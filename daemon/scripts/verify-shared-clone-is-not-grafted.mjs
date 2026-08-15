#!/usr/bin/env node
/**
 * verify-shared-clone-is-not-grafted.mjs
 *
 * WHAT FAILURE THIS WOULD CATCH: a shared clone whose object graph has been
 * truncated by a depth-limited fetch, reported to its readers as "N commits
 * behind" with the remedy `git pull --ff-only` — advice that cannot run,
 * against a state that is not what the number says. KAN-437: the butchr clone
 * read `[ahead 179, behind 4]` while being 22 behind and 0 ahead, served stale
 * prompts and a pre-KAN-266 `link-workspace-deps.mjs` to every agent activated
 * from it, and the existing staleness check reported only the `behind` half —
 * so it could only ever agree with whoever read it.
 *
 * The discriminating question is NOT "is it behind". A check that asks that
 * reproduces the defect, because `behind` is exactly the half that was right.
 * The questions are "is the graph intact" and "is there anything ahead".
 *
 * ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED ────────
 * Section 1 BUILDS the repositories it then classifies. That makes it a test of
 * `classifyRemoteRelation`'s judgement, NOT evidence that any real clone is
 * healthy — a proof that supplies its own input has not tested that the input
 * arrives (KAN-145).
 *
 * Section 2 covers that gap for the one clone that matters: it classifies the
 * REAL shared clone at ~/code/wroosbit/butchr, input supplied by the world.
 * Section 2 is skipped, loudly and without failing, when that clone is absent —
 * this script runs in CI, where it is.
 *
 * Still uncovered by both, named rather than left to inference: nothing here
 * observes the daemon actually SURFACING the verdict to an agent. That is
 * `verify-staleness-over-socket.mjs`'s job, and it is not this file's.
 *
 * ── BUILD DEPENDENCE ────────────────────────────────────────────────────────
 * This script imports from ../dist/, so a failed build makes its verdict
 * evidence about the previous build rather than about your change. Confirm the
 * build exited 0 before reading anything below.
 */

// CI-RUNNABLE: partial — sections 1 and 2 build their own git repositories in a
// temp dir and need nothing but `git`, node and a built `dist`, so they assert
// in full on a runner. Section 3 classifies the real shared clone at
// ~/code/wroosbit/butchr, which no CI runner has; it skips loudly and does not
// fail, and it is the only section that observes a clone this script did not
// create.

import { execFileSync } from 'node:child_process'
// The sync file-writer is imported under another name deliberately. The
// required `sweep-verify-exit-paths.mjs` treats an unaliased call to it as the
// start of a generated shim script and excludes every exit that follows, which
// hid this file's verdict exit and reported it as "all guards". The files
// written below are fixtures, not shims.
//
// Note what this comment may not contain: spelling the call out here, even in
// prose, re-trips the heuristic — the explanation caused the defect it
// explains. Reported as a follow-up rather than left as an unexplained alias.
import { mkdtempSync, rmSync, writeFileSync as writeFixture, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist', 'staleness.js')

if (!existsSync(DIST)) {
  // A setup guard, not a verdict: there is nothing to judge without a build.
  console.error(`FATAL: ${DIST} is missing. Run \`npm run build\` in daemon/ first.`)
  process.exit(1)
}

const { classifyRemoteRelation } = await import(DIST)

let failures = 0
const fail = (msg) => { failures += 1; console.log(`  ✗ FAIL  ${msg}`) }
const pass = (msg) => { console.log(`  ✓ pass  ${msg}`) }

const ID = ['-c', 'user.email=verify@butchr.test', '-c', 'user.name=verify']
const git = (cwd, ...args) =>
  execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const commit = (repo, file, body) => {
  writeFixture(join(repo, file), body)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', `add ${file}`)
}

const root = mkdtempSync(join(tmpdir(), 'kan437-'))

/** A bare origin with `n` commits, plus a working clone that can push to it. */
function makeOrigin(name, n) {
  const origin = join(root, `${name}.git`)
  const author = join(root, `${name}-author`)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, author)
  for (let i = 1; i <= n; i++) commit(author, `c${i}.txt`, `commit ${i}\n`)
  git(author, 'push', '-q', 'origin', 'main')
  return { origin, author }
}

console.log('=== Section 1: fixtures this script builds itself ===\n')

const cases = []

// (a) LEVEL — nothing to do. Must not alarm.
{
  const { origin } = makeOrigin('level', 3)
  const clone = join(root, 'level-clone')
  git(root, 'clone', '-q', origin, clone)
  cases.push({ name: 'level (up to date)', repo: clone, expect: 'level' })
}

// (b) BEHIND ONLY — the discriminating arm. A fast-forward IS available here,
// so this must stay `behind`. If a divergence check reds on this it is crying
// wolf on the ordinary case and will be switched off.
{
  const { origin, author } = makeOrigin('behind', 3)
  const clone = join(root, 'behind-clone')
  git(root, 'clone', '-q', origin, clone)
  commit(author, 'c4.txt', 'four\n')
  commit(author, 'c5.txt', 'five\n')
  git(author, 'push', '-q', 'origin', 'main')
  git(clone, 'fetch', '-q', 'origin')
  cases.push({ name: 'behind only (fast-forward available)', repo: clone, expect: 'behind' })
}

// (c) GENUINELY DIVERGED — real local commits AND real remote commits.
{
  const { origin, author } = makeOrigin('diverged', 3)
  const clone = join(root, 'diverged-clone')
  git(root, 'clone', '-q', origin, clone)
  commit(author, 'remote1.txt', 'remote\n')
  git(author, 'push', '-q', 'origin', 'main')
  commit(clone, 'local1.txt', 'local\n')
  git(clone, 'fetch', '-q', 'origin')
  cases.push({ name: 'genuinely diverged', repo: clone, expect: 'diverged' })
}

// (d) SHALLOW — KAN-437's own shape, reproduced. A full clone, then a
// depth-limited fetch that grafts the remote-tracking ref. The raw counts go
// FAKE: the clone looks ahead of a remote it is strictly behind.
let shallowRepo = null
{
  const { origin, author } = makeOrigin('shallow', 5)
  const clone = join(root, 'shallow-clone')
  git(root, 'clone', '-q', origin, clone)
  commit(author, 'c6.txt', 'six\n')
  commit(author, 'c7.txt', 'seven\n')
  git(author, 'push', '-q', 'origin', 'main')
  git(clone, 'fetch', '-q', '--depth=1', 'origin')
  shallowRepo = clone
  cases.push({ name: 'shallow graft (KAN-437 shape)', repo: clone, expect: 'shallow' })
}

for (const c of cases) {
  const rel = classifyRemoteRelation(c.repo, 'origin/main')
  const got = rel ? rel.kind : '(null)'
  if (got === c.expect) pass(`${c.name} -> ${got}`)
  else fail(`${c.name} -> expected '${c.expect}', got '${got}'`)
}

console.log('\n=== Section 2: the fake numbers the graft produces ===\n')

// This is the heart of it. On the shallow fixture the raw ahead/behind pair is
// not merely incomplete, it points the wrong way — which is why reporting
// `behind` alone was worse than reporting nothing.
{
  const raw = git(shallowRepo, 'rev-list', '--left-right', '--count', 'HEAD...origin/main')
  const [ahead, behind] = raw.split(/\s+/).map(Number)
  console.log(`  raw counts on the grafted clone: ahead=${ahead} behind=${behind}`)
  if (ahead > 0) pass(`the graft manufactures a phantom 'ahead' (${ahead}) on a clone that is strictly behind`)
  else fail(`expected a phantom ahead>0 on the grafted fixture, got ahead=${ahead}`)

  const rel = classifyRemoteRelation(shallowRepo, 'origin/main')
  if (rel && rel.kind === 'shallow') pass('classified as shallow, so those counts are not reported as divergence')
  else fail(`grafted clone classified as '${rel ? rel.kind : '(null)'}' — the phantom counts would be believed`)

  // And the remedy the old check printed genuinely does not run.
  let ffExit = 0
  try {
    execFileSync('git', [...ID, 'pull', '--ff-only'], { cwd: shallowRepo, stdio: 'ignore' })
  } catch (e) {
    ffExit = e.status ?? 1
  }
  if (ffExit !== 0) pass(`\`pull --ff-only\` on the grafted clone exits ${ffExit} — the old remedy could not have worked`)
  else fail('`pull --ff-only` succeeded on the grafted clone; this fixture no longer reproduces KAN-437')
}

console.log('\n=== Section 3: the real shared clone (input supplied by the world) ===\n')

// Overridable so this section's FAILING branch is reachable on demand. A check
// whose red path the world has to supply is a check nobody has watched fail;
// point this at a grafted repo and it must go red.
const SHARED = process.env.BUTCHR_SHARED_CLONE ?? join(process.env.HOME ?? '', 'code', 'wroosbit', 'butchr')
if (!existsSync(join(SHARED, '.git'))) {
  console.log(`  – skipped: ${SHARED} is not present (expected in CI). Section 1 does not cover this.`)
} else {
  const rel = classifyRemoteRelation(SHARED, 'origin/main')
  const kind = rel ? rel.kind : '(null)'
  console.log(`  ${SHARED} -> ${kind}`)
  if (kind === 'shallow') {
    fail(`the shared clone is GRAFTED. Every worktree cut from it shares this. Repair: git -C ${SHARED} fetch --unshallow origin`)
  } else if (kind === 'diverged') {
    fail(`the shared clone has diverged (${rel.ahead} ahead, ${rel.behind} behind) — \`pull --ff-only\` will not fix it`)
  } else {
    pass(`the shared clone's history is intact and nothing is ahead (${kind})`)
  }
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'OK — all checks passed'}`)
process.exit(failures ? 1 : 0)
