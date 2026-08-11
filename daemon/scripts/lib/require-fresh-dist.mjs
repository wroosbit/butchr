//
// KAN-311: a verify script that imports `../dist/` is measuring a build, not a
// checkout, and a stale one produces a run that looks exactly like a real pass.
//
// WHY THIS IS A GUARD AND NOT A NOTE IN A HEADER. At `epic/KAN-39`'s review of
// #127, the first local run of `verify-atlassian-proxy-read-surface.mjs` was
// against a `dist` with **13 source files newer than it**. It printed
// `22 operations, 396 placements` and read as a clean pass, because both heads
// happened to have 22 operations — the number that would have given it away was
// the same on both sides. It was caught only by checking mtimes by hand, and it
// nearly cost an approval on a run that never executed the code under review.
//
// A stale instrument whose output is indistinguishable from a real one is the
// failure mode this epic keeps re-finding, so this refuses rather than warns.
// A warning printed above a screen of PASS lines is a warning nobody reads, and
// the whole problem is that the run looks fine.
//
// THIS EXIT IS A SETUP GUARD, NOT A VERDICT. It says the script could not run,
// never that the thing under test is broken — so it exits **2**, distinct from
// the 1 a real failure exits with, and the caller keeps its own
// `process.exit(failures ? 1 : 0)` as the verdict path that
// `sweep-verify-exit-paths.mjs` requires.
//

import fs from 'fs';
import path from 'path';

/** The newest mtime under a directory tree, in ms, or 0 if it has no files. */
function newestMtime(dir, extensions) {
  let newest = 0;
  let newestFile = null;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestFile = full;
      }
    }
  };
  walk(dir);
  return { newest, newestFile };
}

/**
 * Refuse to run when `dist` is older than `src` — i.e. when the built modules
 * this script is about to import are not the checkout a reader is reviewing.
 *
 * Returns nothing and exits 2 on staleness or on a missing build. Call it
 * before the first assertion; the ESM imports above it have already loaded the
 * stale modules, which is fine because nothing has been asserted on them yet.
 */
export function requireFreshDist(srcDir, distDir, { hint } = {}) {
  const build = hint ?? 'npm run build';

  if (!fs.existsSync(distDir)) {
    console.error(
      `\nCANNOT RUN — no build at ${distDir}.\n` +
        `This script imports the built modules, not the TypeScript. Run \`${build}\` first.\n`
    );
    process.exit(2);
  }

  const src = newestMtime(srcDir, ['.ts']);
  const dist = newestMtime(distDir, ['.js']);

  if (!dist.newest) {
    console.error(
      `\nCANNOT RUN — ${distDir} exists but contains no built JavaScript.\n` +
        `Run \`${build}\` first.\n`
    );
    process.exit(2);
  }

  if (src.newest > dist.newest) {
    // Name the count and one example. "13 source files newer than dist" is the
    // sentence that would have ended the #127 detour in a second.
    const stale = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && fs.statSync(full).mtimeMs > dist.newest) {
          stale.push(full);
        }
      }
    };
    walk(srcDir);
    console.error(
      `\nCANNOT RUN — the build is stale: ${stale.length} source file(s) are newer than ${distDir}.\n` +
        `   newest source: ${src.newestFile}\n` +
        `   newest build:  ${dist.newestFile}\n` +
        `This script imports the built modules, so it would measure the OLD code and print a\n` +
        `pass that looks exactly like a real one. Run \`${build}\` and re-run.\n`
    );
    process.exit(2);
  }
}
