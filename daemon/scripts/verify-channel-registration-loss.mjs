// A daemon restart drops every channel registration. This proves that the fleet
// notices, that an idle agent comes back by itself, and that a `steer` at one
// that has not come back is refused rather than delivered by a Ctrl+C.
//
// WHAT FAILURE THIS WOULD CATCH: the silent downgrade of KAN-274 — a surviving
// agent losing its channel registration to an unrelated operational action, with
// nothing anywhere saying so, so that the next ordinary `steer` at it arrives as
// an interrupt. It was not hypothetical: on 2026-08-11 a deploy restarted the
// daemon at 15:00:40Z, four agents survived (`0 failed`, truthfully), and NO
// connection re-identified for 291 seconds. The three that came back did so on
// their own next tool call; the idle one never did. A `steer` sent into that
// window three minutes after an earlier restart answered `transport: "composer",
// interrupted: true` and cancelled a working supervisor's tool call — which on
// the recipient's side renders as a refusal nobody made.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
// Section 3 spawns a real daemon and a real MCP server and is therefore subject
// to scheduling, so the one observation whose window a fast machine can close —
// the identity map immediately after a restart — is taken with the agent
// SIGSTOPped rather than by winning the race for it (KAN-309).
//
// It would equally catch the half that made the downgrade invisible from the
// *sender's* side, which is the part a reader is most likely to think is covered
// and is not: `butchr_list_agents` reported `transport: "channel"` for exactly
// those agents, because that field was derived from the startup self-check
// verdict alone and never asked whether a connection existed. So a supervisor
// that did the responsible thing — read the row before sending — was told
// `channel` and interrupted the recipient anyway. Section 2 is the check that
// the row and the route cannot disagree again; a build where they are derived
// separately passes every test that only asks "did the message arrive".
//
// And it catches the fix overshooting, which is the failure mode of the fix
// rather than of the defect. A refusal keyed to a bare "no connection" would
// refuse every send to a pane or a human-activated workspace that never had a
// channel to lose, and would refuse every send in the fleet the day somebody
// pulled the kill switch. Section 2's controls 4 and 5 are those two cases, and
// they assert that a steer is still DELIVERED there.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), so, per section:
//
//   SECTION 1 supplies everything. It calls `carrierFor` with a table of
//   arguments and checks the answers. It tests the DECISION and nothing about
//   where the decision's inputs come from — in particular nothing about whether
//   a real registration is ever really lost.
//
//   SECTION 2 supplies the world — the connection map, which addresses count as
//   managed, and the kill switch — and then asks the SHIPPED code both ways
//   round: the row comes out of a real `MessageRouter.handle({action:
//   'list_agents'})` and the carrier out of a real `routeChannelMessage`. Asking
//   `carrierFor` twice and calling the agreement a proof would test nothing,
//   because the defect was precisely that `list_agents` answered this question by
//   its own separate route — so a check that never runs `list_agents` cannot see
//   it. What section 2 does NOT establish is that a daemon restart produces the
//   world it constructs; the `managed` predicate here is a set literal rather
//   than the real `AgentRegistry`, and the connection is released by hand rather
//   than by a socket dying.
//   WHO COVERS THAT: section 3, on a real daemon, with nothing supplied.
//
//   SECTION 3 is the section that exists because the other two would both pass
//   on a build with the reconnect defect fully present. A real daemon is started
//   from the build under test, a real `dist/mcp.js` is spawned the way an
//   activation spawns it, and then the daemon is KILLED and a new one started —
//   the actual operational action. **Nothing here writes a registration, drops
//   one, or reconnects anything**: it watches the production code do all three
//   and reads the result out of the daemon's own identity map and its own log
//   file. **The agent makes no tool call at any point after the restart**, which
//   is the whole of what KAN-274 is about — a busy agent always reconnected, and
//   proving it with one would prove nothing.
//
//   IT SUPPLIES EXACTLY ONE THING, and the AC4 checks are the ones that depend
//   on it: an `agents.jsonl` activation record, because `reconcileAgents` counts
//   dropped registrations only for agents the durable registry EXPECTS to be
//   running, and a section that spawned only an MCP server would leave that
//   registry empty — reconcile would report "no agents that should be running"
//   and the count line would never execute, leaving an assertion that looks like
//   a check and tests nothing. Everything downstream of that one record is the
//   shipped code: that a restart finds the agent surviving, notices it holds no
//   connection, and says so in the log an operator reads.
//   WHAT THAT LEAVES UNCOVERED: nothing here proves a real *activation* writes
//   such a record — that is `verify-activation-records-real-parentage.mjs` and
//   `verify-agent-resumption.mjs`, and this script does not re-test it.
//
//   WHAT NO SECTION HERE COVERS: whether a MODEL is disturbed by a composer
//   send, or notices a channel one. No Claude Code client and no model is run
//   here — the edge of this script is the daemon's socket and the MCP server's
//   stdio. So nothing in this file licenses any claim about what an interrupt
//   costs an agent; that is KAN-219's `probe-inflight-disturbance.mjs`, which is
//   a live experiment and is why it is a `probe-` and this is a `verify-`.
//   WHO COVERS THE REMAINING GAP — that a client which has re-registered still
//   delivers a channel frame to its model: nobody on this run, by design. It is
//   `channel-liveness.ts` (KAN-252) on a schedule, and its record is read off
//   `butchr_list_agents` as `channelLiveness`.
//
// ---------------------------------------------------------------------------
// HOW TO WATCH IT GO RED
// ---------------------------------------------------------------------------
// FOUR modes, one per behaviour this ticket changed, because a red that reaches
// only one of them leaves the others' assertions unproven — and a check that has
// only ever passed is evidence of nothing. Each patches the COPIED build, so
// none of them can touch the real one.
//
//   `--no-reconnect`  removes `scheduleReconnect` from `mcp.js`. That is the
//                     pre-KAN-274 behaviour exactly — the link drops and nothing
//                     re-establishes it until the agent next makes a tool call —
//                     so SECTION 3 reproduces the original defect and fails.
//
//   `--deliver-anyway` removes the refusal guard from `router.js`, so a steer at
//                     an agent with no registration falls through to the composer
//                     and really does issue a Ctrl+C. That is the headline defect,
//                     and it is what makes SECTION 2's "NOTHING WAS TYPED" check
//                     a gate rather than a sentence that has only ever passed.
//
//   `--silent-drop`   removes the AC4 count from `daemon.js`, restoring the
//                     silence that made this defect invisible in the first
//                     place: `0 failed`, truthfully, and nothing about the
//                     registrations the restart took with it. SECTION 3 fails.
//
//   `--stale-row`     puts `router.js` back to deriving the carrier from the
//                     self-check verdict alone. That is the reported symptom
//                     literally: `list_agents` answering `transport: "channel"`
//                     for an agent with no connection, so SECTION 2 fails.
//
// Every patch is ASSERTED rather than assumed, for the reason
// `verify-channel-emission-gate.mjs` asserts its own: a run whose patch silently
// missed would report healthy behaviour and be read as "this proof cannot go
// red", which is the opposite of what it means.
//
// Isolation is by $HOME: BUTCHR_DIR, the socket and the switch file all derive
// from os.homedir(), so a temp HOME gives this its own daemon, its own socket
// and its own switch, and the live daemon at ~/.local/share/butchr is untouched.
//
// Usage: node daemon/scripts/verify-channel-registration-loss.mjs [--no-reconnect] [--stale-row] [--deliver-anyway] [--silent-drop]

import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  mkdtempSync, mkdirSync, cpSync, rmSync, existsSync,
  readFileSync, writeFileSync, symlinkSync
} from 'fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const noReconnect = process.argv.includes('--no-reconnect');
const staleRow = process.argv.includes('--stale-row');
const deliverAnyway = process.argv.includes('--deliver-anyway');
const silentDrop = process.argv.includes('--silent-drop');

if (!existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(daemonDir, '..', 'node_modules')
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, '@modelcontextprotocol'))) return c;
  }
  console.error(`No node_modules with @modelcontextprotocol (checked: ${candidates.join(', ')}).`);
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan274-registration-'));
const installDir = path.join(scratch, 'install', 'daemon');
const distDir = path.join(installDir, 'dist');
mkdirSync(installDir, { recursive: true });
cpSync(path.join(daemonDir, 'dist'), distDir, { recursive: true });
symlinkSync(resolveNodeModules(), path.join(installDir, 'node_modules'));

const spawned = [];
process.on('exit', () => {
  for (const c of spawned) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- verdicts ---------------------------------------------------------------
const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const rule = (t) => { console.log('\n' + '='.repeat(78)); console.log(t); console.log('='.repeat(78)); };

// THE DELIBERATE BREAKS, applied to the copy and asserted rather than assumed.
//
// There are two because the defect had two halves in two files, and a red mode
// that only reaches one of them leaves the other half's assertions unproven —
// which is the thing this repository keeps paying for. `--stale-row` is the
// reported symptom reproduced literally: `list_agents` deriving the carrier from
// the self-check verdict alone, so an agent with no connection reads `channel`.
if (staleRow) {
  const target = path.join(distDir, 'router.js');
  const before = readFileSync(target, 'utf8');
  // Put back the pre-KAN-274 derivation: ignore the carrier reader entirely.
  const after = before.replace(
    /const verdict = this\.channelCarrier\?\.\([^;]*;/,
    'const verdict = null; // --stale-row (KAN-274 proof): the pre-fix derivation'
  );
  if (after === before) {
    console.error(
      '--stale-row could not find the `const verdict = this.channelCarrier?.(...)` line in the ' +
      'copied router.js. The patch did not apply, so this run would report an honest row for ' +
      'the wrong reason. Refusing to continue.'
    );
    process.exit(2);
  }
  writeFileSync(target, after);
  console.log('--stale-row: patched the copied router.js back to deriving the carrier from the');
  console.log('             self-check verdict alone. This is the reported KAN-274 symptom.');
  console.log('             Section 2 is expected to FAIL.');
}

// `--silent-drop` removes the AC4 count, restoring the silence that made this
// defect invisible: the restart still reports `0 failed`, truthfully, and says
// nothing about the registrations it took with it.
if (silentDrop) {
  const target = path.join(distDir, 'daemon.js');
  const before = readFileSync(target, 'utf8');
  const after = before.replace(
    'if (unregistered.length) {',
    'if (false) { // --silent-drop (KAN-274 proof): the restart says nothing'
  );
  if (after === before) {
    console.error(
      '--silent-drop could not find the `if (unregistered.length) {` count guard in the copied ' +
      'daemon.js. The patch did not apply, so this run would report an honest restart for the ' +
      'wrong reason. Refusing to continue.'
    );
    process.exit(2);
  }
  writeFileSync(target, after);
  console.log('--silent-drop: patched the copied daemon.js so the restart reports nothing about');
  console.log('               the registrations it dropped. Section 3 AC4 is expected to FAIL.');
}

// `--deliver-anyway` is the headline defect: a steer at an agent with no
// registration falling through to the composer and Ctrl+C'ing it. Without this
// mode the "NOTHING WAS TYPED" check has never been watched to fail, and a check
// that has only ever passed is evidence of nothing.
if (deliverAnyway) {
  const target = path.join(distDir, 'router.js');
  const before = readFileSync(target, 'utf8');
  const after = before.replace(
    "if (channelOutcome?.routed === false && channelOutcome.reason === 'registration-lost') {",
    "if (false) { // --deliver-anyway (KAN-274 proof): fall through to the composer"
  );
  if (after === before) {
    console.error(
      '--deliver-anyway could not find the `registration-lost` refusal guard in the copied ' +
      'router.js. The patch did not apply, so this run would report a refusal for the wrong ' +
      'reason. Refusing to continue.'
    );
    process.exit(2);
  }
  writeFileSync(target, after);
  console.log('--deliver-anyway: patched the copied router.js so a steer with no registration');
  console.log('                  falls through to the composer, as it did before KAN-274.');
  console.log('                  Section 2 is expected to FAIL, and to show a real Ctrl+C.');
}

if (noReconnect) {
  const target = path.join(distDir, 'mcp.js');
  const before = readFileSync(target, 'utf8');
  // Neuter the scheduler itself rather than its call sites, so a build that grows
  // a second caller cannot quietly keep reconnecting through it.
  const after = before.replace(
    /function scheduleReconnect\(\) \{/,
    'function scheduleReconnect() {\n    return; // --no-reconnect (KAN-274 proof)'
  );
  if (after === before) {
    console.error(
      '--no-reconnect could not find `function scheduleReconnect() {` in the copied mcp.js. ' +
      'The patch did not apply, so this run would report a healthy reconnect for the wrong ' +
      'reason. Refusing to continue.'
    );
    process.exit(2);
  }
  writeFileSync(target, after);
  console.log('--no-reconnect: patched the copied mcp.js so nothing re-establishes a dropped link.');
  console.log('                This is the pre-KAN-274 behaviour. Section 3 is expected to FAIL.');
}

// ============================================================================
rule('1. carrierFor: the decision table, including the two branches that must NOT refuse');
// ============================================================================
const { carrierFor } = await import(path.join(distDir, 'channel.js'));

const base = { emissionEnabled: true, degraded: false, registered: true, managed: true };
const table = [
  {
    name: 'a registered, undegraded agent is on the channel',
    args: { ...base },
    transport: 'channel', refusal: null
  },
  {
    name: 'a managed agent with NO registration is `unregistered`, not `channel`',
    args: { ...base, registered: false },
    transport: 'unregistered', refusal: 'registration-lost'
  },
  {
    name: 'a degraded agent stays on the composer even while registered',
    args: { ...base, degraded: true },
    transport: 'composer', refusal: 'selfcheck-failed'
  },
  {
    name: 'CONTROL: emission off fleet-wide is the composer, and is NOT a refusal',
    args: { ...base, emissionEnabled: false, registered: false },
    transport: 'composer', refusal: 'channel-disabled'
  },
  {
    name: 'CONTROL: an unmanaged address with no registration is the composer, not a refusal',
    args: { ...base, registered: false, managed: false },
    transport: 'composer', refusal: 'no-connection'
  },
  {
    name: 'the switch is read BEFORE the map: disabled+disconnected reads as disabled',
    args: { ...base, emissionEnabled: false, registered: false, managed: true },
    transport: 'composer', refusal: 'channel-disabled'
  },
  {
    name: 'degradation is read before the map: degraded+disconnected reads as degraded',
    args: { ...base, degraded: true, registered: false },
    transport: 'composer', refusal: 'selfcheck-failed'
  }
];

for (const row of table) {
  const got = carrierFor(row.args);
  check(
    row.name,
    got.transport === row.transport && got.refusal === row.refusal,
    `transport=${got.transport} refusal=${String(got.refusal)}`
  );
}

check(
  'every verdict carries a sentence a sender can act on',
  table.every((row) => (carrierFor(row.args).detail ?? '').length > 40),
  'no empty or stub detail strings'
);

// ============================================================================
rule('2. the row and the route agree — asked of the SHIPPED router and gate');
// ============================================================================
// The defect was two derivations of one question. This constructs the world and
// then asks the production code both ways round, which is the only arrangement
// in which "they disagree" is observable at all.
const { AgentConnectionRegistry } = await import(path.join(distDir, 'agent-connections.js'));
const { routeChannelMessage, writeChannelSwitch } = await import(path.join(distDir, 'channel.js'));

const routerHome = path.join(scratch, 'home-router');
mkdirSync(path.join(routerHome, '.local', 'share', 'butchr'), { recursive: true, mode: 0o700 });
process.env.HOME = routerHome;
writeChannelSwitch(true);

const conns = new AgentConnectionRegistry();
const MANAGED = { type: 'task', key: 'KAN-9274' };
const UNMANAGED = { type: 'task', key: 'KAN-9275' };
const managedSet = new Set(['task/kan-9274']);
const isManaged = (a) => managedSet.has(`${a.type}/${a.key}`.toLowerCase());

// A socket that accepts writes, so `routed: true` means the frame really left.
const sink = net.createServer(() => {});
await new Promise((r) => sink.listen(path.join(scratch, 'sink.sock'), r));
spawned.push({ kill: () => sink.close() });
const agentSocket = net.connect(path.join(scratch, 'sink.sock'));
await new Promise((res, rej) => { agentSocket.once('connect', res); agentSocket.once('error', rej); });
agentSocket.on('error', () => {});

const route = (address) =>
  routeChannelMessage({
    registry: conns,
    address,
    content: 'probe',
    selfCheck: { degraded: () => false },
    managed: isManaged
  });

// THE ROW COMES OUT OF THE REAL `list_agents`, not out of `carrierFor` again.
// Asking `carrierFor` twice and calling the agreement a proof would test nothing
// at all: the whole defect was that `list_agents` derived this answer *by its own
// route*, so a check that never runs `list_agents` cannot see the defect. A herdr
// census shim puts both addresses on the fleet so the router has rows to build.
const bin = path.join(scratch, 'bin');
mkdirSync(bin, { recursive: true });
const census = JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      { name: 'butchr-task-kan-9274', agent: 'claude', agent_status: 'working', cwd: scratch },
      { name: 'butchr-task-kan-9275', agent: 'claude', agent_status: 'working', cwd: scratch }
    ]
  }
});
// The shim LOGS EVERY INVOCATION, which is what turns "the send was refused"
// from a claim about a response object into a claim about the world: a composer
// send opens with `herdr pane send-keys <pane> C-c` (herdr.ts), so if no such
// line is in this log then no Ctrl+C was issued and nothing was interrupted.
// Asserting only the response's `interrupted: false` would be trusting the
// message rather than the mechanism — the exact substitution this ticket is
// about.
const herdrLog = path.join(scratch, 'herdr-invocations.log');
const paneAnswer = JSON.stringify({
  id: 'cli:agent:get',
  result: { type: 'agent', agent: { name: 'butchr-task-kan-9274', pane_id: '%42' } }
});
writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh\n` +
  `printf '%s\\n' "$*" >> ${JSON.stringify(herdrLog)}\n` +
  `case "$*" in\n` +
  `  *"agent get"*) cat <<'EOF'\n${paneAnswer}\nEOF\n  ;;\n` +
  `  *) cat <<'EOF'\n${census}\nEOF\n  ;;\n` +
  `esac\n`,
  { mode: 0o755 }
);
writeFileSync(herdrLog, '');
process.env.PATH = `${bin}:${process.env.PATH}`;

/** Mirrors the kill switch, so the row and the gate are asked the same thing. */
let emissionOn = true;

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));

/** One agent's `channel` row, off a real `list_agents` on a real router. */
function rowFor(address) {
  let response;
  const router = new MessageRouter(
    new WorkspaceRegistry(),
    new PromptLoader(path.resolve(daemonDir, '..')),
    new HerdrBridge(),
    (msg) => { response = msg; },
    () => {},
    {
      // The same two closures daemon.ts wires, over the same two maps.
      channelSelfCheck: () => null,
      channelCarrier: (addr, degraded) =>
        carrierFor({
          emissionEnabled: emissionOn,
          degraded,
          registered: conns.resolve(addr) !== undefined,
          managed: isManaged(addr)
        })
    }
  );
  router.handle({ action: 'list_agents' });
  const row = (response?.agents ?? []).find(
    (a) => `${a.type}/${a.key}`.toLowerCase() === `${address.type}/${address.key}`.toLowerCase()
  );
  return row?.channel;
}

const row = (address) => rowFor(address) ?? { transport: 'ROW-MISSING' };

// --- while registered -------------------------------------------------------
conns.register(agentSocket, MANAGED);
const routedWhileUp = route(MANAGED);
const rowWhileUp = row(MANAGED);
check(
  'registered: the route writes the frame',
  routedWhileUp.routed === true,
  `routed=${routedWhileUp.routed}`
);
check(
  'registered: the row says `channel`, and agrees with the route',
  rowWhileUp.transport === 'channel',
  `row=${rowWhileUp.transport}`
);

// --- the registration goes, exactly as a restart takes it --------------------
conns.release(agentSocket);
const routedWhenLost = route(MANAGED);
const rowWhenLost = row(MANAGED);

check(
  'lost: the route refuses with `registration-lost` rather than falling to the composer',
  routedWhenLost.routed === false && routedWhenLost.reason === 'registration-lost',
  `routed=${routedWhenLost.routed} reason=${routedWhenLost.reason}`
);
// THE REGRESSION ITSELF, stated as its own check so it reads in the output.
check(
  'lost: the row does NOT say `channel` — this is the exact claim KAN-274 was filed for',
  rowWhenLost.transport !== 'channel',
  `row=${rowWhenLost.transport} (pre-fix this said "channel" while a send took a Ctrl+C)`
);
check(
  'lost: the row says `unregistered`',
  rowWhenLost.transport === 'unregistered',
  `row=${rowWhenLost.transport}`
);

// --- the SEND path, on the real router, and what it did NOT do ---------------
// Everything above tests the gate and the row. This tests the thing an agent
// actually calls, because a gate that refuses and a handler that falls through
// to the composer anyway would satisfy every check so far.
async function sendVia(address, intent) {
  let response;
  const router = new MessageRouter(
    new WorkspaceRegistry(),
    new PromptLoader(path.resolve(daemonDir, '..')),
    new HerdrBridge(),
    (msg) => { response = msg; },
    () => {},
    {
      channelRoute: (addr, content, meta) =>
        routeChannelMessage({
          registry: conns,
          address: addr,
          content,
          meta,
          selfCheck: { degraded: () => false },
          managed: isManaged
        })
    }
  );
  router.handle({
    action: 'send_to_agent',
    key: address.key,
    type: address.type,
    message: 'an ordinary steer',
    ...(intent ? { intent } : {}),
    workspaceType: 'epic',
    workspaceKey: 'KAN-39'
  });
  // The composer path answers through a promise; the refusal answers inline.
  for (let i = 0; i < 40 && response === undefined; i++) await sleep(50);
  return response;
}

const invocationsBefore = readFileSync(herdrLog, 'utf8');
const refused = await sendVia(MANAGED);
const invocationsAfter = readFileSync(herdrLog, 'utf8');
const newInvocations = invocationsAfter.slice(invocationsBefore.length);

check(
  'send_to_agent REFUSES a steer at an agent whose registration is gone',
  refused?.success === false && refused?.transport === 'unregistered',
  `success=${refused?.success} transport=${refused?.transport}`
);
check(
  'the refusal reports interrupted: false',
  refused?.interrupted === false,
  `interrupted=${String(refused?.interrupted)}`
);
check(
  'NOTHING WAS TYPED: herdr was never asked to send a Ctrl+C',
  !newInvocations.includes('C-c'),
  newInvocations.trim()
    ? `herdr calls during the send: ${newInvocations.trim().split('\n').join(' | ')}`
    : 'herdr was not invoked at all'
);
check(
  'the refusal names the condition and what to do about it',
  typeof refused?.error === 'string' &&
    refused.error.includes('no channel registration') &&
    refused.error.includes('stop-now'),
  refused?.error ? `${refused.error.slice(0, 80)}…` : 'no error text'
);

// AND THE ESCAPE HATCH STILL WORKS. `stop-now` is explicitly about taking the
// recipient's work, so it must still reach the composer even here — otherwise
// this ticket has removed the fleet's only stop-now signal, which is the loss
// design §5.1 says we would otherwise take "without noticing".
const stopBefore = readFileSync(herdrLog, 'utf8');
const stopped = await sendVia(MANAGED, 'stop-now');
const stopAfter = readFileSync(herdrLog, 'utf8');
check(
  'CONTROL: `stop-now` at the same agent still takes the composer and is NOT refused',
  stopped?.transport === 'composer' && stopped?.success === true,
  `transport=${stopped?.transport} success=${stopped?.success}`
);
check(
  'CONTROL: and it really did interrupt — herdr was asked for a Ctrl+C',
  stopAfter.slice(stopBefore.length).includes('C-c'),
  'the escape hatch is a behaviour, not a label'
);

// --- CONTROL: an address the registry does not manage ------------------------
const routedUnmanaged = route(UNMANAGED);
const rowUnmanaged = row(UNMANAGED);
check(
  'CONTROL: an unmanaged address is NOT refused — it falls to the composer as always',
  routedUnmanaged.routed === false && routedUnmanaged.reason === 'no-connection',
  `reason=${routedUnmanaged.reason}`
);
check(
  'CONTROL: an unmanaged address reads `composer`, not `unregistered`',
  rowUnmanaged.transport === 'composer',
  `row=${rowUnmanaged.transport}`
);

// --- CONTROL: the kill switch ------------------------------------------------
writeChannelSwitch(false);
emissionOn = false;
const routedSwitchedOff = route(MANAGED);
const rowSwitchedOff = row(MANAGED);
check(
  'CONTROL: with emission off fleet-wide a managed agent is NOT refused',
  routedSwitchedOff.routed === false && routedSwitchedOff.reason === 'channel-disabled',
  `reason=${routedSwitchedOff.reason} (a refusal here would break every send in the fleet)`
);
check(
  'CONTROL: with emission off the row reads `composer`, not `unregistered`',
  rowSwitchedOff.transport === 'composer',
  `row=${rowSwitchedOff.transport}`
);
writeChannelSwitch(true);
emissionOn = true;

// ============================================================================
rule('3. LIVE: a real daemon restart, and an IDLE agent that re-registers by itself');
// ============================================================================
const home = path.join(scratch, 'home-live');
const butchrDir = path.join(home, '.local', 'share', 'butchr');
mkdirSync(butchrDir, { recursive: true, mode: 0o700 });
const socketPath = path.join(butchrDir, 'butchr.sock');
const daemonLogPath = path.join(butchrDir, 'daemon.log');
process.env.HOME = home;
writeChannelSwitch(true);

// THE DURABLE REGISTRY, WRITTEN BY HAND — and this is the one thing section 3
// supplies, so it is named here rather than left for a reader to discover.
//
// AC 4 asks the restart to say how many registrations it dropped, and it can
// only say that about agents it EXPECTS to be running: `reconcileAgents` reads
// `AgentRegistry.expected()`, which is this file. A section that spawned only an
// MCP server would leave the registry empty, reconcile would report "no agents
// that should be running", and the count line would never execute — so the
// assertion below would be vacuous while looking like a check.
//
// What is supplied is one activation record. What is NOT supplied, and is what
// the assertion actually tests, is everything downstream of it: that a real
// restart finds this agent surviving, notices it holds no connection, and says
// so. The herdr census shim from section 2 is on PATH and names this agent, so
// `reconcile` classifies it as already-running rather than as one to restore.
writeFileSync(
  path.join(butchrDir, 'agents.jsonl'),
  JSON.stringify({
    event: 'activated',
    at: '2026-08-11T00:00:00.000Z',
    agentName: 'butchr-task-kan-9274',
    type: 'task',
    key: 'KAN-9274',
    workDir: scratch,
    defaultAgent: 'claude'
  }) + '\n'
);

function startDaemon(label) {
  const proc = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  spawned.push(proc);
  return proc;
}

async function waitForSocket(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      try {
        const probe = net.connect(socketPath);
        await new Promise((res, rej) => { probe.once('connect', res); probe.once('error', rej); });
        probe.end();
        return true;
      } catch { /* not accepting yet */ }
    }
    await sleep(100);
  }
  return false;
}

/** Ask the daemon's own identity map who is registered. The diagnostic reader. */
async function connectedAgents() {
  const socket = net.connect(socketPath);
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  socket.on('error', () => {});
  let buffer = '';
  const answer = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.action === 'connected_agents_response') resolve(msg);
        } catch { /* not ours */ }
      }
    });
  });
  socket.write(JSON.stringify({ action: 'connected_agents' }) + '\n');
  const res = await Promise.race([answer, sleep(5000).then(() => null)]);
  socket.end();
  return res;
}

const registeredKeys = (res) =>
  (res?.agents ?? []).map((a) => `${a.type}/${a.key}`.toLowerCase()).sort();

const daemon1 = startDaemon('first');
if (!(await waitForSocket(20_000))) {
  console.error('the first daemon never claimed its socket');
  process.exit(2);
}

// A REAL MCP SERVER, spawned with the identity flags a real activation gives it.
// It is never sent a single MCP request after this, so it never makes a tool
// call — which is the entire point: a busy agent reconnected before this ticket
// and would prove nothing.
const AGENT = { type: 'task', key: 'KAN-9274' };
const agent = spawn(
  process.execPath,
  // Space-separated, which is how `launchers.ts` writes them. `--flag=value` is
  // silently read as "no identity" by `workspaceIdentityFromArgv`, and a server
  // with no identity stays anonymous by design — so getting this wrong produces
  // an agent that connects and never registers, which looks exactly like the
  // defect under test. Named because this script had that bug once.
  [
    path.join(distDir, 'mcp.js'),
    '--workspace-type', AGENT.type,
    '--workspace-key', AGENT.key
  ],
  { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }
);
agent.stdout.on('data', () => {});
agent.stderr.on('data', () => {});
spawned.push(agent);

let up = false;
for (let i = 0; i < 60; i++) {
  if (registeredKeys(await connectedAgents()).includes('task/kan-9274')) { up = true; break; }
  await sleep(250);
}
check('the agent registers with the first daemon', up, up ? 'identity map holds it' : 'never appeared');
if (!up) {
  console.error('\nSetup did not reach the state under test; the sections above still stand.');
  console.log('\n' + '='.repeat(78));
  console.log(`FAILED (${failures.length + 1}): setup — the agent never registered at all`);
  console.log('='.repeat(78));
  process.exit(1);
}

// THE AGENT IS SUSPENDED ACROSS THE RESTART, AND THAT IS WHAT MAKES THE NEXT
// ASSERTION AN OBSERVATION RATHER THAN A RACE (KAN-309).
//
// The two facts this section reports are in tension by construction: that a
// restart leaves the agent unregistered, and that the agent puts that right by
// itself within milliseconds. KAN-274 made the second true, which made the
// window in which the first is observable *very* small — and this script read
// the identity map after the window rather than inside it, so whether it saw
// the empty state depended on which of the two won.
//
// On 2026-08-11 it lost, on `main`, on a runner where the agent came back in
// 1 ms. It reported `identity map: [task/kan-9274] — this is the state the
// defect leaves behind`, which reads as the KAN-274 defect returning. Nothing
// had regressed: the daemon dropped the registration exactly as it should, said
// so in its own log (the AC4 checks below saw it and passed), and the agent
// reconnected before this line could look. A green re-run of the identical SHA
// is what established that.
//
// SIGSTOP holds the agent still while the restart is observed. It suspends the
// process without closing anything: the socket is still torn down by the kernel
// when daemon1 dies, and the agent simply has not run the code that notices
// yet. So the state being asserted is the real one, produced by a real restart —
// only the moment of reading is taken out of the scheduler's hands. Cleanup
// kills with SIGKILL, which reaps a stopped process, so an early exit below
// cannot leave one behind.
//
// What this deliberately does NOT weaken: the reconnect is still unassisted and
// still measured (below), and it is still an agent that has made no tool call.
// Suspending it delays when it can notice, never whether it notices by itself.
agent.kill('SIGSTOP');

// THE OPERATIONAL ACTION. Not a simulation of one: the daemon is killed and a
// new one is started, which is what `systemctl --user restart butchr-daemon`
// does to every surviving agent's connection.
daemon1.kill('SIGKILL');
await sleep(500);

const daemon2 = startDaemon('second');
if (!(await waitForSocket(20_000))) {
  agent.kill('SIGCONT');
  console.error('the second daemon never claimed its socket');
  process.exit(2);
}

const afterRestart = registeredKeys(await connectedAgents());
check(
  'immediately after the restart the new daemon holds NO registration for it',
  !afterRestart.includes('task/kan-9274'),
  `identity map: [${afterRestart.join(', ') || 'empty'}] — this is the state the defect leaves behind` +
    ' (observed with the agent suspended, so it is a reading and not a race)'
);

// AC 4 — THE RESTART SAYS WHAT IT DROPPED, AND SOMETHING WATCHES IT SAY SO.
//
// Added after review: the count was implemented and unasserted, so the line
// could have been deleted or reworded into uselessness with every check still
// green. On this ticket in particular that is the wrong shape to leave lying
// around — the whole thesis here is that silence is expensive, and `0 failed`
// was true and misleading in the same line. An unguarded report of a dropped
// count is that same defect one level up.
//
// Read out of the daemon's OWN log file rather than a captured stream, because
// that is the artefact an operator actually reads after a deploy.
let reconcileLine = null;
for (let i = 0; i < 80; i++) {
  const text = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '';
  // Only lines from the SECOND daemon: the first one logged its own reconcile to
  // the same file, and matching that would pass without the restart having said
  // anything at all.
  const afterSecondBoot = text.split('Butchr daemon listening on').pop() ?? '';
  reconcileLine = afterSecondBoot
    .split('\n')
    .find((l) => l.includes('hold no channel registration')) ?? null;
  if (reconcileLine) break;
  await sleep(250);
}

check(
  'AC4: the restart reports how many surviving agents hold no registration',
  reconcileLine !== null,
  reconcileLine
    ? reconcileLine.trim().slice(0, 150) + '…'
    : 'no line naming a dropped count appeared in the daemon log after the restart'
);
check(
  'AC4: and it names them, rather than reporting a bare number',
  reconcileLine !== null && reconcileLine.includes('task/KAN-9274'),
  reconcileLine?.includes('task/KAN-9274')
    ? 'the affected agent is named'
    : 'a count with no names sends the reader nowhere'
);
check(
  'AC4: and it says what a sender should expect — that a steer is refused, not delivered',
  reconcileLine !== null && reconcileLine.includes('REFUSED'),
  'the line has to tell an operator what changed for messaging, not only that a number is non-zero'
);

// AND NOW THE WHOLE TICKET: does it come back on its own?
//
// Resumed here, and the clock starts here (KAN-309). The figure below is
// therefore "how long after it could notice", which is the honest baseline and
// is what it always meant to measure — before the suspension it was timed from
// a moment the agent may already have been past.
agent.kill('SIGCONT');
const startedWaiting = Date.now();
let backAfterMs = null;
for (let i = 0; i < 120; i++) {
  if (registeredKeys(await connectedAgents()).includes('task/kan-9274')) {
    backAfterMs = Date.now() - startedWaiting;
    break;
  }
  await sleep(250);
}

check(
  'the IDLE agent re-registers by itself, having made no tool call',
  backAfterMs !== null,
  backAfterMs !== null
    ? `back after ${backAfterMs}ms`
    : 'still absent after 30s — an idle agent stays unaddressable, which is the defect'
);
if (backAfterMs !== null) {
  check(
    'it comes back promptly rather than eventually',
    backAfterMs < 30_000,
    `${backAfterMs}ms`
  );
}

console.log('\n' + '='.repeat(78));
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  if (noReconnect) {
    console.log('\n(--no-reconnect was passed: section 3 failing here is the point. It is the');
    console.log(' pre-KAN-274 behaviour, reproduced, and it is what the fix removes.)');
  }
} else {
  console.log('All checks passed.');
}
console.log('='.repeat(78));

process.exit(failures.length ? 1 : 0);
