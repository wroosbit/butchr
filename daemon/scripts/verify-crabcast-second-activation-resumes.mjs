// KAN-396 AC2: does a SECOND activation at a path CrabCast has run before
// RESUME the first activation's conversation? Measured by observation, twice at
// one throwaway path, on a real CrabCast daemon.
//
// WHAT FAILURE THIS WOULD CATCH: the cutover being costed on the wrong number.
// KAN-396's description asserts "every CrabCast activation cold-starts, forever
// — a permanent loss of resumability across the whole fleet", and the cutover
// document is about to be written from it. That sentence rests on AC1's answer,
// which established something strictly narrower: **Butchr cannot ASK for a
// resume.** It does not establish that **CrabCast never GRANTS one.** Their own
// durable record governs, so a path Butchr has activated before may resume with
// nobody asking. If it does, the cutover costs ONE COLD START PER WORKSPACE and
// the "permanent loss" sentence is false; if it does not, the ticket's premise
// stands. This script is the instrument that tells those two apart, and they are
// very different numbers to write into a document people will act on.
//
// CI-RUNNABLE: no — needs a real CrabCast daemon, real capacity for one agent,
// and it starts a real `claude` process that spends real tokens.
//
// ── WHAT IS MEASURED HERE VERSUS WHAT IS INHERITED (KAN-396 AC5) ───────────
//
// MEASURED by this script, on this machine, at the peer build it prints:
//   - whether a second `activate_agent` at a path that has run before reports
//     `resumedExistingConversation: true` on the wire;
//   - whether the second session CONTINUES the first session's transcript file
//     on disk, which is the same question asked of an instrument that is
//     neither the wire nor the agent.
//
// INHERITED, cited and NOT re-verified here:
//   - AC1's contract read (`epic/KAN-203`, comment 12162; ruled by `epic/KAN-39`,
//     comment 12166): a resume signal is NOT settable over the wire — NO, not
//     silent. This script does not re-open it and sends no resume field.
//   - `epic/KAN-59`'s reading of CrabCast's three resume conditions, which is a
//     read of THEIR source. This script reads none of it: invariant 10.
//
// ── WHY THIS DOES NOT PROBE THE WIRE WITH A RESUME KEY ─────────────────────
//
// `epic/KAN-39` refused that explicitly and permanently (comment 12166 §4). It
// is not refused here as a scheduling matter and it is not worked around: the
// frames this script sends are exactly the two frames `provision()` already
// sends — `configure_agent` with `path`/`priority`/`launcher`/`prompt`/
// `mcpServers`, and `activate_agent` with `path`. **No undocumented key is
// sent.** What is new is only that this script READS fields off
// `activate_response` that `provision()` currently drops on the floor, and every
// one of them is published in `docs/read-path-contract.md` v8 as an output.
// Reading a documented output is not probing for an undocumented affordance.
//
// ── THE INSTRUMENTS, AND WHY THERE ARE TWO ─────────────────────────────────
//
// §5 reads `activate_response.resumedExistingConversation`, documented as "the
// resume rule, reported rather than merely obeyed". That is CrabCast telling us
// what it decided.
//
// §6 asks the same question of the DISK. Activation 2's session is driven
// through a real turn writing a second marker, BETA, and the question is WHICH
// CONVERSATION FILE it lands in: the one activation 1 wrote — which only a
// continued conversation can do — or a new one, which is what a cold start
// opens. **Two defects were found in this section by running it, and both are
// documented in place rather than tidied away: it first watched for file growth
// (a resumed agent nobody nudged writes nothing), and it then keyed on a marker
// that turned out to ride in the configured prompt and so appeared in both
// worlds.** The surviving signal is file identity, which no prompt can forge.
//
// **They are independent, and that is the point.** The wire field is CrabCast's
// account of its own behaviour, and this ticket's standing instruction is not to
// read a verdict off the actor's own account of itself (`task/KAN-417` and
// `task/KAN-293` both re-read through a separate connection with a unique run
// marker; this copies that). The disk read is neither the wire nor the agent.
// If the two ever disagree, that disagreement is the finding and the script says
// so rather than picking the convenient one.
//
// ── HOW IT WAS MADE TO GO RED (KAN-396 AC4) ────────────────────────────────
//
// **The thing under test is CrabCast's behaviour, which this repository cannot
// mutate** — their source is out of bounds (invariant 10) and their daemon is
// not ours to break. So the red drive is a DISCRIMINATING SECOND ARM rather
// than a mutation, which is the treatment `task/KAN-375` used for exactly this
// shape: run the identical assertions against a case where the answer must be
// the OTHER one, and watch them go red.
//
//   node ...verify-crabcast-second-activation-resumes.mjs --red-drive-fresh-path
//
// points the SECOND activation at a path CrabCast has never run, holding
// everything else — the assertions included — identical. Under the resume rule
// that path cannot resume, so **§5's wire assertion and §6's disk assertion both
// go RED, and the arm exits 1.** That is the watchable failure.
//
// **The assertions are NOT inverted in that arm, and the first draft of this
// script did invert them.** An arm that flips its expectations passes in both
// worlds and proves only that the script can narrate whatever it is handed —
// which is the check-that-cannot-fail this repository keeps paying for, rebuilt
// inside the very proof meant to demonstrate against it. Holding the assertion
// fixed and moving the WORLD is the whole difference.
//
// What that red establishes: §5 and §6 track *resumption* rather than the mere
// fact that an activation happened. Both arms' transcripts are on the PR.
//
// **What it does NOT establish, said plainly:** it does not test Butchr code,
// because no Butchr code decides this. The green arm's pass and the red arm's
// fail are both facts about CrabCast's daemon, observed through frames we
// already send. If CrabCast changed its resume rule tomorrow this script would
// go red on the green arm — which is exactly what it is for.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST ──────────────
//
// **It writes activation 1's prompt, so it supplies the marker it later asserts
// on.** That is deliberate — a marker has to be unforgeable and letters-only to
// survive a rendered pane — but it is named here because a proof that supplies
// its own input has not tested that the input arrives (KAN-145's shape).
//
// What that leaves uncovered, and who covers it:
//   - **That a REAL activation takes this path.** This constructs the runtime and
//     calls `spawnSession` directly; it does not boot `daemon.ts`, because
//     `BUTCHR_AGENT_RUNTIME` is read once at construction and flipping the fleet
//     is out of scope. `verify-crabcast-claude-launcher-live.mjs` has the same
//     limit and states it. NOBODY covers it until the fleet is flipped.
//   - **That the RECONCILER re-activates this way after a restart.** This script
//     performs the second activation itself. `reconcile.ts` is what would do it
//     in production, and this script does not exercise it. NOT COVERED — and it
//     matters, because the reconciler is the actual cutover scenario. Recorded
//     on the ticket rather than implied to be tested.
//   - **Anything about how many workspaces pay the one cold start.** This
//     measures one path twice. It says nothing about the fleet-wide total, which
//     is AC3's arithmetic and is `epic/KAN-39`'s to rule on.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   cd daemon && npm run build            # it imports from ../dist
//   node daemon/scripts/verify-crabcast-second-activation-resumes.mjs [--verbose]
//                                                                    [--red-drive-fresh-path]
//
// EXIT 0 the assertions held, 1 an assertion failed, 2 the run did not happen
// (no capacity / no daemon) and is NOT a verdict about resume either way.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const { createAgentRuntime, crabCastSocketPath } = await import('../dist/runtime-switch.js');
const { CrabCastLink } = await import('../dist/crabcast-link.js');
const { workspaceDirFor, agentNameFor } = await import('../dist/herdr.js');
const { claudeTranscriptDir, hasRestorableConversation } = await import('../dist/resume.js');
const launchers = await import('../dist/launchers.js');

const verbose = process.argv.includes('--verbose');
/** The discriminating second arm — see "HOW IT WAS MADE TO GO RED". */
const redDriveFreshPath = process.argv.includes('--red-drive-fresh-path');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  }
  // Detail is printed ONLY on failure, deliberately, and this differs from the
  // helper it was copied from. `detail` here is the sentence explaining what a
  // FAILURE would mean, so echoing it under `verbose` beside a PASS prints
  // "PASS ... no transcript file carries the marker" — a line that reads as the
  // opposite of the verdict it is attached to. Measured on this script's first
  // live run, in a transcript that was going onto a PR.
}

/** Something measured and worth printing that nothing asserts on. */
function note(label, value) {
  console.log(`   ....  ${label}: ${value}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, budgetMs, stepMs = 500) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

/**
 * Terminal output is not text — herdr emits a cursor-position escape before
 * nearly every character, so a plain `includes` finds nothing while the bytes
 * are all present and in order. Markers here are letters-only for this reason.
 */
function paneLetters(raw) {
  return String(raw)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
}

/** The transcript files backing a workspace, with their sizes. */
function transcriptSnapshot(workDir) {
  const dir = claudeTranscriptDir(workDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { dir, files: new Map() };
  }
  const files = new Map();
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      files.set(name, { size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* raced with a write; treated as absent */
    }
  }
  return { dir, files };
}

/** Does any transcript file for this workspace carry `marker`? Which one? */
function transcriptsCarrying(workDir, marker) {
  const { dir, files } = transcriptSnapshot(workDir);
  const hits = [];
  for (const name of files.keys()) {
    try {
      if (fs.readFileSync(path.join(dir, name), 'utf8').includes(marker)) hits.push(name);
    } catch {
      /* unreadable; treated as not carrying */
    }
  }
  return hits;
}

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const socketPath = process.env.BUTCHR_CRABCAST_SOCKET ?? crabCastSocketPath();
if (!fs.existsSync(socketPath)) {
  console.error(
    `setup: no CrabCast socket at ${socketPath}. This proof needs a real CrabCast daemon;\n` +
      'see the header. Nothing was attempted.'
  );
  process.exit(2);
}
if (!fs.existsSync(path.join(repoRoot, 'daemon', 'dist', 'crabcast-runtime.js'))) {
  console.error('setup: daemon/dist is missing. Run `cd daemon && npm run build` first.');
  process.exit(2);
}

const RUN = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
// The marker activation 1's agent prints. Letters-only so it survives a rendered
// pane, and unguessable so a hit in activation 2's transcript can only have come
// from activation 1's conversation.
const ALPHA = `KANALPHA${RUN}`;

const TYPE = 'task';
// THROWAWAY, AND UNIQUE PER RUN. An activation under CrabCast starts an agent
// FRESH at a path CrabCast has no record for — that property killed
// `task/KAN-275` in seven minutes on 2026-08-12 — so this must never point at a
// workspace whose conversation matters. Unique per run additionally keeps the
// pre-state assertion in §2 meaningful: this whole observation is void if the
// path has run before, and a fixed key would make it void on the second run.
const KEY = `kan-396-ac2-${RUN.toLowerCase()}`;
const workDir = workspaceDirFor(TYPE, KEY);

// The red-drive arm's second activation goes here instead: a path CrabCast has
// never run, where the resume rule must decline.
const FRESH_KEY = `kan-396-ac2-fresh-${RUN.toLowerCase()}`;
const freshWorkDir = workspaceDirFor(TYPE, FRESH_KEY);
const secondWorkDir = redDriveFreshPath ? freshWorkDir : workDir;

console.log(`CrabCast socket : ${socketPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}   (throwaway — see the header)`);
console.log(`workspace       : ${workDir}`);
console.log(`run marker      : ${ALPHA}`);
console.log(
  `mode            : ${
    redDriveFreshPath
      ? `RED DRIVE — second activation at a FRESH path (${secondWorkDir}), which must NOT resume`
      : 'green path — second activation at the SAME path, which is the question'
  }`
);

// ── 1. the runtime and the peer ────────────────────────────────────────────
rule('1. the runtime — CrabCast is serving these activations, and the peer says which build');

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });

check('the runtime is CrabCastRuntime', runtime.constructor.name === 'CrabCastRuntime', report.mode);
check('and its report says so, from the decision rather than a re-read', report.mode === 'crabcast');

const connected = await until(() => runtime.describe().link.connected, 8_000);
check('the link connected to a real CrabCast daemon', connected === true, JSON.stringify(runtime.describe().link));
if (!connected) {
  console.error('\nno CrabCast daemon answered. Nothing was attempted; this is not a verdict.');
  process.exit(2);
}

const link = runtime.describe().link;
note('peer build', `${link.peerCommit?.slice(0, 12)} (adapter pinned to ${link.pinnedCommit.slice(0, 12)}, match=${link.peerMatchesPin})`);
note('read-path contract', `peer v${link.peerContractVersion}, pinned v${link.pinnedContractVersion}`);

// ── A SECOND, SEPARATE CONNECTION, AND THAT IS DELIBERATE ──────────────────
//
// `task/KAN-417` and `task/KAN-293` both established that a verdict must not be
// read off the actor's own account of itself, and re-read through a connection
// of their own. This is that connection: a `CrabCastLink` this script owns,
// distinct from the one `CrabCastRuntime` holds. It is also the only way to read
// `activate_response` at all — `provision()` consumes the response internally
// and stores `channelEnabled` and the remote id from it, dropping every resume
// field on the floor, which is the omission this whole ticket is about.
const probeLink = new CrabCastLink({
  socketPath,
  log: (m) => verbose && console.log(`      [probe-link] ${m}`)
});
probeLink.connect();
const probeConnected = await until(() => probeLink.describe?.().connected ?? probeLink.connected, 8_000);
check('the probe opened its own second connection to CrabCast', probeConnected === true);

// ── 2. the pre-state — this path is genuinely new, so §5/§6 mean something ──
rule('2. pre-state — CrabCast has NO record for this path, so a resume here would have to be granted');

const dirExistedBefore = fs.existsSync(workDir);
const freshDirExistedBefore = fs.existsSync(freshWorkDir);

check(
  'the probe workspace did not already exist',
  !dirExistedBefore,
  `${workDir} already exists — this run cannot establish a clean pre-state`
);
check(
  'and no restorable conversation is on disk for it yet',
  hasRestorableConversation(workDir) === false,
  `${claudeTranscriptDir(workDir)} already holds a non-empty transcript`
);
note('transcript dir (does not exist yet)', claudeTranscriptDir(workDir));

/**
 * Undo everything this run made, on EVERY exit path including the early ones.
 *
 * The record goes first and the order is load-bearing: the probe workspace is an
 * ordinary directory anybody could remove, but the configured record lands in
 * `~/.local/share/crabcast/agents.jsonl`, which is on the standing never-touch
 * list for every Butchr agent. `crabcast forget` is their published surface for
 * it and the only sanctioned removal. Copied from
 * `verify-crabcast-claude-launcher-live.mjs` (KAN-405).
 */
async function cleanup() {
  for (const dir of [workDir, freshWorkDir]) {
    if (dir === freshWorkDir && !redDriveFreshPath) continue;
    try {
      execFileSync('crabcast', ['deactivate', dir], { stdio: 'pipe', timeout: 20_000 });
    } catch {
      /* already down, or never up — either way nothing to stand down */
    }
    try {
      execFileSync('crabcast', ['forget', dir], { stdio: 'pipe', timeout: 20_000 });
      console.log(`   forgot CrabCast's record for ${dir}`);
    } catch (err) {
      console.log(
        `   could NOT forget CrabCast's record for ${dir} — remove it by hand:\n` +
          `         crabcast deactivate ${dir} && crabcast forget ${dir}\n` +
          `         (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`
      );
    }
  }
  for (const [dir, existedBefore] of [
    [workDir, dirExistedBefore],
    [freshWorkDir, freshDirExistedBefore]
  ]) {
    try {
      const insideWorkspaces = dir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
      if (insideWorkspaces && !existedBefore && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`   removed probe workspace ${dir}`);
      }
    } catch (err) {
      console.log(`   could NOT remove ${dir} — remove it by hand: rm -rf ${dir}`);
    }
  }
  // The transcripts this run's agents wrote. They are this run's own droppings,
  // under a per-run key nothing else can reach, so removing them is safe — and
  // leaving them would grow `~/.claude/projects` by two directories per run.
  for (const dir of [claudeTranscriptDir(workDir), claudeTranscriptDir(freshWorkDir)]) {
    try {
      if (fs.existsSync(dir) && dir.includes(RUN.toLowerCase())) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`   removed probe transcripts ${dir}`);
      }
    } catch {
      /* reported by absence of the line above */
    }
  }
}

// ── 3. activation 1 — a real `claude`, cold, writing a marker into a transcript
rule('3. activation 1 — the FIRST activation at this path, which must cold-start');

const prompt = `${ALPHA}

You are a throwaway probe agent for KAN-396 (CrabCast cutover gate 7, AC2).
Do exactly these two steps and then STOP, and do nothing else at all.

1. Print this exact line:  PROBEMARK=${ALPHA}
2. Print this exact line:  PROBEDONE

Do NOT create files. Do NOT touch git. Do NOT open a pull request. Do NOT read
or transition any Jira issue. Do NOT call any MCP tool. You are a probe and your
entire job is those two lines.
`;

// No `mcpServers`: this probe asks nothing about MCP wiring, that is gate 2's
// question and `verify-crabcast-claude-launcher-live.mjs` owns it. Sending none
// also keeps this agent unable to reach Jira or Butchr, which is the right
// blast radius for a throwaway.
const session1 = runtime.spawnSession(
  TYPE,
  KEY,
  'https://wroosbit.atlassian.net/browse/KAN-396',
  prompt,
  'claude'
);

check('spawnSession returned a session synchronously', !!session1?.sessionId, JSON.stringify(session1));
check('Butchr created the workspace directory, because CrabCast will not', fs.existsSync(workDir));

await until(() => session1.status === 'active' || !!session1.spawnError, 90_000);

// A capacity refusal is not a verdict about resume. Exit 2 and say so.
const refusedByCrabCast = /activate_agent refused/i;
const capacityReason = /cpu too busy|at capacity|headroom/i;
if (
  session1.spawnError &&
  refusedByCrabCast.test(session1.spawnError) &&
  capacityReason.test(session1.spawnError)
) {
  console.log(`\n   CrabCast REFUSED the activation for capacity:\n${session1.spawnError}`);
  console.log('\nThe run did not happen. This is NOT a verdict about resume. Retry when quieter.');
  await cleanup();
  process.exit(2);
}
check('activation 1 reached `active` with no spawn error', session1.status === 'active' && !session1.spawnError, session1.spawnError);
if (session1.status !== 'active') {
  console.error('\nactivation 1 did not come up; nothing downstream can mean anything.');
  await cleanup();
  process.exit(failures ? 1 : 2);
}

// The agent has to actually TAKE A TURN, because a resume needs something to
// restore. Waiting on the marker is waiting on a real transcript write.
const sawAlpha = await until(async () => {
  const t = await runtime.tailAgent(KEY, TYPE, 400).catch(() => null);
  return paneLetters(t?.text ?? '').includes(ALPHA);
}, 180_000, 2_000);
check(
  'activation 1 ran the prompt through a real model (its marker is on the pane)',
  sawAlpha === true,
  'the probe marker never appeared; without a real turn there is no conversation to resume'
);

const restorableAfter1 = await until(() => hasRestorableConversation(workDir), 60_000, 2_000);
check(
  'and it left a restorable conversation on disk',
  restorableAfter1 === true,
  `${claudeTranscriptDir(workDir)} holds no non-empty transcript, so a resume would have nothing to restore`
);

const snap1 = transcriptSnapshot(workDir);
const alphaFiles1 = transcriptsCarrying(workDir, ALPHA);
note('transcript files after activation 1', [...snap1.files.keys()].join(', ') || '(none)');
note('files carrying the marker', alphaFiles1.join(', ') || '(none)');
check(
  'the marker is IN the transcript, so §6 has something unforgeable to look for',
  alphaFiles1.length > 0,
  'no transcript file carries the marker; §6 could not distinguish a resume from a cold start'
);

// ── 4. stand it down — the state a daemon restart leaves behind ────────────
rule('4. stand it down — `standby`, which is the state a daemon restart or a reboot leaves');

// `deactivate` and not `forget`: the record must SURVIVE, because the record is
// the input the resume rule reads. `forget` would delete exactly the fact under
// test and the second activation would be a first one wearing its clothes.
try {
  execFileSync('crabcast', ['deactivate', workDir], { stdio: 'pipe', timeout: 30_000 });
  console.log(`   stood down ${workDir}`);
} catch (err) {
  check('stood the agent down', false, err instanceof Error ? err.message : String(err));
}
await sleep(3_000);
check(
  'the session is no longer live, so activation 2 is a real activation and not an attach',
  await until(async () => {
    const t = await runtime.tailAgent(KEY, TYPE, 40).catch(() => null);
    return !t || t.success !== true || !t.text;
  }, 20_000, 1_000) !== false,
  'the pane still answers; a second activate would take the idempotent branch and decide nothing'
);

if (redDriveFreshPath) {
  console.log(`\n   RED DRIVE: activation 2 goes to ${secondWorkDir}, which has never run.`);
  if (!fs.existsSync(secondWorkDir)) fs.mkdirSync(secondWorkDir, { recursive: true });
  // The fresh path needs its own record, exactly as activation 1's path got one.
  const configured = await probeLink.request({
    action: 'configure_agent',
    path: secondWorkDir,
    priority: 1,
    launcher: 'claude',
    prompt
  });
  check('the fresh path was configured', configured.success === true, JSON.stringify(configured).slice(0, 400));
}

// ── 5. activation 2 — the wire's own verdict ───────────────────────────────
rule('5. activation 2 — the same frame `provision()` sends, and the resume fields it drops');

const snapBefore2 = transcriptSnapshot(secondWorkDir);

// EXACTLY the frame `crabcast-runtime.ts` `provision()` sends at line 972:
// `{ action: 'activate_agent', path }`. No resume key, documented or otherwise.
const activated2 = await probeLink.request({ action: 'activate_agent', path: secondWorkDir });

if (
  activated2.success !== true &&
  capacityReason.test(JSON.stringify(activated2.error ?? ''))
) {
  console.log(`\n   CrabCast REFUSED activation 2 for capacity: ${JSON.stringify(activated2.error)}`);
  console.log('\nThe run did not happen. This is NOT a verdict about resume.');
  await cleanup();
  process.exit(2);
}

check('activation 2 succeeded', activated2.success === true, JSON.stringify(activated2).slice(0, 500));
note('activate_response.started', String(activated2.started));
note('activate_response.alreadyRunning', String(activated2.alreadyRunning));
note('activate_response.everActivated', String(activated2.everActivated));
note('activate_response.resumedExistingConversation', String(activated2.resumedExistingConversation));
note('activate_response.resume', String(activated2.resume));
note('activate_response.resumedConversation', String(activated2.resumedConversation));

check(
  'this was a spawning activation, so the resume decision is on the response at all',
  activated2.started === true && activated2.alreadyRunning !== true,
  'the idempotent branch carries no `resumedExistingConversation` by design ' +
    '(read-path-contract v8 §"what the idempotent branch could answer from"), so nothing here decides anything'
);

const wireSaysResumed = activated2.resumedExistingConversation === true;

// ASSERTED IDENTICALLY IN BOTH ARMS, AND THAT IS WHAT MAKES THE RED DRIVE A RED
// DRIVE. An arm that inverted its assertions would go green in both worlds and
// prove only that this script can describe whatever it is handed. Holding the
// assertion fixed and moving the WORLD is what makes the failure watchable.
check(
  'the wire reports the second activation RESUMED the existing conversation',
  wireSaysResumed === true,
  `resumedExistingConversation=${String(activated2.resumedExistingConversation)} — ` +
    (redDriveFreshPath
      ? 'EXPECTED IN THE RED-DRIVE ARM: this path has never run, so the resume rule declines it.'
      : "CrabCast started a NEW session, so KAN-396's premise stands and the cutover cost is the larger number")
);

// ── 6. the same question, asked of the disk ────────────────────────────────
rule('6. the disk — did the second session land in the FIRST session\'s conversation file?');

// ── WHY THIS DRIVES A TURN INSTEAD OF WATCHING FOR GROWTH ──────────────────
//
// The first version of this section slept 20s and asked whether any transcript
// file had grown. **It reported "did not resume" for a run the wire said had
// resumed, and the wire was right.** A resumed `claude` comes up holding its
// conversation and sitting at an empty prompt — CrabCast's own contract says so
// of `resumedConversation: true`, *"the agent is sitting at an empty prompt and
// needs a nudge"* — so it writes NOTHING until something asks it to. Zero growth
// was the correct behaviour of a healthy resume, and the instrument read it as a
// cold start.
//
// That failure is worth keeping in the header rather than quietly fixing,
// because it is this epic's own recurring shape pointed at me: **an instrument
// answering a question I had not asked, in the format of the answer I wanted.**
// "No bytes written" is not "no conversation restored".
//
// So the discriminator is now a SECOND marker driven through a real turn, and it
// is sharper than growth ever was: send the resumed session a message asking for
// BETA, then ask which conversation file BETA landed in.
//
//   BETA lands in the file that already carries ALPHA  -> the second activation
//                                                          continued the first
//                                                          conversation.
//   BETA lands in a NEW file that carries no ALPHA      -> it cold-started.
//
// Both markers are unguessable and letters-only, and the file is read off disk
// rather than out of the pane — so this is neither the wire's account of itself
// nor the agent's.
const BETA = `KANBETA${RUN}`;
note('second marker (must land in a conversation file)', BETA);

// ── WAIT FOR THE COMPOSER BEFORE TYPING AT IT ──────────────────────────────
//
// Measured on this script's second live run: sending the instant
// `activate_agent` returned answered `delivered: false`, `verdict:
// 'not-delivered'`, `interrupts: 1, submits: 0`, `inComposer: false`, with the
// pane tail showing Claude Code's startup screen. **The session was still
// booting.** A resumed session has a conversation to load before it has a
// composer, and `activate_response` returning is not that being finished.
//
// So readiness is polled rather than slept on, using the idle/in-flight
// distinction the guardian triage in `prompts/task.md` states: `esc to
// interrupt` present means a turn IS in flight; a bare prompt with no such
// line is idle and safe to type at.
const paneReady = await until(async () => {
  const t = await probeLink
    .request({ action: 'tail_agent', path: secondWorkDir, lines: 60 })
    .catch(() => null);
  const text = typeof t?.text === 'string' ? t.text : '';
  if (!text) return false;
  return text.includes('❯') && !/esc to interrupt/i.test(text);
}, 180_000, 3_000);
check(
  'the resumed session reached an idle composer, so a message can be typed at it',
  paneReady === true,
  'the pane never settled to an idle prompt; a send into a booting session is refused ' +
    '(`delivered: false`) and would make §6 vacuous rather than negative'
);

const nudge = `Print this exact line and then STOP, and do nothing else: PROBEBETA=${BETA}`;
// Retried, because `delivered` is a verdict about one attempt at one moment.
// Bounded and reported: a silent retry loop would hide a session that never
// accepts anything, which is a real failure and not a slow one.
let sent = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  sent = await probeLink.request({ action: 'send_to_agent', path: secondWorkDir, message: nudge });
  if (sent.success === true && sent.delivered === true) break;
  note(`send attempt ${attempt} not delivered`, String(sent.verdict ?? sent.error ?? 'no verdict'));
  await sleep(15_000);
}
check(
  'the second session accepted a message, so it can be made to write',
  sent?.success === true && sent?.delivered === true,
  JSON.stringify(sent).slice(0, 400)
);

const betaLanded = await until(
  () => transcriptsCarrying(secondWorkDir, BETA).length > 0,
  240_000,
  3_000
);
check(
  'the second session took a real turn and wrote it to a conversation file',
  betaLanded === true,
  `${BETA} never reached any transcript under ${claudeTranscriptDir(secondWorkDir)}; ` +
    'without a turn there is nothing for this section to read, and its verdict would be vacuous'
);

const snapAfter2 = transcriptSnapshot(secondWorkDir);
const newFiles = [...snapAfter2.files.keys()].filter((n) => !snapBefore2.files.has(n));
const alphaFiles2 = transcriptsCarrying(secondWorkDir, ALPHA);
const betaFiles2 = transcriptsCarrying(secondWorkDir, BETA);
// The file the SECOND session is writing into, identified by the marker only it
// could have produced.
const carriesBoth = betaFiles2.filter((n) => alphaFiles2.includes(n));

note('transcript dir', snapAfter2.dir);
note('files before activation 2', [...snapBefore2.files.keys()].join(', ') || '(none)');
note('files after activation 2', [...snapAfter2.files.keys()].join(', ') || '(none)');
note('NEW files since activation 2', newFiles.join(', ') || '(none)');
note(`files carrying ALPHA (${ALPHA}, activation 1)`, alphaFiles2.join(', ') || '(none)');
note(`files carrying BETA  (${BETA}, activation 2)`, betaFiles2.join(', ') || '(none)');
note('files carrying BOTH markers (NOT the signal — see below)', carriesBoth.join(', ') || '(none)');

// ── ⚠ WHY `carriesBoth` IS NOT THE SIGNAL, FOUND BY THE RED DRIVE ──────────
//
// The first version of this section read `carriesBoth.length > 0` as the
// continuation signal, and **the red-drive arm passed it** — a path that had
// demonstrably never run produced a brand-new transcript carrying BOTH markers.
//
// The reason is that **ALPHA travels in the configured prompt.** CrabCast freezes
// the prompt onto the agent's record and hands it to the launcher, so any agent
// at any path configured from this script's `prompt` writes ALPHA into its
// transcript on its first turn — continuation or not. The marker proved the
// prompt arrived, which was never the question.
//
// That is this ticket's own defect wearing my clothes: **an assertion that could
// only ever return the answer I was hoping for.** It would have passed on the
// green arm and been reported as evidence of a resume. The red drive is the only
// thing that caught it, which is the entire argument for running one.
//
// The uncontaminated signal is FILE IDENTITY: did the second session's turn land
// in a conversation file that ALREADY EXISTED before activation 2 — the very file
// activation 1 wrote? A cold start cannot; it opens its own. `newFiles` and the
// pre-activation snapshot are what carry that, and neither can be forged by a
// prompt's contents.
const betaInPreExisting = betaFiles2.filter((n) => snapBefore2.files.has(n));
const betaInActivation1File = betaFiles2.filter((n) => alphaFiles1.includes(n));
note('files that existed BEFORE activation 2', [...snapBefore2.files.keys()].join(', ') || '(none)');
note('BETA landed in a PRE-EXISTING file', betaInPreExisting.join(', ') || '(none)');
note("BETA landed in ACTIVATION 1's OWN file", betaInActivation1File.join(', ') || '(none)');
note(
  'ALPHA present? (evidence only, NOT a signal)',
  `${alphaFiles2.join(', ') || '(none)'} — ALPHA rides in the configured prompt, so its presence ` +
    'distinguishes nothing. See the block above.'
);

const diskSaysResumed = betaInPreExisting.length > 0 && newFiles.length === 0;

// Again identical in both arms — see the note in §5.
check(
  "the second session's turn landed in the conversation file ACTIVATION 1 wrote",
  betaInActivation1File.length > 0,
  `BETA in [${betaFiles2.join(', ')}], activation 1's file was [${alphaFiles1.join(', ')}], ` +
    `new files [${newFiles.join(', ')}] — ` +
    (redDriveFreshPath
      ? 'EXPECTED IN THE RED-DRIVE ARM: a path that never ran has no conversation to continue, ' +
        'so the turn opens a file of its own.'
      : 'a separate file for the second turn is what a cold start leaves')
);
check(
  'and it did so without opening a new conversation file',
  newFiles.length === 0,
  `new transcripts appeared: ${newFiles.join(', ')}` +
    (redDriveFreshPath ? ' — EXPECTED IN THE RED-DRIVE ARM.' : '')
);

// ── 7. the two instruments must agree ──────────────────────────────────────
rule('7. the verdict — and the two instruments agreeing is part of it');

check(
  'the wire and the disk tell the same story',
  wireSaysResumed === diskSaysResumed,
  `wire says resumed=${wireSaysResumed}, disk says resumed=${diskSaysResumed}. ` +
    'That disagreement is itself the finding: one of these instruments is not measuring what it claims, ' +
    'and no cutover cost should be written from either until it is resolved.'
);

console.log(
  `\n   VERDICT (${redDriveFreshPath ? 'red-drive arm' : 'green path'}): ` +
    `a second activation at a path CrabCast HAS run before ${
      redDriveFreshPath ? 'was not exercised in this arm' : wireSaysResumed && diskSaysResumed ? 'RESUMES' : 'does NOT resume'
    }.`
);

rule('cleanup');
await cleanup();

console.log(`\n${failures ? `RED — ${failures} assertion(s) failed` : 'GREEN — every assertion held'}`);
process.exit(failures ? 1 : 0);
