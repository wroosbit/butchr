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
// ── KAN-417: THIS SCRIPT WAS STALE AGAINST KAN-398, AND §5 WAS MEASURING ITS
//    OWN OMISSION ───────────────────────────────────────────────────────────
//
// KAN-398 moved `withWorkspaceIdentity` and `materializeMcpServers` ABOVE the
// runtime seam: `MessageRouter` now calls `prepareWorkspaceMcpServers(mcpServers,
// {type, key})` and hands `spawnSession` the branded result, and
// `crabcast-runtime.ts` applies nothing. **This script kept assembling raw
// definitions and passing them straight to `spawnSession`** — which a `.mjs`
// cannot be stopped from doing, because the brand is a compile-time guard and
// there is no compiler here.
//
// So from KAN-398 until this repair the script no longer reproduced the router.
// Its two §5 gates went RED, and the red was **about the script**: it really was
// sending `pathPrefix` across the wire and really was sending the core server
// unstamped, because it had skipped the preparation the router does. Reported as
// a mechanism finding, that is a false red naming a defect that had already been
// fixed — the mirror of the stale-assertion-green the ticket warned about, and
// the reason `KAN-417` asked for this section to be re-derived rather than
// re-run.
//
// **The repair is to do what the router does, in the same order, at the same
// point** — §2 now asserts that call site by reading `router.ts` as text, and §3
// passes `prepareWorkspaceMcpServers(...)` rather than the raw assembly. §5 then
// asserts the FILE, which is the leg nobody had ever looked at.
//
// **THIS SCRIPT SUPPLIES THE ASSEMBLY IT THEN ASSERTS ON, and that is the edge
// of what §5 covers.** It calls `prepareWorkspaceMcpServers` itself, so a §5 pass
// says: *the transforms produce a correct file when they are applied, and
// CrabCast writes that file through undamaged.* It does **not** say the router
// applies them on a real activation — §2's static read is all there is of that,
// and it is a read rather than an execution. Nothing covers the gap, for the
// reason the section above gives: until the fleet is flipped, nothing can. It is
// the KAN-145 shape again and it is named here rather than left between two
// scripts.
//
// **What §5b adds is the leg that is NOT self-supplied**, and it is the reason
// the ticket asked for a consequence and not just a file: the probe agent's own
// `claude` client reads the `.mcp.json`, starts the `butchr` server from it, and
// that server announces itself to the REAL daemon. Nothing in this script writes
// any of that. See §5b.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   cd daemon && npm run build            # it imports from ../dist
//   node daemon/scripts/verify-crabcast-claude-launcher-live.mjs [--verbose] [--override]
//
// `--override` is the blocking-proof bypass for a capacity refusal, permitted by
// the standing rule on KAN-348. Off by default; see the block at the refusal for
// what it costs the proof and what it does not.
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

// KAN-417. The preparation step, asserted at the call site for the same reason
// the assembly is: this script reproduces what the router does, so a router that
// stops preparing must break this proof rather than silently outrun it. That is
// the failure that produced this repair — the call site moved and the script did
// not.
check(
  'router.ts prepares the assembly before it crosses the seam, in the parameter this proof fills',
  /prepareWorkspaceMcpServers\(\s*mcpServers\s*,\s*\{[^}]*type[^}]*key[^}]*\}\s*\)/.test(routerSrc),
  'router.ts no longer calls prepareWorkspaceMcpServers(mcpServers, {type, key}) into spawnSession'
);
// And that it is still asked BEFORE preparation, because preparation strips the
// field the refusal reads — a check placed after it can only ever return the
// reassuring answer (launchers.ts says so at `prepareWorkspaceMcpServers`).
check(
  'the unusable-server refusal is consulted on the RAW assembly, before preparation',
  routerSrc.indexOf('refuseUnusableMcpServers(mcpServers)') !== -1 &&
    routerSrc.indexOf('refuseUnusableMcpServers(mcpServers)') <
      routerSrc.indexOf('prepareWorkspaceMcpServers(mcpServers'),
  'refuseUnusableMcpServers no longer precedes prepareWorkspaceMcpServers'
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

// ── the preparation, applied HERE because KAN-398 put it here ──────────────
//
// The raw assembly is kept as `mcpServers` so §5 can compare what went in
// against what landed on disk. Asserting "no pathPrefix in the file" without
// knowing a pathPrefix was ever there is a check that could only pass — the
// class KAN-388 names — so §5 reads the expected values out of THIS object
// rather than hard-coding them, and refuses to credit itself where the raw
// assembly gave it nothing to strip.
const preparedMcpServers = launchers.prepareWorkspaceMcpServers(mcpServers, { type: TYPE, key: KEY });

// The positive control for every §5 assertion below. If the raw assembly carried
// no `pathPrefix` at all, §5's `pathPrefix` gates are vacuous and say so rather
// than reporting a pass.
const rawPathPrefixes = Object.entries(mcpServers)
  .filter(([, d]) => Array.isArray(d.pathPrefix) && d.pathPrefix.length > 0)
  .map(([name, d]) => [name, d.pathPrefix]);
check(
  'the raw assembly carries at least one `pathPrefix`, so §5 has something to have stripped',
  rawPathPrefixes.length > 0,
  'no server in the raw assembly has a pathPrefix on this machine, so §5s materialisation gates ' +
    'would pass without testing anything. They are reported as VACUOUS below rather than as green.'
);
note(
  'raw pathPrefix (what materialisation must consume)',
  rawPathPrefixes.map(([n, p]) => `${n}=${p.join(':')}`).join('  ') || '(none)'
);
note(
  'prepared butchr argv (what the stamp must put on the wire)',
  JSON.stringify(preparedMcpServers.butchr?.args)
);

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

// §5b reads the REAL daemon's log for this probe's identified `hello`. The
// offset is taken BEFORE the spawn so a match can only be this run's — the key
// is unique per run as well, so this is belt and braces rather than the only
// guard.
const daemonLogPath = path.join(
  process.env.BUTCHR_DIR ?? path.join(os.homedir(), '.local', 'share', 'butchr'),
  'daemon.log'
);
const daemonLogOffsetBefore = fs.existsSync(daemonLogPath) ? fs.statSync(daemonLogPath).size : null;

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

// PREPARED, NOT RAW (KAN-417). This is the argument the router computes; passing
// `mcpServers` here is what made §5 report a fixed defect as open.
const session = runtime.spawnSession(
  TYPE,
  KEY,
  'https://wroosbit.atlassian.net/browse/KAN-379',
  prompt,
  1,
  false,
  'claude',
  preparedMcpServers
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
//
// ── AND THE CLASSIFIER IS STRUCTURAL FIRST, BY REASON ONLY SECOND ──────────
//
// **`session.spawnError` is not a refusal channel.** It carries ANY thrown
// error's message — `crabcast-runtime.ts` sets `session.spawnError = err
// instanceof Error ? err.message : String(err)` for whatever escapes the spawn
// path. So a classifier that matches only *reason words* lets an ordinary crash
// wear a refusal's clothes: `JavaScript heap out of memory` and `Cannot allocate
// memory` both contain "memory", and either would be announced as "no agent ran,
// this is NOT a verdict" and exit 2. **That fails toward the comfortable
// answer** — a genuine failure reported as a run that never happened, in the
// direction nobody investigates. It is this ticket's own class with its sign
// flipped: KAN-405 fixed a refusal reading as a red; this would be a red reading
// as a refusal. (Found in review of #172 by `epic/KAN-39`.)
//
// `activate_agent refused:` is composed at exactly one place — the branch where
// CrabCast declined the activation — so it, not the reason, is what separates a
// refusal from a crash. It is required here.
const refusedByCrabCast = /activate_agent refused/i;
// The capacity reasons MEASURED on this fleet, and deliberately no others. A
// memory-bound refusal has never been observed, so its wording is not guessed
// at: if one arrives it will fail this test and exit 1 with CrabCast's full text
// visible, which is the safe direction and is how the real string gets learned.
// Writing a matcher for a string nobody has seen is the guess this epic keeps
// paying for.
const capacityReason = /cpu too busy|at capacity|headroom/i;
const refusedForCapacity =
  !!session.spawnError &&
  refusedByCrabCast.test(session.spawnError) &&
  capacityReason.test(session.spawnError);
// ── --override: THE BLOCKING-PROOF BYPASS, AND WHAT IT COSTS THE PROOF ──────
//
// Permitted for a blocking proof by the standing rule on KAN-348 and by
// KAN-417's own ticket, under conditions this implements literally: **in this
// script only, never in `CrabCastRuntime`** (which imports no override and must
// not), **nothing stood down, no `preempt`**, and **the figures it bypassed
// disclosed** — printed here and pasted onto the ticket.
//
// It is off by default. Without it the refusal path below is unchanged.
//
// **It is issued through `crabcast activate --override`, their published CLI**,
// because the alternative is teaching the adapter a verb the ticket forbids it.
// The cost is stated rather than buried: on this path **the activation is the
// CLI's and not the runtime's**, so `CrabCastRuntime.provision`'s own
// `activate_agent` call is NOT exercised by an overridden run.
//
// **What that does NOT cost is this ticket's subject.** The MCP definitions
// cross the wire in `configure_agent`, which the runtime had already made and
// CrabCast had already accepted before the refusal — a refusal is why the
// cleanup has to forget the record. So §5 measures the runtime's own frame on
// every path; it is §3's activation leg, and only that, which is inherited from
// the CLI here.
const allowOverride = process.argv.includes('--override');
let overrodeCapacity = false;
let bypassedFigures = null;

if (session.status !== 'active' && refusedForCapacity && allowOverride) {
  bypassedFigures = session.spawnError;
  console.log('\n   CrabCast refused the activation for capacity. --override was passed, so this run');
  console.log('   bypasses that refusal deliberately. THE FIGURES IT BYPASSED, verbatim:\n');
  console.log(`   ${String(bypassedFigures).split('\n').join('\n   ')}\n`);
  try {
    const { execFileSync } = await import('child_process');
    const out = execFileSync('crabcast', ['activate', workDir, '--override'], {
      stdio: 'pipe',
      timeout: 60_000,
      encoding: 'utf8'
    });
    overrodeCapacity = true;
    console.log(`   crabcast activate --override answered:\n   ${String(out).trim().split('\n').join('\n   ')}`);
    // The runtime's session object was left `terminated` by the refusal it threw.
    // Everything below addresses CrabCast by PATH (`tailAgent`, `listHerdrAgents`,
    // `confirmAgentPresent`, `terminateSession` all resolve `pathForAddress`), so
    // the session record is corrected here to match what is now actually running
    // rather than being worked around at each reader.
    session.status = 'active';
    session.spawnError = undefined;
  } catch (err) {
    console.log(
      `   crabcast activate --override FAILED: ` +
        `${err instanceof Error ? String(err.stderr || err.message).split('\n')[0] : String(err)}`
    );
  }
}

if (session.status !== 'active' && refusedForCapacity) {
  console.log('\n   SKIPPED — CrabCast refused the activation for capacity, so no agent ran.');
  console.log('   This is NOT a verdict on gate 2. Retry when the machine is quieter,');
  console.log('   or re-run with --override if this proof is blocking (see the header).\n');
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

const serversOnDisk = written?.mcpServers ?? {};
const atlassianOnDisk = serversOnDisk.atlassian ?? {};
const butchrOnDisk = serversOnDisk.butchr ?? {};

// ── KAN-417 assertion 1: `pathPrefix` is gone from the WHOLE file ──────────
//
// Every server, not just `atlassian`: the original defect was found by reading a
// real agent's file and seeing a key no MCP client reads, and a client reading a
// key it does not understand is a per-entry hazard rather than a per-integration
// one. `rawPathPrefixes` (§2) is the positive control — it names the servers that
// HAD one, so a pass here is a strip that happened rather than a field that was
// never present.
const pathPrefixSurvivors = Object.entries(serversOnDisk)
  .filter(([, d]) => d && d.pathPrefix !== undefined)
  .map(([name]) => name);

if (rawPathPrefixes.length === 0) {
  gate(
    'VACUOUS — no server in the raw assembly had a `pathPrefix`, so nothing could have been stripped',
    false,
    'This is not a pass. materializeMcpServers had no work to do on this machine, so the file ' +
      'below proves nothing about it. Re-run where an integration supplies a pathPrefix (the ' +
      'Atlassian server does, via node-runtime.ts, whenever npx is resolved off a versioned Node).'
  );
} else {
  gate(
    '`pathPrefix` reached disk NOWHERE in the file — every one was materialised away',
    pathPrefixSurvivors.length === 0,
    `these entries still carry pathPrefix on disk: ${pathPrefixSurvivors.join(', ')}. ` +
      `\`pathPrefix\` is a BUTCHR field, not an MCP one: materializeMcpServers turns it into ` +
      `env.PATH. KAN-157 added it to decide WHICH NODE runs an npx-based server; without it that ` +
      `is whatever the inherited PATH resolves.`
  );

  // ...and landed where it was supposed to land. Compared against the directory
  // the RAW definition named, not against a hard-coded path: this asserts the
  // transform's output, so its expectation has to come from the transform's
  // input.
  for (const [name, prefixes] of rawPathPrefixes) {
    const onDisk = serversOnDisk[name] ?? {};
    const pathValue = onDisk.env?.PATH;
    const firstEntry = typeof pathValue === 'string' ? pathValue.split(':')[0] : null;
    gate(
      `\`${name}\`: env.PATH exists on disk and its FIRST entry is the directory pathPrefix named`,
      firstEntry === prefixes[0],
      `expected first PATH entry ${JSON.stringify(prefixes[0])}, found ${JSON.stringify(firstEntry)} ` +
        `(env.PATH=${JSON.stringify(pathValue)}). Order is the whole point: the prefix decides which ` +
        `node runs an npx-based server, and a directory appended AFTER the inherited PATH decides ` +
        `nothing at all.`
    );
  }
}

// ── KAN-417 assertion 2: the identity stamp carries THIS workspace's values ──
//
// Presence of the flags was the old assertion and it is too weak by exactly the
// distance that matters: `withWorkspaceIdentity` reads its values from the
// identity it is handed, so a stamp naming the WRONG workspace is the failure
// that would record an agent under somebody else's parent — worse than none, in
// launchers.ts's own words. Read the values, not the flags.
const argvOnDisk = Array.isArray(butchrOnDisk.args) ? butchrOnDisk.args : [];
const flagValue = (flag) => {
  const at = argvOnDisk.indexOf(flag);
  return at === -1 ? null : (argvOnDisk[at + 1] ?? null);
};
const stampedType = flagValue(launchers.WORKSPACE_TYPE_FLAG);
const stampedKey = flagValue(launchers.WORKSPACE_KEY_FLAG);

gate(
  "the core server's argv carries this workspace's OWN identity, not merely the flags",
  stampedType === TYPE && stampedKey === KEY,
  `the butchr entry's argv is ${JSON.stringify(argvOnDisk)} — ` +
    `${launchers.WORKSPACE_TYPE_FLAG}=${JSON.stringify(stampedType)} ` +
    `${launchers.WORKSPACE_KEY_FLAG}=${JSON.stringify(stampedKey)}, expected ` +
    `${JSON.stringify(TYPE)}/${JSON.stringify(KEY)}. That is the KAN-145 defect exactly: a value ` +
    `written where nothing reads it, or naming the wrong workspace, leaves activatedBy null or ` +
    `wrong and the org chart unable to render.`
);

// ── KAN-417 assertion 3: `unusable` is absent ───────────────────────────────
//
// Reported honestly rather than credited. `unusable` is Butchr's English
// sentence about a server that cannot start here, and on a machine where every
// server IS usable no definition carries one — so this gate has nothing to strip
// and cannot fail. Saying "PASS" there would be the KAN-388 class in one line:
// a check whose only reachable branch is the one you hoped for.
const rawUnusable = Object.entries(mcpServers)
  .filter(([, d]) => typeof d.unusable === 'string' && d.unusable !== '')
  .map(([name]) => name);
const unusableSurvivors = Object.entries(serversOnDisk)
  .filter(([, d]) => d && d.unusable !== undefined)
  .map(([name]) => name);

if (rawUnusable.length === 0) {
  note(
    '`unusable` on disk',
    `absent — but NOT evidence: no server in the raw assembly carried one on this machine ` +
      `(every server is usable here), so there was nothing for materialisation to strip. ` +
      `Uncovered by this run; covered statically by verify-workspace-mcp-preparation.mjs.`
  );
  check(
    'the file carries no `unusable` key (weak: vacuous on a machine where every server is usable)',
    unusableSurvivors.length === 0,
    `these entries carry unusable on disk: ${unusableSurvivors.join(', ')}`
  );
} else {
  gate(
    '`unusable` was stripped before disk — a Butchr sentence never reached a config file',
    unusableSurvivors.length === 0,
    `raw assembly carried unusable on ${rawUnusable.join(', ')}; these survived onto disk: ` +
      `${unusableSurvivors.join(', ')}. No MCP client has a key by that name, and writing it puts ` +
      `a sentence of English where a reader could take it for a setting.`
  );
}

// The file as CrabCast wrote it, printed so the PR carries the artifact rather
// than only a verdict about it. This is the thing nobody had ever looked at.
console.log('\n   .mcp.json as CrabCast wrote it:');
console.log(
  JSON.stringify(written, null, 2)
    .split('\n')
    .map((l) => `   | ${l}`)
    .join('\n')
);

// Not asserted — measured, because it is a difference from the herdr path whose
// consequence is CrabCast's to state rather than ours to predict.
note('.claude/settings.local.json written', String(fs.existsSync(path.join(workDir, '.claude', 'settings.local.json'))));
note('workspace trusted in ~/.claude.json', `before=${JSON.stringify(trustBefore)} after=${JSON.stringify(trustedFor(workDir))}`);

// ── 5b. THE CONSEQUENCE, NOT THE FILE (KAN-417) ────────────────────────────
//
// §5 asserts a file this script's own `prepareWorkspaceMcpServers` call produced.
// That is worth having and it is not enough: **a correct `.mcp.json` that still
// yields a null parent would mean the stamp is right and something downstream is
// not**, which is KAN-145's defect exactly — a value written where nothing reads
// it. So this section asserts on two things NOTHING IN THIS SCRIPT WROTE.
rule('5b. the consequence — the stamp is READ, by the agent`s client and by the daemon');

// (a) THE CLIENT READ THE FILE AND STARTED THE SERVER FROM IT.
//
// `mcp.ts` derives `callerIdentity` from `process.argv` and says in so many
// words that it "can be read back out of /proc/<pid>/cmdline by anyone who
// doubts it". This is that read. A `.mcp.json` written correctly but never
// loaded — the wrong path, a parse failure, a client that ignored it — leaves no
// such process, and §5 could not tell the difference.
function butchrMcpProcessesFor(type, key) {
  const found = [];
  let scanned = 0;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // the process exited between readdir and read; ordinary
    }
    scanned++;
    const argv = cmdline.split('\0').filter(Boolean);
    if (!argv.some((a) => a.endsWith(`${path.sep}mcp.js`))) continue;
    const at = argv.indexOf(launchers.WORKSPACE_TYPE_FLAG);
    const kt = argv.indexOf(launchers.WORKSPACE_KEY_FLAG);
    found.push({
      pid: Number(entry),
      argv,
      type: at === -1 ? null : argv[at + 1],
      key: kt === -1 ? null : argv[kt + 1]
    });
  }
  return { found, scanned };
}

// THE POSITIVE CONTROL, and it is required rather than decorative: this scan
// answering "none" is the comfortable answer, and it is exactly what a broken
// scan returns too (KAN-388). Every Butchr agent on the herdr path carries this
// stamp, so a scan that cannot see THOSE cannot be trusted to have seen the
// probe's absence either.
const scan = await until(
  () => {
    const s = butchrMcpProcessesFor(TYPE, KEY);
    return s.found.some((p) => p.key === KEY) ? s : null;
  },
  120_000,
  5_000
) ?? butchrMcpProcessesFor(TYPE, KEY);

const otherStamped = scan.found.filter((p) => p.key && p.key !== KEY);
check(
  'the /proc scan can see stamped MCP servers at all (positive control for the gate below)',
  otherStamped.length > 0,
  `the scan read ${scan.scanned} /proc entries and found ${scan.found.length} mcp.js processes, ` +
    `none of them stamped with another workspace. Every herdr-path agent carries this stamp, so ` +
    `finding none means THE SCAN is not working and its answer about the probe is worth nothing.`
);
note(
  'other stamped MCP servers visible',
  otherStamped.map((p) => `${p.type}/${p.key}`).join(', ') || '(none — see the control above)'
);

const probeMcp = scan.found.find((p) => p.key === KEY);
gate(
  "the agent's own client started a `butchr` MCP server FROM the written file, identity intact",
  !!probeMcp && probeMcp.type === TYPE && probeMcp.key === KEY,
  probeMcp
    ? `a probe MCP server is running as ${probeMcp.type}/${probeMcp.key}, expected ${TYPE}/${KEY}`
    : `no mcp.js process carries ${launchers.WORKSPACE_KEY_FLAG} ${KEY}. The file may be correct ` +
      `and unread: a .mcp.json the client never loads leaves the stamp on disk and nowhere else, ` +
      `which is the KAN-145 shape (a value written where nothing reads it).`
);
if (probeMcp) note('probe MCP server', `pid ${probeMcp.pid}, argv ${JSON.stringify(probeMcp.argv.slice(-4))}`);

// (b) THE DAEMON READ IT TOO — the leg `activatedBy` actually rides on.
//
// `mcp.ts` announces `hello {workspaceType, workspaceKey}` from the SAME
// argv-derived `callerIdentity` that it stamps onto every request body, and says
// so: "the two cannot drift apart". `supervisorOfRecord` (router.ts) reads that
// request field and writes it down as the activated agent's supervisor. So an
// identified `hello` from this probe's address is the stamp arriving at the
// daemon through the exact path `activatedBy` is computed from.
//
// READ IN TEXT MODE, AND THAT IS NOT A DETAIL. Tools that sniff for binary
// content report ZERO MATCHES for lines in daemon.log that are present —
// measured while writing this section: `grep -F 'Client connected'` answered 0
// against 1,960 real occurrences, and the same search with `-a` answered 1,960.
// A silent zero from this file is the instrument's verdict on itself, not the
// daemon's on the fleet, and it fails toward "nothing happened". Reading the
// bytes here rather than shelling out sidesteps it entirely.
//
// THE CONCLUSION ABOVE IS UNCHANGED; THE REASON IT ORIGINALLY GAVE WAS WRONG,
// and it is corrected here rather than left, because a false reason in a
// comment does not stay in the comment. This block used to open "daemon.log
// carries raw pane bytes, so …". It does not carry them: across 36,271 lines
// there is not one ESC byte, not one CR and not one other C0 control character
// (KAN-422, measured with a positive control on the counter). What made the
// file binary was 2,074 NUL bytes in five runs, each immediately before a
// `PATH resolved to:` startup line — the tail of an appended file lost to an
// unclean shutdown, which ext4 delayed allocation reads back as zeros.
//
// The cost of the wrong reason is why this edit exists rather than a shrug:
// KAN-422 was filed on it as its stated premise, and `epic/KAN-39` carried it
// from there into KAN-348's standing rules as a fleet-wide claim before anyone
// measured it. Since KAN-422 the daemon repairs this damage at startup and
// cannot write such a byte itself (daemon/src/log-file.ts), so the zero should
// not recur — but reading bytes here is still right, and costs nothing.
let helloLine = null;
let helloSearched = 0;
if (daemonLogOffsetBefore !== null && fs.existsSync(daemonLogPath)) {
  helloLine = await until(
    () => {
      const size = fs.statSync(daemonLogPath).size;
      if (size <= daemonLogOffsetBefore) return null;
      const fd = fs.openSync(daemonLogPath, 'r');
      const buf = Buffer.alloc(size - daemonLogOffsetBefore);
      fs.readSync(fd, buf, 0, buf.length, daemonLogOffsetBefore);
      fs.closeSync(fd);
      const since = buf.toString('utf8');
      helloSearched = since.length;
      return (
        since
          .split('\n')
          .find((l) => l.includes('identified of') && l.includes(`${TYPE}/${KEY}`)) ?? null
      );
    },
    120_000,
    5_000
  );
}

gate(
  "the daemon recorded an identified `hello` from this probe — activatedBy's own source, live",
  !!helloLine,
  `no 'Connection … is ${TYPE}/${KEY} … identified of' line appeared in ${daemonLogPath} in the ` +
    `${helloSearched} bytes written since this run began. The MCP server sends that announcement ` +
    `from the same argv-derived identity it stamps onto every request, and supervisorOfRecord ` +
    `reads that stamp to fill activatedBy — so its absence means an agent this path spawned would ` +
    `be recorded with a null parent and be unaddressable for channel delivery.`
);
if (helloLine) note('daemon log', helloLine.trim());

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

// MEASURED VERSUS INHERITED, stated by the script rather than left to whoever
// pastes its output (KAN-417 item 4).
console.log('   measured by this run:');
console.log('     · the .mcp.json CrabCast wrote, from definitions this run prepared and sent (§5)');
console.log('     · that the agent`s own client read it and started a stamped MCP server (§5b a)');
console.log('     · that the daemon received an identified hello from that server (§5b b)');
console.log('   inherited, NOT measured here:');
console.log('     · that MessageRouter applies the preparation on a real activation — §2 reads');
console.log('       router.ts as TEXT, and a static read is not an execution. Nothing covers this');
console.log('       until the fleet is flipped; see the header.');
if (overrodeCapacity) {
  console.log('     · the ACTIVATION leg: --override was used, so `crabcast activate` started this');
  console.log('       agent and CrabCastRuntime.provision`s own activate_agent call did NOT run.');
  console.log('       configure_agent — where the MCP definitions cross the wire — was the');
  console.log('       runtime`s own on every path, so §5/§5b are unaffected.');
  console.log('   capacity refusal deliberately bypassed; the figures it bypassed:');
  console.log(`${String(bypassedFigures).split('\n').map((l) => `     | ${l}`).join('\n')}`);
}
console.log('');

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
