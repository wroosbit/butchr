#!/usr/bin/env bash
# KAN-465 red drive — reproducible by the reviewer, run from the repo root.
#
# WHAT IT ESTABLISHES, and why it takes two runs per script rather than one:
# a red proves the script noticed SOMETHING. It does not prove the recursion
# bought it. So each mutation is run twice — once against the converted script
# (expect RED) and once against the script exactly as `origin/main` has it
# (expect GREEN, because the flat sweep cannot see depth 2). The pair is the
# evidence; either half alone is not.
#
# Every mutation is asserted PRESENT ON DISK before the script is run, because a
# mutation that silently did not apply produces a green that reads as "the check
# is fine" — four such greens were fabricated on this board this week.
set -u

SCRATCH="$(mktemp -d)"
FAILED=0

banner() { printf '\n%s\n%s\n%s\n' "$(printf '=%.0s' {1..78})" "  $*" "$(printf '=%.0s' {1..78})"; }

# Stage the pre-KAN-465 version of a script beside the real one, so it resolves
# the same repoRoot off its own path.
stage_flat() {
  git show "origin/main:daemon/scripts/$1" > "daemon/scripts/kan465-flat-$1"
}

# Run a script, report its exit code, and classify it. The log path is left in
# LAST_LOG rather than echoed, so the caller can grep it without also capturing
# this function's own report.
LAST_LOG=""
run_expect() {
  local label="$1"
  local script="$2"
  local want="$3"
  local tag="$4"
  LAST_LOG="$SCRATCH/$(basename "$script").$tag.log"
  node "$script" > "$LAST_LOG" 2>&1
  local code=$?
  local got=RED
  [ "$code" -eq 0 ] && got=GREEN
  local ok='OK'
  if [ "$got" != "$want" ]; then ok='*** MISMATCH ***'; FAILED=1; fi
  printf '  %-46s exit=%-3s %-5s (want %-5s) %s\n' "$label" "$code" "$got" "$want" "$ok"
}

assert_present() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    printf '  edit asserted PRESENT in %s: %s\n' "$file" "$pattern"
  else
    printf '  *** EDIT DID NOT APPLY to %s — the run below would be a fabricated green ***\n' "$file"
    FAILED=1
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
banner '1. verify-notifications-never-type.mjs — a composer reach at depth 2'
# The defect this script exists to catch: a daemon module reaching for the
# composer, which types into a pane and presses Enter on whatever is already
# sitting in it. Planted in integrations/enablement.ts, four files deep in the
# blind spot.
cp daemon/src/integrations/enablement.ts "$SCRATCH/enablement.ts.orig"
cat >> daemon/src/integrations/enablement.ts <<'MUTATION'

export function kan465PlantedComposerReach(deps: { sendToAgent: (k: string) => void }): void {
  deps.sendToAgent('task/KAN-465');
}
MUTATION
assert_present daemon/src/integrations/enablement.ts 'deps.sendToAgent('

stage_flat verify-notifications-never-type.mjs
run_expect 'converted (recursive)' daemon/scripts/verify-notifications-never-type.mjs RED new
NEW_LOG="$LAST_LOG"
run_expect 'origin/main (flat)' daemon/scripts/kan465-flat-verify-notifications-never-type.mjs GREEN old
OLD_LOG="$LAST_LOG"
echo
echo '  what the converted script says:'
grep -E 'UNDECLARED|swept [0-9]+' "$NEW_LOG" | sed 's/^/    /'
echo '  what the flat script says (it cannot see the file at all):'
grep -E 'UNDECLARED|integrations' "$OLD_LOG" | sed 's/^/    /' \
  || echo '    (no line mentions integrations/ at all — enablement.ts was never read)'

cp "$SCRATCH/enablement.ts.orig" daemon/src/integrations/enablement.ts
rm -f daemon/scripts/kan465-flat-verify-notifications-never-type.mjs

# ─────────────────────────────────────────────────────────────────────────────
banner '2. verify-channel-meta-renderable.mjs — a non-string meta value at depth 2'
# The defect: a `meta` value that is not a string. The client fails its parse and
# discards THE WHOLE FRAME in silence, while the daemon records `delivered`.
cp daemon/src/integrations/launchdarkly.ts "$SCRATCH/launchdarkly.ts.orig"
cat >> daemon/src/integrations/launchdarkly.ts <<'MUTATION'

export const kan465PlantedFrame = {
  content: 'planted by the KAN-465 red drive',
  meta: { kan465Planted: true }
};
MUTATION
assert_present daemon/src/integrations/launchdarkly.ts 'kan465Planted: true'

stage_flat verify-channel-meta-renderable.mjs
run_expect 'converted (recursive)' daemon/scripts/verify-channel-meta-renderable.mjs RED new
NEW_LOG="$LAST_LOG"
run_expect 'origin/main (flat)' daemon/scripts/kan465-flat-verify-channel-meta-renderable.mjs GREEN old
OLD_LOG="$LAST_LOG"
echo
echo '  what the converted script says:'
grep -E 'kan465Planted|swept [0-9]+|meta literal\(s\) scanned' "$NEW_LOG" | sed 's/^/    /'
echo '  what the flat script says:'
grep -E 'kan465Planted|meta literal\(s\) scanned' "$OLD_LOG" | sed 's/^/    /'

cp "$SCRATCH/launchdarkly.ts.orig" daemon/src/integrations/launchdarkly.ts
rm -f daemon/scripts/kan465-flat-verify-channel-meta-renderable.mjs

# ─────────────────────────────────────────────────────────────────────────────
banner '3. the walker itself — its coverage control is not vacuous'
# The control compares the sweep against a SECOND, independently written
# recursive walk. A control that can only agree is not a control, so: break the
# sweep to depth 1 and require that the control notices, in the walker rather
# than in a caller.
cp daemon/scripts/lib/sweep-sources.mjs "$SCRATCH/sweep-sources.mjs.orig"
# The needle is the enumerator's WHOLE call, not the bare words `recursive: true`
# — the module's header discusses `recursive: true` in prose, and a mutation that
# edits a comment applies cleanly, changes nothing, and hands back a green.
#
# This needle has already gone stale once, which is the argument for the assert
# rather than a hypothetical about one: the enumerator moved from
# `encoding: 'utf8'` to `withFileTypes: true` and the old string stopped
# matching. The `assert` fired, `assert_present` printed EDIT DID NOT APPLY, and
# §3 was reported as a MISMATCH instead of as a pass. That is the whole reason
# a mutation is asserted before its script is trusted.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/scripts/lib/sweep-sources.mjs')
s = p.read_text()
needle = '.readdirSync(root, { recursive: true, withFileTypes: true })'
assert needle in s, 'MUTATION NEEDLE IS STALE — the enumerator has moved, fix the red drive'
s2 = s.replace(needle, '.readdirSync(root, { recursive: false, withFileTypes: true })')
assert s2 != s, 'MUTATION DID NOT APPLY'
p.write_text(s2)
PY
assert_present daemon/scripts/lib/sweep-sources.mjs 'recursive: false, withFileTypes: true'
run_expect 'walker forced flat -> control must fire' daemon/scripts/verify-channel-meta-renderable.mjs RED flatwalk
echo
echo '  what the control says when the sweep it controls goes flat:'
grep -E '1s |swept [0-9]+|DISAGREE' "$LAST_LOG" | sed 's/^/    /'
cp "$SCRATCH/sweep-sources.mjs.orig" daemon/scripts/lib/sweep-sources.mjs

# ─────────────────────────────────────────────────────────────────────────────
banner 'restored — the tree must be clean again'
git status --porcelain daemon/src daemon/scripts | sed 's/^/  /'
echo "  (any line above other than the KAN-465 changes themselves is a leak)"

printf '\n%s\n' "$([ "$FAILED" -eq 0 ] && echo 'RED DRIVE: every expectation met.' || echo 'RED DRIVE: *** AN EXPECTATION WAS NOT MET ***')"
rm -rf "$SCRATCH"
exit "$FAILED"
