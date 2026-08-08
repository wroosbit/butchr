// Live proof for KAN-84: an activation whose brief cannot be written is
// refused — never a `success: true, verified: true` answer wrapped around an
// agent that booted with no instructions.
//
// WHAT FAILURE THIS WOULD CATCH: an activation whose brief could not be
// written answering `success: true, verified: true` — an agent that came up
// with no instructions at all, "verified" only in the sense that a live
// runtime exists behind the name.
//
// The ticket's symptom: when the `.butchr-prompt.md` write failed, initPty
// logged `Failed to write prompt file` and fell through to spawn. The agent
// came up, found no instructions, and the activation still answered
// `success: true, verified: true` — verified means "a live runtime exists",
// not "an instructed agent exists". Fifth generation of the
// failure-as-success lesson (KAN-23, KAN-53, KAN-54, KAN-58).
//
// Four sections:
//
//   1. unfixed   — the silent uninstructed start, reproduced: workDir
//                  unwritable, activate through a build of origin/main's
//                  herdr.ts → success: true, verified: true, an agent
//                  started, and no brief on disk
//   2. refused   — the same setup against the fixed build: success: false,
//                  the error names the prompt-file write and says it was
//                  retried, and nothing was started or recorded
//   3. restored  — writability back, the same key again: a normal instructed
//                  boot, so the refusal neither latched nor cost anything
//   4. no-brief  — an activation with no initialPrompt (the resume /
//                  brief-less launcher path) in a still-unwritable workspace
//                  boots exactly as before: nothing to write, nothing to
//                  refuse over
//
// Everything on the daemon side is real: the real MessageRouter, the real
// HerdrBridge (initPty and all), the real WorkspaceRegistry, PromptLoader and
// a real on-disk AgentRegistry. What is faked is the `herdr` binary itself: a
// shim on PATH that records every invocation — argv-exact — and answers in
// herdr's own JSON shapes without spawning anything. The recorded argv is the
// whole truth about what would have run, which is what lets sections 2 and 4
// say "nothing was started" / "started anyway" from evidence rather than
// inference. The failing write is real too: the workspace directory is made
// read-only on a real filesystem and fs.writeFileSync really fails.
//
// Isolation is by $HOME: workspaces derive from os.homedir(), so a temp HOME
// keeps this run out of ~/.local/share/butchr entirely, and no real herdr —
// live or private — is ever contacted.
//
// Usage:
//   cd daemon && npm run build
//   # the unfixed baseline for section 1: origin/main's herdr.ts, everything
//   # else current, built where node_modules still resolves
//   cp src/herdr.ts /tmp/kan84-herdr-fixed.ts
//   git show $(git merge-base HEAD origin/main):daemon/src/herdr.ts > src/herdr.ts
//   npx tsc --outDir dist-unfixed
//   cp /tmp/kan84-herdr-fixed.ts src/herdr.ts
//   node scripts/verify-prompt-write-refusal.mjs dist dist-unfixed
//
// Section 1 is skipped (with a note) when the unfixed dist is not supplied.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = path.resolve(scriptDir, '..', process.argv[2] ?? 'dist');
const unfixedDistDir = process.argv[3]
  ? path.resolve(scriptDir, '..', process.argv[3])
  : undefined;

const TYPE = 'task';

// A private HOME, before any dist import: workspace paths and the daemon's
// state dir all derive from os.homedir(), which reads $HOME at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan84-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

const workspaceFor = (key) =>
  path.join(fakeHome, '.local', 'share', 'butchr', 'workspaces', TYPE, key.toLowerCase());
const promptFileFor = (key) => path.join(workspaceFor(key), '.butchr-prompt.md');
/** Pre-provision a workspace directory that refuses every write. */
const makeUnwritable = (key) => {
  const dir = workspaceFor(key);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  return dir;
};
const restoreWritable = (key) => fs.chmodSync(workspaceFor(key), 0o755);

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH. Every invocation is appended, argv-exact,
// to invocations.jsonl; `agent start` additionally remembers the agent so
// `agent get` / `agent list` — and through them the existence check — see
// exactly the agents that were started and nothing else. `agent attach`
// holds its terminal open the way a real attach does, and is killed on exit.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN84_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN84_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, agent: 'claude', pane_id: '9' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: '9' } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
// A wrapper with this process's node baked in, so the shim never depends on
// what PATH resolves `node` to.
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const startsFor = (name) =>
  invocations().filter((argv) => argv[0] === 'agent' && argv[1] === 'start' && argv[2] === name);

// ------------------------------------------------------------- the harness --
//
// Two complete daemon stacks when an unfixed dist is supplied: one built from
// this branch, one from origin/main's herdr.ts. Each gets its own bridge,
// router and durable registry; they share the fake HOME and the shim, and
// every section uses its own key, so nothing bleeds between them.
async function harness(dir, registryFile) {
  const { HerdrBridge, agentNameFor } = await import(path.join(dir, 'herdr.js'));
  const { MessageRouter } = await import(path.join(dir, 'router.js'));
  const { WorkspaceRegistry } = await import(path.join(dir, 'registry.js'));
  const { PromptLoader } = await import(path.join(dir, 'prompt.js'));
  const { AgentRegistry } = await import(path.join(dir, 'agent-registry.js'));

  // Section 1's stack is built from an *older* dist, which is the point of this
  // script — and a dist from before KAN-85 has no atlassian-integration module:
  // its registry takes the lookup directly and registers Jira's types itself.
  // Either way the stack under test gets a registry that resolves a Jira issue
  // URL to `task`.
  const jiraRegistry = await (async () => {
    try {
      const { createAtlassianIntegration } = await import(
        path.join(dir, 'integrations', 'atlassian-integration.js')
      );
      const { IntegrationStateStore } = await import(
        path.join(dir, 'integrations', 'enablement.js')
      );
      return (issueTypeLookup) => {
        const registry = new WorkspaceRegistry(
          new IntegrationStateStore(path.join(scratch, `integrations-${registryFile}.json`))
        );
        registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup }));
        registry.setEnabled('jira', true);
        return registry;
      };
    } catch {
      return (issueTypeLookup) => new WorkspaceRegistry(issueTypeLookup);
    }
  })();

  const bridge = new HerdrBridge();
  const agentRegistry = new AgentRegistry(path.join(scratch, registryFile));
  let sent;
  const router = new MessageRouter(
    jiraRegistry(async () => 'Task'),
    new PromptLoader(repoRoot),
    bridge,
    (msg) => { sent = msg; },
    () => {},
    { agentRegistry }
  );

  // The capacity gate reads the real machine, and whether this box is busy
  // decides nothing about whether a brief can be written. The override path
  // is real, recorded, and what [Start anyway] sends.
  const activate = async (key) => {
    sent = undefined;
    await router.handleActivateByKey(
      { action: 'activate_by_key', type: TYPE, key, override: true },
      (msg) => { sent = msg; }
    );
    return sent;
  };

  return { bridge, agentRegistry, agentNameFor, activate };
}

const fixed = await harness(distDir, 'agents-fixed.jsonl');
const unfixed = unfixedDistDir ? await harness(unfixedDistDir, 'agents-unfixed.jsonl') : undefined;

const unwritableKeys = [];
function cleanup() {
  for (const h of [fixed, unfixed]) {
    if (!h) continue;
    for (const session of h.bridge.listActiveSessions()) {
      try { session.ptyProcess?.kill(); } catch {}
    }
  }
  // rmSync cannot empty a read-only directory; give the permissions back first.
  for (const key of unwritableKeys) {
    try { restoreWritable(key); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

console.log(`fake herdr: ${path.join(shimDir, 'herdr')} (records to ${shimState})`);
console.log(`HOME for this run: ${fakeHome}`);
console.log(`fixed dist:   ${distDir}`);
console.log(`unfixed dist: ${unfixedDistDir ?? '(not supplied — section 1 will be skipped)'}`);

// ------------------------------------------- 1. the silent uninstructed start --

rule("1. UNFIXED — origin/main's herdr.ts: the brief write fails, the agent starts anyway");

if (!unfixed) {
  console.log('   skipped: no unfixed dist supplied (see the usage block for how to build one)');
} else {
  const KEY = 'KAN-84-UNFIXED';
  unwritableKeys.push(KEY);
  const dir = makeUnwritable(KEY);
  console.log(`   workspace pre-provisioned read-only: ${dir}\n`);

  const res = await unfixed.activate(KEY);
  show('activate_by_key response:', {
    success: res?.success, verified: res?.verified, sessionId: res?.sessionId, error: res?.error
  });

  const name = unfixed.agentNameFor(TYPE, KEY);
  const started = startsFor(name);
  const briefOnDisk = fs.existsSync(promptFileFor(KEY));
  console.log(`\n   agent start invocations for ${name}: ${started.length}`);
  console.log(`   .butchr-prompt.md on disk: ${briefOnDisk}`);

  verdict(
    res?.success === true && res?.verified === true && started.length === 1 && !briefOnDisk,
    'the ticket\'s symptom, reproduced: an agent started with no brief on disk, behind success: true, verified: true',
    'the unfixed build did not reproduce the silent uninstructed start (already fixed?)'
  );
}

// --------------------------------------------------------- 2. fixed: refused --

rule('2. FIXED — the same unwritable workspace: refused, the write named, nothing started');

const DENIED = 'KAN-84-DENIED';
unwritableKeys.push(DENIED);
const deniedDir = makeUnwritable(DENIED);
console.log(`   workspace pre-provisioned read-only: ${deniedDir}\n`);

const denied = await fixed.activate(DENIED);
show('activate_by_key response:', denied);

const deniedName = fixed.agentNameFor(TYPE, DENIED);
const deniedStarts = startsFor(deniedName);
const deniedBrief = fs.existsSync(promptFileFor(DENIED));
console.log(`\n   agent start invocations for ${deniedName}: ${deniedStarts.length}`);
console.log(`   .butchr-prompt.md on disk: ${deniedBrief}`);
console.log(`   durable registry records: ${JSON.stringify([...fixed.agentRegistry.intents().keys()])}`);

verdict(
  denied?.success === false &&
    typeof denied?.error === 'string' &&
    denied.error.includes('.butchr-prompt.md') &&
    denied.error.includes('initial prompt') &&
    denied.error.includes('retried'),
  'success: false, and the error names the prompt-file write and says it was retried',
  'the refusal is missing, or its error does not name the prompt-file write'
);
verdict(
  deniedStarts.length === 0 && !fixed.agentRegistry.intents().has(deniedName) && !deniedBrief,
  'nothing was started, recorded, or left on disk for the refused activation',
  'the refusal left something behind'
);

// ------------------------------------------------ 3. writability restored --

rule('3. RESTORED — the same key, workspace writable again: a normal instructed boot');

restoreWritable(DENIED);
const restored = await fixed.activate(DENIED);
show('activate_by_key response:', {
  success: restored?.success, verified: restored?.verified, sessionId: restored?.sessionId
});

const restoredBrief = fs.existsSync(promptFileFor(DENIED))
  ? fs.readFileSync(promptFileFor(DENIED), 'utf8')
  : undefined;
console.log(`\n   agent start invocations for ${deniedName} now: ${startsFor(deniedName).length}`);
console.log(
  `   .butchr-prompt.md on disk: ${restoredBrief !== undefined} ` +
  `(${restoredBrief?.length ?? 0} chars${restoredBrief ? `, mentions ${DENIED}: ${restoredBrief.includes(DENIED)}` : ''})`
);

verdict(
  restored?.success === true &&
    restored?.verified === true &&
    startsFor(deniedName).length === 1 &&
    typeof restoredBrief === 'string' &&
    restoredBrief.includes(DENIED),
  'the earlier refusal locked nothing out: the agent boots with its brief on disk',
  'the healthy path is no longer healthy after a refusal'
);

// ------------------------------------------------- 4. the no-brief path --

rule('4. NO-BRIEF — no initialPrompt, workspace still unwritable: boots as before');

const NOBRIEF = 'KAN-84-NOBRIEF';
unwritableKeys.push(NOBRIEF);
makeUnwritable(NOBRIEF);

// The resume / brief-less-launcher shape: spawnSession with nothing to write.
// `shell` keeps the fixture honest — its launcher writes nothing else either,
// so the only write this section could refuse over is the one it must not.
const session = fixed.bridge.spawnSession(TYPE, NOBRIEF, undefined, '', 'shell');
const nobriefName = fixed.agentNameFor(TYPE, NOBRIEF);
show('session:', {
  status: session.status, spawnError: session.spawnError ?? null
});
console.log(`\n   agent start invocations for ${nobriefName}: ${startsFor(nobriefName).length}`);

verdict(
  session.spawnError === undefined &&
    session.status !== 'terminated' &&
    startsFor(nobriefName).length === 1,
  'nothing to write, nothing refused: the brief-less activation still boots',
  'the fix leaked into the no-initialPrompt path'
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
