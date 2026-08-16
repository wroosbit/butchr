/**
 * KAN-223 acceptance criterion 4: a second implementation is expressible.
 *
 * This file is never executed and never shipped — it lives outside `src/` so
 * it stays out of `dist/`, and it exists only to be typechecked. If it
 * compiles, a runtime that is not `HerdrBridge` can be dropped into every
 * place the daemon wires one.
 *
 * The assertions below deliberately use the **real consumers' own types**
 * (`ConstructorParameters<typeof MessageRouter>`, `JiraPollerOptions`, and so
 * on) rather than re-stating `AgentRuntime`. Asserting `stub satisfies
 * AgentRuntime` would only prove the stub matches the interface — it would
 * stay green if someone retyped `router.ts` back to the concrete class, which
 * is exactly the regression worth catching. Pinning to the wiring sites means
 * the seam has to be real at each of them.
 *
 * This is not a CrabCast client and must not grow into one (KAN-223 scope).
 */
import type { AgentRuntime, AgentSpawn, SendToAgentResult } from '../src/agent-runtime.js';
import type {
  AgentPresence,
  CensusReading,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  HerdrSession,
  PtyStreamListener,
  SessionAddressResolution,
  SessionEndedEvent
} from '../src/herdr.js';
import type { McpServerDefinitions } from '../src/integrations/integration.js';
import type { BriefLocation, ResumeCause } from '../src/resume.js';

import type { MessageRouter } from '../src/router.js';
import type { JiraPollerOptions } from '../src/jira-poll.js';
import type { reconcileAgents } from '../src/reconcile.js';
import type { waitForAgentReady, deliverToAgent } from '../src/nudge.js';

const unimplemented = (): never => {
  throw new Error('typecheck fixture: never executed');
};

/**
 * The minimum a non-herdr runtime has to provide. Note what it does *not*
 * need: no pty process. `HerdrSession.ptyProcess` is optional, so a runtime
 * with no in-process pty can still produce a session — which is why the PTY
 * problem KAN-224 owns is about the three pty *methods*, not about being
 * unable to satisfy the type at all.
 */
class StubRuntime implements AgentRuntime {
  // KAN-475. A runtime has to be able to say what it is, because the sentences
  // that name a runtime now ask one instead of spelling it. The union is
  // deliberately closed — a third runtime widens `RuntimeMode` rather than
  // inventing a name here — so this fixture is where that cost is felt, which
  // is what the fixture is for.
  readonly runtimeName = 'crabcast' as const;

  // KAN-495. A new runtime must state whether its agents can receive a channel
  // frame at all, and `'unknown'` is the answer a fixture is entitled to: it
  // routes exactly as the daemon routed before KAN-495 and claims nothing.
  //
  // **This member being REQUIRED is the fix, and this line is where the cost of
  // it lands** — which is what this fixture is for. Adding it to `AgentRuntime`
  // broke the seam typecheck until it was written here, and that is the property
  // the ticket bought: KAN-495 was a runtime that could not carry the
  // dev-channels flag, said nothing about it, and had every instrument report
  // its frames delivered. An optional field would have let the next runtime
  // repeat that in silence.
  readonly channelReach = 'unknown' as const;

  setSessionEndedListener(_listener: (event: SessionEndedEvent) => void): void {}

  // KAN-246. A runtime that spawns no pane of its own simply never fires this,
  // which is why the daemon treats it as a notification rather than a promise.
  //
  // KAN-294 changed the third argument from the spawned command line to the
  // spawn's own record, `AgentSpawn`. The point of this fixture is that the
  // change is felt HERE and not only at `HerdrBridge`: a second runtime that
  // cannot produce a command line can still produce a verdict, which is the
  // whole reason the argument moved.
  setAgentSpawnedListener(
    _listener: (session: HerdrSession, spawnedAt: number, spawn: AgentSpawn) => void
  ): void {}

  // KAN-482 added `_priority`, and this fixture is where a third runtime is
  // TOLD it exists. That is the point of the parameter being required rather
  // than optional: `provision()` sent a hard-coded `1` for every agent for as
  // long as the CrabCast adapter had existed, and an optional parameter would
  // have let the next implementation reintroduce it in silence. Here the
  // omission does not compile — this fixture went red on exactly that, before
  // the parameter was added below.
  //
  // KAN-492 added `_supervisor` the same way and for the same reason, and this
  // fixture proved the claim rather than restating it: leaving the stub alone
  // did not fail as a missing parameter but as `Type 'boolean' is not
  // assignable to type 'string'` — the required parameter shifted `defaultAgent`
  // along and the compiler caught it at the shift. Worth knowing before reading
  // that error as unrelated: a third runtime that ignores supervisor-ness is
  // told about it here, whichever way the message is worded.
  spawnSession(
    _type: string,
    _key: string,
    _url: string | undefined,
    _promptContent: string,
    _priority: number,
    _supervisor: boolean,
    _defaultAgent?: string,
    _mcpServers?: McpServerDefinitions,
    _resume?: ResumeCause
  ): HerdrSession {
    return unimplemented();
  }

  abandonSession(_sessionId: string, _error: string): void {}

  terminateSession(_sessionId: string): { success: boolean; error?: string } {
    return { success: false, error: 'stub' };
  }

  resetWorkspace(_type: string, _key: string): { success: boolean; error?: string } {
    return { success: false, error: 'stub' };
  }

  closeAgentByKey(
    _key: string,
    _type?: string
  ): { success: boolean; agentName?: string; error?: string } {
    return { success: false, error: 'stub' };
  }

  getSession(_sessionId: string): HerdrSession | undefined {
    return undefined;
  }

  getSessionByAddress(_key: string, _type: string): HerdrSession | undefined {
    return undefined;
  }

  resolveSessionByAddress(_key: string, _type?: string): SessionAddressResolution {
    return { outcome: 'none' };
  }

  listActiveSessions(): HerdrSession[] {
    return [];
  }

  describeAgent(_key: string, _type?: string): HerdrAgentDescription {
    return { agentName: 'stub', type: null, workDir: null, herdrStatus: 'unknown' };
  }

  resolveAddress(_key: string, _type?: string): { type: string; key: string } {
    return unimplemented();
  }

  // A third runtime has to say where it puts an agent's brief, and the union is
  // what stops it answering with a path it does not have (KAN-400). This stub
  // writes no brief anywhere, so the honest answer is the `runtime-owned` arm.
  briefLocation(_type: string, _key: string): BriefLocation {
    return { kind: 'runtime-owned', pointer: 'nowhere — this stub starts no agents' };
  }

  herdrReachable(): boolean {
    return false;
  }

  listHerdrAgents(): HerdrAgentRecord[] {
    return [];
  }

  listHerdrAgentsChecked(): CensusReading {
    // `null` rather than `0`: this stub takes no census, so it has nothing to
    // disclose about one. `0` would be a claim that a reading happened and
    // found nothing skipped — see CensusReading.
    return { reachable: false, agents: [], unreadableRecordsTotal: null, unreadableRecords: [] };
  }

  listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    return new Map();
  }

  async confirmAgentPresent(
    _agentName: string,
    _requireRuntime: boolean,
    _timeoutMs?: number
  ): Promise<AgentPresence> {
    return { present: false, reason: 'unverifiable', error: 'stub', waitedMs: 0, checks: 0 };
  }

  // KAN-283. `Promise`-returning, because a runtime answering over a socket
  // cannot serve a tail synchronously — see AgentRuntime.tailAgent.
  async tailAgent(
    _key: string,
    _type?: string,
    _lines?: number
  ): Promise<{ success: boolean; text?: string; truncated?: boolean; error?: string }> {
    return { success: false, error: 'stub' };
  }

  // KAN-246. One key, no interrupt — see the interface for why this is not a
  // smaller `sendToAgent`.
  pressPaneKey(_key: string, _type: string | undefined, _keyName: string): void {}

  // KAN-498. `pane` is REQUIRED, and this stub is one of the places that says
  // so: a runtime cannot answer with a bare delivery boolean and leave the
  // router to derive "a live session exists" from it. A stub knows nothing
  // about any pane, so it says `not-measured` — which is the honest arm and
  // deliberately not `no`.
  async sendToAgent(_key: string, _message: string, _type?: string): Promise<SendToAgentResult> {
    return {
      success: false,
      error: 'stub',
      pane: { reached: 'not-measured', detail: 'this stub never reaches a pane' }
    };
  }

  writePty(_sessionId: string | undefined, _data: string): boolean {
    return false;
  }

  resizePty(_sessionId: string | undefined, _cols: number, _rows: number): boolean {
    return false;
  }

  registerDataListener(
    _sessionId: string | undefined,
    _listener: PtyStreamListener
  ): (() => void) | undefined {
    return undefined;
  }
}

const stub = new StubRuntime();

// -- the seam, asserted at each site the daemon actually wires a runtime -----

/** `router.ts` — the third constructor parameter of MessageRouter. */
type RouterRuntimeParam = ConstructorParameters<typeof MessageRouter>[2];
export const atRouter: RouterRuntimeParam = stub;

/** `jira-poll.ts` */
export const atJiraPoller: JiraPollerOptions['herdrBridge'] = stub;

/** `reconcile.ts` */
export const atReconcile: Parameters<typeof reconcileAgents>[0]['herdrBridge'] = stub;

/** `nudge.ts` — both the positional and the options-bag entry points. */
export const atNudgeWait: Parameters<typeof waitForAgentReady>[0] = stub;
export const atNudgeDeliver: Parameters<typeof deliverToAgent>[0]['herdrBridge'] = stub;
