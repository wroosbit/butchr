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
// The two fixtures are NOT prose typed by an author who had read the dialogs.
// They are the raw bytes both dialogs wrote to a real PTY on claude-code 2.1.228
// on 2026-08-12, captured with node-pty at 100x30 and pasted here verbatim:
//
//   dev-channels   claude --dangerously-load-development-channels server:butchr \
//                    --permission-mode bypassPermissions        (in a TRUSTED cwd)
//   workspace-trust  the same command in an UNTRUSTED cwd, which raises the trust
//                    dialog first
//
// That matters because the bytes are not what a reader expects. Claude Code's TUI
// emits COLUMN-POSITIONING escapes instead of spaces — `WARNING:\e[12GLoading\e`
// `[20Gdevelopment\e[32Gchannels` — so a fixture written by hand from a
// screenshot would contain spaces the terminal never received, and would agree
// with any matcher at all. `render()` below replays them the way a terminal does,
// so what is matched against is what the dialog actually painted.
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
// The captures, verbatim. See the header for how they were taken.
// ---------------------------------------------------------------------------

const DEV_CHANNELS_PTY_CAPTURE =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[?2031h\u001b[>0q\u001b[c\r\r\n\u001b[38;2;255;102;102m────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[3G\u001b[38;2;255;102;102m\u001b[1mWARNING:\u001b[12GLoading\u001b[20Gdevelopment\u001b[32Gchannels\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[3G--dangerously-load-development-channels\u001b[43Gis\u001b[46Gfor\u001b[50Glocal\u001b[56Gchannel\u001b[64Gdevelopment\u001b[76Gonly.\u001b[82GDo\u001b[85Gnot\u001b[89Guse\u001b[93Gthis\r\r\n\u001b[3Goption\u001b[10Gto\u001b[13Grun\u001b[17Gchannels\u001b[26Gyou\u001b[30Ghave\u001b[35Gdownloaded\u001b[46Goff\u001b[50Gthe\u001b[54Ginternet.\r\r\n\r\r\n\u001b[3GPlease\u001b[10Guse\u001b[14G--channels\u001b[25Gto\u001b[28Grun\u001b[32Ga\u001b[34Glist\u001b[39Gof\u001b[42Gapproved\u001b[51Gchannels.\r\r\n\r\r\n\u001b[3G\u001b[38;2;153;153;153mChannels:\u001b[13Gserver:butchr\u001b[39m\r\r\n\r\r\n\u001b[3G\u001b[38;2;153;204;255m❯\u001b[5G\u001b[38;2;153;153;153m1.\u001b[8G\u001b[38;2;153;204;255mI\u001b[10Gam\u001b[13Gusing\u001b[19Gthis\u001b[24Gfor\u001b[28Glocal\u001b[34Gdevelopment\u001b[39m\r\r\n\u001b[5G\u001b[38;2;153;153;153m2.\u001b[8G\u001b[39mExit\r\r\n\r\r\n\u001b[3G\u001b[38;2;153;153;153m\u001b[3mEnter\u001b[9Gto\u001b[12Gconfirm\u001b[20G·\u001b[22GEsc\u001b[26Gto\u001b[29Gcancel\u001b[23m\u001b[39m\r\r\n\u001b[2C\u001b[4A";

const WORKSPACE_TRUST_PTY_CAPTURE =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[?2031h\r\r\n\u001b[38;2;255;204;0m────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;2;255;204;0m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[1m/tmp/claude-1001/-home-brooswit--local-share-butchr-workspaces-task-kan-340/31e8fb44-458f-44a6-a82\u001b[22m\r\r\n\u001b[2G\u001b[1m5-e1ded1d75fb4/scratchpad/untrusted-probe-dir\u001b[22m\r\r\n\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\u001b[70G(Like\u001b[76Gyour\u001b[81Gown\u001b[85Gcode,\u001b[91Ga\r\r\n\u001b[2Gwell-known\u001b[13Gopen\u001b[18Gsource\u001b[25Gproject,\u001b[34Gor\u001b[37Gwork\u001b[42Gfrom\u001b[47Gyour\u001b[52Gteam).\u001b[59GIf\u001b[62Gnot,\u001b[67Gtake\u001b[72Ga\u001b[74Gmoment\u001b[81Gto\u001b[84Greview\u001b[91Gwhat's\u001b[98Gin\r\r\n\u001b[2Gthis\u001b[7Gfolder\u001b[14Gfirst.\r\r\n\r\r\n\u001b[2GClaude\u001b[9GCode'll\u001b[17Gbe\u001b[20Gable\u001b[25Gto\u001b[28Gread,\u001b[34Gedit,\u001b[40Gand\u001b[44Gexecute\u001b[52Gfiles\u001b[58Ghere.\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mSecurity\u001b[11Gguide\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;204;255m❯\u001b[4G\u001b[38;2;153;153;153m1.\u001b[7G\u001b[38;2;153;204;255mYes,\u001b[12GI\u001b[14Gtrust\u001b[20Gthis\u001b[25Gfolder\u001b[39m\r\r\n\u001b[4G\u001b[38;2;153;153;153m2.\u001b[7G\u001b[39mNo,\u001b[11Gexit\r\r\n\r\r\n\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n\u001b[1C\u001b[4A\u001b[>0q\u001b[c";

/**
 * Replay a PTY capture the way a terminal does, to the extent this needs.
 *
 * Only the sequences these dialogs actually use: `CSI n G` moves to an absolute
 * column (padding with spaces, which is where the missing spaces come from),
 * `\r` returns to column 0, `\n` opens a line, and every other CSI is styling
 * that contributes no cells. Deliberately NOT a terminal emulator — it is the
 * smallest thing that turns these captures into the text a pane read returns.
 */
const ESC = String.fromCharCode(27);
/** `CSI <params> <final>`, anchored at an ESC we have already seen. */
const CSI = new RegExp('^' + ESC + '\\[([0-9;?>]*)([a-zA-Z])');

function render(capture) {
  const lines = [];
  let line = '';
  let i = 0;
  while (i < capture.length) {
    const ch = capture[i];
    if (ch === ESC) {
      const m = CSI.exec(capture.slice(i));
      if (m) {
        if (m[2] === 'G') {
          // Absolute column move. The padding it implies IS the missing space.
          const col = Math.max(1, parseInt(m[1] || '1', 10));
          if (line.length < col - 1) line = line.padEnd(col - 1, ' ');
        }
        i += m[0].length;
        continue;
      }
      i += 2; // ESC 7 / ESC 8 and friends: two bytes, no cells
      continue;
    }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { lines.push(line); line = ''; i += 1; continue; }
    line += ch;
    i += 1;
  }
  lines.push(line);
  return lines.join('\n');
}
const DEV_CHANNELS_PANE = render(DEV_CHANNELS_PTY_CAPTURE);
const WORKSPACE_TRUST_PANE = render(WORKSPACE_TRUST_PTY_CAPTURE);

/** A session that has reached its prompt, for the passes after a dialog clears. */
const AT_PROMPT_PANE = '  ? for shortcuts\n  bypass permissions on\n';

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
