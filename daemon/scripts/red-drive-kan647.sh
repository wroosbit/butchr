#!/usr/bin/env bash
# KAN-647: watch `verify-deploy-ledger-is-unbypassable.mjs` fail, six ways.
#
# A gate nobody has watched fail has not been shown to be a gate. This applies
# each mutation named in that script's DRIVING IT RED block, rebuilds, runs the
# proof, and prints the arm's exit code beside the assertions that went red.
#
# ⚠ THE BUILD EXIT IS CHECKED BEFORE THE PROOF'S VERDICT IS READ, AND IT IS
# READ WITHOUT A PIPE. The proof imports from `dist`, so after a failed build it
# runs against the PREVIOUS build and both of its outcomes mislead: a pass reads
# as "my mutation was not caught", a fail credits the proof for a red the
# compiler produced. `npm run build | tail` would report `tail`'s status, which
# is how that trapdoor is usually walked into. An arm whose build fails is
# reported as NOT TESTABLE AS WRITTEN and needs a mutation that compiles — it is
# not a red.
#
# Run from the repository root. It reverts each mutation before the next, and
# leaves the tree as it found it.

set -u
cd "$(dirname "$0")/../.."

SRC=daemon/src/deploy-ledger.ts
DAEMON=daemon/src/daemon.ts
PROOF=daemon/scripts/verify-deploy-ledger-is-unbypassable.mjs

revert() { git checkout -- "$SRC" "$DAEMON"; }
trap revert EXIT

arm() {
  local name="$1"; shift
  echo
  echo "══════════════════════════════════════════════════════════════════════"
  echo "ARM: $name"
  echo "══════════════════════════════════════════════════════════════════════"
  revert
  "$@"
  npm --prefix daemon run build > /tmp/kan647-build.log 2>&1
  local build_exit=$?
  echo "BUILD_EXIT=$build_exit"
  if [ "$build_exit" -ne 0 ]; then
    echo "NOT TESTABLE AS WRITTEN — the mutation does not compile, so the proof would"
    echo "have run against the previous dist. Rewrite the mutation; do not re-run."
    tail -5 /tmp/kan647-build.log
    return
  fi
  node "$PROOF" > /tmp/kan647-proof.log 2>&1
  local proof_exit=$?
  echo "PROOF_EXIT=$proof_exit"
  grep -a "FAIL" /tmp/kan647-proof.log | head -12
  grep -aE "assertion\(s\) failed|All assertions passed" /tmp/kan647-proof.log | tail -1
}

m1() {
  python3 - <<'PY'
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a="""  if (pinned.length === 0 && mismatched.length === 0) {"""
assert s.count(a)==1
s=s.replace(a,"""  if (false && pinned.length === 0 && mismatched.length === 0) {""",1)
open(p,'w').write(s)
PY
}

m2() {
  python3 - <<'PY'
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a="""  if (mismatched.length > 0) {"""
assert s.count(a)==1
s=s.replace(a,"""  if (false && mismatched.length > 0) {""",1)
open(p,'w').write(s)
PY
}

m3() {
  python3 - <<'PY'
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a="""function consumeIntent(intentFile: string, consumedFile: string): string | null {
  try {"""
assert s.count(a)==1
s=s.replace(a,"""function consumeIntent(intentFile: string, consumedFile: string): string | null {
  if (intentFile) return null;
  try {""",1)
open(p,'w').write(s)
PY
}

m4() {
  python3 - <<'PY'
p='daemon/src/daemon.ts'; s=open(p).read()
a="""  announceToJournal(describeUngatedStart(deployRecord), logToFileOnly);"""
assert s.count(a)==1
s=s.replace(a,"""  for (const line of describeUngatedStart(deployRecord)) log(line);""",1)
open(p,'w').write(s)
PY
}

m5() {
  python3 - <<'PY'
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a="""      hash.update(rel);
      hash.update('\\0');
      hash.update(fs.readFileSync(abs));
      hash.update('\\0');"""
assert s.count(a)==1, s.count(a)
s=s.replace(a,"""      hash.update(String(stat.mtimeMs));
      hash.update('\\0');""",1)
open(p,'w').write(s)
PY
}

m6() {
  python3 - <<'PY'
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a="""  return start.kind === 'deploy' || start.kind === 'checkout-moved' || start.kind === 'indeterminate';"""
assert s.count(a)==1
s=s.replace(a,"""  return start.kind === 'checkout-moved' || start.kind === 'indeterminate';""",1)
open(p,'w').write(s)
PY
}

arm "1. judgeGate gates an intent that pins NOTHING" m1
arm "2. judgeGate gates an intent that names a DIFFERENT build" m2
arm "3. consumeIntent is a no-op — the intent gates the next start too" m3
arm "4. the ungated deploy goes to daemon.log only, not to fd 2" m4
arm "5. fingerprintDist hashes mtimes instead of bytes" m5
arm "6. changesTheRunningFleet says a deploy does not change the fleet" m6

revert
npm --prefix daemon run build > /tmp/kan647-build.log 2>&1
echo
echo "restored; BUILD_EXIT=$?"
