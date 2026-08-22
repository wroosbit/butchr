// Proof for KAN-539: a string this daemon PRINTS may not deny a mechanism this
// daemon's own code implements. The mechanism here is one specific chain — the
// configured cap reaching the admission gate — and the denial is one specific
// sentence, but the tie between them is what nothing had.
//
// WHAT FAILURE THIS WOULD CATCH: `capacity.ts` as it stood at `origin/main` on
// 2026-08-18. Line 2429 printed, to every caller of `describeCapacity`:
//
//     "<term> binds first, and admission never reads the cap at all"
//
// while the docblock on `effectiveCeilingOf`, a few hundred lines up in the
// same file, named that exact sentence as the thing not to say and refuted it
// with the chain. Both halves were prose, nothing held them against each other,
// and the runtime half is the one people read: `epic/KAN-203` read it, believed
// it, and repeated it to the human, to `epic/KAN-39`, to `story/KAN-117`, into
// KAN-517's description and into the systemd drop-in where the cap is set.
//
// Also caught, and these are the same defect arriving later rather than
// hypotheticals: the chain being broken so that `cap` really does stop reaching
// the gate while the corrected prose goes on saying it does (§1 goes red, in
// the opposite direction from §3); the refutation being deleted from the
// docblock, which is what stops the next author re-introducing the sentence
// (§4); and the shortfall line reporting a gap without saying which term
// produced it, which is the shape the false sentence grew out of (§5).
//
// CI-RUNNABLE: yes — imports the built daemon modules, reads source files off
// the checkout, and builds its red-drive fixtures in memory. No live daemon, no
// herdr, no credential, no peer, no terminal, no network.
//
// ---------------------------------------------------------------------------
// WHY A SCANNER AT ALL, AND WHY IT SCANS CODE RATHER THAN THE FILE
// ---------------------------------------------------------------------------
// The docblock is ALLOWED to contain the false sentence — it contains it in
// order to refute it, which is the most useful place for it to be. So a check
// that grepped the file would either fail on the correction or be written to
// ignore the correction by name, and both are worse than nothing.
//
// What separates them is not the wording, it is the position: a comment quotes,
// a string literal asserts. So §3 strips comments and scans what is left, which
// is exactly the text that can reach a caller. That is the same distinction
// `approval-recorded` had to learn on KAN-321 — a marker inside a code fence is
// shown and not asserted — reached independently and for the same reason.
//
// ---------------------------------------------------------------------------
// WHAT IT SUPPLIES ITSELF, AND WHO COVERS THE REST (KAN-145)
// ---------------------------------------------------------------------------
// §6 supplies its own input: it mutates a COPY of `capacity.ts`'s text in
// memory and scans that, so it proves the scanner can report a denial and can
// decline to report a quotation — and it proves nothing whatever about the real
// file. §3 is what reads the real tree, and §3 is therefore the section that is
// about this repository. Neither covers the other and the split is deliberate.
//
// Named rather than left to be inferred:
//
//   * §3 is a static reading of string literals. A sentence assembled at
//     runtime from fragments, or loaded from a data file, is invisible to it.
//   * §3 reads a curated list of denial shapes, not English. A denial phrased
//     in a way nobody has yet written is not caught — which is why the list is
//     seeded with the three sentences that were ACTUALLY written and retired
//     (KAN-517's, capacity.ts's and ActivationRefusal.jsx's) rather than with
//     invented ones, and why §6's negative control proves the correct forms of
//     those same sentences do not trip it.
//   * §1 measures `computeCapacity` in this process. It does not show that the
//     INSTALLED daemon hands those figures to that gate; §2 reads the gate's
//     source, which is a weaker instrument than executing it. A live
//     `butchr_capacity` reading pasted in the PR body is what covers that leg,
//     the same division `verify-effective-ceiling.mjs` makes and for the same
//     reason.
//   * Nothing here says the corrected sentence is well written. It says it does
//     not deny the chain and that it names the binding term. Prose quality is
//     not automatable and this does not pretend to it.
//
// ---------------------------------------------------------------------------
// HOW TO WATCH IT GO RED (do this rather than trusting the green)
// ---------------------------------------------------------------------------
//   cd daemon && npm run build
//   # 1. THE DEFECT ITSELF — put the retired sentence back in the emitted
//   #    string. In src/capacity.ts's shortfall clause, replace
//   #      `${ceiling.boundBy} binds first. The cap is not inert — ...`
//   #    with
//   #      `${ceiling.boundBy} binds first, and admission never reads the cap at all`
//   node scripts/verify-cap-claims-match-the-chain.mjs
//   # OBSERVED 2026-08-18: §3 fails naming capacity.ts and the line, §5 fails
//   # because the rendered line matches a denial, exit 1. No rebuild needed —
//   # §3 reads src as text — but §5 imports from dist, so rebuild before
//   # reading §5's verdict (this repository's own dist-staleness rule; the
//   # guard at the top of this script enforces it rather than trusting it).
//   #
//   # 2. BREAK THE CHAIN INSTEAD — the same disagreement from the other side.
//   #    In src/capacity.ts, replace
//   #      const headroomBeforeStall = Math.min(headroomByCap, headroomByCpu, headroomByMemory);
//   #    with
//   #      const headroomBeforeStall = Math.min(headroomByCpu, headroomByMemory);
//   npm run build && node scripts/verify-cap-claims-match-the-chain.mjs
//   # OBSERVED 2026-08-18: §1 fails — the gate no longer flips when only the
//   # cap moves — so the check reports that the prose is now the wrong half.
//   #
//   # 3. DELETE THE REFUTATION — remove the `headroomByCap → headroom →
//   #    atCapacity` chain from effectiveCeilingOf's docblock.
//   node scripts/verify-cap-claims-match-the-chain.mjs
//   # OBSERVED 2026-08-18: §4 fails. The emitted string is still correct, so
//   # this is the one mutation the other three sections cannot see.
//   #
//   # then `git checkout src/capacity.ts && npm run build` and watch it green.
//
// Usage:
//   cd daemon && npm run build && node scripts/verify-cap-claims-match-the-chain.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { computeCapacity, describeCapacity, effectiveCeilingOf } from '../dist/capacity.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonRoot, '..');

const GIB = 1024 ** 3;

let failures = 0;
const fail = (section, message) => {
  failures++;
  console.error(`  ✗ [${section}] ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);
const check = (section, condition, message) => {
  if (condition) ok(message);
  else fail(section, message);
};

// ---------------------------------------------------------------------------
// Setup guard: a verdict read off a stale build is a verdict about code nobody
// wrote. §3 and §4 read source and are unaffected; §1, §5 and §6's rendering
// import from dist, so the whole run is refused rather than half of it trusted.
// ---------------------------------------------------------------------------
const SRC = path.join(daemonRoot, 'src', 'capacity.ts');
const DIST = path.join(daemonRoot, 'dist', 'capacity.js');
if (!fs.existsSync(DIST)) {
  console.error(`dist is missing (${DIST}). Run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}
if (fs.statSync(DIST).mtimeMs < fs.statSync(SRC).mtimeMs) {
  console.error(
    `dist/capacity.js is OLDER than src/capacity.ts. Every figure below would be ` +
    `about the previous build. Run \`npm run build\` in daemon/ and re-run.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The comment stripper — the whole basis of §3, so it is its own function and
// §6 proves it separates the two halves.
// ---------------------------------------------------------------------------
//
// Returns { code, comments }: the same file with each half blanked out, newlines
// preserved on both sides so a match reports the line number it really sits on.
//
// It is a scanner and not a parser. It tracks the five states that decide
// whether a `/` opens a comment — plain code, '…', "…", `…`, and the `${…}`
// substitution inside a template, which is code again. A regex literal cannot
// be confused with a comment here: `//` IS a comment and `/*` is not a legal
// regex opening, so no `/`-initial token that reaches this scanner is ambiguous.
function splitCodeAndComments(source) {
  const code = [];
  const comments = [];
  let i = 0;
  let state = 'code';
  // How many `${` we are inside; 0 means a backtick closes the template.
  let templateDepth = 0;
  const stack = [];
  const push = (ch, into) => {
    if (ch === '\n') {
      code.push('\n');
      comments.push('\n');
      return;
    }
    code.push(into === 'code' ? ch : ' ');
    comments.push(into === 'comments' ? ch : ' ');
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line-comment') {
      if (ch === '\n') state = stack.pop() ?? 'code';
      push(ch, 'comments');
      i++;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        push(ch, 'comments');
        push(next, 'comments');
        state = stack.pop() ?? 'code';
        i += 2;
        continue;
      }
      push(ch, 'comments');
      i++;
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (ch === '\\') {
        push(ch, 'code');
        if (next !== undefined) push(next, 'code');
        i += 2;
        continue;
      }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) state = 'code';
      push(ch, 'code');
      i++;
      continue;
    }
    if (state === 'template') {
      if (ch === '\\') {
        push(ch, 'code');
        if (next !== undefined) push(next, 'code');
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        templateDepth++;
        state = 'code';
        push(ch, 'code');
        push(next, 'code');
        i += 2;
        continue;
      }
      if (ch === '`') state = 'code';
      push(ch, 'code');
      i++;
      continue;
    }
    // state === 'code'
    if (ch === '/' && next === '/') {
      stack.push('code');
      state = 'line-comment';
      push(ch, 'comments');
      push(next, 'comments');
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      stack.push('code');
      state = 'block-comment';
      push(ch, 'comments');
      push(next, 'comments');
      i += 2;
      continue;
    }
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'template';
    else if (ch === '}' && templateDepth > 0) {
      templateDepth--;
      state = 'template';
    }
    push(ch, 'code');
    i++;
  }
  return { code: code.join(''), comments: comments.join('') };
}

// ---------------------------------------------------------------------------
// The denial shapes.
// ---------------------------------------------------------------------------
//
// Seeded with the sentences that were actually written and retired, not with
// invented ones — an invented pattern proves the author could imagine a defect,
// a real one proves the check would have caught the defect that happened.
//
//   1. capacity.ts:2429          "admission never reads the cap at all"
//   2. KAN-517's own description "a number the gate never reads"
//   3. ActivationRefusal.jsx     "`cap` is not consulted at admission"
//
// Each requires the ASSERTION form. "The cap is not inert" and "the cap is read
// at admission" are the correct sentences and must not match; §6's negative
// control is what proves they do not, rather than this comment claiming it.
const DENIALS = [
  { name: 'admission/the gate never reads the cap', re: /\bnever\s+reads?\s+(the\s+|this\s+)?cap\b/i },
  { name: 'a number the gate never reads', re: /\b(gate|admission)\s+never\s+reads?\b/i },
  { name: 'the cap is never read/consulted', re: /\bcap[`'"\s][^.`]{0,60}?\bis\s+never\s+(read|consulted)\b/i },
  { name: 'the cap is not read/consulted', re: /\bcap[`'"\s][^.`]{0,60}?\bis\s+not\s+(read|consulted)\b/i },
  { name: 'the cap is not consulted at admission', re: /\bnot\s+consulted\s+at\s+admission\b/i },
  { name: 'the cap is inert', re: /\bcap[`'"\s][^.`]{0,60}?\bis\s+inert\b/i },
  { name: 'admission ignores the cap', re: /\b(admission|the\s+gate)\b[^.`]{0,40}?\bignores?\b[^.`]{0,20}?\bcap\b/i }
];

/** Every denial in `text`, with the 1-based line it sits on. */
function denialsIn(text) {
  const hits = [];
  text.split('\n').forEach((line, idx) => {
    for (const d of DENIALS) {
      if (d.re.test(line)) hits.push({ line: idx + 1, name: d.name, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

// ===========================================================================
// Section 1 — the chain, MEASURED. Everything below is a claim about prose;
// this is the only section that establishes which prose is true.
// ===========================================================================
console.log('\n=== 1. The chain: cap → headroomByCap → headroom → atCapacity → the gate ===\n');

// Cores and memory deliberately in surplus so the count term is the only one
// that CAN bind. An explicit quiet stall rather than this machine's, because
// the stall term is a veto that would make the reading depend on what else the
// box was doing (the fixture discipline verify-effective-ceiling.mjs sets out).
const ROOMY = {
  cores: 32,
  busyCores: 1,
  busyWindowSeconds: 5,
  load1: 1,
  totalBytes: 128 * GIB,
  availableBytes: 120 * GIB,
  stall: { io: { state: 'measured', fullAvg10Percent: 0 }, memory: { state: 'measured', fullAvg10Percent: 0 } }
};
const opts = (configuredCap) => ({ configuredCap, supervisorsRunning: 0 });

const tight = computeCapacity(ROOMY, 2, opts(2));
const loose = computeCapacity(ROOMY, 2, opts(9));

console.log(`  cap=2, running=2 → headroomByCap=${tight.headroomByCap} ` +
  `headroomByCpu=${tight.headroomByCpu} headroomByMemory=${tight.headroomByMemory} ` +
  `→ headroom=${tight.headroom} boundBy=${tight.headroomBoundBy} atCapacity=${tight.atCapacity}`);
console.log(`  cap=9, running=2 → headroomByCap=${loose.headroomByCap} ` +
  `headroomByCpu=${loose.headroomByCpu} headroomByMemory=${loose.headroomByMemory} ` +
  `→ headroom=${loose.headroom} boundBy=${loose.headroomBoundBy} atCapacity=${loose.atCapacity}`);
console.log('');

// The link the false sentence denied, asserted as arithmetic rather than as a
// flag: a term that did not read `cap` could not reproduce `cap − running`.
check('1', tight.headroomByCap === 0, 'cap=2, running=2 → the count term reproduces max(0, 2 − 2) = 0');
check('1', loose.headroomByCap === 7, 'cap=9, running=2 → the count term reproduces max(0, 9 − 2) = 7');
check('1', tight.headroomBoundBy === 'cap', 'at cap=2 the count term is the smallest of the three, and is named');
check('1', tight.atCapacity === true, 'at cap=2 the gate is CLOSED (atCapacity true) on a machine with cpu and memory to spare');
check('1', loose.atCapacity === false, 'at cap=9 the same machine, same fleet size, the gate is OPEN');
check(
  '1',
  tight.atCapacity !== loose.atCapacity,
  'changing ONLY the cap flipped the gate — which it could not have done had the gate not read it'
);

// The other half, and the reason the corrected sentence is narrower rather than
// the opposite of the false one: `cap` is one term in a `min`, so it can lower
// the number admitted and never raise it.
const starved = computeCapacity(
  { ...ROOMY, totalBytes: 16 * GIB, availableBytes: 1.2 * GIB },
  2,
  opts(10)
);
console.log(`  cap=10, memory-starved → headroomByCap=${starved.headroomByCap} ` +
  `headroomByMemory=${starved.headroomByMemory} → headroom=${starved.headroom} ` +
  `boundBy=${starved.headroomBoundBy}`);
console.log('');
check(
  '1',
  starved.headroomByCap > 0 && starved.headroomBoundBy !== 'cap',
  `a cap of 10 offering ${starved.headroomByCap} slots does not raise headroom past the ` +
  `${starved.headroomBoundBy} term — it is read, and it is not what bound`
);

// ===========================================================================
// Section 2 — the gate itself reads `atCapacity`.
// ===========================================================================
console.log('\n=== 2. The admission gate reads the field §1 measured ===\n');

const routerSrc = fs.readFileSync(path.join(daemonRoot, 'src', 'router.ts'), 'utf8');
const routerCode = splitCodeAndComments(routerSrc).code;
check(
  '2',
  /if\s*\(\s*!\s*capacity\.atCapacity\s*\)/.test(routerCode),
  'router.ts admits on `!capacity.atCapacity` — the last link, read as code and not as a comment'
);
check(
  '2',
  denialsIn(routerCode).length === 0,
  'router.ts emits no string denying that the cap is read'
);

// ===========================================================================
// Section 3 — the emitted prose of the product, comments stripped.
// ===========================================================================
console.log('\n=== 3. No emitted string denies the chain §1 measured ===\n');

/** Every product source file whose string literals can reach a person. */
function productSources() {
  const out = [];
  const walk = (dir, exts) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, exts);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(abs);
    }
  };
  walk(path.join(daemonRoot, 'src'), ['.ts']);
  walk(path.join(repoRoot, 'extension', 'src'), ['.js', '.jsx']);
  return out.sort();
}

const sources = productSources();
check('3', sources.length > 0, `${sources.length} product source file(s) found to scan`);

// The positive control this section's null result needs. An empty scan is a
// claim about the regexes until something has been shown to match them, and
// what is used here is the real retired text rather than a paraphrase.
const RETIRED = [
  '`${ceiling.boundBy} binds first, and admission never reads the cap at all`',
  "'`cap` is not consulted at admission — the gate is live headroom'",
  "'`cap` is never read at admission … a number the gate never reads'",
  "'BUTCHR_MAX_AGENTS is inert: the cap is inert on this machine'",
  "'admission ignores the cap entirely'"
];
const controlHits = RETIRED.map((line) => denialsIn(line).length);
check(
  '3',
  controlHits.every((n) => n > 0),
  `positive control: all ${RETIRED.length} retired sentences match a denial shape ` +
  `(${controlHits.join(', ')} hit(s)) — so an empty scan below is about the tree, not the regexes`
);

let scanned = 0;
let emittedDenials = 0;
for (const abs of sources) {
  const rel = path.relative(repoRoot, abs);
  const { code } = splitCodeAndComments(fs.readFileSync(abs, 'utf8'));
  scanned++;
  for (const hit of denialsIn(code)) {
    emittedDenials++;
    fail('3', `${rel}:${hit.line} emits a denial (${hit.name}): ${hit.text}`);
  }
}
check(
  '3',
  emittedDenials === 0,
  `${scanned} file(s) scanned as code with comments stripped; no emitted string denies that the cap is read`
);

// The second positive control, and this one is about THIS TREE rather than
// about a fixture: the sentence IS present in capacity.ts — in the docblock,
// where it is quoted in order to be refuted. Finding it in the comment half and
// not in the code half is what shows the split did its job on the real file.
const capacitySrc = fs.readFileSync(SRC, 'utf8');
const capacityHalves = splitCodeAndComments(capacitySrc);
const inComments = denialsIn(capacityHalves.comments);
check(
  '3',
  inComments.length > 0,
  `capacity.ts's COMMENTS carry ${inComments.length} quotation(s) of the retired sentence ` +
  `(line(s) ${inComments.map((h) => h.line).join(', ')}) — quoted to be refuted, and correctly not counted`
);
check(
  '3',
  capacityHalves.code.length === capacitySrc.length &&
    capacityHalves.comments.length === capacitySrc.length,
  'both halves are the same length as the file, so reported line numbers are the file\'s own'
);

// ===========================================================================
// Section 4 — the refutation is still in the docblock.
// ===========================================================================
console.log('\n=== 4. The docblock still carries the chain that refutes it ===\n');

// Asserted on the chain's IDENTIFIERS in order rather than on its wording: the
// paragraph should be free to be rewritten, and is not free to stop naming the
// mechanism. This is the only section that would notice the correction being
// quietly deleted while every emitted string stayed correct.
const chainParagraph = capacityHalves.comments
  .split(/\n\s*\*?\s*\n/)
  .find((para) => /headroomByCap/.test(para) && /atCapacity/.test(para));
check('4', Boolean(chainParagraph), 'capacity.ts has a comment paragraph naming both `headroomByCap` and `atCapacity`');
if (chainParagraph) {
  const order = ['headroomByCap', 'headroom =', 'atCapacity'];
  let cursor = 0;
  let inOrder = true;
  for (const token of order) {
    const at = chainParagraph.indexOf(token, cursor);
    if (at < 0) inOrder = false;
    else cursor = at + token.length;
  }
  check('4', inOrder, `the chain is spelled out in order: ${order.join(' → ')}`);
  check(
    '4',
    /\bcap\b/.test(chainParagraph) && /min\(|minimum/.test(chainParagraph),
    'the paragraph says the cap is one term in a minimum, which is the half that IS true'
  );
}

// ===========================================================================
// Section 5 — the rendered shortfall clause: names the term, denies nothing.
// ===========================================================================
console.log('\n=== 5. The line the defect was in, rendered ===\n');

// Memory short and cores free: the state KAN-517 measured, and the only state
// in which the shortfall clause is printed at all.
const shortfallMachine = {
  cores: 8,
  busyCores: 0.5,
  busyWindowSeconds: 5,
  load1: 0.5,
  totalBytes: 16 * GIB,
  availableBytes: 5.2 * GIB,
  stall: { io: { state: 'measured', fullAvg10Percent: 0 }, memory: { state: 'measured', fullAvg10Percent: 0 } }
};
const gapped = computeCapacity(shortfallMachine, 2, { configuredCap: 10, supervisorsRunning: 4 });
const gappedCeiling = effectiveCeilingOf(gapped);
const ceilingLine = describeCapacity(gapped)
  .split('\n')
  .find((l) => l.startsWith('effective ceiling:'));

console.log(`  boundBy=${gappedCeiling.boundBy} ceiling=${gappedCeiling.ceiling} ` +
  `shortfall=${gappedCeiling.shortfall} headroomByCap=${gapped.headroomByCap}`);
console.log('');
console.log(`  ${ceilingLine}`);
console.log('');

check('5', gappedCeiling.shortfall > 0, 'the fixture reaches the shortfall branch — the clause under test is printed');
check('5', Boolean(ceilingLine), 'the derivation carries an `effective ceiling:` line');
if (ceilingLine) {
  check('5', denialsIn(ceilingLine).length === 0, 'the rendered clause matches no denial shape');
  check(
    '5',
    new RegExp(`\\b${gappedCeiling.boundBy}\\b`).test(ceilingLine),
    `the clause names the term that bound (${gappedCeiling.boundBy}) rather than generalising`
  );
  check(
    '5',
    ceilingLine.includes(String(gapped.headroomByCap)),
    `the clause carries the count term's own figure (${gapped.headroomByCap}), so a reader can see the cap WAS read`
  );
}

// ===========================================================================
// Section 6 — DRIVEN RED, in process, both directions.
// ===========================================================================
console.log('\n=== 6. Driven red: the scanner reports an assertion and not a quotation ===\n');

// The mutation is applied to a copy of the real file's text so the fixture is
// the shape of the real defect rather than a convenient one. Nothing is written
// to disk and the real file is untouched.
//
// ⚠ BOTH ARMS ASSERT ON A DELTA, NOT ON AN ABSOLUTE COUNT, and that is not
// tidiness. Read absolutely, arm (b) — "no denial in the code half" — is a
// restatement of §3, so it would go red whenever §3 did and its message
// ("a quotation was miscounted as an assertion") would be false. Measured while
// building this: with the retired sentence deliberately restored to the emitted
// string, arm (b) reported the scanner confusing comments with code, which it
// was not doing. A delta asks this section's own question and leaves §3's to §3.
//
// The injection point is chosen for the same reason: appending a `lines.push`
// depends on nothing about how the shortfall clause is currently worded, so
// rewording that clause cannot silently turn this section into a no-op.
const FALSE_SENTENCE = 'admission never reads the cap at all';
const INJECT_AT = "  return lines.join('\\n');";

const baseCodeHits = denialsIn(capacityHalves.code).length;
const baseCommentHits = denialsIn(capacityHalves.comments).length;
check('6', capacitySrc.includes(INJECT_AT), 'the injection point was located in describeCapacity');

// (a) the denial injected into an EMITTED STRING — the defect itself.
const mutatedEmitted = capacitySrc.replace(
  INJECT_AT,
  `  lines.push('${FALSE_SENTENCE}');\n${INJECT_AT}`
);
check('6', mutatedEmitted !== capacitySrc, 'mutation (a) changed the source copy');
const hitsA = denialsIn(splitCodeAndComments(mutatedEmitted).code).length;
check(
  '6',
  hitsA > baseCodeHits,
  `(a) a denial added to an emitted string IS reported: ${baseCodeHits} → ${hitsA} hit(s) in the code half`
);

// (b) the IDENTICAL sentence in a comment — the refutation's own position.
// This is the arm that matters: a check that fired here would have to be
// written to ignore the correction by name, which is how a gate stops meaning
// anything.
const mutatedComment = capacitySrc.replace(
  INJECT_AT,
  `  // A later author quoting the retired sentence — "${FALSE_SENTENCE}" — in\n` +
  '  // order to say why it is wrong. This must not be a failure.\n' +
  INJECT_AT
);
check('6', mutatedComment !== capacitySrc, 'mutation (b) changed the source copy');
const halvesB = splitCodeAndComments(mutatedComment);
check(
  '6',
  denialsIn(halvesB.code).length === baseCodeHits,
  `(b) the same sentence in a COMMENT adds nothing to the code half (${baseCodeHits} → ` +
  `${denialsIn(halvesB.code).length}) — the check reads assertions, not quotations`
);
check(
  '6',
  denialsIn(halvesB.comments).length > baseCommentHits,
  `(b) and it did land in the comment half (${baseCommentHits} → ` +
  `${denialsIn(halvesB.comments).length}), so the arm above is a real negative and not a missed edit`
);

// (c) the negative control for the regexes themselves: the CORRECT forms of all
// three retired sentences must not match. Without this, §3's list could be
// tightened into uselessness — or loosened until it fails on the fix — and
// nothing would say so.
const CORRECT_FORMS = [
  'The cap is not inert — it is read at every admission, as the count term, which allows 8 here',
  'cpu binds first; the cap is read at admission and is simply not the binding term',
  '`cap` is consulted at admission, as one of the three terms headroom is the minimum of',
  'memory binds first. The cap is read and it is not what refused this start'
];
const falsePositives = CORRECT_FORMS.filter((line) => denialsIn(line).length > 0);
check(
  '6',
  falsePositives.length === 0,
  `(c) all ${CORRECT_FORMS.length} correct forms pass — including the one now shipped in capacity.ts` +
  (falsePositives.length ? ` (tripped: ${falsePositives.join(' | ')})` : '')
);

// (d) §4's mutation: the refutation deleted while every string stays correct.
const withoutChain = capacitySrc.replace(/headroomByCap/g, 'headroomByCount');
const paraGone = !splitCodeAndComments(withoutChain)
  .comments.split(/\n\s*\*?\s*\n/)
  .some((para) => /headroomByCap/.test(para) && /atCapacity/.test(para));
check('6', paraGone, '(d) §4 goes red when the chain stops being named in the docblock');

// ===========================================================================
console.log('');
if (failures === 0) {
  console.log(`ALL CHECKS PASSED — the emitted prose and the measured chain agree.`);
} else {
  console.error(`${failures} CHECK(S) FAILED.`);
}
process.exit(failures ? 1 : 0);
