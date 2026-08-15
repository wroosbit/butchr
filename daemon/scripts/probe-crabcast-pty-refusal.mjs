// KAN-459: capture what a `pty_input` / `pty_resize` REFUSAL looks like on the
// wire, off the live CrabCast socket, at the build that is actually deployed.
//
// **This exists because the answer was about to be inferred from CrabCast's
// source, which invariant 10 forbids.** `epic/KAN-59` reported that CrabCast's
// undeployed `main` turns `pty_*` refusals from a conditional `ack` into an
// unconditional `refuse`. That is a claim about *their* tree. What Butchr is
// entitled to act on is what the *deployed* daemon puts on the wire, and this
// script is the only thing that can say it.
//
// A `probe-`, not a `verify-`: it asserts nothing and has no verdict. It
// records what a peer said, which is the input a proof is then written against.
// Same species as `probe-crabcast-raw-frames.mjs`, and it borrows that script's
// framing loop deliberately.
//
// Deliberately does NOT go through CrabCastLink — the point is to record what
// CrabCast put on the wire, not what our adapter made of it.
//
// ## Safety: every frame here is addressed to a session that cannot exist
//
// `pty_input` on a REAL session types into a real agent's terminal, which is
// the one thing this probe must never do. Every sessionId below is a
// `kan459-probe-…` string with the pid in it, so the only reachable answer is a
// refusal. **There is deliberately no accepted-write leg here** — the control
// for an accepted write is `verify-pty-write-is-fire-and-forget.mjs`, which
// drives a stub link and never touches a pane.
//
// Usage: node daemon/scripts/probe-crabcast-pty-refusal.mjs [out.json]
//        BUTCHR_CRABCAST_SOCKET=<path>   to point at a specific daemon

import net from 'net';
import os from 'os';
import path from 'path';
import { writeFileSync } from 'fs';

const socketPath =
  process.env.BUTCHR_CRABCAST_SOCKET ||
  path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');

const out = process.argv[2] || null;

const socket = net.createConnection(socketPath);
let buffer = '';
/** Every frame the peer sent, in arrival order, whether correlated or not. */
const allFrames = [];
const pending = new Map();
let nextId = 1;

socket.on('data', (chunk) => {
  buffer += String(chunk);
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      allFrames.push({ unparseable: line });
      continue;
    }
    allFrames.push({ at: Date.now(), frame });
    const p = pending.get(frame.id);
    if (p) {
      pending.delete(frame.id);
      p(frame);
    }
  }
});

/** Send a frame WITH an id and wait for its ack. Resolves `null` on timeout. */
function request(body, timeoutMs = 10_000) {
  const id = `kan459-${process.pid}-${nextId++}`;
  const sentAt = Date.now();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pending.delete(id);
      resolve({ id, sent: { ...body, id }, answered: false, waitedMs: Date.now() - sentAt });
    }, timeoutMs);
    pending.set(id, (f) => {
      clearTimeout(t);
      resolve({ id, sent: { ...body, id }, answered: true, roundTripMs: Date.now() - sentAt, answer: f });
    });
    socket.write(JSON.stringify({ ...body, id }) + '\n');
  });
}

/**
 * Send a frame with NO id and watch for anything unsolicited.
 *
 * This is the leg that tests the docblock's own premise — *"CrabCast only acks
 * a frame that carries one"*. Butchr has no id-less code path (`request()`
 * attaches one unconditionally), so this is asked of the wire purely to say
 * whether the retired comment was even describing a real behaviour.
 */
function sendIdless(body, settleMs = 1500) {
  const mark = allFrames.length;
  socket.write(JSON.stringify(body) + '\n');
  return new Promise((resolve) =>
    setTimeout(() => resolve({ sent: body, framesAfter: allFrames.slice(mark) }), settleMs)
  );
}

await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});

const ghostSession = `kan459-probe-${process.pid}-no-such-session`;

const daemonStatus = await request({ action: 'daemon_status' });

const legs = {
  // What build answered. Everything below is a fact about THIS commit only.
  daemon_status: daemonStatus,

  // The three pty verbs, each against a session that cannot exist.
  pty_input_unknown_session: await request({
    action: 'pty_input',
    sessionId: ghostSession,
    data: 'x'
  }),
  pty_resize_unknown_session: await request({
    action: 'pty_resize',
    sessionId: ghostSession,
    cols: 80,
    rows: 24
  }),
  pty_init_unknown_session: await request({ action: 'pty_init', sessionId: ghostSession }),

  // Same refusal, asked WITHOUT an id.
  pty_input_unknown_session_idless: await sendIdless({
    action: 'pty_input',
    sessionId: ghostSession,
    data: 'x'
  })
};

const capture = {
  capturedAt: new Date().toISOString(),
  socketPath,
  note:
    'KAN-459: what a pty_* refusal looks like on the wire at the DEPLOYED CrabCast build. ' +
    'Every sessionId is a probe string that cannot resolve, so no pane was written to. ' +
    'Read rather than inferred from CrabCast source (invariant 10).',
  legs,
  allFrames
};

if (out) {
  writeFileSync(out, JSON.stringify(capture, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

const build = daemonStatus.answer?.build ?? daemonStatus.answer?.daemon?.build;
console.log('--- peer ---');
console.log(`socket           ${socketPath}`);
console.log(`build.commit     ${build?.commit ?? '(not in daemon_status)'}`);
console.log(`contractVersion  ${daemonStatus.answer?.contractVersion ?? '(absent)'}`);
console.log('');

for (const [name, leg] of Object.entries(legs)) {
  if (name === 'daemon_status') continue;
  console.log(`--- ${name} ---`);
  console.log(`sent     ${JSON.stringify(leg.sent)}`);
  if ('answered' in leg) {
    console.log(
      leg.answered
        ? `answered YES in ${leg.roundTripMs}ms`
        : `answered NO  (waited ${leg.waitedMs}ms)`
    );
    if (leg.answer) console.log(`answer   ${JSON.stringify(leg.answer)}`);
  } else {
    console.log(
      leg.framesAfter.length === 0
        ? 'answered NO  (nothing unsolicited arrived)'
        : `unsolicited frames: ${JSON.stringify(leg.framesAfter.map((f) => f.frame))}`
    );
  }
  console.log('');
}

socket.end();
