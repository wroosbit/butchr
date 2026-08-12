// Proof for KAN-207: one ticket's status change and its new comment, seen in
// the same tick, reach a recipient as ONE interruption — and two events on two
// different tickets still reach it as two.
//
// WHAT FAILURE THIS WOULD CATCH: a coalescer that merges news it should not.
// The defect this ticket names — two `sendToAgent` calls 1.2 seconds apart for
// one hand-off — is a volume problem, and volume problems have a fix that is
// trivially too strong. Every failure mode here is therefore a *silence*, not a
// duplicate: two tickets collapsed into one pointer so the reader is sent to
// one of them and never learns about the other (section 2); a comment folded
// into a status pointer for the issue's own agent, which is not a target of
// status events at all, so a steer arrives labelled as the transition the agent
// itself just made (section 3a); a per-recipient authorship suppression lost
// when the events are handled as a group, so an agent is either muted about a
// supervisor's steer or told about its own comment again (3b, 3c); and the
// tick's memory advanced or not advanced by the grouping, which would either
// replay the hand-off forever or swallow the half that failed to deliver (4).
//
// CI-RUNNABLE: partial — the coalescing assertions run in CI. The CONTROL leg
// needs an `--unfixed` build to show the defect it prevents, and AC3d needs
// `--live`; both are skipped without them and both are named in the run
// output.
//
// Sections:
//
//   0. CONTROL     — the pre-fix daemon, same scenario, showing the two
//                    back-to-back interruptions. Needs `--unfixed <dir>`.
//   1. hand-off    — the exact production sequence: an agent comments on its
//                    own ticket and transitions it, one tick sees both. The
//                    supervisor and the linked agent each get ONE message
//                    naming both facts; the agent that did it gets nothing.
//   2. two tickets — two events on two different issues in one tick still
//                    produce two interruptions, with two distinct delivery
//                    fingerprints, because they are two things to go and read.
//   3. asymmetries — what coalescing must not flatten: the issue's own agent
//                    still never hears its own status (a), a partial authorship
//                    suppression still leaves the rest (b), and an agent that
//                    wrote every comment still hears the transition (c). Then
//                    (d) the board parent from KAN-230, which is the relation a
//                    hand-off most needs to reach and which every other section
//                    here passes without exercising.
//   4. memory      — the grouping is between recognition and delivery and
//                    touches neither: the state file is advanced past both
//                    events before the first send, the next tick is silent, and
//                    a restart over that file re-announces nothing.
//   5. --live      — both claims against ONE REAL Claude Code terminal, driven
//                    by the real HerdrBridge and the real `deliverToAgent`, so
//                    "one interruption" is counted as one real Ctrl+C and one
//                    submitted line rather than as a stub's array entry.
//
// WHAT IS REAL HERE, AND WHERE THIS PROOF SUPPLIES ITS OWN INPUT
//
// Real: the JiraPoller, the JiraPollState on a real fsync'd file, the real
// `snapshotFrom` parser over real-shaped Jira response bodies, the real
// CommentAuthorship parser, and the real `deliverToAgent` — which is confirmed
// against a *pane* with a scrollback and a composer, so a nudge counted here is
// one that landed rather than one that was typed.
//
// Supplied by this script: the Jira events themselves, and the transcript
// records that attribute a comment to an agent. **So what sections 1-4 cannot
// prove is that a real hand-off puts both events in one real tick.** They prove
// what the poller does when it does. That leg is covered in two places and
// neither is this file: `verify-jira-poller-nudges.mjs --live` polls the real
// Jira API through a real transition and a real comment, and the production
// `~/.local/share/butchr/daemon.log` records the pairs directly — 85 of them in
// the four days to 2026-08-08, of which 54 landed inside one tick. The PR body
// pastes that tally and the log lines it came from. Section 5 closes the other
// half — that one message is one real interruption — against real panes.
//
// Usage:
//   cd daemon && npm ci && npm run build
//   node scripts/verify-jira-nudge-coalescing.mjs
//
//   # section 0's baseline: origin/main's jira-poll.ts, everything else
//   # current, built where node_modules still resolves
//   cp src/jira-poll.ts /tmp/kan207-jira-poll-fixed.ts
//   git show $(git merge-base HEAD origin/main):daemon/src/jira-poll.ts > src/jira-poll.ts
//   npx tsc --outDir dist-unfixed
//   cp /tmp/kan207-jira-poll-fixed.ts src/jira-poll.ts
//   node scripts/verify-jira-nudge-coalescing.mjs dist --unfixed dist-unfixed
//
//   # THE RED. The whole proof pointed at the unfixed build: sections 1 and 4
//   # fail and it exits 1. Sections 2 and 3 stay GREEN there, deliberately, and
//   # it is worth reading why rather than treating it as a gap: those are the
//   # over-reach guards, and a daemon that has not coalesced at all cannot
//   # over-reach. A run where every section went red would mean the assertions
//   # were measuring which build was loaded rather than what it did.
//   node scripts/verify-jira-nudge-coalescing.mjs dist-unfixed
//
//   --live  additionally runs section 5, which starts two real inert agents on
//           this machine and types at their real terminals. Opt-in. They run as
//           the `probe` workspace type deliberately — see THE WINDOW in that
//           section before changing it.
//   --keep  leave the live panes standing so they can be tailed.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const KEEP = argv.includes('--keep');

const unfixedAt = argv.indexOf('--unfixed');
const UNFIXED_DIR = unfixedAt === -1 ? null : argv[unfixedAt + 1];
// `unfixedAt + 1` is the directory `--unfixed` consumes — but only when the
// flag is actually present. Guarding on -1 is not pedantry: without it the
// index works out to 0 and the *first positional* is silently swallowed, so
// `verify-… dist-unfixed` loads `../dist` and reports the fixed daemon's
// behaviour under the unfixed build's name. That is this proof lying about
// which build it ran, which is the one failure a proof must not have, and it
// is how the first run of the red demonstration came back green.
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !(unfixedAt !== -1 && i === unfixedAt + 1)
);
const distDir = positional[0] ?? path.join(scriptDir, '..', 'dist');

const { JiraPoller, JiraPollState } = await import(
  path.join(path.resolve(distDir), 'jira-poll.js')
);
const { CommentAuthorship } = await import(path.join(path.resolve(distDir), 'comment-authorship.js'));
const { snapshotFrom } = await import(path.join(path.resolve(distDir), 'jira.js'));
const { deliveryFingerprint } = await import(path.join(path.resolve(distDir), 'nudge.js'));
const { deliverToAgent } = await import(path.join(path.resolve(distDir), 'nudge.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(54)} ${value}`);

/**
 * The events one nudge carried.
 *
 * Reads `.events` (this branch) and falls back to `.event` (origin/main's
 * shape) so that pointing the whole proof at an unfixed build produces failed
 * *verdicts* rather than a TypeError on the first section. A crash is red too,
 * but it is the wrong red: it stops the run and reads as a broken script rather
 * than as a missing fix, and it bypasses the accumulated verdict this script
 * exits on.
 */
const eventsOf = (nudge) => nudge?.events ?? (nudge?.event ? [nudge.event] : []);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan207-'));
let files = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++files}.json`);

// ------------------------------------------------------------- the harness --

const nameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

/** A submitted message as Claude Code echoes it, hard-wrapped to 80 columns. */
const wrap = (text) =>
  (text.match(/.{1,76}(\s|$)/g) ?? [text])
    .map((line, i) => (i === 0 ? `❯ ${line.trim()}` : `  ${line.trim()}`))
    .join('\n');

/**
 * A herdr whose agents have panes: a scrollback of what has been submitted and
 * a composer holding what has been typed but not sent. `deliverToAgent` reads
 * the difference, so a message counted here is one that landed.
 *
 * `sends` is the other half of the count and the one this ticket is about: an
 * *interruption* is a `sendToAgent` call, because that is what opens with the
 * Ctrl+C. A fix that merged the text but still called send twice would leave
 * `submitted` looking right and `sends` telling the truth.
 */
function stubHerdr(running) {
  const alive = [...running];
  const panes = new Map();
  const sends = [];

  const paneFor = (agentName) => {
    if (!panes.has(agentName)) panes.set(agentName, { scrollback: ['bypass permissions on'] });
    return panes.get(agentName);
  };
  const render = (pane) =>
    [...pane.scrollback, '─'.repeat(80), '❯ ', '  ⏵⏵ bypass permissions on · ← for agents'].join('\n');

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
      sends.push({ agentName: name, message });
      paneFor(name).scrollback.push(wrap(message), '● Noted.');
      return { success: true };
    },
    /** Everything this pane received as submitted output. */
    submitted: (agentName) => paneFor(agentName).scrollback.filter((l) => l.startsWith('❯ ')),
    /** How many times the daemon typed at this pane at all. */
    interruptions: (agentName) => sends.filter((s) => s.agentName === agentName).length
  };
}

/** A Jira body in the shape the REST API returns for the poller's field list. */
const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status, statusCategory: { key: 'indeterminate' } },
    updated: '2026-08-08T09:00:00.000-0700',
    comment: {
      comments: issue.comments.map((id) => ({
        id: String(id),
        // The shared account, spelled as Jira really spells it: every comment in
        // this fleet carries this and only this.
        author: { accountId: '712020:619ec5ec-2e92-492f-8979-91ccda318230', displayName: 'Wroos Bit' },
        created: '2026-08-08T09:00:00.000-0700'
      })),
      total: issue.comments.length
    },
    issuelinks: (issue.links ?? []).map((linked) => ({
      id: '1',
      type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
      outwardIssue: { key: linked }
    })),
    // The board parent, in the shape the REST API returns it and the shape the
    // real `snapshotFrom` reads (`fields.parent.key`). Absent unless a section
    // asks for one, which is the ordinary case for an epic.
    ...(issue.parent
      ? { parent: { id: '10048', key: issue.parent, fields: { issuetype: { name: 'Epic' } } } }
      : {})
  }
});

function stubJira(issues) {
  return {
    issues,
    pollIssue: async (key) => {
      const issue = issues[key];
      if (!issue) return { ok: false, backOff: false, status: 404, error: 'no such issue' };
      return { ok: true, snapshot: snapshotFrom(key, jiraBody(key, issue)) };
    }
  };
}

/** Transcript records in the shape Claude Code writes them, one root per section. */
let tapes = 0;
function transcripts() {
  const root = path.join(TMP, `transcripts-${++tapes}`);
  const dirFor = (agent) => path.join(root, `${agent.type}-${agent.key}`.toLowerCase());
  let toolCalls = 0;

  return {
    dirFor,
    /** Record that `agent` posted comment `commentId` on `issueKey`. */
    wroteComment(agent, issueKey, commentId) {
      const toolUseId = `toolu_kan207_${++toolCalls}`;
      const dir = dirFor(agent);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'session.jsonl'),
        [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: toolUseId,
                  name: 'mcp__atlassian__addCommentToJiraIssue',
                  input: { issueIdOrKey: issueKey, commentBody: '## Handing off\n\nPR is open.' }
                }
              ]
            }
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        self: `https://api.atlassian.com/ex/jira/c4c5/rest/api/3/issue/10216/comment/${commentId}`,
                        id: String(commentId),
                        created: '2026-08-08T09:00:00.000-0700'
                      })
                    }
                  ]
                }
              ]
            }
          }
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n'
      );
    }
  };
}

function newPoller(Poller, { jira, herdr, agents, parents = {}, stateFile, authorship, log = [], deliver }) {
  return new Poller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents.filter((a) => herdr.alive.includes(a.agentName)),
    supervisorFor: (agentName) => parents[agentName] ?? null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(stateFile),
    confirmTimeoutMs: 400,
    confirmPollMs: 50,
    ...(authorship ? { authorship } : {}),
    // KAN-301 made this seam's default a REFUSAL rather than the composer, so a
    // harness that reads delivery off a pane now has to ask for the composer by
    // name. Deliberate, not a red made to go away: this proof counts
    // INTERRUPTIONS PER RECIPIENT, and it can only count them on a carrier that
    // leaves a mark on a pane. Production rides the channel;
    // `verify-notifications-never-type.mjs` §1b asserts that this injection has
    // no counterpart in `daemon/src`. The coalescing it proves is unchanged by
    // the carrier and still matters: KAN-219 measured one channel event and
    // explicitly declined to say anything about a burst.
    deliver: deliver ?? deliverToAgent
  });
}

/**
 * The cast, which is the fleet shape the ticket's log excerpt came from: a task
 * agent, the supervisor that staffed it, and a linked task with its own agent.
 */
function cast() {
  const subject = { agentName: nameFor('task', 'KAN-900'), type: 'task', key: 'KAN-900' };
  const linked = { agentName: nameFor('task', 'KAN-901'), type: 'task', key: 'KAN-901' };
  const parent = { agentName: nameFor('epic', 'KAN-902'), type: 'epic', key: 'KAN-902' };
  const agents = [subject, linked, parent];
  return {
    subject,
    linked,
    parent,
    agents,
    herdr: stubHerdr(agents.map((a) => a.agentName)),
    jira: stubJira({
      'KAN-900': { status: 'In Progress', comments: [5000], links: ['KAN-901'] },
      'KAN-901': { status: 'In Progress', comments: [], links: ['KAN-900'] },
      'KAN-902': { status: 'In Progress', comments: [], links: [] }
    }),
    parents: { [subject.agentName]: { type: 'epic', key: 'KAN-902' } }
  };
}

const newAuthorship = (Authorship, tape) =>
  new Authorship({ transcriptDirFor: (agent) => tape.dirFor(agent), log: () => {} });

/** The hand-off itself: the agent comments on its own ticket, then moves it. */
function handOff(jira, tape, subject, commentId = 5001) {
  tape.wroteComment(subject, 'KAN-900', commentId);
  jira.issues['KAN-900'].comments.push(commentId);
  jira.issues['KAN-900'].status = 'In Review';
}

// ------------------------------------------------------------ 0. the control --

let controlInterruptions = null;

if (UNFIXED_DIR) {
  rule("CONTROL — the pre-fix daemon: one hand-off, two Ctrl+Cs at one supervisor");

  console.log(`
  Not a description of the defect — the defect, run. This section imports
  JiraPoller from a build of origin/main's jira-poll.ts and drives it through
  the same hand-off every section below uses. Everything else in that build is
  current, so the only difference on screen is the one under test.`);

  const unfixed = path.resolve(UNFIXED_DIR);
  const { JiraPoller: UnfixedPoller } = await import(path.join(unfixed, 'jira-poll.js'));
  const { CommentAuthorship: UnfixedAuthorship } = await import(
    path.join(unfixed, 'comment-authorship.js')
  );

  const { subject, linked, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const log = [];
  const poller = newPoller(UnfixedPoller, {
    jira, herdr, agents, parents,
    stateFile: nextStateFile(),
    authorship: newAuthorship(UnfixedAuthorship, tape),
    log
  });

  await poller.pollOnce(); // first sight
  handOff(jira, tape, subject);
  const tick = await poller.pollOnce();

  controlInterruptions = herdr.interruptions(parent.agentName);

  console.log('');
  row('events recognised on KAN-900 this tick', tick.events.map((e) => e.kind).join(' + '));
  row('sendToAgent calls at epic/KAN-902', String(controlInterruptions));
  row('sendToAgent calls at task/KAN-901 (linked)', String(herdr.interruptions(linked.agentName)));
  console.log('\n  what the supervisor actually received — twice, for one hand-off:\n');
  for (const line of herdr.submitted(parent.agentName)) console.log(`    ${line}`);
  console.log('\n  and the poller\'s own log for it:\n');
  for (const line of log.filter((l) => l.includes('telling'))) console.log(`    ${line}`);

  console.log(`
  Two sends, back to back, to a supervisor that wrote neither the comment nor
  the transition. Both are legitimate news — which is why the answer is not
  suppression — and every prompt in prompts/ forbids an *agent* to do this:
  "never send two nudges in a row to the same agent — the second kills its
  session, and the first already cost it its in-flight work."`);

  verdict(
    controlInterruptions === 2 && herdr.interruptions(linked.agentName) === 2,
    'the pre-fix behaviour is reproduced: one hand-off, two interruptions each at ' +
      'the supervisor and at the linked agent. Everything below is measured against this.',
    'the control did not reproduce the defect, so nothing below is evidence of fixing it.'
  );
} else {
  rule('CONTROL — skipped: no --unfixed build supplied');
  console.log(`
  Section 0 reproduces the defect against a build of origin/main's
  jira-poll.ts and is skipped without one. The header has the four commands
  that produce it. Skipping it costs the baseline, not the assertions: the
  sections below still fail against a daemon that does not coalesce, and
  running this whole script against the unfixed dist is the other way to see
  that happen.`);
}

// -------------------------------------------------------------- 1. hand-off --

rule('AC3a — one hand-off (a comment and a transition) is ONE interruption per recipient');

console.log(`
  The production sequence, unedited: a task agent posts its hand-off comment on
  its own ticket and transitions it to In Review. Both land inside one poll
  interval, so one tick recognises two events on one issue.`);

{
  const { subject, linked, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const log = [];
  const poller = newPoller(JiraPoller, {
    jira, herdr, agents, parents,
    stateFile: nextStateFile(),
    authorship: newAuthorship(CommentAuthorship, tape),
    log
  });

  await poller.pollOnce();
  handOff(jira, tape, subject);
  const tick = await poller.pollOnce();

  const toParent = tick.nudges.find((n) => n.agentName === parent.agentName);

  console.log('');
  row('events recognised on KAN-900 this tick', tick.events.map((e) => e.kind).join(' + '));
  row('interruptions at epic/KAN-902 (parent)', String(herdr.interruptions(parent.agentName)));
  row('  (the control, pre-fix)', controlInterruptions === null ? '(not run)' : String(controlInterruptions));
  row('interruptions at task/KAN-901 (linked)', String(herdr.interruptions(linked.agentName)));
  row('interruptions at task/KAN-900 (it did both)', String(herdr.interruptions(subject.agentName)));
  console.log('');
  row('the events the supervisor was told', JSON.stringify(eventsOf(toParent).map((e) => e.kind)));
  console.log('\n  the single message it received:\n');
  for (const line of herdr.submitted(parent.agentName)) console.log(`    ${line}`);

  console.log(`
  Read the third row with the first two. The agent that made both changes is
  interrupted for neither: the status is its own (KAN-79's asymmetry) and the
  comment is its own (KAN-187's suppression). Coalescing sits underneath both
  and changes neither — what it changes is that the two agents who ARE owed the
  news get it in one sentence instead of two Ctrl+Cs.`);

  const message = herdr.submitted(parent.agentName)[0] ?? '';
  verdict(
    tick.events.length === 2 &&
      herdr.interruptions(parent.agentName) === 1 &&
      herdr.interruptions(linked.agentName) === 1 &&
      herdr.interruptions(subject.agentName) === 0 &&
      eventsOf(toParent).length === 2 &&
      tick.nudges.length === 2 &&
      message.includes('In Review') &&
      message.includes('new comment') &&
      message.includes('KAN-900'),
    'one hand-off produced one interruption at each of the two agents owed it, ' +
      'carrying both facts, and none at the agent that caused it.',
    'the hand-off still cost two interruptions, or one of the two facts was dropped to get to one.'
  );
}

// ---------------------------------------------------------- 2. two tickets --

rule('AC3b — two events on two DIFFERENT issues are still two interruptions');

console.log(`
  The over-reach guard, and the reason this fix is scoped "per issue" rather
  than "per recipient per tick". A supervisor with two children is owed two
  pointers when both move: they are two tickets to go and read, and a merged
  notice would send the reader to one of them and leave the other unopened —
  news lost to a fix aimed at volume. The two messages must also stay tellable
  apart by the delivery check, which matches on the first sixty characters.`);

{
  const parent = { agentName: nameFor('epic', 'KAN-902'), type: 'epic', key: 'KAN-902' };
  const childA = { agentName: nameFor('task', 'KAN-900'), type: 'task', key: 'KAN-900' };
  const childB = { agentName: nameFor('task', 'KAN-903'), type: 'task', key: 'KAN-903' };
  const agents = [parent, childA, childB];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    'KAN-900': { status: 'In Progress', comments: [5000], links: [] },
    'KAN-903': { status: 'In Progress', comments: [6000], links: [] },
    'KAN-902': { status: 'In Progress', comments: [], links: [] }
  });
  const parents = {
    [childA.agentName]: { type: 'epic', key: 'KAN-902' },
    [childB.agentName]: { type: 'epic', key: 'KAN-902' }
  };

  const poller = newPoller(JiraPoller, { jira, herdr, agents, parents, stateFile: nextStateFile() });
  await poller.pollOnce();

  // Both children move in the same interval, on two different tickets.
  jira.issues['KAN-900'].status = 'In Review';
  jira.issues['KAN-903'].comments.push(6001);
  const tick = await poller.pollOnce();

  const messages = herdr.submitted(parent.agentName);
  // Fingerprinted from the bytes that were really sent rather than from a
  // re-render, so this measures what the delivery check would have seen.
  const fingerprints = new Set(
    herdr.sends
      .filter((s) => s.agentName === parent.agentName)
      .map((s) => deliveryFingerprint(s.message))
  );

  console.log('');
  row('issues that changed this tick', tick.events.map((e) => `${e.key}:${e.kind}`).join(', '));
  row('interruptions at epic/KAN-902', String(herdr.interruptions(parent.agentName)));
  row('distinct delivery fingerprints', String(fingerprints.size));
  console.log('\n  both messages, on the supervisor\'s pane:\n');
  for (const line of messages) console.log(`    ${line}`);
  console.log('\n  the first sixty characters of each, which is what the pane check matches on:\n');
  for (const fingerprint of fingerprints) console.log(`    "${fingerprint}"`);

  verdict(
    tick.events.length === 2 &&
      herdr.interruptions(parent.agentName) === 2 &&
      fingerprints.size === 2 &&
      messages.some((m) => m.includes('KAN-900')) &&
      messages.some((m) => m.includes('KAN-903')),
    'two tickets stayed two pointers, each naming its own ticket and each ' +
      'distinguishable to the delivery check.',
    'the fix merged news across issues — a reader sent to one ticket would never learn about the other.'
  );
}

// -------------------------------------------------------- 3. the asymmetries --

rule('AC3c — what coalescing must not flatten: three asymmetries, still asymmetric');

console.log(`
  Coalescing hands one recipient a *group* of events, which is precisely the
  shape in which a per-event rule gets lost. Three of them exist here and each
  one is a silence if it goes:

    (a) an agent is never told its own ticket's status moved (KAN-79). Under
        coalescing this is no longer enforced by the target set alone, because
        a comment makes that agent a target and the status is in the group.
    (b) authorship suppression is per comment, not per issue (KAN-187): an
        agent that wrote one of two comments still hears about the other.
    (c) an agent that wrote EVERY new comment is still owed the transition, if
        it is not the one whose ticket moved.`);

{
  // (a) the issue's own agent, on a tick carrying both kinds, where the comment
  //     is somebody else's so it is genuinely a target.
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const poller = newPoller(JiraPoller, {
    jira, herdr, agents, parents,
    stateFile: nextStateFile(),
    authorship: newAuthorship(CommentAuthorship, tape)
  });
  await poller.pollOnce();

  tape.wroteComment(parent, 'KAN-900', 5100);       // the supervisor's steer
  jira.issues['KAN-900'].comments.push(5100);
  jira.issues['KAN-900'].status = 'In Review';      // and the ticket moves
  const tick = await poller.pollOnce();

  const toSubject = tick.nudges.find((n) => n.agentName === subject.agentName);
  const subjectMessage = herdr.submitted(subject.agentName)[0] ?? '';

  console.log('');
  row('(a) events on KAN-900 this tick', tick.events.map((e) => e.kind).join(' + '));
  row('    interruptions at task/KAN-900 (own)', String(herdr.interruptions(subject.agentName)));
  row('    the kinds it was told', JSON.stringify(eventsOf(toSubject).map((e) => e.kind)));
  console.log(`\n    the words it received:\n\n      ${subjectMessage}`);
  console.log(`
    One interruption carrying the steer, and no mention of In Review — which it
    moved the ticket to itself. A coalescer that simply concatenated the group
    would have put it there.`);

  verdict(
    herdr.interruptions(subject.agentName) === 1 &&
      eventsOf(toSubject).length === 1 &&
      eventsOf(toSubject)[0]?.kind === 'comment' &&
      !subjectMessage.includes('In Review'),
    '(a) the issue\'s own agent got the comment and not the status it made itself.',
    '(a) coalescing leaked the status back to the agent that caused it, or swallowed the steer.'
  );
}

{
  // (b) one comment of two is the recipient's own, on a tick that also carries
  //     a status change.
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const poller = newPoller(JiraPoller, {
    jira, herdr, agents, parents,
    stateFile: nextStateFile(),
    authorship: newAuthorship(CommentAuthorship, tape)
  });
  await poller.pollOnce();

  tape.wroteComment(subject, 'KAN-900', 5200);      // the agent's own
  tape.wroteComment(parent, 'KAN-900', 5201);       // the supervisor's
  jira.issues['KAN-900'].comments.push(5200, 5201);
  jira.issues['KAN-900'].status = 'In Review';
  const tick = await poller.pollOnce();

  const toSubject = tick.nudges.find((n) => n.agentName === subject.agentName);
  const message = herdr.submitted(subject.agentName)[0] ?? '';

  console.log('');
  row('(b) comments new on the issue', '2 — 5200 its own, 5201 the supervisor\'s');
  row('    the comment event as recognised', JSON.stringify(tick.events.find((e) => e.kind === 'comment')?.newComments));
  row('    the ids task/KAN-900 was told about', JSON.stringify(eventsOf(toSubject)[0]?.newCommentIds ?? null));
  console.log(`\n    the words it received:\n\n      ${message}`);

  verdict(
    herdr.interruptions(subject.agentName) === 1 &&
      eventsOf(toSubject).length === 1 &&
      eventsOf(toSubject)[0]?.newCommentIds?.join() === '5201' &&
      message.includes('a new comment') &&
      !message.includes('2 new comments') &&
      !message.includes('In Review'),
    '(b) it was told about the one comment that was news to it, counted as one, and ' +
      'still not about its own status change.',
    '(b) grouping the events lost the per-comment suppression or the per-recipient count.'
  );
}

{
  // (c) the supervisor wrote every new comment, and the ticket also moved. It is
  //     not the ticket's own agent, so the transition is still news to it.
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const log = [];
  const poller = newPoller(JiraPoller, {
    jira, herdr, agents, parents,
    stateFile: nextStateFile(),
    authorship: newAuthorship(CommentAuthorship, tape),
    log
  });
  await poller.pollOnce();

  tape.wroteComment(parent, 'KAN-900', 5300);
  jira.issues['KAN-900'].comments.push(5300);
  jira.issues['KAN-900'].status = 'In Review';
  const tick = await poller.pollOnce();

  const toParent = tick.nudges.find((n) => n.agentName === parent.agentName);
  const message = herdr.submitted(parent.agentName)[0] ?? '';

  console.log('');
  row('(c) epic/KAN-902 wrote every new comment', 'yes (5300)');
  row('    interruptions at epic/KAN-902', String(herdr.interruptions(parent.agentName)));
  row('    the kinds it was told', JSON.stringify(eventsOf(toParent).map((e) => e.kind)));
  row('    suppression recorded for it', JSON.stringify(
    tick.skipped.filter((s) => s.agentName === parent.agentName).map((s) => s.event.kind)
  ));
  console.log(`\n    the words it received:\n\n      ${message}`);
  console.log(`
    Both rules fired on one recipient in one group: the comment suppressed
    because it wrote it, the status delivered because it did not make it. The
    interruption count is one either way — what would have been wrong is zero.`);

  verdict(
    herdr.interruptions(parent.agentName) === 1 &&
      eventsOf(toParent).length === 1 &&
      eventsOf(toParent)[0]?.kind === 'status' &&
      message.includes('In Review') &&
      !message.includes('new comment') &&
      tick.skipped.some((s) => s.agentName === parent.agentName && s.event.kind === 'comment'),
    '(c) the author of every new comment still heard the transition, and heard it once.',
    '(c) a fully-suppressed comment took the status event with it — a silent loss.'
  );
}

// ------------------------------------------------- 3d. the board parent --

rule('AC3d — the relation a hand-off most needs to reach: the board parent (KAN-230)');

console.log(`
  THE GAP THIS SECTION EXISTS TO CLOSE, stated plainly because it nearly shipped.

  KAN-230 added 'parent' — the epic a ticket sits under on the board — and calls
  it the relation a hand-off most needs to reach, because it is the one that
  reviews and merges. It landed while this branch was open. Every section above
  passed on the rebase **without exercising it once**: their stub issues carry no
  parent field, so snapshot.parentKey is null and that whole leg of notify()
  never runs.

  So two proofs were green and the composition of the two changes — a coalesced
  hand-off arriving at a board parent — was tested by neither. That is the shape
  KAN-145 was burned by: not a wrong assertion in either script, but a gap
  between them that no script owned. It matters here more than most, because
  after KAN-230 the board parent is the recipient of nearly every hand-off on
  this board, which makes it the agent that was being interrupted twice.`);

{
  const subject = { agentName: nameFor('task', 'KAN-900'), type: 'task', key: 'KAN-900' };
  const boardParent = { agentName: nameFor('epic', 'KAN-39'), type: 'epic', key: 'KAN-39' };
  const agents = [subject, boardParent];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    // KAN-900 sits under KAN-39 on the board, and nobody activated anybody:
    // `activatedBy` is null for every agent the board reconciler starts, which
    // is the ordinary case KAN-230 was filed for.
    'KAN-900': { status: 'In Progress', comments: [5000], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  });
  const tape = transcripts();
  const poller = newPoller(JiraPoller, {
    jira, herdr, agents,
    parents: {},                        // no supervisor of record, deliberately
    stateFile: nextStateFile(),
    authorship: newAuthorship(CommentAuthorship, tape)
  });

  await poller.pollOnce();
  handOff(jira, tape, subject);          // its own comment, then In Review
  const tick = await poller.pollOnce();

  const toParent = tick.nudges.find((n) => n.agentName === boardParent.agentName);
  const message = herdr.submitted(boardParent.agentName)[0] ?? '';

  console.log('');
  row('KAN-900 sits under KAN-39 on the board', 'yes (fields.parent.key)');
  row('supervisor of record for task/KAN-900', 'none — activatedBy is null');
  row('events recognised on KAN-900', tick.events.map((e) => e.kind).join(' + '));
  row('interruptions at epic/KAN-39 (board parent)', String(herdr.interruptions(boardParent.agentName)));
  row('  the relation it was told under', JSON.stringify(toParent?.relation ?? null));
  row('  the events that one send carried', JSON.stringify(eventsOf(toParent).map((e) => e.kind)));
  console.log('\n  the single message the reviewing epic received:\n');
  console.log(`    ${message}`);

  console.log(`
  One interruption, both facts, and the board-parent sentence rather than the
  supervisor one. Before this branch that epic got two Ctrl+Cs for every
  hand-off it is asked to review; before KAN-230 it got none at all.`);

  verdict(
    tick.events.length === 2 &&
      herdr.interruptions(boardParent.agentName) === 1 &&
      toParent?.relation === 'parent' &&
      eventsOf(toParent).length === 2 &&
      message.includes('In Review') &&
      message.includes('new comment') &&
      message.includes('sits under your ticket on the board') &&
      herdr.interruptions(subject.agentName) === 0,
    'the board parent — the agent that reviews and merges — got one interruption ' +
      'carrying the transition and the comment, under its own relation.',
    'the board parent got two interruptions, none, or the wrong sentence: the two ' +
      'changes do not compose.'
  );
}

// ---------------------------------------------------------------- 4. memory --

rule('AC1 — the grouping sits between recognition and delivery, and touches neither');

console.log(`
  The safety question the ticket asks first: is de-duplicating across a tick's
  events for one issue safe against the existing "one event, one nudge, ever"
  memory? It is, and the reason is structural rather than lucky. \`recognise\`
  writes the memory and \`state.save()\` runs BEFORE the first send, so by the
  time anything is grouped the file already records both events. Grouping is a
  decision about how many times to type, taken downstream of everything the
  memory knows — so it cannot advance the memory past an event, and cannot
  fail to.

  Which is also the honest statement of the cost: a coalesced message that
  fails to deliver loses both facts rather than one. That is not new — the
  memory has always recorded recognition rather than delivery, deliberately, and
  \`deliverToAgent\` has already retried twice by then — but it is one
  interruption's worth of news now instead of half of it.`);

{
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const stateFile = nextStateFile();
  const seenOnDisk = [];

  const spy = async (opts) => {
    seenOnDisk.push(JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues['KAN-900']);
    return deliverToAgent(opts);
  };

  const poller = newPoller(JiraPoller, {
    jira, herdr, agents, parents, stateFile,
    authorship: newAuthorship(CommentAuthorship, tape),
    deliver: spy
  });
  await poller.pollOnce();
  handOff(jira, tape, subject);
  const tick = await poller.pollOnce();

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues['KAN-900'];
  const quiet = await poller.pollOnce();

  // A whole new poller over the file the previous one left behind.
  const after = newPoller(JiraPoller, {
    jira, herdr, agents, parents, stateFile,
    authorship: newAuthorship(CommentAuthorship, tape)
  });
  const afterRestart = await after.pollOnce();

  console.log('');
  row('interruptions this tick', String(tick.nudges.length));
  row('state on disk when the first send was handed over', JSON.stringify(seenOnDisk[0] ?? null));
  row('  …advanced past BOTH events already?', String(
    seenOnDisk.every((s) => s?.status === 'In Review' && s?.maxCommentId === '5001')
  ));
  row('persisted after the tick', JSON.stringify(persisted));
  row('the next tick, nothing new', `${quiet.events.length} event(s), ${quiet.nudges.length} nudge(s)`);
  row('a restart over that same file', `${afterRestart.events.length} event(s), ${afterRestart.nudges.length} nudge(s)`);

  verdict(
    seenOnDisk.length === 2 &&
      seenOnDisk.every((s) => s?.status === 'In Review' && s?.maxCommentId === '5001') &&
      persisted.status === 'In Review' &&
      persisted.maxCommentId === '5001' &&
      quiet.events.length === 0 &&
      quiet.nudges.length === 0 &&
      afterRestart.events.length === 0 &&
      afterRestart.nudges.length === 0,
    'both events were durable before the first send, the coalesced tick repeated on ' +
      'neither the next poll nor a restart, and grouping changed the memory not at all.',
    'either the tick was not one hand-over per recipient (read the count above), or the ' +
      'memory was disturbed — a hand-off that replays, or half of one that vanishes.'
  );
}

// ------------------------------------------------------------- 5. the live run --

if (LIVE) {
  rule('AC3d (--live) — one hand-off, one real Ctrl+C, one line on a real terminal');

  console.log(`
  Sections 1-4 count interruptions against a stub pane. This one counts them
  against real Claude Code terminals driven by the real HerdrBridge and the real
  deliverToAgent — the same code path production uses, including the Ctrl+C that
  opens every send and the pane read that confirms the message landed rather
  than sat in the composer.

  Jira is still stubbed: what this section adds is that ONE message is ONE real
  interruption, not that a real hand-off produces both events in one tick. That
  leg is verify-jira-poller-nudges.mjs --live and the production daemon.log.

  THE WINDOW, AND HOW IT WAS CLOSED — read this before changing the agent type.

  The keys are invented (KAN-99xx) so the real board is never written to. For
  the first four runs of this section they were 'task' keys, and the daemon's
  board reconciler stood the panes down mid-run every time, because a task on a
  key the board cannot find In Progress is an agent it converges away:

      [board] converging: stop task/KAN-9900 — not In Progress or In Review
      [board] stood down task/KAN-9900: the board does not have it In Progress

  It is a sweep rather than a fixed delay, so where the spawn landed in its
  cycle decided whether a run got ninety seconds or fifteen; across those four
  runs it got both. That is the reconciler working exactly as designed.

  The fix is the agent *type* — see AGENTS below. A 'probe' is outside the
  board's jurisdiction while its Jira-shaped key keeps it inside the poller's,
  so nothing converges these panes and nothing had to be weakened to stop it.

  What is kept from those runs is the liveness check: a pane that vanishes
  mid-run must report as a failure and not as a pass, because "inconclusive"
  and "passed" must never be spelled the same way. It should no longer fire.

  Nothing here is safe to run against real board keys instead — that would mean
  this proof transitioning real tickets to keep its own panes alive.`);

  const { HerdrBridge } = await import(path.join(path.resolve(distDir), 'herdr.js'));
  const { waitForAgentReady } = await import(path.join(path.resolve(distDir), 'nudge.js'));

  // TWO panes, and the count is deliberate. Both claims are made about ONE
  // recipient, so a second recipient would prove nothing this does not and
  // would cost a third Claude Code process. On the machine this was written for
  // — 4 cores, six agents working, `butchr_capacity` reporting headroom for one
  // more — a proof that spawned four panes to observe one would be taking
  // capacity from the fleet to watch itself.
  //
  // The `linked` relation is what makes two enough. KAN-9900 and KAN-9901 are
  // linked to each other, so task/KAN-9900's pane is a recipient for events on
  // both tickets: `linked` for KAN-9901's and `own` for a comment on its own.
  // Both of this ticket's claims are then readable off that single pane.
  // `probe`, not `task`, and that one word is what lets this section finish.
  //
  // The board reconciler asks two questions before it has an opinion about an
  // agent (`inJurisdiction`, board-reconcile.ts): is its *type* one the board
  // can describe — epic, story, task — and does its *key* look like a Jira key.
  // The Jira poller asks only the second, of the key alone. So a `probe` agent
  // on a Jira-shaped key is polled here and is none of the reconciler's
  // business, which is the gap this needs and the reason it is not a dodge:
  // the type is honest. These are not task agents and the board should not be
  // asked to hold an opinion about tickets that do not exist.
  //
  // Found the hard way (see THE WINDOW) and named by task/KAN-233, which hit
  // the same wall building its own probe companion and solved it from the key
  // side — a `-PROBE` suffix that fails the key regex. That direction is closed
  // to this script: a key the reconciler ignores is also a key the poller will
  // not poll, and polling it is the whole point here.
  const KEYS = { subject: 'KAN-9900', other: 'KAN-9901' };
  const AGENTS = [
    { type: 'probe', key: KEYS.subject, agentName: nameFor('probe', KEYS.subject) },
    { type: 'probe', key: KEYS.other, agentName: nameFor('probe', KEYS.other) }
  ];
  const WATCHER = AGENTS[0];

  const INERT =
    'You are a stand-in pane for a Butchr proof run (KAN-207). Do nothing at all: no tools, ' +
    'no files, no messages to anyone, no tickets, no Jira. If text arrives in this pane, ' +
    'acknowledge it in one short sentence and take no other action. This pane is closed ' +
    'automatically within a few minutes.';

  const bridge = new HerdrBridge();
  const aliveNames = () => new Set(bridge.listHerdrAgents().map((a) => a.name));
  /** Whether both proof panes are still alive — see THE WINDOW above. */
  const bothAlive = () => AGENTS.every((a) => aliveNames().has(a.agentName));
  const workspaces = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');

  // The keys are invented (KAN-99xx) and the real Jira is never read or
  // written: the events come from this stub, and the panes are what is real.
  const jira = stubJira({
    [KEYS.subject]: { status: 'In Progress', comments: [7000], links: [KEYS.other] },
    [KEYS.other]: { status: 'In Progress', comments: [7500], links: [KEYS.subject] }
  });

  const log = [];
  const poller = new JiraPoller({
    jira,
    herdrBridge: bridge,
    // Narrowed to this proof's two agents: the machine's real fleet is not this
    // script's to interrupt.
    liveAgents: () => AGENTS.filter((a) => aliveNames().has(a.agentName)),
    supervisorFor: () => null,
    log: (...a) => {
      const line = a.join(' ');
      log.push(line);
      console.log(`    ${line}`);
    },
    state: new JiraPollState(nextStateFile()),
    // A little under the 20s production default, and no longer because it has
    // to be: with the panes out of the reconciler's jurisdiction this section
    // owns its own clock again. Kept short only so a run costs a minute rather
    // than three. The code path is unchanged; only the patience is.
    confirmTimeoutMs: 15_000,
    confirmPollMs: 500,
    // The composer, by name — same reason as `newPoller` above. This section is
    // the live one: real panes, real Ctrl+C, counting real interruptions.
    deliver: deliverToAgent
  });

  /**
   * Submitted `[butchr daemon]` echo lines on a real pane.
   *
   * Corroboration, NOT the count. An echo line is one delivery *attempt* that
   * landed, and `deliverToAgent` retries once when the first send's Enter is
   * lost — which on a real Claude Code pane happens often enough that the first
   * run of this section read two echoes for one nudge and called it a failure.
   * The interruption count is `tick.nudges`, one entry per `sendToAgent`, which
   * is what the stub sections count too and what the Ctrl+C rides in on.
   *
   * Counted on the echo line only: Claude Code wraps a long message across
   * several indented rows, so counting every row holding the text would report
   * a coalesced message — which is longer — as more interruptions than a short
   * one, which is the exact number under test.
   */
  const daemonLines = async (agent) => {
    const tail = await bridge.tailAgent(agent.key, agent.type, 200);
    const text = tail.success && typeof tail.text === 'string' ? tail.text : '';
    return text
      .split('\n')
      .filter((l) => l.trimStart().startsWith('❯') && l.includes('[butchr daemon]'));
  };

  try {
    console.log('\n  starting two real agents…\n');
    for (const agent of AGENTS) {
      bridge.spawnSession(agent.type, agent.key, undefined, INERT, 'claude', {});
    }
    const ready = await Promise.all(AGENTS.map((a) => waitForAgentReady(bridge, a.key, a.type)));
    row('both panes reached a prompt', ready.every(Boolean) ? 'yes' : 'NO — see the tails');

    console.log('\n  poll 1 — first sight:\n');
    await poller.pollOnce();

    // BOTH claims in ONE tick, which is not a shortcut but a stronger test and a
    // shorter one. KAN-9901 gets a comment and a transition (the hand-off);
    // KAN-9900 gets a comment of its own. task/KAN-9900's pane is a recipient
    // for all three, so a single tick has to coalesce within an issue AND keep
    // two issues apart, and the pane shows both decisions side by side.
    //
    // Short also matters: see THE WINDOW. A second tick put the run past the
    // board reconciler's stand-down on every attempt.
    jira.issues[KEYS.other].comments.push(7501);
    jira.issues[KEYS.other].status = 'In Review';
    jira.issues[KEYS.subject].comments.push(7001);

    console.log('\n  poll 2 — a hand-off on KAN-9901, and a comment on KAN-9900:\n');
    const tick = await poller.pollOnce();
    const mine = tick.nudges.filter((n) => n.agentName === WATCHER.agentName);
    const onScreen = await daemonLines(WATCHER);

    const carried = mine.map((n) => ({
      ticket: eventsOf(n)[0]?.key,
      kinds: eventsOf(n).map((e) => e.kind)
    }));

    console.log('');
    row('events recognised', tick.events.map((e) => `${e.key}:${e.kind}`).join(', '));
    row('interruptions at the real pane (sends)', String(mine.length));
    for (const c of carried) row(`  → one send about ${c.ticket}`, JSON.stringify(c.kinds));
    row('echo lines on the pane (attempts, not sends)', String(onScreen.length));
    console.log('\n  what the real terminal shows:\n');
    for (const line of onScreen) console.log(`    ${line.trim()}`);

    console.log(`
    Three events, two sends. KAN-9901's transition and comment are one sentence;
    KAN-9900's comment is its own, because it is a different ticket to go and
    read. That is the whole of this ticket, on a real terminal.`);

    for (const agent of AGENTS) {
      const tail = await bridge.tailAgent(agent.key, agent.type, 45);
      console.log(`\n  ${agent.agentName}'s real terminal:\n`);
      console.log((tail.text ?? tail.error ?? '(no output)').split('\n').map((l) => `    ${l}`).join('\n'));
    }

    // The composed sentence, as a real terminal rendered it.
    const coalescedOnScreen = onScreen.some(
      (l) => l.includes('In Review') && l.includes('new comment')
    );

    // Liveness is part of the verdict, and a lost pane is still a failure.
    // Naming the likely cause is not the same as excusing it: a proof that
    // could not see its subject has proved nothing, and "inconclusive" must
    // never be spelled the same way as "passed".
    const survived = bothAlive();
    if (!survived) {
      console.log(`
    NOTE — one or both proof panes were stood down before this run finished.
    Look for a [board] "stood down task/KAN-99.." line in
    ~/.local/share/butchr/daemon.log at the matching time. If it is there, this
    run is INCONCLUSIVE rather than a regression — and it is still counted as a
    failure, because the alternative is a proof that reports success whenever
    its subject disappears.`);
    }

    const coalesced = carried.find((c) => c.kinds.length === 2);
    const alone = carried.find((c) => c.kinds.length === 1);

    verdict(
      survived &&
        tick.events.length === 3 &&
        mine.length === 2 &&
        coalesced?.ticket === KEYS.other &&
        coalesced.kinds.includes('status') &&
        coalesced.kinds.includes('comment') &&
        alone?.ticket === KEYS.subject &&
        coalescedOnScreen,
      'on a real terminal: one ticket\'s transition and comment arrived as a single ' +
        'send naming both, and a second ticket\'s comment arrived as its own — three ' +
        'events, two interruptions.',
      'the real pane shows a different shape from the stubbed ones, or did not survive ' +
        'the run — see the tail and the NOTE above.'
    );
  } finally {
    if (KEEP) {
      console.log('\n  --keep: leaving the panes open so they can be tailed.');
    } else {
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
} else {
  rule('AC3d (--live) — skipped: pass --live to run it');
  console.log(`
  Section 5 starts two real agents on this machine and types at their real
  terminals. Opt-in, because a proof that spawns panes is not something to do
  by accident on a machine with a working fleet on it.`);
}

// --------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures ? `${failures} SECTION(S) FAILED` : 'all sections passed'} ==`);
process.exit(failures ? 1 : 0);
