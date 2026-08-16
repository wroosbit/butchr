// Live proof for KAN-507: under CrabCast, a stand-down that did not stop the
// agent says so; the caller's `override` reaches the gate that actually
// refuses; and an activation refusal names its upstream CAUSE rather than the
// downstream symptom.
//
// WHAT FAILURE THIS WOULD CATCH: `butchr_deactivate_agent` answering
// `success: true, alreadyGone: true, "No agent was running."` about an agent
// that is running, charged and visible in the runtime census — which is what it
// answered on 2026-08-16 for `task/kan-498` and `task/kan-503` while three
// task-shaped `claude` processes totalling ~1.68 GB were alive, and which left
// CrabCast's three slots held by agents Butchr believed were gone until no task
// agent could be staffed at all. It would equally catch `override: true` being
// accepted from a caller and never put on the wire, and an `activate_agent`
// refused for capacity being reported to that caller as
// `no pane named <agent> in CrabCast's census`.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process. Sections 3 and 4 stand up a fake CrabCast on a unix socket in a
// temp dir; no live daemon, no real peer, no herdr, no credential, no terminal.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
//
// Stated because a proof that supplies its own input has not tested that the
// input arrives (KAN-145), and this script does both kinds:
//
//   - §3 and §4 assert on **bytes the adapter really emitted** and on frames a
//     real `CrabCastLink` really parsed. The `override` key is read back off
//     the wire the fake peer received, so "the flag crosses the seam" is
//     measured rather than constructed.
//
//   - §1, §2 and §5 CONSTRUCT their input. They hand the real `MessageRouter` a
//     stub runtime whose census reports an agent running and whose
//     `closeAgentByKey` fails the way `CrabCastRuntime`'s does. That is the seam
//     reproduced, not the seam observed: nothing here proves a real CrabCast
//     ever produces that pairing.
//
//     WHAT COVERS IT: a first-hand reading of the live machine, pasted into the
//     PR body — `crabcast status .../task/kan-420` reporting `state: running`
//     with `sessionless: true` in one payload, beside `/proc/156100/cwd`
//     pointing at that same workspace. No script owns that join, and this
//     header is where that edge is marked rather than left to be inferred.
//
//   - **§4 passes on the pre-fix build, deliberately, and that is not slack.**
//     The adapter always recorded the refusal correctly; the defect was one
//     layer up, in what the router did with it. §4 documents the mechanism and
//     §5 is what actually catches the defect. Split rather than merged so that a
//     future reader can see which half of the seam each one is about.
//
// ---------------------------------------------------------------------------
// DRIVING IT RED
// ---------------------------------------------------------------------------
//
// Every section below fails on the pre-fix build. To watch it:
//
//   git stash                                  # or: git checkout origin/main -- daemon/src
//   cd daemon && npm run build > /tmp/b.log 2>&1; echo "BUILD_EXIT=$?"
//   node scripts/verify-standdown-and-override-cross-the-seam.mjs; echo "EXIT=$?"
//   git stash pop && npm run build > /tmp/b.log 2>&1; echo "BUILD_EXIT=$?"
//
// Note the build is REDIRECTED rather than piped. `npm run build | tail -5`
// yields tail's exit status, so a failed build reads as 0 — and this script
// imports from `dist`, so a verdict read after a failed build would be a
// verdict about the previous build. `require-fresh-dist` below refuses that
// case outright rather than warning about it.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-standdown-and-override-cross-the-seam.mjs [distDir]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const srcDir = path.join(scriptDir, '..', 'src');

// A setup guard, not a verdict — it exits 2. See lib/require-fresh-dist.mjs.
requireFreshDist(srcDir, distDir);

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan507-'));
const cleanups = [];

let failures = 0;
let checks = 0;

function check(condition, claim, detail = '') {
  checks++;
  if (condition) {
    console.log(`  PASS  ${claim}`);
  } else {
    failures++;
    console.log(`  FAIL  ${claim}`);
    if (detail) console.log(`        ${detail}`);
  }
}

async function section(title, body) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  await body();
}

// =============================================================================
// §1 — THE STAND-DOWN THAT DID NOT STAND ANYTHING DOWN
// =============================================================================
//
// The exact state measured on this machine on 2026-08-16: CrabCast's census has
// the agent (running, charged, holding a slot), and Butchr's session map does
// not, because the agent outlived the daemon that started it. `closeAgentByKey`
// resolves against the session map, so it fails — and the pre-fix router read
// that failure, plus a reachable runtime, as "No agent was running."

const AGENT = 'butchr-task-kan-420';
const WORKDIR = '/home/brooswit/.local/share/butchr/workspaces/task/kan-420';

/**
 * A runtime with the CrabCast seam wide open.
 *
 * `censusHas` is the whole variable: with it true the agent is running and the
 * stand-down did nothing; with it false the agent really is gone. One stub, two
 * worlds, so §1 can show the honest answer in BOTH — a rule that only ever
 * returns "still running" would be no better than one that only ever returned
 * "already gone".
 */
function seamRuntime({ censusHas, reachable = true }) {
  return {
    listHerdrAgentsChecked: () => ({
      reachable,
      agents: censusHas
        ? [{ name: AGENT, agentRuntime: 'claude', workDir: WORKDIR, herdrStatus: 'done' }]
        : [],
      unreadableRecordsTotal: 0,
      unreadableRecords: []
    }),
    listHerdrAgents() {
      return this.listHerdrAgentsChecked().agents;
    },
    listActiveSessions: () => [],
    resolveSessionByAddress: () => ({ outcome: 'none' }),
    // CrabCastRuntime's own words, verbatim from `addressedSession`.
    closeAgentByKey: () => ({
      success: false,
      error: 'no session this daemon started matches task/kan-420'
    }),
    listHerdrStatuses: () => new Map(),
    herdrReachable: () => reachable,
    getSession: () => undefined,
    getSessionByAddress: () => undefined,
    terminateSession: () => ({ success: false }),
    describeAgent: () => ({ agentName: AGENT, type: 'task', workDir: WORKDIR, herdrStatus: 'done' })
  };
}

/** Run one `deactivate_by_key` and collect the response and any broadcasts. */
function standDown(runtime) {
  const broadcasts = [];
  let response = null;
  const router = new MessageRouter(
    { resolve: async () => null, disabledMatch: () => null },
    { load: async () => '' },
    runtime,
    () => {},
    (msg) => broadcasts.push(msg)
  );
  router.handleDeactivateByKey({ key: 'KAN-420', type: 'task' }, (msg) => {
    response = msg;
  });
  return { response, broadcasts };
}

await section('1. A stand-down over a live census row is reported as one', async () => {
  const live = standDown(seamRuntime({ censusHas: true }));
  const r = live.response;

  // The defect itself. This is the assertion that goes red on the pre-fix build.
  check(
    r.alreadyGone !== true,
    'does NOT claim alreadyGone about an agent the census reports running',
    `got alreadyGone=${JSON.stringify(r.alreadyGone)} note=${JSON.stringify(r.note)} — ` +
      'the pre-fix build answered true here, with "No agent was running."'
  );

  check(
    r.success === false,
    'reports success: false, because the agent the caller asked to stop was not stopped',
    `got success=${JSON.stringify(r.success)}`
  );

  check(
    r.stillRunning && r.stillRunning.agentName === AGENT,
    'names the agent that is still running',
    `got ${JSON.stringify(r.stillRunning)}`
  );

  check(
    r.stillRunning && r.stillRunning.standDownRecorded === true,
    'still says the stand-down INTENT was recorded — the honest half is not lost',
    `got ${JSON.stringify(r.stillRunning?.standDownRecorded)}`
  );

  check(
    typeof r.stillRunning?.stopItWith === 'string' &&
      r.stillRunning.stopItWith.includes('crabcast deactivate') &&
      r.stillRunning.stopItWith.includes(WORKDIR),
    'names the route that DOES stop it, with the path already filled in',
    `got ${JSON.stringify(r.stillRunning?.stopItWith)}`
  );

  // The response must not contradict itself the way the measured one did:
  // `alreadyGone: true` beside `reclaim.reason: "an agent is still live in this
  // workspace"`, both in one payload.
  check(
    !(r.alreadyGone === true && r.reclaim?.reason?.includes('still live')),
    'does not assert "already gone" and "still live in this workspace" in one payload',
    `alreadyGone=${JSON.stringify(r.alreadyGone)} reclaim=${JSON.stringify(r.reclaim?.reason)}`
  );

  check(
    !live.broadcasts.some((b) => b.action === 'agent_deactivated_event'),
    'broadcasts no agent_deactivated_event for an agent that is still running',
    `broadcast ${JSON.stringify(live.broadcasts.map((b) => b.action))}`
  );

  check(
    r.reclaim === undefined || r.reclaim.status === 'skipped',
    'reclaims nothing from underneath a live agent',
    `got reclaim=${JSON.stringify(r.reclaim)}`
  );
});

await section('2. The honest answer in the other direction — a genuinely dead agent', async () => {
  // The discriminating arm. Without it, §1 would pass against a build that had
  // simply deleted `alreadyGone` — which would be a different defect, not a fix,
  // and would break every supervisor that stands down an agent already gone.
  const dead = standDown(seamRuntime({ censusHas: false }));
  const r = dead.response;

  check(
    r.alreadyGone === true,
    'an agent absent from the census IS still reported alreadyGone',
    `got alreadyGone=${JSON.stringify(r.alreadyGone)} — deleting the claim outright is not the fix`
  );
  check(r.success === true, 'and the stand-down succeeds', `got success=${JSON.stringify(r.success)}`);
  check(
    r.stillRunning === undefined,
    'and carries no stillRunning block',
    `got ${JSON.stringify(r.stillRunning)}`
  );

  // Fails closed: a census that could not be taken establishes nothing.
  const blind = standDown(seamRuntime({ censusHas: false, reachable: false }));
  check(
    blind.response.alreadyGone !== true && blind.response.standDownUnverifiable,
    'an UNREACHABLE runtime yields neither confident answer — it fails closed',
    `got alreadyGone=${JSON.stringify(blind.response.alreadyGone)} ` +
      `unverifiable=${JSON.stringify(blind.response.standDownUnverifiable)}`
  );
});

// =============================================================================
// §3 and §4 — the wire. These read bytes the adapter actually sent.
// =============================================================================

/**
 * A CrabCast that records every frame it is asked and answers as told.
 *
 * `activateReply` decides whether the activation succeeds or is refused, so §4
 * can drive a real capacity refusal through the real adapter.
 */
async function fakePeer(name, { activateReply }) {
  const socketPath = path.join(TMP, `${name}.sock`);
  const seen = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        seen.push(req);
        const reply =
          req.action === 'daemon_status'
            ? { success: true, contractVersion: 8, build: { commit: 'fake' }, bootId: 'b1' }
            : req.action === 'list_agents'
              ? { success: true, agents: [], foreign: [] }
              : req.action === 'configure_agent'
                ? { success: true }
                : req.action === 'activate_agent'
                  ? activateReply(req)
                  : { success: true };
        socket.write(JSON.stringify({ ...reply, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());
  return { socketPath, seen };
}

/** Wait until the peer has been asked for `action`, or give up. */
async function waitForFrame(seen, action, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = seen.find((f) => f.action === action);
    if (frame) return frame;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

/** Spawn one agent through the real adapter and return the frames it sent. */
async function spawnThrough(name, { override, activateReply }) {
  const peer = await fakePeer(name, { activateReply });
  const link = new CrabCastLink({ socketPath: peer.socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 10_000, log: () => {} });
  cleanups.push(() => runtime.dispose());

  // The link connects asynchronously. Spawning before it has would refuse with
  // "no connection ... has been established yet" — a real refusal, but one about
  // this script's own setup rather than about anything under test.
  const connectBy = Date.now() + 5_000;
  while (Date.now() < connectBy && !link.connected) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!link.connected) {
    console.error(`setup: the fake peer at ${peer.socketPath} never accepted a connection.`);
    process.exit(2);
  }

  const workDir = path.join(TMP, `ws-${name}`);
  fs.mkdirSync(workDir, { recursive: true });

  const session = runtime.spawnSession(
    'task',
    `KAN-${name}`,
    undefined,
    'prompt',
    1,
    false,
    'claude',
    undefined,
    undefined,
    override
  );
  // Read SYNCHRONOUSLY, before any await. `provision` mutates this same object,
  // so reading the field after the round-trip would measure the post-refusal
  // state and say nothing about what the caller saw at return.
  const spawnErrorAtReturn = session.spawnError;
  const frame = await waitForFrame(peer.seen, 'activate_agent');
  return { frame, session, spawnErrorAtReturn, runtime, peer };
}

await section('3. `override` reaches the gate that actually refuses', async () => {
  const withFlag = await spawnThrough('ovr', {
    override: true,
    activateReply: () => ({ success: true, sessionId: 'remote-1' })
  });

  check(
    withFlag.frame !== null,
    'the adapter sent an activate_agent frame at all',
    'no activate_agent frame reached the peer'
  );

  // THE ASSERTION THIS TICKET EXISTS FOR. Pre-fix, the adapter sent
  // `{ action, path }` and this key was absent however the caller asked.
  check(
    withFlag.frame?.override === true,
    'a caller override:true puts `override: true` on the activate_agent frame',
    `frame was ${JSON.stringify(withFlag.frame)} — the pre-fix adapter sent { action, path } only`
  );

  // The discriminating arm again: a build that hardcoded the flag would pass
  // the check above and would silently start every agent past capacity.
  const withoutFlag = await spawnThrough('noovr', {
    override: false,
    activateReply: () => ({ success: true, sessionId: 'remote-2' })
  });
  check(
    withoutFlag.frame !== null && !('override' in withoutFlag.frame),
    'and a caller that did NOT ask omits the key entirely, rather than sending false',
    `frame was ${JSON.stringify(withoutFlag.frame)}`
  );
});

await section('4. A refusal names its cause, not the symptom that followed it', async () => {
  // CrabCast's real refusal text, as `epic/KAN-39` recorded it from daemon.log.
  const CAUSE = 'at capacity — 3 charged agents are already running against a cap of 3.';

  const refused = await spawnThrough('refuse', {
    override: true,
    activateReply: () => ({ success: false, error: CAUSE })
  });

  // The adapter records the refusal on the session. This is the value that
  // existed all along and that nothing downstream read in time.
  const deadline = Date.now() + 5_000;
  let spawnError;
  while (Date.now() < deadline) {
    spawnError = refused.runtime.getSession(refused.session.sessionId)?.spawnError;
    if (spawnError) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  check(
    typeof spawnError === 'string' && spawnError.includes('at capacity'),
    'the adapter records the capacity refusal on the session',
    `got ${JSON.stringify(spawnError)}`
  );

  check(
    spawnError?.includes('cap of 3'),
    "and carries CrabCast's own figures verbatim rather than paraphrasing them",
    `got ${JSON.stringify(spawnError)}`
  );

  // The timing that made this invisible: `spawnSession` returns synchronously,
  // so the caller's own `if (session.spawnError)` check runs BEFORE the
  // round-trip that produces one. That is why the fix reads it after the wait
  // rather than adding another check before it.
  check(
    refused.spawnErrorAtReturn === undefined,
    'and it is NOT yet set when spawnSession returns — which is why the pre-fix check missed it',
    `got ${JSON.stringify(refused.spawnErrorAtReturn)} — if this is set, the race this fix ` +
      'is about has changed shape, and reading the cause after the wait may no longer be needed'
  );
});

await section('5. The caller is told the cause — the router-side half of §4', async () => {
  // §4 asserts the ADAPTER records the refusal, and it passes on the pre-fix
  // build too, because the adapter was always right. The defect was one layer
  // up: nothing read that value in time, and the caller got the census symptom.
  // This section drives the real `handleActivateByKey` and asserts on what the
  // CALLER actually receives, which is the surface the fix changes.
  const CENSUS_SYMPTOM = "no pane named butchr-task-kan-506 in CrabCast's census";
  const CAUSE =
    'refused by crabcast-daemon: activate_agent refused: at capacity — 3 charged agents ' +
    'are already running against a cap of 3.';

  const spawned = {
    sessionId: 's1',
    type: 'task',
    key: 'KAN-506',
    status: 'initializing',
    workDir: path.join(TMP, 'ws-506'),
    expectsRuntime: true,
    ptyBuffer: '',
    onDataListeners: [],
    ptyDiscontinuities: []
  };

  const runtime = {
    // The race, reproduced: nothing is set when spawnSession returns...
    spawnSession: () => spawned,
    // ...and the refusal has landed by the time anyone looks again.
    getSession: () => ({ ...spawned, spawnError: CAUSE }),
    getSessionByAddress: () => undefined,
    confirmAgentPresent: async () => ({
      present: false,
      reason: 'absent',
      error: CENSUS_SYMPTOM,
      waitedMs: 10_000,
      checks: 20
    }),
    abandonSession: () => {},
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: [],
      unreadableRecordsTotal: 0,
      unreadableRecords: []
    }),
    listHerdrAgents: () => [],
    listActiveSessions: () => [],
    listHerdrStatuses: () => new Map(),
    herdrReachable: () => true,
    resolveSessionByAddress: () => ({ outcome: 'none' }),
    closeAgentByKey: () => ({ success: false }),
    terminateSession: () => ({ success: false }),
    briefLocation: () => ({ kind: 'runtime-owned', pointer: 'n/a' }),
    describeAgent: () => ({ agentName: 'x', type: 'task', workDir: null, herdrStatus: 'unknown' })
  };

  let response = null;
  const router = new MessageRouter(
    {
      resolve: async () => null,
      get: () => undefined,
      disabledIntegrationForType: () => undefined,
      disabledMatch: () => null,
      priorityFor: () => 1,
      mcpServerDefinitions: () => ({})
    },
    { load: async () => 'prompt', loadAndRender: () => 'prompt' },
    runtime,
    () => {},
    () => {},
    {
      // Butchr's OWN gate must pass, or it refuses before a spawn ever happens
      // and this section measures the wrong refusal. On a loaded machine the
      // real reading refuses here — which is itself a small demonstration of the
      // point: two gates, and only one of them is CrabCast's.
      capacitySource: () => ({
        cap: 12,
        running: 0,
        supervisors: 0,
        headroom: 12,
        atCapacity: false,
        capBoundBy: 'memory',
        headroomBoundBy: 'memory',
        reason: 'injected by verify-standdown-and-override-cross-the-seam.mjs',
        cores: 4,
        load1: 0,
        cpuBusyCores: 0,
        cpuBusySource: 'measured',
        cpuBusyWindowSeconds: 5,
        stallPercent: 0,
        stallSource: 'io',
        stallIoPercent: 0,
        stallMemoryPercent: 0,
        stallRefusePercent: 20,
        stalled: false,
        headroomBeforeStall: 12,
        totalMb: 16000,
        availableMb: 12000,
        agentMemoryMb: 650,
        agentCores: 0.75,
        agentMemorySource: 'seed',
        agentCoresSource: 'seed',
        summary: 'injected'
      })
    }
  );

  await router.handleActivateByKey({ type: 'task', key: 'KAN-506', defaultAgent: 'claude' }, (msg) => {
    response = msg;
  });

  check(response !== null && response.success === false, 'the activation is refused', `got ${JSON.stringify(response)}`);

  // THE ASSERTION. Pre-fix this was the census symptom alone, and it sent
  // `epic/KAN-39` hunting a lookup defect for four attempts.
  check(
    typeof response?.error === 'string' && response.error.includes('at capacity'),
    "the caller's error names the CAUSE — 'at capacity' — rather than only the symptom",
    `got ${JSON.stringify(response?.error)}`
  );

  check(
    response?.error?.includes('cap of 3'),
    "and carries CrabCast's own figures, so the reader can reproduce the arithmetic",
    `got ${JSON.stringify(response?.error)}`
  );

  // The census reading is kept rather than swapped out: it is still the evidence
  // that the agent genuinely is not there.
  check(
    response?.error?.includes(CENSUS_SYMPTOM),
    'and still reports what the census found, rather than trading one half-truth for another',
    `got ${JSON.stringify(response?.error)}`
  );
});

// =============================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) console.log(`${failures} FAILED`);
console.log('='.repeat(70));

for (const fn of cleanups) {
  try {
    fn();
  } catch {
    /* teardown is best-effort */
  }
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ditto */
}

process.exit(failures ? 1 : 0);
