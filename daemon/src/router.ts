import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceRegistry, isSupervisorType } from './registry.js';
import { PromptLoader } from './prompt.js';
import { JiraIssueTypeService } from './jira.js';
import { LaunchDarklyIntegration } from './integrations/launchdarkly.js';
import { Integration, McpServerDefinitions } from './integrations/integration.js';
import {
  coreMcpServerDefinitions,
  prepareWorkspaceMcpServers,
  unusableMcpServers
} from './launchers.js';
// `HerdrSession` stays the FIRST name in this import, on the line directly
// below the brace. `verify-agent-runtime-seam.mjs` §1 reverts the runtime seam
// by textually replacing `import {\n  HerdrSession,` here, and anything between
// the brace and that name — another import, or a comment like this one —
// silently defeats the revert. The proof then reports the required check as red
// when its whole point is that the check is green and blind. Caught by that
// script during KAN-324, twice; hence this note being out here rather than in
// there.
import {
  HerdrSession,
  AmbiguousKeyError,
  CensusReading,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  addressFromAgentName,
  agentNameFor,
  ambiguousKeyMessage,
  type ButchrAgentName,
  typeFromAgentName,
  workspaceDirFor
} from './herdr.js';
import type { AgentRuntime } from './agent-runtime.js';
import { StartLedger, sharedStartLedger } from './start-ledger.js';
import type { RuntimeSwitchReport } from './runtime-switch.js';
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
import { ResumeCause, needsResumeNudge } from './resume.js';
import { nudgeResumedAgent } from './nudge.js';
import { senderTagFor, withSenderTag } from './provenance.js';
import type { CarrierVerdict, ChannelCarrier, ChannelMeta, ChannelRouteOutcome } from './channel.js';
import type { ChannelSelfCheckReport } from './channel-selfcheck.js';
import type { ChannelLivenessState } from './channel-liveness.js';
import type { PendingReport } from './notify.js';
import type { GuardianState } from './guardian.js';
import { boardPageFor } from './board-page.js';
import type { PrWatchHealth } from './pr-watch.js';
import { licenceFor, sealClaims, sealComposerClaims } from './message-claims.js';
import {
  operationByTool,
  ProxyCaller,
  proxyReport,
  refuseProxyCall,
  refuseWriteOutsideCaller,
  selectedProxyMode
} from './atlassian-proxy.js';
// KAN-298. The same shape doing the same job for a second integration — and a
// reader checking "does LaunchDarkly have a write policy too" should meet the
// answer here: there is no `refuseLdWriteOutsideCaller` to import, because
// there is no LaunchDarkly write to bound. See `launchdarkly-proxy.ts`'s header.
import {
  ldOperationByTool,
  ldProxyReport,
  refuseLdProxyCall,
  selectedLdProxyMode
} from './launchdarkly-proxy.js';
import { renderedKey } from './keys.js';

/**
 * What a sender needs, which is not the same as how it travels (KAN-247).
 *
 * `steer` is the ordinary case: a message the recipient should read. `stop-now`
 * says the recipient must stop what it is doing — design §5.1's fifth case,
 * measured in §4 as something only the composer's interrupt can deliver.
 *
 * **This is a requirement, not a carrier.** The daemon maps it to a transport
 * and names the transport in its response; a sender that reads `stop-now` as
 * "the composer" has re-derived the thing §5.1 says it must never derive, and
 * will be wrong the moment the mapping changes.
 */
export type SendIntent = 'steer' | 'stop-now';
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
import { sweepWorkspaces, lastReclaimSummary, reclaimWorkspace, formatBytes } from './reclaim.js';
import { AddressableAgent, BoardControlReport } from './board-control.js';
import {
  Capacity,
  capacityReason,
  capacityRefusal,
  describeCapacity,
  effectiveCeilingOf,
  readCapacity,
  summarizeCapacity
} from './capacity.js';

type Respond = (msg: any) => void;

/**
 * What a stand-down's reclaim did, as it rides both the `deactivate_response`
 * and the `agent_deactivated_event`.
 *
 * Three statuses, and collapsing any two of them loses the fact a reader needs.
 * `reclaimed` did something (possibly nothing, if the workspace was already
 * bare — `paths` says which). `skipped` deliberately did not, and `reason` says
 * why in the words of the condition that refused. `failed` tried and could not,
 * and `error` is what went wrong — the stand-down itself still succeeded.
 *
 * **`bytes` is allocated size, and since KAN-262 it is easily misread.** These
 * trees are hard-linked from a shared store, so deleting one reports its full
 * apparent size while freeing only what nothing else references. A reclaim of
 * ~0 real bytes is the sharing working. See `reclaim.ts`'s header.
 */
export interface StandDownReclaim {
  status: 'reclaimed' | 'skipped' | 'failed';
  /** Absolute paths removed. Empty unless `status` is `reclaimed`. */
  paths: string[];
  bytes: number;
  /** One sentence, for a log line or a row in the Agents page. */
  headline: string;
  /** Candidates found and deliberately left alone — a symlink, a tracked tree. */
  skipped?: { path: string; reason: string }[];
  /** Why nothing was attempted. Present when `status` is `skipped`. */
  reason?: string;
  /** What went wrong. Present when `status` is `failed`. */
  error?: string;
}

/**
 * What the UI is told about a session. Sessions are never sent over the wire
 * directly: they carry a ~100KB ptyBuffer and a live ptyProcess handle, and
 * the Agents page polls list_agents every 2s.
 */
interface AgentDto {
  sessionId: string;
  type: string;
  key: string;
  /**
   * `null` when the session was activated by key without a known page URL and
   * the registry recorded none either — never absent (KAN-481).
   *
   * **It is `string | null` rather than `?: string` so that the vanishing key
   * is not expressible.** `recordedUrlFor` returns `string | undefined` and
   * documents the contract its callers owe it — *"`undefined` here means
   * nothing was written down, and callers render that as `null`"* — and
   * `ListedAgent` states the same invariant for the whole response: *"Nulls
   * are explicit rather than omitted … over JSON an absent field reads as 'not
   * answered', and these are answered — with nothing."* {@link toAgentDto} was
   * the one caller that honoured neither. It spread straight into
   * `agent_status`, `JSON.stringify` dropped the `undefined`, and the key left
   * the response entirely.
   *
   * **What that cost is the reason this is a type and not a comment.** The same
   * agent, read at the same moment, answered `url: null` on `list_agents` and
   * carried no `url` key at all on `agent_status` — so one condition wore two
   * faces, and `epic/KAN-203` reasonably filed them as possibly-three defects
   * ("absent, null, or sometimes populated … those are three different defects
   * and I have not distinguished them"). An optional field would let a later
   * author reintroduce that silently; this one makes it `TS2322` at the
   * assignment.
   */
  url: string | null;
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
  /**
   * What this agent's startup channel self-check found (KAN-248, T5).
   *
   * **This is the field that makes a degraded agent visible**, and visibility is
   * the whole requirement: an agent silently on the composer while the fleet
   * believes it is on channels is the state T5 exists to prevent, and a log line
   * does not prevent it because nobody reads the log until something is already
   * wrong. So it goes on the row a supervisor already polls.
   *
   * Three shapes, three different facts, deliberately not collapsed:
   *
   * - **omitted** — this daemon has no self-check reader wired in and cannot
   *   answer. An older daemon sends no field at all, and a client tells that
   *   from the two below by exactly that difference.
   * - `outcome: 'unchecked'` — nobody has checked this agent. The ordinary case
   *   for one that outlived a daemon restart, and for one spawned while channels
   *   were off. Not a fault, and it degrades nothing (channel-selfcheck.ts says
   *   why at length).
   * - anything else — the check ran. `outcome` names what it found,
   *   `clientVersion` is the client's own report of itself, and `transport` is
   *   the carrier this agent's messages will actually take.
   */
  channel?: ListedAgentChannel;
}

/**
 * A row's channel state, flattened for a reader who is skimming.
 *
 * The `unchecked` shape carries the same keys with nulls rather than being a
 * bare string, so a client can read `row.channel.transport` without first asking
 * which of two shapes it got. Nulls are explicit for the reason
 * {@link ListedAgent} gives: over JSON an absent field reads as "not answered",
 * and these are answered — with nothing.
 */
interface ListedAgentChannel {
  /** `'unchecked'` when no verdict exists; otherwise the report's own outcome. */
  outcome: ChannelSelfCheckReport['outcome'] | 'unchecked';
  /**
   * The carrier this agent's next `steer` actually takes, asked of the same
   * function that routes it (KAN-274).
   *
   * **`'unregistered'` is the third value and the one to read carefully**: the
   * agent holds no channel registration and the registry expects it to, so a
   * `steer` to it is refused rather than delivered by a composer interrupt. It
   * is the ordinary state for the first seconds after a daemon restart, a socket
   * error or a client reload, and it clears by itself when the agent's MCP
   * server re-announces.
   *
   * Before KAN-274 this was the self-check verdict alone and said `'channel'` for
   * agents that had no connection at all.
   */
  transport: ChannelCarrier;
  /** True only when the loop was proved on a client version somebody measured. */
  proved: boolean;
  clientName: string | null;
  clientVersion: string | null;
  clientVersionVerified: boolean | null;
  checkedAt: string | null;
  elapsedMs: number | null;
  /**
   * How many probe attempts the verdict took, or `null` when there is no
   * verdict (KAN-450).
   *
   * `2` means this agent's bring-up replaced its MCP connection while the first
   * check was in flight and the check was re-run against the replacement — so
   * the verdict beside it describes the connection the agent is actually
   * holding, and `elapsedMs` spans both attempts. It is not a fault and needs no
   * action; it is here so that a doubled `elapsedMs` has something on the row
   * that explains it.
   *
   * `null` is the `unchecked` shape's answer, and is the same "answered with
   * nothing" as every other null here — not "this daemon cannot say", which is
   * the ABSENT `channel` key.
   */
  attempts: 1 | 2 | null;
  detail: string;
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
    // Reported, not gated on (KAN-201). Kept on the wire because it is the
    // number a human feels, and because a reader comparing it against
    // cpuBusyCores can see for themselves how far the two diverge — which is
    // the evidence that retired it.
    load1: Math.round(c.machine.load1 * 100) / 100,
    cpuBusyCores: Math.round(c.cpuBusyCores * 100) / 100,
    cpuBusySource: c.cpuBusySource,
    cpuBusyWindowSeconds:
      c.cpuBusyWindowSeconds === null ? null : Math.round(c.cpuBusyWindowSeconds),
    // The stall veto (KAN-218), which is not a count and so has no
    // `headroomBy…` companion. `stallPercent: null` is the one reading a caller
    // must not read as "fine": it means this machine has no /proc/pressure and
    // nothing at all is bounding I/O saturation. `stalled` is therefore sent
    // separately from the figure rather than inferred from it.
    stallPercent: c.stallPercent === null ? null : Math.round(c.stallPercent * 100) / 100,
    stallSource: c.stallSource,
    stallIoPercent:
      typeof c.stall?.ioFullPercent === 'number'
        ? Math.round(c.stall.ioFullPercent * 100) / 100
        : null,
    stallMemoryPercent:
      typeof c.stall?.memoryFullPercent === 'number'
        ? Math.round(c.stall.memoryFullPercent * 100) / 100
        : null,
    stallRefusePercent: c.stallRefusePercent,
    stalled: c.stalled,
    // What the three counting terms allowed before the veto. Equal to
    // `headroom` unless `stalled`, and the pair is what makes the veto's effect
    // legible instead of looking like a machine that happened to be full.
    headroomBeforeStall: c.headroomBeforeStall,
    // The effective ceiling (KAN-517) — how many task agents this machine will
    // admit in total, against the `cap` a caller might otherwise plan against.
    // Sent on every capacity payload rather than only when the two differ, for
    // the reason the block above gives about `unobservedStarts`: a caller
    // cannot tell a machine whose cap is reachable from a build that does not
    // compute this, and `shortfall: 0` is the answer to the first question.
    //
    // Derived here rather than read off `c`, because it is deliberately not a
    // property of Capacity — see effectiveCeilingOf's contract for why the
    // admission gate is not given a ceiling it could start consulting.
    effectiveCeiling: effectiveCeilingOf(c),
    totalMb: Math.round(c.machine.totalBytes / (1024 * 1024)),
    availableMb: Math.round(c.machine.availableBytes / (1024 * 1024)),
    agentMemoryMb: Math.round(c.cost.residentBytes / (1024 * 1024)),
    agentCores: c.cost.cores,
    // Where the two cost figures came from (KAN-56): 'override', 'measured',
    // 'restored', 'stale' or 'seed', plus the sample's metadata when a
    // measurement was consulted. A caller deciding whether to trust the cap can
    // see whether anyone measured it — and, since KAN-365, whether the fleet it
    // was measured over is still running. `measuredAt` is what gives 'stale'
    // its age.
    agentMemorySource: c.costSource.residentBytes,
    agentCoresSource: c.costSource.cores,
    // Starts already admitted that no instrument has priced (KAN-258). Sent
    // whether or not it fired — `count: 0` is the ordinary steady-state answer
    // — because a caller cannot otherwise tell a machine with no starts in
    // flight from a build where this term does not exist. That distinction is
    // the whole of what a reader needs to know this gate is protecting them.
    //
    // A RATE AND AN AMOUNT, AND WHY THEY ARE NOW NAMED AS SUCH (KAN-365)
    //
    // These four numbers are two pairs, and the names used to say so only to
    // whoever wrote them. `cores` was the amount actually taken off the live
    // terms; `chargedCores` was the rate that *would* apply per start. On an
    // idle machine they read:
    //
    //     count: 0   cores: 0   chargedCores: 0.75
    //
    // and `epic/KAN-59` reported a phantom 0.75 core being charged with nothing
    // running. That was a reasonable reading of that block: "charged" is a past
    // participle, it sat one line under an amount, and nothing in the shape
    // distinguished the two. The field was honest and the adjacency was not.
    //
    // `total…` against `perStart…` puts the distinction in the names, so
    // `perStartCores: 0.75` beside `count: 0` reads as the tariff it is —
    // nought starts at 0.75 each. The derivation string says the same thing in
    // words, but only when the term fires, and this block is what a caller
    // parses when it does not.
    unobservedStarts: {
      count: c.unobservedStarts.count,
      totalCores: Math.round(c.unobservedStarts.cores * 100) / 100,
      totalMemoryMb: Math.round(c.unobservedStarts.bytes / (1024 * 1024)),
      perStartCores: c.unobservedStarts.cost.cores,
      perStartMemoryMb: Math.round(c.unobservedStarts.cost.residentBytes / (1024 * 1024)),
      because: c.unobservedStarts.because
    },
    // Null in the ordinary case. Set when the per-agent estimate implied more
    // CPU than the machine reported in use, so `headroomByCpu` below divided by
    // `used` rather than by `agentCores` (KAN-204). Both numbers travel, so a
    // reader can check the contradiction and re-derive the headroom figure.
    // `cap` and `capByCpu` are never affected — see capacity.ts's header.
    liveCoresBound: c.liveCoresBound
      ? {
          published: c.liveCoresBound.published,
          used: Math.round(c.liveCoresBound.used * 1000) / 1000,
          agentTrees: c.liveCoresBound.agentTrees,
          impliedFleetCores: Math.round(c.liveCoresBound.impliedFleetCores * 100) / 100,
          busyCores: Math.round(c.liveCoresBound.busyCores * 100) / 100
        }
      : null,
    measuredAt: c.measured ? new Date(c.measured.sampledAt).toISOString() : null,
    measuredWindowSeconds: c.measured ? Math.round(c.measured.windowSeconds) : null,
    // Task-agent trees only, since KAN-276. It was every claude tree on the
    // machine, which made it a count of one population sitting next to a cost
    // for another — a reading of `running: 0` with `measuredAgentTrees: 3` was
    // how the contamination was finally spotted, and this field now cannot
    // report that combination.
    measuredAgentTrees: c.measured ? c.measured.agentTrees : null,
    // What is held back for supervisors, and what it was worked out from
    // (KAN-276). Always present, `count: 0` when no supervisor is running.
    supervisorReserve: {
      count: c.supervisorReserve.count,
      perSupervisorMb: Math.round(c.supervisorReserve.perSupervisorBytes / (1024 * 1024)),
      reservedMb: Math.round(c.supervisorReserve.bytes / (1024 * 1024)),
      source: c.supervisorReserve.source
    },
    capByCpu: c.capByCpu,
    capByMemory: c.capByMemory,
    headroomByCap: c.headroomByCap,
    headroomByCpu: c.headroomByCpu,
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
 * The extra fields an ambiguous-address refusal carries, whoever discovered the
 * ambiguity (KAN-473).
 *
 * A bare key can collide in two places — this daemon's session map, which the
 * handlers resolve directly, and herdr's own agent list, which `HerdrBridge`
 * consults for agents that outlived their session and which refuses by
 * throwing. Both refusals must reach the client in ONE shape, or a caller ends
 * up parsing agent names back out of prose for half of them.
 *
 * Returns `null` for anything else, so an ordinary failure is not dressed up as
 * a collision.
 */
function ambiguityFields(
  err: unknown
): { refusedBy: 'ambiguous-key'; candidates: string[] } | null {
  return err instanceof AmbiguousKeyError
    ? { refusedBy: 'ambiguous-key', candidates: err.candidates }
    : null;
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
   * Directories the daemon puts ahead of PATH for this server's process, when
   * it puts any there (KAN-157). Reported because it is a *material* part of
   * what the server is — for an npx-based server it is what decides which Node
   * runs it, which is the thing that was invisible while KAN-157 was live.
   * Directories, composed by the daemon; see `McpServerDefinition.pathPrefix`.
   */
  pathPrefix?: string[];
  /**
   * Set when this server cannot start on this machine, in the daemon's own
   * words (KAN-157). The settings page is the surface that advertises what
   * enabling an integration hands every agent, so it is where "and this one
   * would not start" has to be legible — a page that lists a server it knows is
   * dead is the same silence the ticket was filed about.
   */
  unusable?: string;
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
/**
 * The activation refusal for a server that cannot start on this machine —
 * KAN-157's, moved here from `HerdrBridge.initPty` by KAN-398. Returns the
 * message to refuse with, or `null` when every server is startable, which is
 * the normal answer.
 *
 * ## Why it moved, and why it could not stay
 *
 * It reads `McpServerDefinition.unusable`, and `prepareWorkspaceMcpServers`
 * strips that field on its way to producing what the runtime seam accepts. Left
 * where it was, it would have run *after* the strip and found an empty list on
 * every activation for ever — **a check that can only return the reassuring
 * answer, which is worse than no check because it still looks like one.** So the
 * strip decided where this lives, and above the seam is the only side of it
 * where the field still exists.
 *
 * ## What that buys, beyond staying alive
 *
 * `CrabCastRuntime` never had this refusal — the ticket that moved it (KAN-398)
 * records it as the third thing `provision()` did not do. Here it covers both
 * runtimes and any third, because it runs before the seam rather than inside one
 * implementation of it.
 *
 * ## KAN-157's argument, unchanged, in KAN-84's voice
 *
 * REFUSE RATHER THAN WARN, DELIBERATELY. The failure this replaces is not "the
 * agent has fewer tools" — it is that *nobody finds out*. Claude Code reports a
 * server that dies at parse time nowhere the agent can see, so an epic agent
 * with no Jira coordinated a board it could not read for two hours and blamed
 * everything else first. A warning goes to the daemon log, which is the one
 * place the affected agent cannot look; the agent would still boot believing it
 * had the tools its brief tells it to use, and would still spend its budget
 * discovering otherwise. The activation is where a human is present and where a
 * message is unmissable, so that is where this is said.
 *
 * WHAT MAKES REFUSING SAFE, which is the other half of the decision: an operator
 * is never stuck. A disabled integration contributes no servers at all
 * (registry.ts), so switching Atlassian off returns the fleet to service
 * immediately, and the refusal says so. And the resolver prefers the daemon's
 * own Node — the interpreter already running this code — so on any machine where
 * the daemon itself runs, this branch is unreachable by construction. It is a
 * backstop that fires when the machine genuinely cannot host the server, not a
 * hurdle on the normal path.
 *
 * ## THE ONE BEHAVIOURAL DIFFERENCE, NAMED RATHER THAN DISCOVERED
 *
 * `initPty` refused a session it had already created, so a refused activation
 * left a `'terminated'` session carrying `spawnError`. Refusing here happens
 * before `spawnSession`, so **no session record is made at all.** The client
 * response is unchanged — `activate_response` with `success: false` and this
 * same message, which is the branch both call sites already had for
 * `session.spawnError` — and the message's own words ("Nothing was started") are
 * more true now than they were. Both call sites check inside their
 * `if (!session)` branch, so an activation that reuses a live agent is not
 * refused, exactly as before.
 */
function refuseUnusableMcpServers(defs: McpServerDefinitions): string | null {
  const unusable = unusableMcpServers(defs);
  if (unusable.length === 0) return null;
  return (
    `MCP server${unusable.length > 1 ? 's' : ''} that cannot start on this machine: ` +
    unusable.map(([name, why]) => `${name} — ${why}`).join(' ') +
    ` Nothing was started — an agent spawned without the tools its brief tells it to use ` +
    `has no way to find out they are missing.`
  );
}

function describeMcpServers(defs: McpServerDefinitions): ProvidedMcpServer[] {
  return Object.entries(defs).map(([name, definition]) => {
    // KAN-157 added `pathPrefix` and `unusable`, and neither loosens the rule
    // above. `unusable` is the daemon's own sentence about a server that cannot
    // start, so it is reported whether or not detail is withheld — a withheld
    // definition that is also dead must still be able to say the second thing.
    const unusable = definition.unusable ? { unusable: definition.unusable } : {};

    if (definition.env && Object.keys(definition.env).length > 0) {
      return { name, detailWithheld: true as const, ...unusable };
    }
    return {
      name,
      command: definition.command,
      args: [...definition.args],
      // Directories, composed by the daemon rather than supplied whole by the
      // integration — the argument for why that is safe to render is on
      // `McpServerDefinition.pathPrefix`, beside the field itself.
      ...(definition.pathPrefix?.length ? { pathPrefix: [...definition.pathPrefix] } : {}),
      ...unusable
    };
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

/**
 * Everything the router can be given but does not require.
 *
 * WHY THIS IS AN OBJECT AND NOT A PARAMETER LIST (KAN-226)
 *
 * It used to be six optional positional parameters, and on 2026-08-07 two
 * branches raced for the same slot: PR #89 added `capacitySource` tenth and
 * PR #90 added `boardControl` tenth, one conflicted hunk in one file. The
 * textual conflict was trivial; the resolution was a trap. Both proofs passed
 * their argument positionally, `.mjs` is not typechecked, and one of the two
 * orderings was *silent* — `verify-board-reconciler-guard.mjs` would have fed
 * its `capacitySource` into the `boardControl` slot, never called the misbound
 * function, and quietly gone back to reading the real machine. That is the
 * defect review had already sent #89 back for, restored invisibly.
 *
 * The other ordering happened to fail loudly, but only because the two
 * parameters were structurally incompatible. Two optional parameters of
 * compatible shape would have made *both* orderings silent. Naming the slots
 * is what removes the hazard: a field cannot be taken by the wrong argument,
 * so the next optional parameter cannot disarm an existing one. Callers that
 * TypeScript checks get excess-property errors on a misspelling; callers it
 * does not — the `verify-*.mjs` proofs — get the constructor's unknown-key
 * throw below, which is the same protection delivered a moment later.
 *
 * The first five constructor parameters are genuinely required and genuinely
 * ordered; they stay positional. This is the optional tail only.
 */
export interface MessageRouterOptions {
  jira?: JiraIssueTypeService;
  /**
   * Where this daemon is installed and when it started — everything the
   * staleness check needs. Absent in the unit-test constructions that do not
   * care, in which case the check is simply not offered.
   */
  install?: { repoRoot: string; daemonStartedAt: Date };
  /**
   * The durable record of which agents should exist. Optional for the same
   * reason `install` is — the unit-test constructions do not care — and when
   * absent nothing is recorded and nothing is reported missing, which is
   * exactly the pre-KAN-21 behaviour.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Optional exactly as `jira` is: a construction that does not pass one
   * simply answers "no LaunchDarkly credential support" on the credential
   * actions, and `list_integrations` reports the integration unavailable.
   */
  launchdarkly?: LaunchDarklyIntegration;
  /**
   * Where capacity comes from, so a proof can hold it still.
   *
   * WHY THIS SEAM EXISTS, AND IT IS NOT A CONFIGURATION KNOB (KAN-221)
   *
   * `readCapacity` measures the machine this daemon is running on, which is
   * exactly right in production and is the one thing a proof cannot control.
   * `verify-board-reconciler-guard.mjs` isolates herdr with a fake binary and
   * `$HOME` with a temp directory, and its verdict was *still* a function of
   * what else the box happened to be doing: reviewed on a machine at 2.88 of
   * 4 cores, its first section was refused by the real gate and the script
   * exited 1 with the product working perfectly.
   *
   * That is worse than an ordinary flaky test, and the reason is specific to
   * that script. Its first section exists to prove the loop *can* stand an
   * agent down — without it, "the loop stood nothing down on a failed read"
   * is a claim a loop that never acts would also satisfy. So a first section
   * that fails environmentally invites the next reader to weaken or delete
   * the one section that gives the rest of the file its meaning.
   *
   * Injecting capacity is the same move as the fake `herdr`: hold the
   * environment still so the thing under test is the only variable. The
   * alternative offered — `override: true` on the activations — was refused
   * on review and rightly: it would have made the capacity section the only
   * one exercising a path every other section bypassed.
   *
   * **Optional, and unreachable from a client.** Nothing in a request can
   * set it; the daemon constructs its routers without one, so production
   * behaviour is `readCapacity` exactly as before. A construction that passes
   * one is a proof, and the refusals it produces are still the real gate's,
   * computed by the real `computeCapacity` from the facts it was handed.
   *
   * (This read "Optional, last, and unreachable" while it was the tenth
   * positional parameter. KAN-226 made it a named field, so "last" no longer
   * describes anything — and being last is precisely what stopped protecting
   * it the moment an eleventh parameter was added.)
   */
  capacitySource?: (
    running: number,
    supervisors: number,
    /**
     * When each still-running agent this router started was started, wall-clock
     * ms (KAN-258). A proof that injects a two-parameter function still
     * type-checks and still gets the old behaviour, which is what keeps the
     * existing scripts working unchanged.
     */
    startedAt: readonly number[]
  ) => Capacity;
  /**
   * The board's grip on the fleet, for the Agents page's Off and On controls
   * (KAN-222). Optional by the same rule as everything above it, and the
   * absence is load-bearing rather than incidental: a daemon that does not
   * pass one omits `boardControl` from `list_agents_response` entirely, and
   * the page then says nothing about the board at all.
   *
   * That is the honest degradation. "This daemon has no board reconciler" and
   * "the reconciler is switched off" are different facts, and only the second
   * is a claim about the board — so a client that cannot tell them apart must
   * not be handed a default that looks like either. An older extension
   * ignores the field; an older daemon never sends it; both keep the
   * pre-KAN-222 behaviour, which was correct for a world with no reconciler
   * in it.
   */
  boardControl?: (agents: AddressableAgent[]) => BoardControlReport;
  /**
   * The channel carrier for `send_to_agent` (KAN-247, T4 of KAN-150).
   *
   * Injected rather than reached for, because the router deliberately knows
   * nothing about the transport: it is constructed with a `send` closure and
   * has no socket, while the identity map KAN-243 built lives in `daemon.ts`
   * beside the connections it indexes. This closure is the seam between them,
   * and it is the same shape as `boardControl` above for the same reason.
   *
   * **Absence is off, and it is honest rather than incidental.** A daemon that
   * passes none — every proof that constructs a bare router, and any future
   * embedding without a socket set — routes every send over the composer,
   * exactly as it did before this ticket, and the response says `composer` with
   * a reason naming the absence. There is no default channel to fall into,
   * which is what keeps "the daemon decides" from meaning "the router guesses".
   */
  channelRoute?: (
    address: { type: string; key: string },
    content: string,
    /**
     * String values only (KAN-319). `unknown` here until this ticket, which is
     * what let a producer hand the carrier a boolean the client would silently
     * drop; see `ChannelMeta` in channel.ts for what that cost.
     */
    meta?: ChannelMeta
  ) => ChannelRouteOutcome;
  /**
   * What one agent's startup channel self-check found (KAN-248, T5 of KAN-150).
   *
   * A reader, not the store, and injected for the same reason `channelRoute` is:
   * the verdicts live in `daemon.ts` beside the connections they describe, and
   * the router must not learn what a connection is to report a row.
   *
   * **Absence and `null` are different answers and the row says which.** A
   * daemon that passes no reader cannot answer the question at all — every
   * harness router, and any embedding without a socket set — so `channel` is
   * omitted from the row entirely. A reader that answers `null` is saying this
   * agent has no verdict, which is a real state (`unchecked`) with a real
   * meaning: nobody has proved this agent's channel loop. Collapsing the two
   * would let "this daemon cannot tell you" read as "nothing is wrong".
   */
  channelSelfCheck?: (address: { type: string; key: string }) => ChannelSelfCheckReport | null;
  /**
   * Which carrier this agent's next `steer` takes, and why (KAN-274).
   *
   * A reader for the same reason the two above are, and it exists so that the
   * *row* and the *route* cannot disagree: `list_agents` used to answer this
   * question itself, off the self-check verdict alone, and got it wrong for every
   * agent that had lost its registration. It now asks `carrierFor` — the one
   * function `routeChannelMessage` also consults.
   *
   * **It takes an address and nothing else, and the missing second argument is
   * the point (KAN-435).** It used to take a `degraded` boolean that this router
   * derived from `report.transport === 'composer'` — a second answer to a
   * question the verdict store owns. That derivation is not merely duplicated,
   * it is *unanswerable from here*: whether a verdict degrades depends on
   * whether it describes the connection the agent is holding right now, and this
   * router has never known what a connection is. Removing the parameter is what
   * makes a listing structurally unable to hold an opinion about it.
   *
   * **Absence keeps the old answer.** A daemon that passes none reports the
   * self-check verdict exactly as it did before KAN-274, rather than acquiring a
   * third transport value no reader was written for.
   */
  channelCarrier?: (address: { type: string; key: string }) => CarrierVerdict;

  /**
   * What the scheduled end-to-end channel probe has found (KAN-252).
   *
   * Fleet-level rather than per-agent, and that is the shape of the fact: the
   * probe asks **one** agent per run, so a row cannot carry it without implying
   * the other rows were asked and were silent. What a reader needs is when a
   * channel frame last reached a *model*, on which client version, and how many
   * delivered runs have gone unanswered since — one answer for the fleet.
   *
   * A reader for the same reason `channelSelfCheck` is one, plus a sharper one:
   * handing the router the probe itself would put "start a run" one typo away
   * from a listing, and a run costs a real agent a turn.
   *
   * Absent when no probe is wired, `null` never — see `channelLiveness` in the
   * response, which is omitted rather than nulled for the reason `boardControl`
   * is.
   */
  channelLiveness?: () => ChannelLivenessState;

  /**
   * Which agent runtime is serving this daemon (KAN-278).
   *
   * **A value rather than a reader, and that is the point.** A runtime is
   * chosen once, at boot, because it owns live sessions and live pty
   * attachments and cannot be swapped under them. A reader would invite a
   * second read of the environment, and a second read is exactly how a report
   * comes to describe a mode the daemon is not in. `daemon.ts` passes the
   * report `createAgentRuntime` returned **alongside the runtime it returned**,
   * so the object serving and the sentence describing it came out of one call.
   *
   * Absent when nothing wired it — a `verify-*.mjs` constructing a bare router
   * is the ordinary case — and the handler says so rather than guessing.
   */
  agentRuntimeReport?: RuntimeSwitchReport;

  /**
   * Notifications the daemon could not deliver (KAN-301).
   *
   * A reader rather than the store, by the same rule as `channelSelfCheck` and
   * `channelLiveness` above: the router reports what is held and must not be one
   * keystroke away from being able to hold, flush or abandon anything itself.
   *
   * Fleet-level rather than a per-agent row, and that is deliberate. The
   * interesting case is an agent that is **not** in the listing — one that was
   * stood down while news for it was still held — and a field hung off each
   * running agent's row could not express that. It is also the shape of the
   * question a supervisor asks: *"is there anything Butchr failed to tell
   * anyone?"*
   *
   * Absent when nothing wired it — every `verify-*.mjs` constructing a bare
   * router is the ordinary case — and never `null`, so "nothing is held" cannot
   * be confused with "this daemon does not track that".
   */
  pendingNotifications?: () => PendingReport;

  /**
   * Who the guardian is, and whether its poke is landing (KAN-284).
   *
   * A reader for the same reason `channelLiveness` is one, and with the same
   * sharper second reason: handing the router the poker itself would put "poke
   * the guardian now" one typo away from a listing, and a poke lands in a real
   * agent's context.
   *
   * **Fleet-level, and never a per-agent row.** There is exactly one guardian,
   * and the state a reader needs — that there is none, or that its last poke did
   * not land — is a fact about the *fleet*. Worse, a field hung off the
   * guardian's own row could not express the case that matters most: a guardian
   * that is **not in the listing at all** because it is not running. That is
   * precisely the state AC3 calls loud.
   *
   * Absent when nothing wired it — every `verify-*.mjs` constructing a bare
   * router is the ordinary case — and never `null`, so "this daemon has no
   * guardian mechanism" cannot be read as "no guardian is set". Those are
   * different facts and only the second is a claim about the fleet.
   */
  guardian?: () => GuardianState;

  /**
   * Whether the pull-request watcher can currently see GitHub (KAN-304).
   *
   * A reader, by the same rule as the four above. Fleet-level for the same
   * reason `pendingNotifications` is: the question it answers — *"is anything
   * about our pull requests going unobserved right now?"* — is not a property of
   * any one running agent, and the interesting answer names pull requests whose
   * agents are not in the listing at all.
   *
   * It exists because a watcher is the artifact most able to fail silently: a
   * daemon that has not reached GitHub for an hour reports exactly the same
   * clean nothing as one that has looked every minute and found nothing new.
   * `PrWatchHealth.detail` is the sentence that separates them, and this is what
   * puts it where a supervisor will actually read it.
   *
   * Absent when nothing wired it, and never `null`, so "nothing has changed"
   * cannot be confused with "this daemon does not watch pull requests".
   */
  prWatch?: () => PrWatchHealth;

  /**
   * The record of starts this daemon has made that no instrument has priced
   * yet (KAN-258), shared across every router in the process by default
   * (KAN-365).
   *
   * Injectable only so a proof can give two routers two ledgers and reproduce
   * the reading that made `unobservedStarts` look like it oscillated —
   * production wants the shared one, which is what omitting this gives.
   */
  startLedger?: StartLedger;
}

/**
 * The option names, listed once so the constructor can reject anything else.
 *
 * This exists for the callers TypeScript never sees. Every `verify-*.mjs` in
 * `daemon/scripts` constructs a real router, and a plain `.mjs` object literal
 * gets no excess-property check — so `{ capacitySrc: … }` would be accepted,
 * silently ignored, and the proof would go on measuring the real machine while
 * reporting a verdict about an injected one. Naming the slots removes the
 * *positional* hazard for everybody; this removes the *spelling* hazard for
 * the callers that are not typechecked.
 *
 * Keep it in step with `MessageRouterOptions`. The `satisfies` clause makes
 * that mechanical rather than a matter of discipline: a field added to the
 * interface and not to this array is a compile error, and a name here that is
 * not a field of the interface is too.
 */
const MESSAGE_ROUTER_OPTION_NAMES = [
  'jira',
  'install',
  'agentRegistry',
  'launchdarkly',
  'capacitySource',
  'boardControl',
  'channelRoute',
  'channelSelfCheck',
  'channelCarrier',
  'channelLiveness',
  'agentRuntimeReport',
  'pendingNotifications',
  'guardian',
  'prWatch',
  'startLedger'
] as const satisfies readonly (keyof MessageRouterOptions)[];

// The other direction. `satisfies` above catches a name in the array that is
// not a field; this catches a field that is not in the array. Without it the
// array could fall behind the interface, and an option the constructor has
// never heard of would be rejected as unknown by the very throw meant to
// protect it — the same silent-then-baffling failure one layer along. The
// default type argument is the set of undeclared fields, and it has to be
// `never` for this line to compile, so adding a field without adding its name
// is a compile error naming the field.
type MissingOptionNames = Exclude<keyof MessageRouterOptions, (typeof MESSAGE_ROUTER_OPTION_NAMES)[number]>;
type AssertEveryOptionIsDeclared<_T extends never = MissingOptionNames> = true;
export type _MessageRouterOptionsAreFullyDeclared = AssertEveryOptionIsDeclared;

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  /** See {@link MessageRouterOptions.jira}. */
  private readonly jira?: JiraIssueTypeService;
  /** See {@link MessageRouterOptions.install}. */
  private readonly install?: { repoRoot: string; daemonStartedAt: Date };
  /** See {@link MessageRouterOptions.agentRegistry}. */
  private readonly agentRegistry?: AgentRegistry;
  /** See {@link MessageRouterOptions.launchdarkly}. */
  private readonly launchdarkly?: LaunchDarklyIntegration;
  /** See {@link MessageRouterOptions.capacitySource}. */
  private readonly capacitySource: (
    running: number,
    supervisors: number,
    startedAt: readonly number[]
  ) => Capacity;
  /**
   * When this *daemon* started each agent, and whether the fleet census has
   * ever reported it (KAN-258).
   *
   * The capacity gate divides figures that describe *settled* agents, so it
   * cannot see one it started three seconds ago; this is the record that lets
   * it charge for them anyway. See capacity.ts's `unobservedStartsAmong` for
   * which of these end up being charged — the rule lives there, next to the
   * measurement whose staleness it is about, rather than here.
   *
   * **Shared across routers, and that is the fix rather than an implementation
   * detail (KAN-365).** This was a `Map` field, and daemon.ts builds one router
   * per connection, so each client got its own ledger and `unobservedStarts`
   * answered a different question per socket. See start-ledger.ts, which holds
   * the readings that were taken of it.
   */
  private readonly startLedger: StartLedger;
  /** See {@link MessageRouterOptions.boardControl}. */
  private readonly boardControl?: (agents: AddressableAgent[]) => BoardControlReport;
  /** See {@link MessageRouterOptions.channelRoute}. */
  private readonly channelRoute?: MessageRouterOptions['channelRoute'];
  /** See {@link MessageRouterOptions.channelSelfCheck}. */
  private readonly channelSelfCheck?: MessageRouterOptions['channelSelfCheck'];
  /** See {@link MessageRouterOptions.channelCarrier}. */
  private readonly channelCarrier?: MessageRouterOptions['channelCarrier'];
  /** See {@link MessageRouterOptions.channelLiveness}. */
  private readonly channelLiveness?: MessageRouterOptions['channelLiveness'];
  /** See {@link MessageRouterOptions.agentRuntimeReport}. */
  private readonly agentRuntimeReport?: MessageRouterOptions['agentRuntimeReport'];
  /** See {@link MessageRouterOptions.pendingNotifications}. */
  private readonly pendingNotifications?: MessageRouterOptions['pendingNotifications'];
  /** See {@link MessageRouterOptions.guardian}. */
  private readonly guardian?: MessageRouterOptions['guardian'];
  /** See {@link MessageRouterOptions.prWatch}. */
  private readonly prWatch?: MessageRouterOptions['prWatch'];

  constructor(
    private registry: WorkspaceRegistry,
    private promptLoader: PromptLoader,
    private herdrBridge: AgentRuntime,
    private send: (msg: any) => void,
    private broadcast: (msg: any) => void = send,
    opts: MessageRouterOptions = {}
  ) {
    // Loud on a name nobody declared. TypeScript already refuses a misspelled
    // field in a checked caller; this is the same refusal for the `.mjs`
    // proofs, which are the callers that actually got burned. Throwing beats
    // ignoring because the failure mode being replaced was *being ignored*: an
    // option that silently does not arrive leaves the proof asserting against
    // production defaults while it reports on an injected world.
    const unknown = Object.keys(opts).filter(
      (key) => !(MESSAGE_ROUTER_OPTION_NAMES as readonly string[]).includes(key)
    );
    if (unknown.length > 0) {
      throw new TypeError(
        `MessageRouter: unknown option${unknown.length > 1 ? 's' : ''} ${unknown
          .map((key) => `'${key}'`)
          .join(', ')}. Known options: ${MESSAGE_ROUTER_OPTION_NAMES.join(', ')}.`
      );
    }

    this.jira = opts.jira;
    this.install = opts.install;
    this.agentRegistry = opts.agentRegistry;
    this.launchdarkly = opts.launchdarkly;
    this.capacitySource = opts.capacitySource ?? readCapacity;
    this.boardControl = opts.boardControl;
    this.channelRoute = opts.channelRoute;
    this.channelSelfCheck = opts.channelSelfCheck;
    this.channelCarrier = opts.channelCarrier;
    this.channelLiveness = opts.channelLiveness;
    this.agentRuntimeReport = opts.agentRuntimeReport;
    this.pendingNotifications = opts.pendingNotifications;
    this.guardian = opts.guardian;
    this.prWatch = opts.prWatch;
    // The shared ledger unless a proof injected one: a start is a fact about
    // the machine, and every router in this process must answer for the same
    // machine (KAN-365).
    this.startLedger = opts.startLedger ?? sharedStartLedger;
  }

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

  /**
   * Reclaim a stood-down agent's dependencies, and never at the cost of the
   * stand-down itself.
   *
   * **Why stand-down is the trigger, and not the Jira transition.** The human's
   * ask was for cleanup to happen by itself rather than when somebody remembers,
   * and the story's hardest constraint is *never reclaim from a live agent*. A
   * ticket moving to Done says nothing about whether an agent is still working
   * in that workspace — KAN-79's poller reads only the issues of agents that
   * are **live** (`jira-poll.ts`), so Done arrives at precisely the moment the
   * exclusion would have to refuse. Stand-down is the same moment in practice —
   * a close-out transitions the ticket and deactivates the agent — and it is the
   * one at which the safety condition is true **by construction** rather than by
   * inference.
   *
   * **Called after the teardown is confirmed, never before.** Reclaiming
   * underneath a process that is still running is the failure this whole story
   * guards, so every call site below sits behind its own `success`.
   *
   * Three things it will not do:
   *
   *   - **Not on a preemption.** A preemption is an interruption, not a finish:
   *     the agent is expected back, usually within the hour, and
   *     `butchr_list_agents` lists it as work owed. Deleting its tree would
   *     charge an involuntary stand-down a reinstall that a voluntary one is
   *     choosing to pay. The `preemption` record is what tells the two apart.
   *   - **Not while anything is still live in that directory.** `terminateSession`
   *     returning success is our own account of the teardown; this asks herdr,
   *     through the same `surveyAgents()` census `list_agents` and
   *     `reclaim_sweep` are built from, so the exclusion and the fleet a
   *     supervisor is looking at cannot disagree. Fails **closed**: a herdr that
   *     did not answer establishes nothing, so nothing is deleted.
   *   - **Not at the expense of the stand-down.** The caller asked for the agent
   *     to be gone; disk is a side effect. Every failure below is caught,
   *     logged, and reported — `deactivate` still succeeds.
   *
   * The report rides the response *and* the `agent_deactivated_event`, because a
   * stand-down that silently shrank a workspace is the surprise this epic keeps
   * deleting. Note `bytes` is honest but easily misread: since KAN-262 these
   * trees are hard-linked from a shared store, so a reclaim that frees ~nothing
   * on `df` is the mechanism working rather than failing — `reclaim.ts`'s header
   * carries the full account.
   */
  private reclaimForStandDown(args: {
    type: string;
    key: string;
    workDir?: string;
    preemption?: PreemptionRecord;
  }): StandDownReclaim {
    const { type, key, preemption } = args;

    if (preemption) {
      return {
        status: 'skipped',
        paths: [],
        bytes: 0,
        reason: 'this stand-down is a preemption — the agent is expected back, so its workspace is left as it was',
        headline: 'Nothing reclaimed: preempted agents keep their dependencies'
      };
    }

    // The session's own answer first, then what the last activation recorded —
    // the by-key path can stand down an agent whose session this daemon never
    // held, and the registry is the only thing that still knows where it lived.
    const workDir =
      args.workDir ||
      this.agentRegistry?.intents().get(agentNameFor(type, key))?.record.workDir ||
      '';

    if (!workDir) {
      return {
        status: 'skipped',
        paths: [],
        bytes: 0,
        reason: 'no workspace directory is recorded for this agent, so there is nothing to reclaim from',
        headline: 'Nothing reclaimed: no workspace directory on record'
      };
    }

    const live = this.liveWorkspaceCheck(workDir);
    if (live) {
      return { status: 'skipped', paths: [], bytes: 0, reason: live, headline: `Nothing reclaimed: ${live}` };
    }

    try {
      const result = reclaimWorkspace(workDir, { dryRun: false });
      const paths = result.removed.map((r) => r.path);
      return {
        status: 'reclaimed',
        paths,
        bytes: result.bytes,
        ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
        headline:
          paths.length > 0
            ? `Reclaimed ${formatBytes(result.bytes)} in ${paths.length} node_modules from ${type}/${key}`
            : `Nothing left to reclaim in ${type}/${key}`
      };
    } catch (e: any) {
      // The stand-down is what was asked for. This is reported and logged, and
      // it does not travel any further than this return.
      const error = `Reclaim after stand-down failed for ${type}/${key}: ${e?.message ?? String(e)}`;
      console.error('[MessageRouter]', error);
      return { status: 'failed', paths: [], bytes: 0, error, headline: 'Reclaim failed; the stand-down stands' };
    }
  }

  /**
   * Whether anything is still running in `workDir` — the reason to refuse, or
   * null when the directory is genuinely nobody's.
   *
   * Compared by resolved path, so a symlinked workspace cannot dodge the check
   * by being spelled differently in the census than it is on disk. That is the
   * same rule `sweepWorkspaces` applies to its own `liveWorkDirs`, and it is
   * applied here rather than shared because the two are asking about different
   * things: the sweep asks *which of these many*, this asks *is this one*.
   *
   * It reads herdr twice — once for `reachable`, which `surveyAgents` does not
   * return, and once inside it. That is deliberate and it is not a hot path: a
   * stand-down happens on human or supervisor time, and the alternative is a
   * guard that cannot tell "nothing is running" from "nobody answered". Those
   * two must not be the same answer when the consequence is a delete.
   */
  private liveWorkspaceCheck(workDir: string): string | null {
    const { reachable } = this.herdrBridge.listHerdrAgentsChecked();
    if (!reachable) {
      return 'herdr did not answer, so nothing could be established about what is still running';
    }

    const { agents, unbackedPanes } = this.surveyAgents();
    const resolve = (dir: string): string => {
      try {
        return fs.realpathSync(dir);
      } catch {
        return path.resolve(dir);
      }
    };

    const target = resolve(workDir);
    // Panes with a bare shell behind them count, for `handleReclaimSweep`'s
    // reason: somebody may be sitting in front of one, mid-`npm install`.
    const occupants = [...agents.map((a) => a.workDir), ...unbackedPanes.map((p) => p.workDir)];

    for (const dir of occupants) {
      if (typeof dir !== 'string' || !dir) continue;
      if (resolve(dir) === target) return 'an agent is still live in this workspace';
    }

    return null;
  }

  /**
   * What actually became of an agent a by-key stand-down could not close —
   * **as three distinct values, so the wrong one cannot be spelled** (KAN-507).
   *
   * This exists because the fact it reports used to be a boolean, and a boolean
   * had no room for the case that was actually happening. `goneAlready` meant
   * *"the close failed and the runtime was reachable"*, and it was read as
   * *"nothing was running"* — two claims a single `true` cannot tell apart.
   *
   * **The type is the fix, not the message.** `epic/KAN-203` cautioned on this
   * ticket against repairing the wording alone, and it was right: rewording
   * `alreadyGone` would leave a daemon that still could not distinguish an agent
   * it had stopped from one it had merely failed to address. A discriminated
   * union makes `still-running` a value the response must handle, so the honest
   * branch cannot be dropped by a later author without a compile error.
   *
   * **The census is the authority here, and it is the same one the capacity gate
   * and `list_agents` are built from** — `listHerdrAgentsChecked()`'s reading,
   * joined on the Butchr agent name. That matters under CrabCast: their
   * registry, not our session map, is what charges a slot, so it is the only
   * thing that can answer *"is this workspace still costing the machine
   * anything"*.
   *
   * Fails **closed**, exactly as {@link liveWorkspaceCheck} does: a census that
   * could not be taken establishes nothing, so it yields `unverifiable` rather
   * than either confident answer. Reporting an unreachable runtime as
   * `already-gone` is how a stand-down of a live agent gets announced.
   */
  private standDownVerdict(
    result: { success: boolean; error?: string },
    closedType: string | undefined,
    key: string
  ):
    | { outcome: 'closed' }
    | { outcome: 'already-gone' }
    | { outcome: 'still-running'; record: HerdrAgentRecord }
    | { outcome: 'unverifiable'; reason: string } {
    if (result.success) return { outcome: 'closed' };

    // Without a type there is no agent name to join a census row on, and the
    // registry had nothing to record either. Nothing may be concluded.
    if (!closedType) {
      return {
        outcome: 'unverifiable',
        reason:
          'no workspace type could be resolved for this key, so no census row could be ' +
          'joined and nothing was established about what is still running'
      };
    }

    const census = this.herdrBridge.listHerdrAgentsChecked();
    if (!census.reachable) {
      return {
        outcome: 'unverifiable',
        reason:
          'the agent runtime did not answer, so nothing could be established about whether ' +
          'this agent is still running'
      };
    }

    const agentName = agentNameFor(closedType, key);
    const record = census.agents.find((a) => a.name === agentName);
    // A row in the census is the runtime asserting this agent exists right now.
    // That is the state the old boolean reported as "No agent was running."
    if (record) return { outcome: 'still-running', record };

    return { outcome: 'already-gone' };
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
        void guard(this.handleTailAgent(data, respond), 'tail_agent');
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
      case 'agent_runtime_report':
        this.handleAgentRuntimeReport(respond);
        break;
      case 'staleness_check':
        this.handleStalenessCheck(data, respond);
        break;
      case 'reclaim_sweep':
        this.handleReclaimSweep(data, respond);
        break;
      case 'capacity':
        this.handleCapacity(data, respond);
        break;
      case 'agent_work_state':
        this.handleAgentWorkState(data, respond);
        break;
      case 'atlassian_proxy_status':
        void guard(this.handleAtlassianProxyStatus(respond), 'atlassian_proxy_status');
        break;
      case 'atlassian_proxy_call':
        void guard(this.handleAtlassianProxyCall(data, respond), 'atlassian_proxy_call');
        break;
      case 'launchdarkly_proxy_status':
        void guard(this.handleLaunchDarklyProxyStatus(respond), 'launchdarkly_proxy_status');
        break;
      case 'launchdarkly_proxy_call':
        void guard(this.handleLaunchDarklyProxyCall(data, respond), 'launchdarkly_proxy_call');
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
    // a lockout in practice — desktop baseline load alone could pin the live
    // term at 0 indefinitely, which meant epic and story agents
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
    // A stall is not a slot shortage, so no stand-down can relieve it (KAN-218).
    //
    // Preemption's bargain is that destroying one agent's work frees a slot the
    // incoming agent then takes. That holds for the count term exactly, and the
    // block below already accepts that it holds only approximately for cpu and
    // memory — it proceeds unconditionally after a successful stand-down rather
    // than re-running the gate, because "the kernel has not yet reclaimed the
    // memory" and refusing after killing an agent is the worst outcome
    // available.
    //
    // For a stall the bargain fails outright. `full avg10` is a decaying
    // ten-second average of time the machine spent making no progress, so it
    // cannot drop inside this call however many agents are stood down, and the
    // condition it reports — a disk that is failing, or a machine thrashing on
    // swap — is not one that a freed slot addresses. Preempting here would
    // destroy an agent's work and then start a new agent onto the same stalled
    // machine, which is strictly worse than either refusing or admitting.
    //
    // So a stall-bound refusal offers no victim and takes none. `override:
    // true` still works and is still recorded with these figures: an operator
    // who can see the machine may know something the gate does not.
    const stallBound = capacity.headroomBoundBy === 'stall';
    const victim = stallBound ? null : selectVictim(candidates, priority);
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
      // `noVictimReason` would be false here: on a stalled machine there may
      // well be something below this priority, and saying there is not would
      // send the reader to check an ordering that is not what refused them.
      // The reason no victim is offered is that a stand-down cannot help.
      const whyNoVictim = stallBound
        ? 'No stand-down is offered: a stalled machine is not short of a slot, so freeing one ' +
          'would destroy an agent\'s work without making room. Wait for the stall to clear ' +
          '(the figure above is a 10-second average, so give it at least that long), fix what ' +
          'is stalling the machine, or pass override: true to start anyway.'
        : victim
          ? preemptionOffer(victim, priority)
          : noVictimReason(candidates, priority);
      const refusal = `${capacityRefusal(capacity, what)}\n${whyNoVictim}`;
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
   * Only when a conversation actually came back, **or when the runtime could
   * not say whether one did** (KAN-432). The `'fresh'` branch started with the
   * degraded-resume prompt on its command line and is already working; the
   * unknown has not been shown to be that, and {@link needsResumeNudge} carries
   * the argument for why it is nudged rather than assumed.
   *
   * CONSUMER 2 OF 4. This read `session.resumedConversation !== true`, which
   * folded an absent verdict into the already-working branch — the same
   * collapse as `reconcile.ts`, on the path a sidepanel re-activation of a
   * preempted agent takes rather than the path a reboot takes. Under
   * `CrabCastRuntime` the field was never set at all, so this returned early
   * for every agent it was ever asked about.
   */
  private nudgeIfResumed(session: HerdrSession, defaultAgent?: string): void {
    if (!session.resume || !needsResumeNudge(session.resumedConversation)) return;
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
   * Whether the runtime serving this daemon has a live agent at this exact name.
   *
   * The same predicate reconciliation uses (`filter(a => a.agentRuntime)`) and
   * for the same reason: a runtime keeps a name registration for any pane it
   * ever started an agent into, so the name answering is not evidence of an
   * agent. See the `staleRecord` branch of `HerdrBridge.spawnSession`.
   *
   * **It was called `hasLiveHerdrAgent` until KAN-475, and the name is the
   * whole of what that ticket found here.** `this.herdrBridge` is typed
   * {@link AgentRuntime} and built once by `createAgentRuntime`, so it holds
   * *whichever* runtime is serving — under CrabCast this reads CrabCast's own
   * census, which is what the field name and the method name both denied. The
   * ticket was filed reporting that these two reads bypass the runtime seam;
   * they do not, and the misnaming is what made a correct call site read as a
   * broken one. Measured rather than argued: `verify-runtime-agnostic-census.mjs`
   * puts a live CrabCast-owned agent in front of this method and the collision
   * guard below.
   */
  private hasLiveAgent(agentName: string): boolean {
    return this.herdrBridge
      .listHerdrAgents()
      .some((agent) => agent.name === agentName && agent.agentRuntime !== null);
  }

  /**
   * A live agent sharing this key under a *different* type, or undefined.
   *
   * Keys are shared across types by design, so this is a question with a real
   * answer rather than an anomaly detector — `epic/KAN-39` and `task/KAN-39`
   * are both nameable addresses. What makes the pair interesting is that both
   * being live at once is the (key, type) collision KAN-83 exists to prevent.
   *
   * **Reads the serving runtime's census, not herdr's** — see
   * {@link hasLiveAgent} for why that sentence is worth writing down. This is
   * the read KAN-475 flagged as the dangerous one, because its failure mode
   * would be silence: a guard that finds no sibling because it looked in the
   * wrong runtime's list reports "no collision" in the same words as a guard
   * that looked in the right one and found nothing. KAN-473's bare-key refusal
   * depends on the collision being found, so that failure would take this
   * one's protection with it.
   */
  private liveAgentAtKeyOfOtherType(type: string, key: string): string | undefined {
    for (const agent of this.herdrBridge.listHerdrAgents()) {
      if (agent.agentRuntime === null) continue;
      const address = addressFromAgentName(agent.name);
      if (!address) continue;
      if (address.key.toLowerCase() !== key.toLowerCase()) continue;
      if (address.type === type) continue;
      return agent.name;
    }
    return undefined;
  }

  /**
   * Whether starting a *new* agent here would be a start nobody asked for.
   *
   * KAN-196. Both arms below are about the same event, which happened on
   * 2026-08-05T00:57 and then recurred on every reboot for two days:
   * `butchr-task-kan-39` — an artifact stood down at the 2026-08-03 cutover,
   * which KAN-39's description says must never run again — was started by a URL
   * activation, which wrote `activated` into the durable registry and thereby
   * *revoked its stand-down*. From then on boot-time reconciliation restored it
   * every time, correctly: `AgentRegistry.expected()` reads the last event per
   * agent, and the last event said `activated`.
   *
   * So the restore path is not the defect. It consulted the stand-down and
   * honoured it — 274 of the 274 agents whose last event is `deactivated` stay
   * down across a reboot. The defect is that a stand-down can be revoked by an
   * activation nobody intended, silently, and that nothing downstream can tell
   * the difference between that and a person switching an agent back on.
   *
   * Two things had to be true at once for it to happen, and this guard denies
   * each of them separately:
   *
   *   1. **The type was a guess.** `WorkspaceRegistry.resolve` refines a Jira
   *      issue URL by asking Jira what kind of issue it is, and lands on `task`
   *      when that question cannot be answered — which the journal records it
   *      doing for KAN-39, seven seconds before the spawn:
   *      `jira: issue-type lookup for KAN-39 failed (… timed out); falling back
   *      to the default workspace type`. So the daemon started `task/KAN-39`
   *      while `epic/KAN-39` was live, which is invariant 5's collision, whose
   *      failure mode is killing the epic agent's PTY.
   *   2. **Nobody asked.** The activation came from the sidepanel's automatic
   *      re-attach, whose own comment says it "reuses the herdr pane rather
   *      than starting anything". It sends a plain `activate`, which starts
   *      things — the sentence claimed more than the mechanism covered. The
   *      panel now says `reattachOnly` when it means it, and this is where that
   *      word is honoured.
   *
   * Deliberate starts are untouched: the On switch, Reconnect, [Start anyway],
   * [Stand down … and start], and every `activate_by_key` caller (the Agents
   * page and the MCP tool, which name the type instead of guessing it) all
   * reach this with `reattachOnly` unset, and arm 2 only fires when the address
   * is both recorded stood-down *and* about to collide with a live sibling.
   * Turning an ordinary stood-down agent back on from its own page is the case
   * this must not break, and it does not: with no live agent at its key, arm 2
   * has nothing to refuse.
   */
  private unintendedStart(
    type: string,
    key: string,
    agentName: string,
    reattachOnly: boolean
  ): { refusedBy: string; error: string } | undefined {
    if (reattachOnly && !this.hasLiveAgent(agentName)) {
      return {
        refusedBy: 'reattach-only',
        error:
          `Nothing to re-attach to: ${this.herdrBridge.runtimeName} has no live agent ` +
          `named ${agentName}. ` +
          `This request was the panel re-attaching to an agent it believed was already ` +
          `running, and re-attaching is the whole of what it is allowed to do — starting ` +
          `one here would be a start nobody asked for. Use the On switch to start it.`
      };
    }

    const intent = this.agentRegistry?.intents().get(agentName);
    if (intent?.event !== 'deactivated') return undefined;

    const sibling = this.liveAgentAtKeyOfOtherType(type, key);
    if (!sibling) return undefined;

    return {
      refusedBy: 'stood-down-collision',
      error:
        `Refusing to start ${type}/${key}: it was deliberately stood down at ${intent.at}, ` +
        `and ${sibling} is live under the same key right now — so starting it would both ` +
        `revoke that stand-down and put two agents on one key, which is the collision ` +
        `(key, type) addressing exists to prevent. This activation resolved its type from ` +
        `a URL, and a URL cannot tell a Jira Task from an Epic; if the type is right, say ` +
        `so explicitly from the Agents page, which activates by (type, key).`
    };
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
    agentName: ButchrAgentName
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

    // ⚠ THE CAUSE IS READ AFTER THE WAIT, BECAUSE IT DOES NOT EXIST BEFORE IT
    // (KAN-507, finding 4).
    //
    // `spawnSession` returns synchronously under CrabCast — provisioning is a
    // `void`-ed promise — so the caller's `if (session.spawnError)` check runs
    // **before the round-trip that produces one has completed**, and reads
    // `undefined` every time. The refusal lands in `spawnError` about a second
    // later, while this method is still polling; by the time the poll gives up,
    // the real cause has been sitting on the session for nine seconds and
    // nothing looks at it again.
    //
    // What the caller got instead was the *symptom* this method is built to
    // observe: `no pane named butchr-task-kan-506 in CrabCast's census`. That
    // reads as a census or naming bug and sends the reader hunting a lookup
    // defect. `epic/KAN-39` hit it four times over on 2026-08-16 — including
    // once with `override: true` — and only found the actual reason, *"at
    // capacity — 3 charged agents are already running against a cap of 3"*, by
    // reading `daemon.log`, which no response pointed it at.
    //
    // **Upstream cause beats downstream symptom**, so it is preferred here. The
    // census reading is kept alongside rather than discarded: it is still the
    // evidence that the agent is genuinely not there, and dropping it would
    // trade one half-true message for another.
    const spawnError = this.herdrBridge.getSession(session.sessionId)?.spawnError ?? session.spawnError;
    const complaint = spawnError
      ? `${spawnError}\n\nThe census was then checked and agreed the agent is not there: ${presence.error}`
      : presence.error;

    console.error(`[Router] Refusing to report ${agentName} activated: ${complaint}`);
    if (presence.reason === 'absent') {
      this.herdrBridge.abandonSession(session.sessionId, complaint);
    }
    return complaint;
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
      // Before the capacity gate, because this is not a question about whether
      // the machine can hold another agent — it is whether anybody asked for
      // one. See unintendedStart. Only the URL path checks this: the by-key
      // callers state the type rather than deriving it from a page.
      const unintended = this.unintendedStart(
        config.type,
        key,
        agentName,
        data.reattachOnly === true
      );
      if (unintended) {
        console.warn(`[Router] ${unintended.error}`);
        respond({
          action: 'activate_response',
          success: false,
          type: config.type,
          key,
          url: data.url,
          error: unintended.error,
          refusedBy: unintended.refusedBy
        });
        return;
      }

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
      // Before anything is written or spawned, and before the assembly is
      // prepared — `prepareWorkspaceMcpServers` strips the field this reads.
      const refusal = refuseUnusableMcpServers(mcpServers);
      if (refusal) {
        console.error(`[Router] Refusing to start ${agentName}: ${refusal}`);
        respond({
          action: 'activate_response',
          success: false,
          type: config.type,
          key,
          url: data.url,
          error: refusal
        });
        return;
      }
      // A preempted agent switched back on is resuming interrupted work, not
      // starting it. See resumeCauseFor.
      const resume = this.resumeCauseFor(agentName);
      // `config.priority` is the SAME expression the capacity gate above was
      // given, so Butchr's gate and CrabCast's cannot disagree (KAN-482).
      session = this.herdrBridge.spawnSession(
        config.type,
        key,
        data.url,
        renderedPrompt,
        config.priority,
        isSupervisorType(config.type),
        data.defaultAgent,
        prepareWorkspaceMcpServers(mcpServers, { type: config.type, key }),
        resume,
        // The SAME `data.override` the gate above was given, for the same reason
        // `priority` is reused rather than re-derived (KAN-482): the two gates
        // must not be able to disagree about what the caller asked for. Under
        // CrabCast this is the one that reaches the gate that actually refuses —
        // see `AgentRuntime.spawnSession` (KAN-507).
        Boolean(data.override)
      );
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

    // Before the broadcast, so the next capacity question — which a listener
    // may ask the moment it hears this — already charges for this agent
    // (KAN-258).
    this.recordStart(agentName);

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

      // Before anything is written or spawned, and before the assembly is
      // prepared — `prepareWorkspaceMcpServers` strips the field this reads.
      const refusal = refuseUnusableMcpServers(mcpServers);
      if (refusal) {
        console.error(`[Router] Refusing to start ${agentName}: ${refusal}`);
        respond({
          action: 'activate_response',
          success: false,
          type,
          key,
          url,
          error: refusal
        });
        return;
      }

      // The `priority` this handler already resolved for its own capacity gate,
      // reused rather than re-derived — see the other call site (KAN-482).
      session = this.herdrBridge.spawnSession(
        type,
        key,
        url,
        renderedPrompt,
        priority,
        isSupervisorType(type),
        defaultAgent,
        prepareWorkspaceMcpServers(mcpServers, { type, key }),
        resume,
        // As at the other call site: the same flag the gate above was given, so
        // Butchr's gate and CrabCast's cannot disagree about it (KAN-507).
        Boolean(data.override)
      );

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

    // See handleActivate: recorded before the broadcast (KAN-258).
    this.recordStart(agentName);

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

    // Only once the teardown is confirmed. This path carries no `preemption` —
    // it is the by-session stand-down, and the capacity gate stands its victims
    // down by key — so a stand-down that arrives here is a voluntary one.
    const reclaim =
      success && session
        ? this.reclaimForStandDown({ type: session.type, key: session.key, workDir: session.workDir })
        : undefined;

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId,
      ...(reclaim ? { reclaim } : {}),
      ...(error ? { error } : {})
    });
  }

  public handleDeactivateByKey(data: any, respond: Respond) {
    const { key } = data;
    // The address's type half, honoured when the caller states it — the
    // sidepanel and the preemption path both do. Without it a key shared
    // across types would stand down whichever type's session was created
    // first, not the one the caller meant (KAN-83). A caller that names no
    // type is answered only when the key names exactly one agent; see the
    // refusal below.
    const requestedType =
      typeof data.type === 'string' && data.type.trim() ? data.type.trim() : undefined;
    // Set only by the capacity gate, never by a client: it is the record of why
    // this stand-down was not the agent's own idea. See PreemptionRecord.
    const preemption: PreemptionRecord | undefined = data.preemption;
    const resolution = this.herdrBridge.resolveSessionByAddress(key, requestedType);

    // ⚠ THE DESTRUCTIVE VERB REFUSES ON AMBIGUITY RATHER THAN PICKING (KAN-473).
    //
    // This handler used to take the first session on the key and tear it down,
    // and answer `success: true` naming the agent it had chosen. The schema
    // disclosed it — *"a bare key stops whichever of them it happens to reach"*
    // — and disclosure is not a control: `epic/KAN-59` stood `task/KAN-117`
    // down while `story/KAN-117` was live on the same key, and the only thing
    // that saved the story agent was a person remembering to pass `type`. A
    // supervisor would have been destroyed by a correct-looking call whose
    // response reported success.
    //
    // Refusing costs the caller one parameter and destroys nothing. It also
    // TELLS them the collision exists, which the pick never could — this is the
    // `refuse-on-occupied` shape KAN-124 established, applied to an address.
    if (resolution.outcome === 'ambiguous') {
      respond({
        action: 'deactivate_response',
        success: false,
        key,
        refusedBy: 'ambiguous-key',
        candidates: resolution.candidates,
        error: ambiguousKeyMessage(key, resolution.candidates)
      });
      return;
    }

    const session = resolution.outcome === 'one' ? resolution.session : undefined;

    if (session) {
      const { success, error } = this.herdrBridge.terminateSession(session.sessionId);
      this.rememberDeactivated(session.type, session.key, session.workDir, preemption);

      // Behind `success`, for the reason the broadcast below is: reclaiming
      // underneath an agent whose teardown could not be confirmed is exactly
      // the failure the live-agent exclusion exists to prevent.
      const reclaim = success
        ? this.reclaimForStandDown({
            type: session.type,
            key: session.key,
            workDir: session.workDir,
            preemption
          })
        : undefined;

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
          ...(preemption ? { preempted: true } : {}),
          ...(reclaim ? { reclaim } : {})
        });
      }

      respond({
        action: 'deactivate_response',
        success,
        ...(reclaim ? { reclaim } : {}),
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
    // ⚠ WHAT `closeAgentByKey` FAILING ACTUALLY MEANS, AND WHY REACHABILITY IS
    // NOT ENOUGH TO PROMOTE IT TO "ALREADY GONE" (KAN-507).
    //
    // This condition used to be `!result.success && closedType && reachable`,
    // and its reasoning was sound for `HerdrBridge`: that runtime resolves a
    // stand-down through *herdr's own pane list*, so a failure there really was
    // herdr saying "no such agent", and reachability was the qualifier that
    // separated it from "nobody answered".
    //
    // **Under `CrabCastRuntime` the same failure means something else entirely.**
    // Its `closeAgentByKey` resolves against `this.sessions` — the session map
    // this daemon holds — and says so in its own refusal: *"no session this
    // daemon started matches <type>/<key>"*. That map dies with the daemon while
    // CrabCast's registry does not, so **every agent that outlived a daemon
    // restart fails this lookup while running, charged, and visible in the
    // census.** Reachability is then true (CrabCast answered fine), and the old
    // condition promoted "I hold no session for it" to "No agent was running."
    //
    // Measured 2026-08-16 on `task/kan-420`: `crabcast status` reports `state:
    // running` with `sessionless: true` in the same breath, pid 156100 alive at
    // 546 MB, holding one of three CrabCast slots — while this response claimed
    // it was already gone. The response contradicted itself inside one payload,
    // because `reclaim` consults the census and this line did not: it carried
    // `alreadyGone: true` beside `reclaim.reason: "an agent is still live in
    // this workspace"`.
    //
    // So the census is consulted here too, and the two answers are separate
    // values rather than one boolean — see {@link standDownVerdict}. A verdict
    // of `still-running` cannot be spelled as `alreadyGone`, which is the state
    // this ticket exists to make unrepresentable.
    const verdict = this.standDownVerdict(result, closedType, key);
    const goneAlready = verdict.outcome === 'already-gone';

    // The agent is gone — either herdr just closed it, or it was already dead
    // and herdr said so. Both are stand-downs with the teardown confirmed, and
    // both are workspaces with nothing running in them. The workDir comes off
    // the registry inside the helper: this path never held a session to read
    // one from, which is the whole reason `rememberDeactivated` falls back the
    // same way one line above.
    const reclaim =
      (result.success || goneAlready) && closedType
        ? this.reclaimForStandDown({ type: closedType, key, preemption })
        : undefined;

    if (result.success || goneAlready) {
      this.broadcast({
        action: 'agent_deactivated_event',
        type: closedType,
        key,
        ...(preemption ? { preempted: true } : {}),
        ...(reclaim ? { reclaim } : {})
      });
    }

    respond({
      action: 'deactivate_response',
      key,
      ...(closedType ? { type: closedType } : {}),
      success: result.success || goneAlready,
      ...(preemption ? { preempted: true } : {}),
      ...(reclaim ? { reclaim } : {}),
      // KAN-508. `workspace` means the runtime stopped an agent this daemon
      // held no session for, by addressing its workspace path — the route
      // KAN-507 could only name in `stopItWith`. It is reported because "the
      // stand-down worked" and "the stand-down worked *and* it went down a
      // route that exists for agents this daemon had lost track of" are
      // different facts to an operator reading a fleet that stopped shrinking.
      ...(result.route ? { standDownRoute: result.route } : {}),
      // "…so it will not be restored" is what this said until KAN-196, and it
      // promised more than the record provides. What a `deactivated` record
      // actually buys is that `AgentRegistry.expected()` omits this agent, so
      // boot-time reconciliation leaves it down — measured, and it holds: 274
      // of the 274 agents whose last event is `deactivated` stayed down across
      // both of the reboots this ticket was filed about. What it does not buy
      // is permanence. Any later `activated` record overwrites it, because the
      // registry is intent and the last word wins; `task/KAN-39` came back for
      // two days on exactly that route. So the sentence now names the guarantee
      // it has rather than the one a reader would like it to have, and points
      // at the thing that can undo it.
      ...(goneAlready
        ? {
            alreadyGone: true,
            note:
              'No agent was running. Its stand-down is recorded, so restoring the fleet ' +
              'will not bring it back. Only an explicit activation will — and that ' +
              'overwrites this record, so a stand-down meant to be permanent needs ' +
              'nothing to activate this agent again.'
          }
        : {}),
      // ⚠ THE HONEST FORM OF THE CLAIM THIS TICKET WAS FILED ABOUT (KAN-507).
      //
      // The stand-down INTENT is recorded — `rememberDeactivated` ran above and
      // `expected()` will omit this agent — but the process was not stopped and
      // the slot it holds was not freed. Saying so plainly is the whole fix:
      // the caller asked for an agent to be gone, and it is not gone.
      //
      // `success: false`, because the caller's actual request did not happen.
      // That is a deliberate reversal of the paragraph above it, and the two are
      // not in tension: "already dead" is the request working, and "still
      // running" is the request failing. Collapsing them is what made a live
      // 546 MB process read as a completed stand-down.
      //
      // The route that DOES work is named rather than left to be discovered.
      // `epic/KAN-203` found it by hand while the fleet was deadlocked; nobody
      // should have to find it twice.
      ...(verdict.outcome === 'still-running'
        ? {
            stillRunning: {
              agentName: verdict.record.name,
              herdrStatus: verdict.record.herdrStatus,
              workDir: verdict.record.workDir,
              standDownRecorded: true,
              detail:
                'The stand-down was RECORDED but the agent was NOT stopped: this daemon holds ' +
                'no session for it, and the runtime census still reports it running. Under ' +
                'CrabCast a slot stays charged until the agent actually stops, so this ' +
                'workspace is still counted against the cap.',
              stopItWith: verdict.record.workDir
                ? `crabcast deactivate ${verdict.record.workDir}`
                : 'crabcast deactivate <the agent\'s workspace path>'
            }
          }
        : {}),
      ...(verdict.outcome === 'unverifiable' ? { standDownUnverifiable: verdict.reason } : {}),
      ...(result.error && !goneAlready ? { error: result.error } : {})
    });
  }

  /**
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   *
   * WHOSE VOICE THE RECIPIENT HEARS (KAN-149)
   *
   * The message is delivered by *typing it*, so without a tag it arrives
   * indistinguishable from the human at the keyboard — which is how an epic
   * agent came to tell the human they had rejected a tool call they had never
   * seen. So the sender is stamped on, here, at the last point the daemon still
   * knows who asked.
   *
   * **The tag comes from `workspaceType`/`workspaceKey`, which the butchr MCP
   * attaches to every request it makes off its own argv (mcp.ts) — never from
   * anything in `message`.** That is the property worth protecting: a body
   * claiming `[from epic/KAN-39]` changes the delivered text and cannot change
   * the leading tag, because the leading tag is a statement about the request
   * rather than about the text. It is the same identity `supervisorOfRecord`
   * already trusts to record parentage, read the same way.
   *
   * A caller the daemon cannot identify is tagged as unidentified rather than
   * left bare — see `senderTagFor`. Nothing this handler delivers is ever
   * untagged, which is what lets an agent read an untagged message as the
   * human's own typing.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const { key, type, message, intent } = data;
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
    const want: SendIntent = intent === undefined ? 'steer' : intent;
    if (want !== 'steer' && want !== 'stop-now') {
      fail(`Invalid intent '${String(intent)}': expected 'steer' or 'stop-now'`);
      return;
    }

    const tag = senderTagFor({ type: data?.workspaceType, key: data?.workspaceKey });
    const tagged = withSenderTag(tag, message);

    // ONE ADDRESS, BOTH CARRIERS. Resolved before the transport is chosen, so a
    // bare key cannot mean one agent over the channel and another over the
    // composer — see `HerdrBridge.resolveAddress` for why that would be the
    // worst way for a transport to become visible. A key that resolves to
    // nothing is unaddressable on either carrier and fails here, exactly as it
    // failed before this ticket.
    let address: { type: string; key: string };
    try {
      address = this.herdrBridge.resolveAddress(key, type);
    } catch (e: any) {
      // A steer delivered to the wrong agent is the third failure mode of an
      // ambiguous bare key (KAN-473). `resolveAddress` already refused it; what
      // it could not do is tell the caller WHICH agents matched, and a sender
      // that cannot see the collision cannot fix its own call.
      const ambiguity = ambiguityFields(e);
      if (ambiguity) {
        respond({
          action: 'send_to_agent_response',
          success: false,
          key,
          ...ambiguity,
          error: e?.message ?? String(e)
        });
        return;
      }
      fail(e?.message ?? String(e));
      return;
    }

    // THE ROUTING DECISION, MADE HERE AND NOWHERE ELSE (design §5.1).
    //
    // AC 4 of KAN-150 is "no partial migration", and §5.1 is explicit that it is
    // satisfied "not by having one mechanism, but by removing the guess": an
    // agent never chooses its transport and never infers it. Every input to this
    // decision is something only the daemon knows — whether emission is switched
    // on, and whether this recipient holds a live connection — and none of it is
    // reachable from a sender.
    //
    // `intent` is NOT a transport selector, and the distinction is the one thing
    // in this handler worth reading twice. A sender says what it *needs*; the
    // daemon says what carries it. `stop-now` is a requirement about the
    // recipient's current work, and §4 measured that only one carrier can meet
    // it: a channel event is acted on at the turn boundary and therefore cannot
    // stop an agent now, while the composer's Ctrl+C kills the call outright.
    // §5.1 lists that as the fifth retained composer case and calls it "a genuine
    // capability, not a concession" — so a router that always preferred the
    // channel would quietly delete the fleet's only stop-now signal, which is
    // precisely the loss §5.1 says we would otherwise take "without noticing".
    //
    // The sender still never names a carrier, never learns which one exists for
    // its recipient, and reads the transport off the response rather than
    // deriving it. That is §5.1's rule intact.
    const channelOutcome =
      want === 'stop-now'
        ? null
        : this.channelRoute?.(address, tagged, {
            sender: tag,
            workspaceType: address.type,
            workspaceKey: address.key
          }) ?? null;

    if (channelOutcome?.routed) {
      // C1 is the write to that connection; C2 is that the identity map held a
      // live one to write to. C3 and C4 are not this carrier's to make, and
      // `sealClaims` refuses them rather than trusting this call site — see
      // message-claims.ts.
      const claims = sealClaims(
        'channel',
        {
          transportAccepted: true,
          sessionPresent: true,
          enteredTranscript: 'not-measured',
          modelRead: 'not-measured'
        },
        {
          transportAccepted:
            `the frame was written to connection ${channelOutcome.connectionId}`,
          sessionPresent:
            `KAN-243's identity map resolved a live connection (${channelOutcome.connectionId}) for ` +
            `${address.type}/${address.key}`,
          enteredTranscript: '',
          modelRead: ''
        }
      );
      respond({
        action: 'send_to_agent_response',
        // `success` is C1 and says so in `claims`. Kept because `mcp.ts` flags a
        // tool error on it and older readers key off it; it is no longer the
        // only thing a caller has, which was the whole defect.
        success: true,
        key,
        type: address.type,
        transport: 'channel',
        transportChosenBecause:
          `a live channel connection (${channelOutcome.connectionId}) is registered for ` +
          `${address.type}/${address.key}, and this send is a steer rather than a stop-now`,
        connectionId: channelOutcome.connectionId,
        intent: want,
        claims,
        licenses: licenceFor('channel', claims),
        // The recipient's turn was NOT cancelled — §4 measured a channel event
        // waiting for the turn boundary. Said explicitly because it is the one
        // behavioural difference a caller most needs and cannot see.
        interrupted: false,
        sender: tag,
        delivered: tagged
      });
      return;
    }

    // A STEER IS REFUSED RATHER THAN DELIVERED BY CTRL+C (KAN-274).
    //
    // `intent: 'steer'` is defined as *the recipient can finish what it is doing
    // first*. Delivering one by composer interrupt contradicts that definition,
    // and until this ticket it did so **silently**: a registration dropped by a
    // daemon restart left the agent looking exactly like one on a channel — its
    // `list_agents` row said `transport: "channel"` — and the sender learned the
    // truth from `interrupted: true` in the response, after the interrupt had
    // landed. A routine deploy therefore manufactured a cancelled tool call in an
    // idle supervisor, which on the recipient's side renders as a refusal nobody
    // made.
    //
    // **Narrow on purpose, and every part of the narrowing is load-bearing.**
    // Only `registration-lost` refuses — the state where the durable registry
    // expects this agent to hold a connection and it holds none. A blanket
    // refusal on `no-connection` would break every send to a pane or a
    // human-activated workspace that never had a channel, and would break the
    // whole fleet the day somebody pulls the kill switch. `channel-disabled` and
    // `selfcheck-failed` are *decided* states that are already reported, so the
    // composer is the intended carrier there and nothing is refused.
    //
    // **`stop-now` never reaches here**, because `channelOutcome` is not even
    // computed for it: taking the recipient's work is what `stop-now` is for, and
    // it remains the fleet's only way to do so. That is also the escape hatch —
    // a sender that means to interrupt says so, explicitly and on the record,
    // rather than doing it by accident.
    if (channelOutcome?.routed === false && channelOutcome.reason === 'registration-lost') {
      respond({
        action: 'send_to_agent_response',
        success: false,
        key,
        type: address.type,
        transport: 'unregistered',
        transportChosenBecause: channelOutcome.detail,
        intent: want,
        // NOTHING WAS SENT, and the claims say so rather than leaving a reader to
        // infer it from `success`. That inference is the exact defect KAN-150
        // recorded — `success` read as delivery — and a refusal is the one case
        // where getting it wrong is cheapest to prevent.
        claims: sealClaims(
          'composer',
          {
            transportAccepted: false,
            sessionPresent: 'not-measured',
            enteredTranscript: false,
            // NOT `false`, though nothing was sent and no model can have read it.
            // C4 is unobservable on the composer, and `sealClaims` refuses a
            // boolean for it — correctly: the rule is about what the carrier can
            // establish, and a refusal is not a licence to start asserting on a
            // claim nothing here can see. The basis carries the plain fact.
            modelRead: 'not-measured'
          },
          {
            transportAccepted:
              'nothing was written to any carrier: the channel had no registration to write to, ' +
              'and this send was a steer, which is not permitted to interrupt',
            sessionPresent:
              'not asked — the refusal happened before any pane was resolved, so this says ' +
              'nothing about whether the agent is up. It almost certainly is: a lost ' +
              'registration is about the link, not the agent',
            enteredTranscript: 'nothing was sent',
            modelRead: 'nothing was sent'
          }
        ),
        interrupted: false,
        error:
          `Refused: ${address.type}/${address.key} holds no channel registration, and a steer ` +
          `must not be delivered by interrupting it. ${channelOutcome.detail}. ` +
          `WHAT TO DO: wait and retry — it re-registers by itself within seconds of the daemon ` +
          `being reachable, and butchr_list_agents shows transport 'channel' again when it has. ` +
          `If this cannot wait, send it with intent 'stop-now', which takes the composer and ` +
          `WILL destroy the tool call it is running. If it is news rather than a steer, a comment ` +
          `on its Jira ticket reaches it within a minute and costs it no interrupt.`,
        sender: tag,
        delivered: tagged
      });
      return;
    }

    // THE COMPOSER, and why it was chosen. §5.1 asks for a closed set of cases
    // rather than a vague fallback, so the reason is assembled from the actual
    // decision rather than described in general terms.
    const composerBecause =
      want === 'stop-now'
        ? 'this send asked to stop the recipient now, and only the composer interrupt can do that — ' +
          'a channel event waits for the turn boundary (design §4, §5.1 case 5)'
        : !this.channelRoute
          ? 'this daemon has no channel carrier wired in, so the composer is the only carrier'
          : channelOutcome?.reason === 'channel-disabled'
            ? 'channel emission is switched off fleet-wide, so nothing was written to any connection' +
              (channelOutcome.switchPath ? ` (switch: ${channelOutcome.switchPath})` : '')
            : channelOutcome?.reason === 'selfcheck-failed'
              // KAN-248. Named as its own cause rather than folded into
              // `no-connection`, because it sends the reader somewhere
              // different: the recipient IS reachable and its channel loop did
              // not prove out, so the thing to read is its `channel` row in
              // butchr_list_agents rather than its connection.
              ? `${address.type}/${address.key} failed its startup channel self-check and is ` +
                'degraded to the composer; butchr_list_agents carries the outcome and the ' +
                "client version on that agent's row"
            : channelOutcome?.reason === 'no-connection'
              ? `no live channel connection is registered for ${address.type}/${address.key}`
              : channelOutcome?.reason === 'socket-closed'
                ? "the recipient's channel connection closed before the frame could be written"
                : 'no channel route was available';

    this.herdrBridge.sendToAgent(key, tagged, type).then(
      // `sender` and `delivered` go back to the caller so it can see what its
      // recipient will actually read. A sender that cannot see its own tag has
      // no way to notice that the daemon thinks it is somebody else — and the
      // agent-facing tool description promises the tag, so the response is
      // where that promise is either kept or visibly broken.
      (result) => {
        // C3 IS THE INTERESTING ONE, AND IT IS SILENCE RATHER THAN A NEGATIVE.
        //
        // `HerdrBridge.sendToAgent` answers whether the keystrokes were typed —
        // Ctrl+C, text, Enter — which is C1. Whether the text was *submitted*
        // is C3, and only `deliverToAgent` establishes that, by reading the pane
        // above the composer marker (nudge.ts). This handler deliberately does
        // not call it: confirmation costs a 20s wait and, on failure, a SECOND
        // Ctrl+C at an agent that has already lost one turn.
        //
        // That trade-off is a decision, so it is recorded as `not-measured`
        // rather than resolved into a boolean. This is the exact spot where the
        // old `success: true` was read as delivery — KAN-150's defect 1 — and
        // the fix is not a better verb, it is the admission that nothing here
        // looked.
        // C2 AND C3 NOW COME FROM THE PANE, NOT FROM THE DELIVERY VERDICT
        // (KAN-498).
        //
        // Both used to read `result.success === true`, which is the delivery
        // verdict wearing two other claims' names. A 12-line steer typed onto a
        // live pane, collapsed by the client into `[Pasted text #1 +12 lines]`
        // and failed by CrabCast's echo-check, came back `success: false` — so
        // this call site asserted **no live session exists** about a pane the
        // daemon had just typed into, and a caller reading `C2: false`
        // concludes the agent is gone.
        //
        // `claimSessionPresent` takes a `PaneObservation` and nothing else, so
        // the old spelling is a compile error rather than a thing review has to
        // catch. See `agent-runtime.ts` for why that is a type and not an
        // assertion.
        const pane = result.pane;
        const typed = pane.reached === 'typed';
        const claims = sealComposerClaims({
          // The ONLY pane input. C2 and C3 are computed from it inside
          // `sealComposerClaims`, which has no parameter for either — so the
          // old `sessionPresent: result.success === true` has nowhere to go,
          // and `pane: result.success === true` does not type-check.
          pane,
          // C1 is about the BYTES, and on this path they landed: the text is on
          // the recipient's pane whether or not the submit was allowed.
          // Deriving C1 from the delivery verdict called a completed typing a
          // refusal.
          transportAccepted: typed ? true : result.success === true,
          // KAN-475: the runtime names itself. This is evidence a reader acts
          // on, and under CrabCast it used to credit or blame herdr for a send
          // herdr never saw.
          transportAcceptedBasis: typed
            ? `${this.herdrBridge.runtimeName} typed the keystrokes onto the recipient's pane. ${pane.detail}`
            : result.success
              ? `${this.herdrBridge.runtimeName} accepted the keystrokes for the recipient's pane`
              : `${this.herdrBridge.runtimeName} refused the send: ${result.error ?? 'no reason given'}`,
          enteredTranscriptBasis:
            typed && pane.submitted === false
              ? `the submit was withheld, so the text did NOT enter the transcript — it is sitting ` +
                `on the recipient's composer. ${pane.detail}`
              : typed && pane.submitted === true
                ? `the submit went through. ${pane.detail}`
                : undefined
        });
        respond({
          action: 'send_to_agent_response',
          ...result,
          key,
          type: address.type,
          transport: 'composer',
          transportChosenBecause: composerBecause,
          intent: want,
          claims,
          licenses: licenceFor('composer', claims),
          // The cost, stated as a fact rather than left in the tool
          // description. A composer send opens with a Ctrl+C, so on this
          // carrier the recipient's turn — and any tool call in it — is gone.
          //
          // ⚠ THIS TOO USED TO BE `result.success === true`, AND THAT IS THE
          // FALSEHOOD WITH THE HIGHEST COST. On the withheld-submit path the
          // Ctrl+C had already landed and cleared the composer, and the
          // response said `interrupted: false` — so the sender was told it had
          // taken nothing from the recipient at the exact moment it had
          // destroyed their turn AND their composer contents (KAN-498, step 4:
          // `yes all on is right, go ahead`, gone with no record anywhere).
          interrupted: typed ? pane.interrupted === true : result.success === true,
          // ⚠ THE RUNTIME'S OWN REFUSAL TEXT IS NOT PASSED THROUGH UNCORRECTED
          // ON THIS PATH (KAN-498, AC3).
          //
          // `...result` carries the runtime's `error` verbatim, and on the
          // withheld-submit path CrabCast's reads, in part: *"Nothing was
          // changed on the pane. Sending again is safe and does the same
          // thing."* Both sentences are false exactly here — the pane was
          // changed, and sending again APPENDS a second paste block. Their
          // wording is theirs and is reported under `runtimeError` rather than
          // edited or dropped, because it is evidence and because the
          // echo-check that produced it is theirs to fix (KAN-498 defect A,
          // reported to them). What Butchr must not do is repeat a claim it can
          // see is untrue, in Butchr's own voice, in the field callers read.
          error:
            typed && pane.submitted === false
              ? `NOT SUBMITTED to ${address.type}/${address.key}: the message WAS typed onto the ` +
                'pane and the Enter was withheld, so it is sitting on their composer unread. ' +
                (pane.interrupted === true
                  ? 'The interrupt cleared whatever their composer held before this send, and that ' +
                    'content is gone. '
                  : '') +
                'Sending again APPENDS another block rather than repeating this one. ' +
                'The withholding itself is correct — an Enter at a pane whose text could not be ' +
                'verified still confirms whatever that pane has highlighted, which at a dialog is a ' +
                'consent answer nobody gave. Read the pane with butchr_tail_agent; a comment on ' +
                'their Jira ticket reaches them within a minute and costs no interrupt.'
              : result.error,
          /** The runtime's own words, kept verbatim as evidence. */
          runtimeError: result.error,
          // WHAT THE SENDER HAS TO DO ABOUT IT, where there is something to do.
          // A refusal that leaves text on somebody's composer is not a no-op,
          // and nothing else in this response says so in one place.
          composerLeftHolding:
            typed && pane.submitted === false
              ? {
                  text: tagged,
                  priorContentCleared: pane.interrupted === true,
                  advice:
                    `The message was typed onto ${address.type}/${address.key}'s composer and NOT ` +
                    'submitted, so it is sitting there unread and will be submitted by whatever the ' +
                    'recipient types next. ' +
                    (pane.interrupted === true
                      ? 'Whatever their composer held before this send was cleared by the interrupt and ' +
                        'is not recoverable. '
                      : '') +
                    'Sending again APPENDS a second block rather than replacing this one. Read the pane ' +
                    'with butchr_tail_agent before you retry, and prefer a comment on their Jira ticket, ' +
                    'which reaches them in a minute and costs no interrupt.'
                }
              : undefined,
          sender: tag,
          delivered: tagged
        });
      },
      (err) => fail(err?.message ?? String(err))
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private async handleTailAgent(data: any, respond: Respond) {
    const { key, type, lines } = data;
    const fail = (error: string, err?: unknown) =>
      respond({
        action: 'tail_agent_response',
        success: false,
        // A tail refused for a colliding key says WHICH agents collided, so the
        // caller can address one rather than only learn that it could not
        // (KAN-473). `tailAgent` already refused this case — `resolveAgentName`
        // throws — and what was missing was the candidate list reaching the
        // client in a shape it could act on.
        ...(ambiguityFields(err) ?? {}),
        error
      });

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
      // THE `await` IS INSIDE THE `try`, WHICH IS THE WHOLE POINT OF NOT
      // SIMPLIFYING THIS (KAN-283). `tailAgent` is `Promise`-returning now, so
      // a rejection is only catchable here if it is awaited *within* the block
      // — `try { respond({...spread}) }` around an un-awaited call would spread
      // a Promise's own enumerable properties (there are none), answer
      // `success: undefined` with no `text`, and leave the rejection unhandled.
      // The client would read that as a failed read of a pane nobody looked at.
      const tail = await this.herdrBridge.tailAgent(key, type, lines);

      // `tailAgent` never throws, so an ambiguous address arrives here as a
      // return value rather than through the catch below — it carries
      // `candidates` and nothing else does. Labelling it `refusedBy:
      // 'ambiguous-key'` is what makes a refused tail the same shape as a
      // refused stand-down or status, which is what lets a caller handle all of
      // them in one place (KAN-473).
      if (tail.candidates) {
        fail(tail.error ?? ambiguousKeyMessage(key, tail.candidates), new AmbiguousKeyError(key, tail.candidates));
        return;
      }

      respond({
        action: 'tail_agent_response',
        key,
        // WHICH ADDRESS THIS PANE BELONGS TO (KAN-473). A tail is evidence a
        // supervisor acts on — "is it stalled or waiting?" is decided off
        // exactly this read — so a bare-key answer says that the type was
        // inferred rather than given. The refusal above is what stops it being
        // inferred from a collision; this is what stops the reader assuming
        // they had addressed the agent exactly when they had not.
        addressedBy: type ? 'key-and-type' : 'key-only',
        ...tail
      });
    } catch (err: any) {
      fail(err?.message ?? String(err), err);
    }
  }

  /**
   * Everything the sidepanel's Info tab shows, by address. A daemon restart
   * empties the session map while the herdr pane keeps running, so a missing
   * session degrades to herdr's own view (`sessionless: true`) rather than
   * failing — an agent that outlived its daemon is exactly the one a
   * supervisor most needs to inspect.
   *
   * ---------------------------------------------------------------------------
   * IT CARRIES THE `channel` BLOCK, AND UNTIL KAN-435 IT DID NOT
   * ---------------------------------------------------------------------------
   *
   * `channelStateOf` was reachable from `surveyAgents` alone, so this action —
   * the one a supervisor reaches for when it wants to know about *one* agent —
   * answered with **no `channel` key at all, for every agent, in every state.**
   *
   * **That absence was read as a finding, and it is what KAN-435 was filed on.**
   * A supervisor read `butchr_agent_status` on two freshly-staffed task agents,
   * saw no channel field, and recorded "freshly-started agents come up with NO
   * channel" — a fourth transport state that does not exist. Both agents had
   * working channels; one of them had been proved 1.8 seconds before it was read.
   * The same call against an agent with a 23ms round trip answers identically,
   * which is what makes the reading uninformative rather than merely incomplete.
   *
   * So the fix is to answer the question rather than to document that this tool
   * does not: an absent field is indistinguishable from an absent channel, and
   * nothing on the wire could tell the reader which they had. It is the same
   * fragment `list_agents` spreads, from the same reader, so the two surfaces
   * cannot disagree.
   *
   * **The sessionless branch gets it too**, and that is where it matters most: an
   * agent that outlived its daemon is exactly the one whose carrier a supervisor
   * cannot guess.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    const { key, type } = data;
    const fail = (error: string, err?: unknown) =>
      respond({
        action: 'agent_status_response',
        success: false,
        ...(ambiguityFields(err) ?? {}),
        error
      });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }

    try {
      const resolution = this.herdrBridge.resolveSessionByAddress(key, type);

      // ⚠ A READ THAT SILENTLY PICKS IS THE WORSE HALF OF KAN-473, because
      // nothing downstream can detect it. A bare-key status answered about
      // whichever session the map held first, and the response said only
      // `success: true` — so a supervisor deciding "is it stalled or waiting?"
      // could hold a first-hand-looking reading of somebody else's agent. For
      // the 44 hours `task/KAN-117` and `story/KAN-117` were both live, every
      // bare-key call on this action was one of those.
      //
      // Refused rather than disclosed-and-answered, for the reason the
      // stand-down above refuses: the caller wanted ONE agent's state, and no
      // annotation on the wrong agent's row makes it the row they asked for.
      if (resolution.outcome === 'ambiguous') {
        respond({
          action: 'agent_status_response',
          success: false,
          key,
          refusedBy: 'ambiguous-key',
          candidates: resolution.candidates,
          error: ambiguousKeyMessage(key, resolution.candidates)
        });
        return;
      }

      if (resolution.outcome === 'one') {
        const session = resolution.session;
        respond({
          action: 'agent_status_response',
          success: true,
          sessionless: false,
          agentName: agentNameFor(session.type, session.key),
          // WHICH ADDRESS THIS ANSWERS FOR. `agentName` already named the
          // agent; this names how it was reached, so a bare-key reader can see
          // that a type was inferred rather than given and is not left to
          // assume they addressed it exactly.
          addressedBy: type ? 'key-and-type' : 'key-only',
          ...this.toAgentDto(session, this.herdrBridge.listHerdrStatuses()),
          ...this.channelStateOf(session.type, session.key)
        });
        return;
      }

      // The herdr-list fallback refuses an ambiguous key of its own accord —
      // `resolveAgentName` throws `AmbiguousKeyError` — and the catch below
      // turns that into the same refusal shape the session path answers with,
      // so the two paths cannot disagree about what a colliding key means.
      const described = this.herdrBridge.describeAgent(key, type);
      respond({
        action: 'agent_status_response',
        success: true,
        sessionless: true,
        agentName: described.agentName,
        addressedBy: type ? 'key-and-type' : 'key-only',
        sessionId: null,
        type: described.type,
        key,
        // Read from the durable registry, not invented — see {@link
        // recordedUrlFor} and the longer note on the same field in
        // `surveyAgents`. This is the Info tab, so it is where a human meets a
        // stranded agent first.
        url: this.recordedUrlFor(described.agentName) ?? null,
        createdAt: null,
        status: null,
        workDir: described.workDir,
        herdrStatus: described.herdrStatus,
        ...this.channelStateOf(described.type, key)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err), err);
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
      // The session's own url wins; the registry answers when it has none
      // (KAN-346). A session adopted from a runtime's census has no url by
      // construction — CrabCast has no field for one — so without this
      // fallback the restart repair would hand back an addressable session
      // bound to nothing. See {@link recordedUrlFor}: this is a read of what
      // the activation wrote down, never a url derived from the key.
      // `?? null` closes the contract `recordedUrlFor` states and this one
      // caller used to break: it returns `undefined` for an agent the registry
      // never recorded a url for, every other caller renders that as `null`,
      // and this one spread it raw into `agent_status` where `JSON.stringify`
      // deleted the key (KAN-481). The type on {@link AgentDto.url} is what
      // now refuses the raw form; this is the belt beside those braces.
      url: session.url ?? this.recordedUrlFor(agentNameFor(session.type, session.key)) ?? null,
      createdAt: session.createdAt.toISOString(),
      status: session.status,
      workDir: session.workDir,
      herdrStatus: statuses.get(agentNameFor(session.type, session.key)) ?? 'unknown'
    };
  }

  /**
   * The `guardian` block for a page that is **not** a workspace, or nothing.
   *
   * Two conditions, and both are absences rather than defaults:
   *
   *   * **no poker wired** — every bare-router proof, and any embedding without
   *     one — omits the field, so a client cannot read "this daemon does not
   *     have the mechanism" as "this fleet has no guardian";
   *   * **not a board page** — the ordinary case for every other unsupported
   *     URL a browser tab lands on. A guardian notice on a random page is noise
   *     attached to a page nobody asked about the fleet from.
   *
   * The state itself carries `configured: false` when there is genuinely no
   * guardian, which is a *third* thing and the loudest of them: it means nothing
   * is watching this fleet on a timer. The renderer must tell all three apart,
   * which is why none of them is expressed as an absent field standing in for a
   * false one.
   */
  private guardianForPage(url: unknown): { guardian?: GuardianState & { boardId: string | null; projectKey: string | null } } {
    if (!this.guardian) return {};
    const board = boardPageFor(url);
    if (!board) return {};
    return {
      guardian: {
        ...this.guardian(),
        // Carried so the display can name the board it is on without the
        // extension re-parsing the URL — which is the second matcher this whole
        // design exists to avoid. See `board-page.ts`.
        boardId: board.boardId,
        projectKey: board.projectKey
      }
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
          : {}),
        // THE GUARDIAN, ON THE BOARD PAGE (KAN-284) — AND INVARIANT 6 IS WHY IT
        // IS HERE RATHER THAN FIVE LINES HIGHER.
        //
        // This sits *inside the branch that has already answered `supported:
        // false`*. The resolution has happened, its verdict is on the response
        // above, and nothing below can change it: the board page is still not a
        // workspace, still offers no terminal, and still degrades exactly as it
        // did before this ticket. **Displaying on a board page is rendering, not
        // binding**, and the placement is what makes that structural rather than
        // a promise — there is no path from `boardPageFor` back into
        // `registry.resolve`.
        //
        // KAN-284 names the hazard directly: *"do not 'fix' a display that is
        // not appearing by making the board resolve to something."* An author
        // who moved this above the `resolve` call, or who reached for a URL
        // pattern to make the board a workspace type, would trade the invariant
        // for a UI nicety and nothing afterwards would show the trade.
        //
        // Omitted rather than nulled when no poker is wired, by `boardControl`'s
        // rule: "this daemon has no guardian mechanism" and "no guardian is set"
        // are different facts, and only the second is a claim about the fleet.
        ...this.guardianForPage(data.url)
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

  // --- The Atlassian proxy (KAN-272) ---------------------------------------
  //
  // Two actions, and the split between them is load-bearing. `..._status`
  // reports what is being served; `..._call` serves it. **The status action is
  // not a permission check and must never be treated as one** — it is what
  // `mcp.ts` uses to decide what to advertise, and the advertisement is
  // advisory. An agent started while the proxy was on keeps the tools in its
  // list after it is switched off, so the refusal in the call handler is the
  // only gate there is. One gate, in the daemon, exactly as `channel.ts` puts
  // the channel gate there and only there.

  /**
   * What this daemon's Atlassian proxy is serving, and against which account.
   *
   * Answers even when off, and answers **fully** when off: the mode, the reason
   * it is off, and an empty operation list. A status that went quiet when the
   * feature was off would leave `mcp.ts` unable to tell "off" from "this daemon
   * is too old to have a proxy", and those two want different behaviour from an
   * older client.
   */
  private async handleAtlassianProxyStatus(respond: Respond) {
    const decision = selectedProxyMode();
    const credential = this.jira
      ? (() => {
          const status = this.jira.status();
          return {
            configured: status.configured === true,
            ...(typeof status.siteUrl === 'string' ? { siteUrl: status.siteUrl } : {}),
            ...(typeof status.email === 'string' ? { email: status.email } : {}),
            ...(typeof status.storage === 'string' ? { storage: status.storage } : {})
          };
        })()
      : { configured: false };

    respond({
      action: 'atlassian_proxy_status_response',
      success: true,
      // Distinct from `mode: 'off'`: a daemon with no Jira service at all cannot
      // proxy anything however the switch is set, and saying so is different
      // from saying somebody turned it off.
      available: !!this.jira,
      report: proxyReport(decision, credential)
    });
  }

  /**
   * Make one Atlassian read on an agent's behalf — or refuse, loudly.
   *
   * THE ORDER OF THE CHECKS IS THE DESIGN. The switch is consulted before the
   * tool is looked up, so a daemon with the proxy off gives the same refusal
   * for every tool name and reveals nothing about which operations exist. The
   * path is built after that, from validated arguments, by the operation's own
   * `build` — `data` never supplies a path and there is no operation that would
   * accept one.
   *
   * WHAT ATTRIBUTION IS WORTH HERE, STATED BECAUSE IT WILL BE READ AS MORE.
   * `workspaceType`/`workspaceKey` are stamped into every request body by
   * `mcp.ts` from its own argv, and the audit line below names them. That makes
   * a proxied read **attributable** — which agent asked, for what, and what came
   * back — and it is emphatically **not authentication**: anything that can
   * reach the daemon's socket can claim any identity, exactly as
   * `agent-connections.ts` decision 4 records for `hello`. The trust boundary is
   * still the socket's filesystem permission and this handler does not move it.
   * The line is worth writing anyway: the blast radius KAN-272 asks to be
   * written down is "any agent can read as far as the daemon can", and an
   * unattributed read makes that radius unobservable as well as wide.
   */
  private async handleAtlassianProxyCall(data: any, respond: Respond) {
    const tool = typeof data?.tool === 'string' ? data.tool : '';
    const args = data?.args && typeof data.args === 'object' ? data.args : {};
    // The claimed identity, kept structured as well as rendered: the audit line
    // wants the rendering and `refuseWriteOutsideCaller` wants the fields. Both
    // are claims — see the docblock above on what attribution is worth here, and
    // note that a write policy built on it bounds accident and not malice.
    const callerIdentity: ProxyCaller | null =
      typeof data?.workspaceType === 'string' &&
      typeof data?.workspaceKey === 'string' &&
      data.workspaceType &&
      data.workspaceKey
        ? { type: data.workspaceType, key: renderedKey(data.workspaceKey) }
        : null;
    const caller = callerIdentity
      ? `${callerIdentity.type}/${callerIdentity.key}`
      : 'unidentified caller';

    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      console.log(`atlassian-proxy: ${caller} → ${tool || '(no tool)'} REFUSED — ${error.split('.')[0]}`);
      respond({ action: 'atlassian_proxy_call_response', success: false, error, ...extra });
    };

    if (!this.jira) {
      fail('This daemon has no Jira support, so it cannot proxy Atlassian reads.');
      return;
    }

    const decision = selectedProxyMode();
    const refusal = refuseProxyCall(decision.mode, tool);
    if (refusal) {
      fail(refusal.error, { reason: refusal.reason, mode: decision.mode });
      return;
    }

    // Non-null by construction: `refuseProxyCall` returns a refusal for every
    // tool it cannot find, so reaching here means it found this one.
    const operation = operationByTool(tool)!;
    const built = operation.build(args);
    if ('error' in built) {
      fail(built.error, { reason: 'bad-arguments' });
      return;
    }

    // KAN-291: who may be written to, checked before anything is sent. It runs
    // after `build` so that a malformed key is reported as a malformed key
    // rather than as somebody else's ticket, and it returns null for every read
    // — the table's `writesTo` is what says which is which, so a write added
    // without one cannot slip past this line by being new.
    const writeRefusal = refuseWriteOutsideCaller(operation, args, callerIdentity);
    if (writeRefusal) {
      fail(writeRefusal.error, { reason: writeRefusal.reason, mode: decision.mode });
      return;
    }

    // KAN-292: an operation makes one request or a fan-out the TABLE declared,
    // and this is where the two are made one shape. Nothing a caller sent
    // decides how many requests there are or which product each goes to — see
    // `ProxyRequest` — so what follows is a loop over a list this file did not
    // choose the length of.
    const requests =
      'requests' in built
        ? built.requests
        : [
            {
              // A bare `{ path }` means the operation's first declared product,
              // which for everything that predates Confluence is `jira`.
              product: built.product ?? operation.products[0] ?? 'jira',
              path: built.path,
              ...('body' in built ? { body: built.body } : {})
            }
          ];

    const startedAt = Date.now();
    const outcomes = [];
    for (const request of requests) {
      const outcome =
        operation.method === 'GET'
          ? await this.jira.proxyRead(request.path, request.product)
          : // KAN-293: the verb and the product both come from the operation
            // table and the request it built. Until this slice the write leg
            // hard-coded POST and the Jira product, which was true of the one
            // write that existed and would have sent every Confluence write to
            // Jira's gateway base.
            await this.jira.proxyWrite(
              operation.method,
              request.path,
              request.body,
              request.product
            );
      outcomes.push({ request, outcome });
      // A fan-out stops at its first failure rather than pressing on. Half an
      // answer presented as an answer is the failure mode this whole module was
      // written against, and `atlassian_search`'s two legs are not independent
      // questions — one of them failing means the result is not what its shape
      // claims.
      if (!outcome.ok) break;
    }
    const elapsed = Date.now() - startedAt;
    // The last outcome is the failing one when anything failed (the loop broke
    // there), and otherwise the last success.
    const outcome = outcomes[outcomes.length - 1].outcome;
    const auditPath = outcomes.map(({ request }) => request.path).join(' + ');

    // THE AUDIT LINE. A path, never a credential — auth travels in a header and
    // `TokenJiraTransport` scrubs every on-the-wire form of the token out of
    // anything it builds, so there is nothing token-shaped in `built.path` by
    // construction. Logged for refusals and successes alike: a log that records
    // only what worked cannot answer "what has this credential been used for",
    // which is the question an audit line exists for.
    //
    // KAN-291 ADDS THE BODY, AND FOR A WRITE THAT IS THE WHOLE POINT OF THE
    // LINE. A path answers "what was read"; for a write it answers only "which
    // issue", and "which issue was changed" without "changed to what" is not an
    // audit record of a change. It is safe to log by construction rather than by
    // filtering: the body is built by the operation table from arguments matched
    // against a regex, so for the one write that exists it is exactly
    // `{"transition":{"id":"31"}}` and can carry nothing an agent supplied
    // beyond those digits. That property is asserted in
    // `verify-atlassian-proxy-write-scope.mjs`; if a later slice adds a write
    // whose body carries user content, this line is one of the places that has
    // to be reconsidered rather than inherited.
    const writtenBody = outcomes.find(({ request }) => request.body !== undefined)?.request.body;
    const bodyForLog = writtenBody !== undefined ? ` ${JSON.stringify(writtenBody)}` : '';
    console.log(
      `atlassian-proxy: ${caller} → ${tool} ${operation.method} ${auditPath}${bodyForLog} → ` +
        (outcome.ok
          ? `${outcome.status} (${elapsed}ms)`
          : `FAILED${outcome.status ? ` ${outcome.status}` : ''} (${elapsed}ms) ` +
            `${outcome.credentialFault ? '[credential fault — the fleet is affected]' : '[query fault]'}`)
    );

    if (!outcome.ok) {
      respond({
        action: 'atlassian_proxy_call_response',
        success: false,
        error: outcome.error,
        credentialFault: outcome.credentialFault,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.diagnosis ? { diagnosis: outcome.diagnosis } : {}),
        ...(outcome.legs ? { legs: outcome.legs } : {})
      });
      return;
    }

    // KAN-292: two operations reshape what came back before the agent sees it,
    // and both had to. `transform` is given only non-secret credential facts —
    // see `ProxyTransformContext`, which cannot carry a token by shape. A
    // transform that throws is a bug in this daemon rather than in the agent's
    // request, so it is reported as one instead of being allowed to look like
    // Atlassian refusing something.
    let responseBody: unknown = outcome.body;
    if (operation.transform) {
      const credential = this.jira.status();
      // `CredentialStatus` is an open record of `string | boolean`, so the two
      // fields wanted here are narrowed to strings rather than asserted: a
      // `siteUrl` that somehow arrived as a boolean should reach the transform
      // as absent, not as `true`.
      const asText = (value: unknown) => (typeof value === 'string' ? value : undefined);
      try {
        responseBody = operation.transform(
          // Every outcome here is a success — the loop above breaks on the
          // first failure and the `!outcome.ok` branch returned before this.
          outcomes.map(({ outcome: o }) => (o.ok ? o.body : undefined)),
          { siteUrl: asText(credential.siteUrl), email: asText(credential.email) }
        );
      } catch (err: any) {
        fail(
          `${tool} reached Atlassian successfully, but the Butchr daemon failed to assemble the ` +
            `answer: ${err?.message ?? String(err)}. This is a defect in the daemon and not in ` +
            'your request — nothing about your arguments would change it. The underlying read ' +
            'did succeed, so the data exists; report this rather than retrying.',
          { reason: 'transform-failed' }
        );
        return;
      }
    }

    respond({
      action: 'atlassian_proxy_call_response',
      success: true,
      status: outcome.status,
      // Named `body` rather than spread, so a Jira field called `success` or
      // `error` cannot overwrite this envelope's own verdict.
      body: responseBody,
      // What actually happened, for a reader of the transcript who wants to
      // know which credential answered without asking the daemon a second
      // question. Non-secret: a path and a method.
      via: {
        tool,
        method: operation.method,
        path: auditPath,
        products: requests.map((r) => r.product),
        ...(operation.transform ? { reshapedByDaemon: true } : {}),
        servedBy: 'butchr-daemon'
      }
    });
  }

  // --- The LaunchDarkly proxy (KAN-298) ------------------------------------
  //
  // Two actions, split exactly as the Atlassian proxy's are, and for the same
  // reason: `..._status` reports what is being served and `..._call` serves it.
  // **The status action is not a permission check and must never be treated as
  // one** — it is what `mcp.ts` uses to decide what to advertise, and the
  // advertisement is advisory. The refusal in the call handler is the only gate.
  //
  // WHAT IS ABSENT HERE, AND IT IS THE POINT: there is no write branch. The
  // Atlassian handler below carries `refuseWriteOutsideCaller` because it has a
  // write to bound; this one has nothing to bound because
  // `launchdarkly-proxy.ts` has no operation whose method is not GET, enforced
  // by that module's `method: 'GET'` type rather than by this handler's
  // vigilance. A LaunchDarkly write cannot be added without widening that union,
  // and this comment is one of the places whoever does that has to come back to.

  /**
   * What this daemon's LaunchDarkly proxy is serving, and against what.
   *
   * Answers even when off, and answers **fully** when off — the mode, the reason
   * it is off, and an empty operation list — so `mcp.ts` can tell "off" from
   * "this daemon is too old to have a LaunchDarkly proxy". Those two want
   * different behaviour from an older client.
   */
  private async handleLaunchDarklyProxyStatus(respond: Respond) {
    const decision = selectedLdProxyMode();
    const credential = this.launchdarkly
      ? (() => {
          const status = this.launchdarkly.status();
          return {
            configured: status.configured === true,
            ...(typeof status.storage === 'string' ? { storage: status.storage } : {})
          };
        })()
      : { configured: false };

    respond({
      action: 'launchdarkly_proxy_status_response',
      success: true,
      // Distinct from `mode: 'off'`: a daemon with no LaunchDarkly support at
      // all cannot proxy anything however the switch is set, and saying so is
      // different from saying somebody turned it off.
      available: !!this.launchdarkly,
      report: ldProxyReport(decision, credential)
    });
  }

  /**
   * Make one LaunchDarkly read on an agent's behalf — or refuse, loudly.
   *
   * THE ORDER OF THE CHECKS IS THE DESIGN, and it is the Atlassian handler's
   * order. The switch is consulted before the tool is looked up, so a daemon
   * with the proxy off gives the same refusal for every tool name and reveals
   * nothing about which operations exist. The path is built after that, from
   * validated arguments, by the operation's own `build` — `data` never supplies
   * a path or a query string, and there is no operation that would accept one.
   *
   * WHAT ATTRIBUTION IS WORTH HERE, STATED BECAUSE IT WILL BE READ AS MORE.
   * `workspaceType`/`workspaceKey` are stamped into every request body by
   * `mcp.ts` from its own argv, and the audit line below names them. That makes
   * a proxied read **attributable** — which agent asked, and for what — and it
   * is emphatically **not authentication**: anything that can reach the daemon's
   * socket can claim any identity. The trust boundary is still the socket's
   * filesystem permission.
   *
   * Nothing here is load-bearing for safety in the way the Atlassian handler's
   * caller check is, because nothing reachable through this handler can change
   * anything. The audit line is worth writing anyway: the blast radius is "any
   * agent can read as far as the daemon's LaunchDarkly credential can", and an
   * unattributed read makes that radius unobservable as well as wide.
   */
  private async handleLaunchDarklyProxyCall(data: any, respond: Respond) {
    const tool = typeof data?.tool === 'string' ? data.tool : '';
    const args = data?.args && typeof data.args === 'object' ? data.args : {};
    const caller =
      typeof data?.workspaceType === 'string' &&
      typeof data?.workspaceKey === 'string' &&
      data.workspaceType &&
      data.workspaceKey
        ? `${data.workspaceType}/${renderedKey(data.workspaceKey)}`
        : 'unidentified caller';

    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      console.log(
        `launchdarkly-proxy: ${caller} → ${tool || '(no tool)'} REFUSED — ${error.split('.')[0]}`
      );
      respond({ action: 'launchdarkly_proxy_call_response', success: false, error, ...extra });
    };

    if (!this.launchdarkly) {
      fail('This daemon has no LaunchDarkly support, so it cannot proxy LaunchDarkly reads.');
      return;
    }

    const decision = selectedLdProxyMode();
    const refusal = refuseLdProxyCall(decision.mode, tool);
    if (refusal) {
      fail(refusal.error, { reason: refusal.reason, mode: decision.mode });
      return;
    }

    // Non-null by construction: `refuseLdProxyCall` returns a refusal for every
    // tool it cannot find, so reaching here means it found this one.
    const operation = ldOperationByTool(tool)!;
    const built = operation.build(args);
    if ('error' in built) {
      fail(built.error, { reason: 'bad-arguments' });
      return;
    }

    const startedAt = Date.now();
    const outcome = await this.launchdarkly.proxyRead(built.path, operation.beta === true);
    const elapsed = Date.now() - startedAt;

    // THE AUDIT LINE. A path, never a credential — auth travels in a header and
    // the path is built by the operation table from arguments matched against a
    // regex or an allowlist, so there is nothing token-shaped in it by
    // construction. Logged for refusals and successes alike: a log that records
    // only what worked cannot answer "what has this credential been used for",
    // which is the question an audit line exists for.
    //
    // No body is logged and there is no branch for one, because no operation
    // sends one. If that ever changes, this is a line that has to be
    // reconsidered rather than inherited — see the Atlassian handler, which had
    // to grow exactly that.
    console.log(
      `launchdarkly-proxy: ${caller} → ${tool} ${operation.method} ${built.path} → ` +
        (outcome.ok
          ? `${outcome.status} (${elapsed}ms)`
          : `FAILED${outcome.status ? ` ${outcome.status}` : ''} (${elapsed}ms) ` +
            `${outcome.credentialFault ? '[credential fault — the fleet is affected]' : '[query or entitlement fault]'}`)
    );

    if (!outcome.ok) {
      respond({
        action: 'launchdarkly_proxy_call_response',
        success: false,
        error: outcome.error,
        credentialFault: outcome.credentialFault,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.diagnosis ? { diagnosis: outcome.diagnosis } : {}),
        ...(outcome.legs ? { legs: outcome.legs } : {})
      });
      return;
    }

    respond({
      action: 'launchdarkly_proxy_call_response',
      success: true,
      status: outcome.status,
      // Named `body` rather than spread, so a LaunchDarkly field called
      // `success` or `error` cannot overwrite this envelope's own verdict.
      body: outcome.body,
      // What actually happened, for a reader of the transcript who wants to know
      // which credential answered without asking the daemon a second question.
      // Non-secret: a path and a method.
      via: { tool, method: operation.method, path: built.path, servedBy: 'butchr-daemon' }
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
  /**
   * Which runtime is serving, for an operator who must never have to guess
   * (KAN-278 criterion 3).
   *
   * The report is not recomputed here. It is the object `createAgentRuntime`
   * returned beside the runtime it built, carried through unchanged — so this
   * answer cannot drift from the runtime actually serving, which a second read
   * of the environment could.
   *
   * When nothing wired one, this says so rather than defaulting to a cheerful
   * `herdr`. A router with no report is a router that was constructed by
   * something other than `daemon.ts`, and reporting the default there would be
   * describing a decision nobody took.
   */
  private handleAgentRuntimeReport(respond: Respond) {
    if (!this.agentRuntimeReport) {
      respond({
        action: 'agent_runtime_report_response',
        success: false,
        error:
          'This router was constructed without an agent-runtime report, so which runtime is ' +
          'serving is not something it can answer. Only `daemon.ts` wires one.'
      });
      return;
    }
    respond({
      action: 'agent_runtime_report_response',
      success: true,
      runtime: this.agentRuntimeReport
    });
  }

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
   * Reclaim `node_modules` from every workspace with no live agent in it.
   *
   * **The live-agent exclusion is derived here, from the running fleet**, and
   * that is the whole reason this handler exists rather than the sweep reading
   * the filesystem for itself. `surveyAgents()` is the same census
   * `list_agents` is built from, so the set of workspaces this refuses to touch
   * and the set of agents a supervisor is looking at are one answer to one
   * question. The 2026-08-04 manual pass excluded its five running workspaces
   * by hand and that is exactly what must not happen again: a list written down
   * is a list that goes stale between being written and being used.
   *
   * `unbackedPanes` are excluded too, though they are not agents. A pane with a
   * bare shell in it is something a person is plausibly sitting in front of,
   * possibly mid-`npm install`, and the cost of being wrong in that direction
   * is one workspace's worth of bytes left on disk.
   *
   * Defaults to a dry run — see `sweepWorkspaces`. `dryRun: false` is the only
   * thing that deletes, and a caller has to mean it.
   */
  private handleReclaimSweep(data: any, respond: Respond) {
    const { agents, unbackedPanes } = this.surveyAgents();

    const liveWorkDirs = [
      ...agents.map((a) => a.workDir),
      ...unbackedPanes.map((p) => p.workDir)
    ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);

    const dryRun = data?.dryRun !== false;

    try {
      const sweep = sweepWorkspaces({ liveWorkDirs, dryRun });
      respond({ action: 'reclaim_sweep_response', success: true, ...sweep });
    } catch (e: any) {
      const error = `Reclaim sweep failed: ${e?.message ?? String(e)}`;
      console.error('[MessageRouter]', error);
      respond({ action: 'reclaim_sweep_response', success: false, error });
    }
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
    const { agents, unbackedPanes, staleSessions, census } = this.surveyAgents();

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

    // What the last reclaim sweep took, in the same response and for the same
    // reason as staleness: it is the poll a supervisor is already making, so
    // the fact arrives without anybody having to know to ask for it. A reclaim
    // nobody can see after the fact is a reclaim that surprises somebody later
    // (KAN-259). Null until a sweep has run in this daemon's lifetime.
    const reclaim = lastReclaimSummary();

    const preempted = this.preemptedAgents();

    // Whether the board can undo what this page's buttons do (KAN-222). Every
    // list below carries a control the reconciler is capable of reversing —
    // Off on a running row, On on the other three — so all four are handed to
    // the reporter together. Asking about only the running ones would leave
    // the On buttons making a promise the loop can break, which is the same
    // defect this field exists to remove, moved one list down.
    //
    // Every list goes in exactly as it is read, and the spelling is not this
    // method's business (KAN-225).
    //
    // It used to be. Running agents were mapped through `recordedKeyFor` here
    // first, because a running agent's `key` came out of a pane name and is
    // therefore lower-cased, and the board's answer is a sentence telling
    // somebody which ticket to move. **The `?? agent.key` that mapping needed
    // was the defect.** `recordedKeyFor` returns nothing for an agent the
    // durable registry never recorded — a `sessionless` herdr agent that
    // outlived this daemon, or one it never started — and that is exactly the
    // agent whose key is the pane spelling, so the fallback handed `kan-500`
    // downstream to be printed at a human as the ticket to go and move.
    //
    // The correction now lives at the boundary that renders the key, in
    // `board-control.ts`, where it needs no lookup and therefore has nothing to
    // miss: everything that passes the jurisdiction filter is, upper-cased,
    // exactly how Jira spells a key. Re-adding a hop here would put a second
    // spelling rule in front of that one.
    const boardControl = this.boardControl?.([
      ...agents,
      ...missingAgents,
      ...standby,
      ...preempted
    ]);

    respond({
      action: 'list_agents_response',
      success: true,
      agents,
      unbackedPanes,
      // Always present, even when empty: a caller that has to distinguish "no
      // agents are missing" from "this daemon does not track that" cannot do it
      // from an absent field. Empty array means the fleet is whole.
      missingAgents,
      // What the census could not read, beside the list it qualifies (KAN-324).
      //
      // **`agents` above is a count, and this is what says whether that count
      // is whole.** The runtime's census answers a shorter list with nothing
      // marking it short whenever a registry row could not be read — since
      // CrabCast's KAN-302 an unreadable row makes their daemon skip rather
      // than refuse to start, so `agents: []` is byte-for-byte what an empty
      // fleet reads. Measured on this machine at the time of writing:
      // `configuredAgents: 0` with `unreadableRecordsTotal: 1`.
      //
      // Adjacent to the count rather than in a log line, for the reason the
      // whole ticket exists: a disclosure nobody reads is the same as no
      // disclosure, and the caller deciding what the fleet *is* is reading
      // this response. Same rule as `missingAgents` above — always present,
      // never absent.
      //
      // **`null` is not `0` and a client must not render it as one.** `0` says
      // the census was taken and skipped nothing, which is what makes the agent
      // count trustworthy. `null` says no disclosure reached this daemon — the
      // census could not be taken, or the peer is below read-path contract v4 —
      // and the count above may be short with nothing here to say so.
      censusUnreadableRecordsTotal: census.unreadableRecordsTotal,
      censusUnreadableRecords: census.unreadableRecords,
      // Work that was taken off the machine to make room for something more
      // important, and has not been put back. Always present, empty when
      // nothing is owed — a caller distinguishing "nothing was preempted" from
      // "this daemon does not track that" cannot do it from an absent field.
      //
      // It is a queue of decisions still owed rather than a log of events: the
      // moment one of these is re-activated it leaves the list. Nothing here
      // restarts them, deliberately — a preemption queue is a scheduler and
      // this ticket said so.
      preemptedAgents: preempted,
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
      // Omitted rather than nulled when this daemon has no reconciler behind
      // it, so that "no board reconciler here" cannot be mistaken for "the
      // reconciler says nothing controls this". See the constructor parameter.
      ...(boardControl ? { boardControl } : {}),
      // WHEN A CHANNEL FRAME LAST REACHED A MODEL (KAN-252), on the poll a
      // supervisor is already making. Omitted rather than nulled by the same
      // rule as `boardControl`: a daemon with no probe wired must not be
      // readable as a fleet whose channel has never been proved.
      //
      // It sits beside the per-agent `channel` rows deliberately. Those say
      // whether each agent's loop was proved as far as its *client*; this says
      // whether anything got past the client into a *model*, which is the leg
      // none of those rows can see.
      // NEWS THE DAEMON COULD NOT DELIVER (KAN-301), and the one field on this
      // response that answers a question about *absence*.
      //
      // The board's most-repeated failure, in `epic/KAN-39`'s words: "an agent
      // that did NOT get the news must be distinguishable from one that got it
      // and had nothing to do." Dropping pane insertion is what made that
      // question askable — a Ctrl+C always landed, so there was nothing to
      // report — and it is what makes answering it mandatory rather than nice.
      //
      // `pending` is recoverable and retried on every sweep; `abandoned` is
      // Butchr saying plainly that it gave up and that those agents were never
      // told. The abandoned count is never reset, because a counter that returns
      // to zero is the same silence in a tidier costume.
      //
      // Omitted rather than nulled when no store is wired, by the same rule as
      // `boardControl` above: "this daemon holds no notifications" and "this
      // daemon cannot tell you" are different answers.
      ...(this.pendingNotifications
        ? { undeliveredNotifications: this.pendingNotifications() }
        : {}),
      // KAN-304. Whether anything is being observed about the fleet's pull
      // requests at all, and since when it last could be.
      ...(this.prWatch ? { prWatch: this.prWatch() } : {}),
      ...(this.channelLiveness ? { channelLiveness: this.channelLiveness() } : {}),
      // WHO IS WATCHING THIS FLEET, AND WHETHER ITS POKE IS LANDING (KAN-284).
      //
      // On this response rather than only on the board page, because this is the
      // poll a supervisor is already making and *"is anybody watching"* is a
      // question about the fleet. The board display and this read the same
      // reader — one state, two surfaces — which is the rule
      // `carrierFor` exists to enforce elsewhere: a report that derives its own
      // answer is the copy that goes wrong.
      //
      // **Read `proves` before `lastDelivered`.** This record says whether the
      // poke was *delivered*; it says nothing about whether the fleet is
      // supervised, and `provesDetail` carries that sentence so no reader has to
      // have read this comment. A heartbeat proves the loop turns.
      //
      // Omitted rather than nulled when no poker is wired, by `boardControl`'s
      // rule: a daemon without the mechanism must not read as a fleet with no
      // guardian set. `configured: false` is how the second one is said.
      ...(this.guardian ? { guardian: this.guardian() } : {}),
      ...(staleness ? { staleness } : {}),
      // Omitted rather than nulled when no sweep has run, by the same rule as
      // `staleness` directly above: absent means "this daemon has reclaimed
      // nothing", which is a different answer from any summary it could carry.
      ...(reclaim ? { reclaim } : {}),
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
    const live = new Set<string>();

    for (const entry of agents) {
      if (!this.countsAsAgent(entry)) continue;
      live.add(entry.agentName);

      if (isSupervisorType(entry.type)) supervisors++;
      else fleet++;
    }

    // Reconcile the start ledger against the census, in the one order that is
    // safe: mark first, drop second. See start-ledger.ts for why absence alone
    // must never drop an entry.
    this.startLedger.reconcile(live);

    return this.capacitySource(fleet, supervisors, this.startLedger.startedAt());
  }

  /**
   * Record that an agent was started, for the capacity gate's starts-in-flight
   * term (KAN-258). Called on the success path of both activation routes.
   */
  private recordStart(agentName: string): void {
    this.startLedger.record(agentName, Date.now());
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
   *
   * **This one reads the REGISTRY rather than a launcher, which is why it
   * survived KAN-395 unchanged where the question was whether it should.** The
   * ruling is on `HerdrSession.expectsRuntime`; read it there. The half that is
   * specific to this site: `record.defaultAgent` is a value written to disk by
   * an older daemon, so it is not bounded by today's `LauncherName` and cannot
   * be typed into agreement with it. A row saying `'anti-gravity'` — a launcher
   * KAN-395 retired — reads `true` here, which is the safe direction: such an
   * agent cannot be running, because `resolveLauncher` refuses to start one, so
   * the branch this feeds only ever asks whether something already dead is
   * dead.
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
    // work state would answer for the wrong workspace (KAN-83).
    //
    // With no type, a key matching one agent is answered and a key matching
    // several is REFUSED (KAN-473). The clause this replaces read "the key-only
    // match is the best available answer rather than a collision", and it was
    // wrong in exactly the way the ticket is about: a collision is precisely
    // what it was, and the answer it produced named a *workspace directory* —
    // so the wrong agent's work state came back looking like the right one's.
    const resolution = this.herdrBridge.resolveSessionByAddress(key, type);
    if (resolution.outcome === 'ambiguous') {
      respond({
        action: 'agent_work_state_response',
        success: false,
        key,
        refusedBy: 'ambiguous-key',
        candidates: resolution.candidates,
        error: ambiguousKeyMessage(key, resolution.candidates)
      });
      return;
    }
    const session = resolution.outcome === 'one' ? resolution.session : undefined;
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

  /**
   * The page this agent was bound to, as the durable registry recorded it at
   * activation — the half of KAN-346 that is not the runtime's to fix.
   *
   * ## Why this is a read and not a new write
   *
   * `url` was already being persisted. `rememberActivated` has written
   * `AgentRecord.url` on every activation since the registry existed, and
   * `reconcile.ts` reads it back to restore a fleet after a power cut. **What
   * was missing was this direction**: every row `list_agents` and
   * `agent_status` built for an agent with no session hardcoded `url: null`,
   * and the comment above it called that honesty — *"no url the agent was
   * bound to … filling them in to match the attached shape would be a
   * fabrication."* That reasoning is right about a session fact and wrong about
   * this one. **A url is not a session fact.** It is an argument of the
   * activation, it is on disk, it survives the daemon that recorded it, and
   * reporting it is a read rather than an invention.
   *
   * `activatedBy` on the very same row is the precedent and says so in its own
   * comment: *"the registry outlives the session map, which is the whole reason
   * an agent that survived a daemon restart still knows who staffed it."* The
   * same sentence is true of `url` and nobody had written it down.
   *
   * ## What it still refuses to do
   *
   * Answer for an agent the registry never recorded. `undefined` here means
   * *nothing was written down*, and callers render that as `null` — the same
   * answer they gave before, for the one population where it was the true one.
   * Nothing is derived from the key, and no url is constructed: an agent
   * activated without one had none, and `handleActivateByKey` is explicit that
   * *"a fabricated link is worse than no link."*
   *
   * ## Both runtimes, and that is the point
   *
   * This is not CrabCast-specific. A `HerdrBridge` fleet that outlives its
   * daemon reports the same `url: null` on the same row and has always done so;
   * it is merely less visible there, because the sidepanel re-activates on
   * sight and a spawned session carries the browser's own url within seconds.
   * Fixing it here fixes it for the runtime that heals and the runtime that
   * does not.
   */
  public recordedUrlFor(agentName: string): string | undefined {
    return this.agentRegistry?.intents().get(agentName)?.record.url;
  }

  private surveyAgents(): {
    agents: ListedAgent[];
    unbackedPanes: UnbackedPane[];
    staleSessions: Set<string>;
    /**
     * What the census could not read, carried out of here rather than re-asked
     * for downstream (KAN-324).
     *
     * A second `listHerdrAgentsChecked()` in `handleListAgents` would be a
     * second census, taken a moment later, and the response would then pair an
     * agent list with a disclosure about a *different* reading — which is the
     * defect the qualifier exists to prevent, reassembled out of two honest
     * halves. One reading in, one reading out.
     */
    census: CensusReading;
  } {
    const census = this.herdrBridge.listHerdrAgentsChecked();
    const { reachable, agents: herdrAgents } = census;
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
        activatedBy: this.supervisorFor(agentName),
        ...this.channelStateOf(dto.type, dto.key)
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
      // report and no creation time we saw — filling those in to match the
      // attached shape would be a fabrication.
      //
      // **`url` LEFT THIS LIST AT KAN-346, and the reason is that it was never
      // a session-only field.** It is an argument of the activation, written to
      // the durable registry at the time and read back by `reconcile.ts` to
      // restore a fleet after a power cut — so answering `null` here was not
      // refusing to invent, it was declining to read something already on disk.
      // `activatedBy`, two lines below, has always been read that way and gives
      // the reason in as many words. See {@link recordedUrlFor}; an agent the
      // registry never recorded still answers `null`, which is the population
      // that sentence was actually true of.
      agents.push({
        sessionless: true,
        agentName: record.name,
        sessionId: null,
        type: address.type,
        key: address.key,
        url: this.recordedUrlFor(record.name) ?? null,
        createdAt: null,
        status: null,
        workDir: record.workDir,
        herdrStatus: record.herdrStatus,
        agentRuntime: record.agentRuntime,
        supervisor: isSupervisorType(address.type),
        // Not a session-only field, so not null-by-construction here: the
        // registry outlives the session map, which is the whole reason an
        // agent that survived a daemon restart still knows who staffed it.
        activatedBy: this.supervisorFor(record.name),
        // NOT null-by-construction either, and this is the row where it most
        // often says `unchecked` — a sessionless agent is one that outlived a
        // daemon restart, and the daemon that restarted took its verdict with
        // it. The reader answers `unchecked` honestly rather than this row
        // pretending the question does not apply to it.
        ...this.channelStateOf(address.type, address.key)
      });
    }

    return { agents, unbackedPanes, staleSessions, census };
  }

  /**
   * One agent's channel row (KAN-248, T5), or nothing when this daemon cannot say.
   *
   * Returns a spreadable fragment rather than a value so that "no reader wired
   * in" is an ABSENT key rather than a null one. That distinction is the whole
   * reason this is not a one-liner at each call site: a client reading `null`
   * must be able to conclude *"this daemon checked and found no verdict"*, and
   * it can only do that if a daemon which cannot check says nothing at all.
   */
  private channelStateOf(
    type: string | null,
    key: string
  ): { channel: ListedAgentChannel } | {} {
    if (!this.channelSelfCheck || !type) return {};
    const report = this.channelSelfCheck({ type, key });

    // THE CARRIER IS ASKED OF THE THING THAT ROUTES, NOT DERIVED A SECOND TIME
    // (KAN-274). This used to read `report.transport`, or the literal `'channel'`
    // when there was no report — the self-check verdict alone, with nothing
    // asking whether a connection existed. The row therefore said
    // `transport: "channel"` for every agent that had outlived a daemon restart,
    // while a send to one of them took the composer and Ctrl+C'd it. Measured on
    // 2026-08-11: four agents in that state for 291 seconds, and the row's own
    // `detail` named the missing condition in prose — "when one is registered" —
    // while the field ignored it.
    //
    // `channelCarrier` is absent on a daemon wired without one, and the verdict
    // then falls back to the report exactly as before.
    //
    // NOTHING ABOUT DEGRADATION IS PASSED IN ANY MORE (KAN-435). This read
    // `report?.transport === 'composer'`, which is the verdict's own opinion of
    // itself and takes no account of whether the connection it was measured on
    // still exists — so a row could report `composer` for an agent whose channel
    // had been fine for hours. The carrier reader asks the verdict store, which
    // is the only place that can weigh a verdict against a live connection.
    const verdict = this.channelCarrier?.({ type, key }) ?? null;

    if (!report) {
      return {
        channel: {
          outcome: 'unchecked',
          // Unchecked still says nothing about the carrier — `carrierFor` does,
          // and on an agent that holds a live registration it still answers
          // `channel`, which is what it always should have meant.
          transport: verdict?.transport ?? 'channel',
          proved: false,
          clientName: null,
          clientVersion: null,
          clientVersionVerified: null,
          checkedAt: null,
          elapsedMs: null,
          attempts: null,
          detail:
            'no startup channel self-check has run for this agent — most often because it ' +
            'outlived the daemon that would have checked it, or because it was spawned while ' +
            'channel emission was off. Unchecked is not failed. ' +
            (verdict
              ? `Its next steer takes: ${verdict.transport} — ${verdict.detail}. `
              : '') +
            'Re-activating it runs the check.'
        }
      };
    }
    return {
      channel: {
        outcome: report.outcome,
        // The verdict wins over the report's own field, and can only ever be
        // *worse* than it: `carrierFor` is handed this report's degradation as
        // an input, so a `composer` verdict stays `composer` and a `channel`
        // one becomes `unregistered` when the connection behind it has gone.
        transport: verdict?.transport ?? report.transport,
        proved: report.proved,
        clientName: report.clientName,
        clientVersion: report.clientVersion,
        clientVersionVerified: report.clientVersionVerified,
        checkedAt: report.checkedAt,
        elapsedMs: report.elapsedMs,
        attempts: report.attempts,
        detail:
          verdict && verdict.transport !== report.transport
            ? `${report.detail} — but its next steer takes: ${verdict.transport}. ${verdict.detail}`
            : report.detail
      }
    };
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
      buffer: session.ptyBuffer,
      // **The buffer's other half** (KAN-381). A client attaching now was not
      // here for the gaps, so a live event cannot reach it — disclosure that
      // depended on who happened to be watching would leave every fresh
      // attach reading a holed buffer as a whole one. Empty means no gap was
      // recorded, which under `HerdrBridge` also means none was possible.
      discontinuities: session.ptyDiscontinuities
    });

    const oldCleanup = this.activePtyListeners.get(sessionId);
    if (oldCleanup) oldCleanup();

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    //
    // **Two arms, and the second is not optional to handle** (KAN-381). The
    // runtime's stream says either "here are bytes" or "bytes were missed, over
    // this window". Forwarding only the first is what makes a stale terminal
    // look like a quiet one, so the gap gets a frame of its own rather than a
    // field on a frame nobody reads.
    const cleanup = this.herdrBridge.registerDataListener(sessionId, (event) => {
      if (event.kind === 'data') {
        this.send({
          action: 'pty_output',
          sessionId,
          data: event.data
        });
        return;
      }
      this.send({
        action: 'pty_discontinuity',
        sessionId,
        discontinuity: event.discontinuity
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
