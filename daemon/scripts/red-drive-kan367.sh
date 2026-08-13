#!/usr/bin/env bash
#
# KAN-367's red drive, as a script rather than as a paragraph in a PR body.
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
# `git checkout daemon/src/pr-watch.ts daemon/src/jira-poll.ts` puts them back.
#
# Usage:  bash daemon/scripts/red-drive-kan367.sh          (from the repo root)

set -u

if [ ! -f daemon/src/pr-watch.ts ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan367.sh" >&2
  exit 2
fi

PW=daemon/src/pr-watch.ts
JP=daemon/src/jira-poll.ts
BAK=$(mktemp -d)
cp $PW "$BAK/pr-watch.ts"
cp $JP "$BAK/jira-poll.ts"
restore() { cp "$BAK/pr-watch.ts" $PW; cp "$BAK/jira-poll.ts" $JP; }
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

  node daemon/scripts/verify-pr-watch-notice-tense.mjs > "$BAK/proof.log" 2>&1
  local proof=$?
  echo "PROOF_EXIT=$proof"
  if [ $proof -ne 0 ]; then reds=$((reds + 1)); else greens=$((greens + 1)); fi
  grep -E "^§|FAILED —|ALL SECTIONS PASSED" "$BAK/proof.log" | sed 's/^/    /'
  restore
}

# --- 1 -----------------------------------------------------------------------
# THE DEFECT ITSELF, restored verbatim: the state claim is made in the present
# tense whatever its age. This is the sentence that was actually sent at 02:45Z,
# and every other mutation below is a way of arriving back at it by accident.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""  if (Number.isFinite(age) && age >= 0 && age <= limitMs) {
    return `${what} is still ${observed.value} (read ${describeDuration(age)} ago)`;
  }""",
"""  if (true) {
    return `${what} is still ${observed.value}`;
  }""")
p.write_text(s)
PY
drive "every state claim is present tense again (the defect, verbatim)"

# --- 2 -----------------------------------------------------------------------
# THE WRONG FIX THIS CHANGE IS MOST LIKELY TO COMMIT, and the reason mutation 1
# is not the interesting one. An author adding a timestamp to a value that never
# had one has to choose WHICH moment it records, and "now" is both the easier
# reach and the one that compiles identically. It makes every stale fact look
# freshly read — so the notice regains the present tense while APPEARING to have
# been fixed, and the type is satisfied in full.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/jira-poll.ts'); s = p.read_text()
s = s.replace("status: memory.status === null ? null : { value: memory.status, observedAt: memory.seenAt },",
              "status: memory.status === null ? null : { value: memory.status, observedAt: new Date(this.now()).toISOString() },")
p.write_text(s)
PY
drive "the status is stamped when it is HANDED OUT rather than when it was READ"

# --- 3 -----------------------------------------------------------------------
# The freshness bound is widened until the incident falls inside it. Nothing
# about the shape of the code changes: both branches still exist, every claim
# still carries a timestamp, and the type is untouched. Only the boundary moves,
# which is why §4 tests it AT the boundary and one second past it rather than
# with a comfortable margin either side.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("export const PRESENT_TENSE_LIMIT_MS = 2 * PR_POLL_INTERVAL_MS;",
              "export const PRESENT_TENSE_LIMIT_MS = 24 * 60 * 60 * 1000;")
p.write_text(s)
PY
drive "the present tense is allowed for anything read in the last day"

# --- 4 -----------------------------------------------------------------------
# The gap is never recognised, so every notice reads as live. The words are
# unchanged and both branches still exist — this is the failure where the
# disclosure is present, correct, and never reached, which is indistinguishable
# from a fleet that never missed a look.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""    const gapMs = this.now() - previous;""",
              """    const gapMs = 0;""")
p.write_text(s)
PY
drive "no gap is ever measured, so every announcement claims to be live"

# --- 5 -----------------------------------------------------------------------
# The AC4 disclosure is deleted outright. Note WHICH section catches it: §5, and
# not §2 — §2 asserts on the EVENT, which still carries the gap correctly, and a
# measurement nobody puts in the message is a measurement no reader ever sees.
# The two sections are not redundant, and this mutation is what shows it.
#
# THE FIRST SPELLING OF THIS MUTATION WAS WRONG AND IS WORTH RECORDING. It read
# `const backfill = true ? '' : \`…\`` — which does not compile, because the
# narrowing that makes `lastObservedAt` reachable comes from testing
# `first.observation.live` and nothing else. It was reported as a compiler
# refusal, correctly, and a refusal is not a red: had it been left there, this
# drive would have claimed to have exercised §5 while never running it. The
# disclosure has to be emptied where it is BUILT, leaving the discriminant test
# intact.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
old = """  const backfill = first.observation.live
    ? ''
    : ` BACKFILLED, not live: this pull request was not looked at between ` +
      `${first.observation.lastObservedAt} and now, a gap of ` +
      `${describeDuration(first.observation.gapMs)}, so anything above happened at some point ` +
      'in that window rather than just now.';"""
assert s.count(old) == 1
s = s.replace(old, """  const backfill = first.observation.live ? '' : '';""")
p.write_text(s)
PY
drive "the backfill disclosure is measured and never said"

# --- 6 -----------------------------------------------------------------------
# EXPECTED TO FAIL TO COMPILE, and kept in the set for that reason: it is the
# demonstration that an UNTIMED state claim is unrepresentable rather than merely
# discouraged. Reported as a non-result above, never as a pass — a mutation the
# compiler refuses is one the proof never saw.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/jira-poll.ts'); s = p.read_text()
s = s.replace("""  /** ISO 8601 — when it was read. Never optional; that is the whole point. */
  observedAt: string;""",
"""  observedAt?: string;""")
p.write_text(s)
PY
drive "observedAt becomes optional (expected: a compiler refusal, not a red)"

# --- 7 -----------------------------------------------------------------------
# ALSO EXPECTED TO FAIL TO COMPILE, and the second half of the same property: an
# event that does not say whether it was seen live or backfilled cannot be built.
# This is what makes the required field worth the seven construction sites it
# touches — the honest notice is not the one whose author remembered.
python3 - <<'PY'
import pathlib
p = pathlib.Path('daemon/src/pr-watch.ts'); s = p.read_text()
s = s.replace("""  observation: NoticeObservation;
}""",
"""  observation?: NoticeObservation;
}""", 1)
s = s.replace("""      headRefName: pr.headRefName,
      observation
    };""",
"""      headRefName: pr.headRefName
    };""")
p.write_text(s)
PY
drive "PrEvent.observation becomes optional (expected: a compiler refusal, not a red)"

echo
echo "################################################################"
echo "# ${reds} red, ${greens} green, ${uncompilable} refused by the compiler"
echo "################################################################"
echo
echo "A green above is a mutation the proof did not catch and is worth reading."
echo "A compiler refusal is NOT a red: the proof never saw that mutation."
exit 0
