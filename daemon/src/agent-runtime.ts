import type { McpServerDefinitions } from './integrations/integration.js';
import type { ResumeCause } from './resume.js';
import type {
  AgentPresence,
  CensusReading,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  HerdrSession,
  PtyDiscontinuity,
  PtyStreamListener,
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
/**
 * What a runtime reports about a spawn it just made (KAN-294).
 *
 * ## `channelEnabled` has three states and `null` is not `false`
 *
 * - `true` — the spawn decided, and it is channel-capable.
 * - `false` — the spawn decided, and it is not.
 * - `null` — **no spawn decided this.** The runtime made no channel decision it
 *   can report, or has none to report about. It is *not* a way of saying "no
 *   channel".
 *
 * **Collapsing `null` into `false` is a silent defect and that is why it is
 * spelled out here rather than left to the type.** The two differ only for
 * agents nothing ever spawned, so a two-state read is green on every agent
 * anybody tests with and wrong on exactly the population it was added for.
 * CrabCast state it in as many words on the same field at `8d7348f`: *"`null`
 * means there is no spawn to be about, never 'no channel'."* It is invariant 11
 * on this side too — silence is not a negative. The name is deliberately theirs,
 * so one fact carries one name across both projects.
 *
 * ## `command` is diagnostic and nothing may branch on it
 *
 * Present where the runtime spawned a command line and `null` where it did not
 * — CrabCast publishes no argv at the pin, verified from the wire. It is here
 * for logs and for a human reading one. **The question it used to answer is
 * answered by `channelEnabled` now**, and `verify-channel-spawn-verdict.mjs` §4
 * asserts that no consumer has quietly gone back to reading it.
 */
export interface AgentSpawn {
  /** The spawn's own channel verdict. Three states; see above. */
  channelEnabled: boolean | null;
  /** The command line, where this runtime spawns one. Diagnostic only. */
  command: string | null;
}

export interface AgentRuntime {
  // -- lifecycle ------------------------------------------------------------

  /** Register the callback fired when a session ends. Called once, by `daemon.ts`. */
  setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void;

  /**
   * Register the callback fired once per pane this runtime actually spawns,
   * with the moment of the spawn and what the spawn decided. Called once, by
   * `daemon.ts`, which uses it to watch a channel-enabled agent through its
   * startup (KAN-246, channel-startup.ts).
   *
   * **`channelEnabled` is part of the contract; the command string is the
   * convenience.** That is the reverse of what this docblock said until
   * KAN-294, and the reversal is the point. The old wording made the command
   * line load-bearing — it was what made *"was this a channel-enabled spawn?"*
   * answerable from the thing that was spawned rather than from a second read
   * of a switch. The question was right and the carrier was wrong: a command
   * line answers it only for a runtime that spells its channel decision as a
   * flag, and `epic/KAN-59` is explicit that CrabCast does not — *"the channel
   * is not a command-line switch here — it is an MCP server entry."* Under that
   * shape the string sniff does not fail, it silently answers "no channel" for
   * every agent, which is the worse of the two outcomes. So the verdict now
   * crosses this boundary as a verdict.
   *
   * A runtime that never spawns a pane of its own may leave this unfired; the
   * daemon installs a listener and does not require it to be called.
   */
  setAgentSpawnedListener(
    listener: (session: HerdrSession, spawnedAt: number, spawn: AgentSpawn) => void
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
   * `listHerdrAgents` plus whether the census could be taken **and what it
   * could not read**. Callers that must distinguish "no agents" from "could not
   * ask" — or a whole fleet from a silently short one — use this one.
   *
   * The return type is named ({@link CensusReading}) rather than inlined so
   * that its qualifier is not something an implementation can quietly omit:
   * see that type for why `unreadableRecordsTotal` is required and why its
   * `null` must not be collapsed to `0`.
   */
  listHerdrAgentsChecked(): CensusReading;

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
   *
   * ## Why this one is `Promise`-returning and its 13 siblings are not (KAN-283)
   *
   * **A tail is the one read where a cached answer is the wrong answer.** Its
   * whole purpose is to say what the pane shows *now*, so the warm-mirror
   * strategy that correctly serves the census group is not available to it, and
   * a runtime living behind a socket has no third option: KAN-278 found
   * `CrabCastRuntime.tailAgent` refusing outright while CrabCast's own
   * `tail_agent` answered `text`, `truncated`, `source` and `sourcesTried` —
   * **a better match than most of this interface.** The data was there and the
   * signature could not reach it. That is the whole of why this method is async
   * and the reason is worth carrying: **it is the transport that requires it,
   * not tidiness.** The other 13 synchronous returns were each ruled on rather
   * than swept along — see the table in `docs/crabcast-runtime.md` — and every
   * one stayed synchronous, because a mirror or a local record serves it
   * correctly and changing it would have cost 43 call sites for nothing.
   *
   * **`HerdrBridge` answers from a `spawnSync` and therefore resolves on the
   * first microtask.** Going async changed no value it produces and no ordering
   * a caller can observe; `verify-tail-async-awaited.mjs` §1 pins that.
   *
   * ## THE HAZARD THE ASYNC SIGNATURE INTRODUCES, NAMED WHERE IT IS DECLARED
   *
   * **An un-awaited call reads exactly like a failed read, and nothing goes
   * red.** `Promise.success` is `undefined`, which is neither `true` nor
   * `false`, and `Promise.text` is `undefined` — so a caller that forgets the
   * `await` sees `success` falsy and `text` absent and concludes *"could not
   * look"* about a pane it never asked about. That resurrects the precise
   * KAN-255 defect this method's contract exists to forbid, one layer up: a
   * claim about the agent manufactured out of a fact about the caller. It is
   * silent in TypeScript at every site that spreads or truthiness-tests the
   * result rather than reading a typed field.
   *
   * `daemon/scripts/verify-tail-async-awaited.mjs` owns this: it greps every
   * call site for the `await` and drives the un-awaited shape to show what it
   * degrades to. Its verdict was watched failing before it was trusted.
   */
  tailAgent(
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
  }>;

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

  /**
   * Returns an unsubscribe function, or undefined when the session is gone.
   *
   * **The listener takes an event, not a string** (KAN-381). A runtime whose
   * pty subscription lives across a process boundary can lose it — a reconnect
   * re-establishes the link and not the subscription — and the window in which
   * that happened is something a consumer must be able to see rather than
   * infer. So the stream carries two arms: output, and
   * {@link PtyDiscontinuity}, the news that output was missed and over what
   * window.
   *
   * The shape is a union rather than an extra optional argument on purpose.
   * An optional argument is one every existing consumer keeps compiling
   * without reading, which would deliver the gap to code that renders it as
   * nothing — the same defect one layer up. A union has no `.data` on the
   * other arm, so a consumer has to say what a gap means to it.
   *
   * A runtime with an in-process pty never delivers the second arm and is
   * right not to; see `HerdrBridge.registerDataListener`.
   */
  registerDataListener(
    sessionId: string | undefined,
    listener: PtyStreamListener
  ): (() => void) | undefined;
}
