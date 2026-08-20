// KAN-373: a section that did not run is not a section that passed, and the
// exit code is where that distinction has to live.
//
// WHAT FAILURE THIS WOULD CATCH: `lib/verdict-exit.mjs` regressing to
// `failures ? 1 : 0` — the shape six scripts held at once, where a live
// section skipping for want of a peer still exited 0, so a caller wiring the
// script as a gate could not tell "the peer proved it" from "nobody started a
// peer". It would also catch the two ways the fix decays: a failure being
// SOFTENED to the incomplete code (2 is quieter than 1, and the quieter of two
// true statements is how this class survives review), and `--allow-skipped`
// growing the power to silence a real failure rather than only an unrun
// section.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS WHAT THAT LEAVES ─────────────
//
// §1 hands `verdictFor` its inputs directly. It is a proof that supplies its
// own input (KAN-145) and it says so — what it establishes is that the DECISION
// is right across the input space, and nothing about whether any real script
// reaches it with real tallies.
//
// §2 closes half of that by spawning REAL `node` processes and reading the exit
// status the OS actually saw. A return value is not an exit code; §1 could be
// green on a helper that computed the right number and never handed it to
// `process.exit`.
//
// §3 closes the other half against a REAL script — `verify-crabcast-census-
// disclosure.mjs`, the instance KAN-373 was filed on — run end to end with no
// socket. That is the only section here that would notice the six scripts being
// unwired from the helper.
//
// WHAT NOBODY COVERS: that the OTHER five scripts reach the helper with correct
// tallies. `sweep-verify-exit-paths.mjs` asks structurally whether each one's
// skip tally reaches a verdict exit — necessary, not sufficient, and it is a
// different question from whether the tally is CORRECT. No script owns that,
// and it is named here rather than left to be inferred from a green run.
//
// CI-RUNNABLE: partial — §1 and §2 need no peer, no herdr, no PTY, no
// credential and no network; they read this repository's own helper and spawn
// `node`. §3 needs `daemon/dist` and SKIPS without it, which makes THIS script
// exit 2 rather than 0 — the contract under test applied to itself, and
// deliberate. `run-ci-verify-set.mjs` builds before it runs, so §3 executes
// there; the `verify-script-sweep` job does not build, and that step passes
// `--allow-skipped` to say so out loud.
//
// ── DRIVING IT RED ────────────────────────────────────────────────────────
//
// Three mutations in `daemon/scripts/lib/verdict-exit.mjs`, each hitting a
// different section. No build step is involved — this script and the helper are
// both `.mjs` read straight off disk, so there is no `dist` to go stale and the
// KAN-314 build-first rule does not bind on §1 or §2. §3 runs a script that
// DOES import `dist`, so confirm the build exited 0 before reading §3.
//
// The counts below are MEASURED, not predicted — the first draft of this
// paragraph guessed two of them wrong (it had §2 staying green under mutation
// 2, which it does not), and a red drive described inaccurately is the same
// defect this ticket is about wearing the reviewer's clothes.
//
//   1. THE WHOLE DEFECT, restored. Make the skipped branch return EXIT_PASS
//      instead of EXIT_INCOMPLETE. Five reds: §1 on both incomplete cases, §2
//      on the process-boundary pair, §3 reporting 0 where 2 was required. This
//      is the only mutation §3 can see, which is what makes §3 worth its
//      runtime.
//   2. SOFTENING A FAILURE. Narrow the `f > 0` branch to `f > 0 && s === 0`, so
//      a run that both failed and skipped reports 2. Three reds: §1's two mixed
//      cases and §2's `--allow-skipped cannot turn a real failure green`. §3
//      stays green — its script has no failures, which localises the mutation
//      to the mixed case exactly.
//   3. THE FLAG OVERREACHING. Return EXIT_PASS whenever `allowSkipped`, before
//      the `f > 0` test. Three reds: §1's two allowSkipped-with-failures cases
//      and the same §2 assertion. §3 stays green, for the same reason.
//
// Note that 2 and 3 produce overlapping but NOT identical reds — the pair that
// separates them is `failures=1 skipped=0 allowSkipped=true`, which only 3
// reaches. Real output of all three is pasted in the PR body.
//
// Usage: node daemon/scripts/verify-skip-is-not-a-pass.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  verdictFor,
  reportAndExit,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_INCOMPLETE,
  ALLOW_SKIPPED_FLAG
} from './lib/verdict-exit.mjs';

const verbose = process.argv.includes('--verbose');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = path.join(repoRoot, 'daemon', 'dist');

let failures = 0;
let skipped = 0;

const rule = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
function ok(m) {
  console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
}
function bad(m, detail) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
  if (detail !== undefined) console.log(`       ${detail}`);
}
function check(cond, m, detail) {
  if (cond) ok(m);
  else bad(m, detail);
}
function skip(m, why) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);
  console.log(`       ${why}`);
}

// =============================================================================
rule('1. THE DECISION — verdictFor across the input space');
// Every combination that matters, with the REQUIRED code written out rather
// than computed, so this table cannot agree with the implementation by sharing
// its arithmetic.
{
  const cases = [
    { failures: 0, skipped: 0, allowSkipped: false, want: EXIT_PASS, why: 'ran clean' },
    { failures: 0, skipped: 0, allowSkipped: true, want: EXIT_PASS, why: 'the flag changes nothing when nothing skipped' },
    { failures: 0, skipped: 1, allowSkipped: false, want: EXIT_INCOMPLETE, why: 'THE DEFECT: a skip is not a pass' },
    { failures: 0, skipped: 9, allowSkipped: false, want: EXIT_INCOMPLETE, why: 'many skips, same verdict' },
    { failures: 0, skipped: 1, allowSkipped: true, want: EXIT_PASS, why: 'the caller asserted it accepts an incomplete run' },
    { failures: 1, skipped: 0, allowSkipped: false, want: EXIT_FAIL, why: 'an ordinary failure' },
    { failures: 1, skipped: 0, allowSkipped: true, want: EXIT_FAIL, why: 'the flag cannot silence a failure' },
    { failures: 1, skipped: 1, allowSkipped: false, want: EXIT_FAIL, why: 'a failure OUTRANKS a skip — never softened to 2' },
    { failures: 3, skipped: 2, allowSkipped: true, want: EXIT_FAIL, why: 'both at once, and the flag still cannot silence it' }
  ];
  for (const c of cases) {
    const got = verdictFor(c);
    check(
      got.code === c.want,
      `failures=${c.failures} skipped=${c.skipped} allowSkipped=${c.allowSkipped} -> ${c.want}  (${c.why})`,
      `got ${got.code} — "${got.headline}"`
    );
  }

  // The headline must not claim more than the mechanism covers, which is the
  // defect class this whole ticket is an instance of.
  const inc = verdictFor({ failures: 0, skipped: 1, allowSkipped: false });
  check(
    !/^All assertions passed/.test(inc.headline),
    'an incomplete run is not headlined "All assertions passed"',
    inc.headline
  );
  check(
    inc.detail !== null && inc.detail.includes(ALLOW_SKIPPED_FLAG),
    'and it names the flag that would accept it, so the reader is not left guessing',
    JSON.stringify(inc.detail)
  );

  // A tally the script never kept cannot produce a verdict. No `?? 0`.
  for (const bogus of [undefined, null, -1, 1.5, '0', NaN]) {
    let threw = false;
    try {
      verdictFor({ failures: bogus, skipped: 0 });
    } catch {
      threw = true;
    }
    // Rendered with its TYPE, because neither obvious spelling is readable on
    // its own: `JSON.stringify` prints NaN as `null` (colliding with the null
    // case), and bare `String` prints the STRING '0' as `0`, which reads as the
    // number 0 — a value that is legitimately accepted. An output line that
    // cannot be told from another case is not evidence.
    check(
      threw,
      `a \`failures\` of ${typeof bogus} ${String(bogus)} throws rather than defaulting to 0`
    );
  }
}

// =============================================================================
rule('2. THE EXIT CODE THE OS SAW — real processes, not return values');
// §1 proves the decision. This proves it reaches `process.exit`, which is a
// different claim: a helper that computed 2 and exited 0 would pass §1.
{
  const helperUrl = pathToFileURL(path.join(scriptDir, 'lib', 'verdict-exit.mjs')).href;
  const run = (f, s, argv) => {
    const prog =
      `const m = await import(${JSON.stringify(helperUrl)});` +
      `m.reportAndExit({ failures: ${f}, skipped: ${s}, argv: ${JSON.stringify(argv)} });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', prog], {
      encoding: 'utf8'
    });
    if (verbose) console.log(`       [f=${f} s=${s} argv=${JSON.stringify(argv)}] -> ${r.status}`);
    return r;
  };

  const clean = run(0, 0, []);
  check(clean.status === EXIT_PASS, `a clean run exits ${EXIT_PASS}`, `got ${clean.status}`);

  const incomplete = run(0, 1, []);
  check(
    incomplete.status === EXIT_INCOMPLETE,
    `a skipped-but-not-failed run exits ${EXIT_INCOMPLETE} — THE DEFECT, at the process boundary`,
    `got ${incomplete.status}: ${incomplete.stdout}`
  );
  check(
    incomplete.status !== EXIT_PASS,
    'and specifically NOT 0, which is what every caller reads as "the gate held"',
    `got ${incomplete.status}`
  );

  const allowed = run(0, 1, [ALLOW_SKIPPED_FLAG]);
  check(
    allowed.status === EXIT_PASS,
    `${ALLOW_SKIPPED_FLAG} brings an incomplete run back to ${EXIT_PASS}`,
    `got ${allowed.status}`
  );

  const failed = run(2, 0, []);
  check(failed.status === EXIT_FAIL, `a failing run exits ${EXIT_FAIL}`, `got ${failed.status}`);

  const failedAllowed = run(2, 1, [ALLOW_SKIPPED_FLAG]);
  check(
    failedAllowed.status === EXIT_FAIL,
    `${ALLOW_SKIPPED_FLAG} cannot turn a real failure green`,
    `got ${failedAllowed.status}`
  );
}

// =============================================================================
rule('3. THE REAL SCRIPT — the instance this ticket was filed on');
// The only section here that would notice the six scripts being unwired from
// the helper. Runs the census proof end to end against a socket that is not
// there, which is precisely the condition that used to exit 0.
{
  const target = path.join(scriptDir, 'verify-crabcast-census-disclosure.mjs');
  if (!fs.existsSync(path.join(distDir, 'crabcast-runtime.js'))) {
    skip(
      'no build at daemon/dist',
      'That script imports from `dist` and guards on it, so without a build this section ' +
        'would measure the guard rather than the verdict. Run `npm run build` in daemon/. ' +
        'This skip is why THIS script exits 2 rather than 0 — the contract applied to itself.'
    );
  } else {
    const runIt = (extra) =>
      spawnSync(process.execPath, [target, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, BUTCHR_CRABCAST_SOCKET: '/nonexistent/kan-373-no-peer.sock' }
      });

    const bare = runIt([]);
    check(
      bare.status === EXIT_INCOMPLETE,
      `with no socket it exits ${EXIT_INCOMPLETE} — it exited 0 before KAN-373`,
      `got ${bare.status}`
    );
    check(
      /SKIP/.test(bare.stdout) && /no live CrabCast/.test(bare.stdout),
      'and the skip it is reporting is the live-peer section, named in the output',
      verbose ? bare.stdout.slice(-400) : '(run with --verbose for the tail)'
    );

    const allowed = runIt([ALLOW_SKIPPED_FLAG]);
    check(
      allowed.status === EXIT_PASS,
      `and ${ALLOW_SKIPPED_FLAG} makes the same run exit ${EXIT_PASS}, on the caller's own say-so`,
      `got ${allowed.status}`
    );
  }
}

// =============================================================================
console.log('');
reportAndExit({ failures, skipped });
