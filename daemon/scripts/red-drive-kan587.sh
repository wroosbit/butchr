#!/usr/bin/env bash
#
# KAN-587's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
# and where demonstrating the failure needs a recipe, the recipe is part of the
# proof because the reviewer has to be able to reproduce the red as well as the
# green. This is that recipe.
#
# WHAT IT DRIVES: §6 of `daemon/scripts/verify-atlassian-proxy-write-scope.mjs`,
# specifically the assertion `router.ts applies the write policy on every
# proxied call`, before and after KAN-587.
#
# ---------------------------------------------------------------------------
# WHY THERE ARE TWO ASSERTIONS IN EVERY ARM
# ---------------------------------------------------------------------------
# The point of KAN-587 is not that the old assertion was noisy. It is that it
# measured the WRONG THING — proximity of two strings — while its failure
# message asserted a security property was absent. So every arm below evaluates
# BOTH:
#
#   OLD  the assertion exactly as it stood at origin/main, reconstructed here as
#        a literal regex so the arm can show what it WOULD have said. It is
#        written out in this script rather than read from git, so this drive
#        needs no second checkout and no pre-fix build.
#   NEW  the real, current §6, run as the whole verify script.
#
# A fix is only worth having if those two disagree somewhere. Arm 1 is where
# they disagree, and it is the discriminating arm.
#
# ---------------------------------------------------------------------------
# THE ARMS
# ---------------------------------------------------------------------------
#   ARM 0  unmutated tree — both green. The positive control. Without it a red
#          in arm 1 could be this script failing to run rather than the check
#          failing to pass.
#
#   ARM 1  DELETE the `refuseWriteOutsideCaller(...)` call from the body of
#          `handleAtlassianProxyCall`. This is KAN-587 acceptance criterion 1 —
#          the failure the assertion exists to catch, which nobody had driven.
#            NEW -> FAIL, and that is the correct red.
#            OLD -> PASS, and that is a FALSE GREEN: the exact defect its own
#                   message names could not turn it red.
#          The old regex is satisfied by ANY occurrence of the method name, and
#          `router.ts` holds several — the call site, a docblock, the definition.
#          The docblock is the one KAN-577 wrote to explain the false red, and it
#          named `handleAtlassianProxyCall` and `refuseWriteOutsideCaller(` a
#          couple of hundred characters apart. So the old assertion matched
#          PROSE, and went on matching it with the policy call deleted outright.
#
#          THE ARM EVALUATES OLD TWICE: once on the working tree, and once on
#          `origin/main`'s own `router.ts` with the same deletion applied. The
#          second is the one that matters, because THIS branch rewrites the very
#          docblock that does the rescuing — a demonstration that moved when the
#          docblock moved would be a demonstration about the fix rather than
#          about the defect.
#
#   ARM 2  INSERT 700+ characters of comment inside the handler, immediately
#          above the policy call — KAN-587 acceptance criterion 2, the shape
#          that reddened this check for KAN-577 in the first place.
#            NEW -> PASS. A comment inside the body moves nothing out of it.
#            OLD -> PASS TODAY, and the arm prints the distances that say why
#                   rather than leaving it as a claim. At the definition the
#                   distance blows the 3000 window; a docblock match then
#                   rescues it. On the tree KAN-587 was filed from there was no
#                   such rescue and this arm was the false red.
#
# ⚠ READ ARM 2's OLD RESULT AS THE FINDING IT IS, NOT AS A FAILED REPRODUCTION.
# The ticket describes a false RED. What was on origin/main by the time the work
# started is a permanent false GREEN, because the comment written to explain the
# false red pinned the check green from a docblock. Same root cause, opposite
# symptom, worse consequence — which is why arm 1 rather than arm 2 is what
# discriminates a real fix from raising 3000 to 5000. A widened window is still
# green in arm 1.
#
# ---------------------------------------------------------------------------
# WHAT THIS DOES NOT COVER
# ---------------------------------------------------------------------------
#   * It says nothing about whether the write policy is CORRECT. That is §§1-5
#     of the verify script and `refuseWriteOutsideCaller`'s own tests; KAN-587
#     is explicit that the policy is out of scope and not in question.
#   * It drives one assertion. The two siblings — the identity argument and the
#     ordering — are re-pointed at the same body by KAN-587 and go red in arm 1
#     alongside it, which this script prints but does not separately drive.
#   * It rebuilds between arms so the whole verify script's exit code is
#     readable. The AC1 mutation compiles cleanly (measured: tsc exits 0), so
#     no arm here is reading a verdict off a stale `dist` — the very trap
#     `prompts/task.md` names. `rebuild` stops the run if the build did not
#     exit 0, and reads that status directly rather than through a pipe.
#
# NOT A `verify-` SCRIPT, deliberately, and named so it cannot be mistaken for
# one: it mutates `daemon/src/router.ts` and rebuilds. `sweep-verify-exit-paths.mjs`
# and the CI partition both key off the `verify-` prefix, and a script that
# mutates the tree has no business in a set CI runs unattended.
#
# It restores router.ts and rebuilds on EXIT, including on Ctrl+C. If it is
# killed with -9:
#
#   git checkout daemon/src/router.ts && npm --prefix daemon run build
#
# Usage:  bash daemon/scripts/red-drive-kan587.sh          (from the repo root)

set -u

VERIFY=daemon/scripts/verify-atlassian-proxy-write-scope.mjs
ROUTER=daemon/src/router.ts
MUTATE=daemon/scripts/lib/kan587-mutate-router.py
ASSERTION='router.ts applies the write policy on every proxied call'

for f in "$VERIFY" "$ROUTER" "$MUTATE"; do
  if [ ! -f "$f" ]; then
    echo "run this from the repository root — $f not found" >&2
    exit 2
  fi
done

BACKUP="$(mktemp)"
cp "$ROUTER" "$BACKUP"

restore() {
  cp "$BACKUP" "$ROUTER"
  rm -f "$BACKUP"
  npm --prefix daemon run build >/dev/null 2>&1
  echo
  echo "restored $ROUTER and rebuilt."
}
trap restore EXIT

# The build's exit status, by a route that reports it. `npm run build | tail`
# yields tail's status, which is how this repository has twice recorded
# BUILD_EXIT=0 for a build that had just failed.
rebuild() {
  npm --prefix daemon run build >/dev/null 2>&1
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "  BUILD FAILED (exit $code) — the mutation is not testable as written."
    echo "  Not reading any verdict off a stale dist. Stopping."
    exit 1
  fi
  echo "  build exit 0"
}

# The assertion as it stood at origin/main before KAN-587, evaluated on whatever
# file it is handed. Node rather than grep: this is a regex over the whole file,
# and `[\s\S]{0,3000}` is not something a line-oriented tool can express.
old_assertion() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const hit = /handleAtlassianProxyCall[\s\S]{0,3000}refuseWriteOutsideCaller\(/.test(src);
    console.log("  OLD  " + (hit ? "PASS" : "FAIL") + "   <- " + process.argv[2]);
  ' "$1" "$2"
}

# The false green where the claim actually lives: origin/main's own router.ts,
# with the policy call deleted, judged by origin/main's own assertion.
old_assertion_on_main_without_the_call() {
  local tmp
  tmp="$(mktemp --suffix=.ts)"
  if ! git show origin/main:daemon/src/router.ts > "$tmp" 2>/dev/null; then
    echo "  OLD  (skipped — no origin/main:daemon/src/router.ts; run 'git fetch origin')"
    echo "       NOTE: no depth flag on that fetch. A shallow fetch inside a worktree"
    echo "       grafts the SHARED clone for every agent on this machine."
    rm -f "$tmp"
    return
  fi
  if python3 "$MUTATE" delete "$tmp" >/dev/null; then
    old_assertion "$tmp" "origin/main's router.ts, policy call deleted"
  else
    echo "  OLD  (skipped — origin/main's router.ts no longer holds that exact block)"
  fi
  rm -f "$tmp"
}

# Every occurrence of the method name and how far the next policy call sits from
# it. This is what makes arm 2 a measurement rather than an assertion.
distances() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const all = (needle) => {
      const out = [];
      for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
      return out;
    };
    const lineOf = (i) => src.slice(0, i).split("\n").length;
    const policy = all("refuseWriteOutsideCaller(");
    for (const h of all("handleAtlassianProxyCall")) {
      const next = policy.find((p) => p > h);
      const d = next === undefined ? Infinity : next - h;
      console.log(
        "    name at line " + String(lineOf(h)).padStart(5) +
        " -> next policy call " + String(d).padStart(6) + " chars away" +
        (d <= 3000 ? "   <= 3000, satisfies the old window" : "")
      );
    }
  ' "$1"
}

# The one §6 line, by name. The verify script imports from dist AND reads src as
# text, so its exit code is a blend; `prompts/task.md` says read the section
# rather than the exit code. Both are printed, and the section is the verdict.
new_assertion() {
  local out code
  out="$(node "$VERIFY" 2>&1)"
  code=$?
  echo "$out" | grep -F "$ASSERTION" | sed 's/^ */  NEW  /'
  echo "  (whole script exit $code)"
}

echo "==========================================================================="
echo "KAN-587 red drive — §6 'applies the write policy', old window vs new body"
echo "==========================================================================="
echo
echo "--- ARM 0: unmutated tree (positive control) ------------------------------"
rebuild
distances "$ROUTER"
old_assertion "$ROUTER" "working tree"
new_assertion
echo
echo "    Both green. So a red below is the mutation, not this script."

echo
echo "--- ARM 1: policy call DELETED from the handler body (AC1) ----------------"
if ! python3 "$MUTATE" delete "$ROUTER"; then
  echo "  could not delete the policy call — router.ts has moved on; re-point this arm."
  exit 1
fi
rebuild
distances "$ROUTER"
old_assertion "$ROUTER" "working tree"
old_assertion_on_main_without_the_call
new_assertion
echo
echo "    NEW goes red — the failure this assertion exists to catch."
echo "    OLD stays green with the call DELETED, on this branch AND on origin/main."
echo "    That is the false green, and it is why widening 3000 to 5000 is not a"
echo "    fix: a wider window sits here too. The rescuing match is a DOCBLOCK."

cp "$BACKUP" "$ROUTER"

echo
echo "--- ARM 2: 700+ chars of comment INSIDE the handler, above the call (AC2) --"
if ! python3 "$MUTATE" pad "$ROUTER"; then
  echo "  could not pad above the policy call — router.ts has moved on."
  exit 1
fi
rebuild
distances "$ROUTER"
old_assertion "$ROUTER" "working tree"
new_assertion
echo
echo "    NEW stays green — a comment inside the body moves nothing out of it."
echo "    OLD's verdict here is the finding, not a failed reproduction: read the"
echo "    distances above. The definition is now past 3000, and a DOCBLOCK match"
echo "    is what holds it green. On the tree this ticket was filed from there"
echo "    was no such rescue and this arm was the false red."
