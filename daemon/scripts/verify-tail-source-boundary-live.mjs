#!/usr/bin/env node
// KAN-255 — the premise, measured against a real herdr and real panes.
//
// WHAT FAILURE THIS WOULD CATCH: the rule `tailAgent`'s fallback is built on
// ceasing to be true — herdr no longer answering `""` for a live pane that has
// text on it, or answering it by some rule other than `--lines` windowing the
// grid's blank rows. Either way the fallback in `tailAgent` would be guarding
// nothing while `verify-tail-asks-every-source.mjs` stayed green, because that
// script writes its own herdr and would go on modelling a herdr that no longer
// exists. It would also catch the reverse: a herdr that started freezing a dead
// agent's last frame, which is the capability the old docblock claimed and §5
// asserts is absent.
//
// ---------------------------------------------------------------------------
// WHY THIS IS THE HAND-RUN HALF OF A PAIR
// ---------------------------------------------------------------------------
//
// `verify-tail-asks-every-source.mjs` shims herdr, so every empty read it
// asserts on is a read that script wrote. It proves the shipped code OBEYS the
// rule. It cannot prove the rule is REAL — that is this file, and it needs a
// herdr server and a terminal, which no CI runner has. Its output goes on the
// PR. Neither claims the other's half; the gap between two green scripts with
// nobody owning the seam is the KAN-145 shape, and this paragraph is where the
// seam is named.
//
// THE GUARD IS THAT THE BOUNDARY IS PREDICTED BEFORE IT IS MEASURED. §1 asks
// the pane's own shell for its grid height, counts the content rows, computes
// `rows - contentRows`, PRINTS THE PREDICTION, and only then sweeps `--lines`
// to find where the answer flips. A rule that was wrong — or a herdr that had
// changed — gives a different boundary and this fails. It cannot be satisfied
// by describing whatever happened to occur.
//
// WHAT THIS FILE DOES NOT COVER. It never spawns a Claude Code agent, so the
// REAL development-channels dialog is not among its panes: §4 uses a synthetic
// full-screen frame, which establishes the geometry claim (a screen-filling
// frame has no blank rows to window, so it cannot read empty) but is not the
// dialog itself. The real dialog was measured by hand for KAN-255 — a live,
// unanswered full-screen dialog on a 23-row pane returned 607 characters at
// `--lines 120` and was BYTE-IDENTICAL at every sample across 100 seconds — and
// that output is pasted on the PR rather than reproduced here, because getting
// a real dialog needs an authenticated `claude` and a workspace nobody else is
// using. WHO COVERS IT: nobody, as a script. The PR paste is the record.
//
// Creates its own herdr tab and closes it. Touches no other agent's pane.
// Exits non-zero on any failure.
//
// Usage:
//   node daemon/scripts/verify-tail-source-boundary-live.mjs

import { spawnSync } from 'child_process';

let failures = 0;
let checks = 0;
function check(ok, name, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function herdr(args, { json = true } = {}) {
  const res = spawnSync('herdr', args, { encoding: 'utf8', timeout: 15_000 });
  const stdout = (res.stdout ?? '').trim();
  if (!json) return { ok: res.status === 0, text: stdout, stderr: (res.stderr ?? '').trim() };
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.error) return { ok: false, error: parsed.error };
    return { ok: true, value: parsed };
  } catch {
    const parsedErr = (() => { try { return JSON.parse(res.stderr ?? ''); } catch { return null; } })();
    if (parsedErr?.error) return { ok: false, error: parsedErr.error };
    return { ok: false, error: { code: 'unparseable', message: stdout || (res.stderr ?? '') } };
  }
}

const version = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  // A SETUP GUARD, NOT A VERDICT. Nothing has been measured at this point.
  console.error('herdr is not on PATH; this proof needs a real herdr server and a terminal.');
  process.exit(2);
}
console.log('KAN-255 — the herdr read-source rule, measured live');
console.log(`herdr: ${(version.stdout ?? '').trim()}`);

// ---------------------------------------------------------------------------
// Our own tab, so nothing here can land on another agent's pane.
// ---------------------------------------------------------------------------
const tab = herdr(['tab', 'create', '--cwd', '/tmp', '--label', 'kan255-boundary', '--no-focus']);
if (!tab.ok) {
  console.error(`could not create a tab: ${JSON.stringify(tab.error)}`);
  process.exit(2);
}
const PANE = tab.value.result.root_pane.pane_id;
const TAB = tab.value.result.tab.tab_id;
let dyingPaneId = null;
const cleanup = () => {
  if (dyingPaneId) herdr(['pane', 'close', dyingPaneId]);
  herdr(['tab', 'close', TAB]);
};
process.on('exit', cleanup);

/** Read the pane, returning the text or `null` when herdr would not answer. */
function read(source, lines) {
  const res = herdr(['pane', 'read', PANE, '--source', source, '--format', 'text', '--lines', String(lines)],
    { json: false });
  return res.ok ? res.text : null;
}
function run(command) {
  herdr(['pane', 'run', PANE, command]);
}

/**
 * A `visible` frame that both satisfies `predicate` and has stopped changing.
 *
 * NEVER A FIXED SLEEP, AND THE REASON IS THIS FILE'S OWN HISTORY. Two runs
 * failed on a `await sleep(2500)` that read the pane mid-command: once §1 saw
 * the marker but not yet the `tput lines` output and computed a grid height of
 * NaN, and once §3 read the screen before it had scrolled. Neither failure was
 * about herdr, which is the worst kind — a proof going red for a reason that
 * has nothing to do with what it proves teaches its reader to discount it.
 *
 * Stability is required as well as the predicate because a frame can satisfy a
 * pattern while output is still arriving; two consecutive equal reads is what
 * makes everything downstream a measurement of a pane at rest.
 */
async function settledVisible(predicate, { attempts = 40, everyMs = 500 } = {}) {
  let previous = null;
  for (let i = 0; i < attempts; i += 1) {
    await sleep(everyMs);
    const frame = read('visible', 200);
    if (frame !== null && predicate(frame) && frame === previous) return frame;
    previous = frame;
  }
  return previous;
}

try {
  // =========================================================================
  rule('1. THE BOUNDARY IS PREDICTED FROM THE PANE\'S OWN GEOMETRY, THEN MEASURED');
  // =========================================================================
  // The pane is asked how tall it is; the content is counted; the boundary is
  // computed and printed BEFORE the sweep runs. This is the check that cannot
  // be satisfied by narrating whatever happened.
  run('clear; echo KAN255-MARKER-TOP; tput lines');
  // Wait for BOTH lines the section depends on — the marker and the numeric
  // grid height — and for the frame to stop changing.
  const visible = await settledVisible(
    (f) => f.includes('KAN255-MARKER-TOP') && /^\s*\d+\s*$/m.test(f)
  );
  if (visible === null) throw new Error('the pane would not answer a `visible` read');
  const contentRows = visible.replace(/\n+$/, '').split('\n');
  const rowsLine = contentRows.find((l) => /^\d+$/.test(l.trim()));
  const R = rowsLine ? Number(rowsLine.trim()) : NaN;
  const C = contentRows.length;
  const predicted = R - C;

  console.log(`  grid height R  = ${R} rows (the pane's own \`tput lines\`)`);
  console.log(`  content rows C = ${C}`);
  console.log(`  PREDICTION: recent-unwrapped answers "" for every N <= ${predicted}, and text at N = ${predicted + 1}`);

  check(Number.isFinite(R) && R > 0, 'the pane reported a usable grid height', `R=${R}`);
  check(visible.includes('KAN255-MARKER-TOP'), 'and the pane plainly HAS text on it', JSON.stringify(visible));

  let flipped = null;
  const sweep = [];
  for (let n = 1; n <= Math.min(R + 8, 200); n += 1) {
    const t = read('recent-unwrapped', n);
    sweep.push({ n, empty: t === '' });
    if (t !== '' && flipped === null) flipped = n;
  }
  const lastEmpty = sweep.filter((s) => s.empty).map((s) => s.n).pop() ?? 0;
  console.log(`  MEASURED  : empty for every N <= ${lastEmpty}, first text at N = ${flipped}`);

  check(sweep.slice(0, predicted).every((s) => s.empty),
    `every N from 1 to ${predicted} answers the EMPTY STRING, as predicted`,
    JSON.stringify(sweep.filter((s) => s.n <= predicted && !s.empty)));
  check(flipped === predicted + 1,
    `and the first N that answers is exactly ${predicted + 1} — the prediction, not a description`,
    `measured first-text N = ${flipped}`);
  check(lastEmpty === predicted,
    'no N above the boundary is empty either — the flip happens once and stays flipped',
    `last empty N = ${lastEmpty}`);

  // =========================================================================
  rule('2. `visible` IGNORES --lines ENTIRELY, which is what makes it a usable fallback');
  // =========================================================================
  const visibleAnswers = new Set();
  for (const n of [1, 2, 5, 10, 20, 23, 40, 120, 200]) visibleAnswers.add(read('visible', n));
  check(visibleAnswers.size === 1,
    'byte-identical at every N from 1 to 200',
    `${visibleAnswers.size} distinct answers`);
  check(!visibleAnswers.has('') && [...visibleAnswers][0]?.includes('KAN255-MARKER-TOP'),
    'and it has the text at the very --lines where recent-unwrapped answered nothing',
    JSON.stringify([...visibleAnswers][0]));

  // =========================================================================
  rule('3. `recent-unwrapped` REACHES THROUGH SCROLLBACK, WHICH `visible` CANNOT SEE');
  // =========================================================================
  // This is why it keeps its place FIRST. A fix that simply swapped the two
  // would lose history every time a pane had scrolled, and this section is what
  // would catch that.
  // SHELL-AGNOSTIC BY CONSTRUCTION. The pane runs the user's login shell, which
  // on this machine is fish — a `for i in $(seq ...); do ... done` would be a
  // syntax error there, and an error message is also "some text on a pane", so
  // it would satisfy a naive assertion while measuring nothing. A pipeline is
  // the same in every shell this could land in.
  run(`seq 1 ${R * 3} | awk '{print "SCROLLBACK-LINE-" $1}'`);

  // POLLED, NOT SLEPT. The claim is "the marker has scrolled off the screen",
  // so wait for that to be true rather than guessing how long it takes; a fixed
  // sleep read the screen mid-command on the first run and failed for a reason
  // that had nothing to do with the sources.
  let screen = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    screen = read('visible', 120);
    if (screen !== null && !screen.includes('KAN255-MARKER-TOP')) break;
  }
  const deep = read('recent-unwrapped', 200);
  check(screen !== null && !screen.includes('KAN255-MARKER-TOP'),
    'the marker has scrolled off the screen — `visible` no longer has it',
    JSON.stringify(screen?.slice(-80)));
  check(deep !== null && deep.includes('KAN255-MARKER-TOP'),
    'and recent-unwrapped still does: it reaches through SCROLLBACK, which is why it stays first',
    JSON.stringify(deep?.slice(0, 80)));

  // =========================================================================
  rule('4. NO TIME DEPENDENCE, AND A SCREEN-FILLING FRAME NEVER READS EMPTY');
  // =========================================================================
  // The two halves of the claim `channel-startup.ts` used to make. It said
  // `recent-unwrapped` "reports what has RECENTLY SCROLLED" and that a
  // full-screen frame therefore drains to empty within a minute. Both halves
  // are refuted here: nothing drains, and a frame that FILLS the screen leaves
  // no blank rows for any --lines to window.
  const frameRowCount = Math.max(R - 1, 1);
  run(`clear; seq 1 ${frameRowCount} | awk '{print "KAN255-FULLSCREEN-FRAME-ROW-" $1}'`);
  const frame = await settledVisible(
    (f) => f.split('\n').filter((l) => l.includes('KAN255-FULLSCREEN-FRAME-ROW')).length >= frameRowCount - 2
  );

  // THE FRAME REALLY FILLS THE SCREEN, ASSERTED RATHER THAN ASSUMED. Everything
  // below is a claim about a screen with no blank rows left to window; if the
  // command had failed and left a short error message instead, the samples
  // would still be identical and still non-empty, and this section would report
  // a fact about nothing. This check is what stops that.
  const frameRows = (frame ?? '').replace(/\n+$/, '').split('\n');
  check(frame !== null && frameRows.length >= R - 1 &&
        frameRows.filter((l) => l.includes('KAN255-FULLSCREEN-FRAME-ROW')).length >= R - 3,
    `the frame really fills the ${R}-row screen — ${frameRows.length} rows, so there are no blank rows to window`,
    JSON.stringify(frame?.slice(0, 120)));

  const N_SET = [1, 5, 20, 40, 120, 200];
  const snapshot = () => ({ visible: read('visible', 200), recent: N_SET.map((n) => read('recent-unwrapped', n)) });

  // WHAT IS ACTUALLY BEING CLAIMED, STATED CAREFULLY BECAUSE THE OBVIOUS
  // VERSION OF IT IS WRONG. "Nothing drains over time" is a claim about
  // HERDR'S READ, not about a pane that never changes — and the pane does
  // change: the login shell in it repaints its prompt on its own schedule, and
  // a run of this section caught that at t+50s, with the last grid row going
  // blank and `--lines 1` correctly following it to "". A check that demanded
  // absolute stability would be red for a reason it does not measure.
  //
  // So the claim is CONDITIONAL, and it is the one that refutes the docblock:
  // WHENEVER THE PANE'S CONTENT IS UNCHANGED, EVERY `recent-unwrapped` READ IS
  // UNCHANGED TOO. A read that decayed with elapsed time would break that on a
  // pane sitting still, which is exactly the state channel-startup.ts claimed
  // drains to empty within a minute. `visible` is the witness for "the pane did
  // not change", because it is the frame itself and is unaffected by --lines.
  let previous = snapshot();
  const drifts = [];
  let comparable = 0;
  for (let i = 0; i < 9; i += 1) {
    await sleep(10_000);
    const now = snapshot();
    if (now.visible !== null && now.visible === previous.visible) {
      comparable += 1;
      now.recent.forEach((text, j) => {
        if (text !== previous.recent[j]) {
          drifts.push(
            `t+${(i + 1) * 10}s N=${N_SET[j]}: the pane did not change but the read did — ` +
            `${JSON.stringify(previous.recent[j]?.slice(-40))} -> ${JSON.stringify(text?.slice(-40))}`
          );
        }
      });
    }
    previous = now;
  }
  console.log(`  sampled every 10s for 90s at N = ${N_SET.join(', ')}`);
  console.log(`  ${comparable} of 9 intervals had an unchanged pane and are therefore comparable`);

  // The section would be vacuous if the pane changed at every step, so say so.
  check(comparable >= 5,
    'the pane sat still for most of the window, so there is something to measure',
    `only ${comparable} of 9 intervals were comparable`);
  check(drifts.length === 0,
    'and across every one of them the reads are BYTE-IDENTICAL — a still pane does not drain',
    drifts.slice(0, 6).join('\n'));
  check(previous.recent.filter((t) => t === '').length <= 1,
    'a screen-filling frame reads NON-EMPTY at every N above the last row',
    JSON.stringify(previous.recent.map((t) => (t ?? '').length)));

  // =========================================================================
  rule('5. NO SOURCE SHOWS A DEAD AGENT\'S FROZEN LAST FRAME');
  // =========================================================================
  // The old docblock justified `recent-unwrapped` as the source that shows
  // "the frozen last frame of an agent whose process died". If that capability
  // existed, adding a `visible` fallback might have cost it. It does not exist:
  // herdr destroys the pane with its process. A source that DID show the frame
  // would mean the deleted docblock was right and the fix needs re-examining —
  // which is what this check is here to say if it ever fails.
  // NO PLACEMENT ARGUMENTS. Letting herdr place the pane is deliberate: naming
  // a tab makes this depend on tab-id stability across a run, which is not a
  // property this proof is about and which failed a run for that reason alone.
  // The pane is tracked by id and closed in the `finally`.
  const dying = herdr(['agent', 'start', 'kan255-dying-probe', '--cwd', '/tmp',
    '--no-focus', '--', 'bash', '--norc', '--noprofile', '-c',
    'clear; echo KAN255-LAST-WORDS; sleep 600']);
  if (!dying.ok) throw new Error(`could not start the probe agent: ${JSON.stringify(dying.error)}`);
  dyingPaneId = dying.value.result.agent.pane_id;
  await sleep(3000);

  const alive = herdr(['agent', 'read', 'kan255-dying-probe', '--source', 'visible',
    '--format', 'text', '--lines', '40'], { json: false });
  check(alive.ok && alive.text.includes('KAN255-LAST-WORDS'),
    'the probe agent is alive and its last words are on the pane', JSON.stringify(alive.text));

  herdr(['agent', 'send', 'kan255-dying-probe', 'exit\n'], { json: false });
  const dyingPane = dyingPaneId;
  herdr(['pane', 'send-keys', dyingPane, 'C-c'], { json: false });
  herdr(['pane', 'send-text', dyingPane, 'exit'], { json: false });
  herdr(['pane', 'send-keys', dyingPane, 'Enter'], { json: false });

  let stillReadable = [];
  for (let i = 0; i < 15; i += 1) {
    await sleep(1000);
    stillReadable = ['visible', 'recent', 'recent-unwrapped'].filter((source) => {
      const r = herdr(['agent', 'read', 'kan255-dying-probe', '--source', source,
        '--format', 'text', '--lines', '40'], { json: false });
      return r.ok && r.text.includes('KAN255-LAST-WORDS');
    });
    if (stillReadable.length === 0) break;
  }
  check(stillReadable.length === 0,
    'within 15s of the process exiting, NO source still shows the frame — there is nothing to freeze',
    `sources still answering with the frame: ${stillReadable.join(', ') || 'none'}`);
  if (stillReadable.length > 0) {
    console.log('        ^ IF THIS FAILS: the deleted docblock was RIGHT about a frozen last frame,');
    console.log('          and the `visible` fallback needs re-examining for what it costs.');
  }
} finally {
  cleanup();
}

console.log(`\n${'='.repeat(70)}`);
console.log(`${checks} checks, ${failures} failed`);
console.log(failures === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(failures ? 1 : 0);
