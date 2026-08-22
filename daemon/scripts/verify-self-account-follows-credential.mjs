// Live proof for KAN-646: the account id the proxy stamps as `assignee` cannot
// outlive the credential it was read from.
//
// WHAT FAILURE THIS WOULD CATCH: `JiraIssueTypeService.selfAccountId()` serving
// a remembered account id after the stored credential has been replaced — so
// `atlassian_create_issue` stamps every ticket with the account the daemon
// USED to authenticate as, and keeps doing it until somebody restarts the
// daemon. It is silent in both directions: the create succeeds, the ticket has
// a populated assignee, and `boardControl.health.unstaffable` looks for an
// EMPTY one, so no existing surface sees it. A task born pointing at the wrong
// account looks exactly like one born correctly until the wrong machine picks
// it up, or nothing does.
//
// ⚠ THE MEASURED SIGNATURE IS TWO FIELDS OF ONE WRITE DISAGREEING. The proxy
// sends `assignee` from this cache; Jira fills `creator` server-side from the
// credential actually on the request. KAN-627 was filed
// `creator: John Winstead, assignee: Wroos Bit` — one call, two accounts. The
// two tickets filed after the daemon restart (KAN-643, KAN-646) read the same
// name in both fields. That divergence is what this script reproduces in
// process, without a credential and without a network.
//
// CI-RUNNABLE: partial — sections 2-6 drive the built service in process, so
// CI runs them: no daemon, no credential, no network. Section 1, the pre-fix
// build that makes the rest mean something, needs a `dist` built from the
// merge base and is SKIPPED (loudly) without one. A run that skips it exits 2
// and says so, rather than reporting a clean sweep.
//
// ---------------------------------------------------------------------------
// WHY SECTION 1 EXISTS, AND WHY THE REST IS WEAK WITHOUT IT
// ---------------------------------------------------------------------------
//
// "The account id follows the credential" is trivially true of code somebody
// just wrote to make it follow. What is worth proving is that the OLD path
// produced the defect: section 1 drives the real pre-fix `selfAccountId`
// through the identical credential swap and shows it returning the FIRST
// account for the SECOND credential, exit 0, no warning, nothing anywhere
// saying a thing is wrong. That is the artefact this ticket is about — a
// mechanism working exactly as written, whose output is wrong in a way its own
// success cannot express.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS SCRIPT DOES NOT COVER — IT WRITES ITS OWN INPUT
// ---------------------------------------------------------------------------
//
// Every section here constructs the credential store and the transport itself.
// So it proves what the SERVICE does when a credential changes underneath it.
// It does NOT prove that a real settings-UI credential swap reaches this code,
// and it does NOT prove that the id the service returns is the account Jira
// actually authenticates the next request as. Both are the KAN-145 shape — a
// script asserting on a record it wrote — and they are named here rather than
// left to inference.
//
//   - Who covers the swap reaching the service: NOBODY IN CI. `setCredential`
//     and `clearCredential` both call `reset()`, and §6 asserts statically that
//     neither is what this fix depends on — which is the point of binding the
//     cache to a fingerprint rather than clearing it in `reset()`.
//   - Who covers the live leg — that the stamped account equals the account
//     Jira sees: NOBODY IN CI, and it needs a credential. The PR body carries
//     the live reading instead: the `creator`/`assignee` pair on the three
//     tickets already filed through this path, which is the same comparison
//     taken from the far side.
//   - ⚠ Who covers "the stamp is the account this ticket SHOULD have gone to":
//     NOBODY, here or anywhere, and it is a different question. This script is
//     about the stamp matching the credential; whether a supervisor filing a
//     Task should stamp its OWN account or the WORKFORCE account is item 2 of
//     KAN-646 and is unresolved. A green here says the mechanism is coherent,
//     never that the policy is right.
//
// ---------------------------------------------------------------------------
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-self-account-follows-credential.mjs
//
//   # with the pre-fix baseline for section 1 (no --depth on any fetch here;
//   # this is a worktree of a shared clone and a shallow fetch grafts it for
//   # every agent on the machine — KAN-523):
//   git show $(git merge-base HEAD origin/main):daemon/src/jira.ts > /tmp/kan646-prefix.ts
//   cp src/jira.ts /tmp/kan646-fixed.ts
//   cp /tmp/kan646-prefix.ts src/jira.ts
//   npx tsc --outDir dist-prefix
//   cp /tmp/kan646-fixed.ts src/jira.ts
//   node scripts/verify-self-account-follows-credential.mjs dist-prefix

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';
import { requireFreshDist } from './lib/require-fresh-dist.mjs';
import { maskNonCode } from './lib/mask-non-code.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, '..');
const srcDir = path.join(daemonRoot, 'src');
const distDir = path.join(daemonRoot, 'dist');
const prefixDist = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : null;

let failures = 0;
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
// `requireFreshDist` owns both halves: `dist` must exist, and it must not be
// older than `src` — a proof run over a stale `dist` reads a plausible pass for
// code that never executed (PR #127). Its exits are SETUP GUARDS and not
// verdicts; the verdict-derived exit is at the bottom and reads `failures`.

requireFreshDist(srcDir, distDir, { hint: 'cd daemon && npm run build' });

// ------------------------------------------------------------ the rig --
//
// One credential swap, driven against whichever build is under test. Nothing
// here touches the disk, the network or a real credential: the store is an
// object with the three methods the service calls, and the transport answers
// the identity probe with whatever account the current credential belongs to.
//
// `probes` is the load-bearing counter. The defect and its fix are BOTH about
// how often `/rest/api/3/myself` is consulted, so a fix that simply deleted the
// cache would pass an "is it the right account" assertion and fail here — which
// is why §3 asserts the cache still works rather than only that it expires.

const CRED_A = { siteUrl: 'https://example.atlassian.net', email: 'a@example.com', token: 'tok-aaaa' };
// Same length token on purpose is NOT what this is: the fingerprint includes
// the email, and these differ by email as a real account swap would.
const CRED_B = { siteUrl: 'https://example.atlassian.net', email: 'b@example.com', token: 'tok-bbbb' };
const ACCOUNT_OF = new Map([
  [CRED_A.email, '712020:aaaaaaaa-first-account'],
  [CRED_B.email, '712020:bbbbbbbb-second-account']
]);

function makeRig(JiraIssueTypeService) {
  let current = CRED_A;
  const probes = [];
  const store = {
    load: async () => current,
    save: async () => 'file',
    clear: async () => { current = null; },
    status: () => ({ configured: current !== null }),
    storageTarget: async () => ({ storage: 'file' })
  };
  const makeTransport = (cred) => ({
    get: async (p) => {
      probes.push({ path: p, email: cred.email });
      if (p !== '/rest/api/3/myself') return { status: 404, body: {}, legs: [] };
      const accountId = ACCOUNT_OF.get(cred.email);
      return { status: 200, body: { accountId }, legs: [] };
    }
  });
  const service = new JiraIssueTypeService(store, 5000, () => Date.now(), makeTransport);
  return {
    service,
    probes,
    swapTo: (cred) => { current = cred; },
    clearCred: () => { current = null; }
  };
}

async function loadService(distRoot) {
  const mod = await import(pathToFileURL(path.join(distRoot, 'jira.js')).href);
  return mod.JiraIssueTypeService;
}

// ============================ 1. the pre-fix build, showing the defect ====

console.log('\n[1] the pre-fix build: does a swapped credential still get the old account?');

if (!prefixDist) {
  skip('1', 'no pre-fix dist given. This run does NOT show the defect — see the header recipe.');
} else if (!existsSync(path.join(prefixDist, 'jira.js'))) {
  skip('1', `${prefixDist}/jira.js is missing. This run does NOT show the defect.`);
} else {
  const Svc = await loadService(prefixDist);
  const rig = makeRig(Svc);

  const first = await rig.service.selfAccountId();
  rig.swapTo(CRED_B);
  const second = await rig.service.selfAccountId();

  console.log(`      credential A (${CRED_A.email}) -> ${first}`);
  console.log(`      credential B (${CRED_B.email}) -> ${second}`);
  console.log(`      identity probes made: ${rig.probes.length}`);

  if (second === ACCOUNT_OF.get(CRED_B.email)) {
    fail('1', 'the pre-fix build returned the CORRECT account for credential B. Either the ' +
      'dist given is not the pre-fix build, or the defect is not where this script says ' +
      'it is. Section 1 exists to fail here.');
  } else if (second === first) {
    pass('1', 'REPRODUCED: the pre-fix build served credential A\'s account id for ' +
      'credential B, made no second identity probe, and reported no error of any kind. ' +
      'A ticket filed here is stamped with an account the daemon is no longer ' +
      'authenticating as, and the create succeeds.');
  } else {
    fail('1', `the pre-fix build returned an account matching neither credential: ${second}`);
  }
}

// ============================ 2. the fixed build: the id follows the cred ====

console.log('\n[2] the fixed build: a swapped credential gets the new account');
{
  const Svc = await loadService(distDir);
  const rig = makeRig(Svc);

  const first = await rig.service.selfAccountId();
  rig.swapTo(CRED_B);
  const second = await rig.service.selfAccountId();

  console.log(`      credential A (${CRED_A.email}) -> ${first}`);
  console.log(`      credential B (${CRED_B.email}) -> ${second}`);

  if (first !== ACCOUNT_OF.get(CRED_A.email)) {
    fail('2', `credential A resolved to ${first}, expected ${ACCOUNT_OF.get(CRED_A.email)}`);
  } else if (second !== ACCOUNT_OF.get(CRED_B.email)) {
    fail('2', `credential B resolved to ${second} — the cache outlived the credential it ` +
      'was read from, which is the KAN-646 defect exactly.');
  } else {
    pass('2', 'the account id followed the credential across the swap, with no restart');
  }
}

// ============================ 3. the cache still caches ====================
//
// A fix that deleted the cache would satisfy §2 and cost an identity probe on
// every single create. This is the assertion that stops the lazy repair.

console.log('\n[3] the cache is still a cache: one credential costs one probe');
{
  const Svc = await loadService(distDir);
  const rig = makeRig(Svc);

  await rig.service.selfAccountId();
  await rig.service.selfAccountId();
  await rig.service.selfAccountId();
  const beforeSwap = rig.probes.length;

  rig.swapTo(CRED_B);
  await rig.service.selfAccountId();
  await rig.service.selfAccountId();
  const afterSwap = rig.probes.length - beforeSwap;

  console.log(`      probes for 3 calls on credential A: ${beforeSwap}`);
  console.log(`      probes for 2 calls on credential B: ${afterSwap}`);

  if (beforeSwap !== 1) {
    fail('3', `three calls on one credential made ${beforeSwap} identity probes, expected 1 — ` +
      'the cache is not caching, so this "fix" pays a network round trip per create.');
  } else if (afterSwap !== 1) {
    fail('3', `two calls after the swap made ${afterSwap} identity probes, expected 1`);
  } else {
    pass('3', 'each credential costs exactly one identity probe, however many times it is asked');
  }
}

// ============================ 4. a failure is still not cached =============

console.log('\n[4] a failed probe is not remembered');
{
  const Svc = await loadService(distDir);
  let current = CRED_A;
  let failNext = true;
  const store = {
    load: async () => current,
    save: async () => 'file',
    clear: async () => { current = null; },
    status: () => ({ configured: true }),
    storageTarget: async () => ({ storage: 'file' })
  };
  const makeTransport = (cred) => ({
    get: async () => {
      if (failNext) throw Object.assign(new Error('network'), { legs: [] });
      return { status: 200, body: { accountId: ACCOUNT_OF.get(cred.email) }, legs: [] };
    }
  });
  const service = new Svc(store, 5000, () => Date.now(), makeTransport);

  const during = await service.selfAccountId();
  failNext = false;
  const after = await service.selfAccountId();

  console.log(`      while Atlassian is unreachable -> ${JSON.stringify(during)}`);
  console.log(`      once it answers again          -> ${after}`);

  if (during !== null) {
    fail('4', `a failed probe returned ${JSON.stringify(during)} rather than null`);
  } else if (after !== ACCOUNT_OF.get(CRED_A.email)) {
    fail('4', 'a transient failure was cached: the service refused for the life of the ' +
      'process, which would turn a thirty-second outage into a daemon that files nothing ' +
      'until it is restarted.');
  } else {
    pass('4', 'a failure left the cache untouched and the next call retried');
  }
}

// ============================ 5. no credential is a refusal ================
//
// The create path turns null into a loud "nothing was sent". What must never
// happen is a remembered id being served on behalf of a credential that has
// been cleared — which is `clearCredential()`'s case, and which the pre-fix
// field survived exactly as it survived a swap.

console.log('\n[5] a cleared credential refuses rather than serving the remembered id');
{
  const Svc = await loadService(distDir);
  const rig = makeRig(Svc);

  const before = await rig.service.selfAccountId();
  rig.clearCred();
  const after = await rig.service.selfAccountId();

  console.log(`      with a credential -> ${before}`);
  console.log(`      once cleared      -> ${JSON.stringify(after)}`);

  if (before !== ACCOUNT_OF.get(CRED_A.email)) {
    fail('5', `setup: expected ${ACCOUNT_OF.get(CRED_A.email)}, got ${before}`);
  } else if (after !== null) {
    fail('5', `a cleared credential still resolved to ${after}. The proxy would stamp that ` +
      'account onto every ticket it files with no credential behind it at all.');
  } else {
    pass('5', 'a cleared credential resolves to null, which the create path renders as a refusal');
  }
}

// ============================ 6. the fix does not depend on reset() ========
//
// STATIC, and it reads `src` as TEXT rather than through `dist` — so its
// verdict is about what is written, and a failed build cannot make it lie.
//
// This is the section that distinguishes the fix from the repair that was
// available and weaker. Adding `this.cachedAccountId = null` to `reset()` fixes
// the instance and leaves the class: `reset()` is a list a later author extends
// by remembering to, and the defect is a field's ABSENCE from that list. The
// cache entry carrying its own fingerprint makes the stale answer
// unrepresentable instead — so `reset()` may forget this field forever.

console.log('\n[6] static: the cache is bound to a fingerprint, not cleared by reset()');
{
  // ⚠ COMMENTS AND STRINGS ARE MASKED BEFORE ANY ASSERTION BELOW, AND THAT IS
  // LOAD-BEARING IN BOTH DIRECTIONS. This file's own docblocks discuss
  // `cachedAccountId` by name, at length, explaining why it is gone — so a
  // check reading raw text finds the retired field in the prose retiring it
  // and goes red on a correct build. That is not hypothetical: this section did
  // exactly that on its first run. The opposite error cost
  // `verify-atlassian-proxy-write-scope.mjs` a green off a docblock naming a
  // call that had been deleted. `maskNonCode` is the shared implementation — it
  // blanks comments, strings and regex literals while preserving every offset,
  // so prose cannot vote either way.
  const source = maskNonCode(readFileSync(path.join(srcDir, 'jira.ts'), 'utf8'));

  const bodyOf = (name) => {
    const at = source.indexOf(`${name}(`);
    if (at < 0) return null;
    const open = source.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    return null;
  };

  const selfBody = bodyOf('public async selfAccountId');
  const resetBody = bodyOf('private reset');

  // ⚠ THESE THREE ASSERTIONS REQUIRE THE COMPARISON, NOT THE WORD, AND THAT
  // DISTINCTION WAS FOUND BY DRIVING THEM RED RATHER THAN BY WRITING THEM.
  // An earlier draft asked only whether `selfAccountId`'s body CONTAINED
  // "fingerprint" and read `cachedAccount`. Both mutations in the PR body
  // survive that: one deletes the `===` and keeps the local, the other stores
  // `{ fingerprint: '', accountId }`, and each leaves the word in the body
  // while removing every effect it had. The behavioural sections caught both;
  // this one went green through both and would have licensed the reading that
  // the structure was still sound.
  const guarded =
    /this\.cachedAccount\s*&&\s*this\.cachedAccount\.fingerprint\s*===\s*fingerprint/.test(selfBody);
  const refusesWithoutCredential = /if\s*\(!fingerprint\)\s*return null/.test(selfBody);
  const storesRealFingerprint = /this\.cachedAccount\s*=\s*\{\s*fingerprint\s*[,}]/.test(selfBody);

  if (!selfBody) {
    fail('6', 'could not find the body of `selfAccountId` in src/jira.ts');
  } else if (!guarded) {
    fail('6', '`selfAccountId` does not compare the cached fingerprint against the current ' +
      "one. Naming a fingerprint is not binding to it: a body that computes the value and " +
      'never tests it serves a stale account exactly as the unbound field did.');
  } else if (!refusesWithoutCredential) {
    fail('6', '`selfAccountId` does not refuse when there is no credential, so a cleared ' +
      'credential leaves the remembered id serveable');
  } else if (!storesRealFingerprint) {
    fail('6', 'the cache is written with something other than the resolved fingerprint — a ' +
      'placeholder stored here defeats the comparison above while satisfying it textually');
  } else if (/\bcachedAccountId\b/.test(source)) {
    fail('6', 'the unbound `cachedAccountId` field is still present in src/jira.ts');
  } else {
    pass('6', '`selfAccountId` resolves the credential fingerprint, refuses without one, ' +
      'and serves a cached id only when the fingerprints compare equal');
  }

  if (!resetBody) {
    fail('6', 'could not find the body of `reset` in src/jira.ts');
  } else if (/cachedAccount/.test(resetBody)) {
    fail('6', '`reset()` clears the account cache. That is the weaker repair: it works only ' +
      'while somebody remembers to keep it in the list, and the defect being guarded is a ' +
      "field's absence from exactly that list. The binding is supposed to make clearing " +
      'unnecessary — if it is needed here, it is not doing its job.');
  } else {
    pass('6', '`reset()` does not clear the account cache, and does not need to: the ' +
      'fingerprint makes a stale answer unserveable');
  }

  // One definition of "the credential changed", consulted by both readers. Two
  // spellings that drifted apart would hand out an id belonging to a credential
  // the transport had already replaced — the defect, reintroduced sideways.
  const transportBody = bodyOf('private async getTransport');
  const fpBody = bodyOf('private async credentialFingerprint');
  if (!fpBody) {
    fail('6', 'there is no `credentialFingerprint` helper, so the two caches key on ' +
      'independent spellings of the same fact');
  } else if (!transportBody || !/fingerprintOf\(/.test(transportBody)) {
    fail('6', '`getTransport` does not use the shared `fingerprintOf`, so the transport and ' +
      'the account cache can disagree about what a credential change is');
  } else if (!/fingerprintOf\(/.test(fpBody)) {
    fail('6', '`credentialFingerprint` does not use the shared `fingerprintOf`');
  } else {
    pass('6', 'the transport and the account cache key on one shared `fingerprintOf`');
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
