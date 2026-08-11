#!/usr/bin/env node
//
// KAN-284 — does a guardian poke actually leave a REAL daemon and arrive on the
// guardian's own channel connection, and does a poke at a guardian that holds no
// connection report UNDELIVERED rather than success?
//
// WHAT FAILURE THIS WOULD CATCH: the gap `verify-guardian-poke.mjs` names in its
// own header and does not cover — that `daemon.ts` wires the poker to
// `routeChannelMessage` at all. That verify script supplies its own `send` and
// asserts what the mechanism CONCLUDES from a refusal; every assertion in it
// stays green against a daemon in which the poker is constructed and never
// started, or started and wired to a stub. This is the shape KAN-145 cost this
// board a day for: two scripts each honest about what they test, with the seam
// between them owned by neither.
//
// NOT a `verify-` script, deliberately, and do not rename it — the convention is
// `probe-channel-delivery.mjs`'s. It spawns a real daemon process, writes to a
// real Unix socket and depends on process timing, so it is an experiment rather
// than a deterministic proof CI can re-run. A `verify-` name would enrol it in
// `verify-script-sweep` and assert a guarantee it cannot make.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHAT IT THEREFORE CANNOT CLAIM
// ---------------------------------------------------------------------------
// It supplies **the guardian's connection**: a plain socket that sends `hello`
// and is thereafter, as far as the daemon is concerned, `epic/KAN-PROBE`. That
// is the real registration path — `agent-connections.ts` cannot tell this from a
// Claude client's MCP server, and that is the point rather than a shortcut.
//
// WHAT IT DOES NOT PROVE, said plainly because the temptation is to read a
// received frame as a supervised fleet:
//
//   * **That a MODEL read it.** The frame arriving on a socket is legs 1–3 of
//     the channel loop. Whether a real client then dispatches it into a model's
//     context is unobservable from the server — that is `channel-liveness.ts`'s
//     whole reason for existing, and nothing here reaches it.
//   * **That the guardian then SWEPT, or swept correctly.** A heartbeat proves
//     the loop turns; it says nothing about whether its decisions are right.
//   * **That the 30-minute timer fires.** This drives `op: 'poke'`, which is the
//     same code path the timer takes (`GuardianPoker.pokeOnce`) but is not the
//     timer. `--first-poke-ms` runs the real schedule at a short interval to
//     cover that; it is off by default because it costs wall clock.
//
// ---------------------------------------------------------------------------
// IT DOES NOT TOUCH THE FLEET, AND THAT IS STRUCTURAL RATHER THAN CAREFUL
// ---------------------------------------------------------------------------
// `ipc.ts` resolves `BUTCHR_DIR` from `os.homedir()`, so a private `$HOME` gives
// a private daemon, a private socket and a private `guardian.json`. Nothing here
// connects to the fleet's socket, nothing restarts the fleet's daemon, and no
// agent's channel registration is dropped. The machine was at 4.00/4 cores with
// nine agents running when this was written, and a probe that required a deploy
// to demonstrate a poke would have cost every one of them their in-flight work.
//
// Note the caveat `lib/isolated-daemon.mjs` carries in full: a private `$HOME`
// gives a private DAEMON and not a private HERDR. This probe never activates an
// agent, so that caveat does not bite here — it takes no capacity and spawns no
// pane.
//
// USAGE
//   node daemon/scripts/probe-guardian-poke-delivery.mjs
//   node daemon/scripts/probe-guardian-poke-delivery.mjs --first-poke-ms 8000

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const daemonDir = path.join(repoRoot, 'daemon');
const daemonJs = path.join(daemonDir, 'dist', 'daemon.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const firstPokeMs = arg('--first-poke-ms', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
let checks = 0;
function check(label, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}
function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

if (!fs.existsSync(daemonJs)) {
  console.error(`No build at ${daemonJs}. Run \`npm run build\` in daemon/ first.`);
  // A SETUP GUARD, NOT A VERDICT — exit 2, so a reader can tell "this probe did
  // not run" from "this probe found something". `sweep-verify-exit-paths.mjs`
  // makes exactly that distinction and it is worth honouring here too.
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-probe-'));
const butchrDir = path.join(home, '.local', 'share', 'butchr');
fs.mkdirSync(butchrDir, { recursive: true });
// The kill switch ON, in the isolated daemon's own dir. The poke reads the same
// switch every other carrier decision reads, so without this every poke would
// honestly report `channel-disabled` and nothing would be demonstrated.
fs.writeFileSync(path.join(butchrDir, 'channel.json'), JSON.stringify({ enabled: true }));

const logPath = path.join(butchrDir, 'daemon.log');
let daemon;
let cleanedUp = false;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { daemon?.kill('SIGTERM'); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log(`Isolated HOME: ${home}`);
console.log(`Daemon log:    ${logPath}\n`);

daemon = spawn('node', [daemonJs], {
  env: {
    ...process.env,
    HOME: home,
    // The board reconciler off: it would read Jira with a credential this
    // isolated home does not have, and its noise is not what is being measured.
    BUTCHR_BOARD_RECONCILE: 'off',
    ...(firstPokeMs ? { BUTCHR_GUARDIAN_FIRST_POKE_MS: String(firstPokeMs) } : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const daemonOut = [];
daemon.stdout.on('data', (b) => daemonOut.push(b.toString()));
daemon.stderr.on('data', (b) => daemonOut.push(b.toString()));

const socketPath = path.join(butchrDir, 'butchr.sock');
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  await sleep(250);
  up = fs.existsSync(socketPath);
}
if (!up) {
  console.error('The isolated daemon never created its socket. Output:\n' + daemonOut.join(''));
  process.exit(2);
}

/** An RPC connection that also keeps every unsolicited frame it is sent. */
async function connect(label) {
  const sock = net.connect(socketPath);
  sock.on('error', () => {});
  await new Promise((r) => sock.once('connect', r));
  const pending = new Map();
  const frames = [];
  let buf = '';
  let nextId = 0;
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = msg?.id !== undefined ? pending.get(msg.id) : undefined;
      if (resolve) { pending.delete(msg.id); resolve(msg); }
      // EVERYTHING ELSE IS KEPT. The poke is not a reply to anything this
      // connection asked for — it is an addressed frame the daemon writes
      // unsolicited, which is the whole thing being measured.
      else frames.push(msg);
    }
  });
  const call = (action, data = {}) => new Promise((resolve) => {
    const id = `${label}-${++nextId}`;
    pending.set(id, resolve);
    sock.write(JSON.stringify({ action, ...data, id }) + '\n');
    setTimeout(() => { if (pending.delete(id)) resolve({ timedOut: true }); }, 20_000);
  });
  return { call, frames, close: () => { try { sock.destroy(); } catch {} } };
}

const control = await connect('control');

// ---------------------------------------------------------------------------
section('§1 A poke with NO guardian set says so, and pokes nobody');
// ---------------------------------------------------------------------------

const noneYet = await control.call('guardian', { op: 'get' });
check(
  'a fresh daemon reports no guardian configured',
  noneYet?.state?.configured === false,
  `configured=${noneYet?.state?.configured}`
);
check(
  'and says plainly that nothing is watching the fleet',
  /NO GUARDIAN IS SET/.test(noneYet?.state?.detail ?? ''),
  (noneYet?.state?.detail ?? '').slice(0, 60) + '…'
);

const pokeNobody = await control.call('guardian', { op: 'poke' });
check(
  'poking with no guardian is not reported as a success',
  pokeNobody?.success === false,
  `success=${pokeNobody?.success}, outcome=${pokeNobody?.result?.outcome}`
);

// ---------------------------------------------------------------------------
section('§2 A poke to a guardian with NO channel connection reports UNDELIVERED (AC2)');
// ---------------------------------------------------------------------------
// The mirror image of §3, and it is run FIRST on purpose: the guardian is set to
// an address that holds no connection, so this is the real refusal path rather
// than a simulated one.

// AGENTS BEFORE, AND THE COUNT IS NOT ZERO — see `lib/isolated-daemon.mjs`'s
// caveat, which bites here: a private `$HOME` gives a private DAEMON and NOT a
// private HERDR, so this daemon enumerates the REAL fleet's panes. The first
// draft of this probe asserted `length === 0` and went red against nine live
// agents, which was the check being wrong rather than the product.
//
// The honest measurement is therefore not "no agents exist" but "setting a
// guardian CHANGED nothing" — which is the claim actually being made, and is
// the stronger of the two anyway: it holds on a busy machine as well as an idle
// one.
const agentsBefore = (await control.call('list_agents'))?.agents?.length ?? -1;

const setAbsent = await control.call('guardian', {
  op: 'set',
  type: 'epic',
  key: 'KAN-NOT-RUNNING'
});
check('the guardian can be set to an agent that is not running', setAbsent?.success === true,
  setAbsent?.detail ?? setAbsent?.error ?? '');

const agentsAfter = (await control.call('list_agents'))?.agents?.length ?? -2;
check(
  'setting it started nothing — the fleet is exactly as it was',
  agentsBefore >= 0 && agentsAfter === agentsBefore,
  `${agentsBefore} agent(s) before, ${agentsAfter} after — a guardian the system spawns to ` +
    `receive its own pokes proves nothing`
);
check(
  'and the agent it names is NOT among them',
  !((await control.call('list_agents'))?.agents ?? []).some(
    (a) => `${a?.type}/${a?.key}`.toLowerCase() === 'epic/kan-not-running'
  ),
  'the pointer names an agent that does not exist, and that is allowed'
);

const pokeAbsent = await control.call('guardian', { op: 'poke' });
console.log('\n  poke at an agent that is not running:');
console.log('  ' + JSON.stringify({
  success: pokeAbsent?.success,
  outcome: pokeAbsent?.result?.outcome,
  transport: pokeAbsent?.result?.transport,
  interrupted: pokeAbsent?.result?.interrupted,
  reason: pokeAbsent?.result?.reason
}, null, 2).replace(/\n/g, '\n  '));

check('`success` is false', pokeAbsent?.success === false, `success=${pokeAbsent?.success}`);
check(
  "`transport` is 'undelivered'",
  pokeAbsent?.result?.transport === 'undelivered',
  `transport=${pokeAbsent?.result?.transport}`
);
check(
  '`interrupted` is false — nothing was Ctrl+C\'d to deliver it',
  pokeAbsent?.result?.interrupted === false,
  `interrupted=${pokeAbsent?.result?.interrupted}`
);
check(
  'an error naming the condition came back',
  typeof pokeAbsent?.error === 'string' && pokeAbsent.error.length > 0,
  (pokeAbsent?.error ?? '').slice(0, 70) + '…'
);
check(
  'and the state now says the guardian is not being reached',
  pokeAbsent?.state?.consecutiveUndelivered >= 1,
  `consecutiveUndelivered=${pokeAbsent?.state?.consecutiveUndelivered}`
);

// ---------------------------------------------------------------------------
section('§3 A REAL poke reaches the guardian\'s own connection (AC1)');
// ---------------------------------------------------------------------------

const guardian = await connect('guardian');
const hello = await guardian.call('hello', {
  workspaceType: 'epic',
  workspaceKey: 'KAN-PROBE'
});
check(
  'the guardian connection identifies itself',
  hello?.identified === true,
  `connectionId=${hello?.connectionId}`
);

const setPresent = await control.call('guardian', {
  op: 'set',
  type: 'epic',
  key: 'KAN-PROBE',
  // The incumbent from §2 is a DIFFERENT agent, so this is refused without an
  // explicit replace — which is AC4 arriving here as an ordinary consequence
  // rather than as a test.
  replace: true
});
check('the guardian was changed with an explicit replace', setPresent?.success === true,
  setPresent?.detail ?? setPresent?.error ?? '');

const before = guardian.frames.length;
const pokePresent = await control.call('guardian', { op: 'poke' });

console.log('\n  poke at a guardian holding a live channel connection:');
console.log('  ' + JSON.stringify({
  success: pokePresent?.success,
  outcome: pokePresent?.result?.outcome,
  transport: pokePresent?.result?.transport,
  interrupted: pokePresent?.result?.interrupted,
  connectionId: pokePresent?.result?.connectionId
}, null, 2).replace(/\n/g, '\n  '));

check('`success` is true', pokePresent?.success === true, `success=${pokePresent?.success}`);
check(
  "`transport` is 'channel'",
  pokePresent?.result?.transport === 'channel',
  `transport=${pokePresent?.result?.transport}`
);
check(
  '`interrupted` is false',
  pokePresent?.result?.interrupted === false,
  `interrupted=${pokePresent?.result?.interrupted}`
);
check(
  'it names the real connection it was written to',
  pokePresent?.result?.connectionId === hello?.connectionId,
  `${pokePresent?.result?.connectionId} === ${hello?.connectionId}`
);

// THE MEASUREMENT. Everything above is the daemon's own account of what it did;
// this is the guardian's side of the socket, which is a different claim.
await sleep(500);
const arrived = guardian.frames.slice(before);
const pokeFrame = arrived.find((f) =>
  typeof f?.content === 'string' && /guardian sweep poke/.test(f.content)
);

check(
  'a frame ARRIVED on the guardian\'s connection',
  pokeFrame !== undefined,
  pokeFrame ? `action=${pokeFrame.action}` : `${arrived.length} frame(s), none matching`
);
if (pokeFrame) {
  check(
    'it is tagged as the daemon rather than as an agent',
    pokeFrame.content.startsWith('[butchr daemon]'),
    pokeFrame.content.slice(0, 40) + '…'
  );
  check(
    'it says the role is additional to the recipient\'s own work',
    /ADDITIONAL TO YOUR OWN WORK/.test(pokeFrame.content),
    'the guardian is a pointer at an agent that already has a ticket'
  );
  check(
    'it points at the recipient\'s own brief rather than vouching for itself',
    /your own brief/.test(pokeFrame.content),
    'KAN-217: a probe that vouches for itself is one a model is right to refuse'
  );
  console.log('\n  the frame the guardian actually received:');
  console.log('  ' + pokeFrame.content.replace(/(.{92})\s/g, '$1\n  '));
}

check(
  'nothing was written to any OTHER connection',
  control.frames.filter((f) => /guardian sweep poke/.test(f?.content ?? '')).length === 0,
  'a broadcast wearing routing\'s clothes would look identical from the recipient'
);

// ---------------------------------------------------------------------------
section('§4 Exactly one guardian, refused against a live daemon (AC4)');
// ---------------------------------------------------------------------------

const second = await control.call('guardian', { op: 'set', type: 'epic', key: 'KAN-39' });
check('a second, different guardian is refused', second?.success === false, `success=${second?.success}`);
check(
  'the refusal names the incumbent',
  typeof second?.error === 'string' && second.error.includes('epic/KAN-PROBE'),
  (second?.error ?? '').slice(0, 70) + '…'
);
check(
  'and nothing was written — the guardian is unchanged',
  second?.state?.address?.key === 'KAN-PROBE',
  `guardian=${second?.state?.address?.type}/${second?.state?.address?.key}`
);

// ---------------------------------------------------------------------------
if (firstPokeMs) {
  section('§5 The TIMER fires on its own, with nobody asking');
  // -------------------------------------------------------------------------
  // Off by default because it costs wall clock. This is the only section that
  // exercises the schedule rather than `op: 'poke'`, and it is what closes the
  // "does the timer ever fire" hole the header names.
  const wait = Number(firstPokeMs) + 6000;
  console.log(`  waiting ${Math.round(wait / 1000)}s for the scheduled poke…`);
  const beforeTimer = guardian.frames.length;
  await sleep(wait);
  const timerFrames = guardian.frames
    .slice(beforeTimer)
    .filter((f) => /guardian sweep poke/.test(f?.content ?? ''));
  check(
    'a poke arrived without anybody calling `op: poke`',
    timerFrames.length >= 1,
    `${timerFrames.length} scheduled poke(s)`
  );
}

// ---------------------------------------------------------------------------
guardian.close();
control.close();

console.log('\n' + '='.repeat(78));
if (failures.length) {
  console.log(`FAILED (${failures.length} of ${checks}):`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log(`All ${checks} checks passed.`);
  console.log('');
  console.log('WHAT THIS DOES AND DOES NOT LICENSE: a frame left a real daemon and arrived on');
  console.log('the guardian\'s own connection, addressed rather than broadcast. It does NOT');
  console.log('establish that a model read it, that the guardian swept, or that the sweep was');
  console.log('right. A heartbeat proves the loop turns.');
}
console.log('='.repeat(78));

cleanup();
process.exit(failures.length ? 1 : 0);
