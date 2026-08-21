// KAN-568: a command in `docs/SETUP.md` cannot depend on the reader's login
// shell being bash without saying so, where the failure is silent.
//
// WHAT FAILURE THIS WOULD CATCH: step 1's keyring probe, written for six months
// as `secret-tool lookup service butchr account jira; echo "exit=$?"`. That line
// is a hard parse error under `fish` — and `fish` is the login shell on the
// second machine KAN-568 was rehearsed against. The expensive part is not the
// error: fish runs the command BEFORE the `$?` and only then refuses, so the
// reader sees the lookup's output, sees no `exit=` line, and has been handed a
// step whose entire content is the exit code with the exit code missing.
// Measured on both shells at the time of writing: bare, bash prints `exit=127`
// and fish prints no `exit=` line at all; wrapped in `bash -c '...'`, both print
// `exit=127`.
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
// `fish` to show that it executes the preceding command and then withholds the
// exit code; a runner without `fish` on PATH announces that section SKIPPED, and
// a skip is printed as a skip and never counted as a pass. It is not mocked: the
// whole value of §4 is that the parse error is fish's own.
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
// §4 below runs the hazard against a real `fish` when one is present. That is
// the only section that observes the world rather than the text; where `fish` is
// absent it SKIPS, and a skip is not a pass. Nobody covers the fish behaviour on
// a runner without fish installed, and this header is the edge of what is
// claimed.

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

console.log('\n§4 live: the hazard against a real fish (skips where fish is absent)');
{
  const probe = spawnSync('fish', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('  SKIP  no usable `fish` on PATH -- the class is unobserved here, which is not a pass.');
  } else {
    const script = 'echo FIRST_RAN; echo "exit=$?"';
    const bare = spawnSync('fish', ['-c', script], { encoding: 'utf8' });
    const wrapped = spawnSync('fish', ['-c', `bash -c '${script}'`], { encoding: 'utf8' });

    // Assert on stdout ALONE. fish's diagnostic quotes the offending source
    // line back at you, so the string `exit=` appears in stderr even though no
    // `exit=` line was ever produced -- an assertion over both streams passes
    // for the wrong reason and was caught doing exactly that while this script
    // was being written.
    const answered = (out) => out.split('\n').some((l) => l.startsWith('exit='));

    if (bare.stdout.includes('FIRST_RAN') && !answered(bare.stdout)) {
      ok('bare `$?`: fish runs the first command and withholds the exit code -- the silent half is real');
    } else {
      fail(`bare \`$?\` under fish did not reproduce the documented behaviour. stdout: ${JSON.stringify(bare.stdout)}`);
    }

    if (answered(wrapped.stdout)) {
      ok('`bash -c`-wrapped: fish yields the exit code, same as bash');
    } else {
      fail(`\`bash -c\` wrapper did not restore the exit code under fish. stdout: ${JSON.stringify(wrapped.stdout)}`);
    }
  }
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
