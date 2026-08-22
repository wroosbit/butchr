#!/usr/bin/env bash
#
# KAN-633's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
# and where demonstrating the failure needs a recipe, the recipe is part of the
# proof because the reviewer has to be able to reproduce the red as well as the
# green. This is that recipe.
#
# WHAT IT DRIVES: `daemon/scripts/verify-supervised-write-scope.mjs`, and
# specifically the two properties that are load-bearing for the widening.
#
# ---------------------------------------------------------------------------
# WHY THESE TWO ARMS AND NOT OTHERS
# ---------------------------------------------------------------------------
# The widening's whole safety rests on two claims, and each has a failure the
# other cannot catch:
#
#   1. **The second gate is called.** `refuseWriteOutsideCaller` returns `null`
#      for a cross-ticket `supervised-ticket` target BY DESIGN, so deleting the
#      supervision call from `router.ts` does not make anything refuse — it
#      makes `atlassian_transition_issue` and `atlassian_add_comment` writable
#      against any issue in the site, silently, with every unit assertion about
#      the gate still green. That is the exposure KAN-587 established for the
#      first gate, and arm 1 is the same drive pointed at the second.
#
#   2. **The gate refuses.** A gate that answered `null` for everything would
#      pass every "the approver is permitted" check in the script and leave the
#      grant unbounded. Arm 2 makes the decision unconditional and shows the
#      refusal checks are what notice.
#
# ---------------------------------------------------------------------------
# THE ARMS
# ---------------------------------------------------------------------------
#   ARM 0  unmutated tree — green. The positive control. Without it a red in
#          arm 1 or 2 could be this script failing to run rather than a check
#          failing to pass.
#
#   ARM 1  DELETE the `refuseWriteOutsideSupervision(...)` block from the body
#          of `handleAtlassianProxyCall`. §5 must go RED. Note what does NOT go
#          red: every section that imports `dist` stays green, because the gate
#          itself is untouched and still decides correctly when asked. That is
#          the point — the defect is that nothing asks it.
#
#   ARM 2  MAKE THE RELATION CHECK UNCONDITIONAL — the board is still read, and
#          whatever it says the caller is treated as the approver. §4 must go
#          RED on its `not-your-supervisee` checks, and must STAY GREEN on its
#          fail-closed ones, because this mutation does not touch that branch.
#          A red in both would mean the arm broke the script rather than the
#          property.
#
#          IT IS THIS MUTATION AND NOT THE OBVIOUS ONE, and the reason is worth
#          the two lines. The first attempt injected `return null;` as the
#          gate's first statement — and the build failed with fourteen errors,
#          because an early return makes the rest of the body unreachable and
#          TypeScript's narrowing of `caller` and of the board's tagged union
#          collapses with it. A failed build means the mutation is not testable
#          as written: §4 reads `dist`, so it would have tested the previous
#          build and printed a verdict about code nobody wrote. The correct move
#          is a mutation that compiles, which is this one.
#
#          This arm rebuilds, because the mutation is in TypeScript and §4 reads
#          `dist`; arm 1's mutation is read as source text and needs no build.
#
# Both arms restore the file with `git checkout` in an EXIT trap, so an
# interrupted run does not leave a mutated tree.
#
# Usage: bash daemon/scripts/red-drive-kan633.sh
# This is a red-drive helper: it is never imported by a verify script and it
# proves no product behaviour on its own.

set -u

cd "$(dirname "$0")/../.." || exit 1
ROUTER=daemon/src/router.ts
PROXY=daemon/src/atlassian-proxy.ts
VERIFY=daemon/scripts/verify-supervised-write-scope.mjs

restore() {
  git checkout -- "$ROUTER" "$PROXY" 2>/dev/null
}
trap restore EXIT

if ! git diff --quiet -- "$ROUTER" "$PROXY"; then
  echo "REFUSING: $ROUTER or $PROXY has uncommitted changes, and this script restores"
  echo "them with 'git checkout --'. Commit or stash first; nothing was mutated."
  exit 2
fi

build() {
  ( cd daemon && npm run build ) > /tmp/kan633-build.log 2>&1
  # Read the compiler's own status. NOT through a pipe: `npm run build | tail`
  # yields tail's status and reports a failed build as 0, which is the trapdoor
  # `prompts/task.md` names and which this script would otherwise walk into.
  return $?
}

run_verify() {
  node "$VERIFY" > /tmp/kan633-verify.log 2>&1
  echo $?
}

section_result() {
  # $1 = section heading prefix, e.g. "5." — prints FAIL if any check under it
  # failed, PASS otherwise. Reads the log the last run_verify wrote.
  awk -v want="$1" '
    /^[0-9]+[a-z]?\. / { insec = (index($0, want) == 1) }
    insec && /   FAIL / { bad = 1 }
    END { print (bad ? "FAIL" : "PASS") }
  ' /tmp/kan633-verify.log
}

echo "════════════════════════════════════════════════════════════════════════"
echo "ARM 0 — unmutated tree. Both properties must be green, or nothing below"
echo "        means anything."
echo "════════════════════════════════════════════════════════════════════════"
if ! build; then
  echo "  BUILD FAILED on the unmutated tree — see /tmp/kan633-build.log."
  echo "  Stopping: a verdict read after a failed build is evidence about the"
  echo "  previous build, which is the rule this drive is written under."
  exit 1
fi
ARM0=$(run_verify)
echo "  verify exit: $ARM0   §4 (the decision): $(section_result '4.')   §5 (the wiring): $(section_result '5.')"
if [ "$ARM0" -ne 0 ]; then
  echo "  ARM 0 is not green. Fix that before reading a red as a demonstration."
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "ARM 1 — delete the supervision gate from handleAtlassianProxyCall."
echo "        Expect: §5 FAIL. Expect §4 to stay PASS — the gate still works,"
echo "        nothing calls it, and that is exactly the invisible failure."
echo "════════════════════════════════════════════════════════════════════════"
python3 - "$ROUTER" <<'PY'
import io, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()
start = src.find('    const supervisionRefusal = await refuseWriteOutsideSupervision(')
if start == -1:
    sys.stderr.write('  anchor not found in %s — writing nothing.\n' % path)
    sys.exit(1)
end = src.find('    }\n', src.find('if (supervisionRefusal) {', start))
if end == -1:
    sys.stderr.write('  end of the refusal block not found — writing nothing.\n')
    sys.exit(1)
io.open(path, 'w', encoding='utf-8').write(src[:start] + src[end + len('    }\n'):])
print('  deleted the refuseWriteOutsideSupervision(...) block from the handler')
PY
if [ $? -ne 0 ]; then
  echo "  MUTATION FAILED — router.ts has moved on. Nothing was demonstrated."
  exit 1
fi
run_verify > /dev/null
echo "  §4 (the decision): $(section_result '4.')   §5 (the wiring): $(section_result '5.')"
restore

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "ARM 2 — make the relation check unconditional: every board answer is"
echo "        treated as naming the caller. Expect: §4 FAIL on its"
echo "        not-your-supervisee checks. This arm rebuilds, because §4 reads dist."
echo "════════════════════════════════════════════════════════════════════════"
python3 - "$PROXY" <<'PY'
import io, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()
anchor = '  if (seen.parent === mine || seen.linkedStories.includes(mine)) return null;'
if src.count(anchor) != 1:
    sys.stderr.write(
        '  the relation check occurs %d times, expected 1 — writing nothing.\n' % src.count(anchor)
    )
    sys.exit(1)
mutated = (
    '  if (seen.parent === mine || seen.linkedStories.includes(mine) '
    '|| target.length > 0) return null;'
)
# `target.length > 0` is always true at run time and NOT provably so to the
# compiler, which is the whole trick: `if (seen.ok)` would have narrowed the
# trailing refusal's `seen` to `never` and failed the build, and a mutation
# that does not compile is not testable as written.
io.open(path, 'w', encoding='utf-8').write(src.replace(anchor, mutated))
print('  the relation check now permits whatever the board answered')
PY
if [ $? -ne 0 ]; then
  echo "  MUTATION FAILED — atlassian-proxy.ts has moved on. Nothing was demonstrated."
  exit 1
fi
if ! build; then
  echo "  BUILD FAILED on the mutated tree — see /tmp/kan633-build.log."
  echo "  A mutation that does not compile is not testable as written: the"
  echo "  verify run below would test the PREVIOUS dist and its verdict would"
  echo "  be evidence about code nobody wrote. Not run."
  exit 1
fi
run_verify > /dev/null
echo "  §4 (the decision): $(section_result '4.')   §5 (the wiring): $(section_result '5.')"
echo "  and the discriminating detail — which checks reddened:"
grep '   FAIL ' /tmp/kan633-verify.log | sed 's/^/    /'
restore

echo
echo "Restoring the tree and rebuilding, so the checkout is left as it was found."
build || echo "  WARNING: the restoring build failed — see /tmp/kan633-build.log."
echo "Done."
