// Cutover gate 2 (KAN-379): a REAL `claude` agent, started through the
// CrabCast-backed runtime, with the three mechanisms `shell` never exercised
// demonstrated SEPARATELY — prompt delivery, MCP wiring, and `expectsRuntime`.
//
// WHAT FAILURE THIS WOULD CATCH: a CrabCast-started `claude` agent that spawns,
// appears in the census, and cannot do the job — the failure the 2026-08-12 flip
// could not see, because its six preconditions asked whether the runtime
// CONNECTS and never whether an agent can WORK. Concretely: a prompt that is
// accepted by `configure_agent` and never reaches the model; a prompt truncated
// on the way (which a short probe cannot notice, so this one sends a
// real-brief-sized payload and asserts a marker at its END); MCP definitions
// that arrive in a shape the agent's client cannot use, so `butchr_*` or
// Atlassian is silently absent and the agent looks alive and is useless; and an
// activation-confirmation join that cannot find an agent CrabCast started, which
// tears down the session of a perfectly healthy agent.
//
// CI-RUNNABLE: no — needs a real CrabCast daemon, real capacity for one more
// agent, and it starts a real `claude` process that spends real tokens.
//
// ── THIS SCRIPT IS RED WHILE THE GATE IS OPEN, AND THAT IS THE VERDICT ──────
//
// It reports two kinds of result and both feed the exit code:
//
//   check()   — something that must hold for the run to mean anything.
//   gate()    — one of the gate's mechanisms. A `gate` that fails is a FINDING:
//               a mechanism that does not work on this path, reported rather
//               than worked around (KAN-379 AC2).
//
// So a non-zero exit here does NOT mean the script is broken. It means gate 2 is
// still open, and the sections below name what is holding it. It goes green when
// the findings are fixed, which is the only signal worth having.
//
// ── EXIT 0 GREEN, 1 RED, AND 2 DID NOT RUN (KAN-405) ───────────────────────
//
// CrabCast gates activation on measured CPU and refuses outright when the
// machine is busy. On a loaded fleet **that is the ordinary answer, not the rare
// one** — `task/KAN-397` measured six consecutive refusals over half an hour —
// and it is not a verdict about prompt delivery, MCP wiring or `expectsRuntime`,
// none of which were reached. So it is given its own code rather than being
// allowed to read as a mechanism finding. Retry when the machine is quieter.
//
// **The run cleans up after itself on every one of those paths.** `cleanup()` is
// declared before the spawn and called on the refusal path, on the early-failure
// path and at the end; anything this script created, this script removes.
// Until KAN-405 the refusal path returned BEFORE the cleanup section, so the
// path taken most often was the one that leaked — a configured CrabCast record
// and a probe workspace, every time. That is the shape KAN-397's sibling script
// closed deliberately, carried here.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST ─────────────────────
//
// **This script constructs the runtime and calls `spawnSession` directly. It
// does NOT boot `daemon.ts`.** It cannot: `BUTCHR_AGENT_RUNTIME` is read once,
// process-wide, at daemon construction (`runtime-switch.ts`), so pointing a
// single activation at CrabCast without flipping the fleet means constructing
// the runtime in a process of one's own. Flipping the fleet is out of scope
// (KAN-379) and is the one-way door `docs/crabcast-cutover-sequence.md` §8
// describes. `verify-crabcast-runtime-live.mjs` has the same limit and says so.
//
// So this script SUPPLIES TWO OF THE ARGUMENTS a real activation would compute:
//
//   - `mcpServers`. Assembled here by the same chain `MessageRouter
//     .mcpServersForSpawn()` uses — enabled integrations first, `coreMcpServer
//     Definitions()` last. §2 asserts that is still what the router does, by
//     READING `router.ts` AS TEXT.
//   - `promptContent`. A PROBE brief, not a rendered `prompts/task.md` — handing
//     a throwaway agent a real brief would have it claim a Jira ticket. §2
//     asserts the router renders its prompt into the same parameter, again by
//     reading source as text.
//
// **What that leaves uncovered, named rather than implied: a static read is not
// an execution.** These two assertions prove the call site still SAYS the right
// thing; they cannot prove the router RUNS. Nothing covers that, because nothing
// can until the fleet is flipped — and a flip is what the gates exist to
// precede. It is recorded as the honest edge of this proof rather than closed.
// The KAN-145 shape is the one being guarded against here: two scripts each
// honest about what they test, with a hole between them that neither owns.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   cd daemon && npm run build            # it imports from ../dist
//   node daemon/scripts/verify-crabcast-claude-launcher-live.mjs [--verbose]
//
// A CrabCast daemon must be listening at `BUTCHR_CRABCAST_SOCKET`, or at
// `defaultCrabCastSocket()` when that is unset. CrabCast's capacity gate must
// have room for one agent; a refusal lands in `spawnError` with their figures.
//
// ── HOW IT WAS MADE TO GO RED ──────────────────────────────────────────────
//
// Not by breaking the script — by breaking the thing it guards, in
// `daemon/src/crabcast-runtime.ts`'s `provision()`, rebuilding, and re-running.
// Both mutations COMPILE, which is the point: a mutation that fails the build
// leaves the proof running against a stale `dist` and its verdict is about code
// that never executed (`prompts/task.md`). The transcripts are on the PR.
//
//   1. delete `prompt: promptContent` from the `configure_agent` frame
//      → §4 AND §5 go red. The agent starts and sits at Claude Code's welcome
//        screen: no prompt, so no markers, and — because §5's evidence is the
//        agent's own output — no tool calls either. **That second half was not
//        predicted when this header was first written, and it is the more
//        useful result**: it is the ticket's own failure mode reproduced on
//        demand — an agent that "starts and cannot reach its tools looks alive
//        and is useless", indistinguishable from a healthy one from outside.
//   2. delete the `configure.mcpServers = mcpServers` assignment
//      → §5's two mechanism gates go red on their own: the agent reads its
//        prompt, tries both calls and answers BUTCHRFAIL / ATLASSIANFAIL, so
//        §4 stays green. This is the mutation that separates the two
//        mechanisms; mutation 1 cannot.
//
// **Every check() in §1–§3 stayed green under both** — 0 failures, the spawn
// succeeding and the census still reporting `agentRuntime: claude`. That is
// exactly the distinction this gate exists to draw, and it is the reason a
// successful spawn was never evidence for any of the three mechanisms.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const { createAgentRuntime, crabCastSocketPath } = await import('../dist/runtime-switch.js');
const { workspaceDirFor, agentNameFor } = await import('../dist/herdr.js');
const launchers = await import('../dist/launchers.js');
const { WorkspaceRegistry } = await import('../dist/registry.js');
const { createAtlassianIntegration } = await import('../dist/integrations/atlassian-integration.js');
const { createLaunchDarklyIntegration, LaunchDarklyIntegration } = await import(
  '../dist/integrations/launchdarkly.js'
);

const verbose = process.argv.includes('--verbose');
let failures = 0;
let findings = 0;
const findingLog = [];

function rule(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

/** One of the gate's mechanisms. A failure here is a FINDING, not a broken test. */
function gate(label, ok, detail) {
  console.log(`   ${ok ? 'WORKS  ' : 'FINDING'}  ${label}`);
  if (!ok) {
    findings++;
    findingLog.push(label);
    if (detail) console.log(`             ${String(detail).split('\n').slice(0, 10).join('\n             ')}`);
  } else if (verbose && detail) {
    console.log(`             ${String(detail).split('\n')[0]}`);
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
 * Terminal output is not text. herdr renders a pane by emitting a
 * cursor-position escape before nearly every character, so a plain `includes`
 * finds nothing while the bytes are all present and in order — the trap that
 * cost `verify-crabcast-runtime-live.mjs` its first live run. Strip CSI/OSC,
 * then keep only the characters a marker is made of. Markers here are
 * letters-only and short for exactly that reason.
 */
function paneLetters(raw) {
  return String(raw)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
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

// Per-run markers, letters-only so they survive a rendered pane. The agent can
// only print these if the prompt reached it — they are not derivable from
// anything else it can see.
const RUN = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
const HEAD = `KANHEAD${RUN}`;
const TAIL = `KANTAIL${RUN}`;

const TYPE = 'task';
// A THROWAWAY KEY, and the hazard is why. An activation under CrabCast starts
// an agent FRESH — there is no `--continue` on that path — so pointing this at
// a workspace whose conversation matters destroys it. That property killed
// `task/KAN-275` in seven minutes on 2026-08-12.
//
// **UNIQUE PER RUN, and that is a trap being closed rather than tidiness.**
// CrabCast refuses to change `launcher`, `prompt` or `mcp` on a path it already
// holds a record for — `configure --help` says so — so a second run against a
// fixed key would be configured with the PREVIOUS run's prompt, carrying the
// PREVIOUS run's markers. §4 would then report the prompt as undelivered while
// prompt delivery was working perfectly: a false finding, produced by the proof
// re-running rather than by anything under test.
const KEY = process.env.KAN379_PROBE_KEY ?? `kan-379-gate2-${RUN.toLowerCase()}`;
const workDir = workspaceDirFor(TYPE, KEY);
const butchrName = agentNameFor(TYPE, KEY);

console.log(`CrabCast socket : ${socketPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}   (throwaway — see the header)`);
console.log(`butchr name     : ${butchrName}`);
console.log(`workspace       : ${workDir}`);
console.log(`run markers     : ${HEAD} / ${TAIL}`);

// ── 1. which runtime is serving, read off the wire ─────────────────────────
rule('1. the runtime — CrabCast is serving this spawn, and the peer says which build');

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });

check('the runtime is CrabCastRuntime', runtime.constructor.name === 'CrabCastRuntime');
check('and its report says so, from the decision rather than a re-read', report.mode === 'crabcast', JSON.stringify(report));

const connected = await until(() => runtime.describe().link.connected, 8_000);
check('the link connected to a real CrabCast daemon', connected === true, JSON.stringify(runtime.describe().link));

const link = runtime.describe().link;
check(
  'the peer identified its build over the wire',
  typeof link.peerCommit === 'string' && link.peerCommit.length === 40,
  JSON.stringify(link)
);
note('peer build', `${link.peerCommit?.slice(0, 12)} (adapter pinned to ${link.pinnedCommit.slice(0, 12)}, match=${link.peerMatchesPin})`);
note('read-path contract', `peer v${link.peerContractVersion}, pinned v${link.pinnedContractVersion}`);

// ── 2. the arguments are the daemon's own, not this proof's invention ──────
rule("2. provenance of the arguments — the router still assembles them this way");

// Read as TEXT. This is the weaker half of the proof and the header says so:
// it establishes that the call site still SAYS this, never that it ran.
const routerSrc = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'router.ts'), 'utf8');
check(
  'router.ts still assembles MCP servers as integrations-then-core in one place',
  /mcpServersForSpawn\(\)\s*:\s*McpServerDefinitions\s*\{[\s\S]{0,300}?registry\.mcpServerDefinitions\(\)[\s\S]{0,120}?coreMcpServerDefinitions\(\)/.test(
    routerSrc
  ),
  'mcpServersForSpawn no longer matches the shape this proof reproduces'
);
check(
  'router.ts passes a rendered prompt into spawnSession, in the parameter this proof fills',
  /promptLoader\.loadAndRender\(/.test(routerSrc) &&
    /spawnSession\([^)]*renderedPrompt[^)]*\)/.test(routerSrc),
  'the router no longer renders a prompt into spawnSession'
);

const registry = new WorkspaceRegistry();
registry.registerIntegration(createAtlassianIntegration({}));
registry.registerIntegration(
  createLaunchDarklyIntegration(new LaunchDarklyIntegration(undefined, 'https://app.launchdarkly.com'))
);
const mcpServers = { ...registry.mcpServerDefinitions(), ...launchers.coreMcpServerDefinitions() };

check(
  'the assembly produced the two servers a real agent gets',
  Object.keys(mcpServers).includes('butchr') && Object.keys(mcpServers).includes('atlassian'),
  `assembled: ${Object.keys(mcpServers).join(', ')}`
);
note('servers sent', Object.keys(mcpServers).join(', '));

// The prompt. Padded to at least the size of a real rendered brief, with the
// TAIL marker last — a short probe cannot notice a truncating transport, and
// truncation is the failure mode a prompt this size actually has.
const realBriefBytes = fs.statSync(path.join(repoRoot, 'prompts', 'task.md')).size;
// Sized off `prompts/task.md` at run time rather than by a hand-tuned count, so
// this cannot silently stop being brief-sized the next time that file grows.
const fillerLine = (i) =>
  `Filler line ${i}: padding, so the delivered prompt is at least the size of a real brief.`;
const filler = Array.from(
  { length: Math.ceil(realBriefBytes / (fillerLine(1000).length + 1)) + 40 },
  (_, i) => fillerLine(i)
).join('\n');

const prompt = `${HEAD}

You are a throwaway probe agent for KAN-379 (CrabCast cutover gate 2). Do
exactly the four steps below, print each result on its own line, and then STOP.
Do not create files, do not touch git, do not open a pull request, do not
transition any Jira issue.

1. Print:  PROMPTHEAD=${HEAD}
2. Call the MCP tool \`butchr_list_agents\`. If it returns, print BUTCHROK
   followed by the number of agents. If the tool does not exist or errors,
   print BUTCHRFAIL and the reason.
3. Call the Atlassian MCP tool \`atlassianUserInfo\`. If it returns, print
   ATLASSIANOK and the account display name. If the tool does not exist or
   errors, print ATLASSIANFAIL and the reason.
4. Print:  PROMPTTAIL=${TAIL}

${filler}

${TAIL}
`;

check(
  'the probe prompt is at least the size of a real rendered brief',
  Buffer.byteLength(prompt) >= realBriefBytes,
  `probe ${Buffer.byteLength(prompt)} bytes vs prompts/task.md ${realBriefBytes} bytes`
);
note('prompt bytes', `${Buffer.byteLength(prompt)} (prompts/task.md is ${realBriefBytes})`);

// ── 3. the spawn ───────────────────────────────────────────────────────────
rule('3. spawnSession — a real `claude` agent, through CrabCast');

function trustedFor(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return cfg?.projects?.[dir]?.hasTrustDialogAccepted ?? null;
  } catch {
    return 'unreadable';
  }
}
const trustBefore = trustedFor(workDir);
const dirExistedBefore = fs.existsSync(workDir);

/**
 * Undo everything this run made, on EVERY exit path including the early ones.
 *
 * This is declared BEFORE the spawn, next to the `dirExistedBefore` reading it
 * closes over, because the paths that need it most are the ones that return
 * before the script's own cleanup section is ever reached. A run whose
 * activation is REFUSED has still had `configure_agent` accepted, so it leaves a
 * CrabCast record behind, and a unique-key-per-run script that exits before
 * cleanup grows `daemon_status.configuredAgents` by one on every attempt.
 * **Under CPU pressure the refused runs are the common ones** — measured
 * 2026-08-14 for KAN-405: one refused run took `configuredAgents` 5 → 6 and left
 * `task/kan-379-gate2-oqoitp` on disk, and `task/KAN-397` saw six consecutive
 * refusals in half an hour. Copied from the treatment
 * `verify-crabcast-confirm-present-name-join.mjs` (KAN-397) gives the same gap.
 */
async function cleanup() {
  // THE RECORD GOES FIRST, AND THE ORDER IS LOAD-BEARING RATHER THAN
  // ARBITRARY. The two halves of this leak are not equally recoverable: the
  // probe workspace is an ordinary directory anybody could remove, but the
  // configured record lands in `~/.local/share/crabcast/agents.jsonl`, which is
  // on the standing never-touch list for every Butchr agent. **So nobody
  // downstream is permitted to sweep the record half** — "somebody will notice"
  // is not a fallback that exists here, and `task/KAN-397` could not have swept
  // it by hand even had it tried. If only one half can be undone it must be this
  // one, so it runs before anything that could throw and take the rest with it.
  //
  // `crabcast forget` is CrabCast's own published surface for this and the only
  // sanctioned removal; reaching into `agents.jsonl` would trade a leak for a
  // much worse defect. `resetWorkspace` refuses under this runtime and
  // `AgentRuntime` has no forget verb, so this is the CLI rather than the
  // adapter. It removes ONLY the path this run created — measured on this
  // script: `daemon_status.configuredAgents` went 4 → 8 over four runs before
  // any of this existed, and 5 → 6 on the single refused run that opened
  // KAN-405.
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
  // Then the directory. Butchr owns it at both ends — CrabCast never made it and
  // will never delete it (`configure` may not `mkdir`, so `forget` above left it
  // untouched by design). Guarded in its own right so that a failure here is
  // reported rather than thrown: by this point the unrecoverable half is already
  // gone, and a crash would only cost the caller its verdict.
  try {
    const insideWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
    if (insideWorkspaces && !dirExistedBefore && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`   removed probe workspace ${workDir}`);
    } else {
      console.log(`   left ${workDir} alone (pre-existing, or outside the workspaces tree)`);
    }
  } catch (err) {
    console.log(
      `   could NOT remove probe workspace ${workDir} — remove it by hand:\n` +
        `         rm -rf ${workDir}\n` +
        `         (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`
    );
  }
}

const session = runtime.spawnSession(
  TYPE,
  KEY,
  'https://wroosbit.atlassian.net/browse/KAN-379',
  prompt,
  'claude',
  mcpServers
);

check('spawnSession returned a session synchronously', !!session?.sessionId, JSON.stringify(session));
check("it starts in 'initializing'", session.status === 'initializing', session.status);
check('Butchr created the workspace directory, because CrabCast will not', fs.existsSync(workDir));

await until(() => session.status === 'active' || !!session.spawnError, 90_000);

// A CAPACITY REFUSAL IS NOT A VERDICT ABOUT ANY OF THE THREE MECHANISMS, and
// exiting 1 on one reports gate 2 as open when it was never tested. CrabCast
// gates activation on measured CPU and refuses in so many words; on a busy fleet
// that is the ordinary answer, not a finding. Exit 2 and say so, so a wrapper can
// retry and a reader cannot mistake it for red. This is KAN-373's class from the
// other direction — there a skip read as a pass; here a refusal read as a red.
const refusedForCapacity = !!session.spawnError && /cpu too busy|memory|at capacity|headroom/i.test(session.spawnError);
if (session.status !== 'active' && refusedForCapacity) {
  console.log('\n   SKIPPED — CrabCast refused the activation for capacity, so no agent ran.');
  console.log('   This is NOT a verdict on gate 2. Retry when the machine is quieter.\n');
  console.log(`   ${session.spawnError.split('\n').slice(0, 3).join('\n   ')}`);
  runtime.dispose();
  await cleanup();
  process.exit(2);
}

check(
  'the session went active',
  session.status === 'active',
  session.spawnError ?? `still ${session.status} after 90s`
);
if (session.status !== 'active') {
  console.log('\nFAILED early — no agent started, so nothing below would mean anything.');
  runtime.dispose();
  await cleanup();
  process.exit(1);
}

// WHICH RUNTIME SERVED THE SPAWN, READ OFF THE DAEMON RATHER THAN ASSUMED
// (KAN-379 AC1). `agentRuntime` here is CrabCast's own answer about the pane it
// started, arriving on their `list_agents` census — not this process's opinion
// of what it asked for.
const censusRow = await until(() => runtime.listHerdrAgents().find((a) => a.workDir === workDir), 20_000);

check(
  "CrabCast's own census reports a runtime behind the pane, and it is claude",
  censusRow?.agentRuntime === 'claude',
  JSON.stringify(censusRow)
);
note('census row', JSON.stringify(censusRow));
note('channelEnabled (from activate_response)', JSON.stringify(runtime.channelEnabledFor(session.sessionId)));

// ── 4. MECHANISM 1 — prompt delivery ───────────────────────────────────────
rule('4. MECHANISM 1 — prompt delivery: does the brief reach the model, intact?');

// The pane is where the answer is. Poll it rather than sleeping a fixed budget:
// a cold `claude` start plus three tool calls is not a predictable duration.
const sawPrompt = await until(
  async () => {
    const t = await runtime.tailAgent(KEY, TYPE, 200);
    if (t.success !== true) return null;
    const L = paneLetters(t.text ?? '');
    return L.includes(TAIL) ? t : null;
  },
  240_000,
  5_000
);
const finalTail = sawPrompt ?? (await runtime.tailAgent(KEY, TYPE, 200));
const paneText = String(finalTail?.text ?? '');
const paneL = paneLetters(paneText);

gate(
  'the prompt reached the model — the agent printed a marker only the prompt carries',
  paneL.includes(HEAD),
  `HEAD marker ${HEAD} never appeared in the pane. Prompt was accepted by configure_agent ` +
    `but did not reach the model.`
);
gate(
  `the WHOLE prompt arrived — the marker at byte ${Buffer.byteLength(prompt)} survived, so nothing truncated it`,
  paneL.includes(TAIL),
  `TAIL marker ${TAIL} is absent while HEAD is ${paneL.includes(HEAD) ? 'present' : 'absent'}. ` +
    `HEAD present + TAIL absent means the payload was TRUNCATED in transit.`
);

// Measured, and it is a real difference from the herdr path rather than a nit.
const promptFileWritten = fs.existsSync(path.join(workDir, '.butchr-prompt.md'));
note('.butchr-prompt.md written', String(promptFileWritten));
check(
  'the prompt did NOT arrive as .butchr-prompt.md — this path delivers it another way',
  promptFileWritten === false,
  'a .butchr-prompt.md appeared, which this path was measured not to write. Re-read the finding below.'
);

// ── 5. MECHANISM 2 — MCP wiring ────────────────────────────────────────────
rule('5. MECHANISM 2 — MCP wiring: two servers, wired by different config');

gate(
  'the agent reached the `butchr` server and a butchr_* call returned',
  paneL.includes('BUTCHROK'),
  paneL.includes('BUTCHRFAIL')
    ? 'the agent reported BUTCHRFAIL — the core server is present but did not answer.'
    : 'neither BUTCHROK nor BUTCHRFAIL in the pane; the agent never got that far.'
);
gate(
  'the agent reached the `atlassian` server and an Atlassian call returned',
  paneL.includes('ATLASSIANOK'),
  paneL.includes('ATLASSIANFAIL')
    ? 'the agent reported ATLASSIANFAIL — the server is configured and did not answer.'
    : 'neither ATLASSIANOK nor ATLASSIANFAIL in the pane; the agent never got that far.'
);

// WHAT LANDED ON DISK, which is the leg that decides whether the servers can
// start at all. CrabCast writes the definitions VERBATIM (their own words on
// `configure_agent`); Butchr's own writer runs `materializeMcpServers` first.
const writtenPath = path.join(workDir, '.mcp.json');
const written = fs.existsSync(writtenPath) ? JSON.parse(fs.readFileSync(writtenPath, 'utf8')) : null;
check('CrabCast wrote a .mcp.json into the workspace', !!written?.mcpServers, `no .mcp.json at ${writtenPath}`);

const atlassianOnDisk = written?.mcpServers?.atlassian ?? {};
const butchrOnDisk = written?.mcpServers?.butchr ?? {};

gate(
  '`pathPrefix` was materialised into env.PATH before it reached disk',
  atlassianOnDisk.pathPrefix === undefined && typeof atlassianOnDisk.env?.PATH === 'string',
  `the atlassian entry on disk carries pathPrefix=${JSON.stringify(atlassianOnDisk.pathPrefix)} ` +
    `and env.PATH=${JSON.stringify(atlassianOnDisk.env?.PATH)}. \`pathPrefix\` is a BUTCHR field, ` +
    `not an MCP one: materializeMcpServers turns it into env.PATH and every Butchr writer applies ` +
    `it. provision() sends raw definitions, so the field crosses the wire and CrabCast writes it ` +
    `verbatim. KAN-157 added it to decide WHICH NODE runs an npx-based server; without it that is ` +
    `whatever the inherited PATH resolves.`
);

gate(
  'the core server carries its workspace identity, so the agent can be placed on the org chart',
  Array.isArray(butchrOnDisk.args) &&
    butchrOnDisk.args.includes(launchers.WORKSPACE_TYPE_FLAG) &&
    butchrOnDisk.args.includes(launchers.WORKSPACE_KEY_FLAG),
  `the butchr entry's argv is ${JSON.stringify(butchrOnDisk.args)} — no ` +
    `${launchers.WORKSPACE_TYPE_FLAG}/${launchers.WORKSPACE_KEY_FLAG}. \`withWorkspaceIdentity\` is ` +
    `applied in herdr.ts, and crabcast-runtime.ts imports nothing from launchers.js, so this path ` +
    `sends the definitions unstamped. That is the KAN-145 defect exactly: a value written where ` +
    `nothing reads it, leaving activatedBy null and the org chart unable to render.`
);

// Not asserted — measured, because it is a difference from the herdr path whose
// consequence is CrabCast's to state rather than ours to predict.
note('.claude/settings.local.json written', String(fs.existsSync(path.join(workDir, '.claude', 'settings.local.json'))));
note('workspace trusted in ~/.claude.json', `before=${JSON.stringify(trustBefore)} after=${JSON.stringify(trustedFor(workDir))}`);

// ── 6. MECHANISM 3 — expectsRuntime ────────────────────────────────────────
rule('6. MECHANISM 3 — expectsRuntime: the strict reading `shell` could never exercise');

// `shell` sets expectsRuntime FALSE, so KAN-278's proof took the lenient branch
// and the strict one has never run on this path. This is that branch.
check(
  'a `claude` spawn sets expectsRuntime true, which is the strict reading',
  session.expectsRuntime === true,
  `expectsRuntime=${JSON.stringify(session.expectsRuntime)}`
);

const strict = await runtime.confirmAgentPresent(butchrName, true, 20_000);
const lenient = await runtime.confirmAgentPresent(butchrName, false, 6_000);

gate(
  'confirmAgentPresent finds the running agent under its Butchr name (strict)',
  strict.present === true,
  `strict  → ${JSON.stringify(strict)}\n` +
    `lenient → ${JSON.stringify(lenient)}\n` +
    `BOTH ARMS FAIL IDENTICALLY, so this is NOT expectsRuntime rejecting the agent — the name ` +
    `lookup fails before the flag is ever consulted. confirmAgentPresent matches on the raw ` +
    `\`paneName\` (crabcast-runtime.ts, \`all.find((r) => r.paneName === agentName)\`), and an agent ` +
    `CrabCast started carries THEIR name (crabcast-<key>-<hash>), not \`butchr-<type>-<key>\`. ` +
    `KAN-346 fixed exactly this join in \`censusRecords()\` — deriving the name from the row's ` +
    `path — and did not carry the fix to this reader.`
);

check(
  'the two arms agree, which is what identifies the failure as the lookup rather than the flag',
  strict.present === lenient.present,
  `strict.present=${strict.present} lenient.present=${lenient.present}`
);

// The consequence, stated where it is measured rather than left to inference.
if (!strict.present) {
  console.log(
    `\n   CONSEQUENCE: router.ts's confirmActivation calls confirmAgentPresent(agentNameFor(type,key),\n` +
      `   session.expectsRuntime ?? true) and, on 'absent', calls abandonSession and answers the\n` +
      `   activation success:false. So under a flipped daemon EVERY CrabCast-started claude agent\n` +
      `   would be reported as a failed activation and have its session torn down WHILE STILL\n` +
      `   RUNNING — leaving a live pane no Butchr session addresses.`
  );
}

note('expectsRuntime, as it behaves today', 'defaultAgent !== "shell"; true for every claude spawn, and the only false case is `shell`');

// ── 7. what the pane actually said ─────────────────────────────────────────
rule('7. the pane, as CrabCast read it');
console.log(
  paneText
    .split('\n')
    .filter((l) => l.trim().length)
    .slice(-18)
    .map((l) => `   | ${l}`)
    .join('\n')
);
note('tail source', `${JSON.stringify(finalTail?.source)} (truncated=${JSON.stringify(finalTail?.truncated)})`);

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
runtime.terminateSession(session.sessionId);
await sleep(3_000);
runtime.dispose();
await cleanup();

// ── verdict ────────────────────────────────────────────────────────────────
rule('verdict');
if (findings) {
  console.log(`   GATE 2 IS OPEN — ${findings} mechanism finding(s):`);
  for (const f of findingLog) console.log(`     · ${f}`);
}
if (failures) console.log(`   ${failures} check(s) failed — the run's own preconditions did not hold.`);
if (!findings && !failures) {
  console.log(
    '   OK — a real claude agent ran through the CrabCast-backed runtime: its whole prompt\n' +
      '   reached the model, both MCP servers answered, and the strict presence check found it.'
  );
}
console.log('');
process.exit(failures || findings ? 1 : 0);
