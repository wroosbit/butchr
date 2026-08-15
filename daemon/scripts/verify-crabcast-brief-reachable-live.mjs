// KAN-400, the live half: a REAL cold-started `claude` agent, started through
// the CrabCast-backed runtime, asked to follow the daemon's own "go and read
// your brief" wording — the fixed one and the one it replaced — and reporting
// which of them reaches an actual file.
//
// WHAT FAILURE THIS WOULD CATCH: the daemon telling an agent to read a brief it
// cannot reach. Two arms, run against the same agent in the same turn:
//
//   OLD wording — "Read .butchr-prompt.md in this directory" — must find
//   NOTHING under CrabCast, because CrabCast writes no brief into the caller's
//   directory. If this arm ever reports a file, the premise of the whole ticket
//   has changed and the fix needs revisiting rather than trusting.
//
//   NEW wording — rendered live from `degradedResumePrompt` with
//   `CrabCastRuntime.briefLocation()` — must lead the agent to its real brief,
//   proved by a marker planted at the END of that brief which the agent can
//   only have got by reading the file, and by the agent reporting that the file
//   sits OUTSIDE its own working directory.
//
// It would equally catch the fix being cosmetic: wording that names no file and
// leads nowhere either would fail the NEW arm exactly as the old one does.
//
// CI-RUNNABLE: no — it needs a live CrabCast daemon on a Unix socket, room in
// that daemon's capacity gate for one more agent, and it starts a real `claude`
// process that spends real tokens. `verify-brief-location.mjs` is the offline
// half of the same claim and does run in CI.
//
// ── WHAT THIS SUPPLIES, AND THE ONE THING IT DOES NOT ──────────────────────
//
// `prompts/task.md`: *a proof that supplies its own input has not tested that
// the input arrives.* So, precisely:
//
//   SUPPLIED BY THIS SCRIPT — the brief's CONTENT (a probe brief, not a
//   rendered `prompts/task.md`: handing a throwaway agent a real brief would
//   have it claim a Jira ticket), and the two instruction sentences, which are
//   rendered by calling the real `degradedResumePrompt` rather than retyped.
//
//   NOT SUPPLIED, AND THIS IS THE POINT — the POINTER. Nothing here tells the
//   agent where its brief is. CrabCast types that line at the pane itself, from
//   a path this process never learns and never sends. The NEW arm passes only
//   if that pointer exists, is followable, and leads to the bytes we handed
//   over. That is the leg a constructed test cannot fake, and it is the one
//   KAN-400 turns on.
//
// ── ONE INSTRUMENT LIMIT, FOUND BY BEING BITTEN BY IT ──────────────────────
//
// The agent is read by tailing its pane, and **a pane is a screen, not a
// scrollback.** The first run of this probe asked for its four answers as it
// went, and by the time step 4 was done the step-1 answer had scrolled off: the
// marker was absent from a run in which the agent had in fact answered
// correctly. **An absent marker is not a negative answer**, and a check that
// reads it as one is a false red — the same shape `prompts/task.md` names as an
// instrument answering a question you did not ask. So the brief asks for all
// three answers together at the end, the poll waits for all three, and the tail
// prints how many lines it got and CrabCast's own `truncated` flag beside them.
// §5 answers the same question from the filesystem, independently of the agent.
//
// It does NOT boot `daemon.ts`, for the reason
// `verify-crabcast-claude-launcher-live.mjs` gives at length:
// `BUTCHR_AGENT_RUNTIME` is read once, process-wide, at daemon construction, so
// pointing one activation at CrabCast without flipping the fleet means
// constructing the runtime here. Flipping is out of scope (KAN-400).
//
// So this covers what an agent DOES with the wording, and covers nothing about
// the herdr arm or about the MCP server's instructions string.
// `daemon/scripts/verify-brief-location.mjs` covers those, offline, and names
// this script as its own missing half. The hole either would leave alone is
// stated in both headers rather than left to be inferred.
//
// ── HOW IT WAS MADE TO GO RED ──────────────────────────────────────────────
//
// Recorded on the PR with transcripts. The mutation is in
// `daemon/src/crabcast-runtime.ts`: have `briefLocation` answer
// `{ kind: 'workspace-file', … }` — the herdr answer — which COMPILES, so the
// proof runs against the mutation rather than against a stale `dist`.
//
//   cd daemon && npm run build
//   node daemon/scripts/verify-crabcast-brief-reachable-live.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const verbose = process.argv.includes('--verbose');
let failures = 0;

const rule = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 10).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const note = (label, value) => console.log(`   ....  ${label}: ${value}`);
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
 * A rendered pane is not text — herdr emits a cursor-position escape before
 * nearly every character, so a plain `includes` finds nothing while the bytes
 * are all present and in order. Strip CSI/OSC, then keep only letters. Every
 * marker below is letters-only for exactly this reason.
 */
function paneLetters(raw) {
  return String(raw)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
}

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
if (!fs.existsSync(path.join(repoRoot, 'daemon', 'dist', 'crabcast-runtime.js'))) {
  console.error('setup: daemon/dist is missing. Run `cd daemon && npm run build` first.');
  process.exit(1);
}

const { createAgentRuntime, crabCastSocketPath } = await import('../dist/runtime-switch.js');
const { workspaceDirFor } = await import('../dist/herdr.js');
const { degradedResumePrompt } = await import('../dist/resume.js');

const socketPath = process.env.BUTCHR_CRABCAST_SOCKET ?? crabCastSocketPath();
if (!fs.existsSync(socketPath)) {
  console.error(
    `setup: no CrabCast socket at ${socketPath}. This proof needs a real CrabCast daemon.\n` +
      'Nothing was attempted.'
  );
  process.exit(1);
}

// Letters-only, unique per run. No marker is a substring of another, so a
// report of one cannot be read as a report of its opposite.
const RUN = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
const DEEP = `DEEPMARK${RUN}`;          // planted at the END of the brief
const WS_PRESENT = `OLDARMFOUND${RUN}`; // the old wording found a file
const WS_ABSENT = `OLDARMEMPTY${RUN}`;  // the old wording found nothing
const MARK_SEEN = `NEWARMREAD${RUN}`;   // the new wording reached the real brief
const MARK_MISS = `NEWARMLOST${RUN}`;   // it did not
const OUTSIDE = `BRIEFOUTSIDE${RUN}`;   // and the brief is not in the workspace
const INSIDE = `BRIEFINSIDE${RUN}`;

const TYPE = 'task';
// THROWAWAY, AND UNIQUE PER RUN. An activation under CrabCast starts an agent
// FRESH — there is no `--continue` on that path — so a key whose conversation
// matters would be destroyed (the property that killed `task/KAN-275` in seven
// minutes on 2026-08-12). Unique per run because CrabCast refuses to change
// `prompt` on a path it already holds a record for, so a fixed key would be
// configured with the PREVIOUS run's brief and its PREVIOUS run's markers.
const KEY = process.env.KAN400_PROBE_KEY ?? `kan-400-brief-${RUN.toLowerCase()}`;
const workDir = workspaceDirFor(TYPE, KEY);

console.log(`CrabCast socket : ${socketPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}   (throwaway — see the header)`);
console.log(`workspace       : ${workDir}`);
console.log(`run markers     : ${DEEP} / ${MARK_SEEN} / ${OUTSIDE}`);

// ── 1. the runtime ─────────────────────────────────────────────────────────
rule('1. the runtime — CrabCast is serving this spawn');

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });

check('the runtime is CrabCastRuntime', runtime.constructor.name === 'CrabCastRuntime');
check('and its own report says so', report.mode === 'crabcast', JSON.stringify(report));

const connected = await until(() => runtime.describe().link.connected, 8_000);
check('the link connected to a real CrabCast daemon', connected === true, JSON.stringify(runtime.describe().link));
note('peer commit', JSON.stringify(runtime.describe().link.peerCommit));

if (!connected) {
  console.log('\nFAILED early — no peer, so nothing below would mean anything.');
  runtime.dispose();
  process.exit(1);
}

// ── 2. the wording under test, rendered by the real builder ────────────────
rule('2. the two instructions — the new one rendered live, the old one quoted');

// THE FIX ITSELF, taken from the code rather than retyped: the runtime is asked
// where it puts a brief, and the daemon's real cold-start builder renders the
// sentence. If either changes, this probe changes with it.
const where = runtime.briefLocation(TYPE, KEY);
const NEW_INSTRUCTION = degradedResumePrompt(TYPE, KEY, where)
  .split('\n')
  .find((l) => l.startsWith('1. '));

check('the runtime answered `runtime-owned`, as a runtime that writes no workspace brief must',
  where.kind === 'runtime-owned', JSON.stringify(where));
check('the rendered instruction exists and names no .butchr-prompt.md',
  !!NEW_INSTRUCTION && !NEW_INSTRUCTION.includes('.butchr-prompt.md'), NEW_INSTRUCTION);

console.log(`\n   NEW (rendered): ${NEW_INSTRUCTION}`);
console.log(`   OLD (replaced): 1. Read .butchr-prompt.md in this directory for your instructions.\n`);

// ── 3. the brief handed over, with a marker at its end ─────────────────────
rule('3. the probe brief — the agent is asked to run both arms and report');

const brief = `# Probe brief for ${TYPE}/${KEY}

You are a probe agent. Do NOT claim any Jira ticket, do not touch git, and do
not start any long task. Do exactly the four steps below, print the results,
and then stop and wait.

STEP 1 — the OLD instruction the Butchr daemon used to give agents was:

    "Read .butchr-prompt.md in this directory for your instructions."

Follow it literally. If a file named .butchr-prompt.md exists in your current
working directory, print ${WS_PRESENT}. If it does not exist, print ${WS_ABSENT}.

STEP 2 — the NEW instruction the Butchr daemon now gives agents is:

    "${NEW_INSTRUCTION}"

Follow it literally: work out which file that names, and read it.

STEP 3 — the file you just read: if its text contains the token ${DEEP},
print ${MARK_SEEN}. If you could not find or read the file, or the token is not
in it, print ${MARK_MISS}.

STEP 4 — compare the absolute path of that file with your current working
directory. If the file is OUTSIDE your working directory, print ${OUTSIDE}.
If it is inside it, print ${INSIDE}. Then print the absolute path on its own
line.

STEP 5 — IMPORTANT, and it is what makes this readable at all. Finish by
printing your three answers again, together, on three consecutive lines and
nothing else between them:

    <your STEP 1 answer>
    <your STEP 3 answer>
    <your STEP 4 outside/inside answer>

Then stop and wait. (Step 5 exists because this run is read by tailing your
pane, and a pane is a SCREEN rather than a scrollback: an answer printed at
step 1 has scrolled off by the time step 4 is done. The first run of this probe
lost its step-1 answer exactly that way.)

(The token below is the end of this brief. It is here so that reading it proves
the whole file was reached, not merely its opening lines.)

${DEEP}
`;

note('brief bytes', String(Buffer.byteLength(brief)));
check('the brief carries the deep marker at its end', brief.trimEnd().endsWith(DEEP));

// ── 4. the spawn ───────────────────────────────────────────────────────────
rule('4. spawnSession — a real, cold-started `claude` agent through CrabCast');

const dirExistedBefore = fs.existsSync(workDir);

// No MCP servers on purpose. This probe needs no tools beyond reading a file,
// and sending none keeps the workspace holding only what CrabCast itself puts
// there — which is what §5's observation is about.
const session = runtime.spawnSession(TYPE, KEY, undefined, brief, 1, 'claude');

check('spawnSession returned a session synchronously', !!session?.sessionId);
await until(() => session.status === 'active' || !!session.spawnError, 90_000);
check('the session went active', session.status === 'active',
  session.spawnError ?? `still ${session.status} after 90s`);

if (session.status !== 'active') {
  console.log('\nFAILED early — no agent started.');
  runtime.dispose();
  process.exit(1);
}

// ── 5. the workspace, as CrabCast leaves it ────────────────────────────────
rule('5. the workspace — what CrabCast did and did not write into it');

// `task/KAN-379`'s finding, re-measured at this head rather than inherited.
const wsBrief = path.join(workDir, '.butchr-prompt.md');
const wsBriefExists = fs.existsSync(wsBrief);
note('workspace contents', JSON.stringify(fs.existsSync(workDir) ? fs.readdirSync(workDir) : null));
check(
  'CrabCast wrote no .butchr-prompt.md into the workspace — the premise of this ticket, re-measured',
  wsBriefExists === false,
  `a ${wsBrief} appeared. This path was measured not to write one (KAN-379). If CrabCast has ` +
    `changed, the fix in this PR needs re-deciding rather than trusting.`
);

// ── 6. what the agent found ────────────────────────────────────────────────
rule('6. the agent — did the new wording reach a real brief?');

const sawAnswer = await until(
  async () => {
    const t = await runtime.tailAgent(KEY, TYPE, 200);
    if (t.success !== true) return null;
    const L = paneLetters(t.text ?? '');
    // All three, because step 5 prints them together and this must not read a
    // pane taken before it. Two-of-three was the first version and it returned
    // mid-answer, with the step-1 marker already scrolled off the screen.
    return (L.includes(MARK_SEEN) || L.includes(MARK_MISS)) &&
      (L.includes(OUTSIDE) || L.includes(INSIDE)) &&
      (L.includes(WS_PRESENT) || L.includes(WS_ABSENT))
      ? t
      : null;
  },
  300_000,
  5_000
);
const finalTail = sawAnswer ?? (await runtime.tailAgent(KEY, TYPE, 200));
const paneText = String(finalTail?.text ?? '');
const L = paneLetters(paneText);

// WHAT THE INSTRUMENT ACTUALLY RETURNED, printed because the first run of this
// probe was misread for want of it: 200 lines were asked for and a pane is a
// SCREEN, so the step-1 answer had scrolled off and its marker was absent from
// a run in which the agent had answered correctly. An absent marker is not a
// negative answer, which is why the brief now asks for all three together.
note('tail lines returned', String(paneText.split('\n').length));
note('tail truncated (CrabCast\'s own flag)', JSON.stringify(finalTail?.truncated));

check(
  'the agent answered at all — it read its brief and did what it said',
  L.includes(MARK_SEEN) || L.includes(MARK_MISS),
  'neither answer marker appeared within 300s. The agent never got far enough for any ' +
    'arm below to mean anything; read §7 for what the pane actually shows.'
);

check(
  'OLD ARM: `.butchr-prompt.md in this directory` finds nothing, which is the defect',
  L.includes(WS_ABSENT) && !L.includes(WS_PRESENT),
  `absent=${L.includes(WS_ABSENT)} present=${L.includes(WS_PRESENT)}. If BOTH are false the ` +
    `agent's answer is not on the screen — a pane is not a scrollback — and this arm measured ` +
    `NOTHING; read the note above for what the tail returned, and §5, which answers the same ` +
    `question from the filesystem and does not depend on the agent at all. If \`present\` is ` +
    `true, CrabCast's behaviour has changed since KAN-379 measured it.`
);

check(
  'NEW ARM: the rendered wording led the agent to its actual brief',
  L.includes(MARK_SEEN) && !L.includes(MARK_MISS),
  `seen=${L.includes(MARK_SEEN)} lost=${L.includes(MARK_MISS)}. The agent could not follow the ` +
    `instruction to a file containing ${DEEP} — the marker at the END of the brief, so this is ` +
    `also the check that the whole brief arrived.`
);

check(
  'and the brief it read is outside the workspace, which is why naming a workspace file failed',
  L.includes(OUTSIDE) && !L.includes(INSIDE),
  `outside=${L.includes(OUTSIDE)} inside=${L.includes(INSIDE)}`
);

// ── 7. the pane ────────────────────────────────────────────────────────────
rule('7. the pane, as CrabCast read it');
console.log(
  paneText
    .split('\n')
    .filter((l) => l.trim().length)
    .slice(-24)
    .map((l) => `   | ${l}`)
    .join('\n')
);

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
runtime.terminateSession(session.sessionId);
await sleep(3_000);
runtime.dispose();

const insideWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
if (insideWorkspaces && !dirExistedBefore && fs.existsSync(workDir)) {
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`   removed probe workspace ${workDir}`);
} else {
  console.log(`   left ${workDir} alone (pre-existing, or outside the workspaces tree)`);
}
try {
  const { execFileSync } = await import('child_process');
  execFileSync('crabcast', ['forget', workDir], { stdio: 'pipe', timeout: 20_000 });
  console.log(`   forgot CrabCast's record for ${workDir}`);
} catch (err) {
  console.log(
    `   could NOT forget CrabCast's record for ${workDir} — remove it by hand:\n` +
      `         crabcast deactivate ${workDir} && crabcast forget ${workDir}\n` +
      `         (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`
  );
}

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (failures) {
  console.log(`   ${failures} check(s) FAILED.`);
} else {
  console.log(
    '   OK — a cold-started agent under CrabCast could NOT find .butchr-prompt.md in its\n' +
      '   directory, and COULD follow the daemon\'s new wording to its real brief, outside the\n' +
      '   workspace, whole. The pointer it followed came from CrabCast, not from this script.'
  );
}
console.log('');
process.exit(failures ? 1 : 0);
