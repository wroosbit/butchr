#!/usr/bin/env bash
#
# KAN-473's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
# and where demonstrating the failure needs a recipe, the recipe is part of the
# proof because the reviewer has to be able to reproduce the red as well as the
# green. This is that recipe. Every mutation is applied to THIS branch's source,
# so no pre-fix build and no second worktree is needed.
#
# WHAT IT DRIVES: `verify-ambiguous-key-refusal.mjs`. The ticket's criterion 4
# is "a mutation that restores the pick-one behaviour must go red", and each
# mutation below is a different way of arriving back at that behaviour — the
# rule itself, the destructive handler, the read handlers, and the disclosure.
#
# NOT A `verify-` SCRIPT, deliberately, and named so it cannot be mistaken for
# one: it edits `daemon/src` in place and rebuilds. `sweep-verify-exit-paths.mjs`
# and the CI partition both key off the `verify-` prefix, and a script that
# mutates the tree has no business in a set CI runs unattended.
#
# It restores every file on EXIT, including on Ctrl+C. If it is killed with -9,
# `git checkout daemon/src/herdr.ts daemon/src/router.ts` puts them back.
#
# Usage:  bash daemon/scripts/red-drive-kan473.sh          (from the repo root)

set -u

if [ ! -f daemon/src/herdr.ts ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan473.sh" >&2
  exit 2
fi

HB=daemon/src/herdr.ts
RT=daemon/src/router.ts
MC=daemon/src/mcp.ts
BAK=$(mktemp -d)
cp $HB "$BAK/herdr.ts"
cp $RT "$BAK/router.ts"
cp $MC "$BAK/mcp.ts"
restore() { cp "$BAK/herdr.ts" $HB; cp "$BAK/router.ts" $RT; cp "$BAK/mcp.ts" $MC; }
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
  # that never ran, and a red credits the wrong mechanism. This proof imports
  # from `dist/`, so the rule binds on it in full.
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

  node daemon/scripts/verify-ambiguous-key-refusal.mjs > "$BAK/proof.log" 2>&1
  local proof=$?
  echo "PROOF_EXIT=$proof"
  if [ $proof -ne 0 ]; then reds=$((reds + 1)); else greens=$((greens + 1)); fi
  grep -E "✗ FAILED|VERDICT:" "$BAK/proof.log" | sed 's/^/    /'
  restore
}

# --- 1 -----------------------------------------------------------------------
# THE DEFECT ITSELF, restored at the one place the rule now lives: a key that
# matches several agents answers with the first of them and says nothing about
# the others. This is `getSessionByKey` reinstated in the shared resolver, and
# every mutation below is a way of arriving back at it by another route.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/herdr.ts'); s = p.read_text()
old = """  if (matches.length === 0) return { outcome: 'none' };
  if (matches.length === 1) return { outcome: 'one', session: matches[0] };
  return {
    outcome: 'ambiguous',
    candidates: matches.map(s => agentNameFor(s.type, s.key)).sort()
  };"""
new = """  if (matches.length === 0) return { outcome: 'none' };
  return { outcome: 'one', session: matches[0] };"""
assert old in s, 'mutation 1 no longer matches the source'
p.write_text(s.replace(old, new))
PY
drive "the shared rule picks the first match again (the defect, verbatim)"

# --- 2 -----------------------------------------------------------------------
# THE DESTRUCTIVE HANDLER ALONE. The rule is left correct and the stand-down
# stops consulting it — an author "simplifying" the refusal away, or restoring
# the pre-KAN-473 call, gets exactly this. It is the mutation that matters most:
# a green here would mean the proof is testing the rule and not the verb, and
# the verb is what destroys an agent.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/router.ts'); s = p.read_text()
old = """    if (resolution.outcome === 'ambiguous') {
      respond({
        action: 'deactivate_response',
        success: false,
        key,
        refusedBy: 'ambiguous-key',
        candidates: resolution.candidates,
        error: ambiguousKeyMessage(key, resolution.candidates)
      });
      return;
    }

    const session = resolution.outcome === 'one' ? resolution.session : undefined;"""
new = """    const session =
      resolution.outcome === 'one'
        ? resolution.session
        : resolution.outcome === 'ambiguous'
          ? this.herdrBridge
              .listActiveSessions()
              .find(s => s.key === key)
          : undefined;"""
assert old in s, 'mutation 2 no longer matches the source'
p.write_text(s.replace(old, new))
PY
drive "the stand-down picks one of the candidates instead of refusing"

# --- 3 -----------------------------------------------------------------------
# THE READ HANDLER ALONE, and this is the half the ticket calls "arguably worse
# for correctness work": a status that answers about the wrong agent leaves no
# tell. Nothing is destroyed by this mutation, `success` is `true`, and the
# response is well-formed — which is exactly why a proof has to assert on it
# rather than trusting that somebody would notice.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/router.ts'); s = p.read_text()
old = """      if (resolution.outcome === 'ambiguous') {
        respond({
          action: 'agent_status_response',
          success: false,
          key,
          refusedBy: 'ambiguous-key',
          candidates: resolution.candidates,
          error: ambiguousKeyMessage(key, resolution.candidates)
        });
        return;
      }

      if (resolution.outcome === 'one') {
        const session = resolution.session;"""
new = """      const anySession =
        resolution.outcome === 'one'
          ? resolution.session
          : this.herdrBridge.listActiveSessions().find(s => s.key === key);

      if (anySession) {
        const session = anySession;"""
assert old in s, 'mutation 3 no longer matches the source'
p.write_text(s.replace(old, new))
PY
drive "the status read answers about whichever agent it reaches, silently"

# --- 4 -----------------------------------------------------------------------
# THE DISCLOSURE, deleted while both refusals stay intact. This is the weakest
# mutation on purpose: it changes no behaviour a caller can be destroyed by, and
# it is the one an author is most likely to make while tidying. If §6 does not
# go red on it, the `addressedBy` field is decorative and the proof is not
# holding it to anything.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/router.ts'); s = p.read_text()
old = "          addressedBy: type ? 'key-and-type' : 'key-only',\n          ...this.toAgentDto("
new = "          ...this.toAgentDto("
assert old in s, 'mutation 4 no longer matches the source'
p.write_text(s.replace(old, new))
PY
drive "a bare-key read stops saying that its type was inferred"

# --- 5 -----------------------------------------------------------------------
# THE CANDIDATE LIST, emptied while the refusal itself stands. The call is still
# refused and nothing is destroyed — but the caller is told only that it could
# not, never which agents collided, so it cannot fix its own call. This is what
# the state was before this ticket for `send_to_agent`, which always refused and
# never said what it had refused about.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/herdr.ts'); s = p.read_text()
old = """  constructor(key: string, candidates: readonly string[]) {
    super(ambiguousKeyMessage(key, candidates));
    this.name = 'AmbiguousKeyError';
    this.candidates = [...candidates];
  }"""
new = """  constructor(key: string, candidates: readonly string[]) {
    super(ambiguousKeyMessage(key, candidates));
    this.name = 'AmbiguousKeyError';
    this.candidates = [];
  }"""
assert old in s, 'mutation 5 no longer matches the source'
p.write_text(s.replace(old, new))
PY
drive "the refusal stops naming which agents collided"

# --- 6 -----------------------------------------------------------------------
# THE AUDIT'S CLOSURE. Criterion 5 was "check the other bare-key verbs I have not
# enumerated", and §6 answers it by asserting over the whole key-taking tool set
# rather than over a list written down once. `butchr_guardian` is the sharp case:
# its `type` is optional at the SCHEMA and required only by a hand-written check
# in the call handler, so deleting that check gives it a bare-key path that no
# schema-reading audit would see. If §6 does not go red here, the closure is
# decorative and the audit is a claim rather than an assertion.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/mcp.ts'); s = p.read_text()
old = """      if (op === 'set' && (!type || !key)) {
        throw new Error("Missing required arguments for op 'set': type, key");
      }"""
assert old in s, 'mutation 6 no longer matches the source'
p.write_text(s.replace(old, ''))
PY
drive "butchr_guardian loses the handler check that is its only type requirement"

# --- verdict -----------------------------------------------------------------
echo
echo "################################################################"
echo "# ${reds} red, ${greens} green, ${uncompilable} uncompilable"
echo "################################################################"
echo
if [ $greens -ne 0 ]; then
  echo "A MUTATION SURVIVED. The proof does not hold the behaviour that mutation removed."
  exit 1
fi
if [ $uncompilable -ne 0 ]; then
  echo "A MUTATION DID NOT COMPILE, so the proof never saw it — that is not a red."
  echo "Rewrite it as a mutation that compiles rather than counting it."
  exit 1
fi
echo "Every mutation was caught by the proof, and the build exited 0 on each."
exit 0
