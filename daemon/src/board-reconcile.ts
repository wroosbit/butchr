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
 * inherited: an epic agent owns review and approval, and the loop's first cycle
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
 * AN ABSENT ASSIGNEE PROTECTS TOO — ABSENCE IS NOT INTENT (KAN-342)
 *
 * The section above settles `issuetype` completely. {@link BOARD_JQL} reads
 * **two** fields, and until 2026-08-12 the other one was treated the opposite
 * way: a missing `issuetype` protected, a missing `assignee` killed. Same file,
 * same class of absence, opposite outcome — and the principle that resolves it
 * was already written one section up.
 *
 * On 2026-08-12 `KAN-203` sat In Progress with `assignee: null`. This loop
 * concluded no agent should exist for it and stood the running supervisor down
 * once every sixty seconds for as long as that lasted. The human restarted it
 * by hand and was the only instrument that noticed — the guardian that reports
 * agents dying was the agent being killed. KAN-256 had met the same field two
 * days earlier and repaired the *sentence*, which was careful, correct work
 * that left the behaviour exactly where it stood.
 *
 * Read off KAN-203's Jira changelog rather than recalled, and it is the whole
 * of what that changelog can say:
 *
 *     2026-08-12T11:05:31Z  assignee  "Wroos Bit" -> null
 *     2026-08-12T11:24:01Z  assignee  null -> "Wroos Bit"      (18m 30s later)
 *
 * Two entries, and the issue has five in its whole history, so **the field was
 * empty exactly once and for eighteen and a half minutes** — KAN-342 estimates
 * about forty-five, and the changelog is the better witness. Roughly eighteen
 * cycles, which fits the eight hand restarts the ticket records better than
 * forty-five would. **The author reads `Wroos Bit` on both**, which identifies
 * nobody: every agent reaches Jira through the human's account, and Butchr's
 * `[authorship]` records cover comments only. That is the same structural hole
 * KAN-256 hit and it is unchanged — which is exactly why nothing below depends
 * on who emptied the field, on whether it was deliberate, or on it being put
 * back.
 *
 * THE DISTINCTION, AND IT IS THE WHOLE CHANGE
 *
 * **The board expresses intent, and this loop honours it. An absence is not an
 * expression.** A ticket moved out of In Progress has had a decision made about
 * it, and standing its agent down is the mechanism working as designed. A
 * ticket whose assignee field is empty has had no decision made about it at
 * all. *"Nobody has said who owns this"* and *"somebody has decided this should
 * stop"* are different states, and they used to produce the same action.
 *
 * So a stand-down now requires the board to have **said** something — not the
 * absence of a row, but the presence of a value that excludes it:
 *
 *   - `wrong-status`       the diagnostic answered and the ticket is not In
 *                          Progress or In Review under any assignee. A status
 *                          is a decision. STAND DOWN.
 *   - `assigned-elsewhere` the ticket carries an assignee, compared against
 *                          this machine's own account id and different. Also a
 *                          decision, and the partition exists to honour it.
 *                          STAND DOWN.
 *   - everything else      no field said anything. LEAVE IT ALONE.
 *
 * {@link isIntent} is that list, {@link partitionStandDowns} applies it, and
 * {@link StandDown} carries a reason whose condition is *narrowed* to the two —
 * so standing an agent down on `no-assignee` is not something a later author
 * can do by editing the logic below. The type has to be widened first, in the
 * open, which is the difference between a decision and a regression.
 *
 * WHY THIS IS NOT A SUPERVISOR EXEMPTION, AND WHY :98-110 IS UNTOUCHED
 *
 * KAN-221 asked whether supervisors belong outside step 4 and answered no, on
 * the ground that an exemption *is* a second store of desired state and that a
 * board which should keep an epic running can already say so. **That argument
 * is correct, this change agrees with it, and it is left standing above.**
 * Nothing here says any agent runs regardless of what the board says; it says
 * the board has to have said it. Supervisors were the visible victims only
 * because they are the agents nobody else reports on — a task agent whose
 * ticket loses its assignee is spared by exactly the same branch, and no code
 * below consults `isSupervisorType` for anything but the wording of a log line.
 *
 * A deliberate stop is unaffected in every form it takes: Done, To Do, deleted,
 * reassigned to another account. Each is a value this loop can read, and each
 * still stands its agent down within one cycle, supervisor included.
 *
 * WHAT IT COSTS, STATED PLAINLY BECAUSE IT IS NOT NOTHING
 *
 * The evidence for intent comes from {@link BOARD_DIAGNOSTIC_JQL}, so **a
 * diagnostic that does not answer now withholds stand-downs**, where before it
 * only made their log lines vaguer. That is a real behaviour change on a
 * reporting query's failure path, and it was the hard call here:
 *
 *   - **It is not a refusal.** The cycle still reads the board, still starts
 *     everything the board wants, and still reports. What it withholds is the
 *     one action that is unrecoverable: an agent's context does not survive its
 *     pane, and none of it survives the stand-down having been wrong.
 *   - **The two failure modes do not cost the same.** Withholding leaves an
 *     agent up that should have gone — visible, harmless, and corrected by the
 *     next cycle whose diagnostic answers. Acting without evidence killed a
 *     supervisor every sixty seconds for forty-five minutes, and nothing inside
 *     the fleet could tell.
 *   - **The window is narrow.** Both queries share a credential, a transport
 *     and a timeout, so a cycle where the partitioned query answers and the
 *     diagnostic does not is a one-off 5xx, a timeout, or a page Jira would not
 *     certify as complete.
 *
 * **The case that is not narrow, named because it is the one that will bite.**
 * {@link BOARD_DIAGNOSTIC_JQL} is unscoped by project, so an account holding
 * more than {@link BOARD_MAX_RESULTS} issues In Progress or In Review anywhere
 * returns a partial page — which `searchBoard` correctly reports as a failed
 * read — leaving the diagnostic null every cycle, permanently. Stand-downs then
 * stop happening and the fleet accumulates agents whose tickets are Done. It is
 * loud (a line per cycle out of `readDiagnostic`) and it fails in the safe
 * direction, but it is real: filed as KAN-343, not fixed here.
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
 *
 * THE PARTITION IS CORRECT AND THE REPORTING WAS WRONG (KAN-256, 2026-08-10)
 *
 * The paragraph above describes a defect and stops there, and it stopped there
 * for two more occurrences. `assignee = currentUser()` was asked, explicitly,
 * whether it is the right partition at all. **It is, and it stays** —
 *
 *   - It is the only field that is *structurally* tied to the account this
 *     daemon authenticates as. A label, a component or a custom field would
 *     partition the board just as well right up to the moment two machines
 *     disagreed about who owns a ticket, and none of them can be compared
 *     against `currentUser()` by a query — the daemon would have to be told its
 *     own identity by configuration, which is a second store of exactly the kind
 *     this design refuses.
 *   - **Every candidate replacement has the same failure.** The defect is not
 *     that `assignee` can be emptied; it is that emptying it was *silent*. A
 *     label can be removed by a routine edit too, and a fix that swapped fields
 *     would have moved the defect rather than closed it while looking finished.
 *   - Dropping the condition is not available: without it this machine's fleet
 *     converges toward every ticket on the account, including other machines'.
 *
 * So nothing about which tickets are started or stopped changed. What changed is
 * that **the loop no longer says anything it has not checked**. It used to print
 * one sentence — *"the board does not have it In Progress or In Review"* — for a
 * missing ticket whatever the cause, and that sentence is false of the case that
 * actually recurs. See {@link BOARD_DIAGNOSTIC_JQL} for the second query,
 * {@link explainAbsence} for the four conditions it distinguishes, and
 * {@link findNearMisses} for the report that catches the ticket *nobody is
 * running*, which is the occurrence no stand-down line could ever have covered.
 *
 * WHAT EMPTIED THE FIELD — ESTABLISHED, AND THE PART THAT CANNOT BE
 *
 * KAN-256 asked, and called it possibly the most valuable thing in the ticket,
 * because *"a fix that assumes hand-editing will not survive it"*. Read off
 * KAN-59's Jira changelog rather than reasoned about:
 *
 *     2026-08-10T14:08:58Z  assignee  "Wroos Bit" -> null
 *     2026-08-10T14:09:50Z  [board] stood down epic/KAN-59       (51s later)
 *     2026-08-10T14:10:44Z  assignee  null -> "Wroos Bit"
 *     2026-08-10T14:10:51Z  [board] started epic/KAN-59           (7s later)
 *
 * **So it was a real write to the field, and the loop then did exactly what it
 * is designed to do, twice, within a cycle each time.** Two hypotheses die
 * here: it was not a stale search index, and it was not the reconciler. Nothing
 * in this repository writes `assignee` at all — the field appears in `daemon/`
 * and `extension/` only inside this query string and comments about it — so the
 * daemon did not do it either.
 *
 * **Who did is not recoverable, and the reason is structural rather than a gap
 * in the log.** Every agent reaches Jira through the human's own account, so the
 * changelog author reads `Wroos Bit` whether the write came from a person or
 * from any one of nine running agents. Butchr's `[authorship]` records — which
 * *do* attribute a Jira write to a named agent — cover **comments only**, and a
 * field edit produces none. That is a genuine hole and it is filed, not fixed
 * here.
 *
 * The consequence for this file is the useful half: **the fix must not assume a
 * cause, and this one does not.** Nothing above depends on who emptied the
 * field, on whether it was deliberate, or on it being reverted — the loop
 * reports the state it finds, every cycle, whoever produced it.
 *
 * **What is still not covered, named here because the above reads complete.**
 * Both queries are Jira *searches*, and a search reads an index rather than the
 * issue. If that index were ever inconsistent with the issue itself, both
 * queries would miss a ticket together and `explainAbsence` would report
 * `wrong-status` — narrowed to what it observed, but still not the whole truth.
 * The `queries-disagree` branch narrows that a little: it catches the two
 * searches disagreeing with *each other*. **It has never fired, and it is not
 * what happened on KAN-59** — it is a branch for a case that is possible and
 * unobserved, and it is written to say so when it fires rather than to imply it
 * explains anything. Closing the gap properly needs an authoritative per-key GET
 * on the stand-down candidates; that is filed rather than done.
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
 * The diagnostic query: the *status* half of {@link BOARD_JQL}, alone.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND QUERY EXISTS, AND WHY IT IS NOT ALLOWED TO START ANYTHING
 * ---------------------------------------------------------------------------
 *
 * KAN-256. {@link BOARD_JQL} has **two** conditions, and every sentence this
 * module used to write about a missing ticket named only one of them. A ticket
 * that satisfied the status half and failed the assignee half was reported as
 * *"the board does not have KAN-59 In Progress or In Review"* — said of a ticket
 * that **was** In Progress. That is not an imprecise line, it is a false one,
 * and on 2026-08-10 it sent an operator to check a field that was correct while
 * an entire project's supervisor sat dark.
 *
 * This query is how the loop can tell the difference. It asks the same status
 * question with the partition removed, so a key that comes back from *this* and
 * not from {@link BOARD_JQL} has failed the assignee condition specifically —
 * and the `assignee` field on the row then says whether it is empty or somebody
 * else's. Three distinguishable conditions where there was one sentence.
 *
 * **It is reporting, and it is only reporting.** Nothing in the diff is derived
 * from it: `toStart` and `toStop` come from {@link BOARD_JQL} alone, exactly as
 * before. That is deliberate and it is the whole safety argument for adding a
 * second read to a loop that stands agents down —
 *
 *   - **A ticket this query returns is not this fleet's business.** It is In
 *     Progress on somebody's board, and the partition is what says whose. See
 *     the decision recorded in {@link BOARD_JQL}'s own comment: the partition is
 *     correct, and it was the reporting that was wrong.
 *   - **So it cannot widen jurisdiction, and it cannot cause a stand-down.** A
 *     second query that fed the diff would be a second store of desired state,
 *     which is the one thing this file's header says exists nowhere.
 *   - **And its failure costs nothing.** A diagnostic that did not answer leaves
 *     the loop converging exactly as it would have; what it changes is that the
 *     log then says the reason is *undetermined* rather than asserting one. See
 *     {@link AbsenceReason}'s `undetermined` branch — a line that names a
 *     condition it did not check is the defect this whole change is about, and
 *     it would be absurd to fix it by inventing a second way to do it.
 *
 * The cost is one search a minute against a budget the poller's own arithmetic
 * put at roughly 25 GETs a minute, and KAN-256 sanctions it by name.
 */
export const BOARD_DIAGNOSTIC_JQL = 'status IN ("In Progress", "In Review")';

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

/**
 * Which of {@link BOARD_JQL}'s conditions a missing ticket actually failed.
 *
 * The point of the discriminant is that the log line can no longer be written
 * without choosing one, and the choice is made from evidence rather than from
 * the shape of the query. `undetermined` is a first-class member for that
 * reason: it is what honesty looks like when the diagnostic did not answer, and
 * a version of this type without it would push the caller straight back into
 * asserting the condition it happens to know how to spell.
 */
export type AbsenceCondition =
  | IntentCondition
  | 'no-assignee'
  | 'assignee-uncompared'
  | 'queries-disagree'
  | 'undetermined';

/**
 * The conditions in which the board **said** something that excludes a ticket.
 *
 * KAN-342, and the list is the whole of the stand-down rule. Both members are a
 * *value this loop read*: a status that is not In Progress or In Review, or an
 * assignee account id compared against this machine's own and found different.
 * Every other member of {@link AbsenceCondition} is an absence — a field that
 * was empty, a question the diagnostic could not answer, or two searches
 * contradicting each other — and an absence is not an instruction.
 *
 * `assignee-uncompared` is deliberately **not** here, and it is the subtle one.
 * It means the row carries an assignee that could not be checked against this
 * machine's account id, because the partitioned query returned no rows to learn
 * that id from (see {@link deriveAccountId}). *Probably* somebody else's — but
 * "probably somebody else's" is indistinguishable from `queries-disagree` from
 * where this code stands, and the state it appears in is the whole fleet's
 * tickets vanishing from the partitioned query at once, which is the exact
 * shape of the incident rather than of a deliberate handover.
 */
export const INTENT_CONDITIONS = ['wrong-status', 'assigned-elsewhere'] as const;

/** A condition that is a decision rather than an absence. */
export type IntentCondition = (typeof INTENT_CONDITIONS)[number];

/**
 * Whether the board expressed an intent, or merely failed to mention a ticket.
 *
 * A type predicate rather than a boolean helper, so the narrowing it performs
 * is the only route to a {@link StandDown} — see that type for what the
 * narrowing buys over an assertion that a later author can delete.
 */
export function isIntent(condition: AbsenceCondition): condition is IntentCondition {
  return (INTENT_CONDITIONS as readonly string[]).includes(condition);
}

/** An attributed absence: the condition, and the sentence that states it. */
export interface AbsenceReason {
  condition: AbsenceCondition;
  /** The status the diagnostic saw, where it saw the issue at all. */
  statusName: string | null;
  /** Display name of whoever holds it, where the row carried one. */
  assignee: string | null;
  /** The clause the log prints after the key. Never claims an unchecked fact. */
  detail: string;
}

/**
 * A stand-down the board asked for, and the evidence that it did.
 *
 * The narrowed `condition` is the point of this type rather than decoration.
 * The rule *"do not stand an agent down on a missing field"* could have been an
 * `if` in the loop below, and an `if` is one edit from being deleted by an
 * author who does not know what it cost to write. This makes the unwanted state
 * **unconstructible**: the only way to obtain a `StandDown` is to pass a reason
 * through {@link isIntent}, so reinstating the 2026-08-12 behaviour means
 * widening {@link INTENT_CONDITIONS} in the open rather than quietly dropping a
 * guard. The assertion exists as well, in {@link partitionStandDowns}; belt and
 * braces, in that order.
 */
export interface StandDown {
  agent: RunningAgent;
  reason: AbsenceReason & { condition: IntentCondition };
}

/** A running agent left alone because nothing established that anybody meant to stop it. */
export interface SparedAgent {
  agent: RunningAgent;
  reason: AbsenceReason;
}

/**
 * Split the stand-down candidates into the ones the board asked for and the
 * ones it merely did not mention.
 *
 * Pure, and a separate stage from {@link computeBoardDiff} on purpose. The diff
 * is computed from {@link BOARD_JQL} alone and its meaning is unchanged — every
 * running agent the partitioned query did not return is still a *candidate*.
 * What is new is that being a candidate is no longer sufficient, and keeping
 * that as a second function rather than a third argument to the first is what
 * keeps {@link BOARD_DIAGNOSTIC_JQL}'s promise literally true: the diagnostic
 * still cannot start anything, still cannot stand anything down, and still
 * feeds no part of the diff. It can now only **spare**, which is a direction a
 * second store of desired state cannot be built out of — nothing it says can
 * make the fleet do something the board did not ask for.
 *
 * A candidate with no absence entry at all is spared. That is the same rule,
 * not a special case: no entry is the least evidence of all.
 */
export function partitionStandDowns(
  candidates: RunningAgent[],
  absences: Array<{ agentName: string; reason: AbsenceReason }>
): { standDowns: StandDown[]; spared: SparedAgent[] } {
  const reasonFor = new Map(absences.map((a) => [a.agentName, a.reason]));
  const standDowns: StandDown[] = [];
  const spared: SparedAgent[] = [];

  for (const agent of candidates) {
    const reason = reasonFor.get(agent.agentName);
    if (reason && isIntent(reason.condition)) {
      // The restated `condition` is not redundant and is not a typo: it is
      // where the predicate's narrowing is spent. A spread alone reconstructs
      // the wide `AbsenceCondition` and does not typecheck against
      // {@link StandDown}, which is the guard doing its job at the one line
      // that could otherwise route around it.
      standDowns.push({ agent, reason: { ...reason, condition: reason.condition } });
      continue;
    }
    spared.push({
      agent,
      reason: reason ?? {
        condition: 'undetermined',
        statusName: null,
        assignee: null,
        detail:
          `this cycle recorded no reason for its absence from \`${BOARD_JQL}\` at all, and an ` +
          `absence nobody has accounted for is the least evidence of intent there is`
      }
    });
  }

  return { standDowns, spared };
}

/** A ticket In Progress or In Review with nobody in the assignee field. */
export interface BoardNearMiss {
  key: string;
  statusName: string | null;
  issueTypeName: string | null;
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
  /**
   * Tickets In Progress or In Review with an empty assignee (KAN-256).
   *
   * **Null and empty are different answers and a proof must be able to tell
   * them apart**: `[]` is "the diagnostic ran and there are none", `null` is
   * "nobody looked". Collapsing them would let a cycle that never ran the query
   * report a clean board, which is the same class of mistake as reading a failed
   * search as an empty one.
   */
  nearMisses: BoardNearMiss[] | null;
  /**
   * Why the partitioned query did not return each stand-down candidate — one
   * entry per agent in `diff.toStop`, in the same order, whether or not the
   * loop was allowed to act on it.
   */
  absences: Array<{ agentName: string; key: string; reason: AbsenceReason }>;
  /**
   * Candidates the loop declined to stand down because nothing established that
   * anybody meant to stop them (KAN-342).
   *
   * Empty and populated are both ordinary. What this must never be is *absent*
   * from a reader's arithmetic: `diff.toStop` is the candidate set, and
   * `stopped` plus `spared` is what actually became of it.
   */
  spared: SparedAgent[];
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
  /** The reporting-only query of {@link BOARD_DIAGNOSTIC_JQL}. */
  diagnosticJql?: string;
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

/**
 * This machine's own Atlassian account id, learned from the board's own answer.
 *
 * Every row {@link BOARD_JQL} returns satisfies `assignee = currentUser()`, so
 * any assignee it carries **is** currentUser's — the partitioned query is a
 * self-calibrating answer to "who am I", for no extra request and no extra
 * credential scope. That matters because the alternative was a `/myself` call,
 * and the honest reason not to make one is that this needs the id only to
 * *label a log line*; spending a request and a new endpoint on that would be a
 * poor trade.
 *
 * Null when the query returned no rows: an empty board is a real state, and it
 * simply means the id could not be learned this cycle. Callers must degrade
 * rather than guess — see {@link explainAbsence}, which downgrades its own
 * certainty in that case instead of asserting a partition it could not check.
 */
export function deriveAccountId(issues: JiraBoardIssue[]): string | null {
  for (const issue of issues) {
    if (issue.assigneeAccountId) return issue.assigneeAccountId;
  }
  return null;
}

/**
 * Tickets the board has In Progress or In Review with **nobody assigned**.
 *
 * The near-miss report, and the half of KAN-256 that catches the failure
 * *before* it costs anybody an agent. A stand-down reason is retrospective — it
 * explains an agent that has already gone. This is the same defect seen from
 * the front: a ticket in exactly this state is one the partitioned query can
 * never return, so its agent is not merely stopped, it is **never started**, and
 * nothing else in this daemon would ever mention it.
 *
 * That is occurrence 2 on KAN-256: on 2026-08-08 a supervisor moved KAN-212 to
 * In Progress to staff it and reported that the reconciler would pick it up. It
 * would not have. Nothing was running to be stood down, so no stand-down line
 * would have been written however well worded — the ticket would simply have sat
 * there. This function is what says so, once a cycle, out loud.
 */
export function findNearMisses(
  diagnostic: JiraBoardIssue[],
  projects: Set<string>
): BoardNearMiss[] {
  const misses: BoardNearMiss[] = [];
  for (const issue of diagnostic) {
    if (issue.assigneeAccountId) continue;
    const key = issue.key.trim();
    if (!key) continue;
    if (!projects.has(projectOf(key))) continue;
    misses.push({
      key,
      statusName: issue.statusName,
      issueTypeName: issue.issueTypeName
    });
  }
  return misses;
}

/** `KAN-256` → `KAN`. Empty for anything not shaped like a Jira key. */
export function projectOf(key: string): string {
  const upper = key.trim().toUpperCase();
  if (!JIRA_KEY.test(upper)) return '';
  return upper.slice(0, upper.lastIndexOf('-'));
}

/**
 * The projects this fleet demonstrably works in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NEAR-MISS REPORT IS SCOPED AT ALL, AND HOW THE SCOPE WAS FOUND
 * ---------------------------------------------------------------------------
 *
 * {@link BOARD_DIAGNOSTIC_JQL} drops the assignee condition, and an unscoped
 * query over the whole account then returns *every* unassigned In Progress
 * ticket anybody has, in any project. The first live run of this code against
 * the real board returned four — all in `SAM1`, Jira's own sample project,
 * unassigned since the day it was created and of no interest to anybody.
 *
 * **Unfiltered, that is four log lines a minute forever**, and a report that
 * cries wolf 5,760 times a day is not a safety feature: it is the thing that
 * buries the one occurrence that matters. The near-miss report exists because
 * KAN-59's went unnoticed. Shipping it in a form that trains its reader to skim
 * past it would have reproduced the original failure through the mechanism
 * built to prevent it — and it would have looked finished, because the line was
 * there and it was correct.
 *
 * So the scope is **projects this fleet is actually in**, from two sources
 * unioned, and the second one is the one that matters:
 *
 *   - projects named by the partitioned query's own rows, and
 *   - **projects named by the agents currently running.**
 *
 * The second is not redundant. Consider the case the report is *most* needed
 * for: every ticket on the board gets unassigned at once. The partitioned query
 * then returns nothing, so a scope derived from it alone would be empty and the
 * report would fall silent at exactly the moment the whole fleet was about to be
 * stood down. The running agents still name their project, so each of them gets
 * a line saying precisely why it is about to die.
 *
 * When both are empty nothing is at stake — no board rows, no agents — and an
 * empty scope reports nothing, which is correct rather than a degradation.
 */
export function fleetProjects(board: JiraBoardIssue[], running: RunningAgent[]): Set<string> {
  const projects = new Set<string>();
  for (const issue of board) {
    const project = projectOf(issue.key);
    if (project) projects.add(project);
  }
  for (const agent of running) {
    const project = projectOf(agent.key);
    if (project) projects.add(project);
  }
  return projects;
}

/**
 * Why {@link BOARD_JQL} did not return `key` — decided from evidence.
 *
 * Pure, and separated from the logging on purpose: what makes the old line
 * wrong is not its prose but that no code anywhere had established which
 * condition failed. This is that code, and it is testable without a daemon.
 *
 * **Since KAN-342 the condition it returns also decides an action**, and that is
 * worth meeting here rather than discovering downstream. This function was
 * written to choose a *sentence*; {@link partitionStandDowns} now reads the same
 * discriminant to choose whether the agent lives. Nothing about the branches
 * changed for that — they were already required to name only what they had
 * checked, which is exactly the property a decision needs — but a new branch
 * added here is now a stand-down rule as well as a log line, and it has to be
 * added to {@link INTENT_CONDITIONS} or left out of it deliberately.
 *
 * `diagnostic` is null when the diagnostic query was not run or did not answer,
 * and that case returns `undetermined` rather than falling back to the old
 * sentence. **The fallback is the bug.** A loop that says "not In Progress or In
 * Review" whenever it has nothing better to say is exactly what produced the
 * false line on KAN-59, and reproducing it on the failure path would leave the
 * defect live in precisely the conditions — Jira degraded — where an operator is
 * least able to check it by hand.
 */
export function explainAbsence(
  key: string,
  diagnostic: JiraBoardIssue[] | null,
  accountId: string | null
): AbsenceReason {
  const wanted = key.trim().toUpperCase();

  if (!diagnostic) {
    return {
      condition: 'undetermined',
      statusName: null,
      assignee: null,
      detail:
        `this daemon's partitioned board query did not return it, and the diagnostic query ` +
        `that would say which condition it failed — wrong status, no assignee, or assigned to ` +
        `another account — did not answer this cycle. The reason is genuinely unknown; ` +
        `\`${BOARD_DIAGNOSTIC_JQL}\` run by hand will say which`
    };
  }

  const row = diagnostic.find((issue) => issue.key.trim().toUpperCase() === wanted);

  if (!row) {
    // The one case in which the sentence this module used to print for
    // everything is true. It is still narrowed to what was actually observed:
    // a search answered, and the key was in neither result.
    return {
      condition: 'wrong-status',
      statusName: null,
      assignee: null,
      detail:
        `the board does not have it In Progress or In Review under any assignee — ` +
        `it was returned by neither \`${BOARD_JQL}\` nor \`${BOARD_DIAGNOSTIC_JQL}\``
    };
  }

  const status = row.statusName ?? 'In Progress or In Review';

  if (!row.assigneeAccountId) {
    return {
      condition: 'no-assignee',
      statusName: row.statusName,
      assignee: null,
      detail:
        `it IS ${status} on the board, but its assignee field is empty, and this daemon's ` +
        `query is \`${BOARD_JQL}\` — both halves. An unassigned ticket is invisible to it: ` +
        `not started, and not restarted if its agent dies. Assign it to this machine's Jira ` +
        `account and the next cycle will pick it up. Do not go and check the status; the ` +
        `status is correct (KAN-256)`
    };
  }

  if (!accountId) {
    // The row carries an assignee and there is nothing to compare it against:
    // the partitioned query returned no rows this cycle, so this machine's own
    // account id could not be learned from it. Until KAN-342 this fell through
    // to `assigned-elsewhere` with a clause admitting the inference — a
    // conclusion drawn from an absence, wearing the same name as one drawn from
    // a comparison, and now the difference decides whether an agent lives.
    return {
      condition: 'assignee-uncompared',
      statusName: row.statusName,
      assignee: row.assigneeDisplayName,
      detail:
        `it is ${status} on the board and assigned to ` +
        `${row.assigneeDisplayName ?? row.assigneeAccountId}, but this cycle's partitioned ` +
        `query returned no rows at all, so this machine's own Jira account id could not be ` +
        `learned from it and that assignee could not be compared against it. It is probably ` +
        `somebody else's ticket; from here that is indistinguishable from the two searches ` +
        `disagreeing, and a whole board vanishing from \`${BOARD_JQL}\` at once is what the ` +
        `incident looked like rather than what a handover looks like (KAN-342)`
    };
  }

  if (row.assigneeAccountId === accountId) {
    // Status right, assignee right, and the partitioned query still did not
    // return it. Nothing about the ticket explains that, so the line must not
    // pretend something does — the two searches disagreed, and saying so is the
    // only honest reading available from here.
    return {
      condition: 'queries-disagree',
      statusName: row.statusName,
      assignee: row.assigneeDisplayName,
      detail:
        `it is ${status} AND assigned to this machine's own account, yet \`${BOARD_JQL}\` did ` +
        `not return it while \`${BOARD_DIAGNOSTIC_JQL}\` did, seconds apart. Both conditions ` +
        `hold, so nothing about this ticket explains its absence — the two searches disagreed ` +
        `with each other. Suspect Jira's search index rather than the board (KAN-256)`
    };
  }

  const who = row.assigneeDisplayName ?? row.assigneeAccountId;
  return {
    condition: 'assigned-elsewhere',
    statusName: row.statusName,
    assignee: row.assigneeDisplayName,
    detail:
      `it is ${status} on the board but assigned to ${who}, compared against this machine's ` +
      `own Jira account id and different, so it is not this fleet's business however it is ` +
      `statused`
  };
}

/** One line describing a diff, for a log that is read at a glance. */
export function describeBoardDiff(diff: BoardDiff): string {
  const parts = [
    `${diff.desired.length} desired`,
    `${diff.unchanged.length} already right`,
    `${diff.toStart.length} to start`,
    // Not "to stop". Since KAN-342 the board not returning a running agent
    // makes it a candidate and nothing more — whether it is actually stood down
    // depends on the board having said something, which this pure function has
    // no way to know. A count that said "to stop" here would be a number the
    // cycle then contradicts.
    `${diff.toStop.length} stand-down candidate(s)`
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
  private readonly diagnosticJql: string;
  private readonly maxResults: number;
  private readonly intervalMs: number;
  private readonly startStaggerMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cycling = false;
  private stopped = false;

  constructor(private readonly opts: BoardReconcilerOptions) {
    this.jql = opts.jql ?? BOARD_JQL;
    this.diagnosticJql = opts.diagnosticJql ?? BOARD_DIAGNOSTIC_JQL;
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
      converged: false,
      nearMisses: null,
      absences: [],
      spared: []
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

    // ------------------------------------------------------- the diagnostic --
    //
    // Reporting only, and deliberately *after* the diff: nothing in here may
    // change what is started or stopped, and running it once the diff already
    // exists is the cheapest way to keep that true — there is no decision left
    // for it to influence. See BOARD_DIAGNOSTIC_JQL for the argument in full.
    //
    // WHY THE WHOLE BLOCK IS WRAPPED, AND IT IS NOT BELT-AND-BRACES
    //
    // `tick()` catches, so an exception thrown anywhere in here would be caught
    // one level up and the cycle would end **having converged nothing** — a
    // reporting fault silently acquiring the power to stand the fleet still.
    // That is the same trade `readDiagnostic` refuses for a failed query, and
    // refusing it there while leaving it available to a null dereference three
    // lines later would be a guard that only covered the failure somebody had
    // already thought of. Reporting degrades; convergence continues.
    let diagnostic: JiraBoardIssue[] | null = null;
    try {
      diagnostic = await this.readDiagnostic();
      const accountId = deriveAccountId(outcome.issues);
      if (diagnostic) {
        cycle.nearMisses = findNearMisses(diagnostic, fleetProjects(outcome.issues, running));
      }
      for (const agent of diff.toStop) {
        cycle.absences.push({
          agentName: agent.agentName,
          key: agent.key,
          reason: explainAbsence(agent.key, diagnostic, accountId)
        });
      }
    } catch (e: any) {
      // Deliberately not a refusal: the diff above is untouched and still
      // correct, so the loop goes on to act on it with worse log lines.
      cycle.absences.length = 0;
      this.opts.log(
        `[board] the diagnostic reporting failed: ${e?.message ?? String(e)}. Convergence is ` +
        `unaffected and proceeds on the diff already computed; stand-down lines this cycle ` +
        `will report an undetermined reason rather than guessing one.`
      );
    }

    // ------------------------------------------------------ absence or intent --
    //
    // KAN-342. `diff.toStop` is every running agent the partitioned query did
    // not return, which is a question rather than an answer: the board may have
    // said "stop", or it may have said nothing at all. This is where the two
    // are separated, and it is the only gate between a candidate and a killed
    // pane. See the header section AN ABSENT ASSIGNEE PROTECTS TOO.
    const { standDowns, spared } = partitionStandDowns(diff.toStop, cycle.absences);
    cycle.spared = spared;

    this.report(diff, mode, cycle, standDowns);

    if (mode !== 'converge') return cycle;
    if (!standDowns.length && !diff.toStart.length) return cycle;

    cycle.converged = true;

    // Stand-downs first: everything here is desired-off, so doing it now is not
    // a sacrifice for room — it just happens to leave room. See the header.
    for (const { agent, reason } of standDowns) {
      let stood: DeactivateOutcome;
      try {
        stood = await this.opts.deactivate(agent);
      } catch (e: any) {
        stood = { success: false, error: e?.message ?? String(e) };
      }
      cycle.stopped.push({ agent, outcome: stood });
      // The second half of KAN-256, and the one actually read during the
      // incident: this is the line that appears when the agent is already gone,
      // so it is where an operator starts. It carried the same unconditional
      // sentence as the line above and was wrong in exactly the same way.
      this.opts.log(
        stood.success
          ? `[board] stood down ${address(agent)}: ${reason.detail}.`
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

    // One line per cycle naming what the machine held back, and it is the line
    // KAN-258 asks for by name: *"it must say so in the log — a silent deferral
    // is indistinguishable from the KAN-256 invisibility defect."*
    //
    // The per-agent refusals above already carry the gate's figures, so this
    // does not repeat them. What it adds is the thing no per-agent line can
    // say: **how far short of the board this cycle ended up**, in one place, so
    // a reader who scrolls past ten refusals still meets the total. A cycle
    // that deferred nothing writes nothing.
    const deferred = cycle.started.filter(
      (s) => !s.outcome.success && s.outcome.refusedBy === 'capacity'
    );
    if (deferred.length) {
      const startedOk = cycle.started.filter((s) => s.outcome.success).length;
      this.opts.log(
        `[board] converged to ${startedOk} of ${diff.toStart.length} wanted start(s): the ` +
        `machine would not carry ${deferred.length} of them yet — ` +
        `${deferred.map((s) => address(s.agent)).join(', ')}. Each stays desired and is ` +
        `retried next cycle; nothing was queued, preempted or overridden. The board is a ` +
        `statement of what is wanted, and this loop converges toward it at a rate the ` +
        `machine survives rather than jumping to it (KAN-258).`
      );
    }

    return cycle;
  }

  /**
   * The diagnostic query, whose failure is not an event.
   *
   * Returns null on any failure at all, and — unlike every other read in this
   * file — **sets no refusal and takes no branch**. That asymmetry is the point
   * rather than an oversight: the main read decides what should run, so a read
   * that did not answer must stop the loop acting; this one decides only what a
   * sentence says, so a read that did not answer costs a sentence its detail and
   * nothing else. Wiring it into the refusal path would have made a reporting
   * improvement able to halt convergence, which is a strictly worse daemon than
   * the one that had no diagnostic.
   */
  private async readDiagnostic(): Promise<JiraBoardIssue[] | null> {
    try {
      const outcome = await this.opts.jira.searchBoard(this.diagnosticJql, this.maxResults);
      if (outcome.ok) return outcome.issues;
      this.opts.log(
        `[board] the diagnostic query could not be read: ${outcome.error}. Convergence is ` +
        `unaffected — this query never starts or stops anything — but stand-down lines this ` +
        `cycle cannot name which condition a missing ticket failed, and will say so.`
      );
      return null;
    } catch (e: any) {
      this.opts.log(
        `[board] the diagnostic query threw: ${e?.message ?? String(e)}. Convergence is ` +
        `unaffected; stand-down lines this cycle will report an undetermined reason.`
      );
      return null;
    }
  }

  /** Say what the cycle sees, whether or not it is allowed to act on it. */
  private report(
    diff: BoardDiff,
    mode: BoardMode,
    cycle: BoardCycle,
    standDowns: StandDown[]
  ): void {
    const verb = mode === 'converge' ? 'converging' : 'would converge';
    this.opts.log(
      `[board] ${describeBoardDiff(diff)}` +
      (cycle.spared.length
        ? `, of which ${standDowns.length} the board asked to stop and ${cycle.spared.length} ` +
          `it did not mention`
        : '') +
      `.`
    );

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
    // The near-miss report (KAN-256). Every cycle, whether or not anything is
    // being stood down, and whether or not an agent exists for the key — the
    // ticket nobody is running is exactly the one no other line would mention.
    for (const miss of cycle.nearMisses ?? []) {
      this.opts.log(
        `[board] ${miss.key} is ${miss.statusName ?? 'In Progress or In Review'} on the board ` +
        `with NO ASSIGNEE, so this daemon's query cannot see it: it will not be started, and ` +
        `if an agent for it is running it will be stood down. Assign it to this machine's Jira ` +
        `account to staff it. (KAN-256; this line is a report, not an action — nothing about ` +
        `this ticket has been started or stopped.)`
      );
    }

    // One line per stand-down candidate, exactly as before — but the candidates
    // are now two populations and the line says which. Nothing was *added* to
    // this loop's output: a line that used to announce an action announces a
    // refusal to act instead, where the board never asked for one (KAN-342).
    for (const { agent, reason } of standDowns) {
      const supervisor = agent.type ? this.opts.isSupervisorType?.(agent.type) === true : false;
      // Never the old unconditional sentence. `explainAbsence` always returns a
      // reason — `undetermined` when it could not establish one — so there is no
      // branch here that names a condition nobody checked.
      //
      // Through the helper, and not only for consistency: these are the lines in
      // the file that name a key *outside* an address, and they are what tells a
      // reader which ticket to go and fix. `agent` is a RunningAgent, so its key
      // can be the pane spelling.
      const detail = `${renderedKey(agent.key)}: ${reason.detail}`;
      this.opts.log(
        supervisor
          ? `[board] ${verb}: STAND DOWN SUPERVISOR ${address(agent)} — ${detail}. ` +
            `Supervisors are not exempt from this rule (KAN-221); to keep one running, its ` +
            `ticket has to say so.`
          : `[board] ${verb}: stop ${address(agent)} — ${detail}.`
      );
    }
    // The spared. No supervisor variant, deliberately: the loud line above
    // exists because an agent nobody else reports on is about to be destroyed,
    // and nothing is being destroyed here. Special-casing a type in a line that
    // reports *inaction* would be the visibility-instead-of-behaviour trade
    // KAN-221 made and KAN-342 is here to undo.
    for (const { agent, reason } of cycle.spared) {
      this.opts.log(
        `[board] ${address(agent)} is running and \`${this.jql}\` did not return it, but ` +
        `nothing established that anybody asked it to stop — ${renderedKey(agent.key)}: ` +
        `${reason.detail}. Leaving it running: this loop honours what the board says, and an ` +
        `absent field has not said anything (KAN-342, condition \`${reason.condition}\`).`
      );
    }
  }
}
