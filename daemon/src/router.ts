import { WorkspaceRegistry, isSupervisorType } from './registry.js';
import { PromptLoader } from './prompt.js';
import { JiraIssueTypeService } from './jira.js';
import {
  HerdrBridge,
  HerdrSession,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  addressFromAgentName,
  agentNameFor,
  typeFromAgentName
} from './herdr.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import { AgentRecord, AgentRegistry, PreemptionRecord } from './agent-registry.js';
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
}

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
    private agentRegistry?: AgentRegistry
  ) {}

  /**
   * Write an activation down before it is acknowledged.
   *
   * Called on every successful activate, but only appends when it would change
   * something: re-attaching to an agent already recorded as activated is a
   * no-op, and the sidepanel re-activates often enough that recording each one
   * would fill the log with restatements of the same intent.
   */
  private rememberActivated(record: AgentRecord): void {
    if (!this.agentRegistry) return;
    const current = this.agentRegistry.intents().get(record.agentName);
    if (
      current?.event === 'activated' &&
      current.record.workDir === record.workDir &&
      current.record.url === record.url &&
      current.record.defaultAgent === record.defaultAgent
    ) {
      return;
    }
    this.agentRegistry.recordActivated(record);
  }

  /**
   * Write a stand-down down, so reconciliation leaves this agent alone.
   *
   * This is the half of the registry that makes it *intent* rather than
   * history: without it, boot-time restoration would resurrect every agent
   * anyone had ever run. Recorded even when the teardown failed — the caller
   * asked for the agent to be gone, and that is the intent to honour.
   */
  private rememberDeactivated(
    type: string,
    key: string,
    workDir?: string,
    preemption?: PreemptionRecord
  ): void {
    if (!this.agentRegistry) return;
    this.agentRegistry.recordDeactivated(
      {
        agentName: agentNameFor(type, key),
        type,
        key,
        workDir: workDir ?? ''
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
      case 'jira_credential_status':
        void guard(this.handleJiraCredentialStatus(respond), 'jira_credential_status');
        break;
      case 'set_jira_credential':
        void guard(this.handleSetJiraCredential(data, respond), 'set_jira_credential');
        break;
      case 'clear_jira_credential':
        void guard(this.handleClearJiraCredential(respond), 'clear_jira_credential');
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
   * `getSessionByKey` miss is not enough to establish that, because the
   * session map dies with the daemon while the herdr pane does not — so
   * `alreadyRunning` asks herdr, and every re-attach after a daemon restart
   * skips the gate. Without it the panel could not get back to agents it was
   * already supervising, and precisely when the machine was busiest.
   *
   * An override is honoured — a cap that cannot be exceeded on purpose is a
   * cap people work around — but it is recorded rather than waved through.
   * Someone reading the log later should be able to see that the machine was
   * over-staffed deliberately, and what the numbers were at the time.
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
    if (!capacity.atCapacity) return pass(capacity);

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — a task
    // agent on a board of task agents outranks nothing, and neither does
    // anything at all when the only thing running is the board manager.
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
   * The board manager is deliberately *included*. It can never be selected —
   * nothing outranks priority 3 and the comparison is strictly-greater — and
   * leaving it in is what makes that a fact about the ordering rather than a
   * special case somebody has to remember. It is protected twice over in any
   * event: its share is reserved off the top rather than counted against the
   * cap, so standing it down would not free a fleet slot even if it could be
   * chosen.
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

  private async handleActivate(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      respond({
        action: 'activate_response',
        success: false,
        error: 'Unsupported URL. No matching Workspace Type found.'
      });
      return;
    }

    const { config, key } = resolved;
    const renderedPrompt = this.promptLoader.loadAndRender(config.promptTemplateFile, {
      KEY: key,
      URL: data.url
    });

    const agentName = agentNameFor(config.type, key);
    let session = this.herdrBridge.getSessionByKey(key);
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
      session = this.herdrBridge.spawnSession(config.type, key, data.url, renderedPrompt, data.defaultAgent, config.mcpServers, resume);
      if (!session.spawnError) this.nudgeIfResumed(session, data.defaultAgent);
    }

    if (!session.spawnError) {
      this.rememberActivated({
        agentName: agentNameFor(config.type, key),
        type: config.type,
        key,
        workDir: session.workDir,
        url: data.url,
        defaultAgent: data.defaultAgent,
        mcpServers: config.mcpServers
      });
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
      mcpServers: config.mcpServers,
      priority: config.priority,
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
    const promptTemplateFile = config?.promptTemplateFile ?? `prompts/${type}.md`;
    const mcpServers = config?.mcpServers ?? ['atlassian', 'butchr'];
    const priority = this.registry.priorityFor(type);
    const agentName = agentNameFor(type, key);
    let session = this.herdrBridge.getSessionByKey(key);
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

    if (!session.spawnError) {
      this.rememberActivated({
        agentName: agentNameFor(type, key),
        type,
        key,
        workDir: session.workDir,
        url,
        defaultAgent,
        mcpServers
      });
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists. Reporting it as a failure here is not KAN-23's
    // post-spawn existence check — that still has to be added, for the case
    // where herdr reports success and the agent is nevertheless absent — but
    // an error herdr handed us must never be answered with success: true.
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
    const success = this.herdrBridge.terminateSession(data.sessionId);
    if (session) this.rememberDeactivated(session.type, session.key, session.workDir);

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId
    });
  }

  public handleDeactivateByKey(data: any, respond: Respond) {
    const { key } = data;
    // Set only by the capacity gate, never by a client: it is the record of why
    // this stand-down was not the agent's own idea. See PreemptionRecord.
    const preemption: PreemptionRecord | undefined = data.preemption;
    const session = this.herdrBridge.getSessionByKey(key);

    if (session) {
      const success = this.herdrBridge.terminateSession(session.sessionId);
      this.rememberDeactivated(session.type, session.key, session.workDir, preemption);

      this.broadcast({
        action: 'agent_deactivated_event',
        type: session.type,
        key: session.key,
        sessionId: session.sessionId,
        ...(preemption ? { preempted: true } : {})
      });

      respond({
        action: 'deactivate_response',
        success,
        sessionId: session.sessionId,
        ...(preemption ? { preempted: true } : {})
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not. Close it through the fallback
    // rather than telling the caller an obviously-running agent is gone.
    const result = this.herdrBridge.closeAgentByKey(key);

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
      (typeof data.type === 'string' && data.type.trim() ? data.type.trim() : undefined) ??
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
      respond({ action: 'reset_response', success: false, error: 'Unsupported URL' });
      return;
    }
    const { config, key } = resolved;
    const session = this.herdrBridge.getSessionByKey(key);

    // Same ordering rule as handleResetByKey: the agent goes first, whether we
    // reach it through the session map or the herdr-list fallback.
    if (session) {
      this.herdrBridge.terminateSession(session.sessionId);
    } else {
      this.herdrBridge.closeAgentByKey(key);
    }

    // A reset destroys the workspace as well as the agent, so it is the most
    // deliberate stand-down there is. Restoring it on the next boot would
    // recreate an agent whose working directory was deliberately deleted.
    this.rememberDeactivated(config.type, key);

    const { success, error } = this.herdrBridge.resetWorkspace(config.type, key);
    respond({ action: 'reset_response', success, ...(error ? { error } : {}) });
  }

  public handleResetByKey(data: any, respond: Respond) {
    const { type, key } = data;
    const session = this.herdrBridge.getSessionByKey(key);

    // Tear the agent down *before* resetWorkspace deletes the directory it is
    // running in. Without a session the agent is still reachable through the
    // herdr-list fallback, and skipping that left the agent alive in a cwd
    // that no longer exists.
    let agentClosed = false;
    let agentError: string | undefined;

    if (session) {
      agentClosed = this.herdrBridge.terminateSession(session.sessionId);
    } else {
      const result = this.herdrBridge.closeAgentByKey(key);
      agentClosed = result.success;
      agentError = result.error;
    }

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
      respond({ action: 'status_response', success: true, supported: false });
      return;
    }

    const base = {
      action: 'status_response',
      success: true,
      supported: true,
      type: resolved.config.type,
      key: resolved.key
    };

    const session = this.herdrBridge.getSessionByKey(resolved.key);
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

  // --- Atlassian credential -------------------------------------------------
  //
  // The token's whole journey is: settings UI → native messaging → here →
  // CredentialStore. It never travels back. These handlers answer with
  // configured/not-configured and a validation verdict, never with the value,
  // so there is nothing for the extension to retain even by accident.

  private async handleJiraCredentialStatus(respond: Respond) {
    if (!this.jira) {
      respond({
        action: 'jira_credential_status_response',
        success: true,
        available: false,
        configured: false
      });
      return;
    }
    // `storageTarget` runs a keyring probe, which is why this handler is async
    // now. It is what lets the settings page say where the token will land
    // before the user types it, rather than after it has already gone.
    respond({
      action: 'jira_credential_status_response',
      success: true,
      available: true,
      ...this.jira.status(),
      storageTarget: await this.jira.storageTarget()
    });
  }

  private async handleSetJiraCredential(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'set_jira_credential_response', success: false, valid: false, error });

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
      action: 'set_jira_credential_response',
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
    if (!this.jira) {
      respond({ action: 'clear_jira_credential_response', success: false, error: 'unsupported' });
      return;
    }
    await this.jira.clearCredential();
    console.log('jira: credential cleared');
    respond({
      action: 'clear_jira_credential_response',
      success: true,
      status: this.jira.status()
    });
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
   * buys is that the decision is *owed to someone* rather than lost: the board
   * manager sees it on every poll and can move the ticket back to To Do, and a
   * human sees whose work is waiting.
   */
  private preemptedAgents() {
    if (!this.agentRegistry) return [];
    return this.agentRegistry.preempted().map((entry) => ({
      agentName: entry.agentName,
      type: entry.record.type,
      key: entry.record.key,
      workDir: entry.record.workDir,
      url: entry.record.url ?? null,
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
   * The capacity model applied to a census, with the manager set aside.
   *
   * Every capacity answer in this daemon goes through here, so `running` means
   * the same thing in the refusal, in `list_agents` and in `butchr_capacity`.
   * KAN-34 passed `agents.length` at each call site and the board manager was
   * silently one of them — on a 4-core machine that was half the budget spent
   * on the supervisor, and the user could never start a second task agent.
   */
  /**
   * Whether a `list_agents` entry costs an agent's worth of machine.
   *
   * Not everything the list reports does. The daemon opens a bare shell for
   * itself (`ensureDefaultSession`), and it appears in that list because we hold
   * a session for it — which is the right answer to "what can I attach to" and
   * the wrong one to "what is this machine carrying". On a 4-core box it was
   * silently occupying one of two slots.
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
   * `missingAgents`, for callers outside a request — the daemon's periodic
   * sweep. Public because the sweep runs on a timer rather than in response to
   * a client, and must ask the same question the list answers.
   */
  public findMissingAgents(): MissingAgent[] {
    const { agents, staleSessions } = this.surveyAgents();
    return this.missingAgents(agents, staleSessions);
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
        agentRuntime: byName.get(agentName)?.agentRuntime ?? null
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
        agentRuntime: record.agentRuntime
      });
    }

    return { agents, unbackedPanes, staleSessions };
  }

  private handlePtyInit(data: any, respond: Respond) {
    const buffer = this.herdrBridge.getPtyBuffer(data.sessionId);
    respond({
      action: 'pty_init_response',
      sessionId: data.sessionId,
      buffer: buffer
    });

    if (this.activePtyListeners.has(data.sessionId)) {
      const oldCleanup = this.activePtyListeners.get(data.sessionId);
      if (oldCleanup) oldCleanup();
    }

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    const cleanup = this.herdrBridge.registerDataListener(data.sessionId, (ptyData) => {
      this.send({
        action: 'pty_output',
        sessionId: data.sessionId,
        data: ptyData
      });
    });

    this.activePtyListeners.set(data.sessionId, cleanup);
  }

  private handlePtyInput(data: any, ack: Respond) {
    this.herdrBridge.writePty(data.sessionId, data.data);
    ack({ action: 'pty_input_response', success: true });
  }

  private handlePtyResize(data: any, ack: Respond) {
    this.herdrBridge.resizePty(data.sessionId, data.cols, data.rows);
    ack({ action: 'pty_resize_response', success: true });
  }

  public cleanup() {
    this.activePtyListeners.forEach(unsub => unsub());
    this.activePtyListeners.clear();
  }
}
