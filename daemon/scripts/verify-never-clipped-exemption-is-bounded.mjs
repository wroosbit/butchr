// Proof for KAN-525: an exempt field is bounded, or it is a disclosure field
// that is windowed rather than omitted — and no answer claims to be whole while
// it is over budget.
//
// WHAT FAILURE THIS WOULD CATCH: `NEVER_CLIPPED` exempting a field by NAME while
// nothing checked the SHAPE of the value that name carries. The exemption is
// honoured at every rung of both fitters, so an exempt field was irreducible
// everywhere; what made that safe was that every exempt name happened to be
// small at every site producing it, and the name and the shape were connected by
// nothing at all. Two instances were measured on `origin/main`'s build
// (795ae89) on 2026-08-18, both live rather than hypothetical:
//
//   * `via` on an `atlassian_search` envelope measured **5,335 characters**.
//     `via.path` is the audit path and the audit path carries the CALLER'S OWN
//     QUERY — `freeText` accepts 2,000 characters and `encodeURIComponent`
//     expands them. At the default 9,000 budget that irreducible field forced
//     `body` — the entire answer — to be given up so the caller's own question
//     could be echoed back at it. At `MIN_BUDGET_CHARS` the answer came to 6,330
//     characters against 1,000 with no lever left at all, which is the state the
//     ticket describes as "there would be no lever left" reached in practice.
//   * A census carrying 300 `missingAgents` measured **73,312 characters against
//     a 9,000 budget with `completeness.kind === 'complete'`** — the verdict
//     asserting "WHOLE: every field is present and every list entire" on an
//     answer 8x over budget, which the client then cuts. That is KAN-423's own
//     defect rebuilt inside the fix for it. `censusUnreadableRecords` measured
//     ~730 characters PER ENTRY on this machine the same day, so thirteen of
//     them do the same thing without anybody adding a field.
//
// Both are section 3 and section 4 below, run against the fixed build.
//
// CI-RUNNABLE: yes — imports the built module in process and reads one source
// file as text. No live daemon, no herdr, no credential, no peer, no terminal,
// no network.
//
// ---------------------------------------------------------------------------
// WHAT IT SUPPLIES ITSELF, AND WHO COVERS THE REST — read before citing this
// ---------------------------------------------------------------------------
// KAN-145's rule applies to sections 1-5 and it is the honest limit of them:
// **this script constructs every response it asserts on.** It proves that the
// FITTER does the right thing when handed an exempt field of a given shape. It
// proves NOTHING about whether any real tool on this server ever produces such a
// shape, because no tool is called here.
//
// Who covers that, named rather than left to be inferred:
//
//   * The gate itself, and this is the part a fixture-based check could never
//     do: the demotion runs inside `fitGenericResponse`, which every tool answer
//     on this server passes through (`boundToBudget` in `mcp.ts`). So the
//     boundedness of an exempt field is enforced at runtime on every tool,
//     including tools nobody has written yet. There is no producing-site list to
//     keep up to date, which is why there is not one.
//   * Section 6 is the exception to the paragraph above: it supplies no input.
//     It reads `daemon/src/mcp-response-budget.ts` off the checkout and asserts
//     that no rung is still asking `NEVER_CLIPPED.includes(...)` — the guard
//     that answers a question about the LIST rather than about the VALUE. That
//     is the regression this whole ticket is about, and it is static.
//   * NOT covered by anything here: whether a given exempt name's declared
//     `maxChars` is the right number. A ceiling too high is a real exemption
//     that never demotes, and this script would stay green. What bounds that is
//     the `why` on each registry entry naming the value it was measured from,
//     which is a reviewer's instrument and not a script's.

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

const {
  fitGenericResponse,
  fitListAgentsResponse,
  NEVER_CLIPPED,
  NEVER_CLIPPED_FIELDS,
  DISCLOSURE_WINDOWED_FIELDS,
  exemptionHolds,
  DEFAULT_BUDGET_CHARS,
  MIN_BUDGET_CHARS
} = await import('../dist/mcp-response-budget.js');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if ((!ok || verbose) && detail) {
    console.log(`         ${String(detail).split('\n').slice(0, 14).join('\n         ')}`);
  }
}

/** Every clip record on a fitted answer, or `[]` when the verdict is complete. */
const clipsOf = (fitted) => fitted.completeness.clipped ?? [];
const clipFor = (fitted, field) => clipsOf(fitted).find((c) => c.field === field);
const sizeOf = (v) => JSON.stringify(v, null, 2).length;

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE LIST AND THE REGISTRY CANNOT DRIFT, AND EVERY EXEMPTION HAS A REASON');

check(
  '`NEVER_CLIPPED` is derived from `NEVER_CLIPPED_FIELDS` rather than declared twice',
  NEVER_CLIPPED.length === Object.keys(NEVER_CLIPPED_FIELDS).length &&
    NEVER_CLIPPED.every((f) => f in NEVER_CLIPPED_FIELDS),
  `NEVER_CLIPPED=${NEVER_CLIPPED.join(', ')}\nregistry=${Object.keys(NEVER_CLIPPED_FIELDS).join(', ')}`
);

{
  const bad = Object.entries(NEVER_CLIPPED_FIELDS).filter(([, r]) =>
    r.kind === 'bounded'
      ? !(Number.isInteger(r.maxChars) && r.maxChars > 0) || typeof r.why !== 'string' || r.why.length < 40
      : !['never-reduced', 'windowed'].includes(r.whenOverBudget) ||
        typeof r.why !== 'string' ||
        r.why.length < 40
  );
  check(
    'every entry carries a bucket and a reason long enough to be one (15 entries read)',
    bad.length === 0,
    bad.map(([f, r]) => `${f}: ${JSON.stringify(r)}`).join('\n')
  );
}

{
  // The ceiling is per field and nothing static knows which exempt fields
  // co-occur — so this is the one arithmetic claim that IS sound: no single
  // bounded field may be declared large enough to eat half the smallest legal
  // budget on its own, because two such fields on one answer already spend it.
  const half = MIN_BUDGET_CHARS / 2;
  const oversized = Object.entries(NEVER_CLIPPED_FIELDS).filter(
    ([, r]) => r.kind === 'bounded' && r.maxChars > half
  );
  check(
    `no bounded ceiling exceeds MIN_BUDGET_CHARS/2 (${half})`,
    oversized.length === 0,
    oversized.map(([f, r]) => `${f}: maxChars=${r.maxChars}`).join('\n')
  );
}

check(
  '`DISCLOSURE_WINDOWED_FIELDS` is exactly the windowed disclosure entries',
  DISCLOSURE_WINDOWED_FIELDS.length === 3 &&
    ['censusUnreadableRecords', 'missingAgents', 'preemptedAgents'].every((f) =>
      DISCLOSURE_WINDOWED_FIELDS.includes(f)
    ),
  DISCLOSURE_WINDOWED_FIELDS.join(', ')
);

// ───────────────────────────────────────────────────────────────────────────
rule('2. POSITIVE CONTROL — THE EXEMPTION STILL DOES ITS JOB');
//
// Ordered before the red so that a demotion is read against a run where the
// exemption held, on the same shapes. A check that only ever shows the field
// going is a check that would pass if the exemption were deleted outright.

{
  // Every exempt name at its real, measured size, on an answer far over budget.
  const envelope = {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    outcome: 'serving',
    mode: 'confluence-write',
    available: true,
    whatAnEmptyToolListMeans: "both 'off' and 'unreachable' — read `outcome`, not your tool list",
    via: {
      tool: 'atlassian_get_issue',
      method: 'GET',
      path: '/rest/api/3/issue/KAN-525?fields=summary,description,status',
      products: ['jira'],
      servedBy: 'butchr-daemon'
    },
    body: { comments: Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'a comment '.repeat(9) })) }
  };
  const fitted = fitGenericResponse(envelope, { tool: 'atlassian_get_issue' });

  check(
    'an answer 10x over budget is reduced (the fixture actually exercises the fitter)',
    fitted.completeness.kind === 'clipped' && fitted.text.length <= DEFAULT_BUDGET_CHARS,
    `kind=${fitted.completeness.kind} chars=${fitted.text.length} budget=${DEFAULT_BUDGET_CHARS}`
  );

  const survived = [
    'action',
    'success',
    'status',
    'outcome',
    'mode',
    'available',
    'whatAnEmptyToolListMeans',
    'via'
  ].filter((f) => JSON.stringify(fitted.payload[f]) === JSON.stringify(envelope[f]));
  check(
    'every bounded exempt field inside its ceiling came back byte-identical (8/8)',
    survived.length === 8,
    `survived: ${survived.join(', ')}`
  );

  check(
    'and `body` — the one field NOT exempt — is what paid for it',
    clipFor(fitted, 'body') !== undefined || clipFor(fitted, 'body.comments') !== undefined,
    clipsOf(fitted).map((c) => `${c.field}/${c.reduction}`).join(', ')
  );

  check(
    'no clip record claims an exemption was revoked, because none was',
    clipsOf(fitted).every((c) => c.exemptionRevoked === undefined),
    JSON.stringify(clipsOf(fitted), null, 2)
  );
}

{
  // The boundary, which is what makes the demotion a discriminating test rather
  // than a size-independent one. `exemptionHolds` is asked directly here: at the
  // ceiling it holds, one character past it it does not.
  const ceiling = NEVER_CLIPPED_FIELDS.via.maxChars;
  const grow = (n) => ({ tool: 't', method: 'GET', path: 'x'.repeat(n), servedBy: 'butchr-daemon' });
  // Walk up one character at a time to the pair that straddles the ceiling,
  // rather than picking two numbers far apart: a test that compares 10 chars
  // against 10,000 would pass on any threshold whatever, including none.
  let atCeiling = grow(1);
  let justOver = null;
  for (let n = 1; n < 4000; n += 1) {
    const candidate = grow(n);
    if (sizeOf(candidate) > ceiling) {
      justOver = candidate;
      break;
    }
    atCeiling = candidate;
  }

  check(
    'the fixture actually straddles the ceiling (one character apart)',
    justOver !== null && sizeOf(atCeiling) <= ceiling && sizeOf(justOver) > ceiling,
    `atCeiling=${sizeOf(atCeiling)} justOver=${justOver && sizeOf(justOver)} ceiling=${ceiling}`
  );
  check(
    `exemptionHolds('via', …) is TRUE at ${sizeOf(atCeiling)} chars (ceiling ${ceiling})`,
    exemptionHolds('via', atCeiling) === true,
    `measured ${sizeOf(atCeiling)}`
  );
  check(
    `exemptionHolds('via', …) is FALSE at ${sizeOf(justOver)} chars — the boundary discriminates`,
    exemptionHolds('via', justOver) === false,
    `measured ${sizeOf(justOver)}`
  );
  check(
    'a name that is not on the list is not exempt at any size',
    exemptionHolds('toolsAdvertised', 'x') === false,
    'exemptionHolds returned true for an unregistered name'
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule("3. THE RED — AN EXEMPT NAME CARRYING A LIST IT IS NOT ENTITLED TO");
//
// The ticket's own example, and then the instance measured in the wild.

{
  // `available: [...]`. The ticket: "A future tool answering `available: [...]`
  // as a list — or any exempt name growing a collection — would be un-clippable
  // at every rung, and nothing would say so."
  const envelope = {
    action: 'some_future_tool_response',
    success: true,
    available: Array.from({ length: 300 }, (_, i) => `capability-${i}-with-a-descriptive-name`),
    body: { note: 'small' }
  };
  const unclipped = sizeOf(envelope);
  const fitted = fitGenericResponse(envelope, { tool: 'some_future_tool' });
  const record = clipFor(fitted, 'available');

  check(
    `\`available\` as a 300-entry list (${unclipped} chars unclipped) is REDUCED rather than exempt`,
    // `reduction !== 'irreducible'` is not belt-and-braces — it is the whole
    // assertion. Found by the red drive: with the exemption restored to
    // name-matching, `available` is still the largest field left, so section 5's
    // `irreducible` record names it and `clipFor(…, 'available')` comes back
    // DEFINED. Without this clause the check reads PASS on the exact defect it
    // exists to catch, and reports a reduction where nothing was reduced.
    record !== undefined && record.reduction !== 'irreducible',
    `clipped: ${clipsOf(fitted).map((c) => `${c.field}/${c.reduction}`).join(', ') || '(nothing)'}`
  );
  check(
    'and the answer says the exemption was revoked, with both numbers',
    record?.exemptionRevoked?.declaredMaxChars === NEVER_CLIPPED_FIELDS.available.maxChars &&
      record?.exemptionRevoked?.measuredChars === sizeOf(envelope.available),
    JSON.stringify(record, null, 2)
  );
  check(
    'and the answer now fits the budget, which is what having a lever means',
    fitted.text.length <= DEFAULT_BUDGET_CHARS,
    `${fitted.text.length} > ${DEFAULT_BUDGET_CHARS}`
  );
  check(
    '`success` — bounded and inside its ceiling — is untouched by the same pass',
    fitted.payload.success === true,
    JSON.stringify(fitted.payload.success)
  );
}

{
  // The wild instance: `via` on an `atlassian_search`, whose `path` carries the
  // caller's own CQL. Built exactly as `router.ts` builds it, through the same
  // 2,000-character `freeText` cap and the same `encodeURIComponent`.
  const cql = 'type=page AND text ~ "' + 'butchr '.repeat(280) + '"';
  const encoded = encodeURIComponent(cql);
  const auditPath =
    `/rest/api/3/search/jql?jql=text~${encoded}` +
    ' + ' +
    `/wiki/rest/api/search?cql=text~${encoded}&limit=50`;
  const envelope = {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    body: { results: Array.from({ length: 40 }, (_, i) => ({ id: i, title: 'a page '.repeat(6) })) },
    via: {
      tool: 'atlassian_search',
      method: 'GET',
      path: auditPath,
      products: ['jira', 'confluence'],
      servedBy: 'butchr-daemon'
    }
  };
  const viaChars = sizeOf(envelope.via);
  const fitted = fitGenericResponse(envelope, { tool: 'atlassian_search' });
  const record = clipFor(fitted, 'via');

  check(
    `a 2,000-char CQL puts \`via\` at ${viaChars} chars — the caller's own query, inside an exempt field`,
    viaChars > 4000,
    `measured ${viaChars}; the cap in atlassian-proxy.ts freeText() is 2000 pre-encoding`
  );
  check(
    '`via` loses its exemption and is given up',
    record !== undefined && record.exemptionRevoked !== undefined,
    JSON.stringify(record ?? clipsOf(fitted), null, 2)
  );
  check(
    'and `body` — the answer the caller actually asked for — SURVIVES, which it did not before',
    clipFor(fitted, 'body') === undefined && clipFor(fitted, 'body.results') === undefined,
    `clipped: ${clipsOf(fitted).map((c) => `${c.field}/${c.reduction}`).join(', ')}`
  );
  check(
    'the demoted field is given up WHOLE rather than descended into',
    record?.reduction === 'section-omitted',
    `reduction=${record?.reduction} — a member rung here would clip \`products\` (4 chars) and leave \`path\``
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('4. A DISCLOSURE FIELD IS WINDOWED, NEVER OMITTED — THE COUNT IS WHAT SURVIVES');

// NAMED HERE RATHER THAN TAKEN FROM `DISCLOSURE_WINDOWED_FIELDS`, and the red
// drive is why. Iterating the exported list means a mutation that REMOVES a
// field from it silently moves this section onto whatever is left — the run
// that found this was iterating `completeness` and asserting windowing on the
// verdict block. A check must not take its subject from the value under test.
// Section 1 is what asserts the export still equals these three.
const DISCLOSURE_LISTS = ['censusUnreadableRecords', 'missingAgents', 'preemptedAgents'];

for (const field of DISCLOSURE_LISTS) {
  const entries = Array.from({ length: 300 }, (_, i) => ({
    type: 'task',
    key: `KAN-${1000 + i}`,
    workspace: `/home/brooswit/.local/share/butchr/workspaces/task/kan-${1000 + i}`,
    because: 'the durable registry records this agent active and nothing is running in its pane'
  }));
  const census = { success: true, agents: [], agentsTotal: 0, [field]: entries };
  const raw = sizeOf(entries);
  const fitted = fitListAgentsResponse(census, {});
  const record = clipFor(fitted, field);

  check(
    `${field}: ${raw} chars of entries is reduced to fit (was ${sizeOf(census)} whole)`,
    fitted.text.length <= DEFAULT_BUDGET_CHARS,
    `${fitted.text.length} > ${DEFAULT_BUDGET_CHARS}`
  );
  check(
    `${field}: reduced by WINDOWING, not omission — the field is still a list`,
    record?.reduction === 'entries-omitted' && Array.isArray(fitted.payload[field]),
    `reduction=${record?.reduction} value=${JSON.stringify(fitted.payload[field])?.slice(0, 60)}`
  );
  check(
    `${field}: the count survives its own reduction (total=300, returned+omitted=300)`,
    record?.total === 300 && record.returned + record.omitted === 300 && record.returned > 0,
    JSON.stringify(record, null, 2)
  );
  check(
    `${field}: no \`omitted: 'for-budget'\` stub — a disclosure field is never replaced by one`,
    !(fitted.payload[field] && fitted.payload[field].omitted === 'for-budget'),
    JSON.stringify(fitted.payload[field])?.slice(0, 200)
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('5. NO ANSWER CLAIMS TO BE WHOLE WHILE IT IS OVER BUDGET');
//
// The collective case a per-field ceiling cannot reach: fields each inside their
// own ceiling that together do not fit. It is not prevented — it is made loud.

{
  // THE PURE CASE, AND IT IS THE ONE THAT MAKES THIS SECTION DISCRIMINATE.
  // Every field here is exempt AND inside its own declared ceiling, so nothing
  // is demoted and nothing is clippable — the answer is over budget because the
  // exempt fields COLLECTIVELY do not fit, which is the case a per-field ceiling
  // cannot see and no static check can. Found by the red drive: the fixture
  // below it left `body` clippable, so the verdict came back `clipped` on its
  // own merits and the headline assertion passed under a mutation that had
  // deleted the guard entirely.
  //
  // Each field is grown to just under its OWN declared ceiling rather than to a
  // hard-coded length, so the fixture stays honest if a ceiling moves — and so
  // that "inside its ceiling" is a property of how it was built, not a number
  // that happened to agree once.
  const upTo = (field, build) => {
    const ceiling = NEVER_CLIPPED_FIELDS[field].maxChars;
    let best = build(0);
    for (let n = 1; n < 4000; n += 1) {
      const candidate = build(n);
      if (sizeOf(candidate) > ceiling) break;
      best = candidate;
    }
    return best;
  };
  const x = (n) => 'x'.repeat(n);
  const envelope = {
    action: upTo('action', (n) => `a_response_name_${x(n)}`),
    success: true,
    status: upTo('status', (n) => `upstream_${x(n)}`),
    outcome: upTo('outcome', (n) => `serving_${x(n)}`),
    mode: upTo('mode', (n) => `read_${x(n)}`),
    whatAnEmptyToolListMeans: upTo('whatAnEmptyToolListMeans', (n) => `read outcome ${x(n)}`),
    via: upTo('via', (n) => ({
      tool: 'atlassian_search',
      method: 'GET',
      path: `/rest/api/3/${x(n)}`,
      servedBy: 'butchr-daemon'
    }))
  };
  const oversize = Object.entries(envelope).filter(
    ([f, v]) => NEVER_CLIPPED_FIELDS[f] && !exemptionHolds(f, v)
  );
  check(
    'the collective fixture is entirely exempt fields, every one INSIDE its ceiling',
    Object.keys(envelope).every((f) => f in NEVER_CLIPPED_FIELDS) && oversize.length === 0,
    oversize.map(([f, v]) => `${f}: ${sizeOf(v)} > ${NEVER_CLIPPED_FIELDS[f].maxChars}`).join('\n') ||
      Object.keys(envelope).filter((f) => !(f in NEVER_CLIPPED_FIELDS)).join(', ')
  );

  const fitted = fitGenericResponse(envelope, {
    tool: 'atlassian_search',
    budgetChars: MIN_BUDGET_CHARS
  });
  const stuck = clipsOf(fitted).find((c) => c.reduction === 'irreducible');
  check(
    `it is over budget (${fitted.text.length} vs ${MIN_BUDGET_CHARS}) with NOTHING clippable`,
    fitted.text.length > MIN_BUDGET_CHARS &&
      clipsOf(fitted).every((c) => c.reduction === 'irreducible'),
    `chars=${fitted.text.length} clips=${JSON.stringify(clipsOf(fitted).map((c) => `${c.field}/${c.reduction}`))}`
  );
  check(
    'and the verdict is `clipped` with an `irreducible` record — NOT `complete`',
    fitted.completeness.kind === 'clipped' && stuck !== undefined,
    JSON.stringify(fitted.completeness, null, 2)
  );
}

{
  // `completeness` is `never-reduced` and grows by one record per reduction, so
  // at the smallest legal budget the verdict itself is what does not fit.
  const cql = 'x'.repeat(1900);
  const envelope = {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    body: { results: Array.from({ length: 40 }, (_, i) => ({ id: i, title: 'a page '.repeat(6) })) },
    via: {
      tool: 'atlassian_search',
      method: 'GET',
      path: `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=50`,
      products: ['jira', 'confluence'],
      servedBy: 'butchr-daemon'
    }
  };
  const fitted = fitGenericResponse(envelope, { tool: 'atlassian_search', budgetChars: MIN_BUDGET_CHARS });
  const stuck = clipsOf(fitted).find((c) => c.reduction === 'irreducible');

  check(
    `over budget at MIN_BUDGET_CHARS (${fitted.text.length} chars vs ${MIN_BUDGET_CHARS}) — the fixture reaches the case`,
    fitted.text.length > MIN_BUDGET_CHARS,
    `${fitted.text.length}`
  );
  check(
    'the verdict is `clipped`, NOT `complete` — this is the assertion the whole section exists for',
    fitted.completeness.kind === 'clipped',
    `kind=${fitted.completeness.kind}`
  );
  check(
    'and it carries an `irreducible` record naming the largest field left',
    stuck !== undefined && typeof stuck.field === 'string',
    JSON.stringify(clipsOf(fitted).map((c) => `${c.field}/${c.reduction}`))
  );
  check(
    'whose `returned`/`total`/`omitted` are all null, because nothing was dropped there',
    stuck?.returned === null && stuck?.total === null && stuck?.omitted === null,
    JSON.stringify(stuck, null, 2)
  );
  check(
    'and the detail says OVER BUDGET rather than "reduced to fit", which would be the opposite of true',
    /STILL OVER BUDGET/.test(fitted.completeness.detail) &&
      !/reduced to fit/.test(fitted.completeness.detail),
    fitted.completeness.detail
  );
}

{
  // Its own positive control, from the other side: an answer that DOES fit must
  // never carry an `irreducible` record. Without this the section above would
  // pass just as well if every answer were marked irreducible.
  const small = { action: 'capacity_response', success: true, headroom: 3, cap: 11 };
  const fitted = fitGenericResponse(small, { tool: 'butchr_capacity' });
  check(
    'an answer inside its budget is `complete` and carries no `irreducible` record',
    fitted.completeness.kind === 'complete' &&
      clipsOf(fitted).every((c) => c.reduction !== 'irreducible'),
    JSON.stringify(fitted.completeness, null, 2)
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('6. NO RUNG STILL ASKS THE LIST INSTEAD OF THE VALUE (static, supplies no input)');

{
  const source = fs.readFileSync(path.join(daemonDir, 'src', 'mcp-response-budget.ts'), 'utf8');
  // Comments are stripped first: this file DISCUSSES the retired guard by name
  // in the header of `exemptionHolds`, and a grep that counted that would report
  // a regression that is a sentence about the regression.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

  const stale = [...code.matchAll(/NEVER_CLIPPED\.includes\s*\(/g)];
  check(
    'no `NEVER_CLIPPED.includes(...)` guard survives in code — every rung asks `exemptionHolds`',
    stale.length === 0,
    `${stale.length} occurrence(s) remain`
  );

  const guards = [...code.matchAll(/exemptionHolds\s*\(/g)];
  check(
    'and `exemptionHolds` is asked at all three rungs it replaced (ladder, candidates, backstop)',
    guards.length >= 3,
    `found ${guards.length} call site(s) in code`
  );

  check(
    '`NEVER_CLIPPED` is computed from the registry in code, not written out again',
    /NEVER_CLIPPED[^=]*=\s*Object\.keys\(NEVER_CLIPPED_FIELDS\)/.test(code),
    'the derived-list expression was not found'
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(76)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('═'.repeat(76));

process.exit(failures ? 1 : 0);
