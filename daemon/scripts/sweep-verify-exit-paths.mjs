// KAN-119: every `verify-` script in this repository must be able to fail.
//
// WHAT FAILURE THIS WOULD CATCH: a `verify-` script that cannot report failure
// — no exit path at all, or exits that are only setup guards — being added or
// reintroduced. Five such scripts were in this repository at once, four of them
// cited as evidence in real PR reviews, and one of them printed `FAILED` on
// screen while exiting 0. This sweep is named `sweep-` rather than `verify-`
// deliberately: it is not itself a proof of any product behaviour, so it has no
// business in the namespace it polices.
//
// WHY IT DOES NOT GREP
//
// The rule took four attempts to get right, and the first three each shipped a
// wrong answer:
//
//   1. Pattern-matching for failing-exit spellings — clears a script whose
//      `throw` or `assert` happens to match while it has no exit path at all.
//   2. Enumerating exit paths — counts the `process.exit(0)` inside the fake
//      herdr shim a script writes to disk, and counts "daemon/dist is missing"
//      setup guards, as though either were a verdict.
//   3. Reading each exit's *purpose* — separates a guard from a verdict, which
//      is what this file automates: it asks whether an exit's value is derived
//      from an accumulated verdict, not whether a non-zero exit exists.
//   4. Observing the script actually go red — the only test that separates a
//      verdict which can fire from one that cannot. **No tool can do this one.**
//      It is done by breaking the behaviour under test and watching the script
//      fail, and it must not be skipped because this sweep is green.
//
// So: passing this sweep is necessary and *not* sufficient. It answers "can
// this script report a failure at all", which is exactly the question the five
// broken scripts answered no to.
//
// KAN-206: A VERDICT-SHAPED EXIT IS NOT YET A REACHABLE ONE
//
// Everything above checks the *exit*. It does not check that anything can ever
// reach it. `let failures = 0; … process.exit(failures ? 1 : 0)` satisfies
// level 3 completely while nothing in the file ever increments `failures`, and
// so does a `check()` helper that pushes onto the counter and is never called.
// Both are scripts that print their own success and exit 0 forever, and this
// file cleared both until KAN-206 — which is the level-3 defect in a new
// costume, one hop further from the exit.
//
// So the sweep now asks a second question per script: **is there at least one
// call site that can produce a FAIL?** It walks back from each verdict exit
// through the top-level declarations feeding it to the accumulator underneath,
// finds the places that make that accumulator negative, and — when such a place
// sits inside a helper — counts the helper's *call sites* rather than its body.
// A helper nobody calls contributes nothing, which is the whole point.
//
// WHY IT DOES NOT GREP FOR `check(`
//
// The suite's verdict helpers are not uniform. They are at least
// `check(ok, claim, detail)`, `check(name, ok, detail)`, `verdict(ok, yes, no)`,
// `record(name, passed, note)`, `scenario(…)`, and a bare
// `const ok = a === b && c.length === 0` with no helper at all. A detector
// written for one spelling recognises almost nothing — and a detector that
// recognises nothing reports a clean sweep, because every script trivially has
// "no unreached helper". That is the failure mode this check is most likely to
// die of, and it is silent.
//
// Two things guard it, and neither is optional:
//
//   a. It fails closed. Zero recognised FAIL sites is a FAILURE for that
//      script, never a skip. A detector that goes blind turns the whole suite
//      red at once rather than green.
//   b. It self-tests before it sweeps (§ SELF-TEST below) against fixtures that
//      must pass and fixtures that must fail. The first draft of this detector
//      reported zero helpers across all 45 scripts because its comment/string
//      masking mishandled `${…}` inside a template literal and blanked the rest
//      of every file. Nothing about the output looked wrong. The mask fixture
//      exists because of that hour.
//
// WHAT THIS STILL DOES NOT PROVE — and it must not be read as proving it
//
// That a FAIL site exists says nothing about whether it can ever *fire*. A
// `check(true, …)` call is a call site by every measure here and can never
// produce a FAIL. Level 4 above is still the only thing that establishes an
// assertion can be false, it is still done by breaking the behaviour under test
// and watching the script go red, and it is still not automatable. This sweep
// and that discipline do not cover each other; the gap between two honest
// mechanisms is where this class of defect keeps being found.
//
// Usage: node daemon/scripts/sweep-verify-exit-paths.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/**
 * Identifiers a script accumulates failures into. A verdict-driven exit is one
 * whose value is computed from one of these; anything else is a guard.
 */
const COUNTER = /\b(failures?|failed|problems|errors|violations|leaks|bad)\b/i;

/** Every `process.exit(...)` / `process.exitCode = ...`, with its line. */
function exitPaths(source) {
  const found = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const exitCall = line.match(/process\.exit\s*\(([^;]*)\)/);
    if (exitCall) found.push({ line: i + 1, kind: 'exit', expr: exitCall[1].trim(), text: line.trim() });
    const exitCode = line.match(/process\.exitCode\s*=\s*([^;]+)/);
    if (exitCode) found.push({ line: i + 1, kind: 'exitCode', expr: exitCode[1].trim(), text: line.trim() });
  });
  return found;
}

/**
 * The condition controlling an exit, if a nearby `if` supplies one.
 *
 * `exit(1)` says nothing on its own — `if (failures) process.exit(1)` is a
 * verdict and `if (!existsSync(dist)) process.exit(1)` is a guard, and the
 * difference is entirely in the line above. Reading only the exit's argument
 * misclassified verify-agent-resumption on this sweep's first run: the whole
 * point of level 3 is that the argument is not where the meaning lives.
 */
function controllingCondition(source, lineNumber) {
  const lines = source.split('\n');
  for (let i = lineNumber - 1; i >= Math.max(0, lineNumber - 6); i--) {
    const m = lines[i].match(/\bif\s*\((.*)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Is this exit a verdict, or a guard?
 *
 * A verdict's value — or the condition that reaches it — is derived from
 * accumulated state: `exit(failures ? 1 : 0)`, `exitCode = ok ? 0 : 1`,
 * `if (failures) process.exit(1)`. A guard's is a literal reached at a point
 * where the script has decided it cannot run at all.
 *
 * The `process.exitCode` idiom counts as a verdict when the assignment is
 * conditional or computed: setting it to 1 from inside a check and then ending
 * naturally is how eight of these scripts legitimately report failure.
 */
function classify(entry, source) {
  const { kind, expr, text, line } = entry;

  // A literal exit guarded by a check on accumulated failures is a verdict,
  // whatever its argument looks like.
  const condition = controllingCondition(source, line);
  if (kind === 'exit' && condition && COUNTER.test(condition)) {
    return { verdict: true, why: `reached only when \`${condition.trim().slice(0, 40)}\`` };
  }

  if (kind === 'exitCode') {
    // `exitCode = <literal>` inside a conditional line, or `= <expression>`.
    const conditional = /^\s*if\s*\(/.test(text) || /\?/.test(expr) || COUNTER.test(expr);
    return conditional || /^\s*(if|})/.test(text)
      ? { verdict: true, why: 'exitCode set from a check' }
      : { verdict: COUNTER.test(expr), why: 'exitCode assignment' };
  }

  // process.exit(<expr>)
  if (COUNTER.test(expr) || /\?/.test(expr)) {
    return { verdict: true, why: 'exit value derived from an accumulated verdict' };
  }
  if (/^process\.exitCode/.test(expr)) {
    // `process.exit(process.exitCode ?? 0)` — a verdict iff something set it.
    return {
      verdict: /process\.exitCode\s*=/.test(source),
      why: 'exits with the accumulated process.exitCode'
    };
  }
  if (/^0$/.test(expr)) return { verdict: false, why: 'unconditional success exit' };
  return { verdict: false, why: 'literal exit — a setup guard or a usage error' };
}

/**
 * Exits written *into a file this script creates* — the fake `herdr` binaries
 * several scripts put on PATH. They belong to the shim, not to the script's own
 * control flow, and counting them is defect class 2 above.
 */
function insideShim(source, lineNumber) {
  const upTo = source.split('\n').slice(0, lineNumber).join('\n');
  const opens = (upTo.match(/writeFileSync\(|`#!\/bin\/sh|cat <<'EOF'/g) ?? []).length;
  const closes = (upTo.match(/EOF\n|\}\)\;/g) ?? []).length;
  return opens > 0 && opens > closes;
}

// ---------------------------------------------------------------------------
// KAN-206: is there a call site that can produce a FAIL?
// ---------------------------------------------------------------------------

/**
 * Blank out comments and the *contents* of strings and template literals, so
 * that brace depth, `;` and identifiers mean what they say.
 *
 * The `${…}` handling is the part that matters. An interpolation returns to
 * code — with its own brace depth, so the `}` that ends it is the one seen at
 * depth 0 — and the closing `}` returns to template text. Getting this wrong
 * does not produce an error: the unclosed backtick swallows the rest of the
 * file, every identifier disappears, and the sweep reports that no script in
 * the suite has a verdict helper. See the SELF-TEST fixture named `mask`.
 */
function codeMask(src) {
  const n = src.length;
  const out = new Array(n);
  const blank = (i) => { out[i] = src[i] === '\n' ? '\n' : ' '; };

  const interps = [];
  let mode = 'code';
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
      if (c === '/' && d === '*') {
        blank(i++); blank(i++);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
        if (i < n) { blank(i++); blank(i++); }
        continue;
      }
      if (c === "'" || c === '"') {
        blank(i++);
        while (i < n && src[i] !== c) { if (src[i] === '\\') blank(i++); if (i < n) blank(i++); }
        if (i < n) blank(i++);
        continue;
      }
      if (c === '`') { blank(i++); mode = 'tpl'; continue; }
      if (c === '{' && interps.length) interps[interps.length - 1].depth++;
      if (c === '}' && interps.length) {
        if (interps[interps.length - 1].depth === 0) { interps.pop(); blank(i++); mode = 'tpl'; continue; }
        interps[interps.length - 1].depth--;
      }
      out[i] = c; i++;
      continue;
    }
    if (c === '\\') { blank(i++); if (i < n) blank(i++); continue; }
    if (c === '`') { blank(i++); mode = 'code'; continue; }
    if (c === '$' && d === '{') { blank(i++); blank(i++); interps.push({ depth: 0 }); mode = 'code'; continue; }
    blank(i++);
  }
  return out.join('');
}

const lineAt = (masked, index) => masked.slice(0, index).split('\n').length;

/**
 * Every *named* function in the file, with the line range of its body. Named is
 * the only kind that matters here: an anonymous callback has no call site to
 * count, so a failure recorded inside one is treated as recorded directly.
 */
function functionSpans(masked) {
  const spans = [];
  const re = new RegExp(
    String.raw`function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{` + '|' +
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{` + '|' +
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{`,
    'g'
  );
  let m;
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    for (; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') { depth--; if (depth === 0) break; }
    }
    spans.push({
      name: m[1] || m[2] || m[3],
      defLine: lineAt(masked, m.index),
      startLine: lineAt(masked, open),
      endLine: lineAt(masked, j)
    });
  }
  return spans;
}

const JS_WORDS = new Set([
  'const', 'let', 'var', 'if', 'else', 'return', 'true', 'false', 'null',
  'undefined', 'new', 'typeof', 'await', 'async', 'function', 'of', 'in',
  'process', 'exit', 'exitCode', 'Number', 'String', 'Boolean', 'Math', 'JSON',
  'Object', 'Array'
]);

/**
 * Bare identifiers in an expression: `.property` accesses and the parameters of
 * any inline arrow are stripped first. The parameters matter — without that,
 * `results.filter((r) => !r.passed)` puts `r` into the closure, and every
 * unrelated `r = …` in the file then reads as a way to fail.
 */
function identifiers(expr) {
  const bare = expr
    .replace(/\([^)]*\)\s*=>/g, ' ')
    .replace(/\b[A-Za-z_$][\w$]*\s*=>/g, ' ')
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, ' ');
  return [...new Set(bare.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])].filter((n) => !JS_WORDS.has(n));
}

/** The RHS of a top-level `const|let|var NAME = …;`, if the file declares one. */
function declarationOf(masked, name) {
  const re = new RegExp(String.raw`(?:^|\n)\s*(?:const|let|var)\s+${name}\s*=\s*`, 'g');
  const m = re.exec(masked);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = masked.indexOf(';', from);
  return { rhs: masked.slice(from, end === -1 ? masked.length : end), line: lineAt(masked, from) };
}

/**
 * The names an exit's value depends on, followed back through declarations.
 *
 * `process.exit(failed.length === 0 ? 0 : 1)` starts at `failed`; `failed` is
 * declared `const failed = results.filter((r) => !r.passed)`, so `results`
 * joins the closure and *that* is the accumulator the FAIL sites belong to.
 */
/**
 * What an exit's value is named after.
 *
 * The exit's own expression, normally. `process.exit(1)` says nothing, so for
 * that shape — and only that shape — the `if (…)` that controls it supplies the
 * name instead. Taking the condition unconditionally is wrong and was wrong
 * here: `controllingCondition` scans back six lines for any `if (`, so for
 * `process.exit(failures.length ? 1 : 0)` it reached into the body of the
 * `check` helper above and seeded the closure with that helper's parameters.
 */
function verdictSeed(source, entry) {
  const fromExpr = identifiers(entry.expr);
  if (fromExpr.length) return entry.expr;
  const condition = controllingCondition(source, entry.line);
  if (condition == null) return entry.expr;
  // `controllingCondition` returns everything after `if (`, so for
  // `if (!ok) process.exitCode = 1;` it hands back the statement too. Stop at
  // the paren that closes the condition.
  let depth = 0;
  for (let i = 0; i < condition.length; i++) {
    if (condition[i] === '(') depth++;
    else if (condition[i] === ')') { if (depth === 0) return condition.slice(0, i); depth--; }
  }
  return condition;
}

function sinkClosure(masked, seeds) {
  // Two hops, not unlimited. `failed → results` is one; `ok → the values ok is
  // computed from` is one. Following further walks the whole program: on
  // verify-parentage-in-list-agents an unbounded walk reached sixteen names,
  // including a function and its parameters, and every `=` anywhere near them
  // started to look like a way for the script to fail.
  const MAX_DEPTH = 2;
  const closure = new Set();
  const queue = seeds.flatMap(identifiers).map((name) => ({ name, depth: 0 }));
  while (queue.length && closure.size < 24) {
    const { name, depth } = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    if (depth >= MAX_DEPTH) continue;
    const decl = declarationOf(masked, name);
    if (decl) queue.push(...identifiers(decl.rhs).map((n) => ({ name: n, depth: depth + 1 })));
  }
  return closure;
}

/**
 * Is the assignment at `index` a statement, or is it nested inside a parameter
 * list or a call's arguments? An unclosed `(` to its left on the same line is
 * what separates `failures = 1` from `function f({ activated = [] })`.
 *
 * Parentheses only, deliberately: braces would also reject
 * `if (!ok) { failures += 1; }`, which is a real mutation written on one line.
 */
function statementLevel(text, index) {
  let parens = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '(') parens++;
    else if (text[i] === ')') parens--;
  }
  return parens <= 0;
}

const FALSIFIABLE = /===|!==|==|!=|<|>|(?<![!=<>])!(?!=)|&&|\|\||\.(includes|some|every|test|match|startsWith|endsWith)\s*\(/;

/**
 * Places that can make the outcome negative, expressed as call sites.
 *
 * A mutation of an accumulator is a FAIL site where it stands, unless it sits
 * inside a named function — in which case the FAIL sites are that function's
 * call sites, and a function nobody calls yields none. That substitution is the
 * check: it is what separates a `check()` helper that is wired up from one that
 * is merely present.
 */
function failSites(masked, verdictSeeds) {
  const closure = sinkClosure(masked, verdictSeeds);
  const spans = functionSpans(masked);
  const lines = masked.split('\n');

  const mutations = [];
  lines.forEach((text, idx) => {
    const line = idx + 1;
    const isDeclaration = /^\s*(const|let|var)\s/.test(text);
    for (const name of closure) {
      // Alternatives are assembled into a list and joined. Building the pattern
      // by string concatenation left a trailing `|` on declaration lines, and an
      // empty alternative matches every line — which is how the first run of
      // this detector found 141 FAIL sites in a 600-line script and reported the
      // suite clean. Both negative fixtures were red at that moment.
      const alternatives = [
        String.raw`\b${name}\s*\.\s*(push|add|set|unshift)\s*\(`,
        String.raw`\b${name}\s*(\+\+|\+=)`,
        String.raw`\+\+\s*${name}\b`
      ];
      let hit = new RegExp(alternatives.join('|')).exec(text);
      // A re-assignment is a mutation; the declaration that introduces the name
      // is not, or `const failures = []` would be its own way to fail. Nor is a
      // default inside a parameter list: `function f({ activated = [] })` is a
      // signature, and reading it as a mutation made every call to `f` a FAIL
      // site. `statementLevel` is what tells the two apart.
      if (!hit && !isDeclaration) {
        const assign = new RegExp(String.raw`\b${name}\s*=\s*(?!=)`).exec(text);
        if (assign && statementLevel(text, assign.index)) hit = assign;
      }
      if (hit) {
        mutations.push({ line, name, text: text.trim() });
        break;
      }
    }
    if (/process\s*\.\s*exitCode\s*=\s*(?!0\s*;?\s*$)/.test(text)) {
      mutations.push({ line, name: 'process.exitCode', text: text.trim() });
    }
  });

  const sites = [];
  for (const mut of mutations) {
    // `>=`, not `>`: `const check = (ok) => { if (!ok) failures.push(ok); };`
    // opens and closes its body on one line, and a mutation there is inside it.
    const owner = spans.find((s) => mut.line >= s.startLine && mut.line <= s.endLine);
    if (!owner) { sites.push({ line: mut.line, via: 'direct', text: mut.text }); continue; }
    const callRe = new RegExp(String.raw`\b${owner.name}\s*\(`, 'g');
    let c;
    while ((c = callRe.exec(masked))) {
      const line = lineAt(masked, c.index);
      const inOwnBody = spans.some((s) => s.name === owner.name && line >= s.defLine && line <= s.endLine);
      if (inOwnBody) continue;
      if (!sites.some((s) => s.line === line && s.via === owner.name)) {
        sites.push({ line, via: owner.name, text: lines[line - 1].trim() });
      }
    }
  }

  // No accumulator anywhere in the closure: the script may still be the
  // `const ok = a === b && c.length === 0` shape, where the declaration itself
  // is the thing that can be false. This runs only when there is nothing to
  // mutate — it must never rescue a helper that exists and is never called.
  if (!mutations.length) {
    for (const name of closure) {
      const decl = declarationOf(masked, name);
      if (decl && FALSIFIABLE.test(decl.rhs)) {
        sites.push({ line: decl.line, via: 'expression', text: `${name} = ${decl.rhs.trim().split('\n')[0].slice(0, 60)}` });
      }
    }
  }

  return { sites, closure: [...closure], mutations };
}

// ---------------------------------------------------------------------------
// SELF-TEST — the detector must be shown to recognise, and to refuse
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    name: 'helper wired up',
    expect: true,
    source: `const failures = [];
const check = (ok, why) => { if (!ok) failures.push(why); };
check(1 === 1, 'a claim');
process.exit(failures.length ? 1 : 0);`
  },
  {
    name: 'counter never incremented',
    expect: false,
    source: `let failures = 0;
console.log('everything looks fine');
process.exit(failures ? 1 : 0);`
  },
  {
    name: 'helper defined but never called',
    expect: false,
    source: `const failures = [];
const check = (ok, why) => { if (!ok) failures.push(why); };
console.log('everything looks fine');
process.exit(failures.length ? 1 : 0);`
  },
  {
    name: 'results array behind a record helper',
    expect: true,
    source: `const results = [];
const record = (name, passed) => { results.push({ name, passed }); };
record('a claim', 1 === 1);
const failed = results.filter((r) => !r.passed);
process.exit(failed.length === 0 ? 0 : 1);`
  },
  {
    name: 'bare boolean with no helper',
    expect: true,
    source: `const first = { id: 1 }, second = { id: 1 }, ended = [];
const ok = first.id === second.id && ended.length === 0;
process.exit(ok ? 0 : 1);`
  },
  {
    // A default in a parameter list is a signature, not a mutation. Reading it
    // as one made every call to the enclosing function a FAIL site, which is
    // how a script with no real verdict site could be cleared by an unrelated
    // harness function that happened to destructure a similarly named option.
    name: 'a parameter default is not a way to fail',
    expect: false,
    source: `const failures = [];
function harness({ failures = [] }) {
  return failures.length;
}
harness({});
process.exit(failures.length ? 1 : 0);`
  },
  {
    // The bug that made the first draft of this detector report a clean sweep.
    // Nothing here is unusual: a template literal whose interpolation contains
    // braces and quotes. Mishandle it and the mask eats the rest of the file,
    // `check` disappears, and this fixture flips to false.
    name: 'mask survives ${…} with braces and quotes',
    expect: true,
    source: `const failures = [];
const check = (ok, why) => { if (!ok) failures.push(why); };
console.log(\`result: \${ok ? '{yes}' : "{no}"} and \${JSON.stringify({ a: 1 })}\`);
check(1 === 1, 'a claim');
process.exit(failures.length ? 1 : 0);`
  }
];

function runSelfTest() {
  const wrong = [];
  for (const f of FIXTURES) {
    const masked = codeMask(f.source);
    const seeds = exitPaths(f.source).map((e) => verdictSeed(f.source, e));
    const { sites } = failSites(masked, seeds);
    const got = sites.length > 0;
    if (got !== f.expect) wrong.push({ ...f, got, sites });
    if (verbose) {
      console.log(`  ${got === f.expect ? 'ok  ' : 'FAIL'} fixture: ${f.name} — expected ${f.expect ? 'a FAIL site' : 'none'}, found ${sites.length}`);
    }
  }
  return wrong;
}

const rows = [];
for (const dir of SCRIPT_DIRS) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs).sort()) {
    if (!name.startsWith('verify-') || !name.endsWith('.mjs')) continue;
    const file = path.join(abs, name);
    const source = fs.readFileSync(file, 'utf8');
    const paths = exitPaths(source).map((e) => ({
      ...e,
      ...classify(e, source),
      shim: insideShim(source, e.line)
    }));
    const verdicts = paths.filter((p) => p.verdict && !p.shim);
    const guards = paths.filter((p) => !p.verdict && !p.shim);
    const seeds = verdicts.map((v) => verdictSeed(source, v));
    const reach = failSites(codeMask(source), seeds);
    rows.push({
      rel: path.join(dir, name),
      name: name.replace(/\.mjs$/, ''),
      canFail: verdicts.length > 0,
      hasHeader: /WHAT FAILURE THIS WOULD CATCH/.test(source),
      failSites: reach.sites,
      closure: reach.closure,
      verdicts,
      guards,
      shims: paths.filter((p) => p.shim)
    });
  }
}

console.log('self-testing the FAIL-site detector against fixtures that must pass and must fail');
const badFixtures = runSelfTest();
if (badFixtures.length) {
  console.log(`\n${badFixtures.length} fixture(s) came back wrong — the detector below cannot be trusted:`);
  for (const f of badFixtures) {
    console.log(`  - "${f.name}": expected ${f.expect ? 'a FAIL site' : 'none'}, found ${f.sites.length}`);
    for (const s of f.sites) console.log(`      L${s.line} via ${s.via}: ${s.text}`);
  }
} else {
  console.log(`  all ${FIXTURES.length} fixtures behaved as specified\n`);
}

console.log(`sweeping ${rows.length} verify-* scripts under ${SCRIPT_DIRS.join(', ')}\n`);
console.log(`${'script'.padEnd(48)} ${'verdict exits'.padEnd(14)} ${'FAIL sites'.padEnd(11)} ${'guards'.padEnd(7)} header`);
console.log('-'.repeat(48) + ' ' + '-'.repeat(14) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(7) + ' ------');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(48)} ${String(r.canFail ? r.verdicts.length : 'NONE').padEnd(14)} ` +
      `${String(r.failSites.length || 'NONE').padEnd(11)} ` +
      `${String(r.guards.length).padEnd(7)} ${r.hasHeader ? 'yes' : 'NO'}`
  );
  if (verbose) {
    for (const v of r.verdicts) console.log(`      verdict  L${v.line}: ${v.text}   (${v.why})`);
    for (const s of r.failSites) console.log(`      failsite L${s.line}: ${s.text}   (via ${s.via})`);
    for (const g of r.guards) console.log(`      guard    L${g.line}: ${g.text}   (${g.why})`);
    for (const s of r.shims) console.log(`      shim     L${s.line}: ${s.text}   (inside a written-out fake binary)`);
    if (!r.failSites.length) console.log(`      closure  ${r.closure.join(', ') || '(empty)'}`);
  }
}

const cannotFail = rows.filter((r) => !r.canFail);
const noHeader = rows.filter((r) => !r.hasHeader);
const unreachable = rows.filter((r) => !r.failSites.length);

console.log('');
if (cannotFail.length) {
  console.log(`${cannotFail.length} script(s) have NO verdict-driven exit — they cannot report failure:`);
  for (const r of cannotFail) {
    console.log(`  - ${r.rel}` + (r.guards.length ? ` (${r.guards.length} exit(s), all guards)` : ' (no exit path at all)'));
  }
}
if (noHeader.length) {
  console.log(`${noHeader.length} script(s) do not state what failure they would catch:`);
  for (const r of noHeader) console.log(`  - ${r.rel}`);
}
if (unreachable.length) {
  console.log(
    `${unreachable.length} script(s) have a verdict-shaped exit that nothing can reach — no call\n` +
      'site anywhere in the file can make the accumulator behind it negative:'
  );
  for (const r of unreachable) console.log(`  - ${r.rel} (traced back through: ${r.closure.join(', ') || 'nothing'})`);
  console.log(
    '\n  If this is a false negative rather than a broken script, the fix is to teach\n' +
      '  the detector the spelling AND add a fixture for it — not to exempt the file.'
  );
}

const failures = badFixtures.length + cannotFail.length + noHeader.length + unreachable.length;
if (!failures) {
  console.log(
    `ALL PASS — every one of the ${rows.length} verify-* scripts has a verdict-driven exit, at\n` +
      'least one call site that can produce a FAIL, and states what failure it would catch.\n\n' +
      'This does NOT establish that any of their assertions can be false. A `check(true, …)`\n' +
      'is a call site by every measure here. That is the fourth level of the rule and it is\n' +
      'proved only by breaking the behaviour under test and watching the script go red — see\n' +
      'the KAN-119 PR for that evidence.'
  );
}
process.exit(failures > 0 ? 1 : 0);
