// End-to-end proof for KAN-145: a supervisor activating a child through the
// real `butchr_activate_agent` MCP tool produces a recorded `activatedBy`, read
// back out of `list_agents`.
//
// WHAT FAILURE THIS WOULD CATCH: the caller's identity never reaching the
// process that talks to the daemon — the KAN-145 bug itself, in which
// `activatedBy` was `null` for every agent in the fleet, forever, while every
// individual link of the chain looked correct.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It is the *write* path that was uncovered, and the gap is worth naming
// precisely because two honest scripts sat either side of it:
//
//   * verify-status-change-nudges.mjs and verify-parentage-in-list-agents.mjs
//     both seed a registry record with `activatedBy` already in it, then assert
//     the daemon carries it faithfully — which it does, and did throughout.
//   * `mcp.ts` read `BUTCHR_WORKSPACE_TYPE`/`_KEY` from its environment and
//     `supervisorOfRecord` (router.ts) recorded whatever arrived. Both correct.
//   * Nothing ever *set* those variables in the agent's process. The only
//     writer put them on the `herdr agent attach` PTY — a client of the pane,
//     not an ancestor of the agent — so the input never arrived and no
//     assertion anywhere covered the fact that it must.
//
// So this script starts one link earlier than any of them: at the `.mcp.json`
// the daemon writes, and at a real MCP server process spawned from that file
// the way an agent's CLI spawns it. Nothing here writes a parentage record;
// the only way `activatedBy` can be non-null below is if the identity survived
// the whole journey from `writeWorkspaceMcpConfig` to the registry.
//
// WHAT IS REAL AND WHAT IS NOT
//
// Real: the WorkspaceRegistry with the real Atlassian integration, PromptLoader,
// HerdrBridge (initPty, the workspace provisioning, a real PTY), the
// `.mcp.json` writer, `daemon/dist/mcp.js` running as its own OS process, the
// Unix socket between them, the MessageRouter behind that socket wired exactly
// as daemon.ts wires it, and a real on-disk AgentRegistry.
//
// Substituted, and only these two:
//   * `herdr` — a shim on PATH, as in verify-cross-type-activation.mjs, so no
//     real pane is created and no real agent is started.
//   * `$HOME` — a temp dir, which relocates both the workspaces and the daemon
//     socket. That is what keeps this run out of the live fleet: the MCP server
//     spawned below rendezvouses with the socket *this script* is listening on,
//     not with the machine's daemon.
//
// The one link this cannot cover is the agent CLI itself honouring the
// `.mcp.json` it is given — whether Claude Code spawns the server with the
// declared command line. That is a property of somebody else's binary, so it is
// established by observation rather than asserted here: the KAN-145 PR carries
// the transcript of a real `claude` run whose MCP server recorded its own argv.
// Argv was chosen over `env` partly for that reason — a client that spawns the
// server at all necessarily passes its argv.
//
// Sections:
//   1. the file      — a real activation writes a workspace `.mcp.json` whose
//                      core server names that workspace on its command line
//   2. the process   — the server spawned from that file, its identity visible
//                      in /proc/<pid>/cmdline
//   3. the call      — `butchr_activate_agent` through that process, over MCP
//   4. the record    — `butchr_list_agents` through the same process shows the
//                      child parented on the supervisor; the supervisor, whom a
//                      human activated, stays parentless
//   5. the control   — the same file with the two identity flags removed (which
//                      is byte-for-byte the pre-KAN-145 file) activates a child
//                      that comes back `activatedBy: null`
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-activation-records-real-parentage.mjs [distDir]

import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const SUPERVISOR = { type: 'story', key: 'KAN-145-SUP' };
const CHILD = { type: 'task', key: 'KAN-145-CHILD' };
const CONTROL_CHILD = { type: 'task', key: 'KAN-145-CONTROL' };

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const indent = (text) => String(text).split('\n').map((l) => `     ${l}`).join('\n');
const show = (label, value) => console.log(`   ${label}\n${indent(JSON.stringify(value, null, 2))}`);
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A private HOME, before any dist import: the workspace root and the daemon
// socket path both derive from os.homedir(), which reads $HOME at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan145-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// Nothing may inherit a workspace identity from *this* process: if these were
// set, a passing section 4 would prove nothing about the .mcp.json at all.
delete process.env.BUTCHR_WORKSPACE_TYPE;
delete process.env.BUTCHR_WORKSPACE_KEY;

// ---------------------------------------------------------------- the shim --
//
// The `herdr` of verify-cross-type-activation.mjs: `agent start` remembers the
// agent so `agent get`/`agent list` — and through them the KAN-23 existence
// check — see exactly what was started, and `agent attach` holds its terminal
// open the way a real attach does.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN145_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN145_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane, cwd: found.cwd } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    pane: String(100 + started.length)
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: String(99 + started.length) } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'tab' && b === 'create') {
  // KAN-533: \`pane_id\` is REQUIRED of this fixture now. herdr 0.7's
  // \`agent start --pane\` targets the root pane \`tab create\` returns, so a
  // stub without one sends the daemon down its \"no usable pane\" refusal and
  // every assertion below it becomes a claim about a failed activation.
  out({ result: { tab: { tab_id: '7' }, root_pane: { pane_id: 'p1', workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// ------------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { SOCKET_PATH, ensureButchrDir, onJsonLines, writeJsonLine } = await import(
  path.join(distDir, 'ipc.js')
);
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
registry.setEnabled('jira', true);

const prompts = new PromptLoader(repoRoot);
const bridge = new HerdrBridge();
const registryFile = path.join(scratch, 'agents.jsonl');
const agentRegistry = new AgentRegistry(registryFile);

/** A router wired exactly as daemon.ts wires one, per connection. */
const newRouter = (send) =>
  new MessageRouter(registry, prompts, bridge, send, () => {}, { agentRegistry });

const children = [];
function cleanup() {
  for (const child of children) { try { child.kill(); } catch {} }
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

// The daemon's socket, served by this script. Listening *before* any MCP server
// is spawned matters: `connectToDaemon` starts a daemon of its own when nothing
// answers, and this run must never be the reason a daemon appears.
ensureButchrDir();
const socketServer = net.createServer((socket) => {
  const router = newRouter((msg) => writeJsonLine(socket, msg));
  onJsonLines(socket, (msg) => {
    try {
      router.handle(msg);
    } catch (err) {
      writeJsonLine(socket, {
        success: false,
        error: err?.message ?? String(err),
        ...(msg?.id !== undefined ? { id: msg.id } : {})
      });
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => socketServer.listen(SOCKET_PATH, resolve));

console.log(`HOME for this run:   ${fakeHome}`);
console.log(`daemon socket:       ${SOCKET_PATH}  (served by this script)`);
console.log(`fake herdr:          ${path.join(shimDir, 'herdr')}`);
console.log(`agent registry:      ${registryFile}`);
console.log(
  `\nBUTCHR_WORKSPACE_TYPE/_KEY in this process: ` +
  `${process.env.BUTCHR_WORKSPACE_TYPE ?? '(unset)'} / ${process.env.BUTCHR_WORKSPACE_KEY ?? '(unset)'}` +
  `\n  — deleted above, so nothing below can pass by inheriting them from here.`
);

// -------------------------------------------------- 1. the workspace's file --

rule('AC1 — a real activation writes a .mcp.json whose core server names the workspace');

let activation;
await newRouter(() => {}).handleActivateByKey(
  {
    action: 'activate_by_key',
    type: SUPERVISOR.type,
    key: SUPERVISOR.key,
    defaultAgent: 'claude',
    override: true
  },
  (msg) => { activation = msg; }
);

const supervisorWorkDir = activation?.workDir;
show('activate_by_key (the sidepanel path — no MCP, so no caller identity):', {
  success: activation?.success,
  verified: activation?.verified,
  workDir: supervisorWorkDir
});

const mcpJsonPath = path.join(supervisorWorkDir ?? '', '.mcp.json');
const written = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, 'utf8') : '';
console.log(`\n   ${mcpJsonPath}\n`);
console.log(indent(written.trimEnd() || '(no file)'));

const coreDef = JSON.parse(written || '{}').mcpServers?.butchr;
const namesWorkspace =
  Array.isArray(coreDef?.args) &&
  coreDef.args.includes('--workspace-type') &&
  coreDef.args[coreDef.args.indexOf('--workspace-type') + 1] === SUPERVISOR.type &&
  coreDef.args.includes('--workspace-key') &&
  coreDef.args[coreDef.args.indexOf('--workspace-key') + 1] === SUPERVISOR.key;

console.log(`
  The identity is in \`args\` and not in \`env\`, which is a decision rather than a
  detail (KAN-145 task 2). \`describeMcpServers\` in router.ts reports any
  definition carrying \`env\` by its name alone, because \`env\` is where a
  credential would ride; giving the core server an \`env\` would have hidden its
  command line from the settings page and made a security rule the thing that
  had to bend for a plumbing fix. A workspace type and key are not secret — they
  are the ticket key, already on every surface — so \`args\` is that convention
  observed, not loosened.`);

verdict(
  activation?.success === true && namesWorkspace,
  `the file the daemon wrote names ${SUPERVISOR.type}/${SUPERVISOR.key} on the core server's command line.`,
  'the workspace .mcp.json does not carry this workspace\'s identity — nothing below can work.'
);

// ---------------------------------------------------- 2. the server process --

rule('AC2 — the MCP server spawned from that file carries the identity in its own argv');

/**
 * Spawn a server the way an agent's CLI does: the command, args and env from
 * the `.mcp.json` entry, verbatim, over the inherited environment.
 */
function spawnMcpServer(definition) {
  const env = { ...process.env, ...(definition.env ?? {}) };
  delete env.BUTCHR_WORKSPACE_TYPE;
  delete env.BUTCHR_WORKSPACE_KEY;
  const child = spawn(definition.command, definition.args, {
    cwd: supervisorWorkDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  children.push(child);

  let buffer = '';
  const pending = new Map();
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry(msg); }
    }
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`MCP request timed out: ${method}`)),
        60_000
      );
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  /** A tool call, unwrapped the way an agent reads one. */
  const callTool = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    const text = res?.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { unparsed: text }; }
  };

  return { child, request, notify, callTool, stderr };
}

const supervisorServer = spawnMcpServer(coreDef);
await supervisorServer.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'kan145-verify', version: '1.0.0' }
});
supervisorServer.notify('notifications/initialized');

const cmdline = fs
  .readFileSync(`/proc/${supervisorServer.child.pid}/cmdline`, 'utf8')
  .split('\0')
  .filter(Boolean);
const environ = fs
  .readFileSync(`/proc/${supervisorServer.child.pid}/environ`, 'utf8')
  .split('\0')
  .filter((v) => v.startsWith('BUTCHR_WORKSPACE'));

console.log(`\n   the process that actually reaches the daemon: pid ${supervisorServer.child.pid}\n`);
console.log(indent(`/proc/${supervisorServer.child.pid}/cmdline:\n  ${cmdline.join(' ')}`));
console.log(
  indent(
    `\n/proc/${supervisorServer.child.pid}/environ | grep BUTCHR_WORKSPACE:\n  ` +
    `${environ.length ? environ.join('\n  ') : '(nothing — the identity does not travel in the environment any more)'}`
  )
);

verdict(
  cmdline.includes('--workspace-type') &&
    cmdline[cmdline.indexOf('--workspace-type') + 1] === SUPERVISOR.type &&
    cmdline[cmdline.indexOf('--workspace-key') + 1] === SUPERVISOR.key,
  'the identity is readable off the live process, which is what nobody could check while the bug was open.',
  'the spawned MCP server does not carry the workspace identity.'
);

// ----------------------------------------------------- 3. the real MCP call --

rule('AC3 — the supervisor activates a child through butchr_activate_agent');

const activateResult = await supervisorServer.callTool('butchr_activate_agent', {
  type: CHILD.type,
  key: CHILD.key,
  defaultAgent: 'claude',
  // The capacity gate reads the real machine, and how busy this box is decides
  // nothing about parentage. Supervisors pass the gate unconditionally; a task
  // does not, so this is the same override [Start anyway] sends.
  override: true
});

show('what the tool answered:', {
  success: activateResult?.success,
  verified: activateResult?.verified,
  type: activateResult?.type,
  key: activateResult?.key
});

// Deliberately says nothing about parentage: this section asserts only that the
// call went through, so that a failure in AC4 can only mean the identity was
// lost and never that the activation itself did not happen. On the pre-fix
// build this section passes and AC4 fails, which is the shape of the bug — an
// activation that succeeds while silently losing who asked for it.
verdict(
  activateResult?.success === true && activateResult?.verified === true,
  `${CHILD.type}/${CHILD.key} was activated over MCP, the way an agent activates one.`,
  'the activation through the MCP tool failed; the parentage assertion below would be vacuous.'
);

// ------------------------------------------------------------ 4. the record --

rule('AC4 — list_agents reports the child parented on the supervisor');

const listed = await supervisorServer.callTool('butchr_list_agents', {});
const rowFor = (a) =>
  listed.agents?.find((r) => r.agentName === agentNameFor(a.type, a.key));

console.log('\n   the rows, as the tool returned them:\n');
for (const row of listed.agents ?? []) {
  console.log(
    `     ${JSON.stringify({
      agentName: row.agentName,
      type: row.type,
      key: row.key,
      activatedBy: row.activatedBy
    })}`
  );
}

console.log('\n   the registry file this was read back out of, in full:\n');
console.log(indent(fs.readFileSync(registryFile, 'utf8').trimEnd()));
console.log(`
  Every line above was written by the daemon on the activation path. This script
  never calls recordActivated — grep it — which is the difference between this
  proof and the two that came before it: they seeded \`activatedBy\` and asserted
  it was carried, and could therefore both pass while nothing on the machine
  ever produced one.`);

const childRow = rowFor(CHILD);
const supervisorRow = rowFor(SUPERVISOR);

verdict(
  childRow?.activatedBy?.type === SUPERVISOR.type &&
    childRow?.activatedBy?.key === SUPERVISOR.key &&
    supervisorRow !== undefined &&
    'activatedBy' in supervisorRow &&
    supervisorRow.activatedBy === null,
  'the child names its supervisor, and the supervisor — activated by a human — stays an explicit null.',
  `the child came back as ${JSON.stringify(childRow?.activatedBy)} and the supervisor as ` +
    `${JSON.stringify(supervisorRow?.activatedBy)}.`
);

// ----------------------------------------------------------- 5. the control --

rule('AC5 — control: the same file without the two flags is the bug, exactly');

// Byte-for-byte the definition origin/main wrote before this fix: the command
// and the path to mcp.js, and nothing else. If section 4 could pass with this
// too, it would be measuring something other than the identity.
const preFixDef = {
  ...coreDef,
  args: coreDef.args.filter(
    (arg, i) =>
      !['--workspace-type', '--workspace-key'].includes(arg) &&
      !['--workspace-type', '--workspace-key'].includes(coreDef.args[i - 1])
  )
};

console.log('\n   the pre-KAN-145 definition, reconstructed by removing the two flags:\n');
console.log(indent(JSON.stringify(preFixDef, null, 2)));

const blindServer = spawnMcpServer(preFixDef);
await blindServer.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'kan145-verify-control', version: '1.0.0' }
});
blindServer.notify('notifications/initialized');

const controlActivation = await blindServer.callTool('butchr_activate_agent', {
  type: CONTROL_CHILD.type,
  key: CONTROL_CHILD.key,
  defaultAgent: 'claude',
  override: true
});
const controlList = await blindServer.callTool('butchr_list_agents', {});
const controlRow = controlList.agents?.find(
  (r) => r.agentName === agentNameFor(CONTROL_CHILD.type, CONTROL_CHILD.key)
);

console.log('');
show('the child a server with no identity activated:', {
  activated: controlActivation?.success,
  agentName: controlRow?.agentName,
  activatedBy: controlRow?.activatedBy
});
console.log(`
  This is the whole of KAN-145 in one row, and it is why the fix is the
  \`.mcp.json\` and not the daemon: the router, the registry and \`list_agents\`
  are the same code that produced AC4 a moment ago, and the only thing that
  changed is whether the process making the call knew who it was.`);

verdict(
  controlActivation?.success === true &&
    controlRow !== undefined &&
    'activatedBy' in controlRow &&
    controlRow.activatedBy === null,
  'without the flags the activation still succeeds and the parentage is lost — the assertion above is load-bearing.',
  'the control did not reproduce the bug, so AC4 is not measuring what it claims to.'
);

// --------------------------------------------------------------------------

await sleep(50);
socketServer.close();
console.log(`\n== ${failures ? `${failures} FAILURE(S) ABOVE` : 'all sections passed'} ==`);
process.exit(failures ? 1 : 0);
