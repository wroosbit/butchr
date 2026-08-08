// KAN-221: what the board reconciler would do to *this* machine, right now.
//
// Report-only by construction, not by a flag: this script holds no activate and
// no deactivate to call. It reads the real board through the real credential
// and the real fleet through the running daemon's socket, runs the real
// `computeBoardDiff`, and prints the answer. Nothing here can start or stop an
// agent, which is the point — KAN-221 requires the loop to report what it would
// do before it is allowed to do it, and a report you have to trust a mode
// switch for is a weaker report.
//
// It is named `report-` rather than `verify-` deliberately. It asserts nothing
// and has no verdict: a diff is a fact about the board and the fleet at one
// instant, not a pass or a fail. `sweep-verify-exit-paths.mjs` polices the
// `verify-` namespace for scripts that cannot report failure, and a script with
// nothing to fail has no business in it.
//
// WHAT THIS COVERS THAT verify-board-reconciler-guard.mjs DOES NOT
//
// That script stubs the Jira read, because it has to: you cannot ask the real
// Atlassian to fail on cue. What a stub cannot show is that the *real*
// `searchBoard` — real endpoint, real credential, real JQL, real response shape
// — produces the input `computeBoardDiff` expects. This is that half. Between
// them: this one proves the read arrives, that one proves what happens when it
// does not. Neither proves the daemon's timer fires, which is
// `boardReconciler.start()` in daemon.ts and is covered by nothing but reading
// it and by watching the log line it prints at startup.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/report-board-convergence.mjs [distDir]
//
// Requires: a Jira credential configured on this machine, and a running daemon.

import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', process.argv[2] ?? 'dist');
const SOCKET_PATH = path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');

const { JiraIssueTypeService } = await import(path.join(distDir, 'jira.js'));
const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));
const { BOARD_JQL, computeBoardDiff, describeBoardDiff, boardWorkspaceTypes } = await import(
  path.join(distDir, 'board-reconcile.js')
);

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ------------------------------------------------- the fleet, from the daemon --
//
// Over the socket rather than by constructing a MessageRouter here: a second
// router would build a second HerdrBridge with its own session map, and the
// running daemon's sessions are exactly what makes its census the true one.

function listAgents() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    let buffer = '';
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(15_000, () => fail(new Error(`no answer from ${SOCKET_PATH} within 15s`)));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'list_agents' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.action === 'list_agents_response') {
          socket.destroy();
          resolve(msg);
          return;
        }
      }
    });
  });
}

rule('1. THE BOARD — the real JQL, through the real credential');

console.log(`   query: ${BOARD_JQL}\n`);

const jira = new JiraIssueTypeService(new CredentialStore());
const outcome = await jira.searchBoard(BOARD_JQL);

if (!outcome.ok) {
  console.log(`   the board could not be read: ${outcome.error}`);
  console.log(`   backOff: ${outcome.backOff}`);
  console.log(
    `\n   → the reconciler would converge NOTHING this cycle, and the fleet below ` +
    `would be left exactly as it is.`
  );
  const fleet = await listAgents().catch(() => null);
  if (fleet) console.log(`   (the fleet it left alone: ${fleet.agents.length} agent(s))`);
  process.exit(0);
}

console.log(`   ${outcome.issues.length} issue(s) returned:\n`);
for (const issue of outcome.issues) {
  console.log(`     ${issue.key.padEnd(10)} ${String(issue.issueTypeName).padEnd(8)} ${issue.statusName}`);
}

rule('2. THE FLEET — the running daemon\'s own census');

const fleet = await listAgents();
const running = fleet.agents.map((agent) => ({
  agentName: agent.agentName,
  type: agent.type,
  key: agent.key
}));

console.log(`   ${running.length} agent(s) running:\n`);
for (const agent of running) {
  console.log(`     ${agent.agentName.padEnd(28)} ${String(agent.type).padEnd(8)} ${agent.key}`);
}
console.log(
  `\n   ${fleet.unbackedPanes?.length ?? 0} unbacked pane(s), reported separately and not agents ` +
  `— this loop reads .agents and never the pane list.`
);

rule('3. THE DIFF — what the reconciler would do');

const diff = computeBoardDiff(outcome.issues, running);
console.log(`   ${describeBoardDiff(diff)}\n`);
console.log(`   jurisdiction (workspace types a Jira query can describe): ` +
  `${[...boardWorkspaceTypes()].sort().join(', ')}\n`);

const show = (label, rows, render) => {
  console.log(`   ${label}: ${rows.length}`);
  for (const row of rows) console.log(`     ${render(row)}`);
};

show('WOULD START', diff.toStart, (a) => `${a.type}/${a.key}  (${a.issueTypeName}, ${a.statusName})`);
show('WOULD STOP', diff.toStop, (a) => `${a.type}/${a.key}`);
show('already right', diff.unchanged, (a) => `${a.type}/${a.key}`);
show('unresolved board rows', diff.unresolved, (i) => `${i.key}: ${i.reason}`);
show('spared by an unresolved row', diff.protectedByUnresolved, (a) => `${a.type}/${a.key}`);
show('outside jurisdiction', diff.outOfJurisdiction, (a) => `${a.type ?? 'unknown'}/${a.key}`);

console.log(
  `\n   → ${
    diff.toStart.length + diff.toStop.length === 0
      ? 'the board and the fleet agree; a converge cycle would do nothing.'
      : `a converge cycle would make ${diff.toStart.length + diff.toStop.length} change(s).`
  }`
);
