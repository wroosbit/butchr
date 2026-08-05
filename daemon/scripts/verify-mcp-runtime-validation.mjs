// Live proof for KAN-157: the daemon establishes that the interpreter behind an
// npx-based MCP server can actually run it, pins that interpreter into the
// server's own environment, and refuses the activation when no interpreter on
// the machine qualifies — instead of baking whichever npx its PATH happened to
// front into every `.mcp.json` and saying nothing.
//
// WHAT FAILURE THIS WOULD CATCH: a workspace `.mcp.json` naming an npx whose
// Node cannot run mcp-remote, written behind a `success: true, verified: true`
// activation — the agent comes up with no Atlassian tools, no error, no log
// line, and no way to find out why. That is the bug as it actually happened: the
// epic agent lost Jira for two hours and `which('npx')` had succeeded.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// Stated up front because it is the failure mode this epic keeps re-finding: a
// proof that supplies its own input has not tested that the input arrives.
//
// THIS SCRIPT SUPPLIES: the PATH, and the Nodes on it. The "too old" Node is a
// fixture — a shell script that answers `--version` with `v12.22.9` — and the
// directory `process.execPath` sits in is a fixture too (a hard link to this
// process's real node, in a directory this script controls). Both are supplied
// so that the resolver's *decision* can be exercised on any machine, including
// a CI runner with exactly one Node on it.
//
// THEREFORE THIS SCRIPT DOES NOT PROVE that mcp-remote itself parses and runs
// under the Node the daemon picks. It proves which Node a `#!/usr/bin/env node`
// bin would resolve to under the environment the daemon wrote — measured by
// running `/usr/bin/env node --version` with exactly that environment, which is
// literally the mechanism mcp-remote's own bin uses — and no further.
//
// WHO COVERS THE REST:
//
//   * Section 5 of this file, when run with KAN157_LIVE=1, spawns the written
//     command verbatim and waits for mcp-remote to say it connected. It needs
//     the network and Atlassian's endpoint, so it is opt-in and is NOT part of
//     the default verdict. Its transcript is pasted into the KAN-157 PR.
//   * The KAN-157 PR additionally pastes a real activation on the real machine
//     with the operator's `~/.local/bin/{node,npx}` workaround symlinks removed
//     — the acceptance criterion this script cannot reach, because it cannot
//     delete a symlink out of somebody's home directory.
//
// Nobody covers "mcp-remote 0.1.39 raises its own floor above what
// node-runtime.ts records". That is a version-drift risk, not a defect, and the
// re-derivation command is written into node-runtime.ts beside the constant.
//
// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------
//
//   1. unfixed  — origin/main's atlassian-integration.ts, on a PATH whose only
//                 npx runs on Node v12: the config is written naming it, the
//                 activation answers success: true / verified: true, and
//                 nothing anywhere says the server cannot start
//   2. refused  — the same PATH against this branch: success: false, the error
//                 names the Node, its version and the minimum, and nothing was
//                 started, recorded or written
//   3. chosen   — an old Node first on PATH and a good one behind it: the good
//                 one is chosen, the rejection is logged with its version, and
//                 the written `.mcp.json` carries the pinned PATH
//   4. pinned   — the load-bearing one. `/usr/bin/env node --version` run with
//                 exactly the env the daemon wrote resolves to the validated
//                 Node, while the old command shape on the same hostile PATH
//                 resolves to the v12 fixture. The difference is the env, and
//                 this is where that is shown rather than asserted.
//   5. daemon   — the immunity argument: with an npx beside `process.execPath`,
//                 the daemon's own Node is preferred over an older npx that is
//                 first on PATH, and the preference is stated in the log rather
//                 than taken silently
//   6. live     — opt-in (KAN157_LIVE=1): the written command, spawned for real
//
// Sections 1-4 run in a re-exec whose `process.execPath` sits in a directory
// with no npx, so the daemon-preference is honestly unavailable and every
// outcome is decided by PATH. Section 5 re-execs again with an npx placed
// beside that node. Both re-execs use a hard link to this process's own node
// binary, so no fake interpreter is ever the one running the daemon's code.
//
// Everything on the daemon side is real: the real MessageRouter, the real
// HerdrBridge (initPty and all), the real WorkspaceRegistry and a real on-disk
// AgentRegistry. What is faked is the `herdr` binary — a shim on PATH recording
// every invocation argv-exact — so "nothing was started" is read off evidence
// rather than inferred. Isolation is by $HOME.
//
// Usage:
//   cd daemon && npm run build
//   # the unfixed baseline for section 1: origin/main's daemon sources, built
//   # where node_modules still resolves
//   git checkout origin/main -- src
//   npx tsc --outDir dist-unfixed
//   git checkout HEAD -- src
//   node scripts/verify-mcp-runtime-validation.mjs dist dist-unfixed
//
// Section 1 is skipped (with a note) when the unfixed dist is not supplied.

import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, '..', '..');
const distArg = process.argv[2] ?? 'dist';
const unfixedArg = process.argv[3];
const distDir = path.resolve(scriptDir, '..', distArg);
const unfixedDistDir = unfixedArg ? path.resolve(scriptDir, '..', unfixedArg) : undefined;

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);

// =============================================================== re-exec ====
//
// `process.execPath` is realpath'd by Node, so a symlink cannot move it. A hard
// link to the real binary can — it is a second real path to the same inode — and
// a copy is the fallback when /tmp is on another filesystem. Either way the code
// under test runs on this machine's actual Node; only the *directory it appears
// to live in* is under this script's control, which is what makes the
// daemon-bin-dir candidate testable in both directions.

function makeNodeDir(dir, { withNpx }) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'node');
  const real = fs.realpathSync(process.execPath);
  try {
    fs.linkSync(real, target);
  } catch {
    fs.copyFileSync(real, target);
    fs.chmodSync(target, 0o755);
  }
  if (withNpx) {
    // The real npx from this Node's own install, if it has one. Symlinked
    // rather than copied: what matters is that an executable `npx` is beside
    // the node, which is exactly the condition the resolver tests for.
    const realNpx = path.join(path.dirname(real), 'npx');
    if (fs.existsSync(realNpx)) fs.symlinkSync(realNpx, path.join(dir, 'npx'));
    else fs.writeFileSync(path.join(dir, 'npx'), '#!/bin/sh\nexit 0\n'), fs.chmodSync(path.join(dir, 'npx'), 0o755);
  }
  return target;
}

const STAGE = process.env.KAN157_STAGE;

if (!STAGE) {
  // ------------------------------------------------------------- the parent --
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan157-parent-'));
  process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

  console.log(`KAN-157 — MCP interpreter validation`);
  console.log(`fixed dist:   ${distDir}`);
  console.log(`unfixed dist: ${unfixedDistDir ?? '(not supplied — section 1 will be skipped)'}`);
  console.log(`this node:    ${process.execPath} (${process.version})`);

  // The Node directory the child should treat as "a good one that is not the
  // daemon's" — this process's real one, which certainly has an npx if this
  // machine can run npx at all.
  const realNodeDir = path.dirname(fs.realpathSync(process.execPath));

  const stages = [
    { name: 'path', withNpx: false, title: 'sections 1-4 — process.execPath has no npx beside it' },
    { name: 'daemon', withNpx: true, title: 'section 5 — process.execPath has an npx beside it' }
  ];

  let failures = 0;
  for (const stage of stages) {
    const dir = path.join(scratch, `node-${stage.name}`);
    const nodeBinary = makeNodeDir(dir, { withNpx: stage.withNpx });
    rule(`RE-EXEC (${stage.name}) — ${stage.title}`);
    console.log(`   running under ${nodeBinary}`);
    const result = spawnSync(
      nodeBinary,
      [scriptFile, distArg, ...(unfixedArg ? [unfixedArg] : [])],
      {
        stdio: 'inherit',
        env: { ...process.env, KAN157_STAGE: stage.name, KAN157_REAL_NODE_DIR: realNodeDir }
      }
    );
    if (result.status !== 0) failures++;
  }

  rule(failures === 0 ? 'all stages passed' : `${failures} stage(s) FAILED`);
  process.exit(failures ? 1 : 0);
}

// ================================================================ the child ==

const REAL_NODE_DIR = process.env.KAN157_REAL_NODE_DIR;
const TYPE = 'task';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kan157-${STAGE}-`));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

// --------------------------------------------------------------- fixtures --
//
// A Node that is too old, without needing an old Node to be installed. Only
// `--version` is ever asked of it by the resolver, and the resolver asking is
// the behaviour under test — the point of KAN-157 is that a path was accepted
// *without* asking.
const OLD_VERSION = 'v12.22.9';
const oldDir = path.join(scratch, 'old-node', 'bin');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(
  path.join(oldDir, 'node'),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${OLD_VERSION}; exit 0; fi\n` +
  `echo "SyntaxError: Unexpected token '.'" >&2\nexit 1\n`
);
fs.chmodSync(path.join(oldDir, 'node'), 0o755);
fs.writeFileSync(path.join(oldDir, 'npx'), `#!/bin/sh\nexec "$(dirname "$0")/node" "$@"\n`);
fs.chmodSync(path.join(oldDir, 'npx'), 0o755);

// ------------------------------------------------------------------ shim --
//
// One fake `herdr`, always on PATH. Records every invocation argv-exact;
// `agent start` remembers the agent so the existence probe sees exactly what
// was started and nothing else. The directory holds no `node` and no `npx`, so
// the resolver rejects it for the honest reason and it never perturbs a fixture.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'shim-bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN157_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.KAN157_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');
const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;
if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, agent: 'claude', pane_id: '9' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({ name: args[2], cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1], command: sep === -1 ? [] : args.slice(sep + 1) });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: '9' } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else { out({ result: {} }); }
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const startsFor = (name) =>
  invocations().filter((argv) => argv[0] === 'agent' && argv[1] === 'start' && argv[2] === name);

// The PATHs each section resolves against. The shim is always present and the
// real system directories never are, so nothing here depends on what the
// machine running this happens to have installed.
const ONLY_OLD = [oldDir, shimDir].join(':');
const OLD_THEN_GOOD = [oldDir, REAL_NODE_DIR, shimDir].join(':');

const workspaceFor = (key) =>
  path.join(fakeHome, '.local', 'share', 'butchr', 'workspaces', TYPE, key.toLowerCase());
const mcpConfigFor = (key) => path.join(workspaceFor(key), '.mcp.json');

// ---------------------------------------------------------------- harness --

async function harness(dir, registryFile) {
  const { HerdrBridge, agentNameFor } = await import(path.join(dir, 'herdr.js'));
  const { MessageRouter } = await import(path.join(dir, 'router.js'));
  const { WorkspaceRegistry } = await import(path.join(dir, 'registry.js'));
  const { PromptLoader } = await import(path.join(dir, 'prompt.js'));
  const { AgentRegistry } = await import(path.join(dir, 'agent-registry.js'));
  const { createAtlassianIntegration } = await import(
    path.join(dir, 'integrations', 'atlassian-integration.js')
  );
  const { IntegrationStateStore } = await import(path.join(dir, 'integrations', 'enablement.js'));

  const registry = new WorkspaceRegistry(
    new IntegrationStateStore(path.join(scratch, `integrations-${registryFile}.json`))
  );
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
  registry.setEnabled('jira', true);

  const bridge = new HerdrBridge();
  const agentRegistry = new AgentRegistry(path.join(scratch, registryFile));
  let sent;
  const router = new MessageRouter(
    registry,
    new PromptLoader(repoRoot),
    bridge,
    (msg) => { sent = msg; },
    () => {},
    undefined,
    undefined,
    agentRegistry
  );

  // override: the capacity gate reads the real machine, and whether this box is
  // busy decides nothing about whether an interpreter can run mcp-remote.
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
const unfixed = unfixedDistDir && fs.existsSync(path.join(unfixedDistDir, 'herdr.js'))
  ? await harness(unfixedDistDir, 'agents-unfixed.jsonl')
  : undefined;

function cleanup() {
  for (const h of [fixed, unfixed]) {
    if (!h) continue;
    for (const session of h.bridge.listActiveSessions()) {
      try { session.ptyProcess?.kill(); } catch {}
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log(`\nstage:        ${STAGE}`);
console.log(`process.execPath: ${process.execPath}`);
console.log(`  its directory holds an npx: ${fs.existsSync(path.join(path.dirname(process.execPath), 'npx'))}`);
console.log(`fake old node: ${path.join(oldDir, 'node')} (answers --version with ${OLD_VERSION})`);
console.log(`real node dir: ${REAL_NODE_DIR}`);
console.log(`fake herdr:    ${path.join(shimDir, 'herdr')}`);
console.log(`HOME:          ${fakeHome}`);

if (STAGE === 'path') {
  // ================================================== 1. the silent baseline ==

  rule('1. UNFIXED — origin/main: an npx that cannot run mcp-remote, written and never mentioned');

  if (!unfixed) {
    console.log('   skipped: no unfixed dist supplied (see the usage block for how to build one)');
  } else {
    process.env.PATH = ONLY_OLD;
    const KEY = 'KAN-157-UNFIXED';
    const res = await unfixed.activate(KEY);
    show('activate_by_key response:', {
      success: res?.success, verified: res?.verified, error: res?.error ?? null
    });

    const name = unfixed.agentNameFor(TYPE, KEY);
    const written = fs.existsSync(mcpConfigFor(KEY))
      ? JSON.parse(fs.readFileSync(mcpConfigFor(KEY), 'utf8'))
      : undefined;
    show('the atlassian server it wrote:', written?.mcpServers?.atlassian ?? null);
    console.log(`\n   agent start invocations for ${name}: ${startsFor(name).length}`);

    const atlassian = written?.mcpServers?.atlassian;
    verdict(
      res?.success === true &&
        res?.verified === true &&
        startsFor(name).length === 1 &&
        atlassian?.command === path.join(oldDir, 'npx') &&
        atlassian?.env === undefined,
      `the ticket's symptom, reproduced: ${path.join(oldDir, 'npx')} baked in behind ` +
        'success: true / verified: true, with nothing in the response or the file to say ' +
        'the server cannot start',
      'the unfixed build did not reproduce the silent bad interpreter (already fixed?)'
    );
  }

  // ============================================================ 2. refused ==

  rule('2. FIXED — the same PATH: refused, the interpreter named, nothing started');

  process.env.PATH = ONLY_OLD;
  const DENIED = 'KAN-157-DENIED';
  const denied = await fixed.activate(DENIED);
  show('activate_by_key response:', denied);

  const deniedName = fixed.agentNameFor(TYPE, DENIED);
  console.log(`\n   agent start invocations for ${deniedName}: ${startsFor(deniedName).length}`);
  console.log(`   .mcp.json on disk: ${fs.existsSync(mcpConfigFor(DENIED))}`);
  console.log(`   durable registry records: ${JSON.stringify([...fixed.agentRegistry.intents().keys()])}`);

  verdict(
    denied?.success === false &&
      typeof denied?.error === 'string' &&
      denied.error.includes('atlassian') &&
      denied.error.includes(OLD_VERSION) &&
      denied.error.includes('20.18.1') &&
      denied.error.includes('undici'),
    'success: false, and the error names the server, the Node it found, its version and the minimum',
    'the refusal is missing, or its error does not name the interpreter it rejected'
  );
  verdict(
    startsFor(deniedName).length === 0 &&
      !fixed.agentRegistry.intents().has(deniedName) &&
      !fs.existsSync(mcpConfigFor(DENIED)),
    'nothing was started, recorded, or written for the refused activation',
    'the refusal left something behind'
  );

  // ============================================================= 3. chosen ==

  rule('3. FIXED — an old npx first on PATH and a good Node behind it: the good one is chosen');

  process.env.PATH = OLD_THEN_GOOD;
  const OK = 'KAN-157-OK';

  // Captured across the activation, because task 3 of the ticket is about what
  // the daemon says while it decides, and a rejection nobody prints is the same
  // silence the ticket was filed about.
  const logged = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  let ok;
  try {
    ok = await fixed.activate(OK);
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  show('activate_by_key response:', {
    success: ok?.success, verified: ok?.verified, error: ok?.error ?? null
  });
  console.log('\n   what the daemon log said about the interpreter:');
  for (const line of logged.filter((l) => l.includes('[NodeRuntime]'))) console.log(`     ${line}`);

  const written = fs.existsSync(mcpConfigFor(OK))
    ? JSON.parse(fs.readFileSync(mcpConfigFor(OK), 'utf8'))
    : undefined;
  const atlassian = written?.mcpServers?.atlassian;
  show('the atlassian server it wrote:', atlassian ?? null);

  verdict(
    ok?.success === true &&
      atlassian?.command === path.join(REAL_NODE_DIR, 'npx') &&
      typeof atlassian?.env?.PATH === 'string' &&
      atlassian.env.PATH.split(':')[0] === REAL_NODE_DIR,
    `the first npx on PATH (${path.join(oldDir, 'npx')}) was passed over for ${path.join(REAL_NODE_DIR, 'npx')}, ` +
      "and the server's own PATH leads with that directory",
    'the old npx was chosen, or the chosen one was not pinned into the server environment'
  );
  verdict(
    logged.some(
      (l) =>
        l.includes('[NodeRuntime] Rejected') &&
        l.includes(path.join(oldDir, 'node')) &&
        l.includes(OLD_VERSION) &&
        l.includes('20.18.1')
    ),
    'the rejected interpreter was logged by path, by version and against the requirement, ' +
      'rather than passed over in silence',
    'the daemon skipped an interpreter without logging which one or why'
  );

  // ============================================================= 4. pinned ==

  rule('4. THE PROPERTY THAT MATTERS — which Node a `#!/usr/bin/env node` bin resolves to');

  console.log(
    '\n   mcp-remote\'s own bin is `#!/usr/bin/env node`, and so is npx. That is why an\n' +
    '   absolute path in `command` decides nothing about the interpreter and the written\n' +
    '   `env` decides everything. Both halves are measured here with `/usr/bin/env node\n' +
    '   --version`, which is that mechanism exactly — not a stand-in for it.\n'
  );

  const resolveNodeUnder = (env) => {
    try {
      return execFileSync('/usr/bin/env', ['node', '--version'], {
        encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (e) {
      return `(failed: ${e?.message ?? String(e)})`;
    }
  };

  // The hostile PATH the server would otherwise inherit: the v12 fixture first.
  const hostile = { ...process.env, PATH: ONLY_OLD };
  const withWritten = { ...hostile, ...(atlassian?.env ?? {}) };

  const before = resolveNodeUnder(hostile);
  const after = resolveNodeUnder(withWritten);
  console.log(`   with the hostile PATH alone (the old command shape): ${before}`);
  console.log(`   with the env the daemon wrote:                       ${after}`);

  verdict(
    before === OLD_VERSION && /^v(\d+)\./.test(after) && Number(/^v(\d+)\./.exec(after)[1]) >= 20,
    `the same hostile PATH yields ${OLD_VERSION} for the old shape and ${after} for the written one — ` +
      'the pinned env is what moves the interpreter',
    'the written env did not change which Node a shebang resolves to'
  );

  // =============================================================== 6. live ==

  rule('6. LIVE — the written command, spawned for real (opt-in)');

  if (process.env.KAN157_LIVE !== '1' || !atlassian) {
    console.log(
      '   skipped: set KAN157_LIVE=1 to run it. It spawns the exact command from section 3\n' +
      '   under the hostile PATH and waits for mcp-remote to report a connection, so it needs\n' +
      '   the network and Atlassian\'s endpoint. Not part of this script\'s verdict; its\n' +
      '   transcript is pasted into the KAN-157 PR.'
    );
  } else {
    const child = spawn(atlassian.command, atlassian.args, {
      env: { ...hostile, ...atlassian.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const connected = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 90000);
      const check = () => {
        if (/Proxy established|Connected to remote server|Local STDIO server running/.test(output)) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    try { child.kill(); } catch {}
    console.log(output.split('\n').slice(0, 20).map((l) => `     ${l}`).join('\n'));
    verdict(
      connected && !/SyntaxError/.test(output),
      'the command the daemon wrote really does start mcp-remote under a hostile PATH',
      'the written command did not bring mcp-remote up'
    );
  }
}

if (STAGE === 'daemon') {
  // ============================================================== 5. daemon ==

  rule("5. THE IMMUNITY ARGUMENT — the daemon's own Node is preferred, and says so");

  console.log(
    '\n   The core `butchr` server has never had this bug because it is `process.execPath`\n' +
    '   plus an absolute path to the daemon\'s own mcp.js: it runs on the interpreter the\n' +
    '   daemon is already running on, which cannot be too old to run the daemon. This\n' +
    '   section is that same property, given to the Atlassian server — with an npx beside\n' +
    '   `process.execPath`, an older npx first on PATH does not win.\n'
  );

  process.env.PATH = ONLY_OLD;
  const { resolveNpxRuntime, resolveNpxRuntimeUncached, resetNpxRuntimeCache } =
    await import(path.join(distDir, 'node-runtime.js'));

  // Task 3 of the ticket — "do not silently prefer a different interpreter" — is
  // a claim about what gets *said*, so it is read off what was said. The logging
  // entry point is called with console captured, rather than the silent one.
  resetNpxRuntimeCache();
  const logged = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  let resolved;
  try {
    resolved = resolveNpxRuntime(ONLY_OLD);
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  show('resolution:', {
    ok: resolved.ok,
    node: resolved.node,
    npx: resolved.npx,
    version: resolved.version,
    pathPrefix: resolved.pathPrefix,
    firstNpxOnPath: resolved.firstNpxOnPath,
    candidates: resolved.candidates
  });
  console.log('\n   what the daemon log said:');
  for (const line of logged) console.log(`     ${line}`);

  const daemonDir = path.dirname(process.execPath);
  verdict(
    resolved.ok === true &&
      resolved.node === path.join(daemonDir, 'node') &&
      resolved.pathPrefix?.[0] === daemonDir,
    "the daemon's own Node won on a PATH whose only npx is the v12 fixture",
    "the daemon's own Node was not preferred"
  );
  verdict(
    resolved.firstNpxOnPath === path.join(oldDir, 'npx') &&
      logged.some(
        (l) =>
          l.includes('NOT the first npx on PATH') &&
          l.includes(path.join(oldDir, 'npx')) &&
          l.includes("beside the daemon's own node")
      ),
    'passing over the first npx on PATH was said out loud, naming the one that was passed ' +
      'over and why — the line whose absence cost two hours',
    'the daemon preferred a different interpreter without saying so'
  );

  // A preference that could never fail would make section 2's refusal vacuous:
  // if the daemon's directory always qualified, nothing could ever be refused.
  // It is validated like any other candidate, which is what section 2 relies on
  // — its stage runs under an execPath with no npx beside it, so the daemon
  // candidate is rejected there for a reason it prints.
  const noPath = resolveNpxRuntimeUncached('');
  console.log(
    `\n   with an empty PATH: ok=${noPath.ok}, first candidate origin=${noPath.candidates[0]?.origin}`
  );
  verdict(
    noPath.ok === true && noPath.candidates[0]?.origin === 'daemon' && noPath.candidates.length === 1,
    "the daemon's own directory is a candidate in its own right rather than a PATH entry — " +
      'which is exactly why the refusal sections had to run under an execPath with no npx',
    'the daemon directory was not consulted independently of PATH'
  );
}

rule(failures === 0 ? `stage ${STAGE}: all sections passed` : `stage ${STAGE}: ${failures} section(s) FAILED`);
process.exit(failures ? 1 : 0);
