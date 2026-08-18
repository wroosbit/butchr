// KAN-502: no document this converter sends to Jira carries a mark combination
// Jira's ADF validator refuses — and Confluence keeps the combination it
// accepts.
//
// WHAT FAILURE THIS WOULD CATCH: the converter emitting one text node marked
// `code` together with `strong` or `em`, which is what a code span inside bold
// produces and what ordinary house style on this board is thick with. Jira
// answers `400 INVALID_INPUT` naming neither node nor mark, and on the
// issue-creation endpoint it does not even name that. Measured through the
// fleet's own daemon, the pair that differ only in where the code span sits:
//
//     RED    "**bold wrapping `inline_code` here.**"    -> 400, nothing written
//     GREEN  "**bold** and `inline_code` side by side"  -> 201, comment 12767
//
// ⚠ It would ALSO catch the over-stripping repair, which is §2b and which was
// added at `epic/KAN-39`'s review: a fix that made every marked node plain
// would satisfy "no node carries code with strong" and be worse than the
// defect. Every check outside §2b asks what the converter does NOT emit, and a
// converter emitting no marks at all would pass all of them. §2b states the
// other half — a legal mark is untouched, and only the companion Jira refuses
// ever goes.
//
// It would equally catch the over-broad repair, and that one is the reason §3
// exists: stripping the combination for BOTH products. Confluence stores
// `code+strong` perfectly well (HTTP 201, measured the same day), so a fix that
// treated one verdict as covering both would silently degrade every Confluence
// page written through this proxy to satisfy a constraint Confluence does not
// have. §3 fails if Jira's rule leaks into the Confluence path.
//
// CI-RUNNABLE: yes — imports the built converter and asserts against it in
// process; no live daemon, no herdr, no credential, no network, no terminal.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// §1 and §3 supply their own markdown. §2 does not — it reads `prompts/task.md`
// off the disk, which is where this house style actually lives and which nobody
// wrote with this check in mind.
//
// ⚠ WHAT IT CANNOT TELL YOU, AND THE REASON IS SHARPER THAN THE USUAL ONE.
// This script asserts on the document the converter PRODUCES. It never sends
// one, so it cannot tell you what Atlassian STORED — and on 2026-08-18
// `epic/KAN-39` measured that the distinction has teeth: the official
// `mcp__atlassian__editJiraIssue` accepts this exact construct, returns 200,
// and stores it with the code span lifted out of the bold and the trailing
// clause's emphasis silently gone. Same byte count, same headings, different
// text. **So a 200 is not evidence of fidelity, and no check that asserts on
// the request can see the difference.** Only a byte-level diff of a read-back
// against what was sent can.
//
// That leg is `daemon/scripts/probe-atlassian-proxy-content-writes.mjs`, which
// does the real round trip against production with the real credential. It is a
// `probe-` for that reason and cannot run here.
//
// This script is deliberately pointed at the branch of AC2 that does not depend
// on any of it: rather than showing Jira accepts what we emit, it shows **we do
// not emit the thing at all**. That claim is fully decidable from the document,
// which is why it is the branch worth holding.
//
// Usage: node daemon/scripts/verify-adf-jira-mark-combinations.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(daemonDir, '..');
const verbose = process.argv.includes('--verbose');

requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const adf = await import('../dist/adf.js');
const { markdownToAdf } = adf;
// A build without this export is a build predating KAN-502, which is exactly
// what a red drive runs. §4 reports that as a FAIL rather than throwing: a
// stack trace says "this script is broken" when what it means is "the thing
// under test is not there", and the two must not look alike.
const jiraAdfViolations = typeof adf.jiraAdfViolations === 'function' ? adf.jiraAdfViolations : null;

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) {
    console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  }
  if (!ok) failures++;
}

/**
 * Every forbidden mark combination in a document, found HERE rather than by
 * calling `jiraAdfViolations`.
 *
 * This is a second implementation of the property on purpose. The laziest
 * version of this script asks the converter's own diagnostic whether the
 * converter's own output is clean, which checks that adf.ts agrees with itself
 * — delete the rule from `MARK_COMPANIONS` and both sides stop believing in it
 * together, and this script stays green while the defect walks back in. §4
 * checks the shipped diagnostic separately, because that one is what explains a
 * refusal to an agent at runtime and is a different claim.
 */
function forbiddenCombinations(node, out = []) {
  if (node.type === 'text' && Array.isArray(node.marks)) {
    const types = node.marks.map((mark) => mark.type);
    if (types.includes('code')) {
      for (const other of types) {
        // Jira's schema lets `code` keep `link` and nothing else.
        if (other !== 'code' && other !== 'link') {
          out.push({ combination: `code+${other}`, text: node.text });
        }
      }
    }
  }
  for (const child of node.content ?? []) forbiddenCombinations(child, out);
  return out;
}

function convert(markdown, target) {
  try {
    return markdownToAdf(markdown, target);
  } catch (err) {
    return { refused: err?.message ?? String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
rule('1. the construct from the ticket, and the shapes around it');

// The RED half of the ticket's own red/green pair, plus the variants that make
// this about the mark combination rather than about bold or about backticks.
const CASES = [
  'KAN-420 ADF probe A: **bold wrapping `inline_code` here.**',
  '*italic wrapping `inline_code` here.*',
  '**a bolded sentence with `atlassian_add_comment` inside it, five times over.**',
  '_emphasis around `a_code_span` here._',
  '**bold with [a `code` link](https://example.com/x) inside**',
  '- **a list item whose bold wraps `an_identifier`**'
];

for (const source of CASES) {
  const result = convert(source, 'jira');
  if (result.refused) {
    check(`jira: ${JSON.stringify(source.slice(0, 52))} converts`, false, result.refused);
    continue;
  }
  const bad = result.doc.content.flatMap((block) => forbiddenCombinations(block));
  check(
    `jira: ${JSON.stringify(source.slice(0, 52))} emits no forbidden combination`,
    bad.length === 0,
    bad.map((b) => `${b.combination} on ${JSON.stringify(b.text)}`).join('\n')
  );
}

// A coercion is required, not optional: the agent wrote bold and did not get
// bold, and silence about that is the failure shape this whole file exists to
// refuse.
const coerced = convert('**bold wrapping `inline_code` here.**', 'jira');
check(
  'and the dropped mark is REPORTED as a coercion rather than changed silently',
  !coerced.refused && coerced.coercions.length > 0 && /code span/.test(coerced.coercions.join(' ')),
  coerced.refused ?? JSON.stringify(coerced.coercions)
);

// The code span is what survives; the decoration is what goes. Dropping the
// other way would keep the emphasis and throw away the author's meaning.
const kept = convert('**bold wrapping `inline_code` here.**', 'jira');
if (!kept.refused) {
  const codeNodes = [];
  const walk = (n) => {
    if (n.type === 'text' && (n.marks ?? []).some((m) => m.type === 'code')) codeNodes.push(n.text);
    (n.content ?? []).forEach(walk);
  };
  kept.doc.content.forEach(walk);
  check('the code mark is what survived, carrying its text', codeNodes.includes('inline_code'), JSON.stringify(codeNodes));
}

// ═══════════════════════════════════════════════════════════════════════════
rule("2. the fleet's own house-style markdown, read off the disk");

// AC4 asks for a check "converting the fleet's own house-style markdown". This
// is that: `prompts/task.md` is what every task agent is briefed with, it is
// dense with bold wrapping code spans, and it was written by nobody with this
// script in mind.
const briefPath = path.join(repoDir, 'prompts', 'task.md');
if (!fs.existsSync(briefPath)) {
  check('prompts/task.md is readable', false, `${briefPath} does not exist`);
} else {
  const brief = fs.readFileSync(briefPath, 'utf8');
  const paragraphs = brief.split(/\n\s*\n/).filter((block) => block.trim());

  // The count is reported whether or not it is zero. A section that says only
  // "no offenders" cannot be told from a section that examined nothing, and
  // this input is the one that made the check worth writing.
  let carriers = 0;
  const offenders = [];
  const refusals = [];
  for (const block of paragraphs) {
    if (/\*\*[^*]*`[^`]+`[^*]*\*\*/.test(block) || /_[^_]*`[^`]+`[^_]*_/.test(block)) carriers++;
    const result = convert(block, 'jira');
    if (result.refused) {
      refusals.push(`${JSON.stringify(block.slice(0, 60))} → ${result.refused.slice(0, 100)}`);
      continue;
    }
    for (const bad of result.doc.content.flatMap((b) => forbiddenCombinations(b))) {
      offenders.push(`${bad.combination} on ${JSON.stringify(String(bad.text).slice(0, 40))}`);
    }
  }

  console.log(
    `   (${paragraphs.length} paragraphs, ${carriers} of them writing a code span inside bold or italics)`
  );
  check('every paragraph converts for the jira target', refusals.length === 0, refusals.slice(0, 4).join('\n'));
  check(
    'and not one of them emits code+strong or code+em',
    offenders.length === 0,
    `${offenders.length} offender(s):\n${offenders.slice(0, 8).join('\n')}`
  );
  check(
    'the input actually contains the construct — a clean run over nothing proves nothing',
    carriers > 0,
    `${carriers} carriers found; if this is 0 the section above measured an absence of input, not an absence of defects`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
rule('2b. the marks that are LEGAL still survive — the over-stripping guard');

// ⚠ ADDED AT `epic/KAN-39`'s REVIEW OF #225, AND IT FOUND A REAL WEAKNESS.
//
// Their objection: *"a fix that makes every marked node plain would pass 'no
// node carries code with strong' and be worse than the defect."* That is exact.
// Every check above this line asks what the converter does NOT emit, and a
// converter that emitted no marks at all would satisfy all of them.
//
// It was not entirely uncovered — the mutation was written and run, and it was
// caught: `verify-adf-identifier-survives.mjs` §3 lost its `_emphasis_` marks,
// and §1/§5 here lost their coercion because stripping happened before anything
// could record it. But **both catches were incidental**, one of them in another
// file, and neither said what was wrong. A property worth holding is worth
// asserting directly rather than relying on a side effect of a different check
// noticing it.
//
// So this section states the other half: on Jira, a mark that is LEGAL is
// untouched, and the only thing that ever goes is the companion Jira refuses.
const LEGAL = [
  ['**just bold**', 'strong'],
  ['*just em*', 'em'],
  ['~~just struck~~', 'strike'],
  ['`just code`', 'code'],
  ['**bold** and `code` side by side', 'strong'],
  ['**bold** and `code` side by side', 'code'],
  ['[a link](https://example.com/x)', 'link'],
  ['**bold [link](https://example.com/y) inside**', 'link+strong']
];

for (const [source, want] of LEGAL) {
  const result = convert(source, 'jira');
  if (result.refused) {
    check(`jira: ${JSON.stringify(source)} converts`, false, result.refused);
    continue;
  }
  const marks = [];
  const walk = (n) => {
    if (n.type === 'text') marks.push((n.marks ?? []).map((m) => m.type).sort().join('+'));
    (n.content ?? []).forEach(walk);
  };
  result.doc.content.forEach(walk);
  check(
    `jira: ${JSON.stringify(source)} still carries ${want}`,
    marks.includes(want),
    `marks produced: ${JSON.stringify(marks)}`
  );
}

// And the surrounding run keeps its emphasis when only the code span is fixed.
// The failure this rules out is a fix that flattens the whole paragraph to
// repair one node inside it.
const surround = convert('**bold wrapping `inline_code` here.**', 'jira');
if (!surround.refused) {
  const kept = [];
  const walk = (n) => {
    if (n.type === 'text' && (n.marks ?? []).some((m) => m.type === 'strong')) kept.push(n.text);
    (n.content ?? []).forEach(walk);
  };
  surround.doc.content.forEach(walk);
  check(
    'the text AROUND a repaired code span keeps its bold — only the code node changed',
    kept.some((t) => typeof t === 'string' && t.includes('bold wrapping')),
    `still bold: ${JSON.stringify(kept)}`
  );
}

// Nothing is stripped from a document that never had a conflict, and the
// absence of a coercion is what says so.
const untouched = convert('**bold** and `code` side by side', 'jira');
check(
  'a document with no conflict reports no coercion and loses no mark',
  !untouched.refused && untouched.coercions.length === 0,
  untouched.refused ?? JSON.stringify(untouched.coercions)
);

// ═══════════════════════════════════════════════════════════════════════════
rule('3. Confluence is NOT changed — the two products stay distinguished');

// AC5. Confluence stored `code+strong` at HTTP 201, so stripping it there would
// be a regression made in the name of a fix. This section fails if Jira's rule
// leaks across.
const conf = convert('**bold wrapping `inline_code` here.**', 'confluence');
if (conf.refused) {
  check('confluence: the construct converts', false, conf.refused);
} else {
  const combos = conf.doc.content.flatMap((block) => forbiddenCombinations(block));
  check(
    'confluence KEEPS code+strong, which it accepts and Jira does not',
    combos.some((c) => c.combination === 'code+strong'),
    `combinations found: ${JSON.stringify(combos)}`
  );
  check(
    'and reports no coercion for it, because nothing was changed',
    conf.coercions.length === 0,
    JSON.stringify(conf.coercions)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
rule('4. the shipped diagnostic, which is what explains a 400 to an agent');

// `jiraAdfViolations` is what `jira.ts` calls on a 400 to name the construct
// responsible (AC3). It has to find the offender in a REQUEST body, not in a
// document handed to it already located — a comment carries its document at
// `body`, an edit and a create at `fields.description`.
const badNode = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'inline_code', marks: [{ type: 'code' }, { type: 'strong' }] }]
    }
  ]
};

if (!jiraAdfViolations) {
  check(
    'the build under test exports jiraAdfViolations, which is what names the construct',
    false,
    'not exported — a build predating KAN-502 has no diagnostic, so §4 cannot be measured against it.'
  );
} else {
check(
  'it names code+strong in a comment body',
  jiraAdfViolations({ body: badNode }).some((line) => line.includes('code+strong')),
  JSON.stringify(jiraAdfViolations({ body: badNode }))
);
check(
  "it names it in a create's fields.description, the endpoint that reported least",
  jiraAdfViolations({ fields: { summary: 'x', description: badNode } }).some((line) => line.includes('code+strong')),
  JSON.stringify(jiraAdfViolations({ fields: { summary: 'x', description: badNode } }))
);
check(
  'and it says nothing about a clean document, so its silence means something',
  jiraAdfViolations({ body: convert('**bold** and `code` side by side', 'jira').doc }).length === 0,
  JSON.stringify(jiraAdfViolations({ body: convert('**bold** and `code` side by side', 'jira').doc }))
);
}

// ═══════════════════════════════════════════════════════════════════════════
rule('5. the drop reaches the AGENT, not just the converter\'s return value');

// ⚠ THIS SECTION EXISTS BECAUSE §1's COERCION CHECK WAS NOT ENOUGH, AND THE GAP
// IT FOUND WAS REAL. `markdownToAdf` has always returned `coercions`, and
// `markdownBody` has always passed them back, and every one of the proxy's
// EIGHT call sites dropped them: nothing in the daemon read the field, so a
// coercion was reported to a caller that discarded it and the agent was never
// told. §1 asserting "the converter returns a coercion" is true and was true
// before this ticket; it says nothing about whether anybody hears it.
//
// So this asks the operation table itself. `build` is what `router.ts` calls,
// and `takeBuildCoercions` is what it reads immediately after — the same two
// calls in the same order, against the real registered operation.
const proxy = await import('../dist/atlassian-proxy.js');

if (typeof proxy.beginBuildCoercions !== 'function' || typeof proxy.takeBuildCoercions !== 'function') {
  check(
    'the build under test collects coercions for the agent',
    false,
    'beginBuildCoercions/takeBuildCoercions not exported — a build predating KAN-502 discards ' +
      'every coercion, so this section cannot be measured against it.'
  );
} else {
  const comment = proxy.operationByTool('atlassian_add_comment');
  check('the comment write is a registered operation', !!comment, 'atlassian_add_comment not found');

  if (comment) {
    proxy.beginBuildCoercions();
    const built = comment.build({
      issueKey: 'KAN-502',
      bodyMarkdown: '**bold wrapping `inline_code` here.**'
    });
    const reported = proxy.takeBuildCoercions();

    check('the write builds rather than being refused', !('error' in built), JSON.stringify(built).slice(0, 200));
    check(
      'and the dropped mark is reported to the agent, naming the field it was in',
      reported.some((line) => /bodyMarkdown/.test(line) && /code span/.test(line)),
      JSON.stringify(reported)
    );

    // The absence has to mean something too, or a caller cannot read it.
    proxy.beginBuildCoercions();
    comment.build({ issueKey: 'KAN-502', bodyMarkdown: '**bold** and `inline_code` side by side.' });
    check(
      'a write that changed nothing reports nothing, so the field\'s absence is informative',
      proxy.takeBuildCoercions().length === 0,
      JSON.stringify(proxy.takeBuildCoercions())
    );

    // A Confluence write must not report a drop it did not make.
    const page = proxy.operationByTool('atlassian_create_confluence_page');
    if (page) {
      proxy.beginBuildCoercions();
      page.build({
        spaceId: '65551',
        title: 'probe',
        bodyMarkdown: '**bold wrapping `inline_code` here.**'
      });
      check(
        'the Confluence write reports no drop, because Confluence keeps the combination',
        proxy.takeBuildCoercions().length === 0,
        JSON.stringify(proxy.takeBuildCoercions())
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — no Jira-bound document emits code+strong or code+em, the drop is reported as a ' +
        'coercion that reaches the agent, Confluence keeps what it accepts, and the diagnostic ' +
        'names the construct in the request shapes a 400 actually arrives from.'
  }\n`
);
process.exit(failures ? 1 : 0);
