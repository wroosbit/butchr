#!/usr/bin/env bash
# KAN-260: watch `verify-stranded-merges.mjs` fail, six ways.
#
# A gate nobody has watched fail has not been shown to be a gate. Each arm below
# applies one mutation to the shipped source, rebuilds, runs the proof, and
# prints the arm's exit code beside the sections that went red.
#
# ⚠ THE BUILD EXIT IS CHECKED BEFORE THE PROOF'S VERDICT IS READ, AND IT IS READ
# WITHOUT A PIPE. The proof imports from `dist`, so after a failed build it runs
# against the PREVIOUS build and both of its outcomes mislead: a pass reads as
# "my mutation was not caught", a fail credits the proof for a red the compiler
# produced. `npm run build | tail` would report `tail`'s status, which is how
# that trapdoor is usually walked into.
#
# ⚠ ARM 6 IS A COMPILER ARM AND IS EXPECTED TO FAIL ITS BUILD. It is here to
# demonstrate that `mergeHoldOf`'s exhaustiveness is enforced by the TYPE rather
# than by an assertion — `prompts/task.md`, prefer the type where the invariant
# is about what the code is able to say. Its BUILD_EXIT=2 is the mechanism, not
# a broken arm, and it is labelled so that nobody reads the compiler's red as
# the proof's. That confusion is exactly what #134 nearly wrote down.
#
# ⚠ IT REVERTS WITH `git checkout --`, SO IT RESTORES HEAD AND NOT WHAT YOU HAD
# IN THE TREE. RUN IT ON A COMMITTED TREE — the guard below refuses otherwise,
# and the guard is here because the first run of this script was made on an
# UNCOMMITTED one. Arm 1's own revert deleted the change the script was written
# to test; every arm after it then built and ran against `origin/main`, and the
# transcript that produced reads as a coherent set of results. Two of the arms
# even printed the red they were supposed to print, for the wrong reason. This
# is `prompts/task.md`'s "check the instrument answered the question you asked"
# with the instrument being the working tree.
#
# Run from the repository root. It reverts each mutation before the next, and
# leaves the tree as it found it.

set -u
cd "$(dirname "$0")/../.."

SRC=daemon/src/pr-watch.ts
PROOF=daemon/scripts/verify-stranded-merges.mjs

if ! git diff --quiet -- "$SRC"; then
  echo "REFUSING TO RUN: $SRC has uncommitted changes."
  echo
  echo "  This script reverts each mutation with \`git checkout -- $SRC\`, which restores"
  echo "  the file to HEAD. On a dirty tree that DELETES your work, and every arm after"
  echo "  the first then measures HEAD while appearing to measure your change."
  echo
  echo "  Commit first, then run."
  exit 2
fi

# A revert that silently fails stacks the next mutation on top of this one, and
# the compiler errors that follow are then about a file nobody wrote.
revert() {
  git checkout -- "$SRC" || { echo "REVERT FAILED — aborting"; exit 9; }
  git diff --quiet -- "$SRC" || { echo "REVERT LEFT THE TREE DIRTY — aborting"; exit 9; }
}
trap revert EXIT

arm() {
  local n="$1" what="$2" expect="$3"
  echo
  echo "############################################################################"
  echo "# ARM $n — $what"
  echo "#   expected red: $expect"
  echo "############################################################################"

  ( cd daemon && npm run build ) > /tmp/kan260-build.log 2>&1
  local build_exit=$?
  echo "BUILD_EXIT=$build_exit"
  if [ "$build_exit" -ne 0 ]; then
    echo "  → the compiler refused this mutation. The verdict below is NOT run:"
    echo "    a proof over a stale \`dist\` is evidence about code that was not built."
    grep -E "error TS" /tmp/kan260-build.log | head -5
    revert
    return 0
  fi

  node "$PROOF" > /tmp/kan260-proof.log 2>&1
  local proof_exit=$?
  echo "PROOF_EXIT=$proof_exit"
  grep -E "^§|→ FAILED|^PASSED|^FAILED" /tmp/kan260-proof.log | sed 's/^/  /'
  revert
}

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
old='        if (stranded) strandedThisTick.push(stranded);'
new='        if (stranded && stranded.liveMergers.length === 0) strandedThisTick.push(stranded);'
assert s.count(old)==1
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
PY
arm 1 "report ONLY pull requests with no live agent — KAN-260's superseded diagnosis" \
      "§2 (#115: agent live, approved, unmerged)"

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
old="""    case 'conflicted':
    case 'behind':
    case 'mergeability-unknown':
      return 'the-head-does-not-merge';"""
new="""    case 'conflicted':
    case 'behind':
    case 'mergeability-unknown':
      return null;"""
assert s.count(old)==1
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
PY
arm 2 "go quiet once an approved PR goes BEHIND — the state the KAN-260 four decayed into" \
      "§8 (the classification table)"

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
old="""    tick.strandedMerges = anyFailure
      ? {
          answered: false,"""
new="""    tick.strandedMerges = false
      ? {
          answered: false,"""
assert s.count(old)==1
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
PY
arm 3 "answer a failed GitHub read with a clean empty list" \
      "§4 (unreadable tick must not look clean)"

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
old="""        // `waitingMs: 0` for a pull request that has been stranded for hours,
        // on exactly the tick after a daemon restart. Absent reads back as
        // `approvedAt: null`, whose sentence is "how long is genuinely
        // unknown". `verify-stranded-merges.mjs` §7 caught this version of this
        // module doing the stamping.
        greenIdleSha:"""
new="""        // `waitingMs: 0` for a pull request that has been stranded for hours,
        // on exactly the tick after a daemon restart. Absent reads back as
        // `approvedAt: null`, whose sentence is "how long is genuinely
        // unknown". `verify-stranded-merges.mjs` §7 caught this version of this
        // module doing the stamping.
        ...(approvalAtHead(pr) ? { approvedAt: seenAt } : {}),
        greenIdleSha:"""
assert s.count(old)==1
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
PY
arm 4 "stamp approvedAt at first sight — the real defect the proof caught in this ticket" \
      "§7 (an unknown age reported as 0s)"

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io,re
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
old="""so "nothing new" here means nothing new rather than nothing seen. ${asOf}${stranded}`"""
new="""so "nothing new" here means nothing new rather than nothing seen. ${asOf}`"""
assert s.count(old)==1
s=s.replace(old,new,1)
# `stranded` becomes unused; keep it referenced so the arm tests the SENTENCE
# rather than an unused-local error.
s=s.replace("  const closedRows = Math.max(0, health.watchedCount - health.openCount);",
            "  void stranded;\n  const closedRows = Math.max(0, health.watchedCount - health.openCount);",1)
io.open(p,'w',encoding='utf8').write(s)
PY
arm 5 "drop the clause from the health sentence, keeping only the field" \
      "§6 (it must not be a key you have to know about)"

# ---------------------------------------------------------------------------
python3 - <<'PY'
import io
p='daemon/src/pr-watch.ts'; s=io.open(p,encoding='utf8').read()
# A blocker added to the union with no case in `mergeHoldOf`. The point of the
# arm is that this does NOT compile.
old="""  /** Somebody has already approved, so nobody is being waited on. */
  | 'already-approved';"""
new="""  /** Somebody has already approved, so nobody is being waited on. */
  | 'already-approved'
  /** A blocker a later author added and did not classify. */
  | 'awaiting-deploy-window';"""
assert s.count(old)==1
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
PY
arm 6 "COMPILER ARM — add a PrBlocker and forget to classify it in mergeHoldOf" \
      "the BUILD, not the proof: exhaustiveness is enforced by the type"

echo
echo "############################################################################"
echo "# TREE RESTORED"
echo "############################################################################"
git diff --stat -- "$SRC"
( cd daemon && npm run build ) > /tmp/kan260-build.log 2>&1
echo "BUILD_EXIT=$?"
node "$PROOF" > /tmp/kan260-proof.log 2>&1
echo "PROOF_EXIT=$?"
tail -3 /tmp/kan260-proof.log
