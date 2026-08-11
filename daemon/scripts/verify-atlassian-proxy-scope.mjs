// KAN-272: the daemon-side Atlassian proxy is off by default, and what it
// grants when it is on is exactly one table of GETs under one scope.
//
// WHAT FAILURE THIS WOULD CATCH: the proxy widening the daemon's credential
// beyond what a reviewer can read off `atlassian-proxy.ts` — an operation that
// takes a REST path from an agent, a write method arriving under a read mode, a
// mode enabling operations tagged for another, or the switch falling *toward*
// on for an unrecognised or truthy value. It would also catch KAN-272's
// criterion 3 being broken in the direction that matters: a merge that leaves
// the proxy serving on a machine where nobody set the switch.
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
  selectedProxyMode
} from '../dist/atlassian-proxy.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
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

check(
  'every proxied operation is a GET',
  PROXY_OPERATIONS.every((op) => op.method === 'GET'),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method !== 'GET').map((op) => op.tool))
);
check(
  'jira-read needs exactly read:jira-work and nothing else',
  JSON.stringify(grantedScopes('jira-read')) === JSON.stringify(['read:jira-work']),
  JSON.stringify(grantedScopes('jira-read'))
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
check(
  'no operation is named for a write action',
  PROXY_OPERATIONS.every(
    (op) => !/^(create|update|delete|add|edit|post|put|patch|set|transition|move|assign)_/i.test(
      op.tool.replace(/^atlassian_/, '')
    )
  ),
  JSON.stringify(PROXY_OPERATIONS.map((op) => op.tool))
);

// Every path an agent can cause. A refusal is a pass; a built path that escapes
// its parameter is the failure this section exists for.
const HOSTILE = [
  '../../../../rest/api/3/myself',
  'KAN-272/../../admin',
  'KAN-272?expand=changelog&x=/rest/api/3/user',
  'KAN-272#/rest/api/3/anything',
  '../..%2f..%2fadmin',
  'KAN 272',
  '',
  'NOT-A-KEY-AT-ALL',
  'kan-272/transitions'
];
for (const hostile of HOSTILE) {
  const built = operationByTool('atlassian_get_issue').build({ issueKey: hostile });
  const escaped =
    'path' in built && !/^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]*-\d+\?fields=[^/?#]*$/.test(built.path);
  check(
    `issueKey ${JSON.stringify(hostile.slice(0, 34))} cannot escape its parameter`,
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
  'an on report enumerates every operation with its scope and path shape',
  onReport.operations.length === PROXY_OPERATIONS.length &&
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

// The reversal KAN-272 authorises is deliberately not spent in this change, and
// this is the assertion that keeps that true as the file is edited.
const jiraSrc = fs.readFileSync(path.join(daemonDir, 'src', 'jira.ts'), 'utf8');
check(
  'jira.ts still has no write method — the authorised reversal is unspent here',
  !/\b(method|Method)\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(jiraSrc) &&
    !/method:\s*['"]POST['"]/.test(jiraSrc),
  'a write reached the transport: KAN-272 says the two halves land separately'
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — off by default, the instrument that says so was shown to say yes as well, ' +
        'and the grant is three GETs under read:jira-work with no path an agent can name'
  }\n`
);
process.exit(failures ? 1 : 0);
