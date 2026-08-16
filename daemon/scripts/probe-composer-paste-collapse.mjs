#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: a composer send reported as "NOT DELIVERED …
 * Nothing was changed on the pane" for a message that IS on the pane — the
 * state KAN-498 measured, where a multi-line steer is typed, collapsed by the
 * client into `[Pasted text #N +M lines]`, mis-verified by an echo-check
 * looking for the literal text, and then reported as a delivery that never
 * touched the recipient.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT COSTS
 * ---------------------------------------------------------------------------
 *
 * A PROBE, not a unit check — it drives real interactive `claude` clients, so
 * CI does not run it. `probe-channel-reaches-model.mjs` is the precedent.
 *
 * It has two stages and they answer two different questions:
 *
 *   STAGE A — WHAT THE CLIENT DOES. One `claude` in a pty, driven directly.
 *     Cheap: it types into the composer and NEVER presses Enter, so no turn
 *     begins and no tokens are spent. This is where the axes are varied.
 *
 *   STAGE B — WHAT CRABCAST SAYS ABOUT IT. A throwaway CrabCast agent, and two
 *     real `send_to_agent` frames, so the WIRE REPLY on the failing path can be
 *     read rather than assumed. Expensive; `--stage-b` opts in.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY STAGE A EXISTS AT ALL: THE TICKET'S DISCRIMINATOR IS n=1 PER ARM
 * ---------------------------------------------------------------------------
 *
 * KAN-498 records one failing send (12 lines) and one succeeding send (one
 * line, ~470 chars) and says so itself: *"The discriminator therefore looks
 * like NEWLINES, not length … n=1 in each arm; nobody has varied this properly,
 * and that is the first thing to do rather than the finding."* Two samples that
 * differ in TWO variables cannot separate them. AC1 asks for the separation, so
 * this stage crosses the axes rather than sampling the diagonal:
 *
 *   newlines : 0, 1, 2, 5, 12          (5 levels)
 *   length   : ~80, ~300, ~1200 chars  (3 levels)
 *   trials   : 3 per cell              -> 45 observations
 *
 * ⚠ **THE CROSS IS THE POINT.** A one-line payload of ~1200 chars is longer
 * than the whole of the failing 12-line message, and a 12-line payload of ~80
 * chars is shorter than the succeeding one-liner. Those two cells are what make
 * the answer a separation rather than a correlation, and neither exists in the
 * ticket's evidence.
 *
 * ---------------------------------------------------------------------------
 * ⚠ HOW A TRIAL IS CLASSIFIED, AND THE CONTROL THAT MAKES "ABSENT" MEAN SOMETHING
 * ---------------------------------------------------------------------------
 *
 * Every payload carries an unguessable letters-only MARKER. After the write the
 * pane is read and the trial is classified:
 *
 *   LITERAL   marker visible on the pane        -> an echo-check would pass
 *   COLLAPSED `[Pasted text #N +M lines]` shown -> text arrived, echo-check FAILS
 *   NEITHER   neither                           -> the pane really did swallow it
 *
 * ⚠ **`COLLAPSED` and `NEITHER` are the two states production cannot tell apart,
 * and that is the entire defect.** An echo-check searching for the literal text
 * returns the same "not found" for both, and they license opposite actions:
 * `COLLAPSED` means the recipient's composer is now holding your text and its
 * previous contents are gone, `NEITHER` means nothing happened. This probe
 * separates them by looking for the client's own collapse marker, which is a
 * different string from the one the failing check looks for.
 *
 * ⚠ **AND THE POSITIVE CONTROL IS THE 0-NEWLINE ROW.** A probe whose every cell
 * came back `COLLAPSED` would be indistinguishable from a probe that had typed
 * nothing at all, mis-read the pane, or lost its pty — every one of which fails
 * toward the interesting answer. The 0-newline cells must come back `LITERAL`,
 * at all three lengths. If they do not, this run measured the harness and not
 * the client, and it says so instead of reporting a finding.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
 * ---------------------------------------------------------------------------
 *
 * **Stage A composes its own payloads and writes its own bytes**, so it tests
 * the client's rendering and NOT that Butchr's send path produces those bytes.
 * That is the KAN-145 shape and it is named rather than left to be inferred.
 *
 *   - **That the daemon's real send path encodes a paste the way Stage A does.**
 *     NOT COVERED HERE. Stage A writes a bracketed paste directly. Stage B is
 *     what closes it, because Stage B sends through CrabCast's own
 *     `send_to_agent` and reads the pane afterwards.
 *   - **Raw (non-bracketed) multi-line writes.** DELIBERATELY NOT RUN. A bare
 *     `\n` at a composer submits the line, so a raw multi-line arm would fire
 *     real turns, spend tokens and leave the pane in a state later trials would
 *     inherit. The 0-newline raw control IS run, at all three lengths, and shows
 *     the marker landing literally under both encodings — which is what licenses
 *     reading the paste result as being about newlines rather than about
 *     bracketing. Multi-line raw behaviour is UNMEASURED and nobody covers it.
 *   - **Whether CrabCast's echo-check is what this predicts.** Stage A observes
 *     the CLIENT. The check is CrabCast's and reading their source is invariant
 *     10, permanent. Stage B observes their WIRE REPLY beside a pane tail, which
 *     is published behaviour and an outside observation — the same posture
 *     KAN-452 and KAN-498 take.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *
 *   node daemon/scripts/probe-composer-paste-collapse.mjs [--verbose]
 *   node daemon/scripts/probe-composer-paste-collapse.mjs --stage-b   # + wire
 *
 * Stage B additionally needs `cd daemon && npm run build` — it imports ../dist.
 *
 * EXIT 0 the run happened and the control held, 1 the control failed so the run
 * is not a verdict, 2 the run did not happen (no client, no CrabCast daemon).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import pty from 'node-pty';

const here = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');
const wantStageB = process.argv.includes('--stage-b');

/** Unguessable, letters-only, per run — a rendered pane mangles anything else. */
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z]/g, 'K');

const CLEAR_SETTLE_MS = 900;
const WRITE_SETTLE_MS = 1500;
const BOOT_TIMEOUT_MS = 180_000;

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}
function note(k, v) {
  console.log(`   ${k.padEnd(38)} ${v}`);
}
function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`       ${detail}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip ANSI so a marker match is about the text and not about the styling. */
function strip(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * ⚠ **WHITESPACE DOES NOT SURVIVE A TUI, SO NOTHING IS MATCHED WITH IT.**
 *
 * Claude Code lays its screen out with cursor-positioning escapes rather than
 * with spaces, so once the escapes are stripped the words butt together:
 * the folder-trust box reads `Quicksafetycheck:Isthisaprojectyoucreated…`.
 * A first cut of this probe matched dialogs on spaced English, matched none of
 * them, and then took the `❯` **in the trust dialog's own option list** for an
 * idle composer — so all 45 trials typed into a modal that ignores pasted text
 * and every cell came back `NEITHER`. The positive control caught it; that is
 * what it is for.
 *
 * So every pattern in this file is matched against the squashed text and is
 * written without spaces. Markers are letters and digits only for the same
 * reason.
 */
function squash(s) {
  return strip(s).replace(/\s+/g, '');
}

// ── the payload grid ────────────────────────────────────────────────────────
//
// A payload is built to a target LENGTH and a target NEWLINE COUNT
// independently, which is the whole point: the two axes must not co-vary.

const LENGTHS = [
  { name: 'short', chars: 80 },
  { name: 'medium', chars: 300 },
  { name: 'longish', chars: 700 },
  { name: 'long', chars: 1200 }
];
const NEWLINES = [0, 1, 3, 6, 12];
const TRIALS = 3;

/** Terminal width for the main grid. Stage C varies it — see `stageC`. */
const GRID_COLS = 120;

/**
 * Build a payload of `chars` total length carrying `newlines` newlines and one
 * marker. The filler is letters and spaces only, so nothing in it can be
 * mistaken for the client's own collapse marker.
 */
function buildPayload(marker, chars, newlines) {
  const head = `${marker} `;
  const bodyLen = Math.max(chars - head.length, 10);
  // Filler first, then newlines distributed through it, so length is held while
  // the newline count moves.
  let body = '';
  const word = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do ';
  while (body.length < bodyLen) body += word;
  body = body.slice(0, bodyLen);

  if (newlines > 0) {
    const seg = Math.floor(body.length / (newlines + 1));
    const parts = [];
    for (let i = 0; i <= newlines; i++) {
      parts.push(body.slice(i * seg, i === newlines ? body.length : (i + 1) * seg));
    }
    body = parts.join('\n');
  }
  return head + body;
}

/** Bracketed paste — what a terminal sends when text is pasted into it. */
function bracketed(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * ⚠ **THE CLIENT HAS TWO COLLAPSE RENDERINGS AND KAN-498 ONLY EVER SAW ONE.**
 *
 * The ticket records `[Pasted text #1 +12 lines]`, so the obvious regex requires
 * the `+N lines` part. Measured here on 2.1.233, a **single-line** 1200-char
 * paste collapses to `[Pasted text #1] paste again to expand` — no line count,
 * because there are no extra lines to count.
 *
 * A regex demanding `+N lines` therefore classifies the single-line collapse as
 * `NEITHER` — *"the pane swallowed it"* — which is the exact confusion this
 * probe exists to separate, reintroduced in the instrument. So the marker is
 * matched on its stable prefix and the `+N lines` suffix is *recorded* rather
 * than *required*.
 */
const COLLAPSE_RE = /\[Pastedtext#\d+/i;
/** Which of the two renderings appeared — reported, never used to classify. */
const COLLAPSE_WITH_LINES_RE = /\[Pastedtext#\d+\+(\d+)lines?\]/i;

/**
 * Boot one interactive client in a pty and leave it at an IDLE COMPOSER.
 *
 * ⚠ **The readiness test is `❯` AND no dialog, and the second half is the
 * load-bearing one.** The folder-trust box's option list is itself `❯1.Yes,I
 * trustthisfolder`, so `❯` alone is satisfied by the very modal that must be
 * dismissed first — which is how a first cut of this probe typed 45 payloads
 * into a dialog and reported a uniform finding.
 *
 * Dialogs are answered on a settled pane with a cooldown, never on every byte:
 * a pty delivers one box in dozens of writes, and an `onData` handler would
 * fire a burst of Enters into whatever came next.
 */
async function bootClient(dir, cols, optional = false) {
  const term = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols,
    rows: 40,
    cwd: dir,
    env: { ...process.env }
  });

  const paneRef = { text: '' };
  let exited = null;
  term.onData((d) => {
    paneRef.text += d;
  });
  term.onExit((e) => {
    exited = e;
  });

  // Space-free, because a TUI's whitespace does not survive stripping. See
  // `squash`. ⚠ Each pattern names a dialog's own OPTION TEXT and nothing
  // generic: an earlier draft included `Entertoconfirm`, which is a footer that
  // lingers in the scrollback long after the box is gone, so the loop pressed
  // Enter every three seconds forever and never reached the composer.
  const DIALOG_RE = /Yes,Itrustthisfolder|Choosethetextstyle|Selectloginmethod/i;

  // ⚠ And only the LAST SCREENFUL is consulted, for the same reason: the whole
  // transcript still contains the trust dialog after it has been dismissed.
  const WINDOW = 600;
  const MAX_PRESSES = 6;

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastPressAt = 0;
  let presses = 0;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    const live = squash(paneRef.text).slice(-WINDOW);
    const dialog = DIALOG_RE.test(live);

    if (!dialog && /❯/.test(live) && !/esctointerrupt/i.test(live)) {
      ready = true;
      break;
    }
    const now = Date.now();
    if (dialog && presses < MAX_PRESSES && now - lastPressAt > 3000) {
      lastPressAt = now;
      presses++;
      term.write('\r');
      if (verbose) console.log(`   [probe] answered a startup dialog (${presses}/${MAX_PRESSES})`);
    }
    await sleep(1000);
  }

  if (!ready) {
    console.error('\nthe client never reached an idle composer.');
    console.error(`exited   : ${JSON.stringify(exited)}`);
    console.error(`pane tail: ${JSON.stringify(squash(paneRef.text).slice(-600))}`);
    try {
      term.kill();
    } catch {
      /* already gone */
    }
    // A stage that could not boot its client has NOT measured anything, and
    // saying so is different from failing. `optional` lets a later stage
    // report "did not run" instead of taking the whole probe — and the earlier
    // stages' findings down with it, which is what happened on the first
    // complete run when Stage C's narrow-terminal arm timed out.
    if (optional) return null;
    process.exit(2);
  }

  note(`composer (cols=${cols})`, 'idle — safe to type at');
  return { term, pane: paneRef };
}

/**
 * One trial: clear the composer, write the payload, settle, read, classify.
 *
 * The clear is exactly one Ctrl+C — one clears the composer, two is how Claude
 * Code quits, which would kill the pane being measured.
 */
async function runTrial(term, paneRef, { encoding, chars, newlines, n, marker }) {
  const payload = buildPayload(marker, chars, newlines);

  term.write('\x03');
  await sleep(CLEAR_SETTLE_MS);

  const before = paneRef.text.length;
  term.write(encoding === 'paste' ? bracketed(payload) : payload);
  await sleep(WRITE_SETTLE_MS);

  const after = squash(paneRef.text.slice(before));
  const literal = after.includes(marker);
  const collapsed = COLLAPSE_RE.test(after);
  const lineForm = COLLAPSE_WITH_LINES_RE.exec(after);
  const verdict = literal ? 'LITERAL' : collapsed ? 'COLLAPSED' : 'NEITHER';

  if (verbose) {
    console.log(
      `   [${encoding}] nl=${String(newlines).padStart(2)} len=${String(chars).padStart(4)} ` +
        `t${n} -> ${verdict.padEnd(9)} ${lineForm ? `(+${lineForm[1]} lines) ` : ''}` +
        JSON.stringify(after.slice(-70))
    );
  }
  return {
    encoding,
    chars,
    newlines,
    n,
    verdict,
    literal,
    collapsed,
    collapseNamedLines: lineForm ? Number(lineForm[1]) : null
  };
}

// ── STAGE A ─────────────────────────────────────────────────────────────────

async function stageA() {
  rule('STAGE A — what the CLIENT does with a pasted payload (no Enter, no turn, no tokens)');

  const stamp = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const clientVersion = (stamp.stdout ?? '').trim();
  if (stamp.error) {
    console.error('no `claude` on PATH. Nothing was attempted; this is not a verdict.');
    process.exit(2);
  }
  note('client on PATH', clientVersion || 'unknown');
  note('run marker', RUN);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan498-collapse-'));
  note('throwaway cwd', dir);

  const { term, pane: paneRef } = await bootClient(dir, GRID_COLS);
  const readPane = () => paneRef.text;

  const trial = (encoding, chars, newlines, n) =>
    runTrial(term, paneRef, {
      encoding,
      chars,
      newlines,
      n,
      marker: `KANP${RUN}${encoding === 'paste' ? 'P' : 'R'}${newlines}L${chars}T${n}`.replace(
        /[^A-Z0-9]/g,
        ''
      )
    });

  const results = [];

  // The bracketed-paste grid: the full cross.
  for (const len of LENGTHS) {
    for (const nl of NEWLINES) {
      for (let n = 1; n <= TRIALS; n++) {
        results.push(await trial('paste', len.chars, nl, n));
      }
    }
  }

  // The raw control, 0 newlines only — see the header for why multi-line raw is
  // not run. This is what licenses reading the grid as being about newlines
  // rather than about bracketing.
  for (const len of LENGTHS) {
    for (let n = 1; n <= TRIALS; n++) {
      results.push(await trial('raw', len.chars, 0, n));
    }
  }

  // Leave the composer as we found it.
  term.write('\x03');
  await sleep(CLEAR_SETTLE_MS);
  try {
    term.kill();
  } catch {
    /* already gone */
  }

  // ── the table ─────────────────────────────────────────────────────────────
  rule('STAGE A RESULTS — bracketed paste, 3 trials per cell');

  const cell = (enc, chars, nl) => {
    const rs = results.filter((r) => r.encoding === enc && r.chars === chars && r.newlines === nl);
    const counts = rs.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
    const only = Object.keys(counts);
    return only.length === 1 ? `${only[0]} x${counts[only[0]]}` : JSON.stringify(counts);
  };

  const header = ['length \\ newlines', ...NEWLINES.map((n) => String(n).padStart(11))].join(' |');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const len of LENGTHS) {
    console.log(
      [
        `${len.name} (${len.chars})`.padEnd(17),
        ...NEWLINES.map((nl) => cell('paste', len.chars, nl).padStart(11))
      ].join(' |')
    );
  }

  console.log('\nraw (non-bracketed) control, 0 newlines:');
  for (const len of LENGTHS) {
    console.log(`   ${`${len.name} (${len.chars})`.padEnd(17)} ${cell('raw', len.chars, 0)}`);
  }

  // ── the verdict, and the control that has to hold for it to be one ────────
  rule('STAGE A VERDICT');

  const paste = results.filter((r) => r.encoding === 'paste');

  // ⚠ THE CONTROL IS THE SMALLEST PAYLOAD, AND ONLY THAT.
  //
  // An earlier draft made it "every 0-newline cell echoes literally", which this
  // probe's own grid then refuted: a 1200-char single-line payload COLLAPSES,
  // legitimately. A control that the measured behaviour violates is not a
  // control, it is a second finding wearing a control's clothes. What has to
  // hold for an absent marker to mean anything is that a payload nobody expects
  // to collapse does echo — 80 characters on one line, under both encodings.
  const smallest = paste.filter((r) => r.newlines === 0 && r.chars === 80);
  const rawAll = results.filter((r) => r.encoding === 'raw' && r.chars === 80);
  const controlHeld =
    smallest.length > 0 &&
    smallest.every((r) => r.verdict === 'LITERAL') &&
    rawAll.every((r) => r.verdict === 'LITERAL');

  check(
    'POSITIVE CONTROL: the smallest payload (80 chars, 0 newlines) echoed its marker literally, ' +
      'under both encodings',
    controlHeld,
    'the control failed, so this run measured the harness and not the client. Nothing below is a ' +
      'finding: a grid that collapses everywhere is what a lost pty, an unanswered startup dialog, ' +
      'a mis-read pane or a typo in the marker also looks like — and the first draft of this probe ' +
      'was all 45 cells COLLAPSED for exactly the second reason.'
  );

  if (!controlHeld) {
    console.log('\n⚠ NO FINDING IS REPORTED. The control is what makes an absent marker mean something.');
    return { results, controlHeld, separation: null };
  }

  // ── THE TWO SINGLE-AXIS CELLS THAT DO THE SEPARATING ──────────────────────
  //
  // These are the cells KAN-498's evidence does not contain, and each moves ONE
  // variable away from a payload the ticket saw.

  // Longest payload, ZERO newlines. Longer than the whole 12-line message that
  // was refused. If newlines were the axis this must stay LITERAL.
  const longSingleLine = paste.filter((r) => r.newlines === 0 && r.chars === 1200);
  const lengthAloneCollapses = longSingleLine.every((r) => r.verdict === 'COLLAPSED');

  // Shortest payload, MANY newlines. Shorter than the one-liner that succeeded.
  // If length were the axis this must stay LITERAL.
  const shortMultiLine = paste.filter((r) => r.newlines === 12 && r.chars === 80);
  const newlinesAloneCollapse = shortMultiLine.every((r) => r.verdict === 'COLLAPSED');

  note('1200 chars, 0 newlines', verdictOf(longSingleLine));
  note('80 chars, 12 newlines', verdictOf(shortMultiLine));

  // ── THE UNIFYING VARIABLE: DISPLAY ROWS ───────────────────────────────────
  //
  // If both single-axis cells collapse, then neither "newlines" nor "length" is
  // the axis, and the thing they have in common is how many ROWS the payload
  // occupies once wrapped to the terminal width: a 1200-char line wraps to
  // ceil(1200/120) = 10 rows, and 12 newlines is 13 rows. Stage C is what
  // settles it, by holding the payload fixed and moving the width.
  const rowsFor = (chars, newlines, cols) => {
    const perLine = Math.floor(chars / (newlines + 1));
    return (newlines + 1) * Math.max(1, Math.ceil(perLine / cols));
  };

  const collapsedRows = paste
    .filter((r) => r.verdict === 'COLLAPSED')
    .map((r) => rowsFor(r.chars, r.newlines, GRID_COLS));
  const literalRows = paste
    .filter((r) => r.verdict === 'LITERAL')
    .map((r) => rowsFor(r.chars, r.newlines, GRID_COLS));

  const maxLiteralRows = literalRows.length ? Math.max(...literalRows) : null;
  const minCollapsedRows = collapsedRows.length ? Math.min(...collapsedRows) : null;
  const rowsSeparates =
    maxLiteralRows !== null && minCollapsedRows !== null && maxLiteralRows < minCollapsedRows;

  note('widest LITERAL payload, in rows', maxLiteralRows === null ? '(none)' : String(maxLiteralRows));
  note('narrowest COLLAPSED payload, rows', minCollapsedRows === null ? '(none)' : String(minCollapsedRows));
  note(
    'do rows separate the two classes?',
    rowsSeparates
      ? `YES — every LITERAL payload is <= ${maxLiteralRows} rows and every COLLAPSED one >= ${minCollapsedRows}`
      : 'NO — the two classes overlap on rows, so rows is not the variable either'
  );

  const separation =
    lengthAloneCollapses && newlinesAloneCollapse && rowsSeparates
      ? `NEITHER, on its own — it is DISPLAY ROWS, which subsumes both. Everything at or below ` +
        `${maxLiteralRows} rows echoes literally. ⚠ Stage C is what tests this, by holding the ` +
        `payload and moving the terminal width.`
      : lengthAloneCollapses && newlinesAloneCollapse && !rowsSeparates
        ? `⚠ BOTH AXES TRIGGER IT, INDEPENDENTLY, AND ROWS IS NOT THE COMMON CAUSE.\n` +
          `   An 80-char payload with newlines collapses — SHORTER than the one-liner KAN-498 saw ` +
          `succeed — and a 1200-char payload with ZERO newlines also collapses, LONGER than the ` +
          `whole 12-line message it saw refused. Rows do not separate the classes ` +
          `(a LITERAL payload reaches ${maxLiteralRows} rows while a COLLAPSED one starts at ` +
          `${minCollapsedRows}), so this is two thresholds and not one.\n` +
          `   ⚠ KAN-498's "NEWLINES, not length" is HALF RIGHT AND UNSAFE TO ACT ON: newlines do ` +
          `collapse it, but so does length alone, so "send it as one line" is not a workaround ` +
          `above the length threshold. Stage D bisects both.`
        : lengthAloneCollapses && !newlinesAloneCollapse
          ? '⚠ LENGTH, not newlines — the OPPOSITE of what KAN-498 inferred from n=1 per arm.'
          : newlinesAloneCollapse && !lengthAloneCollapses
            ? `NEWLINES, not length — KAN-498's inference is confirmed, now at n=${TRIALS} per cell ` +
              `with the length axis held.`
            : 'NEITHER axis separates cleanly at these levels — read the grid above.';

  console.log('\n⚠ WHAT SEPARATES THE ARMS (AC1):');
  console.log(`   ${separation}`);

  return { results, controlHeld, separation, maxLiteralRows, minCollapsedRows, rowsSeparates };
}

/** Collapse a cell's trials to one word, or to the disagreement. */
function verdictOf(rs) {
  if (!rs.length) return '(no trials)';
  const counts = rs.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  const only = Object.keys(counts);
  return only.length === 1 ? `${only[0]} x${counts[only[0]]}` : JSON.stringify(counts);
}

// ── STAGE C ─────────────────────────────────────────────────────────────────

/**
 * ⚠ **THE DISCRIMINATING CONTROL FOR THE ROWS HYPOTHESIS, AND THE ONLY ARM THAT
 * CAN REFUTE IT.**
 *
 * Stage A can show that rows *separate* the classes, but every payload that is
 * wide in rows is also long in characters, so rows and characters co-vary and
 * the grid cannot tell them apart. Terminal WIDTH breaks that: the identical
 * payload, byte for byte, occupies a different number of rows at a different
 * width.
 *
 *   one 900-char line at cols=200  ->  5 rows   -> LITERAL if rows is the axis
 *   the same 900 chars at cols=60  -> 15 rows   -> COLLAPSED if rows is the axis
 *
 * **If the verdict follows the width, the variable is rows.** If it does not
 * move, the variable is character count and the rows story is wrong — and that
 * is a real possible outcome of this stage rather than a formality.
 */
async function stageC() {
  rule('STAGE C — same payload, different terminal WIDTH: does the verdict follow the rows?');

  const CHARS = 900;
  const WIDTHS = [200, 80];
  const out = [];
  for (const cols of WIDTHS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kan498-w${cols}-`));
    const booted = await bootClient(dir, cols, true);
    if (!booted) {
      note(`cols=${cols}`, 'the client never booted at this width — this arm DID NOT RUN');
      continue;
    }
    const { term, pane: paneRef } = booted;
    for (let n = 1; n <= TRIALS; n++) {
      const r = await runTrial(term, paneRef, {
        encoding: 'paste',
        chars: CHARS,
        newlines: 0,
        n,
        marker: `KANW${RUN}C${cols}T${n}`
      });
      out.push({ ...r, cols, rows: Math.ceil(CHARS / cols) });
    }
    term.write('\x03');
    await sleep(CLEAR_SETTLE_MS);
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  }

  const widths = [...new Set(out.map((r) => r.cols))];
  for (const cols of widths) {
    const rs = out.filter((r) => r.cols === cols);
    note(`${CHARS} chars, 0 newlines, cols=${cols} (${Math.ceil(CHARS / cols)} rows)`, verdictOf(rs));
  }

  const verdicts = new Set(out.map((r) => r.verdict));
  const ignoresWidth = widths.length >= 2 && verdicts.size === 1;
  const followsWidth = widths.length >= 2 && verdicts.size > 1;

  console.log('');
  if (ignoresWidth) {
    console.log(
      `   ⚠ THE VERDICT IGNORES THE WIDTH — ${[...verdicts][0]} at ${widths.join(' and ')} columns for\n` +
        `     the same ${CHARS} bytes, which occupy ${widths.map((c) => Math.ceil(CHARS / c)).join(' vs ')} rows.\n` +
        '     So the variable is CHARACTER COUNT, and the display-rows reading is REFUTED.'
    );
  } else if (followsWidth) {
    console.log(
      '   ⚠ THE VERDICT FOLLOWS THE WIDTH, so the variable is DISPLAY ROWS rather than characters.'
    );
  } else {
    console.log('   Only one width ran, so this stage settles nothing. Not a finding either way.');
  }

  return { out, followsWidth, ignoresWidth, widthsRun: widths };
}

// ── STAGE D ─────────────────────────────────────────────────────────────────

/**
 * WHERE THE TWO THRESHOLDS ACTUALLY SIT.
 *
 * Stage A shows *that* both axes collapse; this bisects *where*, because a
 * threshold is what a caller can act on and "somewhere between 700 and 1200" is
 * not. Both are swept at the level that isolates the other axis: the newline
 * sweep runs at 80 characters, which Stage A shows is short enough to echo on
 * one line, and the length sweep runs at zero newlines.
 */
async function stageD() {
  rule('STAGE D — where the thresholds sit');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan498-thresh-'));
  const booted = await bootClient(dir, GRID_COLS, true);
  if (!booted) {
    note('stage D', 'the client never booted — this stage DID NOT RUN');
    return null;
  }
  const { term, pane: paneRef } = booted;

  const NL_SWEEP = [0, 1, 2, 3, 4];
  const LEN_SWEEP = [700, 800, 900, 1000, 1100, 1200];

  const nlOut = [];
  for (const nl of NL_SWEEP) {
    for (let n = 1; n <= TRIALS; n++) {
      nlOut.push(
        await runTrial(term, paneRef, {
          encoding: 'paste',
          chars: 80,
          newlines: nl,
          n,
          marker: `KAND${RUN}N${nl}T${n}`
        })
      );
    }
  }

  const lenOut = [];
  for (const len of LEN_SWEEP) {
    for (let n = 1; n <= TRIALS; n++) {
      lenOut.push(
        await runTrial(term, paneRef, {
          encoding: 'paste',
          chars: len,
          newlines: 0,
          n,
          marker: `KAND${RUN}L${len}T${n}`
        })
      );
    }
  }

  term.write('\x03');
  await sleep(CLEAR_SETTLE_MS);
  try {
    term.kill();
  } catch {
    /* already gone */
  }

  console.log('\nnewline sweep, held at 80 characters:');
  for (const nl of NL_SWEEP) {
    console.log(
      `   ${String(nl).padStart(2)} newline(s) = ${String(nl + 1).padStart(2)} line(s)   ` +
        verdictOf(nlOut.filter((r) => r.newlines === nl))
    );
  }
  console.log('\nlength sweep, held at 0 newlines:');
  for (const len of LEN_SWEEP) {
    console.log(`   ${String(len).padStart(5)} chars   ` + verdictOf(lenOut.filter((r) => r.chars === len)));
  }

  const firstCollapsingNl = NL_SWEEP.find((nl) =>
    nlOut.filter((r) => r.newlines === nl).every((r) => r.verdict === 'COLLAPSED')
  );
  const lastLiteralNl = [...NL_SWEEP]
    .reverse()
    .find((nl) => nlOut.filter((r) => r.newlines === nl).every((r) => r.verdict === 'LITERAL'));
  const firstCollapsingLen = LEN_SWEEP.find((len) =>
    lenOut.filter((r) => r.chars === len).every((r) => r.verdict === 'COLLAPSED')
  );
  const lastLiteralLen = [...LEN_SWEEP]
    .reverse()
    .find((len) => lenOut.filter((r) => r.chars === len).every((r) => r.verdict === 'LITERAL'));

  console.log('');
  note(
    'LINE threshold',
    firstCollapsingNl === undefined
      ? 'not reached in this sweep'
      : `${lastLiteralNl + 1} line(s) echo; ${firstCollapsingNl + 1} line(s) collapse`
  );
  note(
    'LENGTH threshold (single line)',
    firstCollapsingLen === undefined
      ? `not reached by ${LEN_SWEEP[LEN_SWEEP.length - 1]} chars`
      : `${lastLiteralLen ?? '<' + LEN_SWEEP[0]} chars echo; ${firstCollapsingLen} chars collapse`
  );

  return { nlOut, lenOut, firstCollapsingNl, lastLiteralNl, firstCollapsingLen, lastLiteralLen };
}

// ── STAGE B ─────────────────────────────────────────────────────────────────
//
// The wire reply on the failing path, read rather than assumed. Butchr's fix
// consumes CrabCast's structured fields, so which fields actually arrive on
// this path is a measurement the fix depends on.

async function stageB() {
  rule('STAGE B — CrabCast\'s WIRE REPLY on the failing path, beside a pane tail');

  const { crabCastSocketPath } = await import('../dist/runtime-switch.js');
  const { CrabCastLink } = await import('../dist/crabcast-link.js');
  const { workspaceDirFor } = await import('../dist/herdr.js');

  const socketPath = process.env.BUTCHR_CRABCAST_SOCKET ?? crabCastSocketPath();
  note('CrabCast socket', socketPath);

  const link = new CrabCastLink({ socketPath, log: (m) => verbose && console.log(`      [link] ${m}`) });
  link.connect();

  const connected = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (link.describe?.().connected ?? link.connected) return true;
      await sleep(250);
    }
    return false;
  })();

  if (!connected) {
    console.error('no CrabCast daemon answered. Stage B did not happen; this is NOT a verdict.');
    return { ran: false };
  }

  // THROWAWAY, UNIQUE PER RUN. An activation at a path CrabCast has no record
  // for starts fresh, so this must never point at a workspace whose
  // conversation matters.
  const TYPE = 'task';
  const KEY = `kan-498-collapse-${RUN.toLowerCase()}`;
  const workDir = workspaceDirFor(TYPE, KEY);
  note('throwaway agent', `${TYPE}/${KEY}`);
  note('workspace', workDir);

  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'prompt.md'),
    'You are a throwaway probe target for KAN-498. Do nothing at all. Do not read files, do not ' +
      'run commands, do not call tools. If anything is typed at you, reply with the single word OK ' +
      'and stop.\n'
  );

  const configured = await link.request({
    action: 'configure_agent',
    path: workDir,
    priority: 1,
    launcher: 'claude',
    prompt: 'You are a throwaway probe target. Do nothing. Reply OK to anything and stop.'
  });
  check('the throwaway path was configured', configured.success === true, JSON.stringify(configured).slice(0, 300));

  const activated = await link.request({ action: 'activate_agent', path: workDir });
  if (activated.success !== true) {
    console.error(`CrabCast refused the activation: ${JSON.stringify(activated).slice(0, 400)}`);
    console.error('Stage B did not happen; this is NOT a verdict.');
    return { ran: false };
  }

  // A send into a booting session is refused for a reason that has nothing to
  // do with this ticket, so readiness is polled rather than slept on.
  const paneReady = await (async () => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const t = await link.request({ action: 'tail_agent', path: workDir, lines: 60 }).catch(() => null);
      const text = typeof t?.text === 'string' ? t.text : '';
      if (text.includes('❯') && !/esc to interrupt/i.test(text)) return true;
      await sleep(3000);
    }
    return false;
  })();
  check('the throwaway session reached an idle composer', paneReady === true);
  if (!paneReady) return { ran: false };

  const arms = [];
  for (const arm of [
    { name: 'MULTI-LINE (12 newlines)', newlines: 12, chars: 300 },
    { name: 'SINGLE-LINE (0 newlines)', newlines: 0, chars: 300 }
  ]) {
    const marker = `KANB${RUN}N${arm.newlines}`;
    const message = buildPayload(marker, arm.chars, arm.newlines);

    const reply = await link.request({ action: 'send_to_agent', path: workDir, message });
    await sleep(2500);
    const tail = await link.request({ action: 'tail_agent', path: workDir, lines: 40 }).catch(() => null);
    const tailText = typeof tail?.text === 'string' ? strip(tail.text) : '';

    console.log(`\n--- ARM ${arm.name} ---`);
    console.log(`marker              : ${marker}`);
    console.log(`WIRE REPLY (verbatim): ${JSON.stringify(reply, null, 2)}`);
    console.log(`pane shows marker   : ${tailText.includes(marker)}`);
    console.log(`pane shows collapse : ${COLLAPSE_RE.test(tailText)}`);
    console.log(`pane tail           : ${JSON.stringify(tailText.trim().slice(-300))}`);

    arms.push({
      ...arm,
      marker,
      reply,
      paneLiteral: tailText.includes(marker),
      paneCollapsed: COLLAPSE_RE.test(tailText)
    });
  }

  // ── what the fix may consume ──────────────────────────────────────────────
  rule('STAGE B — WHICH FIELDS THE FAILING REPLY ACTUALLY CARRIES');

  const failing = arms.find((a) => a.newlines > 0);
  const fields = failing ? Object.keys(failing.reply ?? {}) : [];
  note('keys on the failing reply', fields.join(', ') || '(none)');
  for (const f of ['success', 'delivered', 'verdict', 'interrupts', 'submits', 'inComposer', 'evidence']) {
    note(`  ${f}`, f in (failing?.reply ?? {}) ? JSON.stringify(failing.reply[f]) : '(absent)');
  }

  check(
    'the failing arm was typed onto the pane — so a refusal claiming otherwise is false',
    failing?.paneCollapsed === true || failing?.paneLiteral === true,
    'the pane shows neither the marker nor a collapse block: this arm may genuinely not have ' +
      'arrived, which would be a different defect from the one KAN-498 describes'
  );

  try {
    await link.request({ action: 'deactivate_agent', path: workDir });
  } catch {
    /* best effort — it is a throwaway */
  }

  return { ran: true, arms };
}

// ── run ─────────────────────────────────────────────────────────────────────

const a = await stageA();
const c = a.controlHeld ? await stageC() : null;
const d = a.controlHeld ? await stageD() : null;
if (wantStageB) {
  await stageB();
} else {
  rule('STAGE B — SKIPPED');
  console.log('   Pass --stage-b to read CrabCast\'s wire reply on the failing path.');
  console.log('   Without it, this run says what the CLIENT does and nothing about what the');
  console.log('   DAEMON reports about it.');
}

rule('SUMMARY');
if (a.controlHeld) {
  console.log(`AC1 — what separates the arms:\n   ${a.separation}`);
  if (c) {
    console.log(
      `\nAC1 — width control: ${
        c.followsWidth
          ? 'the verdict FOLLOWS the terminal width, so the variable is display rows.'
          : c.ignoresWidth
            ? 'the verdict IGNORES the terminal width, so the variable is CHARACTER COUNT and the ' +
              'display-rows reading is refuted.'
            : 'only one width ran — this settles nothing.'
      }`
    );
  }
  if (d) {
    console.log(
      `\nAC1 — thresholds: ${
        d.firstCollapsingNl === undefined
          ? 'no line threshold found'
          : `${d.lastLiteralNl + 1} line(s) echo, ${d.firstCollapsingNl + 1} line(s) collapse`
      }; ${
        d.firstCollapsingLen === undefined
          ? 'no length threshold found'
          : `${d.lastLiteralLen ?? '?'} chars echo, ${d.firstCollapsingLen} chars collapse (single line)`
      }.`
    );
    console.log(
      '\n⚠ FOR THE FLEET: a steer is only safe from collapse if it is BOTH within the line\n' +
        '   threshold AND within the length threshold. "Send it as one line" alone is not enough.'
    );
  }
} else {
  console.log('AC1 — NOT ANSWERED: the positive control failed, so this run measured the harness.');
}
console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
