// Was this agent tree doing anything? — the activity classifier that
// agent-cost.ts asks for and deliberately does not supply (KAN-368).
//
// WHY THE VERDICT COMES FROM HERDR AND NOT FROM /proc
//
// The measurement being taken is "cores per working agent". A classifier that
// decided working-ness *from* cores would be selecting on the quantity being
// averaged, and the result could not fail: pick any threshold and the trees
// above it average above it. So the verdict has to come from an instrument that
// does not read /proc at all, and herdr's `agent_status` is exactly that — it is
// a reading of the agent's terminal, taken by a process that knows nothing about
// the cost model.
//
// The independence is what makes disagreement informative, and KAN-368's finding
// is a disagreement: six trees herdr called `working` spent 0.034–0.061 core
// each. Had the classifier been a CPU threshold, that sentence could not have
// been written down.
//
// THE AGREEING-ENDPOINTS RULE, WHICH IS THE PART THAT IS EASY TO GET WRONG
//
// A status is an instant and a measurement is a window. An agent that was
// `working` when the window opened and `done` when it closed was working for
// *some* of it, and charging its whole window's cores to the working population
// would understate what working costs by however much of the window it spent at
// its prompt. There is no way to recover the split from two endpoints, so the
// honest answer is that this tree establishes nothing: both ends must agree, and
// a tree that changed is `unknown` rather than being rounded to whichever end
// was read last.
//
// That is why `unknown` is a distinct arm rather than a synonym for
// `not-working`. A tree that changed mid-window is not idle; it is unmeasurable
// by this instrument, and those are different claims about the fleet.
//
// WHAT COUNTS AS WORKING
//
// Only herdr's `working`. `idle`, `done` and `blocked` are all an agent sitting
// at its prompt — `blocked` is waiting on a human (nudge.ts reads it that way),
// `done` is finished, and neither is spending CPU on anybody's behalf. herdr's
// own `unknown` is the absence of a reading and stays `unknown` here.

import { execFileSync } from 'child_process';

/** herdr's name for a workspace, the same string agentNameFor() builds. */
export function herdrNameFor(workspaceType, workspaceKey) {
  return `butchr-${workspaceType}-${String(workspaceKey ?? '').toLowerCase()}`;
}

/**
 * `Map<agentName, agent_status>` from `herdr agent list`.
 *
 * Throws rather than returning an empty map when herdr cannot be reached: an
 * empty map classifies every tree `unknown`, which would silently produce a
 * reading whose working population is empty and whose report says only that no
 * tree was working. That reads as a fact about the fleet and would be a fact
 * about the classifier — precisely the confusion this module's three-arm return
 * type exists to prevent, so it is refused loudly at the source instead.
 */
export function readHerdrStatuses() {
  const raw = execFileSync('herdr', ['agent', 'list'], { encoding: 'utf8', timeout: 15000 });
  const parsed = JSON.parse(raw);
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) {
    throw new Error('`herdr agent list` returned no agents array; refusing to classify activity');
  }
  const statuses = new Map();
  for (const agent of agents) {
    if (typeof agent?.name === 'string' && agent.name) {
      statuses.set(agent.name, typeof agent.agent_status === 'string' ? agent.agent_status : 'unknown');
    }
  }
  return statuses;
}

/**
 * An `ActivityOf` over two status readings taken at the ends of the window.
 *
 * Pure, and exported separately from {@link readHerdrStatuses} so a proof can
 * drive the agreeing-endpoints rule from two hand-written maps with no herdr,
 * no fleet and no machine — the same reason agent-cost.ts's aggregateTrees is
 * pure. CI has no agents on it, and a rule that could only be tested against a
 * live fleet would assert nothing there.
 */
export function activityClassifier(before, after) {
  return (workspaceType, workspaceKey) => {
    const name = herdrNameFor(workspaceType, workspaceKey);
    const start = before.get(name);
    const end = after.get(name);
    // Absent at either end: started or finished inside the window, so the same
    // partial-window objection as a changed status applies.
    if (start === undefined || end === undefined) return 'unknown';
    if (start !== end) return 'unknown';
    if (start === 'working') return 'working';
    if (start === 'idle' || start === 'done' || start === 'blocked') return 'not-working';
    return 'unknown';
  };
}
