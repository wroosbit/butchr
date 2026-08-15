// KAN-471: prove `atlassian_get_issue_comments` reaches comments the capped
// read cannot — against real Jira, with the machine's real credential.
//
// WHAT FAILURE THIS WOULD CATCH: a comment-paging operation that is present and
// does not page. The whole claim of that operation is that it reaches PAST a cap
// that lives at the far end, and no pure script can see that: `startAt` is a
// query parameter, and a script asserting the path it built has asserted its own
// string. `verify-atlassian-proxy-read-surface.mjs` covers the containment and
// the bounds; what it cannot cover is whether Jira serves the page.
//
// THE CONTROL, AND WHY IT IS NOT A PAGE COUNT THAT AGREES WITH ITSELF.
// `epic/KAN-39` measured thirteen reads of KAN-39 in one session, every one
// exactly 100 comments, with the oldest id climbing as new ones arrived, and
// asked for a control with a known answer rather than a count agreeing with
// itself. So this probe runs BOTH reads in the same run, seconds apart:
//
//   - the capped read  (`atlassian_get_issue` with fields=comment) — reports
//     its own floor as `startAt`, and returns nothing below it;
//   - the paging read  (`atlassian_get_issue_comments`, startAt=0) — must
//     return ids BELOW that floor.
//
// Both floors are measured in this run rather than quoted from the ticket,
// because the window slides: yesterday's oldest id is not this run's, and a
// hard-coded number would turn a real control into a stale one.
//
// WHY THIS PROBE RAISES THE RESPONSE BUDGET. A page of 5 of KAN-39's comments
// is ~92 KB and the whole capped read is ~1.9 MB, against a 9 KB default — so
// both come back as `{omitted: 'for-budget'}`, which is a real success that
// renders as `undefined` if you read it for ids. The budget is orthogonal to
// what is under test here and is raised for this daemon only. **That is itself
// worth knowing and is why it is stated rather than quietly configured:** an
// agent calling this operation on a long ticket at the default budget gets the
// elision, not the comments, and has to re-read by section.
//
// This is a `probe-`, not a `verify-`: it touches production Atlassian and needs
// the machine's real credential, so CI does not run it and a reviewer re-runs it
// deliberately.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST ─────────────────────
//
// It supplies the credential's location and the issue key `KAN-39` — the one
// ticket on this board known to be past the cap. It supplies NO id it asserts
// on: both floors are read out of the two live responses. What it does not
// cover is the daemon's own poller behaviour under a capped window, which is
// `verify-jira-comment-window.mjs`, and the containment of the arguments, which
// is `verify-atlassian-proxy-read-surface.mjs`. Neither is sufficient alone.
//
// ── THE CREDENTIAL, AND WHY THIS IS NOT A LEAK ─────────────────────────────
//
// Copied **by path** into a throwaway $HOME: never read into this process,
// never printed, never passed as an argument, written only to a 0600 file in a
// 0700 directory removed on exit. The daemon binds its socket inside that $HOME
// and runs with BUTCHR_BOARD_RECONCILE=off, so it cannot see, start or stand
// down any agent of the running fleet.
//
// Usage: node daemon/scripts/probe-jira-comment-paging.mjs [--verbose]
//        Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const VERBOSE = process.argv.includes('--verbose');

/** The one ticket on this board known to be past the cap. */
const CAPPED_KEY = 'KAN-39';
/** A page small enough to read, large enough to show a run of ids. */
const PAGE = 5;

if (!fs.existsSync(path.join(daemonDir, 'dist', 'mcp.js'))) {
  console.error('daemon/dist/mcp.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

const REAL_CRED = path.join(os.homedir(), '.local', 'share', 'butchr', 'jira-credential.json');
if (!fs.existsSync(REAL_CRED)) {
  console.error(`No Jira credential at ${REAL_CRED}; this probe needs the machine's real one.`);
  process.exit(1);
}

let failures = 0;
const rule = (t) => console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`);
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  if (!ok) failures++;
}
const row = (label, value) => console.log(`   ${String(label).padEnd(42)} ${value}`);

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan471-paging-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(REAL_CRED, path.join(butchrDir, 'jira-credential.json'));
fs.chmodSync(path.join(butchrDir, 'jira-credential.json'), 0o600);

let daemon = null;
function cleanup() {
  try { daemon?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

daemon = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
  env: {
    ...process.env,
    HOME: fakeHome,
    BUTCHR_BOARD_RECONCILE: 'off',
    BUTCHR_ATLASSIAN_PROXY: 'confluence-read',
    // See "WHY THIS PROBE RAISES THE RESPONSE BUDGET" above.
    BUTCHR_MCP_RESPONSE_BUDGET_CHARS: '4000000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
daemon.on('error', () => {});
await sleep(2500);

const mcp = spawn(
  process.execPath,
  [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-471'],
  {
    env: {
      ...process.env,
      HOME: fakeHome,
      // The elision happens where the response is COMPOSED, which is this
      // process and not the daemon. Setting it only on the daemon left both
      // reads elided at the 9 KB default and every id empty — a run that
      // looked like "the operation returns nothing" and was the budget.
      BUTCHR_MCP_RESPONSE_BUDGET_CHARS: '4000000'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }
);
const waiting = new Map();
let buffer = '';
let nextId = 0;
mcp.stdout.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const entry = msg.id !== undefined ? waiting.get(msg.id) : undefined;
    if (entry) { waiting.delete(msg.id); entry(msg); }
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 60_000);
  });

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'kan471-paging-probe', version: '0' }
});

async function call(tool, args) {
  const res = await send('tools/call', { name: tool, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (res?.result?.isError || payload?.success === false) {
    check(`${tool} returned data`, false, payload?.error ?? text.slice(0, 300));
    return null;
  }
  if (VERBOSE) console.log(`         ${JSON.stringify(payload?.body).slice(0, 300)}`);
  return payload?.body ?? null;
}

console.log(`Probing comment paging on ${CAPPED_KEY}.`);
console.log(`Credential: ${REAL_CRED} (copied by path, never read here).`);

// ── 1. the capped read, and the floor it reports ───────────────────────────

rule(`1. the capped read — ${CAPPED_KEY} through the issue endpoint`);

const capped = await call('atlassian_get_issue', { issueKey: CAPPED_KEY, fields: 'comment' });
const container = capped?.fields?.comment;
const cappedIds = (container?.comments ?? []).map((c) => Number(c.id)).filter(Number.isFinite);
const cappedFloor = cappedIds.length ? Math.min(...cappedIds) : NaN;

row('total the container reports', container?.total);
row('maxResults', container?.maxResults);
row('startAt', container?.startAt);
row('comments actually returned', cappedIds.length);
row('oldest id returned (the floor)', cappedFloor);

check(
  'the capped read reports a window, not a whole history',
  Number(container?.total) > cappedIds.length && Number(container?.startAt) > 0,
  JSON.stringify({ total: container?.total, returned: cappedIds.length, startAt: container?.startAt })
);
check(
  'and its own arithmetic is exact: startAt + returned === total',
  Number(container?.startAt) + cappedIds.length === Number(container?.total),
  JSON.stringify({ startAt: container?.startAt, returned: cappedIds.length, total: container?.total })
);

// ── 2. the paging read, and whether it goes below that floor ───────────────

rule('2. the paging read — startAt=0, the oldest end');

const page = await call('atlassian_get_issue_comments', {
  issueKey: CAPPED_KEY,
  startAt: 0,
  maxResults: PAGE
});
const pageIds = (page?.comments ?? []).map((c) => Number(c.id)).filter(Number.isFinite);

row('total the container reports', page?.total);
row('maxResults', page?.maxResults);
row('startAt', page?.startAt);
row('ids returned', JSON.stringify(pageIds));

check(
  'the paging read agrees with the capped read about the total',
  Number(page?.total) === Number(container?.total),
  JSON.stringify({ paging: page?.total, capped: container?.total })
);
check(
  `it returns ids BELOW the capped read's floor (${cappedFloor}) — comments no capped read can reach`,
  pageIds.length > 0 && Math.max(...pageIds) < cappedFloor,
  JSON.stringify({ pageIds, cappedFloor })
);

// ── 3. the negative half, so the control discriminates ─────────────────────

rule('3. the negative half — the capped read really cannot see them');

const overlap = pageIds.filter((id) => cappedIds.includes(id));
row('ids in both reads', JSON.stringify(overlap));
// GUARDED ON BOTH READS BEING POPULATED, and the guard is the point. Written
// as `overlap.length === 0` alone it passed on a run where BOTH reads returned
// nothing — a check with no failing branch the world could reach, which is
// exactly what `prompts/*.md` calls a check that does not exist while
// appearing to. It went green on the run that proved the probe was broken.
check(
  'no id from the oldest page appears in the capped read',
  pageIds.length > 0 && cappedIds.length > 0 && overlap.length === 0,
  JSON.stringify({ pageIds: pageIds.length, cappedIds: cappedIds.length, overlap })
);
check(
  'so the two reads cover different parts of one history',
  pageIds.length > 0 && cappedIds.length > 0 && overlap.length === 0,
  JSON.stringify({ oldestPage: pageIds.slice(0, 3), cappedFloor, cappedTop: Math.max(...cappedIds) })
);

try { mcp.kill('SIGKILL'); } catch {}

console.log(
  failures
    ? `\n✗ ${failures} check(s) failed.\n`
    : `\n✓ ${CAPPED_KEY} holds ${container?.total} comments; the issue endpoint returns the newest\n` +
      `  ${cappedIds.length} from startAt ${container?.startAt}, and atlassian_get_issue_comments returns ids\n` +
      `  ${JSON.stringify(pageIds)} — all below the capped floor ${cappedFloor}, none of them reachable\n` +
      `  by any other surface an agent has.\n`
);
process.exit(failures ? 1 : 0);
