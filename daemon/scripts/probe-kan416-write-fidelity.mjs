// KAN-416 PROBE 3 — does `writePty` deliver the WHOLE line?
//
// Probe 1 + the screen reconstruction found this, and it is upstream of
// everything the ticket is about:
//
//     $ (sleep 5; echo KANGAP$SUF; echo
//     > echo KANAL$W
//     >
//
// The typed line arrived TRUNCATED mid-word. Bash was left holding an
// unbalanced `(`, went to its continuation prompt, and from that moment
// echoed every later keystroke and executed none of them. The background job
// never ran, so the marker never printed — and the live proof then reports
// "the re-subscription snapshot did not carry what the pane printed", about
// output that was never produced.
//
// This probe removes the reconnect entirely. No relay, no drop, no resync. It
// writes one self-checking line at a time and asks only whether the whole line
// arrived. Nothing here can be explained by the mirror.

import fs from 'fs';
import net from 'net';
import path from 'path';

import { createAgentRuntime } from '../dist/runtime-switch.js';
import { workspaceDirFor } from '../dist/herdr.js';

const LINES = Number(process.env.KAN416_LINES ?? 40);
const GAP_MS = Number(process.env.KAN416_GAP_MS ?? 1_200);
const PAD = Number(process.env.KAN416_PAD ?? 30);
const verbose = process.argv.includes('--verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Replay the stream onto a screen — see probe 1 for why a stream search is not this. */
function renderScreen(raw, rows = 24, cols = 80) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 0;
  let c = 0;
  const CSI = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/y;
  const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === '\x1b') {
      OSC.lastIndex = i;
      if (OSC.exec(raw)) {
        i = OSC.lastIndex;
        continue;
      }
      CSI.lastIndex = i;
      const m = CSI.exec(raw);
      if (m) {
        const p = m[1].split(';');
        if (m[3] === 'H' || m[3] === 'f') {
          r = Math.max(0, (parseInt(p[0] || '1', 10) || 1) - 1);
          c = Math.max(0, (parseInt(p[1] || '1', 10) || 1) - 1);
        } else if (m[3] === 'J' && (p[0] === '2' || p[0] === '')) {
          for (const row of grid) row.fill(' ');
        } else if (m[3] === 'K') {
          if (r < rows) for (let x = c; x < cols; x++) grid[r][x] = ' ';
        }
        i = CSI.lastIndex;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '\n') {
      r = Math.min(rows - 1, r + 1);
      i++;
      continue;
    }
    if (ch === '\r') {
      c = 0;
      i++;
      continue;
    }
    if (ch === '\x07' || ch === '\b') {
      i++;
      continue;
    }
    if (r < rows && c < cols) grid[r][c] = ch;
    c++;
    i++;
  }
  // Joined at the pane's real width and WITHOUT trimming: a command line longer
  // than 80 columns wraps, so it is contiguous only when the rows are rejoined
  // at exactly that width. Trimming trailing spaces here would eat a space that
  // happens to land on the wrap boundary and report an intact line as short.
  return grid.map((row) => row.join('')).join('');
}

const paneLetters = (raw) =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');

async function until(fn, budgetMs, stepMs = 200) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

const realSocket = process.env.BUTCHR_CRABCAST_SOCKET;
if (!realSocket || !fs.existsSync(realSocket)) {
  console.error('setup: BUTCHR_CRABCAST_SOCKET missing. Nothing attempted.');
  process.exit(1);
}

const TYPE = 'task';
const KEY = process.env.KAN416_PROBE_KEY ?? 'kan-416-fidelity-probe';
const workDir = workspaceDirFor(TYPE, KEY);

async function cleanup() {
  const { execFileSync } = await import('child_process');
  const run = (args) =>
    execFileSync('crabcast', args, { stdio: 'pipe', timeout: 20_000, encoding: 'utf8' });
  try {
    run(['deactivate', workDir]);
    console.log(`   crabcast deactivate: stood the probe down at ${workDir}`);
  } catch (err) {
    if (verbose) console.log(`   deactivate declined: ${String(err).split('\n')[0]}`);
  }
  try {
    run(['forget', workDir]);
    console.log(`   crabcast forget returned OK — no record remains for ${workDir}`);
  } catch {
    console.log(`   COULD NOT forget ${workDir} — sweep by hand, two commands, not chained.`);
  }
  try {
    if (workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`) && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`   removed probe workspace ${workDir}`);
    }
  } catch {
    /* reported above */
  }
}

let sweeping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (sweeping) return;
    sweeping = true;
    console.log(`\n${sig} — sweeping before exit.`);
    try {
      await cleanup();
    } finally {
      process.exit(130);
    }
  });
}

function askRealPeer(body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(realSocket);
    let buf = '';
    const id = `kan416-fid-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer to ${body.action} in 20s`));
    }, 20_000);
    socket.on('connect', () => socket.write(JSON.stringify({ ...body, id }) + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id === id) {
          clearTimeout(timer);
          setTimeout(() => socket.destroy(), 0);
          resolve(frame);
          return;
        }
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
process.env.BUTCHR_CRABCAST_SOCKET = realSocket;

const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });
if (report.mode !== 'crabcast') {
  console.error(`setup: runtime is ${report.mode}.`);
  process.exit(1);
}
await until(() => runtime.describe().link.connected, 8_000);

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
const configured = await askRealPeer({
  action: 'configure_agent',
  path: workDir,
  priority: 1,
  launcher: 'shell',
  prompt: 'KAN-416 write-fidelity probe.'
});
if (configured.success !== true) {
  console.error(`setup: configure_agent refused: ${configured.error}`);
  runtime.dispose();
  process.exit(1);
}
const activated = await askRealPeer({ action: 'activate_agent', path: workDir, override: true });
if (activated.success !== true) {
  console.error(`setup: activate_agent refused even with override: ${activated.error}`);
  runtime.dispose();
  await cleanup();
  process.exit(1);
}
console.log(`   setup: CrabCast started it as session ${activated.sessionId}`);

const session = await until(() => runtime.listActiveSessions().find((s) => s.key === KEY), 30_000);
if (!session) {
  console.error('setup: never adopted from the census.');
  runtime.dispose();
  await cleanup();
  process.exit(1);
}
runtime.registerDataListener(session.sessionId, () => {});
const filled = await until(
  () => (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length > 0,
  20_000
);
if (filled !== true) {
  console.error('setup: the mirror never filled.');
  runtime.dispose();
  await cleanup();
  process.exit(1);
}

const cr = String.fromCharCode(13);
const buf = () => runtime.getSession(session.sessionId)?.ptyBuffer ?? '';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const name = (i) => `KANFID${LETTERS[i % 26]}${LETTERS[Math.floor(i / 26) % 26]}`;

// ⚠ THE PAYLOAD MUST BE UNIQUE END TO END, AND THE FIRST VERSION OF THIS PROBE
// WAS WRONG ABOUT THAT. It padded the marker with `X`.repeat(30) and
// `Z`.repeat(30) on every line, and reported 25 of 40 lines truncated. They
// were not. herdr repaints the pane cell by cell and **only emits the cells
// that changed**, so when consecutive lines share their padding the padding is
// never re-painted and the joined string never appears contiguously in the
// byte stream — the search fails while the screen is perfectly correct. A
// payload whose every character differs from the last line's forces a full
// repaint of the row, which is the only condition under which a stream search
// means what it looks like it means.
const pad = (n, seed) => {
  let s = '';
  for (let i = 0; i < n; i++) s += LETTERS[(seed * 7 + i * 3 + Math.floor(i / 26)) % 26];
  return s;
};

let truncations = 0;
const results = [];
console.log(`\n line  intact  waitedMs   note`);
for (let i = 0; i < LINES; i++) {
  const N = name(i);
  // ⚠ THE EXACT LINE verify-crabcast-reconnect-live.mjs TYPES, with `sleep 0`
  // so the job prints at once and one trial costs a second rather than six.
  // Its length is what is under test, so it is not shortened.
  const LINE = `(sleep 0; echo KANGAP$SUF; echo KANGAP$SUF) &`;
  // KAN416_DIRECT sends the same bytes as a raw `pty_input` frame on a
  // connection of this script's own, bypassing `CrabCastRuntime.writePty` and
  // `CrabCastLink` entirely. If the truncation survives that, our link layer is
  // not where the bytes go missing.
  const type = async (data) => {
    if (process.env.KAN416_DIRECT) {
      await askRealPeer({ action: 'pty_input', sessionId: activated.sessionId, data });
    } else {
      runtime.writePty(session.sessionId, data);
    }
  };
  await type(`SUF=MARKER${N}${cr}`);
  await sleep(400);
  await type(`${LINE}${cr}`);
  const t0 = Date.now();
  // Ground truth is the SCREEN: whether the whole line reached bash, read off
  // what the pane is displaying rather than off the byte stream.
  const intact = await until(() => renderScreen(buf()).includes(LINE), 6_000);
  const waited = Date.now() - t0;
  const screen = renderScreen(buf());
  // How much of it did arrive? The longest prefix of the line on the screen.
  let got = 0;
  for (let k = LINE.length; k > 0; k--) {
    if (screen.includes(LINE.slice(0, k))) {
      got = k;
      break;
    }
  }
  results.push({ line: i + 1, name: N, intact: intact === true, waitedMs: waited, delivered: got, sent: LINE.length });
  if (intact !== true) {
    truncations++;
    console.log(
      ` ${String(i + 1).padStart(4)}   FALSE  ${String(waited).padStart(8)}   ` +
        `delivered ${got}/${LINE.length} bytes: ${JSON.stringify(LINE.slice(0, got))}`
    );
    if (process.env.KAN416_DUMP_DIR) {
      const d = process.env.KAN416_DUMP_DIR;
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `fidelity-line${i + 1}.raw`), buf());
    }
    // Reset the line editor so one truncation does not poison every later
    // line: Ctrl-C abandons whatever partial command is pending.
    runtime.writePty(session.sessionId, String.fromCharCode(3));
    await sleep(600);
    runtime.writePty(session.sessionId, cr);
    await sleep(600);
  } else if (verbose) {
    console.log(` ${String(i + 1).padStart(4)}    true  ${String(waited).padStart(8)}`);
  }
  await sleep(GAP_MS);
}

console.log(`\n${'═'.repeat(72)}`);
console.log(`WRITE FIDELITY: ${LINES - truncations}/${LINES} lines arrived whole; ${truncations} did not.`);
console.log(`${'═'.repeat(72)}\n`);

if (process.env.KAN416_ROWS_OUT) {
  fs.writeFileSync(process.env.KAN416_ROWS_OUT, JSON.stringify(results, null, 2));
}

runtime.dispose();
await cleanup();
process.exit(0);
