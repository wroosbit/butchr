// Live proof for KAN-278: the CrabCast-backed runtime exists, is selected by a
// switch that is OFF by default, and refuses with figures when its peer is not
// there.
//
// WHAT FAILURE THIS WOULD CATCH: a migration that changes behaviour on merge —
// the daemon quietly connecting to CrabCast, or serving agents from it, on a
// machine where nobody set the switch. That is KAN-278's criterion 3 and it is
// the failure this whole ticket is shaped to avoid. It would also catch the
// three ways the switch could rot into a lie: an unrecognised value falling
// *toward* CrabCast instead of away from it, a report that names a different
// runtime from the one actually serving, and a refusal that says "could not
// connect" without the figures or the leg that refused.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── THE POSITIVE CONTROL, AND WHY THIS SCRIPT IS BUILT AROUND ONE ───────────
//
// "No connection was attempted" is an assertion about an absence, and an
// absence is exactly what a broken instrument also reports. If the socket
// listener below were misconfigured, or the runtime never constructed, section
// 1 would pass for a reason that has nothing to do with the switch — the
// KAN-145 defect in this ticket's costume.
//
// So every absence here is measured on an instrument that is shown to work in
// the same run, against the same listener, in the section immediately after:
// section 1 asserts zero connections with the switch unset, and section 2
// asserts a connection lands with the switch set to `crabcast`. Section 2 is
// not a second test. It is what licenses section 1.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// This script stands up its **own** unix socket and speaks enough of CrabCast's
// protocol to answer a handshake. So it proves the adapter connects, refuses,
// and reports honestly — and it proves NOTHING about whether a real CrabCast
// daemon behaves the way this fake one does. That gap is deliberate and it is
// owned by name:
//
//   - `daemon/scripts/verify-crabcast-runtime-live.mjs` drives a REAL CrabCast
//     daemon and a REAL herdr, spawns a real agent through the runtime, and
//     reads its pty. It is the one that can fail if CrabCast changes; this one
//     cannot. It is not CI-safe and its output goes on the pull request.
//   - Whether the *daemon* wires this switch at all — as opposed to
//     `createAgentRuntime` returning the right object — is covered by section 4
//     here (it reads `daemon.ts`'s single construction site) and by
//     `verify-agent-runtime-seam.mjs`, which proves the seam that site depends
//     on is real.
//
// Neither script covers a cutover, because there is no cutover: KAN-278 lands
// this inert and nothing is migrated onto it.
//
// Usage: node daemon/scripts/verify-crabcast-runtime-switch.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAgentRuntime, selectedRuntimeMode } from '../dist/runtime-switch.js';
import { CrabCastLink, CRABCAST_PIN } from '../dist/crabcast-link.js';
import { CrabCastRuntime } from '../dist/crabcast-runtime.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the instrument ─────────────────────────────────────────────────────────
//
// A unix socket that counts connections and answers `daemon_status` and
// `list_agents`, which is everything the adapter asks unprompted. Keeping it
// this thin is deliberate: a richer fake would start to encode beliefs about
// CrabCast that only the live script is entitled to hold.

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kan278-switch-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

const watchedSocket = path.join(work, 'crabcast.sock');
let connectionCount = 0;

const server = net.createServer((socket) => {
  connectionCount++;
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (req.action === 'daemon_status') {
        socket.write(
          JSON.stringify({
            action: 'daemon_status_response',
            success: true,
            id: req.id,
            build: { commit: CRABCAST_PIN }
          }) + '\n'
        );
      } else if (req.action === 'list_agents') {
        socket.write(
          JSON.stringify({
            action: 'list_agents_response',
            success: true,
            id: req.id,
            agents: [],
            foreignPanes: []
          }) + '\n'
        );
      }
    }
  });
  socket.on('error', () => {});
});

await new Promise((resolve) => server.listen(watchedSocket, resolve));

/** Run a body with a scrubbed environment, restoring whatever was there. */
async function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const quiet = () => {};

// ── 1. default off ─────────────────────────────────────────────────────────
rule('1. default off — with no switch set, HerdrBridge serves and CrabCast is untouched');

const before = connectionCount;
const plain = await withEnv(
  { BUTCHR_AGENT_RUNTIME: undefined, BUTCHR_CRABCAST_SOCKET: watchedSocket },
  async () => {
    const built = createAgentRuntime({ log: quiet });
    // Generous: any connection the adapter would open happens on construction,
    // and this is far longer than that takes.
    await sleep(600);
    return built;
  }
);

check(
  'the runtime is HerdrBridge',
  plain.runtime.constructor.name === 'HerdrBridge',
  `got ${plain.runtime.constructor.name}`
);
check('the report says mode=herdr', plain.report.mode === 'herdr', JSON.stringify(plain.report));
check(
  "the report's source is 'default', not an environment reading",
  plain.report.source === 'default',
  JSON.stringify(plain.report)
);
check(
  'the report carries no crabcast block at all',
  plain.report.crabcast === undefined,
  JSON.stringify(plain.report.crabcast)
);
check(
  'NO connection reached the CrabCast socket',
  connectionCount === before,
  `${connectionCount - before} connection(s) arrived; the switch leaks`
);

// ── 2. the positive control ────────────────────────────────────────────────
rule('2. positive control — the same listener DOES see the switch when it is on');

const beforeOn = connectionCount;
const on = await withEnv(
  { BUTCHR_AGENT_RUNTIME: 'crabcast', BUTCHR_CRABCAST_SOCKET: watchedSocket },
  async () => {
    const built = createAgentRuntime({ log: quiet });
    await sleep(600);
    return built;
  }
);

check(
  'the runtime is CrabCastRuntime',
  on.runtime.constructor.name === 'CrabCastRuntime',
  `got ${on.runtime.constructor.name}`
);
check('the report says mode=crabcast', on.report.mode === 'crabcast', JSON.stringify(on.report));
check(
  'a connection DID reach the socket — so section 1 measured a real absence',
  connectionCount > beforeOn,
  'no connection arrived even with the switch on: this instrument proves nothing, and ' +
    'section 1 above is worthless rather than reassuring'
);
check(
  'the adapter read the peer build and matched it against the pin',
  on.runtime.describe().link.peerCommit === CRABCAST_PIN &&
    on.runtime.describe().link.peerMatchesPin === true,
  JSON.stringify(on.runtime.describe().link)
);
on.runtime.dispose();

// ── 3. an unreadable value falls AWAY from CrabCast ────────────────────────
rule('3. a misspelled switch falls back to herdr, and says so');

const beforeTypo = connectionCount;
const typo = await withEnv(
  { BUTCHR_AGENT_RUNTIME: 'crabcst', BUTCHR_CRABCAST_SOCKET: watchedSocket },
  async () => {
    const built = createAgentRuntime({ log: quiet });
    await sleep(400);
    return built;
  }
);
check(
  'a misspelling serves HerdrBridge',
  typo.runtime.constructor.name === 'HerdrBridge',
  `got ${typo.runtime.constructor.name}`
);
check(
  'and the report carries the reason rather than hiding it',
  typeof typo.report.fallbackReason === 'string' && typo.report.fallbackReason.includes('crabcst'),
  JSON.stringify(typo.report.fallbackReason)
);
check(
  'and no connection was opened on the strength of a typo',
  connectionCount === beforeTypo,
  `${connectionCount - beforeTypo} connection(s) arrived`
);

// Truthiness is the tempting bug: `if (process.env.X)` would select CrabCast
// for every one of these.
for (const value of ['1', 'true', 'yes', 'on', 'CrabCast!', ' ']) {
  const decision = selectedRuntimeMode({ BUTCHR_AGENT_RUNTIME: value });
  check(
    `BUTCHR_AGENT_RUNTIME=${JSON.stringify(value)} does not select CrabCast`,
    decision.mode === 'herdr',
    JSON.stringify(decision)
  );
}
// ...and the one spelling that must work, including case and padding.
for (const value of ['crabcast', 'CrabCast', '  crabcast  ']) {
  const decision = selectedRuntimeMode({ BUTCHR_AGENT_RUNTIME: value });
  check(
    `BUTCHR_AGENT_RUNTIME=${JSON.stringify(value)} selects CrabCast`,
    decision.mode === 'crabcast',
    JSON.stringify(decision)
  );
}

// ── 4. the report cannot describe a runtime other than the one serving ─────
rule('4. the report is derived from the selection, not from a second read');

check(
  'report.implementation is the serving object\'s own class name (herdr)',
  plain.report.implementation === plain.runtime.constructor.name,
  `${plain.report.implementation} vs ${plain.runtime.constructor.name}`
);
check(
  'report.implementation is the serving object\'s own class name (crabcast)',
  on.report.implementation === on.runtime.constructor.name,
  `${on.report.implementation} vs ${on.runtime.constructor.name}`
);

// The wiring site itself: one construction, and the report comes out of it.
const daemonSrc = fs.readFileSync(path.join(daemonDir, 'src', 'daemon.ts'), 'utf8');
check(
  'daemon.ts takes both the runtime and its report from ONE createAgentRuntime call',
  /const \{ runtime: herdrBridge, report: agentRuntimeReport \} = createAgentRuntime\(/.test(
    daemonSrc
  ),
  'daemon.ts no longer destructures both from one call, so the two could disagree'
);
check(
  'daemon.ts constructs no runtime of its own',
  !/=\s*new HerdrBridge\(\)/.test(daemonSrc) && !/new CrabCastRuntime\(/.test(daemonSrc),
  'a second construction site defeats the switch'
);

// ── 5. the refusal, when CrabCast is not there ─────────────────────────────
rule('5. refusal — a runtime whose peer is absent says so, with figures and a leg');

const deadSocket = path.join(work, 'nothing-here.sock');
const deadLink = new CrabCastLink({ socketPath: deadSocket, log: quiet, reconnectDelayMs: 50 });
const deadRuntime = new CrabCastRuntime({ link: deadLink, log: quiet, censusIntervalMs: 10_000 });
await sleep(400);

const tail = deadRuntime.tailAgent('kan-1', 'task');
check('tailAgent refuses rather than reporting an empty pane', tail.success === false, JSON.stringify(tail));
check(
  'it does NOT return text — success:false is a claim about the READ',
  tail.text === undefined,
  JSON.stringify(tail)
);

const refusal = String(tail.error ?? '');
if (verbose) console.log(`\n   refusal text:\n   ${refusal}\n`);
check('the refusal names the leg that refused it', /refused by [a-z-]+:/.test(refusal), refusal);
check('the refusal names the socket it tried', refusal.includes(deadSocket), refusal);
check('the refusal reports how long it has been down', /over [\d.]+s/.test(refusal), refusal);
check('the refusal reports the attempt count', /\d+ connection attempt\(s\)/.test(refusal), refusal);
check(
  'the refusal says this link has never connected rather than implying it once did',
  refusal.includes('never'),
  refusal
);
// A remedy, not a specific one. `tailAgent`'s refusal names a better remedy
// than the link's generic "start a daemon" — make the signature async, and use
// the default runtime meanwhile — and pinning this assertion to the generic
// wording would have punished the more useful message.
check(
  'the refusal tells the operator what to do about it',
  /herdr runtime/.test(refusal) && /Make tailAgent async|Start a CrabCast daemon/.test(refusal),
  refusal
);

check(
  'herdrReachable() is false — could-not-ask is never reported as nothing-there',
  deadRuntime.herdrReachable() === false
);
const checked = deadRuntime.listHerdrAgentsChecked();
check(
  'listHerdrAgentsChecked reports reachable:false rather than an empty fleet',
  checked.reachable === false && checked.agents.length === 0,
  JSON.stringify(checked)
);

const reset = deadRuntime.resetWorkspace('task', 'kan-1');
check(
  'resetWorkspace refuses and explains that CrabCast removed reset by design',
  reset.success === false && /reset` was removed|no CrabCast counterpart/.test(String(reset.error)),
  JSON.stringify(reset)
);

let pressThrew = false;
try {
  deadRuntime.pressPaneKey('kan-1', 'task', 'enter');
} catch (err) {
  pressThrew = /no CrabCast counterpart|press_pane_key/.test(String(err.message));
}
check('pressPaneKey throws and names what is missing', pressThrew);

deadRuntime.dispose();

// ── verdict ────────────────────────────────────────────────────────────────
server.close();
plain.runtime.setSessionEndedListener?.(() => {});

console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — the switch is off by default, the instrument that says so was shown to work, ' +
        'and the runtime refuses with figures when its peer is absent'
  }\n`
);
process.exit(failures ? 1 : 0);
