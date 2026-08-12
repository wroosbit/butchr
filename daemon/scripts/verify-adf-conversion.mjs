// KAN-293: the markdown→ADF conversion every content write shares, and the one
// property that matters about it — nothing an agent wrote is silently dropped.
//
// WHAT FAILURE THIS WOULD CATCH: the converter losing content on a nested
// structure, which is the defect that has now bitten this board twice. KAN-183
// saved a Confluence page that came back missing an invariant, a bullet and a
// whole section; KAN-266 lost a blockquote nested in a numbered list. Both were
// the official markdown→ADF converter, both returned success, and both were
// found by a human reading the page later. This script would catch the same
// defect in ours: a blockquote that vanishes from a list item, a list item that
// takes its own text with it, a table cell whose contents are silently emptied,
// or the completeness guard being removed so that any of those become possible
// again.
//
// It would equally catch the converter emitting ADF that is nesting-illegal —
// which is how the content gets dropped in the first place, since Atlassian
// discards an offending subtree rather than rejecting the document.
//
// CI-RUNNABLE: yes — imports the built converter and asserts against it in
// process; no live daemon, no herdr, no credential, no network, no terminal.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// **This script supplies its own markdown and reads its own output.** It never
// sends a document to Atlassian, so it cannot tell you that what it produced is
// what Atlassian *stored* — and that gap is the entire subject of KAN-183. A
// converter can be perfect and the write still lose content at the API.
//
// That leg is covered, and not by nobody:
//
//   - `daemon/scripts/probe-atlassian-proxy-content-writes.mjs` performs the
//     real round trip: it writes this exact nested structure through the proxy
//     with the daemon's real credential, reads the stored document back, and
//     compares. It is a `probe-` because it touches production Confluence.
//   - The **measurement in `adf.ts`'s header**, which is what established that
//     ADF can carry this structure at all — Confluence page 5046273 sent as ADF
//     kept every marker; page 5079041 sent as markdown lost two of three.
//
// ── WHY §2 RE-IMPLEMENTS THE COMPLETENESS CHECK INSTEAD OF CALLING IT ───────
//
// `markdownToAdf` enforces completeness itself, on every call, and throws when
// it would lose a token. So the laziest version of this script is "call it and
// see if it throws" — which asserts that **the converter agrees with itself**
// and nothing more. Delete the guard inside `adf.ts` and that version stays
// green while the defect it exists to prevent walks straight back in.
//
// So §2 tokenises the source and the produced document **here**, with this
// file's own code, and compares. It is a second implementation of the property
// rather than a call to the first. §5 then checks the converter's internal
// guard separately, because that guard is what protects agents at runtime and
// this script only protects the build.
//
// Usage: node daemon/scripts/verify-adf-conversion.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const { markdownToAdf, confluenceBody, AdfConversionError } = await import('../dist/adf.js');

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok || verbose) {
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 10).join('\n         ')}`);
  }
  if (!ok) failures++;
}

/**
 * Convert, turning a refusal into a legible FAIL instead of a stack trace.
 *
 * Needed because of what the red drive actually produced. Breaking the
 * converter to drop a blockquote made `markdownToAdf` **refuse** — its own
 * completeness guard fired first and named the lost marker — so this script
 * died at the first conversion with an uncaught error and reported nothing
 * about the twenty checks after it. Exit 1 either way, which is the problem: an
 * accidental crash and a real verdict looked identical.
 *
 * A refusal here IS a failure of this file's subject — the corpus is content
 * that must convert — so it is recorded as one, and the run continues.
 */
function convert(label, source) {
  try {
    return markdownToAdf(source);
  } catch (err) {
    check(`${label}: converts without refusing`, false, err?.message ?? String(err));
    return { doc: { type: 'doc', version: 1, content: [] }, coercions: [] };
  }
}

/** Walk a document, yielding every [parentType, node] pair. */
function* walk(node, parent = null) {
  yield [parent, node];
  for (const child of node.content ?? []) yield* walk(child, node.type);
}

/** Find the first node of a type, anywhere. */
const find = (doc, type) => [...walk(doc)].map(([, n]) => n).find((n) => n.type === type);

/** Is `type` reachable underneath a node of type `under`? */
function nestedUnder(doc, under, type) {
  const stack = [[doc, false]];
  while (stack.length) {
    const [node, inside] = stack.pop();
    if (inside && node.type === type) return true;
    for (const child of node.content ?? []) {
      stack.push([child, inside || node.type === under]);
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE STRUCTURE THE OFFICIAL CONVERTER DESTROYS
// ═══════════════════════════════════════════════════════════════════════════
rule('1. the nesting that loses content elsewhere is produced correctly here');

// Exactly the input measured against the live API on 2026-08-12, whose stored
// result was `<ul><li><p>SECOND-ITEM-ECHO</p></li></ul>` — two of three markers
// gone. See `adf.ts`'s header.
const KAN266 = `- ITEM-MARKER-CHARLIE
  > QUOTE-MARKER-DELTA
- SECOND-ITEM-ECHO`;

const kan266 = convert('the KAN-266 nesting', KAN266).doc;
const listItems = [...walk(kan266)].filter(([, n]) => n.type === 'listItem');

check(
  'both list items survive — the official converter kept only the second',
  listItems.length === 2,
  JSON.stringify(kan266)
);
check(
  'the blockquote is inside the list item, not lifted out of it or dropped',
  nestedUnder(kan266, 'listItem', 'blockquote'),
  JSON.stringify(kan266)
);
check(
  "the quoted marker's text is present",
  JSON.stringify(kan266).includes('QUOTE-MARKER-DELTA'),
  JSON.stringify(kan266)
);
check(
  "the item's own text is present — this is the half KAN-266 never recorded",
  JSON.stringify(kan266).includes('ITEM-MARKER-CHARLIE'),
  JSON.stringify(kan266)
);

// The acceptance criterion's structure: blockquote in a list in a table.
const NESTED = `| Case | Nested content |
| --- | --- |
| the AC2 case | - LIST-IN-CELL-FOXTROT<br>  > QUOTED-IN-CELL-HOTEL |`;

const nested = convert('the AC2 nesting', NESTED).doc;
check(
  'a table is produced with a header row',
  find(nested, 'table') && find(nested, 'tableHeader'),
  JSON.stringify(nested)
);
check(
  'blockquote in a list in a table cell — all three levels, in that order',
  // Any cell, not the first: the first cell of that row is the label column,
  // and asking it about a blockquote it never carried is how this check
  // reported a converter defect that was entirely its own.
  [...walk(nested)]
    .map(([, n]) => n)
    .filter((n) => n.type === 'tableCell')
    .some((cell) => nestedUnder(cell, 'listItem', 'blockquote')),
  JSON.stringify(nested)
);
check(
  'and both markers inside it survived',
  JSON.stringify(nested).includes('LIST-IN-CELL-FOXTROT') &&
    JSON.stringify(nested).includes('QUOTED-IN-CELL-HOTEL'),
  JSON.stringify(nested)
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. COMPLETENESS, RE-DERIVED HERE RATHER THAN ASKED OF THE CONVERTER
// ═══════════════════════════════════════════════════════════════════════════
rule('2. no source token is lost — checked by this file, not by adf.ts');

/**
 * This file's own tokenisers. Deliberately a second implementation: see the
 * header. If these two ever disagree with `adf.ts`'s, one of them is wrong and
 * that is a thing worth finding out.
 */
// A token starts and ends on an alphanumeric, so an emphasis delimiter glued to
// a word is not part of it. Same shape as `adf.ts` uses, and it has to be: the
// two sides of a comparison must count the same things or the comparison means
// nothing. Arrived at independently here by hitting the same false positive.
const WORDS = /[A-Za-z0-9](?:[A-Za-z0-9_'-]*[A-Za-z0-9])?/g;
const sourceTokens = (markdown) =>
  (markdown
    .split('\n')
    .filter((line) => !/^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(line.trim()) || !line.includes('-'))
    .map((line) =>
      line
        .replace(/^\s*(>\s?)+/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*```/, '')
        .replace(/<br\s*\/?>/gi, ' ')
    )
    .join('\n')
    .match(WORDS) ?? []);

function documentTokens(node) {
  const own = node.text ?? '';
  const language = typeof node.attrs?.language === 'string' ? ` ${node.attrs.language}` : '';
  const href = node.marks?.find((m) => m.type === 'link')?.attrs?.href;
  const link = typeof href === 'string' ? ` ${href}` : '';
  const kids = (node.content ?? []).map(documentTokens).join(' ');
  return `${own}${language}${link} ${kids}`;
}

const CORPUS = [
  ['the KAN-266 nesting', KAN266],
  ['the AC2 nesting', NESTED],
  ['headings and prose', '# Title\n\nA paragraph with **bold**, *em*, `code` and [a link](https://example.com/p).'],
  ['a fenced code block', 'Before.\n\n```js\nconst answer = 42;\n```\n\nAfter.'],
  ['a deeply nested list', '- one ALPHA\n  - two BRAVO\n    - three CHARLIE\n      > four DELTA'],
  ['an ordered list inside a quote', '> quoted intro ECHO\n> 1. first FOXTROT\n> 2. second GOLF'],
  ['a table whose cells carry structure', '| a | b |\n| --- | --- |\n| plain HOTEL | - listed INDIA |'],
  ['mixed blocks', '## H2 JULIET\n\ntext KILO\n\n---\n\n- item LIMA\n\n> quote MIKE'],
  ['literal markup characters', 'A lone * star and an _underscore_ and 2*3 = 6 NOVEMBER'],
  ['a numbered list not starting at one', '3. third OSCAR\n4. fourth PAPA']
];

for (const [name, source] of CORPUS) {
  const { doc } = convert(name, source);
  const produced = new Set((documentTokens({ type: 'doc', content: doc.content }).match(WORDS) ?? []));
  const missing = [...new Set(sourceTokens(source))].filter((t) => !produced.has(t));
  check(`${name}: every source token appears in the document`, missing.length === 0, `missing: ${JSON.stringify(missing)}`);
}

// ── THE POSITIVE CONTROL ON THE INSTRUMENT ITSELF ──────────────────────────
//
// Every assertion above is "nothing was missing", and a comparison that can
// never report a difference passes exactly the same way. So: feed the *checker*
// a document that genuinely has lost content and require it to notice. This
// tests §2's own arithmetic rather than the converter.
{
  const source = 'alpha bravo charlie';
  const mutilated = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }] };
  const produced = new Set((documentTokens(mutilated).match(WORDS) ?? []));
  const missing = [...new Set(sourceTokens(source))].filter((t) => !produced.has(t));
  check(
    "the completeness check can say NO — a document missing two words is reported as missing two",
    missing.length === 2 && missing.includes('bravo') && missing.includes('charlie'),
    JSON.stringify(missing)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. EVERY NODE IS A LEGAL CHILD OF ITS PARENT
// ═══════════════════════════════════════════════════════════════════════════
rule('3. the produced ADF is nesting-legal — illegal ADF is how content gets dropped');

// This file's own copy of the rules, from the ADF schema and from the official
// server's stated nesting constraints. A second copy on purpose: `adf.ts`
// enforcing its own table proves only that it is self-consistent.
const LEGAL = {
  doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'table', 'rule'],
  paragraph: ['text'],
  heading: ['text'],
  codeBlock: ['text'],
  blockquote: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: ['paragraph', 'bulletList', 'orderedList', 'blockquote', 'codeBlock'],
  table: ['tableRow'],
  tableRow: ['tableCell', 'tableHeader'],
  tableCell: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'],
  tableHeader: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'],
  rule: [],
  text: []
};

const illegal = [];
for (const [name, source] of CORPUS) {
  const { doc } = convert(name, source);
  for (const [parent, node] of walk({ type: 'doc', content: doc.content })) {
    if (!parent) continue;
    const allowed = LEGAL[parent];
    if (!allowed) {
      illegal.push(`unknown parent type ${parent}`);
    } else if (!allowed.includes(node.type)) {
      illegal.push(`${node.type} inside ${parent}`);
    }
  }
}
check(
  'no node in the whole corpus sits somewhere ADF does not allow it',
  illegal.length === 0,
  JSON.stringify([...new Set(illegal)])
);
check(
  'a table cell really does hold a blockquote — the rule that permits the AC2 case is exercised',
  (() => {
    const { doc } = convert('the AC2 nesting', NESTED);
    return [...walk({ type: 'doc', content: doc.content })].some(
      ([parent, node]) => parent === 'listItem' && node.type === 'blockquote'
    );
  })(),
  'if this is false the corpus never exercises the nesting the ticket is about, and §3 is vacuous'
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. A COERCION IS REPORTED, NEVER SILENT
// ═══════════════════════════════════════════════════════════════════════════
rule('4. where a block must change shape, the caller is told');

const coerced = convert('a heading in a list item', '- item ROMEO\n  # heading in a list item SIERRA');
check(
  'a heading inside a list item is reported as a coercion rather than applied quietly',
  coerced.coercions.length === 1 && /heading inside listItem/.test(coerced.coercions[0]),
  JSON.stringify(coerced.coercions)
);
check(
  "and the heading's text survives the coercion",
  JSON.stringify(coerced.doc).includes('SIERRA'),
  JSON.stringify(coerced.doc)
);
check(
  'an ordinary document reports no coercions at all',
  markdownToAdf('# Fine\n\nA paragraph.').coercions.length === 0,
  JSON.stringify(markdownToAdf('# Fine\n\nA paragraph.').coercions)
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE RUNTIME GUARD INSIDE THE CONVERTER
// ═══════════════════════════════════════════════════════════════════════════
rule("5. adf.ts's own guard — the one that protects agents, not just this build");

const adfSrc = fs.readFileSync(path.join(daemonDir, 'src', 'adf.ts'), 'utf8');
check(
  'markdownToAdf throws rather than returns when it would lose content',
  /throw new AdfConversionError\(/.test(adfSrc) && /would have lost \$\{missing\.length\} token/.test(adfSrc),
  'the completeness guard is not in the source; agents are unprotected at runtime even if ' +
    'this build happens to convert correctly'
);
check(
  'the guard runs on every conversion, not behind a flag or an option',
  !/if \(\s*(options|opts|check|strict)/.test(adfSrc.split('export function markdownToAdf')[1] ?? ''),
  'a completeness check that can be switched off is one that will be'
);
check(
  'an unrepresentable nesting is refused rather than dropped',
  /this converter has no content-preserving substitution for that pairing/.test(
    adfSrc.replace(/'\s*\+\s*\n?\s*'/g, '').replace(/`\s*\+\s*\n?\s*'/g, '').replace(/\s+/g, ' ')
  ),
  'the no-coercion branch must throw; a converter that returns something for every input ' +
    'is a converter that drops'
);
check(
  'AdfConversionError is exported, so callers can tell a conversion refusal from a crash',
  typeof AdfConversionError === 'function',
  'callers cannot distinguish "your markdown could not be represented" from a daemon bug'
);

// The measured claim this whole file rests on must stay traceable to what was
// measured, not become folklore.
check(
  'the header still cites the two real pages the loss and the survival were measured on',
  /5079041/.test(adfSrc) && /5046273/.test(adfSrc),
  'the evidence for "the official converter loses content" has become an unsourced assertion'
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. WHAT CONFLUENCE ACTUALLY RECEIVES
// ═══════════════════════════════════════════════════════════════════════════
rule('6. the Confluence body wrapper');

const wrapped = confluenceBody(convert('the wrapper case', '- a ALPHA\n  > b BRAVO').doc);
check(
  'representation is atlas_doc_format',
  wrapped.representation === 'atlas_doc_format',
  JSON.stringify(wrapped).slice(0, 200)
);
check(
  'value is a JSON *string*, which is what the v2 API wants',
  typeof wrapped.value === 'string' && JSON.parse(wrapped.value).type === 'doc',
  typeof wrapped.value
);
check(
  'and the nesting survived being serialised',
  nestedUnder(JSON.parse(wrapped.value), 'listItem', 'blockquote'),
  wrapped.value
);

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — the nesting that loses content through the official converter survives here, ' +
        'completeness is re-derived independently and shown able to report a loss, every ' +
        'node is nesting-legal, and coercions are reported rather than silent.'
  }\n`
);
process.exit(failures ? 1 : 0);
