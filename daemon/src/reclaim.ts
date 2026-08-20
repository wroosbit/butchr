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
 * WHAT IT ASSUMES ABOUT THE TREES IT REMOVES — KAN-262 has landed (`2a259d6`),
 * so this is the world as it is rather than one being anticipated:
 *
 *   - **Not necessarily a private copy any more.** Until KAN-262, every
 *     worktree ran its own `npm install` and removing one freed its bytes.
 *     New workspaces now hard-link from a shared store instead, so both kinds
 *     are on this disk at once and the sweep meets them interchangeably.
 *   - **A real directory, not a link.** A `node_modules` that is a symlink is
 *     SKIPPED, never followed — see `classifyCandidate`. That is the dangerous
 *     shape KAN-262 names: `rm -rf` through a symlink into a shared store
 *     empties it for everyone. Skipping costs a workspace's worth of bytes and
 *     cannot empty a store.
 *   - **Hard links are safe, and they used to break the number. KAN-545 fixed
 *     the number.** Deleting a hard-linked tree unlinks names and frees only
 *     what nothing else references, so it cannot corrupt a store.
 *
 *     Until KAN-545, `bytes` added `blocks * 512` once per **name**, so a
 *     hard-linked tree was reported at full apparent size while freeing
 *     nothing. That was measured twice, three months apart in effect: KAN-262
 *     saw `rm -rf` of a 174M hard-linked `extension/node_modules` recover
 *     **5 MB** with the store intact at 292M, and on 2026-08-20 a real sweep
 *     reported **10.4 GB** against a `df` movement of **1.14 GiB**. The
 *     multiplier was simply how many workspaces shared each inode: measured the
 *     same day, `mime-db/db.json` had `nlink=6` — one name in the store and
 *     five in live workspaces, one inode, 400 blocks, counted six times.
 *
 *     `measure()` below now asks the question `df` answers: a file's blocks are
 *     counted **once**, and only when this sweep is unlinking its **last**
 *     name. The per-name figure is still reported, as `apparentBytes`, because
 *     it is a real quantity — it is just not the one an operator low on disk is
 *     asking about. See `verify-reclaim-bytes-are-freed-bytes.mjs`, which
 *     asserts the reported figure against a real before/after `statfs` delta
 *     and against an independent inode-deduplicating walk.
 *
 *     **KAN-545's ticket says hardlinking was ruled out. It was not.** That
 *     reading came from sampling one file across six surviving workspaces and
 *     finding `links=1` on all six — a sound test that landed on the
 *     private-copy half of a mixed fleet. On 2026-08-20 this machine held 38
 *     surviving workspace `node_modules`, 14 with multiply-linked files and 24
 *     without, because a tree is linked only where `link-workspace-deps.mjs`
 *     built it and private wherever anything ran `npm install`. The reporter's
 *     own `du -c` figures corroborate the sharing, since `du -c` deduplicates
 *     by inode: 4.17 GiB across all 99 directories against the tool's 9.69 GiB
 *     across 72 of them. Both measurements were right; only the conclusion
 *     drawn from the smaller sample was not.
 *
 *     A workspace reclaimed for ~0 bytes is still the mechanism working rather
 *     than failing; what has changed is that the report now says so instead of
 *     claiming the tree's full size. The question that goes with it is
 *     unchanged: *"does any workspace still hold a private copy of a tree the
 *     store already has?"* — and `apparentBytes - bytes` is now the direct
 *     answer to it. `story/KAN-151` recorded the reconciliation and
 *     `epic/KAN-39` owns it.
 *
 * THE STORE IS NOT A ROOT OF THIS SWEEP, AND MUST NOT BECOME ONE. KAN-262 puts
 * its shared store at `~/.local/share/butchr/dep-store` — a *sibling* of the
 * workspaces root, not a descendant — and its `RECLAIMER CONTRACT` asks this
 * module by name not to add it. Nothing here can: the root is `workspacesRoot()`
 * and is not a parameter of the daemon action, so a store outside it is
 * unreachable both lexically and after `realpath`. Verified against KAN-262's
 * head rather than taken from its ticket. If a future change ever makes the
 * root configurable, that is the moment this paragraph stops being true.
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
  /**
   * Allocated bytes this removal gives back — what `df` will move by.
   *
   * Blocks shared with a name that survives (the dep-store's copy, or another
   * directory in the same sweep that was credited with them) are NOT counted
   * here. See `measure`.
   */
  bytes: number;
  /**
   * Allocated bytes summed over every name beneath it, the way `bytes` was
   * computed before KAN-545. Kept because it is a real quantity and something
   * may want it; it is not what an operator low on disk is asking about.
   */
  apparentBytes: number;
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
  /** Allocated bytes actually freed from this workspace. */
  bytes: number;
  /** The per-name total, for the reason on `ReclaimedPath.apparentBytes`. */
  apparentBytes: number;
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
  /**
   * Total allocated bytes actually freed (or, in a dry run, that would be).
   *
   * This is a claim about `df`, and it is checked against one: see
   * `daemon/scripts/verify-reclaim-bytes-are-freed-bytes.mjs`.
   */
  bytes: number;
  /** The same sweep counted per name — see `ReclaimedPath.apparentBytes`. */
  apparentBytes: number;
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

/** What one directory's measurement yielded. */
interface Measurement {
  /** Allocated bytes this removal actually gives back to the filesystem. */
  bytes: number;
  /** Allocated bytes summed over every NAME — the pre-KAN-545 figure. */
  apparentBytes: number;
  /** Names beneath it, reported so a suspiciously small reclaim is visible. */
  files: number;
}

/**
 * Every inode this sweep has already claimed a name of.
 *
 * Keyed `dev:ino`. `nlink` is recorded at FIRST sight and never refreshed, for
 * the reason in `measure` below.
 */
type InodeLedger = Map<string, { blocks: number; nlink: number; claims: number }>;

/**
 * Allocated size and file count beneath `dir`, following no links.
 *
 * `bytes` is the number `df` will move by, which is not the sum of the sizes of
 * the names being unlinked. Since KAN-262 a workspace's `node_modules` is
 * hard-linked from a shared store, so one inode carries many names, and
 * unlinking one of them frees nothing at all — the blocks go back only when the
 * LAST name goes. Counting per name is what reported 10.4 GB for a sweep that
 * moved `df` by 1.14 GiB (KAN-545).
 *
 * So a file's blocks are counted once, and only when the sweep is unlinking its
 * last name. `ledger` is what makes "last" answerable: it spans the whole
 * sweep, so a tree hard-linked to another tree the same sweep is also removing
 * is credited exactly once, to whichever of them completes it.
 *
 * TWO THINGS THAT LOOK LIKE BUGS AND ARE LOAD-BEARING:
 *
 *   - **`nlink` is recorded at first sight and never refreshed.** A real sweep
 *     deletes as it goes, so by the time a second directory holding the same
 *     inode is measured, the kernel's `nlink` has already been decremented by
 *     the first deletion. Trusting the fresh reading would let a tree that
 *     still has a surviving name in the store look fully-claimed. Pinning the
 *     first reading makes the arithmetic count NAMES CLAIMED against NAMES THAT
 *     EXISTED, which is the comparison that answers the question.
 *   - **That is also what makes a dry run agree with the real thing.** A dry
 *     run deletes nothing, so it can never observe a decremented `nlink`; if
 *     the accounting depended on one, a dry run would under-report every
 *     mutually-linked pair and stop being a prediction. Both paths now read the
 *     same first-sight `nlink` and reach the same total.
 *
 * Directories are counted unconditionally: a directory cannot be hard-linked,
 * so its own blocks are always freed with it. On tmpfs that contributes zero,
 * because tmpfs directories report `blocks: 0`; on ext4 it is ~4 KiB apiece and
 * a `node_modules` has thousands of them.
 */
function measure(dir: string, ledger: InodeLedger): Measurement {
  let bytes = 0;
  let apparentBytes = 0;
  let files = 0;

  /** Charge one directory entry, deciding whether its blocks are really going. */
  const account = (st: fs.Stats, isDirectory: boolean): void => {
    // `blocks * 512` rather than `size`: this number is compared against `df`,
    // and a sparse or small file costs a block either way.
    const allocated = st.blocks * 512;
    apparentBytes += allocated;

    if (isDirectory) {
      bytes += allocated;
      return;
    }

    files += 1;

    const key = `${st.dev}:${st.ino}`;
    let entry = ledger.get(key);
    if (!entry) {
      entry = { blocks: st.blocks, nlink: st.nlink, claims: 0 };
      ledger.set(key, entry);
    }
    entry.claims += 1;

    // Exactly `===`: the blocks are freed by the one claim that completes the
    // set, and charged to the directory that made it. A later claim on the same
    // inode — which a `nlink` the sweep mis-read could produce — must not charge
    // for the same blocks twice.
    if (entry.claims === entry.nlink) bytes += entry.blocks * 512;
  };

  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        // Vanished mid-walk. Not an error; it is simply not there to reclaim.
        continue;
      }
      const isDirectory = entry.isDirectory() && !entry.isSymbolicLink();
      account(st, isDirectory);
      if (isDirectory) walk(full);
    }
  };

  // The candidate directory's own blocks go with it too.
  try {
    account(fs.lstatSync(dir), true);
  } catch {
    // Not there to reclaim; the walk below will find nothing either.
  }
  walk(dir);

  return { bytes, apparentBytes, files };
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
  options: { dryRun?: boolean; root?: string; ledger?: InodeLedger } = {}
): WorkspaceReclaim {
  const dryRun = options.dryRun !== false;
  const root = options.root ?? workspacesRoot();
  const realRoot = realpathOrNull(root) ?? root;

  // A caller sweeping several workspaces passes its own ledger, so a tree
  // hard-linked to one in another workspace is counted once across the sweep
  // rather than once per workspace. A standalone caller gets a fresh one, which
  // is the right answer for the only removal it is making.
  const ledger: InodeLedger = options.ledger ?? new Map();

  const workspace = path.relative(root, workDir) || workDir;
  const result: WorkspaceReclaim = {
    workspace,
    workDir,
    removed: [],
    skipped: [],
    bytes: 0,
    apparentBytes: 0
  };

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

    const { bytes, apparentBytes, files } = measure(candidate, ledger);

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
    // Say what was reclaimed AND what was only unlinked. A line reading
    // "removed X (0B)" looks like a failure until it says why, and "shared"
    // is the why: those blocks have a surviving name.
    const shared = apparentBytes - bytes;
    console.log(
      `[reclaim] ${dryRun ? 'would remove' : 'removed'} ${candidate} ` +
        `(${formatBytes(bytes)} freed, ${files} files` +
        `${shared > 0 ? `, ${formatBytes(shared)} shared with a surviving name` : ''})`
    );

    result.removed.push({ path: candidate, bytes, apparentBytes, files });
    result.bytes += bytes;
    result.apparentBytes += apparentBytes;
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
    apparentBytes: 0,
    directories: 0,
    errors: []
  };

  // One ledger for the whole sweep — see `measure`.
  const ledger: InodeLedger = new Map();

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
        const result = reclaimWorkspace(workDir, { dryRun, root, ledger });
        sweep.skipped.push(...result.skipped);
        if (result.removed.length > 0) {
          sweep.reclaimed.push(result);
          sweep.bytes += result.bytes;
          sweep.apparentBytes += result.apparentBytes;
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
      `${sweep.directories} directories, ${formatBytes(sweep.bytes)} freed from ` +
      `${sweep.reclaimed.length}/${sweep.scanned} workspaces; ` +
      `${sweep.excluded.length} excluded as live` +
      `${sweep.apparentBytes > sweep.bytes
        ? ` (${formatBytes(sweep.apparentBytes - sweep.bytes)} of the ` +
          `${formatBytes(sweep.apparentBytes)} unlinked is shared with names that survive)`
        : ''}`
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
  /** Allocated bytes actually freed. See `ReclaimSweep.bytes`. */
  bytes: number;
  /** The per-name total. See `ReclaimedPath.apparentBytes`. */
  apparentBytes: number;
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
    apparentBytes: sweep.apparentBytes,
    excluded: sweep.excluded.length,
    skipped: sweep.skipped.length,
    errors: sweep.errors.length,
    // The headline is the sentence an operator acts on, so it is the freed
    // figure, and it says so in the word "freed". Where the two differ the
    // difference is named rather than left for somebody to discover from `df`
    // — that gap reading as recovered space is the whole of KAN-545.
    headline:
      `${sweep.dryRun ? 'Dry run: ' : ''}` +
      `${formatBytes(sweep.bytes)} ${sweep.dryRun ? 'would be freed' : 'freed'} ` +
      `from ${sweep.directories} node_modules in ${sweep.reclaimed.length} workspaces` +
      `${sweep.apparentBytes > sweep.bytes
        ? `; a further ${formatBytes(sweep.apparentBytes - sweep.bytes)} unlinked but ` +
          `shared with names that survive`
        : ''}` +
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
