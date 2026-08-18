#!/usr/bin/env bash
#
# KAN-522's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
# and where demonstrating the failure needs a recipe, the recipe is part of the
# proof because the reviewer has to be able to reproduce the red as well as the
# green. This is that recipe, and it is acceptance criterion 3 — "it must be
# watched going red before it is trusted."
#
# WHAT IT DRIVES: `daemon/scripts/verify-search-keeps-every-issue.mjs`.
#
# THE PROOF IMPORTS FROM `dist`, SO EVERY ARM REBUILDS AND READS THE BUILD'S OWN
# EXIT CODE FIRST. `prompts/task.md` again, and it is the trapdoor this file was
# most likely to fall through: a proof run after a failed build ran against the
# PREVIOUS `dist`, so its verdict — pass or fail — is evidence about code nobody
# wrote, and BOTH outcomes mislead. A red would then credit the wrong mechanism.
# So every mutation below is chosen to COMPILE, the build is never piped (a pipe
# yields `tail`'s status, not the compiler's), and an arm whose build exits
# non-zero is reported as INCONCLUSIVE rather than as a red.
#
# ARM 0 IS THE DISCRIMINATING ONE AND IT RUNS FIRST. It shows the proof refusing
# to answer at all against a `dist` older than `src` — because a check that
# cannot tell yesterday's build from today's would go green forever, and every
# red below would be a claim about the wrong tree.
#
# NOT A `verify-` SCRIPT, deliberately: it mutates tracked source. Both CI
# sweeps and the CI partition key off the `verify-` prefix, and a script that
# rewrites `daemon/src` has no business in a set CI runs unattended.
#
# It restores every file on EXIT, including on Ctrl+C. If it is killed with -9:
#
#   git checkout daemon/src/atlassian-proxy.ts daemon/src/mcp-response-budget.ts
#   npm run build --prefix daemon
#
# Usage:  bash daemon/scripts/red-drive-kan522.sh          (from the repo root)

set -u

PROOF=daemon/scripts/verify-search-keeps-every-issue.mjs
PROXY=daemon/src/atlassian-proxy.ts
BUDGET=daemon/src/mcp-response-budget.ts

if [ ! -f "$PROOF" ] || [ ! -f "$PROXY" ] || [ ! -f "$BUDGET" ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan522.sh" >&2
  exit 2
fi

BAK=$(mktemp -d)
cp "$PROXY" "$BAK/proxy.ts"
cp "$BUDGET" "$BAK/budget.ts"
restore() { cp "$BAK/proxy.ts" "$PROXY"; cp "$BAK/budget.ts" "$BUDGET"; }
trap 'restore; npm run build --prefix daemon > /dev/null 2>&1; rm -rf "$BAK"' EXIT

caught=0
wrong=0
inconclusive=0

# Rebuild, and report the COMPILER's exit code. Never piped, for the reason in
# the header. Returns non-zero if the build failed.
rebuild() {
  npm run build --prefix daemon > "$BAK/build.log" 2>&1
  local rc=$?
  echo "  \$ npm run build --prefix daemon"
  echo "      BUILD_EXIT=$rc"
  if [ $rc -ne 0 ]; then
    tail -12 "$BAK/build.log" | sed 's/^/      /'
  fi
  return $rc
}

# Run the proof as its own command and report ITS exit status.
run_proof() {
  node "$PROOF" > "$BAK/out.log" 2>&1
  local rc=$?
  echo "  \$ node $PROOF"
  grep -E 'FAIL|CHECK\(S\) FAILED|ALL CHECKS PASSED|dist' "$BAK/out.log" | head -12 | sed 's/^/      /'
  echo "      EXIT=$rc"
  return $rc
}

arm() {
  echo
  echo "################################################################"
  echo "# $1: $2"
  echo "################################################################"
}

expect_red() {
  if ! rebuild; then
    echo "  -> INCONCLUSIVE. The mutation did not compile, so the proof would have run"
    echo "     against the previous dist and its verdict would be about code nobody wrote."
    echo "     A mutation that does not compile is not testable as written."
    inconclusive=$((inconclusive + 1))
    restore
    return
  fi
  run_proof
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "  -> RED, as it must be."
    caught=$((caught + 1))
  else
    echo "  -> GREEN. THE MUTATION SURVIVED — the proof does not hold this property."
    wrong=$((wrong + 1))
  fi
  restore
}

expect_green() {
  if ! rebuild; then
    echo "  -> INCONCLUSIVE: the control did not compile."
    inconclusive=$((inconclusive + 1))
    restore
    return
  fi
  run_proof
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "  -> GREEN, as it must be. The proof asserts the PROPERTY and not the number."
  else
    echo "  -> RED. FALSE POSITIVE — the proof is pinned to an implementation detail."
    wrong=$((wrong + 1))
  fi
  restore
}

# ---------------------------------------------------------------------------
arm "ARM 0" "DISCRIMINATING CONTROL — a stale dist must not be answerable"
# ---------------------------------------------------------------------------
# Before any red below is worth reading, the proof has to be unable to answer
# off a build that predates the source. Touch src, do NOT rebuild, and it must
# refuse. Without this, every arm's verdict could be about yesterday's dist.
touch "$PROXY"
run_proof
rc=$?
if [ $rc -ne 0 ] && grep -qi 'dist' "$BAK/out.log"; then
  echo "  -> REFUSED, as it must. Its verdicts below are about the tree in front of it."
  caught=$((caught + 1))
else
  echo "  -> IT ANSWERED ANYWAY. Every red below may be about a stale build."
  wrong=$((wrong + 1))
fi
rebuild > /dev/null

# ---------------------------------------------------------------------------
arm "ARM 1" "the budget deletes an over-budget list instead of trimming it"
# ---------------------------------------------------------------------------
# This is the state of `origin/main`: an array that will not fit is replaced by
# a stub, so a search that found sixty issues answers with none of them. The
# assertion it must turn red is §4's "ISSUES CAME BACK".
sed -i 's/if (Array.isArray(raw) \&\& raw.length > 0) {/if (Array.isArray(raw) \&\& raw.length < 0) {/' "$BUDGET"
expect_red

# ---------------------------------------------------------------------------
arm "ARM 2" "the search transform is off — Jira's raw rows reach the budget"
# ---------------------------------------------------------------------------
# Also the state of `origin/main`. A raw row is ~2,900 characters here, so the
# ceiling collapses to about three issues and §2 loses every condensing claim.
sed -i "s/if ('error' in format || format.format === 'raw') return page;/if ('error' in format || format.format === 'condensed') return page;/" "$PROXY"
expect_red

# ---------------------------------------------------------------------------
arm "ARM 3" "the transform drops entries instead of saying less about each"
# ---------------------------------------------------------------------------
# ⚠ THE MUTATION ACCEPTANCE CRITERION 3 NAMES IN AS MANY WORDS: "a check that
# fails if a search large enough to clip loses an entry that summarising would
# have kept." The answer still FITS — it is small, well-formed, and wrong, which
# is the failure mode nothing else on this board catches.
sed -i 's/issues: issues.map(condenseSearchIssue)/issues: issues.slice(0, 5).map(condenseSearchIssue)/' "$PROXY"
expect_red

# ---------------------------------------------------------------------------
arm "ARM 4" "an empty prefix is allowed to count as 'trimmed'"
# ---------------------------------------------------------------------------
# The subtle one. `issues: []` is inside budget, carries a completeness block,
# and reports its arithmetic honestly — and reads as a search that found
# nothing, which is KAN-423's defect rebuilt inside the fix for KAN-522.
sed -i 's/      if (lo > 0) {/      if (lo >= 0) {/' "$BUDGET"
expect_red

# ---------------------------------------------------------------------------
arm "ARM 5" "NEGATIVE CONTROL — the same property, a different number of rows"
# ---------------------------------------------------------------------------
# Clamp the trim to at most ten entries. Fewer issues come back than the binary
# search would have kept, and every property §4 asserts still holds: non-empty,
# arithmetic exact, envelope readable. A proof that went red here would be
# pinned to 21 rather than to "entries came back".
sed -i 's/      let hi = total;/      let hi = Math.min(total, 10);/' "$BUDGET"
expect_green

echo
echo "################################################################"
echo "# ${caught} red(s) as required, ${wrong} unexpected, ${inconclusive} inconclusive"
echo "################################################################"
[ "$wrong" -eq 0 ] && [ "$inconclusive" -eq 0 ] && [ "$caught" -eq 5 ]
exit $?
