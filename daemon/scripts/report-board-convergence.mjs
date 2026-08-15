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
const {
  BOARD_JQL,
  BOARD_DIAGNOSTIC_JQL,
  computeBoardDiff,
  describeBoardDiff,
  boardWorkspaceTypes,
  findNearMisses,
  deriveAccountId,
  explainAbsence,
  isIntent,
  partitionStandDowns,
  fleetProjects,
  projectOf
} = await import(path.join(distDir, 'board-reconcile.js'));

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
  console.log(
    `     ${issue.key.padEnd(10)} ${String(issue.issueTypeName).padEnd(8)} ` +
    `${String(issue.statusName).padEnd(12)} ${issue.assigneeDisplayName ?? '(unassigned)'}`
  );
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
// Not "WOULD STOP". Since KAN-342 the board failing to return a running agent
// makes it a *candidate* and nothing more — the loop stands it down only where
// the board said something, and section 6 below is where each candidate's
// condition is read. Printing this list under the old label would have this
// report claiming an action the daemon it is reporting on would not take.
show('stand-down CANDIDATES (see §6 for what would actually happen to each)',
  diff.toStop, (a) => `${a.type}/${a.key}`);
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

// -------------------------------------------------- 4. the diagnostic, live --
//
// KAN-256's half. `verify-absence-attribution.mjs` constructs the board answers
// it asserts on — it has to, since you cannot ask the real Atlassian to
// unassign an epic on cue — so nothing there proves the REAL search returns a
// real `assignee` in the shape `boardPageFrom` expects. This is that half: both
// queries, the real credential, the live board.

rule('4. THE DIAGNOSTIC — the same board without the assignee half (KAN-256)');

console.log(`   query: ${BOARD_DIAGNOSTIC_JQL}\n`);

const diagnosticOutcome = await jira.searchBoard(BOARD_DIAGNOSTIC_JQL);

if (!diagnosticOutcome.ok) {
  console.log(`   the diagnostic query could not be read: ${diagnosticOutcome.error}`);
  console.log(
    `\n   → convergence is unaffected — this query never starts or stops anything — but a ` +
    `stand-down this cycle would report an undetermined reason rather than guessing one.`
  );
} else {
  const diagnostic = diagnosticOutcome.issues;
  const accountId = deriveAccountId(outcome.issues);
  const partitioned = new Set(outcome.issues.map((i) => i.key.trim().toUpperCase()));

  console.log(`   ${diagnostic.length} issue(s) In Progress or In Review under ANY assignee:\n`);
  for (const issue of diagnostic) {
    const mine = partitioned.has(issue.key.trim().toUpperCase());
    console.log(
      `     ${issue.key.padEnd(10)} ${String(issue.statusName).padEnd(12)} ` +
      `${(issue.assigneeDisplayName ?? '(UNASSIGNED)').padEnd(18)} ${mine ? '' : '← not in the partitioned answer'}`
    );
  }

  console.log(
    `\n   this machine's account, derived from the partitioned answer's own rows: ` +
    `${accountId ? 'established' : 'NOT established (the partitioned query returned no rows)'}`
  );

  // The near-miss report — the reason this section exists. A ticket here is one
  // the reconciler can never start, and it is invisible on every other surface.
  const projects = fleetProjects(outcome.issues, running);
  const misses = findNearMisses(diagnostic, projects);
  const unscoped = findNearMisses(diagnostic, new Set(diagnostic.map((i) => projectOf(i.key))));
  rule('5. NEAR MISSES — In Progress or In Review with NOBODY assigned');
  console.log(`   fleet projects (from the board's own rows and the running agents): ` +
    `${[...projects].sort().join(', ') || '(none)'}`);
  console.log(
    `   ${unscoped.length} unassigned account-wide, ${misses.length} of them in this fleet's ` +
    `projects — the rest are other people's and are not reported.\n`
  );
  for (const miss of misses) {
    console.log(`     ${miss.key.padEnd(10)} ${String(miss.issueTypeName).padEnd(8)} ${miss.statusName}`);
  }
  console.log(
    `\n   → ${
      misses.length === 0
        ? 'every ticket in this fleet\'s projects that the board has In Progress or In Review ' +
          'has somebody in the assignee field, so none of them is invisible to the reconciler ' +
          'right now.'
        : `${misses.length} ticket(s) the reconciler CANNOT SEE: it will not start them, and if ` +
          'an agent for one is running it will be stood down within a cycle. Assign them.'
    }`
  );
  if (unscoped.length > misses.length) {
    console.log(
      `\n   (${unscoped.length - misses.length} unassigned ticket(s) outside this fleet's ` +
      `projects were deliberately not reported: ` +
      `${unscoped.filter((m) => !misses.includes(m)).map((m) => m.key).join(', ')}. ` +
      `Unfiltered this line would repeat every 60s forever — see fleetProjects.)`
    );
  }

  // And what the loop would say about each stand-down it is contemplating —
  // the attributed reason, on real data, rather than the old one-size sentence.
  // Since KAN-342 the same condition also decides whether the stand-down happens
  // at all, so this section reads it through the product's own `isIntent` rather
  // than restating the rule: a copy of the list here would be a second store of
  // it, and this file is a report rather than a place decisions live.
  if (diff.toStop.length) {
    rule('6. WHY — the condition each candidate carries, and what the loop would do');
    const { standDowns, spared } = partitionStandDowns(
      diff.toStop,
      diff.toStop.map((a) => ({
        agentName: a.agentName,
        reason: explainAbsence(a, diff.desired, diagnostic, accountId)
      }))
    );
    for (const a of diff.toStop) {
      const reason = explainAbsence(a, diff.desired, diagnostic, accountId);
      console.log(`\n     ${a.type}/${a.key}`);
      console.log(`       condition: ${reason.condition}`);
      console.log(`       verdict:   ${isIntent(reason.condition)
        ? 'STAND DOWN — the board said so'
        : 'LEAVE IT RUNNING — nothing established that anybody asked it to stop (KAN-342)'}`);
      console.log(`       says:      ${reason.detail}`);
    }
    console.log(
      `\n   → of ${diff.toStop.length} candidate(s): ${standDowns.length} would be stood down, ` +
      `${spared.length} left running.`
    );
  }
}
