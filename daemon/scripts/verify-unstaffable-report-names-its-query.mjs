// Proof for KAN-649: `boardControl.health.unstaffable` names the query that
// produced it, so an absent audit and a clean board stop being the same bytes.
//
// WHAT FAILURE THIS WOULD CATCH: a daemon answering this field with an empty
// result from a build that carries no cross-door query at all, with nothing in
// the response able to say so. Measured on this machine on 2026-08-21:
// `BOARD_UNSTAFFABLE_JQL` merged at 22:51:08Z, the running daemon's `dist` was
// built at 10:41 PDT from a checkout five commits behind it, and
// `butchr_list_agents(section: "boardControl")` answered
// `unstaffable: []` — the identical bytes a genuinely clean board produces. The
// field is OLDER THAN THE QUERY by a whole ticket (KAN-577 fed it from the
// diagnostic; KAN-597 gave it a query of its own), so its presence establishes
// nothing, and the comfortable reading — "the cross-door query ran over every
// door and found nothing" — is the wrong one. This script drives that red
// against a real foreign build rather than against a description of one.
//
// CI-RUNNABLE: partial — sections 1, 2 and 5 run in process against this repo's own build and its own tsc
// (no daemon, no credential, no network), while sections 3 and 4 need a SECOND
// build to read — a `dist` from another commit, named with `--against-build
// <dir>` — and are SKIPPED (loudly, and tallied) without one, because the
// acceptance criterion is a comparison between two builds and one build cannot
// make it.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT WRITES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// Section 2 hands the reader payloads THIS FILE constructs — the pre-KAN-577
// `null`, the KAN-577 bare array, the KAN-597 object with no `askedJql`. Those
// are transcriptions of shapes taken from the shipped source of each era, and a
// transcription can be wrong in exactly the way that would make the section
// pass while the reader mishandles the real thing. **Section 3 is what covers
// that**, and it covers it properly: it runs a real foreign build's own
// reconciler and reads its real output, so nothing about the old shape is taken
// on this file's word. A run that skips section 3 has therefore NOT established
// that the reader handles a genuine old build, and says so in its verdict.
//
// Section 1's board is stubbed, so like every section of
// `verify-unstaffable-covers-every-door.mjs` it cannot establish that a real
// unassigned ticket reaches the report. That claim is not this script's — it
// belongs to section 6 of that file, which files a real ticket through an
// unguarded door.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-unstaffable-report-names-its-query.mjs [--verbose]
//   node scripts/verify-unstaffable-report-names-its-query.mjs \
//       --against-build /path/to/another/checkout/daemon/dist

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
const allowSkipped = process.argv.includes(ALLOW_SKIPPED_FLAG);

const againstIndex = process.argv.indexOf('--against-build');
const againstBuild =
  againstIndex !== -1 && process.argv[againstIndex + 1]
    ? path.resolve(process.argv[againstIndex + 1])
    : null;

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
  BOARD_UNSTAFFABLE_JQL,
  scopedDiagnosticJql,
  readUnstaffableSurface
} = await import(pathToFileURL(path.join(distDir, 'board-reconcile.js')).href);

const ACCOUNT = '712020:0000-this-machine';

const row = (key, statusName, assigneeAccountId, issueTypeName = 'Task') => ({
  key,
  issueTypeName,
  statusName,
  assigneeAccountId,
  assigneeDisplayName: assigneeAccountId ? 'Somebody' : null
});

/**
 * One cycle of a given build's reconciler over a board that is genuinely clean:
 * one ticket, In Progress, correctly assigned, and no agent running.
 *
 * ⚠ THE STUB ROUTES BY QUERY STRING AND ANSWERS ANYTHING IT DOES NOT RECOGNISE.
 * The point of this harness is to drive a build whose query set this file does
 * not know — a build that asks two queries and a build that asks three both go
 * through it — so a stub that matched on call order, or that refused an
 * unfamiliar query, would fail on the old build for a reason that has nothing
 * to do with what is being measured.
 *
 * Every arm returns the SAME clean rows, which is what makes the comparison in
 * section 3 fair: both builds are shown a board with nothing wrong with it, and
 * the only thing that can differ is what each is able to say about it.
 */
async function cleanBoardHealth(Reconciler) {
  const clean = { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] };
  const instance = new Reconciler({
    jira: { searchBoard: async () => clean },
    runningAgents: () => [],
    activate: async () => ({ success: true }),
    deactivate: async () => ({ success: true }),
    mode: () => 'converge',
    log: verbose ? (...a) => console.log('        [log]', ...a) : () => {},
    startStaggerMs: 0
  });
  await instance.reconcileOnce();
  return instance.health();
}

// -------------------------------------------- 1. the shape this build publishes --

rule('1. THE SHAPE — a clean board published by THIS build names the query that establishes it');

const expectedJql = scopedDiagnosticJql(BOARD_UNSTAFFABLE_JQL, new Set(['KAN']));
const ownHealth = await cleanBoardHealth(BoardReconciler);
const ownReport = ownHealth?.unstaffable;

console.log(`\n   health.unstaffable = ${JSON.stringify(ownReport)}\n`);

verdict(
  ownReport?.answered === true && ownReport.tickets.length === 0,
  'the board is clean, so the answering branch carries an empty ticket list — the ordinary ' +
    'case, and the one that used to be indistinguishable from silence',
  `the fixture board is not clean, so nothing below is measuring what it claims: ${JSON.stringify(ownReport)}`
);

verdict(
  ownReport?.askedJql === expectedJql,
  `and it names the query that produced it: ${expectedJql}`,
  `the empty result names no query, so it is the same bytes an unasking build produces: ` +
    `${JSON.stringify(ownReport)}`
);

// -------------------------------------------------- 2. the reader over old shapes --

rule('2. THE READER — every shape that cannot name a query reads as "nobody asked"');

// ⚠ SELF-SUPPLIED INPUT. These are transcriptions of the shapes each era
// shipped; section 3 is what checks the transcription against a real build.
const historical = [
  ['pre-KAN-577 (no field at all)', undefined],
  ['pre-KAN-577 (null: no cycle completed)', null],
  ['KAN-577 (a bare array, fed by the diagnostic)', []],
  ['KAN-597 (the union, before this ticket)', { answered: true, consecutiveFailures: 0, tickets: [] }],
  ['a fabricated blank query', { answered: true, consecutiveFailures: 0, askedJql: '   ', tickets: [] }]
];

console.log('');
let everyOldShapeCaught = true;
for (const [label, payload] of historical) {
  const reading = readUnstaffableSurface(payload);
  console.log(`   ${label.padEnd(46)} → ${reading.kind}`);
  if (verbose) console.log(`        ${reading.sentence}`);
  if (reading.kind !== 'no-cross-door-query') everyOldShapeCaught = false;
}
console.log('');

verdict(
  everyOldShapeCaught,
  'an absent field, a null, a bare array, the KAN-597 object with no askedJql and a blank one ' +
    'ALL read as no-cross-door-query — the reader degrades toward the alarming branch, which ' +
    'is the branch every one of these used to be read as the opposite of',
  'at least one shape that cannot name its query was read as an answer about the board'
);

// ⚠ THE CONTROL, and it is the assertion that stops this being a reader that
// only ever prints the alarming sentence. A mechanism with no reachable green
// is not a strict check, it is a check that does not exist.
const cleanReading = readUnstaffableSurface(ownReport);
const dirtyReading = readUnstaffableSurface({
  answered: true,
  consecutiveFailures: 0,
  askedJql: expectedJql,
  tickets: [{ from: 'unstaffable-query', key: 'KAN-590', statusName: 'To Do', issueTypeName: 'Task' }]
});
const failedReading = readUnstaffableSurface({
  answered: false,
  consecutiveFailures: 7,
  failingSince: '2026-08-21T23:00:00.000Z',
  detail: 'Atlassian said 503',
  askedJql: expectedJql
});

console.log(`   this build, clean board                        → ${cleanReading.kind}`);
console.log(`   this build, one unstaffable ticket             → ${dirtyReading.kind}`);
console.log(`   this build, the query did not answer           → ${failedReading.kind}\n`);

verdict(
  cleanReading.kind === 'clean' &&
    dirtyReading.kind === 'unstaffable' &&
    failedReading.kind === 'not-answered',
  'THE CONTROLS HOLD — a report that names its query is read as what it says, in all three of ' +
    'its states, so the alarming branch is a verdict rather than the only thing this can print',
  `a report naming its query was still read as unasked: ${cleanReading.kind}/` +
    `${dirtyReading.kind}/${failedReading.kind}`
);

verdict(
  failedReading.kind === 'not-answered' && failedReading.askedJql === expectedJql,
  'and a FAILED read is distinguishable from a build with no query — the provenance is not ' +
    'carried only on the cycles that went well, which is the half easiest to leave out',
  'a failed read reads the same as a build that never asked'
);

// ------------------------------------- 3. the red drive: a real build with no query --

rule('3. THE RED DRIVE — the same reader over a REAL build that has no cross-door query');

let foreignRendering = null;
if (!againstBuild) {
  skipped++;
  console.log(
    '\n   SKIPPED — needs a second build to read. This is the section that drives the red\n' +
    '   against a real foreign `dist` rather than against section 2\'s transcription of one,\n' +
    '   and it is the only thing here that establishes the reader handles a genuine older\n' +
    '   build. Nothing above has checked that. Run it with:\n\n' +
    '       node daemon/scripts/verify-unstaffable-report-names-its-query.mjs \\\n' +
    '           --against-build <another-checkout>/daemon/dist\n'
  );
} else if (!fs.existsSync(path.join(againstBuild, 'board-reconcile.js'))) {
  // An instrument failure, not a finding: reporting "no query there" for a
  // directory that holds no build at all would be a red credited to the wrong
  // mechanism, which is the defect this repository keeps re-finding.
  failures++;
  console.log(
    `\n   ✗  no board-reconcile.js under ${againstBuild} — this section measured nothing, and ` +
    'that is an instrument failure rather than evidence about any build'
  );
} else {
  const foreign = await import(pathToFileURL(path.join(againstBuild, 'board-reconcile.js')).href);

  // ⚠ THE POSITIVE CONTROL FOR THE CLAIM THIS SECTION MAKES. "That build has no
  // cross-door query" must be established from the build itself, not inferred
  // from the reader's verdict — otherwise the reader is both the instrument and
  // the evidence, and a reader that always said `no-cross-door-query` would
  // pass this section forever.
  const foreignHasConstant = typeof foreign.BOARD_UNSTAFFABLE_JQL === 'string';
  const ownHasConstant = typeof BOARD_UNSTAFFABLE_JQL === 'string';
  console.log(`\n   ${againstBuild}`);
  console.log(`     exports BOARD_UNSTAFFABLE_JQL: ${foreignHasConstant}`);
  console.log(`   ${distDir}`);
  console.log(`     exports BOARD_UNSTAFFABLE_JQL: ${ownHasConstant}\n`);

  verdict(
    !foreignHasConstant && ownHasConstant,
    'the build under test genuinely carries no cross-door query and this one does — measured ' +
      'off the modules themselves, so the reading below is about the build rather than about ' +
      'the reader',
    foreignHasConstant
      ? 'the build named by --against-build DOES carry the cross-door query, so it is not the ' +
        'world this section exists to measure — point it at an older dist'
      : 'THIS build does not export the query either, so the control is dead and nothing here ' +
        'distinguishes the two'
  );

  const foreignHealth = await cleanBoardHealth(foreign.BoardReconciler);
  const foreignReport = foreignHealth?.unstaffable;
  const foreignReading = readUnstaffableSurface(foreignReport);
  foreignRendering = foreignReading.sentence;

  console.log(`   its health.unstaffable = ${JSON.stringify(foreignReport)}`);
  console.log(`   read as: ${foreignReading.kind}`);
  console.log(`     ${foreignReading.sentence}\n`);

  verdict(
    foreignReading.kind === 'no-cross-door-query',
    'a real build with no cross-door query is read as NOBODY ASKED, over the identical clean ' +
      'board that this build reports as clean — the empty result is no longer available to be ' +
      'read as an answer about every door',
    `the old build's empty result was read as ${foreignReading.kind} — which is the reading ` +
      'this ticket was filed for, restored'
  );
}

// ------------------------------------------- 4. the two renderings must differ --

rule('4. THE COMPARISON — the two builds must not render the same');

const ownRendering = cleanReading.sentence;
console.log(`\n   THIS build   → ${ownRendering}`);
console.log(`   OLD build    → ${foreignRendering ?? '(section 3 did not run)'}\n`);

if (foreignRendering === null) {
  skipped++;
  console.log(
    '   SKIPPED — there is no second rendering to compare against. Two outputs that were never\n' +
    '   both produced cannot be shown to differ, and asserting it off one of them would be an\n' +
    '   assertion about nothing.\n'
  );
} else {
  verdict(
    ownRendering !== foreignRendering,
    'the two renderings differ, which is the acceptance criterion — the same reader over the ' +
      'same clean board says two different things depending on whether the build could name ' +
      'what it asked',
    'the two builds render identically, so the change has not been made'
  );
}

// ------------------------------------------------------------- 5. the type --

rule('5. THE TYPE — a report with no query attached cannot be written down at all');

// The alternative was an assertion — a runtime check that `askedJql` is set —
// and an assertion is a line a later author deletes with the build still green.
// This is the same trade `UnstaffableIssue.from` makes four call sites over:
// the state is not checked for, it is unconstructible. BOTH ARMS ARE REQUIRED,
// because a tsc run that failed for an unrelated reason would "prove" the guard
// while proving nothing.
const tscDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan649-tsc-'));
const srcModule = JSON.stringify(path.join(daemonDir, 'src', 'board-reconcile.js'));

const fixtureFor = (withQuery) => `
import type { UnstaffableReport, UnstaffableEvidence } from ${srcModule};

export const report: UnstaffableReport = {
  answered: true,
  consecutiveFailures: 0,
${withQuery ? "  askedJql: 'project IN (\"KAN\") AND assignee IS EMPTY AND statusCategory != Done',\n" : ''}  tickets: []
};

export const evidence: UnstaffableEvidence = {
  from: 'unstaffable-query',
${withQuery ? "  askedJql: 'project IN (\"KAN\") AND assignee IS EMPTY AND statusCategory != Done',\n" : ''}  tickets: []
};
`;

const typecheck = (withQuery) => {
  const file = path.join(tscDir, `kan649-${withQuery ? 'with' : 'without'}.ts`);
  fs.writeFileSync(file, fixtureFor(withQuery));
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

const withoutQuery = typecheck(false);
const withQuery = typecheck(true);
fs.rmSync(tscDir, { recursive: true, force: true });

console.log(`\n   a report and an evidence with NO askedJql → compiles: ${withoutQuery.compiled}`);
for (const line of withoutQuery.output.split('\n').slice(0, 4)) if (line) console.log(`     ${line}`);
console.log(`\n   the identical two WITH askedJql          → compiles: ${withQuery.compiled}`);
for (const line of withQuery.output.split('\n').slice(0, 5)) if (line) console.log(`     ${line}`);

// Matched on the bare member name rather than on a quoted form: tsc quotes
// members as `'askedJql'`, and an assertion pinned to one spelling of that goes
// quietly false when the compiler changes its punctuation.
const refusedLines = withoutQuery.output.split('\n').filter((l) => /error TS/.test(l));
const refusedForTheRightReason =
  !withoutQuery.compiled && withoutQuery.output.includes('askedJql') && refusedLines.length >= 2;

verdict(
  refusedForTheRightReason && withQuery.compiled,
  `the compiler refuses BOTH shapes when the query is missing (${refusedLines.length} errors, ` +
    'each naming askedJql) and accepts the identical two with it — so publishing a report that ' +
    'cannot say what it asked means changing a type in the open, not deleting a check',
  !withQuery.compiled
    ? 'THE CONTROL DID NOT COMPILE EITHER — this section failed for a reason that has nothing ' +
      'to do with the guard and proves nothing about it'
    : withoutQuery.compiled
      ? 'a report with no askedJql is representable, so the provenance is a convention after all'
      : `the refusal does not name askedJql or does not cover both shapes ` +
        `(${refusedLines.length} errors) — this section did not test what it claims to`
);

// ------------------------------------------------------------- verdict --

console.log('');
if (skipped) {
  console.log(
    'NOTE: the red was not driven against a real foreign build, so this run has NOT shown the\n' +
    'reader handling a genuine older daemon — only the shapes section 2 wrote for itself. The\n' +
    'header says what that leaves uncovered.'
  );
}
reportAndExit({ failures, skipped, allowSkipped });
