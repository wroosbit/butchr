// Live proof that the daemon knows which agent is on the other end of each of
// its connections — that the identity arrives from a real MCP server's own
// argv, that two agents resolve to two distinct connections, and that the entry
// is GONE when one of them disconnects.
//
// WHAT FAILURE THIS WOULD CATCH: an identity→connection map that never forgets.
// A daemon that registers on `hello` but does not release on `close` keeps a
// dead socket under a live agent's name, and nothing looks wrong until the
// first addressed message is written to a socket nobody is reading — the agent
// is simply never told, and no log line anywhere says so. It would also catch
// the two ways the map can be wrong while still emptying: identity inferred
// from a request body rather than an announcement (which would register the
// Chrome extension as whichever agent a human is watching), and a
// `Map<address, socket>` with last-write-wins, where an agent that reconnects
// before its old socket's `close` fires has the old cleanup delete the new
// entry — a live agent, unaddressable, with nothing in any log about it.
//
// WHAT IT DOES NOT COVER, AND WHO DOES. This script proves the map resolves an
// identity to a connection. It does NOT fire an addressed frame down that
// connection and observe it arriving at one model and not the other — nothing
// in KAN-243 emits one, and adding an emitter to prove a map would be inventing
// the thing under test. **KAN-244 (T2) owns that**, explicitly and as its
// reason for existing: its four-step criterion is an addressed notification
// reaching one live agent's model with the second agent asked the same question
// and answering without the nonce. The edge of this script is the socket; the
// edge of that one is the model.
//
// WHERE ITS INPUT COMES FROM, since a proof that supplies its own input has
// tested nothing about arrival (KAN-145). Section 1 supplies none of it: the
// two agents' command lines are built by the *production* writers —
// `coreMcpServerDefinitions` → `withWorkspaceIdentity` → `materializeMcpServers`
// — and a real `dist/mcp.js` is spawned from the result, so the chain argv →
// `workspaceIdentityFromArgv` → `hello` → the daemon's map is exercised
// end-to-end by the same code that runs in production. Sections 3 and 4 DO
// construct their own connections with hand-written `hello` frames, because
// they test map *semantics* (reconnection ordering, anonymity) that a real
// agent cannot be made to perform on demand. That is honest only because
// section 1 is what establishes the frames arrive at all; on its own, section 3
// would be the KAN-145 defect wearing a different hat.
//
// Isolation is by $HOME: BUTCHR_DIR and the socket path both derive from
// os.homedir(), so a temp HOME gives this daemon its own socket and its own
// log, and the live daemon at ~/.local/share/butchr is untouched. The daemon is
// run from a *copy* of dist so --break-removal can damage it without touching
// the build.
//
// Usage: node daemon/scripts/verify-agent-connection-identity.mjs [--break-removal]
//
//   --break-removal   patch the copied build so `release()` forgets nothing,
//                     and show this proof going red. AC2: a map that never
//                     forgets is the leak this ticket is most likely to ship,
//                     and a proof that has only ever passed is evidence of
//                     nothing.
//
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const breakRemoval = process.argv.includes('--break-removal');

if (!existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  console.error('daemon/dist/daemon.js is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

/** A daemon/node_modules with a compiled node-pty in it, or exit saying so. */
function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(process.env.HOME, 'code', 'wroosbit', 'butchr', 'daemon', 'node_modules')
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'node-pty', 'build', 'Release', 'pty.node'))) return dir;
  }
  console.error(
    'No daemon/node_modules with a compiled node-pty found. Run `npm install` in daemon/ ' +
      `(checked: ${candidates.join(', ')}).`
  );
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan243-identity-'));
const fakeHome = path.join(scratch, 'home');
const installDir = path.join(scratch, 'install', 'daemon');
const distDir = path.join(installDir, 'dist');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(installDir, { recursive: true });

const children = [];
let daemon;
process.on('exit', () => {
  for (const c of children) c.proc?.kill('SIGKILL');
  daemon?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- verdicts ---------------------------------------------------------------
//
// Everything below is asserted rather than merely printed. The `process.exit(1)`
// calls above this line are setup guards — "there is no build to test" is a
// reason this script could not run, not a verdict on the daemon. Only the
// failures counted here decide the exit code.
const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

cpSync(path.join(daemonDir, 'dist'), distDir, { recursive: true });
symlinkSync(resolveNodeModules(), path.join(installDir, 'node_modules'));

// The deliberate break, applied to the copy. Asserted rather than assumed: a
// `--break-removal` run whose patch silently missed would report a healthy
// daemon and be read as "the proof cannot go red", which is the opposite of
// what it would mean.
if (breakRemoval) {
  const target = path.join(distDir, 'agent-connections.js');
  const before = readFileSync(target, 'utf8');
  const after = before.replace(
    /(\n\s*release\(socket\) \{)/,
    '$1\n        return undefined; // KAN-243 --break-removal: forget nothing'
  );
  if (after === before) {
    console.error(
      `--break-removal could not find release(socket) in ${target}; the patch would be a no-op ` +
        'and this run would prove nothing. Refusing to continue.'
    );
    process.exit(1);
  }
  writeFileSync(target, after);
  console.log('!! --break-removal: release() in the copied build now forgets nothing.\n');
}

// The agents this proof will connect. Two distinct keys, and a third address
// used only by section 3's synthetic reconnection.
const AGENT_A = { type: 'task', key: 'KAN-9001' };
const AGENT_B = { type: 'story', key: 'KAN-9002' };
const RECONNECTOR = { type: 'task', key: 'KAN-9003' };

const socketPath = path.join(fakeHome, '.local', 'share', 'butchr', 'butchr.sock');
const logPath = path.join(fakeHome, '.local', 'share', 'butchr', 'daemon.log');

console.log(`starting a real daemon from ${distDir} with HOME=${fakeHome}`);
daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: { ...process.env, HOME: fakeHome },
  stdio: ['ignore', 'ignore', 'inherit']
});
for (let i = 0; i < 60 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

// --- a diagnostic client ----------------------------------------------------
/** A raw socket client. `identify` sends a hello; omitting it stays anonymous. */
async function client(label) {
  const socket = net.connect(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => {});
  const pending = new Map();
  const events = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      } else {
        events.push(msg);
      }
    }
  });
  let n = 0;
  const request = (body) =>
    new Promise((resolve, reject) => {
      const id = `${label}-${++n}`;
      pending.set(id, resolve);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out: ${body.action}`));
      }, 10_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      socket.write(JSON.stringify({ ...body, id }) + '\n');
    });
  return { label, socket, request, events, close: () => socket.destroy() };
}

const diag = await client('diag');
const agentsByKey = async () => {
  const res = await diag.request({ action: 'connected_agents' });
  const map = new Map();
  for (const entry of res.agents) map.set(`${entry.type}/${entry.key}`, entry);
  return { res, map };
};

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log('1. two REAL MCP servers, launched the way the daemon launches them');
console.log('='.repeat(78));
// The command line is built by the production writers, not typed here: if
// `withWorkspaceIdentity` stopped stamping the flags, or `mcp.ts` stopped
// reading them, this section would go red rather than passing on a hand-made
// argv that nothing in production produces. That is the KAN-145 lesson applied.
const launchers = await import(pathToFileURL(path.join(distDir, 'launchers.js')).href);
const { coreMcpServerDefinitions, withWorkspaceIdentity, materializeMcpServers, CORE_MCP_SERVER } =
  launchers;

async function launchAgent(identity) {
  const defs = materializeMcpServers(
    withWorkspaceIdentity(coreMcpServerDefinitions(), identity)
  );
  const def = defs[CORE_MCP_SERVER];
  console.log(`  launching ${identity.type}/${identity.key}: ${path.basename(def.args[0])} ${def.args.slice(1).join(' ')}`);
  const proc = spawn(def.command, def.args, {
    env: { ...process.env, ...(def.env ?? {}), HOME: fakeHome },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const entry = { identity, proc, stderr: '' };
  proc.stderr.on('data', (d) => {
    entry.stderr += d.toString('utf8');
  });
  children.push(entry);
  return entry;
}

const a = await launchAgent(AGENT_A);
const b = await launchAgent(AGENT_B);

// Wait for both to appear, bounded. Absence after the wait is a verdict.
let seen = await agentsByKey();
for (let i = 0; i < 40 && seen.map.size < 2; i++) {
  await sleep(250);
  seen = await agentsByKey();
}
console.log('\n  connected_agents_response:');
console.log(
  JSON.stringify(seen.res.agents, null, 2)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
);

const entryA = seen.map.get(`${AGENT_A.type}/${AGENT_A.key}`);
const entryB = seen.map.get(`${AGENT_B.type}/${AGENT_B.key}`);
check('the daemon knows agent A by its own argv-derived identity', Boolean(entryA), `${AGENT_A.type}/${AGENT_A.key}`);
check('the daemon knows agent B by its own argv-derived identity', Boolean(entryB), `${AGENT_B.type}/${AGENT_B.key}`);
check(
  'each agent resolves to exactly one connection',
  entryA?.connections.length === 1 && entryB?.connections.length === 1,
  `A=${entryA?.connections.length ?? 0} B=${entryB?.connections.length ?? 0}`
);
check(
  'the two agents resolve to DISTINCT connections',
  Boolean(entryA && entryB) && entryA.connections[0].id !== entryB.connections[0].id,
  entryA && entryB ? `${entryA.connections[0].id} vs ${entryB.connections[0].id}` : 'an agent is missing'
);

// The cross-check: each MCP server reports on its own stderr which connection
// the daemon gave it. Two independent observations of the same binding — the
// daemon's map says key→conn-N, and the process holding conn-N is the one that
// was launched with that key on its command line.
const registeredId = (entry) => (entry.stderr.match(/Registered with the daemon as \S+ \((conn-\d+)\)/) ?? [])[1];
console.log('\n  what each MCP server said on its own stderr:');
for (const c of [a, b]) {
  for (const line of c.stderr.trim().split('\n')) console.log(`    [${c.identity.type}/${c.identity.key}] ${line}`);
}
check(
  "agent A's own report of its connection id matches the daemon's map",
  Boolean(entryA) && registeredId(a) === entryA.connections[0].id,
  `server said ${registeredId(a) ?? '(nothing)'}, map says ${entryA?.connections[0].id ?? '(absent)'}`
);
check(
  "agent B's own report of its connection id matches the daemon's map",
  Boolean(entryB) && registeredId(b) === entryB.connections[0].id,
  `server said ${registeredId(b) ?? '(nothing)'}, map says ${entryB?.connections[0].id ?? '(absent)'}`
);

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log('2. one agent disconnects — its entry must be GONE, the other untouched');
console.log('='.repeat(78));
const idBefore = entryB?.connections[0].id;
a.proc.kill('SIGKILL');
let after = await agentsByKey();
for (let i = 0; i < 40 && after.map.has(`${AGENT_A.type}/${AGENT_A.key}`); i++) {
  await sleep(250);
  after = await agentsByKey();
}
console.log('\n  connected_agents_response after the kill:');
console.log(
  JSON.stringify(after.res.agents, null, 2)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
);
check(
  "the dead agent's entry is gone from the map",
  !after.map.has(`${AGENT_A.type}/${AGENT_A.key}`),
  after.map.has(`${AGENT_A.type}/${AGENT_A.key}`)
    ? 'still registered after its process was killed — the map leaks'
    : `${AGENT_A.type}/${AGENT_A.key} absent`
);
check(
  'the surviving agent is undisturbed, on the same connection',
  after.map.get(`${AGENT_B.type}/${AGENT_B.key}`)?.connections[0]?.id === idBefore,
  `${after.map.get(`${AGENT_B.type}/${AGENT_B.key}`)?.connections[0]?.id ?? '(absent)'} (was ${idBefore})`
);

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log('3. reconnection: a stale close must not evict the connection that replaced it');
console.log('='.repeat(78));
// Synthetic connections, deliberately — a real agent cannot be made to
// reconnect-then-close-late on demand, and this is the ordering that a
// `Map<address, socket>` gets wrong. Section 1 is what establishes that a real
// `hello` arrives; this section is about what the map does with two of them.
const old = await client('old');
const fresh = await client('fresh');
const helloOld = await old.request({ action: 'hello', workspaceType: RECONNECTOR.type, workspaceKey: RECONNECTOR.key });
const helloNew = await fresh.request({ action: 'hello', workspaceType: RECONNECTOR.type, workspaceKey: RECONNECTOR.key });
console.log(`  old connection:  ${JSON.stringify(helloOld)}`);
console.log(`  new connection:  ${JSON.stringify(helloNew)}`);

let both = await agentsByKey();
const reconnEntry = both.map.get(`${RECONNECTOR.type}/${RECONNECTOR.key}`);
check(
  'one agent may hold two connections, and both are kept',
  reconnEntry?.connections.length === 2,
  `${reconnEntry?.connections.length ?? 0} connection(s)`
);
check(
  'the NEWEST connection is the one an addressed message would resolve to',
  reconnEntry?.connections.find((c) => c.current)?.id === helloNew.connectionId,
  `current=${reconnEntry?.connections.find((c) => c.current)?.id ?? '(none)'}, newest=${helloNew.connectionId}`
);

// Now the stale close, after the reconnect. Last-write-wins would delete the
// live entry here.
old.close();
let survived = await agentsByKey();
for (let i = 0; i < 40; i++) {
  const e = survived.map.get(`${RECONNECTOR.type}/${RECONNECTOR.key}`);
  if (e && e.connections.length === 1) break;
  await sleep(250);
  survived = await agentsByKey();
}
const survivor = survived.map.get(`${RECONNECTOR.type}/${RECONNECTOR.key}`);
console.log(`  after the OLD connection closed: ${JSON.stringify(survivor)}`);
check(
  'the stale close removed only its own connection',
  survivor?.connections.length === 1 && survivor.connections[0].id === helloNew.connectionId,
  `left ${JSON.stringify(survivor?.connections.map((c) => c.id) ?? [])}, expected [${helloNew.connectionId}]`
);
fresh.close();

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log('4. an unidentified connection is ordinary — and is not addressable');
console.log('='.repeat(78));
// The sidepanel and the Agents page are connections too. They must keep working
// and must NOT become routable agents.
const anon = await client('anon');
const refused = await anon.request({ action: 'hello', workspaceType: '', workspaceKey: '' });
console.log(`  hello with no identity: ${JSON.stringify(refused)}`);
check('a hello with no identity is refused rather than invented', refused.success === false && refused.identified === false, refused.error ?? '');

const anonView = await agentsByKey();
check(
  'anonymous connections are connected but not identified',
  anonView.res.totalConnections > anonView.res.identifiedConnections,
  `${anonView.res.identifiedConnections} identified of ${anonView.res.totalConnections} connected`
);
check(
  'no anonymous client appears in the map under any name',
  anonView.res.agents.every((e) => `${e.type}/${e.key}` === `${AGENT_B.type}/${AGENT_B.key}`),
  JSON.stringify(anonView.res.agents.map((e) => `${e.type}/${e.key}`))
);

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log('5. broadcast is unchanged — identified and anonymous clients both receive it');
console.log('='.repeat(78));
// AC3. `reset_by_key` on a key with no workspace broadcasts `agent_reset_event`
// and deletes nothing (resetWorkspace refuses anything that is not strictly
// inside this fake HOME's workspaces root, and nothing is).
const listener = await client('listener');
await listener.request({ action: 'hello', workspaceType: 'task', workspaceKey: 'KAN-9004' });
anon.events.length = 0;
listener.events.length = 0;
await diag.request({ action: 'reset_by_key', type: 'task', key: 'KAN-9005-NO-SUCH-WORKSPACE' });
for (let i = 0; i < 20 && !(anon.events.length && listener.events.length); i++) await sleep(100);
const resetOf = (c) => c.events.find((e) => e.action === 'agent_reset_event');
console.log(`  anonymous client received:  ${JSON.stringify(resetOf(anon) ?? null)}`);
console.log(`  identified client received: ${JSON.stringify(resetOf(listener) ?? null)}`);
check('an anonymous client still receives broadcast events', Boolean(resetOf(anon)), 'agent_reset_event');
check('an identified client still receives broadcast events', Boolean(resetOf(listener)), 'agent_reset_event');

// ============================================================================
console.log('\n' + '='.repeat(78));
console.log("6. what the daemon wrote in its own log");
console.log('='.repeat(78));
const logLines = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((l) => /Connection conn-|unregistered|anonymous/.test(l));
console.log(logLines.map((l) => `  ${l}`).join('\n') || '  (nothing)');
check(
  'the daemon says in its log which agent each connection is',
  logLines.some((l) => /Connection conn-\d+ is task\/KAN-9001/.test(l)),
  'registration is legible to a human reading daemon.log'
);
check(
  'the daemon says in its log when an agent is unregistered',
  logLines.some((l) => /task\/KAN-9001 unregistered/.test(l)),
  breakRemoval ? 'expected to be missing under --break-removal' : 'removal is legible too'
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
