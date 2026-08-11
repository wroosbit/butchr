// KAN-306: the approval gate actually refuses.
// KAN-317: and it refuses on the carrier that can retract the refusal.
//
// WHAT FAILURE THIS WOULD CATCH: `approval-recorded` passing a pull request
// that carries no approval, or one whose approval names a commit that is no
// longer the head, or one whose approval is signed by an agent other than the
// approver the pull request declares. That is the gate failing open, which is
// the exact state this repository was in before KAN-306: zero review verdicts
// across #120–#130, `required_approving_review_count: 0`, and every approval a
// PR comment that no machine could tell from any other comment.
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
// WHAT NOTHING HERE COVERS: that the marker a real approver posts on a real pull
// request reaches this check. Nobody covers that by script and nobody can — it
// needs an observation of the running system. The KAN-306 pull request carries
// that observation in its body: the three reds driven live on the pull request
// itself, and the green after the real approval landed. If you are reading this
// later and want the evidence, it is in that pull request and not in this file.
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
import { evaluate, parseMarkers, ownTicketFromRef, exitCodeFor, EXIT_ON } from './lib/approval-marker.mjs';

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
  console.log('and that it refuses via the `approval-recorded` STATUS while leaving the job');
  console.log('green — so an approved pull request can reach `mergeStateStatus: CLEAN`.');
  console.log('');
  console.log('It does not establish that it catches forgery, and it cannot: every agent is the');
  console.log('same GitHub user, so a task agent can post its own marker. See the header, and');
  console.log('the follow-up ticket linked from KAN-306. Nor does it establish what GitHub');
  console.log('concludes from these check runs — a stub has no merge state; that observation is');
  console.log('in the KAN-317 pull request body.');
}

process.exit(failures ? 1 : 0);
