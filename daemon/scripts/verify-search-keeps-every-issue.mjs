// Proof for KAN-522: a search that exceeds the response budget comes back with
// issues in it, and never with none of them.
//
// WHAT FAILURE THIS WOULD CATCH: `atlassian_search_issues` answering a search
// that found issues with zero issues, and no ceiling stated anywhere. Measured
// on the fleet's daemon on 2026-08-18, `project = KAN ORDER BY created DESC`
// with `fields=summary` — already the narrowest useful projection — and
// `maxResults=30`:
//
//     body.issues: { omitted: "for-budget", total: 30, chars: 13615 }
//
// Thirty issues found, none said. On this operation's DEFAULT fields it is
// worse: one raw row measures ~2,600 characters against a 9,000 budget, of
// which roughly 120 carry information a reader steers by, so the answer is
// spent before the fourth issue. `epic/KAN-203` found that ceiling by bisecting
// one call at a time, got to six results on a board of forty-seven, and
// correctly declined to file a ticket on a search it could not claim was whole.
// That is search-before-filing — a standing rule on this board, which exists
// because duplicates have actually been filed here — degrading through a
// surface that reported itself as working.
//
// Two mechanisms have to hold for that not to recur, and this checks both
// because either alone leaves the cliff standing:
//
//   §2-§3  the operation's transform condenses a row to its identity, so far
//          more issues fit;
//   §4     the response budget TRIMS a list it cannot fit instead of deleting
//          it, so the answer degrades one entry at a time rather than going
//          from forty rows to none at the boundary.
//
// CI-RUNNABLE: yes — imports the built modules in process and reads one
// captured fixture; no live daemon, no herdr, no credential, no peer, no
// terminal, no network.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
// ---------------------------------------------------------------------------
// Real: `fitGenericResponse` and `genericRecovery` as built, and the transform
// this ticket adds, reached through `operationByTool('atlassian_search_issues')`
// — the same object the MCP server advertises and dispatches from, so what is
// tested is what runs rather than a second copy of it.
//
// Real: the per-issue SHAPE. `fixtures/kan-522-search-page.json` is a live
// `atlassian_search_issues` page captured from the fleet daemon on 2026-08-18
// at this operation's default fields, pasted verbatim.
//
// ⚠ SUPPLIED BY THIS SCRIPT, AND NAMED HERE BECAUSE KAN-145 IS WHAT HAPPENS
// WHEN IT IS NOT: the NUMBER of issues. Sections 3 and 4 replicate the
// fixture's two real rows up to a page size large enough to clip. They have to:
// the live proxy replaces the array before thirty rows can be observed, which
// is the defect, so a real thirty-row page is not capturable until this lands.
// What that leaves uncovered is therefore the arrival leg — that a real Jira
// page of that size reaches this transform at all — and NOTHING HERE COVERS IT.
// Who does: an observation of the running daemon after this merges, pasted into
// the PR beside the before-measurement above. Not another script.
//
// Also not covered: whether the same ceiling applies to `atlassian_search`,
// `atlassian_search_confluence_cql` or `atlassian_get_confluence_space_pages`.
// KAN-522 states that nobody has measured them, and this script does not
// either — §4's rung is generic and helps them, but a rung firing is not a
// measurement of their envelope.
//
// Usage: node daemon/scripts/verify-search-keeps-every-issue.mjs [--verbose]

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

const { fitGenericResponse, DEFAULT_BUDGET_CHARS } = await import('../dist/mcp-response-budget.js');
const { genericRecovery } = await import('../dist/mcp-recovery.js');
const { operationByTool, SEARCH_CONDENSED_AWAY } = await import('../dist/atlassian-proxy.js');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) {
    console.log(`         ${String(detail).split('\n').slice(0, 12).join('\n         ')}`);
  }
}

const TOOL = 'atlassian_search_issues';
const operation = operationByTool(TOOL);

const fixture = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'kan-522-search-page.json'), 'utf8')
);
const REAL_ROWS = fixture.body.issues;

const size = (v) => JSON.stringify(v, null, 2).length;

/** A page of `n` issues, built from the fixture's real rows with unique keys. */
function pageOf(n) {
  const issues = [];
  for (let i = 0; i < n; i += 1) {
    const row = JSON.parse(JSON.stringify(REAL_ROWS[i % REAL_ROWS.length]));
    row.key = `KAN-${900 + i}`;
    row.id = String(20000 + i);
    issues.push(row);
  }
  return { ...JSON.parse(JSON.stringify(fixture.body)), issues };
}

/** What the MCP gate does to a proxy answer, using the real fitter and recovery. */
function throughBudget(body) {
  return fitGenericResponse(
    { action: 'atlassian_proxy_call_response', success: true, status: 200, body, via: { tool: TOOL } },
    { tool: TOOL, recoveryFor: (p) => genericRecovery(TOOL, p) }
  );
}

const run = (body, args) => operation.transform([body], {}, args ?? {});

/** Every key appearing anywhere in a value, at any depth. */
function keysDeep(value, into = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------
rule('§0  The fixture is still the size the live payload was');
// The stand-in for a big page is the real row replicated, so this section is
// what makes §1, §4, §4b and §5 claims about Jira rather than about a JSON file
// that has drifted. A row that shrank would make the ceiling look further away
// than it is, and every one of those sections would go on passing.
// ---------------------------------------------------------------------------
{
  check('the operation exists and carries a transform', typeof operation?.transform === 'function', operation ? 'transform missing' : 'no such operation');

  const perRow = REAL_ROWS.map(size);
  check(
    `a raw default-fields row is ~2,600 chars (measured: ${perRow.join(', ')})`,
    perRow.every((n) => n > 2000 && n < 3400),
    `rows measured ${perRow.join(', ')}; the header quotes ~2,600`
  );
  check(
    'the fixture carries the endpoint that has no `total`',
    !('total' in fixture.body) && 'isLast' in fixture.body,
    `keys: ${Object.keys(fixture.body).join(', ')}`
  );
}

// ---------------------------------------------------------------------------
rule('§1  POSITIVE CONTROL: the pressure is real, and raw rows are what spend it');
// Without this the sections below could be green because nothing was ever over
// budget — a check that cannot be reached is not a check. This is also the
// arithmetic the ticket is about, stated as an assertion rather than as prose.
// ---------------------------------------------------------------------------
{
  const raw12 = throughBudget(pageOf(12));
  check(
    `12 RAW rows exceed the ${DEFAULT_BUDGET_CHARS}-char budget (unclipped ${raw12.completeness.unclippedChars ?? size(pageOf(12))})`,
    raw12.completeness.kind === 'clipped',
    `verdict ${raw12.completeness.kind}`
  );

  const raw4 = throughBudget(pageOf(4));
  check(
    'even 4 RAW rows exceed it — the undocumented ceiling was about three',
    raw4.completeness.kind === 'clipped',
    `verdict ${raw4.completeness.kind}, chars ${raw4.completeness.chars}`
  );
}

// ---------------------------------------------------------------------------
rule('§2  The transform keeps every issue and says less about each');
// ---------------------------------------------------------------------------
{
  const out = run(fixture.body);

  check('every issue survives condensing', out.issues.length === REAL_ROWS.length, `${out.issues.length} of ${REAL_ROWS.length}`);
  check('`found` states how many the search found', out.found === REAL_ROWS.length, JSON.stringify(out.found));
  check('`total` is null rather than absent — this endpoint sends none', 'total' in out && out.total === null, JSON.stringify(out.total));
  check('`isLast` survives, and is what the dropped page token was read for', out.isLast === false, JSON.stringify(out.isLast));
  check('`nextPageToken` is gone — no call on this server takes one', !('nextPageToken' in out), Object.keys(out).join(', '));

  const first = out.issues[0];
  check('the key is at the top of the row', first.key === REAL_ROWS[0].key, JSON.stringify(first.key));
  check('`status` collapses to its name', first.fields.status === 'In Progress', JSON.stringify(first.fields.status));
  check('`issuetype` collapses to its name', first.fields.issuetype === 'Task', JSON.stringify(first.fields.issuetype));
  check('`assignee` collapses to its display name', first.fields.assignee === 'Wroos Bit', JSON.stringify(first.fields.assignee));
  check(
    'the summary is carried whole — condensing gives up envelope, never content',
    first.fields.summary === REAL_ROWS[0].fields.summary,
    first.fields.summary
  );

  const present = keysDeep(out.issues);
  const leaked = SEARCH_CONDENSED_AWAY.filter((k) => present.has(k));
  check(`no handle this proxy cannot be given back survives (${SEARCH_CONDENSED_AWAY.join(', ')})`, leaked.length === 0, `leaked: ${leaked.join(', ')}`);
  check(
    '`condensedAway` names them in the answer, not only in a comment',
    Array.isArray(out.condensedAway) && out.condensedAway.length === SEARCH_CONDENSED_AWAY.length,
    JSON.stringify(out.condensedAway)
  );

  const before = size(fixture.body.issues);
  const after = size(out.issues);
  check(
    `a row shrinks by at least 8x (${Math.round(before / REAL_ROWS.length)} -> ${Math.round(after / REAL_ROWS.length)} chars)`,
    before / after >= 8,
    `${before} -> ${after}`
  );
}

// ---------------------------------------------------------------------------
rule('§3  The escape hatch is real, and an unknown shape comes back whole');
// The transform docblock claims both. A claim in a comment that no check reads
// is the gap KAN-145 was about, one artifact over.
// ---------------------------------------------------------------------------
{
  const raw = run(fixture.body, { issueFormat: 'raw' });
  check(
    "`issueFormat: 'raw'` returns Atlassian's page byte for byte",
    JSON.stringify(raw) === JSON.stringify(fixture.body),
    'the raw arm reshaped something'
  );

  const refusal = operation.build({ jql: 'project = KAN', issueFormat: 'RAW' });
  check('a mistyped format is refused rather than silently condensed', typeof refusal?.error === 'string', JSON.stringify(refusal));

  // The renderer's default is to keep. A field shape it has no rule for — no
  // `self`, no identity key, not ADF — must survive rather than be dropped,
  // which is what makes "nothing else is given up" a checkable sentence.
  const odd = JSON.parse(JSON.stringify(fixture.body));
  odd.issues = [odd.issues[0]];
  odd.issues[0].fields.customfield_10999 = { weird: { nested: [1, 2, 'three'] }, flag: true };
  const kept = run(odd).issues[0].fields.customfield_10999;
  check(
    'a shape the renderer has no rule for comes back whole',
    JSON.stringify(kept) === JSON.stringify({ weird: { nested: [1, 2, 'three'] }, flag: true }),
    JSON.stringify(kept)
  );

  // `issuelinks` is the shape the merge-governance lookup reads, and it has no
  // identity key at its own level — so it exercises the walk rather than the
  // collapse, and its two endpoints exercise the collapse inside the walk.
  const linked = JSON.parse(JSON.stringify(fixture.body));
  linked.issues = [linked.issues[0]];
  linked.issues[0].fields.issuelinks = [
    {
      id: '10416',
      self: 'https://api.atlassian.com/ex/jira/x/rest/api/3/issueLink/10416',
      type: { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to', self: 'https://api.atlassian.com/ex/jira/x/rest/api/3/issueLinkType/10003' },
      outwardIssue: { id: '10512', key: 'KAN-501', self: 'https://api.atlassian.com/ex/jira/x/rest/api/3/issue/10512', fields: { summary: 'a long summary nobody needs here' } }
    }
  ];
  const link = run(linked).issues[0].fields.issuelinks[0];
  check('a link keeps its relation', link.type === 'Relates', JSON.stringify(link.type));
  check('a link keeps the issue it points at', link.outwardIssue === 'KAN-501', JSON.stringify(link.outwardIssue));
}

// ---------------------------------------------------------------------------
rule('§4  THE RED DRIVE: a page too big to fit comes back with issues in it');
// This is acceptance criterion 3. It fails if a search large enough to clip
// loses an entry that summarising would have kept — and, at the boundary the
// condensing cannot move, if the budget deletes the list instead of trimming it.
// ---------------------------------------------------------------------------
{
  // Big enough that condensed rows still overflow: the point is to exercise the
  // trimming rung, not to prove condensing alone is always enough.
  const PAGE = 60;
  const condensed = run(pageOf(PAGE));

  // ⚠ ACCEPTANCE CRITERION 3, STATED DIRECTLY: the transform may say less about
  // an issue and may not drop one. Asserted against the transform's own output
  // rather than only against the fitted answer, so that a transform which
  // quietly truncated fires HERE — where the message names the mechanism —
  // instead of surfacing three checks later as "the answer got small".
  check(
    `the transform names every issue it was given (${condensed.issues.length} of ${PAGE})`,
    condensed.issues.length === PAGE && condensed.found === PAGE,
    `issues ${condensed.issues.length}, found ${condensed.found}, given ${PAGE}`
  );
  check(
    `condensed, ${PAGE} of this board's rows still exceed the budget — the rung is reached`,
    size(condensed) > DEFAULT_BUDGET_CHARS,
    `${size(condensed)} chars`
  );

  const fitted = throughBudget(condensed);
  const body = fitted.payload.body;

  check('the answer is declared not-whole', fitted.completeness.kind === 'clipped', fitted.completeness.kind);
  check('it is within budget', fitted.text.length <= DEFAULT_BUDGET_CHARS, `${fitted.text.length} chars`);

  // ⚠ THE ASSERTION THIS SCRIPT EXISTS FOR.
  check(
    'ISSUES CAME BACK — the list was trimmed, not deleted',
    Array.isArray(body.issues) && body.issues.length > 0,
    `body.issues is ${Array.isArray(body.issues) ? `an array of ${body.issues.length}` : JSON.stringify(body.issues)}`
  );

  const record = fitted.completeness.clipped.find((c) => c.field === 'body.issues');
  check('the clip is named against the list it happened to', Boolean(record), JSON.stringify(fitted.completeness.clipped?.map((c) => c.field)));
  if (record) {
    check(
      `the arithmetic is exact: ${record.returned} + ${record.omitted} === ${record.total}`,
      record.returned + record.omitted === record.total && record.total === PAGE,
      JSON.stringify(record)
    );
    check('and it reports entries lost, not a section deleted', record.reduction === 'entries-omitted', record.reduction);
    check('every entry it kept is a real row', body.issues.length === record.returned, `${body.issues.length} vs ${record.returned}`);
  }

  // The envelope is the half that makes a bounded search tellable from a whole
  // one in one step — acceptance criterion 2. It is scalars beside the list
  // rather than inside it precisely so a clip cannot reach it.
  check('`found` survives the clip', body.found === PAGE, JSON.stringify(body.found));
  check('`total` survives the clip', 'total' in body, JSON.stringify(Object.keys(body)));
  check('`isLast` survives the clip', body.isLast === false, JSON.stringify(body.isLast));
  check(
    'ONE COMPARISON SAYS IT WAS BOUNDED: `issues.length < found`',
    body.issues.length < body.found,
    `${body.issues.length} vs ${body.found}`
  );

  // The ceiling is no longer something you find by bisection.
  const described = String(operation.description);
  check('the tool description states the ceiling and names it as one', /budget/i.test(described) && /2,600|ceiling/i.test(described), described.slice(0, 160));
  check('and tells a reader which fields say whether the page is the board', described.includes('isLast') && described.includes('found'), described.slice(0, 160));
}

// ---------------------------------------------------------------------------
rule('§4b  WHERE ZERO IS THE ONLY PREFIX THAT FITS, THE ANSWER SAYS SO');
// ---------------------------------------------------------------------------
// ⚠ THIS SECTION EXISTS BECAUSE THE RED DRIVE FOUND §4 COULD NOT FAIL ON IT.
// `red-drive-kan522.sh` arm 4 relaxes the trim to allow an empty prefix, and §4
// stayed green through it — §4's page has 21 rows that fit, so its "not empty"
// assertion was re-stating the assertion above it and the `keep === 0` branch
// was never reached. That is `prompts/task.md`'s sharpest case exactly: a check
// that could only ever return the answer it was hoping for is not a weak check,
// it is a check that does not exist while appearing to.
//
// So this drives that branch directly, with one entry too large to fit by
// itself. `issues: []` would be inside budget, well-formed, honestly numbered —
// and would read as a search that found nothing, which is KAN-423's defect
// rebuilt inside the fix for KAN-522. The stub is what the answer must be.
{
  const single = pageOf(1);
  single.issues[0].fields.summary = 'x'.repeat(DEFAULT_BUDGET_CHARS * 2);
  const condensed = run(single);
  check('one entry alone exceeds the budget — the branch is reached', size(condensed.issues) > DEFAULT_BUDGET_CHARS, `${size(condensed.issues)} chars`);

  const body = throughBudget(condensed).payload.body;
  check(
    '⚠ NOT an empty array — that reads as a search that found nothing',
    !(Array.isArray(body.issues) && body.issues.length === 0),
    `body.issues is ${JSON.stringify(body.issues).slice(0, 120)}`
  );
  check(
    'the stub says the field exists and was not sent',
    !Array.isArray(body.issues) && body.issues?.omitted === 'for-budget',
    JSON.stringify(body.issues)?.slice(0, 200)
  );
  check(
    'and it says there is no way back rather than printing a call that cannot be typed',
    typeof body.issues?.noWayBack === 'string' && !('readWith' in (body.issues ?? {})),
    JSON.stringify(body.issues)?.slice(0, 200)
  );
  check('`found` still says one issue was found', body.found === 1, JSON.stringify(body.found));
}

// ---------------------------------------------------------------------------
rule('§5  A list small enough to fit is not touched');
// The rung must be a ceiling, not a reformatter — the same property the MCP
// gate keeps by returning small answers exactly as their tool wrote them.
// ---------------------------------------------------------------------------
{
  const small = throughBudget(run(pageOf(3)));
  check('a small search is declared whole', small.completeness.kind === 'complete', small.completeness.kind);
  check('with every issue in it', small.payload.body.issues.length === 3, JSON.stringify(small.payload.body.issues?.length));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
