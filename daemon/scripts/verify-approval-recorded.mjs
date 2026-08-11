// KAN-306: the approval gate actually refuses.
//
// WHAT FAILURE THIS WOULD CATCH: `approval-recorded` passing a pull request
// that carries no approval, or one whose approval names a commit that is no
// longer the head, or one whose approval is signed by an agent other than the
// approver the pull request declares. That is the gate failing open, which is
// the exact state this repository was in before KAN-306: zero review verdicts
// across #120–#130, `required_approving_review_count: 0`, and every approval a
// PR comment that no machine could tell from any other comment.
//
// CI-RUNNABLE: yes — drives `lib/approval-marker.mjs` over fixtures in process,
// and drives `check-approval-recorded.mjs` as a child against a stub GitHub API
// bound to 127.0.0.1. No herdr, no live daemon, no credential, no peer, no
// terminal, and no egress: the only socket it opens is its own loopback stub.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST — required by
// `prompts/task.md`, and it is the rule this epic keeps re-learning. §1–§7 build
// the comments and the head SHA they then assert on, so they test the DECISION
// and never that the decision meets real data. §8 closes part of that by running
// the real entry point over real HTTP against a stub, so the event parsing, the
// pagination, the JSON shape and the status POST are genuinely exercised — but a
// stub is still a fixture, and it cannot establish that GitHub's own payload
// looks like the stub's.
//
// WHAT NOTHING HERE COVERS: that the marker a real approver posts on a real pull
// request reaches this check. Nobody covers that by script and nobody can — it
// needs an observation of the running system. The KAN-306 pull request carries
// that observation in its body: the three reds driven live on the pull request
// itself, and the green after the real approval landed. If you are reading this
// later and want the evidence, it is in that pull request and not in this file.
//
// Usage: node daemon/scripts/verify-approval-recorded.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { evaluate, parseMarkers, ownTicketFromRef } from './lib/approval-marker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

let failures = 0;
let checks = 0;

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
  const state = { statuses: [], commentPages: 0 };

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
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(here, 'check-approval-recorded.mjs')], {
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
  ok('end to end: no marker exits non-zero', r.status === 1, `exit ${r.status}\n${r.stdout}${r.stderr}`);
  ok('end to end: no marker publishes a FAILURE status at the head',
    state.statuses.at(-1)?.state === 'failure' && state.statuses.at(-1)?.sha === HEAD,
    JSON.stringify(state.statuses.at(-1)));
  ok('end to end: the published context is `approval-recorded`', state.statuses.at(-1)?.context === 'approval-recorded');

  currentComments = [approval(OLD, 'epic/KAN-39')];
  r = await run();
  ok('end to end: a stale marker exits non-zero', r.status === 1, `exit ${r.status}`);
  ok('end to end: a stale marker publishes a FAILURE status', state.statuses.at(-1)?.state === 'failure');

  currentComments = [approval(HEAD, 'epic/KAN-59')];
  r = await run();
  ok('end to end: a marker from the wrong approver exits non-zero', r.status === 1, `exit ${r.status}`);

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
  ok('end to end: the same approval fails once the head moves', r.status === 1, `exit ${r.status}`);
  ok('end to end: the failure status is published at the NEW head',
    state.statuses.at(-1)?.sha === 'c'.repeat(40) && state.statuses.at(-1)?.state === 'failure');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`${failures} of ${checks} assertions FAILED.`);
  console.log('');
  console.log('A failure here means the approval gate does not refuse what it claims to refuse.');
  console.log('Fix `lib/approval-marker.mjs` or `check-approval-recorded.mjs` — not this file.');
} else {
  console.log(`ALL PASS — ${checks} assertions across 8 sections.`);
  console.log('');
  console.log('This establishes that the gate REFUSES omission, staleness and a wrong signer.');
  console.log('It does not establish that it catches forgery, and it cannot: every agent is the');
  console.log('same GitHub user, so a task agent can post its own marker. See the header, and');
  console.log('the follow-up ticket linked from KAN-306.');
}

process.exit(failures ? 1 : 0);
