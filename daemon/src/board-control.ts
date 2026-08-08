import {
  BoardMode,
  BOARD_CYCLE_MS,
  RunningAgent,
  boardWorkspaceTypes,
  inJurisdiction,
  renderedKey
} from './board-reconcile.js';

/**
 * ---------------------------------------------------------------------------
 * What the Agents page has to know before its Off button can tell the truth.
 * ---------------------------------------------------------------------------
 *
 * KAN-221 made the board the store of desired state, and that turned the
 * extension's Off button into a control whose effect depends on something the
 * extension cannot see. Press Off on a board-controlled agent while the
 * reconciler is converging and the agent stops — and comes back within a cycle,
 * because the board still says In Progress and the daemon holds no write scope
 * with which to change that (KAN-39 invariant 2). The button did something
 * visible, the thing it did was undone, and nothing told anybody why.
 *
 * KAN-222's whole subject is that gap. This module is the half of the fix that
 * has to live in the daemon, and it exists for one reason: **the extension must
 * not work any of this out for itself.**
 *
 * WHY THE EXTENSION IS NOT ALLOWED TO COMPUTE THIS
 *
 * Everything the UI needs is derivable in the browser — the mode is an env var,
 * jurisdiction is a workspace type and a key-shaped regex — and deriving it
 * there is precisely the defect KAN-107 exists to remove, one layer up. A copy
 * of `inJurisdiction` in a `.jsx` file is a second store of the same truth, and
 * it drifts silently: add a Bug workspace type to the issue-type table and the
 * loop starts controlling `task/KAN-N` agents from Bug tickets while the UI
 * goes on telling their owners that Off will stick. The wrong answer would be
 * delivered confidently, by a component whose entire purpose is not doing that.
 *
 * So the two facts are computed **here**, from the reconciler's own exports,
 * and shipped on the poll the page is already making. `boardWorkspaceTypes()`
 * and `inJurisdiction()` are imported rather than reimplemented for the same
 * reason `boardWorkspaceTypes` derives itself from the issue-type table rather
 * than listing types: the copy is the bug.
 *
 * WHY IT REPORTS THE MODE RATHER THAN A BOOLEAN
 *
 * Because "the board controls this agent" is false on a stock machine, and a UI
 * that said it would be committing this ticket's own defect while fixing it.
 * `BUTCHR_BOARD_RECONCILE` defaults to `report`: the loop computes the diff,
 * logs it, and changes nothing. Off is completely durable in `report` and in
 * `off`, and temporary only in `converge`. Those are three different sentences
 * for the user, not three shades of one, so the mode travels intact and the
 * wording is chosen from it — see boardControl.js in the extension.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY
 *
 * Whether the board *currently* wants a given agent running. That would need
 * the last cycle's diff, and it is not needed: the question the confirmation
 * answers is "what happens if I press this", and mode plus jurisdiction settle
 * it completely. Naming the condition — In Progress or In Review, and assigned
 * to this machine's account — is both honest and more useful than a stale
 * yes/no, because it is also the instruction for how to make Off stick. A
 * cached answer from up to a minute ago would be a fact the user could not act
 * on, dressed as one they could.
 */

/** The board's grip on the fleet, as one poll of the Agents page sees it. */
export interface BoardControlReport {
  /**
   * What the loop is allowed to do — `off`, `report` or `converge`.
   *
   * Read fresh on every poll rather than captured at boot, matching
   * `BoardReconciler.readMode`: the mode is a property of the environment the
   * daemon is running in, and a page showing a value from process start would
   * be stale in exactly the case that matters.
   */
  mode: BoardMode;
  /**
   * Seconds between cycles, so the page can say how long "again" is without
   * keeping its own copy of the interval.
   */
  cycleSeconds: number;
  /** The workspace types a Jira issue search is capable of describing. */
  jurisdictionTypes: string[];
  /**
   * The agents this loop is entitled to an opinion about: agent name → the key
   * as the board spells it.
   *
   * One map rather than a per-row flag because the page holds four separate
   * lists of agents — running, missing, preempted, stood down — and every one
   * of them has a control on it that the board can undo. One membership test
   * against one map is what keeps those four surfaces from answering the
   * question four ways.
   *
   * **The value is a key, not a boolean, because the UI has to name a ticket
   * and cannot spell it.** An agent *name* is built from a lower-cased key, so
   * a running agent read back out of a pane census is `kan-222` — and a
   * confirmation that says "move kan-222 out of those statuses" is naming
   * something that does not exist on the board. The rendered proof caught this
   * saying `kan-222` before it was fixed.
   *
   * **The spelling comes from the jurisdiction test, not from a lookup
   * (KAN-225).** The first version of this asked the router for the durable
   * registry's spelling and fell back to the agent's own key when there was no
   * record — and that fallback was the defect, because the agent that has no
   * record is precisely the one whose key is a pane spelling: a `sessionless`
   * herdr agent that outlived this daemon, or one it never started. It reached a
   * human as `kan-500` and named no ticket on any board.
   *
   * There is nothing to look up. `inJurisdiction` decides membership on
   * `key.trim().toUpperCase()` against a Jira-key regex, so **everything that
   * survives the filter below is, upper-cased, exactly how Jira spells a key.**
   * Reporting the string the test accepted is not a tidy-up; it removes a
   * disagreement between what was judged and what was printed, and the fallback
   * disappears rather than being corrected.
   */
  controlled: Record<string, string>;
}

/** An agent from any of the page's lists: enough to place it in jurisdiction. */
export interface AddressableAgent {
  agentName: string;
  type: string | null;
  key: string;
}

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
export function boardControlReport(
  mode: BoardMode,
  agents: AddressableAgent[]
): BoardControlReport {
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
    controlled: Object.fromEntries(
      agents
        .filter((agent) => inJurisdiction(agent as RunningAgent, types))
        .map((agent) => [agent.agentName, renderedKey(agent.key)])
    )
  };
}
