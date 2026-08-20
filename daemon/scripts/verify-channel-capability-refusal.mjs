#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: the daemon writing a channel frame to an agent
 * whose client cannot render one — reporting `delivered: true`, leaving every
 * health field green, and delivering nothing. That is KAN-495: from the CrabCast
 * cutover at 05:46:21Z on 2026-08-16, guardian pokes, the liveness probe,
 * Jira-poll notices and agent-to-agent steers were all written to live
 * connections and none reached a model, for ~75 minutes, with
 * `consecutiveUndelivered: 0` and `overdue: false` throughout.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE SECTIONS, AND WHICH ONE IS THE ACTUAL PROOF
 * ---------------------------------------------------------------------------
 *
 *   §1 `carrierFor` refuses on `not-loaded` and is unchanged on `unknown`.
 *   §2 `routeChannelMessage` writes NOTHING to a live socket when reach is
 *      `not-loaded` — the socket is real and is watched, so "refused" is a
 *      measurement rather than a returned string.
 *   §3 each runtime's spawn-shape answer, AND herdr's per-agent record
 *      layered over it — one runtime, three agents, three answers (KAN-497).
 *   §4 ⚠ THE RED DRIVE. The alarm that was blind is shown going off, and shown
 *      staying green on the pre-fix input. This is the section that matters.
 *   §5 the KAN-319 `meta` prior, ruled out rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * §4 IS TWO-ARMED ON PURPOSE, AND THE GREEN ARM IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * A check that only showed the alarm firing would prove the alarm can fire. It
 * would not show that the alarm **could not have fired before**, which is the
 * whole defect: `GuardianRecord` has had `consecutiveUndelivered`, `overdue` and
 * a loud undelivered log line since KAN-284, and every one of them was working.
 * They read green because the thing upstream of them answered `routed: true`.
 *
 * So §4 runs the REAL `GuardianPoker` over the REAL `routeChannelMessage` and a
 * real socket, twice, changing one input:
 *
 *   arm PRE  (`reach: 'unknown'`)    -> delivered, undelivered 0, overdue false
 *   arm POST (`reach: 'not-loaded'`) -> undelivered, count climbs, overdue TRUE
 *
 * The PRE arm is this script's positive control in reverse: it reproduces the
 * silent green on a frame that would have been discarded, so the POST arm's red
 * is attributable to the fix and to nothing else about the harness.
 *
 * ⚠ **WHAT THIS DOES NOT COVER, and the sibling that does.** Every frame here is
 * one this script constructed, and §1–§4 assert on a daemon-side decision. So
 * this establishes that the daemon **stops writing** frames a client cannot
 * render, and establishes NOTHING about whether that client can in fact render
 * one — the premise the whole fix rests on. That premise is measured from the
 * other side, against two live `claude` sessions with a positive control, by
 * `daemon/scripts/probe-channel-reaches-model.mjs`. Neither script covers the
 * other's half and the gap between them is real: nothing here would notice if
 * the client's behaviour changed and `not-loaded` became a lie.
 *
 * Usage: node daemon/scripts/verify-channel-capability-refusal.mjs
 */

// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
// Its sockets are unix sockets it creates under os.tmpdir(), and the one piece
// of shared state it touches — the channel kill switch under BUTCHR_DIR — it
// reads, overwrites and restores in a `finally`, which the CI runner sandboxes
// per child anyway.

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { carrierFor, routeChannelMessage, CHANNEL_SWITCH_PATH } from '../dist/channel.js';
import { AgentConnectionRegistry } from '../dist/agent-connections.js';
import { GuardianPoker, OVERDUE_INTERVALS } from '../dist/guardian.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'} ${label}\n` +
      (ok ? '' : `       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}\n`)
  );
  return ok;
};

/**
 * The kill switch has to be ON for any of this to be about reach at all.
 *
 * `carrierFor` reads the switch first by design — a shut gate answers
 * `channel-disabled` for everything — so a run against a fleet whose channel is
 * off would pass §1 and §2 for entirely the wrong reason, and pass them
 * *quietly*. Restored in a `finally`.
 */
const switchExisted = fs.existsSync(CHANNEL_SWITCH_PATH);
const switchBefore = switchExisted ? fs.readFileSync(CHANNEL_SWITCH_PATH, 'utf8') : null;
const restoreSwitch = () => {
  if (switchBefore !== null) fs.writeFileSync(CHANNEL_SWITCH_PATH, switchBefore);
  else if (fs.existsSync(CHANNEL_SWITCH_PATH)) fs.rmSync(CHANNEL_SWITCH_PATH);
};

process.stdout.write(`channel switch: ${CHANNEL_SWITCH_PATH}\n`);
if (!switchExisted) {
  process.stdout.write('  (absent — writing an enabled one for this run, restored at the end)\n');
}
// BUTCHR_DIR may not exist at all. The CI runner sandboxes HOME per child, so
// this script meets a home directory with no .local/share/butchr in it — and an
// ENOENT here would fail the script for a reason that has nothing to do with
// what it tests. Measured: it did exactly that on its first CI-set run.
fs.mkdirSync(path.dirname(CHANNEL_SWITCH_PATH), { recursive: true });
fs.writeFileSync(CHANNEL_SWITCH_PATH, JSON.stringify({ enabled: true }, null, 2) + '\n');

try {
  // -------------------------------------------------------------------------
  process.stdout.write('\n§1 carrierFor\n');
  // -------------------------------------------------------------------------
  const base = { emissionEnabled: true, degraded: false, registered: true, managed: true };

  check('unknown  -> channel (unchanged from before KAN-495)',
    carrierFor({ ...base, reach: 'unknown' }).transport, 'channel');
  check('reach absent -> channel (an unwired caller routes as before)',
    carrierFor({ ...base }).transport, 'channel');
  check('loaded   -> channel',
    carrierFor({ ...base, reach: 'loaded' }).transport, 'channel');

  const notLoaded = carrierFor({ ...base, reach: 'not-loaded' });
  check('not-loaded -> composer', notLoaded.transport, 'composer');
  check('not-loaded -> refusal channel-not-loaded', notLoaded.refusal, 'channel-not-loaded');

  // ORDERING. The gate still comes first and a degraded agent still reads as
  // degraded — this branch was inserted between them and must not have moved
  // either, because both orderings carry arguments of their own (channel.ts).
  check('a shut gate still wins over not-loaded',
    carrierFor({ ...base, emissionEnabled: false, reach: 'not-loaded' }).refusal,
    'channel-disabled');
  check('degraded still wins over not-loaded',
    carrierFor({ ...base, degraded: true, reach: 'not-loaded' }).refusal,
    'selfcheck-failed');
  // AND THE ONE THAT IS THE FIX: a live registration must NOT win.
  check('not-loaded beats a live registration (this is the defect)',
    carrierFor({ ...base, registered: true, reach: 'not-loaded' }).refusal,
    'channel-not-loaded');

  // -------------------------------------------------------------------------
  process.stdout.write('\n§2 routeChannelMessage — measured at the socket\n');
  // -------------------------------------------------------------------------
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k495-'));
  const sockPath = path.join(sockDir, 's');
  const received = [];
  const server = net.createServer((c) => c.on('data', (d) => received.push(String(d))));
  await new Promise((r) => server.listen(sockPath, r));
  const socket = net.createConnection(sockPath);
  await new Promise((r) => socket.on('connect', r));

  const registry = new AgentConnectionRegistry();
  const address = { type: 'task', key: 'KAN-495' };
  registry.register(socket, address);

  const settle = () => new Promise((r) => setTimeout(r, 60));

  received.length = 0;
  const routedUnknown = routeChannelMessage({
    registry, address, content: 'pre-fix frame', reach: () => 'unknown'
  });
  await settle();
  check('unknown  -> routed', routedUnknown.routed, true);
  check('unknown  -> bytes actually reached the socket', received.length > 0, true);

  received.length = 0;
  const routedNotLoaded = routeChannelMessage({
    registry, address, content: 'frame that must not be written', reach: () => 'not-loaded'
  });
  await settle();
  check('not-loaded -> refused', routedNotLoaded.routed, false);
  check('not-loaded -> reason channel-not-loaded', routedNotLoaded.reason, 'channel-not-loaded');
  // ⚠ THE ASSERTION THAT IS NOT ABOUT THE RETURN VALUE. A refusal that still
  // wrote the frame would satisfy every check above it and be the same defect.
  check('not-loaded -> NOTHING was written to the live socket', received, []);

  socket.destroy();
  await new Promise((r) => server.close(r));

  // -------------------------------------------------------------------------
  process.stdout.write('\n§3 what each runtime declares, and what herdr records per agent\n');
  // -------------------------------------------------------------------------
  const { CrabCastRuntime, buildConfigureAgentPayload } = await import("../dist/crabcast-runtime.js");
  const { HerdrBridge } = await import("../dist/herdr.js");

  // CONSTRUCTED, not read off the source as text. `channelReach` is a class
  // field, so the value a caller sees is the one the constructor installs —
  // and a text match against dist would pass just as happily on a field that
  // some later edit stopped installing. The stub link is inert: it records the
  // handlers and connects to nothing, so no socket is opened by this check.
  const inertLink = {
    onEvent() {},
    onLinkState() {},
    connect() {},
    close() {}
  };
  const crab = new CrabCastRuntime({
    link: inertLink,
    log: () => {},
    censusIntervalMs: 24 * 60 * 60 * 1000
  });
  const herdr = new HerdrBridge();

  // ⚠ KAN-496: `channelReach` IS NO LONGER A CONSTANT, and this section is
  // rewritten around that rather than re-pinned to a new literal.
  //
  // AC2 asked for the value to move to `'loaded'` "as a consequence of the
  // mechanism, not as an edit that outruns it". A check that asserted the new
  // literal would be satisfied by exactly the edit AC2 forbids — which is the
  // trap `epic/KAN-203` wrote into KAN-503 and `task/KAN-503` refused. So this
  // drives the DERIVATION, both ways, through the seam the production path uses.
  //
  // ⚠ AND IT CANNOT READ THE PRODUCTION SWITCH TO DO IT. `channelEmissionEnabled()`
  // reads a file under HOME; CI sandboxes HOME, so the real answer here is
  // `not-loaded` on every CI run and `loaded` on a developer's machine with the
  // switch on. An assertion against either would be a claim about the harness.
  // `CrabCastRuntimeOptions.channelArgv` exists for this: one injected source
  // that both `channelReach` and the `args` on the wire read.
  const crabWith = new CrabCastRuntime({
    link: inertLink, log: () => {}, censusIntervalMs: 24 * 60 * 60 * 1000,
    channelArgv: () => ['--dangerously-load-development-channels=server:butchr']
  });
  const crabWithout = new CrabCastRuntime({
    link: inertLink, log: () => {}, censusIntervalMs: 24 * 60 * 60 * 1000,
    channelArgv: () => []
  });

  check("crabcast declares loaded when the spawn carries the flag",
    crabWith.channelReach, "loaded");
  check("crabcast declares not-loaded when it does not (the switch is off)",
    crabWithout.channelReach, "not-loaded");

  // THE DISCRIMINATING ARM. Both of the above would pass on a getter that
  // ignored its input and happened to be right once; only a pair that DIFFERS
  // shows the value is actually derived from the argv.
  check("so the value is derived from the argv, not declared",
    crabWith.channelReach !== crabWithout.channelReach, true);

  // AND THE SAME ONE SOURCE REACHES THE WIRE. `channelReach` answering 'loaded'
  // while `provision` sent no args is precisely KAN-495 with the alarm off, so
  // the payload is built from the same injected function and compared.
  const argv = ['--dangerously-load-development-channels=server:butchr'];
  const payload = buildConfigureAgentPayload({
    session: { workDir: '/tmp/kan496-inert' },
    priority: 1, supervisor: false, promptContent: 'inert',
    defaultAgent: 'claude', mcpServers: undefined, channelArgv: argv
  });
  check("and the argv that answers 'loaded' is the argv that goes on the wire",
    JSON.stringify(payload.args), JSON.stringify(argv));
  const payloadOff = buildConfigureAgentPayload({
    session: { workDir: '/tmp/kan496-inert' },
    priority: 1, supervisor: false, promptContent: 'inert',
    defaultAgent: 'claude', mcpServers: undefined, channelArgv: []
  });
  check("and an empty argv OMITS the field rather than sending []",
    Object.prototype.hasOwnProperty.call(payloadOff, 'args'), false);

  // ⚠ KAN-497 CHANGED WHAT THIS ROW MEANS AND NOT WHAT IT ASSERTS, and the
  // distinction is the reason it is not simply left alone.
  //
  // It used to read `'unknown'` as *"nobody has recorded this per-agent yet"* —
  // an honest gap with a ticket against it, and the comment said so. That ticket
  // has landed and the value has NOT moved, deliberately: the per-agent fact was
  // never expressible on a runtime member, because this one answers about a
  // SPAWN SHAPE and *"did the pane serving `task/KAN-1` get the flag?"* is not a
  // question about a shape. The record lives in `channel-spawn-reach.ts`, keyed
  // by address, written from the `AgentSpawn` at the spawn seam.
  //
  // ⚠ So `'unknown'` here is now LOAD-BEARING rather than residual, and a later
  // reader who sharpens it to `'not-loaded'` — reasoning that the fleet is
  // recorded now, so a gap must mean no channel — takes every agent that
  // outlived a daemon restart off the channel for a fact nobody established.
  // The store is in memory on purpose; those agents keep the argv they were
  // started with. That is KAN-497's own stated trap, and this row is one of the
  // two places standing in front of it.
  check("herdr declares unknown — the FALL-THROUGH for an agent with no spawn record (KAN-497)",
    herdr.channelReach, "unknown");

  // AND THE PER-AGENT ANSWER, WHICH IS WHAT ACTUALLY ROUTES. The composition
  // `daemon.ts` uses is `record ?? runtime`, so the same runtime answers three
  // different things about three agents. Asserted here as well as in
  // `verify-herdr-channel-reach-per-agent.mjs` because §1 above is about
  // `carrierFor`'s inputs and this is where the inputs come from — a section
  // that showed the refusal working while the daemon could only ever feed it one
  // fleet-wide value would be describing a gate with nothing behind it.
  const { ChannelSpawnReachStore } = await import("../dist/channel-spawn-reach.js");
  const spawnReach = new ChannelSpawnReachStore();
  const perAgentReach = (address) => spawnReach.get(address) ?? herdr.channelReach;
  const muted = { type: "task", key: "KAN-497-off" };
  const heard = { type: "task", key: "KAN-497-on" };
  const never = { type: "task", key: "KAN-497-restarted" };
  spawnReach.record(muted, false);
  spawnReach.record(heard, true);

  check("a herdr agent whose spawn had no flag reads not-loaded",
    perAgentReach(muted), "not-loaded");
  check("one whose spawn had it reads loaded",
    perAgentReach(heard), "loaded");
  // ⚠ THE ROW THAT MUST NOT BECOME 'not-loaded'. An agent with no record is one
  // that outlived a daemon restart, not one that cannot hear us.
  check("and one this daemon never spawned still reads unknown, NOT not-loaded",
    perAgentReach(never), "unknown");
  // THE DISCRIMINATING ARM. All three above would pass on a lookup that ignored
  // its argument and happened to be right once; only three answers that DIFFER
  // show the value is per-agent.
  check("so one runtime answers three agents differently — the reach is per-agent",
    new Set([perAgentReach(muted), perAgentReach(heard), perAgentReach(never)]).size, 3);

  crabWith.stop?.();
  crabWithout.stop?.();
  crab.stop?.();

  // -------------------------------------------------------------------------
  process.stdout.write('\n§4 THE RED DRIVE — the alarm, shown blind and shown firing\n');
  // -------------------------------------------------------------------------
  const guardianAddress = { type: 'epic', key: 'KAN-203' };
  const INTERVAL = 60_000;

  async function runGuardianArm(reach) {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'k495g-'));
    const sp = path.join(sd, 's');
    const got = [];
    const srv = net.createServer((c) => c.on('data', (d) => got.push(String(d))));
    await new Promise((r) => srv.listen(sp, r));
    const sk = net.createConnection(sp);
    await new Promise((r) => sk.on('connect', r));
    const reg = new AgentConnectionRegistry();
    reg.register(sk, guardianAddress);

    let clock = 1_000_000;
    const logged = [];
    const poker = new GuardianPoker({
      intervalMs: INTERVAL,
      world: {
        emissionEnabled: () => true,
        readConfig: () => ({ address: guardianAddress, intervalMs: INTERVAL, setAt: null }),
        // THE REAL ROUTER, not a stand-in. A fake `send` here would be a second
        // implementation of the decision under test, which is the shape this
        // codebase keeps paying for (KAN-145).
        send: (addr, content) => {
          const outcome = routeChannelMessage({
            registry: reg,
            address: addr,
            content,
            meta: { sender: '[butchr daemon]', workspaceType: addr.type, workspaceKey: addr.key,
                    guardianPoke: 'true' },
            reach: () => reach
          });
          return outcome.routed
            ? { routed: true, connectionId: outcome.connectionId }
            : { routed: false, reason: outcome.reason, detail: outcome.detail };
        },
        now: () => clock,
        log: (m) => logged.push(m)
      }
    });

    // Enough pokes, far enough apart, to cross OVERDUE_INTERVALS.
    for (let i = 0; i <= OVERDUE_INTERVALS + 1; i++) {
      await poker.pokeOnce();
      clock += INTERVAL;
    }
    const state = poker.state();

    sk.destroy();
    await new Promise((r) => srv.close(r));
    return { state, framesOnWire: got.length, logged };
  }

  const pre = await runGuardianArm('unknown');
  process.stdout.write(
    `  arm PRE  (reach unknown)   : delivered=${pre.state.lastPoke?.delivered} ` +
      `consecutiveUndelivered=${pre.state.consecutiveUndelivered} ` +
      `overdue=${pre.state.overdue} framesOnWire=${pre.framesOnWire}\n`
  );
  const post = await runGuardianArm('not-loaded');
  process.stdout.write(
    `  arm POST (reach not-loaded): delivered=${post.state.lastPoke?.delivered} ` +
      `consecutiveUndelivered=${post.state.consecutiveUndelivered} ` +
      `overdue=${post.state.overdue} framesOnWire=${post.framesOnWire}\n`
  );

  // THE GREEN ARM — the state the fleet was actually in. Asserted, not merely
  // printed, because "the alarm could not have fired" is half the finding.
  check('PRE: the poke reports delivered', pre.state.lastPoke?.delivered, true);
  check('PRE: consecutiveUndelivered stays 0', pre.state.consecutiveUndelivered, 0);
  check('PRE: overdue stays FALSE — the alarm is structurally blind', pre.state.overdue, false);
  check('PRE: frames were written to the wire', pre.framesOnWire > 0, true);

  // THE RED ARM.
  check('POST: the poke reports undelivered', post.state.lastPoke?.delivered, false);
  check('POST: transport is undelivered, never composer', post.state.lastPoke?.transport, 'undelivered');
  check('POST: the refusal reason is carried through verbatim',
    post.state.lastPoke?.reason?.includes('channel-not-loaded') ||
      post.state.lastPoke?.detail?.includes('channel-not-loaded') ||
      JSON.stringify(post.state.lastPoke).includes('channel-not-loaded'), true);
  check('POST: consecutiveUndelivered climbs', post.state.consecutiveUndelivered > OVERDUE_INTERVALS, true);
  check('POST: overdue is TRUE — THE ALARM FIRES', post.state.overdue, true);
  check('POST: nothing was written to the wire', post.framesOnWire, 0);
  check('POST: the daemon log says so loudly',
    post.logged.some((m) => /undelivered/i.test(m)), true);

  // -------------------------------------------------------------------------
  process.stdout.write('\n§5 the KAN-319 meta prior — ruled out, not assumed\n');
  // -------------------------------------------------------------------------
  // The ticket names a known prior with an identical signature: a NON-STRING
  // value in a frame's `meta` costs the whole frame, silently, and blinds
  // channel-liveness into reporting parse-loss as a model declining. It is not
  // this defect, and the reason is mechanical rather than a judgement.
  const badMeta = routeChannelMessage({
    registry: new AgentConnectionRegistry(),
    address,
    content: 'x',
    meta: { guardianPoke: true },
    reach: () => 'unknown'
  });
  check('a non-string meta value is still REFUSED before anything else',
    badMeta.reason, 'meta-not-renderable');
  // AND the producers this fleet actually runs. Read out of the daemon source
  // as text, so this section is unaffected by whether `dist` is current.
  const daemonSrc = fs.readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
  const metaLiterals = [...daemonSrc.matchAll(/guardianPoke:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const livenessLiterals = [...daemonSrc.matchAll(/livenessProbe:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  process.stdout.write(`  guardianPoke  literals in daemon.ts: ${JSON.stringify(metaLiterals)}\n`);
  process.stdout.write(`  livenessProbe literals in daemon.ts: ${JSON.stringify(livenessLiterals)}\n`);
  check('every guardianPoke literal is a quoted string',
    metaLiterals.length > 0 && metaLiterals.every((l) => /^'true'$|^"true"$/.test(l)), true);
  check('every livenessProbe literal is a quoted string',
    livenessLiterals.length > 0 && livenessLiterals.every((l) => /^'true'$|^"true"$/.test(l)), true);

  // -------------------------------------------------------------------------
  process.stdout.write('\n§6 THE HERDR COMPARISON — run, and stated either way\n');
  // -------------------------------------------------------------------------
  // KAN-495 AC3 asks whether this is CrabCast-specific, and warns that if it
  // reproduces under herdr the ticket's framing is wrong and that must be said
  // loudly. The question reduces to one thing, because
  // probe-channel-reaches-model.mjs measured that the flag is what decides
  // delivery: DOES EACH RUNTIME'S SPAWN CARRY IT?
  //
  // So this runs herdr's own command composer — the real one, from dist, not a
  // description of it — with the switch in both states.
  const { AGENT_LAUNCHERS, DEV_CHANNELS_FLAG } = await import('../dist/launchers.js');

  // KAN-533: the launcher takes a context and returns argv. There is no `||`
  // any more — herdr 0.7 runs the executable directly — so "both arms" is now
  // two SPAWNS rather than two halves of one string, and each has to be asked
  // for. `resumed`/`cold` are exactly the two the `||` used to hold.
  const compose = (enabled) => {
    fs.writeFileSync(CHANNEL_SWITCH_PATH, JSON.stringify({ enabled }) + '\n');
    return {
      resumed: AGENT_LAUNCHERS.claude.command({ promptCommand: 'PROMPT', hasConversation: true }),
      cold: AGENT_LAUNCHERS.claude.command({ promptCommand: 'PROMPT', hasConversation: false })
    };
  };
  const onArms = compose(true);
  const offArms = compose(false);
  fs.writeFileSync(CHANNEL_SWITCH_PATH, JSON.stringify({ enabled: true }) + '\n');
  const on = onArms.cold;
  const off = offArms.cold;

  process.stdout.write(`  herdr, switch ON : ${on.command.slice(0, 110)}…\n`);
  process.stdout.write(`  herdr, switch OFF: ${off.command.slice(0, 110)}…\n`);

  check('herdr WITH the switch on puts the flag on the command line',
    on.command.includes(DEV_CHANNELS_FLAG), true);
  check('herdr WITH the switch on reports channelEnabled', on.channelEnabled, true);
  check('herdr with the switch off does not, and says so',
    off.command.includes(DEV_CHANNELS_FLAG) === false && off.channelEnabled === false, true);
  // BOTH ARMS, because a half-flagged spawn works on the resumed path and fails
  // on the cold one — the hazard KAN-246 names. ⚠ COUNTING OCCURRENCES IN ONE
  // STRING NO LONGER ASKS THIS QUESTION. Under the `||` both arms shared a
  // command line, so "the flag appears twice" was the test; each arm is now its
  // own spawn, so the same count is 1 on a correct build and the old assertion
  // fails on code that is right. The question is unchanged — is EITHER arm
  // unflagged? — so it is asked of each arm directly, which is also stricter:
  // a count of 2 could have been satisfied by two flags on one arm and none on
  // the other, and this cannot.
  check('herdr flags the RESUMED arm',
    onArms.resumed.argv.filter((w) => w.startsWith(DEV_CHANNELS_FLAG)).length, 1);
  check('herdr flags the COLD-START arm (a half-flagged spawn is the worse bug)',
    onArms.cold.argv.filter((w) => w.startsWith(DEV_CHANNELS_FLAG)).length, 1);
  // And the switch-off side of the same pair, which the old single-string check
  // could not express at all.
  check('with the switch off NEITHER arm carries it',
    offArms.resumed.argv.concat(offArms.cold.argv)
      .some((w) => w.startsWith(DEV_CHANNELS_FLAG)), false);

  // AND THE OTHER SIDE OF THE COMPARISON. ⚠ THIS ASSERTION IS INVERTED SINCE
  // KAN-496, and the inversion is the finding rather than an accommodation.
  //
  // It used to require that `crabcast-runtime.ts` import NOTHING from
  // `launchers.js` — correct while `configure_agent` had no argv member, which
  // made the absence structural. CrabCast added `args` at contract 12 (KAN-504),
  // so the flag has a route in and this runtime takes it. An import is now the
  // mechanism, and a file that had none would be a fleet with no channel again.
  const crabSrc = fs.readFileSync(new URL('../src/crabcast-runtime.ts', import.meta.url), 'utf8');
  check('crabcast-runtime imports the flag composer (KAN-496: this IS the route in)',
    /from '\.\/launchers\.js'/.test(crabSrc), true);
  // And it imports the COMPOSER rather than composing a second copy. The whole
  // argument for one call site is that a second spelling drifts, and under this
  // runtime the copy that drifted would be the one nobody reads.
  check('and composes no second copy of the flag literal',
    crabSrc.includes('dangerously-load-development-channels=server:'), false);

  process.stdout.write(
    '  VERDICT: the flag is now on BOTH runtimes\' spawns. KAN-495 was cutover-specific —\n' +
    '  a regression with a working baseline — and KAN-496 closed it by giving CrabCast\'s\n' +
    '  spawn the same argv herdr always had. Had herdr come back without the flag, or\n' +
    '  CrabCast still without one, this line would have to say so, loudly.\n'
  );
} finally {
  restoreSwitch();
}

process.stdout.write(`\nfailures: ${failures}\n`);
process.exit(failures ? 1 : 0);
