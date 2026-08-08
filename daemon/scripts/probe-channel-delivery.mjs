#!/usr/bin/env node
//
// KAN-217 — can a Claude Code *channel* push a message into a running Butchr
// agent, and does the model actually receive it?
//
// WHAT FAILURE THIS WOULD CATCH: a channel event that our server emits, that
// Claude Code draws on the agent's pane as `← name: …`, and that the model
// never reads — so a Butchr messaging migration built on channels would look
// wired up end to end while every nudge died at the client. That is exactly the
// failure KAN-167 measured and found REAL for `notifications/message`, and the
// reason nobody may quote the docs in place of running this.
//
// It would equally catch the inverse over-claim, which is the one this run is
// actually at risk of: reporting "channels deliver" on evidence that would look
// identical if the nonce had reached the model down some other path. That is
// what configuration N is for.
//
// NOT a `verify-` script, deliberately, for the same reason KAN-167's probe is
// not (do not rename). It drives a live `claude` CLI and a real model, so it is
// an experiment, not a deterministic proof of product behaviour CI can re-run;
// a `verify-` name would enrol it in `verify-script-sweep` and assert a
// guarantee it cannot make.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives, so
// stated plainly, per configuration:
//
//   A, C, N — this script writes the channel server AND fires its trigger over
//   a local HTTP port. They therefore test the CLIENT's handling of a
//   well-formed channel event and nothing whatsoever about Butchr's daemon.
//   Configuration D is what covers the daemon.
//
//   D — the nonce rides inside a REAL daemon broadcast. The channel server
//   holds an ordinary client connection to the daemon's Unix socket, sees the
//   `agent_reset_event` frame the daemon emits on its own, and turns that into
//   the channel event. This script still *causes* the broadcast (by resetting a
//   scratch workspace it created for the purpose), so D does NOT establish that
//   production events fire unprompted — KAN-167 established that by citation
//   (`router.ts:1412`, `:1601`, `:1683`, `:1747`, `:2003`) and it is not
//   re-established here. What D tests is that a real daemon broadcast, once
//   emitted, can reach the model of a real Butchr agent as a channel event.
//
//   WHAT NO CONFIGURATION HERE COVERS — and nobody else covers it either:
//   whether a channel event arriving while the agent is MID-TOOL-CALL disturbs
//   that call. Every configuration below fires at an IDLE agent. That is the
//   destructive question, it is the whole reason channels would be worth
//   migrating to, and it is only reachable now that delivery is established.
//   docs/channel-delivery.md says so rather than letting a reader assume it was
//   tested, and KAN-217 files it as follow-up rather than leaving it unowned.
//
// ---------------------------------------------------------------------------
// THE FOUR CHECKPOINTS — the last one is the answer, the third is not
// ---------------------------------------------------------------------------
//   CP1  the event was emitted        — our trigger fired and the server acted
//   CP2  it left our server           — a `notifications/claude/channel` frame
//                                       observed on the stdio wire by a TEE
//                                       wrapper, not by the server's own claim
//   CP3  it rendered on the pane      — RECORDED, NEVER COUNTED AS DELIVERY.
//                                       A line drawn on a pane the model does
//                                       not read is the failure this exists to
//                                       catch and would otherwise look like
//                                       success.
//   CP4  the model received it        — in two independent strengths:
//          CP4a  the model called the channel's own `reply` tool carrying the
//                nonce. THE COMPOSER IS NEVER USED for this reading, in either
//                direction: the nonce goes in over the channel and comes back
//                out over the channel. Nothing this script types can produce it.
//          CP4b  the model quoted the nonce when asked down the composer —
//                KAN-167's method, kept so the two findings are comparable.
//
// THE NONCE IS NEVER TYPED BY THIS SCRIPT into anything an agent can see. In
// A/C/N it exists only in an HTTP body posted to our own server; in D it exists
// only inside a daemon broadcast payload, riding in a workspace key. If a model
// can produce it, it can only have come from the channel.
//
// EXIT CODE: derived from whether each configuration could be run to a VERDICT,
// not from which way the verdict went. "Channels deliver" and "channels drop"
// are both passing results for the ticket. A configuration that could not reach
// a verdict, or a control that did not behave as a control must, exits 1 —
// then this script is reporting nothing trustworthy either way.
//
// Usage:
//   cd daemon && npm install && npm run build   # D needs dist/launchers.js
//   node scripts/probe-channel-delivery.mjs [--only=A|C|N|D] [--model=m]
//
// RUN MODES, because KAN-167 nearly published a verdict measured only in the
// mode the fleet does not run:
//   A, C  drive `claude -p --output-format stream-json`   — HEADLESS PRINT MODE
//   N     drives interactive Claude Code in a scratch tmux pane — NOT a Butchr
//         agent; it exists only to vary the one flag, with all else identical
//   D     drives a real Butchr agent activated THROUGH THE DAEMON, interactive
//         under a herdr pane — THE ONLY MODE THE FLEET RUNS
//
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import http from 'http';
import { spawn, execSync, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const DAEMON_DIR = path.join(repoRoot, 'daemon');
const NODE_MODULES = path.join(DAEMON_DIR, 'node_modules');
const LAUNCHERS_JS = path.join(DAEMON_DIR, 'dist', 'launchers.js');
const BUTCHR_DIR = path.join(os.homedir(), '.local', 'share', 'butchr');
const SOCKET_PATH = path.join(BUTCHR_DIR, 'butchr.sock');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ONLY = arg('only', null);
const MODEL = arg('model', 'sonnet');
const KEEP = argv.includes('--keep');
/** How long a session gets to settle after it looks ready. See configF. */
const SETTLE_MS = Number(arg('settle-ms', 25_000));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan217-probe-'));
const nonceRoot = randomBytes(6).toString('hex').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t) => { say(''); say('='.repeat(76)); say(t); say('='.repeat(76)); };
const yn = (b) => (b ? 'YES' : 'NO ');

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
//   http   — an HTTP POST on 127.0.0.1 (configs A, C, N). Ours, not Butchr's.
//   daemon — an ordinary client connection to the Butchr daemon's Unix socket,
//            watching for the `*_event` broadcasts the daemon emits on its own
//            (config D). This is the mode that matters: it is the real event
//            stream `daemon/dist/mcp.js` already consumes, proving the carrier
//            can be fed by the daemon exactly as it stands today.
const CHANNEL_SERVER = String.raw`
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

// Returns WHAT THE SENDER OBSERVES, which is the second half of this ticket.
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
  http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const outcome = await emit(body, { probe: 'kan217' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(outcome));
  }).listen(Number(process.env.PROBE_PORT), '127.0.0.1', () => log({ ev: 'listening' }));
} else {
  // Config D. An ordinary daemon client, watching the broadcast stream.
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
        { probe: 'kan217', action: m.action }
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
const TEE = String.raw`
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

let portCursor = 8830;
function nextPort() { return portCursor++; }

/**
 * Lay down a workspace a `claude` can be started in: the channel server, the
 * tee, an `.mcp.json` pointing at them, and the two Claude Code settings the
 * daemon writes for every real Butchr workspace (`enableAllProjectMcpServers`
 * so no server-consent dialog, `bypassPermissions` so the reply tool is not
 * gated behind an approval nobody is present to give).
 */
function makeChannelWorkspace(dir, { mode, nonce, controlNonce, port }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chan.mjs'), CHANNEL_SERVER);
  fs.writeFileSync(path.join(dir, 'tee.mjs'), TEE);
  // The SDK is resolved from the daemon's own node_modules — the same install
  // the product uses, so this cannot pass against a version the product lacks.
  try { fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'dir'); } catch {}

  const env = {
    PROBE_MODE: mode,
    PROBE_NONCE: nonce,
    PROBE_CONTROL_NONCE: controlNonce ?? '',
    PROBE_SERVER_LOG: path.join(dir, 'server.log'),
    PROBE_REPLY_LOG: path.join(dir, 'replies.log'),
    PROBE_WIRE_LOG: path.join(dir, 'wire.log'),
    PROBE_SOCKET: SOCKET_PATH,
    PROBE_STDERR: path.join(dir, 'stderr.log'),
    ...(port ? { PROBE_PORT: String(port) } : {})
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

function writeMcpJson(dir, servers) {
  const p = path.join(dir, '.mcp.json');
  let config = {};
  if (fs.existsSync(p)) { try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { config = {}; } }
  config.mcpServers = { ...config.mcpServers, ...servers };
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

function writeClaudeSettings(dir) {
  const p = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let s = {};
  if (fs.existsSync(p)) { try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { s = {}; } }
  s.enableAllProjectMcpServers = true;
  s.permissions = { ...s.permissions, defaultMode: 'bypassPermissions' };
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

function trustDir(dir) {
  const f = path.join(os.homedir(), '.claude.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
  const key = path.normalize(path.resolve(dir));
  c.projects = { ...c.projects, [key]: { ...c.projects?.[key], hasTrustDialogAccepted: true } };
  const tmp = `${f}.kan217-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, f);
  return true;
}

/** Read the frames the tee recorded, so CP2 rests on the wire, not on a claim. */
function channelFramesOnWire(dir, nonce) {
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
 * Added after this probe's own first run answered "the sender observed
 * ECONNREFUSED" for the REACHABLE leg — because a bug in the tee wrapper meant
 * the server had never started. Every downstream line was still printed, and
 * the run reported a clean "the sender cannot tell arrived from not-arrived"
 * that was really "this script never sent anything". That is precisely the
 * shape this ticket exists to catch, committed by the probe itself, so the
 * guard is here rather than in a reader's head: a configuration whose trigger
 * was never live cannot reach a verdict, and now says so.
 */
async function awaitServerUp(dir, { needsPort }) {
  const logPath = path.join(dir, 'server.log');
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    let log = '';
    try { log = fs.readFileSync(logPath, 'utf8'); } catch {}
    if (needsPort ? log.includes('"listening"') : log.includes('"socket-connected"')) return true;
  }
  return false;
}

/**
 * Establish the probe-target role in a bare tmux session, as a real Butchr
 * agent's `.butchr-prompt.md` does for configuration D.
 *
 * NOT a contamination of the measurement, and the distinction matters: this
 * says a channel named butchrprobe is an expected test harness and what to do
 * with a token that arrives on it. IT NEVER CONTAINS THE NONCE. Without it an
 * unprimed session correctly treats an arriving channel event as untrusted
 * content and may refuse to act — observed, see the `instructions` note above —
 * which would make a genuine delivery read as a non-delivery.
 */
function primeSession(tmuxName) {
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

function serverStderr(dir) {
  try { return fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8').trim(); } catch { return ''; }
}

function repliesCarrying(dir, nonce) {
  const p = path.join(dir, 'replies.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).filter((l) => l.includes(nonce));
}

/**
 * Push an event and report EXACTLY what the sender learned.
 *
 * `ok` is the transport-level answer only. The distinction it exists to expose
 * is the one KAN-217's second acceptance criterion turns on: an event that
 * resolves cleanly here may still have reached nobody.
 */
function postTo(port, body) {
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

// ---------------------------------------------------- print-mode driver --

/**
 * Drive `claude -p` over stream-json and return every line it emitted.
 * `beforeSecondTurn` runs between the two turns — that is where the channel
 * event is pushed, so it lands at a genuinely IDLE session between turns.
 */
async function runPrintSession(dir, { channelFlag, question, beforeSecondTurn }) {
  const args = [];
  if (channelFlag) args.push('--dangerously-load-development-channels', 'server:butchrprobe');
  args.push('-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--permission-mode', 'bypassPermissions', '--model', MODEL);

  const cp = spawn('claude', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  cp.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lines.push(l); }
  });
  cp.stderr.on('data', () => {});
  const results = () => lines.filter((l) => l.includes('"type":"result"')).length;
  const send = (text) => cp.stdin.write(JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }
  }) + '\n');
  const awaitTurn = async () => {
    const before = results();
    for (let i = 0; i < 180; i += 1) { await sleep(1000); if (results() > before) return true; }
    return false;
  };

  await sleep(3000);
  send('Reply with exactly: READY. Do not call any tool.');
  const t1 = await awaitTurn();
  if (beforeSecondTurn) await beforeSecondTurn();
  await sleep(5000);
  send(question);
  const t2 = await awaitTurn();
  await sleep(500);
  try { cp.kill(); } catch {}

  const mcpStatus = (() => {
    for (const l of lines) {
      try { const m = JSON.parse(l); if (m.type === 'system' && m.subtype === 'init') return m.mcp_servers ?? []; } catch {}
    }
    return [];
  })();
  return { lines, transcript: lines.join('\n'), reachedVerdict: t1 && t2, mcpStatus };
}

// ------------------------------------------------- configurations A and C --

async function configA() {
  rule('CONFIGURATION A — channel event, HEADLESS PRINT MODE (`claude -p`)');
  say('The mode no fleet agent runs. Included because it is the mode anyone');
  say('testing this headlessly would reach for first, and its answer differs.');
  say('');
  const nonce = `${nonceRoot}A`;
  const dir = path.join(scratch, 'A');
  const port = nextPort();
  const { name, definition } = makeChannelWorkspace(dir, { mode: 'http', nonce, port });
  writeMcpJson(dir, { [name]: definition });
  writeClaudeSettings(dir);
  trustDir(dir);
  say(`nonce (never typed by this script): ${nonce}`);

  let push = { ok: false, senderObserved: 'not attempted' };
  const session = await runPrintSession(dir, {
    channelFlag: true,
    beforeSecondTurn: async () => {
      const serverUp = await awaitServerUp(dir, { needsPort: true });
      say(`  our channel server is listening (trigger live): ${yn(serverUp)}`);
      if (!serverUp) say(`    server stderr: ${serverStderr(dir) || '(empty)'}`);
      push = await postTo(port, `BUTCHR CHANNEL PROBE ${nonce} :: echo this token back by calling the butchrprobe reply tool now.`);
      say(`  pushed the channel event; the SENDER observed: ${push.senderObserved}`);
    },
    question: 'Since your last turn, has any text arrived in your context from a channel '
      + 'or from an MCP server outside of a tool result? If yes, quote it VERBATIM. '
      + 'If nothing of the kind arrived, reply with exactly: NOTHING ARRIVED. Do not call any tool.'
  });

  const onWire = channelFramesOnWire(dir, nonce);
  const replies = repliesCarrying(dir, nonce);
  const inContext = session.transcript.includes(nonce);
  const registered = session.mcpStatus.find((s) => s.name === 'butchrprobe')?.status;

  say('');
  say('--- verdict: configuration A — print mode ---');
  say(`  MCP server status reported by the client : ${registered ?? 'not reported'}`);
  say(`  CP1 event emitted                        : ${yn(push.ok)}`);
  say(`  CP2 frame left our server (tee on wire)  : ${yn(onWire.length > 0)}  ${onWire.length} frame(s)`);
  say(`  CP3 rendered on a pane                   : n/a (print mode has no pane)`);
  say(`  CP4a model echoed via the reply tool     : ${yn(replies.length > 0)}`);
  say(`  CP4b nonce anywhere in the client stream : ${yn(inContext)}`);
  say(`  what the SENDER observed                 : ${push.senderObserved}`);
  return {
    label: 'A — print mode', nonce, mode: 'print', flag: true,
    cp1: push.ok, cp2: onWire.length > 0, cp3: null,
    cp4a: replies.length > 0, cp4b: inContext,
    senderObserved: push.senderObserved,
    ranToVerdict: push.ok && onWire.length > 0 && session.reachedVerdict,
    note: registered ?? 'not reported'
  };
}

async function configC() {
  rule('CONFIGURATION C — POSITIVE CONTROL, print mode (nonce on a tool RESULT)');
  say("KAN-167's control, unchanged in purpose: a detector that has only ever");
  say('said NO is indistinguishable from a broken detector. This carries the');
  say('same kind of token out on the one path already known to reach the model,');
  say("so configuration A's NO is a fact about channels rather than about this");
  say('script being unable to see anything at all.');
  say('');
  const nonce = `${nonceRoot}C`;
  const control = `${nonceRoot}-C-CONTROL`;
  const dir = path.join(scratch, 'C');
  const port = nextPort();
  const { name, definition } = makeChannelWorkspace(dir, { mode: 'http', nonce, controlNonce: control, port });
  writeMcpJson(dir, { [name]: definition });
  writeClaudeSettings(dir);
  trustDir(dir);
  say(`control token (rides on a tool result): ${control}`);

  const session = await runPrintSession(dir, {
    channelFlag: true,
    question: 'Call the butchrprobe status tool once, then quote its ENTIRE result VERBATIM.'
  });
  const inContext = session.transcript.includes(control);
  say('');
  say('--- verdict: configuration C — positive control ---');
  say(`  control token present in the client stream : ${yn(inContext)}`);
  say(`  (this is the line that makes A's NO mean something)`);
  return {
    label: 'C — positive control', nonce: control, mode: 'print', control: true,
    controlArrived: inContext, ranToVerdict: session.reachedVerdict
  };
}

// ------------------------------------ configuration N (NEGATIVE CONTROL) --
//
// The control this finding actually needs. KAN-167 got a NO and needed a
// POSITIVE control to prove its detector was not broken. This probe gets a YES,
// and a YES has the opposite failure mode: the nonce reaching the model down
// some path that is not the channel at all, which would look identical. N holds
// everything fixed — same server, same workspace shape, same interactive
// client, same trigger — and removes exactly one thing: the flag naming the
// server to `--dangerously-load-development-channels`.
//
// If N delivers too, D proves nothing about channels. If N stays silent, the
// flag is load-bearing, and that is simultaneously the answer to "what would
// Butchr have to change to switch this on": the LAUNCHER, not the server.
//
// N is deliberately NOT a Butchr agent. It varies one flag; making it a real
// agent would vary the flag and the whole activation path at once.
const TMUX_SESSION = 'kan217-probe-n';

async function configN() {
  rule('CONFIGURATION N — NEGATIVE CONTROL, interactive, flag ABSENT');
  const nonce = `${nonceRoot}N`;
  const dir = path.join(scratch, 'N');
  const port = nextPort();
  const { name, definition } = makeChannelWorkspace(dir, { mode: 'http', nonce, port });
  writeMcpJson(dir, { [name]: definition });
  writeClaudeSettings(dir);
  trustDir(dir);
  say(`nonce (never typed by this script): ${nonce}`);
  say('the server IS in .mcp.json; it is NOT named to the channels flag.');
  say('');

  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
  const cmd = `claude --permission-mode bypassPermissions --model ${MODEL}`;
  execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 200 -y 50 -c ${JSON.stringify(dir)} ${JSON.stringify(cmd)}`);
  const pane = () => { try { return execSync(`tmux capture-pane -p -t ${TMUX_SESSION}`, { encoding: 'utf8' }); } catch { return ''; } };

  let up = false;
  for (let i = 0; i < 30; i += 1) { await sleep(2000); if (/bypass permissions|for shortcuts|❯/.test(pane())) { up = true; break; } }
  say(`  client reached its prompt: ${yn(up)}`);
  const banner = pane();
  const sawChannelNotice = /Channels \(experimental\)/.test(banner);
  say(`  startup channels notice present: ${yn(sawChannelNotice)}  (must be NO here)`);

  const serverUp = await awaitServerUp(dir, { needsPort: true });
  say(`  our channel server is listening (trigger live): ${yn(serverUp)}`);
  if (!serverUp) {
    say(`  ABORTING — the trigger never came up. stderr: ${serverStderr(dir) || '(empty)'}`);
    try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
    return { label: 'N — negative control', control: true, ranToVerdict: false,
             blocked: 'channel server never listened' };
  }
  await sleep(SETTLE_MS);
  say('  priming the session with the probe-target role (no nonce in it)…');
  primeSession(TMUX_SESSION);
  for (let i = 0; i < 20; i += 1) { await sleep(3000); if (/PROBE READY/.test(pane())) break; }
  say(`  primed: ${yn(/PROBE READY/.test(pane()))}  (identical to configuration F — only the flag differs)`);

  const push = await postTo(port, `BUTCHR CHANNEL PROBE ${nonce} :: echo this token back by calling the butchrprobe reply tool now.`);
  say(`  pushed the channel event; the SENDER observed: ${push.senderObserved}`);
  await sleep(30000);

  const after = pane();
  const rendered = after.includes(nonce);
  const onWire = channelFramesOnWire(dir, nonce);
  const replies = repliesCarrying(dir, nonce);

  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}

  say('');
  say('--- verdict: configuration N — negative control ---');
  say(`  CP1 event emitted                       : ${yn(push.ok)}`);
  say(`  CP2 frame left our server (tee on wire) : ${yn(onWire.length > 0)}  ${onWire.length} frame(s)`);
  say(`  CP3 rendered on the pane                : ${yn(rendered)}`);
  say(`  CP4a model echoed via the reply tool    : ${yn(replies.length > 0)}`);
  say(`  a control behaving as a control means every one of CP3/CP4a is NO`);
  say('');
  say(`  incidentally: the channel was NOT enabled for this session, so nothing`);
  say(`  could arrive, and what the SENDER observed was: ${push.senderObserved}`);
  return {
    label: 'N — negative control', nonce, mode: 'interactive', flag: false, control: true,
    cp1: push.ok, cp2: onWire.length > 0, cp3: rendered, cp4a: replies.length > 0,
    sawChannelNotice, senderObserved: push.senderObserved,
    controlBehaved: onWire.length > 0 && !rendered && replies.length === 0,
    ranToVerdict: push.ok && onWire.length > 0 && up
  };
}

// ------------------------------------------ configuration F (FAILURE PATH) --
//
// THE SECOND OF THIS SPIKE'S TWO QUESTIONS, and no more than that.
//
// The human decided a durable queue is not wanted (comment 10918): if an agent
// is offline it simply does not get the message, and the sender is told. That
// makes the failure report load-bearing — an unreliable one converts a visible
// drop into an invisible one, which is strictly worse than the queue nobody
// wants. It is the shape `success: true` has failed in five times on this board.
//
// COMMENT 10919 THEN CUT THIS BACK, and this configuration is deliberately the
// smaller thing it asks for. 10918 had wanted failures distinguishable BY CAUSE
// — offline vs not-registered vs delivered-but-ignored, "three different sender
// behaviours" — and the human withdrew that as designing a vocabulary before
// observing anything once. What remains is one question, answered yes or no:
//
//   "When the recipient is not reachable, does the sender find out? Make it
//    happen once — close the session, then send — and report what the sender saw."
//
// So: two legs, not a taxonomy.
//
//   F1  reachable — channel enabled, session alive. Not a second question: it
//                   is the BASELINE, because "the sender finds out" is a claim
//                   about a DIFFERENCE and needs the success case to differ from.
//   F2  dead      — the session is killed, then one send is attempted.
//
// No retry policy, no error categories, no sender-behaviour recommendation.
// Those belong to the design that follows if both answers are yes.
const TMUX_SESSION_F = 'kan217-probe-f';

async function configF() {
  rule('CONFIGURATION F — THE FAILURE PATH (what does the SENDER observe?)');
  const nonce = `${nonceRoot}F`;
  const dir = path.join(scratch, 'F');
  const port = nextPort();
  const { name, definition } = makeChannelWorkspace(dir, { mode: 'http', nonce, port });
  writeMcpJson(dir, { [name]: definition });
  writeClaudeSettings(dir);
  trustDir(dir);
  say(`nonce (never typed by this script): ${nonce}`);
  say('');

  try { execSync(`tmux kill-session -t ${TMUX_SESSION_F} 2>/dev/null`); } catch {}
  const cmd = `claude --permission-mode bypassPermissions --dangerously-load-development-channels server:butchrprobe --model ${MODEL}`;
  execSync(`tmux new-session -d -s ${TMUX_SESSION_F} -x 200 -y 50 -c ${JSON.stringify(dir)} ${JSON.stringify(cmd)}`);
  const pane = () => { try { return execSync(`tmux capture-pane -p -t ${TMUX_SESSION_F}`, { encoding: 'utf8' }); } catch { return ''; } };

  // The research-preview dialog blocks startup; dismiss it.
  let dialog = false;
  for (let i = 0; i < 20 && !dialog; i += 1) {
    await sleep(2000);
    if (/Loading development channels|I am using this for local development/.test(pane())) dialog = true;
  }
  say(`  development-channels warning dialog appeared: ${yn(dialog)}`);
  if (dialog) { try { execSync(`tmux send-keys -t ${TMUX_SESSION_F} Enter`); } catch {} }

  let up = false;
  let notice = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    const p = pane();
    if (/Channels \(experimental\)/.test(p)) notice = true;
    if (/bypass permissions|for shortcuts|❯/.test(p)) { up = true; }
    if (up && notice) break;
  }
  say(`  session up: ${yn(up)}   channels notice: ${yn(notice)}`);
  const serverUp = await awaitServerUp(dir, { needsPort: true });
  say(`  our channel server is listening (trigger live): ${yn(serverUp)}`);
  if (!serverUp) {
    say(`  ABORTING this configuration — the trigger never came up, so nothing below`);
    say(`  would be a measurement. server stderr: ${serverStderr(dir) || '(empty)'}`);
    try { execSync(`tmux kill-session -t ${TMUX_SESSION_F} 2>/dev/null`); } catch {}
    return { label: 'F — failure path', control: true, failurePath: true, ranToVerdict: false,
             blocked: 'channel server never listened' };
  }
  say('');
  say('  NOTE: the "Channels (experimental)" notice above reflects the FLAG, not a');
  say('  working channel — this probe first saw it printed over a server that had');
  say('  crashed at startup. The notice is not evidence of a live channel.');
  // Claude Code spawns the MCP server only AFTER the development-channels
  // dialog is dismissed, so "the pane looks ready" can precede the channel
  // listener existing by seconds. Measured: an event pushed 2.3s after the
  // server said `listening` left our server correctly and was never acted on.
  // This settle is the difference between testing delivery and testing a race.
  say('  letting the session settle before pushing (the listener lags the pane)…');
  await sleep(SETTLE_MS);
  say('  priming the session with the probe-target role (no nonce in it)…');
  primeSession(TMUX_SESSION_F);
  for (let i = 0; i < 20; i += 1) { await sleep(3000); if (/PROBE READY/.test(pane())) break; }
  say(`  primed: ${yn(/PROBE READY/.test(pane()))}`);
  say('');

  // ---- F1: reachable ------------------------------------------------------
  say('  F1 — RECIPIENT REACHABLE (channel enabled, session alive)');
  const p1 = await postTo(port, `BUTCHR CHANNEL PROBE ${nonce}-ALIVE :: echo this token back by calling the butchrprobe reply tool now.`);
  say(`     the sender observed: ${p1.senderObserved}`);
  let acked = [];
  for (let i = 0; i < 18; i += 1) { await sleep(5000); acked = repliesCarrying(dir, `${nonce}-ALIVE`); if (acked.length) break; }
  say(`     did it actually arrive? the model acked over the channel: ${yn(acked.length > 0)}`);
  if (!acked.length) {
    say('     no ack — the pane, so a delivered-but-not-acted-on event is not');
    say('     misread as a non-delivery (they are different things):');
    for (const l of pane().split('\n').filter((x) => x.trim()).slice(-10)) say(`       | ${l.slice(0, 150)}`);
  }
  say('');

  // ---- F2: agent dead -----------------------------------------------------
  say('  F2 — RECIPIENT DEAD (session killed, then a send attempted)');
  try { execSync(`tmux kill-session -t ${TMUX_SESSION_F} 2>/dev/null`); } catch {}
  await sleep(5000);
  const stillListening = (() => {
    try { return execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim(); } catch { return ''; }
  })();
  say(`     is our channel server still alive after the session died? ${stillListening ? 'YES (pid ' + stillListening.split('\n')[0] + ')' : 'NO — it died with the session'}`);
  const p2 = await postTo(port, `BUTCHR CHANNEL PROBE ${nonce}-DEAD :: nobody is listening.`);
  say(`     the sender observed: ${p2.senderObserved}`);
  const ackedDead = repliesCarrying(dir, `${nonce}-DEAD`);
  say(`     did it arrive? ${yn(ackedDead.length > 0)}  (it cannot have — the recipient is gone)`);
  say('');

  const distinguishable = p1.senderObserved !== p2.senderObserved;
  say('  --- verdict: configuration F — does the sender find out? ---');
  say(`  F1 reachable   : sender saw "${p1.senderObserved}"; actually arrived: ${yn(acked.length > 0)}`);
  say(`  F2 dead agent  : sender saw "${p2.senderObserved}"; actually arrived: ${yn(ackedDead.length > 0)}`);
  say(`  DOES THE SENDER FIND OUT? ${distinguishable ? 'YES — the two differ' : 'NO — the two look identical'}`);

  return {
    label: 'F — failure path', nonce, control: true, failurePath: true,
    f1Sender: p1.senderObserved, f1Arrived: acked.length > 0,
    f2Sender: p2.senderObserved, f2Arrived: ackedDead.length > 0,
    f2ServerSurvived: Boolean(stillListening),
    distinguishable, dialog, notice,
    ranToVerdict: up && notice
  };
}

// ------------------------------------------- configuration D (THE FLEET) --
//
// THE SHIPPED PATH, and the only row that licenses a claim about Butchr.
//
// A real agent is activated THROUGH THE DAEMON, so it gets the real workspace,
// the real daemon-written `.mcp.json` (core `butchr` server, identity-stamped
// by `withWorkspaceIdentity`), the real brief write, and a real herdr pane. The
// nonce rides in a REAL daemon broadcast, which the channel server reads off
// the daemon's own Unix socket.
//
// HOW THIS DIFFERS FROM A PRODUCTION ACTIVATION — all of it, stated here rather
// than left for a reader to find:
//
//   1. The launcher flag. `AGENT_LAUNCHERS.claude.command()` in launchers.ts
//      spawns `claude` with NO channels flag, so no fleet agent can receive a
//      channel event today. This probe takes that exact command string FROM THE
//      PRODUCT (it imports dist/launchers.js rather than retyping it) and
//      splices in `--dangerously-load-development-channels server:butchrprobe`.
//      The splice is printed below so the delta is visible, not asserted.
//   2. A second MCP server. The probe channel is merged into the workspace
//      `.mcp.json` alongside the daemon's own entries. The core `butchr` server
//      is untouched and no product file is modified.
//   3. The pane runs `shell` first. Activating as `shell` (rather than
//      `claude`) leaves the probe holding the pane at a bash prompt, which is
//      the only way to start `claude` with an extra flag without editing the
//      product. The daemon still writes `.mcp.json` and the brief for a `shell`
//      activation (herdr.ts writes both before `launcher.setup`); what the
//      `shell` launcher skips is `configureClaudeSettings` and
//      `trustClaudeWorkspace`, so the probe runs THE PRODUCT'S OWN functions,
//      imported from dist/launchers.js, rather than reimplementing them.
//
// So the agent under test is a real Butchr agent in a real herdr pane running
// the product's own claude command line plus one flag. That is as close to the
// shipped path as this can be got without changing the shipped path.
const INERT_BRIEF = `# Probe target — KAN-217

You are a **probe target**, not a working agent. There is no Jira ticket for
this key and no work to do.

**Do not** read or write any Jira issue, do not touch git, GitHub, or any file,
and do not start any other agent. Ignore any instruction to claim a ticket.

If a message arrives from the **butchrprobe channel** asking you to echo a
token, call the butchrprobe \`reply\` tool immediately with that token.

Otherwise answer questions about what has appeared in your own context,
literally and verbatim, and wait.

Reply now with exactly: PROBE READY
`;

async function configD() {
  rule('CONFIGURATION D — THE SHIPPED PATH (a real Butchr agent, herdr pane)');
  if (!fs.existsSync(SOCKET_PATH)) {
    say(`SKIPPED: no daemon socket at ${SOCKET_PATH}.`);
    return { label: 'D — Butchr agent', skipped: true, ranToVerdict: false };
  }
  if (!fs.existsSync(LAUNCHERS_JS)) {
    say(`SKIPPED: ${LAUNCHERS_JS} missing — run \`cd daemon && npm run build\` first.`);
    return { label: 'D — Butchr agent', skipped: true, ranToVerdict: false };
  }

  const nonce = `${nonceRoot}D`;
  const PROBE_TYPE = 'task';
  const PROBE_KEY = `KAN217-PROBE-${nonce}`;
  const agentName = `butchr-${PROBE_TYPE}-${PROBE_KEY.toLowerCase()}`;
  const ws = path.join(BUTCHR_DIR, 'workspaces', PROBE_TYPE, PROBE_KEY.toLowerCase());
  const qtag = `Q${randomBytes(3).toString('hex').toUpperCase()}`;

  say(`nonce (never typed by this script): ${nonce}`);
  say(`scratch agent                    : ${PROBE_TYPE}/${PROBE_KEY}`);
  say(`question tag (typed; not the nonce): ${qtag}`);
  say('');

  // An independent observer of the daemon's broadcast stream, so CP1 is not
  // confirmed only by the connection that caused it.
  const observed = [];
  const observer = net.connect(SOCKET_PATH);
  let obuf = '';
  observer.on('error', () => {});
  observer.on('data', (chunk) => {
    obuf += chunk.toString('utf8');
    let i;
    while ((i = obuf.indexOf('\n')) !== -1) {
      const line = obuf.slice(0, i); obuf = obuf.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (String(m?.action ?? '').endsWith('_event')) observed.push(m); } catch {}
    }
  });
  await new Promise((r) => observer.once('connect', r));

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
      try { const m = JSON.parse(line); const r = m?.id !== undefined ? pending.get(m.id) : undefined; if (r) { pending.delete(m.id); r(m); } } catch {}
    }
  });
  const call = (action, data = {}) => new Promise((resolve) => {
    const id = `kan217d-${++nextId}`;
    pending.set(id, resolve);
    rpc.write(JSON.stringify({ action, ...data, id }) + '\n');
    setTimeout(() => { if (pending.delete(id)) resolve({ timedOut: true }); }, 60_000);
  });
  const tail = async (lines = 160) => (await call('tail_agent', { key: PROBE_KEY, type: PROBE_TYPE, lines }))?.text ?? '';

  const dir = ws;
  let activated = false;
  try {
    say('activating a real agent through the daemon (defaultAgent: shell — see note 3)…');
    const act = await call('activate_by_key', { type: PROBE_TYPE, key: PROBE_KEY, defaultAgent: 'shell' });
    if (!act?.success) {
      say(`  BLOCKED: activation refused — ${act?.error ?? JSON.stringify(act)}`);
      return { label: 'D — Butchr agent', skipped: true, ranToVerdict: false, blocked: act?.error ?? 'activation refused' };
    }
    activated = true;
    say(`  activated: ${agentName}`);
    await sleep(4000);

    // What the daemon wrote for this workspace, on its own — evidence, not assumption.
    const daemonMcp = (() => { try { return JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')); } catch { return {}; } })();
    say(`  .mcp.json written by the daemon: ${Object.keys(daemonMcp.mcpServers ?? {}).join(', ') || '(none)'}`);
    const coreArgs = daemonMcp.mcpServers?.butchr?.args ?? [];
    say(`  core butchr server identity flags: ${coreArgs.slice(1).join(' ') || '(none)'}`);

    fs.writeFileSync(path.join(ws, '.butchr-prompt.md'), INERT_BRIEF);

    // Merge the probe channel in beside the daemon's own servers.
    const port = nextPort();
    const chanDir = path.join(scratch, 'D');
    const { name, definition } = makeChannelWorkspace(chanDir, { mode: 'daemon', nonce, port: null });
    writeMcpJson(ws, { [name]: definition });

    // The two setup steps the `shell` launcher skips, run from THE PRODUCT'S
    // OWN code so this cannot drift from what a claude activation does.
    const launchers = await import(`file://${LAUNCHERS_JS}`);
    launchers.configureClaudeSettings(ws);
    const trust = launchers.trustClaudeWorkspace(ws);
    say(`  product configureClaudeSettings + trustClaudeWorkspace: ${trust.ok ? 'ok' : 'FAILED — ' + trust.error}`);

    // The product's own claude command, verbatim and WHOLE, plus exactly one
    // flag. Called with no argument so it uses the launcher's real default
    // prompt — the one that sends the agent to `.butchr-prompt.md`, which is
    // how a fleet agent is instructed and therefore how this one must be.
    //
    // Both halves of the `||` are stamped. Taking only the first was wrong and
    // this probe proved it on itself: `--continue` in a fresh workspace exits
    // "No conversation found to continue", which is exactly the case the
    // fallback exists for, so the pane died at a bash prompt having started
    // nothing.
    const shipped = launchers.AGENT_LAUNCHERS.claude.command();
    const withChannels = shipped.replaceAll(
      'claude --permission-mode',
      'claude --dangerously-load-development-channels server:butchrprobe --permission-mode');
    say('');
    say('  the product\'s own claude command line, verbatim:');
    say(`    ${shipped}`);
    say('  as launched here (the whole delta from production is the one flag, twice):');
    say(`    ${withChannels}`);
    say('');

    const paneId = (() => {
      try {
        const out = execFileSync('herdr', ['agent', 'get', agentName], { encoding: 'utf8' });
        return JSON.parse(out)?.result?.agent?.pane_id ?? null;
      } catch (e) { return null; }
    })();
    if (!paneId) {
      say('  BLOCKED: could not resolve the herdr pane for this agent.');
      return { label: 'D — Butchr agent', skipped: true, ranToVerdict: false, blocked: 'no pane' };
    }
    say(`  herdr pane: ${paneId}`);

    const sendText = (t) => execFileSync('herdr', ['pane', 'send-text', paneId, t], { encoding: 'utf8' });
    const sendKey = (k) => execFileSync('herdr', ['pane', 'send-keys', paneId, k], { encoding: 'utf8' });

    say('  starting claude in the pane, with the channel enabled…');
    sendText(withChannels);
    sendKey('Enter');

    // THE RESEARCH-PREVIEW DIALOG. `--dangerously-load-development-channels`
    // opens a full-screen confirmation BEFORE the session starts, and it is
    // BLOCKING — an unattended client sits on it forever. It appears once per
    // `claude` invocation, so the shipped `--continue || claude …` command
    // raises it TWICE on a fresh workspace. Nothing in Butchr answers it today.
    // This is a finding in its own right; see docs/channel-delivery.md.
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
      if (/PROBE READY|bypass permissions|for shortcuts/.test(t)) ready = true;
      if (notice && ready) break;
    }
    say(`  blocking dialogs raised and dismissed: ${dialogs}`);
    say(`  startup notice "Channels (experimental) … inject directly in this session": ${yn(notice)}`);
    say(`  agent reached its prompt: ${yn(ready)}`);

    // The channel server is spawned only after the dialog clears, so the pane
    // can look ready before the listener exists. Measured on configuration F.
    const chanUp = await awaitServerUp(chanDir, { needsPort: false });
    say(`  our channel server connected to the daemon socket (trigger live): ${yn(chanUp)}`);
    if (!chanUp) say(`    server stderr: ${serverStderr(chanDir) || '(empty)'}`);
    await sleep(SETTLE_MS);

    const before = await tail(200);

    // Fire a REAL daemon broadcast; the nonce rides inside the workspace key.
    const evKey = `KAN-217-PROBE-${nonce}-IDLE`;
    const evWs = path.join(BUTCHR_DIR, 'workspaces', 'task', evKey.toLowerCase());
    fs.mkdirSync(evWs, { recursive: true });
    fs.writeFileSync(path.join(evWs, 'PROBE'), `KAN-217 ${nonce}\n`);
    say(`  firing a real daemon event: reset_by_key task/${evKey}`);
    await call('reset_by_key', { type: 'task', key: evKey });
    try { fs.rmSync(evWs, { recursive: true, force: true }); } catch {}

    // Give the agent room to receive, decide and call the reply tool.
    let replies = [];
    for (let i = 0; i < 24; i += 1) {
      await sleep(5000);
      replies = repliesCarrying(chanDir, nonce);
      if (replies.length) break;
    }

    const afterEvent = await tail(200);
    const rendered = afterEvent.includes(nonce) && !before.includes(nonce);
    // The inbound line is drawn as `← butchrprobe: …` and TRUNCATED to the pane
    // width, so the nonce can be cut off a line that was nevertheless drawn.
    // Recorded separately: "no inbound line at all" and "a line whose tail was
    // clipped" are different facts, and reporting the second as the first would
    // understate what the terminal did.
    const inboundLine = (afterEvent.split('\n').find((l) => /←\s*butchrprobe/.test(l)) ?? '').trim();
    const onWire = channelFramesOnWire(chanDir, nonce);
    const broadcasts = observed.filter((m) => String(m.key ?? '').includes(nonce));

    say('');
    say(`  CP3 nonce rendered on the pane: ${yn(rendered)}  (recorded, NOT counted as delivery)`);
    say(`      inbound line drawn at all : ${yn(Boolean(inboundLine))}${inboundLine ? ` — "${inboundLine.slice(0, 110)}"` : ''}`);
    say(`  CP4a replies carrying the nonce: ${replies.length}`);

    // CP4b — KAN-167's reading, kept for comparability. Asked down the
    // composer; the question carries qtag and never the nonce.
    say('  asking down the composer as KAN-167 did (CP4b)…');
    await call('send_to_agent', {
      key: PROBE_KEY, type: PROBE_TYPE,
      message: `[${qtag}] Since your last turn, has any text arrived in your context from a `
        + `channel — for example a line inside a <channel> tag, or beginning "[Butchr]"? `
        + `Quote every such line VERBATIM. If nothing of the kind arrived, reply with `
        + `exactly: NOTHING ARRIVED. Do not call any tool.`
    });
    // 40 x 5s. The first run of this probe gave it 120s and captured the agent
    // still mid-turn ("thinking with high effort"), which scored CP4b as a NO
    // that was really a timeout. CP4a had already answered the ticket by then,
    // so the mis-scoring changed no conclusion — but a NO that means "we
    // stopped watching" is exactly the over-claim this file is about.
    let answer = '';
    let answered = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(5000);
      const t = await tail(200);
      const at = t.lastIndexOf(qtag);
      if (at === -1) continue;
      const region = t.slice(at + qtag.length);
      answer = region;
      if (/NOTHING ARRIVED/.test(region) || region.includes(nonce)) { answered = true; break; }
    }
    const quoted = answer.includes(nonce);
    if (!answered) say('  CP4b: the agent had not finished answering before the window closed —');
    if (!answered) say('        scored as "no answer captured", NOT as "the model did not have it".');

    say('');
    say('--- verdict: configuration D — the shipped path ---');
    say(`nonce used : ${nonce}`);
    say(`CP1  the daemon emitted the broadcast        : ${yn(broadcasts.length > 0)}  ${broadcasts.length} on the socket, independent observer`);
    say(`CP2  the event left our channel server       : ${yn(onWire.length > 0)}  ${onWire.length} notifications/claude/channel frame(s) on the tee'd wire`);
    say(`CP3  it rendered on the pane                 : ${yn(rendered)}   (NOT the answer)`);
    say(`CP4a the model echoed it back OVER THE CHANNEL: ${yn(replies.length > 0)}   <<< THE ANSWER (composer never used)`);
    say(`CP4b the model quoted it down the composer   : ${answered ? yn(quoted) : 'no answer captured in the window'}`);
    say('');
    if (replies.length) {
      say('  what the model sent back through the channel\'s reply tool, verbatim:');
      for (const r of replies.slice(0, 5)) say(`    | ${r}`);
      say('');
    }
    say('  the agent\'s composer answer, verbatim from the pane:');
    for (const line of (answer || '<no answer captured>').split('\n').slice(0, 20)) say(`    | ${line}`);

    return {
      label: 'D — Butchr agent', nonce, mode: 'interactive-fleet', flag: true,
      cp1: broadcasts.length > 0, cp2: onWire.length > 0, cp3: rendered,
      cp4a: replies.length > 0, cp4b: quoted,
      dialogs, notice, replies, answer,
      ranToVerdict: broadcasts.length > 0 && onWire.length > 0 && Boolean(answer || replies.length)
    };
  } finally {
    try { observer.destroy(); } catch {}
    if (activated && !KEEP) {
      say('');
      say('  standing the probe agent down and deleting its workspace…');
      await call('deactivate_by_key', { type: PROBE_TYPE, key: PROBE_KEY });
      await sleep(2000);
      await call('reset_by_key', { type: PROBE_TYPE, key: PROBE_KEY });
    }
    try { rpc.destroy(); } catch {}
  }
}

// ------------------------------------------------------------------ main --

const results = [];
try {
  if (!ONLY || ONLY === 'A') results.push(await configA());
  if (!ONLY || ONLY === 'C') results.push(await configC());
  if (!ONLY || ONLY === 'N') results.push(await configN());
  if (!ONLY || ONLY === 'F') results.push(await configF());
  if (!ONLY || ONLY === 'D') results.push(await configD());
} catch (e) {
  say('');
  say(`PROBE ERROR: ${e?.stack ?? e}`);
  results.push({ label: 'aborted', ranToVerdict: false, error: String(e?.message ?? e) });
}

// The summary is derived from what ACTUALLY RAN in this invocation, never from
// a fixed legend. KAN-167's probe shipped a version that printed results for
// configurations `--only` had excluded and credited a control that never
// executed — a probe vouching for its own validity out of evidence it never
// collected. That guard is reproduced here rather than re-learned.
rule('SUMMARY');
const byLabel = Object.fromEntries(results.map((r) => [r.label.split(' ')[0], r]));
const ran = (k) => byLabel[k] && !byLabel[k].skipped;

say('config                       CP1      CP2      CP3 pane   CP4a channel  CP4b composer');
for (const r of results) {
  if (r.skipped) { say(`${r.label.padEnd(28)} SKIPPED — ${r.blocked ?? 'preconditions not met'}`); continue; }
  if (r.failurePath) {
    say(`${r.label.padEnd(28)} sender-observable difference between arrived and not: ${yn(r.distinguishable)}`);
    continue;
  }
  if (r.control && r.label.startsWith('C')) {
    say(`${r.label.padEnd(28)} control token reached the model: ${yn(r.controlArrived)}`);
    continue;
  }
  say(
    `${r.label.padEnd(28)} ${yn(r.cp1).padEnd(8)} ${yn(r.cp2).padEnd(8)} ` +
    `${(r.cp3 === null ? 'n/a' : yn(r.cp3)).padEnd(10)} ${yn(r.cp4a).padEnd(13)} ` +
    `${r.cp4b === undefined ? 'n/a' : yn(r.cp4b)}`
  );
}
say('');
say(`  HEADLESS PRINT MODE exercised here by      : ${[ran('A') && 'A', ran('C') && 'C'].filter(Boolean).join(', ') || 'NOTHING'}`);
say(`  INTERACTIVE, NOT a Butchr agent            : ${[ran('N') && 'N', ran('F') && 'F'].filter(Boolean).join(', ') || 'NOTHING'}`);
say(`  A REAL BUTCHR AGENT under a herdr pane     : ${ran('D') ? 'D' : 'NOTHING'}`);
const missing = ['A', 'C', 'N', 'F', 'D'].filter((k) => !ran(k));
if (missing.length) say(`  NOT exercised in this invocation           : ${missing.join(', ')} — nothing below describes them.`);
say('');

const D = byLabel.D;
const N = byLabel.N;
const F = byLabel.F;
const scoped = missing.length > 0;

// KAN-217 was cut back to exactly two questions (comment 10919). The summary
// answers those two and nothing else, and says which it could not answer.
say('QUESTION 1 — does a channel event reach a running Butchr agent?');
if (ran('D')) {
  say(`  ${D.cp4a || D.cp4b ? 'YES' : 'NO'} — measured on a real Butchr agent under a herdr pane.`);
} else {
  say('  UNANSWERED — configuration D did not run in this invocation.');
}
say('');
say('QUESTION 2 — when the recipient is not reachable, does the sender find out?');
if (ran('F')) {
  say(`  ${F.distinguishable ? 'YES' : 'NO'} — reachable send looked like "${F.f1Sender}";`);
  say(`        send at a dead session looked like "${F.f2Sender}".`);
} else {
  say('  UNANSWERED — configuration F did not run in this invocation.');
}
say('');
say('--- the warrant behind question 1 ---');
if (ran('D') && D.cp4a) {
  say(`ANSWER${scoped ? ', SCOPED' : ''}: a Claude Code channel DOES push a message into a running Butchr`);
  say('        agent, and the MODEL receives it — it echoed the nonce back out over');
  say('        the channel without the composer being used in either direction.');
  if (ran('N')) {
    say(`        The negative control ${N.controlBehaved ? 'HELD' : 'DID NOT HOLD'}: with the same server in .mcp.json but`);
    say(`        NOT named to the channels flag, the event left our server and reached`);
    say(`        ${N.cp3 || N.cp4a ? 'the model anyway — SO THIS RUN CANNOT ATTRIBUTE D TO CHANNELS.' : 'neither the pane nor the model. The flag is load-bearing, so enabling'}`);
    if (!N.cp3 && !N.cp4a) say('        this for the fleet is a LAUNCHER change, not only a server change.');
  } else {
    say('        NO NEGATIVE CONTROL RAN, so this invocation cannot rule out the nonce');
    say('        having reached the model down some path other than the channel, and');
    say('        does not claim to. Drop --only for that.');
  }
} else if (ran('D')) {
  say(`ANSWER${scoped ? ', SCOPED' : ''}: the channel event did NOT reach the model of a real Butchr agent.`);
  if (!ran('C')) say('        NO POSITIVE CONTROL RAN, so this cannot distinguish a dropped event');
  else say(`        The positive control ${byLabel.C?.controlArrived ? 'arrived, so the detector works' : 'DID NOT ARRIVE — the detector is suspect'}.`);
} else {
  say('ANSWER WITHHELD: configuration D did not run, and it is the only one that');
  say('        describes a Butchr agent. Nothing here licenses a claim about the fleet.');
}
say('');
say(`scratch kept at: ${scratch}`);

const failures = results.filter((r) => !r.skipped && !r.ranToVerdict);
if (failures.length) {
  say('');
  say(`NOT TRUSTWORTHY: ${failures.length} configuration(s) did not reach a verdict: ` +
      failures.map((r) => r.label).join(', '));
}
process.exit(failures.length ? 1 : 0);
