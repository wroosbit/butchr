// Proof for KAN-597: the "a KAN ticket is never unassigned" invariant lives at
// the board, sees every create path, and cannot reach the stand-down decision.
//
// WHAT FAILURE THIS WOULD CATCH: a ticket filed through a door the proxy's
// assignee guard does not sit on — the official Atlassian MCP server's
// `createJiraIssue`, which `prompts/task.md` named by name until this ticket, or
// the web UI — being born in To Do with an empty assignee and appearing NOWHERE.
// `BOARD_JQL` is `assignee = currentUser() AND status IN (…)`, so such a ticket
// can never be staffed; it reads exactly like one nobody has triaged; and until
// KAN-597 the only field that reported the condition,
// `boardControl.health.unstaffable`, was fed by a query that does not ask about
// To Do. Three tickets were born that way in the ninety minutes AFTER the proxy
// guard deployed, and all three were found by a supervisor reading changelogs by
// hand. It also catches the repair that was the obvious one and is a defect:
// widening `BOARD_DIAGNOSTIC_JQL` instead, which hands `explainAbsence` a status
// its branches were never written for — section 4 drives that red.
//
// CI-RUNNABLE: partial — sections 1-5 run in process against the built modules
// and section 3 shells the repo's own tsc: no daemon, no credential, no network,
// so CI reaches all five. Section 6 files real Jira tickets through a door that
// is NOT this daemon's proxy, which is the only thing that can demonstrate the
// acceptance criterion, and it is SKIPPED (loudly) without `--live`. A run that
// skips it says so in its verdict rather than reporting a clean sweep.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER, NAMED BECAUSE IT WRITES ITS OWN INPUT
// ---------------------------------------------------------------------------
//
// Sections 1-5 hand the reconciler a stubbed `searchBoard` and therefore supply
// the very rows they then assert on. They prove what the loop DOES with an
// unassigned To Do row; they do NOT prove that Jira produces one, that this
// query is the one that fetches it, or that a real unguarded create leaves the
// board in that state. That is exactly the gap KAN-145 left between two green
// scripts, so it is named rather than left to inference:
//
//   - Who covers the query string: section 1, which asserts the constant
//     itself — a client-side filter cannot show that the right question was
//     asked, only that the answer was handled.
//   - Who covers the live leg: SECTION 6, and nothing in CI. It files two
//     tickets through the unguarded door — one unassigned, one assigned — and
//     runs the shipped reporting code over a real board read. Its output is
//     pasted into the PR body.
//
// ---------------------------------------------------------------------------
// ⚠ SECTION 4 IS THE ONLY SECTION THAT HAS EVER GONE RED, AND IT IS WHY THE
// REPORT IS A THIRD QUERY RATHER THAN A WIDER SECOND ONE
// ---------------------------------------------------------------------------
//
// The naive way to report a To Do ticket is to widen `BOARD_DIAGNOSTIC_JQL`,
// which already drops the assignee condition. `BoardHealth.unstaffable`'s own
// docblock has warned against it since KAN-577 without anybody driving it, and a
// warning nobody has watched fail is not a gate. Section 4 applies exactly that
// mutation — through the `diagnosticJql` constructor option, which takes the
// same value the constant supplies — and shows the concrete harm: a running
// agent whose ticket has been dragged back to To Do is SPARED instead of stood
// down, because `explainAbsence` finds a row it did not expect, sees the
// assignee matches this machine, and falls out as `queries-disagree`, which
// `isIntent` does not count as a decision. Drag a card to To Do and its agent
// never stops. That is the KAN-342 class of failure — the fleet quietly ceasing
// to shrink — bought for the sake of a report.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-unstaffable-covers-every-door.mjs [--verbose]
//   node scripts/verify-unstaffable-covers-every-door.mjs --live   # files real tickets

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { reportAndExit, ALLOW_SKIPPED_FLAG } from './lib/verdict-exit.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, 'dist');
const verbose = process.argv.includes('--verbose');
const live = process.argv.includes('--live');
const allowSkipped = process.argv.includes(ALLOW_SKIPPED_FLAG);

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

let failures = 0;
let skipped = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

function verdict(ok, whenTrue, whenFalse) {
  console.log(`   ${ok ? '✓' : '✗'}  ${ok ? whenTrue : whenFalse}`);
  if (!ok) failures++;
}

const {
  BoardReconciler,
  BOARD_JQL,
  BOARD_DIAGNOSTIC_JQL,
  BOARD_UNSTAFFABLE_JQL,
  toUnstaffableIssues,
  scopedDiagnosticJql
} = await import(pathToFileURL(path.join(distDir, 'board-reconcile.js')).href);

const { agentNameFor } = await import(
  pathToFileURL(path.join(distDir, 'herdr.js')).href
);

const ACCOUNT = '712020:0000-this-machine';
const OTHER = '712020:0000-somebody-else';

const row = (key, statusName, assigneeAccountId, issueTypeName = 'Task') => ({
  key,
  issueTypeName,
  statusName,
  assigneeAccountId,
  assigneeDisplayName: assigneeAccountId ? 'Somebody' : null
});

/**
 * A reconciler whose three queries are answered independently, routed by the
 * query STRING rather than by call order — a stub that matched on order would
 * silently start answering a different question the next time a query is added,
 * which is the failure this whole file is about wearing a test harness's
 * clothes.
 */
function reconciler({ partitioned, diagnostic, unstaffable, running = [], opts = {} }) {
  const stopped = [];
  const instance = new BoardReconciler({
    jira: {
      searchBoard: async (jql) => {
        if (jql.includes('assignee = currentUser()')) return partitioned;
        if (jql.includes('assignee IS EMPTY')) return unstaffable;
        return diagnostic;
      }
    },
    runningAgents: () => running,
    activate: async () => ({ success: true }),
    deactivate: async (agent) => {
      stopped.push(agent.agentName);
      return { success: true };
    },
    mode: () => 'converge',
    log: verbose ? (...a) => console.log('        [log]', ...a) : () => {},
    startStaggerMs: 0,
    ...opts
  });
  return { instance, stopped };
}

// ⚠ THE NAME COMES FROM THE PRODUCER THE LOOP ITSELF USES, never from a
// template string here. `computeBoardDiff` matches on the full agent name, and
// herdr spells a key lower-case — so a hand-spelled `task/KAN-200` matches
// nothing, lands in `toStop` as `same-key-other-type`, and quietly changes what
// the fixture is testing. The first run of section 4 did exactly that.
const runningAgent = (key, type = 'task') => ({
  agentName: agentNameFor(type, key),
  type,
  key,
  issueTypeName: 'Task',
  statusName: null
});

// ------------------------------------------------- 1. the question asked --

rule('1. THE QUERY — it asks about every open status, and it asks for empty assignees');

console.log(`\n   BOARD_JQL             ${BOARD_JQL}`);
console.log(`   BOARD_DIAGNOSTIC_JQL  ${BOARD_DIAGNOSTIC_JQL}`);
console.log(`   BOARD_UNSTAFFABLE_JQL ${BOARD_UNSTAFFABLE_JQL}\n`);

// The client-side filter in `toUnstaffableIssues` cannot establish that the
// right question was asked — it only shows the answer was handled. So the
// constant is asserted directly, and on the two properties that carry the
// ticket: the empty-assignee condition, and a status predicate that is not a
// list of statuses somebody has to remember to extend.
verdict(
  /assignee\s+IS\s+EMPTY/i.test(BOARD_UNSTAFFABLE_JQL),
  'the query asks Jira for tickets with no assignee',
  `the query no longer asks for an empty assignee, so its rows are not this population: ${BOARD_UNSTAFFABLE_JQL}`
);

verdict(
  /statusCategory\s*!=\s*Done/i.test(BOARD_UNSTAFFABLE_JQL) &&
    !/status\s+IN\s*\(/i.test(BOARD_UNSTAFFABLE_JQL),
  'it bounds the population by statusCategory rather than by a status list, so a workflow ' +
    'that gains a status gains it here for free',
  `it names statuses explicitly, which is the thing that goes stale — a new status would be ` +
    `invisible with nothing saying so: ${BOARD_UNSTAFFABLE_JQL}`
);

// The whole point of the ticket: To Do is inside this query and outside the
// diagnostic. Asserted as the RELATION between the two rather than about either
// alone, because that relation is what was wrong.
verdict(
  /status\s+IN\s*\(/i.test(BOARD_DIAGNOSTIC_JQL) &&
    !/to\s*do/i.test(BOARD_DIAGNOSTIC_JQL) &&
    BOARD_UNSTAFFABLE_JQL !== BOARD_DIAGNOSTIC_JQL,
  'the diagnostic still asks only about work in flight, and the unstaffable query is a ' +
    'different question — the two have not been collapsed into one',
  'the diagnostic and the unstaffable query have converged; section 4 is what that costs'
);

verdict(
  scopedDiagnosticJql(BOARD_UNSTAFFABLE_JQL, new Set(['KAN'])) ===
    `project IN ("KAN") AND ${BOARD_UNSTAFFABLE_JQL}` &&
    scopedDiagnosticJql(BOARD_UNSTAFFABLE_JQL, new Set()) === BOARD_UNSTAFFABLE_JQL,
  'it is scoped through the same rule the diagnostic is, so the server-side filter and the ' +
    "client-side one are provably the same set rather than two rules kept in step by hand",
  'the scoping rule has moved or changed shape; an unscoped run returns every unassigned ' +
    "open ticket in the account, which is the report that trains its reader to skim"
);

// -------------------------------------- 2. the To Do ticket, and the control --

rule('2. THE GAP AND ITS CONTROL — a To Do ticket with no assignee is reported; an assigned one is not');

{
  const { instance } = reconciler({
    partitioned: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    diagnostic: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    unstaffable: {
      ok: true,
      issues: [
        // The measured case: born in To Do, no assignee, through a door the
        // proxy guard does not sit on.
        row('KAN-590', 'To Do', null),
        // The same condition in a status the OLD field already covered, so the
        // widening is shown to be a superset rather than a replacement.
        row('KAN-568', 'In Progress', null),
        // ⚠ THE CONTROL. Same query, same door, correctly assigned. If this
        // appears, the report is a list of open tickets rather than of
        // unstaffable ones, and its first false alarm would retire it.
        row('KAN-597', 'To Do', ACCOUNT)
      ]
    }
  });
  await instance.reconcileOnce();
  const report = instance.health()?.unstaffable;
  console.log(`\n   health.unstaffable = ${JSON.stringify(report)}\n`);

  const keys = report?.answered === true ? report.tickets.map((t) => t.key) : null;

  verdict(
    keys !== null && keys.includes('KAN-590'),
    'the To Do ticket with no assignee is reported — the population every measured ' +
      'occurrence sat in, and the one the old field could not see',
    `the To Do ticket is absent: ${JSON.stringify(report)}`
  );

  verdict(
    keys !== null && keys.includes('KAN-568'),
    'the In Progress ticket with no assignee is still reported — this widened the field ' +
      'rather than swapping one blind spot for another',
    `the In Progress ticket is absent, so KAN-577's coverage was lost: ${JSON.stringify(keys)}`
  );

  verdict(
    keys !== null && !keys.includes('KAN-597'),
    'THE CONTROL HOLDS — a correctly assigned ticket, through the same query, is not flagged',
    'a correctly assigned ticket was reported as unstaffable, which makes the report noise'
  );

  verdict(
    report?.answered === true && Array.isArray(report.tickets),
    'the answering branch carries its tickets',
    `the answering branch is malformed: ${JSON.stringify(report)}`
  );
}

{
  // The other half of the shape, and the one that matters: a query that did not
  // answer must not be readable as a clean board. Under the old `[] | null`
  // contract that distinction was a convention two docblocks had to explain.
  const { instance } = reconciler({
    partitioned: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    diagnostic: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    unstaffable: { ok: false, backOff: false, error: 'Atlassian said 503' }
  });
  await instance.reconcileOnce();
  const report = instance.health()?.unstaffable;
  console.log(`\n   health.unstaffable (query failed) = ${JSON.stringify(report)}\n`);

  verdict(
    report?.answered === false && !('tickets' in report),
    'a failed read carries NO ticket list at all, so there is no empty array to mistake for ' +
      'a clean board — the distinction is in the shape rather than in a docblock',
    `a failed read produced ${JSON.stringify(report)}, which a reader can take for a clean board`
  );

  verdict(
    report?.answered === false && report.detail === 'Atlassian said 503' && report.consecutiveFailures === 1,
    "the failing branch carries Jira's own words and the streak, so a partial page is " +
      'distinguishable from an outage',
    `the failing branch does not carry the reason or the count: ${JSON.stringify(report)}`
  );
}

{
  // Independence, both ways. Two queries with two failure modes: neither may
  // take the other down, and a shared streak would report a permanently partial
  // unstaffable page as stand-downs being broken.
  const { instance } = reconciler({
    partitioned: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    diagnostic: { ok: false, backOff: false, error: 'diagnostic 503' },
    unstaffable: { ok: true, issues: [row('KAN-590', 'To Do', null)] }
  });
  await instance.reconcileOnce();
  const health = instance.health();
  console.log(`   diagnostic.answered=${health?.diagnostic.answered}  ` +
    `unstaffable.answered=${health?.unstaffable.answered}\n`);

  verdict(
    health?.diagnostic.answered === false && health?.unstaffable.answered === true,
    'a dead diagnostic does not blank the unstaffable report — they fail independently',
    'the two reports share a fate, so one query going down takes the other with it'
  );
}

{
  const { instance } = reconciler({
    partitioned: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    diagnostic: { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] },
    unstaffable: { ok: false, backOff: false, error: 'unstaffable 503' }
  });
  await instance.reconcileOnce();
  const health = instance.health();
  verdict(
    health?.diagnostic.answered === true && health?.unstaffable.answered === false,
    'and a dead unstaffable query does not report stand-downs as broken — which is the ' +
      'direction that would matter, since this query can be partial permanently',
    'the unstaffable query failing marks the diagnostic as failing too, which is a false ' +
      'alarm about the one thing on this loop nobody can afford a false alarm about'
  );
}

// ------------------------------------------------------- 3. the type guard --

rule('3. THE TYPE — an unstaffable row cannot be handed to the stand-down machinery at all');

// The containment argument — these rows must never reach `explainAbsence` — is
// the kind of thing a comment states and a later author deletes without seeing
// what it cost. This section is what makes it checkable: it is a compile error,
// in four places, and no `if` anywhere expresses it.
//
// BOTH ARMS ARE REQUIRED. A tsc invocation that failed for an unrelated reason —
// an unresolved import, a bad flag — would "prove" the guard while proving
// nothing, which is this repository's most-repeated defect. The control arm is
// the identical fixture with a `JiraBoardIssue`, which must compile.
const tscDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan597-tsc-'));
const srcModule = JSON.stringify(path.join(daemonDir, 'src', 'board-reconcile.js'));
// `JiraBoardIssue` lives in jira.ts and is re-exported by nothing — the first
// run of this section imported it from the wrong module, both arms failed
// identically, and the control arm is the only reason that was visible rather
// than being written down as a green.
const jiraModule = JSON.stringify(path.join(daemonDir, 'src', 'jira.js'));

const fixtureFor = (kind) => `
import type { JiraBoardIssue } from ${jiraModule};
import type { UnstaffableIssue, DesiredAgent, RunningAgent } from ${srcModule};
import { explainAbsence, computeBoardDiff, deriveAccountId, findNearMisses } from ${srcModule};

declare const rows: ${kind}[];
declare const agent: RunningAgent;
declare const desired: DesiredAgent[];
declare const running: RunningAgent[];

explainAbsence(agent, desired, rows, null);
computeBoardDiff(rows, running);
deriveAccountId(rows);
findNearMisses(rows, new Set<string>());
`;

const typecheck = (kind) => {
  const file = path.join(tscDir, `kan597-${kind}.ts`);
  fs.writeFileSync(file, fixtureFor(kind));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(daemonDir, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit', '--strict',
        '--target', 'es2022',
        '--module', 'nodenext',
        '--moduleResolution', 'nodenext',
        file
      ],
      { cwd: daemonDir, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { compiled: true, output: '' };
  } catch (e) {
    return { compiled: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

const refused = typecheck('UnstaffableIssue');
const accepted = typecheck('JiraBoardIssue');
fs.rmSync(tscDir, { recursive: true, force: true });

console.log(`\n   the four calls, given UnstaffableIssue[] → compiles: ${refused.compiled}`);
for (const line of refused.output.split('\n').slice(0, 4)) if (line) console.log(`     ${line}`);
console.log(`\n   the same four, given JiraBoardIssue[]    → compiles: ${accepted.compiled}`);
for (const line of accepted.output.split('\n').slice(0, 5)) if (line) console.log(`     ${line}`);

// The error has to be about the missing assignee fields, and it has to name all
// four call sites. Matched on the bare token rather than on a quoted form: tsc
// quotes members as `'assigneeAccountId'`, and an assertion pinned to one
// spelling of that goes quietly false when the compiler changes its punctuation.
const refusedLines = refused.output.split('\n').filter((l) => /error TS/.test(l));
const refusedForTheRightReason =
  !refused.compiled &&
  refused.output.includes('assigneeAccountId') &&
  refusedLines.length >= 4;

verdict(
  refusedForTheRightReason && accepted.compiled,
  `the compiler refuses an UnstaffableIssue[] at all four stand-down entry points ` +
    `(${refusedLines.length} errors, each naming the missing assignee fields) and accepts the ` +
    'identical calls with board rows — so routing this population into the diff means ' +
    'changing a type in the open, not deleting a branch',
  !accepted.compiled
    ? 'THE CONTROL DID NOT COMPILE EITHER — this section failed for a reason that has nothing ' +
      'to do with the guard and proves nothing about it'
    : refused.compiled
      ? 'unstaffable rows are assignable to the stand-down machinery, so the containment is a ' +
        'comment after all'
      : `the refusal does not name the assignee fields or does not cover all four call sites ` +
        `(${refusedLines.length} errors) — this section did not test what it claims to`
);

// ----------------------------- 4. the red drive: why not widen the diagnostic --

rule('4. THE RED DRIVE — widening the diagnostic instead is what breaks stand-downs');

// The mutation is applied through the `diagnosticJql` constructor option, which
// takes the same value the constant supplies — so this IS the naive repair,
// exercised through the supported seam rather than by editing a file.
{
  // KAN-100's card has been dragged back to To Do, so the partitioned query no
  // longer returns it and its agent is a stand-down candidate. KAN-200 is
  // ordinary work carrying on beside it, and it is not scenery: `deriveAccountId`
  // learns this machine's account from the partitioned query's own rows, so a
  // board with none leaves `explainAbsence` unable to compare an assignee at all
  // and the widened arm lands on `assignee-uncompared` instead — spared for a
  // reason that is real but is not the one under test. The first run of this
  // section had exactly that board and reported a red it could not attribute.
  const board = {
    partitioned: { ok: true, issues: [row('KAN-200', 'In Progress', ACCOUNT)] },
    unstaffable: { ok: true, issues: [row('KAN-590', 'To Do', null)] },
    running: [runningAgent('KAN-100'), runningAgent('KAN-200')]
  };

  const widened = reconciler({
    ...board,
    // What option 3 looked like before it was measured.
    diagnostic: {
      ok: true,
      issues: [row('KAN-200', 'In Progress', ACCOUNT), row('KAN-100', 'To Do', ACCOUNT)]
    },
    opts: { diagnosticJql: 'status IN ("To Do", "In Progress", "In Review")' }
  });
  const widenedCycle = await widened.instance.reconcileOnce();
  const widenedReason = widenedCycle.absences[0]?.reason.condition;
  console.log(`\n   WIDENED DIAGNOSTIC: condition=${widenedReason}  ` +
    `stood down=${JSON.stringify(widened.stopped)}  spared=${widenedCycle.spared.length}`);

  const shipped = reconciler({
    ...board,
    // What ships: the diagnostic still asks only about work in flight, so it
    // returns KAN-200 and not KAN-100 — the card in To Do is in neither result
    // and the board's silence about it is read correctly.
    diagnostic: { ok: true, issues: [row('KAN-200', 'In Progress', ACCOUNT)] }
  });
  const shippedCycle = await shipped.instance.reconcileOnce();
  const shippedReason = shippedCycle.absences[0]?.reason.condition;
  console.log(`   SHIPPED ARRANGEMENT: condition=${shippedReason}  ` +
    `stood down=${JSON.stringify(shipped.stopped)}  spared=${shippedCycle.spared.length}\n`);

  verdict(
    widened.stopped.length === 0 && widenedReason === 'queries-disagree',
    `the widened diagnostic SPARES the agent (condition '${widenedReason}') — drag a card to ` +
      'To Do and its agent never stops. That is the red, and it is why the report is a third ' +
      'query: `explainAbsence` reads a returned row as evidence about intent, and a To Do row ' +
      'is not a question its branches were written for',
    `the widened diagnostic did not reproduce the harm (condition '${widenedReason}', stopped ` +
      `${JSON.stringify(widened.stopped)}) — so this section is not demonstrating what it ` +
      'claims, and the argument for a third query rests on nothing measured here'
  );

  verdict(
    shipped.stopped.includes(agentNameFor('task', 'KAN-100')) && shippedReason === 'wrong-status',
    "the shipped arrangement stands the same agent down, for the right reason " +
      `('${shippedReason}') — the stand-down decision is untouched by adding the report`,
    `the shipped arrangement did not stand the agent down (condition '${shippedReason}', ` +
      `stopped ${JSON.stringify(shipped.stopped)}) — the report has changed the diff, which is ` +
      'the one thing it must not do'
  );

  const shippedReport = shipped.instance.health()?.unstaffable;
  verdict(
    shippedReport?.answered === true && shippedReport.tickets.some((t) => t.key === 'KAN-590'),
    'and it reports the To Do ticket anyway — the report was bought without the trade',
    `the shipped arrangement stood the agent down but reported nothing: ${JSON.stringify(shippedReport)}`
  );
}

// ------------------------------------------- 5. the converter's own filters --

rule('5. THE CONVERTER — the only route into the reported population, and both of its filters');

{
  const rows = [
    row('KAN-590', 'To Do', null),
    row('SAM1-4', 'In Progress', null),
    row('KAN-597', 'To Do', ACCOUNT),
    row('KAN-598', 'To Do', OTHER),
    row('   ', 'To Do', null)
  ];
  const out = toUnstaffableIssues(rows, new Set(['KAN'])).map((t) => t.key);
  console.log(`\n   toUnstaffableIssues → ${JSON.stringify(out)}\n`);

  verdict(
    out.length === 1 && out[0] === 'KAN-590',
    'the project scope drops SAM1 (four permanently unassigned sample tickets, a log line a ' +
      'minute forever), the assignee re-check drops both assigned rows whoever they belong ' +
      'to, and a blank key is dropped',
    `the converter let something through or dropped the wrong thing: ${JSON.stringify(out)}`
  );

  const branded = toUnstaffableIssues([row('KAN-590', 'To Do', null)], new Set(['KAN']));
  verdict(
    branded[0]?.from === 'unstaffable-query' && !('assigneeAccountId' in branded[0]),
    'and what it emits carries the discriminator and no assignee fields, which is what makes ' +
      'section 3 a compile error rather than a convention',
    `the emitted shape is not the branded one: ${JSON.stringify(branded[0])}`
  );
}

// -------------------------------------------- 6. the live, unguarded door --

rule('6. THE LIVE DOOR — a ticket filed WITHOUT this daemon\'s proxy, and the shipped report over it');

if (!live) {
  skipped++;
  console.log(
    '\n   SKIPPED — needs --live, a configured Atlassian credential and network.\n' +
    '   This is the section that files a real ticket through a door the proxy guard does not\n' +
    '   sit on and shows the report catching it. Sections 1-5 supply their own rows and\n' +
    '   therefore cannot establish that a real unguarded create lands in this state.\n' +
    '   Nothing above has checked that. Run it with:\n\n' +
    '       node daemon/scripts/verify-unstaffable-covers-every-door.mjs --live\n'
  );
} else {
  const { CredentialStore } = await import(
    pathToFileURL(path.join(distDir, 'credentials.js')).href
  );
  const cred = await new CredentialStore().load();
  if (!cred) {
    skipped++;
    console.log('\n   SKIPPED — --live was passed but no Atlassian credential is configured.\n');
  } else {
    // ⚠ THE POINT OF THIS SECTION IS THE ROUTE, SO THE ROUTE IS SPELLED OUT.
    // These calls go straight to Jira's REST API with the daemon's credential.
    // They do NOT pass through `atlassian-proxy.ts`, which is where KAN-577's
    // assignee guard lives — that is what makes this the same class of door as
    // the official Atlassian MCP server and the web UI, and what makes the
    // result mean something. A test that filed through the proxy would
    // re-prove KAN-577 and establish nothing new.
    //
    // The credential is read from the store and used at the point of the call.
    // It is never printed, never passed as an argument, and never logged.
    const auth = 'Basic ' + Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
    const site = cred.siteUrl.replace(/\/+$/, '');
    const api = async (method, route, body) => {
      const res = await fetch(`${site}${route}`, {
        method,
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const me = await api('GET', '/rest/api/3/myself');
    const selfId = me.body?.accountId;
    console.log(`\n   authenticating as ${me.body?.displayName} (${me.status})`);

    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const made = [];
    const file = async (label, fields) => {
      const res = await api('POST', '/rest/api/3/issue', { fields });
      if (res.status >= 300) {
        console.log(`   could not file ${label}: ${res.status} ${JSON.stringify(res.body)}`);
        return null;
      }
      made.push(res.body.key);
      console.log(`   filed ${res.body.key} — ${label}`);
      return res.body.key;
    };

    // The subject: exactly what the unguarded door produces. `assignee` is
    // omitted, which is what `createJiraIssue` does when nobody passes
    // `assignee_account_id`.
    const unassigned = await file('unassigned, assignee omitted (the unguarded door)', {
      project: { key: 'KAN' },
      issuetype: { name: 'Task' },
      summary: `[throwaway] KAN-597 live door proof ${stamp} — born unassigned`
    });

    // ⚠ THE CONTROL, through the SAME door, differing only in the field under
    // test. Without it, a report that flagged every ticket it saw would pass.
    const assigned = await file('correctly assigned, same door (the control)', {
      project: { key: 'KAN' },
      issuetype: { name: 'Task' },
      summary: `[throwaway] KAN-597 live door proof ${stamp} — born assigned`,
      assignee: { accountId: selfId }
    });

    if (!unassigned || !assigned) {
      failures++;
      console.log('   ✗  could not file both tickets, so nothing was measured');
    } else {
      const search = async (jql) => {
        const res = await api(
          'GET',
          `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
            `&fields=status,issuetype,assignee&maxResults=100`
        );
        return (res.body?.issues ?? []).map((i) => ({
          key: i.key,
          statusName: i.fields?.status?.name ?? null,
          issueTypeName: i.fields?.issuetype?.name ?? null,
          assigneeAccountId: i.fields?.assignee?.accountId ?? null,
          assigneeDisplayName: i.fields?.assignee?.displayName ?? null
        }));
      };

      // ⚠ WAIT FOR THE SEARCH INDEX, AND MAKE THE WAIT ITS OWN POSITIVE
      // CONTROL. Jira's `/search/jql` is index-backed and a create is not
      // visible to it immediately. The first live run of this section did not
      // wait: the unstaffable query returned ZERO rows, the subject assertion
      // went red — correctly — and the CONTROL WENT GREEN, because a query that
      // returns nothing flags nothing. A control that passes on an empty board
      // is a check that cannot fail, which is worse than no control at all.
      //
      // So the index is proved live on a query that has nothing to do with the
      // one under test — `key IN (…)`, which must return BOTH tickets — before
      // either assertion is allowed to run. If it never catches up, this
      // section reports that it could not measure rather than reporting a
      // finding about the world.
      let indexed = [];
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        indexed = await search(`key IN (${unassigned}, ${assigned})`);
        if (indexed.length === 2) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log(`\n   search index caught up: ${indexed.length}/2 ticket(s) visible to JQL`);

      if (indexed.length !== 2) {
        failures++;
        console.log(
          `   ✗  the search index never returned both tickets within 90s (${indexed.length}/2), ` +
            'so nothing below was measured — this is an instrument failure, not a finding'
        );
      } else {
        // Read the board exactly as the reconciler does, then run the SHIPPED
        // reporting code over the result. Not a re-implementation of the rule —
        // the imported `toUnstaffableIssues` is the same function the daemon runs.
        const jql = scopedDiagnosticJql(BOARD_UNSTAFFABLE_JQL, new Set(['KAN']));
        console.log(`   board read: ${jql}`);
        const boardRows = await search(jql);
        const reported = toUnstaffableIssues(boardRows, new Set(['KAN'])).map((t) => t.key);
        console.log(
          `   the query returned ${boardRows.length} row(s): ${JSON.stringify(boardRows.map((r) => r.key))}`
        );
        console.log(`   the report names ${JSON.stringify(reported)}\n`);

        verdict(
          reported.includes(unassigned),
          `${unassigned} was filed through a door with no assignee guard and the shipped report ` +
            'names it — this is the acceptance criterion, and no create-path fix could have done it',
          `${unassigned} was born unassigned and the report did not name it: ${JSON.stringify(reported)}`
        );

        // ⚠ The control is only worth anything if the query it runs through
        // actually returned something. `reported` containing the subject is
        // what establishes that, so it is required here rather than assumed —
        // otherwise this arm is green on an empty board and says nothing.
        verdict(
          reported.includes(unassigned) && !reported.includes(assigned),
          `THE CONTROL HOLDS — ${assigned} went through the same door, correctly assigned, and ` +
            `is not flagged, on a run where the same query DID flag ${unassigned}`,
          reported.includes(assigned)
            ? `${assigned} was correctly assigned and was flagged anyway, which makes the report noise`
            : 'the control cannot be read: the query flagged nothing at all this run, so a green ' +
              'here would only mean the instrument was silent'
        );
      }
    }

    // Tidy up: these are throwaway tickets on a real board, and leaving them
    // would be adding to the very population this reports on.
    for (const key of made) {
      const del = await api('DELETE', `/rest/api/3/issue/${key}`);
      console.log(`   cleanup: DELETE ${key} → ${del.status}` +
        (del.status >= 300 ? ` (leave it: ${JSON.stringify(del.body)})` : ''));
    }
  }
}

// ------------------------------------------------------------- verdict --

console.log('');
if (skipped) {
  console.log(
    'NOTE: section 6 did not run, so this run has NOT shown a real ticket filed through the\n' +
    'unguarded door being caught. It shows the loop handling rows this script wrote itself,\n' +
    'which is the weaker half of the claim. The header says who covers the rest.'
  );
}
reportAndExit({ failures, skipped, allowSkipped });
