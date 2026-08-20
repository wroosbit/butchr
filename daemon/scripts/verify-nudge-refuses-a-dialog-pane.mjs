// `waitForAgentReady` will not call a pane at a live startup dialog READY.
//
// WHAT FAILURE THIS WOULD CATCH: the daemon typing a nudge at a pane that is
// sitting at one of Claude Code's startup dialogs. `nudge.ts` kept its own
// readiness list — `['bypass permissions', 'for shortcuts', '❯']` — and every
// dialog in `startup-dialog.ts` paints that caret over its selected option, so
// readiness returned `true` for a box waiting on a keystroke. Two things follow,
// and this script asserts both. A composer send at a live dialog ANSWERS the
// dialog with whatever option is highlighted (`task/KAN-375` reproduced that
// terminating an agent on "No, exit"). And the truthful "never reached a prompt"
// branch was skipped, so a parked agent surfaced as `refused by crabcast-daemon:
// no answer to send_to_agent within 10000ms` — which KAN-538 recorded as reading
// like a socket or CrabCast fault. It was neither.
//
// CI-RUNNABLE: yes — imports the built daemon modules and drives the real
// `awaitAgentReadiness` and `nudgeResumedAgent` against a scripted runtime stub.
// No live daemon, no herdr, no terminal, no network, no credential, no Jira. It
// spends real monotonic time, deliberately and about a second of it: every call
// passes a `ReadinessBudget` shortening the 120s budget to tens of milliseconds.
// KAN-543 added that seam for this script, and it is why the parked branch is
// watchable at all. The CLOCK is not part of the seam — see §6, and see
// `ReadinessBudget`'s docblock for the invariant that decided it.
//
// ---------------------------------------------------------------------------
// THE PANES ARE MEASURED, AND THAT IS THE POINT OF SHARING THEM
// ---------------------------------------------------------------------------
//
// `lib/startup-dialog-fixtures.mjs` — the same raw PTY bytes
// `verify-startup-dialog-discrimination.mjs` matches against, lifted out by
// KAN-543 rather than retyped. Claude Code's TUI emits column-positioning
// escapes instead of spaces, so a dialog fixture written by hand from a
// screenshot contains spaces the terminal never sent and would agree with any
// matcher at all. Sharing them is what stops this proof grading its own homework.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER, SAID RATHER THAN LEFT TO BE INFERRED
// ---------------------------------------------------------------------------
//
// **This script supplies its own pane.** `tailAgent` is a stub returning the
// fixtures above, so nothing here tests that a real herdr pane read ARRIVES
// looking like a dialog. `prompts/task.md`: "a proof that supplies its own input
// has not tested that the input arrives." That gap is covered by observation
// rather than by a sibling script, and the observation is in the PR body —
// `epic/KAN-203` reports clearing `story/KAN-117` off a live development-channels
// dialog on 2026-08-20, a pane that `agent_status` was reporting as idle,
// "because the dialog draws a ❯". That is this defect in production and it is
// reported rather than measured here; it is not evidence this script produced.
//
// **Nothing here tests the keystroke's effect.** That a composer send at a live
// dialog selects the highlighted option is `task/KAN-375`'s reproduction, cited
// as the reason refusing matters. This script asserts only that the daemon
// declines to send, which is the half it can own.
//
// **§4's positional limit is asserted as a KNOWN false negative, not fixed.**
// See that section: a pane whose answered dialog is still in the tail below its
// own prompt reads as parked. It is the safe direction, it is shared with
// `superviseChannelStartup`, and diverging here is what KAN-543 closed.

import {
  awaitAgentReadiness,
  waitForAgentReady,
  nudgeResumedAgent,
  describeReadiness
} from '../dist/nudge.js';
import { classifyStartupDialog } from '../dist/startup-dialog.js';
import {
  DEV_CHANNELS_PANE,
  WORKSPACE_TRUST_PANE,
  AT_PROMPT_PANE,
  NARROW_PROMPT_PANE
} from './lib/startup-dialog-fixtures.mjs';

let failures = 0;
const say = (m) => console.log(m);

function check(ok, what, evidence) {
  if (ok) {
    say(`  PASS  ${what}`);
  } else {
    failures += 1;
    say(`  FAIL  ${what}`);
    if (evidence !== undefined) say(`        evidence: ${JSON.stringify(evidence)}`);
  }
}

/**
 * A runtime whose pane says whatever the fixture says, and which RECORDS every
 * send rather than refusing them.
 *
 * Recording rather than refusing is deliberate and it is what makes §1 and §2
 * discriminating. A stub that threw on `sendToAgent` would go green for a fix
 * that still decided to type — the throw would be doing the refusing. Here the
 * send always succeeds, so the only thing that can keep `sent` empty is the
 * daemon choosing not to call it.
 */
function runtime(pane, { tailSucceeds = true, tailError, sendFails } = {}) {
  const sent = [];
  const tails = { count: 0 };
  return {
    sent,
    tails,
    bridge: {
      tailAgent: async () => {
        tails.count += 1;
        return tailSucceeds
          ? { success: true, text: pane }
          : { success: false, error: tailError };
      },
      sendToAgent: async (key, message, type) => {
        sent.push({ key, type, message });
        return sendFails ? { success: false, error: sendFails } : { success: true };
      },
      briefLocation: () => '/tmp/does-not-matter/prompt.md'
    }
  };
}

/**
 * What CrabCast answered KAN-538 with, verbatim from its log:
 *
 *     13:08:16Z [nudge] epic/KAN-59 restored its conversation; could NOT send the
 *               interrupted-work message: refused by crabcast-daemon: no answer to
 *               `send_to_agent` within 10000ms
 *
 * A client with no prompt does not answer, so the send times out and the refusal
 * comes back wearing a socket fault's clothes. §2 wires this into the stub so
 * that the misleading line is REACHABLE — without it, "the send-failed branch
 * never runs" is green whatever the daemon does, because a stub that always
 * succeeds cannot produce the branch it claims to be ruling out. That is a check
 * that does not exist while appearing to.
 */
const CRABCAST_TIMEOUT =
  'refused by crabcast-daemon: no answer to `send_to_agent` within 10000ms';

/**
 * The 120-second budget, shortened — and STILL A REAL WAIT ON THE REAL CLOCK.
 *
 * Only the two durations are settable; `ReadinessBudget` deliberately does not
 * take a clock, because an injectable clock is an injectable WALL clock and that
 * is the KAN-21 suspend defect. So a parked case here genuinely sleeps its way to
 * a genuine monotonic deadline — it just does it in 30ms instead of two minutes.
 * §6 measures the elapsed time to say so rather than asking to be believed.
 */
const SHORT_BUDGET = { timeoutMs: 30, pollMs: 10 };

/** §6's budget: long enough that "it waited the whole thing" is measurable. */
const TIMED_BUDGET = { timeoutMs: 120, pollMs: 20 };

/** Drive the real `nudgeResumedAgent` over that runtime. */
async function nudgeOver(bridge) {
  const logs = [];
  const result = await nudgeResumedAgent({
    herdrBridge: bridge,
    type: 'task',
    key: 'KAN-543',
    cause: 'restart',
    defaultAgent: 'claude',
    readiness: SHORT_BUDGET,
    log: (...args) => logs.push(args.join(' '))
  });
  return { result, logs };
}

say('');
say('=== 0. The premise: the dialogs paint the caret the old list matched on ===');
say('    If this section is red the rest of the script proves nothing, because');
say('    the fixtures would no longer contain the thing that caused the defect.');
{
  check(
    DEV_CHANNELS_PANE.includes('❯'),
    'the development-channels capture contains a caret',
    DEV_CHANNELS_PANE.split('\n').find((l) => l.includes('❯'))
  );
  check(
    WORKSPACE_TRUST_PANE.includes('❯'),
    'the workspace-trust capture contains a caret',
    WORKSPACE_TRUST_PANE.split('\n').find((l) => l.includes('❯'))
  );
  check(
    !DEV_CHANNELS_PANE.includes('for shortcuts') &&
      !/[Bb]ypass(?:ing)? [Pp]ermissions/.test(DEV_CHANNELS_PANE),
    'and it carries NO session footer — so the caret was the whole of what matched'
  );
  check(
    classifyStartupDialog(DEV_CHANNELS_PANE).kind === 'dev-channels' &&
      classifyStartupDialog(WORKSPACE_TRUST_PANE).kind === 'foreign',
    'both classify as a live dialog, which is what readiness must now consult'
  );
}

say('');
say('=== 1. A pane at a LIVE dialog is not ready, and nothing is typed at it ===');
for (const [name, pane] of [
  ['development-channels', DEV_CHANNELS_PANE],
  ['workspace-trust', WORKSPACE_TRUST_PANE]
]) {
  say(`  --- ${name} ---`);
  const { sent, bridge } = runtime(pane);
  const readiness = await awaitAgentReadiness(bridge, 'KAN-543', 'task', SHORT_BUDGET);
  check(readiness.kind === 'parked-at-dialog', 'readiness says parked-at-dialog', readiness);
  check(
    (await waitForAgentReady(bridge, 'KAN-543', 'task', SHORT_BUDGET)) === false,
    'and the boolean the older callers read is FALSE'
  );
  check(
    readiness.kind === 'parked-at-dialog' && readiness.dialog.includes(
      name === 'workspace-trust' ? 'workspace-trust' : 'development-channels'
    ),
    'the verdict names WHICH dialog, so an operator is sent to the right screen',
    readiness.dialog
  );

  const { result, logs } = await nudgeOver(bridge);
  check(sent.length === 0, 'NOTHING was sent — the composer never reached the dialog', sent);
  check(result.nudged === false, 'and the nudge reports itself as not delivered', result);
}

say('');
say('=== 2. The truthful branch fires, instead of a timeout wearing a fault ===');
say('    KAN-538 saw `refused by crabcast-daemon: no answer to send_to_agent`');
say('    for a parked pane. That is the send failing, and the send only ran');
say('    because readiness lied first. The log must now say what is true.');
{
  // THE STUB REFUSES THE SEND THE WAY CRABCAST DID. So this section has a red
  // branch the world can reach: if the daemon decides to type at the parked
  // pane, the send fails and KAN-538's exact line appears in the log. It is
  // absent below because nothing was sent, not because nothing could fail.
  const { sent, bridge } = runtime(DEV_CHANNELS_PANE, { sendFails: CRABCAST_TIMEOUT });
  const { result, logs } = await nudgeOver(bridge);
  const line = logs.find((l) => l.includes('[nudge]'));
  check(sent.length === 0, 'the send was never attempted, so it could not fail', sent.length);
  check(line !== undefined, 'the nudge logged something at all', logs);
  check(
    Boolean(line && line.includes('never reached a prompt')),
    'it is the "never reached a prompt" branch',
    line
  );
  check(
    Boolean(line && line.includes('development-channels dialog')),
    'and it names the dialog rather than shrugging',
    line
  );
  check(
    Boolean(line && line.includes('ANSWER the dialog')),
    'and says why typing would be worse than useless',
    line
  );
  check(
    !logs.some((l) => l.includes('could NOT send')),
    'the send-failed branch — the one that reads as a socket fault — never runs',
    logs
  );
  check(
    !logs.some((l) => l.includes('crabcast-daemon')),
    "and KAN-538's line does not appear, though the stub is armed to produce it",
    logs
  );
  check(
    typeof result.error === 'string' && result.error.includes('parked at'),
    'the returned error says parked, not "did not reach a prompt in time"',
    result.error
  );
}

say('');
say('=== 3. A HEALTHY pane is still ready, including a narrow one (the AC1 column) ===');
say('    The caret is KEPT. A fix that refuses dialogs and also refuses these has');
say('    broken the thing readiness exists to permit.');
for (const [name, pane] of [
  ['a session at its prompt (footer)', AT_PROMPT_PANE],
  ['a NARROW pane: caret only, footer wrapped off the read', NARROW_PROMPT_PANE]
]) {
  const { sent, bridge } = runtime(pane);
  const readiness = await awaitAgentReadiness(bridge, 'KAN-543', 'task', SHORT_BUDGET);
  check(readiness.kind === 'ready', `${name} → ready`, readiness);
  const { result } = await nudgeOver(bridge);
  check(sent.length === 1, `${name} → the nudge WAS sent`, sent.length);
  check(result.nudged === true, `${name} → and reports delivered`, result);
}
{
  // The discriminating half of the narrow case: it is ready BECAUSE of the caret
  // and nothing else. Without this, a fix that quietly dropped the caret would
  // pass §3 on the footer pane alone and lose the case the caret exists for.
  check(
    !NARROW_PROMPT_PANE.includes('for shortcuts') &&
      !/[Bb]ypass(?:ing)? [Pp]ermissions/.test(NARROW_PROMPT_PANE),
    'the narrow pane has NO footer, so only the caret can have made it ready',
    NARROW_PROMPT_PANE
  );
}

say('');
say('=== 4. The two states that are not dialogs and not prompts ===');
{
  const { sent, bridge } = runtime('starting claude...\n');
  const readiness = await awaitAgentReadiness(bridge, 'KAN-543', 'task', SHORT_BUDGET);
  check(readiness.kind === 'no-prompt', 'a booting shell → no-prompt', readiness);
  await nudgeOver(bridge);
  check(sent.length === 0, 'and nothing was typed at it', sent);

  const unreadable = runtime(null, { tailSucceeds: false, tailError: 'pane is gone' });
  const r2 = await awaitAgentReadiness(unreadable.bridge, 'KAN-543', 'task', SHORT_BUDGET);
  check(r2.kind === 'unreadable', 'a pane that cannot be read → unreadable', r2);
  check(
    describeReadiness(r2).includes('pane is gone'),
    'and it carries the reason, which is a herdr problem and not an agent one',
    describeReadiness(r2)
  );
  await nudgeOver(unreadable.bridge);
  check(unreadable.sent.length === 0, 'and nothing was typed at it either', unreadable.sent);
}

say('');
say('=== 4b. THE KNOWN FALSE NEGATIVE, asserted so it is known rather than found ===');
say('    An ANSWERED dialog still in the tail below its own prompt reads as parked.');
say('    This is the safe direction and it is shared with superviseChannelStartup,');
say('    which has had it since KAN-340 and reaches `ready` in production every day.');
say('    Asserted rather than fixed: making nudge.ts smarter than channel-startup.ts');
say('    would re-open the two-definitions divergence KAN-543 exists to close.');
{
  const stale = DEV_CHANNELS_PANE + '\n' + AT_PROMPT_PANE;
  const { bridge } = runtime(stale);
  const readiness = await awaitAgentReadiness(bridge, 'KAN-543', 'task', SHORT_BUDGET);
  check(
    readiness.kind === 'parked-at-dialog',
    'documented limit holds: stale dialog scrollback still reads as parked',
    readiness
  );
  check(
    classifyStartupDialog(stale).kind === 'dev-channels',
    'and it is `classifyStartupDialog` that says so — the limit is in the shared ' +
      'module, so a future fix fixes BOTH callers or neither'
  );
}

say('');
say('=== 5. The reconciliation: one module owns both definitions (AC4) ===');
say('    Not "the two files agree now" — they still differ, deliberately. The');
say('    property is that the difference is in ONE file, reachable only behind a');
say('    classification, so a reader meets both at once.');
{
  const dialogModule = await import('../dist/startup-dialog.js');
  check(
    typeof dialogModule.frameShowsLiveSession === 'function' &&
      typeof dialogModule.frameShowsInputLine === 'function',
    'startup-dialog.js exports both readiness definitions'
  );

  const channelModule = await import('../dist/channel-startup.js');
  check(
    channelModule.SESSION_PROMPT_PATTERN === undefined,
    'channel-startup.js no longer declares a readiness pattern of its own',
    Object.keys(channelModule).filter((k) => /PROMPT|READY/i.test(k))
  );

  // THE TYPE IS THE GATE, AND THIS IS ITS RUNTIME FACE. `frameShowsInputLine`
  // takes a value only a `none` verdict mints, so a raw pane string cannot be
  // asked. TypeScript refuses it at compile time — the mutation in §6's recipe
  // is what shows that — and at runtime the brand is simply absent, so the
  // dialog pane it would have wrongly accepted is not accepted here either.
  const healthy = classifyStartupDialog(AT_PROMPT_PANE);
  check(healthy.kind === 'none', 'a healthy pane yields a frame to test');
  check(
    healthy.kind === 'none' && dialogModule.frameShowsInputLine(healthy.frame) === true,
    'and the frame it yields IS at an input line'
  );
  const parked = classifyStartupDialog(DEV_CHANNELS_PANE);
  check(
    parked.kind !== 'none' && !('frame' in parked),
    'a dialog verdict carries NO frame — there is nothing to hand the prompt test',
    parked.kind
  );
}

say('');
say('=== 6. The parked branch WAITED the budget, on the monotonic clock ===');
say('    Without this the fast run is unexplained: a loop that returned on its');
say('    first read would report `parked` just as green, having waited for');
say('    nothing, and the deadline would be untested.');
say('    Elapsed time rather than a poll count, because the count is a function');
say('    of setTimeout jitter and would be flaky under CI load. Elapsed monotonic');
say('    time cannot go backwards, so `>= timeoutMs` is exact in one direction.');
{
  const parked = runtime(DEV_CHANNELS_PANE);
  const t0 = performance.now();
  const readiness = await awaitAgentReadiness(
    parked.bridge, 'KAN-543', 'task', TIMED_BUDGET
  );
  const elapsed = performance.now() - t0;
  check(readiness.kind === 'parked-at-dialog', 'still parked when the budget ran out', readiness);
  check(
    elapsed >= TIMED_BUDGET.timeoutMs,
    `it waited the whole ${TIMED_BUDGET.timeoutMs}ms budget before giving up`,
    Math.round(elapsed)
  );
  check(
    parked.tails.count >= 2,
    'and it re-read the pane rather than deciding on one frame',
    parked.tails.count
  );

  const healthy = runtime(AT_PROMPT_PANE);
  const t1 = performance.now();
  const r2 = await awaitAgentReadiness(
    healthy.bridge, 'KAN-543', 'task', TIMED_BUDGET
  );
  const quick = performance.now() - t1;
  check(r2.kind === 'ready', 'and a healthy pane returns on the FIRST pass', r2);
  check(
    healthy.tails.count === 1,
    'polling it exactly once — readiness does not wait out a budget it has met',
    healthy.tails.count
  );
  check(
    quick < TIMED_BUDGET.timeoutMs,
    'and returning well inside the budget, which is the discriminating half: a ' +
      'check that waited either way would pass on a daemon that never returns early',
    Math.round(quick)
  );
}

say('');
say('=== 7. How to drive this red ===');
say('    In daemon/src/nudge.ts, restore the caret-matches-dialog behaviour by');
say('    replacing the body of `awaitAgentReadiness`\'s classification with the');
say('    old marker test on the raw tail text:');
say('');
say('        const text = tail.text.toLowerCase();');
say("        last = ['bypass permissions', 'for shortcuts', '\\u276f']");
say('          .some((m) => text.includes(m.toLowerCase()))');
say("          ? { kind: 'ready' } : { kind: 'no-prompt' };");
say('');
say('    That compiles — it never touches `frameShowsInputLine`, so the type gate');
say('    is bypassed rather than violated, which is the mutation this needs.');
say('    ⚠ `npm run build` must exit 0 AND `dist` must be newer than `src` before');
say('    the verdict below means anything: a proof run after a failed build ran on');
say('    the previous dist and is evidence about code you did not write.');
say('    Expected red: §1 and §2 (readiness ready, the nudge sent, the send-failed');
say('    branch back). §3 stays green, which is what says the mutation is a');
say('    regression and not a different feature.');

say('');
say(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
