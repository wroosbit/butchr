// KAN-540: `sweep-verify-exit-paths.mjs` must credit an exit to an `if` only
// when the exit is actually INSIDE that `if`'s body.
//
// WHAT FAILURE THIS WOULD CATCH: the sweep taking proximity for control flow —
// crediting an unconditional `process.exit(0)` to an unrelated `if` on a nearby
// line, so a script that can NEVER report failure passes the REQUIRED
// `verify-script-sweep` check. That is the defect KAN-540 was filed for, and
// §1's five-line probe is the ticket's reproduction verbatim: it asserts
// nothing, its only exit is unconditional, and the retired six-line window
// reported it `1 verdict, exit 0`. It fails toward GREEN, which is the unsafe
// direction and the difference from KAN-535.
//
// It would equally catch the opposite over-correction, which is the expensive
// one to ship on a required check: a containment test so strict that real
// verdicts stop counting and the check goes red for correctly-written scripts.
// §2–§5 are that half — the single-statement form, a body longer than the
// retired window, a nested `if`, and an `else` arm — and §8 is the same
// question asked of the real tree rather than of a fixture.
//
// CI-RUNNABLE: yes — writes fixture trees under `os.tmpdir()` and runs the
// shipped sweep against them as a child process. Node builtins only: no build,
// no daemon, no herdr, no credential, no network, no terminal.
//
// THE RED DRIVE RUNS INLINE, IN §9, RATHER THAN BEHIND A FLAG. Every other red
// drive on this board is a flag because the mutation has to reach a real build;
// this one only has to reach a copy of one module in a scratch tree, so it
// costs nothing to break the containment check on every run and watch the probe
// go back to passing. A red drive behind a flag is a demonstration somebody did
// once; this one is re-evaluated by CI on every PR. If §9 ever reports that the
// probe still fails under the restored proximity window, containment is not
// what §1 is measuring and §1 has stopped being evidence.
//
// THIS SCRIPT BUILDS THE FIXTURES IT ASSERTS ON — §1–§7 and §9 all write their
// own input, which is the KAN-145 shape and a real limit. A fixture is a guess
// at what real scripts look like, and a guess that drifts stays green while
// testing nothing.
//
// WHAT COVERS THE GAP: §8, which makes no fixtures. It runs the shipped sweep
// against THIS repository and asserts, by name, that the real scripts whose
// verdict is established by containment still have it — and that no `why`
// string anywhere in the report is a fragment rather than a condition, which is
// the tell the old defect printed on screen for as long as it existed. Sibling
// coverage: `verify-exit-path-classifier.mjs` owns the code/non-code mask this
// one takes for granted, and neither covers the other.
//
// Usage: node daemon/scripts/verify-exit-path-containment.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const check = (label, cond, detail) => (cond ? ok(label) : fail(`${label} — ${detail}`));

// ---------------------------------------------------------------------------
// Running the shipped sweep against a tree we control
// ---------------------------------------------------------------------------

const SWEEP = 'sweep-verify-exit-paths.mjs';
const LIBS = ['sweep-sources.mjs', 'mask-non-code.mjs', 'governing-conditions.mjs'];

/**
 * Build a throwaway repository shaped like this one and drop `fixtures` into
 * its `daemon/scripts`. The sweep derives its repo root from its own location,
 * so a copy two levels down sweeps the copy and never this checkout.
 */
function treeWith(fixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan540-'));
  const scripts = path.join(root, 'daemon', 'scripts');
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(scriptDir, SWEEP), path.join(scripts, SWEEP));
  for (const lib of LIBS) {
    fs.copyFileSync(path.join(scriptDir, 'lib', lib), path.join(scripts, 'lib', lib));
  }
  for (const [name, body] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(scripts, name), body);
  }
  return { root, scripts, sweep: path.join(scripts, SWEEP) };
}

/** Run a sweep and return its exit code and output, whichever way it went. */
function runSweep(sweepPath) {
  try {
    const stdout = execFileSync(process.execPath, [sweepPath, '--verbose'], {
      encoding: 'utf8',
      timeout: 60_000
    });
    return { code: 0, stdout };
  } catch (err) {
    if (err.stdout === undefined) throw err;
    return { code: err.status, stdout: err.stdout };
  }
}

/**
 * Parse the sweep's `--verbose` report into one record per script.
 *
 * The `why` is separated from the source text by exactly three spaces, and
 * anchoring on that matters: source text routinely contains parentheses of its
 * own, so a match taking the first `(` as the start of `why` would report the
 * text as `if`. Kept identical to `verify-exit-path-classifier.mjs`'s parser on
 * purpose — the two read the same format, and a format change should break both
 * rather than silently only one.
 */
function parseReport(stdout) {
  const rows = new Map();
  let current = null;
  for (const line of stdout.split('\n')) {
    const detail = line.match(/^\s+(verdict|guard|masked)\s+L(\d+):\s(.*)\s{3}\((.*)\)$/);
    if (detail && current) {
      current[`${detail[1]}s`].push({ line: Number(detail[2]), text: detail[3], why: detail[4] });
      continue;
    }
    const row = line.match(/^(verify-\S+)\s+(NONE|\d+)\s+(\d+)\s+(yes|NO)\s*$/);
    if (row) {
      current = {
        name: row[1],
        verdictCount: row[2] === 'NONE' ? 0 : Number(row[2]),
        guardCount: Number(row[3]),
        header: row[4] === 'yes',
        verdicts: [],
        guards: [],
        maskeds: []
      };
      rows.set(row[1], current);
    }
  }
  return rows;
}

/**
 * How many scripts the sweep says it swept, from its own summary line — printed
 * BEFORE the table, so a report that arrives truncated still carries the count
 * of what should have been in it. See §8.
 */
function sweptCount(stdout) {
  const m = stdout.match(/^sweeping (\d+) verify-\* scripts/m);
  return m ? Number(m[1]) : null;
}

const HEADER = (what) =>
  `// WHAT FAILURE THIS WOULD CATCH: nothing — a KAN-540 fixture: ${what}.\n` +
  `// CI-RUNNABLE: no — written into a scratch tree at run time, never committed.\n`;

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

// §1 The ticket's five-line probe, verbatim in shape. It asserts nothing and
// its only exit is unconditional, so it can never report failure. The `if` one
// line above holds a counter word and governs a `console.log` — nothing else.
const CANNOT_FAIL_PROBE =
  `// WHAT FAILURE THIS WOULD CATCH: nothing at all. It asserts nothing and its\n` +
  `// only exit is unconditional, so it can NEVER report failure.\n` +
  `let failures = 0;\n` +
  `if (failures) console.log('this branch prints and does not exit');\n` +
  `process.exit(0);\n`;

// §2 The single-statement form. No braces, condition and exit on one line —
// the shape `prompts/task.md` names as a legitimate verdict, and the one a
// containment test written only around braces would lose.
const SINGLE_STATEMENT =
  HEADER('a braceless `if (failures) process.exit(1)`') +
  `let failures = 0;\n` +
  `if (failures) process.exit(1);\n` +
  `process.exit(0);\n`;

// §3 A braced body LONGER than the retired six-line window. This is not a
// hypothetical shape: `verify-crabcast-channel-startup-supervision.mjs` has it
// at L389–L395, and the window classified that real verdict as a guard by
// missing the `if` above it by exactly one line.
const LONG_BODY =
  HEADER('a verdict inside a body longer than the retired six-line window') +
  `let failures = 0;\n` +
  `if (failures > 0) {\n` +
  `  console.log('line 1 of the explanation');\n` +
  `  console.log('line 2 of the explanation');\n` +
  `  console.log('line 3 of the explanation');\n` +
  `  console.log('line 4 of the explanation');\n` +
  `  console.log('line 5 of the explanation');\n` +
  `  console.log('line 6 of the explanation');\n` +
  `  console.log('line 7 of the explanation');\n` +
  `  process.exit(1);\n` +
  `}\n` +
  `console.log('nothing failed');\n`;

// §4 A success exit sitting AFTER a counter-guarded block. The window credited
// it to the `if` it follows; it is reached whether or not anything failed, so
// it cannot report failure and is a guard. Three real scripts have this shape —
// see §8.
const EXIT_AFTER_BLOCK =
  HEADER('a success exit after a counter-guarded block, which is a guard') +
  `let failures = 0;\n` +
  `if (failures) {\n` +
  `  console.error('failed');\n` +
  `  process.exit(1);\n` +
  `}\n` +
  `console.log('All checks passed.');\n` +
  `process.exit(0);\n`;

// §5 A nested `if` whose own condition holds no counter. The exit is reached
// only when `failures`, so reading the innermost link alone would lose it: the
// governing chain has to be searched outward.
const NESTED =
  HEADER('a verdict under a nested non-counter `if`') +
  `let failures = 0;\n` +
  `const verbose = true;\n` +
  `if (failures) {\n` +
  `  if (verbose) {\n` +
  `    console.error('detail');\n` +
  `    process.exit(1);\n` +
  `  }\n` +
  `}\n` +
  `console.log('done');\n`;

// §6 An `else` arm. `else` is not governed by the `if`'s condition, and a
// scanner that closed the region at the wrong brace would credit it anyway.
const ELSE_ARM =
  HEADER('an exit in an `else` arm, which the `if` does not govern') +
  `let failures = 0;\n` +
  `if (failures) {\n` +
  `  console.error('failed');\n` +
  `  process.exitCode = failures;\n` +
  `} else {\n` +
  `  process.exit(0);\n` +
  `}\n`;

// §7 The condition is read to its own closing parenthesis rather than to the
// end of the line. A window that returned "the rest of the line" printed a
// fragment; a call containing parentheses is what discriminates the two.
const PARENS_IN_CONDITION =
  HEADER('a condition holding parentheses of its own') +
  `let failures = 0;\n` +
  `const seen = new Set();\n` +
  `if (failures > 0 && seen.has('x')) {\n` +
  `  process.exit(1);\n` +
  `}\n` +
  `console.log('done');\n`;

/**
 * §9's mutation: `lib/governing-conditions.mjs` rewritten to answer the way the
 * retired six-line window did — an `if` governs the six lines below it, whether
 * or not the exit is inside its body, and the "condition" is everything after
 * the first `if (` on the line.
 *
 * Faithful to the defect rather than merely broken: it must make the probe pass
 * again, and if it does not then §1 is not measuring containment.
 */
const PROXIMITY_WINDOW_MUTATION = `// MUTATION — KAN-540 §9. The retired proximity window, restored on purpose.
export function conditionalRegions(code) {
  const lines = code.split('\\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const regions = [];
  lines.forEach((line, i) => {
    const m = line.match(/\\bif\\s*\\((.*)/);
    if (!m) return;
    const last = Math.min(lines.length - 1, i + 6);
    regions.push({ cond: m[1], from: starts[i], to: starts[last] + lines[last].length });
  });
  return regions;
}

export function governingConditions(regions, index) {
  return regions
    .filter((r) => index >= r.from && index < r.to)
    .sort((a, b) => b.from - a.from)
    .map((r) => r.cond);
}

export function renderCondition(cond, max = 40) {
  const flat = cond.replace(/\\s+/g, ' ').trim();
  return flat.length > max ? \`\${flat.slice(0, max - 1)}…\` : flat;
}
`;

const cleanup = [];

try {
  // -------------------------------------------------------------------------
  console.log('§1 the five-line probe has NO verdict-driven exit and the sweep goes red');
  {
    const tree = treeWith({ 'verify-cannot-fail-probe.mjs': CANNOT_FAIL_PROBE });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-cannot-fail-probe');
    check('the probe produces a row', !!r, 'the sweep reported no row for it');
    if (r) {
      check(
        `it has no verdict-driven exit (found ${r.verdictCount})`,
        r.verdictCount === 0,
        'an unconditional exit was credited to an `if` it is not inside — this is the KAN-540 defect'
      );
      check(
        `its one exit is counted as a guard (found ${r.guardCount})`,
        r.guardCount === 1,
        `guards: ${JSON.stringify(r.guards.map((g) => g.text))}`
      );
    }
    check(
      'the sweep names it as unable to fail',
      /all guards|no exit path at all/.test(run.stdout),
      `the sweep said:\n${run.stdout}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'a script that cannot report failure passed the required check'
    );
  }

  // -------------------------------------------------------------------------
  // The shapes that must KEEP their verdicts. One tree, so a single sweep run
  // answers for all of them and the tree is expected to be green.
  // -------------------------------------------------------------------------
  const green = treeWith({
    'verify-kan540-single-statement.mjs': SINGLE_STATEMENT,
    'verify-kan540-long-body.mjs': LONG_BODY,
    'verify-kan540-exit-after-block.mjs': EXIT_AFTER_BLOCK,
    'verify-kan540-nested.mjs': NESTED,
    'verify-kan540-else-arm.mjs': ELSE_ARM,
    'verify-kan540-parens-in-condition.mjs': PARENS_IN_CONDITION
  });
  cleanup.push(green.root);
  const greenRun = runSweep(green.sweep);
  const greenRows = parseReport(greenRun.stdout);
  if (verbose) console.log(greenRun.stdout);

  console.log('§2 a braceless `if (failures) process.exit(1)` is still a verdict');
  {
    const r = greenRows.get('verify-kan540-single-statement');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the single-statement exit is a verdict (found ${r.verdictCount})`,
        r.verdicts.some((v) => /if \(failures\) process\.exit\(1\)/.test(v.text)),
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
      check(
        'its condition is reported exactly, with nothing after the parenthesis',
        r.verdicts.some((v) => v.why === 'reached only when `failures`'),
        `why strings: ${JSON.stringify(r.verdicts.map((v) => v.why))}`
      );
    }
  }

  console.log('§3 a verdict inside a body longer than the retired window still counts');
  {
    const r = greenRows.get('verify-kan540-long-body');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the exit ten lines below its \`if\` is a verdict (found ${r.verdictCount})`,
        r.verdictCount === 1,
        'a containment test that kept a distance limit lost a real verdict'
      );
      check(
        'it is credited to the condition that governs it',
        r.verdicts.some((v) => v.why === 'reached only when `failures > 0`'),
        `why strings: ${JSON.stringify(r.verdicts.map((v) => v.why))}`
      );
    }
  }

  console.log('§4 a success exit after a counter-guarded block is a guard, not a verdict');
  {
    const r = greenRows.get('verify-kan540-exit-after-block');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `it keeps exactly one verdict (found ${r.verdictCount})`,
        r.verdictCount === 1,
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
      check(
        'the verdict is the exit INSIDE the block',
        r.verdicts.some((v) => /process\.exit\(1\)/.test(v.text)),
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
      check(
        'the `process.exit(0)` after the block reads as unconditional',
        r.guards.some(
          (g) => /process\.exit\(0\)/.test(g.text) && g.why === 'unconditional success exit'
        ),
        `guards: ${JSON.stringify(r.guards.map((g) => `${g.text} (${g.why})`))}`
      );
    }
  }

  console.log('§5 a nested non-counter `if` does not hide the condition that governs');
  {
    const r = greenRows.get('verify-kan540-nested');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        `the nested exit is a verdict (found ${r.verdictCount})`,
        r.verdictCount === 1,
        'only the innermost link of the governing chain was read'
      );
      check(
        'it is credited to the outer `failures`, not to `verbose`',
        r.verdicts.some((v) => v.why === 'reached only when `failures`'),
        `why strings: ${JSON.stringify(r.verdicts.map((v) => v.why))}`
      );
    }
  }

  console.log('§6 an `else` arm is not governed by the `if` it follows');
  {
    const r = greenRows.get('verify-kan540-else-arm');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      check(
        'the exit in the `else` arm is not credited to `failures`',
        !r.verdicts.some((v) => /process\.exit\(0\)/.test(v.text)),
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => `${v.text} (${v.why})`))}`
      );
      check(
        `the script still reports failure through its exitCode (found ${r.verdictCount})`,
        r.verdicts.some((v) => /process\.exitCode/.test(v.text)),
        `verdicts: ${JSON.stringify(r.verdicts.map((v) => v.text))}`
      );
    }
  }

  console.log('§7 a condition holding parentheses is read to its own closing one');
  {
    const r = greenRows.get('verify-kan540-parens-in-condition');
    check('the fixture produces a row', !!r, 'no row');
    if (r) {
      // The condition is read off the MASKED copy, so the string literal inside
      // `seen.has('x')` arrives blanked and its run of spaces collapses to one.
      // That is the right reading to assert: it is what the classifier actually
      // matched `COUNTER` against, and quoting the raw source here would test a
      // prettier string than the one the decision was made on.
      check(
        'the whole condition is reported and nothing beyond it',
        r.verdicts.some((v) => v.why === 'reached only when `failures > 0 && seen.has( )`'),
        `why strings: ${JSON.stringify(r.verdicts.map((v) => v.why))}`
      );
      check(
        'the closing parenthesis of the `if` is not part of the condition',
        r.verdicts.every((v) => !/\)\s*\{`$/.test(v.why)),
        `why strings: ${JSON.stringify(r.verdicts.map((v) => v.why))}`
      );
    }
  }

  check(
    'the six shapes that must keep their verdicts sweep clean (exit 0)',
    greenRun.code === 0,
    `the sweep exited ${greenRun.code}:\n${greenRun.stdout}`
  );

  // -------------------------------------------------------------------------
  // §8 No fixtures. The shipped sweep, this repository, the real scripts.
  // -------------------------------------------------------------------------
  console.log('§8 the real scripts whose verdict rests on containment still have it');

  // Named rather than described, because AC 2 asks which scripts these are.
  // Each has a literal `process.exit(<0|1>)` whose ONLY claim to being a verdict
  // is the counter condition it sits inside — nothing in its argument says so.
  // If containment regresses in either direction these are what move.
  //
  // IDENTIFIED BY (exit text, condition) AND DELIBERATELY NOT BY LINE NUMBER.
  // A line number is the sharper identity and the wrong one to pin from here:
  // it moves whenever anything above it is edited, so pinning it makes this
  // section go red for changes it has no opinion about — and one of the files
  // in the list is edited by this very ticket. What it is actually asserting is
  // that the verdict is still credited to the condition that governs it, and
  // the pair below says exactly that and nothing more.
  const REAL_CONTAINED_VERDICTS = [
    ['verify-adopted-pane-supervision', 'process.exit(1);', 'failures === 0'],
    ['verify-agent-resumption', 'process.exit(1);', 'failures'],
    ['verify-crabcast-channel-startup-supervision', 'process.exit(1);', 'failures === 0'],
    ['verify-crabcast-channel-startup-supervision', 'process.exit(1);', 'failures > 0'],
    ['verify-env-knobs-documented', 'process.exit(1);', 'failures'],
    ['verify-exit-path-classifier', 'process.exit(1);', 'failures'],
    ['verify-pty-write-refusal-is-read', 'process.exit(0);', 'failures > 0'],
    ['verify-resumed-conversation-nudge', 'process.exit(1);', 'failures === 0']
  ];

  // And the other direction: an unconditional `process.exit(0)` sitting after a
  // counter-guarded block. The retired window called each of these a verdict.
  // Each script keeps a real verdict of its own, which is why reclassifying
  // these turned no required check red.
  const REAL_UNCONDITIONAL_SUCCESS = [
    'verify-adopted-pane-supervision',
    'verify-env-knobs-documented',
    'verify-exit-path-classifier'
  ];

  const realRun = runSweep(path.join(scriptDir, SWEEP));
  const realRows = parseReport(realRun.stdout);
  // Against the sweep's own count, never a floor. Everything §8 asserts is of
  // the form "this named script still has this verdict", and a short read makes
  // every one of them answer ABSENT — a finding about the repository produced
  // by a partial parse. Measured once during this ticket: 128 of 164 rows, and
  // a `> 100` floor cleared it.
  check(
    `every row the sweep printed was parsed (${realRows.size})`,
    realRows.size === sweptCount(realRun.stdout),
    `the sweep says it swept ${sweptCount(realRun.stdout)} scripts and ${realRows.size} rows parsed` +
      ' — the report was read partially, so every verdict below is about a subset'
  );

  for (const [name, text, cond] of REAL_CONTAINED_VERDICTS) {
    const r = realRows.get(name);
    if (!r) {
      fail(`${name} — expected in the sweep's report and absent; has it been renamed?`);
      continue;
    }
    const why = `reached only when \`${cond}\``;
    const hit = r.verdicts.find((v) => v.text === text && v.why === why);
    check(
      `${name}: \`${text}\` is a verdict, credited to \`${cond}\``,
      !!hit,
      `its verdicts read: ${JSON.stringify(r.verdicts.map((v) => `L${v.line} ${v.text} (${v.why})`))}`
    );
  }

  for (const name of REAL_UNCONDITIONAL_SUCCESS) {
    const r = realRows.get(name);
    if (!r) {
      fail(`${name} — absent from the report`);
      continue;
    }
    check(
      `${name}: its trailing \`process.exit(0)\` reads as unconditional`,
      r.guards.some(
        (g) => g.text === 'process.exit(0);' && g.why === 'unconditional success exit'
      ),
      `its guards read: ${JSON.stringify(r.guards.map((g) => `L${g.line} ${g.text} (${g.why})`))}`
    );
    check(
      `${name}: still has a verdict of its own`,
      r.verdictCount >= 1,
      'reclassifying its success exit left it unable to report failure'
    );
  }

  // The tell the old defect printed on screen for as long as it existed: a
  // `why` naming a "condition" that is the remains of a line rather than a
  // condition — `failures) console.log(`. Balance is what discriminates them,
  // and this asks it of every row in the real report rather than of a fixture.
  {
    const fragments = [];
    for (const r of realRows.values()) {
      for (const v of [...r.verdicts, ...r.guards]) {
        const m = v.why.match(/^reached only when `(.*)`$/);
        if (!m) continue;
        let depth = 0;
        for (const ch of m[1]) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          if (depth < 0) break;
        }
        if (depth !== 0) fragments.push(`${r.name} L${v.line}: ${v.why}`);
      }
    }
    check(
      'no reported condition in the whole tree is an unbalanced fragment',
      fragments.length === 0,
      `${fragments.length}: ${JSON.stringify(fragments)}`
    );
  }

  check(
    `this repository sweeps clean (exit ${realRun.code})`,
    realRun.code === 0,
    'the shipped sweep is red against this checkout'
  );

  // -------------------------------------------------------------------------
  // §9 The red drive, inline: break containment and watch §1's probe pass.
  // -------------------------------------------------------------------------
  console.log('§9 RED DRIVE — with the proximity window restored, the probe passes again');
  {
    const mutated = treeWith({ 'verify-cannot-fail-probe.mjs': CANNOT_FAIL_PROBE });
    cleanup.push(mutated.root);
    fs.writeFileSync(
      path.join(mutated.scripts, 'lib', 'governing-conditions.mjs'),
      PROXIMITY_WINDOW_MUTATION
    );
    const run = runSweep(mutated.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-cannot-fail-probe');
    check(
      'the mutated tree still produces a row for the probe',
      !!r,
      `the mutation broke the sweep rather than its containment test:\n${run.stdout}`
    );
    check(
      `the probe is wrongly credited with a verdict again (found ${r ? r.verdictCount : 'no row'})`,
      !!r && r.verdictCount === 1,
      'the probe did NOT go back to passing — §1 is not measuring containment, and its green is not evidence'
    );
    check(
      'the wrongly-credited condition is a fragment, as it was on `main`',
      !!r && r.verdicts.some((v) => /^reached only when `failures\) console\.log\(/.test(v.why)),
      `why strings: ${JSON.stringify(r ? r.verdicts.map((v) => v.why) : [])}`
    );
    check(
      `the sweep exits 0 for a script that cannot fail (exited ${run.code})`,
      run.code === 0,
      'the required check stayed red under the mutation, so something other than containment is holding it'
    );
  }
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
