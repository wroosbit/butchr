//
// The approval marker — what a machine can read of "this pull request was
// approved, at this exact commit, by the agent the board names". KAN-306.
//
// WHY THIS EXISTS. Branch protection on `main` requires green checks and an
// up-to-date branch. It does not require an approval, and it cannot: every
// agent in this fleet authenticates as the same GitHub account, so GitHub
// refuses a formal review verdict on any of our pull requests as self-review —
//
//     $ gh pr review 127 --request-changes
//     failed to create review: GraphQL: Review Can not request changes on your
//     own pull request
//
// — and `required_approving_review_count` is therefore pinned at 0. Raising it
// to 1 would not make merges safer; it would make them impossible. So every
// approval this epic has ever given has been a PR *comment*, indistinguishable
// to any machine from any other comment. `dismiss_stale_reviews: true` has been
// cited all day as the reason "an approval does not survive its head" — but the
// only thing that flag dismisses is review verdicts, and that set is always
// empty here. It has been dismissing nothing.
//
// This module is the alternative that works under one shared identity: an
// approval is a comment containing a canonical line naming the exact commit it
// approves.
//
// WHAT IT DOES AND DOES NOT ESTABLISH — read this before trusting it.
//
//   IT CATCHES OMISSION.  A merge with no approval at all, and a merge on an
//   approval given against a commit that is no longer the head, both become a
//   red required check instead of a thing nobody can see afterwards.
//
//   IT DOES NOT CATCH FORGERY.  Under one shared GitHub identity a task agent
//   can post its own approval marker naming its own approver, and nothing here
//   can tell that comment from the real one. The author of the pull request and
//   the author of the approval are the same GitHub user by construction. This
//   is a real and permanent limit of the design, not an oversight, and closing
//   it needs separate GitHub identities per agent — filed as a follow-up rather
//   than attempted here.
//
// So the honest sentence is: this converts *"I believe I was approved"* into
// *"a comment naming this exact commit exists, or the merge is blocked."* That
// is a smaller claim than "approval is enforced", and it is the one to make.
//
// WHY IT COMPARES COMMITS AND NEVER CLOCKS. The obvious way to check that an
// approval preceded a merge is to compare timestamps, and that is how KAN-306
// itself was filed with a false headline: Jira returns `-0700`, GitHub returns
// `Z`, and neither surface says they are different clocks, so a seven-hour
// timezone error read as evidence of an unapproved merge. `epic/KAN-203` drew
// the right lesson — a claim whose *units* were never checked. The repair used
// here is stronger than normalising to UTC: this module compares 40-character
// commit SHAs, which have no timezone, no offset and no clock. If you ever add
// a leg here that does read a timestamp, normalise both sides to UTC explicitly
// and say so on the line that does it.
//

/** `<type>/<KEY>` — the fleet's own name for an agent, e.g. `epic/KAN-39`. */
const AGENT = /^(epic|story|task|confluence)\/([A-Z][A-Z0-9]*-\d+)$/;

/**
 * The canonical approval line, matched anywhere in a comment body but only on a
 * line of its own. Prose around it is welcome and expected — the marker is what
 * the machine reads, and the reasoning around it is what the next human reads.
 *
 * The SHA must be all 40 characters. An abbreviated SHA is refused rather than
 * resolved: `1abbf50` names a commit only relative to a repository state, and
 * the entire value of this check is that the approval names one commit for all
 * time.
 */
const MARKER = /^[ \t]*BUTCHR-APPROVAL:[ \t]+([0-9a-f]{40})[ \t]+BY[ \t]+(\S+)[ \t]*$/gim;

/**
 * The approver the pull request itself declares, in its body:
 *
 *     BUTCHR-APPROVER: epic/KAN-39
 *
 * This is written by the author, before any approval exists, and it is what the
 * marker is checked against. It is not authentication — see the forgery note
 * above — but it does force the author to commit to who the approver is in
 * advance, so that a marker from some other agent that happens to be watching
 * does not satisfy the gate.
 */
const DECLARED = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/im;

/** The branch convention: `butchr/KAN-306` is the agent working KAN-306. */
const BRANCH = /^butchr\/([A-Z][A-Z0-9]*-\d+)$/;

export function parseMarkers(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const body = typeof c === 'string' ? c : (c?.body ?? '');
    MARKER.lastIndex = 0;
    let m;
    while ((m = MARKER.exec(body)) !== null) {
      found.push({
        sha: m[1].toLowerCase(),
        approver: m[2],
        commentId: typeof c === 'string' ? null : (c?.id ?? null),
        author: typeof c === 'string' ? null : (c?.user?.login ?? null)
      });
    }
  }
  return found;
}

export function parseDeclaredApprover(prBody) {
  const m = DECLARED.exec(prBody ?? '');
  return m ? m[1] : null;
}

/** The ticket this pull request belongs to, read off its own branch name. */
export function ownTicketFromRef(headRef) {
  const m = BRANCH.exec(headRef ?? '');
  return m ? m[1] : null;
}

/**
 * The whole verdict, as data. No I/O, no process exit, no printing — so that
 * the proof can drive it over fixtures and the CI entry point can drive it over
 * a live pull request, and both are exercising the same decision.
 *
 * Returns `{ ok, reasons, accepted, markers }`. `reasons` is non-empty exactly
 * when `ok` is false, and each entry is written to be read on a red check by
 * somebody who has not seen this file.
 */
export function evaluate({ headSha, headRef, prBody, comments }) {
  const reasons = [];
  const markers = parseMarkers(comments);
  const declared = parseDeclaredApprover(prBody);
  const ownTicket = ownTicketFromRef(headRef);
  const head = (headSha ?? '').toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(head)) {
    return {
      ok: false,
      markers,
      accepted: null,
      declared,
      ownTicket,
      reasons: [
        `the head commit was not readable as a 40-character SHA (got ${JSON.stringify(headSha)}). ` +
          'This is a defect in the check itself, not in the pull request — the gate cannot ' +
          'be satisfied until it is fixed, and it must not pass while it cannot see the head.'
      ]
    };
  }

  if (!declared) {
    reasons.push(
      'the pull request body does not declare an approver. Add a line of its own reading ' +
        '`BUTCHR-APPROVER: <type>/<KEY>`, naming the agent your ticket says approves you — ' +
        'the Story your task is linked to by a `Blocks` link, else the parent epic. ' +
        'Declaring it in advance is what stops a marker from an uninvolved agent counting.'
    );
  } else if (!AGENT.test(declared)) {
    reasons.push(
      `the declared approver \`${declared}\` is not a \`<type>/<KEY>\` agent name ` +
        '(e.g. `epic/KAN-39`).'
    );
  } else if (ownTicket && declared.endsWith(`/${ownTicket}`)) {
    reasons.push(
      `the pull request declares \`${declared}\` as its own approver, which is the ticket ` +
        `this branch is working (${ownTicket}). An agent does not approve its own work. ` +
        'If your ticket genuinely names no approver, that is a filing defect — say so on the ' +
        'ticket and do not merge.'
    );
  }

  if (markers.length === 0) {
    reasons.push(
      'no approval marker was found in any comment on this pull request. An approval is a ' +
        'comment containing, on a line of its own: ' +
        '`BUTCHR-APPROVAL: <40-char-head-sha> BY <type>/<KEY>`.\n' +
        `      For this head that line reads:  BUTCHR-APPROVAL: ${head} BY ${declared ?? '<approver>'}`
    );
  }

  const atHead = markers.filter((m) => m.sha === head);
  if (markers.length > 0 && atHead.length === 0) {
    const stale = [...new Set(markers.map((m) => m.sha))];
    reasons.push(
      `${markers.length} approval marker(s) were found, and none names this head. ` +
        `Head is ${head}; the markers name ${stale.map((s) => s.slice(0, 12) + '…').join(', ')}. ` +
        'A push — including `gh pr update-branch` — changes the head and therefore invalidates ' +
        'every approval given against the old one. Take the new head back to your approver.'
    );
  }

  const accepted = declared ? (atHead.find((m) => m.approver === declared) ?? null) : null;
  if (atHead.length > 0 && declared && !accepted) {
    reasons.push(
      `an approval marker names this head, but is signed by ` +
        `${[...new Set(atHead.map((m) => m.approver))].map((a) => `\`${a}\``).join(', ')} ` +
        `where this pull request declares \`${declared}\` as its approver. The agent that ` +
        'approves is the one the board names, and a marker from anybody else does not satisfy ' +
        'the gate. If the declared approver is wrong, fix the pull request body.'
    );
  }

  return { ok: reasons.length === 0, reasons, accepted, markers, declared, ownTicket, head };
}
