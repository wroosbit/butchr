// KAN-441: the Atlassian proxy's OFF state must be distinguishable from a
// BROKEN one — by an operator reading the summary, and by an agent reading its
// own tools.
//
// WHAT FAILURE THIS WOULD CATCH: a state that is fine and a state that is
// broken rendering identically. Two concrete instances, each of which this file
// would have caught the day it was written:
//   (1) `proxyReport()`'s credential warning living only in the ON-state arm of
//       `summary`, so while the proxy is off the operator-facing sentence never
//       mentions the credential — and a report built with `configured: false`
//       reads BYTE-IDENTICALLY to one built with `configured: true`. The one
//       moment the answer can still prevent something is before the flip, which
//       is exactly the state in which the old sentence could not speak.
//   (2) an agent being unable to tell "the proxy is correctly off" from "the
//       daemon could not be asked", because `proxiedOperations()` yields the
//       same empty tool menu for both. After a flip, "my Atlassian tools are
//       missing" is the first symptom anyone reports, and nothing distinguished
//       the flip not taking from the daemon being down from the expected
//       off-state.
//
// ⚠ THE EMPTY MENU IS NOT THE DEFECT AND IS NOT FIXED HERE. "ON FAILURE,
// ADVERTISE NOTHING. A daemon that cannot be asked is not a daemon that said
// yes" is deliberate, correct, and section 4 below asserts it is still true.
// Advertising operations that will refuse is worse than advertising none. What
// KAN-441 changed is that the two non-serving outcomes stopped being the SAME
// VALUE internally, and that an agent has somewhere to READ the difference —
// never that the failure path advertises anything.
//
// CI-RUNNABLE: yes — no network, no herdr, no credential of yours, no terminal.
// Sections 3a/3b spawn a real daemon and a real `mcp.ts` under a temporary
// $HOME that did not exist a moment ago.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ──────────────────────────────────────
//
// REAL: `daemon/dist/atlassian-proxy.js`'s own `proxyReport`; `daemon/dist/
// daemon.js` as its own process; `daemon/dist/mcp.js` as its own process, which
// is byte-for-byte the MCP server every agent runs; the MCP stdio protocol
// spoken properly; the unix socket between them.
//
// NOT REAL: Atlassian. No request leaves this machine. The credential is a
// fabricated string this script writes under a temp $HOME and deletes on exit —
// it is not a token, has never been a token, and no real credential is read.
//
// ⚠ THIS SCRIPT SUPPLIES ITS OWN INPUTS IN SECTIONS 1 AND 2, and that is the
// KAN-145 shape, so it is named rather than left to be inferred. Those sections
// hand `proxyReport` a fabricated `credential` object and a fabricated
// `decision`; they establish that the FUNCTION renders the two worlds
// differently and establish NOTHING about whether the daemon passes it a
// truthful credential. That leg is `router.ts`'s `handleAtlassianProxyStatus`,
// and it is covered live by sections 3a/3b, which read the report off a real
// daemon that built its own credential from disk. Between them the gap is
// closed; neither closes it alone.
//
// ⚠ MIXED READING MODES — READ THE SECTION, NOT THE EXIT CODE, AFTER A FAILED
// BUILD. Sections 1–3 import from `../dist/` and therefore test the last
// successful build; section 4 reads `daemon/src/*.ts` as TEXT and therefore
// tests what you actually wrote. If the build failed, section 4's verdict is
// still about your change and sections 1–3's are about yesterday's.
//
// Usage: node daemon/scripts/verify-atlassian-proxy-off-is-not-broken.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { proxyReport } from '../dist/atlassian-proxy.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 10).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

const OFF = { mode: 'off', source: 'default', rawValue: null, fallbackReason: null };
const ON = { mode: 'jira-read', source: 'environment', rawValue: 'jira-read', fallbackReason: null };

const WITH = { configured: true, siteUrl: 'https://example.invalid', email: 'a@example.invalid', storage: 'file' };
const WITHOUT = { configured: false };

// ── 1. positive control: the instrument can say both things ────────────────
//
// Sections 2 and 3 are findings of the form "these two differ". A module that
// returned a different string for every call would pass them for a reason with
// nothing to do with the credential. So first: the ON state, where the
// distinction has always worked, shown working on this same build.
rule('1. positive control — the ON-state summary already distinguishes the two worlds');

const onWith = proxyReport(ON, WITH).summary;
const onWithout = proxyReport(ON, WITHOUT).summary;

check(
  'the on-state summary differs between a configured and an unconfigured credential',
  onWith !== onWithout,
  `identical: ${onWith}`
);
check(
  'the on-state summary still carries its alarm when nothing is configured',
  /NO CONFIGURED CREDENTIAL/.test(onWithout),
  onWithout
);
check(
  'the on-state summary names the account when one is configured',
  onWith.includes('a@example.invalid'),
  onWith
);

// ── 2. the defect itself: the OFF state must answer too ────────────────────
rule('2. the OFF-state summary states the credential — the discriminating control');

const offWith = proxyReport(OFF, WITH).summary;
const offWithout = proxyReport(OFF, WITHOUT).summary;

if (verbose) {
  console.log(`\n   off + configured:true  ->\n   ${offWith}\n`);
  console.log(`   off + configured:false ->\n   ${offWithout}\n`);
}

// THE assertion. Before KAN-441 these two strings were byte-identical, and
// that identity is the whole defect: an operator checking readiness before a
// flip got the same reassuring paragraph either way.
check(
  'off + configured:true and off + configured:false are NOT the same string',
  offWith !== offWithout,
  `both read: ${offWith}`
);
check(
  'the off-state summary says a credential IS configured when one is',
  /credential IS configured/i.test(offWith),
  offWith
);
check(
  'the off-state summary says NO credential is configured when none is',
  /NO credential is configured/i.test(offWithout),
  offWithout
);
check(
  'the off-state summary still says it is OFF (the sibling scope proof relies on this)',
  /is OFF/.test(offWith) && /is OFF/.test(offWithout),
  offWith
);

// `configured` is not `working`, and the weaker claim must not imply the
// stronger. A token on this machine is not a token Atlassian still accepts.
check(
  'the off-state does not let presence read as a working credential',
  /PRESENCE and not proof it works/i.test(offWith) && /only a call establishes/i.test(offWith),
  offWith
);

// ⚠ And do not import the on-state's alarm into a state where nothing is
// wrong. While off, no call is being made, so "every call will refuse" is
// false as written — it is a claim about a flip that has not happened.
check(
  "the off-state does NOT import the on-state's alarm phrasing",
  !/every call will refuse/.test(offWith) && !/every call will refuse/.test(offWithout),
  offWithout
);
check(
  'the off-state with no credential says nothing is failing YET, and names the flip as the risk',
  /Nothing is failing while the proxy is off/i.test(offWithout) && /flip/i.test(offWithout),
  offWithout
);

// ── the world for sections 3a/3b ───────────────────────────────────────────

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan441-offstate-'));
const butchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true, mode: 0o700 });

/**
 * FABRICATED BY THIS SCRIPT, deleted with the temp directory on exit. Not a
 * token, never has been. It exists so the daemon has a credential to report on
 * and for no other reason — nothing here authenticates to anything.
 */
const FAKE_TOKEN = 'kan441-verify-not-a-real-token-0000000000';

const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({}));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${stub.address().port}`;

fs.writeFileSync(
  path.join(butchrDir, 'jira-credential.json'),
  JSON.stringify({ siteUrl, email: 'verify@example.invalid', storage: 'file', token: FAKE_TOKEN }, null, 2) + '\n',
  { mode: 0o600 }
);

let daemon = null;
let wedgedServer = null;
const mcps = [];

function cleanup() {
  for (const m of mcps) { try { m.kill('SIGKILL'); } catch {} }
  try { daemon?.kill('SIGKILL'); } catch {}
  try { wedgedServer?.close(); } catch {}
  try { stub.close(); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startDaemon(extraEnv) {
  const child = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
    env: { ...process.env, HOME: fakeHome, BUTCHR_BOARD_RECONCILE: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.on('error', () => {});
  return child;
}

/** A real `mcp.ts`, spoken to over real MCP stdio. */
function startMcpClient() {
  const child = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-441'],
    { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  mcps.push(child);
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = msg.id !== undefined ? waiting.get(msg.id) : undefined;
      if (entry) { waiting.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg); }
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => {});

  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} did not answer within 25s`)); }, 25_000);
      waiting.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
  return { child, request, notify };
}

async function connectMcp() {
  const client = startMcpClient();
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kan441-verify', version: '1.0.0' }
  });
  client.notify('notifications/initialized');
  return client;
}

function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
}

const STATUS_TOOL = 'butchr_atlassian_proxy_status';

// ── 3a. a real daemon, reachable, with the proxy off ───────────────────────
rule('3a. daemon UP and proxy OFF — an empty Atlassian menu, and a status that says why');

daemon = startDaemon({}); // BUTCHR_ATLASSIAN_PROXY deliberately unset: the default
await sleep(1800);

const offClient = await connectMcp();
const offTools = ((await offClient.request('tools/list'))?.result?.tools ?? []).map((t) => t.name).sort();
const offAtlassian = offTools.filter((n) => n.startsWith('atlassian_'));

check('with the proxy off, no atlassian_* tools are advertised', offAtlassian.length === 0, offAtlassian.join(', '));
check(`${STATUS_TOOL} IS advertised while the proxy is off`, offTools.includes(STATUS_TOOL), offTools.join(', '));

const offStatus = toolPayload(await offClient.request('tools/call', { name: STATUS_TOOL, arguments: {} }));
if (verbose) console.log(`   status while off: ${JSON.stringify(offStatus).slice(0, 300)}`);

check("a reachable daemon with the switch unset reports outcome 'off'", offStatus.outcome === 'off', JSON.stringify(offStatus).slice(0, 300));
check('the off status reports the credential it found on disk', offStatus?.report?.credential?.configured === true, JSON.stringify(offStatus?.report?.credential));
check(
  'the off status carries the daemon-answered `available` field an agent could not otherwise read',
  offStatus.available === true,
  JSON.stringify(offStatus).slice(0, 200)
);

// ── 3b. a daemon that cannot be asked ──────────────────────────────────────
//
// ⚠ KILLING THE DAEMON DOES NOT PRODUCE THIS STATE, and finding that out is
// worth more than the check it cost. `connectToDaemon` spawns a daemon when the
// socket is absent — right for a tool call, since something wants the daemon
// *now* — so an mcp.ts whose daemon has died simply starts another one and gets
// a truthful `off`. The first draft of this section killed the daemon and
// watched `outcome` come back `off` with a `readAt` two seconds newer than 3a's:
// a replacement had answered. That is the daemon-is-down case behaving CORRECTLY
// and it is not what an agent means by "my tools are missing".
//
// The state that actually reaches the `catch` is a daemon that is THERE and
// cannot answer — wedged, or slower than `PROXY_STATUS_TIMEOUT_MS`, which is the
// documented reason that timeout exists at all. So: a server that accepts the
// connection and never replies. Nothing spawns (the socket connects), and the
// 3s timeout fires.
rule('3b. daemon WEDGED — the SAME empty menu, and a status that separates it from 3a');

try { daemon.kill('SIGKILL'); } catch {}
daemon = null;
await sleep(1200);

const socketPath = path.join(butchrDir, 'butchr.sock');
try { fs.rmSync(socketPath, { force: true }); } catch {}

/** Accepts, and answers nothing. The connection succeeds; the request never does. */
const wedged = net.createServer((socket) => { socket.on('error', () => {}); /* deliberately silent */ });
await new Promise((resolve) => wedged.listen(socketPath, resolve));
wedgedServer = wedged;

const downClient = await connectMcp();
const downTools = ((await downClient.request('tools/list'))?.result?.tools ?? []).map((t) => t.name).sort();
const downAtlassian = downTools.filter((n) => n.startsWith('atlassian_'));

check('with the daemon wedged, no atlassian_* tools are advertised either', downAtlassian.length === 0, downAtlassian.join(', '));

// ⚠ THE REPRODUCTION. This is the defect, asserted as still true, because it
// is deliberate: the two menus are identical and must stay identical. If this
// check ever fails, somebody has "fixed" the diagnosability problem by
// advertising operations on failure — which is the thing the safety rationale
// forbids.
check(
  'REPRODUCTION: the off menu and the wedged-daemon menu are byte-identical',
  JSON.stringify(offTools) === JSON.stringify(downTools),
  `off:    ${offTools.join(', ')}\nwedged: ${downTools.join(', ')}`
);

const downStatus = toolPayload(await downClient.request('tools/call', { name: STATUS_TOOL, arguments: {} }));
if (verbose) console.log(`   status while wedged: ${JSON.stringify(downStatus).slice(0, 300)}`);

// ⚠ THE FIX. Same menu, different answer.
check(
  "an unreachable daemon reports outcome 'unreachable', NOT 'off'",
  downStatus.outcome === 'unreachable',
  JSON.stringify(downStatus).slice(0, 300)
);
check(
  'the unreachable answer names why, rather than being a bare failure',
  typeof downStatus.because === 'string' && downStatus.because.length > 0,
  JSON.stringify(downStatus).slice(0, 300)
);
check(
  'THE POINT: identical tool menus, different outcomes',
  JSON.stringify(offTools) === JSON.stringify(downTools) && offStatus.outcome !== downStatus.outcome,
  `off=${offStatus.outcome} down=${downStatus.outcome}`
);

// ── 4. the safety rationale is still in the source, and still true ─────────
//
// Reads `daemon/src/mcp.ts` as TEXT — so, unlike everything above, this section
// tests what you wrote rather than what was last built.
rule('4. "ON FAILURE, ADVERTISE NOTHING" is preserved, quoted, and structurally enforced');

const mcpSrc = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');

check(
  'the rationale is still quoted in mcp.ts, so nobody later "fixes" it by advertising on failure',
  /ON FAILURE, ADVERTISE NOTHING/.test(mcpSrc),
  'the comment is gone — read KAN-441 before restoring anything'
);
check(
  'both non-serving outcomes are typed to carry an EMPTY operation list',
  /outcome:\s*'off';\s*operations:\s*readonly \[\]/.test(mcpSrc) &&
    /outcome:\s*'unreachable';[\s\S]{0,80}operations:\s*readonly \[\]/.test(mcpSrc),
  'the readonly [] on the off/unreachable variants is what makes "advertise something on failure" un-writable'
);
check(
  "the status tool is advertised outside the proxied spread, so its presence says nothing about the mode",
  /ADVERTISED UNCONDITIONALLY/.test(mcpSrc) && /name: "butchr_atlassian_proxy_status"/.test(mcpSrc),
  'if it moves inside the proxied spread its absence means both "off" and "broken" again'
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — the off-state summary answers the credential question in both worlds, the off ' +
        'menu and the daemon-down menu stay byte-identical (deliberately), and ' +
        `${STATUS_TOOL} is where an agent reads which of the two it is.`
  }\n`
);
process.exit(failures ? 1 : 0);
