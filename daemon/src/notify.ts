import type { AgentAddress } from './agent-connections.js';
import type { ChannelRefusal, ChannelRouteOutcome } from './channel.js';
import { DAEMON_SENDER_TAG } from './provenance.js';

/**
 * ---------------------------------------------------------------------------
 * How the daemon tells an agent something, now that it does not type at one.
 * ---------------------------------------------------------------------------
 *
 * KAN-301. The human, from outside the system: *"seems like ticket status
 * changes are still going through typing in the pane. We should do the same for
 * all instances where we're inserting into the pane. We need to completely drop
 * the practice."*
 *
 * They were right, and the scope was wider than the case they spotted. Two
 * producers of unsolicited news both went through `deliverToAgent` in nudge.ts,
 * which opens every send with a Ctrl+C (`herdr.ts`, in its own words: *"One
 * cancels the recipient's turn — its in-flight tool call with it — which is the
 * cost of this call"*):
 *
 *   - the Jira poller, on every ticket status change and every new comment;
 *   - the supervision notifier, on `working → blocked` and on a lost agent.
 *
 * KAN-274 had already made `butchr_send_to_agent` prefer the channel and refuse
 * rather than interrupt. It did not touch either of these, and neither was in
 * its scope — so the fleet believed the practice was gone while 1,212 confirmed
 * notifications had been delivered by interrupt since 2026-08-04, 139 of them on
 * the day this was filed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE INTERRUPT ACTUALLY COSTS, WHICH IS NOT THE LOST TURN
 * ---------------------------------------------------------------------------
 *
 * A cancelled tool call renders to the recipient as **a refusal**, and an agent
 * cannot tell a poller's Ctrl+C from the human declining something. `epic/KAN-39`
 * is a first-person account of the consequence, on this ticket: it read poller
 * interrupts as the human stopping it, and *told the human so*. It could not
 * afterwards say which interrupts had been which.
 *
 * So the defect is not the wasted turn. It is that the daemon's own plumbing
 * silently corrupts an agent's model of what its operator asked for, and the
 * corruption is invisible from both ends.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION: WHAT HAPPENS WHEN THE CHANNEL CANNOT CARRY IT
 * ---------------------------------------------------------------------------
 *
 * *"Completely drop the practice"* removes a fallback, and the fallback was the
 * only thing that reached an agent holding no channel registration. The ticket
 * put three options and refused to pick between them, and the pick is the
 * deliverable. **This module is option 1 — hold it and deliver it when the
 * channel comes back — bounded, coalescing, and visible in both directions.**
 *
 * WHY NOT OPTION 2, REFUSE AND SURFACE LOUDLY. Because it drops news that is
 * *recoverable*, and it drops it in the commonest case rather than a rare one.
 * A registration is lost by a daemon restart, a socket error or a client reload,
 * and KAN-274 gave every agent's MCP server a reconnect loop that gets it back
 * **within seconds** — measured on this fleet at the time of writing: eight live
 * agents, every one `transport: "channel"`, including two sitting at
 * `herdrStatus: "done"`. Refusing outright would therefore throw away a
 * notification because of a gap that closes by itself before the next poll. The
 * poller cannot re-report it either: it advances its per-issue baseline whether
 * or not anybody was told, so an event dropped here is not seen again by
 * anybody. Option 2 is honest and it is lossier than what it replaces.
 *
 * WHY NOT OPTION 3, PULL INSTEAD OF PUSH. It is very likely the right end state
 * and it is a different ticket: it changes *when* every agent learns *everything*,
 * and it cannot be introduced as a side effect of changing a carrier. Nothing
 * here forecloses it — a store of undelivered news is the thing a puller would
 * read.
 *
 * WHY NOT THE CHEAPER VERSION OF OPTION 1 — hold the poller's baseline back
 * until delivery succeeds, so the next tick re-reports naturally. It is less
 * code and it is wrong: the baseline is a fact about an *issue* and delivery is a
 * fact about a *recipient*, so one agent that never comes back would make an
 * issue re-report to everybody else, forever. That is a storm with a timer on
 * it. The queue is per recipient for exactly that reason.
 *
 * ---------------------------------------------------------------------------
 * THE CRITERION THIS IS BUILT AGAINST
 * ---------------------------------------------------------------------------
 *
 * From `epic/KAN-39`, who names it as the board's most-repeated failure and asks
 * for it as an acceptance criterion rather than a design note:
 *
 *   > **An agent that did NOT get the news must be distinguishable from one that
 *   > got it and had nothing to do.**
 *
 * Three states, never collapsed, all three readable from outside:
 *
 *   `delivered`     the frame was written to a live channel connection.
 *   `pending`       nothing was written; it is held and will be retried.
 *   `abandoned`     it was held until {@link PENDING_TTL_MS} and never landed.
 *
 * {@link PendingNotifications.report} is what makes them visible, and it keeps
 * `abandoned` after it has given up — a counter that resets to a clean-looking
 * zero is the same silence in a tidier costume.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LOSES, STATED HERE RATHER THAN DISCOVERED LATER
 * ---------------------------------------------------------------------------
 *
 * **C3 — that the text entered the recipient's transcript — is gone, and nothing
 * replaces it.** `deliverToAgent` established it by polling the pane for the
 * message above the composer marker; it succeeded 1,212 times out of 1,234 in
 * this fleet's log. The channel cannot establish C3 **at all** — not "does not
 * yet": a channel frame never touches a pane, and `message-claims.ts` records
 * that pane-scraping is forbidden as a channel health check because KAN-217
 * watched that reader flap while the model received every message.
 *
 * So this trades a measured C3 for an unmeasurable one, and buys C1+C2 without
 * an interrupt. That is a real regression on one axis. What partially covers it
 * is that C3's *purpose* here was to drive a retry, and the retry is now driven
 * by C1 instead — a frame that was never written is known not to have been
 * written, which is the case the retry existed for. What is **not** covered is a
 * frame accepted by a live connection whose client then drops it: that was
 * visible before and is invisible now, it is counted here as `delivered`, and
 * nothing in this module can tell. `channel-liveness.ts`'s probe is the only
 * thing that looks that far, it samples rather than covers, and its own record
 * on this fleet reads `nonAnswersSinceProof: 1`.
 */

/** Why the channel could not carry a notification, or why nothing tried. */
export type NotifyRefusal = ChannelRefusal | 'no-carrier-wired';

/** What one notification attempt did. Superset of nudge.ts's `DeliveryResult`. */
export interface NotifyResult {
  /** True only when a frame was written to a live channel connection. */
  delivered: boolean;
  /** How many sends it took. Kept for `DeliveryResult` compatibility. */
  attempts: number;
  /** Why not, when it did not. */
  error?: string;
  /** The carrier that took it. Never `'composer'` — that is the point. */
  transport: 'channel' | 'undelivered';
  /** Present exactly when {@link delivered} is false. */
  reason?: NotifyRefusal;
  /** Whether it was held for redelivery rather than dropped. */
  pending?: boolean;
}

/**
 * The delivery seam the poller and the supervision notifier are wired with.
 *
 * Structurally a `deliverToAgent`, so the harnesses that inject their own — and
 * deliberately choose the composer in order to read a pane — keep working
 * unchanged. `herdrBridge` is accepted and ignored: a notifier has no use for a
 * pane, and taking the argument is what lets this be a drop-in.
 */
export type NotifyFn = (opts: {
  herdrBridge: unknown;
  type: string;
  key: string;
  message: string;
  log: (...args: any[]) => void;
  confirmTimeoutMs?: number;
  pollMs?: number;
}) => Promise<NotifyResult>;

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

/** One notification that has not been delivered yet. */
interface HeldNotice {
  /** Rendered and ready to send, tag included. */
  message: string;
  /** The first line, for the report and for the redelivery preamble. */
  subject: string;
  firstSeenAt: number;
  reason: NotifyRefusal;
}

/** What one recipient's undelivered news looks like from outside. */
export interface PendingReportRow {
  type: string;
  key: string;
  /** How many notices are held for it right now. */
  count: number;
  /** Age of the oldest held notice, in ms. */
  oldestAgeMs: number;
  /** Why the last attempt did not land. */
  lastReason: NotifyRefusal;
  /** The held notices' first lines, so a reader can see what is waiting. */
  subjects: string[];
}

/** What one recipient's *given up on* news looks like from outside. */
export interface AbandonedReportRow {
  type: string;
  key: string;
  /** How many notices have been abandoned for it, ever. Never reset. */
  count: number;
  /** When the most recent one was abandoned. */
  lastAt: string;
  /** The most recent abandoned notice's first line. */
  lastSubject: string;
  /** Why its last delivery attempt did not land. */
  lastReason: NotifyRefusal;
}

/** The whole undelivered picture, for `butchr_list_agents`. */
export interface PendingReport {
  pending: PendingReportRow[];
  abandoned: AbandonedReportRow[];
  /** Sentence a reader can quote without reconstructing it from the rows. */
  detail: string;
}

function addressKey(address: AgentAddress): string {
  return `${address.type}/${address.key}`.toLowerCase();
}

/** The first line of a message, capped — the same shape nudge.ts fingerprints. */
function subjectOf(message: string): string {
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
  private held = new Map<string, { address: AgentAddress; notices: HeldNotice[] }>();
  private abandoned = new Map<string, AbandonedReportRow>();

  constructor(
    private readonly opts: {
      log: (...args: any[]) => void;
      /** Overridable so a proof does not have to wait fifteen minutes. */
      ttlMs?: number;
      maxPerAgent?: number;
      /** Injected so a proof can drive the clock. Monotonic in production. */
      now?: () => number;
    }
  ) {}

  private get ttlMs(): number {
    return this.opts.ttlMs ?? PENDING_TTL_MS;
  }

  private get maxPerAgent(): number {
    return this.opts.maxPerAgent ?? PENDING_MAX_PER_AGENT;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Hold one notification that the channel would not take. */
  public hold(address: AgentAddress, message: string, reason: NotifyRefusal): void {
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
      const dropped = entry.notices.shift() as HeldNotice;
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
  public flush(route: (address: AgentAddress, content: string) => ChannelRouteOutcome): void {
    const now = this.now();

    for (const [id, entry] of [...this.held]) {
      // Age out first, so a recipient holding nothing but expired notices is
      // not sent a frame full of history.
      const fresh: HeldNotice[] = [];
      for (const notice of entry.notices) {
        if (now - notice.firstSeenAt >= this.ttlMs) {
          this.recordAbandoned(
            entry.address,
            notice,
            `it was held for ${Math.round((now - notice.firstSeenAt) / 1000)}s without the ` +
            `channel coming back, which is past the ${Math.round(this.ttlMs / 1000)}s a pointer ` +
            `to a ticket is worth delivering`
          );
        } else {
          fresh.push(notice);
        }
      }

      if (!fresh.length) {
        this.held.delete(id);
        continue;
      }
      entry.notices = fresh;

      let outcome: ChannelRouteOutcome;
      try {
        outcome = route(entry.address, redeliveryText(fresh, now));
      } catch (e: any) {
        this.opts.log(
          `[notify] ${describe(entry.address)}: redelivery threw ` +
          `(${e?.message ?? String(e)}); ${fresh.length} notice(s) still held.`
        );
        continue;
      }

      if (!outcome.routed) {
        // Recorded on every notice, so the report names the *current* reason
        // rather than the one that applied when the news first arrived.
        for (const notice of entry.notices) notice.reason = outcome.reason;
        continue;
      }

      this.opts.log(
        `[notify] ${describe(entry.address)}: ${fresh.length} held notice(s) delivered over the ` +
        `channel (connection ${outcome.connectionId}) after waiting ` +
        `${Math.round((now - fresh[0].firstSeenAt) / 1000)}s.`
      );
      this.held.delete(id);
    }
  }

  private recordAbandoned(address: AgentAddress, notice: HeldNotice, why: string): void {
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
    this.opts.log(
      `[notify] ABANDONED a notification for ${describe(address)}: ${why}. ` +
      `Reason its channel would not take it: ${notice.reason}. ` +
      `Subject: ${notice.subject} — this agent was NOT told, and its ticket is the only ` +
      `remaining record. ${row.count} abandoned for it in total.`
    );
  }

  /** Everything undelivered, for `butchr_list_agents` and for a proof. */
  public report(): PendingReport {
    const now = this.now();
    const pending: PendingReportRow[] = [...this.held.values()]
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
      detail:
        (pending.length
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
function describe(address: AgentAddress): string {
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
export function redeliveryText(notices: HeldNotice[], now: number): string {
  const oldestSeconds = Math.round((now - notices[0].firstSeenAt) / 1000);

  if (notices.length === 1) {
    return (
      `${DAEMON_SENDER_TAG} DELAYED BY ${oldestSeconds}s — your channel registration was not ` +
      `available when this happened, so it was held rather than typed at your terminal. ` +
      `${stripTag(notices[0].message)}`
    );
  }

  return (
    `${DAEMON_SENDER_TAG} DELAYED — ${notices.length} notifications were held while your ` +
    `channel registration was unavailable, the oldest for ${oldestSeconds}s. They are listed ` +
    `oldest first and some may already be out of date:\n` +
    notices.map((notice) => `  - ${stripTag(notice.message)}`).join('\n')
  );
}

/**
 * The daemon's tag, removed from a held message so the redelivery carries one.
 *
 * Two tags in one message is the shape provenance.ts warns about: the leading
 * tag is the one a reader is taught to trust, so a second one further in is body
 * text that looks like a sender. The preamble above supplies the leading tag.
 */
function stripTag(message: string): string {
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
export function channelNotifier(opts: {
  route: (address: AgentAddress, content: string) => ChannelRouteOutcome;
  pending: PendingNotifications;
}): NotifyFn {
  return async ({ type, key, message, log }) => {
    const address: AgentAddress = { type, key };
    const outcome = opts.route(address, message);

    if (outcome.routed) {
      return { delivered: true, attempts: 1, transport: 'channel' };
    }

    opts.pending.hold(address, message, outcome.reason);
    const error =
      `not delivered over the channel (${outcome.reason}): ${outcome.detail}. ` +
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
export const refuseWithoutCarrier: NotifyFn = async ({ type, key, log }) => {
  const error =
    `no channel carrier is wired into this daemon, so ${type}/${key} was told nothing. ` +
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
