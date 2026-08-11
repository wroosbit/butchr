// Proof for KAN-259 and KAN-261: reclaiming `node_modules` from workspaces
// nobody is working in leaves every LIVE workspace untouched; the exclusion that
// makes that true is derived from the running fleet rather than from a list; and
// standing an agent down fires the reclaim by itself.
//
// WHAT FAILURE THIS WOULD CATCH: a reclaim sweep that deletes a live agent's
// dependencies out from under it while it is building. That is the 2026-08-04
// manual pass's one hazard, automated — that pass excluded its five running
// workspaces **by hand**, and a hand-written exclusion is stale the moment the
// fleet changes. Also caught: a sweep that follows a `node_modules` symlink into
// a shared store and empties it for every workspace at once (the shape KAN-262
// went on to create as hard links instead), a sweep that deletes a
// `node_modules` git does *not* ignore and so destroys tracked work, a
// containment check that a traversal or a symlinked workspace can walk out of,
// and a "dry run" that deletes.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// AND, ADDED BY KAN-261: a stand-down that reclaims nothing, so the cleanup goes
// back to happening only when somebody remembers; a stand-down that reclaims the
// wrong workspace, or one somebody is still working in; a **preempted** agent
// charged a reinstall for an interruption it did not choose; a reclaim failure
// that takes the stand-down down with it, so standing an agent down starts
// failing because of a disk operation nobody asked for; and a stand-down that
// shrinks a workspace and says nothing, which is the silent surprise this epic
// keeps deleting.
//
// Six sections:
//
//   1. the exclusion  — a real sweep, real deletions, over a fixture fleet:
//                       the live workspace keeps its tree, the stood-down one
//                       loses it
//   2. the refusals   — symlinked tree not followed and store intact;
//                       un-ignored tree refused; traversal refused
//   3. the dry run    — reports the same bytes and removes nothing, because a
//                       destructive default is the thing most worth not having
//   4. the wiring     — the REAL MessageRouter, the REAL `reclaim_sweep`
//                       action: the excluded set comes out of the fleet census
//                       `list_agents` is built from, not out of an argument
//   5. the trigger    — the REAL `deactivate_by_key` action: a stand-down
//                       reclaims its own workspace and a hard-linked store
//                       survives it; a workspace something is still live in is
//                       refused; a preemption reclaims nothing; and the report
//                       reaches both the response and the broadcast
//   6. can it fail    — three patched builds. Section 1 re-run with the
//                       live-agent exclusion patched out, section 5 re-run with
//                       the stand-down trigger patched out, and section 5 re-run
//                       with the reclaimer patched to throw
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED:
// sections 1-3 build their own fleet on disk and hand `sweepWorkspaces` their
// own `liveWorkDirs`. A sweep that excludes correctly from a list a test wrote
// has NOT been shown to receive the real one — that is precisely how KAN-145's
// two scripts stayed green while `activatedBy` was null for every agent in
// production. Section 4 is what closes it on this side: it drives the real
// router's real action and asserts the exclusion is derived from the census,
// with nothing passing `liveWorkDirs` in.
//
// What sections 4 and 5 still do NOT cover, and section 5 depends on it harder:
// their census comes from a stub `AgentRuntime`, so "herdr really reports the
// running fleet" is assumed here. Section 5 assumes one thing more — that once
// `terminateSession` returns success, herdr's next census no longer lists the
// agent. Its stub removes the pane synchronously, and if the real herdr lags
// there then every real stand-down would refuse its own reclaim as "still live"
// while this section stayed green. **Nothing in this file can catch that**, and
// it is the one assumption on which the whole trigger rests.
//
// WHO COVERS IT: observation of the running system, pasted into KAN-261's pull
// request — a real agent stood down on the live fleet, its workspace measured
// either side, and the daemon's own `[reclaim]` log lines showing which branch
// it took. That is also where AC1 lives, and AC1 is the criterion neither this
// script nor KAN-259's could ever reach: that a reclaimed workspace still
// **resumes the conversation it was stopped in**. Nothing here reactivates
// anything, and this script does not imply it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.join(daemonDir, 'dist');

if (!fs.existsSync(path.join(distDir, 'reclaim.js'))) {
  // A setup guard, not a verdict: there is nothing to test yet.
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}

let failures = 0;
const fail = (section, message) => {
  failures += 1;
  console.log(`   ✗ [${section}] ${message}`);
};
const pass = (section, message) => console.log(`   ✓ [${section}] ${message}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan259-'));
const realHome = process.env.HOME;
const cleanup = [];
process.on('exit', () => {
  process.env.HOME = realHome;
  for (const fn of cleanup.reverse()) {
    try { fn(); } catch {}
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

console.log(`scratch: ${scratch}`);

// ---------------------------------------------------------------- fixtures --
//
// A fleet on disk that looks like the real one where it matters: each workspace
// holds a git worktree-shaped checkout with a real `.gitignore`, because the
// reclaimer asks git — per target, at the moment of deleting — whether the
// directory it is about to remove is ignored. A fixture that faked that would
// be testing around the safety check rather than through it.

function writeTree(dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
}

/** A workspace with a git checkout, a `node_modules`, and some source. */
function makeWorkspace(root, type, key, { ignoreNodeModules = true } = {}) {
  const workDir = path.join(root, type, key);
  const repo = path.join(workDir, 'butchr');
  fs.mkdirSync(repo, { recursive: true });

  writeTree(workDir, {
    '.butchr-prompt.md': '# brief\n',
    '.mcp.json': '{}\n',
    '.claude/settings.json': '{}\n'
  });
  writeTree(repo, {
    '.gitignore': ignoreNodeModules ? 'node_modules/\ndist/\n' : '# nothing ignored\n',
    'daemon/src/daemon.ts': 'export const real = true;\n',
    'daemon/dist/daemon.js': 'export const built = true;\n',
    'daemon/node_modules/left-pad/index.js': 'x'.repeat(4096),
    'daemon/node_modules/left-pad/package.json': '{"name":"left-pad"}\n',
    'extension/node_modules/react/index.js': 'y'.repeat(8192)
  });

  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo
  });

  return { workDir, repo };
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Every file under `dir`, so "untouched" can mean untouched rather than present. */
function inventory(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) { walk(full); continue; }
      out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

// ------------------------------------------------------- 1. the exclusion --

console.log('\n1. a live workspace keeps its dependencies; a stood-down one does not');

const { sweepWorkspaces, reclaimWorkspace, lastReclaimSummary } = await import(
  path.join(distDir, 'reclaim.js')
);

const fleetRoot = path.join(scratch, 'fleet', 'workspaces');
fs.mkdirSync(fleetRoot, { recursive: true });

const live = makeWorkspace(fleetRoot, 'task', 'kan-live');
const dead = makeWorkspace(fleetRoot, 'task', 'kan-dead');
const alsoDead = makeWorkspace(fleetRoot, 'story', 'kan-gone');

const liveBefore = inventory(live.workDir);

const sweep = sweepWorkspaces({
  root: fleetRoot,
  liveWorkDirs: [live.workDir],
  dryRun: false
});

const liveNodeModules = path.join(live.repo, 'daemon', 'node_modules');
const deadNodeModules = path.join(dead.repo, 'daemon', 'node_modules');

if (exists(liveNodeModules)) {
  pass(1, 'live workspace still has daemon/node_modules');
} else {
  fail(1, 'live workspace LOST daemon/node_modules — the exclusion did not hold');
}

const liveAfter = inventory(live.workDir);
if (JSON.stringify(liveBefore) === JSON.stringify(liveAfter)) {
  pass(1, `live workspace byte-for-byte unchanged (${liveAfter.length} files)`);
} else {
  fail(1, `live workspace changed: ${liveBefore.length} files before, ${liveAfter.length} after`);
}

if (!exists(deadNodeModules)) {
  pass(1, 'stood-down workspace lost daemon/node_modules');
} else {
  fail(1, 'stood-down workspace kept daemon/node_modules — nothing was reclaimed');
}

// The thing that must survive a reclaim, checked rather than assumed.
const survivors = ['.butchr-prompt.md', '.mcp.json', '.claude/settings.json'];
for (const rel of survivors) {
  if (exists(path.join(dead.workDir, rel))) pass(1, `reclaimed workspace kept ${rel}`);
  else fail(1, `reclaimed workspace LOST ${rel}`);
}
for (const rel of ['butchr/daemon/src/daemon.ts', 'butchr/.git/HEAD', 'butchr/daemon/dist/daemon.js']) {
  if (exists(path.join(dead.workDir, rel))) pass(1, `reclaimed workspace kept ${rel}`);
  else fail(1, `reclaimed workspace LOST ${rel}`);
}

if (exists(dead.workDir)) pass(1, 'the workspace directory itself still exists');
else fail(1, 'the workspace DIRECTORY was deleted — worktree registrations would be stale');

const excludedKeys = sweep.excluded.map((e) => e.workspace);
if (excludedKeys.includes('task/kan-live')) {
  pass(1, `sweep reported it: excluded = ${JSON.stringify(excludedKeys)}`);
} else {
  fail(1, `sweep did not report the live workspace as excluded (got ${JSON.stringify(excludedKeys)})`);
}

// Two stood-down workspaces, two `node_modules` each.
if (sweep.directories === 4) pass(1, `removed 4 node_modules across 2 workspaces`);
else fail(1, `expected 4 directories removed, got ${sweep.directories}`);

if (sweep.bytes > 0) pass(1, `reported ${sweep.bytes} bytes reclaimed`);
else fail(1, 'reported zero bytes — a reclaim that recovers nothing is not a reclaim');

const summary = lastReclaimSummary();
if (summary && summary.directories === 4 && /reclaimed from 2 workspaces/.test(summary.headline)) {
  pass(1, `summary recorded for list_agents: "${summary.headline}"`);
} else {
  fail(1, `summary not recorded correctly: ${JSON.stringify(summary)}`);
}

void alsoDead;

// -------------------------------------------------------- 2. the refusals --

console.log('\n2. the shapes it must refuse');

const refuseRoot = path.join(scratch, 'refuse', 'workspaces');
fs.mkdirSync(refuseRoot, { recursive: true });

// (a) a `node_modules` that is a symlink into a shared store — KAN-262's shape.
const store = path.join(scratch, 'shared-store');
writeTree(store, { 'react/index.js': 'shared'.repeat(100) });
const linked = makeWorkspace(refuseRoot, 'task', 'kan-linked');
const linkedNm = path.join(linked.repo, 'extension', 'node_modules');
fs.rmSync(linkedNm, { recursive: true, force: true });
fs.symlinkSync(store, linkedNm);

// (b) a checkout whose branch does NOT ignore node_modules.
const tracked = makeWorkspace(refuseRoot, 'task', 'kan-tracked', { ignoreNodeModules: false });

const storeBefore = inventory(store);
const refuseSweep = sweepWorkspaces({ root: refuseRoot, liveWorkDirs: [], dryRun: false });

if (exists(path.join(store, 'react', 'index.js')) &&
    JSON.stringify(inventory(store)) === JSON.stringify(storeBefore)) {
  pass(2, 'shared store behind a symlinked node_modules is intact');
} else {
  fail(2, 'the shared store was emptied through the symlink');
}
if (exists(linkedNm)) pass(2, 'the symlink itself was left in place');
else fail(2, 'the symlink was removed — rewiring a workspace is not this sweep to do');

const symlinkSkip = refuseSweep.skipped.find((s) => s.path === linkedNm);
if (symlinkSkip && /symlink/.test(symlinkSkip.reason)) {
  pass(2, `reported: ${symlinkSkip.reason}`);
} else {
  fail(2, 'the symlinked tree was not reported as skipped');
}

const trackedNm = path.join(tracked.repo, 'daemon', 'node_modules');
if (exists(trackedNm)) {
  pass(2, 'node_modules git does not ignore was NOT deleted');
} else {
  fail(2, 'deleted a node_modules git does not ignore — that can destroy tracked work');
}
const trackedSkip = refuseSweep.skipped.find((s) => s.path === trackedNm);
if (trackedSkip && /does not ignore it/.test(trackedSkip.reason)) {
  pass(2, `reported: ${trackedSkip.reason}`);
} else {
  fail(2, `the un-ignored tree was not reported with the right reason: ${trackedSkip?.reason}`);
}

// (b2) The third outcome, which is NOT the same as (b): a checkout-shaped
// directory with a `.gitignore` and no `.git` at all. `task/kan-96/prefix` on
// this machine is exactly this, holding 115M. Nothing can be tracked by a
// repository that is not there, so this one is reclaimed — and an earlier
// revision refused it while reporting the (b) sentence, which was untrue of it.
const norepoRoot = path.join(scratch, 'norepo', 'workspaces');
const norepoWs = path.join(norepoRoot, 'task', 'kan-norepo');
writeTree(norepoWs, {
  'prefix/.gitignore': 'node_modules/\n',
  'prefix/node_modules/left-pad/index.js': 'x'.repeat(2048)
});
const norepoNm = path.join(norepoWs, 'prefix', 'node_modules');
const norepoSweep = sweepWorkspaces({ root: norepoRoot, liveWorkDirs: [], dryRun: false });

if (!exists(norepoNm)) {
  pass(2, 'node_modules outside any git work tree WAS reclaimed');
} else {
  const why = norepoSweep.skipped.find((s) => s.path === norepoNm)?.reason;
  fail(2, `refused a tree no repository could be tracking: ${why}`);
}
if (!norepoSweep.skipped.some((s) => /does not ignore it/.test(s.reason))) {
  pass(2, 'and it was not described as "a worktree that does not ignore it"');
} else {
  fail(2, 'reported a worktree sentence about a directory with no worktree');
}

// (c) containment: a workspace path outside the root is refused by name.
const outside = path.join(scratch, 'not-a-workspace');
writeTree(outside, { 'node_modules/x/index.js': 'z' });
const escaped = reclaimWorkspace(outside, { root: refuseRoot, dryRun: false });
if (escaped.removed.length === 0 && escaped.skipped.some((s) => /not inside/.test(s.reason))) {
  pass(2, 'a workspace outside the root is refused lexically');
} else {
  fail(2, `a workspace outside the root was not refused: ${JSON.stringify(escaped)}`);
}
if (exists(path.join(outside, 'node_modules', 'x', 'index.js'))) {
  pass(2, 'and nothing outside the root was touched');
} else {
  fail(2, 'DELETED something outside the workspaces root');
}

// (d) a workspace that is a symlink pointing out of the root.
const decoyTarget = path.join(scratch, 'decoy');
writeTree(decoyTarget, { 'butchr/node_modules/y/index.js': 'z' });
const decoyLink = path.join(refuseRoot, 'task', 'kan-decoy');
fs.symlinkSync(decoyTarget, decoyLink);
sweepWorkspaces({ root: refuseRoot, liveWorkDirs: [], dryRun: false });
if (exists(path.join(decoyTarget, 'butchr', 'node_modules', 'y', 'index.js'))) {
  pass(2, 'a symlinked workspace cannot aim the delete outside the root');
} else {
  fail(2, 'followed a symlinked workspace out of the root and deleted through it');
}

// --------------------------------------------------------- 3. the dry run --

console.log('\n3. the default reports and does not delete');

const dryRoot = path.join(scratch, 'dry', 'workspaces');
fs.mkdirSync(dryRoot, { recursive: true });
const dryWs = makeWorkspace(dryRoot, 'task', 'kan-dry');
const dryBefore = inventory(dryWs.workDir);

// No `dryRun` at all — the default is the thing under test.
const dry = sweepWorkspaces({ root: dryRoot, liveWorkDirs: [] });

if (dry.dryRun === true) pass(3, 'omitting dryRun gives a dry run');
else fail(3, 'omitting dryRun DELETED — the default is destructive');

if (JSON.stringify(inventory(dryWs.workDir)) === JSON.stringify(dryBefore)) {
  pass(3, `workspace unchanged (${dryBefore.length} files)`);
} else {
  fail(3, 'the dry run modified the workspace');
}
if (dry.directories === 2 && dry.bytes > 0) {
  pass(3, `still reported what it would take: ${dry.directories} dirs, ${dry.bytes} bytes`);
} else {
  fail(3, `dry run reported nothing useful: ${dry.directories} dirs, ${dry.bytes} bytes`);
}

const wet = sweepWorkspaces({ root: dryRoot, liveWorkDirs: [], dryRun: false });
if (wet.bytes === dry.bytes && wet.directories === dry.directories) {
  pass(3, 'the real sweep took exactly what the dry run predicted');
} else {
  fail(3, `dry run predicted ${dry.bytes}B/${dry.directories} dirs, real sweep took ${wet.bytes}B/${wet.directories}`);
}

// ---------------------------------------------------------- 4. the wiring --
//
// The section that is not about the reclaimer at all: it is about whether the
// live set ARRIVES. Nothing below passes `liveWorkDirs` — the router has to
// derive it from the same census `list_agents` is built from, and the only way
// this section can pass is if it does.

console.log('\n4. the real router derives the exclusion from the fleet census');

const wiringHome = path.join(scratch, 'wiring-home');
const wiringRoot = path.join(wiringHome, '.local', 'share', 'butchr', 'workspaces');
fs.mkdirSync(wiringRoot, { recursive: true });
const wiredLive = makeWorkspace(wiringRoot, 'task', 'kan-wired');
const wiredDead = makeWorkspace(wiringRoot, 'task', 'kan-idle');

// `workspacesRoot()` reads `os.homedir()`, which honours $HOME on POSIX. This
// is the same relocation `lib/isolated-daemon.mjs` uses to give a real daemon a
// private workspace tree, and it is what lets the REAL handler — which takes no
// root, because production does not — run against a fixture.
process.env.HOME = wiringHome;

const { MessageRouter } = await import(path.join(distDir, 'router.js'));

/**
 * A stub `AgentRuntime` standing where herdr stands. It reports exactly one
 * running agent, in `task/kan-wired`. This is the seam KAN-223 built, used as
 * intended: everything downstream of it is unmodified product code.
 */
const stubRuntime = {
  listActiveSessions: () => [],
  listHerdrAgentsChecked: () => ({
    reachable: true,
    agents: [
      {
        name: 'butchr-task-kan-wired',
        workDir: wiredLive.workDir,
        herdrStatus: 'working',
        agentRuntime: 'claude'
      }
    ]
  }),
  listHerdrAgents() { return this.listHerdrAgentsChecked().agents; }
};

// Only what the two actions below actually reach for. A fuller registry would
// be inventing a world; these are the real `WorkspaceRegistry` methods the
// `list_agents` path calls, answering the way an empty install would.
const stubRegistry = {
  getAll: () => [],
  get: () => undefined,
  resolve: () => undefined,
  priorityFor: () => 1,
  integrations: () => [],
  disabledMatch: () => undefined,
  disabledIntegrationForType: () => undefined
};

const responses = [];
const router = new MessageRouter(
  stubRegistry,
  { load: () => '' },
  stubRuntime,
  (msg) => responses.push(msg)
);

router.handle({ action: 'reclaim_sweep', dryRun: true });

const wiring = responses.find((r) => r?.action === 'reclaim_sweep_response');
if (!wiring) {
  fail(4, `the router produced no reclaim_sweep_response (got ${JSON.stringify(responses.map(r => r?.action))})`);
} else if (wiring.success !== true) {
  fail(4, `the action failed: ${wiring.error}`);
} else {
  const excluded = (wiring.excluded ?? []).map((e) => e.workspace);
  if (excluded.includes('task/kan-wired')) {
    pass(4, `excluded the live workspace with nothing passing it in: ${JSON.stringify(excluded)}`);
  } else {
    fail(4, `the live workspace was NOT excluded — the census is not reaching the sweep (excluded ${JSON.stringify(excluded)})`);
  }

  const reclaimedKeys = (wiring.reclaimed ?? []).map((r) => r.workspace);
  if (reclaimedKeys.includes('task/kan-idle')) {
    pass(4, 'and the workspace with no agent was still a candidate');
  } else {
    fail(4, `the idle workspace was not a candidate (reclaimed ${JSON.stringify(reclaimedKeys)}) — an exclusion that excludes everything proves nothing`);
  }
}

// The summary has to reach the response the Agents page already polls.
responses.length = 0;
router.handle({ action: 'list_agents' });
const listed = responses.find((r) => r?.action === 'list_agents_response');
if (listed?.reclaim?.headline) {
  pass(4, `list_agents carries it: "${listed.reclaim.headline}"`);
} else {
  fail(4, 'list_agents did not carry the reclaim summary — the sweep would be silent');
}

process.env.HOME = realHome;
void wiredDead;

// --------------------------------------------------------- 5. the trigger --
//
// KAN-261's half. Nothing below calls the reclaimer: every case drives the REAL
// `deactivate_by_key` action on the REAL router and then looks at the disk. If
// the trigger is not wired, the workspace keeps its tree and this section is
// red — which is the whole point, since a sweep somebody has to invoke was the
// thing the human asked us to stop having.

console.log('\n5. standing an agent down reclaims its workspace, and only its own');

const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

const standHome = path.join(scratch, 'standdown-home');
const standRoot = path.join(standHome, '.local', 'share', 'butchr', 'workspaces');
fs.mkdirSync(standRoot, { recursive: true });

const stood = makeWorkspace(standRoot, 'task', 'kan-stood');
const bystander = makeWorkspace(standRoot, 'task', 'kan-bystander');
const preemptedWs = makeWorkspace(standRoot, 'task', 'kan-preempted');
const deadPane = makeWorkspace(standRoot, 'task', 'kan-dead-pane');

// A shared store, hard-linked into the workspace about to be stood down —
// KAN-262's shape as it actually landed. The store must survive the reclaim,
// and the way it survives is that a hard link is a NAME: removing one drops the
// link count and frees nothing while another name remains.
const standStore = path.join(scratch, 'standdown-store');
writeTree(standStore, {
  'react/index.js': 'shared'.repeat(2048),
  'react/package.json': '{"name":"react"}\n'
});
const storeFile = path.join(standStore, 'react', 'index.js');
const storeInventoryBefore = inventory(standStore);
const storeDigestBefore = md5(storeFile);

const stoodLinked = path.join(stood.repo, 'extension', 'node_modules');
fs.rmSync(stoodLinked, { recursive: true, force: true });
execFileSync('cp', ['-al', standStore, stoodLinked]);
const linksBefore = fs.statSync(storeFile).nlink;
if (linksBefore === 2) {
  pass(5, `the stood-down workspace's tree is hard-linked from the store (nlink=${linksBefore})`);
} else {
  fail(5, `fixture is not hard-linked — nlink=${linksBefore}, so "the store survives" would prove nothing`);
}

/** A pane as herdr reports one. */
const herdrPane = (type, key, workDir) => ({
  name: `butchr-${type}-${key}`,
  workDir,
  herdrStatus: 'working',
  agentRuntime: 'claude'
});

// `task/kan-ghost` is the guard's test case, and it is deliberately perverse: a
// session of its own, but recorded as living in the BYSTANDER's directory.
// Standing it down tears down its own pane and leaves another agent live in the
// directory the reclaim would target. An implementation that trusts its own
// `terminateSession` and deletes reclaims a working agent's dependencies; one
// that asks the census refuses. Nothing else in this file distinguishes them.
let running = [
  herdrPane('task', 'kan-stood', stood.workDir),
  herdrPane('task', 'kan-bystander', bystander.workDir),
  herdrPane('task', 'kan-preempted', preemptedWs.workDir),
  herdrPane('task', 'kan-ghost', bystander.workDir)
];

const standSessions = {
  'task/kan-stood': { sessionId: 's-stood', type: 'task', key: 'kan-stood', workDir: stood.workDir },
  'task/kan-preempted': {
    sessionId: 's-preempted', type: 'task', key: 'kan-preempted', workDir: preemptedWs.workDir
  },
  'task/kan-ghost': {
    // The workDir a stand-down would act on — the bystander's.
    sessionId: 's-ghost', type: 'task', key: 'kan-ghost', workDir: bystander.workDir
  }
};

const standRuntime = {
  listActiveSessions: () => [],
  listHerdrAgentsChecked: () => ({ reachable: true, agents: running.slice() }),
  listHerdrAgents() { return this.listHerdrAgentsChecked().agents; },
  getSessionByAddress: (key, type) => standSessions[`${type ?? 'task'}/${key}`],
  terminateSession: (sessionId) => {
    const entry = Object.values(standSessions).find((s) => s.sessionId === sessionId);
    if (!entry) return { success: false, error: `No session '${sessionId}'` };
    // The pane is gone once herdr has closed it, so the census stops reporting
    // it. See the header: this is the assumption section 5 cannot verify.
    running = running.filter((a) => a.name !== `butchr-${entry.type}-${entry.key}`);
    return { success: true };
  },
  // `task/kan-dead-pane` has no session and no pane: the agent already died.
  closeAgentByKey: (key) => ({ success: true, agentName: `butchr-task-${key}` })
};

// Only what these paths reach for. `kan-dead-pane` is the case where the
// stand-down has NO workDir in hand, so the registry is the only thing that
// still knows where the agent lived — an implementation that gives up there
// never reclaims from an agent that died, which is the commonest stand-down.
const standIntents = new Map([
  ['butchr-task-kan-dead-pane', {
    event: 'activated',
    at: '2026-08-11T00:00:00.000Z',
    record: {
      agentName: 'butchr-task-kan-dead-pane',
      type: 'task',
      key: 'kan-dead-pane',
      workDir: deadPane.workDir,
      activatedBy: null
    }
  }]
]);
const standRegistry = { intents: () => standIntents, recordDeactivated: () => {} };

const bystanderBefore = inventory(bystander.workDir);
const preemptedBefore = inventory(preemptedWs.workDir);

/** Drive one real stand-down and hand back its response and its broadcast. */
function standDown(router, responses, broadcasts, message) {
  responses.length = 0;
  broadcasts.length = 0;
  router.handle({ action: 'deactivate_by_key', ...message });
  return {
    response: responses.find((r) => r?.action === 'deactivate_response'),
    event: broadcasts.find((b) => b?.action === 'agent_deactivated_event')
  };
}

// `reclaimWorkspace` resolves the workspaces root from $HOME, exactly as
// section 4's handler does, so the real code runs against the fixture fleet.
process.env.HOME = standHome;

const standResponses = [];
const standBroadcasts = [];
const standRouter = new MessageRouter(
  stubRegistry,
  { load: () => '' },
  standRuntime,
  (msg) => standResponses.push(msg),
  (msg) => standBroadcasts.push(msg),
  { agentRegistry: standRegistry }
);

// (a) the ordinary case: a voluntary stand-down.
const stoodResult = standDown(standRouter, standResponses, standBroadcasts, {
  type: 'task',
  key: 'kan-stood'
});

if (stoodResult.response?.success === true) {
  pass(5, 'the stand-down itself succeeded');
} else {
  fail(5, `the stand-down failed: ${JSON.stringify(stoodResult.response)}`);
}

const stoodNm = path.join(stood.repo, 'daemon', 'node_modules');
if (!exists(stoodNm)) {
  pass(5, 'the stood-down workspace lost daemon/node_modules with nobody invoking a sweep');
} else {
  fail(5, 'the stood-down workspace KEPT its dependencies — the trigger is not wired');
}
if (!exists(stoodLinked)) {
  pass(5, 'and lost its hard-linked extension/node_modules');
} else {
  fail(5, 'the hard-linked tree was left behind');
}

for (const rel of ['.butchr-prompt.md', '.claude/settings.json', 'butchr/.git/HEAD', 'butchr/daemon/src/daemon.ts']) {
  if (exists(path.join(stood.workDir, rel))) pass(5, `reclaimed workspace kept ${rel}`);
  else fail(5, `reclaimed workspace LOST ${rel} — resuming needs it`);
}

// The store, which is the thing a reclaim must never reach into.
if (exists(storeFile) && md5(storeFile) === storeDigestBefore) {
  pass(5, 'the shared store still holds its file, byte-for-byte (md5 unchanged)');
} else {
  fail(5, 'the shared store was damaged by a stand-down reclaim');
}
if (JSON.stringify(inventory(standStore)) === JSON.stringify(storeInventoryBefore)) {
  pass(5, `the store is complete (${storeInventoryBefore.length} files)`);
} else {
  fail(5, 'files went missing from the store');
}
const linksAfter = fs.statSync(storeFile).nlink;
if (linksAfter === linksBefore - 1) {
  pass(5, `and the link count decremented rather than the file vanishing (${linksBefore} → ${linksAfter})`);
} else {
  fail(5, `link count went ${linksBefore} → ${linksAfter}, expected ${linksBefore - 1}`);
}

// Reported — in both places, because a stand-down that silently shrank a
// workspace is the surprise this epic keeps deleting.
const stoodReclaim = stoodResult.response?.reclaim;
if (stoodReclaim?.status === 'reclaimed' && stoodReclaim.paths?.length === 2) {
  pass(5, `the response says what it took: "${stoodReclaim.headline}"`);
} else {
  fail(5, `the response did not report the reclaim: ${JSON.stringify(stoodReclaim)}`);
}
if (stoodReclaim?.paths?.every((p) => p.startsWith(stood.workDir))) {
  pass(5, 'and every path it named is inside the workspace it stood down');
} else {
  fail(5, `it named a path outside the stood-down workspace: ${JSON.stringify(stoodReclaim?.paths)}`);
}
if (stoodResult.event?.reclaim?.status === 'reclaimed') {
  pass(5, 'the agent_deactivated_event broadcast carries it too');
} else {
  fail(5, `the broadcast did not carry the reclaim: ${JSON.stringify(stoodResult.event)}`);
}

// (b) the bystander — a live agent, untouched by somebody else's stand-down.
if (JSON.stringify(inventory(bystander.workDir)) === JSON.stringify(bystanderBefore)) {
  pass(5, `the live agent's workspace is byte-for-byte unchanged (${bystanderBefore.length} files)`);
} else {
  fail(5, "a live agent's workspace changed while another agent was stood down");
}

// (c) the guard itself: a stand-down whose target directory still has somebody
// live in it. Only the census can tell, and refusing is the only safe answer.
const ghostResult = standDown(standRouter, standResponses, standBroadcasts, {
  type: 'task',
  key: 'kan-ghost'
});
const ghostReclaim = ghostResult.response?.reclaim;
if (ghostReclaim?.status === 'skipped' && /still live/.test(ghostReclaim.reason ?? '')) {
  pass(5, `refused a workspace something is still live in: "${ghostReclaim.reason}"`);
} else {
  fail(5, `did NOT refuse a workspace with a live agent in it: ${JSON.stringify(ghostReclaim)}`);
}
if (ghostResult.response?.success === true) {
  pass(5, 'and the stand-down still succeeded — the reclaim is a side effect, not the job');
} else {
  fail(5, `refusing the reclaim failed the stand-down: ${JSON.stringify(ghostResult.response)}`);
}
if (exists(path.join(bystander.repo, 'daemon', 'node_modules'))) {
  pass(5, 'the live agent still has its dependencies');
} else {
  fail(5, "DELETED a live agent's dependencies — the exact failure this story guards");
}

// (d) preemption: an interruption, not a finish. The agent is expected back.
const preemptResult = standDown(standRouter, standResponses, standBroadcasts, {
  type: 'task',
  key: 'kan-preempted',
  preemption: {
    priority: 1,
    byAgentName: 'butchr-story-kan-151',
    byType: 'story',
    byKey: 'KAN-151',
    byPriority: 5,
    herdrStatus: 'working',
    derivation: 'fixture'
  }
});
const preemptReclaim = preemptResult.response?.reclaim;
if (preemptReclaim?.status === 'skipped' && /preemption/.test(preemptReclaim.reason ?? '')) {
  pass(5, `a preempted stand-down reclaims nothing: "${preemptReclaim.reason}"`);
} else {
  fail(5, `a preempted stand-down was not refused: ${JSON.stringify(preemptReclaim)}`);
}
if (JSON.stringify(inventory(preemptedWs.workDir)) === JSON.stringify(preemptedBefore)) {
  pass(5, `and the preempted workspace is byte-for-byte unchanged (${preemptedBefore.length} files)`);
} else {
  fail(5, 'a preempted agent lost its dependencies — it is expected back, usually within the hour');
}
if (preemptResult.response?.preempted === true) {
  pass(5, 'the response still marks it preempted');
} else {
  fail(5, 'the preemption record did not survive to the response');
}

// (e) the agent that had already died: no session, so no workDir in hand.
const deadResult = standDown(standRouter, standResponses, standBroadcasts, {
  type: 'task',
  key: 'kan-dead-pane'
});
if (deadResult.response?.reclaim?.status === 'reclaimed') {
  pass(5, `an already-dead agent's workspace is reclaimed off the registry: "${deadResult.response.reclaim.headline}"`);
} else {
  fail(5, `no workDir was recovered for a dead agent: ${JSON.stringify(deadResult.response?.reclaim)}`);
}
if (!exists(path.join(deadPane.repo, 'daemon', 'node_modules'))) {
  pass(5, 'and its dependencies are gone');
} else {
  fail(5, 'the dead agent kept its dependencies');
}

process.env.HOME = realHome;

// -------------------------------------------------------- 6. can it fail? --
//
// Three patched builds, because three of the assertions above are worth exactly
// nothing unless the thing they assert about can be taken away.

console.log('\n6a. with the live-agent exclusion removed, section 1 must break');

const guardlessDist = path.join(daemonDir, `dist-guardless-${process.pid}`);
fs.cpSync(distDir, guardlessDist, { recursive: true });
cleanup.push(() => fs.rmSync(guardlessDist, { recursive: true, force: true }));

const guardlessFile = path.join(guardlessDist, 'reclaim.js');
let guardlessSource = fs.readFileSync(guardlessFile, 'utf8');
const NEEDLE = 'if (live.has(resolved)) {';
const hits = guardlessSource.split(NEEDLE).length - 1;
guardlessSource = guardlessSource.split(NEEDLE).join('if (false) {');
fs.writeFileSync(guardlessFile, guardlessSource);

if (hits === 1) {
  pass('6a', `patched the exclusion out (\`${NEEDLE}\` matched exactly once)`);
} else {
  fail('6a', `expected to patch the exclusion exactly once, matched ${hits} times — this section is not testing what it claims`);
}

const { sweepWorkspaces: guardlessSweep } = await import(guardlessFile);

const brokenRoot = path.join(scratch, 'broken', 'workspaces');
fs.mkdirSync(brokenRoot, { recursive: true });
const brokenLive = makeWorkspace(brokenRoot, 'task', 'kan-live');
makeWorkspace(brokenRoot, 'task', 'kan-dead');

const brokenSweep = guardlessSweep({
  root: brokenRoot,
  liveWorkDirs: [brokenLive.workDir], // same input as section 1
  dryRun: false
});

const brokenLiveNm = path.join(brokenLive.repo, 'daemon', 'node_modules');
if (!exists(brokenLiveNm)) {
  pass('6a', "the live workspace lost its tree, so section 1's assertion can fail");
} else {
  fail('6a', 'the live workspace SURVIVED with the exclusion removed — section 1 proves nothing');
}
if (brokenSweep.excluded.length === 0) {
  pass('6a', 'and nothing was reported excluded, as the patched build should');
} else {
  fail('6a', `the patched build still excluded ${brokenSweep.excluded.length} workspaces`);
}

// -----------------------------------------------------------------------------
//
// 6b and 6c both re-run section 5(a) — one real stand-down through a real
// router — against a patched build, so they share their fixture. A stand-down
// is a one-shot thing on a given workspace, so each gets its own fleet.

/**
 * Stand one agent down through a patched `router.js`, and report what the
 * workspace and the response looked like afterwards.
 *
 * Everything about this is section 5(a) except which `dist` it imports from,
 * which is the only way to be sure that is the difference being measured.
 */
async function standDownAgainst(distPath, label) {
  const home = path.join(scratch, `patched-home-${label}`);
  const root = path.join(home, '.local', 'share', 'butchr', 'workspaces');
  fs.mkdirSync(root, { recursive: true });
  const ws = makeWorkspace(root, 'task', 'kan-patched');

  const session = { sessionId: 's-patched', type: 'task', key: 'kan-patched', workDir: ws.workDir };
  let panes = [herdrPane('task', 'kan-patched', ws.workDir)];
  const runtime = {
    listActiveSessions: () => [],
    listHerdrAgentsChecked: () => ({ reachable: true, agents: panes.slice() }),
    listHerdrAgents() { return this.listHerdrAgentsChecked().agents; },
    getSessionByAddress: () => session,
    terminateSession: () => { panes = []; return { success: true }; },
    closeAgentByKey: () => ({ success: false })
  };

  const { MessageRouter: PatchedRouter } = await import(path.join(distPath, 'router.js'));
  const responses = [];
  const broadcasts = [];
  const router = new PatchedRouter(
    stubRegistry,
    { load: () => '' },
    runtime,
    (msg) => responses.push(msg),
    (msg) => broadcasts.push(msg),
    { agentRegistry: { intents: () => new Map(), recordDeactivated: () => {} } }
  );

  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    router.handle({ action: 'deactivate_by_key', type: 'task', key: 'kan-patched' });
  } finally {
    process.env.HOME = priorHome;
  }

  return {
    response: responses.find((r) => r?.action === 'deactivate_response'),
    nodeModules: path.join(ws.repo, 'daemon', 'node_modules')
  };
}

console.log('\n6b. with the stand-down trigger removed, section 5 must break');

const triggerlessDist = path.join(daemonDir, `dist-triggerless-${process.pid}`);
fs.cpSync(distDir, triggerlessDist, { recursive: true });
cleanup.push(() => fs.rmSync(triggerlessDist, { recursive: true, force: true }));

const triggerFile = path.join(triggerlessDist, 'router.js');
let triggerSource = fs.readFileSync(triggerFile, 'utf8');
// The method keeps its signature and its shape and stops doing the one thing it
// is for. Patching the call sites instead would need three edits and would
// leave `reclaim` absent rather than inert, which is a weaker "removed".
const TRIGGER_NEEDLE = 'reclaimForStandDown(args) {';
const triggerHits = triggerSource.split(TRIGGER_NEEDLE).length - 1;
triggerSource = triggerSource.split(TRIGGER_NEEDLE).join(
  `${TRIGGER_NEEDLE} return { status: 'skipped', paths: [], bytes: 0, headline: 'patched out', reason: 'patched out' };`
);
fs.writeFileSync(triggerFile, triggerSource);

if (triggerHits === 1) {
  pass('6b', `patched the trigger out (\`${TRIGGER_NEEDLE}\` matched exactly once)`);
} else {
  fail('6b', `expected to patch the trigger exactly once, matched ${triggerHits} times — this section is not testing what it claims`);
}

const triggerless = await standDownAgainst(triggerlessDist, 'triggerless');
if (exists(triggerless.nodeModules)) {
  pass('6b', "the workspace kept its dependencies, so section 5's assertion can fail");
} else {
  fail('6b', 'the workspace was reclaimed even with the trigger patched out — section 5 proves nothing');
}
if (triggerless.response?.success === true) {
  pass('6b', 'and the stand-down still succeeded, so section 5 is measuring the reclaim and not the stand-down');
} else {
  fail('6b', `the patched build broke the stand-down itself: ${JSON.stringify(triggerless.response)}`);
}

console.log('\n6c. with the reclaimer throwing, the stand-down must still succeed');

const throwingDist = path.join(daemonDir, `dist-throwing-${process.pid}`);
fs.cpSync(distDir, throwingDist, { recursive: true });
cleanup.push(() => fs.rmSync(throwingDist, { recursive: true, force: true }));

const throwingFile = path.join(throwingDist, 'reclaim.js');
let throwingSource = fs.readFileSync(throwingFile, 'utf8');
const THROW_NEEDLE = 'export function reclaimWorkspace(workDir, options = {}) {';
const throwHits = throwingSource.split(THROW_NEEDLE).length - 1;
throwingSource = throwingSource.split(THROW_NEEDLE).join(
  `${THROW_NEEDLE} throw new Error('disk on fire');`
);
fs.writeFileSync(throwingFile, throwingSource);

if (throwHits === 1) {
  pass('6c', `patched the reclaimer to throw (\`${THROW_NEEDLE}\` matched exactly once)`);
} else {
  fail('6c', `expected to patch the reclaimer exactly once, matched ${throwHits} times`);
}

const throwing = await standDownAgainst(throwingDist, 'throwing');
if (throwing.response?.success === true) {
  pass('6c', 'the stand-down succeeded even though the reclaim threw');
} else {
  fail('6c', `a failing reclaim took the stand-down down with it: ${JSON.stringify(throwing.response)}`);
}
if (throwing.response?.reclaim?.status === 'failed' && /disk on fire/.test(throwing.response.reclaim.error ?? '')) {
  pass('6c', `and it said so rather than staying quiet: "${throwing.response.reclaim.error}"`);
} else {
  fail('6c', `the failure was not reported to the caller: ${JSON.stringify(throwing.response?.reclaim)}`);
}
if (exists(throwing.nodeModules)) {
  pass('6c', 'the workspace is intact, as a reclaim that never ran should leave it');
} else {
  fail('6c', 'the workspace was reclaimed by a reclaimer that threw before doing anything');
}

// ------------------------------------------------------------- the verdict --

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check${failures === 1 ? '' : 's'}`
);
process.exit(failures ? 1 : 0);
