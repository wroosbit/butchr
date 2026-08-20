// KAN-373: a section that did not run must not exit 0.
//
// WHAT FAILURE THIS WOULD CATCH: a partially-CI-runnable proof whose live
// section skips for want of a peer and whose process still exits 0 — so a
// caller wiring it as a gate cannot tell "the peer proved it" from "nobody
// started a peer". Six scripts in this repository held exactly that shape:
// each tallies `skipped`, and each ended `process.exit(failures ? 1 : 0)`,
// which consults the tally not at all.
//
// ── WHY A THIRD CODE, RATHER THAN FOLDING SKIPS INTO EITHER OF THE TWO ─────
//
// The two obvious repairs each destroy something real:
//
//   exit 0 (what stood here)  — 0 is the one value every shell, every CI
//     runner and every `&&` reads as "the gate held". A missing peer then
//     downgrades the gate to nothing and the build goes green. This is
//     KAN-119 with the sign flipped: there, three checks rendered a FAILURE
//     as an all-clear; here an UNRUN SECTION renders as one. Invariant 11
//     covers both — a check that renders its own failure as an all-clear is
//     worse than no check.
//
//   exit 1 (fold skip into failure) — throws away the seven sections that
//     genuinely did run and genuinely did pass. It also makes every
//     `CI-RUNNABLE: partial` script unrunnable in CI, which is the whole of
//     the value those scripts have on a runner with no herdr.
//
// So: a third code, whose meaning is the distinction itself.
//
//   0  every section ran, and every assertion passed.
//   1  at least one assertion FAILED. Loudest fact, so it wins over 2.
//   2  nothing failed, and something did not run. Green with holes.
//
// **2 is non-zero on purpose, and that is the load-bearing half.** A caller
// who writes `node verify-x.mjs` and reads the exit code gets a RED when the
// peer is absent. The caller who wants the offline sections only has to say
// so out loud — `--allow-skipped` — and that flag is then the visible,
// reviewable record of the decision. The failure this replaces is not an
// agent choosing wrongly; it is the meaning of a green being inherited from
// whichever file somebody picked up.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
//
// It does not make a skip impossible, and it must not: a skip is the honest
// report of a section that could not run, and the alternative — a section
// that quietly asserts nothing — is the defect, not the cure.
//
// It also cannot see a skip that is never tallied. A script that prints the
// word SKIP and returns, without touching a counter, passes nothing to this
// function and is invisible to it. `sweep-verify-exit-paths.mjs` §skips is
// the cover for scripts that tally and do not consult; NOTHING covers a
// script that does not tally at all, and that is stated rather than left to
// be inferred.

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_INCOMPLETE = 2;

/** The flag a caller passes to assert that it accepts an incomplete run. */
export const ALLOW_SKIPPED_FLAG = '--allow-skipped';

/**
 * A tally that is not a non-negative integer is a bug in the caller, not a
 * verdict to be rendered.
 *
 * There is no `?? 0` here, and its absence is the point: a fallback would
 * convert "this script lost track of its own skips" into "nothing was
 * skipped", which is the exact substitution this module exists to refuse.
 * Throwing exits non-zero with a stack trace — loud, and never a false pass.
 */
function tally(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `verdictFor: \`${name}\` must be a non-negative integer, got ${JSON.stringify(value)}. ` +
        `A verdict cannot be computed from a tally the script did not keep.`
    );
  }
  return value;
}

/**
 * The whole decision, as a pure function — no printing, no exiting.
 *
 * Kept separate from `reportAndExit` so the contract can be asserted across
 * its entire input space without spawning a process, which is what
 * `verify-skip-is-not-a-pass.mjs` does.
 *
 * @returns {{code: 0|1|2, headline: string, detail: string|null}}
 */
export function verdictFor({ failures, skipped, allowSkipped = false }) {
  const f = tally('failures', failures);
  const s = tally('skipped', skipped);

  // A failure outranks a skip. A run that both failed and skipped is a FAILING
  // run; reporting it as merely incomplete would be the softer of two true
  // statements, and the softer reading is how this class survives review.
  if (f > 0) {
    return {
      code: EXIT_FAIL,
      headline: `${f} assertion(s) failed`,
      detail: s > 0 ? `${s} section(s) were also skipped and proved nothing.` : null
    };
  }

  if (s === 0) {
    return { code: EXIT_PASS, headline: 'All assertions passed', detail: null };
  }

  if (allowSkipped) {
    return {
      code: EXIT_PASS,
      headline: `Every assertion that RAN passed — ${s} section(s) did not run`,
      detail:
        `Exiting 0 because the caller passed ${ALLOW_SKIPPED_FLAG}, which asserts that an ` +
        `incomplete run is acceptable HERE. The skipped section(s) above proved nothing; ` +
        `read them before treating this 0 as cover for what they would have checked.`
    };
  }

  return {
    code: EXIT_INCOMPLETE,
    headline: `INCOMPLETE — no assertion failed, but ${s} section(s) did not run`,
    detail:
      `Exiting ${EXIT_INCOMPLETE}: a skip is not a pass, and nothing here has checked what ` +
      `the skipped section(s) cover. Read them above. If an incomplete run is acceptable to ` +
      `this caller, say so with ${ALLOW_SKIPPED_FLAG} and it will exit ${EXIT_PASS} instead.`
  };
}

/**
 * Render the verdict and exit on it. The last line of a `verify-` script.
 *
 * `exit` is injectable for the same reason `verdictFor` is pure: so a proof of
 * this contract can observe the code without dying of it.
 *
 * `allowSkipped` normally comes from the command line, but a script may pass
 * it explicitly to declare an assertion its OWN flags already made. Two
 * scripts here take `--static-only`, which is precisely the caller saying "run
 * the offline sections and no others" — the same statement `--allow-skipped`
 * makes, spelled in that script's own vocabulary. Making them say it twice
 * would be a papercut that teaches agents to pass the flag reflexively, which
 * is how an explicit assertion decays back into an inherited one.
 */
export function reportAndExit({
  failures,
  skipped,
  allowSkipped,
  argv = process.argv,
  log = console.log,
  exit = process.exit
}) {
  const allowed = allowSkipped === undefined ? argv.includes(ALLOW_SKIPPED_FLAG) : allowSkipped;
  const { code, headline, detail } = verdictFor({ failures, skipped, allowSkipped: allowed });
  const colour = code === EXIT_PASS ? '\x1b[32m' : code === EXIT_FAIL ? '\x1b[31m' : '\x1b[33m';
  log(`${colour}${headline}\x1b[0m`);
  if (detail !== null) log(`  ${detail}`);
  return exit(code);
}
