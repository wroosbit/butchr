import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspacesRoot } from './herdr.js';
/**
 * ---------------------------------------------------------------------------
 * Reading GitHub, so that what a ticket *produces* is as visible as the ticket.
 * ---------------------------------------------------------------------------
 *
 * KAN-304. `JiraPoller` has watched tickets since 2026-08-04. Nothing has ever
 * watched the pull requests those tickets produce, and the gap is not
 * theoretical — on the day this was filed, three PRs merged and left their
 * tickets reading In Review, a green PR sat unmerged for most of an hour with
 * nobody told, and an agent hand-rolled a `gh pr view --json comments` bash loop
 * because no watcher existed. That loop died with the agent that wrote it.
 *
 * This module is the *read*. It knows how to ask GitHub what a pull request
 * looks like and nothing else: it recognises no events, decides no audience and
 * sends no message. `pr-watch.ts` is the poll loop, in the same relation to this
 * file that `jira-poll.ts` is to `jira.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE `gh` CLI AND NOT AN HTTP CLIENT WITH A TOKEN
 * ---------------------------------------------------------------------------
 *
 * The ticket asked where the credential comes from, and offered the daemon's own
 * multi-provider store (`credentials.ts`, already holding `'jira'` and
 * `'launchdarkly'`) as one answer. It is the wrong one here, and not by a small
 * margin:
 *
 *   - `gh` is **already authenticated on every machine that runs this fleet**,
 *     because every agent is instructed to use it for all GitHub work. A second
 *     credential would be a second thing to provision, rotate and leak, bought
 *     for a capability that already exists.
 *   - **This process never holds the secret at all.** `gh` reads its own
 *     keyring in its own address space. There is no token in this module, in
 *     `argv`, in an environment variable we set, or in any error string we
 *     render — so the "never print one" rule in every agent's brief is not a
 *     discipline here, it is unreachable. {@link ghErrorText} still redacts what
 *     `gh` prints, because a CLI's stderr is not ours to make promises about.
 *
 * The cost of the choice is that a `gh` that is missing or logged out is a
 * failure mode, and it is one this module reports rather than throws — see
 * {@link GitHubOutcome} and `pr-watch.ts`'s health record.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST PER REPOSITORY PER TICK, AND THE ARITHMETIC FOR IT
 * ---------------------------------------------------------------------------
 *
 * {@link PR_LIST_FIELDS} is a single `gh pr list` returning everything the
 * watcher needs — state, merge state, review decision, head sha, the check
 * rollup and the comments — for the most recent {@link PR_LIST_LIMIT} pull
 * requests in every state. Measured against the real repository while this was
 * written: **3 GraphQL rate-limit points for 30 pull requests with every field
 * above**. At one tick a minute against a 5,000-point hourly ceiling that is
 * ~180 points/hour, or 3.6% of budget, for one repository.
 *
 * `--state all` rather than `--state open` is what makes a merge observable at
 * all: a merged PR leaves the open list, and "it is no longer here" cannot tell
 * merged from closed. Reading both states costs the same one request.
 */
/** How many pull requests one read covers, newest first. */
export const PR_LIST_LIMIT = 40;
/** How long one `gh` invocation may take before it is a failed read. */
export const GH_TIMEOUT_MS = 20_000;
/** Bytes of `gh` output we are willing to hold. 40 PRs of comments is ~1 MB. */
export const GH_MAX_BUFFER = 16 * 1024 * 1024;
/**
 * The fields one read asks for.
 *
 * Kept as one constant because the rate-limit claim above is a claim about
 * *this list*, and a field added elsewhere would silently invalidate it.
 */
export const PR_LIST_FIELDS = [
    'number',
    'title',
    'url',
    'state',
    'isDraft',
    'headRefName',
    'headRefOid',
    'mergedAt',
    'reviewDecision',
    'mergeStateStatus',
    'statusCheckRollup',
    'comments'
].join(',');
/**
 * The required status that carries an approval (KAN-306), read rather than guessed.
 *
 * Every agent in this fleet authenticates as one shared GitHub identity, so
 * GitHub refuses a review verdict on a pull request the same account authored
 * and `required_approving_review_count` is pinned at 0. KAN-306's answer is a
 * comment carrying `BUTCHR-APPROVAL: <full-head-sha> BY <type>/<KEY>`,
 * published as a **commit status** named `approval-recorded` at the pull
 * request head — and made a required context on `main`.
 *
 * NAMING IT HERE IS A COUPLING, AND IT IS THE RIGHT ONE NOW THOUGH IT WAS NOT
 * AN HOUR AGO. This module was written to avoid exactly this constant, on the
 * grounds that the convention was unlanded and that encoding an unmerged
 * agreement is a mechanism claiming more than it covers. KAN-306 merged as
 * `4d6ed87` while this branch was in flight, so that justification has lapsed —
 * and `prompts/task.md` is explicit that an authorisation whose condition has
 * lapsed is not an authorisation. What replaced it is not a guess: the string
 * below is one of the seven contexts `repos/wroosbit/butchr/branches/main/
 * protection` returns.
 *
 * The consequence of NOT reading it would have been quiet and wrong. The status
 * fails on every unapproved pull request, so a watcher that folded it into the
 * ordinary rollup would announce `checks-failed: approval-recorded` on every
 * PR the moment CI went green — reporting the absence of an approval as a
 * broken build, and never once announcing the deadlock this ticket exists for.
 */
export const APPROVAL_STATUS_CONTEXT = 'approval-recorded';
/**
 * The workflow JOB that publishes {@link APPROVAL_STATUS_CONTEXT}, also excluded.
 *
 * FOUND BY TESTING AGAINST REAL OUTPUT, AND IT WOULD NOT HAVE BEEN FOUND ANY
 * OTHER WAY. KAN-306 names its job `approval-gate` and its required status
 * `approval-recorded`, deliberately and for a good reason of its own — a job
 * triggered by `issue_comment` attaches its check run to the default branch
 * rather than to the pull request head, so the status is POSTed instead. The
 * consequence for a reader of `statusCheckRollup` is that the approval mechanism
 * contributes **two** entries, not one, and the second is a CheckRun that FAILS
 * on every unapproved pull request.
 *
 * Excluding only the status would therefore have fixed nothing: `approval-gate`
 * would still have made `checks` read `failure` on every PR awaiting review, so
 * `green-idle` could never fire and `checks-failed` would fire in its place
 * naming a job that reports no defect. That is precisely the notification this
 * ticket forbids — chatty, un-actionable, and wrong about which of "the build is
 * broken" and "nobody has looked yet" is true.
 *
 * Neither entry is a statement about the code, so neither belongs in a rollup
 * whose whole meaning is "are the checks green". The approval is reported
 * separately, as {@link ApprovalState}, because it is a different question.
 */
export const APPROVAL_JOB_CONTEXT = 'approval-gate';
/**
 * Classify `mergeStateStatus`. Unrecognised values are `'unknown'`, never
 * `'mergeable'` — a vocabulary this file does not know is not a promise.
 */
export function mergeabilityOf(mergeStateStatus) {
    switch ((mergeStateStatus ?? '').toUpperCase()) {
        // GitHub computed a merge commit and there is no conflict. The three differ
        // only in what ELSE blocks the button, which is not this function's question:
        //   CLEAN    — nothing blocks it.
        //   BLOCKED  — a required check or review does. This is the ordinary state of
        //              an unapproved pull request on this repository, because
        //              `approval-recorded` is required and fails until approved, so
        //              it is precisely the state `green-idle` is looking for.
        //   UNSTABLE — a non-required check is red.
        case 'CLEAN':
        case 'BLOCKED':
        case 'UNSTABLE':
            return 'mergeable';
        case 'DIRTY':
            return 'conflicted';
        case 'BEHIND':
            return 'behind';
        // UNKNOWN, DRAFT, HAS_HOOKS, '' and anything GitHub adds later.
        default:
            return 'unknown';
    }
}
/**
 * `owner/name` from a GitHub remote URL, or null if it is not one.
 *
 * Handles the three spellings `git remote add` leaves in a config file — HTTPS,
 * SSH-scp and `ssh://` — and rejects everything else rather than guessing. A
 * remote pointing at a host that is not github.com is not something `gh pr
 * list` can read, so returning null is the honest answer and produces a repo
 * that is simply never watched rather than one that fails every tick.
 */
export function repoFromRemoteUrl(url) {
    const trimmed = url.trim();
    const match = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
    if (!match)
        return null;
    const [, owner, name] = match;
    if (!owner || !name)
        return null;
    return `${owner}/${name}`;
}
/**
 * The `origin` URL recorded in a git config file, or null.
 *
 * A hand-rolled INI walk rather than `git config --get`, because this runs once
 * per live agent per tick and a subprocess per workspace is a real cost for a
 * value that is four lines of parsing. It reads only the `[remote "origin"]`
 * section, so a `url` under `[remote "upstream"]` cannot be mistaken for it.
 */
export function originUrlFromGitConfig(text) {
    let inOrigin = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inOrigin = /^\[remote\s+"origin"\]$/.test(line);
            continue;
        }
        if (!inOrigin)
            continue;
        const match = /^url\s*=\s*(.+)$/.exec(line);
        if (match)
            return match[1].trim();
    }
    return null;
}
/**
 * The repository a checkout belongs to, following a worktree back to its clone.
 *
 * Every task agent works in a **worktree** (`prompts/task.md` mandates it), whose
 * `.git` is a *file* reading `gitdir: /…/code/<org>/<repo>/.git/worktrees/<name>`
 * rather than a directory. The remote lives in the shared clone's config, three
 * levels up from there, so following the pointer is the whole of what this does.
 * A plain clone — `.git` as a directory — is handled too, because nothing
 * guarantees a workspace holds a worktree.
 */
export function repoForCheckout(checkout) {
    const dotGit = path.join(checkout, '.git');
    let configPath;
    try {
        const stat = fs.statSync(dotGit);
        if (stat.isDirectory()) {
            configPath = path.join(dotGit, 'config');
        }
        else {
            const pointer = fs.readFileSync(dotGit, 'utf8').trim();
            const match = /^gitdir:\s*(.+)$/.exec(pointer);
            if (!match)
                return null;
            // `<clone>/.git/worktrees/<name>` → `<clone>/.git`. `commondir` is the
            // portable spelling of the same hop and is written beside it; prefer it
            // where it exists, since git owns that file and this arithmetic does not.
            const gitDir = match[1].trim();
            let commonDir = path.resolve(gitDir, '..', '..');
            try {
                const declared = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
                if (declared)
                    commonDir = path.resolve(gitDir, declared);
            }
            catch { }
            configPath = path.join(commonDir, 'config');
        }
    }
    catch {
        return null;
    }
    try {
        const url = originUrlFromGitConfig(fs.readFileSync(configPath, 'utf8'));
        return url ? repoFromRemoteUrl(url) : null;
    }
    catch {
        return null;
    }
}
/**
 * The words a health report uses for a watched repository. One place, so they
 * cannot drift.
 *
 * `checkout` names its holders because the bare phrase is what KAN-370 was filed
 * about: it asserted something true that its reader had no way to check.
 */
export function repoSourcePhrase(watched) {
    switch (watched.source) {
        case 'config':
            return 'named in BUTCHR_PR_WATCH_REPOS';
        case 'checkout':
            return `a live agent holds a checkout: ${watched.heldBy
                .map((holder) => `${holder.type}/${holder.key}`)
                .join(', ')}`;
        case 'memory':
            return 'from memory — an open pull request is outstanding there and no live agent holds a checkout';
    }
}
/**
 * Which repositories to watch: the ones the live fleet is actually working in.
 *
 * WHY DISCOVERY AND NOT CONFIGURATION
 *
 * A watcher that has to be switched on for each repository is a watcher that is
 * off on the day it is needed, and this ticket exists because six real events
 * were missed while everybody believed they were being watched. Discovering the
 * repositories from the fleet means the set is correct by construction: an agent
 * working in a checkout is exactly an agent whose pull requests matter.
 *
 * WHY NOT SCAN THE CLONE CACHE
 *
 * `~/code/<org>/<repo>` holds every repository this human has ever cloned — ten
 * organisations on the machine this was written on, almost none of them Butchr's
 * business. Watching them would be paying GitHub requests to discover that
 * nothing in an unrelated repository concerns anybody.
 *
 * `BUTCHR_PR_WATCH_REPOS` overrides *this* function's discovery entirely,
 * comma-separated, for a machine that wants a repository watched whether or not
 * somebody is in it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FUNCTION CANNOT SEE, AND WHO COVERS IT (KAN-360)
 * ---------------------------------------------------------------------------
 *
 * Both branches here answer *"where is the fleet sitting right now?"*, and the
 * agent a pull request notification is **for** is usually not in the answer. So
 * a task agent standing down after opening a pull request takes the repository
 * out of this set while its approver is still running and still responsible.
 *
 * **This paragraph used to assert that supervisors hold no checkout at all** —
 * *"Measured 2026-08-12 on this machine: `epic/kan-39`, `epic/kan-203` and
 * `epic/kan-59` hold no git checkout at all — only task agents do."* That was
 * **already false when it was written** (KAN-370): `epic/kan-39` had held one at
 * `workspaces/epic/kan-39/review-127` since 2026-08-11, taken to review a pull
 * request. It was measured with `find workspaces -maxdepth 3 -name .git`, which
 * cannot reach a checkout — they sit at depth 4 — so the measurement could not
 * have found what it was looking for.
 *
 * The retention rule that paragraph argues for is **unaffected and still
 * right**, and it survives on a better argument than the one it was given. The
 * false version was *"supervisors never hold a checkout, so discovery can never
 * cover them."* The true version is that a supervisor holding one is **luck
 * rather than design**: `review-127` exists because `epic/kan-39` happened to
 * review a pull request in a worktree and never removed it, and a watch set
 * resting on that is precisely the *coverage from luck* KAN-360 exists to tell
 * apart from coverage. So discovery still cannot be relied on to cover an
 * approver — not because it never does, but because when it does, nothing made
 * it so and nothing keeps it so.
 *
 * Only the evidence was wrong. The design it was offered for was not, and a
 * later reader finding the falsehood should not conclude otherwise.
 *
 * That is not fixed here, deliberately. This function is a reader of the
 * *filesystem*, and the fact that closes the gap — that an open pull request is
 * still outstanding — lives in `PrWatchState`. `PrWatcher.resolveRepos` unions
 * the two, and it is the only place that decides the final set.
 */
export function discoverRepos(agents, env = process.env) {
    const configured = (env.BUTCHR_PR_WATCH_REPOS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (configured.length) {
        return [...new Set(configured)].map((repo) => ({ repo, source: 'config' }));
    }
    // Keyed by repository, holding every agent found in one — a repository is
    // routinely held by more than one agent at a time, and a reader checking the
    // claim wants the whole list rather than whichever was seen first.
    const found = new Map();
    for (const agent of agents) {
        if (!agent.type || !agent.key)
            continue;
        const workspace = path.join(workspacesRoot(), agent.type, agent.key.toLowerCase());
        let children;
        try {
            children = fs.readdirSync(workspace, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const child of children) {
            if (!child.isDirectory())
                continue;
            const checkout = path.join(workspace, child.name);
            const repo = repoForCheckout(checkout);
            if (!repo)
                continue;
            const holders = found.get(repo) ?? [];
            holders.push({ type: agent.type, key: agent.key, path: checkout });
            found.set(repo, holders);
        }
    }
    return [...found.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([repo, heldBy]) => ({ repo, source: 'checkout', heldBy }));
}
/**
 * Reduce GitHub's check rollup to one word, and name what is not green.
 *
 * NEUTRAL and SKIPPED count as green, because that is what they mean to a merge
 * button: a skipped job is not a failing one. Anything still running is
 * `pending`, and `pending` is deliberately not `failure` — announcing a red PR
 * because its checks had not finished would be the chattiness this ticket
 * forbids, arriving as a false alarm.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY LIST AND AN EMPTIED LIST ARE THE SAME ANSWER (KAN-339)
 * ---------------------------------------------------------------------------
 *
 * This function used to guard `!list.length` at the top and then fall through to
 * `'success'` at the bottom whenever nothing had been pushed into `failing` and
 * nothing was pending. Between those two lines it *removes* entries: both of the
 * approval mechanism's contributions are read and set aside, for the good reason
 * given at {@link APPROVAL_STATUS_CONTEXT}. So a rollup consisting only of the
 * approval mechanism entered as non-empty, was emptied, and left as `'success'`.
 *
 * THE MEASURED CASE, which is the whole argument for the counter below. At
 * `wroosbit/butchr#153`, head `514db76`:
 *
 *   gh api .../commits/514db76/check-runs  ->  total_count: 0
 *   gh api .../commits/514db76/status      ->  ["approval-recorded"], failure
 *
 * One entry, and it is the approval status. The old code returned
 * `checks: 'success'` for that, and the watcher composed *"has every other check
 * green … nothing is blocking it except a review that has not happened"* about a
 * pull request on which **no workflow had started at all**. `epic/KAN-203`'s
 * words for the class: *nothing at all is a different shape from zero, and only
 * the second is what a real absence looks like.*
 *
 * The fix is to count what was actually judged rather than to infer it from an
 * empty failure list. `'success'` now requires at least one real check to have
 * passed; the absence of a failure no longer stands in for the presence of a
 * pass.
 */
export function rollupOf(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const green = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
    const failing = [];
    let pending = false;
    let approval = 'absent';
    /**
     * How many entries were judged as checks — i.e. survived the approval
     * exclusions. Zero of them is `'none'` whether the list arrived empty or was
     * emptied here, which is the point.
     */
    let judged = 0;
    for (const entry of list) {
        const name = typeof entry?.name === 'string' && entry.name
            ? entry.name
            : typeof entry?.context === 'string' && entry.context
                ? entry.context
                : 'an unnamed check';
        // The approval mechanism is read, reported and then set aside — never
        // counted as a failing check. See APPROVAL_STATUS_CONTEXT and
        // APPROVAL_JOB_CONTEXT for why both entries have to go.
        if (name === APPROVAL_STATUS_CONTEXT) {
            const verdict = String(entry?.state ?? entry?.conclusion ?? '').toUpperCase();
            // The status is authoritative: it is the required context branch
            // protection reads, and the only one pinned to this exact head.
            approval = verdict === 'SUCCESS' ? 'recorded' : 'not-recorded';
            continue;
        }
        if (name === APPROVAL_JOB_CONTEXT)
            continue;
        judged++;
        if (typeof entry?.state === 'string') {
            // A StatusContext: one field, already terminal or not.
            const state = entry.state.toUpperCase();
            if (state === 'PENDING' || state === 'EXPECTED')
                pending = true;
            else if (!green.has(state))
                failing.push(name);
            continue;
        }
        // A CheckRun.
        const status = String(entry?.status ?? '').toUpperCase();
        if (status && status !== 'COMPLETED') {
            pending = true;
            continue;
        }
        const conclusion = String(entry?.conclusion ?? '').toUpperCase();
        if (!conclusion)
            pending = true;
        else if (!green.has(conclusion))
            failing.push(name);
    }
    // De-duplicated: a job that runs on more than one trigger appears once per
    // trigger in the rollup, and a notice reading "failing checks: approval-gate,
    // approval-gate" is a notice nobody trusts.
    if (failing.length)
        return { checks: 'failure', failingChecks: [...new Set(failing)].sort(), approval };
    if (pending)
        return { checks: 'pending', failingChecks: [], approval };
    // Ordered after `failure` and `pending` deliberately: those two are positive
    // observations and `judged` cannot be zero when either holds. This last line
    // is the only one that can be reached with nothing having been judged, and
    // `'success'` is not what nothing having been judged means.
    if (!judged)
        return { checks: 'none', failingChecks: [], approval };
    return { checks: 'success', failingChecks: [], approval };
}
/** One `gh pr list` row, defended against every field being absent. */
export function snapshotFrom(repo, row) {
    const number = Number(row?.number);
    if (!Number.isFinite(number) || number <= 0)
        return null;
    const { checks, failingChecks, approval } = rollupOf(row?.statusCheckRollup);
    const commentIds = (Array.isArray(row?.comments) ? row.comments : [])
        .map((comment) => (typeof comment?.id === 'string' ? comment.id : null))
        .filter((id) => Boolean(id));
    return {
        repo,
        number,
        title: typeof row?.title === 'string' ? row.title : '',
        url: typeof row?.url === 'string' ? row.url : '',
        state: typeof row?.state === 'string' ? row.state.toUpperCase() : 'UNKNOWN',
        isDraft: row?.isDraft === true,
        headRefName: typeof row?.headRefName === 'string' ? row.headRefName : '',
        headRefOid: typeof row?.headRefOid === 'string' ? row.headRefOid : '',
        mergedAt: typeof row?.mergedAt === 'string' ? row.mergedAt : null,
        reviewDecision: typeof row?.reviewDecision === 'string' ? row.reviewDecision : '',
        mergeStateStatus: typeof row?.mergeStateStatus === 'string' ? row.mergeStateStatus.toUpperCase() : 'UNKNOWN',
        checks,
        failingChecks,
        approval,
        commentIds
    };
}
/**
 * Whether a `gh` failure means *ask less often* rather than *something broke*.
 *
 * Rate limiting and GitHub's own 5xx are the back-off cases, and so — after a
 * measurement made while this module was written — is a TLS handshake failure:
 * a `gh pr list` on the happy path failed once with `tls: failed to verify
 * certificate` and succeeded on the next attempt. A transient network fault
 * that is retried every sixty seconds forever is the same load a rate limit is
 * asking us to shed.
 */
export function isBackOff(text) {
    return /rate limit|secondary rate|abuse detection|\b(?:429|502|503|504)\b|timed out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|tls:|x509|connection refused|no such host/i.test(text);
}
/**
 * `gh`'s output, capped and stripped of anything that could be a secret.
 *
 * `gh` does not print its token and this module never passes one, so this is
 * belt-and-braces on a boundary the daemon does not own — a stderr line is
 * whatever the CLI decided to write, and it lands in `daemon.log` and in
 * `butchr_list_agents`. Both places are read by agents whose briefs say a
 * credential must never enter a transcript.
 */
export function ghErrorText(raw) {
    const redacted = raw
        .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '<redacted-github-token>')
        .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '<redacted-github-token>')
        .replace(/\b[A-Fa-f0-9]{40}\b(?=\s*$)/gm, '<redacted-40-hex>');
    const collapsed = redacted.replace(/\s+/g, ' ').trim();
    return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}
/**
 * The real reader: one `gh pr list` per repository, as a child process.
 *
 * Arguments are a fixed array through `execFile`, never a shell string. That is
 * not style: a repository name reaches this from a git config file, and a shell
 * would make that file's contents executable by whoever can write it.
 */
export class GhCliGitHubReader {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async listPullRequests(repo) {
        const args = [
            'pr',
            'list',
            '--repo',
            repo,
            '--state',
            'all',
            '--limit',
            String(this.opts.limit ?? PR_LIST_LIMIT),
            '--json',
            PR_LIST_FIELDS
        ];
        const result = this.opts.run ? await this.opts.run(args) : await this.exec(args);
        if (!result.ok) {
            return { ok: false, error: result.text, backOff: isBackOff(result.text) };
        }
        let parsed;
        try {
            parsed = JSON.parse(result.stdout);
        }
        catch (e) {
            // Unparseable output is a failed read and never an empty repository.
            return {
                ok: false,
                error: `gh returned output that is not JSON (${e?.message ?? String(e)})`,
                backOff: false
            };
        }
        if (!Array.isArray(parsed)) {
            return { ok: false, error: 'gh returned JSON that is not a list of pull requests', backOff: false };
        }
        const prs = [];
        for (const row of parsed) {
            const snapshot = snapshotFrom(repo, row);
            if (snapshot)
                prs.push(snapshot);
        }
        return { ok: true, prs };
    }
    exec(args) {
        return new Promise((resolve) => {
            execFile('gh', args, {
                timeout: this.opts.timeoutMs ?? GH_TIMEOUT_MS,
                maxBuffer: GH_MAX_BUFFER,
                // `gh` inherits the daemon's environment so it finds its own config
                // and keyring. Nothing token-shaped is added here, and nothing is
                // read back out of it.
                env: process.env,
                cwd: os.homedir()
            }, (err, stdout, stderr) => {
                if (!err)
                    return resolve({ ok: true, stdout: String(stdout) });
                const detail = ghErrorText(String(stderr || '') || String(err?.message ?? err));
                const code = err?.code;
                resolve({
                    ok: false,
                    text: code === 'ENOENT'
                        ? 'the `gh` CLI is not installed or not on the daemon\'s PATH, so no pull ' +
                            'request can be read at all'
                        : detail || 'gh exited non-zero without saying why'
                });
            });
        });
    }
}
