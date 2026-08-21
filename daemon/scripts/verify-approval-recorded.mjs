// KAN-306: the approval gate actually refuses.
// KAN-317: and it refuses on the carrier that can retract the refusal.
//
// KAN-321: and it can tell a marker being USED from one being MENTIONED.
//
// WHAT FAILURE THIS WOULD CATCH: `approval-recorded` passing a pull request
// that carries no approval, or one whose approval names a commit that is no
// longer the head, or one whose approval is signed by an agent other than the
// approver the pull request declares. That is the gate failing open, which is
// the exact state this repository was in before KAN-306: zero review verdicts
// across #120–#130, `required_approving_review_count: 0`, and every approval a
// PR comment that no machine could tell from any other comment.
//
// AND SINCE KAN-321, ALSO: a pull request satisfying the gate with a marker
// nobody asserted. `task/KAN-317` asked `epic/KAN-39` for an approval on #139 by
// pasting the line it needed inside a code fence, and `approval-recorded` went
// green fifteen seconds later describing an approval that did not exist — 47
// seconds before the real one arrived. §11 drives both of those comments,
// byte-exact, and requires the gate to refuse the first and accept the second.
//
// AND SINCE KAN-453, ALSO: the gate reporting success from a run that judged
// nothing because it did not understand its own arguments. `arg()` was
// `argv.indexOf`, so any token that was not `--pr` was not rejected but unread,
// and the run fell through to the "no pull request here" branch that a push
// build legitimately takes. `--check 189` (the sibling project's spelling for the
// same idea), a typo, and no arguments at all produced byte-identical output and
// the same exit code — so in a recipe that says "merge if it exits 0", a
// carried-across command was an approval nobody gave. §15 drives those exact
// vectors and requires the first two to be refused and the third to be untouched.
//
// AND SINCE KAN-627, ALSO: the required status posting the WRONG REASON for a
// refusal. The `description` was one hardcoded sentence — "no approval marker
// naming this head — see the job log" — for all eight refusals `evaluate` can
// reach, and it is true of two of them. In the other six a marker naming this
// exact head can be sitting on the pull request, asserted and correct: a wrong
// signer, a quoted marker, and all four ways the approver DECLARATION can fail.
// The status is the only line most readers see, so a refusal reported as an
// absent marker sends the approver to re-post a marker that is already there.
// It also spent 53 of the 140 characters GitHub allows, so there was room for
// the truth and it went unused. §16 drives every refusal path through
// `statusDescription` and requires each to be said in its own words, inside the
// limit, and — for the six — without claiming the marker is missing.
//
// AND SINCE KAN-317, ALSO: the approval verdict leaking back into the job's own
// exit code. That is the opposite failure and it is not a fail-open — the gate
// refuses correctly and then cannot un-refuse, because a workflow run's
// conclusion is fixed when the run ends and the comment-triggered re-evaluation
// attaches to the default branch rather than to the head. Every pull request
// starts unapproved, so every pull request kept a permanent red `approval-gate`
// run and every APPROVED pull request read `mergeStateStatus: UNSTABLE` rather
// than `CLEAN` (#133, #134, #135, #137, #138). The cost is a loop: UNSTABLE
// looks like a real problem, the natural repair is `gh pr update-branch`, and
// that moves the head and voids the approval. It fired on #138.
//
// §9 and §10 are that regression. They pin the SPLIT — a red status under a
// green job — in both directions, so that a future author who "simplifies" the
// two carriers back into one exit code is caught here rather than on the fifth
// approved pull request that will not go CLEAN.
//
// CI-RUNNABLE: yes — drives `lib/approval-marker.mjs` over fixtures in process,
// and drives `check-approval-recorded.mjs` as a child against a stub GitHub API
// bound to 127.0.0.1. No herdr, no live daemon, no credential, no peer, no
// terminal, and no egress: the only socket it opens is its own loopback stub.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST — required by
// `prompts/task.md`, and it is the rule this epic keeps re-learning. §1–§7 build
// the comments and the head SHA they then assert on, so they test the DECISION
// and never that the decision meets real data. §8 and §10 close part of that by
// running the real entry point over real HTTP against a stub, so the event
// parsing, the pagination, the JSON shape and the status POST are genuinely
// exercised — but a stub is still a fixture, and it cannot establish that
// GitHub's own payload looks like the stub's. §10 is a pure truth table over
// `exitCodeFor` and supplies both of its inputs, so it pins the POLICY and says
// nothing about whether the entry point classifies a real failure correctly;
// §9 is what connects the policy to the script.
//
// §11 IS THE ONE LEG THAT DOES NOT SUPPLY ITS OWN INPUT, and that is the whole
// reason it exists. Its two comment bodies are byte-exact recordings of real
// GitHub comments rather than anything an author here composed — so it cannot
// pass by testing the scanner against its author's idea of what a fenced marker
// looks like. What a recording still cannot establish is that GitHub returns
// those bytes TODAY: a comment is editable, and nothing in CI re-fetches. The
// hashes and the exact re-fetch command are in `fixtures/kan-321/README.md`, and
// the live comparison against the API is pasted in the KAN-321 pull request
// body. If those two disagree in future, the comment was edited — that is not
// this file being wrong, and §11's first two assertions exist to say so loudly
// rather than let a hollowed-out recording pass silently.
//
// WHAT NOTHING HERE COVERS: that the marker a real approver posts on a real pull
// request reaches this check. Nobody covers that by script and nobody can — it
// needs an observation of the running system. The KAN-306 pull request carries
// that observation in its body: the three reds driven live on the pull request
// itself, and the green after the real approval landed. If you are reading this
// later and want the evidence, it is in that pull request and not in this file.
//
// AND NOTHING HERE COVERS FORGERY, WHICH KAN-321 DID NOT CHANGE. The honest
// sentence after KAN-321 is *"the gate no longer fires by accident"*. It is
// smaller than *"the gate cannot be satisfied by the author"*, and the smaller
// one is the true one: an author who writes the marker as a plain top-level line
// still satisfies the gate, exactly as before, because every agent here is the
// same GitHub user. #132 carries two markers posted deliberately as
// demonstrations — top level, and refused only because their SHA and signer were
// wrong; one naming the right head and the right approver would be accepted
// today. What changed is that a marker a comment merely SHOWS no longer counts,
// so a green `approval-recorded` now means somebody meant it. Nobody covers the
// gap between those two sentences by script; separate GitHub identities per
// agent is the only thing that would, and it remains the follow-up KAN-306
// named.
//
// AND NOTHING HERE COVERS THE THING KAN-317 IS ACTUALLY ABOUT — that GitHub
// computes `mergeStateStatus: CLEAN` from the resulting set of check runs. This
// script can prove the job exits 0; it cannot prove what GitHub concludes from
// that, because a stub GitHub has no merge state. That leg is an observation of
// the running system too, and it is in the KAN-317 pull request body: the same
// pull request read BLOCKED unapproved, CLEAN approved, and BLOCKED again after
// a push voided the marker. If a future reader needs it, it is there.
//
// Usage: node daemon/scripts/verify-approval-recorded.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  evaluate,
  parseMarkers,
  parseQuotedMarkers,
  parseDeclaredApprover,
  parseQuotedApprover,
  ownTicketFromRef,
  scanQuoted,
  assertedText,
  exitCodeFor,
  addRefusal,
  statusDescription,
  EXIT_ON,
  QUOTED,
  REFUSAL,
  STATUS_DESCRIPTION_LIMIT
} from './lib/approval-marker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

let failures = 0;
let checks = 0;
// Counted rather than written into the closing line by hand. The old wording
// said "8 sections" as a literal, which is a number that goes stale the moment
// somebody adds a section and forgets — KAN-317 added two.
let sections = 0;

function ok(what, condition, detail = '') {
  checks++;
  if (condition) {
    if (verbose) console.log(`    ok    ${what}`);
  } else {
    failures++;
    console.log(`    FAIL  ${what}${detail ? `\n          ${detail}` : ''}`);
  }
}

function section(n, title) {
  sections++;
  console.log(`\n§${n} ${title}`);
}

const HEAD = 'a'.repeat(39) + '7';
const OLD = 'b'.repeat(39) + '3';
const REF = 'butchr/KAN-306';
const BODY = 'Implements KAN-306.\n\nBUTCHR-APPROVER: epic/KAN-39\n';
const approval = (sha, by) => ({ id: 1, body: `Re-ran the proof at this head.\n\nBUTCHR-APPROVAL: ${sha} BY ${by}\n\nGood to merge.` });

// ---------------------------------------------------------------------------
section(1, 'a correctly-marked pull request passes — the positive control');
{
  const v = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(HEAD, 'epic/KAN-39')] });
  ok('a marker at the head, by the declared approver, is accepted', v.ok, v.reasons.join(' | '));
  ok('the accepted marker is reported back', v.accepted?.approver === 'epic/KAN-39' && v.accepted?.sha === HEAD);
  ok('a passing verdict carries no reasons', v.reasons.length === 0);
}

// ---------------------------------------------------------------------------
section(2, 'no marker at all is refused — the omission case');
{
  const v = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [{ id: 2, body: 'Looks good to me, CI is green.' }] });
  ok('a pull request with no marker fails', !v.ok);
  ok('"looks good" and "CI is green" are not an approval', v.markers.length === 0);
  ok('the reason tells the reader the exact line to post', v.reasons.some((r) => r.includes(`BUTCHR-APPROVAL: ${HEAD} BY epic/KAN-39`)));
  const empty = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [] });
  ok('a pull request with no comments at all fails', !empty.ok);
}

// ---------------------------------------------------------------------------
section(3, 'an approval does not survive its head — the staleness case');
{
  const before = evaluate({ headSha: OLD, headRef: REF, prBody: BODY, comments: [approval(OLD, 'epic/KAN-39')] });
  ok('the approval is valid at the head it names', before.ok, before.reasons.join(' | '));

  // The same comments, one push later. Nothing about the approval changed; the
  // head did. This is the leg `dismiss_stale_reviews: true` was believed to be
  // doing and never was, because it dismisses review verdicts and there have
  // never been any.
  const after = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(OLD, 'epic/KAN-39')] });
  ok('the same approval is refused once the head moves', !after.ok);
  ok('the reason names both the head and the stale marker', after.reasons.some((r) => r.includes(HEAD) && r.includes(OLD.slice(0, 12))));
  ok('the reason names `gh pr update-branch` as a cause', after.reasons.some((r) => r.includes('update-branch')));
}

// ---------------------------------------------------------------------------
section(4, 'a marker signed by the wrong agent is refused');
{
  const v = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(HEAD, 'epic/KAN-59')] });
  ok('an approval at the head from an undeclared agent fails', !v.ok);
  ok('the reason names both the signer and the declared approver', v.reasons.some((r) => r.includes('epic/KAN-59') && r.includes('epic/KAN-39')));

  const both = evaluate({
    headSha: HEAD,
    headRef: REF,
    prBody: BODY,
    comments: [approval(HEAD, 'epic/KAN-59'), approval(HEAD, 'epic/KAN-39')]
  });
  ok('the declared approver among several markers is accepted', both.ok, both.reasons.join(' | '));
}

// ---------------------------------------------------------------------------
section(5, 'an agent cannot declare itself its own approver');
{
  const v = evaluate({
    headSha: HEAD,
    headRef: REF,
    prBody: 'BUTCHR-APPROVER: task/KAN-306\n',
    comments: [approval(HEAD, 'task/KAN-306')]
  });
  ok('a pull request declaring its own ticket as approver fails', !v.ok);
  ok('the reason names the ticket the branch is working', v.reasons.some((r) => r.includes('KAN-306')));
  ok('the branch name is what identifies the pull request\'s own ticket', ownTicketFromRef(REF) === 'KAN-306');
  ok('a branch outside the convention yields no own-ticket', ownTicketFromRef('feature/whatever') === null);
}

// ---------------------------------------------------------------------------
section(6, 'the pull request must declare an approver in advance');
{
  const v = evaluate({ headSha: HEAD, headRef: REF, prBody: 'Implements KAN-306.', comments: [approval(HEAD, 'epic/KAN-39')] });
  ok('a marker with no declared approver fails', !v.ok);
  ok('the reason gives the line to add', v.reasons.some((r) => r.includes('BUTCHR-APPROVER:')));

  const junk = evaluate({ headSha: HEAD, headRef: REF, prBody: 'BUTCHR-APPROVER: Wroos Bit\n', comments: [approval(HEAD, 'epic/KAN-39')] });
  ok('a declared approver that is not a <type>/<KEY> agent fails', !junk.ok);
}

// ---------------------------------------------------------------------------
section(7, 'the marker grammar');
{
  ok('a 40-character SHA is required — an abbreviation is refused',
    parseMarkers([{ id: 1, body: 'BUTCHR-APPROVAL: 1abbf50 BY epic/KAN-39' }]).length === 0);
  ok('the marker must be on a line of its own',
    parseMarkers([{ id: 1, body: 'I said BUTCHR-APPROVAL: ' + HEAD + ' BY epic/KAN-39 earlier' }]).length === 0);
  ok('prose above and below the marker is fine',
    parseMarkers([approval(HEAD, 'epic/KAN-39')]).length === 1);
  ok('an uppercase SHA is normalised rather than refused',
    parseMarkers([{ id: 1, body: `BUTCHR-APPROVAL: ${HEAD.toUpperCase()} BY epic/KAN-39` }])[0]?.sha === HEAD);
  ok('leading indentation is tolerated',
    parseMarkers([{ id: 1, body: `   BUTCHR-APPROVAL: ${HEAD} BY epic/KAN-39` }]).length === 1);
  ok('a marker without a BY clause is refused',
    parseMarkers([{ id: 1, body: `BUTCHR-APPROVAL: ${HEAD}` }]).length === 0);
  ok('markers are found across several comments',
    parseMarkers([{ id: 1, body: 'nothing' }, approval(OLD, 'epic/KAN-39'), approval(HEAD, 'epic/KAN-39')]).length === 2);
}

// ---------------------------------------------------------------------------
section(8, 'the real entry point, over real HTTP, against a stub GitHub');
{
  // WHAT THIS LEG ADDS OVER §1–§7, AND WHAT IT STILL DOES NOT. It runs
  // `check-approval-recorded.mjs` as a child, so the event-file parsing, the
  // comment pagination, the JSON decoding, the verdict and the status POST are
  // all genuinely executed rather than reasoned about. It does NOT establish
  // that GitHub's real payload matches this stub's shape — a stub is a fixture,
  // and the header says so.
  //
  // KAN-317 CHANGED WHAT EVERY LEG HERE ASSERTS, and the change is a
  // strengthening rather than a relaxation. Each refusal leg used to check one
  // thing — that the child exited non-zero — and that single assertion was
  // satisfied by the very defect KAN-317 fixes. Each now checks BOTH carriers:
  // the status went red (the gate refused) AND the exit code stayed 0 (the
  // refusal did not leak into a job conclusion that can never be retracted).
  // Asserting only the first would let the defect back in; asserting only the
  // second would let a fail-open through.
  const state = { statuses: [], commentPages: 0 };
  // Flipped by the leg that proves an unpublishable status is a gate defect.
  let statusPostFails = false;

  const pr = (sha) => ({ number: 999, title: 'KAN-306 fixture', head: { sha, ref: REF }, body: BODY });
  let currentSha = HEAD;
  let currentComments = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/pulls/999') return send(200, pr(currentSha));
    if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/issues/999/comments') {
      state.commentPages++;
      return send(200, Number(url.searchParams.get('page')) === 1 ? currentComments : []);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/repos/wroosbit/butchr/statuses/')) {
      let body = '';
      req.on('data', (d) => (body += d));
      return req.on('end', () => {
        if (statusPostFails) return send(500, { message: 'stub is refusing to publish the status' });
        state.statuses.push({ sha: url.pathname.split('/').pop(), ...JSON.parse(body) });
        send(201, { id: 1 });
      });
    }
    send(404, { message: `stub has no route for ${req.method} ${url.pathname}` });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan306-'));
  const eventPath = path.join(tmp, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 999 } }));

  // `spawn` and not `spawnSync`, and the difference is not stylistic: the stub
  // server above lives in THIS process, so a synchronous spawn blocks the very
  // event loop the stub needs in order to answer the child. That deadlocks —
  // the child waits on a response the parent cannot send until the child exits.
  // Written down because it is invisible until it hangs, and it hung here first.
  const run = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(here, 'check-approval-recorded.mjs'), ...args], {
        env: {
          ...process.env,
          GITHUB_API_URL: base,
          GITHUB_REPOSITORY: 'wroosbit/butchr',
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_TOKEN: '',
          GITHUB_RUN_ID: ''
        }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  currentComments = [];
  let r = await run();
  ok('end to end: no marker publishes a FAILURE status at the head',
    state.statuses.at(-1)?.state === 'failure' && state.statuses.at(-1)?.sha === HEAD,
    JSON.stringify(state.statuses.at(-1)));
  ok('end to end: the published context is `approval-recorded`', state.statuses.at(-1)?.context === 'approval-recorded');
  ok('end to end: no marker still exits ZERO — the refusal is the status, not the job',
    r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);

  currentComments = [approval(OLD, 'epic/KAN-39')];
  r = await run();
  ok('end to end: a stale marker publishes a FAILURE status', state.statuses.at(-1)?.state === 'failure');
  ok('end to end: a stale marker exits zero', r.status === 0, `exit ${r.status}`);

  currentComments = [approval(HEAD, 'epic/KAN-59')];
  r = await run();
  ok('end to end: a marker from the wrong approver publishes a FAILURE status',
    state.statuses.at(-1)?.state === 'failure');
  ok('end to end: a marker from the wrong approver exits zero', r.status === 0, `exit ${r.status}`);

  currentComments = [approval(HEAD, 'epic/KAN-39')];
  r = await run();
  ok('end to end: a correct marker exits zero', r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
  ok('end to end: a correct marker publishes a SUCCESS status at the head',
    state.statuses.at(-1)?.state === 'success' && state.statuses.at(-1)?.sha === HEAD);
  ok('end to end: the success description names the approver',
    (state.statuses.at(-1)?.description ?? '').includes('epic/KAN-39'));
  ok('end to end: the log states the forgery limit rather than claiming enforcement',
    r.stdout.includes('never forgery'));

  // The head moving is the whole design, so it is exercised end to end too.
  currentSha = 'c'.repeat(40);
  r = await run();
  ok('end to end: the same approval publishes a FAILURE status once the head moves',
    state.statuses.at(-1)?.state === 'failure');
  ok('end to end: the failure status is published at the NEW head',
    state.statuses.at(-1)?.sha === 'c'.repeat(40) && state.statuses.at(-1)?.state === 'failure');
  ok('end to end: a moved head exits zero', r.status === 0, `exit ${r.status}`);
  currentSha = HEAD;

  // -------------------------------------------------------------------------
  section(9, 'KAN-317: the split, end to end — a red status under a green job');
  {
    // §10 below pins the policy in the abstract. This pins that the ENTRY POINT
    // classifies real conditions into it, which is the leg §10 cannot reach: a
    // truth table that supplies its own `gateHealthy` proves nothing about
    // whether an unpublishable status actually sets it.
    currentComments = [];
    let x = await run();
    ok('an unapproved pull request leaves the job green', x.status === 0, `exit ${x.status}`);
    ok('...and the job log says so in words, not just in an exit code',
      x.stdout.includes('This job is GREEN and this pull request is NOT APPROVED'),
      x.stdout.slice(-600));
    ok('...and names the required status as what blocks the merge',
      x.stdout.includes('approval-recorded') && x.stdout.includes('BLOCKED'));
    ok('...and warns against the rebase that would void the approval',
      x.stdout.includes('voids the approval marker'));
    ok('the two verdicts are reported apart',
      x.stdout.includes('NOT APPROVED at this head') && x.stdout.includes('gate      HEALTHY'),
      x.stdout.slice(-600));

    // WITH NO STATUS THERE IS NO OTHER CARRIER, so the exit code has to be the
    // answer. This is the leg that stops the fix from being "the job never
    // fails": suppress the status and the refusal comes straight back.
    const publishedBefore = state.statuses.length;
    x = await run('--no-status');
    ok('--no-status puts the approval verdict back into the exit code', x.status === 1, `exit ${x.status}`);
    ok('--no-status publishes nothing at all',
      state.statuses.length === publishedBefore && !x.stdout.includes('posted commit status'),
      `${state.statuses.length - publishedBefore} status(es) published`);
    ok('--no-status says the status was suppressed', x.stdout.includes('suppressed: --no-status'));

    currentComments = [approval(HEAD, 'epic/KAN-39')];
    x = await run('--no-status');
    ok('--no-status still exits zero when the approval is good', x.status === 0, `exit ${x.status}`);

    // ...and the mode can be named outright, so a caller that suppresses the
    // status and genuinely wants gate health can say so.
    currentComments = [];
    x = await run('--no-status', '--exit-on-gate-health');
    ok('--exit-on-gate-health overrides the --no-status default', x.status === 0, `exit ${x.status}`);
    x = await run('--exit-on-approval');
    ok('--exit-on-approval restores the pre-KAN-317 CI behaviour', x.status === 1, `exit ${x.status}`);

    // A GATE THAT CANNOT PUBLISH IS BROKEN, and that IS the job's failure —
    // under both modes. This is the assertion that keeps `approval-gate`
    // meaningful rather than decorative, which is the objection KAN-317 raised
    // against simply exiting 0 always.
    statusPostFails = true;
    currentComments = [approval(HEAD, 'epic/KAN-39')];
    x = await run();
    ok('an unpublishable status is a GATE defect: the job goes red even when approved',
      x.status === 1, `exit ${x.status}\n${x.stdout}`);
    ok('...and it is reported as the gate being broken, not the PR refused',
      x.stdout.includes('gate      BROKEN'), x.stdout.slice(-600));
    ok('...and the reason names the context it could not publish',
      x.stdout.includes('could not be published'));
    statusPostFails = false;
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section(10, 'KAN-317: the exit-code policy, exhaustively');
{
  // Eight rows is the whole input space, so this is a proof rather than a
  // sample. The row that matters is the one the defect got wrong — healthy
  // gate, unapproved PR, gate-health mode — and it is surrounded here by the
  // seven that must not change with it.
  const T = true;
  const F = false;
  const G = EXIT_ON.GATE_HEALTH;
  const A = EXIT_ON.APPROVAL;
  const table = [
    // gateHealthy, approved, exitOn, expected, why
    [T, T, G, 0, 'approved and healthy: nothing to report'],
    [T, F, G, 0, 'THE FIX — unapproved is the status\'s verdict, not the job\'s'],
    [T, T, A, 0, 'approved, and the caller asked for the approval answer'],
    [T, F, A, 1, 'unapproved, and the caller asked for the approval answer'],
    [F, T, G, 1, 'a broken gate is red even when the PR looks approved'],
    [F, F, G, 1, 'a broken gate is red'],
    [F, T, A, 1, 'a broken gate is red under the approval mode too'],
    [F, F, A, 1, 'a broken gate is red under the approval mode too']
  ];
  for (const [gateHealthy, approved, exitOn, expected, why] of table) {
    const got = exitCodeFor({ gateHealthy, approved, exitOn });
    ok(`exit ${expected} when gateHealthy=${gateHealthy} approved=${approved} exitOn=${exitOn} — ${why}`,
      got === expected, `got ${got}`);
  }

  // The invariant stated as itself, not just as four rows: no mode excuses a
  // broken gate. A future author adding a third mode has to keep this true.
  ok('no mode can make a broken gate green',
    [G, A].every((m) => [true, false].every((a) => exitCodeFor({ gateHealthy: false, approved: a, exitOn: m }) === 1)));

  // `.mjs` cannot spell `exitOn` as a literal type, so the closed set is
  // enforced by a throw. A typo must crash rather than silently pick a branch —
  // which, for a gate, means reporting the wrong colour.
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok('an unknown exitOn is refused rather than defaulted',
    throws(() => exitCodeFor({ gateHealthy: true, approved: false, exitOn: 'gate-heath' })));
  ok('a missing exitOn is refused', throws(() => exitCodeFor({ gateHealthy: true, approved: false })));
  ok('a non-boolean verdict is refused rather than coerced',
    throws(() => exitCodeFor({ gateHealthy: true, approved: 'yes', exitOn: G })));
  ok('EXIT_ON is frozen so the closed set cannot be widened by accident',
    Object.isFrozen(EXIT_ON));
}

// ---------------------------------------------------------------------------
section(11, 'KAN-321: the two real comments, 62 seconds apart, told apart');
{
  // AC1 AND AC2, AND THEY ARE THE SAME ASSERTION SEEN TWICE. These are not
  // fixtures: they are byte-exact recordings of the two comments on #139 that
  // the gate could not distinguish — the request that turned `approval-recorded`
  // green at 00:09:05Z, and the genuine approval that arrived at 00:09:52Z. Both
  // are by the GitHub user `brooswit`, which is exactly why authorship cannot be
  // the discriminator and structure has to be. Provenance and re-fetch hashes
  // are in `fixtures/kan-321/README.md`.
  const fx = (name) => fs.readFileSync(path.join(here, 'fixtures', 'kan-321', name), 'utf8');
  const REQUEST = fx('pr139-comment-5260338837-request.md');
  const APPROVAL = fx('pr139-comment-5260345802-approval.md');

  // The real head of #139, its real branch, and its real declared approver.
  const H139 = '9d9893b6afd17048df6a27af10465d0efaf65db1';
  const REF139 = 'butchr/KAN-317';
  const BODY139 = 'Implements KAN-317.\n\nBUTCHR-APPROVER: epic/KAN-39\n';

  ok('the recordings are intact — the request still contains a marker line at all',
    /^[ \t]*BUTCHR-APPROVAL:[ \t]+[0-9a-f]{40}[ \t]+BY/im.test(REQUEST),
    'the fixture no longer contains what it was recorded for');
  ok('the recordings are intact — so does the approval',
    /^[ \t]*BUTCHR-APPROVAL:[ \t]+[0-9a-f]{40}[ \t]+BY/im.test(APPROVAL));

  // AC1 — the request is refused.
  const req = evaluate({ headSha: H139, headRef: REF139, prBody: BODY139, comments: [{ id: 5260338837, body: REQUEST, user: { login: 'brooswit' } }] });
  ok('AC1: the request comment does NOT satisfy the gate', !req.ok, req.reasons.join(' | '));
  ok('AC1: ...and it is refused for being a quotation, not for some unrelated reason',
    req.reasons.some((r) => r.includes('quoted rather than asserted')), req.reasons.join(' | '));
  ok('AC1: ...and nothing was accepted', req.accepted === null);
  ok('AC1: ...and the marker WAS seen, so the reason can name it',
    req.quotedMarkers.length === 1 && req.quotedMarkers[0].sha === H139);
  ok('AC1: ...inside a fenced code block specifically',
    req.quotedMarkers[0]?.quotedAs === QUOTED.FENCED_CODE, req.quotedMarkers[0]?.quotedAs);
  ok('AC1: ...and the refusal names the comment id, so a reader can go and look',
    req.reasons.some((r) => r.includes('5260338837')));

  // AC2 — the genuine approval still works. This is the leg that stops the fix
  // from being "refuse everything", which is the failure mode the supervisor
  // named up front: the failure mode of every fix in this area is a gate that
  // always looks fine.
  const app = evaluate({ headSha: H139, headRef: REF139, prBody: BODY139, comments: [{ id: 5260345802, body: APPROVAL, user: { login: 'brooswit' } }] });
  ok('AC2: the genuine approval DOES satisfy the gate', app.ok, app.reasons.join(' | '));
  ok('AC2: ...and it is accepted at the right head by the right approver',
    app.accepted?.sha === H139 && app.accepted?.approver === 'epic/KAN-39');
  ok('AC2: ...and it is the real comment that carries it', app.accepted?.commentId === 5260345802);

  // AND THE PAIR TOGETHER, which is the state #139 was actually in. Both
  // comments present: the approval must still be accepted, and the quoted one
  // must neither count nor interfere.
  const both = evaluate({
    headSha: H139,
    headRef: REF139,
    prBody: BODY139,
    comments: [
      { id: 5260338837, body: REQUEST, user: { login: 'brooswit' } },
      { id: 5260345802, body: APPROVAL, user: { login: 'brooswit' } }
    ]
  });
  ok('both comments together: the real approval still passes', both.ok, both.reasons.join(' | '));
  ok('both comments together: the accepted marker is the approval, not the request',
    both.accepted?.commentId === 5260345802);
  ok('both comments together: exactly one asserted marker, and one quoted',
    both.markers.length === 1 && both.quotedMarkers.length === 1);

  // THE DEFECT ITSELF, PINNED. On the pre-KAN-321 grammar the request alone was
  // enough. Asserting on the raw regex rather than on `parseMarkers` is what
  // makes this a record of the old behaviour rather than a restatement of the
  // new one — `parseMarkers` is the thing that changed.
  const OLD_GRAMMAR = /^[ \t]*BUTCHR-APPROVAL:[ \t]+([0-9a-f]{40})[ \t]+BY[ \t]+(\S+)[ \t]*$/gim;
  OLD_GRAMMAR.lastIndex = 0;
  ok('the old grammar DID match the request — this is the defect, recorded',
    OLD_GRAMMAR.exec(REQUEST) !== null);
  ok('the new reader does not', parseMarkers([REQUEST]).length === 0);
  ok('...while still reading the genuine approval', parseMarkers([APPROVAL]).length === 1);
}

// ---------------------------------------------------------------------------
section(12, 'KAN-321: the scanner, driven directly rather than through a verdict');
{
  // A scanner exercised only through `evaluate` is one whose every failure looks
  // like an approval failure. These drive `scanQuoted` and `assertedText`
  // themselves, so a broken fence rule reports as a broken fence rule.
  const lines = (body) => scanQuoted(body);

  ok('a plain line is the comment speaking', lines('hello')[0] === null);

  const fenced = lines('before\n```\ninside\n```\nafter');
  ok('a backtick fence labels its content', fenced[2] === QUOTED.FENCED_CODE);
  ok('...and the fence lines themselves', fenced[1] === QUOTED.FENCED_CODE && fenced[3] === QUOTED.FENCED_CODE);
  ok('...and nothing outside it', fenced[0] === null && fenced[4] === null);

  ok('an info string does not stop a fence opening', lines('```js\nx\n```')[1] === QUOTED.FENCED_CODE);
  ok('a tilde fence works too', lines('~~~\nx\n~~~')[1] === QUOTED.FENCED_CODE);
  ok('a tilde fence is not closed by backticks',
    lines('~~~\n```\nx\n~~~')[2] === QUOTED.FENCED_CODE);

  // The nested case is the one that matters most here, because a worked example
  // of this gate is written by fencing a fence — which is exactly how KAN-321's
  // own ticket describes the defect.
  const nested = lines('````\n```\nBUTCHR-APPROVAL: x\n```\n````\nout');
  ok('a longer fence is not closed by a shorter one', nested[2] === QUOTED.FENCED_CODE);
  ok('...and the longer one does close it', nested[5] === null);

  ok('an unclosed fence runs to the end of the comment',
    lines('```\na\nb\nc').every((l, i) => (i === 0 ? true : l === QUOTED.FENCED_CODE)));

  ok('a blockquote is quoted', lines('> quoted')[0] === QUOTED.BLOCKQUOTE);
  ok('a nested blockquote is quoted', lines('> > deep')[0] === QUOTED.BLOCKQUOTE);
  ok('four spaces is an indented block', lines('    code')[0] === QUOTED.INDENTED_CODE);
  ok('a tab is an indented block', lines('\tcode')[0] === QUOTED.INDENTED_CODE);
  ok('THREE spaces is not — the grammar has always tolerated that much',
    lines('   still prose')[0] === null);

  ok('a multi-line HTML comment is hidden', lines('<!--\nhidden\n-->\nout')[1] === QUOTED.HTML_COMMENT);
  ok('...and it ends at the closing marker', lines('<!--\nhidden\n-->\nout')[3] === null);
  ok('a complete one-line HTML comment opens nothing',
    lines('<!-- note -->\nout')[1] === null);

  ok('assertedText blanks quoted lines and keeps the line count',
    assertedText('a\n```\nb\n```\nc').split('\n').length === 5 &&
      assertedText('a\n```\nb\n```\nc').split('\n')[2] === '');
  ok('assertedText leaves an unquoted body byte-identical',
    assertedText('a\nb\nc') === 'a\nb\nc');
  ok('assertedText tolerates a nullish body', assertedText(undefined) === '');
  ok('scanQuoted tolerates a nullish body', scanQuoted(null).length === 1);
}

// ---------------------------------------------------------------------------
section(13, 'KAN-321: use versus mention, through the whole verdict');
{
  const quoted = (sha, by, wrap) => ({ id: 7, body: `Please post this for me:\n\n${wrap(`BUTCHR-APPROVAL: ${sha} BY ${by}`)}\n\nthanks.` });

  for (const [name, wrap, context] of [
    ['a code fence', (l) => '```\n' + l + '\n```', QUOTED.FENCED_CODE],
    ['a tilde fence', (l) => '~~~\n' + l + '\n~~~', QUOTED.FENCED_CODE],
    ['a nested fence', (l) => '````\n```\n' + l + '\n```\n````', QUOTED.FENCED_CODE],
    ['an indented block', (l) => '    ' + l, QUOTED.INDENTED_CODE],
    ['a blockquote', (l) => '> ' + l, QUOTED.BLOCKQUOTE],
    ['an HTML comment', (l) => '<!--\n' + l + '\n-->', QUOTED.HTML_COMMENT]
  ]) {
    const v = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [quoted(HEAD, 'epic/KAN-39', wrap)] });
    ok(`a marker inside ${name} does not satisfy the gate`, !v.ok, v.reasons.join(' | '));
    ok(`...and the refusal names it as ${context}`,
      v.quotedMarkers.some((m) => m.quotedAs === context),
      JSON.stringify(v.quotedMarkers));
    ok(`...and the reason tells the approver how to post it properly (${name})`,
      v.reasons.some((r) => r.includes('plain unindented line at the top level')));
  }

  // THE GUARD THAT KEEPS THIS FIX FROM BEING A NEW DEFECT. A pull request that
  // DISCUSSES the gate will quote markers; that must not refuse a real approval
  // sitting beside them. This is the assertion that would catch an
  // implementation which pushed the explanation as an unconditional reason.
  const alongside = evaluate({
    headSha: HEAD,
    headRef: REF,
    prBody: BODY,
    comments: [quoted(HEAD, 'epic/KAN-39', (l) => '```\n' + l + '\n```'), approval(HEAD, 'epic/KAN-39')]
  });
  ok('a quoted marker does not refuse a pull request that also carries a real one', alongside.ok,
    alongside.reasons.join(' | '));
  ok('...and the real one is what was accepted', alongside.accepted?.sha === HEAD);
  ok('...and a passing verdict still carries no reasons', alongside.reasons.length === 0);

  // The same defect one field over: a PR body that SHOWS the convention.
  const showBody = 'Declare your approver like this:\n\n```\nBUTCHR-APPROVER: epic/KAN-39\n```\n';
  ok('a BUTCHR-APPROVER shown inside a fence does not declare anybody',
    parseDeclaredApprover(showBody) === null);
  ok('...and it is reported so the author knows why',
    parseQuotedApprover(showBody)?.approver === 'epic/KAN-39');
  const showV = evaluate({ headSha: HEAD, headRef: REF, prBody: showBody, comments: [approval(HEAD, 'epic/KAN-39')] });
  ok('...and the verdict says the declaration was shown rather than made',
    !showV.ok && showV.reasons.some((r) => r.includes('shown rather than declared')),
    showV.reasons.join(' | '));

  // ...and the ordering bug that made it worth fixing: `DECLARED` is not global,
  // so before KAN-321 an EXAMPLE above a real declaration won outright.
  const exampleFirst = 'For example:\n\n```\nBUTCHR-APPROVER: epic/KAN-59\n```\n\nBUTCHR-APPROVER: epic/KAN-39\n';
  ok('a real declaration below a shown example is the one that counts',
    parseDeclaredApprover(exampleFirst) === 'epic/KAN-39');

  // And the reverse: the request comment's own author is irrelevant, because
  // under one shared identity it is always the same login. Asserting it here
  // stops a future author from "improving" the fix with an authorship rule that
  // cannot work.
  const sameUser = parseQuotedMarkers([{ id: 1, body: '```\nBUTCHR-APPROVAL: ' + HEAD + ' BY epic/KAN-39\n```', user: { login: 'brooswit' } }]);
  ok('the quoted marker records its GitHub author, which is the same login as every other',
    sameUser[0]?.author === 'brooswit');
}

// ---------------------------------------------------------------------------
section(14, 'KAN-321: what was rejected, pinned so it is not silently adopted');
{
  // FOUR CANDIDATES WERE NAMED ON THE TICKET. Recording which was taken is
  // cheaper than re-deriving it, and the supervisor asked for the rejections
  // specifically — "whatever you pick, record what you rejected and why. That is
  // worth more than the fix."
  //
  // (1) REQUIRE THE MARKER TO LEAD THE COMMENT. REJECTED, against data. All 19
  //     markers this repository has ever carried were surveyed (every comment on
  //     every PR, `BUTCHR-APPROVAL` on a line of its own):
  //
  //       16 genuine approvals — every one leads, every one at top level
  //        2 deliberate DEMONSTRATION markers on #132 — line 3, top level,
  //          refused on SHA and on signer
  //        1 accidental — #139 comment 5260338837, line 89, inside a fence
  //
  //     So leading position separates the populations too, and on the survey
  //     alone it would have cost nothing. It was rejected for two reasons, the
  //     second of which is decisive:
  //
  //       - It separates them by a HABIT rather than by the defect. Sixteen
  //         approvals that happen to open with the marker is a convention nobody
  //         was ever told to keep, and the first approver who writes a sentence
  //         before their marker would get a red check for a formatting rule that
  //         appears in no prompt.
  //       - IT CONTRADICTS THE PUBLISHED CONTRACT. `prompts/epic.md` and
  //         `prompts/story.md` both say "prose around the marker is welcome",
  //         and §7 has pinned "prose above and below the marker is fine" since
  //         KAN-306. Adopting candidate 1 was driven as a mutation on this
  //         branch: it turns 20 of these 140 assertions red, across §1, §3, §4,
  //         §7, §8, §9 and §14 — i.e. it does not tighten the gate, it changes
  //         what an approval IS, and six sections already say otherwise.
  //
  //     Fenced exclusion separates the same populations 18-to-1 by naming what
  //     actually went wrong, and turns nothing pre-existing red. The assertions
  //     below pin the rejection so it is not later adopted by accident.
  //
  // (2) IGNORE QUOTED MARKERS. TAKEN — §11 to §13.
  //
  // (3) A DISTINCT REQUEST VOCABULARY (`BUTCHR-APPROVAL-REQUEST:`). REJECTED: it
  //     is a convention, not a mechanism, so it degrades exactly like the one it
  //     replaces — and it only helps an agent who already knows to use it, which
  //     is not the agent this defect catches.
  //
  // (4) SEPARATE GITHUB IDENTITIES PER AGENT. Out of scope and unchanged: it is
  //     the only thing that closes the forgery limit as well, and it remains the
  //     follow-up KAN-306 already named. Nothing here substitutes for it.
  const led = { id: 1, body: `BUTCHR-APPROVAL: ${HEAD} BY epic/KAN-39\n\nRe-ran the proof.` };
  const trailed = { id: 2, body: `Re-ran the proof at this head, output below.\n\nBUTCHR-APPROVAL: ${HEAD} BY epic/KAN-39` };
  ok('a marker that LEADS the comment is accepted',
    evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [led] }).ok);
  ok('a marker with prose ABOVE it is also accepted — candidate 1 was rejected, not quietly adopted',
    evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [trailed] }).ok);
  ok('...and that is true through parseMarkers as well as through evaluate',
    parseMarkers([trailed]).length === 1);

  // The three properties the supervisor said must survive, restated here as a
  // block rather than left implicit across §1–§10 — so that a future author
  // reading only this section still meets them.
  ok('property 1 survives: an unapproved pull request is still refused',
    !evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [] }).ok);
  ok('property 2 survives: a stale marker is still refused',
    !evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(OLD, 'epic/KAN-39')] }).ok);
  ok('property 3 survives: a real approval is still accepted',
    evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(HEAD, 'epic/KAN-39')] }).ok);
}

// ---------------------------------------------------------------------------
section(15, 'KAN-453: an argument the gate does not recognise is a usage error, not a pass');
{
  // WHAT THIS SECTION PINS, AND WHY IT IS NOT "THE NO-PR BRANCH SHOULD FAIL".
  // `arg()` in the entry point was `argv.indexOf`, so before KAN-453 a token
  // that was not `--pr` was not rejected — it was never read. Every such run
  // fell through to the "no pull request here" branch, which a push build takes
  // legitimately and which correctly exits 0. The consequence was that
  //
  //     --check 189            (the sibling project spells the flag this way)
  //     --utter-nonsense-flag 189
  //     <no arguments at all>
  //
  // produced BYTE-IDENTICAL stdout and the same exit code. The script could not
  // distinguish "I am in CI with no pull request to judge" from "somebody handed
  // me arguments I do not understand", and only the first is benign.
  //
  // THE NO-EVENT CI PATH IS NOT THE DEFECT AND IS NOT CHANGED. The legs below
  // marked CONTROL are the half that matters most: a fix that turned push builds
  // red would be worse than the defect it removed. Nothing here touches
  // `gateHealthy` either — "no question to answer" and "I could not answer the
  // question" are deliberately different, and §9/§10 own that separation.
  //
  // WHAT THIS SUPPLIES ITSELF: the argument vectors, and the stub the `--pr`
  // control is judged against. So it tests the DECISION — that argv is walked
  // and an unknown token refused — and not that any real caller ever passes a
  // foreign flag. The observation that one did is on KAN-453 (`task/KAN-433`
  // carried `--check` across from CrabCast and read the 0 as a pass) and in the
  // pull request body, which pastes the four arms run by hand before and after.
  // No script covers the carry-across itself, and none can.
  const state = { statuses: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/pulls/999')
      return send(200, { number: 999, title: 'KAN-453 fixture', head: { sha: HEAD, ref: REF }, body: BODY });
    if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/issues/999/comments')
      return send(200, Number(url.searchParams.get('page')) === 1 ? [approval(HEAD, 'epic/KAN-39')] : []);
    if (req.method === 'POST' && url.pathname.startsWith('/repos/wroosbit/butchr/statuses/')) {
      let body = '';
      req.on('data', (d) => (body += d));
      return req.on('end', () => {
        state.statuses.push({ sha: url.pathname.split('/').pop(), ...JSON.parse(body) });
        send(201, { id: 1 });
      });
    }
    send(404, { message: `stub has no route for ${req.method} ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // THE ENVIRONMENT IS SCRUBBED, and that is load-bearing rather than hygiene:
  // this file runs inside GitHub Actions, where `GITHUB_EVENT_NAME` is set. A
  // leaked event would send the no-argument control down the `pull_request` leg
  // and it would assert nothing about the push path it exists to protect.
  const run = (...args) =>
    new Promise((resolve) => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith('GITHUB_')) delete env[k];
      env.GITHUB_API_URL = base;
      env.GITHUB_REPOSITORY = 'wroosbit/butchr';
      const child = spawn(process.execPath, [path.join(here, 'check-approval-recorded.mjs'), ...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  // --- the defect, in the exact spelling that produced it -------------------
  const foreign = await run('--check', '189');
  ok('a foreign flag is REFUSED rather than silently ignored', foreign.status === 2,
    `exit ${foreign.status}\n${foreign.stdout}${foreign.stderr}`);
  ok('...and the refusal names the argument it did not recognise',
    foreign.stderr.includes('unrecognised argument') && foreign.stderr.includes('--check'), foreign.stderr);
  ok('...and names `--pr`, so the correct spelling is discoverable from the failure',
    foreign.stderr.includes('--pr'), foreign.stderr);
  ok('...and judged nothing: no commit status was published',
    state.statuses.length === 0, JSON.stringify(state.statuses));

  const garbage = await run('--utter-nonsense-flag', '189');
  ok('a garbage flag is refused', garbage.status === 2, `exit ${garbage.status}`);
  const positional = await run('189');
  ok('a bare positional argument is refused — argv is WALKED, not scanned',
    positional.status === 2, `exit ${positional.status}\n${positional.stdout}`);
  const noValue = await run('--pr');
  ok('`--pr` with no value is refused rather than resolving to undefined',
    noValue.status === 2, `exit ${noValue.status}`);
  const notNumber = await run('--pr', 'banana');
  ok('`--pr` with a non-numeric value is refused rather than fetching /pulls/NaN',
    notNumber.status === 2, `exit ${notNumber.status}`);

  // --- THE FINDING ITSELF: the three arms are no longer the same run --------
  const bare = await run();
  ok('CONTROL: no arguments and no event still exits 0 — the CI push path is UNCHANGED',
    bare.status === 0, `exit ${bare.status}\n${bare.stdout}${bare.stderr}`);
  ok('...and still says so in prose rather than exiting silently',
    bare.stdout.includes('nothing to judge'), bare.stdout);
  ok('THE FINDING: a foreign flag and no arguments are no longer byte-identical',
    foreign.stdout + foreign.stderr !== bare.stdout + bare.stderr);
  ok('...and they no longer share an exit code either',
    foreign.status !== bare.status, `${foreign.status} vs ${bare.status}`);

  // --- CONTROLS: every recognised argument still does what it did -----------
  const explicit = await run('--pr', '999');
  ok('CONTROL: `--pr <n>` still selects that pull request', explicit.stdout.includes('resolved:   --pr 999'),
    explicit.stdout);
  ok('CONTROL: `--pr <n>` still runs the gate to a verdict and publishes it',
    explicit.status === 0 && state.statuses.at(-1)?.state === 'success' && state.statuses.at(-1)?.sha === HEAD,
    `exit ${explicit.status} ${JSON.stringify(state.statuses.at(-1))}`);
  const suppressed = await run('--pr', '999', '--no-status');
  ok('CONTROL: `--no-status` is still accepted and still suppresses the status',
    suppressed.status === 0 && suppressed.stdout.includes('suppressed: --no-status'), suppressed.stdout);
  const onApproval = await run('--pr', '999', '--exit-on-approval');
  ok('CONTROL: `--exit-on-approval` is still accepted', onApproval.status === 0, `exit ${onApproval.status}`);
  const onHealth = await run('--pr', '999', '--no-status', '--exit-on-gate-health');
  ok('CONTROL: `--exit-on-gate-health` is still accepted', onHealth.status === 0, `exit ${onHealth.status}`);

  server.close();

  // --- ARM 1: the library, executed rather than imported --------------------
  // A pure module exiting 0 with no output is ordinary Node behaviour, and in
  // most repositories it would be left alone. It is refused here because a
  // silent 0 is indistinguishable from a gate that ran and passed, and this
  // repository reads merge governance off exit codes — `task/KAN-433` ran the
  // sibling project's copy of this library believing it was the check.
  const lib = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'lib', 'approval-marker.mjs'), '--check', '189']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  ok('the library refuses to be run as a check rather than exiting 0 in silence',
    lib.status === 2, `exit ${lib.status}\n${lib.stdout}${lib.stderr}`);
  ok('...and says it is a library, and points at the entry point that takes `--pr`',
    lib.stderr.includes('is a library') && lib.stderr.includes('check-approval-recorded.mjs'), lib.stderr);
  ok('...and it stays silent on stdout, so nothing reads as a verdict', lib.stdout === '', lib.stdout);

  // The guard must fire on a direct run and NOT on an import. This file is the
  // proof of the second half: every assertion above this one used `evaluate`,
  // `parseMarkers` and `exitCodeFor` imported from that same module, so if the
  // guard fired on import this script could never have reached this line.
  ok('...and importing the library does NOT fire the guard — this file is that proof',
    typeof evaluate === 'function' && typeof exitCodeFor === 'function');
}

// ---------------------------------------------------------------------------
section(16, 'KAN-627: the status says WHICH refusal, and spends the 140 characters');
{
  // THE DEFECT, STATED AS A MEASUREMENT. `check-approval-recorded.mjs` posted
  // one hardcoded `description` for every refusal:
  //
  //     no approval marker naming this head — see the job log
  //
  // GitHub allows a commit status 140 characters. That sentence is 53 of them,
  // so 87 went unused — while the sentence itself was FALSE for six of the
  // eight refusals `evaluate` can reach. A wrong signer, a quoted marker and
  // all four approver-declaration failures each occur with a perfectly good
  // marker sitting on the pull request naming this exact head, and the only
  // line most readers see said there was none. That is KAN-609's family with
  // the sign flipped: not a green that should be red, but a red that names the
  // wrong cause — which sends the reader to fix something that is not broken.
  //
  // The constant is not quoted from memory here. It is read off
  // `fixtures/kan-321/pr139-comment-5260338837-request.md`, which is a
  // byte-exact recording of a real comment on #139 pasting the live status of
  // that pull request. So the FIRST assertion below is that the defect existed,
  // taken from a recording rather than from this file's author.
  //
  // WHAT THIS SECTION SUPPLIES ITSELF, AND WHO COVERS THE REST. The verdicts
  // driven through `statusDescription` are built here, exactly as §1–§7 build
  // theirs — so this tests the DECISION about how a refusal is said, and not
  // that GitHub accepts what is said. The end-to-end leg at the bottom runs the
  // real entry point against the same loopback stub §8 and §15 use, so the
  // composition, the POST body and the 140-character bound are genuinely
  // executed; what a stub cannot establish is that GitHub renders or truncates
  // a `description` the way this assumes. That leg is an observation of the
  // running system, and it is pasted into the KAN-627 pull request body: the
  // live `approval-recorded` status of that pull request, read back with
  // `gh api`, in each refusal state it was driven through.
  const OLD_CONSTANT = 'no approval marker naming this head — see the job log';
  const recording = fs.readFileSync(
    path.join(here, 'fixtures', 'kan-321', 'pr139-comment-5260338837-request.md'),
    'utf8'
  );
  ok('THE DEFECT, RECORDED: a real #139 status carried the hardcoded constant',
    recording.includes(OLD_CONSTANT),
    'the recording no longer contains the sentence this section exists to remove');
  ok('...and it spent 53 of the 140 characters, leaving 87 unused',
    OLD_CONSTANT.length === 53 && STATUS_DESCRIPTION_LIMIT - OLD_CONSTANT.length === 87,
    `${OLD_CONSTANT.length} of ${STATUS_DESCRIPTION_LIMIT}`);

  // --- the eight refusals `evaluate` can reach, each said in its own words ---
  //
  // `where` is the classification the ticket turns on: `marker-absent` is a
  // refusal the OLD constant described truthfully, `marker-present` is one it
  // did not — a marker naming this head can exist in every one of these six.
  const LONG = 'epic/' + 'K'.repeat(80) + '-99';
  const cases = [
    ['no-approver-declared', 'marker-present',
      { prBody: 'Implements KAN-306.', comments: [approval(HEAD, 'epic/KAN-39')] }],
    ['approver-quoted', 'marker-present',
      { prBody: 'Declare it like this:\n\n```\nBUTCHR-APPROVER: epic/KAN-39\n```\n', comments: [approval(HEAD, 'epic/KAN-39')] }],
    ['approver-not-an-agent', 'marker-present',
      { prBody: 'BUTCHR-APPROVER: brooswit\n', comments: [approval(HEAD, 'epic/KAN-39')] }],
    ['self-approval', 'marker-present',
      { prBody: 'BUTCHR-APPROVER: task/KAN-306\n', comments: [approval(HEAD, 'task/KAN-306')] }],
    ['no-marker', 'marker-absent',
      { prBody: BODY, comments: [{ id: 2, body: 'Looks good to me, CI is green.' }] }],
    ['stale-marker', 'marker-absent',
      { prBody: BODY, comments: [approval(OLD, 'epic/KAN-39')] }],
    ['wrong-signer', 'marker-present',
      { prBody: BODY, comments: [approval(HEAD, 'epic/KAN-59')] }],
    ['quoted-marker', 'marker-present',
      { prBody: BODY, comments: [{ id: 7, body: 'Please post this:\n\n```\nBUTCHR-APPROVAL: ' + HEAD + ' BY epic/KAN-39\n```\n' }] }]
  ];

  const said = new Map();
  for (const [code, where, input] of cases) {
    const v = evaluate({ headSha: HEAD, headRef: REF, prBody: input.prBody, comments: input.comments });
    const d = statusDescription(v);
    ok(`${code}: the verdict refuses`, !v.ok, v.reasons.join(' | '));
    ok(`${code}: ...and records that code`, v.refusals.some((r) => r.code === code),
      JSON.stringify(v.refusals.map((r) => r.code)));
    ok(`${code}: ...and every reason has a refusal beside it — the arrays stay in lockstep`,
      v.reasons.length === v.refusals.length, `${v.reasons.length} reasons, ${v.refusals.length} refusals`);
    ok(`${code}: ...and the status fits GitHub's 140 characters`,
      d.length > 0 && d.length <= STATUS_DESCRIPTION_LIMIT, `${d.length}: ${d}`);
    ok(`${code}: ...and it is NOT the old hardcoded constant`, d !== OLD_CONSTANT, d);
    if (where === 'marker-present') {
      // THE HEART OF THE TICKET. In each of these six a marker naming this head
      // may exist, so a status claiming there is none is a red for the wrong
      // reason. Asserting on the constant's own words rather than on the code
      // is what makes this a statement about what the READER is told.
      ok(`${code}: ...and does not claim there is no marker naming this head — this is the defect`,
        !d.includes('no approval marker naming this head'), d);
    }
    said.set(code, d);
  }

  ok('all eight refusals are said differently — no two share a description',
    new Set(said.values()).size === said.size,
    JSON.stringify([...said.entries()]));
  ok('and six of the eight are refusals the old constant described falsely',
    cases.filter(([, where]) => where === 'marker-present').length === 6);

  // --- the two gate defects, which are refusals too ---------------------------
  const badHead = evaluate({ headSha: 'not-a-sha', headRef: REF, prBody: BODY, comments: [] });
  ok('an unreadable head is refused with its own code',
    !badHead.ok && badHead.refusals.some((r) => r.code === REFUSAL.HEAD_UNREADABLE),
    JSON.stringify(badHead.refusals));
  ok('...and the early-return path carries refusals in lockstep too',
    badHead.reasons.length === badHead.refusals.length && badHead.reasons.length === 1);
  ok('...and its status names the gate rather than the pull request',
    statusDescription(badHead).includes('gate defect'), statusDescription(badHead));

  // --- the approved case had spare room as well -------------------------------
  const good = evaluate({ headSha: HEAD, headRef: REF, prBody: BODY, comments: [approval(HEAD, 'epic/KAN-39')] });
  const goodDesc = statusDescription(good);
  ok('an approval still names its approver', goodDesc.includes('epic/KAN-39'), goodDesc);
  ok('...and now also the comment a reader can go and check', goodDesc.includes('comment 1'), goodDesc);
  ok('...within the limit', goodDesc.length <= STATUS_DESCRIPTION_LIMIT, `${goodDesc.length}`);

  // --- the bound holds against values this file does not control --------------
  //
  // An approver name, a signer list and a ticket key all come off the pull
  // request. A composed description is only better than a constant if it cannot
  // be pushed over the ceiling by one — a status GitHub rejects for length is a
  // gate nobody can read, which is the defect in a new costume.
  const longSigners = Array.from({ length: 6 }, (_, i) => approval(HEAD, 'epic/SIGNER' + 'X'.repeat(20) + i));
  const wide = evaluate({ headSha: HEAD, headRef: REF, prBody: `BUTCHR-APPROVER: ${LONG}\n`, comments: longSigners });
  const wideDesc = statusDescription(wide);
  ok('an absurd approver name and six signers still fit in 140',
    wideDesc.length <= STATUS_DESCRIPTION_LIMIT, `${wideDesc.length}`);
  // AND THE ASSERTION ABOVE ON ITS OWN IS NOT THE ONE THAT CATCHES A MISSING
  // `clamp`, which was found by driving it red rather than by reading it.
  // Deleting `clamp` from the wrong-signer brief leaves this section GREEN: the
  // packer's last resort hard-slices a single oversized brief, so the ceiling
  // holds and the bound cannot report the damage. What is actually lost is the
  // second half of the sentence — the reader is told who signed and never who
  // was supposed to. THAT is falsifiable, and it is what the next line asserts.
  // (The bound above is not idle: §16's red drive shows an early return that
  // bypasses the packer turns it red. It is simply not the clamp's gate.)
  ok('...and both halves survive: the abbreviated signer AND the declared approver',
    wideDesc.includes(', not '), wideDesc);
  ok('...with the overlong values abbreviated rather than the sentence cut off',
    wideDesc.includes('…'), wideDesc);

  // Ten refusals at once cannot happen through `evaluate`, so it is driven
  // directly: the packer must say how many it dropped rather than showing a
  // silent subset. That is this repository's "an answer about a subset is not an
  // answer about the whole" applied to a 140-character field.
  const crowded = { ok: false, reasons: [], refusals: [] };
  for (const code of Object.values(REFUSAL)) {
    addRefusal(crowded, { code, brief: `refusal brief for ${code}`, reason: `the long form of ${code}` });
  }
  const crowdedDesc = statusDescription(crowded);
  ok('ten refusals at once still fit', crowdedDesc.length <= STATUS_DESCRIPTION_LIMIT, `${crowdedDesc.length}`);
  ok('...and the ones that did not fit are COUNTED rather than silently dropped',
    /\+\d+ more, see the log$/.test(crowdedDesc), crowdedDesc);
  ok('...and what is shown is whole clauses, not a sentence cut mid-word',
    !crowdedDesc.includes('refusal brief for head-unreadab;'), crowdedDesc);
  ok('a red verdict that recorded no refusal says so rather than posting an empty line',
    statusDescription({ ok: false, reasons: [], refusals: [] }).length > 0);

  // --- the closed set is a set, and a typo is a crash ------------------------
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok('REFUSAL is frozen, so the closed set cannot be widened by accident', Object.isFrozen(REFUSAL));
  ok('an unknown refusal code is refused rather than posted',
    throws(() => addRefusal({ reasons: [], refusals: [] }, { code: 'stale-marker-typo', brief: 'x', reason: 'y' })));
  ok('a refusal with no brief is refused — a reason with no short form is how this defect returns',
    throws(() => addRefusal({ reasons: [], refusals: [] }, { code: REFUSAL.NO_MARKER, brief: '', reason: 'y' })));
  ok('a refusal with no reason is refused too',
    throws(() => addRefusal({ reasons: [], refusals: [] }, { code: REFUSAL.NO_MARKER, brief: 'x', reason: '   ' })));
  ok('a passing verdict records no refusals at all', good.refusals.length === 0);

  // --- end to end: what is actually PUBLISHED -------------------------------
  //
  // Everything above drives a pure function. This drives the real entry point
  // over real HTTP and reads the description off the POST body the stub
  // received, because the defect was in the publisher and not in the verdict.
  {
    const state = { statuses: [] };
    let currentComments = [approval(HEAD, 'epic/KAN-59')];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/pulls/999')
        return send(200, { number: 999, title: 'KAN-627 fixture', head: { sha: HEAD, ref: REF }, body: BODY });
      if (req.method === 'GET' && url.pathname === '/repos/wroosbit/butchr/issues/999/comments')
        return send(200, Number(url.searchParams.get('page')) === 1 ? currentComments : []);
      if (req.method === 'POST' && url.pathname.startsWith('/repos/wroosbit/butchr/statuses/')) {
        let body = '';
        req.on('data', (d) => (body += d));
        return req.on('end', () => {
          state.statuses.push({ sha: url.pathname.split('/').pop(), ...JSON.parse(body) });
          send(201, { id: 1 });
        });
      }
      send(404, { message: `stub has no route for ${req.method} ${url.pathname}` });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const run = () =>
      new Promise((resolve) => {
        const env = { ...process.env };
        for (const k of Object.keys(env)) if (k.startsWith('GITHUB_')) delete env[k];
        env.GITHUB_API_URL = base;
        env.GITHUB_REPOSITORY = 'wroosbit/butchr';
        const child = spawn(process.execPath, [path.join(here, 'check-approval-recorded.mjs'), '--pr', '999'], { env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    let r = await run();
    let posted = state.statuses.at(-1);
    ok('end to end: a wrong signer publishes a FAILURE status', posted?.state === 'failure', JSON.stringify(posted));
    ok('end to end: ...whose description names the signer and the declared approver',
      posted?.description?.includes('epic/KAN-59') && posted?.description?.includes('epic/KAN-39'),
      posted?.description);
    ok('end to end: ...and no longer claims there is no marker naming this head',
      posted?.description !== OLD_CONSTANT && !String(posted?.description).includes('no approval marker naming this head'),
      posted?.description);
    ok('end to end: ...within GitHub\'s 140 characters',
      String(posted?.description).length <= STATUS_DESCRIPTION_LIMIT, `${String(posted?.description).length}`);
    ok('end to end: the job log prints what it published, and how much of the budget it used',
      r.stdout.includes('status description:') && r.stdout.includes(`/${STATUS_DESCRIPTION_LIMIT} characters`),
      r.stdout.slice(-800));
    ok('end to end: ...and prints the refusal code beside its prose',
      r.stdout.includes('[wrong-signer]'), r.stdout.slice(-1200));
    ok('end to end: a refusal is still the STATUS and not the job — the KAN-317 split survives',
      r.status === 0, `exit ${r.status}`);

    currentComments = [{ id: 8, body: 'Looks good, CI is green.' }];
    r = await run();
    const absent = state.statuses.at(-1)?.description;
    ok('end to end: the genuinely-absent case is still said, in its own words',
      String(absent).includes('no approval marker'), absent);
    ok('end to end: ...and it differs from the wrong-signer description',
      absent !== posted?.description, `${absent} vs ${posted?.description}`);

    currentComments = [approval(HEAD, 'epic/KAN-39')];
    r = await run();
    posted = state.statuses.at(-1);
    ok('end to end: an approval still publishes SUCCESS naming the approver',
      posted?.state === 'success' && String(posted?.description).includes('epic/KAN-39'),
      JSON.stringify(posted));

    server.close();
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`${failures} of ${checks} assertions FAILED.`);
  console.log('');
  console.log('A failure here means the approval gate does not refuse what it claims to refuse,');
  console.log('or that it refuses on the wrong carrier — see §9/§10 and KAN-317.');
  console.log('Fix `lib/approval-marker.mjs` or `check-approval-recorded.mjs` — not this file.');
} else {
  console.log(`ALL PASS — ${checks} assertions across ${sections} sections.`);
  console.log('');
  console.log('This establishes that the gate REFUSES omission, staleness and a wrong signer,');
  console.log('that it refuses via the `approval-recorded` STATUS while leaving the job green —');
  console.log('so an approved pull request can reach `mergeStateStatus: CLEAN` — and that it');
  console.log('reads a marker a comment ASSERTS while refusing one it merely shows.');
  console.log('');
  console.log('And that when it refuses, the required status says WHICH of the eight refusals');
  console.log('this is, inside the 140 characters GitHub allows — rather than the one constant');
  console.log('it posted for all of them, which was false for six and used 53 of the 140.');
  console.log('');
  console.log('The honest sentence is that the gate no longer fires by ACCIDENT. That is smaller');
  console.log('than "the gate cannot be satisfied by its author", and the smaller one is true:');
  console.log('an author who posts the marker as a plain top-level line still satisfies it.');
  console.log('It does not establish that it catches forgery, and it cannot: every agent is the');
  console.log('same GitHub user, so a task agent can post its own marker. See the header, and');
  console.log('the follow-up ticket linked from KAN-306. Nor does it establish what GitHub');
  console.log('concludes from these check runs — a stub has no merge state; that observation is');
  console.log('in the KAN-317 pull request body.');
}

process.exit(failures ? 1 : 0);
