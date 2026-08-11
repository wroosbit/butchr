// Proof for KAN-222: the Agents page's Off and On controls say what the board
// will actually do to the agent, in every mode, and say nothing when there is
// no board.
//
// WHAT FAILURE THIS WOULD CATCH: the Off button telling a user that stopping an
// agent is permanent while a converging board reconciler restarts it a minute
// later — or the mirror image, the page announcing "the board controls this
// now" on a stock machine, where the reconciler ships report-only and the board
// controls nothing. Both are the same defect: a control whose sentence claims
// more than its mechanism covers.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Sections:
//
//   1. the field arrives      — a real router answers list_agents with a real
//                               boardControl block, from the real reconciler's
//                               jurisdiction rule
//   2. three modes            — off / report / converge each reach the payload
//   3. jurisdiction           — a confluence agent is outside it *in converge*,
//                               which is the case a blanket message gets wrong
//   4. the sentences          — the real extension function, against the real
//                               payload, produces the right claim in each case
//   5. no reconciler, silence — a router without the reporter omits the field
//                               and the UI says nothing at all
//   6. the claim is true      — the reconciler really does restart an agent
//                               that was switched off while its ticket is In
//                               Progress, which is what section 4 promises
//   7. over the socket        — a real `node dist/daemon.js` carries the field,
//                               and the keys in it are spelled the way Jira
//                               spells them (KAN-225)
//
// WHERE THIS PROOF STOPS, AND WHO COVERS IT
//
// **Sections 1-6 construct the fleet they then assert on.** The agent registry
// records are written by this script, so those sections do not test that a real
// activation produces an agent the reporter can see. What they *do* test for
// real is the part this ticket turns on: the `boardControl` block is computed
// by the shipped `boardControlReport` from the shipped `inJurisdiction`, and
// the sentences come from the shipped `describeBoardControl` — none of the
// three is reimplemented here, and the payload is taken from a real
// `MessageRouter.handle({action:'list_agents'})` rather than hand-written.
//
// **Sections 1-6 also register every agent they run**, which is a second and
// narrower limit, found the hard way (KAN-225): with a registry record for
// everything, the spelling correction those sections exercise is one that could
// never have been missing. The agent that broke this was the one with *no*
// record. Section 7 is where that agent exists, so the spelling is asserted
// there — on a machine with a live fleet. See the note it prints when it has
// nothing to bite on, and verify-board-key-spelling.mjs for the same rule
// against a fleet that can be guaranteed.
//
// **Section 7 is what closes the KAN-145 hole**, and it is the reason this
// script boots a daemon at all. Sections 1-6 construct their own router, so all
// six could be green while `daemon.ts` never passed `reportBoardControl` to
// `MessageRouter` — the field would be absent in production, every control
// would silently revert to its pre-KAN-222 wording, and nothing here would
// notice. That is exactly KAN-145's shape: two honest halves with an untested
// seam between them. Section 7 asks the real daemon over its real socket.
//
// **What no section covers: Chrome.** Whether a browser has loaded a new
// extension build cannot be observed or triggered from the daemon side —
// `butchr_staleness_check` says so itself. The rendered proof of what a human
// sees is extension/scripts/render-board-control-notes.mjs, run against
// `--dump` output from this script; the fact that the bundle in the browser is
// this bundle is a human pressing Reload, and it is stated in the PR rather
// than asserted here.
//
// Usage: node daemon/scripts/verify-off-button-honesty.mjs [distDir] [--dump <dir>]
// Run it after `npm run build` in daemon/.
//
//   --dump <dir>  write the real list_agents payloads (one per mode, plus a
//                 no-reconciler one) to <dir>, for
//                 extension/scripts/render-board-control-notes.mjs to render.

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '..', '..');
const argv = process.argv.slice(2);
const dumpIdx = argv.indexOf('--dump');
const dumpDir = dumpIdx === -1 ? null : argv[dumpIdx + 1];
// `dumpIdx === -1` has to be handled explicitly, and the bug it caused is worth
// a line (KAN-225). With no `--dump`, `dumpIdx + 1` is 0, so the old filter
// excluded index 0 — **the distDir argument** — and silently fell back to the
// default `dist`. Aiming this script at a deliberately broken build to watch a
// check go red therefore ran it against the *working* build and printed PASS: a
// proof that quietly substitutes its own input for the one it was given. Found
// by trying to make §7's new spelling check fail and being unable to.
const positional = argv.filter(
  (a, i) => i !== dumpIdx && (dumpIdx === -1 || i !== dumpIdx + 1) && !a.startsWith('--')
);
const distDir = positional[0] ?? path.join(daemonDir, 'dist');

if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`${distDir}/daemon.js is missing — run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { boardControlReport } = await import(path.join(distDir, 'board-control.js'));
const { BoardReconciler, boardWorkspaceTypes } = await import(
  path.join(distDir, 'board-reconcile.js')
);
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

// The extension's own function, imported rather than reimplemented. It is plain
// ESM with no JSX, so node loads it directly — which is the point: the words
// asserted below are the words the page renders, not a copy of them that could
// drift while this script stayed green.
const { describeBoardControl } = await import(
  pathToFileURL(path.join(repoRoot, 'extension', 'src', 'lib', 'boardControl.js')).href
);

let failures = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan222-'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
function check(ok, label, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
  return ok;
}

// --- a fleet, and a router that reports on it -------------------------------

const scratchState = () =>
  new IntegrationStateStore(path.join(fs.mkdtempSync(path.join(TMP, 'state-')), 'integrations.json'));

/**
 * A herdr stub whose census is whatever we say it is.
 *
 * The shape is verify-agent-power-controls.mjs's `stubHerdr`, narrowed to what
 * `list_agents` touches: this script never spawns or closes a pane, it asks
 * what the census reports about panes that exist. Section 6 is the only one
 * that moves an agent, and it moves it through the reconciler's own
 * activate/deactivate callbacks rather than through herdr.
 */
function herdrStub(names, workDirs) {
  const alive = [...names];
  const bridge = {
    alive,
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: workDirs[name],
        herdrStatus: 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    listHerdrStatuses: () => new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    abandonSession: () => {},
    terminateSession: () => ({ success: true })
  };
  return bridge;
}

/**
 * A router built the way daemon.ts builds one.
 *
 * `mode` is a function rather than a value so the reporter reads it per call,
 * which is the behaviour daemon.ts relies on: the Agents page must show a mode
 * change without a daemon restart. Passing `null` for it omits the reporter
 * entirely and produces the pre-KAN-222 daemon that section 5 is about.
 */
function makeRouter({ running, standby = [], mode }) {
  const registry = new WorkspaceRegistry();
  registry.registerIntegration(
    createAtlassianIntegration({
      issueTypeLookup: async () => null,
      credential: { status: () => ({ configured: false }) },
      state: scratchState()
    })
  );
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const agentRegistry = new AgentRegistry(path.join(home, 'agents.jsonl'));

  const workDirs = {};
  for (const agent of [...running, ...standby]) {
    workDirs[agent.agentName] = path.join(home, agent.agentName);
  }
  const bridge = herdrStub(running.map((a) => a.agentName), workDirs);

  const recordOf = (agent) => ({
    agentName: agent.agentName,
    type: agent.type,
    key: agent.key,
    workDir: workDirs[agent.agentName],
    url: null,
    defaultAgent: 'claude',
    activatedBy: null
  });
  for (const agent of [...running, ...standby]) {
    fs.mkdirSync(workDirs[agent.agentName], { recursive: true });
    agentRegistry.recordActivated(recordOf(agent));
  }
  // A full record, not a name: `recordDeactivated` takes the same shape its
  // sibling does, and passing a bare string produces an entry that reduces to
  // nothing — the agent then shows up as *missing* rather than stood down,
  // which is a different list with a different button on it.
  for (const agent of standby) agentRegistry.recordDeactivated(recordOf(agent));

  let last = null;
  const router = new MessageRouter(
    registry,
    new PromptLoader(repoRoot),
    bridge,
    (msg) => { last = msg; },
    () => {},
    // KAN-226 replaced the positional tail with this object. The slot-counting
    // comment that used to live here — "9 launchdarkly, 10 capacitySource, 11
    // boardControl", written because #89 and #90 both tried to take slot 10 on
    // the same day — has nothing left to describe.
    {
      agentRegistry,
      boardControl: mode ? (agents) => boardControlReport(mode(), agents) : undefined
    }
  );
  return { router, bridge, agentRegistry, list: () => { router.handle({ action: 'list_agents' }); return last; } };
}

/** The fleet every section below reads, chosen to cover both sides of the line. */
const FLEET = [
  { agentName: 'butchr-task-kan-222', type: 'task', key: 'KAN-222' },
  { agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' },
  // Outside the loop's jurisdiction: a Jira issue search can never return it,
  // whatever mode the reconciler is in. This is the agent a blanket "the board
  // controls this now" message would lie about.
  { agentName: 'butchr-confluence-notes', type: 'confluence', key: 'NOTES' }
];
const STANDBY = [{ agentName: 'butchr-task-kan-217', type: 'task', key: 'KAN-217' }];

// =============================================================================
rule('1. THE FIELD ARRIVES — a real list_agents carries a real boardControl');
// =============================================================================

const converge = makeRouter({ running: FLEET, standby: STANDBY, mode: () => 'converge' });
const convergePayload = await converge.list();

check(
  convergePayload?.action === 'list_agents_response',
  'the router answered list_agents',
  `got ${convergePayload?.action}`
);
const bc = convergePayload.boardControl;
check(!!bc, 'the payload carries a boardControl block');
check(bc?.mode === 'converge', `mode is reported as converge`, `got ${bc?.mode}`);
check(
  Number.isFinite(bc?.cycleSeconds) && bc.cycleSeconds > 0,
  `cycleSeconds is a real interval (${bc?.cycleSeconds}s)`
);

// The jurisdiction list is the reconciler's own, not a copy: this asserts the
// two agree rather than asserting a hard-coded set, so adding a Bug workspace
// type cannot make this section wrong while the product is right.
const types = [...boardWorkspaceTypes()].sort();
check(
  JSON.stringify([...(bc?.jurisdictionTypes ?? [])].sort()) === JSON.stringify(types),
  `jurisdictionTypes matches the reconciler's own set (${types.join(', ')})`,
  `payload said ${JSON.stringify(bc?.jurisdictionTypes)}`
);

check(
  'butchr-task-kan-222' in (bc?.controlled ?? {}),
  'a task agent with a Jira-shaped key is reported controlled'
);
check(
  'butchr-epic-kan-39' in (bc?.controlled ?? {}),
  'a supervisor is reported controlled — supervisors are not exempt (KAN-221)'
);
check(
  !('butchr-confluence-notes' in (bc?.controlled ?? {})),
  'a confluence agent is NOT reported controlled'
);
check(
  'butchr-task-kan-217' in (bc?.controlled ?? {}),
  'a stood-down agent is covered too — the On button needs the same answer'
);
// The spelling, not just the membership. A running agent's key comes out of a
// pane name lower-cased, and the note built from it tells somebody which
// ticket to move — `kan-222` names nothing on the board. The rendered proof
// caught this before this check existed; the check is here so it stays caught.
check(
  bc?.controlled?.['butchr-task-kan-222'] === 'KAN-222',
  'and it carries the key as Jira spells it, not as the pane name does',
  `got ${JSON.stringify(bc?.controlled?.['butchr-task-kan-222'])}`
);
// Named explicitly, because the reporter is fed four lists and a bug that
// dropped one of them would still leave `controlled` looking populated.
check(
  (convergePayload.standbyAgents ?? []).some((a) => a.agentName === 'butchr-task-kan-217'),
  'and it really is on the stood-down list, not merely somewhere in the payload',
  `standbyAgents: ${JSON.stringify((convergePayload.standbyAgents ?? []).map((a) => a.agentName))}`
);

// =============================================================================
rule('2. THREE MODES — each one reaches the page intact');
// =============================================================================

let liveMode = 'report';
const switching = makeRouter({ running: FLEET, mode: () => liveMode });
for (const mode of ['off', 'report', 'converge']) {
  liveMode = mode;
  const payload = await switching.list();
  check(
    payload.boardControl?.mode === mode,
    `mode ${mode} is reported as ${mode}`,
    `got ${payload.boardControl?.mode}`
  );
}
// Read per poll rather than captured at construction — a machine switched
// between polls must stop being described the old way on the next one.
liveMode = 'report';
check(
  (await switching.list()).boardControl?.mode === 'report',
  'a mode change between polls is picked up without a restart'
);

// =============================================================================
rule('3. JURISDICTION IN CONVERGE — the case a blanket message gets wrong');
// =============================================================================

const controlledSet = new Set(Object.keys(convergePayload.boardControl.controlled));
for (const agent of FLEET) {
  const inside = controlledSet.has(agent.agentName);
  const expected = agent.type !== 'confluence';
  check(
    inside === expected,
    `${agent.type}/${agent.key} is ${expected ? 'inside' : 'outside'} jurisdiction`,
    `payload said ${inside ? 'inside' : 'outside'}`
  );
}

// =============================================================================
rule('4. THE SENTENCES — the real UI function, against the real payload');
// =============================================================================

const agentOf = (name) => [...FLEET, ...STANDBY].find((a) => a.agentName === name);

function describeIn(mode, agentName) {
  const router = makeRouter({ running: FLEET, standby: STANDBY, mode: () => mode });
  const payload = router.list();
  return describeBoardControl(payload.boardControl, agentOf(agentName));
}

const convergeTask = describeIn('converge', 'butchr-task-kan-222');
check(convergeTask?.reversible === true, 'converge + controlled → the board will undo Off');
check(
  /will not keep it stopped/i.test(convergeTask?.offNote?.lead ?? ''),
  'the Off note leads with the fact that stopping does not stick',
  `lead was: ${convergeTask?.offNote?.lead}`
);
check(
  (convergeTask?.offNote?.action ?? '').includes('KAN-222'),
  'the Off note names the ticket the user must move, spelled as the board spells it',
  `action was: ${convergeTask?.offNote?.action}`
);
check(
  !/kan-222/.test(convergeTask?.offNote?.action ?? ''),
  'and never in the lower-cased pane spelling, which names no ticket'
);
check(
  /assigned to this machine's Jira account/.test(convergeTask?.offNote?.body ?? ''),
  'the Off note names the assignee half of the condition, not just the status half'
);
check(
  /will not keep it started/i.test(convergeTask?.onNote?.lead ?? ''),
  'the On note is the mirror image, and present',
  `lead was: ${convergeTask?.onNote?.lead}`
);

for (const mode of ['report', 'off']) {
  const d = describeIn(mode, 'butchr-task-kan-222');
  check(d?.reversible === false, `${mode} → the board will not undo Off`);
  check(
    /Off will stick/i.test(d?.offNote?.lead ?? ''),
    `${mode} → the Off note says Off will stick`,
    `lead was: ${d?.offNote?.lead}`
  );
  check(d?.onNote === null, `${mode} → the On note is silent, because On is already true`);
}

// The one a blanket sentence gets wrong: converging machine, agent the board
// can never describe.
const outside = describeIn('converge', 'butchr-confluence-notes');
check(outside?.reversible === false, 'converge + outside jurisdiction → Off still sticks');
check(
  /Off will stick/i.test(outside?.offNote?.lead ?? '') &&
    /never return it/i.test(outside?.offNote?.body ?? ''),
  'and it says why: a Jira issue search can never return that agent',
  `note was: ${JSON.stringify(outside?.offNote)}`
);
check(outside?.onNote === null, 'and its On button makes no board promise either');

// =============================================================================
rule('5. NO RECONCILER — the page says nothing, rather than guessing');
// =============================================================================

const bare = makeRouter({ running: FLEET, mode: null });
const barePayload = await bare.list();
check(
  !('boardControl' in barePayload),
  'a daemon with no reconciler omits the field entirely',
  `payload had boardControl = ${JSON.stringify(barePayload.boardControl)}`
);
check(
  describeBoardControl(barePayload.boardControl, agentOf('butchr-task-kan-222')) === null,
  'and the UI function returns null — no note, no chip, no claim'
);

// =============================================================================
rule('6. THE CLAIM IS TRUE — the board really does bring it back');
// =============================================================================
//
// Sections 1-5 prove the page says the right words. This proves the words are
// not merely well-chosen: the mechanism they describe actually behaves that
// way. If the reconciler did *not* restart a switched-off agent whose ticket is
// In Progress, section 4's confirmation would be a confident lie and every
// other section would still be green.
//
// The board read is stubbed, because Atlassian cannot be asked to answer on
// cue. That seam is the same one verify-board-reconciler-guard.mjs names, and
// report-board-convergence.mjs covers the other half against the live board.

const fleet = new Map(FLEET.map((a) => [a.agentName, { ...a }]));
const started = [];
const reconciler = new BoardReconciler({
  jira: {
    searchBoard: async () => ({
      ok: true,
      issues: [
        { key: 'KAN-222', issueTypeName: 'Task', statusName: 'In Progress' },
        { key: 'KAN-39', issueTypeName: 'Epic', statusName: 'In Progress' }
      ]
    })
  },
  runningAgents: () => [...fleet.values()],
  activate: async (agent) => {
    started.push(agent.agentName);
    fleet.set(agent.agentName, { agentName: agent.agentName, type: agent.type, key: agent.key });
    return { success: true };
  },
  deactivate: async (agent) => {
    fleet.delete(agent.agentName);
    return { success: true };
  },
  mode: () => 'converge',
  log: () => {},
  startStaggerMs: 0
});

// The user presses Off. This is what confirmOff ends up doing.
fleet.delete('butchr-task-kan-222');
check(!fleet.has('butchr-task-kan-222'), 'Off removed the agent from the fleet');

const cycle = await reconciler.reconcileOnce();
check(
  started.includes('butchr-task-kan-222'),
  'one cycle later the board started it again — exactly what the Off note warned',
  `started: ${JSON.stringify(started)}, refusal: ${JSON.stringify(cycle.refusal)}`
);
check(
  fleet.has('butchr-confluence-notes'),
  'and the confluence agent, which the note promised was safe, was left alone'
);

// =============================================================================
rule('7. OVER THE SOCKET — a real daemon, wired the way daemon.ts wires it');
// =============================================================================
//
// The section that would have caught a `reportBoardControl` that was written
// and never passed to MessageRouter. Everything above builds its own router;
// this asks the shipped daemon.

const fakeHome = fs.mkdtempSync(path.join(TMP, 'daemon-home-'));
fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'butchr'), { recursive: true });
const socketPath = path.join(fakeHome, '.local', 'share', 'butchr', 'butchr.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let daemon = null;
try {
  daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
    // `converge` deliberately: the mode with the strongest claim attached to it
    // is the one worth proving arrives over a real socket.
    env: { ...process.env, HOME: fakeHome, BUTCHR_BOARD_RECONCILE: 'converge' },
    stdio: 'ignore',
    detached: false
  });

  for (let i = 0; i < 80 && !fs.existsSync(socketPath); i++) await sleep(250);

  if (!fs.existsSync(socketPath)) {
    check(false, 'the daemon claimed its socket', `no socket at ${socketPath} after 20s`);
  } else {
    const socket = net.connect(socketPath);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const payload = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('no list_agents_response in 15s')), 15000);
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.action === 'list_agents_response') {
              clearTimeout(timer);
              resolve(msg);
              return;
            }
          } catch { /* a partial or unrelated line */ }
        }
      });
      socket.on('error', reject);
      socket.write(JSON.stringify({ action: 'list_agents' }) + '\n');
    });

    socket.end();

    check(
      !!payload.boardControl,
      'the real daemon sends boardControl on list_agents — the wiring is live',
      `payload keys: ${Object.keys(payload).join(', ')}`
    );
    check(
      payload.boardControl?.mode === 'converge',
      'and it reports the mode the environment actually set',
      `got ${payload.boardControl?.mode}`
    );
    check(
      Array.isArray(payload.boardControl?.jurisdictionTypes) &&
        payload.boardControl.jurisdictionTypes.length > 0,
      'and a non-empty jurisdiction, derived from the issue-type table'
    );

    // --- the spelling, off the real wire (KAN-225) ---------------------------
    //
    // This daemon runs under a temp `$HOME`, so its agent registry is empty,
    // while herdr's census is machine-wide — **every agent it can see is one it
    // has no record of.** That is acceptance criterion 1's condition occurring
    // naturally rather than being built: exactly the case the deleted
    // `recordedKeyFor(...) ?? agent.key` fallback fired on.
    //
    // It is asserted *here*, on the real payload, because that is the seam the
    // defect survived in. Sections 1-6 construct their fleet and register every
    // agent in it, so the fallback could never fire for them; this section
    // reaches a real one and could not check the spelling. Each half was honest
    // and the gap was between them — the KAN-145 shape, and the reason §7 prints
    // `{"butchr-epic-kan-39":"kan-39", …}` and passed for two PRs.
    const controlledEntries = Object.entries(payload.boardControl?.controlled ?? {});
    const sessionless = (payload.agents ?? []).filter((a) => a.sessionless === true);

    if (controlledEntries.length === 0) {
      // Said out loud rather than passed silently. On a machine with no Butchr
      // panes in jurisdiction — CI, or a developer box with the fleet down —
      // there is nothing for the two checks below to bite on, and a green run
      // that did not look at anything must not read as a green run that did.
      console.log(
        '  NOTE  no agent on this machine is in the board\'s jurisdiction, so the two\n' +
        '        spelling checks below are VACUOUS on this run. They are only evidence\n' +
        '        on a machine with a live fleet; verify-board-key-spelling.mjs is what\n' +
        '        asserts the same rule against a fleet it can guarantee.'
      );
    } else {
      check(
        sessionless.length === controlledEntries.length,
        'every agent off this wire is sessionless — criterion 1\'s condition really holds here',
        `${sessionless.length} sessionless of ${controlledEntries.length} controlled; ` +
        'this daemon\'s $HOME is a temp dir, so its registry has no record of any of them'
      );
    }

    const wrongCase = controlledEntries.filter(([, key]) => key !== key.toUpperCase());
    check(
      wrongCase.length === 0,
      'every key off the real wire is spelled as Jira spells it',
      `lower-cased: ${JSON.stringify(wrongCase)}`
    );
    const notKeyShaped = controlledEntries.filter(([, key]) => !/^[A-Z][A-Z0-9]*-\d+$/.test(key));
    check(
      notKeyShaped.length === 0,
      'and is Jira-shaped — the sentences name it as a ticket to go and move',
      `not key-shaped: ${JSON.stringify(notKeyShaped)}`
    );

    console.log(
      `\n  the block, off the wire: ${JSON.stringify(payload.boardControl)}`
    );
  }
} catch (e) {
  check(false, 'the socket section completed', e?.message ?? String(e));
} finally {
  if (daemon && !daemon.killed) {
    try { process.kill(daemon.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// --- the payloads the rendered proof is taken against ------------------------

if (dumpDir) {
  rule('8. DUMP — the payloads the rendering is taken against');
  fs.mkdirSync(dumpDir, { recursive: true });
  const write = (name, value) => {
    const file = path.join(dumpDir, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    console.log(`  wrote ${file}`);
  };
  for (const mode of ['converge', 'report', 'off']) {
    const router = makeRouter({ running: FLEET, standby: STANDBY, mode: () => mode });
    write(`list_agents.${mode}.json`, router.list());
  }
  write('list_agents.none.json', makeRouter({ running: FLEET, standby: STANDBY, mode: null }).list());
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(
  `\n== ${failures === 0 ? 'done — every section passed' : `${failures} CHECK(S) FAILED`} ==`
);
process.exit(failures === 0 ? 0 : 1);
