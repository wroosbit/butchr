#!/usr/bin/env node
// KAN-283 — `AgentRuntime.tailAgent` is `Promise`-returning, and every caller
// awaits it.
//
// WHAT FAILURE THIS WOULD CATCH: a call site that reads `tailAgent`'s result
// without awaiting it. A Promise has no `success` and no `text` of its own, so
// `tail.success` is `undefined` and `tail.text` is `undefined` — and every
// caller in this daemon tests exactly `tail.success && typeof tail.text ===
// 'string'` or spreads the result. An un-awaited call therefore reads as **a
// read that failed**, and the caller concludes "could not look" about a pane
// nobody asked about. That is the KAN-255 defect resurrected one layer up: a
// claim about the agent manufactured out of a fact about the caller. It is
// silent — nothing throws, nothing logs, `tsc` does not flag a spread of a
// Promise or a truthiness test on one — and it degrades toward looking like the
// honest refusal, which is the direction that survives review.
//
// The concrete consequences, each asserted below rather than described: channel
// startup supervision would count a `paneFailure` on every pass and never see
// the dialog it exists to answer (`readPane` → `null`); the liveness probe would
// report `pane-unreadable` and ask nobody; delivery confirmation would time out
// on every send and report every delivered message unconfirmed, because
// `readLandedCount` returns a Promise now and `Promise > number` is `false` for
// every value of both; and `butchr_tail_agent` would answer a client with no
// `success` field at all, because spreading a Promise contributes nothing.
//
// CI-RUNNABLE: yes — imports the built daemon modules and reads `daemon/src`
// off the checkout; the only herdr is a shim this file writes onto PATH. No
// live daemon, no real herdr, no credential, no peer, no terminal, no network.
//
// ---------------------------------------------------------------------------
// SECTIONS 1 AND 3 SUPPLY THEIR OWN INPUT. READ WHAT THAT LEAVES UNCOVERED.
// ---------------------------------------------------------------------------
//
// Section 1 drives `HerdrBridge.tailAgent` against a herdr this file writes, and
// section 3 constructs the un-awaited shape deliberately. So those two prove
// **what the degradation is**, not that this tree is free of it. Section 2 is
// the one that reads the shipped call sites, and it is a static grep over
// `daemon/src/*.ts` — so it is unaffected by a stale or failed build, and its
// verdict is about the source you are looking at.
//
// WHAT IS NOT COVERED HERE, AND WHO COVERS IT:
//
//   - **That a real CrabCast tail arrives correctly over the socket.** Nothing
//     in this file speaks to CrabCast; there is no peer. `verify-crabcast-
//     runtime-live.mjs` §7 owns that, against a real daemon, hand-run, with its
//     output on the pull request. The two are a pair and neither claims the
//     other's half.
//   - **`HerdrBridge`'s tail *semantics*** — the three outcome shapes, and that
//     every source is asked before a pane is called empty. That is KAN-255's and
//     `verify-tail-asks-every-source.mjs` owns it, with 31 checks. This file
//     asserts only what going async could have broken, and deliberately does not
//     restate it: one fact, one owner.
//   - **A caller that awaits and then misreads the result.** Awaiting is what
//     this file can see. Whether `channel-startup.ts` draws the right conclusion
//     from a `null` is `verify-channel-startup-supervision.mjs`'s.
//
// Usage:
//   cd daemon && npm run build
//   node daemon/scripts/verify-tail-async-awaited.mjs [--verbose] [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sweepTree } from './lib/sweep-sources.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const distDir = process.argv.slice(2).find((a) => !a.startsWith('--'))
  ?? path.join(daemonDir, 'dist');

// A SETUP GUARD, NOT A VERDICT — nothing has been tested at this point, so this
// exits 2 rather than 1. `exit 1` in this file always means an assertion failed.
if (!fs.existsSync(path.join(distDir, 'herdr.js'))) {
  console.error(`setup: no build at ${distDir}. Run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

let failures = 0;
let checks = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(name, ok, detail) {
  checks += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) {
      console.log(`         ${String(detail).replace(/\n/g, '\n         ')}`);
    }
  } else if (verbose && detail !== undefined) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

// ── a herdr shim, so a real HerdrBridge can be driven with no real herdr ─────
//
// Deliberately minimal beside `verify-tail-asks-every-source.mjs`'s grid model:
// this file does not test WHAT a tail answers, only that the answer is a
// promise, that it settles without I/O, and that it never rejects. So the shim
// needs one readable pane and one refusing source, and nothing else.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan283-'));
const shimState = path.join(scratch, 'state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.BUTCHR_KAN283_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.BUTCHR_KAN283_SHIM_STATE;
const args = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
if (args[0] === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (args[0] === 'agent' && args[1] === 'read') {
  const srcIdx = args.indexOf('--source');
  const source = srcIdx === -1 ? 'recent-unwrapped' : args[srcIdx + 1];
  if (fs.existsSync(path.join(state, 'fail-' + source))) {
    process.stderr.write(JSON.stringify({ error: { code: 'herdr_unreachable', message: 'refused (' + source + ')' } }));
    process.exit(1);
  }
  const paneFile = path.join(state, 'pane.txt');
  const text = fs.existsSync(paneFile) ? fs.readFileSync(paneFile, 'utf8') : '';
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

const setPane = (text) => fs.writeFileSync(path.join(shimState, 'pane.txt'), text);
const failSource = (source, on) => {
  const f = path.join(shimState, `fail-${source}`);
  if (on) fs.writeFileSync(f, '1');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
};
const clearFaults = () => {
  failSource('recent-unwrapped', false);
  failSource('visible', false);
};

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const bridge = new HerdrBridge();
const KEY = 'kan-283-async';
const TYPE = 'task';

// ── 1. the default runtime: a promise, settled without I/O, never rejecting ──
rule('1. HerdrBridge.tailAgent — Promise-returning, and nothing else about it moved');

clearFaults();
setPane('KAN283 pane has text on it\n');

const returned = bridge.tailAgent(KEY, TYPE, 40);
check(
  'it returns a thenable rather than a plain object',
  returned !== null && typeof returned === 'object' && typeof returned.then === 'function',
  `typeof=${typeof returned}; keys=${JSON.stringify(Object.keys(returned ?? {}))}`
);

// THE ORDERING ASSERTION, AND IT IS THE POINT OF THIS SECTION. `HerdrBridge`
// reads through `spawnSync`, so going async added no waiting: the promise is
// already settled when the first macrotask runs. A future author who replaced
// that read with something genuinely asynchronous would land here, which is the
// one place this file would rather be told than left green.
let macrotaskRan = false;
setTimeout(() => { macrotaskRan = true; }, 0);
const settled = await returned;
check(
  'it settles on the microtask queue — no I/O was introduced, so no ordering a caller can see changed',
  macrotaskRan === false,
  'a macrotask ran before the tail resolved, so this method now waits where it did not'
);

check(
  'the resolved value is the read itself, not a wrapper',
  settled.success === true && settled.text.includes('KAN283'),
  JSON.stringify(settled)
);
check(
  'and it still names the source that answered',
  settled.source === 'recent-unwrapped',
  JSON.stringify(settled)
);

// NEVER THROWS became NEVER REJECTS, and the contract says "the caller owes its
// client a response". All three outcome shapes are driven, because a rejection
// on any of them would reach a caller that has no catch.
const outcomes = [];
clearFaults();
setPane('');
outcomes.push(['a pane that is genuinely empty', await bridge.tailAgent(KEY, TYPE, 40).then(
  (v) => ({ ok: true, v }),
  (e) => ({ ok: false, e: String(e?.message ?? e) })
)]);
failSource('recent-unwrapped', true);
failSource('visible', true);
outcomes.push(['every source refusing', await bridge.tailAgent(KEY, TYPE, 40).then(
  (v) => ({ ok: true, v }),
  (e) => ({ ok: false, e: String(e?.message ?? e) })
)]);
clearFaults();
outcomes.push(['an unresolvable address', await bridge.tailAgent('no-such-agent-kan283', undefined, 40).then(
  (v) => ({ ok: true, v }),
  (e) => ({ ok: false, e: String(e?.message ?? e) })
)]);

for (const [label, result] of outcomes) {
  check(
    `it resolves rather than rejecting — ${label}`,
    result.ok === true,
    result.ok ? undefined : `rejected with: ${result.e}`
  );
}
// The empty-pane case must still be the ASSERTION about the agent, not a
// refusal that happens to look like one.
const emptyCase = outcomes[0][1];
check(
  'a genuinely empty pane still resolves to success:true with source:null',
  emptyCase.ok && emptyCase.v.success === true && emptyCase.v.text === '' && emptyCase.v.source === null,
  JSON.stringify(emptyCase.v)
);
const refusedCase = outcomes[1][1];
check(
  'a refused read still resolves to success:false and carries NO text',
  refusedCase.ok && refusedCase.v.success === false && refusedCase.v.text === undefined,
  JSON.stringify(refusedCase.v)
);

// ── 2. every shipped call site awaits ───────────────────────────────────────
rule('2. the call sites — every tailAgent read in daemon/src is awaited');

// READS SOURCE AS TEXT, DELIBERATELY. This section's verdict is about the tree
// you are looking at, so it must not depend on `dist` being current — see the
// header. `prompts/task.md` is explicit that a proof importing from `dist` after
// a failed build tested yesterday's code; this leg cannot.
// RECURSIVE SINCE KAN-465 — this was `fs.readdirSync(srcDir)` and read 58 of the
// 62 `.ts` under `daemon/src`. The section below asserts that EVERY `tailAgent`
// read in `daemon/src` is awaited, and an unawaited one in `integrations/` was
// outside it. The `callSites.length >= 5` guard directly under this is the
// check that the grep found anything at all; it could not have noticed a
// population four files short, because five were always at the top level.
const srcDir = path.join(daemonDir, 'src');
const srcSweep = sweepTree(srcDir, { label: 'daemon/src' });
const srcFiles = srcSweep.files;
console.log(`  ${srcSweep.coverage}`);

check(
  'the sweep reached every daemon source — the population this rule is about',
  srcSweep.reachedEverything,
  srcSweep.detail
);

/** Call sites, excluding the declaration in the interface and the two implementations. */
const callSites = [];
for (const file of srcFiles) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!/\.tailAgent\(/.test(line)) return;
    callSites.push({ file, line: i + 1, text: line.trim() });
  });
}

check(
  'the greps found call sites at all — an empty set would pass every assertion below',
  callSites.length >= 5,
  `found ${callSites.length}: ${callSites.map((c) => `${c.file}:${c.line}`).join(', ')}`
);

for (const site of callSites) {
  check(
    `${site.file}:${site.line} awaits its tail`,
    /await\s+[A-Za-z_$][\w$.]*\.tailAgent\(/.test(site.text),
    site.text
  );
}

// The two `World` drivers read a pane through an injected function rather than
// through `tailAgent` directly, so the grep above cannot see them. They are the
// callers whose un-awaited form is hardest to notice, because `readPane`'s
// return type is the thing that changed and both are `null`-significant.
const worldReads = [];
for (const file of ['channel-startup.ts', 'channel-liveness.ts']) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  text.split('\n').forEach((line, i) => {
    if (!/(?<!\w)world\.readPane\(/.test(line)) return;
    worldReads.push({ file, line: i + 1, text: line.trim() });
  });
}
check(
  'the pane-reading drivers were found',
  worldReads.length >= 3,
  `found ${worldReads.length}: ${worldReads.map((w) => `${w.file}:${w.line}`).join(', ')}`
);
for (const site of worldReads) {
  check(
    `${site.file}:${site.line} awaits world.readPane()`,
    /await\s+world\.readPane\(/.test(site.text),
    site.text
  );
}

// `readLandedCount` is the sharpest of the lot: its un-awaited form is a
// comparison rather than a field read, so it produces a NUMBER-shaped wrong
// answer instead of an undefined one. Section 3 drives what that costs.
const nudgeSrc = fs.readFileSync(path.join(srcDir, 'nudge.ts'), 'utf8');
const landedCalls = nudgeSrc.split('\n')
  .map((line, i) => ({ line: i + 1, text: line.trim() }))
  .filter((l) => /(?<!function\s)readLandedCount\(/.test(l.text) && !/^async function/.test(l.text));
check(
  'nudge.ts readLandedCount call sites were found',
  landedCalls.length >= 2,
  `found ${landedCalls.length}`
);
for (const site of landedCalls) {
  check(
    `nudge.ts:${site.line} awaits readLandedCount`,
    /await\s+readLandedCount\(/.test(site.text),
    site.text
  );
}

// ── 3. what an un-awaited read degrades to, driven rather than described ────
rule('3. the hazard — an un-awaited tail is indistinguishable from a failed read');

clearFaults();
setPane('KAN283 the pane plainly has text on it\n');
const unawaited = bridge.tailAgent(KEY, TYPE, 40);

check(
  'a Promise carries no success of its own — so the value is neither true nor false',
  unawaited.success === undefined,
  `success=${String(unawaited.success)}`
);
check(
  'and no text — so a caller cannot tell this from a pane it failed to read',
  unawaited.text === undefined,
  `text=${String(unawaited.text)}`
);

// The exact expressions the shipped callers use, applied to the un-awaited
// value. Each of these is a line copied from `daemon/src`, which is what makes
// this a statement about those callers rather than about Promises in general.
const startupExpr = unawaited.success && typeof unawaited.text === 'string' ? unawaited.text : null;
check(
  "daemon.ts's channel-startup readPane would answer null — 'could not look' about a pane with text on it",
  startupExpr === null,
  `expression yielded ${JSON.stringify(startupExpr)}`
);

const livenessExpr = unawaited.text ?? null;
check(
  "daemon.ts's liveness readPane would answer null — the probe would report pane-unreadable and ask nobody",
  livenessExpr === null,
  `expression yielded ${JSON.stringify(livenessExpr)}`
);

const spread = { action: 'tail_agent_response', key: KEY, ...unawaited };
check(
  'router.ts spreading it would answer a client with no success field at all',
  spread.success === undefined && spread.text === undefined,
  JSON.stringify(spread)
);

// And the comparison form, which is the one that yields a plausible number.
const { landedCount } = await import(path.join(distDir, 'nudge.js')).then(
  (m) => ({ landedCount: m.landedCount }),
  () => ({ landedCount: undefined })
);
const promiseComparison = Promise.resolve(7) > 0;
check(
  'Promise > number is false for every value of both — delivery confirmation would never confirm',
  promiseComparison === false,
  `Promise.resolve(7) > 0 === ${promiseComparison}`
);
if (verbose && landedCount === undefined) {
  console.log('         (landedCount is not exported; the comparison above is asserted directly)');
}

// Awaiting the same call returns the text that was there all along. This is the
// control: it is what makes the four assertions above claims about the missing
// `await` rather than about the pane.
const awaited = await unawaited;
check(
  'awaiting the SAME call returns the text — the pane was readable throughout',
  awaited.success === true && awaited.text.includes('KAN283'),
  JSON.stringify(awaited)
);

// ── 4. the signature the greps depend on ───────────────────────────────────
rule('4. the interface still declares it async — without which section 2 asserts nothing');

// THIS SECTION EXISTS BECAUSE SECTION 2 WOULD PASS ON A REVERTED SIGNATURE.
// `await` on a non-promise is legal and returns the value, so every grep above
// stays green if somebody makes `tailAgent` synchronous again. That would be a
// silent partial revert: the awaits would be decoration, and the CrabCast
// implementation would have to go back to refusing. So the signature is pinned
// here, and the two sections are only load-bearing together.
const ifaceSrc = fs.readFileSync(path.join(srcDir, 'agent-runtime.ts'), 'utf8');
check(
  'AgentRuntime.tailAgent is declared Promise-returning',
  /tailAgent\(\s*key: string,\s*type\?: string,\s*lines\?: number\s*\): Promise</.test(ifaceSrc),
  'the interface no longer declares a Promise, so every `await` in section 2 is decoration'
);

const herdrSrc = fs.readFileSync(path.join(srcDir, 'herdr.ts'), 'utf8');
check(
  'HerdrBridge implements it async',
  /public async tailAgent\(/.test(herdrSrc),
  'HerdrBridge.tailAgent is no longer async'
);

const crabSrc = fs.readFileSync(path.join(srcDir, 'crabcast-runtime.ts'), 'utf8');
check(
  'CrabCastRuntime implements it async',
  /async tailAgent\(/.test(crabSrc),
  'CrabCastRuntime.tailAgent is no longer async'
);
check(
  'and CrabCastRuntime actually asks the wire rather than refusing outright',
  /action: 'tail_agent'/.test(crabSrc),
  "CrabCastRuntime no longer sends tail_agent — the KAN-278 refusal is back"
);

// ── 5. the CrabCast mapping, against frames recorded from a real peer ──────
rule('5. CrabCastRuntime.tailAgent — the wire response mapped into our contract');

// ───────────────────────────────────────────────────────────────────────────
// THIS SECTION STAGES ITS OWN SOCKET. WHAT THAT DOES AND DOES NOT ESTABLISH.
// ───────────────────────────────────────────────────────────────────────────
//
// It proves the ADAPTER maps a `tail_agent_response` into
// `AgentRuntime.tailAgent`'s contract correctly. It cannot prove CrabCast sends
// that shape — a staged responder is structurally incapable of noticing that
// they renamed a field, and `tail_agent_response` is **outside their read-path
// contract**, which covers `list_agents` and `agent_status` only. So it can
// change without their CI going red.
//
// WHAT MAKES THE FRAMES BELOW EVIDENCE RATHER THAN INVENTION: each is a shape
// read off a live CrabCast daemon at `6f47df7d` (contract v6) by direct socket
// probe, and the probe output is pasted on the KAN-283 pull request. The refusal
// frame in §5c is quoted verbatim from that run, `sourcesTried` included.
//
// WHO COVERS THE OTHER HALF: `verify-crabcast-runtime-live.mjs` §4c, against a
// real daemon and a real pane, hand-run, output on the PR. **The two are a pair
// and the gap between them is real** — if CrabCast changes the field names,
// this section stays green and only that one goes red.

const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { workspaceDirFor } = await import(path.join(distDir, 'herdr.js'));

const net = await import('net');
const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan283-tail-sock-'));
const sockPath = path.join(sockDir, 'crabcast.sock');
const quiet = () => {};

/** What the staged peer answers the next `tail_agent` with. */
let tailReply = null;
/** Every `tail_agent` request the adapter sent, so the address can be asserted. */
const tailRequests = [];

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
      try { req = JSON.parse(line); } catch { continue; }
      const reply = (body) => socket.write(JSON.stringify({ ...body, id: req.id }) + '\n');
      if (req.action === 'daemon_status') {
        reply({ action: 'daemon_status_response', success: true, build: { commit: 'staged' } });
      } else if (req.action === 'list_agents') {
        reply({ action: 'list_agents_response', success: true, agents: [], foreignPanes: [] });
      } else if (req.action === 'tail_agent') {
        tailRequests.push(req);
        reply({ action: 'tail_agent_response', ...(tailReply ?? { success: false, error: 'nothing staged' }) });
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((r) => server.listen(sockPath, r));

const link = new CrabCastLink({ socketPath: sockPath, log: quiet, reconnectDelayMs: 50 });
const crab = new CrabCastRuntime({ link, log: quiet, censusIntervalMs: 10_000 });
// The link connects lazily; give it its handshake before asking for anything.
for (let i = 0; i < 60 && !crab.describe().link.connected; i++) {
  await new Promise((r) => setTimeout(r, 50));
}
check('the staged peer is connected', crab.describe().link.connected === true);

// §5a — a successful read, mapped field for field.
tailReply = {
  success: true,
  path: workspaceDirFor(TYPE, 'kan-1'),
  text: 'line one\nKAN283-OVER-THE-WIRE\n',
  truncated: true,
  source: 'recent-unwrapped',
  sourcesTried: ['recent-unwrapped']
};
const mapped = await crab.tailAgent('kan-1', TYPE, 60);
check(
  '5a: a successful tail_agent maps to success:true with the text intact',
  mapped.success === true && mapped.text === 'line one\nKAN283-OVER-THE-WIRE\n',
  JSON.stringify(mapped)
);
check('5a: truncated is carried', mapped.truncated === true, JSON.stringify(mapped));
check('5a: source is carried', mapped.source === 'recent-unwrapped', JSON.stringify(mapped));
check(
  '5a: sourcesTried is carried',
  JSON.stringify(mapped.sourcesTried) === JSON.stringify(['recent-unwrapped']),
  JSON.stringify(mapped)
);
check(
  '5a: and the agent was addressed by PATH, translated from (type, key)',
  tailRequests.at(-1)?.path === workspaceDirFor(TYPE, 'kan-1') &&
    tailRequests.at(-1)?.lines === 60,
  JSON.stringify(tailRequests.at(-1))
);

// §5b — the empty pane. `source: null` with `success: true` is the ASSERTION
// "every source was asked and every one was empty", which `superviseChannelStartup`
// is entitled to rely on. It has to survive the mapping as `null`.
tailReply = { success: true, text: '', truncated: false, source: null, sourcesTried: ['recent-unwrapped', 'visible'] };
const emptied = await crab.tailAgent('kan-1', TYPE, 60);
check(
  '5b: a genuinely empty pane stays success:true with source:null — a claim about the AGENT',
  emptied.success === true && emptied.text === '' && emptied.source === null,
  JSON.stringify(emptied)
);

// §5c — their refusal, quoted from the live probe at 6f47df7d. The critical
// property is that it does NOT become an empty pane.
tailReply = {
  success: false,
  path: '/tmp/kan283-notanagent',
  error:
    "Could not establish what is on agent 'crabcast-kan283-notanagent-e484f1f3e766bbdf': " +
    'agent target crabcast-kan283-notanagent-e484f1f3e766bbdf not found. no source could be read.',
  sourcesTried: ['recent-unwrapped', 'visible']
};
const refused = await crab.tailAgent('kan-1', TYPE, 60);
check(
  '5c: a refusal stays success:false and acquires NO text',
  refused.success === false && refused.text === undefined,
  JSON.stringify(refused)
);
check(
  "5c: their reason is carried verbatim inside our refusal, and the leg is named",
  typeof refused.error === 'string' &&
    refused.error.includes('no source could be read') &&
    /refused by crabcast-daemon:/.test(refused.error),
  refused.error
);
check(
  '5c: sourcesTried survives the refusal — the evidence that they looked twice',
  JSON.stringify(refused.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
  JSON.stringify(refused)
);

// §5d — success with a non-string `text`. THE ONE THE SIGNATURE CHANGE MADE
// POSSIBLE: an implementation with a wire to read is the one tempted to treat a
// missing text as an empty pane, which is the KAN-255 defect arriving from a new
// direction.
tailReply = { success: true, truncated: false, source: 'visible', sourcesTried: ['visible'] };
const textless = await crab.tailAgent('kan-1', TYPE, 60);
check(
  '5d: success with no text is a READ WE COULD NOT MAKE, not an empty pane',
  textless.success === false && textless.text === undefined,
  JSON.stringify(textless)
);
check(
  '5d: and it says the pane is UNKNOWN rather than empty',
  typeof textless.error === 'string' && /UNKNOWN rather than empty/.test(textless.error),
  textless.error
);

// §5e — a source name we do not recognise narrows to `null` rather than being
// passed through the type unchecked. `sourcesTried` still reports what they said,
// minus what we cannot name.
tailReply = {
  success: true,
  text: 'something',
  truncated: false,
  source: 'a-source-nobody-has-heard-of',
  sourcesTried: ['recent-unwrapped', 'a-source-nobody-has-heard-of']
};
const unknownSource = await crab.tailAgent('kan-1', TYPE, 60);
check(
  '5e: an unrecognised source becomes null rather than being smuggled through the type',
  unknownSource.success === true && unknownSource.source === null,
  JSON.stringify(unknownSource)
);
check(
  '5e: and sourcesTried drops only what we cannot name',
  JSON.stringify(unknownSource.sourcesTried) === JSON.stringify(['recent-unwrapped']),
  JSON.stringify(unknownSource)
);

// §5f — an address with no type and no session. There is no path to ask about,
// and inventing one would tail the wrong agent.
const unaddressed = await crab.tailAgent('kan-1');
check(
  '5f: a bare key with no session refuses rather than guessing a path',
  unaddressed.success === false && /cannot be addressed/.test(String(unaddressed.error)),
  JSON.stringify(unaddressed)
);

crab.dispose();
await new Promise((r) => server.close(r));
fs.rmSync(sockDir, { recursive: true, force: true });

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${checks} checks, ${failures} failed`);
console.log(`VERDICT: ${failures ? 'FAIL' : 'PASS'}`);

fs.rmSync(scratch, { recursive: true, force: true });

process.exit(failures ? 1 : 0);
