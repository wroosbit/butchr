import fs from 'fs';
import path from 'path';
import type { AgentRuntime } from './agent-runtime.js';
import {
  CrabCastLink,
  type CrabCastRefusal,
  renderRefusal
} from './crabcast-link.js';
import {
  agentNameFor,
  workspaceDirFor,
  workspacesRoot,
  type AgentPresence,
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
 * confirmed against the running daemon). Synchrony has three answers and no
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
 *    caller needs a *fresh* fact that costs a round trip. Used for
 *    {@link tailAgent}, and it is a real capability gap rather than a detail —
 *    see that method.
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
}

const HERDR_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

function asHerdrStatus(value: unknown): HerdrAgentStatus {
  return typeof value === 'string' && (HERDR_STATUSES as string[]).includes(value)
    ? (value as HerdrAgentStatus)
    : 'unknown';
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
  private readonly ptyMirrors = new Map<string, PtyMirror>();

  private census: Census = { reachable: false, at: 0, rows: [], foreign: [] };
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
   * **Deliberately never fired, and this is the honest answer rather than a
   * gap left by laziness.**
   *
   * The interface's own docblock is explicit that the command string is "part
   * of the contract, not a convenience": it is what makes *"was this a
   * channel-enabled spawn?"* answerable from the thing that was spawned, rather
   * than from a second read of a switch anything may have rewritten in between.
   *
   * **CrabCast publishes no command line.** Verified against a running daemon
   * at the pin: `activate_response` carries `launcher` ("shell", "claude") and
   * 20 other fields but no argv; `agent_status` and the `agent.activated`
   * broadcast carry none either. There is nothing to pass.
   *
   * So the choice is between firing with a fabricated command and not firing.
   * Firing would make `channel-startup.ts` (KAN-246) believe it knows something
   * it does not, which is the exact defect both projects' north stars name —
   * a claim that outruns its mechanism. The interface anticipates this: *"A
   * runtime that never spawns a pane of its own may leave this unfired; the
   * daemon installs a listener and does not require it to be called."*
   *
   * **The cost, named rather than buried: channel-startup supervision does not
   * run under this runtime.** That is one of the reasons this switch is off by
   * default, and it is a row in the method table with a verdict of `absent`.
   */
  setAgentSpawnedListener(
    _listener: (session: HerdrSession, spawnedAt: number, command: string) => void
  ): void {
    this.log(
      'setAgentSpawnedListener: registered and never fired — CrabCast publishes no spawn ' +
        'command line, and firing with a fabricated one would break channel-startup ' +
        'supervision more quietly than not firing does.'
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
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      configure.mcpConfig = JSON.stringify(mcpServers);
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
    session.status = 'active';
    this.log(`activated ${agentNameFor(session.type, session.key)} as ${remoteId}`);
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

  listHerdrAgentsChecked(): { reachable: boolean; agents: HerdrAgentRecord[] } {
    // The distinction this method exists for survives intact here, and it is
    // the one CrabCast's north star 2 and Butchr's both insist on: `reachable`
    // is a claim about whether the census could be TAKEN, never about whether
    // it found anything.
    if (!this.link.connected) return { reachable: false, agents: [] };
    return { reachable: this.census.reachable, agents: this.censusRecords() };
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
   * **The one method this runtime cannot serve, and the reason is the finding
   * of this ticket rather than a shortfall of CrabCast's.**
   *
   * CrabCast serves tails well: `tail_agent` answers `success`, `text`,
   * `truncated`, `source` and `sourcesTried`, with `source` drawn from the same
   * `'recent-unwrapped' | 'visible'` pair Butchr's own {@link TailSource} uses.
   * It is a *better* match than most of this interface — their KAN-98 fixed the
   * shape for the same reason ours has it.
   *
   * **`AgentRuntime.tailAgent` is synchronous.** A tail is the one read where a
   * cached answer is the wrong answer — its whole purpose is to show what the
   * pane says *now* — so the mirror strategy that serves the census group is
   * not available, and there is no way to await a socket inside a synchronous
   * signature.
   *
   * So it refuses, with figures, naming the leg — and the refusal is
   * `success: false`, which the interface's own docblock defines as **a claim
   * about the READ**, never about the agent. That is exactly what happened: we
   * could not look. Returning `success: true, text: ''` here would be the
   * precise defect that docblock was written to forbid.
   *
   * **The fix is the same one KAN-224 prescribed for the PTY group**: an async
   * signature. `tailAgent` needs to become `Promise`-returning before any
   * cutover, and that is interface work, not adapter work.
   */
  tailAgent(
    key: string,
    type?: string,
    _lines?: number
  ): {
    success: boolean;
    text?: string;
    truncated?: boolean;
    source?: TailSource | null;
    sourcesTried?: TailSource[];
    error?: string;
  } {
    return {
      success: false,
      error: renderRefusal(
        this.link.refusal(
          'butchr-adapter',
          `tailAgent(${type ?? '*'}/${key}) cannot be served: AgentRuntime declares it ` +
            'synchronous and this runtime answers over a socket. CrabCast serves tails fine ' +
            "(`tail_agent` returns text, truncated, source and sourcesTried) — it is our " +
            'signature that cannot await it',
          'Make tailAgent async before any cutover — the same change KAN-224 prescribed for ' +
            'the PTY group. Until then, run under the default herdr runtime for tails.'
        )
      )
    };
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
    return { reachable: true, at: Date.now(), rows: agents, foreign };
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
  } {
    return {
      link: this.link.describe(),
      sessions: this.sessions.size,
      ptyMirrors: this.ptyMirrors.size,
      censusAgeMs: this.census.at ? Date.now() - this.census.at : null,
      censusReachable: this.census.reachable
    };
  }

  /** Stops the census poll and drops the connection. Tests and shutdown only. */
  dispose(): void {
    if (this.censusTimer) clearInterval(this.censusTimer);
    this.censusTimer = null;
    this.link.close();
  }
}
