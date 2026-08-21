// The auto-confirm's aim, driven against the SHIPPED loop with real dialogs.
//
// WHAT FAILURE THIS WOULD CATCH: the daemon pressing Enter at Claude Code's
// WORKSPACE-TRUST dialog — granting read, edit and execute in a directory nobody
// vetted — because that dialog and the development-channels one are answered by
// the same keystroke and present the identical affordance. The specific route is
// the one the pre-KAN-340 matcher took: it tested the whole 140-line pane read,
// so a frame carrying a dead `claude`'s dev-channels scrollback ABOVE a live
// trust dialog matched, and the watcher answered the trust dialog. Section 3 is
// that exact frame, and section 3b shows the old pattern still saying yes to it.
//
// CI-RUNNABLE: yes — imports the built daemon modules and drives the real
// `superviseChannelStartup` on a virtual clock. No live daemon, no herdr, no
// terminal, no credential.
//
// ---------------------------------------------------------------------------
// WHERE THE PANE TEXT COMES FROM, BECAUSE IT IS THE WHOLE VALUE OF THIS SCRIPT
// ---------------------------------------------------------------------------
//
// `lib/startup-dialog-fixtures.mjs`, and that file's header is where the
// provenance is written down: the two dialogs' raw PTY bytes on claude-code
// 2.1.228, captured at 100x30 and replayed by a `render()` that reproduces the
// column-positioning escapes a hand-typed fixture would get wrong.
//
// They were declared HERE until KAN-543 and were moved without being retyped.
// A second proof needed the same bytes — `verify-nudge-refuses-a-dialog-pane.mjs`,
// which drives the caret defect out of `nudge.ts` — and two scripts each
// hand-writing "what a dialog looks like" is two chances to write a fixture that
// agrees with any matcher at all.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT SUPPLIES ITS OWN PANE, AND HERE IS WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// The frames are constructed here, so nothing below tests that a real herdr pane
// read ARRIVES looking like this — `readPane` is stubbed. That gap is covered by
// observation rather than by a sibling script, and the observation is in the PR
// body: `~/.local/share/butchr/daemon.log` records `superviseChannelStartup`
// answering two real dev-channels dialogs on every channel-enabled spawn
// (task/KAN-340, KAN-346, KAN-341, KAN-342, KAN-283 on 2026-08-12), which is the
// live proof that the production path reaches this matcher with text it matches.
// What no artifact covers is a real TRUST dialog reaching a real watcher: raising
// one requires an untrusted workspace, and `trustClaudeWorkspace` exists to make
// that unreachable on the spawn path. Said out loud rather than left to be
// inferred from two green scripts.

import {
  classifyStartupDialog,
  liveDialogRegion
} from '../dist/startup-dialog.js';
import {
  superviseChannelStartup,
  DEV_CHANNELS_DIALOG_PATTERN
} from '../dist/channel-startup.js';
// The measured captures, shared with verify-nudge-refuses-a-dialog-pane.mjs
// since KAN-543. See that module's header for their provenance.
import {
  DEV_CHANNELS_PANE,
  WORKSPACE_TRUST_PANE,
  AT_PROMPT_PANE
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


// ---------------------------------------------------------------------------
// Driving the SHIPPED loop. Scripted panes, virtual clock, recorded keystrokes.
// ---------------------------------------------------------------------------

/**
 * @param frames pane text per pass; the last is repeated once exhausted.
 * @param connectAfter presses after which a fresh connection appears (Infinity: never)
 */
async function drive(frames, { connectAfter = 0 } = {}) {
  let pass = 0;
  let clock = 1_000_000;
  const pressed = [];
  const logs = [];
  const result = await superviseChannelStartup({
    address: { type: 'task', key: 'KAN-340' },
    spawnedAt: clock,
    deadlineMs: 60_000,
    world: {
      readPane: async () => frames[Math.min(pass++, frames.length - 1)],
      pressEnter: (confirmation) => { pressed.push(confirmation); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      freshConnection: () => (pressed.length >= connectAfter ? { id: 'conn-test' } : null),
      log: (m) => logs.push(m)
    }
  });
  return { result, pressed, logs };
}

say('');
say('=== 0. The captures render to the dialogs they were taken from ===');
check(
  DEV_CHANNELS_PANE.includes('WARNING: Loading development channels'),
  'dev-channels capture renders the spaced title (the raw bytes have no spaces in it)',
  DEV_CHANNELS_PANE.split('\n')[2]
);
check(
  WORKSPACE_TRUST_PANE.includes('Yes, I trust this folder'),
  'trust capture renders its confirm option',
  WORKSPACE_TRUST_PANE.split('\n').find((l) => l.includes('trust this'))
);
check(
  DEV_CHANNELS_PANE.includes('Enter to confirm') &&
    WORKSPACE_TRUST_PANE.includes('Enter to confirm'),
  'BOTH dialogs offer the identical Enter affordance — the premise of this script'
);

say('');
say('=== 1. The development-channels dialog IS answered ===');
{
  const v = classifyStartupDialog(DEV_CHANNELS_PANE);
  check(v.kind === 'dev-channels', 'classified dev-channels', v.kind);
  const { result, pressed } = await drive([DEV_CHANNELS_PANE, AT_PROMPT_PANE]);
  check(pressed.length === 1, 'the loop pressed Enter exactly once', pressed.length);
  check(result.outcome === 'ready', 'and the agent reached ready', result.outcome);
  check(
    pressed[0] && typeof pressed[0].evidence === 'string' && pressed[0].evidence.length > 0,
    'the keystroke carried the prose that earned it',
    pressed[0]?.evidence
  );
}

say('');
say('=== 2. The workspace-trust dialog is NOT answered ===');
{
  const v = classifyStartupDialog(WORKSPACE_TRUST_PANE);
  check(v.kind === 'foreign', 'classified foreign', v.kind);
  check(v.kind === 'foreign' && v.dialog === 'workspace-trust', 'named as workspace-trust', v);
  const { result, pressed, logs } = await drive([WORKSPACE_TRUST_PANE]);
  check(pressed.length === 0, 'NOTHING was pressed', pressed.length);
  check(result.outcome === 'foreign-dialog', 'outcome names the refusal', result.outcome);
  check(
    logs.some((l) => l.includes('REFUSING TO ANSWER')),
    'and the refusal is in the log, not silent',
    logs
  );
}

say('');
say('=== 3. THE REGRESSION: stale dev-channels scrollback above a LIVE trust dialog ===');
say('    This is the frame the pre-KAN-340 whole-pane matcher answered. The launcher');
say('    runs claude twice via `||`, so the first one\'s dialog can still be in the');
say('    140-line window when the second paints something else over it.');
{
  const frame =
    DEV_CHANNELS_PANE + '\nNo conversation found to continue\n' + WORKSPACE_TRUST_PANE;
  const v = classifyStartupDialog(frame);
  check(v.kind === 'foreign', 'the LIVE dialog decides: foreign', v.kind);
  const region = liveDialogRegion(frame);
  check(
    region !== null && !region.includes('Loading development channels'),
    'the classified region excludes the stale dev-channels text entirely'
  );
  const { result, pressed } = await drive([frame]);
  check(pressed.length === 0, 'NOTHING was pressed — the trust dialog survives', pressed.length);
  check(result.outcome === 'foreign-dialog', 'outcome names the refusal', result.outcome);

  say('');
  say('  --- 3b. and the old matcher would have said yes to this same frame ---');
  check(
    DEV_CHANNELS_DIALOG_PATTERN.test(frame) === true,
    'DEV_CHANNELS_DIALOG_PATTERN still matches it, which is why it is deprecated ' +
      'and no longer consulted — this is the defect, demonstrated rather than described'
  );
}

say('');
say('=== 4. Both dialogs inside one live region is ambiguous, and ambiguous never presses ===');
{
  const frame = WORKSPACE_TRUST_PANE.replace(
    'Security guide',
    'Security guide\n  I am using this for local development'
  );
  const v = classifyStartupDialog(frame);
  check(v.kind === 'ambiguous', 'classified ambiguous', v.kind);
  const { result, pressed } = await drive([frame]);
  check(pressed.length === 0, 'NOTHING was pressed', pressed.length);
  check(result.outcome === 'foreign-dialog', 'outcome names the refusal', result.outcome);
}

say('');
say('=== 5. A pane with no dialog is `none`, and a healthy session is untouched ===');
{
  check(classifyStartupDialog(AT_PROMPT_PANE).kind === 'none', 'prompt pane → none');
  check(classifyStartupDialog('').kind === 'none', 'empty pane → none');
  check(
    classifyStartupDialog(
      'claude --dangerously-load-development-channels server:butchr --continue'
    ).kind === 'none',
    'a pane echoing the LAUNCH COMMAND is not a dialog — the flag name is never matched'
  );
}

say('');
say('=== 5b. Our prose with NO confirm line is `undelimited`, and it is LOUD ===');
say('    This is the only direction the positional guard can fail in: it refuses');
say('    where the old whole-frame match would have answered. Refusing wedges an');
say('    agent, so it must never be silent — `none` would have been.');
{
  const midPaint = 'WARNING: Loading development channels\n  Channels: server:butchr';
  check(classifyStartupDialog(midPaint).kind === 'undelimited', 'classified undelimited');
  const { result, pressed, logs } = await drive([midPaint]);
  check(pressed.length === 0, 'NOTHING was pressed', pressed.length);
  check(
    logs.some((l) => l.includes('no') && l.includes('Enter to confirm')),
    'and the log names the missing confirm line and what to suspect',
    logs
  );
  check(
    result.outcome === 'dialog-unanswered',
    'a frame that never resolves ends as the brick, with the REVERT beside it',
    result.outcome
  );
  check(
    logs.some((l) => l.includes('REVERT')),
    'REVERT instruction present'
  );

  // AND THE ORDINARY CAUSE RECOVERS, which is why this does not give up on the
  // first frame the way a foreign dialog does.
  const { result: r2, pressed: p2 } = await drive([
    midPaint,
    DEV_CHANNELS_PANE,
    AT_PROMPT_PANE
  ]);
  check(p2.length === 1, 'a mid-paint frame followed by the full dialog IS answered', p2.length);
  check(r2.outcome === 'ready', 'and reaches ready', r2.outcome);
}

say('');
say('=== 6. Two real dev-channels dialogs in sequence, which is the shipped path ===');
{
  const { result, pressed } = await drive([
    DEV_CHANNELS_PANE,
    DEV_CHANNELS_PANE,
    AT_PROMPT_PANE
  ]);
  check(pressed.length === 2, 'both answered — the `||` raises two', pressed.length);
  check(result.outcome === 'ready', 'and ready', result.outcome);
  check(result.dialogsAnswered === 2, 'counted as two', result.dialogsAnswered);
}

say('');
say(failures === 0 ? `ALL CHECKS PASSED` : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
