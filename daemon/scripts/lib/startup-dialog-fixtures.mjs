// The measured dialog captures, shared by every proof that needs a real pane.
//
// NOT A `verify-` SCRIPT: it asserts nothing and exits nowhere. It is the
// fixtures `verify-startup-dialog-discrimination.mjs` measured, lifted out by
// KAN-543 so that a second proof — `verify-nudge-refuses-a-dialog-pane.mjs` —
// tests the SAME bytes rather than prose retyped from a screenshot. Two proofs
// each hand-typing "what a dialog looks like" is two chances to write a fixture
// that agrees with any matcher at all; see the note below on why the raw bytes
// are not what a reader expects.
//
// Its red drive lives in the scripts that import it: change a capture and both
// go red, which is the coverage boundary this header owes the reader.
//
// ---------------------------------------------------------------------------
// WHERE THE PANE TEXT COMES FROM, BECAUSE IT IS THE WHOLE VALUE OF THESE PROOFS
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
// emits COLUMN-POSITIONING escapes instead of spaces, so a fixture written by hand
// from a screenshot would contain spaces the terminal never received, and would
// agree with any matcher at all. `render()` below replays them the way a terminal
// does, so what is matched against is what the dialog actually painted.

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

/** The dev-channels dialog as a terminal would have shown it. */
export const DEV_CHANNELS_PANE = render(DEV_CHANNELS_PTY_CAPTURE);

/** The workspace-trust dialog as a terminal would have shown it. */
export const WORKSPACE_TRUST_PANE = render(WORKSPACE_TRUST_PTY_CAPTURE);

/**
 * A session that has reached its prompt: the status footer, and no dialog.
 *
 * This one IS hand-written, and it is the healthy control every proof here needs
 * a green from — a fix that refuses dialogs and also refuses this has broken the
 * thing it was guarding.
 */
export const AT_PROMPT_PANE = '  ? for shortcuts\n  bypass permissions on\n';

/**
 * A NARROW pane: the composer caret, and no status footer.
 *
 * The case `nudge.ts` keeps the caret for (KAN-543). A pane read can be narrow
 * enough that the footer wraps off the tail while the input line is plainly
 * there, and refusing to nudge here costs a nudge to an agent that is genuinely
 * idle. It has no `Enter to confirm`, so it classifies `none` and the caret is
 * reached — which is exactly the distinction the old marker list could not draw.
 */
export const NARROW_PROMPT_PANE = '\u276f ';
