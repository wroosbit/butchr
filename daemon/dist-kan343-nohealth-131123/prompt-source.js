import { execFile, execFileSync } from 'child_process';
/**
 * WHERE A BRIEF'S TEXT COMES FROM — and why it is no longer the working tree.
 *
 * `prompts/*.md` are read at activation off the daemon's own checkout, which is
 * the *shared clone* every task agent also fetches and creates worktrees in.
 * That clone's `main` is never advanced, and this is not an oversight:
 * `prompts/task.md` forbids `pull` there in so many words, because agents read
 * that tree while others could be moving it, and a fast-forward that changes
 * files under a reading agent is a real hazard.
 *
 * So the working tree drifts behind `origin/main` **by design**, one commit per
 * merge, monotonically, and nothing will ever reduce it. KAN-437 fast-forwarded
 * it by hand on 2026-08-14 and it was `[behind 7]` within six hours. Every agent
 * activated in that window was briefed on governance that had moved.
 *
 * KAN-442 asked who should advance that tree. THE ANSWER IS NOBODY, AND THE
 * REASON IS THAT THE TREE WAS NEVER THE RIGHT SOURCE. Git can read a file at a
 * ref without touching the working tree at all:
 *
 *     git show origin/main:prompts/task.md
 *
 * That read takes no index lock, writes nothing, and cannot change a file under
 * a concurrent reader — so the hazard that made `pull` unsafe does not arise,
 * rather than being mitigated. The currency question and the concurrency
 * question stop being the same question.
 *
 * WHAT THIS DOES NOT DO, said plainly because the failure this board keeps
 * re-finding is an artifact whose sentence claims more than its mechanism
 * covers:
 *
 *   - **It does not advance the working tree, and nothing here should be read as
 *     making the clone current.** `git status` in the shared clone will go on
 *     saying `[behind N]` forever. What changes is that the number stops
 *     reaching the briefs.
 *   - **It does not deploy anything.** The daemon still runs the build it was
 *     started from. A brief rendered from `origin/main` can therefore describe a
 *     mechanism this daemon has not got — see `describeBuildGap` below, which
 *     exists so that gap is reported rather than discovered.
 *   - **It does not make `origin/main` current on its own.** That ref is only as
 *     fresh as the last fetch, which is what {@link PromptSourceKeeper} owns.
 */
/**
 * The one write this design permits, and the reason it is safe.
 *
 * `git fetch` moves `refs/remotes/origin/*` and adds objects. It does not touch
 * the working tree, the index, or `HEAD`. Every task agent already runs it in
 * this clone concurrently at setup — the existing rule tells them to — so the
 * daemon doing so on a timer adds a participant to an operation the repository
 * already sustains, rather than introducing a new class of write.
 */
export const FETCH_INTERVAL_MS = 5 * 60 * 1000;
/** A fetch that has not answered by now is not worth waiting for. */
export const FETCH_TIMEOUT_MS = 60_000;
/** Read-only git is bounded much more tightly; it is on the activation path. */
const GIT_TIMEOUT_MS = 5_000;
/**
 * The remote ref briefs are rendered from when one is available.
 *
 * Hard-coded rather than derived from `origin/HEAD` because this names a
 * *policy* — "brief agents from what has been merged" — and not a fact about
 * the clone. `resolvePromptSource` verifies the ref exists before claiming it.
 */
export const PROMPT_REF = 'origin/main';
/** Run git read-only against a checkout, or null if it fails for any reason. */
function git(repoRoot, args) {
    try {
        return execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
            // The shared clone is read by task agents concurrently. A read that took
            // `index.lock` could make one of their commands fail, and a mechanism
            // that broke the agents it briefs would be a poor trade.
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        });
    }
    catch {
        return null;
    }
}
/**
 * Which source this render should use, decided fresh at every render.
 *
 * Not cached, and not resolved once at construction: a daemon that started
 * before the first successful fetch would otherwise be pinned to the working
 * tree for its whole life, which is the failure mode this module exists to
 * remove. Two bounded git reads on the activation path is the price.
 *
 * Every failure lands in `worktree` with a reason. An activation must never be
 * lost to a slow or absent git — the brief still ships, and it ships saying
 * honestly what it was rendered from.
 */
export function resolvePromptSource(repoRoot, ref = PROMPT_REF) {
    if (git(repoRoot, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
        return {
            kind: 'worktree',
            because: `${repoRoot} is not a git working tree, so there is no ${ref} to read`
        };
    }
    const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
    if (!sha) {
        return {
            kind: 'worktree',
            because: `${ref} does not exist in ${repoRoot} — it has never been fetched`
        };
    }
    return { kind: 'ref', ref, sha };
}
/**
 * A template's bytes, read from whichever source was resolved.
 *
 * Returns null rather than throwing so the loader can fall back and say so; a
 * ref that exists is not a guarantee that a given path exists *in* it, and a
 * template added after the last fetch is an ordinary, recoverable state.
 */
export function readTemplateAt(repoRoot, source, templatePath) {
    if (source.kind !== 'ref')
        return null;
    // `<sha>:<path>` rather than `<ref>:<path>`: the ref could move between this
    // read and the provenance read below if a fetch lands in between, and a brief
    // stamped with one commit but carrying another's text is exactly the silent
    // mismatch the stamp exists to prevent. Pinning to the sha makes the two reads
    // one snapshot.
    return git(repoRoot, ['show', `${source.sha}:${templatePath}`]);
}
/**
 * How the ref being rendered from stands to the build this daemon is running.
 *
 * Reported rather than resolved, and it is the honest cost of this design.
 * Briefing from `origin/main` makes governance current while the daemon goes on
 * executing whatever it was built from, so a brief can describe a tool the
 * running daemon has not got. That trade is deliberate — governance is the
 * load-bearing half of a brief, and a stale approver rule has cost this board
 * measured hours where a mechanism described early has cost it nothing — but a
 * trade nobody can see is indistinguishable from a defect.
 *
 * Returns null when the question does not arise (no ref, or not a checkout).
 */
export function describeBuildGap(repoRoot, source) {
    if (source.kind !== 'ref')
        return null;
    const counts = git(repoRoot, ['rev-list', '--count', `HEAD..${source.sha}`])?.trim();
    const ahead = Number(counts);
    if (!Number.isFinite(ahead))
        return null;
    if (ahead === 0)
        return null;
    return (`${source.ref} is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of this checkout's HEAD, ` +
        `so briefs are current with what has been merged while the daemon runs the older build`);
}
/**
 * Keeps `origin/main` fetched so that rendering from it means something.
 *
 * THIS IS THE OWNER KAN-442 ASKED FOR. Not of the working tree — nobody owns
 * that and nothing needs to — but of the *ref* the briefs are read from. It is
 * the daemon because the daemon is the only long-lived process here: the board
 * reconciler runs at activation (too late, and it would put a network round trip
 * on the path an agent waits on), and a human is not a mechanism.
 *
 * Deliberately never on the activation path. `daemon.ts` already refuses to put
 * a blocking fetch at startup on the grounds that it trades a silent failure for
 * a slow one, and the same argument applies with more force to an activation.
 * The timer runs behind everything; a render takes whatever ref it finds.
 */
export class PromptSourceKeeper {
    repoRoot;
    log;
    intervalMs;
    timer = null;
    running = false;
    constructor(repoRoot, log, intervalMs = FETCH_INTERVAL_MS) {
        this.repoRoot = repoRoot;
        this.log = log;
        this.intervalMs = intervalMs;
    }
    /** Start the timer and fetch once immediately. Safe to call twice. */
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => void this.fetchOnce(), this.intervalMs);
        // `unref` so this timer never holds the process open. A daemon that could
        // not exit because it owed a fetch would be a worse bug than a stale ref.
        this.timer.unref?.();
        void this.fetchOnce();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /**
     * One fetch, never overlapping itself.
     *
     * The overlap guard is not tidiness: a fetch that outran its interval on a
     * slow network would otherwise stack processes against the clone every
     * interval, and the thing being contended is the shared clone every agent is
     * using.
     */
    fetchOnce() {
        if (this.running)
            return Promise.resolve();
        this.running = true;
        return new Promise((resolve) => {
            execFile('git', ['-C', this.repoRoot, 'fetch', '--quiet', 'origin'], {
                timeout: FETCH_TIMEOUT_MS,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
            }, (err) => {
                this.running = false;
                // Logged and swallowed. A failed fetch means briefs are rendered from
                // an older `origin/main` — which is where they were before this class
                // existed — and is never a reason to disturb an activation.
                if (err)
                    this.log(`prompt-source: fetch of ${this.repoRoot} failed: ${err.message}`);
                resolve();
            });
        });
    }
}
