// KAN-658: the brief-vs-mechanism check read `prompts/task.md` and nothing
// else, so three of the four briefs were never measured against
// `PROXY_OPERATIONS` by anything.
//
// WHAT FAILURE THIS WOULD CATCH: a cross-ticket write mandate being ADDED to
// any brief in `prompts/` without a recorded answer for it — the shape that hit
// `story/KAN-657` in flight on 2026-08-21, when its FIRST job was to link
// KAN-652 and KAN-656 `Duplicate` and `atlassian_create_issue_link` refused it
// `not-your-ticket` because neither end was that agent's own ticket. That
// mandate is `prompts/story.md:260`, it is a `link`, and neither KAN-515's
// check nor KAN-633's table named it: KAN-515 opens one brief
// (`const BRIEF_REL = 'prompts/task.md'`), and a `link` was the fourth shape
// nobody had written down. It equally catches the opposite drift — one of the
// recorded mandates being deleted or reworded while `docs/atlassian-proxy.md`
// goes on asserting the answer that rested on it — and a brief appearing in or
// disappearing from `prompts/` with no entry in the record.
//
// CI-RUNNABLE: yes — every section reads repository files as TEXT and asserts
// in process; no live daemon, no herdr, no credential, no peer, no terminal,
// no network.
//
// ── THIS SCRIPT DOES NOT IMPORT `dist`, AND THAT IS LOAD-BEARING ───────────
//
// `prompts/task.md` requires a reader to establish which kind of proof they ran
// before trusting or discarding its verdict: a `dist`-importing proof run after
// a failed build tested the previous build, so its verdict — pass OR fail — is
// evidence about code nobody wrote. **This one reads `src` and four prose
// documents as text and imports nothing**, so a failed build does not
// invalidate it and a red here is about the tree in front of you. There is no
// blended section: no part of this file reads `dist`.
//
// The cost of that choice is stated rather than hidden, and it is the same cost
// `verify-task-agent-write-list.mjs` names: reading a table as text means this
// script agrees with a *regex* over `PROXY_OPERATIONS`, not with the table the
// daemon actually serves. §1 keeps that script's count floors for exactly that
// reason, and §5 adds the floors the sweep needs, which are the same idea
// applied to a second parse: a detector that has stopped matching returns zero
// hits, and zero hits is indistinguishable from "no brief mandates a
// cross-ticket write" — the empty result `prompts/task.md` tells you to refuse
// to report as a finding.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ──────────────
//
// **§1–§6 supply none of their input**: they read the real `prompts/`, the real
// `docs/atlassian-proxy.md` and the real `daemon/src/atlassian-proxy.ts` off the
// checkout, which is the whole of what they are for.
//
// **§7 supplies its own input and is honest about what that leaves uncovered.**
// It drives the real detector over string literals written here, so it proves
// the detector can say YES and can say NO — and proves NOTHING about the real
// briefs, which is §5's job. KAN-145's defect was two scripts each asserting a
// field was carried correctly over records they had constructed with the field
// already in them; the gap was between them and no script owned it. Here the
// two legs are in one file and named as complementary: §5 reads the world, §7
// shows the instrument can be false. Neither covers the other.
//
// What NOTHING here covers, named rather than left to be inferred:
//
//   - **Whether the proxy really refuses these writes.** This is a consistency
//     proof over six documents. `verify-atlassian-proxy-write-scope.mjs`
//     asserts what `refuseWriteOutsideCaller` actually decides;
//     `verify-atlassian-proxy-failure-is-loud.mjs` drives a real daemon over
//     MCP stdio. A real refusal by a real agent is the leg no script can run,
//     and `story/KAN-657` pasted one on 2026-08-21 (the `link` above).
//   - **`prompts/task.md`'s own recorded answer**, which is
//     `verify-task-agent-write-list.mjs` §3–§5 and stays there. This script
//     covers task.md only as one of four briefs in the inventory below; the
//     overlap is deliberate and the two are not redundant — that script pins
//     the counts in `PROXY_OPERATIONS`'s own docblock, which is per-table and
//     not per-brief.
//   - **Prose that mandates a cross-ticket write in words no pattern here
//     matches.** The detector reads the shapes the four briefs actually use.
//     A mandate phrased around none of them is invisible to it, and §5's
//     per-brief floors are what turn "the detector stopped working" into a red
//     rather than into a quiet zero — they do not turn "the detector never knew
//     that phrasing" into one. That hole is real and is why the record is
//     written as prose a human reads, not only as a table a script parses.
//
// Usage: node daemon/scripts/verify-brief-cross-ticket-write-inventory.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PROXY_SRC_REL = 'daemon/src/atlassian-proxy.ts';
const DOC_REL = 'docs/atlassian-proxy.md';
const BRIEF_DIR_REL = 'prompts';
const RECORD_HEADING = '#### The four-brief cross-ticket write inventory';

const proxySrc = read(PROXY_SRC_REL);
const doc = read(DOC_REL);

// ── 1. the write table, measured from source rather than quoted ────────────
//
// Lifted from `verify-task-agent-write-list.mjs` §1, floors included, because
// the whole inventory below is expressed in terms of this table's scopes: a
// row saying `atlassian_create_issue_link` is `own-ticket-endpoint` is a claim
// about THIS parse, and a parse that stopped working would make every such
// claim vacuous rather than wrong.
rule('1. every write in PROXY_OPERATIONS, and what bounds it');

// KAN-633 added `supervised-ticket`: the caller's own ticket plus any ticket
// the board places under it. It IS caller-bounded — bounded twice, in fact,
// by the caller's key without a read and by the board's approver relation
// with one — so a refused row may rest on it. The alternation below lists
// longer tags before their prefixes; `own-ticket` is a prefix of
// `own-ticket-endpoint` and an alternation that forgot that would record
// every endpoint scope as an own-ticket one.
const SCOPE_KINDS = [
  'own-ticket',
  'own-ticket-endpoint',
  'supervised-ticket',
  'own-project',
  'unscoped'
];
const CALLER_BOUNDED = ['own-ticket', 'own-ticket-endpoint', 'supervised-ticket', 'own-project'];
const writes = [];
const toolsSeen = [];
{
  let open = null;
  const lines = proxySrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const tool = /^\s*tool: '([a-z_]+)',/.exec(lines[i]);
    if (tool) {
      open = { tool: tool[1], line: i + 1 };
      toolsSeen.push(tool[1]);
      continue;
    }
    const kind = /^\s*kind: '(own-ticket-endpoint|own-ticket|supervised-ticket|own-project|unscoped)',/.exec(lines[i]);
    if (kind && open) {
      writes.push({ ...open, scope: kind[1] });
      open = null;
    }
  }
}
const scopeOf = (tool) => (writes.find((w) => w.tool === tool) || {}).scope;
const counts = Object.fromEntries(SCOPE_KINDS.map((k) => [k, writes.filter((w) => w.scope === k).length]));

console.log(
  `   ${writes.length} writes — ` +
    SCOPE_KINDS.map((k) => `${counts[k]} ${k}`).join(', ') +
    `; ${toolsSeen.length} operations in the table overall`
);

check(
  'the table parsed at all — more than 20 operations found',
  toolsSeen.length > 20,
  `found ${toolsSeen.length}; if this is 0 the tool regex has stopped matching and every scope below is meaningless`
);
check(
  'the table carries writes — at least one of every caller-bounded scope',
  CALLER_BOUNDED.every((k) => counts[k] > 0),
  CALLER_BOUNDED.map((k) => `${k}=${counts[k]}`).join(' ')
);

// The four operations the four cross-ticket shapes resolve to. A shape whose
// operation has fallen out of the table is a red rather than a silent skip:
// the record's scope column would otherwise be asserting about an operation the
// proxy no longer carries.
const SHAPE_OPERATION = {
  comment: 'atlassian_add_comment',
  transition: 'atlassian_transition_issue',
  edit: 'atlassian_edit_issue',
  link: 'atlassian_create_issue_link'
};
const SHAPES = Object.keys(SHAPE_OPERATION);

for (const [shape, tool] of Object.entries(SHAPE_OPERATION)) {
  check(
    `the ${shape} shape resolves to a write in the table — ${tool} (${scopeOf(tool) || 'MISSING'})`,
    Boolean(scopeOf(tool)),
    `${tool} is not a write in ${PROXY_SRC_REL}; the inventory's scope column for every ${shape} row is asserting about an operation the proxy no longer carries`
  );
}

// ── 2. the briefs on disk ──────────────────────────────────────────────────
//
// Discovered by reading the directory, never from a list here. That is the
// whole of what KAN-658 was filed for: `verify-task-agent-write-list.mjs` names
// one brief in a constant, so a fifth brief added tomorrow would be measured by
// nothing and nothing would say so.
rule('2. the briefs in prompts/, discovered rather than listed');

const briefFiles = fs
  .readdirSync(path.join(repoRoot, BRIEF_DIR_REL))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => `${BRIEF_DIR_REL}/${f}`);

for (const b of briefFiles) console.log(`   ${b}`);

check(
  'prompts/ holds at least four briefs',
  briefFiles.length >= 4,
  `found ${briefFiles.length}: ${briefFiles.join(', ') || '(none)'}. If this is 0 the directory read has stopped working and every reconciliation below is vacuous.`
);

const briefText = Object.fromEntries(briefFiles.map((b) => [b, read(b)]));

// Each brief's OWN subject. A mandate naming the caller's own ticket is served,
// and in a brief the caller's ticket is written `{{KEY}}` — but it is also
// written as the noun the brief is about. `prompts/story.md` saying "transition
// the story" is an own-ticket write; `prompts/epic.md` saying the same words is
// a cross-ticket one. Without this the detector reports a story agent
// transitioning its own ticket as a refused write, which is false and would
// have made §5 unusable.
const SELF_NOUN = {
  'prompts/task.md': 'task',
  'prompts/story.md': 'story',
  'prompts/epic.md': 'epic',
  'prompts/confluence.md': 'page'
};

check(
  'every brief on disk has a declared self-noun',
  briefFiles.every((b) => SELF_NOUN[b]),
  `no self-noun for: ${briefFiles.filter((b) => !SELF_NOUN[b]).join(', ')}. A new brief needs one here and a block in ${DOC_REL} — until it has both, the detector cannot tell its own-ticket writes from its cross-ticket ones.`
);

// ── 3. the recorded answer, parsed per brief ───────────────────────────────
rule('3. the recorded inventory in docs/atlassian-proxy.md');

const recordSection = /#### The four-brief cross-ticket write inventory([\s\S]*?)(?=\n### |\n## |$)/.exec(doc);
check(
  'the inventory section is present in the document',
  Boolean(recordSection),
  `${DOC_REL} no longer carries "${RECORD_HEADING}" — the recorded answer this script reconciles against has been removed or renamed, and nothing else records it`
);

const VERDICTS = {
  served: 'yes',
  refused: 'no',
  notMandate: 'n/a'
};

/**
 * Strip one markdown code-span fence off a table cell.
 *
 * ## WHY IT ACCEPTS A DOUBLED FENCE, WHICH IS NOT COSMETIC
 *
 * Two of the mandates this table has to anchor contain a backtick themselves —
 * *"apply the `wont-do` label"*, in `prompts/story.md` and in `prompts/epic.md`.
 * A single-backtick cell cannot hold them, and the first version of this parser
 * used one: the effect was not a parse error but a row that silently did not
 * match, so the mandate went unrecorded, §5 reported it as unaccounted, and the
 * red named the wrong defect. Markdown's own answer is the doubled fence, so
 * that is what this accepts.
 */
function unfence(cell) {
  const s = cell.trim();
  const double = /^``([\s\S]+)``$/.exec(s);
  if (double) return double[1].trim();
  const single = /^`([\s\S]+)`$/.exec(s);
  if (single) return single[1];
  return s;
}

const rows = [];
if (recordSection) {
  // | brief | shape | the phrase in the brief | operation | scope | through the proxy? |
  //
  // Split on the pipe rather than matched by one regex over the whole row: a
  // cell holding a doubled fence and a cell holding a plain one are different
  // shapes, and six alternations in one expression is where the last parser
  // stopped matching a row nobody noticed was missing.
  for (const line of recordSection[1].split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    const cells = t.slice(1, -1).split('|');
    if (cells.length !== 6) continue;
    const brief = unfence(cells[0]);
    if (!brief.startsWith(`${BRIEF_DIR_REL}/`)) continue; // the header row and the `---` rule
    const verdictCell = cells[5].trim();
    let verdict = null;
    if (/\*\*yes\b/.test(verdictCell)) verdict = VERDICTS.served;
    else if (/\*\*no\b/.test(verdictCell)) verdict = VERDICTS.refused;
    else if (/\*\*n\/a\b/.test(verdictCell)) verdict = VERDICTS.notMandate;
    const operation = unfence(cells[3]);
    const scope = unfence(cells[4]);
    rows.push({
      brief,
      shape: unfence(cells[1]),
      quote: unfence(cells[2]),
      operation: operation === '—' ? null : operation,
      scope: scope === '—' ? null : scope,
      verdictCell,
      verdict
    });
  }
}

const byBrief = (b) => rows.filter((r) => r.brief === b);
console.log(
  `   ${rows.length} recorded rows — ` +
    briefFiles.map((b) => `${path.basename(b)}:${byBrief(b).length}`).join(' ') +
    `; refused=${rows.filter((r) => r.verdict === VERDICTS.refused).length}` +
    ` served=${rows.filter((r) => r.verdict === VERDICTS.served).length}` +
    ` n/a=${rows.filter((r) => r.verdict === VERDICTS.notMandate).length}`
);

// The parse's own alarm, and it is the reason §3 is not "assert the table says
// what I remember it saying". A row regex that stopped matching returns zero
// rows, and zero rows would make §4 assert nothing while §5 reported every hit
// in every brief as unaccounted — a red, but a red naming the wrong defect.
check(
  'the inventory table parsed at all — more than 10 rows found',
  rows.length > 10,
  `found ${rows.length}; if this is 0 the row regex has stopped matching the table's shape and §4 is asserting nothing`
);
check(
  'every row carried a verdict this script recognises',
  rows.every((r) => r.verdict),
  `rows with an unrecognised final column: ${rows
    .filter((r) => !r.verdict)
    .map((r) => `${r.brief} ${JSON.stringify(r.quote)} -> ${JSON.stringify(r.verdictCell)}`)
    .join('; ')}`
);

// Both directions, because each catches a different edit. A brief on disk with
// no block in the record is the new-brief case KAN-658 was filed for; a brief in
// the record that is not on disk is the case acceptance criterion 4 drives —
// remove `prompts/confluence.md` and this is what goes red, for want of it.
const recordedBriefs = [...new Set(rows.map((r) => r.brief))].sort();
check(
  'every brief on disk has recorded rows',
  briefFiles.every((b) => byBrief(b).length > 0),
  `no rows in ${DOC_REL} for: ${briefFiles.filter((b) => byBrief(b).length === 0).join(', ')}. A brief nothing records is a brief nothing reconciles — which is the defect KAN-658 was filed for.`
);
check(
  'every brief the record names is on disk',
  recordedBriefs.every((b) => briefFiles.includes(b)),
  `${DOC_REL} records rows for a brief that is not in ${BRIEF_DIR_REL}/: ${recordedBriefs
    .filter((b) => !briefFiles.includes(b))
    .join(', ')}. Either the brief was deleted and its recorded answer was left behind, or this check is no longer reading the whole directory.`
);

// All four shapes, which is KAN-658's third task. `link` is the one that was
// missing: it is the shape that refused `story/KAN-657` in flight.
for (const shape of SHAPES) {
  check(
    `the ${shape} shape is recorded as refused somewhere in the inventory`,
    rows.some((r) => r.shape === shape && r.verdict === VERDICTS.refused),
    `no brief records a refused ${shape} mandate. If the last one was genuinely removed, the recorded answer in ${DOC_REL} rests on it and must be revisited — do not delete this check to make it green.`
  );
}

// ── 4. every recorded row still describes the tree ─────────────────────────
//
// THIS IS THE LEG THAT MAKES EACH BRIEF'S ANSWER FALSIFIABLE, and it is
// per-brief by construction: a red here names the brief, the recorded phrase
// and the answer that rested on it, which is what KAN-658 asked for. The
// recorded answer for `prompts/story.md` is "three transition mandates and two
// link mandates the own-ticket scope refuses". If somebody removes one, that
// answer stops being true, and the failure mode without this check is that
// nobody notices.
rule('4. every recorded row is still true of the brief and of the table');

for (const r of rows) {
  const text = briefText[r.brief];
  if (text === undefined) continue; // already red in §3; do not double-count
  const occurrences = text.split(r.quote).length - 1;
  check(
    `${r.brief} [${r.shape}] ${JSON.stringify(r.quote)} — present exactly once`,
    occurrences === 1,
    occurrences === 0
      ? `NOT FOUND in ${r.brief}. The recorded answer in ${DOC_REL} rests on this mandate: the row says ${r.verdictCell.replace(/\*/g, '')} for ${r.operation || 'no operation'} (${r.scope || 'no scope'}). If it was deliberately removed or reworded, revisit the record — do not delete the row to make this green.`
      : `found ${occurrences} times in ${r.brief}; the anchor no longer identifies one mandate, so §5 cannot tell which hit it accounts for. Lengthen the quote until it is unique.`
  );
}

for (const r of rows.filter((x) => x.operation)) {
  const scope = scopeOf(r.operation);
  check(
    `${r.brief} [${r.shape}] — ${r.operation} is a write, recorded as ${r.scope}`,
    Boolean(scope) && scope === r.scope,
    !scope
      ? `${r.operation} is not a write in ${PROXY_SRC_REL} — the record names an operation the proxy no longer carries`
      : `the record says ${r.scope}; ${PROXY_SRC_REL} says ${scope}. The scope that decides whether this mandate is refused has moved under the recorded answer.`
  );
}

// A refused row must name a caller-bounded scope: `unscoped` refuses nobody, so
// a row claiming refusal under `unscoped` is a recorded answer that cannot be
// true. This is the honesty leg — the cheapest way to make §5 green is to
// record every hit as refused, and this is what stops that being free.
for (const r of rows.filter((x) => x.verdict === VERDICTS.refused)) {
  check(
    `${r.brief} [${r.shape}] — refusal rests on a caller-bounded scope`,
    CALLER_BOUNDED.includes(r.scope),
    `the row claims ${r.verdictCell.replace(/\*/g, '')} but records the scope as ${JSON.stringify(r.scope)}; only ${CALLER_BOUNDED.join('/')} refuse a caller. An unscoped operation refuses nobody, so this row's recorded answer cannot be true as written.`
  );
}

// And a served row must NOT be recorded as refused by the same operation in the
// same brief for the same phrase — the positive-control half of §4. Almost
// everything above asserts that something is refused, and a record in which
// every row was refused would satisfy all of it.
check(
  'the inventory records served mandates too, not only refused ones',
  rows.some((r) => r.verdict === VERDICTS.served),
  `every row in ${DOC_REL} is a refusal or a non-mandate. The own-ticket half of these briefs is what the proxy exists to serve; a record that shows only the refused half is not an inventory.`
);

// ── 5. the sweep — what the briefs mandate, reconciled against the record ──
//
// The detector. §4 pins what is recorded; this finds what is THERE, and the two
// directions catch different edits: a mandate added to any brief with no
// recorded answer goes red here, and a detector that has stopped seeing a
// recorded mandate goes red here too.
rule('5. sweep prompts/ for cross-ticket write mandates, and reconcile');

// The other party's ticket, as these four briefs actually name it. `{{KEY}}` is
// deliberately absent: it is the caller's own ticket, which is the served case.
const OTHERS = String.raw`(?:its|their|_their_|the task's|the story's|the epic's|that agent's|your approver's|the moved ticket's)`;
const TICKET = String.raw`(?:ticket|issue)`;

/**
 * The detector, as data rather than as inline literals, so §7 can drive the
 * same objects the sweep uses instead of a copy of them that could drift.
 *
 * `noun` is substituted per brief with the three subject nouns that are NOT
 * that brief's own — see SELF_NOUN above for why that substitution exists.
 *
 * ## WHY EVERY PATTERN PAIRS A VERB WITH A TARGET
 *
 * A first attempt matched write verbs and other-party targets independently and
 * required both somewhere in the same sentence. Measured on the four briefs, it
 * reported `prompts/task.md:178` as a transition mandate on the strength of the
 * words "Announce a transition" in a cross-reference to a section title — a
 * verb with no object, in a sentence whose real mandate was a comment. Pairing
 * them in one span is what makes the matched text quotable in a failure
 * message, which is acceptance criterion 2's requirement: a red must name the
 * mandate, not merely the file.
 *
 * ## WHY THE VERBS TAKE `-ing` BUT NOT `-s`
 *
 * A mandate is an instruction, and an instruction is imperative or gerundive:
 * *"transition the task"*, *"assigning the ticket"*. The third-person `-s` form
 * cannot be either — *"only one of them assigns the ticket"* is a sentence about
 * how the proxy behaves, not a thing the reader is being told to do, and it
 * occurs in three of the four briefs in exactly that descriptive clause. This
 * is a NARROWING OF THE GRAMMAR AND NOT A SUPPRESSION OF A KNOWN HIT: no
 * inflection is being special-cased and no phrase is being excluded by name.
 * The distinction it draws is the one the whole detector is trying to draw, and
 * §7's third check is what holds it — prose that instructs nothing must be
 * rejected, whatever words it happens to contain.
 */
const DETECTORS = [
  ['comment', String.raw`\bcomment(?:ing)?\s+on\s+(?:\*\*)?OTHERS(?:\s+own)?\s+TICKET`],
  ['comment', String.raw`\bcomment\s+on\s+(?:it|them)\b`],
  ['transition', String.raw`\btransition(?:ing)?\s+(?:OTHERS\s+TICKET|the\s+(?:NOUN)\b|it\s+back|a\s+ticket\s+that\s+is\s+not)`],
  ['transition', String.raw`\bset\s+(?:the\s+(?:NOUN)|OTHERS\s+TICKET)\s+(?:\*\*)?(?:Done|To Do|In Progress|In Review)`],
  ['transition', String.raw`\bmove\s+(?:the\s+(?:NOUN)|OTHERS\s+TICKET)\s+(?:back\s+)?to\b`],
  ['edit', String.raw`\bapply\s+the\s+\x60?[\w-]+\x60?\s+label`],
  ['edit', String.raw`\bassign(?:ing)?\s+(?:the\s+(?:NOUN)|OTHERS\s+TICKET)`],
  ['link', String.raw`\blink\s+(?:the\s+two|them|those|both)\b`],
  ['link', String.raw`\blink\s+(?:it|the\s+\w+)\s+\x60?(?:Relates|Blocks|Duplicate|Cloners)\x60?\s+to\s+(?!\*\*\{\{KEY\}\})`]
];

const NOUNS = ['task', 'story', 'epic', 'page', 'ticket'];

function detectorsFor(brief) {
  const others = NOUNS.filter((n) => n !== SELF_NOUN[brief]).join('|');
  return DETECTORS.map(([shape, src]) => [
    shape,
    new RegExp(src.replace(/OTHERS/g, OTHERS).replace(/TICKET/g, TICKET).replace(/NOUN/g, others), 'gi')
  ]);
}

function sweep(brief, text) {
  const hits = [];
  for (const [shape, re] of detectorsFor(brief)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      hits.push({ shape, at: m.index, end: m.index + m[0].length, text: m[0].replace(/\s+/g, ' ') });
      if (m[0].length === 0) break; // a zero-width match would loop forever; §7 asserts none exists
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

const allHits = [];
for (const brief of briefFiles) {
  const text = briefText[brief];
  const hits = sweep(brief, text).map((h) => ({
    ...h,
    brief,
    line: text.slice(0, h.at).split('\n').length
  }));
  allHits.push(...hits);
  console.log(`   ${brief}: ${hits.length} hit(s)`);
  if (verbose) for (const h of hits) console.log(`         ${h.line} [${h.shape}] ${JSON.stringify(h.text)}`);
}

// The sweep's own floors, and they are §1's floors applied to the second parse.
// Zero hits is what a detector that has stopped matching returns, and it is
// byte-identical to "these briefs mandate no cross-ticket write" — an empty
// result reported as a finding about the world rather than about the search.
check(
  'the sweep matched at all — more than 10 hits across prompts/',
  allHits.length > 10,
  `found ${allHits.length}; if this is 0 the detectors have stopped matching and the reconciliation below is vacuous`
);
check(
  'every brief produced at least one hit',
  briefFiles.every((b) => allHits.some((h) => h.brief === b)),
  `no hit in: ${briefFiles.filter((b) => !allHits.some((h) => h.brief === b)).join(', ')}. Every brief in this tree contains at least one phrase the detectors match — a brief with none is far more likely to be an unreadable file or a broken pattern than a brief that never mentions another ticket.`
);

// ── the reconciliation, direction 1: every hit is accounted for ────────────
//
// This is the direction acceptance criterion 2 drives. A hit is accounted for
// when it falls inside a recorded row's quote AS THAT QUOTE OCCURS IN THE
// BRIEF — an offset test, not a string comparison, so the record stays readable
// prose and rewording a detector does not invalidate the whole table.
const spans = [];
for (const r of rows) {
  const text = briefText[r.brief];
  if (text === undefined) continue;
  const at = text.indexOf(r.quote);
  if (at === -1) continue; // already red in §4
  spans.push({ ...r, at, end: at + r.quote.length });
}

/**
 * Does this recorded anchor account for this hit?
 *
 * The test is on the hit's START offset, not on whole containment, and the
 * difference is forced by the briefs rather than chosen. `prompts/epic.md`
 * wraps its mandate across a line break — line 952 ends *"set the story"* and
 * 953 begins *"**Done**"* — so the detector's match spans the newline while a
 * markdown table cell cannot. Requiring whole containment would make that one
 * mandate unrecordable, and the anchor would have to grow to a paragraph to
 * hold mandates whose only sin is being wrapped. The anchor's job is to say
 * WHERE the mandate is; uniqueness (§4) and the shape match are what stop it
 * accounting for a different one.
 */
const accountedBy = (span, hit) =>
  span.brief === hit.brief && span.shape === hit.shape && hit.at >= span.at && hit.at < span.end;

const unaccounted = allHits.filter((h) => !spans.some((s) => accountedBy(s, h)));

/**
 * The shortest span of the hit's own line that contains the hit, occurs exactly
 * once in the brief, and carries no `|`.
 *
 * This exists so that a red is ACTIONABLE rather than merely correct. A row's
 * anchor has to be unique — §4 goes red on a quote that matches twice — and
 * `prompts/task.md` carries the phrase "comment on their ticket" at two
 * different lines, so the obvious anchor is the wrong one and the author finds
 * that out on the next run. Computing it here turns a two-run loop into a
 * paste. It returns null when the line offers no unique span, which is a real
 * outcome rather than a failure: the anchor then has to cross a line break, and
 * the author writes it by hand.
 */
function suggestAnchor(brief, hit) {
  const text = briefText[brief];
  const lineStart = text.lastIndexOf('\n', hit.at) + 1;
  const lineEndRaw = text.indexOf('\n', hit.at);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const occurs = (q) => text.split(q).length - 1;
  for (let grow = 0; grow <= lineEnd - lineStart; grow++) {
    for (let left = 0; left <= grow; left++) {
      const a = Math.max(lineStart, hit.at - left);
      const b = Math.min(lineEnd, hit.end + (grow - left));
      const q = text.slice(a, b);
      if (q.includes('|')) continue;
      if (occurs(q) === 1) return q;
    }
  }
  return null;
}

// Printed in full and outside `check`, which truncates its detail. Every
// unaccounted hit is a separate decision somebody has to record, so a listing
// cut off at the eighth line sends the author round the loop once per hit.
if (unaccounted.length) {
  console.log(`\n   ${unaccounted.length} UNACCOUNTED mandate(s) — each needs a row in ${DOC_REL}:`);
  for (const h of unaccounted) {
    const anchor = suggestAnchor(h.brief, h);
    console.log(
      `     ${h.brief}:${h.line} [${h.shape}] ${JSON.stringify(h.text)}\n` +
        `        anchor: ${anchor === null ? '(none on one line — write it by hand)' : '`' + anchor + '`'}`
    );
  }
  console.log('');
}

check(
  `every cross-ticket write mandate in prompts/ has a recorded answer — ${allHits.length} hit(s), ${unaccounted.length} unaccounted`,
  unaccounted.length === 0,
  unaccounted
    .map((h) => {
      const tool = SHAPE_OPERATION[h.shape];
      const anchor = suggestAnchor(h.brief, h);
      return (
        `${h.brief}:${h.line} mandates a ${h.shape} — ${JSON.stringify(h.text)} — served by ${tool} (${
          scopeOf(tool) || 'MISSING'
        }), which refuses a caller writing outside its own ticket with reason "not-your-ticket". Nothing in ${DOC_REL} under "${RECORD_HEADING}" records an answer for it. Add a row for it, or remove the mandate.` +
        (anchor ? `\n    unique anchor for the row: \`${anchor}\`` : '\n    (no unique single-line anchor; write one by hand)')
      );
    })
    .join('\n')
);

// ── the reconciliation, direction 2: the detector still sees what is recorded
//
// The record's quotes are verbatim spans of the briefs, so a quote that is
// still present is text that has not changed. If the detector no longer matches
// inside it, the detector regressed — not the brief. Without this leg a
// narrowed pattern makes direction 1 green by seeing less, which is the
// unfalsifiable direction.
const unseen = spans.filter(
  (s) => s.verdict !== VERDICTS.notMandate && !allHits.some((h) => accountedBy(s, h))
);
check(
  'the detector still matches inside every recorded mandate',
  unseen.length === 0,
  unseen
    .map(
      (s) =>
        `${s.brief} records a ${s.shape} mandate at ${JSON.stringify(s.quote)} and the phrase is still in the brief, but no ${s.shape} detector matches inside it. The DETECTORS list has been narrowed and can no longer see a mandate this tree really carries — direction 1 above is now green because it is looking at less.`
    )
    .join('\n')
);

// ── 6. positive control — the served half, per brief ───────────────────────
//
// Almost every assertion above is that something is refused or absent, and a
// `prompts/` in which nothing was mandated at all would satisfy most of them.
// This shows the other side in the same run: each brief's own-ticket writes,
// which the proxy exists to serve, matched to operations the table really
// carries.
rule('6. positive control — each brief\'s own-ticket writes are served');

const SERVED_OWN_TICKET = [
  ['prompts/task.md', 'claim the ticket by assigning it', 'assign **{{KEY}}** to yourself', 'atlassian_edit_issue'],
  [
    'prompts/story.md',
    'comment on its own ticket',
    'which is your own ticket: post the comment',
    'atlassian_add_comment'
  ],
  ['prompts/epic.md', 'claim its own ticket by assigning it', 'assign **{{KEY}}**', 'atlassian_edit_issue'],
  ['prompts/confluence.md', 'write its own page', 'You edit **{{KEY}}** with', 'atlassian_update_confluence_page']
];

for (const [brief, label, needle, tool] of SERVED_OWN_TICKET) {
  const text = briefText[brief];
  const scope = scopeOf(tool);
  check(
    `${brief} — ${label}, served by ${tool} (${scope || 'MISSING'})`,
    text !== undefined && text.includes(needle) && Boolean(scope),
    text === undefined
      ? `${brief} is not in ${BRIEF_DIR_REL}/`
      : !text.includes(needle)
        ? `the brief no longer says ${JSON.stringify(needle)}`
        : `${tool} is not a write in ${PROXY_SRC_REL} — the proxy can no longer serve a mandate the brief still carries`
  );
}

// ── 7. self-test — the detector can say YES and can say NO ─────────────────
//
// **Every assertion in §5 is "the sweep found exactly the mandates the record
// names", and every one of them is worthless if the sweep cannot reject a
// document that mandates nothing.** KAN-515's reviewer found that script's
// count matcher one stripped byte from exactly that: `(4|)` matches every
// string in existence, and four checks would have gone permanently green while
// asserting nothing.
//
// It supplies its own input — these are string literals, not the repository —
// so it proves the detector discriminates and proves NOTHING about the real
// briefs. §5 is what reads those. Neither covers the other.
rule('7. self-test — the detector discriminates');

{
  const probe = (brief, text) => sweep(brief, text);

  check(
    'a brief mandating a cross-ticket transition is detected (positive control)',
    probe('prompts/epic.md', 'When a task stalls, transition the task to **To Do** yourself.').some(
      (h) => h.shape === 'transition'
    ),
    'the detector cannot see a transition mandate it is meant to catch — §5 is asserting nothing'
  );
  check(
    'a brief mandating a cross-ticket link is detected (the shape KAN-657 met)',
    probe('prompts/story.md', 'When duplicate work is discovered, link the two before closing the loser.').some(
      (h) => h.shape === 'link'
    ),
    'the detector cannot see the `link` shape — the fourth shape, and the one that refused story/KAN-657 in flight'
  );
  check(
    'prose mandating NO write is REJECTED',
    probe('prompts/epic.md', 'Read the ticket, run the tests, and push your branch when CI is green.').length === 0,
    'THE DETECTOR MATCHES ANYTHING. §5 is asserting nothing — check DETECTORS for a pattern that can match the empty string.'
  );
  check(
    "a brief transitioning its OWN ticket is not reported as cross-ticket",
    probe('prompts/story.md', 'When every task has closed, transition the story to **Done**.').length === 0,
    'the self-noun exemption has stopped working: a story agent moving its own ticket is an own-ticket write the proxy serves, and reporting it as refused makes §5 permanently red on a correct tree'
  );
  check(
    'the SAME words in a brief whose subject is different ARE reported (the discriminating arm)',
    probe('prompts/epic.md', 'When every task has closed, transition the story to **Done**.').some(
      (h) => h.shape === 'transition'
    ),
    'the self-noun exemption is exempting every noun in every brief, not each brief\'s own — so a genuine cross-ticket mandate is invisible wherever it is phrased with a subject noun'
  );
  check(
    'no detector matches the empty string, for any brief',
    briefFiles.every((b) => detectorsFor(b).every(([, re]) => !new RegExp(`^(?:${re.source})$`, 'i').test(''))),
    'a detector accepts the empty string, so it matches at every position in every document and §5 reports the whole tree as unaccounted'
  );
  check(
    'this script is plain text — no control bytes that hide it from grep',
    !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(fs.readFileSync(SELF_PATH, 'utf8')),
    'a raw control byte is present, so `file` reports `data` and plain grep silently skips this file'
  );
}

console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s). The four briefs' account of which writes they mandate no longer agrees with ${DOC_REL} or with ${PROXY_SRC_REL}.`
      : `OK — ${briefFiles.length} briefs swept, ${allHits.length} cross-ticket write mandates found, all ${rows.length} recorded in ${DOC_REL}, every scope agreeing with ${PROXY_SRC_REL}, and the detector can still say no.`
  }\n`
);

process.exit(failures ? 1 : 0);
