import * as fs from 'fs';
import * as path from 'path';
import { claudeTranscriptDir } from './resume.js';
import { workspaceDirFor } from './herdr.js';
/**
 * ---------------------------------------------------------------------------
 * Which agent wrote which Jira comment.
 * ---------------------------------------------------------------------------
 *
 * THE DEFECT THIS EXISTS FOR (KAN-187)
 *
 * The Jira poller nudges an agent when a ticket it is bound to gains a comment,
 * *including when that agent wrote the comment*. Delivery is a Ctrl+C typed
 * into the recipient's composer, which cancels whatever it was doing — a tool
 * call in flight included, and that does not resume. So the cost of a
 * self-notification is not a wasted turn; it is destroyed work, to deliver a
 * message the recipient already knows, whose own text says no reply is
 * expected. It was filed as the highest-volume source of interrupts on the
 * board, from four separate agents' first-hand observation.
 *
 * WHY THE OBVIOUS SIGNAL IS NOT AVAILABLE — checked, not assumed
 *
 * Every agent reaches Jira through the same Atlassian account. Read live on
 * 2026-08-06, every comment on KAN-183 — written by `task/KAN-183`,
 * `story/KAN-160` and `epic/KAN-39` between them — carries the identical
 * `author.accountId` `712020:619ec5ec-…` and the identical display name. There
 * is exactly one distinct author across the whole issue. So `author` says
 * "somebody in this fleet" and can never say which one, and a filter built on
 * it would suppress a supervisor's steer as readily as an echo.
 *
 * WHY THE DAEMON CANNOT SEE THE WRITE EITHER
 *
 * Agents call the Atlassian MCP server directly: each workspace's `.mcp.json`
 * spawns `npx mcp-remote https://mcp.atlassian.com/v1/mcp` as its own stdio
 * process, and that process talks to Atlassian, not to us. The daemon's own
 * Jira client (jira.ts) is read-only by construction and posts nothing. The
 * daemon writes `.mcp.json` but is not in the request path, so a comment an
 * agent writes is invisible to it at the moment it is written.
 *
 * WHAT IS AVAILABLE, AND WHY IT IS EXACT RATHER THAN A GUESS
 *
 * Claude Code writes every turn to a transcript under
 * `~/.claude/projects/<encoded-cwd>/<session>.jsonl`, and a transcript records
 * both halves of a tool call. The `tool_use` block carries the arguments —
 * including `issueIdOrKey` — and the `tool_result` block carries what Atlassian
 * returned, which for `addCommentToJiraIssue` is the created comment object
 * with **its id**. Verified against a real, untouched transcript:
 *
 *   tool_use   mcp__atlassian__addCommentToJiraIssue {"issueIdOrKey":"KAN-186",…}
 *   tool_result {"self":"…/issue/10195/comment/10818","id":"10818",…}
 *
 * So attribution is not inference from timing, or from text similarity, or from
 * which agent happened to be busy. It is the comment's own primary key, read
 * out of the response the authoring agent received. `10818` was written by
 * `task/KAN-186`, and nothing else in the fleet can claim it.
 *
 * The daemon already knows an agent's working directory, and `resume.ts`
 * already derives Claude Code's transcript directory from it for a different
 * decision. This adds a second reader of the same knowledge rather than a
 * second copy of it.
 *
 * WHY NOT A BUTCHR TOOL THAT WRAPS COMMENTING (the ticket's direction 1)
 *
 * It is the architecturally cleaner answer and it costs more than it is worth
 * here. It needs a new write path in a daemon whose Jira client is read-only on
 * purpose (KAN-20), a new credential scope, and — decisively — a prompt change
 * telling every agent to use it, because a tool nobody is told about is a tool
 * nobody calls. It would then suppress echoes only for the agents that
 * remembered. This reads what agents already do, and covers them whether or not
 * anybody tells them anything.
 *
 * THE OTHER THREE DIRECTIONS KAN-187 OFFERED, AND WHY NOT THEM
 *
 *  - **Suppress by content identity.** The poller holds comment *ids* and never
 *    bodies (see `JiraIssueSnapshot`, which says why), and the daemon has no
 *    record of what any agent wrote to compare a body against. It would mean
 *    widening a deliberately minimal read *and* building the very record of
 *    agent writes that this module builds — at which point the id is already in
 *    hand and matching text would be the weaker key.
 *  - **Never interrupt for a notification that needs no reply.** The most
 *    valuable of the four and not available: KAN-167 established, in both run
 *    modes and against a working control, that this client discards
 *    server-initiated MCP notifications without showing them to the model, and
 *    the current protocol revision deprecates the mechanism outright. There is
 *    no non-preempting path to build on today. Not reopened here.
 *  - **Rate-limit or coalesce.** The poller already coalesces a tick's comments
 *    into one nudge and already never repeats an event. Coalescing further would
 *    delay a supervisor's steer to reduce the count of a nudge that should not
 *    have been sent at all.
 *
 * WHEN THE RECORD IS WRITTEN, since a race here would be silent
 *
 * Claude Code appends each record as it happens rather than at the end of a
 * turn — the `tool_use` is on disk while the tool is still running, and the
 * `tool_result` lands when the call returns. So a comment's id is durable before
 * the agent takes its next action, and the poller's scan (which runs after its
 * Jira reads, deliberately) sees it a whole poll interval later. The window in
 * which a comment is visible to Jira but not yet to this module is milliseconds
 * wide, and lands on "unattributed", which is one redundant nudge.
 *
 * THE DIRECTION IT FAILS IN, WHICH IS THE ONE THAT MATTERS
 *
 * Every unknown here resolves to "notify". An unreadable transcript, an
 * unparseable result, a comment written outside the seed window, an agent that
 * is not Claude Code — all of them leave the id unattributed, and an
 * unattributed comment is nudged about exactly as it is today. **The failure
 * mode of this module is a redundant nudge, never a suppressed steer.** That
 * asymmetry is deliberate: the steer is the channel the poller exists to
 * deliver, and losing one would be a worse defect than the one being fixed.
 *
 * WHAT IT DOES NOT COVER, so nobody infers a coverage that is not here
 *
 *  - A comment created as a side effect of `createIssueLink`'s optional
 *    `comment` argument. The link result does not carry the created comment's
 *    id, so that comment stays unattributed and its author is nudged about it.
 *  - An agent launched with something other than Claude Code, which writes no
 *    such transcript.
 *  - A comment posted by a human in the Jira web UI, which is not an echo at
 *    all and must keep nudging.
 *  - Every other interrupt source: status nudges, supervision notices, and
 *    agent-to-agent `butchr_send_to_agent` sends are untouched by this.
 */
/**
 * The MCP tool name that creates a Jira comment.
 *
 * Matched on the suffix rather than in full: the prefix is the MCP server's
 * alias (`mcp__atlassian__`), which is a name chosen in `.mcp.json` and could
 * differ between workspaces, while the tool's own name comes from the server.
 */
const COMMENT_TOOL_SUFFIX = 'addCommentToJiraIssue';
/**
 * How much of a transcript is read the first time it is seen.
 *
 * A transcript is append-only and grows to megabytes; reading one from the top
 * on every daemon start would be work proportional to a whole conversation to
 * learn about the last minute of it. One megabyte is roughly the last few
 * turns, which is the window that can still matter — an id is only consulted
 * while it is newer than what the poller last saw, and the poller's own state
 * file survives restarts, so the reachable window is the downtime plus one
 * interval.
 *
 * The cost of the bound is stated in the header: a comment written further back
 * than this, by an agent whose daemon then restarted, is unattributed and gets
 * its one redundant pointer. That is the pre-fix behaviour, which is the safe
 * side to land on.
 */
const SEED_TAIL_BYTES = 1024 * 1024;
/** How long an attribution is kept. See {@link CommentAuthorship.prune}. */
const AUTHORSHIP_TTL_MS = 60 * 60 * 1000;
/**
 * A hard ceiling on remembered attributions, independent of the TTL.
 *
 * The TTL bounds the map in time and this bounds it in space; a fleet that
 * comments in a tight loop should not be able to grow the daemon's heap while
 * every entry is still inside its hour.
 */
const MAX_ATTRIBUTIONS = 5_000;
/**
 * The daemon's memory of which agent wrote which comment.
 *
 * Not persisted. The window that matters is bounded by the poller's own state
 * file — an id is only ever consulted while it is newer than the last one the
 * poller recorded — and {@link SEED_TAIL_BYTES} rebuilds the recent past from
 * the transcripts themselves on the first scan after a restart. A second state
 * file to keep in sync would buy a marginal amount of that window back and add
 * a durable thing that can be wrong.
 */
export class CommentAuthorship {
    authors = new Map();
    pending = new Map();
    cursors = new Map();
    transcriptDirFor;
    log;
    now;
    seedTailBytes;
    ttlMs;
    constructor(opts = {}) {
        this.transcriptDirFor =
            opts.transcriptDirFor ??
                ((agent) => claudeTranscriptDir(workspaceDirFor(agent.type, agent.key)));
        this.log = opts.log ?? (() => { });
        this.now = opts.now ?? (() => Date.now());
        this.seedTailBytes = opts.seedTailBytes ?? SEED_TAIL_BYTES;
        this.ttlMs = opts.ttlMs ?? AUTHORSHIP_TTL_MS;
    }
    /**
     * Read whatever each live agent has appended since the last scan.
     *
     * Never throws. This runs inside the poller's tick, where an exception would
     * take the whole sweep down — and the correct behaviour when a transcript
     * cannot be read is to learn nothing and therefore to suppress nothing.
     */
    scan(agents) {
        for (const agent of agents) {
            let dir;
            try {
                dir = this.transcriptDirFor(agent);
            }
            catch {
                continue;
            }
            let names;
            try {
                names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
            }
            catch {
                // No transcript directory: a fresh workspace, or an agent that is not
                // Claude Code. Nothing to learn, nothing to suppress.
                continue;
            }
            for (const name of names) {
                try {
                    this.readAppended(path.join(dir, name), agent);
                }
                catch (e) {
                    this.log(`[authorship] could not read ${path.join(dir, name)}: ${e?.message ?? String(e)}`);
                }
            }
        }
        this.prune();
    }
    /** Which agent wrote this comment, if the daemon saw it being written. */
    authorOf(commentId) {
        return this.authors.get(String(commentId))?.agentName;
    }
    /** Whether this comment is this agent's own. Unknown ids are never anyone's. */
    isOwnComment(commentId, agentName) {
        return this.authorOf(commentId) === agentName;
    }
    /** Every attribution held, for a proof that wants to read the memory back. */
    entries() {
        return [...this.authors.entries()];
    }
    /**
     * Read one transcript from where it was left, and record what it says.
     *
     * A file smaller than the recorded offset has been replaced or truncated
     * rather than appended to, so the cursor is dropped and the tail re-seeded.
     * Reading from a stale offset into a different file would parse the middle of
     * unrelated lines, and every such line fails to parse into an attribution —
     * which is safe, but silently blind.
     */
    readAppended(file, agent) {
        const size = fs.statSync(file).size;
        let cursor = this.cursors.get(file);
        if (!cursor || cursor.offset > size) {
            // First sight, or a replaced file: start from the tail rather than the
            // top. A line straddling the start of the window is dropped by the
            // `carry` handling below, which costs at most one record.
            const from = Math.max(0, size - this.seedTailBytes);
            cursor = { offset: from, carry: '' };
            this.cursors.set(file, cursor);
            if (from > 0) {
                // Everything up to the first newline is the tail of a line whose start
                // was not read; it cannot be parsed and must not be handed to a parser
                // as though it were whole.
                const skipped = this.readRange(file, from, Math.min(size, from + 64 * 1024));
                const firstBreak = skipped.indexOf('\n');
                cursor.offset = firstBreak === -1 ? size : from + Buffer.byteLength(skipped.slice(0, firstBreak + 1));
            }
        }
        if (cursor.offset >= size)
            return;
        const text = cursor.carry + this.readRange(file, cursor.offset, size);
        cursor.offset = size;
        const lines = text.split('\n');
        // A transcript is appended line by line, and a read can land mid-line. The
        // last fragment is kept and prepended to the next read rather than parsed.
        cursor.carry = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim())
                continue;
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            this.absorb(record, agent);
        }
    }
    /** Bytes `[from, to)` of a file, as UTF-8. */
    readRange(file, from, to) {
        const length = Math.max(0, to - from);
        if (!length)
            return '';
        const buffer = Buffer.allocUnsafe(length);
        const fd = fs.openSync(file, 'r');
        try {
            const read = fs.readSync(fd, buffer, 0, length, from);
            return buffer.subarray(0, read).toString('utf8');
        }
        finally {
            fs.closeSync(fd);
        }
    }
    /**
     * Take one transcript record apart.
     *
     * Two block kinds matter and they arrive in separate records: the `tool_use`
     * that asked Atlassian to create the comment, and — in the next message — the
     * `tool_result` carrying what Atlassian returned. The pairing is by
     * `tool_use_id`, which is what makes this a record of a *write*: a read that
     * happens to return comment ids has no matching pending write and is ignored.
     */
    absorb(record, agent) {
        const content = record?.message?.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (!block || typeof block !== 'object')
                continue;
            if (block.type === 'tool_use') {
                if (typeof block.name !== 'string' || !block.name.endsWith(COMMENT_TOOL_SUFFIX))
                    continue;
                const issueKey = block.input?.issueIdOrKey;
                if (typeof block.id !== 'string' || typeof issueKey !== 'string')
                    continue;
                this.pending.set(block.id, {
                    issueKey: issueKey.toUpperCase(),
                    agentName: agent.agentName,
                    at: this.now()
                });
                continue;
            }
            if (block.type !== 'tool_result')
                continue;
            const write = this.pending.get(block.tool_use_id);
            if (!write)
                continue;
            this.pending.delete(block.tool_use_id);
            // A refused write created no comment, so there is nothing to attribute
            // and nothing to suppress.
            if (block.is_error)
                continue;
            const commentId = createdCommentId(block.content);
            if (!commentId) {
                this.log(`[authorship] ${write.agentName} wrote a comment on ${write.issueKey} but its id ` +
                    `could not be read from the result; it will be treated as somebody else's.`);
                continue;
            }
            this.authors.set(commentId, {
                agentName: write.agentName,
                issueKey: write.issueKey,
                at: this.now()
            });
            this.log(`[authorship] ${write.agentName} wrote comment ${commentId} on ${write.issueKey}.`);
        }
    }
    /**
     * Drop what is too old or too plentiful to be worth holding.
     *
     * Insertion order is age order — a `Map` preserves it and every write here is
     * a fresh key — so the oldest entries are the ones at the front.
     */
    prune() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, author] of this.authors) {
            if (author.at < cutoff)
                this.authors.delete(id);
        }
        for (const [id, write] of this.pending) {
            if (write.at < cutoff)
                this.pending.delete(id);
        }
        while (this.authors.size > MAX_ATTRIBUTIONS) {
            const oldest = this.authors.keys().next();
            if (oldest.done)
                break;
            this.authors.delete(oldest.value);
        }
    }
}
/**
 * The id of the comment a `tool_result` says was created, or null.
 *
 * Two readings, because one of them is the primary key and the other is the URL
 * that contains it, and a result that carries either is enough:
 *
 *   {"self":"…/rest/api/3/issue/10195/comment/10818","id":"10818",…}
 *
 * Null is a complete answer and the safe one — see the module header on which
 * direction the unknowns resolve in.
 */
export function createdCommentId(content) {
    const text = resultText(content);
    if (!text)
        return null;
    try {
        const parsed = JSON.parse(text);
        const id = parsed?.id;
        if (typeof id === 'string' && /^\d+$/.test(id))
            return id;
        if (typeof id === 'number' && Number.isFinite(id))
            return String(id);
        const self = typeof parsed?.self === 'string' ? parsed.self : '';
        const fromSelf = self.match(/\/comment\/(\d+)/);
        if (fromSelf)
            return fromSelf[1];
    }
    catch {
        // Not JSON, or JSON wrapped in prose. The URL below is the fallback.
    }
    const fromUrl = text.match(/\/comment\/(\d+)/);
    return fromUrl ? fromUrl[1] : null;
}
/** A tool result's text, whether it arrived as a string or as content blocks. */
function resultText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('\n');
}
