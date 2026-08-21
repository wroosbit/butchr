// CI-RUNNABLE: yes — KAN-576. Pure arithmetic over strings, plus one fixture
// repository built in a temp directory. Needs no daemon, no herdr and no peer.
//
// WHAT FAILURE THIS WOULD CATCH: `run-ci-verify-set.mjs` reducing a failing
// child's output to a window that does not say it is one. Before KAN-576 that
// window was `out.split('\n').slice(-25)`, so a proof whose failure sat
// anywhere but at its end produced a CI red naming NO ASSERTION — measured on
// `verify-runtime-pin-spares-test-daemons.mjs` in run 32456060343, where §2
// broke, §2 sits eight lines in, and every line naming a failure had scrolled
// off the top. What reached the log was seven PASS lines and `1 FAILURE(S)`:
// well-formed, tidy, entirely green, and wrong about the run it described.
//
// ── WHAT EACH SECTION COVERS, AND WHERE THE EDGE OF THIS SCRIPT IS ─────────
//
// §1–§3 CONSTRUCT THEIR OWN INPUT. They hand `failureExcerpt` strings this file
// wrote and assert on what comes back, so they prove the reducer's arithmetic
// and NOT that anything calls it. `prompts/task.md`: "a proof that supplies its
// own input has not tested that the input arrives" — KAN-145 shipped two green
// scripts and a field that was null in production for exactly that reason.
//
// §4 IS WHAT CLOSES THAT GAP, and it is the section to keep if you are ever
// choosing. It builds a throwaway repository in a temp directory, copies in the
// REAL `run-ci-verify-set.mjs` and the REAL `lib/`, gives it one fixture proof
// whose only failure sits at the top, and runs the harness as a child process.
// What it asserts on is the harness's own stdout. No stub, no injected reducer,
// no assertion about a function this file called itself.
//
// §5 is the static half of the same question — that the retired `.slice(-25)`
// idiom has not come back alongside the helper — and it reads the harness as
// text, so it is unaffected by whether anything is built.
//
// NOT COVERED, stated rather than left to be inferred: whether the rescue's
// vocabulary matches a script nobody has written yet. It cannot be, and that is
// the design rather than a hole — §2 covers the marker path and §1 covers the
// script that matches no marker at all, which is the case that must degrade to
// "N lines not shown" instead of to silence. See `lib/failure-excerpt.mjs`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { failureExcerpt, FAILURE_MARKER } from './lib/failure-excerpt.mjs';
import { reportAndExit } from './lib/verdict-exit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const check = (ok, name, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

// ── §1 the notice is unconditional ────────────────────────────────────────
//
// The load-bearing section. A script whose output names its failure in a
// vocabulary this reducer does not know must still be told it was cut.
console.log('== §1 a reduced output says it was reduced, with no marker anywhere ==');
{
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} — nothing here matches the marker`);
  const r = failureExcerpt(lines.join('\n'), { tail: 25 });
  const text = r.lines.join('\n');

  check(r.rescued === 0, 'nothing was rescued (the control: this input matches no marker)', `rescued=${r.rescued}`);
  check(r.dropped === 35, 'the dropped count is exact — 60 lines, a 25-line window', `dropped=${r.dropped}`);
  check(/… 35 earlier line\(s\) not shown/.test(text), 'and it is SAID, in the output, naming the count');
  check(text.includes('line 60'), 'the tail itself survives');
  check(!text.includes('line 35'), 'and the dropped region really is dropped');
}
{
  // The other half of the same claim: a window that drops nothing must not
  // invent a notice. A guard that fires on every input has not measured one.
  const r = failureExcerpt(['a', 'b', 'c'].join('\n'), { tail: 25 });
  check(r.dropped === 0 && !r.lines.join('\n').includes('not shown'), 'a short output gets no notice', `dropped=${r.dropped}`);
}

// ── §2 the rescue names the assertion ─────────────────────────────────────
console.log('== §2 KAN-576\'s own shape: the failure is at the top ==');
{
  // Deliberately the measured case: four sections, ~50 lines, the one broken
  // assertion in §2, everything after it green.
  const out = [
    '== §1 the socket is private ==',
    ...Array.from({ length: 6 }, (_, i) => `  PASS  §1.${i + 1} a private socket reads CARRIED`),
    '== §2 the pin spares a test daemon ==',
    '  FAIL  §2.1 the pin refused a daemon it should have spared',
    '        expected NOTHING-PINNED, got a refusal',
    ...Array.from({ length: 30 }, (_, i) => `  PASS  §3.${i + 1} filler`),
    '16/17 checks passed',
    '1 FAILURE(S)'
  ].join('\n');
  const text = failureExcerpt(out, { tail: 25 }).lines.join('\n');

  check(text.includes('§2.1 the pin refused a daemon it should have spared'), 'the broken assertion is NAMED');
  check(text.includes('expected NOTHING-PINNED'), 'and its detail line came with it');
  check(/… \d+ earlier line\(s\) not shown/.test(text), 'the §1 block it was lifted out of is reported as dropped');

  // Order is part of the report: a §2 failure printed below the §4 tail reads
  // as a different run than the one that happened.
  check(
    text.indexOf('§2.1 the pin refused') < text.indexOf('1 FAILURE(S)'),
    'and it is printed in source order, above the tail'
  );
}
{
  const r = failureExcerpt(['✗ FAILED: the thing', ...Array.from({ length: 40 }, () => 'noise')].join('\n'), { tail: 25 });
  check(r.lines.join('\n').includes('✗ FAILED: the thing'), 'the glyph vocabulary is rescued too');
}

// ── §3 the arithmetic cannot drift from the prose ─────────────────────────
console.log('== §3 shown + dropped === total, over every window size ==');
{
  let bad = null;
  for (let total = 0; total <= 80 && bad === null; total += 7) {
    for (const tail of [0, 1, 3, 25, 200]) {
      const src = Array.from({ length: total }, (_, i) => (i % 9 === 0 ? `FAIL check ${i}` : `PASS check ${i}`));
      const r = failureExcerpt(src.join('\n'), { tail });
      const claimed = (r.lines.join('\n').match(/… (\d+) /g) ?? []).reduce((s, m) => s + Number(m.match(/\d+/)[0]), 0);
      if (r.shown + r.dropped !== r.total || claimed !== r.dropped) {
        bad = `total=${total} tail=${tail} shown=${r.shown} dropped=${r.dropped} claimedInProse=${claimed}`;
      }
    }
  }
  check(bad === null, 'the counts balance, and the notices sum to exactly what was dropped', bad ?? '');
  check(failureExcerpt('', { tail: 25 }).lines.length === 0, 'empty output produces no excerpt and no notice');
}
{
  // The marker is what the rescue rests on; a marker matching PASS lines would
  // quietly disable truncation altogether.
  check(!FAILURE_MARKER.test('  PASS  §1.1 a private socket reads CARRIED'), 'the marker does not match a PASS line');
  check(FAILURE_MARKER.test('  FAIL  §2.1 something'), 'the marker does match a FAIL line');
}

// ── §4 the real harness, run for real ─────────────────────────────────────
console.log('== §4 end to end: the harness itself, over a fixture whose failure is at the top ==');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan576-'));
  try {
    fs.mkdirSync(path.join(root, 'daemon/scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'daemon/dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'extension/dist'), { recursive: true });
    // The harness refuses to start without these two; it never reads them.
    fs.writeFileSync(path.join(root, 'daemon/dist/daemon.js'), '');
    fs.writeFileSync(path.join(root, 'extension/dist/sidepanel.html'), '');

    // The harness under test is THIS repository's, not a copy of one.
    fs.copyFileSync(
      path.join(REPO, 'daemon/scripts/run-ci-verify-set.mjs'),
      path.join(root, 'daemon/scripts/run-ci-verify-set.mjs')
    );
    for (const f of fs.readdirSync(path.join(REPO, 'daemon/scripts/lib'))) {
      const from = path.join(REPO, 'daemon/scripts/lib', f);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(root, 'daemon/scripts/lib', f));
    }

    fs.writeFileSync(
      path.join(root, 'daemon/scripts/verify-kan576-fixture.mjs'),
      [
        '// CI-RUNNABLE: yes — KAN-576 fixture. Asserts nothing real; it exists to fail.',
        '// WHAT FAILURE THIS WOULD CATCH: nothing. Never runs outside its temp directory.',
        "const L = ['== §1 ==' ];",
        "for (let i = 1; i <= 8; i++) L.push('  PASS  §1.' + i + ' filler');",
        "L.push('  FAIL  §2.1 THE-ASSERTION-THAT-BROKE');",
        "for (let i = 1; i <= 30; i++) L.push('  PASS  §3.' + i + ' filler');",
        "L.push('1 FAILURE(S)');",
        "console.log(L.join('\\n'));",
        'process.exit(1);'
      ].join('\n')
    );

    // The harness arms a working-tree guard before its first child and refuses
    // to run without one, so the fixture root has to be a repository.
    for (const a of [
      ['init', '-q'],
      ['add', '-A'],
      ['-c', 'user.email=k@576', '-c', 'user.name=kan576', 'commit', '-qm', 'fixture']
    ]) {
      const g = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
      if (g.status !== 0) throw new Error(`git ${a[0]} failed in the fixture root: ${g.stderr ?? ''}`);
    }

    const run = spawnSync(process.execPath, [path.join(root, 'daemon/scripts/run-ci-verify-set.mjs')], {
      cwd: path.join(root, 'daemon'),
      encoding: 'utf8',
      timeout: 120_000
    });
    const printed = `${run.stdout}${run.stderr}`;

    // The positive control. If the harness did not run the fixture at all, every
    // assertion below would go red for the wrong reason and read as this bug.
    check(printed.includes('FAIL  verify-kan576-fixture'), 'control: the harness ran the fixture and reported it FAILED');
    check(printed.includes('THE-ASSERTION-THAT-BROKE'), 'the harness NAMED the assertion that broke');
    check(/… \d+ earlier line\(s\) not shown/.test(printed), 'and the harness said what it had dropped');
    check(printed.includes('1 FAILURE(S)'), 'the tail is still printed as well');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── §5 the retired idiom has not come back ────────────────────────────────
console.log('== §5 the harness reduces through the helper, and nowhere else ==');
{
  const src = fs.readFileSync(path.join(REPO, 'daemon/scripts/run-ci-verify-set.mjs'), 'utf8');
  check(/from '\.\/lib\/failure-excerpt\.mjs'/.test(src), 'it imports the helper');
  check(/failureExcerpt\(/.test(src), 'and calls it');
  check(
    !/\.split\('\\n'\)\s*\.?slice\(\s*[^)]*-\d+/.test(src.replace(/\n/g, '')),
    'and no bare negative-slice tail survives anywhere in it'
  );
}

console.log('');
reportAndExit({ failures, skipped: 0 });
