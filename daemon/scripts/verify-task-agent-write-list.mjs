// KAN-515: the task agent's brief mandates writes that are NOT all own-ticket,
// and for three tickets nobody had measured that.
//
// WHAT FAILURE THIS WOULD CATCH: the recorded answer to KAN-288 drifting away
// from what `prompts/task.md` and `PROXY_OPERATIONS` actually say — a brief
// mandate to write to a ticket the caller does not own being added, removed or
// reworded while `docs/atlassian-proxy.md` §4 goes on asserting the old answer;
// a write operation gaining or losing a `WriteScope` without the recorded
// counts moving; or the corrected premise in `refuseWriteOutsideCaller`'s
// docblock being edited back out. It would have caught the original defect: a
// docblock asserting the brief's writes were own-ticket and that "none of them
// writes to anybody else's", which was false on the merge path of every task
// and which three tickets inherited as settled.
//
// CI-RUNNABLE: yes — every section reads repository files as TEXT and asserts
// in process; no live daemon, no herdr, no credential, no peer, no terminal,
// no network.
//
// ── THIS SCRIPT DOES NOT IMPORT `dist`, AND THAT IS LOAD-BEARING ───────────
//
// `prompts/task.md` requires a reader to establish which kind of proof they
// ran before trusting or discarding its verdict, because a `dist`-importing
// proof run after a failed build tested the previous build and its verdict is
// evidence about code nobody wrote. **This one reads `src` and the prose as
// text and imports nothing**, so a failed build does not invalidate it and a
// red here is about the tree in front of you. There is no blended section: no
// part of this file reads `dist`.
//
// The cost of that choice is stated rather than hidden: reading a table as
// text means this script agrees with a *regex* over `PROXY_OPERATIONS`, not
// with the table the daemon actually serves. §1 is written so that a parse
// which stops working goes RED rather than quietly returning nothing — see the
// count floors there, which exist for exactly that reason.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ──────────────
//
// **It supplies no input to the proxy and asserts on no behaviour.** It is a
// consistency proof over four documents, so it cannot tell you that a write is
// really refused — only that the tree's own account of which writes are
// refused hangs together. The behaviour is owned elsewhere, and none of these
// is nobody:
//
//   - `verify-atlassian-proxy-write-scope.mjs` asserts what
//     `refuseWriteOutsideCaller` actually decides, with a positive control.
//   - `verify-atlassian-proxy-failure-is-loud.mjs` drives a real daemon and a
//     real `mcp.ts` over MCP stdio, which is the leg that fails if the wiring
//     is wrong.
//   - **A real refusal by a real agent, pasted into a PR.** KAN-515 recorded
//     one: `task/KAN-515` called `atlassian_add_comment` naming KAN-513 and got
//     `reason: "not-your-ticket"`, in the same session in which the identical
//     call naming its own key returned 201. That is the leg no script can run,
//     because it needs an agent with an identity and a credential.
//
// Usage: node daemon/scripts/verify-task-agent-write-list.mjs [--verbose]

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
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PROXY_SRC_REL = 'daemon/src/atlassian-proxy.ts';
const DOC_REL = 'docs/atlassian-proxy.md';
const BRIEF_REL = 'prompts/task.md';

const proxySrc = read(PROXY_SRC_REL);
const doc = read(DOC_REL);
const brief = read(BRIEF_REL);

// ── 1. the write table, measured from source rather than quoted ────────────
//
// The parse walks the table in order: a `tool:` line opens an operation, and
// the FIRST `kind:` line after it that names a `WriteScope` tag closes it as a
// write. Reads never reach a `kind:`, so they fall out by having no scope
// rather than by being recognised — which is the safe direction, because a
// scope spelled in a way this regex misses becomes a MISSING write and not a
// silently unbounded one.
rule('1. every write in PROXY_OPERATIONS, and what bounds it');

const SCOPE_KINDS = ['own-ticket', 'own-ticket-endpoint', 'own-project', 'unscoped'];
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
    const kind = /^\s*kind: '(own-ticket-endpoint|own-ticket|own-project|unscoped)',/.exec(lines[i]);
    if (kind && open) {
      writes.push({ ...open, scope: kind[1] });
      open = null;
    }
  }
}

const counts = Object.fromEntries(SCOPE_KINDS.map((k) => [k, writes.filter((w) => w.scope === k).length]));

for (const w of writes) {
  console.log(`   ${String(w.line).padStart(5)}  ${w.scope.padEnd(20)} ${w.tool}`);
}
console.log(
  `\n   ${writes.length} writes — ` +
    SCOPE_KINDS.map((k) => `${counts[k]} ${k}`).join(', ') +
    `; ${toolsSeen.length} operations in the table overall`
);

// The floors are the parse's own alarm. A regex that stopped matching returns
// zero of everything, and zero is indistinguishable from "this table has no
// writes" — which is exactly the shape of empty result `prompts/task.md` tells
// you to refuse to report as a finding. These make that case RED.
check(
  'the table parsed at all — more than 20 operations found',
  toolsSeen.length > 20,
  `found ${toolsSeen.length}; if this is 0 the tool regex has stopped matching and every count below is meaningless`
);
check(
  'the table carries writes — at least one of every caller-bounded scope',
  counts['own-ticket'] > 0 && counts['own-ticket-endpoint'] > 0 && counts['own-project'] > 0,
  `own-ticket=${counts['own-ticket']} own-ticket-endpoint=${counts['own-ticket-endpoint']} own-project=${counts['own-project']}`
);
check(
  'every write named a scope — no write parsed without one',
  writes.every((w) => SCOPE_KINDS.includes(w.scope)),
  'a write reached this list with a scope tag outside the union'
);

// ── 2. the source docblock quotes the counts the table actually holds ──────
//
// This is the leg that would have caught the drift KAN-515 found in passing:
// the sentence read "Five of the ten writes are own-ticket, one is
// own-project, one needs only one endpoint to be the caller's, and four are
// unscoped" — five numbers summing to eleven, for a table of ten. It is the
// class `docs/doc-constant-drift.md` describes, in the one place that page's
// guard explicitly does not reach: a source docblock.
rule('2. ProxyOperationReport.ownTicketOnly quotes the measured counts');

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The alternation matching a count written as a numeral or as an English word.
 *
 * ## WHY THIS IS A FUNCTION AND NOT AN INLINE `?? <sentinel>`
 *
 * It was written inline as `${n}|${WORDS[n] ?? <sentinel>}` and reviewed on
 * KAN-515, where two defects were measured in it — one cosmetic, one not:
 *
 *  1. The sentinel was a **raw NUL byte**, so `file` called this script
 *     `data` and plain `grep` suppressed every match in it. A maintenance
 *     sweep over `daemon/scripts` would have skipped it in silence, and the
 *     reviewer found it only because their own review greps kept coming back
 *     empty on a file they had just watched run.
 *  2. **Far worse**: strip that byte — a formatter, an editor, a
 *     `.gitattributes` normalisation — and the alternative becomes EMPTY.
 *     An empty alternative matches at every position, so `(4|)` matches any
 *     string at all, and four of this script's assertions become permanent
 *     no-ops **while still reporting PASS**. For a script whose whole job is
 *     to notice a recorded decision drifting, silently unfalsifiable is the
 *     worst available failure.
 *
 * `filter(Boolean)` is the fix, and it is a type-shaped one rather than an
 * assertion: with no defined word for `n` the alternation is simply the
 * numeral, and **an empty alternative cannot be constructed here at all**.
 * There is no sentinel left to strip. §7 exercises the property rather than
 * trusting this paragraph.
 */
function numAlt(n) {
  return [String(n), WORDS[n]].filter(Boolean).join('|');
}
const ownTicketBlock = /Whether this operation is restricted to the caller's own ticket\.([\s\S]{0,1600}?)\*\//.exec(
  proxySrc
);

check(
  "the ownTicketOnly docblock was located",
  Boolean(ownTicketBlock),
  'the anchor sentence has been reworded; §2 asserts nothing until this is repaired'
);

if (ownTicketBlock) {
  const block = ownTicketBlock[1];
  const total = writes.length;
  const expectations = [
    [`the total (${total}) is quoted`, new RegExp(`\\b(${numAlt(total)})\\b`, 'i')],
    [
      `own-ticket (${counts['own-ticket']}) is quoted`,
      new RegExp(`\\*?\\*?(${numAlt(counts['own-ticket'])})\\*?\\*?[^.]{0,40}own-ticket`, 'i')
    ],
    [
      `unscoped (${counts['unscoped']}) is quoted`,
      new RegExp(`(${numAlt(counts['unscoped'])})\\b[^.]{0,40}unscoped`, 'i')
    ]
  ];
  for (const [label, re] of expectations) {
    check(label, re.test(block), `not found in the docblock; the table now holds ${JSON.stringify(counts)}`);
  }

  // §4-style honesty leg, in the spirit of verify-doc-constant-pins: the
  // cheapest way to make the check above go green is to paste a number in
  // somewhere, so assert the retired figure is NOT still being asserted.
  check(
    'the retired "five ... own-ticket" figure is gone',
    !/five of the ten writes are own-ticket/i.test(block),
    'the docblock still claims five own-ticket writes; the table holds ' + counts['own-ticket']
  );
}

// ── 3. the recorded decision quotes the same counts ────────────────────────
rule('3. docs/atlassian-proxy.md §4 quotes the same counts');

// `\n#### ` is in the lookahead because KAN-658 added a SIBLING `####` section
// immediately below this one, and without it the capture ran straight through
// the new heading and swallowed the four-brief inventory table — 9,254
// characters where the section is 2,322. Measured, not feared: every check
// below still passed, because an over-capture can only ADD text to search and
// therefore only ever turns a red green. That is the direction that matters —
// this section's whole job is to notice a count drifting, and a capture that
// reaches into a neighbouring table full of scope names is one paste away from
// being satisfied by a document that no longer says what it is asserted to say.
const decisionSection = /#### The task-agent write list([\s\S]*?)(?=\n## |\n---|\n#### |\n### |$)/.exec(doc);
check(
  'the write-list section is present in the document',
  Boolean(decisionSection),
  `${DOC_REL} no longer carries "#### The task-agent write list" — the decision KAN-515 recorded has been removed or renamed`
);

if (decisionSection) {
  const sec = decisionSection[1];
  for (const k of SCOPE_KINDS) {
    const n = counts[k];
    check(
      `${k} count (${n}) agrees with the table`,
      new RegExp(`(${numAlt(n)})\\b[^.]{0,60}\`?${k}\`?`, 'i').test(sec),
      `the document does not state ${n} for ${k}; the table holds ${JSON.stringify(counts)}`
    );
  }
}

check(
  "KAN-288's goal is answered in one place, and the answer is recorded as no",
  /KAN-288's goal, answered/.test(doc) && /Answered `no`, for the whole fleet/.test(doc),
  `${DOC_REL} no longer records the answer to KAN-288 for the whole fleet`
);

check(
  'the decision names which option was taken',
  /\*\*Option taken: accept it\.\*\*/.test(doc),
  'the recorded decision no longer names the option it took'
);

// ── 4. the brief still mandates the cross-ticket writes the decision rests on
//
// THIS IS THE SECTION THAT MAKES THE DECISION FALSIFIABLE. The recorded answer
// is "no, because the brief mandates writes the own-ticket scope refuses". If
// somebody later takes option 2 and removes those mandates, the answer stops
// being true — and the failure mode is that nobody notices, which is precisely
// how the premise KAN-515 found survived three tickets. A red here means the
// decision needs revisiting, not that the edit was wrong.
rule('4. prompts/task.md still mandates the cross-ticket writes');

const CROSS_TICKET_MANDATES = [
  ["the merge-path pointer comment on the approver's ticket", "post a short pointer comment on your approver's own ticket"],
  ['the pointer comment where the poller cannot announce', 'Post a short pointer comment on _their_ ticket.'],
  ['a transition of a ticket that is not the caller\'s', 'transition a ticket that is not **{{KEY}}**']
];

for (const [label, needle] of CROSS_TICKET_MANDATES) {
  check(
    `the brief still mandates ${label}`,
    brief.includes(needle),
    `not found in ${BRIEF_REL}. If this mandate was deliberately removed, the recorded answer in ${DOC_REL} §4 rests on it and must be revisited — see "the two options not taken".`
  );
}

// ── 5. the own-ticket half is really served, so §4 is not the whole story ──
//
// The positive control for §4. Almost everything above asserts that something
// is refused or absent, and a tree in which the proxy served NOTHING would
// satisfy most of it. This section shows the other side in the same run: the
// five brief mandates that ARE served, each matched to an operation the table
// really carries.
rule('5. positive control — the served half of the brief, matched to real operations');

const SERVED = [
  ['claim the ticket by assigning it', 'assign **{{KEY}}** to yourself', 'atlassian_edit_issue'],
  ['move it to In Progress and In Review', 'transition it to **In Progress**', 'atlassian_transition_issue'],
  ['comment on its own ticket', 'Post progress updates or completion status back to the Jira issue', 'atlassian_add_comment'],
  // KAN-597 rewrote this needle, and the reason is the point rather than
  // maintenance. It used to be "`createJiraIssue` takes a `parent` field" —
  // which pinned the mandate to the name of the ONE create tool whose door has
  // no assignee guard, so satisfying this check required the brief to keep
  // naming it. The mandate is unchanged and the brief still carries it; what it
  // no longer does is name that tool as the way to meet it. The needle is now
  // the mandate itself, which is tool-neutral and cannot be satisfied by naming
  // a tool at all.
  ['file a parented follow-up', 'carries a parent epic, and you set it at creation', 'atlassian_create_issue'],
  ['link that follow-up to its own ticket', 'link it `Relates` to **{{KEY}}**', 'atlassian_create_issue_link']
];

for (const [label, needle, tool] of SERVED) {
  const inBrief = brief.includes(needle);
  const op = writes.find((w) => w.tool === tool);
  check(
    `${label} — mandated, and served by ${tool} (${op ? op.scope : 'MISSING'})`,
    inBrief && Boolean(op),
    !inBrief
      ? `the brief no longer says ${JSON.stringify(needle)}`
      : `${tool} is not a write in ${PROXY_SRC_REL} — the proxy can no longer serve a mandate the brief still carries`
  );
}

// ── 6. the corrected premise is still in the source docblock ───────────────
//
// Asserted POSITIVELY rather than as the absence of the old sentence. An
// assertion that the false claim is gone passes vacuously if the whole
// paragraph is deleted, which is the edit most likely to happen by accident.
rule('6. refuseWriteOutsideCaller records what its policy does not cover');

const policyBlock = /## THE POLICY, AND WHY THIS ONE([\s\S]*?)export function refuseWriteOutsideCaller/.exec(proxySrc);
check(
  'the policy docblock was located',
  Boolean(policyBlock),
  'the anchor heading has been reworded; §6 asserts nothing until this is repaired'
);

if (policyBlock) {
  const block = policyBlock[1];
  check(
    'it names the merge-path comment as a write this policy refuses',
    /post\s+\*?"?a short pointer comment on your approver's own ticket/i.test(block) ||
      /pointer comment on your approver's own ticket/i.test(block),
    'the correction KAN-515 added has been edited out; the docblock is free to claim full coverage again'
  );
  check(
    'it points at the one place the consequence is recorded',
    /docs\/atlassian-proxy\.md/.test(block),
    'the docblock no longer points at the recorded decision, so the two can drift apart unnoticed'
  );
  // The honesty leg, and it has to tell a QUOTATION from an ASSERTION — which
  // is the distinction `approval-recorded` was taught by KAN-321, after a
  // comment pasting the marker it wanted inside a code fence turned the gate
  // green. The correction paragraph necessarily quotes the sentence it retires,
  // so a plain "is this phrase absent" check fails on the fix itself: this
  // script's first run went red on exactly that, which is the cheapest possible
  // demonstration that the naive form is wrong.
  //
  // So the leg is POSITIONAL. The phrase may appear inside the correction
  // section, where it is being reported; it may not appear in the policy
  // statement above it, which is where it was originally asserted.
  const CORRECTION_HEADING = '## IT DOES NOT COVER THE WHOLE BRIEF';
  const at = block.indexOf(CORRECTION_HEADING);
  const asserted = at === -1 ? block : block.slice(0, at);
  check(
    'the retired coverage claim is not asserted in the policy statement',
    !/none of them writes to anybody\s*\n?\s*\*?\s*else's/.test(asserted),
    at === -1
      ? 'the correction section is missing entirely, so the whole docblock counts as the policy statement'
      : 'the retired sentence is being asserted again above the correction, not merely quoted inside it'
  );
}

// ── 7. the count matcher can say NO — the property §2 and §3 rest on ───────
//
// **Every assertion in §2 and §3 is "this document quotes the right number",
// and every one of them is worthless if the matcher cannot reject a wrong
// one.** That is not hypothetical: KAN-515's reviewer found the matcher one
// stripped byte away from exactly that. The sentinel in the old
// `WORDS[n] ?? <sentinel>` idiom was a raw NUL, and removing it would have left
// an EMPTY alternative — `(4|)` matches every string in existence — so four
// checks would have gone permanently green while asserting nothing.
//
// `numAlt` makes that unconstructible. **This section is what stops the next
// author reintroducing it by another route**: it drives the real matcher over
// a document that is deliberately WRONG and requires a rejection. A matcher
// that matches everything fails here, whatever made it do so.
//
// It supplies its own input — these are string literals, not the repository —
// so it proves the matcher discriminates and proves NOTHING about the real
// documents. §2 and §3 are what read those. The two are complementary and
// neither covers the other.
rule('7. self-test — the count matcher rejects a wrong document');

{
  const matches = (n, text, tail) => new RegExp(`(${numAlt(n)})\\b[^.]{0,40}${tail}`, 'i').test(text);

  check(
    'a document quoting the RIGHT count matches (positive control)',
    matches(4, 'four are unscoped writes in the table', 'unscoped'),
    'the matcher rejects a correct document — it is broken in the safe direction, but broken'
  );
  check(
    'a document quoting a WRONG count is REJECTED',
    !matches(4, 'the table says seven unscoped writes', 'unscoped'),
    'THE MATCHER MATCHES ANYTHING. §2 and §3 are asserting nothing. Check numAlt for an empty alternative.'
  );
  check(
    'the numeral alone still matches when no English word exists for n',
    /^99$/.test(numAlt(99)) && new RegExp(`(${numAlt(99)})`).test('99 writes'),
    `numAlt(99) produced ${JSON.stringify(numAlt(99))}; out-of-range counts must degrade to the numeral, never to an empty alternative`
  );
  check(
    'numAlt never yields an empty alternative, for any count 0..40',
    Array.from({ length: 41 }, (_, i) => numAlt(i)).every(
      (a) => a.length > 0 && !a.startsWith('|') && !a.endsWith('|') && !a.includes('||')
    ),
    'some count produced an alternation with an empty branch — the KAN-515 defect is back'
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
      ? `FAILED — ${failures} check(s). The tree's account of which writes a task agent may make no longer hangs together.`
      : `OK — ${writes.length} writes measured, ${CROSS_TICKET_MANDATES.length} cross-ticket mandates still in the brief, ${DOC_REL} §4 agrees with both, and the count matcher can still say no.`
  }\n`
);

process.exit(failures ? 1 : 0);
