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
// Usage: node daemon/scripts/verify-atlassian-proxy-read-surface.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

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

/** Every request an operation builds for these arguments, or `null` if refused. */
function requestsOf(op, args) {
  const built = op.build(args);
  if ('error' in built) return null;
  if ('requests' in built) return built.requests;
  return [{ product: built.product ?? op.products[0], path: built.path, body: built.body }];
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
check(
  'the read surface is exactly 21 operations — the 3 KAN-272 shipped plus 18',
  operationsFor('confluence-read').filter((op) => op.method === 'GET').length === 21,
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
const HOSTILE = [
  '../../../../rest/api/3/myself',
  'KAN-1/../../admin',
  'KAN-1?expand=changelog&x=/rest/api/3/user',
  'KAN-1#/rest/api/3/anything',
  '../..%2f..%2fadmin',
  'https://evil.example.com/rest/api/3/myself',
  '//evil.example.com/x',
  'KAN 1',
  '',
  'NOT-A-KEY-AT-ALL',
  ' /rest/api/3/myself',
  '163933/../../../admin'
];

// A path is safe when it still addresses the endpoint its own template names.
//
// THE FIRST VERSION OF THIS FUNCTION WAS WRONG, AND IT IS WORTH SAYING HOW,
// because the wrong version is the one that looks more thorough. It grepped the
// built path for `..`, `http:` and `//` and called any of them an escape. That
// reported 29 failures against a table that is perfectly safe:
// `encodeURIComponent` leaves `.` alone — it is an unreserved character — and
// encodes `/` as `%2F`, so a hostile `../../admin` correctly becomes
// `..%2F..%2Fadmin`: dots intact, slashes neutralised, going nowhere. A checker
// that reads that as traversal is measuring the wrong thing, and "make the
// check pass" would have meant deleting it rather than fixing it.
//
// What matters is where the URL RESOLVES, so that is what is measured. The path
// is resolved against a base exactly as `fetch` would resolve it, and it must
// still land on the same origin and under the same fixed prefix its own
// template produces. A `..` that does nothing survives this; a `..` that climbs
// a segment does not, because resolution normalises it away and the prefix
// check then fails.
const BASE = 'https://site.invalid';

/**
 * The literal part of an operation's path — everything before the first place
 * an argument goes — derived by building the SAME operation twice with two
 * different benign values and taking the common prefix of what came out.
 *
 * Derived rather than declared, for two reasons. A new operation is covered the
 * day it is added instead of when somebody remembers to write its shape here;
 * and a `pathShape` string that has drifted from what `build` actually does
 * cannot quietly widen this check, because this never reads `pathShape`.
 */
function fixedPrefix(op, field, otherArgs) {
  const a = requestsOf(op, { ...otherArgs, [field]: pickBenign(field, 0) });
  const b = requestsOf(op, { ...otherArgs, [field]: pickBenign(field, 1) });
  if (!a || !b || a.length !== b.length) return null;
  return a.map((request, i) => {
    const pa = new URL(request.path, BASE).pathname;
    const pb = new URL(b[i].path, BASE).pathname;
    let n = 0;
    while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    // Back off to the last complete segment, so a prefix never ends mid-id.
    return pa.slice(0, pa.lastIndexOf('/', n) + 1);
  });
}

/** Two different, valid values for a field, so a prefix can be derived. */
function pickBenign(field, which) {
  if (/issueKey/i.test(field)) return which ? 'ZZZ-9' : 'KAN-1';
  if (/projectKey/i.test(field)) return which ? 'ZZZ' : 'KAN';
  if (/Id$/i.test(field)) return which ? '424242' : '163933';
  if (field === 'id') {
    return which ? 'ari:cloud:jira:c:issue/424242' : 'ari:cloud:jira:c:issue/163933';
  }
  if (field === 'limit' || field === 'maxResults') return which ? 4 : 5;
  if (field === 'bodyFormat') return which ? 'view' : 'storage';
  return which ? 'zzz' : 'aaa';
}

function pathEscapes(request, expectedPrefix) {
  let url;
  try {
    url = new URL(request.path, BASE);
  } catch {
    return 'the path does not parse as a URL at all';
  }
  if (url.origin !== BASE) return `resolves to a different origin: ${url.origin}`;
  if (url.hash) return `carries a fragment: ${url.hash}`;
  if (expectedPrefix != null && !url.pathname.startsWith(expectedPrefix)) {
    return `resolves outside its template: ${url.pathname} is not under ${expectedPrefix}`;
  }
  return null;
}

let hostileChecked = 0;
let hostileRefused = 0;
let hostileContained = 0;
const escapes = [];
for (const op of PROXY_OPERATIONS) {
  const fields = Object.keys(op.inputSchema.properties ?? {});
  for (const field of fields) {
    // Fill every OTHER field with something valid, so the operation gets far
    // enough to build and the hostile value is the only thing under test.
    const otherArgs = {};
    for (const other of fields) {
      if (other !== field) otherArgs[other] = validFor(op, other);
    }
    const prefixes = fixedPrefix(op, field, otherArgs);
    for (const hostile of HOSTILE) {
      const built = op.build({ ...otherArgs, [field]: hostile });
      hostileChecked++;
      if ('error' in built) {
        hostileRefused++;
        continue; // a refusal is a pass, and the loudest kind
      }
      const requests = 'requests' in built ? built.requests : [built];
      requests.forEach((request, i) => {
        const escape = pathEscapes(request, prefixes?.[i] ?? null);
        if (escape) {
          escapes.push(`${op.tool}.${field}=${JSON.stringify(hostile.slice(0, 30))} → ${escape}`);
        } else {
          hostileContained++;
        }
      });
    }
  }
}
check(
  `all ${hostileChecked} hostile argument placements were refused (${hostileRefused}) or ` +
    `stayed inside their parameter (${hostileContained})`,
  escapes.length === 0,
  escapes.slice(0, 6).join('\n')
);
// Both outcomes must actually occur, or the loop above proved nothing: all
// refusals would mean the operations never build, and all containments would
// mean no validator rejects anything.
check(
  'and both outcomes occurred — the loop is neither refusing everything nor validating nothing',
  hostileRefused > 0 && hostileContained > 0,
  `refused ${hostileRefused}, contained ${hostileContained}`
);

/** A value this field will accept, so other fields can be exercised. */
function validFor(op, field) {
  // `id` is tested BEFORE the /Id$/ suffix rule. The suffix rule matches the
  // bare name `id` too, which handed `atlassian_fetch_resource` a plain number
  // where it wanted an ARI — the operation then refused every argument and
  // section 5's positive control caught it, which is what a positive control is
  // for.
  if (field === 'id') return 'ari:cloud:jira:c4c-523:issue/10301';
  if (/issueKey/i.test(field)) return 'KAN-1';
  if (/projectKey/i.test(field)) return 'KAN';
  if (/Id$/i.test(field)) return '163933';
  if (field === 'limit' || field === 'maxResults') return 5;
  if (field === 'cql') return 'type=page';
  if (field === 'jql') return 'project = KAN';
  if (field === 'query') return 'butchr';
  if (field === 'bodyFormat') return 'storage';
  if (field === 'fields') return 'summary';
  if (field === 'transitionId') return '31';
  return 'x';
}

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
  for (const field of fields) args[field] = validFor(op, field);
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
  for (const field of fields) args[field] = validFor(op, field);
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
  for (const field of fields) args[field] = validFor(op, field);
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
rule('6. only two operations reshape a response, and neither can reach a credential');

const withTransform = PROXY_OPERATIONS.filter((op) => op.transform).map((op) => op.tool);
check(
  'exactly two operations have a transform, and they are the two that cannot avoid one',
  JSON.stringify(withTransform.sort()) ===
    JSON.stringify(['atlassian_get_accessible_resources', 'atlassian_search']),
  JSON.stringify(withTransform)
);
// A transform is given non-secret context and nothing else. Asserted against
// the source, because the type that enforces it is erased at runtime.
const proxySrc = fs.readFileSync(path.join(scriptDir, '..', 'src', 'atlassian-proxy.ts'), 'utf8');
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
const transformCall = routerSrc.match(/operation\.transform\(([\s\S]{0,400}?)\);/)?.[1] ?? '';
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
      `${hostileChecked} hostile argument placements contained, the ARI parsed rather than ` +
      `forwarded, and ${grantedScopes('confluence-read').length} scopes readable off one table.`
);
process.exit(failures ? 1 : 0);
