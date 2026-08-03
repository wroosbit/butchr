// Proof for KAN-46: the `epic` workspace type exists, `manage` does not, and
// the priority scale reads epic 3 > story 2 > task 1 off the real registry.
//
// Three sections, one per acceptance criterion:
//
//   1. issue-type refinement — an Epic issue resolves to an `epic` workspace,
//                              a Story to `story`, a Task to `task`, and a
//                              lookup that throws still degrades to `task`
//   2. board URLs            — a bare board URL resolves to nothing, while the
//                              &selectedIssue= form still resolves as an issue
//   3. the scale             — epic 3 > story 2 > task 1, read back from
//                              priorityFor(), and epic-versus-epic is a refusal
//
// Every section drives the real WorkspaceRegistry carrying the real Jira
// integration; only the IssueTypeLookup is stubbed, because Jira's answer to
// "what type is this issue?" is the one thing resolution asks anything else.
//
// Usage: node daemon/scripts/verify-per-epic-supervision.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { PRIORITY_EPIC, PRIORITY_STORY, PRIORITY_TASK, outranks } =
  await import(path.join(distDir, 'priority.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

/**
 * The production registry for this proof: empty, then filled by the Atlassian
 * integration and switched on.
 *
 * Its enabled state goes to a throwaway file — a proof script must not write
 * into the machine's real ~/.local/share/butchr/integrations.json, nor depend
 * on what is recorded there.
 */
const atlassianRegistry = (issueTypeLookup) => {
  const registry = new WorkspaceRegistry(
    new IntegrationStateStore(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-state-')), 'integrations.json')
    )
  );
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup }));
  registry.setEnabled('jira', true);
  return registry;
};

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const ISSUE_URL = 'https://wroosbit.atlassian.net/browse/KAN-46';
const BOARD_URL = 'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2';
const BOARD_WITH_ISSUE_URL =
  'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2?selectedIssue=KAN-5';

const show = (resolved) =>
  resolved ? `{ type: '${resolved.config.type}', key: '${resolved.key}' }` : 'null';

// ------------------------------------ 1. issue-type refinement, and failure --

rule('AC1 — a Jira issue URL resolves by the issue\'s real type, degrading to task');

console.log(`\n  resolving ${ISSUE_URL}\n  against four different Jira answers:\n`);

const cases = [
  { label: 'lookup answers "Epic"  ', lookup: async () => 'Epic', want: { type: 'epic', key: 'KAN-46' } },
  { label: 'lookup answers "Story" ', lookup: async () => 'Story', want: { type: 'story', key: 'KAN-46' } },
  { label: 'lookup answers "Task"  ', lookup: async () => 'Task', want: { type: 'task', key: 'KAN-46' } },
  {
    label: 'lookup rejects         ',
    lookup: async () => { throw new Error('stub: Jira is unreachable'); },
    want: { type: 'task', key: 'KAN-46' }
  }
];

let ac1Ok = true;
for (const { label, lookup, want } of cases) {
  const registry = atlassianRegistry(lookup);
  const resolved = await registry.resolve(ISSUE_URL);
  const ok =
    resolved !== null && resolved.config.type === want.type && resolved.key === want.key;
  ac1Ok &&= ok;
  console.log(`  ${label} → ${show(resolved)}${ok ? '' : `   (expected ${want.type}/${want.key})`}`);
}

verdict(
  ac1Ok,
  'Epic → epic, Story → story, Task → task, and a throwing lookup lands on task.',
  'an issue URL resolved to the wrong workspace type — see the rows above.'
);

// ------------------------------------------------------------ 2. board URLs --

rule('AC2 — a board URL resolves to nothing; an opened issue on a board still resolves');

const registry = atlassianRegistry(async () => 'Task');
const board = await registry.resolve(BOARD_URL);
const opened = await registry.resolve(BOARD_WITH_ISSUE_URL);

console.log(`\n  bare board page      ${BOARD_URL}\n                       → ${show(board)}`);
console.log(`\n  issue opened on it   ${BOARD_WITH_ISSUE_URL}\n                       → ${show(opened)}`);

verdict(
  board === null && opened !== null && opened.config.type === 'task' && opened.key === 'KAN-5',
  'no workspace type claims a board page, and &selectedIssue= still resolves the issue.',
  'a board URL resolved to something, or the &selectedIssue= form stopped resolving.'
);

// -------------------------------------------------------------- 3. the scale --

rule('AC3 — epic 3 > story 2 > task 1, read back from the registry, and epic never displaces epic');

const p = {
  epic: registry.priorityFor('epic'),
  story: registry.priorityFor('story'),
  task: registry.priorityFor('task')
};

console.log('');
for (const [type, priority] of Object.entries(p)) {
  console.log(`  priorityFor('${type}')${' '.repeat(6 - type.length)} = ${priority}`);
}
const epicVsEpic = outranks(PRIORITY_EPIC, PRIORITY_EPIC);
console.log(`\n  outranks(PRIORITY_EPIC, PRIORITY_EPIC) = ${epicVsEpic}`);

verdict(
  p.epic === PRIORITY_EPIC &&
    p.story === PRIORITY_STORY &&
    p.task === PRIORITY_TASK &&
    p.epic > p.story &&
    p.story > p.task &&
    epicVsEpic === false,
  'the registry answers epic 3 > story 2 > task 1, and epic-versus-epic is a refusal.',
  'the scale read back from the registry is not epic 3 > story 2 > task 1 with strict outranking.'
);

console.log('\n== done ==');
