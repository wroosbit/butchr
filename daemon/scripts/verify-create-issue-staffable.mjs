// Live proof for KAN-577: a ticket filed through the proxy cannot be born
// unstaffable, and the condition is visible where a supervisor already looks.
//
// WHAT FAILURE THIS WOULD CATCH: `atlassian_create_issue` building a POST body
// with no `assignee` field — a ticket that is filed, looks filed, and can never
// be staffed, because the board reconciler starts an agent only for
// `assignee = currentUser() AND status IN ("In Progress", "In Review")`. It
// fails silently and in the comfortable direction: an unassigned ticket is
// indistinguishable from one nobody has triaged yet, so nothing goes red and
// nobody goes looking. 104 of them had accumulated by 2026-08-21.
//
// CI-RUNNABLE: partial — sections 2-6 assert against the built modules in
// process, so CI runs them: no daemon, no credential, no network. Section 1,
// the pre-fix build that makes the rest mean something, needs a `dist` built
// from the merge base and is SKIPPED (loudly) without one, which is what CI
// reaches. A run that skips it says so in its verdict rather than reporting a
// clean sweep.
//
// ---------------------------------------------------------------------------
// WHY SECTION 1 EXISTS, AND WHY THE REST IS WEAK WITHOUT IT
// ---------------------------------------------------------------------------
//
// "The built body carries an assignee" is trivially true of a body somebody
// just wrote an assignee into. What is worth proving is that the OLD path
// produced the defect and this one cannot — so section 1 builds the real
// pre-fix operation and shows the body it emits, `assignee` absent, exit 0, no
// warning, nothing anywhere saying a thing is wrong. That is the artefact this
// ticket is about: a mechanism working exactly as written, whose output is
// unusable in a way its own success cannot express.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER, NAMED BECAUSE IT WRITES ITS OWN INPUT
// ---------------------------------------------------------------------------
//
// Sections 2-4 call `build()` directly and supply the `ProxyBuildContext`
// themselves. So they prove what the operation DOES with an account id and
// without one — they do NOT prove that the router resolves a real one and hands
// it over. That is exactly the gap KAN-145 left between two green scripts, and
// it is named here rather than left to inference.
//
//   - Who covers the router leg: section 5, statically. It reads `router.ts` as
//     TEXT (never through `dist`) and asserts the resolve-then-build wiring is
//     present and awaited outside the coercion window.
//   - Who covers the live leg: NOBODY IN CI, and it needs a credential. The
//     PR body carries the live run — a ticket filed through the running proxy,
//     read back, and the assignee compared against `/rest/api/3/myself`.
//
// Section 6 is the other half of the ticket and stands alone: the reconciler's
// unstaffable report reaching `BoardHealth`, where `butchr_list_agents` shows
// it, instead of only `daemon.log`.
//
// ---------------------------------------------------------------------------
// ⚠ TWO THINGS THIS SCRIPT LEARNED BY MISSING THEM, RECORDED SO THE NEXT EDITOR
// DOES NOT
// ---------------------------------------------------------------------------
//
//  1. `handleAtlassianProxyCall`'s BODY IS LENGTH-SENSITIVE.
//     `verify-atlassian-proxy-write-scope.mjs` reads it as text and requires
//     `refuseWriteOutsideCaller(` within 3000 characters of the method's name.
//     An inline comment block added here pushed it to 3372 and reddened that
//     required check while the write policy was being applied exactly as
//     before. That is why the account-id resolution lives in the
//     `proxyBuildContext` helper. **Put explanation in the helper's docblock,
//     never in the handler's body.**
//
//  2. `build`'s SECOND PARAMETER MUST STAY OPTIONAL. Every caller under
//     `daemon/scripts` is JavaScript and passes one argument; a required
//     parameter throws at all of them. §5 now drives that case.
//
// Neither was caught by this script when it was written — both were caught by
// CI, on scripts this change was not about. The lesson is the one the sweep's
// own output states: run `run-ci-verify-set.mjs` before pushing, not after.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-create-issue-staffable.mjs
//
//   # with the pre-fix baseline for section 1 (no --depth on any fetch here;
//   # this is a worktree of a shared clone and a shallow fetch grafts it for
//   # every agent on the machine — KAN-523):
//   git show $(git merge-base HEAD origin/main):daemon/src/atlassian-proxy.ts \
//     > /tmp/kan577-prefix.ts
//   cp src/atlassian-proxy.ts /tmp/kan577-fixed.ts
//   cp /tmp/kan577-prefix.ts src/atlassian-proxy.ts
//   npx tsc --outDir dist-prefix
//   cp /tmp/kan577-fixed.ts src/atlassian-proxy.ts
//   node scripts/verify-create-issue-staffable.mjs dist-prefix

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, '..');
const srcDir = path.join(daemonRoot, 'src');
const distDir = path.join(daemonRoot, 'dist');
const prefixDist = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : null;

let failures = 0;
// Counted, and the verdict is derived from it: a run that skipped section 1
// exits 2, never 0. `lib/verdict-exit.mjs` owns that rule for every script here
// — see KAN-373 for why a skip that exits 0 is the defect and not the tidy
// outcome, and `--allow-skipped` for the caller that means to accept one.
let skipped = 0;
const fail = (section, why) => {
  failures++;
  console.error(`  ✗ [${section}] ${why}`);
};
const pass = (section, what) => console.log(`  ✓ [${section}] ${what}`);
const skip = (section, why) => {
  skipped++;
  console.log(`  ⚠ [${section}] SKIPPED: ${why}`);
};

// --------------------------------------------------------- setup guards --
//
// `process.exit(1)` here is a SETUP GUARD and not a verdict: it says the script
// could not run, never that the product is broken. The verdict-derived exit is
// at the bottom and reads `failures`.

if (!existsSync(distDir)) {
  console.error('daemon/dist is missing. Run `npm run build` in daemon/ first.');
  process.exit(1); // setup guard
}

// KAN-577 carries forward the rule that cost PR #127 an afternoon: a proof run
// over a `dist` older than `src` reads a completely plausible pass for code that
// never executed, and nothing in its output can say so. This script imports from
// `dist`, so it checks rather than trusting the operator's last build.
{
  const newest = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => statSync(path.join(dir, e.name)).mtimeMs)
      .reduce((a, b) => Math.max(a, b), 0);
  const newestSrc = newest(srcDir);
  const newestDist = readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => statSync(path.join(distDir, e.name)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  // Two seconds of slack: tsc writes the whole tree in a burst and file mtimes
  // are not ordered within it.
  if (newestSrc > newestDist + 2000) {
    console.error(
      `daemon/dist is older than daemon/src (src ${new Date(newestSrc).toISOString()}, ` +
      `dist ${new Date(newestDist).toISOString()}). Whatever this printed would be about ` +
      'code you did not write. Run `npm run build` in daemon/ and try again.'
    );
    process.exit(1); // setup guard
  }
}

const proxy = await import(pathToFileURL(path.join(distDir, 'atlassian-proxy.js')).href);
const createIssue = proxy.operationByTool('atlassian_create_issue');
if (!createIssue) {
  console.error('atlassian_create_issue is not in the operation table at all.');
  process.exit(1); // setup guard
}

const ACCOUNT = '712020:619ec5ec-2e92-492f-8979-91ccda318230';
const ARGS = { projectKey: 'KAN', issueType: 'Task', summary: 'a probe', parent: 'KAN-39' };

// ------------------------------------------------------------ 1. unfixed --
//
// The pre-fix build, producing the defect. Skipped loudly without a baseline.

console.log('\n1. the pre-fix path — a ticket born with no assignee');
if (!prefixDist) {
  skip(
    '1',
    'no pre-fix dist given. The header has the recipe. Sections 2-6 below are a claim ' +
    'about the fixed build only — nothing here has shown the defect.'
  );
} else if (!existsSync(path.join(prefixDist, 'atlassian-proxy.js'))) {
  skip('1', `${prefixDist}/atlassian-proxy.js does not exist.`);
} else {
  const old = await import(pathToFileURL(path.join(prefixDist, 'atlassian-proxy.js')).href);
  const oldOp = old.operationByTool('atlassian_create_issue');
  // The pre-fix `build` takes one argument. Passing a context it does not
  // declare is harmless and is what makes this the SAME CALL as section 3 —
  // the difference measured is the operation, never the call.
  const built = oldOp.build(ARGS, { selfAccountId: ACCOUNT });
  if ('error' in built) {
    fail('1', `the pre-fix build refused, so it cannot demonstrate the defect: ${built.error}`);
  } else {
    console.log(`    body: ${JSON.stringify(built.body)}`);
    if (built.body?.fields?.assignee === undefined) {
      pass('1', 'pre-fix build emits NO assignee — and reports success. This is the defect.');
    } else {
      fail('1', 'the pre-fix build already carried an assignee; the baseline is not pre-fix.');
    }
    if (oldOp.needsSelfAccountId) {
      fail('1', 'the pre-fix operation already declared needsSelfAccountId.');
    } else {
      pass('1', 'pre-fix operation declares no need for an account id — nothing asked for one.');
    }
  }
}

// ------------------------------------------------------------ 2. refused --

console.log('\n2. no account id → the create is refused and nothing is sent');
{
  const built = createIssue.build(ARGS, { selfAccountId: null });
  if (!('error' in built)) {
    fail('2', `built a request with no account id: ${JSON.stringify(built)}`);
  } else if (!/could not establish which Atlassian account/.test(built.error)) {
    fail('2', `refused, but the sentence does not name the cause: ${built.error}`);
  } else if (!/Nothing was sent/.test(built.error)) {
    fail('2', `refused without telling the agent nothing was sent: ${built.error}`);
  } else {
    pass('2', 'refused, naming the cause and saying nothing was sent');
    console.log(`    error: ${built.error.slice(0, 96)}…`);
  }
}

// ---------------------------------------------------------- 3. assigned --

console.log('\n3. an account id → every ticket is born assigned to it');
{
  const built = createIssue.build(ARGS, { selfAccountId: ACCOUNT });
  if ('error' in built) {
    fail('3', `refused with a valid account id: ${built.error}`);
  } else {
    console.log(`    body.fields.assignee: ${JSON.stringify(built.body?.fields?.assignee)}`);
    if (built.body?.fields?.assignee?.accountId !== ACCOUNT) {
      fail('3', `assignee is ${JSON.stringify(built.body?.fields?.assignee)}, not the account id`);
    } else {
      pass('3', 'body carries fields.assignee.accountId, and it is the daemon\'s own account');
    }
    if (built.path !== '/rest/api/3/issue') fail('3', `path moved: ${built.path}`);
  }
}

// -------------------------------------------- 4. the caller cannot choose --
//
// The assignee is a grant, not an argument. An agent that supplies one must not
// be able to file work into somebody else's queue — and must not be able to
// file an unassigned one either, which is the same hole from the other side.

console.log('\n4. a caller-supplied assignee changes nothing');
{
  const other = '000000:1111aaaa-2222-3333-4444-555555555555';
  for (const [label, extra] of [
    ['assignee', { assignee: other }],
    ['assignee_account_id', { assignee_account_id: other }],
    ['fields.assignee', { fields: { assignee: { accountId: other } } }],
    ['an explicit null', { assignee: null }]
  ]) {
    const built = createIssue.build({ ...ARGS, ...extra }, { selfAccountId: ACCOUNT });
    if ('error' in built) {
      fail('4', `${label}: refused a create it should have accepted — ${built.error}`);
    } else if (built.body?.fields?.assignee?.accountId !== ACCOUNT) {
      fail('4', `${label}: the caller moved the assignee to ` +
        `${JSON.stringify(built.body?.fields?.assignee)}`);
    } else {
      pass('4', `${label} in args is ignored; the assignee is still the daemon's account`);
    }
  }
  if (JSON.stringify(createIssue.inputSchema).includes('assignee')) {
    fail('4', 'inputSchema advertises an assignee argument — it must not take one');
  } else {
    pass('4', 'inputSchema advertises no assignee argument at all');
  }
}

// ----------------------------------- 5. the declaration and the router leg --
//
// STATIC, and deliberately so: this section reads source TEXT and is therefore
// unaffected by a stale or failed build. It covers the one thing sections 2-4
// cannot, because they supply their own context — that the router resolves a
// real account id and hands it to `build`.

console.log('\n5. every operation that declares the need refuses without it (and the router wiring)');
{
  const declaring = proxy.PROXY_OPERATIONS.filter((op) => op.needsSelfAccountId);
  if (!declaring.length) {
    fail('5', 'no operation declares needsSelfAccountId, so nothing resolves an account id');
  }
  for (const op of declaring) {
    const built = op.build(ARGS, { selfAccountId: null });
    if (!('error' in built)) {
      fail('5', `${op.tool} declares needsSelfAccountId but builds a request without one`);
    } else {
      pass('5', `${op.tool} declares the need and refuses when it is not met`);
    }
  }

  const routerText = readFileSync(path.join(srcDir, 'router.ts'), 'utf8');

  // The resolution lives in `proxyBuildContext`, deliberately OUT of
  // `handleAtlassianProxyCall`'s body — see that helper's docblock, and see the
  // note at the head of this file about why the handler's body is
  // length-sensitive. So this asserts the helper's two halves, not an inline
  // block: it must gate on the declaration and it must ask the daemon.
  const resolves =
    /proxyBuildContext[\s\S]{0,600}?operation\.needsSelfAccountId[\s\S]{0,300}?selfAccountId\(\)/.test(
      routerText
    );
  if (!resolves) {
    fail('5', 'router.ts does not resolve selfAccountId for operations that declare the need');
  } else {
    pass('5', 'router.ts resolves the account id from the daemon, gated on the declaration');
  }
  if (!/await this\.proxyBuildContext\(operation\)/.test(routerText)) {
    fail('5', 'the proxy handler does not call proxyBuildContext');
  } else {
    pass('5', 'the proxy handler resolves a build context before building');
  }
  if (!/operation\.build\(args, context\)/.test(routerText)) {
    fail('5', 'router.ts does not pass the build context to operation.build');
  } else {
    pass('5', 'router.ts passes that context into operation.build');
  }
  // The resolve is an `await`, and the coercion window's safety argument is that
  // nothing awaits inside it. Order is the assertion.
  const iResolve = routerText.indexOf('await this.proxyBuildContext(operation)');
  const iBegin = routerText.indexOf('beginBuildCoercions();', iResolve);
  if (iResolve < 0 || iBegin < 0 || iResolve > iBegin) {
    fail('5', 'the account-id await is not outside the beginBuildCoercions window');
  } else {
    pass('5', 'the await sits before beginBuildCoercions, so the window stays synchronous');
  }

  // A one-argument call must REFUSE rather than throw. Every caller under
  // `daemon/scripts` is JavaScript and passes one argument, so a required
  // context parameter reddened two unrelated proxy proofs with
  // `Cannot read properties of undefined` — KAN-493's shape, caught in CI
  // rather than here because this script did not think to try it.
  const oneArg = createIssue.build(ARGS);
  if (!('error' in oneArg)) {
    fail('5', `a one-argument build produced a request instead of refusing: ${JSON.stringify(oneArg)}`);
  } else {
    pass('5', 'a one-argument build refuses rather than throwing — the default fails closed');
  }
}

// ------------------------------------------------- 6. the visible surface --
//
// The second half of the ticket. `findNearMisses` has detected unstaffable
// tickets since KAN-256 and written them to `daemon.log` and nowhere else. This
// asserts they now reach `BoardHealth`, which is what `butchr_list_agents`
// returns — and that a cycle whose diagnostic did NOT answer reports `null`
// rather than an empty list, because a clean board and a blind one must not
// read the same.

console.log('\n6. an unstaffable ticket is visible on BoardHealth, not just in the log');
{
  const { BoardReconciler, BOARD_JQL } = await import(
    pathToFileURL(path.join(distDir, 'board-reconcile.js')).href
  );

  const row = (key, statusName, assigneeAccountId) => ({
    key,
    issueTypeName: 'Task',
    statusName,
    assigneeAccountId,
    assigneeDisplayName: assigneeAccountId ? 'Wroos Bit' : null
  });

  // The partitioned query returns one properly assigned ticket; the diagnostic
  // returns that one AND an unassigned one the partitioned query can never see.
  const make = (diagnosticOutcome) =>
    new BoardReconciler({
      jira: {
        searchBoard: async (jql) =>
          jql.includes('assignee = currentUser()')
            ? { ok: true, issues: [row('KAN-100', 'In Progress', ACCOUNT)] }
            : diagnosticOutcome
      },
      runningAgents: () => [],
      activate: async () => ({ success: true }),
      deactivate: async () => ({ success: true }),
      mode: () => 'report',
      log: () => {},
      startStaggerMs: 0
    });

  if (!BOARD_JQL.includes('assignee = currentUser()')) {
    fail('6', `BOARD_JQL no longer partitions on assignee: ${BOARD_JQL}`);
  }

  const seen = make({
    ok: true,
    issues: [row('KAN-100', 'In Progress', ACCOUNT), row('KAN-568', 'In Progress', null)]
  });
  await seen.reconcileOnce();
  const health = seen.health();
  const listed = (health?.unstaffable ?? []).map((m) => m.key);
  console.log(`    health.unstaffable: ${JSON.stringify(health?.unstaffable)}`);
  if (!listed.includes('KAN-568')) {
    fail('6', `the unassigned In Progress ticket is not on BoardHealth: ${JSON.stringify(listed)}`);
  } else if (listed.includes('KAN-100')) {
    fail('6', 'a properly assigned ticket was reported as unstaffable');
  } else {
    pass('6', 'the unassigned ticket is named on health.unstaffable and the assigned one is not');
  }

  // The red arm: a diagnostic that did not answer must not read as a clean
  // board. This is the assertion that can go false — and the one that matters,
  // because `[]` is the comfortable answer.
  const blind = make({ ok: false, backOff: false, error: 'Atlassian said 503' });
  await blind.reconcileOnce();
  const blindHealth = blind.health();
  console.log(`    health.unstaffable (diagnostic failed): ${JSON.stringify(blindHealth?.unstaffable)}`);
  if (blindHealth?.unstaffable !== null) {
    fail('6', `a failed diagnostic reported ${JSON.stringify(blindHealth?.unstaffable)} ` +
      'rather than null — "nobody looked" is being reported as "there are none"');
  } else {
    pass('6', 'a failed diagnostic reports null, so a blind cycle cannot read as a clean board');
  }
}

// ------------------------------------------------------------- verdict --

console.log('');
if (skipped) {
  console.log(
    'NOTE: section 1 did not run, so this run has NOT shown the pre-fix defect. It shows ' +
    'the fixed build behaving correctly, which is the weaker half of the claim. The header ' +
    'has the recipe for the baseline.'
  );
}
reportAndExit({ failures, skipped });
