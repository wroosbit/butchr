// KAN-465: the shared recursive sweep, and the reason it is shared rather than
// copied — a flat `readdirSync` over a tree that has depth reads correctly,
// returns a plausible number, and that number looks like an answer.
//
// WHAT FAILURE THIS WOULD CATCH: a proof script enumerating `daemon/src` with a
// flat `readdirSync` and reporting a verdict about 58 files as though it were a
// verdict about 62. `daemon/src` has held one subdirectory —
// `integrations/{integration,enablement,launchdarkly,atlassian-integration}.ts`
// — for as long as that directory has existed, and until this module two
// shipped checks could not see into it: `verify-channel-meta-renderable.mjs`
// and `verify-notifications-never-type.mjs`. The second is the check that a
// daemon notification never types at a pane, which is the composer hazard
// itself, so the property was guarded across 58 of the 62 files that could
// break it.
//
// THIS IS THE FIFTH INSTANCE IN A WEEK, and the argument for a module rather
// than five patches is in how they were found: `epic/KAN-39`'s
// `daemon/scripts/*.mjs` glob (96 of 110) by accident, KAN-406 (16 of 17, the
// miss in `scripts/lib/`) by mutation, KAN-424's sweep by mutation, KAN-456's
// §4 gate (58 of 62) by mutation, and these two by measurement only because
// KAN-456 prompted a look. FOUR OF FIVE WERE INVISIBLE TO REVIEW. A grep for
// `readdirSync` finds the shape and says nothing about whether it is wrong; the
// discriminating question is whether the swept tree has depth, and a reader of
// a bare count cannot ask it.
//
// SO THE COVERAGE IS PART OF THE OUTPUT, NOT A PROPERTY OF THE CODE. Copying
// the recursion alone would fix these two scripts and leave the next one to be
// found by accident again. `sweepTree` reports what it reached — the count AND
// the below-top-level fact — so a future regression to flat is visible in a
// GREEN run, before anybody has to go looking. That property is KAN-456's, from
// the gate `epic/KAN-39` repaired by mutation; it is copied here deliberately.
//
// A FLAT SWEEP IS NOT NAMEABLE THROUGH THIS MODULE. There is no `recursive:
// false`, no depth argument and no exported non-recursive enumerator, because
// the invariant here is about what a caller is ABLE to say. `prompts/task.md`:
// "reach for the type when the invariant is about what the code is able to
// say." An assertion that a sweep recursed can be deleted by a later author
// with the build still green; a flat sweep that cannot be written at all
// cannot be reintroduced by one.
//
// NOT A `verify-` SCRIPT. It asserts nothing on its own and exits nowhere; it
// is a library the proofs call, and its own red drive lives in the scripts that
// use it — driving one of them red at depth 2 exercises this file. That is
// deliberate, and it is the coverage boundary this header owes the reader: this
// module is covered by `verify-channel-meta-renderable.mjs` §1c and
// `verify-notifications-never-type.mjs` §sweep, both of which fail when the
// walk stops recursing, and by neither when they are not run.

import fs from 'fs';
import path from 'path';

/** Default predicate: TypeScript sources. */
const IS_TS = (name) => name.endsWith('.ts');

/**
 * The control's own enumeration, written out by hand and DELIBERATELY NOT the
 * one `sweepTree` uses.
 *
 * Two independent implementations are the whole value here. `sweepTree` reads
 * the tree with Node's own `readdirSync(..., { recursive: true })`; this walks
 * it explicitly. If either stops recursing the two disagree and the caller's
 * coverage check goes red naming the files that went missing — whereas a
 * control built on the same call as the thing it controls regresses with it and
 * goes green forever. `prompts/task.md`: "a check that could only ever return
 * the answer you were hoping for is not a weak check, it is a check that does
 * not exist while appearing to."
 */
function walkByHand(dir, match, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkByHand(path.join(dir, entry.name), match, rel));
    else if (match(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Every matching file under `root`, recursively, with paths relative to it and
 * separators normalised to `/`.
 *
 * The returned paths are `path.join`-able against `root` exactly as a flat
 * `readdirSync`'s were, so a call site converts by swapping the enumerator and
 * changing nothing else — which is what makes converting the fifth instance of
 * this defect cheap enough to actually do.
 */
export function everySourceFile(root, match = IS_TS) {
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split(path.sep).join('/'))
    .filter((rel) => match(path.basename(rel)))
    .sort();
}

/**
 * Sweep `root` and hand back both the files AND the evidence that the sweep
 * reached them.
 *
 * The two travel together on purpose: a caller cannot take the file list
 * without also being handed the coverage sentence and the control's verdict, so
 * "the sweep read everything" stops being a claim a reader has to take on
 * trust and becomes a line in the output.
 *
 * @param {string} root      directory to sweep
 * @param {object} [options]
 * @param {(name: string) => boolean} [options.match] predicate on the BASENAME
 * @param {string} [options.label] how the tree is named in the coverage line
 * @param {string} [options.what]  what the files are called in the coverage line
 */
export function sweepTree(root, { match = IS_TS, label, what = '.ts file(s)' } = {}) {
  const files = everySourceFile(root, match);
  const byHand = walkByHand(root, match);

  const seen = new Set(files);
  // Files the control found and the sweep did not. This is the branch that goes
  // red when the sweep regresses to flat: `integrations/launchdarkly.ts` is
  // reachable by the hand walk at any depth, so a depth-1 sweep loses it here.
  const missed = byHand.filter((rel) => !seen.has(rel)).sort();
  // And the other direction, because a control is only worth its symmetry: a
  // sweep reporting files the tree does not hold is as broken as one missing
  // them, and neither direction is more likely a priori.
  const byHandSeen = new Set(byHand);
  const phantom = files.filter((rel) => !byHandSeen.has(rel)).sort();

  const below = files.filter((rel) => rel.includes('/'));
  const subdirs = [...new Set(below.map((rel) => rel.slice(0, rel.lastIndexOf('/'))))].sort();

  const coverage =
    `swept ${files.length} ${what} under ${label ?? root}, ` +
    `including ${below.length} below the top level` +
    (subdirs.length ? ` (${subdirs.map((d) => `${d}/`).join(', ')})` : '');

  return {
    root,
    files,
    belowTopLevel: below.length,
    subdirs,
    missed,
    phantom,
    coverage,
    /** True when the sweep and the independent hand walk agree exactly. */
    reachedEverything: missed.length === 0 && phantom.length === 0,
    /** Why, in one line, for a `check()`'s detail argument. */
    detail:
      missed.length || phantom.length
        ? `sweep and independent walk DISAGREE — missed: ${missed.join(', ') || '(none)'}` +
          `; not on disk: ${phantom.join(', ') || '(none)'}`
        : `${files.length} file(s), confirmed against an independent recursive walk of ${
            label ?? root
          }`
  };
}

/**
 * Read one swept file. Kept here so a call site never rebuilds the join itself
 * and cannot get the relative-path convention wrong.
 */
export function readSwept(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
