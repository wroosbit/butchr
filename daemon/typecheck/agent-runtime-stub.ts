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
import type { AgentRuntime, AgentSpawn } from '../src/agent-runtime.js';
import type {
  AgentPresence,
  CensusReading,
  HerdrAgentDescription,
  HerdrAgentRecord,
  HerdrAgentStatus,
  HerdrSession,
  SessionEndedEvent
} from '../src/herdr.js';
import type { McpServerDefinitions } from '../src/integrations/integration.js';
import type { ResumeCause } from '../src/resume.js';

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

  spawnSession(
    _type: string,
    _key: string,
    _url: string | undefined,
    _promptContent: string,
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

  getSessionByAddress(_key: string, _type?: string): HerdrSession | undefined {
    return undefined;
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

  tailAgent(
    _key: string,
    _type?: string,
    _lines?: number
  ): { success: boolean; text?: string; truncated?: boolean; error?: string } {
    return { success: false, error: 'stub' };
  }

  // KAN-246. One key, no interrupt — see the interface for why this is not a
  // smaller `sendToAgent`.
  pressPaneKey(_key: string, _type: string | undefined, _keyName: string): void {}

  async sendToAgent(
    _key: string,
    _message: string,
    _type?: string
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'stub' };
  }

  writePty(_sessionId: string | undefined, _data: string): boolean {
    return false;
  }

  resizePty(_sessionId: string | undefined, _cols: number, _rows: number): boolean {
    return false;
  }

  registerDataListener(
    _sessionId: string | undefined,
    _listener: (data: string) => void
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
