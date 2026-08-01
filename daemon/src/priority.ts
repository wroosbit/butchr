import { HerdrAgentStatus } from './herdr.js';

/**
 * Which work gets the machine when there is not enough machine.
 *
 * KAN-36 gave the cap a number and a legible refusal. What it could not do is
 * choose: at capacity every activation was refused identically, so a board
 * manager that needed to start could not, and the person asking was left to
 * work out for themselves what to stand down. This file is the missing
 * comparison.
 *
 * WHERE PRIORITY COMES FROM
 *
 * The workspace *type*, not the Jira ticket. The ticket originally proposed
 * reading Jira's own Highest/High/Medium/Low/Lowest field; the human specified
 * otherwise, and the specification is better than the proposal for three
 * reasons worth writing down, because the alternative will be suggested again:
 *
 *   - No lookup. The type is resolved before activation — `registry.ts` hands
 *     back `{config, key}` — so priority is already in hand at the moment it is
 *     needed. Reading Jira would put a network call on the activation path for
 *     a question the daemon has already answered.
 *   - Both callers work. The sidepanel toggle cannot supply a Jira priority and
 *     the board manager can; a property of the type is available to both,
 *     identically, so there is no path that degrades.
 *   - Manager safety stops being a rule. `manage` is the top of the scale, so
 *     "never preempt the board manager" is not an exception anyone has to
 *     remember to code — it is what the ordering already says. See
 *     {@link outranks}.
 *
 * THE SCALE
 *
 * Three levels, ordered by what each type is to the others rather than by how
 * urgent any particular piece of work feels:
 *
 *   manage (3) supervises the fleet and hands work out.
 *   story  (2) decomposes a story into the tasks that task agents execute, so
 *              it is upstream of them: preempting a task to let a story run
 *              unblocks the thing that generates more work.
 *   task   (1) does the work.
 */

/** The board manager. Nothing outranks it, which is the whole of rule 3. */
export const PRIORITY_MANAGE = 3;
/** Story decomposition, upstream of the tasks it produces. */
export const PRIORITY_STORY = 2;
/** Ordinary work. The floor, and the common case. */
export const PRIORITY_TASK = 1;

/**
 * What an unregistered workspace type is worth.
 *
 * The floor, deliberately: a type this daemon has never heard of can be
 * preempted by anything and can preempt nothing. Whatever goes wrong with
 * resolution lands somewhere that cannot kill another agent's work, which is
 * the same degradation guarantee `DEFAULT_JIRA_WORKSPACE_TYPE` makes one layer
 * up.
 */
export const DEFAULT_WORKSPACE_PRIORITY = PRIORITY_TASK;

/**
 * Strictly greater, not greater-or-equal.
 *
 * Equal-priority preemption is churn in the general case — two agents at the
 * same level displacing each other indefinitely — but the argument is sharper
 * on this scale than on a five-level one. With three levels and one agent per
 * supervisory type in practice, *equal* is the normal case: two `task` agents
 * at priority 1 is what a full machine looks like here. Greater-or-equal would
 * therefore mean any task agent may kill any other task agent, making the
 * choice of victim arbitrary and every activation a coin toss over somebody's
 * uncommitted work.
 *
 * Strictly-greater makes task-versus-task always a refusal, which is the
 * honest answer: the machine is full of work exactly as important as yours.
 */
export function outranks(incoming: number, running: number): boolean {
  return incoming > running;
}

/**
 * How much an agent stands to lose by being stood down right now, lowest
 * first.
 *
 * The ticket guessed "least recently active" and gave the reason: an agent
 * mid-compile has more to lose than one idling. There is no last-active
 * timestamp anywhere in this daemon — but herdr already reports what each
 * agent is *doing*, which is the thing that proxy was reaching for, measured
 * rather than inferred.
 *
 *   done    — finished. There is nothing in flight to destroy.
 *   idle    — at a prompt with no turn to take.
 *   blocked — waiting on a human, so not computing, but mid-task.
 *   unknown — herdr has nothing to say; assume it is working.
 *   working — actively producing. Taken last.
 */
const STATUS_COST: Record<HerdrAgentStatus, number> = {
  done: 0,
  idle: 1,
  blocked: 2,
  unknown: 3,
  working: 4
};

/** One agent considered as something that could be stood down. */
export interface PreemptionCandidate {
  agentName: string;
  /** Null only for an agent whose name this daemon could not parse. */
  type: string | null;
  key: string;
  priority: number;
  /** herdr's own view of what it is doing, right now. */
  herdrStatus: HerdrAgentStatus;
  /** When the registry last recorded it activated; null when it has no record. */
  activatedAt: string | null;
}

/**
 * Victim ordering: the better victim sorts first.
 *
 * Lowest priority, then least to lose, then oldest, then name. The last two
 * terms exist for determinism rather than judgement — the same fleet must
 * always yield the same victim, or a refusal that names one agent and a
 * preemption that kills another would be the same request.
 *
 * An agent with no registry record sorts *last* among its equals. Knowing
 * least about something is a reason to be more careful with it, not less.
 */
export function compareVictims(a: PreemptionCandidate, b: PreemptionCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const cost = STATUS_COST[a.herdrStatus] - STATUS_COST[b.herdrStatus];
  if (cost !== 0) return cost;

  if (a.activatedAt !== b.activatedAt) {
    if (a.activatedAt === null) return 1;
    if (b.activatedAt === null) return -1;
    return a.activatedAt < b.activatedAt ? -1 : 1;
  }

  return a.agentName < b.agentName ? -1 : a.agentName > b.agentName ? 1 : 0;
}

/**
 * The agent that would be stood down to make room for `incoming`, or null when
 * there is nothing this activation outranks.
 *
 * Null is the ordinary answer, not an error: it is what a task agent gets on a
 * machine full of task agents, and what anything gets on a machine holding only
 * the board manager.
 */
export function selectVictim(
  candidates: PreemptionCandidate[],
  incoming: number
): PreemptionCandidate | null {
  const eligible = candidates.filter((c) => outranks(incoming, c.priority));
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareVictims)[0];
}

/** `task/KAN-99`, or just the key when the type could not be parsed. */
export function addressOf(candidate: PreemptionCandidate): string {
  return candidate.type ? `${candidate.type}/${candidate.key}` : candidate.key;
}

/** `task/KAN-99 (priority 1, idle)` — one candidate, for prose. */
export function describeCandidate(candidate: PreemptionCandidate): string {
  return `${addressOf(candidate)} (priority ${candidate.priority}, ${candidate.herdrStatus})`;
}

/**
 * What is running and what each one is worth.
 *
 * This is the refusal proof's requirement in one function: someone who has just
 * lost a slot must be able to see *why* they lost it, which means seeing what
 * beat them and by how much. Ordered as victims are, so the first name is the
 * one that would have gone had the caller outranked it.
 */
export function describeFleetPriorities(candidates: PreemptionCandidate[]): string {
  if (candidates.length === 0) return 'nothing is running that could be stood down';
  return [...candidates].sort(compareVictims).map(describeCandidate).join(', ');
}

/**
 * Why an activation that could have preempted was refused anyway.
 *
 * Preemption is opt-in per activation, which is the same principle as KAN-36's
 * visible refusal: someone toggling an agent on must not silently destroy
 * another's work. So this is what the caller gets *instead* of a kill — the
 * name of what would die, what it is doing, and the flag that authorises it.
 */
export function preemptionOffer(victim: PreemptionCandidate, incoming: number): string {
  return (
    `Standing down ${describeCandidate(victim)} would make room: this activation is ` +
    `priority ${incoming}, which outranks it. That is not done automatically — ` +
    `pass preempt: true to authorise it, and its uncommitted work is interrupted. ` +
    `It can be re-activated later and will resume the conversation it was stopped in.`
  );
}

/** Why nothing could be stood down for this activation. */
export function noVictimReason(candidates: PreemptionCandidate[], incoming: number): string {
  return (
    `Nothing running is below priority ${incoming}, so there is nothing this ` +
    `activation may stand down. Running: ${describeFleetPriorities(candidates)}. ` +
    `Preemption is strictly-greater: an agent may not displace one of its own ` +
    `priority.`
  );
}
