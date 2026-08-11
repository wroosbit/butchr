// Proof for KAN-230: an issue's parent *on the board* is on the poller's
// notification topology, and is a different relation from the agent that
// activated it.
//
// WHAT FAILURE THIS WOULD CATCH: a hand-off that reaches nobody. A task agent
// moves its ticket to In Review with a PR open and waiting; the epic that owns
// review and merge is live, is the ticket's Jira parent, and is told nothing,
// because the poller's only two routes were `issuelinks` and `activatedBy` and
// this ticket had neither. Observed in production on 2026-08-08 as
// `[jira-poll] KAN-237 (status): nobody live to tell.` while PR #98 sat
// unreviewed. It also catches the four ways a fix for that goes wrong: the
// board parent read but never *requested*, so `parentKey` is null against the
// real API and the relation silently never fires (section 1 — this is the one
// with teeth); the new relation stealing the sentence or the slot of an agent
// that is already covered as a supervisor, so a working notification changes
// under a change that was supposed to be additive (5a); a parent whose agent is
// switched off disappearing into the same undiagnosable `nobody live to tell`
// the defect hid behind (5b); and the new relation announcing an issue's status
// change twice, or on every subsequent tick (5d).
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Six sections:
//
//   1. the field arrives   — the real JiraClient, driven through a transport
//                            that behaves the way Jira behaves (it returns
//                            ONLY the fields the request named), so a
//                            `WATCH_FIELDS` that forgot `parent` fails here
//   2. the divergent chain — task → story → epic, where `activatedBy` and the
//                            Jira parent name DIFFERENT agents. Both are told,
//                            each in its own words. Plus the control the
//                            acceptance criterion asks for: the same code on a
//                            task whose `activatedBy` IS its epic, which is the
//                            shape that proves nothing
//   3. the board-reconciler shape — `activatedBy: null`, no issue links, live
//                            epic: 0 recipients before, 1 after. This is
//                            KAN-237's and this ticket's own shape
//   4. both kinds          — a status change and a comment each reach the board
//                            parent, and the four relations' sentences
//   5. no regression       — supervisor still wins the tie, a parent that is not
//                            running is logged rather than swallowed, an issue
//                            with no parent routes nowhere new, and nothing
//                            repeats on the next tick
//   6. --live              — the real Jira API with the daemon's stored
//                            read-only credential: a real issue's real parent
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
//
// Sections 2-5 build their own Jira response bodies and hand them to the real
// `snapshotFrom`, so they test routing and not retrieval. On its own that is
// precisely the KAN-145 shape — a proof asserting the daemon carries a field,
// over records that already had the field in them, while production had null.
// Section 1 is what closes it *inside this script*: it never constructs a
// snapshot, it makes the real client issue a real request against a transport
// that withholds anything the request did not ask for, so the only way to get a
// `parentKey` is to have asked Jira for one. Section 6 confirms the same thing
// against the live API rather than against a model of it.
//
// Still not covered by anything here: the production daemon delivering to a
// real epic's pane. `verify-jira-poller-nudges.mjs --live` owns real panes and
// the real API for the three older relations; it does not exercise this one.
// The PR body carries an observation of the running fleet in its place.
//
// Usage: node daemon/scripts/verify-jira-parent-topology.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.
//
//        --live  additionally runs section 6, which reads ONE real Jira issue
//                with the daemon's stored credential. Read-only, no panes, no
//                writes, nothing on the fleet is disturbed. Opt-in because it
//                needs a configured credential and network.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

const { JiraPoller, JiraPollState, jiraEventNudgeText } = await import(
  path.join(distDir, 'jira-poll.js')
);
const { JiraClient, snapshotFrom, WATCH_FIELDS } = await import(path.join(distDir, 'jira.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
/** Accumulated verdict. The exit code below is derived from it, nothing else. */
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(52)} ${value}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan230-'));
let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++stateFiles}.json`);

// ------------------------------------------------------------- the harness --

const nameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

/** A submitted message, as Claude Code echoes it: `❯`, hard-wrapped (KAN-77). */
const wrap = (text) =>
  (text.match(/.{1,76}(\s|$)/g) ?? [text])
    .map((line, i) => (i === 0 ? `❯ ${line.trim()}` : `  ${line.trim()}`))
    .join('\n');

/**
 * A herdr whose agents have panes: a scrollback of what was submitted and a
 * composer of what was merely typed. `deliverToAgent` reads the difference, so
 * a nudge counted here is one that landed.
 */
function stubHerdr(running) {
  const alive = [...running];
  const panes = new Map();
  const paneFor = (agentName) => {
    if (!panes.has(agentName)) panes.set(agentName, { scrollback: ['bypass permissions on'], composer: '' });
    return panes.get(agentName);
  };
  const render = (pane) =>
    [...pane.scrollback, '─'.repeat(80), `❯ ${pane.composer}`, '─'.repeat(80), '  ⏵⏵ bypass permissions on'].join('\n');

  return {
    alive,
    tailAgent: (key, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      return { success: true, text: render(paneFor(name)) };
    },
    sendToAgent: async (key, message, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      const pane = paneFor(name);
      pane.scrollback.push(wrap(message), '● Noted.');
      pane.composer = '';
      return { success: true };
    },
    kill: (agentName) => {
      const i = alive.indexOf(agentName);
      if (i !== -1) alive.splice(i, 1);
    },
    submitted: (agentName) => paneFor(agentName).scrollback.filter((l) => l.startsWith('❯ '))
  };
}

/**
 * A Jira response body in the shape the REST API returns for the watched
 * fields, so the real `snapshotFrom` is what turns it into a snapshot.
 *
 * `parent` is emitted only when the issue has one, exactly as Jira does: an
 * epic's response carries no `parent` key at all rather than a null one.
 */
const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status, statusCategory: { key: 'indeterminate' } },
    updated: '2026-08-08T09:00:00.000-0700',
    comment: {
      comments: (issue.comments ?? []).map((id) => ({
        id: String(id),
        author: { accountId: '712020:shared', displayName: 'Wroos Bit' },
        created: '2026-08-08T09:00:00.000-0700'
      })),
      total: (issue.comments ?? []).length,
      maxResults: (issue.comments ?? []).length,
      startAt: 0
    },
    issuelinks: (issue.links ?? []).map((linked) => ({
      id: '1',
      type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
      outwardIssue: { key: linked, fields: { status: { name: 'To Do' } } }
    })),
    ...(issue.parent
      ? {
          parent: {
            id: '10048',
            key: issue.parent,
            fields: { summary: 'Butchr', issuetype: { name: 'Epic', hierarchyLevel: 1 } }
          }
        }
      : {})
  }
});

/**
 * Jira, stubbed at the one method the poller calls.
 *
 * `blindToParent` reproduces the pre-fix daemon without reverting the build: a
 * client whose request never named `parent` receives no `parent`, so the
 * snapshot's `parentKey` is null. It is how sections 2 and 3 show the before as
 * well as the after through the same code path.
 */
function stubJira(issues, { blindToParent = false } = {}) {
  return {
    issues,
    pollIssue: async (key) => {
      const issue = issues[key];
      if (!issue) return { ok: false, backOff: false, status: 404, error: 'issue does not exist' };
      const body = jiraBody(key, issue);
      if (blindToParent) delete body.fields.parent;
      return { ok: true, snapshot: snapshotFrom(key, body) };
    }
  };
}

function newPoller({ jira, herdr, agents, supervisors = {}, stateFile, log = [] }) {
  return new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents.filter((a) => herdr.alive.includes(a.agentName)),
    supervisorFor: (agentName) => supervisors[agentName] ?? null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(stateFile),
    confirmTimeoutMs: 400,
    confirmPollMs: 50
  });
}

/**
 * A pane's echo with its hard wrapping undone, for substring checks.
 *
 * Claude Code echoes a submitted message wrapped to the pane width, so a naive
 * `includes()` over the scrollback fails on any phrase that happens to straddle
 * a line break — the same trap KAN-77's AC3 documents for delivery checks.
 */
const flat = (line) => line.replace(/\s+/g, ' ').trim();

/** Which relation each recipient was told, from the tick record. */
const routing = (tick) =>
  tick.nudges.map((n) => `${n.type}/${n.key}=${n.relation}${n.delivered ? '' : ' (UNDELIVERED)'}`).sort().join('  ');

// ===================================================== 1. the field arrives ==

rule('AC-input — the parent is REQUESTED, not merely parsed: the real client, against a Jira that answers only what it was asked');

console.log(`
  The failure this section exists for is the one that looks like success. A
  proof that builds a snapshot with a parentKey already in it passes whether or
  not the daemon ever asks Jira for the field — and if it does not ask, the
  field is null in production and the whole relation is dead code that no test
  can see. That is KAN-145 exactly: two green scripts over records that already
  carried \`activatedBy\`, while every agent in production had null.

  So nothing here constructs a snapshot. The real JiraClient issues a real
  request, and the transport below models the one Jira behaviour that makes the
  question decidable: **it returns only the fields the request named.**`);

{
  /**
   * A transport that behaves like Jira's `fields` parameter: it parses the
   * request's own field list and withholds everything not on it. The full issue
   * it draws from has a parent; whether the caller sees one is decided entirely
   * by what the caller asked for.
   */
  const requests = [];
  const fullIssue = {
    key: 'KAN-230',
    fields: {
      status: { name: 'In Progress' },
      updated: '2026-08-08T10:00:00.000-0700',
      comment: { comments: [{ id: '11057' }] },
      issuelinks: [{ id: '1', outwardIssue: { key: 'KAN-226' } }],
      parent: { id: '10048', key: 'KAN-39', fields: { issuetype: { name: 'Epic' } } }
    }
  };
  const transportAskingFor = (fieldList) => ({
    describe: () => 'a Jira that answers only what it was asked',
    get: async (requestPath) => {
      requests.push(requestPath);
      const asked = new Set(
        (new URL(`https://x${requestPath}`).searchParams.get('fields') ?? '').split(',').filter(Boolean)
      );
      const fields = {};
      for (const name of Object.keys(fullIssue.fields)) if (asked.has(name)) fields[name] = fullIssue.fields[name];
      return { status: 200, body: { key: fullIssue.key, fields }, legs: [] };
    },
    fieldList
  });

  const client = new JiraClient(transportAskingFor());
  const snapshot = await client.getIssueSnapshot('KAN-230', new AbortController().signal);
  // Counted here, before the counterfactual below adds a request of its own:
  // "the parent costs no extra round trip" is one of the claims on the ticket.
  const issuedByClient = requests.length;

  console.log('');
  row('WATCH_FIELDS, as the module exports it', WATCH_FIELDS);
  row('requests the client issued for that snapshot', String(issuedByClient));
  row('the request the real client actually issued', requests[0]);
  row('  …does it name `parent`?', String(new URL(`https://x${requests[0]}`).searchParams.get('fields').split(',').includes('parent')));
  row('snapshot.parentKey it came back with', JSON.stringify(snapshot.parentKey));

  // The counterfactual, through the identical code path: the same transport,
  // the same issue, the same parser — asked the pre-KAN-230 field list.
  const before = snapshotFrom('KAN-230', await (async () => {
    const t = transportAskingFor();
    const { body } = await t.get('/rest/api/3/issue/KAN-230?fields=status,updated,comment,issuelinks');
    return body;
  })());
  console.log('');
  row('the same issue, asked the pre-KAN-230 field list', 'fields=status,updated,comment,issuelinks');
  row('  snapshot.parentKey', JSON.stringify(before.parentKey));
  console.log(`
    …null, from a Jira that HAS the parent. That is the state the daemon was in:
    the routing code could have been perfect and would have routed to nobody.`);

  verdict(
    WATCH_FIELDS.split(',').includes('parent') &&
      issuedByClient === 1 &&
      requests[0].includes('parent') &&
      snapshot.parentKey === 'KAN-39' &&
      before.parentKey === null,
    'the poll read asks Jira for the parent and gets it; the same read without ' +
      'the field in the request gets null, so this section fails if WATCH_FIELDS ever loses it.',
    'the client did not request `parent`, or requested it and did not carry it into the snapshot.'
  );
}

// ================================================== 2. the divergent chain ==

rule('AC2 — task → story → epic: `activatedBy` and the Jira parent are DIFFERENT agents, and both are told');

console.log(`
  Modelled on the real board. task/KAN-226 was activated by story/KAN-107 and
  sits under epic/KAN-39 on the board; the two readings of the word "parent"
  name different agents, which is the only shape in which this ticket is
  decidable. The epic is the agent that reviews and merges, so it is the one
  the hand-off has to reach.`);

{
  const agents = [
    { agentName: 'butchr-task-kan-226', type: 'task', key: 'KAN-226' },
    { agentName: 'butchr-story-kan-107', type: 'story', key: 'KAN-107' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const issues = {
    'KAN-226': { status: 'In Progress', comments: [11000], links: [], parent: 'KAN-39' },
    'KAN-107': { status: 'In Progress', comments: [], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  };
  const supervisors = { 'butchr-task-kan-226': { type: 'story', key: 'KAN-107' } };

  /**
   * One hand-off, end to end: warm the memory, move the ticket, poll again.
   *
   * `blindToParent` is the only difference between the two runs below — same
   * poller, same cast, same transition. It models a daemon whose poll read
   * never asked Jira for the parent, which is what the daemon did until this
   * change and what section 1 shows is entirely a property of the request.
   */
  const handOff = async (blindToParent) => {
    const herdr = stubHerdr(agents.map((a) => a.agentName));
    const log = [];
    const stateFile = nextStateFile();
    const jira = stubJira(structuredClone(issues), { blindToParent });
    const poller = newPoller({ jira, herdr, agents, supervisors, stateFile, log });
    const first = await poller.pollOnce();
    jira.issues['KAN-226'].status = 'In Review';
    const tick = await poller.pollOnce();
    return { first, tick, herdr, log, poller };
  };

  const before = await handOff(true);
  console.log('');
  row('BEFORE — KAN-226 In Progress → In Review', `${before.tick.events.length} event(s), ${before.tick.nudges.length} nudge(s)`);
  row('  who was told', routing(before.tick) || '(nobody)');
  row('  epic/KAN-39 — the agent that merges', `${before.herdr.submitted('butchr-epic-kan-39').length} notice(s)`);

  const after = await handOff(false);
  const { first, tick, herdr } = after;

  console.log('');
  row('AFTER  — KAN-226 In Progress → In Review', `${tick.events.length} event(s), ${tick.nudges.length} nudge(s)`);
  row('  who was told, and as what', routing(tick));
  console.log('\n  epic/KAN-39\'s pane — the agent that reviews and merges:\n');
  for (const line of herdr.submitted('butchr-epic-kan-39')) console.log(`    ${line}`);
  console.log('\n  story/KAN-107\'s pane — the agent that staffed the task:\n');
  for (const line of herdr.submitted('butchr-story-kan-107')) console.log(`    ${line}`);
  console.log('\n  task/KAN-226\'s own pane (a status change is never echoed to its own agent):');
  console.log(`    ${herdr.submitted('butchr-task-kan-226').length === 0 ? '(nothing — by design)' : 'UNEXPECTED'}`);

  const epic = herdr.submitted('butchr-epic-kan-39');
  const story = herdr.submitted('butchr-story-kan-107');

  // ---- the control the acceptance criterion asks for -----------------------
  console.log(`
  And the control. AC2 says a proof built on a task whose \`activatedBy\` IS its
  epic proves nothing here — so here is that shape, run through the same code,
  to show what it would have "proved": the epic is told, as it always was, by
  the supervisor leg. Green before this change and green after, measuring
  nothing.`);
  const coincident = (async () => {
    const cAgents = [
      { agentName: 'butchr-task-kan-217', type: 'task', key: 'KAN-217' },
      { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
    ];
    const cHerdr = stubHerdr(cAgents.map((a) => a.agentName));
    const cIssues = {
      'KAN-217': { status: 'In Progress', comments: [], links: [], parent: 'KAN-39' },
      'KAN-39': { status: 'In Progress', comments: [], links: [] }
    };
    const cState = nextStateFile();
    const blind = stubJira(structuredClone(cIssues), { blindToParent: true });
    const cSup = { 'butchr-task-kan-217': { type: 'epic', key: 'KAN-39' } };
    const warm = newPoller({ jira: blind, herdr: cHerdr, agents: cAgents, supervisors: cSup, stateFile: cState });
    await warm.pollOnce();
    blind.issues['KAN-217'].status = 'In Review';
    return (await newPoller({ jira: blind, herdr: cHerdr, agents: cAgents, supervisors: cSup, stateFile: cState }).pollOnce());
  })();
  const control = await coincident;
  row('control: activatedBy IS the epic, parent unread', routing(control));

  verdict(
    first.events.length === 0 &&
      before.tick.nudges.length === 1 &&
      before.tick.nudges[0].relation === 'supervisor' &&
      before.herdr.submitted('butchr-epic-kan-39').length === 0 &&
      tick.nudges.length === 2 &&
      tick.nudges.every((n) => n.delivered) &&
      tick.nudges.some((n) => n.key === 'KAN-39' && n.relation === 'parent') &&
      tick.nudges.some((n) => n.key === 'KAN-107' && n.relation === 'supervisor') &&
      epic.length === 1 &&
      flat(epic[0]).includes('KAN-226 status changed to In Review') &&
      flat(epic[0]).includes('It sits under your ticket on the board') &&
      story.length === 1 &&
      flat(story[0]).includes('You activated its agent') &&
      herdr.submitted('butchr-task-kan-226').length === 0 &&
      control.nudges.length === 1 &&
      control.nudges[0].relation === 'supervisor',
    'on the chain where the two readings differ, the supervisor and the board parent ' +
      'were each told once and each in its own words — and the shape where they coincide ' +
      'routes through the supervisor leg alone, which is why it proves nothing.',
    'the epic was not told, was told as the wrong relation, or the supervisor lost its notice.'
  );
}

// =========================================== 3. the board-reconciler shape ==

rule('AC2b — `activatedBy: null`, no issue links, live epic: the shape the board reconciler makes, and the one KAN-237 stalled on');

console.log(`
  Since KAN-221/222 the board starts most agents, and daemon.ts passes no
  \`activatedBy\` when it does — deliberately, because nothing staffed the agent
  and inventing a supervisor would put a false parent in the org chart (KAN-145).
  That decision is correct and untouched here. Its consequence was that BOTH
  legs of the topology were empty for such an agent, so a hand-off reached
  nobody at all. Read from production on 2026-08-08:

      [jira-poll] KAN-237 (status): nobody live to tell.

  …with PR #98 open and epic/KAN-39 live. Same shape below.`);

{
  const agents = [
    { agentName: 'butchr-task-kan-237', type: 'task', key: 'KAN-237' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const issues = {
    'KAN-237': { status: 'In Progress', comments: [], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  };
  // No supervisors at all: the registry says `activatedBy: null`, honestly.
  const supervisors = {};

  const run = async (blindToParent) => {
    const herdr = stubHerdr(agents.map((a) => a.agentName));
    const log = [];
    const stateFile = nextStateFile();
    const jira = stubJira(structuredClone(issues), { blindToParent });
    const poller = newPoller({ jira, herdr, agents, supervisors, stateFile, log });
    await poller.pollOnce();
    jira.issues['KAN-237'].status = 'In Review';
    const tick = await poller.pollOnce();
    return { tick, herdr, log };
  };

  const before = await run(true);
  const after = await run(false);

  console.log('');
  row('BEFORE — recipients for the In Review move', `${before.tick.nudges.length}`);
  row('  what the daemon logged', before.log.find((l) => l.includes('nobody live to tell')) ?? '(no such line)');
  console.log('');
  row('AFTER  — recipients for the In Review move', `${after.tick.nudges.length}`);
  row('  who, and as what', routing(after.tick));
  console.log('\n  epic/KAN-39\'s pane:\n');
  for (const line of after.herdr.submitted('butchr-epic-kan-39')) console.log(`    ${line}`);

  verdict(
    before.tick.nudges.length === 0 &&
      before.log.some((l) => l.includes('nobody live to tell')) &&
      after.tick.nudges.length === 1 &&
      after.tick.nudges[0].relation === 'parent' &&
      after.tick.nudges[0].key === 'KAN-39' &&
      after.tick.nudges[0].delivered &&
      after.herdr.submitted('butchr-epic-kan-39').length === 1,
    'the agent whose ticket had neither a link nor a supervisor now reaches the epic ' +
      'that owns its merge, and the production log line that hid the gap is gone.',
    'the board-reconciler shape still reaches nobody.'
  );
}

// ==================================================== 4. both kinds of news ==

rule('AC — the board parent gets status changes AND comments, and each relation says which it is');

console.log(`
  \`own\` deliberately excludes status changes: an agent that moved its own
  ticket does not need to be interrupted to hear that it moved. That reasoning
  does not reach a board parent, which caused neither the transition nor the
  comment — and the transition it most needs is exactly the one \`own\` drops,
  In Review with a PR waiting. So this relation carries both kinds.`);

{
  const agents = [
    { agentName: 'butchr-task-kan-230', type: 'task', key: 'KAN-230' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const issues = {
    'KAN-230': { status: 'In Progress', comments: [11057], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  };
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const stateFile = nextStateFile();
  const jira = stubJira(structuredClone(issues));
  const poller = newPoller({ jira, herdr, agents, stateFile });
  await poller.pollOnce();

  jira.issues['KAN-230'].comments.push(11059);
  const onComment = await poller.pollOnce();
  jira.issues['KAN-230'].status = 'In Review';
  const onStatus = await poller.pollOnce();

  console.log('');
  row('a comment on KAN-230 — who is told', routing(onComment));
  row('a transition on KAN-230 — who is told', routing(onStatus));
  row('the issue\'s own agent, comment vs status', `${herdr.submitted('butchr-task-kan-230').length} notice(s) (comment only)`);

  console.log('\n  the four relations, in the words a recipient actually receives:\n');
  for (const relation of ['own', 'supervisor', 'parent', 'linked']) {
    console.log(`    ${relation.padEnd(11)} ${jiraEventNudgeText({ key: 'KAN-230', kind: 'status', to: 'In Review' }, relation)}`);
  }

  const epic = herdr.submitted('butchr-epic-kan-39');
  verdict(
    onComment.nudges.filter((n) => n.relation === 'parent').length === 1 &&
      onStatus.nudges.filter((n) => n.relation === 'parent').length === 1 &&
      epic.length === 2 &&
      herdr.submitted('butchr-task-kan-230').length === 1 &&
      jiraEventNudgeText({ key: 'K-1', kind: 'status', to: 'X' }, 'parent').includes('sits under your ticket on the board') &&
      jiraEventNudgeText({ key: 'K-1', kind: 'status', to: 'X' }, 'supervisor').includes('You activated its agent'),
    'a board parent is told about both a comment and a transition, the issue\'s own ' +
      'agent is still told about the comment only, and the two parent-ish relations ' +
      'no longer share a sentence.',
    'the new relation dropped one of the two event kinds, or its wording is indistinguishable from the supervisor\'s.'
  );
}

// ======================================================== 5. no regression ==

rule('AC — the guards: the supervisor keeps the tie, a switched-off parent is named, an issue with no parent adds nobody, and nothing repeats');

{
  // 5a — one agent, both relations: told once, in the terms that already applied.
  const agents = [
    { agentName: 'butchr-task-kan-217', type: 'task', key: 'KAN-217' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const issues = {
    'KAN-217': { status: 'In Progress', comments: [], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  };
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const stateFile = nextStateFile();
  const jira = stubJira(structuredClone(issues));
  const poller = newPoller({
    jira, herdr, agents,
    supervisors: { 'butchr-task-kan-217': { type: 'epic', key: 'KAN-39' } },
    stateFile
  });
  await poller.pollOnce();
  jira.issues['KAN-217'].status = 'In Review';
  const both = await poller.pollOnce();
  console.log('');
  row('5a — supervisor AND board parent are one agent', routing(both));
  row('  notices on that one pane', String(herdr.submitted('butchr-epic-kan-39').length));

  // 5b — the parent's agent is switched off: named, not swallowed.
  const offAgents = [
    { agentName: 'butchr-task-kan-230', type: 'task', key: 'KAN-230' },
    { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }
  ];
  const offHerdr = stubHerdr(offAgents.map((a) => a.agentName));
  const offJira = stubJira({
    'KAN-230': { status: 'In Progress', comments: [], links: [], parent: 'KAN-39' },
    'KAN-39': { status: 'In Progress', comments: [], links: [] }
  });
  const offLog = [];
  const offState = nextStateFile();
  const offPoller = newPoller({ jira: offJira, herdr: offHerdr, agents: offAgents, stateFile: offState, log: offLog });
  await offPoller.pollOnce();
  offHerdr.kill('butchr-epic-kan-39');
  offJira.issues['KAN-230'].status = 'In Review';
  const off = await offPoller.pollOnce();
  console.log('');
  row('5b — the board parent is switched off', `${off.nudges.length} nudge(s), ${off.skipped.length} recorded skip(s)`);
  row('  the reason it recorded', off.skipped.map((s) => s.reason).join('; ') || '(none)');
  row('  the line it logged', offLog.find((l) => l.includes('board parent')) ?? '(none)');

  // 5c — an epic has no parent, and asks for nobody it should not.
  const topAgents = [{ agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }];
  const topHerdr = stubHerdr(topAgents.map((a) => a.agentName));
  const topJira = stubJira({ 'KAN-39': { status: 'In Progress', comments: [], links: [] } });
  const topState = nextStateFile();
  const topPoller = newPoller({ jira: topJira, herdr: topHerdr, agents: topAgents, stateFile: topState });
  await topPoller.pollOnce();
  topJira.issues['KAN-39'].status = 'Done';
  const top = await topPoller.pollOnce();
  console.log('');
  row('5c — an issue with no parent at all', `${top.events.length} event(s) → ${top.nudges.length} nudge(s)`);
  row('  snapshot.parentKey for that issue', JSON.stringify((await topJira.pollIssue('KAN-39')).snapshot.parentKey));

  // 5d — the same transition on the next tick is not news again.
  const again = await poller.pollOnce();
  const andAgain = await poller.pollOnce();
  console.log('');
  row('5d — two more ticks over the same state', `${again.nudges.length} + ${andAgain.nudges.length} nudge(s)`);
  row('  total notices on epic/KAN-39\'s pane', String(herdr.submitted('butchr-epic-kan-39').length));

  verdict(
    both.nudges.length === 1 &&
      both.nudges[0].relation === 'supervisor' &&
      herdr.submitted('butchr-epic-kan-39').length === 1 &&
      off.nudges.length === 0 &&
      off.skipped.some((s) => s.relation === 'parent' && s.reason.includes('no live agent')) &&
      offLog.some((l) => l.includes('board parent KAN-39')) &&
      top.events.length === 1 &&
      top.nudges.length === 0 &&
      (await topJira.pollIssue('KAN-39')).snapshot.parentKey === null &&
      again.nudges.length === 0 &&
      andAgain.nudges.length === 0,
    'an agent covered twice is interrupted once and keeps the wording it had, a ' +
      'switched-off parent is named in the log and recorded as skipped rather than ' +
      'vanishing, an issue with no parent adds no recipients, and one transition stays one nudge.',
    'a guard did not hold — see the counts above.'
  );
}

// ========================================================== 6. the live leg ==

if (LIVE) {
  rule('AC-live — the real Jira API, the daemon\'s stored read-only credential: a real issue\'s real parent');

  const { JiraIssueTypeService } = await import(path.join(distDir, 'jira.js'));
  const { CredentialStore } = await import(path.join(distDir, 'credentials.js'));

  const KEY = process.env.KAN230_ISSUE ?? 'KAN-230';
  const EXPECTED = process.env.KAN230_PARENT ?? 'KAN-39';

  const service = new JiraIssueTypeService(new CredentialStore());
  const outcome = await service.pollIssue(KEY);

  console.log('');
  row('issue read', KEY);
  row('read ok', String(outcome.ok));
  if (!outcome.ok) {
    row('  why not', `${outcome.status ?? '-'} ${outcome.error}`);
  } else {
    row('statusName', JSON.stringify(outcome.snapshot.statusName));
    row('linkedKeys', JSON.stringify(outcome.snapshot.linkedKeys));
    row('parentKey', JSON.stringify(outcome.snapshot.parentKey));
    console.log(`
    Read over one GET, through the same poll path the daemon uses every minute.
    No second request was issued for the parent: it arrives in the response
    because WATCH_FIELDS names it.`);
  }

  verdict(
    outcome.ok === true && outcome.snapshot.parentKey === EXPECTED,
    `the real API returned ${EXPECTED} as ${KEY}'s parent, in the poll read itself.`,
    'the live read failed, or returned no parent — set KAN230_ISSUE / KAN230_PARENT if the board has moved.'
  );
}

// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures ? `${failures} SECTION(S) FAILED` : 'all sections passed'} ==`);
process.exit(failures ? 1 : 0);
