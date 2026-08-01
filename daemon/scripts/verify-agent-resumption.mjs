#!/usr/bin/env node
// Verifies the parts of KAN-21 that can be checked without rebooting the host.
//
// The reboot proof is the one this cannot stand in for, and the ticket says so
// explicitly: a simulated daemon restart is not evidence for a power cut. What
// this DOES establish is every property the reboot proof depends on — that the
// registry survives an unclean death, that a torn tail does not destroy it,
// that intent is honoured rather than history, and that the resume framing
// differs correctly between a restorable and an unrestorable conversation.
//
//   node daemon/scripts/verify-agent-resumption.mjs
//
// Run from the repo root, after `cd daemon && npx tsc`.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../dist');

const { AgentRegistry } = await import(path.join(dist, 'agent-registry.js'));
const {
  hasRestorableConversation,
  claudeTranscriptDir,
  degradedResumePrompt,
  resumeNudge,
  RESUME_ENV
} = await import(path.join(dist, 'resume.js'));
const { AGENT_LAUNCHERS } = await import(path.join(dist, 'launchers.js'));

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message.split('\n').join('\n        ')}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan21-'));
const registryFile = path.join(tmp, 'agents.jsonl');
const record = (key, extra = {}) => ({
  agentName: `butchr-task-${key}`,
  type: 'task',
  key,
  workDir: path.join(tmp, 'workspaces', 'task', key),
  ...extra
});

// ---------------------------------------------------------------------------
section('1. The registry records intent, not history');

check('an activated agent is expected', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-1'));
  assert.deepStrictEqual(
    reg.expected().map((r) => r.agentName),
    ['butchr-task-kan-1']
  );
});

check('a deactivated agent is NOT expected — a stand-down stays down', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  reg.recordDeactivated(record('kan-2'));
  const expected = reg.expected().map((r) => r.agentName);
  assert.ok(!expected.includes('butchr-task-kan-2'), `still expected: ${expected.join(', ')}`);
});

check('re-activating after a deactivate brings it back', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  assert.ok(reg.expected().some((r) => r.agentName === 'butchr-task-kan-2'));
});

check('the full activation argument list round-trips', () => {
  const reg = new AgentRegistry(registryFile);
  const original = record('kan-3', {
    url: 'https://example.atlassian.net/browse/KAN-3',
    defaultAgent: 'claude',
    mcpServers: ['atlassian', 'butchr']
  });
  reg.recordActivated(original);
  const restored = reg.expected().find((r) => r.agentName === 'butchr-task-kan-3');
  assert.deepStrictEqual(restored, original);
});

// ---------------------------------------------------------------------------
section('2. The on-disk format survives an unclean shutdown');

check('every record is fsync-durable and readable by a fresh reader', () => {
  const fresh = new AgentRegistry(registryFile);
  const names = fresh.expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, ['butchr-task-kan-1', 'butchr-task-kan-2', 'butchr-task-kan-3']);
});

check('a torn final line loses only the record that was in flight', () => {
  const torn = path.join(tmp, 'torn.jsonl');
  const reg = new AgentRegistry(torn);
  reg.recordActivated(record('kan-10'));
  reg.recordActivated(record('kan-11'));
  reg.recordActivated(record('kan-12'));

  // Exactly what a power cut mid-write leaves: a partial final record.
  const text = fs.readFileSync(torn, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const half = lines[lines.length - 1].slice(0, Math.floor(lines[lines.length - 1].length / 2));
  fs.writeFileSync(torn, lines.slice(0, -1).join('\n') + '\n' + half);

  const names = new AgentRegistry(torn).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(
    names,
    ['butchr-task-kan-10', 'butchr-task-kan-11'],
    'the two complete records before the tear must survive intact'
  );
});

check('a torn DEACTIVATE leaves the agent expected — it fails safe, not silent', () => {
  const torn = path.join(tmp, 'torn-deactivate.jsonl');
  const reg = new AgentRegistry(torn);
  reg.recordActivated(record('kan-20'));
  reg.recordDeactivated(record('kan-20'));

  const lines = fs.readFileSync(torn, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(torn, lines[0] + '\n' + lines[1].slice(0, 20));

  const names = new AgentRegistry(torn).expected().map((r) => r.agentName);
  assert.deepStrictEqual(
    names,
    ['butchr-task-kan-20'],
    'losing a stand-down must leave the agent visible as expected, never vanish it'
  );
});

check('garbage in the middle of the log does not discard the records around it', () => {
  const messy = path.join(tmp, 'messy.jsonl');
  const reg = new AgentRegistry(messy);
  reg.recordActivated(record('kan-30'));
  const body = fs.readFileSync(messy, 'utf8');
  fs.writeFileSync(messy, body + '{ not json at all\n');
  const reg2 = new AgentRegistry(messy);
  reg2.recordActivated(record('kan-31'));
  const names = new AgentRegistry(messy).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, ['butchr-task-kan-30', 'butchr-task-kan-31']);
});

check('a missing registry file is an empty fleet, not an error', () => {
  assert.deepStrictEqual(new AgentRegistry(path.join(tmp, 'nope.jsonl')).expected(), []);
});

check('compaction preserves intent and drops the history', () => {
  const busy = path.join(tmp, 'busy.jsonl');
  const reg = new AgentRegistry(busy);
  for (let i = 0; i < 20; i++) {
    reg.recordActivated(record('kan-40'));
    reg.recordDeactivated(record('kan-40'));
  }
  reg.recordActivated(record('kan-41'));
  const before = fs.readFileSync(busy, 'utf8').split('\n').filter(Boolean).length;
  reg.compact();
  const after = fs.readFileSync(busy, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(after < before, `compaction did not shrink the log (${before} → ${after})`);
  assert.deepStrictEqual(
    new AgentRegistry(busy).expected().map((r) => r.agentName),
    ['butchr-task-kan-41']
  );
});

// A real SIGKILL, so no exit hook, no flush, no cleanup — the ticket's
// unclean-shutdown proof, in miniature and reproducibly.
check('SIGKILL mid-life leaves every acknowledged record on disk', () => {
  const killed = path.join(tmp, 'killed.jsonl');
  const script = `
    import { AgentRegistry } from ${JSON.stringify(path.join(dist, 'agent-registry.js'))};
    const reg = new AgentRegistry(${JSON.stringify(killed)});
    for (let i = 0; i < 5; i++) {
      reg.recordActivated({ agentName: 'butchr-task-kan-5' + i, type: 'task', key: 'kan-5' + i, workDir: '/tmp/w' + i });
    }
    import * as fs from 'fs';
    fs.writeFileSync(${JSON.stringify(path.join(tmp, 'killer.ready'))}, 'ok');
    setInterval(() => {}, 1000);
  `;
  const scriptPath = path.join(tmp, 'killer.mjs');
  const marker = path.join(tmp, 'killer.ready');
  fs.writeFileSync(scriptPath, script);

  // The wait-then-kill runs entirely inside one shell rather than in this
  // process: a synchronous poll here would block the event loop that has to
  // deliver the child's readiness, and the check would hang forever.
  execFileSync(
    'bash',
    [
      '-c',
      `"$1" "$2" >/dev/null 2>&1 & pid=$!; ` +
        `for _ in $(seq 1 200); do [ -f "$3" ] && break; sleep 0.1; done; ` +
        `kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 0`,
      'bash',
      process.execPath,
      scriptPath,
      marker
    ],
    { timeout: 60_000 }
  );

  assert.ok(fs.existsSync(marker), 'child never reported its writes');

  const names = new AgentRegistry(killed).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, [
    'butchr-task-kan-50', 'butchr-task-kan-51', 'butchr-task-kan-52',
    'butchr-task-kan-53', 'butchr-task-kan-54'
  ]);
});

// ---------------------------------------------------------------------------
section('3. Resume framing differs by whether a conversation survived');

const withHistory = path.join(tmp, 'ws-with-history');
const withoutHistory = path.join(tmp, 'ws-without-history');
fs.mkdirSync(withHistory, { recursive: true });
fs.mkdirSync(withoutHistory, { recursive: true });

check('a workspace with no transcript has nothing to restore', () => {
  assert.strictEqual(hasRestorableConversation(withoutHistory), false);
});

check('a workspace with a non-empty transcript has something to restore', () => {
  const dir = claudeTranscriptDir(withHistory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), '{"type":"user"}\n');
  try {
    assert.strictEqual(hasRestorableConversation(withHistory), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('an empty transcript file does not count as restorable', () => {
  const dir = claudeTranscriptDir(withHistory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), '');
  try {
    assert.strictEqual(hasRestorableConversation(withHistory), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('the transcript path matches Claude Code\'s own mangling', () => {
  assert.strictEqual(
    claudeTranscriptDir('/home/someone/.local/share/butchr/workspaces/task/kan-21'),
    path.join(
      os.homedir(),
      '.claude/projects/-home-someone--local-share-butchr-workspaces-task-kan-21'
    )
  );
});

check('the degraded prompt tells the agent it lost its memory and points at the ticket', () => {
  const prompt = degradedResumePrompt('task', 'KAN-21');
  for (const phrase of ['NO memory', 'KAN-21', '.butchr-prompt.md', 'not restart the task']) {
    assert.ok(prompt.includes(phrase), `degraded prompt is missing ${JSON.stringify(phrase)}`);
  }
});

check('the nudge frames the interruption and forbids starting over', () => {
  const nudge = resumeNudge('task', 'KAN-21');
  for (const phrase of ['interrupted mid-work', 'KAN-21', 'Do not start over']) {
    assert.ok(nudge.includes(phrase), `nudge is missing ${JSON.stringify(phrase)}`);
  }
  assert.ok(!nudge.includes('\n'), 'the nudge is typed into a TUI and must be one line');
});

// ---------------------------------------------------------------------------
section('4. The launcher carries the resume framing into the pane');

check('the claude launcher still tries --continue first', () => {
  const command = AGENT_LAUNCHERS.claude.command();
  assert.ok(command.startsWith('claude --permission-mode bypassPermissions --continue ||'), command);
});

check('a degraded prompt reaches the fallback, correctly quoted', () => {
  const prompt = degradedResumePrompt('task', 'KAN-21');
  const command = AGENT_LAUNCHERS.claude.command(prompt);
  assert.ok(command.includes("'"), 'the prompt must be single-quoted for bash');
  const quoted = command.slice(command.indexOf('||') + 2);
  assert.ok(quoted.includes('NO memory'), 'the degraded framing did not reach the fallback');
});

check('a prompt containing a single quote cannot break out of the quoting', () => {
  const command = AGENT_LAUNCHERS.claude.command(`don't; rm -rf /`);
  // Everything after the fallback's flags must be one quoted word; the escape
  // sequence for an embedded quote is close-escape-reopen.
  assert.ok(command.includes(`'don'\\''t; rm -rf /'`), command);
});

check('the resume modal thresholds are raised past any real conversation', () => {
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES) > 70 * 1000);
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD) > 100_000 * 1000);
});

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.log(`${failures} FAILED.`);
  process.exit(1);
}
