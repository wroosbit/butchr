#!/usr/bin/env node
// KAN-255 — a tail may not report a pane empty until it has asked every source.
//
// WHAT FAILURE THIS WOULD CATCH: `HerdrBridge.tailAgent` answering
// `{success: true, text: ''}` for a pane that is ALIVE and has text on it,
// because it asked ONE herdr read source and that source answers `""` when the
// `--lines` window lands entirely in a pane's blank rows. An empty string is a
// string, so no `typeof text !== 'string'` guard catches it, and the caller is
// handed a SUCCESSFUL read of NO OUTPUT — which is a claim about the agent
// ("nothing is happening there") built out of a fact about the read. It would
// also catch the repair going wrong in the other direction: a source that
// REFUSED being counted as a source that said "empty" (§5), which is the same
// defect wearing the fallback's clothes.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT SUPPLIES ITS OWN INPUT. READ WHAT THAT LEAVES UNCOVERED.
// ---------------------------------------------------------------------------
//
// The herdr here is a shim this file writes, so every read it asserts on is a
// read this file produced. THAT MEANS THIS SCRIPT CANNOT ESTABLISH THAT REAL
// HERDR EVER ANSWERS `""` FOR A PANE WITH TEXT ON IT. If that premise were
// false, or had been fixed upstream, every section below would still pass while
// the fallback in `tailAgent` guarded nothing — the KAN-145 shape, two green
// scripts with the gap between them and no script owning it.
//
// WHO COVERS IT: `daemon/scripts/verify-tail-source-boundary-live.mjs`, against
// the real herdr and a real pane. It is hand-run — no CI runner has a terminal
// — and its output goes on the PR. The two are a pair: that one shows the rule
// is REAL, this one shows the shipped code OBEYS it, and neither claims the
// other's half.
//
// WHAT THE SHIM MODELS, and it is the MEASURED rule rather than a convenient
// flag (herdr 0.6.4, measured live by the sibling script on this machine):
//
//   * `recent`/`recent-unwrapped --lines N` return THE LAST N ROWS OF THE GRID.
//     Rows below the cursor are blank, so a pane whose content sits in the top
//     C rows of an R-row screen answers `""` for every N <= R - C. Predicted
//     from geometry and hit exactly: R=23, C=3 answered `""` at every N from 1
//     to 20 and returned text at N=21.
//   * `visible` returns the screen's content and IGNORES N entirely —
//     byte-identical at every N from 1 to 200 on the same pane.
//
// So the shim is a grid, not a switch: the empty answers below are produced the
// way herdr produces them, by windowing blank rows.
//
// WHICH OF THESE IS REACHABLE ON A REAL PANE, SAID PLAINLY BECAUSE §7 IS NOT.
// Every herdr pane measured on this machine is 23 rows, so R - C <= 22 and only
// a caller asking for N <= 22 can hit the empty read. In this repository that
// is `butchr_tail_agent`, whose `lines` comes from whichever agent called it
// (default 40, but 1..200 is accepted) — §2 and §6 run on that real geometry.
// The daemon's own `readPane` asks for 140 and `nudge.ts` for 40 or 60, so
// NEITHER CAN REACH IT AT 23 ROWS; §7 drives that composition on a modelled
// 200-row grid, and it is a proof about the code's shape rather than a report
// of a state anybody has seen. Nobody has observed a spurious empty read in
// production. That is the honest edge of this file.
//
// Needs no daemon, no network and no real herdr. Exits non-zero on any failure.
//
// Usage:
//   cd daemon && npm run build
//   node daemon/scripts/verify-tail-asks-every-source.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.resolve(scriptDir, '..', 'dist');

if (!fs.existsSync(path.join(distDir, 'herdr.js'))) {
  // A SETUP GUARD, NOT A VERDICT. Nothing has been tested at this point.
  console.error(`No build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

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

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan255-'));
const shimState = path.join(scratchRoot, 'shim-state');
const shimDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.BUTCHR_KAN255_SHIM_STATE = shimState;

// ---------------------------------------------------------------------------
// The herdr shim: A GRID, read the way herdr reads one.
// ---------------------------------------------------------------------------
const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.BUTCHR_KAN255_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};

const paneFile = path.join(state, 'pane.json');
/** rows = the GRID's height; \`content\` is the text at the top of it. */
const readPaneModel = () => JSON.parse(fs.readFileSync(paneFile, 'utf8'));

/**
 * THE MEASURED RULE. The grid is \`rows\` tall; content sits at the top and the
 * rest are blank. A \`recent\` read windows the LAST N ROWS of that grid and
 * joins them — so when the window lies entirely in the blank region the answer
 * is the empty string, which is exactly what herdr 0.6.4 does.
 */
const recentRead = (p, n) => {
  const content = p.content === '' ? [] : p.content.split('\\n');
  const grid = content.concat(Array(Math.max(0, p.rows - content.length)).fill(''));
  return grid.slice(Math.max(0, grid.length - n)).join('\\n').replace(/\\n+$/, '');
};

if (args[0] === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (args[0] === 'agent' && args[1] === 'read') {
  const srcIdx = args.indexOf('--source');
  const source = srcIdx === -1 ? 'recent-unwrapped' : args[srcIdx + 1];
  const lineIdx = args.indexOf('--lines');
  const n = lineIdx === -1 ? 40 : Number(args[lineIdx + 1]);

  // A source that REFUSES, so "could not look" can be told from "empty".
  if (fs.existsSync(path.join(state, 'fail-' + source))) {
    fail('herdr_unreachable', 'could not connect to the herdr server (' + source + ')');
  }
  const p = readPaneModel();
  // \`visible\` ignores N — measured, at every N from 1 to 200.
  const text = source === 'visible' ? p.content : recentRead(p, n);
  out({ result: { read: { text, truncated: false } } });
}

out({ result: {} });
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { superviseChannelStartup } = await import(path.join(distDir, 'channel-startup.js'));

const invocationsFile = path.join(shimState, 'invocations.jsonl');
const resetInvocations = () => fs.writeFileSync(invocationsFile, '');
const reads = () => (fs.existsSync(invocationsFile) ? fs.readFileSync(invocationsFile, 'utf8') : '')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((a) => a[0] === 'agent' && a[1] === 'read');
const sourcesAsked = () => reads().map((a) => a[a.indexOf('--source') + 1]);

const paneFile = path.join(shimState, 'pane.json');
const setPane = (p) => fs.writeFileSync(paneFile, JSON.stringify(p));
const failSource = (source, on) => {
  const f = path.join(shimState, `fail-${source}`);
  if (on) fs.writeFileSync(f, '1');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
};
const clearFaults = () => { failSource('recent-unwrapped', false); failSource('visible', false); };

const TYPE = 'task';
const KEY = 'KAN-255';
const bridge = new HerdrBridge();

/** A 23-row grid with three rows of content — the shape measured on this machine. */
const REAL_PANE = {
  rows: 23,
  content: 'bypass permissions on\n❯ echo hello-from-kan-255\n  hello-from-kan-255'
};

console.log('KAN-255 — a tail may not report a pane empty until it has asked every source');
console.log(`dist: ${distDir}`);

// ===========================================================================
rule('1. THE TRIGGER IS REAL IN THE MODEL — one source answers "" for a pane with text');
// ===========================================================================
// Before asserting anything about the fix, show the state it exists for: a live
// pane, plainly not empty, and a `recent-unwrapped` read of it with nothing in
// it. This is the ticket's own reproduction, on the geometry a real pane has.
setPane(REAL_PANE);
clearFaults();
{
  const ask = (source, n) => JSON.parse(spawnSync('herdr',
    ['agent', 'read', 'butchr-task-kan-255', '--source', source, '--format', 'text', '--lines', String(n)],
    { encoding: 'utf8' }).stdout).result.read.text;

  const recent8 = ask('recent-unwrapped', 8);
  const visible8 = ask('visible', 8);
  const recent21 = ask('recent-unwrapped', 21);

  check(recent8 === '', 'recent-unwrapped --lines 8 answers the EMPTY STRING', JSON.stringify(recent8));
  check(typeof recent8 === 'string',
    'and it is a STRING, so a `typeof text !== "string"` guard does not catch it — the whole defect');
  check(visible8.includes('hello-from-kan-255'),
    'visible, at the same moment and the same --lines, HAS the text', JSON.stringify(visible8));
  check(recent21.includes('hello-from-kan-255'),
    'the boundary is R - C: the same source answers at --lines 21 on a 23-row/3-row pane',
    JSON.stringify(recent21));
}

// ===========================================================================
rule('2. THE FIX — tailAgent asks the second source and returns the text');
// ===========================================================================
setPane(REAL_PANE);
clearFaults();
resetInvocations();
{
  const t = await bridge.tailAgent(KEY, TYPE, 8);
  check(t.success === true, 'success', JSON.stringify(t));
  check(typeof t.text === 'string' && t.text.includes('hello-from-kan-255'),
    'the pane text is returned rather than an empty string', JSON.stringify(t.text));
  check(t.source === 'visible', 'and it NAMES which source answered', `source=${t.source}`);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    'sourcesTried records that both were asked, in order', JSON.stringify(t.sourcesTried));
  check(JSON.stringify(sourcesAsked()) === JSON.stringify(['recent-unwrapped', 'visible']),
    'and herdr\'s own invocation log agrees — asserted on the CALLS, not on the return value',
    JSON.stringify(sourcesAsked()));
}

// ===========================================================================
rule('3. THE PRIMARY SOURCE STILL WINS, and the second is not asked when it answers');
// ===========================================================================
// The fallback must not become a substitution: `recent-unwrapped` reaches back
// through SCROLLBACK, which `visible` cannot see, so it keeps its place first.
setPane(REAL_PANE);
clearFaults();
resetInvocations();
{
  const t = await bridge.tailAgent(KEY, TYPE, 40);
  check(t.success === true && t.source === 'recent-unwrapped',
    'a --lines 40 read is answered by recent-unwrapped', `source=${t.source}`);
  check(JSON.stringify(sourcesAsked()) === JSON.stringify(['recent-unwrapped']),
    'visible was NOT asked — one read, not two, when the first one answers',
    JSON.stringify(sourcesAsked()));
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped']),
    'and sourcesTried says so rather than claiming a look that did not happen',
    JSON.stringify(t.sourcesTried));
}

// ===========================================================================
rule('4. A GENUINELY EMPTY PANE IS STILL REPORTED EMPTY — and is distinguishable');
// ===========================================================================
// This is the answer that must survive: an empty pane is a real fact about an
// agent, and a fix that could no longer say it would have traded one wrong
// answer for another.
setPane({ rows: 23, content: '' });
clearFaults();
resetInvocations();
{
  const t = await bridge.tailAgent(KEY, TYPE, 40);
  check(t.success === true, 'success — this is an answer about the pane, not a failure',
    JSON.stringify(t));
  check(t.text === '', 'text is empty', JSON.stringify(t.text));
  check(t.source === null,
    'source is NULL, which is the assertion "every source was asked and every one was silent"',
    `source=${JSON.stringify(t.source)}`);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    'and both are named, so the claim is auditable', JSON.stringify(t.sourcesTried));
  check(JSON.stringify(sourcesAsked()) === JSON.stringify(['recent-unwrapped', 'visible']),
    'herdr was really asked twice before this was said', JSON.stringify(sourcesAsked()));
}

// ===========================================================================
rule('5. A SOURCE THAT FAILS IS NOT A SOURCE THAT SAID EMPTY');
// ===========================================================================
// The trap the fallback can walk straight into. One refusal must make the read
// UNTRUSTED rather than the pane empty — otherwise the original defect is back,
// wearing the fallback's clothes.
{
  // 5a — the first answered empty, the second REFUSED. Whether the pane is
  // empty is now unknown, and saying "empty" here would be the defect.
  setPane(REAL_PANE);
  clearFaults();
  failSource('visible', true);
  const t = await bridge.tailAgent(KEY, TYPE, 8);
  check(t.success === false,
    '5a: recent-unwrapped empty + visible refusing → success FALSE, not an empty pane',
    JSON.stringify(t));
  check(t.text === undefined, '5a: and no text is offered to be mistaken for a reading',
    JSON.stringify(t.text));
  check(typeof t.error === 'string' && /UNKNOWN/.test(t.error),
    '5a: the error says the emptiness is UNKNOWN rather than confirmed', t.error);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    '5a: both are still named, so a reader can see which one refused',
    JSON.stringify(t.sourcesTried));
}
{
  // 5b — every source refused. No claim about the pane at all.
  setPane(REAL_PANE);
  clearFaults();
  failSource('recent-unwrapped', true);
  failSource('visible', true);
  const t = await bridge.tailAgent(KEY, TYPE, 40);
  check(t.success === false, '5b: every source refusing → success FALSE', JSON.stringify(t));
  check(typeof t.error === 'string' && /no source could be read/.test(t.error),
    '5b: and it says no source could be read', t.error);
}
{
  // 5c — THE OTHER DIRECTION, and it is the one an over-cautious fix breaks:
  // one source refusing must not lose a pane the other source can read.
  setPane(REAL_PANE);
  clearFaults();
  failSource('recent-unwrapped', true);
  const t = await bridge.tailAgent(KEY, TYPE, 40);
  check(t.success === true && typeof t.text === 'string' && t.text.includes('hello-from-kan-255'),
    '5c: recent-unwrapped refusing + visible answering → the TEXT, not a failure',
    JSON.stringify(t));
  check(t.source === 'visible', '5c: and the surviving source is named', `source=${t.source}`);
}
clearFaults();

// ===========================================================================
rule('6. THE `visible` FALLBACK IS HELD TO THE CALLER\'S N, WHICH IT IGNORES');
// ===========================================================================
// `visible` returns the screen and pays no attention to --lines, so without a
// trim a `--lines 2` request could be answered with a whole screen.
setPane({ rows: 23, content: 'row-one\nrow-two\nrow-three\nrow-four\nrow-five' });
clearFaults();
{
  const t = await bridge.tailAgent(KEY, TYPE, 2);
  check(t.source === 'visible', 'visible answered (--lines 2 lands in the blank rows)',
    `source=${t.source}`);
  check(t.text === 'row-four\nrow-five',
    'and its answer is trimmed to the 2 lines that were asked for, taken from the END',
    JSON.stringify(t.text));
}

// ===========================================================================
rule('7. THE COMPOSITION — a spurious empty read must not read as "no dialog"');
// ===========================================================================
// `superviseChannelStartup` decides whether an agent is wedged behind a
// full-screen dialog by matching on the pane. Its `readPane` is wired to
// `tailAgent` in daemon.ts, and the expression below is that wiring copied.
//
// MODELLED GEOMETRY, AND IT IS NOT REACHABLE ON A REAL PANE. daemon.ts asks for
// 140 lines, so an empty read needs R - C >= 140 — a 200-row grid here, where
// every herdr pane measured on this machine is 23 rows. What this section
// proves is that the composition is correct at the seam, NOT that anybody has
// seen it fail. The reachable version of the same defect is §2's geometry with
// a caller-chosen small N, which is `butchr_tail_agent`'s whole surface.
{
  const DIALOG = 'Loading development channels\n  I am using this for local development';
  setPane({ rows: 200, content: DIALOG });
  clearFaults();

  // `async` SINCE KAN-283, WHICH IS WHAT THIS SECTION IS FOR. `readPane` is
  // handed straight to `superviseChannelStartup` as its `world.readPane`, and
  // that interface is `() => Promise<string | null>` now because
  // `AgentRuntime.tailAgent` is. Copied from daemon.ts's world.readPane, awaits
  // and all — the point of this section is that the expression the daemon ships
  // is the expression under test.
  const readPane = async () => {
    const tail = await bridge.tailAgent(KEY, TYPE, 140);
    return tail.success && typeof tail.text === 'string' ? tail.text : null;
  };

  const seen = await readPane();
  check(seen !== null && /Loading development channels/.test(seen),
    'the dialog is SEEN through the daemon\'s own readPane expression',
    JSON.stringify(seen));

  let enters = 0;
  let now = 0;
  const result = await superviseChannelStartup({
    address: { type: TYPE, key: KEY },
    spawnedAt: 0,
    deadlineMs: 60_000,
    world: {
      readPane,
      pressEnter: () => {
        enters += 1;
        // The Enter clears the dialog and the session comes up at its prompt.
        setPane({ rows: 200, content: 'bypass permissions on\n❯ ' });
      },
      now: () => (now += 1000),
      sleep: async () => {},
      freshConnection: () => (enters > 0 ? { id: 'conn-kan255' } : null),
      log: () => {}
    }
  });

  check(enters >= 1, 'the watcher answered the dialog rather than waiting out a "blank" pane',
    `enters=${enters}`);
  check(result.outcome === 'ready', 'and the agent reached ready', JSON.stringify(result.outcome));

  // THE SAME WORLD WITH THE PANE UNREADABLE. `readPane` must answer null, and
  // the run must land on `unreadable-pane` — which counts pane FAILURES, and
  // could never fire while a failed read looked like an empty pane.
  setPane({ rows: 200, content: DIALOG });
  failSource('recent-unwrapped', true);
  failSource('visible', true);
  let now2 = 0;
  const blind = await superviseChannelStartup({
    address: { type: TYPE, key: KEY },
    spawnedAt: 0,
    deadlineMs: 10_000,
    world: {
      readPane,
      pressEnter: () => { throw new Error('must not press Enter at a pane nobody could read'); },
      now: () => (now2 += 1000),
      sleep: async () => {},
      freshConnection: () => null,
      log: () => {}
    }
  });
  check(blind.outcome === 'unreadable-pane',
    'a pane no source could read reports `unreadable-pane`, not "no dialog was raised"',
    JSON.stringify(blind.outcome));
  clearFaults();
}

// ===========================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`${checks} checks, ${failures} failed`);
console.log(failures === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
fs.rmSync(scratchRoot, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
