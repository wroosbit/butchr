//
// KAN-248 (T5 of KAN-150) — the live proof that a real agent's channel loop is
// proved at bring-up, that the client version is recorded with the result, and
// that when the loop breaks the agent comes up on the composer WITH THAT STATE
// VISIBLE TO A SUPERVISOR.
//
// WHAT ONLY A LIVE RUN CAN SHOW. `verify-channel-selfcheck.mjs` drives the
// shipped decision procedure through every outcome deterministically, and every
// fact it asserts about a client is one the harness supplied. Three things are
// facts about a real Claude Code and cannot be held by any harness:
//
//   1. That a real client ANSWERS AN MCP PING ordered behind a
//      `notifications/claude/channel` frame on the same stdio stream. That
//      ordering is the whole mechanism — it is what turns an unacknowledgeable
//      notification into evidence the client consumed it — and if a real client
//      did not answer, every agent in the fleet would come up degraded.
//   2. That `clientInfo.version` is where the client's version actually is, and
//      that it reaches the daemon. That is the version pin, and it is the one
//      thing §6.1 asks for that nothing else in this story does.
//   3. That the whole chain costs what it is claimed to cost.
//
// ---------------------------------------------------------------------------
// WHAT IT SHOWS, IN THE ORDER THE TICKET ASKS FOR IT
// ---------------------------------------------------------------------------
//   PHASE 1  THE GREEN. A real activation, channels on, the daemon's own
//            watcher answering the dialog and the self-check running behind it.
//            The verdict is read out of `list_agents` — the supervisor-facing
//            surface — and carries the client version.               (AC 1)
//   PHASE 2  THE RED. The same activation against a build whose `mcp.js` never
//            answers the self-check: the contract having moved under us on our
//            own side of the wire. The agent comes up fine, its channel loop
//            does not prove out, and `butchr_list_agents` reports it on the
//            COMPOSER — with the outcome and the reason on its row.  (AC 2)
//   PHASE 3  THE COST, measured rather than argued: how long the check takes,
//            and where it sits relative to the activation.           (AC 3)
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHERE ITS EVIDENCE STOPS
// ---------------------------------------------------------------------------
// It supplies the switch (on, in its own `$HOME`) and the brief. It supplies
// NOTHING about the check: the daemon fires it, the agent's own `mcp.js` answers
// it, the client answers the ping, and the verdict is read back off the product's
// own `list_agents`. Phase 2's patch is the one exception and it is deliberately
// a patch to the SERVER side rather than a stubbed verdict — the daemon still
// runs the real check and still decides for itself.
//
// **WHERE THE EVIDENCE STOPS, AND IT STOPS SHORT OF THE HEADLINE.** A green here
// means the frame reached the client and the client read it. **It does not mean
// the client's channel dispatcher accepted it, and no probe can.** Claude Code
// 2.1.226 can decline a channel for six separately-named reasons and tells the
// server none of them; its `initialize` request is byte-identical with and
// without the channels flag, which this probe prints so the reader can see it
// rather than take it on trust. Phase 1 therefore ALSO fires one real addressed
// message and reports whether the model acted on it — the only end-to-end
// evidence available from outside — and reports a non-answer as a non-answer,
// because a model may decline on the merits (KAN-217 measured exactly that).
// **That leg is evidence and is not the self-check**: it costs a model turn and
// cannot run at bring-up, which is why the shipped check does not do it. See the
// header of `daemon/src/channel-selfcheck.ts` for what stands in for it.
//
// NOTHING HERE TOUCHES THE FLEET, with the precise extent of that claim — and
// its one important caveat — stated in `lib/isolated-daemon.mjs`. Read it there
// rather than from this summary: **a private `$HOME` gives a private daemon and
// NOT a private herdr**, so the panes are real, they take real capacity, and a
// composer send from here would reach the live fleet. Every send below checks
// `transport` and aborts rather than falling back.
//
// Usage: node daemon/scripts/probe-channel-selfcheck.mjs [--keep] [--only=1,2]
//
//   --keep     leave the agents and the scratch directory up for inspection
//   --only=..  run a subset of the phases (default: both; phase 3 is a summary
//              of what phases 1 and 2 measured and always runs)
//
// Run it after `npm run build` in daemon/.
//

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { connectDaemonRpc, sleep, yn, SOCKET_PATH } from './lib/channel-probe.mjs';
import {
  DIALOG_ON_PANE,
  PROMPT_READY,
  activateWaitingForRoom,
  awaitStartupOutcome,
  clientHandshake,
  daemonLogLines,
  negotiated,
  outboundFrames,
  stageIsolatedDaemon,
  stagedDaemons as daemons,
  startupLines
} from './lib/isolated-daemon.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');

const KEEP = process.argv.includes('--keep');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const PHASES = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => Number(s.trim()))
  : [1, 2];

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('='.repeat(78));
  say(title);
  say('='.repeat(78));
};

const runId = `${process.pid}${Math.floor(process.uptime() * 1000) % 1000}`;
const GREEN_KEY = `KAN-9248${runId.slice(-3)}`;
const RED_KEY = `KAN-9249${runId.slice(-3)}`;
const TYPE = 'task';
const NONCE = `SELFCHECK${runId}`;

/**
 * The brief these probe agents get.
 *
 * The real `prompts/task.md` sends a task agent to Jira for its ticket and these
 * keys have none, so an agent given the real brief spends the run arguing with
 * it. A preamble that parks the agent, plus **the real file's channel section
 * spliced out verbatim**, so what it knows about the channel is what a fleet
 * agent knows, byte for byte.
 */
const PREAMBLE = `# Probe target — KAN-248 channel self-check

You are a probe target. There is no Jira ticket for this key and no repository
to clone. **Do not look for either.**

Your entire job is to sit at your prompt and wait. Do not read files, do not run
commands, do not start work of any kind.

You may see a channel message describing itself as a startup self-check. It is
exactly what it says it is. Ignore it and keep waiting.

If — and only if — a message arrives asking you to echo a token, reply with that
token as a single line of plain text and nothing else. Then go back to waiting.

`;

/** The `## Whose voice is this?` section of prompts/task.md, verbatim. */
function channelSection() {
  const src = fs.readFileSync(path.join(repoRoot, 'prompts', 'task.md'), 'utf8');
  const start = src.search(/^## .*Whose voice is this\?/m);
  if (start === -1) throw new Error('no "Whose voice is this?" section in prompts/task.md');
  const rest = src.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * Phase 2's break: an `mcp.js` that receives the self-check and never answers.
 *
 * **Patched on the AGENT side, not the daemon side, and that is the whole
 * point.** The daemon still runs the real check, still arms a real answer, still
 * times out on its own clock and still decides its own verdict — so what this
 * demonstrates is the product detecting a broken loop rather than the product
 * being told there is one. It stands in for the thing §6.1 ranks as the quiet
 * failure: our end of the contract having moved, so frames go out and nothing
 * comes back.
 *
 * The `return` is spliced in front of the branch that answers, matched by shape
 * rather than by an exact string, and it THROWS if it matches nothing — a patch
 * that silently found nothing would produce a "red" phase that is really a green
 * build, which is the worst possible outcome for the section whose whole job is
 * to show the failure.
 */
function deafenSelfCheck(distDir) {
  const target = path.join(distDir, 'mcp.real.js');
  const source = fs.readFileSync(target, 'utf8');
  const marker = /(else if \(msg\?\.action === CHANNEL_SELFCHECK_ACTION\) \{)/;
  if (!marker.test(source)) {
    throw new Error('could not find the self-check branch in the built mcp.js to deafen');
  }
  fs.writeFileSync(target, source.replace(marker, '$1\n            return;'));
  say('  [red] patched the copied build so the agent NEVER answers the self-check');
}

// ---------------------------------------------------------------- preflight --

if (!fs.existsSync(path.join(daemonDir, 'dist', 'daemon.js'))) {
  say('ABORTING: daemon/dist/daemon.js is missing — run `cd daemon && npm run build`.');
  process.exit(1);
}
if (!fs.existsSync(path.join(daemonDir, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'))) {
  say('ABORTING: node-pty has no compiled native module here, so a staged daemon would die');
  say(`on startup and be reported as a socket that never appeared.  cd ${daemonDir} && npm rebuild node-pty`);
  process.exit(1);
}

let clientVersion = '(unknown)';
try {
  clientVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  say('ABORTING: no `claude` on PATH. This probe drives the real client.');
  process.exit(1);
}

// The fleet's capacity, read from the fleet's own daemon. The only thing this
// script asks of the live daemon, and it is a read.
try {
  const fleet = await connectDaemonRpc(SOCKET_PATH);
  const cap = await fleet.call('capacity');
  say(`fleet capacity (read from the live daemon): ${cap?.reason ?? '(none)'} ` +
      `[cap=${cap?.cap} running=${cap?.running} headroom=${cap?.headroom}]`);
  fleet.close();
} catch (e) {
  say(`NOTE: could not read the fleet's capacity (${e?.message}); continuing.`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan248-'));
say(`client version : ${clientVersion}   (what \`claude --version\` says; the check reads the`);
say(`                 client's OWN report instead, and the two are compared below)`);
say(`run id         : ${runId}`);
say(`scratch        : ${scratch}`);
say(`phases         : ${PHASES.join(', ')}`);

const results = { green: null, red: null };

const stage = (label, key, patchDist) =>
  stageIsolatedDaemon({
    scratch,
    label,
    type: TYPE,
    key,
    promptText: PREAMBLE + channelSection(),
    say,
    patchDist
  });

const tail = async (side, key, lines = 120) =>
  (await side.call('tail_agent', { key, type: TYPE, lines }))?.text ?? '';

/** This agent's row out of the product's own `list_agents`. */
async function channelRow(side, key) {
  const res = await side.call('list_agents');
  const row = (res?.agents ?? []).find((a) => a.key.toLowerCase() === key.toLowerCase());
  return { row, channel: row?.channel, res };
}

/**
 * Poll `list_agents` until a self-check verdict NEWER THAN `newerThan` lands.
 *
 * **The freshness test is not belt and braces.** Run 2's red phase needed three
 * activations to get a live pane, and this returned attempt 2's verdict the
 * instant it was asked — a `not-ready` from four minutes earlier — because it
 * only tested that a verdict existed. It reported a stale reading as this
 * activation's result, which is the same defect the product had and which
 * `ChannelSelfCheckStore.forget` now closes on the daemon's side. Both ends are
 * fixed, deliberately: the product must not carry a stale verdict, and a proof
 * must not accept one even if it did.
 */
async function awaitVerdict(side, key, { attempts = 20, intervalMs = 2000, newerThan = 0 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const found = await channelRow(side, key);
    const at = found.channel?.checkedAt ? Date.parse(found.channel.checkedAt) : 0;
    if (found.channel && found.channel.outcome !== 'unchecked' && at >= newerThan) return found;
    await sleep(intervalMs);
  }
  return channelRow(side, key);
}

/**
 * Bring an agent up and hold out for a pane that actually lives.
 *
 * **THE RETRY IS NOT DEFENSIVE PADDING, AND THE FIRST RUN OF THIS PROBE IS WHY
 * IT IS HERE.** herdr's spawn fails intermittently on this machine — KAN-24's
 * `ghostty error -2`, a pane-geometry failure documented in
 * `repro-pane-geometry-spawn-failure.sh` — and when it does, `activate_by_key`
 * still answers `success: true, verified: true` and the PTY exits 1 three
 * seconds later. Run 1's red phase hit exactly that, and it produced a
 * `composer` verdict: the RIGHT ANSWER FOR THE WRONG REASON. Its outcome was
 * `not-ready` — no agent ever came up — rather than `no-answer`, which is the
 * broken-loop case the phase exists to demonstrate. A red that is red for the
 * wrong reason proves nothing and reads exactly like a proof, so this asserts
 * the agent came up before it believes anything about its channel.
 */
async function bringUp(side, key, { attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = startupLines(side).length;
    const selfCheckBefore = selfCheckLines(side).length;
    const calledAt = Date.now();
    const act = await activateWaitingForRoom(side, key, { type: TYPE, say });
    if (!act?.success) throw new Error(`activation refused: ${act?.error ?? JSON.stringify(act)}`);
    const activateReturnedAt = Date.now();
    const startup = await awaitStartupOutcome(side, { since: before });
    if (startup.outcome === 'ready') {
      return {
        act,
        startup,
        attempt,
        // The activation call ALONE, excluding any wait for a capacity slot and
        // excluding the wait for readiness. Timed inside the successful attempt
        // so a retry cannot inflate it — run 2 reported 12731ms for what was
        // really "activate, then wait for T3", which is exactly the conflation
        // this figure exists to refute.
        activateMs: activateReturnedAt - calledAt,
        // Where the verdict must be newer than, for `awaitVerdict`, and where
        // this attempt's self-check log lines start.
        readyAt: Date.now(),
        selfCheckBefore
      };
    }

    say('');
    say(`  ATTEMPT ${attempt} DID NOT COME UP — T3's watcher reported '${startup.outcome}'.`);
    for (const l of startup.lines) say(`    | ${l.trim()}`);
    const pane = await tail(side, key, 40);
    say(`  the pane reads: ${pane.trim() ? '' : '(nothing — no pane)'}`);
    for (const l of pane.split('\n').slice(-8)) if (l.trim()) say(`    | ${l}`);
    say('  This is most likely KAN-24\'s intermittent herdr spawn failure rather than anything');
    say('  about the channel: `activate_by_key` answers success, the PTY exits 1 seconds later');
    say('  and herdr never has the agent at all. Standing it down and trying again.');
    if (attempt === attempts) {
      throw new Error(
        `${key} would not come up in ${attempts} attempts (last: ${startup.outcome}). ` +
        'This probe cannot say anything about a channel for an agent that never started.'
      );
    }
    await side.call('deactivate_by_key', { type: TYPE, key });
    await sleep(3000);
    await side.call('reset_by_key', { type: TYPE, key });
    await sleep(3000);
  }
  throw new Error('unreachable');
}

const selfCheckLines = (side) => daemonLogLines(side, '[ChannelSelfCheck]');

let verdict = { ranToVerdict: false };

try {
  // =====================================================================
  if (PHASES.includes(1)) {
    rule('PHASE 1 — THE GREEN: a real activation, and the loop proved behind it   (AC 1)');
    const side = await stage('green', GREEN_KEY);
    const sw = await side.call('channel_switch', { enabled: true });
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');
    say(`  channel switch: ${JSON.stringify(sw)}`);
    say("  (that is a channel.json inside this run's own $HOME — the fleet's is untouched)");
    say('');

    const { act, startup, attempt, activateMs, readyAt, selfCheckBefore } =
      await bringUp(side, GREEN_KEY);
    say(`  activate_by_key → success=${act?.success} verified=${act?.verified} ` +
        `(attempt ${attempt}; the call itself returned in ${activateMs}ms)`);

    say('');
    say("  T3's watcher, verbatim from the daemon's own log:");
    for (const l of startup.lines) say(`    | ${l.trim()}`);

    const { row, channel } = await awaitVerdict(side, GREEN_KEY, { newerThan: readyAt - 60_000 });
    if (!channel) throw new Error('no channel row for the green agent — see list_agents above');
    say('');
    say('  THE SELF-CHECK, verbatim from the daemon\'s own log:');
    for (const l of selfCheckLines(side).slice(selfCheckBefore)) say(`    | ${l.trim()}`);

    const handshake = clientHandshake(side);
    const frames = outboundFrames(side, 'notifications/claude/channel');
    const neg = negotiated(side);
    const paneText = await tail(side, GREEN_KEY);

    say('');
    say('  WHAT butchr_list_agents REPORTS FOR THIS AGENT — the supervisor-facing surface:');
    say(`    ${JSON.stringify(channel, null, 2).split('\n').join('\n    ')}`);
    say('');
    say(`  the agent reached its prompt                    : ${yn(PROMPT_READY.test(paneText))}`);
    say(`  a dialog is still on the pane                   : ${yn(DIALOG_ON_PANE.test(paneText))}`);
    say(`  self-check outcome                              : ${channel?.outcome ?? '(none)'}`);
    say(`  transport this agent's messages will take       : ${channel?.transport ?? '(none)'}`);
    say(`  client version, AS THE CLIENT REPORTED IT       : ${channel?.clientVersion ?? '(none)'}`);
    say(`  …and \`claude --version\` on this machine         : ${clientVersion}`);
    say(`  that version has a measured delivery result     : ${yn(channel?.clientVersionVerified === true)}`);
    say(`  the check took                                  : ${channel?.elapsedMs}ms`);
    say('');
    say(`  a notifications/claude/channel frame left our server : ` +
        `${frames.length} on the tee'd wire`);
    if (frames.length) {
      say('    the self-check frame, verbatim off the wire:');
      say(`    | ${JSON.stringify(frames[0].params).slice(0, 400)}`);
    }
    say('');
    say('  THE CLIENT\'S OWN initialize REQUEST, off the tee\'d wire — printed because the');
    say('  claim that it says nothing about channels is a claim, and this is the evidence:');
    say(`    clientInfo   : ${JSON.stringify(handshake?.clientInfo ?? null)}`);
    say(`    capabilities : ${JSON.stringify(handshake?.capabilities ?? null)}`);
    say(`    ^ NO channel capability, with the flag on the command line. That is why the`);
    say(`      self-check cannot see a client that read the frame and declined it, and why`);
    say(`      the version above is what the result is pinned to instead.`);
    say(`    our server declared experimental['claude/channel'] : ${yn(neg.channel)}`);

    // ------------------------------------------------ the end-to-end leg --
    rule('PHASE 1b — one addressed message, for the leg the self-check cannot reach');
    say('The self-check proves the client READ the frame. Only the model can show the client');
    say('DISPATCHED it. This is not part of the shipped check — it costs a turn — and is run');
    say('once here so the green above is not the only thing standing.');
    say('');
    const send = await side.call('send_to_agent', {
      key: GREEN_KEY,
      type: TYPE,
      message:
        `Channel check for KAN-248. Please reply with exactly this token on a line of its ` +
        `own and nothing else: ${NONCE}`,
      workspaceType: 'task',
      workspaceKey: 'KAN-248'
    });
    say(`  transport              : ${send?.transport ?? '(none)'}`);
    say(`  transportChosenBecause : ${send?.transportChosenBecause ?? '(none)'}`);

    let echoed = null;
    if (send?.transport !== 'channel') {
      say('');
      say('  ABORTING PHASE 1b: the send did not take the channel. A composer send from an');
      say('  isolated daemon types into a REAL fleet pane and kills a working agent\'s tool');
      say('  call, so this stops rather than continuing.');
    } else {
      echoed = false;
      for (let i = 0; i < 24 && !echoed; i += 1) {
        await sleep(5000);
        const t = await tail(side, GREEN_KEY, 160);
        // The nonce is in this script and in the message, never on the agent's
        // disk — so it cannot appear on that pane except by having arrived.
        echoed = t.replace(/\s/g, '').includes(NONCE);
      }
      say('');
      say(`  the model echoed the token back on its pane: ${yn(echoed)}`);
      if (!echoed) {
        say('  A non-answer is reported as a non-answer. KAN-217 measured a session receiving a');
        say('  channel event perfectly and declining to act on it; from outside that is');
        say('  indistinguishable from a transport that did not deliver. It does not weaken the');
        say('  self-check verdict above, which rests on the client answering a ping.');
      }
    }

    results.green = {
      outcome: channel?.outcome ?? null,
      transport: channel?.transport ?? null,
      proved: channel?.proved === true,
      clientVersion: channel?.clientVersion ?? null,
      clientVersionVerified: channel?.clientVersionVerified === true,
      elapsedMs: channel?.elapsedMs ?? null,
      activateMs,
      reachedPrompt: PROMPT_READY.test(paneText),
      frames: frames.length,
      sessionless: row?.sessionless,
      echoed
    };

    if (!KEEP) {
      say('');
      say('  standing the green agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: GREEN_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: GREEN_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  if (PHASES.includes(2)) {
    rule('PHASE 2 — THE RED: the loop breaks, and a supervisor can SEE it   (AC 2)');
    say("The same activation against a build whose `mcp.js` receives the self-check frame and");
    say('never answers it — our own end of the contract having moved. The daemon runs the');
    say('real check against it and decides for itself.');
    say('');
    const side = await stage('red', RED_KEY, deafenSelfCheck);
    const sw = await side.call('channel_switch', { enabled: true });
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');
    say(`  channel switch: ${JSON.stringify(sw)}`);
    say('');

    const { act, startup, readyAt, selfCheckBefore } = await bringUp(side, RED_KEY);
    say(`  activate_by_key → success=${act?.success} verified=${act?.verified}`);
    say('  ^ NOTE THIS. THE ACTIVATION SUCCEEDS. A failed self-check degrades the transport');
    say('    and never refuses the agent — the ticket asks for exactly that, because T3');
    say('    already carries enough activation risk.');

    say('');
    say(`  T3's watcher still reports: ${startup.outcome}`);
    for (const l of startup.lines) say(`    | ${l.trim()}`);
    say('  ^ AND THAT IS THE POINT. T3 is satisfied: the dialog was answered, the pane is at');
    say('    a prompt, an MCP server registered. Everything T3 can see is fine. This is the');
    say('    exact state KAN-248 exists to catch — a socket that exists and a loop that does');
    say('    not work. This phase is worthless unless T3 says `ready`, which is why `bringUp`');
    say('    refuses to continue without it.');

    // The daemon waits 20s for an answer that will never come, so this poll has
    // to outlast that — 25 × 2s does.
    const { row, channel } = await awaitVerdict(side, RED_KEY, {
      attempts: 25,
      intervalMs: 2000,
      newerThan: readyAt - 60_000
    });
    if (!channel) throw new Error('no channel row for the red agent — it is not in list_agents');
    const paneText = await tail(side, RED_KEY);

    say('');
    say('  THE SELF-CHECK, verbatim from the daemon\'s own log:');
    for (const l of selfCheckLines(side).slice(selfCheckBefore)) say(`    | ${l.trim()}`);
    say('');
    say('  WHAT butchr_list_agents REPORTS FOR THIS AGENT — this is the answer to AC 2:');
    say(`    ${JSON.stringify(channel, null, 2).split('\n').join('\n    ')}`);
    say('');
    say(`  the agent came up fine                          : ${yn(PROMPT_READY.test(paneText))}`);
    say(`  self-check outcome                              : ${channel?.outcome ?? '(none)'}`);
    say(`  transport this agent's messages will take       : ${channel?.transport ?? '(none)'}`);
    say('');
    say('  AND THE FALLBACK IS A BEHAVIOUR, NOT A LABEL. One send at this agent, to show');
    say('  the gate refusing the channel rather than the listing merely saying so:');
    const send = await side.call('send_to_agent', {
      key: RED_KEY,
      type: TYPE,
      message: 'ignore this; it exists to show which carrier the daemon chose',
      workspaceType: 'task',
      workspaceKey: 'KAN-248'
    });
    say(`    transport              : ${send?.transport ?? '(none)'}`);
    say(`    transportChosenBecause : ${send?.transportChosenBecause ?? '(none)'}`);
    say(`    interrupted            : ${send?.interrupted}`);
    say('    ^ the composer, named as such, with the failed self-check as the reason. A');
    say('      sender is told which carrier ran and why; nobody has to infer it.');
    say('');
    say('  the last of the pane:');
    for (const l of paneText.split('\n').slice(-15)) say(`    | ${l}`);

    results.red = {
      outcome: channel?.outcome ?? null,
      transport: channel?.transport ?? null,
      proved: channel?.proved === true,
      clientVersion: channel?.clientVersion ?? null,
      reachedPrompt: PROMPT_READY.test(paneText),
      startupOutcome: startup.outcome,
      sendTransport: send?.transport ?? null,
      sendBecause: send?.transportChosenBecause ?? null,
      activationSucceeded: act?.success === true
    };

    if (!KEEP) {
      say('');
      say('  standing the red agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: RED_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: RED_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  rule('PHASE 3 — WHAT THE CHECK COSTS   (AC 3)');
  say('Two figures, and the second is the one that matters.');
  say('');
  if (results.green) {
    say(`  the self-check itself, end to end        : ${results.green.elapsedMs}ms`);
    say(`  the activate_by_key CALL alone returned in: ${results.green.activateMs}ms`);
    say('  (the call, not the bring-up: no wait for a capacity slot and no wait for T3)');
  }
  say('');
  say('  ADDED TO ACTIVATION LATENCY: NOTHING, and that is structural rather than a');
  say('  measurement. The check is chained onto T3\'s watcher, which the daemon fires with');
  say('  `void` from a spawn listener; no caller awaits any of it, and `activate_by_key` has');
  say('  already returned by the time T3 has answered its first dialog. The figures above');
  say('  are on different clocks for that reason — the check runs after the activation is');
  say('  over.');
  say('');
  say('  WHAT IT DOES COST, stated so it is not read as free: one socket round trip and one');
  say('  MCP ping per channel-enabled activation, plus roughly forty tokens of the agent\'s');
  say('  context for the frame itself, once. On a FAILING agent it costs the 20s the daemon');
  say('  waits for an answer that is not coming — paid once, off the critical path, and the');
  say('  agent is usable throughout. During that window the agent has no verdict and');
  say('  therefore still routes over the channel: unchecked is not failed.');

  // =====================================================================
  rule('VERDICT');
  const g = results.green;
  const r = results.red;

  if (g) {
    say(`AC1  a real activation, self-check ${g.outcome}, transport=${g.transport}, ` +
        `client version recorded=${g.clientVersion ?? 'NONE'}`);
    say(`     a real notifications/claude/channel frame left our server: ${g.frames} on the wire`);
    say(`     the model echoed a token sent over the channel: ` +
        `${g.echoed === null ? 'NOT ASKED (send did not take the channel)' : yn(g.echoed)}`);
  }
  if (r) {
    say(`AC2  with the loop broken: activation succeeded=${yn(r.activationSucceeded)}, ` +
        `T3 said '${r.startupOutcome}', self-check ${r.outcome}, transport=${r.transport}`);
    say(`     and a send at that agent took the ${r.sendTransport}`);
  }

  const ok =
    (!PHASES.includes(1) ||
      (g && g.outcome === 'passed' && g.transport === 'channel' && g.proved &&
        g.clientVersion && g.clientVersionVerified && g.reachedPrompt && g.frames >= 1)) &&
    (!PHASES.includes(2) ||
      // `outcome === 'no-answer'` and `startupOutcome === 'ready'` are asserted
      // rather than merely `transport === 'composer'`, because run 1 produced a
      // composer verdict for an agent that never came up at all. A red that is
      // red for the wrong reason is worth nothing and reads exactly like a
      // proof; these two are what tell them apart.
      (r && r.startupOutcome === 'ready' && r.outcome === 'no-answer' &&
        r.transport === 'composer' && !r.proved && r.reachedPrompt &&
        r.activationSucceeded && r.sendTransport === 'composer'));

  say('');
  if (ok) {
    say('PASS: a real agent proves its own channel loop at bring-up and records the version');
    say('      of the client it proved it on; when the loop breaks, the agent still comes up');
    say('      and every supervisor reading butchr_list_agents can see that it is on the');
    say('      composer and why.');
  } else {
    say('FAIL: at least one phase did not do what it must. Read the phases above — the row');
    say('      dumps and the log lines are the evidence, not this line.');
  }
  verdict = { ranToVerdict: true, ok, ...results };
} catch (e) {
  say('');
  say(`PROBE ERROR: ${e?.stack ?? e}`);
  for (const d of daemons) {
    const last = d.stdio.join('').slice(-800);
    if (last) say(`  a daemon's last words: ${last}`);
  }
  verdict = { ranToVerdict: false, blocked: String(e?.message ?? e) };
} finally {
  for (const d of daemons) {
    try {
      d.proc.kill();
    } catch {}
  }
  await sleep(1000);
}

say('');
say(`scratch kept at: ${scratch}`);
say(`client version this result is scoped to: ${clientVersion}`);
if (!verdict.ranToVerdict) {
  say('');
  say(`NOT TRUSTWORTHY: this run did not reach a verdict — ${verdict.blocked ?? 'see above'}.`);
}
process.exit(verdict.ranToVerdict && verdict.ok ? 0 : 1);
