// KAN-459: a `pty_input` / `pty_resize` refusal reaches something, and reading
// it costs the keystroke path no round trip.
//
// WHAT FAILURE THIS WOULD CATCH: a pty write's ack being discarded again — the
// state `writePty` was in until KAN-459, where `void this.link.request(…)
// .catch(() => {})` threw away an answer CrabCast was already sending. A
// session CrabCast had disowned went on accepting keystrokes at this interface
// forever, and nothing anywhere could count or name a single refused write.
// Section 3 reintroduces exactly that line into a copy of the build and
// requires this script to go red on it.
//
// It also catches the opposite regression, which is the one a careless fix
// produces: section 2's CONTROL fails if `writePty` starts awaiting the ack, so
// a fix that made the sidepanel terminal wait a round trip per keystroke cannot
// pass here either.
//
// ## Sections, and which kind each is — READ THE SECTION, NOT THE EXIT CODE
//
// This script is one of the mixed kind. After a FAILED BUILD its overall exit
// code is a blend, and the two halves are testing different commits:
//
//   §1  STATIC   reads `daemon/src/*.ts` as text. Unaffected by a failed build —
//                it read what you wrote. `--static-only` runs this alone.
//   §2  DIST     imports `daemon/dist/crabcast-runtime.js`. A failed build means
//                this tested the PREVIOUS build and its verdict is about code
//                you did not write.
//   §3  DIST     the red drive, opt-in via `--restore-void-catch`.
//
// ## The fake CrabCast, and where its refusal shape came from
//
// The refusal frame this script's fake serves is not invented and is not read
// off CrabCast's source (invariant 10). It is copied from a capture taken off
// the LIVE socket by `probe-crabcast-pty-refusal.mjs` at CrabCast
// `9d4d999cbac6bb94eb5ed25f58c24a7bf7ebf747`, contractVersion 8 — `success:
// false`, `refusal: "unknown_session"`, plus a prose `error`. If a future peer
// refuses in a different shape, this script keeps passing and would be wrong to:
// re-run the probe and update the constant below.
//
// ## What this script does NOT cover, and who does
//
// **It writes the record it then asserts on.** The fake is this script's own
// creation, so a green here says the adapter reads a refusal *that this script
// sent*, never that a real CrabCast refusal arrives in this shape. The leg that
// tests the input actually arriving is `probe-crabcast-pty-refusal.mjs` against
// a live daemon, whose output is pasted in the KAN-459 PR body. Neither covers
// the third thing: that anybody LOOKS at the resulting log line or counter.
// Nothing covers that today — `CrabCastRuntime.describe()` has no production
// caller at all — and KAN-459's ticket comment records it rather than leaving a
// reader to infer a coverage that does not exist.
//
// ⚠ AND THE LOG SURFACE IS INERT ON A STOCK INSTALL. `BUTCHR_AGENT_RUNTIME` is
// unset by default, so this runtime does not run and no pty write reaches it.
// A green here is a statement about the adapter, NOT about any refusal having
// been observed in production — there cannot have been one. Do not read this
// script as evidence that the fleet is refusal-free.
//
// CI-RUNNABLE: yes — imports the built daemon modules and serves its own
// CrabCast over a unix socket in a temp dir; node builtins only, no live
// daemon, no herdr, no credential, no network, no terminal.
//
// Usage: node daemon/scripts/verify-pty-write-refusal-is-read.mjs [--verbose]
//        --static-only          §1 only; safe after a failed build
//        --restore-void-catch   §3: put the discarded-ack line back and require red

import net from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const staticOnly = process.argv.includes('--static-only');
const restoreVoidCatch = process.argv.includes('--restore-void-catch');

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(72));
  say(title);
  say('─'.repeat(72));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) say(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => new URL(`file://${p}`).href;

/** Copied from the live capture — see the header. */
const LIVE_REFUSAL_CODE = 'unknown_session';
const LIVE_REFUSAL_ERROR =
  "pty_input names session 'X', which this daemon does not have. A PTY session id is only " +
  'valid for the daemon process that issued it, and this one is not among them.';

// ── §1 STATIC — the comment matches the code ───────────────────────────────
rule('1. STATIC (reads src as text — valid after a failed build)');

const runtimeSrc = readFileSync(path.join(daemonDir, 'src', 'crabcast-runtime.ts'), 'utf8');
const linkSrc = readFileSync(path.join(daemonDir, 'src', 'crabcast-link.ts'), 'utf8');

check(
  !/with no `id`/.test(runtimeSrc),
  'the retired clause "with no `id`" is gone from crabcast-runtime.ts',
  'that clause was false: `request()` has no id-less path, so it described a mechanism that does not exist'
);

// The premise the retired clause got backwards. Asserted rather than trusted,
// because the correction that replaced it CLAIMS this — a comment saying "an id
// is attached to every frame" is exactly as false as the one it replaced if the
// link ever grows a branch here.
const requestBody = linkSrc.slice(linkSrc.indexOf('request(body: Record<string, unknown>)'));
const requestHead = requestBody.slice(0, requestBody.indexOf('return new Promise'));
check(
  /const id = `butchr-\$\{process\.pid\}-\$\{this\.nextId\+\+\}`;/.test(requestHead) &&
    /const frame = \{ \.\.\.body, id \};/.test(requestHead),
  'CrabCastLink.request attaches an id to every frame — the correction`s premise holds',
  requestHead.trim().split('\n').slice(0, 4).join('\n')
);
// From the id to the frame there must be no branch. Sliced from `const id` on
// purpose: the `if (!this.connected)` guard ABOVE it is a legitimate early
// return that sends nothing at all, and folding it in here is what made the
// first draft of this check fail against correct code.
const idToFrame = requestHead.slice(requestHead.indexOf('const id = '));
check(
  !/\bif\b|\?/.test(idToFrame),
  'and it does so unconditionally — no branch between the id and the frame',
  `a branch here would mean an id-less path exists and the new comment is now the false one\n${idToFrame.trim()}`
);

const writePtyBlock = runtimeSrc.slice(
  runtimeSrc.indexOf('writePty(sessionId: string | undefined, data: string): boolean {'),
  runtimeSrc.indexOf('private observePtyWrite')
);
check(
  writePtyBlock.length > 0 && !/\.catch\(\(\) => \{\}\)/.test(writePtyBlock),
  'neither writePty nor resizePty discards its answer with an empty catch',
  writePtyBlock.slice(0, 300)
);
check(
  /observePtyWrite\(\s*'pty_input'/.test(writePtyBlock) &&
    /observePtyWrite\(\s*'pty_resize'/.test(writePtyBlock),
  'both write verbs route their answer through observePtyWrite',
  'a verb that skips it is unread again, which is the whole defect'
);
// The correction has to state the mechanism, not merely delete the falsehood
// (KAN-459 AC1). Checked by requiring the two facts a reader needs.
check(
  /attaches an `id` to every frame/.test(runtimeSrc) && /does not \*choose\* to spend/.test(runtimeSrc),
  'the replacement docblock states what the mechanism does — id always sent, ack already on the wire',
  'AC1: the correction must say what happens, not just stop saying the wrong thing'
);

if (staticOnly) {
  rule('--static-only: sections 2 and 3 skipped');
  say(failures ? `\n${failures} static check(s) failed.` : '\nStatic checks pass.');
  process.exit(failures ? 1 : 0);
}

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'crabcast-runtime.js'))) {
  console.error('daemon/dist is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan459-pty-refusal-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

let distUnderTest = dist;

if (restoreVoidCatch) {
  // THE RED DRIVE, built in rather than hand-demonstrated at review time.
  // Patch a COPY of the build back to the pre-KAN-459 line and require the
  // sections below to fail on it.
  // The damage is done to a COPY. A red run cannot leave a broken build behind,
  // which matters here more than usual: this repo has live agents working in
  // sibling worktrees off the same shared clone.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  // The copy still has to resolve `node-pty`, which `herdr.js` imports. Node
  // walks up from the importing file, so one symlink beside the copy is enough
  // and is cheaper than copying 100+ MB of node_modules. Without it the run
  // dies with ERR_MODULE_NOT_FOUND and exits non-zero — which looks exactly
  // like the red this flag is asking for, while proving nothing.
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const target = path.join(distUnderTest, 'crabcast-runtime.js');
  const built = readFileSync(target, 'utf8');
  const patched = built.replace(
    /this\.observePtyWrite\(\s*'pty_input',[\s\S]*?\);/,
    "void this.link.request({ action: 'pty_input', sessionId: remote, data }).catch(() => {});"
  );
  if (patched === built) {
    console.error('--restore-void-catch: could not find the observePtyWrite call to patch out.');
    console.error('The build has moved; this flag is testing nothing. Fix the patch, do not ignore this.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say('');
  say('--restore-void-catch: patched a copy of the build back to the discarded-ack line.');
}

const { CrabCastRuntime } = await import(fileUrl(path.join(distUnderTest, 'crabcast-runtime.js')));
const { CrabCastLink, CRABCAST_PIN, CRABCAST_CONTRACT_VERSION } = await import(
  fileUrl(path.join(distUnderTest, 'crabcast-link.js'))
);

// ── the fake CrabCast ──────────────────────────────────────────────────────
//
// Deliberately thin, and its pty_input answer is switchable so one runtime can
// be shown an accepted write and a refused one in the same run.
let ptyInputMode = 'accept'; // 'accept' | 'refuse'
let ptyReplyDelayMs = 0;
const ptyInputSeen = [];

const socketPath = path.join(scratch, 'crabcast.sock');
const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (body) => socket.write(`${JSON.stringify({ ...body, id: req.id })}\n`);
      if (req.action === 'daemon_status') {
        reply({
          action: 'daemon_status_response',
          success: true,
          build: { commit: CRABCAST_PIN },
          contractVersion: CRABCAST_CONTRACT_VERSION
        });
      } else if (req.action === 'list_agents') {
        reply({ action: 'list_agents_response', success: true, agents: [], foreignPanes: [] });
      } else if (req.action === 'configure_agent') {
        reply({ action: 'configure_response', success: true });
      } else if (req.action === 'activate_agent') {
        reply({
          action: 'activate_response',
          success: true,
          sessionId: `crabcast-${Math.abs(req.path.length)}`
        });
      } else if (req.action === 'pty_init') {
        reply({ action: 'pty_init_response', success: true, buffer: '' });
      } else if (req.action === 'pty_input' || req.action === 'pty_resize') {
        ptyInputSeen.push({ action: req.action, hasId: typeof req.id === 'string' });
        const answer =
          ptyInputMode === 'refuse'
            ? {
                action: `${req.action}_response`,
                success: false,
                sessionId: req.sessionId,
                refusal: LIVE_REFUSAL_CODE,
                error: LIVE_REFUSAL_ERROR
              }
            : { action: `${req.action}_response`, success: true, sessionId: req.sessionId };
        if (ptyReplyDelayMs > 0) setTimeout(() => reply(answer), ptyReplyDelayMs);
        else reply(answer);
      } else if (req.action === 'deactivate_agent') {
        reply({ action: 'deactivate_response', success: true });
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => server.listen(socketPath, resolve));

const logLines = [];
const link = new CrabCastLink({ socketPath, log: () => {}, reconnectDelayMs: 50 });
const runtime = new CrabCastRuntime({
  link,
  log: (m) => logLines.push(m),
  censusIntervalMs: 10_000
});
await sleep(400);

const session = runtime.spawnSession('task', 'KAN-459-probe', undefined, 'kan-459 pty refusal', 'shell');
for (let i = 0; i < 60 && session.status === 'initializing'; i++) await sleep(50);
if (!session.sessionId || session.status === 'initializing') {
  console.error(`setup: the fake never brought a session up (status ${session.status}).`);
  process.exit(2);
}
const sid = session.sessionId;

// ── §2 DIST — the refusal is read, and the accepted write is not slowed ────
rule('2. DIST (imports the build — a failed build makes this a verdict about the previous one)');

// ---- CONTROL A: an accepted write still succeeds, and does NOT wait --------
ptyInputMode = 'accept';
ptyReplyDelayMs = 300; // the ack is deliberately slow; a fix that awaits will show here
const t0 = process.hrtime.bigint();
const acceptedReturn = runtime.writePty(sid, 'hello');
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

check(acceptedReturn === true, 'CONTROL: an accepted write still returns true', `got ${acceptedReturn}`);
check(
  elapsedMs < 50,
  `CONTROL: writePty returned in ${elapsedMs.toFixed(1)}ms against a 300ms ack — no per-keystroke round trip`,
  'AC3: a fix that awaits the ack makes the terminal laggy and is the wrong trade. This is that gate.'
);

await sleep(500); // let the slow ack land
const afterAccept = runtime.describe().ptyWrites;
check(
  afterAccept.refused === 0 && afterAccept.undelivered === 0,
  'CONTROL: an accepted write records nothing — the counters name only failure',
  JSON.stringify(afterAccept)
);
check(
  logLines.filter((l) => l.includes('pty_input')).length === 0,
  'CONTROL: and it logs nothing',
  logLines.join('\n')
);

// ---- the defect this ticket is about --------------------------------------
ptyReplyDelayMs = 0;
ptyInputMode = 'refuse';
check(runtime.writePty(sid, 'a') === true, 'a refused write still returns true — the boolean is a local lookup');
await sleep(200);

const afterRefusal = runtime.describe().ptyWrites;
check(
  afterRefusal.refused === 1,
  'THE DEFECT: the refusal is counted — it was discarded by a `void` before KAN-459',
  `ptyWrites = ${JSON.stringify(afterRefusal)}`
);
check(
  afterRefusal.last?.refusal === LIVE_REFUSAL_CODE,
  `the refusal CODE survives to the report (${LIVE_REFUSAL_CODE})`,
  JSON.stringify(afterRefusal.last)
);
check(
  afterRefusal.last?.action === 'pty_input' && afterRefusal.last?.sessionId === sid,
  'and it names the verb and the Butchr session id an operator can look up',
  JSON.stringify(afterRefusal.last)
);
check(
  afterRefusal.undelivered === 0,
  'and it is counted as `refused`, NOT `undelivered` — we asked and it said no',
  'collapsing those two is what CrabCastLink.request`s docblock exists to prevent'
);

const firstLogs = logLines.filter((l) => l.includes('pty_input') && l.includes('refused'));
check(firstLogs.length === 1, 'the surface that works today: exactly one daemon.log line', logLines.join('\n'));
check(
  firstLogs[0]?.includes(LIVE_REFUSAL_CODE) && firstLogs[0]?.includes(sid),
  'and it carries the refusal code and the session id',
  firstLogs[0] ?? '(none)'
);

// ---- the log is first-of-kind; the counter is the authority ----------------
for (let i = 0; i < 5; i++) runtime.writePty(sid, 'b');
await sleep(200);
const afterStorm = runtime.describe().ptyWrites;
check(
  afterStorm.refused === 6,
  'five more refusals are all counted (6 total) — the counter does not suppress',
  JSON.stringify(afterStorm)
);
check(
  logLines.filter((l) => l.includes('pty_input') && l.includes('refused')).length === 1,
  'and they log nothing further — a held-down key cannot storm the log',
  'a line per refused keystroke would be a log storm keyed to typing speed'
);

// ---- resize is the same shape and must not have been forgotten ------------
check(runtime.resizePty(sid, 80, 24) === true, 'resizePty still returns true');
await sleep(200);
const afterResize = runtime.describe().ptyWrites;
check(
  afterResize.refused === 7 && afterResize.last?.action === 'pty_resize',
  'a refused resize is read too — both write verbs, not just the one in the ticket title',
  JSON.stringify(afterResize.last)
);

// ---- `undelivered` is a different claim and is reachable -------------------
const beforeDrop = runtime.describe().ptyWrites.undelivered;
link.close();
await sleep(100);
runtime.writePty(sid, 'c');
await sleep(200);
const afterDrop = runtime.describe().ptyWrites;
check(
  afterDrop.undelivered === beforeDrop + 1,
  'with the link down the same write records `undelivered` — "we could not ask"',
  JSON.stringify(afterDrop)
);
check(
  afterDrop.last?.outcome === 'undelivered' && afterDrop.last?.refusal === null,
  'and it carries no refusal code, because no peer refused anything',
  JSON.stringify(afterDrop.last)
);

// ---- the premise, observed on the wire rather than asserted ---------------
check(
  ptyInputSeen.length > 0 && ptyInputSeen.every((f) => f.hasId),
  `every pty frame the adapter sent carried an id (${ptyInputSeen.length} frames)`,
  'this is the retired comment`s premise, measured: there is no id-less path'
);

// ── §3 the red drive ───────────────────────────────────────────────────────
runtime.dispose();
server.close();

rule('verdict');
if (restoreVoidCatch) {
  if (failures > 0) {
    say(`--restore-void-catch: ${failures} check(s) FAILED, which is the point.`);
    say('The discarded-ack line was put back and this script caught it. That is the red drive.');
    say('Exiting 0 because the requested failure is what happened.');
    process.exit(0);
  }
  say('--restore-void-catch was requested and everything PASSED.');
  say('That means the patch did not take, or these assertions do not watch what they claim to.');
  process.exit(1);
}

if (failures) {
  say(`${failures} check(s) failed.`);
} else {
  say('OK — a pty write refusal is counted, named and logged; an accepted write keeps its');
  say('synchronous return and gains no round trip; and `refused` stays distinct from');
  say('`undelivered`. Nothing in production reads the report — see the header.');
}
process.exit(failures ? 1 : 0);
