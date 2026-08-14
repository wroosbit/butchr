#!/usr/bin/env node
// KAN-266: `link-workspace-deps.mjs` must link a repo whose lockfile is at its
// root, and must not report having linked nothing as success.
//
// WHAT FAILURE THIS WOULD CATCH: the script silently no-opping on a repo shape
// it does not recognise and exiting 0 — the defect this ticket was filed for.
// `const PACKAGES = ['daemon', 'extension']` was hard-coded, so on CrabCast
// (one root package, lockfile at the repo root) both entries missed, both skips
// were logged only under `--verbose`, `failures` stayed 0 and the script exited
// 0 having linked nothing. It could not distinguish "linked everything" from
// "found nothing to link": both were exit 0 and both were silent at default
// verbosity. Three agents hit it over four days, each hand-rolled the link, and
// the failure mode when they did not was a silent private `node_modules` — the
// exact cost the store exists to remove. It would equally catch the fix being
// lost later: discovery narrowed back to a fixed list, the root shape dropped,
// or the zero-package verdict softened back to an exit 0.
//
// AND THE SECOND DEFECT, WHICH IS INDEPENDENT OF THE FIRST: a repo whose root
// manifest builds itself on install cannot have a store entry built at all. The
// store temp dir holds two manifests and no `src`, so CrabCast's
// `"prepare": "npm run build"` ran `tsc` against an empty directory and took
// `npm ci` down with it. Section 4 reproduces that end to end and asserts the
// entry now builds; it is the section that fails if the lifecycle strip is
// removed from `buildStoreEntry`.
//
// CI-RUNNABLE: yes — builds every fixture in a temporary directory, runs `npm
// ci` only against a hand-written zero-dependency lockfile (no network), and
// reads `prompts/task.md` off the checkout. Node builtins plus `npm` and `cp`.
//
// HOW TO WATCH IT GO RED. Sections 1 and 5 carry their own negative controls
// and run them on every invocation, so a vacuous pass is visible rather than
// inferred: section 1 asserts discovery returns *nothing* for a repo that has
// no lockfile (if it returned something, every positive below would be
// worthless), and section 5 asserts the real script exits non-zero there. For
// the mechanism, any one of these reproduces a genuine red:
//   - restore `const PACKAGES = ['daemon', 'extension']` and index off it:
//     sections 2 and 5 go red (the root shape vanishes, and a lockfile-less
//     repo goes back to exiting 0).
//   - delete the `delete manifest.scripts` line in `buildStoreEntry`:
//     section 4 goes red with npm's own `command sh -c npm run build`.
//   - change the zero-package branch in `main()` back to falling through to
//     `process.exit(failures ? 1 : 0)`: section 5 goes red.
//   - revert the `prompts/task.md` bullet to `node daemon/scripts/…`:
//     section 6 goes red.
//
// THIS SCRIPT BUILDS THE FIXTURES IT THEN ASSERTS ON, AND THAT IS A REAL LIMIT,
// stated here rather than left to be noticed (the KAN-145 lesson: a proof that
// supplies its own input has not tested that the input arrives). The fixtures
// are synthetic reproductions of two real repo shapes — they are not CrabCast.
// What is covered below is that the *mechanism* handles both shapes and refuses
// to call a no-op a success. What is NOT covered is that CrabCast specifically
// still has the shape section 2 models: if it grew a `daemon/` subdirectory
// tomorrow, every assertion here would stay green and say nothing about it.
//
// WHO COVERS THE REST, precisely, because two honest scripts can still leave a
// hole between them:
//   - That `prompts/task.md` names the step at all: rule H-15 in
//     `verify-operative-rules-are-carried.mjs`, a required check. H-15 asserts
//     the *filename* appears; it does not read the path for correctness, which
//     is why the ENOENT survived it. Section 6 below is that missing half, and
//     it is deliberately here rather than added as an H-rule phrase: it is an
//     assertion about a path resolving, not about a rule being carried.
//   - That the linked tree actually shares inodes and cannot damage the store:
//     `verify-workspace-deps-are-shared.mjs`. This script asserts *which*
//     packages get linked; that one asserts what linking is worth.
//   - That a real agent in a real CrabCast worktree runs it and it works:
//     NOBODY covers that today, and the honest statement is that it is
//     unobserved rather than passing. Do not read these three scripts as
//     covering it together.
//
// USAGE
//   node daemon/scripts/verify-dep-linking-covers-every-repo-shape.mjs [--verbose]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const verbose = process.argv.includes('--verbose')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const linkScript = path.join(scriptDir, 'link-workspace-deps.mjs')

// Both the fake store and every fixture workspace live under ONE temp root, so
// `cp -al` never has to cross a filesystem. That is not incidental: a hard link
// cannot span devices, and a store in `/tmp` with a workspace elsewhere fails
// with EXDEV and reports a linking failure that is really a failure to test
// linking.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan266-'))
const storeRoot = path.join(scratch, 'store')

// SET BEFORE THE IMPORT, AND THE ORDER IS LOad-BEARING. `STORE_ROOT` is a
// module-level const read at import time, so a `process.env` assignment after a
// static import would be ignored and `buildStoreEntry` below would publish its
// fixture entries into the REAL store on this machine. A dynamic import after
// the assignment is what keeps this script's writes inside its own temp dir;
// section 0 asserts that rather than trusting it.
process.env.BUTCHR_DEP_STORE = storeRoot
const { STORE_ROOT, buildStoreEntry, discoverPackages, storeKey } = await import('./link-workspace-deps.mjs')

let failures = 0
const fail = (section, msg) => {
  failures++
  console.error(`  FAIL [${section}] ${msg}`)
}
const pass = (section, msg) => console.log(`  ok   [${section}] ${msg}`)
const vlog = (...a) => {
  if (verbose) console.log(...a)
}

/** A minimal lockfile with no dependencies — installable offline. */
const emptyLock = (name) =>
  `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name, version: '1.0.0' } },
    },
    null,
    2
  )}\n`

function writePackage(dir, { name, scripts }) {
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { name, version: '1.0.0' }
  if (scripts) manifest.scripts = scripts
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'package-lock.json'), emptyLock(name))
}

/** Run the real link script as a subprocess, capturing its verdict honestly. */
function runLinkScript(repoDir, storeRoot) {
  try {
    const stdout = execFileSync('node', [linkScript, '--repo', repoDir, '--verbose'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BUTCHR_DEP_STORE: storeRoot },
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    }
  }
}

function main() {
  console.log('verify-dep-linking-covers-every-repo-shape')

  try {
    // ---- 0. THIS SCRIPT'S WRITES CANNOT REACH THE REAL STORE.
    // Asserted rather than assumed, because getting it wrong is silent: section
    // 4 publishes a fixture entry, and if the override had not taken effect it
    // would land in the store every agent on this machine shares.
    if (STORE_ROOT === storeRoot) {
      pass('0 isolation', 'the store override took effect; fixture entries stay in the temp dir')
    } else {
      fail('0 isolation', `STORE_ROOT is ${STORE_ROOT}, not the fixture store — refusing to trust section 4`)
    }

    // ---- 1. NEGATIVE CONTROL — discovery must be able to find nothing.
    // If this found a package in a repo that has none, every positive result
    // below would be meaningless. It runs first and on every invocation.
    const barren = path.join(scratch, 'barren')
    fs.mkdirSync(path.join(barren, 'src'), { recursive: true })
    fs.mkdirSync(path.join(barren, '.git'))
    fs.writeFileSync(path.join(barren, 'README.md'), 'no lockfile here\n')
    const none = discoverPackages(barren)
    if (none.length === 0) {
      pass('1 negative control', 'a repo with no lockfile discovers 0 packages — discovery can say no')
    } else {
      fail('1 negative control', `discovered ${none.length} package(s) in a repo with no lockfile: ${none.map((p) => p.name).join(', ')}`)
    }

    // ---- 2. THE ROOT SHAPE — CrabCast. This is the shape the hard-coded list
    // could not see at all.
    const rootRepo = path.join(scratch, 'rootshape')
    fs.mkdirSync(path.join(rootRepo, '.git'), { recursive: true })
    writePackage(rootRepo, { name: 'crabcast-fixture', scripts: { prepare: 'npm run build', build: 'tsc' } })
    fs.mkdirSync(path.join(rootRepo, 'src'), { recursive: true })
    const rootPkgs = discoverPackages(rootRepo)
    if (rootPkgs.length === 1 && rootPkgs[0].dir === rootRepo) {
      pass('2 root shape', `a root-lockfile repo discovers 1 package (${rootPkgs[0].name})`)
    } else {
      fail('2 root shape', `expected exactly 1 package at the repo root, got ${rootPkgs.length}: ${JSON.stringify(rootPkgs.map((p) => p.name))}`)
    }
    // The name comes from the MANIFEST, not the directory, so two worktrees of
    // the same repo produce the same store key and actually share.
    if (rootPkgs[0]?.name === 'crabcast-fixture') {
      pass('2 root shape', 'the root package is keyed on its manifest name, not the worktree directory')
      const otherWorktree = path.join(scratch, 'a-differently-named-checkout')
      fs.mkdirSync(path.join(otherWorktree, '.git'), { recursive: true })
      writePackage(otherWorktree, { name: 'crabcast-fixture', scripts: { prepare: 'npm run build' } })
      const a = storeKey(rootPkgs[0].name, path.join(rootRepo, 'package-lock.json'))
      const b = storeKey(discoverPackages(otherWorktree)[0].name, path.join(otherWorktree, 'package-lock.json'))
      if (a === b) pass('2 root shape', `two differently-named worktrees share one store key (${a})`)
      else fail('2 root shape', `worktree name leaked into the store key: ${a} vs ${b}`)
    } else {
      fail('2 root shape', `root package named ${rootPkgs[0]?.name}, expected the manifest name`)
    }

    // ---- 3. THE SUBDIRECTORY SHAPE — butchr, asserted on the REAL repo rather
    // than a fixture, because the thing worth protecting is that this change
    // did not move the two store keys every machine already holds.
    const real = discoverPackages(repoRoot)
    const names = real.map((p) => p.name).sort()
    if (names.length === 2 && names[0] === 'daemon' && names[1] === 'extension') {
      pass('3 subdirectory shape', `this repo still discovers exactly: ${names.join(', ')}`)
    } else {
      fail('3 subdirectory shape', `expected daemon+extension in ${repoRoot}, got ${JSON.stringify(names)}`)
    }
    // `daemon`'s manifest is named `@butchr/daemon`. Keying subdirectories on
    // the manifest name would have silently orphaned every existing entry, so
    // the directory name is asserted rather than assumed.
    const daemonLock = path.join(repoRoot, 'daemon', 'package-lock.json')
    if (fs.existsSync(daemonLock)) {
      const key = storeKey('daemon', daemonLock)
      const found = real.find((p) => p.dir === path.join(repoRoot, 'daemon'))
      if (found && storeKey(found.name, daemonLock) === key) {
        pass('3 subdirectory shape', `the daemon store key is unchanged by this refactor (${key})`)
      } else {
        fail('3 subdirectory shape', `the daemon store key moved: discovery names it ${found?.name}`)
      }
    }

    // ---- 4. A ROOT `prepare` NO LONGER BREAKS THE STORE BUILD.
    // The fixture's `prepare` is `exit 1`: if the lifecycle strip were removed,
    // `npm ci` inside the store temp dir runs it and dies, exactly as
    // CrabCast's `tsc` did against a directory holding no `src`.
    //
    // THIS CALLS `buildStoreEntry` DIRECTLY RATHER THAN THE CLI, and the reason
    // is worth stating because it looks like a shortcut and is not. The fixture
    // has ZERO dependencies so that `npm ci` needs no network — and `npm ci`
    // creates no `node_modules` at all for an empty tree, so `linkInto` cannot
    // run and the CLI exits 1 on a fixture artefact rather than on the defect.
    // `buildStoreEntry` is exactly the function the defect lived in, so that is
    // what is exercised. (That the CLI refuses an empty store entry is correct
    // behaviour, not a bug this hides: a repo with nothing to link should say
    // so rather than report success — the same principle as section 5.)
    // Section 5 runs the real CLI end to end, so the binary is not untested.
    const lifecycle = path.join(scratch, 'lifecycle')
    fs.mkdirSync(path.join(lifecycle, '.git'), { recursive: true })
    writePackage(lifecycle, {
      name: 'lifecycle-fixture',
      scripts: { prepare: 'exit 1', postbuild: 'exit 1' },
    })
    const lifecycleKey = storeKey('lifecycle-fixture', path.join(lifecycle, 'package-lock.json'))
    let entry = null
    try {
      buildStoreEntry('lifecycle-fixture', lifecycleKey, lifecycle)
      entry = lifecycleKey
      pass('4 root lifecycle', 'a store entry builds for a root package whose `prepare` would fail')
    } catch (err) {
      fail('4 root lifecycle', `buildStoreEntry died on a failing root \`prepare\`; the lifecycle strip is not working: ${err.message}`)
    }
    // The strip must not have touched the lockfile — the resolved tree and the
    // store key both derive from it, so a rewritten lockfile would silently
    // stop workspaces sharing.
    if (entry && fs.existsSync(path.join(storeRoot, entry))) {
      const storedLock = fs.readFileSync(path.join(storeRoot, entry, 'package-lock.json'), 'utf8')
      const sourceLock = fs.readFileSync(path.join(lifecycle, 'package-lock.json'), 'utf8')
      if (storedLock === sourceLock) pass('4 root lifecycle', 'the lockfile reached the store byte-for-byte')
      else fail('4 root lifecycle', 'the store lockfile differs from the source lockfile')

      const storedManifest = JSON.parse(fs.readFileSync(path.join(storeRoot, entry, 'package.json'), 'utf8'))
      if (!storedManifest.scripts) {
        pass('4 root lifecycle', 'the store manifest carries no lifecycle scripts')
      } else {
        fail('4 root lifecycle', `the store manifest still carries scripts: ${Object.keys(storedManifest.scripts).join(', ')}`)
      }
    } else {
      // Reached when buildStoreEntry threw above. This branch must REPORT
      // rather than crash: it is the path a real regression takes, and an
      // exception here would replace the verdict with a stack trace. Caught by
      // the red drive on 2026-08-14, which is the whole argument for running
      // one — the mutation went red for the right reason and this branch threw
      // `ReferenceError: entries is not defined` on its way out.
      const held = fs.existsSync(storeRoot)
        ? fs.readdirSync(storeRoot).filter((n) => !n.startsWith('.'))
        : []
      fail('4 root lifecycle', `no store entry was published; store held: ${JSON.stringify(held)}`)
    }

    // ---- 5. FINDING NOTHING IS A FAILURE. The heart of the ticket: the old
    // code reached `process.exit(failures ? 1 : 0)` with `failures` at 0 here.
    const empty = runLinkScript(barren, storeRoot)
    vlog(empty.out)
    if (empty.code !== 0) {
      pass('5 no-op is not success', `a repo with no lockfile exits ${empty.code}, not 0`)
    } else {
      fail('5 no-op is not success', 'the script exited 0 having linked nothing — the KAN-266 defect is back')
    }
    if (/no package-lock\.json found/i.test(empty.out) && /private copy/i.test(empty.out)) {
      pass('5 no-op is not success', 'it says what went wrong and what the consequence is, at default verbosity')
    } else {
      fail('5 no-op is not success', 'the failure is silent about what was not linked or why it matters')
    }

    // ---- 6. THE INSTRUCTION AGENTS ACTUALLY FOLLOW RESOLVES OUTSIDE BUTCHR.
    // Reads the prompt as text, so this section is unaffected by a failed build
    // and its verdict is always about the working tree.
    const promptPath = path.join(repoRoot, 'prompts', 'task.md')
    const prompt = fs.readFileSync(promptPath, 'utf8')
    const invocations = [...prompt.matchAll(/^\s*(?:node|\$)?\s*(\S*link-workspace-deps\.mjs)/gm)].map((m) => m[1])
    if (invocations.length === 0) {
      fail('6 prompt path', 'prompts/task.md gives no runnable invocation of link-workspace-deps.mjs')
    } else if (invocations.every((p) => p.startsWith('~/') || path.isAbsolute(p))) {
      pass('6 prompt path', `every invocation is an absolute path: ${[...new Set(invocations)].join(', ')}`)
    } else {
      fail(
        '6 prompt path',
        `a repo-relative invocation is ENOENT outside butchr: ${invocations.filter((p) => !p.startsWith('~/') && !path.isAbsolute(p)).join(', ')}`
      )
    }
  } finally {
    // The scratch trees are hard links into a throwaway store; removing them
    // cannot reach the real one, which lives outside this directory entirely.
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  console.log(failures ? `\nFAILED (${failures})` : '\nPASSED')
  process.exit(failures ? 1 : 0)
}

main()
