// Proof for KAN-545: the `bytes` a reclaim sweep reports is the number of bytes
// the filesystem actually gave back, not the sum of the apparent sizes of the
// names it unlinked.
//
// WHAT FAILURE THIS WOULD CATCH: `butchr_reclaim_workspaces` reporting
// `bytes: 10399428608` ("10.4 GB") for a real sweep on 2026-08-20 that moved
// `df` by 1.14 GiB — an 8-9x over-report of the one number an operator low on
// disk acts on. The mechanism is `measure()` in `daemon/src/reclaim.ts` adding
// `st.blocks * 512` once per NAME. Since KAN-262 a workspace's `node_modules` is
// hard-linked from a shared store, so one inode carries many names: measured on
// this machine on 2026-08-20, `mime-db/db.json` had `nlink=6` — one name in the
// store and five in live workspaces, all one inode, 400 blocks. Summed per name
// that tree reports at full size five times over; unlinked, it frees nothing at
// all, because the store's name survives.
//
// CI-RUNNABLE: yes — imports the built daemon module and builds its own filesystem fixture on tmpfs; no live daemon, no herdr, no credential, no peer, no terminal, no network.
//
// ---------------------------------------------------------------------------
// THE TICKET SAYS HARDLINKING IS RULED OUT. IT IS NOT, AND BOTH MEASUREMENTS
// WERE CORRECT — THEY SAMPLED DIFFERENT POPULATIONS.
// ---------------------------------------------------------------------------
// KAN-545's reporter sampled one file across six DIFFERENT surviving
// workspaces, got six distinct inodes with `links=1` each, and concluded
// hardlinking was not the cause. That test was sound and its reading was true.
// It landed on the private-copy half of a mixed fleet: measured on this machine
// on 2026-08-20, 14 of 38 surviving workspace `node_modules` contained at least
// one multiply-linked file and the other 24 did not, because a workspace gets a
// linked tree only if `link-workspace-deps.mjs` built it and a private one if
// anything ran `npm install`. Sampling six and drawing six private trees is an
// ordinary outcome, not bad luck. On the store side of the same fleet the same
// day: 2366 of 3000 sampled files carried `nlink=8`.
//
// The reporter's OWN `du` figures are the independent corroboration, and they
// were on the ticket the whole time: `du -c` deduplicates by inode, so its
// 4.17 GiB across ALL 99 directories cannot be reconciled with the tool's
// 9.69 GiB across only 72 of them unless inodes are heavily shared. A per-name
// sum over a subset exceeding an inode-deduplicated sum over its superset is
// the signature of exactly this defect.
//
// Recorded here rather than only on the ticket, because "hardlinking is ruled
// out" and "hardlinking is the mechanism" cannot both stand unexplained in
// front of the next reader.
//
// ---------------------------------------------------------------------------
// WHY tmpfs, AND WHY THE df ARM IS NOT THE ONLY ARM
// ---------------------------------------------------------------------------
// The acceptance criterion asks for a real before/after `df` delta. `df` is only
// an instrument if the filesystem under it is quiet: this machine's `/` is a
// shared ext4 at 98% with the whole fleet writing to it, and ext4's delayed
// allocation means a write need not be visible to `statfs` when the write call
// returns. So the fixture is built on tmpfs (`/dev/shm`), which is a real
// filesystem with real `statfs` accounting, real hard links and no delayed
// allocation, and which nothing else on this box is churning.
//
// The `du` arm is a SECOND instrument and not a second reading of the first.
// `du` walks the tree and adds `st.blocks`, deduplicating by inode as it goes;
// `df` asks the allocator how many blocks are free and never looks at a file.
// They share no step, which is what lets one corroborate the other -- if they
// agreed because of a common upstream cause they would be one reading, and the
// point of running both would be gone.
//
// ---------------------------------------------------------------------------
// THE FIXTURE, AND WHY IT DISCRIMINATES IN BOTH DIRECTIONS
// ---------------------------------------------------------------------------
// A fix that simply reported less would be no better than the defect. Five
// workspaces, and the correct answer is different for each kind:
//
//   linked-a, linked-b  hard-linked from a store OUTSIDE the workspaces root.
//                       Removing them frees NOTHING - the store's name survives.
//                       A sweep that counts them is today's defect.
//   private             its own copy, nothing else references it.
//                       Removing it frees EVERY byte. A sweep that fails to
//                       count it has "fixed" the number by under-reporting,
//                       which this arm refuses.
//   pair-x, pair-y      hard-linked to EACH OTHER and to nothing else, and both
//                       are swept. Removing both frees the blocks ONCE.
//                       This is the arm that kills the tempting wrong fix
//                       "skip anything with nlink > 1": that would report zero
//                       here, and the bytes really are recovered.
//
// So the expected figure is `private + pair (once)`, and three different wrong
// answers -- count every name, count no shared name, count each inode once
// regardless of who else holds it -- each miss it in a different direction.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// It supplies its own fixture: it lays out the workspaces, links them from a
// store it also builds, and hands `sweepWorkspaces` its own `root`. Per KAN-145,
// a proof that constructs its own input has NOT shown that the real input
// arrives. What is uncovered here, named rather than left to be inferred:
//
//   * That a REAL sweep meets hard-linked trees at all is not shown by this
//     script - it is shown by `link-workspace-deps.mjs` being what creates
//     every new workspace's `node_modules`, and by the `nlink=6` measurement
//     quoted above, which is an observation of the running system and is pasted
//     into the PR body rather than asserted here.
//   * That the router's `reclaim_sweep` action carries these fields out to a
//     caller is covered by section 4 of `verify-workspace-reclaim.mjs`, which
//     drives the real action; this script asserts on the module directly.
//   * `df` granularity on filesystems other than tmpfs is not characterised.
//     Section 1 asserts against tmpfs `statfs` and would need re-tuning, not
//     re-thinking, on a filesystem with a coarser allocator.
//
// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------
//   1. df       - real before/after `statfs` delta across a real deletion,
//                 against the reported `bytes`
//   2. du       - the same sweep against an independent inode-deduplicating
//                 walk, and against the arithmetic the fixture was built to
//   3. parts    - the per-directory `bytes` sum to the headline, and each one
//                 is the freed figure for its own directory
//   4. apparent - the old per-name number is still reported, under a name that
//                 says what it is, so nothing that needs it has lost it
//   5. can it fail - the assertions of sections 1-3 re-run against a build
//                 patched back to today's per-name counting, which must go red

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(HERE, '..');
const DIST = path.join(DAEMON, 'dist');

let failures = 0;

/**
 * Everything to remove on the way out.
 *
 * The patched build lives INSIDE `daemon/` (see section 5 for why), so leaking
 * one would leave an untracked directory in the checkout that the next reader
 * has to work out the provenance of. Registered here so that an assertion
 * throwing does not leave it behind.
 */
const litter = [];
process.on('exit', () => {
  for (const target of litter) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort on the way out; nothing here is worth failing the run over.
    }
  }
});

const pass = (section, message) => console.log(`  ok   [${section}] ${message}`);
const fail = (section, message) => {
  failures += 1;
  console.log(`  FAIL [${section}] ${message}`);
};

/** A setup guard, deliberately not a verdict: nothing has been measured yet. */
if (!fs.existsSync(path.join(DIST, 'reclaim.js'))) {
  console.error('daemon/dist is missing - run `npm run build` in daemon/ first');
  process.exit(2);
}

const TMPFS = '/dev/shm';
if (!fs.existsSync(TMPFS)) {
  console.error(`${TMPFS} is not present, and this proof needs a quiet filesystem to read df on`);
  process.exit(2);
}

const MIB = 1024 * 1024;
/**
 * Per tree. Large enough that a stray page cannot explain the delta, small
 * enough to fit a containerised runner's 64 MB `/dev/shm`.
 *
 * Only three of the five trees cost real blocks — the two store-linked ones are
 * names over blocks the store already holds — so the fixture is ~3x this.
 * Nothing but this process writes to tmpfs, so the noise floor is near zero and
 * the 3% tolerance below is slack rather than a fudge.
 */
const TREE_MIB = 8;

// A setup guard, deliberately not a verdict. A fixture that does not fit is a
// proof that did not run, and it must say so rather than measure a truncated
// tree and report a verdict about it.
const NEEDED = TREE_MIB * MIB * 6;
const availableOnTmpfs = (() => {
  const st = fs.statfsSync(TMPFS);
  return st.bavail * st.bsize;
})();
if (availableOnTmpfs < NEEDED) {
  console.error(
    `${TMPFS} has ${(availableOnTmpfs / MIB).toFixed(1)} MiB free and this proof needs ` +
      `${(NEEDED / MIB).toFixed(1)} MiB to build a fixture it can read df on`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * A `node_modules` with real bytes in it.
 *
 * Written with distinct content per tree so that nothing can be quietly shared
 * by the filesystem behind our back, and in several files so that the walk has
 * something to walk.
 */
function writePrivateTree(target, seed) {
  fs.mkdirSync(path.join(target, 'pkg', 'lib'), { recursive: true });
  for (let i = 0; i < TREE_MIB; i += 1) {
    const buf = Buffer.alloc(MIB, (seed + i) % 251);
    fs.writeFileSync(path.join(target, 'pkg', 'lib', `chunk-${i}.bin`), buf);
  }
  fs.writeFileSync(path.join(target, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }));
}

/** Hard-link every file of `source` into `target`, as `link-workspace-deps.mjs` does. */
function hardLinkTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) hardLinkTree(from, to);
    else fs.linkSync(from, to);
  }
}

/** Free bytes on the filesystem holding `target`, straight from `statfs`. */
function freeBytes(target) {
  const st = fs.statfsSync(target);
  return st.bavail * st.bsize;
}

/**
 * Allocated bytes beneath `dir`, counting each inode ONCE across the whole call
 * - which is what `du -xsc` does, and the reason it is the honest comparison.
 */
function duBytes(dirs) {
  const seen = new Set();
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      const key = `${st.dev}:${st.ino}`;
      if (!seen.has(key)) {
        seen.add(key);
        bytes += st.blocks * 512;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  for (const dir of dirs) {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    const key = `${st.dev}:${st.ino}`;
    if (!seen.has(key)) {
      seen.add(key);
      bytes += st.blocks * 512;
    }
    walk(dir);
  }
  return bytes;
}

/**
 * Build the five-workspace fixture described in the header.
 *
 * Returns the workspaces root, the candidate paths, and the arithmetic the
 * fixture was built to - computed from the disk rather than from `TREE_MIB`, so
 * that a filesystem allocating differently than expected changes the
 * expectation rather than breaking the proof.
 */
function buildFixture() {
  const scratch = fs.mkdtempSync(path.join(TMPFS, 'kan545-'));
  litter.push(scratch);
  const store = path.join(scratch, 'dep-store');
  const root = path.join(scratch, 'workspaces');

  const ws = (key) => path.join(root, 'task', key, 'repo');
  const nm = (key) => path.join(ws(key), 'node_modules');

  // The store sits OUTSIDE the workspaces root, exactly as the real one does.
  fs.mkdirSync(store, { recursive: true });
  writePrivateTree(path.join(store, 'node_modules'), 3);

  for (const key of ['linked-a', 'linked-b']) {
    fs.mkdirSync(ws(key), { recursive: true });
    hardLinkTree(path.join(store, 'node_modules'), nm(key));
  }

  fs.mkdirSync(ws('private'), { recursive: true });
  writePrivateTree(nm('private'), 97);

  fs.mkdirSync(ws('pair-x'), { recursive: true });
  writePrivateTree(nm('pair-x'), 181);
  fs.mkdirSync(ws('pair-y'), { recursive: true });
  hardLinkTree(nm('pair-x'), nm('pair-y'));

  const candidates = ['linked-a', 'linked-b', 'private', 'pair-x', 'pair-y'].map(nm);

  // What removing all five ACTUALLY frees: the private tree, plus the pair once,
  // plus the directory blocks of the two store-linked trees (their directories
  // are their own - only the files are shared).
  const freedByPrivate = duBytes([nm('private')]);
  const freedByPair = duBytes([nm('pair-x'), nm('pair-y')]);
  const dirsOnlyLinked = duBytes([nm('linked-a'), nm('linked-b')]) - duBytes([path.join(store, 'node_modules')]);

  return {
    scratch,
    store,
    root,
    candidates,
    expectedFreed: freedByPrivate + freedByPair + dirsOnlyLinked,
    // Every name, counted once each - the number today's build reports.
    apparentTotal: [nm('linked-a'), nm('linked-b'), nm('private'), nm('pair-x'), nm('pair-y')]
      .reduce((sum, dir) => sum + duBytes([dir]), 0)
  };
}

/** Percentage by which `got` misses `want`. */
const missBy = (got, want) => (want === 0 ? (got === 0 ? 0 : Infinity) : Math.abs(got - want) / want);

const fmt = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;

// ---------------------------------------------------------------------------
// Sections 1-4: the real module
// ---------------------------------------------------------------------------

/**
 * Run one sweep over a fresh fixture with the given `sweepWorkspaces`, taking a
 * `statfs` reading either side of the deletion.
 *
 * Each reading is its own call, and nothing else in this process writes to
 * tmpfs between them.
 */
function runSweep(sweepWorkspaces) {
  const fixture = buildFixture();

  const before = freeBytes(TMPFS);
  const sweep = sweepWorkspaces({ liveWorkDirs: [], dryRun: false, root: fixture.root });
  const after = freeBytes(TMPFS);

  return { fixture, sweep, dfDelta: after - before };
}

const { sweepWorkspaces } = await import(path.join(DIST, 'reclaim.js'));

console.log('\n=== 1. df: the reported bytes against a real before/after statfs delta ===\n');

const main = runSweep(sweepWorkspaces);
const { fixture, sweep, dfDelta } = main;

console.log(`  fixture      ${fixture.root}`);
console.log(`  scanned      ${sweep.scanned} workspaces, ${sweep.directories} directories removed`);
console.log(`  reported     ${fmt(sweep.bytes)}  (bytes: ${sweep.bytes})`);
console.log(`  df freed     ${fmt(dfDelta)}  (statfs delta: ${dfDelta})`);
console.log(`  fixture says ${fmt(fixture.expectedFreed)}  (private + pair once + linked dirs)`);
console.log(`  per-name sum ${fmt(fixture.apparentTotal)}  (what counting every name gives)\n`);

if (sweep.directories !== 5) {
  fail(1, `the sweep removed ${sweep.directories} directories, not the 5 the fixture laid out - the rest of this proof is about a sweep that did not happen`);
}

// tmpfs allocates in pages and this is a real filesystem, so a little slack.
// 3% of a 32 MiB answer is under a megabyte; the defect under test is 4x.
const DF_TOLERANCE = 0.03;

if (missBy(dfDelta, fixture.expectedFreed) <= DF_TOLERANCE) {
  pass(1, `df moved by ${fmt(dfDelta)}, which is what the fixture's arithmetic predicts - df is measuring what we think it is`);
} else {
  fail(1, `df moved ${fmt(dfDelta)} but the fixture predicts ${fmt(fixture.expectedFreed)}; the instrument disagrees with the fixture, so neither can arbitrate the tool`);
}

if (missBy(sweep.bytes, dfDelta) <= DF_TOLERANCE) {
  pass(1, `reported ${fmt(sweep.bytes)} against a real df delta of ${fmt(dfDelta)}`);
} else {
  const ratio = dfDelta === 0 ? 'infinity' : `${(sweep.bytes / dfDelta).toFixed(2)}x`;
  fail(1, `reported ${fmt(sweep.bytes)} but df freed ${fmt(dfDelta)} - over-reporting by ${ratio}`);
}

// The one that says the fix is not just "report a smaller number".
if (sweep.bytes > 0) {
  pass(1, 'the private tree is still counted - the number did not get right by getting small');
} else {
  fail(1, 'reported zero bytes; a sweep that really did free the private copy must say so');
}

console.log('\n=== 2. du: an independent inode-deduplicating walk of the same fixture ===\n');

if (missBy(sweep.bytes, fixture.expectedFreed) <= 0.001) {
  pass(2, `reported bytes equals the du arithmetic exactly (${sweep.bytes} == ${fixture.expectedFreed})`);
} else {
  fail(2, `reported ${sweep.bytes} against du's ${fixture.expectedFreed} - a ${(sweep.bytes / Math.max(fixture.expectedFreed, 1)).toFixed(2)}x reading`);
}

// The store is the thing a wrong answer would have had to eat. It is outside the
// workspaces root, so it was never a candidate; if it lost bytes, the sweep did
// something far worse than mis-count.
const storeAfter = duBytes([path.join(fixture.store, 'node_modules')]);
if (storeAfter > 0 && fs.existsSync(path.join(fixture.store, 'node_modules', 'pkg', 'lib', 'chunk-0.bin'))) {
  pass(2, `the store outside the workspaces root is intact (${fmt(storeAfter)})`);
} else {
  fail(2, 'the store lost content - the sweep reached outside the workspaces root');
}

console.log('\n=== 3. the per-directory figures, which are what sum to the headline ===\n');

const perDirectory = sweep.reclaimed.flatMap((workspace) => workspace.removed);
const perDirectorySum = perDirectory.reduce((total, removed) => total + removed.bytes, 0);

for (const removed of perDirectory) {
  const which = path.basename(path.dirname(path.dirname(removed.path)));
  console.log(`  ${which.padEnd(10)} bytes=${String(removed.bytes).padStart(10)}  files=${removed.files}`);
}
console.log('');

if (perDirectorySum === sweep.bytes) {
  pass(3, `the per-directory bytes sum to the headline exactly (${perDirectorySum} == ${sweep.bytes})`);
} else {
  fail(3, `per-directory bytes sum to ${perDirectorySum} but the headline says ${sweep.bytes} - one of them is not what it claims`);
}

const byWorkspace = new Map(
  perDirectory.map((removed) => [path.basename(path.dirname(path.dirname(removed.path))), removed])
);

// A store-linked tree frees only its own directory blocks: every file in it has
// a surviving name in the store.
for (const key of ['linked-a', 'linked-b']) {
  const removed = byWorkspace.get(key);
  if (!removed) {
    fail(3, `${key} is missing from the per-directory report`);
  } else if (removed.bytes < duBytes([path.join(fixture.store, 'node_modules')]) * 0.5) {
    pass(3, `${key} is charged ${fmt(removed.bytes)} - its files' bytes belong to the store name that survives`);
  } else {
    fail(3, `${key} is charged ${fmt(removed.bytes)} for a tree whose every file still has a name in the store`);
  }
}

const privateRemoved = byWorkspace.get('private');
if (privateRemoved && missBy(privateRemoved.bytes, duBytes([path.join(fixture.store, 'node_modules')])) <= 0.05) {
  pass(3, `private is charged ${fmt(privateRemoved.bytes)} - the whole tree, because nothing else holds it`);
} else {
  fail(3, `private is charged ${privateRemoved ? fmt(privateRemoved.bytes) : 'nothing'}, and it should carry the full tree`);
}

// The pair: between them exactly one tree's worth, because that is what removing
// both actually gives back. Neither is zero-rated by an "nlink > 1" rule and
// neither is counted twice.
const pairSum = ['pair-x', 'pair-y'].reduce((total, key) => total + (byWorkspace.get(key)?.bytes ?? -1), 0);
const oneTree = duBytes([path.join(fixture.store, 'node_modules')]);
if (missBy(pairSum, oneTree) <= 0.05) {
  pass(3, `pair-x and pair-y together are charged ${fmt(pairSum)} - one tree, which is what unlinking both frees`);
} else {
  fail(3, `pair-x and pair-y together are charged ${fmt(pairSum)}, against one tree at ${fmt(oneTree)}`);
}

console.log('\n=== 4. the per-name number is still reported, under a name that says so ===\n');

if (typeof sweep.apparentBytes === 'number') {
  pass(4, `the sweep carries apparentBytes=${sweep.apparentBytes} (${fmt(sweep.apparentBytes)}) alongside bytes`);
  if (missBy(sweep.apparentBytes, fixture.apparentTotal) <= 0.01) {
    pass(4, 'and it is the per-name total, so a reader who wanted the old figure has not lost it');
  } else {
    fail(4, `apparentBytes is ${sweep.apparentBytes}, but every name summed comes to ${fixture.apparentTotal}`);
  }
  if (sweep.apparentBytes > sweep.bytes) {
    pass(4, 'apparentBytes exceeds bytes on this fixture, which is the whole distinction being drawn');
  } else {
    fail(4, `apparentBytes (${sweep.apparentBytes}) does not exceed bytes (${sweep.bytes}) on a fixture built to make it`);
  }
} else {
  fail(4, 'the sweep reports no apparentBytes - the per-name figure has been dropped rather than renamed');
}

fs.rmSync(fixture.scratch, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Section 5: can it fail?
// ---------------------------------------------------------------------------
//
// A patched build that counts `st.blocks * 512` once per NAME - which is what
// `daemon/src/reclaim.ts` did before this ticket. Sections 1-3 are re-run
// against it and MUST go red. A green here means the assertions above cannot
// tell the defect from the fix, and are therefore worth nothing.

console.log('\n=== 5. can it fail: the same assertions against per-name counting ===\n');

// The patched copy has to sit INSIDE `daemon/`, not on tmpfs: the built modules
// import `node-pty` and friends, and Node resolves those by walking up from the
// importing file. A copy on tmpfs has no `node_modules` above it and dies on the
// first bare specifier - which is a broken arm, not a red.
const patchDir = fs.mkdtempSync(path.join(DAEMON, '.kan545-patched-'));
litter.push(patchDir);
fs.cpSync(DIST, patchDir, { recursive: true });

const patchedPath = path.join(patchDir, 'reclaim.js');
const original = fs.readFileSync(patchedPath, 'utf8');

// Replace the whole measure() body with the pre-KAN-545 one: add every name's
// blocks, ask nothing about inodes or link counts.
const perNameMeasure = `function measure(dir) {
    let bytes = 0;
    let files = 0;
    const walk = (current) => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(full); continue; }
            try { const st = fs.lstatSync(full); bytes += st.blocks * 512; files += 1; } catch { }
        }
    };
    walk(dir);
    return { bytes, files, apparentBytes: bytes };
}`;

// Matched on the bare name, not on a parameter list: the signature gained a
// `ledger` argument in this very ticket, and an anchor that pins the old one
// silently stops finding it. It fails loudly below if it finds nothing.
const measureStart = original.indexOf('function measure(');
if (measureStart < 0) {
  fail(5, 'could not find measure() in the built module, so the patched arm did not run and section 1-3 greens are unproven');
} else {
  // Find the end of the function by brace matching from its opening brace.
  let depth = 0;
  let index = original.indexOf('{', measureStart);
  const bodyStart = index;
  do {
    if (original[index] === '{') depth += 1;
    else if (original[index] === '}') depth -= 1;
    index += 1;
  } while (depth > 0 && index < original.length);

  if (depth !== 0) {
    fail(5, 'could not brace-match measure() in the built module; the patched arm did not run');
  } else {
    const patched = original.slice(0, measureStart) + perNameMeasure + original.slice(index);
    fs.writeFileSync(patchedPath, patched);

    const { sweepWorkspaces: patchedSweep } = await import(`${patchedPath}?patched=1`);
    const bad = runSweep(patchedSweep);

    console.log(`  patched build reports ${fmt(bad.sweep.bytes)} against a df delta of ${fmt(bad.dfDelta)}`);
    console.log(`  fixture arithmetic still says ${fmt(bad.fixture.expectedFreed)}\n`);

    // Section 1's assertion.
    if (missBy(bad.sweep.bytes, bad.dfDelta) > DF_TOLERANCE) {
      pass(5, `section 1 goes RED against per-name counting (${fmt(bad.sweep.bytes)} reported, ${fmt(bad.dfDelta)} freed)`);
    } else {
      fail(5, 'section 1 stayed GREEN against per-name counting - it cannot tell the defect from the fix');
    }

    // Section 2's assertion.
    if (missBy(bad.sweep.bytes, bad.fixture.expectedFreed) > 0.001) {
      pass(5, 'section 2 goes RED against per-name counting');
    } else {
      fail(5, 'section 2 stayed GREEN against per-name counting');
    }

    // Section 3's assertion, on the arm that is the whole point: a store-linked
    // tree charged for bytes the store still holds.
    const badByWorkspace = new Map(
      bad.sweep.reclaimed
        .flatMap((workspace) => workspace.removed)
        .map((removed) => [path.basename(path.dirname(path.dirname(removed.path))), removed])
    );
    const badLinked = badByWorkspace.get('linked-a');
    const badOneTree = duBytes([path.join(bad.fixture.store, 'node_modules')]);
    if (badLinked && badLinked.bytes >= badOneTree * 0.5) {
      pass(5, `section 3 goes RED: per-name counting charges linked-a ${fmt(badLinked.bytes)} for a tree the store still holds`);
    } else {
      fail(5, 'section 3 stayed GREEN against per-name counting');
    }

    // And the direction that proves the patched arm is the OLD behaviour rather
    // than simply a broken build: it must over-report, never under-report.
    if (bad.sweep.bytes > bad.fixture.expectedFreed) {
      pass(5, `the patched arm over-reports by ${(bad.sweep.bytes / Math.max(bad.fixture.expectedFreed, 1)).toFixed(2)}x, which is the defect KAN-545 describes`);
    } else {
      fail(5, 'the patched arm did not over-report, so it is not reproducing the defect and its reds prove nothing');
    }

    fs.rmSync(bad.fixture.scratch, { recursive: true, force: true });
  }
}

fs.rmSync(patchDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} - ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
