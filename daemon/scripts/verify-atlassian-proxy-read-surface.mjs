// KAN-292: the read surface — eighteen operations added to the daemon-side
// Atlassian proxy, and the containment they must not loosen.
//
// WHAT FAILURE THIS WOULD CATCH: an operation that lets an agent name where the
// daemon's credential goes. That is the one property the whole design rests on
// — KAN-272 established it, KAN-291 kept it through a write, and this slice is
// where it was most likely to be lost, because two of the tools it adds
// (`atlassian_fetch_resource` and `atlassian_search`) look from the outside
// like they want a caller-supplied URL. It would also catch: a Confluence path
// routed at the Jira host or the reverse; the ARI parser accepting a product,
// a type or an id it should not; the search fan-out growing or shrinking on an
// argument; a scope quietly widening; a transform reaching for the credential;
// and the switch falling toward on.
//
// Since KAN-311 it also catches **an interpolation losing its encoding on a path
// whose argument is strictly validated** — a change no hostile input can see,
// because a digits-only validator lets through only characters the encoder would
// not have altered, so the built path is byte-identical either way. Sections 2b
// and 2c are that pair: 2b reports which arguments the sweep never exercised an
// interpolation for, and 2c asserts the encoding those arguments rest on. What
// 2c does **not** reach is any path built outside this table's own `path:`
// templates — it is a static read of `atlassian-proxy.ts`, and section 6 plus
// `verify-atlassian-proxy-failure-is-loud.mjs` are what tie the table to the
// router that issues the request.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process, and reads `atlassian-proxy.ts` and `router.ts` off the checkout;
// no live daemon, no herdr, no credential, no peer, no terminal, no network.
// The half that needs real Atlassian is deliberately not here — it is
// `probe-atlassian-proxy-read-surface.mjs`, which is a `probe-` precisely
// because CI cannot run it.
//
// ── WHY THE REFUSALS NEED A POSITIVE CONTROL ────────────────────────────────
//
// Most of this file asserts that something is REFUSED, and a refusal is what a
// broken instrument produces too: a `build` that returned `{error}` for every
// input would make sections 2 and 3 pass completely, for a reason with nothing
// to do with containment, and this file would read as a clean bill of health
// for a proxy that had stopped working. So section 5 is not a fifth test — it
// is what licenses the others: the same table, the same builders, shown in the
// same run to produce real paths for real arguments. Every "it refused" here is
// measured on an instrument shown to be capable of saying yes.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// This one is pure: it imports the module and calls it. No daemon, no socket,
// no credential, no network. That is what makes it fast and unflaky, and it is
// also exactly what it cannot prove:
//
//   - **It proves nothing about whether Atlassian serves these paths.** A path
//     this table builds correctly and Confluence has never heard of would leave
//     every assertion here green. `probe-atlassian-proxy-read-surface.mjs`
//     covers that — a real call per tool against real Atlassian with the real
//     credential — and it is the one that found the two endpoints whose shape
//     this file could not have questioned.
//   - **It proves nothing about whether the daemon consults any of this.** A
//     `router.ts` that never called `build` would leave this green too. Section
//     6 reads `router.ts` for the structural half, and
//     `verify-atlassian-proxy-failure-is-loud.mjs` drives the whole chain over
//     real MCP stdio.
//   - **It constructs its own arguments**, which is the KAN-145 shape named in
//     `prompts/task.md`: it proves what `build` does GIVEN an argument, never
//     that a real argument arrives from a real agent. The probe's section 2 is
//     what covers arrival, because there the arguments come out of earlier
//     proxied calls rather than out of a literal in a script.
//
// ── BUILD FIRST — THIS SCRIPT IMPORTS `../dist/`, NOT THE TYPESCRIPT ────────
//
// Run `npm run build` in `daemon/` before this, and re-run it after every edit
// to `daemon/src`. A stale `dist` does not fail: it measures the OLD code and
// prints a pass indistinguishable from a real one. `epic/KAN-39`'s first run at
// review of #127 was against a `dist` with 13 newer source files and printed
// `22 operations, 396 placements` — a clean-looking pass over code that was not
// the code under review, caught only by checking mtimes by hand.
//
// You do not have to remember: `requireFreshDist` below refuses the run. It
// exits 2 — a setup guard, distinct from the 1 this script's verdict exits with.
//
// Usage: node daemon/scripts/verify-atlassian-proxy-read-surface.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  PROXY_COMMENT_MAX_RESULTS,
  PROXY_ENV_VAR,
  PROXY_LIST_MAX_RESULTS,
  PROXY_OPERATIONS,
  enabledModes,
  grantedScopes,
  operationByTool,
  operationsFor,
  parseAri,
  proxyReport,
  refuseProxyCall,
  scopesOf,
  selectedProxyMode
} from '../dist/atlassian-proxy.js';
import {
  BASE,
  HOSTILE,
  fixedPrefix,
  pathEscapes,
  requestsOf,
  sweepHostileInput,
  unencodedPathInterpolations,
  validFor,
  zeroContainmentArguments
} from './lib/proxy-hostile-input.mjs';
import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// Before anything is asserted on the modules imported above. See the header.
requireFreshDist(path.join(scriptDir, '..', 'src'), path.join(scriptDir, '..', 'dist'), {
  hint: 'npm run build --prefix daemon'
});

const VERBOSE = process.argv.includes('--verbose');

// The proxy source, read once. Section 2c reads it for the path encodings and
// section 6 for the transform context, so it is hoisted here rather than read
// twice at two different points in the file.
const proxySrc = fs.readFileSync(path.join(scriptDir, '..', 'src', 'atlassian-proxy.ts'), 'utf8');

let failures = 0;
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}
function check(label, ok, detail) {
  if (ok && !VERBOSE) {
    console.log(`   PASS  ${label}`);
  } else {
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  }
  if (!ok) failures++;
}

// ── 1. the surface is complete, and counted off the live list ──────────────
rule('1. the surface — eighteen reads added, and the count is checked not asserted');

// The official Atlassian MCP tools this slice replaces, written out so that
// "every remaining read" is a checkable claim rather than a sentence. KAN-288's
// enumeration and KAN-292's both mislabelled their own lists — 30 where the
// list has 31, 5 where the list has 6 — so this is the arithmetic redone
// against the live tool list, which both tickets say wins.
const REPLACES = {
  // KAN-272 shipped these three; they are here so the mapping is whole.
  getJiraIssue: 'atlassian_get_issue',
  searchJiraIssuesUsingJql: 'atlassian_search_issues',
  getTransitionsForJiraIssue: 'atlassian_get_transitions',
  // Jira reads — KAN-292 labelled this group "(5)" and listed six.
  getIssueLinkTypes: 'atlassian_get_issue_link_types',
  getJiraIssueRemoteIssueLinks: 'atlassian_get_issue_remote_links',
  getJiraIssueTypeMetaWithFields: 'atlassian_get_issue_type_fields',
  getJiraProjectIssueTypesMetadata: 'atlassian_get_project_issue_types',
  getVisibleJiraProjects: 'atlassian_get_visible_projects',
  lookupJiraAccountId: 'atlassian_lookup_account_id',
  // Confluence reads — eight.
  getConfluenceCommentChildren: 'atlassian_get_confluence_comment_children',
  getConfluencePage: 'atlassian_get_confluence_page',
  getConfluencePageDescendants: 'atlassian_get_confluence_page_descendants',
  getConfluencePageFooterComments: 'atlassian_get_confluence_page_footer_comments',
  getConfluencePageInlineComments: 'atlassian_get_confluence_page_inline_comments',
  getConfluenceSpaces: 'atlassian_get_confluence_spaces',
  getPagesInConfluenceSpace: 'atlassian_get_confluence_space_pages',
  searchConfluenceUsingCql: 'atlassian_search_confluence_cql',
  // Account / cross-product — four.
  atlassianUserInfo: 'atlassian_get_user_info',
  getAccessibleAtlassianResources: 'atlassian_get_accessible_resources',
  search: 'atlassian_search',
  fetch: 'atlassian_fetch_resource'
};

const unmapped = Object.entries(REPLACES).filter(([, tool]) => !operationByTool(tool));
check(
  `every one of the ${Object.keys(REPLACES).length} official read tools maps to an operation`,
  unmapped.length === 0,
  JSON.stringify(unmapped)
);
// 21 until KAN-471, which added `atlassian_get_issue_comments` — the one read
// with no counterpart on the official server, because that server has no
// comment-listing tool and the issue endpoint both share caps the comment
// field at 100 with no way to page past it. So this count and
// `Object.keys(REPLACES).length` above are deliberately no longer equal, and
// the check directly above is the one that still ties the table to the
// official surface.
// KAN-656 adds the twenty-third for the same reason KAN-471 added the
// twenty-second, one field over. `atlassian_get_issue` can ask for
// `fields=description` and inherits no cap it can page past: a description is
// ONE field, `fields` is the only lever, and a brief larger than the response
// budget was therefore returned by nothing at all. Measured on KAN-623 — every
// route ended in `noWayBack`, and the agent staffed for that ticket could not
// read it. `atlassian_get_issue_description` pages the rendered text by
// character offset, which is the lever that did not exist.
check(
  'the read surface is exactly 23 operations — the 3 KAN-272 shipped, 18 from KAN-292, KAN-471\'s comment paging and KAN-656\'s description paging',
  operationsFor('confluence-read').filter((op) => op.method === 'GET').length === 23,
  JSON.stringify(operationsFor('confluence-read').map((op) => op.tool))
);
check(
  'every read operation is a GET — this slice added no write',
  operationsFor('confluence-read').every((op) => op.method === 'GET'),
  JSON.stringify(operationsFor('confluence-read').filter((op) => op.method !== 'GET').map((o) => o.tool))
);

// ── 2. NO OPERATION TAKES A PATH — the containment, over the whole table ───
rule('2. containment — no operation accepts a path, and none can be made to build one');

check(
  'no input schema names a path, url, endpoint, method, host or body',
  PROXY_OPERATIONS.every(
    (op) =>
      !Object.keys(op.inputSchema.properties ?? {}).some((name) =>
        /^(path|url|uri|endpoint|method|rest|body|host|origin|site|base|server)$/i.test(name)
      )
  ),
  JSON.stringify(PROXY_OPERATIONS.map((op) => [op.tool, Object.keys(op.inputSchema.properties ?? {})]))
);

// Every argument of every operation, fed the same hostile values. This is the
// section that would have caught a `fetch` implemented the obvious way.
//
// The corpus and the checker moved to `lib/proxy-hostile-input.mjs` at
// `epic/KAN-39`'s review of #127, so that `verify-atlassian-proxy-scope.mjs` —
// the file that owns KAN-272's "no operation takes a path" sentence — runs the
// SAME sweep over the same table rather than a second copy of it. Two copies of
// a 400-placement corpus is two things to drift, and the one that stops
// covering `fetch` is the one nobody re-reads.
const sweep = sweepHostileInput(PROXY_OPERATIONS);
check(
  `all ${sweep.checked} hostile argument placements were refused (${sweep.refused}) or ` +
    `stayed inside their parameter (${sweep.contained})`,
  sweep.escapes.length === 0,
  sweep.escapes.slice(0, 6).join('\n')
);
// Both outcomes must actually occur, or the sweep proved nothing: all refusals
// would mean the operations never build, and all containments would mean no
// validator rejects anything.
check(
  'and both outcomes occurred — the sweep is neither refusing everything nor validating nothing',
  sweep.refused > 0 && sweep.contained > 0,
  `refused ${sweep.refused}, contained ${sweep.contained}`
);

// ── 2b. WHICH ARGUMENTS THE SWEEP ACTUALLY MEASURED (KAN-311) ──────────────
//
// The assertion above is global, and global is not where a path is built. An
// argument whose validator refuses all twelve hostile values contributes zero
// containment evidence: the sweep measured its **validator** and never its
// **interpolation**, and the encoding beside it could be entirely absent with
// every check on this page still green. That is exactly what happened — removing
// `encodeURIComponent` from the get-page path left all 396 placements green,
// because `pageId` is digits-only and no hostile value ever reaches the
// interpolation.
//
// THE DECISION, WHICH KAN-311 ASKED TO BE MADE DELIBERATELY AND RECORDED:
//
//   **Zero containment is a REPORT here, and the encoding is an ASSERTION
//   below.** Not a failure, because refusing everything is the correct
//   behaviour for a strict validator on an argument with no free-text form —
//   `pageId`, `commentId`, `issueKey`, `spaceId` and `transitionId` all
//   legitimately refuse all twelve, and failing on that would be demanding that
//   validators be loosened to satisfy a proof, which is the opposite of the
//   property being protected.
//
// WHAT WAS REJECTED, and why, because "we picked a report" is not a decision
// without the alternatives:
//
//   - **Fail on zero containment.** Rejected: it fails eleven arguments that are
//     correct today, and the only way to make it pass is to weaken a validator.
//     A proof that pushes the code toward the hole is worse than no proof.
//   - **Fail where an argument is UNVALIDATED and still contributes nothing** —
//     the shape the ticket floats. Rejected as an assertion because it is
//     vacuous on this table: an unvalidated argument by definition does not
//     refuse, so it always contributes containment, and the check can never
//     fire. It is a tautology wearing a guard's clothes.
//   - **Extend the corpus with values that pass the validator and still probe
//     the encoding.** Rejected because it is impossible, not merely hard: for a
//     digits-only argument every accepted value is digits, and digits are
//     unchanged by `encodeURIComponent`. The two builds are byte-identical.
//     **No input fed through `build` can distinguish them.**
//
// So the report names where the evidence is missing, and section 2c asserts the
// mechanism that covers it. Neither alone is enough: the report does not go red
// on the mutation (`pageId` is in the zero list before it and after it), and the
// assertion cannot see a validator. Together they say which of the two
// mechanisms is carrying each argument.
rule('2b. per argument — which interpolations the sweep measured, and which it did not');

const zero = zeroContainmentArguments(sweep);
console.log(
  `   NOTE  ${zero.length} of ${sweep.perArgument.length} arguments contributed zero contained ` +
    'placements — their validator refused every hostile value, so this sweep measured the\n' +
    '         validator and NOT the encoding behind it. Section 2c is what covers those:'
);
for (const tally of zero) {
  console.log(`           ${tally.tool}.${tally.field} — refused ${tally.refused}/${tally.checked}`);
}
// The report has to be a report OF something. If every argument refused
// everything, the sweep measured no interpolation anywhere and the global
// assertion above is the only thing standing — which is the vacuity this whole
// section exists to make visible.
check(
  'at least one argument contributed containment — the sweep exercised a real interpolation',
  zero.length < sweep.perArgument.length,
  `all ${sweep.perArgument.length} arguments refused everything`
);

// ── 2c. THE ENCODING, WHICH IS THE MECHANISM THE SWEEP CANNOT SEE ──────────
//
// The second of the two mechanisms that contain a path. Where a validator
// refuses every hostile value, the sweep's verdict is carried by the validator
// alone and the encoding is never exercised — so it is checked where it IS
// visible, which is the source. This is the check that goes red on KAN-311's
// mutation while every placement above stays green.
//
// The risk it exists to prevent is a future one and the ticket names it exactly:
// someone relaxes `pageId` to accept a non-digit — a slug, an id with a suffix —
// and silently un-contains that path, because the encoding that would have held
// it had already gone and nothing noticed. Two mechanisms make it safe today;
// this is what keeps the count at two.
rule('2c. the encoding — every path interpolation encodes its argument or is not a string');

const bareInterpolations = unencodedPathInterpolations(proxySrc);
check(
  'every interpolation into a path is encoded, or is a bounded number or a narrowed literal',
  bareInterpolations.length === 0,
  bareInterpolations
    .map((b) => `atlassian-proxy.ts:${b.line}  \${${b.expression}} reaches a path unencoded`)
    .join('\n')
);

// ── 3. the ARI, which is the one input that looks like a destination ───────
rule('3. the ARI is parsed, never forwarded');

// An ARI names a resource; a URL names a location. If the difference had not
// held, `atlassian_fetch_resource` would have been a caller-supplied endpoint
// wearing an identifier's clothes, and KAN-292 says to stop and report rather
// than ship that. These are the inputs that would prove it had not held.
const BAD_ARIS = [
  'https://wroosbit.atlassian.net/rest/api/3/myself',
  '/rest/api/3/myself',
  'ari:cloud:jira:c4c:issue/../../admin',
  'ari:cloud:jira:c4c:issue/KAN-1/../../admin',
  'ari:cloud:confluence:c4c:page/../../../admin',
  'ari:cloud:jira:c4c:page/163933',            // product and type disagree
  'ari:cloud:confluence:c4c:issue/10301',      // and the other way round
  'ari:cloud:bitbucket:c4c:repository/x',      // a product this proxy has no credential for
  'ari:cloud:jira:c4c:attachment/1',           // a type it does not serve
  'ari:cloud:jira:c4c:issue/',
  'ari:cloud:jira:c4c:issue/NOT A KEY',
  'ari::::/',
  ''
];
for (const bad of BAD_ARIS) {
  const parsed = parseAri(bad);
  check(
    `ARI ${JSON.stringify(bad.slice(0, 44))} is refused`,
    'error' in parsed,
    JSON.stringify(parsed)
  );
}
// The cloudId is ignored rather than honoured — see `parseAri`. Two ARIs that
// differ only in cloudId must build the same path, or an agent could name a
// site the credential was never configured for.
const mine = operationByTool('atlassian_fetch_resource').build({
  id: 'ari:cloud:jira:c4c523ff-4beb-4418-9257-9f194fce3490:issue/10301'
});
const theirs = operationByTool('atlassian_fetch_resource').build({
  id: 'ari:cloud:jira:somebody-elses-cloud-id:issue/10301'
});
check(
  "a foreign cloudId in an ARI changes nothing — the daemon reaches its own site or none",
  mine.path === theirs.path && mine.product === theirs.product,
  JSON.stringify({ mine, theirs })
);
check(
  'a Jira ARI routes at Jira and a Confluence ARI at Confluence',
  operationByTool('atlassian_fetch_resource').build({ id: 'ari:cloud:jira:c:issue/KAN-1' }).product ===
    'jira' &&
    operationByTool('atlassian_fetch_resource').build({ id: 'ari:cloud:confluence:c:page/1' })
      .product === 'confluence',
  ''
);

// ── 4. product routing — a path goes to the product that owns it ───────────
rule('4. product routing — a Confluence path never goes to the Jira host, or the reverse');

for (const op of operationsFor('confluence-read')) {
  const fields = Object.keys(op.inputSchema.properties ?? {});
  const args = {};
  for (const field of fields) args[field] = validFor(field);
  const requests = requestsOf(op, args);
  if (!requests) {
    check(`${op.tool} builds a request for valid arguments`, false, JSON.stringify(op.build(args)));
    continue;
  }
  for (const request of requests) {
    const ok =
      request.product === 'confluence'
        ? request.path.startsWith('/wiki/')
        : request.product === 'site'
          ? request.path.startsWith('/_edge/')
          : request.path.startsWith('/rest/');
    check(
      `${op.tool} routes ${request.product} at a ${request.product} path`,
      ok,
      `${request.product} → ${request.path}`
    );
  }
  check(
    `${op.tool} declares every product it actually builds for`,
    requests.every((request) => op.products.includes(request.product)),
    JSON.stringify({ declared: op.products, built: requests.map((r) => r.product) })
  );
}

// ── 5. THE POSITIVE CONTROL, plus the fan-out is fixed ─────────────────────
rule('5. positive control — the same table really does build paths, and the fan-out is the table\'s');

let built_ok = 0;
for (const op of operationsFor('confluence-read')) {
  const fields = Object.keys(op.inputSchema.properties ?? {});
  const args = {};
  for (const field of fields) args[field] = validFor(field);
  if (requestsOf(op, args)) built_ok++;
}
check(
  `all ${operationsFor('confluence-read').length} read operations build a path for good arguments — ` +
    'so every refusal above measured a real absence',
  built_ok === operationsFor('confluence-read').length,
  `${built_ok} of ${operationsFor('confluence-read').length}`
);

// `atlassian_search` is the only operation that makes more than one request,
// and the NUMBER is the table's rather than the caller's. An argument that
// could add a request would be an argument that could add an endpoint.
const searchOp = operationByTool('atlassian_search');
for (const args of [
  { query: 'a' },
  { query: 'a', limit: 1 },
  { query: 'a', limit: 9999 },
  { query: 'a"; DROP', limit: -1 },
  { query: 'x'.repeat(400) }
]) {
  const requests = requestsOf(searchOp, args);
  check(
    `atlassian_search builds exactly 2 requests for ${JSON.stringify(JSON.stringify(args).slice(0, 40))}`,
    requests?.length === 2 &&
      requests[0].product === 'jira' &&
      requests[1].product === 'confluence',
    JSON.stringify(requests?.map((r) => `${r.product} ${r.path.slice(0, 60)}`))
  );
}
// And every list bound is honoured, on every operation that takes one.
for (const op of operationsFor('confluence-read')) {
  const fields = Object.keys(op.inputSchema.properties ?? {});
  if (!fields.includes('limit')) continue;
  const args = {};
  for (const field of fields) args[field] = validFor(field);
  for (const asked of [10_000, PROXY_LIST_MAX_RESULTS + 1, 'lots', -5, NaN]) {
    const requests = requestsOf(op, { ...args, limit: asked });
    const bounded = requests?.every((request) => {
      const got = Number(request.path.match(/(?:limit|maxResults)=(\d+)/)?.[1] ?? -1);
      return got >= 1 && got <= PROXY_LIST_MAX_RESULTS;
    });
    check(
      `${op.tool} bounds limit=${JSON.stringify(asked)} at ${PROXY_LIST_MAX_RESULTS}`,
      !!bounded,
      JSON.stringify(requests?.map((r) => r.path))
    );
  }
}

// KAN-471's comment paging takes `maxResults` and `startAt` rather than
// `limit`, so the loop above — which keys off a `limit` field — skips it
// entirely. THAT SKIP IS THE POINT OF THIS BLOCK. `BOUNDED_INTERPOLATIONS`
// exempts both of its interpolations from the encoding check on the stated
// grounds that they are bounded by construction, and an exemption whose
// backing assertion never runs is the artifact-claims-more-than-its-mechanism
// defect in the proof itself. So both bounds are driven here, against the same
// hostile values, and the exemption is earned rather than asserted.
const commentsOp = operationByTool('atlassian_get_issue_comments');
check(
  'atlassian_get_issue_comments is on the read surface',
  !!commentsOp && commentsOp.method === 'GET',
  JSON.stringify(commentsOp?.tool ?? null)
);
for (const asked of [10_000, PROXY_COMMENT_MAX_RESULTS + 1, 'lots', -5, NaN]) {
  const requests = requestsOf(commentsOp, { issueKey: 'KAN-39', maxResults: asked });
  const got = Number(requests?.[0]?.path.match(/maxResults=(\d+)/)?.[1] ?? -1);
  check(
    `atlassian_get_issue_comments bounds maxResults=${JSON.stringify(asked)} at ${PROXY_COMMENT_MAX_RESULTS}`,
    got >= 1 && got <= PROXY_COMMENT_MAX_RESULTS,
    JSON.stringify(requests?.map((r) => r.path))
  );
}
// `startAt` has no useful ceiling — paging a long history legitimately asks for
// 200 — so what must hold is that it reaches the path as a non-negative
// integer and never as caller text. `'../../admin'` is in the list because
// that is the value the whole containment argument exists to refuse.
for (const asked of ['lots', -5, NaN, 1.7, '../../admin', 10_000_000]) {
  const requests = requestsOf(commentsOp, { issueKey: 'KAN-39', startAt: asked });
  const path = requests?.[0]?.path ?? '';
  const got = Number(path.match(/startAt=(\d+)(?:&|$)/)?.[1] ?? -1);
  check(
    `atlassian_get_issue_comments bounds startAt=${JSON.stringify(asked)} to a non-negative integer`,
    got >= 0 && Number.isInteger(got) && !/\.\.|admin/.test(path),
    JSON.stringify(path)
  );
}

// ── 5b. the scopes this surface needs ──────────────────────────────────────
//
// THIS SECTION EXISTS BECAUSE THE RED-DRIVE FOUND IT MISSING. Six deliberate
// breakages were applied to this slice and five of them turned this file red.
// The sixth — giving `atlassian_get_confluence_page` a `write:confluence-content`
// scope — left it **completely green**, while this file's own header claimed it
// would catch "a scope quietly widening". It was caught, but by
// `verify-atlassian-proxy-scope.mjs`, which is a different file with a
// different remit; nothing here noticed, and a header that claims coverage a
// script does not have is the artifact-claims-more-than-its-mechanism defect
// this epic keeps finding, in the proof rather than the feature.
//
// So the claim is made true rather than withdrawn. KAN-292's criterion 3 is
// "the scope actually needed, enumerated per tool", which is this slice's own
// acceptance criterion and belongs in this slice's own script.
rule('5b. the scopes — enumerated per tool, and no read may need a write');

check(
  'no read operation declares a write scope',
  PROXY_OPERATIONS.filter((op) => op.method === 'GET').every((op) =>
    scopesOf(op).every((scope) => !/^write:/i.test(scope))
  ),
  JSON.stringify(
    PROXY_OPERATIONS.filter((op) => op.method === 'GET')
      .filter((op) => scopesOf(op).some((s) => /^write:/i.test(s)))
      .map((op) => [op.tool, scopesOf(op)])
  )
);
check(
  'confluence-read needs exactly the five read scopes and nothing else',
  JSON.stringify(grantedScopes('confluence-read')) ===
    JSON.stringify([
      'read:confluence-content.all',
      'read:confluence-content.summary',
      'read:confluence-space.summary',
      'read:jira-user',
      'read:jira-work'
    ]),
  JSON.stringify(grantedScopes('confluence-read'))
);
// A scope and a product must agree. A Confluence operation asking for a Jira
// scope is either mis-tagged or mis-routed, and both are invisible in a passing
// run of everything else.
for (const op of operationsFor('confluence-read')) {
  const scopes = scopesOf(op);
  if (!scopes.length) continue; // the one unauthenticated read; asserted below
  const ok = op.products.every((product) =>
    product === 'site'
      ? true
      : scopes.some((scope) => scope.includes(product === 'jira' ? 'jira' : 'confluence'))
  );
  check(`${op.tool}'s scopes name the products it reaches`, ok, JSON.stringify({ products: op.products, scopes }));
}
check(
  'exactly one operation is scopeless, and it is the unauthenticated site read',
  (() => {
    const none = PROXY_OPERATIONS.filter((op) => scopesOf(op).length === 0);
    return none.length === 1 && none[0].tool === 'atlassian_get_accessible_resources';
  })(),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => scopesOf(op).length === 0).map((op) => op.tool))
);

// ── 6. the transforms, and what they are allowed to touch ──────────────────
rule('6. only four operations reshape a response, and none can reach a credential');

// KAN-501 made this three; KAN-522 makes it four. The list is spelled out rather
// than counted so that adding a transform is a deliberate edit here as well as
// there — the point was never the number, it is that each one is argued for.
// `ProxyOperationBase.transform` carries the argument for the third and the
// fourth, and each operation's own transform docblock carries its half.
//
// THE FOURTH IS `atlassian_search_issues`, and what makes it belong here rather
// than merely be tolerated: its alternative was not an untransformed response
// but NO ISSUES, measured — a raw row costs ~2,850 characters on that
// operation's default fields against a 9,000-character budget, so the whole
// `issues` array was replaced, and `fields` is already at its narrowest useful
// value when that happens. Same argument as the third, made on the same terms.
// THE FIFTH IS `atlassian_get_issue_description` (KAN-656), and its argument is
// the second one made on those terms: without a transform its alternative was
// not an untransformed response but NO DESCRIPTION. Jira serves a description
// as ADF, which is roughly four times the size of the prose in it — 32,405
// characters for KAN-623's 8,384 rendered — so the field was replaced whole at
// every budget, and unlike a list there is no narrower `fields` to ask for. The
// transform is what renders it, and it is also what lifts the paging cursor out
// of the clippable region: `total` and `startAt` sit beside the text as scalars
// rather than inside an object a clip can take, which is the defect KAN-501
// found in the comment pager, avoided here by construction.
const withTransform = PROXY_OPERATIONS.filter((op) => op.transform).map((op) => op.tool);
check(
  'exactly five operations have a transform, and they are the five that cannot avoid one',
  JSON.stringify(withTransform.sort()) ===
    JSON.stringify([
      'atlassian_get_accessible_resources',
      'atlassian_get_issue_comments',
      'atlassian_get_issue_description',
      'atlassian_search',
      'atlassian_search_issues'
    ]),
  JSON.stringify(withTransform)
);
// A transform is given non-secret context and nothing else. Asserted against
// the source, because the type that enforces it is erased at runtime.
// Read the FIELDS, not the prose. The first version of this check grepped the
// whole interface block for the word "token" and failed on the docblock
// sentence *"the token half of Basic auth is not here"* — a comment saying the
// right thing, read as the wrong thing. What the check wants is the set of
// declared property names, so that is what it extracts.
const contextBlock = proxySrc.match(/export interface ProxyTransformContext \{([^}]*)\}/)?.[1] ?? '';
const contextFields = [...contextBlock.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
check(
  'ProxyTransformContext declares only siteUrl and email — no token can reach a transform',
  JSON.stringify(contextFields.sort()) === JSON.stringify(['email', 'siteUrl']),
  JSON.stringify(contextFields)
);
const routerSrc = fs.readFileSync(path.join(scriptDir, '..', 'src', 'router.ts'), 'utf8');
// And the call site actually passes that narrow object rather than the whole
// credential status. `CredentialStatus` is an open record — `[field: string]:
// string | boolean` — so `this.jira.status()` is exactly the sort of value that
// could grow a token-bearing field later without anything here objecting. What
// is asserted is that the two fields are named individually at the call site.
// The window was 400 characters and KAN-501 grew the call past it by adding a
// third argument. A non-match yields '' — which fails all three assertions
// below, each naming a credential problem that does not exist. THE CHECK WENT
// RED FOR THE WRONG REASON, which is the failure this repository keeps finding
// in other instruments and had here in its own. So the window is wider, and a
// call site that cannot be located now says exactly that.
const transformCall = routerSrc.match(/operation\.transform\(([\s\S]{0,900}?)\);/)?.[1] ?? '';
check(
  "the transform call site was located in router.ts at all — otherwise the checks below are about nothing",
  transformCall.length > 0,
  'no `operation.transform(...)` call matched; the assertions below would report a credential ' +
    'leak that has not been measured'
);
check(
  'router.ts hands the transform only siteUrl and email, never the credential object',
  /siteUrl:\s*asText\(credential\.siteUrl\)/.test(transformCall) &&
    /email:\s*asText\(credential\.email\)/.test(transformCall) &&
    !/\bcredential\s*[,)}]/.test(transformCall) &&
    !/\.\.\.credential/.test(transformCall),
  transformCall.slice(0, 300) ||
    'a transform handed the whole credential status could put a token in a response body'
);
// The accessible-resources transform must not invent a scope list. A classic
// token has none, and a fabricated one would be a claim about the credential's
// authority that nothing checked.
const resources = operationByTool('atlassian_get_accessible_resources').transform(
  [{ cloudId: 'c4c' }],
  { siteUrl: 'https://example.atlassian.net' }
);
check(
  'accessible-resources reports the one real site and no invented scopes',
  Array.isArray(resources) &&
    resources.length === 1 &&
    resources[0].id === 'c4c' &&
    resources[0].url === 'https://example.atlassian.net' &&
    Array.isArray(resources[0].scopes) &&
    resources[0].scopes.length === 0,
  JSON.stringify(resources)
);
// The search transform must keep the two products apart and must say what it
// is not. A merged, re-ranked list would be an artifact claiming more than its
// mechanism covers — the defect this epic keeps re-finding.
const merged = operationByTool('atlassian_search').transform(
  [{ issues: [{ key: 'KAN-1' }] }, { results: [{ title: 'p' }] }],
  {}
);
check(
  'search keeps the two products separate rather than inventing a ranking',
  merged.jira.issues.length === 1 && merged.confluence.results.length === 1 && !('results' in merged),
  JSON.stringify(merged)
);
check(
  'and it says in its own payload that it is not Rovo Search',
  /not Rovo Search/i.test(merged.note ?? ''),
  merged.note
);

// ── 7. the switch still falls to off, with the new rung on the ladder ──────
rule('7. off by default — a new rung did not give the switch a way to fall open');

for (const value of [undefined, '', '   ', 'confluence_read', 'CONFLUENCE', '1', 'true', 'on', 'yes', 'all']) {
  const decision = selectedProxyMode(value === undefined ? {} : { [PROXY_ENV_VAR]: value });
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(value)} serves nothing`,
    decision.mode === 'off' && operationsFor(decision.mode).length === 0,
    JSON.stringify(decision)
  );
}
for (const value of ['confluence-read', 'CONFLUENCE-READ', '  confluence-read  ']) {
  const decision = selectedProxyMode({ [PROXY_ENV_VAR]: value });
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(value)} selects confluence-read`,
    decision.mode === 'confluence-read' && decision.source === 'environment',
    JSON.stringify(decision)
  );
}
check(
  'jira-read does NOT serve the Confluence reads — the rung is a rung, not a relabelling',
  operationsFor('jira-read').every((op) => !op.products.includes('confluence')),
  JSON.stringify(operationsFor('jira-read').filter((op) => op.products.includes('confluence')).map((o) => o.tool))
);
check(
  'and confluence-read contains everything jira-read does',
  operationsFor('jira-read').every((op) =>
    operationsFor('confluence-read').some((other) => other.tool === op.tool)
  ),
  JSON.stringify(enabledModes('confluence-read'))
);
// The report an operator reads has to describe the mode the daemon is in.
const report = proxyReport(selectedProxyMode({ [PROXY_ENV_VAR]: 'confluence-read' }), {
  configured: true,
  siteUrl: 'https://x.atlassian.net',
  email: 'a@b.c'
});
check(
  'the confluence-read report enumerates every operation with its products and scope',
  report.operations.length === operationsFor('confluence-read').length &&
    report.operations.every((op) => op.products?.length && op.scope) &&
    JSON.stringify(report.scopes) === JSON.stringify(grantedScopes('confluence-read')),
  JSON.stringify(report.operations.slice(0, 2))
);
check(
  'the report never carries a token, under any key',
  !/token/i.test(JSON.stringify(report)),
  JSON.stringify(report).slice(0, 200)
);

console.log(
  failures
    ? `\nFAILED — ${failures} check(s)`
    : `\nOK — ${operationsFor('confluence-read').length} reads across three products, ` +
      `${sweep.checked} hostile argument placements contained, the ARI parsed rather than ` +
      `forwarded, and ${grantedScopes('confluence-read').length} scopes readable off one table.`
);
process.exit(failures ? 1 : 0);
