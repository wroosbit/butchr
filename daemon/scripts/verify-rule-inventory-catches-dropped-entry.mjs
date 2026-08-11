// KAN-241: a dropped entry in the operative-rule sweep must not pass as green.
//
// WHAT FAILURE THIS WOULD CATCH: a merge conflict in the `RULES`/`RETIRED`
// arrays of `verify-operative-rules-are-carried.mjs` resolved by taking one
// side, so the other side's entries are lost — and every check in the
// repository staying green over it, because **the entries are the checking**.
// A dropped entry removes the assertion that would have noticed it was dropped,
// and the sweep then passes *harder*: one fewer assertion to satisfy.
//
// CI-RUNNABLE: quarantined — CI-runnable (5.6 s, git + node) but RED as of
// KAN-295. Its `--baseline` defaults to `origin/main` — "the version this PR
// changes", which stopped being true the moment KAN-241 merged — so the three
// `BEFORE is GREEN` legs now fail because the baseline already carries the
// fix. Every `AFTER CATCHES it` leg passes. A pinning defect of the kind this
// repository already knows about; rot, not regression. Owned by KAN-300.
//
// That is not a thought experiment. On 2026-08-08 `epic/KAN-39` resolved
// exactly this conflict, in exactly that region, between KAN-212's parent-epic
// entry and KAN-250's storm-guards entry — **both independently numbered
// `H-13`**. It kept both and renumbered one (`2a24912`). Taking either side
// would have dropped a live rule; `node --check` passes, the sweep passes, and
// the collision was found by a person grepping on a hunch rather than by
// anything mechanical.
//
// HOW THE PROOF IS STAGED — GREEN THEN CAUGHT, ON ONE TREE
//
// A throwaway git repository is built with the real `prompts/`, the real
// inventory, and **two copies of the sweep side by side**: AFTER, this PR's
// version, at the sweep's real path — it has to keep that path, because its
// baseline leg reads itself out of `origin/main` by it — and BEFORE, the
// version at the baseline ref without the inventory section, as `before.mjs`.
// A trunk branch adds entry `H-90`; a feature branch forked from the same base
// adds `H-91` at the same spot. Merging them conflicts — in both scripts and in
// the inventory, because all three edits land in the same region — and the
// merge is then resolved the careless way, `--ours`, which silently drops the
// trunk's `H-90` from whichever files were resolved that way.
//
// Both scripts are then run **against that one tree**, sharing its repo root
// and its `prompts/`. BEFORE exits 0. AFTER exits 1 and names H-90. That is the
// whole claim, and the two runs differ only in which sweep ran.
//
// FOUR SCENARIOS, BECAUSE THREE OF THEM TEST A DIFFERENT LEG:
//
//   1. Careless in the script, careful in the inventory — the declared-vs-present
//      leg fires. This is the common case: a conflict confined to `RULES` does
//      not touch the inventory file at all.
//   2. Careless in BOTH files — declared-vs-present is satisfied, because the
//      inventory lost the same entry. Only the **baseline leg** fires, and it is
//      here to show that the inventory alone would not have been enough.
//   3. Both sides claim the same id, resolved by keeping both — the
//      **unique-ids** leg fires. This is the 2026-08-08 shape, and it is the one
//      a bare entry *count* would miss: two entries named `H-13` count as two.
//   4. Resolved correctly, keeping both — everything green. Without this the
//      other three prove only that the sweep can be made to fail, which is not
//      the same as it being right.
//
// THIS SCRIPT CONSTRUCTS THE MERGE IT THEN ASSERTS ON, and that is the KAN-145
// shape, so here is what it leaves uncovered. It proves the sweep reacts
// correctly to a badly-resolved conflict **of the shape staged here**. It does
// not prove any future real conflict takes that shape, and it cannot: the input
// is synthesised, not observed.
//   WHO COVERS THAT: the observation at `2a24912`, which is a real conflict of
//   this shape resolved by hand and recorded on KAN-241 — evidence, not a check.
//   Nothing runs on every PR that would notice a differently-shaped one.
// Nor does it prove anyone keeps `rule-inventory.md` up to date. The sweep's own
// present-but-undeclared leg is what forces that, and this script exercises it
// only incidentally.
//
// Usage:
//   node daemon/scripts/verify-rule-inventory-catches-dropped-entry.mjs [--verbose]
//   node daemon/scripts/verify-rule-inventory-catches-dropped-entry.mjs --baseline <ref>
//
// `--baseline` names the ref the "before" sweep is read from; it defaults to
// `origin/main`, which is the version this PR changes.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const baselineIndex = process.argv.indexOf('--baseline');
const baselineRef = baselineIndex === -1 ? 'origin/main' : process.argv[baselineIndex + 1];

const SWEEP = 'daemon/scripts/verify-operative-rules-are-carried.mjs';
const INVENTORY = 'daemon/scripts/rule-inventory.md';
const PROMPTS = ['epic', 'story', 'task', 'confluence'].map((t) => `prompts/${t}.md`);

let failures = 0;

// ------------------------------------------------------------------ fixtures

/**
 * A synthetic rule entry. Its phrases are ones `prompts/task.md` genuinely
 * carries, so a surviving entry is satisfied and the sweep's verdict turns on
 * the inventory legs rather than on a rule that was never met.
 */
function ruleEntry(id, phrase) {
  return `  {
    id: '${id}',
    title: 'SYNTHETIC (KAN-241 proof) — ${id}',
    carriedBy: { 'prompts/task.md': [${phrase}] },
  },
`;
}

const H90 = ruleEntry('H-90', '/Secrets never enter a transcript/i');
const H91 = ruleEntry('H-91', '/Never print one/i');
// Scenario 3: the 2026-08-08 shape — two different rules, one number.
const H90_COLLIDING = ruleEntry('H-90', '/Never print one/i');

const invLine = (id) => `- \`${id}\` — KAN-241 — SYNTHETIC proof entry\n`;

/** Insert `text` immediately before the last `\n];` that closes the RULES array. */
function addRule(source, text) {
  const start = source.indexOf('const RULES = [');
  if (start === -1) throw new Error('RULES array not found in sweep source');
  const end = source.indexOf('\n];', start);
  if (end === -1) throw new Error('end of RULES array not found');
  return source.slice(0, end + 1) + text + source.slice(end + 1);
}

function addInventory(source, line) {
  const marker = '<!-- INVENTORY:END -->';
  const at = source.indexOf(marker);
  if (at === -1) throw new Error('INVENTORY:END marker not found');
  return source.slice(0, at) + line + source.slice(at);
}

// ------------------------------------------------------------ the scratch repo

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let beforeSweep;
try {
  beforeSweep = execFileSync('git', ['show', `${baselineRef}:${SWEEP}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  // Not a setup guard being dressed up as a verdict: the "before" half of
  // green-then-caught is the point of this script, and without the baseline
  // there is no before. Counted as a failure so the exit stays verdict-derived.
  failures += 1;
  console.log(`✗ could not read ${SWEEP} at ${baselineRef} — no "before" sweep to compare against.`);
  console.log('  Fetch the baseline (a shallow clone will not have it), or pass --baseline <ref>.');
  console.log(`\n✗ ${failures} check(s) failed.`);
  process.exit(1);
}

const afterSweep = fs.readFileSync(path.join(repoRoot, SWEEP), 'utf8');
const inventory = fs.readFileSync(path.join(repoRoot, INVENTORY), 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan241-'));

/**
 * Build a repo whose history is: base → (trunk adds one entry | feature adds
 * another at the same spot) → merge. Returns the paths and the merge result.
 *
 * `trunkRule` / `featureRule` are the RULES text each side adds; the inventory
 * line for each is derived from the id inside it.
 */
function stage(name, { trunkRule, featureRule, trunkId, featureId }) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'daemon', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const p of PROMPTS) fs.copyFileSync(path.join(repoRoot, p), path.join(dir, p));

  const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  // AFTER keeps the sweep's real path, because its baseline leg reads *itself*
  // out of `origin/main` by that path. BEFORE sits beside it under another
  // name: same repo root, same `prompts/`, so both read one tree.
  const AFTER = SWEEP;
  const BEFORE = 'daemon/scripts/before.mjs';

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'proof@example.invalid');
  git(dir, 'config', 'user.name', 'KAN-241 proof');

  // base — the real files, unmodified.
  write(AFTER, afterSweep);
  write(BEFORE, beforeSweep);
  write(INVENTORY, inventory);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  // trunk — `main`, and therefore what the baseline leg will read.
  write(AFTER, addRule(afterSweep, trunkRule));
  write(BEFORE, addRule(beforeSweep, trunkRule));
  write(INVENTORY, addInventory(inventory, invLine(trunkId)));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `trunk adds ${trunkId}`);

  // feature — forked from base, adding its own entry at the same spot.
  git(dir, 'checkout', '-q', '-b', 'feature', 'HEAD~1');
  write(AFTER, addRule(afterSweep, featureRule));
  write(BEFORE, addRule(beforeSweep, featureRule));
  write(INVENTORY, addInventory(inventory, invLine(featureId)));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `feature adds ${featureId}`);

  // An `origin` remote so the sweep's baseline leg resolves `origin/main`
  // exactly as it does in a real clone.
  git(dir, 'remote', 'add', 'origin', dir);
  git(dir, 'fetch', '-q', 'origin');

  const merge = spawnSync('git', ['merge', 'main'], { cwd: dir, encoding: 'utf8' });
  const conflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);

  /**
   * Take our side — the careless resolution, and the one the hazard is about.
   * `--ours` on `feature` keeps the feature entry and silently drops the
   * trunk's.
   */
  const takeOurs = (rel) => {
    git(dir, 'checkout', '--ours', '--', rel);
    git(dir, 'add', '--', rel);
  };

  /**
   * Keep both — the careful resolution, written out rather than reconstructed
   * from the conflict markers. Git's hunk boundaries fall mid-object here, so
   * stripping markers splices the two entries into one literal with two `id`
   * keys; that is a *third*, differently broken resolution, not the correct
   * one. What a careful human produces is the base with both entries added, so
   * that is what this writes.
   */
  const keepBoth = () => {
    write(AFTER, addRule(addRule(afterSweep, trunkRule), featureRule));
    write(BEFORE, addRule(addRule(beforeSweep, trunkRule), featureRule));
    write(INVENTORY, addInventory(addInventory(inventory, invLine(trunkId)), invLine(featureId)));
    git(dir, 'add', '-A');
  };

  return { dir, merge, conflicted, AFTER, BEFORE, takeOurs, keepBoth };
}

function run(dir, rel, args = []) {
  const r = spawnSync('node', [path.join(dir, rel), ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function expect(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail) console.log(detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

// ------------------------------------------------------- scenario 1 + before

console.log('KAN-241 — a dropped rule entry must not pass as green');
console.log('='.repeat(70));
console.log(`\nbaseline ("before") sweep read from: ${baselineRef}`);
console.log(`scratch repo: ${root}\n`);

console.log('Scenario 1 — careless in the script, careful in the inventory');
console.log('-'.repeat(70));
{
  const s = stage('s1', { trunkRule: H90, featureRule: H91, trunkId: 'H-90', featureId: 'H-91' });
  expect(
    `the merge really conflicts (${s.conflicted.length} paths)`,
    s.merge.status !== 0 && s.conflicted.length >= 3,
    `conflicted paths: ${JSON.stringify(s.conflicted)}\nA staged conflict that does not conflict proves nothing.`
  );
  // The careless half: take ours in both scripts, so the trunk's H-90 is lost.
  s.takeOurs(s.AFTER);
  s.takeOurs(s.BEFORE);
  // The careful half: the inventory still declares both.
  fs.writeFileSync(
    path.join(s.dir, INVENTORY),
    addInventory(addInventory(inventory, invLine('H-90')), invLine('H-91'))
  );

  const before = run(s.dir, s.BEFORE);
  const after = run(s.dir, s.AFTER);

  expect(
    'BEFORE (baseline sweep) is GREEN over the dropped entry — exit 0',
    before.status === 0,
    `exit ${before.status}\n${before.out.split('\n').slice(-12).join('\n')}`
  );
  expect(
    'AFTER (this PR) CATCHES it — exit 1, naming H-90 as dropped',
    after.status === 1 && /"H-90" is declared in .* and no longer exists in the sweep/.test(after.out),
    `exit ${after.status}\n${after.out.split('\n').slice(-20).join('\n')}`
  );
  if (verbose) {
    console.log('\n      --- AFTER, inventory section ---');
    console.log(
      after.out
        .split('Inventory integrity')[1]
        ?.split('\n')
        .slice(0, 14)
        .map((l) => `      ${l}`)
        .join('\n')
    );
    console.log('');
  }
}

// -------------------------------------------------------------- scenario 2

console.log('\nScenario 2 — careless in BOTH files; only the baseline leg can see it');
console.log('-'.repeat(70));
{
  const s = stage('s2', { trunkRule: H90, featureRule: H91, trunkId: 'H-90', featureId: 'H-91' });
  s.takeOurs(s.AFTER);
  s.takeOurs(s.BEFORE);
  s.takeOurs(INVENTORY); // the inventory loses H-90 too

  const before = run(s.dir, s.BEFORE);
  const after = run(s.dir, s.AFTER);

  expect('BEFORE is GREEN — exit 0', before.status === 0, `exit ${before.status}`);
  expect(
    'declared-vs-present is satisfied — the inventory lost the same entry',
    !/"H-90" is declared in/.test(after.out),
    'The inventory leg fired, which would mean this scenario is not testing what it claims.'
  );
  expect(
    'AFTER CATCHES it on the baseline leg — exit 1, H-90 gone from origin/main',
    after.status === 1 && /"H-90" is in the sweep at origin\/main and is gone/.test(after.out),
    `exit ${after.status}\n${after.out.split('\n').slice(-20).join('\n')}`
  );
  if (verbose) {
    console.log(
      `\n${after.out
        .split('\n')
        .filter((l) => /H-90|baseline|ids present/.test(l))
        .map((l) => `      ${l}`)
        .join('\n')}\n`
    );
  }
}

// -------------------------------------------------------------- scenario 3

console.log('\nScenario 3 — both sides claim the same id, resolved by keeping both');
console.log('-'.repeat(70));
{
  const s = stage('s3', { trunkRule: H90, featureRule: H90_COLLIDING, trunkId: 'H-90', featureId: 'H-90' });
  s.keepBoth();

  const before = run(s.dir, s.BEFORE);
  const after = run(s.dir, s.AFTER);

  expect(
    'BEFORE is GREEN over the duplicate id — exit 0',
    before.status === 0,
    `exit ${before.status}\n${before.out.split('\n').slice(-12).join('\n')}`
  );
  expect(
    'AFTER CATCHES the collision — exit 1, two entries claiming H-90',
    after.status === 1 && /two entries in .* both claim id "H-90"/.test(after.out),
    `exit ${after.status}\n${after.out.split('\n').slice(-20).join('\n')}`
  );
  if (verbose) {
    console.log(
      `\n${after.out
        .split('\n')
        .filter((l) => /claim id|2a24912|Renumber/.test(l))
        .map((l) => `      ${l}`)
        .join('\n')}\n`
    );
  }
}

// -------------------------------------------------------------- scenario 4

console.log('\nScenario 4 — resolved correctly, keeping both entries: nothing fires');
console.log('-'.repeat(70));
{
  const s = stage('s4', { trunkRule: H90, featureRule: H91, trunkId: 'H-90', featureId: 'H-91' });
  s.keepBoth();

  const before = run(s.dir, s.BEFORE);
  const after = run(s.dir, s.AFTER);

  expect('BEFORE is GREEN — exit 0', before.status === 0, `exit ${before.status}`);
  expect(
    'AFTER is GREEN on a good resolution — exit 0, no false positive',
    after.status === 0,
    `exit ${after.status}\n${after.out.split('\n').slice(-24).join('\n')}`
  );
}

// ----------------------------------------------------------------- verdict

console.log('');
if (failures) {
  console.log(`✗ ${failures} check(s) failed — a dropped, duplicated or vanished rule entry is`);
  console.log('  not being caught, or a correctly resolved merge is being flagged as one.');
  console.log(`  Scratch repos left at ${root} for inspection.`);
} else {
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ the baseline sweep is green over a dropped entry, a both-files drop and a');
  console.log('  duplicate id; this PR\'s sweep catches all three on the same tree and stays');
  console.log('  green when the same conflict is resolved correctly.');
}

process.exit(failures ? 1 : 0);
