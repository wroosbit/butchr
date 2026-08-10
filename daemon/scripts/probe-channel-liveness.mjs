//
// KAN-252 — the live proof that the SCHEDULED end-to-end probe reaches a real
// model, records the client version it reached it on, and reports a model that
// does not answer as a non-answer rather than as a fault.
//
// WHAT ONLY A LIVE RUN CAN SHOW. `verify-channel-liveness.mjs` drives the
// shipped decision procedure through every outcome deterministically, and every
// pane it reads is one the harness wrote. Three things are facts about a real
// Claude Code and a real model, and no deterministic harness can hold one:
//
//   1. **That a channel frame is DISPATCHED INTO A MODEL'S CONTEXT at all.**
//      That is leg 4 of the loop, it is invisible from the server, and a model
//      echo is the only instrument that reaches it. It is the entire subject of
//      this ticket.
//   2. **That an agent which has read the brief answers.** KAN-252 added a
//      paragraph to `prompts/*.md` naming this probe; `verify-operative-rules-
//      are-carried.mjs` (H-15) can prove the four files *contain* it and can
//      never prove a model *acts* on it. KAN-217 measured a session receiving a
//      channel event perfectly and correctly declining, and KAN-249 then measured
//      an UNbriefed agent complying — so neither direction is safe to assume.
//   3. **That the assembled token can only get onto a pane by being assembled.**
//      Phase 1 prints the frame off the tee'd wire beside the pane, so a reader
//      can see for themselves that the two halves went out apart.
//
// NOT a `verify-` script, deliberately (do not rename), for the reason
// `probe-briefed-channel-compliance.mjs` is not: it drives real `claude`
// processes and real models, so it is an experiment rather than a deterministic
// proof CI can re-run. A model may decline for a reason that has nothing to do
// with the transport — which is the whole point of phase 2.
//
// ---------------------------------------------------------------------------
// WHAT IT SHOWS, IN THE ORDER THE TICKET ASKS FOR IT
// ---------------------------------------------------------------------------
//   PHASE 1  THE PROOF. A real briefed agent, the shipped `channel_liveness`
//            action firing the shipped probe, the token coming back off the
//            agent's own pane, and the result recorded against the client
//            version its startup self-check read out of `initialize`.   (AC 1)
//   PHASE 2  THE NON-ANSWER. An agent briefed to ignore the probe — standing in
//            for a model that declines on the merits, which KAN-217 measured and
//            which must never be reported as a fault. The run comes back
//            `no-answer`, the drought counter moves, and the agent's transport
//            is UNCHANGED: it is still on the channel and an ordinary send to it
//            still routes there.                                        (AC 2)
//   PHASE 3  WHAT IT COSTS, measured rather than argued.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHERE ITS EVIDENCE STOPS
// ---------------------------------------------------------------------------
// It supplies the switch (on, in its own `$HOME`), the brief, and — in phase 2
// only — an instruction to the agent not to answer. It supplies NOTHING about
// the probe: the daemon mints the token, composes the message, chooses the
// recipient, writes the frame, reads the pane and decides the outcome, and the
// verdict is read back off the product's own `channel_liveness` record.
//
// **WHERE THE EVIDENCE STOPS.** A green phase 1 says a channel frame reached a
// model **on this client version, on this machine, today**. It does not say the
// fleet's next client will do the same — that is the whole reason the result is
// pinned to a version — and it does not say that a future non-answer means the
// client broke. Nothing can say that from outside the client, and
// `daemon/src/channel-liveness.ts` states the limit rather than working around it.
//
// NOTHING HERE TOUCHES THE FLEET, with the precise extent of that claim — and
// its one important caveat — stated in `lib/isolated-daemon.mjs`. Read it there:
// **a private `$HOME` gives a private daemon and NOT a private herdr**, so the
// panes are real, they take real capacity, and a composer send from here would
// reach the live fleet. The probe under test never uses the composer at all,
// which is the one thing that makes this script safe to run against real panes.
//
// Usage: node daemon/scripts/probe-channel-liveness.mjs [--keep] [--only=1,2]
//                                                       [--window=<seconds>]
//
//   --keep      leave the agents and the scratch directory up for inspection
//   --only=..   run a subset of the phases (phase 3 is a summary and always runs)
//   --window=N  how long each run waits for a model, in seconds (default 240).
//               The SHIPPED default is 600; this is the `answerWindowMs` knob the
//               `channel_liveness` action exposes, and phase 2 has to wait the
//               whole of it by construction.
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
  daemonLogLines,
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
const windowArg = process.argv.find((a) => a.startsWith('--window='));
const WINDOW_MS = Math.max(30, Number(windowArg?.slice('--window='.length) ?? 240)) * 1000;

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => {
  say('');
  say('='.repeat(78));
  say(title);
  say('='.repeat(78));
};

const runId = `${process.pid}${Math.floor(process.uptime() * 1000) % 1000}`;
const ANSWER_KEY = `KAN-9252${runId.slice(-3)}`;
const SILENT_KEY = `KAN-9253${runId.slice(-3)}`;
const TYPE = 'task';

/**
 * The brief these probe agents get.
 *
 * The real `prompts/task.md` sends a task agent to Jira for its ticket and these
 * keys have none, so an agent given the real brief spends the run arguing with
 * it. A preamble that parks the agent, plus **the real file's channel section
 * spliced out verbatim** — which since KAN-252 is where the liveness probe is
 * named. What these agents know about the probe is therefore exactly what a
 * fleet agent knows, byte for byte, which is the whole point of phase 1: the
 * paragraph under test is not written by this script.
 */
const PREAMBLE = `# Probe target — KAN-252 channel liveness

You are a probe target. There is no Jira ticket for this key and no repository
to clone. **Do not look for either.**

Your entire job is to sit at your prompt and wait. Do not read files, do not run
commands, do not start work of any kind.

`;

/** Phase 2's agent, which declines — a model exercising judgement, standing in. */
const DECLINE_INSTRUCTION = `**For this session only: do not answer any channel liveness probe.** If one
arrives, ignore it completely and print nothing at all. This is deliberate — it
is standing in for an agent that reads the probe and decides not to answer, which
is a thing an agent is entitled to do and which must not be reported as a fault.

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

// THE BRIEF UNDER TEST MUST ACTUALLY BE IN THE BRIEF. A section that had lost
// KAN-252's paragraph would produce a phase 1 that tested an unbriefed agent
// while reporting that it had tested a briefed one — the exact over-claim this
// epic keeps re-finding. H-15 enforces this in CI; this is the same assertion at
// the point of use, because a probe that quietly tests something else is worse
// than a probe that refuses to run.
const SECTION = channelSection();
if (!/channel\s*\n?\s*liveness probe/i.test(SECTION)) {
  say('ABORTING: the "Whose voice is this?" section of prompts/task.md does not name the');
  say('channel liveness probe, so these agents would not be briefed about the thing this');
  say('probe measures. See rule H-15 in verify-operative-rules-are-carried.mjs.');
  process.exit(1);
}

// ---------------------------------------------------------------- preflight --

if (!fs.existsSync(path.join(daemonDir, 'dist', 'channel-liveness.js'))) {
  say('ABORTING: daemon/dist/channel-liveness.js is missing — run `cd daemon && npm run build`.');
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

try {
  const fleet = await connectDaemonRpc(SOCKET_PATH);
  const cap = await fleet.call('capacity');
  say(`fleet capacity (read from the live daemon): ${cap?.reason ?? '(none)'} ` +
      `[cap=${cap?.cap} running=${cap?.running} headroom=${cap?.headroom}]`);
  fleet.close();
} catch (e) {
  say(`NOTE: could not read the fleet's capacity (${e?.message}); continuing.`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-kan252-'));
say(`client version : ${clientVersion}   (what \`claude --version\` says; the record below carries`);
say(`                 the version the CLIENT reported in its own initialize instead)`);
say(`run id         : ${runId}`);
say(`scratch        : ${scratch}`);
say(`answer window  : ${WINDOW_MS / 1000}s per run (shipped default is 600s)`);
say(`phases         : ${PHASES.join(', ')}`);

const results = { answered: null, silent: null };

const stage = (label, key, extraBrief = '') =>
  stageIsolatedDaemon({
    scratch,
    label,
    type: TYPE,
    key,
    promptText: PREAMBLE + extraBrief + SECTION,
    say
  });

const tail = async (side, key, lines = 160) =>
  (await side.call('tail_agent', { key, type: TYPE, lines }))?.text ?? '';

const livenessLines = (side) => daemonLogLines(side, '[ChannelLiveness]');

/** This agent's channel row out of the product's own `list_agents`. */
async function channelRow(side, key) {
  const res = await side.call('list_agents');
  const row = (res?.agents ?? []).find((a) => a.key.toLowerCase() === key.toLowerCase());
  return { row, channel: row?.channel, fleet: res?.channelLiveness, res };
}

/** Poll `list_agents` until this activation's startup self-check verdict lands. */
async function awaitSelfCheck(side, key, { attempts = 25, intervalMs = 2000, newerThan = 0 } = {}) {
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
 * THE RETRY IS NOT DEFENSIVE PADDING (KAN-248 learned this the expensive way).
 * herdr's spawn fails intermittently on this machine — KAN-24's pane-geometry
 * failure — and when it does, `activate_by_key` still answers `success: true`
 * and the PTY exits seconds later. A liveness run against an agent that never
 * came up would report `not-routed` or `no-answer`: the right shape of answer
 * for entirely the wrong reason, and it would read exactly like a proof.
 */
async function bringUp(side, key, { attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = startupLines(side).length;
    const act = await activateWaitingForRoom(side, key, { type: TYPE, say });
    if (!act?.success) throw new Error(`activation refused: ${act?.error ?? JSON.stringify(act)}`);
    const startup = await awaitStartupOutcome(side, { since: before });
    if (startup.outcome === 'ready') return { act, startup, attempt, readyAt: Date.now() };

    say('');
    say(`  ATTEMPT ${attempt} DID NOT COME UP — T3's watcher reported '${startup.outcome}'.`);
    for (const l of startup.lines) say(`    | ${l.trim()}`);
    say("  This is most likely KAN-24's intermittent herdr spawn failure rather than anything");
    say('  about the channel. Standing it down and trying again.');
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

/**
 * Fire the SHIPPED probe and wait for the SHIPPED record to move.
 *
 * The action answers immediately and the run happens behind it, so `runs` on the
 * record is what says a run finished. Polled rather than awaited because a
 * ten-minute reply would outlive any client's own timeout — see the
 * `channel_liveness` case in daemon.ts.
 */
async function fireProbe(side, { budgetMs }) {
  const before = (await side.call('channel_liveness'))?.state?.runs ?? 0;
  const kicked = await side.call('channel_liveness', {
    run: true,
    answerWindowMs: WINDOW_MS,
    panePollMs: 5000
  });
  if (kicked?.started !== true) {
    throw new Error(`the daemon would not start a probe: ${JSON.stringify(kicked)}`);
  }
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const now = await side.call('channel_liveness');
    if ((now?.state?.runs ?? 0) > before) return now.state;
  }
  throw new Error(`the probe did not finish within ${Math.round(budgetMs / 1000)}s`);
}

let verdict = { ranToVerdict: false };

try {
  // =====================================================================
  if (PHASES.includes(1)) {
    rule('PHASE 1 — THE PROOF: a channel frame reaches a real MODEL and comes back  (AC 1)');
    const side = await stage('answers', ANSWER_KEY);
    const sw = await side.call('channel_switch', { enabled: true });
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');
    say(`  channel switch: ${JSON.stringify(sw)}`);
    say("  (that is a channel.json inside this run's own $HOME — the fleet's is untouched)");
    say('');

    const { act, startup, attempt, readyAt } = await bringUp(side, ANSWER_KEY);
    say(`  activate_by_key → success=${act?.success} verified=${act?.verified} (attempt ${attempt})`);
    say(`  T3's watcher: ${startup.outcome}`);

    // The version pin comes from KAN-248's check, not from this probe. Waiting
    // for it is what makes phase 1's result a fact WITH A VERSION on it rather
    // than a fact about an unnamed client.
    const { channel } = await awaitSelfCheck(side, ANSWER_KEY, { newerThan: readyAt - 60_000 });
    say('');
    say(`  the startup self-check (KAN-248) says       : ${channel?.outcome ?? '(none)'}`);
    say(`  client version, AS THE CLIENT REPORTED IT   : ${channel?.clientVersion ?? '(none)'}`);
    say(`  that version has a measured delivery result : ${yn(channel?.clientVersionVerified === true)}`);

    say('');
    say('  Firing the SHIPPED probe through the SHIPPED action. Everything from here — the');
    say('  token, the message, the recipient, the frame, the pane read and the verdict — is');
    say('  the daemon\'s. This script supplies none of it.');
    const startedAt = Date.now();
    const state = await fireProbe(side, { budgetMs: WINDOW_MS + 120_000 });
    const took = Date.now() - startedAt;
    const last = state.lastRun;

    say('');
    say("  THE PROBE, verbatim from the daemon's own log:");
    for (const l of livenessLines(side)) say(`    | ${l.trim()}`);

    const frames = outboundFrames(side, 'notifications/claude/channel');
    const probeFrame = frames.find((f) => f?.params?.meta?.livenessProbe === true);
    const paneText = await tail(side, ANSWER_KEY);

    say('');
    say('  WHAT butchr_list_agents REPORTS FOR THE FLEET — the supervisor-facing surface:');
    say(`    ${JSON.stringify(state, null, 2).split('\n').join('\n    ')}`);
    say('');
    say(`  outcome                                     : ${last?.outcome}`);
    say(`  proved (a frame reached a MODEL)            : ${yn(last?.proved === true)}`);
    say(`  client version the result is pinned to      : ${last?.clientVersion ?? '(none)'}`);
    say(`  the agent asked                             : ${last?.address?.type}/${last?.address?.key}`);
    say(`  time from firing to a recorded result       : ${took}ms`);
    say('');
    say('  THE FRAME THAT WENT OUT, verbatim off the tee\'d wire — printed so a reader can');
    say('  see for themselves that the two halves of the token were never adjacent in it:');
    if (probeFrame) {
      say(`    | ${JSON.stringify(probeFrame.params.content)}`);
    } else {
      say('    (no liveness frame on the wire — see the outcome above for why)');
    }
    say('');
    say('  the last of the pane, where the ASSEMBLED token is (or is not):');
    for (const l of paneText.split('\n').slice(-12)) if (l.trim()) say(`    | ${l}`);

    results.answered = {
      outcome: last?.outcome ?? null,
      proved: last?.proved === true,
      clientVersion: last?.clientVersion ?? null,
      selfCheckVersion: channel?.clientVersion ?? null,
      waitedMs: last?.waitedMs ?? null,
      elapsedMs: last?.elapsedMs ?? null,
      firedToRecordedMs: took,
      frames: frames.length,
      reachedPrompt: PROMPT_READY.test(paneText),
      dialogStuck: DIALOG_ON_PANE.test(paneText),
      lastProofVersion: state.lastProof?.clientVersion ?? null
    };

    if (!KEEP) {
      say('');
      say('  standing the agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: ANSWER_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: ANSWER_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  if (PHASES.includes(2)) {
    rule('PHASE 2 — THE NON-ANSWER: a model declines, and nothing calls that a fault  (AC 2)');
    say('The same probe against an agent briefed to ignore it. This stands in for KAN-217\'s');
    say('measured refusal — a model that reads the message and decides not to answer — which');
    say('is the outcome the ticket requires be reported as a non-answer rather than a failure.');
    say(`This phase waits the WHOLE answer window (${WINDOW_MS / 1000}s) by construction.`);
    say('');
    const side = await stage('silent', SILENT_KEY, DECLINE_INSTRUCTION);
    const sw = await side.call('channel_switch', { enabled: true });
    if (sw?.enabled !== true) throw new Error('the isolated switch would not enable');
    say('');

    const { act, startup, readyAt } = await bringUp(side, SILENT_KEY);
    say(`  activate_by_key → success=${act?.success}   T3's watcher: ${startup.outcome}`);
    const before = await awaitSelfCheck(side, SILENT_KEY, { newerThan: readyAt - 60_000 });
    say(`  its startup self-check: ${before.channel?.outcome} → transport ${before.channel?.transport}`);

    const state = await fireProbe(side, { budgetMs: WINDOW_MS + 120_000 });
    const last = state.lastRun;
    const after = await channelRow(side, SILENT_KEY);

    say('');
    say("  THE PROBE, verbatim from the daemon's own log:");
    for (const l of livenessLines(side)) say(`    | ${l.trim()}`);
    say('');
    say(`  outcome                                     : ${last?.outcome}`);
    say(`  the sentence a supervisor reads             :`);
    for (const l of String(last?.detail ?? '').match(/.{1,86}(\s|$)/g) ?? []) say(`    | ${l.trim()}`);
    say('');
    say(`  nonAnswersSinceProof                        : ${state.nonAnswersSinceProof}`);
    say(`  drought (needs 3)                           : ${yn(state.drought)}`);
    say('');
    say('  AND THE AGENT IS UNCHANGED. This is the half that matters: a model declining must');
    say('  not cost that agent its channel, because declining is a judgement call and not a');
    say('  transport fault. Wiring it into the carrier decision is the change KAN-252\'s own');
    say('  ticket forbids, and this is the observation that it was not made:');
    say(`    startup self-check outcome, still          : ${after.channel?.outcome}`);
    say(`    transport this agent's messages take, still: ${after.channel?.transport}`);
    const send = await side.call('send_to_agent', {
      key: SILENT_KEY,
      type: TYPE,
      message: 'ignore this; it exists to show which carrier the daemon chose after a non-answer',
      workspaceType: 'task',
      workspaceKey: 'KAN-252'
    });
    say(`    and an ordinary send to it takes the       : ${send?.transport ?? '(none)'}`);
    say(`    because                                    : ${send?.transportChosenBecause ?? '(none)'}`);

    results.silent = {
      outcome: last?.outcome ?? null,
      proved: last?.proved === true,
      detail: last?.detail ?? '',
      clientVersion: last?.clientVersion ?? null,
      nonAnswersSinceProof: state.nonAnswersSinceProof,
      drought: state.drought,
      transportBefore: before.channel?.transport ?? null,
      transportAfter: after.channel?.transport ?? null,
      sendTransport: send?.transport ?? null,
      waitedMs: last?.waitedMs ?? null
    };

    if (!KEEP) {
      say('');
      say('  standing the agent down and deleting its workspace…');
      await side.call('deactivate_by_key', { type: TYPE, key: SILENT_KEY });
      await sleep(2000);
      await side.call('reset_by_key', { type: TYPE, key: SILENT_KEY });
      await sleep(1500);
    }
    side.close();
  }

  // =====================================================================
  rule('PHASE 3 — WHAT IT COSTS');
  if (results.answered) {
    say(`  a run that gets an answer, end to end   : ${results.answered.elapsedMs}ms ` +
        `(${results.answered.waitedMs}ms of it waiting for the model)`);
  }
  if (results.silent) {
    say(`  a run that does not, end to end         : ${results.silent.waitedMs}ms — the whole ` +
        `answer window, by construction`);
  }
  say('');
  say('  WHAT IT COSTS THE FLEET, stated so it is not read as free: one agent, once per');
  say(`  interval, is asked for one line — a model turn and a few dozen tokens of its`);
  say('  context. Nothing is asked of any other agent, nothing is interrupted (a channel');
  say('  event waits for the recipient\'s turn boundary, KAN-219) and no activation is');
  say('  affected. The agent asked is the least recently asked one, so the cost rotates.');

  // =====================================================================
  rule('VERDICT');
  const a = results.answered;
  const s = results.silent;

  if (a) {
    say(`AC1  the scheduled probe ran, outcome=${a.outcome}, proved=${yn(a.proved)}, ` +
        `pinned to client ${a.clientVersion ?? 'NONE'}`);
    say(`     and that version is the one the CLIENT reported in initialize: ` +
        `${yn(a.clientVersion === a.selfCheckVersion && a.clientVersion !== null)}`);
    say(`     a real notifications/claude/channel frame left our server: ${a.frames} on the wire`);
  }
  if (s) {
    say(`AC2  an agent that declined produced outcome=${s.outcome}, proved=${yn(s.proved)}`);
    say(`     it was NOT degraded: transport ${s.transportBefore} → ${s.transportAfter}, ` +
        `and a send to it took the ${s.sendTransport}`);
    say(`     the record counts it as a non-answer (${s.nonAnswersSinceProof}) and not as a fault`);
  }

  const ok =
    (!PHASES.includes(1) ||
      (a && a.outcome === 'echoed' && a.proved && a.clientVersion &&
        a.clientVersion === a.selfCheckVersion && a.reachedPrompt && !a.dialogStuck &&
        a.frames >= 1)) &&
    (!PHASES.includes(2) ||
      // `outcome === 'no-answer'` is asserted rather than merely "not echoed":
      // a `not-routed` or a `pane-unreadable` here would also fail to echo, and
      // would be the right shape of answer for entirely the wrong reason.
      (s && s.outcome === 'no-answer' && !s.proved && s.transportAfter === 'channel' &&
        s.sendTransport === 'channel' && /NON-ANSWER, NOT A FAILURE/.test(s.detail)));

  say('');
  if (ok) {
    say('PASS: a channel frame reached a real model and came back, on a named client version,');
    say('      through the shipped scheduled probe; and an agent that declined to answer was');
    say('      recorded as a non-answer, kept its channel, and cost nobody anything.');
  } else {
    say('FAIL: at least one phase did not do what it must. Read the phases above — the log');
    say('      lines and the record dumps are the evidence, not this line.');
  }
  verdict = { ranToVerdict: true, ok, ...results };
} catch (e) {
  say('');
  say(`PROBE ERROR: ${e?.stack ?? e}`);
  for (const d of daemons) {
    const lastWords = d.stdio.join('').slice(-800);
    if (lastWords) say(`  a daemon's last words: ${lastWords}`);
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
