// KAN-206: show `sweep-verify-exit-paths` going red, and for which reason.
//
// WHAT FAILURE THIS WOULD CATCH: `sweep-verify-exit-paths.mjs` losing the
// ability to report the thing it was extended to report — a `verify-` script
// whose verdict exit nothing can reach — while continuing to print ALL PASS.
// The sweep is a required check; a required check that cannot go red is worse
// than no check, because it is read as coverage.
//
// This is named `repro-` rather than `verify-`: it proves nothing about the
// product, only about a tool, and the sweep's own header explains why such a
// thing has no business in the namespace the sweep polices. It is deliberately
// kept out of the swept set for the same reason a guard should not live inside
// the thing it guards.
//
// WHY IT IS NEEDED AT ALL
//
// The sweep passed on its first complete run, on all 45 scripts, and would have
// passed identically with its detector blinded — the empty-alternative bug in
// its mutation regex made every line in every file look like a way to fail, and
// the output was a clean table of large numbers. A proof that has only ever
// passed is evidence of nothing. So this file constructs the defects, runs the
// real sweep against them, and asserts that it goes red *and names them*.
//
// WHAT IT WRITES, AND WHAT THAT LEAVES UNCOVERED
//
// This script writes the fixture `verify-` scripts it then asserts on. A proof
// that supplies its own input has not tested that the input arrives: nothing
// here establishes that the sweep is pointed at the real `daemon/scripts` and
// `extension/scripts` in CI, only that it judges correctly whatever it is
// pointed at. That half is covered by the `verify-script-sweep` job running the
// sweep against the checkout with no arguments, and by its output naming all 45
// real scripts — which is visible in the job log and pasted in the KAN-206 PR.
//
// Usage: node daemon/scripts/repro-unreachable-verdict.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.join(scriptDir, 'sweep-verify-exit-paths.mjs');
const verbose = process.argv.includes('--verbose');

if (!fs.existsSync(SWEEP)) {
  console.error(`setup: ${SWEEP} is missing — nothing to reproduce against.`);
  process.exit(2);
}

const failures = [];
const check = (ok, claim, detail) => {
  if (!ok) failures.push(`${claim}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${claim}${!ok && detail ? ` — ${detail}` : ''}`);
};

/** A `verify-` script that is healthy by every property the sweep checks. */
const HEALTHY = `// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.
const failures = [];
const check = (ok, why) => {
  if (!ok) failures.push(why);
  console.log(\`  \${ok ? 'ok' : 'FAIL'}  \${why}\`);
};
check(1 === 1, 'one is one');
process.exit(failures.length ? 1 : 0);
`;

/** Level 3 satisfied, level "reachable" not: nothing ever touches `failures`. */
const COUNTER_NEVER_SET = `// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.
let failures = 0;
console.log('  ok    everything looks fine');
process.exit(failures ? 1 : 0);
`;

/** The helper exists, pushes onto the counter, and is never called. */
const HELPER_NEVER_CALLED = `// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.
const failures = [];
const check = (ok, why) => {
  if (!ok) failures.push(why);
};
console.log('  ok    everything looks fine');
process.exit(failures.length ? 1 : 0);
`;

/**
 * Stand up a throwaway tree the sweep will accept as a repository: it resolves
 * its own root two levels up from itself, so the copy has to sit at
 * <root>/daemon/scripts/ with a sibling <root>/extension/scripts/.
 */
function tree(fixtures, { sweepSource } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan206-'));
  fs.mkdirSync(path.join(root, 'daemon', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'extension', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'daemon', 'scripts', 'sweep-verify-exit-paths.mjs'),
    sweepSource ?? fs.readFileSync(SWEEP, 'utf8')
  );
  for (const [name, source] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(root, 'daemon', 'scripts', name), source);
  }
  return root;
}

function runSweep(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'daemon', 'scripts', 'sweep-verify-exit-paths.mjs'), '--verbose'], {
    encoding: 'utf8'
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (verbose) console.log(out.split('\n').map((l) => `      | ${l}`).join('\n'));
  return { code: r.status, out };
}

const rule = (n, title) => console.log(`\n${n}. ${title}\n${'-'.repeat(76)}`);

// --------------------------------------------------------------- 1. green --
rule(1, 'GREEN FIRST — a healthy fixture, so the reds below mean something');
{
  const { code, out } = runSweep(tree({ 'verify-fixture-healthy.mjs': HEALTHY }));
  check(code === 0, 'the sweep exits 0 on a tree whose only script is healthy', `exit ${code}`);
  check(/ALL PASS/.test(out), 'and says ALL PASS');
  // A count, not an exact one: adding a fixture must not fail this, but
  // deleting the self-test — or gutting it down to a token case — must.
  const fixtures = Number(out.match(/all (\d+) fixtures behaved as specified/)?.[1] ?? 0);
  check(fixtures >= 5, 'having first self-tested its detector on at least 5 fixtures', `saw ${fixtures}`);
}

// ------------------------------------------------- 2. counter never set --
rule(2, 'RED — a verdict-shaped exit over a counter nothing increments');
{
  const { code, out } = runSweep(
    tree({ 'verify-fixture-healthy.mjs': HEALTHY, 'verify-fixture-counter.mjs': COUNTER_NEVER_SET })
  );
  check(code === 1, 'the sweep exits 1', `exit ${code}`);
  check(/verify-fixture-counter\.mjs/.test(out), 'and names the script it is red about');
  check(
    /verdict-shaped exit that nothing can reach/.test(out),
    'and gives the reachability reason, not the level-3 one'
  );
  check(!/ALL PASS/.test(out), 'and does not claim ALL PASS');
  check(
    /verify-fixture-healthy\s+\S+\s+1\s/.test(out) || /verify-fixture-healthy/.test(out),
    'while the healthy script beside it is still reported'
  );
}

// ----------------------------------------------- 3. helper never called --
rule(3, 'RED — the helper that records a FAIL exists, and nobody calls it');
{
  const { code, out } = runSweep(
    tree({ 'verify-fixture-healthy.mjs': HEALTHY, 'verify-fixture-orphan.mjs': HELPER_NEVER_CALLED })
  );
  check(code === 1, 'the sweep exits 1', `exit ${code}`);
  check(/verify-fixture-orphan\.mjs/.test(out), 'and names it');
  check(
    /verdict-shaped exit that nothing can reach/.test(out),
    'for the same reason — a helper nobody calls is not a call site'
  );
}

// ------------------------------------------------- 4. the detector blind --
rule(4, 'RED — the detector blinded, which is how this check would die quietly');
{
  // Reproduce the original bug in kind: a mask that eats the file. Every
  // identifier disappears, so no script has a recognisable helper, and the
  // naive outcome is a clean sweep over an empty analysis.
  const blinded = fs
    .readFileSync(SWEEP, 'utf8')
    .replace('function codeMask(src) {', 'function codeMask(src) {\n  return src.replace(/[^\\n]/g, " ");');
  check(blinded !== fs.readFileSync(SWEEP, 'utf8'), 'the blinding patch applied', 'codeMask signature not found');

  const { code, out } = runSweep(tree({ 'verify-fixture-healthy.mjs': HEALTHY }, { sweepSource: blinded }));
  check(code === 1, 'a blinded detector exits 1 rather than reporting a clean sweep', `exit ${code}`);
  check(
    /fixture\(s\) came back wrong/.test(out),
    'and the self-test is what catches it, before any real script is judged'
  );
  check(!/ALL PASS/.test(out), 'and it never prints ALL PASS');
}

// ------------------------------------------------------------ 5. verdict --
console.log(`\n${'='.repeat(76)}`);
if (failures.length) {
  console.log(`${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nThe sweep is not doing what its header claims. Fix the sweep, not this file.');
} else {
  console.log(
    'The sweep goes red on both unreachable-verdict shapes, names them, gives the\n' +
      'reachability reason rather than the level-3 one, and refuses to report a clean\n' +
      'sweep when its own detector is blinded.\n\n' +
      'It remains true that a `check(true, …)` is a call site here. Nothing in this\n' +
      'file establishes that any real assertion can be false.'
  );
}
process.exit(failures.length ? 1 : 0);
