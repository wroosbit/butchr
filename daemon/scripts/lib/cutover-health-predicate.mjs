// The cutover watchdog's health predicate, as a pure function of one
// `list_agents` frame (KAN-481).
//
// It lives here, apart from both the prober that feeds it and the proof that
// exercises it, so that the thing shipped and the thing tested are the same
// expression. The defect this replaces was not a coding mistake; it was a
// predicate nobody could run against a control, because it only existed inside
// a shell pipeline that had to be mid-cutover to evaluate.
//
// NODE BUILTINS ONLY, AND NOT EVEN THOSE. No imports at all, no `dist`, no
// `node_modules`. This runs on the worst day, on a checkout nobody installed,
// beside `probe-cutover-readiness.mjs` which makes the same promise for the
// same reason.

/**
 * ## What the old predicate was, and why both of its terms were wrong
 *
 * `watchdog.sh` tripped on:
 *
 *     agents > 0 && (noSession >= agents || noUrl >= agents)
 *
 * Both terms are proxies for one event — the 2026-08-12 flip, where every
 * agent came back `sessionless: true, sessionId: null, url: null` and nobody
 * could drive any of them. Both proxies are satisfied by a **healthy plain
 * herdr fleet**, which is what made the trip carry no information:
 *
 *   - `noUrl >= agents` — `url` is the Jira link **passed into** the
 *     activation. It is optional provenance, it is deliberately never derived
 *     from the key (`daemon.ts`: *"a fabricated link is worse than no link"*),
 *     and the board reconciler — which starts most of this fleet — passes none
 *     at all, on purpose. So this term measures *"was every agent started
 *     without somebody handing it a link"*, which is a fact about the caller
 *     and not about the agent. Measured on the durable registry 2026-08-15: 58
 *     of 75 distinct agents have no url recorded, and url-less has been the
 *     majority every day since the registry began.
 *   - `noSession >= agents` — a **daemon** restart empties the session table
 *     while herdr keeps every pane. All-sessionless is therefore the ordinary
 *     state of a healthy herdr fleet whose daemon has just come back, and it
 *     is recorded as such four times in `cutover.log`'s own pre-flip
 *     snapshots. The ticket found the `url` term; this one is the same defect
 *     one field over, and deleting only the first would have left it.
 *
 * ## What replaces them, and why it is a re-derivation rather than a deletion
 *
 * KAN-481 is explicit that the term must not simply go: it is the only thing
 * watching for *agents present but unreachable*, which is what actually went
 * wrong on 2026-08-12. So the replacement measures **that**, directly, instead
 * of two things that used to correlate with it:
 *
 *     an agent is REACHABLE if a steer sent to it right now would arrive.
 *
 * Two routes, and a steer takes one or the other:
 *
 *   1. **`sessionId`** — this daemon holds the agent's pty attach, so a
 *      composer send has a terminal to type into.
 *   2. **`channel.transport === 'channel'`** — a live channel registration, so
 *      a steer is delivered into its context without our pty being involved.
 *      `'unregistered'` is explicitly a refusal and counts as neither.
 *
 * **`herdrStatus` is deliberately NOT a third route.** It is present on every
 * row including the sessionless ones, so a disjunct reading it could never be
 * false — the predicate would go green forever while appearing to check
 * something. That is the failure mode this ticket exists to punish, and it was
 * considered and rejected here rather than never noticed.
 *
 * ## The margin, stated because the last one was implicit and got eaten
 *
 * The old margin was *"EVERY agent must lack a url"*, written nowhere, and a
 * separate change consumed all of it without anybody being able to see it
 * shrink. This one is named, returned on every poll, and has two independent
 * components:
 *
 *   - **`marginAgents`** — how many reachable agents stand between the fleet
 *     and a trip. It equals `reachable`, because the trip needs `reachable`
 *     to hit zero. A fleet of nine with one reachable agent is one agent from
 *     tripping and says so.
 *   - **`marginPolls`** — the watchdog additionally requires that state to
 *     hold for `FAIL_LIMIT` consecutive polls, so bring-up transients do not
 *     trip it. This function does not know the caller's limit; the prober
 *     reports it alongside.
 *
 * Both are on the returned object so a reader watching the log can see the
 * margin move rather than discovering after the fact that it was gone.
 *
 * @param {Array<object>} agents `list_agents`' own `agents` array.
 * @returns {{agents:number, reachable:number, unreachable:number,
 *   marginAgents:number, unhealthy:boolean, bySession:number, byChannel:number,
 *   unreachableAgents:string[]}}
 */
export function fleetHealth(agents) {
  const rows = Array.isArray(agents) ? agents : [];

  let bySession = 0;
  let byChannel = 0;
  const unreachableAgents = [];

  for (const row of rows) {
    const hasSession = typeof row?.sessionId === 'string' && row.sessionId.length > 0;
    const hasChannel = row?.channel?.transport === 'channel';

    if (hasSession) bySession++;
    if (hasChannel) byChannel++;

    if (!hasSession && !hasChannel) {
      unreachableAgents.push(
        typeof row?.agentName === 'string' && row.agentName
          ? row.agentName
          : `${row?.type ?? '?'}/${row?.key ?? '?'}`
      );
    }
  }

  const total = rows.length;
  const unreachable = unreachableAgents.length;
  const reachable = total - unreachable;

  return {
    agents: total,
    reachable,
    unreachable,
    // The margin IS the reachable count: the trip needs it to reach zero.
    // Returned under its own name anyway, because "reachable: 1" and "you are
    // one agent from a rollback" are the same number read by different people.
    marginAgents: reachable,
    // An empty fleet is NOT unhealthy. There is nothing to be unreachable, and
    // a watchdog that rolled back because the drain worked would be a rollback
    // caused by the cutover succeeding. `cutover.log` carries four `agents: 0`
    // readings taken straight after a rollback restart for exactly this reason.
    unhealthy: total > 0 && reachable === 0,
    bySession,
    byChannel,
    unreachableAgents
  };
}

/**
 * The old predicate, kept so the proof can demonstrate the difference on the
 * same recorded frames rather than asserting it.
 *
 * It is exported for `verify-cutover-health-predicate.mjs` and has no other
 * caller. Do not wire it to anything: it is here as the thing being replaced,
 * and §1 of that proof runs it against plain-herdr controls and watches it go
 * red, which is the whole evidence that the replacement was needed.
 *
 * @param {{agents:number, noSession:number, noUrl:number}} counts
 */
export function retiredPredicate(counts) {
  const agents = counts?.agents ?? 0;
  const noSession = counts?.noSession ?? 0;
  const noUrl = counts?.noUrl ?? 0;
  return agents > 0 && (noSession >= agents || noUrl >= agents);
}

/**
 * The counts the retired predicate read, computed off a frame, so a recorded
 * `butchr_health` line and a live `list_agents` frame can be compared on
 * equal terms.
 *
 * @param {Array<object>} agents
 */
export function retiredCounts(agents) {
  const rows = Array.isArray(agents) ? agents : [];
  return {
    agents: rows.length,
    sessionless: rows.filter((a) => a?.sessionless === true).length,
    noSession: rows.filter((a) => !a?.sessionId).length,
    noUrl: rows.filter((a) => !a?.url).length
  };
}
