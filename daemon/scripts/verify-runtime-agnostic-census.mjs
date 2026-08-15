// Live proof for KAN-475: the Router's two liveness reads consult WHICHEVER
// runtime is serving, and the sentence they refuse with names that runtime.
//
// WHAT FAILURE THIS WOULD CATCH: a refusal that names a runtime it did not ask.
// `unintendedStart`'s reattach gate read `herdr has no live agent named X` as a
// string literal on every runtime, so under CrabCast it sent the reader after a
// runtime that was not in service — during a cutover, which is the moment that
// misattribution costs most. Section 3 is that defect, and it goes RED on the
// pre-fix build. It would ALSO catch the stronger defect the ticket alleged: if
// either read were pinned to `HerdrBridge` rather than to the injected runtime,
// sections 1 and 2 go red, because their CrabCast census is the only place the
// agent they look for exists.
//
// CI-RUNNABLE: yes — imports the built daemon modules, stands a fake CrabCast
// peer on a Unix socket in a scratch $HOME, and asserts in process. No live
// daemon, no real CrabCast, no herdr, no credential, no terminal.
//
// ---------------------------------------------------------------------------
// WHAT THIS TICKET TURNED OUT TO BE — read this before the sections
// ---------------------------------------------------------------------------
//
// KAN-475 was filed reporting that `hasLiveHerdrAgent` and
// `liveAgentAtKeyOfOtherType` "go straight to herdrBridge regardless of
// runtime", so that under CrabCast the panel could never reattach and the
// KAN-83 collision guard silently stopped guarding. **The reads were fine and
// the ticket was still worth filing.** `MessageRouter`'s third constructor
// parameter is typed `AgentRuntime` and `daemon.ts` builds it once, through
// `createAgentRuntime`, into a variable it happens to call `herdrBridge`. Under
// CrabCast that binding holds a `CrabCastRuntime`, whose `listHerdrAgents()`
// answers CrabCast's own census. Both reads were already runtime-agnostic.
//
// **What made a correct call site read as a broken one was the naming**: a
// field called `herdrBridge`, a method called `listHerdrAgents`, a predicate
// called `hasLiveHerdrAgent`, and a refusal sentence that said `herdr` out
// loud. The last of those is a real defect and the rest are why it was
// believed. So the ticket's diagnosis is refuted here BY MEASUREMENT rather
// than by argument — sections 1 and 2 put a live CrabCast-owned agent in front
// of each read — and its remedy is applied to the one thing that was actually
// wrong.
//
// ⚠ **THE FIXTURE IS THE LOAD-BEARING PART, AND THE OBVIOUS ONE IS STALE.**
// Both reads test `agent.agentRuntime !== null` for liveness. The only
// committed census with CrabCast-OWNED running rows before this ticket —
// `crabcast-owned-running-census.json`, read-path contract v6, captured
// 2026-08-12 — carries `agentRuntime: null` on both of its owned rows. Written
// against that fixture, sections 1 and 2 FAIL, and they fail in the direction
// that confirms the ticket. `crabcast-v8-owned-running-census.json` was
// captured off the live socket for this ticket, at contract v8, with three
// CrabCast-started agents running, and its owned rows carry
// `agentRuntime: "claude"`. **A reader re-pointing this script at the v6
// fixture will reproduce the ticket's claim and should not read that as having
// reproduced the defect** — it is one field, two contract versions apart. Which
// of the two describes a peer you are running is a question for the peer.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT BUILDS THE CENSUS IT THEN ASSERTS ON — and here is what that
// leaves uncovered, and who covers it
// ---------------------------------------------------------------------------
//
// The peer here is a fake: a socket that replays two captured frames. So this
// proves the Router reads whatever census the runtime hands it, and it does NOT
// prove a real CrabCast hands over a census of that shape. That second claim is
// the fixture's job, and the fixture is a verbatim capture off a live peer
// rather than a hand-written guess — its provenance block names the probe that
// took it. What no script here owns:
//
//   * **That a CURRENT peer still sends `agentRuntime` on an owned row.** The
//     capture is from one moment. Re-run `probe-crabcast-raw-frames.mjs` to ask
//     again; the v6-to-v8 difference above is exactly this going stale once.
//   * **That the panel's reattach button reaches `handleActivate` with
//     `reattachOnly: true`.** Asserted from the daemon side only. The extension
//     half is `verify-reattach-only.mjs`'s.
//   * **A real end-to-end reattach under CrabCast.** Nothing here spawns. §1
//     asserts the reattach GATE does not refuse; what happens after it is the
//     spawn path's, and under a fake peer that path is not exercised.
//
// Sections:
//   1. the reattach gate  — a live CrabCast-owned agent IS visible to it, and
//                           the empty-census arm proves the gate can still fire
//   2. THE DANGEROUS ONE  — runtime is CrabCast, collision exists, guard fires
//                           (the ticket's criterion 3, in its own words)
//   3. THE RED            — the refusal names the runtime it actually asked
//   4. no runtime is anonymous — both implementations name themselves, and the
//                           name agrees with what `createAgentRuntime` chose
//   5. the audit          — the runtime-sensitive sentences this ticket owns
//                           carry no hardcoded runtime, and the residue is named
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-runtime-agnostic-census.mjs [distDir]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

if (!fs.existsSync(path.join(distDir, 'router.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

let failures = 0;
let checks = 0;

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
}

// A private $HOME before any dist import: `workspacesRoot()` is
// `os.homedir()/.local/share/butchr/workspaces` and `os.homedir()` reads $HOME
// at call time, so every path this script derives — and every path the census
// reader maps back to an address — lands in the scratch tree rather than in the
// real one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan475-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

const { CrabCastLink } = await import(path.join(distDir, 'crabcast-link.js'));
const { CrabCastRuntime } = await import(path.join(distDir, 'crabcast-runtime.js'));
const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { createAgentRuntime } = await import(path.join(distDir, 'runtime-switch.js'));
const { workspacesRoot } = await import(path.join(distDir, 'workspace-dir.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(scriptDir, 'fixtures', 'crabcast-v8-owned-running-census.json'), 'utf8')
);

// -----------------------------------------------------------------------------
// The edits made to the captured data — both to `path`, both made here rather
// than in the file so the committed fixture stays a verbatim capture.
// -----------------------------------------------------------------------------
//
//   1. The absolute root is rebased onto this run's scratch `workspacesRoot()`,
//      which is what lets `addressForPath` map an owned row back to a
//      (type, key) address at all.
//
//   2. ⚠ **The KEY is replaced with a synthetic one, and this is a CORRECTNESS
//      requirement rather than tidiness.** The capture names real agents on the
//      machine it was taken from — `story/kan-419`, `epic/kan-203`,
//      `task/kan-473` — and those agents are *also* live in that machine's real
//      herdr. So a census keyed on them cannot distinguish "the Router read the
//      CrabCast census I injected" from "the Router read the machine's herdr and
//      found the same agent there": both answer yes, for the same name, for
//      unrelated reasons.
//
//      **This was not reasoned out — the red drive found it.** Pinning both
//      reads to `new HerdrBridge()` — the exact defect KAN-475 alleged — left
//      §1 and §2 GREEN, because `herdr agent list` on the developing machine
//      really did contain `butchr-story-kan-419`. Two of 34 checks moved. The
//      proof was measuring the machine it ran on.
//
//      A synthetic key closes it: no agent anywhere is at `KAN-990475`, so the
//      injected census is the only place it can come from, and the herdr-pinned
//      mutation now goes red on both sections. The ROW SHAPE is what the fixture
//      is for and it stays verbatim — which fields a v8 owned row carries, and
//      that `agentRuntime` is `"claude"` on it. Which ticket it happens to name
//      is not evidence about anything.
//
//      They are still spelled like Jira keys (`KAN-<n>`) because §1 and §2 drive
//      the real URL activation path, which resolves an issue key out of the URL
//      — a key shaped like `kan-475-probe-a` would not survive that, and the
//      sections would fail for a reason with nothing to do with the runtime.
const SYNTHETIC_KEYS = ['kan-990475', 'kan-990419', 'kan-990203'];

function rebasedRows(rows) {
  return rows.map((row, i) => {
    const rel = path.relative(FIXTURE.capturedWorkspacesRoot, row.path ?? row.workDir ?? '');
    const type = rel.split('/')[0];
    const dir = path.join(workspacesRoot(), type, SYNTHETIC_KEYS[i % SYNTHETIC_KEYS.length]);
    return {
      ...row,
      path: row.path == null ? row.path : dir,
      workDir: row.workDir == null ? row.workDir : dir
    };
  });
}

const cleanups = [];

/** A CrabCast that answers `daemon_status` and `list_agents` and nothing else. */
async function fakePeer(name, listFrame) {
  const socketPath = path.join(scratch, `${name}.sock`);
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const frame =
          req.action === 'daemon_status'
            ? FIXTURE.daemon_status
            : req.action === 'list_agents'
              ? listFrame
              : null;
        if (frame) socket.write(JSON.stringify({ ...frame, id: req.id }) + '\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(socketPath, r));
  cleanups.push(() => server.close());
  return socketPath;
}

/** A `CrabCastRuntime` against that peer, with one census landed. */
async function crabCastRuntimeWith(name, listFrame) {
  const socketPath = await fakePeer(name, listFrame);
  const link = new CrabCastLink({ socketPath, log: () => {} });
  const runtime = new CrabCastRuntime({ link, censusIntervalMs: 25, log: () => {} });
  cleanups.push(() => runtime.dispose());
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !runtime.listHerdrAgentsChecked().reachable) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return runtime;
}

/** The captured census, rebased — three CrabCast-OWNED running agents. */
function populatedCensus() {
  return {
    ...FIXTURE.list_agents,
    agents: rebasedRows(FIXTURE.list_agents.agents),
    foreignPanes: []
  };
}

/** The same frame with nothing in it: the discriminating arm. */
function emptyCensus() {
  return { ...FIXTURE.list_agents, agents: [], foreignPanes: [] };
}

function scratchRegistry() {
  const registry = new WorkspaceRegistry(
    new IntegrationStateStore(path.join(fs.mkdtempSync(path.join(scratch, 'state-')), 'i.json'))
  );
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
  registry.setEnabled('jira', true);
  return registry;
}

/** A real `MessageRouter` over the runtime it is handed. */
function routerOver(runtime, agentRegistry) {
  return new MessageRouter(
    scratchRegistry(),
    new PromptLoader(repoRoot),
    runtime,
    () => {},
    () => {},
    agentRegistry ? { agentRegistry } : {}
  );
}

/** Drive the real URL activation path and hand back the response. */
async function activateByUrl(router, url, extra = {}) {
  let response;
  await router.handleActivate(
    { action: 'activate', url, defaultAgent: 'claude', ...extra },
    (msg) => {
      response = msg;
    }
  );
  return response ?? {};
}

// The three agents the injected census holds, as addresses — read back off the
// rebased rows rather than retyped, so this list cannot drift from what the
// peer will actually serve.
const OWNED = rebasedRows(FIXTURE.list_agents.agents).map((row) => {
  const rel = path.relative(workspacesRoot(), row.path ?? row.workDir);
  const [type, key] = rel.split(path.sep);
  return { type, key, name: agentNameFor(type, key) };
});

console.log(`fixture: contract v${FIXTURE.daemon_status.contractVersion}, captured ${FIXTURE.capturedAt}`);
console.log(`owned rows: ${OWNED.map((a) => `${a.type}/${a.key}`).join(', ')}`);
console.log(`owned agentRuntime: ${FIXTURE.list_agents.agents.map((r) => JSON.stringify(r.agentRuntime)).join(', ')}`);

// =============================================================================
section('1. THE REATTACH GATE — a live CrabCast-owned agent is visible to it');
// The ticket's first predicted failure: "asks a runtime that is not running the
// agents -> refuses every reattach, loudly".
//
// ⚠ **The predicate is exercised DIRECTLY here, and the reason is worth
// reading, because the obvious way to test it does not test it.** Driving the
// URL activation path with a populated CrabCast census does NOT reach the gate
// at all: `handleActivate` calls `unintendedStart` only `if (!session)`, and
// under `CrabCastRuntime` a running owned row already has a session rebuilt for
// it by the restart repair (KAN-346). So the path-level assertion passes
// whether `hasLiveAgent` works or not — it is vacuous, and it was written that
// way here first. The herdr-pinned red drive is what exposed it: §1 stayed
// green under the very defect it was written to catch.
//
// So §1 now asserts on both, separately, and says which is which:
//   (a) the predicate itself, called on the router — the discriminating check;
//   (b) the path, with its own reason recorded rather than left to look like
//       evidence for (a).
//
// `hasLiveAgent` is `private` in TypeScript, which is erased — there is no such
// thing at run time, and a proof importing from `dist` calls it like any other
// method. That is a deliberate reach past the public surface, so it is named.
{
  const live = await crabCastRuntimeWith('populated', populatedCensus());
  const target = OWNED[0];
  const url = `https://wroosbit.atlassian.net/browse/${target.key.toUpperCase()}`;

  const seen = live.listHerdrAgents();
  check(
    seen.some((a) => a.name === target.name && a.agentRuntime !== null),
    `the CrabCast census carries ${target.name} as live`,
    `names seen: ${seen.map((a) => `${a.name}(${JSON.stringify(a.agentRuntime)})`).join(', ') || '<none>'}`
  );

  // (a) THE DISCRIMINATING CHECK. Nothing outside this process has heard of
  // this agent name, so a `true` here can only have come from the census the
  // fake peer served — which is the whole claim.
  const liveRouter = routerOver(live);
  check(
    liveRouter.hasLiveAgent(target.name) === true,
    `hasLiveAgent(${target.name}) is TRUE under CrabCast — the read is not pinned to herdr`,
    `got ${JSON.stringify(liveRouter.hasLiveAgent(target.name))}`
  );

  const bare = await crabCastRuntimeWith('empty', emptyCensus());
  const bareRouter = routerOver(bare);
  check(
    bareRouter.hasLiveAgent(target.name) === false,
    'and FALSE against an empty census — so the predicate reads the census rather than always answering yes',
    `got ${JSON.stringify(bareRouter.hasLiveAgent(target.name))}`
  );

  // (b) THE PATH, with its reason stated. The gate is not reached for a running
  // owned agent, and that is a SECOND independent reason the ticket's predicted
  // "refuses every reattach" does not happen — recorded here so that a reader
  // does not mistake this pass for evidence about the predicate above.
  check(
    Boolean(live.getSessionByAddress(target.key, target.type)),
    'the runtime already holds a session for the running owned agent (KAN-346 restart repair)',
    'so `unintendedStart` is never called on this path — see the note above'
  );
  const allowed = await activateByUrl(liveRouter, url, { reattachOnly: true });
  check(
    allowed.refusedBy !== 'reattach-only',
    'and the real URL activation does not refuse reattach for it',
    `refusedBy=${JSON.stringify(allowed.refusedBy)} error=${JSON.stringify(allowed.error)}`
  );

  // The positive control on the gate itself. Without it, "not refused" is a
  // claim about a gate that might never refuse anything — a check with no
  // failing branch the world can reach is not a weak check, it is one that does
  // not exist while appearing to.
  const refused = await activateByUrl(bareRouter, url, { reattachOnly: true });
  check(
    refused.refusedBy === 'reattach-only',
    'and the SAME call IS refused when the census is empty — the gate still fires',
    `refusedBy=${JSON.stringify(refused.refusedBy)}`
  );
}

// =============================================================================
section('2. THE DANGEROUS ONE — runtime is CrabCast, collision exists, guard fires');
// The ticket's criterion 3, in its own words. This is the read whose failure
// would have been SILENT: a guard that finds no sibling because it looked in
// the wrong runtime's list reports "no collision" in the same words as a guard
// that looked in the right one. KAN-473's bare-key refusal (#210) depends on
// the collision being found, so that failure would take its protection too.
{
  const live = await crabCastRuntimeWith('collision', populatedCensus());
  // A CrabCast-owned agent live at some key under a type OTHER than `task`;
  // the fixture's story/epic rows are exactly that population.
  const sibling = OWNED.find((a) => a.type !== 'task');
  check(Boolean(sibling), 'the fixture holds a live non-task agent to collide with');

  const registryPath = path.join(scratch, 'agents-collision.jsonl');
  const agentRegistry = new AgentRegistry(registryPath);
  const victim = agentNameFor('task', sibling.key);
  // Arm 2 of `unintendedStart` fires only for an address recorded stood-down,
  // so the collision has to be with an agent somebody switched off on purpose.
  const victimRecord = {
    agentName: victim,
    type: 'task',
    key: sibling.key,
    workDir: path.join(workspacesRoot(), 'task', sibling.key)
  };
  agentRegistry.recordActivated(victimRecord);
  agentRegistry.recordDeactivated(victimRecord);

  const url = `https://wroosbit.atlassian.net/browse/${sibling.key.toUpperCase()}`;
  const guarded = await activateByUrl(routerOver(live, agentRegistry), url);
  check(
    guarded.refusedBy === 'stood-down-collision',
    `the guard FIRES under CrabCast: task/${sibling.key} refused against live ${sibling.name}`,
    `refusedBy=${JSON.stringify(guarded.refusedBy)} error=${JSON.stringify(guarded.error)}`
  );
  check(
    typeof guarded.error === 'string' && guarded.error.includes(sibling.name),
    'and it names the sibling it found, rather than refusing anonymously',
    `error=${JSON.stringify(guarded.error)}`
  );

  // The discriminating arm again: same registry, same stand-down, empty census.
  // Nothing to collide with, so nothing to refuse.
  const bare = await crabCastRuntimeWith('collision-empty', emptyCensus());
  const registry2 = new AgentRegistry(registryPath);
  const unguarded = await activateByUrl(routerOver(bare, registry2), url);
  check(
    unguarded.refusedBy !== 'stood-down-collision',
    'and with no live sibling in the census it does NOT refuse — the guard reads the census, not the registry alone',
    `refusedBy=${JSON.stringify(unguarded.refusedBy)}`
  );
}

// =============================================================================
section('3. THE RED — the refusal names the runtime it actually asked');
// This is the defect. On the pre-fix build both arms below say `herdr`, so the
// CrabCast arm fails and the herdr arm passes — which is precisely why the
// defect survived: the runtime everybody develops against is the one the
// literal happened to be right about.
{
  const bare = await crabCastRuntimeWith('naming', emptyCensus());
  const refusal = await activateByUrl(
    routerOver(bare),
    'https://wroosbit.atlassian.net/browse/KAN-9999',
    { reattachOnly: true }
  );
  const text = String(refusal.error ?? '');
  check(refusal.refusedBy === 'reattach-only', 'the reattach gate refused, so there is a sentence to read');
  check(
    text.includes('crabcast'),
    'under CrabCast the refusal names crabcast',
    `error=${JSON.stringify(text)}`
  );
  check(
    !/\bherdr\b/.test(text),
    'and it does NOT name herdr, which was not asked',
    `error=${JSON.stringify(text)}`
  );

  // The other direction, so this is a proof about naming the runtime rather
  // than a proof that the word `herdr` was deleted.
  const herdr = new HerdrBridge();
  const underHerdr = await activateByUrl(
    routerOver(herdr),
    'https://wroosbit.atlassian.net/browse/KAN-9999',
    { reattachOnly: true }
  );
  const herdrText = String(underHerdr.error ?? '');
  check(
    underHerdr.refusedBy === 'reattach-only' && /\bherdr\b/.test(herdrText),
    'under HerdrBridge the same refusal still names herdr',
    `error=${JSON.stringify(herdrText)}`
  );
}

// =============================================================================
section('4. NO RUNTIME IS ANONYMOUS — and the name agrees with the switch');
// `runtimeName` is on the interface so that a sentence naming a runtime cannot
// be written without asking one. This section is the reason it is read off the
// runtime rather than off `RuntimeSwitchReport`: the report is a second value
// describing the same decision, and two values can disagree. These cannot.
{
  check(new HerdrBridge().runtimeName === 'herdr', 'HerdrBridge names itself herdr');

  const crab = await crabCastRuntimeWith('naming-self', emptyCensus());
  check(crab.runtimeName === 'crabcast', 'CrabCastRuntime names itself crabcast');

  for (const [raw, expected] of [
    [undefined, 'herdr'],
    ['herdr', 'herdr'],
    ['crabcast', 'crabcast'],
    ['crabcst', 'herdr'] // an unreadable setting falls back, and says so
  ]) {
    const env = { ...process.env };
    if (raw === undefined) delete env.BUTCHR_AGENT_RUNTIME;
    else env.BUTCHR_AGENT_RUNTIME = raw;
    const { runtime, report } = createAgentRuntime({ env, log: () => {} });
    check(
      runtime.runtimeName === expected && report.mode === expected,
      `BUTCHR_AGENT_RUNTIME=${JSON.stringify(raw)} -> runtime and report both say ${expected}`,
      `runtimeName=${runtime.runtimeName} report.mode=${report.mode}`
    );
    runtime.dispose?.();
  }
}

// =============================================================================
section('5. THE AUDIT — the runtime-sensitive sentences carry no hardcoded name');
// Ticket criterion 4: "Check for OTHER direct herdrBridge reads on
// runtime-sensitive paths. I found two by following one screenshot. I did NOT
// audit the file — treat my list as a starting point, not a census."
//
// This is the census, and it is a source sweep rather than a behavioural one:
// each site below is a sentence that reaches an agent or an operator from a
// path that runs under EITHER runtime, and each must now derive the name.
{
  const src = (f) => fs.readFileSync(path.join(scriptDir, '..', 'src', f), 'utf8');

  // Sentences this ticket converted. A literal returning to any of them is what
  // this assertion catches; it is deliberately a check on the SENTENCE and not
  // on a grep of the file, because `herdr` appears legitimately all over these
  // modules as a type name, an import and a comment.
  const converted = [
    ['router.ts', 'Nothing to re-attach to: ${this.herdrBridge.runtimeName} has no live agent'],
    ['router.ts', '${this.herdrBridge.runtimeName} refused the send:'],
    ['router.ts', '${this.herdrBridge.runtimeName} could not reach a pane for'],
    ['router.ts', "${this.herdrBridge.runtimeName} accepted the keystrokes for the recipient's pane"],
    ['router.ts', '${this.herdrBridge.runtimeName} resolved a live pane for this address'],
    ['nudge.ts', '${herdrBridge.runtimeName} refused the send'],
    ['nudge.ts', '${asked} has no agent by that name'],
    ['reconcile.ts', '${herdrBridge.runtimeName} did not become reachable within'],
    ['daemon.ts', '${herdrBridge.runtimeName} has no such agent']
  ];
  for (const [file, needle] of converted) {
    check(src(file).includes(needle), `${file}: names the runtime — ${needle.slice(0, 52)}…`);
  }

  // And the pre-fix literals must be gone from those same sentences.
  const retired = [
    ['router.ts', 'herdr has no live agent named'],
    ['router.ts', 'herdr refused the send:'],
    ['router.ts', 'herdr could not reach a pane for'],
    ['nudge.ts', "'herdr refused the send'"],
    ['nudge.ts', 'herdr has no agent by that name'],
    ['reconcile.ts', 'herdr did not become reachable within'],
    ['daemon.ts', 'but herdr has no such agent']
  ];
  for (const [file, needle] of retired) {
    check(!src(file).includes(needle), `${file}: the literal is gone — "${needle}"`);
  }

  // The seam itself: both reads still go through the injected runtime rather
  // than constructing one. A `new HerdrBridge()` inside router.ts is the shape
  // of the defect the ticket alleged, and it would pass a typecheck.
  check(
    !/new HerdrBridge\(/.test(src('router.ts')),
    'router.ts constructs no runtime of its own — it uses the one it was handed'
  );
}

// ---------------------------------------------------------------------------
// THE RESIDUE — named, because "the audit passed" would otherwise read as
// "every `herdr` in the daemon is now correct", which is false.
// ---------------------------------------------------------------------------
console.log(`
RESIDUE — deliberately NOT changed by KAN-475, each with the reason:

  * mcp.ts tool descriptions ("herdr's agent list", "herdr's own view of what
    the agent is doing", "from herdr's view of what exists"). Agent-facing and
    genuinely misleading under CrabCast, but they are multi-kilobyte prose
    blocks and rewriting them is a change no section here would cover — a tool
    description is not reachable from any of them. COVERED BY KAN-484, filed
    rather than done silently.
  * capacity.ts HERDR_OVERHEAD_CORES and its two sentences. This is a claim
    about herdr-the-process's core overhead. Under CrabCast the capacity model
    is arguably wrong, which is a modelling question and not a naming one.
  * herdr-health.ts / router.ts fd-limit reporting ("herdr server is using N%
    of its open-file soft limit"). Honestly about herdr: it inspects herdr's
    own process. Under CrabCast the check is inapplicable, not misnamed.
  * crabcast-runtime.ts's own mentions of herdr. Correct as written — they name
    herdr as the OTHER runtime, which is what they mean.

The distinction drawn throughout: a sentence that names the runtime it just
asked was converted; a sentence that names herdr because it means herdr was
left alone.`);

// =============================================================================
for (const c of cleanups) {
  try {
    c();
  } catch {}
}
try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch {}

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
