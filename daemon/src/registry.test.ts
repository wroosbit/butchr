import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceRegistry } from './registry.js';
import { WORKSPACES_ROOT, expandHome, isInsideWorkspacesRoot, resolveWorkDir } from './workspaces.js';

const BOARD_URL = 'https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2?filter=&groupBy=none';

function resolve(url: string) {
  const resolved = new WorkspaceRegistry().resolve(url);
  return resolved ? { type: resolved.config.type, key: resolved.key } : null;
}

test('a Jira board page resolves to the singleton manage agent', () => {
  assert.deepEqual(resolve(BOARD_URL), { type: 'manage', key: 'work' });
});

test('every board resolves to the same key, whatever the project or board id', () => {
  assert.deepEqual(
    resolve('https://example.atlassian.net/jira/software/projects/OPS/boards/17'),
    { type: 'manage', key: 'work' }
  );
});

test('an issue page still resolves to task', () => {
  assert.deepEqual(resolve('https://wroosbit.atlassian.net/browse/ABC-1'), {
    type: 'task',
    key: 'ABC-1'
  });
});

// Regression cover for the KAN-15 behavior this ticket must not disturb: adding
// a workDir to the `manage` type must not move which type a URL resolves to.
test('a board URL selecting an issue is about the issue, not the board', () => {
  // Registration order is what decides this: `task` is registered first, so it
  // gets first crack at a URL both types match.
  assert.deepEqual(resolve(`${BOARD_URL}&selectedIssue=KAN-5`), {
    type: 'task',
    key: 'KAN-5'
  });
  assert.deepEqual(
    resolve('https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2?selectedIssue=KAN-5'),
    { type: 'task', key: 'KAN-5' }
  );
});

test('the manage type runs in the home directory', () => {
  const config = new WorkspaceRegistry().get('manage');
  assert.ok(config);
  assert.equal(config.workDir, '~');
  assert.equal(resolveWorkDir('manage', 'work', config.workDir), os.homedir());
});

test('a type without a workDir keeps the per-key workspace directory', () => {
  assert.equal(
    resolveWorkDir('task', 'KAN-1'),
    path.join(WORKSPACES_ROOT, 'task', 'kan-1')
  );
});

test('expandHome only expands a leading ~', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/code'), path.join(os.homedir(), 'code'));
  assert.equal(expandHome('/tmp/scratch'), '/tmp/scratch');
  // Not a home reference: `~foo` is a literal directory name here.
  assert.equal(expandHome('~foo'), '~foo');
});

test('only directories strictly inside the workspaces root are deletable', () => {
  // A normal task workspace: deletable, which is the whole point of the guard
  // not being a blanket refusal.
  assert.equal(isInsideWorkspacesRoot(path.join(WORKSPACES_ROOT, 'task', 'kan-1')), true);
  assert.equal(isInsideWorkspacesRoot(path.join(WORKSPACES_ROOT, 'task', 'kan-1', 'butchr')), true);

  // The home directory — where `manage` runs.
  assert.equal(isInsideWorkspacesRoot(os.homedir()), false);
  // The workspaces root itself: deleting it would take every other agent's
  // workspace with it.
  assert.equal(isInsideWorkspacesRoot(WORKSPACES_ROOT), false);
  // A sibling whose path merely starts with the same characters.
  assert.equal(isInsideWorkspacesRoot(`${WORKSPACES_ROOT}-backup`), false);
  // Anywhere else at all.
  assert.equal(isInsideWorkspacesRoot('/'), false);
  assert.equal(isInsideWorkspacesRoot('/tmp'), false);
  assert.equal(isInsideWorkspacesRoot(path.join(os.homedir(), '.claude')), false);
});

test('a workspace path that escapes via .. or a symlink is not deletable', () => {
  assert.equal(isInsideWorkspacesRoot(path.join(WORKSPACES_ROOT, 'task', '..', '..', '..')), false);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-guard-'));
  const link = path.join(WORKSPACES_ROOT, `escape-${process.pid}`);
  try {
    fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
    fs.symlinkSync(scratch, link, 'dir');
    // Lexically inside the root, but the symlink lands outside it.
    assert.equal(isInsideWorkspacesRoot(link), false);
  } finally {
    try { fs.unlinkSync(link); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
