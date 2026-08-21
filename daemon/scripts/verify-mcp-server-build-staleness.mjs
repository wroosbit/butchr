// KAN-526: a deploy cannot reach a running agent's proxy, and until this check
// existed nothing said so.
//
// WHAT FAILURE THIS WOULD CATCH: an agent's `mcp.js` serving calls out of a
// build older than the deployed one while every staleness item reads green — the
// state the whole fleet was in on 2026-08-18, when the checkout sat at the merge
// commit, the daemon had been rebuilt and restarted, and not one server on the
// machine was post-merge. It also catches the two ways the check could lie in
// the comfortable direction: an empty connection list reported as `fresh`
// instead of `unknown` (a daemon restart drops every registration, so the
// emptiest moment is the moment right after a deploy), and a server that
// announces no build at all being read as current rather than as necessarily
// pre-KAN-526.
//
// CI-RUNNABLE: yes — no live daemon, no herdr, no credential, no network. It
// spawns the built `dist/mcp.js` against a stub socket in a temp HOME, and
// drives the real registry and the real staleness report in process.
//
// SECTIONS, AND WHICH ONES A FAILED BUILD INVALIDATES. Read the section, never
// the exit code, if `npm run build` did not exit 0:
//
//   A. announcement (live)   — spawns dist/mcp.js. dist-dependent.
//   B. verdict (behaviour)   — imports dist/. dist-dependent.
//   C. wiring (static)       — reads daemon/src/*.ts as TEXT. Unaffected by a
//                              failed build: it read what you wrote.
//
// `--static-only` runs C alone, for exactly that case.
//
// WHAT THIS SCRIPT DOES NOT COVER, named because two honest scripts can still
// leave a hole between them (KAN-145). Section A proves a real `mcp.js` process
// announces a real build stamp, and section B proves the daemon's report goes
// red on one that is behind — but **no section here exercises a
// client-spawned server registering with the real running daemon and appearing
// in the real fleet report**. That leg needs a deployed build on this machine
// and therefore cannot be run before the merge that deploys it; the post-deploy
// observation on the ticket is what covers it, and nothing here does.
//
// Usage: node daemon/scripts/verify-mcp-server-build-staleness.mjs [--static-only]
// Run from the repo root or the daemon directory after `npm run build`.

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const distDir = path.join(daemonDir, 'dist');
const staticOnly = process.argv.includes('--static-only');

const failures = [];
let checks = 0;

function check(name, ok, evidence = '') {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
  if (!ok) failures.push(name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan526-'));
const cleanup = [];

// --- C. wiring, read as text ------------------------------------------------
//
// The three edits that make a build stamp travel from the process that has it
// to the check that judges it. Asserted over source rather than behaviour
// because behaviour cannot see a wire that was never connected: sections A and
// B would both pass on a daemon that parsed the block and dropped it.

console.log('\n--- C. wiring (static, reads src as text) ---');
{
  const mcpSrc = fs.readFileSync(path.join(daemonDir, 'src/mcp.ts'), 'utf8');
  const daemonSrc = fs.readFileSync(path.join(daemonDir, 'src/daemon.ts'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(daemonDir, 'src/router.ts'), 'utf8');

  check(
    'mcp.ts reads its own build at load',
    /const OWN_BUILD = readOwnBuild\(import\.meta\.url\)/.test(mcpSrc)
  );
  check(
    "mcp.ts puts the build on the `hello` it sends",
    /action: 'hello',[\s\S]{0,1400}?build: OWN_BUILD/.test(mcpSrc)
  );
  check(
    'mcp.ts stamps the staleness answer with the process that answered it',
    /servingProcess: serving/.test(mcpSrc) && /describeOwnBuild\(\)/.test(mcpSrc)
  );
  check(
    // `build[,)]` rather than `build)`: KAN-319 added a FOURTH argument — the
    // client's measured channel reach — so the literal call shape moved while
    // this assertion's claim did not. What is asserted is what KAN-526 cares
    // about and all it ever cared about: the announced build is parsed, and it
    // is handed to `register` as the third positional argument. A refactor that
    // dropped it, reordered it, or passed something else there still fails.
    'daemon.ts parses the announced build and stores it on the connection',
    /buildFromAnnouncement\(msg\)/.test(daemonSrc) &&
      /agentConnections\.register\(socket, address, build[,)]/.test(daemonSrc)
  );
  check(
    'daemon.ts gives the staleness report a live view of connected servers',
    /servers: \(\) => agentConnections\.servingProcesses\(\)/.test(daemonSrc)
  );
  check(
    'daemon.ts says after a restart what the restart did not reach',
    /deploy reach:/.test(daemonSrc) && /RECONNECT_SETTLE_MS/.test(daemonSrc)
  );
  check(
    'the router carries the supplier through to the report',
    /servers\?: \(\) => ServingProcess\[\]/.test(routerSrc)
  );
}

if (staticOnly) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    failures.length
      ? `\n${failures.length} of ${checks} FAILED: ${failures.join(', ')}`
      : `\nALL PASS (${checks} checks, static only)`
  );
  process.exit(failures.length ? 1 : 0);
}

if (!fs.existsSync(path.join(distDir, 'mcp.js'))) {
  // A setup guard, not a verdict: there is nothing to judge, so this says so
  // rather than reporting a green over an absent build.
  console.error(`\nSETUP: ${distDir}/mcp.js is missing. Run \`cd daemon && npm run build\` first.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}

const { buildFromAnnouncement, classifyServerBuild, newestMtimeMs, BUILD_SKEW_TOLERANCE_MS } =
  await import('../dist/mcp-build.js');
const { AgentConnectionRegistry, addressFromAnnouncement } = await import(
  '../dist/agent-connections.js'
);
const { getStalenessReport, resetStalenessCache } = await import('../dist/staleness.js');

// --- A. the announcement, from a real server process ------------------------
//
// THE LEG THAT STOPS THIS BEING A PROOF ABOUT ITS OWN FIXTURES. Everything in
// section B is fed announcements this script wrote, and a check whose input it
// supplies has not tested that the input arrives — the KAN-145 defect. So this
// starts the real `dist/mcp.js`, with HOME pointed at a temp directory holding
// a stub socket, and reads what the process actually says. Nothing here is
// mocked except the daemon on the far end of the socket.

console.log('\n--- A. announcement (live: spawns dist/mcp.js) ---');

const fakeHome = path.join(tmp, 'home');
const socketPath = path.join(fakeHome, '.local/share/butchr/butchr.sock');
fs.mkdirSync(path.dirname(socketPath), { recursive: true });

const announced = await new Promise((resolve) => {
  let settled = false;
  const done = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const msg = JSON.parse(line);
          if (msg?.action === 'hello') done(msg);
        } catch {
          // not our line
        }
      }
    });
    socket.on('error', () => {});
  });
  cleanup.push(() => server.close());
  server.listen(socketPath, () => {
    const child = spawn(
      process.execPath,
      [path.join(distDir, 'mcp.js'), '--workspace-type', 'task', '--workspace-key', 'KAN-526-PROBE'],
      { env: { ...process.env, HOME: fakeHome }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    child.on('error', () => done(null));
    cleanup.push(() => child.kill('SIGKILL'));
  });

  setTimeout(() => done(null), 15_000).unref();
});

check('a real dist/mcp.js announced itself', announced !== null);

const liveAddress = announced ? addressFromAnnouncement(announced) : null;
const liveBuild = announced ? buildFromAnnouncement(announced) : null;

check(
  'the announcement still carries the identity it always did',
  liveAddress?.type === 'task' && liveAddress?.key === 'KAN-526-PROBE',
  JSON.stringify(liveAddress)
);
check('the announcement carries a build block this daemon can parse', liveBuild !== null);
check(
  'the build names the dist tree the process was loaded from',
  liveBuild !== null && path.resolve(liveBuild.distDir) === path.resolve(distDir),
  liveBuild?.distDir
);
check(
  'the build stamp matches that tree, rather than being a clock reading',
  liveBuild?.loadedBuildAt != null &&
    Math.abs(Date.parse(liveBuild.loadedBuildAt) - (newestMtimeMs(distDir) ?? 0)) < 1000,
  `announced ${liveBuild?.loadedBuildAt}, tree ${new Date(newestMtimeMs(distDir) ?? 0).toISOString()}`
);
check(
  'a real server just started reads as current against the tree it loaded',
  liveBuild !== null &&
    classifyServerBuild(liveBuild, distDir, newestMtimeMs(distDir), BUILD_SKEW_TOLERANCE_MS).kind ===
      'current'
);

for (const fn of cleanup.splice(0)) {
  try {
    fn();
  } catch {
    // best effort
  }
}

// --- B. the verdict ---------------------------------------------------------
//
// A temp repo root holding a `daemon/dist` whose mtime this script controls, so
// "the deploy happened after this server started" is a fact about the fixture
// rather than something to wait for. The registry and the report are the real
// ones: an announcement goes in as a wire message and comes out as an item.

console.log('\n--- B. verdict (imports dist/) ---');

const fixtureRoot = path.join(tmp, 'repo');
const fixtureDist = path.join(fixtureRoot, 'daemon/dist');
fs.mkdirSync(fixtureDist, { recursive: true });
fs.writeFileSync(path.join(fixtureDist, 'daemon.js'), '// deployed build\n');
const DEPLOYED_AT = Date.now();
fs.utimesSync(path.join(fixtureDist, 'daemon.js'), DEPLOYED_AT / 1000, DEPLOYED_AT / 1000);

/** One `hello` off the wire, as `mcp.ts` would send it. */
function helloFrom({ type, key, pid, startedAt, loadedBuildAt, distDir: dir }) {
  return {
    action: 'hello',
    workspaceType: type,
    workspaceKey: key,
    build: { pid, startedAt, loadedBuildAt, distDir: dir }
  };
}

/** Feed announcements through a real registry and report on the fixture. */
function itemFor(messages, { withView = true } = {}) {
  const registry = new AgentConnectionRegistry();
  for (const msg of messages) {
    const socket = new net.Socket();
    registry.register(socket, addressFromAnnouncement(msg), buildFromAnnouncement(msg));
  }
  resetStalenessCache();
  const report = getStalenessReport({
    repoRoot: fixtureRoot,
    ...(withView ? { servers: () => registry.servingProcesses() } : {}),
    force: true
  });
  return { item: report.items.find((i) => i.id === 'mcp-servers'), report };
}

const currentServer = helloFrom({
  type: 'task',
  key: 'KAN-1',
  pid: 111,
  startedAt: new Date(DEPLOYED_AT).toISOString(),
  loadedBuildAt: new Date(DEPLOYED_AT).toISOString(),
  distDir: fixtureDist
});
const staleServer = helloFrom({
  type: 'epic',
  key: 'KAN-39',
  pid: 222,
  startedAt: new Date(DEPLOYED_AT - 3 * 3600_000).toISOString(),
  loadedBuildAt: new Date(DEPLOYED_AT - 3 * 3600_000).toISOString(),
  distDir: fixtureDist
});
const otherTreeServer = helloFrom({
  type: 'task',
  key: 'KAN-2',
  pid: 333,
  startedAt: new Date(DEPLOYED_AT - 3 * 3600_000).toISOString(),
  loadedBuildAt: new Date(DEPLOYED_AT - 3 * 3600_000).toISOString(),
  distDir: path.join(tmp, 'somebody-elses-worktree/daemon/dist')
});
const unstampedServer = {
  action: 'hello',
  workspaceType: 'story',
  workspaceKey: 'KAN-150'
};

{
  const { item } = itemFor([currentServer]);
  check('the report carries an mcp-servers item at all', item !== undefined);
  check('a server that loaded the deployed build is fresh', item?.state === 'fresh', item?.headline);
}

{
  // THE RED. This is the case the check exists for, and the one to break
  // deliberately before trusting it: an agent serving its own calls out of a
  // build three hours older than the deploy.
  const { item } = itemFor([currentServer, staleServer]);
  check('a server older than the deployed build is STALE', item?.state === 'stale', item?.headline);
  check(
    'the stale item names the agent that is behind, with the age it is behind by',
    /epic\/KAN-39 \(pid 222, up since [^)]+\) loaded a build \S+ older than daemon\/dist/.test(
      item?.detail ?? ''
    ),
    item?.detail?.slice(0, 120)
  );
  check(
    'the stale item does not offer a remedy that would kill an agent',
    /costs that agent its session/.test(item?.remedy ?? '') && !/pkill|restart the agent/i.test(item?.remedy ?? ''),
    item?.remedy?.slice(0, 60)
  );
  check(
    'a stale server makes the whole report stale, so a caller cannot skim past it',
    itemFor([currentServer, staleServer]).report.stale === true
  );
}

{
  const { item } = itemFor([unstampedServer]);
  check(
    'a server announcing no build is stale, not unknown',
    item?.state === 'stale',
    item?.headline
  );
  check(
    'and the reason given is that it cannot be running the current build',
    /predates KAN-526/.test(item?.detail ?? '')
  );
}

{
  const { item } = itemFor([]);
  check(
    'no connected servers is unknown, never fresh',
    item?.state === 'unknown',
    item?.headline
  );
  check(
    'and it says so as a claim about what can be seen from here',
    /not about the fleet/.test(item?.detail ?? '')
  );
}

{
  const { item } = itemFor([currentServer], { withView: false });
  check(
    'a report built without a connection view is unknown, never fresh',
    item?.state === 'unknown',
    item?.headline
  );
}

{
  const { item } = itemFor([otherTreeServer]);
  check(
    'a server loaded from another tree is not a false red',
    item?.state === 'unknown',
    item?.headline
  );
}

{
  // The relation is a union so that a case added without a branch fails to
  // compile; this asserts the five kinds are actually reachable rather than
  // trusting the type to imply it.
  const kinds = new Set(
    [
      classifyServerBuild(buildFromAnnouncement(currentServer), fixtureDist, DEPLOYED_AT, BUILD_SKEW_TOLERANCE_MS),
      classifyServerBuild(buildFromAnnouncement(staleServer), fixtureDist, DEPLOYED_AT, BUILD_SKEW_TOLERANCE_MS),
      classifyServerBuild(buildFromAnnouncement(otherTreeServer), fixtureDist, DEPLOYED_AT, BUILD_SKEW_TOLERANCE_MS),
      classifyServerBuild(null, fixtureDist, DEPLOYED_AT, BUILD_SKEW_TOLERANCE_MS),
      classifyServerBuild(
        { pid: 1, startedAt: 'x', loadedBuildAt: null, distDir: fixtureDist },
        fixtureDist,
        DEPLOYED_AT,
        BUILD_SKEW_TOLERANCE_MS
      )
    ].map((r) => r.kind)
  );
  check(
    'every relation kind is reachable',
    ['current', 'older', 'other-tree', 'unstamped', 'unreadable'].every((k) => kinds.has(k)),
    [...kinds].join(', ')
  );
}

for (const fn of cleanup.splice(0)) {
  try {
    fn();
  } catch {
    // best effort
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length
    ? `\n${failures.length} of ${checks} FAILED: ${failures.join(', ')}`
    : `\nALL PASS (${checks} checks)`
);
process.exit(failures.length ? 1 : 0);
