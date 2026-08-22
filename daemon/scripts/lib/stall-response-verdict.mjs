// KAN-643: deciding what a PSI response to an induced I/O load means — and, in
// particular, telling "the instrument is broken" apart from "this host could
// not supply the input".
//
// WHAT FAILURE THIS WOULD CATCH: a required CI check that renders a host it
// could not stall as a FAILING instrument. `verify-io-stall-gate.mjs` §2
// induces a real I/O stall and asserts that PSI moved. Its bar was
//
//     peakSome > Math.max(5, baseline * 1.5)
//
// and the multiplicative arm is the defect: it makes the response you must
// produce PROPORTIONAL TO THE NOISE ALREADY ON THE BOX. On a quiet developer
// machine `baseline` is 0.00 and the bar is the 5-point floor; on a
// shared-tenant CI runner with a neighbour already using the device the
// baseline is high and the bar rises with it — while `some` is bounded at 100%
// and a saturated device has LESS headroom to stall further, not more. The bar
// is therefore hardest to clear exactly where the machine is least able to
// clear it, which is the regime CI runs in.
//
// Measured, first-hand, on PR #278 head `0d4d18f0`, run `32532687840`
// attempt 1 (captured by `task/KAN-597` before the re-run erased it):
//
//     before 19.19%   peak 27.16%
//     bar = max(5, 19.19 * 1.5) = 28.79   ->  27.16 < 28.79  ->  RED
//
// PSI moved +7.97 points under that load. The claim §2 announces is that PSI
// "is measuring something and not a constant", and a +7.97-point excursion is
// not a constant by any reading. **That red was false**: the instrument worked
// and the bar was miscalibrated for a loaded host. Attempt 2, on the identical
// tree, went green — so the check was non-deterministic in the host, not in the
// code, and `verify-runnable-set` is a required status.
//
// ── WHY A MARGIN IN POINTS, AND NOT A RATIO ───────────────────────────────
//
// The question §2 asks is "did this instrument move when I stalled the disk".
// That is a question about an EXCURSION, and an excursion is measured in the
// units of the thing that excurses. A ratio silently asks a second question —
// "did it move by a lot RELATIVE TO whatever else is happening on this box" —
// which is a question about the neighbours and not about the instrument.
//
// So this module has TWO ARMS, split on the baseline, and the split is the
// whole design:
//
//   baseline < 5%   the original expression, evaluated unchanged, strict `>`
//                   and all. Every green this check has ever produced came
//                   from a machine in this range, and none of them moves.
//   baseline >= 5%  somebody else is already stalling the device. The
//                   excursion is measured in points, and a response too small
//                   to read is a SKIP rather than a verdict about PSI.
//
// **Nothing about the quiet-machine verdict changes**, and `§4` of
// `verify-stall-response-verdict.mjs` asserts that as an equality across the
// whole quiet range rather than asking to be believed. That section earned its
// place immediately: an earlier draft applied the additive margin at every
// baseline, and §4 caught that between 3.33% and 5% the multiplicative arm is
// the MILDER bar — so the "fix" was silently stricter there and would have
// shipped a second flake inside the repair for the first.
//
// ── THE DISCRIMINATOR, AND WHAT IT DELIBERATELY DOES NOT CLAIM ────────────
//
// When the response is BELOW the margin there are two live explanations and
// they need opposite verdicts:
//
//   * the instrument is not reading what it claims to  -> FAIL, loudly
//   * a neighbour already owns the device, so the premise of the section — a
//     quiet disk we stall on purpose — was never available  -> SKIP
//
// `baseline` separates them, and the margin is reused as the boundary rather
// than a second constant being invented: the margin is the smallest excursion
// this module is willing to call a response, so a baseline BELOW it is a box
// quiet enough that a real response would have been visible, and a baseline AT
// OR ABOVE it is a box that already had that much stall on it from somewhere
// this script did not put it.
//
// ⚠ WHAT THAT LEAVES UNCOVERED, STATED RATHER THAN LEFT TO BE INFERRED: an
// instrument stuck at a CONSTANT HIGH value — always reporting, say, 30% — is
// classified `host-already-stalled` and skipped, not failed. That is a real
// hole and it is accepted deliberately, because the alternative (failing on a
// high baseline) is the false red this module exists to remove. It is bounded
// by the exit code rather than by an assertion: a skip is EXIT_INCOMPLETE (2),
// which is non-zero, so such a host still cannot render a green. Nothing here
// covers it turning into a pass, because nothing here can make it one.
//
// ── AND THE INPUT THAT WAS NEVER CHECKED AT ALL ───────────────────────────
//
// §2 blamed PSI for a load it never confirmed had run. Eight `dd` writers can
// fail as one — a full disk, a read-only temp dir, no `dd` on the PATH — and
// every one of those arrives at the assertion as "PSI did not respond". That is
// the brief's *a proof that supplies its own input has not tested that the
// input arrives*, read from the other side: before blaming the instrument for a
// silence, confirm something was said to it. `loadApplied: false` is therefore
// a SKIP naming the load, and never a verdict about PSI.

/**
 * The smallest excursion, in percentage points of `io some`, that this module
 * is willing to call a response — and, reused, the baseline at or above which
 * the box is judged to have been stalled by somebody else already.
 *
 * 5 is not new. It is the floor the original bar already carried as
 * `Math.max(5, …)`, kept at its measured value so that a quiet machine's
 * verdict is bit-for-bit the one it has always given.
 */
export const RESPONSE_MARGIN_POINTS = 5;

export const RESPONDED = 'responded';
export const FLAT = 'flat';
export const HOST_ALREADY_STALLED = 'host-already-stalled';
export const LOAD_NOT_APPLIED = 'load-not-applied';
export const UNREADABLE = 'unreadable';

/** The outcomes that mean a section did not run, rather than ran and failed. */
const SKIP_OUTCOMES = new Set([HOST_ALREADY_STALLED, LOAD_NOT_APPLIED]);

/**
 * A figure that is not a finite number is a broken read, not a quiet machine.
 *
 * There is no `?? 0` here, and its absence is the point — the same absence, for
 * the same reason, as the one in `lib/verdict-exit.mjs`. `/proc/pressure/io`
 * that does not match the expected shape yields NaN, and a NaN coerced to 0
 * would read as "a perfectly quiet disk" forever.
 */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The whole decision, as a pure function — no printing, no exiting, no I/O.
 *
 * Kept pure so the contract can be asserted across its entire input space
 * without inducing a single byte of real disk load, which is what
 * `verify-stall-response-verdict.mjs` does. That matters more here than it
 * usually would: exercising this decision for real means deliberately stalling
 * a shared machine, and on a box carrying a live agent fleet that crosses
 * `STALL_REFUSE_PERCENT` and refuses every new agent start for the duration.
 * The arithmetic is the same arithmetic; only the blast radius differs.
 *
 * @param {object} o
 * @param {number} o.baseline      `io some` avg10 before the load, in percent.
 * @param {number} o.peak          the highest `io some` avg10 seen under load.
 * @param {boolean} o.loadApplied  did the induced load actually run?
 * @returns {{outcome: string, isSkip: boolean, response: number|null, headline: string}}
 */
export function stallResponseVerdict({ baseline, peak, loadApplied = true }) {
  if (!finite(baseline) || !finite(peak)) {
    return {
      outcome: UNREADABLE,
      isSkip: false,
      response: null,
      headline:
        `/proc/pressure/io did not yield a number (before ${JSON.stringify(baseline)}, ` +
        `peak ${JSON.stringify(peak)}). The file exists — it is being parsed and is not ` +
        'producing a figure, which is an instrument fault and not a quiet disk.'
    };
  }

  if (!loadApplied) {
    return {
      outcome: LOAD_NOT_APPLIED,
      isSkip: true,
      response: peak - baseline,
      headline:
        'the induced load did not run, so nothing was asked of PSI and its silence ' +
        'means nothing. This is a skip about the load, never a verdict about the instrument.'
    };
  }

  const response = peak - baseline;

  // ── THE QUIET ARM: BIT-IDENTICAL TO THE BAR THIS REPLACED ────────────────
  //
  // Below the boundary the original expression is evaluated unchanged, down to
  // its strict `>`. That is deliberate and it is the load-bearing half of the
  // claim that this change is a repair rather than a loosening: every green
  // this check has ever produced came from a developer machine sitting at a
  // baseline of roughly zero, and on those machines the verdict here is the one
  // they have always given — not a near-equivalent, the same expression.
  // `verify-stall-response-verdict.mjs` §4 asserts that equality over the whole
  // quiet range rather than leaving it to be believed.
  //
  // An earlier draft of this module used the additive margin at every baseline.
  // It was caught by that section: at baselines between 3.33% and 5% the
  // multiplicative arm is a *milder* bar than `baseline + 5`, so the additive
  // rule was quietly STRICTER there and would have introduced new reds on
  // slightly-busy developer machines — a second flake, shipped inside the fix
  // for the first.
  if (baseline < RESPONSE_MARGIN_POINTS) {
    if (peak > Math.max(RESPONSE_MARGIN_POINTS, baseline * 1.5)) {
      return {
        outcome: RESPONDED,
        isSkip: false,
        response,
        headline:
          `PSI moved with a real induced stall on real hardware (${baseline.toFixed(2)}% → ` +
          `${peak.toFixed(2)}%, +${response.toFixed(2)} points), so it is measuring something ` +
          'and not a constant.'
      };
    }
    return {
      outcome: FLAT,
      isSkip: false,
      response,
      headline:
        `PSI did not respond to a deliberate 8-way synchronous-direct-write load on a box ` +
        `that was quiet before it (before ${baseline.toFixed(2)}%, peak ${peak.toFixed(2)}%, ` +
        `+${response.toFixed(2)} points). The disk was idle enough for a real response to ` +
        'have been visible, so the instrument is not reading what it claims to.'
    };
  }

  // ── THE LOADED ARM: WHERE THE MULTIPLICATIVE BAR WAS UNUSABLE ────────────
  //
  // At or above the boundary somebody else is already stalling this device, and
  // `baseline * 1.5` has stopped being a test of the instrument: it asks the
  // disk to absorb an excursion proportional to the neighbour's traffic. Here
  // the excursion is measured in points, and a response too small to read is
  // reported as what it is — a host that could not supply the section's input —
  // rather than as a verdict about PSI.
  if (response >= RESPONSE_MARGIN_POINTS && peak >= RESPONSE_MARGIN_POINTS) {
    return {
      outcome: RESPONDED,
      isSkip: false,
      response,
      headline:
        `PSI moved with a real induced stall on real hardware (${baseline.toFixed(2)}% → ` +
        `${peak.toFixed(2)}%, +${response.toFixed(2)} points), so it is measuring something ` +
        'and not a constant — and it did so on a host that was already busy.'
    };
  }

  return {
    outcome: HOST_ALREADY_STALLED,
    isSkip: true,
    response,
    headline:
      `this host was already ${baseline.toFixed(2)}% I/O-stalled before the load was ` +
      `applied, and the load moved it only to ${peak.toFixed(2)}% (+${response.toFixed(2)} ` +
      'points). A neighbour already owns this device, so the section\'s premise — a quiet ' +
      'disk stalled on purpose — was never available here. Nothing is claimed about PSI ' +
      'either way.'
  };
}

/** True when this outcome means the section did not run. */
export function isSkipOutcome(outcome) {
  return SKIP_OUTCOMES.has(outcome);
}
