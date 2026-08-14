#!/usr/bin/env node
// KAN-262: install a workspace's dependencies as hard links into a shared
// store, so N worktrees cost roughly one copy instead of N.
//
// WHY THIS EXISTS. Every worktree ran its own `npm install` for an identical
// dependency tree. Measured 2026-08-10: 217 workspaces, 119 `node_modules`
// directories, 15G — the whole of `~/.local/share/butchr/workspaces`. One task
// workspace is 296M of which the agent's own state (brief, config, history) is
// twelve kilobytes. The trees were not merely similar: the three
// `package-lock.json` files under two workspaces and the shared clone had the
// same md5, and only the inodes differed.
//
// WHAT THIS IS, IN ONE LINE: `npm ci` once per (package, lockfile) into a store
// outside every workspace, then `cp -al` that tree into the workspace. The
// files in the workspace and the files in the store are *the same inodes*, so
// the second workspace to ask for a given lockfile costs directory entries and
// no file data.
//
// WHY HARD LINKS AND NOT A SYMLINK INTO THE SHARED CLONE. A symlinked
// `node_modules` pointing at `~/code/<org>/<repo>` is the shape that makes an
// ordinary `npm install` in a workspace write into the shared clone that every
// other agent is using — `prompts/task.md` already forbids `checkout` and
// `pull` there for that reason. It is also the shape that makes KAN-259's
// reclaimer dangerous: `rm -rf node_modules` through a symlink empties the
// store for everyone. Hard links have neither property. Removing a hard-linked
// tree decrements link counts and frees only what nothing else references, so
// a reclaimer needs no special case to be safe — see RECLAIMER CONTRACT below.
//
// WHY NOT pnpm. Evaluated and rejected on this repo; the reasoning and the
// measurements are on KAN-262. Short version: pnpm's strict layout is a
// different `node_modules` shape, and the win over `cp -al` here is
// cross-version content addressing that this repo — one lockfile per package,
// one arch, one node — does not have enough versions to collect. `cp -al`
// keeps the tree byte-for-byte the one npm produces, which is why the
// extension's `@launchpad-ui` tree needs no hoisting argument at all: it is not
// a different layout, it is the same layout sharing inodes.
//
// RECLAIMER CONTRACT — read this before writing anything that deletes
// `node_modules` (KAN-259, KAN-261). Three properties, and they are properties
// of where the store lives rather than promises this script makes:
//
//   1. The store lives at STORE_ROOT below, which is *outside*
//      `~/.local/share/butchr/workspaces`. A sweep rooted at `workspaces/`
//      cannot reach it. Do not add the store to such a sweep's roots.
//   2. A workspace's `node_modules` contains no symlink pointing out of the
//      workspace, so `rm -rf` cannot escape through one. This script asserts
//      that after every link (see assertNoOutwardSymlinks) rather than leaving
//      it as a claim.
//   3. Deleting a hard-linked tree is safe and frees almost nothing, because
//      the store still references the data. After this change, "bytes
//      recovered" stops being the number that says whether reclaiming worked —
//      `story/KAN-151` recorded that reconciliation and owns it.
//
// USAGE
//   node daemon/scripts/link-workspace-deps.mjs [--repo <dir>] [--verbose]
// Run from inside a worktree, or point --repo at one. Idempotent: a workspace
// that already has a tree for the current lockfile is left alone.
//
// THIS SCRIPT LIVES IN BUTCHR AND IS NOT BUTCHR-ONLY (KAN-266). It works on any
// repo this fleet checks out, and the two are reached differently:
//
//   - from a butchr worktree:   node daemon/scripts/link-workspace-deps.mjs
//   - from any other worktree:  node ~/code/wroosbit/butchr/daemon/scripts/link-workspace-deps.mjs
//
// The second line is not a nicety. `daemon/scripts/` is a butchr path, and a
// CrabCast worktree has `scripts/` and no `daemon/`, so an agent running the
// first form there gets ENOENT — which is exactly what `prompts/task.md`
// instructed until this change. `--repo` defaults to the current directory, so
// the absolute form needs no argument when run from inside the target worktree.

import { execFileSync } from 'node:child_process'
import {
  createHash,
} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The store sits beside `workspaces/`, not inside it. That placement is what
// makes property 1 of the reclaimer contract structural.
export const STORE_ROOT =
  process.env.BUTCHR_DEP_STORE ||
  path.join(os.homedir(), '.local', 'share', 'butchr', 'dep-store')

// KAN-266: packages are DISCOVERED, not listed. This was
// `const PACKAGES = ['daemon', 'extension']`, and the comment above it read
// "adding one here is all that is needed if the repo grows a third" — it
// anticipated a repo with *more* packages and not one with *fewer*. CrabCast is
// a single root package: its lockfile is at the repo root, both hard-coded
// entries missed, and the script logged two verbose-only skips and exited 0
// having linked nothing. Two agents hit that three days apart, each hand-rolled
// the link, and the workspace's next `npm install` silently took a private copy
// the step exists to prevent.
//
// SCOPE — the repo root and its immediate subdirectories, and no deeper. That
// is not a guess: at full depth, excluding `node_modules`, butchr carries
// exactly two lockfiles (`daemon/`, `extension/`) and CrabCast exactly one (the
// root), so root + depth 1 covers both repos this fleet works in completely.
// Going deeper would start matching lockfiles inside test fixtures, which are
// not packages a workspace wants linked.
const MAX_DEPTH = 1

/**
 * Every directory under `repoDir` that carries its own `package-lock.json`.
 *
 * THE NAME IS THE STORE KEY'S PREFIX, so it has to be stable across workspaces
 * — and the two cases earn different answers rather than one uniform rule:
 *
 *   - A SUBDIRECTORY uses its directory name. That is stable within the repo,
 *     and it is what keeps every store entry built before this change valid:
 *     `daemon`'s manifest is named `@butchr/daemon`, so switching to the
 *     manifest name here would have changed its key and orphaned the entries
 *     already on every machine.
 *   - THE ROOT uses its manifest's `name`, because the root's directory name is
 *     the *worktree's* name, which an agent chooses. Keying on it would give
 *     two CrabCast worktrees two different keys for one lockfile and defeat the
 *     sharing this script exists for. CrabCast's manifest says `crabcast`,
 *     which is the key `task/KAN-216` measured its scratch workaround produce.
 */
export function discoverPackages(repoDir) {
  const found = []
  const hasLock = (dir) => fs.existsSync(path.join(dir, 'package-lock.json'))
  const manifestName = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name || null
    } catch {
      return null
    }
  }

  if (hasLock(repoDir)) {
    // A scoped name (`@scope/thing`) would put a `/` in a store *path*, so it
    // is flattened rather than trusted into `path.join`.
    const name = (manifestName(repoDir) || path.basename(repoDir)).replace(/[^A-Za-z0-9._-]/g, '-')
    found.push({ name, dir: repoDir })
  }

  if (MAX_DEPTH >= 1) {
    // Sorted, so the order a workspace links in — and therefore the output a
    // reader compares between runs — is the same on every machine.
    const entries = fs
      .readdirSync(repoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      const dir = path.join(repoDir, e.name)
      if (hasLock(dir)) found.push({ name: e.name, dir })
    }
  }

  return found
}

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const repoFlag = argv.indexOf('--repo')
const repoDir = path.resolve(repoFlag === -1 ? process.cwd() : argv[repoFlag + 1])

const log = (...a) => console.log(...a)
const vlog = (...a) => {
  if (verbose) console.log(...a)
}

/**
 * The store key. A tree is reusable by another workspace exactly when it was
 * produced from the same lockfile by the same node on the same platform, so all
 * four go into the key. Node major matters because `node-pty` compiles a native
 * addon against the ABI; platform and arch matter for the same reason.
 */
export function storeKey(pkg, lockPath) {
  const lock = fs.readFileSync(lockPath)
  const h = createHash('sha256').update(lock).digest('hex').slice(0, 16)
  const abi = `${process.platform}-${process.arch}-node${process.versions.modules}`
  return `${pkg}-${abi}-${h}`
}

/**
 * Build a store entry. The install happens in a sibling temp directory and is
 * moved into place with a single rename, so a concurrent reader either sees no
 * entry or sees a complete one — never a half-installed tree. Two agents racing
 * to build the same key is fine: both install, both rename, the loser's tree is
 * discarded.
 *
 * `rename` is atomic only within a filesystem, which is why the temp directory
 * is created under STORE_ROOT rather than in /tmp.
 */
export function buildStoreEntry(pkg, key, pkgDir) {
  const finalDir = path.join(STORE_ROOT, key)
  fs.mkdirSync(STORE_ROOT, { recursive: true })
  const tmpDir = fs.mkdtempSync(path.join(STORE_ROOT, `.tmp-${key}-`))

  try {
    // Only the two manifests are copied in: `npm ci` needs nothing else, and
    // copying the source would put a stale copy of the repo in the store.
    fs.copyFileSync(path.join(pkgDir, 'package-lock.json'), path.join(tmpDir, 'package-lock.json'))

    // KAN-266: THE STORE HOLDS DEPENDENCIES, NEVER THIS REPO'S BUILD OUTPUT, so
    // the package's own lifecycle scripts are stripped from the copied manifest.
    // This is a deliberate decision rather than an inherited workaround, and the
    // reasoning is the line above: the temp dir holds two manifests and nothing
    // else — no `src`, no `tsconfig.json`, no `scripts/` — so a root lifecycle
    // script cannot do anything but fail there. CrabCast's root manifest carries
    // `"prepare": "npm run build"`, which runs `tsc` against that empty
    // directory, and the observed result was the whole store entry failing:
    //
    //   npm error command sh -c npm run build
    //   Error: Command failed: npm ci   at buildStoreEntry (…:123:5)
    //
    // WHAT THIS DOES NOT DO, because the distinction is the whole point:
    // dependencies' own install scripts still run. `npm ci --ignore-scripts`
    // would have been the wrong instrument — it would silently skip `node-pty`'s
    // native addon build and produce a store entry that links cleanly and
    // crashes at require time. What is suppressed is only *this* package's
    // lifecycle, which builds the repo rather than its dependency tree.
    //
    // The resolved tree and the store key are both untouched: `scripts` plays no
    // part in dependency resolution, and `storeKey` hashes the lockfile alone.
    // So an entry built this way is byte-identical to one built without the
    // strip, and remains shareable with every workspace on the same lockfile.
    // Neither butchr package has a `prepare`, so nothing about the existing two
    // entries changes.
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const stripped = Object.keys(manifest.scripts || {})
    delete manifest.scripts
    fs.writeFileSync(path.join(tmpDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (stripped.length) {
      vlog(`  ${pkg}: stripped ${stripped.length} lifecycle script(s) from the store manifest: ${stripped.join(', ')}`)
    }

    log(`  building store entry ${key} (npm ci) …`)
    execFileSync('npm', ['ci'], {
      cwd: tmpDir,
      stdio: verbose ? 'inherit' : ['ignore', 'ignore', 'inherit'],
    })

    // Every file in the store is made read-only, and this is load-bearing
    // rather than tidiness. A hard link is the same inode, so an *in-place*
    // write in one workspace reaches the store and therefore every other
    // workspace sharing it. Measured on 2026-08-10 before this line existed:
    // appending one line to `typescript/package.json` in a workspace changed
    // the store file's md5 from 4dc17c6a… to 8181a383…, silently, with no
    // error anywhere.
    //
    // Read-only files turn that silent corruption into EACCES at the moment of
    // the write. It does not stop a determined `chmod`, and it is not meant to
    // — it stops the accident, which is the failure that actually happens.
    //
    // ONLY FILES, NEVER DIRECTORIES, and the distinction is what keeps `npm
    // install` working. `cp -al` copies directory modes to the workspace, so a
    // read-only store directory would make the workspace's directory read-only
    // too, and npm replaces a package by unlinking and recreating it — which
    // needs write permission on the *directory* and none on the file. Files
    // read-only plus directories writable is exactly the combination where an
    // ordinary install succeeds and an in-place edit fails.
    execFileSync('find', [tmpDir, '-type', 'f', '-exec', 'chmod', 'a-w', '{}', '+'])

    // Atomic publish. If another agent won the race, keep theirs and drop ours:
    // the trees are equivalent by construction — same lockfile, same ABI.
    try {
      fs.renameSync(tmpDir, finalDir)
      vlog(`  published ${finalDir}`)
    } catch (err) {
      if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
        vlog(`  lost publish race for ${key}; using the existing entry`)
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } else {
        throw err
      }
    }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
  return finalDir
}

/**
 * Property 2 of the reclaimer contract, asserted rather than claimed: nothing
 * in the linked tree is a symlink that leaves the workspace. If one ever
 * appeared, `rm -rf node_modules` could delete through it, which is the exact
 * failure the store placement exists to prevent.
 */
export function assertNoOutwardSymlinks(root, workspaceRoot) {
  const offenders = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(p))
        if (!target.startsWith(workspaceRoot + path.sep)) offenders.push(`${p} -> ${target}`)
      } else if (e.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(root)
  return offenders
}

export function linkInto(storeDir, pkgDir) {
  const src = path.join(storeDir, 'node_modules')
  const dest = path.join(pkgDir, 'node_modules')
  if (!fs.existsSync(src)) throw new Error(`store entry has no node_modules: ${src}`)

  // `cp -al` recreates the directory tree and hard-links every file. Coreutils
  // is doing the work rather than a hand-rolled walk because it handles the
  // cases a walk gets wrong — symlinks inside the tree stay symlinks, modes and
  // timestamps are preserved, and it is an order of magnitude faster.
  execFileSync('cp', ['-al', src, dest])
  return dest
}

function main() {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.error(`not a git worktree: ${repoDir}`)
    process.exit(2)
  }

  log(`store: ${STORE_ROOT}`)
  log(`repo:  ${repoDir}`)

  let failures = 0

  const packages = discoverPackages(repoDir)

  // KAN-266: FINDING NOTHING IS A FAILURE, AND IT IS THE FAILURE THIS TICKET WAS
  // FILED FOR. The old loop skipped each missing hard-coded package under
  // `vlog` and fell through to `process.exit(failures ? 1 : 0)` with `failures`
  // still 0 — so "linked everything" and "found nothing to link" were the same
  // exit code and, at default verbosity, the same silence. That is this fleet's
  // most-repeated defect shape: a check reporting its own no-op as success. A
  // repo checked out at a path with no lockfile anywhere in scope is not a
  // no-op to shrug at; it means the workspace has no shared tree and the next
  // `npm install` will quietly take a private copy.
  if (packages.length === 0) {
    console.error(`FAIL — no package-lock.json found in ${repoDir} or its immediate subdirectories.`)
    console.error('       Nothing was linked, so this workspace has NO shared dependency tree.')
    console.error('       An `npm install` here would take a private copy. Do not treat this as done.')
    process.exit(1)
  }

  log(`packages: ${packages.map((p) => p.name).join(', ')}`)

  for (const { name: pkg, dir: pkgDir } of packages) {
    const lockPath = path.join(pkgDir, 'package-lock.json')

    const key = storeKey(pkg, lockPath)
    const storeDir = path.join(STORE_ROOT, key)
    const dest = path.join(pkgDir, 'node_modules')

    if (fs.existsSync(dest)) {
      log(`${pkg}: node_modules already present, leaving it alone`)
      continue
    }

    try {
      if (!fs.existsSync(storeDir)) {
        buildStoreEntry(pkg, key, pkgDir)
      } else {
        log(`${pkg}: store hit ${key}`)
      }

      linkInto(storeDir, pkgDir)

      const offenders = assertNoOutwardSymlinks(dest, repoDir)
      if (offenders.length) {
        failures++
        console.error(`${pkg}: FAIL — ${offenders.length} symlink(s) point outside the workspace:`)
        for (const o of offenders.slice(0, 5)) console.error(`    ${o}`)
      } else {
        log(`${pkg}: linked from store, no outward symlinks`)
      }
    } catch (err) {
      failures++
      console.error(`${pkg}: FAIL — ${err.message}`)
    }
  }

  process.exit(failures ? 1 : 0)
}

// Only run when executed directly; the verify script imports the functions
// above so that it exercises this code path rather than a copy of it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main()
}
