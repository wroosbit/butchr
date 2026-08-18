// KAN-535: tell a script's own code from the text it merely contains.
//
// `sweep-verify-exit-paths.mjs` reads every `verify-` script as text and asks
// which of its `process.exit` calls are verdicts. To ask that at all it must
// first know which `process.exit` calls are *the script's*, rather than
// characters sitting inside a string it writes to disk or inside a comment
// describing the idiom.
//
// It used to answer that by counting openers and closers — `writeFileSync(`,
// `` `#!/bin/sh ``, `cat <<'EOF'` against `EOF\n` and `});` — and returning
// "still open". That is the counter KAN-535 was filed against. Three things
// were measured wrong with it on `main`, all in one direction and all invisible:
//
//   - `writeFileSync(` is not an opener. A script that writes an ordinary
//     fixture file leaves the count unbalanced for the rest of the file, so
//     EVERY exit below its first `fs.writeFileSync(` was discarded — including
//     the script's own verdict. `verify-dep-linking-covers-every-repo-shape`
//     lost its real verdict at L326 this way and passed the required check only
//     because a header COMMENT at L42 happened to contain the idiom.
//   - comments were never excluded at all, so prose about `process.exit(...)`
//     counted as an exit path — the accident that was propping the above up.
//   - the `#!/bin/sh` and `cat <<'EOF'` openers never suppressed anything,
//     because the fake `herdr` binaries are SHELL and contain no `process.exit`.
//
// So the question is not "is this inside a shim". It is "is this code", and
// that has an exact answer rather than a heuristic one. This module blanks
// every character belonging to a comment, a string, a template literal or a
// regex literal, leaving `${...}` interpolations — which ARE code — intact, and
// preserving newlines so line numbers survive.
//
// WHY REGEX LITERALS ARE HANDLED AND NOT SKIPPED, which looks like scope creep
// and is not: 21 of the swept scripts contain a regex holding a quote character
// (`/["']/`, `/['"]/`, `` /[*_`]/ ``). A scanner that treated those as division
// would read the quote inside them as a string opener and blank live code from
// there to the next matching quote — silently deleting real verdicts. Not
// handling regexes is the more dangerous option, not the cheaper one.

/**
 * Can a `/` at this point begin a regex literal, or is it division?
 *
 * Decided by the previous significant token, which is the standard
 * disambiguation. The set is deliberately closed rather than open: `)`, `]`, an
 * identifier and a digit all mean division, so anything not named here reads as
 * division and the `/` stays code. A regex that is missed is read as code — the
 * safe direction, because the fallback below also refuses to run past a
 * newline.
 */
const REGEX_MAY_FOLLOW = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>'
]);
const REGEX_MAY_FOLLOW_WORD = /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;

function regexMayStart(prevChar, prevWord) {
  if (prevChar === null) return true;
  if (REGEX_MAY_FOLLOW.has(prevChar)) return true;
  return REGEX_MAY_FOLLOW_WORD.test(prevWord);
}

/**
 * Return a copy of `source` in which every character that is not executable
 * code has been replaced by a space.
 *
 * Newlines are preserved everywhere, so the result is the same length as the
 * input and every offset and line number still refers to the same place. That
 * is what lets a caller run its existing line-based matchers over the masked
 * copy and report line numbers against the original file.
 *
 * Masked: line comments, block comments, single- and double-quoted strings,
 * template-literal text, and regex literals — delimiters included.
 * Not masked: `${ ... }` interpolation bodies, which are ordinary code and can
 * themselves contain any of the above, nested to any depth.
 */
export function maskNonCode(source) {
  const n = source.length;
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  // Brace depths at which each enclosing `${` was opened. Empty means we are
  // not inside any interpolation, so a `}` is an ordinary block close.
  const interpolations = [];
  let braceDepth = 0;
  let prevChar = null;
  let prevWord = '';
  let mode = 'code';
  let i = 0;

  while (i < n) {
    if (mode === 'template') {
      // Inside the text of a template literal. Ends at an unescaped backtick,
      // or suspends at `${` for an interpolation, which is code.
      const start = i;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`') { i++; blank(start, i); mode = 'code'; prevChar = ' '; prevWord = ''; break; }
        if (source[i] === '$' && source[i + 1] === '{') {
          i += 2;
          blank(start, i);
          interpolations.push(braceDepth);
          braceDepth++;
          mode = 'code';
          prevChar = '{';
          prevWord = '';
          break;
        }
        i++;
      }
      if (i >= n) blank(start, n); // unterminated at end of file
      continue;
    }

    const c = source[i];
    const next = source[i + 1];

    // ---- comments --------------------------------------------------------
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    // ---- quoted strings ---------------------------------------------------
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j++; break; }
        if (source[j] === '\n') break; // unterminated; do not run away
        j++;
      }
      blank(i, j);
      prevChar = ' ';
      prevWord = '';
      i = j;
      continue;
    }

    // ---- template literal opens ------------------------------------------
    if (c === '`') {
      blank(i, i + 1);
      i++;
      mode = 'template';
      continue;
    }

    // ---- braces, which is how an interpolation closes ---------------------
    if (c === '{') {
      braceDepth++;
      prevChar = c;
      prevWord = '';
      i++;
      continue;
    }
    if (c === '}') {
      braceDepth--;
      if (interpolations.length && braceDepth === interpolations[interpolations.length - 1]) {
        interpolations.pop();
        blank(i, i + 1);
        i++;
        mode = 'template'; // back into the text after `${ ... }`
        continue;
      }
      prevChar = c;
      prevWord = '';
      i++;
      continue;
    }

    // ---- regex literals ---------------------------------------------------
    if (c === '/' && regexMayStart(prevChar, prevWord)) {
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < n) {
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break; // a regex cannot span lines; this was division
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { j++; terminated = true; break; }
        j++;
      }
      if (terminated) {
        while (j < n && /[a-z]/.test(source[j])) j++; // flags
        blank(i, j);
        prevChar = ' ';
        prevWord = '';
        i = j;
        continue;
      }
      // Unterminated on this line, so it was division after all: fall through
      // and treat the `/` as the ordinary operator it is.
    }

    // ---- ordinary code ----------------------------------------------------
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      prevWord = source.slice(i, j);
      prevChar = source[j - 1];
      i = j;
      continue;
    }
    prevChar = c;
    prevWord = '';
    i++;
  }

  return out.join('');
}
