// KAN-561: a skip tally is CONSULTED when an exit's condition names it, not
// only when its expression does.
//
// WHAT FAILURE THIS WOULD CATCH: the required `verify-script-sweep` check
// reporting `tallies \`skipped\`, and no exit reads it` about a script that
// implements the tri-state contract correctly — the false positive KAN-373's
// skip check shipped. Its measured victim was
// `verify-herdr-channel-reach-live.mjs` from #247, which wrote
//
//     if (skipped > 0 && !allowSkipped) process.exit(EXIT_INCOMPLETE);
//
// because its author had been told a constant is the spelling the sweep cannot
// follow and a CONDITION is the spelling it can. It was the one spelling the
// check could not read. It would equally catch the opposite failure, which is
// the one this fix could introduce: the widened check clearing a script that
// genuinely ignores its tally (§2), or a skip-only exit being credited as proof
// that a script can report a FAILURE (§3), which would gut KAN-119.
//
// CI-RUNNABLE: yes — writes fixture trees under `os.tmpdir()` and runs the
// shipped sweep against them as a child process. Node builtins only: no build,
// no daemon, no herdr, no credential, no network, no terminal.
//
// ── WHY A FALSE POSITIVE ON A REQUIRED CHECK EARNS ITS OWN SCRIPT ──────────
//
// A gate that is wrong about correct code does not merely waste a run. It
// teaches agents to contort the code to placate it, and the contorted shape
// outlives the fix while nobody remembers why it is shaped that way — so the
// damage is permanent and invisible in a way a miss is not. #247's author wrote
// the principle down while being bitten by it: *"writing code a required check
// cannot read, and then arguing the check is behind, is how a gate stops being
// a gate."* Both directions of that are tested here, in §1 and §2, because
// fixing one by widening into the other is the ordinary way this goes wrong.
//
// THIS SCRIPT BUILDS THE FIXTURES IT THEN ASSERTS ON, AND THAT IS A REAL LIMIT.
// §1–§6 prove the sweep answers correctly about source *this script wrote*,
// which is not the claim "it answers correctly about the repository". A fixture
// is a guess at what real scripts look like, and a guess that drifts stops
// testing anything while staying green — the KAN-145 shape.
//
// WHAT COVERS THE GAP: §7, which makes no fixtures at all. It runs the shipped
// sweep against THIS repository and asserts that every script tallying skips is
// found to consult them, and that the count of such scripts is the sweep's own
// rather than a number written here. If §1–§6 drift away from what real scripts
// look like, §7 is what still fails.
//
// WHAT NEITHER COVERS, named because the two paragraphs above read as a
// completeness claim: whether an exit that reads the tally then RENDERS it
// correctly. `if (skipped > 0) process.exit(0)` consults the tally and swallows
// it, and passes both the sweep and this script. It cannot be refused on its
// shape — `if (skipped > 0 && allowSkipped) process.exit(0)` is the legitimate
// `--allow-skipped` arm and differs only in a term the sweep cannot evaluate.
// `lib/verdict-exit.mjs` is what removes that class, by being the one
// implementation of the decision; `verify-skip-is-not-a-pass.mjs` is its proof.
// Nothing here covers a script that spells the verdict itself and spells it
// wrong.
//
// THE WORKED CASE ITSELF IS NOT IN THIS FILE, AND THE RECIPE IS IN THE PR.
// §1 is the SHAPE of #247's exit written as a fixture; the actual file that was
// falsely accused is `verify-herdr-channel-reach-live.mjs` at `bde76fd`, which
// #247 later moved to `reportAndExit` for its own reasons. Running it against
// both sweeps needs a git ref this script has no business reaching for — a
// CI-RUNNABLE proof that shells out to `git show` stops being runnable on a
// shallow checkout, and a ref can be collected. So it was measured out of band
// and pasted into the PR, with the commands, exactly as the pre-fix build rule
// asks. What that measurement establishes and this file cannot: the check was
// wrong about a REAL script, not only about a fixture guessing at one.
//
// THE RED DRIVE RUNS INLINE, IN §8, RATHER THAN BEHIND A FLAG — the same trade
// `verify-exit-path-containment.mjs` §9 makes. A red drive run once by hand is
// evidence about the afternoon it was run on; this one is re-evaluated by CI on
// every PR, so if §8 ever reports that the restored KAN-373 check leaves §1's
// fixture PASSING, then §1 is not measuring consultation and its green is not
// evidence.
//
// Usage: node daemon/scripts/verify-exit-path-skip-consultation.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

/** Distinguishes the capture files of one run from each other. */
let captureSeq = 0;

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
// The list has to be complete or the copied sweep dies on an unresolved import,
// and `runSweep` reads that as a non-zero exit with EMPTY stdout — which
// arrives here as "the sweep reported no row for it", i.e. as a substantive
// finding about the check rather than as a broken fixture. Every section below
// fails at once when this list is short, which is the tell.
const LIBS = ['sweep-sources.mjs', 'mask-non-code.mjs', 'governing-conditions.mjs'];

/**
 * Build a throwaway repository shaped like this one and drop `fixtures` into
 * its `daemon/scripts`. The sweep derives its repo root from its own location,
 * so a copy two levels down sweeps the copy and never this checkout.
 */
function treeWith(fixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan561-'));
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

/**
 * Run a sweep and return its exit code and output, whichever way it went.
 *
 * THE CHILD'S STDOUT GOES TO A FILE, NOT A PIPE, AND THAT IS LOAD-BEARING. Read
 * through a pipe this report arrives TRUNCATED under load — measured twice in
 * one afternoon on KAN-540, `128 of 164` rows and `69 of 165`, with the sweep's
 * own `sweeping N` line intact at the top and the table cut off part way down.
 * The cause is not established and it does not reproduce on demand, which is
 * what makes it dangerous rather than merely annoying. A short read makes every
 * section below answer ABSENT for a missing script, reporting a finding about
 * the sweep that is really a fact about the read. §7's row-count check against
 * the sweep's own `sweeping N` is the positive control that it did not happen.
 */
function runSweep(sweepPath) {
  const out = path.join(os.tmpdir(), `kan561-sweep-out-${process.pid}-${captureSeq++}.txt`);
  const fd = fs.openSync(out, 'w');
  // Closed exactly once. A descriptor closed twice is not a harmless retry: the
  // number is free after the first close and the second one shuts whatever has
  // since been handed it.
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      fs.closeSync(fd);
    }
  };
  try {
    const run = spawnSync(process.execPath, [sweepPath, '--verbose'], {
      stdio: ['ignore', fd, 'inherit'],
      timeout: 120_000
    });
    close();
    if (run.error) throw run.error;
    return { code: run.status, stdout: fs.readFileSync(out, 'utf8') };
  } finally {
    close();
    fs.rmSync(out, { force: true });
  }
}

/**
 * Parse the sweep's `--verbose` report into one record per script.
 *
 * The `why` is separated from the source text by exactly three spaces, and
 * anchoring on that matters: source text routinely contains parentheses of its
 * own, so a match taking the first `(` as the start of `why` would report the
 * text as `if`.
 *
 * `skip` is KAN-561's label and is read here alongside `verdict` and `guard`.
 * The ROW regex is deliberately identical to the one in
 * `verify-exit-path-classifier.mjs` and `verify-exit-path-containment.mjs` — the
 * table's columns did not change, and a skip verdict is a fact about one exit
 * rather than a fourth number every reader of that table has to learn.
 */
function parseReport(stdout) {
  const rows = new Map();
  let current = null;
  for (const line of stdout.split('\n')) {
    const detail = line.match(/^\s+(verdict|skip|guard|masked)\s+L(\d+):\s(.*)\s{3}\((.*)\)$/);
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
        skips: [],
        guards: [],
        maskeds: []
      };
      rows.set(row[1], current);
    }
  }
  return rows;
}

/**
 * The scripts the sweep names as tallying skips nothing consults — the finding
 * this whole file is about, read back off the report rather than off an exit
 * code, so a section can assert WHICH script was named.
 */
function blindScripts(stdout) {
  return [...stdout.matchAll(/^ {2}- (\S+) \(tallies `([^`]*)`, and no exit reads it\)$/gm)].map(
    (m) => ({ rel: m[1], tallies: m[2] })
  );
}

/** How many scripts the sweep says it swept, from its own summary line. */
function sweptCount(stdout) {
  const m = stdout.match(/^sweeping (\d+) verify-\* scripts/m);
  return m ? Number(m[1]) : null;
}

const HEADER = (what) =>
  `// WHAT FAILURE THIS WOULD CATCH: nothing — a KAN-561 fixture: ${what}.\n` +
  `// CI-RUNNABLE: no — written into a scratch tree at run time, never committed.\n`;

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

// §1 THE WORKED CASE. #247's shape: a named-constant exit argument, and a
// governing condition that names the tally. The tally IS read — in the one
// place KAN-373's check did not look.
const CONDITION_CONSULTED =
  HEADER('the tri-state contract spelled with a condition, as #247 spelled it') +
  `import { EXIT_INCOMPLETE } from './lib/verdict-exit.mjs';\n` +
  `const allowSkipped = process.argv.includes('--allow-skipped');\n` +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) {\n` +
  `  console.log('SKIP live section');\n` +
  `  skipped += 1;\n` +
  `}\n` +
  `if (skipped > 0 && !allowSkipped) {\n` +
  `  process.exit(EXIT_INCOMPLETE);\n` +
  `}\n` +
  `process.exit(failures ? 1 : 0);\n`;

// §2 THE CONTROL, AND THE ARM AT RISK. Identical but for the missing tri-state
// branch: it tallies the skip and its only exit consults `failures`. This is
// the six-script shape KAN-373 was filed for, and widening the check is exactly
// how it would stop being caught.
const GENUINELY_BLIND =
  HEADER('a skip tally no exit names — KAN-373\\u2019s original defect') +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) {\n` +
  `  console.log('SKIP live section');\n` +
  `  skipped += 1;\n` +
  `}\n` +
  `if (skipped > 0) console.log('some sections did not run');\n` +
  `process.exit(failures ? 1 : 0);\n`;

// §3 KAN-119'S QUESTION, WHICH THIS FIX MUST NOT ANSWER FOR FREE. The only exit
// is reached when something was SKIPPED. It consults its tally, so §skips is
// satisfied — and it cannot report a failing assertion, so it must still be
// named as unable to fail.
const SKIP_ONLY_EXIT =
  HEADER('an exit governed only by a skip tally is not proof the script can fail') +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (skipped > 0) {\n` +
  `  process.exit(2);\n` +
  `}\n` +
  `console.log('done');\n`;

// §4 PRECEDENCE. A condition naming both is a FAILURE verdict — the loudest
// true statement about it, the same order `lib/verdict-exit.mjs` gives 1 over 2.
const BOTH_IN_ONE_CONDITION =
  HEADER('a condition naming a failure counter and a skip tally') +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (failures > 0 || skipped > 0) {\n` +
  `  process.exit(1);\n` +
  `}\n` +
  `process.exit(0);\n`;

// §5 THE KEY-SPELLING DEFENCE, ONE LEVEL DOWN. `references` exists because
// `reportAndExit({ failures: 0, skipped: 0 })` cannot report anything while
// SPELLING both tallies. A condition can spell one the same way, and reading
// conditions without `references` would reintroduce that hole in the new place.
const TALLY_ONLY_AS_A_KEY =
  HEADER('a tally spelled as an object KEY in a condition has not been read') +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (report({ skipped: 0 }).ok) {\n` +
  `  process.exit(3);\n` +
  `}\n` +
  `process.exit(failures ? 1 : 0);\n`;

// §6 CONTAINMENT STILL BINDS. The `if` naming the tally governs a `console.log`
// and nothing else; the exit below is outside its body. Proximity is not
// control flow — KAN-540's whole argument — and reading conditions for the skip
// question must not smuggle the retired window back in.
const SKIP_IF_GOVERNS_NOTHING =
  HEADER('an `if` naming the tally that does not govern the exit below it') +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (skipped > 0) {\n` +
  `  console.log('this branch prints and does not exit');\n` +
  `}\n` +
  `process.exit(failures ? 1 : 0);\n`;

// §9 THE `exitCode` KIND, WHICH THE FIRST CUT OF THIS FIX DID NOT COVER — and
// the defect it left is a RED TURNED GREEN, so it is the dangerous direction.
// `if (skipped > 0) process.exitCode = 2` is scored a failure verdict by the
// sweep's `exitCode` branch on the strength of its leading `if (` alone, with
// nothing having looked at what the condition says. On `main` that shape was
// red anyway, for the unrelated reason that the tally reached no expression;
// teaching the sweep to read conditions removed that second red and left the
// script passing while asserting nothing. It asserts nothing: there is no
// failure counter in it at all.
const SKIP_GOVERNED_EXITCODE =
  HEADER('a skip-governed `process.exitCode` is not proof the script can fail') +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (skipped > 0) process.exitCode = 2;\n` +
  `console.log('done');\n`;

// §10 THE OPPOSITE BOUNDARY. A REAL failure verdict that happens to sit under a
// skip condition. Demoting it would report a script that CAN fail as one that
// cannot — a fresh false positive on a required check, which is this ticket's
// own defect committed by its fix. The exit's own argument is what saves it.
const FAILURE_VERDICT_UNDER_A_SKIP_CONDITION =
  HEADER('a failure verdict nested under a skip condition stays a failure verdict') +
  `let failures = 0;\n` +
  `let skipped = 0;\n` +
  `if (!peerIsUp()) skipped += 1;\n` +
  `if (skipped > 0) {\n` +
  `  console.log('reporting early because sections did not run');\n` +
  `  process.exit(failures ? 1 : 0);\n` +
  `}\n` +
  `process.exit(failures ? 1 : 0);\n`;

/**
 * §8's mutation: the shipped sweep's `consultedTallies` rewritten to read the
 * exit's EXPRESSION alone, which is what KAN-373 shipped and what this ticket
 * is the fix for.
 *
 * Applied by exact string replacement rather than by regex, and the replacement
 * is ASSERTED to have happened. A patch that silently fails to match leaves the
 * fixed sweep in place, §1's fixture keeps passing, and this section reports
 * `the fixture went red` — never. It would go green forever while measuring
 * nothing, which is the exact class KAN-119 and KAN-373 both exist to prevent,
 * committed by the script policing it.
 */
const CONSULTS_EXPRESSION_ONLY_FROM = `  const texts = [
    references(entry.expr),
    ...governingConditions(regions, entry.index).map(references)
  ];`;
const CONSULTS_EXPRESSION_ONLY_TO = `  // MUTATION — KAN-561 §8. KAN-373's expression-only check, restored on purpose.
  const texts = [references(entry.expr)];`;

const cleanup = [];

try {
  // -------------------------------------------------------------------------
  console.log('§1 a tally named in an exit\'s CONDITION is consulted — #247\'s shape passes');
  {
    const tree = treeWith({ 'verify-condition-consulted.mjs': CONDITION_CONSULTED });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-condition-consulted');
    check('the fixture produces a row', !!r, `no row in:\n${run.stdout}`);
    check(
      'it is NOT named as tallying skips nothing reads',
      blindScripts(run.stdout).length === 0,
      `named: ${JSON.stringify(blindScripts(run.stdout))}`
    );
    check(
      `the sweep is green for it (exited ${run.code})`,
      run.code === 0,
      'the false positive KAN-561 was filed for is still present'
    );
    check(
      `the constant exit is a SKIP verdict, not a guard (skips ${r ? r.skips.length : 'no row'}, guards ${r ? r.guardCount : '-'})`,
      !!r && r.skips.length === 1 && r.guardCount === 0,
      `calling it a guard is what made the false positive unreadable — skips: ${JSON.stringify(r ? r.skips.map((s) => s.text) : [])}`
    );
    check(
      'the skip verdict names the condition that reaches it',
      !!r && r.skips.some((s) => /reached only when `skipped > 0 && !allowSkipped`/.test(s.why)),
      `why strings: ${JSON.stringify(r ? r.skips.map((s) => s.why) : [])}`
    );
    check(
      `it still has its own failure verdict (found ${r ? r.verdictCount : 'no row'})`,
      !!r && r.verdictCount === 1,
      'the skip verdict swallowed the failure verdict'
    );
  }

  // -------------------------------------------------------------------------
  console.log('§2 a tally NO exit names is still caught — the arm widening would break');
  {
    const tree = treeWith({ 'verify-genuinely-blind.mjs': GENUINELY_BLIND });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const named = blindScripts(run.stdout);
    check(
      `it IS named as tallying skips nothing reads (found ${named.length})`,
      named.length === 1 && /verify-genuinely-blind\.mjs$/.test(named[0].rel),
      `KAN-373's own defect is no longer caught — named: ${JSON.stringify(named)}`
    );
    check(
      'the tally it names is `skipped`',
      named.length === 1 && named[0].tallies === 'skipped',
      `tallies reported: ${JSON.stringify(named.map((n) => n.tallies))}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'a script whose skip tally reaches no exit passed the required check'
    );
  }

  // -------------------------------------------------------------------------
  console.log('§3 a skip-only exit does NOT make a script able to report failure');
  {
    const tree = treeWith({ 'verify-skip-only-exit.mjs': SKIP_ONLY_EXIT });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-skip-only-exit');
    check('the fixture produces a row', !!r, `no row in:\n${run.stdout}`);
    check(
      `it has NO failure verdict (found ${r ? r.verdictCount : 'no row'})`,
      !!r && r.verdictCount === 0,
      'a skip verdict was credited as proof the script can fail — this is KAN-119 gutted'
    );
    check(
      `its exit is scored a skip verdict (found ${r ? r.skips.length : 'no row'})`,
      !!r && r.skips.length === 1,
      `skips: ${JSON.stringify(r ? r.skips.map((s) => s.text) : [])}`
    );
    check(
      'the sweep names it as unable to fail, and names the near miss',
      /none a failure verdict; 1 report only SKIPS/.test(run.stdout),
      `the sweep said:\n${run.stdout}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'a script that cannot report failure passed the required check'
    );
  }

  // -------------------------------------------------------------------------
  console.log('§4 a condition naming both a counter and a tally is a FAILURE verdict');
  {
    const tree = treeWith({ 'verify-both-in-one.mjs': BOTH_IN_ONE_CONDITION });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-both-in-one');
    check('the fixture produces a row', !!r, `no row in:\n${run.stdout}`);
    check(
      `the exit is a failure verdict, not a skip verdict (verdicts ${r ? r.verdictCount : '-'}, skips ${r ? r.skips.length : '-'})`,
      !!r && r.verdictCount === 1 && r.skips.length === 0,
      'the skip branch is being reached before the counter branch — precedence is inverted'
    );
    check(
      'and the tally is still counted as consulted',
      blindScripts(run.stdout).length === 0,
      `named: ${JSON.stringify(blindScripts(run.stdout))}`
    );
  }

  // -------------------------------------------------------------------------
  console.log('§5 a tally spelled as an object KEY in a condition has not been read');
  {
    const tree = treeWith({ 'verify-key-spelled.mjs': TALLY_ONLY_AS_A_KEY });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const named = blindScripts(run.stdout);
    check(
      `it IS named as tallying skips nothing reads (found ${named.length})`,
      named.length === 1 && /verify-key-spelled\.mjs$/.test(named[0].rel),
      `a tally spelled as a key passed as a reference — the \`references\` defence is not applied to conditions: ${JSON.stringify(named)}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'spelling a tally as a key cleared the check'
    );
  }

  // -------------------------------------------------------------------------
  console.log('§6 an `if` naming the tally that governs no exit does not count');
  {
    const tree = treeWith({ 'verify-skip-if-governs-nothing.mjs': SKIP_IF_GOVERNS_NOTHING });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const named = blindScripts(run.stdout);
    const r = parseReport(run.stdout).get('verify-skip-if-governs-nothing');
    check(
      `it IS named as tallying skips nothing reads (found ${named.length})`,
      named.length === 1 && /verify-skip-if-governs-nothing\.mjs$/.test(named[0].rel),
      `proximity was taken for control flow — KAN-540's retired window is back: ${JSON.stringify(named)}`
    );
    check(
      `no exit was scored a skip verdict (found ${r ? r.skips.length : 'no row'})`,
      !!r && r.skips.length === 0,
      `skips: ${JSON.stringify(r ? r.skips.map((s) => s.text) : [])}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'an `if` governing only a `console.log` cleared the check'
    );
  }

  // -------------------------------------------------------------------------
  // §7 No fixtures. The shipped sweep, this repository, the real scripts.
  // -------------------------------------------------------------------------
  console.log('§7 this repository: every script that tallies skips is found to consult them');
  const realRun = runSweep(path.join(scriptDir, SWEEP));
  {
    if (verbose) console.log(realRun.stdout);
    // POSITIVE CONTROL FOR THE READ, and it comes before every claim below.
    // Each of those is of the form "no script here is named blind", and a
    // truncated report answers that trivially — a fact about the read arriving
    // as a finding about the repository. The count is the sweep's own.
    const swept = sweptCount(realRun.stdout);
    const rows = parseReport(realRun.stdout);
    check(
      `the report is complete — ${rows.size} rows for the ${swept} the sweep says it swept`,
      swept !== null && rows.size === swept,
      'the report arrived short, so nothing below is a claim about this repository'
    );
    const named = blindScripts(realRun.stdout);
    check(
      `no script in this repository is named as tallying skips nothing reads (found ${named.length})`,
      named.length === 0,
      `named: ${JSON.stringify(named)}`
    );
    // The sweep prints how many scripts tally skips only when it is green, and
    // it is read here rather than written down: a number in this file would be
    // a fact about the afternoon it was typed on. It is asserted non-zero so
    // that the assertion above cannot be satisfied by there being nothing to
    // check — the empty-set trapdoor this repository names as its own rule.
    const tallying = realRun.stdout.match(/each of the (\d+) that tally skips/);
    check(
      `and the check has something to be right about — ${tallying ? tallying[1] : 'no'} script(s) tally skips`,
      !!tallying && Number(tallying[1]) > 0,
      'no script here tallies skips at all, so §7 asserts nothing — the green above is vacuous'
    );
    check(
      `this repository sweeps clean (exit ${realRun.code})`,
      realRun.code === 0,
      'the shipped sweep is red against this checkout'
    );
  }

  // -------------------------------------------------------------------------
  // §8 The red drive, inline: restore KAN-373's check and watch §1 go red.
  // -------------------------------------------------------------------------
  console.log('§8 RED DRIVE — with the expression-only check restored, #247\'s shape fails again');
  {
    const mutated = treeWith({ 'verify-condition-consulted.mjs': CONDITION_CONSULTED });
    cleanup.push(mutated.root);
    const sweepPath = path.join(mutated.scripts, SWEEP);
    const before = fs.readFileSync(sweepPath, 'utf8');
    const after = before.replace(CONSULTS_EXPRESSION_ONLY_FROM, CONSULTS_EXPRESSION_ONLY_TO);
    // Asserted, not assumed. See the note on the mutation constants above: an
    // unapplied patch makes every check below pass while measuring nothing.
    check(
      'the mutation applied — the shipped sweep still has the shape §8 patches',
      after !== before,
      'the anchor text has moved; §8 measured the FIXED sweep and its greens below are worthless'
    );
    fs.writeFileSync(sweepPath, after);
    const run = runSweep(mutated.sweep);
    if (verbose) console.log(run.stdout);
    const named = blindScripts(run.stdout);
    check(
      `the mutated sweep still produces a row for the fixture`,
      !!parseReport(run.stdout).get('verify-condition-consulted'),
      `the mutation broke the sweep rather than its skip check:\n${run.stdout}`
    );
    check(
      `#247's shape is falsely named blind again (found ${named.length})`,
      named.length === 1 && /verify-condition-consulted\.mjs$/.test(named[0].rel),
      '§1 did NOT go back to failing — it is not measuring consultation, and its green is not evidence'
    );
    check(
      `the mutated sweep goes red for it (exited ${run.code})`,
      run.code === 1,
      'the required check stayed green under the mutation, so something other than the condition read is holding §1'
    );
  }
  // -------------------------------------------------------------------------
  console.log('§9 a skip-governed `process.exitCode` is not a failure verdict either');
  {
    const tree = treeWith({ 'verify-skip-governed-exitcode.mjs': SKIP_GOVERNED_EXITCODE });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-skip-governed-exitcode');
    check('the fixture produces a row', !!r, `no row in:\n${run.stdout}`);
    check(
      `it has NO failure verdict (found ${r ? r.verdictCount : 'no row'})`,
      !!r && r.verdictCount === 0,
      'the `exitCode` branch credited a skip-governed assignment as proof the script can fail — a script asserting nothing passes the required check'
    );
    check(
      `the assignment is scored a skip verdict (found ${r ? r.skips.length : 'no row'})`,
      !!r && r.skips.length === 1,
      `skips: ${JSON.stringify(r ? r.skips.map((s) => s.text) : [])}`
    );
    check(
      'the tally is still counted as consulted — this is a canFail failure, not a skip one',
      blindScripts(run.stdout).length === 0,
      `named: ${JSON.stringify(blindScripts(run.stdout))}`
    );
    check(
      `the sweep exits non-zero for it (exited ${run.code})`,
      run.code === 1,
      'a script with no failure counter in it at all passed the required check'
    );
  }

  // -------------------------------------------------------------------------
  console.log('§10 a REAL failure verdict under a skip condition is not demoted');
  {
    const tree = treeWith({ 'verify-verdict-under-skip.mjs': FAILURE_VERDICT_UNDER_A_SKIP_CONDITION });
    cleanup.push(tree.root);
    const run = runSweep(tree.sweep);
    if (verbose) console.log(run.stdout);
    const r = parseReport(run.stdout).get('verify-verdict-under-skip');
    check('the fixture produces a row', !!r, `no row in:\n${run.stdout}`);
    check(
      `both exits stay failure verdicts (verdicts ${r ? r.verdictCount : '-'}, skips ${r ? r.skips.length : '-'})`,
      !!r && r.verdictCount === 2 && r.skips.length === 0,
      'the skip override demoted a real verdict — a script that CAN fail is reported as one that cannot, which is this ticket\'s defect committed by its fix'
    );
    check(
      `the sweep is green for it (exited ${run.code})`,
      run.code === 0,
      'a correct script was failed by the check — the false positive, in a new place'
    );
  }
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`);
} else {
  console.log(
    '\x1b[32mAll checks passed\x1b[0m — a skip tally named in an exit\'s CONDITION is\n' +
      'consulted, a tally named at no exit is still caught, and an exit reached only on a\n' +
      'skip is not credited as proof the script can fail.\n\n' +
      'Note what §7 does and does not establish: it asserts that no script in THIS\n' +
      'repository is currently named blind, which is a claim about the scripts that exist\n' +
      'today. It is not a claim that the check would catch every shape — §2, §5 and §6 are\n' +
      'the shapes tested, and they are fixtures this script wrote.'
  );
}

process.exit(failures ? 1 : 0);
