// Proof for KAN-656: a description LARGER than the response budget is
// reachable, a window at a time, and the cursor that walks it survives the clip
// that shortens the text.
//
// WHAT FAILURE THIS WOULD CATCH: a Jira description that no tool on this proxy
// can return, so the agent staffed for a ticket cannot read the ticket it was
// staffed for. Measured on KAN-623 (2026-08-21) by the agent assigned to it:
// every read route ended in `noWayBack` — `atlassian_get_issue` at 48,230
// unclipped characters, the same call with `fields=description` at 40,543, and
// `atlassian_search_issues` with the description RENDERED TO TEXT at 8,568
// characters against a 9,000 budget, losing by about 200 characters of response
// envelope. `atlassian_fetch_resource` takes no `fields` at all. There was no
// narrower request to make: `description` is one field and it is the one
// wanted. This script would have gone red on that ticket and does go red if the
// pager, the string rung, or the recipe that names the pager is removed.
//
// IT WOULD ALSO CATCH THE WRONG FIX, which is the likelier failure. Raising
// `DEFAULT_BUDGET_CHARS` moves the cliff instead of adding a route over it, and
// would satisfy a proof that only ever ran at one budget. Section 4 runs the
// whole walk at a budget far BELOW the default — where any fix that works by
// having more room fails — and section 6 asserts the two constants are
// unchanged.
//
// CI-RUNNABLE: yes — imports the built modules in process and reads one
// captured fixture; no live daemon, no herdr, no credential, no peer, no
// terminal, no network.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: `fitGenericResponse` and `genericRecovery` as built, and the operation
// taken off `PROXY_OPERATIONS` — the same table the MCP server advertises from,
// so the `build` and `transform` exercised here are the ones that run. Real
// too: the fixture, which is KAN-623's ACTUAL description ADF captured through
// the daemon proxy, not a hand-written stand-in of it.
//
// ⚠ STUBBED, AND THIS SCRIPT WRITES THE RECORD IT THEN ASSERTS ON. The HTTP
// round trip to Jira is not made: section 2 hands the operation's transform a
// fixture body rather than one `build`'s path fetched. So this proves the
// rendering, the windowing, the cursor and the recipe are correct GIVEN a Jira
// response — and NOT that `build` addresses the right endpoint, that Jira
// returns `fields.description` for it, or that the daemon's dispatcher reaches
// this operation at all. Section 1 narrows the middle one by asserting the path
// `build` produces asks for exactly that field, which is a static read and not
// a call.
//
// WHO COVERS THE REST: nobody yet, and that is stated rather than left to be
// inferred. `probe-atlassian-proxy-read-surface.mjs` is the live-daemon
// counterpart for the existing read operations and does not know about this
// one; extending it needs a daemon and a credential and is therefore not
// CI-runnable. That gap is filed as its own ticket, linked `Relates` to
// KAN-656. The hole this leaves is the KAN-145 shape exactly — two artifacts
// that each test their own half — and it is marked here because the edge of
// this script's coverage is this script's job to mark.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const { PROXY_OPERATIONS, PROXY_DESCRIPTION_MAX_CHARS } = await import('../dist/atlassian-proxy.js');
const {
  fitGenericResponse,
  DEFAULT_BUDGET_CHARS,
  MEASURED_CLIENT_CAP_CHARS,
  MIN_BUDGET_CHARS
} = await import('../dist/mcp-response-budget.js');
const { genericRecovery } = await import('../dist/mcp-recovery.js');

let failures = 0;
const check = (what, ok, detail = '') => {
  if (ok) {
    console.log(`   PASS  ${what}`);
  } else {
    failures += 1;
    console.log(`   FAIL  ${what}`);
    if (detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`);
  }
};
const rule = (title) => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
};

const TOOL = 'atlassian_get_issue_description';
const fixturePath = path.join(scriptDir, 'fixtures', 'kan-656-kan-623-description.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

/** One proxied answer, fitted exactly as `boundToBudget` fits it. */
function callAndFit(args, budgetChars) {
  const op = PROXY_OPERATIONS.find((o) => o.tool === TOOL);
  const built = op.build(args);
  if ('error' in built) return { refused: built.error };
  const body = op.transform([{ key: fixture.key, fields: fixture.fields }], {}, args);
  const response = {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    via: { tool: TOOL, method: 'GET', path: built.path, products: ['jira'], servedBy: 'daemon' },
    body
  };
  const fitted = fitGenericResponse(response, {
    budgetChars,
    tool: TOOL,
    recoveryFor: (p) => genericRecovery(TOOL, p, args.issueKey)
  });
  return { fitted, body: fitted.payload.body, raw: body };
}

/**
 * Walk the pager to the end and return what it reassembles.
 *
 * ⚠ PAGES BY THE LENGTH OF THE TEXT IT ACTUALLY RECEIVED, which is the whole
 * contract this asserts. The response budget can shorten a window AFTER the
 * daemon built it, so any count the daemon sent would be a number about a
 * payload that had not finished being reduced. The operation therefore sends no
 * such count and this walks by `text.length`.
 *
 * ⚠ AND WHEN A WINDOW DOES NOT FIT AT ALL, IT FOLLOWS THE PRINTED RECIPE rather
 * than giving up or restarting. That is the second half of the contract: the
 * stub names this same call with the place kept and the window halved, so a
 * reader that does what it says converges. Following it here is what makes it a
 * tested instruction rather than a decorative one — the recipe is PARSED out of
 * the response and its arguments are used, never reconstructed from what this
 * script already knows.
 */
function walk(budgetChars, maxResults) {
  const seen = [];
  let startAt = 0;
  let window = maxResults ?? null;
  let guard = 0;
  let total = null;
  let followed = 0;
  for (;;) {
    if (++guard > 500) return { text: seen.join(''), total, pages: guard, ranAway: true };
    const args = { issueKey: fixture.key, startAt, ...(window ? { maxResults: window } : {}) };
    const { body, fitted } = callAndFit(args, budgetChars);
    if (typeof body.total === 'number') total = body.total;

    if (typeof body.text !== 'string') {
      // The window did not fit. The stub is required to say what to do instead;
      // parse it and do that. A stub with no usable recipe strands the reader,
      // which is this ticket rebuilt one turn deeper.
      const recipe = findRecipe(body);
      if (!recipe) return { text: seen.join(''), total, pages: guard, stalled: true, body };
      const next = parseRecipe(recipe);
      if (!next || (next.startAt === startAt && next.maxResults === window)) {
        return { text: seen.join(''), total, pages: guard, stalled: true, body, recipe };
      }
      startAt = next.startAt;
      window = next.maxResults;
      followed += 1;
      continue;
    }
    if (body.text.length === 0) {
      return { text: seen.join(''), total, pages: guard, stalled: true, body };
    }
    seen.push(body.text);
    startAt = body.startAt + body.text.length;
    if (startAt >= body.total) break;

    // ⚠ A WINDOW THAT ARRIVED CUT IS A WINDOW TOO BIG FOR THIS BUDGET, and the
    // clip record says so AND names a smaller one. Adopting it is what keeps
    // the walk from crawling: at a 1,000-character budget an unnarrowed
    // 6,000-character request comes back as FOUR characters — the disclosure of
    // what was dropped costs more than the text it displaced — which is
    // progress in the same sense that a walk of two thousand calls is progress.
    // Following the printed recipe converges instead, and this is the second
    // place the recipe is executed rather than read.
    const cut = clipRecordFor(fitted, 'body.text');
    if (cut) {
      const next = parseRecipe(cut.readTheRest);
      if (next && next.maxResults !== window) {
        window = next.maxResults;
        followed += 1;
      }
    }
  }
  return { text: seen.join(''), total, pages: guard, followed };
}

/** The clip record taken against one field, or null where the field survived. */
function clipRecordFor(fitted, field) {
  if (!fitted || fitted.completeness.kind !== 'clipped') return null;
  return fitted.completeness.clipped.find((c) => c.field === field) ?? null;
}

/** The `readWith` a stub left behind, wherever in the body it landed. */
function findRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.readWith === 'string') return node.readWith;
  for (const value of Object.values(node)) {
    const found = findRecipe(value);
    if (found) return found;
  }
  return null;
}

/** The arguments a printed recipe actually types, read off the recipe itself. */
function parseRecipe(text) {
  const startAt = text.match(/startAt:\s*(\d+)/);
  const maxResults = text.match(/maxResults:\s*(\d+)/);
  if (!startAt || !maxResults) return null;
  return { startAt: Number(startAt[1]), maxResults: Number(maxResults[1]) };
}

const op = PROXY_OPERATIONS.find((o) => o.tool === TOOL);

// ⚠ THE WHOLE TEXT COMES FROM THE RENDERER, NOT FROM THE OPERATION. Asking the
// operation for a huge window returns `PROXY_DESCRIPTION_MAX_CHARS` of text,
// because `maxResults` is CLAMPED rather than refused — so a "whole text" taken
// that way is silently the first page, and every reassembly check below would
// then be comparing the walk against a prefix of itself and passing. Caught by
// section 0's size assertion on the first run of this script, which is what that
// assertion is for.
const { adfToText } = await import('../dist/adf.js');
const wholeText = adfToText(fixture.fields.description).text;

// ───────────────────────────────────────────────────────────────────────────
rule('0. THE FIXTURE IS A REAL DESCRIPTION, AND IT IS OVER BUDGET');

console.log(`   fixture:            ${path.relative(daemonDir, fixturePath)}`);
console.log(`   rendered:           ${fixture._liveRenderedChars} chars (captured ${fixture._capturedOn})`);
console.log(`   raw ADF:            ${fixture._liveAdfChars} chars`);
console.log(`   budget:             ${DEFAULT_BUDGET_CHARS} chars\n`);

check(
  'the operation is on the table and carries a transform',
  Boolean(op?.transform),
  'no transform — the rendered path does not exist'
);
check(
  'the fixture still renders to the size it was captured at',
  wholeText.length === fixture._liveRenderedChars,
  `renders to ${wholeText.length}, fixture claims ${fixture._liveRenderedChars} — recapture it, ` +
    'or every measurement below is about a payload the proxy never sees'
);
// ⚠ MEASURED AS A WHOLE RESPONSE, NOT AS A BARE STRING, and the difference is
// the entire margin this ticket turns on. KAN-623's description is 8,384
// rendered characters against a 9,000 budget — it FITS by itself, and a check
// that weighed only the text would conclude there is no defect here. What loses
// is the description INSIDE the proxy envelope, which is the only form anybody
// ever receives it in. The ticket's own words: it "gets to 8,568 characters
// against a 9,000 budget — and still loses, by about 200 characters of response
// envelope."
//
// ⚠ AND MEASURED BY THE FITTER RATHER THAN BY HAND. A hand-built envelope omits
// the `completeness` block the fitter adds to every answer before weighing it,
// which on this fixture is the difference between 8,961 characters (under, so
// "no defect here") and the real figure. Reading `unclippedChars` off the
// fitter's own verdict is the only measurement that counts the same bytes the
// budget counts — and getting this wrong in the reassuring direction is the
// exact failure this script's own header warns about.
const searchShaped = {
  action: 'atlassian_proxy_call_response',
  success: true,
  status: 200,
  via: {
    tool: 'atlassian_search_issues',
    method: 'GET',
    path: '/rest/api/3/search/jql?jql=key%3DKAN-623&fields=description&maxResults=1',
    products: ['jira'],
    servedBy: 'daemon'
  },
  body: { found: 1, isLast: true, total: null, issues: [{ key: 'KAN-623', description: wholeText }] }
};
const asSearched = fitGenericResponse(searchShaped, {
  budgetChars: DEFAULT_BUDGET_CHARS,
  tool: 'atlassian_search_issues',
  recoveryFor: (p) => genericRecovery('atlassian_search_issues', p)
});
const wholeResponseChars =
  asSearched.completeness.kind === 'clipped'
    ? asSearched.completeness.unclippedChars
    : asSearched.completeness.chars;
console.log(`   as one response:    ${wholeResponseChars} chars (text ${wholeText.length} + envelope)`);
console.log(`   verdict:            ${asSearched.completeness.kind}\n`);
// ⚠ THE RENDERED SEARCH ROUTE IS NOT ASSERTED TO LOSE, AND THAT IS DELIBERATE.
// KAN-656 measured it at 8,568 characters against 9,000 on 2026-08-21; this
// fixture renders to 8,384 today and the modelled response comes to 8,961 —
// which FITS, by under forty characters. Asserting a red there would be
// asserting that a description stays exactly the length it was on a Tuesday,
// and the check would go green or red on somebody editing a ticket. What is
// asserted instead is the thing that is actually true and actually the point:
// THIS IS A SIZE BOUNDARY AND THIS TICKET SITS ON IT. A description a few
// hundred characters longer — which is to say most of this board's briefs —
// is past it, and nothing about being under it today is a margin anybody chose.
console.log(
  `   margin:             ${DEFAULT_BUDGET_CHARS - wholeResponseChars} chars ` +
    `(${((wholeResponseChars / DEFAULT_BUDGET_CHARS) * 100).toFixed(1)}% of budget)\n`
);
check(
  'the rendered search route is ON the budget boundary — within 10% either way',
  Math.abs(wholeResponseChars - DEFAULT_BUDGET_CHARS) < DEFAULT_BUDGET_CHARS * 0.1,
  `${wholeResponseChars} against ${DEFAULT_BUDGET_CHARS} is not a boundary case — recapture the ` +
    'fixture, or the sections below are measuring a payload nothing like the one the ticket met'
);

// THE UNAMBIGUOUS RED, and it is the route the ticket's own agent actually used
// to try to read its own ticket. `atlassian_get_issue` returns Jira's ADF, which
// is roughly four times the size of the prose in it: 32,405 characters here
// against a 9,000 budget. There is no boundary to argue about.
const asRead = fitGenericResponse(
  {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    via: { tool: 'atlassian_get_issue', method: 'GET', path: '/rest/api/3/issue/KAN-623?fields=description' },
    body: { key: 'KAN-623', fields: fixture.fields }
  },
  {
    budgetChars: DEFAULT_BUDGET_CHARS,
    tool: 'atlassian_get_issue',
    recoveryFor: (p) => genericRecovery('atlassian_get_issue', p)
  }
);
console.log(`   as a raw issue read: ${asRead.completeness.unclippedChars ?? '?'} chars -> ${asRead.completeness.kind}\n`);
check(
  'the ordinary issue read IS over budget, unambiguously — this is the route the defect was met on',
  asRead.completeness.kind === 'clipped' &&
    asRead.completeness.unclippedChars > DEFAULT_BUDGET_CHARS,
  `verdict ${asRead.completeness.kind} — this fixture cannot demonstrate the defect`
);
check(
  'and it returns NONE of the description — the defect, stated as a measurement',
  typeof asRead.payload.body?.fields?.description !== 'object' ||
    asRead.payload.body.fields.omitted === 'for-budget' ||
    asRead.payload.body.fields.description === undefined,
  'the issue read returned the description, so there is nothing here to fix'
);
check(
  'and the margin is the envelope rather than the prose — the text alone WOULD have fitted',
  JSON.stringify({ text: wholeText }).length < DEFAULT_BUDGET_CHARS,
  'the text alone is over budget too, so this fixture is not the boundary case the ticket measured'
);

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE BUILD ASKS FOR THE ONE FIELD, AND REFUSES WHAT IT CANNOT ANSWER');

const built = op.build({ issueKey: 'KAN-623' });
console.log(`   path:               ${built.path}\n`);
check(
  'the path asks Jira for the description field',
  typeof built.path === 'string' && built.path.includes('fields=description'),
  built.path
);
check(
  'a bad issue key is refused rather than concatenated into a path',
  'error' in op.build({ issueKey: '../../etc/passwd' }),
  'a non-key reached the path builder'
);
const badFormat = op.build({ issueKey: 'KAN-623', descriptionFormat: 'ADF' });
check(
  "a descriptionFormat the operation does not accept is REFUSED, never quietly defaulted",
  'error' in badFormat,
  'a mistyped format silently became text — the caller would page a rendering it did not ask for'
);

// ───────────────────────────────────────────────────────────────────────────
rule('2. THE GREEN — the description comes back, whole, at the DEFAULT budget');

const firstPage = callAndFit({ issueKey: fixture.key }, DEFAULT_BUDGET_CHARS);
console.log(`   page 1 returned:    ${firstPage.body.text.length} of ${firstPage.body.total} chars`);
console.log(`   verdict:            ${firstPage.fitted.completeness.kind}\n`);

check(
  'a first page carries actual text, not a stub',
  typeof firstPage.body.text === 'string' && firstPage.body.text.length > 0,
  `got ${typeof firstPage.body.text}`
);
check(
  '`total` is the length of the WHOLE description, not of this window',
  firstPage.body.total === wholeText.length,
  `total ${firstPage.body.total}, whole text ${wholeText.length}`
);
check(
  'and this window is not the whole description, so a walk has somewhere to go',
  firstPage.body.startAt + firstPage.body.text.length < firstPage.body.total,
  `startAt ${firstPage.body.startAt} + ${firstPage.body.text.length} vs total ${firstPage.body.total}`
);
check(
  '⚠ no `returned` and no `isLast` are sent — a count fixed before the budget runs can lie',
  firstPage.body.returned === undefined && firstPage.body.isLast === undefined,
  `the response carries ${JSON.stringify(Object.keys(firstPage.body))} — a field the budget ` +
    'can invalidate is back, and a caller paging by it would silently skip text'
);

const walked = walk(DEFAULT_BUDGET_CHARS);
console.log(`   walked:             ${walked.pages} page(s), ${walked.text.length} chars\n`);
check(
  'walking startAt to the end reassembles the description EXACTLY',
  walked.text === wholeText,
  `reassembled ${walked.text.length} chars of ${wholeText.length}; first difference at ` +
    `${[...wholeText].findIndex((c, i) => walked.text[i] !== c)}`
);
check(
  'the walk terminated rather than running away',
  !walked.ranAway && !walked.stalled,
  walked.ranAway ? 'hit the 500-page guard' : 'a page came back empty, stranding the walk'
);

// ───────────────────────────────────────────────────────────────────────────
rule('3. THE CURSOR SURVIVES THE CLIP THAT SHORTENS THE TEXT');

// The case this ticket is one turn deeper than: a pager whose own cursor can be
// clipped away is a pager that strands its reader. Asked for a window far larger
// than the budget can carry, so the fitter MUST shorten it.
const squeezed = callAndFit({ issueKey: fixture.key, maxResults: PROXY_DESCRIPTION_MAX_CHARS }, 3_000);
console.log(`   asked for:          ${PROXY_DESCRIPTION_MAX_CHARS} chars at a 3,000 budget`);
console.log(`   returned:           ${typeof squeezed.body.text === 'string' ? squeezed.body.text.length : '(stub)'} chars`);
console.log(`   verdict:            ${squeezed.fitted.completeness.kind}\n`);

check(
  'the text came back SHORT rather than omitted',
  typeof squeezed.body.text === 'string' && squeezed.body.text.length > 0,
  `text is ${typeof squeezed.body.text} — the reader got a stub where a window would do`
);
check(
  'every cursor field survived the clip: total, startAt, maxResults',
  ['total', 'startAt', 'maxResults'].every((f) => typeof squeezed.body[f] === 'number'),
  JSON.stringify(Object.keys(squeezed.body))
);
check(
  'and `total` still describes the WHOLE description rather than the window that survived',
  squeezed.body.total === wholeText.length,
  `total ${squeezed.body.total}, whole ${wholeText.length}`
);
check(
  'and the clip is disclosed as text-windowed, counted in characters',
  squeezed.fitted.completeness.kind === 'clipped' &&
    squeezed.fitted.completeness.clipped.some(
      (c) => c.reduction === 'text-windowed' && c.returned + c.omitted === c.total
    ),
  JSON.stringify(squeezed.fitted.completeness.clipped ?? null)
);

// ───────────────────────────────────────────────────────────────────────────
rule('4. THE ANTI-CLIFF — the same walk at a budget FAR BELOW the default');

// A fix that works by having more room fails here, which is the point. The
// handle is the one KAN-656 hands its agent: `budgetFromEnv()` has a floor and
// no ceiling, so the over-budget case can be manufactured at any margin.
const tightWalk = walk(MIN_BUDGET_CHARS, PROXY_DESCRIPTION_MAX_CHARS);
console.log(`   budget:             ${MIN_BUDGET_CHARS} chars (MIN_BUDGET_CHARS)`);
console.log(`   walked:             ${tightWalk.pages} page(s), ${tightWalk.text.length} chars\n`);

check(
  'the description is STILL reachable in full at the minimum budget',
  tightWalk.text === wholeText,
  tightWalk.stalled
    ? 'a page came back empty — the reader is stranded, which is this ticket rebuilt'
    : `reassembled ${tightWalk.text.length} of ${wholeText.length}`
);
check(
  'and it took more pages to do it, rather than more room',
  tightWalk.pages > walked.pages,
  `${tightWalk.pages} pages at the floor vs ${walked.pages} at the default`
);

// ───────────────────────────────────────────────────────────────────────────
rule('5. A CLIPPED DESCRIPTION NOW PRINTS A CALL, WHERE IT PRINTED noWayBack');

// The `atlassian_get_issue` route is unchanged and still cannot return an
// over-budget description — the fitter descends one level and a description sits
// three down. What changed is that its stub names the route out.
const issueRead = fitGenericResponse(
  {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    via: { tool: 'atlassian_get_issue', method: 'GET', path: '/rest/api/3/issue/KAN-623?fields=description' },
    body: { key: 'KAN-623', fields: { description: fixture.fields.description } }
  },
  {
    budgetChars: DEFAULT_BUDGET_CHARS,
    tool: 'atlassian_get_issue',
    recoveryFor: (p) => genericRecovery('atlassian_get_issue', p, 'KAN-623')
  }
);
const stub = issueRead.payload.body?.fields;
console.log(`   readWith:           ${stub?.readWith ?? '(none)'}`);
console.log(`   noWayBack:          ${stub?.noWayBack ? stub.noWayBack.slice(0, 70) + '…' : '(none)'}\n`);

check(
  'the ordinary issue read still cannot return it — this rung was never the fix',
  typeof stub?.omitted === 'string' && stub.omitted === 'for-budget',
  'the description fitted, so this section is measuring nothing'
);
check(
  'and its stub carries a readWith rather than a noWayBack',
  typeof stub?.readWith === 'string' && !stub.noWayBack,
  stub?.noWayBack ?? '(no recipe at all)'
);
check(
  'the recipe names the pager and the issue it was actually asked about',
  typeof stub?.readWith === 'string' &&
    stub.readWith.startsWith(`${TOOL}(`) &&
    stub.readWith.includes("issueKey: 'KAN-623'"),
  stub?.readWith
);
// ⚠ THE RECIPE MUST KEEP THE READER'S PLACE, and this assertion exists because
// its absence was measured. A mutation making `descriptionRecovery` always
// print `startAt: 0` left every other check in this file GREEN — the walk
// happened to use only the recipe's `maxResults`, so nothing here could see the
// offset being thrown away. A recipe that always restarts is executable, looks
// correct, and sends a reader who is 6,000 characters in back to the beginning
// to fail the same way forever. Caught by the red drive, not by review.
const deepCall = fitGenericResponse(
  {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    via: { tool: TOOL, method: 'GET', path: '/rest/api/3/issue/KAN-623?fields=description' },
    body: {
      total: wholeText.length,
      startAt: 6000,
      maxResults: 4000,
      descriptionFormat: 'text',
      key: 'KAN-623',
      text: wholeText.slice(6000)
    }
  },
  {
    budgetChars: 1_500,
    tool: TOOL,
    recoveryFor: (p) => genericRecovery(TOOL, p, { issueKey: 'KAN-623', startAt: 6000, maxResults: 4000 })
  }
);
const deepRecipe =
  findRecipe(deepCall.payload.body) ?? clipRecordFor(deepCall, 'body.text')?.readTheRest ?? null;
console.log(`   deep recipe:        ${deepRecipe ?? '(none)'}\n`);
check(
  "a recipe printed mid-walk keeps the reader's place rather than restarting at 0",
  typeof deepRecipe === 'string' && parseRecipe(deepRecipe)?.startAt === 6000,
  `recipe says startAt ${parseRecipe(deepRecipe ?? '')?.startAt} for a call at 6000 — a reader ` +
    'following it would restart and loop'
);
check(
  'and it narrows the window rather than repeating the one that just failed',
  typeof deepRecipe === 'string' && (parseRecipe(deepRecipe)?.maxResults ?? 4000) < 4000,
  `recipe repeats maxResults ${parseRecipe(deepRecipe ?? '')?.maxResults} — following it changes nothing`
);

// A recipe is only worth printing if it can be typed. Executed, not read.
const recipeArgs = { issueKey: 'KAN-623', startAt: 0 };
const executed = callAndFit(recipeArgs, DEFAULT_BUDGET_CHARS);
check(
  'and the recipe EXECUTES — run verbatim, it returns description text',
  typeof executed.body?.text === 'string' && executed.body.text.length > 0 &&
    wholeText.startsWith(executed.body.text),
  'the printed call did not return the start of the description'
);

check(
  'a key that is not a key gets NO recipe rather than a broken one',
  ["KAN-1' }); evil('", 'not-a-key', '', '../../etc/passwd'].every(
    (k) => genericRecovery('atlassian_get_issue', 'body.fields', { issueKey: k }).kind === 'none'
  ),
  'an unvalidated key reached a printed recipe — a quote or a brace in it produces a call ' +
    'that cannot be typed, which is the defect this whole module exists to end'
);

// ───────────────────────────────────────────────────────────────────────────
rule('6. THE ANTI-GOAL — no budget was raised to achieve any of the above');

console.log(`   DEFAULT_BUDGET_CHARS:      ${DEFAULT_BUDGET_CHARS}`);
console.log(`   MEASURED_CLIENT_CAP_CHARS: ${MEASURED_CLIENT_CAP_CHARS}\n`);
check(
  'DEFAULT_BUDGET_CHARS is still 9,000',
  DEFAULT_BUDGET_CHARS === 9_000,
  `it is ${DEFAULT_BUDGET_CHARS} — this ticket asked that a field be REACHABLE, not that the budget grow`
);
check(
  'MEASURED_CLIENT_CAP_CHARS is still 10,000, and the headroom below it survives',
  MEASURED_CLIENT_CAP_CHARS === 10_000 && DEFAULT_BUDGET_CHARS < MEASURED_CLIENT_CAP_CHARS,
  `cap ${MEASURED_CLIENT_CAP_CHARS}, budget ${DEFAULT_BUDGET_CHARS}`
);
check(
  'and a page of this operation is capped well inside the budget',
  PROXY_DESCRIPTION_MAX_CHARS < DEFAULT_BUDGET_CHARS,
  `${PROXY_DESCRIPTION_MAX_CHARS} against ${DEFAULT_BUDGET_CHARS}`
);

// ───────────────────────────────────────────────────────────────────────────
rule('7. AN EMPTY DESCRIPTION IS NOT A CLIPPED ONE');

const emptyBody = op.transform([{ key: 'KAN-1', fields: { description: null } }], {}, { issueKey: 'KAN-1' });
console.log(`   total:              ${emptyBody.total}`);
console.log(`   text:               ${JSON.stringify(emptyBody.text)}`);
console.log(`   unrendered:         ${JSON.stringify(emptyBody.textUnrenderedNodes ?? null)}\n`);
check(
  'a ticket with no description answers total: 0 — a real answer, not a failure to read it',
  emptyBody.total === 0 && emptyBody.text === '' && emptyBody.startAt === 0,
  JSON.stringify(emptyBody)
);
check(
  'and it is NOT reported as an unrenderable document',
  emptyBody.textUnrenderedNodes === undefined,
  `renderer complained about an absent description: ${JSON.stringify(emptyBody.textUnrenderedNodes)}`
);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(76)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('═'.repeat(76));
process.exit(failures ? 1 : 0);
