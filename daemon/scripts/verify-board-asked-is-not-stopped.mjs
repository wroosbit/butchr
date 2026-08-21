#!/usr/bin/env node
/**
 * verify-board-asked-is-not-stopped
 *
 * WHAT FAILURE THIS WOULD CATCH: the board reporting `[board] stood down
 * <agent>` — a flat past tense — for a stand-down the runtime only ASKED for.
 * On the workspace route `closeAgentByWorkspace` returns `success: true`
 * meaning *asked, not stopped*, and says so in its own log: "the slot is
 * released when CrabCast actually stops it, which the next census tick shows".
 * The board stated the outcome the runtime had just declined to guarantee.
 *
 * `epic/KAN-203` measured eight agents holding 8 of 10 slots while that line
 * was emitted every cycle for three cycles — 48 times in 60k of log — with
 * nothing reaped, and was misled twice in five minutes by it: once into "the
 * reconciler is stuck in a loop", once into the opposite. Only the untruncated
 * runtime line settled it (KAN-552, 2026-08-21).
 *
 * ⚠ THE INFORMATION WAS NEVER MISSING. `deactivate_response` already carried
 * `standDownRoute`; `DeactivateOutcome` had no field to receive it, so
 * `daemon.ts`'s adapter dropped it and the board could not have distinguished
 * the two cases had it wanted to. This proof therefore asserts on BOTH halves:
 * that the seam carries the route, and that the sentence changes with it.
 *
 * ⚠ WHAT IT DOES NOT COVER, AND WHO DOES. This drives `reconcileOnce` with a
 * stubbed `deactivate`, so it proves the BOARD's rendering of an outcome — not
 * that the real router ever sets `standDownRoute: 'workspace'`. That half is
 * `router.ts`'s `standDownRoute` mapping and the live behaviour `epic/KAN-203`
 * measured; nobody covers the join between them, and this header is the edge
 * of what this script establishes.
 */

// CI-RUNNABLE: yes — imports the built `board-reconcile.js` and drives it with
// in-process stubs. It points `HOME` at a temp dir and touches nothing else: no
// herdr, no CrabCast, no PTY, no network, no Jira, no wall clock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.env.BUTCHR_DIST
  ? path.resolve(process.env.BUTCHR_DIST)
  : path.join(repoRoot, 'daemon', 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan552-board-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const { BoardReconciler, BOARD_JQL } = await import(path.join(distDir, 'board-reconcile.js'));

let failures = 0;
const check = (ok, what, detail) => {
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
};

const ME = '712020:619ec5ec-me';
const agent = (type, key) => ({ agentName: `butchr-${type}-${key.toLowerCase()}`, type, key });

/**
 * One converge cycle whose `deactivate` answers with the given outcome.
 *
 * The board is EMPTY, so every running agent is desired-off and lands in
 * `toStop` — which is the state that produced the specimen: tickets Done,
 * agents still up.
 */
async function cycleWith(outcome) {
  const log = [];
  const reconciler = new BoardReconciler({
    // `{ ok: true, issues: [] }` — an EMPTY board that was read, which is not
    // the same answer as a board that could not be read. Getting this shape
    // wrong returns `ok: undefined`, the reconciler correctly converges nothing,
    // and every assertion below goes red describing a rendering that never ran.
    // Guarded explicitly further down rather than left to be diagnosed.
    jira: { async searchBoard() { return { ok: true, issues: [] }; } },
    runningAgents: () => [agent('task', 'KAN-525')],
    activate: async () => ({ success: true }),
    deactivate: async () => outcome,
    mode: () => 'converge',
    isSupervisorType: (type) => type === 'epic' || type === 'story',
    log: (...args) => log.push(args.join(' '))
  });
  const cycle = await reconciler.reconcileOnce();
  const out = log.join('\n');

  // ⚠ A FIXTURE THAT DID NOT CONVERGE IS NOT A VERDICT ABOUT THE SENTENCE
  // (KAN-552, the lesson from #263). If the board could not be read, or nothing
  // reached `toStop`, then no stand-down line was ever rendered and every
  // assertion below would go red describing behaviour that never ran — naming
  // the wrong suspect exactly as the script this repairs once did. Say so and
  // stop, rather than reporting a verdict this run did not earn.
  if (cycle.refusal || !cycle.stopped.length) {
    console.error(
      `INCOMPLETE: the reconciler stood nothing down, so no stand-down line was rendered ` +
        `and nothing about its wording was exercised. refusal=${JSON.stringify(cycle.refusal)} ` +
        `stopped=${cycle.stopped.length}. This is the fixture, NOT a finding about the code.`
    );
    process.exit(2);
  }
  return out;
}

console.log('\n1. THE WORKSPACE ROUTE IS REPORTED AS A REQUEST, NOT A COMPLETION');
{
  const out = await cycleWith({ success: true, standDownRoute: 'workspace' });

  check(
    /ASKED the runtime to stand down/.test(out),
    'the line says it ASKED — the verb the runtime actually earned',
    out.slice(0, 300)
  );
  check(
    !/\[board\] stood down /.test(out),
    'and it does NOT claim `[board] stood down`, which states an outcome nothing verified',
    out.slice(0, 300)
  );
  check(
    /next census tick/.test(out),
    'it carries the runtime’s own falsifiable promise, so the claim can be checked later',
    out.slice(0, 300)
  );
  check(
    /held no session/.test(out),
    'and it names WHY the route was taken, rather than leaving it to be inferred',
    out.slice(0, 300)
  );
}

console.log('\n2. THE SESSION ROUTE KEEPS THE PAST TENSE — it earned it');
{
  const out = await cycleWith({ success: true });
  check(
    /\[board\] stood down /.test(out),
    'a stand-down this daemon actually performed still reports as done',
    out.slice(0, 300)
  );
  check(
    !/ASKED the runtime/.test(out),
    'and it is NOT softened — vagueness everywhere would be the other way to lose the distinction',
    out.slice(0, 300)
  );
}

console.log('\n3. A REFUSAL IS STILL A REFUSAL');
{
  const out = await cycleWith({ success: false, error: 'no session this daemon started matches it' });
  check(
    /could not stand down/.test(out),
    'an outright failure is unchanged by any of this',
    out.slice(0, 300)
  );
}

console.log('');
if (failures) {
  console.log(`${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('All assertions passed');
process.exit(0);
