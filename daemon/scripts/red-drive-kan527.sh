#!/usr/bin/env bash
#
# KAN-527's red drive, as a script rather than as a paragraph in a PR body.
#
# `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
# and where demonstrating the failure needs a recipe, the recipe is part of the
# proof because the reviewer has to be able to reproduce the red as well as the
# green. This is that recipe.
#
# WHAT IT DRIVES: `daemon/scripts/sweep-script-text-hazards.mjs`, both sections.
#
# THE DISCRIMINATING ARM IS ARM 0 AND IT RUNS FIRST. KAN-527's acceptance
# criterion 3 says it in as many words: "a guard that reads the file through a
# NUL-tolerant path will report clean on a file that is not, so show it failing
# before you believe it passing." Arm 0 puts the byte back exactly where
# `origin/main` carried it, then shows three things about that tree before the
# new guard is asked anything:
#
#   * `file -b` calls an 800-line proof `data`;
#   * every `grep` on the machine needs `-a` to get a line out of it, and they
#     do not all fail the same way — the arm names each one and prints what it
#     actually did rather than captioning a number;
#   * `sweep-verify-exit-paths.mjs`, the REQUIRED check that already sweeps this
#     directory with `readFileSync(f, 'utf8')`, exits 0 on it.
#
# That last line is the whole justification for a second guard. It is also the
# input that turns the new one red, which is what makes its green worth reading.
#
# NOT A `verify-` SCRIPT, deliberately, and named so it cannot be mistaken for
# one: it writes control bytes into the tree. `sweep-verify-exit-paths.mjs` and
# the CI partition both key off the `verify-` prefix, and a script that mutates
# the tree has no business in a set CI runs unattended.
#
# It restores every file on EXIT, including on Ctrl+C, and deletes the scratch
# target it creates. If it is killed with -9:
#
#   git checkout daemon/scripts/verify-send-transport-claims.mjs
#   rm -f daemon/scripts/kan527-red-drive-target.mjs
#
# Usage:  bash daemon/scripts/red-drive-kan527.sh          (from the repo root)

set -u

GUARD=daemon/scripts/sweep-script-text-hazards.mjs
EXITS=daemon/scripts/sweep-verify-exit-paths.mjs
REAL=daemon/scripts/verify-send-transport-claims.mjs
TARGET=daemon/scripts/kan527-red-drive-target.mjs

if [ ! -f "$GUARD" ] || [ ! -f "$REAL" ]; then
  echo "run me from the repository root: bash daemon/scripts/red-drive-kan527.sh" >&2
  exit 2
fi

BAK=$(mktemp -d)
cp "$REAL" "$BAK/real.mjs"
restore() { cp "$BAK/real.mjs" "$REAL"; rm -f "$TARGET"; }
trap 'restore; rm -rf "$BAK"' EXIT

caught=0
wrong=0

# Write the scratch target with `$1` as its one interesting line.
#
# `@NUL@` in a body becomes a RAW NUL BYTE here. It has to travel as a marker
# because a bash variable cannot hold a NUL at all — the shell would truncate
# the body at it and the arm would silently test nothing.
write_target() {
  cat > "$TARGET" <<EOF
// KAN-527 red-drive scratch target. Created and deleted by
// daemon/scripts/red-drive-kan527.sh; it is never committed.
//
// WHAT FAILURE THIS WOULD CATCH: nothing. It is not a proof and asserts no
// product behaviour. It exists so each arm has a file of its own to be red
// about, rather than mutating one somebody depends on.
const haystack = 'connection-7f3a';
const id = process.env.KAN527_ID;
const words = { 4: 'four' };
const n = 4;
$1
EOF
  python3 - "$TARGET" <<'PY'
import sys
path = sys.argv[1]
data = open(path, 'rb').read()
open(path, 'wb').write(data.replace(b'@NUL@', b'\x00'))
PY
}

# Run one command as ITS OWN invocation and report its exit status.
#
# NEVER PIPED. `cmd | tail` yields tail's status, so a failure reads as 0 — an
# exit code read through a pipe is not even the exit code (`prompts/task.md`).
# The output is redirected to a file and the file is what gets summarised.
run() {
  local label=$1; shift
  "$@" > "$BAK/out.log" 2>&1
  local rc=$?
  echo "  \$ $*"
  head -"${HEAD_LINES:-16}" "$BAK/out.log" | sed 's/^/      /'
  echo "      EXIT=$rc   ($label)"
  return $rc
}

expect_red() {
  echo
  echo "################################################################"
  echo "# MUTATION: $1"
  echo "################################################################"
  run "the guard" node "$GUARD"
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "  -> RED, as it must be."
    caught=$((caught + 1))
  else
    echo "  -> GREEN. THE MUTATION SURVIVED — the guard does not hold this property."
    wrong=$((wrong + 1))
  fi
}

expect_green() {
  echo
  echo "################################################################"
  echo "# NEGATIVE CONTROL: $1"
  echo "################################################################"
  run "the guard" node "$GUARD"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "  -> GREEN, as it must be. The guard discriminates rather than flagging a spelling."
  else
    echo "  -> RED. FALSE POSITIVE — the guard fired on something that disarms nothing."
    wrong=$((wrong + 1))
  fi
}

# =============================================================================
echo "################################################################"
echo "# ARM 0 — what the EXISTING instruments say about a file that is"
echo "#         not text. Run FIRST, and it is the discriminating arm."
echo "################################################################"
# =============================================================================
python3 - "$REAL" <<'PY'
import sys
path = sys.argv[1]
data = open(path, 'rb').read()
old = b".includes(sendA.connectionId),"
new = b".includes(sendA.connectionId ?? '\x00'),"
assert data.count(old) == 1, f"expected one call site, found {data.count(old)}"
open(path, 'wb').write(data.replace(old, new))
print(f"  put one raw NUL back into {path}, where origin/main carried it")
PY

echo
echo "  \$ file -b $REAL"
kind=$(file -b "$REAL")
echo "      $kind"
case "$kind" in
  *data*) echo "      -> an 800-line proof classified as binary. The arm reproduced." ;;
  *) echo "      -> NOT classified as binary. THE ARM DID NOT REPRODUCE; read no further"
     echo "         until you know why, because everything below assumes it did."
     wrong=$((wrong + 1)) ;;
esac

# ---------------------------------------------------------------------------
# NAME THE GREP. It is not one instrument and the two on this machine DISAGREE.
# ---------------------------------------------------------------------------
# KAN-527 and its staffing comment both record `grep -q ... -> rc=1` on this
# file. That is true, and it is true of ONE grep. Measured here rather than
# quoted, because the difference is the ticket's own rule turned on the ticket's
# own evidence — an empty result is a claim about your search, and which binary
# answered is part of the search:
#
#   * ugrep, which is what `grep` resolves to at an agent's PROMPT (Claude Code
#     installs a shell function that routes there), refuses the file outright:
#     no output, EXIT=1, indistinguishable from "the string is not in it". That
#     binary ships INSIDE Claude Code rather than on PATH, so the row below
#     usually reads "not on this machine" even where an agent's own `grep` is
#     exactly it — no path is guessed here, because a guessed path that misses
#     would print a reassuring absence rather than a missing measurement.
#   * GNU grep, which is what a bash SCRIPT like this one gets, exits 0 and
#     prints `binary file matches` to stderr instead of the line. The status is
#     not suppressed; the readable output is.
#
# Both are unusable for review and they are unusable in different ways, so this
# prints what each did and derives the sentence rather than captioning it.
probe_grep() {
  local label=$1 bin=$2
  [ -x "$bin" ] || { echo "      $label: not on this machine"; return; }
  "$bin" -c 'CI-RUNNABLE' "$REAL" > "$BAK/g.log" 2>&1
  local plain=$?
  local plainout; plainout=$(tr -d '\n' < "$BAK/g.log")
  "$bin" -ac 'CI-RUNNABLE' "$REAL" > "$BAK/g.log" 2>&1
  local astext=$?
  local atext; atext=$(tr -d '\n' < "$BAK/g.log")
  echo "      $label ($("$bin" --version 2>&1 | head -1 | cut -c1-40))"
  echo "        -c   EXIT=$plain  output=${plainout:-(none)}"
  echo "        -ac  EXIT=$astext  output=${atext:-(none)}"
  if [ "$plain" != "$astext" ] || [ "$plainout" != "$atext" ]; then
    echo "        -> the two disagree, so the plain form was a claim about the SEARCH"
  else
    echo "        -> this one answers the same either way; \`file\` above is the finding"
  fi
}

echo
echo "  \$ grep -c 'CI-RUNNABLE' $REAL   vs   grep -ac ...   per implementation:"
probe_grep "GNU grep (what a bash script gets)" /usr/bin/grep
probe_grep "ugrep    (what \`grep\` is at an agent's prompt)" "$(command -v ugrep || echo /nonexistent)"

echo
echo "  And the required check that already sweeps this directory, same tree:"
HEAD_LINES=3 run "sweep-verify-exit-paths — the utf8 reader" node "$EXITS"
existing=$?
if [ $existing -eq 0 ]; then
  echo "  -> GREEN on a file that is not text. That is the gap KAN-527 is about, and"
  echo "     it is why the new guard reads BUFFERS rather than utf8 strings."
else
  echo "  -> RED. Unexpected: the existing sweep is reacting to something else."
  echo "     Read its output above before trusting anything below it."
  wrong=$((wrong + 1))
fi

expect_red "the real C1 needle defaults to a raw NUL again (origin/main's state)"
restore

# =============================================================================
# The synthetic arms, on a scratch file, so each shape is isolated.
# =============================================================================

write_target 'const ok = haystack.includes(id ?? "@NUL@"); console.log(ok, words, n);'
expect_red "a raw-NUL fallback in a .includes() needle"

write_target 'const ok = haystack.includes(id ?? "\x00"); console.log(ok, words, n);'
expect_red "the SAME sentinel, ESCAPED — 1 is satisfied and 2 still refuses it"

write_target 'const ok = haystack.includes(id ?? ""); console.log(ok, words, n);'
expect_red "the deliberate empty needle — AC4's case, no control byte anywhere"

write_target 'const pattern = `${n}|${words[n] ?? ""}`; console.log(new RegExp(pattern).test("anything"), haystack, id);'
expect_red "an empty ALTERNATION alternative — (4|) matches every string in existence"

# The arm that says this is a guard and not a grep for `?? ''`. That spelling
# occurs 276 times in these two trees and all but the ones above are ordinary
# display defaults; a guard that flagged them all would be routed around within
# a week, which is how a gate becomes a thing people disable.
write_target 'const label = String(id ?? "").slice(0, 20); console.log(haystack.includes(label), words, n);'
expect_green "the same spelling in a DISPLAY position — String(x ?? \"\").slice(...)"

# 2's OWN COVERAGE LEG, driven red on VALID JavaScript.
#
# A regex literal containing a backtick, in a position the lexer's
# regex-versus-division heuristic gets wrong, is read as division — so the
# backtick opens a template that never closes and the whole rest of the file is
# lexed in the wrong state. `found` comes back EMPTY, which is byte-identical to
# a clean file. The `unterminated` flag is the only thing that separates them,
# and this arm is what shows it can fire.
#
# The heuristic knows about `return /re/` and the keywords around it; this arm
# uses `if (s) /re/`, which it does not. That is the honest state of it: the
# lexer is a heuristic, it will always have a case it gets wrong, and the leg
# exists so that case arrives as a DOUBT rather than as a green.
write_target 'if (haystack) /`/.test(String(id)); console.log(words, n);'
node --check "$TARGET" > "$BAK/check.log" 2>&1
valid=$?
echo
echo "  \$ node --check $TARGET"
echo "      EXIT=$valid   <- the mutation is VALID JavaScript; the lexer is what misreads it"
if [ $valid -ne 0 ]; then
  echo "      THAT IS NOT VALID JAVASCRIPT, so this arm proves less than it claims:"
  sed 's/^/        /' "$BAK/check.log"
  wrong=$((wrong + 1))
fi
expect_red "a regex the lexer misparses — 2 would have reported this file CLEAN"

rm -f "$TARGET"
expect_green "the tree as this branch leaves it, with nothing mutated"

# --- verdict -----------------------------------------------------------------
echo
echo "################################################################"
echo "# ${caught} mutation(s) caught, ${wrong} arm(s) came out wrong"
echo "################################################################"
echo
if [ $wrong -ne 0 ]; then
  echo "AN ARM CAME OUT WRONG. Either a mutation survived the guard, or the guard"
  echo "fired on something that disarms nothing, or the discriminating arm did not"
  echo "reproduce. Read the arm above and fix the guard — not this script."
  exit 1
fi
echo "Every mutation was caught, both negative controls stayed green, and the"
echo "existing required sweep was shown blind to the byte that turns this one red."
exit 0
