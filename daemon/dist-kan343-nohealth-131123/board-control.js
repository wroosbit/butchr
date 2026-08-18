import { BOARD_CYCLE_MS, boardWorkspaceTypes, inJurisdiction, renderedKey } from './board-reconcile.js';
/**
 * Build the report for one poll.
 *
 * Pure, and takes the mode as an argument rather than reading the environment,
 * so that a proof can drive all three modes without setting process state — and
 * so that this module has no opinion about where the mode comes from. The
 * daemon passes `boardReconcileMode`, the same function the reconciler itself
 * is constructed with, which is what makes the page's answer and the loop's
 * behaviour the same fact rather than two readings of one env var.
 */
export function boardControlReport(mode, agents, health = null) {
    const types = boardWorkspaceTypes();
    return {
        mode,
        cycleSeconds: Math.round(BOARD_CYCLE_MS / 1000),
        jurisdictionTypes: [...types],
        // `renderedKey` rather than `agent.key`, and it is the same helper
        // board-reconcile.ts's `address()` renders its log lines through — one rule,
        // two callers, so the daemon log and this page cannot name one agent two
        // ways (KAN-225). On this path the helper's Jira-shape guard is redundant,
        // because `inJurisdiction` has already applied it; on `address()`'s path it
        // is load-bearing. See the helper for why it is written for that caller.
        controlled: Object.fromEntries(agents
            .filter((agent) => inJurisdiction(agent, types))
            .map((agent) => [agent.agentName, renderedKey(agent.key)]))
    };
}
