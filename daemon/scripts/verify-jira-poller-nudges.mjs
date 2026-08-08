// Proof for KAN-79: the daemon polls the Jira issues of its live agents, and a
// status change or a new comment reaches the agents it concerns — once.
//
// WHAT FAILURE THIS WOULD CATCH: a poller that replays history. Every failure
// mode here is a nudge sent when it should not have been, because that is the
// mode with teeth: each one interrupts a working agent's composer with a
// Ctrl+C, so a poller that re-announces on every tick, or dumps a ticket's
// whole comment history the first time it sees it, or repeats a tick's events
// after a daemon restart, is worse than no poller at all. Concretely — a state
// file that is not consulted after a restart (section 4), an issue initialised
// loudly instead of silently (3), an event announced twice because recognition
// was recorded after delivery rather than before (1, 2), a burst of comments
// turned into one interruption per comment (2), and a self-echo left unbounded
// (6). It also catches the two silences: comment ids compared as strings, which
// makes `"10446" < "9999"` true and swallows every new comment on a ticket past
// its 10,000th id (6b), and a status change routed to the issue's own agent
// instead of to the linked and parent agents that cannot see it (1). And it
// catches a rate-limit response that degrades to silence rather than to a
// slower poll, or that lets one deleted ticket's 404 pace the whole fleet (5).
//
// Seven sections, one per thing the ticket asks to be true:
//
//   1. a status change  — linked agents and the parent agent are told; the
//                         issue's OWN agent is not, and a second poll over the
//                         same state sends nothing
//   2. a new comment    — the same three, plus the issue's own agent, because a
//                         comment is the steering API
//   3. first sight      — an issue seen for the first time records its status
//                         and its whole comment history and notifies nobody
//   4. restart          — a new poller over the persisted state re-announces
//                         nothing, and news from the downtime is still news
//   5. rate limits      — the arithmetic, a 429 slowing the interval with a log
//                         line and never to silence, a 404 not slowing it, and
//                         recovery announced
//   6. repeats          — a comment attributable to nobody produces exactly one
//                         pointer and never a second. (Suppressing an agent's
//                         own comment is KAN-187's, and is proved in
//                         verify-jira-self-echo-suppression.mjs.)
//   7. --live           — real herdr panes, the real Jira API, a real status
//                         transition and a real comment
//
// Sections 1-6 drive the real JiraPoller, the real JiraPollState (a real file,
// fsync'd and renamed), the real snapshot parser fed real Jira response bodies,
// and the real `deliverToAgent` from nudge.ts. herdr is stubbed — but stubbed as
// a *pane*, with a composer and a scrollback, so delivery is confirmed the way
// production confirms it rather than against a boolean this script chose. Jira
// is stubbed at the one method the poller uses, so the response shapes are the
// only thing invented.
//
// Usage: node daemon/scripts/verify-jira-poller-nudges.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.
//
//        --live  additionally runs section 7 against the real world: three real
//                agents, two throwaway Jira issues, a real transition and a real
//                comment posted through the Jira REST API with the daemon's own
//                stored credential. Opt-in because it starts agents on the
//                machine you run it on and writes to a real Jira project.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
/** Leave the live panes standing, so the acceptance proof can tail them. */
const KEEP = args.includes('--keep');
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

const {
  JiraPoller,
  JiraPollState,
  jiraEventNudgeText,
  compareCommentIds,
  POLL_INTERVAL_MS,
  DEGRADED_POLL_INTERVAL_MS
} = await import(path.join(distDir, 'jira-poll.js'));
const { snapshotFrom } = await import(path.join(distDir, 'jira.js'));
const { deliveryFingerprint } = await import(path.join(distDir, 'nudge.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(52)} ${value}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan79-'));
let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++stateFiles}.json`);

// ------------------------------------------------------------- the harness --

const nameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

/**
 * A message as Claude Code echoes it once submitted: the same `❯` caret the
 * composer uses, hard-wrapped to the pane's width with the continuation
 * indented. Copied from a real 80-column pane (KAN-77, AC3).
 */
const wrap = (text) =>
  (text.match(/.{1,76}(\s|$)/g) ?? [text])
    .map((line, i) => (i === 0 ? `❯ ${line.trim()}` : `  ${line.trim()}`))
    .join('\n');

/**
 * A herdr whose agents have *panes*: a scrollback of what has been submitted
 * and a composer holding what has been typed but not sent. The distinction is
 * what `deliverToAgent` reads, so a nudge counted here is a nudge that landed
 * rather than one that was typed.
 */
function stubHerdr(running) {
  const alive = [...running];
  const panes = new Map();
  const sends = [];

  const paneFor = (agentName) => {
    if (!panes.has(agentName)) {
      panes.set(agentName, { scrollback: ['bypass permissions on'], composer: '' });
    }
    return panes.get(agentName);
  };

  const render = (pane) =>
    [
      ...pane.scrollback,
      '─'.repeat(80),
      `❯ ${pane.composer}`,
      '─'.repeat(80),
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
    ].join('\n');

  return {
    alive,
    sends,
    tailAgent: (key, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      return { success: true, text: render(paneFor(name)) };
    },
    sendToAgent: async (key, message, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      const pane = paneFor(name);
      sends.push({ agentName: name, message });
      pane.scrollback.push(wrap(message), '● Noted.');
      pane.composer = '';
      return { success: true };
    },
    /** Everything this pane actually received, as submitted output. */
    submitted: (agentName) => paneFor(agentName).scrollback.filter((l) => l.startsWith('❯ '))
  };
}

/**
 * A Jira response body in the shape the REST API actually returns for
 * `?fields=status,updated,comment,issuelinks`, so the real `snapshotFrom`
 * parser is what turns it into a snapshot.
 */
const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status, statusCategory: { key: 'indeterminate' } },
    updated: issue.updated ?? '2026-08-04T09:00:00.000-0700',
    comment: {
      comments: issue.comments.map((id) => ({
        id: String(id),
        author: { accountId: '712020:shared', displayName: 'Wroos Bit' },
        created: '2026-08-04T09:00:00.000-0700'
      })),
      total: issue.comments.length,
      maxResults: issue.comments.length,
      startAt: 0
    },
    issuelinks: (issue.links ?? []).map((linked) => ({
      id: '1',
      type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
      outwardIssue: { key: linked, fields: { status: { name: 'To Do' } } }
    }))
  }
});

/** Jira, stubbed at the one method the poller calls. */
function stubJira(issues) {
  const reads = [];
  /** key → { status?, backOff?, error? } to force a failure on the next read. */
  const failures = new Map();
  return {
    issues,
    reads,
    fail: (key, outcome) => failures.set(key, outcome),
    clearFailures: () => failures.clear(),
    pollIssue: async (key) => {
      reads.push(key);
      const forced = failures.get(key);
      if (forced) return { ok: false, ...forced };
      const issue = issues[key];
      if (!issue) return { ok: false, backOff: false, status: 404, error: 'issue does not exist' };
      return { ok: true, snapshot: snapshotFrom(key, jiraBody(key, issue)) };
    }
  };
}

/**
 * A poller wired to stubs, with the real state file and the real delivery.
 *
 * `confirmTimeoutMs` is short only so the proof runs in seconds; the code path
 * it exercises — send, read the pane back, require the message as submitted
 * output — is the production one.
 */
function newPoller({ jira, herdr, agents, parents = {}, stateFile, log = [], deliver }) {
  return new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents.filter((a) => herdr.alive.includes(a.agentName)),
    supervisorFor: (agentName) => parents[agentName] ?? null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(stateFile),
    confirmTimeoutMs: 400,
    confirmPollMs: 50,
    ...(deliver ? { deliver } : {})
  });
}

/** The cast used by most sections: a subject, a linked ticket, and a parent. */
function cast() {
  const agents = [
    { agentName: 'butchr-task-kan-79', type: 'task', key: 'KAN-79' },
    { agentName: 'butchr-task-kan-77', type: 'task', key: 'KAN-77' },
    { agentName: 'butchr-story-kan-75', type: 'story', key: 'KAN-75' }
  ];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    // KAN-79 is the subject; KAN-77 is linked to it; KAN-75 is nobody's link
    // but is the supervisor of record for KAN-79's agent.
    'KAN-79': { status: 'In Progress', comments: [10446], links: ['KAN-77', 'KAN-75'] },
    'KAN-77': { status: 'Done', comments: [10401], links: ['KAN-79'] },
    'KAN-75': { status: 'In Progress', comments: [], links: ['KAN-79'] }
  });
  const parents = { 'butchr-task-kan-79': { type: 'story', key: 'KAN-75' } };
  return { agents, herdr, jira, parents };
}

/** Who received a nudge about which issue, from the panes themselves. */
const received = (herdr, agents) =>
  agents.map((a) => `${a.type}/${a.key}: ${herdr.submitted(a.agentName).length}`).join('   ');

// ------------------------------------------------------ 1. a status change --

rule('AC1 — a status change: linked and parent agents are told, the issue\'s own agent is not');

{
  const { agents, herdr, jira, parents } = cast();
  const log = [];
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), log });

  // Tick one: nothing is news yet, because nothing has been seen before.
  const first = await poller.pollOnce();
  row('tick 1 — first sight of three issues', `${first.polled.length} read, ${first.events.length} event(s)`);

  // A human drags KAN-79 across the board.
  jira.issues['KAN-79'].status = 'In Review';
  const second = await poller.pollOnce();

  console.log('');
  row('tick 2 — KAN-79 In Progress → In Review', `${second.events.length} event(s), ${second.nudges.length} nudge(s)`);
  row('nudges landed on each pane', received(herdr, agents));
  console.log('');
  for (const nudge of second.nudges) {
    row(`  → ${nudge.type}/${nudge.key} (${nudge.relation})`, nudge.delivered ? 'delivered' : `NOT delivered: ${nudge.error}`);
  }

  const third = await poller.pollOnce();
  row('tick 3 — nothing has changed since', `${third.events.length} event(s), ${third.nudges.length} nudge(s)`);

  console.log('\n  what the linked agent\'s pane actually received:\n');
  for (const line of herdr.submitted('butchr-task-kan-77')) console.log(`    ${line}`);
  console.log('\n  what the parent agent\'s pane actually received:\n');
  for (const line of herdr.submitted('butchr-story-kan-75')) console.log(`    ${line}`);
  console.log('\n  what the issue\'s OWN agent received:');
  console.log(`    ${herdr.submitted('butchr-task-kan-79').length === 0 ? '(nothing — by design)' : herdr.submitted('butchr-task-kan-79').join('\n')}`);

  const linked = herdr.submitted('butchr-task-kan-77');
  const parent = herdr.submitted('butchr-story-kan-75');

  verdict(
    first.events.length === 0 &&
      second.events.length === 1 &&
      second.events[0].kind === 'status' &&
      second.events[0].to === 'In Review' &&
      second.nudges.length === 2 &&
      second.nudges.every((n) => n.delivered) &&
      linked.length === 1 &&
      parent.length === 1 &&
      linked[0].includes('KAN-79') &&
      linked[0].includes('In Review') &&
      herdr.submitted('butchr-task-kan-79').length === 0 &&
      third.events.length === 0,
    'one status change produced exactly one nudge to the linked agent and one to the ' +
      'parent, both naming KAN-79 and its new status, none to its own agent, and a ' +
      'second poll over the same state sent nothing.',
    'see the counts above — the status change reached the wrong set of agents, or reached them twice.'
  );
}

// --------------------------------------------------------- 2. a new comment --

rule('AC2 — a new comment: the same two, plus the issue\'s own agent');

{
  const { agents, herdr, jira, parents } = cast();
  const log = [];
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), log });

  await poller.pollOnce();

  // A human comments on KAN-79 while its agent is mid-turn.
  jira.issues['KAN-79'].comments.push(10499);
  const tick = await poller.pollOnce();

  console.log('');
  row('KAN-79 gains one comment', `${tick.events.length} event(s), ${tick.nudges.length} nudge(s)`);
  row('nudges landed on each pane', received(herdr, agents));
  console.log('');
  for (const nudge of tick.nudges) {
    row(`  → ${nudge.type}/${nudge.key} (${nudge.relation})`, nudge.delivered ? 'delivered' : `NOT delivered: ${nudge.error}`);
  }

  console.log('\n  the mid-turn agent\'s own pane — the gap this story exists to close:\n');
  for (const line of herdr.submitted('butchr-task-kan-79')) console.log(`    ${line}`);

  // Two more comments in one interval are one thing to go and read, not two
  // interruptions of the same agent.
  jira.issues['KAN-79'].comments.push(10500, 10501);
  const burst = await poller.pollOnce();
  console.log('');
  row('two more comments in one interval', `${burst.events.length} event(s) → ${burst.nudges.length} nudge(s)`);
  row('  the event the poller recognised', JSON.stringify(burst.events[0] ?? null));

  const quiet = await poller.pollOnce();
  row('a poll later, with nothing new', `${quiet.events.length} event(s)`);

  const own = herdr.submitted('butchr-task-kan-79');
  verdict(
    tick.events.length === 1 &&
      tick.events[0].kind === 'comment' &&
      tick.nudges.length === 3 &&
      tick.nudges.every((n) => n.delivered) &&
      new Set(tick.nudges.map((n) => n.relation)).size === 3 &&
      own.length === 2 &&
      burst.events.length === 1 &&
      burst.events[0].newComments === 2 &&
      quiet.events.length === 0,
    'a comment reached the issue\'s own agent, its linked agent and its parent — one ' +
      'nudge each — and a burst of two comments in one interval was one nudge, not two.',
    'the comment did not reach all three, or a burst produced a nudge per comment.'
  );
}

// ---------------------------------------------------------- 3. first sight --

rule('AC3 — an issue seen for the first time is recorded, not replayed');

{
  const agents = [{ agentName: 'butchr-task-kan-90', type: 'task', key: 'KAN-90' }];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    // A ticket with a life behind it: eleven comments and a status already Done.
    'KAN-90': {
      status: 'Done',
      comments: [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10011],
      links: []
    }
  });
  const stateFile = nextStateFile();
  const log = [];
  const poller = newPoller({ jira, herdr, agents, stateFile, log });

  const tick = await poller.pollOnce();
  console.log('');
  row('an issue with 11 comments and status Done', `${tick.events.length} event(s), ${tick.nudges.length} nudge(s)`);
  row('what the poller logged', log.find((l) => l.includes('first sight')) ?? '(nothing)');
  console.log(`\n  the state file it wrote:\n`);
  console.log(fs.readFileSync(stateFile, 'utf8').split('\n').map((l) => `    ${l}`).join('\n'));

  verdict(
    tick.events.length === 0 &&
      tick.nudges.length === 0 &&
      JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues['KAN-90'].maxCommentId === '10011',
    'a newly watched issue records its status and its whole comment history and ' +
      'notifies nobody — a fresh install is not a broadcast of history.',
    'the first sight of an issue produced nudges, or failed to record where it had got to.'
  );
}

// ------------------------------------------------------------- 4. a restart --

rule('AC4 — a daemon restart between events does not replay what was already sent');

{
  const { agents, herdr, jira, parents } = cast();
  const stateFile = nextStateFile();
  const logA = [];

  // ---- daemon run one -----------------------------------------------------
  const before = newPoller({ jira, herdr, agents, parents, stateFile, log: logA });
  await before.pollOnce();                       // first sight
  jira.issues['KAN-79'].status = 'In Review';
  jira.issues['KAN-79'].comments.push(10499);
  const announced = await before.pollOnce();     // both events, announced
  console.log('');
  row('run 1 — a status change and a comment', `${announced.events.length} event(s), ${announced.nudges.length} nudge(s)`);
  row('  panes after run 1', received(herdr, agents));
  console.log(`
    Two events, three nudges — not five. Since KAN-207 one issue's events are
    announced to a recipient together, so task/KAN-77 and story/KAN-75 each get
    one interruption carrying both facts, and task/KAN-79 gets the comment
    alone (an agent is never told its own ticket's status moved). What that
    section proves is unchanged: nothing here repeats after the restart.`);

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues['KAN-79'];
  row('  persisted for KAN-79', JSON.stringify(persisted));

  // ---- the daemon is down, and the world moves on -------------------------
  // Both halves matter and they pull in opposite directions, which is why they
  // are tested together. A poller that keeps no state passes "did not replay"
  // trivially — it stays silent — and fails here. A poller that replays passes
  // here and fails the `from` check below, because it would report the status
  // moving from `To Do` (run 1's starting point) rather than from `In Review`
  // (where run 1 left it).
  jira.issues['KAN-79'].status = 'Done';
  jira.issues['KAN-79'].comments.push(10502);

  // A whole new JiraPoller over a whole new JiraPollState, reading the file the
  // previous process left behind. Nothing is carried over in memory.
  const logB = [];
  const after = newPoller({ jira, herdr, agents, parents, stateFile, log: logB });
  const firstAfterRestart = await after.pollOnce();
  console.log('');
  row('run 2 — first poll after the restart', `${firstAfterRestart.events.length} event(s), ${firstAfterRestart.nudges.length} nudge(s)`);
  row('  the status event it reported', JSON.stringify(firstAfterRestart.events.find((e) => e.kind === 'status') ?? null));
  row('  panes after run 2', received(herdr, agents));
  console.log(`
    …reported as In Review → Done, not as To Do → Done: run 1's transition is
    not re-announced, and the transition made while the daemon was down is.`);

  // ---- and nothing repeats on the poll after that -------------------------
  const fresh = await after.pollOnce();
  console.log('');
  row('the next poll, with nothing new', `${fresh.events.length} event(s), ${fresh.nudges.length} nudge(s)`);
  row('  panes at the end', received(herdr, agents));

  // ---- a lost state file is silent, never a replay ------------------------
  fs.rmSync(stateFile);
  const logC = [];
  const wiped = newPoller({ jira, herdr, agents, parents, stateFile, log: logC });
  const afterWipe = await wiped.pollOnce();
  console.log('');
  row('and if the state file is lost entirely', `${afterWipe.events.length} event(s), ${afterWipe.nudges.length} nudge(s)`);

  console.log(`
  Note on the reading. "First poll after a restart initialises without
  notifying" is the rule for an issue the poller has never seen — which, once
  the state file survives the restart, a restarted daemon's issues are not.
  Discarding the state on boot would satisfy the sentence and make the file
  ornamental: nothing would then stop run 2 from re-announcing run 1's events.
  So state is persisted, consulted, and diffed; what run 2 must not do is
  repeat itself, and what it must still do is deliver the news from the gap.`);

  const restartStatus = firstAfterRestart.events.find((e) => e.kind === 'status');
  verdict(
    announced.events.length === 2 &&
      // Three interruptions for two events on one issue (KAN-207), where this
      // used to assert five. The recipient set is unchanged — what changed is
      // that two of them hear both facts once instead of twice.
      announced.nudges.length === 3 &&
      firstAfterRestart.events.length === 2 &&
      restartStatus?.from === 'In Review' &&
      restartStatus?.to === 'Done' &&
      firstAfterRestart.events.some((e) => e.kind === 'comment') &&
      fresh.events.length === 0 &&
      fresh.nudges.length === 0 &&
      afterWipe.events.length === 0,
    'a restart delivered exactly the news made while the daemon was down, measured ' +
      'from where run 1 left off rather than from the top, repeated none of run 1\'s ' +
      'events, and a lost state file re-initialises silently rather than replaying.',
    'the restart replayed already-notified events, or lost the ones made while it was down.'
  );
}

// ------------------------------------- 4b. recognition is recorded first --

rule('AC4b — the memory is on disk before the first nudge goes out, not after');

console.log(`
  The ordering is the storm guard, and it is only visible under a crash: a
  daemon killed between "nudge sent" and "state saved" comes back believing the
  event never happened and announces the whole tick again — "one event, one
  nudge, ever" broken by exactly the crash it exists to survive. So rather than
  simulating a kill, the delivery path is asked what it can see: at the moment
  the first nudge is handed to the delivery primitive, the state file on disk
  must already have been advanced past the event being announced.`);

{
  const { agents, herdr, jira, parents } = cast();
  const seenOnDisk = [];
  // Wraps the real primitive rather than replacing it: what is under test is
  // *when* the file was written, not whether the message lands.
  const { deliverToAgent } = await import(path.join(distDir, 'nudge.js'));
  const stateFile = nextStateFile();
  const spy = async (opts) => {
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues['KAN-79'];
    seenOnDisk.push(onDisk);
    return deliverToAgent(opts);
  };

  const poller = newPoller({ jira, herdr, agents, parents, stateFile, deliver: spy });
  await poller.pollOnce();
  jira.issues['KAN-79'].status = 'In Review';
  jira.issues['KAN-79'].comments.push(10499);
  const tick = await poller.pollOnce();

  console.log('');
  row('nudges sent this tick', String(tick.nudges.length));
  row('state on disk when nudge 1 was handed over', JSON.stringify(seenOnDisk[0] ?? null));
  row('  …its status already advanced?', String(seenOnDisk[0]?.status === 'In Review'));
  row('  …its comment id already advanced?', String(seenOnDisk[0]?.maxCommentId === '10499'));

  verdict(
    // Three since KAN-207 — one hand-over to the delivery primitive per
    // recipient rather than per event. The claim under test is about *when*
    // the file was written, not how many times.
    seenOnDisk.length === 3 &&
      seenOnDisk.every((s) => s?.status === 'In Review' && s?.maxCommentId === '10499'),
    'every nudge went out with the event already durable, so a crash mid-delivery ' +
      'loses a notification rather than repeating one.',
    'a nudge was sent before the event was recorded — a crash there would re-announce the tick.'
  );
}

// ---------------------------------------------------------- 5. rate limits --

rule('AC5 — the request arithmetic, and degrading to a slower poll rather than to silence');

console.log(`
  One GET per distinct issue with a live agent, per tick, issued one after
  another. KAN-79 states the ceiling as 19 task agents plus their supervisors,
  so 25 live agents is generous, and distinct issues is fewer still because two
  agents on one ticket share one read:

      25 issues × 1 GET ÷ ${POLL_INTERVAL_MS / 1000}s = ${(25 / (POLL_INTERVAL_MS / 60000)).toFixed(0)} requests/minute ≈ ${(25 / (POLL_INTERVAL_MS / 1000)).toFixed(2)} requests/second

  — one request every ${((POLL_INTERVAL_MS / 1000) / 25).toFixed(1)} seconds from one account, less than a human
  clicking around the Jira web UI generates from the same account. Atlassian
  publishes no fixed per-user ceiling for API-token REST access; it rate-limits
  dynamically and says so with a 429. So the estimate is why this is expected to
  be fine, and the back-off below is what makes being wrong survivable.`);

{
  const { agents, herdr, jira, parents } = cast();
  const log = [];
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), log });
  await poller.pollOnce();

  row('normal interval', `${POLL_INTERVAL_MS / 1000}s`);
  row('degraded interval', `${DEGRADED_POLL_INTERVAL_MS / 1000}s`);

  // A 404 on a renamed ticket: a real failure, and not one that should pace the
  // rest of the fleet.
  jira.fail('KAN-77', { backOff: false, status: 404, error: 'Issue does not exist or you do not have permission to see it.' });
  const notFound = await poller.pollOnce();
  console.log('');
  row('a 404 on one ticket — degraded?', String(notFound.degraded));

  // A 429 from Jira.
  jira.clearFailures();
  jira.fail('KAN-79', { backOff: true, status: 429, error: 'Rate limit exceeded' });
  const limited = await poller.pollOnce();
  row('a 429 — degraded?', String(limited.degraded));
  row('  the log line it produced', log.find((l) => l.includes('left alone')) ?? '(none)');

  // Still polling while degraded — the point of not degrading to silence.
  const whileDegraded = await poller.pollOnce();
  row('reads issued while degraded', String(whileDegraded.polled.length));

  jira.clearFailures();
  const recovered = await poller.pollOnce();
  row('Jira answers again — degraded?', String(recovered.degraded));
  row('  the log line it produced', log.find((l) => l.includes('answering again')) ?? '(none)');

  // A 5xx and an unreachable host are the same class as a 429.
  jira.fail('KAN-79', { backOff: true, status: 503, error: 'Service Unavailable' });
  const fiveHundred = await poller.pollOnce();
  row('a 503 — degraded?', String(fiveHundred.degraded));

  verdict(
    notFound.degraded === false &&
      limited.degraded === true &&
      whileDegraded.polled.length === 3 &&
      recovered.degraded === false &&
      fiveHundred.degraded === true &&
      log.some((l) => l.includes('left alone')) &&
      log.some((l) => l.includes('answering again')),
    'a 429 or a 5xx slows the poll and says so, a 404 does not, the poller keeps ' +
      'polling while degraded, and recovery is announced.',
    'the back-off did not fire, fired on the wrong evidence, or went quiet instead of slow.'
  );
}

// ----------------------------------------------------- 6. the self-echo limit --

rule('AC6 — the event memory bounds a repeat to zero, whoever wrote the comment');

console.log(`
  Every agent reaches Jira through the same shared Atlassian account, so a
  comment's author reads "somebody in this fleet" and never which agent. There
  is no authorship signal *in Jira* to suppress an agent's own actions with.
  Suppression here is event-based instead: an event is remembered the first time
  it is seen and never nudges twice.

  KAN-75 accepted the limit that leaves — an agent that comments on its own
  ticket is told once about its own comment — and this section is where that
  bound of exactly one is asserted. KAN-187 has since closed the limit itself:
  the poller now takes authorship from the authoring agent's own transcript and
  declines to interrupt an author about its own text at all.

  This section deliberately runs WITHOUT that authorship source, which is what
  makes it still the right test of *this* module: the poller's own memory has to
  bound the repeat on its own, for the comments it cannot attribute to anybody —
  a human's, or one written before the daemon was watching. The suppression
  itself is proved in verify-jira-self-echo-suppression.mjs, both legs.`);

{
  const { agents, herdr, jira, parents } = cast();
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile() });
  await poller.pollOnce();

  // task/KAN-79's own agent posts a progress comment on KAN-79.
  jira.issues['KAN-79'].comments.push(10600);
  const echo = await poller.pollOnce();
  const afterOne = herdr.submitted('butchr-task-kan-79').length;
  const laterTicks = [await poller.pollOnce(), await poller.pollOnce(), await poller.pollOnce()];
  const afterFour = herdr.submitted('butchr-task-kan-79').length;

  console.log('');
  row('a comment appears, attributable to nobody', `${echo.events.length} event(s)`);
  row('pointers the issue\'s own agent received', String(afterOne));
  row('after three more polls', String(afterFour));
  row('  events on those three polls', laterTicks.map((t) => t.events.length).join(', '));

  const message = jiraEventNudgeText({ key: 'KAN-79', kind: 'comment', newComments: 1 }, 'own');
  console.log(`\n  the words it received:\n\n    ${message}`);
  console.log(`\n  (the first 60 characters, which is what the delivery check matches on:`);
  console.log(`   "${deliveryFingerprint(message)}")`);
  console.log(`\n  Note that it is a pointer: the comment's text is nowhere in it, and`);
  console.log(`  nothing in the message asks the recipient to do anything.`);

  verdict(
    afterOne === 1 && afterFour === 1 && laterTicks.every((t) => t.events.length === 0) &&
      !message.includes('\n') && message.includes('KAN-79') && message.includes('not an instruction'),
    'exactly one pointer, never a second, and the pointer carries no ticket content.',
    'the repeat was unbounded, or the nudge carried content instead of a pointer.'
  );
}

// -------------------------------------------------------- comment id ordering --

rule('AC6b — comment ids compare as numbers, because Jira\'s are numbers');

{
  const asStrings = ['10446', '9999'].sort();
  console.log('');
  row('"10446" vs "9999" as strings', `${asStrings[0]} < ${asStrings[1]} → 10446 would look older`);
  row('compareCommentIds("10446", "9999")', String(compareCommentIds('10446', '9999')));
  row('compareCommentIds("9999", "10446")', String(compareCommentIds('9999', '10446')));
  row('compareCommentIds("10446", "10446")', String(compareCommentIds('10446', '10446')));

  verdict(
    compareCommentIds('10446', '9999') > 0 &&
      compareCommentIds('9999', '10446') < 0 &&
      compareCommentIds('10446', '10446') === 0,
    'a five-digit comment id is newer than a four-digit one, which a string ' +
      'comparison gets backwards and would use to swallow every new comment.',
    'comment ids are being compared as strings.'
  );
}

// ------------------------------------------------------- 7. the timer loop --

rule('AC7 — the loop schedules itself, and a slow tick does not overlap the next');

{
  const { agents, herdr, jira, parents } = cast();
  const log = [];
  const poller = new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents,
    supervisorFor: (name) => parents[name] ?? null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(nextStateFile()),
    intervalMs: 120,
    degradedIntervalMs: 400,
    confirmTimeoutMs: 200,
    confirmPollMs: 20
  });

  poller.start();
  // Three intervals of a 120ms loop. The first tick is one interval away by
  // design, so this is the scheduled path and nothing else.
  await new Promise((r) => setTimeout(r, 500));
  const readsBeforeChange = jira.reads.length;
  jira.issues['KAN-79'].status = 'Blocked';
  await new Promise((r) => setTimeout(r, 300));
  poller.stop();
  const readsAtStop = jira.reads.length;
  await new Promise((r) => setTimeout(r, 300));

  console.log('');
  row('reads issued by the scheduled loop', String(readsBeforeChange));
  row('a status change picked up without a manual tick', String(herdr.submitted('butchr-task-kan-77').length));
  row('reads after stop(), 300ms later', `${jira.reads.length} (was ${readsAtStop} at stop)`);
  row('the line it logged on start', log.find((l) => l.includes('watching live-agent issues')) ?? '(none)');

  verdict(
    readsBeforeChange >= 3 &&
      herdr.submitted('butchr-task-kan-77').length === 1 &&
      jira.reads.length === readsAtStop,
    'the poller ticks on its own schedule, delivers without being driven by hand, ' +
      'and stops when it is told to.',
    'the scheduled loop did not tick, did not deliver, or kept ticking after stop().'
  );
}

// -------------------------------------------------------- 8. the live proof --

if (LIVE) {
  rule('AC8 (--live) — real panes, the real Jira API, a real transition and a real comment');

  const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
  const { JiraIssueTypeService, TokenJiraTransport } = await import(path.join(distDir, 'jira.js'));
  const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));
  const { waitForAgentReady } = await import(path.join(distDir, 'nudge.js'));

  // The two throwaway issues and the supervisor are supplied by the caller,
  // because creating Jira issues is a write and this script does not make them:
  // it is handed keys that already exist, linked, with the panes to match.
  const SUBJECT = process.env.KAN79_SUBJECT;
  const LINKED = process.env.KAN79_LINKED;
  const PARENT = process.env.KAN79_PARENT;
  if (!SUBJECT || !LINKED || !PARENT) {
    console.log(`
  --live needs three Jira keys in the environment, and does not invent them:

      KAN79_SUBJECT=KAN-nn   the ticket that changes
      KAN79_LINKED=KAN-nn    a ticket linked to it, with its own agent
      KAN79_PARENT=KAN-nn    the supervisor of record for the subject's agent

  Create and link them yourself, so the proof never writes to a board on its
  own initiative. This script starts one inert agent per key, polls the real
  Jira API with the daemon's stored credential, and prints the panes.`);
    process.exitCode = 1;
  } else {
    const AGENTS = [
      { type: 'task', key: SUBJECT, agentName: nameFor('task', SUBJECT) },
      { type: 'task', key: LINKED, agentName: nameFor('task', LINKED) },
      { type: 'story', key: PARENT, agentName: nameFor('story', PARENT) }
    ];

    const INERT =
      'You are a stand-in pane for a Butchr proof run (KAN-79). Do nothing at all: ' +
      'no tools, no files, no messages to anyone, no tickets. If text arrives in this ' +
      'pane, acknowledge it in one short sentence and take no other action. ' +
      'This pane is closed automatically within a few minutes.';

    const bridge = new HerdrBridge();
    const jira = new JiraIssueTypeService(new CredentialStore());
    const log = [];
    const stateFile = nextStateFile();

    const poller = new JiraPoller({
      jira,
      herdrBridge: bridge,
      // Narrowed to this proof's three agents: the machine's real fleet is not
      // this script's to interrupt.
      liveAgents: () => AGENTS.filter((a) => aliveNames().has(a.agentName)),
      supervisorFor: (agentName) =>
        agentName === AGENTS[0].agentName ? { type: 'story', key: PARENT } : null,
      log: (...a) => {
        const line = a.join(' ');
        log.push(line);
        console.log(`    ${line}`);
      },
      state: new JiraPollState(stateFile)
    });

    const aliveNames = () => new Set(bridge.listHerdrAgents().map((a) => a.name));
    const workspaces = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');

    try {
      console.log('\n  starting three real agents…\n');
      for (const agent of AGENTS) {
        bridge.spawnSession(agent.type, agent.key, undefined, INERT, 'claude', {});
      }
      const ready = await Promise.all(
        AGENTS.map((a) => waitForAgentReady(bridge, a.key, a.type))
      );
      row('all three panes reached a prompt', ready.every(Boolean) ? 'yes' : 'NO — see the tails');

      console.log('\n  poll 1 — first sight, against the real Jira API:\n');
      const first = await poller.pollOnce();
      row('issues read', first.polled.join(', ') || '(none)');
      row('events', String(first.events.length));

      // The changes are made by a human or an agent with write access, in Jira,
      // while this loop is running — never by this script, which holds the
      // daemon's read-only credential and would not be able to write if it
      // wanted to. The loop is the proof: it polls on the real interval and the
      // tick that catches a change is the "within one poll interval" claim.
      const intervalMs = Number(process.env.KAN79_LIVE_INTERVAL_MS ?? 20_000);
      const deadline = Date.now() + Number(process.env.KAN79_LIVE_TIMEOUT_MS ?? 300_000);
      console.log(`
  Make the two changes on ${SUBJECT} in Jira now — a status transition and a
  comment. This loop polls every ${intervalMs / 1000}s and reports the tick that catches them.
`);

      const seen = [];
      let second = { events: [], nudges: [] };
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const tick = await poller.pollOnce();
        row(`poll at +${Math.round((Date.now() - (deadline - Number(process.env.KAN79_LIVE_TIMEOUT_MS ?? 300_000))) / 1000)}s`,
          `${tick.events.length} event(s), ${tick.nudges.length} nudge(s)`);
        if (!tick.events.length) continue;
        seen.push(...tick.events);
        second = {
          events: [...second.events, ...tick.events],
          nudges: [...second.nudges, ...tick.nudges]
        };
        for (const nudge of tick.nudges) {
          row(`  → ${nudge.type}/${nudge.key} (${nudge.relation})`, nudge.delivered ? 'delivered' : `NOT: ${nudge.error}`);
        }
        // Both kinds seen: the ticket asks for a status transition and a
        // comment, and there is nothing more to wait for.
        if (seen.some((e) => e.kind === 'status') && seen.some((e) => e.kind === 'comment')) break;
      }
      console.log('');
      row('events caught by the live loop', JSON.stringify(second.events));

      for (const agent of AGENTS) {
        const tail = bridge.tailAgent(agent.key, agent.type, 40);
        console.log(`\n  ${agent.agentName}'s real terminal:\n`);
        console.log((tail.text ?? tail.error ?? '(no output)').split('\n').map((l) => `    ${l}`).join('\n'));
      }

      const third = await poller.pollOnce();
      console.log('');
      row('poll 3 — same state', `${third.events.length} event(s)`);

      verdict(
        second.events.some((e) => e.kind === 'status') &&
          second.events.some((e) => e.kind === 'comment') &&
          second.nudges.some((n) => n.delivered) &&
          third.events.length === 0,
        'a real status transition and a real comment each reached real terminals ' +
          'within one poll interval, and did not repeat on the next poll.',
        'the live poll missed one of the two changes, delivered nothing, or repeated itself.'
      );
    } finally {
      if (KEEP) {
        console.log(`\n  --keep: leaving the three panes open so they can be tailed.`);
        fs.rmSync(TMP, { recursive: true, force: true });
        console.log(`\n== ${process.exitCode ? 'FAILURES ABOVE' : 'all sections passed'} ==`);
        process.exit(process.exitCode ?? 0);
      }
      const alive = aliveNames();
      for (const agent of AGENTS) {
        if (alive.has(agent.agentName)) {
          try { bridge.closeAgentByKey(agent.key, agent.type); } catch {}
        }
        try {
          fs.rmSync(path.join(workspaces, agent.type, agent.key.toLowerCase()), {
            recursive: true, force: true
          });
        } catch {}
      }
      console.log('\n  proof panes closed and their workspaces removed.');
    }
  }
}

// --------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${process.exitCode ? 'FAILURES ABOVE' : 'all sections passed'} ==`);
