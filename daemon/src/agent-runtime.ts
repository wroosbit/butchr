import type { McpServerDefinitions } from './integrations/integration.js';
import type { ResumeCause } from './resume.js';
import type {
  AgentPresence,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  HerdrSession,
  SessionEndedEvent
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
 * The 20 methods below are exactly those `daemon.ts`, `jira-poll.ts`,
 * `nudge.ts`, `reconcile.ts` and `router.ts` actually call, across 43 call
 * sites. `HerdrBridge` declares 31 methods; the other 11 are implementation
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
 * An interface mirroring all 31 would have copied the implementation instead
 * of declaring the contract, and would make a second implementation harder
 * rather than easier — so the 11 stay out.
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

  tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): { success: boolean; text?: string; truncated?: boolean; error?: string };

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
