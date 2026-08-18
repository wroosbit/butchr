import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
/**
 * What an agent would lose if it were switched off right now.
 *
 * WHY THIS EXISTS
 *
 * KAN-38 put an Off button on the Agents page, where the whole fleet is
 * visible and none of it is being watched closely. The hazard is specific and
 * has already happened: on 2026-07-31 three agents were found sitting idle
 * with real unpushed changes in their worktrees. Stopping one of those from a
 * list — where the reader can see a name, a chip and nothing else — throws that
 * work away, and "idle" is exactly what it looks like beforehand.
 *
 * A confirmation that says *"this may destroy uncommitted work"* is a speed
 * bump; everyone clicks through it, because it says the same thing whether
 * there is work to lose or not. A confirmation that says *"2 files changed and
 * 1 commit unpushed on butchr/KAN-38"* is a decision. This module is the
 * difference between the two.
 *
 * WHY IT IS ON DEMAND AND NOT ON THE POLL
 *
 * The Agents page polls `list_agents` every 2s. Shelling out to git once per
 * agent per poll would put a permanent subprocess load on the machine whose
 * capacity this system spends its time rationing, to answer a question nobody
 * has asked yet. It is asked exactly once: when a human clicks Off and before
 * they confirm.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not claim there is nothing to lose when it could not look. Every
 * failure — no such directory, no repository, git missing, git slow — comes
 * back as `checked: false` with a sentence saying so, and the caller is
 * expected to warn anyway. A false "all clear" here is worse than no check at
 * all, because it is the one that gets believed.
 */
/** How long any single git invocation may take before it is abandoned. */
const GIT_TIMEOUT_MS = 5000;
/**
 * How deep to look for repositories. An agent's workspace is not itself a
 * checkout in the ordinary case — the task prompt has agents create a worktree
 * *inside* the workspace (`<workspace>/<repo>`), so the work that matters is
 * one level down. Both levels are checked and nothing deeper: a `node_modules`
 * with vendored git repositories in it is not this agent's uncommitted work.
 */
const MAX_DEPTH = 1;
function git(repo, args) {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    }
    catch {
        // Every caller below treats null as "could not tell", which is the honest
        // reading of a git that errored, timed out, or is not installed.
        return null;
    }
}
/**
 * Repository roots at or one level below `workDir`.
 *
 * `.git` is tested with `existsSync` rather than `statSync().isDirectory()`
 * because in a worktree — which is what agents actually work in — `.git` is a
 * *file* pointing at the real git directory. Requiring a directory here would
 * miss precisely the checkouts this is for.
 */
function findRepos(workDir, depth = 0) {
    const found = [];
    if (fs.existsSync(path.join(workDir, '.git')))
        found.push(workDir);
    if (depth >= MAX_DEPTH)
        return found;
    let entries;
    try {
        entries = fs.readdirSync(workDir, { withFileTypes: true });
    }
    catch {
        return found;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        found.push(...findRepos(path.join(workDir, entry.name), depth + 1));
    }
    return found;
}
function readRepo(repo, workDir) {
    const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (status === null)
        return null;
    const lines = status ? status.split('\n') : [];
    const untrackedFiles = lines.filter((l) => l.startsWith('??')).length;
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // `@{u}` fails when no upstream is configured, which is not an error — it is
    // the answer "this branch has never been pushed".
    const ahead = git(repo, ['rev-list', '--count', '@{u}..HEAD']);
    const noUpstream = ahead === null;
    return {
        path: path.relative(workDir, repo) || '.',
        branch: branch && branch !== 'HEAD' ? branch : null,
        modifiedFiles: lines.length - untrackedFiles,
        untrackedFiles,
        unpushedCommits: noUpstream ? null : Number(ahead),
        noUpstream
    };
}
/** Whether this repository holds anything that switching the agent off destroys. */
function repoHasWork(repo) {
    if (repo.modifiedFiles > 0 || repo.untrackedFiles > 0)
        return true;
    // A branch with no upstream and no commits of its own has nothing to lose;
    // one with commits has all of them.
    return (repo.unpushedCommits ?? 0) > 0;
}
function describe(repo) {
    const parts = [];
    if (repo.modifiedFiles > 0)
        parts.push(`${repo.modifiedFiles} changed`);
    if (repo.untrackedFiles > 0)
        parts.push(`${repo.untrackedFiles} untracked`);
    if (repo.noUpstream) {
        parts.push('never pushed');
    }
    else if ((repo.unpushedCommits ?? 0) > 0) {
        parts.push(`${repo.unpushedCommits} unpushed`);
    }
    const where = repo.path === '.' ? 'the workspace' : repo.path;
    const on = repo.branch ? ` on ${repo.branch}` : '';
    return parts.length ? `${where}${on}: ${parts.join(', ')}` : `${where}${on}: clean`;
}
/**
 * Look at what an agent has not saved. Never throws; every failure is reported
 * as `checked: false` rather than as an all-clear.
 */
export function readWorkState(workDir) {
    const unchecked = (summary) => ({
        workDir,
        checked: false,
        repos: [],
        hasUnsavedWork: false,
        summary
    });
    if (!workDir)
        return unchecked('No workspace directory is recorded for this agent, so its uncommitted work could not be checked.');
    if (!fs.existsSync(workDir)) {
        return unchecked(`${workDir} does not exist, so this agent's uncommitted work could not be checked.`);
    }
    const repos = findRepos(workDir);
    if (repos.length === 0) {
        return unchecked(`No git repository was found in ${workDir}, so nothing can be said about uncommitted work. ` +
            'Anything the agent has not pushed elsewhere will still be lost.');
    }
    const states = repos.map((repo) => readRepo(repo, workDir)).filter((s) => s !== null);
    if (states.length === 0) {
        return unchecked(`git could not be run in ${workDir}, so this agent's uncommitted work could not be checked.`);
    }
    const dirty = states.filter(repoHasWork);
    return {
        workDir,
        // Partial is still checked, but say how partial: a repository that could
        // not be read is a place work might be hiding.
        checked: true,
        repos: states,
        hasUnsavedWork: dirty.length > 0,
        summary: dirty.length
            ? `Unsaved work in ${dirty.length === 1 ? '1 repository' : `${dirty.length} repositories`} — ` +
                dirty.map(describe).join('; ') + '.' +
                (states.length < repos.length ? ` ${repos.length - states.length} repository could not be read.` : '')
            : `Nothing uncommitted: ${states.map(describe).join('; ')}.` +
                (states.length < repos.length ? ` ${repos.length - states.length} repository could not be read.` : '')
    };
}
