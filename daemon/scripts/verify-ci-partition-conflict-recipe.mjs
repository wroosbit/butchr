// KAN-590: the way out of a `ci-partition.md` merge conflict is written in the
// document itself, and these are the lines that get run rather than a paragraph
// describing them.
//
// WHAT FAILURE THIS WOULD CATCH: the resolution procedure going stale where it
// is written down, which is the state KAN-590 was filed about. `ci-partition.md`
// is generated AND tracked, so any two pull requests that each add a `verify-*`
// script conflict in it and usually nowhere else — three times on 2026-08-21,
// and in one of those the only conflicted file was this one while the code under
// review auto-merged clean. Each of those three agents worked the answer out
// independently, from commit messages, and by the third telling the recipe had
// picked up two steps that do nothing: a `git checkout origin/main --` on the
// file, and a `cd daemon && npm run build` justified as "the generator reads the
// built set". It does not. Prose cannot notice that about itself; this script
// runs what the document says, against a conflict it builds for real, so a
// recipe that stops working goes red instead of going quietly wrong.
//
// CI-RUNNABLE: yes — builds a repository-shaped fixture under `os.tmpdir()` from
// the files of this checkout, drives `git` on it, and spawns the generator and
// the enforcement guard as node children; node builtins and the `git` binary
// only, no build, no `npm install`, no daemon, no herdr, no credential, no
// network, no wall clock.
//
// ---------------------------------------------------------------------------
// THE COUPLING THAT MAKES THIS WORTH HAVING
// ---------------------------------------------------------------------------
//
// The commands are not written here. They are EXTRACTED from the generated
// document, out of the fenced block under its own conflict heading, and run
// verbatim. So the document is the only copy: editing the recipe there changes
// what this script executes, and there is no second place for the two to drift
// apart. A test that restated the commands would be a second source of truth
// wearing a guard's clothes — the very shape `ci-partition.md` itself is
// forbidden from being, four lines into its own header.
//
// ---------------------------------------------------------------------------
// WHAT IT SUPPLIES ITSELF, AND WHO COVERS THE REST — KAN-145
// ---------------------------------------------------------------------------
//
// This script BUILDS the conflict it then resolves. That is the honest half to
// state plainly: it does not observe a real pull request, so it cannot be
// evidence that real pull requests conflict here. What it establishes is
// narrower and is the part that rots — that the written procedure, run as
// written, turns a genuine two-branch conflict in this file into a tree the
// enforcement guard passes.
//
// Not covered by this script, named rather than left to be inferred:
//
//   * THAT THE CONFLICT HAPPENS IN THE FIELD. Evidence for that is KAN-590's
//     three measured collisions (#258, #263, #265) and nothing here. §2 is the
//     nearest thing — it refuses to continue unless git really did conflict on
//     the fixture — so this script cannot pass vacuously, but that is a fact
//     about the fixture and not about the board. Covered by: nobody, and it
//     needs nobody; the recurrence is what the ticket recorded.
//   * WHETHER GITHUB RESOLVES IT THE SAME WAY. `gh pr update-branch` merges on
//     GitHub's servers, and nothing here reaches them. It matters less than it
//     looks: GitHub refuses to update a branch it cannot merge cleanly, so the
//     conflict comes back to a local `git merge`, which is what this measures.
//     Covered by: nobody.
//   * A CONFLICT IN A SCRIPT HEADER RATHER THAN IN THIS FILE. If the merge left
//     conflict markers inside a `verify-*.mjs` header, regenerating would render
//     that damage into the document instead of removing it. Out of scope here,
//     and the recipe does not claim to cover it — §5's byte-identity check would
//     still pass, because the generator and the document would agree about a
//     tree that is itself broken. Covered by: nobody.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { REPO_ROOT } from './lib/ci-partition.mjs';

const verbose = process.argv.includes('--verbose');
let failures = 0;

function check(ok, what, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  } else if (verbose && detail) {
    console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}

function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/** The heading the recipe lives under, in the generated document. */
const CONFLICT_HEADING = '## If you got here from a merge conflict';
const MD_REL = 'daemon/scripts/ci-partition.md';

// =============================================================================
rule('1. THE DOCUMENT CARRIES A RUNNABLE RECIPE — under a heading, in a fence');
// =============================================================================
//
// Read off the checkout, not off a regenerated copy. What a reader meets when
// they open the conflicted file is the committed bytes, so those are the bytes
// whose recipe has to work.

const mdPath = path.join(REPO_ROOT, MD_REL);
const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
check(md.length > 0, `${MD_REL} exists and is not empty`, mdPath);

/**
 * Pull the fenced `bash` block out of the section under `CONFLICT_HEADING`.
 *
 * Bounded at the next `## ` heading on purpose: an unbounded search would
 * happily find the fence belonging to a later section and report a recipe this
 * section does not contain.
 */
function extractRecipe(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.trim() === CONFLICT_HEADING);
  if (start === -1) return { ok: false, why: `no line reading exactly \`${CONFLICT_HEADING}\`` };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);
  const open = section.findIndex((l) => l.trim() === '```bash');
  if (open === -1) return { ok: false, why: 'the section has no ```bash fence' };
  const close = section.findIndex((l, i) => i > open && l.trim() === '```');
  if (close === -1) return { ok: false, why: 'the ```bash fence is never closed' };

  const commands = section.slice(open + 1, close).filter((l) => l.trim().length > 0);
  if (commands.length === 0) return { ok: false, why: 'the fence is empty' };
  return { ok: true, commands };
}

const recipe = extractRecipe(md);
check(
  recipe.ok,
  `the section \`${CONFLICT_HEADING}\` holds a non-empty bash fence`,
  recipe.ok ? `${recipe.commands.length} command(s):\n${recipe.commands.join('\n')}` : recipe.why
);

// The document is a view of the generator, so a missing section is a generator
// edit that was never made. Everything below runs the extracted commands; with
// nothing to run there is nothing to say, and saying it as a pass would be the
// vacuous green this file exists to refuse.
if (!recipe.ok) {
  console.log(
    '\n  Nothing below can run without a recipe to run. The section is emitted by\n' +
      '  `emitMarkdown()` in daemon/scripts/run-ci-verify-set.mjs — restore it there\n' +
      '  and regenerate; do not add it to ci-partition.md by hand.'
  );
  console.log(`\n== ${failures} CHECK(S) FAILED ==`);
  process.exit(failures ? 1 : 0);
}

// =============================================================================
rule('2. THE FIXTURE REALLY CONFLICTS — the reproduction, before the remedy');
// =============================================================================
//
// Two branches off one base, each adding one `verify-*` script and regenerating
// the document, exactly as two pull requests do. The names are adjacent on
// purpose: rows are emitted in sorted order, so adjacent names put both new rows
// at the same position in the table and git has no way to take both. Names that
// sorted far apart would auto-merge cleanly — which is KAN-409's case, a
// different defect with its own guard, and not what this file is about.
//
// This section is the reason the rest is not vacuous. If a future git resolves
// this merge by itself, every check below would pass while testing nothing, so
// the absence of a conflict is reported here as a FAILURE — "the reproduction
// has stopped reproducing" — rather than being quietly welcomed.

const FIXTURE_NAMES = ['verify-zzz-kan590-conflict-a', 'verify-zzz-kan590-conflict-b'];

/**
 * A header-only fixture script. No body, for the reason
 * `verify-ci-partition-is-enforced.mjs` gives about its own fixtures: a written
 * out `process.exit` in this file would be counted by
 * `sweep-verify-exit-paths.mjs` against this script's own exit paths.
 */
const fixtureSource = (name) =>
  `// ${name}: a KAN-590 fixture. Never runs; it exists to be classified.\n` +
  `//\n` +
  `// WHAT FAILURE THIS WOULD CATCH: nothing. It is a fixture.\n` +
  `//\n` +
  `// CI-RUNNABLE: no — a fixture, written into a temporary tree by\n` +
  `// verify-ci-partition-conflict-recipe.mjs and never executed.\n`;

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kan590-conflict-'));
const repo = path.join(fixtureRoot, 'repo');

function git(...args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Copy this checkout into the fixture: tracked files PLUS untracked ones git is
 * not ignoring.
 *
 * `--others --exclude-standard` is what makes this test the working tree rather
 * than HEAD. An author running it has usually not committed yet — a fixture
 * built from `git ls-files` alone, or from a clone, would silently exercise the
 * previous commit's generator and report a green about code that is not the code
 * in front of them. `node_modules` and `dist` are excluded by `.gitignore`, so
 * they cost nothing here.
 */
function copyCheckoutInto(dest) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (listed.status !== 0) return { ok: false, why: `git ls-files failed: ${listed.stderr}` };
  const rels = listed.stdout.split('\0').filter((r) => r.length > 0);
  let copied = 0;
  for (const rel of rels) {
    const from = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
    copied++;
  }
  return { ok: true, copied, listed: rels.length };
}

fs.mkdirSync(repo, { recursive: true });
const copy = copyCheckoutInto(repo);
check(copy.ok, 'this checkout copied into the fixture', copy.ok ? `${copy.copied} file(s)` : copy.why);

/** Run the generator inside the fixture, writing its document. */
function regenerateInFixture() {
  const gen = spawnSync(process.execPath, ['daemon/scripts/run-ci-verify-set.mjs', '--markdown'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (gen.status === 0) fs.writeFileSync(path.join(repo, MD_REL), gen.stdout);
  return gen;
}

let setupNote = null;
if (copy.ok) {
  const init = git('init', '-q');
  git('config', 'user.email', 'kan590@example.invalid');
  git('config', 'user.name', 'KAN-590 fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  const baseCommit = git('commit', '-qm', 'base');
  if (init.status !== 0 || baseCommit.status !== 0) {
    setupNote = `git init/commit failed:\n${init.stderr}${baseCommit.stderr}${baseCommit.stdout}`;
  }
}
check(setupNote === null, 'the fixture is a git repository with a base commit', setupNote);

const base = git('rev-parse', 'HEAD').stdout.trim();

/** One branch: add a script, regenerate the document, commit both. */
function makeBranch(branch, scriptName) {
  git('checkout', '-q', '-B', branch, base);
  fs.writeFileSync(path.join(repo, 'daemon', 'scripts', `${scriptName}.mjs`), fixtureSource(scriptName));
  const gen = regenerateInFixture();
  git('add', '-A');
  const c = git('commit', '-qm', branch);
  return { genOk: gen.status === 0, genErr: gen.stderr, commitOk: c.status === 0 };
}

const branchA = makeBranch('kan590-a', FIXTURE_NAMES[0]);
const branchB = makeBranch('kan590-b', FIXTURE_NAMES[1]);
check(
  branchA.genOk && branchA.commitOk && branchB.genOk && branchB.commitOk,
  'two branches, each adding one verify- script and regenerating the document',
  `A: generator ${branchA.genOk}, commit ${branchA.commitOk}\n` +
    `B: generator ${branchB.genOk}, commit ${branchB.commitOk}\n${branchA.genErr}${branchB.genErr}`
);

git('checkout', '-q', 'kan590-a');
const merge = git('merge', '--no-edit', 'kan590-b');
const conflicted = git('diff', '--name-only', '--diff-filter=U')
  .stdout.split('\n')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

check(
  conflicted.includes(MD_REL),
  `merging the two branches conflicts in ${MD_REL} — the reproduction still reproduces`,
  `merge exit ${merge.status}; conflicted paths: ${conflicted.length > 0 ? conflicted.join(', ') : '(none)'}\n` +
    'If this says (none), git resolved it by itself and every check below would\n' +
    'have passed without testing anything. That is why it is reported as a failure.'
);

// The other half of the reproduction, and the sentence the recipe leans on: the
// two new SCRIPTS auto-merge. That is what makes "regenerate" the right answer
// rather than a way of losing somebody's work — the generator reads a tree that
// already holds both sides.
const bothScriptsPresent = FIXTURE_NAMES.every((n) =>
  fs.existsSync(path.join(repo, 'daemon', 'scripts', `${n}.mjs`))
);
check(
  bothScriptsPresent,
  'and both new scripts auto-merged into the tree — only the generated file collided',
  FIXTURE_NAMES.map(
    (n) => `${n}.mjs: ${fs.existsSync(path.join(repo, 'daemon', 'scripts', `${n}.mjs`)) ? 'present' : 'MISSING'}`
  ).join('\n')
);

// =============================================================================
rule('3. THE CONFLICTED TREE IS GENUINELY BROKEN — the red, before the green');
// =============================================================================
//
// Run the enforcement guard on the conflicted tree and require it to FAIL. This
// is the red arm, and it is what stops §4 and §5 from being a green that was
// available all along: if the guard passed here, then it would pass after the
// recipe too, and the recipe would have been shown to do nothing.

function enforcementInFixture() {
  return spawnSync(process.execPath, ['daemon/scripts/verify-ci-partition-is-enforced.mjs'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

const before = enforcementInFixture();
check(
  before.status !== 0,
  'verify-ci-partition-is-enforced.mjs is RED on the conflicted tree',
  `exit ${before.status}\n` +
    'A pass here would mean the conflicted document is acceptable to the guard,\n' +
    'and the recipe below would be demonstrating nothing.'
);

const conflictedText = fs.readFileSync(path.join(repo, MD_REL), 'utf8');
check(
  /^<{7} /m.test(conflictedText) && /^>{7} /m.test(conflictedText),
  'and the document on disk carries conflict markers',
  `<<<<<<< lines: ${(conflictedText.match(/^<{7} /gm) || []).length}, ` +
    `>>>>>>> lines: ${(conflictedText.match(/^>{7} /gm) || []).length}`
);

// =============================================================================
rule('4. THE DOCUMENTED RECIPE RUNS — every line of it, exactly as written');
// =============================================================================
//
// `sh -c` per line, because the recipe redirects and a redirect needs a shell.
// Each line is required to exit 0 on its own: the recipe's last line is the
// enforcement guard, so a green there is the recipe reporting its own success in
// the same words the document tells a reader to expect.

const ran = [];
for (const command of recipe.commands) {
  const r = spawnSync('sh', ['-c', command], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  ran.push({ command, status: r.status, stderr: r.stderr, stdout: r.stdout });
}

for (const r of ran) {
  check(
    r.status === 0,
    `\`${r.command}\` exited 0`,
    `exit ${r.status}\n${(r.stderr || r.stdout || '').trimEnd().split('\n').slice(-12).join('\n')}`
  );
}

// =============================================================================
rule('5. AND THE TREE IT LEAVES IS THE ONE THE DOCUMENT PROMISES');
// =============================================================================
//
// Three claims, because "the guard went green" is the weakest of them and would
// be satisfied by a recipe that deleted the file's contents and regenerated a
// document describing a tree with neither new script in it.

const after = fs.readFileSync(path.join(repo, MD_REL), 'utf8');

check(
  !/^<{7} /m.test(after) && !/^>{7} /m.test(after) && !/^={7}$/m.test(after),
  'no conflict markers survive in the document',
  `<<<<<<<: ${(after.match(/^<{7} /gm) || []).length}, ` +
    `=======: ${(after.match(/^={7}$/gm) || []).length}, ` +
    `>>>>>>>: ${(after.match(/^>{7} /gm) || []).length}`
);

const missingRows = FIXTURE_NAMES.filter((n) => !after.includes(n));
check(
  missingRows.length === 0,
  'BOTH new scripts have a row — neither side was dropped by the resolution',
  missingRows.length === 0
    ? FIXTURE_NAMES.map((n) => `${n}: row present`).join('\n')
    : `no row for: ${missingRows.join(', ')}\n` +
      'A resolution that keeps one side and drops the other is what a `merge=ours`\n' +
      'driver does, and it is why the document tells you to regenerate instead.'
);

const finalGen = spawnSync(process.execPath, ['daemon/scripts/run-ci-verify-set.mjs', '--markdown'], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
check(
  finalGen.status === 0 && finalGen.stdout === after,
  'and the resolved document is byte-identical to what the generator emits',
  finalGen.status !== 0
    ? `the generator exited ${finalGen.status}\n${finalGen.stderr}`
    : `generator ${finalGen.stdout.length} bytes, resolved file ${after.length} bytes`
);

const noConflictLeft = git('diff', '--name-only', '--diff-filter=U')
  .stdout.split('\n')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
check(
  noConflictLeft.length === 0,
  'and git considers the merge resolved — nothing is left unmerged',
  noConflictLeft.length === 0 ? 'no unmerged paths' : `still unmerged: ${noConflictLeft.join(', ')}`
);

// -----------------------------------------------------------------------------

fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(
  '\n  WHAT THIS SECTION DOES NOT ESTABLISH: that the conflict happens in the\n' +
    '  field. The fixture is built here, so §2 shows the reproduction is real and\n' +
    '  says nothing about the board — the three KAN-590 collisions of 2026-08-21\n' +
    '  are that evidence, and this script is not a substitute for them. It also does\n' +
    '  not reach GitHub, which merges on its own servers during update-branch. The\n' +
    '  header names both, and names who covers them: nobody.'
);

console.log('');
if (failures) {
  console.log(`== ${failures} CHECK(S) FAILED ==`);
  console.log(
    'The way out of a ci-partition.md conflict is not what the document says it\n' +
      'is. Fix the recipe where it is emitted — `emitMarkdown()` in\n' +
      'daemon/scripts/run-ci-verify-set.mjs — and regenerate. Do not edit\n' +
      'ci-partition.md by hand to make this pass; that is the very thing the\n' +
      'recipe exists to talk you out of.'
  );
} else {
  console.log(
    `== ALL PASS — the ${recipe.commands.length}-line recipe in ${MD_REL} resolves a real conflict ==\n\n` +
      'Extracted from the document and run verbatim, against a two-branch conflict\n' +
      'built for the purpose, with the enforcement guard red before it and green\n' +
      'after.'
  );
}

process.exit(failures ? 1 : 0);
