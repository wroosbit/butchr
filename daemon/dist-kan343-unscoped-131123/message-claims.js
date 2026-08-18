/**
 * What a delivery may claim, and the check that stops it claiming more.
 *
 * WHY THIS MODULE EXISTS (KAN-247, T4 of KAN-150)
 *
 * `docs/channel-messaging-design.md` §2 opens with the sentence this file is
 * built to enforce: *"This is where `success: true` has failed five times on
 * this board."* The story KAN-150 is named for one of those failures — a
 * `success: true` on `butchr_send_to_agent` that meant **typed, and Enter
 * attempted**, and was read by every caller as **the recipient got it**.
 *
 * The obvious way to fix that is to rename the field, and it is the trap. A
 * `delivered: true` that means *handed to a socket* is the identical defect in
 * a word that sounds stronger, which is why KAN-247's description forbids it by
 * name. §2's answer is not a better word but a **refusal to collapse four
 * facts into one**:
 *
 *   C1  the transport accepted the bytes
 *   C2  a live session exists for this recipient
 *   C3  the text entered the session's transcript
 *   C4  the model read it
 *
 * Those are established by different evidence, they fail independently, and
 * they license different actions. CrabCast reached the same conclusion from the
 * other end and their sentence is the one worth carrying (KAN-150 comment
 * 11039, their interface and never their source):
 *
 *   > "a caller that cannot tell 'it did not arrive' from 'I could not see'
 *   > will eventually treat one as the other, and the two license opposite
 *   > actions. Resending on `not-delivered` is right; resending on
 *   > `unverifiable` types a duplicate at an agent that may already be working
 *   > on the first copy."
 *
 * ---------------------------------------------------------------------------
 * THE THREE-VALUED CLAIM, AND WHY `false` AND `null` MUST NOT MERGE
 * ---------------------------------------------------------------------------
 *
 * Every claim here carries `true`, `false`, or `null`, and the last one is the
 * point. `false` is a **measurement** — we looked, and it did not happen.
 * `null` is **silence** — nothing here looked, or nothing here *could* look.
 * A caller that reads silence as a negative resends into an agent that already
 * has the message; a caller that reads it as a positive believes a delivery
 * nobody observed. Both are live failure modes on this board, and a boolean
 * cannot express the difference.
 *
 * `null` is further split by {@link ClaimSilence} into the two reasons a claim
 * can be unestablished, because they age differently:
 *
 *   * `not-observable-on-this-transport` — no future patch to this call site
 *     will fill it in. The channel does not touch a pane, so C3 is not a
 *     measurement this transport is capable of, ever. §2 is explicit that a
 *     channel must **not** be health-checked by scraping the pane: KAN-217
 *     watched the inbound render truncate to pane width and flap YES/NO across
 *     runs while the model received it every time.
 *   * `not-measured-by-this-path` — observable in principle, and this code did
 *     not look. C3 on the composer is exactly this: `deliverToAgent` in
 *     nudge.ts *can* establish it by watching the pane, and `handleSendToAgent`
 *     deliberately does not call it, because that confirmation costs a 20s wait
 *     and a **second Ctrl+C** at a working agent. Recording the omission is how
 *     that trade-off stays visible instead of becoming a claim.
 *
 * A reader can act on the first and file a ticket about the second. Collapsed
 * to one `null`, neither is possible.
 *
 * ---------------------------------------------------------------------------
 * THE SEAL — a check, not a convention
 * ---------------------------------------------------------------------------
 *
 * {@link sealClaims} is the only exported way to build a claim block, and it
 * **throws** rather than corrects when a caller asserts a claim its transport
 * cannot establish. Throwing is deliberate and the alternatives were worse:
 *
 *   * *Silently downgrade to `null`* — the response would be honest and the
 *     bug that produced it would be invisible, which is how a wrong claim
 *     survives to the next refactor.
 *   * *Return an error value* — every call site then owns the decision to check
 *     it, and the one that forgets is the one that ships the over-claim.
 *
 * A throw reaches the daemon's per-request `catch` (daemon.ts) and comes back
 * to the sender as a loud failure. **An over-claim is a bug in Butchr, not a
 * delivery outcome**, and it should read as one.
 *
 * The guard is on {@link CLAIMABLE}, which is a statement about **transports**
 * rather than about call sites — so a future path that acquires a real C4 ack
 * (design §7's T5, the reply tool) changes one table entry and every response
 * follows. Nothing here needs the call sites to be kept in step by hand, which
 * is the KAN-145 defect this codebase has already paid for once.
 *
 * **What the seal does not cover, said plainly.** It cannot stop a caller
 * building a `send_to_agent_response` object by hand and never calling this at
 * all — it guards the constructor, not the wire. What closes that today is that
 * `handleSendToAgent` is the single producer of that response and it is sealed;
 * nothing enforces that a *second* producer would be.
 * WHO COVERS IT: `verify-send-transport-claims.mjs` asserts the property from
 * the outside — it reads the response off a real daemon socket and fails if any
 * claim exceeds its transport — so a hand-built bypass is caught by its output
 * rather than by its construction. That is a weaker guarantee than the throw
 * and it is the one that actually holds for a new call site.
 */
/**
 * THE ONLY ROUTE FROM A PANE OBSERVATION TO C2, AND IT TAKES NOTHING ELSE
 * (KAN-498).
 *
 * C2 — *a live session exists for this recipient* — used to be spelled
 * `result.success === true` at `router.ts`'s composer call site, which is to
 * say it was **the delivery verdict wearing C2's name**. That is how a refusal
 * for a pane the daemon had just typed into came back asserting no session
 * existed.
 *
 * This function's whole job is its signature. It accepts a
 * {@link PaneObservation} and nothing else, so the old spelling no longer
 * type-checks: `boolean` is not assignable to a tagged union, and the compiler
 * refuses it at the call site rather than a reviewer refusing it at the diff.
 * That is the mutation the red drive uses — see
 * `verify-send-claims-not-collapsed.mjs`.
 *
 * ⚠ **`no` and `not-measured` map to different things and must keep doing so.**
 * `no` is a measurement and becomes `false`; `not-measured` is silence and
 * becomes `'not-measured'`, which `sealClaims` renders as `null` with a `why`.
 * Collapsing them would put this module's own three-valued doctrine back into
 * the boolean it exists to escape.
 */
export function claimSessionPresent(pane) {
    switch (pane.reached) {
        case 'typed':
            return true;
        case 'no':
            return false;
        case 'not-measured':
            return 'not-measured';
    }
}
/**
 * C3 from the same observation. A pane that was typed into and **submitted**
 * put the text in the transcript; one that was typed into and not submitted
 * demonstrably did not, and that is a measurement rather than silence — the
 * text is sitting in the composer where anyone can read it.
 *
 * Every other arm is silence: nothing that failed to reach a pane can say
 * anything about a transcript.
 */
export function claimEnteredTranscript(pane) {
    return pane.reached === 'typed' ? pane.submitted : 'not-measured';
}
/**
 * THE COMPOSER'S CLAIM BLOCK, WHICH COMPUTES C2 AND C3 ITSELF AND WILL NOT
 * ACCEPT THEM (KAN-498).
 *
 * ## Why this exists rather than a rule about how to call `sealClaims`
 *
 * The first cut of this fix exported {@link claimSessionPresent} and asked the
 * router to use it. **It was driven red and it did not hold.** `sealClaims`
 * takes `Record<ClaimName, Observation>` and `Observation` includes `boolean`,
 * so putting the old `sessionPresent: result.success === true` straight back
 * compiled cleanly — the helper was available, not required, and a type that
 * merely offers the right answer prevents nothing. Recorded because the
 * mutation is the only reason it was found: a helper that is *used* looks
 * identical, in a diff, to one that is *enforced*.
 *
 * So the composer path does not get to name C2 or C3 at all. There is no
 * parameter for them. The only thing the caller supplies about the pane is the
 * {@link PaneObservation} itself, and a `boolean` is not assignable to that —
 * which is the compile error the red drive now actually gets.
 *
 * ## What the caller still owns
 *
 * C1 and its basis, because "the transport accepted the bytes" has a legitimate
 * non-pane source: a runtime can accept a send without this code seeing a pane.
 * C4 is silence on this carrier and is not a parameter either.
 */
export function sealComposerClaims(args) {
    const { pane } = args;
    return sealClaims('composer', {
        transportAccepted: args.transportAccepted,
        sessionPresent: claimSessionPresent(pane),
        enteredTranscript: claimEnteredTranscript(pane),
        modelRead: 'not-measured'
    }, {
        transportAccepted: args.transportAcceptedBasis,
        sessionPresent: pane.detail,
        enteredTranscript: args.enteredTranscriptBasis ??
            'nothing here read the pane. `butchr_tail_agent` is what shows whether the Enter took; ' +
                'the Enter can be lost and strand the text at the composer (nudge.ts, KAN-79)',
        modelRead: ''
    });
}
/** Thrown when a response tries to assert more than its transport measured. */
export class OverClaimError extends Error {
    transport;
    claim;
    asserted;
    constructor(transport, claim, asserted) {
        super(`over-claim refused: the ${transport} transport cannot establish ` +
            `${claim} (${CLAIMS[claim].id}), and this response asserted ${asserted}. ` +
            `${CLAIMS[claim].unobservable[transport] ?? ''}`);
        this.transport = transport;
        this.claim = claim;
        this.asserted = asserted;
        this.name = 'OverClaimError';
    }
}
/** The four claims, their §2 label and their wording. */
const CLAIMS = {
    transportAccepted: {
        id: 'C1',
        statement: 'the transport accepted the bytes',
        unobservable: { channel: null, composer: null }
    },
    sessionPresent: {
        id: 'C2',
        statement: 'a live session exists for this recipient',
        unobservable: { channel: null, composer: null }
    },
    enteredTranscript: {
        id: 'C3',
        statement: "the text entered the session's transcript",
        unobservable: {
            // §2: the channel never touches the pane, and must not be health-checked
            // by scraping one — KAN-217 measured that reader flapping while the model
            // received every message. There is no other way to see a transcript from
            // here, so this is a property of the carrier and not of this code.
            channel: 'A channel frame never reaches a pane, and §2 forbids pane-scraping as a channel health check.',
            composer: null
        }
    },
    modelRead: {
        id: 'C4',
        statement: 'the model read it',
        unobservable: {
            // §2 says only the channel *can* offer C4 — via an application-level ack,
            // the recipient calling a reply tool. That reply tool is design §7's T6,
            // is not built, and until it is, this is silence on both carriers. When it
            // lands, this entry becomes `null` for `channel` and every response that
            // measures an ack starts reporting it, with no call site edited.
            channel: 'C4 needs an application-level ack — the recipient calling a reply tool. That tool is T6 and is not built.',
            composer: 'The composer has never been able to establish C4; `deliverToAgent` polls a pane, which is C3.'
        }
    }
};
/** Whether a transport is capable of establishing a claim at all. */
export function isClaimable(transport, claim) {
    return CLAIMS[claim].unobservable[transport] === null;
}
/**
 * Build the claim block for a response, refusing anything the transport cannot
 * support.
 *
 * Every claim must be named by the caller — a missing key throws rather than
 * defaulting. Defaulting an unmentioned claim to `null` would be the quiet
 * failure this module exists to prevent: a new claim added to §2 would appear
 * as silence in every existing response, and nothing would say that no author
 * had ever considered it.
 *
 * @throws {OverClaimError} when a boolean is asserted for a claim the transport
 *   cannot establish — the check KAN-247's AC 3 asks for.
 */
export function sealClaims(transport, observed, bases) {
    const out = {};
    for (const claim of Object.keys(CLAIMS)) {
        if (!(claim in observed)) {
            throw new Error(`sealClaims: no observation given for ${claim} (${CLAIMS[claim].id}). ` +
                "Every claim must be named — say 'not-measured' rather than omitting it.");
        }
        const value = observed[claim];
        const claimable = isClaimable(transport, claim);
        if (typeof value === 'boolean' && !claimable) {
            throw new OverClaimError(transport, claim, value);
        }
        out[claim] =
            typeof value === 'boolean'
                ? { id: CLAIMS[claim].id, statement: CLAIMS[claim].statement, value, basis: bases[claim] }
                : {
                    id: CLAIMS[claim].id,
                    statement: CLAIMS[claim].statement,
                    value: null,
                    why: claimable ? 'not-measured-by-this-path' : 'not-observable-on-this-transport',
                    basis: claimable
                        ? bases[claim]
                        : CLAIMS[claim].unobservable[transport]
                };
    }
    return out;
}
/**
 * The one sentence a sender can quote, derived from the block rather than
 * written beside it.
 *
 * Derived, because a hand-written summary is a fifth place for the four claims
 * to disagree — and a prose line saying "delivered" over a block saying `null`
 * is precisely how the collapse comes back. It is generated here so it cannot
 * drift from what was sealed.
 */
export function licenceFor(transport, claims) {
    const may = Object.keys(claims).filter((c) => claims[c].value === true);
    const mayNot = Object.keys(claims).filter((c) => claims[c].value !== true);
    const list = (names) => names.map((c) => `${claims[c].statement} (${claims[c].id})`).join('; ') || 'nothing';
    return (`Carried over the ${transport}. ` +
        `You may state: ${list(may)}. ` +
        `You may NOT state: ${list(mayNot)} — ` +
        'a claim with a null value was not measured here, and silence is not a negative.');
}
