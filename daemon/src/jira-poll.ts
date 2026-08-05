import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
import { HerdrBridge, agentNameFor } from './herdr.js';
import { SupervisorOfRecord } from './agent-registry.js';
import { JiraIssueSnapshot, JiraSnapshotOutcome } from './jira.js';
import { deliverToAgent } from './nudge.js';
import { DAEMON_SENDER_TAG } from './provenance.js';

/**
 * ---------------------------------------------------------------------------
 * Watching Jira, so that news made outside an agent's turn reaches it.
 * ---------------------------------------------------------------------------
 *
 * THE GAP (KAN-75, layer 3)
 *
 * An agent finds out about its own ticket by reading it, which it does at the
 * start of a turn and not again. So a human moving a ticket on the board, or a
 * comment posted while the agent is mid-turn, is discovered only if somebody
 * remembers to nudge — and the comment is the steering API, the one channel a
 * human has for redirecting work already in flight. Every steer typed at a busy
 * agent's ticket was landing in a file nobody was going to open.
 *
 * POLLING, NOT WEBHOOKS
 *
 * Decided by the human on 2026-08-03 and not a shortcut: a webhook is an
 * inbound network surface on a developer laptop, and Butchr's entire posture is
 * outbound-only — a Unix socket whose permissions are the auth boundary, and no
 * listening port at all. A poll costs a request a minute and keeps that true.
 *
 * WHAT IT WATCHES, AND WHAT IT DOES NOT
 *
 * Only issues that have a live agent. An issue whose agent is not running has
 * its ticket as a durable inbox — it will read it when it starts — and polling
 * it would be paying requests to notify nobody.
 *
 * It watches the *Jira issue's* `status` field. It does not read herdr's agent
 * status, and must not: KAN-77 established that herdr's `done` is the agent's
 * own per-turn hook boundary, fires at the end of every turn, and is not
 * evidence of anything, and its verify script asserts that nothing is wired to
 * it. A Jira transition is the opposite kind of signal — rare, deliberate,
 * performed by a human or an agent, and exactly the news a linked ticket needs.
 * The two share a word and nothing else.
 */

/**
 * How long between polls.
 *
 * Sixty seconds, the cost sampler's interval rather than the missing sweep's
 * thirty, and the choice is about the recipient rather than about Jira. Every
 * nudge this module sends begins with a Ctrl+C at somebody's working agent, so
 * the pacing question is "how often may this interrupt the fleet?", not "how
 * fast can we notice?". Jira events are human-paced — a comment written, a
 * ticket dragged across a board — and a minute of latency on one is invisible
 * next to the cost of interrupting an agent twice as often. It is also the
 * latency the acceptance criteria are written against: one poll interval.
 *
 * THE RATE-LIMIT ARITHMETIC, since the ticket asks for it shown
 *
 * One GET per *distinct issue* with a live agent, per tick, issued one after
 * another. KAN-79 states the fleet ceiling as 19 task agents (the cap is
 * derived from the hardware in capacity.ts; 19 is what this machine derives)
 * plus their supervisors — a story per epic and an epic or two, so 25 live
 * agents is a generous bound, and distinct issues is fewer still because two
 * agents on one ticket share one read.
 *
 *   25 issues × 1 GET ÷ 60s = 25 requests/minute ≈ 0.42 requests/second
 *
 * That is one request every 2.4 seconds from one account — less traffic than a
 * human clicking around the Jira web UI generates from the same account, and
 * the daemon makes no other Jira request except an issue-type lookup on a tab
 * change. Atlassian does not publish a fixed per-user ceiling for API-token
 * REST access; it rate-limits dynamically and says so with a 429 when it does.
 * So the estimate is the reason to expect this to be fine, and {@link
 * DEGRADED_POLL_INTERVAL_MS} is what makes being wrong survivable.
 *
 * Sequential rather than parallel is the batching. Twenty-five requests spread
 * across a tick never present Jira with a burst, and a tick that runs long
 * cannot overlap the next one — the poller refuses to start a tick while one is
 * still in flight, and a whole sweep of reads that all time out at
 * POLL_TIMEOUT_MS would trip the back-off anyway.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * The interval a rate-limited or failing Jira gets instead.
 *
 * Five minutes: long enough to be a real concession to a 429, short enough that
 * recovery costs at most one interval of blindness. Degrading to *silence* was
 * the option not taken — a poller that switches itself off after a bad
 * afternoon is a poller nobody can trust to be running, and the same reasoning
 * put a bounded cooldown rather than a kill switch on the issue-type lookup
 * (`FAILURE_COOLDOWN_MS`, jira.ts). Both the degrade and the recovery are
 * logged, so the log always says which pace the poller is running at.
 */
export const DEGRADED_POLL_INTERVAL_MS = 300_000;

/**
 * Where last-seen state lives: beside the agent registry, in `BUTCHR_DIR`.
 *
 * WHOLE-FILE ATOMIC REPLACE, NOT AN APPEND LOG
 *
 * `agents.jsonl` appends because its unit of change is one record — one
 * activation — and rewriting the fleet per event would be work proportional to
 * the fleet for a change of size one. Here the opposite holds: the state *is* a
 * reduction (one row per watched issue, overwritten every tick), the file is
 * one small object, and an append log of every tick would grow without bound
 * while saying nothing a reader wants. So this takes the other crash-safe shape
 * `AgentRegistry.compact()` already uses — write temp, fsync temp, rename,
 * fsync the directory — which has no torn tail to tolerate because a crash
 * anywhere in it leaves the previous file intact. A poller that comes back to
 * *older* state re-reports at most one interval of news; one that came back to
 * a half-written file could not be reasoned about at all.
 */
export const POLL_STATE_PATH = path.join(BUTCHR_DIR, 'jira-poll.json');

/**
 * How long an issue's memory outlives its agent.
 *
 * Entries are not deleted the moment an agent stops: an agent that is stood
 * down at lunch and re-activated after it should not be told, on its first
 * tick back, about every comment its ticket has ever had. Seven days is well
 * past the life of a task agent, and the expiry exists only so a machine that
 * has run for a year is not carrying a row for every ticket it ever touched.
 */
export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What a Jira issue key looks like, so a `shell` workspace is not polled. */
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** One watched issue, as last seen. */
export interface IssueMemory {
  /** The Jira status name last seen, or null if the read carried none. */
  status: string | null;
  /** The highest comment id already accounted for, as a decimal string. */
  maxCommentId: string;
  /** ISO 8601. Only used to expire rows; never compared for events. */
  seenAt: string;
}

/** A running agent, as the poller needs to see one. */
export interface LiveAgent {
  agentName: string;
  type: string;
  key: string;
}

export type JiraEventKind = 'status' | 'comment';

/** Something that happened to an issue since the poller last looked. */
export interface JiraIssueEvent {
  key: string;
  kind: JiraEventKind;
  /** Status events only: what it was, and what it is now. */
  from?: string | null;
  to?: string | null;
  /** Comment events only: how many ids arrived past the last-seen maximum. */
  newComments?: number;
}

/** Why a given agent is being told about a given issue. */
export type NudgeRelation = 'own' | 'parent' | 'linked';

/** One nudge the poller decided to send. */
export interface PollNudge {
  event: JiraIssueEvent;
  relation: NudgeRelation;
  type: string;
  key: string;
  agentName: string;
  delivered: boolean;
  error?: string;
}

/** What one tick did, so the caller can log it and a proof can assert on it. */
export interface PollTick {
  /** The distinct issue keys read this tick. */
  polled: string[];
  events: JiraIssueEvent[];
  nudges: PollNudge[];
  /** Recognised but not sent, with the reason each was dropped. */
  skipped: Array<{ event: JiraIssueEvent; relation: NudgeRelation; reason: string }>;
  /** True when Jira asked to be left alone and the interval was lengthened. */
  degraded: boolean;
}

/**
 * The words a recipient receives.
 *
 * A pointer, never content. The nudge says which ticket changed and how, and
 * sends the reader to the ticket — which is where the words are, where they
 * stay current, and where a reply belongs. Copying a comment into a terminal
 * would put a second, ageing copy of a steer in the one place nobody can edit
 * it, and would make the daemon a courier of text it has no business holding.
 *
 * The subject leads, before any explanation, for the same reason it does in
 * `supervisionNudgeText`: the delivery check matches on the first sixty
 * characters, so two notices about two different tickets must not share their
 * opening or the check cannot tell them apart. It also puts the fact first for
 * the reader, who is being interrupted mid-thought.
 *
 * It informs and instructs nothing. Every sentence a nudge spends telling an
 * agent to *act* is a sentence that can produce another nudge, another ticket
 * comment, or a reply to a daemon that is not listening.
 */
export function jiraEventNudgeText(event: JiraIssueEvent, relation: NudgeRelation): string {
  const what =
    event.kind === 'status'
      ? `status changed to ${event.to ?? 'an unnamed status'}.`
      : (event.newComments ?? 1) > 1
        ? `has ${event.newComments} new comments.`
        : 'has a new comment.';

  const whose: Record<NudgeRelation, string> = {
    own: 'It is your own ticket.',
    parent: 'You activated its agent.',
    linked: 'It is linked to a ticket of yours.'
  };

  return (
    `${DAEMON_SENDER_TAG} ${event.key} ${what} ${whose[relation]} ` +
    `Re-read ${event.key} when you next look; this is a notification, ` +
    `not an instruction, and no reply is expected.`
  );
}

/**
 * The poller's memory of what it has already accounted for.
 *
 * THE SUPPRESSION PROBLEM, AND ITS HONEST LIMIT (KAN-75)
 *
 * Every agent reaches Jira through the same shared Atlassian account, so a
 * comment's author says "somebody in this fleet" and never *which* agent. There
 * is therefore no authorship signal to suppress an agent's own actions with,
 * and pretending otherwise would be inventing a distinction the data cannot
 * support. Suppression is event-based instead: an event is remembered the first
 * time it is seen and never produces a second nudge.
 *
 * The limit that leaves, stated rather than hidden: **an agent that comments on
 * its own ticket receives one redundant pointer to its own comment.** It is
 * bounded to exactly one by this memory, it is a pointer rather than an echo of
 * the text, and it is the accepted cost of having no authorship signal. The
 * alternative — not nudging an issue's own agent on a comment — would drop the
 * steer this whole story exists to deliver.
 */
export class JiraPollState {
  private issues = new Map<string, IssueMemory>();
  private loaded = false;

  constructor(
    private readonly file: string = POLL_STATE_PATH,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Read the file, or start empty.
   *
   * A missing file is the ordinary state on a fresh install. A corrupt one is
   * treated the same way and said out loud: the cost of starting empty is that
   * every watched issue is initialised silently on the next tick, which loses
   * one interval of news and cannot produce a false nudge — strictly better
   * than refusing to poll.
   */
  public load(): void {
    this.loaded = true;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        console.error(`[jira-poll] Could not read ${this.file}: ${e?.message ?? String(e)}`);
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      console.error(
        `[jira-poll] ${this.file} is not readable JSON (${e?.message ?? String(e)}); ` +
        `starting from empty state. Watched issues will be re-initialised without notifying.`
      );
      return;
    }

    for (const [key, value] of Object.entries<any>(parsed?.issues ?? {})) {
      if (!value || typeof value !== 'object') continue;
      this.issues.set(key.toUpperCase(), {
        status: typeof value.status === 'string' ? value.status : null,
        maxCommentId: typeof value.maxCommentId === 'string' ? value.maxCommentId : '0',
        seenAt: typeof value.seenAt === 'string' ? value.seenAt : new Date(this.now()).toISOString()
      });
    }
  }

  public get(key: string): IssueMemory | undefined {
    return this.issues.get(key.toUpperCase());
  }

  public set(key: string, memory: IssueMemory): void {
    this.issues.set(key.toUpperCase(), memory);
  }

  /** Every row, for a proof that wants to read the memory back. */
  public entries(): Array<[string, IssueMemory]> {
    return [...this.issues.entries()];
  }

  /** Whether {@link load} has run. A save before a load would erase the file. */
  public isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Persist, atomically, dropping rows nothing has looked at in a week.
   *
   * Never throws: this runs inside a timer tick, and a state file that cannot
   * be written is a poller that re-initialises after a restart, not a reason to
   * take the daemon's sweep down with it.
   */
  public save(): void {
    const cutoff = this.now() - STATE_TTL_MS;
    for (const [key, memory] of this.issues) {
      const seen = Date.parse(memory.seenAt);
      if (Number.isFinite(seen) && seen < cutoff) this.issues.delete(key);
    }

    const body = JSON.stringify(
      { version: 1, issues: Object.fromEntries(this.issues) },
      null,
      2
    );

    const temp = `${this.file}.tmp-${process.pid}`;
    let fd: number | undefined;
    let dir: number | undefined;
    try {
      ensureButchrDir();
      fd = fs.openSync(temp, 'w', 0o600);
      fs.writeSync(fd, body + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(temp, this.file);

      dir = fs.openSync(path.dirname(this.file), 'r');
      fs.fsyncSync(dir);
    } catch (e: any) {
      console.error(`[jira-poll] Could not persist ${this.file}: ${e?.message ?? String(e)}`);
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

/**
 * Compare two Jira comment ids.
 *
 * Numeric, because Jira's ids are increasing integers and `'10446' < '9999'` is
 * true as strings and false as anything a reader means. The string fallback is
 * for an id that is not a number at all, which no Jira Cloud instance produces
 * and which must still not crash a timer.
 */
export function compareCommentIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** The maximum of a set of comment ids, or `'0'` when there are none. */
function maxCommentId(ids: string[]): string {
  return ids.reduce((best, id) => (compareCommentIds(id, best) > 0 ? id : best), '0');
}

export interface JiraPollerOptions {
  /** The Jira read. Narrowed to one method so a proof can stub it in a line. */
  jira: { pollIssue(key: string): Promise<JiraSnapshotOutcome> };
  herdrBridge: HerdrBridge;
  /**
   * The running fleet, from the same census `sweepForMissingAgents` uses. A
   * function rather than a value because the fleet changes between ticks.
   */
  liveAgents: () => LiveAgent[];
  /** Parentage, read off the durable registry — the supervisor of record. */
  supervisorFor: (agentName: string) => SupervisorOfRecord | null;
  log: (...args: any[]) => void;
  state?: JiraPollState;
  intervalMs?: number;
  degradedIntervalMs?: number;
  /** Swapped out only by a proof, which has no real pane to confirm against. */
  deliver?: typeof deliverToAgent;
  /** Overridable so a proof runs in seconds rather than in minutes. */
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
}

/**
 * The poll loop: read the watched issues, notice what changed, tell the agents
 * it concerns.
 *
 * WHO GETS TOLD, AND THE ONE ASYMMETRY IN IT
 *
 *   - **linked issues' agents** — an issue link is a statement that these two
 *     tickets are each other's business, and a live agent on the other end is
 *     the party that cannot see the change.
 *   - **the parent agent** — the supervisor of record from `activatedBy`, the
 *     agent that staffed this one and is accountable for it.
 *   - **the issue's own agent, for a new comment only.** Comments are the
 *     steering API and an agent that misses a steer mid-turn is the stated gap.
 *     A *status* change does not go to its own agent: its own transitions are
 *     announced to it by the prompts layer (KAN-76), and telling an agent that
 *     the ticket it just moved has moved is noise it caused itself.
 *
 * A supervisor or a linked agent that is not running is not woken. Its ticket
 * is its durable inbox, and starting an agent to receive a notification would
 * be the daemon staffing the fleet on its own initiative.
 */
export class JiraPoller {
  private readonly state: JiraPollState;
  private readonly intervalMs: number;
  private readonly degradedIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private degraded = false;
  private stopped = false;

  constructor(private readonly opts: JiraPollerOptions) {
    this.state = opts.state ?? new JiraPollState();
    this.intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
    this.degradedIntervalMs = opts.degradedIntervalMs ?? DEGRADED_POLL_INTERVAL_MS;
  }

  /** The memory, for a caller that wants to inspect or persist it. */
  public pollState(): JiraPollState {
    return this.state;
  }

  /** Whether the poller is currently running at the degraded interval. */
  public isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Start ticking.
   *
   * The first tick is one interval away rather than immediate. At boot the
   * daemon is busy restoring the fleet and most of it is not back yet, so a
   * tick at t=0 would mostly find nothing to poll; and the state file it would
   * write is the one thing that must not be rushed, since an issue initialised
   * before its agent is up is an issue whose agent is told nothing about the
   * interval it was away.
   */
  public start(): void {
    if (this.timer || this.stopped) return;
    if (!this.state.isLoaded()) this.state.load();
    this.opts.log(
      `[jira-poll] watching live-agent issues every ${this.intervalMs / 1000}s ` +
      `(${this.state.entries().length} issue(s) remembered from a previous run)`
    );
    this.schedule();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    const wait = this.degraded ? this.degradedIntervalMs : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, wait);
    // The daemon's other timers are unref'd for the same reason: a poll must
    // not be the thing keeping a shutting-down process alive.
    this.timer.unref?.();
  }

  /**
   * One tick, guarded against overlapping itself.
   *
   * A tick can outlast its interval — twenty-five reads that all time out
   * would — and two overlapping ticks would double the request rate at the
   * exact moment Jira is least able to take it, as well as racing each other
   * on the state file. Skipping is the right answer: the next tick reads the
   * same issues and finds the same news.
   */
  private async tick(): Promise<void> {
    if (this.ticking) {
      this.opts.log('[jira-poll] previous tick is still running; skipping this one.');
      return;
    }
    this.ticking = true;
    try {
      await this.pollOnce();
    } catch (e: any) {
      this.opts.log(`[jira-poll] tick failed: ${e?.message ?? String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Read every watched issue once, and send what that turns up.
   *
   * Public so the daemon can run a tick by hand and so a proof can drive ticks
   * deterministically instead of waiting on a timer. Never throws.
   */
  public async pollOnce(): Promise<PollTick> {
    const tick: PollTick = { polled: [], events: [], nudges: [], skipped: [], degraded: this.degraded };
    if (!this.state.isLoaded()) this.state.load();

    let agents: LiveAgent[];
    try {
      agents = this.opts.liveAgents();
    } catch (e: any) {
      this.opts.log(`[jira-poll] could not read the fleet: ${e?.message ?? String(e)}`);
      return tick;
    }

    // Two agents on one ticket — a task and a story that share a key — are one
    // read, not two. The multimap is what keeps the request count "per issue"
    // rather than "per agent", which is what the arithmetic above assumes.
    const byKey = new Map<string, LiveAgent[]>();
    const running = new Set<string>();
    for (const agent of agents) {
      if (!agent.type || !agent.key) continue;
      running.add(agent.agentName);
      const key = agent.key.toUpperCase();
      const bucket = byKey.get(key);
      if (bucket) bucket.push(agent);
      else byKey.set(key, [agent]);
    }

    const pollable = [...byKey.keys()].filter((key) => JIRA_KEY.test(key)).sort();
    if (!pollable.length) return tick;

    let sawBackOff = false;
    let sawSuccess = false;
    const pending: Array<{ event: JiraIssueEvent; snapshot: JiraIssueSnapshot }> = [];

    for (const key of pollable) {
      const outcome = await this.opts.jira.pollIssue(key);
      tick.polled.push(key);

      if (!outcome.ok) {
        if (outcome.backOff) sawBackOff = true;
        // A read that failed is a read that saw nothing. It must never be
        // allowed to look like "the status went away" or "the comments were
        // deleted", so the memory is left exactly as it was.
        this.opts.log(
          `[jira-poll] ${key}: read failed` +
          (outcome.status !== undefined ? ` (HTTP ${outcome.status})` : '') +
          `: ${outcome.error}`
        );
        continue;
      }

      sawSuccess = true;
      for (const event of this.recognise(outcome.snapshot)) {
        pending.push({ event, snapshot: outcome.snapshot });
        tick.events.push(event);
      }
    }

    // Persisted before a single nudge is sent, and this order is the storm
    // guard. Recognition is what the memory records, not delivery: an event
    // that could not be delivered is not retried next tick, because retrying is
    // the delivery primitive's job and it has already done it twice. Saving
    // afterwards would mean a daemon killed mid-delivery came back and
    // announced the whole tick again — the "one event, one nudge, ever" rule
    // broken by exactly the crash it is supposed to survive.
    this.state.save();

    this.updatePace(sawBackOff, sawSuccess);
    tick.degraded = this.degraded;

    for (const { event, snapshot } of pending) {
      await this.notify(event, snapshot, byKey, running, tick);
    }

    return tick;
  }

  /**
   * What changed on one issue since the last look — and the restart rule.
   *
   * An issue with no memory is initialised **silently**. That is the whole of
   * the no-replay guarantee for a newly watched ticket: the first sight of
   * `KAN-79` carries eleven comments and a status, none of which is news, and
   * announcing them would make every activation and every fresh install a
   * broadcast of history.
   *
   * A restart is *not* the same case, and conflating them would defeat the
   * point of writing the file. The memory is durable, so after a restart an
   * issue is not newly seen: it is diffed against what was recorded before the
   * daemon went down. Already-notified events are therefore never re-sent —
   * that is the acceptance criterion — while a comment posted during the
   * downtime is genuine news and is delivered, which is what a watcher is for.
   * Discarding state on boot would satisfy the letter of "restarts must not
   * replay history" and make the state file ornamental.
   */
  private recognise(snapshot: JiraIssueSnapshot): JiraIssueEvent[] {
    const key = snapshot.key.toUpperCase();
    const seen = this.state.get(key);
    const seenAt = new Date().toISOString();
    const highest = maxCommentId(snapshot.commentIds);

    if (!seen) {
      this.state.set(key, { status: snapshot.statusName, maxCommentId: highest, seenAt });
      this.opts.log(
        `[jira-poll] ${key}: first sight — recording status \`${snapshot.statusName ?? 'unknown'}\` ` +
        `and ${snapshot.commentIds.length} existing comment(s) without notifying anyone.`
      );
      return [];
    }

    const events: JiraIssueEvent[] = [];

    // A read that carried no status name says nothing about the status; it is
    // not a transition to "no status".
    if (snapshot.statusName !== null && snapshot.statusName !== seen.status) {
      events.push({ key, kind: 'status', from: seen.status, to: snapshot.statusName });
    }

    const fresh = snapshot.commentIds.filter(
      (id) => compareCommentIds(id, seen.maxCommentId) > 0
    );
    if (fresh.length) {
      // One nudge for the tick, not one per comment. Three comments written in
      // a minute are one thing to go and read, and three interruptions of the
      // same agent would be the storm this module is most able to cause.
      events.push({ key, kind: 'comment', newComments: fresh.length });
    }

    this.state.set(key, {
      status: snapshot.statusName ?? seen.status,
      maxCommentId: compareCommentIds(highest, seen.maxCommentId) > 0 ? highest : seen.maxCommentId,
      seenAt
    });

    return events;
  }

  /** Lengthen or restore the interval, saying so either way. */
  private updatePace(sawBackOff: boolean, sawSuccess: boolean): void {
    if (sawBackOff) {
      if (!this.degraded) {
        this.degraded = true;
        this.opts.log(
          `[jira-poll] Jira asked to be left alone (429/5xx or an unreachable host); ` +
          `slowing from ${this.intervalMs / 1000}s to ${this.degradedIntervalMs / 1000}s between polls. ` +
          `Still polling — degrading to silence is not an option here.`
        );
      }
      return;
    }
    if (this.degraded && sawSuccess) {
      this.degraded = false;
      this.opts.log(
        `[jira-poll] Jira is answering again; back to ${this.intervalMs / 1000}s between polls.`
      );
    }
  }

  /** Work out who this event concerns, and tell each of them once. */
  private async notify(
    event: JiraIssueEvent,
    snapshot: JiraIssueSnapshot,
    byKey: Map<string, LiveAgent[]>,
    running: Set<string>,
    tick: PollTick
  ): Promise<void> {
    const { log, herdrBridge, supervisorFor } = this.opts;
    const deliver = this.opts.deliver ?? deliverToAgent;

    // Most specific relation wins, so an agent that is both the ticket's own
    // and a linked one is told once, in the terms that actually apply.
    const targets = new Map<string, { agent: LiveAgent; relation: NudgeRelation }>();
    const consider = (agent: LiveAgent, relation: NudgeRelation) => {
      if (!running.has(agent.agentName)) return;
      if (!targets.has(agent.agentName)) targets.set(agent.agentName, { agent, relation });
    };

    const own = byKey.get(event.key.toUpperCase()) ?? [];

    // The asymmetry, decided on the ticket: a comment reaches the issue's own
    // agent, a status change does not.
    if (event.kind === 'comment') {
      for (const agent of own) consider(agent, 'own');
    }

    // The parent of *this issue's* agent — the supervisor that staffed it.
    for (const agent of own) {
      const supervisor = supervisorFor(agent.agentName);
      if (!supervisor) continue;
      const supervisorName = agentNameFor(supervisor.type, supervisor.key);
      if (supervisorName === agent.agentName) continue; // Guarded at write time too.
      if (!running.has(supervisorName)) {
        log(
          `[jira-poll] ${event.key} (${event.kind}): supervisor ` +
          `${supervisor.type}/${supervisor.key} is not running; logging and stopping. ` +
          `Its ticket comments and its own polling remain its inbox.`
        );
        tick.skipped.push({
          event,
          relation: 'parent',
          reason: 'supervisor of record is not running'
        });
        continue;
      }
      consider(
        { agentName: supervisorName, type: supervisor.type, key: supervisor.key },
        'parent'
      );
    }

    for (const linkedKey of snapshot.linkedKeys) {
      for (const agent of byKey.get(linkedKey.toUpperCase()) ?? []) {
        consider(agent, 'linked');
      }
    }

    if (!targets.size) {
      log(`[jira-poll] ${event.key} (${event.kind}): nobody live to tell.`);
      return;
    }

    for (const { agent, relation } of targets.values()) {
      log(
        `[jira-poll] ${event.key} (${event.kind}): telling ${agent.type}/${agent.key} (${relation}).`
      );
      const outcome = await deliver({
        herdrBridge,
        type: agent.type,
        key: agent.key,
        message: jiraEventNudgeText(event, relation),
        log,
        ...(this.opts.confirmTimeoutMs !== undefined
          ? { confirmTimeoutMs: this.opts.confirmTimeoutMs }
          : {}),
        ...(this.opts.confirmPollMs !== undefined ? { pollMs: this.opts.confirmPollMs } : {})
      });
      tick.nudges.push({
        event,
        relation,
        type: agent.type,
        key: agent.key,
        agentName: agent.agentName,
        delivered: outcome.delivered,
        ...(outcome.error ? { error: outcome.error } : {})
      });
    }
  }
}
