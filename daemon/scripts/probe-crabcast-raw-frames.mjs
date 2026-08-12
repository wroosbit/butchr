// KAN-324: capture the RAW `list_agents` and `daemon_status` frames off a live
// CrabCast socket.
//
// **This is where `fixtures/crabcast-v4-short-census.json` came from**, and it
// is committed so that fixture has a reproducible provenance rather than being
// a blob somebody pasted. Re-run it against any CrabCast to capture another.
//
// A `probe-`, not a `verify-`: it asserts nothing and has no verdict. It
// records what a peer said, which is the input a proof is then written against.
//
// Deliberately does NOT go through CrabCastLink. The point is to record what
// CrabCast actually put on the wire, not what our adapter made of it — a
// capture taken through the adapter could not have caught the adapter reading
// the wrong field name, which is half of what the fixture is for.
//
// Usage: node daemon/scripts/probe-crabcast-raw-frames.mjs [out.json]
//        BUTCHR_CRABCAST_SOCKET=<path>   to point at a specific daemon

import net from 'net';
import os from 'os';
import path from 'path';
import { writeFileSync } from 'fs';

const socketPath =
  process.env.BUTCHR_CRABCAST_SOCKET ||
  path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');

const out = process.argv[2] || 'raw-capture.json';

const socket = net.createConnection(socketPath);
let buffer = '';
const frames = [];
const pending = new Map();
let nextId = 1;

socket.on('data', (chunk) => {
  buffer += String(chunk);
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    frames.push(frame);
    const p = pending.get(frame.id);
    if (p) { pending.delete(frame.id); p(frame); }
  }
});

function request(action) {
  const id = `kan324-${process.pid}-${nextId++}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${action}`)), 10_000);
    pending.set(id, (f) => { clearTimeout(t); resolve(f); });
    socket.write(JSON.stringify({ action, id }) + '\n');
  });
}

await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });

const daemonStatus = await request('daemon_status');
const listAgents = await request('list_agents');

const capture = {
  capturedAt: new Date().toISOString(),
  socketPath,
  note:
    'Raw frames off the live CrabCast socket. Captured for KAN-324 AC5 because ' +
    'the registry state that produces a non-zero unreadableRecordsTotal ' +
    'describes an agent deactivated 2026-08-03 and is not being preserved on purpose.',
  daemon_status: daemonStatus,
  list_agents: listAgents
};

writeFileSync(out, JSON.stringify(capture, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log('');
console.log('--- daemon_status ---');
console.log(JSON.stringify(daemonStatus, null, 2));
console.log('');
console.log('--- list_agents ---');
console.log(JSON.stringify(listAgents, null, 2));

socket.destroy();
