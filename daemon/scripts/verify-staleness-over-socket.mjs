// Live proof that a real Butchr daemon reports staleness — at startup in its
// log, on demand over the socket, and alongside every `list_agents` poll (which
// is what feeds the Agents-page banner).
//
// A genuine daemon process is started against a genuine, deliberately stale
// checkout. Isolation is by $HOME: BUTCHR_DIR and the socket path are both
// derived from os.homedir(), so a temp HOME gives this daemon its own socket
// and its own log, and the live daemon at ~/.local/share/butchr is untouched.
//
// Usage: node daemon/scripts/verify-staleness-over-socket.mjs [repoToClone] [--dump <file>]
//
//   --dump <file>  write the exact list_agents_response received to <file>.
//                  extension/scripts/screenshot-staleness-banner.mjs renders
//                  that file, so the screenshot is of real daemon output rather
//                  than of a hand-written fixture.
//
// Run it after `npm run build` in daemon/.

import { execFileSync, spawn } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  readFileSync,
  existsSync,
  utimesSync,
  writeFileSync,
  symlinkSync
} from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const argv = process.argv.slice(2);
const dumpIdx = argv.indexOf('--dump');
const dumpPath = dumpIdx === -1 ? null : argv[dumpIdx + 1];
const positional = argv.filter((a, i) => i !== dumpIdx && i !== dumpIdx + 1);
const sourceRepo = positional[0] ?? path.resolve(daemonDir, '..');

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

const scratch = mkdtempSync(path.join(tmpdir(), 'kan30-socket-'));
const fakeHome = path.join(scratch, 'home');
const repo = path.join(scratch, 'butchr');
mkdirSync(fakeHome, { recursive: true });

let daemon;
process.on('exit', () => {
  daemon?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real clone, moved two commits back — the exact shape of "two PRs merged and
// nobody pulled". The compiled daemon is copied in so the process's own
// repoRoot (dist/../..) is this stale checkout.
console.log(`clone ${sourceRepo} -> ${repo}`);
run('git', ['clone', '--quiet', sourceRepo, repo]);
run('git', ['-C', repo, 'checkout', '--quiet', '-B', 'main', 'origin/main']);
run('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
run('git', ['-C', repo, 'fetch', '--quiet', 'origin']);
run('git', ['-C', repo, 'reset', '--hard', '--quiet', 'origin/main~2']);
cpSync(path.join(daemonDir, 'dist'), path.join(repo, 'daemon', 'dist'), { recursive: true });
// Symlinked, not copied: node-pty is a native module, and a tree installed with
// `npm ci --ignore-scripts` (as CI and typechecking do) has no compiled
// pty.node. Borrow a tree that has one — the daemon loads it at startup.
symlinkSync(resolveNodeModules(), path.join(repo, 'daemon', 'node_modules'));
// Age the sources so only the git case is stale: `git clone` stamps every file
// with the current time, which would otherwise make the builds look stale too.
const backdate = (root, rel = '') => {
  for (const entry of run('find', [path.join(root, rel), '-type', 'f']).trim().split('\n')) {
    if (!entry || entry.includes('/.git/') || entry.includes('/dist/') || entry.includes('/node_modules/')) continue;
    const when = new Date(Date.now() - 3600_000);
    try { utimesSync(entry, when, when); } catch {}
  }
};
backdate(repo);
// A stand-in extension build, so the *only* thing wrong with this install is
// the one thing being demonstrated: main is behind origin. mtimes are the
// evidence the check reads, so its contents are irrelevant.
mkdirSync(path.join(repo, 'extension', 'dist'), { recursive: true });
writeFileSync(path.join(repo, 'extension', 'dist', 'agents.js'), '// pretend build output\n');

const socketPath = path.join(fakeHome, '.local', 'share', 'butchr', 'butchr.sock');
const logPath = path.join(fakeHome, '.local', 'share', 'butchr', 'daemon.log');

console.log(`starting a real daemon from ${repo}/daemon/dist with HOME=${fakeHome}`);
daemon = spawn(process.execPath, [path.join(repo, 'daemon', 'dist', 'daemon.js')], {
  env: { ...process.env, HOME: fakeHome },
  stdio: ['ignore', 'ignore', 'inherit']
});

for (let i = 0; i < 60 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

console.log('\n' + '='.repeat(78));
console.log('1. what the daemon logged at startup (its own daemon.log)');
console.log('='.repeat(78));
console.log(
  readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => /staleness|STALE|OK  |fix:|note:|\?   |-   /.test(l))
    .join('\n')
);

// --- socket client ----------------------------------------------------------
const socket = net.connect(socketPath);
await new Promise((resolve) => socket.once('connect', resolve));

let buffer = '';
const pending = new Map();
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
let nextId = 0;
const call = (action, data = {}) =>
  new Promise((resolve) => {
    const id = `verify-${++nextId}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

console.log('\n' + '='.repeat(78));
console.log("2. on demand over the socket: {action: 'staleness_check'}");
console.log('='.repeat(78));
console.log(JSON.stringify(await call('staleness_check'), null, 2));

console.log('\n' + '='.repeat(78));
console.log("3. riding along on list_agents — the payload the Agents page polls");
console.log('='.repeat(78));
const agents = await call('list_agents');
console.log(JSON.stringify({ ...agents, staleness: agents.staleness?.summary }, null, 2));
console.log('\n  staleness.items as the banner receives them:');
console.log(
  '  ' +
    JSON.stringify(agents.staleness?.items?.map((i) => ({ id: i.id, state: i.state, headline: i.headline })), null, 2)
      .replace(/\n/g, '\n  ')
);

if (dumpPath) {
  const { id, ...body } = agents;
  writeFileSync(dumpPath, JSON.stringify(body, null, 2));
  console.log(`\nwrote the list_agents_response to ${dumpPath}`);
}

socket.end();
console.log('\n== done ==');
process.exit(0);
