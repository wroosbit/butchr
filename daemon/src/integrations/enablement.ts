import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from '../ipc.js';

/**
 * Which integrations the user has turned on.
 *
 * WHY A FILE
 *
 * The same reason the agent registry is one: the daemon restarts — on reboot,
 * on upgrade, on a crash — and a toggle the user set has to survive that. This
 * is small, whole-state and rarely written (a human clicking a switch), which
 * is the opposite of the agent registry's profile, so it gets the *other*
 * crash-safe shape the house already uses: atomic replace (write temp → fsync
 * → rename → fsync the directory), exactly as `AgentRegistry.compact` does it.
 * Crashing anywhere in a write leaves the previous state intact, which is a
 * correct answer. No third pattern is invented here.
 *
 * DEFAULT DISABLED, EXCEPT WHERE THAT WOULD STRAND SOMEONE
 *
 * A new integration is off until the user turns it on — nothing should start
 * contributing workspace types and MCP servers to every spawned agent because
 * a release added it. But "default disabled" applied to an *existing* install
 * would be a silent uninstall: this machine has a configured Atlassian
 * credential and a live fleet, and defaulting it off on the next restart would
 * unregister epic/story/task, leave every Jira URL unresolvable, and strand
 * agents nobody could reactivate.
 *
 * So the default is a function of what is already there: an integration whose
 * credential is already configured migrates as **enabled** on the first read
 * that has no record of it, and the decision is written down at that moment
 * rather than re-derived — clearing a credential later must not silently
 * disable an integration the user has been using.
 */

/** Where the state lives. One file, next to the socket and the agent log. */
export const INTEGRATION_STATE_PATH = path.join(BUTCHR_DIR, 'integrations.json');

interface IntegrationStateFile {
  /** Integration id → enabled. Absent id means "never decided". */
  enabled: Record<string, boolean>;
}

export class IntegrationStateStore {
  constructor(private file: string = INTEGRATION_STATE_PATH) {}

  private read(): IntegrationStateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const enabled = parsed?.enabled;
      // Anything that is not an object of booleans is treated as absent: this
      // file is Butchr's own, and a corrupt one must not be able to decide
      // that an integration is on.
      if (!enabled || typeof enabled !== 'object') return { enabled: {} };
      const clean: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(enabled)) {
        if (typeof value === 'boolean') clean[id] = value;
      }
      return { enabled: clean };
    } catch {
      // Missing (the ordinary first-run case) or unreadable.
      return { enabled: {} };
    }
  }

  /** Every recorded decision. Ids with no record are simply absent. */
  public decisions(): Record<string, boolean> {
    return this.read().enabled;
  }

  /** Whether a decision has been recorded for this integration at all. */
  public isDecided(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.read().enabled, id);
  }

  /**
   * The recorded decision, or `fallback` when there is none.
   *
   * The caller supplies the fallback because only it knows the migration rule
   * — see the header: a configured credential means an existing install, which
   * migrates as enabled.
   */
  public isEnabled(id: string, fallback: boolean): boolean {
    const recorded = this.read().enabled[id];
    return typeof recorded === 'boolean' ? recorded : fallback;
  }

  /** Record a decision. Idempotent; returns what was written. */
  public setEnabled(id: string, enabled: boolean): boolean {
    const state = this.read();
    state.enabled[id] = enabled;
    this.write(state);
    return enabled;
  }

  /**
   * Write the decision for an id only if none has been recorded yet — the
   * migration write. Returns true when it wrote.
   */
  public decideIfUndecided(id: string, enabled: boolean): boolean {
    const state = this.read();
    if (Object.prototype.hasOwnProperty.call(state.enabled, id)) return false;
    state.enabled[id] = enabled;
    this.write(state);
    return true;
  }

  /**
   * Atomic replace, the shape AgentRegistry.compact uses: temp → fsync →
   * rename → fsync the directory. A failure here is logged and swallowed
   * rather than thrown: an integration toggle that cannot be persisted must
   * not take down an activation, and the in-memory registry still reflects
   * what the user asked for until the daemon restarts.
   */
  private write(state: IntegrationStateFile): void {
    const temp = `${this.file}.tmp-${process.pid}`;
    let fd: number | undefined;
    let dir: number | undefined;
    try {
      ensureButchrDir();
      fd = fs.openSync(temp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(temp, this.file);

      dir = fs.openSync(path.dirname(this.file), 'r');
      fs.fsyncSync(dir);
    } catch (e: any) {
      console.error(`[Integrations] Could not persist enabled state: ${e?.message ?? String(e)}`);
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
}
