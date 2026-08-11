// Live proof that a real Butchr daemon reports staleness — at startup in its
// log, on demand over the socket, and alongside every `list_agents` poll (which
// is what feeds the Agents-page banner).
//
// WHAT FAILURE THIS WOULD CATCH: a daemon that computes staleness correctly
// but fails to *deliver* it — a startup log that never mentions it, a
// `staleness_check` action that stops answering, or a `list_agents` payload
// that drops the `staleness` field the Agents-page banner renders from. Any
// one of those makes a stale install look healthy to the only surfaces anyone
// reads. In `--clean` mode it catches the opposite failure: a daemon that
// reports staleness on an install that is not stale.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// The startup-log leg waits for the line rather than reading once (KAN-251).
// What that wait covers is the daemon's buffered write stream reaching disk —
// nothing more. It does not make the log leg independent of the other two: all
// three read the same daemon process in the same run, so a defect in
// `getStalenessReport` itself fails all three together and none of them
// corroborates the others. `verify-staleness-check.mjs` is what exercises the
// report's own arithmetic, against clones damaged one way at a time.
//
// A genuine daemon process is started against a genuine, deliberately stale
// checkout. Isolation is by $HOME: BUTCHR_DIR and the socket path are both
// derived from os.homedir(), so a temp HOME gives this daemon its own socket
// and its own log, and the live daemon at ~/.local/share/butchr is untouched.
//
// Usage: node daemon/scripts/verify-staleness-over-socket.mjs [repoToClone] [--dump <file>] [--clean]
//
//   --dump <file>  write the exact list_agents_response received to <file>.
//                  extension/scripts/render-staleness-banner.mjs renders that
//                  file, so the surfacing proof is of real daemon output rather
//                  than of a hand-written fixture.
//   --clean        leave the clone level with origin/main, to show the same
//                  daemon reporting a healthy install and saying nothing.
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
const clean = argv.includes('--clean');
// `dumpIdx + 1` is the file after `--dump`. When there is no `--dump` at all,
// dumpIdx is -1 and that expression is 0 — which silently dropped the *first*
// positional, so `repoToClone` was ignored on every run that did not also pass
// `--dump` and the clone source was always the build's own repo root (KAN-251).
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && (dumpIdx === -1 || (i !== dumpIdx && i !== dumpIdx + 1))
);
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

// --- verdicts ---------------------------------------------------------------
//
// The three surfaces below are each asserted, not merely printed. Note that the
// `process.exit(1)`s above this line are setup guards — "the daemon never came
// up" is a reason this script could not run, not a verdict on the daemon. Only
// the failures counted here are verdicts, and only they decide the exit code.

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// What this run is entitled to expect. The fixture is either two commits behind
// origin/main or level with it, and every surface must agree with whichever it
// is: `--clean` is not a weaker run, it is the no-false-alarm half of the proof.
const expectStale = !clean;
const expectedHeadline = /main is 2 commits behind origin\/main/;

// A real clone, moved two commits back — the exact shape of "two PRs merged and
// nobody pulled". The compiled daemon is copied in so the process's own
// repoRoot (dist/../..) is this stale checkout.
console.log(`clone ${sourceRepo} -> ${repo}`);
run('git', ['clone', '--quiet', sourceRepo, repo]);
run('git', ['-C', repo, 'checkout', '--quiet', '-B', 'main', 'origin/main']);
run('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
run('git', ['-C', repo, 'fetch', '--quiet', 'origin']);
if (!clean) run('git', ['-C', repo, 'reset', '--hard', '--quiet', 'origin/main~2']);
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

// The daemon logs through `fs.createWriteStream` (daemon.ts), so a line is
// stamped when `log()` is called and reaches the file when the stream's buffer
// flushes. The socket appearing says nothing about that flush having happened:
// reading here the moment the socket showed up reported "no staleness line in
// daemon.log at all" on a daemon whose log, on disk after the run, held the
// line with a timestamp *earlier* than the read (KAN-251 — 3 of 14 runs of the
// unmodified build). Poll for it instead, exactly as the socket is polled
// above, and judge only once the wait has expired. The wait is on the log's
// *arrival*, never on its content: what is asserted below is unchanged, so a
// daemon that never logs staleness still fails — 10 seconds later than before.
const LOG_WAIT_MS = 10_000;

const readStalenessLog = () => {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => /staleness|STALE|OK  |fix:|note:|\?   |-   /.test(l));
  } catch {
    return [];
  }
};

// The two assertions below, as a predicate. Waiting on *these* rather than on
// "the file is non-empty" is what keeps `--clean` honest: a clean run must see
// `nothing stale`, and stopping at the first staleness line would let it read a
// half-written report and judge it.
const settled = (text) =>
  /staleness:/.test(text) &&
  (expectStale
    ? /STALE local checkout/.test(text) && expectedHeadline.test(text)
    : /staleness: nothing stale/.test(text));

// The first read is taken separately and reported, because it is exactly what
// the pre-KAN-251 script did: it is the one-shot read at socket-appearance.
// Keeping it visible means a run that hits the race says so in its own output
// rather than passing silently — the race is intermittent, and a fix for an
// intermittent fault that leaves no trace when it fires cannot be confirmed by
// anyone who did not already believe it.
const waitStartedAt = Date.now();
let logLines = readStalenessLog();
const atSocketAppearance = settled(logLines.join('\n'));
while (!settled(logLines.join('\n')) && Date.now() - waitStartedAt < LOG_WAIT_MS) {
  await sleep(50);
  logLines = readStalenessLog();
}
const waitedMs = Date.now() - waitStartedAt;
const logText = logLines.join('\n');

console.log(logText);
console.log(
  '\n  ' +
    (atSocketAppearance
      ? `(the log had already flushed when the socket appeared — waited ${waitedMs}ms)`
      : settled(logText)
        ? `(RACE OBSERVED: nothing this leg could judge was in daemon.log when the socket ` +
          `appeared; it arrived ${waitedMs}ms later. The one-shot read this leg used before ` +
          `KAN-251 would have called the daemon silent here.)`
        : `(waited the full ${waitedMs}ms and the daemon never logged what this run expects — ` +
          `not a flush delay, a daemon that did not say it)`)
);
console.log('');
check(
  'the daemon says something about staleness in its own log at startup',
  /staleness:/.test(logText),
  logLines.length
    ? `${logLines.length} matching line(s) after ${waitedMs}ms`
    : `no staleness line in daemon.log after waiting ${waitedMs}ms for one`
);
check(
  expectStale
    ? 'the startup log names the stale checkout'
    : 'the startup log reports nothing stale',
  expectStale
    ? /STALE local checkout/.test(logText) && expectedHeadline.test(logText)
    : /staleness: nothing stale/.test(logText) && !/STALE/.test(logText),
  logText.split('\n')[0] ?? '(nothing logged)'
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
const onDemand = await call('staleness_check');
console.log(JSON.stringify(onDemand, null, 2));

const gitItem = onDemand.items?.find((i) => i.id === 'git');
console.log('');
check('staleness_check answers at all', onDemand?.success === true, `success: ${onDemand?.success}`);
check(
  'staleness_check returns the itemised report, not just a boolean',
  Array.isArray(onDemand.items) && onDemand.items.some((i) => i.id === 'daemon-build'),
  `${onDemand.items?.length ?? 0} item(s)`
);
check(
  expectStale ? 'staleness_check reports the checkout stale' : 'staleness_check reports nothing stale',
  expectStale
    ? onDemand.stale === true && gitItem?.state === 'stale' && expectedHeadline.test(onDemand.summary ?? '')
    : onDemand.stale === false && gitItem?.state !== 'stale' && onDemand.summary === null,
  `stale: ${onDemand.stale}, git: ${gitItem?.state}, summary: ${onDemand.summary ?? '(none)'}`
);

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

// The banner is fed by list_agents, not by staleness_check — a daemon could
// answer the on-demand action perfectly and still drop the field the Agents
// page actually renders, which is the failure this pair of checks exists for.
const bannerGit = agents.staleness?.items?.find((i) => i.id === 'git');
console.log('');
check(
  'list_agents carries the staleness report the banner renders from',
  Boolean(agents.staleness) && Array.isArray(agents.staleness.items),
  agents.staleness ? `${agents.staleness.items?.length ?? 0} item(s)` : 'no staleness field on the payload'
);
check(
  'the banner receives the same verdict the on-demand check gave',
  agents.staleness?.summary === onDemand.summary && bannerGit?.state === gitItem?.state,
  `list_agents: ${agents.staleness?.summary ?? '(none)'} / staleness_check: ${onDemand.summary ?? '(none)'}`
);

if (dumpPath) {
  const { id, ...body } = agents;
  writeFileSync(dumpPath, JSON.stringify(body, null, 2));
  console.log(`\nwrote the list_agents_response to ${dumpPath}`);
}

socket.end();
console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(', ')}`
    : `\nALL PASS — all three surfaces agree the install is ${expectStale ? 'stale' : 'clean'}.`
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
