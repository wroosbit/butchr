import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';
import { MessageRouter } from './router.js';
import { JiraIssueTypeService } from './jira.js';
import { CredentialStore } from './credentials.js';
import {
  LaunchDarklyIntegration,
  createLaunchDarklyIntegration
} from './integrations/launchdarkly.js';
import { createAtlassianIntegration } from './integrations/atlassian-integration.js';
import { coreMcpServerDefinitions } from './launchers.js';
import { BUTCHR_DIR, SOCKET_PATH, ensureButchrDir, onJsonLines, writeJsonLine } from './ipc.js';
import { resolveUserPath, which } from './env.js';
import { getStalenessReport, formatStalenessReport } from './staleness.js';
import { readFdUsage, isFdCeilingUnraised, describeFdCeiling, checkHerdrVersion } from './herdr-health.js';
import { AgentRegistry, REGISTRY_PATH } from './agent-registry.js';
import { reconcileAgents } from './reconcile.js';
import { SupervisionNotifier } from './nudge.js';
import { startMeasurement, finishMeasurement, MeasurementStart } from './agent-cost.js';
import { dampCost, sampleFromMeasurement } from './agent-cost-damping.js';
import { AgentCost, MEASURED_AGENT_COST, setMeasuredAgentCost } from './capacity.js';
import { execFileSync } from 'child_process';

// The single long-lived Butchr daemon. Owns all sessions, PTYs, and the
// workspace registry. Clients (Chrome native-host proxies, the MCP server)
// connect over a Unix domain socket speaking newline-delimited JSON, so
// filesystem permissions are the auth boundary and there is no TCP port
// for multiple browser profiles to fight over.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

ensureButchrDir();
const logStream = fs.createWriteStream(path.join(BUTCHR_DIR, 'daemon.log'), { flags: 'a' });
const log = (...args: any[]) => {
  const line = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
};
// The daemon normally runs detached; shared modules log via console.
console.log = log;
console.error = log;

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log('Unhandled rejection:', err as any);
});

// Normalize PATH before anything spawns: this daemon outlives the client that
// started it, and its environment is inherited by every herdr pane and agent.
process.env.PATH = resolveUserPath();
const herdrPath = which('herdr');
log(`PATH resolved to: ${process.env.PATH}`);
if (herdrPath) {
  log(`herdr found at ${herdrPath}`);
  // Which herdr, not just whether there is one: 0.7 changed `agent start`
  // incompatibly, and without this the only symptom is `unknown option: --cwd`
  // on every activation.
  try {
    const version = execFileSync(herdrPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    log(`herdr version: ${version.trim()}`);
    const versionWarning = checkHerdrVersion(version);
    if (versionWarning) log(`WARNING: ${versionWarning}`);
  } catch (e: any) {
    log(`Could not read herdr's version: ${e?.message ?? String(e)}`);
  }
} else {
  log('WARNING: herdr not found on PATH; agent sessions will fail to attach');
}

// The pane ceiling, checked once at startup rather than left to be discovered
// as a total spawn outage. A herdr on the stock 1024 soft limit runs out of
// descriptors at ~205 panes; the fix is a setup step, and a setup step nobody
// verifies is folklore (KAN-33). Reported here and by
// daemon/scripts/butchr-doctor.mjs so the two cannot disagree.
const fdUsage = readFdUsage();
if (!fdUsage) {
  log('herdr fd limit: no running herdr server to inspect (or no /proc); skipping the check');
} else if (isFdCeilingUnraised(fdUsage)) {
  log(`WARNING: ${describeFdCeiling(fdUsage)}`);
} else {
  log(
    `herdr fd limit: soft ${fdUsage.softLimit}, ${fdUsage.openFds} open, ` +
    `headroom ≈ ${fdUsage.headroomPanes} panes (pid ${fdUsage.pid})`
  );
}

// Jira access exists for exactly one question — is this issue a Task or a
// Story? — and is strictly read-only. The service never throws and always
// answers within its own timeout, so the registry can depend on it without
// activation ever being able to hang or fail on Jira's account.
const jira = new JiraIssueTypeService(new CredentialStore());
// LaunchDarkly holds a credential only, for now: no flag reads, no LD-owned
// workspace types. The adapter exists so the settings UI has somewhere real
// to store and validate a token (KAN-86).
const launchdarkly = new LaunchDarklyIntegration();

// The registry is empty until an integration fills it: what workspace types
// this daemon has is the sum of what its enabled integrations contribute, and
// this is the only place that sum is decided. Atlassian first, so the settings
// surface lists it first.
const registry = new WorkspaceRegistry();
registry.registerIntegration(
  createAtlassianIntegration({
    // The one question the registry asks the outside world. Bounded and
    // never-throwing inside the service; see jira.ts.
    issueTypeLookup: (key: string) => jira.getIssueTypeName(key),
    credential: jira
  })
);
registry.registerIntegration(createLaunchDarklyIntegration(launchdarkly));
// What this daemon came up with, said plainly at startup. A disabled
// integration is the difference between "no Jira URL resolves" and "no Jira
// URL resolves *because Atlassian is switched off*", and that is exactly the
// question someone will be asking the log.
for (const integration of registry.integrations()) {
  const types = integration.workspaceTypes.map((t) => t.type).join(', ') || '(none)';
  const servers = Object.keys(integration.mcpServers?.() ?? {}).join(', ') || '(none)';
  log(
    `Integration ${integration.id} (${integration.name}): ` +
      (integration.enabled
        ? `enabled — types: ${types}; MCP servers: ${servers}`
        : `disabled — registered but contributing nothing until enabled ` +
          `(would provide types: ${types}; MCP servers: ${servers})`)
  );
}
log(
  `MCP servers assembled for a spawning agent now: ` +
    Object.keys({ ...registry.mcpServerDefinitions(), ...coreMcpServerDefinitions() }).join(', ')
);
const promptLoader = new PromptLoader(repoRoot);
const herdrBridge = new HerdrBridge();

// The one piece of state that outlives the machine. Everything else here —
// the session map, herdr's panes, the extension's view — dies in a power cut,
// which is why a reboot used to destroy the fleet with nothing to say about it.
// See agent-registry.ts for why it is an fsync'd append-only log.
const agentRegistry = new AgentRegistry();

const credentialStatus = jira.status();
log(
  credentialStatus.configured
    ? `Jira credential configured for ${credentialStatus.email} @ ${credentialStatus.siteUrl} (stored in ${credentialStatus.storage})`
    : 'No Jira credential configured; Jira issue URLs will all resolve to type `task`'
);
const ldStatus = launchdarkly.status();
log(
  ldStatus.configured
    ? `LaunchDarkly credential configured (stored in ${ldStatus.storage})`
    : 'No LaunchDarkly credential configured'
);
// When this process started, so the staleness check can tell a rebuilt `dist/`
// from a daemon that has actually loaded it. Captured before anything slow.
const daemonStartedAt = new Date();

// Nothing about a merged PR reaches this machine on its own: the clone is not
// pulled, `dist/` does not rebuild, Chrome does not reload. Report it at
// startup — the daemon is restarted precisely when someone has just changed
// something, which is the moment the answer matters. Local reads only; a
// blocking `git fetch` here would trade a silent failure for a slow one.
for (const line of formatStalenessReport(
  getStalenessReport({ repoRoot, daemonStartedAt, force: true })
)) {
  log(line);
}

const connections = new Set<net.Socket>();

const broadcast = (msg: any) => {
  for (const conn of connections) {
    writeJsonLine(conn, msg);
  }
};

// A PTY that dies takes the terminal with it, and the client has no other way
// to find out: output simply stops. Announcing it is what lets the sidepanel
// show a disconnected state instead of a frozen last frame.
herdrBridge.setSessionEndedListener((event) => {
  log(
    `Session ended: ${event.sessionId} (${event.type}/${event.key}) ` +
    `reason=${event.reason} exitCode=${event.exitCode}`
  );
  broadcast({ action: 'agent_detached_event', ...event });
});

const server = net.createServer((socket) => {
  connections.add(socket);
  log(`Client connected (${connections.size} total)`);

  // One router per connection: responses go back to the requesting client,
  // pty listeners registered by this client die with its connection.
  const router = new MessageRouter(
    registry,
    promptLoader,
    herdrBridge,
    (msg) => writeJsonLine(socket, msg),
    broadcast,
    jira,
    { repoRoot, daemonStartedAt },
    agentRegistry,
    launchdarkly
  );

  onJsonLines(
    socket,
    (msg) => {
      try {
        router.handle(msg);
      } catch (err: any) {
        log('Handler error:', err);
        writeJsonLine(socket, {
          success: false,
          error: err?.message ?? String(err),
          ...(msg?.id !== undefined ? { id: msg.id } : {})
        });
      }
    },
    (err) => log('Bad JSON line from client:', err.message)
  );

  socket.on('error', (err) => log('Client socket error:', err.message));
  socket.on('close', () => {
    connections.delete(socket);
    router.cleanup();
    log(`Client disconnected (${connections.size} total)`);
  });
});

let retriedStaleSocket = false;
server.on('error', (err: any) => {
  if (err.code !== 'EADDRINUSE') {
    log('Server error:', err);
    process.exit(1);
  }
  // Socket file exists: either a live daemon owns it, or it's stale from a crash.
  const probe = net.connect(SOCKET_PATH);
  probe.once('connect', () => {
    probe.end();
    log('Another daemon is already running; exiting.');
    process.exit(0);
  });
  probe.once('error', () => {
    if (retriedStaleSocket) {
      log('Could not claim socket after stale-file cleanup; exiting.');
      process.exit(1);
    }
    retriedStaleSocket = true;
    log('Removing stale socket file');
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    server.listen(SOCKET_PATH, onListen);
  });
});

/**
 * A router with nowhere to answer, for the daemon's own use.
 *
 * Reconciliation and the loss sweep are not requests — nobody is connected at
 * boot, which is the whole difficulty this ticket is about — but they need to
 * do exactly what a request would. Rather than duplicating activation, they get
 * a router whose per-request `send` goes nowhere while broadcasts still reach
 * whatever clients turn up later.
 */
const daemonRouter = new MessageRouter(
  registry,
  promptLoader,
  herdrBridge,
  () => {},
  broadcast,
  jira,
  { repoRoot, daemonStartedAt },
  agentRegistry,
  launchdarkly
);

/**
 * How long between checks that the fleet still matches the registry.
 *
 * Not a restart loop: this only *reports*. An agent that dies mid-afternoon is
 * a different decision from one that was killed by a power cut, with different
 * failure modes, and KAN-21 asks for the loss to be surfaced rather than
 * guessed at. Restoring is startup's job.
 */
const MISSING_SWEEP_INTERVAL_MS = 30_000;

/**
 * The detectability half. Silent loss is what made KAN-21's outage expensive —
 * the board read healthy for twenty minutes while nothing was running — so a
 * missing agent is announced to every connected client, which is what the
 * sidepanel and the Agents page render and what `butchr_list_agents` reports on
 * every poll. It is deliberately not just a log line.
 *
 * Only *newly* missing agents are announced. An agent that has been gone for an
 * hour is still reported in `list_agents` on every request, but re-broadcasting
 * it twice a minute forever would train everyone to ignore the event.
 */
const announcedMissing = new Set<string>();

/**
 * The other half of the same tick: who to *tell*.
 *
 * The broadcast above reaches whatever clients are connected, which is the
 * right answer for a board somebody is looking at and no answer at all for the
 * story agent whose task agent just died — nobody types into an agent's
 * terminal on the strength of a WebSocket frame. This is the party that has to
 * hear it, resolved through the supervisor of record the activation recorded.
 * See nudge.ts for which transitions qualify and for the storm guards.
 */
const supervision = new SupervisionNotifier({
  herdrBridge,
  supervisorFor: (agentName) => daemonRouter.supervisorFor(agentName),
  recordedKeyFor: (agentName) => daemonRouter.recordedKeyFor(agentName),
  log
});

function sweepForMissingAgents() {
  let fleet;
  try {
    fleet = daemonRouter.surveyFleet();
  } catch (e: any) {
    log('Missing-agent sweep failed:', e?.message ?? String(e));
    return;
  }
  const missing = fleet.missing;

  // Fire-and-forget, and deliberately after nothing: a nudge waits on a pane
  // tail to confirm delivery, and blocking the sweep on that would delay the
  // loss broadcast — the report path this ticket is not allowed to re-pace —
  // behind a message to somebody who may not even be running.
  void supervision.onSweep({
    agents: fleet.agents.map((agent) => ({
      agentName: agent.agentName,
      type: agent.type,
      key: agent.key,
      herdrStatus: agent.herdrStatus
    })),
    missing: missing.map((agent) => ({
      agentName: agent.agentName,
      type: agent.type,
      key: agent.key
    }))
  });

  const names = new Set(missing.map((agent) => agent.agentName));
  for (const name of announcedMissing) {
    if (!names.has(name)) announcedMissing.delete(name);
  }

  for (const agent of missing) {
    if (announcedMissing.has(agent.agentName)) continue;
    announcedMissing.add(agent.agentName);
    log(
      `AGENT LOST: ${agent.agentName} (${agent.type}/${agent.key}) is recorded as active ` +
      `since ${agent.since} but herdr has no such agent. Workspace: ${agent.workDir}`
    );
    broadcast({ action: 'agent_lost_event', ...agent });
  }
}

/**
 * How often the daemon re-measures what its own agents cost (KAN-56, on the
 * same footing as the missing-agent sweep above).
 *
 * Sixty seconds, for two reasons. Long enough that the utime deltas average
 * over an agent's think/act duty cycle instead of catching one busy or one
 * idle instant, and that the sampling itself — two /proc sweeps a minute,
 * single-digit milliseconds each — stays far below anything worth charging
 * for. Short enough that, with the damping's fast-up alpha, a fleet that
 * turns busy is mostly believed within three windows, i.e. minutes.
 */
const COST_SAMPLE_INTERVAL_MS = 60_000;

/** The open "before" side of the current window; null until the first tick
 * and after any sampling failure. */
let costWindow: MeasurementStart | null = null;
/** The damped estimate, unrounded. Null whenever capacity should answer from
 * the seed. */
let costEstimate: AgentCost | null = null;
/** Transition memory so the log records changes of state, not every quiet
 * minute of a healthy sampler. */
let costSamplerState: 'no-measurement' | 'live' = 'no-measurement';

/**
 * Degrade, never guess: any failure — /proc unreadable, an empty fleet, a
 * sample that fails validation — clears the live measurement so capacity
 * falls back to MEASURED_AGENT_COST with the report labelling the figures as
 * seed. A stale estimate left posing as live would be the exact mislabelling
 * KAN-44 exists to correct.
 */
function degradeCostMeasurement(reason: string) {
  costEstimate = null;
  setMeasuredAgentCost(null);
  if (costSamplerState !== 'no-measurement') {
    costSamplerState = 'no-measurement';
    log(`Agent-cost sampler: ${reason}; capacity answers from the seed constants until sampling recovers`);
  }
}

function sampleFleetCost() {
  let measurement;
  try {
    measurement = costWindow ? finishMeasurement(costWindow) : null;
    costWindow = startMeasurement();
  } catch (e: any) {
    costWindow = null;
    degradeCostMeasurement(`/proc sampling failed (${e?.message ?? String(e)})`);
    return;
  }
  if (!measurement) return; // first tick only opens the window

  const sample = sampleFromMeasurement(measurement, os.totalmem());
  if (!sample) {
    degradeCostMeasurement(
      measurement.totals.agents <= 0
        ? 'no agent trees running, nothing to measure'
        : 'sample failed validation'
    );
    return;
  }

  // Damped from the previous estimate, seeded from the constants, so the
  // first window after a gap starts from the conservative figure rather than
  // from whatever the window happened to catch. See agent-cost-damping.ts.
  costEstimate = dampCost(costEstimate ?? MEASURED_AGENT_COST, sample);
  // Published rounded (whole MB, 3-decimal cores) so the figures a capacity
  // report prints are exactly the figures the arithmetic divides by — the
  // hand-reproducibility describeCapacity promises.
  const published = {
    residentBytes: Math.round(costEstimate.residentBytes / (1024 * 1024)) * 1024 * 1024,
    cores: Math.round(costEstimate.cores * 1000) / 1000,
    sampledAt: Date.now(),
    windowSeconds: measurement.elapsed,
    agentTrees: measurement.totals.agents
  };
  setMeasuredAgentCost(published);
  if (costSamplerState !== 'live') {
    costSamplerState = 'live';
    log(
      `Agent-cost sampler: live measurement established — damped cost ` +
      `${Math.round(published.residentBytes / (1024 * 1024))} MB / ${published.cores} core per tree ` +
      `(${published.agentTrees} tree(s), ${Math.round(published.windowSeconds)}s window)`
    );
  }
}

let started = false;

function onListen() {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {}
  log(`Butchr daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);

  // A stale-socket retry calls this twice; restoration must happen once.
  if (started) return;
  started = true;

  log(`Agent registry: ${REGISTRY_PATH}`);

  // Restoration runs after the socket is listening, not before: an activation
  // takes minutes for a fleet, and a daemon that answered nothing until it
  // finished would look exactly like a daemon that never came up.
  //
  // `reboot` rather than `daemon-restart` because that is what this daemon
  // starting means in the case the ticket is about, and because it is the
  // framing an agent needs to read: the machine went away, not just its
  // supervisor. A restored agent is told to check the repository and the
  // workspace for what it already did either way.
  void reconcileAgents({
    registry: agentRegistry,
    herdrBridge,
    router: daemonRouter,
    cause: 'reboot',
    log
  })
    .then((result) => {
      const restored = result.outcomes.filter((o) => o.result === 'restored');
      const failed = result.outcomes.filter((o) => o.result === 'failed');
      const idle = restored.filter((o) => o.resumedConversation && o.nudged === false);
      log(
        `[reconcile] Done: ${result.expected} expected, ` +
        `${restored.length} restored, ` +
        `${result.outcomes.filter((o) => o.result === 'already-running').length} already running, ` +
        `${failed.length} failed.` +
        (idle.length
          ? ` ${idle.length} restored agent(s) could not be told to carry on and may be idle: ` +
            idle.map((o) => o.agentName).join(', ')
          : '')
      );
      // Whatever restoration could not bring back is a loss, and is announced
      // by the same sweep that watches for losses later.
      sweepForMissingAgents();
    })
    .catch((err) => log('[reconcile] Reconciliation failed:', err));

  const sweep = setInterval(sweepForMissingAgents, MISSING_SWEEP_INTERVAL_MS);
  sweep.unref();

  // Open the first cost window now rather than a minute from now; the first
  // damped figure lands one interval later. Until then — and whenever the
  // sampler degrades — capacity answers from the labelled seed.
  sampleFleetCost();
  const costSampler = setInterval(sampleFleetCost, COST_SAMPLE_INTERVAL_MS);
  costSampler.unref();
}

const shutdown = () => {
  log('Shutting down');
  server.close();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(SOCKET_PATH, onListen);
