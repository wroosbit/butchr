// KAN-291: the daemon-side Atlassian proxy can now WRITE, and this is what
// bounds it — one POST, in a mode of its own, restricted to the caller's own
// ticket, with a body no agent supplied.
//
// WHAT FAILURE THIS WOULD CATCH: the write grant widening past the one
// transition this ticket authorises — a second write operation, a write tagged
// into the read mode so that `jira-read` starts changing things, a PUT or
// DELETE arriving under the POST the union now allows, an operation whose body
// or path is built from an agent's argument rather than from validated pieces,
// or the own-ticket restriction being lost so that any agent can move any
// issue. It would equally catch the write mode ceasing to be off by default,
// which is the direction KAN-272's criterion 3 cared about and which a write
// makes considerably more expensive to get wrong.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── WHY THE REFUSALS NEED A POSITIVE CONTROL ────────────────────────────────
//
// Inherited wholesale from `verify-atlassian-proxy-scope.mjs`, whose §3 makes
// the argument, and it binds harder here. Almost every assertion below is that
// something is *refused*, and a refusal is what a broken instrument produces
// too: if `refuseWriteOutsideCaller` returned an error for every input — one
// stray line — sections 2, 4 and 5 would all pass while the write tool was
// entirely non-functional, and this file would read as a clean bill of health.
// So §3 shows the same functions saying **yes** to the one call that should
// work, in the same run, on the same table.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ───────────────
//
// **This script constructs its own callers.** It hands `refuseWriteOutsideCaller`
// a `{type, key}` object it wrote a line earlier, so it proves what the policy
// decides *given* an identity and proves **nothing** about whether a real
// identity arrives — the KAN-145 defect, named in `prompts/task.md`, is exactly
// a proof that supplies its own input. If `mcp.ts` stopped stamping
// `workspaceKey`, or `router.ts` stopped passing it, every assertion here would
// stay green while every agent wrote as `unidentified caller`.
//
// That gap is owned, in three parts, and none of them is nobody:
//
//   - **§6 reads `router.ts` and `mcp.ts`** for the wiring a pure test cannot
//     see: that the handler calls this function at all, that it passes the
//     identity from the request rather than a constant, and that the refusal
//     happens before anything is sent.
//   - **`daemon/scripts/verify-atlassian-proxy-failure-is-loud.mjs`** stands up
//     a real daemon and a real `mcp.ts` under a temporary $HOME and drives the
//     whole chain over real MCP stdio. It is the one that fails if the wiring
//     is wrong; this one cannot.
//   - **A real transition of a real issue by a real agent**, pasted into the
//     PR. That is the only leg that shows an identity being *produced* rather
//     than constructed, and it is a human-run observation rather than a script,
//     because the thing being tested is an agent's own workspace argv.
//
// Usage: node daemon/scripts/verify-atlassian-proxy-write-scope.mjs [--verbose]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  PROXY_ENV_VAR,
  PROXY_MODES,
  PROXY_OPERATIONS,
  enabledModes,
  grantedScopes,
  operationByTool,
  operationsFor,
  proxyReport,
  refuseProxyCall,
  refuseWriteOutsideCaller,
  scopesOf,
  selectedProxyMode,
  writeOperationsFor
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

/** The one write this ticket authorises. Named once so §1 can assert the count. */
const THE_WRITE = 'atlassian_transition_issue';

// ── 1. the write grant is one operation, and this is what it is ────────────
rule('1. the grant — exactly one write, one verb, one scope');

check(
  `the whole table contains exactly one non-GET operation, and it is ${THE_WRITE}`,
  PROXY_OPERATIONS.filter((op) => op.method !== 'GET').length === 1 &&
    PROXY_OPERATIONS.filter((op) => op.method !== 'GET')[0].tool === THE_WRITE,
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method !== 'GET').map((op) => op.tool))
);
check(
  'that operation is a POST — no PUT, PATCH or DELETE anywhere in the table',
  PROXY_OPERATIONS.every((op) => op.method === 'GET' || op.method === 'POST'),
  JSON.stringify(PROXY_OPERATIONS.map((op) => [op.tool, op.method]))
);
// KAN-292 re-pointed this, and the re-pointing is itself the thing to read.
//
// It used to be `['read:jira-work', 'write:jira-work']`. KAN-292 inserts a
// `confluence-read` rung BELOW `jira-write` on the ladder, and the ladder's
// defining property is that the rung above contains the rung below — so
// `jira-write` now enables the Confluence reads too and names their scopes.
// That is a genuine widening of an existing mode, it was decided deliberately
// rather than discovered, and `enabledModes` carries the argument for it.
//
// **The only thing that matters here is unchanged and is asserted separately
// below: exactly one write scope, on exactly one mode.** Everything this list
// gained is a `read:`. An exact comparison is kept rather than softened to "no
// unexpected write scopes", because the whole point is that a list nobody
// compares exactly is a list that grows.
check(
  'jira-write needs exactly one write scope, plus every read scope the rung below it grants',
  JSON.stringify(grantedScopes('jira-write')) ===
    JSON.stringify([
      'read:confluence-content.all',
      'read:confluence-content.summary',
      'read:confluence-space.summary',
      'read:jira-user',
      'read:jira-work',
      'write:jira-work'
    ]),
  JSON.stringify(grantedScopes('jira-write'))
);
check(
  'and write:jira-work is the ONLY write scope in the entire table',
  JSON.stringify(
    [...new Set(PROXY_OPERATIONS.flatMap((op) => scopesOf(op)).filter((s) => /^write:/.test(s)))]
  ) === JSON.stringify(['write:jira-work']),
  JSON.stringify(PROXY_OPERATIONS.flatMap((op) => scopesOf(op)).filter((s) => /^write:/.test(s)))
);
// The write scope must never appear on a read mode. That would grant an
// operator who asked for reads a credential able to change things, which is the
// widening a reviewer is least likely to see because nothing about the tool
// list would change.
check(
  'no read mode requires a write scope',
  !grantedScopes('jira-read').some((scope) => /^write:/.test(scope)),
  JSON.stringify(grantedScopes('jira-read'))
);
check(
  'every write declares writesTo — the table says which calls are restricted',
  PROXY_OPERATIONS.filter((op) => op.method !== 'GET').every((op) => typeof op.writesTo === 'function'),
  JSON.stringify(
    PROXY_OPERATIONS.filter((op) => op.method !== 'GET' && typeof op.writesTo !== 'function').map((op) => op.tool)
  )
);
check(
  'no read declares writesTo — a GET that claims to write would skew every count here',
  PROXY_OPERATIONS.filter((op) => op.method === 'GET').every((op) => op.writesTo === undefined),
  JSON.stringify(PROXY_OPERATIONS.filter((op) => op.method === 'GET' && op.writesTo).map((op) => op.tool))
);
check(
  'every write states its bodyShape, so the grant is readable without reading build()',
  PROXY_OPERATIONS.filter((op) => op.method !== 'GET').every((op) => typeof op.bodyShape === 'string' && op.bodyShape),
  JSON.stringify(PROXY_OPERATIONS.map((op) => [op.tool, op.bodyShape ?? null]))
);

// ── 2. off by default, and the read mode does not smuggle a write ──────────
rule('2. off by default — and jira-read still cannot write');

for (const env of [{}, { [PROXY_ENV_VAR]: '' }, { [PROXY_ENV_VAR]: '   ' }]) {
  const decision = selectedProxyMode(env);
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(env[PROXY_ENV_VAR] ?? undefined)} enables no write`,
    decision.mode === 'off' && writeOperationsFor(decision.mode).length === 0,
    JSON.stringify({ decision, writes: writeOperationsFor(decision.mode).map((o) => o.tool) })
  );
}
// The truthiness trap, pointed at the write. Each of these would be a fleet-wide
// grant of write access by typo, which is a categorically worse outcome than the
// read version of the same bug.
for (const value of ['1', 'true', 'yes', 'on', 'write', 'jira_write', 'jirawrite', 'JIRA-WRITE!', 'jira-writes']) {
  const decision = selectedProxyMode({ [PROXY_ENV_VAR]: value });
  check(
    `${PROXY_ENV_VAR}=${JSON.stringify(value)} does NOT enable the write mode`,
    decision.mode === 'off',
    JSON.stringify(decision)
  );
}
check(
  `${THE_WRITE} is refused when the proxy is off`,
  refuseProxyCall('off', THE_WRITE)?.reason === 'proxy-off',
  JSON.stringify(refuseProxyCall('off', THE_WRITE))
);
// THE CHECK THIS FILE EXISTS FOR MOST. `jira-read` is what an operator grants
// when they want reads; it must not carry the write, and the ladder is
// deliberately one-way.
check(
  'jira-read enables NO write operation',
  writeOperationsFor('jira-read').length === 0,
  JSON.stringify(writeOperationsFor('jira-read').map((op) => op.tool))
);
check(
  `${THE_WRITE} is refused under jira-read, naming the mode that would enable it`,
  refuseProxyCall('jira-read', THE_WRITE)?.reason === 'not-in-mode' &&
    refuseProxyCall('jira-read', THE_WRITE).error.includes('jira-write'),
  JSON.stringify(refuseProxyCall('jira-read', THE_WRITE))
);
check(
  'the ladder is one-way — jira-read does not enable jira-write',
  !enabledModes('jira-read').includes('jira-write'),
  JSON.stringify(enabledModes('jira-read'))
);
check(
  'off enables nothing at all, whatever the ladder says',
  enabledModes('off').length === 0 && operationsFor('off').length === 0,
  JSON.stringify({ modes: enabledModes('off'), ops: operationsFor('off').length })
);
// KAN-291's criterion 5: the switch unset means nothing reaches Atlassian. The
// mode is the only thing standing between an agent and a write, so it is
// asserted over every mode this daemon knows rather than over the two that
// happen to be interesting.
for (const mode of PROXY_MODES) {
  const writes = writeOperationsFor(mode);
  check(
    `mode "${mode}" enables ${writes.length} write(s) — and only jira-write enables any`,
    mode === 'jira-write' ? writes.length === 1 : writes.length === 0,
    JSON.stringify(writes.map((op) => op.tool))
  );
}

// ── 3. THE POSITIVE CONTROL ────────────────────────────────────────────────
rule('3. positive control — the same table and the same policy DO say yes');

const writeDecision = selectedProxyMode({ [PROXY_ENV_VAR]: 'jira-write' });
check(
  `${PROXY_ENV_VAR}=jira-write selects jira-write`,
  writeDecision.mode === 'jira-write' && writeDecision.source === 'environment',
  JSON.stringify(writeDecision)
);
check(
  'jira-write enables the write — so every "it refused" in this file measured a real absence',
  writeOperationsFor('jira-write').length === 1,
  'the write mode enables nothing even when on: sections 2, 4 and 5 are vacuous and this ' +
    'file is worthless rather than reassuring'
);
// KAN-292: the comparison is against `confluence-read` rather than `jira-read`,
// because that is now the rung directly below `jira-write`. Same assertion —
// the write mode contains every read of the rung beneath it — pointed at the
// rung that is actually beneath it. Comparing against `jira-read` would still
// have passed as an inequality and would have stopped meaning anything.
check(
  'jira-write ALSO enables every read of the rung below — an agent that can transition can look first',
  operationsFor('jira-write').filter((op) => op.method === 'GET').length ===
    operationsFor('confluence-read').length,
  JSON.stringify(operationsFor('jira-write').map((op) => op.tool))
);
// And the ladder is a ladder: every rung is a strict superset of the one below,
// asserted over the whole chain rather than at the one join this ticket touched.
// This is what would catch a future rung inserted anywhere without the
// containment being re-established.
const LADDER = ['jira-read', 'confluence-read', 'jira-write'];
for (let i = 1; i < LADDER.length; i++) {
  const below = new Set(operationsFor(LADDER[i - 1]).map((op) => op.tool));
  const above = new Set(operationsFor(LADDER[i]).map((op) => op.tool));
  const missing = [...below].filter((tool) => !above.has(tool));
  check(
    `${LADDER[i]} contains everything ${LADDER[i - 1]} does`,
    missing.length === 0 && above.size > below.size,
    JSON.stringify({ missing, sizes: [below.size, above.size] })
  );
}
check(
  `${THE_WRITE} is permitted under jira-write`,
  refuseProxyCall('jira-write', THE_WRITE) === null,
  JSON.stringify(refuseProxyCall('jira-write', THE_WRITE))
);
const goodCall = operationByTool(THE_WRITE).build({ issueKey: 'KAN-291', transitionId: '31' });
check(
  'a good argument really does build a path and a body',
  goodCall.path === '/rest/api/3/issue/KAN-291/transitions' &&
    JSON.stringify(goodCall.body) === '{"transition":{"id":"31"}}',
  JSON.stringify(goodCall)
);
check(
  'and the policy permits an agent to write to its own ticket',
  refuseWriteOutsideCaller(
    operationByTool(THE_WRITE),
    { issueKey: 'KAN-291', transitionId: '31' },
    { type: 'task', key: 'KAN-291' }
  ) === null,
  'the policy refuses the one call it exists to permit: every refusal below is vacuous'
);

// ── 4. the body and the path are built, never supplied ─────────────────────
rule('4. an agent names neither a path nor a body');

check(
  'the write accepts no path, url, endpoint, method or body argument',
  !Object.keys(operationByTool(THE_WRITE).inputSchema.properties ?? {}).some((name) =>
    /^(path|url|uri|endpoint|method|rest|body|fields|transition)$/i.test(name)
  ),
  JSON.stringify(Object.keys(operationByTool(THE_WRITE).inputSchema.properties ?? {}))
);
check(
  'it takes exactly two arguments — an issue key and a transition id',
  JSON.stringify(Object.keys(operationByTool(THE_WRITE).inputSchema.properties ?? {}).sort()) ===
    JSON.stringify(['issueKey', 'transitionId']),
  JSON.stringify(Object.keys(operationByTool(THE_WRITE).inputSchema.properties ?? {}))
);

// Every path and body an agent can cause. A refusal is a pass; a built request
// that escapes its parameter, or a body that grew a field, is the failure this
// section exists for.
const HOSTILE_KEYS = [
  '../../../../rest/api/3/myself',
  'KAN-291/../../admin',
  'KAN-291?expand=changelog',
  'KAN-291#/rest/api/3/anything',
  '../..%2f..%2fadmin',
  'KAN 291',
  '',
  'NOT-A-KEY',
  'kan-291/transitions'
];
for (const hostile of HOSTILE_KEYS) {
  const built = operationByTool(THE_WRITE).build({ issueKey: hostile, transitionId: '31' });
  const escaped =
    'path' in built && !/^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]*-\d+\/transitions$/.test(built.path);
  check(
    `issueKey ${JSON.stringify(hostile.slice(0, 34))} cannot escape its parameter`,
    'error' in built || !escaped,
    JSON.stringify(built)
  );
}

// The transition id is the entire variable part of the only body this proxy can
// build. Anything that is not digits must be refused outright — not encoded,
// not coerced — because a value that survives into the body is a value that
// decides what `{"transition":{"id":…}}` means.
const HOSTILE_IDS = [
  '31"},"fields":{"summary":"owned',
  '{"id":"31"}',
  '../31',
  '31 OR 1=1',
  'In Progress',
  '',
  null,
  undefined,
  {},
  [],
  '3.1',
  '-31',
  '31\n',
  '999999999999'
];
for (const hostile of HOSTILE_IDS) {
  const built = operationByTool(THE_WRITE).build({ issueKey: 'KAN-291', transitionId: hostile });
  const clean =
    'error' in built ||
    (/^\{"transition":\{"id":"[0-9]{1,8}"\}\}$/.test(JSON.stringify(built.body)) &&
      Object.keys(built.body).length === 1 &&
      Object.keys(built.body.transition).length === 1);
  check(
    `transitionId ${JSON.stringify(String(hostile).slice(0, 34))} cannot add structure to the body`,
    clean,
    JSON.stringify(built)
  );
}
// Extra arguments are ignored rather than merged. An operation that spread its
// arguments into the body would grant every field Jira's API accepts, which is
// the widening no reviewer could read off the table.
const withExtras = operationByTool(THE_WRITE).build({
  issueKey: 'KAN-291',
  transitionId: '31',
  fields: { summary: 'overwritten' },
  update: { comment: [{ add: { body: 'x' } }] },
  historyMetadata: { actor: { id: 'someone' } }
});
check(
  'unknown arguments never reach the body — no field, update or metadata smuggling',
  JSON.stringify(withExtras.body) === '{"transition":{"id":"31"}}',
  JSON.stringify(withExtras)
);
check(
  'and they never reach the path either',
  withExtras.path === '/rest/api/3/issue/KAN-291/transitions',
  JSON.stringify(withExtras)
);
check(
  'no GET operation builds a body — a read cannot become a write by carrying one',
  operationsFor('jira-write')
    .filter((op) => op.method === 'GET')
    .every((op) => !('body' in (op.build({ issueKey: 'KAN-291', jql: 'project = KAN' }) ?? {}))),
  JSON.stringify(
    operationsFor('jira-write')
      .filter((op) => op.method === 'GET')
      .map((op) => op.build({ issueKey: 'KAN-291', jql: 'project = KAN' }))
  )
);

// ── 5. the scoping decision — an agent writes only to its own ticket ───────
rule("5. the policy — a write is permitted only to the caller's own ticket");

const theWrite = operationByTool(THE_WRITE);
const args = (issueKey) => ({ issueKey, transitionId: '31' });

check(
  "an agent transitioning somebody else's ticket is refused",
  refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.reason ===
    'not-your-ticket',
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' }))
);
check(
  'the refusal names both tickets, so the agent can see which it confused',
  (() => {
    const r = refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' });
    return r.error.includes('KAN-150') && r.error.includes('KAN-291');
  })(),
  refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.error
);
check(
  'the refusal says the write did not happen, rather than leaving it ambiguous',
  /Nothing was sent to Atlassian/.test(
    refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.error ?? ''
  ),
  refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.error
);
check(
  "the refusal points at the agent's own Atlassian session, which still works",
  /own Atlassian MCP tools/.test(
    refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.error ?? ''
  ),
  refuseWriteOutsideCaller(theWrite, args('KAN-150'), { type: 'task', key: 'KAN-291' })?.error
);
// An epic agent may not move a task's ticket, and this is the case that will be
// argued with: the fleet's own governance has approvers setting Done on tickets
// they approve. It is refused deliberately — see `refuseWriteOutsideCaller` —
// and the refusal names the workaround. If a later slice widens this, THIS is
// the assertion it has to change, which is the point of writing it down.
check(
  "an epic agent is refused a transition of its child's ticket",
  refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'epic', key: 'KAN-39' })?.reason ===
    'not-your-ticket',
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'epic', key: 'KAN-39' }))
);
check(
  'an unidentified caller is refused — a write is never made on nobody\'s behalf',
  refuseWriteOutsideCaller(theWrite, args('KAN-291'), null)?.reason === 'unidentified-caller',
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-291'), null))
);
for (const partial of [
  { type: 'task', key: '' },
  { type: '', key: 'KAN-291' },
  { type: undefined, key: 'KAN-291' },
  { type: 'task', key: undefined }
]) {
  check(
    `a half-identified caller ${JSON.stringify(partial)} is refused`,
    refuseWriteOutsideCaller(theWrite, args('KAN-291'), partial)?.reason === 'unidentified-caller',
    JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-291'), partial))
  );
}
check(
  'a confluence workspace, whose key is a page id, is refused and told why',
  refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'confluence', key: '123456' })?.reason ===
    'caller-has-no-ticket',
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'confluence', key: '123456' }))
);
// Case is not a licence. An agent whose key is spelled `kan-291` is the same
// agent, and `issueKey` upper-cases before it validates — so the comparison has
// to as well, or the restriction is bypassed by lower-casing one letter.
check(
  'a lower-case own key is still the same ticket, not a bypass and not a refusal',
  refuseWriteOutsideCaller(theWrite, args('kan-291'), { type: 'task', key: 'kan-291' }) === null,
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('kan-291'), { type: 'task', key: 'kan-291' }))
);
check(
  'and a lower-case OTHER key is still refused',
  refuseWriteOutsideCaller(theWrite, args('kan-150'), { type: 'task', key: 'KAN-291' })?.reason ===
    'not-your-ticket',
  JSON.stringify(refuseWriteOutsideCaller(theWrite, args('kan-150'), { type: 'task', key: 'KAN-291' }))
);
// A near-miss key must not pass. Substring or prefix comparison would let an
// agent for KAN-29 write to KAN-291, which is the classic form of this bug.
for (const near of ['KAN-29', 'KAN-2911', 'KAN-291X', 'XKAN-291', 'KAN-291 ']) {
  check(
    `caller ${JSON.stringify(near)} cannot write to KAN-291 by resembling it`,
    refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'task', key: near }) !== null,
    JSON.stringify(refuseWriteOutsideCaller(theWrite, args('KAN-291'), { type: 'task', key: near }))
  );
}
check(
  'the policy leaves every READ alone — restricting reads is not what this decides',
  operationsFor('jira-write')
    .filter((op) => op.method === 'GET')
    .every((op) => refuseWriteOutsideCaller(op, args('KAN-150'), { type: 'task', key: 'KAN-291' }) === null),
  'a read was refused by the write policy: agents legitimately read other tickets, and ' +
    'KAN-272 granted exactly that'
);

// ── 6. the report, and where the gate lives ────────────────────────────────
rule('6. the report tells the truth about writes, and the wiring is in the daemon');

const cred = { configured: true, siteUrl: 'https://x.atlassian.net', email: 'a@b.c' };
const writeReport = proxyReport(writeDecision, cred);
check(
  'the report marks the write as own-ticket-only',
  writeReport.operations.find((op) => op.tool === THE_WRITE)?.ownTicketOnly === true,
  JSON.stringify(writeReport.operations)
);
check(
  'and marks every read as not',
  writeReport.operations.filter((op) => op.method === 'GET').every((op) => op.ownTicketOnly === false),
  JSON.stringify(writeReport.operations)
);
check(
  'the report carries the body shape, so the grant is enumerable from it alone',
  writeReport.operations.find((op) => op.tool === THE_WRITE)?.bodyShape === '{"transition":{"id":"{transitionId}"}}',
  JSON.stringify(writeReport.operations.find((op) => op.tool === THE_WRITE))
);
check(
  'the summary says writes are restricted and says it is not authentication',
  /OWN TICKET/i.test(writeReport.summary) && /not authentication/i.test(writeReport.summary),
  writeReport.summary
);
check(
  'the summary warns that a read-scoped credential will refuse the write',
  /read scope will refuse/i.test(writeReport.summary),
  writeReport.summary
);
check(
  'the report never carries a token, under any key',
  !JSON.stringify(writeReport).toLowerCase().includes('token'),
  JSON.stringify(writeReport)
);
const readReport = proxyReport(selectedProxyMode({ [PROXY_ENV_VAR]: 'jira-read' }), cred);
check(
  'a jira-read report enumerates no write at all',
  readReport.operations.every((op) => op.method === 'GET' && !op.ownTicketOnly),
  JSON.stringify(readReport.operations)
);

// The wiring, read off the sources. A pure test cannot tell "the handler
// enforces the policy" from "the policy exists and nobody calls it" — which is
// this file's own stated gap, and §6 is the part of it that a script can close.
const routerSrc = fs.readFileSync(path.join(daemonDir, 'src', 'router.ts'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(daemonDir, 'src', 'mcp.ts'), 'utf8');

check(
  'router.ts applies the write policy on every proxied call',
  /handleAtlassianProxyCall[\s\S]{0,3000}refuseWriteOutsideCaller\(/.test(routerSrc),
  'the handler no longer consults the policy: any agent can write to any issue'
);
check(
  'it passes the identity from the request, not a constant',
  /refuseWriteOutsideCaller\(operation, args, callerIdentity\)/.test(routerSrc),
  'a hard-coded caller would make the restriction always-pass or always-fail'
);
// Ordering, and it is the whole of what "nothing was sent" is worth. A refusal
// after the request has gone is not a refusal.
check(
  'the refusal is decided BEFORE anything is sent to Atlassian',
  (() => {
    const handler = routerSrc.slice(routerSrc.indexOf('handleAtlassianProxyCall'));
    const refusal = handler.indexOf('refuseWriteOutsideCaller(operation');
    const send = handler.indexOf('this.jira.proxyWrite(');
    return refusal !== -1 && send !== -1 && refusal < send;
  })(),
  'the policy is consulted after the write has already gone out, which makes its ' +
    '"nothing was sent to Atlassian" sentence false'
);
// KAN-292 MOVED THE TEXT THESE TWO MATCH, AND THAT IS WHY THEY ARE WRITTEN OUT
// AT LENGTH RATHER THAN QUIETLY UPDATED.
//
// The handler no longer calls `proxyWrite(built.path, built.body)` directly. It
// normalises every operation into a list of `requests` — one for almost all of
// them, two for `atlassian_search`, which has to ask both products — and loops.
// So the old patterns stopped matching, and the update was made by checking
// that the PROPERTY still holds and then re-pointing at where it now lives,
// which is the opposite of the ordinary failure here: a check that stops
// matching gets relaxed until it passes, and the relaxation is what ships.
//
// The property is unchanged and is now asserted in THREE places rather than
// one, because the new intermediary is somewhere a body could be introduced
// that did not exist before:
//
//   1. the request list is derived from `built` — the operation's own output;
//   2. the write is sent `request.body`, a member of that list;
//   3. nothing derived from `data` (the wire) reaches `proxyWrite` at all.
//
// Together those say what the single old pattern said: the body Atlassian
// receives was constructed by the operation table from validated arguments.
check(
  'router.ts derives its request list from the operation, never from the request body',
  /const requests =\s*[\s\S]{0,80}'requests' in built\s*\?\s*built\.requests/.test(routerSrc),
  'the list of requests is assembled from something other than the operation\'s own build()'
);
check(
  'router.ts builds the write body from the operation, never from the request',
  /proxyWrite\(request\.path, request\.body\)/.test(routerSrc) &&
    !/proxyWrite\([^)]*data\./.test(routerSrc),
  'a body taken off the wire makes the granted scope unbounded'
);
check(
  'no path or body reaching Atlassian is read off the wire',
  !/proxy(Read|Write)\([^)]*data\./.test(routerSrc),
  'a path or body taken from `data` is a caller-supplied endpoint by another name'
);
check(
  'the audit line records what was written, not only which issue',
  /bodyForLog/.test(routerSrc) && /\$\{auditPath\}\$\{bodyForLog\}/.test(routerSrc),
  '"KAN-291 was changed" without "changed to what" is not an audit record of a change'
);
// And the audit line names every request a fan-out made, not just the last one.
// A two-request operation that logged one path would under-report what the
// credential had been used for, which is the one question an audit line exists
// to answer.
check(
  'the audit path covers every request the operation made',
  /const auditPath = outcomes\.map\(\(\{ request \}\) => request\.path\)\.join/.test(routerSrc),
  'a fan-out that logs one leg hides the other from the audit record'
);
check(
  'mcp.ts still does NOT read the switch itself — one reader, in the daemon',
  !/selectedProxyMode\s*\(/.test(mcpSrc) && !/PROXY_ENV_VAR/.test(mcpSrc),
  'the tool list and the gate would be answers about two different machines'
);

// ── THE SAME WIRING, IN THE BUILD THIS FILE ACTUALLY TESTS ─────────────────
//
// Added after `epic/KAN-39` drove this proof red by a route it survived: it
// replaced the `refuseWriteOutsideCaller` call in **`dist/router.js`** with
// `null` — every write reachable against anybody's ticket — and this file
// stayed green, EXIT=0.
//
// The checks above read `src/router.ts` and they do work: the identical
// mutation applied to the source trips all three. But **sections 1 to 5 import
// from `dist/`**, so until now this file asserted its units against the build
// and its wiring against the source, and was therefore describing two
// different programs. A divergence between them was invisible by construction,
// and a hand-edited `dist` is exactly that divergence.
//
// So the wiring is now asserted in both. `src` is what a reviewer reads and
// what the next change edits; `dist` is what actually runs and what every other
// assertion in this file is about. Neither is redundant: source-only misses a
// build that does not match it, and dist-only would pass a stale build that
// happens to still contain the call.
const routerDist = fs.readFileSync(path.join(daemonDir, 'dist', 'router.js'), 'utf8');
check(
  'the BUILT router applies the write policy, with the identity from the request',
  /refuseWriteOutsideCaller\(operation,\s*args,\s*callerIdentity\)/.test(routerDist),
  'src/router.ts consults the policy and the build does not: what runs is not what was reviewed'
);
check(
  'and the BUILT router decides it before anything is sent to Atlassian',
  (() => {
    const handler = routerDist.slice(routerDist.indexOf('handleAtlassianProxyCall'));
    const refusal = handler.indexOf('refuseWriteOutsideCaller(operation');
    const send = handler.indexOf('.proxyWrite(');
    return refusal !== -1 && send !== -1 && refusal < send;
  })(),
  'in the build that runs, the policy is consulted after the write has gone out'
);
// A proof run against a build older than the source it claims to describe is
// reporting on code nobody has. Cheap, deterministic, and it catches the
// ordinary version of the mistake above — forgetting to rebuild — as well as
// the deliberate one.
check(
  'and that build is not older than the source it is meant to be',
  fs.statSync(path.join(daemonDir, 'dist', 'router.js')).mtimeMs >=
    fs.statSync(path.join(daemonDir, 'src', 'router.ts')).mtimeMs,
  'dist/router.js predates src/router.ts — run `npm run build`; every assertion in this ' +
    'file is about the older code'
);

// The credential's own disclosure. KAN-291 §1 asks where the key lives and who
// can read it; the answer is "the store KAN-20 built, unchanged". What DID
// change is what the user is told before they type one, and a stale consent
// statement is the failure this checks for.
const cardSrc = fs.readFileSync(
  path.join(daemonDir, '..', 'extension', 'src', 'components', 'JiraCredentialCard.jsx'),
  'utf8'
);
// Comments stripped first, and this is not a convenience. What is being checked
// is **what the user is shown**, and the file's own comment quotes the retired
// sentence verbatim so that a reader knows what changed and why. Matching the
// raw source would make explaining the removal the thing that fails the check on
// it — the same trap `verify-atlassian-proxy-scope.mjs` names when it insists on
// an invocation rather than a mention of `selectedProxyMode`.
const cardRendered = cardSrc.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check(
  'the settings page no longer promises that Butchr never writes to Jira',
  !/never\s+writes\s+to\s+Jira/i.test(cardRendered),
  'a consent statement made to somebody about to hand over a credential has gone stale'
);
// And the positive control for the line above: the stripper must not be so
// enthusiastic that it deletes the text the check is meant to read. If this
// fails, the check above passed because there was nothing left to match.
check(
  'stripping comments left the rendered hint text intact',
  /Read scope is enough/.test(cardRendered) && cardRendered.length > cardSrc.length / 2,
  `stripped ${cardSrc.length - cardRendered.length} of ${cardSrc.length} characters`
);
check(
  'and it names write:jira-work and what granting it permits',
  /write:jira-work/.test(cardSrc) && /own ticket/i.test(cardSrc),
  'the scope that now matters is not disclosed before the token is typed'
);
check(
  'the token still never reaches this file — disclosure is about scope, not the secret',
  !/value=\{token\}[\s\S]{0,200}chrome\.storage/.test(cardSrc),
  'the credential card is storing the secret it is meant only to forward'
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — one POST, in jira-write only, off by default, body built from two validated ' +
        "strings, and refused for any ticket but the caller's own. The instrument was shown " +
        'to say yes in the same run.'
  }\n`
);
process.exit(failures ? 1 : 0);
