#!/usr/bin/env node
// KAN-262: the dependency sharing a workspace is supposed to get, asserted on
// the real store rather than described.
//
// WHAT FAILURE THIS WOULD CATCH: a workspace whose `node_modules` is a private
// copy of a tree the store already holds — the pre-2026-08-10 world, where 119
// workspaces each ran their own `npm install` for an identical lockfile and
// `~/.local/share/butchr/workspaces` reached 15G, of which one task workspace
// was 296M and the agent's own state was twelve kilobytes. It would equally
// catch the sharing being lost later: a `cp` that quietly drops its `-l`, a
// helper that falls back to `npm install` when the store is missing, or a store
// entry rebuilt per workspace because the key stopped matching. All three look
// exactly like success — the build goes green either way, which is why this is
// asserted on inode identity and not on whether anything works.
//
// AND THE SECOND HALF, WHICH IS THE ONE WITH TEETH: that sharing has not been
// bought by making a workspace able to damage something outside it. Section 3
// asserts no symlink in the tree leaves the workspace (so `rm -rf node_modules`
// cannot reach the store or the shared clone — the shape that empties a shared
// tree for every agent at once), and section 4 asserts store files are
// read-only, because a hard link is the same inode and an in-place write in one
// workspace otherwise reaches every workspace sharing it. That is measured, not
// feared: on 2026-08-10, before the store was made read-only, appending one
// line to `typescript/package.json` inside a workspace changed the store file's
// md5 from 4dc17c6a… to 8181a383… with no error anywhere.
//
// THIS SCRIPT BUILDS THE WORKSPACES IT THEN ASSERTS ON, AND THAT IS A REAL
// LIMIT — stated here rather than left for the reader to notice, per the
// KAN-145 lesson that a proof supplying its own input has not tested that the
// input arrives. What is covered below is that the *mechanism* shares storage
// and contains deletion. What is NOT covered is that a real agent ever runs it:
// this script calls `linkInto` directly, so a `prompts/task.md` that stopped
// telling agents to link their deps would leave every assertion here green
// while every new workspace went back to a private 296M copy.
//
// WHO COVERS THAT: `daemon/scripts/verify-operative-rules-are-carried.mjs`,
// rule H-15, which asserts the linking step is present in `prompts/task.md` —
// and it is a required check, so it is the half of this that CI enforces.
// `prompts/task.md` alone is the right scope and not an oversight: a story
// agent is told to read the shared clone directly and that it "need no worktree
// of your own" (`prompts/story.md`), and `prompts/epic.md` has no repository
// setup at all, so neither ever installs a dependency tree.
//
// Between the two scripts there is still a gap neither owns: that an agent
// which *reads* the instruction follows it. Nothing covers that today; do not
// read these two scripts as covering it together.
//
// HOW TO WATCH IT GO RED — section 1 does it on every run, deliberately, rather
// than living in a comment that rots. It makes a genuine private copy (`cp -a`,
// the same operation with `-l` removed) of a real store package and asserts the
// sharing check *reports it unshared*. If sharing were removed from the helper,
// section 2 would fail in exactly the way section 1 demonstrates. For the whole
// mechanism, delete the `-l` from `linkInto` in link-workspace-deps.mjs and
// re-run: section 2 goes red and the exit code follows.
//
// USAGE
//   node daemon/scripts/verify-workspace-deps-are-shared.mjs [--verbose]
// Needs a built store; builds one from this repo's lockfiles if absent.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STORE_ROOT,
  assertNoOutwardSymlinks,
  buildStoreEntry,
  linkInto,
  storeKey,
} from './link-workspace-deps.mjs'

const verbose = process.argv.includes('--verbose')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let failures = 0
const fail = (section, msg) => {
  failures++
  console.error(`  FAIL [${section}] ${msg}`)
}
const pass = (section, msg) => console.log(`  ok   [${section}] ${msg}`)
const vlog = (...a) => {
  if (verbose) console.log(...a)
}

/**
 * How much of `dir` shares inodes with the corresponding file under
 * `storeDir`. This is the whole assertion of the ticket expressed as a number:
 * a hard-linked tree scores 1, a private copy scores 0. Sampling rather than
 * walking every file keeps a run cheap; the sample is deterministic (sorted)
 * so a failure is reproducible.
 */
function sharedFraction(dir, storeDir, limit = 200) {
  const files = []
  const walk = (d) => {
    if (files.length >= limit) return
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= limit) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) files.push(p)
    }
  }
  walk(dir)

  let shared = 0
  for (const f of files) {
    const rel = path.relative(dir, f)
    const counterpart = path.join(storeDir, rel)
    try {
      if (fs.statSync(f).ino === fs.statSync(counterpart).ino) shared++
    } catch {
      /* missing counterpart counts as unshared */
    }
  }
  return { shared, total: files.length, fraction: files.length ? shared / files.length : 0 }
}

/** The smallest package directory in the store — the cheapest honest sample. */
function smallestPackage(storeNodeModules) {
  const candidates = fs
    .readdirSync(storeNodeModules, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@'))
    .map((e) => path.join(storeNodeModules, e.name))
  let best = null
  for (const c of candidates) {
    try {
      const n = execFileSync('find', [c, '-type', 'f'], { encoding: 'utf8' }).split('\n').length
      if (!best || n < best.n) best = { dir: c, n }
    } catch {
      /* ignore */
    }
  }
  return best?.dir ?? candidates[0]
}

function main() {
  console.log('verify-workspace-deps-are-shared')

  // Resolve a store entry for this repo's daemon lockfile, building it if the
  // machine has none yet.
  const pkgDir = path.join(repoRoot, 'daemon')
  const lockPath = path.join(pkgDir, 'package-lock.json')
  if (!fs.existsSync(lockPath)) {
    console.error(`no lockfile at ${lockPath}`)
    process.exit(2) // setup guard, not a verdict
  }
  const key = storeKey('daemon', lockPath)
  const storeDir = path.join(STORE_ROOT, key)
  if (!fs.existsSync(storeDir)) {
    console.log(`  store entry absent; building ${key}`)
    buildStoreEntry('daemon', key, pkgDir)
  }
  const storeNodeModules = path.join(storeDir, 'node_modules')
  console.log(`  store: ${storeDir}`)

  // Scratch lives beside the store, never in `os.tmpdir()`. A hard link cannot
  // cross a filesystem, and `/tmp` is a separate one (often tmpfs) on plenty of
  // machines — there, `cp -al` fails with EXDEV and this script would report a
  // sharing failure that is really a failure to test sharing. On the machine
  // this was written on the two happen to share a device, which is exactly the
  // kind of accident that makes a script pass everywhere it is tried and break
  // on the first host that differs.
  const scratch = fs.mkdtempSync(path.join(STORE_ROOT, '.verify-scratch-'))

  try {
    const samplePkg = smallestPackage(storeNodeModules)
    vlog(`  sample package: ${samplePkg}`)

    // ---- 1. NEGATIVE CONTROL — the sharing check must be able to say "no".
    // A private copy is `cp -a`: byte-identical content, brand new inodes. This
    // is the pre-change world reproduced with the real tree, and if the check
    // called it shared, every green below would be worthless.
    const copied = path.join(scratch, 'private-copy')
    execFileSync('cp', ['-a', samplePkg, copied])
    const neg = sharedFraction(copied, samplePkg)
    if (neg.fraction === 0) {
      pass('1 negative control', `a private copy scores 0/${neg.total} shared — the check can go red`)
    } else {
      fail(
        '1 negative control',
        `a private copy scored ${neg.shared}/${neg.total} shared; the sharing check is vacuous`
      )
    }

    // ---- 2. THE PROPERTY BOUGHT — a linked workspace shares storage.
    const ws = path.join(scratch, 'workspace', 'daemon')
    fs.mkdirSync(ws, { recursive: true })
    linkInto(storeDir, ws)
    const linked = path.join(ws, 'node_modules')
    const pos = sharedFraction(linked, storeNodeModules)
    if (pos.fraction === 1) {
      pass('2 sharing', `linked workspace shares ${pos.shared}/${pos.total} sampled files with the store`)
    } else {
      fail('2 sharing', `linked workspace shares only ${pos.shared}/${pos.total} sampled files`)
    }

    // Link count > 1 is the same fact from the other side, and it is what makes
    // a reclaimer's `rm -rf` cheap and safe rather than destructive.
    const probe = path.join(linked, 'typescript', 'package.json')
    if (fs.existsSync(probe)) {
      const links = fs.statSync(probe).nlink
      if (links > 1) pass('2 sharing', `sampled file has ${links} links — store still references it`)
      else fail('2 sharing', `sampled file has ${links} link; nothing else references it`)
    }

    // ---- 3. DELETION CANNOT ESCAPE THE WORKSPACE.
    const offenders = assertNoOutwardSymlinks(linked, path.join(scratch, 'workspace'))
    if (offenders.length === 0) {
      pass('3 containment', 'no symlink in the tree points outside the workspace')
    } else {
      fail('3 containment', `${offenders.length} symlink(s) escape the workspace, e.g. ${offenders[0]}`)
    }

    // ---- 4. AN IN-PLACE WRITE CANNOT REACH THE STORE.
    // The workspace file and the store file are one inode, so this is the only
    // thing standing between one agent's stray edit and every other agent's
    // dependency tree.
    const target = fs.existsSync(probe) ? probe : null
    if (!target) {
      fail('4 read-only store', 'could not find a sampled file to probe')
    } else {
      // The probe is destructive if it succeeds, so take a byte-exact backup
      // first. It is a file copy rather than a buffer held in memory because
      // the repair below has to put the original back even if this process is
      // interrupted between the two.
      const backup = path.join(scratch, 'probe-backup')
      fs.copyFileSync(target, backup)
      const before = fs.readFileSync(target)
      let refused = false
      try {
        fs.appendFileSync(target, '\n// KAN-262 in-place write probe\n')
      } catch (err) {
        refused = err.code === 'EACCES' || err.code === 'EPERM'
      }
      const after = fs.readFileSync(target)
      if (refused && after.equals(before)) {
        pass('4 read-only store', 'in-place write refused (EACCES); store content unchanged')
      } else if (!after.equals(before)) {
        // Repair before reporting: leaving a corrupted store behind would be a
        // worse outcome than the failure being reported.
        try {
          fs.chmodSync(target, 0o644)
          fs.copyFileSync(backup, target)
          execFileSync('chmod', ['a-w', target])
        } catch {
          /* reported below regardless */
        }
        fail('4 read-only store', 'an in-place write reached the store (content changed); repaired')
      } else {
        fail('4 read-only store', 'write was not refused, though content did not change')
      }
    }
  } finally {
    // The scratch trees are hard links into the store; removing them frees
    // almost nothing and cannot damage it, which is the reclaimer contract
    // being exercised rather than asserted.
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  console.log(failures ? `\nFAILED (${failures})` : '\nPASSED')
  process.exit(failures ? 1 : 0)
}

main()
