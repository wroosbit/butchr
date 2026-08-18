import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
import { agentNameFor } from './herdr.js';
import { repoSourcePhrase, discoverRepos, mergeabilityOf } from './github.js';
import { refuseWithoutCarrier } from './notify.js';
import { DAEMON_SENDER_TAG } from './provenance.js';
/**
 * ---------------------------------------------------------------------------
 * Watching the pull requests behind the tickets (KAN-304).
 * ---------------------------------------------------------------------------
 *
 * `JiraPoller` watches what a ticket *says*. Nothing watched what a ticket
 * *produces*, and the six things that cost this board a day are all on the other
 * side of that line. From the ticket, every row observed on 2026-08-11 and every
 * one caught only because a human or a supervisor happened to look:
 *
 *   - a PR merged and its ticket left In Review — **three times in one day**;
 *   - a PR green with an empty `reviewDecision`, sitting unmerged for most of
 *     an hour while its approver worked on something else;
 *   - an approval landing with nothing to tell the agent that had stopped to
 *     wait for it;
 *   - a PR going BEHIND on a `strict: true` branch, where an approval does not
 *     survive its head;
 *   - a new PR comment — the case `task/KAN-280` hand-rolled in a bash loop,
 *     which worked, and which died with the agent that wrote it;
 *   - checks going red after the branch moved.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * **Not a second source of truth.** `gh pr list` stays authoritative. This holds
 * only enough of the last read to answer "is this new?", it answers no queries
 * about pull requests, and {@link PrWatchState} is a change-detector rather than
 * a cache.
 *
 * **Not a second audience model.** `epic/KAN-39` promoted that from a design
 * note to a requirement: the recipients here are `own` / `supervisor` / `parent`
 * / `linked`, most-specific-relation-wins, told once — the same four relations
 * `jira-poll.ts` computes, resolved off the same Jira snapshot the poller has
 * already read. {@link NudgeRelation} is imported from that module rather than
 * redeclared, so the two cannot drift.
 *
 * **Not an actor.** It watches and it tells. Merging, approving and transitioning
 * stay with the governance in `prompts/task.md` — the approver approves, the task
 * agent merges — and nothing here does any of them.
 *
 * ---------------------------------------------------------------------------
 * IT RIDES THE CHANNEL. THAT IS A HARD CONDITION AND NOT A PREFERENCE.
 * ---------------------------------------------------------------------------
 *
 * KAN-301 removed pane insertion from the daemon's two notification producers on
 * the human's instruction — *"we need to completely drop the practice"* — the
 * day before this was filed. A PR watcher built on `deliverToAgent` would be a
 * **fourth** composer-interrupting caller, and its interrupt would land on the
 * agent working the very pull request being announced: a Ctrl+C that renders to
 * that agent as its operator refusing something.
 *
 * So this is a second producer against the {@link NotifyFn} seam and contains no
 * delivery code at all. `verify-notifications-never-type.mjs` §AC1a reads every
 * composer reach in `daemon/src` against a declared allowlist and this module is
 * deliberately not on it; §AC1b asserts that `daemon.ts` hands the channel-only
 * carrier to **all three** producers.
 *
 * ---------------------------------------------------------------------------
 * THE WATCH SET DRAINS WITH THE FLEET, AND THE APPROVER IS NEVER IN IT (KAN-360)
 * ---------------------------------------------------------------------------
 *
 * `discoverRepos` reads the repositories out of live agents' checkouts, which is
 * the right primary path and has one property nobody had stated: **no supervisor
 * holds a checkout.** Measured on this machine 2026-08-12 — `epic/kan-39`,
 * `epic/kan-203`, `epic/kan-59`, none of them has one — because only task agents
 * make worktrees. So the set is built entirely by the agents a PR notification
 * is *not* for, and emptied by them standing down:
 *
 *   1. a task agent opens a pull request and finishes;
 *   2. it stands down, and its worktree was the only thing holding that
 *      repository in the set;
 *   3. the repository leaves the set;
 *   4. **the approver — still running, still responsible, holding no checkout —
 *      stops being told anything about that pull request;**
 *   5. the report says *"Watching 1 repository"* and nothing about having watched
 *      two an hour ago.
 *
 * Observed as readings 35 minutes apart: `crabcast + butchr` → `butchr` only, as
 * CrabCast's last live checkout went away. The shape is the wrong way round for
 * an unattended fleet — the quiet hours are when a pull request sits longest and
 * when the watcher covers least.
 *
 * WHAT WAS CHOSEN, AND WHAT WAS NOT
 *
 * **Chosen: retain a repository while the watcher's own durable memory says
 * something there is still OPEN** — {@link PrWatchState.reposWithOpenPr}, unioned
 * with discovery in {@link PrWatcher.resolveRepos}, each entry carrying the
 * {@link RepoSource} it arrived by. It is derived from *responsibility* rather
 * than from possession, it survives a daemon restart because the memory is
 * durable, and it releases by itself when the last open pull request merges or
 * closes.
 *
 * **Rejected: `BUTCHR_PR_WATCH_REPOS` as the answer.** It is kept and it is now
 * documented (`docs/pr-watch-coverage.md`), but a list somebody has to maintain
 * is a list that does not name the repository nobody thought of, and a variable
 * set once on one machine is this ticket again after the next rebuild. It is an
 * override, not coverage — so it is a floor here rather than a ceiling: naming
 * repositories in it does not switch retention off, because "watch exactly these
 * and nothing else" would reintroduce the blindness for anything opened later.
 *
 * **Rejected: derive the set from what each supervisor is responsible for.** It
 * is the more faithful idea and it is not buildable, for a stated reason rather
 * than a cost: **nothing maps a ticket to a repository.** Jira carries no such
 * field, and KAN-360's own description names `wroosbit/butchr` in *prose*. The
 * only route from a supervisor to a repository runs through the agents under it,
 * which is the checkout path again and drains at exactly the same moment. What
 * survives of the idea is its principle, and the retention rule is that
 * principle applied to the one durable responsibility signal the daemon actually
 * holds: an open pull request whose branch names a ticket of this fleet's.
 *
 * WHAT RETENTION STILL DOES NOT COVER, stated because it looks total
 *
 *   - **A pull request no tick ever saw open.** Retention is self-sustaining,
 *     not self-starting: the repository has to be watched once, with the PR
 *     open, for the memory to exist. An agent that opens a PR and stands down
 *     inside one 60s tick — or one that opens it while the daemon is down and is
 *     gone before it returns — leaves nothing behind to retain.
 *   - **A repository nobody has ever worked in.** By construction.
 *
 * Both are what `BUTCHR_PR_WATCH_REPOS` is for, and both are why it was kept
 * rather than deleted.
 *
 * ---------------------------------------------------------------------------
 * A NOTICE MUST NOT CLAIM THE PRESENT FROM EVIDENCE ABOUT THE PAST (KAN-367)
 * ---------------------------------------------------------------------------
 *
 * At 02:45Z on 2026-08-13 this watcher told `epic/KAN-59`:
 *
 *   > `wroosbit/CrabCast#86` has **MERGED**, and KAN-361 **is still In Review**
 *
 * Read from the Jira changelog and `gh` rather than from anyone's recollection:
 *
 *   23:37:04Z  KAN-361  In Progress -> In Review
 *   23:53:31Z  PR #86   MERGED
 *   23:53:58Z  KAN-361  In Review -> Done      <- 27 SECONDS after the merge
 *   02:45Z     the notice arrives saying "is still In Review"
 *
 * **The state claim was wrong by two hours and fifty-one minutes, and it was
 * made in the present tense.** Both halves of the sentence were derived from
 * evidence, and both were stale; only the second was phrased as though it were
 * being observed as it was said.
 *
 * TWO SEPARABLE DEFECTS, AND FIXING THE FIRST DOES NOT FIX THE SECOND
 *
 *   1. **Coverage.** `prWatch` was not watching CrabCast when #86 merged, so the
 *      merge was announced three hours late, on the tick after an unrelated
 *      agent's checkout put the repository back in the set. That is KAN-360's
 *      subject, and KAN-360 shipped: the repository is now RETAINED while the
 *      memory says something in it is open, so this exact trigger no longer
 *      fires. It is not the only way to lose a look — a daemon that is down and
 *      a GitHub that is unreachable both produce the same gap, and the recovery
 *      path says so itself: *"anything that changed while it was not is diffed
 *      against the memory and announced now."*
 *   2. **Tense.** Any delay between an event and its delivery makes a
 *      present-tense claim a guess. **Perfect coverage would not fix this**, and
 *      it is the cheaper of the two by a wide margin.
 *
 * WHERE THE STALE `In Review` CAME FROM — mechanism, not candidate
 *
 * Not a state captured when the PR row was first seen and carried with it: the
 * status is read where the event is constructed, on the tick that recognises the
 * merge. It was read *fresh from a memory that was itself three hours old*.
 * `jira-poll.ts` polls **only live agents' issues**; `task/KAN-361` stood down
 * after merging, so KAN-361 stopped being polled, and its row froze at `In
 * Review` — held for a week by `STATE_TTL_MS`, whose docblock says outliving the
 * agent is the point. `factsFor` then returned the status as a **bare string**
 * with `seenAt` sitting one field away.
 *
 * THE RULE THIS ENFORCES, and it is a type rather than a convention
 *
 *   **Every state claim in a notice is either present-tense and freshly read, or
 *   past-tense and timestamped. There is no third option.**
 *
 * A bare string is the third option, so the bare string is gone:
 * {@link ObservedState} carries the moment it was read and has no untimed
 * spelling, and {@link PrEvent.observation} is **required**, so an event cannot
 * be constructed without saying whether it was seen live or backfilled after a
 * gap. Deleting the disclosure is a compile error rather than a quieter notice.
 */
/**
 * How often to look.
 *
 * Sixty seconds, matching `JiraPoller` — and for a different reason, which is
 * worth stating because the poller's reason no longer applies to either of us.
 * Its interval was chosen as "how often may this interrupt the fleet?", back
 * when every notification opened with a Ctrl+C. Since KAN-301 nothing here
 * interrupts anybody, so the pacing question is only about GitHub's budget and
 * about how stale a notice may be.
 *
 * THE RATE-LIMIT ARITHMETIC, MEASURED RATHER THAN ESTIMATED
 *
 * One `gh pr list` per repository per tick, covering every field the watcher
 * needs for the last forty pull requests in every state. Measured against the
 * real repository while this was written: **3 GraphQL rate-limit points for 30
 * pull requests**. GitHub's ceiling is 5,000 points per hour.
 *
 *   1 repo × 3 points × 60 ticks/hour = 180 points/hour = 3.6% of budget
 *
 * The fleet works in one repository today and the discovery in `github.ts` is
 * bounded by the number of *distinct* checkouts live agents hold, not by the
 * number of agents. Ten repositories would still be 36% of budget, and
 * {@link DEGRADED_PR_POLL_INTERVAL_MS} is what makes being wrong survivable.
 */
export const PR_POLL_INTERVAL_MS = 60_000;
/**
 * The interval a rate-limited or unreachable GitHub gets instead.
 *
 * Five minutes, the same concession `jira-poll.ts` makes and for the same
 * reason: degrading to *silence* would make this a watcher nobody can trust to
 * be running, which is the failure the ticket names as worse than having none.
 * Both the degrade and the recovery are logged and both are visible in
 * {@link PrWatchHealth}.
 */
export const DEGRADED_PR_POLL_INTERVAL_MS = 300_000;
/** Where last-seen pull request state lives, beside the poller's own. */
export const PR_STATE_PATH = path.join(BUTCHR_DIR, 'pr-watch.json');
/** How long a pull request's memory is kept after it stops being seen. */
export const PR_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * THE ASSOCIATION RULE: a pull request belongs to the ticket its head branch
 * names.
 *
 * The ticket left this open — branch name, PR title prefix and Jira's
 * development panel all defensible, none authoritative — and asked for a choice
 * with a reason. This is the choice.
 *
 * **Why the branch.** It is the one signal the system *creates* rather than
 * types: `prompts/task.md` mandates `git worktree add … -b butchr/KAN-NNN`, so
 * every task agent produces it mechanically. It is also immutable for the life
 * of the pull request, where a title can be edited at any moment — and an edited
 * title would silently **re-associate** a PR already being watched, or
 * de-associate one, with no event and no trace. Watching the wrong ticket is
 * worse than watching none, and only the branch cannot do that.
 *
 * **Why not the development panel.** It needs a Jira↔GitHub integration this
 * site does not have, and it would make GitHub state reachable only through
 * Jira — a second hop failing independently of the first.
 *
 * **Why the suffix is optional, which is not tidiness.** The first draft of this
 * was `^butchr\/(KAN-\d+)$`, and the real branch list refutes it: of the four
 * most recent pull requests at the time of writing, `butchr/KAN-306-gate-demo`
 * and `butchr/KAN-295-ci-main` both carry a suffix and both belong to the ticket
 * they name. A strict match would have silently unwatched two real PRs — this
 * ticket's own failure, committed in its own subject matter.
 */
export const BRANCH_ASSOCIATION = /^butchr\/([A-Z][A-Z0-9]*-\d+)(?:-.*)?$/;
/** The ticket a branch names, or null when it names none. */
export function issueKeyForBranch(branch) {
    const match = BRANCH_ASSOCIATION.exec((branch ?? '').trim());
    return match ? match[1].toUpperCase() : null;
}
/**
 * The repository half of a `owner/name#number` memory key.
 *
 * `#` cannot occur in a GitHub owner or repository name, so the split is exact
 * rather than a guess — and it is done here, once, because a second spelling of
 * it somewhere else is how the retention set and the report would come to
 * disagree about what a row is.
 */
export function repoOfPrId(id) {
    const hash = id.lastIndexOf('#');
    if (hash <= 0)
        return null;
    const repo = id.slice(0, hash);
    return repo.includes('/') ? repo : null;
}
/** The two blockers a `head-stale` notice is for. See where it is raised. */
export function isStaleMergeability(mergeability) {
    return mergeability === 'conflicted' || mergeability === 'behind';
}
/**
 * The one place that decides it. Every sentence about whether a pull request
 * needs a reviewer is composed from this and from nothing else.
 */
export function readinessOf(pr) {
    if (pr.state !== 'OPEN') {
        return { ready: false, blocker: 'not-open', reason: `is ${pr.state.toLowerCase()}` };
    }
    if (pr.isDraft)
        return { ready: false, blocker: 'draft', reason: 'is still a draft' };
    // Mergeability first, because a conflicted pull request is not made ready by
    // anything else being true of it — which is exactly what the 15:58:53Z notice
    // got wrong.
    const mergeability = mergeabilityOf(pr.mergeStateStatus);
    if (mergeability === 'conflicted') {
        return {
            ready: false,
            blocker: 'conflicted',
            reason: 'CONFLICTS with main — that needs the conflict resolved by hand, and no review and no ' +
                '`update-branch` can clear it'
        };
    }
    if (mergeability === 'behind') {
        return {
            ready: false,
            blocker: 'behind',
            reason: 'is BEHIND main — `gh pr update-branch` fixes it, and because that changes the head, an ' +
                'approval given before it does not survive'
        };
    }
    if (mergeability === 'unknown') {
        return {
            ready: false,
            blocker: 'mergeability-unknown',
            reason: `is in merge state ${pr.mergeStateStatus} — GitHub has not told us whether this head ` +
                'merges, which is not the same as it merging'
        };
    }
    switch (pr.checks) {
        case 'none':
            return {
                ready: false,
                blocker: 'checks-absent',
                reason: 'has NO checks at this head — none have run, which is not the same as all of them ' +
                    'passing, and on a conflicted or unpushed head none ever will'
            };
        case 'pending':
            return { ready: false, blocker: 'checks-pending', reason: 'still has checks running' };
        case 'failure':
            return {
                ready: false,
                blocker: 'checks-failed',
                reason: `has failing checks: ${pr.failingChecks.join(', ') || 'unnamed'}`
            };
    }
    if (pr.approval === 'recorded' || pr.reviewDecision === 'APPROVED') {
        return {
            ready: false,
            blocker: 'already-approved',
            reason: 'already has an approval at this head, so nobody is being waited on'
        };
    }
    return { ready: true };
}
/**
 * How long an observation stays quotable in the present tense (KAN-367).
 *
 * Two minutes: one {@link PR_POLL_INTERVAL_MS} for the fact to have been read,
 * and one for this watcher's own tick to carry it. It is the smallest bound that
 * cannot call an ordinary, on-time pair of ticks a gap — a one-interval bound
 * would flap on every tick that started a second late, and a notice whose tense
 * changes with scheduler jitter teaches its reader to ignore the distinction.
 *
 * It is a **ceiling on the claim, not a promise about the fact**: inside it the
 * fact may still have changed a second ago. What the present tense asserts here
 * is *"this was read just now"*, which is all any watcher can honestly say, and
 * exactly what the 02:45Z notice asserted while being three hours old.
 */
export const PRESENT_TENSE_LIMIT_MS = 2 * PR_POLL_INTERVAL_MS;
/**
 * A duration a person reads, from milliseconds. `2h51m`, `45s`, `3d4h`.
 *
 * Exported because the notice and the proof must not spell a gap two different
 * ways — a disclosure a proof cannot match by construction is a disclosure
 * nothing checks.
 */
export function describeDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days)
        return `${days}d${hours}h`;
    if (hours)
        return `${hours}h${minutes}m`;
    if (minutes)
        return `${minutes}m${seconds}s`;
    return `${seconds}s`;
}
/**
 * The one place a state claim becomes words — AC3, enforced in a single call.
 *
 * Both branches exist and both are honest; what is *not* available is a third
 * one. The signature is why: there is no argument list here that produces a
 * sentence without an `observedAt`, so an untimed claim cannot be composed by
 * calling this, and {@link ObservedState} is the only shape a status arrives in.
 *
 * `what` is the subject (`KAN-361`), `now` the moment the sentence is being
 * written. The past-tense branch names the timestamp **and** the age: the
 * timestamp is what makes it true forever, and the age is what makes a reader
 * notice how stale it is without doing arithmetic.
 */
export function describeObservedState(what, observed, now, limitMs = PRESENT_TENSE_LIMIT_MS) {
    const observedMs = Date.parse(observed.observedAt);
    const age = Number.isFinite(observedMs) ? now - observedMs : NaN;
    // An unparseable or future timestamp is not a licence for the present tense.
    // It is the one input that could smuggle the third option back in — `NaN < x`
    // is false for every x, so an accidental `age < limit` test would have fallen
    // through to "fresh" on exactly the malformed input least worth trusting.
    if (Number.isFinite(age) && age >= 0 && age <= limitMs) {
        return `${what} is still ${observed.value} (read ${describeDuration(age)} ago)`;
    }
    return (`${what} was ${observed.value} when its status was last read, at ${observed.observedAt}` +
        (Number.isFinite(age) && age >= 0 ? ` — ${describeDuration(age)} ago` : '') +
        '. That is what was true then, and this notice does not know what it is now');
}
/**
 * The health sentence — and the whole of AC5 is that its two branches differ.
 *
 * A report whose "everything is fine" and "I have been blind for an hour" read
 * the same is the silence this ticket forbids wearing a tidier costume, so the
 * failing branch names the time, the count and the error, and does not lead with
 * anything reassuring.
 */
export function describeHealth(health, now) {
    if (!health.repos.length) {
        // AC4 OF KAN-339 AND AC4 OF KAN-360 BOTH GUARD THIS STRING, so it is
        // reproduced here unchanged to the byte. With genuinely nothing to watch —
        // no checkout, no configuration, and nothing outstanding in memory — this is
        // the whole sentence, exactly as it was.
        const inert = 'No repository is being watched: no live agent holds a checkout with a GitHub ' +
            '`origin`, and BUTCHR_PR_WATCH_REPOS is unset. Nothing about any pull request is ' +
            'being observed, which is not the same as nothing having changed.';
        // Appended, never substituted: a reader who has seen this sentence before
        // meets the same words and then learns which repositories it is being silent
        // about. Silence about a named repository is a different fact from silence
        // about nothing at all.
        return health.releasedRepos.length
            ? `${inert} Seen before and not watched now: ${health.releasedRepos.join(', ')} — nothing ` +
                'there is outstanding either (no open pull request in memory).'
            : inert;
    }
    if (!health.lastAttemptAt) {
        return (`Watching ${health.repos.map((r) => r.repo).join(', ')}; the first look has not run yet, ` +
            'so nothing is known about any pull request. This is the ordinary state for the first ' +
            'minute after a daemon start.');
    }
    // The population counts are always qualified as "as of the last successful
    // look", in BOTH branches, and that phrasing is the fix for a real defect this
    // sentence had: while GitHub was unreachable the counts fell to zero and the
    // report read "0 pull requests matched to a ticket" — which a reader takes as
    // "there are none" when the truth is "we could not look". A number that decays
    // to a clean-looking zero when observation stops is the exact silence this
    // field exists to break.
    // AND THE POPULATION IS SPLIT BY STATE, which is the second defect this
    // sentence had (KAN-339). The read is `--state all` — deliberately, because a
    // merged pull request leaves the open list and "it is gone" cannot tell merged
    // from closed — so the window is the last PR_LIST_LIMIT rows in ANY state. The
    // sentence used to report all of them as one number and read, on a repository
    // with zero open pull requests:
    //
    //   "40 pull request(s) matched a ticket, 40 of them with no live agent to
    //    tell, and 0 matched no ticket at all."
    //
    // Every figure in that was arithmetically correct and the sentence was false:
    // it reads as forty pull requests wanting attention from nobody, when nothing
    // was open and nothing wanted anything. The counters answered "how many rows
    // did I poll?" while the prose asked "how much is outstanding?". Splitting
    // them is the fix; narrowing the fetch is NOT, and must not be — see above.
    const closedRows = Math.max(0, health.watchedCount - health.openCount);
    const asOf = `As of the last successful look, ${health.openCount} OPEN pull request(s) matched a ticket, ` +
        `${health.nobodyLiveCount} of them with no live agent to tell. A further ${closedRows} ` +
        'matched row(s) in the read window are already merged or closed and are polled only so that ' +
        'a state change on one is still recognisable — they are not outstanding work. ' +
        `${health.unmatched.length} row(s) matched no ticket at all` +
        (health.unmatched.length
            ? ` (${health.unmatched.map((pr) => `${pr.repo}#${pr.number} on ${pr.headRefName}`).join(', ')})`
            : '') +
        '.';
    // EVERY REPOSITORY SAYS HOW IT GOT HERE (KAN-360, AC3).
    //
    // The sentence this replaces was `Watching 1 repository (wroosbit/butchr).`,
    // and its defect was not what it said but what it could not: on 2026-08-12 the
    // same sentence was true of a set that had been two an hour earlier, and a
    // reader had no way to notice. Provenance is the half that makes coverage
    // legible — `a live agent holds a checkout` is a fact about where the fleet is
    // sitting, and it stops being true the moment that agent stands down.
    //
    // KAN-370: the `checkout` phrase now names WHICH agent. The bare version was
    // true and uncheckable, and a reader who could not check it from the report
    // went looking with a `find` that could not see a checkout, then filed the
    // truth as a falsehood. Naming the holder is what makes the claim cheap to
    // falsify — which is the only thing that makes it worth printing.
    const seen = new Set([...health.repos.map((r) => r.repo), ...health.releasedRepos]);
    const scale = seen.size > health.repos.length ? ` of the ${seen.size} seen` : '';
    const repos = `Watching ${health.repos.length}${scale} repositor${health.repos.length === 1 ? 'y' : 'ies'}: ` +
        health.repos.map((r) => `${r.repo} (${repoSourcePhrase(r)})`).join('; ') +
        '.' +
        // The released ones, named rather than silently absent. A set that narrows
        // because the work in it finished and a set that narrows because the fleet
        // went quiet are different facts, and only one of them is fine.
        (health.releasedRepos.length
            ? ` Not watched now, and seen before: ${health.releasedRepos.join(', ')} — nothing there is ` +
                'outstanding (no live checkout, and no open pull request in memory). Anything opened ' +
                'there while nobody holds a checkout would be unobserved until somebody does.'
            : '');
    if (health.consecutiveFailures > 0) {
        const since = health.lastSuccessAt
            ? `since ${health.lastSuccessAt}, ${Math.round((now - Date.parse(health.lastSuccessAt)) / 1000)}s ago`
            : 'at any point since this daemon started';
        return (`WE HAVE NOT BEEN ABLE TO LOOK AT GITHUB ${since} — ` +
            `${health.consecutiveFailures} consecutive failed read(s). Anything that has happened to ` +
            `these pull requests in that window is UNKNOWN and has been announced to nobody. The last ` +
            `error was: ${health.lastError ?? 'unrecorded'}.` +
            (health.degraded
                ? ` Polling has slowed to ${DEGRADED_PR_POLL_INTERVAL_MS / 1000}s while GitHub asks to be ` +
                    'left alone; it has not stopped.'
                : '') +
            ` ${repos} ${asOf}`);
    }
    return (`${repos} Last looked successfully at ${health.lastSuccessAt} ` +
        `(${health.lastSuccessAt ? Math.round((now - Date.parse(health.lastSuccessAt)) / 1000) : '?'}s ` +
        `ago), so "nothing new" here means nothing new rather than nothing seen. ${asOf}`);
}
/**
 * The words a recipient receives.
 *
 * A pointer, never content — the same restraint `jiraEventNudgeText` keeps, for
 * the same reason: the PR is where the words are and where they stay current,
 * and a daemon that copies them into a message becomes a courier of text it has
 * no business holding. What it does carry is the **conjunction** a pointer
 * cannot be reconstructed from: that a merge left a ticket in In Review, that
 * green checks are waiting on a named approver.
 *
 * One message per pull request per recipient per tick, with the clauses joined —
 * KAN-207's rule, and it binds here for a reason that survived KAN-301: two
 * channel frames where one would do is two pieces of somebody's context, and
 * KAN-219 measured a single channel event and explicitly declined to say
 * anything about a burst.
 *
 * It informs and instructs nothing. Every sentence spent telling an agent to
 * *act* is a sentence that can produce another notification, another ticket
 * comment, or a reply to a daemon that is not listening.
 */
export function prEventNoticeText(events, relation, now) {
    const first = events[0];
    const pr = `${first.repo}#${first.number}`;
    const clause = (event) => {
        switch (event.kind) {
            case 'merged': {
                // The merge itself, timestamped. `has MERGED` alone reads as news
                // whether it is forty seconds or three hours old, and on 2026-08-13 it
                // was three hours old.
                const when = event.mergedAt
                    ? `MERGED at ${event.mergedAt}`
                    : 'has MERGED (GitHub reported no merge time)';
                // The ticket's status, which is a claim about a *state* and therefore
                // the one that has to carry its own age. `describeObservedState` is the
                // only way to say it, and it has no untimed branch.
                if (!event.jiraStatus || event.jiraStatus.value.toLowerCase() === 'done')
                    return when;
                return (`${when}, and ${describeObservedState(event.issueKey, event.jiraStatus, now)} — a ` +
                    'merge is not a transition, so nothing on the board will say so');
            }
            case 'closed':
                return 'was CLOSED without merging';
            case 'approved':
                return event.approvalSource === 'marker'
                    ? 'has an approval recorded at its current head (KAN-306\'s `approval-recorded` ' +
                        'status). A push after this invalidates it, because no earlier marker names the new head'
                    : 'has an approving GitHub review';
            case 'changes-requested':
                return 'has a review requesting changes';
            case 'green-idle':
                // Every clause here is a thing `readinessOf` had to establish before this
                // event could exist — checks that RAN and passed, and a head GitHub has
                // positively said merges. Before KAN-339 this sentence asserted the first
                // on the strength of nothing having failed and did not mention the
                // second at all, and it was wrong about both on `#153`.
                return ('has checks green at this head, a head GitHub reports as merging cleanly, and NO ' +
                    'approval recorded, so nothing is blocking it except a review that has not happened — ' +
                    '`approval-recorded` is the required status that is still red');
            case 'checks-failed':
                return `has failing checks: ${(event.failingChecks ?? []).join(', ') || 'unnamed'}`;
            case 'head-stale':
                // Two states, two different pairs of hands. Collapsing them into one
                // sentence told a reader that something was wrong and not who could fix
                // it, which on a conflicted PR sent the approver rather than the author.
                switch (event.mergeability) {
                    case 'conflicted':
                        return ('CONFLICTS with main — this needs the conflict resolved by hand on the branch. ' +
                            'No review clears it and `gh pr update-branch` cannot either, and until it is ' +
                            'resolved no workflow will run at this head');
                    case 'behind':
                        return ('is BEHIND main — `gh pr update-branch` fixes it. That changes the head, so any ' +
                            'approval given against the old one no longer names it');
                    default:
                        return (`is ${event.mergeStateStatus ?? 'not mergeable'} against main — on a strict branch ` +
                            'an approval does not survive its head');
                }
            case 'comment':
                return (event.newComments ?? 1) > 1
                    ? `has ${event.newComments} new comments`
                    : 'has a new comment';
        }
    };
    // One sentence each, because four relations are four different reasons to be
    // told and a recipient that cannot tell which applies cannot judge whether the
    // news is its business.
    const whose = {
        own: `It is the pull request for your own ticket ${first.issueKey}.`,
        supervisor: `You activated the agent working ${first.issueKey}.`,
        parent: `${first.issueKey} sits under your ticket on the board, so you are its approver.`,
        linked: `${first.issueKey} is linked to a ticket of yours.`
    };
    // AC4: a backfilled announcement says so, and says how big the hole was.
    //
    // It goes BEFORE the URL and after the news, because a reader who stops at the
    // first sentence has to have met it. The live case adds nothing at all — a
    // qualification on every notice is a qualification nobody reads, and the
    // distinction only means something if it is rare.
    const backfill = first.observation.live
        ? ''
        : ` BACKFILLED, not live: this pull request was not looked at between ` +
            `${first.observation.lastObservedAt} and now, a gap of ` +
            `${describeDuration(first.observation.gapMs)}, so anything above happened at some point ` +
            'in that window rather than just now.';
    return (`${DAEMON_SENDER_TAG} ${pr} (${first.headRefName}) ${events.map(clause).join('; and it ')}.` +
        `${backfill} ` +
        `${whose[relation]} ${first.url} — this is a notification, not an instruction, and no ` +
        'reply is expected.');
}
/**
 * The watcher's memory, persisted the same crash-safe way the poller's is.
 *
 * Write temp, fsync temp, rename, fsync the directory: a crash anywhere in it
 * leaves the previous file intact, so the worst case is coming back to slightly
 * older state and re-reading one interval — never a half-written file nobody can
 * reason about.
 */
export class PrWatchState {
    file;
    now;
    prs = new Map();
    loaded = false;
    constructor(file = PR_STATE_PATH, now = () => Date.now()) {
        this.file = file;
        this.now = now;
    }
    load() {
        this.loaded = true;
        let text;
        try {
            text = fs.readFileSync(this.file, 'utf8');
        }
        catch (e) {
            if (e?.code !== 'ENOENT') {
                console.error(`[pr-watch] Could not read ${this.file}: ${e?.message ?? String(e)}`);
            }
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (e) {
            console.error(`[pr-watch] ${this.file} is not readable JSON (${e?.message ?? String(e)}); starting ` +
                'from empty state. Watched pull requests will be re-initialised without notifying.');
            return;
        }
        for (const [id, value] of Object.entries(parsed?.prs ?? {})) {
            if (!value || typeof value !== 'object')
                continue;
            this.prs.set(id, {
                state: typeof value.state === 'string' ? value.state : 'UNKNOWN',
                reviewDecision: typeof value.reviewDecision === 'string' ? value.reviewDecision : '',
                // Absent in a state file written before this shipped; 'absent' is the
                // same value a pull request with no approval status carries, so an
                // upgrade re-announces nothing.
                approval: typeof value.approval === 'string' ? value.approval : 'absent',
                checks: typeof value.checks === 'string' ? value.checks : 'none',
                mergeStateStatus: typeof value.mergeStateStatus === 'string' ? value.mergeStateStatus : 'UNKNOWN',
                headRefOid: typeof value.headRefOid === 'string' ? value.headRefOid : '',
                commentIds: Array.isArray(value.commentIds)
                    ? value.commentIds.filter((id) => typeof id === 'string')
                    : [],
                greenIdleSha: typeof value.greenIdleSha === 'string' ? value.greenIdleSha : '',
                seenAt: typeof value.seenAt === 'string' ? value.seenAt : new Date(this.now()).toISOString()
            });
        }
    }
    isLoaded() {
        return this.loaded;
    }
    get(id) {
        return this.prs.get(id);
    }
    set(id, memory) {
        this.prs.set(id, memory);
    }
    /** Every row, for a proof that wants to read the memory back. */
    entries() {
        return [...this.prs.entries()];
    }
    /**
     * Every repository with a remembered pull request that was OPEN when last
     * read — **the retention rule of KAN-360, and the whole of the fix.**
     *
     * A repository named here has outstanding work in it, established from the
     * watcher's own durable memory rather than from anybody's filesystem. That
     * matters because the memory outlives the thing discovery depends on: a task
     * agent's worktree vanishes when it stands down, and this file does not.
     *
     * IT SELF-RELEASES, WHICH IS WHY IT IS SAFE. The tick that sees the pull
     * request merge writes `MERGED` here, so the repository drops out of the set
     * on the tick after the one that announced the merge — nothing is retained
     * because it was once interesting, only while something is actually open.
     * That is the difference between this and "watch it forever", which would pay
     * GitHub three rate-limit points a minute in perpetuity for every repository
     * anybody ever touched.
     */
    reposWithOpenPr() {
        const repos = new Set();
        for (const [id, memory] of this.prs) {
            if (memory.state !== 'OPEN')
                continue;
            const repo = repoOfPrId(id);
            if (repo)
                repos.add(repo);
        }
        return [...repos].sort();
    }
    /**
     * Every repository this memory has seen at all, in any state.
     *
     * Not a watch set — it is what lets the report say *"watching 1 of the 2
     * repositories seen"* rather than *"watching 1 repository"*. `epic/KAN-203`
     * asked for exactly that sentence, and the reason is that the current one
     * gives a reader no way to notice the set shrank.
     */
    knownRepos() {
        const repos = new Set();
        for (const id of this.prs.keys()) {
            const repo = repoOfPrId(id);
            if (repo)
                repos.add(repo);
        }
        return [...repos].sort();
    }
    /** Persist, dropping rows nothing has looked at in a week. Never throws. */
    save() {
        const cutoff = this.now() - PR_STATE_TTL_MS;
        for (const [id, memory] of this.prs) {
            const seen = Date.parse(memory.seenAt);
            if (Number.isFinite(seen) && seen < cutoff)
                this.prs.delete(id);
        }
        const body = JSON.stringify({ version: 1, prs: Object.fromEntries(this.prs) }, null, 2);
        const temp = `${this.file}.tmp-${process.pid}`;
        let fd;
        let dir;
        try {
            ensureButchrDir();
            fd = fs.openSync(temp, 'w', 0o600);
            fs.writeSync(fd, body + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temp, this.file);
            dir = fs.openSync(path.dirname(this.file), 'r');
            fs.fsyncSync(dir);
        }
        catch (e) {
            console.error(`[pr-watch] Could not persist ${this.file}: ${e?.message ?? String(e)}`);
            try {
                fs.unlinkSync(temp);
            }
            catch { }
        }
        finally {
            for (const handle of [fd, dir]) {
                if (handle !== undefined) {
                    try {
                        fs.closeSync(handle);
                    }
                    catch { }
                }
            }
        }
    }
}
/** The kinds a given relation is told about. See the class docblock. */
function relationHears(kind, relation) {
    // `green-idle` is the approver's business and nobody else's. Telling the
    // author "your PR is green and nobody has looked at it" tells it a thing it
    // can do nothing about except merge without an approval, which is precisely
    // what `task/KAN-226` did five minutes after CI went green and precisely what
    // the governance forbids. So the one recipient is the one being waited on.
    if (kind === 'green-idle')
        return relation === 'parent';
    // In this fleet's governance the task agent is the one that presses merge, so
    // it is the one party guaranteed to know already. LIMIT, stated rather than
    // hidden: if somebody else merges the PR, its own agent learns from its Jira
    // ticket rather than from here. Attribution cannot close that gap — every
    // agent pushes as one shared GitHub identity, so `mergedBy` names the fleet.
    if (kind === 'merged')
        return relation !== 'own';
    // Same guard, other direction: the board parent is the approver, so an
    // approval is news it caused. "Never notify the agent whose action caused the
    // event" is a storm guard in every agent's brief.
    if (kind === 'approved' || kind === 'changes-requested')
        return relation !== 'parent';
    return true;
}
/**
 * The watch loop: read the repositories, notice what changed, tell whoever it
 * concerns.
 *
 * WHO GETS TOLD
 *
 * The same four relations `jira-poll.ts` computes, resolved off the same facts,
 * de-duplicated most-specific-first so an agent that is both a PR's own and a
 * linked one is told once in the terms that apply:
 *
 *   - **own** — the live agent whose ticket the branch names.
 *   - **supervisor** — the agent that activated it, from the durable registry.
 *   - **parent** — the agent of the ticket's board parent. This is the
 *     **approver**, which is why it is the relation `green-idle` and `merged`
 *     are for.
 *   - **linked** — live agents of issues linked to the ticket.
 *
 * An agent that is not running is not woken. Its ticket is its durable inbox and
 * starting an agent to receive a notification would be the daemon staffing the
 * fleet on its own initiative.
 *
 * AND EACH OF THEM ONCE PER PULL REQUEST PER TICK
 *
 * A tick routinely recognises two facts about one PR — it went green and it
 * picked up a comment — and they arrive as one message with the clauses joined.
 */
export class PrWatcher {
    opts;
    state;
    intervalMs;
    degradedIntervalMs;
    timer = null;
    ticking = false;
    degraded = false;
    stopped = false;
    health = {
        repos: [],
        releasedRepos: [],
        lastAttemptAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastError: null,
        degraded: false,
        watchedCount: 0,
        openCount: 0,
        nobodyLiveCount: 0,
        unmatched: []
    };
    constructor(opts) {
        this.opts = opts;
        this.state = opts.state ?? new PrWatchState();
        this.intervalMs = opts.intervalMs ?? PR_POLL_INTERVAL_MS;
        this.degradedIntervalMs = opts.degradedIntervalMs ?? DEGRADED_PR_POLL_INTERVAL_MS;
    }
    now() {
        return this.opts.now?.() ?? Date.now();
    }
    /** The memory, for a caller that wants to inspect it. */
    watchState() {
        return this.state;
    }
    isDegraded() {
        return this.degraded;
    }
    /**
     * Whether this watcher can see GitHub, and since when — AC5's surface.
     *
     * A reader, wired into `butchr_list_agents` beside the undelivered-notification
     * record KAN-301 added, so that "we have not been able to look" is answerable
     * by anyone with the MCP tool rather than only by someone tailing a log.
     */
    healthReport() {
        return { ...this.health, detail: describeHealth(this.health, this.now()) };
    }
    start() {
        if (this.timer || this.stopped)
            return;
        if (!this.state.isLoaded())
            this.state.load();
        this.opts.log(`[pr-watch] watching pull requests every ${this.intervalMs / 1000}s ` +
            `(${this.state.entries().length} pull request(s) remembered from a previous run)`);
        this.schedule();
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    schedule() {
        if (this.stopped)
            return;
        const wait = this.degraded ? this.degradedIntervalMs : this.intervalMs;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick().finally(() => this.schedule());
        }, wait);
        this.timer.unref?.();
    }
    async tick() {
        if (this.ticking) {
            this.opts.log('[pr-watch] previous tick is still running; skipping this one.');
            return;
        }
        this.ticking = true;
        try {
            await this.watchOnce();
        }
        catch (e) {
            this.opts.log(`[pr-watch] tick failed: ${e?.message ?? String(e)}`);
        }
        finally {
            this.ticking = false;
        }
    }
    /**
     * One pass: read every repository, recognise what changed, tell whoever it
     * concerns. Public so the daemon can run one by hand and a proof can drive
     * ticks deterministically. Never throws.
     */
    async watchOnce() {
        const tick = {
            repos: [],
            releasedRepos: [],
            watched: [],
            openWatched: [],
            nobodyLive: [],
            unmatched: [],
            events: [],
            notices: [],
            skipped: [],
            failures: [],
            degraded: this.degraded
        };
        if (!this.state.isLoaded())
            this.state.load();
        this.health.lastAttemptAt = new Date(this.now()).toISOString();
        let agents;
        try {
            agents = this.opts.liveAgents();
        }
        catch (e) {
            this.opts.log(`[pr-watch] could not read the fleet: ${e?.message ?? String(e)}`);
            this.recordFailure(`could not read the fleet: ${e?.message ?? String(e)}`, false);
            return tick;
        }
        const byKey = new Map();
        const running = new Set();
        for (const agent of agents) {
            if (!agent.type || !agent.key)
                continue;
            running.add(agent.agentName);
            const key = agent.key.toUpperCase();
            const bucket = byKey.get(key);
            if (bucket)
                bucket.push(agent);
            else
                byKey.set(key, [agent]);
        }
        let repos;
        let released;
        try {
            ({ repos, released } = this.resolveRepos(agents));
        }
        catch (e) {
            this.opts.log(`[pr-watch] could not discover repositories: ${e?.message ?? String(e)}`);
            this.recordFailure(`could not discover repositories: ${e?.message ?? String(e)}`, false);
            return tick;
        }
        tick.repos = repos;
        tick.releasedRepos = released;
        this.health.repos = repos;
        this.health.releasedRepos = released;
        if (!repos.length) {
            // Not a failure: no live agent holds a checkout. The health sentence says
            // so in its own words rather than reporting a clean nothing.
            this.health.watchedCount = 0;
            this.health.openCount = 0;
            this.health.nobodyLiveCount = 0;
            this.health.unmatched = [];
            return tick;
        }
        let sawBackOff = false;
        let anyFailure = false;
        let lastError = null;
        const pending = [];
        for (const { repo } of repos) {
            const outcome = await this.opts.github.listPullRequests(repo);
            if (!outcome.ok) {
                anyFailure = true;
                if (outcome.backOff)
                    sawBackOff = true;
                lastError = `${repo}: ${outcome.error}`;
                tick.failures.push({ repo, error: outcome.error, backOff: outcome.backOff });
                // A read that failed saw nothing. It must never be able to look like
                // "every pull request went away", so no memory is touched.
                this.opts.log(`[pr-watch] ${repo}: read failed: ${outcome.error}`);
                continue;
            }
            for (const pr of outcome.prs) {
                const issueKey = issueKeyForBranch(pr.headRefName);
                if (!issueKey) {
                    // AC4. Visible, by number and branch, not silently unwatched.
                    tick.unmatched.push({
                        repo: pr.repo,
                        number: pr.number,
                        headRefName: pr.headRefName,
                        title: pr.title,
                        state: pr.state
                    });
                    continue;
                }
                tick.watched.push(`${pr.repo}#${pr.number}`);
                // Open-ness is what makes a row outstanding, and it is recorded here
                // rather than recomputed from the health numbers, so the two can never
                // be derived from different reads of the same tick.
                if (pr.state === 'OPEN') {
                    tick.openWatched.push(`${pr.repo}#${pr.number}`);
                    if (!byKey.has(issueKey))
                        tick.nobodyLive.push(`${pr.repo}#${pr.number}`);
                }
                for (const event of this.recognise(pr, issueKey)) {
                    pending.push(event);
                    tick.events.push(event);
                }
            }
        }
        // Persisted before a single notification is sent, and this order is the
        // storm guard: recognition is what the memory records, not delivery. Saving
        // afterwards would mean a daemon killed mid-delivery came back and announced
        // the whole tick again — "one event, one notice, ever" broken by exactly the
        // crash it exists to survive.
        this.state.save();
        this.updatePace(sawBackOff, !anyFailure);
        tick.degraded = this.degraded;
        if (anyFailure)
            this.recordFailure(lastError ?? 'a read failed without saying why', sawBackOff);
        else
            this.recordSuccess();
        // Only from a tick that actually saw something. A tick in which every read
        // failed observed no pull requests, and writing that observation down as
        // `watchedCount = 0` would turn "we are blind" into "there is nothing
        // there" — the same collapse in the numbers that the sentence above refuses
        // to make in words. The last real observation stands, labelled as such.
        if (!anyFailure) {
            this.health.watchedCount = tick.watched.length;
            this.health.openCount = tick.openWatched.length;
            this.health.nobodyLiveCount = tick.nobodyLive.length;
            this.health.unmatched = tick.unmatched;
        }
        // One pull request's events are announced together (KAN-207).
        const byPr = new Map();
        for (const event of pending) {
            const id = `${event.repo}#${event.number}`;
            const bucket = byPr.get(id);
            if (bucket)
                bucket.push(event);
            else
                byPr.set(id, [event]);
        }
        for (const events of byPr.values()) {
            await this.notify(events, byKey, running, tick);
        }
        return tick;
    }
    /**
     * The final watch set, and what was released from it (KAN-360).
     *
     * Two sources unioned, and the order of precedence is the order of confidence
     * about *why* a repository is being watched — an explicit instruction beats a
     * live checkout, and a live checkout beats an inference from memory. Only the
     * label differs; a repository present twice is read once either way.
     *
     * THE UNION IS THE FIX. Discovery answers "where is the fleet sitting?" and
     * drains as the fleet does; the memory answers "where is something still
     * open?" and does not. The approver a pull request notification is for is in
     * the second answer and never in the first.
     */
    resolveRepos(agents) {
        const discovered = this.opts.repos
            ? // An explicit override from a caller — a proof, or a machine that has
                // been told what to watch. Configuration by any other name.
                this.opts.repos(agents).map((repo) => ({ repo, source: 'config' }))
            : discoverRepos(agents);
        // First writer wins, and there is no precedence rule here because there is
        // nothing for one to arbitrate: `discoverRepos` returns `config` OR
        // `checkout` and never both, and the memory is consulted only for
        // repositories discovery did not already name. A tie-break written for a
        // case that cannot arise would be a claim about behaviour nothing exercises.
        // The whole entry is carried rather than just its source (KAN-370): a
        // `checkout` names the agents holding it, and reducing it to a bare source
        // here would drop exactly the evidence the report exists to print.
        const byRepo = new Map();
        for (const entry of discovered) {
            if (!byRepo.has(entry.repo))
                byRepo.set(entry.repo, entry);
        }
        for (const repo of this.state.reposWithOpenPr()) {
            if (!byRepo.has(repo))
                byRepo.set(repo, { repo, source: 'memory' });
        }
        const repos = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
        // Everything the memory knows of that did not make the set. It is bounded by
        // `PR_STATE_TTL_MS`, so "seen before" means "seen in the last week" rather
        // than "seen ever", and a repository the fleet has genuinely left behind
        // stops being mentioned instead of accumulating forever.
        const released = this.state.knownRepos().filter((repo) => !byRepo.has(repo));
        return { repos, released };
    }
    /**
     * What changed about one pull request since the last look — and the first-sight
     * rule.
     *
     * A pull request with no memory is recorded **silently**. That is the whole of
     * the no-replay guarantee: the first read of this repository carries forty
     * pull requests, thirty of them merged weeks ago, and announcing them would
     * make every daemon start a broadcast of history. A restart is *not* that
     * case — the memory is durable, so after one a pull request is diffed against
     * what was recorded before the daemon went down, and something that happened
     * during the downtime is genuine news and is delivered.
     */
    recognise(pr, issueKey) {
        const id = `${pr.repo}#${pr.number}`;
        const seen = this.state.get(id);
        const seenAt = new Date(this.now()).toISOString();
        // WAS THIS SEEN LIVE, OR IS IT BEING BACKFILLED AFTER A GAP? (KAN-367, AC4)
        //
        // Measured here, once, from the memory's own `seenAt` — the last tick that
        // actually read this pull request — because this is the only place that
        // holds both the previous look and the current one. A repository can stop
        // being looked at for several unrelated reasons (its last checkout goes away
        // and nothing in it is open, the daemon is down, GitHub is unreachable for
        // an hour), and none of them is distinguishable at the moment of composing
        // a sentence. The gap is, and the gap is what the reader actually needs.
        //
        // Spread into `base` so every event of this tick carries it. That is what
        // makes {@link PrEvent.observation} affordable as a REQUIRED field.
        const observation = this.observationSince(seen?.seenAt);
        const base = {
            repo: pr.repo,
            number: pr.number,
            title: pr.title,
            url: pr.url,
            issueKey,
            headRefName: pr.headRefName,
            observation
        };
        // Both of these read the SAME classifier the readiness answer reads, so
        // "this PR is stale" and "this PR is ready" cannot come apart in the way
        // KAN-339 recorded. `head-stale` fires on the two blockers somebody can act
        // on and NOT on `mergeability-unknown`: an uncomputed merge state is the
        // ordinary consequence of any push to `main` and would fire on half the
        // fleet's pull requests several times a day, saying nothing anybody can do
        // anything about. Uncertainty suppresses the confident notice; it does not
        // earn a notice of its own.
        const mergeability = mergeabilityOf(pr.mergeStateStatus);
        const stale = isStaleMergeability(mergeability);
        const wasStale = seen ? isStaleMergeability(mergeabilityOf(seen.mergeStateStatus)) : false;
        // `green-idle` is a standing CONDITION, not an edge in a field, so it is
        // armed per head sha rather than per transition. Without that it would
        // either announce once and never again after a rebase — losing exactly the
        // case a strict branch creates — or announce every tick forever, which is
        // the chattiness that trains agents to ignore this channel.
        //
        // Its predicate is now one call. Everything it used to test inline — open,
        // not draft, checks actually green, no approval yet, and a head GitHub has
        // positively said merges — lives in `readinessOf`, and this is the only
        // place `green-idle` can come from.
        const readiness = readinessOf(pr);
        const greenIdle = readiness.ready;
        if (!seen) {
            this.state.set(id, {
                state: pr.state,
                reviewDecision: pr.reviewDecision,
                checks: pr.checks,
                mergeStateStatus: pr.mergeStateStatus,
                headRefOid: pr.headRefOid,
                commentIds: pr.commentIds,
                approval: pr.approval,
                // Armed as already-announced, so first sight of a PR that has been
                // sitting green for an hour does not announce it as news.
                greenIdleSha: greenIdle ? pr.headRefOid : '',
                seenAt
            });
            this.opts.log(`[pr-watch] ${id} (${issueKey}): first sight — recording ${pr.state}, checks ` +
                `${pr.checks}, ${pr.commentIds.length} comment(s) without notifying anyone.`);
            return [];
        }
        const events = [];
        if (pr.state !== seen.state) {
            if (pr.state === 'MERGED') {
                events.push({
                    ...base,
                    kind: 'merged',
                    mergedAt: pr.mergedAt,
                    jiraStatus: this.opts.issueFacts(issueKey)?.status ?? null
                });
            }
            else if (pr.state === 'CLOSED') {
                events.push({ ...base, kind: 'closed' });
            }
        }
        // An approval arrives one of two ways, and only one of them can happen here.
        // `reviewDecision` is a GitHub review verdict, which this fleet structurally
        // cannot produce — it is kept for a human reviewing from a second account.
        // `approval` is KAN-306's head-pinned marker, which is how every approval on
        // this board is actually recorded.
        if (pr.approval === 'recorded' && seen.approval !== 'recorded') {
            events.push({ ...base, kind: 'approved', approvalSource: 'marker' });
        }
        else if (pr.reviewDecision !== seen.reviewDecision) {
            if (pr.reviewDecision === 'APPROVED')
                events.push({ ...base, kind: 'approved', approvalSource: 'review' });
            else if (pr.reviewDecision === 'CHANGES_REQUESTED')
                events.push({ ...base, kind: 'changes-requested' });
        }
        if (pr.checks === 'failure' && seen.checks !== 'failure' && pr.state === 'OPEN') {
            events.push({ ...base, kind: 'checks-failed', failingChecks: pr.failingChecks });
        }
        if (stale && !wasStale && pr.state === 'OPEN') {
            // `mergeability` is carried rather than the raw string so the notice can
            // say what to DO about it — conflicts and being behind need different
            // hands. It is the same classification `readinessOf` refused on, so the
            // two notices cannot describe this head differently.
            events.push({
                ...base,
                kind: 'head-stale',
                mergeStateStatus: pr.mergeStateStatus,
                mergeability
            });
        }
        const known = new Set(seen.commentIds);
        const fresh = pr.commentIds.filter((commentId) => !known.has(commentId));
        if (fresh.length) {
            // One notice for the tick, not one per comment: three comments written in
            // a minute are one thing to go and read.
            events.push({ ...base, kind: 'comment', newComments: fresh.length });
        }
        let greenIdleSha = seen.greenIdleSha;
        if (greenIdle && seen.greenIdleSha !== pr.headRefOid) {
            events.push({ ...base, kind: 'green-idle' });
            greenIdleSha = pr.headRefOid;
        }
        else if (!greenIdle && seen.headRefOid !== pr.headRefOid) {
            // A new head that is not yet green re-arms the condition for when it is.
            greenIdleSha = '';
        }
        this.state.set(id, {
            state: pr.state,
            reviewDecision: pr.reviewDecision,
            checks: pr.checks,
            // AN UNCOMPUTED MERGE STATE DOES NOT OVERWRITE A KNOWN ONE (KAN-339).
            //
            // `mergeStateStatus` is remembered for exactly one purpose: to answer "was
            // this already stale last time?", so that a standing conflict is announced
            // once rather than every minute. `UNKNOWN` is not an answer to that
            // question, and writing it down as though it were makes the memory forget.
            //
            // Every push to `main` invalidates this field on every open pull request,
            // so the DIRTY → UNKNOWN → DIRTY flap is the ordinary consequence of the
            // fleet merging anything. Recording the UNKNOWN loses `wasStale` and the
            // conflict is re-announced on the next tick as though it were new — which
            // is how a watcher teaches its readers to ignore it. Keeping the last
            // thing GitHub actually said costs nothing and is what `wasStale` meant
            // all along; the CURRENT read is still what `readinessOf` refuses on, so
            // this cannot make an unknown head look ready.
            //
            // Scoped to an UNCHANGED head, deliberately: carrying a previous head's
            // mergeability across a push would be remembering something about a commit
            // that no longer exists.
            mergeStateStatus: mergeability === 'unknown' && seen.headRefOid === pr.headRefOid
                ? seen.mergeStateStatus
                : pr.mergeStateStatus,
            headRefOid: pr.headRefOid,
            approval: pr.approval,
            // The union, so a comment deleted between reads cannot make an older one
            // look new on the tick after that.
            commentIds: [...new Set([...seen.commentIds, ...pr.commentIds])],
            greenIdleSha,
            seenAt
        });
        return events;
    }
    /**
     * How long this pull request went unobserved before the look happening now
     * (KAN-367, AC4).
     *
     * THE BOUND IS THE CURRENT CADENCE, DOUBLED, and it has to be read at call
     * time rather than fixed at construction: while GitHub is asking to be left
     * alone the interval is {@link DEGRADED_PR_POLL_INTERVAL_MS}, and a five
     * minute gap is then the *ordinary* spacing of two consecutive looks. A fixed
     * 60s bound would have labelled every notice during a degradation as
     * backfilled — which is the failure mode this disclosure most needs to avoid,
     * because a qualification that fires constantly is one a reader learns to skip
     * and is then not read on the notice that meant it.
     *
     * Doubled for the reason {@link PRESENT_TENSE_LIMIT_MS} is: one interval is
     * the cadence and one absorbs a late tick, so an on-time pair of looks is
     * never called a gap.
     *
     * A pull request with no memory returns `live`. That is the first-sight rule
     * one step on: first sight announces nothing at all, so there is no notice for
     * this value to qualify — and claiming a gap of *"since the beginning of
     * time"* would be inventing an observation window nobody ever had.
     */
    observationSince(lastSeenAt) {
        if (!lastSeenAt)
            return { live: true };
        const previous = Date.parse(lastSeenAt);
        if (!Number.isFinite(previous))
            return { live: true };
        const gapMs = this.now() - previous;
        const cadence = this.degraded ? this.degradedIntervalMs : this.intervalMs;
        if (gapMs <= cadence * 2)
            return { live: true };
        return { live: false, lastObservedAt: lastSeenAt, gapMs };
    }
    updatePace(sawBackOff, allSucceeded) {
        if (sawBackOff) {
            if (!this.degraded) {
                this.degraded = true;
                this.opts.log(`[pr-watch] GitHub asked to be left alone (rate limit, 5xx or an unreachable host); ` +
                    `slowing from ${this.intervalMs / 1000}s to ${this.degradedIntervalMs / 1000}s between ` +
                    'looks. Still watching — degrading to silence is not an option here.');
            }
            this.health.degraded = true;
            return;
        }
        if (this.degraded && allSucceeded) {
            this.degraded = false;
            this.opts.log(`[pr-watch] GitHub is answering again; back to ${this.intervalMs / 1000}s.`);
        }
        this.health.degraded = this.degraded;
    }
    recordFailure(error, backOff) {
        this.health.consecutiveFailures++;
        this.health.lastError = error;
        this.opts.log(`[pr-watch] CANNOT SEE GITHUB: ${this.health.consecutiveFailures} consecutive failed ` +
            `look(s); last success ${this.health.lastSuccessAt ?? 'never'}. Anything that has happened ` +
            `to these pull requests since then is unknown and has been announced to nobody. ` +
            `${error}${backOff ? ' (backing off)' : ''}`);
    }
    recordSuccess() {
        if (this.health.consecutiveFailures > 0) {
            this.opts.log(`[pr-watch] GitHub is readable again after ${this.health.consecutiveFailures} failed ` +
                'look(s). Anything that changed while it was not is diffed against the memory and ' +
                'announced now.');
        }
        this.health.consecutiveFailures = 0;
        this.health.lastError = null;
        this.health.lastSuccessAt = new Date(this.now()).toISOString();
    }
    /** Work out who one pull request's events concern, and tell each of them once. */
    async notify(events, byKey, running, tick) {
        const { log, herdrBridge, supervisorFor } = this.opts;
        const deliver = this.opts.deliver ?? refuseWithoutCarrier;
        const first = events[0];
        const id = `${first.repo}#${first.number}`;
        const issueKey = first.issueKey.toUpperCase();
        const kinds = events.map((event) => event.kind).join('+');
        // Most specific relation wins, so an agent that is both is told once in the
        // terms that actually apply.
        const targets = new Map();
        const consider = (agent, relation) => {
            if (!running.has(agent.agentName))
                return;
            if (!targets.has(agent.agentName))
                targets.set(agent.agentName, { agent, relation });
        };
        const own = byKey.get(issueKey) ?? [];
        for (const agent of own)
            consider(agent, 'own');
        for (const agent of own) {
            const supervisor = supervisorFor(agent.agentName);
            if (!supervisor)
                continue;
            const supervisorName = agentNameFor(supervisor.type, supervisor.key);
            if (supervisorName === agent.agentName)
                continue;
            if (!running.has(supervisorName))
                continue;
            consider({ agentName: supervisorName, type: supervisor.type, key: supervisor.key }, 'supervisor');
        }
        const facts = this.opts.issueFacts(issueKey);
        const parentKey = facts?.parentKey?.toUpperCase();
        if (parentKey && parentKey !== issueKey) {
            const parents = byKey.get(parentKey) ?? [];
            if (!parents.length) {
                // Said out loud rather than folded into "nobody live to tell", which is
                // the line that made KAN-237's stall hard to diagnose: it cannot
                // distinguish "this concerns nobody" from "the agent it most concerns —
                // the approver — is switched off".
                log(`[pr-watch] ${id} (${kinds}): board parent ${parentKey} has no live agent, so the ` +
                    `approver was not told. ${issueKey} remains its inbox.`);
                for (const event of events) {
                    tick.skipped.push({
                        event,
                        relation: 'parent',
                        reason: "the ticket's board parent has no live agent"
                    });
                }
            }
            for (const agent of parents)
                consider(agent, 'parent');
        }
        for (const linkedKey of facts?.linkedKeys ?? []) {
            for (const agent of byKey.get(linkedKey.toUpperCase()) ?? [])
                consider(agent, 'linked');
        }
        if (!targets.size) {
            log(`[pr-watch] ${id} (${kinds}): nobody live to tell.`);
            return;
        }
        for (const { agent, relation } of targets.values()) {
            const mine = [];
            for (const event of events) {
                if (relationHears(event.kind, relation)) {
                    mine.push(event);
                    continue;
                }
                log(`[pr-watch] ${id} (${event.kind}): not telling ${agent.type}/${agent.key} ` +
                    `(${relation}) — this relation does not hear this kind.`);
                tick.skipped.push({
                    event,
                    relation,
                    reason: `a ${relation} is not told about a ${event.kind} event`,
                    agentName: agent.agentName
                });
            }
            if (!mine.length)
                continue;
            log(`[pr-watch] ${id} (${mine.map((event) => event.kind).join('+')}): telling ` +
                `${agent.type}/${agent.key} (${relation}).`);
            const outcome = await deliver({
                herdrBridge,
                type: agent.type,
                key: agent.key,
                message: prEventNoticeText(mine, relation, this.now()),
                log
            });
            tick.notices.push({
                events: mine,
                relation,
                type: agent.type,
                key: agent.key,
                agentName: agent.agentName,
                delivered: outcome.delivered,
                ...(outcome.error ? { error: outcome.error } : {})
            });
        }
    }
}
