#!/usr/bin/env node
//
// WHAT FAILURE THIS WOULD CATCH: a hand-written `.mjs` stub of
// `AgentRuntime.spawnSession` whose positional parameter list has drifted from
// the interface, so that every argument past the drift point lands in the wrong
// hole AT RUNTIME, in JavaScript, with no compiler anywhere in the loop.
//
// It has happened TWICE on this seam in two days, both times by an insertion in
// the middle of the list:
//
//   KAN-482 inserted `priority` 5th. The stubs were updated by hand and
//           `verify-agent-power-controls.mjs` was given a comment saying so.
//   KAN-492 inserted `supervisor` 6th. THE COMMENT DID NOT PREVENT IT — a
//           warning living in the file that gets shifted cannot reach the person
//           editing a different file. `verify-agent-power-controls` and
//           `verify-agent-preemption` went red in CI on assertions about
//           stand-downs and preemption, which have nothing to do with either
//           ticket: `resume` was being read off `mcpServers`.
//
// The required parameter protects every TYPESCRIPT call site — omission is a
// compile error, and `daemon/typecheck/agent-runtime-stub.ts` pins that for a
// third runtime. This script exists because that protection is blind to `.mjs`,
// which is the population that actually broke. `epic/KAN-39` asked, reviewing
// #215, what stops the ninth insertion doing this again. This does.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE, AND WHY IT IS A PREFIX RULE RATHER THAN AN EQUALITY
//
// A stub MAY declare fewer parameters than the interface: `(type, key, url)` is
// a perfectly correct stub for a script that only needs the address, and JS
// simply drops the rest. What it may NOT do is declare a DIFFERENT NAME at a
// position the interface has already spoken for — that is the drift, and it is
// exactly what an insertion produces.
//
// So: the stub's parameter list must be a POSITION-BY-POSITION PREFIX of the
// interface's. Stopping early is fine. Renaming or reordering is not.
//
// ⚠ THIS IS WHAT SEPARATES THE TWO BROKEN STUBS FROM THE SIX SOUND ONES, and
// the distinction is not cosmetic. Reviewing #215, `epic/KAN-39` read the eight
// stubs as eight breakages and reported six of them as "green while feeding
// their stub arguments in the wrong slots". Measured, they are not: four
// declare `()` and read no argument at all, and two declare `(type, key, url)`,
// which an insertion at position 6 cannot move. A stub that never reads past
// position 3 HAS no wrong slot. The concern was right, the count was not, and
// the reason to write this as an instrument rather than an argument is that a
// count nobody can re-run is how the disagreement recurs.
//
// ─────────────────────────────────────────────────────────────────────────────
// CI-RUNNABLE: yes — reads `daemon/src/agent-runtime.ts` and the `.mjs` files as
// TEXT; no build, no socket, no peer, no credential, no network. Unaffected by a
// failed build, so its verdict is about what you wrote rather than what last
// compiled.
//
// WHAT THIS SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// The interface's parameter list is READ from `agent-runtime.ts` rather than
// written down here, so this cannot go green against a list it invented. What
// it does NOT cover, named rather than left to be inferred:
//
//   (a) Stubs of the OTHER seam methods. Only `spawnSession` is checked. It is
//       the only member with a long positional list — the rest take three
//       parameters or fewer, where an insertion has nowhere to hide — and both
//       incidents were this method. A stub of `tailAgent` that drifted would
//       not be caught here. WHO COVERS IT: nobody. Stated so no reader infers
//       a coverage that does not exist.
//   (b) That a stub's BEHAVIOUR mirrors the real implementation. This is about
//       argument positions only. A stub with a perfect parameter list that
//       returns the wrong shape is `verify-agent-preemption.mjs`'s own note
//       about `ResumedConversation`, and no arity check reaches it.
//   (c) `.mjs` outside `daemon/scripts`. The search root is printed at run time
//       so the reader can see what was actually swept.
//
// ─────────────────────────────────────────────────────────────────────────────
// RED DRIVE — restore one stub to its pre-KAN-492 arity and watch it go red.
//
// ⚠ The restore below is a `sed` and not a `git checkout` DELIBERATELY. This was
// driven red while the stub fixes were still uncommitted, where a `git checkout`
// restores from the INDEX and would have discarded them — the same trap
// `verify-crabcast-supervisor-exemption.mjs` warns about from the other side.
// A `sed` back is correct whether or not you have committed.
//
//   sed -i 's/priority, supervisor, defaultAgent/priority, defaultAgent/' \
//       daemon/scripts/verify-agent-power-controls.mjs
//   grep -n 'spawnSession: (type' daemon/scripts/verify-agent-power-controls.mjs  # ASSERT THE EDIT TOOK
//   node daemon/scripts/verify-mjs-stub-arity-matches-seam.mjs
//   sed -i 's/priority, defaultAgent/priority, supervisor, defaultAgent/' \
//       daemon/scripts/verify-agent-power-controls.mjs
//
// Watched failing on 2026-08-16 before this script was trusted. The red names
// the position, both spellings and the file:line:
//
//   FAIL  verify-agent-power-controls.mjs:172 is a positional prefix of the seam
//         position 6 declares `defaultAgent` where the seam says `supervisor`.
//         Every argument from position 6 on lands in the wrong hole at runtime.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const seamFile = path.join(repoRoot, 'daemon', 'src', 'agent-runtime.ts');
const scriptsDir = path.join(repoRoot, 'daemon', 'scripts');

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

let failures = 0;
function check(ok, what, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
  }
  return ok;
}

// ───────────────────────────────────────────────────────────────────────────
rule('§1  THE SEAM IS THE SOURCE OF TRUTH — read, never written down here');
// ───────────────────────────────────────────────────────────────────────────

const seamSrc = fs.readFileSync(seamFile, 'utf8');
const sig = seamSrc.match(/ {2}spawnSession\(([\s\S]*?)\n {2}\): HerdrSession;/);

if (!check(Boolean(sig), "the interface's spawnSession signature is findable in agent-runtime.ts")) {
  console.log('\nCannot proceed: with no signature there is nothing to compare against, and');
  console.log('a green here would mean "I checked nothing" rather than "everything matches".');
  process.exit(1);
}

/** `priority: number,` -> `priority`. Order is the whole point, so keep it. */
const seamParams = [...sig[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]);

console.log(`  seam: spawnSession(${seamParams.join(', ')})`);
console.log(`  that is ${seamParams.length} positional parameters.\n`);

// The positive control for the extraction itself. If the regex above matched
// nothing, or matched one stray thing, every comparison below would be
// vacuously satisfiable and this script would be green while checking nothing.
check(
  seamParams.length >= 5,
  `the parameter list parsed to something plausible (${seamParams.length} names)`,
  `parsed: ${seamParams.join(', ') || '(nothing)'}`
);
check(
  seamParams[0] === 'type' && seamParams[1] === 'key',
  'and it starts where the interface starts — `type`, `key`',
  `parsed: ${seamParams.join(', ')}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('§2  EVERY `.mjs` STUB OF IT IS A POSITIONAL PREFIX OF THAT LIST');
// ───────────────────────────────────────────────────────────────────────────
// Fewer parameters is fine — a stub that needs only the address stops at 3.
// A DIFFERENT NAME at a position the seam has spoken for is the drift.

console.log(`  swept: ${path.relative(repoRoot, scriptsDir)}/*.mjs\n`);

// This file is excluded from its own sweep, and that is a real exclusion rather
// than tidiness: the pattern below appears in this script AS A PATTERN, so a
// self-inclusive sweep reads its own regex literal as a one-parameter stub named
// `...` and reports itself DRIFTED. Named here because a silent self-exclusion
// is how a sweep quietly stops covering something.
const selfBasename = path.basename(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.mjs') && f !== selfBasename)
  .sort();

const stubs = [];
for (const file of files) {
  const full = path.join(scriptsDir, file);
  const text = fs.readFileSync(full, 'utf8');
  // `spawnSession:` followed by a parenthesised parameter list and an arrow.
  // Comments mentioning it in prose do not match, because they carry no `(...)  =>`.
  for (const m of text.matchAll(/spawnSession:\s*\(([^)]*)\)\s*=>/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    const params = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    stubs.push({ file, line, params });
  }
}

// THE POSITIVE CONTROL FOR THE SWEEP, and §2 is worth nothing without it. A
// regex that matched no file would leave the loop below with nothing to say and
// this script would report success — the "empty result is a claim about your
// search" trap, in the one place it would be least visible.
check(
  stubs.length > 0,
  `the sweep found stubs to check at all (${stubs.length} found)`,
  'no `spawnSession: (...) =>` matched anywhere. Either the stubs moved, or this ' +
    "script's pattern has rotted and it is now checking nothing while reporting green."
);

console.log(`  ${'file'.padEnd(46)} line  params  verdict`);
for (const stub of stubs) {
  const bad = stub.params.findIndex((p, i) => p !== seamParams[i]);
  stub.ok = bad === -1 && stub.params.length <= seamParams.length;
  stub.badAt = bad;
  console.log(
    `  ${stub.file.padEnd(46)} ${String(stub.line).padStart(4)}  ${String(stub.params.length).padStart(6)}  ${stub.ok ? 'prefix' : 'DRIFTED'}`
  );
}
console.log('');

for (const stub of stubs) {
  check(
    stub.ok,
    `${stub.file}:${stub.line} is a positional prefix of the seam`,
    stub.badAt >= 0
      ? `position ${stub.badAt + 1} declares \`${stub.params[stub.badAt]}\` where the seam says ` +
        `\`${seamParams[stub.badAt] ?? '(nothing — the stub is LONGER than the interface)'}\`.\n` +
        `stub: (${stub.params.join(', ')})\n` +
        `seam: (${seamParams.join(', ')})\n` +
        `Every argument from position ${stub.badAt + 1} on lands in the wrong hole at runtime.`
      : `the stub declares ${stub.params.length} parameters where the seam has ${seamParams.length}.`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§3  WHAT A SOUND STUB LOOKS LIKE — so "prefix" is not taken for "unchecked"');
// ───────────────────────────────────────────────────────────────────────────
// The distinction this script exists to make precise. A short stub is not a
// lucky stub: it cannot be shifted by an insertion past where it stops reading.

const short = stubs.filter((s) => s.params.length <= 3);
const long = stubs.filter((s) => s.params.length > 3);
console.log(
  `  ${short.length} stub(s) read position 3 or earlier — an insertion after that cannot reach them.`
);
console.log(`  ${long.length} stub(s) read further and are the ones an insertion can shift.\n`);
for (const s of short) console.log(`    short: ${s.file} (${s.params.length} params)`);
for (const s of long) console.log(`    long:  ${s.file} (${s.params.length} params)`);
console.log('');

check(
  short.every((s) => s.ok) && long.every((s) => s.ok),
  'both populations are sound — the short ones by construction, the long ones by matching',
  `drifted: ${stubs
    .filter((s) => !s.ok)
    .map((s) => s.file)
    .join(', ')}`
);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`);
console.log(
  failures
    ? `RED — ${failures} assertion(s) failed. A stub's arguments are in the wrong holes.`
    : `GREEN — every assertion passed. ${stubs.length} stub(s) checked against the seam.`
);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
