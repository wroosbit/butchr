/**
 * What the board will do to an agent after you press the button.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DECIDES NOTHING
 *
 * KAN-221 made Jira the store of desired state. On a machine where that loop is
 * converging, the Agents page's Off button stops an agent that comes back
 * within a cycle — because the board still says In Progress, and the daemon
 * holds no write scope with which to change that and never will (KAN-39,
 * invariant 2). KAN-222 is the ticket for that gap, and its instruction was
 * "either it moves out of the way, or it says plainly that the board controls
 * this now. Pick one and make it honest."
 *
 * **The button stays and says so**, and the reasoning is worth keeping next to
 * the words because the other choice was defensible:
 *
 *   - Off is *completely truthful today* on a stock machine. The reconciler
 *     ships report-only; `converge` is opt-in. Removing a control that is
 *     honest in two of its three modes, to fix the third, would take the escape
 *     hatch away from every machine that never turns convergence on.
 *   - Even under `converge`, Off does something real and sometimes wanted:
 *     it stops the agent *now*. An agent burning tokens in a loop should be
 *     stoppable in the second you notice, and the ticket moved afterwards.
 *     What was missing was never the effect — it was being told the effect is
 *     temporary, and what to do instead.
 *   - AgentOffControl already refuses to guess: it goes and looks at the
 *     workspace, and renders "could not look" differently from "nothing to
 *     lose". This is that same instinct pointed at a second question, which is
 *     the ticket's own framing — extend the honesty, do not replace the button.
 *
 * WHY NOTHING HERE IS COMPUTED FROM THE AGENT ITSELF
 *
 * Jurisdiction — whether this loop is entitled to an opinion about an agent —
 * is a workspace type and a key shape, and it would be four lines to work out
 * here. Those four lines would be a second copy of the daemon's rule, and it
 * would drift: the daemon derives the type set from the Jira issue-type table
 * precisely so that adding a Bug type cannot leave a stale list behind, and a
 * copy in the extension would be exactly that stale list. So `controlled`
 * arrives from the daemon per agent name and this file only *reads* it.
 *
 * The same goes for the mode. It is not "is the board in charge, yes or no" —
 * it is three states, and the difference between them is the difference between
 * three different true sentences. `report` is the default, and a UI that
 * announced "the board controls this now" on a default install would be
 * committing this ticket's defect in the course of fixing it.
 *
 * WHY A MISSING FIELD PRODUCES SILENCE
 *
 * A daemon with no reconciler behind it omits `boardControl` entirely, and this
 * returns null: the page then says nothing about the board, which is exactly
 * right, because there is nothing to say. "This daemon has no reconciler" and
 * "the reconciler will not touch this agent" are different facts that happen to
 * license the same button behaviour, and only the second is a claim about the
 * board. Defaulting the absent case to either sentence would be inventing one.
 */

/**
 * Read the board's grip on one agent.
 *
 * @param boardControl the `boardControl` block from `list_agents_response`, or
 *   null/undefined on a daemon that does not have a reconciler.
 * @param agent anything carrying `agentName` and `key`.
 * @returns null when there is nothing truthful to say, otherwise a description
 *   whose `reversible` field is the single fact every caller actually branches
 *   on: whether the board will undo what this button does.
 */
export function describeBoardControl(boardControl, agent) {
  if (!boardControl || !agent) return null;
  const { mode, cycleSeconds, controlled } = boardControl;
  if (mode !== 'off' && mode !== 'report' && mode !== 'converge') return null;

  // `controlled` maps agent name → the key as the board spells it. Membership
  // is the jurisdiction test; the value is what the sentences name.
  const boardKey = controlled && typeof controlled === 'object' ? controlled[agent.agentName] : undefined;
  const inJurisdiction = boardKey !== undefined;

  // The daemon's spelling wins, because it is the one that matches the ticket.
  // A running agent's own `key` comes out of a pane name and is lower-cased, so
  // telling somebody to move `kan-222` would name a ticket the board does not
  // have. The fallback only ever applies outside jurisdiction, where no
  // sentence names a ticket anyway.
  const ticket = boardKey ?? agent.key;

  // "About" a minute, from the daemon's own interval rather than a copy of it
  // here. A cycle can also be one cycle-length late, because the next one is
  // scheduled when the previous finishes — so this is deliberately the
  // approximate word the daemon's own log uses, not a promise of a deadline.
  const soon = Number.isFinite(cycleSeconds) ? `about ${cycleSeconds} seconds` : 'about a minute';

  // The condition the loop actually applies, named rather than summarised.
  // Both halves matter and the second is the one that surprises people: the
  // query is `assignee = currentUser() AND status IN (...)`, so an In Progress
  // ticket with no assignee is invisible to it. That exact case was live on
  // this board on 2026-08-08 (KAN-221), and a user who moved a ticket to In
  // Progress and saw nothing happen would have no way to guess why.
  const wanted =
    `${ticket} is In Progress or In Review and assigned to this machine's Jira account`;

  return {
    mode,
    controlled: inJurisdiction,
    cycleSeconds,
    /** Whether the board will undo this button within a cycle. */
    reversible: inJurisdiction && mode === 'converge',
    offNote: offNote({ mode, inJurisdiction, agent, ticket, soon, wanted }),
    onNote: onNote({ mode, inJurisdiction, agent, ticket, soon, wanted })
  };
}

/**
 * A note is three fields rather than one marked-up string.
 *
 * `lead` is the claim, `body` explains it, `action` is what the reader must do
 * instead — and the split is structural rather than cosmetic. Every one of
 * these sentences has that shape, the renderer emphasises the first and last
 * without interpreting anything, and the alternative was a mini-markdown parser
 * living in a UI package to bold two spans. `action` is null wherever there is
 * nothing for the reader to do, which is every case where the button already
 * does what it says.
 */
function note(lead, body, action = null) {
  return { lead, body, action };
}

function offNote({ mode, inJurisdiction, agent, ticket, soon, wanted }) {
  if (!inJurisdiction) {
    return note(
      'Off will stick.',
      `The board reconciler has no opinion about ${agent.type}/${agent.key} in any mode: a Jira ` +
      `issue search can never return it, and "the board did not mention you" is not "the board ` +
      `wants you off".`
    );
  }

  if (mode === 'off') {
    return note(
      'Off will stick.',
      `The board reconciler is switched off on this machine, so nothing will start ${ticket} ` +
      `again on its own.`
    );
  }

  if (mode === 'report') {
    return note(
      'Off will stick.',
      `The board reconciler is in report-only mode on this machine: every cycle it works out ` +
      `what the board wants, writes that to the log, and starts and stops nothing. If this ` +
      `machine is ever switched to converge, Off on this agent stops being permanent.`
    );
  }

  // converge — the case this ticket was filed for.
  return note(
    'Stopping this will not keep it stopped.',
    `The board decides what runs here. Within ${soon} the reconciler re-reads Jira, and if ` +
    `${wanted}, it will be started again — or retried each cycle until the machine has room ` +
    `for it.`,
    `To keep it off, move ${ticket} out of those statuses. That is the only switch this ` +
    `daemon honours: it has no write access to Jira and cannot move the ticket for you.`
  );
}

function onNote({ mode, inJurisdiction, agent, ticket, soon, wanted }) {
  // The mirror image, and it is a real hazard rather than a symmetry exercise:
  // under `converge`, starting an agent whose ticket is not In Progress or In
  // Review buys about a minute of work that is then stood down, and the
  // conversation ends wherever the stand-down caught it. A page that warned
  // about one direction and not the other would have fixed half a lie.
  //
  // Silent in `report` and `off` for the same reason the Off note is reassuring
  // in them: the board changes nothing there, so On is already the whole truth
  // and a note would be noise attached to a working button.
  if (!inJurisdiction || mode !== 'converge') return null;

  return note(
    'Starting this will not keep it started.',
    `Within ${soon} the reconciler re-reads Jira, and unless ${wanted}, it will be stood down ` +
    `again.`,
    `To keep it on, move ${ticket} into one of those statuses.`
  );
}
