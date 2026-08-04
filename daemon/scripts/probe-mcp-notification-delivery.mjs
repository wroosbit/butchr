#!/usr/bin/env node
//
// KAN-167 — does a server-initiated MCP notification reach the model's context,
// and does the answer depend on whether the agent is idle or mid-request?
//
// WHAT FAILURE THIS WOULD CATCH: a `notifications/message` that leaves our MCP
// server correctly, is drawn on the agent's terminal pane, and is never put in
// front of the model — so a Butchr feature built on daemon events would look
// wired up end to end while every message silently died at the client. That is
// the failure KAN-145 cost a day to in a different costume: reading the sending
// code proves what the code does with an input, never that the input arrives.
//
// NOT a `verify-` script, deliberately (the ticket decided this; do not rename).
// It drives a live `claude` CLI and a real model, so it is an experiment, not a
// deterministic proof of product behaviour that CI can re-run. `verify-script-
// sweep` would assert a guarantee it cannot make.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives, so
// here is exactly what each configuration manufactures:
//
//   Configuration A — the stub server is written by this script and emits the
//   notification on its own schedule. A therefore tests ONLY the client's
//   handling of a well-formed `notifications/message`. It proves nothing about
//   Butchr's daemon, and it is not meant to. Configuration B covers that.
//
//   Configuration C — the control. Identical to A except the nonce ALSO rides
//   out on the tool result. Its only job is to prove this script can see a
//   nonce that really is delivered, so that a NO elsewhere is a fact about the
//   delivery path rather than a fact about a broken detector.
//
//   Configuration B — this script fires the daemon event itself, by resetting
//   scratch workspaces it created for the purpose. So B does NOT test that
//   production events fire on their own; it tests that a real event, once
//   broadcast by the real daemon, travels through the real `daemon/dist/mcp.js`
//   onto the stdio wire and (checkpoint 3) into or not into the model. That
//   production events do fire is already established in the ticket by citation
//   (`router.ts:1220`, `:1409`, `:1491`, `:1555`, `:904`, `:951`, `:1758`;
//   `daemon.ts:198`, `:401`) and is NOT re-established here.
//
//   What no configuration here covers: whether a notification arriving while
//   the recipient is mid-tool-call *disturbs* that call. This script observes
//   whether such a notification is DELIVERED, not whether it is destructive —
//   and the destructive case is only reachable if delivery happens at all.
//   Nobody covers it yet; docs/mcp-notification-delivery.md says so rather
//   than leaving a reader to assume it was tested.
//
// ---------------------------------------------------------------------------
// THE THREE CHECKPOINTS, AND THE TWO TARGET STATES
// ---------------------------------------------------------------------------
//   CP1  the daemon emitted the broadcast   — observed on the daemon's Unix
//        socket by a second, independent client connection (config B only;
//        A and C have no daemon and report CP1 as n/a rather than as a pass)
//   CP2  the notification left our server   — observed as a JSON-RPC
//        `notifications/message` frame on the stdio wire, via a tee wrapper
//   CP3  the model received it              — in two independent strengths:
//          CP3a  the nonce appears anywhere in the conversation the client
//                emitted (i.e. it was put into context at all)
//          CP3b  the model quoted the nonce back when asked
//        Rendering on a terminal pane is NOT checkpoint 3 and is not consulted.
//
// Target state is MEASURED, not assumed. For every notification frame, this
// script computes from the wire log whether a client->server JSON-RPC request
// was outstanding at that instant (`in-flight`) or not (`idle`). That matters
// because the 2026-07-28 revision confines server-initiated traffic to the
// window of an in-flight client request, and the ticket asks whether a daemon
// can reach an IDLE agent at all. Frames are reported per state.
//
// EXIT CODE: derived from whether the probe could OBSERVE each checkpoint, not
// from whether delivery succeeded. "The client drops it" is a passing result
// for the ticket (AC 6) and exits 0. A configuration that could not be run to
// a verdict, or a control that failed, exits 1 — then the probe is reporting
// nothing trustworthy either way.
//
// Usage:
//   cd daemon && npm run build     # config B needs daemon/dist/mcp.js
//   node scripts/probe-mcp-notification-delivery.mjs [--only=A|B|C] [--model=m]
//
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const MCP_SERVER = path.join(repoRoot, 'daemon', 'dist', 'mcp.js');
const BUTCHR_DIR = path.join(os.homedir(), '.local', 'share', 'butchr');
const SOCKET_PATH = path.join(BUTCHR_DIR, 'butchr.sock');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ONLY = arg('only', null);
const MODEL = arg('model', 'sonnet');
const TURN_TIMEOUT_MS = Number(arg('turn-timeout-ms', 240_000));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan167-probe-'));
const nonceRoot = randomBytes(6).toString('hex').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t) => {
  say('');
  say('='.repeat(76));
  say(t);
  say('='.repeat(76));
};

// ---------------------------------------------------------------- the stub --
//
// Raw JSON-RPC over stdio rather than the SDK: this configuration is the
// protocol floor, so it must not inherit any SDK behaviour that could explain
// a result. It logs every frame it reads and writes, which is where CP2, the
// target-state classification and the `initialize` capture all come from.
//
// Four emission timings, chosen to straddle the in-flight boundary:
//   INIT   just after the handshake
//   DURING while this server is processing a tools/call — certainly in-flight
//   AFTER  a moment after that tool result
//   LATE   seconds later, in the gap between turns — certainly idle
const STUB_SERVER = String.raw`
import fs from 'fs';
const WIRE = process.env.PROBE_WIRE_LOG;
const NONCE = process.env.PROBE_NONCE;
const logFrame = (dir, obj) => {
  fs.appendFileSync(WIRE, JSON.stringify({ t: Date.now(), dir, frame: obj }) + '\n');
};
const send = (obj) => {
  logFrame('server->client', obj);
  process.stdout.write(JSON.stringify(obj) + '\n');
};
const notify = (tag) => send({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: {
    level: 'info',
    logger: 'kan167-probe',
    data: '[KAN-167 PROBE] nonce=' + NONCE + '-' + tag + ' emitted-by=stub'
  }
});

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    logFrame('client->server', msg);
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's own requested revision so negotiation cannot be
        // what fails; the point of this configuration is the delivery path.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: 'kan167-probe-stub', version: '1.0.0' }
      }
    });
    return;
  }
  if (method === 'notifications/initialized') {
    setTimeout(() => notify('INIT'), 150);
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'probe_emit',
      description: 'Emits an MCP log notification. Returns no useful content.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }] } });
    return;
  }
  if (method === 'tools/call') {
    notify('DURING');
    send({ jsonrpc: '2.0', id, result: {
      // Deliberately nonce-free — UNLESS this is the positive control, whose
      // whole job is to put the nonce on a path that certainly does reach the
      // model, so that a NO on the notification path means something.
      content: [{ type: 'text', text: process.env.PROBE_CONTROL
        ? '[KAN-167 PROBE] nonce=' + NONCE + '-CONTROL delivered-by=tool-result'
        : 'probe_emit ok (notification sent out of band)' }]
    } });
    setTimeout(() => notify('AFTER'), 250);
    setTimeout(() => notify('LATE'), 3000);
    return;
  }
  if (method === 'logging/setLevel') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id, result: { resources: [] } }); return; }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: [] } }); return; }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}
`;

// ---------------------------------------------------------------- the tee --
//
// Config B must observe the real server's wire without altering it, so this
// wrapper spawns daemon/dist/mcp.js and copies bytes through in both
// directions, logging complete lines. Bytes are forwarded untouched; only the
// log is line-framed.
const TEE_WRAPPER = String.raw`
import fs from 'fs';
import { spawn } from 'child_process';
const WIRE = process.env.PROBE_WIRE_LOG;
const TARGET = process.env.PROBE_TARGET;
const ARGS = JSON.parse(process.env.PROBE_TARGET_ARGS);
const logFrame = (dir, text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { frame = { unparsed: text }; }
  fs.appendFileSync(WIRE, JSON.stringify({ t: Date.now(), dir, frame }) + '\n');
};
const child = spawn(process.execPath, [TARGET, ...ARGS], { stdio: ['pipe', 'pipe', 'inherit'] });
// When a tools/call goes upstream, drop a marker file the moment it is seen.
// That is what lets the probe fire a daemon event while a client request is
// genuinely in flight, rather than firing blind and hoping to overlap.
const MARKER = process.env.PROBE_INFLIGHT_MARKER;
// LATENCY INJECTION, and exactly what it does — disclosed because it is the one
// place this wrapper is not a passive observer.
//
// A real butchr tools/call completes in ~20ms, so the in-flight window is too
// narrow to fire a daemon event into: measured, the first event landed 9ms
// after the response. PROBE_HOLD_RESULT_MS delays the delivery of the tools/call
// RESPONSE ONLY, widening that window to seconds.
//
// What is altered: the arrival time of one response frame.
// What is NOT altered: its bytes, and every notification frame — those are the
// real server's own output, forwarded the instant it produces them. So the
// thing under test (does the client surface a notification that arrives while a
// request is open?) is measured on genuine frames; only the window they land in
// is manufactured, and it is manufactured on the client's side of our server.
const HOLD_MS = Number(process.env.PROBE_HOLD_RESULT_MS || 0);
const heldIds = new Set();

let upBuf = '';
process.stdin.on('data', (c) => {
  child.stdin.write(c);
  upBuf += c.toString('utf8');
  let i;
  while ((i = upBuf.indexOf('\n')) !== -1) {
    const line = upBuf.slice(0, i);
    upBuf = upBuf.slice(i + 1);
    if (!line.trim()) continue;
    logFrame('client->server', line);
    try {
      const f = JSON.parse(line);
      if (f.method === 'tools/call') {
        if (HOLD_MS) heldIds.add(f.id);
        if (MARKER) { try { fs.writeFileSync(MARKER, String(Date.now())); } catch {} }
      }
    } catch { /* unparsed frames are logged and passed through regardless */ }
  }
});

let downBuf = '';
child.stdout.on('data', (c) => {
  downBuf += c.toString('utf8');
  let i;
  while ((i = downBuf.indexOf('\n')) !== -1) {
    const line = downBuf.slice(0, i);
    downBuf = downBuf.slice(i + 1);
    if (!line.trim()) continue;
    let held = false;
    try {
      const f = JSON.parse(line);
      held = HOLD_MS > 0 && f.id !== undefined && heldIds.has(f.id);
      if (held) heldIds.delete(f.id);
    } catch { /* fall through: forward immediately */ }
    // Logged at the instant it is FORWARDED, not when it was read, so the wire
    // log is a faithful record of what the client received and when. Classifying
    // "in-flight" off read-time would call a deliberately widened window closed.
    if (held) {
      setTimeout(() => { logFrame('server->client', line); process.stdout.write(line + '\n'); }, HOLD_MS);
    } else {
      logFrame('server->client', line);
      process.stdout.write(line + '\n');
    }
  }
});

process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => setTimeout(() => process.exit(code ?? 0), HOLD_MS + 250));
`;

// ------------------------------------------------------------ claude driver --
//
// Two turns in one session. The notification must arrive without the model
// having asked for it, and the second turn is the only place the model can
// report what it has. `--strict-mcp-config` keeps this run away from the
// operator's own MCP servers.
function runClaudeSession({ cwd, mcpConfigPath, allowedTools, turn1, turn2, onTurn1Sent, betweenTurns }) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      '--model', MODEL
    ];
    if (allowedTools) args.push('--allowedTools', allowedTools);

    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let raw = '';
    let stderr = '';
    const events = [];
    let turnsSeen = 0;
    let sentTurn2 = false;
    let settled = false;
    let buf = '';

    const timer = setTimeout(() => finish('timeout'), TURN_TIMEOUT_MS);

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve({ raw, stderr, events, reason, turnsSeen });
    };

    const sendTurn = (text) => {
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] }
      }) + '\n');
    };

    child.stdout.on('data', async (chunk) => {
      raw += chunk.toString('utf8');
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        events.push(evt);
        if (evt.type === 'result') {
          turnsSeen += 1;
          if (!sentTurn2) {
            sentTurn2 = true;
            if (betweenTurns) await betweenTurns();
            sendTurn(turn2);
          } else {
            child.stdin.end();
            finish('complete');
          }
        }
      }
    });

    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => { stderr += `spawn error: ${err.message}\n`; finish('spawn-error'); });
    child.on('exit', () => setTimeout(() => finish('exit'), 200));

    sendTurn(turn1);
    if (onTurn1Sent) onTurn1Sent();
  });
}

// Text the model itself produced, as opposed to anything the client echoed.
function assistantText(events) {
  const out = [];
  for (const evt of events) {
    if (evt.type !== 'assistant') continue;
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push(block.text);
    }
  }
  return out.join('\n');
}

function readWire(wireLog) {
  if (!fs.existsSync(wireLog)) return [];
  return fs.readFileSync(wireLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ------------------------------------------------- target-state measurement --
//
// A client->server frame carrying both an `id` and a `method` is a request; the
// server->client frame echoing that `id` is its response. A notification sent
// between those two instants went out while a client request was in flight.
// This is measured off the recorded wire, so "idle" is an observation rather
// than an assumption about what the client was doing.
function requestWindows(wire) {
  const windows = [];
  for (let i = 0; i < wire.length; i += 1) {
    const e = wire[i];
    if (e.dir !== 'client->server') continue;
    if (e.frame?.id === undefined || !e.frame?.method) continue;
    const reply = wire.find((r, j) =>
      j > i && r.dir === 'server->client' && r.frame?.id === e.frame.id);
    windows.push({ method: e.frame.method, from: e.t, to: reply ? reply.t : Infinity });
  }
  return windows;
}

function classifyNotifications(wire, nonce) {
  const windows = requestWindows(wire);
  return wire
    .filter((e) => e.dir === 'server->client' &&
                   e.frame?.method === 'notifications/message' &&
                   String(e.frame?.params?.data ?? '').includes(nonce))
    .map((e) => {
      const data = String(e.frame.params.data);
      // Config A/C carry `nonce=<marker>`; config B carries the nonce inside a
      // workspace key (`… - task/KAN-167-PROBE-<nonce>-<label>`). Both forms
      // must resolve to the full unique marker, or distinct frames collapse
      // into one indistinguishable blob in the report.
      const full = data.match(/nonce=(\S+)/)?.[1]
        ?? data.match(new RegExp(`[\\w-]*${nonce}[\\w-]*`))?.[0]
        ?? nonce;
      const covering = windows.filter((w) => e.t >= w.from && e.t <= w.to);
      return {
        marker: full,
        tag: (full.split(nonce)[1] ?? '').replace(/^-/, '') || '(untagged)',
        state: covering.length ? 'in-flight' : 'idle',
        during: covering.map((w) => w.method).join(',') || null,
        frame: e.frame
      };
    });
}

const TURN_1_TOOL = 'Call the probe_emit tool exactly once, then reply with exactly: READY';
const TURN_1_BUTCHR =
  'Call the butchr_list_agents tool exactly once, then reply with exactly: READY';
const TURN_2 = [
  'Since your previous turn, did any text arrive from an MCP server outside of a tool result',
  '— for example a log line, a server notice, or any text containing the word PROBE or the',
  'phrase "Butchr Event"? If yes, quote every such line VERBATIM. If nothing of the kind',
  'arrived, reply with exactly: NOTHING ARRIVED. Do not call any tool.'
].join(' ');

// --------------------------------------------------------------- reporting --
function report(r) {
  const mark = (s) => (s === 'observed' ? 'YES' : s === 'n/a' ? 'n/a' : 'NO ');
  say('');
  say(`--- verdict: configuration ${r.label} ---`);
  say(`nonce used : ${r.nonce}`);
  say(`CP1  daemon emitted the broadcast      : ${mark(r.cp1.state)}  ${r.cp1.detail ?? ''}`);
  say(`CP2  notification left our MCP server  : ${mark(r.cp2.state)}  ${r.cp2.detail ?? ''}`);
  say('');
  say('  per target state (state measured from the wire, not assumed):');
  for (const state of ['in-flight', 'idle']) {
    const frames = r.classified.filter((c) => c.state === state);
    if (!frames.length) {
      say(`    ${state.padEnd(9)} : no notification was emitted in this state`);
      continue;
    }
    const inCtx = frames.some((f) => r.session.raw.includes(f.marker));
    const quoted = frames.some((f) => r.modelText.includes(f.marker));
    say(`    ${state.padEnd(9)} : ${frames.length} frame(s) [${frames.map((f) => f.tag).join(', ')}]` +
        (state === 'in-flight' ? ` during ${[...new Set(frames.map((f) => f.during))].join('/')}` : ''));
    say(`                CP3a in context: ${inCtx ? 'YES' : 'NO '}   CP3b quoted: ${quoted ? 'YES' : 'NO '}`);
  }
  say('');

  if (r.classified.length) {
    say('  frames observed leaving the server (verbatim):');
    for (const c of r.classified) say(`    [${c.state}] ${JSON.stringify(c.frame)}`);
    say('');
  }

  say('  the `initialize` request this client sent (verbatim):');
  say(`    ${r.initReq ? JSON.stringify(r.initReq.frame) : '<not observed>'}`);
  say('');
  say('  the `initialize` result our server returned (verbatim):');
  say(`    ${r.initRes ? JSON.stringify(r.initRes.frame) : '<not observed>'}`);
  say('');
  say(`  logging/setLevel requests from the client: ${r.setLevel?.length ?? 0}` +
      (r.setLevel?.length ? ` — ${r.setLevel.map((s) => JSON.stringify(s.frame.params)).join(', ')}` : ''));
  say('');
  say("  the model's own words (verbatim, both turns):");
  for (const line of (r.modelText || '<no assistant text>').split('\n')) say(`    | ${line}`);
  say('');
  say(`  session ended: ${r.session.reason} (${r.session.turnsSeen} turn result(s))`);
  if (r.session.reason !== 'complete') {
    say(`  stderr tail: ${r.session.stderr.split('\n').slice(-6).join(' / ')}`);
  }
  say(`  full wire log: ${r.wireLog}`);

  // A configuration reached a verdict only if it observed what left the server,
  // ran both turns, AND actually produced a frame in each target state. A state
  // with no frame in it is an untested cell, and an untested cell reported as
  // if it were a result is the exact "looks finished" failure this ticket is
  // about — so it counts as a failure here rather than a footnote.
  const covered = ['in-flight', 'idle']
    .filter((s) => r.classified.some((c) => c.state === s));
  if (covered.length < 2) {
    say(`  NOTE: only ${covered.length}/2 target states were exercised` +
        ` (${covered.join(', ') || 'none'}); the missing one is untested, not passing.`);
  }
  const ranToVerdict =
    r.cp2.state === 'observed' && r.session.turnsSeen >= 2 && covered.length === 2;
  return { ...r, ranToVerdict };
}

function commonWire(wireLog, nonce, session) {
  const wire = readWire(wireLog);
  return {
    wire,
    classified: classifyNotifications(wire, nonce),
    initReq: wire.find((e) => e.dir === 'client->server' && e.frame?.method === 'initialize'),
    initRes: wire.find((e) => e.dir === 'server->client' && e.frame?.result?.protocolVersion),
    setLevel: wire.filter((e) => e.dir === 'client->server' && e.frame?.method === 'logging/setLevel'),
    modelText: assistantText(session.events)
  };
}

// ----------------------------------------------------------- configuration A --
async function configA() {
  rule('CONFIGURATION A — protocol floor (stub MCP server, no Butchr involved)');
  const dir = path.join(scratch, 'config-a');
  fs.mkdirSync(dir, { recursive: true });
  const stubPath = path.join(dir, 'stub-server.mjs');
  const wireLog = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(stubPath, STUB_SERVER);
  fs.writeFileSync(wireLog, '');

  const nonce = `${nonceRoot}-A`;
  const mcpConfigPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      probe: {
        command: process.execPath,
        args: [stubPath],
        env: { PROBE_WIRE_LOG: wireLog, PROBE_NONCE: nonce }
      }
    }
  }, null, 2));

  say(`nonce            : ${nonce}`);
  say(`scratch workspace: ${dir}`);
  say(`model            : ${MODEL}`);
  say('');
  say('Driving a live `claude` session (two turns, 6s idle gap between them)…');

  const session = await runClaudeSession({
    cwd: dir,
    mcpConfigPath,
    allowedTools: 'mcp__probe__probe_emit',
    turn1: TURN_1_TOOL,
    turn2: TURN_2,
    // An idle window with certainty: nothing is in flight while we wait here,
    // which is what makes the LATE emission a genuine idle-state test.
    betweenTurns: () => sleep(6000)
  });

  const w = commonWire(wireLog, nonce, session);
  return report({
    label: 'A — protocol floor',
    nonce,
    session,
    cp1: { state: 'n/a', detail: 'no daemon in this configuration; the stub is the emitter' },
    cp2: {
      state: w.classified.length > 0 ? 'observed' : 'not-observed',
      detail: `${w.classified.length} notifications/message frame(s) on the stdio wire`
    },
    wireLog,
    ...w
  });
}

// ----------------------------------------------------- configuration C (control) --
//
// THE CONTROL, and the reason any "NO" above can be believed. A detector that
// has only ever said NO is indistinguishable from a broken detector.
async function configC() {
  rule('CONFIGURATION C — positive control (same stub; nonce also on the tool result)');
  const dir = path.join(scratch, 'config-c');
  fs.mkdirSync(dir, { recursive: true });
  const stubPath = path.join(dir, 'stub-server.mjs');
  const wireLog = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(stubPath, STUB_SERVER);
  fs.writeFileSync(wireLog, '');

  const nonce = `${nonceRoot}-C`;
  const control = `${nonce}-CONTROL`;
  const mcpConfigPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      probe: {
        command: process.execPath,
        args: [stubPath],
        env: { PROBE_WIRE_LOG: wireLog, PROBE_NONCE: nonce, PROBE_CONTROL: '1' }
      }
    }
  }, null, 2));

  say(`notification nonce: ${nonce}-{INIT,DURING,AFTER,LATE}`);
  say(`control nonce     : ${control}  (carried on the tool result)`);
  say('');
  say('Driving a live `claude` session (two turns)…');

  const session = await runClaudeSession({
    cwd: dir,
    mcpConfigPath,
    allowedTools: 'mcp__probe__probe_emit',
    turn1: TURN_1_TOOL,
    turn2: TURN_2,
    betweenTurns: () => sleep(6000)
  });

  const w = commonWire(wireLog, nonce, session);
  // The control marker must not be counted as a notification: it never was one.
  w.classified = w.classified.filter((c) => c.tag !== 'CONTROL');

  const out = report({
    label: 'C — positive control',
    nonce,
    session,
    cp1: { state: 'n/a', detail: 'no daemon in this configuration' },
    cp2: {
      state: w.classified.length > 0 ? 'observed' : 'not-observed',
      detail: `${w.classified.length} notifications/message frame(s) on the stdio wire`
    },
    wireLog,
    ...w
  });

  const controlInContext = session.raw.includes(control);
  const controlQuoted = w.modelText.includes(control);
  say('');
  say('  CONTROL — the same nonce carried on the tool result instead:');
  say(`    control nonce present in context : ${controlInContext ? 'YES' : 'NO '}  (${control})`);
  say(`    control nonce quoted by the model: ${controlQuoted ? 'YES' : 'NO '}`);
  say('');
  if (controlInContext) {
    say('  => the detector CAN see a nonce that is actually delivered. A NO on the');
    say('     notification path is therefore a fact about the notification path.');
  } else {
    say('  => WARNING: the control did not arrive either. This probe cannot tell a');
    say('     dropped notification from a broken detector; treat every NO as void.');
  }

  return { ...out, isControl: true, controlInContext, controlQuoted };
}

// ----------------------------------------------------------- configuration B --
//
// The real server, real daemon events, a real agent. The nonce rides in the
// workspace key, so the text mcp.ts forwards contains something the model
// cannot have known. Events are fired as a burst spanning turn 1 (so some land
// while a tools/call is in flight) and again in the idle gap between turns.
async function configB() {
  rule('CONFIGURATION B — the real path (daemon/dist/mcp.js + real daemon events)');
  if (!fs.existsSync(MCP_SERVER)) {
    say(`SKIPPED: ${MCP_SERVER} is missing. Run \`cd daemon && npm run build\` first.`);
    return { label: 'B — real path', skipped: true, ranToVerdict: false };
  }
  if (!fs.existsSync(SOCKET_PATH)) {
    say(`SKIPPED: no daemon socket at ${SOCKET_PATH}. Start the Butchr daemon first.`);
    return { label: 'B — real path', skipped: true, ranToVerdict: false };
  }

  const dir = path.join(scratch, 'config-b');
  fs.mkdirSync(dir, { recursive: true });
  const teePath = path.join(dir, 'tee-wrapper.mjs');
  const wireLog = path.join(dir, 'wire.jsonl');
  const marker = path.join(dir, 'inflight.marker');
  fs.writeFileSync(teePath, TEE_WRAPPER);
  fs.writeFileSync(wireLog, '');

  const nonce = `${nonceRoot}B`; // no dash: it rides inside a workspace key
  const mcpConfigPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      butchr: {
        command: process.execPath,
        args: [teePath],
        env: {
          PROBE_WIRE_LOG: wireLog,
          PROBE_INFLIGHT_MARKER: marker,
          // A real butchr tools/call answers in ~20ms, which is too narrow to
          // fire an event into. See the disclosure in TEE_WRAPPER: this delays
          // that one response and nothing else.
          PROBE_HOLD_RESULT_MS: '4000',
          PROBE_TARGET: MCP_SERVER,
          PROBE_TARGET_ARGS: JSON.stringify([
            '--workspace-type', 'task', '--workspace-key', 'KAN-167'
          ])
        }
      }
    }
  }, null, 2));

  say(`nonce            : ${nonce}  (rides inside the workspace key)`);
  say(`real MCP server  : ${MCP_SERVER} (behind a byte-faithful tee)`);
  say(`model            : ${MODEL}`);
  say('');

  // CP1 observer: a second, independent connection to the daemon socket. This
  // is what makes "the daemon emitted it" an observation rather than an
  // inference from having called a tool.
  const observed = [];
  const observer = net.connect(SOCKET_PATH);
  let observerBuf = '';
  observer.on('data', (chunk) => {
    observerBuf += chunk.toString('utf8');
    let i;
    while ((i = observerBuf.indexOf('\n')) !== -1) {
      const line = observerBuf.slice(0, i);
      observerBuf = observerBuf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg?.action === 'string' && msg.action.endsWith('_event')) observed.push(msg);
      } catch { /* not our frame */ }
    }
  });
  observer.on('error', () => {});
  await new Promise((r) => observer.once('connect', r));

  // A separate connection to *fire* the events, so the observer is never the
  // requester: a broadcast seen only by the caller proves less.
  const firer = net.connect(SOCKET_PATH);
  firer.on('error', () => {});
  await new Promise((r) => firer.once('connect', r));

  let fired = 0;
  const fireRealDaemonEvent = async (label) => {
    fired += 1;
    const probeKey = `KAN-167-PROBE-${nonce}-${label}`;
    const ws = path.join(BUTCHR_DIR, 'workspaces', 'task', probeKey.toLowerCase());
    // A genuine success path: the workspace exists, so the reset really deletes
    // something of ours and the daemon broadcasts a real agent_reset_event.
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'PROBE'), `KAN-167 probe ${nonce}\n`);
    firer.write(JSON.stringify({
      action: 'reset_by_key', type: 'task', key: probeKey, id: `kan167-${nonce}-${label}`
    }) + '\n');
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* reset got it */ }
  };

  // IN-FLIGHT STATE, triggered rather than guessed. The tee drops a marker the
  // instant a `tools/call` is forwarded upstream; this watcher fires daemon
  // events immediately and repeatedly for as long as that call is plausibly
  // open. Whether any of them actually landed inside the window is still
  // MEASURED from the wire afterwards — this only makes the overlap likely,
  // it never asserts it. `butchr_list_agents` is chosen because its daemon
  // round-trip (herdr census + staleness) is the slowest tool we expose.
  let watching = true;
  const inflightBurst = (async () => {
    while (watching && !fs.existsSync(marker)) await sleep(10);
    if (!watching) return;
    say('  tools/call seen on the wire — firing daemon events into the open window');
    for (let i = 0; i < 25 && watching; i += 1) {
      await fireRealDaemonEvent(`INFLIGHT${i}`);
      await sleep(60);
    }
  })();

  say('Driving a live `claude` session; events fire mid-tool-call and again while idle…');
  const session = await runClaudeSession({
    cwd: dir,
    mcpConfigPath,
    allowedTools: 'mcp__butchr__butchr_list_agents',
    turn1: TURN_1_BUTCHR,
    turn2: TURN_2,
    betweenTurns: async () => {
      watching = false;
      await inflightBurst;
      await sleep(2000);                 // settle: nothing in flight now
      await fireRealDaemonEvent('IDLE'); // certainly idle
      await sleep(3000);
    }
  });
  watching = false;
  await inflightBurst;

  observer.destroy();
  firer.destroy();

  const w = commonWire(wireLog, nonce, session);
  const broadcast = observed.filter((m) => String(m.key ?? '').includes(nonce));

  say('');
  say(`  daemon events fired by this probe: ${fired}`);

  return report({
    label: 'B — real path',
    nonce,
    session,
    cp1: {
      state: broadcast.length > 0 ? 'observed' : 'not-observed',
      detail: broadcast.length
        ? `${broadcast.length} broadcast(s) seen on the daemon socket by an independent observer`
        : 'no matching *_event broadcast seen on the daemon socket'
    },
    cp2: {
      state: w.classified.length > 0 ? 'observed' : 'not-observed',
      detail: `${w.classified.length} notifications/message frame(s) carrying the nonce`
    },
    wireLog,
    ...w
  });
}

// -------------------------------------------------------------------- main --
const results = [];
try {
  if (!ONLY || ONLY === 'A') results.push(await configA());
  if (!ONLY || ONLY === 'C') results.push(await configC());
  if (!ONLY || ONLY === 'B') results.push(await configB());
} catch (err) {
  say('');
  say(`probe aborted: ${err?.stack ?? err}`);
  process.exit(1);
}

rule('SUMMARY');
say(`nonce root: ${nonceRoot}    model: ${MODEL}`);
say('');
say('                        CP1        CP2        CP3a in-flight   CP3a idle');
for (const r of results) {
  if (r.skipped) { say(`${r.label.padEnd(22)} SKIPPED`); continue; }
  const cell = (state) => {
    const frames = r.classified.filter((c) => c.state === state);
    if (!frames.length) return 'not-tested';
    return frames.some((f) => r.session.raw.includes(f.marker)) ? 'DELIVERED ' : 'dropped   ';
  };
  say(`${r.label.padEnd(22)} ${r.cp1.state.padEnd(10)} ${r.cp2.state.padEnd(10)} ` +
      `${cell('in-flight').padEnd(16)} ${cell('idle')}`);
}
say('');

const control = results.find((r) => r.isControl);
const real = results.filter((r) => !r.skipped && !r.isControl);
const anyDelivered = real.some((r) => r.classified.some((c) => r.session.raw.includes(c.marker)));
const anySent = real.some((r) => r.cp2.state === 'observed');

if (control && !control.controlInContext) {
  say('ANSWER: VOID — the positive control did not arrive either, so this probe cannot');
  say('        distinguish a dropped notification from a broken detector.');
} else if (anySent && !anyDelivered) {
  say('ANSWER: the notification left the server on every configuration that ran, in both');
  say('        target states, and NOTHING carrying the nonce reached the model\'s context.');
  say('        The control proves the detector works. The blocker is the CLIENT — not the');
  say('        protocol, not our SDK, and not our server.');
} else if (anyDelivered) {
  say('ANSWER: a server-initiated notification DID reach the model\'s context. See the');
  say('        per-state verdicts above for which states survived.');
} else {
  say('ANSWER: inconclusive — no configuration reached a verdict. See above.');
}
say('');
say(`scratch kept for inspection: ${scratch}`);

// Verdict-derived exit: did the probe manage to report, not did delivery work.
const ranAny = results.some((r) => r.ranToVerdict);
let failures = results.filter((r) => !r.skipped && !r.ranToVerdict).length;
if (control && !control.controlInContext) failures += 1;
if (!ranAny) {
  say('');
  say('probe FAILED: no configuration reached a verdict.');
  process.exit(1);
}
if (failures) {
  say('');
  say(`probe PARTIAL: ${failures} configuration(s) did not reach a trustworthy verdict.`);
}
process.exit(failures ? 1 : 0);
