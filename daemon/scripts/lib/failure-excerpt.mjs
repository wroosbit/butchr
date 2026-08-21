// KAN-576: the excerpt a failing child's output is reduced to, and the reason
// the reduction is not allowed to be silent.
//
// `run-ci-verify-set.mjs` cannot print every line of every failing child — a
// long proof emits fifty lines and the set holds well over a hundred scripts —
// so it prints a window. Until this module that window was the last 25 lines
// and nothing else:
//
//     const tail = out.split('\n').slice(verbose && ok ? -3 : -25).join('\n');
//
// A proof whose failure is anywhere but the end therefore produced a CI red in
// which NO ASSERTION WAS NAMED. Measured on
// `verify-runtime-pin-spares-test-daemons.mjs` (run 32456060343): its §2
// assertion failed, §2 sits eight lines in, and what reached the log was seven
// PASS lines, `16/17 checks passed` and `1 FAILURE(S)`. Which check broke was
// unrecoverable from the run — `task/KAN-574` found it by reading this harness's
// source and reproducing locally, which is a diagnosis path for somebody who
// already suspects the harness and not one for somebody reading a red on a PR.
//
// THE DEFECT IS THE SILENCE, NOT THE WINDOW. A reduced output that says it was
// reduced sends its reader to the right place; the truncated report above is
// well-formed, ends tidily, and shows a screenful of green. Nothing in it says
// "the part you need was cut" — it degrades toward LOOKING FINISHED, which is
// this epic's recurring shape and the reason KAN-423, KAN-425 and KAN-471 are
// all the same ticket wearing different surfaces. The through-line this board
// keeps re-deriving: **a response that was reduced must say so.**
//
// SO THE NOTICE IS UNCONDITIONAL AND THE RESCUE IS NOT. Two mechanisms, and
// keeping them apart is the whole design:
//
//   * `… N line(s) not shown` is emitted whenever N > 0, from arithmetic over
//     the line count. It depends on no convention, no marker and no cooperation
//     from the script being run. It cannot be wrong about a script nobody has
//     written yet.
//   * Rescuing the lines that match `FAILURE_MARKER` out of the dropped region
//     is BEST EFFORT ON TOP. It is what turns "27 lines not shown" into the
//     assertion itself, and it works because 90 of the `FAIL` literals in this
//     tree agree on the word. A script that names its failure some other way
//     loses the rescue and KEEPS THE NOTICE, which is the degradation this
//     module is willing to have.
//
// The honesty must not rest on the heuristic, because a heuristic over other
// people's output is exactly the "convention no other script follows and nothing
// enforces" that KAN-576 was filed to avoid instituting.
//
// WHY THE NOTICES ARE IN THE RETURNED LINES RATHER THAN BESIDE THEM. `dropped`
// is also returned, and a caller could print the lines and forget it. It cannot:
// the notice is spliced into `lines` at the gap it describes, so there is no way
// to print this excerpt WITHOUT printing that it is one. `prompts/task.md`:
// reach for the type when the invariant is about what the code is able to say.
// The counts travel alongside for a caller that wants to assert on them, never
// as the only place they appear.
//
// NOT A `verify-` SCRIPT: it asserts nothing and exits nowhere. Its red drive
// lives in `verify-failure-excerpt-names-the-assertion.mjs`, which drives both
// mechanisms red separately and then runs the real harness over a fixture whose
// failure sits at the top.

/**
 * A line that names a failure, by the vocabulary this tree actually uses.
 *
 * Measured over every `verify-*.mjs` under the two swept directories rather than
 * chosen: `FAIL` 90, `✗` 10, `FAILURE(S)` 10, `FAILED` 8, `ERROR` 3,
 * `UNEXPECTED` 2. The word boundary is what keeps `PASS` lines and ordinary
 * prose out; a false positive costs one printed line, and a false NEGATIVE
 * costs the rescue — so this leans permissive on purpose.
 *
 * It is deliberately NOT exhaustive and is not documented anywhere as a
 * contract a script must meet. Nothing is required to match it. The notice
 * below is what covers the scripts that do not.
 */
export const FAILURE_MARKER = /\b(FAIL|FAILS|FAILED|FAILURE|FAILURES|ERROR|ERRORS|MISMATCH|UNEXPECTED|REFUSED)\b|[✗✘❌]/;

/** How many rescued lines are worth printing before the rescue is itself noise. */
const RESCUE_CEILING = 40;

/**
 * Lines kept after each rescued one.
 *
 * A marker line names the assertion; the line under it is usually what the
 * assertion expected and got. Rescuing the first without the second gives a
 * reader the name of a check and no reason for it, which is a smaller version
 * of the defect this module exists for. Two, because the shape in this tree is
 * `FAIL  <name>` / `expected …` / `got …`.
 */
const RESCUE_CONTEXT = 2;

/**
 * Reduce a child's output to something printable that admits what it dropped.
 *
 * Returns `{ lines, total, shown, dropped, rescued }`. `lines` is ready to
 * print — gap notices already spliced in, no indentation applied — and is the
 * only thing a caller needs; the counts are for a test that wants to assert on
 * the arithmetic rather than scrape the prose.
 *
 * @param {string} out       the child's combined stdout and stderr
 * @param {number} tail      how many trailing lines to keep unconditionally
 * @param {boolean} rescue   also lift failure-marked lines out of the dropped region
 */
export function failureExcerpt(out, { tail = 25, rescue = true } = {}) {
  const text = out.trimEnd();
  if (text === '') return { lines: [], total: 0, shown: 0, dropped: 0, rescued: 0 };

  const lines = text.split('\n');
  const total = lines.length;

  // The tail window, always kept. `tail <= 0` is a caller asking for nothing but
  // the notice, which is a legitimate thing to ask for and must not underflow
  // into "keep everything" the way a bare negative slice would.
  const tailFrom = tail <= 0 ? total : Math.max(0, total - tail);
  const keep = new Set();
  for (let i = tailFrom; i < total; i++) keep.add(i);

  // Everything above the window that names a failure, up to the ceiling. Past
  // the ceiling the remainder is simply not kept, and the gap arithmetic below
  // reports it as dropped — the count stays true without a special case.
  let rescued = 0;
  if (rescue) {
    for (let i = 0; i < tailFrom && rescued < RESCUE_CEILING; i++) {
      if (!FAILURE_MARKER.test(lines[i])) continue;
      keep.add(i);
      rescued++;
      // Its detail, where there is any still above the window.
      for (let j = i + 1; j <= i + RESCUE_CONTEXT && j < tailFrom; j++) keep.add(j);
    }
  }

  const shown = keep.size;
  const dropped = total - shown;

  // Walk in source order, replacing each run of dropped lines with a notice
  // naming its size. Source order matters: a rescued §2 failure printed above
  // the tail it was lifted out of reads as the report it came from.
  const rendered = [];
  let gap = 0;
  let gapStart = 0;
  const flush = () => {
    if (gap === 0) return;
    rendered.push(`… ${gap} ${gapStart === 0 ? 'earlier ' : ''}line(s) not shown`);
    gap = 0;
  };
  for (let i = 0; i < total; i++) {
    if (keep.has(i)) {
      flush();
      rendered.push(lines[i]);
    } else {
      if (gap === 0) gapStart = i;
      gap++;
    }
  }
  flush();

  return { lines: rendered, total, shown, dropped, rescued };
}
