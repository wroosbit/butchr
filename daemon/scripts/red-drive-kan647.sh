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
# ⚠ ARMS 1 AND 2 WERE FIRST WRITTEN AS `if (false && ...)` AND DID NOT COMPILE,
# which is worth recording rather than quietly fixing. TypeScript drops a
# narrowing inside a provably-unreachable branch, so `intent` — narrowed
# non-null forty lines above — went back to `DeployIntent | null` and
# `intent.by` errored. Both arms reported BUILD_EXIT=2 and no verdict, which was
# the correct outcome and not a broken arm. They are branch DELETIONS now, which
# is both the mutation a later author actually makes and one that compiles.
#
# Run from the repository root. It reverts each mutation before the next, and
# leaves the tree as it found it.

set -u
cd "$(dirname "$0")/../.."

SRC=daemon/src/deploy-ledger.ts
DAEMON=daemon/src/daemon.ts
GATE=daemon/scripts/announce-deploy-intent.mjs
PROOF=daemon/scripts/verify-deploy-ledger-is-unbypassable.mjs

# A revert that silently fails stacks the next mutation on top of this one, and
# the compiler errors that follow are then about a file nobody wrote. Checked
# rather than assumed — it happened on the first run of this script.
revert() {
  git checkout -- "$SRC" "$DAEMON" "$GATE" || { echo "REVERT FAILED — aborting"; exit 9; }
  git diff --quiet -- "$SRC" "$DAEMON" "$GATE" || { echo "REVERT LEFT THE TREE DIRTY — aborting"; exit 9; }
}
trap revert EXIT

arm() {
  local name="$1"; shift
  echo
  echo "======================================================================"
  echo "ARM: $name"
  echo "======================================================================"
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
  python3 -c "
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a = s[s.index('  if (pinned.length === 0 && mismatched.length === 0) {'):s.index('  if (mismatched.length > 0) {')]
s = s.replace(a, '', 1)
open(p,'w').write(s)
"
}

m2() {
  python3 -c "
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a = s[s.index('  if (mismatched.length > 0) {'):s.index(\"  return { kind: 'gated'\")]
s = s.replace(a, '', 1)
open(p,'w').write(s)
"
}

m3() {
  python3 -c "
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a='function consumeIntent(intentFile: string, consumedFile: string): string | null {'
assert s.count(a)==1
s=s.replace(a, a + '\n  if (intentFile) return null;', 1)
open(p,'w').write(s)
"
}

m4() {
  python3 -c "
p='daemon/src/daemon.ts'; s=open(p).read()
a='  announceToJournal(describeUngatedStart(deployRecord), logToFileOnly);'
assert s.count(a)==1
s=s.replace(a,'  for (const line of describeUngatedStart(deployRecord)) log(line);',1)
open(p,'w').write(s)
"
}

m5() {
  python3 -c "
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a = '''      hash.update(rel);
      hash.update('\\\\0');
      hash.update(fs.readFileSync(abs));
      hash.update('\\\\0');'''
assert s.count(a)==1, s.count(a)
s = s.replace(a, '''      hash.update(String(stat.mtimeMs));
      hash.update('\\\\0');''', 1)
open(p,'w').write(s)
"
}

m6() {
  python3 -c "
p='daemon/src/deploy-ledger.ts'; s=open(p).read()
a=\"  return start.kind === 'deploy' || start.kind === 'checkout-moved' || start.kind === 'indeterminate';\"
assert s.count(a)==1
s=s.replace(a,\"  return start.kind === 'checkout-moved' || start.kind === 'indeterminate';\",1)
open(p,'w').write(s)
"
}

m7() {
  python3 -c "
p='daemon/scripts/announce-deploy-intent.mjs'; s=open(p).read()
a='  intendedHead: build.head,\n  intendedDist: build.dist.digest,'
assert s.count(a)==1, s.count(a)
s=s.replace(a,'  intendedHead: null,\n  intendedDist: null,',1)
open(p,'w').write(s)
"
}

arm "1. judgeGate no longer refuses an intent that pins NOTHING" m1
arm "2. judgeGate no longer refuses an intent that names a DIFFERENT build" m2
arm "3. consumeIntent is a no-op — the intent gates the next start too" m3
arm "4. the ungated deploy goes to daemon.log only, not to fd 2" m4
arm "5. fingerprintDist hashes mtimes instead of bytes" m5
arm "6. changesTheRunningFleet says a deploy does not change the fleet" m6
arm "7. announce-deploy-intent.mjs stops pinning what it built" m7

revert
npm --prefix daemon run build > /tmp/kan647-build.log 2>&1
echo
echo "restored; BUILD_EXIT=$?"
