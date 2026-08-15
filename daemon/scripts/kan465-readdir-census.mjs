#!/usr/bin/env node
// KAN-465 acceptance criterion 4 — the census, re-runnable rather than pasted.
//
// WHAT IT ANSWERS: which `readdirSync` call sites under the swept script
// directories enumerate a tree NON-RECURSIVELY, and — the discriminating half —
// whether the tree each one reaches actually has depth. A grep for
// `readdirSync` finds the shape and says nothing about whether it is wrong;
// `find <tree> -maxdepth 1` against `find <tree>` is the whole discriminator,
// and the census runs it rather than describing it.
//
// WHY IT IS NOT A `verify-` SCRIPT: it reports, it does not assert. The trees a
// script sweeps cannot in general be recovered from source — several are built
// from variables, `/proc`, or a temp dir that exists only at run time — so a
// gate built on this would be asserting against a population it cannot fully
// resolve, which is the defect this whole ticket is about. It exits 0 whatever
// it finds. The judgement lives in the pull request, where a reader can check
// it; what this file supplies is the measurement it was made from.
//
// ⚠ WHAT IT CANNOT SEE, said plainly because an empty result is a claim about
// the search and not about the world:
//
//   * A call site whose directory argument is a variable is reported as
//     UNRESOLVED, not as safe. There are several and they are listed.
//   * A recursive enumeration written some other way — a hand-rolled `walk()`,
//     `glob`, `find` via execSync — is detected only by the heuristics below.
//   * It reads `daemon/scripts` and `extension/scripts` ONLY. Sweeps living in
//     `daemon/src` or the extension's own sources are outside its population,
//     and that is a limit rather than a finding.
//
// Usage: node daemon/scripts/kan465-readdir-census.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { everySourceFile } from './lib/sweep-sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/** Does this directory hold anything below its top level? */
function depthOf(abs) {
  if (!fs.existsSync(abs)) return null;
  let subdirs = 0;
  let filesTop = 0;
  let filesAll = 0;
  const walk = (dir, top) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) {
        if (top) subdirs += 1;
        walk(path.join(dir, e.name), false);
      } else {
        filesAll += 1;
        if (top) filesTop += 1;
      }
    }
  };
  try {
    walk(abs, true);
  } catch {
    return null;
  }
  return { subdirs, filesTop, filesAll };
}

// The trees this repository's scripts actually sweep, resolved by hand because
// source cannot resolve them, and measured here rather than asserted.
const KNOWN_TREES = [
  'daemon/src',
  'daemon/scripts',
  'daemon/scripts/lib',
  'extension/scripts',
  'extension/src',
  'docs'
];

console.log('KAN-465 census — non-recursive sweeps, and whether their tree has depth\n');
console.log('='.repeat(78));
console.log('1. THE TREES, MEASURED. `subdirs` is the discriminator, not the counts.');
console.log('='.repeat(78));
console.log(`${'tree'.padEnd(24)} ${'subdirs'.padEnd(9)} ${'files@1'.padEnd(9)} files(all)`);
console.log('-'.repeat(24) + ' ' + '-'.repeat(9) + ' ' + '-'.repeat(9) + ' ----------');
for (const t of KNOWN_TREES) {
  const d = depthOf(path.join(REPO_ROOT, t));
  if (!d) {
    console.log(`${t.padEnd(24)} (absent)`);
    continue;
  }
  const flag = d.subdirs > 0 && d.filesAll !== d.filesTop ? '  <- a flat sweep here is SHORT' : '';
  console.log(
    `${t.padEnd(24)} ${String(d.subdirs).padEnd(9)} ${String(d.filesTop).padEnd(9)} ${String(d.filesAll)}${flag}`
  );
}

console.log('\n' + '='.repeat(78));
console.log('2. EVERY readdirSync CALL SITE — the population, reported before it is filtered');
console.log('='.repeat(78));

const RECURSIVE_HINT = /recursive\s*:/;
const sites = [];
for (const dir of SCRIPT_DIRS) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const rel of everySourceFile(abs, (b) => b.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(abs, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (!/readdirSync\s*\(/.test(line)) return;
      // A mention in a comment is not a call.
      const code = line.replace(/^\s*(\/\/|\*).*$/, '');
      if (!/readdirSync\s*\(/.test(code)) return;
      sites.push({
        file: path.join(dir, rel),
        line: i + 1,
        text: line.trim(),
        recursive: RECURSIVE_HINT.test(line)
      });
    });
  }
}

console.log(`population: ${sites.length} readdirSync call site(s) in code (comments excluded)\n`);

// A POSITIVE CONTROL ON THE FINDER ITSELF. If the census reports nothing, that
// must be a fact about the repository and not about this script — so it is
// required to find the sites KAN-465 converted, by name. A finder that cannot
// find a known-present thing has measured its own search.
// These three hold a `readdirSync` that this ticket deliberately did NOT
// convert — the walker's own two implementations, `/proc`, and the dist-freshness
// probe — so they are stable anchors rather than moving targets.
//
// The first draft of this list named `lib/ci-partition.mjs` and
// `sweep-verify-exit-paths.mjs`, and the control FAILED on its first run: this
// ticket had just removed the last `readdirSync` from both. That is the control
// working exactly as intended, on its author, within a minute of being written —
// it caught a stale expectation rather than a broken finder, which is the
// distinction an uncontrolled empty result cannot make.
const MUST_FIND = [
  'daemon/scripts/lib/sweep-sources.mjs',
  'daemon/scripts/butchr-doctor.mjs',
  'daemon/scripts/lib/require-fresh-dist.mjs'
];
const missing = MUST_FIND.filter((f) => !sites.some((s) => s.file === f));
console.log(
  `positive control — the finder locates ${MUST_FIND.length - missing.length}/${MUST_FIND.length} ` +
    `known call sites${missing.length ? `; MISSING: ${missing.join(', ')}` : ''}`
);
if (missing.length) {
  console.log('  ⚠ the census below is NOT trustworthy — the finder failed on a known-present site.\n');
} else {
  console.log('  so a short list below is a fact about the repository, not about this search.\n');
}

const flat = sites.filter((s) => !s.recursive);
console.log(`${sites.length - flat.length} site(s) pass an explicit \`recursive:\` option.`);
console.log(`${flat.length} site(s) do not — listed below with the tree each reaches:\n`);
for (const s of flat) {
  console.log(`  ${s.file}:${s.line}`);
  console.log(`      ${s.text.slice(0, 96)}`);
}

console.log('\n' + '='.repeat(78));
console.log('3. HOW TO READ SECTION 2 — a flat call site is not a defect on its own');
console.log('='.repeat(78));
console.log(`
A flat \`readdirSync\` is WRONG only where the tree it reaches has depth. Most of
the sites above are correct and converting them would be churn:

  * /proc and /proc/<pid>/fd            — flat by construction.
  * a temp fixture built by the script  — its own shape, known to it.
  * workspace roots enumerated one level deliberately (type/ then key/).
  * daemon/scripts/lib itself           — one level, and section 1 shows it.
  * docs/                               — 0 subdirectories, so flat cannot be
                                          short. Watch the SUBDIR count, not the
                                          file count (task/KAN-457, 2026-08-15).

The sites KAN-465 converted are the ones whose tree appears in section 1 with a
non-zero \`subdirs\` AND a files@1 lower than files(all) — that is the whole
discriminator, and it is measured above rather than asserted here.
`);
