// Proof for KAN-630: a local instrument's answer covers ONE MACHINE, so it may
// not be phrased as a fact about the fleet — and an address this box has never
// held is refused rather than described.
//
// WHAT FAILURE THIS WOULD CATCH: `butchr_agent_status` answering
// `success: true, sessionless: true, herdrStatus: "unknown"` about an agent
// this daemon has never held — a well-formed row, indistinguishable on the wire
// from a real reading, for an agent that is alive on another machine. Observed
// on 2026-08-21: `story/KAN-609` read exactly that for `task/KAN-587`,
// `KAN-598` and `KAN-600`, concluded all three had stood down, and `epic/KAN-39`
// escalated a governance question to the guardian on it. All three were working
// throughout — `#273` was already MERGED at 21:27:25Z — and it was retracted one
// message short of the human, only because a merge timestamp was checked for an
// unrelated reason. The remedy that reading invites is destructive: the
// `missingAgents` tool description tells a supervisor to stand down or
// re-activate, and re-activation RESUMES A CONVERSATION.
//
// ⚠ THE ROW IS FABRICATED, AND ONLY UNDER THE RUNTIME THE FLEET ACTUALLY RUNS.
// `HerdrBridge.describeAgent` THROWS `No agent found for key '<key>'` for an
// address it does not know. `CrabCastRuntime.describeAgent` never throws: its
// census lookup is an optional `find`, so a miss returns
// `workDir: workspaceDirFor(type, key)` — a path it COMPUTED rather than found —
// and `herdrStatus: asHerdrStatus(undefined)`, which is `'unknown'`. §6 is the
// static assertion that this is still the shape of the real source.
//
// Six shapes, and §2 and §5 are the ones that keep the fix honest:
//
//   * the fabricated row for an address that was never here (§1);
//   * the fix over-applied — a refusal reaching an agent that IS on this box,
//     which would take a supervisor's own fleet away from it. Driven once per
//     witness, because any ONE of the three must be enough (§2);
//   * "the search could not run" collapsing into "this box does not hold it",
//     which is the same over-reach one level up (§3);
//   * the positive control deleted — `absent` returned by a probe that would
//     answer absent for every address on the board (§4);
//   * KAN-21's detectability half quietly disarmed: a REAL loss must still
//     read as `It is not running.` (§5);
//   * the scope statement absent from the fleet-shaped answers, or clippable
//     off them by the response budget (§7).
//
// §6 is static and asserts the two premises the dynamic sections rest on: that
// the real `CrabCastRuntime.describeAgent` still has the fabricating shape the
// stub reproduces, and that the refusal sentence is composed at exactly one
// site. Without it §1 would prove something about this file's own stub.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ── WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED ────────
//
// THE RUNTIME IS A STUB, AND IT IS THE LOAD-BEARING ONE. Sections 1-5 drive the
// real `MessageRouter` and the real `HerdrBridge` census reader, but
// `describeAgent` is overridden on a subclass to reproduce CrabCast's OBSERVED
// contract — never throw, computed workDir, `'unknown'` status. It is not
// CrabCast. Driving the real one is out of scope by the human's decision of
// 2026-08-21 recorded on KAN-657: `~/code/wroosbit/crabcast/dist/cli.js` shares
// an inode with the running binary, so a build there is a live deploy.
//
// WHAT THAT LEAVES UNCOVERED: that CrabCast's real `describeAgent` still
// behaves as the stub does at the commit this daemon is pinned to. §6 covers
// as much of it as source text can — it asserts the shape in
// `daemon/src/crabcast-runtime.ts`, which is OUR adapter and OUR source, not
// theirs — and what remains uncovered is the wire behaviour of their daemon.
// WHO COVERS IT: `daemon/scripts/verify-crabcast-runtime.mjs`, which drives a
// real CrabCast daemon and is not CI-runnable for that reason.
//
// The workspace tree is also supplied here: `HOME` is redirected to a temp
// directory so `workspacesRoot()` resolves inside it. That is what makes the
// positive control in §4 drivable at all — an empty tree is not a state this
// machine can be put into — and it means this file does not test that a real
// activation creates the directory it later looks for. WHO COVERS IT:
// `verify-workspace-reset-boundary.mjs` owns both ends of that directory.
//
// Usage: node daemon/scripts/verify-census-scope-states-its-population.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { workspacePresence, censusScope } = await import(path.join(distDir, 'census-scope.js'));
const { NEVER_CLIPPED_FIELDS, exemptionHolds } = await import(
  path.join(distDir, 'mcp-response-budget.js')
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan630-'));
const realPath = process.env.PATH;
const realHome = process.env.HOME;
let seq = 0;

/** The two sentences this ticket is about. Written once, compared everywhere. */
const DEATH_CLAIM = 'It is not running.';
const NOT_A_CLAIM = 'THAT IS NOT A CLAIM THAT IT IS NOT RUNNING.';

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(38)} ${value}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ PASS — ' + yes : '→ FAILED — ' + no}`);
};

// ------------------------------------------------------------- the harness --

// Redirect HOME so `workspacesRoot()` resolves inside TMP. Node's `os.homedir()`
// reads $HOME on POSIX and this daemon calls it per lookup rather than caching,
// so every producer under test follows. See the header for what this supplies.
process.env.HOME = TMP;
const wsRoot = path.join(TMP, '.local', 'share', 'butchr', 'workspaces');

/** Make `workspaces/<type>/<key>` exist, as an activation would. */
function makeWorkspace(type, key) {
  const dir = path.join(wsRoot, type, key.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove every workspace, so the positive control has nothing to find. */
function emptyTheTree() {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.mkdirSync(wsRoot, { recursive: true });
}

/**
 * An empty but PRESENT `workspaces/<type>/`.
 *
 * ⚠ NOT THE SAME STATE AS `emptyTheTree()`, and the difference is the whole of
 * §4. A missing directory lands in the UNREADABLE arm (ENOENT), so a proof that
 * only ever deletes the tree drives that arm twice and never once reaches the
 * `siblings === 0` branch the control actually gates. This file passed all
 * seven sections that way on its first run; the branch was untested and could
 * have been deleted with everything still green.
 */
function emptyTypeDir(type) {
  emptyTheTree();
  fs.mkdirSync(path.join(wsRoot, type), { recursive: true });
}

/**
 * Put a `herdr` on PATH whose census is exactly `rows`. A stub BINARY rather
 * than a stub census: the real HerdrBridge runs it and parses its output, so
 * `name` and `cwd` reach the router through the production reader.
 */
function stubHerdr(rows) {
  const bin = path.join(TMP, `bin-${++seq}`);
  fs.mkdirSync(bin, { recursive: true });
  const payload = JSON.stringify({
    id: 'cli:agent:list',
    result: {
      type: 'agent_list',
      agents: rows.map((r) => ({
        name: r.name,
        agent: 'claude',
        agent_status: 'working',
        ...(r.cwd === undefined ? {} : { cwd: r.cwd })
      }))
    }
  });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`, {
    mode: 0o755
  });
  process.env.PATH = `${bin}:${realPath}`;
}

/**
 * A runtime that describes an address it has never heard of, exactly as
 * `CrabCastRuntime.describeAgent` does. THE POPULATION UNDER TEST.
 *
 * Everything except `describeAgent` is the real HerdrBridge, so the census, the
 * statuses and the session map all reach the router through production code.
 * §6 asserts this override is still faithful to the real adapter's source.
 */
class FabricatingRuntime extends HerdrBridge {
  constructor() {
    super();
    // ASSIGNED, NOT OVERRIDDEN ON THE PROTOTYPE. `HerdrBridge` declares
    // `public readonly runtimeName = 'herdr'`, which is an OWN INSTANCE
    // property and therefore shadows any accessor a subclass puts on the
    // prototype. A `get runtimeName()` here reads `herdr` at every call site
    // and the stub silently stops reproducing the runtime it claims to — which
    // this file caught on its first run, by §1 printing `scope.runtime: herdr`.
    this.runtimeName = 'crabcast';
  }
  describeAgent(key, type) {
    const resolvedType = type ?? null;
    return {
      agentName: `butchr-${resolvedType ?? '?'}-${key.toLowerCase()}`,
      type: resolvedType,
      workDir: resolvedType ? path.join(wsRoot, resolvedType, key.toLowerCase()) : null,
      herdrStatus: 'unknown'
    };
  }
}

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(TMP, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration());
registry.setEnabled('jira', true);
const prompts = new PromptLoader(repoRoot);

/** A registry record as an activation writes one. Seeded — see the header. */
function record(type, key, workDir) {
  return {
    agentName: `butchr-${type}-${key.toLowerCase()}`,
    type,
    key,
    workDir,
    defaultAgent: 'claude',
    activatedBy: null
  };
}

/** Drive a real handler through a real router over a seeded registry. */
function drive(action, records = [], Runtime = FabricatingRuntime) {
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++seq}.jsonl`));
  for (const r of records) agentRegistry.recordActivated(r);

  let response;
  const router = new MessageRouter(
    registry,
    prompts,
    new Runtime(),
    (msg) => {
      response = msg;
    },
    () => {},
    { agentRegistry }
  );
  router.handle(action);
  return response;
}

const status = (key, type, records) =>
  drive({ action: 'agent_status', key, ...(type === undefined ? {} : { type }) }, records);

// ---------------------- 1. the observed case: an address that was never here --

rule('§1  AC1 — an address this box has never held is REFUSED, not described');

{
  // The tree is populated with other agents and NOT with this one — which is
  // precisely `epic/KAN-203`'s reading on the night: three absent directories
  // beside 424 present ones.
  emptyTheTree();
  for (const k of ['KAN-100', 'KAN-101', 'KAN-102']) makeWorkspace('task', k);
  stubHerdr([{ name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') }]);

  const res = status('KAN-587', 'task', []);

  row('success', res.success);
  row('refusedBy', res.refusedBy);
  row('sessionless present?', 'sessionless' in res);
  row('herdrStatus present?', 'herdrStatus' in res);
  row('scope.host', res.scope?.host);
  row('scope.runtime', res.scope?.runtime);
  row('carries the non-claim?', String(res.error ?? '').includes(NOT_A_CLAIM));
  row('names the control count?', /\b3 other 'task' workspaces\b/.test(String(res.error ?? '')));
  console.log(`\n  error: ${res.error}`);

  verdict(
    res.success === false &&
      res.refusedBy === 'not-on-this-box' &&
      !('sessionless' in res) &&
      !('herdrStatus' in res) &&
      String(res.error).includes(NOT_A_CLAIM) &&
      !String(res.error).includes(DEATH_CLAIM) &&
      res.scope?.from === 'this-box' &&
      res.scope?.runtime === 'crabcast',
    'the fabricated row is gone: no `sessionless`, no `herdrStatus`, the scope names the runtime actually serving, and the refusal says out loud that it is not a claim about whether the agent is running',
    'an address this box has never held still answers with a status a reader can complete as a death'
  );
}

// ------------------------------ 2. the over-application guard, once per witness --

rule('§2  AC3(first half) — an agent that IS on this box still answers. Any ONE witness suffices');

{
  const cases = [
    {
      name: 'census only (no registry record, no workspace directory)',
      setup: () => {
        emptyTheTree();
        for (const k of ['KAN-100']) makeWorkspace('task', k);
        stubHerdr([
          { name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') },
          { name: 'butchr-task-kan-777', cwd: path.join(wsRoot, 'task', 'kan-777') }
        ]);
      },
      records: []
    },
    {
      name: 'durable registry only (census silent, no workspace directory)',
      setup: () => {
        emptyTheTree();
        for (const k of ['KAN-100']) makeWorkspace('task', k);
        stubHerdr([{ name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') }]);
      },
      records: [record('task', 'KAN-777', path.join(wsRoot, 'task', 'kan-777'))]
    },
    {
      name: 'workspace directory only (census silent, registry empty)',
      setup: () => {
        emptyTheTree();
        for (const k of ['KAN-100', 'KAN-777']) makeWorkspace('task', k);
        stubHerdr([{ name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') }]);
      },
      records: []
    }
  ];

  let allAnswered = true;
  for (const c of cases) {
    c.setup();
    const res = status('KAN-777', 'task', c.records);
    const answered = res.success === true;
    if (!answered) allAnswered = false;
    row(c.name, answered ? 'answered' : `REFUSED (${res.refusedBy})`);
  }

  verdict(
    allAnswered,
    'each of the three witnesses independently keeps a local agent answerable — the refusal cannot take a supervisor its own fleet',
    'the refusal reaches an agent that IS on this box, which is the fix over-applied'
  );
}

// ------------------- 3. "could not establish" must not become "not here" --

rule('§3  AC1 — a search that could not run is its OWN refusal, never the off-box one');

{
  emptyTypeDir('task'); // READABLE, and holding nothing at all — not missing
  stubHerdr([]);

  const res = status('KAN-587', 'task', []);

  row('success', res.success);
  row('refusedBy', res.refusedBy);
  row('says "not on this box"?', res.refusedBy === 'not-on-this-box');
  console.log(`\n  error: ${res.error}`);

  verdict(
    res.success === false &&
      res.refusedBy === 'scope-undetermined' &&
      String(res.error).includes('could not be established') &&
      String(res.error).includes('would have answered "absent" for every address') &&
      !String(res.error).includes(DEATH_CLAIM),
    'an unanswerable question refuses as unanswerable and is not rounded to the confident answer',
    '"nothing was searched" and "this box does not hold it" have collapsed into one answer'
  );
}

// -------------------------------------- 4. the positive control itself --

rule('§4  AC3 — `absent` is UNREACHABLE from a probe that would answer absent for everybody');

{
  // Arm A: the type directory EXISTS and is empty. This is the branch the
  // control gates, and it is only reachable from a present directory.
  emptyTypeDir('task');
  const onEmpty = workspacePresence('task', 'KAN-587');
  row('empty-but-present tree → kind', onEmpty.kind);
  row('  because', onEmpty.because);

  // Arm B: the type directory is MISSING. A different way of not knowing, and
  // it must not be confused with arm A or with `absent`.
  emptyTheTree();
  const onMissing = workspacePresence('task', 'KAN-587');
  row('missing tree → kind', onMissing.kind);

  emptyTypeDir('task');

  for (const k of ['KAN-100', 'KAN-101']) makeWorkspace('task', k);
  const onPopulated = workspacePresence('task', 'KAN-587');
  row('populated tree → kind', onPopulated.kind);
  row('  siblings (the control)', onPopulated.siblings);

  const present = workspacePresence('task', 'KAN-100');
  row('the agent itself → kind', present.kind);

  // The unreadable arm, driven through the injected reader rather than by
  // chmod-ing a directory on the machine.
  const unreadable = workspacePresence('task', 'KAN-587', () => {
    throw new Error('EACCES: permission denied');
  });
  row('unreadable tree → kind', unreadable.kind);

  verdict(
    onEmpty.kind === 'cannot-tell' &&
      onEmpty.because.includes('would have answered "absent" for every address') &&
      onMissing.kind === 'cannot-tell' &&
      onPopulated.kind === 'absent' &&
      onPopulated.siblings === 2 &&
      present.kind === 'present' &&
      unreadable.kind === 'cannot-tell',
    'the control gates the arm: `absent` needs siblings counted in the same read, and an empty or unreadable tree cannot produce one',
    'a probe that finds nothing for anybody can still report an agent as absent — which has measured itself and not the world'
  );
}

// ------------------ 5. KAN-21's detectability half must survive this fix --

rule('§5  AC3(second half) — a REAL loss still reads as a loss. KAN-579 undisturbed');

{
  emptyTheTree();
  const workDir = makeWorkspace('task', 'KAN-300');
  makeWorkspace('task', 'KAN-100');
  // The registry says it is active; the census is reachable, whole, and holds
  // nothing in that directory under any name. That is the ONE state in which
  // `It is not running.` is earned.
  stubHerdr([{ name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') }]);

  const res = drive({ action: 'list_agents' }, [record('task', 'KAN-300', workDir)]);
  const missing = (res.missingAgents ?? []).find((r) => r.agentName === 'butchr-task-kan-300');

  row('row present?', Boolean(missing));
  row('occupiedBy', JSON.stringify(missing?.occupiedBy));
  row('still says the death claim?', String(missing?.reason ?? '').includes(DEATH_CLAIM));

  verdict(
    Boolean(missing) &&
      missing.occupiedBy === null &&
      String(missing.reason).includes(DEATH_CLAIM),
    'a genuine loss is still reported as one — the scope work did not disarm KAN-21`s detectability half',
    'the fix reached `missingAgents` and suppressed a real loss, which is worse than the defect it was fixing'
  );
}

// --------------------------------- 6. the static premises the above rest on --

rule('§6  the two premises: the adapter still fabricates, and the refusal has one author');

{
  const crabcast = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'crabcast-runtime.ts'), 'utf8');
  const herdr = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'herdr.ts'), 'utf8');
  const scopeSrc = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'census-scope.ts'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(repoRoot, 'daemon', 'src', 'router.ts'), 'utf8');

  // The fabricating shape: an optional `find` whose miss falls through to a
  // COMPUTED directory and a defaulted status, with no throw on the path.
  const describeBody = crabcast.slice(
    crabcast.indexOf('describeAgent(key: string, type?: string): HerdrAgentDescription {')
  );
  const fabricates =
    describeBody.includes('workDir: row?.workDir ?? row?.path ?? dir') &&
    describeBody.includes('herdrStatus: asHerdrStatus(row?.herdrStatus)');
  const herdrThrows = herdr.includes("throw new Error(`No agent found for key '${key}'`)");

  // One author for the sentence, on the `reasonForMissingAgent` rule.
  const offBoxAuthors = (scopeSrc.match(/THAT IS NOT A CLAIM THAT IT IS NOT RUNNING/g) ?? []).length;
  const routerWritesIt = routerSrc.includes('THAT IS NOT A CLAIM THAT IT IS NOT RUNNING');

  row('crabcast adapter fabricates?', fabricates);
  row('herdr bridge throws instead?', herdrThrows);
  row('refusal sentence sites', offBoxAuthors);
  row('router writes it by hand?', routerWritesIt);

  verdict(
    fabricates && herdrThrows && offBoxAuthors === 1 && !routerWritesIt,
    'the stub in this file is faithful to the adapter it reproduces, and the refusal is composed at exactly one site',
    'either the adapter no longer has the shape this file stubs — so §1 proves something about this stub — or a second author of the refusal has appeared'
  );
}

// ------------------------- 7. the scope on the fleet-shaped answers, unclippable --

rule('§7  AC2 — every fleet-shaped answer states its population, and a clip cannot take it');

{
  emptyTheTree();
  makeWorkspace('task', 'KAN-100');
  stubHerdr([{ name: 'butchr-task-kan-100', cwd: path.join(wsRoot, 'task', 'kan-100') }]);

  const list = drive({ action: 'list_agents' }, []);
  const cap = drive({ action: 'capacity' }, []);
  const scope = censusScope('crabcast', 'a-host');

  row('list_agents scope.from', list.scope?.from);
  row('capacity scope.from', cap.scope?.from);
  row('list scope names the root?', String(list.scope?.sentence ?? '').includes(wsRoot));
  row('scope is never-clipped?', 'scope' in NEVER_CLIPPED_FIELDS);
  row('exemption holds for a real one', exemptionHolds('scope', scope));
  row('measured chars', JSON.stringify(scope, null, 2).length);
  console.log(`\n  sentence: ${scope.sentence}`);

  verdict(
    list.scope?.from === 'this-box' &&
      cap.scope?.from === 'this-box' &&
      String(list.scope.sentence).includes(wsRoot) &&
      String(list.scope.sentence).includes('can see no other') &&
      'scope' in NEVER_CLIPPED_FIELDS &&
      exemptionHolds('scope', scope) === true,
    'both fleet-shaped answers carry the population they cover, and the response budget cannot drop it while keeping the counts',
    'a count survives a clip that its population statement does not — which is this ticket`s own defect, produced by the fitter'
  );
}

// ------------------------------------------------------------------ verdict --

process.env.PATH = realPath;
if (realHome === undefined) delete process.env.HOME;
else process.env.HOME = realHome;
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0 ? 'ALL SECTIONS PASS' : `${failures} SECTION(S) FAILED`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
