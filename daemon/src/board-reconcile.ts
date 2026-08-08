import { JiraBoardIssue, JiraBoardOutcome, BOARD_MAX_RESULTS } from './jira.js';
import { agentNameFor } from './herdr.js';
import {
  workspaceTypeForJiraIssueTypeStrict,
  jiraIssueWorkspaceTypes
} from './integrations/atlassian-integration.js';

/**
 * ---------------------------------------------------------------------------
 * The board drives the fleet: one bounded JQL per cycle, then converge.
 * ---------------------------------------------------------------------------
 *
 * THE ALGORITHM, IN THE HUMAN'S OWN WORDS (KAN-107, 2026-08-06)
 *
 *   * Go through all tickets owned by the user
 *   * If the ticket is In Progress or In Review → that agent should be running
 *   * If it is not → that agent should be off
 *   * Anything running that is not in that list → off
 *
 * **Jira is the store of desired state. There is no second store.** That is the
 * whole design, and most of what follows is about the ways a loop like this can
 * quietly stop being that — by keeping its own idea of what should run, by
 * exempting favourites, by guessing at what it could not read.
 *
 * WHY THIS IS NOT reconcile.ts
 *
 * reconcile.ts converges the fleet against the **agent registry** — the durable
 * record of what this daemon started — and it runs once, at boot, to undo a
 * power cut. This converges the fleet against **the board**, and it runs
 * forever. The registry says what *was* started; the board says what *should
 * be*. They are different questions and the second one is not derivable from
 * the first, which is why this is a second file rather than an argument to the
 * first. What the two do share is the thing that makes either safe, and it is
 * the next section.
 *
 * THE ONE THING THAT IS NOT A BELL OR A WHISTLE: A FAILED READ CONVERGES
 * NOTHING
 *
 * A failed query and an empty board both produce an empty list, and steps 3 and
 * 4 turn an empty list into *stand the entire fleet down*. The Atlassian MCP
 * was unreachable for about two hours on 2026-08-04 (KAN-157); under a loop
 * that could not tell those apart, that outage would have destroyed every
 * running agent's context — every one of them unrecoverable, because an agent's
 * context does not survive its pane.
 *
 * So the read returns {@link JiraBoardOutcome}, a discriminated union, and this
 * module's first act every cycle is to check `ok`. There is no `issues` field
 * to read on the failure branch: a version of this file that forgot the check
 * does not compile. That is deliberate — the distinction is too important to
 * leave to a caller remembering it, which is what a boolean flag or a thrown
 * exception would have done.
 *
 * `waitForHerdr` (reconcile.ts) is the same guard, ten feet away, pointed at
 * herdr instead of at Jira: `listHerdrAgents` returns empty both when herdr has
 * no agents and when herdr could not be reached, and its comment says the
 * distinction *"matters enormously here, because 'herdr is not up yet' would
 * otherwise read as 'every agent is missing'"*. Same sentence, different
 * upstream. The fleet census this module reads gets the same treatment for the
 * same reason — see `refuse('fleet-unreadable')` below.
 *
 * WHY A PERIODIC CONVERGER BEATS AN EVENT-TRIGGERED ONE
 *
 * Carried in verbatim from KAN-107 (comment 10997), where it was written to be
 * lifted rather than re-derived. It is here because the named failure mode is
 * that this property gets lost the moment somebody describes this loop as "a
 * restart mechanism", and a module header is what a future reader actually
 * meets. The live evidence behind it is on KAN-107 comment 10996 (KAN-203).
 *
 * **Why a periodic converger beats an event-triggered one, and it is not "in
 * case we missed an event".**
 *
 * `reconcile.ts` restores the fleet when the _daemon_ restarts. That trigger was
 * never wrong — it was incomplete, and the missing case was undiscoverable by
 * inspection: on 2026-08-08 herdr restarted alone, took eight agents with it,
 * and nothing fired for seven hours because the daemon had been up throughout.
 * Both prior recoveries worked only because the power cuts restarted daemon and
 * herdr together.
 *
 * **This loop never asks why an agent is gone.** It asks what the board says
 * should be running and what is running, and converges the difference. An agent
 * missing after a herdr restart is just an agent missing. That is the property —
 * not extra coverage of a longer event list, but **needing no event list at
 * all** — and it is the reason this design replaces the other rather than
 * supplementing it.
 *
 * The corollary is the guard: because the loop trusts the difference between two
 * readings, a reading that did not happen must never be treated as a difference.
 * See the failed-read guard above; it is the same property from the other side.
 *
 * SUPERVISORS ARE NOT EXEMPT FROM STEP 4, AND THAT IS A DECISION (KAN-221)
 *
 * The question was asked explicitly and had to be answered rather than
 * inherited: an epic agent owns review and merge, and the loop's first cycle
 * reaches it like anything else. **The answer is no exemption.**
 *
 *   - An exemption *is* a second store of desired state. "These agents run
 *     regardless of what the board says" is a rule living in this file, and the
 *     entire point of the design is that no such rule exists anywhere.
 *   - The board can already express it, exactly and per-agent: an epic that
 *     should keep running keeps its ticket In Progress. That is not a
 *     workaround, it is the mechanism. All three epic tickets on this board
 *     were In Progress when this was written.
 *   - KAN-57's *"supervisors are never refused"* is about **refusing an
 *     activation** under a capacity gate — a rule about rationing scarce
 *     machine, which said nothing about intent and was never asked to. Step 4
 *     is not rationing; it is honouring stated intent. Transplanting a
 *     capacity rule into an intent decision would carry a conclusion away from
 *     the argument that earned it.
 *
 * What a supervisor *does* get is noise. {@link BoardReconciler} logs a
 * distinctly loud line when a stand-down target is a supervisor type, because
 * "the board just turned off the agent that reviews your PRs" is a thing a
 * human should be able to find in a log without knowing to look for it.
 * Visibility is not exemption, and it is the right amount of special-casing:
 * none in the behaviour, all of it in the reporting.
 *
 * JURISDICTION — WHAT THE QUERY COULD NOT HAVE ASKED ABOUT IS NOT ITS BUSINESS
 *
 * Step 4 says "anything running that is not in that list". Taken with no
 * bound, that includes a `confluence` agent, a `shell` workspace, and anything
 * else somebody starts — none of which a JQL over Jira issues can *ever*
 * return, however healthy Jira is. Standing those down would not be converging
 * toward the board; it would be reading "the board did not mention you" as "the
 * board wants you off", which is the failed-read confusion wearing a different
 * hat.
 *
 * So the loop's jurisdiction is exactly the set of agents this query is capable
 * of describing: a Jira-shaped key, and a workspace type the Jira issue-type
 * table can produce. Everything else is reported and left alone. The set is
 * derived from that table rather than written out here, so adding a Bug
 * workspace type later does not silently leave a second list behind.
 *
 * AN UNREADABLE TYPE PROTECTS, IT DOES NOT KILL
 *
 * A board row whose `issuetype` did not come through is an issue whose type
 * nobody knows. Two things follow, and only the first is obvious: no agent is
 * started for it (there is nothing to start), **and no agent on that key is
 * stood down either**. The alternative — "I could not tell what you should be,
 * so I am turning you off" — turns a missing field into a stand-down, which is
 * the same trade the guard above refuses at the level of the whole query.
 * Absent data stays absent, per row as well as per cycle.
 *
 * The type itself is never guessed. `workspaceTypeForJiraIssueTypeStrict` has
 * no fallback, deliberately; see its doc comment for KAN-196, the day a
 * URL-guessed type fell back to `task`, started `task/KAN-39` beside a live
 * `epic/KAN-39`, and the collision killed the epic agent's PTY. On a
 * sixty-second timer that is not an incident, it is a recurrence.
 *
 * CAPACITY IS NOT DESIRED STATE
 *
 * A desired-on agent that will not fit reports the binding constraint and is
 * tried again next cycle. It is not queued, not scheduled, not forced, and
 * nothing is preempted to make room for it — KAN-107 puts all three out of
 * scope by name, and this file contains no `override` and no `preempt` because
 * the absence is the guarantee. The refusal sentence is the capacity gate's own
 * (`capacityRefusal`, capacity.ts), reported verbatim rather than rewritten,
 * so the arithmetic that refused it travels with it (KAN-60).
 *
 * Convergence is level-triggered, so "try again next cycle" costs one line: the
 * next cycle re-reads the board and re-derives the same desire.
 *
 * STOP BEFORE START, AND WHY THAT IS NOT PREEMPTION
 *
 * Both halves are desired state. Everything in `toStop` is something the board
 * says should be off — not a sacrifice, not a victim, nothing anybody is
 * trading away for room. Doing the desired-off work first therefore costs
 * nothing and happens to release capacity, which is why a start that needs a
 * slot the board has already given up does not have to wait a cycle for it.
 * Reversing the order would be the same set of actions with a worse
 * interleaving; it would not be more careful.
 *
 * SELF-INFLICTED EVENTS
 *
 * Agents move their own tickets, so this loop's input is partly its own
 * children's writes: a task agent transitioning itself to In Review is a change
 * this loop then reads. Level-triggered convergence makes that a cycle that
 * finds nothing to do rather than a loop — the agent is running, the board says
 * it should be running, and the two agree.
 *
 * WHAT WAS OBSERVED ABOUT KAN-79's POLLER, WHICH IS NOT TOUCHED HERE
 *
 * Recorded rather than refactored, per KAN-107's out-of-scope list. Two timers
 * now read Jira on this daemon, for different questions:
 *
 *   - jira-poll.ts polls **per key**, over the issues of agents that are
 *     already live, to notice comments and status changes worth interrupting
 *     somebody about. Its unit is one issue; its output is a nudge.
 *   - this file runs **one search**, over the whole account, to decide what
 *     should be live at all. Its unit is the fleet; its output is an
 *     activation or a stand-down.
 *
 * They share a credential, a transport and a cadence (60s), and nothing else —
 * separate state, separate back-off, separate timeouts. The interaction worth
 * settling before both run in anger is ordering, not load: within a cycle this
 * loop can start an agent whose issue the poller then initialises silently on
 * its next tick, so the new agent is told nothing about the interval before it
 * existed. That is the poller's existing and intended behaviour for a newly
 * watched issue, and it is correct here too — an agent that has just started
 * reads its own ticket. The request cost is one search a minute added to a
 * budget the poller's own arithmetic put at roughly 25 GETs a minute.
 *
 * REPORT BEFORE ACT
 *
 * {@link BoardMode} defaults to `report`, and convergence is opt-in. This is a
 * requirement of KAN-221 rather than caution for its own sake: the first time
 * the spec's exact JQL was run against the real board, the result was missing a
 * ticket whose agent was running — KAN-107 was In Progress with no assignee, so
 * `assignee = currentUser()` could not see it, and step 4 would have stood down
 * the agent that filed this work. **An unassigned ticket with a running agent
 * is the board lying**, and under "Jira is the single store of desired state"
 * the fix is that the board must be true, not that the loop should tolerate a
 * board that is not. Report-only is how you find out which it is before it
 * costs somebody their context.
 */

/**
 * The spelling rule, which now lives in keys.ts.
 *
 * It was defined here until KAN-229 found a third surface that needs it —
 * nudge.ts, whose supervision notices name an agent the same way these log lines
 * do. The notifier importing this module to get it would have made the
 * supervision sweep depend on the reconciliation loop, jira.js and the Atlassian
 * integration for one regex, so the rule moved down to a module that depends on
 * nothing rather than sideways into a second copy.
 *
 * Re-exported because this is where the other surfaces already import it from,
 * and one helper reached by two paths is still one rule; two definitions would
 * not be. See keys.ts for why the guard is written to be safe for an unfiltered
 * caller.
 */
export { renderedKey } from './keys.js';
import { JIRA_KEY, renderedKey } from './keys.js';

/**
 * The query. `currentUser()` is the partition, and it is per machine: each
 * machine authenticates as its own Atlassian account, so a ticket assigned to
 * somebody else is not this fleet's business however it is statused.
 */
export const BOARD_JQL =
  'assignee = currentUser() AND status IN ("In Progress", "In Review")';

/**
 * How long between cycles.
 *
 * Sixty seconds, matching jira-poll.ts, and the acceptance criteria are written
 * against it — "within one cycle". The pacing argument is different from the
 * poller's, though: a poll tick interrupts running agents and is therefore
 * priced by what it costs them, while a cycle here usually does nothing at all
 * and costs one request. What sets the floor is the other side: this is how
 * long a human waits after dragging a card before anything happens, and a
 * minute is about the shortest interval at which nobody is tempted to go and
 * click something instead.
 */
export const BOARD_CYCLE_MS = 60_000;

/**
 * Gap between starts, for the reason RESTORE_STAGGER_MS gives in reconcile.ts:
 * each activation is a node process, an MCP server or two and a model
 * connection, and starting six at once is how convergence becomes the thing
 * that makes the machine unusable. Stand-downs are not staggered — releasing a
 * pane is cheap, and the sooner room is freed the better the starts behind it
 * go.
 */
export const START_STAGGER_MS = 3_000;

/**
 * What the loop is allowed to do.
 *
 *   - `off`      — do not even read the board.
 *   - `report`   — read, compute the diff, log it, change nothing. The default.
 *   - `converge` — act on the diff.
 *
 * Three states rather than a boolean because "not running" and "running and
 * deliberately not acting" are different things to find in a log, and the
 * second is the one this landed in.
 */
export type BoardMode = 'off' | 'report' | 'converge';

/** A running agent, as this loop needs to see one — from `surveyFleet`. */
export interface RunningAgent {
  agentName: string;
  type: string | null;
  key: string;
}

/** An agent the board says should be running. */
export interface DesiredAgent {
  agentName: string;
  /** The workspace type, resolved from the issue type. Never guessed. */
  type: string;
  /** The key as Jira spells it. */
  key: string;
  issueTypeName: string;
  statusName: string | null;
}

/** A board row this loop declined to act on, and why. */
export interface UnresolvedIssue {
  key: string;
  issueTypeName: string | null;
  reason: string;
}

/** Desired against running, with everything the loop deliberately left alone. */
export interface BoardDiff {
  /** Every issue the board wants, resolved to an agent. */
  desired: DesiredAgent[];
  toStart: DesiredAgent[];
  toStop: RunningAgent[];
  /** Running, wanted, and already in the right state. */
  unchanged: RunningAgent[];
  /** Board rows whose workspace type could not be established. */
  unresolved: UnresolvedIssue[];
  /** Running agents this query could never have described. */
  outOfJurisdiction: RunningAgent[];
  /** In jurisdiction and not wanted, but spared by an unresolved board row. */
  protectedByUnresolved: RunningAgent[];
}

export type BoardRefusalReason = 'mode-off' | 'jira-read-failed' | 'fleet-unreadable';

/** Why a cycle converged nothing. */
export interface BoardRefusal {
  reason: BoardRefusalReason;
  detail: string;
  /** Read failures only: whether Jira asked to be left alone. */
  backOff?: boolean;
}

export interface ActivateOutcome {
  success: boolean;
  error?: string;
  /** `capacity`, `integration-disabled`, … straight from the router. */
  refusedBy?: string;
}

export interface DeactivateOutcome {
  success: boolean;
  error?: string;
}

/** What one cycle did, so the daemon can log it and a proof can assert on it. */
export interface BoardCycle {
  mode: BoardMode;
  /** Null exactly when {@link refusal} is set: the loop could not see. */
  diff: BoardDiff | null;
  refusal: BoardRefusal | null;
  started: Array<{ agent: DesiredAgent; outcome: ActivateOutcome }>;
  stopped: Array<{ agent: RunningAgent; outcome: DeactivateOutcome }>;
  /** True only when the loop was in `converge` and had something to act on. */
  converged: boolean;
}

export interface BoardReconcilerOptions {
  /** Narrowed to one method so a proof can stub the board in a line. */
  jira: { searchBoard(jql: string, maxResults?: number): Promise<JiraBoardOutcome> };
  /** The running fleet, from `surveyFleet().agents` — agents, never panes. */
  runningAgents: () => RunningAgent[];
  activate: (agent: DesiredAgent) => Promise<ActivateOutcome>;
  deactivate: (agent: RunningAgent) => Promise<DeactivateOutcome>;
  /** Read every cycle, so the mode can change without a restart. */
  mode: () => BoardMode;
  log: (...args: any[]) => void;
  /** For the loud line on a supervisor stand-down. Reporting only. */
  isSupervisorType?: (type: string) => boolean;
  jql?: string;
  maxResults?: number;
  intervalMs?: number;
  startStaggerMs?: number;
}

/**
 * The set of workspace types a Jira board query can describe.
 *
 * Derived from the issue-type table rather than written out, so this cannot
 * drift from the mapping it is supposed to mirror.
 */
export function boardWorkspaceTypes(): Set<string> {
  return new Set(jiraIssueWorkspaceTypes());
}

/** Whether this loop is entitled to have an opinion about an agent at all. */
export function inJurisdiction(agent: RunningAgent, types: Set<string>): boolean {
  if (!agent.type || !types.has(agent.type)) return false;
  return JIRA_KEY.test(agent.key.trim().toUpperCase());
}

/**
 * Desired against running. Pure, and the whole of the algorithm's arithmetic.
 *
 * Agents are matched by **agent name**, which is `type` and `key` together —
 * never by key alone. KAN-83 is why: keys are shared across types by design, so
 * a key-only match makes `task/KAN-39` and `epic/KAN-39` the same agent, and a
 * loop using it would call a board that wants the epic satisfied by the task.
 * Matching on the full address is also what makes the KAN-196 cleanup fall out
 * for free: a `task/KAN-39` running against a board that says Epic is simply
 * not in the desired list, and goes.
 */
export function computeBoardDiff(
  issues: JiraBoardIssue[],
  running: RunningAgent[]
): BoardDiff {
  const types = boardWorkspaceTypes();

  const desired: DesiredAgent[] = [];
  const unresolved: UnresolvedIssue[] = [];
  /** Keys the board mentioned but could not be resolved — protected below. */
  const unresolvedKeys = new Set<string>();

  for (const issue of issues) {
    const key = issue.key.trim().toUpperCase();
    if (!key) continue;
    const type = workspaceTypeForJiraIssueTypeStrict(issue.issueTypeName);
    if (!type) {
      unresolved.push({
        key,
        issueTypeName: issue.issueTypeName,
        reason: issue.issueTypeName
          ? `no workspace type is registered for Jira issue type "${issue.issueTypeName}"`
          : 'the board row carried no issue type'
      });
      unresolvedKeys.add(key);
      continue;
    }
    desired.push({
      agentName: agentNameFor(type, key),
      type,
      key: issue.key.trim(),
      issueTypeName: issue.issueTypeName as string,
      statusName: issue.statusName
    });
  }

  const desiredNames = new Set(desired.map((agent) => agent.agentName));
  const runningNames = new Set(running.map((agent) => agent.agentName));

  const toStart = desired.filter((agent) => !runningNames.has(agent.agentName));

  const toStop: RunningAgent[] = [];
  const unchanged: RunningAgent[] = [];
  const outOfJurisdiction: RunningAgent[] = [];
  const protectedByUnresolved: RunningAgent[] = [];

  for (const agent of running) {
    if (desiredNames.has(agent.agentName)) {
      unchanged.push(agent);
      continue;
    }
    if (!inJurisdiction(agent, types)) {
      outOfJurisdiction.push(agent);
      continue;
    }
    if (unresolvedKeys.has(agent.key.trim().toUpperCase())) {
      protectedByUnresolved.push(agent);
      continue;
    }
    toStop.push(agent);
  }

  return { desired, toStart, toStop, unchanged, unresolved, outOfJurisdiction, protectedByUnresolved };
}

/** One line describing a diff, for a log that is read at a glance. */
export function describeBoardDiff(diff: BoardDiff): string {
  const parts = [
    `${diff.desired.length} desired`,
    `${diff.unchanged.length} already right`,
    `${diff.toStart.length} to start`,
    `${diff.toStop.length} to stop`
  ];
  if (diff.unresolved.length) parts.push(`${diff.unresolved.length} unresolved`);
  if (diff.protectedByUnresolved.length) {
    parts.push(`${diff.protectedByUnresolved.length} spared by an unresolved row`);
  }
  if (diff.outOfJurisdiction.length) {
    parts.push(`${diff.outOfJurisdiction.length} outside this query's jurisdiction`);
  }
  return parts.join(', ');
}

/**
 * How every line below names an agent.
 *
 * Through {@link renderedKey}, because a `RunningAgent`'s key may have come out
 * of a pane name — and this is one of the two surfaces KAN-225 was filed for.
 * The other is board-control.ts; they share the helper so that the log and the
 * Agents page cannot name one agent two ways.
 */
const address = (agent: { type: string | null; key: string }) =>
  `${agent.type ?? 'unknown'}/${renderedKey(agent.key)}`;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The loop. Reads the board, computes the diff, and — only in `converge` —
 * acts on it.
 */
export class BoardReconciler {
  private readonly jql: string;
  private readonly maxResults: number;
  private readonly intervalMs: number;
  private readonly startStaggerMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cycling = false;
  private stopped = false;

  constructor(private readonly opts: BoardReconcilerOptions) {
    this.jql = opts.jql ?? BOARD_JQL;
    this.maxResults = opts.maxResults ?? BOARD_MAX_RESULTS;
    this.intervalMs = opts.intervalMs ?? BOARD_CYCLE_MS;
    this.startStaggerMs = opts.startStaggerMs ?? START_STAGGER_MS;
  }

  /**
   * Start cycling. The first cycle is one interval away, for the reason
   * `JiraPoller.start` gives: at boot the daemon is still restoring the fleet
   * from the registry, and a cycle at t=0 would see a half-restored fleet and
   * compute a diff against it — in `converge`, that is a race between two
   * reconcilers over the same agents.
   */
  public start(): void {
    if (this.timer || this.stopped) return;
    const mode = this.readMode();
    this.opts.log(
      `[board] reconciler starting in ${mode} mode, every ${this.intervalMs / 1000}s. ` +
      `Query: ${this.jql}` +
      (mode === 'converge'
        ? ' — this loop WILL start and stop agents.'
        : mode === 'report'
          ? ' — reporting only; no agent will be started or stopped.'
          : ' — switched off; the board will not be read.')
    );
    this.schedule();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private readMode(): BoardMode {
    try {
      return this.opts.mode();
    } catch {
      // A mode that cannot be read is not a licence to act on the fleet.
      return 'off';
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.intervalMs);
    // Unref'd like the daemon's other timers: a reconcile must not be the thing
    // keeping a shutting-down process alive.
    this.timer.unref?.();
  }

  /** One cycle, guarded against overlapping itself — see JiraPoller.tick. */
  private async tick(): Promise<void> {
    if (this.cycling) {
      this.opts.log('[board] previous cycle is still running; skipping this one.');
      return;
    }
    this.cycling = true;
    try {
      await this.reconcileOnce();
    } catch (e: any) {
      this.opts.log(`[board] cycle failed: ${e?.message ?? String(e)}`);
    } finally {
      this.cycling = false;
    }
  }

  /**
   * Read the board once and converge toward it. Never throws.
   *
   * Public so the daemon can run a cycle by hand and so a proof can drive
   * cycles deterministically instead of waiting on a timer.
   */
  public async reconcileOnce(): Promise<BoardCycle> {
    const mode = this.readMode();
    const cycle: BoardCycle = {
      mode,
      diff: null,
      refusal: null,
      started: [],
      stopped: [],
      converged: false
    };

    if (mode === 'off') {
      cycle.refusal = { reason: 'mode-off', detail: 'the board reconciler is switched off' };
      return cycle;
    }

    // ------------------------------------------------------------ the guard --
    //
    // Everything this module is for is in the next six lines. A read that did
    // not answer is not an answer, and the one thing that must never follow it
    // is a stand-down.
    const outcome = await this.opts.jira.searchBoard(this.jql, this.maxResults);
    if (!outcome.ok) {
      cycle.refusal = {
        reason: 'jira-read-failed',
        detail: outcome.error,
        backOff: outcome.backOff
      };
      this.opts.log(
        `[board] the board could not be read` +
        (outcome.status !== undefined ? ` (HTTP ${outcome.status})` : '') +
        `: ${outcome.error}. Converging nothing this cycle — a query that failed is ` +
        `absent data, not an empty board, and the fleet is left exactly as it is.`
      );
      return cycle;
    }

    // The same guard, pointed at the other input. An exception out of the
    // census would otherwise be caught by tick() and look like a quiet cycle;
    // an empty census mistaken for a real one would make every desired agent
    // look missing and start a second copy of a fleet that already exists.
    let running: RunningAgent[];
    try {
      running = this.opts.runningAgents();
    } catch (e: any) {
      const detail = e?.message ?? String(e);
      cycle.refusal = { reason: 'fleet-unreadable', detail };
      this.opts.log(
        `[board] the running fleet could not be read: ${detail}. Converging nothing ` +
        `this cycle — see waitForHerdr in reconcile.ts for the same distinction.`
      );
      return cycle;
    }

    const diff = computeBoardDiff(outcome.issues, running);
    cycle.diff = diff;
    this.report(diff, mode);

    if (mode !== 'converge') return cycle;
    if (!diff.toStop.length && !diff.toStart.length) return cycle;

    cycle.converged = true;

    // Stand-downs first: everything here is desired-off, so doing it now is not
    // a sacrifice for room — it just happens to leave room. See the header.
    for (const agent of diff.toStop) {
      let stood: DeactivateOutcome;
      try {
        stood = await this.opts.deactivate(agent);
      } catch (e: any) {
        stood = { success: false, error: e?.message ?? String(e) };
      }
      cycle.stopped.push({ agent, outcome: stood });
      this.opts.log(
        stood.success
          ? `[board] stood down ${address(agent)}: the board does not have it In Progress or In Review.`
          : `[board] could not stand down ${address(agent)}: ${stood.error ?? 'no reason given'}`
      );
    }

    let startedCount = 0;
    for (const agent of diff.toStart) {
      if (startedCount > 0 && this.startStaggerMs > 0) await delay(this.startStaggerMs);
      startedCount++;

      let started: ActivateOutcome;
      try {
        started = await this.opts.activate(agent);
      } catch (e: any) {
        started = { success: false, error: e?.message ?? String(e) };
      }
      cycle.started.push({ agent, outcome: started });

      if (started.success) {
        this.opts.log(
          `[board] started ${address(agent)}: ${agent.key} is ${agent.statusName ?? 'in flight'}.`
        );
      } else if (started.refusedBy === 'capacity') {
        // Reported and retried, never queued and never forced. The refusal is
        // the gate's own words, arithmetic included (KAN-60).
        this.opts.log(
          `[board] ${address(agent)} is wanted by the board and cannot start right now. ` +
          `It stays desired and will be tried again next cycle; nothing was preempted ` +
          `and nothing was overridden.\n${started.error ?? ''}`
        );
      } else {
        this.opts.log(
          `[board] could not start ${address(agent)}: ${started.error ?? 'no reason given'}` +
          (started.refusedBy ? ` (refused by ${started.refusedBy})` : '')
        );
      }
    }

    return cycle;
  }

  /** Say what the cycle sees, whether or not it is allowed to act on it. */
  private report(diff: BoardDiff, mode: BoardMode): void {
    const verb = mode === 'converge' ? 'converging' : 'would converge';
    this.opts.log(`[board] ${describeBoardDiff(diff)}.`);

    for (const issue of diff.unresolved) {
      this.opts.log(
        `[board] ${issue.key}: ${issue.reason}. Starting nothing for it, and standing ` +
        `nothing down on that key either — an unknown type is an unanswered question, ` +
        `not an instruction to stop.`
      );
    }
    for (const agent of diff.protectedByUnresolved) {
      this.opts.log(
        `[board] ${address(agent)} is running and not in the desired list, but its key ` +
        `appears on the board with a type this daemon cannot resolve; leaving it alone.`
      );
    }
    for (const agent of diff.outOfJurisdiction) {
      this.opts.log(
        `[board] ${address(agent)} is outside this query's jurisdiction — a Jira issue ` +
        `search can never describe it — so this loop has no opinion about it.`
      );
    }
    for (const agent of diff.toStart) {
      this.opts.log(`[board] ${verb}: start ${address(agent)} (${agent.issueTypeName}, ${agent.statusName}).`);
    }
    for (const agent of diff.toStop) {
      const supervisor = agent.type ? this.opts.isSupervisorType?.(agent.type) === true : false;
      this.opts.log(
        supervisor
          ? `[board] ${verb}: STAND DOWN SUPERVISOR ${address(agent)} — the board does not ` +
            // Through the helper as well, and not only for consistency: this is
            // the one line in the file that names a key *outside* an address, and
            // it is the sentence that tells a reader which ticket to go and move.
            // `agent` here is a RunningAgent, so its key can be the pane spelling.
            `have ${renderedKey(agent.key)} In Progress or In Review. Supervisors are not exempt from ` +
            `this rule (KAN-221); to keep one running, its ticket has to say so.`
          : `[board] ${verb}: stop ${address(agent)} — not In Progress or In Review on the board.`
      );
    }
  }
}
