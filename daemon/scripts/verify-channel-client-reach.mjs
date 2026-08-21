#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: the daemon writing channel frames at a client
 * that was started WITHOUT `--dangerously-load-development-channels`, reporting
 * `delivered: true` with C1 and C2 honestly true, and delivering nothing to a
 * model — because the pane was started by somebody Butchr is not. That is
 * KAN-319, measured on this fleet on 2026-08-20: herdr restored four supervisor
 * panes itself (`resume_agents_on_restore`) as `claude --resume <uuid>`, a
 * command line `launchers.ts` cannot compose. `epic/KAN-39`, `epic/KAN-59`,
 * `epic/KAN-203` and `story/KAN-117` then spent a night unreachable while every
 * instrument read green and `task/KAN-335` — a TASK agent in the same process
 * cohort, carrying the flag — received normally throughout.
 *
 * ⚠ KAN-495 and KAN-497 exist and could not catch it, which is the point of a
 * third mechanism rather than a fourth field on one of theirs. Both derive their
 * answer from **a spawn Butchr made**: `AgentRuntime.channelReach` from a
 * runtime's spawn shape, `ChannelSpawnReachStore` from one launcher decision.
 * A pane restored behind the daemon's back has no such spawn to inspect, so the
 * store is empty, the fall-through answers about spawns that are not this one,
 * and the frame goes out. Only the argv of the process that is running decides
 * whether a frame is rendered, and only a reading of that argv can see it.
 *
 * It would equally catch this fix's own failure mode, which is the opposite
 * direction and costs an interrupt rather than a silence: an agent this daemon
 * could NOT measure answering `'not-loaded'` and being demoted to the composer,
 * whose Ctrl+C destroys the tool call it is running. §1's wrapper row, §2's
 * shadowing row and §3's two guards are what stand in front of that.
 *
 * ---------------------------------------------------------------------------
 * THE SECTIONS
 * ---------------------------------------------------------------------------
 *
 *   §1 the verdict, over argv — the real shapes from both sides of the split,
 *      and every way of declining to answer.
 *   §2 the composition: measurement first, spawn record second, runtime third,
 *      and ⚠ an `'unknown'` measurement shadowing NEITHER of the two below it.
 *   §3 the real `/proc` walk, over a two-level process tree this script starts:
 *      an argv0-`claude` parent with and without the flag, plus the pid-reuse
 *      guard and the no-pid case.
 *   §4 the wiring, read off `src/daemon.ts` as TEXT: that the production
 *      `channelReach` composes the three through `reachForRoute`, and that the
 *      measurement is taken at `hello` from the announced server pid.
 *   §5 ⚠ THE BEHAVIOUR, and where `--red-drive` bites. Two agents, one
 *      registry, two real sockets: the one whose connection measured
 *      `not-loaded` gets NOTHING written; its unmeasured neighbour gets a frame.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
 * ---------------------------------------------------------------------------
 *
 * A proof that supplies its own input has not tested that the input arrives
 * (KAN-145). Said in both directions:
 *
 *   * §1, §2 and §5 SUPPLY THE READING. They hand the router a verdict this
 *     file chose, so they establish what the composition and the route do with
 *     one, and **nothing about whether a real client produces it.**
 *   * §3 IS WHAT NARROWS THAT, and it is why the section exists in this file
 *     rather than in a live-only sibling: it starts a real two-level process
 *     tree and reads it through the real `/proc`, so the argv reader, the
 *     `ppid` walk and the `mcp.js` guard are all exercised against the kernel
 *     rather than against an array. What it still supplies is the tree — the
 *     parent is a `node` wearing `argv0: 'claude'`, not a Claude Code client.
 *   * ⚠ WHAT NOTHING HERE COVERS: that the daemon's `hello` handler is reached
 *     at all, and that a real `mcp.js` really is a child of a real client. §4
 *     asserts the first as source text, which is weaker than running it and is
 *     named as such. The second is an observation of the running fleet, not a
 *     test — `ps -eo pid,ppid,args` over every live `mcp.js`, and the daemon's
 *     own `client channel reach …` line at each `hello`. **Both are pasted into
 *     the pull request** for KAN-319, which is where that gap is closed and who
 *     closes it.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *   node daemon/scripts/verify-channel-client-reach.mjs [--verbose]
 *
 *   --red-drive    patch a COPY of the build so a Claude Code command line with
 *                  no channel flag answers `'unknown'` instead of
 *                  `'not-loaded'` — which is precisely how this daemon behaved
 *                  before KAN-319, and precisely the shrug that let four
 *                  supervisors go unreachable. Watch §1, §3 and §5 go red. It
 *                  ends by FAILING if the run came back green, because a
 *                  mutation that did not take is an assertion that is not
 *                  watching what it claims to watch.
 *
 * Run it after `npm run build` in daemon/.
 */

// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
//       in process, over unix sockets and child processes it creates under
//       os.tmpdir(); no live daemon, no herdr, no credential, no peer, no
//       terminal, and nothing read from the fleet. EVERY section runs on a
//       runner, so there is no skip tally and no way to report a green that a
//       section did not earn.
//
// §3 needs Linux `/proc`. It is not skipped elsewhere — it FAILS, deliberately:
// the product's measurement is a `/proc` read, so a platform without one is a
// platform where this daemon cannot tell a mute agent from a live one, and a
// proof that shrugged at that would be certifying the gap it exists to close.
//
// The one piece of shared state §5 touches — the channel kill switch under
// BUTCHR_DIR — it reads, writes ENABLED, and restores in a `finally`. Enabling
// is the safe direction, and `carrierFor` reads the switch first by design, so a
// run against a fleet whose channel is off would pass §5 quietly and for
// entirely the wrong reason.

import * as net from 'net';
import { spawn } from 'child_process';
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
const redDrive = process.argv.includes('--red-drive');

let failures = 0;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-client-reach.js'))) {
  console.error('daemon/dist is missing or predates KAN-319 — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan319-reach-'));
const children = [];
process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

let distUnderTest = dist;
if (redDrive) {
  // The damage is done to a COPY: this repository has live agents working in
  // sibling worktrees off one shared clone, and a red run must not leave a
  // broken build where one of them will import it.
  distUnderTest = path.join(scratch, 'dist');
  cpSync(dist, distUnderTest, { recursive: true });
  symlinkSync(path.join(daemonDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const target = path.join(distUnderTest, 'channel-client-reach.js');
  const source = readFileSync(target, 'utf8');
  // The mutation is the pre-KAN-319 behaviour exactly: a recognised Claude Code
  // command line with no channel flag on it produces a shrug instead of a
  // verdict, so the router falls through to a spawn inference that does not
  // know about this pane and the frame goes out.
  const patched = source.replace("    if (looksLikeClaudeClient(argv)) {", '    if (false) {');
  if (patched === source) {
    console.error('--red-drive could not find the claude-client branch to patch; it has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  say("--red-drive: patched a copy of the build so a flagless Claude Code argv answers 'unknown'.");
}

const u = (f) => `file://${path.join(distUnderTest, f)}`;
const {
  channelEntriesInArgv,
  measureClientReachForServer,
  reachForRoute,
  reachFromClientArgv,
  readParentPid,
  readProcessArgv
} = await import(u('channel-client-reach.js'));
const { routeChannelMessage, CHANNEL_SWITCH_PATH } = await import(u('channel.js'));
const { AgentConnectionRegistry } = await import(u('agent-connections.js'));

const daemonSrc = readFileSync(path.join(daemonDir, 'src', 'daemon.ts'), 'utf8');
// Comments stripped, so prose in the blocks around these statements can neither
// satisfy nor defeat a match — a rule this repository has had to learn twice.
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

const FLAG = '--dangerously-load-development-channels';

try {
  // ═════════════════════════════════════════════════════════════════════════
  rule('§1  the verdict, over argv — both sides of the real split');
  // ═════════════════════════════════════════════════════════════════════════

  // ⚠ THE TWO ROWS THAT ARE THE WHOLE TICKET, spelled as the fleet spelled them
  // on 2026-08-20. The first is what herdr's own pane restore produced for four
  // supervisors; the second is what `launchers.ts` produces.
  const HERDR_RESTORED = ['claude', '--resume', 'af1615b1-398b-44fe-83fa-910410bfac1a'];
  const BUTCHR_SPAWNED = [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    `${FLAG}=server:butchr`,
    'Please read and follow the instructions in /home/…/prompt.md to begin.'
  ];

  check(
    reachFromClientArgv(HERDR_RESTORED).reach === 'not-loaded',
    "`claude --resume <uuid>` (herdr's restore, the four supervisors) → not-loaded",
    reachFromClientArgv(HERDR_RESTORED).detail
  );
  check(
    reachFromClientArgv(BUTCHR_SPAWNED).reach === 'loaded',
    "`claude … --dangerously-…=server:butchr …` (launchers.ts) → loaded",
    reachFromClientArgv(BUTCHR_SPAWNED).detail
  );

  // The two-token spelling. `launchers.ts` never writes it (KAN-496: the flag is
  // variadic and the two-token form swallows what follows), but this reader
  // reads command lines it did not compose, and answering `not-loaded` for a
  // correctly flagged client somebody else launched would cost that agent an
  // interrupt on every message.
  check(
    reachFromClientArgv(['claude', FLAG, 'server:butchr', '--permission-mode', 'bypassPermissions'])
      .reach === 'loaded',
    'the variadic two-token spelling is also read as loaded'
  );
  check(
    JSON.stringify(channelEntriesInArgv(['claude', FLAG, 'server:a', 'server:b', '--other', 'x'])) ===
      '["server:a","server:b"]',
    'and the variadic list stops at the next flag, rather than eating it'
  );
  check(
    reachFromClientArgv(['claude', `${FLAG}=server:other,server:butchr`]).reach === 'loaded',
    'a comma-joined list naming this server is read as loaded'
  );

  // A flag that loads SOMEBODY ELSE'S channel is a measured no, not a shrug:
  // the client is rendering channels and will still discard ours.
  check(
    reachFromClientArgv(['claude', `${FLAG}=server:somethingelse`]).reach === 'not-loaded',
    'a flag naming a different server → not-loaded'
  );

  // ── ⚠ EVERY WAY OF DECLINING, and each one costs an interrupt if it lies ──
  say('');
  say('  the honest shrugs — each of these answering not-loaded would demote a working agent:');
  check(reachFromClientArgv(null).reach === 'unknown', '  an unreadable command line → unknown');
  check(reachFromClientArgv([]).reach === 'unknown', '  an empty command line → unknown');
  // ⚠ THE WRAPPER ROW. Started through a shell, the whole command sits inside
  // ONE argv element, so a token scan finds no flag on a client that hears us
  // perfectly. This is the row that keeps this fix from being worse than the
  // defect.
  check(
    reachFromClientArgv(['bash', '-c', `claude ${FLAG}=server:butchr --permission-mode bypassPermissions`])
      .reach === 'unknown',
    '  a shell wrapper holding the whole command in one element → unknown',
    reachFromClientArgv(['bash', '-c', 'claude …']).detail
  );
  check(
    reachFromClientArgv(['node', 'scripts/verify-event-contract.mjs']).reach === 'unknown',
    '  a parent that is not a client at all → unknown'
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§2  the composition — three sources, and what may not shadow what');
  // ═════════════════════════════════════════════════════════════════════════

  check(
    reachForRoute({ measured: 'not-loaded', spawn: 'loaded', runtime: 'loaded' }) === 'not-loaded',
    'the measurement beats a spawn record that disagrees',
    'an observation of the running process outranks an inference about its launch'
  );
  check(
    reachForRoute({ measured: 'loaded', spawn: 'not-loaded', runtime: 'not-loaded' }) === 'loaded',
    'and it beats them in the other direction too'
  );
  check(
    reachForRoute({ spawn: 'not-loaded', runtime: 'loaded' }) === 'not-loaded',
    'with no measurement, KAN-497’s spawn record still decides'
  );
  check(
    reachForRoute({ runtime: 'loaded' }) === 'loaded',
    'with neither, the runtime answers exactly as it did before KAN-319'
  );

  // ⚠ THE SHADOWING ROWS — the trap `channel-spawn-reach.ts` names in its own
  // words: *"absence composes; a recorded shrug does not."* An older mcp.js
  // announces no pid, a non-Linux host reads no /proc, a wrapper is
  // unrecognisable — all three arrive here as `'unknown'`, and every one of them
  // would otherwise erase an answer somebody actually knows.
  say('');
  say("  ⚠ an 'unknown' measurement must shadow NEITHER source below it:");
  check(
    reachForRoute({ measured: 'unknown', spawn: 'not-loaded', runtime: 'loaded' }) === 'not-loaded',
    "  unknown + a spawn record → the spawn record"
  );
  check(
    reachForRoute({ measured: 'unknown', runtime: 'loaded' }) === 'loaded',
    "  unknown + a runtime that knows → the runtime's answer"
  );
  check(
    reachForRoute({ measured: 'unknown', spawn: 'unknown', runtime: 'unknown' }) === 'unknown',
    '  and three shrugs are still a shrug, never a demotion'
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§3  the real /proc walk, over a process tree this script starts');
  // ═════════════════════════════════════════════════════════════════════════

  // A REAL TWO-LEVEL TREE. The parent wears `argv0: 'claude'` — which is what
  // the fleet's clients are, literally — and forks a child carrying an `mcp.js`
  // path, which is the shape the daemon's guard looks for. Both arms differ in
  // one argument and nothing else.
  const fakeMcp = path.join(scratch, 'mcp.js');
  // A FILE rather than `node -e`, and the difference is not style: everything
  // after a script path is an argument to the script, whereas everything after
  // `-e` is parsed by node itself — which rejects `--resume` as a bad option and
  // kills the arm before it can be measured.
  const childEntry = path.join(scratch, 'arm.cjs');
  writeFileSync(
    childEntry,
    `const {spawn}=require('child_process');\n` +
      `const c=spawn(process.execPath,[${JSON.stringify(fakeMcp)}],{stdio:'ignore'});\n` +
      `process.stdout.write(String(c.pid)+'\\n');\n` +
      `setTimeout(()=>{},20000);\n`
  );
  // The stand-in server has to survive being executed, since it is now a real
  // child rather than an argument — it holds itself open and does nothing else.
  writeFileSync(fakeMcp, 'setTimeout(()=>{},20000);\n');

  const startArm = async (extraArgs) => {
    const client = spawn(process.execPath, [childEntry, ...extraArgs], {
      argv0: 'claude',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    children.push(client);
    const serverPid = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('arm did not report a server pid')), 10_000);
      client.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('\n')) {
          clearTimeout(timer);
          resolve(Number(out.trim()));
        }
      });
    });
    return { clientPid: client.pid, serverPid };
  };

  const flagged = await startArm([`${FLAG}=server:butchr`]);
  const flagless = await startArm(['--resume', 'e2f0c1aa-0000-4000-8000-000000000000']);
  // The children register with /proc the moment they exist; this is slack for
  // the fork itself rather than a poll.
  await sleep(150);

  const flaggedRead = measureClientReachForServer({ serverPid: flagged.serverPid });
  const flaglessRead = measureClientReachForServer({ serverPid: flagless.serverPid });

  check(
    readProcessArgv(flagged.clientPid)?.[0] === 'claude',
    'the harness really did produce an argv0-claude parent',
    JSON.stringify(readProcessArgv(flagged.clientPid)?.slice(0, 2))
  );
  check(
    readParentPid(flagged.serverPid) === flagged.clientPid,
    'the ppid walk finds the client from the server pid',
    `${readParentPid(flagged.serverPid)} vs ${flagged.clientPid}`
  );
  check(
    flaggedRead.reach === 'loaded' && flaggedRead.clientPid === flagged.clientPid,
    'flagged arm, read through real /proc → loaded',
    JSON.stringify(flaggedRead)
  );
  // ⚠ THE DISCRIMINATING ARM. Same harness, same second, same machine; the two
  // command lines differ in that one argument. Without this pair, the row above
  // would be a claim about the reader rather than about the world.
  check(
    flaglessRead.reach === 'not-loaded' && flaglessRead.clientPid === flagless.clientPid,
    'flagless arm, read through real /proc → not-loaded',
    JSON.stringify(flaglessRead)
  );

  say('');
  say('  the two guards on the walk itself:');
  // A pid that is not an mcp.js is refused rather than described. Pointed at
  // THIS process — a real, live, readable pid — the guard must still decline,
  // which is what makes it a check rather than a formality.
  const notAServer = measureClientReachForServer({ serverPid: process.pid });
  check(
    notAServer.reach === 'unknown' && notAServer.clientPid === null,
    '  a live pid that is not an mcp.js → unknown, and no parent is described',
    notAServer.detail
  );
  check(
    measureClientReachForServer({ serverPid: undefined }).reach === 'unknown',
    '  a connection announcing no pid (an mcp.js from before KAN-526) → unknown'
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§4  the wiring in src/daemon.ts, as text');
  // ═════════════════════════════════════════════════════════════════════════
  // ⚠ WEAKER THAN RUNNING IT, AND SAID SO IN THE HEADER. The production
  // `channelReach` closure and the `hello` handler are not exported, so no
  // script can call them; this asserts the seam exists and is composed the way
  // §2 tested. Nothing here would notice if the handler stopped being reached.

  check(
    /reachForRoute\(\{/.test(daemonCode),
    'channelReach composes through reachForRoute rather than a second ?? chain'
  );
  check(
    /measured:\s*agentConnections\.resolve\(address\)\?\.clientReach\?\.reach/.test(daemonCode),
    'the measurement comes off the connection `resolve` would write to',
    'asking about the socket the frame goes down, not about the address in the abstract'
  );
  check(
    /spawn:\s*channelSpawnReach\.get\(address\)/.test(daemonCode) &&
      /runtime:\s*herdrBridge\.channelReach/.test(daemonCode),
    "KAN-497's record and the runtime are still the second and third sources"
  );
  check(
    /measureClientReachForServer\(\{\s*serverPid:\s*build\?\.pid\s*\}\)/.test(daemonCode),
    'the reading is taken at hello, from the pid the server is announcing',
    'while that process is demonstrably alive, because it is the one talking'
  );
  check(
    /agentConnections\.register\(socket,\s*address,\s*build,\s*clientReach\)/.test(daemonCode),
    'and it is held on the connection, not in a map that outlives it'
  );

  // ═════════════════════════════════════════════════════════════════════════
  rule('§5  THE BEHAVIOUR — two agents, two real sockets, one measured mute');
  // ═════════════════════════════════════════════════════════════════════════
  mkdirSync(path.dirname(CHANNEL_SWITCH_PATH), { recursive: true });
  writeFileSync(CHANNEL_SWITCH_PATH, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
  say(`  (channel switch written ENABLED for this section: ${CHANNEL_SWITCH_PATH})`);

  const MUTE = { type: 'epic', key: 'KAN-319-mute' };
  const HEARD = { type: 'task', key: 'KAN-319-heard' };

  const sockDir = mkdtempSync(path.join(tmpdir(), 'kan319-sock-'));
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
    // THE MUTE AGENT'S CONNECTION CARRIES A MEASUREMENT taken by the real
    // reader off the real flagless argv from §1 — not a hand-written verdict.
    // Its neighbour carries none at all, which is every agent whose server
    // announces no pid.
    registry.register(
      client,
      address,
      null,
      address === MUTE ? { ...reachFromClientArgv(HERDR_RESTORED), clientPid: null } : null
    );
    servers.push(server);
    clients.push(client);
  }

  // The one composition under test, spelled as §4 asserts daemon.ts spells it.
  // `'unknown'` stands in for the runtime, which is what a HerdrBridge answers.
  const reachOf = (address) =>
    reachForRoute({
      measured: registry.resolve(address)?.clientReach?.reach,
      spawn: undefined,
      runtime: 'unknown'
    });
  const send = (address) =>
    routeChannelMessage({
      registry,
      reach: reachOf,
      address,
      content: 'kan-319 probe',
      managed: () => true
    });

  const mutedOutcome = send(MUTE);
  const heardOutcome = send(HEARD);
  await sleep(60);

  check(mutedOutcome.routed === false, 'the measured-mute agent is REFUSED', JSON.stringify(mutedOutcome));
  check(
    mutedOutcome.reason === 'channel-not-loaded',
    'and the refusal names the reason a reader can act on',
    mutedOutcome.reason
  );
  // ⚠ A MEASUREMENT, NOT A RETURNED STRING. The socket is real and is watched,
  // so "refused" here means nothing arrived rather than that a function said so.
  check(
    JSON.stringify(received[`${MUTE.type}/${MUTE.key}`]) === '[]',
    'and NOTHING was written to its live connection',
    JSON.stringify(received[`${MUTE.type}/${MUTE.key}`])
  );

  // THE DISCRIMINATING ARM, in the same breath and on the same registry. Both
  // agents are registered, both connections are live, and the ONLY difference
  // between them is the measurement — so a harness that refused everything, or a
  // kill switch that was off, cannot produce this pair.
  check(heardOutcome.routed === true, 'its UNMEASURED neighbour is routed', JSON.stringify(heardOutcome));
  check(
    received[`${HEARD.type}/${HEARD.key}`].length === 1,
    'and a frame really was written to that one',
    JSON.stringify(received[`${HEARD.type}/${HEARD.key}`])
  );

  for (const c of clients) c.destroy();
  for (const s of servers) s.close();
  rmSync(sockDir, { recursive: true, force: true });
} finally {
  restoreSwitch();
}

say('');
if (redDrive) {
  // A mutation that did not take is an assertion that is not watching what it
  // claims to watch, so a green here is a FAILURE of the red drive.
  if (failures > 0) {
    say(`--red-drive: RED as required — ${failures} assertion(s) failed.`);
    say('The behaviour that made it go red: a recognised Claude Code command line carrying no');
    say("channel flag answered 'unknown' instead of 'not-loaded', so the router fell through to a");
    say('spawn inference that knows nothing about a pane herdr restored — and the frame went out to');
    say('a client that discards it. That is KAN-319 exactly, and it is how this daemon behaved');
    say('until this ticket.');
    process.exit(0);
  }
  say('--red-drive: GREEN, which is a FAILURE. The mutation did not reach anything asserted.');
  process.exit(1);
}

// No skip tally to consult, because there is nothing here that can fail to run
// — a script with sections it might not reach owes its caller a third exit code
// (KAN-373); this one owes only pass or fail.
say(
  failures === 0
    ? 'GREEN — every section ran, and every assertion passed.'
    : `RED — ${failures} assertion(s) failed.`
);
process.exit(failures ? 1 : 0);
