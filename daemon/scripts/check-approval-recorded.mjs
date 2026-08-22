// KAN-306: the CI entry point for the approval gate — `approval-recorded`.
//
// It reads a live pull request, asks `lib/approval-marker.mjs` whether it
// carries an approval pinned to the exact commit that would merge, publishes
// the answer as a commit status named `approval-recorded`, and exits on the
// verdict.
//
// `check-` rather than `verify-`, for the reason `sweep-` and `run-` are not
// `verify-` either: this file proves no product behaviour of its own. It is a
// gate over live GitHub state, it needs a token and a network, and it could
// never run in the CI-runnable set. `verify-approval-recorded.mjs` is the proof
// that polices it, and that one does run on every pull request.
//
// WHY IT PUBLISHES A COMMIT STATUS RATHER THAN BEING A JOB NAMED
// `approval-recorded`. An approval arrives *after* the push that triggered CI,
// so a check that only ever evaluates on `pull_request` is red at the moment it
// is created and has no way to become green — nothing re-runs it when the
// approver finally comments. The workflow therefore also runs on
// `issue_comment`, and a workflow triggered by a comment attaches its own check
// run to the default branch rather than to the pull request head, where branch
// protection would never see it. A commit status POSTed at the head SHA lands in
// the right place on every trigger, so there is exactly one context named
// `approval-recorded` whatever woke it up.
//
// THE BOOTSTRAP, STATED BECAUSE IT WILL CONFUSE THE NEXT READER OTHERWISE.
// GitHub always takes an `issue_comment` workflow from the DEFAULT BRANCH, never
// from the pull request's branch. So on the pull request that introduces this
// file, a comment cannot re-trigger it — the file is not on `main` yet. Re-run
// the workflow by hand there (`gh run rerun <id>`), which re-evaluates against
// the same head and finds the comment. From the merge onwards the comment
// trigger works by itself.
//
// WHAT THIS PROCESS'S EXIT CODE MEANS, WHICH CHANGED IN KAN-317. It reports
// whether the GATE worked, not whether the pull request is approved. The
// approval answer is the `approval-recorded` status this script POSTs, and that
// status is the required context. The full argument — why one carrier can
// retract an answer and the other cannot, and why publishing to both made every
// approved pull request read `UNSTABLE` forever — is on `exitCodeFor` in
// `lib/approval-marker.mjs`. Read it before changing either exit path.
//
// WHAT THE STATUS SAYS, WHICH CHANGED IN KAN-627. The `description` this POSTs
// was a single hardcoded sentence — "no approval marker naming this head" — for
// every refusal `lib/approval-marker.mjs` can reach. It is true of two of the
// eight and false of the other six: a wrong signer, a quoted marker and all four
// approver-declaration failures can each occur while a perfectly good marker
// names this exact head. The sentence also spent 53 of the 140 characters GitHub
// allows a commit status, so there was room for the truth and it went unused.
// `statusDescription` in the lib composes the line from the refusals that fired;
// this file only publishes it.
//
// AN ARGUMENT THIS SCRIPT DOES NOT RECOGNISE IS A USAGE ERROR — KAN-453. It
// exits 2 without judging anything. Until KAN-453 it exited 0 instead, and that
// is worth stating rather than filing as a fixed bug, because the shape recurs:
// `arg()` below is `argv.indexOf`, so anything that was not `--pr` was not
// rejected — it was *not read at all*, and the run fell through to the "no pull
// request here" branch that a push build legitimately takes. A foreign flag, a
// typo, and no arguments whatsoever therefore produced byte-identical output and
// the same exit code, so the script could not distinguish "I am in CI on a push
// build with no pull request" from "a human handed me arguments I do not
// understand". Only the first of those is benign, and in a repository whose
// merge governance is read off exit codes the second is a green light from a
// gate that judged nothing.
//
// Usage:
//   node daemon/scripts/check-approval-recorded.mjs             # in CI
//   node daemon/scripts/check-approval-recorded.mjs --pr 132    # by hand
//   node daemon/scripts/check-approval-recorded.mjs --pr 132 --no-status
//
//   --pr <n>               judge pull request <n> rather than resolving one
//                          from the CI event.
//   --no-status            do not publish; implies --exit-on-approval, because
//                          with no status posted the exit code is the only
//                          carrier left and the verdict has to go somewhere.
//   --exit-on-approval     exit 1 when the pull request is unapproved. What CI
//                          did before KAN-317; keep it for a shell that wants
//                          the answer in `$?`.
//   --exit-on-gate-health  exit 0 whenever the gate published a verdict, even a
//                          red one. The CI default, stated explicitly for a
//                          caller that also passes `--no-status` and genuinely
//                          means it.
//
// Reads `GITHUB_TOKEN` from the environment and never prints it, echoes it, or
// passes it as an argument. It is sent in an Authorization header at the point
// of use and stays there.

import fs from 'fs';
import {
  evaluate,
  exitCodeFor,
  addRefusal,
  statusDescription,
  EXIT_ON,
  REFUSAL,
  GATE_CONTRADICTION_BRIEF,
  STATUS_DESCRIPTION_LIMIT
} from './lib/approval-marker.mjs';

const argv = process.argv.slice(2);

// KAN-453: THE FLAG TABLE IS THE SINGLE SOURCE OF BOTH THE PARSER AND THE USAGE
// TEXT, and that is the point rather than tidiness. The defect being fixed is a
// correct spelling that was undiscoverable from the failure — the run said
// "nothing to judge" and exited 0, which names neither the flag you got wrong
// nor the flag you wanted. A usage message assembled from a table cannot fall
// behind the parser, so the next flag added here is documented by construction;
// one written out as prose beside a separate parser is documented until somebody
// forgets, and this file has no way to notice that it has.
const FLAGS = Object.freeze({
  '--pr': { value: '<n>', help: 'judge pull request <n> rather than resolving one from the CI event' },
  '--no-status': { value: null, help: 'do not publish the commit status; implies --exit-on-approval' },
  '--exit-on-approval': { value: null, help: 'exit 1 when the pull request is unapproved' },
  '--exit-on-gate-health': { value: null, help: 'exit 0 whenever the gate published a verdict' }
});

// EXIT 2, AND DELIBERATELY NOT 1. `0` and `1` are this script's two verdict
// codes — see `exitCodeFor` in the lib — and a usage error is neither of them:
// nothing was judged, so reporting it as a verdict is the exact confusion
// KAN-453 exists to remove. A third code says "I did not run" and cannot be
// read as an answer to the question the gate asks.
const EXIT_USAGE = 2;

function usage(problem) {
  console.error(`check-approval-recorded: ${problem}`);
  console.error('');
  console.error('Usage:');
  console.error('  node daemon/scripts/check-approval-recorded.mjs [--pr <n>] [--no-status]');
  console.error('      [--exit-on-approval | --exit-on-gate-health]');
  console.error('');
  for (const [name, spec] of Object.entries(FLAGS)) {
    console.error(`  ${`${name}${spec.value ? ` ${spec.value}` : ''}`.padEnd(24)}${spec.help}`);
  }
  console.error('');
  console.error('With no arguments the pull request is resolved from the CI event, which is how');
  console.error('the workflow invokes it. That is a valid invocation and is unchanged by this');
  console.error('check: a CI run with no pull request to judge still reports success.');
  process.exit(EXIT_USAGE);
}

// WALK argv RATHER THAN SCANNING IT. A scan finds the tokens it already knows to
// look for and is structurally blind to the rest, which is the defect itself —
// so validation has to visit every token, not query for a few. Note that an
// empty argv walks zero times and is accepted: no arguments is how CI calls
// this, and rejecting it would break every push build.
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  const spec = FLAGS[token];
  if (!spec) usage(`unrecognised argument ${JSON.stringify(token)}.`);
  if (!spec.value) continue;
  const given = argv[++i];
  if (given === undefined) usage(`${token} needs a value (${spec.value}).`);
  // A non-numeric `--pr` used to reach GitHub as `/pulls/NaN` and fail as a
  // network error, which reports a broken gate for what is a typo at the shell.
  if (!/^[0-9]+$/.test(given)) usage(`${token} needs a pull request number, got ${JSON.stringify(given)}.`);
}

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const postStatus = !argv.includes('--no-status');

// The exit code carries the approval verdict exactly when nothing else does.
// Default to the status being the carrier; fall back to the exit code when the
// status has been suppressed; let either be named outright.
const exitOn = argv.includes('--exit-on-approval')
  ? EXIT_ON.APPROVAL
  : argv.includes('--exit-on-gate-health')
    ? EXIT_ON.GATE_HEALTH
    : postStatus
      ? EXIT_ON.GATE_HEALTH
      : EXIT_ON.APPROVAL;

// Did this run manage to answer the question at all? Distinct from the answer,
// and the only thing the job's own conclusion reports. Anything pushed here is
// a defect in the gate or its environment — never a fact about the pull
// request, which is what `verdict.reasons` is for.
const gateDefects = [];

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || 'wroosbit/butchr';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const CONTEXT = 'approval-recorded';

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'butchr-approval-recorded',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method ?? 'GET'} ${pathname} → ${res.status}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Which pull request are we judging, on each of the three events?
 *
 * `pull_request` is the ordinary case, and the head SHA comes out of the event
 * payload rather than out of `GITHUB_SHA` — on a `pull_request` event
 * `GITHUB_SHA` is the *merge* commit GitHub synthesised, which no approver has
 * ever seen and which no marker will ever name.
 */
async function resolvePullRequest() {
  const event = process.env.GITHUB_EVENT_NAME;
  const explicit = arg('--pr');
  if (explicit) return { number: Number(explicit), why: `--pr ${explicit}` };

  const payload = process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};

  if (event === 'pull_request' || event === 'pull_request_target') {
    return { number: payload.pull_request?.number, why: 'pull_request event' };
  }

  if (event === 'issue_comment') {
    // An `issue_comment` fires for issues as well as pull requests, and only a
    // pull request has this key. An issue comment is not this check's business.
    if (!payload.issue?.pull_request) return { number: null, why: 'comment on an issue, not a pull request' };
    return { number: payload.issue.number, why: 'issue_comment event' };
  }

  if (event === 'push') {
    // THE PUSH LEG. #126 taught this board that a check green on `pull_request`
    // can be broken on `push`, so this one is covered rather than excused: on a
    // push to `main` we ask which pull request the pushed commit came from and
    // re-judge THAT pull request at ITS head. A squash merge rewrites the
    // commit, so the pushed SHA is not the SHA any marker names — the PR's own
    // head is, and that is what is checked. A commit with no pull request
    // behind it is reported and passes: this gate is about pull requests, and
    // saying so is better than inventing a verdict about a direct push.
    const sha = process.env.GITHUB_SHA;
    const prs = await api(`/repos/${REPO}/commits/${sha}/pulls`);
    if (!prs.length) return { number: null, why: `no pull request contains ${sha}` };
    return { number: prs[0].number, why: `pushed commit ${sha?.slice(0, 12)} came from #${prs[0].number}` };
  }

  return { number: null, why: `unhandled event ${event}` };
}

async function allComments(number) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${REPO}/issues/${number}/comments?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const { number, why } = await resolvePullRequest();
console.log(`repository ${REPO}`);
console.log(`resolved:   ${why}`);

if (!number) {
  console.log(`\nnothing to judge — ${why}.`);
  console.log('Reporting success: this gate judges pull requests, and there is not one here.');
  process.exit(0);
}

const pr = await api(`/repos/${REPO}/pulls/${number}`);
const comments = await allComments(number);
const headSha = pr.head.sha;
const headRef = pr.head.ref;

console.log(`pull request #${number} — ${pr.title}`);
console.log(`head:       ${headSha} (${headRef})`);
console.log(`comments:   ${comments.length}`);
console.log('');

const verdict = evaluate({ headSha, headRef, prBody: pr.body, comments });

// A head we cannot read is the gate's problem and not the pull request's: the
// lib's own reason line says so — "a defect in the check itself". Detected on
// the shape of the SHA rather than by matching that reason's text, because a
// gate whose health depends on the wording of a sentence is a gate that goes
// green when somebody improves the prose.
if (!/^[0-9a-f]{40}$/.test(headSha ?? '')) {
  gateDefects.push(
    `the pull request head was not readable as a 40-character SHA (got ${JSON.stringify(headSha)}). ` +
      'The gate cannot judge a head it cannot see, and it must not pass while it cannot.'
  );
}

// `ok` implies `accepted` in `lib/approval-marker.mjs` — every path that leaves
// `accepted` null also pushes a reason. That is true by construction across two
// files, which is exactly the kind of invariant that survives until somebody
// edits one of them. Asserting it here costs nothing and keeps the failure
// legible: without it, a lib that returns `ok` with no marker crashes on
// `accepted.approver` BEFORE the status is posted, so the required context
// never reports at all and the pull request blocks forever on a check that
// looks like it never ran. Found by deliberately breaking the omission leg and
// watching this script die instead of going red. Fail closed, and say why.
//
// KAN-317: this one is a gate defect as well as a refusal, and it is filed as
// both. The pull request is refused (the status goes red, because a gate that
// cannot say who approved has not established that anybody did) AND the job
// goes red (because the contradiction is in our own code, and it is the one
// thing here nobody would otherwise be paged about). The comment above already
// says this is "a contradiction inside `lib/approval-marker.mjs`, not a fact
// about this pull request" — before KAN-317 that sentence was true and the exit
// code disagreed with it.
if (verdict.ok && !verdict.accepted) {
  verdict.ok = false;
  // KAN-627: through `addRefusal`, so the status describes THIS refusal rather
  // than inheriting whatever sentence the last one left behind. A reason pushed
  // straight onto the array would be right in the job log and invisible to the
  // 140 characters most readers actually see.
  addRefusal(verdict, {
    code: REFUSAL.GATE_CONTRADICTION,
    brief: GATE_CONTRADICTION_BRIEF,
    reason:
      'the gate returned a passing verdict with no accepted marker attached. That is a ' +
      'contradiction inside `lib/approval-marker.mjs`, not a fact about this pull request. ' +
      'Refusing rather than passing, because a gate that cannot say who approved has not ' +
      'established that anybody did.'
  });
  gateDefects.push(
    '`lib/approval-marker.mjs` returned `ok` with no accepted marker. This is a contradiction ' +
      'in the gate itself — fix the lib.'
  );
}

if (verdict.ok) {
  console.log('APPROVAL RECORDED');
  console.log(`  approver: ${verdict.accepted.approver}`);
  console.log(`  at head:  ${verdict.accepted.sha}`);
  console.log(`  comment:  ${verdict.accepted.commentId}`);
  console.log('');
  console.log('This says a comment naming this exact commit exists, and nothing more. It does');
  console.log('not establish that the named approver is who posted it — every agent here is the');
  console.log('same GitHub user, so this check catches omission and staleness, never forgery.');
} else {
  console.log('NO APPROVAL RECORDED AT THIS HEAD');
  console.log('');
  // KAN-627: the code is printed beside its prose so that a reader who arrived
  // from the 140-character status can find the paragraph it was said short in.
  verdict.reasons.forEach((r, i) => {
    const code = verdict.refusals?.[i]?.code;
    console.log(`  - ${code ? `[${code}] ` : ''}${r}`);
  });

  // KAN-321. Printed as its own block as well as inside the reasons, because
  // this is the refusal most likely to be read as the gate malfunctioning: the
  // comment visibly contains the line, and the reader has to be told in one
  // place that it was seen, understood, and refused for being a quotation.
  if (verdict.quotedMarkers?.length) {
    console.log('');
    console.log('QUOTED MARKERS SEEN AND NOT COUNTED');
    for (const m of verdict.quotedMarkers) {
      console.log(`  - comment ${m.commentId}: ${m.sha} BY ${m.approver} — inside ${m.quotedAs}`);
    }
  }
}

if (postStatus) {
  const state = verdict.ok ? 'success' : 'failure';
  // KAN-627. This used to be one hardcoded sentence for every refusal — "no
  // approval marker naming this head" — which is true of two of `evaluate`'s
  // eight refusal paths and false of the other six, and which spent 53 of the
  // 140 characters GitHub allows. `statusDescription` composes it from the
  // refusals that actually fired; the `.slice` below is the assertion behind
  // that mechanism, kept because a status GitHub rejects for length is a gate
  // nobody can read.
  const description = statusDescription(verdict).slice(0, STATUS_DESCRIPTION_LIMIT);
  console.log(`status description: ${description}`);
  console.log(`                    ${description.length}/${STATUS_DESCRIPTION_LIMIT} characters`);
  try {
    await api(`/repos/${REPO}/statuses/${headSha}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state,
        context: CONTEXT,
        description,
        target_url: process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined
      })
    });
    console.log(`\nposted commit status ${CONTEXT}=${state} at ${headSha}`);
  } catch (e) {
    // A status we could not publish is a gate nobody can see. Fail loudly
    // rather than exiting green on an unpublished verdict. KAN-317 routes this
    // through `gateDefects` instead of exiting on the spot, so that it reports
    // as what it is — the gate broken, rather than the pull request refused —
    // and so that the summary below still prints. It is red under both modes.
    console.error(`\nFAILED to post the ${CONTEXT} status: ${e.message}`);
    gateDefects.push(
      `the ${CONTEXT} status could not be published at ${headSha}: ${e.message}. A verdict ` +
        'nobody can read is not a gate, so this run reports itself broken rather than passing.'
    );
  }
}

// ---------------------------------------------------------------------------
// THE TWO VERDICTS, SAID APART — KAN-317.
//
// The failure mode of this whole change is a reader who takes a green
// `approval-gate` job for an approval, so the job log states which question
// each colour answers rather than leaving it to be inferred from an exit code.
const gateHealthy = gateDefects.length === 0;
const exitCode = exitCodeFor({ gateHealthy, approved: verdict.ok, exitOn });

console.log('');
console.log('─── verdicts ───────────────────────────────────────────────────────────');
console.log(`  approval  ${verdict.ok ? 'APPROVED' : 'NOT APPROVED'} at this head`);
console.log(`            carried by the required commit status \`${CONTEXT}\`${postStatus ? '' : ' (suppressed: --no-status)'}`);
console.log(`  gate      ${gateHealthy ? 'HEALTHY' : 'BROKEN'} — did this check manage to publish that answer?`);
console.log(`            carried by this job's own conclusion (\`approval-gate\`, not required)`);
if (!gateHealthy) for (const d of gateDefects) console.log(`              - ${d}`);
console.log(`  exiting   ${exitCode} — on ${exitOn}`);
console.log('────────────────────────────────────────────────────────────────────────');

if (!verdict.ok && gateHealthy && exitCode === 0) {
  console.log('');
  console.log('This job is GREEN and this pull request is NOT APPROVED. That is the designed');
  console.log(`reading, not a hole: \`${CONTEXT}\` is red and it is the context branch protection`);
  console.log('requires, so the merge is BLOCKED. The job is green because the gate itself is');
  console.log('working — it read the head and published the refusal above.');
  console.log('');
  console.log('The job used to go red here too, and could never go green again afterwards: a');
  console.log('comment-triggered re-run attaches to the default branch, not to this head, so the');
  console.log('red run was never replaced and every approved pull request read UNSTABLE forever.');
  console.log('KAN-317. Do not "fix" that by rebasing — a rebase voids the approval marker.');
}

process.exit(exitCode);
