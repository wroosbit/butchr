#!/usr/bin/env bash
#
# KAN-360's red drive, as a script rather than as a paragraph in a PR body.
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
# Usage:  bash daemon/scripts/red-drive-kan360.sh          (from the repo root)

set -u

if [ ! -f daemon/src/pr-watch.ts ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan360.sh" >&2
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

  node daemon/scripts/verify-pr-watch-repo-retention.mjs > "$BAK/proof.log" 2>&1
  local proof=$?
  echo "PROOF_EXIT=$proof"
  if [ $proof -ne 0 ]; then reds=$((reds + 1)); else greens=$((greens + 1)); fi
  grep -E "FAILED —|ALL SECTIONS PASSED" "$BAK/proof.log" | sed 's/^/    /'
  restore
}

# --- 1 -----------------------------------------------------------------------
# THE DEFECT ITSELF. The memory union is removed and the watch set is discovery
# only, which is what `origin/main` does today. §1 must still pass — the drain is
# a fact about discovery and is not what changed — and §2 must go red, because
# the merge the approver has to act on is now announced to nobody.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""    for (const repo of this.state.reposWithOpenPr()) {
      if (!bySource.has(repo)) bySource.set(repo, 'memory');
    }
""", "")
p.write_text(s)
PY
drive "the watch set is discovery only again (the defect, verbatim)"

# --- 2 -----------------------------------------------------------------------
# THE WRONG FIX, and the one this change is most likely to commit: retain
# everything the memory has ever seen. §2, §3 and §4 are all satisfied by it —
# it is more coverage, not less — and §6 is the only thing standing between this
# change and a watcher that pays GitHub three points a minute forever for every
# repository anybody has ever touched, while reporting full coverage.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("      if (memory.state !== 'OPEN') continue;",
              "      if (false && memory.state !== 'OPEN') continue;")
p.write_text(s)
PY
drive "retention never releases — every repository ever seen is watched forever"

# --- 3 -----------------------------------------------------------------------
# The inert-case disclosure is softened. Both AC4s protect this sentence, and
# §4 pins it as a LITERAL rather than by regex for exactly this reason: the
# mutation below still contains "No repository is being watched" and would
# survive any assertion written about the part a reader remembers.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("      'being observed, which is not the same as nothing having changed.';",
              "      'being observed.';")
p.write_text(s)
PY
drive "the inert-case reason string loses its disclosure"

# --- 4 -----------------------------------------------------------------------
# EXPECTED TO FAIL TO COMPILE, and kept in the set for that reason: it is the
# demonstration that `RepoSource` makes a fourth, undeclared way into the watch
# set unrepresentable rather than merely unlikely. Reported as a non-result
# above, never as a pass.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("if (!bySource.has(repo)) bySource.set(repo, 'memory');",
              "if (!bySource.has(repo)) bySource.set(repo, 'inferred');")
p.write_text(s)
PY
drive "a repository enters the set with an undeclared source (expected: TS2345, not a red)"

# --- 4b ----------------------------------------------------------------------
# The same lie spelled so that it compiles: a retained repository claims a live
# checkout it does not have. This is the failure AC3 is about — the report is
# full, the set is right, and every entry in it is described as coverage when
# half of it is luck — so §3 is what has to catch it rather than the compiler.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("if (!bySource.has(repo)) bySource.set(repo, 'memory');",
              "if (!bySource.has(repo)) bySource.set(repo, 'checkout');")
p.write_text(s)
PY
drive "a retained repository reports a live checkout it does not have"

# --- 5 -----------------------------------------------------------------------
# CANDIDATE (1) AS THE TICKET FILED IT: "once discovered, a repository stays
# watched for the daemon's life." Retention comes off a set on the WATCHER, fed
# by discovery, persisted nowhere.
#
# WHICH SECTION CATCHES IT, stated precisely because the obvious answer is
# wrong. It is §6, not §5 — a set that lives for the daemon's life never
# releases, so the repository is still being read a tick after the merge it was
# retained for. §5 goes on passing, and correctly: it asserts a property of
# `PrWatchState`, which this mutation leaves intact and merely stops consulting.
# What §5 is for is the other half of the ruling — that retention read out of the
# durable memory has no restart hole to begin with, which is the measurement
# that made candidate (1) unnecessary rather than the one that refutes it.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""  private resolveRepos(agents: LiveAgent[]): { repos: WatchedRepo[]; released: string[] } {""",
"""  private stickyRepos = new Set<string>();

  private resolveRepos(agents: LiveAgent[]): { repos: WatchedRepo[]; released: string[] } {""")
s = s.replace("""    for (const repo of this.state.reposWithOpenPr()) {
      if (!bySource.has(repo)) bySource.set(repo, 'memory');
    }""",
"""    for (const { repo } of discovered) this.stickyRepos.add(repo);
    for (const repo of this.stickyRepos) {
      if (!bySource.has(repo)) bySource.set(repo, 'memory');
    }""")
p.write_text(s)
PY
drive "retention becomes a sticky set on the watcher (candidate 1, as filed)"

echo
echo "################################################################"
echo "# ${reds} red, ${greens} green, ${uncompilable} refused by the compiler"
echo "################################################################"
echo
echo "A green above is a mutation the proof did not catch and is worth reading."
echo "A compiler refusal is NOT a red: the proof never saw that mutation."
exit 0
