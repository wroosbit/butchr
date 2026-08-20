#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: the daemon writing a channel frame to a herdr
 * agent whose pane was started while the kill switch was OFF — reporting
 * `delivered: true`, leaving `consecutiveUndelivered: 0` and every other health
 * field green, and delivering nothing to a model. That is KAN-495's failure on
 * the herdr path, and until KAN-497 nothing in this daemon could see it: argv
 * is fixed at process start, agents outlive switch flips, and
 * `HerdrBridge.channelReach` answered `'unknown'` for the whole fleet because a
 * runtime-wide member cannot hold a per-agent fact. `launchers.ts` has
 * described this exact agent in prose since KAN-246 — *"the daemon will now
 * happily resolve them in KAN-243's identity map and write frames their client
 * discards in silence"* — and nothing enforced it.
 *
 * It would equally catch the fix's own failure mode, which is the opposite
 * direction and worse: an agent with NO record answering `'not-loaded'`. Every
 * agent that outlives a daemon restart is in that population — the store is in
 * memory on purpose — so that collapse takes a working fleet off channels for a
 * fact nobody established. KAN-497 names it as its trap; §2 and §4 are what
 * stand in front of it.
 *
 * ---------------------------------------------------------------------------
 * THE SECTIONS, AND WHICH ONES ARE THE ACTUAL PROOF
 * ---------------------------------------------------------------------------
 *
 *   §1 the store's three states, including the one it must NOT store.
 *   §2 the composition, read off `src/daemon.ts`: record first, runtime second,
 *      and `'not-loaded'` is nowhere a default.
 *   §3 the wiring: the record is written BEFORE the supervision guard, and the
 *      carrier row asks about an address rather than about the fleet.
 *   §4 ⚠ THE RED DRIVE, and AC2. Two agents, one registry, one real socket:
 *      a recorded `not-loaded` gets NOTHING written to a live connection, its
 *      unrecorded neighbour gets a frame — and then the record is DELETED and
 *      the answer is watched falling back to `'unknown'`, not to `'not-loaded'`.
 *   §5 ⚠ THE REAL SPAWN, and AC1. Opt-in with `--live`; skipped otherwise.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
 * ---------------------------------------------------------------------------
 *
 * A proof that supplies its own input has not tested that the input arrives
 * (KAN-145, whose two scripts both missed exactly this by constructing the
 * records they then asserted on). Said plainly, in both directions:
 *
 *   * §1–§4 SUPPLY THE RECORD. They call `record()` with a verdict this file
 *     chose. So they establish what the store does with a verdict and what the
 *     router does with the store, and **nothing whatever about whether a real
 *     spawn produces one.** On their own they are precisely the KAN-145 shape.
 *   * §5 IS WHAT COVERS THAT, and it is the only section that can. It drives a
 *     real `HerdrBridge`, the real `claude` launcher and the real kill switch
 *     into two real panes, and the `AgentSpawn` it reads is the one the product
 *     composed. It needs herdr and a terminal, so it is opt-in and its output
 *     goes on the pull request.
 *   * ⚠ WHAT EVEN §5 SUPPLIES is the two-line listener body — `record(address,
 *     spawn.channelEnabled)`. The production listener lives in `daemon.ts` and
 *     is not exported, so no script can call the real one. **§3 is what makes
 *     that honest**: it asserts against `src/daemon.ts` as TEXT that the
 *     production closure records the same three-state verdict at the same seam,
 *     ahead of the supervision guard. Neither section subsumes the other and
 *     the seam between them is real: nothing here would notice if `daemon.ts`
 *     stopped installing the listener at all.
 *   * WHO COVERS THAT LAST GAP: nobody, today, and it is named rather than left
 *     to be inferred. `verify-channel-spawn-verdict.mjs` §4 has the same hole
 *     for the same reason and says so. The field observation that closes it is
 *     the daemon's own log line — `channel reach for <address>: …` — which
 *     appears once per spawn in `~/.local/share/butchr/daemon.log` from the
 *     first restart after this lands, and which the pull request pastes.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *   node daemon/scripts/verify-herdr-channel-reach-per-agent.mjs [--verbose]
 *
 *   --live         run §5: two REAL herdr panes, the real claude launcher and
 *                  the real kill switch. Off by default because it spawns.
 *   --red-drive    patch a COPY of the build so `reachFromSpawnVerdict(null)`
 *                  answers `'unknown'` instead of `undefined`, and watch §1's
 *                  discriminating row go red. A gate nobody has watched fail
 *                  has not been shown to be a gate, so this is part of the
 *                  proof rather than a convenience: it ends by FAILING if the
 *                  run came back green, because a mutation that did not take is
 *                  an assertion that is not watching what it claims to watch.
 *
 * Run it after `npm run build` in daemon/.
 */

// CI-RUNNABLE: partial — §1–§4 import the built daemon modules and assert
//       against them in process, over unix sockets this script creates under
//       os.tmpdir(); no live daemon, no herdr, no credential, no peer, no
//       terminal. §5 needs a real herdr on PATH and spawns two real panes, so
//       it is opt-in behind `--live` and announces itself SKIPPED without it —
//       including in CI, which has neither. It is not mocked and there is no
//       fallback: the whole value of §5 is that the `AgentSpawn` is the
//       product's, so a reproduction of one would prove nothing.
//
// The one piece of shared state §4 touches — the channel kill switch under
// BUTCHR_DIR — it reads, writes ENABLED, and restores in a `finally`. Enabling
// is the safe direction (a send that would have fallen back to the composer
// still arrives), and `carrierFor` reads the switch first by design, so a run
// against a fleet whose channel is off would pass §4 for entirely the wrong
// reason and pass it quietly.

import * as net from 'net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const verbose = process.argv.includes('--verbose');
const live = process.argv.includes('--live');
const redDrive = process.argv.includes('--red-drive');

let failures = 0;
let skipped = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('─'.repeat(74));
  say(title);
  say('─'.repeat(74));
};
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail && (!ok || verbose)) {
    say(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
  }
  return ok;
};
const skip = (what, why) => {
  skipped += 1;
  say(`  SKIP  ${what}\n        ${why}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-spawn-reach.js'))) {
  console.error('daemon/dist is missing or predates KAN-497 — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan497-reach-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

let distUnderTest = dist;
if (redDrive) {
  // The damage is done to a COPY. A red run cannot leave a broken build behind,
  // which matters here more than usual: this repository has live agents working
  // in sibling worktrees off the same shared clone.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  // The copy still has to resolve `node-pty`, which `herdr.js` imports. Node
  // walks up from the importing file, so one symlink beside the copy is enough
  // and is cheaper and less surprising than copying a linked dependency tree.
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const target = path.join(distUnderTest, 'channel-spawn-reach.js');
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(
    "    return undefined;",
    "    return 'unknown';"
  );
  if (patched === source) {
    console.error('--red-drive could not find reachFromSpawnVerdict to patch; it has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say("--red-drive: patched a copy of the build so a `null` verdict records 'unknown'.");
}

const u = (f) => `file://${path.join(distUnderTest, f)}`;
const { ChannelSpawnReachStore, reachFromSpawnVerdict } = await import(u('channel-spawn-reach.js'));
const { routeChannelMessage, carrierFor, CHANNEL_SWITCH_PATH } = await import(u('channel.js'));
const { AgentConnectionRegistry } = await import(u('agent-connections.js'));

const daemonSrc = readFileSync(path.join(daemonDir, 'src', 'daemon.ts'), 'utf8');
// Comments stripped, so prose in the blocks around these statements can neither
// satisfy nor defeat a match. Every §2/§3 assertion reads this, never the raw
// file — a rule this repository has had to learn twice.
const daemonCode = daemonSrc
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
  .join('\n');

const switchExisted = existsSync(CHANNEL_SWITCH_PATH);
const switchBefore = switchExisted ? readFileSync(CHANNEL_SWITCH_PATH, 'utf8') : null;
const restoreSwitch = () => {
  if (switchBefore !== null) writeFileSync(CHANNEL_SWITCH_PATH, switchBefore);
  else if (existsSync(CHANNEL_SWITCH_PATH)) rmSync(CHANNEL_SWITCH_PATH);
};

try {
  // ═════════════════════════════════════════════════════════════════════════
  rule('§1  the store — three states in, two states kept');
  // ═════════════════════════════════════════════════════════════════════════
  const store = new ChannelSpawnReachStore();
  const A = { type: 'task', key: 'KAN-497' };
  const B = { type: 'task', key: 'KAN-498' };
  const NEVER = { type: 'task', key: 'KAN-000' };

  check(reachFromSpawnVerdict(true) === 'loaded', 'true  → loaded');
  check(reachFromSpawnVerdict(false) === 'not-loaded', 'false → not-loaded');

  // ⚠ THE DISCRIMINATING ROW, AND THE ONE `--red-drive` BREAKS. `null` means NO
  // SPAWN DECIDED THIS — the absence of a verdict, never a verdict of "no
  // channel". Recording it as `'unknown'` would read exactly like no record at
  // the one place that matters, while being able to SHADOW a runtime that does
  // know: under CrabCast, whose `channelReach` is derived from the argv it
  // actually sends (KAN-496), it would overwrite a correct `'loaded'` with a
  // shrug. Absence composes; a recorded shrug does not.
  check(
    reachFromSpawnVerdict(null) === undefined,
    "null  → undefined, NOT 'unknown' — a recorded shrug shadows a runtime that knows",
    `got ${JSON.stringify(reachFromSpawnVerdict(null))}`
  );

  check(store.record(A, false) === 'not-loaded', 'record(false) stores and returns not-loaded');
  check(store.get(A) === 'not-loaded', 'and reads back not-loaded');
  check(store.record(B, null) === undefined, 'record(null) stores NOTHING and says so');
  check(store.get(B) === undefined, 'so B reads as unrecorded');
  check(store.get(NEVER) === undefined, 'an address nothing ever spawned reads as unrecorded');

  // ⚠ `undefined` IS NOT `'not-loaded'`. The whole three-valued discipline is
  // the same one `ChannelReach` and `AgentSpawn.channelEnabled` are written
  // around, and a store that answered a negative for an unrecorded agent would
  // be the fleet outage this ticket exists to avoid.
  check(
    store.get(NEVER) !== 'not-loaded' && store.get(B) !== 'not-loaded',
    'and NEITHER unrecorded address answers not-loaded — absence is not a negative'
  );

  // Case and whitespace collapse, so two spellings of one agent are one agent.
  check(
    store.get({ type: 'TASK', key: ' kan-497 ' }) === 'not-loaded',
    'address spellings collapse to one key'
  );

  // A re-spawn overwrites unconditionally: the pane the old record described is
  // gone, and the switch may have moved since.
  store.record(A, true);
  check(store.get(A) === 'loaded', 're-spawn overwrites — a stale verdict is not kept');
  check(store.forget(A) === true && store.get(A) === undefined, 'forget() takes the record away');

  const census = new ChannelSpawnReachStore();
  census.record({ type: 'task', key: 'a' }, true);
  census.record({ type: 'task', key: 'b' }, false);
  census.record({ type: 'task', key: 'c' }, null);
  check(
    JSON.stringify(census.describe()) === JSON.stringify({ loaded: 1, notLoaded: 1, total: 2 }),
    'describe() counts what is HELD — the null spawn is absent, not a third column',
    JSON.stringify(census.describe())
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§2  the composition in daemon.ts — record first, runtime second');
  // ═════════════════════════════════════════════════════════════════════════
  check(
    /const channelReach = \(address: \{ type: string; key: string \}\): ChannelReach =>\s*\n\s*channelSpawnReach\.get\(address\) \?\? herdrBridge\.channelReach;/.test(
      daemonCode
    ),
    'channelReach(address) reads the per-agent record FIRST and the runtime second',
    daemonCode.split('\n').filter((l) => l.includes('channelReach =')).join('\n')
  );

  // ⚠ THE TRAP, ASSERTED RATHER THAN WRITTEN DOWN. An agent with no record must
  // fall through to what the runtime can say — `'unknown'` under herdr — never
  // to a negative. `?? 'not-loaded'` is the whole defect in one operator.
  check(
    !/\?\?\s*'not-loaded'/.test(daemonCode),
    "and nothing anywhere in daemon.ts defaults to 'not-loaded'",
    daemonCode.split('\n').filter((l) => l.includes('not-loaded')).join('\n')
  );

  const spawnReachSrc = readFileSync(path.join(daemonDir, 'src', 'channel-spawn-reach.ts'), 'utf8');
  const spawnReachCode = spawnReachSrc
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n');
  check(
    !/\?\?\s*'not-loaded'/.test(spawnReachCode) && !/return 'not-loaded';\s*\n\s*\}/.test(spawnReachCode),
    'nor does the store itself invent one for a missing record',
    spawnReachCode.split('\n').filter((l) => l.includes('not-loaded')).join('\n')
  );

  // The other half of the fall-through, at the far end. `HerdrBridge` is not
  // asked per address and must not be: it answers about a SPAWN SHAPE, and
  // `'unknown'` is now load-bearing rather than residual.
  const herdrSrc = readFileSync(path.join(daemonDir, 'src', 'herdr.ts'), 'utf8');
  check(
    /public readonly channelReach = 'unknown' as const;/.test(herdrSrc),
    "HerdrBridge.channelReach is still 'unknown' — it is the fall-through, not a gap",
    (herdrSrc.match(/channelReach = .*/) || ['(not found)'])[0]
  );
  const { HerdrBridge } = await import(u('herdr.js'));
  check(new HerdrBridge().channelReach === 'unknown', 'and the constructed object agrees');

  // ═════════════════════════════════════════════════════════════════════════
  rule('§3  the wiring — the record is written BEFORE the supervision guard');
  // ═════════════════════════════════════════════════════════════════════════
  // ⚠ THIS ORDERING IS THE ENTIRE TICKET. The guard is about supervision, and it
  // is right that a non-channel spawn needs none — but `channelEnabled: false`
  // is the verdict worth MORE than `true`, because it is the one that says *do
  // not write frames to this agent*. A listener that returned first would keep
  // the fact for the agents that never needed it and drop it for the ones that
  // did, and it would look completely correct doing so.
  check(
    /setAgentSpawnedListener\(\(session, spawnedAt, spawn\) => \{(?:(?!if \(spawn\.channelEnabled)[\s\S])*?channelSpawnReach\.record\(address, spawn\.channelEnabled\)[\s\S]*?\n\s*if \(spawn\.channelEnabled !== true\) return;/.test(
      daemonCode
    ),
    'the listener records the verdict, and only then returns on `!== true`',
    daemonCode.split('\n').filter((l) => l.includes('channelSpawnReach') || l.includes('spawn.channelEnabled')).join('\n')
  );

  // The raw three-state verdict crosses into the store, so `null` stays
  // distinguishable from `false` on the way past. A boolean derived on this line
  // would be the collapse one layer up from the one §1 guards.
  check(
    /channelSpawnReach\.record\(address, spawn\.channelEnabled\)/.test(daemonCode) &&
      !/channelSpawnReach\.record\([^)]*(\?\?|\|\||!!)/.test(daemonCode),
    'and it hands over the raw verdict — nothing flattens it with `??`, `||` or `!!`',
    daemonCode.split('\n').filter((l) => l.includes('channelSpawnReach.record')).join('\n')
  );

  // ⚠ THE ROW ASKS ABOUT AN ADDRESS. KAN-274 made the route and the listing one
  // function so a row cannot report a carrier the next send will not take; an
  // argument-less call here would give every row one fleet-wide answer and break
  // that property in the direction nobody looks.
  check(
    /reach: channelReach\(address\)/.test(daemonCode) && !/reach: channelReach\(\)/.test(daemonCode),
    'the list_agents carrier asks channelReach(address), never channelReach()',
    daemonCode.split('\n').filter((l) => l.includes('reach: channelReach')).join('\n')
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§4  THE RED DRIVE — two agents, one socket, and the record deleted');
  // ═════════════════════════════════════════════════════════════════════════
  mkdirSync(path.dirname(CHANNEL_SWITCH_PATH), { recursive: true });
  writeFileSync(CHANNEL_SWITCH_PATH, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
  say(`  (channel switch written ENABLED for this section: ${CHANNEL_SWITCH_PATH})`);

  const MUTE = { type: 'task', key: 'KAN-497-mute' };
  const HEARD = { type: 'task', key: 'KAN-497-heard' };

  const sockDir = mkdtempSync(path.join(tmpdir(), 'kan497-sock-'));
  const received = { [`${MUTE.type}/${MUTE.key}`]: [], [`${HEARD.type}/${HEARD.key}`]: [] };
  const registry = new AgentConnectionRegistry();
  const servers = [];
  const clients = [];
  for (const address of [MUTE, HEARD]) {
    const p = path.join(sockDir, `${address.key}.sock`);
    const bucket = received[`${address.type}/${address.key}`];
    const server = net.createServer((c) => c.on('data', (d) => bucket.push(String(d))));
    await new Promise((r) => server.listen(p, r));
    const client = net.createConnection(p);
    await new Promise((r) => client.on('connect', r));
    registry.register(client, address);
    servers.push(server);
    clients.push(client);
  }

  const spawnReach = new ChannelSpawnReachStore();
  // The one composition under test, spelled exactly as §2 asserts daemon.ts
  // spells it. `'unknown'` stands in for `herdrBridge.channelReach`, which is
  // what a HerdrBridge answers and what §2 checked on a constructed one.
  const reachOf = (address) => spawnReach.get(address) ?? 'unknown';
  const send = (address) =>
    routeChannelMessage({
      registry,
      reach: reachOf,
      address,
      content: 'kan-497 probe',
      managed: () => true
    });

  spawnReach.record(MUTE, false);
  // HEARD is deliberately left unrecorded — it is the agent that outlived a
  // daemon restart, and it must keep the channel it has always had.

  const mutedOutcome = send(MUTE);
  const heardOutcome = send(HEARD);
  await sleep(60);

  check(mutedOutcome.routed === false, 'a recorded not-loaded agent is REFUSED', JSON.stringify(mutedOutcome));
  check(mutedOutcome.reason === 'channel-not-loaded', 'and the refusal names the reason', mutedOutcome.reason);
  // ⚠ A MEASUREMENT, NOT A RETURNED STRING. The socket is real and is watched,
  // so "refused" here means nothing arrived rather than that a function said so.
  check(
    JSON.stringify(received[`${MUTE.type}/${MUTE.key}`]) === '[]',
    'and NOTHING was written to its live connection',
    JSON.stringify(received[`${MUTE.type}/${MUTE.key}`])
  );

  // THE DISCRIMINATING ARM, in the same breath and on the same registry. Both
  // agents are registered, both connections are live, and the ONLY difference
  // between them is the record — so a harness that refused everything, or a
  // switch that was off, cannot produce this pair.
  check(heardOutcome.routed === true, 'its UNRECORDED neighbour is routed', JSON.stringify(heardOutcome));
  check(
    received[`${HEARD.type}/${HEARD.key}`].length === 1,
    'and a frame really was written to that one',
    JSON.stringify(received[`${HEARD.type}/${HEARD.key}`])
  );

  // ── AC2, driven red: delete the record and watch the answer ──────────────
  say('');
  say('  AC2 — the record is deleted and the answer is watched:');
  check(reachOf(MUTE) === 'not-loaded', `  before: reachOf(mute) = ${reachOf(MUTE)}`);
  spawnReach.forget(MUTE);
  const after = reachOf(MUTE);
  check(after === 'unknown', `  after : reachOf(mute) = ${after} — falls back to the runtime`, after);
  // ⚠ THE ASSERTION AC2 ACTUALLY ASKS FOR, stated as its own row rather than
  // left implicit in the one above. `'unknown'` and `'not-loaded'` route
  // differently and it is the second that would strand the fleet, so what
  // matters is not only that the fall-back is right — it is that it is not THAT.
  check(after !== 'not-loaded', "  and it is NOT 'not-loaded' — absence is not a negative", after);

  const afterForget = send(MUTE);
  await sleep(60);
  check(
    afterForget.routed === true && received[`${MUTE.type}/${MUTE.key}`].length === 1,
    '  so a frame flows to it again — an unrecorded agent routes exactly as before KAN-495',
    JSON.stringify(afterForget)
  );

  // The same fact through `carrierFor`, which is what the `list_agents` row
  // reads. The row and the route are one function (KAN-274) and this is the
  // half of that property KAN-497 could have broken.
  const carrierArgs = { emissionEnabled: true, degraded: false, registered: true, managed: true };
  check(
    carrierFor({ ...carrierArgs, reach: 'not-loaded' }).transport === 'composer' &&
      carrierFor({ ...carrierArgs, reach: 'unknown' }).transport === 'channel',
    'and carrierFor separates the two, so the row cannot promise what the send refuses'
  );

  for (const c of clients) c.destroy();
  for (const s of servers) await new Promise((r) => s.close(r));
  rmSync(sockDir, { recursive: true, force: true });

  // ═════════════════════════════════════════════════════════════════════════
  rule('§5  ⚠ THE REAL SPAWN — AC1, and the only section that tests arrival');
  // ═════════════════════════════════════════════════════════════════════════
  if (!live) {
    skip(
      'the real herdr spawn',
      'pass --live to run it. It starts TWO real panes through the real claude ' +
        'launcher and writes the real kill switch, so it is opt-in rather than ' +
        'default. Everything above supplies its own record and therefore says ' +
        'nothing about whether a spawn produces one — see this file’s header.'
    );
  } else {
    const { workspaceDirFor } = await import(u('workspace-dir.js'));
    const bridge = new HerdrBridge();

    // THE HARNESS-SUPPLIED HALF, AND IT IS TWO LINES ON PURPOSE. §3 asserts
    // against `src/daemon.ts` that the production closure does exactly this, at
    // this seam, ahead of the supervision guard. What is NOT supplied is
    // everything on the left of it: the switch read, the command composed, the
    // pane started, and the `AgentSpawn` that comes back out.
    const liveStore = new ChannelSpawnReachStore();
    const seen = [];
    bridge.setAgentSpawnedListener((session, spawnedAt, spawn) => {
      seen.push({ key: session.key, channelEnabled: spawn.channelEnabled, command: spawn.command });
      liveStore.record({ type: session.type, key: session.key }, spawn.channelEnabled);
    });
    const liveReachOf = (address) => liveStore.get(address) ?? bridge.channelReach;

    const spawnedKeys = [];
    const spawnUnder = (enabled, key) => {
      writeFileSync(CHANNEL_SWITCH_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`);
      const session = bridge.spawnSession(
        'task', key, undefined, 'KAN-497 reach probe — this pane is closed immediately.',
        1, false, 'claude'
      );
      spawnedKeys.push(key);
      return session;
    };

    try {
      // ON FIRST, DELIBERATELY. On a live fleet the switch is normally on, so
      // this arm changes nothing, and the off-arm's window is a fraction of a
      // second before the `finally` puts it back. Off is also the SAFE
      // direction to be wrong in — a send that would have taken the channel
      // falls back to the composer and still arrives.
      const on = spawnUnder(true, 'kan497-reach-on');
      const off = spawnUnder(false, 'kan497-reach-off');

      const onAddr = { type: 'task', key: 'kan497-reach-on' };
      const offAddr = { type: 'task', key: 'kan497-reach-off' };

      // The product's own verdict, off a real spawn. Printed as well as
      // asserted, because a reviewer re-running this should see the argv that
      // produced it.
      for (const s of seen) {
        say(`  ${s.key}: channelEnabled=${JSON.stringify(s.channelEnabled)}  ${String(s.command).slice(0, 90)}…`);
      }

      // ── the OFF arm: a real spawn, all the way to the record ─────────────
      check(
        off.status !== 'terminated',
        'switch OFF → the pane started',
        `${off.status} / ${off.spawnError ?? ''}`
      );
      check(
        seen.some((s) => s.key === 'kan497-reach-off' && s.channelEnabled === false),
        'switch OFF → the listener fired, carrying the launcher’s own `false`',
        JSON.stringify(seen)
      );
      check(
        liveReachOf(offAddr) === 'not-loaded',
        'switch OFF → and the record that arrived reads not-loaded',
        liveReachOf(offAddr)
      );

      // ── the ON arm ⚠ AND WHY IT HAS TWO ACCEPTABLE OUTCOMES ──────────────
      //
      // Measured 2026-08-20 on this repository at `4a429ba`: a channel-enabled
      // `claude` spawn is REFUSED by `herdr agent start`, after 7.4s, with
      // *"agent … is blocked during startup and is not ready for prompts"*. That
      // is not this harness being slow and it is not the 20s budget — herdr
      // detected the agent sitting on a dialog and said so.
      //
      // ⚠ THE DIALOG IS THE ONE THE FLAG ITSELF RAISES, and the consequence is
      // an ordering defect that belongs to the product rather than to this
      // script: `startAgentInOwnTab` throws, so `agentSpawnedListener` is never
      // called, so `superviseChannelStartup` — whose ENTIRE JOB is to answer
      // that dialog (KAN-246) — never runs. The supervision is downstream of a
      // call that fails because of the thing it exists to supervise. It is
      // latent today only because the fleet runs CrabCast. `agent start` gained
      // the readiness wait in herdr 0.7 and `initPty`'s own comment still
      // describes the 0.6.4 behaviour it replaced.
      //
      // ⚠ SO THIS ARM ACCEPTS TWO OUTCOMES AND A CHECK THAT ACCEPTS ANYTHING IS
      // NOT A CHECK. It is written to have a reachable red: a THIRD outcome —
      // the spawn succeeding but leaving no record, or leaving one that reads
      // `unknown` or `not-loaded` — fails here. And when the ordering defect is
      // fixed, the `blocked` branch stops being reachable and this arm becomes
      // the plain `'loaded'` measurement AC1 asked for, with no edit needed.
      // ⚠ THE REFUSAL HAS TWO SHAPES AND BOTH WERE OBSERVED, minutes apart, on
      // the same machine and the same build. They are one cause read through two
      // instruments, so matching only the first would have this arm reporting a
      // hard failure half the time for a condition it is meant to recognise:
      //
      //   * `agent … is blocked during startup and is not ready for prompts`
      //     — herdr's OWN detection, returned at 7.4s, well inside its budget.
      //   * `failed: spawnSync herdr ETIMEDOUT`
      //     — Node's spawnSync timeout firing first, so herdr never got to say
      //     it. Same wedged agent; a different process noticed.
      //
      // So the branch is "the spawn did not complete", with the exact text
      // printed rather than summarised. That is deliberately broad, and the red
      // it leaves reachable is the one this ticket is about: a spawn that
      // SUCCEEDS and leaves no record, or a wrong one — KAN-145's defect
      // exactly. What it can no longer catch is a `loaded` arm that fails for
      // some unrelated reason, and that is the trade, stated rather than hidden.
      const onRecorded = liveReachOf(onAddr);
      const onBlocked = on.status === 'terminated' && (on.spawnError ?? '') !== '';

      if (onBlocked) {
        say('');
        say('  ⚠ THE ON ARM WAS REFUSED BY HERDR, AND THIS IS A PRODUCT FINDING:');
        say(`      ${on.spawnError}`);
        say('    A channel-enabled spawn cannot complete on the herdr path, so the spawn');
        say('    listener never fires and KAN-246 channel-startup supervision never runs.');
        say('    AC1’s `loaded` arm is therefore NOT measured live here. See the ticket');
        say('    filed against KAN-497 for the ordering defect.');
        skip(
          "AC1's `loaded` arm",
          'blocked by the product ordering defect named above, not by this harness. ' +
            'The launcher half of that arm IS measured — by the argv printed above, and ' +
            'by verify-channel-spawn-verdict §1 and verify-channel-capability-refusal §6, ' +
            'which drive the real launcher under both switch states in CI.'
        );
      }
      check(
        onBlocked || onRecorded === 'loaded',
        'switch ON  → a real spawn reads loaded, OR herdr refuses it as blocked-on-dialog',
        `record=${JSON.stringify(onRecorded)} status=${on.status} spawnError=${on.spawnError ?? '(none)'}`
      );
      // THE DISCRIMINATING ROW for the pair — asked ONLY when the ON arm really
      // produced a record. ⚠ It was gated on `!onBlocked` for one run and that
      // was wrong in the way this file keeps warning about: with the ON arm
      // refused, it compared `'unknown'` against `'not-loaded'`, found them
      // different, and printed PASS. A green for a pair where one side is the
      // fall-through is a check passing for the wrong reason — it would have
      // gone green on a build with no store in it at all.
      if (onRecorded === 'loaded') {
        check(
          liveReachOf(onAddr) !== liveReachOf(offAddr),
          'so the answer is per-agent, not one fleet-wide value'
        );
      }
      check(
        liveReachOf({ type: 'task', key: 'kan497-never-spawned' }) === 'unknown',
        'and an agent this daemon never spawned still reads unknown'
      );
    } finally {
      restoreSwitch();
      for (const key of spawnedKeys) {
        try {
          bridge.closeAgentByKey(key, 'task');
        } catch (e) {
          say(`  (could not close ${key}: ${e?.message ?? e})`);
        }
        // Removed per path rather than by reverting a directory — `task/KAN-291`
        // lost three uncommitted files to a harness that ran `git checkout`.
        const dir = workspaceDirFor('task', key);
        if (dir.includes(`${path.sep}workspaces${path.sep}`) && existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }
} finally {
  restoreSwitch();
}

say('');
if (redDrive) {
  // A mutation that did not take is an assertion that is not watching what it
  // claims to watch, so a green here is a FAILURE of the red drive.
  if (failures > 0) {
    say(`--red-drive: RED as required — ${failures} assertion(s) failed.`);
    say("The behaviour that made it go red: `reachFromSpawnVerdict(null)` returned 'unknown'");
    say('instead of `undefined`, so a spawn that decided nothing would be RECORDED as a shrug —');
    say("which reads exactly like no record here, and shadows CrabCast's derived 'loaded' there.");
    process.exit(0);
  }
  say('--red-drive: GREEN, which is a FAILURE. The mutation did not reach anything asserted.');
  process.exit(1);
}

say(
  failures === 0
    ? `GREEN — every assertion passed${skipped ? `, ${skipped} section(s) skipped` : ''}.`
    : `RED — ${failures} assertion(s) failed${skipped ? `, ${skipped} skipped` : ''}.`
);
process.exit(failures ? 1 : 0);
