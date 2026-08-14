// Live proof for KAN-397, against a REAL CrabCast daemon, a REAL herdr and a
// REAL pane: `confirmAgentPresent` finds an agent CrabCast started, under the
// name every caller addresses it by.
//
// WHAT FAILURE THIS WOULD CATCH: `CrabCastRuntime.confirmAgentPresent` joining
// CrabCast's census on the raw `paneName` — the one name a CrabCast-started
// agent does not have. That agent carries THEIR pane name
// (`crabcast-<key>-<hash>`), not `butchr-<type>-<key>`, so the lookup cannot
// succeed for exactly the population this runtime creates. `router.ts`'s
// `confirmActivation` answers `absent` by calling `abandonSession` and reporting
// the activation `success: false`, so the defect this catches is a WORKING agent
// being torn down by the thing that checks whether it started — a live pane left
// running that no Butchr session addresses.
//
// CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`
// (or the default socket path) and it spawns a real `claude` agent. It attempts
// nothing without one. Its output goes on the pull request.
//
// ── READ THE SECTION, NOT THE EXIT CODE, IF THE BUILD FAILED ───────────────
//
// **This script is one of the mixed kind, and says so where it can be acted
// on.** §1–§4 go through `daemon/dist`, so after a failed build they test the
// PREVIOUS build and their verdict is about code you did not write. §5 reads
// `daemon/src/router.ts` AS TEXT and is unaffected by the build — it tested what
// you wrote whatever tsc did. The overall exit code is a blend of the two, so a
// red after a failed build must be read per section rather than off the exit.
// Setup guards below refuse outright when `dist` is missing, but a STALE `dist`
// is not missing and nothing here can see it: confirm `npm run build` exited 0,
// unpiped, before trusting §1–§4 at all.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST ─────────────────────
//
// **This script spawns the agent it then asserts on.** So it does not test that
// an activation arriving from the extension produces such an agent, and it
// cannot: it constructs the runtime through `createAgentRuntime` and never boots
// `daemon.ts`, so nothing here exercises the router's own activation path
// end-to-end. §5 covers the half that matters for THIS defect by reading
// `router.ts` as text and asserting the `absent → abandonSession →
// success: false` wiring is still what the router does — which is what makes the
// consequence a fact about this repository rather than an inference. **Nothing
// covers a real extension-driven activation under a flipped daemon**, and that
// is deliberately not this script's job: it is cutover step 9's canary
// (`docs/crabcast-cutover-sequence.md`), and the whole reason KAN-397 blocks
// step 8 is that the canary would never reach its checklist while this defect
// stands.
//
// §6 of `verify-crabcast-claude-launcher-live.mjs` (KAN-379, cutover gate 2) is
// the sibling assertion — the same gate reached from the launcher side. **It was
// not in this repository when this was written**: it is untracked in KAN-379's
// worktree and on no branch, which is why this script exists rather than that
// one simply being re-run.
//
// ── WHY §2 IS A GATE AND NOT A NOTE ────────────────────────────────────────
//
// Ask what would have to be true for §4 to pass while the join is broken: the
// spawned agent's `paneName` would have to already EQUAL its Butchr name. Then
// the raw-`paneName` join finds it, §4 is green, and the proof has demonstrated
// nothing. That is not hypothetical — it is exactly the case for a pane herdr
// started, where `paneName` IS `butchr-<type>-<key>`, and it is why KAN-346's
// flip lost nothing for those. So §2 asserts, off the wire, that the two names
// DISAGREE for this agent. **If §2 is red, §4's green means nothing** and the
// run should be discarded rather than reported.
//
// ── HOW IT WAS MADE TO GO RED ──────────────────────────────────────────────
//
//   Revert the join in `daemon/src/crabcast-runtime.ts`:
//
//     -  const match = all.find((r) => butchrNameForCensusRow(r) === agentName);
//     +  const match = all.find((r) => r.paneName === agentName);
//
//   then `cd daemon && npm run build` (check it exited 0, unpiped) and re-run.
//   The transcript of that run is on the pull request. §4 goes red on both
//   `requireRuntime` arms — which is what identifies it as the LOOKUP rather
//   than `expectsRuntime` rejecting the agent, since the flag is never reached —
//   while §1–§3 and §5 stay green: the agent is running, CrabCast's census
//   reports it, and the router wiring that would tear it down is untouched.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   BUTCHR_CRABCAST_SOCKET=<path to a live crabcast.sock> \
//     node daemon/scripts/verify-crabcast-confirm-present-name-join.mjs [--verbose]
//
// A CrabCast daemon must already be listening there. Any of `crabcast
// configure|activate|deactivate|forget|send` spawns one; `list` does not.
//
// **Exit 0 green, 1 red, and 2 DID NOT RUN.** CrabCast gates activation on
// measured CPU and refuses outright when the machine is busy — on a loaded fleet
// that is the ordinary answer and it is not a verdict about anything here, so it
// is given its own code rather than being allowed to read as failure. Retry when
// the machine is quieter; the run cleans up after itself either way.

import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAgentRuntime, crabCastSocketPath } from '../dist/runtime-switch.js';
import { workspaceDirFor, agentNameFor } from '../dist/herdr.js';

const verbose = process.argv.includes('--verbose');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 12).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
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
 * Read `list_agents` STRAIGHT OFF THE SOCKET, not through the adapter.
 *
 * §2 asks what CrabCast called the pane, and the adapter is the thing under
 * test — `listHerdrAgents()` returns the DERIVED name, which is the answer the
 * fix produces rather than the input it was produced from. Taking the raw frame
 * is the only way this proof can see the disagreement it depends on.
 */
function rawListAgents(socketPath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `kan397-${process.pid}-${Date.now()}`;
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout reading list_agents from ${socketPath}`));
    }, timeoutMs);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id !== id) continue;
        clearTimeout(timer);
        socket.destroy();
        resolve(frame);
        return;
      }
    });
    socket.once('connect', () => socket.write(JSON.stringify({ action: 'list_agents', id }) + '\n'));
  });
}

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
const socketPath = process.env.BUTCHR_CRABCAST_SOCKET ?? crabCastSocketPath();
if (!fs.existsSync(socketPath)) {
  console.error(
    `setup: no CrabCast socket at ${socketPath}. This proof needs a real CrabCast daemon;\n` +
      'see the header. Nothing was attempted.'
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(repoRoot, 'daemon', 'dist', 'crabcast-runtime.js'))) {
  console.error('setup: daemon/dist is missing. Run `cd daemon && npm run build` first.');
  process.exit(1);
}

const RUN = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6).padEnd(6, 'x');
const TYPE = 'task';
// A THROWAWAY KEY, and the hazard is why. An activation under CrabCast starts an
// agent FRESH — there is no `--continue` on that path — so pointing this at a
// workspace whose conversation matters destroys it. That property killed
// `task/KAN-275` in seven minutes on 2026-08-12. Unique per run additionally,
// because CrabCast refuses to change `launcher`/`prompt`/`mcp` on a path it
// already holds a record for, so a fixed key would silently re-use the previous
// run's configuration.
const KEY = process.env.KAN397_PROBE_KEY ?? `kan-397-namejoin-${RUN}`;
const workDir = workspaceDirFor(TYPE, KEY);
const butchrName = agentNameFor(TYPE, KEY);

console.log(`CrabCast socket : ${socketPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}   (throwaway — see the header)`);
console.log(`butchr name     : ${butchrName}`);
console.log(`workspace       : ${workDir}`);

// ── 1. the runtime and the spawn ───────────────────────────────────────────
rule('1. a real `claude` agent, started by CrabCast through this adapter');

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });

check('the runtime is CrabCastRuntime', runtime.constructor.name === 'CrabCastRuntime');
check('and its own report says so', report.mode === 'crabcast', JSON.stringify(report));

const connected = await until(() => runtime.describe().link.connected, 8_000);
check('the link connected to a real CrabCast daemon', connected === true, JSON.stringify(runtime.describe().link));
note('peer', JSON.stringify(runtime.describe().link));

const dirExistedBefore = fs.existsSync(workDir);

/**
 * Undo everything this run made, on EVERY exit path including the early one.
 *
 * The early path is the one that matters and it was missed first time round: a
 * run whose activation is REFUSED has still had `configure_agent` accepted, so
 * it leaves a CrabCast record behind, and a unique-key-per-run script that exits
 * before cleanup grows `daemon_status.configuredAgents` by one on every attempt.
 * Under CPU pressure the refused runs are the common ones.
 */
async function cleanup() {
  const insideWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
  if (insideWorkspaces && !dirExistedBefore && fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`   removed probe workspace ${workDir}`);
  } else {
    console.log(`   left ${workDir} alone (pre-existing, or outside the workspaces tree)`);
  }
  // AND REMOVE THE RECORD ON CRABCAST'S SIDE — a unique key per run would
  // otherwise leave one behind on every run; measured on the sibling script,
  // `configuredAgents` went 4 → 8 over four runs before this was added.
  // `resetWorkspace` refuses under this runtime and `AgentRuntime` has no forget
  // verb, so this is the CLI rather than the adapter. It removes ONLY the path
  // this run created.
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
}

// A deliberately inert brief. This proof is about a name lookup, not about what
// the agent does, and an agent given real work would cost the machine capacity
// this run has no use for.
const prompt =
  'You are a probe for KAN-397 and there is no task here. Print the single word ' +
  'KANPROBEOK and then stop. Do not read any files, do not use any tools, and do ' +
  'not ask any questions.';

const session = runtime.spawnSession(TYPE, KEY, 'https://wroosbit.atlassian.net/browse/KAN-397', prompt, 'claude');

check('spawnSession returned a session synchronously', !!session?.sessionId, JSON.stringify(session));
check('Butchr created the workspace directory, because CrabCast will not', fs.existsSync(workDir));

await until(() => session.status === 'active' || !!session.spawnError, 90_000);

// A CAPACITY REFUSAL IS NOT A VERDICT ABOUT THE JOIN, and exiting 1 on one
// would report this proof as failing when it never ran. CrabCast gates
// activation on measured CPU and refuses in so many words; on a busy fleet that
// is the ordinary answer, not a finding. Exit 2 and say so, so a wrapper can
// retry and a reader cannot mistake it for red.
const refusedForCapacity = !!session.spawnError && /cpu too busy|memory|at capacity|headroom/i.test(session.spawnError);
if (session.status !== 'active' && refusedForCapacity) {
  console.log('\n   SKIPPED — CrabCast refused the activation for capacity, so no agent ran.');
  console.log('   This is NOT a verdict on the name join. Retry when the machine is quieter.\n');
  console.log(`   ${session.spawnError.split('\n').slice(0, 3).join('\n   ')}`);
  runtime.dispose();
  await cleanup();
  process.exit(2);
}

check('the session went active', session.status === 'active', session.spawnError ?? `still ${session.status} after 90s`);
if (session.status !== 'active') {
  console.log('\nFAILED early — no agent started, so nothing below would mean anything.');
  runtime.dispose();
  await cleanup();
  process.exit(1);
}

check(
  "the agent is in CrabCast's census under its Butchr name, with a claude runtime behind it",
  !!(await until(
    () => runtime.listHerdrAgents().find((a) => a.workDir === workDir && a.agentRuntime === 'claude'),
    30_000
  )),
  JSON.stringify(runtime.listHerdrAgents().find((a) => a.workDir === workDir))
);

// ── 2. the premise §4 depends on, read off the wire ────────────────────────
rule('2. the two names DISAGREE for this agent — without which §4 proves nothing');

const rawFrame = await rawListAgents(socketPath);
const rawRows = [
  ...(Array.isArray(rawFrame.agents) ? rawFrame.agents : []),
  ...(Array.isArray(rawFrame.foreignPanes) ? rawFrame.foreignPanes : [])
];
const rawRow = rawRows.find((r) => (r.workDir ?? r.path) === workDir);

check('CrabCast reports a row for this workspace on the raw wire', !!rawRow, `rows seen: ${rawRows.length}`);
note('raw paneName', JSON.stringify(rawRow?.paneName));
note('butchr name ', JSON.stringify(butchrName));

check(
  'the pane carries CrabCast\'s name, not Butchr\'s — so a raw `paneName` join CANNOT find it',
  !!rawRow && rawRow.paneName !== butchrName,
  `paneName=${JSON.stringify(rawRow?.paneName)} butchrName=${JSON.stringify(butchrName)} — ` +
    'if these are EQUAL, this agent is not the population KAN-397 is about and §4 below is vacuous.'
);

// ── 3. the derived name is the one every caller addresses it by ────────────
rule('3. the census, in Butchr\'s vocabulary (KAN-346, unchanged — the baseline)');

const record = runtime.listHerdrAgents().find((a) => a.workDir === workDir);
check(
  '`censusRecords()` names the row from its path, so the fleet listing shows it',
  record?.name === butchrName,
  JSON.stringify(record)
);

// ── 4. THE DEFECT — the presence check, on both arms ───────────────────────
rule('4. confirmAgentPresent finds it under that same name (KAN-397)');

const strict = await runtime.confirmAgentPresent(butchrName, true, 20_000);
const lenient = await runtime.confirmAgentPresent(butchrName, false, 6_000);

check(
  'strict (requireRuntime=true) — the reading a `claude` spawn actually gets',
  strict.present === true,
  `strict  → ${JSON.stringify(strict)}\nlenient → ${JSON.stringify(lenient)}`
);
check('lenient (requireRuntime=false)', lenient.present === true, JSON.stringify(lenient));
check(
  'the two arms agree, which is what identifies a failure here as the LOOKUP rather than the flag',
  strict.present === lenient.present,
  `strict.present=${strict.present} lenient.present=${lenient.present}`
);
note('strict ', JSON.stringify(strict));
note('lenient', JSON.stringify(lenient));

// ── 5. the consequence, read out of router.ts AS TEXT ──────────────────────
rule('5. what `absent` costs — read out of daemon/src/router.ts, not inferred');

// STATIC SECTION. This reads source and is unaffected by a stale or failed
// build; see the header. It exists so the sentence "a live agent would be torn
// down" is a fact about this repository rather than a claim in a ticket.
const routerSrc = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'router.ts'), 'utf8');
const confirmActivation = routerSrc.slice(
  routerSrc.indexOf('private async confirmActivation'),
  routerSrc.indexOf('private async handleActivate')
);

check(
  'confirmActivation is what calls confirmAgentPresent, with the session\'s expectsRuntime',
  /confirmAgentPresent\(\s*agentName,\s*session\.expectsRuntime \?\? true\s*\)/.test(confirmActivation),
  confirmActivation.slice(0, 400)
);
check(
  "and `absent` — the reason a name that does not match produces — reaches abandonSession",
  /presence\.reason === 'absent'/.test(confirmActivation) &&
    /abandonSession\(session\.sessionId, presence\.error\)/.test(confirmActivation),
  confirmActivation.slice(0, 400)
);
check(
  'confirmActivation is on the activation path, so that error becomes the activation answer',
  (routerSrc.match(/await this\.confirmActivation\(session, agentName\)/g) ?? []).length >= 1,
  'no call site found'
);

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
runtime.terminateSession(session.sessionId);
await sleep(3_000);
runtime.dispose();
await cleanup();

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (failures) {
  console.log(`   ${failures} check(s) failed. Read §2 first: if IT is red, §4's verdict is vacuous`);
  console.log('   and the run should be discarded rather than reported.');
} else {
  console.log(
    '   OK — a real claude agent that CrabCast started, carrying CrabCast\'s pane name, was\n' +
      '   found by confirmAgentPresent under the Butchr name every caller addresses it by,\n' +
      '   on both requireRuntime arms.'
  );
}
console.log('');
process.exit(failures ? 1 : 0);
