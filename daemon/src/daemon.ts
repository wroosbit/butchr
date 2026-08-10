import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceRegistry, isSupervisorType } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';
import type { AgentRuntime } from './agent-runtime.js';
import { MessageRouter } from './router.js';
import { JiraIssueTypeService } from './jira.js';
import { CredentialStore } from './credentials.js';
import {
  LaunchDarklyIntegration,
  createLaunchDarklyIntegration
} from './integrations/launchdarkly.js';
import { createAtlassianIntegration } from './integrations/atlassian-integration.js';
import { coreMcpServerDefinitions, DEV_CHANNELS_FLAG } from './launchers.js';
import { BUTCHR_DIR, SOCKET_PATH, ensureButchrDir, onJsonLines, writeJsonLine } from './ipc.js';
import { resolveUserPath, which } from './env.js';
import { getStalenessReport, formatStalenessReport } from './staleness.js';
import { readFdUsage, isFdCeilingUnraised, describeFdCeiling, checkHerdrVersion } from './herdr-health.js';
import { AgentRegistry, REGISTRY_PATH } from './agent-registry.js';
import {
  AgentConnectionRegistry,
  addressFromAnnouncement,
  describeAddress
} from './agent-connections.js';
import {
  CHANNEL_SWITCH_PATH,
  channelEmissionEnabled,
  routeChannelMessage,
  writeChannelSwitch
} from './channel.js';
import {
  freshConnectionFrom,
  superviseChannelStartup
} from './channel-startup.js';
import {
  CHANNEL_SELFCHECK_ACTION,
  CHANNEL_SELFCHECK_RESULT_ACTION,
  ChannelSelfCheckAckRegistry,
  ChannelSelfCheckStore,
  runChannelSelfCheck
} from './channel-selfcheck.js';
import { reconcileAgents } from './reconcile.js';
import { SupervisionNotifier } from './nudge.js';
import { JiraPoller } from './jira-poll.js';
import { BoardMode, BoardReconciler } from './board-reconcile.js';
import { AddressableAgent, BoardControlReport, boardControlReport } from './board-control.js';
import { CommentAuthorship } from './comment-authorship.js';
import { startMeasurement, finishMeasurement, MeasurementStart } from './agent-cost.js';
import { dampCost, sampleFromMeasurement } from './agent-cost-damping.js';
import {
  COST_ESTIMATE_PATH,
  clearCostEstimate,
  loadCostEstimate,
  saveCostEstimate
} from './agent-cost-store.js';
import { AgentCost, MEASURED_AGENT_COST, sampleCpuBusy, setMeasuredAgentCost } from './capacity.js';
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
const herdrBridge: AgentRuntime = new HerdrBridge();

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

// Which agent is on the other end of each connection (KAN-243). Maintained
// beside `connections` and never instead of it: `broadcast` still fans out to
// every client, identified or not, so nothing any existing consumer receives
// changes. This map only adds the ability to *address* one — KAN-244 is what
// uses it. See agent-connections.ts for the four decisions behind its shape.
const agentConnections = new AgentConnectionRegistry();

/**
 * Each agent's startup channel self-check verdict (KAN-248, T5).
 *
 * Beside the identity map because it describes entries in it: a verdict is about
 * one connection, and is dropped when that connection goes (see the socket
 * `close` below). Read in two places and written in one — the watcher wiring
 * further down is the only writer, `routeChannelMessage` and `list_agents` are
 * the readers.
 */
const channelSelfChecks = new ChannelSelfCheckStore();

/**
 * Self-check answers this daemon is still waiting for, by nonce.
 *
 * Armed before the probe frame is written and resolved by the
 * `channel_selfcheck_result` case below, which is why the ack cannot arrive
 * before anybody is listening for it — the round trip is sub-millisecond on a
 * loopback socket.
 */
const selfCheckAcks = new ChannelSelfCheckAckRegistry();

/**
 * The two actions that are about the connection itself rather than about the
 * fleet, answered here instead of in the router.
 *
 * They are handled at this layer because the router has no socket: it is
 * constructed with a `send` closure and deliberately knows nothing about the
 * transport, whereas both of these are questions about *which socket this is*.
 * Handling them before dispatch also means `MessageRouter.handle` is reached by
 * exactly the actions it was reached by before, so its unknown-action branch
 * cannot start warning about `hello`.
 *
 * Returns whether the message was consumed.
 */
const handleConnectionAction = (socket: net.Socket, msg: any): boolean => {
  const reply = (body: any) =>
    writeJsonLine(socket, msg?.id !== undefined ? { ...body, id: msg.id } : body);

  switch (msg?.action) {
    case 'hello': {
      const address = addressFromAnnouncement(msg);
      if (!address) {
        // Not an error worth closing over. A client with nothing to announce
        // should not be sending `hello` at all, but the honest answer is that
        // it stays anonymous — which is a perfectly ordinary way to be.
        log('hello with no workspace identity; connection stays anonymous');
        reply({
          action: 'hello_response',
          success: false,
          error: 'hello requires both workspaceType and workspaceKey',
          identified: false
        });
        return true;
      }
      const result = agentConnections.register(socket, address);
      if (!result.ok) {
        reply({ action: 'hello_response', success: false, error: result.error, identified: false });
        return true;
      }
      const { connection, replaced } = result;
      log(
        `Connection ${connection.id} is ${describeAddress(connection.address)}` +
          (replaced ? ` (was ${describeAddress(replaced.address)} as ${replaced.id})` : '') +
          ` — ${agentConnections.size} identified of ${connections.size} connected`
      );
      reply({
        action: 'hello_response',
        success: true,
        identified: true,
        connectionId: connection.id,
        workspaceType: connection.address.type,
        workspaceKey: connection.address.key
      });
      return true;
    }
    case 'channel_send': {
      // THE ADDRESSED SEND (KAN-244, T2). KAN-243 built the identity → connection
      // map and routed nothing with it; this is what writes down one of those
      // connections and no others.
      //
      // Handled here beside `hello` for the same reason `hello` is: the router
      // is constructed with a `send` closure and deliberately knows nothing
      // about the transport, and this action's whole subject is *which socket*.
      // Keeping it out of the router also means `MessageRouter.handle` is
      // reached by exactly the actions it was reached by before, so no existing
      // caller's behaviour moves — `butchr_send_to_agent` still types into a
      // composer, unchanged and untouched. Routing it over this is T4.
      //
      // WHAT THE REPLY CLAIMS, AND WHAT IT REFUSES TO. `success: true` here
      // means the bytes were written to a named connection. It does NOT mean an
      // agent read them and does NOT mean a model received them — those are
      // different facts with different failure modes, and `success: true`
      // standing in for them is the shape this board has been burned by five
      // times (design §2). So the reply carries `claim` saying in words what it
      // is asserting, and the honest negative — no connection for that identity
      // — is a first-class, sender-visible answer rather than a silent discard
      // (design §1.3).
      const address = addressFromAnnouncement(msg);
      if (!address) {
        reply({
          action: 'channel_send_response',
          success: false,
          reason: 'no-address',
          error: 'channel_send requires both workspaceType and workspaceKey'
        });
        return true;
      }
      // The switch check, the map lookup and the write moved into
      // `routeChannelMessage` when KAN-247 gave `butchr_send_to_agent` a channel
      // route: two callers needed all three, and a second copy of the *gate* in
      // particular would mean a send that routed over a channel the fleet
      // believes is off. See channel.ts. What stays here is this action's own
      // reply shape, which KAN-244's proofs read field by field.
      const outcome = routeChannelMessage({
        registry: agentConnections,
        address,
        content: msg.content,
        meta: msg.meta,
        selfCheck: channelSelfChecks
      });
      log(
        `channel_send → ${describeAddress(address)}: ` +
          (outcome.routed ? `written to ${outcome.connectionId}` : `refused (${outcome.reason})`)
      );
      if (!outcome.routed) {
        reply({
          action: 'channel_send_response',
          success: false,
          reason: outcome.reason,
          error: outcome.detail,
          ...(outcome.switchPath ? { switchPath: outcome.switchPath } : {}),
          claim: 'nothing was written'
        });
        return true;
      }
      reply({
        action: 'channel_send_response',
        success: true,
        connectionId: outcome.connectionId,
        workspaceType: outcome.address.type,
        workspaceKey: outcome.address.key,
        claim:
          `the frame was written to ${outcome.connectionId}; this is not a claim that the agent read it, ` +
          'nor that a model received it'
      });
      return true;
    }
    case 'channel_switch': {
      // The kill switch, readable and settable over the socket so it does not
      // need a shell on the machine. Omit `enabled` to read it. Not an MCP tool
      // — §1.2 asks for a control that does not touch the tool surface, and
      // this is a daemon action like `connected_agents` beside it.
      if (typeof msg?.enabled === 'boolean') {
        writeChannelSwitch(msg.enabled);
        log(`channel emission switched ${msg.enabled ? 'ON' : 'OFF'} via channel_switch`);
      }
      // Reported by reading it back rather than by echoing what was asked for:
      // the value that matters is the one the next `channel_send` will read.
      reply({
        action: 'channel_switch_response',
        success: true,
        enabled: channelEmissionEnabled(),
        switchPath: CHANNEL_SWITCH_PATH
      });
      return true;
    }
    case CHANNEL_SELFCHECK_RESULT_ACTION: {
      // An agent's report of its own end of the startup loop (KAN-248, T5).
      //
      // Handled beside `hello` rather than in the router because it is an answer
      // to something this layer asked, and because it must NOT be replied to:
      // answering an answer would put a frame on the wire the agent's `mcp.js`
      // has no branch for.
      //
      // An unknown nonce is dropped in silence and that is correct rather than
      // lax — it is what a late answer looks like after the check has already
      // timed out and reported, and resolving one then would overwrite a verdict
      // with a stale reading of a client that has since gone.
      selfCheckAcks.deliver(msg);
      return true;
    }
    case 'connected_agents': {
      // A diagnostic, and the only window onto this map from outside the
      // process. It reports the map and routes nothing.
      reply({
        action: 'connected_agents_response',
        success: true,
        agents: agentConnections.snapshot(),
        identifiedConnections: agentConnections.size,
        totalConnections: connections.size
      });
      return true;
    }
    default:
      return false;
  }
};

// A PTY that dies takes the terminal with it, and the client has no other way
// to find out: output simply stops. Announcing it is what lets the sidepanel
// show a disconnected state instead of a frozen last frame.
// Watch every pane the bridge spawns through the channel dialog and on to a
// connected MCP server (KAN-246). Installed here because readiness is defined in
// terms of `agentConnections` — the map an addressed frame is routed through —
// and the bridge has no view of it; the same seam, and the same reason, as the
// router's `channelRoute` below.
//
// THE SWITCH IS NOT RE-READ HERE, DELIBERATELY. The launcher read it moments ago
// to decide whether to pass the flag, and asking the same question of the same
// file a second time admits an answer that disagrees with what is now running in
// the pane — a switch turned off in that window would leave a `claude` launched
// WITH the flag and nothing watching the dialog it raises, which is the wedged
// agent this ticket exists to prevent. So the test is on the command string that
// was actually spawned. One fact, read from the thing itself.
herdrBridge.setAgentSpawnedListener((session, spawnedAt, command) => {
  if (!command.includes(DEV_CHANNELS_FLAG)) return;

  const address = { type: session.type, key: session.key };
  // THIS AGENT IS BEING RE-SPAWNED, SO WHATEVER WAS KNOWN ABOUT ITS CHANNEL IS
  // NO LONGER KNOWN (KAN-248). Dropped before the new check rather than
  // overwritten after it: a verdict that never held a connection is released by
  // nothing, so without this an agent that failed its check once carried that
  // verdict — with its old timestamp — across every restart until a new check
  // finished. Found by `probe-channel-selfcheck.mjs` reading a previous
  // attempt's row and believing it.
  channelSelfChecks.forget(address);
  void superviseChannelStartup({
    address,
    spawnedAt,
    world: {
      // `recent-unwrapped`, via the same reader `butchr_tail_agent` uses, so
      // what this matches against is what a human would see if they looked.
      readPane: () => herdrBridge.tailAgent(session.key, session.type, 140).text ?? null,
      pressEnter: () => herdrBridge.pressPaneKey(session.key, session.type, 'Enter'),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      freshConnection: freshConnectionFrom(agentConnections, address),
      log: (message) => log(message)
    }
  }).then(async (startup) => {
    // THE STARTUP SELF-CHECK (KAN-248, T5), CHAINED ONTO T3 RATHER THAN RACING
    // IT. Readiness is the precondition for the check to mean anything: design
    // §6.2 says the fix for the startup race is ordering rather than buffering —
    // *"do not send until the agent's own readiness is observed"* — and firing a
    // probe frame at a pane that has not got a listener yet would manufacture
    // the exact failure this check exists to detect.
    //
    // IT ADDS NOTHING TO ACTIVATION LATENCY, and that is structural rather than
    // measured: the whole chain hangs off `void`, downstream of a listener the
    // activation does not await, so no caller is waiting on any of it. What it
    // costs is one socket round trip per channel-enabled activation, off the
    // critical path. The window between readiness and the verdict is that same
    // round trip, and during it the agent has no record and therefore routes —
    // see channel-selfcheck.ts on why unchecked is not failed.
    const report = await runChannelSelfCheck({
      address,
      startupOutcome: startup.outcome,
      world: {
        // The same reader the launcher and `routeChannelMessage` use, called
        // rather than copied.
        emissionEnabled: () => channelEmissionEnabled(),
        resolveConnection: () => {
          const conn = agentConnections.resolve(address);
          return conn ? { id: conn.id } : null;
        },
        expectAck: (nonce, timeoutMs) => selfCheckAcks.expect(nonce, timeoutMs),
        writeProbe: (nonce) => {
          const conn = agentConnections.resolve(address);
          return conn
            ? writeJsonLine(conn.socket, { action: CHANNEL_SELFCHECK_ACTION, nonce })
            : false;
        },
        now: () => Date.now(),
        log: (message) => log(message)
      }
    });
    channelSelfChecks.record(address, report);
  }).catch((err) => {
    // `superviseChannelStartup` and `runChannelSelfCheck` both promise not to
    // throw, and this is caught anyway because an unhandled rejection here would
    // take the daemon down and the fleet with it, over a watcher. The chain is
    // covered as a whole rather than one `.catch` per link: an agent that ends up
    // with no verdict is `unchecked`, which is a state the fleet already has to
    // handle honestly, so there is nothing to recover here beyond saying so.
    log(`[ChannelStartup] ${describeAddress(address)}: watcher failed unexpectedly:`, err);
  });
});

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
    {
      jira,
      install: { repoRoot, daemonStartedAt },
      agentRegistry,
      launchdarkly,
      // `capacitySource` is deliberately absent (KAN-221): production wants its
      // default, the real machine. Under KAN-226 that is an omitted field
      // rather than an `undefined` placeholder holding a slot open, so nothing
      // here has to be counted and a new option cannot displace an existing one.
      boardControl: reportBoardControl,
      // The channel carrier for `butchr_send_to_agent` (KAN-247, T4). This is
      // the seam that lets the router decide a transport without knowing what a
      // socket is: the identity map lives here, beside the connections it
      // indexes, and the router gets a closure over it rather than a reference
      // to it. `routeChannelMessage` reads the kill switch on every call, so a
      // channel switched off mid-flight stops the very next send with nothing
      // restarted — see channel.ts on why the gate is read fresh.
      //
      // `selfCheck` is KAN-248's verdicts, and passing them here is what makes
      // "fall back to the composer" a behaviour rather than a row in a listing:
      // a degraded agent's sends are refused by the gate and land on the
      // composer, with `transportChosenBecause` naming the failed check.
      channelRoute: (address, content, meta) =>
        routeChannelMessage({
          registry: agentConnections,
          address,
          content,
          meta,
          selfCheck: channelSelfChecks
        }),
      // What each agent's startup self-check found, for `list_agents` (KAN-248).
      // A reader rather than the store, for the same reason `channelRoute` is a
      // closure: the router does not learn what a connection is.
      channelSelfCheck: (address) => channelSelfChecks.get(address) ?? null
    }
  );

  onJsonLines(
    socket,
    (msg) => {
      try {
        if (handleConnectionAction(socket, msg)) return;
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
    // Beside the set's own cleanup, deliberately: a map that outlives the
    // socket set is the leak this ticket is most likely to ship, and it is
    // invisible — an entry for a departed agent looks exactly like an entry for
    // a present one until something addresses it.
    const released = agentConnections.release(socket);
    // And the verdict about that connection goes with it (KAN-248). Matched on
    // connection id inside the store, so an agent that reconnected before this
    // close fired keeps its NEW verdict — the unordered-close bug
    // agent-connections.ts decision 3 makes unrepresentable, not reintroduced
    // one map over.
    const forgotten = released
      ? channelSelfChecks.releaseConnection(released.address, released.id)
      : false;
    router.cleanup();
    log(
      `Client disconnected (${connections.size} total)` +
        (released
          ? ` — ${describeAddress(released.address)} unregistered (${released.id}), ` +
            `${agentConnections.size} identified remain` +
            (forgotten ? '; its channel self-check verdict is dropped with it' : '')
          : '')
    );
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
  {
    jira,
    install: { repoRoot, daemonStartedAt },
    agentRegistry,
    launchdarkly,
    boardControl: reportBoardControl
  }
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

/**
 * The other direction the same news travels: Jira, watched (KAN-79).
 *
 * The sweep above notices what happens to an agent's *runtime*. This notices
 * what happens to its *ticket* — a status moved on the board, a comment posted
 * while the agent was mid-turn — which no amount of watching herdr can see and
 * which, for a comment, is the human's only way of steering work already in
 * flight. Same fleet census, same durable parentage, same delivery primitive;
 * a different thing being read. See jira-poll.ts for the interval arithmetic,
 * the back-off, and the limits of self-echo suppression.
 *
 * `authorship` is what stops the poller interrupting an agent to tell it about
 * a comment it wrote itself (KAN-187). It is the one part of this wiring that
 * reads something other than herdr, Jira or the registry — Claude Code's own
 * transcripts — because that is the only place in the system where an agent's
 * write to Jira is observable at all. See comment-authorship.ts for why the
 * author field cannot answer this and what the transcript answers instead.
 */
const commentAuthorship = new CommentAuthorship({ log });

const jiraPoller = new JiraPoller({
  jira,
  herdrBridge,
  authorship: commentAuthorship,
  liveAgents: () =>
    daemonRouter
      .surveyFleet()
      .agents.filter((agent) => agent.type)
      .map((agent) => ({
        agentName: agent.agentName,
        type: agent.type as string,
        // The registry's spelling, because an agent *name* is built from a
        // lower-cased key and `kan-79` is not what a Jira URL takes.
        key: daemonRouter.recordedKeyFor(agent.agentName) ?? agent.key
      })),
  supervisorFor: (agentName) => daemonRouter.supervisorFor(agentName),
  log
});

/**
 * The board, driving the fleet (KAN-221).
 *
 * The poller above watches the tickets of agents that already exist. This
 * decides which agents should exist at all: one bounded JQL a minute, and the
 * fleet converged toward the answer. See board-reconcile.ts for the algorithm,
 * the failed-read guard, and the decision that supervisors are not exempt.
 *
 * WHY THE DEFAULT IS `report` AND NOT `converge`
 *
 * Because the loop's first live cycle is the one that can do the most damage,
 * and because it already found the board wrong once: the spec's exact query,
 * run against the real board on 2026-08-08, was missing a ticket whose agent
 * was running — In Progress with no assignee — and step 4 would have stood that
 * agent down. Report-only makes the diff visible before it is expensive. A
 * machine whose board has been checked opts in with
 * `BUTCHR_BOARD_RECONCILE=converge`; `off` stops it reading Jira at all.
 *
 * Read on every cycle rather than captured once, so the mode is a property of
 * the environment the daemon is running in rather than of the moment it
 * started.
 */
function boardReconcileMode(): BoardMode {
  const raw = (process.env.BUTCHR_BOARD_RECONCILE ?? '').trim().toLowerCase();
  if (raw === 'converge' || raw === 'report' || raw === 'off') return raw;
  if (raw) {
    log(
      `[board] BUTCHR_BOARD_RECONCILE is set to "${raw}", which is not one of ` +
      `off | report | converge. Falling back to report — an unreadable setting ` +
      `is never a licence to start or stop agents.`
    );
  }
  return 'report';
}

/**
 * What the Agents page is told about the board's grip on the fleet (KAN-222).
 *
 * Deliberately built from `boardReconcileMode` — the *same function* the
 * reconciler below is constructed with, not a second read of the same env var.
 * That is the whole point of routing this through one function: if the mode the
 * page reports and the mode the loop obeys were two readings, they could differ,
 * and a UI confidently describing a mode the loop is not in is a worse failure
 * than the silence it replaced.
 *
 * A function declaration rather than a const because both `MessageRouter`
 * constructions above it need it, and hoisting is what lets this stay next to
 * the reconciler it describes rather than being hauled to the top of the file
 * away from its reason.
 */
function reportBoardControl(agents: AddressableAgent[]): BoardControlReport {
  return boardControlReport(boardReconcileMode(), agents);
}

const boardReconciler = new BoardReconciler({
  jira,
  // The same census the poller and the missing sweep read, and deliberately
  // `.agents` rather than the pane list: `unbackedPanes` are reported
  // separately and are not agents, so a loop that read panes would try to
  // stand down things nothing started.
  runningAgents: () =>
    daemonRouter.surveyFleet().agents.map((agent) => ({
      agentName: agent.agentName,
      type: agent.type,
      // The registry's spelling, for the reason the poller gives: an agent
      // *name* is built from a lower-cased key, and KAN-79 is not `kan-79`.
      key: daemonRouter.recordedKeyFor(agent.agentName) ?? agent.key
    })),
  activate: async (agent) => {
    let response: any = null;
    await daemonRouter.handleActivateByKey(
      {
        type: agent.type,
        key: agent.key,
        // No url. The registry maps URLs to keys, not the other way round, and
        // handleActivateByKey is explicit that a fabricated link is worse than
        // no link. The agent is told its key and finds its own ticket.
        //
        // No `activatedBy` either, and that is honest rather than an omission:
        // nothing staffed this agent. The board did, and the board is not an
        // agent with a pane to be accountable at. A supervisor of record
        // invented here would put a false parent in the org chart (KAN-145).
        //
        // No `override` and no `preempt`, ever. Capacity refusals are reported
        // and retried; see board-reconcile.ts.
        defaultAgent: 'claude'
      },
      (msg: any) => {
        response = msg;
      }
    );
    return {
      success: response?.success === true,
      ...(response?.error ? { error: response.error } : {}),
      ...(response?.refusedBy ? { refusedBy: response.refusedBy } : {})
    };
  },
  deactivate: async (agent) => {
    let response: any = null;
    daemonRouter.handleDeactivateByKey(
      { type: agent.type ?? undefined, key: agent.key },
      (msg: any) => {
        response = msg;
      }
    );
    return {
      success: response?.success === true,
      ...(response?.error ? { error: response.error } : {})
    };
  },
  mode: boardReconcileMode,
  isSupervisorType,
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

/**
 * How often the daemon closes a /proc/stat window for the CPU headroom term
 * (KAN-201). Five seconds: short enough that "cores in use" describes now
 * rather than the last minute — the complaint that retired the load average —
 * and long enough to be well above the sampler's own two-second floor.
 */
const CPU_SAMPLE_INTERVAL_MS = 5_000;

/** The open "before" side of the current window; null until the first tick
 * and after any sampling failure. */
let costWindow: MeasurementStart | null = null;
/** The damped estimate, unrounded. Null whenever capacity should answer from
 * the seed. */
let costEstimate: AgentCost | null = null;
/** Transition memory so the log records changes of state, not every quiet
 * minute of a healthy sampler. `restored` is its own state so the first real
 * window still announces itself, and so a degrade that discards a restored
 * estimate is not silent. */
let costSamplerState: 'no-measurement' | 'restored' | 'live' = 'no-measurement';

/**
 * Degrade, never guess: any failure — /proc unreadable, an empty fleet, a
 * sample that fails validation — clears the live measurement so capacity
 * falls back to MEASURED_AGENT_COST with the report labelling the figures as
 * seed. A stale estimate left posing as live would be the exact mislabelling
 * KAN-44 exists to correct.
 *
 * KAN-204: the persisted copy goes with it. The whole point of writing the
 * estimate down is that a restart is not new information; a sampler that has
 * just decided its estimate is untrustworthy *is* new information, and leaving
 * a copy on disk would let the next start resurrect exactly what this call
 * threw away.
 */
function degradeCostMeasurement(reason: string) {
  costEstimate = null;
  setMeasuredAgentCost(null);
  clearCostEstimate();
  if (costSamplerState !== 'no-measurement') {
    costSamplerState = 'no-measurement';
    log(`Agent-cost sampler: ${reason}; capacity answers from the seed constants until sampling recovers`);
  }
}

/**
 * Pick the damping filter's starting state back up from where the previous
 * daemon left it (KAN-204).
 *
 * Two things happen here and they are worth separating. The estimate becomes
 * the damping seed, so the first fresh window moves from what this fleet last
 * cost rather than from a July constant — that is the fix for the 25-minute
 * walk. It is *also* published immediately, so the sixty seconds before that
 * first window are answered from a real measurement of this fleet instead of
 * from the seed; without that the cap still collapses, just briefly.
 *
 * Publishing it is the part that needs the argument, since it is a figure
 * nobody re-checked. Three things bound it: it is labelled `restored` in every
 * report rather than `measured`, so nothing claims this daemon took it; it
 * expires (agent-cost-store.ts), so it can only ever be minutes old; and it is
 * still subject to the observed-CPU bound in capacity.ts, which does not care
 * where a figure came from. Sixty seconds later a real window replaces it.
 */
function restoreCostEstimate() {
  const restored = loadCostEstimate();
  if (!restored) return;
  costEstimate = { residentBytes: restored.residentBytes, cores: restored.cores };
  setMeasuredAgentCost(restored);
  costSamplerState = 'restored';
  log(
    `Agent-cost sampler: resumed from the estimate the previous daemon left in ` +
    `${COST_ESTIMATE_PATH} — ${Math.round(restored.residentBytes / (1024 * 1024))} MB / ` +
    `${restored.cores} core per tree, sampled ` +
    `${Math.round((Date.now() - restored.sampledAt) / 1000)}s ago. Reported as 'restored' until ` +
    `this daemon closes its own window`
  );
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
  // Written down as soon as it is published, so the copy on disk is never more
  // than one window behind the copy in memory (KAN-204).
  saveCostEstimate(published);
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

  // Pick the damping filter back up before the first window opens, so the
  // minute between now and the first fresh sample is answered from what this
  // fleet last cost rather than from the 2026-07-31 seed (KAN-204). No file, or
  // one too old to describe this machine, and this does nothing at all —
  // leaving exactly the behaviour of the line below.
  restoreCostEstimate();

  // Open the first cost window now rather than a minute from now; the first
  // damped figure lands one interval later. Until then — and whenever the
  // sampler degrades — capacity answers from the labelled seed.
  sampleFleetCost();
  const costSampler = setInterval(sampleFleetCost, COST_SAMPLE_INTERVAL_MS);
  costSampler.unref();

  // KAN-201's CPU headroom term divides by cores actually in use, which needs
  // two /proc/stat readings a window apart. readMachineFacts() advances the
  // same sampler on every capacity question, so this timer is not what makes
  // the measurement work — it is what makes the *first* question after a quiet
  // spell answerable from a window that closed seconds ago instead of from the
  // labelled load-average fallback. One 200-byte read every five seconds.
  sampleCpuBusy();
  const cpuSampler = setInterval(sampleCpuBusy, CPU_SAMPLE_INTERVAL_MS);
  cpuSampler.unref();

  // Unlike the two above, this one schedules its own next tick rather than
  // running on a fixed interval — it has to be able to slow down when Jira
  // says so. Its first tick is one interval away by design; see start().
  jiraPoller.start();

  // Schedules its own next cycle for the same reason the poller does, and its
  // first cycle is one interval away for a sharper one: the restoration above
  // is still running, and a reconciler that read the fleet mid-restore would
  // compute a diff against a fleet that is deliberately incomplete.
  boardReconciler.start();
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
