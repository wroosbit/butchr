/**
 * Reclaiming regenerable build products from workspaces nobody is working in.
 *
 * A workspace is ~296MB, and 99.99% of that is `node_modules` that `npm
 * install` will put back. Nothing in the daemon creates them and nothing
 * removed them: `spawnSession` makes the workspace directory and stops, and the
 * worktree and its installs are the agent's own doing. So growth is unbounded,
 * and the only pass that ever reclaimed any of it was done by hand on
 * 2026-08-04 — 119 directories, 15G, on a disk at 99%.
 *
 * WHAT THIS DELETES: directories named `node_modules`, and nothing else. Not
 * source, not the worktree, not `.git`, not `.butchr-prompt.md`, not
 * `.mcp.json`, not `.claude/`, and never a workspace directory itself. A
 * workspace that is reclaimed still holds every byte of the agent's own state,
 * which is the twelve kilobytes that let it resume the conversation it was
 * stopped in.
 *
 * `dist/` IS DELIBERATELY NOT RECLAIMED. It is 163M against `node_modules`'
 * 15G — about 1% of the prize — and unlike `node_modules` it is what a resumed
 * agent needs to run anything without a rebuild. The rebuild it would cost is
 * not worth 1%. (The staleness checker cannot be affected either way: its
 * `repoRoot` is the installation's own checkout, never a workspace.)
 *
 * WHAT IT ASSUMES ABOUT THE TREES IT REMOVES — stated for KAN-262, which is
 * changing what those trees are:
 *
 *   - **A private copy.** Today every worktree runs its own `npm install`, so
 *     removing one frees its bytes and affects nothing else.
 *   - **A real directory, not a link.** A `node_modules` that is a symlink is
 *     SKIPPED, never followed — see `classifyCandidate`. That is the dangerous
 *     shape KAN-262 names: `rm -rf` through a symlink into a shared store
 *     empties it for everyone. Skipping costs a workspace's worth of bytes and
 *     cannot empty a store.
 *   - **Hard links are safe but change the meaning of the number.** Deleting a
 *     hard-linked tree unlinks names and frees only what nothing else
 *     references, so it cannot corrupt a store — but `bytes` below counts
 *     allocated blocks, which over-reports what `df` will show once a store
 *     exists. `epic/KAN-39` owns reconciling that metric after KAN-262 lands.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isStrictlyInside, workspacesRoot } from './herdr.js';

/** The one directory name this module will remove. */
const RECLAIMABLE = 'node_modules';

/**
 * Directories the scan will not descend into.
 *
 * `.git` because a worktree's git directory is not ours to walk, and the rest
 * because they are the agent's own state — there is nothing reclaimable under
 * any of them and walking them is pure cost.
 */
const NEVER_DESCEND = new Set(['.git', '.claude']);

/** One directory that was removed, or would have been. */
export interface ReclaimedPath {
  /** Absolute path of the removed `node_modules`. */
  path: string;
  /** Allocated size, from `blocks * 512` — what `df` will show, not apparent size. */
  bytes: number;
  /** Files beneath it, reported so a suspiciously small reclaim is visible. */
  files: number;
}

/** A candidate that was found and deliberately left alone. */
export interface SkippedPath {
  path: string;
  reason: string;
}

/** What one workspace yielded. */
export interface WorkspaceReclaim {
  /** `type/key`, as the board spells it. */
  workspace: string;
  workDir: string;
  removed: ReclaimedPath[];
  skipped: SkippedPath[];
  bytes: number;
}

/** A workspace the sweep refused to touch, and why. */
export interface ExcludedWorkspace {
  workspace: string;
  workDir: string;
  reason: string;
}

/** The result of one fleet-wide sweep. */
export interface ReclaimSweep {
  /** True when nothing was deleted. See `sweepWorkspaces` for the default. */
  dryRun: boolean;
  root: string;
  finishedAt: string;
  /** Workspace directories considered. */
  scanned: number;
  /** Workspaces that yielded at least one directory. */
  reclaimed: WorkspaceReclaim[];
  /** Workspaces skipped because an agent is live in them. */
  excluded: ExcludedWorkspace[];
  /** Candidates found and refused, across every workspace. */
  skipped: SkippedPath[];
  /** Total allocated bytes removed (or, in a dry run, that would be). */
  bytes: number;
  /** Directories removed (or that would be). */
  directories: number;
  /** Non-fatal failures — one unreadable workspace must not lose the sweep. */
  errors: string[];
}

export interface SweepOptions {
  /**
   * Workspace directories with a live agent in them. Derived by the caller from
   * the running fleet — never a list written down here. `router.ts` reads it
   * off the same `surveyAgents()` census `list_agents` is built from, so the
   * exclusion and the fleet the reader is looking at cannot disagree.
   */
  liveWorkDirs: Iterable<string>;
  /** When false, actually delete. Defaults to true — a dry run. */
  dryRun?: boolean;
  /** Overridable for tests; defaults to the real workspaces root. */
  root?: string;
}

/**
 * Resolve a path for comparison, tolerating one that no longer exists.
 *
 * A live agent's workspace always exists, but the census can name one that was
 * removed a moment ago, and a throw there would lose the whole sweep.
 */
function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Whether it is safe, as far as git is concerned, to delete this directory —
 * asked of the worktree it actually sits in rather than of the repository we
 * think it belongs to.
 *
 * This is the "verify per target" rule, enforced rather than assumed. A
 * workspace worktree sits on its own branch and could carry a different
 * `.gitignore`; if a branch ever un-ignored `node_modules` and tracked files
 * under it, deleting would destroy committed work. So the answer must come from
 * the target, at the moment of deleting it.
 *
 * THREE OUTCOMES, AND COLLAPSING ANY TWO OF THEM IS A BUG:
 *
 *   - **In a work tree, and ignored** — safe. This is the ordinary case.
 *   - **In a work tree, and NOT ignored** — refuse. The dangerous case: the
 *     directory may hold tracked work, and this is the whole reason the check
 *     exists.
 *   - **Not in a work tree at all** — safe. Nothing can be tracked by a
 *     repository that is not there. `task/kan-96/prefix` is a real workspace in
 *     this shape: a `.gitignore` on disk, no `.git`, 115M of packages.
 *
 * An earlier revision of this function collapsed the last two into `false` and
 * reported *"git does not report it ignored in its own worktree"* for both.
 * That sentence was **untrue of the third case** — there was no worktree to
 * report anything — and it is the failure this epic keeps finding: an artifact
 * whose wording claims more than its mechanism observed. The distinction is
 * cheap and the reason strings are now answers to the question actually asked.
 *
 * Still fails CLOSED on the one thing that matters: if `git` cannot be run at
 * all, nothing is established and nothing is deleted.
 *
 * (Note for anyone re-running this by hand: `git check-ignore` matches the
 * `node_modules/` pattern only for a path that *exists*, because the trailing
 * slash restricts it to directories and git cannot classify what is not there.
 * Against a candidate we just found on disk that is never a problem.)
 */
function gitSafeToDelete(candidate: string): { safe: boolean; reason: string } {
  const dir = path.dirname(candidate);

  let insideWorkTree: boolean;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    });
    insideWorkTree = out.trim() === 'true';
  } catch (e: any) {
    // `git` exiting non-zero here means "not a repository", which is the third
    // case. `git` failing to *run* means we know nothing — and those must not
    // be the same answer.
    if (e?.code === 'ENOENT') {
      return { safe: false, reason: 'git is not available, so nothing could be established about it' };
    }
    insideWorkTree = false;
  }

  if (!insideWorkTree) {
    return { safe: true, reason: 'not inside a git work tree — nothing here can be tracked' };
  }

  try {
    execFileSync('git', ['-C', dir, 'check-ignore', '-q', '--', candidate], { stdio: 'ignore' });
    return { safe: true, reason: 'ignored by its own worktree' };
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return { safe: false, reason: 'git is not available, so nothing could be established about it' };
    }
    return {
      safe: false,
      reason: 'inside a git work tree that does not ignore it — refusing to delete what may be tracked'
    };
  }
}

/**
 * Find the outermost `node_modules` beneath `dir`.
 *
 * Outermost only: the scan does not descend into one it has found, so a nested
 * `node_modules` is removed with its parent and never counted twice. Symlinks
 * are recorded rather than followed — see the module header on why that
 * matters more than it looks.
 */
function findCandidates(dir: string, found: string[], skipped: SkippedPath[], depth = 0): void {
  // Deep enough for `<workspace>/<repo>/<package>/node_modules` and its
  // neighbours, shallow enough that a pathological tree cannot stall a sweep.
  if (depth > 6) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable directory: nothing to reclaim from it.
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.name === RECLAIMABLE) {
      // A symlinked tree is never followed and never deleted. Removing the link
      // itself would be safe, but it would also be a change to how the
      // workspace is wired, which is KAN-262's decision and not this sweep's.
      if (entry.isSymbolicLink()) {
        skipped.push({ path: full, reason: 'is a symlink — not followed, and not this sweep to rewire' });
      } else if (entry.isDirectory()) {
        found.push(full);
      }
      continue; // Either way, do not descend into it.
    }

    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (NEVER_DESCEND.has(entry.name)) continue;

    findCandidates(full, found, skipped, depth + 1);
  }
}

/** Allocated size and file count beneath `dir`, following no links. */
function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;

  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
        continue;
      }
      try {
        // `blocks * 512` rather than `size`: this number is compared against
        // `df`, and a sparse or small file costs a block either way.
        const st = fs.lstatSync(full);
        bytes += st.blocks * 512;
        files += 1;
      } catch {
        // Vanished mid-walk. Not an error; it is simply not there to reclaim.
      }
    }
  };

  walk(dir);
  return { bytes, files };
}

/**
 * The containment discipline, applied to one candidate.
 *
 * Copied deliberately from `resetWorkspace` (`herdr.ts`) rather than shared
 * with it, because the two delete different things — but the *rule* is the same
 * one, imported from the same place so it cannot drift: lexical check first, so
 * a traversal is refused by name even when it points at nothing, then
 * `realpath` on **both** sides and compare again, so a symlinked workspace
 * cannot aim the delete somewhere Butchr does not own.
 *
 * Returns a reason when the candidate is refused, or null when it may go.
 */
function classifyCandidate(root: string, realRoot: string, candidate: string): string | null {
  // Lexical first: the answer must not depend on what happens to exist.
  if (!isStrictlyInside(root, candidate)) {
    return `'${candidate}' is not inside the workspaces root`;
  }

  const realTarget = realpathOrNull(candidate);
  if (realTarget === null) {
    return `'${candidate}' could not be resolved`;
  }
  if (!isStrictlyInside(realRoot, realTarget)) {
    return `resolves to '${realTarget}', outside the workspaces root`;
  }

  // And the rule the target's own worktree is the authority on.
  const git = gitSafeToDelete(candidate);
  if (!git.safe) return git.reason;

  return null;
}

/**
 * Reclaim from one workspace directory.
 *
 * Exported for the caller that has a single workspace in hand (KAN-261's
 * stand-down hook is the one coming). It performs its own containment checks;
 * it does not trust the sweep to have done them.
 */
export function reclaimWorkspace(
  workDir: string,
  options: { dryRun?: boolean; root?: string } = {}
): WorkspaceReclaim {
  const dryRun = options.dryRun !== false;
  const root = options.root ?? workspacesRoot();
  const realRoot = realpathOrNull(root) ?? root;

  const workspace = path.relative(root, workDir) || workDir;
  const result: WorkspaceReclaim = { workspace, workDir, removed: [], skipped: [], bytes: 0 };

  // The workspace itself gets the same treatment before anything under it is
  // even enumerated. A caller that invents a workspace location gets nothing.
  const refusal = isStrictlyInside(root, workDir)
    ? null
    : `'${workDir}' is not inside the workspaces root`;
  if (refusal) {
    result.skipped.push({ path: workDir, reason: refusal });
    return result;
  }

  const candidates: string[] = [];
  findCandidates(workDir, candidates, result.skipped);

  for (const candidate of candidates) {
    const reason = classifyCandidate(root, realRoot, candidate);
    if (reason) {
      result.skipped.push({ path: candidate, reason });
      continue;
    }

    const { bytes, files } = measure(candidate);

    if (!dryRun) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
      } catch (e: any) {
        result.skipped.push({ path: candidate, reason: `delete failed: ${e?.message ?? String(e)}` });
        continue;
      }
    }

    // Say what was reclaimed, every path, at the moment it goes. A silent
    // reclaim that surprises somebody later is the failure this epic keeps
    // deleting.
    console.log(
      `[reclaim] ${dryRun ? 'would remove' : 'removed'} ${candidate} ` +
        `(${formatBytes(bytes)}, ${files} files)`
    );

    result.removed.push({ path: candidate, bytes, files });
    result.bytes += bytes;
  }

  return result;
}

/**
 * Sweep every workspace that has no live agent in it.
 *
 * **`dryRun` defaults to TRUE, and that is a deliberate asymmetry.** A caller
 * who forgets the flag gets a report; a caller who forgets it the other way
 * would get an irreversible delete across a hundred-odd directories. The cost
 * of the safe default being wrong is one more call. The cost of the unsafe
 * default being wrong is the 2026-08-04 pass with no way back.
 */
export function sweepWorkspaces(options: SweepOptions): ReclaimSweep {
  const dryRun = options.dryRun !== false;
  const root = options.root ?? workspacesRoot();
  const realRoot = realpathOrNull(root) ?? root;

  // Live workspaces are compared by resolved path, so a symlinked workspace
  // cannot dodge the exclusion by being spelled differently in the census than
  // it is on disk.
  const live = new Map<string, string>();
  for (const workDir of options.liveWorkDirs) {
    if (!workDir) continue;
    live.set(realpathOrNull(workDir) ?? path.resolve(workDir), workDir);
  }

  const sweep: ReclaimSweep = {
    dryRun,
    root,
    finishedAt: new Date().toISOString(),
    scanned: 0,
    reclaimed: [],
    excluded: [],
    skipped: [],
    bytes: 0,
    directories: 0,
    errors: []
  };

  let types: fs.Dirent[];
  try {
    types = fs.readdirSync(root, { withFileTypes: true });
  } catch (e: any) {
    sweep.errors.push(`Could not read workspaces root '${root}': ${e?.message ?? String(e)}`);
    return sweep;
  }

  for (const typeDir of types) {
    if (!typeDir.isDirectory() || typeDir.isSymbolicLink()) continue;

    let keys: fs.Dirent[];
    try {
      keys = fs.readdirSync(path.join(root, typeDir.name), { withFileTypes: true });
    } catch (e: any) {
      sweep.errors.push(`Could not read '${typeDir.name}': ${e?.message ?? String(e)}`);
      continue;
    }

    for (const keyDir of keys) {
      if (!keyDir.isDirectory() || keyDir.isSymbolicLink()) continue;

      const workDir = path.join(root, typeDir.name, keyDir.name);
      const workspace = `${typeDir.name}/${keyDir.name}`;
      sweep.scanned += 1;

      // The exclusion, and it is the whole point of the ticket. A workspace
      // with an agent in it is left entirely alone — not measured, not walked,
      // not touched.
      const resolved = realpathOrNull(workDir) ?? workDir;
      if (live.has(resolved)) {
        sweep.excluded.push({ workspace, workDir, reason: 'an agent is live in this workspace' });
        continue;
      }

      try {
        const result = reclaimWorkspace(workDir, { dryRun, root });
        sweep.skipped.push(...result.skipped);
        if (result.removed.length > 0) {
          sweep.reclaimed.push(result);
          sweep.bytes += result.bytes;
          sweep.directories += result.removed.length;
        }
      } catch (e: any) {
        sweep.errors.push(`${workspace}: ${e?.message ?? String(e)}`);
      }
    }
  }

  sweep.finishedAt = new Date().toISOString();

  console.log(
    `[reclaim] sweep ${dryRun ? '(dry run) ' : ''}finished: ` +
      `${sweep.directories} directories, ${formatBytes(sweep.bytes)} from ` +
      `${sweep.reclaimed.length}/${sweep.scanned} workspaces; ` +
      `${sweep.excluded.length} excluded as live`
  );

  recordSweep(sweep);
  return sweep;
}

/** Human-readable bytes, for the log line and the summary sentence. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}${units[unit]}`;
}

/**
 * The last sweep, so it can ride the response the Agents page is already
 * polling — the same place, and for the same reason, as the staleness report.
 *
 * A reclaim nobody can see afterwards is the silent reclaim this epic keeps
 * deleting. Held in memory only: it describes something that happened in this
 * daemon's lifetime, and a restart genuinely has nothing to report.
 */
let lastSweep: ReclaimSummary | null = null;

/** The short form that rides `list_agents` — the counts, not every path. */
export interface ReclaimSummary {
  dryRun: boolean;
  finishedAt: string;
  workspaces: number;
  directories: number;
  bytes: number;
  excluded: number;
  skipped: number;
  errors: number;
  headline: string;
}

function recordSweep(sweep: ReclaimSweep): void {
  lastSweep = {
    dryRun: sweep.dryRun,
    finishedAt: sweep.finishedAt,
    workspaces: sweep.reclaimed.length,
    directories: sweep.directories,
    bytes: sweep.bytes,
    excluded: sweep.excluded.length,
    skipped: sweep.skipped.length,
    errors: sweep.errors.length,
    headline:
      `${sweep.dryRun ? 'Dry run: ' : ''}` +
      `${formatBytes(sweep.bytes)} in ${sweep.directories} node_modules ` +
      `${sweep.dryRun ? 'reclaimable from' : 'reclaimed from'} ${sweep.reclaimed.length} workspaces` +
      `${sweep.excluded.length > 0 ? `; ${sweep.excluded.length} left alone as live` : ''}`
  };
}

/** The last sweep this daemon ran, or null if it has run none. */
export function lastReclaimSummary(): ReclaimSummary | null {
  return lastSweep;
}

/** Test seam: forget the recorded sweep. */
export function resetLastReclaimSummary(): void {
  lastSweep = null;
}
