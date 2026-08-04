import * as fs from 'fs';
import { WorkspaceRegistry, isSupervisorType } from './registry.js';
import { PromptLoader } from './prompt.js';
import { JiraIssueTypeService } from './jira.js';
import { LaunchDarklyIntegration } from './integrations/launchdarkly.js';
import { Integration, McpServerDefinitions } from './integrations/integration.js';
import { coreMcpServerDefinitions } from './launchers.js';
import {
  HerdrBridge,
  HerdrSession,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  addressFromAgentName,
  agentNameFor,
  typeFromAgentName,
  workspaceDirFor
} from './herdr.js';
import { readWorkState } from './work-state.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import {
  AgentRecord,
  AgentRegistry,
  PreemptionRecord,
  SupervisorOfRecord,
  sameSupervisorOfRecord,
  toSupervisorOfRecord
} from './agent-registry.js';
import { ResumeCause } from './resume.js';
import { nudgeResumedAgent } from './nudge.js';
import {
  PreemptionCandidate,
  addressOf,
  describeCandidate,
  describeFleetPriorities,
  noVictimReason,
  preemptionOffer,
  selectVictim
} from './priority.js';
import { getStalenessReport, StalenessReport } from './staleness.js';
import {
  Capacity,
  capacityReason,
  capacityRefusal,
  describeCapacity,
  readCapacity,
  summarizeCapacity
} from './capacity.js';

type Respond = (msg: any) => void;

/**
 * What the UI is told about a session. Sessions are never sent over the wire
 * directly: they carry a ~100KB ptyBuffer and a live ptyProcess handle, and
 * the Agents page polls list_agents every 2s.
 */
interface AgentDto {
  sessionId: string;
  type: string;
  key: string;
  /** Absent when the session was activated by key without a known page URL. */
  url?: string;
  createdAt: string;
  status: HerdrSession['status'];
  workDir: string;
  herdrStatus: HerdrAgentStatus;
}

/**
 * One row of `list_agents`. Two kinds of entry share this shape, and the
 * difference between them is the point of the field that names it:
 *
 * - `sessionless: false` — this daemon holds the agent's terminal attach, so
 *   every field is populated from the session it owns.
 * - `sessionless: true` — the agent is alive in herdr but no session of ours
 *   describes it, which is every surviving agent after a daemon restart. The
 *   session-only fields are null because there is no session, not because the
 *   agent is impaired.
 *
 * Nulls are explicit rather than omitted, for the reason HerdrAgentDescription
 * gives: over JSON an absent field reads as "not answered", and these are
 * answered — with nothing.
 */
interface ListedAgent {
  sessionless: boolean;
  agentName: string;
  sessionId: string | null;
  type: string | null;
  key: string;
  url: string | null;
  createdAt: string | null;
  status: HerdrSession['status'] | null;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
  /** herdr's own `agent` field: the CLI running in the pane, null for a shell. */
  agentRuntime: string | null;
  /**
   * Whether this agent supervises its own children rather than doing the work
   * itself.
   *
   * Sent so a client does not have to know which workspace types those are.
   * KAN-38 put an Off button next to every row including the supervisors',
   * and the guard on those rows has to be different in kind — stopping one
   * stops the thing that hands work out. A UI deciding that from a hardcoded
   * list of types would be a second copy of a rule that lives with the
   * workspace type itself (`supervisor: true`, declared by the integration
   * that owns the type and answered by `isSupervisorType` in registry.ts), and
   * the copy is the one that gets forgotten when a supervisor type is added.
   */
  supervisor: boolean;
  /**
   * The agent whose activation call started this one, or `null` when nobody's
   * did. See {@link AgentRecord.activatedBy} for what is and is not recorded.
   *
   * Read off the registry on every poll rather than cached here, so a parent
   * written down after this daemon booted shows up on the next list without a
   * second copy of the fact existing to go stale. It is the only edge the
   * Agents page's org chart draws with — the extension makes no Jira call and
   * infers nothing from key or type — so an agent whose parent this does not
   * name renders at top level.
   *
   * `null` rather than an omitted key, for the reason the doc comment above
   * gives and for one more specific to this field: an older daemon sends no
   * `activatedBy` at all, and the page tells "this agent has no parent" from
   * "this daemon cannot answer that" by exactly that difference.
   */
  activatedBy: SupervisorOfRecord | null;
}

/**
 * A `butchr-*` pane that is not an agent by any test we can apply: herdr
 * reports no agent running in it and this daemon holds no session for it.
 * Reported separately rather than dropped — see handleListAgents.
 */
interface UnbackedPane {
  agentName: string;
  type: string;
  key: string;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
  reason: string;
}

/**
 * The addressing convention shared by every agent-targeted action: a key is
 * required, a type is optional but must be meaningful when present. Returns
 * the complaint, or null when the address is usable.
 */
/**
 * The capacity numbers as they go over the wire.
 *
 * Flat and named rather than nested, because the caller most likely to read
 * this is a language model deciding whether to staff another agent, and the
 * fields it needs — `headroom`, `atCapacity`, `summary` — should not be at the
 * end of a path. `summary` is the same figures in a sentence: a caller that
 * ignores every number still cannot ignore that one.
 */
function capacityDto(c: Capacity) {
  return {
    cap: c.cap,
    running: c.running,
    supervisors: c.supervisors,
    headroom: c.headroom,
    atCapacity: c.atCapacity,
    capBoundBy: c.capBoundBy,
    headroomBoundBy: c.headroomBoundBy,
    // The one sentence a UI with a single line to spare can render. Sent on
    // every capacity payload rather than only on refusals, because the panel
    // that has to explain a refused toggle should not have to parse the reason
    // out of a paragraph of derivation.
    reason: capacityReason(c),
    cores: c.machine.cores,
    load1: Math.round(c.machine.load1 * 100) / 100,
    totalMb: Math.round(c.machine.totalBytes / (1024 * 1024)),
    availableMb: Math.round(c.machine.availableBytes / (1024 * 1024)),
    agentMemoryMb: Math.round(c.cost.residentBytes / (1024 * 1024)),
    agentCores: c.cost.cores,
    // Where the two cost figures came from (KAN-56): 'override', 'measured'
    // or 'seed', plus the sample's metadata when a measurement was consulted.
    // A caller deciding whether to trust the cap can see whether anyone
    // measured it.
    agentMemorySource: c.costSource.residentBytes,
    agentCoresSource: c.costSource.cores,
    measuredAt: c.measured ? new Date(c.measured.sampledAt).toISOString() : null,
    measuredWindowSeconds: c.measured ? Math.round(c.measured.windowSeconds) : null,
    measuredAgentTrees: c.measured ? c.measured.agentTrees : null,
    capByCpu: c.capByCpu,
    capByMemory: c.capByMemory,
    headroomByCap: c.headroomByCap,
    headroomByLoad: c.headroomByLoad,
    headroomByMemory: c.headroomByMemory,
    summary: summarizeCapacity(c)
  };
}

function invalidAddress(key: unknown, type: unknown): string | null {
  if (typeof key !== 'string' || !key.trim()) return 'Missing or invalid key';
  if (type !== undefined && (typeof type !== 'string' || !type.trim())) {
    return 'Invalid type: expected a non-empty string';
  }
  return null;
}

/**
 * An agent the registry says should be running that herdr does not have.
 *
 * This is the whole of the detectability half of KAN-21, as data. On the day
 * that ticket was written two agents ceased to exist and the board read healthy
 * for twenty minutes; the loss was found only because a human thought to ask.
 * The registry is what makes the question answerable without asking — it holds
 * the *intended* fleet, and anything in it that herdr cannot show is a loss,
 * reported on every `list_agents` poll rather than written to a log.
 */
interface MissingAgent {
  agentName: string;
  type: string;
  key: string;
  workDir: string;
  url: string | null;
  /** When the registry last recorded this agent as activated. */
  since: string;
  reason: string;
  /**
   * Who activated it, from the same record that says it should be running.
   * Carried here for the same reason as on {@link ListedAgent}: a loss is
   * owed to whoever staffed the work, and the tree that shows it has to be
   * able to put the row under that agent.
   */
  activatedBy: SupervisorOfRecord | null;
}

/**
 * An agent somebody deliberately switched off, that could be switched back on.
 *
 * KAN-38 asked where the *on* half of a fleet switch gets its candidates from,
 * because the Agents page lists what is running and a stopped agent is by
 * definition not in that list. The answer is KAN-21's registry, and this is the
 * third of the three ways it can answer "not running":
 *
 *   - {@link MissingAgent}    — recorded active, absent anyway. A loss.
 *   - preempted (see below)   — stood down so something else could run. A debt.
 *   - StandbyAgent            — stood down because a person said so.
 *
 * The three are disjoint on purpose, so no agent grows two switches. This one
 * is what makes Off reversible from the page that offers it: without it,
 * turning an agent off here would drop it off every list the page renders and
 * there would be no way back except finding its Jira tab again.
 *
 * Only agents whose workspace still exists are offered. A `reset` also records
 * a stand-down, and the directory it deleted is the evidence that "turn this
 * back on" is not what anyone means by it.
 */
interface StandbyAgent {
  agentName: string;
  type: string;
  key: string;
  workDir: string;
  url: string | null;
  /** Which launcher it last ran, so it comes back as what it was. */
  defaultAgent: string | null;
  /** When the registry recorded the stand-down. */
  since: string;
  reason: string;
  /**
   * Who activated it, kept across the stand-down because the stand-down did
   * not change who staffed it. A story switched off under a live epic is
   * information — it says the epic has a child and the child is off — and
   * without this the tree could only show it as a rootless orphan.
   */
  activatedBy: SupervisorOfRecord | null;
}

/**
 * How many stood-down agents `list_agents` will carry. The registry compacts
 * at 500 records, so this is bounded already — the cap is about the 2s poll,
 * not about the log. Anything beyond it is *counted* rather than dropped
 * silently: see `standbyTotal`.
 */
const STANDBY_LIMIT = 25;

/**
 * What the caller is told about the agent it could stand down, when it is at
 * capacity and outranks something.
 *
 * Sent on the *refusal*, not after the fact. Preemption is opt-in per
 * activation for the same reason KAN-36 made refusals visible: someone toggling
 * an agent on must not silently destroy another agent's uncommitted work. This
 * is the sentence the sidepanel turns into a named button, and its presence in
 * the payload is what the consent criterion is satisfied by.
 */
interface PreemptionOfferDto {
  agentName: string;
  type: string | null;
  key: string;
  priority: number;
  herdrStatus: HerdrAgentStatus;
  /** The priority of the activation being refused, for the comparison. */
  incomingPriority: number;
  /** One sentence naming what would be stood down and what authorises it. */
  offer: string;
}

/** What {@link MessageRouter.capacityGate} decided, and why. */
interface CapacityGateResult {
  capacity: Capacity;
  /** The refusal to send back, or null when the activation may proceed. */
  refusal: string | null;
  /** Set when it may proceed only because the caller deliberately said so. */
  overrode: { at: string; derivation: string } | null;
  /**
   * Set on a refusal that preemption could lift. Null both when there is
   * nothing to preempt and when preemption already happened.
   */
  preemptable: PreemptionOfferDto | null;
  /** Set when an agent was actually stood down to make this room. */
  preempted: { at: string; victim: PreemptionOfferDto; derivation: string } | null;
}

/** Everything the capacity gate needs to know about the activation it is judging. */
interface GateRequest {
  /** `task/KAN-99`, for the refusal prose. */
  what: string;
  type: string;
  key: string;
  agentName: string;
  /** What this activation outranks. See priority.ts. */
  priority: number;
  /** Start it past the cap without freeing anything. */
  override: unknown;
  /** Free a slot by standing down something this activation outranks. */
  preempt: unknown;
}

/**
 * The refusal for an integration id this daemon does not know. Names the
 * known ids so a typo'd caller learns the vocabulary from the error itself.
 */
function unknownIntegration(integration: string): string {
  return `Unknown integration: ${integration || '(none given)'}. Known integrations: jira, launchdarkly.`;
}

/**
 * The refusal for a page — or a type — whose integration is switched off.
 *
 * A Jira URL failing as "unsupported URL" when the user has merely turned
 * Atlassian off is a lie, and an expensive one: it sends someone looking for a
 * pattern bug that is not there. Disabled integrations keep their patterns for
 * exactly this, never for matching, so the refusal can name the real cause and
 * the fix. KAN-91 renders this verbatim.
 */
function integrationDisabled(name: string, what: string): string {
  return (
    `The ${name} integration is switched off, so ${what} does not open a workspace. ` +
    `Turn ${name} back on in Butchr's settings to activate it again. ` +
    `Agents that are already running are unaffected.`
  );
}

/**
 * An integration's workspace types, as `list_integrations` reports them.
 *
 * `resolution` says how a page becomes this type: `url-matched` types own URL
 * patterns; the pattern-less ones are reached only by refining a URL match
 * against what the integration knows the entity really is (see
 * atlassian-integration.ts on why a Story's URL is byte-identical to a Task's).
 * Derived from the config rather than declared, which is the meaning this
 * field has always carried.
 *
 * Ordered by descending priority — epic, story, task for Jira — which is the
 * order the settings page has always rendered and the order the scale reads
 * in. Registration order is deliberately not used: it is the order that
 * matters to URL matching, and a UI list is not the place to expose it.
 */
function providedTypesOf(integration: Integration): Array<{
  type: string;
  name: string;
  resolution: 'url-matched' | 'refined-from-issue-type';
  priority: number;
  supervisor: boolean;
}> {
  return [...integration.workspaceTypes]
    .sort((a, b) => b.priority - a.priority)
    .map((config) => ({
      type: config.type,
      name: config.name,
      resolution: (config.urlPatterns.length > 0
        ? 'url-matched'
        : 'refined-from-issue-type') as 'url-matched' | 'refined-from-issue-type',
      priority: config.priority,
      supervisor: !!config.supervisor
    }));
}

/**
 * One MCP server, as `list_integrations` reports it — the settings page's half
 * of KAN-85.
 *
 * KAN-87 shipped an integration's `providedTypes`; KAN-106 gives the same
 * treatment to the other, more consequential half of what enabling an
 * integration does, which is hand every agent this daemon spawns a new set of
 * tools. A name alone answers "which server", so the name is always here; the
 * command and its arguments answer "what is it, actually" — `npx -y mcp-remote
 * https://mcp.atlassian.com/v1/mcp` tells a reader that Atlassian's tools come
 * over a remote endpoint — and those are here whenever they can be shown
 * safely. See `providedMcpServersOf` for when they cannot.
 */
export interface ProvidedMcpServer {
  /** The key of the `mcpServers` entry — a literal in the integration's source. */
  name: string;
  /** The resolved executable. Absent when detail is withheld. */
  command?: string;
  /** Its arguments, verbatim. Absent when detail is withheld. */
  args?: string[];
  /**
   * Set when only the name could be reported, so the UI says so rather than
   * silently drawing a server with no detail.
   */
  detailWithheld?: true;
}

/**
 * An integration's MCP servers, in the shape above — and the one place that
 * decides how much of a server definition is safe to send to a UI.
 *
 * THE RULE: a definition carrying `env` is reported as its **name only**.
 *
 * WHY, AND WHY THE TEST IS STRUCTURAL. A server provider is a closure over its
 * integration (see `McpServerProvider`), so it can build a definition out of
 * the stored credential — that is what a credential is *for* here. The daemon
 * cannot detect a secret by looking at the value: a `CredentialAdapter` never
 * hands back the secret, by design, so there is nothing to compare a string
 * against. What is left is where a credential can arrive, and the house
 * convention is `env` — an environment variable the agent's MCP client sets,
 * not a plaintext argv parameter (integration.ts says exactly this about why
 * Butchr writes per-workspace 0600-sourced config rather than registering a
 * vendor server globally). So `env` is treated as the mark of a
 * credential-configured definition and closes the whole definition down to its
 * name, and `env` itself — keys as well as values — is never reported at all.
 *
 * That is deliberately blunt in the safe direction. A definition with a
 * perfectly innocuous `env` loses its command line here, which costs a line of
 * display; the opposite mistake costs a token in a settings page.
 *
 * THE LIMIT, STATED SO THE NEXT AUTHOR KEEPS THE CONVENTION: an integration
 * that baked a token into `args` instead — `--header "Authorization: Bearer …"`
 * is a real MCP pattern — would defeat this, because nothing here can tell that
 * string from a URL. If you write such a definition, do not rely on this
 * function to notice: give it an `env` (which is where it belongs and which
 * this rule already covers).
 *
 * Today's definitions were checked against this before it was written.
 * Atlassian's carries no token and no `env` at all — the official Atlassian MCP
 * is a remote endpoint and mcp-remote does its own OAuth (see
 * atlassian-integration.ts) — so its command and args are reported in full.
 * LaunchDarkly provides no servers yet, and the core `butchr` server is
 * `process.execPath` plus a path to the daemon's own mcp.js.
 *
 * KAN-145 had to carry a workspace's identity into its own MCP server process
 * and deliberately did **not** use `env` for it, so this rule is untouched and
 * no exemption was carved for the core server. The identity rides in `args`
 * (`--workspace-type task --workspace-key KAN-1`) because it is provably not a
 * secret — it is the ticket key, already rendered on every surface — and
 * because putting it in `env` would have closed `butchr`'s command line down to
 * its name here for no security reason at all. A plumbing change must not be
 * allowed to buy itself a loosened security rule; see `withWorkspaceIdentity`
 * in launchers.ts for the full argument. Note that what this function is handed
 * for the settings page is `coreMcpServerDefinitions()` — the unstamped
 * definition, since "what every agent gets" has no one workspace to name.
 */
function describeMcpServers(defs: McpServerDefinitions): ProvidedMcpServer[] {
  return Object.entries(defs).map(([name, definition]) => {
    if (definition.env && Object.keys(definition.env).length > 0) {
      return { name, detailWithheld: true as const };
    }
    return { name, command: definition.command, args: [...definition.args] };
  });
}

/**
 * What this integration would give every spawning agent.
 *
 * "Would": reported whether or not the integration is switched on, exactly as
 * `providedTypes` is and for the same reason — a switch is only a choice if
 * what it turns on is legible before it is flipped. The registry is what
 * actually gates them (enabled, and configured where there is a credential);
 * this is the settings page's description of them, not the assembly.
 */
function providedMcpServersOf(integration: Integration): ProvidedMcpServer[] {
  return describeMcpServers(integration.mcpServers?.() ?? {});
}

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  constructor(
    private registry: WorkspaceRegistry,
    private promptLoader: PromptLoader,
    private herdrBridge: HerdrBridge,
    private send: (msg: any) => void,
    private broadcast: (msg: any) => void = send,
    private jira?: JiraIssueTypeService,
    /**
     * Where this daemon is installed and when it started — everything the
     * staleness check needs. Absent in the unit-test constructions that do not
     * care, in which case the check is simply not offered.
     */
    private install?: { repoRoot: string; daemonStartedAt: Date },
    /**
     * The durable record of which agents should exist. Optional for the same
     * reason `install` is — the unit-test constructions do not care — and when
     * absent nothing is recorded and nothing is reported missing, which is
     * exactly the pre-KAN-21 behaviour.
     */
    private agentRegistry?: AgentRegistry,
    /**
     * Optional exactly as `jira` is: a construction that does not pass one
     * simply answers "no LaunchDarkly credential support" on the credential
     * actions, and `list_integrations` reports the integration unavailable.
     */
    private launchdarkly?: LaunchDarklyIntegration
  ) {}

  /**
   * Write an activation down before it is acknowledged.
   *
   * Called on every successful activate, but only appends when it would change
   * something: re-attaching to an agent already recorded as activated is a
   * no-op, and the sidepanel re-activates often enough that recording each one
   * would fill the log with restatements of the same intent.
   */
  private rememberActivated(incoming: AgentRecord): void {
    if (!this.agentRegistry) return;
    const current = this.agentRegistry.intents().get(incoming.agentName);

    // A parent already recorded is not un-recorded by a request that simply
    // does not know one. The sidepanel calls `activate` every time a human
    // opens the agent's Jira tab, and those calls carry no caller identity —
    // so without this, looking at a supervised agent's ticket would quietly
    // orphan it, and the Agents page's org chart would lose the edge between
    // one visit and the next. Only an activation that *names* a supervisor
    // changes who the supervisor is; nothing here invents one.
    const record: AgentRecord = {
      ...incoming,
      activatedBy: incoming.activatedBy ?? current?.record.activatedBy ?? null
    };

    if (
      current?.event === 'activated' &&
      current.record.workDir === record.workDir &&
      current.record.url === record.url &&
      current.record.defaultAgent === record.defaultAgent &&
      // Part of the comparison, not merely part of the record: an agent first
      // activated parentless — by a human, from the sidepanel — and later
      // re-activated by the supervisor that adopted it would otherwise match on
      // the three fields above, be treated as a restatement, and never have its
      // parent written down at all.
      sameSupervisorOfRecord(current.record.activatedBy, record.activatedBy)
    ) {
      return;
    }
    this.agentRegistry.recordActivated(record);
  }

  /**
   * Who activated this agent, as far as the daemon can honestly tell.
   *
   * Two sources, in order. An explicit `activatedBy` is restoration: boot-time
   * reconciliation re-runs an activation somebody else originally made, and it
   * passes the parentage it read out of the registry so a reboot does not
   * orphan a fleet that had parents before the power went out. Otherwise the
   * answer is the caller's own identity, which the butchr MCP attaches to every
   * request it makes (`workspaceType`/`workspaceKey`, mcp.ts) — so a story
   * agent staffing a task is recorded as that task's supervisor by the ordinary
   * act of staffing it, with nothing new for it to remember to send.
   *
   * A request carrying neither has no supervisor of record and gets `null`: the
   * sidepanel and the Agents page are humans, and a human activation has no
   * parent. Nothing is invented for it.
   *
   * An agent that activates itself is nobody's child either. Recording that
   * would make it its own supervisor, and the notifier would then send it
   * bulletins about itself — the self-nudge loop the storm guards exist to
   * prevent, seeded at the point where the fact is first written down.
   */
  private supervisorOfRecord(data: any, agent: { type: string; key: string }): SupervisorOfRecord | null {
    const claimed =
      toSupervisorOfRecord(data?.activatedBy) ??
      toSupervisorOfRecord({ type: data?.workspaceType, key: data?.workspaceKey });
    if (!claimed) return null;
    if (agentNameFor(claimed.type, claimed.key) === agentNameFor(agent.type, agent.key)) {
      console.warn(
        `[Router] Ignoring a self-referential supervisor of record: ` +
        `${claimed.type}/${claimed.key} cannot have activated itself.`
      );
      return null;
    }
    return claimed;
  }

  /**
   * Write a stand-down down, so reconciliation leaves this agent alone.
   *
   * This is the half of the registry that makes it *intent* rather than
   * history: without it, boot-time restoration would resurrect every agent
   * anyone had ever run. Recorded even when the teardown failed — the caller
   * asked for the agent to be gone, and that is the intent to honour.
   *
   * Everything the last activation knew is carried onto the stand-down, and
   * that is not tidiness. `AgentRecord` is the argument list of an activation,
   * and `defaultAgent` is one of its arguments: an agent recorded without it
   * and then switched back on resolves to the `shell` launcher (see
   * launchers.ts) and comes back as a bare bash prompt wearing the name of a
   * Claude agent. Before KAN-38 nothing switched a stood-down agent back on, so
   * the loss was invisible; the moment the Agents page offers an On button it
   * is the ordinary path. The url and workDir travel for the same reason —
   * they are how it comes back as what it was rather than as something new.
   */
  private rememberDeactivated(
    type: string,
    key: string,
    workDir?: string,
    preemption?: PreemptionRecord
  ): void {
    if (!this.agentRegistry) return;
    const agentName = agentNameFor(type, key);
    const previous = this.agentRegistry.intents().get(agentName)?.record;
    this.agentRegistry.recordDeactivated(
      {
        agentName,
        type,
        // The registry's spelling of the key, when it has one. `agentName` is
        // built from a lower-cased key, so an agent addressed from a census —
        // which is how the Agents page addresses one — arrives here as
        // `kan-38`, and recording that would quietly replace a key spelled the
        // way its Jira issue is. `preemptionCandidates` already prefers the
        // registry's spelling for the same reason: this key is about to be
        // shown to a person next to a ticket that is spelled KAN-38.
        key: previous?.key ?? key,
        // The caller's own answer wins — it is looking at the live session —
        // and the registry's is the fallback for the by-key paths that have no
        // session to read one from.
        workDir: workDir ?? previous?.workDir ?? '',
        // Carried forward for the same reason the rest of the argument list is:
        // a stood-down agent is still somebody's, and the Agents page draws its
        // standby and preempted rows in the same tree as the running ones. This
        // is preservation, not invention — the parentage is whatever the last
        // activation recorded, and a stand-down learns nothing new about it.
        activatedBy: previous?.activatedBy ?? null,
        ...(previous?.url ? { url: previous.url } : {}),
        ...(previous?.defaultAgent ? { defaultAgent: previous.defaultAgent } : {}),
        ...(previous?.mcpServers ? { mcpServers: previous.mcpServers } : {})
      },
      preemption
    );
  }

  /** The staleness report, or undefined when this router has no install context. */
  private staleness(force = false): StalenessReport | undefined {
    if (!this.install) return undefined;
    return getStalenessReport({ ...this.install, force });
  }

  public handle(data: any) {
    // Responses echo the request's `id` so a transport can correlate them.
    // Chrome's messages carry no id; their replies go out on the default
    // channel, which is what the extension already listens to.
    const respond: Respond = (msg) =>
      this.send(data.id !== undefined ? { ...msg, id: data.id } : msg);

    // Fire-and-forget actions only reply when a caller asked to be
    // correlated, so Chrome doesn't get an ack per keystroke.
    const ack: Respond = (msg) => {
      if (data.id !== undefined) this.send({ ...msg, id: data.id });
    };

    // Resolution reaches the network now, so the handlers that use it are
    // async. A rejected handler promise would otherwise escape the try/catch
    // the daemon wraps this call in and surface as an unhandled rejection,
    // leaving the caller waiting on a response that never comes.
    const guard = (p: Promise<void>, action: string) =>
      p.catch((err: any) => {
        console.error(`Handler error in ${action}:`, err?.message ?? String(err));
        respond({
          action: `${action}_response`,
          success: false,
          error: err?.message ?? String(err)
        });
      });

    switch (data.action) {
      case 'reset':
        void guard(this.handleReset(data, respond), 'reset');
        break;
      case 'reset_by_key':
        this.handleResetByKey(data, respond);
        break;
      case 'activate':
        void guard(this.handleActivate(data, respond), 'activate');
        break;
      case 'activate_by_key':
        void guard(this.handleActivateByKey(data, respond), 'activate');
        break;
      case 'deactivate':
        this.handleDeactivate(data, respond);
        break;
      case 'deactivate_by_key':
        this.handleDeactivateByKey(data, respond);
        break;
      case 'send_to_agent':
        this.handleSendToAgent(data, respond);
        break;
      case 'tail_agent':
        this.handleTailAgent(data, respond);
        break;
      case 'agent_status':
        this.handleAgentStatus(data, respond);
        break;
      case 'status':
        void guard(this.handleStatus(data, respond), 'status');
        break;
      case 'list_agents':
        this.handleListAgents(data, respond);
        break;
      case 'staleness_check':
        this.handleStalenessCheck(data, respond);
        break;
      case 'capacity':
        this.handleCapacity(data, respond);
        break;
      case 'agent_work_state':
        this.handleAgentWorkState(data, respond);
        break;
      case 'jira_credential_status':
        void guard(this.handleJiraCredentialStatus(respond), 'jira_credential_status');
        break;
      case 'set_jira_credential':
        void guard(this.handleSetJiraCredential(data, respond), 'set_jira_credential');
        break;
      case 'clear_jira_credential':
        void guard(this.handleClearJiraCredential(respond), 'clear_jira_credential');
        break;
      case 'integration_credential_status':
        void guard(
          this.handleIntegrationCredentialStatus(data, respond),
          'integration_credential_status'
        );
        break;
      case 'set_integration_credential':
        void guard(
          this.handleSetIntegrationCredential(data, respond),
          'set_integration_credential'
        );
        break;
      case 'clear_integration_credential':
        void guard(
          this.handleClearIntegrationCredential(data, respond),
          'clear_integration_credential'
        );
        break;
      case 'set_integration_enabled':
        void guard(
          this.handleSetIntegrationEnabled(data, respond),
          'set_integration_enabled'
        );
        return;
      case 'list_integrations':
        void guard(this.handleListIntegrations(respond), 'list_integrations');
        break;
      case 'pty_init':
        this.handlePtyInit(data, respond);
        break;
      case 'pty_input':
        this.handlePtyInput(data, ack);
        break;
      case 'pty_resize':
        this.handlePtyResize(data, ack);
        break;
      default:
        console.warn('Unknown action:', data.action);
        respond({
          action: 'error_response',
          success: false,
          error: `Unknown action: ${data.action}`
        });
    }
  }

  /**
   * Whether the machine can carry another agent, checked before spawning one.
   *
   * Only consulted when a *new* agent would be created: re-attaching to an
   * agent that is already running costs the machine nothing, and refusing that
   * would be refusing to look at work already in flight. The caller's own
   * `getSessionByAddress` miss is not enough to establish that, because the
   * session map dies with the daemon while the herdr pane does not — so
   * `alreadyRunning` asks herdr, and every re-attach after a daemon restart
   * skips the gate. Without it the panel could not get back to agents it was
   * already supervising, and precisely when the machine was busiest.
   *
   * An override is honoured — a cap that cannot be exceeded on purpose is a
   * cap people work around — but it is recorded rather than waved through.
   * Someone reading the log later should be able to see that the machine was
   * over-staffed deliberately, and what the numbers were at the time.
   *
   * Supervisor activations are never refused at all — see the exemption
   * below, which is where the capacity model's "supervisors are not part of
   * the limit" decision is actually honoured.
   */
  private capacityGate(request: GateRequest): CapacityGateResult {
    const { what, type, key, agentName, priority, override, preempt } = request;
    const pass = (capacity: Capacity): CapacityGateResult => ({
      capacity,
      refusal: null,
      overrode: null,
      preemptable: null,
      preempted: null
    });

    const { agents } = this.surveyAgents();

    if (agents.some((a) => a.agentName === agentName)) {
      // Already alive and already counted. Starting nothing costs nothing.
      return pass(this.capacityOf(agents));
    }

    const capacity = this.capacityOf(agents);

    // Supervisors pass unconditionally (KAN-57). The capacity model already
    // decided they are not part of the limit: they are neither counted in
    // `running` nor charged a slot (see capacity.ts's header for the KAN-41
    // argument), so a load- or headroom-bound refusal here was refusing an
    // agent whose cost the model had already declined to charge. It was also
    // a lockout in practice — desktop baseline load alone can pin
    // headroomByLoad at 0 indefinitely, which meant epic and story agents
    // could never start or auto-restore without a manual override. They are
    // higher priority by construction (priority.ts) and always-on by intent,
    // so the gate has nothing to ration for them: no refusal, and therefore
    // no override to record and no preemption to offer. Task activations
    // below are untouched, and supervisors still appear in every capacity
    // report as `supervisors`.
    if (isSupervisorType(type)) return pass(capacity);

    if (!capacity.atCapacity) return pass(capacity);

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — a task
    // agent on a board of task agents outranks nothing, and neither does
    // anything at all when the only things running are epic or story agents.
    const candidates = this.preemptionCandidates(agents, agentName);
    const victim = selectVictim(candidates, priority);
    const derivation = describeCapacity(capacity);
    const offer = (v: PreemptionCandidate): PreemptionOfferDto => ({
      agentName: v.agentName,
      type: v.type,
      key: v.key,
      priority: v.priority,
      herdrStatus: v.herdrStatus,
      incomingPriority: priority,
      offer: preemptionOffer(v, priority)
    });

    if (preempt && victim) {
      const at = new Date().toISOString();
      const preemption: PreemptionRecord = {
        byAgentName: agentName,
        byType: type,
        byKey: key,
        byPriority: priority,
        priority: victim.priority,
        herdrStatus: victim.herdrStatus,
        derivation
      };

      // Through the ordinary stand-down path rather than a teardown of its own.
      // KAN-21's `deactivate_by_key` already handles every case this needs —
      // a live session, an agent that outlived its daemon, and one that has
      // already died — and answers honestly about which it found. Preemption
      // reusing it means there is one way an agent stops, not two.
      let standDown: any = null;
      this.handleDeactivateByKey(
        { key: victim.key, type: victim.type ?? undefined, preemption },
        (msg: any) => {
          standDown = msg;
        }
      );

      if (!standDown?.success) {
        // Nothing was freed, so nothing may start. Refusing here is the
        // important half: proceeding would leave the machine over capacity
        // *and* have announced a preemption that did not happen.
        const error =
          `Refusing to activate ${what}: standing down ${addressOf(victim)} to make room ` +
          `failed (${standDown?.error ?? 'no reason given'}), so no capacity was freed.\n` +
          derivation;
        console.error(`[capacity] preemption aborted: ${error}`);
        return { capacity, refusal: error, overrode: null, preemptable: offer(victim), preempted: null };
      }

      console.warn(
        `[capacity] preemption: ${what} (priority ${priority}) stood down ` +
        `${describeCandidate(victim)} at ${at}\n${derivation}`
      );
      this.broadcast({
        action: 'agent_preempted_event',
        at,
        victim: offer(victim),
        by: { agentName, type, key, priority },
        capacity: capacityDto(capacity)
      });

      // Re-surveyed rather than reused: the caller is about to be told what the
      // machine looks like, and it is not the machine that refused a moment ago.
      //
      // The activation now proceeds unconditionally, and that is deliberate.
      // Only the count term responds to a stand-down immediately — the load
      // average is a one-minute mean and the kernel has not yet reclaimed the
      // memory — so re-running the whole gate here would sometimes refuse
      // *after* destroying an agent's work, which is the worst of both
      // outcomes. A slot was freed on purpose; the machine is strictly better
      // off than it was a moment ago, and it is about to look it.
      const after = this.capacityOf(this.surveyAgents().agents);
      return {
        capacity: after,
        refusal: null,
        overrode: null,
        preemptable: null,
        preempted: { at, victim: offer(victim), derivation }
      };
    }

    if (!override) {
      // Both branches name what is running and what it is worth. Losing a slot
      // is survivable; not being able to see who you lost it to is not.
      const refusal =
        `${capacityRefusal(capacity, what)}\n` +
        (victim ? preemptionOffer(victim, priority) : noVictimReason(candidates, priority));
      return {
        capacity,
        refusal,
        overrode: null,
        preemptable: victim ? offer(victim) : null,
        preempted: null
      };
    }

    const at = new Date().toISOString();
    console.warn(
      `[capacity] override: starting ${what} past capacity at ${at}\n${derivation}`
    );
    this.broadcast({
      action: 'capacity_override_event',
      what,
      at,
      capacity: capacityDto(capacity)
    });
    return {
      capacity,
      refusal: null,
      overrode: { at, derivation },
      preemptable: victim ? offer(victim) : null,
      preempted: null
    };
  }

  /**
   * Everything running that could be considered for a stand-down.
   *
   * The same filter the capacity model uses, for the same reason it exists
   * there: a list that counted the daemon's own bare shell would offer to kill
   * it, and a list that disagreed with `running` would offer to free a slot
   * that was never occupied.
   *
   * Supervisors — epic and story agents — are deliberately *included*. An
   * epic agent can never be selected: nothing outranks priority 3 and the
   * comparison is strictly-greater, and leaving supervisors in is what makes
   * that a fact about the ordering rather than a special case somebody has to
   * remember. (Standing one down would not free a fleet slot anyway — they
   * are never counted against the cap — but the ordering, not that, is what
   * protects them.)
   */
  private preemptionCandidates(agents: ListedAgent[], exclude?: string): PreemptionCandidate[] {
    const intents = this.agentRegistry?.intents();
    const candidates: PreemptionCandidate[] = [];

    for (const entry of agents) {
      if (!this.countsAsAgent(entry)) continue;
      if (exclude && entry.agentName === exclude) continue;

      const intent = intents?.get(entry.agentName);
      candidates.push({
        agentName: entry.agentName,
        type: entry.type,
        // The registry's key when it has one, because an agent resolved from
        // its name alone carries the lower-cased form the name was built from
        // — and this key is about to be shown to a person next to a Jira issue
        // that is spelled KAN-10.
        key: intent?.record.key ?? entry.key,
        priority: this.registry.priorityFor(entry.type),
        herdrStatus: entry.herdrStatus,
        activatedAt: intent?.event === 'activated' ? intent.at : null
      });
    }

    return candidates;
  }

  /**
   * The resume cause for an activation nobody labelled one.
   *
   * An agent whose last stand-down was a preemption is being *resumed* when it
   * is switched back on, whatever the caller thinks it is doing — and it must
   * be told so, or it comes back with its whole conversation restored and no
   * turn to take. That is KAN-21's idle-forever failure, reached by a route
   * KAN-21 never had: nobody rebooted anything, a person just turned a switch
   * back on.
   *
   * An explicit cause always wins; only boot-time reconciliation sets one.
   */
  private resumeCauseFor(agentName: string, explicit?: ResumeCause): ResumeCause | undefined {
    if (explicit) return explicit;
    return this.agentRegistry?.preemptionFor(agentName) ? 'preempted' : undefined;
  }

  /**
   * Tell a just-resumed agent to carry on, without making the caller wait.
   *
   * Fire-and-forget on purpose: the nudge waits up to two minutes for the
   * agent's prompt to appear, and an activate that blocked on that would time
   * out in every client. The response has already gone; this is the part that
   * happens afterwards, and its outcome lands in the daemon log.
   *
   * Scheduled onto a later turn rather than merely un-awaited, which is not
   * fussiness. The first thing the nudge does is read the agent's pane, and
   * `herdr agent read` is an `execSync` with a five-second ceiling — starting it
   * inside this call would run it *before* the handler reaches `respond`, and
   * the user would watch a toggle hang on a message it is not waiting for.
   *
   * Only when a conversation actually came back. The other branch started with
   * the degraded-resume prompt on its command line and is already working.
   */
  private nudgeIfResumed(session: HerdrSession, defaultAgent?: string): void {
    if (!session.resume || session.resumedConversation !== true) return;
    const cause = session.resume;
    setTimeout(() => {
      void nudgeResumedAgent({
        herdrBridge: this.herdrBridge,
        type: session.type,
        key: session.key,
        cause,
        defaultAgent,
        log: (...args: any[]) => console.log(...args)
      });
    }, 0);
  }

  /**
   * The step that makes an activate response a statement about the world
   * rather than about our own intentions.
   *
   * Returns the complaint when success cannot honestly be claimed, and
   * `undefined` when the agent has been confirmed to exist. Both activate
   * handlers call it in the same place — after herdr's own errors have been
   * dealt with, before anything is recorded, broadcast or answered — so there
   * is exactly one point at which the two of them decide they succeeded.
   *
   * A confirmed-absent agent takes its session down with it. That is not a
   * retry (see the ticket's out-of-scope list) and not a cleanup: it is the
   * difference between a failure a caller can act on and one it is locked out
   * of, because a session left active is the one the next activate would
   * reuse. An unverifiable answer changes nothing — see abandonSession.
   */
  private async confirmActivation(
    session: HerdrSession,
    agentName: string
  ): Promise<string | undefined> {
    // Existence means a live runtime for every launcher but `shell` — a name
    // registration over a dead pane must not verify (KAN-58). Sessions that
    // reached this point were built by initPty, which sets the field; an
    // unset one gets the strict reading rather than the lenient one.
    const presence = await this.herdrBridge.confirmAgentPresent(
      agentName,
      session.expectsRuntime ?? true
    );
    if (presence.present) return undefined;

    console.error(
      `[Router] Refusing to report ${agentName} activated: ${presence.error}`
    );
    if (presence.reason === 'absent') {
      this.herdrBridge.abandonSession(session.sessionId, presence.error);
    }
    return presence.error;
  }

  private async handleActivate(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      // Only after resolution has genuinely failed: a disabled integration's
      // patterns are diagnosis, never matching, so this can never turn a
      // refusal into an activation.
      const disabled = this.registry.disabledMatch(data.url);
      respond({
        action: 'activate_response',
        success: false,
        error: disabled
          ? integrationDisabled(
              disabled.integration.name,
              disabled.key ? `${disabled.key}` : 'this page'
            )
          : 'Unsupported URL. No matching Workspace Type found.',
        ...(disabled
          ? {
              refusedBy: 'integration-disabled',
              integration: disabled.integration.id,
              integrationName: disabled.integration.name,
              ...(disabled.key ? { key: disabled.key } : {})
            }
          : {})
      });
      return;
    }

    const { config, key } = resolved;
    const renderedPrompt = this.promptLoader.loadAndRender(config.promptTemplateFile, {
      KEY: key,
      URL: data.url
    });

    const agentName = agentNameFor(config.type, key);
    const mcpServers = this.mcpServersForSpawn();
    // By (key, type), never by key alone: workspace keys are shared across
    // types by design, so a key-only match here would hand this activation a
    // live agent of another type — whose PTY the confirmation-failure path
    // would then kill (KAN-83).
    let session = this.herdrBridge.getSessionByAddress(key, config.type);
    let gate: CapacityGateResult | null = null;
    if (!session) {
      gate = this.capacityGate({
        what: `${config.type}/${key}`,
        type: config.type,
        key,
        agentName,
        priority: config.priority,
        override: data.override,
        preempt: data.preempt
      });
      if (gate.refusal) {
        respond({
          action: 'activate_response',
          success: false,
          type: config.type,
          key,
          url: data.url,
          // `error` is the whole refusal, for the log and for MCP callers.
          // `refusedBy`, `reason` and `derivation` are the same thing split
          // into the pieces a UI can lay out — the sidepanel showed none of
          // this and the user met a dead switch. See KAN-36.
          error: gate.refusal,
          refusedBy: 'capacity',
          reason: capacityReason(gate.capacity),
          derivation: describeCapacity(gate.capacity),
          capacity: capacityDto(gate.capacity),
          priority: config.priority,
          // Named, so the panel can offer a button that says whose work it
          // ends. Absent when there is nothing this activation outranks.
          ...(gate.preemptable ? { preemption: gate.preemptable } : {})
        });
        return;
      }
      // A preempted agent switched back on is resuming interrupted work, not
      // starting it. See resumeCauseFor.
      const resume = this.resumeCauseFor(agentName);
      session = this.herdrBridge.spawnSession(config.type, key, data.url, renderedPrompt, data.defaultAgent, mcpServers, resume);
      if (!session.spawnError) this.nudgeIfResumed(session, data.defaultAgent);
    }

    if (session.spawnError) {
      respond({
        action: 'activate_response',
        success: false,
        type: config.type,
        key,
        url: data.url,
        error: session.spawnError
      });
      return;
    }

    const unconfirmed = await this.confirmActivation(session, agentName);
    if (unconfirmed) {
      respond({
        action: 'activate_response',
        success: false,
        type: config.type,
        key,
        url: data.url,
        error: unconfirmed,
        verified: false
      });
      return;
    }

    // Only now. The durable registry is the record of which agents *should* be
    // running, and writing an activation into it before the agent is known to
    // exist would have list_agents report the failure as an agent that
    // silently stopped, indefinitely, until a human stood down something that
    // was never started.
    this.rememberActivated({
      agentName,
      type: config.type,
      key,
      workDir: session.workDir,
      url: data.url,
      defaultAgent: data.defaultAgent,
      mcpServers: Object.keys(mcpServers),
      activatedBy: this.supervisorOfRecord(data, { type: config.type, key })
    });

    this.broadcast({
      action: 'agent_activated_event',
      type: config.type,
      key,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir
    });

    respond({
      action: 'activate_response',
      success: true,
      type: config.type,
      key,
      url: data.url,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir,
      createdAt: session.createdAt.toISOString(),
      mcpServers: Object.keys(mcpServers),
      priority: config.priority,
      // Not decoration: it is the difference between this response and the one
      // KAN-23 was filed about. `true` means the agent was found in herdr's
      // census before this was sent, and success is never reported without it.
      verified: true,
      ...(session.resume ? { resume: session.resume, resumedConversation: session.resumedConversation } : {}),
      ...(gate?.preempted ? { preempted: gate.preempted } : {}),
      ...(gate?.overrode ? { capacityOverride: { ...gate.overrode, capacity: capacityDto(gate.capacity) } } : {})
    });
  }

  public async handleActivateByKey(data: any, respond: Respond) {
    const { type, key, defaultAgent } = data;

    // A key alone does not determine a URL: the registry maps URLs to keys,
    // not the other way round. Callers who know the page URL pass it; for
    // callers who don't, the session simply has no url. Never invent one —
    // a fabricated link is worse than no link.
    const url =
      typeof data.url === 'string' && data.url.trim() ? data.url.trim() : undefined;

    // The url is advisory: an explicit key always wins. A disagreement is
    // worth a log line but not a rejection — the caller may legitimately be
    // binding an agent to a page the registry doesn't recognise.
    if (url) {
      const resolved = await this.registry.resolve(url);
      if (resolved && resolved.key !== key) {
        console.warn(
          `activate_by_key: url ${url} resolves to key ${resolved.key}, but key ${key} was given; using ${key}`
        );
      }
    }

    // Prefer the registered config so a type's prompt file and MCP servers
    // come from one place. An unregistered type still works on the old
    // convention — callers may address a type this daemon doesn't know.
    const config = this.registry.get(type);
    // An unregistered type is ordinarily allowed through on the old convention
    // — callers may address a type this daemon does not know. But a type that
    // is unregistered *because its integration is switched off* is a refusal
    // with a reason, not an unknown.
    if (!config) {
      const disabled = this.registry.disabledIntegrationForType(type);
      if (disabled) {
        respond({
          action: 'activate_response',
          success: false,
          type,
          key,
          error: integrationDisabled(disabled.name, `${type}/${key}`),
          refusedBy: 'integration-disabled',
          integration: disabled.id,
          integrationName: disabled.name
        });
        return;
      }
    }
    const promptTemplateFile = config?.promptTemplateFile ?? `prompts/${type}.md`;
    // Not read off the config: MCP servers belong to the integrations, not to
    // the type, so an unregistered type gets the same servers as a registered
    // one and the old `?? ['atlassian', 'butchr']` fallback — a second copy of
    // the hardcoded table — has nothing left to stand in for.
    const mcpServers = this.mcpServersForSpawn();
    const priority = this.registry.priorityFor(type);
    const agentName = agentNameFor(type, key);
    // By (key, type), never by key alone. This was KAN-83's collision:
    // activating type B with a key a live type-A agent held reused A's
    // session, failed runtime confirmation against B's agent name, and the
    // failure path's abandonSession killed A's PTY — a healthy, unrelated
    // agent destroyed by someone else's activation.
    let session = this.herdrBridge.getSessionByAddress(key, type);
    let gate: CapacityGateResult | null = null;

    if (!session) {
      // Before the prompt is even rendered: the cheapest refusal is the one
      // that happens before any work is done for an agent that will not exist.
      gate = this.capacityGate({
        what: `${type}/${key}`,
        type,
        key,
        agentName,
        priority,
        override: data.override,
        preempt: data.preempt
      });
      if (gate.refusal) {
        respond({
          action: 'activate_response',
          success: false,
          type,
          key,
          url,
          error: gate.refusal,
          refusedBy: 'capacity',
          reason: capacityReason(gate.capacity),
          derivation: describeCapacity(gate.capacity),
          capacity: capacityDto(gate.capacity),
          priority,
          ...(gate.preemptable ? { preemption: gate.preemptable } : {})
        });
        return;
      }

      const renderedPrompt = this.promptLoader.loadAndRender(promptTemplateFile, {
        KEY: key,
        URL: url ?? ''
      });
      // An explicit `resume` is set only by boot-time reconciliation, never by
      // a client: it changes what the agent is told when there is nothing to
      // continue, and an ordinary activation is not an interrupted one. What a
      // client *can* produce without saying so is the re-activation of an agent
      // it previously preempted, which is an interrupted one — resumeCauseFor
      // is where that is recognised rather than trusted to the caller.
      const explicit: ResumeCause | undefined =
        data.resume === 'reboot' || data.resume === 'daemon-restart' ? data.resume : undefined;
      const resume = this.resumeCauseFor(agentName, explicit);

      session = this.herdrBridge.spawnSession(type, key, url, renderedPrompt, defaultAgent, mcpServers, resume);

      // Reconciliation nudges its own restores, in sequence and with the
      // stagger it needs; it passes an explicit cause, which is how the two are
      // told apart. A preemption resume has nobody else to do it.
      if (!explicit && !session.spawnError) this.nudgeIfResumed(session, defaultAgent);
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists, and an error herdr handed us must never be
    // answered with success: true. It is not the whole of the question, which
    // is why confirmActivation follows: herdr can also report success and
    // leave no agent behind, and that case is answered by looking rather than
    // by trusting.
    if (session.spawnError) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        url,
        error: session.spawnError
      });
      return;
    }

    const unconfirmed = await this.confirmActivation(session, agentName);
    if (unconfirmed) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        url,
        error: unconfirmed,
        verified: false
      });
      return;
    }

    // After confirmation, for the reason handleActivate gives.
    this.rememberActivated({
      agentName,
      type,
      key,
      workDir: session.workDir,
      url,
      defaultAgent,
      mcpServers: Object.keys(mcpServers),
      activatedBy: this.supervisorOfRecord(data, { type, key })
    });

    this.broadcast({
      action: 'agent_activated_event',
      type,
      key,
      sessionId: session.sessionId,
      status: session.status
    });

    respond({
      action: 'activate_response',
      success: true,
      type,
      key,
      url: session.url,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir,
      priority,
      // See handleActivate: success is never sent without having looked.
      verified: true,
      // Only present on a restore. `false` means the agent came up with the
      // degraded-resume prompt and is already working; `true` means it was
      // handed its old conversation and is sitting at an empty prompt, which
      // is the case that needs a nudge. See daemon.ts's reconciliation.
      ...(session.resume ? { resume: session.resume, resumedConversation: session.resumedConversation } : {}),
      // What this activation cost somebody else. Reported to the caller as well
      // as broadcast, so an MCP client that started an agent by preemption
      // learns whose work it interrupted from the same response.
      ...(gate?.preempted ? { preempted: gate.preempted } : {}),
      ...(gate?.overrode ? { capacityOverride: { ...gate.overrode, capacity: capacityDto(gate.capacity) } } : {})
    });
  }

  private handleDeactivate(data: any, respond: Respond) {
    if (!data.sessionId) {
      respond({
        action: 'deactivate_response',
        success: false,
        error: 'Missing sessionId'
      });
      return;
    }

    // Read before the teardown: terminateSession marks the session terminated,
    // after which getSession still answers but the address is what we need and
    // it does not change. Recorded either way — see rememberDeactivated.
    const session = this.herdrBridge.getSession(data.sessionId);
    const { success, error } = this.herdrBridge.terminateSession(data.sessionId);
    if (session) this.rememberDeactivated(session.type, session.key, session.workDir);

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId,
      ...(error ? { error } : {})
    });
  }

  public handleDeactivateByKey(data: any, respond: Respond) {
    const { key } = data;
    // The address's type half, honoured when the caller states it — the
    // sidepanel and the preemption path both do. Without it a key shared
    // across types would stand down whichever type's session was created
    // first, not the one the caller meant (KAN-83). A caller that names no
    // type gets the key-only match it asked for: deliberately type-agnostic,
    // for clients addressing an agent whose type they never knew.
    const requestedType =
      typeof data.type === 'string' && data.type.trim() ? data.type.trim() : undefined;
    // Set only by the capacity gate, never by a client: it is the record of why
    // this stand-down was not the agent's own idea. See PreemptionRecord.
    const preemption: PreemptionRecord | undefined = data.preemption;
    const session = this.herdrBridge.getSessionByAddress(key, requestedType);

    if (session) {
      const { success, error } = this.herdrBridge.terminateSession(session.sessionId);
      this.rememberDeactivated(session.type, session.key, session.workDir, preemption);

      // Not broadcast when the teardown could not be confirmed: the event is
      // what the Agents page and the sidepanel act on, and announcing an agent
      // deactivated while it may still be running is the same false claim this
      // ticket is about, arriving as an event instead of as a response.
      if (success) {
        this.broadcast({
          action: 'agent_deactivated_event',
          type: session.type,
          key: session.key,
          sessionId: session.sessionId,
          ...(preemption ? { preempted: true } : {})
        });
      }

      respond({
        action: 'deactivate_response',
        success,
        // The address, so a caller that asked about several agents can tell
        // which one this answers for. A fleet list can — the Agents page shows
        // every agent at once, and a bare `success: false` there is a failure
        // it cannot attribute to a row.
        type: session.type,
        key: session.key,
        sessionId: session.sessionId,
        ...(preemption ? { preempted: true } : {}),
        ...(error ? { error } : {})
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not. Close it through the fallback
    // rather than telling the caller an obviously-running agent is gone.
    const result = this.herdrBridge.closeAgentByKey(key, requestedType);

    // The type comes from the agent herdr just closed, or — when herdr has no
    // such agent — from the registry.
    //
    // That second source is not a nicety. An agent that has already died cannot
    // be resolved through herdr at all, so without it the one case where a
    // human most needs to say "stop expecting this" would record nothing, and
    // the next boot would resurrect an agent someone had explicitly given up
    // on. Standing down something that is already gone has to work, because
    // that is exactly when it is asked for.
    //
    // A caller that already knows the type says so and is believed first — the
    // capacity gate does, having just picked this agent out of a census.
    const closedType =
      requestedType ??
      (result.agentName ? typeFromAgentName(result.agentName, key) : undefined) ??
      this.registeredTypeFor(key);

    if (closedType) this.rememberDeactivated(closedType, key, undefined, preemption);

    // Standing down an agent that has already died is not a failure — it is the
    // request working. There was no pane to close, and the thing actually being
    // asked for ("stop expecting this agent back") is the registry write, which
    // succeeded. Reporting `success: false` there tells a supervisor its
    // stand-down did not take, inviting it either to retry forever or to
    // conclude the agent is still owed a slot; the next boot would then be the
    // first anyone learns the intent was recorded all along.
    //
    // Only when herdr *answered* though. An unreachable herdr also fails to
    // close the pane, and calling that "already gone" would report an agent
    // stood down while it is still running.
    const goneAlready =
      !result.success && Boolean(closedType) && this.herdrBridge.listHerdrAgentsChecked().reachable;

    if (result.success || goneAlready) {
      this.broadcast({
        action: 'agent_deactivated_event',
        type: closedType,
        key,
        ...(preemption ? { preempted: true } : {})
      });
    }

    respond({
      action: 'deactivate_response',
      key,
      ...(closedType ? { type: closedType } : {}),
      success: result.success || goneAlready,
      ...(preemption ? { preempted: true } : {}),
      ...(goneAlready
        ? { alreadyGone: true, note: 'No agent was running. Its stand-down is recorded, so it will not be restored.' }
        : {}),
      ...(result.error && !goneAlready ? { error: result.error } : {})
    });
  }

  /**
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const { key, type, message } = data;
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (typeof message !== 'string' || !message.trim()) {
      fail('Missing or invalid message');
      return;
    }

    this.herdrBridge.sendToAgent(key, message, type).then(
      (result) => respond({ action: 'send_to_agent_response', key, ...result }),
      (err) => fail(err?.message ?? String(err))
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private handleTailAgent(data: any, respond: Respond) {
    const { key, type, lines } = data;
    const fail = (error: string) =>
      respond({ action: 'tail_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (lines !== undefined && (typeof lines !== 'number' || !Number.isFinite(lines))) {
      fail('Invalid lines: expected a number');
      return;
    }

    try {
      respond({
        action: 'tail_agent_response',
        key,
        ...this.herdrBridge.tailAgent(key, type, lines)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  /**
   * Everything the sidepanel's Info tab shows, by address. A daemon restart
   * empties the session map while the herdr pane keeps running, so a missing
   * session degrades to herdr's own view (`sessionless: true`) rather than
   * failing — an agent that outlived its daemon is exactly the one a
   * supervisor most needs to inspect.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    const { key, type } = data;
    const fail = (error: string) =>
      respond({ action: 'agent_status_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }

    try {
      const session = this.herdrBridge.getSessionByAddress(key, type);
      if (session) {
        respond({
          action: 'agent_status_response',
          success: true,
          sessionless: false,
          agentName: agentNameFor(session.type, session.key),
          ...this.toAgentDto(session, this.herdrBridge.listHerdrStatuses())
        });
        return;
      }

      const described = this.herdrBridge.describeAgent(key, type);
      respond({
        action: 'agent_status_response',
        success: true,
        sessionless: true,
        agentName: described.agentName,
        sessionId: null,
        type: described.type,
        key,
        url: null,
        createdAt: null,
        status: null,
        workDir: described.workDir,
        herdrStatus: described.herdrStatus
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  private async handleReset(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      const disabled = this.registry.disabledMatch(data.url);
      respond({
        action: 'reset_response',
        success: false,
        error: disabled
          ? integrationDisabled(
              disabled.integration.name,
              disabled.key ? `${disabled.key}` : 'this page'
            )
          : 'Unsupported URL'
      });
      return;
    }
    const { config, key } = resolved;
    // By (key, type): the URL resolved to a typed workspace, and this reset is
    // about to delete that workspace's directory — tearing down a same-key
    // agent of another type instead would destroy a bystander (KAN-83).
    const session = this.herdrBridge.getSessionByAddress(key, config.type);

    // Same ordering rule as handleResetByKey: the agent goes first, whether we
    // reach it through the session map or the herdr-list fallback.
    //
    // And the outcome is reported, as handleResetByKey already did. This path
    // discarded it entirely, so a reset whose agent could not be closed —
    // leaving it running in a directory about to be deleted — was answered
    // exactly like one that went cleanly. `success` still describes the
    // workspace delete, which is what reset is; `agentClosed` is the separate
    // fact, and a caller that cannot see it cannot know to go looking.
    const closed = session
      ? this.herdrBridge.terminateSession(session.sessionId)
      : this.herdrBridge.closeAgentByKey(key, config.type);

    // A reset destroys the workspace as well as the agent, so it is the most
    // deliberate stand-down there is. Restoring it on the next boot would
    // recreate an agent whose working directory was deliberately deleted.
    this.rememberDeactivated(config.type, key);

    const { success, error } = this.herdrBridge.resetWorkspace(config.type, key);
    respond({
      action: 'reset_response',
      success,
      agentClosed: closed.success,
      ...(closed.error ? { agentError: closed.error } : {}),
      ...(error ? { error } : {})
    });
  }

  public handleResetByKey(data: any, respond: Respond) {
    const { type, key } = data;
    // By (key, type), for handleReset's reason: reset destroys type/key's
    // workspace, so type/key's agent is the only one it may touch (KAN-83).
    const session = this.herdrBridge.getSessionByAddress(key, type);

    // Tear the agent down *before* resetWorkspace deletes the directory it is
    // running in. Without a session the agent is still reachable through the
    // herdr-list fallback, and skipping that left the agent alive in a cwd
    // that no longer exists.
    const { success: agentClosed, error: agentError } = session
      ? this.herdrBridge.terminateSession(session.sessionId)
      : this.herdrBridge.closeAgentByKey(key, type);

    // Same reasoning as handleReset: the workspace is about to be deleted, so
    // this agent must not be brought back by reconciliation.
    this.rememberDeactivated(type, key, session?.workDir);

    // The workspace still goes away even if no agent was there to close —
    // reset's job is to leave nothing behind. Unless the target isn't ours to
    // delete, in which case `resetError` says which path was refused and why.
    const { success, error: resetError } = this.herdrBridge.resetWorkspace(type, key);

    // Broadcast event so UI can update
    this.broadcast({
      action: 'agent_reset_event',
      type,
      key,
      success,
      agentClosed
    });

    respond({
      action: 'reset_response',
      success,
      agentClosed,
      ...(agentError ? { agentError } : {}),
      // A refusal outranks the agent's complaint: it is the reason the reset
      // did not happen, and the caller needs to see the path that was rejected.
      ...(success ? {} : { error: resetError ?? agentError ?? `No workspace directory for ${type}/${key}` })
    });
  }

  private toAgentDto(session: HerdrSession, statuses: Map<string, HerdrAgentStatus>): AgentDto {
    return {
      sessionId: session.sessionId,
      type: session.type,
      key: session.key,
      url: session.url,
      createdAt: session.createdAt.toISOString(),
      status: session.status,
      workDir: session.workDir,
      herdrStatus: statuses.get(agentNameFor(session.type, session.key)) ?? 'unknown'
    };
  }

  /**
   * Does an agent exist for this page, and are we attached to it?
   *
   * Two different truths, and conflating them is what made the toggle lie:
   * `active` is the agent's own existence, which is herdr's and survives a
   * daemon restart; `attached` is whether *this* daemon holds a session for
   * it, which is ephemeral and dies with the process. A missing session used
   * to answer `active: false` for an agent that was demonstrably still
   * working, so a session miss now asks herdr before calling anything Off.
   */
  private async handleStatus(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      // `supported: false` either way — the page is not a workspace right now
      // — but when the reason is a switched-off integration rather than an
      // unrecognised URL, say so, so the sidepanel can offer the toggle
      // instead of a shrug.
      const disabled = this.registry.disabledMatch(data.url);
      respond({
        action: 'status_response',
        success: true,
        supported: false,
        ...(disabled
          ? {
              refusedBy: 'integration-disabled',
              integration: disabled.integration.id,
              integrationName: disabled.integration.name,
              reason: integrationDisabled(
                disabled.integration.name,
                disabled.key ? `${disabled.key}` : 'this page'
              )
            }
          : {})
      });
      return;
    }

    const base = {
      action: 'status_response',
      success: true,
      supported: true,
      type: resolved.config.type,
      key: resolved.key
    };

    // By (key, type): the page resolved to a typed workspace, and answering
    // with a same-key session of another type would report a different
    // agent's attachment as this page's (KAN-83).
    const session = this.herdrBridge.getSessionByAddress(resolved.key, resolved.config.type);
    if (session) {
      const agent = this.toAgentDto(session, this.herdrBridge.listHerdrStatuses());
      respond({
        ...base,
        active: true,
        attached: true,
        sessionId: agent.sessionId,
        status: agent.status,
        workDir: agent.workDir,
        createdAt: agent.createdAt,
        herdrStatus: agent.herdrStatus
      });
      return;
    }

    // The registry knows this page's type, so the agent can be named exactly
    // rather than resolved by suffix. Not-found is the ordinary answer here,
    // not a failure: it is precisely the case where the agent really is gone.
    let described: HerdrAgentDescription | undefined;
    try {
      described = this.herdrBridge.describeAgent(resolved.key, resolved.config.type);
    } catch {
      described = undefined;
    }

    if (!described) {
      respond({ ...base, active: false, attached: false });
      return;
    }

    respond({
      ...base,
      active: true,
      attached: false,
      // Session-only fields stay absent — there is no session to describe,
      // and herdr knows nothing about sessionId, createdAt or pty status.
      // workDir is included only when herdr actually reported a cwd.
      ...(described.workDir !== null ? { workDir: described.workDir } : {}),
      herdrStatus: described.herdrStatus
    });
  }

  // --- Integration credentials ---------------------------------------------
  //
  // A token's whole journey is: settings UI → native messaging → here →
  // CredentialStore. It never travels back. These handlers answer with
  // configured/not-configured and a validation verdict, never with the value,
  // so there is nothing for the extension to retain even by accident.
  //
  // Two generations of surface share these bodies. The legacy `jira_credential_*`
  // actions predate integrations being plural and stay exactly as they were;
  // the `*_integration_credential {integration}` actions are the generalized
  // form KAN-87's settings UI speaks. Same handlers, different response action
  // names — so the two surfaces cannot drift apart.

  private async handleJiraCredentialStatus(respond: Respond) {
    await this.jiraCredentialStatus(respond, 'jira_credential_status_response', {});
  }

  private async jiraCredentialStatus(
    respond: Respond,
    action: string,
    extra: Record<string, unknown>
  ) {
    if (!this.jira) {
      respond({ action, ...extra, success: true, available: false, configured: false });
      return;
    }
    // `storageTarget` runs a keyring probe, which is why this handler is async
    // now. It is what lets the settings page say where the token will land
    // before the user types it, rather than after it has already gone.
    respond({
      action,
      ...extra,
      success: true,
      available: true,
      ...this.jira.status(),
      storageTarget: await this.jira.storageTarget()
    });
  }

  private async handleSetJiraCredential(data: any, respond: Respond) {
    await this.submitJiraCredential(data, respond, 'set_jira_credential_response', {});
  }

  private async submitJiraCredential(
    data: any,
    respond: Respond,
    action: string,
    extra: Record<string, unknown>
  ) {
    const fail = (error: string) =>
      respond({ action, ...extra, success: false, valid: false, error });

    if (!this.jira) {
      fail('This daemon has no Jira credential support.');
      return;
    }

    const siteUrl = typeof data.siteUrl === 'string' ? data.siteUrl.trim() : '';
    const email = typeof data.email === 'string' ? data.email.trim() : '';
    const token = typeof data.token === 'string' ? data.token : '';

    if (!siteUrl || !email || !token) {
      fail('Site URL, account email and API token are all required.');
      return;
    }

    // Normalise before storing: a trailing slash would double up in every
    // request path, and a bare hostname needs a scheme to be fetchable.
    const normalisedSite = (/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`)
      .replace(/\/+$/, '');

    let parsed: URL;
    try {
      parsed = new URL(normalisedSite);
    } catch {
      fail('That does not look like a valid site URL.');
      return;
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      fail('Enter just the site address, e.g. https://yoursite.atlassian.net');
      return;
    }

    const result = await this.jira.setCredential({
      siteUrl: parsed.origin,
      email,
      token
    });

    // Note what is *not* here: the token, and any echo of the request. The
    // response carries a verdict, the non-secret site/account, and the record
    // of which endpoints were tried — every field of which is built from a URL,
    // a status code, or Atlassian's own response text, and each of those is
    // scrubbed of every encoded form of the token before it leaves the
    // transport.
    //
    // The log gets the diagnosis and the leg trail, not just "rejected". The
    // whole reason this ticket exists is that a rejection which says only that
    // it happened cannot be acted on — and that is as true of the log as of
    // the UI.
    console.log(
      `jira: credential submitted for ${email} @ ${parsed.origin} — ` +
        (result.valid
          ? `valid, stored in ${result.storage}`
          : `rejected (${result.diagnosis ?? 'unknown'})`) +
        (result.legs?.length
          ? `; legs: ${result.legs
              .map(
                (l) =>
                  `${l.leg}=${l.failure ?? l.status}${l.traceId ? ` trace:${l.traceId}` : ''}`
              )
              .join(' ')}`
          : '')
    );

    respond({
      action,
      ...extra,
      success: true,
      valid: result.valid,
      ...(result.error ? { error: result.error } : {}),
      ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
      ...(result.legs?.length ? { legs: result.legs } : {}),
      ...(result.note ? { note: result.note } : {}),
      ...(result.accountName ? { accountName: result.accountName } : {}),
      ...(result.storage ? { storage: result.storage } : {}),
      status: this.jira.status()
    });
  }

  private async handleClearJiraCredential(respond: Respond) {
    await this.clearJiraCredential(respond, 'clear_jira_credential_response', {});
  }

  private async clearJiraCredential(
    respond: Respond,
    action: string,
    extra: Record<string, unknown>
  ) {
    if (!this.jira) {
      respond({ action, ...extra, success: false, error: 'unsupported' });
      return;
    }
    await this.jira.clearCredential();
    console.log('jira: credential cleared');
    respond({
      action,
      ...extra,
      success: true,
      status: this.jira.status()
    });
  }

  // --- the generalized {integration} forms ----------------------------------

  private async handleIntegrationCredentialStatus(data: any, respond: Respond) {
    const action = 'integration_credential_status_response';
    const integration = typeof data.integration === 'string' ? data.integration : '';
    if (integration === 'jira') {
      await this.jiraCredentialStatus(respond, action, { integration });
      return;
    }
    if (integration === 'launchdarkly') {
      if (!this.launchdarkly) {
        respond({ action, integration, success: true, available: false, configured: false });
        return;
      }
      respond({
        action,
        integration,
        success: true,
        available: true,
        ...this.launchdarkly.status(),
        storageTarget: await this.launchdarkly.storageTarget()
      });
      return;
    }
    respond({ action, success: false, error: unknownIntegration(integration) });
  }

  private async handleSetIntegrationCredential(data: any, respond: Respond) {
    const action = 'set_integration_credential_response';
    const integration = typeof data.integration === 'string' ? data.integration : '';
    if (integration === 'jira') {
      await this.submitJiraCredential(data, respond, action, { integration });
      return;
    }
    if (integration === 'launchdarkly') {
      const fail = (error: string) =>
        respond({ action, integration, success: false, valid: false, error });
      if (!this.launchdarkly) {
        fail('This daemon has no LaunchDarkly credential support.');
        return;
      }
      const token = typeof data.token === 'string' ? data.token : '';
      if (!token) {
        fail('An API token is required.');
        return;
      }

      const result = await this.launchdarkly.setCredential({ token });

      // Same shape of log line as the Jira submission below: verdict,
      // diagnosis, and the leg trail as status codes and trace ids — never the
      // token, and never LaunchDarkly's response text, which belongs to the
      // (scrubbed) response rather than the log.
      console.log(
        `launchdarkly: credential submitted — ` +
          (result.valid
            ? `valid, stored in ${result.storage}`
            : `rejected (${result.diagnosis ?? 'unknown'})`) +
          (result.legs?.length
            ? `; legs: ${result.legs
                .map(
                  (l) =>
                    `${l.leg}=${l.failure ?? l.status}${l.traceId ? ` trace:${l.traceId}` : ''}`
                )
                .join(' ')}`
            : '')
      );

      respond({
        action,
        integration,
        success: true,
        valid: result.valid,
        ...(result.error ? { error: result.error } : {}),
        ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
        ...(result.legs?.length ? { legs: result.legs } : {}),
        ...(result.storage ? { storage: result.storage } : {}),
        status: this.launchdarkly.status()
      });
      return;
    }
    respond({ action, success: false, valid: false, error: unknownIntegration(integration) });
  }

  private async handleClearIntegrationCredential(data: any, respond: Respond) {
    const action = 'clear_integration_credential_response';
    const integration = typeof data.integration === 'string' ? data.integration : '';
    if (integration === 'jira') {
      await this.clearJiraCredential(respond, action, { integration });
      return;
    }
    if (integration === 'launchdarkly') {
      if (!this.launchdarkly) {
        respond({ action, integration, success: false, error: 'unsupported' });
        return;
      }
      await this.launchdarkly.clearCredential();
      console.log('launchdarkly: credential cleared');
      respond({
        action,
        integration,
        success: true,
        status: this.launchdarkly.status()
      });
      return;
    }
    respond({ action, success: false, error: unknownIntegration(integration) });
  }

  /**
   * The MCP servers a spawning agent gets: every configured integration's,
   * plus Butchr's own.
   *
   * This is the whole of the "which servers?" decision, and it is made in one
   * place for both activation paths. It replaced a hardcoded if-chain in
   * launchers.ts that resolved bare server names — so the Atlassian server's
   * definition lived in a launcher module that had no idea it was Jira's, and
   * adding a platform meant editing that chain.
   *
   * Core last, deliberately: `butchr` is the daemon's own server and an
   * integration must not be able to displace it by declaring a server of the
   * same name. The resulting key order — integrations in registration order,
   * then core — is also the order the old chain produced, so the `.mcp.json`
   * this writes is byte-identical to the one it wrote before.
   */
  private mcpServersForSpawn(): McpServerDefinitions {
    return {
      ...(this.registry ? this.registry.mcpServerDefinitions() : {}),
      ...coreMcpServerDefinitions()
    };
  }

  /**
   * The integrations surface the settings UI renders: one row per
   * integration, each with its provided workspace types and a non-secret
   * credential summary.
   *
   * Backed by the real `Integration` objects the registry holds (KAN-85) —
   * the two-row table this handler used to build by hand is gone, and a third
   * integration appears here by being registered in daemon.ts rather than by
   * being restated.
   *
   * KAN-87's fields keep their shapes exactly; the additions are `enabled` and
   * `providedMcpServers`, and `name` now reads "Atlassian" for the row whose
   * id is still `jira` (see atlassian-integration.ts for why the identity did
   * not move). KAN-91 renders the toggle from `enabled` beside what the row
   * says it provides.
   *
   * KAN-106 fills `providedMcpServers` out from bare names to `ProvidedMcpServer`
   * objects and adds `coreMcpServers` beside the list. The core servers are
   * deliberately *not* a row and not attributed to any integration: `butchr` is
   * the daemon's own, every agent gets it whatever is switched on, and a
   * settings page that listed it under Atlassian would be teaching the reader
   * something false about what the switch does. Sent as a sibling of
   * `integrations` so the page can say "and every agent also gets these"
   * without inventing the fact itself.
   */
  private async handleListIntegrations(respond: Respond) {
    // Test constructions pass no registry; an empty list degrades exactly like
    // the rest of this handler's absent-collaborator cases.
    const integrations = this.registry ? this.registry.integrations() : [];

    // Every storage probe runs a keyring lookup; in parallel so the settings
    // page pays one probe's latency, not the sum.
    const targets = await Promise.all(
      integrations.map((integration) =>
        integration.credential ? integration.credential.storageTarget() : Promise.resolve(undefined)
      )
    );

    respond({
      action: 'list_integrations_response',
      success: true,
      // The daemon's own, named as such. Resolved through the same describer as
      // the integrations' so one rule governs what a settings page may see.
      coreMcpServers: describeMcpServers(coreMcpServerDefinitions()),
      integrations: integrations.map((integration, i) => ({
        id: integration.id,
        name: integration.name,
        // What it provides, whether or not it is switched on — a disabled
        // integration contributes nothing, but the toggle has to be rendered
        // next to what turning it on would give you.
        providedTypes: providedTypesOf(integration),
        providedMcpServers: providedMcpServersOf(integration),
        // "Does this daemon support a credential for it?" — which is what an
        // integration having a credential adapter means.
        available: !!integration.credential,
        enabled: integration.enabled,
        credential: integration.credential
          ? integration.credential.status()
          : { configured: false },
        ...(targets[i] ? { storageTarget: targets[i] } : {})
      }))
    });
  }

  /**
   * Turn an integration on or off — KAN-91's contract, shaped like the
   * credential actions beside it: `{ integration, enabled }` in,
   * `<action>_response` with the same `integration` echoed back out.
   *
   * One action carrying the desired state rather than an enable/disable pair,
   * because a toggle sends what it now is. The response carries the integration
   * row's own fields so the UI can re-render from this answer without a second
   * round trip.
   *
   * Disabling is always allowed, even with agents of that integration's types
   * running: they keep the `.mcp.json` already written into their workspaces
   * and are left strictly alone. Only new activations are refused, and they are
   * refused legibly — see `integrationDisabled`. Standing a fleet down before a
   * toggle could be flipped would be a worse rule than the house one, which is
   * that the Off control warns and lets the human proceed.
   */
  private async handleSetIntegrationEnabled(data: any, respond: Respond) {
    const action = 'set_integration_enabled_response';
    const integrationId = typeof data.integration === 'string' ? data.integration : '';
    if (typeof data.enabled !== 'boolean') {
      respond({
        action,
        integration: integrationId,
        success: false,
        error: '`enabled` must be true or false.'
      });
      return;
    }

    const integration = this.registry
      ? this.registry.integrations().find((i) => i.id === integrationId)
      : undefined;
    if (!integration) {
      respond({ action, success: false, error: unknownIntegration(integrationId) });
      return;
    }

    this.registry.setEnabled(integrationId, data.enabled);
    const running = this.agentsOfIntegration(integration);
    console.log(
      `integrations: ${integrationId} ${data.enabled ? 'enabled' : 'disabled'}` +
        (!data.enabled && running.length
          ? `; ${running.length} running agent(s) of its types left untouched: ${running.join(', ')}`
          : '')
    );

    respond({
      action,
      integration: integrationId,
      success: true,
      enabled: integration.enabled,
      name: integration.name,
      providedTypes: providedTypesOf(integration),
      providedMcpServers: providedMcpServersOf(integration),
      // Named, not counted: a human turning Atlassian off deserves to see
      // which agents go on running under a type that no longer resolves.
      ...(running.length ? { runningAgentsUnaffected: running } : {})
    });
  }

  /** Agent names currently running under one of an integration's types. */
  private agentsOfIntegration(integration: Integration): string[] {
    const types = new Set(integration.workspaceTypes.map((config) => config.type));
    try {
      return this.herdrBridge
        .listHerdrAgents()
        .map((agent) => agent.name)
        .filter((name) => {
          const address = addressFromAgentName(name);
          return !!address && types.has(address.type);
        });
    } catch {
      // Nothing here is worth failing a toggle over; the census is a courtesy.
      return [];
    }
  }

  /**
   * "Is the thing I am looking at the thing that was merged?" — on demand.
   *
   * The audience is as much an agent as a human: an agent that verifies its
   * work against this daemon is verifying whatever was last built, and this is
   * how it can find that out before believing its own acceptance proof.
   */
  private handleStalenessCheck(data: any, respond: Respond) {
    const report = this.staleness(data?.force === true);
    if (!report) {
      respond({
        action: 'staleness_check_response',
        success: false,
        error: 'This daemon was started without install context; staleness cannot be checked.'
      });
      return;
    }
    respond({ action: 'staleness_check_response', success: true, ...report });
  }

  /**
   * Everything running, from herdr's view unioned with our own.
   *
   * The session map is emptied by a daemon restart while the herdr panes keep
   * running, so a list built from sessions alone answers "nothing is running"
   * for a board full of working agents — and that is the reading a supervisor
   * acts on. herdr is therefore the source of existence here, exactly as it
   * already is for `agent_status`, `deactivate` and `reset`; sessions only add
   * what herdr cannot know (session id, bound url, creation time).
   *
   * An entry counts as an agent when *either* test passes: this daemon holds a
   * live session for it, or herdr reports an agent runtime behind its pane.
   * What fails both is a `butchr-*` name with a bare shell behind it and no
   * session of ours — nothing to message, tail or supervise. Those are kept
   * out of `agents`, because a supervisor counting the list must get a number
   * it can act on, and reported under `unbackedPanes`, because silently
   * dropping them would repeat the mistake this handler exists to fix.
   */
  private handleListAgents(data: any, respond: Respond) {
    const { agents, unbackedPanes, staleSessions } = this.surveyAgents();

    // Agents that should be here and are not. Computed from the same census the
    // list is built from, so the two can never disagree about what is running.
    const missingAgents = this.missingAgents(agents, staleSessions);

    // Agents a person switched off. From the same census for the same reason:
    // an agent that is running must never be offered an On button.
    const { standby, total: standbyTotal } = this.standbyAgents(agents);

    // Descriptor headroom, reported where someone looking at agents will see
    // it. On KAN-24 the herdr server's fd usage was invisible until spawning
    // broke, and the only way to learn it was to read /proc by hand. Expressed
    // in panes because that is the unit the reader can act on — "room for 12
    // more agents" is a decision, "62000 descriptors" is trivia.
    const usage = readFdUsage();

    // CPU and memory headroom, for the same reason and in the same place. A
    // supervisor reading this list is about to decide whether to staff another
    // agent; this is the number that decision needs.
    const capacity = this.capacityOf(agents);

    // Staleness rides along on the poll the Agents page is already making, so
    // the banner can appear without a second request and without the page
    // having to know when to ask. The report is cached for 15s inside
    // getStalenessReport, so a 2s poll does not mean a 2s git invocation.
    const staleness = this.staleness();

    respond({
      action: 'list_agents_response',
      success: true,
      agents,
      unbackedPanes,
      // Always present, even when empty: a caller that has to distinguish "no
      // agents are missing" from "this daemon does not track that" cannot do it
      // from an absent field. Empty array means the fleet is whole.
      missingAgents,
      // Work that was taken off the machine to make room for something more
      // important, and has not been put back. Always present, empty when
      // nothing is owed — a caller distinguishing "nothing was preempted" from
      // "this daemon does not track that" cannot do it from an absent field.
      //
      // It is a queue of decisions still owed rather than a log of events: the
      // moment one of these is re-activated it leaves the list. Nothing here
      // restarts them, deliberately — a preemption queue is a scheduler and
      // this ticket said so.
      preemptedAgents: this.preemptedAgents(),
      // Where the Agents page's On button gets its candidates. Always present
      // and empty rather than absent, by the same rule as the two lists above:
      // "nothing is switched off" and "this daemon does not track that" are
      // different answers and a client cannot tell them apart from a missing
      // field. `standbyTotal` is the unclipped count — a list that silently
      // stopped at STANDBY_LIMIT would read as "that is all of them".
      standbyAgents: standby,
      standbyTotal,
      capacity: capacityDto(capacity),
      // What each running agent is worth, and therefore what a would-be
      // activation would have to outrank. Sent alongside the capacity figures
      // because "there is no room" and "there is no room *for you*" became
      // different answers with KAN-37, and a supervisor deciding whether to
      // staff something needs both.
      priorities: this.preemptionCandidates(agents).map((c) => ({
        agentName: c.agentName,
        type: c.type,
        key: c.key,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      ...(staleness ? { staleness } : {}),
      ...(usage ? {
        herdrHealth: {
          pid: usage.pid,
          openFds: usage.openFds,
          softLimit: usage.softLimit,
          headroomPanes: usage.headroomPanes,
          fdPressure: Math.round(usage.ratio * 100) / 100,
          ...(isFdPressureHigh(usage) ? {
            warning:
              `herdr server is using ${Math.round(usage.ratio * 100)}% of its open-file soft limit ` +
              `(${usage.openFds}/${usage.softLimit}); room for about ${usage.headroomPanes} more panes ` +
              `at ${PTMX_FDS_PER_PANE} descriptors each. Close idle agents.`
          } : {})
        }
      } : {})
    });
  }

  /** `butchr_capacity`: how many more agents this machine can carry. */
  private handleCapacity(data: any, respond: Respond) {
    const { agents } = this.surveyAgents();
    const capacity = this.capacityOf(agents);
    const candidates = this.preemptionCandidates(agents);
    respond({
      action: 'capacity_response',
      success: true,
      ...capacityDto(capacity),
      derivation: describeCapacity(capacity),
      // At capacity the next question is always "then what would I have to
      // stand down?", and answering it here saves a caller from working the
      // ordering out for itself — or, worse, guessing at it.
      priorities: candidates.map((c) => ({
        agentName: c.agentName,
        type: c.type,
        key: c.key,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      fleetPriorities: describeFleetPriorities(candidates)
    });
  }

  /**
   * Agents stood down to make room, in the shape a client renders.
   *
   * Reported until they are re-activated. Restarting them is out of scope by
   * the ticket's own words — a preemption queue is a scheduler — so what this
   * buys is that the decision is *owed to someone* rather than lost: the epic
   * and story agents that supervise see it on every poll and can move the
   * ticket back to To Do, and a human sees whose work is waiting.
   */
  private preemptedAgents() {
    if (!this.agentRegistry) return [];
    return this.agentRegistry.preempted().map((entry) => ({
      agentName: entry.agentName,
      type: entry.record.type,
      key: entry.record.key,
      workDir: entry.record.workDir,
      url: entry.record.url ?? null,
      // The preemption record already holds who took the slot; this is the
      // other party — who is owed the decision about putting the work back.
      activatedBy: entry.record.activatedBy ?? null,
      at: entry.at,
      priority: entry.preemption.priority,
      herdrStatusWhenPreempted: entry.preemption.herdrStatus,
      by: {
        agentName: entry.preemption.byAgentName,
        type: entry.preemption.byType,
        key: entry.preemption.byKey,
        priority: entry.preemption.byPriority
      },
      reason:
        `Stood down at ${entry.at} to free capacity for ` +
        `${entry.preemption.byType}/${entry.preemption.byKey} ` +
        `(priority ${entry.preemption.byPriority} against this agent's ` +
        `${entry.preemption.priority}). Its work was interrupted, not finished. ` +
        `Re-activating it resumes the conversation it was stopped in; until then ` +
        `its ticket should not read In Progress.`,
      derivation: entry.preemption.derivation
    }));
  }

  /**
   * The agent census, shared by `list_agents` and by everything that needs to
   * know how many agents are already running before starting another.
   *
   * herdr is the source of existence, not our session map — see
   * handleListAgents for why. Split out so the capacity check counts exactly
   * what the list reports; two answers to "how many agents are running" is one
   * answer too many.
   */
  /**
   * The capacity model applied to a census: task agents in `running`,
   * epic and story agents counted separately as `supervisors` (reported,
   * never charged — see capacity.ts).
   *
   * Every capacity answer in this daemon goes through here, so `running` means
   * the same thing in the refusal, in `list_agents` and in `butchr_capacity`.
   * KAN-34 passed `agents.length` at each call site and the then-single board
   * manager was silently one of them — on a 4-core machine that was half the
   * budget spent on the supervisor, and the user could never start a second
   * task agent.
   */
  /**
   * Whether a `list_agents` entry costs an agent's worth of machine.
   *
   * Not everything the list reports does. The daemon used to open a bare shell
   * for itself — the `default/workspace` session KAN-25 removed — and it
   * appeared in this list because we held a session for it, which is the right
   * answer to "what can I attach to" and the wrong one to "what is this machine
   * carrying". On a 4-core box it was silently occupying one of two slots. The
   * daemon no longer starts anything for itself, but herdr hosts more than
   * Butchr and the distinction still has to be drawn.
   *
   * The test is whether the entry is a workspace type this daemon starts agents
   * into, or whether herdr can see an agent runtime behind the pane. Either is
   * enough; a registered type does not wait for herdr to notice a freshly
   * spawned agent, and a runtime catches anything the registry has not heard of.
   *
   * Shared by the capacity count and the preemption candidate list, so an agent
   * that occupies a slot is exactly an agent that can be asked to give it up.
   */
  private countsAsAgent(entry: ListedAgent): boolean {
    const registered = entry.type !== null && this.registry.get(entry.type) !== undefined;
    return registered || entry.agentRuntime !== null;
  }

  private capacityOf(agents: ListedAgent[]): Capacity {
    let fleet = 0;
    let supervisors = 0;

    for (const entry of agents) {
      if (!this.countsAsAgent(entry)) continue;

      if (isSupervisorType(entry.type)) supervisors++;
      else fleet++;
    }

    return readCapacity(fleet, supervisors);
  }

  /**
   * The workspace type the registry has on file for a key, when it is
   * unambiguous. Used to address an agent that no longer exists anywhere else —
   * see handleDeactivateByKey. Two registered agents sharing a key differ only
   * by type, which is precisely what this cannot guess, so it declines rather
   * than picking one.
   */
  /**
   * Whether an empty pane is evidence that this agent died.
   *
   * For everything Claude-shaped, yes: the runtime is the agent, and its
   * absence is the death. For a `shell` workspace it is the opposite — there
   * was never a runtime to lose, and a bare prompt is the delivered product.
   * Unknown agents are assumed to have a runtime, so a name we cannot place
   * still gets watched rather than quietly excused.
   */
  private expectsRuntime(agentName: string): boolean {
    return this.agentRegistry?.intents().get(agentName)?.record.defaultAgent !== 'shell';
  }

  private registeredTypeFor(key: string): string | undefined {
    if (!this.agentRegistry) return undefined;
    const lower = key.toLowerCase();
    const matches = Array.from(this.agentRegistry.intents().values()).filter(
      (intent) => intent.event === 'activated' && intent.record.key.toLowerCase() === lower
    );
    return matches.length === 1 ? matches[0].record.type : undefined;
  }

  /**
   * The gap between what the registry says should be running and what herdr
   * actually has.
   *
   * The comparison is against the *census*, not against the session map: an
   * agent that survived a daemon restart has no session of ours and is
   * nonetheless perfectly alive, and calling it missing would be the same
   * false alarm KAN-9 and KAN-28 already fixed at other layers.
   */
  private missingAgents(agents: ListedAgent[], staleSessions?: Set<string>): MissingAgent[] {
    if (!this.agentRegistry) return [];

    const alive = new Set(agents.map((a) => a.agentName));
    const missing: MissingAgent[] = [];

    for (const [agentName, intent] of this.agentRegistry.intents()) {
      if (intent.event !== 'activated') continue;
      if (alive.has(agentName)) continue;

      missing.push({
        agentName,
        type: intent.record.type,
        key: intent.record.key,
        workDir: intent.record.workDir,
        url: intent.record.url ?? null,
        activatedBy: intent.record.activatedBy ?? null,
        since: intent.at,
        // Both cases are "not running", but they are not the same event and a
        // reader acting on this deserves the difference: an agent that never
        // came back, versus one that was running under this daemon and died
        // while we held its session. The second is a crash we witnessed.
        reason: staleSessions?.has(agentName)
          ? 'The registry records this agent as active and this daemon still holds a session ' +
            'for it, but herdr has no agent by that name: it started and then died. ' +
            'It is not running.'
          : 'The registry records this agent as active, but herdr has no agent by that name ' +
            'and this daemon holds no session for it. It is not running.'
      });
    }

    return missing;
  }

  /**
   * Agents a person switched off, that could be switched back on.
   *
   * Three filters, each removing a different kind of thing nobody means by
   * "turn it back on":
   *
   *   - still running — the stand-down failed, or it was started again since.
   *     Offering On for something already on is how a control starts lying.
   *   - preempted — reported separately, with the name of what took its slot.
   *     One agent, one switch: a row in two lists is a row that can be pressed
   *     twice.
   *   - no workspace on disk — `reset` records a stand-down too, and the
   *     directory it deleted is the whole difference between "stopped" and
   *     "finished with". Re-activating one of those would create an empty
   *     workspace and start an agent in it with nothing to continue.
   *
   * Newest first, because the thing you just switched off is the thing you are
   * most likely to want back.
   */
  private standbyAgents(agents: ListedAgent[]): { standby: StandbyAgent[]; total: number } {
    if (!this.agentRegistry) return { standby: [], total: 0 };

    const alive = new Set(agents.map((a) => a.agentName));
    const standby: StandbyAgent[] = [];

    for (const [agentName, intent] of this.agentRegistry.intents()) {
      if (intent.event !== 'deactivated') continue;
      if (intent.preemption) continue;
      if (alive.has(agentName)) continue;

      const workDir = intent.record.workDir;
      if (!workDir || !fs.existsSync(workDir)) continue;

      standby.push({
        agentName,
        type: intent.record.type,
        key: intent.record.key,
        workDir,
        url: intent.record.url ?? null,
        defaultAgent: intent.record.defaultAgent ?? null,
        activatedBy: intent.record.activatedBy ?? null,
        since: intent.at,
        reason:
          'Switched off deliberately. Its workspace is still on disk, so switching it back ' +
          'on resumes the conversation it was stopped in rather than starting a new one.'
      });
    }

    standby.sort((a, b) => b.since.localeCompare(a.since));
    return { standby: standby.slice(0, STANDBY_LIMIT), total: standby.length };
  }

  /**
   * What an agent would lose if it were switched off now.
   *
   * Answered from the address rather than from a path the caller supplies: this
   * runs git in the directory it is given, and a client-supplied path would be
   * a client choosing where the daemon executes subprocesses. The workspace is
   * derived from type and key by the same function that creates it.
   *
   * Never fails the request. A check that could not be performed comes back
   * `checked: false` with the reason, because a UI that renders an error as
   * "nothing to lose" is worse than one that never asked.
   */
  private handleAgentWorkState(data: any, respond: Respond) {
    const { key, type } = data;
    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      respond({ action: 'agent_work_state_response', success: false, error: badAddress });
      return;
    }

    // The live session knows where it actually is; the registry remembers for
    // the agents that outlived their session; the convention is the fallback,
    // and is what `initPty` would have used anyway.
    //
    // By (key, type) when the caller gives a type — a same-key session of
    // another type is a different agent in a different directory, and its
    // work state would answer for the wrong workspace (KAN-83). With no type
    // there is only the key to go by, and the key-only match is the best
    // available answer rather than a collision.
    const session = this.herdrBridge.getSessionByAddress(key, type);
    const recorded =
      typeof type === 'string'
        ? this.agentRegistry?.intents().get(agentNameFor(type, key))?.record.workDir
        : undefined;
    const workDir =
      session?.workDir ||
      (recorded && recorded.length ? recorded : undefined) ||
      (typeof type === 'string' ? workspaceDirFor(type, key) : '');

    respond({
      action: 'agent_work_state_response',
      success: true,
      type: type ?? null,
      key,
      ...readWorkState(workDir)
    });
  }

  /**
   * `missingAgents`, for callers outside a request — the daemon's periodic
   * sweep. Public because the sweep runs on a timer rather than in response to
   * a client, and must ask the same question the list answers.
   */
  public findMissingAgents(): MissingAgent[] {
    return this.surveyFleet().missing;
  }

  /**
   * Both halves of what the periodic sweep needs, from one census.
   *
   * The sweep asks two questions — what is gone, and what is each survivor
   * doing — and they have to be asked of the same instant. Two calls would put
   * a `herdr agent list` between them, which is long enough for an agent to
   * appear in one answer and not the other: an agent reported both alive and
   * lost in the same tick would nudge its supervisor about a death that had not
   * happened.
   */
  public surveyFleet(): { agents: ListedAgent[]; missing: MissingAgent[] } {
    const { agents, staleSessions } = this.surveyAgents();
    return { agents, missing: this.missingAgents(agents, staleSessions) };
  }

  /**
   * The supervisor of record for an agent, read back off the durable registry.
   *
   * Public because the notifier is not a request handler: the sweep runs on a
   * timer and has no client, and it must resolve parentage through the same
   * registry the activation wrote it to rather than keeping a second copy.
   */
  public supervisorFor(agentName: string): SupervisorOfRecord | null {
    return this.agentRegistry?.intents().get(agentName)?.record.activatedBy ?? null;
  }

  /**
   * The key as the registry spells it, when it has one.
   *
   * An agent *name* is built from a lower-cased key, so an agent addressed from
   * a census comes back as `kan-98` — and a notice that names `task/kan-98` is
   * read by a supervisor sitting next to a ticket spelled KAN-98.
   * `rememberDeactivated` prefers the registry's spelling for exactly this
   * reason, and a message a person or an agent will read deserves it more.
   */
  public recordedKeyFor(agentName: string): string | undefined {
    return this.agentRegistry?.intents().get(agentName)?.record.key;
  }

  private surveyAgents(): {
    agents: ListedAgent[];
    unbackedPanes: UnbackedPane[];
    staleSessions: Set<string>;
  } {
    const { reachable, agents: herdrAgents } = this.herdrBridge.listHerdrAgentsChecked();
    const byName = new Map<string, HerdrAgentRecord>(herdrAgents.map(a => [a.name, a]));
    const statuses = new Map(herdrAgents.map(a => [a.name, a.herdrStatus]));

    const agents: ListedAgent[] = [];
    const attached = new Set<string>();

    /**
     * Sessions this daemon still holds for agents herdr no longer has.
     *
     * A session is our record that we *started* something; it is not evidence
     * that the thing is still alive, and it outlives the agent whenever the
     * pane dies without us tearing it down — which is precisely what a crashed
     * or killed agent looks like. Listing one as running is how a dead agent
     * keeps a ticket reading In Progress with nothing behind it: the silent
     * loss this whole ticket exists to remove, reintroduced one layer up.
     */
    const staleSessions = new Set<string>();

    for (const session of this.herdrBridge.listActiveSessions()) {
      const agentName = agentNameFor(session.type, session.key);
      attached.add(agentName);

      // herdr is the authority on whether an agent exists — but only when it
      // answered. An unreachable herdr returns an empty census, and treating
      // that silence as "they are all dead" would condemn a perfectly healthy
      // fleet, so in that case we keep trusting the session map.
      //
      // Two different deaths, and only one of them is unconditional. A name
      // herdr has never heard of is gone, full stop. A name it *has* with no
      // runtime behind it is a pane whose agent exited — dead too, except for
      // a `shell` workspace, where a bare prompt and no runtime is the entire
      // point. Calling one of those missing would be a false alarm about
      // something working exactly as asked.
      if (reachable) {
        const record = byName.get(agentName);
        const dead = !record || (!record.agentRuntime && this.expectsRuntime(agentName));
        if (dead) {
          staleSessions.add(agentName);
          continue;
        }
      }

      const dto = this.toAgentDto(session, statuses);
      agents.push({
        sessionless: false,
        agentName,
        sessionId: dto.sessionId,
        type: dto.type,
        key: dto.key,
        url: dto.url ?? null,
        createdAt: dto.createdAt,
        status: dto.status,
        workDir: dto.workDir,
        herdrStatus: dto.herdrStatus,
        agentRuntime: byName.get(agentName)?.agentRuntime ?? null,
        supervisor: isSupervisorType(dto.type),
        // Through the same helper the notifier resolves parentage with, so
        // the row the page nests by and the supervisor a nudge is delivered to
        // can never be two different answers to one question.
        activatedBy: this.supervisorFor(agentName)
      });
    }

    const unbackedPanes: UnbackedPane[] = [];

    for (const record of herdrAgents) {
      if (attached.has(record.name)) continue;
      const address = addressFromAgentName(record.name);
      if (!address) continue; // Not one of ours; herdr hosts more than Butchr.

      if (!record.agentRuntime) {
        unbackedPanes.push({
          agentName: record.name,
          type: address.type,
          key: address.key,
          workDir: record.workDir,
          herdrStatus: record.herdrStatus,
          reason:
            'herdr reports no agent running in this pane and this daemon holds no session for it'
        });
        continue;
      }

      // Session-only fields are null, not invented. There is no session id to
      // report, no url the agent was bound to and no creation time we saw —
      // filling them in to match the attached shape would be a fabrication.
      agents.push({
        sessionless: true,
        agentName: record.name,
        sessionId: null,
        type: address.type,
        key: address.key,
        url: null,
        createdAt: null,
        status: null,
        workDir: record.workDir,
        herdrStatus: record.herdrStatus,
        agentRuntime: record.agentRuntime,
        supervisor: isSupervisorType(address.type),
        // Not a session-only field, so not null-by-construction here: the
        // registry outlives the session map, which is the whole reason an
        // agent that survived a daemon restart still knows who staffed it.
        activatedBy: this.supervisorFor(record.name)
      });
    }

    return { agents, unbackedPanes, staleSessions };
  }

  /**
   * The session id a PTY request names, when it named one at all.
   *
   * `null` covers both a missing id and a non-string one, so the refusal below
   * can tell "you sent no session" from "you sent a session I do not have"
   * without any caller having to trust the shape of the wire.
   */
  private ptySessionId(data: any): string | null {
    return typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  }

  /**
   * The refusal a PTY request gets when it names a session this daemon does not
   * hold.
   *
   * It says which id, what that means, and what to do instead — because the
   * caller is a program, and a program that is only told "no" will retry the
   * same id forever. The alternative this replaces was worse than a bad error
   * message: the daemon used to substitute an arbitrary session, or spawn a
   * `default/workspace` shell, and answer as though the request had been
   * honoured. See KAN-25.
   */
  private unknownPtySession(action: string, sessionId: string | null): string {
    const named =
      sessionId === null
        ? `${action} arrived without a sessionId`
        : `${action} names session '${sessionId}', which this daemon does not have`;
    return (
      `${named}. A PTY session id is only valid for the daemon process that issued it, ` +
      'and this one is not among them — most likely it was issued by a previous daemon ' +
      'and the client has not re-resolved since. Ask for the workspace again (status, then ' +
      'activate) and use the session id that comes back; retrying this one cannot succeed.'
    );
  }

  private handlePtyInit(data: any, respond: Respond) {
    const sessionId = this.ptySessionId(data);
    const session = sessionId === null ? undefined : this.herdrBridge.getSession(sessionId);
    if (sessionId === null || session === undefined) {
      respond({
        action: 'pty_init_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_init', sessionId)
      });
      return;
    }

    respond({
      action: 'pty_init_response',
      success: true,
      sessionId,
      buffer: session.ptyBuffer
    });

    const oldCleanup = this.activePtyListeners.get(sessionId);
    if (oldCleanup) oldCleanup();

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    const cleanup = this.herdrBridge.registerDataListener(sessionId, (ptyData) => {
      this.send({
        action: 'pty_output',
        sessionId,
        data: ptyData
      });
    });

    // Only absent if the session went away between the lookup above and here,
    // which cannot happen synchronously — but nothing is registered on a guess.
    if (cleanup) this.activePtyListeners.set(sessionId, cleanup);
  }

  private handlePtyInput(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    // The most dangerous of the three to answer approximately: keystrokes sent
    // to a session picked on the client's behalf land in some other agent's
    // terminal, and get executed there.
    if (!this.herdrBridge.writePty(sessionId ?? undefined, data.data)) {
      ack({
        action: 'pty_input_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_input', sessionId)
      });
      return;
    }
    ack({ action: 'pty_input_response', success: true, sessionId });
  }

  private handlePtyResize(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    if (!this.herdrBridge.resizePty(sessionId ?? undefined, data.cols, data.rows)) {
      ack({
        action: 'pty_resize_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_resize', sessionId)
      });
      return;
    }
    ack({ action: 'pty_resize_response', success: true, sessionId });
  }

  public cleanup() {
    this.activePtyListeners.forEach(unsub => unsub());
    this.activePtyListeners.clear();
  }
}
