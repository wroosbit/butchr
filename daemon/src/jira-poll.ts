import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
import { HerdrBridge, agentNameFor } from './herdr.js';
import { SupervisorOfRecord } from './agent-registry.js';
import { JiraIssueSnapshot, JiraSnapshotOutcome } from './jira.js';
import { deliverToAgent } from './nudge.js';
import { DAEMON_SENDER_TAG } from './provenance.js';
import { CommentAuthorship } from './comment-authorship.js';

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
  /**
   * Comment events only: *which* ids those were.
   *
   * Carried because the count alone cannot answer the question each recipient
   * has to be asked separately — "is any of this news to *you*?". Suppression
   * is per-recipient (see {@link JiraPoller.notify}), so the event that reaches
   * the fan-out has to hold the ids, not a total.
   */
  newCommentIds?: string[];
}

/** Why a given agent is being told about a given issue. */
export type NudgeRelation = 'own' | 'parent' | 'linked';

/** One nudge the poller decided to send. */
export interface PollNudge {
  /**
   * The events this one interruption carried, as this recipient was told them.
   *
   * An array rather than a single event since KAN-207: one issue's status
   * change and its new comment, recognised in the same tick, reach a recipient
   * as one message. It is a list of what was *announced*, not of what happened
   * — after per-recipient suppression the two are not always the same.
   */
  events: JiraIssueEvent[];
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
  /**
   * Recognised but not sent, with the reason each was dropped.
   *
   * `agentName` is present when the drop was about a specific recipient rather
   * than about the event — self-authored suppression is per-recipient, and
   * "somebody was skipped" is not a fact anyone can check without knowing who.
   */
  skipped: Array<{
    event: JiraIssueEvent;
    relation: NudgeRelation;
    reason: string;
    agentName?: string;
  }>;
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
 *
 * ONE TICKET, ONE SENTENCE (KAN-207)
 *
 * Takes a *list* of events, because a hand-off is a comment and a transition
 * and the poller sees both in the same tick. Two pointers to one ticket are two
 * Ctrl+Cs at one terminal to say "go and read KAN-207" twice, so the clauses are
 * joined — `status changed to In Review and has a new comment` — and the reader
 * is sent to the ticket once. A single event renders exactly as it always did:
 * the join is what changed, not the wording.
 */
export function jiraEventNudgeText(
  events: JiraIssueEvent | JiraIssueEvent[],
  relation: NudgeRelation
): string {
  const list = Array.isArray(events) ? events : [events];
  const key = list[0].key;

  const clause = (event: JiraIssueEvent): string =>
    event.kind === 'status'
      ? `status changed to ${event.to ?? 'an unnamed status'}`
      : (event.newComments ?? 1) > 1
        ? `has ${event.newComments} new comments`
        : 'has a new comment';

  const what = `${list.map(clause).join(' and ')}.`;

  const whose: Record<NudgeRelation, string> = {
    own: 'It is your own ticket.',
    parent: 'You activated its agent.',
    linked: 'It is linked to a ticket of yours.'
  };

  return (
    `${DAEMON_SENDER_TAG} ${key} ${what} ${whose[relation]} ` +
    `Re-read ${key} when you next look; this is a notification, ` +
    `not an instruction, and no reply is expected.`
  );
}

/**
 * The poller's memory of what it has already accounted for.
 *
 * THE SUPPRESSION PROBLEM (KAN-75), AND WHAT CLOSED IT (KAN-187)
 *
 * Every agent reaches Jira through the same shared Atlassian account, so a
 * comment's author says "somebody in this fleet" and never *which* agent. There
 * is therefore no authorship signal *in Jira* to suppress an agent's own
 * actions with. This memory answers a different question — "have I already
 * announced this?" — and an event is remembered the first time it is seen and
 * never produces a second nudge.
 *
 * KAN-75 accepted the limit that leaves: **an agent that comments on its own
 * ticket receives one redundant pointer to its own comment**, bounded to
 * exactly one. What made that cost worth re-opening is what the pointer costs
 * to deliver. A nudge begins with a Ctrl+C at the recipient's terminal, which
 * cancels the tool call it is in the middle of, and that call does not resume.
 * Four agents recorded the same thing on KAN-187: work destroyed to deliver
 * news the recipient wrote itself.
 *
 * So authorship is no longer taken from Jira. {@link CommentAuthorship} reads
 * it out of the authoring agent's own transcript, where the tool result carries
 * the created comment's id — see that module for why that is exact rather than
 * a guess, and for the list of cases it does not cover. It is optional here:
 * without one, this poller behaves exactly as KAN-75 left it, which is what
 * makes the pre-fix behaviour reproducible in a proof.
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
  /**
   * Who wrote which comment, so an agent is not interrupted to be told about
   * its own (KAN-187).
   *
   * Optional, and its absence is the pre-fix behaviour rather than a crash:
   * a poller without one attributes nothing, suppresses nothing, and sends the
   * redundant pointer KAN-75 accepted. That is what lets a proof reproduce the
   * defect and its absence with the same code path.
   */
  authorship?: Pick<CommentAuthorship, 'scan' | 'isOwnComment'>;
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
 *
 * AND EACH OF THEM ONCE PER ISSUE PER TICK (KAN-207)
 *
 * A hand-off is a comment and a transition, so a tick routinely recognises two
 * events on one issue. They reach a recipient as one interruption carrying
 * both facts — see {@link JiraPoller.notify} for why that is not the coalescing
 * KAN-187 declined, and for what it deliberately does not fix.
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

    // Deliberately after the reads and before the first nudge. A comment is
    // written by an agent, then observed by a read, and the transcript line
    // recording it is flushed in between — so scanning last is what makes the
    // ids this tick is about the ids the scan has already seen. Scanning first
    // would race the very writes this tick is reporting.
    if (pending.some(({ event }) => event.kind === 'comment')) {
      try {
        this.opts.authorship?.scan(agents);
      } catch (e: any) {
        // Learning nothing means suppressing nothing, which is the safe side.
        this.opts.log(`[jira-poll] authorship scan failed: ${e?.message ?? String(e)}`);
      }
    }

    // One issue's events are announced together (KAN-207). `recognise` returns
    // a status change and a comment as separate events because they are
    // separate facts, and the memory records them separately — but a recipient
    // does not want two Ctrl+Cs to be pointed at one ticket twice, so the
    // grouping happens here, between recognition and delivery, and touches
    // neither. Insertion order is the read order (`pollable` is sorted) and
    // within an issue it is `recognise`'s order, so the composed sentence is
    // deterministic.
    const byIssue = new Map<string, { snapshot: JiraIssueSnapshot; events: JiraIssueEvent[] }>();
    for (const { event, snapshot } of pending) {
      const key = event.key.toUpperCase();
      const bucket = byIssue.get(key);
      if (bucket) bucket.events.push(event);
      else byIssue.set(key, { snapshot, events: [event] });
    }

    for (const { snapshot, events } of byIssue.values()) {
      await this.notify(events, snapshot, byKey, running, tick);
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
      events.push({ key, kind: 'comment', newComments: fresh.length, newCommentIds: fresh });
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

  /**
   * This event as one recipient should hear it, or null if it is all its own.
   *
   * THE ASYMMETRY THIS ENCODES
   *
   * An id the daemon cannot attribute belongs to nobody, and news that belongs
   * to nobody is delivered. So an unreadable transcript, an agent that is not
   * Claude Code, a human commenting in the web UI, a comment written before the
   * daemon started watching — every one of them lands on "notify", which is the
   * behaviour that existed before any of this. **Suppression requires positive
   * evidence that this recipient wrote the comment; nothing else suppresses.**
   *
   * Status events are returned untouched. There is no authorship in a
   * transition, and the poller already declines to tell an issue's own agent
   * about its own status (see the class docblock).
   */
  private newsFor(event: JiraIssueEvent, agent: LiveAgent): JiraIssueEvent | null {
    const authorship = this.opts.authorship;
    if (!authorship || event.kind !== 'comment') return event;

    const ids = event.newCommentIds;
    // An event with no ids on it predates this field or was built by hand;
    // there is nothing to check it against, so it is news.
    if (!ids?.length) return event;

    const theirs = ids.filter((id) => !authorship.isOwnComment(id, agent.agentName));
    if (!theirs.length) return null;
    if (theirs.length === ids.length) return event;

    // Some of it was this agent's own. It is told about the rest, and the count
    // it is given is the count that is actually news to it — a nudge saying
    // "3 new comments" to an agent that wrote two of them is a pointer with a
    // wrong number on it.
    return { ...event, newComments: theirs.length, newCommentIds: theirs };
  }

  /**
   * One issue's events as one recipient should hear them, in order.
   *
   * Empty means there is nothing left to tell this agent, which is not the same
   * as there being nothing to tell: an agent whose own comment was the only
   * comment, on a ticket whose status also moved, ends up here with the status
   * dropped for the reason below and the comment dropped by {@link newsFor}.
   */
  private eventsFor(
    events: JiraIssueEvent[],
    agent: LiveAgent,
    relation: NudgeRelation,
    tick: PollTick
  ): JiraIssueEvent[] {
    const mine: JiraIssueEvent[] = [];

    for (const event of events) {
      // The asymmetry, decided on KAN-79's ticket: a comment reaches the
      // issue's own agent, a status change does not. It used to be enforced by
      // never making an own agent a *target* of a status event; now that one
      // recipient can be handed a whole issue's events at once, it has to be
      // enforced per event as well, or coalescing would smuggle back exactly
      // the "the ticket you just moved has moved" noise that rule removed.
      // Silent, as it was before: nothing was ever announced to record.
      if (relation === 'own' && event.kind === 'status') continue;

      // The one question that has to be asked of each recipient separately:
      // news is news *to somebody*, and the same three comments can be an echo
      // for one agent and a steer for the next. Answered per target rather than
      // per event for exactly that reason — an agent that wrote one of three
      // comments is still told about the other two.
      const forThisAgent = this.newsFor(event, agent);
      if (!forThisAgent) {
        this.opts.log(
          `[jira-poll] ${event.key} (${event.kind}): not telling ${agent.type}/${agent.key} ` +
          `(${relation}) — it wrote every new comment itself.`
        );
        tick.skipped.push({
          event,
          relation,
          reason: 'every new comment on this issue was written by the recipient',
          agentName: agent.agentName
        });
        continue;
      }

      mine.push(forThisAgent);
    }

    return mine;
  }

  /**
   * Work out who one issue's events concern, and interrupt each of them once.
   *
   * ONE ISSUE, ONE INTERRUPTION PER RECIPIENT (KAN-207)
   *
   * The recipient de-duplication below — `targets`, most specific relation wins
   * — has always been *within* one event. A task agent handing off posts its
   * comment and then transitions, both inside one poll interval, so one tick
   * recognised two events on one issue and delivered them as two
   * `sendToAgent` calls, 1.2 seconds apart, to the same supervisor. Every
   * prompt in `prompts/` forbids agents to do precisely that — *"never send two
   * nudges in a row to the same agent"* — because each send opens with a Ctrl+C
   * that kills the recipient's in-flight tool call and it does not resume.
   *
   * So the de-duplication now spans the tick's events for the issue. Both facts
   * are legitimate news and neither is dropped; they arrive in one sentence.
   *
   * WHY THIS IS NOT THE COALESCING KAN-187 DECLINED
   *
   * KAN-187 refused to "rate-limit or coalesce" because *"it would delay a real
   * steer to reduce the count of a nudge that should not have been sent"*, and
   * that was right about the case it was deciding — a self-echo, whose fix was
   * to not send at all. Neither half of the reason reaches here. There is no
   * delay: both events are already in hand, in this loop, and the message is
   * composed from them without waiting for anything. And nothing is suppressed:
   * a recipient told about one event instead of two is told about *both*, in
   * one interruption, so no steer is delayed or lost. The count that falls is
   * the count of Ctrl+Cs, which was never the news.
   */
  private async notify(
    events: JiraIssueEvent[],
    snapshot: JiraIssueSnapshot,
    byKey: Map<string, LiveAgent[]>,
    running: Set<string>,
    tick: PollTick
  ): Promise<void> {
    const { log, herdrBridge, supervisorFor } = this.opts;
    const deliver = this.opts.deliver ?? deliverToAgent;

    // Every event in the group is one issue's, by construction in `pollOnce`.
    const issueKey = events[0].key;
    const kinds = events.map((e) => e.kind).join('+');

    // Most specific relation wins, so an agent that is both the ticket's own
    // and a linked one is told once, in the terms that actually apply.
    const targets = new Map<string, { agent: LiveAgent; relation: NudgeRelation }>();
    const consider = (agent: LiveAgent, relation: NudgeRelation) => {
      if (!running.has(agent.agentName)) return;
      if (!targets.has(agent.agentName)) targets.set(agent.agentName, { agent, relation });
    };

    const own = byKey.get(issueKey.toUpperCase()) ?? [];

    // An own agent is a candidate only when there is a comment in the group;
    // `eventsFor` then keeps the status event away from it. Both halves are
    // needed: without this one, a pure status change would make the issue's own
    // agent a target and then have nothing to say to it.
    if (events.some((event) => event.kind === 'comment')) {
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
          `[jira-poll] ${issueKey} (${kinds}): supervisor ` +
          `${supervisor.type}/${supervisor.key} is not running; logging and stopping. ` +
          `Its ticket comments and its own polling remain its inbox.`
        );
        // Recorded per event rather than per interruption: `skipped` answers
        // "what was recognised and not delivered", which is a question about
        // events, and collapsing two of them into one row would under-report.
        for (const event of events) {
          tick.skipped.push({
            event,
            relation: 'parent',
            reason: 'supervisor of record is not running'
          });
        }
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
      log(`[jira-poll] ${issueKey} (${kinds}): nobody live to tell.`);
      return;
    }

    for (const { agent, relation } of targets.values()) {
      const forThisAgent = this.eventsFor(events, agent, relation, tick);
      // Every reason it is empty has already been logged and recorded by
      // `eventsFor`; there is nothing left to say and nobody to interrupt.
      if (!forThisAgent.length) continue;

      log(
        `[jira-poll] ${issueKey} (${forThisAgent.map((e) => e.kind).join('+')}): ` +
        `telling ${agent.type}/${agent.key} (${relation}).`
      );
      const outcome = await deliver({
        herdrBridge,
        type: agent.type,
        key: agent.key,
        message: jiraEventNudgeText(forThisAgent, relation),
        log,
        ...(this.opts.confirmTimeoutMs !== undefined
          ? { confirmTimeoutMs: this.opts.confirmTimeoutMs }
          : {}),
        ...(this.opts.confirmPollMs !== undefined ? { pollMs: this.opts.confirmPollMs } : {})
      });
      tick.nudges.push({
        // The events as this recipient was told them, which after suppression
        // is not always what the issue had. A record of what was sent.
        events: forThisAgent,
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
