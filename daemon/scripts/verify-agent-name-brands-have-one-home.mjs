// KAN-406's single-conversion property, as a mechanism rather than as a grep a
// human runs (KAN-424).
//
// WHAT FAILURE THIS WOULD CATCH: a *second* place where an agent-name string is
// minted or converted. KAN-406 branded the two agent-name types so that
// `r.paneName === agentName` is `error TS2367`, and the brand's whole value
// rests on a discipline the brand itself cannot enforce — that `as PaneName`
// and `as ButchrAgentName` each live in exactly one named home. A future author
// who writes a third cast has written a second derivation of the Butchr name,
// which is precisely the defect KAN-346 fixed once inside `censusRecords()` and
// KAN-397 fixed again, one function away, inside `confirmAgentPresent`. Both
// fixes were right and neither could stop the next instance. This script is
// what stops it: the cast still compiles wherever it is written, and now it
// does not merge.
//
// It also catches the two quieter ways the brand stops meaning "a transform
// ran": an exported brand symbol, which lets anyone mint one of these types
// from nothing, and an exported `PaneName`, which lets CrabCast's string travel
// past the one module that is entitled to read it.
//
// AND THE REASON IT IS A SCRIPT AT ALL, WHICH IS THE EMBARRASSING PART. The
// only check on this property in PR #180 was a `grep` pasted into the PR body,
// and it reported the wrong number: it claimed one `as ButchrAgentName` cast
// where there are two, both visible in the diff it sat under. The design was
// fine and the prose above the grep was accurate — the *evidence* had drifted
// from the claim before the ink was dry, in the PR whose subject was making a
// mechanism carry a claim. A property whose entire enforcement is a command a
// human runs and a human reads is not enforced.
//
// CI-RUNNABLE: yes — reads `daemon/src/**/*.ts` as TEXT and asserts against it
// in process. No build, no `dist`, no live daemon, no herdr, no credential, no
// peer, no terminal, no network, and it writes nothing: the red-drive flags
// rewrite an in-memory copy of the source rather than the tree.
//
// ---------------------------------------------------------------------------
// HOW IT PARSES, AND WHY NOT WITH A BARE `grep`
// ---------------------------------------------------------------------------
// #180's docblocks discuss `as ButchrAgentName` and `as PaneName` IN PROSE —
// they have to, since a brand that cannot say what it brands is useless to the
// next reader. A bare `grep` for the cast text therefore counts documentation
// as code and goes red when somebody improves a comment. So comments are
// stripped first, then string literals, exactly as
// `verify-crabcast-channel-startup-disablement.mjs` does for gate 3's §1;
// strip order matters, so that an apostrophe inside a comment ("daemon.ts's")
// cannot open a phantom string.
//
// ⚠ ASSERTED BY LOCATION, NOT ONLY BY COUNT. Two casts in the wrong two places
// satisfy a count and defeat the property entirely — a count alone is the same
// SHAPE of check as the grep that was wrong, and would have been just as
// useless. Each cast is resolved to its innermost enclosing named function by
// brace-matching the stripped source, and the function must be the one named.
//
// The homes are DISCOVERED, not hardcoded to a file: the declarations of
// `readCensus`, `agentNameFor` and `butchrNameForCensusRow` are located by
// sweeping the whole of `daemon/src`, so moving one to another module keeps
// this script working rather than breaking it. What is specified here is the
// FUNCTION a cast must live in, which is the property itself and not an
// incidental fact about today's layout.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER, NAMED RATHER THAN IMPLIED
// ---------------------------------------------------------------------------
//   * **`daemon/scripts/*.mjs` is unprotected, permanently.** Brands erase at
//     runtime, so the seventeen scripts that import `agentNameFor` from
//     `dist/` get nothing from the type system and nothing from this script,
//     which reads `daemon/src` alone. `task/KAN-406` read all seventeen at
//     their head and found no mis-join. ⚠ THAT WAS TRUE AT ONE COMMIT AND
//     NOTHING HOLDS IT TRUE — it is an observation with a date on it, not a
//     guarantee, and it says nothing about the eighteenth. WHO COVERS IT:
//     nobody, mechanically. Do not read this script's green as covering them.
//
//   * **Anything outside `daemon/src`.** `extension/` and the tests are not
//     swept.
//
//   * **That the two casts are CORRECT.** This asserts where a conversion may
//     live, never that the conversion it performs is the right one. §2's
//     location check is what makes the fallback branch in
//     `butchrNameForCensusRow` the only route from a `PaneName` to a
//     `ButchrAgentName`; whether that route is sound is #180's design, which
//     this guards and does not revise.
//
//   * **A conversion that never spells the type.** A `string` widened through
//     an `any`, a `JSON.parse`, or a signature that returns `ButchrAgentName`
//     while receiving an unbranded string, mints one of these with no cast to
//     find. The angle-bracket cast form `<ButchrAgentName>x` IS checked (§2c)
//     because it is the one alternate spelling with the same meaning; the rest
//     are open, and the type system is what narrows them, not this file.
//
// ---------------------------------------------------------------------------
// MADE TO GO RED — one mutation per assertion, each failing on its own
// ---------------------------------------------------------------------------
// Each rewrites a COPY of the source text in memory, so a red run leaves the
// tree untouched. Each must trip exactly the section it names and no other; a
// script where one mutation trips everything cannot tell a future reader what
// they broke.
//
//   node daemon/scripts/verify-agent-name-brands-have-one-home.mjs --stray-cast
//   node daemon/scripts/verify-agent-name-brands-have-one-home.mjs --export-brand
//   node daemon/scripts/verify-agent-name-brands-have-one-home.mjs --export-panename
//   node daemon/scripts/verify-agent-name-brands-have-one-home.mjs --move-cast
//
// Going GREEN under any of them is counted as a failure, and each mutation
// additionally asserts that its own edit took — a mutation that silently
// matched nothing would otherwise report the assertions as strong when they
// were never exercised, which is the "a proof that supplies its own input" trap
// wearing the red drive's clothes.

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');

const verbose = process.argv.includes('--verbose');
const strayCast = process.argv.includes('--stray-cast');
const exportBrand = process.argv.includes('--export-brand');
const exportPaneName = process.argv.includes('--export-panename');
const moveCast = process.argv.includes('--move-cast');
const mutating = strayCast || exportBrand || exportPaneName || moveCast;

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(76));
  say(title);
  say('─'.repeat(76));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) {
    say(`        ${String(detail).split('\n').slice(0, 8).join('\n        ')}`);
  }
  return ok;
};

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
if (!existsSync(srcDir)) {
  console.error(`Missing ${srcDir} — this script reads the tree, not a build.`);
  process.exit(2);
}

/** Every `.ts` under `daemon/src`, discovered rather than listed. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

const files = walk(srcDir);
if (files.length === 0) {
  console.error(`No .ts files under ${srcDir} — the sweep found nothing to read.`);
  process.exit(2);
}

/** rel path -> raw source. Mutations rewrite this map and nothing on disk. */
const sources = new Map(
  files.map((f) => [path.relative(repoRoot, f), readFileSync(f, 'utf8')])
);

// ── the mutations ──────────────────────────────────────────────────────────
// Applied to the in-memory copy. Each asserts that it took: a mutation that
// matched nothing is a red drive that never drove.
const mutate = (rel, from, to, what) => {
  const before = sources.get(rel);
  if (before === undefined) {
    console.error(`--- mutation "${what}" targets ${rel}, which this tree has not got.`);
    process.exit(2);
  }
  if (!before.includes(from)) {
    console.error(
      `--- mutation "${what}" found no occurrence of its anchor in ${rel}:\n` +
        `      ${from}\n` +
        '    The mutation did not take, so this run would prove nothing. Fix the anchor.'
    );
    process.exit(2);
  }
  sources.set(rel, before.replace(from, to));
};

if (strayCast) {
  // THE DEFECT IN MINIATURE. Somebody one module away needs a Butchr name from
  // a pane name and writes the conversion where they are standing. It compiles;
  // it is a second derivation; it is KAN-346 and KAN-397 arriving a third time.
  const rel = 'daemon/src/router.ts';
  const src = sources.get(rel);
  if (src === undefined) {
    console.error(
      `--- mutation "--stray-cast" appends to ${rel}, which this tree has not got.\n` +
        '    Point it at any module outside the two homes; without a target it would\n' +
        '    append to nothing and report the assertions as strong untested.'
    );
    process.exit(2);
  }
  sources.set(
    rel,
    `${src}\nfunction butchrNameFromPane(paneName: string): ButchrAgentName {\n  return paneName as ButchrAgentName;\n}\n`
  );
}

if (exportBrand) {
  // An exported brand symbol can be minted anywhere, so the type stops meaning
  // "a transform ran" and starts meaning "somebody wrote the words".
  mutate(
    'daemon/src/herdr.ts',
    'declare const BUTCHR_AGENT_NAME_BRAND: unique symbol;',
    'export declare const BUTCHR_AGENT_NAME_BRAND: unique symbol;',
    '--export-brand'
  );
}

if (exportPaneName) {
  // CrabCast's string escapes the one module entitled to read it, and every
  // other module gains the ability to name — and therefore to join on — it.
  mutate(
    'daemon/src/crabcast-runtime.ts',
    'type PaneName = string &',
    'export type PaneName = string &',
    '--export-panename'
  );
}

if (moveCast) {
  // The count stays at one and the property is gone: the cast is no longer at
  // the boundary where CrabCast's frame is read, so it is asserting the brand
  // over a string that did not come from the census.
  mutate(
    'daemon/src/crabcast-runtime.ts',
    "paneName: (typeof r.paneName === 'string' ? r.paneName : '') as PaneName,",
    "paneName: (typeof r.paneName === 'string' ? r.paneName : '') as unknown as PaneNameMoved,",
    '--move-cast (removing the cast from readCensus)'
  );
  mutate(
    'daemon/src/crabcast-runtime.ts',
    'const rel = path.relative(workspacesRoot(), dir);',
    "const rel = path.relative(workspacesRoot(), dir);\n  const stolen = String(dir) as PaneName;",
    '--move-cast (planting the cast in addressForPath)'
  );
}

// ── stripping: comments first, then string literals ────────────────────────
// The brand's own docblocks name the casts, and must be free to. What is
// asserted here is the presence of a CAST IN CODE, so code is what is read.
//
// Strip order matters and is the same as
// `verify-crabcast-channel-startup-disablement.mjs`: comments first, so that an
// apostrophe inside one cannot open a phantom string. The difference is that
// this one BLANKS rather than deletes — see below.
/**
 * Blank out comments and strings while PRESERVING every byte offset, so that a
 * line number computed on the stripped text is the line number in the file. A
 * `replace` that shortens the text would report the wrong line, which for a
 * script whose entire job is "say where" is a defect rather than a detail.
 */
const blank = (ts) => {
  const noComments = ts.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
    m.replace(/[^\n]/g, ' ')
  );
  return noComments.replace(
    /`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/g,
    (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[m.length - 1]
  );
};

/** rel -> code with comments and string bodies blanked, offsets intact. */
const code = new Map([...sources].map(([rel, src]) => [rel, blank(src)]));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every function-like DECLARATION in a file, with the span of its body.
 *
 * A declaration is told from a call by two independent facts, both required:
 * the name sits at the head of its line behind nothing but modifiers, and its
 * parameter list is followed by an optional return-type annotation and then an
 * opening brace. `name(x),` and `? name(x)` fail the first; `name(x);` fails
 * the second.
 */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'typeof',
  'new', 'await', 'yield', 'delete', 'void', 'in', 'of', 'with'
]);

function collectFunctions(text) {
  const found = [];
  const re =
    /(^|\n)([ \t]*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:function\s*\*?\s+)?)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=\()/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[3];
    if (NOT_A_FUNCTION.has(name)) continue;
    const parenAt = m.index + m[0].length;
    const closeParen = matchDelimiter(text, parenAt, '(', ')');
    if (closeParen < 0) continue;
    const braceAt = bodyBraceAfter(text, closeParen + 1);
    if (braceAt < 0) continue;
    const closeBrace = matchDelimiter(text, braceAt, '{', '}');
    if (closeBrace < 0) continue;
    found.push({ name, start: m.index, bodyStart: braceAt, bodyEnd: closeBrace });
  }
  return found;
}

/**
 * The `{` that opens a function BODY, given the index just past its `)`.
 *
 * A return-type annotation may itself contain braces — `addressForPath` returns
 * `{ type: string; key: string } | null`, and a naive "first `{` after the
 * parens" reads that object TYPE as the body. It then brace-matches the type
 * and reports every cast in the real body as sitting at top level, which for a
 * script whose whole job is asserting WHERE a cast lives is the defect rather
 * than a cosmetic slip. (It was fail-safe — an unrecognised location is not an
 * allowed one, so the verdict stayed correct — but a red that misnames the
 * function tells the next reader the wrong thing about what they broke.)
 *
 * Told apart by what FOLLOWS the closing brace: a brace group that is part of a
 * type is followed by more type syntax (`|`, `&`, `>`, `,`, `)`, `]`, `;`,
 * `=>`), and a body is not. So candidates are tried in order and the first one
 * that is not continued as a type is the body. `Promise<{ a: string }>` falls
 * out of the same test without tracking angle brackets, which cannot be done
 * reliably anyway — `<` is also a comparison.
 */
function bodyBraceAfter(text, from) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const close = matchDelimiter(text, i, '{', '}');
      if (close < 0) return -1;
      const rest = text.slice(close + 1).match(/^\s*(=>|[|&>,)\];=?])/);
      if (!rest) return i;
      i = close + 1;
      continue;
    }
    // Anything else that can legally sit between `)` and the body is type
    // syntax or whitespace. A `;` means this was a signature with no body
    // (an overload or an interface member), so there is nothing to span.
    if (ch === ';') return -1;
    i += 1;
  }
  return -1;
}

/** Index of the delimiter closing the one at `openAt`, or -1. */
function matchDelimiter(text, openAt, open, close) {
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The innermost declared function containing `index`, or null. */
function enclosingFunction(fns, index) {
  let best = null;
  for (const f of fns) {
    if (index > f.bodyStart && index < f.bodyEnd) {
      if (!best || f.bodyStart > best.bodyStart) best = f;
    }
  }
  return best;
}

const fnsByFile = new Map([...code].map(([rel, text]) => [rel, collectFunctions(text)]));

/** Every occurrence of `as <Brand>` in code, with the function it sits in. */
function castSites(brand) {
  const re = new RegExp(`\\bas\\s+${brand}\\b`, 'g');
  const sites = [];
  for (const [rel, text] of code) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const fn = enclosingFunction(fnsByFile.get(rel), m.index);
      sites.push({
        rel,
        line: lineOf(text, m.index),
        fn: fn ? fn.name : '(top level)',
        where: `${rel}:${lineOf(text, m.index)} in ${fn ? fn.name : '(top level)'}`
      });
    }
  }
  return sites;
}

/**
 * Where a named function is declared, swept from the tree rather than assumed.
 * More than one is itself a finding: two `agentNameFor`s are two producers.
 */
function declarationsOf(name) {
  const out = [];
  for (const [rel, fns] of fnsByFile) {
    for (const f of fns) if (f.name === name) out.push({ rel, line: lineOf(code.get(rel), f.start) });
  }
  return out;
}

/**
 * The angle-bracket cast `<Brand>expr`, told from the generic `Foo<Brand>` by
 * the character before the `<`: a generic argument list is always preceded by
 * an identifier character, and a cast never is.
 */
function angleCastSites(brand) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])<\\s*${brand}\\s*>`, 'g');
  const sites = [];
  for (const [rel, text] of code) {
    let m;
    while ((m = re.exec(text)) !== null) {
      sites.push(`${rel}:${lineOf(text, m.index)}`);
    }
  }
  return sites;
}

const fmt = (sites) => (sites.length ? sites.map((s) => s.where ?? s).join('\n') : '(none)');

// ═══════════════════════════════════════════════════════════════════════════
say('KAN-424 — the two agent-name brands each have exactly one home');
say(`swept ${files.length} .ts files under daemon/src`);

// ── §1 ─────────────────────────────────────────────────────────────────────
rule('§1  `as PaneName` — once, and in readCensus (the sole producer)');
{
  const sites = castSites('PaneName');
  const homes = declarationsOf('readCensus');

  check(
    homes.length === 1,
    'readCensus is declared exactly once in daemon/src',
    homes.map((h) => `${h.rel}:${h.line}`).join('\n') || '(no declaration found)'
  );
  check(
    sites.length === 1,
    `\`as PaneName\` occurs exactly once in code (found ${sites.length})`,
    fmt(sites)
  );
  check(
    sites.length > 0 && sites.every((s) => s.fn === 'readCensus'),
    'every `as PaneName` sits inside readCensus, where CrabCast’s frame is read',
    fmt(sites)
  );
  check(
    angleCastSites('PaneName').length === 0,
    'no angle-bracket `<PaneName>` cast is used as a second spelling',
    angleCastSites('PaneName').join('\n')
  );
}

// ── §2 ─────────────────────────────────────────────────────────────────────
rule('§2  `as ButchrAgentName` — twice, and only in agentNameFor and butchrNameForCensusRow');
{
  const sites = castSites('ButchrAgentName');
  const ALLOWED = ['agentNameFor', 'butchrNameForCensusRow'];

  for (const name of ALLOWED) {
    const homes = declarationsOf(name);
    check(
      homes.length === 1,
      `${name} is declared exactly once in daemon/src`,
      homes.map((h) => `${h.rel}:${h.line}`).join('\n') || '(no declaration found)'
    );
  }
  check(
    sites.length === 2,
    `\`as ButchrAgentName\` occurs exactly twice in code (found ${sites.length})`,
    fmt(sites)
  );
  const strays = sites.filter((s) => !ALLOWED.includes(s.fn));
  check(
    strays.length === 0,
    `every \`as ButchrAgentName\` sits in ${ALLOWED.join(' or ')} — a cast elsewhere is a second derivation`,
    fmt(strays)
  );
  for (const name of ALLOWED) {
    check(
      sites.some((s) => s.fn === name),
      `${name} still holds one — a home that lost its cast is a producer that moved`,
      fmt(sites)
    );
  }
  check(
    angleCastSites('ButchrAgentName').length === 0,
    'no angle-bracket `<ButchrAgentName>` cast is used as a second spelling',
    angleCastSites('ButchrAgentName').join('\n')
  );
}

// ── §3 ─────────────────────────────────────────────────────────────────────
rule('§3  Neither brand symbol is exported');
{
  for (const symbol of ['PANE_NAME_BRAND', 'BUTCHR_AGENT_NAME_BRAND']) {
    const decls = [];
    const exported = [];
    for (const [rel, text] of code) {
      const declRe = new RegExp(`(export\\s+)?declare\\s+const\\s+${symbol}\\s*:\\s*unique\\s+symbol`, 'g');
      let m;
      while ((m = declRe.exec(text)) !== null) {
        decls.push({ rel, line: lineOf(text, m.index), exported: Boolean(m[1]) });
        if (m[1]) exported.push(`${rel}:${lineOf(text, m.index)} (declaration is exported)`);
      }
      // `export { X }` / `export { X as Y }`, the other way out of a module.
      const listRe = new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`, 'g');
      let n;
      while ((n = listRe.exec(text)) !== null) {
        exported.push(`${rel}:${lineOf(text, n.index)} (named in an export list)`);
      }
    }
    check(
      decls.length === 1,
      `${symbol} is declared exactly once as \`declare const … unique symbol\``,
      decls.map((d) => `${d.rel}:${d.line}`).join('\n') || '(no declaration found)'
    );
    check(
      exported.length === 0,
      `${symbol} is not exported — an exported brand can be minted anywhere`,
      exported.join('\n')
    );
  }
}

// ── §4 ─────────────────────────────────────────────────────────────────────
rule('§4  `type PaneName` stays module-local to crabcast-runtime.ts');
{
  const decls = [];
  for (const [rel, text] of code) {
    const re = /(export\s+)?type\s+PaneName\s*=/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      decls.push({ rel, line: lineOf(text, m.index), exported: Boolean(m[1]) });
    }
  }
  check(
    decls.length === 1,
    `type PaneName is declared exactly once in daemon/src (found ${decls.length})`,
    decls.map((d) => `${d.rel}:${d.line}`).join('\n') || '(no declaration found)'
  );
  check(
    decls.length === 1 && decls[0].rel === 'daemon/src/crabcast-runtime.ts',
    'it is declared in crabcast-runtime.ts, the module that reads CrabCast’s frame',
    decls.map((d) => `${d.rel}:${d.line}`).join('\n') || '(no declaration found)'
  );
  check(
    decls.every((d) => !d.exported),
    'it is not exported — module-local is what keeps the census join unwritable elsewhere',
    decls.filter((d) => d.exported).map((d) => `${d.rel}:${d.line}`).join('\n')
  );

  const importers = [];
  for (const [rel, text] of code) {
    if (rel === 'daemon/src/crabcast-runtime.ts') continue;
    const re = /import\s+(?:type\s+)?\{[^}]*\bPaneName\b[^}]*\}/g;
    let m;
    while ((m = re.exec(text)) !== null) importers.push(`${rel}:${lineOf(text, m.index)}`);
  }
  check(
    importers.length === 0,
    'no other module imports PaneName',
    importers.join('\n')
  );
}

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (failures) {
  say(`  ${failures} check(s) FAILED.`);
  if (strayCast) {
    say('');
    say('This is the expected red for --stray-cast. The behaviour that made it red: a');
    say('third `as ButchrAgentName` was written in router.ts, outside both homes. §2 is');
    say('the only section that moved — the count and the location both name it.');
  }
  if (exportBrand) {
    say('');
    say('This is the expected red for --export-brand. The behaviour that made it red:');
    say('BUTCHR_AGENT_NAME_BRAND is exported, so any module can mint a ButchrAgentName');
    say('without a cast and the type stops meaning "a transform ran". §3 only.');
  }
  if (exportPaneName) {
    say('');
    say('This is the expected red for --export-panename. The behaviour that made it red:');
    say('PaneName is exported, so CrabCast’s string can be named — and joined on —');
    say('outside the one module entitled to read it. §4 only.');
  }
  if (moveCast) {
    say('');
    say('This is the expected red for --move-cast. The behaviour that made it red: the');
    say('one `as PaneName` moved out of readCensus into addressForPath. THE COUNT IS');
    say('STILL ONE and the property is gone — which is exactly why a count alone would');
    say('have passed this, and is the whole argument for asserting by location. §1 only.');
  }
} else {
  say('  OK — each brand has one home, both brand symbols are module-private, and');
  say('  PaneName has not left crabcast-runtime.ts.');
  say('');
  say('  This says nothing about `daemon/scripts/*.mjs`, where brands do not exist at');
  say('  runtime and nothing is checked. See the header.');
  for (const [flag, label] of [
    [strayCast, '--stray-cast'],
    [exportBrand, '--export-brand'],
    [exportPaneName, '--export-panename'],
    [moveCast, '--move-cast']
  ]) {
    if (flag) {
      say('');
      say(`  BUT ${label} was requested and this went GREEN, which means the mutation did`);
      say('  not move the verdict: these assertions are not watching what they claim to.');
      failures += 1;
    }
  }
}
if (mutating) {
  say('');
  say('  (mutating run — the tree on disk was not touched.)');
}

process.exit(failures ? 1 : 0);
