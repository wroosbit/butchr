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
/**
 * A supervisor of record read off untrusted input, or `null` when there isn't
 * one. Both halves must be present and non-empty: half an address is not an
 * address, and a `{ type: 'story', key: '' }` recorded as parentage would
 * point every consumer at an agent that cannot exist.
 */
export function toSupervisorOfRecord(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const type = typeof candidate.type === 'string' ? candidate.type.trim() : '';
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
    return type && key ? { type, key } : null;
}
/** Whether two supervisors of record name the same agent. */
export function sameSupervisorOfRecord(a, b) {
    if (!a || !b)
        return !a && !b;
    return a.type === b.type && a.key === b.key;
}
function isUsableEntry(value) {
    return (value &&
        (value.event === 'activated' || value.event === 'deactivated') &&
        typeof value.agentName === 'string' &&
        value.agentName.length > 0 &&
        typeof value.type === 'string' &&
        typeof value.key === 'string');
}
export class AgentRegistry {
    file;
    constructor(file = REGISTRY_PATH) {
        this.file = file;
    }
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
    record(event, record, preemption) {
        const entry = {
            ...record,
            // Normalised rather than trusted, so the promise the field makes —
            // always present, `null` when there is nothing to report — holds for
            // every line in the file regardless of what a caller passed.
            activatedBy: toSupervisorOfRecord(record.activatedBy),
            event,
            at: new Date().toISOString(),
            ...(preemption ? { preemption } : {})
        };
        let fd;
        try {
            ensureButchrDir();
            fd = fs.openSync(this.file, 'a', 0o600);
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
        }
        catch (e) {
            console.error(`[AgentRegistry] Could not record ${event} for ${record.agentName}: ${e?.message ?? String(e)}`);
            return;
        }
        finally {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                }
                catch { }
            }
        }
        this.compactIfLarge();
    }
    recordActivated(record) {
        this.record('activated', record);
    }
    recordDeactivated(record, preemption) {
        this.record('deactivated', record, preemption);
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
    readLog() {
        let text;
        try {
            text = fs.readFileSync(this.file, 'utf8');
        }
        catch (e) {
            // No file yet is the ordinary state on a fresh install.
            if (e?.code !== 'ENOENT') {
                console.error(`[AgentRegistry] Could not read ${this.file}: ${e?.message ?? String(e)}`);
            }
            return [];
        }
        const lines = text.split('\n');
        const entries = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                // The final line is the one a power cut can tear. Anything earlier is
                // unexpected and worth saying out loud, but is still skipped rather
                // than allowed to discard the records around it.
                if (i < lines.length - 1) {
                    console.error(`[AgentRegistry] Skipping unparseable record at line ${i + 1}`);
                }
                continue;
            }
            // Every record leaves this function with an `activatedBy` — `null` when
            // it has none, and `null` when it comes from a daemon that predates the
            // field. Normalising here rather than at each reader is what lets the
            // consumers treat "no parent" as one answer instead of two.
            if (isUsableEntry(parsed)) {
                entries.push({ ...parsed, activatedBy: toSupervisorOfRecord(parsed.activatedBy) });
            }
        }
        return entries;
    }
    /**
     * The last word on each agent — what the fleet is *meant* to look like.
     * Later records overwrite earlier ones, so this is a reduction of the log to
     * one intent per agent.
     */
    intents() {
        const intents = new Map();
        for (const entry of this.readLog()) {
            // `preemption` is pulled out rather than left in the rest: `record` is
            // the argument list of an activation, and a later activate must not carry
            // the reason a previous stand-down happened.
            const { event, at, preemption, ...record } = entry;
            intents.set(entry.agentName, { event, at, record, ...(preemption ? { preemption } : {}) });
        }
        return intents;
    }
    /**
     * Agents that were stood down to make room and have not been brought back.
     *
     * Derived from {@link intents}, so it empties itself: the moment a preempted
     * agent is re-activated its last event is `activated` again and it leaves this
     * list. That is what makes it safe to report on every `list_agents` poll — it
     * is a queue of decisions still owed, not a log of things that happened.
     *
     * It does not survive compaction, which rewrites the log as one `activated`
     * record per expected agent. That is deliberate rather than overlooked: this
     * is a live signal about work waiting to be re-staffed, and compaction only
     * happens after 500 records, by which time a preemption nobody acted on is
     * not news.
     */
    preempted() {
        const out = [];
        for (const [agentName, intent] of this.intents()) {
            if (intent.event !== 'deactivated' || !intent.preemption)
                continue;
            out.push({ agentName, record: intent.record, at: intent.at, preemption: intent.preemption });
        }
        return out;
    }
    /**
     * Whether this agent's last stand-down was a preemption — i.e. whether
     * re-activating it is resuming interrupted work rather than starting it.
     *
     * This is what turns a re-activation into a resume, so a preempted agent
     * comes back with KAN-21's interrupted-work framing instead of sitting at a
     * restored-but-silent prompt.
     */
    preemptionFor(agentName) {
        const intent = this.intents().get(agentName);
        return intent?.event === 'deactivated' ? intent.preemption : undefined;
    }
    /**
     * The agents that should be running: those whose last event was `activated`.
     * This is the input to boot-time reconciliation and to the missing-agent
     * sweep, and both must read the same list or they would disagree about what
     * "missing" means.
     */
    expected() {
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
    compact() {
        const expected = this.expected();
        const now = new Date().toISOString();
        const body = expected
            .map((record) => JSON.stringify({ ...record, event: 'activated', at: now }))
            .join('\n');
        const temp = `${this.file}.compact-${process.pid}`;
        let fd;
        let dir;
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
        }
        catch (e) {
            console.error(`[AgentRegistry] Compaction failed: ${e?.message ?? String(e)}`);
            try {
                fs.unlinkSync(temp);
            }
            catch { }
        }
        finally {
            for (const handle of [fd, dir]) {
                if (handle !== undefined) {
                    try {
                        fs.closeSync(handle);
                    }
                    catch { }
                }
            }
        }
    }
    compactIfLarge() {
        try {
            if (this.readLog().length > COMPACT_AFTER_RECORDS)
                this.compact();
        }
        catch {
            // Compaction is housekeeping; failing it must not fail an activation.
        }
    }
}
