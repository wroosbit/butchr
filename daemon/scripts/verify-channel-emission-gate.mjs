// Live proof of the three things KAN-244 asserts at the WIRE, deterministically:
// that the `claude/channel` capability is declared, that an addressed frame is
// written to ONE agent's MCP server and to no other, and that with the switch
// off nothing of the kind leaves any server at all.
//
// WHAT FAILURE THIS WOULD CATCH: a channel that ships live rather than inert.
// §1.2 of docs/channel-messaging-design.md permits the capability to sit on the
// shared `butchr` server ONLY because emission is independently disableable and
// off by default — that mitigation is what makes the shared-server decision
// defensible, so a build where the switch is absent, defaults on, fails open on
// a corrupt file, or is simply not consulted has removed the reason the decision
// was allowed. None of that shows up as an error anywhere: every agent would
// quietly acquire a new inbound path into its context and the fleet would look
// exactly as it does now. It would equally catch the addressing being wrong in
// the direction that is invisible — a frame fanned out to every connection
// still reaches the intended recipient, so a broadcast masquerading as a route
// passes any test that only asks "did the right agent get it".
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// It also catches the allowlist drifting in EITHER direction: an eighth
// `*_event` forwarded because somebody named it that way (§1.3's firehose), and
// a real daemon event silently NOT forwarded because it was added to the daemon
// and not to the list (the price of an allowlist, section 4).
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), so, per section:
//
//   SECTION 1 supplies everything. A stub server stands in for the daemon and
//   writes the frames by hand, so it tests `mcp.ts`'s SELECTOR and EMISSION and
//   nothing whatever about whether a daemon ever produces such a frame.
//
//   SECTIONS 2 AND 3 supply none of it. A real daemon is started from the build
//   under test, two real `dist/mcp.js` servers are launched by the PRODUCTION
//   writers (`coreMcpServerDefinitions` → `withWorkspaceIdentity` →
//   `materializeMcpServers`), and the frame is produced by the daemon's own
//   `channel_send` resolving KAN-243's identity map. The chain argv → `hello` →
//   map → resolve → one socket → `notifications/claude/channel` is exercised
//   end to end by the code that runs in production.
//
//   WHAT NO SECTION HERE COVERS: whether the CLIENT delivers that notification
//   to a MODEL. The edge of this script is the MCP server's stdout. Claude Code
//   is not run here and no model is involved, so nothing in this file licenses
//   any claim about an agent receiving anything.
//   WHO COVERS IT: `probe-addressed-channel-delivery.mjs`, which fires an
//   addressed frame at one of two live channel-enabled Butchr agents and reads
//   both models' answers off their own panes. That is the ticket's four-step
//   criterion and it is a live experiment, not a CI check — which is exactly why
//   it is a `probe-` and this is a `verify-`.
//
// Isolation is by $HOME: BUTCHR_DIR, the socket and the switch file all derive
// from os.homedir(), so a temp HOME gives every section its own daemon, its own
// socket and its own switch, and the live daemon at ~/.local/share/butchr is
// untouched. The daemon is run from a COPY of dist so --misaddress can damage it
// without touching the build.
//
// Usage: node daemon/scripts/verify-channel-emission-gate.mjs [--misaddress]
//
//   --misaddress   patch the copied build so `resolve()` answers with somebody
//                  else's connection, and show this proof going red. AC2: a
//                  proof that has only ever passed cannot distinguish routing
//                  that works from routing that is never wrong by accident.
//
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import {
  mkdtempSync, mkdirSync, cpSync, rmSync, existsSync,
  readFileSync, writeFileSync, symlinkSync, readdirSync
} from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const misaddress = process.argv.includes('--misaddress');

// Setup guards. These are reasons this script COULD NOT RUN, not verdicts on the
// daemon, which is why they exit before the failure counter below exists.
if (!existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(process.env.HOME, 'code', 'wroosbit', 'butchr', 'daemon', 'node_modules')
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, '@modelcontextprotocol'))) return dir;
  }
  console.error(
    'No daemon/node_modules with @modelcontextprotocol installed. Run `npm install` in daemon/ ' +
      `(checked: ${candidates.join(', ')}).`
  );
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan244-channel-'));
const installDir = path.join(scratch, 'install', 'daemon');
const distDir = path.join(installDir, 'dist');
mkdirSync(installDir, { recursive: true });
cpSync(path.join(daemonDir, 'dist'), distDir, { recursive: true });
symlinkSync(resolveNodeModules(), path.join(installDir, 'node_modules'));

const spawned = [];
process.on('exit', () => {
  for (const c of spawned) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- verdicts ---------------------------------------------------------------
const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const rule = (t) => { console.log('\n' + '='.repeat(78)); console.log(t); console.log('='.repeat(78)); };

// The deliberate break, applied to the copy and ASSERTED rather than assumed: a
// --misaddress run whose patch silently missed would report healthy routing and
// be read as "this proof cannot go red", which is the opposite of what it means.
if (misaddress) {
  const target = path.join(distDir, 'agent-connections.js');
  const before = readFileSync(target, 'utf8');
  // ANCHORED ON `resolve(address) {`, and that anchor is not decoration. The
  // obvious needle — the lookup line alone — appears THREE times in this file,
  // and `register()`'s copy comes first, so the unanchored patch silently broke
  // registration instead of resolution: both agents landed in one slot and the
  // run went red for a reason the banner did not describe. A break that damages
  // something other than what it names is a proof lying about its own control,
  // which is this ticket's subject wearing the tester's hat. Measured, then
  // fixed here.
  const needle = '    resolve(address) {\n        const slot = this.byAddress.get(canonical(address));';
  if (!before.includes(needle)) {
    console.error(`--misaddress could not find resolve()'s lookup in ${target}; refusing to continue.`);
    process.exit(1);
  }
  const after = before.replace(
    needle,
    '    resolve(address) {\n' +
    '        const wanted = canonical(address);\n' +
    '        let slot = this.byAddress.get(wanted);\n' +
    '        for (const [k, s] of this.byAddress) { if (k !== wanted && s.length) { slot = s; break; } }'
  );
  writeFileSync(target, after);
  console.log("!! --misaddress: resolve() in the copied build now answers with somebody else's connection.\n");
  // The patch must have landed in `resolve` and NOWHERE ELSE. Asserted by
  // counting the untouched lookups: `register` and `connectionsFor` keep theirs.
  const remaining = (after.match(/this\.byAddress\.get\(canonical\(address\)\)/g) ?? []).length;
  if (remaining !== 2) {
    console.error(`--misaddress touched the wrong methods (${remaining} untouched lookups, expected 2). Refusing to continue.`);
    process.exit(1);
  }
}

// --- an MCP client over stdio ------------------------------------------------
//
// The framing Claude Code itself speaks to this server: newline-delimited
// JSON-RPC on stdin/stdout. Written here rather than pulled from the SDK so
// that what is observed is the BYTES the server wrote, not an SDK object graph
// that has already interpreted them — CP2 must rest on the wire.
function mcpClient(proc, label) {
  const frames = [];
  const stderr = [];
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { frames.push({ unparsed: line }); }
    }
  });
  proc.stderr.on('data', (c) => stderr.push(c.toString('utf8')));
  const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
  const awaitId = async (id, ms = 15_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = frames.find((f) => f.id === id);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  return {
    label, frames, send, awaitId,
    stderr: () => stderr.join(''),
    notifications: (method) => frames.filter((f) => f.method === method),
    async initialize() {
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'kan244-verify', version: '0' }
        }
      });
      const res = await this.awaitId(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return res;
    }
  };
}

/** Spawn `dist/mcp.js` with the identity flags a real activation would give it. */
function spawnMcp(distRoot, home, identity, flags) {
  const proc = spawn(process.execPath, [path.join(distRoot, 'mcp.js'), ...flags], {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  spawned.push(proc);
  return mcpClient(proc, `${identity.type}/${identity.key}`);
}

// ============================================================================
rule('1. the SERVER contract: what mcp.ts declares, and what it forwards');
// ============================================================================
// A stub stands in for the daemon here so that frames the daemon cannot be made
// to emit on demand — a non-allowlisted `*_event`, an addressed channel frame —
// can be put on the wire exactly. THIS SECTION TESTS mcp.ts AND NOTHING ELSE;
// sections 2 and 3 are where a real daemon produces the frames.
const stubHome = path.join(scratch, 'home-stub');
const stubButchr = path.join(stubHome, '.local', 'share', 'butchr');
mkdirSync(stubButchr, { recursive: true, mode: 0o700 });
const stubSocket = path.join(stubButchr, 'butchr.sock');

const stubClients = [];
await new Promise((resolve) => {
  const stub = net.createServer((socket) => {
    stubClients.push(socket);
    let sbuf = '';
    socket.on('error', () => {});
    socket.on('data', (c) => {
      sbuf += c.toString('utf8');
      let i;
      while ((i = sbuf.indexOf('\n')) !== -1) {
        const line = sbuf.slice(0, i); sbuf = sbuf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        // Answer `hello` the way the daemon does, so the server under test
        // reaches the same state it reaches in production.
        if (m.action === 'hello') {
          socket.write(JSON.stringify({
            action: 'hello_response', success: true, identified: true, connectionId: 'stub-1',
            workspaceType: m.workspaceType, workspaceKey: m.workspaceKey
          }) + '\n');
        }
      }
    });
  });
  stub.listen(stubSocket, resolve);
  spawned.push({ kill: () => stub.close() });
});

const stubAgent = spawnMcp(distDir, stubHome, { type: 'task', key: 'KAN-9101' },
  ['--workspace-type', 'task', '--workspace-key', 'KAN-9101']);
const initResult = await stubAgent.initialize();
const caps = initResult?.result?.capabilities ?? {};
console.log(`  initialize → capabilities: ${JSON.stringify(caps)}`);
check(
  "the server declares experimental['claude/channel']",
  Boolean(caps.experimental && caps.experimental['claude/channel']),
  'read off a real initialize result, not off the source'
);
check(
  'the capabilities it already had are still there',
  Boolean(caps.tools) && Boolean(caps.logging),
  `tools=${Boolean(caps.tools)} logging=${Boolean(caps.logging)}`
);

// Wait for the stub to hold the server's connection before writing to it.
for (let i = 0; i < 60 && stubClients.length === 0; i++) await sleep(100);
const toServer = (msg) => { for (const c of stubClients) c.write(JSON.stringify(msg) + '\n'); };

const { CHANNEL_EVENT_ALLOWLIST, CHANNEL_MESSAGE_ACTION, CHANNEL_NOTIFICATION_METHOD } =
  await import(pathToFileURL(path.join(distDir, 'channel.js')).href);

console.log('\n  THE ALLOWLIST, verbatim from the build under test:');
for (const a of CHANNEL_EVENT_ALLOWLIST) console.log(`    - ${a}`);

// An allowlisted event, and one that is not. `bogus_event` passes the OLD
// suffix test and must not pass this one — that difference is the change.
toServer({ action: 'agent_activated_event', type: 'task', key: 'KAN-9101' });
toServer({ action: 'bogus_event', type: 'task', key: 'KAN-9101' });
toServer({ action: CHANNEL_MESSAGE_ACTION, content: 'KAN244-SECTION1-CONTENT', meta: { probe: 'section1' } });
await sleep(2000);

const logNotes = stubAgent.notifications('notifications/message');
const chanNotes = stubAgent.notifications(CHANNEL_NOTIFICATION_METHOD);
console.log('\n  what left the server, on the wire:');
for (const f of [...logNotes, ...chanNotes]) console.log(`    ${JSON.stringify(f)}`);
check(
  'an allowlisted event is forwarded, exactly as before KAN-244',
  logNotes.some((f) => String(f.params?.data ?? '').includes('agent_activated_event')),
  'agent_activated_event → notifications/message'
);
check(
  'a NON-allowlisted *_event is NOT forwarded',
  !logNotes.some((f) => String(f.params?.data ?? '').includes('bogus_event')),
  'bogus_event passes the retired suffix test and must not pass the allowlist'
);
check(
  `an addressed ${CHANNEL_MESSAGE_ACTION} frame becomes ${CHANNEL_NOTIFICATION_METHOD}`,
  chanNotes.some((f) => f.params?.content === 'KAN244-SECTION1-CONTENT'),
  `${chanNotes.length} channel notification(s) on the wire`
);

// ============================================================================
rule('2. a REAL daemon, switch untouched: the channel is INERT by default');
// ============================================================================
const home = path.join(scratch, 'home');
mkdirSync(home, { recursive: true });
const butchrDir = path.join(home, '.local', 'share', 'butchr');
const socketPath = path.join(butchrDir, 'butchr.sock');
const switchPath = path.join(butchrDir, 'channel.json');

const daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'ignore', 'inherit']
});
spawned.push(daemon);
for (let i = 0; i < 80 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

/** A plain RPC client on the daemon socket — the diagnostic caller. */
async function rpc(label) {
  const socket = net.connect(socketPath);
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  socket.on('error', () => {});
  const pending = new Map();
  const events = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const r = m.id !== undefined ? pending.get(m.id) : undefined;
      if (r) { pending.delete(m.id); r(m); } else events.push(m);
    }
  });
  let n = 0;
  const call = (body) => new Promise((resolve) => {
    const id = `${label}-${++n}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ ...body, id }) + '\n');
    setTimeout(() => { if (pending.delete(id)) resolve({ timedOut: true }); }, 15_000);
  });
  return { call, events, close: () => socket.destroy() };
}

const diag = await rpc('diag');

check(
  'the switch file does not exist on a fresh install',
  !existsSync(switchPath),
  `absent at ${path.relative(home, switchPath)} — and absent means off`
);
const offState = await diag.call({ action: 'channel_switch' });
console.log(`  channel_switch (read) → ${JSON.stringify(offState)}`);
check('the daemon reports channel emission OFF by default', offState.enabled === false, 'off-by-default');

// Two real MCP servers, launched by the production writers.
const launchers = await import(pathToFileURL(path.join(distDir, 'launchers.js')).href);
const { coreMcpServerDefinitions, withWorkspaceIdentity, materializeMcpServers, CORE_MCP_SERVER } = launchers;

const AGENT_A = { type: 'task', key: 'KAN-9201' };
const AGENT_B = { type: 'task', key: 'KAN-9202' };

async function launchAgent(identity) {
  const defs = materializeMcpServers(withWorkspaceIdentity(coreMcpServerDefinitions(), identity));
  const def = defs[CORE_MCP_SERVER];
  // The production definition points at the INSTALLED mcp.js; this run must
  // exercise the copied build, so only the script path is swapped and the
  // identity flags the writers produced are carried through verbatim.
  const flags = def.args.slice(1);
  console.log(`  launching ${identity.type}/${identity.key} with flags: ${flags.join(' ')}`);
  const client = spawnMcp(distDir, home, identity, flags);
  await client.initialize();
  return client;
}

const agentA = await launchAgent(AGENT_A);
const agentB = await launchAgent(AGENT_B);

// Both must be in the daemon's map before anything is addressed at them.
let connected = { agents: [] };
for (let i = 0; i < 60; i++) {
  connected = await diag.call({ action: 'connected_agents' });
  if ((connected.agents ?? []).length >= 2) break;
  await sleep(250);
}
console.log(`  connected_agents → ${JSON.stringify(connected.agents)}`);
check(
  'both agents are in the identity map before anything is addressed',
  (connected.agents ?? []).length === 2,
  `${(connected.agents ?? []).length} identified`
);

const offSend = await diag.call({
  action: 'channel_send',
  workspaceType: AGENT_A.type, workspaceKey: AGENT_A.key,
  content: 'KAN244-WHILE-OFF', meta: { probe: 'section2' }
});
console.log(`  channel_send while OFF → ${JSON.stringify(offSend)}`);
check(
  'a send with the switch off is REFUSED, not silently dropped',
  offSend.success === false && offSend.reason === 'channel-disabled',
  `reason=${offSend.reason ?? '(none)'}`
);
check(
  'the refusal names the switch, so the sender learns where it is',
  typeof offSend.switchPath === 'string' && offSend.switchPath.endsWith('channel.json'),
  offSend.switchPath ?? '(not named)'
);

await sleep(1500);
check(
  'NO channel notification left agent A\'s server while off',
  agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length === 0,
  `${agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length} frame(s)`
);
check(
  'NO channel notification left agent B\'s server while off',
  agentB.notifications(CHANNEL_NOTIFICATION_METHOD).length === 0,
  `${agentB.notifications(CHANNEL_NOTIFICATION_METHOD).length} frame(s)`
);

// EXISTING CONSUMERS ARE UNAFFECTED — the other half of "inert". A channel that
// is off must not cost the broadcast path anything, and `reset_by_key` on a key
// with no workspace broadcasts `agent_reset_event` and deletes nothing.
const anon = await rpc('anon');
anon.events.length = 0;
const beforeLog = agentA.notifications('notifications/message').length;
await diag.call({ action: 'reset_by_key', type: 'task', key: 'KAN-9299-NO-SUCH-WORKSPACE' });
for (let i = 0; i < 40 && !anon.events.some((e) => e.action === 'agent_reset_event'); i++) await sleep(100);
await sleep(1000);
check(
  'broadcast still reaches an ordinary anonymous client with the channel off',
  anon.events.some((e) => e.action === 'agent_reset_event'),
  'agent_reset_event'
);
check(
  "and still reaches an agent's MCP server as notifications/message",
  agentA.notifications('notifications/message').length > beforeLog,
  `${agentA.notifications('notifications/message').length - beforeLog} new logging notification(s)`
);

// ============================================================================
rule('3. switch ON: the frame reaches ONE agent, and demonstrably not the other');
// ============================================================================
const onState = await diag.call({ action: 'channel_switch', enabled: true });
console.log(`  channel_switch (set on) → ${JSON.stringify(onState)}`);
check('the switch reads back ON after being set', onState.enabled === true, 'runtime, with nothing restarted');
check(
  'setting it wrote the switch file the daemon reads',
  existsSync(switchPath),
  existsSync(switchPath) ? readFileSync(switchPath, 'utf8').trim().replace(/\s+/g, ' ') : 'absent'
);

const NONCE_A = 'KAN244-ADDRESSED-TO-A';
const sent = await diag.call({
  action: 'channel_send',
  workspaceType: AGENT_A.type, workspaceKey: AGENT_A.key,
  content: NONCE_A, meta: { probe: 'section3' }
});
console.log(`  channel_send → ${JSON.stringify(sent)}`);
check('the addressed send reports success', sent.success === true, sent.error ?? '');
check(
  'and its claim is about the CONNECTION, not about a model',
  typeof sent.claim === 'string' && /not a claim that/.test(sent.claim),
  sent.claim ?? '(no claim stated)'
);
check(
  'the daemon says it wrote to the connection the map holds for A',
  sent.workspaceKey === AGENT_A.key && sent.workspaceType === AGENT_A.type,
  `${sent.workspaceType}/${sent.workspaceKey} on ${sent.connectionId}`
);

await sleep(2000);
const gotA = agentA.notifications(CHANNEL_NOTIFICATION_METHOD).filter((f) => f.params?.content === NONCE_A);
const gotB = agentB.notifications(CHANNEL_NOTIFICATION_METHOD).filter((f) => f.params?.content === NONCE_A);
console.log(`  agent A's wire: ${JSON.stringify(gotA)}`);
console.log(`  agent B's wire: ${JSON.stringify(gotB)}`);
check(
  'THE INTENDED RECIPIENT received it',
  gotA.length === 1,
  `${gotA.length} frame(s) carrying the nonce on A's wire`
);
check(
  'THE OTHER AGENT DID NOT — this is the half that separates routing from broadcast',
  gotB.length === 0,
  `${gotB.length} frame(s) on B's wire`
);

// The symmetric send. One-directional routing that always answers with the
// first connection would pass everything above; it cannot pass this too.
const NONCE_B = 'KAN244-ADDRESSED-TO-B';
await diag.call({
  action: 'channel_send',
  workspaceType: AGENT_B.type, workspaceKey: AGENT_B.key,
  content: NONCE_B, meta: { probe: 'section3' }
});
await sleep(2000);
check(
  'addressing the other way round reaches B and only B',
  agentB.notifications(CHANNEL_NOTIFICATION_METHOD).some((f) => f.params?.content === NONCE_B) &&
    !agentA.notifications(CHANNEL_NOTIFICATION_METHOD).some((f) => f.params?.content === NONCE_B),
  `A=${agentA.notifications(CHANNEL_NOTIFICATION_METHOD).length} B=${agentB.notifications(CHANNEL_NOTIFICATION_METHOD).length} total frame(s)`
);

// The honest negative: an agent that is not there. §1.3 asks for this to be a
// sender-visible answer rather than a discard.
const absent = await diag.call({
  action: 'channel_send',
  workspaceType: 'task', workspaceKey: 'KAN-9999-NOBODY-HOME',
  content: 'KAN244-INTO-THE-VOID'
});
console.log(`  channel_send to an absent agent → ${JSON.stringify(absent)}`);
check(
  'an unreachable recipient is reported to the sender, not discarded',
  absent.success === false && absent.reason === 'no-connection',
  absent.error ?? ''
);

// And back off again, at runtime, with nothing restarted.
const backOff = await diag.call({ action: 'channel_switch', enabled: false });
const afterOff = await diag.call({
  action: 'channel_send',
  workspaceType: AGENT_A.type, workspaceKey: AGENT_A.key,
  content: 'KAN244-AFTER-SWITCH-OFF'
});
await sleep(1500);
check(
  'the switch can be pulled at runtime and emission stops again',
  backOff.enabled === false && afterOff.reason === 'channel-disabled' &&
    !agentA.notifications(CHANNEL_NOTIFICATION_METHOD).some((f) => f.params?.content === 'KAN244-AFTER-SWITCH-OFF'),
  'same daemon, same agents, no restart'
);

// A corrupt switch file must read as OFF. A kill switch that fails open on half
// a JSON document is off precisely when somebody edited it in a hurry.
writeFileSync(switchPath, '{"enabled": tr');
const corrupt = await diag.call({ action: 'channel_switch' });
check(
  'a corrupt switch file reads as OFF rather than failing open',
  corrupt.enabled === false,
  'fails closed'
);

// ============================================================================
rule('4. the allowlist has not drifted from what the daemon actually emits');
// ============================================================================
// The direction an allowlist fails in: an event added to the daemon and not to
// the list is dropped in silence. Read out of the sources rather than restated,
// so the two cannot be kept in step by hand.
const emitted = new Set();
for (const file of readdirSync(path.join(daemonDir, 'src'))) {
  if (!file.endsWith('.ts')) continue;
  const src = readFileSync(path.join(daemonDir, 'src', file), 'utf8');
  for (const m of src.matchAll(/action:\s*'([a-z_]+_event)'/g)) emitted.add(m[1]);
}
const listed = new Set(CHANNEL_EVENT_ALLOWLIST);
const missing = [...emitted].filter((e) => !listed.has(e)).sort();
const stale = [...listed].filter((e) => !emitted.has(e)).sort();
console.log(`  emitted by daemon/src : ${[...emitted].sort().join(', ')}`);
console.log(`  on the allowlist      : ${[...listed].sort().join(', ')}`);
check(
  'every event the daemon emits is on the allowlist',
  missing.length === 0,
  missing.length ? `NOT forwarded, silently: ${missing.join(', ')}` : 'none dropped'
);
check(
  'the allowlist names no event that no longer exists',
  stale.length === 0,
  stale.length ? `stale entries: ${stale.join(', ')}` : 'none stale'
);

console.log('\n' + '='.repeat(78));
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log('All checks passed.');
}
console.log('='.repeat(78));

process.exit(failures.length ? 1 : 0);
