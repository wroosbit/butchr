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

/** How a message was carried. Named in every response; never chosen by a sender. */
export type Transport = 'channel' | 'composer';

/** The four claims of design §2, in the spelling a response uses. */
export type ClaimName =
  | 'transportAccepted'
  | 'sessionPresent'
  | 'enteredTranscript'
  | 'modelRead';

/** Why a claim is `null`. See the module comment: these age differently. */
export type ClaimSilence = 'not-observable-on-this-transport' | 'not-measured-by-this-path';

/** What a caller may say about one claim: a measurement, or an admission. */
export type Observation = boolean | 'not-measured';

/** One claim, as it appears in a response. */
export interface ClaimReport {
  /** §2's own label, so a reader can find the row in the design. */
  id: 'C1' | 'C2' | 'C3' | 'C4';
  /** The claim in words, phrased so it can be quoted without the table. */
  statement: string;
  /** `true`/`false` are measurements; `null` is silence — see `why`. */
  value: boolean | null;
  /** Present exactly when `value` is `null`. */
  why?: ClaimSilence;
  /** What established it, or what would have to. */
  basis: string;
}

export type ClaimBlock = Record<ClaimName, ClaimReport>;

/** Thrown when a response tries to assert more than its transport measured. */
export class OverClaimError extends Error {
  constructor(
    public readonly transport: Transport,
    public readonly claim: ClaimName,
    public readonly asserted: boolean
  ) {
    super(
      `over-claim refused: the ${transport} transport cannot establish ` +
        `${claim} (${CLAIMS[claim].id}), and this response asserted ${asserted}. ` +
        `${CLAIMS[claim].unobservable[transport] ?? ''}`
    );
    this.name = 'OverClaimError';
  }
}

/** The four claims, their §2 label and their wording. */
const CLAIMS: Record<
  ClaimName,
  {
    id: ClaimReport['id'];
    statement: string;
    /** Per transport: why this claim is unobservable there, or `null` if it is observable. */
    unobservable: Record<Transport, string | null>;
  }
> = {
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
      channel:
        'A channel frame never reaches a pane, and §2 forbids pane-scraping as a channel health check.',
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
      channel:
        'C4 needs an application-level ack — the recipient calling a reply tool. That tool is T6 and is not built.',
      composer:
        'The composer has never been able to establish C4; `deliverToAgent` polls a pane, which is C3.'
    }
  }
};

/** Whether a transport is capable of establishing a claim at all. */
export function isClaimable(transport: Transport, claim: ClaimName): boolean {
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
export function sealClaims(
  transport: Transport,
  observed: Record<ClaimName, Observation>,
  bases: Record<ClaimName, string>
): ClaimBlock {
  const out = {} as ClaimBlock;

  for (const claim of Object.keys(CLAIMS) as ClaimName[]) {
    if (!(claim in observed)) {
      throw new Error(
        `sealClaims: no observation given for ${claim} (${CLAIMS[claim].id}). ` +
          "Every claim must be named — say 'not-measured' rather than omitting it."
      );
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
              : (CLAIMS[claim].unobservable[transport] as string)
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
export function licenceFor(transport: Transport, claims: ClaimBlock): string {
  const may = (Object.keys(claims) as ClaimName[]).filter((c) => claims[c].value === true);
  const mayNot = (Object.keys(claims) as ClaimName[]).filter((c) => claims[c].value !== true);

  const list = (names: ClaimName[]) =>
    names.map((c) => `${claims[c].statement} (${claims[c].id})`).join('; ') || 'nothing';

  return (
    `Carried over the ${transport}. ` +
    `You may state: ${list(may)}. ` +
    `You may NOT state: ${list(mayNot)} — ` +
    'a claim with a null value was not measured here, and silence is not a negative.'
  );
}
