// KAN-188: the prompts' announce rule and the Jira poller must agree about who
// the daemon tells.
//
// WHAT FAILURE THIS WOULD CATCH: a `prompts/*.md` sentence about the poller that
// the poller no longer satisfies — the defect this ticket exists for. The rule
// in all three prompts was written (KAN-76, 2026-08-03) on the stated premise
// that "a status change is news, and nothing in the board delivers it". KAN-79's
// poller made that false on 2026-08-04 and nothing went red, so for two days the
// prompts instructed every agent to hand-deliver news the daemon had already
// delivered — at the cost of a Ctrl+C into the recipient's composer, which kills
// an in-flight tool call that does not resume. Three agents (KAN-185, KAN-186,
// KAN-160) each reached that instruction, checked, and disobeyed it correctly.
// Concretely this script goes red on: the retired premise sentence reappearing
// (6); the poller routing a status change to the issue's own agent, or ceasing
// to route it to linked and parent agents, while the prompts still tell agents
// to stay silent because it does (1, 2); an unwatched issue's move becoming
// visible or the "only live-agent issues are polled" exception the prompts rely
// on ceasing to be true (3); the topology widening past linked-and-supervisor so
// that "check issuelinks and activatedBy" stops being sufficient (4); and the
// 60s/300s intervals the prompts quote to agents drifting from the constants (5).
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It is a BINDING, and that is the point: each section asserts a claim is
// present in the prompts AND that the real JiraPoller behaves that way. Either
// half drifting is a failure, so the code cannot move without the prompts being
// made to follow, and the prompts cannot assert coverage the code does not give.
// This closes, for this one class of claim, the hole named in the header of
// `verify-operative-rules-are-carried.mjs`: that script checks a sentence is
// *present*, and says outright it "cannot check that the sentence is correct".
//
// WHAT THIS SCRIPT DOES NOT COVER, STATED BECAUSE THE HEADER IS WHERE THE EDGE
// GOES:
//
//   - **It supplies its own fleet, its own Jira and its own state file.** It
//     therefore proves what the JiraPoller class does when wired this way, and
//     NOT that the running daemon is wired this way, nor that a real transition
//     produces a real nudge. That is the KAN-145 failure mode and it is named
//     here rather than left to be inferred. Who covers it: `daemon.ts` wiring is
//     exercised by `verify-jira-poller-nudges.mjs --live` against real panes and
//     the real Jira API; and KAN-188's PR pastes `[jira-poll]` lines from
//     `~/.local/share/butchr/daemon.log` for its own real In Progress → In
//     Review transition, which is the leg no script owns.
//   - **It could not have caught the original drift**, because nobody had
//     written it when KAN-79 landed. What it does is make the *next* change to
//     the poller's topology fail loudly instead of silently invalidating a rule
//     three prompts give as an instruction.
//   - It says nothing about whether an agent *obeys* the rule, or whether the
//     rule is placed where the agent will meet it. Placement is
//     `verify-operative-rules-are-carried.mjs`; obedience is unprovable here.
//
// Usage: node daemon/scripts/verify-prompt-poller-seam.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.
//
// To watch it go red, break either half:
//   - the code: in `daemon/src/jira-poll.ts`, delete the `event.kind ===
//     'comment'` guard around the `own` loop in `notify()` so a status change
//     reaches the issue's own agent, rebuild, re-run → section 2 fails.
//   - the prompts: restore the retired premise sentence to any prompt → 6 fails.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

if (!fs.existsSync(path.join(distDir, 'jira-poll.js'))) {
  // A setup guard, not a verdict: there is nothing to test rather than
  // something that failed. The verdict-derived exit is at the bottom.
  console.error(`daemon/dist is missing (looked in ${distDir}). Run: cd daemon && npx tsc`);
  process.exit(2);
}

const { JiraPoller, JiraPollState, POLL_INTERVAL_MS, DEGRADED_POLL_INTERVAL_MS } =
  await import(path.join(distDir, 'jira-poll.js'));
const { snapshotFrom } = await import(path.join(distDir, 'jira.js'));
const { deliverToAgent } = await import(path.join(distDir, 'nudge.js'));

let failures = 0;
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${label.padEnd(58)} ${value}`);
const check = (ok, label, detail) => {
  row(label, ok ? 'PASS' : `FAIL — ${detail ?? 'expectation not met'}`);
  if (!ok) failures++;
  return ok;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan188-'));
let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `poll-${++stateFiles}.json`);
const nameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

// ------------------------------------------------------------- the prompts --

const PROMPTS = ['prompts/task.md', 'prompts/story.md', 'prompts/epic.md'];
const promptText = new Map(
  PROMPTS.map((rel) => [
    rel,
    // Whitespace-normalised, because every one of these files hard-wraps at 79
    // columns and a claim that straddles a line break is still the claim. The
    // naive grep misses exactly those, which is how a stale cross-reference
    // survived the first sweep of this very change.
    //
    // Emphasis markers are stripped for the same reason one step further in:
    // the three prompts bold the *same* sentence differently — `reads *only*
    // the issues`, `reads **only the issues**` — and a claim that a rule is
    // stated must not turn on where an author put an asterisk. This script
    // failed on exactly that before the strip was added, which is the honest
    // reason it is here.
    fs.readFileSync(path.join(repoRoot, rel), 'utf8')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
  ])
);

/** Assert every prompt in `where` carries every pattern. */
function claim(where, patterns, label) {
  let ok = true;
  for (const rel of where) {
    const text = promptText.get(rel);
    for (const re of patterns) {
      if (!re.test(text)) {
        ok = false;
        row(`  ${rel} carries ${re}`, 'FAIL — not found');
      }
    }
  }
  return check(ok, label, 'a prompt stopped stating this claim');
}

// ------------------------------------------------------------- the harness --

/** A herdr with panes, so delivery is confirmed the way production confirms it. */
function stubHerdr(running) {
  const alive = [...running];
  const panes = new Map();
  const sends = [];
  const paneFor = (n) => {
    if (!panes.has(n)) panes.set(n, { scrollback: ['bypass permissions on'] });
    return panes.get(n);
  };
  return {
    alive,
    sends,
    tailAgent: (key, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      return { success: true, text: [...paneFor(name).scrollback, '─'.repeat(80), '❯ '].join('\n') };
    },
    sendToAgent: async (key, message, type) => {
      const name = nameFor(type, key);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      sends.push({ agentName: name, message });
      paneFor(name).scrollback.push(`❯ ${message}`, '● Noted.');
      return { success: true };
    }
  };
}

const jiraBody = (key, issue) => ({
  key,
  fields: {
    status: { name: issue.status },
    updated: '2026-08-06T09:00:00.000-0700',
    comment: { comments: (issue.comments ?? []).map((id) => ({ id: String(id) })) },
    issuelinks: (issue.links ?? []).map((k) => ({
      type: { name: 'Relates' },
      outwardIssue: { key: k }
    }))
  }
});

function stubJira(issues) {
  const reads = [];
  return {
    issues,
    reads,
    pollIssue: async (key) => {
      reads.push(key);
      const issue = issues[key];
      if (!issue) return { ok: false, backOff: false, status: 404, error: 'no such issue' };
      return { ok: true, snapshot: snapshotFrom(key, jiraBody(key, issue)) };
    }
  };
}

function newPoller({ jira, herdr, agents, parents = {}, stateFile }) {
  return new JiraPoller({
    jira,
    herdrBridge: herdr,
    liveAgents: () => agents.filter((a) => herdr.alive.includes(a.agentName)),
    supervisorFor: (agentName) => parents[agentName] ?? null,
    log: () => {},
    state: new JiraPollState(stateFile),
    confirmTimeoutMs: 400,
    confirmPollMs: 50,
    // KAN-301 made this seam's default a REFUSAL rather than the composer, so a
    // harness that reads delivery off a pane now has to ask for the composer by
    // name. This is that ask, and it is deliberate rather than a red made to go
    // away: what this proof is about is WHO gets told and WHAT the message says,
    // and the composer is the only carrier whose delivery can be confirmed as
    // submitted output (C3) — a channel frame is unobservable past the socket.
    // It is NOT a claim about production's carrier. Production rides the
    // channel, and `verify-notifications-never-type.mjs` §1b is what asserts
    // that this injection has no counterpart anywhere in `daemon/src`.
    deliver: deliverToAgent
  });
}

const told = (herdr) => new Set(herdr.sends.map((s) => s.agentName));

// =========================================================== 1, 2 and 4 ======
// One real tick, four recipients, because who is told and who is not are the
// same decision seen from four sides.

rule('1, 2, 4 — one status change, and the four people it does and does not reach');

{
  // KAN-800 moves. KAN-801 is linked to it. story/KAN-802 activated KAN-800's
  // agent. KAN-803 is live, unlinked, and nobody's supervisor.
  const agents = [
    { agentName: 'butchr-task-kan-800', type: 'task', key: 'KAN-800' },
    { agentName: 'butchr-task-kan-801', type: 'task', key: 'KAN-801' },
    { agentName: 'butchr-story-kan-802', type: 'story', key: 'KAN-802' },
    { agentName: 'butchr-task-kan-803', type: 'task', key: 'KAN-803' }
  ];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    'KAN-800': { status: 'In Progress', comments: ['10'], links: ['KAN-801'] },
    'KAN-801': { status: 'In Progress', comments: ['20'], links: ['KAN-800'] },
    'KAN-802': { status: 'In Progress', comments: ['30'], links: [] },
    'KAN-803': { status: 'In Progress', comments: ['40'], links: [] }
  });
  const parents = { 'butchr-task-kan-800': { type: 'story', key: 'KAN-802' } };
  const poller = newPoller({ jira, herdr, agents, parents, stateFile: nextStateFile() });

  await poller.pollOnce();               // first sight: records, notifies nobody
  jira.issues['KAN-800'].status = 'In Review';
  herdr.sends.length = 0;
  await poller.pollOnce();               // the transition

  const reached = told(herdr);
  console.log(`\n  nudged: ${[...reached].join(', ') || '(nobody)'}\n`);

  check(reached.has('butchr-task-kan-801'), '§1 the linked live agent is told', 'not nudged');
  check(reached.has('butchr-story-kan-802'), '§1 the activating supervisor is told', 'not nudged');
  check(
    !reached.has('butchr-task-kan-800'),
    "§2 the issue's OWN agent is NOT told about its own status",
    'the poller echoed a status change back to the agent that made it'
  );
  check(
    !reached.has('butchr-task-kan-803'),
    '§4 a live agent that is neither linked nor supervisor is NOT told',
    'the topology is wider than linked-and-supervisor'
  );

  claim(
    PROMPTS,
    [/Jira-linked/i, /activatedBy|supervisor (that|recorded)/i],
    '§1 all three prompts name the two relations the poller uses'
  );
  claim(
    ['prompts/task.md'],
    [/never about its own status/i],
    "§2 task.md tells the agent its own status change is not echoed back to it"
  );
  claim(
    PROMPTS,
    [/issuelinks/i],
    '§4 the prompts tell the agent to check issuelinks rather than assume'
  );
}

// ===================================================================== 3 ======

rule('3 — an issue with no live agent is never read, so its move reaches nobody');

{
  // KAN-900 has no agent. KAN-901 is live AND linked to it — the strongest
  // version of the case: the neighbour is watched and still hears nothing,
  // because events are recognised only on issues that are themselves read.
  const agents = [{ agentName: 'butchr-task-kan-901', type: 'task', key: 'KAN-901' }];
  const herdr = stubHerdr(agents.map((a) => a.agentName));
  const jira = stubJira({
    'KAN-900': { status: 'In Progress', comments: ['10'], links: ['KAN-901'] },
    'KAN-901': { status: 'In Progress', comments: ['20'], links: ['KAN-900'] }
  });
  const poller = newPoller({ jira, herdr, agents, stateFile: nextStateFile() });

  await poller.pollOnce();
  jira.issues['KAN-900'].status = 'Done';   // the unstaffed ticket moves
  herdr.sends.length = 0;
  jira.reads.length = 0;
  const tick = await poller.pollOnce();

  row('issues read this tick', jira.reads.join(', ') || '(none)');
  check(!jira.reads.includes('KAN-900'), '§3 the unstaffed issue is not even read', 'it was read');
  check(
    tick.events.length === 0 && herdr.sends.length === 0,
    '§3 its move produces no event and no nudge, for anyone',
    `${tick.events.length} event(s), ${herdr.sends.length} nudge(s)`
  );

  claim(
    PROMPTS,
    [/only the issues of live agents/i],
    '§3 all three prompts state that only live agents’ issues are polled'
  );
  claim(
    ['prompts/epic.md', 'prompts/story.md'],
    [/stood down|not running/i],
    '§3 epic.md and story.md name the stood-down ticket as the case they must announce'
  );
}

// ===================================================================== 5 ======

rule('5 — the intervals the prompts quote to agents are the poller’s constants');

{
  row('POLL_INTERVAL_MS', POLL_INTERVAL_MS);
  row('DEGRADED_POLL_INTERVAL_MS', DEGRADED_POLL_INTERVAL_MS);
  check(POLL_INTERVAL_MS === 60_000, '§5 the normal interval is the 60s the prompts quote', String(POLL_INTERVAL_MS));
  check(
    DEGRADED_POLL_INTERVAL_MS === 300_000,
    '§5 the degraded interval is the 300s the prompts quote',
    String(DEGRADED_POLL_INTERVAL_MS)
  );
  claim(PROMPTS, [/60 seconds|60s/], '§5 the prompts quote the 60s figure agents reason with');
  claim(
    ['prompts/task.md', 'prompts/story.md'],
    [/300s|300 seconds/],
    '§5 task.md and story.md quote the degraded figure'
  );
}

// ===================================================================== 6 ======

rule('6 — the retired premise stays retired');

{
  const RETIRED = /nothing in the board delivers it/i;
  let ok = true;
  for (const rel of PROMPTS) {
    if (RETIRED.test(promptText.get(rel))) {
      ok = false;
      row(`  ${rel}`, 'FAIL — the false premise is back');
    }
  }
  check(
    ok,
    '§6 no prompt claims the board delivers nothing',
    'a prompt asserts a premise KAN-79 made false on 2026-08-04'
  );
  claim(
    PROMPTS,
    [/poller|jira-poll/i],
    '§6 every prompt that instructs on announcing names the mechanism it defers to'
  );
}

// --------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(
  `\n${'='.repeat(78)}\n` +
  (failures ? `== ${failures} FAILURE(S) ABOVE ==` : '== all sections passed ==') +
  `\n${'='.repeat(78)}`
);
process.exit(failures ? 1 : 0);
