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
// CI-RUNNABLE: yes — every section stands up its own Unix socket under os.tmpdir() and answers its own frames, and §7's first arm additionally reads daemon/src/board-reconcile.ts as text out of the checkout, which CI has; no peer, no herdr, no PTY, no credential, no network, and nothing is skipped, so a green is a green.
//
// ── WHICH SECTIONS READ WHAT, AND WHY THAT MATTERS BEFORE THE VERDICT ──────
//
// §1-§6 IMPORT FROM `dist` AND READ NOTHING ELSE. §7 IS A BLEND (KAN-516): its
// FIRST arm reads `daemon/src/board-reconcile.ts` as TEXT, and its remaining
// three import `dist` like every other section.
//
// So after a FAILED BUILD this script's exit code is a BLEND too — the
// source-text arm tested the mutation you actually wrote, and every other check
// in the file tested the PREVIOUS build. Both of those mislead on their own: a
// pass reads as "my mutation was not caught" and a fail credits this script for
// what the compiler did.
//
// ⚠ READ IT BY SECTION AND, IN §7, BY ARM — never by the exit code — unless you
// have first confirmed `npm run build` exited 0, UNPIPED, because
// `npm run build | tail` reports `tail`'s status and not the compiler's. This
// is KAN-314's third case; this file was outside it until §7's arm 0 was added
// and is squarely inside it now.
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
//   - §7 SUPPLIED ITS OWN BOARD TOO, AND ARM 0 IS WHY IT NO LONGER SUPPLIES ALL
//     OF IT (KAN-516). The board rows §7 hands `computeBoardDiff` are written
//     in this file, so the section proved the reconciler's LOGIC keeps an In
//     Review agent and was structurally unable to see its INPUT change: mutating
//     `BOARD_JQL` to `In Progress` alone — the exact work-destroying direction —
//     left all five of §7's checks GREEN, measured by `epic/KAN-39` on PR #221.
//     Arm 0 reads that constant off `daemon/src/board-reconcile.ts` as source
//     text, so the safety property is now guarded by an assertion that KNOWS it
//     is a safety property and says so when it breaks. `verify-doc-constant-pins`
//     catches the same mutation and is a genuine defence, but it fires on the
//     constant drifting from its sha256 pin in `docs/crabcast-cutover-sequence.md`
//     — so an author changing the constant DELIBERATELY regenerates the pin, the
//     ordinary and correct workflow, and at that moment nothing tells them what
//     they have just done. That defence is real and INCIDENTAL; this one is not.
//   - WHAT ARM 0 STILL DOES NOT COVER, AND NOBODY DOES: the two links between
//     the constant and the rows. `BoardReconciler`'s constructor resolves
//     `opts.jql ?? BOARD_JQL`, and `daemon.ts` constructs the production
//     reconciler passing no `jql` — so production does read the constant, but
//     NOTHING IN THIS FILE ASSERTS EITHER OF THOSE, and a caller that passed an
//     override `jql` would satisfy every check here. Nor does anything assert
//     that Jira answers that query with the rows it is claimed to. Covered by no
//     script at the time of writing; named here rather than left to inference.
//
// ── DRIVING IT RED (eight mutations, eight independent mechanisms) ─────────
//
// Mutations 1-4 and §7's A and B were applied, BUILT (exit 0, unpiped), and run
// on 2026-08-17; arm 0's C and D on 2026-08-18. The counts below are what was
// observed, not what was expected — §2's first form was rewritten because this
// drive showed it passing under its own mutation, and C's count was written down
// as 2 before the drive measured 1.
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
// ── AND §7'S TWO, WHICH ARE RUN AS A PAIR BECAUSE EITHER ALONE PROVES LITTLE ─
//
// §7 is the safety property — KAN-508's item 2 — and `epic/KAN-39` asked for it
// in this shape: *"A test that only shows a Done ticket's agent being stopped
// passes on a rule that stops everything."* So each arm is driven red by a
// mutation the OTHER arm survives, which is what establishes that the section
// discriminates rather than merely passes.
//
//   A. STOPS TOO MUCH. In `computeBoardDiff`, `continue` past any row whose
//      `statusName` is `'In Review'`, so only In Progress is desired — the
//      work-destroying regression this property exists to prevent.
//      → 3 red: `KAN-420` becomes a stand-down candidate (`toStop` is
//      `["KAN-420","KAN-504"]`). ⚠ **The discriminating arm stays GREEN.**
//   B. STOPS NOTHING. Short-circuit the `running` loop to `unchanged`, so
//      `toStop` is always empty — the opposite regression, and the one a
//      one-armed test cannot see.
//      → 2 red on the discriminating arm (`toStop` is `[]`). ⚠ **Arm 1 stays
//      GREEN**, which is precisely the failure `epic/KAN-39` named: without arm
//      2, this section would have passed a reconciler that never stops anything.
//
// ── AND ARM 0'S TWO, ADDED BY KAN-516, DRIVEN 2026-08-18 ───────────────────
//
//   C. THE INPUT, NOT THE LOGIC. In `daemon/src/board-reconcile.ts` change
//      `BOARD_JQL` from `status IN ("In Progress", "In Review")` to
//      `status IN ("In Progress")` — mutation A's work-destroying direction,
//      applied one link upstream of where A applies it. Built, exit 0, unpiped.
//      → 1 red, in arm 0: *"BOARD_JQL admits ["In Progress"]"*.
//      ⚠ **ALL FIVE CHECKS OF ARMS 1 AND 2 STAY GREEN**, and so does every
//      other section — 29 PASS, 1 FAIL over the whole file. That is the whole of
//      why arm 0 exists: this mutation is invisible to a section handed a board
//      it wrote itself, and it is the mutation `epic/KAN-39` measured surviving
//      §7 in review of PR #221. (`verify-doc-constant-pins` also goes red on it,
//      2 failures, and that defence is genuine — but it fires on the pin, not on
//      the property, so a deliberate change that regenerates the pin is silent
//      there and is not silent here.)
//   D. THE READING, NOT THE CODE. Rename the constant to `BOARD_JQL_RENAMED`
//      throughout `board-reconcile.ts` — the compiling form, value untouched —
//      so the extractor finds no declaration. Built, exit 0, unpiped.
//      → 4 red, all four of arm 0, LED BY THE POSITIVE CONTROL; the two
//      property checks report *"NOT REACHED"* rather than a finding about the
//      constant. Arms 1 and 2 stay GREEN, correctly: the value did not move.
//      Recorded because a static arm whose extractor quietly returns nothing is
//      a check that goes green forever while appearing to guard something.
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

// ── §7 ─────────────────────────────────────────────────────────────────────

/**
 * The canonical declaration of `name` in `source`: the declaring line through
 * the first line that closes the statement, or null when there is no such
 * declaration. Same shape as `verify-doc-constant-pins.mjs`'s `declarationOf`
 * and deliberately so — both need the whole STATEMENT rather than a line,
 * because `BOARD_JQL` wraps onto a second one and a line-oriented read of it
 * returns the assignment without the value.
 *
 * ⚠ Null, never an empty string. An extractor that answers "" for a constant it
 * could not find makes every assertion downstream of it pass, which is the one
 * failure a static arm cannot survive; §7 asserts on the null.
 */
function declarationOf(source, name) {
  const lines = source.split('\n');
  const opensAt = lines.findIndex((l) => new RegExp(`^\\s*export const ${name}\\b`).test(l));
  if (opensAt === -1) return null;
  for (let i = opensAt; i < lines.length && i < opensAt + 40; i++) {
    if (/;\s*$/.test(lines[i])) return lines.slice(opensAt, i + 1).join('\n');
  }
  return null;
}

/**
 * The status names a JQL declaration admits, or null when it carries no
 * `status IN (...)` list at all.
 *
 * Null rather than `[]`, and the distinction carries weight: an empty array
 * reads as "admits no status", which is indistinguishable from "this stopped
 * being a status-filtered query", and the second is a change §7 must report as
 * a failure of the READING rather than as a board that admits nothing.
 */
function statusesAdmittedBy(declaration) {
  const list = /status\s+IN\s*\(([^)]*)\)/i.exec(declaration);
  if (list === null) return null;
  return list[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']/, '').replace(/["']$/, ''))
    .filter((entry) => entry.length > 0);
}

await section(
  '§7  BLENDS source text AND dist — THE SAFETY PROPERTY: an In Review ticket keeps its agent, and a Done one does not',
  async () => {
    // ⚠ THIS SECTION IS THE ONE THAT MATTERS MOST, AND IT IS HERE BECAUSE OF
    // WHAT IT WOULD BE WITHOUT ITS SECOND ARM. `epic/KAN-39` asked for it by
    // name on KAN-508: *"A test that only shows a Done ticket's agent being
    // stopped passes on a rule that stops everything."* That is exactly right —
    // a one-armed test of a stand-down rule is satisfied by the most destructive
    // rule there is, so the arms are run together and both are required.
    //
    // The property under test is KAN-508's item 2: nothing may stand down an
    // agent whose work is unfinished. It is satisfied BY CONSTRUCTION rather
    // than by a special case — `BOARD_JQL` admits `In Progress` AND `In Review`,
    // so an In Review ticket is still DESIRED and never becomes a stand-down
    // candidate. Both halves of that are asserted here, in the direction that
    // would destroy work: ARM 0 reads the constant itself off source and says
    // the admission is there, and ARMS 1 AND 2 exercise the consequence through
    // `dist`. Until KAN-516 only the second half was checked, and the first was
    // a claim in a comment.
    //
    // It reproduces the judgement `epic/KAN-203` made by hand on 2026-08-16:
    // two agents at Done stood down, `task/kan-420` at In Review deliberately
    // left. The keys below are that incident's.

    // ── ARM 0 — READS SOURCE TEXT, NOT `dist` (KAN-516) ───────────────────
    //
    // "By construction" names an input, and arms 1 and 2 do not read it. They
    // are handed a board THIS FILE WROTE, so they prove the reconciler's logic
    // keeps an In Review row and are structurally blind to `BOARD_JQL` ceasing
    // to return one — measured: mutating the constant to `In Progress` alone
    // left all five of their checks green.
    //
    // So this arm reads the production constant off `daemon/src/board-reconcile.ts`
    // AS TEXT and asserts the property directly. It is a source-text assertion in
    // a section that otherwise imports `dist`, which makes §7 a blend — see the
    // header, and read this section by arm rather than by an exit code.
    const boardReconcileSrc = path.join(repoRoot, 'daemon', 'src', 'board-reconcile.ts');
    const declared = declarationOf(fs.readFileSync(boardReconcileSrc, 'utf8'), 'BOARD_JQL');
    check(
      declared !== null,
      'THE POSITIVE CONTROL: `export const BOARD_JQL` is found in daemon/src/board-reconcile.ts',
      `no such declaration in ${boardReconcileSrc}. Everything below this line is then a claim ` +
        `about a constant that was never read, so this is a failure of THE READING and not a ` +
        `finding about the code — repair the extractor before believing any verdict under it.`
    );
    const admits = declared === null ? null : statusesAdmittedBy(declared);
    check(
      admits !== null,
      'and it filters on a `status IN (...)` list, which is the form the two checks below read',
      declared === null
        ? 'not reached — the declaration itself was not found, see the check above'
        : `the declaration carries no \`status IN (...)\`:\n${declared}`
    );
    check(
      admits !== null && admits.includes('In Review'),
      '⚠ THE SAFETY PROPERTY, READ OFF PRODUCTION SOURCE: BOARD_JQL admits "In Review"',
      // ⚠ Two different failures, told apart deliberately. A reading that did
      // not happen is not a finding about the constant, and printing the safety
      // paragraph under it would be this file's own subject — an artifact whose
      // wording claims more than its mechanism covers.
      admits === null
        ? `NOT REACHED — BOARD_JQL was never read, see the checks above. This says nothing ` +
          `whatever about what the constant admits; repair the reading first.`
        : `BOARD_JQL admits ${JSON.stringify(admits)}. Dropping "In Review" makes an In Review ` +
          `ticket ABSENT from the board, which makes every agent working one a stand-down ` +
          `candidate: unfinished work stopped mid-flight. That is KAN-508's item 2 — nothing ` +
          `may stand down an agent whose work is unfinished — and this check exists so that ` +
          `breaking it is told to you AS a safety property, rather than as a digest that no ` +
          `longer matches a document.`
    );
    check(
      admits !== null && admits.includes('In Progress'),
      'and "In Progress", so the property is about unfinished work of both kinds',
      admits === null
        ? 'NOT REACHED — BOARD_JQL was never read, see the checks above.'
        : `BOARD_JQL admits ${JSON.stringify(admits)} — an In Progress ticket absent from the ` +
          `board makes its agent a stand-down candidate by the same route`
    );
    if (verbose) {
      console.log(`       BOARD_JQL admits: ${JSON.stringify(admits)}`);
    }

    // ── ARMS 1 AND 2 — IMPORT `dist` ──────────────────────────────────────
    const { computeBoardDiff } = await import(path.join(distDir, 'board-reconcile.js'));

    const board = [
      // Staffed and unfinished — the agent MUST survive. This is the arm that
      // fails on a rule that stops everything.
      { key: 'KAN-420', statusName: 'In Review', issueTypeName: 'Task', assignee: 'acct-1' },
      // Staffed and working — survives for the same reason, and is here so the
      // section is not a claim about In Review alone.
      { key: 'KAN-508', statusName: 'In Progress', issueTypeName: 'Task', assignee: 'acct-1' }
      // KAN-504 is DELIBERATELY ABSENT. `BOARD_JQL` returns only In Progress /
      // In Review rows, so a Done ticket is absent from the board rather than
      // present with a Done status — modelling it as a row would be modelling a
      // response Jira does not send.
    ];

    const running = [
      { agentName: 'butchr-task-kan-420', type: 'task', key: 'KAN-420' },
      { agentName: 'butchr-task-kan-508', type: 'task', key: 'KAN-508' },
      { agentName: 'butchr-task-kan-504', type: 'task', key: 'KAN-504' } // its ticket is Done
    ];

    const diff = computeBoardDiff(board, running);
    const stopping = diff.toStop.map((a) => a.key);
    const desired = diff.desired.map((a) => a.key);

    // ARM 1 — the work-destroying direction.
    check(
      !stopping.includes('KAN-420'),
      '⚠ an In Review ticket with an assignee is NOT a stand-down candidate — its agent keeps running',
      `toStop was ${JSON.stringify(stopping)} — this is the arm whose failure destroys work`
    );
    check(
      desired.includes('KAN-420'),
      'and it is positively DESIRED rather than merely spared, which is what makes it survive by construction',
      `desired was ${JSON.stringify(desired)}`
    );
    check(
      !stopping.includes('KAN-508'),
      'an In Progress ticket with an assignee is not a stand-down candidate either',
      `toStop was ${JSON.stringify(stopping)}`
    );

    // ARM 2 — the discriminating one. Without this the section passes on a rule
    // that never stops anything, which is the mirror of the failure `epic/KAN-39`
    // named and just as empty.
    check(
      stopping.includes('KAN-504'),
      '⚠ DISCRIMINATING ARM: an agent whose ticket the board does NOT carry IS a stand-down candidate',
      `toStop was ${JSON.stringify(stopping)} — without this, arm 1 would pass on a rule that ` +
        `stops nothing at all, and the section would assert nothing`
    );
    check(
      stopping.length === 1,
      'exactly one of the three is a candidate — the rule is selective, not blanket and not inert',
      `toStop was ${JSON.stringify(stopping)}`
    );
    if (verbose) {
      console.log(`       desired: ${JSON.stringify(desired)}`);
      console.log(`       toStop : ${JSON.stringify(stopping)}`);
    }
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
