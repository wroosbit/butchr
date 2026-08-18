import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FETCH_INTERVAL_MS, PROMPT_REF, resolvePromptSource } from './prompt-source.js';
import {
  BUILD_SKEW_TOLERANCE_MS,
  classifyServerBuild,
  isBehindDeploy,
  newestMtimeMs,
  ServerBuildRelation,
  ServingProcess
} from './mcp-build.js';

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
 * Defined in `mcp-build.ts` and re-exported here, unchanged, so that the
 * `mcp-servers` item — which lives in that module's dependency-free half
 * because every agent's server process loads it — judges a loaded build by the
 * same number this file judges a `dist` by. Two copies of one tolerance is the
 * shape `docs/doc-constant-drift.md` is about.
 */
export { BUILD_SKEW_TOLERANCE_MS } from './mcp-build.js';

/**
 * Age at which our knowledge of `origin/main` stops being worth asserting.
 *
 * Deliberately generous. Every task agent fetches this clone when it starts, so
 * in practice `FETCH_HEAD` is minutes old; a threshold tight enough to fire on
 * a normal working day would fire constantly and be ignored by the next one.
 */
export const FETCH_KNOWLEDGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long after this daemon starts before its view of connected servers is
 * worth reading (KAN-526).
 *
 * A daemon restart drops every registration, and each agent's `mcp.js`
 * re-announces itself on a jittered backoff capped at `RECONNECT_MAX_MS`
 * (15s, `mcp.ts`). Reading the connection map before they have come back
 * measures the restart rather than the fleet — and it fails toward the
 * comfortable answer, an empty list that could be mistaken for "nothing stale".
 *
 * Three times the cap rather than exactly it: the backoff is jittered, an agent
 * whose client was itself starting takes about twelve seconds to register at
 * all, and this delays a log line rather than anything anybody waits on.
 */
export const RECONNECT_SETTLE_MS = 45_000;

const GIT_TIMEOUT_MS = 5_000;

/**
 * Age at which the ref briefs are rendered from stops being credibly current.
 *
 * Much tighter than {@link FETCH_KNOWLEDGE_MAX_AGE_MS}, and deliberately so:
 * that constant asks "is our picture of the remote worth asserting", which is a
 * question about a human's fetch habits. This one asks whether
 * `PromptSourceKeeper` is *running*, and that is a machine on a timer. At
 * `FETCH_INTERVAL_MS` this is six consecutive missed fetches — a keeper that is
 * dead, not one that was briefly unlucky with the network.
 */
export const PROMPT_REF_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * How old this clone's knowledge of its remote is, or null if never fetched.
 *
 * `FETCH_HEAD` lives in the common git dir, which is not `.git` when the
 * checkout is a linked worktree — every task agent's is.
 */
function fetchHeadAgeMs(repoRoot: string, now: number): number | null {
  const commonDir = git(repoRoot, ['rev-parse', '--git-common-dir']);
  if (!commonDir) return null;
  const abs = path.isAbsolute(commonDir) ? commonDir : path.join(repoRoot, commonDir);
  try {
    return now - fs.statSync(path.join(abs, 'FETCH_HEAD')).mtimeMs;
  } catch {
    return null; // never fetched in this clone
  }
}

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
  | 'prompt-source'
  | 'daemon-build'
  | 'daemon-process'
  | 'mcp-servers'
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
  /**
   * The MCP server processes currently connected, newest connection per agent.
   *
   * Enables the `mcp-servers` item (KAN-526). Absent — in the unit-test and
   * script constructions that hold no daemon — the item reports `unknown`
   * rather than silently claiming nothing is stale, which is the distinction
   * the whole item is about.
   *
   * A supplier rather than an array: the report is cached for
   * {@link CACHE_TTL_MS} but the fleet is not, and a stored array would be a
   * snapshot of whoever happened to be connected when the daemon started.
   */
  servers?: () => ServingProcess[];
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

// --- what a build actually reads --------------------------------------------

/**
 * The inputs of one build, stated as an **exhaustive** classification of the
 * package directory beside it.
 *
 * `extension-build` used to compare `extension/dist` against the newest file
 * anywhere under `extension/`. That tree also holds `extension/scripts/` —
 * verify scripts and render harnesses, which run *against* a build and are
 * never compiled into one — so editing one reported a stale extension build
 * with a remedy no rebuild could satisfy, and which asks the operator for a
 * `chrome://extensions` reload no agent can perform (KAN-305). The noise was
 * not the cost: while that item was red for a verify script, **a genuinely
 * stale build was indistinguishable from it**, which is the single thing this
 * check exists to prevent.
 *
 * Narrowing to a list of inputs alone would trade that lying red for a lying
 * green, which is worse: a directory added later and genuinely read by the
 * build would simply never be scanned, and the item would report fresh over a
 * `dist` that was behind it. So the classification covers **every** entry under
 * `root` — anything matching neither list makes the item `unknown` and names
 * itself, rather than being silently assumed harmless.
 *
 * That last part is why this is data rather than a comment above a path. A
 * comment saying "inputs are src plus the entry points" is re-opened by the
 * next directory added under `extension/` and nobody finds out; an entry that
 * satisfies neither list here cannot pass through the check quietly. It stays
 * a runtime classification rather than a type because what it is about — which
 * files exist on disk — is not something the compiler can be shown.
 */
interface BuildInputs {
  /** Package directory, relative to the repo root, classified exhaustively. */
  root: string;
  /** Entry names, or `*.ext` / `prefix*` patterns over them, the build reads. */
  inputs: readonly string[];
  /** Entries the build does not read, each with the reason it does not. */
  notInputs: readonly { readonly entry: string; readonly because: string }[];
}

/**
 * `tsc` with `daemon/tsconfig.json`, whose `include` is exactly `src/**`.
 *
 * Confirmed rather than assumed (KAN-305 asked): `rootDir` is `src`, `outDir`
 * is `dist`, and nothing else under `daemon/` is compiled. The five entries
 * that are not inputs were each read before being written down here.
 */
const DAEMON_BUILD_INPUTS: BuildInputs = {
  root: 'daemon',
  inputs: ['src', 'tsconfig.json', 'package.json', 'package-lock.json'],
  notInputs: [
    { entry: 'dist', because: 'the output this check judges' },
    {
      entry: 'node_modules',
      because: 'installed rather than authored — an npm install would otherwise read as an edit'
    },
    {
      entry: 'scripts',
      because: 'verify and probe scripts; they import dist/ and are never compiled into it'
    },
    { entry: 'bin', because: 'launchers that exec dist/ at run time; tsc never reads them' },
    { entry: 'systemd', because: 'unit files installed by hand, outside any build' },
    { entry: 'typecheck', because: 'a separate tsconfig that emits nothing into dist/' },
    { entry: '.*', because: 'dotfiles — tooling and editor state, never a build input here' }
  ]
};

/**
 * `vite build` with `extension/vite.config.js`.
 *
 * The three `rollupOptions.input` entries are `sidepanel.html`, `options.html`
 * and `agents.html` at this root; each pulls in its sibling `.jsx`, and
 * `sidepanel.html` its sibling `.css` — hence the patterns rather than six
 * filenames, so that adding a fourth entry point is an input by default and
 * fails toward the red. `public/` is Vite's publicDir and is copied verbatim
 * into `dist/` (`manifest.json`, the icons, the service worker), so it is as
 * much a build input as anything imported.
 */
const EXTENSION_BUILD_INPUTS: BuildInputs = {
  root: 'extension',
  inputs: ['src', 'public', '*.html', '*.jsx', '*.css', 'vite.config.js', 'package.json', 'package-lock.json'],
  notInputs: [
    { entry: 'dist', because: 'the output this check judges' },
    {
      entry: 'node_modules',
      because: 'installed rather than authored — an npm install would otherwise read as an edit'
    },
    {
      entry: 'scripts',
      because:
        'verify scripts, render harnesses and screenshot drivers; they run against a build and no ' +
        'import from extension/src reaches them (KAN-305)'
    },
    { entry: '.*', because: 'dotfiles — tooling and editor state, never a build input here' }
  ]
};

/** Exact name, `*.suffix`, or `prefix*`. Deliberately not a glob library. */
function matchesEntry(name: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

interface ClassifiedEntries {
  /** Entry names that feed the build. */
  inputs: string[];
  /** Entry names matching neither list — this check cannot judge them. */
  unclassified: string[];
}

function classifyEntries(rootAbs: string, spec: BuildInputs): ClassifiedEntries {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return { inputs: [], unclassified: [] };
  }
  const inputs: string[] = [];
  const unclassified: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (spec.inputs.some((p) => matchesEntry(name, p))) inputs.push(name);
    else if (spec.notInputs.some((n) => matchesEntry(name, n.entry))) continue;
    // An entry holding no files at all contributes no timestamp, so it cannot
    // make a build stale whatever it turns out to be — and a doubt that cannot
    // change the verdict is a false alarm, which is the defect this whole
    // change is about. The live install has carried an empty, untracked
    // `extension/sidepanel/` since July. It is reported the moment it gains a
    // file, which is the moment it could matter.
    else if (!entry.isDirectory() || newestFile(path.join(rootAbs, name)) !== null) {
      unclassified.push(name);
    }
  }
  return { inputs: inputs.sort(), unclassified: unclassified.sort() };
}

/**
 * The newest file among a set of entries under `rootAbs`.
 *
 * `relPath` comes back relative to `rootAbs` so the evidence reads as a path
 * somebody can open: `extension/src/components/StalenessBanner.jsx`, not a
 * fragment of one.
 */
function newestAmong(rootAbs: string, names: string[]): NewestFile | null {
  let best: { relPath: string; mtimeMs: number } | null = null;
  let scanned = 0;
  for (const name of names) {
    const abs = path.join(rootAbs, name);
    let isDir: boolean;
    let mtimeMs: number;
    try {
      const stat = fs.statSync(abs);
      isDir = stat.isDirectory();
      mtimeMs = stat.mtimeMs;
    } catch {
      continue; // declared but absent; an input set is a declaration, not an audit
    }
    const found = isDir ? newestFile(abs) : { relPath: '', mtimeMs, scanned: 1 };
    if (!found) continue;
    scanned += found.scanned;
    if (!best || found.mtimeMs > best.mtimeMs) {
      best = {
        relPath: found.relPath ? `${name}/${found.relPath}` : name,
        mtimeMs: found.mtimeMs
      };
    }
  }
  return best ? { ...best, scanned } : null;
}

/** The input set, for the report line where the next reader meets it. */
function describeInputs(spec: BuildInputs, classified: ClassifiedEntries): string {
  const not = spec.notInputs.map((n) => n.entry).join(', ');
  return `inputs: ${classified.inputs.join(', ') || '(none)'} — not inputs: ${not}`;
}

// --- the three (and a half) checks ------------------------------------------

/**
 * How this checkout stands to its remote — a shape, not a pair of integers.
 *
 * KAN-437 is what two loose numbers cost. The report named `behind`, said
 * nothing about `ahead`, and prescribed `pull --ff-only` — a fast-forward that
 * was not available, against a clone that was not behind in the way the number
 * implied. A reader acts on the number they are given.
 *
 * As a union, every relation that needs a *different* remedy is its own kind,
 * and the remedy is chosen per kind rather than printed unconditionally. Adding
 * a kind without handling it makes the `level` narrowing below fail to compile,
 * so "forgot one" surfaces as a build error instead of as confident wrong
 * advice.
 */
export type RemoteRelation =
  /** The object graph is truncated: no count here means what it appears to. */
  | { kind: 'shallow'; ahead: number; behind: number }
  /** Local commits the remote lacks *and* remote commits this clone lacks. */
  | { kind: 'diverged'; ahead: number; behind: number }
  /** Strictly behind — a fast-forward is genuinely available. */
  | { kind: 'behind'; behind: number }
  /** Nothing to fetch. `ahead` may still be non-zero: unpushed local work. */
  | { kind: 'level'; ahead: number };

/**
 * Shallowness is asked *first*, and that order is the whole point.
 *
 * On a grafted clone `ahead` and `behind` are not divergence counts at all —
 * they are the sizes of each ref's whole *visible* history, because the shared
 * ancestry sits outside the graft horizon. KAN-437's clone reported
 * `[ahead 179, behind 4]` while being 22 behind and 0 ahead. Reading those
 * numbers before establishing the graph is intact is reading noise.
 */
export function classifyRemoteRelation(repoRoot: string, remoteRef: string): RemoteRelation | null {
  const counts = git(repoRoot, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
  const parts = counts ? counts.split(/\s+/).map(Number) : [];
  const ahead = parts[0];
  const behind = parts[1];
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;

  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true') {
    return { kind: 'shallow', ahead, behind };
  }
  if (ahead > 0 && behind > 0) return { kind: 'diverged', ahead, behind };
  if (behind > 0) return { kind: 'behind', behind };
  return { kind: 'level', ahead };
}

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

  // How old our knowledge of the remote is.
  const fetchAgeMs = fetchHeadAgeMs(repoRoot, now);
  const fetchedAgo = fetchAgeMs === null ? null : describeAge(fetchAgeMs);
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

  const relation = classifyRemoteRelation(repoRoot, remoteRef);
  if (!relation) {
    return {
      ...base,
      state: 'unknown',
      headline: `could not compare ${defaultBranch} with ${remoteRef}`,
      detail: `\`git rev-list --left-right --count HEAD...${remoteRef}\` produced no usable answer. ${provenance}.`
    };
  }

  // A graft makes every other number on this item meaningless, so it is
  // reported as the finding rather than folded into a commit count. It alarms:
  // a truncated clone silently serves stale files to everything reading them,
  // and `pull --ff-only` cannot repair it.
  if (relation.kind === 'shallow') {
    return {
      ...base,
      state: 'stale',
      headline: `${defaultBranch} is in a SHALLOW clone — its relation to ${remoteRef} cannot be measured`,
      detail:
        `\`git rev-parse --is-shallow-repository\` is true, so this clone's history is truncated at a graft ` +
        `point and the shared ancestry with ${remoteRef} may sit outside it. The raw counts here ` +
        `(${relation.ahead} ahead, ${relation.behind} behind) are the sizes of each ref's *visible* history, not a measure of ` +
        `divergence — KAN-437's clone read [ahead 179, behind 4] while being 22 behind and 0 ahead. ` +
        `Restore the history before trusting any comparison, including this one. ${provenance}.`,
      remedy: `git -C ${repoRoot} fetch --unshallow origin`
    };
  }

  // Diverged is not "behind with an extra number". The fast-forward that
  // `behind` implies does not exist here, so the remedy must not be one.
  if (relation.kind === 'diverged') {
    return {
      ...base,
      state: 'stale',
      headline:
        `${defaultBranch} has DIVERGED from ${remoteRef} — ` +
        `${relation.ahead} ahead, ${relation.behind} behind`,
      detail:
        `HEAD is ${head}, ${remoteRef} is ${remoteHead}. This checkout has ${relation.ahead} local ` +
        `commit${relation.ahead === 1 ? '' : 's'} the remote does not have, and is missing ${relation.behind} ` +
        `that it does. **\`pull --ff-only\` will fail here** — there is no fast-forward to take. Inspect the ` +
        `local commits before deciding whether to rebase, reset or push them. ${provenance}.`,
      remedy: `git -C ${repoRoot} log --oneline ${remoteRef}..HEAD`
    };
  }

  if (relation.kind === 'behind') {
    return {
      ...base,
      state: 'stale',
      headline: `${defaultBranch} is ${relation.behind} commit${relation.behind === 1 ? '' : 's'} behind ${remoteRef}`,
      detail:
        `HEAD is ${head}, ${remoteRef} is ${remoteHead}: ${relation.behind} commit${relation.behind === 1 ? '' : 's'} merged that ` +
        `this checkout does not have, and nothing local it does not know about — so a fast-forward is available. ` +
        `Anything built here predates ${remoteHead}. ${provenance}.`,
      remedy: `git -C ${repoRoot} pull --ff-only`
    };
  }

  // `relation` is narrowed to `level` here. A new kind added to RemoteRelation
  // without a branch above breaks this line rather than falling through to a
  // freshness claim it has not earned.
  const unpushed: number = relation.ahead;

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
      `${unpushed > 0 ? ` (plus ${unpushed} unpushed local commit${unpushed === 1 ? '' : 's'})` : ''}. ${provenance}.`
  };
}

/**
 * Are the briefs agents are being handed rendered from something current?
 *
 * THE ITEM KAN-442 ASKED FOR, and it is deliberately not "is the working tree
 * behind". That question already had an answer — `checkGit` above — and the
 * answer was always going to be yes: nothing advances the shared clone's `main`,
 * nothing should, and after KAN-442 nothing needs to. An item that went red
 * every day for a condition nobody is meant to fix is how a warning gets
 * ignored, which is the failure mode `checkGit` is already careful about.
 *
 * What can actually regress is the *source*: `PromptLoader` renders at
 * `origin/main` and falls back to the working tree when it cannot. That fallback
 * is the old defect returning, and it is silent — the brief still ships and
 * still reads like a standing rule. So this item asks two things the old check
 * could not:
 *
 *   1. **Which source would a render use right now?** `worktree` is the
 *      regression: briefs are stale again by exactly the mechanism KAN-442
 *      removed.
 *   2. **How old is the ref?** A `PromptSourceKeeper` that has stopped fetching
 *      leaves rendering from `origin/main` technically true and progressively
 *      meaningless. Nothing else on this machine would notice.
 *
 * WHAT IT STILL CANNOT SEE, named because a check's silence is not evidence:
 * whether an *already-briefed* agent re-reads anything. It cannot — that is the
 * KAN-242 finding, the brief lives in a context nothing on this machine can
 * reach, and no check here will ever close it. This item is about what the next
 * activation will be handed.
 */
function checkPromptSource(repoRoot: string, now: number): StalenessItem {
  const base = { id: 'prompt-source' as const, label: 'prompt source' };
  const source = resolvePromptSource(repoRoot);

  if (source.kind === 'worktree') {
    return {
      ...base,
      state: 'stale',
      headline: `briefs are being rendered from the WORKING TREE, not ${PROMPT_REF}`,
      detail:
        `${source.because}. The working tree's default branch is never advanced — agents read it ` +
        `concurrently and \`prompts/task.md\` forbids moving it — so it falls behind by one commit per ` +
        `merge and every brief rendered from it carries governance that has moved. That is the defect ` +
        `KAN-442 removed by reading templates at ${PROMPT_REF} with \`git show\`, and this is what its ` +
        `return looks like.`,
      remedy: `git -C ${repoRoot} fetch origin`
    };
  }

  const ageMs = fetchHeadAgeMs(repoRoot, now);
  const at = `${source.ref} is ${source.sha.slice(0, 7)}`;

  if (ageMs === null) {
    return {
      ...base,
      state: 'unknown',
      headline: `rendering from ${PROMPT_REF}, but this clone records no fetch`,
      detail:
        `${at}, and templates are read there rather than from the working tree — but there is no ` +
        `FETCH_HEAD, so how old that ref is cannot be established from here. The ref exists, so it was ` +
        `fetched at some point; nothing says when.`,
      remedy: `git -C ${repoRoot} fetch origin`
    };
  }

  if (ageMs > PROMPT_REF_MAX_AGE_MS) {
    return {
      ...base,
      state: 'stale',
      headline: `${PROMPT_REF} was last fetched ${describeAge(ageMs)} ago — briefs are that far behind`,
      detail:
        `${at}, and templates are read there rather than from the working tree, so briefs are current ` +
        `with whatever that fetch brought and nothing since. PromptSourceKeeper fetches every ` +
        `${describeAge(FETCH_INTERVAL_MS)}, so a gap this size is a keeper that is not running rather ` +
        `than a slow network. Until it fetches again, rendering from ${PROMPT_REF} is true and means ` +
        `progressively less.`,
      remedy: `Check the daemon is up and grep its log for 'prompt-source:'; git -C ${repoRoot} fetch origin`
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: `briefs are rendered from ${PROMPT_REF}, fetched ${describeAge(ageMs)} ago`,
    detail:
      `${at}. Templates are read there with \`git show\`, so no working tree is opened and no lock is ` +
      `taken — the checkout's own branch being behind ${PROMPT_REF} does not reach the briefs. ` +
      `PromptSourceKeeper fetches every ${describeAge(FETCH_INTERVAL_MS)}.`
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
  spec: BuildInputs,
  distRel: string,
  remedy: string,
  now: number,
  note?: string
): StalenessItem {
  const base = { id, label, ...(note ? { note } : {}) };
  const rootAbs = path.join(repoRoot, spec.root);
  const distDir = path.join(repoRoot, distRel);

  const classified = classifyEntries(rootAbs, spec);
  const inputSet = describeInputs(spec, classified);

  const src = newestAmong(rootAbs, classified.inputs);
  if (!src) {
    return {
      ...base,
      state: 'unknown',
      headline: `no build inputs found under ${spec.root}`,
      detail:
        `Nothing readable at the declared inputs of ${spec.root} (${inputSet}), so there is no source ` +
        'timestamp to compare a build against.'
    };
  }

  const dist = newestFile(distDir, new Set(['.git']));
  if (!dist) {
    return {
      ...base,
      state: 'stale',
      headline: `${distRel} has never been built`,
      detail:
        `${distDir} is missing or empty, while ${spec.root} has ${src.scanned} input files, the newest being ` +
        `${spec.root}/${src.relPath} (${ageOf(src.mtimeMs, now)} old). Nothing here can be running current ` +
        `code. Judged against ${inputSet}.`,
      remedy
    };
  }

  // A demonstrated gap outranks an incomplete classification: `stale` is a
  // claim backed by two mtimes, and it stays the verdict even when some entry
  // beside the inputs has yet to be classified below.
  const lagMs = src.mtimeMs - dist.mtimeMs;
  if (lagMs > BUILD_SKEW_TOLERANCE_MS) {
    return {
      ...base,
      state: 'stale',
      headline: `${distRel} is older than ${spec.root}'s build inputs`,
      detail:
        `${spec.root}/${src.relPath} was modified ${ageOf(src.mtimeMs, now)} ago, ${describeAge(lagMs)} after ` +
        `the newest file in ${distRel} (${dist.relPath}, ${ageOf(dist.mtimeMs, now)} old). The build does not ` +
        `contain that change. Judged against ${inputSet}.`,
      remedy
    };
  }

  // Nothing is behind anything — but an entry classified neither way means the
  // input set may be incomplete, and an incomplete input set is exactly how a
  // stale build reports fresh. Say so rather than pass it off as freshness.
  if (classified.unclassified.length) {
    const names = classified.unclassified.map((n) => `${spec.root}/${n}`).join(', ');
    return {
      ...base,
      state: 'unknown',
      headline: `${spec.root} holds ${classified.unclassified.length} entr${
        classified.unclassified.length === 1 ? 'y' : 'ies'
      } this check cannot classify`,
      detail:
        `${distRel} is newer than every declared input (${inputSet}), but ${names} ${
          classified.unclassified.length === 1 ? 'is' : 'are'
        } declared neither an input nor a non-input. If the build reads ${
          classified.unclassified.length === 1 ? 'it' : 'them'
        }, this item would report fresh over a ${distRel} that was behind ${
          classified.unclassified.length === 1 ? 'it' : 'them'
        }.`,
      remedy:
        `Classify ${names} in the BuildInputs for '${id}' in daemon/src/staleness.ts — as an input, or as a ` +
        'notInput with the reason it is not one.'
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: `${distRel} is newer than every build input`,
    detail:
      `${distRel} was last written ${ageOf(dist.mtimeMs, now)} ago (${dist.relPath}); the newest of the ` +
      `${src.scanned} input files under ${spec.root} is ${src.relPath}, ${ageOf(src.mtimeMs, now)} old. ` +
      `Judged against ${inputSet}.`
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

/**
 * The per-workspace MCP servers against the build on disk.
 *
 * THE FIFTH GAP, AND THE ONE NO RESTART REACHES (KAN-526). The four checks
 * above cover the checkout, the briefs, `dist/` and the daemon process, and
 * between them they describe a deploy completely — as long as the daemon is the
 * only long-lived process. It is not. Every agent's client spawns its own
 * `mcp.js`, every proxy call that agent makes is served by it, and `git pull`,
 * `npm run build` and `systemctl --user restart butchr-daemon.service` reach
 * none of them.
 *
 * Measured 2026-08-18: with the checkout at the merge commit and the daemon
 * rebuilt and restarted, **not one server on the fleet was post-merge**, and one
 * agent got a live daemon-side fix and an inert `mcp.js`-side defect out of a
 * single call. So this item's absence was not a small hole — it is the half of
 * the deploy that nothing reported at all, while the four green items above
 * described the deploy as complete.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not restart anything and proposes no
 * remedy that would: an `mcp.js` is a stdio child of its agent's client, so
 * reloading one costs that agent its session and whatever it had in flight.
 * KAN-526 scopes the restart policy out and asks for the state to be visible.
 * The remedy therefore names the trade rather than a command.
 *
 * ⚠ WHAT AN EMPTY LIST MEANS, said here because the comfortable reading is
 * wrong. No connected servers is `unknown`, never `fresh`: the daemon has just
 * dropped every registration if it has just restarted, and servers re-register
 * over the following seconds. "Nobody is stale" and "I can see nobody" are the
 * same output from this check unless it says which it is.
 */
function checkMcpServers(
  repoRoot: string,
  servers: ServingProcess[] | undefined,
  now: number
): StalenessItem {
  const base = { id: 'mcp-servers' as const, label: 'agent MCP servers' };
  const distDir = path.join(repoRoot, 'daemon/dist');

  if (!servers) {
    return {
      ...base,
      state: 'unknown',
      headline: 'no view of connected servers from here',
      detail:
        'This staleness report was built without a connection registry, so which MCP servers are ' +
        'running — and which build each loaded — cannot be seen. Only the daemon holds that; ask it ' +
        'with butchr_staleness_check.'
    };
  }

  const newest = newestMtimeMs(distDir);
  if (newest === null) {
    return {
      ...base,
      state: 'unknown',
      headline: 'no build on disk to compare the servers against',
      detail: `${distDir} is missing or empty, so there is no deployed build to judge ${servers.length} connected server(s) against.`
    };
  }

  if (servers.length === 0) {
    return {
      ...base,
      state: 'unknown',
      headline: 'no agent MCP server is connected right now',
      detail:
        `Nothing has announced itself to this daemon, so this is a statement about what can be seen ` +
        `from here and not about the fleet. A daemon restart drops every registration and servers ` +
        `re-register over the next few seconds — ${describeAge(RECONNECT_SETTLE_MS)} covers a jittered ` +
        `backoff — so an empty list moments after a restart is expected. It is never evidence that ` +
        `nothing is stale.`
    };
  }

  const judged = servers.map((server) => ({
    server,
    relation: classifyServerBuild(server.build, distDir, newest, BUILD_SKEW_TOLERANCE_MS)
  }));

  const describe = (
    server: ServingProcess,
    relation: ServerBuildRelation
  ): string => {
    const who = `${server.type}/${server.key}`;
    const pid = server.build ? `pid ${server.build.pid}` : 'pid unknown';
    switch (relation.kind) {
      case 'older':
        return `${who} (${pid}, up since ${server.build?.startedAt}) loaded a build ${describeAge(
          relation.behindMs
        )} older than daemon/dist`;
      case 'unstamped':
        return `${who} (${server.connectionId}) announced no build at all — its mcp.js predates KAN-526, so it cannot be running the current one`;
      case 'other-tree':
        return `${who} (${pid}) was loaded from ${relation.distDir}, a different tree`;
      case 'unreadable':
        return `${who} (${pid}) could not read its own ${relation.distDir} at start`;
      case 'current':
        return `${who} (${pid}) loaded ${relation.loadedBuildAt}`;
    }
  };

  const behind = judged.filter((j) => isBehindDeploy(j.relation));
  const undecidable = judged.filter(
    (j) => j.relation.kind === 'other-tree' || j.relation.kind === 'unreadable'
  );
  const distAge = ageOf(newest, now);

  // The remedy is not a command, and that is the finding rather than an
  // omission: nothing on this machine can reload one of these without taking
  // the agent's session with it.
  const remedy =
    'Nothing here restarts them, deliberately: an mcp.js is a stdio child of its agent\'s client, so ' +
    'it reloads only when that agent is reset or re-activated, which costs that agent its session ' +
    'and any work in flight. Until then, treat live output from these agents as evidence about the ' +
    'build they loaded and not about the deploy.';

  if (behind.length) {
    return {
      ...base,
      state: 'stale',
      headline: `${behind.length} of ${servers.length} agent MCP server${
        servers.length === 1 ? '' : 's'
      } ${behind.length === 1 ? 'is' : 'are'} running a build older than daemon/dist`,
      detail:
        `daemon/dist was last written ${distAge} ago. ` +
        `${behind.map((j) => describe(j.server, j.relation)).join('; ')}. ` +
        `A deploy does not restart these processes, so a merged fix is inert for every agent here ` +
        `until its client is restarted — and a live probe answered by one of them reports the age of ` +
        `that process rather than the state of the deploy (docs/staleness.md).` +
        (undecidable.length
          ? ` Not judged: ${undecidable.map((j) => describe(j.server, j.relation)).join('; ')}.`
          : ''),
      remedy
    };
  }

  if (undecidable.length) {
    return {
      ...base,
      state: 'unknown',
      headline: `${undecidable.length} of ${servers.length} agent MCP server${
        servers.length === 1 ? '' : 's'
      } cannot be judged against daemon/dist`,
      detail:
        `No connected server is demonstrably behind daemon/dist (written ${distAge} ago), but ` +
        `${undecidable.map((j) => describe(j.server, j.relation)).join('; ')} — so this is not a ` +
        `claim that every server is current.`
    };
  }

  return {
    ...base,
    state: 'fresh',
    headline: `all ${servers.length} connected agent MCP server${
      servers.length === 1 ? '' : 's'
    } loaded the build on disk`,
    detail:
      `daemon/dist was last written ${distAge} ago and every connected server loaded it or later: ` +
      `${judged.map((j) => describe(j.server, j.relation)).join('; ')}. ` +
      `This covers the servers that have announced themselves to this daemon; an agent whose client ` +
      `is not running has no server here to be stale.`
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
  // Whether a connection view was offered is part of the key: a caller that has
  // one must not be served a cached report computed by a caller that had none,
  // which would answer "no view of connected servers from here" to the one
  // reader who does have the view.
  const key = `${options.repoRoot}|${options.daemonStartedAt?.getTime() ?? ''}|${
    options.servers ? 'servers' : 'no-servers'
  }`;
  const now = Date.now();
  if (!options.force && cached && cached.key === key && now - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }

  let items: StalenessItem[];
  try {
    items = [
      checkGit(options.repoRoot, now),
      checkPromptSource(options.repoRoot, now),
      checkBuild(
        'daemon-build',
        'daemon build',
        options.repoRoot,
        DAEMON_BUILD_INPUTS,
        'daemon/dist',
        'cd daemon && npm run build && restart the daemon',
        now
      ),
      ...(options.daemonStartedAt
        ? [checkDaemonProcess(options.repoRoot, options.daemonStartedAt, now)]
        : []),
      // Directly after the daemon process, because it is the same question
      // asked of the other long-lived process — and because a reader who has
      // just been told the daemon is current is exactly the reader about to
      // conclude that the deploy landed.
      checkMcpServers(options.repoRoot, options.servers?.(), now),
      checkBuild(
        'extension-build',
        'extension build',
        options.repoRoot,
        EXTENSION_BUILD_INPUTS,
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
