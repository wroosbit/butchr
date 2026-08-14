// The cutover sequence's reads, for a driver who is not an agent (KAN-378).
//
// WHY THIS EXISTS. `docs/crabcast-cutover-sequence.md` Q6 concludes that the
// driver **must not** be an agent this daemon manages: any managed agent is
// either drained during the drain phase or destroyed at the flip, so none
// survives to read the next check. `epic/KAN-39` walked the sequence and found
// the contradiction that left: every step's check was written in `butchr_*`
// vocabulary, and those are MCP tools **a human at a terminal does not have**.
// Step 1 was the only step that named a non-agent route. This script is that
// route, for the rest of them.
//
// IT READS AND NEVER WRITES. Two socket actions, both reads:
// `agent_runtime_report` and `list_agents`. There is deliberately no drain verb
// here — standing an agent down is a decision with a ticket comment attached to
// it, and a tool that made it one keystroke from a status read would be
// inviting exactly the accident the sequence is ordered to avoid.
//
// IT REPORTS CONDITIONS AND RENDERS NO VERDICT. It will not tell you the fleet
// is ready to flip. Three of step 8's preconditions are not observable from
// here — whether the gates are closed, whether the human has decided, and
// whether the person running this is a managed agent — and a green light that
// silently omitted them would be the defect this whole document is about.
//
// Usage:
//   node daemon/scripts/probe-cutover-readiness.mjs          # human-readable
//   node daemon/scripts/probe-cutover-readiness.mjs --json   # the raw frames
//
// Exit codes: 0 the reads were made; 2 the daemon socket could not be reached,
// which is a fact about this invocation rather than a verdict about the fleet —
// and is itself abort condition 2, because every emptiness claim in the drain
// is read off a census that has to be takeable.

import net from 'net';
import os from 'os';
import path from 'path';

const SOCKET_PATH = path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');
const json = process.argv.includes('--json');

/**
 * One connection, newline-delimited JSON, correlated by `id` — the same wire
 * the MCP server speaks, with node builtins only. No import from the daemon's
 * `dist` and no dependency on `node_modules`, deliberately: this is a tool for
 * the worst day, and it has to run on a checkout nobody has installed.
 */
function connect(socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const pending = new Map();
    let buf = '';
    let nextId = 0;
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          const settle = frame?.id !== undefined ? pending.get(frame.id) : undefined;
          if (settle) {
            pending.delete(frame.id);
            settle(frame);
          }
        } catch {
          /* a frame we cannot parse is not ours to interpret */
        }
      }
    });
    sock.once('connect', () =>
      resolve({
        call: (action, data = {}) =>
          new Promise((done) => {
            const id = `cutover-${process.pid}-${++nextId}`;
            pending.set(id, done);
            sock.write(`${JSON.stringify({ id, action, ...data })}\n`);
            setTimeout(() => {
              if (pending.delete(id)) done({ success: false, error: `no answer to ${action} in 10s` });
            }, 10_000);
          }),
        end: () => sock.end()
      })
    );
  });
}

let link;
try {
  link = await connect();
} catch (err) {
  console.error(
    `setup: could not reach the Butchr daemon at ${SOCKET_PATH} — ${err?.message ?? err}\n` +
      `That is this invocation, not a verdict about the fleet. If the daemon is genuinely down, the\n` +
      `census cannot be taken, which is abort condition 2 of docs/crabcast-cutover-sequence.md.`
  );
  process.exit(2);
}

const runtime = await link.call('agent_runtime_report');
const fleet = await link.call('list_agents');
link.end();

if (json) {
  console.log(JSON.stringify({ agent_runtime_report: runtime, list_agents: fleet }, null, 2));
  process.exit(0);
}

const line = (label, value) => console.log(`  ${label.padEnd(34)}${value}`);
const head = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

head('Which runtime is serving  (steps 1, 8, R3)');
if (!runtime?.success) {
  line('agent_runtime_report', `REFUSED — ${runtime?.error ?? 'no reason given'}`);
} else {
  const r = runtime.runtime ?? {};
  line('mode', r.mode);
  line('implementation', r.implementation);
  line('source', r.source);
  line('raw value', JSON.stringify(r.rawValue));
  line('fallbackReason', r.fallbackReason ?? 'none');
  line('decided at', r.decidedAt);
  if (r.crabcast) {
    line('crabcast socket', r.crabcast.socketPath);
    line('proved against commit', r.crabcast.pinnedCommit);
  }
  if (r.fallbackReason) {
    console.log(
      '\n  A fallbackReason means a value was set and was unusable, and the daemon stayed on herdr.\n' +
        '  That is the safe direction and it is step 8\'s abort: fix the drop-in and restart rather\n' +
        '  than proceeding as though the flip took.'
    );
  }
}

head('Is the fleet drained?  (steps 4, 5, R2 — two conditions, not one)');
if (!fleet?.success) {
  line('list_agents', `REFUSED — ${fleet?.error ?? 'no reason given'}`);
  console.log('\n  The census could not be taken. That is abort condition 2.');
} else {
  const agents = fleet.agents ?? [];
  const missing = fleet.missingAgents ?? [];
  line('agents running', `${agents.length}${agents.length ? ` — ${agents.map((a) => a.agentName).join(', ')}` : ''}`);
  line('missingAgents (still expected)', `${missing.length}${missing.length ? ` — ${missing.map((a) => a.agentName).join(', ')}` : ''}`);
  line('unbackedPanes', (fleet.unbackedPanes ?? []).length);
  line('preemptedAgents', (fleet.preemptedAgents ?? []).length);
  line('standbyTotal', fleet.standbyTotal ?? 0);
  line('censusUnreadableRecordsTotal', fleet.censusUnreadableRecordsTotal);
  console.log(
    `\n  DRAINED means BOTH of: the registry expects nobody (agents and missingAgents empty), and no\n` +
      `  Butchr pane is alive. The first is the one that decides what a restart re-spawns, and it is\n` +
      `  not the one people look at.\n` +
      `  standbyTotal is NOT part of the drain — those agents are neither running nor expected. It is\n` +
      `  printed because "the fleet is drained" is not "there is nothing left to lose" (see U-3).\n` +
      `  A non-zero censusUnreadableRecordsTotal means this list is SHORT by that many; an INCREASE\n` +
      `  during the cutover is abort condition 3.`
  );

  head('Will the board refill what you drain?  (step 2, step 11)');
  const board = fleet.boardControl;
  if (!board) {
    line('boardControl', 'ABSENT — no reconciler is wired in this daemon');
  } else {
    line('mode', board.mode);
    line('cycle seconds', board.cycleSeconds);
    line('agents under board control', Object.keys(board.controlled ?? {}).length);
    if (board.mode === 'converge') {
      console.log(
        '\n  CONVERGE. A drain performed underneath this is refilled from the board within a cycle.\n' +
          '  Step 2 is what freezes it, and the mode is read from the DAEMON\'S OWN environment, so\n' +
          '  exporting the variable in your shell changes nothing — see step 2 for the drop-in.'
      );
    }
  }

  head('Who is the guardian?  (step 6)');
  const g = fleet.guardian;
  if (!g?.configured) {
    line('guardian', 'none configured');
  } else {
    line('guardian', `${g.address?.type}/${g.address?.key}`);
    line('last poke', `${g.lastPoke?.outcome ?? 'never'}${g.overdue ? ' — OVERDUE' : ''}`);
    console.log(
      '\n  The guardian is a role laid on an agent that already has a ticket, so draining that agent\n' +
        '  leaves the fleet unswept. Step 6 asks you to decide that deliberately and write it down.'
    );
  }
}

head('What this probe cannot see');
console.log(
  `  - Whether the four cutover gates are closed. Read KAN-348.\n` +
    `  - Whether the human has decided to flip, in their own words rather than relayed.\n` +
    `  - Whether you, running this, are an agent this daemon manages. If you are, Q6 says you are\n` +
    `    not the driver — the flip ends your conversation and nobody reads the next check.\n` +
    `  So this prints conditions and renders no verdict, and there is deliberately no line below\n` +
    `  saying you are ready.`
);
