// KAN-298 acceptance criterion 2, at its strongest reading: **a real call per
// tool** — every one of the ten mirrored operations, built by the real operation
// table, sent through the real transport, using the real credential in the
// daemon's own store, against the real app.launchdarkly.com.
//
// This is a `probe-`, not a `verify-`, and the distinction is deliberate. It
// needs a configured LaunchDarkly credential and outbound network, neither of
// which CI has, and its answers depend on what happens to be in the account —
// none of which belongs in a proof a reviewer is meant to re-run cheaply. The
// *assertions* about the proxy live in `verify-launchdarkly-proxy-scope.mjs` and
// `verify-launchdarkly-proxy-failure-is-loud.mjs`.
//
// WHAT THIS ADDS OVER THOSE TWO, WHICH IS ONE THING AND WORTH SAYING EXACTLY:
// **that the paths this table builds actually address the endpoints it claims
// they do.** Both verify scripts run against a stub that answers whatever they
// ask, so every REST path in `launchdarkly-proxy.ts` could be subtly wrong and
// both would stay green. Only this script can fail on that, and it is the only
// thing that establishes it. Conversely, this script proves nothing about the
// switch, the refusals, `mcp.ts` or the daemon — it does not go through any of
// them. **Neither script covers the other, and the gap is named in both.**
//
// CI-RUNNABLE: no — needs a configured LaunchDarkly credential and outbound
// network to app.launchdarkly.com.
//
// ── ON SECRETS ──────────────────────────────────────────────────────────────
//
// The token is read from the daemon's own store BY PATH and is never printed,
// never passed as an argument, and never written anywhere. What this script
// prints is the *response*: a status, a path, and a short shape summary. Run it
// with `--bodies` to print response bodies too — that is off by default because
// the output of this script routinely ends up pasted into a pull request, and a
// body is the one part of it nobody has audited.
//
// ── WHAT A NON-200 MEANS HERE, WHICH IS NOT NECESSARILY A FAILURE ───────────
//
// On the account this was built against, **all four AI Config operations answer
// `403 {"code":"forbidden","message":"Plan does not allow this operation"}`**.
// That is an account entitlement, not a defect in the mirror and not a broken
// credential — and it is reported as an EXPECTED outcome rather than smuggled
// into a pass. The exit code counts only calls that failed for a reason this
// script cannot account for.
//
// Usage: node daemon/scripts/probe-launchdarkly-proxy-real-calls.mjs [--bodies]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { LD_PROXY_OPERATIONS, ldOperationByTool } from '../dist/launchdarkly-proxy.js';
import { LaunchDarklyIntegration } from '../dist/integrations/launchdarkly.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const showBodies = process.argv.includes('--bodies');

// Setup guards, not verdicts.
if (!fs.existsSync(path.join(daemonDir, 'dist', 'launchdarkly-proxy.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(1);
}
const credentialFile = path.join(os.homedir(), '.local', 'share', 'butchr', 'launchdarkly-credential.json');
if (!fs.existsSync(credentialFile)) {
  console.error(
    `No LaunchDarkly credential is configured on this machine (${credentialFile} does not exist). ` +
      "This probe needs one — configure it in Butchr's settings, under Integrations."
  );
  process.exit(1);
}

/** Counts only outcomes this script cannot account for. */
let unaccounted = 0;
const rows = [];

const ld = new LaunchDarklyIntegration();

/**
 * The arguments each operation is exercised with.
 *
 * Discovered rather than hard-coded where it matters: the flag key, the
 * environment key and the AI Config keys are read out of earlier calls, so this
 * probe works against any account rather than only against the one it was
 * written on. A hard-coded `agent-runner` would make this script a claim about
 * one project.
 */
const discovered = { projectKey: null, flagKey: null, envKey: null, configKey: null, variationKey: null };

function summarise(body) {
  if (body === null || body === undefined) return '(no body)';
  if (Array.isArray(body?.items)) {
    const keys = body.items.map((i) => i?.key ?? i?._id ?? '?').slice(0, 4);
    return `items[${body.items.length}]${keys.length ? `: ${keys.join(', ')}` : ''}`;
  }
  if (typeof body === 'object') {
    const keys = Object.keys(body).filter((k) => !k.startsWith('_')).slice(0, 6);
    return `{${keys.join(', ')}}`;
  }
  return String(body).slice(0, 80);
}

async function call(tool, args, { expect403 = false } = {}) {
  const op = ldOperationByTool(tool);
  if (!op) {
    console.log(`   MISSING  ${tool} is not in the operation table`);
    unaccounted++;
    return null;
  }
  const built = op.build(args);
  if ('error' in built) {
    console.log(`   REFUSED  ${tool} — ${built.error.slice(0, 120)}`);
    unaccounted++;
    return null;
  }
  const outcome = await ld.proxyRead(built.path, op.beta === true);

  if (outcome.ok) {
    console.log(`   200      ${tool}`);
    console.log(`            GET ${built.path}`);
    console.log(`            → ${summarise(outcome.body)}`);
    if (showBodies) console.log(`            ${JSON.stringify(outcome.body).slice(0, 600)}`);
    rows.push({ tool, path: built.path, status: outcome.status, verdict: 'ok', note: summarise(outcome.body) });
    return outcome.body;
  }

  const planLimited = outcome.status === 403 && /ACCOUNT PLAN DOES NOT INCLUDE/.test(outcome.error);
  if (expect403 && planLimited) {
    console.log(`   403      ${tool}  — EXPECTED on this account (plan does not include AI Configs)`);
    console.log(`            GET ${built.path}`);
    console.log(`            → credentialFault=${outcome.credentialFault} (correctly false: not a dead token)`);
    rows.push({
      tool,
      path: built.path,
      status: 403,
      verdict: 'plan-limited',
      note: 'Plan does not allow this operation'
    });
    return null;
  }

  console.log(`   FAILED   ${tool} — HTTP ${outcome.status ?? '(none)'}`);
  console.log(`            GET ${built.path}`);
  console.log(`            → ${String(outcome.error).slice(0, 240)}`);
  rows.push({
    tool,
    path: built.path,
    status: outcome.status ?? null,
    verdict: 'failed',
    note: String(outcome.error).slice(0, 160)
  });
  unaccounted++;
  return null;
}

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

// ── discovery: find a project to exercise the rest against ─────────────────
rule('0. discovery — which project, flag and environment this account has');

// Deliberately NOT one of the ten: `/api/v2/projects` is the validation probe
// `launchdarkly.ts` already used before this ticket, and it is here only to find
// a project key. It is not part of the mirrored surface and is not counted.
const projects = await ld.proxyRead('/api/v2/projects?limit=5');
if (!projects.ok) {
  console.error(`\nCould not list projects: ${projects.error}`);
  console.error('Nothing below could be exercised. This is a setup failure, not a verdict.');
  process.exit(1);
}
discovered.projectKey = projects.body?.items?.[0]?.key ?? null;
console.log(`   projects: ${(projects.body?.items ?? []).map((p) => p.key).join(', ') || '(none)'}`);
console.log(`   using projectKey = ${JSON.stringify(discovered.projectKey)}`);
if (!discovered.projectKey) {
  console.error('This account has no projects, so there is nothing to read. Setup failure.');
  process.exit(1);
}

// ── the six flag, environment and insight operations ───────────────────────
rule('1. the six non-AI-Config reads — all ten calls are real, against app.launchdarkly.com');

const flags = await call('launchdarkly_list_feature_flags', {
  projectKey: discovered.projectKey,
  limit: 5,
  summary: true
});
discovered.flagKey = flags?.items?.[0]?.key ?? null;

const envs = await call('launchdarkly_get_environments', { projectKey: discovered.projectKey, limit: 5 });
discovered.envKey = envs?.items?.[0]?.key ?? null;

if (discovered.flagKey) {
  await call('launchdarkly_get_feature_flag', {
    projectKey: discovered.projectKey,
    featureFlagKey: discovered.flagKey,
    ...(discovered.envKey ? { env: discovered.envKey } : {})
  });
  await call('launchdarkly_get_flag_status_across_environments', {
    projectKey: discovered.projectKey,
    featureFlagKey: discovered.flagKey
  });
} else {
  // Said out loud rather than skipped quietly: a project with no flags leaves
  // two of the ten unexercised, and a summary that did not say so would be
  // claiming ten real calls while making eight.
  console.log('   SKIPPED  launchdarkly_get_feature_flag — this project has no flags to read');
  console.log('   SKIPPED  launchdarkly_get_flag_status_across_environments — same reason');
  unaccounted += 2;
}

await call('launchdarkly_get_audit_log_entries', { limit: 2, spec: `proj/${discovered.projectKey}:env/*` });
await call('launchdarkly_get_code_references', { projKey: discovered.projectKey });

// ── the four AI Config reads ───────────────────────────────────────────────
rule('2. the four AI Config reads — plan-gated on this account, and that is reported as such');

const configs = await call('launchdarkly_list_ai_configs', { projectKey: discovered.projectKey, limit: 5 }, { expect403: true });
discovered.configKey = configs?.items?.[0]?.key ?? null;

// With no config to name, the remaining three are exercised against a key that
// does not exist. That is deliberate and it is still a real call: on a
// plan-limited account the 403 arrives before the key is ever looked at, which
// is exactly the outcome being recorded. On an account WITH AI Configs this
// would produce a 404, which the summary would report as unaccounted — correctly,
// because it would mean this probe needs a real config key to finish its job.
const configKey = discovered.configKey ?? 'no-such-ai-config';
if (!discovered.configKey) {
  console.log(`   (no AI Config to name — using ${JSON.stringify(configKey)}; on this account the`);
  console.log('    plan refusal arrives before the key is read, so the call is still real)');
}
await call('launchdarkly_get_ai_config', { projectKey: discovered.projectKey, configKey }, { expect403: true });
await call('launchdarkly_get_ai_config_targeting', { projectKey: discovered.projectKey, configKey }, { expect403: true });
await call(
  'launchdarkly_get_ai_config_variation',
  { projectKey: discovered.projectKey, configKey, variationKey: discovered.variationKey ?? 'no-such-variation' },
  { expect403: true }
);

// ── the arithmetic, said plainly ───────────────────────────────────────────
rule('3. the arithmetic — how many of the ten actually return data on this account');

const ok = rows.filter((r) => r.verdict === 'ok');
const planLimited = rows.filter((r) => r.verdict === 'plan-limited');
const failed = rows.filter((r) => r.verdict === 'failed');
const attempted = rows.length;

console.log(`   mirrored operations:        ${LD_PROXY_OPERATIONS.length}`);
console.log(`   calls attempted:            ${attempted}`);
console.log(`   returned data (HTTP 200):   ${ok.length}   ${ok.map((r) => r.tool.replace('launchdarkly_', '')).join(', ')}`);
console.log(`   plan-limited (HTTP 403):    ${planLimited.length}   ${planLimited.map((r) => r.tool.replace('launchdarkly_', '')).join(', ')}`);
console.log(`   unaccounted failures:       ${failed.length}   ${failed.map((r) => r.tool.replace('launchdarkly_', '')).join(', ')}`);
console.log('');
console.log(
  `   IN ONE SENTENCE: ${LD_PROXY_OPERATIONS.length} operations are mirrored, ${ok.length} return data on ` +
    `this account and ${planLimited.length} are refused by the account plan. "${LD_PROXY_OPERATIONS.length} ` +
    'tools mirrored" is not the same claim as "' + LD_PROXY_OPERATIONS.length + ' tools working", and this ' +
    'line exists so the difference cannot be lost in a summary.'
);

console.log(
  `\n${
    unaccounted
      ? `FAILED — ${unaccounted} call(s) neither returned data nor failed for a reason this probe accounts for`
      : `OK — every mirrored operation was called for real against app.launchdarkly.com: ${ok.length} ` +
        `returned data and ${planLimited.length} were refused by the account plan, which is an entitlement ` +
        'rather than a defect and is reported as one.'
  }\n`
);
process.exit(unaccounted ? 1 : 0);
