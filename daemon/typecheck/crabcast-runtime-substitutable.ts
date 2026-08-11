/**
 * KAN-278: the CrabCast-backed runtime is substitutable at every site the
 * daemon wires a runtime — asserted against the **real class**, not a stub.
 *
 * `agent-runtime-stub.ts` beside this file proves a second implementation is
 * *expressible*, which was KAN-223's criterion and is a strictly weaker claim.
 * This proves the second implementation that now exists is *acceptable* at the
 * five wiring sites, which is what "provably substitutable" has to mean once
 * there is a real one.
 *
 * The assertions use the consumers' own parameter types rather than
 * `satisfies AgentRuntime`, for the reason the stub file states: asserting
 * against the interface would stay green if someone retyped `router.ts` back to
 * the concrete `HerdrBridge`, and that is exactly the regression worth
 * catching.
 *
 * Never executed and never shipped — it lives outside `src/`, so it stays out
 * of `dist/`, and the tsconfig here is `noEmit`. Nothing below constructs a
 * runtime, so importing this file opens no socket.
 */
import type { CrabCastRuntime } from '../src/crabcast-runtime.js';
import type { MessageRouter } from '../src/router.js';
import type { JiraPollerOptions } from '../src/jira-poll.js';
import type { reconcileAgents } from '../src/reconcile.js';
import type { waitForAgentReady, deliverToAgent } from '../src/nudge.js';

declare const crabcast: CrabCastRuntime;

/** `router.ts` — the third constructor parameter of MessageRouter. */
export const crabcastAtRouter: ConstructorParameters<typeof MessageRouter>[2] = crabcast;

/** `jira-poll.ts` */
export const crabcastAtJiraPoller: JiraPollerOptions['herdrBridge'] = crabcast;

/** `reconcile.ts` */
export const crabcastAtReconcile: Parameters<typeof reconcileAgents>[0]['herdrBridge'] = crabcast;

/** `nudge.ts` — both the positional and the options-bag entry points. */
export const crabcastAtNudgeWait: Parameters<typeof waitForAgentReady>[0] = crabcast;
export const crabcastAtNudgeDeliver: Parameters<typeof deliverToAgent>[0]['herdrBridge'] = crabcast;

/**
 * `daemon.ts` wires whatever `createAgentRuntime` returns, so the switch's own
 * return type is a wiring site too — and the one that would break first if the
 * CrabCast branch ever stopped satisfying the interface.
 */
import type { createAgentRuntime } from '../src/runtime-switch.js';
export const crabcastAtSwitch: ReturnType<typeof createAgentRuntime>['runtime'] = crabcast;
