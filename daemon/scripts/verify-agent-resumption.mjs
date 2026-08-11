#!/usr/bin/env node
// Verifies the parts of KAN-21 that can be checked without rebooting the host.
//
// WHAT FAILURE THIS WOULD CATCH: a registry that does not survive an unclean
// death — a torn tail destroying the whole file, history being replayed where
// intent should be honoured, or a wait budget computed from the wall clock,
// which a clock adjustment mid-wait turns into a hang no timeout ever ends.
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
  // Part of the activation argument list since KAN-77, and always present:
  // `null` is the answer for an agent nobody's activation started, and the
  // registry normalises a record without the key to exactly this on the way
  // back in — which is what the round-trip check below is asserting.
  activatedBy: null,
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
  const { command } = AGENT_LAUNCHERS.claude.command();
  assert.ok(command.startsWith('claude --permission-mode bypassPermissions --continue ||'), command);
});

check('a degraded prompt reaches the fallback, correctly quoted', () => {
  const prompt = degradedResumePrompt('task', 'KAN-21');
  const { command } = AGENT_LAUNCHERS.claude.command(prompt);
  assert.ok(command.includes("'"), 'the prompt must be single-quoted for bash');
  const quoted = command.slice(command.indexOf('||') + 2);
  assert.ok(quoted.includes('NO memory'), 'the degraded framing did not reach the fallback');
});

check('a prompt containing a single quote cannot break out of the quoting', () => {
  const { command } = AGENT_LAUNCHERS.claude.command(`don't; rm -rf /`);
  // Everything after the fallback's flags must be one quoted word; the escape
  // sequence for an embedded quote is close-escape-reopen.
  assert.ok(command.includes(`'don'\\''t; rm -rf /'`), command);
});

check('the resume modal thresholds are raised past any real conversation', () => {
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES) > 70 * 1000);
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD) > 100_000 * 1000);
});

// ---------------------------------------------------------------------------
section('6. A session is not proof that an agent is alive');

// The defect these cover was found in this code, by the reboot it was written
// for. An agent was restored at boot, died later, and `list_agents` went on
// reporting it `active` with `missingAgents: []` — because the census counted
// any session this daemon held, without asking herdr whether the agent behind
// it still existed. A dead agent that reports as healthy is the silent loss
// this whole ticket exists to remove, so it must not survive here.

const { MessageRouter } = await import(path.join(dist, 'router.js'));

/** A router wired to a herdr that says exactly what a test wants it to say. */
function routerWith({ sessions, herdr, reachable = true, registry }) {
  const herdrBridge = {
    listActiveSessions: () => sessions,
    listHerdrAgentsChecked: () => ({ reachable, agents: herdr }),
    listHerdrAgents: () => herdr,
    listHerdrStatuses: () => new Map(herdr.map((a) => [a.name, a.herdrStatus]))
  };
  return new MessageRouter(null, null, herdrBridge, () => {}, () => {}, { agentRegistry: registry });
}

const session = (key) => ({
  sessionId: `task-${key}-1`,
  type: 'task',
  key,
  url: null,
  createdAt: new Date(0),
  status: 'active',
  workDir: path.join(tmp, 'workspaces', 'task', key)
});

const herdrAgent = (key, agentRuntime = 'claude') => ({
  name: `butchr-task-${key}`,
  agentRuntime,
  workDir: path.join(tmp, 'workspaces', 'task', key),
  herdrStatus: 'working'
});

function registryExpecting(...keys) {
  const file = path.join(tmp, `reg-${keys.join('-')}-${Math.random()}.jsonl`);
  const reg = new AgentRegistry(file);
  for (const key of keys) reg.recordActivated(record(key));
  return reg;
}

check('an agent herdr no longer has is missing, even while its session lingers', () => {
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [], // herdr answered, and it has never heard of this agent
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.strictEqual(missing.length, 1, `expected 1 missing, got ${JSON.stringify(missing)}`);
  assert.strictEqual(missing[0].agentName, 'butchr-task-kan-21');
});

check('the reason says it started and died, not that it never existed', () => {
  const [missing] = routerWith({
    sessions: [session('kan-21')],
    herdr: [],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.ok(/started and then died/.test(missing.reason), missing.reason);
});

check('a pane whose agent runtime has exited is missing too', () => {
  // herdr knows the name but nothing is running in the pane — the same
  // emptiness, reported one layer down.
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [herdrAgent('kan-21', null)],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.strictEqual(missing.length, 1, JSON.stringify(missing));
});

check('a shell workspace with no runtime is working as asked, not missing', () => {
  // The one case where an empty pane is the product rather than the failure.
  // Reporting it would be a false alarm about something doing its job.
  const file = path.join(tmp, 'reg-shell.jsonl');
  const reg = new AgentRegistry(file);
  reg.recordActivated(record('kan-21', { defaultAgent: 'shell' }));

  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [herdrAgent('kan-21', null)],
    registry: reg
  }).findMissingAgents();

  assert.deepStrictEqual(missing, [], 'a shell workspace must not be reported dead');
});

check('a healthy agent is not reported missing', () => {
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [herdrAgent('kan-21')],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.deepStrictEqual(missing, []);
});

check('an unreachable herdr condemns nobody — silence is not evidence of death', () => {
  // The trap: an unreachable herdr returns an empty census, which looks
  // identical to "every agent is gone". Acting on it would declare a whole
  // healthy fleet dead the moment herdr hiccups.
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [],
    reachable: false,
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.deepStrictEqual(missing, [], 'an unreachable herdr must not condemn a live agent');
});

check('a deliberately stood-down agent is not reported missing', () => {
  const file = path.join(tmp, 'reg-standdown.jsonl');
  const reg = new AgentRegistry(file);
  reg.recordActivated(record('kan-21'));
  reg.recordDeactivated({ agentName: 'butchr-task-kan-21', type: 'task', key: 'kan-21' });

  const missing = routerWith({ sessions: [], herdr: [], registry: reg }).findMissingAgents();
  assert.deepStrictEqual(missing, [], 'a stand-down must stay down, not become an alarm');
});

// ---------------------------------------------------------------------------
section('7. Waiting budgets survive a suspend');

check('the restore wait is monotonic, so sleeping through it does not consume it', () => {
  // On the reboot this ticket was proved by, the laptop suspended 1.5s into
  // the first restore and woke 5h40m later. A Date.now() deadline had expired
  // without a single poll after resume, so a restored agent was written off as
  // "never reached a prompt" and never nudged. CLOCK_MONOTONIC excludes
  // suspended time, which is the only reading of "120 seconds" that means
  // anything to an agent that was asleep for most of them.
  // Both budgets, wherever they live. The agent-ready wait moved to nudge.js
  // in KAN-37, because a preempted agent that is switched back on needs the
  // same "wait for a prompt, then tell it it was interrupted" that a restored
  // one does — and reconciliation is no longer the only caller. The property
  // asserted here is about the two waits, not about which file holds them, so
  // it is checked across both rather than pinned to one.
  const src = ['reconcile.js', 'nudge.js']
    .map((file) => fs.readFileSync(path.join(dist, file), 'utf8'))
    .join('\n');
  // Matched on the deadline arithmetic rather than on any mention of the two
  // clocks, so that the comment explaining why the wall clock is wrong here
  // cannot itself fail the check.
  assert.ok(
    !/deadline\s*=\s*Date\.now\(\)/.test(src),
    'a wait deadline is still computed from the wall clock'
  );
  // Three since KAN-77 added a third wait to nudge.js: after a nudge is typed,
  // the sender watches the pane until the message appears as submitted output.
  // That budget bounds waiting exactly as the other two do, so a suspend must
  // not consume it either.
  const monotonicDeadlines = src.match(/deadline\s*=\s*monotonicNow\(\)/g) ?? [];
  assert.strictEqual(
    monotonicDeadlines.length,
    3,
    `expected every wait budget (herdr-ready, agent-ready, delivery-confirm) to be ` +
    `monotonic, found ${monotonicDeadlines.length}`
  );
  assert.ok(/performance\.now\(\)/.test(src), 'the waits do not use a monotonic clock');
});

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.log(`${failures} FAILED.`);
  process.exit(1);
}
