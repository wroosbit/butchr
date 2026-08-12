import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceRegistry, isSupervisorType } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge, agentNameFor } from './herdr.js';
import type { AgentRuntime } from './agent-runtime.js';
import { createAgentRuntime, type RuntimeSwitchReport } from './runtime-switch.js';
import { MessageRouter } from './router.js';
import { JiraIssueTypeService } from './jira.js';
import { CredentialStore } from './credentials.js';
import {
  LD_API_ORIGIN,
  LaunchDarklyIntegration,
  createLaunchDarklyIntegration
} from './integrations/launchdarkly.js';
import { createAtlassianIntegration } from './integrations/atlassian-integration.js';
// DEV_CHANNELS_FLAG IS DELIBERATELY NOT IMPORTED HERE (KAN-294). This file used
// to search a spawned command line for it; that consumer is gone, and so is the
// import, so a re-import is a diff a reviewer sees rather than a line that
// blends in. `verify-channel-spawn-verdict.mjs` §4 asserts the absence.
import { coreMcpServerDefinitions } from './launchers.js';
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
  carrierFor,
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
import { ChannelLivenessProbe } from './channel-liveness.js';
import {
  GuardianPoker,
  readGuardianConfig,
  writeGuardianConfig,
  setGuardian,
  clearGuardian
} from './guardian.js';
import { reconcileAgents } from './reconcile.js';
import { SupervisionNotifier } from './nudge.js';
import { PendingNotifications, channelNotifier } from './notify.js';
import { DAEMON_SENDER_TAG, senderTagFor } from './provenance.js';
import { JiraPoller } from './jira-poll.js';
import { PrWatcher } from './pr-watch.js';
import { GhCliGitHubReader } from './github.js';
import { BoardMode, BoardReconciler } from './board-reconcile.js';
import { AddressableAgent, BoardControlReport, boardControlReport } from './board-control.js';
import { CommentAuthorship } from './comment-authorship.js';
import { startMeasurement, finishMeasurement, MeasurementStart } from './agent-cost.js';
import {
  dampCost,
  sampleFromMeasurement,
  supervisorMemoryFromMeasurement
} from './agent-cost-damping.js';
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
// LaunchDarkly: a stored credential (KAN-86) and, since KAN-298, the ten reads
// `launchdarkly-proxy.ts` serves through it.
//
// THE ORIGIN OVERRIDE IS FOR PROOFS AND IS CLAMPED TO LOOPBACK. Nothing in
// normal operation sets it, and it defaults to LaunchDarkly's real API. It
// exists because the alternative — the shape LaunchDarkly's own credential
// path already rejected in `validateLdToken`'s docblock — is to exercise the
// 401 and 403 branches by firing invalid credentials at app.launchdarkly.com,
// and a proof should not need to do that.
//
// **The clamp is the whole of why this is safe to have**, and it is a clamp
// rather than a warning: a non-loopback value is refused and the default is
// kept, so this variable cannot redirect the daemon's LaunchDarkly traffic —
// credential and all — to a host somebody else chose. An override that could
// do that would be a credential-exfiltration primitive configured by an
// environment variable, which is a strictly worse thing than the exposure this
// ticket set out to remove.
const launchdarkly = new LaunchDarklyIntegration(undefined, ldApiOrigin());

function ldApiOrigin(): string {
  const raw = process.env.BUTCHR_LAUNCHDARKLY_API_ORIGIN;
  if (!raw || !raw.trim()) return LD_API_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    console.log(
      `launchdarkly: BUTCHR_LAUNCHDARKLY_API_ORIGIN="${raw}" is not a URL — ignoring it and using ` +
        `${LD_API_ORIGIN}.`
    );
    return LD_API_ORIGIN;
  }
  // Loopback only, by hostname rather than by resolution: a name that resolves
  // to 127.0.0.1 today is a name somebody else controls tomorrow.
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
  if (!loopback) {
    console.log(
      `launchdarkly: BUTCHR_LAUNCHDARKLY_API_ORIGIN="${raw}" is not a loopback address — REFUSED, ` +
        `using ${LD_API_ORIGIN}. This override exists for local proofs and must never be able to ` +
        "send the daemon's LaunchDarkly credential to another host."
    );
    return LD_API_ORIGIN;
  }
  console.log(`launchdarkly: API origin overridden to ${parsed.origin} (loopback; proofs only).`);
  return parsed.origin;
}

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
// KAN-278. Still exactly one construction site for the runtime — the property
// KAN-223 established and `verify-agent-runtime-seam.mjs` protects — but the
// choice of *which* runtime now lives behind it. `createAgentRuntime` returns
// `HerdrBridge` unless `BUTCHR_AGENT_RUNTIME=crabcast` says otherwise, and it
// returns the report describing what it chose from the same call, so the two
// cannot disagree. In the default case nothing here opens a CrabCast socket.
const { runtime: herdrBridge, report: agentRuntimeReport } = createAgentRuntime({ log });

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
 * Whether the durable registry expects this agent to be running (KAN-274).
 *
 * **The one fact that separates a lost registration from an address that never
 * had one**, and the reason KAN-274 needed no new persistence to find it. The
 * agent registry is a log on disk: it survives the restart that empties
 * `agentConnections`, and its `expected()` is precisely the set of agents that
 * were activated, have not been stood down, and therefore run a Butchr MCP server
 * that is supposed to be announcing itself on a socket.
 *
 * So an address that is in here with no connection has **lost** one — the state a
 * `steer` refuses rather than delivering by Ctrl+C. An address that is not in
 * here never had one: a `butchr-*` pane with nothing behind it, a human-activated
 * workspace that legitimately stays anonymous (`hello` with no identity is
 * refused, and that is correct), an agent started outside Butchr. Every one of
 * those keeps the composer it has always been reached by.
 *
 * Read fresh per call rather than cached, for the reason board-control.ts gives
 * about its mode: this decides whether a message is refused, and a set captured
 * at boot is stale in exactly the case that matters — an agent activated since.
 * `intents()` re-reads the log, which is a few KB and is already re-read on every
 * `list_agents`.
 */
/**
 * The set of expected agent names, re-derived only when the log has changed.
 *
 * `intents()` re-reads and re-parses `agents.jsonl` on every call — 0.93 ms
 * against the 114-entry log this was measured on, and the log grows to 500
 * records before compaction. {@link isManagedAgent} is asked once per row of
 * every `list_agents`, so an uncached read would put ~28 ms of re-parsing the
 * same file thirty times into a call a supervisor makes on a poll.
 *
 * **Keyed on the file's own mtime and size rather than on a timer**, so it is a
 * memo and not a cache with a staleness window: the moment anything appends an
 * activation the key changes and the next read is fresh. A time-based cache
 * would have been simpler and would have been a stored fact that outlives what
 * it describes, which is the artefact this codebase keeps paying for.
 */
let managedMemo: { key: string; names: Set<string> } | null = null;

function expectedAgentNames(): Set<string> {
  let key: string;
  try {
    const stat = fs.statSync(REGISTRY_PATH);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No registry file yet. Ask every time rather than memoising an absence:
    // the file appears the moment the first agent is activated.
    key = '';
  }
  if (key && managedMemo?.key === key) return managedMemo.names;

  const names = new Set<string>();
  for (const [name, intent] of agentRegistry.intents()) {
    if (intent.event === 'activated') names.add(name);
  }
  if (key) managedMemo = { key, names };
  return names;
}

function isManagedAgent(address: { type: string; key: string }): boolean {
  return expectedAgentNames().has(agentNameFor(address.type, address.key));
}

/**
 * The scheduled end-to-end channel probe (KAN-252).
 *
 * The startup self-check above proves four legs of the channel loop and cannot
 * reach the fifth — whether the client's dispatcher actually put the frame in
 * front of a model. Nothing observes that, and a break in it is silent. This
 * asks one agent, occasionally, to echo a token, and keeps the answer beside the
 * client version the self-check recorded for that agent.
 *
 * **It decides nothing.** It never degrades an agent, never changes a carrier
 * and never fails an activation — a model declining is a judgement call, not a
 * fault, and wiring a judgement call into the transport decision is exactly the
 * change KAN-252's own ticket forbids. It is a reader of two maps and a writer
 * of one record.
 */
const channelLiveness = new ChannelLivenessProbe({
  world: {
    // The same reader the launcher, the router and the self-check use.
    emissionEnabled: () => channelEmissionEnabled(),
    candidates: () =>
      agentConnections.addresses().flatMap((address) => {
        // A degraded agent is excluded because it is ON THE COMPOSER: the gate
        // would refuse its frame, and asking anyway would spend a run to learn
        // something `list_agents` already says. This is a reader of the same
        // verdict `routeChannelMessage` consults, not a second opinion on it.
        if (channelSelfChecks.degraded(address)) return [];
        // `addresses()` only returns agents that resolve, so this cannot be
        // undefined — it is asked anyway because the connection ID is what a
        // reader matches this run against in the daemon log, and inventing one
        // would be worse than dropping the candidate.
        const conn = agentConnections.resolve(address);
        if (!conn) return [];
        const report = channelSelfChecks.get(address);
        return [{
          address,
          connectionId: conn.id,
          // Carried from the startup self-check rather than re-derived. The
          // version pin is one fact and this is not a second source of it —
          // `null` here means "unchecked", which is what the row says too.
          clientName: report?.clientName ?? null,
          clientVersion: report?.clientVersion ?? null,
          clientVersionVerified: report?.clientVersionVerified ?? null
        }];
      }),
    // `recent-unwrapped`, through the same reader `butchr_tail_agent` uses, so
    // what this matches against is what a human would see if they looked.
    readPane: (address) => herdrBridge.tailAgent(address.key, address.type, 200).text ?? null,
    // THE CHANNEL, AND ONLY THE CHANNEL. A composer send types into the pane,
    // which is the surface this probe reads its answer off — it would write its
    // own token there and read it back as proof that a model had seen it. There
    // is no composer in `ChannelLivenessWorld` at all, deliberately.
    send: (address, content) => {
      const outcome = routeChannelMessage({
        registry: agentConnections,
        address,
        content,
        // A STRING, and the quotes are load-bearing (KAN-319). Meta entries
        // become attributes on the recipient's `<channel>` tag, so a boolean
        // here fails the client's parse and the whole frame is dropped in
        // silence — which is what this probe was reading as `no-answer`, the
        // state reserved for a model that declined.
        meta: { livenessProbe: 'true' },
        selfCheck: channelSelfChecks
      });
      return outcome.routed
        ? { routed: true }
        : { routed: false, reason: outcome.reason, detail: outcome.detail };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => log(message)
  }
});

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
    case 'channel_liveness': {
      // KAN-252's record, and — with `run: true` — a way to fire the shipped
      // probe now instead of waiting for its interval.
      //
      // Handled beside `channel_send` for the same reason: its subject is the
      // identity map and the connections in it, which the router deliberately
      // knows nothing about.
      //
      // **The forced run is the same code path the timer takes**, which is the
      // only thing that makes it legitimate: a "run it now" that went round the
      // scheduler would be a second implementation of the mechanism, and the one
      // nobody runs in production is the one that stays right (KAN-145). It is
      // how `probe-channel-liveness.mjs` gets a result in minutes rather than
      // hours, and how somebody looking at a drought asks again by hand.
      //
      // **It answers immediately and does NOT wait for the run.** A probe waits
      // up to ten minutes for a model, and a reply held open that long is a
      // socket call that every client's own timeout would abandon — after which
      // the run finishes into a connection nobody is reading. So this starts it
      // and says so; the caller polls this same action without `run` and watches
      // `state.runs` change. `running` is what tells a poller which it is
      // looking at.
      if (msg?.run === true) {
        // The two knobs a caller asking BECAUSE something looks wrong actually
        // wants, clamped rather than trusted: an unbounded window would let one
        // request hold the probe — which is single-flight — for as long as it
        // liked, and every scheduled run after it would find one in progress
        // and decline. Absent means the shipped default.
        const clamp = (v: unknown, lo: number, hi: number): number | undefined =>
          typeof v === 'number' && Number.isFinite(v)
            ? Math.min(hi, Math.max(lo, Math.round(v)))
            : undefined;
        const overrides = {
          answerWindowMs: clamp(msg.answerWindowMs, 5_000, 30 * 60_000),
          panePollMs: clamp(msg.panePollMs, 1_000, 60_000)
        };
        const started = !channelLiveness.isRunning();
        if (started) void channelLiveness.runOnce(overrides).catch(() => {});
        reply({
          action: 'channel_liveness_response',
          success: true,
          started,
          ...(started
            ? {}
            : { reason: 'already-running', error: 'a channel liveness probe is already running' }),
          running: channelLiveness.isRunning(),
          state: channelLiveness.state()
        });
        return true;
      }
      reply({
        action: 'channel_liveness_response',
        success: true,
        started: false,
        running: channelLiveness.isRunning(),
        state: channelLiveness.state()
      });
      return true;
    }
    case 'guardian': {
      // WHO IS WATCHING THE FLEET, AND THE THREE WRITES TO THAT (KAN-284).
      //
      // Handled here beside `channel_send` and `channel_liveness` rather than in
      // the router, for the same reason both of those are: its subject is the
      // identity map and the connections in it — a poke is a channel write — and
      // the router deliberately has no socket and knows nothing about either.
      //
      // The *read* is also on `list_agents` and on `status_response` for a board
      // page, through the same `guardianPoker.state()` reader. One state, three
      // surfaces; none of them derives its own answer, which is the rule
      // `carrierFor` exists to enforce elsewhere.
      const op = typeof msg?.op === 'string' ? msg.op : 'get';

      if (op === 'set') {
        const address = { type: msg?.type, key: msg?.key };
        const result = setGuardian({
          address,
          replace: msg?.replace === true,
          // WHO SET IT, FROM THE REQUEST RATHER THAN FROM THE BODY. Same
          // provenance rule as `handleSendToAgent`'s sender tag: the identity
          // is a statement about the *request*, which the butchr MCP attaches
          // off its own argv, so a caller cannot write itself down as somebody
          // else. The options page is unidentified and reads as such.
          setBy: senderTagFor({ type: msg?.workspaceType, key: msg?.workspaceKey }),
          intervalMs: typeof msg?.intervalMs === 'number' ? msg.intervalMs : null,
          now: () => Date.now(),
          read: () => readGuardianConfig(),
          write: (config) => writeGuardianConfig(config)
        });
        if (!result.ok) {
          // A REFUSAL, NOT AN ERROR CONDITION. `success: false` with the
          // condition named — AC4 asks for "a second guardian refused, with the
          // refusal naming the condition", and the incumbent is the condition.
          log(`[Guardian] set refused (${result.refusal}): ${result.detail}`);
          reply({
            action: 'guardian_response',
            success: false,
            op,
            refusal: result.refusal,
            error: result.detail,
            incumbent: result.incumbent,
            state: guardianPoker.state()
          });
          return true;
        }
        log(`[Guardian] ${result.detail}`);
        reply({
          action: 'guardian_response',
          success: true,
          op,
          config: result.config,
          replaced: result.replaced,
          detail: result.detail,
          state: guardianPoker.state()
        });
        return true;
      }

      if (op === 'clear') {
        const result = clearGuardian({
          read: () => readGuardianConfig(),
          write: (config) => writeGuardianConfig(config)
        });
        log(`[Guardian] ${result.detail}`);
        reply({
          action: 'guardian_response',
          success: true,
          op,
          cleared: result.cleared,
          detail: result.detail,
          state: guardianPoker.state()
        });
        return true;
      }

      if (op === 'poke') {
        // THE SAME CODE PATH THE TIMER TAKES, which is the only thing that makes
        // this legitimate: a "poke now" that went round the scheduler would be a
        // second implementation of the mechanism, and the one nobody runs in
        // production is the one that stays right (KAN-145). It is how a proof
        // gets a real delivery in seconds rather than thirty minutes, and how
        // somebody looking at an overdue guardian asks again by hand.
        //
        // Unlike `channel_liveness`, this ANSWERS WITH THE RESULT rather than
        // starting a run and returning: a poke is a single synchronous channel
        // write with no answer window to wait through, so there is nothing for a
        // caller to poll for.
        const result = guardianPoker.pokeOnce();
        reply({
          action: 'guardian_response',
          // `success` IS THE DELIVERY, and that is AC2 in one line: a poke to an
          // unregistered agent reports undelivered, not success. Nothing here
          // swallows KAN-274's refusal or converts it into a queued retry.
          success: result.delivered,
          op,
          result,
          ...(result.delivered ? {} : { error: result.detail }),
          state: guardianPoker.state()
        });
        return true;
      }

      reply({
        action: 'guardian_response',
        success: true,
        op: 'get',
        config: readGuardianConfig(),
        state: guardianPoker.state()
      });
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
// agent KAN-246 exists to prevent. So the test is on what the spawn itself
// decided. One fact, read from the thing itself.
//
// AND THE TEST IS THE SPAWN'S VERDICT, NOT A SEARCH OF ITS COMMAND LINE
// (KAN-294). This read `command.includes(DEV_CHANNELS_FLAG)` until 2026-08-11,
// which answered the right question by the wrong route: it inferred the decision
// from a shape only a `claude` command line has. `epic/KAN-59` is explicit that
// the shape does not generalise — "CrabCast has no DEV_CHANNELS_FLAG equivalent
// at all. The channel is not a command-line switch here — it is an MCP server
// entry." Against a spawn like that the sniff does not error, it returns early
// for every agent, so channel-startup supervision would simply never run and
// nothing would say so. A verdict cannot be absent by accident in that way.
//
// `!== true` RATHER THAN `=== false`, AND THAT IS THE THREE-STATE RULE (KAN-294).
// `channelEnabled` is `true | false | null` and `null` means NO SPAWN DECIDED —
// it is not "no channel". Both non-`true` values return here, because both mean
// "do not supervise a channel startup", but they mean it for different reasons
// and neither may be rewritten into the other on the way past. Collapsing them
// with `?? false` would be green on every agent anybody tests with and wrong on
// exactly the population the third state exists for. See AgentSpawn.
herdrBridge.setAgentSpawnedListener((session, spawnedAt, spawn) => {
  if (spawn.channelEnabled !== true) return;

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
      // Via the same reader `butchr_tail_agent` uses, so what this matches
      // against is what a human would see if they looked.
      //
      // THE `null` IS "COULD NOT LOOK" AND IS DERIVED FROM `success`, NOT FROM
      // THE TEXT BEING ABSENT (KAN-255). `ChannelStartupWorld.readPane` has
      // three meanings — text, an empty pane, and no reading at all — and the
      // last is `null`. Before `tailAgent` asked every source, a spurious empty
      // read arrived here as `''`, which is the SECOND of those: this loop
      // concluded no dialog and no prompt about a pane it had not really seen,
      // and `unreadable-pane` (which counts pane FAILURES) could never fire for
      // it. Reading `success` rather than `text ?? null` says that out loud
      // instead of leaving it to the shape of an optional field.
      readPane: () => {
        const tail = herdrBridge.tailAgent(session.key, session.type, 140);
        return tail.success && typeof tail.text === 'string' ? tail.text : null;
      },
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
          selfCheck: channelSelfChecks,
          // KAN-274. What separates "this agent lost its registration" from
          // "this address never had one": the durable registry survives the
          // restart that drops the connections, and it names exactly the agents
          // that run an MCP server and are therefore supposed to hold one.
          managed: isManagedAgent
        }),
      // KAN-274. The row and the route ask the same function, so a row cannot
      // report a carrier the next send will not take — which is what it did for
      // every agent that outlived a daemon restart.
      channelCarrier: (address, degraded) =>
        carrierFor({
          emissionEnabled: channelEmissionEnabled(),
          degraded,
          registered: agentConnections.resolve(address) !== undefined,
          managed: isManagedAgent(address),
          switchPath: CHANNEL_SWITCH_PATH
        }),
      // What each agent's startup self-check found, for `list_agents` (KAN-248).
      // A reader rather than the store, for the same reason `channelRoute` is a
      // closure: the router does not learn what a connection is.
      channelSelfCheck: (address) => channelSelfChecks.get(address) ?? null,
      // KAN-252's fleet-level record, on the same poll a supervisor already
      // makes. A reader rather than the probe itself, for the same reason
      // `channelSelfCheck` is a reader: the router does not learn what a
      // connection is, and must not be able to *start* a probe by accident.
      channelLiveness: () => channelLiveness.state(),
      // A READER, NOT THE POKER (KAN-284). The router reports who the guardian
      // is and whether its last poke landed; handing it the poker itself would
      // put "poke the guardian now" one typo away from a listing, and a poke
      // lands in a real agent's context. Same rule, same reason, as the line
      // above it.
      guardian: () => guardianPoker.state(),
      // Which runtime is serving (KAN-278). The report object itself, not a
      // reader: it was produced beside the runtime at the one construction
      // site, and passing the value is what makes it impossible for this
      // answer to describe a runtime other than the one in `herdrBridge`.
      agentRuntimeReport,
      // KAN-301. What the daemon has failed to tell somebody, so that an agent
      // which was never told is distinguishable from one that was told and had
      // nothing to do. A reader, so that a listing cannot flush or abandon
      // anything by accident.
      pendingNotifications: () => pendingNotifications.report(),
      // KAN-304. Whether the PR watcher can currently see GitHub, and since
      // when. A reader, like the two above, so that a listing cannot start or
      // perturb a watch by accident — and present so that "we have not been
      // able to look since 11:04" is answerable with the MCP tool rather than
      // only by someone who thinks to tail a log.
      prWatch: () => prWatcher.healthReport()
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
    boardControl: reportBoardControl,
    agentRuntimeReport
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
/**
 * How the daemon's own news reaches an agent (KAN-301).
 *
 * ONE ROUTE, SHARED BY BOTH PRODUCERS, AND NO PANE ANYWHERE IN IT
 *
 * The Jira poller and the supervision notifier below are the daemon's two
 * sources of unsolicited news, and until KAN-301 both delivered it by typing
 * into the recipient's terminal after a Ctrl+C. That cancelled whatever the
 * recipient was doing — 1,212 confirmed times since 2026-08-04 — and a cancelled
 * tool call renders to an agent as a refusal, so the daemon's own plumbing was
 * manufacturing refusals nobody made. See notify.ts for the full account and for
 * why holding an undeliverable notice beats both dropping it and interrupting.
 *
 * The route is the same `routeChannelMessage` that carries `butchr_send_to_agent`
 * — deliberately, and it is the KAN-145 argument again: a second implementation
 * of "which carrier, and is the gate open" is a second thing to keep in step by
 * hand, and the copy nobody routes on is the one that goes wrong. So the kill
 * switch, the self-check degradation and the `managed` predicate all apply here
 * exactly as they apply to a steer.
 *
 * `sender` is the daemon's own tag rather than an agent's: these messages are
 * the daemon speaking for itself, which is what `[butchr daemon]` means in
 * provenance.ts, and both producers already render it into the message text.
 */
const pendingNotifications = new PendingNotifications({ log });

const notificationRoute = (address: { type: string; key: string }, content: string) =>
  routeChannelMessage({
    registry: agentConnections,
    address,
    content,
    meta: {
      sender: DAEMON_SENDER_TAG,
      workspaceType: address.type,
      workspaceKey: address.key
    },
    selfCheck: channelSelfChecks,
    managed: isManagedAgent
  });

const notifyAgent = channelNotifier({
  route: notificationRoute,
  pending: pendingNotifications
});

const supervision = new SupervisionNotifier({
  herdrBridge,
  supervisorFor: (agentName) => daemonRouter.supervisorFor(agentName),
  recordedKeyFor: (agentName) => daemonRouter.recordedKeyFor(agentName),
  deliver: notifyAgent,
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
/**
 * The guardian's clock (KAN-284).
 *
 * The human asked for **one guardian agent, poked every thirty minutes**. The
 * argument for putting the clock here is measured: `epic/KAN-203` ran the same
 * supervision on a wakeup it scheduled for itself and it silently failed to fire
 * twice in one day, while the daemon's timers missed nothing across two capacity
 * outages, three restarts and a twelve-hour Atlassian blackout.
 *
 * **It points at an agent; it never makes one.** The guardian is a setting that
 * names an agent which already exists and already has its own ticket — the
 * human, relayed 2026-08-11: *"the guardian agent should pointed to an existing
 * agent, not a whole new agent."* Nothing in `GuardianWorld` can activate
 * anything, so a pointer at an agent that is not running produces a loud
 * `undelivered` rather than a daemon starting something to receive its own poke.
 *
 * **The channel and only the channel.** A poke on the composer would Ctrl+C the
 * guardian every thirty minutes by design — 48 destroyed tool calls a day,
 * delivered by the mechanism meant to keep the fleet healthy. It shares
 * `routeChannelMessage` with every other carrier decision for KAN-145's reason,
 * so the kill switch, the self-check degradation and the `managed` predicate all
 * apply to a poke exactly as they apply to a steer.
 *
 * **It is not wired to `notifyAgent`, and that is deliberate rather than an
 * oversight.** KAN-301's queue holds an undeliverable notice and retries it,
 * which is right for news and wrong for a poke: a poke is periodic, so the retry
 * already exists and is called the schedule, and holding one would convert
 * `undelivered` — the loudest state this feature has — into `pending`, which
 * reads as fine. See guardian.ts's header.
 */
const guardianPoker = new GuardianPoker({
  /**
   * How long after start-up the first poke fires, overridable for a proof.
   *
   * **A test affordance, and it is the FIRST delay rather than the interval on
   * purpose.** The interval is a real setting and belongs in `guardian.json`
   * where a human can see it; this is the one number that otherwise makes the
   * schedule unobservable — `probe-guardian-poke-delivery.mjs` §5 is the only
   * thing that exercises the TIMER rather than `op: 'poke'`, and without this it
   * would have to wait five minutes to do it, which means in practice nobody
   * would ever run it. Bounded so that a stray value cannot turn the schedule
   * into a busy-loop at a real agent's expense.
   */
  ...(process.env.BUTCHR_GUARDIAN_FIRST_POKE_MS
    ? {
        firstPokeDelayMs: Math.min(
          10 * 60_000,
          Math.max(1_000, Number(process.env.BUTCHR_GUARDIAN_FIRST_POKE_MS) || 0)
        )
      }
    : {}),
  world: {
    // The same reader the launcher, the router, the self-check and the liveness
    // probe use. One kill switch, read fresh, on every poke.
    emissionEnabled: () => channelEmissionEnabled(),
    // Read from disk per poke rather than captured at boot, so setting a
    // guardian from the options page takes effect at the next poke instead of
    // at the next restart — and a restart is the thing that drops every channel
    // registration in the fleet.
    readConfig: () => readGuardianConfig(),
    send: (address, content) => {
      const outcome = routeChannelMessage({
        registry: agentConnections,
        address,
        content,
        meta: {
          sender: DAEMON_SENDER_TAG,
          workspaceType: address.type,
          workspaceKey: address.key,
          // A STRING, and this one quote is the whole of KAN-319 (see
          // channel.ts on `ChannelMeta`). As a boolean it failed the client's
          // parse of the notification params, so every poke was written to a
          // live connection, recorded `delivered: true`, and discarded before it
          // reached a model — six times, across two agents and three
          // connections, while the fleet went unsupervised and every instrument
          // read green. It renders as `guardianPoke="true"` on the recipient's
          // `<channel>` tag, which is how a reader tells a poke from a notice.
          guardianPoke: 'true'
        },
        selfCheck: channelSelfChecks,
        // `managed` is what separates a guardian whose registration was dropped
        // by a restart from one that was never running at all. Both are
        // `undelivered`; the reason tells a reader which, and they send them to
        // different places.
        managed: isManagedAgent
      });
      return outcome.routed
        ? { routed: true, connectionId: outcome.connectionId }
        : { routed: false, reason: outcome.reason, detail: outcome.detail };
    },
    now: () => Date.now(),
    log: (message) => log(message)
  }
});

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
  // KAN-301. Same channel-only carrier as the supervision notifier above; see
  // its wiring for why there is one route rather than two.
  deliver: notifyAgent,
  log
});

/**
 * The third thing the fleet cannot see for itself: its own pull requests
 * (KAN-304).
 *
 * The poller above watches what a ticket *says*. This watches what a ticket
 * *produces* — and nothing did, which is why three pull requests merged on
 * 2026-08-11 and left their tickets reading In Review, and why an agent was
 * found hand-rolling a `gh pr view --json comments` loop in bash because no
 * watcher existed to do it.
 *
 * Same fleet census, same durable parentage, same delivery primitive, and
 * deliberately the same four relations — `own`, `supervisor`, `parent`,
 * `linked` — resolved off the facts `jiraPoller` has already read. `issueFacts`
 * is that reuse: the watcher makes **no Jira request of its own**, so watching
 * pull requests costs Jira nothing and costs GitHub one `gh pr list` per
 * repository per minute.
 *
 * `deliver: notifyAgent` is the hard condition this ticket was gated on. A PR
 * watcher on the composer would have been a fourth interrupting caller the day
 * after the human asked for the practice to end, and its Ctrl+C would have
 * landed on the agent working the very pull request being announced.
 */
const prWatcher = new PrWatcher({
  github: new GhCliGitHubReader({ log }),
  herdrBridge,
  liveAgents: () =>
    daemonRouter
      .surveyFleet()
      .agents.filter((agent) => agent.type)
      .map((agent) => ({
        agentName: agent.agentName,
        type: agent.type as string,
        key: daemonRouter.recordedKeyFor(agent.agentName) ?? agent.key
      })),
  issueFacts: (key) => jiraPoller.pollState().factsFor(key),
  supervisorFor: (agentName) => daemonRouter.supervisorFor(agentName),
  // KAN-301. The same channel-only carrier as the other two producers; there is
  // one route rather than three, and no argument here can make it a pane write.
  deliver: notifyAgent,
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

  // KAN-301. The redelivery leg: anything the channel would not take is held,
  // and this is the tick that tries it again. On the missing-agent sweep rather
  // than on a timer of its own because a held notice is waiting for a
  // registration to come back, KAN-274 measured that happening within seconds,
  // and 30s is already far tighter than the 15-minute window a notice is worth
  // delivering in. Synchronous and cheap — `routeChannelMessage` is a map lookup
  // and a socket write, with no pane to poll and nothing to await.
  try {
    pendingNotifications.flush(notificationRoute);
  } catch (e: any) {
    log('Held-notification flush failed:', e?.message ?? String(e));
  }

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
    // What keeps epic and story trees out of the divisor (KAN-276). Passed
    // rather than imported by agent-cost.ts because supervisor-ness is registry
    // state that only a booted daemon has; see IsSupervisorType there.
    //
    // `registry.declaresSupervisor` and not the free `isSupervisorType`: the
    // latter answers from *registered* types, so switching Atlassian off while
    // epic and story agents are still running would put their trees back in the
    // divisor with nothing saying so. See that method for the argument.
    measurement = costWindow
      ? finishMeasurement(costWindow, (t) => registry.declaresSupervisor(t))
      : null;
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
      measurement.chargeable.agents <= 0
        ? // Named separately from an empty machine because it is now a state a
          // busy fleet reaches: supervisors running and no task agent among
          // them. The seed is the honest answer for the *next* task agent, and
          // the reading that filed KAN-276 is what the alternative looks like —
          // 0.123 core/agent published with `running: 0`, averaged entirely
          // over supervisors.
          measurement.totals.agents > 0
          ? `no task-agent trees to measure (${measurement.supervisors.agents} supervisor(s), ` +
            `${measurement.unmarked.agents} unmarked tree(s) held out)`
          : 'no agent trees running, nothing to measure'
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
  const supervisorMemory = supervisorMemoryFromMeasurement(measurement, os.totalmem());
  const published = {
    residentBytes: Math.round(costEstimate.residentBytes / (1024 * 1024)) * 1024 * 1024,
    cores: Math.round(costEstimate.cores * 1000) / 1000,
    sampledAt: Date.now(),
    windowSeconds: measurement.elapsed,
    // The two figures above are averaged over two different populations since
    // KAN-276 — cores over the task-agent trees, memory over all of them — so
    // both counts are published rather than one standing in for both.
    agentTrees: measurement.chargeable.agents,
    memoryAgentTrees: measurement.totals.agents,
    // Undamped, deliberately. The damping exists to stop one flattering window
    // opening the cap (agent-cost-damping.ts); this figure only ever makes the
    // cap smaller, so a filter that is slow to believe it would be slow in the
    // unsafe direction. It is also far steadier than the CPU figure it rides
    // beside: a supervisor's memory is what the binary holds, not what it is
    // doing.
    supervisorResidentBytes: supervisorMemory
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
      // KAN-258: counted and named separately from failures, and named *by
      // key*, because this is the line an operator reads after a cold boot to
      // find out why the fleet is smaller than the board. A count alone would
      // say the machine held back without saying who it held back.
      const deferred = result.outcomes.filter((o) => o.result === 'deferred');
      const idle = restored.filter((o) => o.resumedConversation && o.nudged === false);
      log(
        `[reconcile] Done: ${result.expected} expected, ` +
        `${restored.length} restored, ` +
        `${result.outcomes.filter((o) => o.result === 'already-running').length} already running, ` +
        `${deferred.length} deferred for capacity, ` +
        `${failed.length} failed.` +
        (deferred.length
          ? ` The machine would not carry ${deferred.length} of them yet, so restoration ` +
            `converged toward the recorded fleet rather than jumping to it: ` +
            deferred.map((o) => `${o.type}/${o.key}`).join(', ') +
            `. They stay recorded as active and are reported under missingAgents; ` +
            `board-keyed ones are retried by the board reconciler within a cycle. ` +
            `Nothing was overridden (KAN-258).`
          : '') +
        (idle.length
          ? ` ${idle.length} restored agent(s) could not be told to carry on and may be idle: ` +
            idle.map((o) => o.agentName).join(', ')
          : '')
      );
      // WHAT THE RESTART DROPPED, COUNTED AT THE MOMENT IT DROPPED IT (KAN-274).
      //
      // The line above is true and was misleading in the same breath: `0 failed`
      // is a statement about *agents*, and the agents really did survive. What
      // did not survive is every one of their channel registrations, and until
      // this ticket nothing said so — on 2026-08-11 four agents came through a
      // restart, `0 failed`, and the fleet was addressable by nobody for 291
      // seconds with no line anywhere to say it.
      //
      // Derived rather than remembered: this daemon never saw the old
      // registrations, so it cannot count what *it* lost. It counts what is
      // missing now — surviving agents holding no connection — which is the same
      // number and is a fact this process can actually observe. Saying it any
      // other way would be inventing a memory of a predecessor.
      const survivors = result.outcomes.filter((o) => o.result === 'already-running');
      const unregistered = survivors.filter(
        (o) => agentConnections.resolve({ type: o.type, key: o.key }) === undefined
      );
      if (unregistered.length) {
        log(
          `[reconcile] ${unregistered.length} of ${survivors.length} surviving agent(s) hold no ` +
          `channel registration: ${unregistered.map((o) => `${o.type}/${o.key}`).join(', ')}. ` +
          `A daemon restart drops every one — the agents are fine and are simply not addressable ` +
          `over the channel until each one's MCP server re-announces itself, which it now does by ` +
          `itself within seconds rather than waiting for the agent's next tool call. Until then a ` +
          `steer to one is REFUSED rather than delivered by a composer interrupt, and ` +
          `butchr_list_agents reports transport 'unregistered' on its row (KAN-274).`
        );
      } else if (survivors.length) {
        log(
          `[reconcile] All ${survivors.length} surviving agent(s) hold a channel registration.`
        );
      }
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

  // Schedules its own next tick for the same reason the poller does — it has to
  // be able to slow down when GitHub says so — and its first look is one
  // interval away for the same reason too: the fleet is still being restored,
  // and the repositories it watches are discovered from live agents' checkouts.
  prWatcher.start();

  // Schedules its own next cycle for the same reason the poller does, and its
  // first cycle is one interval away for a sharper one: the restoration above
  // is still running, and a reconciler that read the fleet mid-restore would
  // compute a diff against a fleet that is deliberately incomplete.
  boardReconciler.start();

  // KAN-252. Started unconditionally rather than behind the channel switch: the
  // switch is read fresh on every run, so a probe that started while channels
  // were off would begin working the moment they were turned on, and one gated
  // at boot would stay dead until the daemon restarted. A run with the switch
  // off costs one file read and records `channel-disabled`.
  channelLiveness.start();
  // The guardian's clock (KAN-284). Started here with the other schedules; it
  // does nothing at all until a guardian is configured, and says so once in the
  // log rather than silently.
  guardianPoker.start();
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
