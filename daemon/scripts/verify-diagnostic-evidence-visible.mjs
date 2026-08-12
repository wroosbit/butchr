// Live proof for KAN-343: the evidence every stand-down depends on cannot go
// dark permanently, and cannot go dark invisibly.
//
// WHAT FAILURE THIS WOULD CATCH: the board reconciler's diagnostic query
// truncating on a busy account and disabling every stand-down for good, with
// nothing but a log line to say so. Since KAN-342 a stand-down requires the
// board to have SAID something, and the only channel that evidence arrives on
// is `BOARD_DIAGNOSTIC_JQL`. That query was unscoped by project and
// `BOARD_MAX_RESULTS` is 100, so an account holding more than a hundred issues
// In Progress or In Review ANYWHERE — other people's projects, other machines'
// fleets, Jira's own `SAM1` sample project — returns a partial page every
// cycle, which `searchBoard` correctly reports as a failed read, which spares
// every candidate, forever. A ticket moved to Done then keeps its agent running
// indefinitely, the fleet stops shrinking, the capacity gate starts refusing
// real work, and the reconciler goes on reporting that it converged.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no network, no terminal.
// Section 5 additionally shells out to the repo's own `tsc`, as
// verify-absence-is-not-intent.mjs §5 does.
//
// "FAILS SAFE" IS NOT "FAILS VISIBLY", AND THE SECOND IS WHAT THIS IS FOR
//
// Post-KAN-342 the failure above leaves agents RUNNING rather than killing
// them, which is the safe direction and is why KAN-342 shipped with it open.
// **It is also the direction nobody notices** (`epic/KAN-203`): a fleet that
// fails to shrink looks exactly like a fleet nobody asked to shrink, until
// capacity fills and the machine degrades — KAN-258's incident shape arriving
// by a new road. So the first question KAN-343 had to answer was not *how do we
// stop the query truncating* but **when the diagnostic stops answering, who
// finds out, by what route, and would they have been looking?** The answer, read
// off the file rather than assumed: one line per cycle into `daemon.log`, and
// nothing else. That is the same trade as board-reconcile.ts:111's loud
// supervisor stand-down — logged deliberately, into a place nobody was reading,
// so that in review it looks as though somebody was told.
//
// §1 is therefore the smaller red and §2 is the one the ticket is named for.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the built `BoardReconciler` and its real `reconcileOnce`, the real
// `computeBoardDiff`, `explainAbsence`, `partitionStandDowns`, `fleetProjects`,
// `scopedDiagnosticJql` and `boardControlReport`; and — the part that matters
// most for §1 — **the truncation verdict is the real `boardPageFrom`'s**, not
// this file's opinion. The fake Jira below builds a Jira-shaped response body
// and asks the shipped parser whether it is complete, so "a partial page" means
// here what it means in production.
//
// **Stubbed: the transport, and THIS SCRIPT WRITES THE RECORD IT THEN ASSERTS
// ON.** Every issue the fake Jira holds is constructed here — you cannot ask
// the real Atlassian to put 120 tickets In Progress on cue — so nothing below
// tests that a real busy account produces the body `boardPageFrom` is fed. §1c
// closes the half of that gap which is checkable without a network: it reads
// `jira.ts` as text and asserts the two-line rule this file reimplements (a
// `complete: false` page becoming `ok: false`) is still spelled that way in the
// shipped service. The other half — that Jira really answers a 101st row with a
// continuation token — is unobserved here and is `report-board-convergence.mjs`'s
// territory; its live output against the real board is pasted in the PR.
//
// **Who covers what this leaves open:**
//
//   the KAN-342 property, in full   `verify-absence-is-not-intent.mjs` §3 — four
//                                   deliberate stops × two agent types, all
//                                   eight still killed. §3 below runs two of
//                                   them as a tripwire and defers to it
//   the real response shape         `verify-absence-attribution.mjs` §5
//   the real query, live            `report-board-convergence.mjs`
//   the field reaching a reader     NOBODY, and it is named rather than
//                                   implied. §2 asserts `boardControlReport`
//                                   returns the health; that the extension's
//                                   Agents page renders it, and that a
//                                   supervisor reads it off
//                                   `butchr_list_agents`, is not proven by any
//                                   artifact. Filed as a follow-up and linked
//                                   `Relates` on KAN-343
//
// Sections:
//
//   1. THE RED     — a busy account, an unscoped diagnostic, and a Done
//      (scope)       ticket's agent surviving five cycles in a row. Against the
//                    scoping patched out it never dies; against today's build
//                    it dies in one. One variable
//   2. THE RED     — the same five truncated cycles, asked what a supervisor
//      (visibility)  polling `butchr_list_agents` would see. Against the
//                    pre-KAN-343 report shape: nothing at all. Against today's:
//                    `answered: false`, and a streak that counts
//   3. KAN-342     — the property this must not have broken, as a tripwire: an
//                    absent assignee still spares, a Done ticket still kills
//   4. containment — the scope cannot lose a row `explainAbsence` needs,
//                    checked over every candidate rather than argued
//   5. the type    — the repo's own tsc refuses a health that answered AND
//                    carries a failure reason
//
// Isolation is by $HOME, as in verify-absence-is-not-intent.mjs. This script
// starts and stops nothing: `activate`/`deactivate` are stubs that record.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-diagnostic-evidence-visible.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan343-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const {
  BoardReconciler,
  BOARD_JQL,
  BOARD_DIAGNOSTIC_JQL,
  scopedDiagnosticJql,
  fleetProjects,
  computeBoardDiff
} = await import(pathToFileURL(path.join(distDir, 'board-reconcile.js')).href);
const { boardControlReport } = await import(
  pathToFileURL(path.join(distDir, 'board-control.js')).href
);
const { boardPageFrom, BOARD_MAX_RESULTS } = await import(
  pathToFileURL(path.join(distDir, 'jira.js')).href
);

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const check = (ok, good, bad) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${ok ? good : bad}`);
  if (!ok) failures++;
};
const verdict = (ok, good, bad) => {
  console.log(`\n  ${ok ? '→' : '✗ FAILED:'} ${ok ? good : bad}`);
  if (!ok) failures++;
};

const ME = '712020:619ec5ec-me';

/** One issue as the fake Jira holds it, in the shape a real search row has. */
const issue = (key, type, status, accountId = ME) => ({
  key,
  fields: {
    status: { name: status },
    issuetype: { name: type },
    assignee: accountId ? { accountId, displayName: 'Wroos Bit' } : null
  }
});

const agent = (type, key) => ({ agentName: `butchr-${type}-${key.toLowerCase()}`, type, key });

/**
 * A Jira that holds issues and answers JQL, badly but faithfully in the one
 * respect that matters.
 *
 * It understands exactly three things — `status IN ("A", "B")`, the
 * `assignee = currentUser()` half of `BOARD_JQL`, and a `project IN ("A", "B")`
 * prefix — which is all either query this loop makes actually uses. Everything
 * else about the JQL is ignored, and that is fine: this is not a JQL engine, it
 * is a truncation.
 *
 * **The status clause is not optional and the first draft of this file omitted
 * it**, which is worth recording because of how the omission presented: a Done
 * ticket came back from the partitioned query, so it was *desired* rather than a
 * stand-down candidate, so `diff.toStop` was empty and every section that
 * depended on a candidate quietly had nothing to assert on. The checks went red,
 * which is the only reason it was found — a fixture that produces no subject is
 * indistinguishable from a fix that works, and §1's first check exists to say so
 * out loud rather than let a later edit re-introduce it silently.
 *
 * **The completeness verdict is not this function's.** It assembles a
 * Jira-shaped body — rows, and a `nextPageToken` when it held more than it was
 * asked for, exactly as Cloud's `search/jql` does — and hands it to the shipped
 * `boardPageFrom`. So the sentence "the diagnostic truncated" below means what
 * the daemon means by it, and a change to the parser's completeness rule
 * reaches this script rather than going around it.
 */
function fakeJira(issues) {
  const calls = [];
  return {
    calls,
    async searchBoard(jql, maxResults = BOARD_MAX_RESULTS) {
      calls.push(jql);
      const scope = /project IN \(([^)]*)\)/.exec(jql);
      const projects = scope
        ? new Set(scope[1].split(',').map((p) => p.trim().replace(/"/g, '')))
        : null;
      const mine = jql.includes('assignee = currentUser()');
      const statuses = /status IN \(([^)]*)\)/.exec(jql);
      const wanted = statuses
        ? new Set(statuses[1].split(',').map((s) => s.trim().replace(/"/g, '')))
        : null;

      const matched = issues.filter((row) => {
        if (projects && !projects.has(row.key.slice(0, row.key.lastIndexOf('-')))) return false;
        if (mine && row.fields.assignee?.accountId !== ME) return false;
        if (wanted && !wanted.has(row.fields.status.name)) return false;
        return true;
      });

      const page = matched.slice(0, maxResults);
      const body =
        matched.length > maxResults
          ? { issues: page, nextPageToken: 'more' }
          : { issues: page, isLast: true };

      const parsed = boardPageFrom(body, maxResults);
      // The rule `JiraIssueTypeService.searchBoard` applies, and the only line
      // of that service reimplemented here — §1c asserts it still reads this
      // way in `jira.ts` rather than trusting this comment.
      if (!parsed.complete) {
        return {
          ok: false,
          backOff: false,
          error:
            `the board search returned a partial page (${parsed.issues.length} issue(s), ` +
            `asked for up to ${maxResults}, and Jira did not say that was all of them)`
        };
      }
      return { ok: true, issues: parsed.issues };
    }
  };
}

/** Run `cycles` cycles of one reconciler and collect everything they did. */
async function run({ issues, running, cycles = 1, Class = BoardReconciler }) {
  const log = [];
  const stopped = [];
  const jira = fakeJira(issues);
  const reconciler = new Class({
    jira,
    runningAgents: () => running.filter((a) => !stopped.includes(a.agentName)),
    activate: async () => ({ success: true }),
    deactivate: async (a) => {
      stopped.push(a.agentName);
      return { success: true };
    },
    mode: () => 'converge',
    log: (...args) => log.push(args.join(' ')),
    isSupervisorType: (type) => type === 'epic' || type === 'story'
  });
  const seen = [];
  for (let i = 0; i < cycles; i++) seen.push(await reconciler.reconcileOnce());
  return { cycles: seen, log, stopped, reconciler, jira };
}

/**
 * The busy account, as the ticket describes it.
 *
 * `KAN-500`'s agent is running and its ticket has been moved to **Done**, so
 * the board is asking for it to stop in the plainest way the board has. Around
 * it sit 120 issues In Progress in `OTHER` — somebody else's project, on the
 * same Atlassian account, which nobody in this repository controls. That is the
 * whole fixture: one deliberate stop, and enough unrelated noise to push an
 * unscoped status query past `BOARD_MAX_RESULTS`.
 */
const NOISE = Array.from({ length: 120 }, (_, i) =>
  issue(`OTHER-${i + 1}`, 'Task', 'In Progress', '712020:0000-them')
);
const BUSY_ACCOUNT = [
  ...NOISE,
  issue('KAN-39', 'Epic', 'In Progress'),
  issue('KAN-500', 'Task', 'Done')
];
const RUNNING = [agent('epic', 'KAN-39'), agent('task', 'KAN-500')];

/** Copy `dist`, apply edits, and report whether each landed exactly once. */
function patchedDist(tag, edits) {
  const dir = path.join(daemonDir, `dist-kan343-${tag}-${process.pid}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const report = [];
  for (const [file, from, to] of edits) {
    const target = path.join(dir, file);
    const source = fs.readFileSync(target, 'utf8');
    const hits = source.split(from).length - 1;
    report.push({ file, from, hits });
    fs.writeFileSync(target, source.split(from).join(to));
  }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, report, ok: report.every((r) => r.hits === 1) };
}

console.log(`dist:                 ${distDir}`);
console.log(`BOARD_JQL:            ${BOARD_JQL}`);
console.log(`BOARD_DIAGNOSTIC_JQL: ${BOARD_DIAGNOSTIC_JQL}`);
console.log(`BOARD_MAX_RESULTS:    ${BOARD_MAX_RESULTS}`);
console.log(`the fixture account holds ${BUSY_ACCOUNT.length} issue(s) In Progress or Done, ` +
  `${NOISE.length} of them in a project this fleet has nothing to do with`);

// ------------------------------------------------------------ 1. THE RED --

rule('1. THE RED (scope) — a busy account, and a Done ticket whose agent will not die');

// The pre-KAN-343 query, restored in the built module rather than quoted:
// `scopedDiagnosticJql` returning its base unscoped IS the old behaviour.
const redScope = patchedDist('unscoped', [
  ['board-reconcile.js', 'return `project IN (${list}) AND ${base}`;', 'return base;']
]);
check(
  redScope.ok,
  'the scoping patch site is where this section thinks it is',
  `${JSON.stringify(redScope.report)} — scopedDiagnosticJql has moved or changed shape; this ` +
    `section proves nothing until it is updated`
);

let red = null;
if (redScope.ok) {
  const { BoardReconciler: UnscopedReconciler } = await import(
    pathToFileURL(path.join(redScope.dir, 'board-reconcile.js')).href
  );
  red = await run({
    issues: BUSY_ACCOUNT,
    running: RUNNING,
    cycles: 5,
    Class: UnscopedReconciler
  });

  const truncated = red.cycles.every((c) => c.nearMisses === null);
  const everySpared = red.cycles.every(
    (c) => c.spared.length === 1 && c.spared[0].reason.condition === 'undetermined'
  );
  const converged = red.cycles.every((c) => c.diff.toStop.length === 1);

  console.log(`\n   five cycles against the unscoped build:`);
  for (const [i, c] of red.cycles.entries()) {
    console.log(
      `     cycle ${i + 1}: ${c.diff.toStop.length} candidate(s), ${c.stopped.length} stopped, ` +
        `${c.spared.length} spared (${c.spared.map((s) => s.reason.condition).join(', ')})`
    );
  }
  console.log(`   the diagnostic query it asked: ${red.jira.calls[1]}`);

  check(converged, 'KAN-500 is a stand-down candidate every cycle — the board is asking',
    'the fixture did not even produce a candidate; this section is testing nothing');
  check(truncated, 'the unscoped diagnostic came back a partial page every cycle, so no cycle ' +
    'could establish intent', 'the diagnostic answered — the fixture is not busy enough');
  check(red.stopped.length === 0,
    'and KAN-500 is STILL RUNNING after five cycles, with its ticket Done',
    'the agent was stood down, so this section did not reproduce the defect');
  check(everySpared,
    'each cycle spared it on `undetermined` — not a decision anybody made about KAN-500',
    'the spare was recorded on some other condition');
}

rule('1b. THE GREEN — the same account, the same ticket, today\'s build');

const green = await run({ issues: BUSY_ACCOUNT, running: RUNNING, cycles: 5 });
console.log(`\n   the diagnostic query it asked: ${green.jira.calls[1]}`);
console.log(`   cycle 1: ${green.cycles[0].stopped.length} stopped ` +
  `(${green.cycles[0].stopped.map((s) => s.agent.agentName).join(', ') || 'none'})`);

check(
  green.jira.calls[1].startsWith('project IN ("KAN")'),
  'the diagnostic is scoped to the one project this fleet is in',
  `the diagnostic was asked as ${JSON.stringify(green.jira.calls[1])}`
);
check(
  green.cycles[0].nearMisses !== null,
  'the scoped query answered completely on an account that truncates the unscoped one',
  'the scoped query truncated too'
);
check(
  green.stopped.includes('butchr-task-kan-500'),
  'and KAN-500 was stood down in the FIRST cycle, its ticket being Done',
  'KAN-500 survived — the fix does not converge the deliberate stop'
);
check(
  !green.stopped.includes('butchr-epic-kan-39'),
  'while the epic whose ticket is In Progress was left alone',
  'the epic was stood down, which is a mass stand-down wearing a fix\'s name'
);

rule('1c. the one rule this script reimplements, checked against the source it copies');

// The fake Jira above turns `complete: false` into `ok: false` in two lines,
// because `JiraIssueTypeService.searchBoard` needs a transport and a
// credential. That is a copy, and a copy is a thing that goes quietly stale —
// so it is read back rather than trusted. Source as text, deliberately: this
// check must hold whether or not the build is fresh.
const jiraSource = fs.readFileSync(path.join(daemonDir, 'src', 'jira.ts'), 'utf8');
const partialIsFailure =
  /if \(!page\.complete\)/.test(jiraSource) &&
  /returned a partial page/.test(jiraSource);
check(
  partialIsFailure,
  'jira.ts still turns a partial page into `ok: false`, so the stub above models the shipped rule',
  'jira.ts no longer reads that way — the fake Jira is modelling a rule that has changed, and ' +
    'every verdict in §1 is about a daemon that no longer exists'
);

verdict(
  redScope.ok && red && red.stopped.length === 0 && green.stopped.includes('butchr-task-kan-500') &&
    partialIsFailure,
  'one variable — the project scope — decides whether a Done ticket\'s agent dies in one cycle ' +
    'or survives indefinitely on an account nobody in this repository controls',
  'the scope is not what decides it, so §1 has not isolated the defect'
);

// ------------------------------------------------------- 2. THE RED (visibility) --

rule('2. THE FIX — what a supervisor polling butchr_list_agents actually sees');

// This is the section the ticket is named for. §1's failure is real and rare;
// this one is what made it worth a ticket at all — the failure was invisible
// everywhere a person or an agent actually looks, and the only thing that knew
// was a line in daemon.log.
//
// **§2 runs before §2b and is not gated on it**, and that ordering is the
// correction rather than a style choice. The first draft nested every assertion
// below inside the red build's `if (patch.ok)`, so mutating `boardControlReport`
// in `src` — the exact defect this section exists to catch — moved the patch
// site, skipped the whole block, and reported *"the patch site is where this
// section thinks it is: FAIL"*. A red, exit 1, and crediting the wrong
// mechanism: it said the fixture had rotted when what had actually broken was
// the thing under test. Found by driving that mutation. **A section's own
// assertions must not depend on its red build being patchable.**

// A reconciler on today's build whose diagnostic is failing — a 503 rather than
// a truncation, deliberately: that is the failure mode scoping cannot fix, and
// it is why §1 is not this ticket's answer.
const failing = await run({
  issues: [issue('KAN-39', 'Epic', 'In Progress'), issue('KAN-500', 'Task', 'Done')],
  running: RUNNING,
  cycles: 5,
  Class: class extends BoardReconciler {
    constructor(opts) {
      super({
        ...opts,
        jira: {
          async searchBoard(jql, max) {
            if (jql !== BOARD_JQL) {
              return { ok: false, backOff: true, status: 503, error: 'service unavailable' };
            }
            return opts.jira.searchBoard(jql, max);
          }
        }
      });
    }
  }
});
const failingHealth = failing.reconciler.health();

console.log(`\n   today's health, after five cycles with the evidence channel dark:`);
console.log(`     ${JSON.stringify(failingHealth, null, 2).split('\n').join('\n     ')}`);

check(
  failingHealth !== null && failingHealth.diagnostic.answered === false,
  'today\'s report says plainly that the last cycle could not establish intent',
  'today\'s report claims the diagnostic answered while it was failing'
);
check(
  failingHealth?.diagnostic.consecutiveFailures === 5,
  'and it counts the run — 5 consecutive cycles, which is what separates the one-off 5xx ' +
    'KAN-342 priced in from stand-downs having been off for five minutes',
  `the streak read ${failingHealth?.diagnostic.consecutiveFailures} after five failed cycles`
);
check(
  typeof failingHealth?.diagnostic.failingSince === 'string' &&
    failingHealth.diagnostic.detail.includes('service unavailable'),
  'carrying when it started and Jira\'s own words for why, so a partial page is ' +
    'distinguishable from an outage',
  'the streak carries no start time or no reason, so a reader cannot tell the two apart'
);
check(
  failingHealth?.agents.length === 1 &&
    failingHealth.agents[0].key === 'KAN-500' &&
    failingHealth.agents[0].condition === 'undetermined',
  'and it names the agent left running and the condition that spared it, so the reader knows ' +
    'which ticket is not converging',
  `the withheld list read ${JSON.stringify(failingHealth?.agents)}`
);

// The load-bearing one, and it is deliberately separate from every check above:
// those read `reconciler.health()` directly, which establishes that the
// reconciler KNOWS. What makes this a fix rather than a second private field is
// that the knowledge reaches the response a supervisor is already polling, and
// only `boardControlReport` can say that. A version of this section without this
// check would pass against a daemon that computed the health perfectly and told
// nobody — which is the defect, not the fix.
const sightedReport = boardControlReport('converge', RUNNING, failingHealth);
check(
  sightedReport.health?.diagnostic.answered === false &&
    sightedReport.health.diagnostic.consecutiveFailures === 5 &&
    sightedReport.health.agents.length === 1,
  'and boardControlReport carries it onto the list_agents payload intact — verdict, streak, ' +
    'and the agent left running',
  `the poll response carried ${JSON.stringify(sightedReport.health)} — the reconciler knows and ` +
    `the response does not, which is the defect rather than the fix`
);

// A streak that never comes down is a different lie: it would make a daemon that
// had one bad minute last week indistinguishable from one whose diagnostic has
// been dead since boot.
const recovered = await run({ issues: BUSY_ACCOUNT, running: RUNNING, cycles: 1 });
check(
  recovered.reconciler.health().diagnostic.answered === true &&
    recovered.reconciler.health().diagnostic.consecutiveFailures === 0,
  'a cycle that answers resets the run to zero — the field reports the state now, not a total ' +
    'that only ever grows',
  'the streak survived a healthy cycle'
);

// THE JOIN, AND IT IS THE ONE KAN-145 IS ABOUT.
//
// Every check above calls `boardControlReport` itself, which is exactly the
// shape KAN-145 was filed for: two halves each provably correct, and nothing
// exercising the wiring between them. `activatedBy` was `null` for every agent
// in production while two scripts asserting it stayed green, because both
// constructed the record they then asserted on and neither watched a real
// activation produce one. The equivalent hole here is `daemon.ts` calling
// `boardControlReport(mode, agents)` and never passing the third argument — the
// health would be computed every cycle, carried faithfully by a reporter nobody
// called correctly, and every assertion above would still pass.
//
// This is read statically, off `daemon.ts` as text, and it is a weaker
// instrument than the rest of this file: it proves the call is *written*, never
// that it runs. What would close it properly is a cycle driven through a real
// daemon and read back over the socket, which means installing this build over
// the running one and restarting the live fleet — not a thing a task agent
// should do to prove a point. The honest state is that the wiring is checked
// and the execution is not.
const daemonSource = fs.readFileSync(path.join(daemonDir, 'src', 'daemon.ts'), 'utf8');
const wired = /boardControlReport\(\s*boardReconcileMode\(\),\s*agents,\s*boardReconciler\.health\(\)\s*\)/
  .test(daemonSource);
check(
  wired,
  'and daemon.ts really passes the reconciler\'s health to it — the join two provably-correct ' +
    'halves can otherwise leave open (KAN-145)',
  'daemon.ts calls boardControlReport without the health, so the field is computed every cycle ' +
    'and published as null forever, with every check above still green'
);

rule('2b. THE RED (visibility) — the same fault against the pre-KAN-343 report shape');

// The pre-KAN-343 report shape, restored in the built module: `boardControlReport`
// simply did not carry the field.
const redVis = patchedDist('nohealth', [['board-control.js', '\n        health,', '']]);
check(
  redVis.ok,
  'the visibility patch site is where this section thinks it is',
  `${JSON.stringify(redVis.report)} — boardControlReport has changed shape; this section proves ` +
    `nothing until it is updated`
);

let blindSaysNothing = false;
if (redVis.ok && red) {
  const { boardControlReport: redReport } = await import(
    pathToFileURL(path.join(redVis.dir, 'board-control.js')).href
  );
  const { BoardReconciler: UnscopedReconciler } = await import(
    pathToFileURL(path.join(redScope.dir, 'board-reconcile.js')).href
  );

  // The same five truncated cycles as §1, asked the question a supervisor asks.
  const blind = await run({
    issues: BUSY_ACCOUNT,
    running: RUNNING,
    cycles: 5,
    Class: UnscopedReconciler
  });
  const blindReport = redReport('converge', RUNNING, blind.reconciler.health?.() ?? null);

  console.log(`\n   pre-KAN-343 report, after five cycles with the evidence channel dark:`);
  console.log(`     ${JSON.stringify(blindReport, null, 2).split('\n').join('\n     ')}`);

  blindSaysNothing =
    !('health' in blindReport) &&
    !JSON.stringify(blindReport).toLowerCase().includes('diagnostic');
  const onlyRouteWasTheLog = blind.log.some((l) =>
    l.includes('the diagnostic query could not be read')
  );

  check(
    blindSaysNothing,
    'the pre-KAN-343 report carries NOTHING about the diagnostic — a supervisor polling ' +
      'butchr_list_agents could not have known stand-downs were off',
    'the old report already disclosed it, so this section is not the red it claims to be'
  );
  check(
    onlyRouteWasTheLog,
    'and the only place it was mentioned at all was a line in the daemon log',
    'the daemon did not even log it, which is a different and worse defect'
  );
}

verdict(
  blindSaysNothing && wired && failingHealth?.diagnostic.answered === false &&
    failingHealth?.diagnostic.consecutiveFailures === 5,
  'the same fault that was disclosed only to a log file is now on the response a supervisor is ' +
    'already polling, with the run length that says whether it is worth acting on',
  'the fault is still invisible on the poll, or is disclosed without the run length'
);

// ------------------------------------------------------------- 3. KAN-342 --

rule('3. KAN-342 — the property this change must not have broken');

// A tripwire, not the proof. `verify-absence-is-not-intent.mjs` §3 is the proof:
// four deliberate stops × two agent types, all eight still killed, and it is
// what catches an over-broad fix. This runs two of them through the scoped
// query specifically, because the scope is the new thing and the thing that
// could plausibly lose a row and turn a spare into a kill.
const spare = await run({
  issues: [issue('KAN-203', 'Epic', 'In Progress', null)],
  running: [agent('epic', 'KAN-203')]
});
const kill = await run({
  issues: [issue('KAN-203', 'Epic', 'Done')],
  running: [agent('epic', 'KAN-203')]
});

check(
  spare.stopped.length === 0 && spare.cycles[0].spared[0]?.reason.condition === 'no-assignee',
  'an epic In Progress with an empty assignee is still spared, on `no-assignee` — the incident ' +
    'KAN-342 exists for, unchanged by the scope',
  `the unassigned epic was stood down, or spared on ` +
    `${spare.cycles[0].spared[0]?.reason.condition}`
);
check(
  kill.stopped.includes('butchr-epic-kan-203'),
  'and a Done ticket still kills its agent within the cycle, supervisor included',
  'a deliberate stop no longer converges — the fix is over-broad'
);
verdict(
  spare.stopped.length === 0 && kill.stopped.includes('butchr-epic-kan-203'),
  'absence still spares and intent still kills through the scoped query; see ' +
    'verify-absence-is-not-intent.mjs §3 for the full eight-case matrix',
  'the scope changed what the board is able to say'
);

// ---------------------------------------------------------- 4. containment --

rule('4. CONTAINMENT — the scope cannot lose a row explainAbsence needs');

// The direction this fails in is the dangerous one, which is why it is checked
// rather than argued: a candidate whose row the diagnostic did not return gets
// `wrong-status`, `isIntent` calls that a decision, and the agent dies. The
// argument is that `fleetProjects` takes the project of every RUNNING agent and
// every candidate is a running agent — so this walks a fleet spread over four
// projects, half of it out of jurisdiction, and asserts it over every candidate
// the diff actually produces.
const spread = [
  agent('epic', 'KAN-39'),
  agent('task', 'KAN-500'),
  agent('task', 'PROJ2-17'),
  agent('story', 'ABC-1'),
  agent('task', 'ZZ9-42'),
  { agentName: 'butchr-confluence-12345', type: 'confluence', key: '12345' },
  { agentName: 'butchr-shell-scratch', type: 'shell', key: 'scratch' }
];
const boardRows = [
  { key: 'KAN-39', statusName: 'In Progress', issueTypeName: 'Epic', assigneeAccountId: ME, assigneeDisplayName: 'Wroos Bit' }
];
const diff = computeBoardDiff(boardRows, spread);
const scope = fleetProjects(boardRows, spread);
const jql = scopedDiagnosticJql(BOARD_DIAGNOSTIC_JQL, scope);

console.log(`\n   running:    ${spread.map((a) => `${a.type}/${a.key}`).join(', ')}`);
console.log(`   candidates: ${diff.toStop.map((a) => a.key).join(', ')}`);
console.log(`   scope:      ${[...scope].sort().join(', ')}`);
console.log(`   diagnostic: ${jql}`);

// "Covered" means the query would return this candidate's row: either it names
// the project, or it does not restrict projects at all. The second arm is not
// slack — it is what keeps this check pointed at its own property. An UNSCOPED
// query excludes nothing and therefore cannot lose a row, so a §4 that flagged
// it would go red against a build whose only fault is §1's, crediting the
// containment argument with catching a defect it is blind to. Caught by driving
// exactly that mutation and reading which sections moved.
const scoped = /project IN \(/.test(jql);
const uncovered = diff.toStop.filter((a) => {
  const upper = a.key.trim().toUpperCase();
  const project = upper.slice(0, upper.lastIndexOf('-'));
  return scoped && !jql.includes(`"${project}"`);
});
check(
  diff.toStop.length >= 4,
  `${diff.toStop.length} candidates across ${new Set(diff.toStop.map((a) => a.key.split('-')[0])).size} ` +
    `projects — enough for this section to mean something`,
  'the fixture produced too few candidates for this check to be worth running'
);
check(
  uncovered.length === 0,
  'every stand-down candidate\'s project is named in the scoped query, so no candidate can be ' +
    'missing from the diagnostic because of the scope',
  `${uncovered.map((a) => a.key).join(', ')} would be asked about by a query that excludes their ` +
    `project — those agents would be read as \`wrong-status\` and KILLED`
);
check(
  scopedDiagnosticJql(BOARD_DIAGNOSTIC_JQL, new Set()) === BOARD_DIAGNOSTIC_JQL,
  'an empty scope returns the query unscoped rather than `project IN ()`, which would match ' +
    'nothing and read as every candidate being wrong-status',
  'an empty scope produces a query that matches nothing — the worst possible degradation'
);
verdict(
  uncovered.length === 0,
  'the containment holds over every candidate the diff produced, including agents out of ' +
    'jurisdiction whose projects the scope picks up anyway',
  'the scope can exclude a candidate, which turns a spare into a stand-down'
);

// ------------------------------------------------------------- 5. the type --

rule('5. THE TYPE — a health that answered cannot also carry a failure reason');

// Four nullable fields could say "the diagnostic answered, and here is why it
// failed". A refactor that forgets to clear `detail` on the success path
// produces a healthy cycle carrying a stale failure reason, which reads to a
// supervisor as a fleet whose stand-downs are off when they are not — the same
// class of false sentence KAN-256 was filed for. The union makes that state
// unconstructible; this section is what makes that claim checkable, and it
// needs BOTH halves, because a tsc invocation that failed for an unrelated
// reason would "prove" the guard while proving nothing.
const tscDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan343-tsc-'));
const src = JSON.stringify(path.join(daemonDir, 'src', 'board-reconcile.js'));
const fixture = (body) =>
  `import type { BoardDiagnosticHealth } from ${src};\nexport const h: BoardDiagnosticHealth = ${body};\n`;

const typecheck = (name, body) => {
  const file = path.join(tscDir, `kan343-${name}.ts`);
  fs.writeFileSync(file, fixture(body));
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

const contradiction = typecheck(
  'answered-and-failing',
  `{ answered: true, consecutiveFailures: 0, failingSince: '2026-08-12T00:00:00Z', ` +
    `detail: 'service unavailable' }`
);
const streakWhileAnswering = typecheck(
  'answered-with-streak',
  `{ answered: true, consecutiveFailures: 3 }`
);
const control = typecheck('failing', `{ answered: false, consecutiveFailures: 3, ` +
  `failingSince: '2026-08-12T00:00:00Z', detail: 'service unavailable' }`);
fs.rmSync(tscDir, { recursive: true, force: true });

console.log(`\n   { answered: true,  … detail: 'service unavailable' } → compiles: ${contradiction.compiled}`);
if (!contradiction.compiled) {
  for (const line of contradiction.output.split('\n').slice(0, 2)) console.log(`     ${line}`);
}
console.log(`   { answered: true,  consecutiveFailures: 3 }           → compiles: ${streakWhileAnswering.compiled}`);
if (!streakWhileAnswering.compiled) {
  for (const line of streakWhileAnswering.output.split('\n').slice(0, 2)) console.log(`     ${line}`);
}
console.log(`   { answered: false, consecutiveFailures: 3, … }        → compiles: ${control.compiled}`);
if (!control.compiled) {
  for (const line of control.output.split('\n').slice(0, 5)) console.log(`     ${line}`);
}

check(
  !contradiction.compiled && /not exist in type|not assignable/.test(contradiction.output),
  'the compiler refuses a health that answered and carries a failure reason',
  'a health can claim to have answered while carrying why it failed'
);
check(
  !streakWhileAnswering.compiled && /not assignable/.test(streakWhileAnswering.output),
  'and refuses one that answered while reporting a failure streak',
  'a health can report success and a streak of failures together'
);
verdict(
  !contradiction.compiled && !streakWhileAnswering.compiled && control.compiled,
  'the honest shape compiles and both contradictory ones do not, so a reader of ' +
    '`answered: true` is reading a fact rather than a field somebody forgot to clear',
  !control.compiled
    ? 'the control case did not compile either — this section failed for a reason that has ' +
      'nothing to do with the guard and proves nothing about it'
    : 'a contradictory health compiles, so the invariant is a convention rather than a type'
);

// ----------------------------------------------------------------- verdict --

console.log(
  `\n${'='.repeat(78)}\n` +
  (failures === 0
    ? 'done — every section passed'
    : `${failures} CHECK(S) FAILED`) +
  `\n${'='.repeat(78)}`
);
process.exit(failures ? 1 : 0);
