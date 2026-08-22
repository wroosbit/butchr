// Proof for KAN-273: an MCP stdio server whose client has gone is reaped, and
// one whose client is still holding the other end is not.
//
// WHAT FAILURE THIS WOULD CATCH: a reaper that identifies its targets by
// something which no longer distinguishes them, and kills every live agent's
// Atlassian proxy. KAN-273 was filed on a census where a proxy parented to
// `claude` was live and one parented to `systemd` was litter; by 2026-08-22 all
// five proxies on the manager box were parented to `systemd --user`, live ones
// included, because `npx` spawns `mcp-remote` and exits. A reaper written to
// the ticket's own suggested rule would have taken out the working fleet. Also
// caught: a discriminator with no reachable failing branch (one that answers
// "orphan" whatever it is shown, which goes green forever); a `gone` verdict
// returned for a socket the daemon merely could not read, which turns "I could
// not look" into a kill; a kill on a stale pid after the process exited and the
// pid was reused; a matcher that matches the searching shell's own command line
// (KAN-273 recorded two probes finding themselves); a grace window that does not
// hold a freshly-started server; and the reaper existing but never being called
// by the daemon, which is the KAN-145 shape — every unit green, nothing wired.
//
// CI-RUNNABLE: yes — every section builds its own socketpairs with
// `child_process.spawn` and asserts against the built module in process, so it
// needs no live daemon, no fleet, no credential, no terminal and no network.
// Section 6 reads `daemon/src/daemon.ts` as text. It does read `/proc/net/unix`
// and `/proc/<pid>/fd`, which a Linux runner has; it asserts nothing about any
// process it did not spawn itself.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// Sections 1-4 spawn their own children and close their own descriptors, so
// **this script writes the state it then asserts on**. That is the KAN-145
// shape stated plainly: it proves the discriminator separates a held socketpair
// from a released one, and it does NOT prove that a real `mcp-remote` started
// by Claude Code presents that same signature.
//
// Who covers that: an observation of the running fleet, pasted into the PR
// body — the 2026-08-22 census on the manager box, where five hung `mcp-remote`
// processes read `refCount 2 / fdRefs 1` and three working `daemon/dist/mcp.js`
// servers read `3 / 1` on the same instrument in the same minute. Nothing in
// this file can produce that row, and no future edit to this file should be
// read as having done so.
//
// The link is not arbitrary: Node's `stdio: 'pipe'` is a `uv_pipe_t`, which on
// Unix is `socketpair(AF_UNIX, SOCK_STREAM)` — the same primitive Claude Code's
// MCP transport gets. That is why the fixture is representative and it is still
// not the same as having measured the real thing.
//
// Six sections:
//
//   1. discriminator  — one socketpair, measured held and then released, so
//                       both branches are shown reachable on real kernel state
//   2. survey         — a server named like a proxy moves from `held` to
//                       `unreachable` when, and only when, its client lets go
//   3. grace          — a freshly-unreachable server is left alone
//   4. pid reuse      — a candidate whose argv changed is not signalled
//   5. self-match     — a shell command line mentioning `mcp-remote` is not
//                       itself an MCP server
//   6. wiring         — the daemon calls the sweep on a timer

import { spawn } from 'child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(HERE, '..');

let mod;
try {
  mod = await import(path.join(DAEMON, 'dist', 'mcp-orphan.js'));
} catch (err) {
  console.error('SETUP: daemon/dist is missing or stale — run `npm run build` in daemon/.');
  console.error(String(err));
  process.exit(1);
}

const {
  readUnixSocketRefCounts,
  countSocketFdReferences,
  stdinSocketInode,
  classifyClientLink,
  mcpServerKindOf,
  identifyMcpServers,
  surveyMcpServers,
  reapUnreachableMcpServers,
  processAgeSeconds,
  REAP_GRACE_SECONDS
} = mod;

let failures = 0;
const results = [];

function check(section, claim, passed, detail) {
  results.push({ section, claim, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${claim}${detail ? ` -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scratch tree holding a script named exactly as the resolved binary is, so
// the fixture is recognised by `mcpServerKindOf` for the same reason a real one
// is — its argv — rather than by a kind this script asserts on its own behalf.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'kan273-'));
const FAKE_BIN = path.join(SCRATCH, 'node_modules', '.bin');
mkdirSync(FAKE_BIN, { recursive: true });
const FAKE_PROXY = path.join(FAKE_BIN, 'mcp-remote');
writeFileSync(FAKE_PROXY, 'setTimeout(() => {}, 120000);\n');

/**
 * A child holding a real AF_UNIX socketpair on its fd 0.
 *
 * Spawned as `node .../node_modules/.bin/mcp-remote`, so its argv is the shape
 * the matcher is looking for and `identifyMcpServers()` finds it on this
 * machine without being told it exists.
 */
async function spawnHolder() {
  const child = spawn(process.execPath, [FAKE_PROXY], { stdio: ['pipe', 'pipe', 'ignore'] });
  await sleep(500);
  return child;
}

const spawned = [];
function track(child) {
  spawned.push(child);
  return child;
}

function look(inode) {
  return classifyClientLink(inode, readUnixSocketRefCounts(), countSocketFdReferences());
}

try {
  // -------------------------------------------------------------------------
  console.log('\n1. The discriminator, driven both ways on one socketpair');
  // -------------------------------------------------------------------------
  const one = track(await spawnHolder());
  const inode1 = stdinSocketInode(one.pid);

  check(1, 'the child fd 0 is a unix socket, not a FIFO', inode1 !== null, `inode ${inode1}`);

  const whileHeld = look(inode1);
  check(
    1,
    'GREEN BRANCH: while this process holds the other end, the link reads connected',
    whileHeld.state === 'connected',
    `${whileHeld.state} (refCount ${whileHeld.refCount} - fdRefs ${whileHeld.fdRefs})`
  );

  one.stdin.destroy();
  await sleep(500);
  const afterRelease = look(inode1);
  check(
    1,
    'RED BRANCH: once this process lets go, the SAME socket reads gone',
    afterRelease.state === 'gone',
    `${afterRelease.state} (refCount ${afterRelease.refCount} - fdRefs ${afterRelease.fdRefs})`
  );

  check(
    1,
    'the two branches differ by the peer reference alone, not by fd count',
    whileHeld.state === 'connected' &&
      afterRelease.state === 'gone' &&
      whileHeld.fdRefs === afterRelease.fdRefs &&
      whileHeld.refCount - afterRelease.refCount === 1,
    `fdRefs ${whileHeld.fdRefs} both times; refCount ${whileHeld.refCount} -> ${afterRelease.refCount}`
  );

  check(
    1,
    'an inode with no /proc/net/unix row is unmeasurable, never gone',
    look(2147483646).state === 'unmeasurable',
    'a kill on "I could not look" is the failure this separates out'
  );

  // -------------------------------------------------------------------------
  console.log('\n2. The survey moves a server across only when its client lets go');
  // -------------------------------------------------------------------------
  const two = track(await spawnHolder());

  // The whole record comes from `identifyMcpServers()` reading /proc, so this
  // section never asserts on a shape it invented. Only `ageSeconds` is
  // overridden, and section 3 is what covers the real one.
  const discovered = identifyMcpServers().find((s) => s.pid === two.pid);
  check(
    2,
    'identifyMcpServers finds the fixture on this machine by its argv alone',
    discovered !== undefined && discovered.kind === 'atlassian-mcp-remote',
    discovered ? `pid ${discovered.pid} kind ${discovered.kind}` : 'not found'
  );

  const asServer = (ageSeconds) => ({ ...discovered, ageSeconds });

  const heldSurvey = surveyMcpServers(
    [asServer(600)],
    readUnixSocketRefCounts(),
    countSocketFdReferences()
  );
  check(
    2,
    'a server whose client still holds it is NOT a reap candidate',
    heldSurvey.unreachable.length === 0 && heldSurvey.held.length === 1,
    heldSurvey.held[0] ? heldSurvey.held[0].because : 'nothing held'
  );

  two.stdin.destroy();
  await sleep(500);
  const goneSurvey = surveyMcpServers(
    [asServer(600)],
    readUnixSocketRefCounts(),
    countSocketFdReferences()
  );
  check(
    2,
    'the same server becomes a reap candidate once its client lets go',
    goneSurvey.unreachable.length === 1 && goneSurvey.held.length === 0,
    goneSurvey.unreachable[0]
      ? `refCount ${goneSurvey.unreachable[0].link.refCount} - fdRefs ${goneSurvey.unreachable[0].link.fdRefs}`
      : 'no candidate'
  );

  const signalled = [];
  const outcomes = reapUnreachableMcpServers(goneSurvey.unreachable, (pid, sig) =>
    signalled.push([pid, sig])
  );
  check(
    2,
    'the reaper signals exactly that server, with SIGTERM',
    outcomes.length === 1 &&
      outcomes[0].result === 'signalled' &&
      signalled.length === 1 &&
      signalled[0][0] === two.pid &&
      signalled[0][1] === 'SIGTERM',
    JSON.stringify(signalled)
  );

  const noneSignalled = [];
  reapUnreachableMcpServers(heldSurvey.unreachable, (pid, sig) => noneSignalled.push([pid, sig]));
  check(
    2,
    'and signals nothing at all for the held survey',
    noneSignalled.length === 0,
    `${noneSignalled.length} signal(s)`
  );

  // -------------------------------------------------------------------------
  console.log('\n3. The grace window holds a freshly-started server');
  // -------------------------------------------------------------------------
  const youngAge = processAgeSeconds(two.pid);
  const youngSurvey = surveyMcpServers(
    [asServer(youngAge)],
    readUnixSocketRefCounts(),
    countSocketFdReferences()
  );
  check(
    3,
    `an unreachable server younger than ${REAP_GRACE_SECONDS}s is held, not reaped`,
    youngAge < REAP_GRACE_SECONDS &&
      youngSurvey.unreachable.length === 0 &&
      youngSurvey.held.length === 1,
    `age ${youngAge.toFixed(1)}s; ${youngSurvey.held[0] ? youngSurvey.held[0].because : 'not held'}`
  );

  // -------------------------------------------------------------------------
  console.log('\n4. A pid whose argv changed is not signalled');
  // -------------------------------------------------------------------------
  const stale = {
    process: { ...asServer(600), argv: [process.execPath, '/some/other/mcp-remote'] },
    link: { state: 'gone', refCount: 2, fdRefs: 1 }
  };
  const staleSignals = [];
  const staleOutcomes = reapUnreachableMcpServers([stale], (pid, sig) =>
    staleSignals.push([pid, sig])
  );
  check(
    4,
    'a candidate whose argv no longer matches is reported pid-reused and left alone',
    staleOutcomes.length === 1 &&
      staleOutcomes[0].result === 'pid-reused' &&
      staleSignals.length === 0,
    `${staleOutcomes[0].result}; ${staleSignals.length} signal(s)`
  );

  const deadPid = {
    process: { ...asServer(600), pid: 2147483646 },
    link: { state: 'gone', refCount: 2, fdRefs: 1 }
  };
  const deadSignals = [];
  const deadOutcomes = reapUnreachableMcpServers([deadPid], (pid, sig) =>
    deadSignals.push([pid, sig])
  );
  check(
    4,
    'a candidate that has already exited is reported vanished, not signalled',
    deadOutcomes[0].result === 'vanished' && deadSignals.length === 0,
    deadOutcomes[0].result
  );

  // -------------------------------------------------------------------------
  console.log('\n5. A shell that merely mentions mcp-remote is not an MCP server');
  // -------------------------------------------------------------------------
  check(
    5,
    'a shell command line containing "mcp-remote" is not matched',
    mcpServerKindOf(['/bin/bash', '-c', 'ps -eo cmd | grep mcp-remote']) === null,
    'the trap two probes on this ticket walked into'
  );
  check(
    5,
    'a real mcp-remote argv IS matched',
    mcpServerKindOf([process.execPath, '/home/x/.npm/_npx/abc/node_modules/.bin/mcp-remote']) ===
      'atlassian-mcp-remote',
    'the positive control for the line above'
  );
  check(
    5,
    'butchr own MCP server is matched as its own kind',
    mcpServerKindOf([process.execPath, '/home/x/butchr/daemon/dist/mcp.js', '--workspace-type']) ===
      'butchr-mcp',
    'the orphan class of comment 11403'
  );
  check(
    5,
    'and an unrelated node process is not matched',
    mcpServerKindOf([process.execPath, '/home/x/some/other/server.js']) === null,
    'the closed set is closed'
  );

  // -------------------------------------------------------------------------
  console.log('\n6. The daemon actually calls the sweep');
  // -------------------------------------------------------------------------
  // Read as TEXT from src, deliberately: this section's verdict is about the
  // code in the tree, so it is unaffected by a stale or failed `dist` build.
  const daemonSrc = readFileSync(path.join(DAEMON, 'src', 'daemon.ts'), 'utf8');
  check(
    6,
    'daemon.ts imports the sweep',
    /from '\.\/mcp-orphan\.js'/.test(daemonSrc),
    'KAN-145: every unit green and nothing wired is the shape this catches'
  );
  check(
    6,
    'daemon.ts schedules it on an interval',
    /setInterval\(sweepMcpOrphanProcesses, MCP_ORPHAN_SWEEP_INTERVAL_MS\)/.test(daemonSrc),
    'a reaper nobody calls reclaims nothing'
  );
  check(
    6,
    'and runs one sweep at startup, when a restart has just stranded them',
    /\n\s*sweepMcpOrphanProcesses\(\);\n\s*const mcpOrphanSweep = setInterval/.test(daemonSrc),
    'the restart is one of the two events that produces these'
  );

  // A live read of this machine, reported and never asserted on: the fleet is
  // not this script's to control, so a count here would be a check whose
  // verdict depends on who else is running. Printed because the census is what
  // the PR body pastes.
  console.log('\n   (informational, not a check) MCP servers visible on this machine now:');
  for (const s of identifyMcpServers()) {
    const link = look(s.stdinInode);
    console.log(
      `     pid=${s.pid} ${s.kind} ppid=${s.ppid} ` +
        `rss=${Math.round(s.rssBytes / 1024 / 1024)}MB link=${link.state}`
    );
  }
} finally {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${'-'.repeat(72)}`);
const passed = results.length - failures;
console.log(`${passed}/${results.length} checks passed`);
if (failures > 0) {
  console.log('\nFAILED:');
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  section ${r.section}: ${r.claim}${r.detail ? ` -- ${r.detail}` : ''}`);
  }
}
console.log(failures === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${failures})`);

process.exit(failures ? 1 : 0);
