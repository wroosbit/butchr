import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Which build is a running MCP server actually executing?
 *
 * THE DEFECT THIS EXISTS TO END (KAN-526). Every workspace runs its own
 * long-lived `mcp.js`, spawned when that agent's client starts, and **nothing in
 * the deploy path restarts them**. `git pull`, `npm run build` and
 * `systemctl --user restart butchr-daemon.service` reach the checkout, `dist/`
 * and the daemon; they reach no agent's server at all. So a merged, built,
 * correctly-deployed fix does not reach any agent that was already running, and
 * the agent goes on calling the code it loaded at spawn time for as long as it
 * lives.
 *
 * Measured 2026-08-18: with the deploy checkout at `b997884` and the daemon
 * rebuilt and restarted, the live proxy still returned KAN-501's pre-fix
 * strings. Not one server on the fleet was post-merge — the newest had started
 * five minutes before the merge, the oldest two hours before it. `epic/KAN-203`
 * then got both halves out of **one** call: a daemon-side coercion carrying
 * KAN-502's fix, twelve minutes old and live, beside an `mcp.js`-side recovery
 * recipe carrying KAN-501's defect, eighteen minutes old and inert.
 *
 * **The seam runs between the daemon and `mcp.js`, not between agents.** A
 * daemon restart reaches everything the daemon computes and nothing the server
 * process computes, so "is the fix live" has no single answer per commit — it
 * has one per surface, and the daemon-side half going live first makes a deploy
 * *look* successful.
 *
 * ⚠ **So a green live probe is not evidence of a deploy.** It reports the age of
 * whichever process answered it. An agent verifying its own fix through its own
 * proxy is testing the code it started with. `docs/staleness.md` records this
 * for the next reader; this module is what makes the age *askable* rather than
 * something you infer from a pid.
 *
 * It stays deliberately small and dependency-free — no git, no daemon imports —
 * because `mcp.js` loads it in every agent's server process and the daemon reads
 * it too. What it does NOT do is restart anything: whether a deploy should
 * respawn agents trades a stale proxy against destroying work in flight, and
 * KAN-526 asks for the state to be **visible**, not for a restart policy.
 */

/**
 * Slack allowed before one mtime counts as newer than another.
 *
 * Not a fudge factor for clock skew — everything compared with it is on the same
 * filesystem. It absorbs the one legitimate ordering inversion: a file written
 * in the same second the reader read it. Anything larger would hide a real edit.
 *
 * It lives here, in the module with no dependencies, because two comparisons
 * need it and a second copy is how the constants in `docs/doc-constant-drift.md`
 * came apart: `staleness.ts` re-exports this one for its `src` vs `dist` and
 * daemon-process items, and the `mcp-servers` item judges a loaded build with
 * the same number rather than a number of its own.
 */
export const BUILD_SKEW_TOLERANCE_MS = 2_000;

/**
 * What a running MCP server says about the code it loaded.
 *
 * Sent on `hello` (see `mcp.ts`), held on the connection (`agent-connections.ts`)
 * and judged by the `mcp-servers` staleness item.
 */
export interface McpServerBuild {
  /** The server process, so a reader can confirm this on the machine itself. */
  pid: number;
  /** ISO. When this process loaded its modules, off its own clock. */
  startedAt: string;
  /**
   * ISO of the newest file in the `dist` tree this process was loaded from,
   * **read at load time**.
   *
   * This rather than {@link startedAt} is what the verdict is taken on, and the
   * difference matters: a start time is a clock reading and a build stamp is a
   * filesystem mtime, so comparing a start time against a `dist` mtime compares
   * two different instruments. Comparing this against the same tree's mtime
   * *now* compares one instrument with itself.
   *
   * Null when the tree could not be read — reported as such rather than
   * defaulted, because a missing stamp that reads as "current" is the exact
   * failure this module exists to remove.
   */
  loadedBuildAt: string | null;
  /**
   * Absolute path of that tree, so a judge can check it is judging the same one.
   * An agent's server loaded from a different checkout is a different question,
   * not a stale one.
   */
  distDir: string;
}

/**
 * A server's build against the build on disk now.
 *
 * A union rather than a boolean and a couple of loose fields, for the reason
 * `RemoteRelation` in `staleness.ts` is one: every case that needs a *different
 * sentence* is its own kind, and a kind added without a branch in the reporting
 * switch fails to compile rather than falling through to a freshness claim it
 * has not earned. Three of these five are explicitly not-stale-and-not-fresh,
 * and flattening them into `stale: boolean` is how a "no" that means "I could
 * not tell" gets read as "everything is fine".
 */
export type ServerBuildRelation =
  /** Loaded a build no older than the one on disk. */
  | { kind: 'current'; loadedBuildAt: string }
  /** Demonstrably behind: the tree it loaded from has been rebuilt since. */
  | { kind: 'older'; loadedBuildAt: string; behindMs: number }
  /** Loaded from a different tree; its age says nothing about this deploy. */
  | { kind: 'other-tree'; distDir: string }
  /**
   * Announced no build block at all.
   *
   * **Necessarily older, and that is an inference worth stating.** Only an
   * `mcp.js` built from a tree carrying KAN-526 sends the block, so a server
   * that does not send one cannot have loaded a build that has it. This is the
   * ordinary state of every server that was already running when this shipped —
   * which is precisely the population the ticket is about.
   */
  | { kind: 'unstamped' }
  /** It ran, it stamped nothing readable. Say so rather than guess. */
  | { kind: 'unreadable'; distDir: string };

/** One connected server, as the judge needs it. */
export interface ServingProcess {
  type: string;
  key: string;
  /** The daemon's own id for the connection, so two are tellable apart. */
  connectionId: string;
  /** Null when the announcement carried none — see `unstamped` above. */
  build: McpServerBuild | null;
}

/**
 * The newest mtime under `dir`, or null when nothing there is readable.
 *
 * Deliberately not `staleness.ts`'s `newestFile`: this is loaded by every
 * agent's server process, and that module reaches for `child_process` and git.
 * The two answer different questions anyway — that one names the file for a
 * human, this one is a single number to compare.
 */
export function newestMtimeMs(dir: string): number | null {
  let best = -1;

  const walk = (at: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = fs.statSync(abs);
          if (mtimeMs > best) best = mtimeMs;
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };

  walk(dir);
  return best < 0 ? null : best;
}

/**
 * What this process loaded, read from the module's own location.
 *
 * Called once at load, before anything can rebuild the tree underneath it — so
 * the stamp describes the files that were actually read into this process
 * rather than whatever is on disk by the time somebody asks.
 */
export function readOwnBuild(moduleUrl: string, pid = process.pid, now = new Date()): McpServerBuild {
  const distDir = path.dirname(fileURLToPath(moduleUrl));
  const newest = newestMtimeMs(distDir);
  return {
    pid,
    startedAt: now.toISOString(),
    loadedBuildAt: newest === null ? null : new Date(newest).toISOString(),
    distDir
  };
}

/**
 * A build block off the wire, or null when the announcement carries none.
 *
 * Strict for `addressFromAnnouncement`'s reason: this arrives from another
 * process and is a claim, not a measurement this daemon took. A malformed block
 * is `null` — the `unstamped` case, which is judged rather than trusted — and
 * never a partially-filled record that would read as a stamp.
 */
export function buildFromAnnouncement(msg: any): McpServerBuild | null {
  const raw = msg?.build;
  if (!raw || typeof raw !== 'object') return null;
  const pid = typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null;
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
  const distDir = typeof raw.distDir === 'string' && raw.distDir ? raw.distDir : null;
  if (pid === null || !startedAt || !distDir) return null;
  return {
    pid,
    startedAt,
    // The one field allowed to be absent, because the server is allowed to have
    // failed to read its own tree and say so.
    loadedBuildAt: typeof raw.loadedBuildAt === 'string' ? raw.loadedBuildAt : null,
    distDir
  };
}

/**
 * Judge one server's build against a tree's newest mtime.
 *
 * `judgedNewestMs` is passed in rather than read here so that one directory walk
 * serves a whole fleet, and so a test can hold the tree still.
 */
export function classifyServerBuild(
  build: McpServerBuild | null,
  judgedDistDir: string,
  judgedNewestMs: number,
  skewMs: number
): ServerBuildRelation {
  if (!build) return { kind: 'unstamped' };
  if (path.resolve(build.distDir) !== path.resolve(judgedDistDir)) {
    return { kind: 'other-tree', distDir: build.distDir };
  }
  if (!build.loadedBuildAt) return { kind: 'unreadable', distDir: build.distDir };
  const loadedMs = Date.parse(build.loadedBuildAt);
  if (!Number.isFinite(loadedMs)) return { kind: 'unreadable', distDir: build.distDir };
  const behindMs = judgedNewestMs - loadedMs;
  return behindMs > skewMs
    ? { kind: 'older', loadedBuildAt: build.loadedBuildAt, behindMs }
    : { kind: 'current', loadedBuildAt: build.loadedBuildAt };
}

/** Whether a relation is the one that means "this process is behind the deploy". */
export function isBehindDeploy(relation: ServerBuildRelation): boolean {
  return relation.kind === 'older' || relation.kind === 'unstamped';
}
