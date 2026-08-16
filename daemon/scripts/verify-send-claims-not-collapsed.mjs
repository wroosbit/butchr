#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: a composer `send_to_agent` response that
 * derives "a live session exists for this recipient" (C2) from the DELIVERY
 * verdict — so a steer that was typed onto a live pane and then had its submit
 * withheld comes back asserting the recipient has no session, and a caller
 * reading it concludes the agent is gone. That is KAN-498, measured against
 * `epic/KAN-39`: a 12-line message was typed onto its pane, collapsed by the
 * client into `[Pasted text #1 +12 lines]`, failed CrabCast's echo-check, and
 * the daemon reported `C1: false, C2: false` and *"Nothing was changed on the
 * pane"* about a pane it had just typed into and cleared.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE TWO ARMS, AND WHY A ONE-ARM VERSION OF THIS PROVES NOTHING
 * ---------------------------------------------------------------------------
 *
 * The delivered case ALREADY behaved correctly before this fix — `success:
 * true` made C2 `true`, which was the right answer for the wrong reason. So a
 * script that only exercised a successful send goes green against a completely
 * broken build. Every section here runs both arms, and they differ in ONE
 * field of the runtime's reply:
 *
 *   ARM DELIVERED : interrupts: 1, submits: 1, delivered: true
 *   ARM WITHHELD  : interrupts: 1, submits: 0, delivered: false
 *
 * ⚠ **The withheld arm is the whole proof.** Its assertions are `C2: true` and
 * `interrupted: true` on a send whose `success` is `false` — which is exactly
 * the combination the old code could not produce, because both were spelled
 * `result.success === true`.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WAS MADE TO GO RED — three ways, all reproducible
 * ---------------------------------------------------------------------------
 *
 * **1. Against the pre-fix build.** Check out the merge base, build, and run
 * this script; §2's withheld arm fails on `C2` and on `interrupted`. This is
 * the honest red and the reviewer can reproduce it:
 *
 *     git stash && (cd daemon && npm run build) &&
 *       node daemon/scripts/verify-send-claims-not-collapsed.mjs ; git stash pop
 *
 * **2. By the compiler, which is the stronger half.** The fix is a type, not an
 * assertion, so putting the defect back does not compile. Measured:
 *
 *     pane: result.success === true
 *       -> error TS2322: Type 'boolean' is not assignable to type 'PaneObservation'.
 *     sealComposerClaims({ pane, sessionPresent: result.success === true, ... })
 *       -> error TS2353: 'sessionPresent' does not exist in type '{ pane: PaneObservation; ... }'.
 *     a runtime returning { success: true } with no pane
 *       -> error TS2353: 'paneREMOVED' does not exist in type 'SendToAgentResult'.
 *
 * ⚠ **The first draft of the fix FAILED this drive and was rewritten because of
 * it.** It exported a `claimSessionPresent` helper and asked `router.ts` to
 * call it, which left `sealClaims`'s `Record<ClaimName, Observation>` still
 * accepting `sessionPresent: result.success === true` — so the defect went
 * straight back in and compiled clean. A helper that is *available* is not a
 * helper that is *required*, and in a diff the two look identical.
 * `sealComposerClaims` has no parameter for C2 at all, which is what made the
 * mutation red.
 *
 * **3. Mutate this script's own inputs.** Change the withheld arm's `submits`
 * to `1` and §2's C3 assertion fails, showing the assertion reads the reply
 * rather than a constant.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
 * ---------------------------------------------------------------------------
 *
 * ⚠ **It supplies the runtime's reply**, so it is the KAN-145 shape and says so:
 * a proof that supplies its own input has not tested that the input arrives.
 * Precisely:
 *
 *   - **That the claim block is built correctly FROM a reply** — covered here,
 *     by the real `MessageRouter.handleSendToAgent` and the real
 *     `sealComposerClaims`. Only the reply is injected.
 *   - **That CrabCast actually SENDS `interrupts`/`submits` on the failing
 *     path** — NOT COVERED HERE, and it is the load-bearing assumption. It is
 *     covered by `probe-composer-paste-collapse.mjs --stage-b`, which drives a
 *     throwaway CrabCast agent and prints the wire reply verbatim, and by the
 *     reply recorded in `verify-crabcast-second-activation-resumes.mjs`
 *     (`interrupts: 1, submits: 0`). ⚠ If CrabCast renames or drops those
 *     counters, §3 here still passes and the fleet silently degrades to
 *     `not-measured` — which is honest but is a loss of signal that NOTHING
 *     currently alarms on. Recorded as uncovered rather than implied to be
 *     handled.
 *   - **That the client collapses a paste at all** — not this script's
 *     question; `probe-composer-paste-collapse.mjs` Stages A/C/D measure it.
 *
 *
 * ⚠ IT IMPORTS FROM `../dist`, so a failed build makes its verdict evidence
 * about the PREVIOUS build. Confirm `npm run build` exited 0 — unpiped — before
 * reading anything below.
 *
 *   cd daemon && npm run build
 *   node daemon/scripts/verify-send-claims-not-collapsed.mjs [--verbose]
 *
 * EXIT 0 every assertion held, 1 an assertion failed.
 */

// CI-RUNNABLE: yes — it imports the built daemon modules and drives the real
// MessageRouter in-process. No terminal, no socket, no network, no `claude`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const verbose = process.argv.includes('--verbose');

// ⚠ §1 AND §3 IMPORT SYMBOLS THAT ONLY EXIST AFTER THE FIX, AND §2 MUST NOT.
//
// The point of §2 is to run against BOTH builds — that is the whole red drive.
// A first cut imported `paneObservationFrom` at the top and used it to build
// §2's stub reply, so against the pre-fix build the script died at line 1 of §1
// with `paneObservationFrom is not a function` and exited 1 — a red that
// credits the wrong mechanism, exactly what `prompts/task.md` warns of. The
// import is soft, the sections that need it say so, and §2 builds its pane
// observations as LITERALS so it depends on nothing this branch added.
const { sealComposerClaims } = await import('../dist/message-claims.js').catch(() => ({}));
const { paneObservationFrom } = await import('../dist/crabcast-runtime.js').catch(() => ({}));
const { MessageRouter } = await import('../dist/router.js');
const { WorkspaceRegistry } = await import('../dist/registry.js');
const { PromptLoader } = await import('../dist/prompt.js');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}
function row(k, v) {
  console.log(`   ${String(k).padEnd(44)} ${v}`);
}
function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`       ${detail}`);
  }
}

// ── the two arms, differing in ONE field ────────────────────────────────────
//
// Shaped as CrabCast's `send_to_agent` reply is shaped on the wire. The
// withheld arm's `error` is CrabCast's own wording, quoted verbatim from
// KAN-498 — including the two sentences that are false in this state, because
// §2 asserts Butchr stops repeating them.
const CRABCAST_WITHHELD_ERROR =
  "NOT DELIVERED to 'crabcast-kan-39-77f2646e7d2a1b9e': the message was typed and did not " +
  'appear anywhere on the pane within 2000ms, so THE SUBMIT WAS WITHHELD — Enter was not ' +
  'pressed (submits: 0). A pane that swallowed the text will not submit it for an Enter ' +
  'either, and an Enter it cannot submit still confirms whatever that pane has highlighted, ' +
  'which at a Claude Code dialog is a consent answer nobody gave. Nothing was changed on the ' +
  'pane. Sending again is safe and does the same thing.';

const ARM_DELIVERED = {
  name: 'DELIVERED',
  reply: { success: true, delivered: true, verdict: 'delivered', interrupts: 1, submits: 1, inComposer: false },
  // The literal §2 injects — see the note at the injection point.
  pane: { reached: 'typed', interrupted: true, submitted: true, detail: '1 interrupt, 1 submit' }
};
const ARM_WITHHELD = {
  name: 'WITHHELD',
  reply: {
    success: true,
    delivered: false,
    verdict: 'not-delivered',
    interrupts: 1,
    submits: 0,
    inComposer: false,
    error: CRABCAST_WITHHELD_ERROR
  },
  pane: { reached: 'typed', interrupted: true, submitted: false, detail: '1 interrupt, 0 submits' }
};

// ═══════════════════════════════════════════════════════════════════════════
rule('1. the wire reader — CrabCast\'s counters become a pane observation');
// ═══════════════════════════════════════════════════════════════════════════

if (typeof paneObservationFrom !== 'function') {
  console.log(
    '   SKIPPED — this build carries no `paneObservationFrom`, so it predates the fix.\n' +
      '   ⚠ This is NOT a pass. Section 2 below is the one that runs on both builds and is\n' +
      '   where the red drive lives.'
  );
}

const paneDelivered =
  typeof paneObservationFrom === 'function' ? paneObservationFrom(ARM_DELIVERED.reply, '/tmp/x', 'crabcast') : null;
const paneWithheld =
  typeof paneObservationFrom === 'function' ? paneObservationFrom(ARM_WITHHELD.reply, '/tmp/x', 'crabcast') : null;

if (paneWithheld) {

row('DELIVERED -> reached', paneDelivered.reached);
row('DELIVERED -> submitted', String(paneDelivered.submitted));
row('WITHHELD  -> reached', paneWithheld.reached);
row('WITHHELD  -> interrupted', String(paneWithheld.interrupted));
row('WITHHELD  -> submitted', String(paneWithheld.submitted));

check(
  'a withheld submit still reports the pane as REACHED — one interrupt landed on it',
  paneWithheld.reached === 'typed',
  `reached was ${paneWithheld.reached}; a pane that was interrupted is a pane that exists`
);
check(
  'and reports the composer as interrupted, which is the part with a cost',
  paneWithheld.interrupted === true
);
check(
  'and reports the submit as NOT taken — a measurement, not silence',
  paneWithheld.submitted === false
);
check('the delivered arm reports a submit', paneDelivered.submitted === true);

// ⚠ ABSENCE IS SILENCE. If CrabCast stops sending the counters, this must
// degrade to `not-measured` and never to a `false` — a `false` here is the
// KAN-498 defect arriving through the back door.
const paneNoCounters = paneObservationFrom({ success: true, delivered: false, verdict: 'x' }, '/tmp/x', 'crabcast');
row('no counters at all -> reached', paneNoCounters.reached);
check(
  'a reply carrying NO counters degrades to `not-measured`, never to `no`',
  paneNoCounters.reached === 'not-measured',
  'a missing field must not be readable as "the agent is gone"'
);

// ⚠ THE SHAPE OF A WITHHELD REPLY IS NOT SETTLED, AND THE FIX MUST NOT DEPEND
// ON WHICH ONE ARRIVES.
//
// Two shapes are consistent with the evidence: `success: true, delivered:
// false` (recorded in `verify-crabcast-second-activation-resumes.mjs`) and
// `success: false` with the refusal prose in `error` (which is how KAN-498's
// agent saw that prose, since the old code surfaced `res.error` only on that
// branch). Reading the counters on one branch only would fix the defect under
// one shape and leave it live under the other — so both are asserted here.
const paneSuccessFalse = paneObservationFrom(
  { success: false, error: CRABCAST_WITHHELD_ERROR, interrupts: 1, submits: 0 },
  '/tmp/x',
  'crabcast'
);
row('success:false shape -> reached', paneSuccessFalse.reached);
row('success:false shape -> submitted', String(paneSuccessFalse.submitted));
check(
  '⚠ a withheld reply shaped `success: false` reads the SAME as `delivered: false` — the fix ' +
    'does not depend on which shape CrabCast uses',
  paneSuccessFalse.reached === 'typed' &&
    paneSuccessFalse.interrupted === true &&
    paneSuccessFalse.submitted === false,
  `got ${JSON.stringify(paneSuccessFalse)}`
);
}

// ═══════════════════════════════════════════════════════════════════════════
rule('2. the real router response — both arms, through handleSendToAgent');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan498-verify-'));

/** A stub runtime whose ONLY job is to hand the router one chosen reply. */
function runtimeFor(arm) {
  const session = {
    sessionId: 'stub', type: 'epic', key: 'KAN-39', createdAt: new Date(),
    status: 'active', workDir: TMP, ptyBuffer: '', onDataListeners: []
  };
  return {
    runtimeName: 'crabcast',
    channelReach: 'not-loaded',
    resolveAddress: (key, type) => ({ type: type ?? 'epic', key }),
    herdrReachable: () => true,
    listHerdrAgentsChecked: () => ({ ok: true, agents: [] }),
    listHerdrAgents: () => [],
    listHerdrStatuses: () => new Map(),
    listActiveSessions: () => [session],
    getSessionByAddress: () => session,
    resolveSessionByAddress: () => ({ outcome: 'one', session }),
    confirmAgentPresent: async () => ({ present: true, waitedMs: 0, checks: 1 }),
    abandonSession: () => {},
    terminateSession: () => ({ success: true }),
    closeAgentByKey: () => ({ success: true }),
    tailAgent: async () => ({ success: true, text: '' }),
    // THE INJECTION POINT, AND THE ONLY ONE. The claim block, the error text,
    // `interrupted` and `composerLeftHolding` downstream of this are all
    // product code.
    //
    // ⚠ The pane observation is a LITERAL here rather than built by
    // `paneObservationFrom`, so this section runs unchanged against the pre-fix
    // build — which is what makes the red drive possible. §1 is what covers the
    // real wire reader.
    sendToAgent: async () => ({
      success: arm.reply.delivered === true,
      error: arm.reply.delivered === true ? undefined : `CrabCast verdict: ${arm.reply.verdict}`,
      pane: arm.pane
    }),
    spawnSession: () => session
  };
}

async function respondFor(arm) {
  const registry = new WorkspaceRegistry(path.join(TMP, `reg-${arm.name}.json`));
  let captured = null;
  let settle;
  const waited = new Promise((resolve) => {
    settle = resolve;
  });
  // Responses leave through the router's own `send`, so that is where they are
  // caught — the same seam `daemon.ts` uses.
  const router = new MessageRouter(
    registry,
    new PromptLoader(repoRoot),
    runtimeFor(arm),
    (msg) => {
      if (msg?.action === 'send_to_agent_response') {
        captured = msg;
        settle();
      }
    },
    () => {}
  );
  router.handle({
    action: 'send_to_agent',
    key: 'KAN-39',
    type: 'epic',
    message: 'line one\nline two\nline three',
    intent: 'stop-now'
  });
  await Promise.race([waited, new Promise((r) => setTimeout(r, 10_000))]);
  return captured;
}

const outDelivered = await respondFor(ARM_DELIVERED);
const outWithheld = await respondFor(ARM_WITHHELD);

const claim = (out, name) => out?.claims?.[name]?.value;

console.log('\n   claim                    DELIVERED        WITHHELD');
for (const name of ['transportAccepted', 'sessionPresent', 'enteredTranscript', 'modelRead']) {
  console.log(
    `   ${name.padEnd(24)} ${String(claim(outDelivered, name)).padEnd(16)} ${String(claim(outWithheld, name))}`
  );
}
row('success        (delivered / withheld)', `${outDelivered?.success} / ${outWithheld?.success}`);
row('interrupted    (delivered / withheld)', `${outDelivered?.interrupted} / ${outWithheld?.interrupted}`);

if (verbose) {
  console.log(`\n   WITHHELD error:\n     ${String(outWithheld?.error).replace(/\n/g, '\n     ')}`);
}

// ── the arm that carries the proof ──────────────────────────────────────────
check(
  '⚠ WITHHELD: C2 sessionPresent is TRUE even though the send was NOT delivered',
  claim(outWithheld, 'sessionPresent') === true && outWithheld?.success === false,
  `C2 was ${claim(outWithheld, 'sessionPresent')} with success ${outWithheld?.success}. ` +
    'This is the KAN-498 defect: C2 derived from the delivery verdict.'
);
check(
  'WITHHELD: C1 transportAccepted is TRUE — the bytes are on the pane',
  claim(outWithheld, 'transportAccepted') === true
);
check(
  'WITHHELD: C3 enteredTranscript is FALSE — measured, not null',
  claim(outWithheld, 'enteredTranscript') === false,
  'a withheld Enter is a MEASUREMENT that the text did not enter the transcript'
);
check(
  '⚠ WITHHELD: interrupted is TRUE — the Ctrl+C landed and cleared their composer',
  outWithheld?.interrupted === true,
  'reporting `interrupted: false` here tells the sender it took nothing from the recipient at ' +
    'the moment it destroyed both their turn and their composer contents'
);

// ── AC3: the false sentences are not repeated in Butchr's own voice ─────────
check(
  '⚠ AC3: Butchr\'s `error` does NOT repeat "Nothing was changed on the pane"',
  typeof outWithheld?.error === 'string' && !/Nothing was changed on the pane/i.test(outWithheld.error),
  `error was: ${String(outWithheld?.error).slice(0, 200)}`
);
check(
  'AC3: nor "Sending again is safe", which is false here — a second send APPENDS',
  typeof outWithheld?.error === 'string' && !/Sending again is safe/i.test(outWithheld.error),
  `error was: ${String(outWithheld?.error).slice(0, 200)}`
);
check(
  'AC3: it says the message was typed onto the pane and not submitted',
  typeof outWithheld?.error === 'string' &&
    /typed onto the pane/i.test(outWithheld.error) &&
    /NOT SUBMITTED/i.test(outWithheld.error)
);
check(
  'AC3: and says the previous composer content was cleared — the part with a cost',
  typeof outWithheld?.error === 'string' && /cleared whatever their composer held/i.test(outWithheld.error)
);
check(
  'the runtime\'s own wording is kept verbatim as evidence rather than dropped',
  outWithheld?.runtimeError !== undefined,
  'their sentence is theirs to fix (defect A) and must remain readable'
);
check(
  'a caller is told what to do about the text left on the composer',
  outWithheld?.composerLeftHolding?.priorContentCleared === true &&
    /APPENDS/i.test(String(outWithheld?.composerLeftHolding?.advice)),
  JSON.stringify(outWithheld?.composerLeftHolding ?? null).slice(0, 200)
);

// ── the control arm: the delivered case must stay correct ───────────────────
check(
  'CONTROL: the DELIVERED arm still reports C2 true, C3 true and success true',
  claim(outDelivered, 'sessionPresent') === true &&
    claim(outDelivered, 'enteredTranscript') === true &&
    outDelivered?.success === true,
  'the fix must not be bought by breaking the case that already worked'
);
check(
  'CONTROL: the DELIVERED arm carries no composerLeftHolding — nothing is stranded',
  outDelivered?.composerLeftHolding === undefined
);
check(
  '⚠ THE TWO ARMS DISAGREE ON C3 AND AGREE ON C2 — which is only possible once the two ' +
    'are read from different facts',
  claim(outDelivered, 'enteredTranscript') !== claim(outWithheld, 'enteredTranscript') &&
    claim(outDelivered, 'sessionPresent') === claim(outWithheld, 'sessionPresent'),
  'under the old derivation both claims tracked `success`, so the arms could never differ on ' +
    'one while agreeing on the other'
);

// ═══════════════════════════════════════════════════════════════════════════
rule('3. the seal — C2 and C3 cannot be named by a caller at all');
// ═══════════════════════════════════════════════════════════════════════════

// The composer's claim block is built from a PaneObservation and nothing else.
// This is the runtime half of the compile-time guarantee; the compiler half is
// in the header ("HOW IT WAS MADE TO GO RED", mutations 1 and 2).
if (typeof sealComposerClaims !== 'function') {
  console.log('   SKIPPED — this build has no `sealComposerClaims`, so it predates the fix.');
} else {
for (const [label, pane, expectC2, expectC3] of [
  ['typed + submitted', { reached: 'typed', interrupted: true, submitted: true, detail: 'd' }, true, true],
  ['typed + withheld', { reached: 'typed', interrupted: true, submitted: false, detail: 'd' }, true, false],
  ['typed + unknown', { reached: 'typed', interrupted: true, submitted: 'not-measured', detail: 'd' }, true, null],
  ['no pane', { reached: 'no', detail: 'd' }, false, null],
  ['not measured', { reached: 'not-measured', detail: 'd' }, null, null]
]) {
  const block = sealComposerClaims({
    pane,
    transportAccepted: 'not-measured',
    transportAcceptedBasis: 'b'
  });
  const c2 = block.sessionPresent.value;
  const c3 = block.enteredTranscript.value;
  row(label, `C2=${c2}  C3=${c3}`);
  check(
    `  ${label}: C2=${expectC2}, C3=${expectC3}`,
    c2 === expectC2 && c3 === expectC3,
    `got C2=${c2} C3=${c3}`
  );
}

check(
  '⚠ `no` and `not-measured` do NOT collapse: one is false, the other is null',
  sealComposerClaims({ pane: { reached: 'no', detail: 'd' }, transportAccepted: 'not-measured', transportAcceptedBasis: 'b' })
    .sessionPresent.value === false &&
    sealComposerClaims({ pane: { reached: 'not-measured', detail: 'd' }, transportAccepted: 'not-measured', transportAcceptedBasis: 'b' })
      .sessionPresent.value === null,
  'a caller that reads silence as a negative stops trying to reach an agent that is there'
);
}

// ═══════════════════════════════════════════════════════════════════════════
rule('VERDICT');
// ═══════════════════════════════════════════════════════════════════════════

console.log(
  failures === 0
    ? 'C2 is read from the pane and not from the delivery verdict; a withheld submit reports the\n' +
        'composer as changed and its previous contents as cleared.'
    : 'at least one claim is still being derived from the delivery verdict.'
);
console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
