import { DAEMON_SENDER_TAG } from './provenance.js';
/** How long a held notification is worth delivering. See below for the number. */
export const PENDING_TTL_MS = 15 * 60_000;
/**
 * How many notices are held for one recipient before the oldest is abandoned.
 *
 * Bounded because the queue's whole job is to survive a gap, and a gap that is
 * not closing is the case where an unbounded queue turns one unreachable agent
 * into a memory leak with a delivery attempt attached. Twenty is far above the
 * observed burst — the busiest hour in this fleet's log delivered 402 notices
 * across the whole fleet in a day — and low enough that the overflow sentence
 * below stays readable.
 */
export const PENDING_MAX_PER_AGENT = 20;
function addressKey(address) {
    return `${address.type}/${address.key}`.toLowerCase();
}
/** The first line of a message, capped — the same shape nudge.ts fingerprints. */
function subjectOf(message) {
    return message.replace(/\s+/g, ' ').trim().slice(0, 120);
}
/**
 * The held news, and the rules for holding it.
 *
 * Deliberately in memory and deliberately not persisted. A daemon restart drops
 * every channel registration *and* re-baselines the poller, so a queue that
 * survived one would come back holding notices about a world it can no longer
 * describe — and would deliver them into agents that had just been told nothing
 * changed. Losing the queue with the daemon is the honest behaviour, and
 * {@link report} is what stops it being a silent loss: the abandoned counter is
 * written before the process can forget.
 */
export class PendingNotifications {
    opts;
    held = new Map();
    abandoned = new Map();
    constructor(opts) {
        this.opts = opts;
    }
    get ttlMs() {
        return this.opts.ttlMs ?? PENDING_TTL_MS;
    }
    get maxPerAgent() {
        return this.opts.maxPerAgent ?? PENDING_MAX_PER_AGENT;
    }
    now() {
        return this.opts.now?.() ?? Date.now();
    }
    /** Hold one notification that the channel would not take. */
    hold(address, message, reason) {
        const id = addressKey(address);
        const entry = this.held.get(id) ?? { address, notices: [] };
        entry.notices.push({
            message,
            subject: subjectOf(message),
            firstSeenAt: this.now(),
            reason
        });
        // Oldest first, because the newest notice is the one most likely still to
        // be worth acting on. An overflow is abandonment and is recorded as such
        // rather than being a silent shift off the front of an array.
        while (entry.notices.length > this.maxPerAgent) {
            const dropped = entry.notices.shift();
            this.recordAbandoned(address, dropped, 'the queue for this agent overflowed');
        }
        this.held.set(id, entry);
    }
    /**
     * Try to deliver everything held, and abandon whatever has aged out.
     *
     * One channel attempt per recipient per call, carrying every notice held for
     * it in a single frame. Not one attempt per notice: a recipient whose channel
     * is back should learn everything it missed at one turn boundary, and a
     * recipient whose channel is still down should cost one refused lookup rather
     * than twenty.
     *
     * Never throws — the daemon's sweep timer is the only caller and an exception
     * here would take out the missing-agent sweep it shares a tick with.
     */
    flush(route) {
        const now = this.now();
        for (const [id, entry] of [...this.held]) {
            // Age out first, so a recipient holding nothing but expired notices is
            // not sent a frame full of history.
            const fresh = [];
            for (const notice of entry.notices) {
                if (now - notice.firstSeenAt >= this.ttlMs) {
                    this.recordAbandoned(entry.address, notice, `it was held for ${Math.round((now - notice.firstSeenAt) / 1000)}s without the ` +
                        `channel coming back, which is past the ${Math.round(this.ttlMs / 1000)}s a pointer ` +
                        `to a ticket is worth delivering`);
                }
                else {
                    fresh.push(notice);
                }
            }
            if (!fresh.length) {
                this.held.delete(id);
                continue;
            }
            entry.notices = fresh;
            let outcome;
            try {
                outcome = route(entry.address, redeliveryText(fresh, now));
            }
            catch (e) {
                this.opts.log(`[notify] ${describe(entry.address)}: redelivery threw ` +
                    `(${e?.message ?? String(e)}); ${fresh.length} notice(s) still held.`);
                continue;
            }
            if (!outcome.routed) {
                // Recorded on every notice, so the report names the *current* reason
                // rather than the one that applied when the news first arrived.
                for (const notice of entry.notices)
                    notice.reason = outcome.reason;
                continue;
            }
            this.opts.log(`[notify] ${describe(entry.address)}: ${fresh.length} held notice(s) delivered over the ` +
                `channel (connection ${outcome.connectionId}) after waiting ` +
                `${Math.round((now - fresh[0].firstSeenAt) / 1000)}s.`);
            this.held.delete(id);
        }
    }
    recordAbandoned(address, notice, why) {
        const id = addressKey(address);
        const row = this.abandoned.get(id) ?? {
            type: address.type,
            key: address.key,
            count: 0,
            lastAt: '',
            lastSubject: '',
            lastReason: notice.reason
        };
        row.count++;
        row.lastAt = new Date().toISOString();
        row.lastSubject = notice.subject;
        row.lastReason = notice.reason;
        this.abandoned.set(id, row);
        // LOUD, and at the level a human reads. This is the branch where Butchr
        // knowingly fails to tell an agent something, and the whole defence of
        // choosing to hold rather than to interrupt is that this line exists and
        // that `report()` outlives it.
        this.opts.log(`[notify] ABANDONED a notification for ${describe(address)}: ${why}. ` +
            `Reason its channel would not take it: ${notice.reason}. ` +
            `Subject: ${notice.subject} — this agent was NOT told, and its ticket is the only ` +
            `remaining record. ${row.count} abandoned for it in total.`);
    }
    /** Everything undelivered, for `butchr_list_agents` and for a proof. */
    report() {
        const now = this.now();
        const pending = [...this.held.values()]
            .filter((entry) => entry.notices.length > 0)
            .map((entry) => ({
            type: entry.address.type,
            key: entry.address.key,
            count: entry.notices.length,
            oldestAgeMs: now - entry.notices[0].firstSeenAt,
            lastReason: entry.notices[entry.notices.length - 1].reason,
            subjects: entry.notices.map((notice) => notice.subject)
        }));
        const abandoned = [...this.abandoned.values()];
        return {
            pending,
            abandoned,
            detail: (pending.length
                ? `${pending.reduce((n, row) => n + row.count, 0)} notification(s) are held for ` +
                    `${pending.length} agent(s) whose channel would not take them; each is retried on ` +
                    `the daemon's sweep and abandoned after ${Math.round(PENDING_TTL_MS / 60_000)} ` +
                    'minutes. '
                : 'No notification is currently held. ') +
                (abandoned.length
                    ? `${abandoned.reduce((n, row) => n + row.count, 0)} have been ABANDONED for ` +
                        `${abandoned.length} agent(s) since this daemon started — those agents were never ` +
                        'told, and their tickets are the only record. This count is never reset.'
                    : 'None has been abandoned since this daemon started.') +
                ' Nothing here was delivered by typing at a pane (KAN-301).'
        };
    }
}
/** `type/key`, for a log line. */
function describe(address) {
    return `${address.type}/${address.key}`;
}
/**
 * What a recipient reads when news reaches it late.
 *
 * The preamble is not decoration. A pointer that says *"KAN-301 has a new
 * comment"* invites the reader to treat it as having just happened, and acting
 * on fifteen-minute-old news as though it were current is its own defect. So the
 * delay is stated, in the message, before the news.
 */
export function redeliveryText(notices, now) {
    const oldestSeconds = Math.round((now - notices[0].firstSeenAt) / 1000);
    if (notices.length === 1) {
        return (`${DAEMON_SENDER_TAG} DELAYED BY ${oldestSeconds}s — your channel registration was not ` +
            `available when this happened, so it was held rather than typed at your terminal. ` +
            `${stripTag(notices[0].message)}`);
    }
    return (`${DAEMON_SENDER_TAG} DELAYED — ${notices.length} notifications were held while your ` +
        `channel registration was unavailable, the oldest for ${oldestSeconds}s. They are listed ` +
        `oldest first and some may already be out of date:\n` +
        notices.map((notice) => `  - ${stripTag(notice.message)}`).join('\n'));
}
/**
 * The daemon's tag, removed from a held message so the redelivery carries one.
 *
 * Two tags in one message is the shape provenance.ts warns about: the leading
 * tag is the one a reader is taught to trust, so a second one further in is body
 * text that looks like a sender. The preamble above supplies the leading tag.
 */
function stripTag(message) {
    return message.startsWith(DAEMON_SENDER_TAG)
        ? message.slice(DAEMON_SENDER_TAG.length).trim()
        : message;
}
/**
 * The channel-only notifier the daemon wires into both notification producers.
 *
 * There is no composer branch in here and there is no argument that would add
 * one. That is the whole of KAN-301: a notification is news about a durable
 * record — a Jira ticket, or a status that `butchr_list_agents` still reports —
 * so the cost of it arriving a minute late is latency, while the cost of it
 * arriving as a Ctrl+C is a fabricated refusal in somebody's transcript. Those
 * are not comparable, and the trade was only ever made by default.
 */
export function channelNotifier(opts) {
    return async ({ type, key, message, log }) => {
        const address = { type, key };
        const outcome = opts.route(address, message);
        if (outcome.routed) {
            return { delivered: true, attempts: 1, transport: 'channel' };
        }
        opts.pending.hold(address, message, outcome.reason);
        const error = `not delivered over the channel (${outcome.reason}): ${outcome.detail}. ` +
            `Held for redelivery; nothing was typed at its terminal.`;
        log(`[notify] ${describe(address)}: ${error}`);
        return {
            delivered: false,
            attempts: 1,
            error,
            transport: 'undelivered',
            reason: outcome.reason,
            pending: true
        };
    };
}
/**
 * The default when no carrier is wired — and it is not the composer.
 *
 * This is the seam's *default*, so it is the thing a future daemon gets by
 * forgetting to wire anything, and that is precisely why it must not be a pane
 * write. Before KAN-301 the same slot defaulted to `deliverToAgent`, and the
 * whole defect was that nobody had to choose the interrupt in order to get it.
 *
 * It refuses and says so. A daemon wired like this tells nobody anything, which
 * is a wiring bug and reads as one.
 */
export const refuseWithoutCarrier = async ({ type, key, log }) => {
    const error = `no channel carrier is wired into this daemon, so ${type}/${key} was told nothing. ` +
        `Notifications are not delivered by typing at a pane (KAN-301); this is a wiring defect ` +
        `rather than a delivery outcome.`;
    log(`[notify] ${type}/${key}: ${error}`);
    return {
        delivered: false,
        attempts: 0,
        error,
        transport: 'undelivered',
        reason: 'no-carrier-wired',
        pending: false
    };
};
