// KAN-502: a snake_case identifier written in ordinary prose must reach the
// page it was written on.
//
// WHAT FAILURE THIS WOULD CATCH: the markdown→ADF converter treating an
// underscore *inside a word* as an emphasis delimiter, which consumes the run
// and deletes the identifier from the output text. That was live until
// 2026-08-18 and it made `atlassian_update_confluence_page` — and every other
// tool name this fleet has, all of them snake_case with two or more
// underscores — unwritable in prose through the proxy:
//
//     AdfConversionError: The markdown→ADF conversion would have lost 1 token(s)
//     from your content — "atlassian_update_confluence_page". NOTHING WAS WRITTEN.
//
// It would equally catch the opposite repair, which is the one worth guarding
// against because it is silent: somebody "fixing" the refusal by widening
// `contentTokens` in adf.ts so the lost identifier stops being counted. That
// turns a loud refusal into a page storing `atlassianupdateconfluence_page`
// with nothing said, which is the exact failure the completeness guard exists
// to prevent. §2 therefore checks the identifier is *present in the output*,
// not merely that the conversion did not throw — the two come apart precisely
// under that repair.
//
// And it would catch a repair that went too far the other way: disabling `_`
// emphasis outright, so `_emphasised_` stopped being emphasis at all. §3 is
// what holds that line.
//
// CI-RUNNABLE: yes — imports the built converter and asserts against it in
// process; no live daemon, no herdr, no credential, no network, no terminal.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// §1–§3 supply their own markdown, which means they test the cases somebody
// thought of. §4 gets its identifiers from `prompts/task.md` instead — the
// fleet's own brief, written by nobody with this check in mind.
//
// ⚠ §4 CONVERTS THE BRIEF WITH ITS BACKTICKS REMOVED, AND THAT IS DELIBERATE.
// Measured: the brief contains **zero** bare two-or-more-underscore identifiers
// and 18 that appear only inside backticks, because house style backticks
// everything — which is the workaround this very defect forced on the fleet.
// Converted as written, §4 therefore exercises only the path that always
// worked, and it passed against the pre-fix converter on its first draft: a
// check with no reachable failing branch. Un-backticking gives it a red to go
// to. The positive control at the top of §4 is what stops it quietly emptying
// again.
//
// What none of it covers is the round trip. This script never sends a document
// to Atlassian, so it cannot tell you the identifier is in the *stored* text.
// That leg is `daemon/scripts/probe-atlassian-proxy-content-writes.mjs`, which
// writes through the proxy with the real credential and reads the result back;
// it is a `probe-` because it touches production. Between the two there is one
// genuine gap and nobody covers it: the *live* proxy path from an agent's tool
// call to `markdownBody`, which is exercised by neither.
//
// Usage: node daemon/scripts/verify-adf-identifier-survives.mjs [--verbose]
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

const { markdownToAdf } = await import('../dist/adf.js');

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) {
    console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  }
  if (!ok) failures++;
}

/** All text an ADF subtree carries, flattened. The output side of the claim. */
function textOf(node) {
  const own = typeof node.text === 'string' ? node.text : '';
  const children = (node.content ?? []).map(textOf).join('');
  return `${own}${children}`;
}

/** Convert without dying, so a refusal reads as a FAIL rather than a stack. */
function convert(markdown, target) {
  try {
    return { doc: markdownToAdf(markdown, target).doc };
  } catch (err) {
    return { refused: err?.message ?? String(err) };
  }
}

/** Every mark type on every text node, for §3. */
function marksOf(node, out = []) {
  if (node.type === 'text') out.push((node.marks ?? []).map((m) => m.type).sort().join('+'));
  for (const child of node.content ?? []) marksOf(child, out);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
rule('1. the identifiers this fleet writes every day, in bare prose');

// Every one of these is a real tool on this fleet's own MCP surface. They are
// not sampled or representative — they are the names an agent has to be able to
// type, and the reason this defect was worth a ticket.
const IDENTIFIERS = [
  'atlassian_update_confluence_page',
  'atlassian_get_issue_comments',
  'atlassian_add_comment',
  'atlassian_create_issue',
  'butchr_send_to_agent',
  'butchr_list_agents',
  'butchr_atlassian_proxy_status',
  'customfield_10001'
];

for (const identifier of IDENTIFIERS) {
  const source = `The tool ${identifier} was called at version 2.`;
  for (const target of ['jira', 'confluence']) {
    const result = convert(source, target);
    if (result.refused) {
      check(`${target}: ${identifier} converts at all`, false, result.refused);
      continue;
    }
    const produced = textOf(result.doc);
    check(
      `${target}: ${identifier} survives into the document, character for character`,
      produced.includes(identifier),
      `produced: ${JSON.stringify(produced)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
rule('2. more than one on a line, which is where the pairing used to happen');

// The original defect was underscores *pairing across a line*, so a line with
// two identifiers on it lost both. One identifier alone was not the sharpest
// case and would not have been the first to fail.
const TWO_UP = 'atlassian_add_comment and atlassian_edit_issue both work.';
const twoUp = convert(TWO_UP, 'jira');
check('a line naming two identifiers converts', !twoUp.refused, twoUp.refused);
if (!twoUp.refused) {
  const produced = textOf(twoUp.doc);
  check('both identifiers are in the output', produced.includes('atlassian_add_comment') && produced.includes('atlassian_edit_issue'), produced);
}

// A single underscore was always safe — it had no partner — so it is the
// control that says this section is measuring pairing rather than underscores.
const ONE = convert('added by atlassian_update at version 2.', 'jira');
check('the one-underscore control still converts (it always did)', !ONE.refused, ONE.refused);

// The identifier wrapped in underscores is the case both ends of the rule have
// to agree on: the opener may fire, and the closer must not eat the middle.
const WRAPPED = convert('_atlassian_update_confluence_page_ is the tool.', 'jira');
check('an identifier wrapped in underscores keeps its middle', !WRAPPED.refused && textOf(WRAPPED.doc).includes('atlassian_update_confluence_page'), WRAPPED.refused ?? textOf(WRAPPED.doc));

// ═══════════════════════════════════════════════════════════════════════════
rule('3. and `_emphasis_` is still emphasis — the over-correction guard');

// Without this section the cheapest way to pass §1 and §2 is to delete `_`
// emphasis entirely, which would pass every check above and quietly change how
// every existing ticket renders.
const EMPHASIS = [
  ['_emphasis_ at the start of a line', 'em'],
  ['an _emphasised_ word mid-sentence', 'em'],
  ['__bold underscores__ here', 'strong']
];
for (const [source, want] of EMPHASIS) {
  const result = convert(source, 'jira');
  const marks = result.refused ? [] : marksOf(result.doc);
  check(
    `${JSON.stringify(source)} still produces a ${want} mark`,
    marks.includes(want),
    result.refused ?? `marks: ${JSON.stringify(marks)}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
rule("4. the fleet's own house style, read off the disk rather than invented");

// `prompts/task.md` is what every task agent is briefed with. Nobody wrote it
// to pass this script, which is the whole reason it is the input worth using.
const briefPath = path.join(repoDir, 'prompts', 'task.md');
if (!fs.existsSync(briefPath)) {
  check('prompts/task.md is readable', false, `${briefPath} does not exist`);
} else {
  const brief = fs.readFileSync(briefPath, 'utf8');

  // Convert paragraph by paragraph rather than whole: a 90 KB document over
  // the proxy's 32 000-character body cap is not a shape any write takes, and
  // converting it whole would be measuring something no agent ever sends.
  const paragraphs = brief.split(/\n\s*\n/).filter((block) => block.trim());

  // ⚠ THE BACKTICKS COME OFF, AND THAT IS THE WHOLE POINT OF THIS SECTION.
  //
  // Measured on this file: `prompts/task.md` contains **zero** bare
  // two-or-more-underscore identifiers outside backticks, and 18 that appear
  // only inside them. House style backticks everything — which is exactly the
  // workaround this defect forced on the fleet in the first place.
  //
  // So converting the brief as written tests only the path that ALWAYS worked.
  // The first draft of this section did that, and it passed against the
  // pre-fix converter: a check with no reachable failing branch, which is not a
  // weak check but an absent one wearing a passing one's clothes. Un-backticking
  // is what gives it a red to go to — it asks the question the ticket is about,
  // *"can this project's real identifiers be written as prose"*, using this
  // project's real identifiers rather than a list somebody invented.
  const unbacktick = (block) =>
    block.replace(/`([^`\n]+)`/g, (whole, inner) =>
      /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){2,}$/.test(inner) ? inner : whole
    );

  const refused = [];
  const lost = [];
  let examined = 0;
  for (const block of paragraphs) {
    const source = unbacktick(block);
    const bare = new Set(
      (source.replace(/`[^`\n]*`/g, ' ').match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){2,}/g) ?? [])
    );
    if (!bare.size) continue;
    examined += bare.size;

    const result = convert(source, 'jira');
    if (result.refused) {
      refused.push(`${JSON.stringify(block.slice(0, 70))} → ${result.refused.slice(0, 110)}`);
      continue;
    }
    const produced = textOf(result.doc);
    for (const found of bare) {
      if (!produced.includes(found)) lost.push(`${found} (in ${JSON.stringify(block.slice(0, 60))})`);
    }
  }

  // The positive control. Without it a change to house style, or to the regex
  // above, silently empties this section and the two checks below go green over
  // nothing — which is the exact failure this section was rewritten to escape.
  check(
    'the brief actually yielded identifiers to test — a clean run over nothing proves nothing',
    examined > 0,
    `${examined} bare identifiers assembled from prompts/task.md; 0 means this section measured no input`
  );
  check(
    "every paragraph of prompts/task.md carrying one converts once its identifiers are bare",
    refused.length === 0,
    `${refused.length} refused:\n${refused.slice(0, 4).join('\n')}`
  );
  check(
    'and not one of those identifiers is lost',
    lost.length === 0,
    `${lost.length} lost:\n${lost.slice(0, 6).join('\n')}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : "OK — snake_case identifiers survive conversion in bare prose, several to a line and " +
        "throughout the fleet's own brief; `_emphasis_` still marks."
  }\n`
);
process.exit(failures ? 1 : 0);
