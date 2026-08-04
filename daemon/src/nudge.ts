import { HerdrAgentStatus, HerdrBridge, agentNameFor } from './herdr.js';
import { SupervisorOfRecord } from './agent-registry.js';
import { ResumeCause, resumeNudge } from './resume.js';

/**
 * Telling a restored agent to carry on.
 *
 * This was inside `reconcile.ts` and belongs to more than reconciliation now.
 * KAN-21 established the finding it exists for: an agent whose conversation
 * *was* restored has all of its memory and no turn to take, because Claude Code
 * resumes at an empty prompt and waits indefinitely. On the day that ticket was
 * filed, two agents sat like that until a human retyped their instructions.
 *
 * KAN-37 makes the same thing happen on a path that has nothing to do with
 * booting: a preempted agent, re-activated from the sidepanel, restores its
 * conversation and then sits silent. A preemption whose victim comes back and
 * idles is a work-shredder with extra steps, so both callers go through here
 * and cannot drift apart.
 */

/** How long an agent gets to reach its prompt before a nudge is typed at it. */
const AGENT_READY_TIMEOUT_MS = 120_000;
const AGENT_READY_POLL_MS = 2_000;

/**
 * Evidence that Claude Code has finished starting and is listening.
 *
 * Read off the pane rather than asked of herdr because herdr's `agent_status`
 * reports what its hooks last told it, which on a freshly spawned agent is
 * nothing. These are the two things Claude Code puts on screen once its input
 * box exists — the permission-mode footer and the prompt caret — and a nudge
 * typed before either appears would go to the bash that is still starting it.
 */
const AGENT_READY_MARKERS = ['bypass permissions', 'for shortcuts', '❯'];

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Elapsed time that does not count time the machine spent asleep.
 *
 * These budgets exist to bound *waiting*, and `Date.now()` does not measure
 * waiting — it measures the wall clock, which keeps running through a suspend
 * while nothing here does. This is not hypothetical: on the reboot that proved
 * KAN-21, the laptop suspended 1.5 seconds into restoring the first agent and
 * woke five hours and forty minutes later. The 120-second budget below had
 * expired without a single poll ever being taken after the machine came back,
 * so a restored agent that was very probably sitting at a healthy prompt was
 * written off as "never reached a prompt within 120s" and never nudged — the
 * exact idle-forever failure this exists to prevent — and the second agent
 * waited out the whole suspend behind it.
 *
 * `performance.now()` is CLOCK_MONOTONIC on Linux, which excludes suspended
 * time. So the budget means what it says: 120 seconds of the machine actually
 * being awake, whenever those seconds happen to occur.
 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * Wait until an agent's pane looks like a prompt rather than a launching shell.
 * Returns false on timeout, which is a reason not to type at it rather than a
 * reason to fail the restore — the agent is up either way.
 */
export async function waitForAgentReady(
  herdrBridge: HerdrBridge,
  key: string,
  type: string
): Promise<boolean> {
  const deadline = monotonicNow() + AGENT_READY_TIMEOUT_MS;
  for (;;) {
    const tail = herdrBridge.tailAgent(key, type, 40);
    if (tail.success && typeof tail.text === 'string') {
      const text = tail.text.toLowerCase();
      if (AGENT_READY_MARKERS.some((marker) => text.includes(marker.toLowerCase()))) return true;
    }
    if (monotonicNow() >= deadline) return false;
    await delay(AGENT_READY_POLL_MS);
  }
}

/** What the nudge did, for the log and for the caller's outcome record. */
export interface NudgeResult {
  nudged: boolean;
  error?: string;
}

/**
 * Wait for a restored agent's prompt and tell it, in words, that it was
 * interrupted and what to do about it.
 *
 * Only for agents whose conversation actually came back. The other branch needs
 * no message: its prompt went in on the command line (the degraded-resume
 * framing) and it is already working. Never throws — every caller is either a
 * boot-time sweep or a fire-and-forget from a request handler that has already
 * answered.
 */
export async function nudgeResumedAgent(opts: {
  herdrBridge: HerdrBridge;
  type: string;
  key: string;
  cause: ResumeCause;
  /** Which launcher started it. Only `claude` restores a conversation. */
  defaultAgent?: string;
  log: (...args: any[]) => void;
}): Promise<NudgeResult> {
  const { herdrBridge, type, key, cause, defaultAgent, log } = opts;
  const label = `${type}/${key}`;

  if (defaultAgent !== 'claude') {
    // Anything else came up fresh; there is nothing to nudge it about.
    return { nudged: false };
  }

  try {
    if (!(await waitForAgentReady(herdrBridge, key, type))) {
      log(
        `[nudge] ${label} restored its conversation but never reached a prompt within ` +
        `${AGENT_READY_TIMEOUT_MS / 1000}s; not typing at it. It will sit idle until nudged.`
      );
      return { nudged: false, error: 'agent did not reach a prompt in time' };
    }

    const sent = await herdrBridge.sendToAgent(key, resumeNudge(type, key, cause), type);
    log(
      `[nudge] ${label} restored its conversation; ` +
      (sent.success
        ? 'sent it the interrupted-work message.'
        : `could NOT send the interrupted-work message: ${sent.error}. It will sit idle.`)
    );
    return { nudged: sent.success, ...(sent.success ? {} : { error: sent.error }) };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    log(`[nudge] ${label} could not be nudged: ${error}`);
    return { nudged: false, error };
  }
}

/**
 * ---------------------------------------------------------------------------
 * A send that confirms rather than dispatches.
 * ---------------------------------------------------------------------------
 *
 * `HerdrBridge.sendToAgent` answers whether the keystrokes were *typed*, which
 * is not the same claim as whether the message *landed*. On 2026-08-03 a nudge
 * returned `success: true` and two consecutive tails afterwards showed the text
 * sitting unsubmitted at the target's `❯` composer, with the tool call above it
 * reading `Interrupted`: the Ctrl+C arrived mid-tool-call, the Enter did not
 * take, and the recipient never saw a word of it. The same failure had already
 * cost KAN-61 a nudge in the other direction.
 *
 * So delivery is verified against the pane, and the check is deliberately not a
 * substring test: the unsent composer text *is* in the buffer and a naive
 * `tail.includes(message)` passes on exactly the frame that proves the failure.
 * What separates the two is *where* the text is — see {@link messageLanded}.
 */

/** How long a sent message gets to appear as submitted output before a retry. */
const DELIVERY_CONFIRM_TIMEOUT_MS = 20_000;
const DELIVERY_CONFIRM_POLL_MS = 1_000;
/** Enough tail to hold a long message's echo and the composer beneath it. */
const DELIVERY_TAIL_LINES = 60;

/**
 * Where the live input line begins.
 *
 * Claude Code marks a submitted message and the composer with the *same* caret
 * — the transcript echo reads `❯ your message` and so does the input box — so
 * what separates them is position, not glyph: the composer is the last one on
 * screen, because it is drawn at the bottom. Everything before the final caret
 * has scrolled past as output; everything after it is still being typed.
 */
const COMPOSER_MARKERS = ['❯', '│ >'];

/** Whitespace flattened, so a wrap is not a difference. See messageLanded. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The part of a message worth looking for in a pane.
 *
 * The first line, flattened and capped short: a submitted message is echoed
 * into the transcript beginning with its first line, and a long one is
 * abbreviated after that ("… +3 lines"), so nothing past the first line is
 * reliably on screen to match against. Short because every character of the
 * needle is another chance to straddle something.
 */
export function deliveryFingerprint(message: string): string {
  return flatten(message.split('\n')[0]).slice(0, 60);
}

/**
 * Whether a message reached the agent rather than merely reaching its composer.
 *
 * The test is *where* the text is: present in the pane above the composer means
 * submitted; present only in the composer means typed and never sent, which is
 * the failure this exists to catch and the one a plain `tail.includes(message)`
 * cannot see — the unsent text is in the buffer too.
 *
 * Whitespace is flattened on both sides before comparing, and this is not
 * tidiness. Claude Code hard-wraps the echo to the pane's width and indents the
 * continuation, so on an 80-column pane the message comes back as
 *
 *     ❯ [butchr daemon] task/KAN-90 (butchr-task-kan-90), an agent you
 *       activated, is no longer running — herdr has no agent by that name.
 *
 * A raw substring check against the original one-line message fails on that,
 * reports a delivered message as undelivered, and re-sends it — which is
 * exactly what the first live run of this code did, twice, to an agent that had
 * already answered. Flattening makes the wrap invisible to the comparison.
 *
 * When no composer marker is on screen the pane is not a Claude Code prompt — a
 * bare shell, or output mid-scroll — and presence anywhere is the only evidence
 * available. A deliberate degradation: the alternative is calling every
 * non-Claude pane undeliverable.
 */
export function messageLanded(tail: string, message: string): boolean {
  return landedCount(tail, message) > 0;
}

/**
 * How many times this message appears as submitted output.
 *
 * A count rather than a yes/no because "is it there?" is the wrong question
 * when the same text may have been sent before: a notice about a second agent
 * shares its opening with the notice about the first, and a supervisor's pane
 * legitimately holds both. What proves *this* send landed is that the count
 * went up — so {@link deliverToAgent} takes a reading before it types and waits
 * for a bigger one, which is also what makes a genuine duplicate provable
 * rather than assumed.
 */
export function landedCount(tail: string, message: string): number {
  const needle = deliveryFingerprint(message);
  if (!needle) return 0;

  const composerAt = COMPOSER_MARKERS.reduce(
    (furthest, marker) => Math.max(furthest, tail.lastIndexOf(marker)),
    -1
  );
  const submitted = composerAt === -1 ? tail : tail.slice(0, composerAt);
  return flatten(submitted).split(needle).length - 1;
}

/** What a delivery attempt did, for the log and for the caller's record. */
export interface DeliveryResult {
  /** True only when the message was seen as submitted output. */
  delivered: boolean;
  /** How many sends it took. Two means the first one did not land. */
  attempts: number;
  /** Why not, when it did not. */
  error?: string;
}

/**
 * Send a message to an agent's terminal and confirm it landed, retrying at
 * most once.
 *
 * Exported and free of any caller's specifics on purpose: this is the delivery
 * primitive the status notifier below uses, and KAN-79's Jira poller consumes
 * the same one rather than growing a second copy of the confirm-and-retry rule.
 *
 * Exactly one retry, as the ticket asks. Not zero, because the observed failure
 * is transient — an Enter lost to a tool call that was in flight — and not
 * unbounded, because every send begins with a Ctrl+C at somebody's working
 * agent, and a loop of those is a worse outcome than an undelivered
 * notification. When both attempts fail the caller is told so and the message
 * is dropped: what makes that safe is that nothing here is the only path to the
 * information, and the caller's own polling remains the backstop.
 *
 * Never throws. Every caller is a timer or a fire-and-forget handler.
 */
export async function deliverToAgent(opts: {
  herdrBridge: HerdrBridge;
  type: string;
  key: string;
  message: string;
  log: (...args: any[]) => void;
  /** Overridable so a proof can run in seconds rather than in minutes. */
  confirmTimeoutMs?: number;
  pollMs?: number;
}): Promise<DeliveryResult> {
  const { herdrBridge, type, key, message, log } = opts;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DELIVERY_CONFIRM_POLL_MS;
  const label = `${type}/${key}`;

  let lastError: string | undefined;
  // What the pane already showed before this send. Anything at or below this
  // is somebody else's message, or an earlier copy of this one.
  const before = readLandedCount(herdrBridge, type, key, message);

  for (let attempt = 1; attempt <= 2; attempt++) {
    let sent: { success: boolean; error?: string };
    try {
      sent = await herdrBridge.sendToAgent(key, message, type);
    } catch (e: any) {
      sent = { success: false, error: e?.message ?? String(e) };
    }

    if (!sent.success) {
      lastError = sent.error ?? 'herdr refused the send';
      log(`[deliver] ${label}: send attempt ${attempt} failed: ${lastError}`);
      continue;
    }

    if (await confirmDelivered(herdrBridge, type, key, message, before, confirmTimeoutMs, pollMs)) {
      log(
        `[deliver] ${label}: delivered and confirmed on the pane` +
        (attempt > 1 ? ` after ${attempt} attempts.` : '.')
      );
      return { delivered: true, attempts: attempt };
    }

    lastError =
      `the message was typed but never appeared as submitted output within ` +
      `${confirmTimeoutMs}ms — it is most likely sitting unsent at the composer`;
    log(`[deliver] ${label}: send attempt ${attempt} unconfirmed: ${lastError}`);
  }

  log(
    `[deliver] ${label}: NOT delivered after 2 attempts (${lastError}). ` +
    `Dropping the message rather than typing at it again; the recipient's own polling is the backstop.`
  );
  return { delivered: false, attempts: 2, error: lastError };
}

/** This message's current count in the pane, or 0 if the pane cannot be read. */
function readLandedCount(
  herdrBridge: HerdrBridge,
  type: string,
  key: string,
  message: string
): number {
  const tail = herdrBridge.tailAgent(key, type, DELIVERY_TAIL_LINES);
  return tail.success && typeof tail.text === 'string' ? landedCount(tail.text, message) : 0;
}

/** Poll the pane until one more copy has been submitted than there was, or time out. */
async function confirmDelivered(
  herdrBridge: HerdrBridge,
  type: string,
  key: string,
  message: string,
  before: number,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = monotonicNow() + timeoutMs;
  for (;;) {
    if (readLandedCount(herdrBridge, type, key, message) > before) return true;
    if (monotonicNow() >= deadline) return false;
    await delay(pollMs);
  }
}

/**
 * ---------------------------------------------------------------------------
 * Telling a supervisor that one of its agents changed state without saying so.
 * ---------------------------------------------------------------------------
 *
 * The gap this closes (KAN-75): an agent that dies, or goes blocked, announces
 * nothing — it cannot, because it is not running or not proceeding. The
 * missing-agent sweep already *detected* the loss and broadcast it to whatever
 * clients happened to be connected, but nudged nobody, so the story agent whose
 * task agent died found out whenever its polling loop next looked. With
 * `activatedBy` on the durable record there is now somebody to tell.
 *
 * WHICH TRANSITIONS ARE WORTH A NUDGE — and why `done` is not one
 *
 * herdr's `agent_status` is not this daemon's judgement: `toAgentStatus` in
 * herdr.ts whitelists whatever `herdr agent list` reports, and nothing here
 * computes or corroborates it. It tracks the agent's own hook-reported turn
 * boundaries, which means `done` fires at the end of *every* turn rather than
 * at the end of the work — and it can be wrong even about that: on 2026-08-03
 * `list_agents` reported `task/KAN-72` as `done` while a tail of the same agent
 * at the same moment showed a live diff scrolling under the status line
 * "Merging KAN-71 and re-wiring registry seams…".
 *
 * So `working` → `done` is not evidence that an agent finished, and nudging on
 * it would deliver a false "your agent is finished" several times an hour, per
 * agent, each one interrupting a supervisor's composer — the exact storm this
 * story exists to avoid. Corroborating it across two sweeps was the other
 * option offered and does not help: an agent between turns is still `done` a
 * minute later, so corroboration would confirm the wrong reading rather than
 * filter it.
 *
 * What is left is unambiguous in a way `done` is not:
 *
 *   - **newly missing** — the registry expects it and herdr has no such agent.
 *     A fact about existence, not a self-report, and the one case that can
 *     never be announced by the agent itself.
 *   - **`working` → `blocked`** — herdr reports blocked when the agent has
 *     stopped and is waiting; `prompts/epic.md` already tells supervisors to
 *     investigate it immediately, and it is precisely what they cannot see
 *     between polls.
 *
 * An agent going quietly `idle` or `done` remains visible in `butchr_list_agents`
 * on every poll, which is where a supervisor deciding "is this finished?"
 * should be looking anyway — it has the deliverables to check against, and this
 * notifier does not.
 */

/** A change worth telling somebody about. */
export interface AgentStateChange {
  agentName: string;
  type: string;
  key: string;
  /** The last status this notifier saw, or `unknown` if it never saw one. */
  from: HerdrAgentStatus;
  /** `blocked`, or `missing` for an agent that is no longer there at all. */
  to: HerdrAgentStatus | 'missing';
}

/**
 * The words a supervisor receives.
 *
 * Written to inform and to stop there. Every sentence a nudge spends telling an
 * agent to *do* something is a sentence that can produce another nudge, another
 * ticket comment, or a reply to a daemon that is not listening — so this names
 * what changed, says where to look, and asks for nothing. It is prefixed and
 * self-describing because it arrives in the middle of whatever the recipient
 * was doing, and a bare sentence in a composer is indistinguishable from a
 * human interrupting.
 */
export function supervisionNudgeText(change: AgentStateChange): string {
  const what =
    change.to === 'missing'
      ? `is no longer running — herdr has no agent by that name. ` +
        `Its last known status was \`${change.from}\`.`
      : `went \`${change.from}\` → \`${change.to}\`.`;

  // The subject leads, before any boilerplate. Two notices about two different
  // agents must not share their opening: the delivery check matches on the
  // first sixty characters, and a preamble in front of the name would make
  // every notice look alike to it. It also puts the fact first for the reader.
  return (
    `[butchr daemon] ${change.type}/${change.key} (${change.agentName}), ` +
    `an agent you activated, ${what} ` +
    `This is a notification, not an instruction, and no reply is expected — ` +
    `\`butchr_list_agents\` and \`butchr_tail_agent\` hold the details when you next look.`
  );
}

/** One row of the census the notifier compares against its memory. */
export interface WatchedAgent {
  agentName: string;
  type: string | null;
  key: string;
  herdrStatus: HerdrAgentStatus;
}

/** One agent the registry expects that the census cannot show. */
export interface LostAgent {
  agentName: string;
  type: string;
  key: string;
}

/** What one sweep did, so the caller can log or assert on it. */
export interface SupervisionSweepResult {
  changes: AgentStateChange[];
  /** Changes whose supervisor of record was named, running, and told. */
  delivered: number;
  /** Changes recognised but not delivered, with the reason each was dropped. */
  skipped: Array<{ change: AgentStateChange; reason: string }>;
}

/**
 * The status watcher's memory and its rules.
 *
 * Owned by the daemon's periodic sweep, which is where the census already comes
 * from; a class rather than a closure so its transition memory is inspectable
 * and a proof can drive two sweeps in a row against it.
 *
 * THE STORM GUARDS, all four in one place:
 *
 *   1. One event, one nudge. A recognised change is remembered by
 *      `<agentName>:<to>` and never re-sent while it still holds — the same
 *      shape as `announcedMissing` in daemon.ts, and for the same reason: an
 *      agent that has been blocked for an hour is not news twice a minute. The
 *      memory is cleared when the condition clears, so an agent that goes
 *      blocked, is unblocked, and blocks again is two events, not one.
 *   2. Nobody hears about themselves. Guaranteed at the point of writing
 *      (`supervisorOfRecord` in router.ts refuses a self-referential parent) and
 *      checked again here, because a record written by an older daemon is not
 *      covered by a guard added later.
 *   3. A supervisor that is not running is not woken. Its ticket comments and
 *      its own polling are its durable inbox; a message typed at a pane nobody
 *      is attached to is not delivery, and starting it to receive one would be
 *      the daemon staffing agents on its own initiative.
 *   4. Recognition, not delivery, is what the memory records. A change that
 *      could not be delivered is not retried on the next sweep: retrying is the
 *      delivery primitive's job and it has already done it twice.
 */
export class SupervisionNotifier {
  private lastStatus = new Map<string, HerdrAgentStatus>();
  private announced = new Set<string>();

  constructor(
    private readonly opts: {
      herdrBridge: HerdrBridge;
      /** How the notifier resolves an agent's parent — the durable registry. */
      supervisorFor: (agentName: string) => SupervisorOfRecord | null;
      /**
       * The key as the registry spells it. Optional: without it a notice names
       * the key the census had, which for a sessionless agent is lower-cased
       * off its agent name rather than spelled the way its ticket is.
       */
      recordedKeyFor?: (agentName: string) => string | undefined;
      log: (...args: any[]) => void;
      /** Swapped out only by the proof, which has no pane to confirm against. */
      deliver?: typeof deliverToAgent;
    }
  ) {}

  /** What the notifier currently believes each agent is doing. For proofs. */
  public knownStatus(agentName: string): HerdrAgentStatus | undefined {
    return this.lastStatus.get(agentName);
  }

  /**
   * Compare one census against the last, and tell the supervisors of record
   * about anything that changed underneath them.
   *
   * Never throws: this runs on the daemon's timer, where an exception would
   * take out the missing-agent sweep it shares a tick with.
   */
  public async onSweep(census: {
    agents: WatchedAgent[];
    missing: LostAgent[];
  }): Promise<SupervisionSweepResult> {
    const result: SupervisionSweepResult = { changes: [], delivered: 0, skipped: [] };

    try {
      const changes = this.recognise(census);
      result.changes = changes;

      const running = new Set(
        census.agents
          .filter((agent) => agent.type)
          .map((agent) => agentNameFor(agent.type as string, agent.key))
      );

      for (const change of changes) {
        const outcome = await this.notify(change, running);
        if (outcome === null) result.delivered++;
        else result.skipped.push({ change, reason: outcome });
      }
    } catch (e: any) {
      this.opts.log(`[supervision] sweep failed: ${e?.message ?? String(e)}`);
    }

    return result;
  }

  /**
   * The transitions this sweep is the first to see.
   *
   * Missing agents keep their last known status rather than being forgotten:
   * the whole value of the loss notice is that it can say what the agent was
   * doing when it stopped, and that is the one fact the census no longer holds.
   */
  private recognise(census: { agents: WatchedAgent[]; missing: LostAgent[] }): AgentStateChange[] {
    const changes: AgentStateChange[] = [];
    const live = new Set<string>();
    // Every condition that currently holds, so the memory of everything that
    // stopped holding can be dropped in one pass at the end.
    const holding = new Set<string>();

    for (const agent of census.agents) {
      if (!agent.type) continue; // Not addressable; nothing to notify about.
      live.add(agent.agentName);

      const previous = this.lastStatus.get(agent.agentName);
      this.lastStatus.set(agent.agentName, agent.herdrStatus);

      if (agent.herdrStatus !== 'blocked') continue;
      holding.add(`${agent.agentName}:blocked`);
      // Only from `working`: an agent that was already blocked when this daemon
      // first saw it has not changed under anybody, and announcing the first
      // sweep after a daemon restart as a wave of new events would be the storm
      // in its purest form.
      if (previous !== 'working') continue;
      if (this.announced.has(`${agent.agentName}:blocked`)) continue;
      this.announced.add(`${agent.agentName}:blocked`);
      changes.push({
        agentName: agent.agentName,
        type: agent.type,
        key: this.spelling(agent.agentName, agent.key),
        from: previous,
        to: 'blocked'
      });
    }

    for (const lost of census.missing) {
      live.add(lost.agentName);
      const token = `${lost.agentName}:missing`;
      holding.add(token);
      if (this.announced.has(token)) continue;
      this.announced.add(token);
      changes.push({
        agentName: lost.agentName,
        type: lost.type,
        key: this.spelling(lost.agentName, lost.key),
        from: this.lastStatus.get(lost.agentName) ?? 'unknown',
        to: 'missing'
      });
    }

    for (const token of this.announced) {
      if (!holding.has(token)) this.announced.delete(token);
    }
    // An agent that is neither running nor expected has been stood down for
    // good; keeping its last status would leak a map entry per agent this
    // daemon ever saw.
    for (const agentName of this.lastStatus.keys()) {
      if (!live.has(agentName)) this.lastStatus.delete(agentName);
    }

    return changes;
  }

  /** The registry's spelling of a key, falling back to the census's. */
  private spelling(agentName: string, key: string): string {
    return this.opts.recordedKeyFor?.(agentName) ?? key;
  }

  /** Deliver one change, or say why it was dropped. `null` means delivered. */
  private async notify(change: AgentStateChange, running: Set<string>): Promise<string | null> {
    const { log, herdrBridge, supervisorFor } = this.opts;
    const deliver = this.opts.deliver ?? deliverToAgent;
    const subject = `${change.type}/${change.key} → ${change.to}`;

    const supervisor = supervisorFor(change.agentName);
    if (!supervisor) {
      log(`[supervision] ${subject}: no supervisor of record; nobody to tell.`);
      return 'no supervisor of record';
    }

    const supervisorName = agentNameFor(supervisor.type, supervisor.key);
    if (supervisorName === change.agentName) {
      log(
        `[supervision] ${subject}: its supervisor of record is itself; not telling an agent ` +
        `about its own status.`
      );
      return 'self-referential supervisor of record';
    }

    if (!running.has(supervisorName)) {
      log(
        `[supervision] ${subject}: supervisor ${supervisor.type}/${supervisor.key} is not running; ` +
        `logging and stopping. Its ticket comments and its own polling remain its inbox.`
      );
      return 'supervisor of record is not running';
    }

    log(`[supervision] ${subject}: telling ${supervisor.type}/${supervisor.key}.`);
    const outcome = await deliver({
      herdrBridge,
      type: supervisor.type,
      key: supervisor.key,
      message: supervisionNudgeText(change),
      log
    });

    return outcome.delivered ? null : (outcome.error ?? 'delivery could not be confirmed');
  }
}
