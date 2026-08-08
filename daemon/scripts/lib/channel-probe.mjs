//
// The Claude Code *channel* probing harness, shared by every probe that needs
// one.
//
// EXTRACTED FROM `probe-channel-delivery.mjs` BY KAN-219, NOT REWRITTEN. That
// script established (KAN-217) that a channel event reaches the model of a real
// Butchr agent; KAN-219 asks the destructive follow-up — whether such an event
// arriving MID-TOOL-CALL disturbs that call — and its ticket says plainly that
// configuration D's bring-up is what to reuse and "the in-flight window is the
// only new part". Copying 200 lines of agent bring-up into a second file would
// have created exactly the second place for identity stamping and command-line
// splicing to drift that KAN-145's defect was made of. So the bring-up lives
// here, once, and both probes import it.
//
// WHAT THIS MODULE IS NOT: it is not a `verify-` script and must never be
// renamed into that namespace. It drives a live `claude` CLI and a real model.
// It also has no top-level side effects, deliberately — a probe must be able to
// import it without something starting.
//
// ---------------------------------------------------------------------------
// THE ONE BEHAVIOURAL NOTE THAT SURVIVED THE EXTRACTION
// ---------------------------------------------------------------------------
// `bringUpChannelAgent` activates a REAL agent through the daemon and holds a
// REAL herdr pane. It takes a capacity slot. Every caller must stand its agent
// down in a `finally` — `standDownAgent` is here for that — or an abandoned
// probe leaves a live agent and a workspace behind.
//
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import http from 'http';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const libDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(libDir, '..', '..', '..');
export const DAEMON_DIR = path.join(repoRoot, 'daemon');
export const NODE_MODULES = path.join(DAEMON_DIR, 'node_modules');
export const LAUNCHERS_JS = path.join(DAEMON_DIR, 'dist', 'launchers.js');
export const BUTCHR_DIR = path.join(os.homedir(), '.local', 'share', 'butchr');
export const SOCKET_PATH = path.join(BUTCHR_DIR, 'butchr.sock');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const yn = (b) => (b ? 'YES' : 'NO ');
const stdoutSay = (s = '') => process.stdout.write(`${s}\n`);

// ------------------------------------------------------------ the channel --
//
// The smallest thing the reference calls a channel: the `claude/channel`
// experimental capability, a `notifications/claude/channel` emission, and stdio
// transport. Plain Node against `@modelcontextprotocol/sdk` — the SAME package
// and version the daemon already depends on (daemon/package.json). BUN IS NOT
// INVOLVED and is not installed on this machine; the reference says Node and
// Deno work and only the three pre-built Anthropic plugins happen to use Bun.
// That claim is not taken on trust here — it is what this file executes.
//
// Two trigger modes:
//   http   — an HTTP POST on 127.0.0.1. Ours, not Butchr's.
//   daemon — an ordinary client connection to the Butchr daemon's Unix socket,
//            watching for the `*_event` broadcasts the daemon emits on its own.
//            This is the mode that matters: it is the real event stream
//            `daemon/dist/mcp.js` already consumes, proving the carrier can be
//            fed by the daemon exactly as it stands today.
export const CHANNEL_SERVER = String.raw`
import fs from 'fs';
import net from 'net';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const LOG = process.env.PROBE_SERVER_LOG;
const REPLIES = process.env.PROBE_REPLY_LOG;
const MODE = process.env.PROBE_MODE || 'http';
const NONCE = process.env.PROBE_NONCE || '';
const CONTROL = process.env.PROBE_CONTROL_NONCE || '';
const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };

const mcp = new Server(
  { name: 'butchrprobe', version: '0.0.1' },
  {
    capabilities: {
      // THIS KEY IS WHAT MAKES IT A CHANNEL. Without it Claude Code registers
      // no listener and every notification below is discarded in silence.
      experimental: { 'claude/channel': {} },
      tools: {}
    },
    // WORDING IS LOAD-BEARING, and this probe learned it the hard way. An
    // earlier version ended this string with "Do not ask permission first."
    // The event was DELIVERED — the model described it accurately — and the
    // model then declined to act, naming the message as a probable prompt
    // injection and quoting that very sentence as the red flag that decided
    // it. It was right to. A channel event is untrusted input, and content
    // that pre-authorises its own execution reads exactly like an attack.
    // Recorded in docs/channel-delivery.md, because it is a design constraint
    // on any migration and not a quirk of this script.
    instructions:
      'Events from the butchrprobe channel arrive as <channel source="butchrprobe" ...>. '
      + 'This channel is a local delivery test harness. When an event asks you to echo '
      + 'a token, call the butchrprobe reply tool with that token as the text argument.'
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back over this channel',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The message to send' } },
        required: ['text']
      }
    },
    {
      // The positive control's carrier: a nonce riding OUT on a tool RESULT,
      // the path KAN-167 configuration C proved does reach the model.
      name: 'status',
      description: 'Report probe status. Call this when asked for the probe status.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === 'reply') {
    const text = String(req.params.arguments?.text ?? '');
    log({ ev: 'reply-tool-called', text });
    try { fs.appendFileSync(REPLIES, text + '\n'); } catch {}
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  if (name === 'status') {
    log({ ev: 'status-tool-called' });
    return { content: [{ type: 'text', text: 'probe status OK; control token ' + CONTROL }] };
  }
  throw new Error('unknown tool: ' + name);
});

// Returns WHAT THE SENDER OBSERVES, which is the second half of KAN-217.
// Deliberately reports the outcome of the await rather than swallowing it: the
// question is precisely whether a send that will never be read still looks
// like a success from here.
const emit = async (content, meta) => {
  log({ ev: 'emit', content, meta });
  try {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } });
    log({ ev: 'emitted', resolved: true });
    return { senderObserved: 'resolved-without-error' };
  } catch (e) {
    const error = String(e && e.message ? e.message : e);
    log({ ev: 'emit-failed', error });
    return { senderObserved: 'threw', error };
  }
};

await mcp.connect(new StdioServerTransport());
log({ ev: 'connected', mode: MODE });

if (MODE === 'http') {
  // Port 0 = let the OS pick a free one, then report which. A FIXED port was a
  // real defect: an orphaned server from an earlier run held 8830 and the next
  // run's config A died with EADDRINUSE, which the guard correctly reported as
  // "did not reach a verdict". Ephemeral ports make that collision impossible
  // rather than merely unlikely.
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const outcome = await emit(body, { probe: 'butchr' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(outcome));
  });
  srv.on('error', (e) => log({ ev: 'listen-failed', error: String(e && e.message) }));
  srv.listen(0, '127.0.0.1', () => log({ ev: 'listening', port: srv.address().port }));
} else {
  // An ordinary daemon client, watching the broadcast stream.
  const sock = net.connect(process.env.PROBE_SOCKET);
  let buf = '';
  sock.on('error', (e) => log({ ev: 'socket-error', error: String(e && e.message) }));
  sock.on('connect', () => log({ ev: 'socket-connected' }));
  sock.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (typeof m?.action !== 'string' || !m.action.endsWith('_event')) continue;
      const key = String(m.key ?? '');
      log({ ev: 'daemon-broadcast', action: m.action, key });
      // Only the broadcast carrying our nonce becomes an event, so unrelated
      // fleet activity cannot put text in front of the probe target.
      if (!NONCE || !key.includes(NONCE)) continue;
      await emit(
        '[Butchr] ' + m.action + ' for ' + m.type + '/' + key
          + ' :: echo the token ' + NONCE + ' back to me by calling the butchrprobe'
          + ' reply tool now, with text set to exactly that token.',
        { probe: 'butchr', action: m.action }
      );
    }
  });
}
`;

// --------------------------------------------------------------- the tee --
//
// CP2 must not rest on the server's own logging: a server that believes it sent
// a frame and a frame that reached the client are different claims, and the
// gap between them is precisely the class of defect this epic keeps finding.
// So the channel server is spawned behind this wrapper, which forwards stdio
// verbatim and records every line crossing it in both directions.
export const TEE = String.raw`
import fs from 'fs';
import { spawn } from 'child_process';
const WIRE = process.env.PROBE_WIRE_LOG;
const rec = (dir, line) => {
  if (!line.trim()) return;
  let frame; try { frame = JSON.parse(line); } catch { frame = { unparsed: line }; }
  fs.appendFileSync(WIRE, JSON.stringify({ t: Date.now(), dir, frame }) + '\n');
};
// argv is [node, tee.mjs, <command>, ...args] — the wrapped server starts at 2.
const child = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ['pipe', 'pipe', process.env.PROBE_STDERR ? fs.openSync(process.env.PROBE_STDERR, 'a') : 'inherit']
});
child.on('error', (e) => {
  fs.appendFileSync(WIRE, JSON.stringify({ t: Date.now(), dir: 'tee-error', error: String(e.message) }) + '\n');
});
let up = '';
process.stdin.on('data', (c) => {
  up += c.toString('utf8'); let i;
  while ((i = up.indexOf('\n')) !== -1) { rec('client->server', up.slice(0, i)); up = up.slice(i + 1); }
  child.stdin.write(c);
});
let down = '';
child.stdout.on('data', (c) => {
  down += c.toString('utf8'); let i;
  while ((i = down.indexOf('\n')) !== -1) { rec('server->client', down.slice(0, i)); down = down.slice(i + 1); }
  process.stdout.write(c);
});
child.on('exit', (code) => process.exit(code ?? 0));
`;

// ------------------------------------------------------------- scaffolding --

/**
 * Lay down the channel server, the tee, and the log files a probe reads back.
 *
 * The SDK is resolved from the daemon's own node_modules — the same install the
 * product uses, so a probe cannot pass against a version the product lacks.
 */
export function makeChannelWorkspace(dir, { mode, nonce, controlNonce }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chan.mjs'), CHANNEL_SERVER);
  fs.writeFileSync(path.join(dir, 'tee.mjs'), TEE);
  try { fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'dir'); } catch {}

  const env = {
    PROBE_MODE: mode,
    PROBE_NONCE: nonce,
    PROBE_CONTROL_NONCE: controlNonce ?? '',
    PROBE_SERVER_LOG: path.join(dir, 'server.log'),
    PROBE_REPLY_LOG: path.join(dir, 'replies.log'),
    PROBE_WIRE_LOG: path.join(dir, 'wire.log'),
    PROBE_SOCKET: SOCKET_PATH,
    PROBE_STDERR: path.join(dir, 'stderr.log')
  };
  for (const f of ['server.log', 'replies.log', 'wire.log', 'stderr.log']) fs.writeFileSync(path.join(dir, f), '');
  return {
    name: 'butchrprobe',
    definition: {
      command: process.execPath,
      args: [path.join(dir, 'tee.mjs'), process.execPath, path.join(dir, 'chan.mjs')],
      env
    }
  };
}

/** Merge servers into a workspace `.mcp.json`, preserving what is already there. */
export function writeMcpJson(dir, servers) {
  const p = path.join(dir, '.mcp.json');
  let config = {};
  if (fs.existsSync(p)) { try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { config = {}; } }
  config.mcpServers = { ...config.mcpServers, ...servers };
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

/**
 * The two Claude Code settings the daemon writes for every real Butchr
 * workspace: `enableAllProjectMcpServers` so there is no server-consent dialog,
 * and `bypassPermissions` so a tool is not gated behind an approval nobody is
 * present to give. Used by the scratch (non-agent) configurations; a real
 * activation gets these from the product's own `configureClaudeSettings`.
 */
export function writeClaudeSettings(dir) {
  const p = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let s = {};
  if (fs.existsSync(p)) { try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { s = {}; } }
  s.enableAllProjectMcpServers = true;
  s.permissions = { ...s.permissions, defaultMode: 'bypassPermissions' };
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

export function trustDir(dir) {
  const f = path.join(os.homedir(), '.claude.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
  const key = path.normalize(path.resolve(dir));
  c.projects = { ...c.projects, [key]: { ...c.projects?.[key], hasTrustDialogAccepted: true } };
  const tmp = `${f}.probe-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, f);
  return true;
}

/** Read the frames the tee recorded, so CP2 rests on the wire, not on a claim. */
export function channelFramesOnWire(dir, nonce) {
  const p = path.join(dir, 'wire.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.dir === 'server->client'
      && r.frame?.method === 'notifications/claude/channel'
      && (!nonce || JSON.stringify(r.frame).includes(nonce)));
}

/**
 * Wait until the channel server says it is up, and REFUSE TO PROCEED if it
 * never does.
 *
 * Added after `probe-channel-delivery.mjs`'s own first run answered "the sender
 * observed ECONNREFUSED" for the REACHABLE leg — because a bug in the tee
 * wrapper meant the server had never started. Every downstream line was still
 * printed, and the run reported a clean "the sender cannot tell arrived from
 * not-arrived" that was really "this script never sent anything". A
 * configuration whose trigger was never live cannot reach a verdict, and now
 * says so.
 */
export async function awaitServerUp(dir, { needsPort }) {
  const logPath = path.join(dir, 'server.log');
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    let log = '';
    try { log = fs.readFileSync(logPath, 'utf8'); } catch {}
    if (!needsPort) { if (log.includes('"socket-connected"')) return { up: true }; continue; }
    // The port is whatever the OS handed the server, so it is read back here
    // rather than assumed by the caller.
    const m = /"ev":"listening","port":(\d+)/.exec(log);
    if (m) return { up: true, port: Number(m[1]) };
  }
  return { up: false };
}

/**
 * Establish the probe-target role in a bare tmux session, as a real Butchr
 * agent's `.butchr-prompt.md` does for an activated agent.
 *
 * NOT a contamination of the measurement, and the distinction matters: this
 * says a channel named butchrprobe is an expected test harness and what to do
 * with a token that arrives on it. IT NEVER CONTAINS THE NONCE. Without it an
 * unprimed session correctly treats an arriving channel event as untrusted
 * content and may refuse to act — observed, see the `instructions` note above —
 * which would make a genuine delivery read as a non-delivery.
 */
export function primeSession(tmuxName) {
  const brief =
    'You are a probe target for a delivery test. A channel called butchrprobe is '
    + 'an expected local test harness set up by me for this session. When an event '
    + 'arrives on it asking you to echo a token, call the butchrprobe reply tool '
    + 'with that token. Do not read or write any file, and do not run any command. '
    + 'Reply now with exactly: PROBE READY';
  try {
    execSync(`tmux send-keys -t ${tmuxName} -l ${JSON.stringify(brief)}`);
    execSync(`tmux send-keys -t ${tmuxName} Enter`);
    return true;
  } catch { return false; }
}

/**
 * Reap channel servers spawned for a configuration.
 *
 * `claude -p` does not always take its MCP subprocesses down with it: an
 * orphaned server from one run was still holding its port when the next run
 * started, and killed that run's configuration A with EADDRINUSE.
 */
export function killServersFor(dir) {
  // The pattern travels in the ENVIRONMENT, not on the command line. Written
  // the obvious way -- `pkill -f "<dir>"` -- the shell running pkill has the
  // pattern in its own argv, so pkill matches and kills that shell. Measured:
  // it takes the exit code with it (144) and the cleanup silently does nothing.
  try {
    execSync('pkill -f "$BUTCHR_PROBE_KILL_PATTERN" || true',
      { stdio: 'ignore', env: { ...process.env, BUTCHR_PROBE_KILL_PATTERN: dir } });
  } catch { /* nothing matched, which is the normal case */ }
}

export function serverStderr(dir) {
  try { return fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8').trim(); } catch { return ''; }
}

export function repliesCarrying(dir, nonce) {
  const p = path.join(dir, 'replies.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).filter((l) => l.includes(nonce));
}

/**
 * Every `reply` tool call the model made, WITH THE SERVER'S OWN TIMESTAMP.
 *
 * `replies.log` is content-only, which is enough when a probe fires once. KAN-219
 * fires several times at one long-lived agent and has to tell round 2's echo from
 * round 1's — and the two can be byte-identical. Time is what separates them, so
 * this reads `server.log`, where the timestamp already was.
 */
export function replyEvents(dir) {
  const p = path.join(dir, 'server.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.ev === 'reply-tool-called')
    .map((r) => ({ t: r.t, text: String(r.text ?? '') }));
}

/**
 * Push an event and report EXACTLY what the sender learned.
 *
 * `ok` is the transport-level answer only. The distinction it exists to expose:
 * an event that resolves cleanly here may still have reached nobody.
 */
export function postTo(port, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST' }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ ok: true, ...(parsed ?? { senderObserved: out || 'no body' }) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, senderObserved: `transport unreachable (${e.code ?? e.message})` }));
    req.end(body);
  });
}

// ----------------------------------------------------------- the daemon --

/**
 * An ordinary RPC client on the daemon's Unix socket — the same socket the
 * product's own MCP server speaks, addressed the same way.
 */
export async function connectDaemonRpc() {
  const rpc = net.connect(SOCKET_PATH);
  rpc.on('error', () => {});
  await new Promise((r) => rpc.once('connect', r));
  const pending = new Map();
  let rbuf = '';
  let nextId = 0;
  rpc.on('data', (chunk) => {
    rbuf += chunk.toString('utf8');
    let i;
    while ((i = rbuf.indexOf('\n')) !== -1) {
      const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        const r = m?.id !== undefined ? pending.get(m.id) : undefined;
        if (r) { pending.delete(m.id); r(m); }
      } catch {}
    }
  });
  const call = (action, data = {}) => new Promise((resolve) => {
    const id = `probe-${process.pid}-${++nextId}`;
    pending.set(id, resolve);
    rpc.write(JSON.stringify({ action, ...data, id }) + '\n');
    setTimeout(() => { if (pending.delete(id)) resolve({ timedOut: true }); }, 60_000);
  });
  return { call, close: () => { try { rpc.destroy(); } catch {} } };
}

/**
 * A SECOND, independent connection that only watches `*_event` broadcasts.
 *
 * Independent on purpose: a broadcast confirmed only by the connection that
 * caused it is a claim about that connection.
 */
export async function observeDaemonBroadcasts() {
  const events = [];
  const observer = net.connect(SOCKET_PATH);
  let obuf = '';
  observer.on('error', () => {});
  observer.on('data', (chunk) => {
    obuf += chunk.toString('utf8');
    let i;
    while ((i = obuf.indexOf('\n')) !== -1) {
      const line = obuf.slice(0, i); obuf = obuf.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (String(m?.action ?? '').endsWith('_event')) events.push(m); } catch {}
    }
  });
  await new Promise((r) => observer.once('connect', r));
  return { events, close: () => { try { observer.destroy(); } catch {} } };
}

// ------------------------------------------- a real Butchr agent, channelled --

/**
 * Bring up a REAL Butchr agent with a channel attached, and hand back the
 * handles a probe needs to drive and observe it.
 *
 * THE SHIPPED PATH, and the only shape that licenses a claim about the fleet.
 * A real agent is activated THROUGH THE DAEMON, so it gets the real workspace,
 * the real daemon-written `.mcp.json` (core `butchr` server, identity-stamped
 * by `withWorkspaceIdentity`), the real brief write, and a real herdr pane.
 *
 * HOW THIS DIFFERS FROM A PRODUCTION ACTIVATION — all of it, stated here rather
 * than left for a reader to find:
 *
 *   1. The launcher flag. `AGENT_LAUNCHERS.claude.command()` in launchers.ts
 *      spawns `claude` with NO channels flag, so no fleet agent can receive a
 *      channel event today. This takes that exact command string FROM THE
 *      PRODUCT (it imports dist/launchers.js rather than retyping it) and
 *      splices in `--dangerously-load-development-channels server:butchrprobe`.
 *      The splice is printed so the delta is visible, not asserted.
 *   2. A second MCP server. The probe channel is merged into the workspace
 *      `.mcp.json` alongside the daemon's own entries. The core `butchr` server
 *      is untouched and no product file is modified.
 *   3. The pane runs `shell` first. Activating as `shell` (rather than
 *      `claude`) leaves the probe holding the pane at a bash prompt, which is
 *      the only way to start `claude` with an extra flag without editing the
 *      product. The daemon still writes `.mcp.json` and the brief for a `shell`
 *      activation (herdr.ts writes both before `launcher.setup`); what the
 *      `shell` launcher skips is `configureClaudeSettings` and
 *      `trustClaudeWorkspace`, so THE PRODUCT'S OWN functions are imported from
 *      dist/launchers.js and run here rather than reimplemented.
 *
 * @returns a handle, or `{ ok: false, reason }`. Callers MUST call
 *          `standDownAgent` in a `finally`.
 */
export async function bringUpChannelAgent({
  call,
  type,
  key,
  brief,
  chanDir,
  nonce,
  say = stdoutSay,
  settleMs = 25_000,
  readyPattern = /PROBE READY|bypass permissions|for shortcuts/,
  serverName = 'butchrprobe',
  // How long to keep waiting when the daemon refuses for want of capacity.
  // DEFAULT ZERO — one attempt, which is what `probe-channel-delivery.mjs` did
  // before this was extracted, and changing that silently would have been a
  // behaviour change smuggled in under a refactor.
  //
  // NEVER `override: true`. The daemon offers it, and it is the wrong tool
  // here twice over: it pushes a machine past its own guard while other agents
  // are working, and every timing a probe reads is a timing off a loaded
  // machine. Waiting costs minutes; overriding costs the measurement.
  activationRetryMs = 0
}) {
  const agentName = `butchr-${type}-${key.toLowerCase()}`;
  const ws = path.join(BUTCHR_DIR, 'workspaces', type, key.toLowerCase());

  say('activating a real agent through the daemon (defaultAgent: shell — see note 3)…');
  let act = await call('activate_by_key', { type, key, defaultAgent: 'shell' });
  if (!act?.success && activationRetryMs > 0) {
    const deadline = Date.now() + activationRetryMs;
    const firstLine = String(act?.error ?? '').split('\n')[0];
    say(`  refused: ${firstLine}`);
    say(`  waiting for a slot rather than overriding — up to ${Math.round(activationRetryMs / 1000)}s…`);
    while (!act?.success && Date.now() < deadline) {
      await sleep(20_000);
      act = await call('activate_by_key', { type, key, defaultAgent: 'shell' });
      if (!act?.success) {
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        say(`    still refused (${String(act?.error ?? '').split('\n')[0].slice(0, 90)}…) — ${left}s left`);
      }
    }
  }
  if (!act?.success) {
    say(`  BLOCKED: activation refused — ${act?.error ?? JSON.stringify(act)}`);
    return { ok: false, activated: false, reason: act?.error ?? 'activation refused' };
  }
  say(`  activated: ${agentName}`);
  await sleep(4000);

  // What the daemon wrote for this workspace, on its own — evidence, not assumption.
  const daemonMcp = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')); } catch { return {}; }
  })();
  const daemonServers = Object.keys(daemonMcp.mcpServers ?? {});
  say(`  .mcp.json written by the daemon: ${daemonServers.join(', ') || '(none)'}`);
  const coreArgs = daemonMcp.mcpServers?.butchr?.args ?? [];
  say(`  core butchr server identity flags: ${coreArgs.slice(1).join(' ') || '(none)'}`);

  fs.writeFileSync(path.join(ws, '.butchr-prompt.md'), brief);

  // Merge the probe channel in beside the daemon's own servers.
  const { name, definition } = makeChannelWorkspace(chanDir, { mode: 'daemon', nonce });
  writeMcpJson(ws, { [name]: definition });

  // The two setup steps the `shell` launcher skips, run from THE PRODUCT'S OWN
  // code so this cannot drift from what a claude activation does.
  const launchers = await import(`file://${LAUNCHERS_JS}`);
  launchers.configureClaudeSettings(ws);
  const trust = launchers.trustClaudeWorkspace(ws);
  say(`  product configureClaudeSettings + trustClaudeWorkspace: ${trust.ok ? 'ok' : 'FAILED — ' + trust.error}`);

  // The product's own claude command, verbatim and WHOLE, plus exactly one
  // flag. Called with no argument so it uses the launcher's real default
  // prompt — the one that sends the agent to `.butchr-prompt.md`, which is how
  // a fleet agent is instructed and therefore how this one must be.
  //
  // Both halves of the `||` are stamped. Taking only the first was wrong and
  // this harness proved it on itself: `--continue` in a fresh workspace exits
  // "No conversation found to continue", which is exactly the case the fallback
  // exists for, so the pane died at a bash prompt having started nothing.
  const shipped = launchers.AGENT_LAUNCHERS.claude.command();
  const withChannels = shipped.replaceAll(
    'claude --permission-mode',
    `claude --dangerously-load-development-channels server:${serverName} --permission-mode`);
  say('');
  say("  the product's own claude command line, verbatim:");
  say(`    ${shipped}`);
  say('  as launched here (the whole delta from production is the one flag, twice):');
  say(`    ${withChannels}`);
  say('');

  const paneId = (() => {
    try {
      const out = execFileSync('herdr', ['agent', 'get', agentName], { encoding: 'utf8' });
      return JSON.parse(out)?.result?.agent?.pane_id ?? null;
    } catch { return null; }
  })();
  if (!paneId) {
    say('  BLOCKED: could not resolve the herdr pane for this agent.');
    return { ok: false, activated: true, reason: 'no pane' };
  }
  say(`  herdr pane: ${paneId}`);

  const sendText = (t) => execFileSync('herdr', ['pane', 'send-text', paneId, t], { encoding: 'utf8' });
  const sendKey = (k) => execFileSync('herdr', ['pane', 'send-keys', paneId, k], { encoding: 'utf8' });
  const tail = async (lines = 160) => (await call('tail_agent', { key, type, lines }))?.text ?? '';

  say('  starting claude in the pane, with the channel enabled…');
  sendText(withChannels);
  sendKey('Enter');

  // THE RESEARCH-PREVIEW DIALOG. `--dangerously-load-development-channels`
  // opens a full-screen confirmation BEFORE the session starts, and it is
  // BLOCKING — an unattended client sits on it forever. It appears once per
  // `claude` invocation, so the shipped `--continue || claude …` command raises
  // it TWICE on a fresh workspace. Nothing in Butchr answers it today. This is
  // a finding in its own right; see docs/channel-delivery.md.
  let dialogs = 0;
  let notice = false;
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(3000);
    const t = await tail(140);
    if (/Loading development channels|I am using this for local development/.test(t)) {
      dialogs += 1;
      say(`  development-channels warning dialog #${dialogs} — dismissing with Enter`);
      sendKey('Enter');
      await sleep(3000);
      continue;
    }
    if (/Channels \(experimental\)/.test(t)) notice = true;
    if (readyPattern.test(t)) ready = true;
    if (notice && ready) break;
  }
  say(`  blocking dialogs raised and dismissed: ${dialogs}`);
  say(`  startup notice "Channels (experimental) … inject directly in this session": ${yn(notice)}`);
  say(`  agent reached its prompt: ${yn(ready)}`);

  // The channel server is spawned only after the dialog clears, so the pane can
  // look ready before the listener exists. Measured on configuration F.
  const chanUp = await awaitServerUp(chanDir, { needsPort: false });
  say(`  our channel server connected to the daemon socket (trigger live): ${yn(chanUp.up)}`);
  if (!chanUp.up) say(`    server stderr: ${serverStderr(chanDir) || '(empty)'}`);
  await sleep(settleMs);

  return {
    ok: true,
    activated: true,
    agentName, ws, paneId, sendText, sendKey, tail,
    dialogs, notice, ready,
    chanUp: chanUp.up,
    daemonServers, coreArgs,
    shipped, withChannels
  };
}

/** Stand the probe agent down and delete its workspace. Belongs in a `finally`. */
export async function standDownAgent(call, type, key, say = stdoutSay) {
  say('');
  say('  standing the probe agent down and deleting its workspace…');
  await call('deactivate_by_key', { type, key });
  await sleep(2000);
  await call('reset_by_key', { type, key });
}
