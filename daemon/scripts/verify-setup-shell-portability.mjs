// KAN-568: a command in `docs/SETUP.md` cannot depend on the reader's login
// shell being bash without saying so, where the failure is silent.
//
// WHAT FAILURE THIS WOULD CATCH: step 1's keyring probe, written for six months
// as `secret-tool lookup service butchr account jira; echo "exit=$?"`. That line
// is a hard parse error under `fish` — and `fish` is the login shell on the
// second machine KAN-568 was rehearsed against. A step whose entire content is
// the exit code is handed to the reader with the exit code missing.
//
// KAN-602 CORRECTED WHAT HAPPENS AROUND THAT LINE, and the correction is the
// reason §5 exists. The unit fish refuses is the whole PARSE UNIT, not the one
// line, so what a `$?` costs depends on how much fish was reading:
//
//   `fish -c 'cmd; echo "exit=$?"'`   one unit  -> NOTHING runs, `cmd` included
//   `fish steps.fish`                 one unit  -> NOT ONE LINE of the file runs,
//                                                  including steps ABOVE the bad
//                                                  one; exits 127
//   two lines typed with Enter between -> two units -> `cmd` runs, the `$?` line
//                                                  is refused, exit code missing
//
// Only the third is quiet. The first two are loud and much broader, and the
// FILE case is the one a reader following a document actually meets.
//
// This header claimed the opposite until KAN-602 — "fish runs the command
// BEFORE the `$?` and only then refuses, so the reader sees the lookup's
// output". That is true only of the two-unit case, and §4 below had been
// written to ASSERT it: it required `FIRST_RAN` on stdout from a `fish -c`
// one-liner, which is a single unit. Measured on fish 3.7.0 that assertion is
// false, and §4 was failing on any machine that actually had fish. Nothing in
// CI runs this script, so the red was never seen. Measured now, on fish 3.7.0:
// bare, bash prints `exit=127`; fish prints nothing at all on stdout and exits
// `127`; wrapped in `bash -c '...'`, both print `exit=127`.
//
// It catches the general case rather than that one line: any NEW `$?` added to a
// fenced `bash` block in SETUP.md that is not inside an explicit `bash -c`
// wrapper. The next such line is the one this exists for; the original is
// already fixed.
//
// CI-RUNNABLE: partial — §1–§3 read `docs/SETUP.md` as TEXT and assert in full
// on any runner: they parse its fenced `bash` blocks, refuse a bare `$?` outside
// a `bash -c` wrapper, and prove the detector fires on a synthetic hazard it was
// never told about. Node builtins only — no build, no daemon, no herdr, no
// credential, no network, no wall clock. §4 runs the hazard against a REAL
// `fish` to show that a single parse unit is refused ENTIRE -- the command before
// the `$?` does not run either; a runner without `fish` on PATH announces that
// section SKIPPED, and a skip is printed as a skip and never counted as a pass.
// It is not mocked: the whole value of §4 is that the parse error is fish's own.
// §5 does the same for FILE mode — it writes a four-step fixture with a `$?` on
// line 3 and shows that none of the four ran, steps 1 and 2 above it included —
// and skips identically.
//
// READS SOURCE AS TEXT, NOT `dist`. This script imports nothing from
// `daemon/dist`, so a failed build does not invalidate its verdict — it read
// what you wrote. (See the `dist`-staleness rule in `prompts/task.md`: 17 of the
// scripts here do both and have to be read per-section. This one does not.)
//
// WHAT THIS DOES NOT COVER, AND WHO COVERS IT
//
// This script checks ONE construct — `$?` — because that is the one measured to
// fail while looking like it worked. It is not a general bash-to-fish linter and
// must not be read as one. Constructs deliberately NOT checked, because they
// were measured to work in fish at the time of writing: `export VAR=...`, brace
// expansion (`{a,b}`), and `$(...)`. Constructs not checked because they do not
// currently appear in SETUP.md and a check with no subject cannot go red:
// `[[ ]]`, `<<<`, `$(( ))`, arrays, and `VAR=x cmd` prefix assignment.
//
// §4 and §5 run the hazard against a real `fish` when one is present. They are
// the only sections that observe the world rather than the text; where `fish` is
// absent they SKIP, and a skip is not a pass. Nobody covers the fish behaviour on
// a runner without fish installed, and this header is the edge of what is
// claimed.
//
// §5 SUPPLIES ITS OWN INPUT — it writes the fixture it then asserts on — so per
// KAN-145 it proves that fish refuses such a file, NEVER that any line in
// `docs/SETUP.md` is such a file. §2 covers that second question, statically and
// over the real document. Neither executes SETUP.md's own blocks, and nothing
// does: no section here would notice a step that is portable but wrong. That
// gap is the clean-install rehearsal's (KAN-568), not this script's.
//
// §5 RUNS ITS POSITIVE CONTROL FIRST, and the order is load-bearing rather than
// tidy: its finding is that NO marker file was created, and an empty directory
// is equally what a typo in the fixture would produce. The control writes the
// same fixture with the `$?` removed and requires all three markers, so a §5
// that cannot create a marker at all reports a failed control instead of
// reporting the abort it was hoping for.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SETUP = path.join(repoRoot, 'docs', 'SETUP.md');

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  FAIL  ${m}`);
};
const ok = (m) => console.log(`  ok    ${m}`);

/**
 * Every fenced block tagged `bash`, with the 1-based line number its content
 * starts on, so a finding names a line the reader can open.
 */
function bashBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (current === null) {
      if (/^\s*```bash\s*$/.test(line)) current = { startLine: i + 2, body: [] };
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      blocks.push(current);
      current = null;
      continue;
    }
    current.body.push({ line: i + 1, text: line });
  }
  return blocks;
}

/**
 * A `$?` is acceptable only when the line explicitly names the shell that
 * defines it. `bash -c '...'` is the wrapper SETUP.md uses; `sh -c` counts too.
 */
function hazardsIn(blocks) {
  const found = [];
  for (const block of blocks) {
    for (const { line, text } of block.body) {
      if (!text.includes('$?')) continue;
      if (/\b(?:ba)?sh\s+-c\b/.test(text)) continue;
      found.push({ line, text: text.trim() });
    }
  }
  return found;
}

console.log('§1 docs/SETUP.md parses into fenced bash blocks');
if (!fs.existsSync(SETUP)) {
  fail(`${SETUP} does not exist -- this script has no subject.`);
  console.error('\n1 failure(s).');
  process.exit(1);
}
const markdown = fs.readFileSync(SETUP, 'utf8');
const blocks = bashBlocks(markdown);
if (blocks.length === 0) {
  fail('no ```bash blocks found -- the parser found nothing to check, which is not the same as nothing being wrong.');
} else {
  ok(`${blocks.length} bash block(s), ${blocks.reduce((n, b) => n + b.body.length, 0)} line(s)`);
}

console.log('\n§2 no bare `$?` in a bash block -- it is a parse error in fish');
const hazards = hazardsIn(blocks);
if (hazards.length === 0) {
  ok('none');
} else {
  for (const h of hazards) {
    fail(`docs/SETUP.md:${h.line} uses \`$?\` outside a \`bash -c\` wrapper: ${h.text}`);
  }
  console.error('       Wrap the line as `bash -c \'...\'` so it answers the same in every shell.');
}

console.log('\n§3 the detector fires on a hazard it was never told about');
{
  const bad = ['```bash', 'some-command; echo "exit=$?"', '```'].join('\n');
  const good = ['```bash', `bash -c 'some-command; echo "exit=$?"'`, '```'].join('\n');
  const notBash = ['```fish', 'some-command; echo "exit=$?"', '```'].join('\n');

  if (hazardsIn(bashBlocks(bad)).length === 1) {
    ok('a bare `$?` in a bash block is detected');
  } else {
    fail('a bare `$?` in a bash block was NOT detected -- §2 above could not have gone red.');
  }

  if (hazardsIn(bashBlocks(good)).length === 0) {
    ok('a `bash -c`-wrapped `$?` is correctly allowed');
  } else {
    fail('a `bash -c`-wrapped `$?` was flagged -- the check would demand a change that fixes nothing.');
  }

  if (hazardsIn(bashBlocks(notBash)).length === 0) {
    ok('a non-bash fence is correctly out of scope');
  } else {
    fail('a non-`bash` fence was scanned -- the parser is not respecting the fence tag.');
  }
}

console.log('\n§4 live: ONE parse unit -- the hazard under `fish -c` (skips where fish is absent)');
let fishUsable = false;
{
  const probe = spawnSync('fish', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('  SKIP  no usable `fish` on PATH -- the class is unobserved here, which is not a pass.');
  } else {
    fishUsable = true;
    const script = 'echo FIRST_RAN; echo "exit=$?"';
    const bare = spawnSync('fish', ['-c', script], { encoding: 'utf8' });
    const wrapped = spawnSync('fish', ['-c', `bash -c '${script}'`], { encoding: 'utf8' });

    // Assert on stdout ALONE. fish's diagnostic quotes the offending source
    // line back at you, so the string `exit=` appears in stderr even though no
    // `exit=` line was ever produced -- an assertion over both streams passes
    // for the wrong reason and was caught doing exactly that while this script
    // was being written.
    const answered = (out) => out.split('\n').some((l) => l.startsWith('exit='));

    // The whole `-c` string is ONE parse unit, so fish refuses it entire and
    // `echo FIRST_RAN` never runs either. Until KAN-602 this assertion was
    // written the other way round -- it REQUIRED `FIRST_RAN` on stdout -- and
    // was false on fish 3.7.0. See the correction in this file's header.
    if (!bare.stdout.includes('FIRST_RAN') && !answered(bare.stdout)) {
      ok('bare `$?`: one parse unit, so fish runs NOTHING -- not even the command before it');
    } else {
      fail(`bare \`$?\` under \`fish -c\` did not reproduce the measured behaviour: expected no stdout at all. stdout: ${JSON.stringify(bare.stdout)}`);
    }

    if (answered(wrapped.stdout)) {
      ok('`bash -c`-wrapped: fish yields the exit code, same as bash');
    } else {
      fail(`\`bash -c\` wrapper did not restore the exit code under fish. stdout: ${JSON.stringify(wrapped.stdout)}`);
    }
  }
}

console.log('\n\u00a75 live: FILE mode -- a `$?` anywhere discards the WHOLE file (skips where fish is absent)');
if (!fishUsable) {
  console.log('  SKIP  no usable `fish` on PATH -- the class is unobserved here, which is not a pass.');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan602-setup-portability-'));
  const NAMES = ['step1', 'step2', 'step4'];
  const at = (name) => path.join(dir, name);
  const ran = () => NAMES.filter((name) => fs.existsSync(at(name)));
  const clear = () => { for (const name of NAMES) fs.rmSync(at(name), { force: true }); };

  // Side effects rather than stdout: a marker file says a line RAN, where
  // absent stdout is also what a redirect or a quiet command would look like.
  // The probe sits on line 3, BELOW two steps, because the finding this section
  // exists for is that the steps ABOVE it do not run either.
  const fixture = (probeLine) => [
    `touch '${at('step1')}'`,
    `touch '${at('step2')}'`,
    probeLine,
    `touch '${at('step4')}'`,
    '',
  ].join('\n');

  // POSITIVE CONTROL FIRST. \u00a75's finding is that no marker exists, and an empty
  // directory is exactly what a broken fixture would also produce -- so prove
  // this fixture can create markers before reading their absence as evidence.
  clear();
  const controlPath = at('control.fish');
  fs.writeFileSync(controlPath, fixture('echo "exit=ok"'));
  const control = spawnSync('fish', [controlPath], { encoding: 'utf8' });
  const controlRan = ran();
  if (control.status === 0 && controlRan.length === NAMES.length) {
    ok(`positive control: the same fixture without a \`$?\` runs all ${NAMES.length} steps and exits 0`);
  } else {
    fail(`positive control did not run -- an absence measured below would prove nothing. exit=${control.status}, ran=${JSON.stringify(controlRan)}, stderr=${JSON.stringify(control.stderr)}`);
  }

  clear();
  const hazardPath = at('hazard.fish');
  fs.writeFileSync(hazardPath, fixture('echo "exit=$?"'));
  const hazard = spawnSync('fish', [hazardPath], { encoding: 'utf8' });
  const hazardRan = ran();

  if (hazardRan.length === 0) {
    ok('file mode: a `$?` on line 3 discards the whole file -- steps 1 and 2, ABOVE it, never ran');
  } else {
    fail(`file mode ran ${hazardRan.length} step(s) where none was expected: ${JSON.stringify(hazardRan)}`);
  }

  if (hazard.status !== 0) {
    ok(`file mode exits ${hazard.status} -- the reader is not told the file succeeded`);
  } else {
    fail('file mode exited 0 on a file fish refused to read -- the abort would be silent.');
  }

  // The wrapped form is what SETUP.md ships, and it must survive file mode.
  clear();
  const wrappedPath = at('wrapped.fish');
  fs.writeFileSync(wrappedPath, fixture(`bash -c 'echo "exit=$?"'`));
  const wrapped = spawnSync('fish', [wrappedPath], { encoding: 'utf8' });
  const wrappedRan = ran();
  if (wrapped.status === 0 && wrappedRan.length === NAMES.length) {
    ok('`bash -c`-wrapped: the same file runs end to end under fish, which is why the wrapper is load-bearing');
  } else {
    fail(`\`bash -c\` wrapper did not survive file mode. exit=${wrapped.status}, ran=${JSON.stringify(wrappedRan)}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
