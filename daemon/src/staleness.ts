import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Is the code running here the code that was merged?
 *
 * Merging a PR changes nothing on this machine. The clone is not pulled, the
 * daemon's `dist/` does not rebuild itself, the extension's `dist/` does not
 * rebuild itself, and Chrome does not reload the unpacked extension. On
 * 2026-07-31 two PRs merged and none of the three artefacts moved: local `main`
 * was two commits behind, `daemon/dist` was two hours old, `extension/dist` was
 * a day old. A feature was declared broken on the strength of a bundle built
 * the previous afternoon.
 *
 * The cost is not the manual steps — it is that **an agent verifying its work
 * against a running daemon is verifying whatever was last built**. This board's
 * quality model rests on agents proving things with live output, and a silent
 * staleness gap makes every such proof unfalsifiable: the artefact under test
 * may not be the artefact under review.
 *
 * So this module reports; it never acts. No fetch, no rebuild, no pull. See
 * `docs/staleness.md` for the ritual it tells you to perform and for why it
 * warns rather than blocks.
 *
 * It lives outside `daemon.ts` and `herdr.ts` on purpose: it needs neither, and
 * `herdr.ts` is contended by several concurrent tickets.
 */

/** How long a computed report is reused. `list_agents` is polled every 2s. */
export const CACHE_TTL_MS = 15_000;

/**
 * Slack allowed before a source file counts as newer than a build.
 *
 * Not a fudge factor for clock skew — src and dist are on the same filesystem.
 * It absorbs the one legitimate ordering inversion: a file written in the same
 * second the build read it. Anything larger would hide a real edit.
 */
export const BUILD_SKEW_TOLERANCE_MS = 2_000;

/**
 * Age at which our knowledge of `origin/main` stops being worth asserting.
 *
 * Deliberately generous. Every task agent fetches this clone when it starts, so
 * in practice `FETCH_HEAD` is minutes old; a threshold tight enough to fire on
 * a normal working day would fire constantly and be ignored by the next one.
 */
export const FETCH_KNOWLEDGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const GIT_TIMEOUT_MS = 5_000;

/**
 * Directory names never descended into when timestamping sources.
 *
 * `node_modules` and `dist` are outputs, `.git` churns on every read. Excluding
 * them is also what keeps an `npm install` from being mistaken for a source
 * edit — the single most likely false alarm.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

export type Freshness =
  /** Up to date, with evidence. */
  | 'fresh'
  /** Demonstrably behind, with evidence. Only this state raises an alarm. */
  | 'stale'
  /** Could not be determined; say so rather than guess. */
  | 'unknown'
  /** Deliberately not judged — see the detail for why. */
  | 'not-applicable';

export type StalenessItemId =
  | 'git'
  | 'daemon-build'
  | 'daemon-process'
  | 'extension-build';

export interface StalenessItem {
  id: StalenessItemId;
  /** What is being judged, e.g. "daemon build". */
  label: string;
  state: Freshness;
  /** One short clause for a banner: "2 commits behind origin/main". */
  headline: string;
  /** The evidence the verdict rests on — files, counts, timestamps. */
  detail: string;
  /** The command that fixes it, when a command can. */
  remedy?: string;
  /** Something true that the check cannot itself observe. */
  note?: string;
}

export interface StalenessReport {
  /** The checkout this daemon is running from. Nothing outside it is examined. */
  repoRoot: string;
  checkedAt: string;
  /** True when at least one item is `stale`. Nothing else raises an alarm. */
  stale: boolean;
  /** One line naming every stale item, or null when nothing is stale. */
  summary: string | null;
  items: StalenessItem[];
}

export interface StalenessOptions {
  repoRoot: string;
  /**
   * When the process asking is the long-lived daemon, its start time. Enables
   * the `daemon-process` item: a rebuilt `dist/` that the running daemon has
   * not loaded is still the old code, and that gap looks exactly like success.
   */
  daemonStartedAt?: Date;
  /** Skip the cache. */
  force?: boolean;
}

// --- small helpers ----------------------------------------------------------

/** Compact age, for a line someone reads rather than parses. */
function describeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function ageOf(mtimeMs: number, now: number): string {
  return describeAge(now - mtimeMs);
}

/**
 * Run git read-only against a checkout, or null if it fails for any reason.
 *
 * `GIT_OPTIONAL_LOCKS=0` matters: this clone is shared, and task agents run git
 * in it concurrently. A status check that takes `index.lock` could make another
 * agent's command fail — a monitor that breaks the thing it monitors is worse
 * than no monitor.
 */
function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }).trim();
  } catch {
    return null;
  }
}

interface NewestFile {
  /** Path relative to the scanned root, for a legible message. */
  relPath: string;
  mtimeMs: number;
  /** How many files were considered — the scan's own evidence. */
  scanned: number;
}

/**
 * The most recently modified file under `root`, ignoring {@link SKIP_DIRS}.
 *
 * The scan never leaves `root`, and it refuses to descend into any directory
 * that is itself a git checkout. That second rule is what makes the whole check
 * immune to the obvious false alarm: an agent building in its own worktree is
 * writing to a different tree entirely, and even a worktree created *inside*
 * this one would be stepped over rather than timestamped.
 */
function newestFile(root: string, skip: Set<string> = SKIP_DIRS): NewestFile | null {
  let bestPath = '';
  let bestMtime = -1;
  let scanned = 0;

  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable mid-scan; a timestamp is a diagnostic, not an audit
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // A nested checkout belongs to somebody else's build.
        if (fs.existsSync(path.join(abs, '.git'))) continue;
        walk(abs, childRel);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = fs.statSync(abs);
          scanned++;
          if (mtimeMs > bestMtime) {
            bestMtime = mtimeMs;
            bestPath = childRel;
          }
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };

  walk(root, '');
  return bestMtime < 0 ? null : { relPath: bestPath, mtimeMs: bestMtime, scanned };
}

// --- the three (and a half) checks ------------------------------------------

/**
 * Local `HEAD` against the last-known `origin/main`.
 *
 * No network. The remote ref is whatever the last `git fetch` left behind, and
 * how old that knowledge is goes in the evidence rather than being papered
 * over — a blocking fetch on daemon startup would trade one silent failure for
 * a slower one.
 */
function checkGit(repoRoot: string, now: number): StalenessItem {
  const base = { id: 'git' as const, label: 'local checkout' };

  if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      ...base,
      state: 'unknown',
      headline: 'not a git checkout',
      detail: `${repoRoot} is not a git working tree, so there is nothing to compare against origin/main.`
    };
  }

  // `origin/HEAD` names the remote's default branch when the clone recorded
  // one; plain clones do, and worktrees share it. `origin/main` is the fallback
  // rather than an assumption made first.
  let remoteRef = git(repoRoot, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (!remoteRef || !remoteRef.startsWith('origin/')) {
    remoteRef = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'origin/main'])
      ? 'origin/main'
      : null;
  }
  if (!remoteRef) {
    return {
      ...base,
      state: 'unknown',
      headline: 'no origin/main to compare against',
      detail:
        `${repoRoot} has no origin/HEAD and no origin/main ref. Run \`git -C ${repoRoot} fetch origin\` once ` +
        'so there is a remote ref to compare with.'
    };
  }
  const defaultBranch = remoteRef.slice('origin/'.length);

  const branch = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = git(repoRoot, ['rev-parse', '--short', 'HEAD']) ?? '(unknown)';
  const remoteHead = git(repoRoot, ['rev-parse', '--short', remoteRef]) ?? '(unknown)';

  // How old our knowledge of the remote is. FETCH_HEAD lives in the common git
  // dir, which is not `.git` when this checkout is a linked worktree.
  let fetchedAgo: string | null = null;
  let fetchAgeMs: number | null = null;
  const commonDir = git(repoRoot, ['rev-parse', '--git-common-dir']);
  if (commonDir) {
    const abs = path.isAbsolute(commonDir) ? commonDir : path.join(repoRoot, commonDir);
    try {
      fetchAgeMs = now - fs.statSync(path.join(abs, 'FETCH_HEAD')).mtimeMs;
      fetchedAgo = describeAge(fetchAgeMs);
    } catch {
      // never fetched in this clone
    }
  }
  const provenance = fetchedAgo
    ? `${remoteRef} is as known at the last fetch, ${fetchedAgo} ago`
    : `${remoteRef} has never been fetched in this clone`;

  // Only the default branch is judged. A checkout parked on a feature branch is
  // somebody working, not a stale install, and calling that "stale" every day is
  // how a warning gets ignored. The comparison is still reported, unalarmed.
  if (branch !== defaultBranch) {
    const where = branch ? `branch ${branch}` : `detached HEAD at ${head}`;
    const counts = git(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
    const behind = counts ? Number(counts.split(/\s+/)[1]) : NaN;
    const relation = Number.isFinite(behind)
      ? `${behind} commit${behind === 1 ? '' : 's'} behind ${remoteRef}`
      : `relation to ${remoteRef} unknown`;
    return {
      ...base,
      state: 'not-applicable',
      headline: `on ${where}, not ${defaultBranch}`,
      detail:
        `This checkout is on ${where} — a deliberate checkout, so it is not judged against ${remoteRef}. ` +
        `For reference it is ${relation}. ${provenance}.`
    };
  }

  const counts = git(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
  const parts = counts ? counts.split(/\s+/).map(Number) : [];
  const ahead = parts[0];
  const behind = parts[1];
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return {
      ...base,
      state: 'unknown',
      headline: `could not compare ${defaultBranch} with ${remoteRef}`,
      detail: `\`git rev-list --left-right --count HEAD...${remoteRef}\` produced no usable answer. ${provenance}.`
    };
  }

  if (behind > 0) {
    return {
      ...base,
      state: 'stale',
      headline: `${defaultBranch} is ${behind} commit${behind === 1 ? '' : 's'} behind ${remoteRef}`,
      detail:
        `HEAD is ${head}, ${remoteRef} is ${remoteHead}: ${behind} commit${behind === 1 ? '' : 's'} merged that ` +
        `this checkout does not have${ahead > 0 ? `, and ${ahead} local commit${ahead === 1 ? '' : 's'} it does not know about` : ''}. ` +
        `Anything built here predates ${remoteHead}. ${provenance}.`,
      remedy: `git -C ${repoRoot} pull --ff-only`
    };
  }

  // Level with what we know — but if that knowledge is old, say so instead of
  // asserting freshness we cannot support. `unknown`, not `stale`: nothing here
  // is demonstrably behind, and only demonstrable staleness raises an alarm.
  if (fetchAgeMs === null || fetchAgeMs > FETCH_KNOWLEDGE_MAX_AGE_MS) {
    return {
      ...base,
      state: 'unknown',
      headline: `level with ${remoteRef}, but that ref is ${fetchedAgo ?? 'never fetched'}`,
      detail:
        `HEAD is ${head} and matches the ${remoteRef} this clone knows about, but ${provenance} — ` +
        'the real origin/main may have moved since. This is not a claim that anything is behind.',
      remedy: `git -C ${repoRoot} fetch origin`
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: `${defaultBranch} is level with ${remoteRef}`,
    detail:
      `HEAD is ${head}, the same commit as ${remoteRef}` +
      `${ahead > 0 ? ` (plus ${ahead} unpushed local commit${ahead === 1 ? '' : 's'})` : ''}. ${provenance}.`
  };
}

/**
 * Newest source file against newest build output.
 *
 * mtimes rather than content hashes because a merge, a pull and a hand-edit all
 * bump mtime, and because the question is only ever "did anything change after
 * the last build" — which is the cheap direction of the comparison.
 */
function checkBuild(
  id: 'daemon-build' | 'extension-build',
  label: string,
  repoRoot: string,
  srcRel: string,
  distRel: string,
  remedy: string,
  now: number,
  note?: string
): StalenessItem {
  const base = { id, label, ...(note ? { note } : {}) };
  const srcDir = path.join(repoRoot, srcRel);
  const distDir = path.join(repoRoot, distRel);

  const src = newestFile(srcDir);
  if (!src) {
    return {
      ...base,
      state: 'unknown',
      headline: `no sources found in ${srcRel}`,
      detail: `Nothing readable under ${srcDir}, so there is no source timestamp to compare a build against.`
    };
  }

  const dist = newestFile(distDir, new Set(['.git']));
  if (!dist) {
    return {
      ...base,
      state: 'stale',
      headline: `${distRel} has never been built`,
      detail:
        `${distDir} is missing or empty, while ${srcRel} has ${src.scanned} files, the newest being ` +
        `${srcRel}/${src.relPath} (${ageOf(src.mtimeMs, now)} old). Nothing here can be running current code.`,
      remedy
    };
  }

  const lagMs = src.mtimeMs - dist.mtimeMs;
  if (lagMs > BUILD_SKEW_TOLERANCE_MS) {
    return {
      ...base,
      state: 'stale',
      headline: `${distRel} is older than ${srcRel}`,
      detail:
        `${srcRel}/${src.relPath} was modified ${ageOf(src.mtimeMs, now)} ago, ${describeAge(lagMs)} after the ` +
        `newest file in ${distRel} (${dist.relPath}, ${ageOf(dist.mtimeMs, now)} old). The build does not ` +
        'contain that change.',
      remedy
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: `${distRel} is newer than every source`,
    detail:
      `${distRel} was last written ${ageOf(dist.mtimeMs, now)} ago (${dist.relPath}); the newest of the ` +
      `${src.scanned} files in ${srcRel} is ${src.relPath}, ${ageOf(src.mtimeMs, now)} old.`
  };
}

/**
 * The running daemon against the build on disk.
 *
 * The fourth gap, and the one that catches you *after* you have done the right
 * thing: `npm run build` rewrites `dist/`, and the daemon that has been up since
 * this morning goes on serving the code it loaded then. Every symptom is
 * identical to a stale build, so it belongs in the same report.
 */
function checkDaemonProcess(repoRoot: string, startedAt: Date, now: number): StalenessItem {
  const base = { id: 'daemon-process' as const, label: 'running daemon' };
  const dist = newestFile(path.join(repoRoot, 'daemon/dist'), new Set(['.git']));
  const upFor = describeAge(now - startedAt.getTime());

  if (!dist) {
    return {
      ...base,
      state: 'unknown',
      headline: 'no build on disk to compare against',
      detail: `This daemon has been up ${upFor}, but daemon/dist is missing or empty.`
    };
  }

  if (dist.mtimeMs > startedAt.getTime() + BUILD_SKEW_TOLERANCE_MS) {
    return {
      ...base,
      state: 'stale',
      headline: 'this daemon started before the build it is meant to be running',
      detail:
        `The daemon has been up ${upFor} (since ${startedAt.toISOString()}), but daemon/dist was rebuilt ` +
        `${ageOf(dist.mtimeMs, now)} ago (${dist.relPath}). The process is still executing the code it loaded ` +
        'at startup, not what is on disk.',
      remedy: 'Restart the daemon: pkill -f butchr/daemon/dist/daemon.js (the next client respawns it)'
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: 'running the build that is on disk',
    detail: `Up ${upFor}, started after daemon/dist was last written (${dist.relPath}, ${ageOf(dist.mtimeMs, now)} old).`
  };
}

// --- the report -------------------------------------------------------------

let cached: { at: number; key: string; report: StalenessReport } | null = null;

/**
 * The staleness report, cached for {@link CACHE_TTL_MS}.
 *
 * Cached because `list_agents` is polled every 2s by the Agents page and this
 * costs four git invocations and a directory walk. Never throws: a check that
 * can take the daemon down is not a safety feature.
 */
export function getStalenessReport(options: StalenessOptions): StalenessReport {
  const key = `${options.repoRoot}|${options.daemonStartedAt?.getTime() ?? ''}`;
  const now = Date.now();
  if (!options.force && cached && cached.key === key && now - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }

  let items: StalenessItem[];
  try {
    items = [
      checkGit(options.repoRoot, now),
      checkBuild(
        'daemon-build',
        'daemon build',
        options.repoRoot,
        'daemon/src',
        'daemon/dist',
        'cd daemon && npm run build && restart the daemon',
        now
      ),
      ...(options.daemonStartedAt
        ? [checkDaemonProcess(options.repoRoot, options.daemonStartedAt, now)]
        : []),
      checkBuild(
        'extension-build',
        'extension build',
        options.repoRoot,
        'extension',
        'extension/dist',
        'cd extension && npm run build, then reload the extension at chrome://extensions',
        now,
        // Said plainly because the alternative is implying a guarantee we do not
        // have: nothing outside Chrome can see which bundle Chrome has loaded,
        // and nothing outside Chrome can make it reload one.
        'Whether Chrome has actually loaded this build cannot be observed from here, and cannot be ' +
          'triggered from here either. After rebuilding, press Reload on the extension at chrome://extensions.'
      )
    ];
  } catch (err: any) {
    items = [
      {
        id: 'git',
        label: 'staleness check',
        state: 'unknown',
        headline: 'the check itself failed',
        detail: `Staleness check threw: ${err?.message ?? String(err)}`
      }
    ];
  }

  const staleItems = items.filter((i) => i.state === 'stale');
  const report: StalenessReport = {
    repoRoot: options.repoRoot,
    checkedAt: new Date(now).toISOString(),
    stale: staleItems.length > 0,
    summary: staleItems.length ? staleItems.map((i) => i.headline).join('; ') : null,
    items
  };

  cached = { at: now, key, report };
  return report;
}

/** Drop the cached report. For tests and for the verification script. */
export function resetStalenessCache(): void {
  cached = null;
}

/** The report as lines for a log or a terminal, one item each. */
export function formatStalenessReport(report: StalenessReport): string[] {
  const mark: Record<Freshness, string> = {
    fresh: 'OK  ',
    stale: 'STALE',
    unknown: '?   ',
    'not-applicable': '-   '
  };
  const lines = report.items.map(
    (i) => `  ${mark[i.state]} ${i.label}: ${i.headline}\n        ${i.detail}` +
      (i.remedy ? `\n        fix: ${i.remedy}` : '') +
      (i.note ? `\n        note: ${i.note}` : '')
  );
  return [
    report.stale
      ? `staleness: ${report.summary} — you may be testing code that is not what was merged`
      : 'staleness: nothing stale',
    ...lines
  ];
}
