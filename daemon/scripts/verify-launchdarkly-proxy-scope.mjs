// KAN-298: the daemon-side LaunchDarkly proxy is off by default, serves exactly
// the ten operations LaunchDarkly itself classifies as reads, and has no write
// of any kind.
//
// WHAT FAILURE THIS WOULD CATCH: a write operation reaching the LaunchDarkly
// proxy — the one thing this ticket decided against, on the finding that the
// daemon's stored credential holds account-admin authority and that no
// LaunchDarkly resource belongs to a calling agent the way a Jira ticket does,
// so no policy could bound such a write. It would also catch the containment
// coming apart in the four ways it can: an operation that takes a REST path or a
// raw query string from an agent, a path parameter that escapes its segment, a
// query parameter reaching LaunchDarkly without passing the operation's own
// allowlist, and the switch falling *toward* on for an unrecognised or truthy
// value. And it would catch the plan-limited 403 being reported as a credential
// fault, which would send a human to replace a perfectly good token while every
// agent on the fleet was told its shared credential had died.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── WHY THE REFUSALS NEED A POSITIVE CONTROL ────────────────────────────────
//
// Most of this file asserts that something is refused, and a refusal is what a
// broken instrument produces too. If `refuseLdProxyCall` returned a refusal for
// every input — a one-character bug — sections 1, 2 and 5 would all pass for a
// reason with nothing to do with the switch, and the file would read as a clean
// bill of health for a proxy that had stopped working entirely. That is KAN-145's
// defect wearing this ticket's clothes.
//
// So section 3 is not a fourth test. It is what licenses the others: the same
// call, the same table, the same builders, shown to produce a path and a null
// refusal when the mode is on. Every "it refused" below is measured on an
// instrument shown in the same run to be capable of saying yes.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// **This script supplies every input it then asserts on**, which is the KAN-145
// shape and has to be said rather than left to be found. It imports the module
// and calls it: it touches no daemon, no socket, no credential and no network,
// which is what makes it fast and unflaky — and it means it proves NOTHING about
// whether the daemon actually consults any of this. A `router.ts` that never
// called `refuseLdProxyCall` would leave every assertion here green.
//
// What covers that gap, by name:
//
//   - **Section 7 reads `router.ts` and `mcp.ts`** for the structural properties
//     a pure unit run cannot distinguish: that the gate is in the daemon, that
//     the path comes from the operation table and never off the wire, and that
//     `mcp.ts` does not read the switch itself.
//   - **Section 4 holds this table against the vendor's own classification.** It
//     is the one section whose authority comes from outside this repository:
//     `LD_READ_SCOPE_TOOLS` is what `@launchdarkly/mcp-server --scope read`
//     mounts, enumerated from a live `tools/list`. It is a **captured** constant
//     rather than a live probe — CI has no network and `npx` on the critical
//     path is exactly the flakiness that keeps scripts out of CI — so it is
//     evidence with a date on it, not a live oracle. It is checked against a
//     rerun of that enumeration at review time and the reproduction command is
//     in `launchdarkly-proxy.ts` beside the constant.
//   - **Nothing here observes a real LaunchDarkly call**, and nothing in CI can:
//     that needs the daemon's credential. The ten real calls are pasted in the
//     PR, made against the live API, and that observation is what covers the
//     "does the path this table builds actually address the endpoint it claims"
//     gap. **No script owns that**, and it is the honest edge of this one.
//
// Usage: node daemon/scripts/verify-launchdarkly-proxy-scope.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  LD_PROXY_ENV_VAR,
  LD_PROXY_MAX_LIMIT,
  LD_PROXY_MODES,
  LD_PROXY_OPERATIONS,
  LD_READ_SCOPE_TOOLS,
  LD_WRITE_SCOPE_TOOLS,
  ldGrantedScopes,
  ldOperationByTool,
  ldOperationsFor,
  ldProxyReport,
  refuseLdProxyCall,
  selectedLdProxyMode
} from '../dist/launchdarkly-proxy.js';
import { explainLdProxyFailure } from '../dist/integrations/launchdarkly.js';

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

for (const env of [{}, { [LD_PROXY_ENV_VAR]: '' }, { [LD_PROXY_ENV_VAR]: '   ' }]) {
  const decision = selectedLdProxyMode(env);
  check(
    `${LD_PROXY_ENV_VAR}=${JSON.stringify(env[LD_PROXY_ENV_VAR] ?? undefined)} is off`,
    decision.mode === 'off',
    JSON.stringify(decision)
  );
}

// Truthiness is the tempting bug: `if (process.env.X)` selects the proxy for
// every one of these, and each would be a fleet-wide widening by typo.
for (const value of [
  '1',
  'true',
  'yes',
  'on',
  'launchdarkly',
  'launchdarkly_read',
  'launchdarklyread',
  'LAUNCHDARKLY-READ!',
  'read',
  // The one that would matter most: a mode this proxy does not have, spelled
  // the way somebody who had read the Atlassian file would spell it.
  'launchdarkly-write'
]) {
  const decision = selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: value });
  check(
    `${LD_PROXY_ENV_VAR}=${JSON.stringify(value)} does NOT enable the proxy`,
    decision.mode === 'off',
    JSON.stringify(decision)
  );
}
const typo = selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: 'launchdarkly_read' });
check(
  'a misspelling carries its reason rather than failing silently',
  typeof typo.fallbackReason === 'string' && typo.fallbackReason.includes('launchdarkly_read'),
  JSON.stringify(typo.fallbackReason)
);
check(
  'off exposes no operations at all',
  ldOperationsFor('off').length === 0 && ldGrantedScopes('off').length === 0,
  JSON.stringify({ ops: ldOperationsFor('off').length, scopes: ldGrantedScopes('off') })
);

// ── 2. every call is refused while off ─────────────────────────────────────
rule('2. while off, every call is refused — including tools that really exist');

for (const op of LD_PROXY_OPERATIONS) {
  const refusal = refuseLdProxyCall('off', op.tool);
  check(
    `${op.tool} is refused when the proxy is off`,
    refusal !== null && refusal.reason === 'proxy-off',
    JSON.stringify(refusal)
  );
}
const offRefusal = refuseLdProxyCall('off', 'launchdarkly_list_feature_flags');
check(
  'the refusal names the switch, so an operator knows what to set',
  offRefusal.error.includes(LD_PROXY_ENV_VAR),
  offRefusal.error
);
check(
  'an unknown tool while off gets the same refusal, revealing no operation names',
  refuseLdProxyCall('off', 'launchdarkly_delete_everything')?.reason === 'proxy-off',
  JSON.stringify(refuseLdProxyCall('off', 'launchdarkly_delete_everything'))
);

// ── 3. THE POSITIVE CONTROL ────────────────────────────────────────────────
rule('3. positive control — the same table DOES say yes when the switch is on');

for (const value of ['launchdarkly-read', 'LAUNCHDARKLY-READ', '  launchdarkly-read  ']) {
  const decision = selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: value });
  check(
    `${LD_PROXY_ENV_VAR}=${JSON.stringify(value)} selects launchdarkly-read`,
    decision.mode === 'launchdarkly-read' && decision.source === 'environment',
    JSON.stringify(decision)
  );
}
check(
  'launchdarkly-read exposes operations — so sections 1, 2 and 5 measured a real absence',
  ldOperationsFor('launchdarkly-read').length > 0,
  'the mode enables nothing even when on: every "it refused" above is vacuous, and this ' +
    'file is worthless rather than reassuring'
);
for (const op of LD_PROXY_OPERATIONS) {
  check(
    `${op.tool} is permitted when its own mode is on`,
    refuseLdProxyCall(op.mode, op.tool) === null,
    JSON.stringify(refuseLdProxyCall(op.mode, op.tool))
  );
}
const okPath = ldOperationByTool('launchdarkly_get_feature_flag').build({
  projectKey: 'butchr',
  featureFlagKey: 'agent-runner',
  env: 'production'
});
check(
  'and a good argument really does build a path',
  okPath.path === '/api/v2/flags/butchr/agent-runner?env=production',
  JSON.stringify(okPath)
);
// Every operation, not just the one above: a builder that refused everything
// would make section 6's hostile inputs pass for the wrong reason.
const GOOD_ARGS = {
  projectKey: 'butchr',
  featureFlagKey: 'agent-runner',
  configKey: 'my-config',
  variationKey: 'v1'
};
for (const op of LD_PROXY_OPERATIONS) {
  const built = op.build(GOOD_ARGS);
  check(
    `${op.tool} builds a path from ordinary arguments`,
    'path' in built && built.path.startsWith('/api/v2/'),
    JSON.stringify(built)
  );
}

// ── 4. THE GRANTED SET, HELD TO LAUNCHDARKLY'S OWN CLASSIFICATION ──────────
rule("4. the granted set is exactly LaunchDarkly's own --scope read set, and no more");

// The direction that catches a widening: nothing we serve may be a tool
// LaunchDarkly calls a write. This is AC6's "no tool outside the granted set is
// offered", checked against the vendor rather than against a list in this file.
const mirrored = LD_PROXY_OPERATIONS.map((op) => op.mirrors);
const writesOffered = mirrored.filter((name) => LD_WRITE_SCOPE_TOOLS.includes(name));
check(
  'NO operation mirrors a tool from LaunchDarkly --scope write',
  writesOffered.length === 0,
  `offered writes: ${JSON.stringify(writesOffered)} — this proxy has no write policy and no ` +
    'resource-to-caller binding that could support one; see launchdarkly-proxy.ts'
);
for (const op of LD_PROXY_OPERATIONS) {
  check(
    `${op.tool} mirrors "${op.mirrors}", which LaunchDarkly --scope read mounts`,
    LD_READ_SCOPE_TOOLS.includes(op.mirrors),
    `"${op.mirrors}" is not in LaunchDarkly's read set: ${JSON.stringify(LD_READ_SCOPE_TOOLS)}`
  );
}
// The other direction, which catches a silent *narrowing*: every read
// LaunchDarkly offers is mirrored. A tool quietly dropped from this table would
// otherwise be invisible — the PR would still say "the read set is mirrored".
const missing = LD_READ_SCOPE_TOOLS.filter((name) => !mirrored.includes(name));
check(
  `all ${LD_READ_SCOPE_TOOLS.length} of LaunchDarkly's read tools are mirrored`,
  missing.length === 0,
  `not mirrored: ${JSON.stringify(missing)} — either mirror it or say in the PR why not`
);
check(
  'no tool is mirrored twice',
  new Set(mirrored).size === mirrored.length,
  JSON.stringify(mirrored)
);
check(
  "LaunchDarkly's read and write sets are disjoint, as measured",
  LD_READ_SCOPE_TOOLS.every((name) => !LD_WRITE_SCOPE_TOOLS.includes(name)),
  'the two captured constants overlap, so section 4 is testing nothing'
);

// ── 5. no write reaches this proxy, by any route ───────────────────────────
rule('5. no write — not by method, not by name, not by mode');

check(
  'every operation in the table is a GET',
  LD_PROXY_OPERATIONS.every((op) => op.method === 'GET'),
  JSON.stringify(LD_PROXY_OPERATIONS.filter((op) => op.method !== 'GET').map((op) => op.tool))
);
// The verb, not the noun. `launchdarkly_get_ai_config_targeting` READS targeting
// and changes nothing — a substring match on "targeting" or "update" calls that
// a write and is the sloppiness that makes a check get deleted rather than
// fixed. What is checked is the leading verb after the prefix.
const WRITE_VERB = /^(create|update|delete|add|edit|post|put|patch|set|remove|archive|toggle)_/i;
const shortName = (op) => op.tool.replace(/^launchdarkly_/, '');
check(
  'no operation is NAMED for a write action',
  LD_PROXY_OPERATIONS.every((op) => !WRITE_VERB.test(shortName(op))),
  JSON.stringify(LD_PROXY_OPERATIONS.map((op) => op.tool).filter((t) => WRITE_VERB.test(t.replace(/^launchdarkly_/, ''))))
);
check(
  'there is no write mode to select',
  !LD_PROXY_MODES.some((mode) => /write/i.test(mode)),
  JSON.stringify(LD_PROXY_MODES)
);
// Asking for a write by its obvious name gets a refusal that explains the
// decision rather than a bare "no such tool" — otherwise an agent reasonably
// concludes it guessed the spelling wrong and tries four more variants.
for (const writeTool of LD_WRITE_SCOPE_TOOLS) {
  const guessed = `launchdarkly_${writeTool.replace(/-/g, '_')}`;
  const refusal = refuseLdProxyCall('launchdarkly-read', guessed);
  check(
    `${guessed} is refused, and the refusal says the omission is deliberate`,
    refusal !== null &&
      refusal.reason === 'unknown-tool' &&
      /deliberately has none/.test(refusal.error),
    JSON.stringify(refusal)
  );
}
check(
  'the report says in one line that there is no write surface',
  /NO WRITE OPERATIONS AND NO WRITE MODE/.test(
    ldProxyReport(selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: 'launchdarkly-read' }), {
      configured: true,
      storage: 'file'
    }).summary
  ),
  ldProxyReport(selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: 'launchdarkly-read' }), { configured: true }).summary
);

// ── 6. an agent names neither a path nor a query parameter ─────────────────
rule('6. containment — no path escapes its segment, and no undeclared parameter travels');

check(
  'no operation accepts a path, url, endpoint, method, query or body argument',
  LD_PROXY_OPERATIONS.every(
    (op) =>
      !Object.keys(op.inputSchema.properties ?? {}).some((name) =>
        /^(path|url|uri|endpoint|method|rest|body|query|querystring)$/i.test(name)
      )
  ),
  JSON.stringify(LD_PROXY_OPERATIONS.map((op) => Object.keys(op.inputSchema.properties ?? {})))
);

// Every path an agent can cause. A refusal is a pass; a built path that escapes
// its parameter is the failure this section exists for.
const HOSTILE_KEYS = [
  '../../../../api/v2/members/me',
  'butchr/../../members',
  'butchr?x=/api/v2/members/me',
  'butchr#/api/v2/anything',
  '..%2f..%2fmembers',
  '.',
  '..',
  'butchr flag',
  '',
  'butchr/agent-runner'
];
for (const hostile of HOSTILE_KEYS) {
  const built = ldOperationByTool('launchdarkly_get_feature_flag').build({
    projectKey: hostile,
    featureFlagKey: 'agent-runner'
  });
  // One and only one shape is acceptable: two encoded segments under /flags/.
  const escaped =
    'path' in built && !/^\/api\/v2\/flags\/[A-Za-z0-9][A-Za-z0-9._-]*\/agent-runner$/.test(built.path);
  check(
    `projectKey ${JSON.stringify(hostile.slice(0, 34))} cannot escape its segment`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}
for (const hostile of HOSTILE_KEYS) {
  const built = ldOperationByTool('launchdarkly_get_ai_config_variation').build({
    projectKey: 'butchr',
    configKey: 'cfg',
    variationKey: hostile
  });
  const escaped =
    'path' in built &&
    !/^\/api\/v2\/projects\/butchr\/ai-configs\/cfg\/variations\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(built.path);
  check(
    `variationKey ${JSON.stringify(hostile.slice(0, 34))} cannot escape its segment`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}

// A query parameter the operation did not declare must not travel, and this is
// the check that distinguishes an allowlist from a filter. `apiKey` is the one
// that matters: LaunchDarkly does not take auth in a query string, but a proxy
// that forwarded unknown parameters would let an agent try.
const undeclared = ldOperationByTool('launchdarkly_get_feature_flag').build({
  projectKey: 'butchr',
  featureFlagKey: 'agent-runner',
  apiKey: 'nope',
  'x-override': 'nope',
  limit: 999,
  spec: 'proj/other'
});
check(
  'parameters the operation does not declare never reach the query string',
  undeclared.path === '/api/v2/flags/butchr/agent-runner',
  `${JSON.stringify(undeclared)} — this operation declares only env and expand, so limit, spec, ` +
    'apiKey and x-override must all be absent rather than filtered out one by one'
);
// And the bound on the ones it does declare.
for (const asked of [10_000, 999, LD_PROXY_MAX_LIMIT + 1, 'lots', -5, NaN]) {
  const built = ldOperationByTool('launchdarkly_list_feature_flags').build({
    projectKey: 'butchr',
    limit: asked
  });
  const got = Number(String(built.path ?? '').match(/limit=(\d+)/)?.[1] ?? -1);
  check(
    `limit=${JSON.stringify(asked)} is bounded at ${LD_PROXY_MAX_LIMIT} or absent`,
    'error' in built || got === -1 || (got >= 1 && got <= LD_PROXY_MAX_LIMIT),
    JSON.stringify(built)
  );
}
// A declared free-text parameter is percent-encoded into its value rather than
// closing it. `spec` is the one that carries slashes and colons by design.
const spec = ldOperationByTool('launchdarkly_get_audit_log_entries').build({
  spec: 'proj/butchr:env/*:flag/agent-runner'
});
check(
  'a free-text parameter is percent-encoded into its value',
  spec.path === '/api/v2/auditlog?spec=proj%2Fbutchr%3Aenv%2F*%3Aflag%2Fagent-runner',
  JSON.stringify(spec)
);
for (const hostile of ['a&limit=99999', 'a#/api/v2/members/me', 'a=b&c=d']) {
  const built = ldOperationByTool('launchdarkly_get_audit_log_entries').build({ q: hostile });
  const escaped = 'path' in built && (built.path.match(/[?&]/g) ?? []).length !== 1;
  check(
    `q ${JSON.stringify(hostile.slice(0, 30))} cannot open a second parameter`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}

// ── 7. the report, and where the gate lives ────────────────────────────────
rule('7. the report is derived from the decision, and the gate is in the daemon');

const offReport = ldProxyReport(selectedLdProxyMode({}), { configured: true, storage: 'file' });
check('an off report carries no operations', offReport.operations.length === 0, JSON.stringify(offReport.operations));
check('an off report carries no scopes', offReport.scopes.length === 0, JSON.stringify(offReport.scopes));
check('an off report says so in one line', /is OFF/.test(offReport.summary), offReport.summary);
check(
  'the report never carries a token, under any key',
  !JSON.stringify(offReport).toLowerCase().includes('token'),
  JSON.stringify(offReport)
);

const onReport = ldProxyReport(selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: 'launchdarkly-read' }), {
  configured: true,
  storage: 'file'
});
check(
  "the report's operations are the mode's operations, not a second table",
  JSON.stringify(onReport.operations.map((o) => o.tool)) ===
    JSON.stringify(ldOperationsFor('launchdarkly-read').map((o) => o.tool)),
  JSON.stringify(onReport.operations.map((o) => o.tool))
);
check(
  'each reported operation enumerates the query parameters it can carry',
  onReport.operations.every((op) => Array.isArray(op.queryParams)) &&
    onReport.operations.find((op) => op.tool === 'launchdarkly_get_feature_flag').queryParams.join(',') ===
      'env,expand',
  JSON.stringify(onReport.operations.map((op) => [op.tool, op.queryParams]))
);
check(
  'the summary refuses to let tool presence read as a working credential',
  /listed tool is not a working one/.test(onReport.summary),
  onReport.summary
);
const noCred = ldProxyReport(selectedLdProxyMode({ [LD_PROXY_ENV_VAR]: 'launchdarkly-read' }), {
  configured: false
});
check(
  'on with no credential says every call will refuse, rather than looking healthy',
  /NO CONFIGURED CREDENTIAL/.test(noCred.summary),
  noCred.summary
);

// The wiring, read off the sources. A pure unit run cannot tell "the gate is in
// the daemon" from "the gate is in mcp.ts and happens to agree today".
const routerSrc = fs.readFileSync(path.join(daemonDir, 'src', 'router.ts'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');
check(
  'router.ts consults the switch on every proxied call',
  /handleLaunchDarklyProxyCall[\s\S]{0,3000}selectedLdProxyMode\(\)/.test(routerSrc),
  'the call handler no longer reads the mode: the switch would only affect what is advertised'
);
check(
  'router.ts refuses through refuseLdProxyCall rather than an inline condition',
  /refuseLdProxyCall\(decision\.mode, tool\)/.test(routerSrc),
  'a second copy of the refusal rule is a second thing to get wrong'
);
check(
  'router.ts builds the path from the operation, never from the request body',
  /operation\.build\(args\)/.test(routerSrc) && !/data\.path/.test(routerSrc),
  'a path taken off the wire makes the granted scope unbounded'
);
// An invocation, not a mention: `mcp.ts` may name the switch in a comment
// explaining why it does not read it, and a bare substring match would make
// documenting the decision the thing that fails the check on it.
check(
  'mcp.ts does NOT read the switch itself — one reader, in the daemon',
  !/selectedLdProxyMode\s*\(/.test(mcpSrc) && !/LD_PROXY_ENV_VAR/.test(mcpSrc),
  "mcp.ts reads its own environment, which is not the daemon's: the tool list and the gate " +
    'would then be answers about two different machines'
);
check(
  'mcp.ts forwards a proxied call rather than deciding it',
  /callDaemonAPI\('launchdarkly_proxy_call'/.test(mcpSrc),
  JSON.stringify(mcpSrc.includes('launchdarkly_proxy_call'))
);
// The transport boundary. This is the assertion that would catch a write being
// added at the layer below the table, where the type union would not stop it.
const ldSrc = fs.readFileSync(path.join(daemonDir, 'src', 'integrations', 'launchdarkly.ts'), 'utf8');
const forbiddenVerbs = ["'POST'", "'PUT'", "'PATCH'", "'DELETE'", '"POST"', '"PUT"', '"PATCH"', '"DELETE"'].filter(
  (verb) => ldSrc.includes(verb)
);
check(
  'launchdarkly.ts has no POST, PUT, PATCH or DELETE — the transport cannot write',
  forbiddenVerbs.length === 0,
  `found ${JSON.stringify(forbiddenVerbs)}: a write verb reached the transport, which is the ` +
    'thing this ticket decided against. See launchdarkly-proxy.ts for the decision.'
);
// A DECLARATION, NOT A MENTION — and this one went red on its first run for
// exactly that reason, which is worth recording rather than quietly fixing.
// `launchdarkly.ts`'s docblock says "there is deliberately no `proxyWrite`
// beside this", and a bare substring match made *documenting the decision* the
// thing that failed the check on it. That is the same trap
// `verify-atlassian-proxy-scope.mjs` §5 names for `selectedProxyMode`, met here
// in the opposite direction: there the mention was in a comment explaining why
// the function is not called, here it is a comment explaining why the method
// does not exist. Match the declaration.
check(
  'launchdarkly.ts declares no proxyWrite method',
  !/\b(public|private|protected|async)?\s*proxyWrite\s*\(/.test(ldSrc),
  'a write method is declared on the LaunchDarkly transport: ' +
    JSON.stringify((ldSrc.match(/.*proxyWrite\s*\(.*/g) ?? []).slice(0, 3))
);

// ── 8. the plan-limited 403 is legible, and is NOT a credential fault ──────
rule('8. the failure path — a 403 by plan is told apart from a 403 by credential');

const planLeg = [
  {
    leg: 'api',
    endpoint: 'https://app.launchdarkly.com/api/v2/projects/butchr/ai-configs',
    status: 403,
    detail: 'Plan does not allow this operation'
  }
];
const plan = explainLdProxyFailure(403, planLeg);
check(
  'a plan-limited 403 is NOT reported as a credential fault',
  plan.credentialFault === false,
  `${JSON.stringify(plan)} — reporting this as a credential fault sends a human to replace a ` +
    'perfectly good token and tells the whole fleet its shared credential has died'
);
check(
  'and it names the plan limitation rather than failing opaquely',
  /ACCOUNT PLAN DOES NOT INCLUDE THIS FEATURE/.test(plan.error) &&
    /No token change fixes it/.test(plan.error),
  plan.error
);
check(
  "it carries LaunchDarkly's own words",
  /Plan does not allow this operation/.test(plan.error),
  plan.error
);

// The other 403, which IS the credential's problem. Both directions, because a
// function that returned "not a credential fault" for every 403 would pass the
// three checks above and hide a revoked token.
const roleLeg = [
  {
    leg: 'api',
    endpoint: 'https://app.launchdarkly.com/api/v2/flags/butchr',
    status: 403,
    detail: 'insufficient permissions'
  }
];
const role = explainLdProxyFailure(403, roleLeg);
check(
  'a role-limited 403 IS a credential fault — the discrimination runs both ways',
  role.credentialFault === true,
  `${JSON.stringify(role)} — every 403 is being treated as an entitlement, so a token whose ` +
    'role was narrowed would read as a plan limitation and nobody would fix it'
);
check(
  'a 401 is a credential fault and says the fleet is affected',
  explainLdProxyFailure(401, [{ leg: 'api', endpoint: 'x', status: 401 }]).credentialFault === true &&
    /every agent using this proxy/.test(
      explainLdProxyFailure(401, [{ leg: 'api', endpoint: 'x', status: 401 }]).error
    ),
  JSON.stringify(explainLdProxyFailure(401, [{ leg: 'api', endpoint: 'x', status: 401 }]))
);
check(
  'a 404 is the query\'s problem, not the credential\'s',
  explainLdProxyFailure(404, [{ leg: 'api', endpoint: 'x', status: 404 }]).credentialFault === false,
  JSON.stringify(explainLdProxyFailure(404, [{ leg: 'api', endpoint: 'x', status: 404 }]))
);
// No failure may be silent: every status this function has a reading of must
// produce a non-empty sentence. An empty error is the defect the whole ticket
// exists to remove, arriving through the one function that formats them.
for (const status of [400, 401, 403, 404, 418, 429, 500, 503]) {
  const explained = explainLdProxyFailure(status, [{ leg: 'api', endpoint: 'x', status }]);
  check(
    `HTTP ${status} produces a sentence rather than silence`,
    typeof explained.error === 'string' && explained.error.trim().length > 40,
    JSON.stringify(explained)
  );
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — off by default, the instrument that says so was shown to say yes as well, and ' +
        `launchdarkly-read is ${ldOperationsFor('launchdarkly-read').length} GETs under ` +
        `${ldGrantedScopes('launchdarkly-read').join(', ')}, mirroring exactly LaunchDarkly's own ` +
        '--scope read set, with no write by method, name or mode, no path or query parameter an ' +
        'agent can name, and a plan-limited 403 told apart from a credential one.'
  }\n`
);
process.exit(failures ? 1 : 0);
