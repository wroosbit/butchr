// KAN-502 AC3: a Jira 400 reaches the agent naming what was wrong with the
// document, rather than as a bare "malformed (400)".
//
// WHAT FAILURE THIS WOULD CATCH: the proxy passing Jira's own uninformative
// rejection straight through. Jira answers a bad ADF document with
// `INVALID_INPUT` and nothing else — no node, no mark, no field — and on the
// issue-creation endpoint the detail was being dropped entirely before it ever
// reached the message. Measured by `task/KAN-513` on the same malformed input
// through two endpoints on one daemon:
//
//     atlassian_add_comment   -> INVALID_INPUT, with detail
//     atlassian_create_issue  -> "Jira rejected this request as malformed (400)"
//                                and NO INVALID_INPUT detail at all
//
// The cause was that `extractDetail` read `errorMessages` (an array, empty on
// that endpoint) and never `errors` (an object keyed by field, which is where
// Jira had put `description: INVALID_INPUT` the whole time). §1 holds that.
//
// ⚠ WHY THAT MATTERS MORE THAN A MISSING WORD: a bare `malformed (400)` is
// indistinguishable from a network-level rejection, so a caller has no reason
// to suspect its own markup. KAN-513 lost two attempts to it before finding the
// cause already written down on another ticket.
//
// It would equally catch the opposite failure, which §3 exists for: a proxy
// that names a construct whenever it sees a 400, whether or not the document
// has one. A diagnosis that fires every time is not a diagnosis — it would send
// the next agent rewriting clean markdown while the real cause went unlooked
// at. So the silence on a clean document is asserted as hard as the naming on a
// dirty one.
//
// CI-RUNNABLE: yes — `explainProxyFailure` is a pure function from a status and
// a payload to a sentence, and it is called here directly; no live daemon, no
// herdr, no credential, no network, no terminal.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// ⚠ **This script constructs the refusals it then asserts on.** It builds the
// leg records and the request body by hand, so it proves that `explainProxyFailure`
// says the right thing when handed a 400 — and NOT that a real Jira 400 arrives
// carrying the shape it was handed. Those are different claims and only the
// first is decidable here.
//
// Who covers the second: `daemon/scripts/verify-atlassian-proxy-failure-is-loud.mjs`
// runs a real daemon against a stub Atlassian that returns real status codes,
// and is where "the daemon's own failures reach an agent at all" is
// established. Nobody covers the join — that Jira's *production* 400 for a bad
// document has `errors` keyed the way §1 assumes. That shape is taken from
// KAN-513's measurement rather than from documentation, and it is the
// assumption in this file most worth re-measuring if this check ever goes quiet
// while agents still report bare 400s.
//
// Usage: node daemon/scripts/verify-adf-refusal-names-the-construct.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');

requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const jira = await import('../dist/jira.js');
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

// A build without these exports is the pre-fix build, which is exactly what a
// red drive runs. Reported as a FAIL rather than left to throw: a stack trace
// from a missing import says "this script is broken" when what it means is
// "the thing under test is not there", and those must not look alike.
const explainProxyFailure = jira.explainProxyFailure;
const extractDetail = jira.extractDetail;
if (typeof explainProxyFailure !== 'function' || typeof extractDetail !== 'function') {
  check(
    'the build under test exports the refusal explainers this script is about',
    false,
    `explainProxyFailure: ${typeof explainProxyFailure}, extractDetail: ${typeof extractDetail} — ` +
      'a build predating KAN-502 exports neither, so nothing below can be measured against it.'
  );
  console.log(`\nFAILED — ${failures} check(s)\n`);
  process.exit(failures ? 1 : 0);
}

/** The document Jira refuses, as the converter emitted it before this ticket. */
const OFFENDING = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold wrapping ', marks: [{ type: 'strong' }] },
        { type: 'text', text: 'inline_code', marks: [{ type: 'code' }, { type: 'strong' }] }
      ]
    }
  ]
};

/** A document with nothing wrong with it, for the silence half. */
const CLEAN = markdownToAdf('**bold** and `inline_code` side by side.', 'jira').doc;

const leg = (detail) => [
  { leg: 'site', endpoint: 'POST /rest/api/3/issue', status: 400, ...(detail ? { detail } : {}) }
];

// ═══════════════════════════════════════════════════════════════════════════
rule("1. Jira's field-keyed `errors` map is read — the create-path gap");

// The payload shape that reported nothing: `errorMessages` present and EMPTY,
// the whole explanation sitting in `errors` beside it. Before this ticket the
// first was read and the second was not, so this returned undefined and the
// agent got a bare "malformed (400)".
const CREATE_400 = { errorMessages: [], errors: { description: 'INVALID_INPUT' } };
check(
  'the field-keyed `errors` map is read when `errorMessages` is empty',
  extractDetail(JSON.stringify(CREATE_400), CREATE_400) === 'description: INVALID_INPUT',
  `got: ${JSON.stringify(extractDetail(JSON.stringify(CREATE_400), CREATE_400))}`
);

// More than one bad field is named, and each says which field it was about.
const TWO_FIELDS = { errorMessages: [], errors: { summary: 'TOO_LONG', description: 'INVALID_INPUT' } };
check(
  'more than one field error is reported, each named',
  /summary: TOO_LONG/.test(extractDetail('', TWO_FIELDS) ?? '') &&
    /description: INVALID_INPUT/.test(extractDetail('', TWO_FIELDS) ?? ''),
  `got: ${JSON.stringify(extractDetail('', TWO_FIELDS))}`
);

// `errorMessages` still wins where it has something to say, so this widening
// did not change the endpoint that already worked.
const COMMENT_400 = { errorMessages: ['INVALID_INPUT'], errors: {} };
check(
  'and `errorMessages` still takes precedence where Jira populated it',
  extractDetail('', COMMENT_400) === 'INVALID_INPUT',
  `got: ${JSON.stringify(extractDetail('', COMMENT_400))}`
);

// An empty map must fall through rather than render as an empty sentence:
// "there was no field error" and "there was one and it was blank" are
// different facts and only the first should reach the next candidate.
check(
  'an empty `errors` map falls through to the next candidate rather than blanking it',
  extractDetail('', { errorMessages: [], errors: {}, message: 'something else' }) === 'something else',
  `got: ${JSON.stringify(extractDetail('', { errorMessages: [], errors: {}, message: 'something else' }))}`
);

const created = explainProxyFailure(400, leg('description: INVALID_INPUT'), true, 'jira', {
  fields: { summary: 'x', description: OFFENDING }
});
check(
  "the field-keyed detail reaches the message ('description: INVALID_INPUT')",
  created.error.includes('description: INVALID_INPUT'),
  created.error
);

// ═══════════════════════════════════════════════════════════════════════════
rule('2. and the construct in the document is named');

check(
  'the offending mark combination is named',
  created.error.includes('code+strong'),
  created.error
);
check(
  'the agent is told what to do about it',
  /Rewrite that part of your markdown/.test(created.error),
  created.error
);
check(
  'and told nothing was written, so nothing needs undoing',
  /nothing was written/i.test(created.error),
  created.error
);

// A comment body carries its document at `body`, not at `fields.description`.
// The diagnosis must not be keyed to one operation's shape.
const commented = explainProxyFailure(400, leg('INVALID_INPUT'), true, 'jira', { body: OFFENDING });
check(
  'the same naming happens for a comment, whose document sits at a different key',
  commented.error.includes('code+strong'),
  commented.error
);

// ═══════════════════════════════════════════════════════════════════════════
rule('3. a clean document is NOT blamed — the silence has to mean something');

const clean = explainProxyFailure(400, leg('INVALID_INPUT'), true, 'jira', { body: CLEAN });
check(
  'no construct is named when the document has none',
  !clean.error.includes('code+strong') && !/The document Butchr sent contains/.test(clean.error),
  clean.error
);
check(
  "but Jira's own words still get through",
  clean.error.includes('INVALID_INPUT'),
  clean.error
);

// ═══════════════════════════════════════════════════════════════════════════
rule('4. the diagnosis is scoped to Jira and to 400');

// Confluence stores this document at HTTP 201. Blaming the mark combination for
// a Confluence 400 would send an agent to rewrite markdown that is fine there.
const conf = explainProxyFailure(400, leg('INVALID_INPUT'), true, 'confluence', { body: OFFENDING });
check(
  'a Confluence 400 does not blame a combination Confluence accepts',
  !conf.error.includes('code+strong'),
  conf.error
);
check('and it names Confluence rather than Jira as the refuser', conf.error.startsWith('Confluence'), conf.error);

// A 404 is about the issue key, not the document. Naming a mark combination
// there would be a confident misdiagnosis of the kind this file exists to end.
const missing = explainProxyFailure(404, [{ leg: 'site', endpoint: 'POST /rest/api/3/issue/KAN-9999/comment', status: 404, detail: 'Issue does not exist' }], true, 'jira', { body: OFFENDING });
check(
  'a 404 is not explained by the document',
  !missing.error.includes('code+strong'),
  missing.error
);

// A read has no document to blame and must not acquire one.
const read = explainProxyFailure(400, leg('INVALID_INPUT'), false, 'jira', undefined);
check('a read with no body still produces a sentence', typeof read.error === 'string' && read.error.length > 0, read.error);
check('and blames no construct', !read.error.includes('code+strong'), read.error);

// ═══════════════════════════════════════════════════════════════════════════
rule('5. none of this is a credential fault, and the message must not say so');

// The failure this guards is an agent reading "your markup is wrong" as "the
// fleet's token is broken" and escalating to a human who can do nothing.
check('a 400 is reported as the query\'s fault, not the credential\'s', created.credentialFault === false, JSON.stringify(created.credentialFault));

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : "OK — a Jira 400 carries Jira's own field-keyed words and names the construct in the " +
        'document that caused it; a clean document, a Confluence refusal, a 404 and a read are ' +
        'each left unblamed.'
  }\n`
);
process.exit(failures ? 1 : 0);
