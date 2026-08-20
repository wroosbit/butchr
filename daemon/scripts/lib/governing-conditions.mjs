// KAN-540: which `if` actually governs a line — containment, not proximity.
//
// `sweep-verify-exit-paths.mjs` asks whether a script's `process.exit(1)` is a
// verdict or a setup guard, and for the literal-argument forms the answer is
// not in the argument. `if (failures) process.exit(1)` is a verdict;
// `if (!existsSync(dist)) process.exit(1)` is a guard. So the classifier has to
// read the condition that reaches the exit.
//
// IT USED TO READ THE NEAREST `if` WITHIN SIX LINES ABOVE, and that is the
// defect this module exists to remove. Proximity is not control flow. Nothing
// checked that the exit was inside the `if`'s body, so ANY line within six
// above holding `if (` and a counter word laundered an unconditional exit into
// a verdict. The five-line reproduction from the ticket:
//
//     let failures = 0;
//     if (failures) console.log('this branch prints and does not exit');
//     process.exit(0);
//
// asserts nothing and can never report failure, and the old window reported it
// `1 verdict, exit 0` — a pass on the REQUIRED `verify-script-sweep` check for
// a script that cannot fail, which is the exact class that check exists to
// catch. It failed toward GREEN, which is the unsafe direction.
//
// The tell was in the output the whole time: the `why` string printed
// ``reached only when `failures) console.log(` `` — the remains of a line that
// is not a condition at all. A window that returns "everything after the first
// `if (`" can return a fragment; a scanner that matches the condition's own
// parenthesis cannot. That is why the condition text is produced HERE and
// nowhere else, and why the sweep has no path left that can build one from a
// line regex: the shape of the answer is what makes the old defect
// unrepresentable rather than merely absent.
//
// THE SIX-LINE WINDOW IS GONE RATHER THAN TIGHTENED. Once containment is the
// question, a distance is the wrong instrument in both directions: a braced
// `if (failures) { … }` body is routinely longer than six lines, and an
// unrelated `if` one line above governs nothing. Neither error is fixed by
// changing the number.
//
// COST, MEASURED RATHER THAN ARGUED, because this backs a REQUIRED check. The
// scan resumes at the body of each `if` it finds so that nested ones are found
// by the same loop, which re-reads a body once per enclosing level: linear in
// the file, quadratic in NESTING DEPTH. Measured on synthetic input, a chain
// 160 `if`s deep costs 395ms; 1600 sequential blocks over 100 KB cost 11.7ms.
// Real scripts nest five or six deep, and the whole sweep went from 1.7s to
// 2.7s over 164 files on one loaded machine. A single-pass stack would remove
// the depth term; it is not worth restructuring a required check for a second
// per pull request, and the number is written down here so that a future reader
// meeting a pathological file knows the shape rather than rediscovering it.
//
// WHAT THIS IS NOT: a parser. It answers one question — "which `if` bodies
// enclose this offset" — over code that `mask-non-code.mjs` has already
// stripped of comments, strings, template text and regex literals, so every
// brace and parenthesis it counts is real. It does not model early returns,
// `switch`, short-circuit operators or functions called from a conditional
// site. Everything it cannot see reads as UNGOVERNED, which classifies the exit
// as a guard — the direction that makes a required check red rather than
// wrongly green.

/**
 * Index just past the delimiter matching the one at `open`, or -1 if the file
 * ends first. `code` must be masked, so nesting is the only thing to count.
 */
function matchDelim(code, open) {
  const closer = { '(': ')', '[': ']', '{': '}' }[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === code[open]) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * End of the single statement beginning at `from` — the body of an `if` written
 * without braces.
 *
 * Ends at the first `;` outside any bracket, at a `}` that closes an ENCLOSING
 * block, or just past the `}` of a block the statement opened itself
 * (`if (a) if (b) { … }`).
 */
function statementEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i; // closing a block we are inside, not one of ours
      depth--;
      if (depth === 0 && c === '}') return i + 1;
    } else if (c === ';' && depth === 0) return i;
  }
  return code.length;
}

/**
 * Every region of `code` governed by an `if` condition.
 *
 * @param {string} code masked source — see `mask-non-code.mjs`
 * @returns {{cond: string, from: number, to: number}[]} in source order, outer
 *   regions before the inner ones they contain
 */
export function conditionalRegions(code) {
  const regions = [];
  const n = code.length;
  let i = 0;
  let prevChar = null;

  while (i < n) {
    const c = code[i];

    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      // `.if` cannot occur — `if` is reserved — but a property access is what
      // this guard is for, and it costs one comparison.
      if (code.slice(i, j) === 'if' && prevChar !== '.') {
        let k = j;
        while (k < n && /\s/.test(code[k])) k++;
        if (code[k] === '(') {
          const close = matchDelim(code, k);
          if (close > 0) {
            const cond = code.slice(k + 1, close);
            let b = close + 1;
            while (b < n && /\s/.test(code[b])) b++;
            let from;
            let to;
            if (code[b] === '{') {
              const endBrace = matchDelim(code, b);
              from = b + 1;
              to = endBrace < 0 ? n : endBrace;
            } else {
              from = b;
              to = statementEnd(code, b);
            }
            regions.push({ cond, from, to });
            // Resume at the body rather than past it, so `if`s nested inside
            // are found by the same loop. The condition itself is skipped: an
            // `if` written inside a condition (in a callback) governs nothing
            // this sweep can reason about, and reading it as ungoverned is the
            // safe direction.
            i = b;
            prevChar = null;
            continue;
          }
        }
      }
      prevChar = code[j - 1];
      i = j;
      continue;
    }

    if (!/\s/.test(c)) prevChar = c;
    i++;
  }

  return regions;
}

/**
 * The conditions governing `index`, innermost first.
 *
 * An empty array means nothing conditions that offset — the statement runs
 * whenever the script reaches it.
 */
export function governingConditions(regions, index) {
  return regions
    .filter((r) => index >= r.from && index < r.to)
    .sort((a, b) => b.from - a.from)
    .map((r) => r.cond);
}

/**
 * A condition rendered for a one-line diagnostic: whitespace collapsed, and cut
 * at `max` with an explicit ellipsis so a truncation cannot read as the whole.
 */
export function renderCondition(cond, max = 40) {
  const flat = cond.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
