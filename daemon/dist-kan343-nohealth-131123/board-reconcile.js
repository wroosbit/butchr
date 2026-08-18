import { BOARD_MAX_RESULTS } from './jira.js';
import { agentNameFor } from './herdr.js';
import { workspaceTypeForJiraIssueTypeStrict, jiraIssueWorkspaceTypes } from './integrations/atlassian-integration.js';
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
 * THIS LOOP OWNS AGENT LIFECYCLE, AND THAT IS NOW A RULING RATHER THAN AN
 * IMPLICATION (KAN-508, 2026-08-17)
 *
 * The algorithm above always implied it, and for a year nothing said it, so in
 * practice the answer to *"who stands an agent down when its ticket reaches
 * Done?"* was **nobody, until a guardian happened to notice at capacity**. That
 * is not a gap in this file — this loop was converging correctly — it is that
 * three other candidates were live in the fleet's own instructions at the same
 * time: the agent itself at the end of its run, the approver in the same motion
 * as setting `Done`, and the guardian sweep. `prompts/story.md` and
 * `prompts/epic.md` told supervisors to call `butchr_deactivate_agent` by hand,
 * which is the second of those.
 *
 * The human ruled, relayed on KAN-508 by `epic/KAN-203`: *"butchr should be
 * responsibile for telling crabcast to turn on/off agents based on the status
 * and assignee of the jira issue"*. So it is this loop, and the other three are
 * out — **the guardian sweep especially, because doing it by accident is what
 * let three finished agents fill a cap of three** (KAN-507's incident, where
 * four activations were refused including the deploy of the fleet's own
 * messaging fix).
 *
 * **Nothing in the algorithm changed, and that is the substance of the ruling
 * rather than a caveat on it.** The requirement attached to it was that nothing
 * may stand down an agent whose work is unfinished, and keying on `status IN
 * (In Progress, In Review) AND assignee` satisfies that **by construction**: a
 * ticket at `In Review` is still staffed, so its agent keeps running. That is
 * the case `epic/KAN-203` got right by hand on 2026-08-16 — two agents at
 * `Done` stood down, `task/kan-420` at `In Review` deliberately left — and this
 * loop reproduces it without anybody having to remember. A rule keyed on
 * anything looser destroys work.
 *
 * **What the ruling exposed is that this loop could DECIDE a stand-down it
 * could not PERFORM**, which is the half KAN-508 actually had to build. Under
 * CrabCast, `closeAgentByKey` resolved against the daemon's own session map;
 * that map dies with the daemon and CrabCast's registry does not, so every
 * agent outliving a daemon restart was refused while running and charged. The
 * stand-downs below were computed correctly and silently did nothing for
 * exactly the population that accumulates. See
 * `CrabCastRuntime.closeAgentByKey` for the workspace-addressed route that
 * closes it, and `verify-standdown-reaches-sessionless-agent.mjs` for the
 * proof. **A loop that owns lifecycle has to be able to end one.**
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
 * {@link BOARD_DIAGNOSTIC_JQL} was unscoped by project, so an account holding
 * more than {@link BOARD_MAX_RESULTS} issues In Progress or In Review anywhere
 * returned a partial page — which `searchBoard` correctly reports as a failed
 * read — leaving the diagnostic null every cycle, permanently. Stand-downs then
 * stop happening and the fleet accumulates agents whose tickets are Done. It
 * was filed as KAN-343 and it is the section below.
 *
 * WHAT KAN-343 FOUND, AND WHY THE QUERY WAS THE SMALLER HALF (2026-08-12)
 *
 * The paragraph above called that failure *loud*, and the word was doing work it
 * had not earned. **"Fails safe" and "fails visibly" are different claims and
 * only the first was true here** (`epic/KAN-203`). Post-KAN-342 a broken
 * diagnostic leaves agents *running* rather than killing them — the safe
 * direction, and **the direction nobody notices**: a fleet that fails to shrink
 * looks exactly like a fleet nobody asked to shrink, until capacity fills and
 * the machine degrades, which is KAN-258's incident shape arriving by a new
 * road.
 *
 * So KAN-343's first question was not *how do we stop the query truncating* but
 * **when the diagnostic stops answering, who finds out, by what route, and would
 * they have been looking?** The answer, read off this file rather than assumed:
 * one line per cycle out of {@link BoardReconciler.readDiagnostic} into
 * `daemon.log`, and nothing else. `boardControlReport` deliberately carried no
 * cycle state, `butchr_list_agents` carried no board health, and no ticket is
 * ever written. **That is the same defect as :111's loud supervisor stand-down
 * logged into a place nobody reads** — in review it looks as though somebody was
 * told. Two fixes follow, and they are not the same size:
 *
 *   1. **The evidence channel now discloses itself** — {@link BoardHealth},
 *      published through `board-control.ts` onto the `butchr_list_agents`
 *      response beside `censusUnreadableRecordsTotal` and
 *      `undeliveredNotifications`, which are the fields this daemon already uses
 *      to say *what it could not do*. That is the fix. It carries
 *      `consecutiveFailures`, because **one** failed diagnostic is the narrow
 *      window the section above priced in and **ninety** is stand-downs having
 *      been off for an hour and a half, and no log line distinguishes those.
 *   2. **The diagnostic is scoped by project** — {@link scopedDiagnosticJql} —
 *      which closes the named mechanism. This is a smaller claim than it looks
 *      and deliberately so: it is **not a new trade-off**, it moves a filter
 *      that already existed one hop upstream. {@link findNearMisses} has
 *      discarded every row outside {@link fleetProjects} since KAN-256; asking
 *      Jira for what this loop already keeps is not a narrowing of the answer.
 *
 * **Why (2) cannot lose a row (1) needs**, because the direction it would fail
 * in is the dangerous one — a diagnostic missing a candidate's row returns
 * `wrong-status`, which is an intent, which is a stand-down. Every stand-down
 * candidate is in `diff.toStop`, `toStop ⊆ running` by construction in
 * {@link computeBoardDiff}, every member of it passed {@link inJurisdiction} and
 * therefore has a Jira-shaped key, and {@link fleetProjects} adds the project of
 * **every running agent**. So a candidate's project is in the scope by
 * construction, not by luck. The containment is asserted rather than trusted —
 * `verify-diagnostic-evidence-visible.mjs` §4.
 *
 * An empty scope runs the query unscoped, which is the honest degradation: an
 * empty scope means no board rows and no running agents, so there is no
 * candidate to explain and nothing is at stake.
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
 * searches disagreeing with *each other*. Closing the gap properly needs an
 * authoritative per-key GET on the stand-down candidates; that is filed rather
 * than done.
 *
 * ---------------------------------------------------------------------------
 * `queries-disagree` HAS FIRED, AND EVERY ONE OF THOSE FIRINGS WAS THIS FILE'S
 * OWN BUG RATHER THAN JIRA'S (KAN-470)
 * ---------------------------------------------------------------------------
 *
 * Until 2026-08-15 the paragraph above ended: *"**It has never fired, and it is
 * not what happened on KAN-59** — it is a branch for a case that is possible and
 * unobserved, and it is written to say so when it fires rather than to imply it
 * explains anything."*
 *
 * **That was true when it was written and false for the 44 hours before anybody
 * re-read it.** The branch had fired **1307 times** by 2026-08-15T13:40Z, every
 * cycle since **2026-08-13T17:10:43Z**, and the sentence telling the reader it
 * was hypothetical is what kept 1307 log lines unread — a reader who is told a
 * branch is unobserved discounts the line that proves it is not. **What changed
 * is not that a possible case finally happened. It is that the branch was
 * reachable without its premise holding at all.**
 *
 * **What was actually firing.** Every one of the 1307 named `task/KAN-117`, and
 * never `story/KAN-117` on the same key, and never any other key in the fleet.
 * KAN-117 is a **Story**, In Progress, assigned to this machine's account, and
 * `BOARD_JQL` returned it on every one of those cycles — the same cycles logged
 * `8 desired, 8 already right`, and `story/KAN-117` was one of the eight.
 * Two agents were running on the one key, and {@link computeBoardDiff} matches on
 * **type and key together** (KAN-83), so `task/KAN-117` was not in the desired
 * list and became a stand-down candidate — correctly.
 *
 * **The bug was the next line.** {@link explainAbsence} was handed `agent.key`
 * and nothing else, so it asked *"is KAN-117 on the board?"* where the diff had
 * asked *"is `task/KAN-117` on the board?"*. KAN-117 was; `task/KAN-117` was not.
 * Right status, right assignee, and no explanation left — so it fell to the last
 * branch and reported the two searches disagreeing. **The two searches never
 * disagreed. Both returned KAN-117 every time.** The disagreement was between
 * the diff's question and this function's, and the log line asserted a fact about
 * Jira to describe it.
 *
 * **The class, which is why this is written out rather than just patched.** Two
 * stages decided on different identifiers for the same agent, and the second one
 * was written to explain the first's verdict. Nothing type-checked that they were
 * answering about the same thing, because a key is a string and an address is a
 * string. `explainAbsence` now takes the {@link RunningAgent} the diff acted on
 * and the desired list the diff computed, so it cannot be asked a question the
 * diff did not ask; and the case above has its own condition,
 * `same-key-other-type`, which names what was observed instead of blaming an
 * index. **It is deliberately not in {@link INTENT_CONDITIONS}** — the sparing was
 * always right and nothing here changes it. What changes is the sentence.
 *
 * **What the old wording cost, stated because it is this file's own lesson.** The
 * guard behaved correctly for 44 hours while describing itself wrongly, and the
 * docblock promised the reader that the description could be ignored. That is
 * the same defect this header warns about elsewhere — an artifact whose sentence
 * claims more than its mechanism covers — and it survived because everything it
 * touched kept working. **A branch's own comment is not evidence about whether it
 * has fired. The log is.**
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
export const BOARD_JQL = 'assignee = currentUser() AND status IN ("In Progress", "In Review")';
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
 * {@link BOARD_DIAGNOSTIC_JQL}, narrowed to the projects this fleet is in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NEW TRADE-OFF (KAN-343)
 * ---------------------------------------------------------------------------
 *
 * The unscoped query asks the whole account, and `BOARD_MAX_RESULTS` is 100, so
 * an account holding more than a hundred issues In Progress or In Review
 * **anywhere** — other people's projects, other machines' fleets, Jira's own
 * `SAM1` sample project — gets a partial page every cycle, forever. `searchBoard`
 * correctly reports a partial page as a failed read, and since KAN-342 a
 * diagnostic that does not answer withholds every stand-down. So a number nobody
 * in this repository controls silently switches off half the reconciler.
 *
 * **The scope is not a narrowing of the answer, because the answer was already
 * being narrowed.** {@link findNearMisses} has filtered its rows through
 * {@link fleetProjects} since KAN-256, for the reason recorded there: unfiltered,
 * `SAM1`'s four permanently-unassigned tickets are four log lines a minute
 * forever, and a report that cries wolf 5,760 times a day buries the occurrence
 * that matters. Measured on the live board 2026-08-12: ten rows came back, four
 * of them `SAM1`, and all four were discarded here. This asks Jira not to send
 * them.
 *
 * **The one thing it must not do is lose a row {@link explainAbsence} needs**,
 * because that failure runs the wrong way: a candidate whose row is missing gets
 * `wrong-status`, which {@link isIntent} calls a decision, which is a
 * stand-down. It cannot. See the header section WHAT KAN-343 FOUND for the
 * containment argument in full — the short form is that
 * {@link fleetProjects} takes the project of every *running* agent, and every
 * stand-down candidate is a running agent with a Jira-shaped key.
 *
 * **An empty set returns the query unscoped rather than `project IN ()`**, which
 * is not a fallback so much as the same rule at zero: an empty scope means no
 * board rows and no running agents, so there is no candidate to explain, no near
 * miss to report, and nothing at stake in the difference.
 *
 * Sorted, so the string a stub matches on and the string a log line prints are
 * stable across cycles rather than dependent on Set insertion order.
 */
export function scopedDiagnosticJql(base, projects) {
    if (projects.size === 0)
        return base;
    const list = [...projects].sort().map((project) => `"${project}"`).join(', ');
    return `project IN (${list}) AND ${base}`;
}
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
 * The conditions in which the board **said** something that excludes a ticket.
 *
 * KAN-342, and the list is the whole of the stand-down rule. Both members are a
 * *value this loop read*: a status that is not In Progress or In Review, or an
 * assignee account id compared against this machine's own and found different.
 * Every other member of {@link AbsenceCondition} is an absence — a field that
 * was empty, a question the diagnostic could not answer, or two searches
 * contradicting each other — and an absence is not an instruction.
 *
 * `same-key-other-type` is deliberately **not** here either, and it is the one
 * that looks most like an instruction while being none. The board *did* answer
 * about that key — it said the key belongs to a different workspace type — so it
 * is tempting to read it as "and therefore stop the other one". It is not: the
 * board was asked which agents should run and never asked whether a second agent
 * on the same key should stop, and a ticket cannot express that it wants one.
 * Standing an agent down on it would let a single Jira issue-type field kill a
 * pane that no ticket ever mentioned (KAN-470).
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
export const INTENT_CONDITIONS = ['wrong-status', 'assigned-elsewhere'];
/**
 * Whether the board expressed an intent, or merely failed to mention a ticket.
 *
 * A type predicate rather than a boolean helper, so the narrowing it performs
 * is the only route to a {@link StandDown} — see that type for what the
 * narrowing buys over an assertion that a later author can delete.
 */
export function isIntent(condition) {
    return INTENT_CONDITIONS.includes(condition);
}
/**
 * Split the stand-down candidates into the ones the board asked for and the
 * ones it merely did not mention.
 *
 * Pure, and a separate stage from {@link computeBoardDiff} on purpose. The diff
 * is computed from {@link BOARD_JQL} alone and its meaning is unchanged — every
 * running agent whose **address** the partitioned query did not return is still
 * a *candidate*. (Address, not key: the distinction reads pedantic until it
 * isn't — see KAN-470 in the header.)
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
export function partitionStandDowns(candidates, absences) {
    const reasonFor = new Map(absences.map((a) => [a.agentName, a.reason]));
    const standDowns = [];
    const spared = [];
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
                detail: `this cycle recorded no reason for its absence from \`${BOARD_JQL}\` at all, and an ` +
                    `absence nobody has accounted for is the least evidence of intent there is`
            }
        });
    }
    return { standDowns, spared };
}
/**
 * The set of workspace types a Jira board query can describe.
 *
 * Derived from the issue-type table rather than written out, so this cannot
 * drift from the mapping it is supposed to mirror.
 */
export function boardWorkspaceTypes() {
    return new Set(jiraIssueWorkspaceTypes());
}
/** Whether this loop is entitled to have an opinion about an agent at all. */
export function inJurisdiction(agent, types) {
    if (!agent.type || !types.has(agent.type))
        return false;
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
export function computeBoardDiff(issues, running) {
    const types = boardWorkspaceTypes();
    const desired = [];
    const unresolved = [];
    /** Keys the board mentioned but could not be resolved — protected below. */
    const unresolvedKeys = new Set();
    for (const issue of issues) {
        const key = issue.key.trim().toUpperCase();
        if (!key)
            continue;
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
            issueTypeName: issue.issueTypeName,
            statusName: issue.statusName
        });
    }
    const desiredNames = new Set(desired.map((agent) => agent.agentName));
    const runningNames = new Set(running.map((agent) => agent.agentName));
    const toStart = desired.filter((agent) => !runningNames.has(agent.agentName));
    const toStop = [];
    const unchanged = [];
    const outOfJurisdiction = [];
    const protectedByUnresolved = [];
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
export function deriveAccountId(issues) {
    for (const issue of issues) {
        if (issue.assigneeAccountId)
            return issue.assigneeAccountId;
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
export function findNearMisses(diagnostic, projects) {
    const misses = [];
    for (const issue of diagnostic) {
        if (issue.assigneeAccountId)
            continue;
        const key = issue.key.trim();
        if (!key)
            continue;
        if (!projects.has(projectOf(key)))
            continue;
        misses.push({
            key,
            statusName: issue.statusName,
            issueTypeName: issue.issueTypeName
        });
    }
    return misses;
}
/** `KAN-256` → `KAN`. Empty for anything not shaped like a Jira key. */
export function projectOf(key) {
    const upper = key.trim().toUpperCase();
    if (!JIRA_KEY.test(upper))
        return '';
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
export function fleetProjects(board, running) {
    const projects = new Set();
    for (const issue of board) {
        const project = projectOf(issue.key);
        if (project)
            projects.add(project);
    }
    for (const agent of running) {
        const project = projectOf(agent.key);
        if (project)
            projects.add(project);
    }
    return projects;
}
/**
 * Why {@link BOARD_JQL} did not return `agent`'s **address** — decided from
 * evidence.
 *
 * **It takes the agent, not its key, and that is load-bearing rather than
 * convenience (KAN-470).** The question this function answers has to be the
 * question {@link computeBoardDiff} asked, and the diff asks about `type` and
 * `key` together. For 44 hours it was handed a bare `key`, answered a question
 * about the ticket, and reported that answer as though it were about the agent —
 * which is how a correctly-returned board row became 1307 log lines blaming
 * Jira's search index. A key is a string and an address is a string, so nothing
 * caught it; taking the {@link RunningAgent} is what makes the wrong question
 * unaskable. See the header section `queries-disagree` HAS FIRED.
 *
 * `desired` is the partitioned query's own resolved rows — what the diff
 * actually compared against — so the first branch is settled without consulting
 * the diagnostic at all.
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
export function explainAbsence(agent, desired, diagnostic, accountId) {
    const wanted = agent.key.trim().toUpperCase();
    // FIRST, AND BEFORE THE DIAGNOSTIC IS EVEN CONSULTED (KAN-470).
    //
    // This branch is decided from the *partitioned* result the diff itself was
    // computed from, so it needs no second query and cannot be wrong about one.
    //
    // Every branch below asks the diagnostic about a KEY. The diff that produced
    // this candidate asked about an ADDRESS — type and key together, never key
    // alone (KAN-83) — so a key whose board row resolves to a *different* type
    // reaches those branches with its status right, its assignee right, and no
    // explanation left, and falls out of the bottom as `queries-disagree`: a
    // claim that Jira contradicted itself, made about a query that answered
    // correctly both times. That is not hypothetical; it is what ran 1307 times
    // over 44 hours on `task/KAN-117` while `story/KAN-117` held the key. See the
    // header section `queries-disagree` HAS FIRED.
    //
    // Taking the agent rather than its key is the half that stops this recurring:
    // a later branch cannot silently ask about a key again, because a key is no
    // longer what this function is given.
    const sameKeyOtherType = desired.find((row) => row.key.trim().toUpperCase() === wanted && row.agentName !== agent.agentName);
    if (sameKeyOtherType) {
        return {
            condition: 'same-key-other-type',
            statusName: sameKeyOtherType.statusName,
            // The partitioned query's rows all satisfy `assignee = currentUser()`, so
            // this is known to be this machine's — but `DesiredAgent` does not carry
            // the display name, and inventing one here is the exact habit this whole
            // module exists to break.
            assignee: null,
            detail: `\`${BOARD_JQL}\` DID return ${wanted} this cycle — as a ` +
                `${sameKeyOtherType.issueTypeName}, so the board wants ` +
                `\`${sameKeyOtherType.agentName}\` and that is the agent it is asking for. What it ` +
                `did not return is THIS address, \`${agent.agentName}\`: agents are matched on type ` +
                `AND key together and never on key alone (KAN-83), so a second agent on the same key ` +
                `with a different type can never be in the desired list while the board says ` +
                `${sameKeyOtherType.issueTypeName}. Nothing is wrong with Jira, nothing is wrong with ` +
                `the ticket, and the two searches did not disagree — this is one key with two agents ` +
                `on it. The board was never asked whether this second agent should stop, and an issue ` +
                `type is not an instruction to kill a pane no ticket mentioned (KAN-470)`
        };
    }
    if (!diagnostic) {
        return {
            condition: 'undetermined',
            statusName: null,
            assignee: null,
            detail: `this daemon's partitioned board query did not return it, and the diagnostic query ` +
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
            detail: `the board does not have it In Progress or In Review under any assignee — ` +
                `it was returned by neither \`${BOARD_JQL}\` nor \`${BOARD_DIAGNOSTIC_JQL}\``
        };
    }
    const status = row.statusName ?? 'In Progress or In Review';
    if (!row.assigneeAccountId) {
        return {
            condition: 'no-assignee',
            statusName: row.statusName,
            assignee: null,
            detail: `it IS ${status} on the board, but its assignee field is empty, and this daemon's ` +
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
            detail: `it is ${status} on the board and assigned to ` +
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
            detail: `it is ${status} AND assigned to this machine's own account, yet \`${BOARD_JQL}\` did ` +
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
        detail: `it is ${status} on the board but assigned to ${who}, compared against this machine's ` +
            `own Jira account id and different, so it is not this fleet's business however it is ` +
            `statused`
    };
}
/** One line describing a diff, for a log that is read at a glance. */
export function describeBoardDiff(diff) {
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
    if (diff.unresolved.length)
        parts.push(`${diff.unresolved.length} unresolved`);
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
const address = (agent) => `${agent.type ?? 'unknown'}/${renderedKey(agent.key)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The loop. Reads the board, computes the diff, and — only in `converge` —
 * acts on it.
 */
export class BoardReconciler {
    opts;
    jql;
    diagnosticJql;
    maxResults;
    intervalMs;
    startStaggerMs;
    timer = null;
    cycling = false;
    stopped = false;
    /**
     * The last completed cycle's health, or null when none has completed.
     *
     * Null is a third answer and not a tidier zero: the first cycle is one
     * interval away by design (see {@link start}), so for the first minute of a
     * daemon's life *"the diagnostic is fine"* and *"nobody has asked yet"* are
     * different facts, and a reader deciding whether stand-downs are working must
     * not be handed the first when the second is true. Same rule as
     * {@link BoardCycle.nearMisses}.
     */
    lastHealth = null;
    /** Consecutive cycles whose diagnostic did not answer; reset by any that does. */
    diagnosticFailures = 0;
    /** When the current run of failures began. Null exactly when the count is 0. */
    diagnosticFailingSince = null;
    constructor(opts) {
        this.opts = opts;
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
    start() {
        if (this.timer || this.stopped)
            return;
        const mode = this.readMode();
        this.opts.log(`[board] reconciler starting in ${mode} mode, every ${this.intervalMs / 1000}s. ` +
            `Query: ${this.jql}` +
            (mode === 'converge'
                ? ' — this loop WILL start and stop agents.'
                : mode === 'report'
                    ? ' — reporting only; no agent will be started or stopped.'
                    : ' — switched off; the board will not be read.'));
        this.schedule();
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    readMode() {
        try {
            return this.opts.mode();
        }
        catch {
            // A mode that cannot be read is not a licence to act on the fleet.
            return 'off';
        }
    }
    schedule() {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick().finally(() => this.schedule());
        }, this.intervalMs);
        // Unref'd like the daemon's other timers: a reconcile must not be the thing
        // keeping a shutting-down process alive.
        this.timer.unref?.();
    }
    /** One cycle, guarded against overlapping itself — see JiraPoller.tick. */
    async tick() {
        if (this.cycling) {
            this.opts.log('[board] previous cycle is still running; skipping this one.');
            return;
        }
        this.cycling = true;
        try {
            await this.reconcileOnce();
        }
        catch (e) {
            this.opts.log(`[board] cycle failed: ${e?.message ?? String(e)}`);
        }
        finally {
            this.cycling = false;
        }
    }
    /**
     * Read the board once and converge toward it. Never throws.
     *
     * Public so the daemon can run a cycle by hand and so a proof can drive
     * cycles deterministically instead of waiting on a timer.
     */
    async reconcileOnce() {
        const mode = this.readMode();
        const cycle = {
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
            this.opts.log(`[board] the board could not be read` +
                (outcome.status !== undefined ? ` (HTTP ${outcome.status})` : '') +
                `: ${outcome.error}. Converging nothing this cycle — a query that failed is ` +
                `absent data, not an empty board, and the fleet is left exactly as it is.`);
            return cycle;
        }
        // The same guard, pointed at the other input. An exception out of the
        // census would otherwise be caught by tick() and look like a quiet cycle;
        // an empty census mistaken for a real one would make every desired agent
        // look missing and start a second copy of a fleet that already exists.
        let running;
        try {
            running = this.opts.runningAgents();
        }
        catch (e) {
            const detail = e?.message ?? String(e);
            cycle.refusal = { reason: 'fleet-unreadable', detail };
            this.opts.log(`[board] the running fleet could not be read: ${detail}. Converging nothing ` +
                `this cycle — see waitForHerdr in reconcile.ts for the same distinction.`);
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
        let diagnostic = null;
        // Null exactly when this cycle ended up with usable evidence. KAN-343
        // counts *cycles that produced none*, which is deliberately wider than
        // *queries that failed*: a read that answered and then threw on the way to
        // `cycle.absences` leaves the loop in the identical state — every candidate
        // `undetermined`, every stand-down withheld — and a streak that only
        // counted query failures would report a healthy evidence channel while the
        // fleet stopped shrinking, which is this ticket's whole defect wearing the
        // other failure's clothes.
        let diagnosticFailure = null;
        try {
            // Computed here rather than inside `readDiagnostic` because it is the
            // same set twice: the scope the query is asked in, and the scope
            // `findNearMisses` filters by. Deriving it once is what makes the
            // server-side filter provably the client-side one rather than a second
            // rule that has to be kept in step (KAN-343).
            const projects = fleetProjects(outcome.issues, running);
            const read = await this.readDiagnostic(projects);
            if ('issues' in read)
                diagnostic = read.issues;
            else
                diagnosticFailure = read.failure;
            const accountId = deriveAccountId(outcome.issues);
            if (diagnostic) {
                cycle.nearMisses = findNearMisses(diagnostic, projects);
            }
            for (const agent of diff.toStop) {
                cycle.absences.push({
                    agentName: agent.agentName,
                    key: agent.key,
                    // The agent and the desired list, never the bare key: this call is
                    // explaining `diff`'s verdict and must be asked `diff`'s question
                    // (KAN-470).
                    reason: explainAbsence(agent, diff.desired, diagnostic, accountId)
                });
            }
        }
        catch (e) {
            // Deliberately not a refusal: the diff above is untouched and still
            // correct, so the loop goes on to act on it with worse log lines.
            cycle.absences.length = 0;
            diagnosticFailure = `the diagnostic reporting threw: ${e?.message ?? String(e)}`;
            this.opts.log(`[board] the diagnostic reporting failed: ${e?.message ?? String(e)}. Convergence is ` +
                `unaffected and proceeds on the diff already computed; stand-down lines this cycle ` +
                `will report an undetermined reason rather than guessing one.`);
        }
        this.noteDiagnostic(diagnosticFailure);
        // ------------------------------------------------------ absence or intent --
        //
        // KAN-342. `diff.toStop` is every running agent whose ADDRESS the
        // partitioned query did not return — type and key together, which is not
        // the same set as "every agent whose key it did not return" and the gap
        // between the two is KAN-470. It is a question rather than an answer: the
        // board may have said "stop", or it may have said nothing at all. This is where the two
        // are separated, and it is the only gate between a candidate and a killed
        // pane. See the header section AN ABSENT ASSIGNEE PROTECTS TOO.
        const { standDowns, spared } = partitionStandDowns(diff.toStop, cycle.absences);
        cycle.spared = spared;
        // KAN-343. Published, not merely logged — see {@link BoardHealth}. Recorded
        // here rather than after the acting below because it describes what this
        // cycle *decided*, and a stand-down that then failed to take effect is
        // already `stopped[].outcome`'s business; folding the two would make one
        // field answer two questions badly.
        this.lastHealth = {
            diagnostic: this.diagnosticHealth(),
            agents: spared.map(({ agent, reason }) => ({
                agentName: agent.agentName,
                type: agent.type,
                key: renderedKey(agent.key),
                condition: reason.condition
            })),
            at: new Date().toISOString()
        };
        this.report(diff, mode, cycle, standDowns);
        if (mode !== 'converge')
            return cycle;
        if (!standDowns.length && !diff.toStart.length)
            return cycle;
        cycle.converged = true;
        // Stand-downs first: everything here is desired-off, so doing it now is not
        // a sacrifice for room — it just happens to leave room. See the header.
        for (const { agent, reason } of standDowns) {
            let stood;
            try {
                stood = await this.opts.deactivate(agent);
            }
            catch (e) {
                stood = { success: false, error: e?.message ?? String(e) };
            }
            cycle.stopped.push({ agent, outcome: stood });
            // The second half of KAN-256, and the one actually read during the
            // incident: this is the line that appears when the agent is already gone,
            // so it is where an operator starts. It carried the same unconditional
            // sentence as the line above and was wrong in exactly the same way.
            this.opts.log(stood.success
                ? `[board] stood down ${address(agent)}: ${reason.detail}.`
                : `[board] could not stand down ${address(agent)}: ${stood.error ?? 'no reason given'}`);
        }
        let startedCount = 0;
        for (const agent of diff.toStart) {
            if (startedCount > 0 && this.startStaggerMs > 0)
                await delay(this.startStaggerMs);
            startedCount++;
            let started;
            try {
                started = await this.opts.activate(agent);
            }
            catch (e) {
                started = { success: false, error: e?.message ?? String(e) };
            }
            cycle.started.push({ agent, outcome: started });
            if (started.success) {
                this.opts.log(`[board] started ${address(agent)}: ${agent.key} is ${agent.statusName ?? 'in flight'}.`);
            }
            else if (started.refusedBy === 'capacity') {
                // Reported and retried, never queued and never forced. The refusal is
                // the gate's own words, arithmetic included (KAN-60).
                this.opts.log(`[board] ${address(agent)} is wanted by the board and cannot start right now. ` +
                    `It stays desired and will be tried again next cycle; nothing was preempted ` +
                    `and nothing was overridden.\n${started.error ?? ''}`);
            }
            else {
                this.opts.log(`[board] could not start ${address(agent)}: ${started.error ?? 'no reason given'}` +
                    (started.refusedBy ? ` (refused by ${started.refusedBy})` : ''));
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
        const deferred = cycle.started.filter((s) => !s.outcome.success && s.outcome.refusedBy === 'capacity');
        if (deferred.length) {
            const startedOk = cycle.started.filter((s) => s.outcome.success).length;
            this.opts.log(`[board] converged to ${startedOk} of ${diff.toStart.length} wanted start(s): the ` +
                `machine would not carry ${deferred.length} of them yet — ` +
                `${deferred.map((s) => address(s.agent)).join(', ')}. Each stays desired and is ` +
                `retried next cycle; nothing was queued, preempted or overridden. The board is a ` +
                `statement of what is wanted, and this loop converges toward it at a rate the ` +
                `machine survives rather than jumping to it (KAN-258).`);
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
    async readDiagnostic(projects) {
        // Scoped to the projects this fleet is in (KAN-343). See
        // {@link scopedDiagnosticJql} for why this cannot lose a row
        // {@link explainAbsence} needs, and why it is not a narrowing of the answer.
        const jql = scopedDiagnosticJql(this.diagnosticJql, projects);
        try {
            const outcome = await this.opts.jira.searchBoard(jql, this.maxResults);
            if (outcome.ok)
                return { issues: outcome.issues };
            this.opts.log(`[board] the diagnostic query could not be read: ${outcome.error}. Convergence is ` +
                `unaffected — this query never starts or stops anything — but stand-down lines this ` +
                `cycle cannot name which condition a missing ticket failed, and will say so. ` +
                `Query: ${jql}`);
            return { failure: outcome.error };
        }
        catch (e) {
            const detail = e?.message ?? String(e);
            this.opts.log(`[board] the diagnostic query threw: ${detail}. Convergence is ` +
                `unaffected; stand-down lines this cycle will report an undetermined reason.`);
            return { failure: detail };
        }
    }
    /**
     * Advance the failure streak by one cycle's outcome.
     *
     * `detail` is null when the cycle ended with usable evidence, and **any**
     * such cycle resets the run to zero — the streak is *consecutive* failures
     * rather than a total, because the question a reader has is "are stand-downs
     * working right now", not "have they ever not been". A total that never came
     * down would make a daemon that had one bad minute a week ago
     * indistinguishable from one whose diagnostic has been dead since boot, which
     * is the distinction this field exists to draw.
     */
    noteDiagnostic(detail) {
        if (detail === null) {
            this.diagnosticFailures = 0;
            this.diagnosticFailingSince = null;
            return;
        }
        if (this.diagnosticFailures === 0)
            this.diagnosticFailingSince = new Date().toISOString();
        this.diagnosticFailures++;
        this.lastDiagnosticDetail = detail;
    }
    /** The last diagnostic failure's own words; only read while a streak is live. */
    lastDiagnosticDetail = '';
    diagnosticHealth() {
        if (this.diagnosticFailures === 0)
            return { answered: true, consecutiveFailures: 0 };
        return {
            answered: false,
            consecutiveFailures: this.diagnosticFailures,
            // Non-null whenever the count is non-zero, by `noteDiagnostic`'s own
            // arithmetic — the two move together and nothing else writes either.
            failingSince: this.diagnosticFailingSince ?? new Date().toISOString(),
            detail: this.lastDiagnosticDetail
        };
    }
    /**
     * What the last completed cycle can say about its own evidence, or null when
     * none has completed.
     *
     * Public because this is the KAN-343 fix: `daemon.ts` hands it to
     * `board-control.ts`, which puts it on the `butchr_list_agents` response.
     * A getter rather than a field so that a caller cannot hold a reference that
     * silently stops updating — the object is replaced each cycle, never mutated.
     */
    health() {
        return this.lastHealth;
    }
    /** Say what the cycle sees, whether or not it is allowed to act on it. */
    report(diff, mode, cycle, standDowns) {
        const verb = mode === 'converge' ? 'converging' : 'would converge';
        this.opts.log(`[board] ${describeBoardDiff(diff)}` +
            (cycle.spared.length
                ? `, of which ${standDowns.length} the board asked to stop and ${cycle.spared.length} ` +
                    `it did not mention`
                : '') +
            `.`);
        // KAN-343. The log said the diagnostic had failed; it could not say *for how
        // long*, because each cycle wrote the same sentence and the difference was
        // visible only to somebody counting them. One failure is the narrow window
        // KAN-342 priced in. A run of them is stand-downs being off, and the run is
        // the fact worth reading. This is still a log line and still not the fix —
        // `health` on the `butchr_list_agents` response is — but a reader who does
        // reach the log should not have to do the arithmetic by hand.
        const health = this.lastHealth;
        if (health && !health.diagnostic.answered && health.diagnostic.consecutiveFailures > 1) {
            this.opts.log(`[board] the diagnostic has not answered for ${health.diagnostic.consecutiveFailures} ` +
                `consecutive cycles, since ${health.diagnostic.failingSince}. No agent can be stood ` +
                `down while that lasts (KAN-342), so the fleet will not shrink and the capacity gate ` +
                `will start refusing real work. This is reported on the butchr_list_agents response ` +
                `as boardControl.health — go and read it there rather than counting these lines ` +
                `(KAN-343). Last reason: ${health.diagnostic.detail}`);
        }
        for (const issue of diff.unresolved) {
            this.opts.log(`[board] ${issue.key}: ${issue.reason}. Starting nothing for it, and standing ` +
                `nothing down on that key either — an unknown type is an unanswered question, ` +
                `not an instruction to stop.`);
        }
        for (const agent of diff.protectedByUnresolved) {
            this.opts.log(`[board] ${address(agent)} is running and not in the desired list, but its key ` +
                `appears on the board with a type this daemon cannot resolve; leaving it alone.`);
        }
        for (const agent of diff.outOfJurisdiction) {
            this.opts.log(`[board] ${address(agent)} is outside this query's jurisdiction — a Jira issue ` +
                `search can never describe it — so this loop has no opinion about it.`);
        }
        for (const agent of diff.toStart) {
            this.opts.log(`[board] ${verb}: start ${address(agent)} (${agent.issueTypeName}, ${agent.statusName}).`);
        }
        // The near-miss report (KAN-256). Every cycle, whether or not anything is
        // being stood down, and whether or not an agent exists for the key — the
        // ticket nobody is running is exactly the one no other line would mention.
        for (const miss of cycle.nearMisses ?? []) {
            this.opts.log(`[board] ${miss.key} is ${miss.statusName ?? 'In Progress or In Review'} on the board ` +
                `with NO ASSIGNEE, so this daemon's query cannot see it: it will not be started, and ` +
                `if an agent for it is running it will be stood down. Assign it to this machine's Jira ` +
                `account to staff it. (KAN-256; this line is a report, not an action — nothing about ` +
                `this ticket has been started or stopped.)`);
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
            this.opts.log(supervisor
                ? `[board] ${verb}: STAND DOWN SUPERVISOR ${address(agent)} — ${detail}. ` +
                    `Supervisors are not exempt from this rule (KAN-221); to keep one running, its ` +
                    `ticket has to say so.`
                : `[board] ${verb}: stop ${address(agent)} — ${detail}.`);
        }
        // The spared. No supervisor variant, deliberately: the loud line above
        // exists because an agent nobody else reports on is about to be destroyed,
        // and nothing is being destroyed here. Special-casing a type in a line that
        // reports *inaction* would be the visibility-instead-of-behaviour trade
        // KAN-221 made and KAN-342 is here to undo.
        for (const { agent, reason } of cycle.spared) {
            this.opts.log(
            // "did not return this type and key together" rather than the old "did
            // not return it" (KAN-470). The old wording said the query had not
            // returned the *ticket*, which for `same-key-other-type` is flatly
            // false — the query returned it, under the other type. The precise
            // clause is true of every condition here, because `toStop` is computed
            // by address and never by key.
            `[board] ${address(agent)} is running and \`${this.jql}\` did not return this type ` +
                `and key together (agents match on both, never on key alone — KAN-83), but ` +
                `nothing established that anybody asked it to stop — ${renderedKey(agent.key)}: ` +
                `${reason.detail}. Leaving it running: this loop honours what the board says, and an ` +
                `absent field has not said anything (KAN-342, condition \`${reason.condition}\`).`);
        }
    }
}
