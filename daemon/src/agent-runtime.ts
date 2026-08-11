import type { McpServerDefinitions } from './integrations/integration.js';
import type { ResumeCause } from './resume.js';
import type {
  AgentPresence,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  HerdrSession,
  SessionEndedEvent,
  TailSource
} from './herdr.js';

/**
 * What the daemon needs from an agent runtime, and nothing more.
 *
 * `HerdrBridge` is the only implementation today. This interface exists so
 * that "could a different runtime drop in?" is a question the type system
 * answers rather than a judgement someone makes by reading — see KAN-223.
 *
 * ## Derived from call sites, not from the class
 *
 * The 23 methods below are exactly those `daemon.ts`, `jira-poll.ts`,
 * `nudge.ts`, `reconcile.ts` and `router.ts` actually call. (KAN-223 derived 20
 * from 43 call sites; KAN-246 added `setAgentSpawnedListener` and
 * `pressPaneKey`, both called from `daemon.ts`, and KAN-247 added
 * `resolveAddress` with its caller in `router.ts` — all by the same rule, that
 * a method is on this interface because daemon code calls it.) `HerdrBridge`
 * declares 34 methods (25 public, 9 private); the other 11 are implementation
 * and are deliberately absent:
 *
 * - **9 are private** — `liveAttachFor`, `startAgentInOwnTab`,
 *   `createAgentTab`, `closeTabPlaceholder`, `initPty`, `runHerdr`,
 *   `resolveAgentName`, `agentNameForAddress`, `closePaneForAgent`.
 * - **`getSessionByKey`** is public but has no caller in `daemon/src`. It is
 *   reached internally, by `getSessionByAddress` when no type is given
 *   (`herdr.ts`), and directly by one verify script asserting on a real
 *   bridge. Several verify scripts also include it in their hand-written stub
 *   bridges, but those mirror the class's shape rather than respond to a call
 *   from daemon code. Test scaffolding is not the contract.
 * - **`getPtyBuffer`** is public and called from nowhere at all.
 *
 * An interface mirroring all 34 would have copied the implementation instead
 * of declaring the contract, and would make a second implementation harder
 * rather than easier — so the 11 stay out. (34 − 11 = 23.)
 *
 * **The three counts in this header were all wrong until KAN-278**, which is
 * worth a sentence because of how they got that way rather than for its own
 * sake: each was correct when written and none was bumped by the ticket that
 * added a method. KAN-224 found the drift by enumerating; KAN-278 fixed it
 * while writing the second implementation. They are derived by
 * `verify-agent-runtime-seam.mjs` §2 from the interface itself, so the
 * *relationship* is enforced even when a number in prose is not.
 *
 * ## The PTY group is the exception
 *
 * `registerDataListener`, `writePty` and `resizePty` are the one group where a
 * second implementation would not be a passthrough: they assume a pty in this
 * process, and a runtime living in another process would have to turn these
 * in-process callbacks into cross-process events. Designing that is
 * deliberately **not** this interface's job — see the sibling ticket KAN-224.
 *
 * Two notes the ticket's framing does not cover, recorded here because this is
 * where the next reader will look:
 *
 * - `initPty` and `getPtyBuffer` belong to that group conceptually but are not
 *   on this interface — the first is private, the second uncalled. The PTY
 *   surface a second implementation must satisfy is the **three** methods
 *   above, not five.
 * - The coupling is not only in those methods. {@link HerdrSession} itself
 *   carries `ptyProcess?: pty.IPty` and `onDataListeners`, and every method
 *   returning a session hands that shape to its caller. So the pty assumption
 *   reaches the data type, not just the calls. That is KAN-224's problem to
 *   solve; naming it here so it is not rediscovered.
 *
 * ## Why the types still come from `herdr.js`
 *
 * The data types above are imported from `herdr.ts` rather than moved here.
 * Moving them would enlarge a deliberately mechanical change, and would not
 * buy a cleaner seam anyway: `HerdrSession` pulls in `node-pty`, so relocating
 * it would only move that dependency rather than remove it. The type-only
 * import keeps the implementation swappable, which is what this ticket is for.
 */
export interface AgentRuntime {
  // -- lifecycle ------------------------------------------------------------

  /** Register the callback fired when a session ends. Called once, by `daemon.ts`. */
  setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void;

  /**
   * Register the callback fired once per pane this runtime actually spawns,
   * with the moment of the spawn and the command line it ran. Called once, by
   * `daemon.ts`, which uses it to watch a channel-enabled agent through its
   * startup (KAN-246, channel-startup.ts).
   *
   * **The command string is part of the contract, not a convenience.** It is
   * what makes "was this a channel-enabled spawn?" answerable from the thing
   * that was spawned, rather than from a second read of a switch that anything
   * may have rewritten in between — see the note on the implementation.
   *
   * A runtime that never spawns a pane of its own may leave this unfired; the
   * daemon installs a listener and does not require it to be called.
   */
  setAgentSpawnedListener(
    listener: (session: HerdrSession, spawnedAt: number, command: string) => void
  ): void;

  spawnSession(
    type: string,
    key: string,
    url: string | undefined,
    promptContent: string,
    defaultAgent?: string,
    mcpServers?: McpServerDefinitions,
    resume?: ResumeCause
  ): HerdrSession;

  abandonSession(sessionId: string, error: string): void;

  terminateSession(sessionId: string): { success: boolean; error?: string };

  resetWorkspace(type: string, key: string): { success: boolean; error?: string };

  closeAgentByKey(
    key: string,
    type?: string
  ): { success: boolean; agentName?: string; error?: string };

  // -- lookup ---------------------------------------------------------------

  getSession(sessionId: string): HerdrSession | undefined;

  /**
   * The dominant lookup — 8 of the 43 call sites. Addresses an agent by
   * (key, type); a bare key matches whatever type it lands on.
   */
  getSessionByAddress(key: string, type?: string): HerdrSession | undefined;

  listActiveSessions(): HerdrSession[];

  describeAgent(key: string, type?: string): HerdrAgentDescription;

  /**
   * Resolve a (key, type) address, inferring the type from the agent's name
   * when it is not given. **Throws** when the key names no agent or an
   * ambiguous one, so an unaddressable key stays unaddressable rather than
   * silently reaching the wrong agent — callers are expected to catch.
   *
   * Added by KAN-247, which gave it its first caller in `router.ts`. It is on
   * this interface for the same reason everything else is: a real call site.
   */
  resolveAddress(key: string, type?: string): { type: string; key: string };

  // -- the runtime's own census ---------------------------------------------

  /** Whether the underlying runtime answers at all. */
  herdrReachable(): boolean;

  listHerdrAgents(): HerdrAgentRecord[];

  /**
   * `listHerdrAgents` plus whether the census could be taken. Callers that
   * must distinguish "no agents" from "could not ask" use this one.
   */
  listHerdrAgentsChecked(): { reachable: boolean; agents: HerdrAgentRecord[] };

  listHerdrStatuses(): Map<string, HerdrAgentStatus>;

  /**
   * Wait, up to `timeoutMs`, for an agent to show up in the census.
   * `requireRuntime` decides whether a pane with no runtime behind it counts.
   */
  confirmAgentPresent(
    agentName: string,
    requireRuntime: boolean,
    timeoutMs?: number
  ): Promise<AgentPresence>;

  // -- talking to an agent --------------------------------------------------

  /**
   * The tail of an agent's terminal.
   *
   * **`success: true` with `text: ''` is a claim about the AGENT; `success:
   * false` is a claim about the READ.** Implementations must ask every read
   * source before reporting an empty pane — herdr answers `""` for a live pane
   * that has text on it (see `TAIL_SOURCES` in herdr.ts) — and a source that
   * FAILED is not a source that said empty. `source` names which one answered,
   * and is `null` exactly when every source was asked and every one was empty.
   */
  tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): {
    success: boolean;
    text?: string;
    truncated?: boolean;
    source?: TailSource | null;
    sourcesTried?: TailSource[];
    error?: string;
  };

  /**
   * Press one key at an agent's pane. Throws when the agent, the pane or the
   * runtime itself is not there.
   *
   * **Not a smaller `sendToAgent`.** That method opens with a Ctrl+C, which
   * cancels the recipient's turn and abandons any tool call in flight; this
   * sends exactly the key it is given. Its one caller answers a full-screen
   * startup dialog that is blocking the session's own boot, where there is no
   * turn to cancel because the agent has not begun one (KAN-246).
   */
  pressPaneKey(key: string, type: string | undefined, keyName: string): void;

  /**
   * Types a message into an agent's terminal. Resolves to whether the
   * keystrokes were *typed*, which is not the same as delivered — see the
   * note above `sendToAgent`'s caller in `nudge.ts`.
   */
  sendToAgent(
    key: string,
    message: string,
    type?: string
  ): Promise<{ success: boolean; error?: string }>;

  // -- pty: the exception, see KAN-224 --------------------------------------

  writePty(sessionId: string | undefined, data: string): boolean;

  resizePty(sessionId: string | undefined, cols: number, rows: number): boolean;

  /** Returns an unsubscribe function, or undefined when the session is gone. */
  registerDataListener(
    sessionId: string | undefined,
    listener: (data: string) => void
  ): (() => void) | undefined;
}
