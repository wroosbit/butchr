import fs from 'fs';
import path from 'path';
import type { AgentRuntime, AgentSpawn } from './agent-runtime.js';
import {
  CRABCAST_CONTRACT_VERSION,
  CrabCastLink,
  type CrabCastRefusal,
  renderRefusal
} from './crabcast-link.js';
import {
  agentNameFor,
  workspaceDirFor,
  workspacesRoot,
  type AgentPresence,
  type CensusReading,
  type CensusUnreadableRecord,
  type HerdrAgentDescription,
  type HerdrAgentRecord,
  type HerdrAgentStatus,
  type HerdrSession,
  type SessionEndedEvent,
  type TailSource
} from './herdr.js';
import type { McpServerDefinitions } from './integrations/integration.js';
import type { ResumeCause } from './resume.js';

/**
 * A second implementation of {@link AgentRuntime}, backed by CrabCast (KAN-278).
 *
 * **It is off by default and nothing is migrated onto it.** Selection lives in
 * `runtime-switch.ts`; this file is only what the switch selects. The channel
 * work is the precedent being copied: land it inert, exercise it deliberately,
 * and let becoming the default be a separate decision on a separate ticket.
 *
 * ## The finding that shapes this whole file
 *
 * KAN-224 established that **PTY is the one method group that is not a
 * passthrough**, and that is true. But it is not the binding constraint, and
 * building this turned up the one that is:
 *
 * > **`AgentRuntime` is a synchronous interface and CrabCast is a socket.**
 * > 14 of the 23 methods return data synchronously. A socket cannot answer a
 * > synchronous call, so every one of them is served from a mirror, from a
 * > local record, or not at all.
 *
 * That is a bigger break than PTY and it was not on anybody's list. PTY at
 * least *has* a clean answer (KAN-224's local mirror, implemented below and
 * confirmed against the running daemon). Synchrony had three answers and no
 * fourth, exactly as KAN-224 §5.1 found for `ptyBuffer` alone:
 *
 * 1. **Serve it from a mirror the adapter keeps warm.** Correct for census
 *    questions — "what is the fleet doing?" — because the honest answer to
 *    those is already an observation with a timestamp, and `HerdrBridge`'s own
 *    answer is a `herdr agent list` shell-out that is stale the moment it
 *    returns. Used for the census group.
 * 2. **Serve it from a record only this adapter holds.** Correct for sessions
 *    *we* started: we know them exactly, with no round trip and no staleness.
 *    Used for the session-lookup group.
 * 3. **Refuse, with figures, naming the leg.** The only honest answer where the
 *    caller needs a *fresh* fact that costs a round trip.
 *
 * **KAN-283 added the fourth, which was never a strategy but a repair: change
 * the signature.** `tailAgent` was the whole of category 3 and is served over
 * the wire now — a tail is the one read where a cached answer is the wrong
 * answer, so neither mirror nor local record could serve it, and refusing was
 * the honest answer only for as long as the interface forbade awaiting. **The
 * other 13 synchronous returns were each ruled on and every one stayed
 * synchronous**, because 1 or 2 serves it correctly or because CrabCast has no
 * counterpart to await; the ruling is in `docs/crabcast-runtime.md` under *The
 * synchrony ruling*. So categories 1 and 2 are the design and category 3 is now
 * empty of anything a signature change could rescue.
 *
 * ## What was read to build this
 *
 * CrabCast's **interface**, never its source: `crabcast --help` and each
 * command's help, the `--json` responses of a real daemon, and direct probes of
 * the socket. The human's decision of 2026-08-08 stands unlifted, and no file
 * under `crabcast/src` was opened. Everything asserted here about their
 * behaviour is reproducible by
 * `node daemon/scripts/verify-crabcast-runtime.mjs`.
 */

/** Butchr's `(type, key)` address and CrabCast's path address are the same fact. */
function pathForAddress(type: string, key: string): string {
  return workspaceDirFor(type, key);
}

/**
 * The inverse. Returns null for a path outside Butchr's workspace tree — which
 * is most of what a shared CrabCast daemon reports, since it also sees panes
 * nobody in this daemon started.
 */
function addressForPath(dir: string): { type: string; key: string } | null {
  const rel = path.relative(workspacesRoot(), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;
  return { type: parts[0], key: parts[1] };
}

/** One row of CrabCast's `list_agents.agents`, narrowed to what we branch on. */
interface CensusRow {
  path: string;
  paneName: string;
  sessionId: string | null;
  status: string | null;
  herdrStatus: string | null;
  agentRuntime: string | null;
  state: string | null;
  workDir: string | null;
}

/** A census reading, with the timestamp that makes its staleness legible. */
interface Census {
  reachable: boolean;
  at: number;
  rows: CensusRow[];
  /** Panes CrabCast can see but does not own. Read for `describeAgent`. */
  foreign: CensusRow[];
  /**
   * `list_agents.unreadableRecordsTotal`, read at read-path contract v4
   * (KAN-324). `null` means the frame carried no disclosure — a peer below v4,
   * or a census that was never taken. **Never defaulted to `0`**: see
   * {@link CensusReading}.
   */
  unreadableRecordsTotal: number | null;
  /** `list_agents.unreadableRecords`, narrowed to what Butchr may carry. */
  unreadableRecords: CensusUnreadableRecord[];
}

/**
 * The empty census — what this runtime holds before it has read one, and what
 * every failure path falls back to.
 *
 * Its disclosure is `null` rather than `0`, and that is the point of it being a
 * named constant rather than an object literal repeated at five call sites: a
 * literal is where somebody writes `0` because it looks tidier, and `0` there
 * is the claim *"a census was taken and found nothing skipped"* about a census
 * that did not happen.
 */
const NO_CENSUS: Census = {
  reachable: false,
  at: 0,
  rows: [],
  foreign: [],
  unreadableRecordsTotal: null,
  unreadableRecords: []
};

const HERDR_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

function asHerdrStatus(value: unknown): HerdrAgentStatus {
  return typeof value === 'string' && (HERDR_STATUSES as string[]).includes(value)
    ? (value as HerdrAgentStatus)
    : 'unknown';
}

/**
 * The read sources a tail may name — the same pair `TAIL_SOURCES` declares in
 * `herdr.ts`, restated here rather than imported because that constant is not
 * exported and the type is.
 *
 * **Confirmed identical on the wire**, which is why the mapping is a narrowing
 * and not a translation: a live CrabCast at `6f47df7d` answered
 * `sourcesTried: ["recent-unwrapped", "visible"]` — their own vocabulary,
 * matching ours value for value. That is the exception rather than the rule
 * across this adapter, and it is the whole reason {@link CrabCastRuntime.tailAgent}
 * is worth serving over the wire instead of approximating.
 */
const TAIL_SOURCE_VALUES = ['recent-unwrapped', 'visible'] as const;

/**
 * A source name we recognise, or `null`.
 *
 * **`null` means "every source was asked and every one was empty"** — the
 * assertion {@link AgentRuntime.tailAgent} defines and that
 * `superviseChannelStartup` relies on — and an unrecognised value collapses to
 * it for a reason worth stating: a source we cannot name is one we cannot make
 * that claim about either, and the alternative is passing a string through the
 * type as if it had been checked. A new source appearing on their side is
 * therefore *visible* here as a `null` rather than smuggled through, and
 * `sourcesTried` still carries what they said.
 */
function narrowTailSource(value: unknown): TailSource | null {
  return typeof value === 'string' && (TAIL_SOURCE_VALUES as readonly string[]).includes(value)
    ? (value as TailSource)
    : null;
}

/** The same narrowing over a list, dropping anything we cannot name. */
function narrowTailSources(values: unknown[]): TailSource[] {
  return values
    .map((v) => narrowTailSource(v))
    .filter((v): v is TailSource => v !== null);
}

/**
 * KAN-224's `PtyMirror`, implemented.
 *
 * The local reconstitution of `HerdrSession`'s pty fields: the snapshot
 * replaces {@link buffer} and is never fanned out; each `pty_output` frame is
 * appended **and** fanned out, with the same `slice(-100000)` bound
 * `HerdrBridge` uses. Two destinations, no overlap, nothing to deduplicate.
 */
interface PtyMirror {
  remoteSessionId: string;
  buffer: string;
  listeners: Array<(data: string) => void>;
  state: 'subscribing' | 'live' | 'ended';
  generation: number;
}

const PTY_BUFFER_LIMIT = 100_000;

/**
 * Read CrabCast's `channelEnabled` off a frame **without collapsing its third
 * state** (KAN-294, consuming their KAN-281 at `8d7348f`).
 *
 * ## The three states, confirmed from the wire at the pin rather than relayed
 *
 * Driven against a real daemon built at `8d7348f`, isolated `dataDir`:
 *
 * | what was done | surface | value |
 * | --- | --- | --- |
 * | `configure --mcp crabcast`, then `activate` | `activate_response` | `true` |
 * | `configure` with no `--mcp`, then `activate` | `activate_response` | `false` |
 * | `configure`, never activated | `agent_status` | `null` |
 * | a path nobody configured | `agent_status` | `null` |
 * | `activate` refused for capacity | `activate_response` | `null` |
 *
 * That last row was not planned and is the most useful of the five: a refusal
 * spawned nothing, so there is no spawn to be about, and CrabCast answers
 * `null` rather than `false` on the one path most likely to have been written
 * as a boolean.
 *
 * ## Why this is a function and not `frame.channelEnabled ?? false`
 *
 * Because that expression is the defect, and it is a *silent* one. `??` and
 * `!!` and a `boolean` type annotation all turn "nobody decided" into "decided
 * no", and the two differ only for agents nothing ever spawned — so the
 * collapsed version is green against every agent anybody tests with. CrabCast
 * say it on the field itself: *"`null` means there is no spawn to be about,
 * never 'no channel'."* A wrong `false` is the actively damaging value, because
 * `false` is what a caller branches on to conclude the channel is unavailable.
 *
 * **An unrecognised type is `null`, not `false`.** Their §8 requires a value a
 * consumer does not recognise to be handled as an unknown rather than errored
 * on, and `null` is this field's spelling of unknown. A string `"true"` would
 * be a shape nobody has seen; reading it as `true` would be guessing and
 * reading it as `false` would be the collapse.
 *
 * ## Where it is read from, and what that is worth
 *
 * `activate_response` — **which is outside their read-path contract.** They
 * disclosed that themselves and their KAN-287 is the ticket to close it, so
 * this field can change here without moving
 * {@link CRABCAST_CONTRACT_VERSION} and without going red in their CI.
 *
 * **And `list_agents` does not carry it at all** — checked row by row at the
 * pin, the key is simply absent. That is not documented anywhere: their
 * contract covers `list_agents` and `agent_status`, and the `channelEnabled`
 * section describes `agent_status` and `activate_response` without saying the
 * census omits it. It matters here more than it would to most consumers,
 * because **the census is the only thing this runtime polls** ({@link
 * startCensus}). So the verdict is reachable at the spawn and by a per-agent
 * `agent_status` round trip, and never from the poll we already run — which is
 * why it is kept on the session at {@link provision} rather than refreshed.
 */
export function readChannelEnabled(frame: Record<string, unknown>): boolean | null {
  const value = frame.channelEnabled;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Read read-path contract v4's skipped-row disclosure off a `list_agents` or
 * `daemon_status` frame (KAN-324), **without collapsing its third state**.
 *
 * ## What this is reading, and why an additive change needed any code at all
 *
 * v4 added `unreadableRecords` and `unreadableRecordsTotal` to both calls
 * because CrabCast's KAN-302 changed what an unreadable registry row does:
 * their daemon used to refuse to start on one and now starts and **skips** it.
 * So from v4 onward a census can be *short*, and at v3 there was no field that
 * could say so. Measured on this machine against a peer at `6258ded`:
 * `agents: []`, `configuredAgents: 0`, `unreadableRecordsTotal: 1` — an empty
 * fleet and a one-row-short fleet, identical on every field a v3 consumer
 * reads. CrabCast put the counts and the disclosure adjacent for exactly this
 * reason: **a count that silently excludes what it could not read is the
 * defect, one field to the left.**
 *
 * ## Why this is a function and not `frame.unreadableRecordsTotal ?? 0`
 *
 * Because that expression is the defect, and it is the *silent* kind — the same
 * one {@link readChannelEnabled} exists to refuse, in the same shape. `?? 0`
 * turns **"this peer disclosed nothing"** into **"this peer disclosed that
 * nothing was skipped"**, and those are opposite claims about how far the agent
 * count can be trusted. It is green against every v4 peer anybody tests with,
 * because a v4 peer sends the field; it is wrong only against the v3 peer this
 * adapter is still expected to meet — and wrong in the direction of looking
 * clean.
 *
 * So: a number is a disclosure, and **anything else is `null`**. A negative or
 * non-integer total is not a count either — it is a shape nobody has seen, and
 * reading it as a count would be guessing while reading it as `0` would be the
 * collapse.
 *
 * ## The total is not the array's length, and must not be derived from it
 *
 * Both are read, separately, and the total wins. CrabCast caps the detail rows
 * it returns on other lists in this same frame (`pages.*.limit` is 25), so a
 * length that had silently stopped at a cap would read as *"that is all of
 * them"* — which is this ticket's own defect, reproduced inside the field
 * written to disclose it. `unreadableRecords` is therefore evidence about the
 * rows it names and never a count of the rows there are.
 */
export function readUnreadableDisclosure(frame: Record<string, unknown>): {
  unreadableRecordsTotal: number | null;
  unreadableRecords: CensusUnreadableRecord[];
} {
  const total = frame.unreadableRecordsTotal;
  const rows = Array.isArray(frame.unreadableRecords) ? frame.unreadableRecords : [];

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  return {
    unreadableRecordsTotal:
      typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null,
    unreadableRecords: rows.map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        source: 'crabcast-registry' as const,
        line: typeof r.line === 'number' && Number.isInteger(r.line) ? r.line : null,
        problem: str(r.problem),
        identity: str(r.identity),
        reason: str(r.reason)
        // `raw` is deliberately not carried. See CensusUnreadableRecord.
      };
    })
  };
}

export interface CrabCastRuntimeOptions {
  link: CrabCastLink;
  /** How often the census is refreshed while connected. */
  censusIntervalMs?: number;
  log?: (message: string) => void;
}

export class CrabCastRuntime implements AgentRuntime {
  private readonly link: CrabCastLink;
  private readonly log: (message: string) => void;
  private readonly censusIntervalMs: number;

  /** Sessions this daemon started. Authoritative, exact, no round trip. */
  private readonly sessions = new Map<string, HerdrSession>();
  /** Butchr session id → CrabCast's own session id, which addresses the wire. */
  private readonly remoteIds = new Map<string, string>();
  /**
   * Butchr session id → the spawn's channel verdict, as CrabCast reported it.
   *
   * **Three states, and the map has a fourth thing to say: an absent key.** A
   * key that is not here is a session this adapter has no verdict for at all —
   * `provision` has not answered yet, or never will. {@link channelEnabledFor}
   * renders that as `null` too, which is right: "no spawn decided" and "no
   * answer reached us" are both *not a verdict*, and neither is `false`.
   */
  private readonly channelEnabled = new Map<string, boolean | null>();
  private readonly ptyMirrors = new Map<string, PtyMirror>();

  private census: Census = NO_CENSUS;
  private censusTimer: NodeJS.Timeout | null = null;

  private sessionEndedListener: ((event: SessionEndedEvent) => void) | null = null;

  constructor(options: CrabCastRuntimeOptions) {
    this.link = options.link;
    this.censusIntervalMs = options.censusIntervalMs ?? 2_000;
    this.log = options.log ?? ((m) => console.log(`[CrabCastRuntime] ${m}`));

    this.link.onEvent((frame) => this.onCrabCastEvent(frame));
    this.link.connect();
    this.startCensus();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void {
    this.sessionEndedListener = listener;
  }

  /**
   * **Still never fired — but the reason changed at `8d7348f`, and the new one
   * is smaller and worth stating exactly** (KAN-294).
   *
   * **The old reason is gone.** It was that CrabCast publishes no command line,
   * and that the command line was what made *"was this a channel-enabled
   * spawn?"* answerable — so there was nothing to pass. Both halves have moved:
   * the interface no longer carries a command string as its contract (it
   * carries {@link AgentSpawn.channelEnabled}), and CrabCast now publishes
   * exactly that verdict as `activate_response.channelEnabled`. **The question
   * this listener exists to answer is now answerable under this runtime**, and
   * {@link provision} reads and keeps the answer — see {@link channelEnabledFor}.
   *
   * **The remaining reason is the consumer, not the datum.** The one caller
   * (`daemon.ts` → `superviseChannelStartup`, KAN-246) does not merely want to
   * know the verdict; it then *supervises* the startup, and supervision is built
   * out of two methods — {@link tailAgent} and {@link pressPaneKey}.
   *
   * **KAN-283 fixed half of that, and half is not enough to fire on.**
   * `tailAgent` is served over the wire now, so the *observation* half works:
   * the watcher could read the pane for real. `pressPaneKey` still throws,
   * because CrabCast has no `press_pane_key` and its `send_to_agent` opens with
   * a Ctrl+C — which is the one thing a startup dialog must not receive, since
   * the Ctrl+C would cancel the boot the Enter exists to unblock. So firing here
   * would start a watcher that **sees the dialog correctly and cannot answer
   * it**, retrying until its deadline. That is a worse failure than the old one
   * rather than a better one: it burns a real socket read every three seconds to
   * reach a conclusion it was never able to act on.
   *
   * The interface still anticipates this: *"A runtime that never spawns a pane
   * of its own may leave this unfired; the daemon installs a listener and does
   * not require it to be called."*
   *
   * **The cost, named rather than buried, and it is unchanged: channel-startup
   * supervision does not run under this runtime.** What changed is which leg is
   * missing. It was two; it is now one, and that one is CrabCast's absent verb
   * rather than our signature — an interface observation for KAN-59, not
   * something this side can close. That is gate 3, and it is one of the reasons
   * the switch is off by default.
   */
  setAgentSpawnedListener(
    _listener: (session: HerdrSession, spawnedAt: number, spawn: AgentSpawn) => void
  ): void {
    this.log(
      'setAgentSpawnedListener: registered and never fired. The spawn verdict IS available ' +
        'now (activate_response.channelEnabled, kept per session) and tailAgent IS served ' +
        'since KAN-283, so the watcher could read the pane — but pressPaneKey still throws, ' +
        'because CrabCast has no press_pane_key and send_to_agent opens with a Ctrl+C. ' +
        'Firing would start a watcher that sees the startup dialog correctly and cannot ' +
        'answer it. One leg missing rather than two, and it is theirs rather than ours.'
    );
  }

  /**
   * `configure_agent` then `activate_agent` — two calls, both asynchronous,
   * behind a signature that is synchronous and must return a session now.
   *
   * The session is returned in `'initializing'`, which is what that state is
   * for, and is promoted to `'active'` when the activation answers. A failure
   * lands in `spawnError`, which the interface documents as the difference
   * between "this agent is quiet" and "this agent was never created".
   *
   * **`HerdrSession.sessionId` stays Butchr's own.** CrabCast mints its own id
   * and we keep it in {@link remoteIds} rather than swapping it into the object
   * the caller is already holding — a caller that read `session.sessionId` and
   * then found it renamed would be holding a key that addresses nothing.
   */
  spawnSession(
    type: string,
    key: string,
    url: string | undefined,
    promptContent: string,
    defaultAgent?: string,
    mcpServers?: McpServerDefinitions,
    resume?: ResumeCause
  ): HerdrSession {
    const existing = this.sessionForAddress(type, key);
    if (existing && existing.status !== 'terminated') {
      this.log(`reusing live session ${existing.sessionId} for ${agentNameFor(type, key)}`);
      return existing;
    }

    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    const workDir = pathForAddress(type, key);

    // **Butchr creates the directory, because CrabCast will not.** Their north
    // star 3 is that an agent IS a canonical filesystem path and the caller owns
    // it — `configure_agent` refuses a path that does not exist rather than
    // making one. `HerdrBridge` happens to mkdir in the same place, so this is
    // not new behaviour; it is the same behaviour becoming this side's explicit
    // job. It is the exact mirror of {@link resetWorkspace}: the whole lifecycle
    // of the directory is ours under this runtime, both ends of it.
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    const session: HerdrSession = {
      sessionId,
      type,
      key,
      url,
      createdAt: new Date(),
      status: 'initializing',
      workDir,
      ptyBuffer: '',
      onDataListeners: [],
      expectsRuntime: defaultAgent !== 'shell',
      ...(resume ? { resume } : {})
    };
    this.sessions.set(sessionId, session);

    void this.provision(session, promptContent, defaultAgent, mcpServers).catch((err) => {
      session.status = 'terminated';
      session.spawnError = err instanceof Error ? err.message : String(err);
      this.log(`spawn failed for ${agentNameFor(type, key)}: ${session.spawnError}`);
    });

    return session;
  }

  private async provision(
    session: HerdrSession,
    promptContent: string,
    defaultAgent?: string,
    mcpServers?: McpServerDefinitions
  ): Promise<void> {
    const configure: Record<string, unknown> = {
      action: 'configure_agent',
      path: session.workDir,
      priority: 1,
      launcher: defaultAgent ?? 'claude',
      prompt: promptContent
    };
    // `mcpServers`, AN OBJECT, AND NOT `mcpConfig`, A STRING (KAN-294).
    //
    // This read `configure.mcpConfig = JSON.stringify(mcpServers)` until the
    // re-pin, and that field does not exist on `configure_agent`. It was not
    // rejected — CrabCast accepted the call, answered `success: true`, and
    // simply did not have the servers: `agent_status` echoed
    // `config.mcpServers: undefined` for an agent configured that way. So every
    // agent this runtime spawned got NO MCP servers at all, silently, and
    // `channelEnabled` was structurally `false` for all of them. Confirmed on a
    // real daemon at the pin, both directions — the wrong field echoes
    // `undefined`, the right one echoes back what was sent.
    //
    // The shape is the one CrabCast's own refusal states: *"an object keyed by
    // server name … IT IS DEFINITIONS RATHER THAN NAMES: the command, args and
    // env that spawn each server, written into .mcp.json verbatim."* That is
    // exactly `McpServerDefinitions`, so this is a pass-through and not a
    // translation.
    //
    // WHAT IS DELIBERATELY NOT DONE HERE. Their `"builtin"` sentinel —
    // `{"crabcast": "builtin"}` — is how an agent would be given CrabCast's own
    // channel server, and it is what makes `channelEnabled` answer `true`. This
    // does not send it. Giving Butchr's agents a CrabCast channel is a cutover
    // decision about which daemon an agent talks to, and cutover is out of scope
    // (KAN-294 item 5). The consequence, stated rather than left to be found: an
    // agent spawned through this runtime answers `channelEnabled: false`, and
    // that `false` is now honest — it is CrabCast reporting a spawn that decided,
    // where before it was reporting a spawn whose MCP request it had discarded.
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      configure.mcpServers = mcpServers;
    }

    const configured = await this.link.request(configure);
    if (configured.success !== true) {
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'crabcast-daemon',
            `configure_agent refused: ${String(configured.error ?? 'no reason given')}`,
            'Read the refusal above; CrabCast states the binding constraint with its figures.'
          )
        )
      );
    }

    const activated = await this.link.request({ action: 'activate_agent', path: session.workDir });
    if (activated.success !== true) {
      // A capacity refusal lands here, and it arrives with CrabCast's own
      // derivation attached. Carrying their text verbatim is deliberate: their
      // figures are the product, and paraphrasing them would lose the terms.
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'crabcast-daemon',
            `activate_agent refused: ${String(activated.error ?? 'no reason given')}`,
            'Wait for room, stand an agent down, or read the derivation CrabCast printed.'
          )
        )
      );
    }

    const remoteId = typeof activated.sessionId === 'string' ? activated.sessionId : null;
    if (!remoteId) {
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'butchr-adapter',
            'activate_agent answered success with no sessionId, so nothing can be addressed'
          )
        )
      );
    }
    this.remoteIds.set(session.sessionId, remoteId);

    // THE SPAWN'S CHANNEL VERDICT, TAKEN HERE BECAUSE HERE IS THE ONLY PLACE IT
    // IS AVAILABLE (KAN-294). `activate_response` is the surface that describes
    // *the spawn we just made*; `list_agents` — the only thing this runtime
    // polls — does not carry the field at all, confirmed row by row at the pin.
    // So this is not a cache of something re-readable: it is the record of a
    // fact that has no second source short of a per-agent `agent_status` round
    // trip, and the interface this serves is synchronous.
    //
    // Read through `readChannelEnabled` rather than inline, so that the one
    // place `null` could be flattened into `false` is a named function with a
    // proof pointed at it (`verify-channel-spawn-verdict.mjs` §2).
    this.channelEnabled.set(session.sessionId, readChannelEnabled(activated));

    session.status = 'active';
    this.log(
      `activated ${agentNameFor(session.type, session.key)} as ${remoteId} ` +
        `(channelEnabled=${JSON.stringify(readChannelEnabled(activated))})`
    );
  }

  /**
   * Whether the spawn behind a session was channel-capable, as CrabCast reported
   * it at activation. **Three states; `null` is not `false`.**
   *
   * `null` covers three genuinely different situations, and merging them here is
   * correct where merging them with `false` would not be: CrabCast said `null`
   * (no spawn to be about), CrabCast said nothing recognisable, or this adapter
   * has no record for the session. All three are *"no verdict"*, which is what
   * `null` means; none of them is *"there is no channel"*.
   *
   * Nothing branches on this yet, and that is stated rather than implied — see
   * {@link setAgentSpawnedListener} for why the one consumer cannot run under
   * this runtime. It is on {@link describe} so an operator can see it, and it is
   * the value the live proof asserts arrives.
   */
  channelEnabledFor(sessionId: string): boolean | null {
    return this.channelEnabled.get(sessionId) ?? null;
  }

  abandonSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = 'terminated';
    session.spawnError = error;
    this.endMirror(sessionId, 1);
  }

  terminateSession(sessionId: string): { success: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `No session ${sessionId}` };
    // Synchronous signature, asynchronous verb. The local record is marked
    // immediately because the caller's next read must not see a live session,
    // and the wire call is fired behind it. The honest limit: this returns
    // "asked", not "stopped" — CrabCast's own answer arrives later and is
    // logged. Callers that need "stopped" have `agent.detached`.
    session.status = 'terminated';
    void this.link
      .request({ action: 'deactivate_agent', path: session.workDir })
      .then((res) => {
        if (res.success !== true) this.log(`deactivate refused for ${session.workDir}: ${String(res.error)}`);
      })
      .catch((err) => this.log(`deactivate failed for ${session.workDir}: ${err.message}`));
    this.endMirror(sessionId, 0);
    return { success: true };
  }

  /**
   * **Absent on CrabCast, by their design, and this refuses rather than
   * improvises.**
   *
   * Verified from the wire: `reset_workspace` and `reset_agent` both answer
   * with a refusal that states the reason outright — *"`reset` was removed:
   * CrabCast no longer creates the directory an agent runs in, so it may not
   * delete one either."* That is KAN-59's north star 3 (*an agent IS a
   * canonical filesystem path; the caller owns the directory*), not an
   * oversight, and it will not be coming back.
   *
   * **Butchr owns the deletion in a migrated world**, and the machinery for
   * doing it safely already exists here rather than there: `workspacesRoot()`
   * and the strictly-inside check `HerdrBridge.resetWorkspace` uses. Wiring
   * that up is a cutover decision and cutover is explicitly out of scope for
   * KAN-278, so this refuses and names the leg.
   */
  resetWorkspace(type: string, key: string): { success: boolean; error?: string } {
    return {
      success: false,
      error: renderRefusal(
        this.link.refusal(
          'butchr-adapter',
          `resetWorkspace(${type}/${key}) has no CrabCast counterpart: their \`reset\` was ` +
            'removed deliberately, because CrabCast never creates the directory an agent runs ' +
            'in and so may not delete one',
          'Deleting the workspace becomes Butchr\'s own job under this runtime. That wiring is ' +
            'cutover work and KAN-278 is explicitly not a cutover; run under the default herdr ' +
            'runtime if you need reset today.'
        )
      )
    };
  }

  closeAgentByKey(
    key: string,
    type?: string
  ): { success: boolean; agentName?: string; error?: string } {
    const session = type ? this.sessionForAddress(type, key) : this.sessionForKey(key);
    if (!session) {
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal('butchr-adapter', `no session this daemon started matches ${type ?? '*'}/${key}`)
        )
      };
    }
    const result = this.terminateSession(session.sessionId);
    return { ...result, agentName: agentNameFor(session.type, session.key) };
  }

  // ── lookup ───────────────────────────────────────────────────────────────

  getSession(sessionId: string): HerdrSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByAddress(key: string, type?: string): HerdrSession | undefined {
    return type ? this.sessionForAddress(type, key) : this.sessionForKey(key);
  }

  listActiveSessions(): HerdrSession[] {
    return [...this.sessions.values()].filter((s) => s.status !== 'terminated');
  }

  describeAgent(key: string, type?: string): HerdrAgentDescription {
    const resolvedType = type ?? this.sessionForKey(key)?.type ?? null;
    const agentName = resolvedType ? agentNameFor(resolvedType, key) : `butchr-?-${key.toLowerCase()}`;
    const dir = resolvedType ? pathForAddress(resolvedType, key) : null;
    const row =
      (dir ? this.census.rows.find((r) => r.path === dir) : undefined) ??
      this.census.foreign.find((r) => r.paneName === agentName);
    return {
      agentName,
      type: resolvedType,
      workDir: row?.workDir ?? row?.path ?? dir,
      herdrStatus: asHerdrStatus(row?.herdrStatus)
    };
  }

  /**
   * Served entirely locally, and that is correct rather than a shortcut.
   *
   * `type` is Butchr's vocabulary — CrabCast has no notion of one, by their
   * north star 4 (*no consumer's vocabulary lives inside it*), and an agent
   * there is a bare directory path. So there is nothing to ask: the mapping
   * from a key to a type is a fact about this daemon's own sessions.
   *
   * Throws on an unknown or ambiguous key, exactly as the interface requires,
   * so an unaddressable key stays unaddressable rather than silently reaching
   * the wrong agent.
   */
  resolveAddress(key: string, type?: string): { type: string; key: string } {
    if (type) return { type, key };
    const matches = [...this.sessions.values()].filter(
      (s) => s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
    if (matches.length === 1) return { type: matches[0].type, key: matches[0].key };
    if (matches.length === 0) throw new Error(`No agent named ${key}`);
    throw new Error(
      `Ambiguous key ${key}: ${matches.map((m) => `${m.type}/${m.key}`).join(', ')}. Pass a type.`
    );
  }

  // ── the runtime's own census ─────────────────────────────────────────────

  herdrReachable(): boolean {
    return this.link.connected && this.census.reachable;
  }

  listHerdrAgents(): HerdrAgentRecord[] {
    return this.censusRecords();
  }

  listHerdrAgentsChecked(): CensusReading {
    // The distinction this method exists for survives intact here, and it is
    // the one CrabCast's north star 2 and Butchr's both insist on: `reachable`
    // is a claim about whether the census could be TAKEN, never about whether
    // it found anything.
    //
    // KAN-324 adds a second distinction of the same species one level down:
    // `agents` is what the census found, and `unreadableRecordsTotal` is how
    // much of the registry it could not look at. A disconnected link discloses
    // `null` for the same reason it reports no agents — there is no reading to
    // qualify, and `0` would claim there was one.
    if (!this.link.connected) {
      return { reachable: false, agents: [], unreadableRecordsTotal: null, unreadableRecords: [] };
    }
    return {
      reachable: this.census.reachable,
      agents: this.censusRecords(),
      unreadableRecordsTotal: this.census.unreadableRecordsTotal,
      unreadableRecords: this.census.unreadableRecords
    };
  }

  listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    const out = new Map<string, HerdrAgentStatus>();
    for (const record of this.censusRecords()) out.set(record.name, record.herdrStatus);
    return out;
  }

  async confirmAgentPresent(
    agentName: string,
    requireRuntime: boolean,
    timeoutMs = 10_000
  ): Promise<AgentPresence> {
    const startedAt = Date.now();
    let checks = 0;
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
      checks++;
      try {
        const res = await this.link.request({ action: 'list_agents' });
        if (res.success === true) {
          const rows = this.readCensus(res);
          const all = [...rows.rows, ...rows.foreign];
          const match = all.find((r) => r.paneName === agentName);
          if (match && (!requireRuntime || match.agentRuntime !== null)) {
            return { present: true, waitedMs: Date.now() - startedAt, checks };
          }
          lastError = match
            ? `pane ${agentName} exists but CrabCast reports no agent runtime behind it`
            : `no pane named ${agentName} in CrabCast's census`;
        } else {
          lastError = String(res.error ?? 'list_agents answered success: false');
        }
      } catch (err) {
        // Could not ask. That is `unverifiable`, never `absent` — the whole
        // point of the two-reason split is that nothing may be concluded from
        // a census that did not happen.
        return {
          present: false,
          reason: 'unverifiable',
          error: err instanceof Error ? err.message : String(err),
          waitedMs: Date.now() - startedAt,
          checks
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      present: false,
      reason: 'absent',
      error: lastError || `${agentName} did not appear within ${timeoutMs}ms`,
      waitedMs: Date.now() - startedAt,
      checks
    };
  }

  // ── talking to an agent ──────────────────────────────────────────────────

  /**
   * **Served for real, over the wire — this is what KAN-283 unblocked.**
   *
   * KAN-278 found this method refusing while CrabCast's own `tail_agent`
   * answered `success`, `text`, `truncated`, `source` and `sourcesTried`, with
   * `source` drawn from the same `'recent-unwrapped' | 'visible'` pair Butchr's
   * own {@link TailSource} uses. **The data was there and our signature could
   * not reach it**: `AgentRuntime.tailAgent` was synchronous, a tail is the one
   * read where a cached answer is the wrong answer, and so the mirror strategy
   * that correctly serves the census group was unavailable. The interface is
   * `Promise`-returning now and the refusal is gone.
   *
   * ## Three things confirmed from the wire rather than from their document
   *
   * Driven against a live daemon at `6f47df7d` (contract v6 — **past our pin**,
   * so these are claims about that build, not about `CRABCAST_PIN`):
   *
   * 1. **`path` is required and must exist.** Omitting it answers *"Missing or
   *    invalid path: an agent is addressed by the directory it runs in"*; a path
   *    that is not there answers `ENOENT` with their reason that the filesystem
   *    is the typo-checker. Both are `success: false`.
   * 2. **`sourcesTried` comes back on the refusal too**, carrying both sources
   *    — so their `success: false` is a claim about the READ in the same sense
   *    ours is, and the field maps straight across.
   * 3. **They can only tail an agent CrabCast itself configured.** Their agent
   *    name is derived from the path (`crabcast-<leaf>-<hash>`), so a pane
   *    *herdr* owns under a Butchr name is `not found` even though
   *    `list_agents` reports it under `foreignPanes`. That is honest rather than
   *    broken — see the note on the fall-through below — and it is why this
   *    method is not a general pane reader under this runtime.
   *
   * ## What is deliberately NOT done here
   *
   * **No fallback to a mirror, and no synthesised empty pane.** A failed read
   * stays `success: false` with the refusal carried verbatim. Returning
   * `success: true, text: ''` on a refusal is the precise defect
   * {@link AgentRuntime.tailAgent}'s contract was written to forbid — a claim
   * about the agent manufactured out of a fact about the read — and it is the
   * one this method must never introduce now that it has a wire to fail on.
   */
  async tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): Promise<{
    success: boolean;
    text?: string;
    truncated?: boolean;
    source?: TailSource | null;
    sourcesTried?: TailSource[];
    error?: string;
  }> {
    // ADDRESSED THE SAME WAY `describeAgent` IS, so one key cannot mean two
    // agents depending on which method asked. A bare key is resolved through
    // our own session table because `type` is Butchr's vocabulary and CrabCast
    // has none — their north star 4.
    const resolvedType = type ?? this.sessionForKey(key)?.type ?? null;
    if (!resolvedType) {
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal(
            'butchr-adapter',
            `tailAgent(${key}) cannot be addressed: no type was given and no session this ` +
              'daemon started names that key, so there is no path to ask CrabCast about',
            'Pass a type, or address an agent this daemon spawned.'
          )
        )
      };
    }

    const dir = pathForAddress(resolvedType, key);
    try {
      const res = await this.link.request({
        action: 'tail_agent',
        path: dir,
        ...(lines === undefined ? {} : { lines })
      });

      if (res.success !== true) {
        // THEIR REFUSAL, CARRIED VERBATIM AND NOT PARSED. `sourcesTried` is
        // passed through when they send it because it is the same field with the
        // same meaning — "we looked here" — and dropping it would lose the only
        // evidence that the read was attempted twice.
        return {
          success: false,
          error: renderRefusal(
            this.link.refusal(
              'crabcast-daemon',
              `tail_agent(${resolvedType}/${key}) refused: ` +
                String(res.error ?? 'no reason given'),
              'Start a CrabCast daemon addressing that socket if it is down, or unset ' +
                'BUTCHR_AGENT_RUNTIME to serve tails from the default herdr runtime, which ' +
                'needs no peer. Note that CrabCast can only tail an agent it configured ' +
                'itself: a pane herdr owns under a Butchr name is not theirs to read.'
            )
          ),
          ...(Array.isArray(res.sourcesTried)
            ? { sourcesTried: narrowTailSources(res.sourcesTried) }
            : {})
        };
      }

      // `text` MUST BE A STRING TO BE A SUCCESSFUL READ. A `success: true` with
      // no text is not an empty pane — it is a response we cannot interpret, and
      // the honest report of one is that we could not look.
      if (typeof res.text !== 'string') {
        return {
          success: false,
          error: renderRefusal(
            this.link.refusal(
              'crabcast-daemon',
              `tail_agent(${resolvedType}/${key}) answered success without text ` +
                `(text was ${typeof res.text}), so what is on the pane is UNKNOWN rather ` +
                'than empty',
              'This is an interface observation for KAN-59, not a change request.'
            )
          ),
          ...(Array.isArray(res.sourcesTried)
            ? { sourcesTried: narrowTailSources(res.sourcesTried) }
            : {})
        };
      }

      // `source: null` WITH `success: true` IS "EVERY SOURCE WAS ASKED AND EVERY
      // ONE WAS EMPTY", and it is the assertion `superviseChannelStartup` and
      // `readLandedCount` are entitled to rely on. It is carried through as
      // `null` rather than dropped: an absent `source` and a `null` one are the
      // same fact here only because their empty answer spells it the same way,
      // and `?? null` says so once instead of leaving it to each caller.
      return {
        success: true,
        text: res.text,
        truncated: res.truncated === true,
        source: narrowTailSource(res.source),
        ...(Array.isArray(res.sourcesTried)
          ? { sourcesTried: narrowTailSources(res.sourcesTried) }
          : {})
      };
    } catch (e: any) {
      // A LINK THAT IS DOWN IS A READ WE COULD NOT MAKE, never an empty pane.
      //
      // RE-HEADLINED RATHER THAN CARRIED, and the reason is the one thing this
      // path has that the link's generic refusal does not: a remedy that is
      // *specific to a tail*. `request` rejects with `unreachable()`, whose
      // remedy is the right general advice — start a daemon, or unset the
      // switch — and a reader looking at a failed tail wants to be told that
      // **the default herdr runtime serves tails with no peer at all**. The
      // figures are not lost: `link.refusal()` regenerates socket, errno,
      // attempts, downFor and last-good from the same link, and the original
      // message is appended so nothing the link said is discarded.
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal(
            'crabcast-socket',
            `tail_agent(${resolvedType}/${key}) could not be sent: ` +
              String(e?.message ?? e),
            'Start a CrabCast daemon addressing that socket, or unset ' +
              'BUTCHR_AGENT_RUNTIME to serve tails from the default herdr runtime, which ' +
              'needs no peer.'
          )
        )
      };
    }
  }

  /**
   * **Absent.** CrabCast has no `press_pane_key`: verified from the wire, where
   * it answers `Unknown action`. Its `send_to_agent` is not a substitute — that
   * verb opens with a Ctrl+C (its response reports `interrupts: 1`), which is
   * precisely what this method exists **not** to do. Its one caller answers a
   * full-screen startup dialog that is blocking a session's own boot, where a
   * Ctrl+C would cancel the boot it is trying to unblock.
   *
   * `pty_input` can carry a raw keystroke, but only for a session with a live
   * pty mirror, and the caller here has a *pane* and no session. Pretending
   * otherwise would answer a different question.
   *
   * Throws, as the interface requires of a runtime that cannot reach the pane.
   */
  pressPaneKey(key: string, type: string | undefined, keyName: string): void {
    throw new Error(
      renderRefusal(
        this.link.refusal(
          'butchr-adapter',
          `pressPaneKey(${type ?? '*'}/${key}, ${keyName}) has no CrabCast counterpart — ` +
            'there is no press_pane_key action, and send_to_agent opens with a Ctrl+C, which ' +
            'is the one thing this method must not do',
          'This is an interface observation for KAN-59, not a change request. Channel startup ' +
            'supervision (KAN-246) is inert under this runtime; it is off by default.'
        )
      )
    );
  }

  async sendToAgent(
    key: string,
    message: string,
    type?: string
  ): Promise<{ success: boolean; error?: string }> {
    const session = type ? this.sessionForAddress(type, key) : this.sessionForKey(key);
    if (!session) {
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal('butchr-adapter', `no session this daemon started matches ${type ?? '*'}/${key}`)
        )
      };
    }
    try {
      const res = await this.link.request({
        action: 'send_to_agent',
        path: session.workDir,
        message
      });
      if (res.success !== true) {
        return { success: false, error: String(res.error ?? 'send_to_agent answered success: false') };
      }
      // CrabCast answers richer than this interface can carry: `delivered`,
      // `verdict`, `interrupts`, `submits` and an `evidence` block. The
      // interface takes a boolean, and the honest mapping is their `delivered`
      // rather than the bare `success` — `success` says the call worked,
      // `delivered` says the keystrokes landed, and this method's contract is
      // about the typing.
      const delivered = res.delivered === true;
      return delivered
        ? { success: true }
        : { success: false, error: `CrabCast verdict: ${String(res.verdict ?? 'not delivered')}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── pty: KAN-224's design, implemented ───────────────────────────────────

  writePty(sessionId: string | undefined, data: string): boolean {
    const remote = this.remoteFor(sessionId);
    if (!remote) return false;
    // Fire and forget, with no `id`: CrabCast only acks a frame that carries
    // one, and a keystroke wants no ack. This matches the in-process version's
    // meaning exactly — `HerdrBridge.writePty` returns "do I have this
    // session?", never "did the bytes reach the pty".
    void this.link.request({ action: 'pty_input', sessionId: remote, data }).catch(() => {});
    return true;
  }

  resizePty(sessionId: string | undefined, cols: number, rows: number): boolean {
    const remote = this.remoteFor(sessionId);
    if (!remote) return false;
    void this.link.request({ action: 'pty_resize', sessionId: remote, cols, rows }).catch(() => {});
    return true;
  }

  /**
   * Never touches the socket — the point of KAN-224's design.
   *
   * The cross-process subscription is per **session** and is opened once, by
   * {@link ensureMirror}. This call pushes onto a local array and returns a
   * closure that filters it back out, which is the same operation with the same
   * semantics as `HerdrBridge`'s. That is what makes CrabCast's missing detach
   * verb a non-problem rather than a blocker.
   */
  registerDataListener(
    sessionId: string | undefined,
    listener: (data: string) => void
  ): (() => void) | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const mirror = this.ensureMirror(sessionId);
    if (!mirror) return undefined;
    mirror.listeners.push(listener);
    return () => {
      mirror.listeners = mirror.listeners.filter((fn) => fn !== listener);
    };
  }

  private ensureMirror(sessionId: string): PtyMirror | undefined {
    const existing = this.ptyMirrors.get(sessionId);
    if (existing) return existing;
    const remote = this.remoteFor(sessionId);
    if (!remote) return undefined;

    const mirror: PtyMirror = {
      remoteSessionId: remote,
      buffer: '',
      listeners: [],
      state: 'subscribing',
      generation: 0
    };
    this.ptyMirrors.set(sessionId, mirror);
    void this.subscribeMirror(sessionId, mirror);
    return mirror;
  }

  private async subscribeMirror(sessionId: string, mirror: PtyMirror): Promise<void> {
    try {
      const { buffer } = await this.link.ptyInit(mirror.remoteSessionId, (data) => {
        // Appended AND fanned out — the snapshot is neither. Two destinations
        // with no overlap is what makes duplication structurally impossible.
        mirror.buffer = (mirror.buffer + data).slice(-PTY_BUFFER_LIMIT);
        const session = this.sessions.get(sessionId);
        if (session) session.ptyBuffer = mirror.buffer;
        for (const fn of mirror.listeners) fn(data);
      });
      // Replaces, never appends. Appending the snapshot is the duplication bug
      // in its most tempting form (KAN-224 §3.5).
      mirror.buffer = buffer.slice(-PTY_BUFFER_LIMIT);
      mirror.state = 'live';
      const session = this.sessions.get(sessionId);
      if (session) session.ptyBuffer = mirror.buffer;
    } catch (err) {
      mirror.state = 'ended';
      this.log(`pty mirror for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `reason` is `SessionEndReason`, whose two values are `'taken-over'` and
   * `'exited'`.
   *
   * **CrabCast cannot tell those apart and this does not guess.** `taken-over`
   * is Butchr's own concept — an attach evicted by a second one, detected in
   * `HerdrBridge` by scanning the pty buffer for herdr's takeover notice. No
   * CrabCast event carries it: `agent.detached` says the session ended and
   * nothing about why. So every end reported through this runtime is
   * `'exited'`, which is the weaker and true claim, rather than a coin-flip
   * between two states a caller renders differently.
   */
  private endMirror(sessionId: string, exitCode: number): void {
    // The verdict belongs to a spawn, and this spawn is over. Dropped rather
    // than left behind so a later session reusing nothing of this one cannot
    // read a stale `true` — and dropping it renders as `null`, which is the
    // honest answer for a session there is no longer a spawn to be about.
    this.channelEnabled.delete(sessionId);
    const mirror = this.ptyMirrors.get(sessionId);
    if (mirror) {
      this.link.releasePty(mirror.remoteSessionId);
      mirror.state = 'ended';
      mirror.listeners = [];
      this.ptyMirrors.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session && this.sessionEndedListener) {
      const event: SessionEndedEvent = {
        type: session.type,
        key: session.key,
        sessionId,
        reason: 'exited',
        exitCode
      };
      this.sessionEndedListener(event);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private remoteFor(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    return this.remoteIds.get(sessionId) ?? null;
  }

  private sessionForAddress(type: string, key: string): HerdrSession | undefined {
    return [...this.sessions.values()].find(
      (s) => s.type === type && s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
  }

  private sessionForKey(key: string): HerdrSession | undefined {
    return [...this.sessions.values()].find(
      (s) => s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
  }

  private censusRecords(): HerdrAgentRecord[] {
    const rows = [...this.census.rows, ...this.census.foreign];
    return rows.map((row) => ({
      name: row.paneName,
      agentRuntime: row.agentRuntime,
      workDir: row.workDir ?? row.path,
      herdrStatus: asHerdrStatus(row.herdrStatus)
    }));
  }

  private readCensus(frame: Record<string, unknown>): Census {
    const toRow = (raw: unknown): CensusRow => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        path: typeof r.path === 'string' ? r.path : '',
        paneName: typeof r.paneName === 'string' ? r.paneName : '',
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        status: typeof r.status === 'string' ? r.status : null,
        herdrStatus: typeof r.herdrStatus === 'string' ? r.herdrStatus : null,
        agentRuntime: typeof r.agentRuntime === 'string' ? r.agentRuntime : null,
        state: typeof r.state === 'string' ? r.state : null,
        workDir: typeof r.workDir === 'string' ? r.workDir : null
      };
    };
    const agents = Array.isArray(frame.agents) ? frame.agents.map(toRow) : [];
    const foreign = Array.isArray(frame.foreignPanes) ? frame.foreignPanes.map(toRow) : [];
    return {
      reachable: true,
      at: Date.now(),
      rows: agents,
      foreign,
      ...readUnreadableDisclosure(frame)
    };
  }

  private startCensus(): void {
    const tick = () => {
      if (!this.link.connected) {
        this.census = { ...this.census, reachable: false };
        return;
      }
      void this.link
        .request({ action: 'list_agents' })
        .then((res) => {
          if (res.success === true) this.census = this.readCensus(res);
          else this.census = { ...this.census, reachable: false };
        })
        .catch(() => {
          this.census = { ...this.census, reachable: false };
        });
    };
    tick();
    this.censusTimer = setInterval(tick, this.censusIntervalMs);
    this.censusTimer.unref?.();
  }

  /**
   * `agent.detached` is how a session death reaches us — the cross-process
   * equivalent of `HerdrBridge`'s in-process `sessionEndedListener`. Verified
   * on the wire: it is broadcast to every connected client, unasked, carrying
   * `at`, `seq` and `bootId`.
   */
  private onCrabCastEvent(frame: Record<string, unknown>): void {
    const action = String(frame.action ?? '');
    const dir = typeof frame.path === 'string' ? frame.path : null;
    if (!dir) return;
    const address = addressForPath(dir);
    if (!address) return; // a CrabCast agent outside Butchr's tree; not ours

    if (action === 'agent.detached' || action === 'agent.deactivated') {
      const session = this.sessionForAddress(address.type, address.key);
      if (!session) return;
      session.status = 'terminated';
      this.endMirror(session.sessionId, 0);
    }
  }

  /** Everything an operator needs about this runtime, for the honest report. */
  describe(): {
    link: ReturnType<CrabCastLink['describe']>;
    sessions: number;
    ptyMirrors: number;
    censusAgeMs: number | null;
    censusReachable: boolean;
    /**
     * Rows the last census could not read, and therefore did not count
     * (KAN-324). **`censusReachable: true` with a non-zero total here is a
     * census that was taken and is short** — the one state a v3-proved adapter
     * could not express, and the reason this field is on the operator report
     * rather than only in a log line. `null` is no disclosure at all.
     */
    censusUnreadableRecordsTotal: number | null;
    censusUnreadableRecords: CensusUnreadableRecord[];
    /**
     * One entry per session this adapter started, with the spawn's channel
     * verdict. **Counted three ways rather than summed into a boolean** — a
     * count of "channel-enabled agents" would have to decide what to do with
     * the `null`s, and there is no right answer to that question.
     */
    channelEnabled: { true: number; false: number; null: number };
  } {
    const tally = { true: 0, false: 0, null: 0 };
    for (const session of this.sessions.keys()) {
      const verdict = this.channelEnabledFor(session);
      if (verdict === true) tally.true++;
      else if (verdict === false) tally.false++;
      else tally.null++;
    }
    return {
      link: this.link.describe(),
      sessions: this.sessions.size,
      ptyMirrors: this.ptyMirrors.size,
      censusAgeMs: this.census.at ? Date.now() - this.census.at : null,
      censusReachable: this.census.reachable,
      censusUnreadableRecordsTotal: this.census.unreadableRecordsTotal,
      censusUnreadableRecords: this.census.unreadableRecords,
      channelEnabled: tally
    };
  }

  /** Stops the census poll and drops the connection. Tests and shutdown only. */
  dispose(): void {
    if (this.censusTimer) clearInterval(this.censusTimer);
    this.censusTimer = null;
    this.link.close();
  }
}
