// KAN-527: the two readings `sweep-script-text-hazards.mjs` takes, kept here so
// the sweep is the policy and this is the instrument.
//
// NOT A `verify-` SCRIPT — it asserts nothing and exits nowhere. Its own red
// drive is `daemon/scripts/red-drive-kan527.sh`, which mutates real files in the
// tree and watches the sweep that calls this go red on each mutation. That is
// the coverage boundary this header owes the reader: nothing in this file is
// exercised by anything except that sweep and that drive.
//
// WHY A SEPARATE MODULE. `sweep-sources.mjs` is the precedent and the argument
// is the same one: the byte reading in particular is a thing that must be done
// exactly once and exactly one way, because doing it through a text path is the
// defect. Given a `readFileSync(f, 'utf8')` here and a second one at a call
// site, the second is the one that will go on tolerating what this exists to
// refuse.

import fs from 'fs';

/**
 * Bytes that make a file `data` to `file(1)` and invisible to `grep`.
 *
 * The C0 range minus the three whitespace bytes that are ordinary in source —
 * tab, newline, carriage return — plus DEL. That is the set KAN-527's
 * acceptance criterion 1 names, and the reason for the shape rather than a
 * NUL-only test is that NUL is only the loudest member: `grep` suppresses a
 * whole file on any of them, so a `\x01` sentinel would have hidden a script
 * exactly as the `\x00` one did.
 */
export function isForbiddenByte(byte) {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

/**
 * Every forbidden byte in a file, READ AS BYTES.
 *
 * The encoding is the point. `fs.readFileSync(file, 'utf8')` is the path that
 * tolerated the NUL in `verify-send-transport-claims.mjs` through the required
 * `verify-script-sweep` check — it decoded it happily into a `U+0000` nobody
 * looked at — and a scan of a decoded string additionally cannot tell a byte
 * that was in the file from a `U+FFFD` the decoder substituted for a sequence
 * that was not valid UTF-8. So this reads the buffer.
 */
export function forbiddenBytes(file) {
  const buf = fs.readFileSync(file);
  const hits = [];
  let line = 1;
  let col = 1;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (isForbiddenByte(byte)) hits.push({ offset: i, byte, line, col });
    if (byte === 0x0a) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return hits;
}

/** `0x00` → `\x00`, for an output that is itself safe to paste. */
export function nameByte(byte) {
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The second reading: a fallback constant that cannot be false
// ---------------------------------------------------------------------------
//
// `x ?? '<NUL>'` and `x ?? ''` differ by one byte and are the same defect at
// different stages of it. Both put a constant into a position where the
// surrounding test stops being able to fail:
//
//   `String(basis).includes(id ?? '')`   — `''.includes` is true of every
//                                          string in existence
//   `` `${n}|${word ?? ''}` ``           — an empty alternative matches at
//                                          every position, so `(4|)` matches
//                                          anything
//
// A control-byte sentinel holds the property only by assumption: strip the byte
// and the second form is what is left. AC4 is explicit that a guard on the
// bytes alone does not reach the deliberate `?? ''`, which is why this reading
// exists alongside the first rather than instead of it.

const ESCAPES = { '0': '\0', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

/**
 * Decode a single-quoted or double-quoted JavaScript string literal's body.
 *
 * Only the escapes that can produce a control character or an empty result
 * matter here; anything else decodes to itself, which is enough to answer the
 * one question asked of the result — is every character in it a control
 * character, or is there nothing in it at all.
 */
export function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === 'x') {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16) || 0);
      i += 3;
    } else if (next === 'u' && raw[i + 2] === '{') {
      const close = raw.indexOf('}', i + 3);
      out += String.fromCodePoint(parseInt(raw.slice(i + 3, close), 16) || 0);
      i = close - 1 + 1;
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 0);
      i += 5;
    } else if (next in ESCAPES) {
      out += ESCAPES[next];
      i += 1;
    } else {
      out += next ?? '';
      i += 1;
    }
  }
  return out;
}

/**
 * How a fallback constant is dangerous, or `null` if it is not.
 *
 * `empty` is unfalsifiable NOW. `control-only` is one normalisation away from
 * being — a formatter, an editor, a `.gitattributes` rule or a copy-paste
 * through anything that drops control characters, and it becomes `empty`. The
 * two are reported apart because they need different fixes: the first is a bug,
 * the second is a bug waiting for a trigger nobody would notice pulling.
 */
export function vacuity(raw) {
  const value = decodeLiteral(raw);
  if (value.length === 0) return 'empty';
  if ([...value].every((ch) => isForbiddenByte(ch.charCodeAt(0)))) return 'control-only';
  return null;
}

/**
 * A one-pass lexer, enough to tell code from the things that look like it.
 *
 * It is deliberately not a parser. What the scan needs is exactly three facts —
 * where the string literals are, where the template literals' interpolations
 * and literal chunks are, and which parentheses are real code — and all three
 * come out of a state machine that knows about comments, quotes, regex literals
 * and `${}` nesting.
 *
 * TWO BOUNDS KEEP A MISPARSE FROM SPREADING. A quote or a regex slash that is
 * not what it looks like would otherwise swallow the rest of the file and the
 * scan would report a clean sweep of a file it never read. So a string literal
 * that does not close on its own line is not a string literal, and a regex that
 * does not close on its own line is not a regex — neither construct can legally
 * span a line unescaped, so the bound costs nothing real and turns "the lexer
 * lost the file" into "the lexer skipped one character".
 *
 * @returns {{mask: string, strings: Array, templates: Array}}
 *   `mask` is the source with comments, string bodies and template chunks
 *   replaced by spaces and every offset preserved, so a paren search over it
 *   sees only code.
 */
export function lex(src) {
  const n = src.length;
  const mask = new Array(n).fill(' ');
  const strings = [];
  const templates = [];
  const stack = [{ kind: 'code', braces: 0 }];
  let i = 0;
  let prev = '';

  const keep = (at) => {
    mask[at] = src[at];
  };

  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = src[i];

    if (top.kind === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        top.quasis.push({ start: top.quasiStart, end: i, text: src.slice(top.quasiStart, i) });
        templates.push(top);
        stack.pop();
        prev = '`';
        i += 1;
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        top.quasis.push({ start: top.quasiStart, end: i, text: src.slice(top.quasiStart, i) });
        stack.push({ kind: 'code', braces: 0, exprStart: i + 2, template: top });
        i += 2;
        prev = '';
        continue;
      }
      i += 1;
      continue;
    }

    // --- code ---------------------------------------------------------------
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === '/' && !/[)\]}\w$'"`]/.test(prev)) {
      const end = regexEnd(src, i);
      if (end !== -1) {
        i = end + 1;
        prev = '/';
        continue;
      }
      // Not a regex after all: fall through and treat it as the operator.
    }
    if (ch === "'" || ch === '"') {
      const end = quoteEnd(src, i, ch);
      if (end !== -1) {
        strings.push({ start: i, end: end + 1, quote: ch, raw: src.slice(i + 1, end) });
        i = end + 1;
        prev = ch;
        continue;
      }
      // Unterminated on this line, so it was not a string literal.
    }
    if (ch === '`') {
      stack.push({ kind: 'template', start: i, quasiStart: i + 1, quasis: [] });
      i += 1;
      continue;
    }
    if (ch === '{') {
      top.braces += 1;
    } else if (ch === '}') {
      if (top.braces === 0 && top.template) {
        top.template.exprs = top.template.exprs ?? [];
        top.template.exprs.push({ start: top.exprStart, end: i, text: src.slice(top.exprStart, i) });
        stack.pop();
        stack[stack.length - 1].quasiStart = i + 1;
        i += 1;
        prev = '}';
        continue;
      }
      top.braces -= 1;
    }
    keep(i);
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }

  // An unterminated template at EOF still yields what was read of it.
  for (const frame of stack) {
    if (frame.kind === 'template') {
      frame.quasis.push({ start: frame.quasiStart, end: n, text: src.slice(frame.quasiStart) });
      templates.push(frame);
    }
  }
  for (const t of templates) t.exprs = t.exprs ?? [];

  return { mask: mask.join(''), strings, templates };
}

function quoteEnd(src, from, quote) {
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === '\n') return -1;
    if (src[i] === quote) return i;
  }
  return -1;
}

function regexEnd(src, from) {
  let inClass = false;
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === '\n') return -1;
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) return i;
  }
  return -1;
}

/**
 * The calls whose argument a vacuous constant makes unfalsifiable.
 *
 * `''` is a substring of every string, an index-0 hit of every string, and a
 * regex that matches everywhere. There is no member of this list for which an
 * empty needle produces a test that can fail.
 */
const MATCHER = /(?:\.(?:includes|startsWith|endsWith|indexOf|lastIndexOf)\s*\(|\bnew\s+RegExp\s*\()/g;

/** Argument spans of every matcher call, found over the code-only mask. */
function matcherSpans(mask) {
  const spans = [];
  MATCHER.lastIndex = 0;
  let m;
  while ((m = MATCHER.exec(mask)) !== null) {
    const open = mask.indexOf('(', m.index);
    let depth = 0;
    for (let i = open; i < mask.length; i++) {
      if (mask[i] === '(') depth += 1;
      else if (mask[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          spans.push({ call: m[0].trim(), open, close: i });
          break;
        }
      }
    }
  }
  return spans;
}

/** Is `at` immediately preceded, over code, by `??` or `||`? */
function fallbackOperator(mask, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(mask[i])) i -= 1;
  const two = mask.slice(i - 1, i + 1);
  return two === '??' || two === '||' ? two : null;
}

/**
 * Every vacuous-or-nearly-vacuous fallback sitting in a position where it
 * disarms a match.
 *
 * A fallback anywhere else is not reported. `String(x ?? '').slice(0, 90)` is
 * an ordinary display default and there are 276 of that shape in this tree; a
 * guard that flagged them all would be read once and then routed around, which
 * is the failure mode this repository already has a document about.
 */
export function vacuousFallbacks(src) {
  const { mask, strings, templates } = lex(src);
  const spans = matcherSpans(mask);
  const found = [];

  for (const lit of strings) {
    const kind = vacuity(lit.raw);
    if (!kind) continue;
    const operator = fallbackOperator(mask, lit.start);
    if (!operator) continue;

    const span = spans.find((s) => lit.start > s.open && lit.end <= s.close);
    if (span) {
      found.push({ ...positionOf(src, lit.start), kind, operator, where: `argument of ${span.call}` });
      continue;
    }

    const alternation = alternationAround(templates, lit.start);
    if (alternation) {
      found.push({ ...positionOf(src, lit.start), kind, operator, where: alternation });
    }
  }
  return found;
}

/**
 * Is this offset inside a template interpolation that a literal `|` adjoins?
 *
 * That is the alternation shape: `` `${n}|${word ?? ''}` `` builds `4|` and an
 * empty alternative matches everywhere. The adjacency test is what keeps this
 * off the four ordinary templates in this tree that contain a `|` for reasons
 * of table drawing and have a `?? ''` somewhere else on the same line.
 */
function alternationAround(templates, offset) {
  for (const t of templates) {
    const expr = t.exprs.find((e) => offset > e.start && offset < e.end);
    if (!expr) continue;
    const before = t.quasis.find((q) => q.end === expr.start - 2);
    const after = t.quasis.find((q) => q.start === expr.end + 1);
    if (before && /\|\s*$/.test(before.text)) return 'an alternation alternative (a `|` precedes it)';
    if (after && /^\s*\|/.test(after.text)) return 'an alternation alternative (a `|` follows it)';
  }
  return null;
}

function positionOf(src, offset) {
  const upTo = src.slice(0, offset);
  const line = upTo.split('\n').length;
  const lineStart = upTo.lastIndexOf('\n') + 1;
  return { offset, line, col: offset - lineStart + 1, text: src.slice(lineStart, src.indexOf('\n', offset)).trim() };
}
