// Proof for KAN-187: the poller no longer interrupts an agent to tell it about
// a comment that agent wrote itself — and still interrupts it for everybody
// else's.
//
// WHAT FAILURE THIS WOULD CATCH: a suppression that closed the channel instead
// of filtering it. The dangerous failure here is not the redundant nudge this
// ticket is about; it is the fix over-reaching and swallowing a supervisor's
// steer, because a comment on a task's ticket is how an epic redirects work
// already in flight, and a steer that never arrives fails silently and looks
// exactly like a quiet afternoon. So every section that asserts a nudge was
// suppressed is paired with one asserting a nudge still landed: an agent's own
// comment (1), another agent's comment on the same ticket in the same tick (2),
// a mix of both where the count must be the news rather than the total (3), a
// human's comment which is attributable to nobody (4), and the `linked` and
// `parent` relations, which are where the echo was observed live and which a
// fix written only for `own` would miss (5). It also catches an attribution
// built on something weaker than the comment's id — section 6 hands the parser
// a *read* whose response is full of comment ids and requires that none of them
// be claimed as a write.
//
// Six sections plus a control:
//
//   0. the control    — the same scenario with the authorship source removed,
//                       which is the pre-fix daemon, showing the echo arriving
//   1. own            — an agent's own comment on its own ticket: no nudge
//   2. somebody else  — another agent's comment on that same ticket: nudged
//   3. mixed          — one of each in one tick: nudged, and told "1", not "2"
//   4. unattributed   — a comment nobody in the fleet wrote: nudged
//   5. linked/parent  — the two relations the live reports came from
//   6. reads          — a getJiraIssue result is not a write, however many
//                       comment ids it contains
//
// WHERE THIS PROOF SUPPLIES ITS OWN INPUT, AND WHO COVERS THAT
//
// Sections 1-6 write the transcript lines they then assert on. They exercise
// the real CommentAuthorship parser, the real JiraPoller, the real JiraPollState
// on a real file, the real snapshot parser over real-shaped Jira bodies and the
// real `deliverToAgent` against a stubbed *pane* — but the transcript records
// are synthesised, so what they cannot prove is that Claude Code writes records
// in the shape parsed here. **That leg is not covered by this script.** It is
// covered by `verify-comment-authorship-live.mjs`, which runs the same parser
// over this machine's real, untouched Claude Code transcripts and checks the ids
// it extracts against Jira. Run both; neither is sufficient alone, and the gap
// between them is exactly the shape-of-the-record question.
//
// Usage: node daemon/scripts/verify-jira-self-echo-suppression.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

const { JiraPoller, JiraPollState } = await import(path.join(distDir, 'jira-poll.js'));
const { CommentAuthorship } = await import(path.join(distDir, 'comment-authorship.js'));
const { snapshotFrom } = await import(path.join(distDir, 'jira.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(56)} ${value}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan187-'));
let files = 0;
const nextStateFile = () => path.join(TMP, `jira-poll-${++files}.json`);

// ------------------------------------------------------------- the harness --

const nameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

/** A submitted message as Claude Code echoes it, wrapped to an 80-column pane. */
const wrap = (text) =>
  (text.match(/.{1,76}(\s|$)/g) ?? [text])
    .map((line, i) => (i === 0 ? `❯ ${line.trim()}` : `  ${line.trim()}`))
    .join('\n');

/** A herdr whose agents have panes, so delivery is confirmed as production does. */
function stubHerdr(running) {
  const alive = [...running];
  const panes = new Map();
  const paneFor = (agentName) => {
    if (!panes.has(agentName)) panes.set(agentName, { scrollback: ['bypass permissions on'] });
    return panes.get(agentName);
  };
  const render = (pane) =>
    [...pane.scrollback, '─'.repeat(80), '❯ ', '  ⏵⏵ bypass permissions on · ← for agents'].join('\n');

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
      paneFor(name).scrollback.push(wrap(message), '● Noted.');
      return { success: true };
    },
    submitted: (agentName) => paneFor(agentName).scrollback.filter((l) => l.startsWith('❯ '))
  };
}

/** A Jira body in the shape the REST API returns for the poller's field list. */
const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status },
    updated: '2026-08-06T09:00:00.000-0700',
    comment: {
      comments: issue.comments.map((id) => ({
        id: String(id),
        // The shared account, spelled as Jira really spells it. Every comment
        // in this fleet carries this and only this, which is the whole reason
        // authorship has to come from somewhere else.
        author: { accountId: '712020:619ec5ec-2e92-492f-8979-91ccda318230', displayName: 'Wroos Bit' },
        created: '2026-08-06T09:00:00.000-0700'
      })),
      total: issue.comments.length
    },
    issuelinks: (issue.links ?? []).map((linked) => ({
      id: '1',
      type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
      outwardIssue: { key: linked }
    }))
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

// --------------------------------------------------- synthesised transcripts --

/**
 * A transcript directory per agent, laid out the way Claude Code lays one out.
 *
 * The *records* are this script's invention — see the header — but the pairing
 * they encode is not: a `tool_use` in an assistant message carrying the tool's
 * arguments, then a `tool_result` in the following user message carrying
 * Atlassian's response, joined by `tool_use_id`. The response body below is a
 * verbatim-shaped copy of a real one:
 *
 *   {"self":"…/rest/api/3/issue/10195/comment/10818","id":"10818","author":{…}}
 */
let tapes = 0;
function transcripts() {
  // One root per section. Sharing one would let an earlier section's records
  // attribute a later section's comments — which is how the first run of this
  // script failed three sections, and is worth keeping the guard for.
  const root = path.join(TMP, `transcripts-${++tapes}`);
  const dirFor = (agent) => path.join(root, `${agent.type}-${agent.key}`.toLowerCase());

  const append = (agent, lines) => {
    const dir = dirFor(agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'session.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    );
  };

  let toolCalls = 0;

  return {
    dirFor,
    /** Record that `agent` posted comment `commentId` on `issueKey`. */
    wroteComment(agent, issueKey, commentId) {
      const toolUseId = `toolu_kan187_${++toolCalls}`;
      append(agent, [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Posting the update on the ticket.' },
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'mcp__atlassian__addCommentToJiraIssue',
                input: {
                  cloudId: 'c4c523ff-4beb-4418-9257-9f194fce3490',
                  issueIdOrKey: issueKey,
                  commentBody: '## Progress\n\nWork continues.'
                }
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
                      self: `https://api.atlassian.com/ex/jira/c4c5/rest/api/3/issue/10195/comment/${commentId}`,
                      id: String(commentId),
                      author: {
                        accountId: '712020:619ec5ec-2e92-492f-8979-91ccda318230',
                        displayName: 'Wroos Bit'
                      },
                      created: '2026-08-06T09:00:00.000-0700'
                    })
                  }
                ]
              }
            ]
          }
        }
      ]);
    },
    /** Record that `agent` *read* an issue whose response is full of ids. */
    readIssue(agent, issueKey, commentIds) {
      const toolUseId = `toolu_kan187_${++toolCalls}`;
      append(agent, [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'mcp__atlassian__getJiraIssue',
                input: { issueIdOrKey: issueKey, fields: ['comment'] }
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
                      key: issueKey,
                      fields: {
                        comment: {
                          comments: commentIds.map((id) => ({
                            id: String(id),
                            self: `https://api.atlassian.com/ex/jira/c4c5/rest/api/3/issue/1/comment/${id}`
                          }))
                        }
                      }
                    })
                  }
                ]
              }
            ]
          }
        }
      ]);
    }
  };
}

function newPoller({ jira, herdr, agents, parents = {}, stateFile, authorship, log = [] }) {
  return new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents.filter((a) => herdr.alive.includes(a.agentName)),
    supervisorFor: (agentName) => parents[agentName] ?? null,
    log: (...a) => log.push(a.join(' ')),
    state: new JiraPollState(stateFile),
    confirmTimeoutMs: 400,
    confirmPollMs: 50,
    ...(authorship ? { authorship } : {})
  });
}

/** The cast: a task agent, its supervisor, and a linked task. */
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

const newAuthorship = (tape, log = []) =>
  new CommentAuthorship({
    transcriptDirFor: (agent) => tape.dirFor(agent),
    log: (...a) => log.push(a.join(' '))
  });

// ------------------------------------------------------------- 0. the control --

rule('CONTROL — the pre-fix daemon: the same scenario with no authorship source');

console.log(`
  This is not a hypothetical description of the defect; it is the defect,
  reproduced by the same code path this proof then uses. A JiraPoller built
  without an authorship source attributes nothing, so nothing is suppressed —
  which is exactly what shipped before KAN-187, and what four agents recorded
  being interrupted by. Section 1 is the same scenario with the source wired in.`);

let controlOwnPane = -1;
{
  const { subject, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile() });

  await poller.pollOnce(); // first sight

  // task/KAN-900's own agent comments on KAN-900.
  tape.wroteComment(subject, 'KAN-900', 5001);
  jira.issues['KAN-900'].comments.push(5001);

  const tick = await poller.pollOnce();
  controlOwnPane = herdr.submitted(subject.agentName).length;

  console.log('');
  row('the agent wrote comment 5001 on its own ticket', 'yes');
  row('nudges it received about its own comment', String(controlOwnPane));
  console.log('\n  what landed in its terminal:\n');
  for (const line of herdr.submitted(subject.agentName)) console.log(`    ${line}`);

  verdict(
    controlOwnPane === 1 && tick.nudges.some((n) => n.agentName === subject.agentName),
    'the pre-fix behaviour is reproduced: the agent is interrupted to be told about ' +
      'its own comment. Everything below is measured against this.',
    'the control did not reproduce the defect, so nothing below is evidence of fixing it.'
  );
}

// ---------------------------------------------------------------- 1. own --

rule('AC3a — an agent that comments on its own ticket is NOT nudged about it');

{
  const { subject, linked, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const log = [];
  const authorship = newAuthorship(tape, log);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship, log });

  await poller.pollOnce();

  tape.wroteComment(subject, 'KAN-900', 5001);
  jira.issues['KAN-900'].comments.push(5001);

  const tick = await poller.pollOnce();

  console.log('');
  row('the comment id the daemon attributed', JSON.stringify(authorship.entries()));
  row('nudges to the issue\'s OWN agent', String(herdr.submitted(subject.agentName).length));
  row('  (the control above, with no authorship source)', String(controlOwnPane));
  row('nudges to the linked agent', String(herdr.submitted(linked.agentName).length));
  row('nudges to the parent agent', String(herdr.submitted(parent.agentName).length));
  console.log('');
  row('what the poller logged about the skip', log.find((l) => l.includes('wrote every new comment')) ?? '(nothing)');
  row('recorded in tick.skipped', JSON.stringify(tick.skipped.map((s) => s.reason)));

  console.log(`
  Note which nudges survived. The comment is still news to the linked agent and
  to the supervisor — neither of them wrote it — so suppression is per-recipient
  and not a decision about the comment.`);

  verdict(
    herdr.submitted(subject.agentName).length === 0 &&
      controlOwnPane === 1 &&
      herdr.submitted(linked.agentName).length === 1 &&
      herdr.submitted(parent.agentName).length === 1 &&
      tick.skipped.some((s) => s.reason.includes('written by the recipient')),
    'the author was not interrupted, and the two agents who did not write it were.',
    'the author was still nudged, or the suppression took the other recipients with it.'
  );
}

// ------------------------------------------------------- 2. somebody else --

rule('AC3b — a comment from ANOTHER agent on the same ticket still nudges');

console.log(`
  The leg that decides whether this filtered the channel or closed it. Same
  ticket, same relation, same agent — the only difference is who wrote the
  comment, which is the only difference that should matter.`);

{
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const authorship = newAuthorship(tape);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship });

  await poller.pollOnce();

  // The supervisor posts a steer on the task's ticket — the channel this whole
  // subsystem exists to deliver.
  tape.wroteComment(parent, 'KAN-900', 5002);
  jira.issues['KAN-900'].comments.push(5002);

  await poller.pollOnce();

  console.log('');
  row('epic/KAN-902 wrote comment 5002 on KAN-900', 'yes');
  row('nudges to task/KAN-900 (the recipient)', String(herdr.submitted(subject.agentName).length));
  row('nudges to epic/KAN-902 (the author)', String(herdr.submitted(parent.agentName).length));
  console.log('\n  what the task agent received — the steer, intact:\n');
  for (const line of herdr.submitted(subject.agentName)) console.log(`    ${line}`);

  verdict(
    herdr.submitted(subject.agentName).length === 1 &&
      herdr.submitted(parent.agentName).length === 0,
    'a supervisor\'s comment reached the agent it was written for, and did not come ' +
      'back to the supervisor that wrote it.',
    'the steer was suppressed — the fix has closed the channel rather than filtered it.'
  );
}

// -------------------------------------------------------------- 3. mixed --

rule('AC3c — one of each in one tick: nudged, and told the count that is news');

{
  const { subject, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const authorship = newAuthorship(tape);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship });

  await poller.pollOnce();

  tape.wroteComment(subject, 'KAN-900', 5003); // its own
  tape.wroteComment(parent, 'KAN-900', 5004);  // the supervisor's
  jira.issues['KAN-900'].comments.push(5003, 5004);

  const tick = await poller.pollOnce();
  const toSubject = tick.nudges.find((n) => n.agentName === subject.agentName);

  console.log('');
  row('comments new on the issue this tick', '2 (5003 its own, 5004 the supervisor\'s)');
  row('the event the poller recognised', JSON.stringify(tick.events[0]));
  row('the event task/KAN-900 was actually told', JSON.stringify(toSubject?.events ?? null));
  console.log('\n  the words it received:\n');
  for (const line of herdr.submitted(subject.agentName)) console.log(`    ${line}`);

  console.log(`
  "has a new comment", not "has 2 new comments". A pointer with the wrong number
  on it is a small lie that costs a re-read, and the agent already knows what one
  of the two says.`);

  verdict(
    herdr.submitted(subject.agentName).length === 1 &&
      tick.events[0].newComments === 2 &&
      // One interruption carrying one event since KAN-207; the assertion is
      // on that event, which is still the one comment that is news to it.
      toSubject?.events.length === 1 &&
      toSubject?.events[0].newComments === 1 &&
      toSubject?.events[0].newCommentIds?.join() === '5004' &&
      herdr.submitted(subject.agentName)[0].includes('a new comment') &&
      !herdr.submitted(subject.agentName)[0].includes('2 new comments'),
    'the agent was told about the one comment that was news to it, counted as one.',
    'the mixed tick was suppressed entirely, or announced with the issue\'s total.'
  );
}

// ------------------------------------------------------- 4. unattributed --

rule('AC3d — a comment nobody in the fleet wrote is nudged about, as before');

console.log(`
  A human typing in the Jira web UI leaves no transcript anywhere, and neither
  does an agent whose transcript cannot be read. Both arrive here as an id with
  no author, and an id with no author is news to everyone. This is the direction
  every unknown in this fix resolves in.`);

{
  const { subject, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const authorship = newAuthorship(tape);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship });

  await poller.pollOnce();

  // No transcript is written for this one: it is a human's comment.
  jira.issues['KAN-900'].comments.push(5005);
  await poller.pollOnce();

  console.log('');
  row('a comment appeared with no transcript behind it', 'yes');
  row('attributions the daemon holds', String(authorship.entries().length));
  row('nudges to task/KAN-900', String(herdr.submitted(subject.agentName).length));

  verdict(
    authorship.entries().length === 0 && herdr.submitted(subject.agentName).length === 1,
    'an unattributable comment nudges exactly as it did before the fix — the ' +
      'unknown case fails towards a redundant pointer, never towards a lost steer.',
    'an unattributed comment was suppressed, which would drop human steers silently.'
  );
}

// ----------------------------------------------------- 5. linked / parent --

rule('AC3e — the `linked` and `parent` relations, where the echo was observed live');

console.log(`
  Both live reports on this ticket came through these two paths, not through
  \`own\`: task/KAN-183 was nudged about its own comment on the *linked* story
  KAN-160 under the mirror-post convention, and epic/KAN-39 was nudged about its
  own comments on its children's tickets. A fix written only for \`own\` would
  have left both of them exactly as they were.`);

{
  const { subject, linked, parent, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const authorship = newAuthorship(tape);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship });

  await poller.pollOnce();

  // The mirror-post: task/KAN-900 posts on the LINKED ticket KAN-901, whose own
  // agent is live. Under `linked`, the author would be told about its own text.
  tape.wroteComment(subject, 'KAN-901', 5010);
  jira.issues['KAN-901'].comments.push(5010);

  // And the supervisor comments on its child's ticket, where it hears about the
  // event under `parent`.
  tape.wroteComment(parent, 'KAN-900', 5011);
  jira.issues['KAN-900'].comments.push(5011);

  const tick = await poller.pollOnce();

  console.log('');
  const toSubject = tick.nudges.filter((n) => n.agentName === subject.agentName);
  const skippedFor = (agentName) =>
    tick.skipped.filter((s) => s.agentName === agentName).map((s) => `${s.relation}:${s.event.key}`);

  row('task/KAN-900 wrote 5010 on the linked KAN-901', 'yes');
  row('  → suppressed for task/KAN-900', JSON.stringify(skippedFor(subject.agentName)));
  row('epic/KAN-902 wrote 5011 on its child KAN-900', 'yes');
  row('  → suppressed for epic/KAN-902', JSON.stringify(skippedFor(parent.agentName)));
  console.log('');
  row('nudges task/KAN-900 still received', JSON.stringify(toSubject.map((n) => `${n.relation}:${n.events.map((e) => e.key).join()}`)));
  row('nudges epic/KAN-902 still received', String(herdr.submitted(parent.agentName).length));
  row('nudges task/KAN-901, which wrote neither', String(herdr.submitted(linked.agentName).length));

  console.log(`
  Read the two rows for task/KAN-900 together: in a single tick it was
  suppressed for the comment it wrote on the linked ticket and still told about
  the supervisor's comment on its own. Same agent, same tick, same relation
  machinery — the only thing separating them is who wrote which.

  task/KAN-901's two are both right as well: 5010 landed on its own ticket and
  5011 on KAN-900, to which it is linked. It wrote neither, so neither is
  suppressed — the count that has to fall is the author's, not the audience's.`);

  verdict(
    skippedFor(subject.agentName).join() === 'linked:KAN-901' &&
      skippedFor(parent.agentName).join() === 'parent:KAN-900' &&
      toSubject.length === 1 &&
      toSubject[0].events.length === 1 &&
      toSubject[0].events[0].key === 'KAN-900' &&
      herdr.submitted(parent.agentName).length === 0 &&
      herdr.submitted(linked.agentName).length === 2,
    'neither the linked author nor the parent author was interrupted about its own ' +
      'text, while the same tick still delivered the supervisor\'s steer to the agent ' +
      'it was written for.',
    'the echo survived on the linked or the parent path — the two the live reports came from.'
  );
}

// ------------------------------------------------------------- 6. reads --

rule('AC3f — a read full of comment ids is not a write of any of them');

console.log(`
  The attribution is a *paired* record: a tool_use that asked Atlassian to
  create a comment, joined by tool_use_id to the result that came back. Reading
  ids out of any result that happens to contain them would let a single
  getJiraIssue — which returns every comment on the issue — claim authorship of
  the whole ticket and mute it permanently.`);

{
  const { subject, agents, herdr, jira, parents } = cast();
  const tape = transcripts();
  const authorship = newAuthorship(tape);
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile(), authorship });

  await poller.pollOnce();

  // The agent reads its own ticket, whose response carries ids 5020 and 5021.
  tape.readIssue(subject, 'KAN-900', [5020, 5021]);
  jira.issues['KAN-900'].comments.push(5020, 5021);

  await poller.pollOnce();

  console.log('');
  row('the agent READ an issue whose response held 5020, 5021', 'yes');
  row('attributions the daemon holds', JSON.stringify(authorship.entries()));
  row('nudges to task/KAN-900', String(herdr.submitted(subject.agentName).length));

  verdict(
    authorship.entries().length === 0 && herdr.submitted(subject.agentName).length === 1,
    'reading an issue claims authorship of nothing, so a ticket cannot be muted by ' +
      'being read.',
    'a read was treated as a write — the attribution is not pairing tool_use with its result.'
  );
}

// --------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures ? `${failures} SECTION(S) FAILED` : 'all sections passed'} ==`);
process.exit(failures ? 1 : 0);
