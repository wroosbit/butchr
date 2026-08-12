// KAN-272: the daemon-side Atlassian proxy is off by default, and its READ mode
// grants exactly one table of GETs under one scope.
//
// KAN-291 added a write mode, and this file deliberately did not grow to cover
// it. What it now owns is the property that a write must not disturb: **the
// read grant is unchanged** — `jira-read` is the same GETs under the same
// `read:jira-work` it was before, so an operator who granted it granted no more
// than they thought. Who may write, to what, and under what scope is
// `verify-atlassian-proxy-write-scope.mjs`, which is where a widening of the
// write mode goes red. Sections 1–4 here run over the whole table, so a write
// tagged into a read mode still fails in this file.
//
// WHAT FAILURE THIS WOULD CATCH: the proxy widening the daemon's credential
// beyond what a reviewer can read off `atlassian-proxy.ts` — an operation that
// takes a REST path from an agent, a write method arriving under a read mode, a
// mode enabling operations tagged for another, or the switch falling *toward*
// on for an unrecognised or truthy value. It would also catch KAN-272's
// criterion 3 being broken in the direction that matters: a merge that leaves
// the proxy serving on a machine where nobody set the switch.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── WHY THE REFUSALS NEED A POSITIVE CONTROL ────────────────────────────────
//
// Most of this file asserts that something is refused, and a refusal is what a
// broken instrument produces too. If `refuseProxyCall` returned a refusal for
// every input — a one-character bug — sections 1, 2 and 4 would all pass for a
// reason with nothing to do with the switch, and the file would read as a clean
// bill of health for a proxy that had stopped working entirely. That is the
// KAN-145 defect wearing this ticket's clothes.
//
// So section 3 is not a fourth test. It is what licenses the other three: the
// same call, the same table, the same builders, shown to produce a path and a
// null refusal when the mode is on. Every "it refused" below is measured on an
// instrument shown in the same run to be capable of saying yes.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// This one is pure: it imports the module and calls it. It touches no daemon,
// no socket, no credential and no network, which is what makes it fast and
// unflaky — and it means it proves NOTHING about whether the daemon actually
// consults any of this. A `router.ts` that never called `refuseProxyCall` would
// leave every assertion here green. That gap is owned by name:
//
//   - `daemon/scripts/verify-atlassian-proxy-failure-is-loud.mjs` stands up a
//     real daemon and a real `mcp.ts` under a temporary $HOME and drives the
//     whole chain over real MCP stdio, including with the switch off. It is the
//     one that can fail if the wiring is wrong; this one cannot.
//   - Section 5 here reads `router.ts` and `mcp.ts` for the two structural
//     properties a live run cannot distinguish: that the gate is in the daemon
//     and that `mcp.ts` does not read the switch itself.
//
// Usage: node daemon/scripts/verify-atlassian-proxy-scope.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  PROXY_ENV_VAR,
  PROXY_OPERATIONS,
  PROXY_SEARCH_MAX_RESULTS,
  grantedScopes,
  operationByTool,
  operationsFor,
  proxyReport,
  refuseProxyCall,
  scopesOf,
  selectedProxyMode
} from '../dist/atlassian-proxy.js';
import {
  HOSTILE,
  sweepHostileInput,
  unencodedPathInterpolations,
  zeroContainmentArguments
} from './lib/proxy-hostile-input.mjs';
import { requireFreshDist } from './lib/require-fresh-dist.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

// Before anything is asserted on the modules imported above: this script reads
// `../dist/`, so a stale build would measure the old code and print a pass
// indistinguishable from a real one. Exits 2 — a setup guard, not a verdict.
requireFreshDist(path.join(daemonDir, 'src'), path.join(daemonDir, 'dist'), {
  hint: 'npm run build --prefix daemon'
});

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

// ── 1. off by default ──────────────────────────────────────────────────────
rule('1. off by default — an unset, empty or unreadable switch serves nothing');

for (const env of [{}, { [PROXY_ENV_VAR]: '' }, { [PROXY_ENV_VAR]: '   ' }]) {
  const decision = selectedProxyMode(env);
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(env[PROXY_ENV_VAR] ?? undefined)} is off`,
    decision.mode === 'off',
    JSON.stringify(decision)
  );
}

// Truthiness is the tempting bug: `if (process.env.X)` selects the proxy for
// every one of these, and each would be a fleet-wide widening by typo.
for (const value of ['1', 'true', 'yes', 'on', 'jira', 'jira_read', 'jiraread', 'JIRA-READ!', 'read']) {
  const decision = selectedProxyMode({ [PROXY_ENV_VAR]: value });
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(value)} does NOT enable the proxy`,
    decision.mode === 'off',
    JSON.stringify(decision)
  );
}
const typo = selectedProxyMode({ [PROXY_ENV_VAR]: 'jira_read' });
check(
  'a misspelling carries its reason rather than failing silently',
  typeof typo.fallbackReason === 'string' && typo.fallbackReason.includes('jira_read'),
  JSON.stringify(typo.fallbackReason)
);
check(
  'off exposes no operations at all',
  operationsFor('off').length === 0 && grantedScopes('off').length === 0,
  JSON.stringify({ ops: operationsFor('off').length, scopes: grantedScopes('off') })
);

// ── 2. every call is refused while off ─────────────────────────────────────
rule('2. while off, every call is refused — including tools that really exist');

for (const op of PROXY_OPERATIONS) {
  const refusal = refuseProxyCall('off', op.tool);
  check(
    `${op.tool} is refused when the proxy is off`,
    refusal !== null && refusal.reason === 'proxy-off',
    JSON.stringify(refusal)
  );
}
const offRefusal = refuseProxyCall('off', 'atlassian_get_issue');
check(
  'the refusal names the switch, so an operator knows what to set',
  offRefusal.error.includes(PROXY_ENV_VAR),
  offRefusal.error
);
check(
  "the refusal tells the agent it is not cut off from Jira — it still has its own session",
  /own Atlassian MCP tools/.test(offRefusal.error),
  offRefusal.error
);
check(
  'an unknown tool while off gets the same refusal, revealing no operation names',
  refuseProxyCall('off', 'atlassian_delete_everything')?.reason === 'proxy-off',
  JSON.stringify(refuseProxyCall('off', 'atlassian_delete_everything'))
);

// ── 3. THE POSITIVE CONTROL ────────────────────────────────────────────────
rule('3. positive control — the same table DOES say yes when the switch is on');

for (const value of ['jira-read', 'JIRA-READ', '  jira-read  ']) {
  const decision = selectedProxyMode({ [PROXY_ENV_VAR]: value });
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(value)} selects jira-read`,
    decision.mode === 'jira-read' && decision.source === 'environment',
    JSON.stringify(decision)
  );
}
check(
  'jira-read exposes operations — so sections 1, 2 and 4 measured a real absence',
  operationsFor('jira-read').length > 0,
  'the mode enables nothing even when on: every "it refused" above is vacuous, and this ' +
    'file is worthless rather than reassuring'
);
for (const op of PROXY_OPERATIONS) {
  check(
    `${op.tool} is permitted when its own mode is on`,
    refuseProxyCall(op.mode, op.tool) === null,
    JSON.stringify(refuseProxyCall(op.mode, op.tool))
  );
}
const okPath = operationByTool('atlassian_get_issue').build({ issueKey: 'KAN-272' });
check(
  'and a good argument really does build a path',
  okPath.path === '/rest/api/3/issue/KAN-272?fields=status%2Csummary%2Cissuetype%2Cassignee%2Cparent%2Cupdated%2Cissuelinks',
  JSON.stringify(okPath)
);

// ── 4. the granted scope, and what an agent can reach with it ──────────────
rule('4. the grant — GETs only, one scope, and no way for an agent to name a path');

// KAN-291 re-pointed this section rather than relaxing it. It used to assert
// that every operation in the table was a GET; a write exists now, so that
// sentence is false and keeping it would have meant deleting a check. What
// replaced it is the property that actually matters and which survives the
// change: **the read mode is still GETs only**, so an operator who grants
// `jira-read` grants exactly what they granted before this ticket.
check(
  'every operation in jira-read is a GET — the read mode did not acquire a write',
  operationsFor('jira-read').every((op) => op.method === 'GET'),
  JSON.stringify(operationsFor('jira-read').filter((op) => op.method !== 'GET').map((op) => op.tool))
);
// KAN-293 re-pointed this one for KAN-291's own stated reason, and the wording
// it replaced was written in anticipation of exactly this: *"there is
// deliberately no PUT, PATCH or DELETE: the operations that need them are
// content edits, which are KAN-293's and which should have to widen this union
// rather than slip in under a method it already allows."* They needed it, the
// union was widened deliberately, and this is the check being re-pointed rather
// than deleted.
//
// **The property that survives is the one that was always the point: NOTHING
// HERE DELETES.** A PUT replaces content that a version number and an audit
// line both account for; a DELETE destroys something no proxy of ours should be
// able to destroy, and no operation in this table has ever needed one.
check(
  'no operation uses DELETE — the table can change content and cannot destroy it',
  PROXY_OPERATIONS.every((op) => op.method === 'GET' || op.method === 'POST' || op.method === 'PUT'),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => !['GET', 'POST', 'PUT'].includes(op.method)).map((o) => [o.tool, o.method]))
);
check(
  'PUT appears on exactly the two operations that replace a document, and nowhere else',
  PROXY_OPERATIONS.filter((op) => op.method === 'PUT').map((op) => op.tool).sort().join(',') ===
    'atlassian_edit_issue,atlassian_update_confluence_page',
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method === 'PUT').map((op) => op.tool))
);
// KAN-292 re-pointed this one, and the honest thing is to say that it moved
// rather than to present the new list as though it had always been there.
//
// It used to read "jira-read needs exactly read:jira-work and nothing else",
// and that was true of the three operations KAN-272 shipped. This slice adds
// six more Jira reads, two of which — `atlassian_get_user_info` and
// `atlassian_lookup_account_id` — read the **user directory** rather than issue
// data. That is `read:jira-user`, a different scope, and rounding it into
// `read:jira-work` because both start with `read:` is precisely the quiet
// widening `grantedScopes` exists to expose.
//
// So the check is not relaxed: it is still an EXACT list, and it still fails
// the moment a seventh scope appears. What changed is which list, and the
// change is visible in this diff rather than inferrable from a passing run.
//
// Note what is NOT here: no `write:` scope, and nothing Confluence. Those are
// asserted separately below and in verify-atlassian-proxy-write-scope.mjs.
check(
  'jira-read needs exactly read:jira-work and read:jira-user — the two Jira reads, and no more',
  JSON.stringify(grantedScopes('jira-read')) ===
    JSON.stringify(['read:jira-user', 'read:jira-work']),
  JSON.stringify(grantedScopes('jira-read'))
);
// The rung above it. Stated as its own exact list for the same reason: the way
// a mode acquires a scope nobody granted is by one operation being tagged into
// it, and an exact comparison is the only thing that notices.
check(
  'confluence-read needs exactly the Jira reads plus the three Confluence read scopes',
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
// The property that survives every rung being added: a READ mode never needs a
// WRITE scope. This is the one that would matter most if it broke, because
// nothing about the tool list would look different.
for (const mode of ['jira-read', 'confluence-read']) {
  check(
    `${mode} requires no write scope at all`,
    !grantedScopes(mode).some((scope) => /^write:/.test(scope)),
    JSON.stringify(grantedScopes(mode))
  );
}
// An operation that declares no scope is legitimate — `/_edge/tenant_info` is
// unauthenticated site metadata — but exactly one operation may do it, and a
// second appearing silently is far more likely to be a forgotten field than a
// second genuinely unauthenticated endpoint.
const scopeless = PROXY_OPERATIONS.filter((op) => scopesOf(op).length === 0);
check(
  'exactly one operation declares no scope, and it is the unauthenticated site-metadata read',
  scopeless.length === 1 && scopeless[0].tool === 'atlassian_get_accessible_resources',
  JSON.stringify(scopeless.map((op) => op.tool))
);
// And no scope is a compound string. This is here because the first draft of
// this slice wrote a two-scope operation as `'read:jira-work read:confluence-
// content.all'`, which type-checked, read correctly to a human, and defeated
// the deduplication in `grantedScopes` — the enumeration grew an entry rather
// than reusing the two it already had. A scope with a space in it is always
// this bug.
check(
  'no scope is a space-joined compound — the list is the list',
  PROXY_OPERATIONS.every((op) => scopesOf(op).every((scope) => !/\s/.test(scope))),
  JSON.stringify(PROXY_OPERATIONS.flatMap((op) => scopesOf(op).filter((s) => /\s/.test(s))))
);
check(
  'no operation accepts a path, url, endpoint or method argument',
  PROXY_OPERATIONS.every(
    (op) =>
      !Object.keys(op.inputSchema.properties ?? {}).some((name) =>
        /^(path|url|uri|endpoint|method|rest|body)$/i.test(name)
      )
  ),
  JSON.stringify(PROXY_OPERATIONS.map((op) => Object.keys(op.inputSchema.properties ?? {})))
);
// The verb, not the noun. `atlassian_get_transitions` READS the transitions
// available on an issue and performs none — a substring match on "transition"
// calls that a write and is exactly the sloppiness that makes a check get
// deleted rather than fixed. What is checked is the leading verb.
//
// KAN-291 made this two-directional, which is the form it should always have
// had. A name is a claim about what a tool does, and a claim can be wrong in
// either direction: a read named `transition_` misleads an operator reading the
// grant, and — the one that matters more — a **write** named `get_` hides
// itself in the middle of a list of reads. Asserting only the first would let
// `atlassian_get_issue_status_updated` be a POST.
const WRITE_VERB = /^(create|update|delete|add|edit|post|put|patch|set|transition|move|assign)_/i;
const shortName = (op) => op.tool.replace(/^atlassian_/, '');
check(
  'no READ operation is named for a write action',
  PROXY_OPERATIONS.filter((op) => op.method === 'GET').every((op) => !WRITE_VERB.test(shortName(op))),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method === 'GET').map((op) => op.tool))
);
check(
  'every WRITE operation is named for one — a write cannot hide among the reads',
  PROXY_OPERATIONS.filter((op) => op.method !== 'GET').every((op) => WRITE_VERB.test(shortName(op))),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method !== 'GET').map((op) => op.tool))
);

// Every path an agent can cause, over EVERY operation. A refusal is a pass; a
// built path that escapes its parameter is the failure this section exists for.
//
// KAN-292 WIDENED THIS FROM TWO OPERATIONS TO ALL OF THEM, at review, and the
// reason is worth keeping because it is the general shape of how a guard goes
// stale without anybody editing it.
//
// This section used to hand hostile values to `atlassian_get_issue` and
// `atlassian_search_issues` and to nothing else, asserting each built path
// against a regex written for that one operation. **That was complete when the
// table had three entries.** The table now has twenty-two, and the twenty this
// section did not reach included `atlassian_fetch_resource` and
// `atlassian_search` — the two operations KAN-292's own ticket names as the
// most likely to open a hole, and the two with the most intricate containment
// in the file. Nothing had broken. The guard had simply stopped being a guard
// over most of what it was guarding, and every run stayed green throughout.
//
// `epic/KAN-39` asked for this at review of #127, having verified the property
// by reading all twelve path interpolations — and said plainly that reading the
// source is a weaker kind of evidence than a red, which is the argument for
// putting the coverage here rather than leaving it as a review finding.
//
// The corpus and the checker are `lib/proxy-hostile-input.mjs`, shared with
// `verify-atlassian-proxy-read-surface.mjs` so the two cannot drift apart. See
// that module on why containment is measured by URL RESOLUTION against a
// derived template prefix rather than by grepping the path for `..`.
const sweep = sweepHostileInput(PROXY_OPERATIONS);
check(
  `every argument of all ${PROXY_OPERATIONS.length} operations, against ${HOSTILE.length} hostile ` +
    `values: ${sweep.checked} placements, ${sweep.refused} refused and ${sweep.contained} ` +
    'contained, none escaped',
  sweep.escapes.length === 0,
  sweep.escapes.slice(0, 8).join('\n')
);
// Both outcomes must occur, or the sweep above proved nothing: all-refused
// would mean the operations never build, and all-contained would mean no
// validator rejects anything.
check(
  'and the sweep both refused and contained — it is neither rejecting everything nor validating nothing',
  sweep.refused > 0 && sweep.contained > 0,
  `refused ${sweep.refused}, contained ${sweep.contained}`
);
// KAN-311: that assertion is global, and global is not where a path is built.
// An argument whose validator refuses all twelve hostile values contributes
// zero containment evidence — the sweep measured its validator and never its
// interpolation. The list is a report rather than a failure, because refusing
// everything is correct for a strict validator on an argument with no free-text
// form; what covers those arguments is the encoding check directly below.
// `verify-atlassian-proxy-read-surface.mjs` section 2b records the full
// decision and what was rejected.
const zeroContainment = zeroContainmentArguments(sweep);
console.log(
  `   NOTE  ${zeroContainment.length} of ${sweep.perArgument.length} arguments contributed zero ` +
    'contained placements — validator measured, encoding not:'
);
for (const tally of zeroContainment) {
  console.log(`           ${tally.tool}.${tally.field} — refused ${tally.refused}/${tally.checked}`);
}
check(
  'at least one argument contributed containment — the sweep exercised a real interpolation',
  zeroContainment.length < sweep.perArgument.length,
  `all ${sweep.perArgument.length} arguments refused everything`
);
// The second mechanism, checked where it is visible. A path whose argument is
// strictly validated can lose its `encodeURIComponent` without a single
// placement above changing — the built path is byte-identical, because the
// validator only ever lets through characters the encoder would not touch. So
// the encoding is read off the source, and this is what keeps the count of
// mechanisms at two rather than silently at one.
const bareInterpolations = unencodedPathInterpolations(
  fs.readFileSync(path.join(daemonDir, 'src', 'atlassian-proxy.ts'), 'utf8')
);
check(
  'every interpolation into a path is encoded, or is a bounded number or a narrowed literal',
  bareInterpolations.length === 0,
  bareInterpolations
    .map((b) => `atlassian-proxy.ts:${b.line}  \${${b.expression}} reaches a path unencoded`)
    .join('\n')
);
// The two operations this section used to cover, kept as explicit shape
// assertions on top of the sweep. The sweep proves a path cannot leave its
// template; these prove the template is the one KAN-272 documented, which is a
// different claim and the one a reader of the grant is making.
for (const hostile of HOSTILE) {
  const built = operationByTool('atlassian_get_issue').build({ issueKey: hostile });
  const escaped =
    'path' in built && !/^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]*-\d+\?fields=[^/?#]*$/.test(built.path);
  check(
    `issueKey ${JSON.stringify(String(hostile).slice(0, 34))} keeps atlassian_get_issue's documented shape`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}
for (const hostile of ['status,summary#/rest/api/3/myself', 'a/../../b', '*all&maxResults=9999']) {
  const built = operationByTool('atlassian_get_issue').build({ issueKey: 'KAN-1', fields: hostile });
  const escaped = 'path' in built && !/^\/rest\/api\/3\/issue\/KAN-1\?fields=[^/?#]*$/.test(built.path);
  check(
    `fields ${JSON.stringify(hostile.slice(0, 34))} cannot escape its parameter`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}

// The search bound. A proxy that let one agent ask for the whole account is a
// different grant from the one this table describes.
for (const asked of [10_000, 999, PROXY_SEARCH_MAX_RESULTS + 1, 'lots', -5, NaN]) {
  const built = operationByTool('atlassian_search_issues').build({ jql: 'project = KAN', maxResults: asked });
  const got = Number(String(built.path ?? '').match(/maxResults=(\d+)/)?.[1] ?? -1);
  check(
    `maxResults=${JSON.stringify(asked)} is bounded at ${PROXY_SEARCH_MAX_RESULTS}`,
    got >= 1 && got <= PROXY_SEARCH_MAX_RESULTS,
    JSON.stringify(built)
  );
}
check(
  'a JQL query is percent-encoded into its parameter',
  operationByTool('atlassian_search_issues')
    .build({ jql: 'project = KAN AND status = "In Review"' })
    .path.startsWith('/rest/api/3/search/jql?jql=project%20%3D%20KAN'),
  JSON.stringify(operationByTool('atlassian_search_issues').build({ jql: 'project = KAN AND status = "In Review"' }))
);

// ── 5. the report, and where the gate lives ────────────────────────────────
rule('5. the report is derived from the decision, and the gate is in the daemon');

const offReport = proxyReport(selectedProxyMode({}), { configured: true, siteUrl: 'https://x.atlassian.net', email: 'a@b.c' });
check('an off report carries no operations', offReport.operations.length === 0, JSON.stringify(offReport.operations));
check('an off report carries no scopes', offReport.scopes.length === 0, JSON.stringify(offReport.scopes));
check('an off report says so in one line', /is OFF/.test(offReport.summary), offReport.summary);
check(
  'the report never carries a token, under any key',
  !JSON.stringify(offReport).toLowerCase().includes('token'),
  JSON.stringify(offReport)
);

const onReport = proxyReport(selectedProxyMode({ [PROXY_ENV_VAR]: 'jira-read' }), { configured: true, siteUrl: 'https://x.atlassian.net', email: 'a@b.c' });
check(
  'an on report enumerates every operation of its mode with scope and path shape',
  onReport.operations.length === operationsFor('jira-read').length &&
    onReport.operations.every((op) => op.scope && op.pathShape && op.method),
  JSON.stringify(onReport.operations)
);
check(
  "the report's operations are the mode's operations, not a second table",
  JSON.stringify(onReport.operations.map((o) => o.tool)) ===
    JSON.stringify(operationsFor('jira-read').map((o) => o.tool)),
  JSON.stringify(onReport.operations.map((o) => o.tool))
);
check(
  'the summary refuses to let tool presence read as a working credential',
  /listed tool is not a working one/.test(onReport.summary),
  onReport.summary
);
const noCred = proxyReport(selectedProxyMode({ [PROXY_ENV_VAR]: 'jira-read' }), { configured: false });
check(
  'on with no credential says every call will refuse, rather than looking healthy',
  /NO CONFIGURED CREDENTIAL/.test(noCred.summary),
  noCred.summary
);

// The wiring, read off the sources. A live run cannot tell "the gate is in the
// daemon" from "the gate is in mcp.ts and happens to agree today".
const routerSrc = fs.readFileSync(path.join(daemonDir, 'src', 'router.ts'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');
check(
  'router.ts consults the switch on every proxied call',
  /handleAtlassianProxyCall[\s\S]{0,2000}selectedProxyMode\(\)/.test(routerSrc),
  'the call handler no longer reads the mode: the switch would only affect what is advertised'
);
check(
  'router.ts refuses through refuseProxyCall rather than an inline condition',
  /refuseProxyCall\(decision\.mode, tool\)/.test(routerSrc),
  'a second copy of the refusal rule is a second thing to get wrong'
);
check(
  'router.ts builds the path from the operation, never from the request body',
  /operation\.build\(args\)/.test(routerSrc) && !/data\.path/.test(routerSrc),
  'a path taken off the wire makes the granted scope unbounded'
);
// The fourth, asked for by `epic/KAN-39` at review of KAN-291 and in the shape
// of the three above. Those guard KAN-272's machinery — the switch, the
// refusal, the path — and the write policy is the newest thing standing between
// a *declared* rule and an *enforced* one, on the first write scope this daemon
// has ever held, with 29 more tools queued behind it in KAN-292 and KAN-293.
//
// It is a second home for a property `verify-atlassian-proxy-write-scope.mjs`
// §6 also asserts, and the duplication is deliberate rather than an oversight:
// this file is the one a reader opens to ask "what does the proxy grant and
// what enforces it", and a router section that guards three call sites while
// silently omitting the fourth reads as though there were only three.
check(
  'router.ts refuses a foreign write through refuseWriteOutsideCaller, not an inline condition',
  /refuseWriteOutsideCaller\(operation,\s*args,\s*callerIdentity\)/.test(routerSrc),
  'the write policy is declared in atlassian-proxy.ts and not applied by the handler: any ' +
    "agent can transition any issue the credential can reach. See verify-atlassian-proxy-" +
    'write-scope.mjs §5 for the policy itself and §6 for the same call site in the build.'
);
// An invocation, not a mention. `mcp.ts` names `selectedProxyMode` in a comment
// explaining why it does not call it, and a bare substring match would make
// documenting the decision the thing that fails the check on it.
check(
  'mcp.ts does NOT read the switch itself — one reader, in the daemon',
  !/selectedProxyMode\s*\(/.test(mcpSrc) && !/PROXY_ENV_VAR/.test(mcpSrc),
  "mcp.ts reads its own environment, which is not the daemon's: the tool list and the gate " +
    'would then be answers about two different machines'
);
check(
  'mcp.ts forwards a proxied call rather than deciding it',
  /callDaemonAPI\('atlassian_proxy_call'/.test(mcpSrc),
  JSON.stringify(mcpSrc.includes('atlassian_proxy_call'))
);

// ── the transport boundary, which moved on 2026-08-11 ──────────────────────
//
// KAN-272 left the authorised reversal unspent and asserted that here:
//
//     'jira.ts still has no write method — the authorised reversal is unspent
//      here', !/\b(method|Method)\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/…
//
// KAN-291 is the ticket that spends it, so that assertion had to be replaced.
// **Worth recording before it is deleted: when the write landed, it did not go
// red.** `jira.ts` now POSTs, and the old regex still passed — it looked for
// the literal spelling `method: 'POST'`, and the write arrived as
// `this.request('POST', …)` behind a `method: 'GET' | 'POST'` union, which that
// pattern does not match. It was a check on one spelling of a write, not on the
// presence of one, and had this ticket relied on it to notice a widening it
// would have been told everything was fine.
//
// So its replacement does not ask whether a write *exists* — one does, on
// purpose. It asserts the shape of the boundary that now holds: **POST and
// nothing else**, with the verbs that would let an agent destroy or overwrite
// still absent from this file entirely.
//
// KAN-293 re-points it once more, and the note above about *how* it failed to
// go red is the reason the replacement is written the way it is. `PUT` is now
// legitimately present — two operations replace a document — so the list of
// forbidden spellings loses `PUT` and keeps the two that matter. **A DELETE or
// a PATCH reaching this transport is still a widening nobody authorised**, and
// unlike the original this is not a check on one spelling: `PATCH` and `DELETE`
// cannot reach `fetch` here by any route without one of these literals
// appearing, because the verb is threaded through as a typed parameter whose
// union does not contain them.
const jiraSrc = fs.readFileSync(path.join(daemonDir, 'src', 'jira.ts'), 'utf8');
const forbiddenVerbs = ["'PATCH'", "'DELETE'", '"PATCH"', '"DELETE"'].filter((verb) =>
  jiraSrc.includes(verb)
);
check(
  'jira.ts has no PATCH or DELETE — the transport can write and cannot destroy',
  forbiddenVerbs.length === 0,
  `found ${JSON.stringify(forbiddenVerbs)}: a deletion reached the transport, which is a ` +
    'widening well past the content writes KAN-293 authorises'
);
check(
  "the transport's write verb is a closed union, so a third verb cannot be passed in",
  /method: 'POST' \| 'PUT'/.test(jiraSrc),
  'the verb arrives as data now (KAN-293), so the union on it is what keeps DELETE out — ' +
    'a widened union would let a caller name a verb this table never granted'
);
check(
  'the write reaches Atlassian only through a body the caller did not supply',
  /JSON\.stringify\(requestBody/.test(jiraSrc) && !/JSON\.parse\([^)]*args/.test(jiraSrc),
  'the transport serialises an object built by the operation table; a pre-serialised string ' +
    'or a body assembled from arguments would put the grant back in the caller\'s hands'
);
// And the property the old assertion was reaching for, checked where it can
// actually be read: the daemon's own domain operations are still reads. The
// poller and the reconciler must not have quietly gained the ability to write
// on the daemon's own account — only the proxy writes, and only when asked.
check(
  'only the proxy writes — no domain method on the client writes',
  (jiraSrc.match(/this\.transport\.write\(/g) ?? []).length === 1,
  'more than one call site writes: ' +
    JSON.stringify(jiraSrc.match(/.*this\.transport\.write\(.*/g)) +
    ' — the daemon is meant to write only what an agent asked it to'
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — off by default, the instrument that says so was shown to say yes as well, and ' +
        `jira-read is ${operationsFor('jira-read').length} GETs under ` +
        `${grantedScopes('jira-read').join(', ')} with no path an agent can name. The write ` +
        'mode is verify-atlassian-proxy-write-scope.mjs\'s to police.'
  }\n`
);
process.exit(failures ? 1 : 0);
