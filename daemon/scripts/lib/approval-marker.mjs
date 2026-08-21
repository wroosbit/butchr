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
//   AND SINCE KAN-321, IT NO LONGER FIRES BY ACCIDENT.  A marker that a comment
//   *displays* — inside a code fence, a blockquote, an indented block — or
//   *hides* inside an HTML comment is a mention rather than an assertion, and is
//   no longer read as an approval. That is a smaller claim than the one above it
//   and the two must not be confused: it does not make the gate harder to
//   satisfy deliberately, only harder to satisfy unintentionally. See the
//   USE VERSUS MENTION section below.
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

// ---------------------------------------------------------------------------
// TWO VERDICTS, TWO CARRIERS — KAN-317.
//
// KAN-306 published its answer twice: once as the `approval-recorded` commit
// status, and once as the exit code of the job that posted it. That looked like
// belt and braces and was not. The two carriers behave differently, and the
// difference is the whole defect:
//
//   THE STATUS IS REPLACED.  It is POSTed at the head SHA, so the newest POST
//   for that context wins. An approval arriving by comment overwrites the
//   failure the push wrote. This carrier tracks the current answer, which is why
//   it is the one branch protection requires.
//
//   THE JOB CONCLUSION IS NOT.  A workflow run's conclusion is fixed when the
//   run ends. Worse, the re-evaluation triggered by the approving comment does
//   not even attach to the head — an `issue_comment` run attaches its check run
//   to the DEFAULT BRANCH (that is the whole reason the status exists). So the
//   red `approval-gate` run written by the opening push is never superseded and
//   never replaced. It sits on the head for all time.
//
// Every pull request begins unapproved, so every pull request earned a red
// `approval-gate` run, so every APPROVED pull request in this repository read
// `mergeStateStatus: UNSTABLE` rather than `CLEAN` — permanently, on #133, #134,
// #135, #137 and #138.
//
// AND THAT IS NOT COSMETIC, WHICH IS WHY IT IS FIXED RATHER THAN DOCUMENTED.
// `UNSTABLE` is indistinguishable at a glance from a real problem, and the
// natural repair is `gh pr update-branch` — which moves the head and voids the
// approval marker. Red-looking PR → rebase to clear it → approval dies →
// `approval-recorded` goes red for real → still `UNSTABLE` → rebase again. That
// loop fired on #138, costing a re-review, ninety seconds after the PR had been
// green and approved.
//
// THE REPAIR IS TO STOP PUTTING THE APPROVAL VERDICT IN A CARRIER THAT CANNOT
// RETRACT IT. Each carrier now answers exactly one question:
//
//   `approval-recorded` (a commit status, REQUIRED)
//       Is this head approved?  Replaceable, head-pinned, and the only thing
//       branch protection reads. Unchanged by KAN-317 — omission, staleness and
//       a wrong signer all still turn it red, exactly as KAN-306 built it.
//
//   `approval-gate` (the job conclusion, NOT required)
//       Did the gate manage to evaluate this head and publish that answer?
//       Green means the gate ran and reported. Red means it could not — it
//       could not read the head, or could not publish, or contradicted itself.
//
// SO A GREEN JOB OVER A RED STATUS IS THE DESIGNED READING, not a hole. It says
// "the gate is working, and its answer is no". The job log says so in those
// words, because the failure mode of this change is a reader who takes the green
// job for an approval.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not weaken the gate: nothing here
// touches `evaluate` above, and `approval-recorded` is the required context in
// branch protection, so an unapproved pull request is still BLOCKED rather than
// merely untidy. The candidate fix of "have the job always exit 0 regardless"
// was rejected for the reason KAN-317 gives — it relies on nobody reading the
// job as meaningful, which is the current confusion inverted. The job stays
// meaningful; it is answering a narrower question, and saying which.

import { realpathSync } from 'fs';

// KAN-453: THIS FILE IS A LIBRARY, AND RUNNING IT SAYS SO RATHER THAN EXITING 0.
//
// The decision, and the argument for it, because the ticket asked for one and
// "leave it" was an allowed answer. A pure module exiting 0 with no output when
// executed directly is ordinary Node behaviour and not a bug — but this
// repository reads merge governance off exit codes, and in that setting silence
// plus 0 is *indistinguishable from a gate that ran and passed*. That is not a
// hypothetical confusion: the sibling project's copy of this pair sits in one
// directory, and `task/KAN-433` ran the library there believing it was the
// check and nearly recorded a verified approval off the zero. Ours is one level
// down under `lib/`, which makes the mistake less likely — but that is an
// accident of layout rather than a design, and layout is not a mechanism.
//
// So the cost is four lines and the benefit is that the confusable outcome
// stops existing. It costs importers nothing: the guard fires only when this
// file is the process entry point, and `2` matches the usage code its entry
// point uses, so "you ran the wrong file" and "you passed the wrong flag" read
// the same to a shell.
//
// `realpathSync` on both sides rather than a string compare, so a symlinked
// checkout does not defeat it; the `try` is because `argv[1]` is absent when
// this module is loaded by something that is not a file (`node -e`, a REPL),
// which is an import and not a direct run.
const runDirectly = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === realpathSync(import.meta.filename) : false;
  } catch {
    return false;
  }
})();

if (runDirectly) {
  console.error('approval-marker.mjs is a library, not a check — it judges nothing when run.');
  console.error('');
  console.error('You almost certainly want the gate itself, which takes `--pr`:');
  console.error('  node daemon/scripts/check-approval-recorded.mjs --pr <n> --no-status');
  console.error('');
  console.error('Exiting 2 rather than 0 on purpose: a silent zero here is indistinguishable');
  console.error('from a gate that ran and passed, and this repository reads approvals off exit');
  console.error('codes. Nothing was checked. See KAN-453.');
  process.exit(2);
}

/**
 * The exit-code policy, as one pure function, because it is the thing that must
 * not be quietly re-conflated. `check-approval-recorded.mjs` computes nothing
 * about its own exit code except through here, so there is exactly one place in
 * the repository that decides which failures are the job's.
 *
 * `.mjs` cannot spell `exitOn` as a literal type, which is what `prompts/*.md`
 * would prefer over an assertion — an unrepresentable state cannot be
 * introduced, whereas an assertion can be deleted. The nearest available thing
 * is a closed set plus a throw, so that a typo becomes a loud crash rather than
 * a silently-chosen branch. `EXIT_ON` is exported so a caller can enumerate the
 * valid values rather than retyping a string literal.
 *
 * @param {{ gateHealthy: boolean, approved: boolean, exitOn: 'gate-health' | 'approval' }} q
 * @returns {0 | 1}
 */
export const EXIT_ON = Object.freeze({ GATE_HEALTH: 'gate-health', APPROVAL: 'approval' });

export function exitCodeFor({ gateHealthy, approved, exitOn }) {
  if (typeof gateHealthy !== 'boolean' || typeof approved !== 'boolean') {
    throw new TypeError(
      `exitCodeFor needs booleans for gateHealthy and approved (got ${typeof gateHealthy}, ${typeof approved}). ` +
        'Refusing to guess, because every wrong guess here is a gate that reports the wrong colour.'
    );
  }
  if (exitOn !== EXIT_ON.GATE_HEALTH && exitOn !== EXIT_ON.APPROVAL) {
    throw new TypeError(
      `exitCodeFor got exitOn=${JSON.stringify(exitOn)}, which is neither ` +
        `${JSON.stringify(EXIT_ON.GATE_HEALTH)} nor ${JSON.stringify(EXIT_ON.APPROVAL)}.`
    );
  }

  // A gate that could not publish its verdict is a job failure under BOTH
  // modes, and this line is the invariant rather than a shortcut. The mode
  // chooses who carries the APPROVAL answer; it never excuses a broken gate,
  // because a broken gate has not established anything at all. Fail closed.
  if (!gateHealthy) return 1;

  // `gate-health` is the CI default: the status carries the approval answer, so
  // the job does not repeat it. `approval` is for a caller that has suppressed
  // the status — with no other carrier, the exit code has to be the answer or
  // the answer is nowhere.
  return exitOn === EXIT_ON.APPROVAL ? (approved ? 0 : 1) : 0;
}

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

/** The same grammar against a single line, for reporting a marker we refused. */
const MARKER_LINE = /^[ \t]*BUTCHR-APPROVAL:[ \t]+([0-9a-f]{40})[ \t]+BY[ \t]+(\S+)[ \t]*$/i;

// ---------------------------------------------------------------------------
// USE VERSUS MENTION — KAN-321.
//
// `task/KAN-317` needed a second approval on #139 and asked for one the obvious
// way: it pasted the exact line it wanted, inside a code fence, so that its
// approver could copy it. Fifteen seconds later `approval-recorded` went green,
// describing an approval that did not exist. The genuine one arrived 61 seconds
// after that; for 47 seconds the required check reported an approval on the
// strength of the author's own request for one.
//
// THIS IS NOT THE FORGERY LIMIT ABOVE, AND IT IS WORSE IN ONE SPECIFIC WAY: it
// needs no intent. The forgery note describes what a *deliberate* agent could
// do. This is what a *cooperative* agent does by following the obvious path —
// the natural way to request an approval is to quote the line you are
// requesting. `MARKER` matches "a line of its own", and a line inside a code
// fence is still a line of its own.
//
// AND IT FIRES AT THE WORST MOMENT: the marker gets quoted precisely when
// somebody is requesting or explaining the gate, which is exactly when the gate
// is being relied upon. A rule that is tripped by citing it correctly is tripped
// by its most careful users first.
//
// THE FIX IS TO READ ONLY WHAT THE COMMENT ASSERTS. A Markdown comment has
// contexts that show a line rather than say it, and one that hides it
// altogether; a marker in any of them is a mention. `scanQuoted` labels those
// lines and `assertedText` blanks them before the grammar above ever runs.
//
// WHY EVERY AMBIGUITY HERE RESOLVES TOWARD "QUOTED", and it is the reason this
// scanner is allowed to be approximate rather than a conformant CommonMark
// parser. Deciding a line is quoted REFUSES a marker, and a refused marker is a
// red required check and a blocked merge. So an over-eager scanner costs an
// approver a re-post with a reason that names exactly what happened, while an
// under-eager one hands back the defect this section exists to close. Fail
// closed, loudly. Where you are unsure, mark it quoted.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not require the marker to lead the
// comment. That was the first candidate on KAN-321 and it was rejected against
// data rather than taste — see `verify-approval-recorded.mjs` §14, which carries
// the survey of all 19 markers this repository has ever seen.
//
// WHAT IT STILL DOES NOT CATCH, stated here rather than left to be inferred:
//
//   - FORGERY, exactly as before. An author who writes the marker as a plain
//     top-level line satisfies the gate, whatever they meant by it. Unchanged.
//   - A MARKER POSTED AS A DELIBERATE DEMONSTRATION. #132 carries two, at top
//     level, refused only because their SHA and their signer were wrong. One
//     naming the right head and the right approver would still be accepted.
//   - RENDERED-INLINE PROSE. A line indented under a list item is a paragraph
//     rather than code, and this scanner calls it quoted anyway — fail-closed,
//     and noted so that nobody reads the labels as a rendering claim.

/**
 * The contexts in which a Markdown comment shows a line rather than says it.
 * A closed frozen set for the same reason `EXIT_ON` is one: `.mjs` cannot spell
 * it as a literal type, and a typo that silently picks a branch is, for a gate,
 * a wrong colour.
 */
export const QUOTED = Object.freeze({
  FENCED_CODE: 'a fenced code block',
  INDENTED_CODE: 'an indented block',
  BLOCKQUOTE: 'a blockquote',
  HTML_COMMENT: 'an HTML comment'
});

/** An opening fence may carry an info string; a closing one may not. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {4,}|\t)/;
/** Strip one or more blockquote markers, so a quoted marker can be reported. */
const BLOCKQUOTE_PREFIX = /^(?: {0,3}> ?)+/;

/**
 * Label every line of `body` with the context that displays or hides it, or
 * `null` where the line is the comment speaking in its own voice.
 *
 * Exported so the proof can drive the scanner directly rather than only through
 * its effect on a verdict — a scanner tested only via `evaluate` is one whose
 * failures all look like approval failures.
 *
 * @param {string} body
 * @returns {(string|null)[]} one entry per line, a `QUOTED` value or `null`
 */
export function scanQuoted(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = new Array(lines.length).fill(null);
  let fence = null;
  let html = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside a fence, nothing else can start: a `>` or a `<!--` in there is
    // code being shown. An unclosed fence runs to the end of the comment, which
    // is CommonMark's own rule and is also the fail-closed direction.
    if (fence) {
      out[i] = QUOTED.FENCED_CODE;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }

    if (html) {
      out[i] = QUOTED.HTML_COMMENT;
      if (line.includes('-->')) html = false;
      continue;
    }

    // A fence closes only on the SAME character at the SAME length or longer,
    // which is what makes a ``` inside a ```` block content rather than a
    // terminator. That nesting is how a worked example of this very gate gets
    // written, so it is the case most likely to occur here.
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      out[i] = QUOTED.FENCED_CODE;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      out[i] = QUOTED.BLOCKQUOTE;
      continue;
    }

    // Four spaces or a tab. This is deliberately blunter than CommonMark, which
    // would call the same line a paragraph continuation in some positions — but
    // a continuation renders INLINE, so it is not "a line of its own" either,
    // and both readings refuse. Three spaces stay legal, so the indentation the
    // grammar has always tolerated is untouched.
    if (INDENTED.test(line)) {
      out[i] = QUOTED.INDENTED_CODE;
      continue;
    }

    // A complete `<!-- … -->` on one line opens nothing. Anything left after
    // removing those pairs is a comment that runs on to a later line — and a
    // marker nobody can see is the same defect as one that is merely shown.
    if (line.replace(/<!--[\s\S]*?-->/g, '').includes('<!--')) {
      out[i] = QUOTED.HTML_COMMENT;
      html = true;
    }
  }

  return out;
}

/**
 * `body` with every displayed or hidden line blanked, keeping the line count so
 * that the grammar above still sees "a line of its own" exactly where the
 * comment does.
 */
export function assertedText(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const quoted = scanQuoted(body);
  return lines.map((line, i) => (quoted[i] ? '' : line)).join('\n');
}

/** The body, id and GitHub author of a comment, which may be a bare string. */
function commentParts(c) {
  return {
    body: typeof c === 'string' ? c : (c?.body ?? ''),
    commentId: typeof c === 'string' ? null : (c?.id ?? null),
    author: typeof c === 'string' ? null : (c?.user?.login ?? null)
  };
}

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

/** Every marker a comment ASSERTS. What the gate reads, and the only thing it does. */
export function parseMarkers(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const { body, commentId, author } = commentParts(c);
    const text = assertedText(body);
    MARKER.lastIndex = 0;
    let m;
    while ((m = MARKER.exec(text)) !== null) {
      found.push({ sha: m[1].toLowerCase(), approver: m[2], commentId, author });
    }
  }
  return found;
}

/**
 * Every marker a comment MENTIONS — refused, and reported so that the refusal
 * has a reason an approver can act on.
 *
 * This exists because the fix without it is the worse bug. An approver who
 * fences their marker would otherwise get silence: a red check whose reason
 * reads "no approval marker was found", about a comment they can see contains
 * one. Each entry carries `quotedAs` so the reason names the context.
 */
export function parseQuotedMarkers(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const { body, commentId, author } = commentParts(c);
    const lines = String(body ?? '').split(/\r?\n/);
    const quoted = scanQuoted(body);
    lines.forEach((line, i) => {
      if (!quoted[i]) return;
      // A blockquoted marker never matched the grammar in the first place — `>`
      // is not `[ \t]` — so it has always been refused, silently and by
      // accident rather than by design. Stripping the prefix here is what turns
      // that accident into a reported refusal.
      const bare = quoted[i] === QUOTED.BLOCKQUOTE ? line.replace(BLOCKQUOTE_PREFIX, '') : line;
      const m = MARKER_LINE.exec(bare);
      if (m) {
        found.push({
          sha: m[1].toLowerCase(),
          approver: m[2],
          commentId,
          author,
          quotedAs: quoted[i]
        });
      }
    });
  }
  return found;
}

export function parseDeclaredApprover(prBody) {
  const m = DECLARED.exec(assertedText(prBody));
  return m ? m[1] : null;
}

/**
 * The approver a pull request body only MENTIONS. The same use/mention defect
 * one field over, and it bites in a way the marker's version does not: a body
 * that shows `BUTCHR-APPROVER: epic/KAN-39` as an example of the convention,
 * above a real declaration of somebody else, used to have the example win —
 * `DECLARED` is not global and takes the first match in the file.
 */
export function parseQuotedApprover(prBody) {
  const lines = String(prBody ?? '').split(/\r?\n/);
  const quoted = scanQuoted(prBody);
  for (let i = 0; i < lines.length; i++) {
    if (!quoted[i]) continue;
    const bare = quoted[i] === QUOTED.BLOCKQUOTE ? lines[i].replace(BLOCKQUOTE_PREFIX, '') : lines[i];
    const m = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/i.exec(bare);
    if (m) return { approver: m[1], quotedAs: quoted[i] };
  }
  return null;
}

/** The ticket this pull request belongs to, read off its own branch name. */
export function ownTicketFromRef(headRef) {
  const m = BRANCH.exec(headRef ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// WHICH REFUSAL THIS IS — KAN-627.
//
// `reasons` above is prose written for the job log, where there is room for a
// paragraph. The `approval-recorded` STATUS is the other end of that scale:
// GitHub gives a commit status a `description` of at most 140 characters, and
// it is the only sentence most readers ever see — it is what sits in the merge
// box, what `gh pr checks` prints, and what an agent reads before deciding
// whether to go and fetch a fresh marker.
//
// UNTIL KAN-627 THAT SENTENCE WAS A CONSTANT. `check-approval-recorded.mjs`
// posted the literal
//
//     no approval marker naming this head — see the job log
//
// for EVERY refusal — 53 characters of a 140-character field, so 87 went unused
// — and `evaluate` has eight refusal paths. The sentence is true of exactly two
// of them (no marker at all; markers that all name some other head). For the
// other six a marker naming this head may be sitting on the pull request,
// perfectly asserted, and the status says it is not there:
//
//     no BUTCHR-APPROVER declared      the marker can be flawless
//     the approver line is quoted      the marker can be flawless
//     the declared approver is junk    the marker can be flawless
//     the PR declares its own ticket   the marker can be flawless
//     the marker is signed by somebody else — it DOES name this head
//     every marker is quoted           they DO name this head, unasserted
//
// That is this repository's false-green family with the sign flipped: an
// instrument answering plausibly about the wrong thing (KAN-609). It does not
// go green when it should be red — it goes red for a reason that is not the
// reason, which sends the reader to fix something that is not broken. It has a
// recorded instance: `fixtures/kan-321/pr139-comment-5260338837-request.md`
// pastes that constant off the live status of #139.
//
// SO A REFUSAL NOW CARRIES A CODE AND A SHORT SENTENCE OF ITS OWN, and the
// status description is composed from the ones that actually fired. The codes
// are a frozen closed set for the same reason `EXIT_ON` and `QUOTED` are:
// `.mjs` cannot spell them as a literal type, and the nearest available thing
// is a set plus a throw, so that a typo is a loud crash rather than a status
// that quietly describes the wrong refusal.

/** Every refusal this gate can reach. Frozen: the set is the type. */
export const REFUSAL = Object.freeze({
  HEAD_UNREADABLE: 'head-unreadable',
  NO_APPROVER_DECLARED: 'no-approver-declared',
  APPROVER_QUOTED: 'approver-quoted',
  APPROVER_NOT_AN_AGENT: 'approver-not-an-agent',
  SELF_APPROVAL: 'self-approval',
  NO_MARKER: 'no-marker',
  STALE_MARKER: 'stale-marker',
  WRONG_SIGNER: 'wrong-signer',
  QUOTED_MARKER: 'quoted-marker',
  GATE_CONTRADICTION: 'gate-contradiction'
});

const REFUSAL_CODES = new Set(Object.values(REFUSAL));

/** GitHub's own ceiling on a commit status `description`. */
export const STATUS_DESCRIPTION_LIMIT = 140;

/**
 * Record one refusal on `target`, which is anything carrying `reasons` and
 * `refusals` — the accumulator inside `evaluate`, or a returned verdict that a
 * caller is adding to.
 *
 * THE POINT OF FUNNELLING BOTH ARRAYS THROUGH ONE CALL is that a reason without
 * a code is what re-creates this defect: the long prose would be right and the
 * status would fall back to describing some other refusal. The two arrays are
 * appended to in lockstep here and nowhere else, so `reasons.length ===
 * refusals.length` is an invariant a reader can check rather than a convention
 * a future author has to remember. `verify-approval-recorded.mjs` asserts it on
 * every refusal path.
 *
 * A `brief` is what fits in a status: one clause, no trailing full stop, and no
 * unbounded value spliced into it — see `clamp` below.
 */
export function addRefusal(target, { code, brief, reason }) {
  if (!REFUSAL_CODES.has(code)) {
    throw new TypeError(
      `addRefusal got code=${JSON.stringify(code)}, which is not one of ` +
        `${[...REFUSAL_CODES].join(', ')}. Refusing to guess, because a wrong code here is a ` +
        'required check describing a refusal that did not happen.'
    );
  }
  if (typeof brief !== 'string' || brief.trim().length === 0) {
    throw new TypeError(`addRefusal needs a non-empty brief for ${code} (got ${JSON.stringify(brief)}).`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError(`addRefusal needs a non-empty reason for ${code} (got ${JSON.stringify(reason)}).`);
  }
  target.reasons.push(reason);
  target.refusals.push({ code, brief });
  return target;
}

/**
 * Keep a value spliced into a `brief` from eating the whole status line. An
 * approver name, a signer list and a ticket key all come off the pull request,
 * so none of them is bounded by anything in this file.
 */
function clamp(value, max) {
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * The whole verdict, as data. No I/O, no process exit, no printing — so that
 * the proof can drive it over fixtures and the CI entry point can drive it over
 * a live pull request, and both are exercising the same decision.
 *
 * Returns `{ ok, reasons, refusals, accepted, markers }`. `reasons` is non-empty
 * exactly when `ok` is false, and each entry is written to be read on a red
 * check by somebody who has not seen this file. `refusals` is the same list said
 * short enough for a commit status, one entry per reason and in the same order.
 */
export function evaluate({ headSha, headRef, prBody, comments }) {
  const reasons = [];
  const refusals = [];
  const refuse = (code, brief, reason) => addRefusal({ reasons, refusals }, { code, brief, reason });
  const markers = parseMarkers(comments);
  const quotedMarkers = parseQuotedMarkers(comments);
  const declared = parseDeclaredApprover(prBody);
  const quotedDeclared = parseQuotedApprover(prBody);
  const ownTicket = ownTicketFromRef(headRef);
  const head = (headSha ?? '').toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(head)) {
    const broken = { reasons: [], refusals: [] };
    addRefusal(broken, {
      code: REFUSAL.HEAD_UNREADABLE,
      brief: "gate defect: this PR's head is not a 40-character SHA",
      reason:
        `the head commit was not readable as a 40-character SHA (got ${JSON.stringify(headSha)}). ` +
        'This is a defect in the check itself, not in the pull request — the gate cannot ' +
        'be satisfied until it is fixed, and it must not pass while it cannot see the head.'
    });
    return {
      ok: false,
      markers,
      quotedMarkers,
      accepted: null,
      declared,
      ownTicket,
      reasons: broken.reasons,
      refusals: broken.refusals
    };
  }

  if (!declared) {
    refuse(
      REFUSAL.NO_APPROVER_DECLARED,
      'the PR body declares no BUTCHR-APPROVER line',
      'the pull request body does not declare an approver. Add a line of its own reading ' +
        '`BUTCHR-APPROVER: <type>/<KEY>`, naming the agent your ticket says approves you — ' +
        'the Story your task is linked to by a `Blocks` link, else the parent epic. ' +
        'Declaring it in advance is what stops a marker from an uninvolved agent counting.'
    );
    if (quotedDeclared) {
      refuse(
        REFUSAL.APPROVER_QUOTED,
        `the approver is only shown inside ${quotedDeclared.quotedAs}, not declared`,
        `the body does name \`${quotedDeclared.approver}\` as approver, but inside ` +
          `${quotedDeclared.quotedAs}, where it is shown rather than declared (KAN-321). ` +
          'Move the declaration out to the top level of the body.'
      );
    }
  } else if (!AGENT.test(declared)) {
    refuse(
      REFUSAL.APPROVER_NOT_AN_AGENT,
      `the declared approver "${clamp(declared, 32)}" is not a type/KEY agent name`,
      `the declared approver \`${declared}\` is not a \`<type>/<KEY>\` agent name ` +
        '(e.g. `epic/KAN-39`).'
    );
  } else if (ownTicket && declared.endsWith(`/${ownTicket}`)) {
    refuse(
      REFUSAL.SELF_APPROVAL,
      `the PR declares its own ticket ${clamp(ownTicket, 16)} as its approver`,
      `the pull request declares \`${declared}\` as its own approver, which is the ticket ` +
        `this branch is working (${ownTicket}). An agent does not approve its own work. ` +
        'If your ticket genuinely names no approver, that is a filing defect — say so on the ' +
        'ticket and do not merge.'
    );
  }

  if (markers.length === 0) {
    refuse(
      REFUSAL.NO_MARKER,
      'no approval marker was asserted in any comment',
      'no approval marker was found in any comment on this pull request. An approval is a ' +
        'comment containing, on a line of its own and at the top level of the comment: ' +
        '`BUTCHR-APPROVAL: <40-char-head-sha> BY <type>/<KEY>`. For this head that line is ' +
        `the following, which must be pasted UNINDENTED and NOT inside a code fence (KAN-321):\n` +
        // Deliberately not indented to line up with the reason above it. The
        // gate printing its own suggestion indented by six spaces, in an era
        // where an indented marker is refused, would be this defect handing the
        // next agent a line that cannot work.
        `BUTCHR-APPROVAL: ${head} BY ${declared ?? '<approver>'}`
    );
  }

  const atHead = markers.filter((m) => m.sha === head);
  if (markers.length > 0 && atHead.length === 0) {
    const stale = [...new Set(markers.map((m) => m.sha))];
    refuse(
      REFUSAL.STALE_MARKER,
      `${markers.length} marker(s) found and none names this head — stale`,
      `${markers.length} approval marker(s) were found, and none names this head. ` +
        `Head is ${head}; the markers name ${stale.map((s) => s.slice(0, 12) + '…').join(', ')}. ` +
        'A push — including `gh pr update-branch` — changes the head and therefore invalidates ' +
        'every approval given against the old one. Take the new head back to your approver.'
    );
  }

  const accepted = declared ? (atHead.find((m) => m.approver === declared) ?? null) : null;
  if (atHead.length > 0 && declared && !accepted) {
    const signers = [...new Set(atHead.map((m) => m.approver))];
    refuse(
      REFUSAL.WRONG_SIGNER,
      `a marker names this head but is signed by ${clamp(signers.join(', '), 32)}, ` +
        `not ${clamp(declared, 32)}`,
      `an approval marker names this head, but is signed by ` +
        `${[...new Set(atHead.map((m) => m.approver))].map((a) => `\`${a}\``).join(', ')} ` +
        `where this pull request declares \`${declared}\` as its approver. The agent that ` +
        'approves is the one the board names, and a marker from anybody else does not satisfy ' +
        'the gate. If the declared approver is wrong, fix the pull request body.'
    );
  }

  // KAN-321: explain a refusal caused by a quoted marker — and ONLY explain it.
  //
  // THE GUARD IS THE POINT, NOT A TIDINESS. This block must never be what makes
  // a verdict fail, because `ok` is `reasons.length === 0`: pushing here
  // unconditionally would refuse a pull request that carries a real asserted
  // approval merely because some other comment on it also quotes a marker — and
  // a PR that discusses this gate is exactly the kind that would. So it appends
  // to an existing failure and is unreachable when the gate is satisfied.
  if (reasons.length > 0 && quotedMarkers.length > 0) {
    const atHeadQuoted = quotedMarkers.filter((m) => m.sha === head);
    const relevant = atHeadQuoted.length > 0 ? atHeadQuoted : quotedMarkers;
    refuse(
      REFUSAL.QUOTED_MARKER,
      `${quotedMarkers.length} marker(s) seen, all quoted rather than asserted`,
      `${quotedMarkers.length} marker(s) WERE found and every one of them was quoted rather ` +
        'than asserted, so none counted (KAN-321 — the gate used to read a quotation as the ' +
        'thing itself, which let a request for an approval satisfy it). ' +
        relevant
          .map(
            (m) =>
              `Comment ${m.commentId ?? '?'} names ${m.sha.slice(0, 12)}… by \`${m.approver}\` ` +
              `inside ${m.quotedAs}.`
          )
          .join(' ') +
        ' If you meant to approve, post the marker as a plain unindented line at the top level ' +
        'of a comment. If you were quoting it to ask for an approval, this refusal is correct ' +
        'and nothing is wrong.'
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    refusals,
    accepted,
    markers,
    quotedMarkers,
    declared,
    ownTicket,
    head
  };
}

/**
 * The sentence the `approval-recorded` commit status carries — KAN-627.
 *
 * Pure, so the proof drives it directly rather than only through the shape of a
 * status the stub happened to receive. Never longer than
 * `STATUS_DESCRIPTION_LIMIT`, and it says which refusal fired rather than one
 * constant for all of them.
 *
 * HOW IT SPENDS THE 140 CHARACTERS, because the old defect was not only that
 * the sentence was wrong — it was that 87 characters sat unused while it was
 * wrong. Refusals are packed in the order `evaluate` found them, joined with
 * `; `, and the pack stops at the last one that fits WITH ROOM FOR THE TAIL
 * that says how many were dropped. So a reader is never silently shown a subset:
 * either every refusal is named, or the count of the ones that are not is.
 *
 * NOTHING IS CUT MID-CLAUSE except in the one case where a single brief cannot
 * fit at all, which is why `clamp` bounds the values spliced into them at the
 * source. That last resort still names its refusal, which is the property worth
 * keeping when there is nothing else left to keep.
 */
export function statusDescription(verdict) {
  const limit = STATUS_DESCRIPTION_LIMIT;

  if (verdict?.ok) {
    // The approved case had spare room too, and a comment id is what turns
    // "somebody approved this" into a link a reader can go and check.
    const approver = clamp(verdict.accepted?.approver, 48);
    const base = `approved at this head by ${approver}`;
    const commentId = verdict.accepted?.commentId;
    const withComment =
      commentId === null || commentId === undefined ? base : `${base} (comment ${clamp(commentId, 24)})`;
    return (withComment.length <= limit ? withComment : base).slice(0, limit);
  }

  const briefs = (Array.isArray(verdict?.refusals) ? verdict.refusals : [])
    .map((r) => (typeof r?.brief === 'string' ? r.brief.trim() : ''))
    .filter((b) => b.length > 0);

  // A red verdict carrying no refusal at all is a contradiction, and saying so
  // beats posting an empty description that reads as a status with no opinion.
  if (briefs.length === 0) return 'refused, and no refusal was recorded — see the job log'.slice(0, limit);

  const tail = (n) => `; +${n} more, see the log`;
  let packed = '';
  let taken = 0;
  for (; taken < briefs.length; taken++) {
    const candidate = taken === 0 ? briefs[0] : `${packed}; ${briefs[taken]}`;
    const leftAfter = briefs.length - (taken + 1);
    if (candidate.length + (leftAfter > 0 ? tail(leftAfter).length : 0) > limit) break;
    packed = candidate;
  }

  const dropped = briefs.length - taken;
  if (dropped === 0) return packed;
  if (packed.length === 0) return briefs[0].slice(0, limit);
  return `${packed}${tail(dropped)}`;
}
