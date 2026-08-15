#!/usr/bin/env node
//
// KAN-442 — briefs are rendered from `origin/main`, and doing so cannot move a
// file under an agent that is reading the shared clone.
//
// WHAT FAILURE THIS WOULD CATCH: the shared clone's working tree drifting back
// into the briefs. `~/code/wroosbit/butchr`'s `main` is never advanced — agents
// read that tree concurrently and `prompts/task.md` forbids moving it — so it
// falls behind `origin/main` by one commit per merge, monotonically, and every
// brief rendered from it teaches governance that has moved. Measured: KAN-437
// fast-forwarded it by hand on 2026-08-14 and it was `[behind 7]` six hours
// later, carrying a `prompts/task.md` 34 lines out of date. Four shapes of that
// failure, each of which would ship green under a laxer test:
//
//   1. **Reading the working tree while claiming the ref.** The render succeeds,
//      the block reads perfectly, and the bytes are the stale ones. §2.
//   2. **Stamping the working tree's commit onto the ref's text.** The subtler
//      half, and it is worse than useless: the reader's
//      `log <stamp>..origin/main` then lists the very commits their brief
//      already contains, reporting "a rule changed after you were briefed"
//      about a change they are looking at. A check that cries wolf is a check
//      an agent stops running. §3.
//   3. **A fallback that lies.** When `origin/main` cannot be read the loader
//      must still render — an activation is never lost to git — but a brief
//      that silently reverts to the working tree while its block still says
//      `origin/main` is the original defect wearing the fix's clothes. §5.
//   4. **The regression going unnoticed.** §6 drives the `prompt-source`
//      staleness item red on exactly that fallback.
//
// AND §4 IS THE ONE THE TICKET ASKED FOR (AC2): that this is safe against an
// agent reading the tree concurrently, *demonstrated rather than asserted*. It
// runs a real second process reading the working tree in a loop and shows the
// bytes under it never move across many renders — then runs the SAME reader
// across `git pull --ff-only`, the option this design rejected, and shows the
// bytes changing under it mid-read. The control is the point: it makes the
// hazard real rather than hypothetical, and shows this mechanism does not have
// it. §4c holds `index.lock` — the thing that made a concurrent `git` write
// dangerous — and shows a render is untroubled by it.
//
// CI-RUNNABLE: yes — builds scratch git repositories under `os.tmpdir()` and
// imports the built daemon modules in process; git and node builtins only, no
// live daemon, no herdr, no credential, no peer, no terminal, no network.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT WRITES THE REPOSITORIES IT THEN ASSERTS ON — SAID PLAINLY,
// BECAUSE THAT IS THE KAN-145 FAILURE MODE AND THE HEADER IS WHERE THE EDGE GOES
// ---------------------------------------------------------------------------
// Every fixture here is built by this file: the scratch checkout, its `origin`,
// the commits, the drift between them. So what these sections prove is that
// **the loader, given a repository in a known state, reads and stamps the right
// one** — never that the production daemon is pointed at a real shared clone.
//
// WHAT THAT LEAVES UNCOVERED, and who covers it:
//   - **That the daemon's `repoRoot` really is the shared clone every agent
//     fetches.** Not covered here. `daemon.ts` resolves it as
//     `path.resolve(__dirname, '../../')`, and nothing in this file reads
//     `daemon.ts`. Covered by an observation of the running system pasted into
//     the PR: `butchr_staleness_check` on the live install, whose `prompt-source`
//     item names the ref and the path it resolved.
//   - **That a real activation produces a brief carrying the ref-sourced
//     block.** Not covered here — this script never activates anything. Covered
//     by a `grep` of a live workspace's `.butchr-prompt.md`, pasted into the PR
//     by hand, exactly as KAN-242 covered the same edge for its own block.
//   - **Whether an already-briefed agent re-reads anything.** Covered by
//     nobody, permanently, and that is the KAN-242 finding rather than a gap in
//     this script: the brief lives in a context nothing on this machine can
//     reach.
//
// NOTE ON READING THIS SCRIPT'S VERDICT: it imports from `daemon/dist`, so a
// failed build makes every section below evidence about the previous build
// rather than about your change. Confirm `npm run build` exited 0 — without a
// pipe, which reports the wrong process's status — before believing any line of
// its output.
//

import assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const DIST = path.join(REPO_ROOT, 'daemon', 'dist');

if (!fs.existsSync(path.join(DIST, 'prompt.js'))) {
  // A setup guard, not a verdict: there is nothing to assert on.
  console.error(`daemon/dist is missing at ${DIST}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const { PromptLoader, templateProvenance, renderProvenanceBlock } = await import(
  path.join(DIST, 'prompt.js')
);
const { resolvePromptSource, readTemplateAt, PROMPT_REF } = await import(
  path.join(DIST, 'prompt-source.js')
);
const { getStalenessReport, resetStalenessCache } = await import(path.join(DIST, 'staleness.js'));

let failures = 0;
let cases = 0;

function check(label, fn) {
  cases++;
  try {
    fn();
    console.log(`  PASS  case ${cases}: ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  case ${cases}: ${label}`);
    console.log(`        ${err?.message ?? err}`);
  }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  }).trim();
}

const TEMPLATE = 'prompts/task.md';

/**
 * A checkout whose working tree is deliberately behind its `origin/main`.
 *
 * This is the production shape reproduced in miniature: `origin` has moved on,
 * the clone has fetched it, and the clone's own `main` has NOT been advanced —
 * because advancing it is what the rule forbids.
 */
function makeDriftedClone(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kan442-${label}-`));
  const upstream = path.join(root, 'upstream.git');
  const clone = path.join(root, 'clone');

  fs.mkdirSync(upstream);
  git(upstream, ['init', '--bare', '--initial-branch=main', '--quiet']);

  const seed = path.join(root, 'seed');
  fs.mkdirSync(path.join(seed, 'prompts'), { recursive: true });
  git(root, ['init', seed, '--initial-branch=main', '--quiet']);
  git(seed, ['config', 'user.email', 'kan442@example.invalid']);
  git(seed, ['config', 'user.name', 'KAN-442 fixture']);

  // v1 — the rule as it stood when the clone's working tree was last advanced.
  fs.writeFileSync(
    path.join(seed, TEMPLATE),
    'RULE: the epic agent merges your PR.\n\n{{PROMPT_PROVENANCE}}\n'
  );
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'v1: the old merge rule']);
  git(seed, ['remote', 'add', 'origin', upstream]);
  git(seed, ['push', '-q', 'origin', 'main']);

  git(root, ['clone', '--quiet', upstream, clone]);
  git(clone, ['config', 'user.email', 'kan442@example.invalid']);
  git(clone, ['config', 'user.name', 'KAN-442 fixture']);
  const v1 = git(clone, ['rev-parse', 'HEAD']);

  // v2 — governance moves upstream. An unrelated file moves too, so that a
  // stamp taken from HEAD rather than from the template's own commit is
  // distinguishable from one taken correctly.
  fs.writeFileSync(path.join(seed, 'unrelated.txt'), 'noise\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'unrelated: touches no prompt']);
  fs.writeFileSync(
    path.join(seed, TEMPLATE),
    'RULE: you merge your own PR after approval.\n\n{{PROMPT_PROVENANCE}}\n'
  );
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'v2: merge governance changed']);
  const v2 = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', 'origin', 'main']);

  // The clone fetches — which every agent does — and does NOT pull. This is the
  // production state exactly: `origin/main` current, working tree behind.
  git(clone, ['fetch', '--quiet', 'origin']);

  return { root, upstream, clone, seed, v1, v2 };
}

const cleanups = [];
function fixture(label) {
  const f = makeDriftedClone(label);
  cleanups.push(f.root);
  return f;
}

// ===========================================================================
console.log('\n== 1. the fixture really is drifted (a control on the test itself) ==\n');
// A test whose fixture is not in the state it claims proves nothing, and this
// one's whole subject is a drift. So the drift is asserted before it is used.
// ===========================================================================
{
  const f = fixture('control');
  check('the clone`s working tree is behind origin/main', () => {
    const behind = Number(git(f.clone, ['rev-list', '--count', 'HEAD..origin/main']));
    assert.ok(behind > 0, `expected the working tree to be behind, got ${behind}`);
  });
  check('and the two versions of the template genuinely differ on disk', () => {
    const onDisk = fs.readFileSync(path.join(f.clone, TEMPLATE), 'utf8');
    const atRef = git(f.clone, ['show', `origin/main:${TEMPLATE}`]);
    assert.ok(onDisk.includes('the epic agent merges'), `working tree unexpectedly held: ${onDisk}`);
    assert.ok(atRef.includes('you merge your own PR'), `ref unexpectedly held: ${atRef}`);
  });
}

// ===========================================================================
console.log('\n== 2. the render reads the REF, not the working tree ==\n');
// ===========================================================================
{
  const f = fixture('reads-ref');
  const rendered = new PromptLoader(f.clone).loadAndRender(TEMPLATE, {});

  check('the brief carries the rule as merged, not the rule on disk', () => {
    assert.ok(
      rendered.includes('you merge your own PR after approval'),
      `brief did not carry the merged rule:\n${rendered}`
    );
  });
  check('and does NOT carry the superseded rule the working tree still holds', () => {
    assert.ok(
      !rendered.includes('the epic agent merges your PR'),
      `brief carried the stale working-tree rule:\n${rendered}`
    );
  });
  check('the source resolves to the ref, and names it', () => {
    const source = resolvePromptSource(f.clone);
    assert.equal(source.kind, 'ref');
    assert.equal(source.ref, PROMPT_REF);
    assert.equal(source.sha, f.v2);
  });
  check('the block says so, so a reader can tell which source they got', () => {
    assert.ok(
      rendered.includes(`at \`${PROMPT_REF}\``) && rendered.includes('no working tree was involved'),
      `block did not name its source:\n${rendered}`
    );
  });
}

// ===========================================================================
console.log('\n== 3. the stamp names the REF`s commit for this path, not HEAD ==\n');
// The failure this closes is a false positive, which is worse than a miss: a
// brief stamped with the working tree`s older commit sends its reader to
// `log <old>..origin/main`, which lists the commits their text already
// contains. They then read "a rule changed after you were briefed" about a
// change they are looking at, and learn to distrust the check.
// ===========================================================================
{
  const f = fixture('stamp');
  const p = templateProvenance(f.clone, TEMPLATE, resolvePromptSource(f.clone));

  check('the stamped commit is the one that last changed this path at the ref', () => {
    assert.ok(p.commit, `no commit stamped: ${p.unavailable}`);
    assert.equal(p.commit.sha, f.v2);
  });
  check('and is NOT the working tree`s commit for it', () => {
    assert.notEqual(p.commit.sha, f.v1);
  });
  check('the check the block embeds answers "current" — the whole point of it', () => {
    // Run the reader's own command verbatim rather than a paraphrase of it: a
    // block whose command is subtly wrong still runs and still prints nothing,
    // which the block defines as "this brief is current".
    const out = git(f.clone, [
      'log',
      '--oneline',
      `${p.commit.shortSha}..origin/main`,
      '--',
      TEMPLATE
    ]);
    assert.equal(out, '', `expected no output (brief is current), got:\n${out}`);
  });
  check('and the same command from the WORKING TREE`s commit is noisy — the old state', () => {
    const out = git(f.clone, ['log', '--oneline', `${f.v1}..origin/main`, '--', TEMPLATE]);
    assert.ok(out.length > 0, 'expected the pre-KAN-442 stamp to report a moved rule, got nothing');
  });
}

// ===========================================================================
console.log('\n== 4. AC2 — SAFE AGAINST A CONCURRENT READER, DEMONSTRATED ==\n');
// The ticket asks for this to be shown, not claimed. Sections 4a and 4b run the
// SAME reader process against the two options, so the difference between them
// is the mechanism and nothing else.
// ===========================================================================

/**
 * A real second process reading the working-tree template in a tight loop.
 *
 * It reports every distinct content-hash it observes. One hash means nothing
 * moved under it; two means a file changed while it was being read, which is
 * precisely the hazard `prompts/task.md` cites when it forbids `pull` in the
 * shared clone.
 */
function startReader(clone) {
  const src = `
    const fs = require('fs'), crypto = require('crypto');
    const target = ${JSON.stringify(path.join(clone, TEMPLATE))};
    const seen = new Set();
    const deadline = Date.now() + 60000;
    process.on('SIGTERM', () => { console.log(JSON.stringify([...seen])); process.exit(0); });
    (function spin() {
      try {
        seen.add(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
      } catch (e) { seen.add('ERROR:' + e.code); }
      if (Date.now() < deadline) setImmediate(spin);
      else { console.log(JSON.stringify([...seen])); process.exit(0); }
    })();
  `;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  return {
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      return JSON.parse(out.trim() || '[]');
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 4a: the mechanism this ticket ships -----------------------------------
{
  const f = fixture('concurrent-render');
  const before = fs.readFileSync(path.join(f.clone, TEMPLATE));

  const reader = startReader(f.clone);
  await sleep(150); // let it get going, so "one hash" means it really looked
  const loader = new PromptLoader(f.clone);
  for (let i = 0; i < 40; i++) loader.loadAndRender(TEMPLATE, {});
  await sleep(150);
  const hashes = await reader.stop();

  check('a concurrent reader saw the working-tree file never change across 40 renders', () => {
    assert.ok(hashes.length > 0, 'the reader observed nothing at all — it was not really running');
    assert.equal(
      hashes.length,
      1,
      `the reader saw ${hashes.length} distinct states, so a render moved a file under it`
    );
    assert.ok(!hashes[0].startsWith('ERROR'), `the reader could not read the file: ${hashes[0]}`);
  });
  check('and the working tree is byte-identical afterwards', () => {
    assert.ok(fs.readFileSync(path.join(f.clone, TEMPLATE)).equals(before), 'the template moved');
  });
  check('while those renders did carry the ref`s text — the reads were not no-ops', () => {
    // Without this, "nothing changed" would also be satisfied by a render that
    // silently did nothing, which is a green for the wrong reason.
    assert.ok(loader.loadAndRender(TEMPLATE, {}).includes('you merge your own PR after approval'));
  });
  check('and the checkout`s own branch never moved', () => {
    assert.equal(git(f.clone, ['rev-parse', 'HEAD']), f.v1);
  });
}

// --- 4b: THE CONTROL — the rejected option, under the same reader ----------
// This is the red that makes 4a mean something. `pull --ff-only` is the obvious
// answer to KAN-442 and it is the one the existing rule forbids; here is the
// forbidding demonstrated rather than repeated.
{
  const f = fixture('concurrent-pull');

  const reader = startReader(f.clone);
  await sleep(150);
  git(f.clone, ['pull', '--ff-only', '--quiet', 'origin', 'main']);
  await sleep(150);
  const hashes = await reader.stop();

  check('CONTROL: `pull --ff-only` DID change the file under the very same reader', () => {
    assert.ok(hashes.length > 0, 'the reader observed nothing at all — it was not really running');
    // MORE THAN ONE, not exactly two, and the difference was measured rather
    // than anticipated: driving this script red once showed the reader
    // observing THREE states across a pull. A fast-forward is not atomic from a
    // reader's point of view — the file can be seen before, mid-swap and after,
    // and a mid-swap read can even fail outright. Asserting `=== 2` would have
    // made this control flake in CI, and a flaky control is worse than none: it
    // trains the next reader to re-run until green. The claim being made is
    // "the bytes moved under the reader", and that is `> 1`.
    assert.ok(
      hashes.length > 1,
      `expected the reader to observe the file changing, saw only ${hashes.length} state`
    );
  });
  check('CONTROL: and every state it saw is accounted for as before, after, or mid-swap', () => {
    // Reported rather than swallowed, because a transient ERROR here is the
    // hazard in its sharpest form: an agent reading the shared clone during a
    // fast-forward can get no file at all.
    const errors = hashes.filter((h) => h.startsWith('ERROR'));
    console.log(
      `        (the reader saw ${hashes.length} distinct states across the pull` +
        `${errors.length ? `, ${errors.length} of them read failures: ${errors.join(', ')}` : ''})`
    );
    assert.ok(hashes.length >= 2);
  });
  check('CONTROL: and it moved the checkout`s branch, which agents share', () => {
    assert.equal(git(f.clone, ['rev-parse', 'HEAD']), f.v2);
  });
}

// --- 4c: a concurrent git write is holding index.lock ----------------------
// The specific mechanism behind the hazard: git operations that touch the index
// take this lock, and a second one fails. If rendering needed it, an agent
// running `git add` in the shared clone could make an activation fail. It does
// not, because `git show` reads objects.
{
  const f = fixture('index-lock');
  const lock = path.join(f.clone, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  try {
    check('a render succeeds while another process holds index.lock', () => {
      const out = new PromptLoader(f.clone).loadAndRender(TEMPLATE, {});
      assert.ok(out.includes('you merge your own PR after approval'), 'render did not read the ref');
    });
    check('CONTROL: a working-tree-moving git command fails against that same lock', () => {
      // Establishes the lock is real and that the render's success is a property
      // of the mechanism rather than of a lock that was never contended.
      assert.throws(() => git(f.clone, ['pull', '--ff-only', 'origin', 'main']));
    });
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ===========================================================================
console.log('\n== 5. the fallback renders, and says what it fell back to ==\n');
// An activation must never be lost to git. But a brief that reverts to the
// working tree while still claiming `origin/main` is the original defect in the
// fix's clothes, so the block has to name the source it actually used.
// ===========================================================================
{
  const f = fixture('fallback');
  // Remove the remote-tracking ref: the state of a clone that has never fetched.
  git(f.clone, ['update-ref', '-d', 'refs/remotes/origin/main']);

  const source = resolvePromptSource(f.clone);
  const rendered = new PromptLoader(f.clone).loadAndRender(TEMPLATE, {});

  check('the source degrades to the working tree rather than throwing', () => {
    assert.equal(source.kind, 'worktree');
    assert.ok(source.because && source.because.length > 0, 'no reason given for the fallback');
  });
  check('the brief still renders — an activation is never lost to git', () => {
    assert.ok(rendered.includes('RULE:'), `nothing rendered:\n${rendered}`);
  });
  check('it carries the working tree`s text, which is what it actually read', () => {
    assert.ok(rendered.includes('the epic agent merges your PR'));
  });
  check('and the block SAYS it is the working tree and may be behind', () => {
    assert.ok(
      rendered.includes('working tree') && rendered.includes('may be behind'),
      `the block did not disclose the fallback:\n${rendered}`
    );
  });
  check('and the REASON itself is rendered, verbatim, not merely required to exist', () => {
    // ADDED BY `epic/KAN-39` IN REVIEW, and the gap was real: the tagged union
    // makes `because` impossible to omit when CONSTRUCTING a worktree source,
    // so the type carries the invariant — but nothing checked the renderer
    // still printed it. Their mutation replaced `(${p.source.because})` with a
    // constant, and all 30 cases stayed green, including the case directly
    // above: "working tree" and "may be behind" are the renderer's own fixed
    // words and survive any mutation of the reason.
    //
    // So an agent could have been handed a stale working-tree brief with the
    // reason stripped, in a change whose entire subject is provenance
    // disclosure. This asserts the reason STRING reaches the page, which is the
    // property the prose promises — the type guarantees it exists, and only
    // this guarantees it is said. Same shape as KAN-449 collects.
    assert.ok(
      rendered.includes(source.because),
      `the fallback reason never reached the brief.\nexpected to find: ${source.because}\nin:\n${rendered}`
    );
  });
  check('and does not claim the ref it did not read', () => {
    assert.ok(
      !rendered.includes('no working tree was involved'),
      `the block claimed a ref-sourced read it did not perform:\n${rendered}`
    );
  });
}

// ===========================================================================
console.log('\n== 6. AC3 — the staleness item notices the regression, driven red ==\n');
// Not "is the tree behind": that is true by design, every day, forever, and an
// item that is always red is an item nobody reads. What can regress is the
// SOURCE, and this drives exactly that.
// ===========================================================================
{
  const f = fixture('staleness');

  resetStalenessCache();
  const green = getStalenessReport({ repoRoot: f.clone, force: true });
  const greenItem = green.items.find((i) => i.id === 'prompt-source');

  check('with the ref present the item is fresh and names the ref', () => {
    assert.ok(greenItem, 'no prompt-source item in the report');
    assert.equal(greenItem.state, 'fresh', `expected fresh, got ${greenItem.state}: ${greenItem.headline}`);
    assert.ok(greenItem.headline.includes(PROMPT_REF), greenItem.headline);
  });
  check('and it does NOT raise an alarm about the working tree being behind', () => {
    // The whole design point: the checkout is genuinely behind here, and that is
    // correct and permanent. If this item alarmed on it, it would be red every
    // day and would be ignored — which is how the original defect survived.
    assert.ok(Number(git(f.clone, ['rev-list', '--count', 'HEAD..origin/main'])) > 0);
    assert.equal(greenItem.state, 'fresh');
  });

  // THE RED. Delete the ref: the loader falls back to the working tree, which is
  // precisely the pre-KAN-442 behaviour returning.
  git(f.clone, ['update-ref', '-d', 'refs/remotes/origin/main']);
  resetStalenessCache();
  const red = getStalenessReport({ repoRoot: f.clone, force: true });
  const redItem = red.items.find((i) => i.id === 'prompt-source');

  check('RED: with the ref gone the item goes stale', () => {
    assert.equal(redItem.state, 'stale', `expected stale, got ${redItem.state}: ${redItem.headline}`);
  });
  check('RED: it says briefs are coming from the working tree', () => {
    assert.ok(/working tree/i.test(redItem.headline), redItem.headline);
  });
  check('RED: and the report as a whole is alarmed, so a banner would show it', () => {
    assert.equal(red.stale, true);
    assert.ok(red.summary && red.summary.includes('WORKING TREE'), red.summary);
  });
  check('RED: it carries a remedy that would actually restore the ref', () => {
    assert.ok(redItem.remedy && redItem.remedy.includes('fetch'), redItem.remedy);
  });
}

// ===========================================================================
for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? `\nALL PASS — ${cases} asserted cases, every verdict as specified.\n`
    : `\n${failures} of ${cases} cases FAILED.\n`
);
process.exit(failures ? 1 : 0);
