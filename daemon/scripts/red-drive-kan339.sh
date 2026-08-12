#!/usr/bin/env bash
#
# KAN-339's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing, and
# where demonstrating the failure needs a recipe, the recipe is part of the proof
# because the reviewer has to be able to reproduce the red as well as the green.
# This is that recipe. Every mutation is applied to THIS branch's source, so no
# pre-fix build and no second worktree is needed.
#
# NOT A `verify-` SCRIPT, deliberately, and named so it cannot be mistaken for
# one: it edits `daemon/src` in place and rebuilds. `sweep-verify-exit-paths.mjs`
# and the CI partition both key off the `verify-` prefix, and a script that
# mutates the tree has no business in a set CI runs unattended.
#
# It restores both files on EXIT, including on Ctrl+C. If it is killed with -9,
# `git checkout daemon/src/github.ts daemon/src/pr-watch.ts` puts them back.
#
# Usage:  bash daemon/scripts/red-drive-kan339.sh          (from the repo root)

set -u

if [ ! -f daemon/src/pr-watch.ts ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan339.sh" >&2
  exit 2
fi

GH=daemon/src/github.ts
PW=daemon/src/pr-watch.ts
BAK=$(mktemp -d)
cp $GH "$BAK/github.ts"
cp $PW "$BAK/pr-watch.ts"
restore() { cp "$BAK/github.ts" $GH; cp "$BAK/pr-watch.ts" $PW; }
trap 'restore; rm -rf "$BAK"' EXIT

reds=0
greens=0
uncompilable=0

drive() {
  echo
  echo "################################################################"
  echo "# MUTATION: $1"
  echo "################################################################"

  # THE BUILD EXIT CODE IS READ BEFORE THE PROOF'S VERDICT IS READ AT ALL, and
  # it is not piped (H-22): `npm run build | tail` yields tail's status, so a
  # failed build would read as 0 and the proof would then run against the
  # PREVIOUS dist — where a pass means "my mutation was not caught" about code
  # that never ran, and a red credits the wrong mechanism.
  npm --prefix daemon run build > "$BAK/build.log" 2>&1
  local build=$?
  echo "BUILD_EXIT=$build"

  if [ $build -ne 0 ]; then
    # Not a red. The compiler caught the mutation and the proof never saw it, so
    # this mutation is not testable as written and the correct move is a
    # mutation that compiles — not a re-run, and not a shrug.
    uncompilable=$((uncompilable + 1))
    echo "NOT A RED — the mutation does not compile, so the proof never saw it."
    echo "The compiler said:"
    grep -E "error TS" "$BAK/build.log" | sed 's/^/    /'
    restore
    return
  fi

  node daemon/scripts/verify-pr-watch-readiness.mjs > "$BAK/proof.log" 2>&1
  local proof=$?
  echo "PROOF_EXIT=$proof"
  if [ $proof -ne 0 ]; then reds=$((reds + 1)); else greens=$((greens + 1)); fi
  grep -E "FAILED —|ALL SECTIONS PASSED" "$BAK/proof.log" | sed 's/^/    /'
  restore
}

# --- 1 -----------------------------------------------------------------------
# rollupOf stops counting what it judged, so a rollup emptied by the approval
# exclusions falls through to 'success' again. This is the #153 defect verbatim.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/github.ts'); s = p.read_text()
s = s.replace("  if (!judged) return { checks: 'none', failingChecks: [], approval };\n", "")
p.write_text(s)
PY
drive "rollupOf no longer distinguishes an emptied rollup from a green one"

# --- 2 -----------------------------------------------------------------------
# An uncomputed merge state becomes a green light again, which is the 40-second
# window after any push to main.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/github.ts'); s = p.read_text()
s = s.replace("    case 'UNSTABLE':\n      return 'mergeable';",
              "    case 'UNSTABLE':\n    case 'UNKNOWN':\n      return 'mergeable';")
p.write_text(s)
PY
drive "mergeabilityOf treats an uncomputed merge state as mergeable"

# --- 3 -----------------------------------------------------------------------
# The wrong fix. Silencing green-idle satisfies 1, 2, 4b and 6, and removes the
# feature. §3 is the only thing standing between this change and that outcome.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("    const greenIdle = readiness.ready;", "    const greenIdle = false && readiness.ready;")
p.write_text(s)
PY
drive "green-idle is silenced entirely (the fix that removes the feature)"

# --- 4 -----------------------------------------------------------------------
# EXPECTED TO FAIL TO COMPILE, and kept in the set for that reason: it is the
# demonstration that the discriminated union makes the collapse unrepresentable
# rather than merely unlikely. Reported as a non-result above, never as a pass.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("        switch (event.mergeability) {\n          case 'conflicted':",
              "        switch ('collapsed') {\n          case 'conflicted':")
p.write_text(s)
PY
drive "head-stale's switch is collapsed (expected: TS2678, not a red)"

# --- 4b ----------------------------------------------------------------------
# The same collapse spelled so that it compiles, so §4's assertion is what has
# to catch it.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""          case 'behind':
            return (
              'is BEHIND main — `gh pr update-branch` fixes it. That changes the head, so any ' +
              'approval given against the old one no longer names it'
            );""", """          case 'behind':
            return (
              'CONFLICTS with main — this needs the conflict resolved by hand on the branch. ' +
              'No review clears it and `gh pr update-branch` cannot either, and until it is ' +
              'resolved no workflow will run at this head'
            );""")
p.write_text(s)
PY
drive "BEHIND is given the DIRTY wording (compiles, so §4 must catch it)"

# --- 5 -----------------------------------------------------------------------
# The counters stop separating rows polled from pull requests outstanding.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("      this.health.openCount = tick.openWatched.length;",
              "      this.health.openCount = tick.watched.length;")
p.write_text(s)
PY
drive "openCount counts every polled row again"

# --- 6 -----------------------------------------------------------------------
# AC4: the inert-case disclosure is the best thing in this module and the ticket
# forbids damaging it. This proves that forbidding it is enforced.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("'being observed, which is not the same as nothing having changed.'", "'being observed.'")
p.write_text(s)
PY
drive "the inert-case reason string loses its disclosure (AC4)"

# --- 7 -----------------------------------------------------------------------
# Both original defects together: the build that was running at 15:58:53Z.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/github.ts'); s = p.read_text()
s = s.replace("  if (!judged) return { checks: 'none', failingChecks: [], approval };\n", "")
s = s.replace("    case 'UNSTABLE':\n      return 'mergeable';",
              "    case 'UNSTABLE':\n    case 'UNKNOWN':\n      return 'mergeable';")
p.write_text(s)
PY
drive "BOTH defects restored — the build that ran at 15:58:53Z"

echo
echo "################################################################"
echo "# RESTORED — the tree is back to this branch's code"
echo "################################################################"
npm --prefix daemon run build > "$BAK/build.log" 2>&1
echo "BUILD_EXIT=$?"
node daemon/scripts/verify-pr-watch-readiness.mjs > "$BAK/proof.log" 2>&1
echo "PROOF_EXIT=$?"
tail -3 "$BAK/proof.log"

echo
echo "  ${reds} mutation(s) went red, ${greens} stayed green, ${uncompilable} did not compile."
echo
if [ $greens -ne 0 ]; then
  echo "A MUTATION THAT STAYED GREEN IS AN ASSERTION THAT CANNOT BE FALSE. That is the"
  echo "thing this script exists to find, and it has found one."
  exit 1
fi
# Mutation 4 is expected not to compile. Any OTHER uncompilable mutation means
# this script has drifted from the source it patches — its `replace` calls are
# string-exact — and a mutation that silently failed to apply would be reported
# as a green above, so the count is checked rather than assumed.
if [ $uncompilable -ne 1 ]; then
  echo "Expected exactly one uncompilable mutation (#4, the type refusing the collapse);"
  echo "got ${uncompilable}. This script has probably drifted from daemon/src."
  exit 1
fi
exit 0
