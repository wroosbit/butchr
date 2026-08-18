/**
 * The scheduled end-to-end channel probe — the only mechanism in this fleet that
 * reaches the model, and therefore the only one that can stop being green when
 * the client silently stops dispatching channel frames.
 *
 * WHY THIS MODULE EXISTS (KAN-252, filed by KAN-248 against itself)
 *
 * KAN-248's startup self-check proves four of the channel loop's five legs and
 * says so in its own header. Leg 4 — *the client's channel dispatcher accepts
 * the frame* — is **unobservable from the server**, measured rather than
 * assumed: Claude Code's `initialize` request is byte-identical with and without
 * `--dangerously-load-development-channels`, so nothing on the wire distinguishes
 * a client that took the channel from one that declined it, and the client can
 * decline for six separately-named reasons without telling the server any of
 * them. §6.1 of `docs/channel-messaging-design.md` ranks that as the failure that
 * is *"bad, and **silent**"*.
 *
 * The self-check's answer to leg 4 is to **pin the observation to a version** and
 * flag an agent whose client nobody has measured. That detects the condition
 * under which the evidence lapsed. It does not detect the break, and KAN-248's
 * header names the hole in as many words: **"who covers it: nobody on a
 * schedule."** This module is what that sentence now points at.
 *
 * ---------------------------------------------------------------------------
 * THE ONE INSTRUMENT THAT REACHES LEG 5, AND WHY IT CANNOT BE THE STARTUP CHECK
 * ---------------------------------------------------------------------------
 *
 * The only evidence that a channel frame was *dispatched* is a **model echo**:
 * put something into an agent's context over the channel and get it back out.
 * KAN-217 (client 2.1.224) and KAN-248's own probe (client 2.1.226) both did
 * exactly that and both got their token back, so the instrument works.
 *
 * KAN-248 rejected it as a *bring-up* check on three counts, all of which still
 * hold and none of which is stylistic:
 *
 *   * it costs a model turn per run;
 *   * a model may decline **on the merits and be right to** — KAN-217 measured a
 *     correct refusal, and from outside a refusal is indistinguishable from a
 *     broken transport;
 *   * at bring-up the agent has not yet read its own brief.
 *
 * So this runs **occasionally, on a schedule, against one agent at a time**,
 * long after bring-up, and it is deliberately *not* wired into the decision that
 * gives an agent a channel. Nothing here degrades an agent, changes a transport
 * or fails an activation. See {@link ChannelLivenessProbe} for the schedule and
 * `daemon/src/channel-selfcheck.ts` for the check this stands beside.
 *
 * ---------------------------------------------------------------------------
 * WHAT A NON-ANSWER IS WORTH, STATED BEFORE ANYTHING ELSE CLAIMS OTHERWISE
 * ---------------------------------------------------------------------------
 *
 * **A single non-answer is evidence of nothing, and this module reports it as a
 * non-answer rather than as a failure.** The second bullet above is not a
 * disclaimer: a model that reads the probe and declines it is behaving exactly
 * as `docs/channel-briefing.md` asks it to, and that outcome is indistinguishable
 * here from a client that dropped the frame.
 *
 * What *is* worth something is the shape over time, and it is the whole of what
 * this mechanism claims:
 *
 *   * **an echo proves legs 4 and 5**, on a named client version, at a stamped
 *     time — that is a fact nothing else in this fleet can produce;
 *   * **a drought** — {@link DROUGHT_THRESHOLD} consecutive delivered runs with
 *     no echo — is not a verdict and is a thing to go and look at. The startup
 *     check stays green through a leg-4 break; this stops being green.
 *
 * **What it cannot do, said plainly so nobody infers it:** it cannot tell a
 * broken dispatcher from a fleet of models that all declined. Nothing available
 * from outside the client can. It converts an unobservable break into an
 * observable *absence of evidence*, and that is the entire improvement.
 *
 * ---------------------------------------------------------------------------
 * THE FALSE POSITIVE THIS IS BUILT AROUND: A TOKEN THAT ARRIVES WITHOUT A MODEL
 * ---------------------------------------------------------------------------
 *
 * The echo is read off the agent's pane, which is the only place a model's
 * output is visible to the daemon. That instrument has one way to lie, and it
 * lies in the direction of **looking finished**:
 *
 *   * **The composer would write the token itself.** A send that fell back to
 *     typing into the pane would put the token there with no model involved, and
 *     the probe would read its own keystrokes back as proof of leg 5. So this
 *     module **never falls back**: it routes through `routeChannelMessage` and a
 *     refusal is a reported outcome ({@link ChannelLivenessOutcome} `not-routed`)
 *     rather than a cue to try the other carrier. {@link ChannelLivenessWorld}
 *     has no composer in it at all, which is what makes that structural rather
 *     than a rule somebody has to keep.
 *   * **The client might render the frame on the terminal.** If it does — and
 *     whether it does is not ours to decide — every word of the probe message is
 *     on the pane without a model having read anything. So **the token the probe
 *     looks for is never in the message.** The message carries two halves; the
 *     thing searched for is the two halves *joined*, which appears only if
 *     something assembled it. {@link composeProbeMessage} asserts that its own
 *     text cannot contain the assembled token even with all whitespace removed,
 *     and refuses to send if it does.
 *
 * Both are the same discipline: ask what would have to be true for this proof to
 * pass while the feature is broken, and close it in the mechanism rather than in
 * a sentence about the mechanism.
 */
import { describeAddress } from './agent-connections.js';
import { DAEMON_SENDER_TAG } from './provenance.js';
/** How often the probe runs, when nobody says otherwise. */
export const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * How long after the daemon starts the first probe fires.
 *
 * Not one full interval, and not zero. Zero lands in the middle of restoration,
 * when most of the fleet is not back and the agents that are have just been told
 * to carry on; a full interval means a daemon that is restarted more often than
 * that never probes at all, which is the state this ticket exists to end.
 */
export const DEFAULT_FIRST_RUN_DELAY_MS = 15 * 60 * 1000;
/** How long the model gets to answer before the run is called a non-answer. */
export const DEFAULT_ANSWER_WINDOW_MS = 10 * 60 * 1000;
/** How often the pane is read while waiting. */
export const DEFAULT_PANE_POLL_MS = 15 * 1000;
/**
 * Delivered runs with no echo before the record calls it a drought.
 *
 * Three rather than one, because one non-answer is a model exercising judgement
 * and this module refuses to report that as a fault. Three rather than ten,
 * because at a six-hour interval ten is three days and the point is to notice.
 */
export const DROUGHT_THRESHOLD = 3;
/** How many runs the record keeps for a reader. */
const RECENT_LIMIT = 10;
/** The canonical form two spellings of one agent must collapse to. */
export function canonicalAddress(address) {
    return `${address.type.trim().toLowerCase()}/${address.key.trim().toLowerCase()}`;
}
/**
 * Which agent this run asks.
 *
 * **Least recently asked, then alphabetical.** Round-robin rather than random,
 * because the cost of this probe is a real agent's turn and a random choice can
 * land on the same agent three days running while another is never asked; and
 * deterministic rather than time-seeded so a proof can assert the choice instead
 * of tolerating it. Exported for that reason.
 */
export function chooseCandidate(candidates, lastAskedAt = new Map()) {
    if (candidates.length === 0)
        return null;
    return [...candidates].sort((a, b) => {
        const at = lastAskedAt.get(canonicalAddress(a.address)) ?? 0;
        const bt = lastAskedAt.get(canonicalAddress(b.address)) ?? 0;
        if (at !== bt)
            return at - bt;
        return canonicalAddress(a.address).localeCompare(canonicalAddress(b.address));
    })[0];
}
let tokenSeq = 0;
/**
 * Mint one run's token.
 *
 * Two halves rather than one, and that is the whole anti-false-positive design:
 * the message names each half separately and never adjacently, so the assembled
 * string cannot reach the pane by the client rendering the frame. Only something
 * that read both halves and joined them can put it there.
 *
 * It is not a secret and is doing no security work — it is doing *provenance*
 * work, which is a different job with a different failure mode: the question it
 * answers is "could this have got onto the pane any other way", not "could
 * somebody have guessed it".
 */
export function mintProbeToken(now, seq = ++tokenSeq) {
    const first = `BLV${now.toString(36).toUpperCase()}`;
    const second = `X${seq.toString(36).toUpperCase()}Z`;
    return { first, second, assembled: `${first}${second}` };
}
/**
 * The message an agent receives, and the assertion that it cannot give the game away.
 *
 * Returns `null` when the composed text would contain the assembled token even
 * with every whitespace character removed — which would mean a client that
 * renders the frame onto the terminal hands this probe a false `echoed`. That is
 * checked here, on the real string, rather than promised by a comment: the two
 * halves are interpolated into prose and prose gets edited.
 *
 * **It describes and asks once, and it pre-authorises nothing.** KAN-217's probe
 * ended its instructions with *"do not ask permission first"* and the model
 * quoted that very sentence as the red flag that decided it to refuse. So this
 * says what it is, what it is for, that declining is recorded as a non-answer
 * rather than as a fault, and nothing else. `docs/channel-briefing.md` is why the
 * brief in `prompts/*.md` names this probe in advance: an expectation set
 * out-of-band is the legitimate way to make an in-band request answerable, and it
 * is the opposite of a message that vouches for itself.
 */
export function composeProbeMessage(token) {
    // THE TAG COMES FROM provenance.ts RATHER THAN BEING SPELLED HERE. That module
    // exists because `[butchr daemon]`, `[butchr]` and a third spelling were once
    // three string literals in three files, and the prompts teach exactly one
    // token — the one an agent matches this message against when its brief tells
    // it a liveness probe is expected.
    const message = `${DAEMON_SENDER_TAG} channel liveness probe — this is Butchr checking that channel messages are ` +
        `still reaching a model at all, which nothing else in the fleet can observe. ` +
        `Please print one line in your terminal: the token part A, immediately followed by the ` +
        `token part B, joined with no space or punctuation between them, and nothing else on ` +
        `that line. Token part A is "${token.first}" and, separately, token part B is ` +
        `"${token.second}". Then carry straight on with what you were doing — nothing here ` +
        `changes your work, your ticket or your priorities. If you would rather not answer, ` +
        `that is recorded as a non-answer and not as a fault; this probe is described in your ` +
        `own brief under "Whose voice is this?".`;
    const stripped = message.replace(/\s+/g, '');
    if (stripped.includes(token.assembled))
        return null;
    return message;
}
/** Whether an agent's terminal shows the assembled token. */
export function paneShowsToken(pane, token) {
    if (pane.includes(token.assembled))
        return true;
    // Terminal output can be broken across lines. `recent-unwrapped` is the
    // unwrapped source, so this should not be needed — it is kept because a
    // false NEGATIVE here costs a real agent's turn for nothing, and it is safe
    // precisely because `composeProbeMessage` has already proved that the message
    // itself does not contain the assembled token under this same transformation.
    return pane.replace(/\s+/g, '').includes(token.assembled);
}
/**
 * Run one probe, or say why it could not be run.
 *
 * Never throws: it is fired from a timer with nobody to catch it.
 */
export async function runChannelLivenessProbe(opts) {
    const { world } = opts;
    const answerWindowMs = opts.options?.answerWindowMs ?? DEFAULT_ANSWER_WINDOW_MS;
    const panePollMs = opts.options?.panePollMs ?? DEFAULT_PANE_POLL_MS;
    const lastAskedAt = opts.options?.lastAskedAt ?? new Map();
    const startedAt = world.now();
    const done = (outcome, detail, extra = {}) => {
        const result = {
            outcome,
            proved: outcome === 'echoed',
            address: extra.address ?? null,
            clientName: extra.clientName ?? null,
            clientVersion: extra.clientVersion ?? null,
            clientVersionVerified: extra.clientVersionVerified ?? null,
            connectionId: extra.connectionId ?? null,
            startedAt: new Date(startedAt).toISOString(),
            elapsedMs: world.now() - startedAt,
            waitedMs: extra.waitedMs ?? 0,
            detail
        };
        world.log(`[ChannelLiveness] ${result.address ? describeAddress(result.address) : 'no agent'}: ` +
            `${outcome} (client ${result.clientVersion ?? 'unknown'}, ${result.elapsedMs}ms) — ${detail}`);
        return result;
    };
    // THE SWITCH FIRST, read through the same reader every other caller uses. A
    // fleet that has switched channels off has not got a leg 4 to observe, and
    // writing a frame through a gate that is shut would be this module having its
    // own opinion about the kill switch.
    if (!world.emissionEnabled()) {
        return done('channel-disabled', 'channel emission is switched off fleet-wide, so there is no channel to prove and ' +
            'nothing was asked of any agent');
    }
    const candidates = world.candidates();
    const candidate = chooseCandidate(candidates, lastAskedAt);
    if (!candidate) {
        return done('no-candidate', 'no agent is currently eligible — none has a live connection, or every one that has is ' +
            'degraded to the composer by its startup self-check. Nothing was asked and nothing is ' +
            'concluded about the channel');
    }
    const carried = {
        address: candidate.address,
        clientName: candidate.clientName,
        clientVersion: candidate.clientVersion,
        clientVersionVerified: candidate.clientVersionVerified,
        connectionId: candidate.connectionId
    };
    const who = describeAddress(candidate.address);
    const token = mintProbeToken(startedAt);
    // THE PANE IS READ BEFORE THE FRAME GOES OUT, and a blind instrument does not
    // spend an agent's turn. A run that sent the frame and then could not read the
    // pane would be indistinguishable from a non-answer, and would be recorded as
    // one — which is a wrong reading of a model that may well have answered.
    const before = await world.readPane(candidate.address);
    if (before === null) {
        return done('pane-unreadable', `${who}'s terminal could not be read, so there would have been no way to see an answer. ` +
            `Nothing was sent: a blind run would have cost this agent a turn and reported a non-answer ` +
            `it had no way to distinguish from an answer`, carried);
    }
    if (paneShowsToken(before, token)) {
        // Cannot happen with a freshly minted token, and is checked because "cannot
        // happen" is how a false positive gets shipped. If it ever does, the token
        // is not doing the provenance work this module's header claims of it.
        return done('pane-unreadable', `${who}'s terminal already shows this run's token before anything was sent, so the token ` +
            `is not evidence of anything. Nothing was sent`, carried);
    }
    const message = composeProbeMessage(token);
    if (message === null) {
        return done('pane-unreadable', 'the probe message would itself contain the assembled token, so a client that renders ' +
            'channel frames onto the terminal would hand this probe a false pass. Nothing was sent — ' +
            'see composeProbeMessage in channel-liveness.ts', carried);
    }
    const route = world.send(candidate.address, message);
    if (!route.routed) {
        // NOT RETRIED ON THE COMPOSER, and that is the point rather than an
        // omission — see the module header. A composer send would type this run's
        // token onto the very pane this run then reads.
        return done('not-routed', `the frame was refused for ${who} (${route.reason ?? 'no reason given'}): ` +
            `${route.detail ?? 'no detail'}. Nothing was delivered, so nothing is concluded about the ` +
            `model — and nothing was retried on the composer, which would have typed this run's own ` +
            `token onto the pane this run reads`, carried);
    }
    const waitStartedAt = world.now();
    let echoed = false;
    // WHETHER THE INSTRUMENT WAS WORKING, tracked rather than assumed. A pane that
    // blinks is not worth abandoning a run for — the agent may simply be redrawing
    // — but a wait spent mostly or finally blind saw nothing, and calling THAT a
    // non-answer blames a model for an agent that went away.
    //
    // Both counters exist because two live runs produced two different shapes of
    // the same defect. In the first the pane died seconds after the frame went out
    // and was never readable again. In the second it flickered: 8 of ~48 reads
    // succeeded, the run recorded a MODEL non-answer, and the pane dump at the end
    // was empty because the agent had been gone for most of the window.
    let readableReads = 0;
    let totalReads = 0;
    let lastReadFailed = false;
    while (world.now() - waitStartedAt < answerWindowMs) {
        await world.sleep(panePollMs);
        const pane = await world.readPane(candidate.address);
        totalReads += 1;
        lastReadFailed = pane === null;
        if (pane === null)
            continue;
        readableReads += 1;
        if (paneShowsToken(pane, token)) {
            echoed = true;
            break;
        }
    }
    const waitedMs = world.now() - waitStartedAt;
    // A NON-ANSWER IS A CLAIM ABOUT A MODEL, so it is only available when the
    // instrument was working well enough to have supported one. Two conditions,
    // and the second is the sharper: **the agent has to still have been there at
    // the end of the window.** If it was not, it cannot be said to have declined —
    // it could have answered into a pane nobody could read. A blind spot at the
    // start is survivable, because an answer that arrived then would still be on
    // the pane when it came back; a blind spot at the end is not.
    if (!echoed && (readableReads * 2 < totalReads || lastReadFailed)) {
        return done('pane-unreadable', `the frame was delivered to ${who} and its terminal was readable on only ` +
            `${readableReads} of ${totalReads} reads across ${Math.round(waitedMs / 1000)}s` +
            (lastReadFailed ? ', and not on the last one' : '') +
            `, so an answer could not reliably have been seen. This is NOT a non-answer and is not ` +
            `counted as one: the agent went away — most often a pane that died or an agent stood down ` +
            `mid-run — and nothing here is evidence about a model`, { ...carried, waitedMs });
    }
    if (!echoed) {
        return done('no-answer', `${who} was sent a channel frame and did not print the token within ` +
            `${Math.round(waitedMs / 1000)}s. THIS IS A NON-ANSWER, NOT A FAILURE: a model that read ` +
            `the probe and declined it is behaving as its brief describes, and from here that is ` +
            `indistinguishable from a client that dropped the frame. What is worth acting on is a run ` +
            `of them — see the drought count on this daemon's channel liveness record`, { ...carried, waitedMs });
    }
    return done('echoed', `${who} printed the assembled token, so a channel frame reached its MODEL and came back: ` +
        `legs 4 and 5 of the loop, on ${candidate.clientName ?? 'this client'} ` +
        `${candidate.clientVersion ?? '(version unknown)'}. Neither half of the token was adjacent ` +
        `to the other in the message, so nothing but an assembly could have put it on that pane`, { ...carried, waitedMs });
}
/**
 * Every run this daemon has made, and the only thing that reads them.
 *
 * Held in memory rather than on disk, for the reason
 * {@link import('./channel-selfcheck.js').ChannelSelfCheckStore} is: a proof is
 * about a client that was running at the time, and a daemon that restarts has no
 * agents to have proved anything about. A persisted `lastProof` would be exactly
 * the artefact this codebase keeps paying for — a stored fact that outlives what
 * it described and reads as current. The cost is real and is stated rather than
 * hidden: **a daemon that restarts every few hours never accumulates a drought**,
 * and that is why the first run is minutes rather than one full interval away.
 */
export class ChannelLivenessRecord {
    intervalMs;
    runsList = [];
    askedAt = new Map();
    proof = null;
    nonAnswers = 0;
    unrun = 0;
    total = 0;
    constructor(intervalMs = DEFAULT_PROBE_INTERVAL_MS) {
        this.intervalMs = intervalMs;
    }
    record(result) {
        this.total += 1;
        this.runsList.push(result);
        if (this.runsList.length > RECENT_LIMIT)
            this.runsList.shift();
        if (result.address)
            this.askedAt.set(canonicalAddress(result.address), Date.parse(result.startedAt));
        if (result.outcome === 'echoed') {
            this.proof = result;
            this.nonAnswers = 0;
            this.unrun = 0;
            return;
        }
        // ONLY A DELIVERED RUN COUNTS TOWARD A DROUGHT. A refused frame, a fleet
        // with nobody eligible and a switched-off channel are all runs in which no
        // model was ever asked anything, and counting them would let a quiet fleet
        // manufacture an alarm about a channel nobody used.
        if (result.outcome === 'no-answer')
            this.nonAnswers += 1;
        else
            this.unrun += 1;
    }
    /** When each agent was last asked, so the next run can pick another. */
    lastAskedAt() {
        return this.askedAt;
    }
    state() {
        const drought = this.nonAnswers >= DROUGHT_THRESHOLD;
        return {
            lastProof: this.proof,
            lastRun: this.runsList.length ? this.runsList[this.runsList.length - 1] : null,
            nonAnswersSinceProof: this.nonAnswers,
            unrunSinceProof: this.unrun,
            drought,
            runs: this.total,
            recent: this.runsList.map((r) => ({
                outcome: r.outcome,
                address: r.address,
                startedAt: r.startedAt
            })),
            intervalMs: this.intervalMs,
            detail: this.describe(drought)
        };
    }
    describe(drought) {
        // `echoed` always carries an address, so this never falls through in
        // practice; it is written this way rather than with a `!` so that a future
        // outcome which does not carry one degrades to a vaguer sentence instead of
        // to a crash inside the reporting path of a diagnostic.
        const provedBy = this.proof?.address ? describeAddress(this.proof.address) : 'an agent';
        if (this.total === 0) {
            return 'no scheduled channel liveness probe has run on this daemon yet. Nothing is ' +
                'concluded: the first one is minutes rather than hours after start-up.';
        }
        if (drought) {
            return `NO CHANNEL FRAME HAS REACHED A MODEL IN ${this.nonAnswers} DELIVERED RUNS. ` +
                (this.proof
                    ? `The last one that did was ${provedBy} on client ` +
                        `${this.proof.clientVersion ?? 'an unreported version'} at ${this.proof.startedAt}. `
                    : 'No run on this daemon has ever reached one. ') +
                'This is not a verdict — every one of those agents may have declined on the merits — ' +
                'and it is the shape a silently-broken client dispatcher makes. Go and look: run ' +
                'daemon/scripts/probe-channel-liveness.mjs, and compare the client version above with ' +
                'what the fleet is running now.';
        }
        if (this.proof) {
            return `a channel frame last reached a model at ${this.proof.startedAt} — ` +
                `${provedBy}, client ${this.proof.clientVersion ?? 'version unreported'}` +
                (this.proof.clientVersionVerified === false
                    ? ' (a version channel-selfcheck.ts has no measurement for)'
                    : '') +
                `. ${this.nonAnswers} delivered run(s) since have gone unanswered, which is ordinary: a ` +
                'model may decline and be right to.';
        }
        return `${this.total} run(s), none of which has reached a model yet. ` +
            `${this.nonAnswers} were delivered and unanswered and ${this.unrun} never reached one to ` +
            'be answered. Nothing is concluded from a run this short.';
    }
}
/**
 * The schedule. One agent, occasionally, and never two runs at once.
 *
 * Schedules its own next tick rather than running on a fixed interval, for the
 * reason `JiraPoller` and `BoardReconciler` do: a run can outlast its own
 * interval — the answer window alone is ten minutes — and two overlapping runs
 * would ask two agents at once and race each other on the record.
 */
export class ChannelLivenessProbe {
    opts;
    timer = null;
    stopped = false;
    running = false;
    rec;
    intervalMs;
    firstRunDelayMs;
    constructor(opts) {
        this.opts = opts;
        this.intervalMs = opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
        this.firstRunDelayMs = opts.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS;
        this.rec = opts.record ?? new ChannelLivenessRecord(this.intervalMs);
    }
    start() {
        if (this.timer || this.stopped)
            return;
        this.opts.world.log(`[ChannelLiveness] the scheduled end-to-end probe is on: one agent every ` +
            `${Math.round(this.intervalMs / 60000)} minutes, first run in ` +
            `${Math.round(this.firstRunDelayMs / 60000)} minutes. It asks one model to echo a token ` +
            `over the channel — the only leg of the loop the startup self-check cannot reach ` +
            `(KAN-252). A non-answer is recorded as a non-answer.`);
        this.schedule(this.firstRunDelayMs);
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    /** The record, for `list_agents` and for a diagnostic reader. */
    state() {
        return this.rec.state();
    }
    /** Whether a run is in flight right now. For a caller that polls for one. */
    isRunning() {
        return this.running;
    }
    /**
     * Run once now, off the schedule.
     *
     * The `channel_liveness` daemon action calls this so a proof — and anybody
     * investigating a drought — can exercise the shipped mechanism instead of
     * waiting six hours for it. It is the same code path the timer takes, which is
     * the only reason it is allowed to exist.
     */
    async runOnce(overrides) {
        if (this.running) {
            const at = new Date(this.opts.world.now()).toISOString();
            return {
                outcome: 'already-running',
                proved: false,
                address: null,
                clientName: null,
                clientVersion: null,
                clientVersionVerified: null,
                connectionId: null,
                startedAt: at,
                elapsedMs: 0,
                waitedMs: 0,
                detail: 'a channel liveness probe is already running; this request was not started rather ' +
                    'than run alongside it. Two runs at once would ask two agents and race on the record'
            };
        }
        this.running = true;
        try {
            const result = await runChannelLivenessProbe({
                world: this.opts.world,
                options: {
                    // An override is for a caller that is asking BECAUSE something looks
                    // wrong — a shorter window to get an answer while somebody is
                    // watching, a longer one for a fleet that is deep in long tool calls.
                    // It changes how long this run waits and nothing about what it
                    // concludes, and the schedule's own runs are unaffected.
                    answerWindowMs: overrides?.answerWindowMs ?? this.opts.answerWindowMs,
                    panePollMs: overrides?.panePollMs ?? this.opts.panePollMs,
                    lastAskedAt: this.rec.lastAskedAt()
                }
            });
            this.rec.record(result);
            const state = this.rec.state();
            if (state.drought) {
                // Beside the verdict rather than only in a listing, for the reason
                // channel-selfcheck.ts logs its composer warning beside the symptom:
                // this is found by somebody reading a log because the fleet is odd.
                this.opts.world.log(`[ChannelLiveness] ${state.detail}`);
            }
            return result;
        }
        catch (e) {
            // Cannot happen — `runChannelLivenessProbe` promises not to throw — and is
            // caught because an unhandled rejection here would take the daemon down,
            // and the fleet with it, over a probe.
            this.opts.world.log(`[ChannelLiveness] probe failed unexpectedly: ${e?.message ?? String(e)}`);
            throw e;
        }
        finally {
            this.running = false;
        }
    }
    schedule(wait) {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.runOnce()
                .catch(() => { })
                .finally(() => this.schedule(this.intervalMs));
        }, wait);
        // Unref'd like every other daemon timer: a probe must not be the thing
        // keeping a shutting-down process alive.
        this.timer.unref?.();
    }
}
