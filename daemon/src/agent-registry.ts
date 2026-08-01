import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';

/**
 * The durable record of which agents are *supposed* to exist.
 *
 * WHY THIS IS A FILE AND NOT A FIELD
 *
 * Everything else that knows about an agent dies with the machine. The session
 * map dies with the daemon; herdr's panes die with herdr; the extension's view
 * dies with the browser. A power cut takes all three at once, and on KAN-21 it
 * did: two agents that had been working for ninety seconds simply ceased to
 * exist, and nothing anywhere had written down that they ever had. Boot-time
 * restoration needs an answer to "what was running?" that predates the outage,
 * and only the filesystem can hold one.
 *
 * WHY APPEND-ONLY JSONL RATHER THAN A STATE BLOB
 *
 * A power cut gives no shutdown hook, so "save on exit" saves nothing. Every
 * write here therefore happens *at the moment the lifecycle event happens* and
 * is fsync'd before the caller is told the activation succeeded — the ordering
 * that makes "the daemon said yes" and "the disk knows" the same fact.
 *
 * Two crash-safe shapes were available: atomically replace a whole-state file
 * (temp + rename), or append single records. Appending wins here because the
 * unit of change *is* a single record — one activation, one deactivation — so
 * a rewrite of the whole state per event would be work proportional to the
 * fleet for a change of size one. The cost of appending is that the tail can be
 * torn: a machine that loses power mid-`write` leaves a partial final line.
 * That is handled by construction — {@link readLog} drops an unparseable last
 * line and keeps every complete record before it — which is exactly the
 * "format tolerant of a torn tail" the ticket allows. A torn tail can lose at
 * most the one event that was in flight, and never corrupts an earlier one.
 *
 * INTENT, NOT HISTORY
 *
 * The log is a history, but the question asked of it is not "what happened?",
 * it is "what should be running now?". {@link intents} answers that by keeping
 * only the last event per agent: `activated` means restore it, `deactivated`
 * means leave it down. An agent that a human deliberately stood down before the
 * outage must not come back, and that is the whole of the rule that keeps it
 * down.
 */

/** Where the registry lives. One file, next to the socket and the daemon log. */
export const REGISTRY_PATH = path.join(BUTCHR_DIR, 'agents.jsonl');

/**
 * Records past which the log is compacted. High enough that ordinary use never
 * triggers it, low enough that a pathological activate/deactivate loop cannot
 * grow the file without bound.
 */
const COMPACT_AFTER_RECORDS = 500;

export type AgentEvent = 'activated' | 'deactivated';

/**
 * Everything needed to bring an agent back without asking anyone. This is the
 * argument list of an activation, frozen: type, key, where it works, which
 * binary it runs, and which MCP servers it was given.
 */
export interface AgentRecord {
  agentName: string;
  type: string;
  key: string;
  workDir: string;
  /** The page the agent was bound to, when the activation knew one. */
  url?: string;
  /** Which launcher started it — `claude`, `shell`, … . */
  defaultAgent?: string;
  mcpServers?: string[];
}

export interface AgentLogEntry extends AgentRecord {
  event: AgentEvent;
  /** ISO 8601, so a human reading the raw file can date every line. */
  at: string;
}

/** The last thing said about one agent. */
export interface AgentIntent {
  event: AgentEvent;
  record: AgentRecord;
  at: string;
}

function isUsableEntry(value: any): value is AgentLogEntry {
  return (
    value &&
    (value.event === 'activated' || value.event === 'deactivated') &&
    typeof value.agentName === 'string' &&
    value.agentName.length > 0 &&
    typeof value.type === 'string' &&
    typeof value.key === 'string'
  );
}

export class AgentRegistry {
  constructor(private readonly file: string = REGISTRY_PATH) {}

  /**
   * Append one event and make it durable before returning.
   *
   * `fsync` is the point of this function. Without it the record sits in the
   * page cache, where a `write()` that has already returned is still lost to a
   * power cut — which is precisely the failure being defended against, so the
   * cost of the syscall is the feature. `openSync('a')` gives O_APPEND, so
   * concurrent writers (a second daemon losing the socket race, say) interleave
   * whole lines rather than overwriting each other.
   *
   * Never throws. A registry that cannot be written is a degraded restore, not
   * a reason to fail the activation the caller is in the middle of.
   */
  public record(event: AgentEvent, record: AgentRecord): void {
    const entry: AgentLogEntry = { ...record, event, at: new Date().toISOString() };

    let fd: number | undefined;
    try {
      ensureButchrDir();
      fd = fs.openSync(this.file, 'a', 0o600);
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } catch (e: any) {
      console.error(
        `[AgentRegistry] Could not record ${event} for ${record.agentName}: ${e?.message ?? String(e)}`
      );
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    this.compactIfLarge();
  }

  public recordActivated(record: AgentRecord): void {
    this.record('activated', record);
  }

  public recordDeactivated(record: AgentRecord): void {
    this.record('deactivated', record);
  }

  /**
   * Every complete record in the log, oldest first.
   *
   * The torn-tail rule lives here and applies to *any* unparseable line, not
   * only the last one: a line that cannot be read is a line that says nothing,
   * and skipping it is strictly better than refusing to read the file. Only a
   * bad final line is expected (that is what a power cut produces), so anything
   * earlier is logged — it would mean something worse than a crash.
   */
  public readLog(): AgentLogEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      // No file yet is the ordinary state on a fresh install.
      if (e?.code !== 'ENOENT') {
        console.error(`[AgentRegistry] Could not read ${this.file}: ${e?.message ?? String(e)}`);
      }
      return [];
    }

    const lines = text.split('\n');
    const entries: AgentLogEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        // The final line is the one a power cut can tear. Anything earlier is
        // unexpected and worth saying out loud, but is still skipped rather
        // than allowed to discard the records around it.
        if (i < lines.length - 1) {
          console.error(`[AgentRegistry] Skipping unparseable record at line ${i + 1}`);
        }
        continue;
      }

      if (isUsableEntry(parsed)) entries.push(parsed);
    }

    return entries;
  }

  /**
   * The last word on each agent — what the fleet is *meant* to look like.
   * Later records overwrite earlier ones, so this is a reduction of the log to
   * one intent per agent.
   */
  public intents(): Map<string, AgentIntent> {
    const intents = new Map<string, AgentIntent>();
    for (const entry of this.readLog()) {
      const { event, at, ...record } = entry;
      intents.set(entry.agentName, { event, at, record });
    }
    return intents;
  }

  /**
   * The agents that should be running: those whose last event was `activated`.
   * This is the input to boot-time reconciliation and to the missing-agent
   * sweep, and both must read the same list or they would disagree about what
   * "missing" means.
   */
  public expected(): AgentRecord[] {
    return Array.from(this.intents().values())
      .filter((intent) => intent.event === 'activated')
      .map((intent) => intent.record);
  }

  /**
   * Rewrite the log as one `activated` record per expected agent.
   *
   * Atomic, unlike the appends: a whole-file replacement has no torn-tail story
   * available to it, so it gets `write to temp → fsync temp → rename → fsync
   * the directory` instead. The rename is what makes it atomic; the directory
   * fsync is what makes the rename itself durable. Crashing anywhere in here
   * leaves the *old* log intact, which is a correct answer.
   */
  public compact(): void {
    const expected = this.expected();
    const now = new Date().toISOString();
    const body = expected
      .map((record) => JSON.stringify({ ...record, event: 'activated', at: now } as AgentLogEntry))
      .join('\n');

    const temp = `${this.file}.compact-${process.pid}`;
    let fd: number | undefined;
    let dir: number | undefined;
    try {
      ensureButchrDir();
      fd = fs.openSync(temp, 'w', 0o600);
      fs.writeSync(fd, expected.length ? body + '\n' : '');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(temp, this.file);

      dir = fs.openSync(path.dirname(this.file), 'r');
      fs.fsyncSync(dir);
    } catch (e: any) {
      console.error(`[AgentRegistry] Compaction failed: ${e?.message ?? String(e)}`);
      try {
        fs.unlinkSync(temp);
      } catch {}
    } finally {
      for (const handle of [fd, dir]) {
        if (handle !== undefined) {
          try {
            fs.closeSync(handle);
          } catch {}
        }
      }
    }
  }

  private compactIfLarge(): void {
    try {
      if (this.readLog().length > COMPACT_AFTER_RECORDS) this.compact();
    } catch {
      // Compaction is housekeeping; failing it must not fail an activation.
    }
  }
}
