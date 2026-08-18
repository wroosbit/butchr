// KAN-508: a stand-down is addressed to a WORKSPACE, so it reaches an agent
// this daemon holds no session for.
//
// WHAT FAILURE THIS WOULD CATCH: `CrabCastRuntime.closeAgentByKey` resolving
// against `this.sessions` alone. That map dies with the daemon while CrabCast's
// registry does not, so every agent that outlives a daemon restart is
// unstoppable through it while running, charged and visible in the census. The
// refusal reads *"no session this daemon started matches <type>/<key>"* — true
// about the map, false about the world — and the board reconciler, which is the
// thing the human ruled owns agent lifecycle (KAN-508 comment 12874), calls
// exactly this method for every stand-down it decides on. So the loop that is
// supposed to shrink the fleet silently no-ops for precisely the population it
// exists to clear. KAN-507 made the condition legible (`stillRunning`,
// `stopItWith: crabcast deactivate <workDir>`) and could not act on it; this is
// the daemon taking the route it was already naming.
//
// It fails in the comfortable direction and that is why it survived: a fleet
// that fails to shrink looks exactly like a fleet nobody asked to shrink, until
// capacity fills. KAN-507 measured it at the sharp end — `task/kan-420`
// sessionless and running at pid 156100, 546 MB, holding one of three slots,
// with four activations refused including the deploy of the fleet's own
// messaging fix.
//
// CI-RUNNABLE: yes — every section stands up its own Unix socket under os.tmpdir() and answers its own frames; no peer, no herdr, no PTY, no credential, no network, and nothing is skipped, so a green is a green.
//
// ── WHICH SECTIONS READ WHAT, AND WHY THAT MATTERS BEFORE THE VERDICT ──────
//
// EVERY SECTION IMPORTS FROM `dist`. There is no static section in this file,
// so after a FAILED BUILD this script tested the PREVIOUS build and both
// outcomes mislead — a pass reads as "my mutation was not caught" and a fail
// credits this script for what the compiler did. Confirm `npm run build` exited
// 0, unpiped, before reading the verdict below. This is KAN-314's rule and this
// script is squarely inside it rather than at its edge.
//
// ── WHAT SUPPLIES ITS OWN INPUT, AND WHO COVERS WHAT THAT LEAVES ───────────
//
// This script writes the census it then asserts on, which is the KAN-145 shape,
// so the edge of its coverage is marked here rather than left to inference:
//
//   - The frame is NOT hand-written. It is
//     `fixtures/crabcast-owned-running-census.json`, captured verbatim off a
//     live CrabCast socket while two agents CrabCast itself had started were
//     RUNNING, with its `capturedWorkspacesRoot` rewritten to this machine's —
//     the same treatment `verify-crabcast-adopt-launcher-vocabulary.mjs` and
//     `verify-crabcast-session-restore.mjs` give it.
//   - ONE EDIT MAKES THE POPULATION: `createdAt` is set to null on a row. That
//     is a REAL committed refusal branch of `adoptFromCensus` (*"Not a time we
//     may guess"*), not an invented state — it is one of the three ways a row
//     stays sessionless for good, alongside a missing `sessionId` and a
//     launcher outside Butchr's vocabulary (KAN-429). Every committed fixture
//     row is adoptable, because every captured row was configured by Butchr, so
//     the un-adoptable population has to be synthesised to be exercised at all.
//   - WHAT THIS DOES NOT COVER: that the WIRE CALL STOPS THE AGENT. Every
//     section asserts what this daemon SENT, never what CrabCast did with it —
//     `deactivate_agent` is asynchronous and `terminateSession` has always
//     answered "asked", not "stopped". A fake peer cannot demonstrate a real
//     stop and neither can this script.
//   - WHO COVERS THAT: `verify-standdown-and-override-cross-the-seam.mjs`
//     against a live peer, and the PR body pastes an observation of the running
//     fleet. Until one of those runs, "the slot is released" is uncovered by
//     anything here, and §1 asserts the send rather than the release
//     deliberately — naming what it proves is the whole of what a header owes.
//
// ── DRIVING IT RED (four mutations, four independent mechanisms) ───────────
//
// Each was applied, BUILT (exit 0, unpiped), and run on 2026-08-17. The counts
// below are what was observed, not what was expected — §2's first form was
// rewritten because this drive showed it passing under its own mutation.
//
//   1. THE FIX ITSELF. Delete the ambiguity check and the
//      `closeAgentByWorkspace` call from `closeAgentByKey`, leaving the
//      pre-KAN-508 `return { success: false, error: addressed.error }`.
//      → 8 red: all four of §1, §2's wording and positive control, and §4's
//      narrowed arm. §3, §5, §6 GREEN — which is what says §6 guards the
//      session route rather than re-testing §1.
//   2. THE FAIL-CLOSED GUARD. Delete the `if (!this.census.reachable)` block in
//      `closeAgentByWorkspace`.
//      → 2 red, both in §2: the stand-down succeeds on a stale census.
//      Everything else GREEN, so §2 is not §1 twice.
//   3. THE AMBIGUITY REFUSAL. Change `if (matches.length > 1)` to `if (false)`,
//      so a bare key resolves to `matches[0]`.
//      → 2 red, both in §4. §1, §2, §3, §5, §6 GREEN.
//   4. THE FOREIGN-PANE GUARD. Make `censusAddressesForKey` iterate
//      `[...this.census.rows, ...this.census.foreign]` and fall back to a
//      basename-derived address for a path outside the tree.
//      → 2 red, both in §5: a pane at a directory Butchr never owned is
//      addressed by a stand-down. Everything else GREEN.
//
// ⚠ A FIFTH MUTATION WAS TRIED FIRST AND IS RECORDED BECAUSE IT DID NOT RUN.
// Inserting `if (addressed.outcome !== 'one') return …` above the existing
// branch narrowed the rest of the method to `never` and the build FAILED with
// TS2339. Under KAN-314's rule that is not a red and not a re-run: the mutation
// is not testable as written, and mutation 1 above is its compiling form. Had
// the verdict been read anyway it would have described the previous `dist`.
//
// Each mutation that counted compiles, which is required of a red drive here.
//
// USAGE
//   node daemon/scripts/verify-standdown-reaches-sessionless-agent.mjs [--verbose]
//   BUTCHR_DIST=<path>   to point at a build other than daemon/dist

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const verbose = process.argv.includes('--verbose');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');

let failures = 0;

function rule(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function ok(message) {
  console.log(`  \x1b[32mPASS\x1b[0m ${message}`);
}
function bad(message, detail) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${message}`);
  if (detail !== undefined) console.log(`       ${detail}`);
}
function check(condition, message, detail) {
  if (condition) ok(message);
  else bad(message, detail);
}

async function section(title, body) {
  rule(title);
  try {
    await body();
  } catch (err) {
    bad(
      'this section could not run to completion',
      `${err instanceof Error ? err.message : String(err)} — counted as a failure of this ` +
        `section, not swallowed.`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, budgetMs, stepMs = 100) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { workspacesRoot } = await import(path.join(distDir, 'herdr.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan508-'));
const cleanups = [];

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-owned-running-census.json'), 'utf8')
);

/** Rewrite the captured workspace root to this machine's. See the header. */
function localise(value) {
  return JSON.parse(
    JSON.stringify(value).split(FIXTURE.capturedWorkspacesRoot).join(workspacesRoot())
  );
}

const CENSUS = localise(FIXTURE.list_agents);
const STATUS = FIXTURE.daemon_status;

/** The address a fixture row maps to, in Butchr's terms. */
function addressOf(row) {
  const rel = path.relative(workspacesRoot(), row.workDir ?? row.path).split(path.sep);
  return { type: rel[0], key: rel[1] };
}

/**
 * A CrabCast that answers the frames it is handed AND RECORDS what it was
 * asked to deactivate.
 *
 * The recording is the instrument for every section below: the question is
 * never only "what did the runtime return" but "what went down the wire",
 * because a refusal that returns cleanly while still sending is the failure
 * this script exists to catch. `sent` is the array those assertions read.
 */
async function fakeCrabCast(name, listFrame, statusFrame = STATUS) {
  const sent = [];
  const socketPath = path.join(TMP, `${name}.sock`);
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
        if (req.action === 'deactivate_agent') {
          sent.push(req.path);
          socket.write(JSON.stringify({ success: true, id: req.id }) + '\n');
          continue;
        }
        const frame =
          req.action === 'daemon_status'
            ? statusFrame
            : req.action === 'list_agents'
              ? listFrame
              : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(socketPath, r));
  const close = () => {
    for (const s of sockets) s.destroy();
    try {
      server.close();
    } catch {
      /* teardown */
    }
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* teardown */
    }
  };
  cleanups.push(close);
  return { socketPath, sent, close };
}

/** A runtime pointed at a fake peer, with its census already read once. */
async function runtimeOn(socketPath) {
  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 100, log: () => {} });
  cleanups.push(() => runtime.dispose());
  await until(() => runtime.herdrReachable(), 5_000);
  await sleep(300); // one more census tick, so adoption has run
  return runtime;
}

/**
 * The census with every row made UN-ADOPTABLE, by the one branch that is a
 * refusal rather than a failure: `createdAt: null`. See the header — this is a
 * real committed branch of `adoptFromCensus`, not an invented state.
 */
function censusUnadoptable(frame = CENSUS) {
  const out = JSON.parse(JSON.stringify(frame));
  for (const row of out.agents) row.createdAt = null;
  return out;
}

// ── §1 ─────────────────────────────────────────────────────────────────────
await section(
  '§1  IMPORTS dist — a sessionless-but-running agent is stood down by its workspace path',
  async () => {
    const peer = await fakeCrabCast('sessionless', censusUnadoptable());
    const runtime = await runtimeOn(peer.socketPath);
    const address = addressOf(CENSUS.agents[0]);
    const expectedPath = path.join(workspacesRoot(), address.type, address.key);

    // The premise, asserted rather than assumed: this runtime really does hold
    // no session for the agent. Without this the section could pass while
    // silently testing the ordinary session route, which is §6's job.
    const held = runtime.getSessionByAddress(address.key, address.type);
    check(
      held === undefined,
      `the runtime holds NO session for ${address.type}/${address.key} (the premise)`,
      held ? `it held session ${held.sessionId} — this section tested the wrong route` : undefined
    );

    const result = runtime.closeAgentByKey(address.key, address.type);
    check(
      result.success === true,
      'closeAgentByKey SUCCEEDS for an agent this daemon holds no session for',
      `got ${JSON.stringify(result)}`
    );
    check(
      result.route === 'workspace',
      "it reports `route: 'workspace'`, so an operator can see it went down the fallback",
      `got route=${JSON.stringify(result.route)}`
    );

    await until(() => peer.sent.length > 0, 3_000);
    check(
      peer.sent.length === 1,
      'exactly one deactivate_agent reached the peer',
      `peer received ${JSON.stringify(peer.sent)}`
    );
    check(
      peer.sent[0] === expectedPath,
      'it names the workspace path pathForAddress would have spawned at',
      `sent ${JSON.stringify(peer.sent[0])}, expected ${JSON.stringify(expectedPath)}`
    );
    if (verbose) console.log(`       workspace: ${expectedPath}`);
  }
);

// ── §2 ─────────────────────────────────────────────────────────────────────
await section(
  '§2  IMPORTS dist — a census that WAS read and then went unreachable refuses on its stale rows',
  async () => {
    // ⚠ THE ARRANGEMENT IS THE POINT OF THIS SECTION, and the obvious version
    // of it tests nothing. A peer that never answers `list_agents` leaves
    // `census.rows` EMPTY, so the stand-down is refused by the no-such-row
    // branch whether or not the reachability guard exists — measured, not
    // reasoned: with `if (!this.census.reachable)` deleted, that arrangement
    // still sent nothing and this section still passed. It was a check that
    // could only ever return the answer it was hoping for.
    //
    // The state that actually distinguishes the guard is a census that was read
    // ONCE and then stopped answering: `startCensus` sets
    // `{ ...this.census, reachable: false }`, which RETAINS the rows. So the
    // runtime holds a populated, stale census it knows it can no longer trust —
    // and without the guard it would stand an agent down on a reading that is
    // no longer being taken.
    const peer = await fakeCrabCast('census-stale', censusUnadoptable());
    const runtime = await runtimeOn(peer.socketPath);
    const address = addressOf(CENSUS.agents[0]);

    // The premise: the rows are there and the runtime believes them.
    check(
      runtime.herdrReachable() === true,
      'the census was read and IS reachable (the premise, before the peer goes away)'
    );

    // Take the peer away. The rows stay; `reachable` goes false.
    peer.close();
    const wentUnreachable = await until(() => runtime.herdrReachable() === false, 5_000);
    check(
      wentUnreachable === true,
      'after the peer goes away the census reports itself UNREACHABLE',
      'the arrangement never reached the state this section is about'
    );

    const result = runtime.closeAgentByKey(address.key, address.type);
    check(
      result.success === false,
      'a stand-down is REFUSED on a stale census, even though the rows are still populated',
      `got ${JSON.stringify(result)}`
    );
    check(
      /did not answer|nothing could be established/i.test(result.error ?? ''),
      'and the refusal names the census as what established nothing',
      `error was: ${result.error}`
    );

    // ⚠ THE POSITIVE CONTROL, and here it carries real weight: the identical
    // call, at the identical address, against the identical census CONTENT —
    // differing only in whether the peer is still answering. Without it this
    // section would be satisfied by a runtime that never sends anything.
    const live = await fakeCrabCast('census-live', censusUnadoptable());
    const liveRuntime = await runtimeOn(live.socketPath);
    const control = liveRuntime.closeAgentByKey(address.key, address.type);
    await until(() => live.sent.length > 0, 3_000);
    check(
      control.success === true && live.sent.length === 1,
      'POSITIVE CONTROL: the same call on the same rows, with the peer still answering, DOES send',
      `success=${control.success} sent=${JSON.stringify(live.sent)} — if this fails, the ` +
        `refusal above proved nothing, because a runtime that never sends would satisfy it too`
    );
  }
);

// ── §3 ─────────────────────────────────────────────────────────────────────
await section(
  '§3  IMPORTS dist — a key the census reports nothing for is refused, and nothing is sent',
  async () => {
    const peer = await fakeCrabCast('absent', censusUnadoptable());
    const runtime = await runtimeOn(peer.socketPath);

    const result = runtime.closeAgentByKey('KAN-000-not-running', 'task');
    check(
      result.success === false,
      'a workspace the census reports no running agent at is REFUSED',
      `got ${JSON.stringify(result)}`
    );
    await sleep(250);
    check(
      peer.sent.length === 0,
      'nothing was sent for a workspace nobody confirmed',
      `peer received ${JSON.stringify(peer.sent)}`
    );
  }
);

// ── §4 ─────────────────────────────────────────────────────────────────────
await section(
  '§4  IMPORTS dist — one key under two types is AMBIGUOUS, and ambiguity is refused, not resolved',
  async () => {
    // Same key, two workspace types. The session map cannot disambiguate
    // (it holds neither), so this is the fallback's own decision to make.
    const base = censusUnadoptable();
    const address = addressOf(CENSUS.agents[0]);
    const frame = JSON.parse(JSON.stringify(base));
    frame.agents = [frame.agents[0], JSON.parse(JSON.stringify(frame.agents[0]))];
    const twinPath = path.join(workspacesRoot(), 'story', address.key);
    frame.agents[1].path = twinPath;
    frame.agents[1].workDir = twinPath;
    frame.agents[1].sessionId = `${frame.agents[1].sessionId}-twin`;

    const peer = await fakeCrabCast('ambiguous', frame);
    const runtime = await runtimeOn(peer.socketPath);

    const result = runtime.closeAgentByKey(address.key); // no type given
    check(
      result.success === false,
      'a bare key matching two workspaces is REFUSED rather than resolved to whichever came first',
      `got ${JSON.stringify(result)}`
    );
    await sleep(250);
    check(
      peer.sent.length === 0,
      'no stand-down was sent while the address was ambiguous',
      `peer received ${JSON.stringify(peer.sent)}`
    );

    // And the disambiguated call works, which is what makes the refusal a
    // refusal of the ADDRESS rather than of the agent.
    const narrowed = runtime.closeAgentByKey(address.key, address.type);
    await until(() => peer.sent.length > 0, 3_000);
    check(
      narrowed.success === true && peer.sent.length === 1,
      'naming the type stands exactly one of them down',
      `success=${narrowed.success} sent=${JSON.stringify(peer.sent)}`
    );
    check(
      peer.sent[0] === path.join(workspacesRoot(), address.type, address.key),
      'and it is the one that was named',
      `sent ${JSON.stringify(peer.sent[0])}`
    );
  }
);

// ── §5 ─────────────────────────────────────────────────────────────────────
await section(
  '§5  IMPORTS dist — a pane outside Butchr\'s workspace tree is never a stand-down target',
  async () => {
    // A running pane at a path Butchr does not own — a human's own terminal is
    // the case that matters. It carries the same KEY in its directory name, so
    // a key-only match that did not check the tree would find it.
    const frame = JSON.parse(JSON.stringify(censusUnadoptable()));
    const outside = path.join(os.tmpdir(), 'not-a-butchr-workspace', 'kan-346-diag');
    frame.agents = [JSON.parse(JSON.stringify(frame.agents[0]))];
    frame.agents[0].path = outside;
    frame.agents[0].workDir = outside;

    const peer = await fakeCrabCast('foreign', frame);
    const runtime = await runtimeOn(peer.socketPath);

    const result = runtime.closeAgentByKey('kan-346-diag', 'task');
    check(
      result.success === false,
      'a running pane outside the workspace tree is REFUSED as a stand-down target',
      `got ${JSON.stringify(result)}`
    );
    await sleep(250);
    check(
      peer.sent.length === 0,
      'nothing was sent at a directory Butchr never owned',
      `peer received ${JSON.stringify(peer.sent)}`
    );
  }
);

// ── §6 ─────────────────────────────────────────────────────────────────────
await section(
  '§6  IMPORTS dist — the ordinary session route is unchanged and still reports itself',
  async () => {
    // The committed fixture, unmodified: both rows are adoptable, so the
    // runtime holds sessions for them and the fallback must not be reached.
    const peer = await fakeCrabCast('adopted', CENSUS);
    const runtime = await runtimeOn(peer.socketPath);
    const address = addressOf(CENSUS.agents[0]);

    const held = runtime.getSessionByAddress(address.key, address.type);
    check(
      held !== undefined,
      `the runtime DOES hold a session for ${address.type}/${address.key} (the premise)`,
      'adoption did not run — this section would otherwise re-test §1 and claim to test §6'
    );

    const result = runtime.closeAgentByKey(address.key, address.type);
    check(
      result.success === true && result.route === 'session',
      "an adopted agent is stood down by SESSION, and says so",
      `got ${JSON.stringify(result)}`
    );
    await until(() => peer.sent.length > 0, 3_000);
    check(
      peer.sent.length === 1 && peer.sent[0] === (CENSUS.agents[0].workDir ?? CENSUS.agents[0].path),
      'and the session route still addresses the peer by the session\'s own workDir',
      `peer received ${JSON.stringify(peer.sent)}`
    );
  }
);

// ───────────────────────────────────────────────────────────────────────────
for (const fn of cleanups.reverse()) {
  try {
    fn();
  } catch {
    /* teardown */
  }
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* teardown */
}

console.log(
  `\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}`
);
process.exit(failures ? 1 : 0);
