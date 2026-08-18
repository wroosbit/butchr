// KAN-531: build output committed under `daemon/` or `extension/` is a red
// required check, and the rule that decides is an allowlist of where source
// lives rather than an enumeration of what output is called.
//
// WHAT FAILURE THIS WOULD CATCH: PR #232 (KAN-516) as it stood on 2026-08-18 —
// two complete compiled daemon trees, `daemon/dist-kan343-nohealth-3287848/`
// and `daemon/dist-kan343-unscoped-3287848/`, 130 files and 81,309 lines of
// emitted JavaScript, added to the repository with EVERY required check green:
// `approval-gate`, `ci-partition`, `daemon-typecheck`, `extension-build`,
// `operative-rule-carriage`, `verify-runnable-set`, `verify-script-sweep`.
// Nothing in the gate had an opinion about it. `.gitignore` was the only thing
// standing anywhere near this defect, and `.gitignore` is not a check: it does
// not run in CI, it says nothing about what is already tracked, and `git add -f`
// walks past it without comment.
//
// CI-RUNNABLE: yes — reads `git ls-files` off the checkout and the bytes of the
// files it names, and builds its fixtures under `os.tmpdir()`; node builtins and
// `git` only, no build, no daemon, no herdr, no credential, no peer, no network,
// no terminal, no wall clock.
//
// ---------------------------------------------------------------------------
// WHY AN ALLOWLIST, WHICH IS THE WHOLE DESIGN
// ---------------------------------------------------------------------------
// The escape had a root cause and it was not carelessness. `.gitignore`
// enumerated scratch build directories one ticket at a time — `dist-unfixed/`,
// `dist-guardless-*/`, `dist-kan342-red-*/` — so `dist-kan343-*` was missing for
// the only reason such a line is ever missing: nobody had got to it yet. An
// enumeration of what output is CALLED requires every future author to extend
// it, and fails silently and hugely when one does not.
//
// So this check never asks what a directory is called. It asks whether a
// directory holding JavaScript has been DECLARED as a place source lives. The
// two lists differ in the direction they fail:
//
//   * a denylist of output names is unbounded, and forgetting an entry is
//     SILENT — 81,309 lines through seven green checks;
//   * an allowlist of source locations is small, bounded and rarely edited, and
//     forgetting an entry is LOUD — a red naming the exact path, one line to
//     declare with a reason a reviewer reads.
//
// That is why §2 exists and is the acceptance criterion that matters: a check
// keyed on the directory names that exist today would reproduce the enumeration
// defect in a new place. §2 drives it red on a name nobody has ever used.
//
// ---------------------------------------------------------------------------
// WHAT IT SUPPLIES ITSELF, AND WHO COVERS THE REST (KAN-145)
// ---------------------------------------------------------------------------
// §1 supplies nothing: it scans the real checkout, and it is the leg that
// actually gates a pull request. §§2-6 DO supply their own input — they build
// repository-shaped fixtures under `os.tmpdir()` and scan those — so on their
// own they establish only that the detector CAN report, never that it is
// pointed at anything. Two things cover that gap, and they are named here
// rather than left to be inferred:
//
//   * §1 runs the same entry point against the real tree, so the detector is
//     demonstrably reading this repository and not only a fixture.
//   * §7 asserts `ci.yml` invokes this script, by reading `ci.yml` off the
//     checkout — the leg that makes §1 run on every pull request rather than
//     when somebody remembers.
//
// What NOTHING here covers, stated plainly because the reader would otherwise
// infer it: nobody re-checks that the required-check list in branch protection
// still contains the jobs §7 finds. That is a GitHub setting an agent cannot
// read or write. See "WHAT THIS GATE DOES NOT COVER" below.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE DOES NOT COVER — named, because a partial gate that reads as
// total is the defect this epic keeps re-finding
// ---------------------------------------------------------------------------
//   1. NON-JAVASCRIPT OUTPUT. §§1-3 govern JavaScript-family files. A build
//      that emits only `.html`, `.css`, `.png` or `.wasm` into an undeclared
//      directory is invisible to them. The `.d.ts` / `.map` / `.tsbuildinfo`
//      leg (§4) is repository-wide and catches the TypeScript sidecars, and
//      that is the whole of the non-JS coverage.
//   2. AN AUTHOR WHO EDITS THE ALLOWLIST. Declaring `daemon/dist-whatever` in
//      the table below turns this check green for that directory. That is not
//      a hole to be plugged — it is the point of an allowlist. What changes is
//      that landing artefacts now requires a visible, reviewable edit to a list
//      of source locations with a reason attached, rather than the absence of a
//      line nobody was ever going to notice.
//   3. `git add -f` IS COVERED, and it is worth saying so because the ignore
//      rule's own weakness invites the opposite assumption. This check reads
//      the TRACKED set, so how a file got tracked is irrelevant to it. Force-add
//      it, name the directory something the ignore rule never heard of, do
//      both — §1 still sees it. `.gitignore` is a convenience for the author;
//      this is the check.
//   4. OUTPUT OUTSIDE `daemon/` AND `extension/`. The governed roots are the
//      two packages that have builds. A compiled tree dropped in `prompts/` or
//      at the repository root is caught only if it carries a §4 sidecar.
//   5. IT SAYS NOTHING ABOUT `dist/` ITSELF BEING BUILDABLE OR FRESH. Whether a
//      build is stale is a different question with different instruments; see
//      the `dist` older than `src` rule in `prompts/task.md`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// ===========================================================================
// THE RULE
// ===========================================================================

// The two packages that have a build, and therefore the two that can emit into
// the tree. Everything below is scoped to these except §4, which is repo-wide.
const GOVERNED_ROOTS = ['daemon', 'extension'];

// WHERE HAND-WRITTEN JAVASCRIPT LIVES. One entry per directory, matched
// EXACTLY — not as a prefix. `daemon/scripts` being declared does NOT declare
// `daemon/scripts/dist-x`, which is what stops a scratch tree being parked one
// level inside a source directory.
//
// Adding a directory here is a normal, small change. Write the reason: the
// reason is what a reviewer checks, and it is the only thing separating "a new
// source directory" from "the artefact tree this check exists to refuse".
const DECLARED_JS_DIRECTORIES = new Map([
  ['daemon/bin', 'the Chrome native-messaging shim, hand-written and shipped as-is'],
  ['daemon/scripts', 'the verify/sweep/harness scripts, hand-written .mjs'],
  ['daemon/scripts/lib', 'shared helpers for those scripts'],
  ['extension/scripts', 'the extension render and harness scripts, hand-written .mjs'],
  ['extension/public/background', 'the service worker, copied verbatim into the build'],
  ['extension/src/components', 'React components, hand-written .jsx'],
  ['extension/src/hooks', 'React hooks, hand-written .js'],
  ['extension/src/lib', 'extension helpers, hand-written .js']
]);

// The extension's entry points sit at the package root, where a directory rule
// would declare the whole of `extension/` and let a build output land beside
// them. So they are declared one file at a time.
const DECLARED_JS_FILES = new Map([
  ['extension/agents.jsx', 'entry point for the agents page'],
  ['extension/options.jsx', 'entry point for the options page'],
  ['extension/sidepanel.jsx', 'entry point for the side panel'],
  ['extension/vite.config.js', 'the build config itself']
]);

const JS_SUFFIXES = ['.js', '.cjs', '.mjs', '.jsx'];

// Files a hand nearly never writes and a compiler nearly always does. Checked
// across the WHOLE repository rather than the two governed roots: zero are
// tracked anywhere today, so the leg costs nothing and covers the case where
// output lands outside `daemon/` and `extension/`.
//
// `.map` rather than `.js.map` and `.css.map`, because listing the flavours is
// the enumeration mistake in miniature: the first draft of this line listed
// both and let `verify-thing.mjs.map` through, which §4 caught.
const EMIT_SIDECAR_SUFFIXES = ['.d.ts', '.map', '.tsbuildinfo'];

// Fingerprints of machine emission, for output smuggled INTO a declared
// directory under a source-shaped name. Both are anchored to the start of a
// line, which is where a compiler puts them and is also what keeps this file
// from matching itself: the patterns appear here indented and inside regex
// literals, so neither can occur at a line start in this script.
const EMIT_FINGERPRINTS = [
  { name: 'a source-map trailer', re: /^\/\/#\s*sourceMappingURL=/m },
  { name: 'the tsc CommonJS __esModule preamble', re: /^Object\.defineProperty\(exports, "__esModule"/m }
];

function hasSuffix(file, suffixes) {
  return suffixes.some((s) => file.endsWith(s));
}

function trackedFiles(repoRoot) {
  const res = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  if (res.status !== 0) {
    // Deliberately not a silent empty list. An unreadable index means the check
    // did not run, and "no findings" would be indistinguishable from a clean
    // tree — the exact shape of an empty result that is a claim about the
    // search rather than about the world.
    throw new Error(`git ls-files failed in ${repoRoot}: ${res.stderr || res.error}`);
  }
  return res.stdout.split('\0').filter((f) => f.length > 0);
}

/**
 * Scan one repository's TRACKED files for committed build output.
 *
 * Returns a list of findings, each naming the path, the leg that fired and why.
 * The same entry point serves §1 (the real checkout) and every fixture below,
 * so a fixture exercises the code that actually gates a pull request.
 */
function scanRepository(repoRoot) {
  const findings = [];
  for (const file of trackedFiles(repoRoot)) {
    const root = file.split('/')[0];
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';

    if (hasSuffix(file, EMIT_SIDECAR_SUFFIXES)) {
      findings.push({
        file,
        leg: 'emit-sidecar',
        why: 'a compiler sidecar (declaration, source map or build info) is tracked'
      });
      continue;
    }

    if (!GOVERNED_ROOTS.includes(root)) continue;
    if (!hasSuffix(file, JS_SUFFIXES)) continue;

    const declared = DECLARED_JS_DIRECTORIES.has(dir) || DECLARED_JS_FILES.has(file);
    if (!declared) {
      findings.push({
        file,
        leg: 'undeclared-location',
        why: `\`${dir}\` is not a declared source directory, so JavaScript in it is presumed build output`
      });
      continue;
    }

    const body = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const fp of EMIT_FINGERPRINTS) {
      if (fp.re.test(body)) {
        findings.push({
          file,
          leg: 'emit-fingerprint',
          why: `carries ${fp.name}, so it is emitted rather than written`
        });
        break;
      }
    }
  }
  return findings;
}

function describe(findings) {
  return findings.map((f) => `${f.file}  [${f.leg}] ${f.why}`).join('\n');
}

// ===========================================================================
// FIXTURES
// ===========================================================================
//
// One helper for every write, deliberately: `sweep-verify-exit-paths.mjs`
// counts `writeFileSync(` call sites to tell a shim's exits from a script's own
// control flow, and scattering them makes this file's real verdict exit read as
// a shim. See the same note in `verify-ci-partition-is-enforced.mjs`.
function writeFixtureFile(repoRoot, relative, body) {
  const full = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

const fixtureRoots = [];

/**
 * A repository-shaped git repo holding the source files this project really
 * has, so every fixture starts from a tree this check calls clean.
 */
function makeFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kan531-${label}-`));
  fixtureRoots.push(root);
  const init = spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  writeFixtureFile(root, 'daemon/src/router.ts', 'export const router = 1;\n');
  writeFixtureFile(root, 'daemon/scripts/verify-thing.mjs', 'process.exit(0);\n');
  writeFixtureFile(root, 'daemon/bin/native-host.js', 'module.exports = {};\n');
  writeFixtureFile(root, 'extension/sidepanel.jsx', 'export const Panel = () => null;\n');
  writeFixtureFile(root, 'extension/src/lib/guardian.js', 'export const guardian = 1;\n');
  return root;
}

function trackFixture(root, extraArgs) {
  const args = ['-C', root, 'add'].concat(extraArgs).concat(['.']);
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git add failed in ${root}: ${res.stderr}`);
}

// A compiled daemon module, in the shape the escaped trees actually held: the
// project emits ESM with comments preserved and NO source map, which is exactly
// why a content sniffer alone would not have caught KAN-516.
const COMPILED_ROUTER = 'export const router = 1;\n';

// ===========================================================================
rule('1. THE REAL CHECKOUT IS CLEAN — the leg that gates a pull request');
// ===========================================================================
//
// No fixture. This scans the tracked set of the repository this script is in,
// and it is what a red on a pull request means. Everything below establishes
// that this scan is capable of reporting; this establishes what it reports
// about the tree in front of it.

const liveFindings = scanRepository(REPO_ROOT);
check(
  liveFindings.length === 0,
  'no tracked file under daemon/ or extension/ is build output',
  liveFindings.length === 0
    ? `scanned ${trackedFiles(REPO_ROOT).length} tracked paths at ${REPO_ROOT}`
    : `build output is committed:\n${describe(liveFindings)}\n\nIf one of these is genuinely hand-written source in a new location, declare\nits directory in DECLARED_JS_DIRECTORIES with the reason. If it is build\noutput, remove it: \`git rm -r --cached <dir>\`.`
);

// The instrument named, per this project's standing rule that an empty result
// is a claim about the search. A scan that read nothing would also report no
// findings, and would look identical to the line above.
check(
  trackedFiles(REPO_ROOT).length > 0,
  'the scan read a non-empty tracked set, so its emptiness is about the tree',
  `${trackedFiles(REPO_ROOT).length} tracked paths`
);

// ===========================================================================
rule('2. A DIRECTORY NAME NOBODY HAS EVER USED — the discriminating arm');
// ===========================================================================
//
// THIS IS THE ACCEPTANCE CRITERION THAT MATTERS. A check keyed on the names in
// `.gitignore` today — `dist`, `dist-unfixed`, `dist-guardless-*`,
// `dist-kan342-red-*`, `dist-kan343-*` — would have caught KAN-516 and would
// reproduce the enumeration defect in a new place the moment somebody named an
// output directory something else.
//
// So the fixture uses a name with no `dist` in it at all, which has never
// appeared in this repository, in `.gitignore`, or in any ticket: `out-2029-quux`.
// It is refused for one reason only — nobody declared it as a place source lives.

const novel = makeFixture('novel-name');
writeFixtureFile(novel, 'daemon/out-2029-quux/router.js', COMPILED_ROUTER);
writeFixtureFile(novel, 'daemon/out-2029-quux/notify.js', COMPILED_ROUTER);
trackFixture(novel, []);

const novelFindings = scanRepository(novel);
check(
  novelFindings.length === 2,
  'a directory name never seen in this repository is refused',
  describe(novelFindings)
);
check(
  novelFindings.every((f) => f.leg === 'undeclared-location'),
  'and it is refused for being undeclared, not for being called anything',
  `legs: ${[...new Set(novelFindings.map((f) => f.leg))].join(', ')}`
);
check(
  !JSON.stringify([...DECLARED_JS_DIRECTORIES.keys()]).includes('dist'),
  'the rule contains no output name at all — nothing in it says `dist`',
  `declared directories: ${[...DECLARED_JS_DIRECTORIES.keys()].join(', ')}`
);

// A second novel name, under `extension/` and one level inside a directory that
// IS declared. `extension/scripts` being a source directory must not declare
// `extension/scripts/anything-else`, or a scratch tree parked one level in
// walks through.
const nested = makeFixture('nested');
writeFixtureFile(nested, 'extension/scripts/bundle-tmp-77/sidepanel.js', COMPILED_ROUTER);
trackFixture(nested, []);
const nestedFindings = scanRepository(nested);
check(
  nestedFindings.length === 1 && nestedFindings[0].leg === 'undeclared-location',
  'a declared directory does not declare its subdirectories',
  describe(nestedFindings)
);

// ===========================================================================
rule('3. THE HISTORICAL ESCAPE — and that .gitignore would not have stopped it');
// ===========================================================================
//
// The real thing, by its real name: the two `dist-kan343-*` trees PR #232 added
// under seven green required checks.
//
// The second half is the one worth watching. The fixture carries the CURRENT
// `.gitignore` glob — `dist-*/`, which does match these names — and the files
// are tracked anyway, with `git add -f`. That is not a contrived move: it is
// how the file gets tracked whenever the ignore rule was added AFTER a `git add
// -A` had already swept the tree in, which `.gitignore`'s own comment records
// happening three times. The ignore rule cannot see a file that is already
// tracked; this check reads the tracked set, so it does not care how it got
// there.

const historical = makeFixture('kan516');
writeFixtureFile(historical, '.gitignore', 'node_modules/\ndist/\ndist-*/\n');
writeFixtureFile(historical, 'daemon/dist-kan343-nohealth-3287848/router.js', COMPILED_ROUTER);
writeFixtureFile(historical, 'daemon/dist-kan343-unscoped-3287848/router.js', COMPILED_ROUTER);
trackFixture(historical, ['-f']);

const escapedPath = 'daemon/dist-kan343-nohealth-3287848/router.js';
const patternMatches = spawnSync(
  'git',
  ['-C', historical, 'check-ignore', '--no-index', '-v', escapedPath],
  { encoding: 'utf8' }
);
check(
  patternMatches.status === 0,
  '.gitignore DOES match these paths — so the ignore rule is not what fails here',
  `git check-ignore --no-index -v: ${patternMatches.stdout.trim()}`
);

// And the half that is the point, measured rather than argued. WITHOUT
// `--no-index`, `git check-ignore` declines to report a path that is in the
// index at all — so the moment a file is tracked, the ignore rule has nothing
// to say about it and no amount of correcting `.gitignore` will remove it.
// That is the same exit code an unmatched path gives, which is why the two
// checks are here as a pair rather than one alone.
const asTracked = spawnSync('git', ['-C', historical, 'check-ignore', escapedPath], {
  encoding: 'utf8'
});
check(
  asTracked.status === 1 && asTracked.stdout.trim() === '',
  'yet against the index it reports nothing, because the file is already tracked',
  `git check-ignore exit ${asTracked.status}, no output — the ignore rule is out of the picture`
);

const historicalFindings = scanRepository(historical);
check(
  historicalFindings.length === 2,
  'and the check refuses them anyway, because they are tracked',
  describe(historicalFindings)
);

// ===========================================================================
rule('4. COMPILER SIDECARS — repository-wide, not only the governed roots');
// ===========================================================================
//
// `.d.ts`, `.js.map`, `.d.ts.map` and `.tsbuildinfo` are tracked nowhere in this
// repository today (measured: `git ls-files | grep -E '\\.(d\\.ts|map|tsbuildinfo)$'`
// returns nothing). They are what a build configured with `declaration` or
// `sourceMap` leaves behind, and they are caught wherever they land — including
// inside `daemon/src`, where the location leg would never look.

const sidecars = makeFixture('sidecars');
writeFixtureFile(sidecars, 'daemon/src/router.d.ts', 'export declare const router: number;\n');
writeFixtureFile(sidecars, 'daemon/scripts/verify-thing.mjs.map', '{"version":3}\n');
writeFixtureFile(sidecars, 'prompts/somewhere.js.map', '{"version":3}\n');
trackFixture(sidecars, []);

const sidecarFindings = scanRepository(sidecars);
check(
  sidecarFindings.filter((f) => f.leg === 'emit-sidecar').length === 3,
  'declarations, source maps and build info are refused wherever they are',
  describe(sidecarFindings)
);
check(
  sidecarFindings.some((f) => f.file.startsWith('prompts/')),
  'including outside daemon/ and extension/, which the location leg does not reach',
  describe(sidecarFindings.filter((f) => f.file.startsWith('prompts/')))
);

// ===========================================================================
rule('5. EMITTED CODE INSIDE A DECLARED DIRECTORY');
// ===========================================================================
//
// The location leg trusts a declared directory, so a bundle dropped into one
// under a source-shaped name would pass it. Two line-anchored fingerprints
// close the common half of that: a source-map trailer, and the CommonJS
// preamble tsc emits.
//
// THE LIMIT IS REAL AND IS NOT COVERED. This project's daemon build emits ESM
// with neither marker — that is why §3's fixture content is indistinguishable
// from source, and why the location leg rather than this one is what would have
// caught KAN-516. This leg is a second net, not the net.

const smuggled = makeFixture('smuggled');
writeFixtureFile(
  smuggled,
  'daemon/scripts/helper-bundle.js',
  'var x = 1;\n//# sourceMappingURL=helper-bundle.js.map\n'
);
writeFixtureFile(
  smuggled,
  'extension/src/lib/vendor.js',
  '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n'
);
trackFixture(smuggled, []);

const smuggledFindings = scanRepository(smuggled);
check(
  smuggledFindings.filter((f) => f.leg === 'emit-fingerprint').length === 2,
  'emitted code in a DECLARED directory is caught by its fingerprint',
  describe(smuggledFindings)
);

// This script names both fingerprints in its own text. If they were not
// line-anchored it would match itself, and §1 would be red for the wrong
// reason — a check that fails on its own existence.
const selfBody = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
check(
  EMIT_FINGERPRINTS.every((fp) => !fp.re.test(selfBody)),
  'and the fingerprints do not match this script, which quotes both of them',
  'anchored to line start; the patterns appear here indented and inside regex literals'
);

// ===========================================================================
rule('6. POSITIVE CONTROL — the fixture harness can print green');
// ===========================================================================
//
// Every section above asserts that a fixture goes RED. If `scanRepository`
// reported findings for any tree at all, all five would pass and the check
// would be worthless. A clean fixture — the same source files, no artefacts —
// must come back with nothing.

const clean = makeFixture('clean');
trackFixture(clean, []);
const cleanFindings = scanRepository(clean);
check(
  cleanFindings.length === 0,
  'a fixture holding only declared source produces no findings',
  `${trackedFiles(clean).length} tracked paths, 0 findings`
);
check(
  trackedFiles(clean).length >= 5,
  'and it was a non-empty tree, so the green is about the files rather than about an empty scan',
  `${trackedFiles(clean).length} tracked paths`
);

// ===========================================================================
rule('7. CI RUNS IT — the leg the fixtures cannot supply');
// ===========================================================================
//
// KAN-145's rule: a proof that supplies its own input has not tested that the
// input arrives. Sections 2-6 build their own trees, so they say nothing about
// whether anything scans THIS repository on a pull request. This section reads
// `ci.yml` off the checkout and asserts the wiring is there.
//
// TWO wirings, deliberately, and the second is what makes it gate on the day it
// lands. `verify-script-sweep` is a required check that installs nothing and
// builds nothing, so naming this script there puts it behind a gate immediately
// and keeps it out from behind a build. The `CI-RUNNABLE: yes` header ALSO puts
// it in `run-ci-verify-set.mjs`'s discovered set, which the required
// `verify-runnable-set` job runs — so the guard survives either wiring being
// removed. Adding a NEW job would have named the failure better and gated
// nothing: a new job is not a required check until somebody with admin edits
// branch protection, which is not an agent's to do (KAN-527 records the same
// reasoning for the same reason).

const ciPath = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const ciLines = fs
  .readFileSync(ciPath, 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'));

check(
  ciLines.some((l) => l.includes('daemon/scripts/verify-no-build-output-is-committed.mjs')),
  'ci.yml invokes this script directly, in a required job that needs no build',
  'no uncommented line of ci.yml names this script'
);
check(
  ciLines.some((l) => l.includes('daemon/scripts/run-ci-verify-set.mjs')),
  'and ci.yml invokes the runner, which discovers this script from its CI-RUNNABLE line',
  'no uncommented line of ci.yml names run-ci-verify-set.mjs'
);

// ===========================================================================

for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0 ? 'ALL SECTIONS PASS' : `${failures} CHECK(S) FAILED`);
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
