// Proof for KAN-501: a clipped answer never prints an instruction that cannot
// be typed, and the paging envelope survives the clip that takes the prose.
//
// WHAT FAILURE THIS WOULD CATCH: a response-budget stub telling its reader to
// recover an omitted field with a parameter the calling tool does not have.
// Measured on the fleet's daemon by three agents on three days — `task/KAN-420`
// (2026-08-16), `epic/KAN-39` (2026-08-17) and `epic/KAN-203` (2026-08-18) —
// every clipped Atlassian answer printed
//
//     readWith: "atlassian_get_issue_comments({ section: 'body' })"
//
// and that tool's schema carries `issueKey`, `startAt` and `maxResults` and
// nothing else. There is no `section` to pass. Calling it with one anyway
// returned the IDENTICAL clipped answer, because a parameter that is not in the
// schema is not there to be refused either — so the instruction failed in the
// one way that looks like having followed it. The recipe was built from the
// calling tool's NAME, which made it true of `butchr_list_agents`, the tool it
// was written for, and false of the other forty-odd it was then emitted for.
//
// The same clip removed `total`, `startAt` and `maxResults` as collateral — they
// lived inside the one object that was replaced — so the caller was told to page
// by a number the same response had just deleted. That is section 5.
//
// CI-RUNNABLE: yes — imports the built modules in process and reads two
// captured fixtures; no live daemon, no herdr, no credential, no peer, no
// terminal, no network.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: `fitGenericResponse`, `fitListAgentsResponse` and `genericRecovery` as
// built, and the operation tables the MCP server actually advertises from —
// `operationsFor` and `ldOperationsFor` are the same objects the client is sent,
// so section 2 checks recipes against the schemas rather than against a second
// copy of them. That is the point of `genericRecovery` living in
// `mcp-recovery.ts` rather than inside `mcp.ts`: a check can import it, so what
// is tested is what runs.
//
// Stubbed: the MCP round trip. Nothing here calls a tool. Section 6 narrows
// that with a static read of `mcp.ts` asserting the gate passes `genericRecovery`
// to the fitter, which proves the call site says the right thing and NOT that a
// real call reaches it. The live half is `probe-atlassian-proxy-read-surface.mjs`,
// which needs a daemon and a credential and is therefore not CI-runnable —
// neither script alone should be cited as covering both.
//
// Also stubbed: the ADF of the fixture comment. Section 0 exists because of it —
// it is the assertion that the stand-in is still the size the real payload was.

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

const { fitGenericResponse, fitListAgentsResponse, DEFAULT_BUDGET_CHARS } = await import(
  '../dist/mcp-response-budget.js'
);
const { genericRecovery } = await import('../dist/mcp-recovery.js');
const { operationsFor } = await import('../dist/atlassian-proxy.js');
const { ldOperationsFor } = await import('../dist/launchdarkly-proxy.js');

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

// ───────────────────────────────────────────────────────────────────────────
// What a tool advertises, from the two places this server gets it.
// ───────────────────────────────────────────────────────────────────────────

const proxiedOps = [...operationsFor('confluence-write'), ...ldOperationsFor('write')];
const proxiedParams = new Map(
  proxiedOps.map((op) => [op.tool, Object.keys(op.inputSchema?.properties ?? {})])
);

/**
 * The daemon-native tools' schemas, read out of `mcp.ts` as source text.
 *
 * A STATIC READ RATHER THAN AN IMPORT, because importing `mcp.ts` starts an MCP
 * server. The anchor is `inputSchema: {` after the tool's `name:` line and the
 * stop is its `required:` line, so the tool's *description* — which quotes
 * `section: '<field>'` in prose, and would otherwise be mistaken for a schema —
 * is outside the window on purpose.
 */
const mcpSource = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');
function nativeParams(tool) {
  const at = mcpSource.indexOf(`name: "${tool}"`);
  if (at === -1) return null;
  const schemaAt = mcpSource.indexOf('inputSchema: {', at);
  if (schemaAt === -1) return null;
  const stop = mcpSource.indexOf('required:', schemaAt);
  const window = mcpSource.slice(schemaAt, stop === -1 ? schemaAt + 4000 : stop);
  return [...window.matchAll(/^\s{12}([A-Za-z][A-Za-z0-9_]*): \{$/gm)].map((m) => m[1]);
}

const NATIVE_TOOLS = ['butchr_list_agents', 'butchr_atlassian_proxy_status', 'butchr_agent_status'];
const nativeParamMap = new Map(NATIVE_TOOLS.map((t) => [t, nativeParams(t)]));

function paramsOf(tool) {
  if (proxiedParams.has(tool)) return proxiedParams.get(tool);
  return nativeParamMap.get(tool) ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// What a recovery string CLAIMS a caller can pass.
//
// Two forms, and they are read by two different rules because they promise
// two different things:
//
//   a call    `tool({ key: value })`  — every key is a parameter, and the whole
//                                       string is meant to be typed verbatim
//   prose     "... ask for less with `maxResults` ..." — a backticked bare
//                                       identifier is a parameter being named
//
// Backticks are RESERVED for parameter names in these strings, which is what
// makes the second rule decidable. Field paths are written in double quotes
// ("body.comments") for exactly that reason, and `detail` is excluded from this
// rule altogether — it names response fields rather than arguments, and section
// 4 is what covers it.
// ───────────────────────────────────────────────────────────────────────────

function paramsNamedBy(text) {
  if (typeof text !== 'string') return [];
  const call = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\{(.*)\}\)$/s);
  if (call) {
    return [...call[2].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]);
  }
  return [...text.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
}

/** Every recovery claim in a fitted payload, with where it was found. */
function recoveryClaims(payload) {
  const found = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${where}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'readWith' || key === 'noWayBack' || key === 'readTheRest') && typeof value === 'string') {
        found.push({ at: `${where}.${key}`, key, text: value });
      }
      walk(value, `${where}.${key}`);
    }
  };
  walk(payload, '$');
  return found;
}

function auditRecipes(label, tool, payload) {
  const advertised = paramsOf(tool);
  const claims = recoveryClaims(payload);
  const offenders = [];
  for (const claim of claims) {
    for (const param of paramsNamedBy(claim.text)) {
      // `null` means this script could not establish the tool's parameters, and
      // an unestablished schema is not evidence of a good recipe — it is a hole,
      // reported as one rather than silently passed.
      if (advertised === null) {
        offenders.push(`${claim.at}: names \`${param}\` and ${tool}'s parameters could not be read`);
      } else if (!advertised.includes(param)) {
        offenders.push(
          `${claim.at}: names \`${param}\`, which ${tool} does not accept ` +
            `(it takes ${advertised.length ? advertised.join(', ') : 'no parameters'}) — "${claim.text}"`
        );
      }
    }
  }
  check(
    `${label}: every parameter a recovery names is one ${tool} accepts (${claims.length} claim(s) read)`,
    offenders.length === 0,
    offenders.join('\n')
  );
  return { claims, offenders };
}

// ───────────────────────────────────────────────────────────────────────────
rule('0. THE FIXTURE IS STILL THE SIZE OF THE THING IT STANDS IN FOR');

const commentFixturePath = path.join(scriptDir, 'fixtures', 'kan-501-clipped-comment-page.json');
const commentPage = JSON.parse(fs.readFileSync(commentFixturePath, 'utf8'));
const fixtureBodyChars = JSON.stringify(commentPage.body, null, 2).length;
const liveBodyChars = commentPage._liveBodyChars;
const ratio = fixtureBodyChars / liveBodyChars;

console.log(`   fixture:            ${path.relative(daemonDir, commentFixturePath)}`);
console.log(`   fixture body:       ${fixtureBodyChars} chars`);
console.log(`   live body (measured 2026-08-18): ${liveBodyChars} chars`);
console.log(`   ratio:              ${(ratio * 100).toFixed(1)}%\n`);

check(
  'the stand-in ADF is within 25% of the live payload it stands in for',
  ratio >= 0.75 && ratio <= 1.25,
  `ratio ${(ratio * 100).toFixed(1)}% — regenerate the fixture, or the sections below are ` +
    'measuring a payload the proxy never sees'
);
check(
  'the fixture is over budget at all (if it were not, nothing below would clip)',
  JSON.stringify(commentPage, null, 2).length > DEFAULT_BUDGET_CHARS,
  'the fixture fits the budget, so every clip assertion below would pass vacuously'
);

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE RED — a real clipped comment page, and the recipe it prints');

const commentTool = 'atlassian_get_issue_comments';
const commentFit = fitGenericResponse(
  { action: commentPage.action, success: commentPage.success, status: commentPage.status, body: commentPage.body, via: commentPage.via },
  { tool: commentTool, recoveryFor: (p) => genericRecovery(commentTool, p) }
);

console.log(`   ${commentTool} advertises: ${(paramsOf(commentTool) ?? []).join(', ')}`);
console.log(`   verdict: ${commentFit.completeness.kind}, ${commentFit.completeness.chars} chars\n`);
if (verbose) console.log(commentFit.text.split('\n').slice(0, 40).join('\n'));

check(
  'this fixture does clip — otherwise the recipe under test is never emitted',
  commentFit.completeness.kind === 'clipped',
  `verdict was ${commentFit.completeness.kind}`
);

// THE ASSERTION THAT IS THE WHOLE TICKET. Pre-fix this reads
//   $.body.readWith: names `section`, which atlassian_get_issue_comments does
//   not accept (it takes issueKey, startAt, maxResults, bodyFormat)
auditRecipes('the clipped comment page', commentTool, commentFit.payload);

// ───────────────────────────────────────────────────────────────────────────
rule('2. THE SWEEP — every tool this server advertises, not just the one that failed');

/** An over-budget answer in the envelope the proxy actually wraps things in. */
function oversizedFor() {
  return {
    action: 'atlassian_proxy_call_response',
    success: true,
    status: 200,
    body: {
      startAt: 0,
      maxResults: 50,
      total: 4321,
      values: Array.from({ length: 120 }, (_, i) => ({
        id: `entry-${i}`,
        title: `a row of the kind a real read returns, number ${i}`,
        prose: 'x'.repeat(120)
      }))
    },
    via: { tool: 'x', method: 'GET', path: '/rest/api/3/whatever', products: ['jira'] }
  };
}

const swept = [...proxiedParams.keys(), ...NATIVE_TOOLS];
let sweepOffenders = 0;
let sweptClipping = 0;
for (const tool of swept) {
  const fitted = fitGenericResponse(oversizedFor(), {
    tool,
    recoveryFor: (p) => genericRecovery(tool, p)
  });
  if (fitted.completeness.kind !== 'clipped') continue;
  sweptClipping += 1;
  const { offenders } = auditRecipesQuiet(tool, fitted.payload);
  if (offenders.length) {
    sweepOffenders += 1;
    console.log(`   ${tool}:`);
    offenders.forEach((o) => console.log(`      ${o}`));
  }
}

function auditRecipesQuiet(tool, payload) {
  const advertised = paramsOf(tool);
  const offenders = [];
  for (const claim of recoveryClaims(payload)) {
    for (const param of paramsNamedBy(claim.text)) {
      if (advertised === null) {
        offenders.push(`${claim.at}: names \`${param}\` and ${tool}'s parameters could not be read`);
      } else if (!advertised.includes(param)) {
        offenders.push(`${claim.at}: names \`${param}\` — "${claim.text}"`);
      }
    }
  }
  return { offenders };
}

check(
  `all ${sweptClipping} tools that clipped print only parameters their own schema carries`,
  sweepOffenders === 0,
  `${sweepOffenders} tool(s) named a parameter they do not accept — listed above`
);
check(
  'the sweep actually swept something (a sweep of zero tools proves nothing)',
  sweptClipping >= 20,
  `only ${sweptClipping} tools clipped; the operation tables may not have loaded`
);

// ───────────────────────────────────────────────────────────────────────────
rule('3. THE ONE REAL RECIPE, EXECUTED VERBATIM RATHER THAN READ');

// `epic/KAN-39`, KAN-501 comment 12871: "whatever recovery the stub prints must
// be executed verbatim in the proof. A recipe that is checked only by reading it
// is how this shipped."
const censusPath = path.join(scriptDir, 'fixtures', 'kan-423-over-cap-census.json');
const census = JSON.parse(fs.readFileSync(censusPath, 'utf8'));
const censusFit = fitListAgentsResponse(census, {});

const listClaims = recoveryClaims(censusFit.payload).filter((c) => c.key === 'readWith');
check(
  'the census clip prints at least one readWith recipe to execute',
  listClaims.length > 0,
  'no readWith stub on a clipped census — nothing to execute'
);

let executed = 0;
for (const claim of listClaims) {
  const parsed = claim.text.match(/^butchr_list_agents\(\{ section: '([A-Za-z0-9_]+)' \}\)$/);
  if (!parsed) {
    check(`recipe "${claim.text}" has the shape the tool's section argument takes`, false, claim.at);
    continue;
  }
  const section = parsed[1];
  // Executed through the same entry point the tool calls with `section`.
  const answer = fitListAgentsResponse(census, { section });
  const returned = answer.payload[section];
  const refused = answer.payload.success === false;
  const stillStubbed =
    returned && typeof returned === 'object' && !Array.isArray(returned) && returned.omitted === 'for-budget';
  check(
    `running "${claim.text}" verbatim returns \`${section}\` rather than refusing or re-stubbing it`,
    !refused && returned !== undefined && !stillStubbed,
    JSON.stringify({ refused, present: returned !== undefined, stillStubbed, error: answer.payload.error })
  );
  executed += 1;
}
console.log(`   ${executed} recipe(s) executed, not merely read.`);

// ───────────────────────────────────────────────────────────────────────────
rule('4. THE DETAIL SENTENCE DESCRIBES THIS RESPONSE, NOT THE ONE IT WAS WRITTEN FOR');

const commentDetail = commentFit.completeness.detail;
console.log(`   comment page detail: ${commentDetail}\n`);
check(
  'a clipped Jira comment page does not claim "every agent is named"',
  !/agent/i.test(commentDetail),
  commentDetail
);

// ⚠ THE CASE ABOVE IS NOT ENOUGH, AND FINDING THAT OUT IS WHY THIS BLOCK EXISTS.
//
// The leaked sentence lives on the no-entry-lost branch of `clippedVerdict`.
// The comment page reaches the OTHER branch, because what it gives up is an
// array and an array reports how many entries went — so restoring the
// unconditional sentence and rebuilding left every assertion above green. That
// was measured, not reasoned about: mutation C of this ticket's red drive
// compiled, ran, and was caught by nothing.
//
// `butchr_atlassian_proxy_status` is the shape that does reach it, and it is
// the instance `task/KAN-420` actually reported: `report` is an OBJECT, so
// nothing was countable, so the verdict says "no entry was dropped" — and used
// to finish that sentence with "every agent is named, with less said about
// some", in a proxy status response with no agents anywhere in it.
const statusTool = 'butchr_atlassian_proxy_status';
const proxyStatus = {
  outcome: 'serving',
  mode: 'confluence-write',
  // The 32 tool names this daemon really advertised on 2026-08-18, quoted from
  // the live call in this script's header.
  toolsAdvertised: proxiedOps.filter((op) => op.tool.startsWith('atlassian_')).map((op) => op.tool),
  whatAnEmptyToolListMeans: "both 'off' and 'unreachable' — read `outcome`, not your tool list",
  available: true,
  // An OBJECT rather than an array, which is the whole point of this case.
  // One entry per granted operation, which is why KAN-420 measured it growing
  // with the rung until it stopped being retrievable at all.
  report: Object.fromEntries(
    proxiedOps.map((op) => [
      op.tool,
      {
        mode: op.mode ?? null,
        scope: op.scope,
        pathShape: op.pathShape,
        note: 'one entry per granted operation, as the live report carries them'
      }
    ])
  )
};
const statusFit = fitGenericResponse(proxyStatus, {
  tool: statusTool,
  recoveryFor: (p) => genericRecovery(statusTool, p)
});
const statusLost = (statusFit.completeness.clipped ?? []).reduce((n, c) => n + (c.omitted ?? 0), 0);
console.log(`   proxy status detail: ${statusFit.completeness.detail}\n`);

check(
  'the proxy status answer clips, and reaches the NO-ENTRY-LOST branch the sentence lives on',
  statusFit.completeness.kind === 'clipped' && statusLost === 0,
  `kind=${statusFit.completeness.kind}, lost=${statusLost} — if entries were counted, this ` +
    'case has stopped exercising the branch it was written for and catches nothing'
);
check(
  'a clipped proxy status answer does not claim "every agent is named"',
  !/agent/i.test(statusFit.completeness.detail),
  statusFit.completeness.detail
);
check(
  'and the operator fields it is READ FOR survive the clip (KAN-420)',
  statusFit.payload.outcome === 'serving' && statusFit.payload.mode === 'confluence-write',
  JSON.stringify({ outcome: statusFit.payload.outcome, mode: statusFit.payload.mode })
);

// NOT A BLANKET DELETION, AND THIS IS THE HALF THAT SAYS SO. The sentence is
// true of the fleet census and was only ever wrong elsewhere, so a fix that
// removed it everywhere would have thrown away a correct disclosure to silence
// an incorrect one. The agents-only case is built from the census fixture's own
// eight rows with its list sections removed, because the sentence sits on the
// no-entry-lost branch and that fixture's `standbyAgents` always loses entries.
const agentsOnly = { action: census.action, success: true, agents: census.agents };
const agentsOnlyFit = fitListAgentsResponse(agentsOnly, { budgetChars: 6000 });
const agentsOnlyDetail = agentsOnlyFit.completeness.detail;
const agentRungFired = (agentsOnlyFit.completeness.clipped ?? []).some(
  (c) => c.reduction === 'rows-summarised' || c.reduction === 'rows-addressed'
);
console.log(`   agents-only detail:  ${agentsOnlyDetail}\n`);
check(
  'an agent rung really did fire on the agents-only census (else the next check is vacuous)',
  agentRungFired,
  JSON.stringify(agentsOnlyFit.completeness.clipped)
);
check(
  'and the agent sentence is still printed where an agent rung DID fire (this is not a blanket deletion)',
  /every agent is named/.test(agentsOnlyDetail),
  agentsOnlyDetail
);

// The invariant, stated as one rather than as two examples: the sentence is
// permitted exactly where it is true.
for (const [label, fit] of [
  ['clipped comment page', commentFit],
  ['census', censusFit],
  ['agents-only census', agentsOnlyFit]
]) {
  const detail = fit.completeness.detail;
  const rung = (fit.completeness.clipped ?? []).some(
    (c) => c.reduction === 'rows-summarised' || c.reduction === 'rows-addressed'
  );
  check(
    `${label}: claims "every agent is named" only where an agent rung fired`,
    !/every agent is named/.test(detail) || rung,
    detail
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('5. THE PAGING ENVELOPE SURVIVES THE CLIP THAT TAKES THE PROSE');

// `epic/KAN-203`, KAN-501 comment 12903: "the clip removed the paging metadata,
// not just the prose — and that is the part I would fix first. This endpoint
// serves oldest first, and the tool's own description tells the caller to read
// total first and then walk startAt. Both halves of that procedure need total,
// and the clip is what removes it."
const clippedBody = commentFit.payload.body;
console.log(`   body after the clip: ${JSON.stringify(clippedBody).slice(0, 200)}\n`);

for (const field of ['total', 'startAt', 'maxResults']) {
  check(
    `\`${field}\` survives the clip, with the value the page carried (${commentPage.body[field]})`,
    clippedBody && clippedBody[field] === commentPage.body[field],
    `got ${JSON.stringify(clippedBody?.[field])}, expected ${JSON.stringify(commentPage.body[field])}`
  );
}
check(
  'and the prose IS what went — otherwise nothing was given up and this section is vacuous',
  clippedBody?.comments?.omitted === 'for-budget',
  JSON.stringify(clippedBody?.comments)
);

// ───────────────────────────────────────────────────────────────────────────
rule('6. THE SEAM — the gate hands the fitter a recovery rather than letting it invent one');

const gate = mcpSource.slice(mcpSource.indexOf('function boundToBudget'));
check(
  'boundToBudget passes recoveryFor to fitGenericResponse',
  /fitGenericResponse\([\s\S]{0,200}recoveryFor:/.test(gate),
  'the gate calls the fitter without a recovery, so every tool falls back to the default'
);
check(
  'and the recovery it passes is genericRecovery, the function section 2 checked',
  /recoveryFor:[\s\S]{0,80}genericRecovery\(/.test(gate),
  'the gate builds its own recovery, so what section 2 checked is not what runs'
);
// The generic backstop is the code that met every tool, and it is where the
// invented recipe lived. `fitListAgentsResponse` above it may build a `section`
// recipe and does — that one is real, and section 3 executed it.
const budgetSource = fs.readFileSync(path.join(daemonDir, 'src', 'mcp-response-budget.ts'), 'utf8');
const genericFitter = budgetSource.slice(budgetSource.indexOf('export function fitGenericResponse'));
check(
  'the generic backstop constructs no `section` recipe of its own',
  genericFitter.length > 0 && !/section:\s*'/.test(genericFitter),
  'fitGenericResponse still builds a section recipe — the defect, rebuilt'
);
check(
  'and it emits a recovery it was GIVEN rather than one it derived from a tool name',
  /recoveryFor/.test(genericFitter) && !/callRecipe\(\s*options\.tool/.test(genericFitter),
  'the generic fitter is still deriving a call from the tool name'
);

// ───────────────────────────────────────────────────────────────────────────
rule('7. AND THE TOOL ANSWERS AT ALL — the same page, rendered, through the same gate');

// Sections 1 and 5 establish that a clipped answer is honest about what it gave
// up. THIS ONE IS THE OTHER HALF AND IT IS THE ONE THE TICKET IS NAMED FOR: an
// honest refusal is still a refusal, and `atlassian_get_issue_comments` was
// refusing on every real ticket. The operation's own transform is what changed
// that, so it is the operation's own transform that is run here — taken off the
// same table the MCP server advertises from, not reimplemented.
const commentOp = proxiedOps.find((op) => op.tool === commentTool);
check(
  'the comment operation is on the table and carries a transform',
  Boolean(commentOp?.transform),
  'no transform — the rendered path does not exist'
);

if (commentOp?.transform) {
  const rendered = commentOp.transform([commentPage.body], {}, { issueKey: 'KAN-501' });
  const renderedFit = fitGenericResponse(
    { action: commentPage.action, success: true, status: 200, body: rendered, via: commentPage.via },
    { tool: commentTool, recoveryFor: (p) => genericRecovery(commentTool, p) }
  );
  const adfChars = JSON.stringify(commentPage.body, null, 2).length;
  const textChars = JSON.stringify(rendered, null, 2).length;
  console.log(`   as ADF:        ${adfChars} chars  -> ${commentFit.completeness.kind}`);
  console.log(`   as text:       ${textChars} chars  -> ${renderedFit.completeness.kind}`);
  console.log(`   budget:        ${DEFAULT_BUDGET_CHARS} chars\n`);

  check(
    'the rendered page fits the budget whole, where the ADF page did not',
    renderedFit.completeness.kind === 'complete',
    `verdict ${renderedFit.completeness.kind} at ${renderedFit.completeness.chars} chars`
  );

  const body = renderedFit.payload.body;
  const firstComment = body?.comments?.[0];
  check(
    'a comment body actually comes back — the thing the tool exists to return',
    typeof firstComment?.body === 'string' && firstComment.body.length > 500,
    `got ${typeof firstComment?.body}, length ${firstComment?.body?.length ?? 0}`
  );
  check(
    'and it is the prose rather than a node tree (a spot-check on words only the comment has)',
    typeof firstComment?.body === 'string' &&
      firstComment.body.includes('KAN-471') &&
      firstComment.body.includes('31'),
    (firstComment?.body ?? '').slice(0, 200)
  );
  check(
    'the paging envelope is beside the comments rather than inside anything clippable',
    body?.total === 4 && body?.startAt === 0 && body?.maxResults === 1 && body?.returned === 1,
    JSON.stringify({ total: body?.total, startAt: body?.startAt, maxResults: body?.maxResults, returned: body?.returned })
  );
  check(
    'the renderer understood every node in it (an unrendered type would be named here)',
    firstComment?.bodyUnrenderedNodes === undefined,
    `unrendered: ${JSON.stringify(firstComment?.bodyUnrenderedNodes)}`
  );

  // The other arm, so `bodyFormat` is a real choice rather than a documented one.
  const asAdf = commentOp.transform([commentPage.body], {}, { issueKey: 'KAN-501', bodyFormat: 'adf' });
  check(
    "bodyFormat: 'adf' returns Jira's own object untouched, so nothing is lost by default-changing",
    asAdf === commentPage.body,
    'the adf arm reshaped the page it was asked not to reshape'
  );
  const refusal = commentOp.build({ issueKey: 'KAN-501', bodyFormat: 'ADF' });
  check(
    'and a bodyFormat the operation does not accept is REFUSED rather than quietly defaulted',
    typeof refusal?.error === 'string',
    JSON.stringify(refusal)
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(76)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('═'.repeat(76));

process.exit(failures ? 1 : 0);
