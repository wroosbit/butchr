/**
 * The guardian agent, and the clock that pokes it.
 *
 * WHY THIS MODULE EXISTS (KAN-284)
 *
 * The human, relayed through `epic/KAN-203`: *"butchr should have one guardian
 * agent, which is configurable in the settings page or via mcp. it should
 * receive a poke every 30 minutes."*
 *
 * The argument for it is measured rather than asserted. `epic/KAN-203` ran fleet
 * supervision by hand as a self-paced `ScheduleWakeup` loop, and it **silently
 * failed to fire twice in one day** — once consumed by conversational turns,
 * once for a reason it could not determine, **because nothing lets an agent
 * inspect a pending wakeup.** Both times the human noticed the fleet had gone
 * quiet before the supervisor did. The daemon's own timers, over the same
 * period, missed nothing: the converger polled every 60 seconds through two
 * capacity outages, three restarts and a twelve-hour Atlassian blackout. So this
 * moves the supervision heartbeat **off the least reliable clock onto the most
 * reliable one**, and that is the whole of what it claims.
 *
 * A daemon-held clock is categorically better than an agent-held one, and
 * `prompts/epic.md`'s *Cadence* section already prefers exactly that: *"Act on
 * events, not on a clock. Your events are nudges from your children, the
 * daemon's Jira poller, and the human — **never a timer you set yourself**."*
 * This is a fourth event **of the same species as the Jira poller** —
 * daemon-held, arriving from outside, not settable and not inspectable by its
 * recipient.
 *
 * **THIS ADDS AN EVENT. IT RETIRES NOTHING, AND THAT LIMIT IS DELIBERATE.**
 *
 * An earlier draft of this header said the poke *replaced* the epic agent's
 * self-paced `ScheduleWakeup` loop, reasoning from the Cadence sentence above.
 * **That was wrong, and the correction is worth more than the claim was**:
 * `epic/KAN-203` reports that the human instructed that loop **directly, twice,
 * after that prompt text was written** — *"keep a loop going so you can keep
 * things moving"*, and *"make sure you're always moving toward these goals, and
 * your loop is always going"*. A prompt convention does not override a standing
 * instruction from the person the convention exists to serve, so whether the
 * loop is retired is **the human's decision and not this module's**.
 *
 * The substantive reason is stronger than the provenance one, and it is an
 * argument this module has to make against itself: **the loop has failed twice
 * and been caught twice; this poke has never run.** `epic/KAN-203` deliberately
 * runs two mechanisms today — the self-paced loop plus a cron backstop that
 * re-arms it — so replacing a proven-unreliable mechanism with a single unproven
 * one is a **loss of redundancy** even where the new one is better in isolation.
 * The honest sequence is: run alongside, demonstrate that it fires reliably
 * including across a daemon restart, and let the human retire the other one
 * then, if they want to.
 *
 * **It does not touch the supervision sweep** either — five reads performed once
 * per turn you were already having. The poke is a *wake-up*; the sweep is what
 * you do when woken. KAN-186 owns the prompt's two undefined references to "that
 * loop", and this module deliberately does not resolve them.
 *
 * ---------------------------------------------------------------------------
 * THE SENTENCE THIS MODULE IS BUILT AGAINST, AND IT IS NOT ON THIS FEATURE'S SIDE
 * ---------------------------------------------------------------------------
 *
 * From `epic/KAN-39`, pinned to KAN-284 above every other line on it:
 *
 *   > **A heartbeat proves the loop turns; it says nothing about whether its
 *   > decisions are right.**
 *
 * **A guardian is a heartbeat by construction, so that sentence is an objection
 * to this feature and not a caveat on it.** A guardian that pokes perfectly for
 * eight hours while supervising nothing is *worse* than no guardian, because it
 * reads as coverage. Nothing here detects that, and **no heartbeat can**.
 *
 * So this module is not built to be a detector. It is built so that it **cannot
 * be mistaken for one**, and that is a design constraint with three mechanical
 * consequences rather than a disclaimer:
 *
 *   1. **Nothing here is named for health.** There is no `healthy`, no `ok`, no
 *      `status`. The fields are named for the *poke* — {@link GuardianState.lastDelivered},
 *      {@link GuardianState.consecutiveUndelivered} — and the one boolean a
 *      caller branches on is `delivered`, which is a claim about a frame
 *      reaching a connection and is incapable of being read as a claim about a
 *      fleet. Same discipline as `channel-liveness.ts`, whose `proved` is true
 *      only for `echoed`.
 *   2. **The limit is carried as data, not as a comment.** {@link GuardianState.proves}
 *      is the literal `'delivery'` and {@link GuardianState.provesDetail} is the
 *      sentence every surface renders **verbatim**. A comment in this file is
 *      invisible to the board page; a field is not. That matters because the
 *      board display is where the overclaim would actually be made.
 *   3. **What is detectable is detected and what is not is said to be.**
 *      Detected: undelivered (KAN-274's refusal, propagated), silence across
 *      {@link OVERDUE_INTERVALS} intervals, and no guardian configured at all.
 *      Not detected, and named as not detected: whether the sweep it ran was
 *      right.
 *
 * **The residue is real and is not closed by this module.** The first thing that
 * would bear on correctness rather than on cadence is the *durable artifact*: a
 * sweep leaves a comment on a ticket, and "has the guardian commented since the
 * last poke" is answerable by the Jira poller, which already reads exactly that.
 * That is still not correctness — it is "the loop left something a human can
 * judge" — and it is a separate ticket, linked `Relates` to KAN-284 rather than
 * left for a reader to infer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POKE IS NEVER HELD, WHICH IS A DELIBERATE DIVERGENCE FROM notify.ts
 * ---------------------------------------------------------------------------
 *
 * KAN-301 gave the daemon's two notification producers a hold-and-deliver queue
 * ({@link import('./notify.js').PendingNotifications}): a frame the channel will
 * not take is held and retried, because a registration lost to a restart comes
 * back within seconds and the news would otherwise be dropped for good.
 *
 * **That is right for news and wrong for a poke, and this module does not use
 * it.** Two reasons, and the second is the one that matters:
 *
 *   * A poke is **periodic**. If this one did not land the next is one interval
 *     away, so the retry already exists and is called the schedule. Delivering a
 *     held poke later is delivering a *stale* one — it says "sweep now" at a
 *     moment nobody chose.
 *   * Holding it would convert **undelivered into pending**, and `pending` is a
 *     reassurance. AC2 and AC3 of KAN-284 exist precisely to forbid that: *"a
 *     poke to an unregistered agent must report undelivered, not success"* and
 *     *"a poke to an absent guardian is loud, and visibly distinct from a quiet
 *     successful one."* A queue would make the loudest state look like the
 *     quietest one.
 *
 * So: fire, report what happened, let the interval be the retry.
 *
 * ---------------------------------------------------------------------------
 * A POINTER, NEVER A SPAWN — AND THE INTERFACE IS WHAT ENFORCES IT
 * ---------------------------------------------------------------------------
 *
 * The human, relayed by `epic/KAN-203` on 2026-08-11 while this was being
 * written: *"the guardian agent should pointed to an existing agent, not a whole
 * new agent."* Read back against the original instruction, that is plainly what
 * it always said — *"it should be **set to be** you"*, addressed to an agent
 * that was already running and already had a job. A dedicated guardian would
 * have been *"start a guardian"*, and it never was.
 *
 * So the guardian is **a setting that names an agent**, and this module has no
 * power to bring one into existence:
 *
 *   * {@link GuardianWorld} exposes four capabilities — the kill switch, the
 *     config, a channel write, and a clock. **There is no activator in it**, the
 *     same way and for the same reason there is no composer: what the interface
 *     cannot express, no future author can quietly add at a call site.
 *   * A pointer at an agent that is not running therefore produces `undelivered`
 *     and nothing else. That is AC3 working, not a gap to be closed by starting
 *     something — **a guardian the system spawns to receive its own pokes proves
 *     nothing**, and would be this epic's favourite defect in its purest form.
 *   * It costs **no capacity**, which is part of the point on a 4-core machine
 *     that has been at zero headroom twice in a day. The role is laid on an
 *     agent that is already carrying its own ticket, and the poke message says
 *     so in as many words.
 *
 * ---------------------------------------------------------------------------
 * THE CHANNEL, AND ONLY THE CHANNEL
 * ---------------------------------------------------------------------------
 *
 * A poke every thirty minutes over the composer is an agent Ctrl+C'd every
 * thirty minutes **by design** — 48 destroyed tool calls a day, delivered by the
 * mechanism that exists to keep the fleet healthy. {@link GuardianWorld} has no
 * composer in it at all, which makes that unrepresentable rather than forbidden;
 * it is the same structural choice, for the same reason, as
 * `ChannelLivenessWorld`.
 *
 * ---------------------------------------------------------------------------
 * EXACTLY ONE GUARDIAN, ENFORCED TWICE, AND ONLY ONE OF THEM IS A RULE
 * ---------------------------------------------------------------------------
 *
 * *"The failure mode of two is two parties each assuming the other swept"* — and
 * that is not hypothetical: it happened **to KAN-284 itself**, which was filed
 * twice, ninety minutes apart, by two agents each assuming the other had checked
 * the backlog.
 *
 * So {@link GuardianConfig} holds a single `address` **field** rather than a
 * list: two guardians are not refused, they are *unrepresentable*. The refusal
 * ({@link setGuardian}) sits on the write path and exists for the second half of
 * the problem — an author who does not know there is an incumbent — so it names
 * the incumbent and when it was set rather than saying no. A rule enforced by
 * the shape of the data is the one that survives the next author; a rule
 * enforced by a check is the one that gets an `if` around it.
 */
import path from 'path';
import fs from 'fs';
import { describeAddress } from './agent-connections.js';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
import { DAEMON_SENDER_TAG } from './provenance.js';
/** Where the guardian is recorded. Absent is ordinary, and it means none. */
export const GUARDIAN_PATH = path.join(BUTCHR_DIR, 'guardian.json');
/** How often the guardian is poked, when nobody says otherwise. */
export const DEFAULT_POKE_INTERVAL_MS = 30 * 60 * 1000;
/**
 * How long after the daemon starts the first poke fires.
 *
 * Not zero and not one full interval, for `channel-liveness.ts`'s reasons: zero
 * lands in the middle of restoration, when the guardian may not be back yet and
 * would take a poke it cannot act on; one full interval means a daemon restarted
 * more often than that never pokes at all — which is this ticket's own failure
 * mode reintroduced one level down.
 *
 * Five minutes rather than fifteen because a poke costs its recipient a turn's
 * context and nothing else, where a liveness probe costs it a whole turn.
 */
export const DEFAULT_FIRST_POKE_DELAY_MS = 5 * 60 * 1000;
/**
 * Intervals without a delivered poke before the record says `overdue`.
 *
 * Two rather than one, because one missed poke is a restart or a client reload
 * and the next one lands; two is sixty minutes of a fleet with nobody watching
 * it, which is what the human noticed by hand and what this exists to surface
 * before they have to.
 */
export const OVERDUE_INTERVALS = 2;
/** The narrowest interval a caller may configure, and the widest. */
export const MIN_POKE_INTERVAL_MS = 60 * 1000;
export const MAX_POKE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How many pokes the record keeps for a reader. */
const RECENT_LIMIT = 10;
/** The empty config, which is what every unreadable file degrades to. */
export function noGuardian() {
    return { address: null, intervalMs: null, setBy: null, setAt: null };
}
/**
 * Read the guardian, fresh from disk, every time.
 *
 * Never throws and never partially answers: a file that is missing, malformed,
 * half-written or the wrong shape reads as **no guardian**, which is the state
 * in which this feature does nothing at all. `channelEmissionEnabled` fails the
 * same way for the same reason — a mechanism that fails *open* on a corrupt file
 * is one that acts on a file somebody was in the middle of editing.
 *
 * Read per use rather than captured at boot, for `BoardReconciler.readMode`'s
 * reason, which `board-control.ts` records: a value captured at boot is stale in
 * exactly the case that matters. Setting a guardian must not need a restart —
 * restarting is what drops every channel registration in the fleet.
 */
export function readGuardianConfig(readFile = defaultRead) {
    try {
        const parsed = JSON.parse(readFile());
        const address = normaliseAddress(parsed?.address);
        if (!address)
            return noGuardian();
        const intervalMs = typeof parsed?.intervalMs === 'number' && Number.isFinite(parsed.intervalMs)
            ? clampInterval(parsed.intervalMs)
            : null;
        return {
            address,
            intervalMs,
            setBy: typeof parsed?.setBy === 'string' ? parsed.setBy : null,
            setAt: typeof parsed?.setAt === 'string' ? parsed.setAt : null
        };
    }
    catch {
        return noGuardian();
    }
}
function defaultRead() {
    return fs.readFileSync(GUARDIAN_PATH, 'utf8');
}
/** An address is two non-empty strings or it is not an address. */
function normaliseAddress(value) {
    const type = typeof value?.type === 'string' ? value.type.trim() : '';
    const key = typeof value?.key === 'string' ? value.key.trim() : '';
    if (!type || !key)
        return null;
    return { type, key };
}
/** Clamp rather than reject: an out-of-range interval is a typo, not a request. */
export function clampInterval(ms) {
    return Math.min(MAX_POKE_INTERVAL_MS, Math.max(MIN_POKE_INTERVAL_MS, Math.round(ms)));
}
/**
 * Write the guardian, atomically.
 *
 * Temp file and `rename`, for {@link writeChannelSwitch}'s reason: this is read
 * on every poke and by every board page, so a plain write leaves a window in
 * which the file is half a JSON document — and a reader landing there sees *no
 * guardian*, which is safe and is also a guardian that vanishes for no reason
 * anybody can find afterwards.
 */
export function writeGuardianConfig(config) {
    ensureButchrDir();
    const tmp = `${GUARDIAN_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, GUARDIAN_PATH);
}
/**
 * Set the guardian, or refuse and say what is already there.
 *
 * **The refusal is the point rather than the guard.** Two guardians are already
 * unrepresentable — the config holds one field — so nothing here prevents a
 * second one existing. What it prevents is the *silent replacement*: an author
 * who does not know there is an incumbent, overwriting it, and leaving two
 * parties each believing they are the guardian. That is the failure mode this
 * ticket was filed about and the one it suffered.
 *
 * So `replace` is not a force flag with a warning attached — it is the
 * difference between "I am setting the guardian" and "I know who the guardian is
 * and I am changing it". The refusal names the incumbent and when it was set,
 * because those are the two facts that turn the first sentence into the second.
 */
export function setGuardian(opts) {
    const address = normaliseAddress(opts.address);
    if (!address) {
        return {
            ok: false,
            refusal: 'invalid-address',
            detail: 'a guardian is a workspace type and key, e.g. type "epic" and key "KAN-203". Both must ' +
                'be non-empty strings; nothing was written',
            incumbent: null
        };
    }
    const current = opts.read();
    const incumbent = current.address;
    // SAME AGENT IS NOT A SECOND GUARDIAN, so it is not refused. Setting the
    // guardian to who the guardian already is is idempotent — which is what makes
    // it safe for the options page to write on every save, and for a caller that
    // cannot remember whether it already did.
    const sameAsIncumbent = incumbent !== null && canonical(incumbent) === canonical(address);
    if (incumbent && !sameAsIncumbent && opts.replace !== true) {
        return {
            ok: false,
            refusal: 'already-set',
            detail: `${describeAddress(incumbent)} is already the guardian` +
                (current.setAt ? `, set at ${current.setAt}` : '') +
                (current.setBy ? ` by ${current.setBy}` : '') +
                `. There is exactly one guardian, deliberately: two of them is two parties each ` +
                `assuming the other swept. Nothing was written. To change it, say so explicitly by ` +
                `passing replace — that is the difference between setting a guardian and knowing who ` +
                `the guardian is and changing it`,
            incumbent
        };
    }
    const config = {
        address,
        intervalMs: typeof opts.intervalMs === 'number' && Number.isFinite(opts.intervalMs)
            ? clampInterval(opts.intervalMs)
            : // An unspecified interval keeps whatever was configured rather than
                // silently reverting to the default: a caller changing WHO the
                // guardian is has said nothing about HOW OFTEN, and helpfully
                // resetting it would be this codebase's favourite defect — a change
                // that does more than its sentence says.
                current.intervalMs,
        setBy: opts.setBy ?? null,
        setAt: new Date(opts.now()).toISOString()
    };
    opts.write(config);
    return {
        ok: true,
        config,
        replaced: sameAsIncumbent ? null : incumbent,
        detail: `${describeAddress(address)} is the guardian` +
            (sameAsIncumbent
                ? ' (unchanged — it already was, so this wrote the same address back)'
                : incumbent
                    ? `, replacing ${describeAddress(incumbent)}`
                    : '')
    };
}
/** Unset the guardian. Reports whether there was one, rather than assuming. */
export function clearGuardian(opts) {
    const current = opts.read();
    opts.write(noGuardian());
    return {
        cleared: current.address,
        detail: current.address
            ? `${describeAddress(current.address)} is no longer the guardian. Nothing is being poked, ` +
                `and nothing is watching the fleet on a timer until one is set`
            : 'there was no guardian to clear; nothing changed'
    };
}
function canonical(address) {
    return `${address.type.trim().toLowerCase()}/${address.key.trim().toLowerCase()}`;
}
/**
 * The message the guardian receives.
 *
 * **It asks for a sweep and pre-authorises nothing**, which is `composeProbeMessage`'s
 * lesson learned at a cost: KAN-217's probe ended its instructions with *"do not
 * ask permission first"* and the model **quoted that very sentence** as the red
 * flag that decided it to refuse. From outside, a correct refusal is
 * indistinguishable from a broken transport — which for this feature means the
 * fleet is unsupervised while everything reports healthy, on a thirty-minute
 * timer, exactly the way it would if the poke were never delivered at all.
 *
 * **So the brief is what makes this answerable, not the message.** `prompts/epic.md`
 * names this poke as expected out-of-band, for `docs/channel-briefing.md`'s
 * reason: an expectation set out-of-band is the legitimate way to make an
 * in-band request answerable, and it is the opposite of a message that vouches
 * for itself. This text points at that section rather than asserting its own
 * authority.
 *
 * **It names the durable artifact**, and that is the one thing here that is not
 * cadence. The daemon cannot judge whether a sweep was right; it can ask that
 * the sweep leave something a human can judge, and the absence of that is
 * visible to a reader in a way that a missed heartbeat is not.
 *
 * **AND IT SAYS THAT IT IS ARRIVING MID-JOB, BECAUSE IT IS.** The guardian is a
 * *pointer to an agent that already exists and already has work* — the human,
 * relayed 2026-08-11: *"the guardian agent should pointed to an existing agent,
 * not a whole new agent."* So unlike a dedicated supervisor's prompt, this one
 * lands in a context that is busy with something else, and a message that reads
 * as though it owned the recipient's attention would be asking it to drop a
 * ticket it is mid-way through. The role is additive and the wording has to be.
 */
export function composePokeMessage(opts) {
    const minutes = Math.round(opts.intervalMs / 60000);
    return (`${DAEMON_SENDER_TAG} guardian sweep poke #${opts.pokeNumber} — you are Butchr's guardian ` +
        `agent, and this is the daemon's timer rather than a person asking. It arrives every ` +
        `${minutes} minutes for as long as you hold that role. ` +
        `WHAT IT IS FOR: fleet supervision used to run on a wakeup an agent scheduled for itself, ` +
        `which failed silently twice in one day because nothing lets an agent inspect a pending ` +
        `wakeup. The clock now lives here. ` +
        `THIS IS ADDITIONAL TO YOUR OWN WORK, NOT INSTEAD OF IT. Being the guardian is a role laid ` +
        `on an agent that already has a ticket; this poke arrives in the middle of that ticket and ` +
        `does not outrank it. Finish what you are mid-way through first if that is the right call. ` +
        `WHAT TO DO: run your supervision sweep once — the reads your brief defines — and then ` +
        `stop. If it finds nothing actionable, that is the ordinary outcome and it is worth ` +
        `recording as such. ` +
        `LEAVE SOMETHING A HUMAN CAN JUDGE: post or update a brief sweep summary on your own ` +
        `ticket, including when it found nothing. A poke that landed proves this loop turns; it ` +
        `says nothing about whether your decisions were right, and your comment is the only ` +
        `artifact that lets anybody check the second. ` +
        `THIS CHANGES NO PRIORITY AND AUTHORISES NOTHING. It is described in your own brief under ` +
        `"The guardian poke"; if it does not match what your brief says, trust your brief and say ` +
        `so on your ticket. Declining is recorded as a non-answer and not as a fault.`);
}
/**
 * Poke the guardian once, or say why it could not be poked.
 *
 * Never throws: it is fired from a timer with nobody to catch it.
 */
export function runGuardianPoke(opts) {
    const { world } = opts;
    const startedAt = world.now();
    const done = (outcome, detail, extra = {}) => {
        const result = {
            outcome,
            delivered: outcome === 'delivered',
            address: extra.address ?? null,
            connectionId: extra.connectionId ?? null,
            // DERIVED FROM THE OUTCOME, never passed in. A carrier that could be
            // supplied by a call site is one that can disagree with what happened.
            transport: outcome === 'delivered' ? 'channel' : 'undelivered',
            interrupted: false,
            reason: extra.reason ?? null,
            startedAt: new Date(startedAt).toISOString(),
            elapsedMs: world.now() - startedAt,
            detail
        };
        // LOUD FOR THE LOUD CASE (AC3). An undelivered poke means nothing is
        // watching the fleet, and it must not read like the line above it in the
        // log. A quiet success is one line at the ordinary level; a refusal names
        // itself in capitals, because the reader who finds this is grepping a log
        // at the moment they have noticed the fleet has gone quiet.
        world.log(outcome === 'undelivered'
            ? `[Guardian] POKE UNDELIVERED to ${result.address ? describeAddress(result.address) : 'nobody'}` +
                ` (${result.reason ?? 'no reason given'}) — ${detail}`
            : `[Guardian] ${result.address ? describeAddress(result.address) : 'no guardian'}: ` +
                `${outcome} — ${detail}`);
        return result;
    };
    // THE SWITCH FIRST, through the same reader every other caller uses, and
    // before the config is read. A fleet that has switched channels off has no
    // carrier for a poke, and writing through a shut gate would be this module
    // holding its own opinion about the kill switch.
    if (!world.emissionEnabled()) {
        return done('channel-disabled', 'channel emission is switched off fleet-wide, so there is no carrier for a poke and ' +
            'nothing was written to anybody. NOTHING IS SUPERVISING THE FLEET ON A TIMER while ' +
            'this is the case');
    }
    const config = world.readConfig();
    if (!config.address) {
        return done('no-guardian', 'no guardian is configured, so nothing was poked. This is not an error — it is the ' +
            'default state — and it does mean nothing is watching the fleet on a timer. Set one ' +
            'from the Butchr options page or with butchr_guardian');
    }
    const address = config.address;
    const intervalMs = config.intervalMs ?? DEFAULT_POKE_INTERVAL_MS;
    const message = composePokeMessage({ address, intervalMs, pokeNumber: opts.pokeNumber });
    const route = world.send(address, message);
    if (!route.routed) {
        // NOT RETRIED ON THE COMPOSER AND NOT HELD FOR LATER — both are the point
        // rather than omissions, and both are argued in the module header. The
        // composer would Ctrl+C the guardian; the queue would turn the loudest
        // state in this feature into `pending`, which reads as fine.
        return done('undelivered', `the poke was refused for ${describeAddress(address)} (${route.reason ?? 'no reason given'}): ` +
            `${route.detail ?? 'no detail'}. NOTHING WAS DELIVERED, so the guardian has not been asked ` +
            `to sweep and the fleet is unsupervised until a later poke lands. It was not retried on ` +
            `the composer, which would have destroyed whatever tool call it is running, and it was ` +
            `not held for redelivery, because a poke delivered late says "sweep now" at a moment ` +
            `nobody chose. The next one is ${Math.round(intervalMs / 60000)} minutes away`, { address, reason: route.reason ?? 'unknown' });
    }
    return done('delivered', `a poke was written to ${describeAddress(address)}'s channel connection ` +
        `(${route.connectionId ?? 'unknown'}). THAT IS C1 AND C2 AND NOTHING MORE: the frame ` +
        `reached a live connection. Whether a model read it, whether it swept, and whether the ` +
        `sweep was right are three further questions and none of them is answered here`, { address, connectionId: route.connectionId ?? null });
}
/** The sentence every surface renders verbatim. One copy, here. */
export const PROVES_DETAIL = 'This records whether the poke was delivered, not whether the fleet is being supervised. ' +
    'A heartbeat proves the loop turns; it says nothing about whether its decisions are right.';
/**
 * Every poke this daemon has made, and the only thing that reads them.
 *
 * In memory rather than on disk, for `ChannelLivenessRecord`'s reason: a
 * delivery is a fact about a connection that was live at the time, and a daemon
 * that restarts has no connections to have delivered anything to. A persisted
 * `lastDelivered` would be the artefact this codebase keeps paying for — a
 * stored fact that outlives what it described and reads as current.
 *
 * **The cost is stated rather than hidden**: a daemon that restarts more often
 * than {@link OVERDUE_INTERVALS} intervals never reports `overdue`, so a machine
 * in a restart loop looks the same as a healthy one *on this field*. The
 * configured guardian itself is on disk and survives, which is why "no guardian
 * configured" is the one state that cannot be lost by a restart.
 */
export class GuardianRecord {
    opts;
    pokeList = [];
    lastDeliveredResult = null;
    undelivered = 0;
    total = 0;
    constructor(opts) {
        this.opts = opts;
    }
    record(result) {
        this.total += 1;
        this.pokeList.push(result);
        if (this.pokeList.length > RECENT_LIMIT)
            this.pokeList.shift();
        if (result.outcome === 'delivered') {
            this.lastDeliveredResult = result;
            this.undelivered = 0;
            return;
        }
        // ONLY A POKE THAT WAS ACTUALLY ATTEMPTED COUNTS AS UNDELIVERED. `no-guardian`
        // is not a delivery failure — nobody was asked — and counting it would let an
        // unconfigured machine manufacture an alarm about an agent that does not
        // exist. `channel-disabled` is a decided state that is already reported
        // everywhere, and is likewise not this counter's business.
        if (result.outcome === 'undelivered')
            this.undelivered += 1;
    }
    /** How many pokes have been made. The poke message numbers itself from this. */
    count() {
        return this.total;
    }
    state() {
        const config = this.opts.readConfig();
        const intervalMs = config.intervalMs ?? DEFAULT_POKE_INTERVAL_MS;
        const sinceLastDeliveryMs = this.lastDeliveredResult
            ? this.opts.now() - Date.parse(this.lastDeliveredResult.startedAt)
            : null;
        // OVERDUE IS ONLY MEANINGFUL WHERE A POKE WAS EXPECTED. With no guardian
        // configured there is no schedule to be late for, and reporting `overdue`
        // there would be an alarm about an agent nobody named. The honest reading of
        // "no guardian" is `configured: false`, which is louder than `overdue` and
        // is what the board renders.
        const overdue = config.address !== null &&
            (this.lastDeliveredResult === null
                ? this.undelivered >= OVERDUE_INTERVALS
                : (sinceLastDeliveryMs ?? 0) > intervalMs * OVERDUE_INTERVALS);
        return {
            address: config.address,
            configured: config.address !== null,
            intervalMs,
            setBy: config.setBy,
            setAt: config.setAt,
            lastPoke: this.pokeList.length ? this.pokeList[this.pokeList.length - 1] : null,
            lastDelivered: this.lastDeliveredResult,
            sinceLastDeliveryMs,
            consecutiveUndelivered: this.undelivered,
            overdue,
            pokes: this.total,
            recent: this.pokeList.map((p) => ({
                outcome: p.outcome,
                startedAt: p.startedAt,
                reason: p.reason
            })),
            proves: 'delivery',
            provesDetail: PROVES_DETAIL,
            detail: this.describe(config, intervalMs, overdue, sinceLastDeliveryMs)
        };
    }
    describe(config, intervalMs, overdue, sinceLastDeliveryMs) {
        if (!config.address) {
            return ('NO GUARDIAN IS SET, so nothing is watching this fleet on a timer. That is the default ' +
                'state rather than a fault — and it is the state in which a fleet goes quiet without ' +
                'anybody being told. Set one from the Butchr options page or with butchr_guardian.');
        }
        const who = describeAddress(config.address);
        const mins = Math.round(intervalMs / 60000);
        if (this.total === 0) {
            return (`${who} is the guardian and is poked every ${mins} minutes. No poke has been sent yet on ` +
                `this daemon — the first is minutes rather than one full interval after start-up — so ` +
                `nothing is yet known about whether it is reachable.`);
        }
        if (overdue) {
            return (`NO POKE HAS REACHED ${who.toUpperCase()} IN ${this.undelivered} ATTEMPT(S)` +
                (sinceLastDeliveryMs === null
                    ? ', and none ever has on this daemon. '
                    : `, and the last one that landed was ${Math.round(sinceLastDeliveryMs / 60000)} minutes ` +
                        `ago. `) +
                `The guardian is not being asked to sweep, so THE FLEET IS UNSUPERVISED and will stay ` +
                `that way until a poke lands. Most often the agent is not running, or its channel ` +
                `registration was dropped by a restart and it has not re-registered. Go and look: ` +
                `butchr_list_agents shows whether ${who} is up and what its transport is. ` +
                `${this.lastDeliveredResult ? '' : 'Nothing here is evidence about the guardian itself — ' +
                    'a poke that was never delivered says nothing about the agent it was addressed to. '}` +
                `Last refusal: ${this.pokeList[this.pokeList.length - 1]?.reason ?? 'not recorded'}.`);
        }
        if (this.lastDeliveredResult) {
            return (`a poke last reached ${who} at ${this.lastDeliveredResult.startedAt}` +
                (sinceLastDeliveryMs !== null
                    ? ` (${Math.round(sinceLastDeliveryMs / 60000)} minutes ago)`
                    : '') +
                `, on a ${mins}-minute timer. ` +
                (this.undelivered > 0
                    ? `${this.undelivered} poke(s) since have not been delivered. `
                    : '') +
                PROVES_DETAIL);
        }
        return (`${this.total} poke(s) to ${who}, none of which has been delivered yet. ` +
            `${this.undelivered} was/were refused by the channel. Nothing is concluded about the ` +
            `guardian's own health from this — a frame that was never written says nothing about the ` +
            `agent it was addressed to.`);
    }
}
/**
 * The schedule. One guardian, every interval, and never two pokes at once.
 *
 * Schedules its own next tick rather than running on a fixed interval, for the
 * reason `JiraPoller`, `BoardReconciler` and `ChannelLivenessProbe` all do — and
 * here it has a second job: **the interval is read from the config on every
 * tick**, so changing it from the options page takes effect at the next poke
 * rather than at the next daemon restart. A `setInterval` captured at boot would
 * make the one setting this feature has require the one action that drops every
 * channel registration in the fleet.
 */
export class GuardianPoker {
    opts;
    timer = null;
    stopped = false;
    running = false;
    rec;
    constructor(opts) {
        this.opts = opts;
        this.rec =
            opts.record ??
                new GuardianRecord({ readConfig: opts.world.readConfig, now: opts.world.now });
    }
    /** The interval in force right now, read fresh. See the class header. */
    currentIntervalMs() {
        if (this.opts.intervalMs !== undefined)
            return this.opts.intervalMs;
        return this.opts.world.readConfig().intervalMs ?? DEFAULT_POKE_INTERVAL_MS;
    }
    start() {
        if (this.timer || this.stopped)
            return;
        const config = this.opts.world.readConfig();
        this.opts.world.log(`[Guardian] the supervision poke is on: ` +
            (config.address
                ? `${describeAddress(config.address)} every ` +
                    `${Math.round(this.currentIntervalMs() / 60000)} minutes`
                : 'no guardian is set, so nothing will be poked until one is') +
            `, first poke in ${Math.round(this.firstDelayMs() / 60000)} minutes. ` +
            `It carries the daemon's clock to the agent that supervises this fleet (KAN-284), over ` +
            `the channel only. A poke that is not delivered is reported as undelivered and is not ` +
            `held for later.`);
        this.schedule(this.firstDelayMs());
    }
    firstDelayMs() {
        return this.opts.firstPokeDelayMs ?? DEFAULT_FIRST_POKE_DELAY_MS;
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    /** The record, for `list_agents`, the board page and a diagnostic reader. */
    state() {
        return this.rec.state();
    }
    isRunning() {
        return this.running;
    }
    /**
     * Poke once now, off the schedule.
     *
     * The `guardian` daemon action calls this so a proof — and anybody
     * investigating an overdue guardian — can exercise **the shipped mechanism**
     * rather than waiting thirty minutes for it. It is the same code path the
     * timer takes, which is the only reason it is allowed to exist (KAN-145).
     */
    pokeOnce() {
        if (this.running) {
            return {
                outcome: 'already-running',
                delivered: false,
                address: null,
                connectionId: null,
                transport: 'undelivered',
                interrupted: false,
                reason: 'already-running',
                startedAt: new Date(this.opts.world.now()).toISOString(),
                elapsedMs: 0,
                detail: 'a poke is already in flight; this request was not started rather than run alongside ' +
                    'it. It is not recorded, because it describes a request rather than a poke — counting ' +
                    'it would let a caller that polls invent an overdue guardian'
            };
        }
        this.running = true;
        try {
            const result = runGuardianPoke({
                world: this.opts.world,
                pokeNumber: this.rec.count() + 1
            });
            this.rec.record(result);
            const state = this.rec.state();
            if (state.overdue) {
                // Beside the verdict rather than only in a listing, for the reason
                // `ChannelLivenessProbe` logs its drought: this is found by somebody
                // reading a log because the fleet has gone quiet.
                this.opts.world.log(`[Guardian] ${state.detail}`);
            }
            return result;
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
            try {
                this.pokeOnce();
            }
            catch (e) {
                // Cannot happen — `runGuardianPoke` promises not to throw — and is
                // caught because an unhandled throw here would take the daemon down,
                // and the fleet with it, over a poke.
                this.opts.world.log(`[Guardian] poke failed unexpectedly: ${e?.message ?? String(e)}`);
            }
            this.schedule(this.currentIntervalMs());
        }, wait);
        // Unref'd like every other daemon timer: a poke must not be the thing
        // keeping a shutting-down process alive.
        this.timer.unref?.();
    }
}
