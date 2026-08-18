#!/usr/bin/env node
/**
 * verify-brief-staleness-check-is-depth-robust.mjs
 *
 * WHAT FAILURE THIS WOULD CATCH: the governance staleness check at the top of
 * `prompts/task.md` silently changing its answer with the clone's DEPTH — a
 * history walk (`git log <brief>..origin/main -- prompts/task.md`) naming a
 * commit, and therefore telling an agent that every rule it operates under has
 * moved, on a clone where the file has not changed at all. KAN-523: the shared
 * clone was grafted at `e7ac6bf` and the check printed that commit with a
 * `739 insertions` diff for a blob whose sha was identical at all three points.
 *
 * The failure direction is the one the brief does NOT anticipate. The brief
 * warns about a check that wrongly says "nothing changed". This one says
 * "EVERYTHING changed", and the cost lands on the agent that is being careful:
 * it is told to read a 739-line diff and may reasonably conclude its brief is
 * wholly untrustworthy.
 *
 * ── WHY A GRAFT PRODUCES THIS, WHICH IS THE WHOLE REASON THE FIX WORKS ──────
 * A shallow clone's graft root has its parents ERASED. So a revision range that
 * starts before the graft cannot be walked, and git reports every file in the
 * graft root's tree as ADDED there. The path filter does not save you: the file
 * genuinely is in that tree.
 *
 * A blob comparison asks the same question without walking anything —
 * `<rev>:<path>` resolves through the tree, not through history — so it is
 * unaffected by depth. That is the fix, and §2 is what stops it from being the
 * useless fix of "always say nothing changed".
 *
 * ── THE CASE MATRIX, AND WHICH ARM IS THE DANGEROUS ONE ─────────────────────
 *   objects present + history grafted  -> OLD false-positives, NEW correct  §1
 *   full clone, file genuinely changed -> both correct                      §2
 *   full clone, file unchanged         -> both correct                      §3
 *   brief commit object ABSENT         -> BOTH refuse, exit 128             §4
 *
 * §4 is measured and reported rather than assumed: an absent object was the
 * arm this script was written expecting to be dangerous, and it is not — both
 * checks fail loudly there and neither pretends to an answer. §1 is the live
 * shape KAN-523 actually hit, and it is the only arm where the two disagree.
 *
 * ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED ────────
 * Every repository below is built here, so this is a test of the two CHECKS'
 * judgement and NOT evidence that any real clone is healthy (KAN-145: a proof
 * that supplies its own input has not tested that the input arrives).
 *
 * The real shared clone is covered by a sibling and not by this file:
 * `verify-shared-clone-is-not-grafted.mjs` classifies ~/code/wroosbit/butchr
 * itself. Uncovered by BOTH, named rather than left to inference: nothing here
 * observes an agent actually RUNNING the check out of a rendered brief. §6
 * renders the block and reads it, which is the closest this can get without a
 * live activation.
 *
 * ── ⚠ BUILD DEPENDENCE IS MIXED — READ THE SECTION, NOT THE EXIT CODE ───────
 * §1-§5 are build-free: they shell out to `git` and read `daemon/src/prompt.ts`
 * and `prompts/task.md` as TEXT. Their verdicts are about your change even
 * after a failed build, and discarding them out of caution wastes a good red.
 *
 * §6 imports `../dist/prompt.js`. After a failed build its verdict is evidence
 * about the PREVIOUS build. It skips loudly when `dist` is absent rather than
 * failing, so a runner without a build does not report a defect it did not
 * find — which also means a green §6 is not proof that §6 ran.
 *
 * This file is therefore one of the mixed scripts `prompts/task.md` warns
 * about: its overall exit code is a blend, and the section is the unit of
 * evidence.
 */

// CI-RUNNABLE: partial — §1-§5 build their own git repositories under a temp
// dir and need nothing but `git` and node: no network, no shared clone, no build.
// §6 imports daemon/dist and SKIPS loudly on a runner that has not built.

import { execFileSync } from 'node:child_process'
// Aliased deliberately: `sweep-verify-exit-paths.mjs` treats an unaliased call
// to the sync file-writer as the start of a generated shim and excludes every
// exit that follows it, which would hide this file's verdict exit. The files
// written below are fixtures.
import { mkdtempSync, rmSync, writeFileSync as writeFixture, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

let failures = 0
const fail = (msg) => { failures += 1; console.log(`  ✗ FAIL  ${msg}`) }
const pass = (msg) => { console.log(`  ✓ pass  ${msg}`) }

const ID = ['-c', 'user.email=verify@butchr.test', '-c', 'user.name=verify']
const git = (cwd, ...args) =>
  execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Run a check and report its verdict as data, never throwing. */
function attempt(cwd, ...args) {
  try {
    return { ok: true, exit: 0, out: git(cwd, ...args) }
  } catch (e) {
    return { ok: false, exit: e.status ?? -1, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}

// ── THE TWO CHECKS, each written exactly once so §5 can compare them to the
// prompt's prose and so no section can quietly exercise a different command.
const OLD_CHECK = (repo, brief) => attempt(repo, 'log', '--oneline', `${brief}..origin/main`, '--', 'prompts/task.md')
const NEW_CHECK = (repo, brief) => attempt(repo, 'rev-parse', `${brief}:prompts/task.md`, 'origin/main:prompts/task.md')

/** Verdict of the blob check: 'current' | 'moved' | 'cannot-answer'. */
function readNew(r) {
  if (!r.ok) return 'cannot-answer'
  const lines = r.out.split('\n').map((s) => s.trim()).filter(Boolean)
  if (lines.length !== 2) return 'cannot-answer'
  return lines[0] === lines[1] ? 'current' : 'moved'
}

/** Verdict of the history walk: 'current' | 'moved' | 'cannot-answer'. */
function readOld(r) {
  if (!r.ok) return 'cannot-answer'
  return r.out === '' ? 'current' : 'moved'
}

const root = mkdtempSync(join(tmpdir(), 'kan523-'))

/**
 * A bare origin carrying `prompts/task.md`, the brief commit, `filler`
 * unrelated commits after it, and optionally a real edit to the prompt last.
 * Returns the origin path and the brief commit sha.
 */
function makeOrigin(name, { filler = 3, thenEditPrompt = false } = {}) {
  const origin = join(root, `${name}.git`)
  const author = join(root, `${name}-author`)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, author)
  execFileSync('mkdir', ['-p', join(author, 'prompts')])

  writeFixture(join(author, 'prompts', 'task.md'), 'RULE ONE\nRULE TWO\n')
  git(author, 'add', '-A')
  git(author, 'commit', '-q', '-m', 'the brief commit')
  const brief = git(author, 'rev-parse', 'HEAD')

  for (let i = 1; i <= filler; i++) {
    writeFixture(join(author, `unrelated${i}.txt`), `${i}\n`)
    git(author, 'add', '-A')
    git(author, 'commit', '-q', '-m', `unrelated ${i}`)
  }
  if (thenEditPrompt) {
    writeFixture(join(author, 'prompts', 'task.md'), 'RULE ONE\nRULE TWO, CHANGED\n')
    git(author, 'add', '-A')
    git(author, 'commit', '-q', '-m', 'a rule actually moved')
  }
  git(author, 'push', '-q', 'origin', 'main')
  return { origin, brief }
}

try {
  // ══ §1 ═══════════════════════════════════════════════════════════════════
  // The live KAN-523 shape. A clone that was FULL — so the brief commit's
  // objects are on disk — then grafted by a depth-limited fetch. The file never
  // changed. This is the only arm where the two checks disagree, and it is the
  // arm that cost KAN-515 a false alarm.
  console.log('=== §1  grafted clone, objects present, prompt UNCHANGED ===\n')
  {
    const { origin, brief } = makeOrigin('grafted', { filler: 3 })
    const clone = join(root, 'grafted-clone')
    git(root, 'clone', '-q', `file://${origin}`, clone)
    // The graft, applied exactly as it reaches the real shared clone.
    git(clone, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main')

    if (git(clone, 'rev-parse', '--is-shallow-repository') === 'true') pass('fixture is genuinely shallow')
    else fail('fixture is NOT shallow — this section proves nothing; git may be ignoring --depth')

    const o = readOld(OLD_CHECK(clone, brief))
    const n = readNew(NEW_CHECK(clone, brief))
    console.log(`      history walk -> ${o}      blob compare -> ${n}`)

    // THE RED. This is the defect reproduced. If the history walk ever stops
    // saying 'moved' here, the false positive is gone by some other route and
    // this whole file should be re-derived rather than quietly relaxed.
    if (o === 'moved') pass("history walk says 'moved' — the KAN-523 false positive, reproduced")
    else fail(`history walk said '${o}' — the defect did NOT reproduce, so §1 is asserting nothing`)

    // THE GREEN, on the same repository and the same question.
    if (n === 'current') pass("blob compare says 'current' — correct, and depth did not reach it")
    else fail(`blob compare said '${n}' — the fix does not survive a graft`)
  }

  // ══ §2 ═══════════════════════════════════════════════════════════════════
  // The discriminating arm. Without this, "always answer current" would pass §1.
  console.log('\n=== §2  full clone, prompt GENUINELY changed ===\n')
  {
    const { origin, brief } = makeOrigin('changed', { filler: 1, thenEditPrompt: true })
    const clone = join(root, 'changed-clone')
    git(root, 'clone', '-q', `file://${origin}`, clone)

    if (git(clone, 'rev-parse', '--is-shallow-repository') === 'false') pass('fixture is a full clone')
    else fail('fixture is shallow — §2 cannot discriminate')

    const n = readNew(NEW_CHECK(clone, brief))
    if (n === 'moved') pass("blob compare says 'moved' — the fix is NOT 'always say current'")
    else fail(`blob compare said '${n}' on a genuinely changed prompt — the fix is blind`)

    // And it survives a graft too: same answer, shallow clone, real change.
    const grafted = join(root, 'changed-grafted')
    git(root, 'clone', '-q', `file://${origin}`, grafted)
    git(grafted, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    const ng = readNew(NEW_CHECK(grafted, brief))
    if (ng === 'moved') pass("blob compare still says 'moved' on a GRAFTED clone — depth-independent both ways")
    else fail(`blob compare said '${ng}' on a grafted clone with a real change — it lost a true positive`)
  }

  // ══ §3 ═══════════════════════════════════════════════════════════════════
  console.log('\n=== §3  full clone, prompt unchanged — neither check may alarm ===\n')
  {
    const { origin, brief } = makeOrigin('quiet', { filler: 3 })
    const clone = join(root, 'quiet-clone')
    git(root, 'clone', '-q', `file://${origin}`, clone)

    const o = readOld(OLD_CHECK(clone, brief))
    const n = readNew(NEW_CHECK(clone, brief))
    if (o === 'current') pass('history walk is correct on a full clone — it is not broken, only depth-fragile')
    else fail(`history walk said '${o}' on a full unchanged clone`)
    if (n === 'current') pass('blob compare is correct on a full clone')
    else fail(`blob compare said '${n}' on a full unchanged clone`)
  }

  // ══ §4 ═══════════════════════════════════════════════════════════════════
  // Measured, not assumed. This arm was expected to be the dangerous one and
  // is not: with the brief commit absent, BOTH checks refuse. Recorded so that
  // nobody re-derives it, and so the claim in the header has evidence.
  console.log('\n=== §4  brief commit object ABSENT — both must refuse, neither may guess ===\n')
  {
    const { origin, brief } = makeOrigin('absent', { filler: 3 })
    const clone = join(root, 'absent-clone')
    // Shallow from the start, over file://, so the brief commit never arrives.
    git(root, 'clone', '-q', '--depth=1', `file://${origin}`, clone)

    if (git(clone, 'rev-parse', '--is-shallow-repository') === 'true') pass('fixture is genuinely shallow')
    else fail('fixture is NOT shallow — §4 proves nothing')

    const objectHere = attempt(clone, 'cat-file', '-t', brief).ok
    if (!objectHere) pass('the brief commit is genuinely absent from this clone')
    else fail('the brief commit IS present — §4 is not testing an absent object')

    const oR = OLD_CHECK(clone, brief)
    const nR = NEW_CHECK(clone, brief)
    if (readOld(oR) === 'cannot-answer') pass(`history walk refuses (exit ${oR.exit}) rather than answering`)
    else fail(`history walk answered '${readOld(oR)}' about an object it does not have`)

    // The one that matters: the fix must never fall back to "looks unchanged".
    if (readNew(nR) === 'cannot-answer') pass(`blob compare refuses (exit ${nR.exit}) rather than answering`)
    else fail(`blob compare answered '${readNew(nR)}' about an object it does not have — it GUESSED`)
  }

  // ══ §5 ═══════════════════════════════════════════════════════════════════
  // The gap named in the header: nothing above reads the thing that actually
  // emits the check. This does, as TEXT, so it carries no build dependence.
  //
  // ⚠ The check is NOT in `prompts/task.md`. That file is a template; the
  // provenance block is RENDERED into every brief by `renderProvenanceBlock`
  // in `daemon/src/prompt.ts`. This script originally asserted against the
  // template, and that assertion passed before the fix was written — it was
  // looking for a string in a file that never contained it. Recorded because a
  // green from the wrong file is exactly this repository's signature defect.
  console.log('\n=== §5  the RENDERER emits the depth-robust recipe (source read as text) ===\n')
  {
    const src = readFileSync(join(REPO, 'daemon', 'src', 'prompt.ts'), 'utf8')

    if (/rev-parse \$\{shortSha\}:\$\{p\.templatePath\}/.test(src)) {
      pass('prompt.ts emits a blob comparison (`rev-parse <sha>:<path> origin/main:<path>`)')
    } else {
      fail('prompt.ts does NOT emit a blob comparison — the proof and the renderer have diverged')
    }

    // The fragile form must not be emitted any more. It may still be described
    // in the doc comment that explains why it was retired, so this looks only
    // at the emitted template literals — the lines that reach an agent.
    const emitsWalk = /`\s*git -C \$\{p\.repoRoot\} log --oneline \$\{shortSha\}\.\.origin\/main/.test(src)
    if (!emitsWalk) pass('prompt.ts no longer emits the depth-fragile history walk')
    else fail('prompt.ts still emits `log --oneline <sha>..origin/main` as the check')

    // The third outcome is the half AC2 asks for: refuse rather than guess.
    if (/cannot answer/i.test(src) && /unshallow/.test(src)) {
      pass('the emitted block names the `fatal:` outcome and the --unshallow remedy')
    } else {
      fail('the emitted block does not tell the reader what a refusal means')
    }

    // The mechanism warning is the half that prevents recurrence.
    //
    // ⚠ This assertion was originally three loose `/--depth/`-style tests over
    // the whole document, and it PASSED with the load-bearing bullet deleted —
    // the words survived in neighbouring bullets that do not carry the claim.
    // It now binds the proposition rather than the vocabulary: one bullet must
    // say that a depth flag is forbidden, and that the reason is that a
    // worktree shares the shared clone's `.git`. Driven red by deleting that
    // bullet, which is the mutation the loose version did not notice.
    const prompt = readFileSync(join(REPO, 'prompts', 'task.md'), 'utf8')
    const bullets = prompt.split(/\n(?=- |\s*- )/)
    const warns = bullets.filter(
      (b) => /--depth/.test(b) && /\bNever\b/.test(b) && /worktree/i.test(b) && /shared clone/i.test(b)
    )
    if (warns.length >= 1) {
      pass('prompts/task.md forbids --depth and says why: a worktree shares the shared clone')
    } else {
      fail('no single bullet in prompts/task.md carries the forbid-and-explain warning')
    }

    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')
    if (/DO NOT RUN THIS COMMAND ON THE DEV MACHINE/.test(ci)) {
      pass('ci.yml warns at the copy site that its --depth=1 recipe is runner-only')
    } else {
      fail('ci.yml carries a --depth=1 recipe with no warning at the point somebody would copy it')
    }
  }

  // ══ §6 ═══════════════════════════════════════════════════════════════════
  // ⚠ THIS SECTION IMPORTS FROM ../dist/ AND THE ONES ABOVE DO NOT. After a
  // failed build its result is evidence about the PREVIOUS build, while §1-§5
  // still tested your change. Read the section, never this file's exit code
  // alone. It skips loudly rather than failing when there is no build, so that
  // a CI runner without one does not report a defect it did not find.
  console.log('\n=== §6  the rendered block itself, end to end (imports dist) ===\n')
  {
    const DIST = join(REPO, 'daemon', 'dist', 'prompt.js')
    let mod = null
    try {
      mod = await import(DIST)
    } catch {
      console.log('  ⓘ SKIP  daemon/dist/prompt.js is absent or unloadable — run `npm run build` in daemon/.')
      console.log('          §1-§5 above are unaffected: none of them import from dist.')
    }
    if (mod?.renderProvenanceBlock) {
      const block = mod.renderProvenanceBlock({
        repoRoot: '/home/example/code/wroosbit/butchr',
        templatePath: 'prompts/task.md',
        renderedAt: new Date(0),
        source: { kind: 'ref', ref: 'origin/main' },
        commit: { sha: 'a'.repeat(40), shortSha: 'abc1234', subject: 'a subject', date: '2026-08-18 00:00' }
      })
      if (block.includes('rev-parse abc1234:prompts/task.md origin/main:prompts/task.md')) {
        pass('the rendered brief carries the blob comparison, with both revisions spelled out')
      } else {
        fail('the rendered brief does not carry the blob comparison')
      }
      if (!/log --oneline abc1234\.\.origin\/main/.test(block)) {
        pass('the rendered brief no longer carries the history walk')
      } else {
        fail('the rendered brief still carries the depth-fragile history walk')
      }
      if (/fatal:/.test(block) && /--unshallow/.test(block)) {
        pass('the rendered brief tells the reader a refusal is not "nothing changed"')
      } else {
        fail('the rendered brief omits the cannot-answer outcome')
      }
    } else if (mod) {
      fail('daemon/dist/prompt.js loaded but exports no renderProvenanceBlock')
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
if (failures) {
  console.log(`FAILED: ${failures} assertion${failures === 1 ? '' : 's'}`)
} else {
  console.log('OK: the governance staleness check is depth-robust, and still able to say a rule moved.')
}
process.exit(failures ? 1 : 0)
