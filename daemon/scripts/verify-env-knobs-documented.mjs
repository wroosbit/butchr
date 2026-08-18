// KAN-534: a `BUTCHR_*` environment read cannot be added to `daemon/src`
// without a row in `docs/env-knobs.md`, and a row cannot outlive the read it
// describes.
//
// WHAT FAILURE THIS WOULD CATCH: a new `BUTCHR_*` environment variable being
// read by the daemon and documented nowhere — the condition this repository was
// in when KAN-534 was filed, with nine of the then-counted knobs written down
// in no document at all and the list having grown to that size without anyone
// deciding it should. It catches the reverse too: a row left behind for a knob
// whose read has been deleted, which is how `BUTCHR_WORKSPACE_TYPE` went on
// looking like a live control for the six days after KAN-145 removed it.
//
// CI-RUNNABLE: yes — reads `daemon/src/**/*.ts` and `docs/env-knobs.md` off the
// checkout and matches regexes; node builtins only, no build, no daemon, no
// herdr, no credential, no network, no terminal, no wall clock.
//
// WHAT COUNTS AS A READ, AND WHY IT IS NOT A BARE GREP
//
// KAN-534 was filed against a count of nineteen taken by grepping for the token
// `BUTCHR_[A-Z0-9_]+`. That matches an identifier, and four of the nineteen are
// identifiers that never reach `process.env`: a `unique symbol` type brand, two
// exported constants, and one knob whose env read had already been deleted. A
// check built on that grep would demand documentation for a TypeScript type
// brand and would call the resulting page complete.
//
// So a name is a knob here when it is used as an environment KEY:
//
//   * `process.env.X`, `env.X`                     — direct member access
//   * `process.env['X']`, `env['X']`               — direct index
//   * a string literal `'X'`                       — handed to a reader such as
//                                                    `envNumber('X')`, or held
//                                                    in a `*_ENV_VAR` constant
//                                                    and indexed through later
//
// The literal form is deliberately broad. Both indirections this repository
// actually uses — `envNumber(name)` in capacity.ts and the `*_ENV_VAR`
// constants in runtime-switch.ts, atlassian-proxy.ts and launchdarkly-proxy.ts
// — put the name in a string literal at some point, so matching the literal
// catches them without this script having to model the indirection. The cost is
// that a `BUTCHR_*` string literal that is NOT an env key would be demanded of
// the documentation; that is the safe direction, and §1 prints every hit with
// its file so a false demand is one read away from being seen.
//
// Comments are stripped before matching. Otherwise this file's own prose, and
// the comments in `herdr.ts` and `mcp.ts` that explain why
// `BUTCHR_WORKSPACE_TYPE` is gone, would each conjure a knob that does not
// exist — which is the same defect as the bare grep, arriving by a different
// route.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Section 3 builds a fixture file in `os.tmpdir()` and asserts the detector
// finds the knob in it. That is a proof supplying its own input, and it is
// stated here rather than left to be inferred:
//
//   * What §3 establishes is that the DETECTOR is directory-driven — a file no
//     list mentions, named nothing this script could know, is scanned and its
//     env read found. That is the mechanism, and it is genuinely tested.
//   * What §3 does NOT establish is that the real tree is scanned correctly.
//     §1 and §2 cover that: they read `daemon/src` and `docs/env-knobs.md` off
//     the checkout, so what they assert on is what a reviewer would find.
//   * WHO COVERS the remaining leg — that a knob's documented DEFAULT and
//     VALUES are true of the code — is nobody, and there is no check here that
//     could. This script guards that every knob is written down, never that
//     what is written down is right. `docs/env-knobs.md` says so in its own
//     closing section.
//
// Usage: node daemon/scripts/verify-env-knobs-documented.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const VERBOSE = process.argv.includes('--verbose');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC_DIR = path.join(REPO, 'daemon', 'src');
const DOC = path.join(REPO, 'docs', 'env-knobs.md');

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};
const ok = (msg) => {
  if (VERBOSE) console.log(`  ok: ${msg}`);
};

/** Block and line comments removed, so prose about a knob does not create one. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function tsFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

const KEY_PATTERNS = [
  /(?:process\.)?env\s*\.\s*(BUTCHR_[A-Z0-9_]+)/g,
  /(?:process\.)?env\s*\[\s*['"](BUTCHR_[A-Z0-9_]+)['"]\s*\]/g,
  /['"](BUTCHR_[A-Z0-9_]+)['"]/g
];

/** Every name used as an environment key, mapped to the files using it. */
function envKeysIn(files, rootForDisplay) {
  const found = new Map();
  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const pattern of KEY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const name = match[1];
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(path.relative(rootForDisplay, file));
      }
    }
  }
  return found;
}

/**
 * Every knob given a row in a table the document marks as a knob table.
 *
 * The marker is required rather than inferred. `env-knobs.md` also carries a
 * table of identifiers that are NOT knobs — the `unique symbol`, the two
 * constants, the removed read — and its rows have the same shape as a knob
 * row, so a parser that took every backticked first cell would read those four
 * as documented knobs and then report them as rows describing nothing. It did,
 * on the first run of this script. Marking the real tables is what tells the
 * two apart, and it fails safe: a knob table added without a marker leaves its
 * knobs undocumented as far as §2 is concerned, which is a red rather than a
 * silent pass.
 */
const KNOB_TABLE_MARKER = '<!-- knob-table -->';

function documentedKnobs(markdown) {
  const found = new Set();
  let inKnobTable = false;
  for (const line of markdown.split('\n')) {
    if (line.trim() === KNOB_TABLE_MARKER) {
      inKnobTable = true;
      continue;
    }
    // A table ends at the first line that is not one of its rows.
    if (inKnobTable && !line.trimStart().startsWith('|')) {
      inKnobTable = false;
      continue;
    }
    if (!inKnobTable) continue;
    const row = /^\|\s*`(BUTCHR_[A-Z0-9_]+)`\s*\|/.exec(line);
    if (row) found.add(row[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// §1 — what daemon/src actually reads
// ---------------------------------------------------------------------------
console.log('§1 Environment keys read by daemon/src');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`FATAL: ${SRC_DIR} does not exist — wrong repository layout.`);
  process.exit(2);
}

const sourceFiles = tsFilesUnder(SRC_DIR);
// A directory that yielded no files is a broken search, not an empty tree, and
// it would make every assertion below vacuously true.
if (sourceFiles.length === 0) {
  console.error(`FATAL: no .ts files under ${SRC_DIR} — the scan found nothing to read.`);
  process.exit(2);
}

const read = envKeysIn(sourceFiles, REPO);
console.log(`  ${sourceFiles.length} source files, ${read.size} environment keys read`);
if (VERBOSE) {
  for (const name of [...read.keys()].sort()) {
    console.log(`    ${name} — ${[...read.get(name)].sort().join(', ')}`);
  }
}
// Same reasoning as the file count: zero keys means the matcher broke, and
// every knob would then read as correctly documented.
if (read.size === 0) {
  console.error('FATAL: no BUTCHR_* environment keys found at all — the matcher is broken.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// §2 — the documentation agrees, in both directions
// ---------------------------------------------------------------------------
console.log('§2 docs/env-knobs.md covers exactly what is read');

if (!fs.existsSync(DOC)) {
  fail(`${path.relative(REPO, DOC)} does not exist — the knobs have no documented home.`);
} else {
  const documented = documentedKnobs(fs.readFileSync(DOC, 'utf8'));
  if (VERBOSE) console.log(`  ${documented.size} knobs have a row`);

  for (const name of [...read.keys()].sort()) {
    if (documented.has(name)) {
      ok(`${name} is documented`);
    } else {
      fail(
        `${name} is read by ${[...read.get(name)].sort().join(', ')} and has no row in ` +
          `docs/env-knobs.md. Add one — a knob nobody documented is a knob nobody can find.`
      );
    }
  }

  for (const name of [...documented].sort()) {
    if (read.has(name)) continue;
    fail(
      `${name} has a row in docs/env-knobs.md but nothing in daemon/src reads it as an ` +
        `environment key. Either the read was deleted and the row should go, or the row ` +
        `describes an identifier that was never a knob.`
    );
  }
}

// ---------------------------------------------------------------------------
// §3 — the detector is directory-driven, and comments do not conjure knobs
// ---------------------------------------------------------------------------
console.log('§3 The detector finds a knob it was never told about');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-knob-fixture-'));
try {
  const readFile = path.join(fixtureDir, 'a-file-no-list-mentions.ts');
  fs.writeFileSync(
    readFile,
    'export const v = process.env.BUTCHR_FIXTURE_DIRECT;\n' +
      "export const w = envNumber('BUTCHR_FIXTURE_LITERAL');\n"
  );
  const commentFile = path.join(fixtureDir, 'only-comments.ts');
  fs.writeFileSync(
    commentFile,
    '// BUTCHR_FIXTURE_IN_LINE_COMMENT is mentioned and not read.\n' +
      '/* BUTCHR_FIXTURE_IN_BLOCK_COMMENT likewise. */\n' +
      'export const unrelated = 1;\n'
  );

  const fixtureKeys = envKeysIn(tsFilesUnder(fixtureDir), fixtureDir);

  // KAN-535: these two loops were `.forEach(…)` rather than `for…of` to get a
  // `});` at the end of each, which balanced `sweep-verify-exit-paths.mjs`'s
  // opener/closer count and stopped it discarding this script's verdict exit
  // below. That was a coincidence standing in for a fix — the sweep no longer
  // counts, it masks, so the loops are written the way they read best.
  for (const expected of ['BUTCHR_FIXTURE_DIRECT', 'BUTCHR_FIXTURE_LITERAL']) {
    if (fixtureKeys.has(expected)) ok(`${expected} detected in a file nothing lists`);
    else fail(`${expected} was read in the fixture and the detector did not find it.`);
  }

  for (const absent of ['BUTCHR_FIXTURE_IN_LINE_COMMENT', 'BUTCHR_FIXTURE_IN_BLOCK_COMMENT']) {
    if (fixtureKeys.has(absent)) {
      fail(`${absent} appears only in a comment and the detector counted it as a read.`);
    } else {
      ok(`${absent} correctly not counted — comments are stripped`);
    }
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
