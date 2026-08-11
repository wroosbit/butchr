// LIVE proof for KAN-156: a real `butchr_send_to_agent` lands on a REAL Claude
// Code agent that is REALLY in the middle of a shell command, and the command
// dies. Not a claim about Ctrl+C — a killed tool call, read back off the pane.
//
// WHAT FAILURE THIS WOULD CATCH: the `butchr_send_to_agent` tool description
// telling callers the send "interrupts any partially typed input" while the
// mechanism cancels the recipient's whole turn. A caller who believes the
// smaller claim sends to a working agent expecting to queue a note and
// destroys a tool call instead — which is how an epic agent came to report a
// rejection the human never made. This script is the measurement that decides
// which of the two sentences is true, and it fails if the small one is.
//
// CI-RUNNABLE: no — needs a real daemon and a live agent with a tool call
// actually in flight — the interrupt is the thing under test.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS AND IS NOT
// ---------------------------------------------------------------------------
//
// It is a **demonstration of a mechanism**, not a regression guard on a
// sentence. Nothing here reads `mcp.ts`, so this stays green if someone
// rewrites the description back to the understatement tomorrow. NOT COVERED,
// and covered by nobody today: that the shipped wording still matches what
// this script observes. The `grep -n` in the KAN-156 PR is a reading of one
// moment, and a reviewer re-reading the description is the only thing standing
// between it and drift. Said here rather than left to be inferred.
//
// It also does not prove the interrupt is *unwanted*. Steering a working agent
// is often worth exactly this cost. What it establishes is the price, so the
// caller is deciding rather than assuming.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT A CI CHECK
// ---------------------------------------------------------------------------
//
// It starts a real Claude Code agent: a real herdr, a real terminal, a real
// Anthropic session, and it costs tokens and about two minutes. Run by hand and
// pasted into the PR — the same standing as verify-message-provenance-live.mjs
// and verify-fleet-switch-live.mjs.
//
// ---------------------------------------------------------------------------
// SHOWING THE FAILURE — the red run, because a proof that only passes is not one
// ---------------------------------------------------------------------------
//
// The assertion below is "the recipient's running command stopped, and it
// stopped because of the send". The way to watch that go red is to take the
// send's interrupt away and change nothing else:
//
//     # green — the branch
//     cd daemon && npm run build
//     node scripts/verify-send-interrupts-inflight-work.mjs ./dist
//
//     # red — the same build with the leading Ctrl+C removed from the send path
//     rm -rf /tmp/dist-no-interrupt && cp -r dist /tmp/dist-no-interrupt
//     sed -i "s/this.runHerdr(\[.pane., .send-keys., paneId, .C-c.\]);//" \
//       /tmp/dist-no-interrupt/herdr.js
//     node scripts/verify-send-interrupts-inflight-work.mjs /tmp/dist-no-interrupt
//
// On the red build the message is still typed, and the recipient's command runs
// on undisturbed: PANE-2 and CAUSE fail and the script exits 1. That is the
// whole finding in one diff — the destruction is the Ctrl+C, not the message.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL, WHAT IS SUBSTITUTED
// ---------------------------------------------------------------------------
//
// Real: the daemon (from the dist you name), the MCP server process, the
// socket, herdr, the pane, the Claude Code process in it, its Bash tool call,
// and every tail. **The send path is real end to end** — a real MCP tool call,
// through the real router, through the real `HerdrBridge.sendToAgent`, into a
// real pane. That path is the entire subject.
//
// Substituted, and exactly three things:
//
//   1. **$HOME**, so this daemon has its own socket and its own workspace root
//      and cannot touch the live fleet — the whole point, since the thing being
//      demonstrated is destructive to whoever receives it. `~/.claude`,
//      `~/.claude.json` and `~/.local/bin` are symlinked in so the probe agent
//      authenticates; `integrations.json` and the credential files are copied,
//      not symlinked, so this run cannot write to the real ones.
//   2. **The probe's brief.** The daemon resolves prompts against the repo root
//      above its own `dist`, so the dist under test is staged into a scratch
//      repo whose `prompts/task.md` says: run this one command, do nothing
//      else. The real `prompts/task.md` sends an agent to Jira, and the first
//      attempt at this script died there — the probe read KAN-156, found a live
//      agent already on it, and stopped at a "what should I do?" dialog instead
//      of running anything. A probe that argues with its brief measures the
//      brief.
//   3. **One key in the real `~/.claude.json`**, trusting the probe's scratch
//      workspace, removed again at exit. herdr spawns panes from its own
//      environment rather than this daemon's, so the folder-trust dialog is
//      read from the real file no matter how isolated the daemon is. This is
//      the one thing here that touches real user state; it is additive, it
//      names a /tmp path, and the exit handler takes it back out.
//
// What the substitutions cost is worth stating: the recipient is a Claude Code
// agent doing a Bash tool call, which is what every fleet agent is doing most of
// the time, but it is not carrying a real workload. Nothing here measures how
// much work a real interrupt destroys — only that it destroys the call.
//
// **There is no setup send.** The probe enters its command off its own brief, so
// the in-flight state the measurement needs is not something this script typed
// into it — the ONE send in this script is the one under measurement. That is
// deliberate: a proof that supplies its own input has not tested that the input
// arrives, and the input here is "a recipient that is genuinely busy".
//
// Usage: node scripts/verify-send-interrupts-inflight-work.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const sourceDist = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'dist'));
const realHome = os.homedir();

if (!fs.existsSync(path.join(sourceDist, 'daemon.js'))) {
  // A setup guard, not a verdict: "there is no build to test" is a reason this
  // script cannot run, not a finding about what a send does.
  console.error(`${sourceDist}/daemon.js is missing — run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

// --- verdicts ---------------------------------------------------------------
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECIPIENT = { type: 'task', key: 'KAN-156-PROBE' };
const SENDER = { type: 'story', key: 'KAN-156-SENDER' };
const SENDER_TAG = `[from ${SENDER.type}/${SENDER.key}]`;

/**
 * The command the probe is to sit inside: long enough to be unmistakably
 * mid-flight, short of the Bash tool's default two-minute timeout.
 *
 * A file rather than an inline `sleep`, for two measured reasons. Claude Code's
 * own harness **blocks a bare foreground `sleep`** and the probe dutifully
 * routed around it into a background shell — leaving nothing in the foreground
 * to kill, which the third attempt at this script spent its run discovering.
 * And a short filename renders whole in the pane's tool line, where a long
 * inline command is truncated and cannot be matched on.
 */
const WAIT_SECONDS = 90;
const WAIT_SCRIPT = 'probe-wait.py';
const WAIT_CMD = `python3 ${WAIT_SCRIPT}`;

/**
 * Whether a turn is live on the recipient's pane.
 *
 * **This, and not the word "interrupted", is what the verdicts read — because
 * three runs of this script produced three different renderings of the same
 * kill:**
 *
 *   1. `⎿ Interrupted · What should Claude do instead?` — the obvious one.
 *   2. No such marker; the agent instead said *"the python3 probe-wait.py call
 *      was rejected, so nothing ran"*, and then *"the command you just
 *      declined"* — to a human who had declined nothing. That sentence is the
 *      defect this ticket is about, printed on the recipient's own screen.
 *   3. **Nothing whatsoever.** The tool line went from `running 1 shell
 *      command` to `ran 1 shell command`, the command was gone, and no word on
 *      the pane said anything had happened to it.
 *
 * A word-matching proof would have called run 3 a pass for the *old*
 * description — an interrupt so quiet it left no trace is still an interrupt,
 * and it is the most dangerous of the three. What is invariant across all three
 * is the state: Claude Code shows `esc to interrupt` in its footer exactly while
 * a turn is in flight, and stops showing it the moment there is nothing to
 * interrupt. Present before the send, absent after, with a command that needed
 * 90 seconds and never printed its last line, is a killed call in any rendering.
 */
const LIVE_TURN = 'esc to interrupt';
const turnIsLive = (tail) => tail.includes(LIVE_TURN);

/** Printed by the wait script, and only if it is allowed to run to the end. */
const COMPLETION_MARKER = 'probe-wait finished';

/**
 * How the kill was *rendered*, reported rather than asserted on.
 *
 * Kept because which of the three renderings a run gets is the interesting part
 * — and because a run that gets rendering 3 is the one worth quoting at anybody
 * who thinks an unnoticed interrupt did not happen.
 */
const CANCELLED_MARKERS = [
  /interrupted/gi,
  /\brejected\b/gi,
  /(does|do)(n't| not) want to proceed/gi,
  /\bdeclined\b/gi
];
const countCancelled = (tail) =>
  CANCELLED_MARKERS.reduce((n, re) => n + (tail.match(re) ?? []).length, 0);

// ------------------------------------------------------------- isolation ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan156-live-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

for (const name of ['.claude', '.claude.json']) {
  const target = path.join(realHome, name);
  if (fs.existsSync(target)) fs.symlinkSync(target, path.join(fakeHome, name));
}
fs.mkdirSync(path.join(fakeHome, '.local'), { recursive: true });
if (fs.existsSync(path.join(realHome, '.local', 'bin'))) {
  fs.symlinkSync(path.join(realHome, '.local', 'bin'), path.join(fakeHome, '.local', 'bin'));
}

const realButchrDir = path.join(realHome, '.local', 'share', 'butchr');
const fakeButchrDir = path.join(fakeHome, '.local', 'share', 'butchr');
fs.mkdirSync(fakeButchrDir, { recursive: true });
if (fs.existsSync(realButchrDir)) {
  for (const name of fs.readdirSync(realButchrDir)) {
    if (name === 'integrations.json' || name.endsWith('-credential.json')) {
      fs.copyFileSync(path.join(realButchrDir, name), path.join(fakeButchrDir, name));
    }
  }
}

// ----------------------------------------------------------- the brief ------
// The daemon renders an activation's brief from `<repoRoot>/prompts/<type>.md`,
// where repoRoot is two levels above its own `dist`. So staging the build under
// test into a scratch repo is all it takes to give the probe a brief of our
// own — no daemon flag, no code path that exists only for tests.
const stagedRepo = path.join(scratch, 'repo');
const distDir = path.join(stagedRepo, 'daemon', 'dist');
fs.mkdirSync(path.join(stagedRepo, 'prompts'), { recursive: true });
fs.mkdirSync(path.dirname(distDir), { recursive: true });
fs.cpSync(sourceDist, distDir, { recursive: true });
// The staged package needs its `package.json` (for `"type": "module"`) and its
// `node_modules` (for node-pty). They come from beside the dist when that dist
// sits in a package, and from this script's own `daemon/` when it does not —
// which is the ordinary case for the red run, where the dist under test is a
// bare copy in /tmp. Neither is part of what is being measured.
const ownPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['package.json', 'node_modules']) {
  const from = [path.join(path.dirname(sourceDist), name), path.join(ownPkg, name)]
    .find((p) => fs.existsSync(p));
  if (from) fs.symlinkSync(from, path.join(stagedRepo, 'daemon', name));
}
fs.writeFileSync(
  path.join(stagedRepo, 'prompts', 'task.md'),
  `You are a probe in a timing experiment, and the experiment is about what\n` +
  `happens to a command that is still running. Do not read any other file, do\n` +
  `not use any MCP tool, and do no other work whatsoever.\n\n` +
  `Your only instruction: run \`${WAIT_CMD}\` in the FOREGROUND, now, and wait\n` +
  `for it to finish. Do not background it, do not run it with a shorter wait,\n` +
  `and do not substitute anything for it — a backgrounded or shortened command\n` +
  `measures nothing and wastes the run. Say nothing first; just run it.\n`
);

// ----------------------------------------------------- trusting the probe ---
// herdr spawns panes from its own environment, not the daemon's, so the Claude
// Code process reads the REAL `~/.claude.json` however isolated this daemon is.
// Without an entry for the probe's scratch workspace it stops on the folder-trust
// dialog and never runs anything — which is what the second attempt at this
// script spent its run watching. So the entry is written to the real file here
// and removed at exit: one key, naming a directory under /tmp that will not
// exist by then.
const realClaudeConfig = path.join(realHome, '.claude.json');
const probeWorkDir = path.join(
  fakeButchrDir, 'workspaces', RECIPIENT.type, RECIPIENT.key.toLowerCase()
);
const trustKey = path.normalize(path.resolve(probeWorkDir));

// The command itself, put where the probe will be told to run it. Activation
// creates this directory if it is missing and is content to find it there.
fs.mkdirSync(probeWorkDir, { recursive: true });
fs.writeFileSync(
  path.join(probeWorkDir, WAIT_SCRIPT),
  `import time\ntime.sleep(${WAIT_SECONDS})\nprint("probe-wait finished")\n`
);

/** Read-modify-write the real config atomically, or leave it entirely alone. */
function editRealClaudeConfig(mutate) {
  try {
    if (!fs.existsSync(realClaudeConfig)) return false;
    const config = JSON.parse(fs.readFileSync(realClaudeConfig, 'utf8'));
    if (!mutate(config)) return false;
    const tmp = `${realClaudeConfig}.kan156-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, realClaudeConfig);
    return true;
  } catch (e) {
    console.error(`  (could not edit ${realClaudeConfig}: ${e?.message ?? e})`);
    return false;
  }
}

let trustAdded = false;
trustAdded = editRealClaudeConfig((config) => {
  if (config.projects?.[trustKey]?.hasTrustDialogAccepted === true) return false;
  config.projects = {
    ...config.projects,
    [trustKey]: { ...config.projects?.[trustKey], hasTrustDialogAccepted: true }
  };
  return true;
});

let daemon;
const children = [];
process.on('exit', () => {
  for (const c of children) { try { c.kill(); } catch {} }
  try { daemon?.kill('SIGKILL'); } catch {}
  if (trustAdded) {
    editRealClaudeConfig((config) => {
      if (!config.projects?.[trustKey]) return false;
      delete config.projects[trustKey];
      return true;
    });
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

// --------------------------------------------------------------- daemon -----
console.log(`build under test:  ${sourceDist}`);
console.log(`staged at:         ${distDir}`);
console.log(`isolated HOME:     ${fakeHome}`);
daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: { ...process.env, HOME: fakeHome },
  stdio: ['ignore', 'pipe', 'pipe']
});
const daemonLog = [];
daemon.stdout.on('data', (c) => daemonLog.push(c.toString()));
daemon.stderr.on('data', (c) => daemonLog.push(c.toString()));

const socketPath = path.join(fakeButchrDir, 'butchr.sock');
for (let i = 0; i < 80 && !fs.existsSync(socketPath); i++) await sleep(250);
if (!fs.existsSync(socketPath)) {
  console.error('daemon never claimed its socket:\n' + daemonLog.join('').slice(-2000));
  process.exit(1); // setup guard
}
console.log(`daemon socket:     ${socketPath}\n`);

// ----------------------------------------------------------- MCP client -----
/** daemon/dist/mcp.js, spawned with the flags a real workspace .mcp.json declares. */
function mcpClient(identity) {
  const args = [path.join(distDir, 'mcp.js')];
  if (identity) args.push('--workspace-type', identity.type, '--workspace-key', identity.key);
  const child = spawn(process.execPath, args, {
    env: { ...process.env, HOME: fakeHome },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  children.push(child);

  let buffer = '';
  const pending = new Map();
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry(msg); }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const callTool = async (name, toolArgs) => {
    const res = await request('tools/call', { name, arguments: toolArgs });
    const text = res?.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { unparsed: text }; }
  };
  return { child, request, callTool, argv: args };
}

const sender = mcpClient(SENDER);
await sender.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'kan156-live', version: '1.0.0' }
});
sender.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
console.log(`sender MCP argv:   ${sender.argv.join(' ')}\n`);

const tail = async (lines = 45) =>
  (await sender.callTool('butchr_tail_agent', { ...RECIPIENT, lines }))?.text ?? '';

// ------------------------------------------------ a real agent in a pane ----
rule(`SETUP — activating a REAL claude agent: ${RECIPIENT.type}/${RECIPIENT.key}`);
const activation = await sender.callTool('butchr_activate_agent', {
  ...RECIPIENT, defaultAgent: 'claude', override: true
});
console.log(JSON.stringify({ success: activation?.success, workDir: activation?.workDir }, null, 2));
if (activation?.success !== true) {
  console.error(`\nactivation failed: ${activation?.error ?? '(no reason given)'}`);
  console.error(daemonLog.join('').slice(-2000));
  process.exit(1); // setup guard — no agent means nothing to observe
}

console.log(`\nwaiting for the probe to reach ${WAIT_CMD} off its own brief …`);
let inFlight = false;
let beforeTail = '';
let startedAt = 0;
for (let i = 0; i < 75; i++) {
  beforeTail = await tail(45);
  const flat = beforeTail.replace(/\s+/g, ' ');
  // The command is on the pane, a turn is live, and nothing has finished or
  // been cancelled yet.
  if (flat.includes(WAIT_CMD) && turnIsLive(beforeTail) && countCancelled(beforeTail) === 0) {
    // A settle, because the command name can be on screen while the agent is
    // only saying it is about to run it. Eight seconds later the pane must
    // still show the command and still show a live turn — which a narration
    // followed by a real call satisfies and a finished command does not.
    // `startedAt` is taken here, so the elapsed figure below over-estimates the
    // command's true age rather than flattering it.
    await sleep(8000);
    beforeTail = await tail(45);
    if (
      beforeTail.replace(/\s+/g, ' ').includes(WAIT_CMD) &&
      turnIsLive(beforeTail) &&
      countCancelled(beforeTail) === 0
    ) {
      inFlight = true;
      startedAt = Date.now();
      break;
    }
  }
  await sleep(2000);
}

if (!inFlight) {
  // A setup guard: without a command in flight there is nothing to interrupt,
  // so this run has measured nothing either way. It is not a verdict that a
  // send is harmless.
  rule('SETUP FAILED — the recipient never got into a shell command');
  console.log(beforeTail);
  console.log(`\nThe probe agent never ran ${WAIT_CMD}, so there was nothing in flight to\n` +
              'destroy. Nothing is concluded. Re-run; if it recurs, read the pane above.');
  console.log(JSON.stringify(await sender.callTool('butchr_deactivate_agent', RECIPIENT)));
  process.exit(1); // setup guard
}

const cancelledBefore = countCancelled(beforeTail);
rule(`1. THE RECIPIENT'S PANE BEFORE THE SEND — ${WAIT_CMD} in flight`);
console.log(beforeTail);
console.log('');
check(
  'PANE-1: the recipient is inside a running shell command, with a live turn and nothing cancelled',
  beforeTail.replace(/\s+/g, ' ').includes(WAIT_CMD) && turnIsLive(beforeTail) && cancelledBefore === 0,
  `"${WAIT_CMD}" on the pane, "${LIVE_TURN}" in the footer, cancellation markers: ${cancelledBefore}`
);

// ------------------------------------------- the send under measurement ----
rule('2. THE SEND — one ordinary butchr_send_to_agent, to a busy agent');
const NOTE = 'Probe note: a routine pointer, of the kind a supervisor sends without thinking.';
const sentAt = Date.now();
const measured = await sender.callTool('butchr_send_to_agent', { ...RECIPIENT, message: NOTE });
console.log(JSON.stringify(measured, null, 2));

let afterTail = '';
let killedAt = 0;
for (let i = 0; i < 30; i++) {
  afterTail = await tail(45);
  if (!turnIsLive(afterTail)) {
    // Confirmed a second later, so a single repaint frame between the footer
    // and the transcript cannot be read as a dead turn.
    await sleep(1000);
    const settled = await tail(45);
    if (!turnIsLive(settled)) { afterTail = settled; killedAt = Date.now(); break; }
  }
  await sleep(1000);
}
const cancelledAfter = countCancelled(afterTail);

const elapsedSinceStart = ((killedAt || Date.now()) - startedAt) / 1000;
const elapsedSinceSend = ((killedAt || Date.now()) - sentAt) / 1000;

rule('3. THE RECIPIENT\'S PANE AFTER THE SEND');
console.log(afterTail);
console.log('');

check(
  'PANE-2: the turn that was running the command is gone — the pane no longer offers to interrupt anything',
  killedAt > 0,
  killedAt > 0
    ? `"${LIVE_TURN}" was in the footer before the send and is not after it`
    : `the turn was still live 30s after the send`
);
check(
  `NEVER-FINISHED: the command did not reach its own end — "${COMPLETION_MARKER}" is nowhere on the pane`,
  !afterTail.includes(COMPLETION_MARKER),
  afterTail.includes(COMPLETION_MARKER)
    ? 'the command ran to completion, so nothing was destroyed'
    : `the ${WAIT_SECONDS}s command never printed its completion line`
);
check(
  `TIMING: it stopped far short of its own ${WAIT_SECONDS}s, so it was cut off rather than finishing`,
  killedAt > 0 && elapsedSinceStart < WAIT_SECONDS,
  killedAt > 0
    ? `${elapsedSinceStart.toFixed(1)}s into a ${WAIT_SECONDS}s command, ${elapsedSinceSend.toFixed(1)}s after the send`
    : `the turn outlived the send by more than 30s`
);
check(
  'CAUSE: the turn survived the whole preceding wait and died within seconds of the send — one event, not a coincidence',
  killedAt > 0 && elapsedSinceSend < 15,
  killedAt > 0
    ? `${elapsedSinceSend.toFixed(1)}s after the send`
    : 'the turn was still live 30s after the send'
);

// How this run happened to render it — see CANCELLED_MARKERS. Not a verdict:
// run 3 of this script rendered nothing at all, and a kill that says nothing is
// still a kill. This line exists so a reader knows which of the three they got.
console.log(
  `\n  RENDERING: cancellation wording on the pane went ${cancelledBefore} → ${cancelledAfter}` +
  (killedAt === 0
    ? ' — nothing was killed, so there was nothing to render.'
    : cancelledAfter > cancelledBefore
      ? ' — the recipient said something about it.'
      : ' — the kill was SILENT: nothing on the pane says the command was stopped.')
);

// --------------------------------------------------------- an observation ---
// Reported, not asserted, because it is a different ticket's defect (KAN-61 /
// KAN-77) and this script has no business passing or failing on it. It is here
// because it is the sharpest thing a run of this script can tell you: whether
// the message the interrupt was paid for actually arrived. On the first green
// run it had not — `success: true`, the turn destroyed, and not one word of the
// message on the pane or in the composer. That is the whole cost with none of
// the benefit, and it is invisible to a caller who does not tail.
const landed = afterTail.replace(/\s+/g, ' ').includes(`${SENDER_TAG} Probe note`.replace(/\s+/g, ' '));
console.log(
  `\n  OBSERVED (not a verdict here): the message itself ${landed ? 'DID' : 'did NOT'} appear on the\n` +
  `  recipient's pane, while the send reported success: ${measured?.success}.` +
  (landed
    ? '\n'
    : '\n  So this send destroyed a running command and delivered nothing — the sender\n' +
      '  cannot tell from its own return value. See KAN-61 and the confirm-or-retry\n' +
      '  helper in daemon/src/nudge.ts, which the agent-facing tool does not use.\n')
);

// The second observation, and the one KAN-156 exists for: not merely that the
// call died, but what the recipient *believes* killed it. A cancellation with no
// visible cause is read as the human's refusal, because the human is the only
// thing that normally interrupts a pane. Reported rather than asserted — the
// recipient's wording is its own, and a run where it says nothing about who
// stopped it is not a run where nothing was stopped.
const BLAME = /(you (just )?(declined|rejected|stopped)|user (rejected|declined|doesn't want))/i;
const blame = afterTail.match(BLAME);
if (blame) {
  console.log(
    `  OBSERVED: the recipient attributed the cancellation to the human — "${blame[0]}".\n` +
    '  Nobody at that keyboard did anything. This is the misattribution the epic\n' +
    '  agent hit twice from the receiving end, reproduced here from the sending end.\n'
  );
}

// ---------------------------------------------------------------- cleanup ---
rule('CLEANUP — standing the probe agent down');
console.log(JSON.stringify(await sender.callTool('butchr_deactivate_agent', RECIPIENT)));
await sleep(1500);

rule(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASS');
console.log(
  failures
    ? '\n  The send did not visibly destroy the recipient\'s in-flight work. Either the\n' +
      '  interrupt has been removed from the send path (see the red recipe in the\n' +
      '  header) or the pane did not render what this script reads. Read the tails.\n'
    : `\n  A single butchr_send_to_agent ended a real tool call ${elapsedSinceSend.toFixed(1)}s after it was\n` +
      `  issued, ${elapsedSinceStart.toFixed(1)}s into a ${WAIT_SECONDS}s command. "Interrupts any partially typed\n` +
      '  input" does not describe that. The tool description now says what this is.\n'
);
console.log('== done ==');
process.exit(failures ? 1 : 0);
