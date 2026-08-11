/**
 * What the board page says about the guardian, and why identity is never enough.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE COMPONENT THAT RENDERS IT
 *
 * Same split, and the same reason, as `boardControl.js`: this decides *which
 * true sentence* and the component decides *how loud*. Keeping the sentences out
 * of JSX is what lets `render-guardian-panel.mjs` drive every state without a
 * browser, and it is what stops a fifth state being added as an extra `? :` in a
 * template where nobody can see the set.
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT THIS FILE IS ACTUALLY FOR (KAN-284, AC3 and AC5)
 * ---------------------------------------------------------------------------
 *
 * From the ticket, twice, in the human's terms and then in `epic/KAN-39`'s:
 *
 *   > **"Guardian: epic/KAN-203" and "Guardian: epic/KAN-203 — last poke landed
 *   > 4 hours ago" must not render the same**, or the display becomes the
 *   > reassurance that hides the failure it exists to reveal.
 *
 * So **identity is not a state**. A renderer handed only a name has no way to
 * make that distinction, which is why `tone` below is derived from delivery and
 * never from whether an address exists. There are five states and the loudest
 * two are the ones nobody would think to design for:
 *
 *   `none`      no guardian is configured. **Nothing is watching the fleet on a
 *               timer.** This is the default state of a fresh install and it is
 *               the quietest possible failure, so it is rendered as the loudest.
 *   `overdue`   a guardian is named and pokes are not landing. The fleet is
 *               unsupervised and the name at the top of the panel is, on its
 *               own, a lie of exactly the kind the ticket names.
 *   `slipping`  a poke landed recently but some since have not. Not yet an
 *               alarm; worth seeing before it becomes one.
 *   `waiting`   no poke has been sent yet on this daemon. Nothing is known —
 *               and "nothing is known" is not "everything is fine".
 *   `landing`   the ordinary state: the last poke reached a connection.
 *
 * ---------------------------------------------------------------------------
 * AND THE LIMIT IS RENDERED, NOT COMMENTED
 * ---------------------------------------------------------------------------
 *
 * Even `landing` carries `proves` — the daemon's own sentence, passed through
 * **verbatim** rather than paraphrased here:
 *
 *   > A heartbeat proves the loop turns; it says nothing about whether its
 *   > decisions are right.
 *
 * That sentence is `epic/KAN-39`'s objection to this whole feature, and the
 * board is the one surface where the overclaim would actually be made — a green
 * tick reading "Guardian: epic/KAN-203" invites precisely the inference it
 * cannot support. It is carried as data from `guardian.ts` (`provesDetail`) so
 * that there is one copy of it, in the module that knows what it measured. A
 * paraphrase here would be a second copy, and it would be the one that softened.
 */

/** How long ago, in words a human reads at a glance. */
function ago(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** `epic/KAN-203`, or null when there is no guardian to name. */
export function guardianName(address) {
  if (!address || typeof address.type !== 'string' || typeof address.key !== 'string') return null;
  return `${address.type}/${address.key}`;
}

/**
 * Read the guardian block into something a renderer can show.
 *
 * @param guardian the `guardian` block from `status_response`, or null when the
 *   page is not a board or the daemon has no guardian mechanism. Those two are
 *   the same rendering decision — say nothing — and this returns null for both.
 * @returns null when there is nothing to say, otherwise `{ tone, headline,
 *   name, detail, proves, action }`. `tone` is the single field a component
 *   branches on, and it is derived from **delivery**, never from identity.
 */
export function describeGuardian(guardian) {
  if (!guardian || typeof guardian !== 'object') return null;

  const name = guardianName(guardian.address);
  // The daemon's own sentence about what its record proves, carried through
  // untouched. Defaulted only so an older daemon that predates the field cannot
  // render an empty space where the limit should be — a missing caveat is worse
  // than a stale one, because it reads as no caveat.
  const proves =
    typeof guardian.provesDetail === 'string' && guardian.provesDetail
      ? guardian.provesDetail
      : 'This records whether the poke was delivered, not whether the fleet is being supervised.';

  // NO GUARDIAN AT ALL — the quietest failure, rendered loudest. A fresh install
  // is in this state, and so is a fleet whose guardian was cleared and never
  // replaced; from the board those look identical and both mean the same thing.
  if (!guardian.configured || !name) {
    return {
      tone: 'alarm',
      state: 'none',
      name: null,
      headline: 'No guardian is set',
      detail:
        'Nothing is watching this fleet on a timer. That is the default state rather than a ' +
        'fault — and it is the state in which the board goes quiet without anybody being told.',
      action: 'Set one from the Butchr options page, or with butchr_guardian from an agent.',
      proves
    };
  }

  const since = ago(guardian.sinceLastDeliveryMs);
  const everyMinutes = Math.round((guardian.intervalMs ?? 0) / 60000) || null;
  const lastReason = guardian.lastPoke?.reason ?? null;

  // POKES ARE NOT LANDING. The name is still true and is now the least
  // interesting fact on the panel, so the headline leads with the reachability
  // and the name is demoted to context. This is the exact pair the ticket says
  // must not render the same.
  if (guardian.overdue) {
    return {
      tone: 'alarm',
      state: 'overdue',
      name,
      headline: `${name} is not being reached`,
      detail:
        (since
          ? `The last poke that landed was ${since}. `
          : 'No poke has ever been delivered to it on this daemon. ') +
        `${guardian.consecutiveUndelivered || 0} since then ` +
        `${guardian.consecutiveUndelivered === 1 ? 'has' : 'have'} not been delivered, so the ` +
        'guardian is not being asked to sweep and the fleet is unsupervised until one lands.' +
        (lastReason ? ` Last refusal: ${lastReason}.` : ''),
      action:
        `Check whether ${name} is running and what its transport is — butchr_list_agents shows ` +
        'both. A registration dropped by a daemon restart comes back by itself within seconds; ' +
        'an agent that is not running does not.',
      proves
    };
  }

  // NOTHING HAS BEEN TRIED YET. Distinct from `landing`, because "no evidence"
  // and "good evidence" are different answers and only one of them is
  // reassuring. A daemon restarted a minute ago is here.
  if (!guardian.lastDelivered) {
    return {
      tone: 'neutral',
      state: 'waiting',
      name,
      headline: `${name} is the guardian`,
      detail:
        (guardian.pokes
          ? `${guardian.pokes} poke(s) have been sent on this daemon and none has been ` +
            'delivered yet. '
          : 'No poke has been sent yet on this daemon — the first is minutes rather than one ' +
            'full interval after start-up. ') +
        'Nothing is yet known about whether it is reachable.' +
        (lastReason ? ` Last refusal: ${lastReason}.` : ''),
      action: null,
      proves
    };
  }

  // LANDING, BUT NOT EVERY TIME. Below the overdue threshold, so not an alarm —
  // and not silence either, because this is what `overdue` looks like on its way
  // to happening.
  if (guardian.consecutiveUndelivered > 0) {
    return {
      tone: 'caution',
      state: 'slipping',
      name,
      headline: `${name} is the guardian`,
      detail:
        `The last poke that landed was ${since}, but ${guardian.consecutiveUndelivered} since ` +
        `then ${guardian.consecutiveUndelivered === 1 ? 'has' : 'have'} not been delivered.` +
        (lastReason ? ` Last refusal: ${lastReason}.` : ''),
      action: null,
      proves
    };
  }

  // THE ORDINARY STATE. Still carries `proves`, and that is the point of this
  // whole file: the calm case is where the overclaim would be made.
  return {
    tone: 'calm',
    state: 'landing',
    name,
    headline: `${name} is the guardian`,
    detail:
      `Its last poke landed ${since}` +
      (everyMinutes ? `, on a ${everyMinutes}-minute timer.` : '.'),
    action: null,
    proves
  };
}
