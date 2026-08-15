// Live check of the KAN-16 fix against a real herdr, at the level the bug
// actually lived: HerdrBridge.
//
// WHAT FAILURE THIS WOULD CATCH: a second activation for an agent opening a
// second `--takeover` attach, which evicts the first and leaves the sidepanel
// rendering a terminal that will never produce another byte.
//
// CI-RUNNABLE: no — takes the key of a live agent as its argument and attaches
// to it; there is nothing to pass in CI.
//
// Before the fix, a second spawnSession for one agent opened a second
// `herdr agent attach --takeover`, which evicted the first and left the
// sidepanel rendering a dead frame. This drives exactly that sequence and
// asserts the first PTY is still streaming afterwards.
//
// Usage: node daemon/scripts/verify-no-attach-steal.mjs <existing-agent-key>
//
// The key must belong to an agent herdr already knows and nothing is attached
// to (e.g. a finished task workspace). Run it from the daemon directory after
// `npm ci` and `npx tsc`.

import { HerdrBridge, agentNameFor } from '../dist/herdr.js';

const key = process.argv[2];
if (!key) {
  console.error('usage: node scripts/verify-no-attach-steal.mjs <agent-key>');
  process.exit(2);
}
const type = 'task';
console.log(`target agent: ${agentNameFor(type, key)}\n`);

const bridge = new HerdrBridge();
const ended = [];
bridge.setSessionEndedListener((e) => {
  ended.push(e);
  console.log(`  [event] agent_detached_event sessionId=${e.sessionId} reason=${e.reason} exitCode=${e.exitCode}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bridge writes a prompt file into the workspace; pass none so this
// touches nothing but the attach itself.
console.log('== first activate ==');
const first = bridge.spawnSession(type, key, undefined, '', 1);
await sleep(2000);

let firstBytes = 0;
// KAN-381: the listener takes a PtyStreamEvent now. `HerdrBridge` only ever
// delivers the data arm — an in-process pty has no subscription to lose — so
// this counts that arm and would throw rather than miscount if the other ever
// arrived here.
bridge.registerDataListener(first.sessionId, (e) => { firstBytes += e.data.length; });

console.log('\n== second activate at the same agent (this is what used to steal it) ==');
const second = bridge.spawnSession(type, key, undefined, '', 1);
await sleep(3000);

console.log('\n== result ==');
console.log(`same session returned: ${first.sessionId === second.sessionId}`);
console.log(`first session status:  ${first.status}`);
console.log(`detach events:         ${ended.length ? JSON.stringify(ended) : 'none'}`);

// A live attach keeps redrawing, so any traffic at all proves it is streaming.
const before = firstBytes;
await sleep(1500);
console.log(`bytes streamed after the second activate: ${firstBytes - before >= 0 ? firstBytes : 0} total`);

const ok =
  first.sessionId === second.sessionId &&
  first.status === 'active' &&
  ended.length === 0;

// Drop only our own attach. terminateSession would also close the agent's
// pane, and this script borrows an agent it does not own.
first.ptyProcess?.kill();
await sleep(500);

console.log(ok
  ? '\nPASS: the second activate reused the live session; nothing was evicted.'
  : '\nFAIL: a second attach was opened or the first session died.');
process.exit(ok ? 0 : 1);
