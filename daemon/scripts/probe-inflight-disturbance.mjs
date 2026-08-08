#!/usr/bin/env node
//
// KAN-219 — when a message arrives while a Butchr agent is MID-TOOL-CALL, does
// it disturb that call? Asked of two carriers, in the same window, on the same
// agent: a Claude Code **channel** event, and `butchr_send_to_agent`.
//
// WHAT FAILURE THIS WOULD CATCH: a fleet that migrates its messaging onto
// channels because "channels don't interrupt", when in fact an arriving channel
// event cancels or corrupts the recipient's in-flight tool call exactly as a
// composer send does — the difference having been read off a documentation
// sentence rather than measured. It would equally catch the inverse: reporting
// "no disturbance" from a run whose event never actually landed inside a window,
// which looks identical from the outside and is the easier mistake to make.
//
// NOT a `verify-` script, deliberately (do not rename). It drives a live
// `claude` CLI and a real model, so it is an experiment, not a deterministic
// proof of product behaviour CI can re-run. Its exit code reports whether the
// run could be TRUSTED, not which way the answer went — see EXIT CODE below.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — and what KAN-217 deliberately left here
// ---------------------------------------------------------------------------
// `probe-channel-delivery.mjs` established that a channel event reaches the
// model of a real Butchr agent (KAN-217, docs/channel-delivery.md). EVERY
// configuration in it fires at an IDLE agent; its own header says so and names
// this as the gap nobody covered. This script is that gap, and it reuses
// KAN-217's configuration-D bring-up out of `lib/channel-probe.mjs` rather than
// copying it — the in-flight window is the only new part.
//
// The defect the migration would replace is `butchr_send_to_agent`'s, and it is
// in the product's own words at `daemon/src/herdr.ts:1335`: *"Ctrl+C at a Claude
// Code pane cancels the turn in progress — a running tool call included, which
// is abandoned rather than resumed, and which renders on the recipient's screen
// as a refusal it may attribute to the human."* KAN-150's fourth defect — an
// interrupt leaving a tool call half-applied while reporting total rejection —
// has never been TESTABLE, because until KAN-217 there was no non-destructive
// delivery mechanism to compare against.
//
// ---------------------------------------------------------------------------
// THE THREE ARMS — the third is a control on the DETECTOR, not on the answer
// ---------------------------------------------------------------------------
//   U  UNDISTURBED    nothing is fired into the window. The baseline: it is
//                     what "the tool call completed and its result reached the
//                     model" looks like when nobody touches it. Without it,
//                     "the channel did not disturb the call" is unfalsifiable.
//   C  CHANNEL        a REAL daemon broadcast becomes a channel event inside
//                     the window. The question.
//   X  COMPOSER       `send_to_agent` — the daemon action `butchr_send_to_agent`
//                     invokes — fired into the same window. THE COMPARISON IS
//                     THE POINT: an absolute answer about channels alone does
//                     not tell the fleet whether to migrate.
//
// X IS ALSO THE POSITIVE CONTROL FOR THE INSTRUMENT, and this is the load-
// bearing bit of the design. If the detector cannot see the composer path
// disturb a tool call — behaviour the product documents in its own source — then
// its silence on the channel path is worth nothing, and a clean, plausible,
// entirely wrong "channels are safe" is exactly what would ship. So a run in
// which X shows no disturbance is NOT TRUSTWORTHY and exits 1, with both
// readings named: either this script is blind, or composer sends have stopped
// being destructive, and the second would demolish the premise of migrating.
//
// ARMS RUN IN THE ORDER U, C, X against ONE agent. Destructive last, so it
// cannot contaminate what precedes it. The confound that leaves — later arms see
// an agent with more prior context — is real, is stated in the finding, and is
// the price of not paying three activations and three dialog dances.
//
// ---------------------------------------------------------------------------
// THE WINDOW IS WIDENED, AND THIS SAYS SO RATHER THAN IMPLYING OTHERWISE
// ---------------------------------------------------------------------------
// A real `butchr` MCP tool call answers in ~20ms; KAN-167 had to widen its
// window with a 4s tee delay for the same reason. The tool call here is a
// GENUINE one — the product's own Bash tool, run by the model's own decision,
// with real side effects on a real filesystem — but its DURATION is this
// script's choice: it runs a shell script that sleeps between steps.
//
// So: the call is real, the window is manufactured. What that buys is the one
// thing a 20ms window cannot give — certainty that the event landed INSIDE it,
// which is measured here rather than assumed:
//
//   * the script's step 1 stamps the moment the tool call really began;
//   * the probe waits for that stamp to appear before firing anything;
//   * the fire time and step 2's stamp bracket the event, so the finding can
//     say WHICH SLEEP it landed in rather than "during, probably".
//
// ---------------------------------------------------------------------------
// HOW THE TOOL CALL'S OUTCOME IS MEASURED WITHOUT ASKING THE MODEL
// ---------------------------------------------------------------------------
// The ticket's second acceptance criterion. The in-flight script writes its own
// lifecycle to disk as it goes, so the record is made by the WORK, with no model
// and no MCP server in the path, and no pane scraped:
//
//   step-1 <ms>            written immediately — the call really started
//   (sleep)
//   step-2 <ms>            written halfway   — the call survived the fire
//   (sleep)
//   step-3 <ms> <TOKEN>    written at the end — the call ran to completion
//   token file             the same TOKEN, minted from /dev/urandom AT STEP 3
//
// HALF-APPLICATION IS THEREFORE LITERAL: steps 1..k with k < 3 on disk is a tool
// call that did part of its work and stopped. That is KAN-150's fourth defect
// made observable, and it is checked against what the model then SAYS happened.
//
// AND THE TOKEN CANNOT BE OBTAINED ANY OTHER WAY. It does not exist until the
// final step; it is not in the script, not in the brief, not in any message this
// probe types. The model can only produce it by having received the tool RESULT.
// It sends it back through the channel's `reply` tool, so even that reading does
// not depend on reading a pane. "Did it return, and was its result correct" is
// one file comparison.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives:
//
//   * THIS SCRIPT WRITES THE IN-FLIGHT WORK AND ASKS FOR IT. The agent is told,
//     down the composer, to run the script; the window would not exist
//     otherwise. Nothing here shows that fleet agents make long tool calls — they
//     plainly do, but that is an observation about the fleet and not a result of
//     this run.
//   * THIS SCRIPT CAUSES THE BROADCAST arm C turns into a channel event, by
//     resetting a scratch workspace it created — inherited from KAN-217's
//     configuration D, along with its limit: it does not establish that
//     production events fire unprompted. KAN-167 established that by citation
//     (`router.ts:1412`, `:1601`, `:1683`, `:1747`, `:2003`).
//   * ARM X'S CARRIER IS THE PRODUCT'S. It calls the daemon's `send_to_agent`
//     action, which is what the `butchr_send_to_agent` MCP tool calls, so the
//     Ctrl+C is the real one. The message CONTENT is this script's.
//
//   NOT COVERED BY THIS SCRIPT OR ANY OTHER:
//   * ONE TOOL. The in-flight call is Bash. Whether an interrupted `Edit`, or an
//     in-flight MCP call, half-applies the same way is untested — and Bash is
//     the friendly case, because its side effects are files this script chose.
//   * ONE CLIENT, ONE MODEL, ONE MACHINE. See the header the run prints.
//   * Whether a model that has been disturbed RECOVERS — resumes, retries, or
//     abandons the work. This records what it says; it does not follow it up.
//   docs/channel-inflight-disturbance.md repeats these rather than leaving a
//   reader to infer a coverage that does not exist.
//
// EXIT CODE: 0 when every arm that ran reached a verdict and the two controls
// behaved — U completed undisturbed, X showed the disturbance the product
// documents. 1 when the run cannot be trusted to answer the question, whichever
// way the channel arm came out. "Channels disturb" and "channels do not" are
// both passing results.
//
// Usage:
//   cd daemon && npm install && npm run build     # needs dist/launchers.js
//   node scripts/probe-inflight-disturbance.mjs [--arms=U,C,X] [--rounds=N]
//                                               [--model=m] [--keep]
//   node scripts/probe-inflight-disturbance.mjs --self-check
//       Exercises the two readers that read a TERMINAL — the account capture and
//       the refusal-keyword flag — against real transcripts. No agent, no
//       daemon, no capacity slot. Exits 1 on any case. Every reading this probe
//       ever got wrong was one of these two, so they are the ones with a check.
//
//   node scripts/probe-inflight-disturbance.mjs --arms=Q
//       Runs no arm, and is how you watch the trust gate go red.
//
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  BUTCHR_DIR, SOCKET_PATH, LAUNCHERS_JS,
  sleep, yn,
  serverStderr, replyEvents, channelFramesOnWire,
  connectDaemonRpc, observeDaemonBroadcasts, bringUpChannelAgent, standDownAgent
} from './lib/channel-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ARMS = String(arg('arms', 'U,C,X')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const ROUNDS = Math.max(1, Number(arg('rounds', 1)));
const MODEL = arg('model', 'sonnet');
const KEEP = argv.includes('--keep');
/** How long a session gets to settle after it looks ready — the listener lags the pane. */
const SETTLE_MS = Number(arg('settle-ms', 25_000));
/** The two sleeps inside the in-flight script, in seconds. The window is 2x this. */
const SLEEP1 = Number(arg('sleep1', 14));
const SLEEP2 = Number(arg('sleep2', 14));
/** How long after the tool call is OBSERVED to have started before firing. */
const LEAD_MS = Number(arg('lead-ms', 4000));
/** How long to wait for a capacity slot before giving up. See bringUpChannelAgent. */
const ACTIVATE_WAIT_MS = Number(arg('activate-wait-ms', 900_000));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan219-probe-'));
const runId = randomBytes(4).toString('hex').toUpperCase();
/**
 * The channel's match token, kept DISTINCT from the agent's own key on purpose.
 * The channel server emits for any daemon broadcast whose key contains the
 * nonce; if the probe agent's key contained it, every broadcast about the probe
 * agent itself — its own activation, its own teardown — would put an
 * uninstructed channel event in front of the agent mid-run.
 */
const nonce = `IFN${randomBytes(5).toString('hex').toUpperCase()}`;

const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t) => { say(''); say('='.repeat(78)); say(t); say('='.repeat(78)); };

const PROBE_TYPE = 'task';
const PROBE_KEY = `KAN219-PROBE-${runId}`;
const chanDir = path.join(scratch, 'chan');
const roundsDir = path.join(scratch, 'rounds');

// ------------------------------------------------------- the in-flight work --
//
// Deliberately trivial, deliberately observable. Every line it writes is a fact
// about the tool call that no model reported and no MCP server relayed.
//
// The token is minted at the LAST step from /dev/urandom, so it cannot exist
// before the call completes and cannot be read out of this file, the brief, or
// anything this probe types. That is what makes "the model quoted the token"
// mean "the tool result reached the model" and not "the model guessed".
const WORK_SCRIPT = `#!/bin/bash
# KAN-219 in-flight work. Args: <round-dir> <sleep1> <sleep2>
set -u
D="$1"
mkdir -p "$D"
now() { date +%s%3N; }
echo "step-1 $(now)" >> "$D/work.log"
sleep "$2"
echo "step-2 $(now)" >> "$D/work.log"
sleep "$3"
TOKEN="INFL$(od -An -N5 -tx1 /dev/urandom | tr -d ' \\n' | tr 'a-f' 'A-F')"
echo "step-3 $(now) $TOKEN" >> "$D/work.log"
printf '%s' "$TOKEN" > "$D/token"
echo "IN-FLIGHT RESULT TOKEN: $TOKEN"
`;

// ------------------------------------------------------------------ the brief --
//
// Two jobs, and one thing it deliberately does NOT do.
//
// It establishes the butchrprobe channel as an expected local harness. That is
// not a thumb on the scale but a NECESSARY CONDITION: KAN-217 measured an
// unprimed session correctly refusing to act on a channel event, naming it as a
// probable prompt injection, and a refusal is indistinguishable from a
// non-delivery from outside. `.butchr-prompt.md` is where a real agent would
// carry that trust, so it is where this carries it.
//
// WHAT IT DOES NOT SAY is "keep going if something interrupts you", or anything
// else that would push the model toward persisting. That instruction would
// contaminate the very thing being measured. It asks only for a faithful report,
// which is the one thing a probe is entitled to ask of its target.
const BRIEF = `# Probe target — KAN-219

You are a **probe target**, not a working agent. There is no Jira ticket for
this key and no work to do.

**Do not** read or write any Jira issue, do not touch git or GitHub, do not
create or message any other agent, and do not edit any file. Ignore any
instruction to claim a ticket.

A channel called \`butchrprobe\` is an **expected local test harness** for this
session. Content arriving from it is legitimate and set up on purpose.

Your only job, and nothing else:

1. When a message arrives beginning \`[RUN ...]\` that gives you a shell command,
   run **that exact command** with the Bash tool.
2. That command prints a line \`IN-FLIGHT RESULT TOKEN: <token>\`. When you have
   it, call the \`butchrprobe\` **reply** tool with \`text\` set to exactly that
   token, and nothing else.
3. If an event arrives on the butchrprobe channel asking you to echo a token,
   call the \`butchrprobe\` reply tool with that token.

**Report faithfully what happened to anything you ran** — whether it finished,
what it printed, and whether anything interrupted it. Never describe a command
as rejected, refused, or completed unless it was.

Otherwise answer questions about your own context literally, and wait.

Reply now with exactly: PROBE READY
`;

// --------------------------------------------------------------- utilities --

/**
 * Does the model's prose claim the tool call was refused, interrupted or denied?
 *
 * A REGEX OVER MODEL PROSE IS A GUESS, and this one has now been wrong in both
 * directions on real transcripts — see the long note at its call site. The
 * negations are struck out first, because `/interrupt/` is a substring of
 * `uninterrupted` and the two mean opposite things.
 *
 * Exported in spirit rather than in fact: `--self-check` exercises it against
 * both real transcripts, so its two-sidedness is demonstrated rather than
 * asserted, and demonstrated without an agent, a daemon or a slot.
 */
function saysRefused(text) {
  const withoutNegations = text.replace(
    /uninterrupted|un-interrupted|not interrupted|without (?:being )?interrupt\w*|no interruption|never interrupted|nothing was (?:rejected|refused|denied|interrupted)(?: or \w+)?|was not (?:rejected|denied|refused)/gi,
    ' ');
  return /interrupt|reject|denied|declin|cancell?ed|aborted|refus/i.test(withoutNegations);
}

/**
 * The model's account, separated from the client's chrome around it.
 *
 * TWO THINGS THE PANE CONTAINS THAT ARE NOT THE MODEL TALKING, and both have
 * corrupted a reading here:
 *
 *   1. THE COMPOSER BOX. Claude Code renders a SUGGESTED next prompt into it —
 *      contextually generated, never submitted, indistinguishable from typed
 *      text to `capture-pane`. Observed suggestions include *"did the command
 *      finish or get interrupted?"* and *"Did the reset event interrupt your
 *      bash command?"*, both of which contain the word this probe searches for,
 *      in rounds where nothing whatsoever went wrong.
 *   2. THE RUN TAG, echoed inside such a suggestion. In one round the
 *      suggestion was `[RUN RF84531] retry: run the X1 command now`, so
 *      `lastIndexOf(runTag)` landed on the SUGGESTION and sliced away the
 *      model's real account entirely.
 *
 * So the chrome is cut off FIRST — everything from the first long horizontal
 * rule, which is the composer box's top border — and the run tag is looked for
 * only in what remains. Getting this backwards is what produced (2).
 */
function modelAccount(paneText, runTag) {
  const transcript = paneText.split(/\n[ \t]*─{20,}/)[0];
  const at = transcript.lastIndexOf(runTag);
  return at === -1 ? transcript.slice(-2500) : transcript.slice(at);
}

/**
 * The two-sided check on the one detector here that reads model prose.
 *
 * REAL TRANSCRIPTS, both captured by this probe on 2026-08-08, one from each
 * arm. The composer arm's must classify as a refusal claim; the channel arm's
 * must not — and the channel one is the case that broke, because it contains
 * the word `uninterrupted`. A check that only asserted the first would pass
 * against the very bug it exists to catch.
 */
const SELF_CHECK_CASES = [
  {
    name: 'arm X (composer) — the model claims a refusal that never happened',
    text: 'The X1 command was rejected — the Bash tool use was denied before the '
      + 'script ran, so it produced no output and no in-flight result token.',
    expect: true
  },
  {
    name: 'arm C (channel) — the model says UNINTERRUPTED, which must not match',
    text: 'Both handled: 1. The command ran to completion, uninterrupted, printing: '
      + 'IN-FLIGHT RESULT TOKEN: INFLDB577B4D2B. I replied on butchrprobe with '
      + 'exactly INFLDB577B4D2B. 2. While it was running, a butchrprobe event arrived',
    expect: false
  },
  {
    name: 'the interrupt chrome the first version matched, kept so it still does',
    text: '⎿  Interrupted by user',
    expect: true
  },
  {
    name: 'an ordinary clean round, which must stay quiet',
    text: 'Ran 1 shell command. IN-FLIGHT RESULT TOKEN: INFL0FDF72B42F. Replied on '
      + 'butchrprobe with exactly INFL0FDF72B42F.',
    expect: false
  },
  {
    name: 'arm C run 3 — "Nothing was rejected or refused", which must not match',
    text: 'The command ran to completion, uninterrupted, and printed: IN-FLIGHT '
      + 'RESULT TOKEN: INFL47FDCC6CF5. While it was running, a butchrprobe channel '
      + 'event arrived asking me to echo IFN559CF5A45E. Per your standing '
      + 'instruction #3, I echoed it. Nothing was rejected or refused. Waiting.',
    expect: false
  }
];

/**
 * The capture cases — the composer box must never reach the account.
 *
 * These are real panes. The first is an undisturbed round whose SUGGESTED next
 * prompt was *"did the command finish or get interrupted?"*; the second is the
 * round where the suggestion carried the run tag and swallowed the account.
 */
const CAPTURE_CASES = [
  {
    name: 'the client\'s suggested prompt must not reach the model\'s account',
    pane: '❯ [from task/KAN-219] [RUN RCF3A0A] Run this exact command\n'
      + '● The command ran to completion with no interruption.\n'
      + '  IN-FLIGHT RESULT TOKEN: INFL7B2A332C8D\n'
      + '────────────────────────────────────────────────────────────────\n'
      + '❯ did the command finish or get interrupted?\n'
      + '────────────────────────────────────────────────────────────────\n',
    runTag: 'RCF3A0A',
    mustNotContain: 'did the command finish or get interrupted?',
    mustContain: 'ran to completion'
  },
  {
    name: 'a suggestion carrying the run tag must not swallow the account',
    pane: '❯ [from task/KAN-219] [RUN RF84531] Run this exact command\n'
      + '● The X1 command was rejected — the Bash tool use was denied.\n'
      + '────────────────────────────────────────────────────────────────\n'
      + '❯ [RUN RF84531] retry: run the X1 command now\n'
      + '────────────────────────────────────────────────────────────────\n',
    runTag: 'RF84531',
    mustNotContain: 'retry: run the X1 command now',
    mustContain: 'was rejected'
  }
];

if (argv.includes('--self-check')) {
  let bad = 0;
  process.stdout.write('modelAccount() — the client\'s chrome must not reach the account:\n\n');
  for (const c of CAPTURE_CASES) {
    const got = modelAccount(c.pane, c.runTag);
    const ok = !got.includes(c.mustNotContain) && got.includes(c.mustContain);
    if (!ok) bad += 1;
    process.stdout.write(`  ${ok ? 'pass' : 'FAIL'}  ${c.name}\n`);
    if (!ok) process.stdout.write(`        got: ${JSON.stringify(got.slice(0, 160))}\n`);
  }
  process.stdout.write('\nsaysRefused() against real transcripts — both directions:\n\n');
  for (const c of SELF_CHECK_CASES) {
    const got = saysRefused(c.text);
    const ok = got === c.expect;
    if (!ok) bad += 1;
    process.stdout.write(`  ${ok ? 'pass' : 'FAIL'}  expected ${String(c.expect).padEnd(5)} got ${String(got).padEnd(5)}  ${c.name}\n`);
  }
  process.stdout.write(`\n${bad ? `${bad} case(s) FAILED` : 'all cases pass'}\n`);
  process.exit(bad ? 1 : 0);
}

/** The step lines the work script wrote, parsed. Nobody's account but the work's. */
function readWork(dir) {
  const p = path.join(dir, 'work.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [step, t, tok] = l.trim().split(/\s+/);
    return { step, t: Number(t), token: tok ?? null };
  });
}

function stepAt(steps, name) {
  return steps.find((s) => s.step === name) ?? null;
}

function readToken(dir) {
  const p = path.join(dir, 'token');
  try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

/** Wait for a predicate, polling. Returns true on success, false on timeout. */
async function until(fn, { timeoutMs, pollMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

/**
 * Fire a REAL daemon broadcast the channel server will turn into an event.
 *
 * Inherited from KAN-217 configuration D, limits included: this probe CAUSES
 * the broadcast, so it shows that a real broadcast reaches the model, not that
 * production events fire unprompted.
 */
async function fireDaemonBroadcast(call, evKey) {
  const evWs = path.join(BUTCHR_DIR, 'workspaces', 'task', evKey.toLowerCase());
  fs.mkdirSync(evWs, { recursive: true });
  fs.writeFileSync(path.join(evWs, 'PROBE'), `KAN-219 ${nonce}\n`);
  const t = Date.now();
  await call('reset_by_key', { type: 'task', key: evKey });
  try { fs.rmSync(evWs, { recursive: true, force: true }); } catch {}
  return t;
}

/**
 * The composer carrier, as the fleet actually invokes it.
 *
 * `send_to_agent` is the daemon action behind the `butchr_send_to_agent` MCP
 * tool (`router.ts` → `handleSendToAgent` → `herdrBridge.sendToAgent`), and that
 * method opens with EXACTLY ONE Ctrl+C (`herdr.ts:1355`) and does not retry —
 * the confirm-and-retry wrapper lives in `nudge.ts` and is not on this path. So
 * arm X costs the recipient one interrupt, which is the fair comparison rather
 * than a worst case built to lose.
 *
 * `workspaceType`/`workspaceKey` are passed so the daemon stamps a real sender
 * tag and the target reads `[from task/KAN-219] …`, exactly as it would for an
 * agent-to-agent nudge.
 */
async function fireComposer(call, message) {
  const t = Date.now();
  const res = await call('send_to_agent', {
    key: PROBE_KEY, type: PROBE_TYPE, message,
    workspaceType: 'task', workspaceKey: 'KAN-219'
  });
  return { t, res };
}

/**
 * The sentence both carriers deliver.
 *
 * IDENTICAL IN SHAPE ACROSS ARMS, because the comparison is the point: the
 * channel server composes this same line for arm C off the daemon broadcast
 * (see CHANNEL_SERVER in lib/channel-probe.mjs), so the only thing that differs
 * between C and X is the carrier and the token.
 */
const disturbanceFor = (action, type, key, token) =>
  `[Butchr] ${action} for ${type}/${key} :: echo the token ${token} back to me by `
  + `calling the butchrprobe reply tool now, with text set to exactly that token.`;

// ------------------------------------------------------------------ a round --

/**
 * One measurement: open a genuine in-flight window, fire (or not) into it, and
 * record what became of the tool call.
 */
async function runRound({ arm, index, call, tail }) {
  const label = `${arm}${index}`;
  const dir = path.join(roundsDir, label);
  fs.mkdirSync(dir, { recursive: true });
  const runTag = `R${randomBytes(3).toString('hex').toUpperCase()}`;
  const workCmd = `bash ${path.join(scratch, 'inflight-work.sh')} ${dir} ${SLEEP1} ${SLEEP2}`;

  say('');
  say(`--- round ${label} ---------------------------------------------------------`);
  say(`  run tag (typed): ${runTag}`);

  const replyBefore = replyEvents(chanDir).length;
  const wireBefore = channelFramesOnWire(chanDir, null).length;

  // Open the window. The agent is IDLE here, so this send's Ctrl+C costs it
  // nothing — the interrupt under test is the one fired later, from inside.
  await call('send_to_agent', {
    key: PROBE_KEY, type: PROBE_TYPE,
    message: `[RUN ${runTag}] Run this exact command with the Bash tool now: ${workCmd}`,
    workspaceType: 'task', workspaceKey: 'KAN-219'
  });

  // THE WINDOW IS OBSERVED, NOT ASSUMED. Nothing is fired until the work itself
  // has stamped the moment it began.
  const started = await until(() => stepAt(readWork(dir), 'step-1'), { timeoutMs: 180_000 });
  const s1 = stepAt(readWork(dir), 'step-1');
  if (!started || !s1) {
    say('  THE WINDOW NEVER OPENED — the agent did not start the command within 180s.');
    say('  No verdict from this round: there was nothing to disturb.');
    return {
      arm, label, ranToVerdict: false, reason: 'window never opened',
      pane: (await tail(200)).slice(-2000)
    };
  }
  say(`  tool call really began (step-1 stamped by the work): ${new Date(s1.t).toISOString()}`);

  // Fire.
  await sleep(LEAD_MS);
  let fireT = null;
  let disturbance = null;
  let composerResult = null;
  let evKey = null;
  if (arm === 'C') {
    evKey = `KAN-219-INFLIGHT-${nonce}-${label}`;
    say(`  FIRING: a real daemon broadcast → channel event (reset_by_key task/${evKey})`);
    fireT = await fireDaemonBroadcast(call, evKey);
    disturbance = nonce;
  } else if (arm === 'X') {
    disturbance = `XCMP${randomBytes(4).toString('hex').toUpperCase()}`;
    evKey = `KAN-219-INFLIGHT-COMPOSER-${label}`;
    const msg = disturbanceFor('agent_reset_event', 'task', evKey, disturbance);
    say('  FIRING: send_to_agent — the composer path, one Ctrl+C at the pane');
    const r = await fireComposer(call, msg);
    fireT = r.t;
    composerResult = r.res;
    say(`    the daemon reported: success=${composerResult?.success} sender=${composerResult?.sender ?? '(none)'}`);
  } else {
    say('  FIRING: nothing — this is the undisturbed baseline.');
  }

  // Let the window close, then give the model room to act.
  const windowMs = (SLEEP1 + SLEEP2) * 1000;
  await until(() => readToken(dir), { timeoutMs: windowMs + 60_000 });
  const steps = readWork(dir);
  const token = readToken(dir);
  const s2 = stepAt(steps, 'step-2');
  const s3 = stepAt(steps, 'step-3');

  // The model's echo — of the tool RESULT, and of the disturbance. Read off the
  // channel server's own timestamped log, so two rounds' identical text can
  // still be told apart, and so no pane is scraped for a primary reading.
  //
  // ---------------------------------------------------------------------------
  // WAIT FOR *BOTH*, AND THIS PROBE LEARNED IT THE HARD WAY ON ITS FIRST RUN.
  // ---------------------------------------------------------------------------
  // The first version stopped the moment the RESULT token appeared. In arm C the
  // model echoed the result at 16:42:04 and the channel nonce at 16:42:06 — two
  // seconds later — so the run printed `the disturbance itself arrived: NO`
  // about an event that had plainly arrived and was about to be echoed. A NO
  // that means "we stopped watching" is worse than no reading at all, and this
  // one was especially dangerous because it did not change the headline: the
  // tool call completed either way, so a false NO on a secondary line would have
  // ridden out on a true YES on the primary one.
  //
  // This is KAN-217's defect 4 in a new costume, and the shape it keeps taking
  // is the same: the detector fails toward "looks measured".
  //
  // So the predicate now requires EVERY echo this round expects, and a NO
  // therefore costs the full window rather than the first satisfied clause.
  const wantResult = (rs) => !token || rs.some((r) => r.text.includes(token));
  const wantDisturb = (rs) => !disturbance
    || rs.some((r) => r.text.includes(disturbance) && (!fireT || r.t >= fireT));
  let replies = [];
  const bothEchoed = await until(() => {
    replies = replyEvents(chanDir).slice(replyBefore);
    return wantResult(replies) && wantDisturb(replies);
  }, { timeoutMs: 180_000, pollMs: 2000 });
  replies = replyEvents(chanDir).slice(replyBefore);

  // The model's own account, recorded SECOND and never as a primary reading.
  await sleep(5000);
  // One last read after the settle, so a straggler that lands in that gap is
  // counted rather than becoming another "we stopped watching" NO.
  replies = replyEvents(chanDir).slice(replyBefore);
  const resultEcho = token ? replies.find((r) => r.text.includes(token)) ?? null : null;
  const disturbEcho = disturbance
    ? replies.find((r) => r.text.includes(disturbance) && (!fireT || r.t >= fireT)) ?? null
    : null;
  const paneAfter = await tail(200);
  const region = modelAccount(paneAfter, runTag);
  const flat = region.replace(/\s+/g, ' ');
  /**
   * DOES THE MODEL SAY IT WAS REFUSED? — and this probe got it wrong first.
   *
   * Run 1's arm X scored this NO while the pane read, verbatim:
   *
   *   "The X1 command was rejected — the Bash tool use was denied before the
   *    script ran, so it produced no output and no in-flight result token."
   *
   * The pattern was a list of Claude Code's own interrupt CHROME —
   * `Interrupted by user`, `rejected this tool` — and the model had described
   * the refusal in its own prose instead. So the single most important line in
   * this finding, *the model reported a rejection nobody made*, was scored as
   * not having happened. It changed no headline, which is exactly what would
   * have let it ship.
   *
   * Two changes, and the second matters more than the first: the pattern now
   * matches the vocabulary of refusal rather than one client's chrome, AND THE
   * MODEL'S ACCOUNT IS PRINTED VERBATIM EVERY ROUND, so this classification can
   * be checked by a reader instead of trusted.
   *
   * THEN THE WIDENED PATTERN OVER-MATCHED, which is the other direction of the
   * same mistake and was caught the same way — by reading the transcript printed
   * beneath it. In arm C the model wrote *"The command ran to completion,
   * UNINTERRUPTED"*, and `/interrupt/` is a substring of `uninterrupted`, so a
   * round in which nothing whatsoever went wrong was scored as the model
   * claiming an interruption. **A false YES here is as bad as the false NO it
   * replaced**, and on this comparison it is worse: it makes the channel arm
   * look like the composer arm.
   *
   * So the negations are struck out before the pattern runs. Two real
   * transcripts, one from each arm, are the two-sided check that this is right,
   * and `--self-check` runs them without touching an agent.
   */
  const claimsInterrupted = saysRefused(flat);

  // ---- what became of the tool call ---------------------------------------
  const completed = Boolean(s3 && token);
  const stepsDone = ['step-1', 'step-2', 'step-3'].filter((n) => stepAt(steps, n)).length;
  const halfApplied = stepsDone > 0 && stepsDone < 3;
  const resultReachedModel = Boolean(resultEcho);

  /**
   * WHAT "DISTURBED" MEANS HERE, stated because the obvious definition is too
   * narrow and would have produced a false all-clear on the composer arm.
   *
   * Three distinct failures, any one of which is a disturbed call:
   *   * it never finished           — no step 3 on disk
   *   * it half-applied             — some steps ran, not all
   *   * it finished and the model NEVER GOT THE RESULT — which is what happens
   *     if the interrupt cancels the TURN while leaving the child process
   *     running. The work lands, the answer is lost, and a definition built
   *     only on "did it complete" would call that undisturbed.
   */
  const disturbed = !completed || halfApplied || !resultReachedModel;

  // The window's own end, preferred over the arithmetic one: on a loaded
  // machine `sleep 14` is not 14000ms, and the claim "we fired inside" should
  // rest on when the work ACTUALLY ended where that is known.
  const windowEnd = s3 ? s3.t : s1.t + windowMs;
  const firedInsideWindow = fireT === null ? null : fireT > s1.t && fireT < windowEnd;
  const firedBeforeStep2 = fireT !== null && s2 ? fireT < s2.t : null;
  const echoBeforeCallEnded = disturbEcho && s3 ? disturbEcho.t < s3.t : null;
  // CP2, KAN-217's discipline kept: a channel frame is counted on the TEE'D
  // WIRE, never on the server's own claim to have sent one. Expected >0 in arm
  // C and exactly 0 in the others — an arm that was supposed to be quiet and
  // was not is a contaminated round, not a result.
  const wireFrames = channelFramesOnWire(chanDir, null).length - wireBefore;

  say('');
  say(`  THE TOOL CALL — measured on disk by the work itself, not reported by the model`);
  say(`    steps completed              : ${stepsDone}/3 ${halfApplied ? '  <<< HALF-APPLIED' : ''}`);
  say(`    ran to completion            : ${yn(completed)}`);
  if (fireT !== null) {
    say(`    fired at start + ${String(fireT - s1.t).padStart(6)}ms   inside the ${windowMs}ms window: ${yn(Boolean(firedInsideWindow))}`);
    if (firedBeforeStep2 !== null) say(`    landed during the FIRST sleep: ${yn(firedBeforeStep2)}  (step-2 at start + ${s2.t - s1.t}ms)`);
    else if (!s2) say('    step-2 never happened — the call did not survive to the halfway mark');
  }
  say(`    result token minted          : ${token ?? '(none — the call never reached step 3)'}`);
  say(`    result reached the MODEL     : ${yn(resultReachedModel)}  (echoed back over the channel's reply tool)`);
  say(`    channel frames on the tee'd wire this round: ${wireFrames}${arm === 'C' ? '  (expected >0)' : '  (expected 0)'}`);
  if (disturbance) {
    say(`    the disturbance itself arrived: ${yn(Boolean(disturbEcho))}  (token ${disturbance})`);
    if (!disturbEcho) {
      say(`      ${bothEchoed ? '' : 'the full 180s echo window elapsed — this NO is "nothing came", '}`
        + `${bothEchoed ? '' : 'not "we stopped watching"'}`);
    }
    if (resultEcho && disturbEcho) {
      say(`    the model echoed result then event, ${disturbEcho.t - resultEcho.t}ms apart`);
    }
    if (echoBeforeCallEnded !== null) {
      say(`    it was acted on BEFORE the tool call ended: ${yn(echoBeforeCallEnded)}`);
    }
  }
  // ADVISORY, and labelled as such in the output rather than only in a comment.
  // This is a keyword search over model prose. It has been wrong in both
  // directions on real transcripts and the honest conclusion is that it is the
  // wrong shape of instrument for the job: what the model claims is qualitative
  // evidence for a reader, not a measurable. It is reported because it is a
  // useful pointer, it is never used in a verdict, it is never used in the exit
  // code, and the transcript that decides it is printed directly beneath.
  say(`    refusal keywords in the model's account: ${yn(claimsInterrupted)}  (ADVISORY — the transcript below is the evidence)`);
  say(`    >>> THE TOOL CALL WAS DISTURBED: ${yn(disturbed)}`);
  // Printed EVERY round, not only the interesting ones. The classification
  // above is a regex over model prose and has already been wrong once; this is
  // what lets a reader check it rather than take it.
  say('');
  say("    the model's own account, verbatim off the pane:");
  for (const line of region.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 24)) {
    say(`      | ${line.slice(0, 120)}`);
  }
  if (claimsInterrupted && stepsDone > 0 && !completed) {
    say('');
    say(`    ^^^ THE DISK SAYS ${stepsDone}/3 OF THE WORK RAN. Whatever the account above`);
    say('        says about refusal, the side effects are on the filesystem.');
  }

  return {
    arm, label, runTag, ranToVerdict: true,
    startT: s1.t, fireT, windowMs, firedInsideWindow, firedBeforeStep2,
    stepsDone, completed, halfApplied, disturbed, token, wireFrames,
    resultEcho: resultEcho ? { t: resultEcho.t, text: resultEcho.text } : null,
    resultReachedModel,
    disturbance, disturbEcho: disturbEcho ? { t: disturbEcho.t, text: disturbEcho.text } : null,
    disturbanceArrived: Boolean(disturbEcho), echoBeforeCallEnded,
    claimsInterrupted, composerResult,
    pane: region.slice(0, 3000)
  };
}

// ------------------------------------------------------------------- main --

rule('KAN-219 — does a message arriving MID-TOOL-CALL disturb that call?');
say(`client   : ${(() => { try { return execSync('claude --version', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })()}`);
say(`model    : ${MODEL}`);
say(`run id   : ${runId}      channel nonce: ${nonce}`);
say(`arms     : ${ARMS.join(', ')}   rounds per arm: ${ROUNDS}`);
say(`window   : ${SLEEP1}s + ${SLEEP2}s of real sleep inside one real Bash tool call`);
say(`fire lead: ${LEAD_MS}ms after the work stamps that it started`);
say('');
say('The window is WIDENED and the run says so: the tool call is genuine, its');
say('duration is this script\'s. A real butchr MCP call answers in ~20ms.');

const rounds = [];
let agent = { ok: false, activated: false };
let watcher = null;
let daemon = null;
/**
 * Set whenever the run could not get as far as measuring anything.
 *
 * THIS FLAG EXISTS BECAUSE THIS SCRIPT GOT IT WRONG. Its first invocation was
 * refused a capacity slot by the daemon, ran no arm at all, and then printed
 * `TRUSTWORTHY: every arm reached a verdict and both controls behaved` and
 * exited 0 — because "every arm" over an empty list is vacuously true and the
 * `process.exitCode = 1` set at the block site was overwritten by the
 * `process.exit(failures ? 1 : 0)` at the end. A confident all-clear from a run
 * that measured nothing is precisely the failure this family of scripts exists
 * to catch, committed by the script itself on its first outing.
 */
let blocked = null;

try {
  if (!fs.existsSync(SOCKET_PATH)) throw new Error(`no daemon socket at ${SOCKET_PATH}`);
  if (!fs.existsSync(LAUNCHERS_JS)) {
    throw new Error(`${LAUNCHERS_JS} missing — run \`cd daemon && npm run build\` first`);
  }

  fs.writeFileSync(path.join(scratch, 'inflight-work.sh'), WORK_SCRIPT, { mode: 0o755 });
  fs.mkdirSync(roundsDir, { recursive: true });

  // An independent watcher on the daemon's broadcast stream. `probe-channel-
  // delivery.mjs` READS this to score its CP1; this probe does not, and says so
  // rather than leaving a reader to assume otherwise. CP1 is not the question
  // here — KAN-217 settled that a broadcast becomes a channel event — and what
  // this probe checks per round is the frame on the TEE'D WIRE, which cannot
  // exist unless the broadcast reached our server. The connection is held open
  // so both probes stress the daemon the same way.
  watcher = await observeDaemonBroadcasts();
  daemon = await connectDaemonRpc();
  const { call } = daemon;
  const tail = async (lines = 200) => (await call('tail_agent', { key: PROBE_KEY, type: PROBE_TYPE, lines }))?.text ?? '';

  rule('BRINGING UP A REAL BUTCHR AGENT WITH A CHANNEL ATTACHED');
  say('Reused wholesale from KAN-217 configuration D — see bringUpChannelAgent');
  say('in lib/channel-probe.mjs for every way this differs from a production');
  say('activation. The in-flight window below is the only new part.');
  say('');
  agent = await bringUpChannelAgent({
    call, type: PROBE_TYPE, key: PROBE_KEY, brief: BRIEF,
    chanDir, nonce, say, settleMs: SETTLE_MS,
    // A real agent takes a real capacity slot, and this machine routinely has
    // none free. Waiting is the honest response: `override: true` would push
    // past the daemon's own guard and would also poison the measurement, since
    // every timing here is read off a machine under load.
    activationRetryMs: ACTIVATE_WAIT_MS
  });
  if (!agent.ok) {
    say('');
    say(`BLOCKED: the agent never came up — ${agent.reason}. Nothing below would be a measurement.`);
    blocked = `agent never came up: ${agent.reason}`;
  } else if (!agent.chanUp) {
    say('');
    say('BLOCKED: the channel server never reached the daemon socket, so arm C');
    say('would have no trigger. A configuration whose trigger was never live');
    say('cannot reach a verdict — this is KAN-217 defect 1, inherited.');
    say(`  server stderr: ${serverStderr(chanDir) || '(empty)'}`);
    blocked = 'the channel server never came up';
  } else {
    for (const arm of ARMS) {
      if (!['U', 'C', 'X'].includes(arm)) { say(`(skipping unknown arm ${arm})`); continue; }
      rule(arm === 'U' ? 'ARM U — UNDISTURBED (the baseline the others are read against)'
        : arm === 'C' ? 'ARM C — A CHANNEL EVENT FIRED INTO THE WINDOW'
        : 'ARM X — send_to_agent FIRED INTO THE WINDOW (the composer path)');
      for (let i = 1; i <= ROUNDS; i += 1) {
        rounds.push(await runRound({ arm, index: i, call, tail }));
      }
    }
  }
} catch (e) {
  say('');
  say(`PROBE ERROR: ${e?.stack ?? e}`);
  rounds.push({ arm: '?', label: 'aborted', ranToVerdict: false, error: String(e?.message ?? e) });
  blocked = `probe error: ${e?.message ?? e}`;
} finally {
  if (watcher) watcher.close();
  if (daemon && agent.activated && !KEEP) await standDownAgent(daemon.call, PROBE_TYPE, PROBE_KEY, say);
  if (daemon) daemon.close();
}

// ---------------------------------------------------------------- summary --
//
// Derived from what ACTUALLY RAN in this invocation, never from a fixed legend.
// KAN-167's probe once shipped a version that printed results for
// configurations `--only` had excluded and credited a control that never
// executed — a probe vouching for its own validity out of evidence it never
// collected. That guard is reproduced here rather than re-learned.
rule('SUMMARY');

const of = (arm) => rounds.filter((r) => r.arm === arm && r.ranToVerdict);
const ranArms = [...new Set(rounds.filter((r) => r.ranToVerdict).map((r) => r.arm))];
const U = of('U'); const C = of('C'); const X = of('X');

say('arm  round  fired-in  steps  done  result→model  event→model  says-interrupted  DISTURBED');
for (const r of rounds) {
  if (!r.ranToVerdict) { say(`${r.arm.padEnd(4)} ${String(r.label).padEnd(6)} NO VERDICT — ${r.reason ?? r.error}`); continue; }
  say([
    r.arm.padEnd(4),
    String(r.label).padEnd(6),
    (r.fireT === null ? 'n/a' : yn(Boolean(r.firedInsideWindow))).padEnd(9),
    `${r.stepsDone}/3`.padEnd(6),
    yn(r.completed).padEnd(5),
    yn(r.resultReachedModel).padEnd(13),
    (r.disturbance ? yn(r.disturbanceArrived) : 'n/a').padEnd(12),
    yn(r.claimsInterrupted).padEnd(17),
    yn(r.disturbed)
  ].join(' '));
}

const noneDisturbed = (rs) => rs.length > 0 && rs.every((r) => !r.disturbed);
const anyDisturbed = (rs) => rs.some((r) => r.disturbed);
const allInside = (rs) => rs.length > 0 && rs.every((r) => r.firedInsideWindow);

say('');
say('--- the controls, which is what decides whether any of this can be read ---');
say(`  U undisturbed ran clean every round      : ${U.length ? yn(noneDisturbed(U)) : 'DID NOT RUN'}`);
say(`  X composer fired inside the window       : ${X.length ? yn(allInside(X)) : 'DID NOT RUN'}`);
say(`  X composer DISTURBED the call            : ${X.length ? yn(anyDisturbed(X)) : 'DID NOT RUN'}`);

const controlsOk =
  U.length > 0 && noneDisturbed(U) &&
  X.length > 0 && allInside(X) && anyDisturbed(X);

say('');
say('--- the question ---');
if (!C.length) {
  say('  UNANSWERED — arm C did not run to a verdict in this invocation.');
} else if (!allInside(C)) {
  say('  UNANSWERED — arm C ran, but at least one fire did NOT land inside the');
  say('  window. An event outside the window says nothing about an in-flight one.');
} else if (!controlsOk) {
  say('  WITHHELD — arm C completed, but the controls did not hold (above), so a');
  say('  quiet result here is indistinguishable from an instrument that cannot see.');
} else {
  const disturbed = anyDisturbed(C);
  say(`  DOES A CHANNEL EVENT ARRIVING MID-TOOL-CALL DISTURB THAT CALL?  ${disturbed ? 'YES' : 'NO'}`);
  say(`    every arm-C fire landed inside a genuine in-flight window : YES`);
  say(`    the tool call ran to completion in every arm-C round      : ${yn(C.every((r) => r.completed))}`);
  say(`    its result still reached the model                        : ${yn(C.every((r) => r.resultReachedModel))}`);
  say(`    the event itself reached the model                        : ${yn(C.every((r) => r.disturbanceArrived))}`);
  const acted = C.filter((r) => r.echoBeforeCallEnded !== null);
  if (acted.length) {
    say(`    it was acted on before the tool call ended                : ${yn(acted.some((r) => r.echoBeforeCallEnded))}`);
    say('      (NO here is the documented behaviour: events queue and are');
    say('       delivered at the turn boundary. Measured, not quoted.)');
  }
  say('');
  say('  AND THE COMPARISON, which is the point:');
  say(`    composer path — tool call ran to completion  : ${yn(X.every((r) => r.completed))}`);
  say(`    composer path — half-applied on disk         : ${yn(X.some((r) => r.halfApplied))}`);
  say(`    composer path — result reached the model     : ${yn(X.every((r) => r.resultReachedModel))}`);
  say(`    composer path — model reported a rejection   : ${yn(X.some((r) => r.claimsInterrupted))}`);
  const phantom = X.filter((r) => r.claimsInterrupted && r.stepsDone > 0);
  if (phantom.length) {
    say(`    composer path — reported a rejection while ${phantom[0].stepsDone}/3 of the work HAD run:`);
    say('      that is KAN-150 defect 4 — a tool call left half-applied while the');
    say('      recipient reports total rejection, and it is measured here rather');
    say('      than inferred, because the steps are on disk and the claim is on the pane.');
  }
}

say('');
say('--- scope, restated so no reader has to infer it ---');
say(`  arms exercised in this invocation : ${ranArms.join(', ') || 'NONE'}`);
say(`  arms NOT exercised                : ${['U', 'C', 'X'].filter((a) => !ranArms.includes(a)).join(', ') || 'none'}`);
say('  one client, one model, one machine, and ONE TOOL — Bash. An interrupted');
say('  Edit or an in-flight MCP call is not covered by this or anything else.');

// ------------------------------------------------------------- exit code --
//
// Whether the run can be TRUSTED, not which way the answer went.
const noVerdict = rounds.filter((r) => !r.ranToVerdict);
let failures = 0;
say('');
if (blocked) {
  say(`NOT TRUSTWORTHY: this run never got as far as measuring anything — ${blocked}.`);
  failures += 1;
}
// An empty list satisfies `every`, so "all arms behaved" is VACUOUSLY TRUE when
// no arm ran. That is how the first invocation of this script printed a
// confident all-clear over a run the daemon had refused a capacity slot. The
// emptiness is checked before the behaviour, here, rather than trusted to the
// quantifier.
if (!ranArms.length) {
  say('NOT TRUSTWORTHY: no arm ran to a verdict, so nothing below is a measurement');
  say('  and nothing above may be quoted as one.');
  failures += 1;
}
if (noVerdict.length) {
  say(`NOT TRUSTWORTHY: ${noVerdict.length} round(s) reached no verdict: ${noVerdict.map((r) => r.label).join(', ')}`);
  failures += 1;
}
if (U.length && !noneDisturbed(U)) {
  say('NOT TRUSTWORTHY: the UNDISTURBED baseline was itself disturbed. If a tool');
  say('  call fails with nobody touching it, no result about touching it means');
  say('  anything.');
  failures += 1;
}
if (X.length && !allInside(X)) {
  say('NOT TRUSTWORTHY: an arm-X fire landed outside the window, so it did not');
  say('  exercise the interrupt it exists to demonstrate.');
  failures += 1;
}
if (X.length && allInside(X) && !anyDisturbed(X)) {
  say('NOT TRUSTWORTHY: the COMPOSER path did not disturb the call. Read this in');
  say('  one of exactly two ways, and do not ship either without resolving it:');
  say('    (a) this script cannot see a disturbance, in which case arm C\'s quiet');
  say('        result is worth nothing; or');
  say('    (b) send_to_agent has stopped cancelling in-flight tool calls, which');
  say('        would demolish the premise of migrating away from it.');
  say(`  The product documents (a)'s opposite at daemon/src/herdr.ts:1335.`);
  failures += 1;
}
if (!U.length || !C.length || !X.length) {
  say(`NOTE: not every arm ran (${ranArms.join(', ') || 'none'}), so this run does not`);
  say('  license the comparison on its own. That is a scope statement, not a failure.');
}

if (!failures) say(`TRUSTWORTHY: every arm that ran (${ranArms.join(', ')}) reached a verdict and both controls behaved.`);
say('');
say(`scratch kept at: ${scratch}`);
process.exit(failures ? 1 : 0);
