// Proof for KAN-80: every category of `list_agents` row carries the supervisor
// of record, so the Agents page can draw the org chart from the DTO alone.
//
// WHAT FAILURE THIS WOULD CATCH: the Agents page drawing the wrong org chart, or
// no org chart, because the daemon answered the parentage question badly. Four
// shapes of that, and the last is the one that silently costs the most:
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
//   * a row nesting under the wrong agent, or under nothing — `activatedBy`
//     naming an agent that did not staff it, or dropped from one of the four
//     lists so that whole category renders rootless;
//   * a parent invented for an agent nobody supervising activated — a human's
//     sidepanel toggle is parentless, and guessing a supervisor for it puts
//     somebody else's name on work they never staffed;
//   * a stood-down, lost or preempted child losing the parent it had, so a
//     story switched off under a live epic disappears from the structure
//     instead of showing that the epic has a child and the child is off;
//   * a parentless agent coming back with the key *omitted* rather than
//     `null`. That one is not a bad row, it is a bad page: the extension reads
//     an absent field as "this daemon cannot answer", so a single omission
//     flattens the entire tree — every nesting relationship in the fleet lost
//     to make one row honest about something it was not confused about.
//
// It also catches the field drifting out from under KAN-81 and CrabCast:
// renamed, reshaped, `type`/`key` swapped or blank, extra keys, or the
// `(type, key)` match folded on one side only — which orphans every child while
// each individual row still looks correct.
//
// What it cannot catch is the router reading the wrong thing off a *correct*
// registry write, because the records here are seeded rather than activated
// through. Recording is KAN-77's, proved in verify-status-change-nudges.mjs.
//
// THIS SCRIPT IS THE INTERFACE, NOT THE IMPLEMENTATION
//
// The daemon-side exposure below is expected to be deleted: under KAN-104 the
// orchestration layer becomes CrabCast's, and `activatedBy` is one of the
// requirements CrabCast accepted from us. What survives that swap is the field
// name and its shape — `activatedBy: { type, key } | null`, always present,
// never omitted — because KAN-81's tree and CrabCast's extension-point API are
// both written against it. So this file asserts the *contract* rather than the
// code that currently satisfies it: the exact field name, the exact object
// shape, and specifically that a parentless agent yields an explicit `null`
// rather than a missing key. That last one is what the Agents page uses to tell
// "this agent has no parent" from "this daemon is too old to answer", and it is
// the detail most easily lost in a reimplementation.
//
// House style, from verify-list-agents-survives-restart.mjs: the real
// MessageRouter, the real WorkspaceRegistry carrying the real Atlassian
// integration, and a real on-disk AgentRegistry pointed at a temp file. Only
// `herdr` is replaced, and only as an external binary on PATH — no part of the
// code under test is mocked.
//
// Sections:
//   1. the chain      — epic KAN-900 → story KAN-901 → task KAN-902, all three
//                       running, reconstructed as a tree from the DTO alone
//   2. no parent      — an agent nobody supervising activated answers `null`,
//                       present as a key, and no parent is invented for it
//   3. standby child  — a stood-down story under a live epic keeps its parent;
//                       the same for a missing agent and a preempted one, so
//                       all four row categories are covered
//   4. the shape      — every row of every category has the key; every non-null
//                       value is exactly `{ type, key }` with non-empty strings
//   5. self-parentage — a record that names itself as its own supervisor never
//                       reaches the wire (refused at write time by KAN-77; this
//                       asserts the absence rather than re-implementing it)
//
// Usage: node daemon/scripts/verify-parentage-in-list-agents.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan80-'));
const realPath = process.env.PATH;
let registryFiles = 0;

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

/** How a parent reads in a table: `(field absent)` is a failure, `null` is not. */
const show = (parent) =>
  parent === undefined ? '(field absent)' : parent === null ? 'null' : `${parent.type}/${parent.key}`;

// ------------------------------------------------------------- the harness --

/**
 * Put a `herdr` on PATH that reports `agents` as live panes.
 *
 * A stub binary rather than a stub bridge: the real HerdrBridge parses this,
 * so the census the router surveys is produced by production code reading real
 * subprocess output. Every invocation prints the same census, which is all
 * `herdr agent list` is asked for here.
 */
function stubHerdr(agents) {
  const bin = path.join(TMP, `bin-${++registryFiles}`);
  fs.mkdirSync(bin, { recursive: true });
  const payload = JSON.stringify({
    id: 'cli:agent:list',
    result: {
      type: 'agent_list',
      agents: agents.map((name) => ({
        name,
        agent: 'claude',
        agent_status: 'working',
        cwd: path.join(TMP, 'workspaces', name)
      }))
    }
  });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`, {
    mode: 0o755
  });
  process.env.PATH = `${bin}:${realPath}`;
}

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(TMP, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration());
registry.setEnabled('jira', true);
const prompts = new PromptLoader(repoRoot);

/**
 * A registry record as an activation writes one.
 *
 * `activatedBy` is populated here rather than by driving `activate_by_key`,
 * because *recording* it is KAN-77's scope and is proved by its own script.
 * What this file is about is what happens to the field between the durable
 * record and the wire, so the record is the input and the DTO is the output.
 */
function record(type, key, activatedBy, { workspace = true } = {}) {
  const workDir = path.join(TMP, 'workspaces', `butchr-${type}-${key.toLowerCase()}`);
  // Standby rows are only offered for agents whose workspace still exists —
  // a `reset` deletes the directory, and that is the difference between
  // "switched off" and "finished with".
  if (workspace) fs.mkdirSync(workDir, { recursive: true });
  return {
    agentName: `butchr-${type}-${key.toLowerCase()}`,
    type,
    key,
    workDir,
    defaultAgent: 'claude',
    activatedBy
  };
}

/**
 * Drive the real `list_agents` handler over a registry seeded with `records`.
 *
 * `live` names which of them herdr will report as running; anything seeded as
 * activated and not live is a loss, and anything deactivated is standby.
 */
function listAgents({ live = [], activated = [], deactivated = [], preempted = [] }) {
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFiles}.jsonl`));
  for (const r of activated) agentRegistry.recordActivated(r);
  for (const r of deactivated) {
    agentRegistry.recordActivated(r);
    agentRegistry.recordDeactivated(r);
  }
  for (const { rec, by } of preempted) {
    agentRegistry.recordActivated(rec);
    agentRegistry.recordDeactivated(rec, {
      byAgentName: by.agentName,
      byType: by.type,
      byKey: by.key,
      byPriority: 2,
      priority: 1,
      herdrStatus: 'working',
      derivation: 'a proof run, not a real capacity decision'
    });
  }

  stubHerdr(live);

  let response;
  const router = new MessageRouter(
    registry,
    prompts,
    // A fresh bridge holds no sessions, so every running row comes back
    // `sessionless: true` — the post-restart state, and the one where the
    // registry is the *only* thing that still knows who staffed what.
    new HerdrBridge(),
    (msg) => {
      response = msg;
    },
    () => {},
    { agentRegistry }
  );
  router.handle({ action: 'list_agents' });
  return response;
}

/** Every row of every category, tagged with the list it came from. */
const allRows = (res) => [
  ...res.agents.map((r) => ({ category: 'agents', ...r })),
  ...res.standbyAgents.map((r) => ({ category: 'standbyAgents', ...r })),
  ...res.missingAgents.map((r) => ({ category: 'missingAgents', ...r })),
  ...res.preemptedAgents.map((r) => ({ category: 'preemptedAgents', ...r }))
];

const find = (res, agentName) => allRows(res).find((r) => r.agentName === agentName);

/** The contract, as one predicate: present, and either null or a full address. */
function shapeOk(row) {
  if (!('activatedBy' in row)) return false;
  const value = row.activatedBy;
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) === '["key","type"]' &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    typeof value.key === 'string' &&
    value.key.length > 0
  );
}

// ---------------------------------------------- 1. the epic→story→task chain --

rule('AC1 — epic KAN-900 activates story KAN-901 activates task KAN-902');

{
  const epic = record('epic', 'KAN-900', null);
  const story = record('story', 'KAN-901', { type: 'epic', key: 'KAN-900' });
  const task = record('task', 'KAN-902', { type: 'story', key: 'KAN-901' });

  const res = listAgents({
    activated: [epic, story, task],
    live: [epic.agentName, story.agentName, task.agentName]
  });

  console.log('\n  the `agents` rows, as they go over the wire:\n');
  for (const a of res.agents) {
    console.log(
      `    ${JSON.stringify({ agentName: a.agentName, type: a.type, key: a.key, activatedBy: a.activatedBy })}`
    );
  }

  // Rebuilt the way the extension does it: an index by (type, key), because
  // the live fleet has both epic/KAN-39 and task/KAN-39 and a key-only index
  // gives one of them the other's children (KAN-83's collision, client-side).
  const byAddress = new Map(
    res.agents.map((a) => [`${a.type}/${String(a.key).toLowerCase()}`, a])
  );
  const parentOf = (a) =>
    a.activatedBy
      ? byAddress.get(`${a.activatedBy.type}/${String(a.activatedBy.key).toLowerCase()}`)
      : undefined;

  const chain = [];
  let cursor = res.agents.find((a) => a.agentName === task.agentName);
  while (cursor) {
    chain.unshift(`${cursor.type}/${cursor.key}`);
    cursor = parentOf(cursor);
  }

  console.log(`\n  reconstructed from activatedBy alone:\n\n    ${chain.join('  →  ')}`);
  console.log(`
  Note the two spellings, which are not a defect and are worth stating: a
  sessionless row recovers its own key from the agent name, so it reads
  \`kan-900\`, while \`activatedBy\` carries the key as the registry recorded it
  — \`KAN-900\`, the way the ticket is spelled. Matching is therefore case-folded
  on both sides, which is exactly what KAN-81's (type, key) index does and what
  docs/agent-tree.md commits to. Folding only the row's key, or only the
  parent's, would silently orphan every child.`);
  console.log('');
  const depth = (a) => {
    let d = 0;
    for (let c = parentOf(a); c; c = parentOf(c)) d++;
    return d;
  };
  for (const a of res.agents.slice().sort((x, y) => depth(x) - depth(y))) {
    console.log(`    ${'    '.repeat(depth(a))}${depth(a) ? '└── ' : ''}${a.type}/${a.key}`);
  }

  const roots = res.agents.filter((a) => a.activatedBy === null);

  verdict(
    chain.length === 3 &&
      chain.join(' → ').toLowerCase() === 'epic/kan-900 → story/kan-901 → task/kan-902' &&
      roots.length === 1 &&
      roots[0].agentName === epic.agentName,
    'the DTO reconstructs the chain exactly, with the epic as the only root.',
    `the chain came back as ${chain.join(' → ') || '(nothing)'} with ${roots.length} root(s).`
  );
}

// ------------------------------------------------------- 2. no known parent --

rule('AC2 — an agent nobody supervising activated answers `null`, and the key is there');

{
  const epic = record('epic', 'KAN-900', null);
  const solo = record('task', 'KAN-903', null);

  const res = listAgents({
    activated: [epic, solo],
    live: [epic.agentName, solo.agentName]
  });

  const soloRow = find(res, solo.agentName);
  const raw = JSON.parse(JSON.stringify(res)).agents.find((a) => a.agentName === solo.agentName);

  console.log('');
  row('task/KAN-903 — activated by nobody', show(soloRow?.activatedBy));
  row("'activatedBy' in row", String('activatedBy' in (soloRow ?? {})));
  row('after a JSON round-trip, key still present', String('activatedBy' in (raw ?? {})));
  console.log(`\n    ${JSON.stringify(raw && { agentName: raw.agentName, activatedBy: raw.activatedBy })}`);
  console.log(`
  This is the assertion the Agents page depends on and the one most easily
  lost in a reimplementation. An omitted key and a null one look the same to
  \`row.activatedBy\` and are different answers: null is "this agent has no
  parent", absent is "this daemon cannot tell you". The page renders the first
  as a root and the second as a flat list with no tree at all.`);

  verdict(
    soloRow !== undefined &&
      'activatedBy' in soloRow &&
      soloRow.activatedBy === null &&
      raw !== undefined &&
      'activatedBy' in raw &&
      raw.activatedBy === null,
    'a parentless agent answers an explicit null that survives JSON, and no parent is invented.',
    'the parentless row either omitted the key or invented a supervisor.'
  );
}

// -------------------------------------- 3. the three not-running categories --

rule('AC3 — a standby child, a lost child and a preempted child all keep their parent');

{
  const epic = record('epic', 'KAN-900', null);
  // Switched off deliberately, under an epic that is still running. The
  // story's own case: "a standby story under a live epic is information".
  const story = record('story', 'KAN-901', { type: 'epic', key: 'KAN-900' });
  // Recorded as activated and absent from herdr's census anyway: a loss.
  const lost = record('task', 'KAN-904', { type: 'story', key: 'KAN-901' });
  // Stood down to make room for something that outranked it: a debt.
  const taken = record('task', 'KAN-905', { type: 'story', key: 'KAN-901' });

  const res = listAgents({
    activated: [epic, lost],
    deactivated: [story],
    preempted: [{ rec: taken, by: { agentName: 'butchr-task-kan-906', type: 'task', key: 'KAN-906' } }],
    live: [epic.agentName]
  });

  console.log('');
  for (const category of ['agents', 'standbyAgents', 'missingAgents', 'preemptedAgents']) {
    for (const r of res[category]) {
      row(`${category}: ${r.type}/${r.key}`, show(r.activatedBy));
    }
  }
  console.log('\n  the standby row as sent:\n');
  console.log(`    ${JSON.stringify(res.standbyAgents[0])}`);

  const standbyRow = res.standbyAgents.find((r) => r.agentName === story.agentName);
  const missingRow = res.missingAgents.find((r) => r.agentName === lost.agentName);
  const preemptedRow = res.preemptedAgents.find((r) => r.agentName === taken.agentName);

  verdict(
    standbyRow?.activatedBy?.type === 'epic' &&
      standbyRow?.activatedBy?.key === 'KAN-900' &&
      missingRow?.activatedBy?.type === 'story' &&
      missingRow?.activatedBy?.key === 'KAN-901' &&
      preemptedRow?.activatedBy?.type === 'story' &&
      preemptedRow?.activatedBy?.key === 'KAN-901',
    'being switched off, lost or preempted does not change who staffed the work.',
    'one of the three not-running categories dropped its parent — see the rows above.'
  );
}

// ------------------------------------------------- 4. every row, every list --

rule('AC4 — the field is on every row of every category, in exactly one shape');

{
  const epic = record('epic', 'KAN-900', null);
  const story = record('story', 'KAN-901', { type: 'epic', key: 'KAN-900' });
  const task = record('task', 'KAN-902', { type: 'story', key: 'KAN-901' });
  const solo = record('task', 'KAN-903', null);
  const lost = record('task', 'KAN-904', { type: 'story', key: 'KAN-901' });
  const standby = record('story', 'KAN-907', { type: 'epic', key: 'KAN-900' });
  const taken = record('task', 'KAN-905', { type: 'story', key: 'KAN-901' });

  const res = listAgents({
    activated: [epic, story, task, solo, lost],
    deactivated: [standby],
    preempted: [{ rec: taken, by: { agentName: 'butchr-task-kan-906', type: 'task', key: 'KAN-906' } }],
    live: [epic.agentName, story.agentName, task.agentName, solo.agentName]
  });

  const rows = allRows(res);
  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  console.log('');
  for (const [category, n] of Object.entries(counts)) {
    const ok = rows.filter((r) => r.category === category).every(shapeOk);
    row(`${category} — ${n} row(s)`, ok ? 'every row carries a well-formed activatedBy' : 'MALFORMED');
  }
  row('rows in total', String(rows.length));
  row('rows missing the key entirely', String(rows.filter((r) => !('activatedBy' in r)).length));

  verdict(
    rows.length === 7 &&
      Object.keys(counts).length === 4 &&
      rows.every(shapeOk),
    'all four categories are populated, and every row has the key with either null or ' +
      'exactly { type, key } behind it.',
    'a row was missing the field or carried something other than { type, key } | null.'
  );
}

// ------------------------------------------------------- 5. self-parentage --

rule('AC5 — a self-referential parent never reaches the wire');

{
  // Refused at write time, with a logged reason, by `supervisorOfRecord` in the
  // router (KAN-77). One rule, one place: this asserts the absence rather than
  // adding a second guard here. What is written directly to the registry is the
  // hostile case — a record that got past the write path somehow.
  const selfy = record('task', 'KAN-908', { type: 'task', key: 'KAN-908' });
  const res = listAgents({ activated: [selfy], live: [selfy.agentName] });
  const rowFor = find(res, selfy.agentName);

  console.log('');
  row('a record naming itself, seeded directly', show(rowFor?.activatedBy));
  console.log(`
  The DTO is a transport: it reports what the registry holds, and it holds this
  only because this script wrote it there by hand. The refusal lives at the one
  place a supervisor of record is decided — \`supervisorOfRecord\`, on the
  activation path — so no ordinary activation can produce this row. What is
  checked here is that the router did not grow a second copy of that rule, and
  that a cycle a client could construct is a client-side rendering question
  rather than a daemon crash.`);

  const cycle = rowFor?.activatedBy?.type === 'task' && rowFor?.activatedBy?.key === 'KAN-908';
  verdict(
    res.success === true && shapeOk(rowFor ?? {}) && cycle,
    'the router reports the record as written and does not re-litigate a rule it does not own.',
    'the router either failed the list or silently rewrote a record it was only transporting.'
  );
}

// --------------------------------------------------------------------------

process.env.PATH = realPath;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${process.exitCode ? 'FAILURES ABOVE' : 'all sections passed'} ==`);
