// Live proof for KAN-646 want 3: a ticket filed through the proxy says which
// account it landed on, and cannot say nothing.
//
// WHAT FAILURE THIS WOULD CATCH: `atlassian_create_issue` returning a plain
// success for a ticket stamped with the wrong account — filed, looking filed,
// with a populated assignee that points somewhere nobody intended. Every
// existing surface is blind to it: `boardControl.health.unstaffable` looks for
// an EMPTY assignee and this population is populated-and-wrong, so the defect
// has no symptom at all until the wrong machine picks the ticket up or nothing
// does. KAN-643 and KAN-649 were both repaired by hand AFTER the fact, because
// nothing said at filing time which account had gone on.
//
// ⚠ AND THE SECOND FAILURE, WHICH IS THE ONE THAT LOOKS LIKE SUCCESS: a
// read-back that could not be made being OMITTED from the answer. An absent
// audit and a clean audit must not be the same bytes. That is KAN-649's finding
// exactly — `boardControl.health.unstaffable` read `[]` for 48 minutes while
// the running build had no cross-door query at all, and `[]` is precisely what
// a clean board looks like. §3 and §4 below are the sections that enforce the
// difference, and they are the reason this script exists rather than one
// assertion that the happy path is happy.
//
// CI-RUNNABLE: yes — every section drives the built router in process against a
// stub transport: no daemon, no credential, no network, no Jira.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS SCRIPT DOES NOT COVER — IT WRITES ITS OWN INPUT
// ---------------------------------------------------------------------------
//
// This calls `stampReadBack` directly and supplies the Jira responses itself.
// So it proves what the daemon DOES with a given read-back — it does NOT prove
// that a real create reaches this code, and it does NOT prove the values it is
// fed resemble what Jira sends. That is the KAN-145 shape, named rather than
// left to inference.
//
//   - Who covers the wiring: §5, statically. It reads `router.ts` as TEXT
//     (never through `dist`), so a failed build cannot make its verdict lie,
//     and asserts the call is gated on `needsSelfAccountId` and its result
//     spread into the success response.
//   - Who covers the live leg: NOBODY IN CI, and it needs a credential. The PR
//     body carries the same comparison taken from the far side — the
//     `creator`/`assignee` pair on the tickets already filed through this path.
//
// ⚠ - Who covers "the stamp is the account this ticket SHOULD have gone to":
//     NOBODY, here or anywhere. This daemon holds one credential and can name
//     one account; `JiraCredential` is `{siteUrl, email, token}` and there is
//     no second account in this codebase to compare against. A supervisor
//     filing a Task on the manager box gets `creator === assignee === manager`
//     — they AGREE, §2 passes, and the ticket is still on the wrong account.
//     That is KAN-646 want 2, it needs a configuration input that does not
//     exist, and a green from this script says nothing whatever about it.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-create-stamp-is-audited.mjs

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';
import { requireFreshDist } from './lib/require-fresh-dist.mjs';
import { maskNonCode } from './lib/mask-non-code.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, '..');
const srcDir = path.join(daemonRoot, 'src');
const distDir = path.join(daemonRoot, 'dist');

let failures = 0;
const fail = (section, why) => {
  failures++;
  console.error(`  ✗ [${section}] ${why}`);
};
const pass = (section, what) => console.log(`  ✓ [${section}] ${what}`);

// --------------------------------------------------------- setup guards --
//
// `requireFreshDist` owns both halves of this: `dist` must exist, and it must
// not be older than `src`. A proof run over a stale `dist` reads a completely
// plausible pass for code that never executed, and nothing in its own output
// can say so — PR #127's afternoon. Its exits are SETUP GUARDS and not
// verdicts; the verdict-derived exit is at the bottom and reads `failures`.

requireFreshDist(srcDir, distDir, { hint: 'cd daemon && npm run build' });

// ------------------------------------------------------------ the rig --
//
// `stampReadBack` is `private` in TypeScript, which is a compile-time claim and
// nothing at runtime — so it is reachable here on the prototype. It touches
// exactly one collaborator (`this.jira.proxyRead`), so the whole rig is an
// object with that one method.

const { MessageRouter: Router } = await import(pathToFileURL(path.join(distDir, 'router.js')).href);

const MANAGER = { accountId: '712020:manager-account', displayName: 'John Winstead' };
const WORKER = { accountId: '712020:worker-account', displayName: 'Wroos Bit' };

const readBack = (jiraAnswer) => {
  const self = { jira: { proxyRead: async () => jiraAnswer } };
  return Router.prototype.stampReadBack.call(self, { key: 'KAN-999' });
};

const ok = (assignee, creator) => ({
  ok: true,
  status: 200,
  body: { fields: { assignee, creator } }
});

// ============================ 1. the divergence is caught and named ========
//
// The KAN-627 signature: one call, two fields, two accounts. `creator` is
// filled by Jira from the credential on the request; `assignee` is what this
// daemon chose to send. They disagree only if the stamp did not come from the
// live credential.

console.log('\n[1] a stamp that disagrees with the credential is reported, loudly');
{
  const r = await readBack(ok(WORKER, MANAGER));
  console.log(`      creator=${r.creator?.displayName}  assignee=${r.assignee?.displayName}`);
  console.log(`      matchesCredential=${r.matchesCredential}  verified=${r.verified}`);

  if (r.verified !== true) {
    fail('1', `a successful read-back reported verified=${r.verified}`);
  } else if (r.matchesCredential !== false) {
    fail('1', 'two different accounts on one call were reported as matching — this is the ' +
      'exact reading KAN-627 would have needed and did not get');
  } else if (typeof r.warning !== 'string' || !/KAN-646/.test(r.warning)) {
    fail('1', `the divergence carries no warning naming the defect: ${JSON.stringify(r.warning)}`);
  } else if (!r.warning.includes('John Winstead') || !r.warning.includes('Wroos Bit')) {
    fail('1', 'the warning does not name BOTH accounts, so a reader cannot see which way ' +
      'round the divergence went');
  } else {
    pass('1', 'the divergence is reported with both account names and the ticket key');
  }
}

// ============================ 2. agreement is reported as agreement ========
//
// The control. A rule that fires on everything is not a detector, and §1 alone
// cannot tell "it caught the divergence" from "it warns whatever it is given".

console.log('\n[2] control: a stamp that agrees is NOT flagged');
{
  const r = await readBack(ok(MANAGER, MANAGER));
  console.log(`      creator=${r.creator?.displayName}  assignee=${r.assignee?.displayName}`);
  console.log(`      matchesCredential=${r.matchesCredential}  warning=${JSON.stringify(r.warning)}`);

  if (r.matchesCredential !== true) {
    fail('2', 'a ticket whose creator and assignee are the same account was reported as ' +
      'diverging — the check fires on everything and detects nothing');
  } else if (r.warning !== undefined) {
    fail('2', `an agreeing stamp carried a warning: ${r.warning}`);
  } else {
    pass('2', 'an agreeing stamp is reported as matching, with no warning');
  }
}

// ============================ 3. a failed read-back says so ================
//
// ⚠ THE KAN-649 SECTION. The failure that looks like success is this block
// being absent or reading clean when nobody actually looked.

console.log('\n[3] a read-back that FAILED says so — it does not read as agreement');
{
  const r = await readBack({ ok: false, error: 'Atlassian returned 503' });
  console.log(`      verified=${r.verified}  matchesCredential=${JSON.stringify(r.matchesCredential)}`);
  console.log(`      because=${JSON.stringify(r.because)?.slice(0, 80)}…`);

  if (r === undefined || r === null) {
    fail('3', 'a failed read-back returned nothing at all, so the create response would carry ' +
      'no `stamped` block — indistinguishable from an operation that does not stamp');
  } else if (r.verified !== false) {
    fail('3', `a failed read-back reported verified=${r.verified}`);
  } else if (r.matchesCredential !== undefined) {
    fail('3', `a failed read-back claimed matchesCredential=${r.matchesCredential}. It did not ` +
      'read anything, so it cannot have compared anything — this is the field that must be ' +
      'ABSENT rather than false, because false is a finding and nobody made one.');
  } else if (typeof r.because !== 'string' || !r.because.includes('503')) {
    fail('3', 'a failed read-back does not carry Atlassian\'s own reason');
  } else {
    pass('3', 'a failed read-back reports verified:false with the reason and NO comparison verdict');
  }
}

// ============================ 4. an empty assignee is still caught =========
//
// KAN-577's population, reaching the same surface. A create that somehow filed
// without an assignee must not report a clean stamp.

console.log('\n[4] a ticket that came back with NO assignee is flagged, not passed');
{
  const r = await readBack(ok(null, MANAGER));
  console.log(`      assignee=${JSON.stringify(r.assignee)}  matchesCredential=${r.matchesCredential}`);

  if (r.matchesCredential !== false) {
    fail('4', 'a ticket with no assignee at all was not flagged');
  } else if (typeof r.warning !== 'string' || !/never be staffed/.test(r.warning)) {
    fail('4', `the empty-assignee warning does not say what it costs: ${JSON.stringify(r.warning)}`);
  } else {
    pass('4', 'an empty assignee is reported with what it costs — the ticket can never be staffed');
  }
}

// ============================ 5. static: the wiring ========================
//
// Reads `router.ts` as TEXT, never through `dist`, so a failed build cannot
// make this verdict lie. Sections 1-4 prove what the method does; this is the
// only thing that says the method is reached at all.

console.log('\n[5] static: the read-back is gated on `needsSelfAccountId` and reaches the response');
{
  // ⚠ COMMENTS AND STRINGS ARE MASKED BEFORE EVERY ASSERTION BELOW. A docblock
  // naming a call is not the call: `verify-atlassian-proxy-write-scope.mjs`
  // went GREEN off prose for a call that had been deleted, 174 characters of
  // comment being enough to satisfy its window. `maskNonCode` is the shared
  // implementation of that rule — it blanks comments, strings and regex
  // literals while preserving every offset, so prose cannot vote and line
  // numbers still refer to the real file.
  const source = maskNonCode(readFileSync(path.join(srcDir, 'router.ts'), 'utf8'));

  const gated = /operation\.needsSelfAccountId\s*\n?\s*\?\s*await this\.stampReadBack\(/.test(source);
  const spread = /\.\.\.\(stamped \? \{ stamped \} : \{\}\)/.test(source);
  const declared = /private async stampReadBack\(/.test(source);

  if (!declared) {
    fail('5', '`stampReadBack` is not declared in router.ts');
  } else if (!gated) {
    fail('5', 'the read-back is not gated on `operation.needsSelfAccountId`. Gating on a tool ' +
      'NAME instead would mean an operation that later acquires the stamp acquires it ' +
      'silently, with no audit — which is the property that makes the audit necessary.');
  } else if (!spread) {
    fail('5', 'the `stamped` block is not spread into the success response, so the read-back ' +
      'is computed and thrown away');
  } else {
    pass('5', 'the read-back is gated on the stamping property and reaches the success response');
  }

  // The block must never be omitted for a stamp that could not be confirmed —
  // absence has exactly one meaning, and it is "this operation does not assign".
  const bad = /stamped\?\.verified\s*\?\s*\{ stamped \}/.test(source) ||
    /stamped && stamped\.verified \? \{ stamped \}/.test(source);
  if (bad) {
    fail('5', 'the `stamped` block is omitted when it could not be verified, which makes an ' +
      'unconfirmed stamp and a non-stamping operation the same bytes — KAN-649 exactly');
  } else {
    pass('5', 'no branch omits the block for an unverified stamp');
  }
}

// ------------------------------------------------------------- verdict --

console.log('');
reportAndExit({ failures, skipped: 0 });
