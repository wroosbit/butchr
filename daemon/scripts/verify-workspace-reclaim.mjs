// Proof for KAN-259: reclaiming `node_modules` from workspaces nobody is
// working in leaves every LIVE workspace untouched, and the exclusion that
// makes that true is derived from the running fleet rather than from a list.
//
// WHAT FAILURE THIS WOULD CATCH: a reclaim sweep that deletes a live agent's
// dependencies out from under it while it is building. That is the 2026-08-04
// manual pass's one hazard, automated — that pass excluded its five running
// workspaces **by hand**, and a hand-written exclusion is stale the moment the
// fleet changes. Also caught: a sweep that follows a `node_modules` symlink into
// a shared store and empties it for every workspace at once (the shape KAN-262
// is about to create), a sweep that deletes a `node_modules` git does *not*
// ignore and so destroys tracked work, a containment check that a traversal or
// a symlinked workspace can walk out of, and a "dry run" that deletes.
//
// Five sections:
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
//   5. can it fail    — section 1 re-run against a build with the live-agent
//                       exclusion patched out. If the live workspace survives
//                       *that*, section 1 was never testing the exclusion and
//                       this script exits red
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
// What section 4 still does NOT cover: its census comes from a stub
// `AgentRuntime`, so "herdr really reports the running fleet" is assumed here.
// That link is covered by observation rather than by any script — the sweep run
// against the live fleet with eight agents up, `butchr_list_agents` and the
// workspace sizes pasted either side, in the pull request. **And one thing is
// covered by neither and is owned elsewhere:** that a reclaimed workspace still
// *resumes* the conversation it was stopped in. Nothing here reactivates
// anything. That is AC1 of KAN-261 (`Relates`), marked there as the criterion
// that matters, and this script deliberately does not imply it.

import fs from 'fs';
import os from 'os';
import path from 'path';
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

// -------------------------------------------------------- 5. can it fail? --
//
// Section 1 asserts a live workspace keeps its `node_modules`. That assertion
// is worth exactly nothing unless removing the exclusion makes it false, so
// here it is removed.

console.log('\n5. with the live-agent exclusion removed, section 1 must break');

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
  pass(5, `patched the exclusion out (\`${NEEDLE}\` matched exactly once)`);
} else {
  fail(5, `expected to patch the exclusion exactly once, matched ${hits} times — this section is not testing what it claims`);
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
  pass(5, "the live workspace lost its tree, so section 1's assertion can fail");
} else {
  fail(5, 'the live workspace SURVIVED with the exclusion removed — section 1 proves nothing');
}
if (brokenSweep.excluded.length === 0) {
  pass(5, 'and nothing was reported excluded, as the patched build should');
} else {
  fail(5, `the patched build still excluded ${brokenSweep.excluded.length} workspaces`);
}

// ------------------------------------------------------------- the verdict --

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check${failures === 1 ? '' : 's'}`
);
process.exit(failures ? 1 : 0);
