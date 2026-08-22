// Proof for KAN-643: the PSI-response decision in `verify-io-stall-gate.mjs` §2
// separates a broken instrument from a host that could not supply the input,
// and never renders either as a pass.
//
// WHAT FAILURE THIS WOULD CATCH: a required CI check going red on a healthy
// tree because the runner's disk was already busy. `verify-runnable-set` is a
// required status, and `verify-io-stall-gate.mjs` §2 sat inside it asserting
//
//     peakSome > Math.max(5, baseline * 1.5)
//
// which demands a stall response PROPORTIONAL TO THE NOISE ALREADY ON THE BOX.
// Measured on PR #278 head `0d4d18f0`, run `32532687840` attempt 1: a runner
// already 19.19% I/O-stalled needed 28.79% and reached 27.16%, so a +7.97-point
// excursion — an instrument working exactly as advertised — was reported as
// "PSI did not respond … the instrument is not reading what it claims to", and
// merges were blocked fleet-wide until somebody re-ran the job. Attempt 2 on
// the identical tree passed.
//
// ALSO CAUGHT, and it is the same defect with the sign flipped: a host that
// cannot run the section at all rendering as a PASS. Until KAN-643 that script
// tallied failures and nothing else, so on a runner with no /proc/pressure §2
// and §6 skipped by printing a line, touched no counter, and the script exited
// 0 — a green with two holes in it, byte-identical to a full pass.
//
// CI-RUNNABLE: yes — pure arithmetic over a decision function. It induces no
// I/O, spawns nothing, reads no /proc, and imports nothing from dist. That is
// deliberate and is the point of the module being pure: exercising this
// decision for real means deliberately stalling a shared machine, which on a
// box carrying a live agent fleet crosses STALL_REFUSE_PERCENT and refuses
// EVERY new agent start for as long as it runs. This script covers the whole
// input space at zero blast radius; §2 still does the real thing on a host that
// can supply it, and nothing here replaces that.
//
// Five sections:
//
//   1. the regression   — the runner's own measured figures, which used to be
//                         red and must now be a pass, plus the old bar
//                         evaluated alongside to show the change is the fix
//                         rather than a coincidence
//   2. the discriminator— flat instrument vs already-owned disk vs load that
//                         never ran, each to its own outcome
//   3. no false pass    — swept across the input space: nothing below the
//                         margin is ever RESPONDED, and every skip outcome is
//                         non-zero through lib/verdict-exit.mjs
//   4. quiet-box parity — on a quiet box this module's verdict is identical to
//                         the bar it replaced, over the whole range. The change
//                         must not have moved the calibration every green this
//                         check has ever produced came from
//   5. can it fail      — the discriminator deleted, three ways. If the battery
//                         still passes it proves nothing and this script exits red
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED:
// every figure below is a number this file wrote, except §1's, which are
// `task/KAN-597`'s first-hand reading of attempt 1's log quoted on KAN-643. So
// this proves the ARITHMETIC is right and does not prove that real figures
// reach it. The seam between "this host read 19.19%" and "the decision saw
// 19.19%" is covered by `verify-io-stall-gate.mjs` §2 itself, which passes
// `stallResponseVerdict` a baseline and peak it sampled from this machine's own
// /proc/pressure — and by its `load actually applied: N bytes` line, which is
// the arriving input made visible. Neither script covers the third thing:
// **nobody has watched this decision run on a genuinely shared-tenant runner**,
// because that is the machine we do not have. §1 is a replay of one, from a log
// that no longer exists, and it is the closest thing available.
//
// HOW TO WATCH IT GO RED — these three were run and the sections named are the
// ones that ACTUALLY went red, not the ones that looked likely:
//   node scripts/verify-stall-response-verdict.mjs          # exit 0 first
//   # 1. restore the old bar on the loaded arm: in
//   #    lib/stall-response-verdict.mjs replace
//   #      if (response >= RESPONSE_MARGIN_POINTS && peak >= RESPONSE_MARGIN_POINTS) {
//   #    with
//   #      if (peak > Math.max(RESPONSE_MARGIN_POINTS, baseline * 1.5)) {
//   #    -> sections 1, 2 and 3 fail; 3 assertions; exit 1.
//   # 2. delete the arm split: replace `if (baseline < RESPONSE_MARGIN_POINTS) {`
//   #    with `if (false) {`, so every short response is excused as a busy host.
//   #    -> sections 2, 3 and 4 fail; 4 assertions; exit 1.
//   # 3. make a skip report itself as not-a-skip: set `isSkip: false` on the
//   #    HOST_ALREADY_STALLED return.
//   #    -> sections 2 and 3 fail; exit 1.
//   # Then restore the file and confirm exit 0 again.
//
// ⚠ A NOTE ON HOW MUTATION 3 NEARLY GOT WRITTEN DOWN AS UNCAUGHT. The first
// attempt applied it with a text anchor that matched nothing. The `python`
// that applied it raised, the `node` after it ran anyway, and the run reported
// EXIT=0 — for the UNMUTATED module, because the harness had already restored
// it. Read as "mutation 3 is not caught", which is the comfortable direction.
// It is this repository's own `a check bundled behind something else may not
// have run at all` wearing a mutation harness: the assertion that the mutation
// landed has to be its own failing step, and mutation 3 is now applied by line
// number with the line's content asserted before it is touched.
//
// Usage:
//   cd daemon && node scripts/verify-stall-response-verdict.mjs

import {
  stallResponseVerdict,
  isSkipOutcome,
  RESPONSE_MARGIN_POINTS,
  RESPONDED,
  FLAT,
  HOST_ALREADY_STALLED,
  LOAD_NOT_APPLIED,
  UNREADABLE
} from './lib/stall-response-verdict.mjs';
import { verdictFor, EXIT_PASS } from './lib/verdict-exit.mjs';
import { reportAndExit } from './lib/verdict-exit.mjs';

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

/** The bar this module replaced, kept executable so §1 and §4 can compare. */
const oldBar = (baseline, peak) => peak > Math.max(5, baseline * 1.5);

// ------------------------------------------------------- 1. the regression --
rule('1. THE REGRESSION — the runner\'s own figures, which used to block merges');

// task/KAN-597 read these from attempt 1's log before the re-run erased it.
// They are the only surviving copy; the description of KAN-643 records that
// `gh run view --log` now returns attempt 2 with no marker that attempt 1 existed.
const RUNNER = { baseline: 19.19, peak: 27.16 };
const runner = stallResponseVerdict({ ...RUNNER, loadApplied: true });

console.log(
  `  attempt 1, PR #278 head 0d4d18f0, run 32532687840\n` +
    `    before        ${RUNNER.baseline}%\n` +
    `    peak          ${RUNNER.peak}%\n` +
    `    response      +${(RUNNER.peak - RUNNER.baseline).toFixed(2)} points\n\n` +
    `    old bar       max(5, ${RUNNER.baseline} * 1.5) = ` +
    `${Math.max(5, RUNNER.baseline * 1.5).toFixed(2)}%  -> ` +
    `${oldBar(RUNNER.baseline, RUNNER.peak) ? 'pass' : 'RED'}\n` +
    `    this module   ${runner.outcome}`
);

verdict(
  oldBar(RUNNER.baseline, RUNNER.peak) === false,
  'the bar this module replaced does go red on these figures, so §1 is testing the\n' +
    '    defect that was actually reported and not a hypothetical one. Without this the\n' +
    '    section below could pass for a reason unrelated to the change.',
  'the old bar PASSES the runner\'s figures, so the reported failure is not reproduced ' +
    'here and every conclusion §1 draws is about something else. Check the constants ' +
    'against KAN-643 before reading further.'
);

verdict(
  runner.outcome === RESPONDED,
  `the same figures are now ${RESPONDED}: PSI moved +7.97 points, which is the claim §2\n` +
    '    announces — "measuring something and not a constant". The red was false, and this\n' +
    '    is the assertion that keeps it from coming back.',
  `the runner's figures are ${runner.outcome}, not ${RESPONDED}. This ticket's flake is not ` +
    'fixed: a healthy tree on a shared-tenant runner still blocks merges on a required check.'
);

// ---------------------------------------------------- 2. the discriminator --
rule('2. THE DISCRIMINATOR — three ways a short response happens, three verdicts');

const CASES = [
  {
    what: 'quiet disk, instrument flat',
    input: { baseline: 0, peak: 0, loadApplied: true },
    expect: FLAT,
    why: 'the disk was idle enough for a response to have been visible and none came'
  },
  {
    what: 'quiet disk, instrument stuck just under the margin',
    input: { baseline: 0.4, peak: 3.1, loadApplied: true },
    expect: FLAT,
    why: 'still a quiet box; 2.7 points is not a response and the box cannot excuse it'
  },
  {
    what: 'neighbour already owns the disk',
    input: { baseline: 40, peak: 42, loadApplied: true },
    expect: HOST_ALREADY_STALLED,
    why: 'the premise — a quiet disk we stall on purpose — was never available'
  },
  {
    what: 'the runner, had it been far more loaded',
    input: { baseline: 19.19, peak: 21.0, loadApplied: true },
    expect: HOST_ALREADY_STALLED,
    why: 'a short response on a busy box says nothing about PSI either way'
  },
  {
    what: 'dd never started',
    input: { baseline: 0, peak: 0, loadApplied: false },
    expect: LOAD_NOT_APPLIED,
    why: 'nothing was asked of PSI, so its silence is not evidence about PSI'
  },
  {
    what: 'dd never started ON A BUSY BOX',
    input: { baseline: 40, peak: 40, loadApplied: false },
    expect: LOAD_NOT_APPLIED,
    why: 'the load is checked before the host is, so the more specific reason is the one reported'
  },
  {
    what: 'pressure file unparseable',
    input: { baseline: NaN, peak: NaN, loadApplied: true },
    expect: UNREADABLE,
    why: 'a NaN is a broken read; coerced to 0 it would read as a perfectly quiet disk forever'
  },
  {
    what: 'a real response on a busy box',
    input: { baseline: 30, peak: 38, loadApplied: true },
    expect: RESPONDED,
    why: 'a busy box that DOES move by the margin has demonstrated the claim like any other'
  }
];

for (const c of CASES) {
  const got = stallResponseVerdict(c.input);
  console.log(
    `\n  ${c.what}\n` +
      `    ${JSON.stringify(c.input)}\n` +
      `    expected ${c.expect}, got ${got.outcome} (isSkip ${got.isSkip})`
  );
  verdict(
    got.outcome === c.expect,
    `${c.expect} — ${c.why}`,
    `"${c.what}" produced ${got.outcome}, expected ${c.expect}. The discriminator does not ` +
      'separate the case it claims to, and one of a false red or a false green follows.'
  );
  // The §3 sweep can only reach the two `loadApplied: true` outcomes, so the
  // field-vs-outcome agreement for LOAD_NOT_APPLIED and UNREADABLE is asserted
  // here or nowhere.
  verdict(
    got.isSkip === isSkipOutcome(got.outcome),
    `and its isSkip field agrees with isSkipOutcome() — the caller branches on the field,\n` +
      '    this script reasons about the outcome, and nothing else keeps the two in step.',
    `"${c.what}": isSkip=${got.isSkip} but isSkipOutcome(${got.outcome})=` +
      `${isSkipOutcome(got.outcome)}. verify-io-stall-gate.mjs §2 branches on the field, so ` +
      'it would take the wrong arm for this input.'
  );
}

// ------------------------------------------------------- 3. no false pass --
rule('3. NO FALSE PASS — swept, and every skip carried through to an exit code');

// The property, over a grid rather than over examples: RESPONDED requires a
// real excursion, whatever the baseline. This is the claim a reviewer most
// needs, because every other section is a handful of chosen points.
const sweepProblems = [];
for (let baseline = 0; baseline <= 90; baseline += 0.5) {
  for (let response = -5; response <= 20; response += 0.5) {
    const peak = baseline + response;
    if (peak < 0) continue;
    const got = stallResponseVerdict({ baseline, peak, loadApplied: true });
    const loadedArm = baseline >= RESPONSE_MARGIN_POINTS;

    // Holds on BOTH arms: a pass always clears the absolute floor, and always
    // involved the number going up.
    if (got.outcome === RESPONDED && peak < RESPONSE_MARGIN_POINTS) {
      sweepProblems.push(`RESPONDED with peak=${peak} below the floor`);
    }
    if (got.outcome === RESPONDED && response <= 0) {
      sweepProblems.push(`RESPONDED at baseline=${baseline} with response=${response}`);
    }
    // The loaded arm is the one this ticket changed, and it is where a pass
    // must mean a real excursion rather than a ratio against the neighbours.
    if (loadedArm && got.outcome === RESPONDED && response < RESPONSE_MARGIN_POINTS) {
      sweepProblems.push(`loaded-arm RESPONDED at baseline=${baseline} response=${response}`);
    }
    // A skip must never be reachable on a quiet box: that is where a genuine
    // instrument fault has nowhere to hide, and it must stay a failure.
    if (isSkipOutcome(got.outcome) && !loadedArm) {
      sweepProblems.push(`skip (${got.outcome}) on a quiet box, baseline=${baseline}`);
    }
    // `verify-io-stall-gate.mjs` §2 branches on the `isSkip` FIELD while this
    // sweep reasons about the OUTCOME. Those are two spellings of one fact, and
    // nothing else makes them agree — so if they ever drift, the caller skips a
    // section this script is still calling a failure, or the reverse.
    if (got.isSkip !== isSkipOutcome(got.outcome)) {
      sweepProblems.push(
        `isSkip=${got.isSkip} disagrees with isSkipOutcome(${got.outcome}) at ` +
          `baseline=${baseline} peak=${peak}`
      );
    }
    // And the converse, which is the anti-softening half: on the quiet arm the
    // verdict must be the OLD bar's verdict, with no exceptions anywhere.
    if (!loadedArm && (got.outcome === RESPONDED) !== oldBar(baseline, peak)) {
      sweepProblems.push(`quiet-arm divergence at baseline=${baseline} peak=${peak}`);
    }
  }
}
console.log(
  `  swept ${(91 * 2 * 51).toLocaleString()} (baseline, response) pairs across ` +
    `baseline 0…90% and response -5…+20 points\n` +
    `  violations: ${sweepProblems.length}`
);
verdict(
  sweepProblems.length === 0,
  'across the whole grid: a pass always clears the floor and always went up; on the\n' +
    '    loaded arm a pass means a real excursion in points; no skip is reachable on a quiet\n' +
    '    box, so a flat instrument can never excuse itself by claiming the host was busy;\n' +
    '    and on the quiet arm the verdict is the OLD bar\'s verdict everywhere.',
  `${sweepProblems.length} violation(s), first: ${sweepProblems[0]}. A pass or a skip is ` +
    'reachable where neither is warranted.'
);

// The skip must survive as far as the process's exit code, or it is decoration.
const skipExit = verdictFor({ failures: 0, skipped: 1, allowSkipped: false });
console.log(
  `\n  verdictFor({failures: 0, skipped: 1}) -> exit ${skipExit.code} (${skipExit.headline})`
);
verdict(
  skipExit.code !== EXIT_PASS && skipExit.code !== 0,
  `a skipped section exits ${skipExit.code}, not 0. This is the half that makes the\n` +
    '    reclassification honest: a host that could not run §2 cannot render a green, so\n' +
    '    the constant-high-instrument hole named in the module header is bounded by the\n' +
    '    exit code even though no assertion covers it.',
  `a skipped section exits ${skipExit.code}. A skip that exits 0 is the KAN-373 defect ` +
    'and the false green this ticket found in verify-io-stall-gate.mjs.'
);

// ----------------------------------------------------- 4. quiet-box parity --
rule('4. QUIET-BOX PARITY — the calibration every existing green came from is unmoved');

// The change must be invisible on the machines this check has always run on.
// If it is not, "I only loosened it where the physics demanded" is not true.
const parityProblems = [];
for (let peak = 0; peak <= 60; peak += 0.25) {
  for (const baseline of [0, 0.5, 1, 2, 3, 4, 4.9]) {
    const mine = stallResponseVerdict({ baseline, peak, loadApplied: true }).outcome === RESPONDED;
    const theirs = oldBar(baseline, peak);
    if (mine !== theirs) parityProblems.push(`baseline=${baseline} peak=${peak}: ${theirs} -> ${mine}`);
  }
}
console.log(
  `  compared both rules over every quiet-box baseline (0…4.9%) x peak 0…60%\n` +
    `  disagreements: ${parityProblems.length}` +
    (parityProblems.length ? `\n  first: ${parityProblems[0]}` : '')
);
verdict(
  parityProblems.length === 0,
  'on a quiet box the two rules agree everywhere, so this change moved no threshold that\n' +
    '    any existing green depended on. It differs only where the multiplicative arm was\n' +
    '    asking a loaded device for a response it cannot physically supply.',
  `${parityProblems.length} disagreement(s) on a quiet box, first: ${parityProblems[0]}. The ` +
    'change is not confined to the loaded-host regime and the existing calibration moved.'
);

// --------------------------------------------------------- 5. can it fail --
rule('5. CAN IT FAIL — the discriminator deleted three ways, and caught each time');

// Sections 1-4 are a green light unless something makes them go red. These are
// the three ways this module could be broken back into the defect it fixes.
const MUTANTS = [
  {
    name: 'the old multiplicative bar restored',
    decide: ({ baseline, peak }) => (oldBar(baseline, peak) ? RESPONDED : FLAT),
    caughtBy: 'section 1',
    detect: (d) => d({ ...RUNNER }) !== RESPONDED
  },
  {
    name: 'discriminator deleted — every short response excused as a busy host',
    decide: ({ baseline, peak }) =>
      peak - baseline >= RESPONSE_MARGIN_POINTS ? RESPONDED : HOST_ALREADY_STALLED,
    caughtBy: 'section 2 (quiet disk, instrument flat)',
    detect: (d) => d({ baseline: 0, peak: 0 }) !== FLAT
  },
  {
    name: 'margin removed — any movement at all counts as a response',
    decide: ({ baseline, peak }) => (peak > baseline ? RESPONDED : FLAT),
    caughtBy: 'section 3 (sweep)',
    detect: (d) => d({ baseline: 0, peak: 0.5 }) === RESPONDED
  }
];

for (const m of MUTANTS) {
  const caught = m.detect(m.decide);
  console.log(`\n  mutant: ${m.name}\n    would be caught by ${m.caughtBy}: ${caught}`);
  verdict(
    caught,
    `the battery rejects it — ${m.caughtBy} goes red on this mutation, so its verdict on\n` +
      '    the real module is worth something.',
    `the battery ACCEPTS "${m.name}". This script cannot detect the failure it exists to ` +
      'detect and its green means nothing.'
  );
}

console.log(
  failures.length
    ? `\n${failures.length} section(s) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS.'
);
console.log('\n== done ==');

// No section of this script can skip: it reads no host state and spawns
// nothing, so there is no input it can fail to obtain. The tally is passed
// explicitly as 0 rather than omitted, so that the claim is stated rather than
// inferred from its absence.
reportAndExit({ failures: failures.length, skipped: 0 });
