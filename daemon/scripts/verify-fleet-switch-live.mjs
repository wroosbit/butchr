// The live half of KAN-38's proof: a real daemon, a real herdr, and
// `herdr agent list` as the ground truth for whether an agent is running.
//
// verify-agent-power-controls.mjs proves the decisions — the confirmation, the
// candidate list, the refusal, the ordering — against a stubbed herdr, which is
// what makes it fast and deterministic. It cannot prove that a pane actually
// closed. This can, and does it the way the acceptance criteria ask: the
// evidence is what `herdr agent list` says before and after, not what the page
// renders about itself.
//
// WHAT IT TOUCHES
//
// One probe agent, `task/KAN38-PROBE`, and nothing else. Every request it makes
// names that key; `closeAgentByKey` resolves by exact `-kan38-probe` suffix, so
// no agent already on this machine can be reached by anything here. The daemon
// runs under a temporary $HOME, so its socket, its log and — crucially — its
// copy of KAN-21's registry are its own, and the live install's
// ~/.local/share/butchr/agents.jsonl is never written to.
//
// herdr is deliberately NOT isolated: its server is per-machine rather than
// per-$HOME, which is exactly what makes this a live proof. The probe really
// does occupy a real pane for the fifteen seconds or so this takes, and it is
// closed on every exit path including a crash.
//
// The probe launches `shell`, not `claude`: this is proving that panes open and
// close on command, and starting a real language model to demonstrate that
// would cost money to prove nothing extra.
//
// Usage: node daemon/scripts/verify-fleet-switch-live.mjs
// Run it after `npm run build` in daemon/, on a machine with herdr running.

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

const PROBE_TYPE = 'task';
const PROBE_KEY = 'KAN38-PROBE';
const PROBE_AGENT = `butchr-${PROBE_TYPE}-${PROBE_KEY.toLowerCase()}`;

if (!existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(process.env.HOME, 'code', 'wroosbit', 'butchr', 'daemon', 'node_modules')
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'node-pty', 'build', 'Release', 'pty.node'))) return dir;
  }
  console.error('No daemon/node_modules with a compiled node-pty found. Run `npm install` in daemon/.');
  process.exit(1);
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

/**
 * Ground truth. Not the daemon's `list_agents`, which is the thing under test —
 * this is herdr's own census, read with the same command a human would type.
 */
function herdrAgents() {
  try {
    const out = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return (JSON.parse(out)?.result?.agents ?? []).map((a) => a.name);
  } catch (e) {
    console.error(`herdr agent list failed: ${e?.message ?? e}`);
    return null;
  }
}

const probeRunning = () => (herdrAgents() ?? []).includes(PROBE_AGENT);

/** Wait for herdr to agree, or give up. Panes do not open or close instantly. */
async function waitForProbe(present, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeRunning() === present) return true;
    await sleep(500);
  }
  return false;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan38-live-'));
const fakeHome = path.join(scratch, 'home');
mkdirSync(fakeHome, { recursive: true });
// The daemon is run in place from daemon/dist, so it resolves node-pty out of
// daemon/node_modules as it normally would; this only fails early and clearly
// when that tree has no compiled binding.
resolveNodeModules();

let daemon;
let cleanedUp = false;

/**
 * Close the probe's pane whatever happened. Registered on exit and on the
 * signals a Ctrl-C produces, because the one outcome this script must not have
 * is leaving an orphan pane on a machine whose capacity is rationed.
 */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if ((herdrAgents() ?? []).includes(PROBE_AGENT)) {
      execFileSync('herdr', ['agent', 'close', PROBE_AGENT], { stdio: 'ignore', timeout: 15000 });
    }
  } catch {}
  daemon?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(1); });

// --------------------------------------------------------------- the daemon --

const socketPath = path.join(fakeHome, '.local', 'share', 'butchr', 'butchr.sock');
const registryPath = path.join(fakeHome, '.local', 'share', 'butchr', 'agents.jsonl');

console.log(`starting a real daemon from ${daemonDir}/dist with HOME=${fakeHome}`);
console.log(`(its registry: ${registryPath} — the live install's is untouched)`);
daemon = spawn(process.execPath, [path.join(daemonDir, 'dist', 'daemon.js')], {
  env: { ...process.env, HOME: fakeHome },
  stdio: ['ignore', 'ignore', 'inherit']
});

for (let i = 0; i < 60 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

const socket = net.connect(socketPath);
await new Promise((resolve) => socket.once('connect', resolve));

let buffer = '';
const pending = new Map();
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
let nextId = 0;
const call = (action, data = {}) =>
  new Promise((resolve) => {
    const id = `kan38-${++nextId}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

// ------------------------------------------------------------- 1. baseline --
rule('1. BASELINE — what herdr says is running before anything happens');

const baseline = herdrAgents();
if (baseline === null) {
  console.error('herdr is not answering; this script cannot prove anything without it.');
  process.exit(1);
}
console.log(`herdr agent list → ${baseline.length} agents:`);
for (const name of baseline) console.log(`  ${name}`);
console.log(`\n  probe present: ${baseline.includes(PROBE_AGENT)}`);

// ------------------------------------------------------------- 2. refusal ---
rule('2. REFUSAL — the machine as it actually is, answering a real request');

// The page's On button, exactly: activate_by_key with no override. Whether this
// is refused depends on what this machine is carrying right now, which is the
// point — it is the real capacity model answering about the real fleet.
const firstTry = await call('activate_by_key', {
  type: PROBE_TYPE,
  key: PROBE_KEY,
  defaultAgent: 'shell'
});

console.log(`{ action: 'activate_by_key', type: '${PROBE_TYPE}', key: '${PROBE_KEY}' } →\n`);
if (firstTry.success === false && firstTry.refusedBy === 'capacity') {
  console.log(JSON.stringify({
    success: firstTry.success,
    refusedBy: firstTry.refusedBy,
    reason: firstTry.reason,
    capacity: {
      cap: firstTry.capacity.cap,
      running: firstTry.capacity.running,
      supervisors: firstTry.capacity.supervisors,
      headroom: firstTry.capacity.headroom,
      load1: firstTry.capacity.load1,
      cores: firstTry.capacity.cores
    },
    preemption: firstTry.preemption ?? null
  }, null, 2));
  console.log('\nwhat the Agents page renders under the row that was pressed:\n');
  // The same headline rule ActivationRefusal.jsx applies (KAN-60): the
  // binding constraint leads; "at capacity" is said only when the count bound.
  const headline =
    firstTry.capacity.headroomBoundBy === 'load'
      ? 'Load is too high'
      : firstTry.capacity.headroomBoundBy === 'memory'
        ? 'Not enough memory'
        : 'This machine is at capacity';
  console.log(`  ⚠️  Can't start this agent`);
  console.log(`  ${headline} — ${firstTry.reason}.`);
  console.log(`  ${firstTry.capacity.running} of ${firstTry.capacity.cap} task agents · room for ${firstTry.capacity.headroom} · load ${firstTry.capacity.load1} / ${firstTry.capacity.cores} cores`);
  if (firstTry.preemption) {
    console.log(`  ┃ Starting ${PROBE_TYPE}/${PROBE_KEY} can free a slot by standing down`);
    console.log(`  ┃ ${firstTry.preemption.type}/${firstTry.preemption.key} (priority ${firstTry.preemption.priority}), currently ${firstTry.preemption.herdrStatus}.`);
    console.log(`  [ Stand down ${firstTry.preemption.type}/${firstTry.preemption.key} and start ]  [ Start anyway ]  [ Dismiss ]`);
  } else {
    console.log(`  [ Start anyway ]  [ Dismiss ]`);
  }
  console.log(`\n  and nothing started: probe in herdr agent list = ${probeRunning()}`);
  verdict(
    !probeRunning(),
    'a live refusal, with the real numbers, and no pane opened. This is the control\n' +
    '    KAN-36 was filed about, on the second surface, saying why rather than nothing.',
    'the activation was refused and something started anyway.'
  );
} else {
  console.log(JSON.stringify({ success: firstTry.success, sessionId: firstTry.sessionId }, null, 2));
  console.log(
    '\n  This machine had headroom, so there was nothing to refuse and the probe simply\n' +
    '  started. The refusal path is proved deterministically in section 6 of\n' +
    '  verify-agent-power-controls.mjs, which fills the cap to whatever this machine\n' +
    '  derives before asking. Re-run this script while the board is full to see the\n' +
    '  live refusal here.'
  );
  verdict(firstTry.success === true, 'the machine had room and said so.', 'the activation failed for a reason other than capacity.');
}

// ------------------------------------------------------------------ 3. on ---
rule('3. ON — a pane that was not there, and then is');

if (!probeRunning()) {
  // Past the cap, deliberately, and recorded as such by the daemon. This is the
  // refusal's own [Start anyway], which is the button the page offers next to
  // the sentence above — pressed here so the rest of the proof has an agent to
  // switch off.
  const started = await call('activate_by_key', {
    type: PROBE_TYPE,
    key: PROBE_KEY,
    defaultAgent: 'shell',
    override: true
  });
  console.log(`[Start anyway] → activate_by_key with override: true → success: ${started.success}`);
  if (started.capacityOverride) {
    console.log(`  recorded: over capacity at ${started.capacityOverride.at}`);
  }
  if (!started.success) {
    console.error(`could not start the probe: ${started.error}`);
    process.exit(1);
  }
}

const appeared = await waitForProbe(true);
const withProbe = herdrAgents() ?? [];
console.log(`\nherdr agent list → ${withProbe.length} agents`);
console.log(`  ${PROBE_AGENT}   ← the one that was not there in section 1`);

const listedOn = await call('list_agents');
const rowOn = listedOn.agents.find((a) => a.agentName === PROBE_AGENT);
console.log(`\nand on the Agents page's own poll:\n`);
console.log(`  ${JSON.stringify({ agentName: rowOn?.agentName, type: rowOn?.type, key: rowOn?.key, supervisor: rowOn?.supervisor, herdrStatus: rowOn?.herdrStatus })}`);

verdict(
  appeared && Boolean(rowOn) && !baseline.includes(PROBE_AGENT),
  'the agent is running, and herdr says so — not just the page that started it.',
  `the probe never appeared in herdr agent list (page row: ${Boolean(rowOn)})`
);

// ----------------------------------------------------------------- 4. off ---
rule('4. OFF — the message the page sends, and the pane gone');

console.log('the human presses Off, confirms, and the page sends:\n');
console.log(`  { type: 'DEACTIVATE_BUTCHR_BY_KEY', workspaceType: '${PROBE_TYPE}', key: '${PROBE_KEY}' }`);
console.log(`      → daemon action 'deactivate_by_key'\n`);

// What the confirmation showed first — the real probe, from the real daemon.
const work = await call('agent_work_state', { type: PROBE_TYPE, key: PROBE_KEY });
console.log(`what it showed before that, from { action: 'agent_work_state' }:`);
console.log(`  checked: ${work.checked}   hasUnsavedWork: ${work.hasUnsavedWork}`);
console.log(`  "${work.summary}"\n`);

const off = await call('deactivate_by_key', { type: PROBE_TYPE, key: PROBE_KEY });
console.log(`response: ${JSON.stringify({ success: off.success, type: off.type, key: off.key })}`);

const vanished = await waitForProbe(false);
const afterOff = herdrAgents() ?? [];
console.log(`\nherdr agent list → ${afterOff.length} agents`);
console.log(`  ${PROBE_AGENT} present: ${afterOff.includes(PROBE_AGENT)}`);
console.log(`  everything else that was running in section 1 still running: ${baseline.every((n) => afterOff.includes(n))}`);

verdict(
  off.success === true && vanished && baseline.every((n) => afterOff.includes(n)),
  'the pane is gone from herdr\'s own census — the ground truth, not the page\'s\n' +
  '    rendering of itself — and nothing else was touched.',
  `the probe did not go away (success=${off.success}, gone=${vanished})`
);

// ------------------------------------------------------------- 5. the way back --
rule('5. THE WAY BACK — off is reversible from the page that offered it');

const listedOff = await call('list_agents');
const standby = listedOff.standbyAgents.find((a) => a.agentName === PROBE_AGENT);
console.log('the next poll of list_agents, which the page makes every 2s:\n');
console.log(JSON.stringify({ standbyAgents: listedOff.standbyAgents, standbyTotal: listedOff.standbyTotal }, null, 2));
console.log('\nthe registry line behind it, on disk, fsynced before the response went out:\n');
const lastLine = readFileSync(registryPath, 'utf8').trim().split('\n').pop();
console.log(`  ${lastLine}`);

console.log('\nthe page sends, from that row:\n');
console.log(`  { type: 'ACTIVATE_BUTCHR_BY_KEY', workspaceType: '${standby?.type}', key: '${standby?.key}',`);
console.log(`    defaultAgent: '${standby?.defaultAgent}' }\n`);

const backOn = await call('activate_by_key', {
  type: standby?.type ?? PROBE_TYPE,
  key: standby?.key ?? PROBE_KEY,
  defaultAgent: standby?.defaultAgent ?? 'shell',
  // Same override as section 3, and for the same reason: this machine is busy
  // and the point being proved here is the round trip, not the gate.
  override: true
});
const returned = await waitForProbe(true);
const afterOn = herdrAgents() ?? [];
console.log(`activate_by_key → success: ${backOn.success}`);
console.log(`herdr agent list → ${PROBE_AGENT} present: ${afterOn.includes(PROBE_AGENT)}`);

const listedBack = await call('list_agents');
console.log(`list_agents → running: ${listedBack.agents.some((a) => a.agentName === PROBE_AGENT)}, still on the stood-down list: ${listedBack.standbyAgents.some((a) => a.agentName === PROBE_AGENT)}`);

verdict(
  Boolean(standby) &&
    standby.defaultAgent === 'shell' &&
    backOn.success === true &&
    returned &&
    !listedBack.standbyAgents.some((a) => a.agentName === PROBE_AGENT),
  'the agent this page switched off is the agent this page switched back on, with the\n' +
  '    launcher it was started with, and it left the candidate list the moment it did.',
  `the round trip did not close: standby=${Boolean(standby)} launcher=${standby?.defaultAgent} back=${returned}`
);

// ------------------------------------------------------------- 6. teardown --
rule('6. TEARDOWN — the machine as it was found');

await call('deactivate_by_key', { type: PROBE_TYPE, key: PROBE_KEY });
await waitForProbe(false);
const final = herdrAgents() ?? [];
console.log(`herdr agent list → ${final.length} agents`);
console.log(`  probe present:                    ${final.includes(PROBE_AGENT)}`);
console.log(`  every agent from section 1 still running: ${baseline.every((n) => final.includes(n))}`);

verdict(
  !final.includes(PROBE_AGENT) && baseline.every((n) => final.includes(n)),
  'no orphan pane, and every agent that was working when this started still is.',
  'this script did not leave the machine as it found it.'
);

socket.end();
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
