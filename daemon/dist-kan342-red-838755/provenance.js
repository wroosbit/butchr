/**
 * ---------------------------------------------------------------------------
 * Whose voice is this? — provenance for everything Butchr types at an agent.
 * ---------------------------------------------------------------------------
 *
 * KAN-149. Butchr delivers messages by typing them into the target's composer
 * and pressing Enter, which means a nudge from another agent arrives looking
 * *exactly* like the human at the keyboard. There is no channel to read a sender
 * off, because the channel is a keyboard.
 *
 * Two failure modes came out of that, both observed:
 *
 *   1. **Misattributed interrupt.** A nudge from `task/KAN-146` landed
 *      mid-tool-call on `epic/KAN-39`; the interrupt rendered as a rejection,
 *      the epic agent read the rejection as the human's, and told the human they
 *      had declined something they had never seen.
 *   2. **Misattributed authority**, which is the serious one. An agent that
 *      cannot tell a peer's nudge from the human's instruction can be told
 *      "the human decided X" and act on it as though the human had spoken. This
 *      board runs on the human's decisions being authoritative and traceable,
 *      and all of that assumes the reader knows whose voice it is hearing.
 *
 * WHAT THIS MODULE IS
 *
 * The one place the tag vocabulary is written down, so the daemon's own notices,
 * the router's agent-to-agent path, the prompts that teach the convention and
 * the script that proves it cannot drift apart. Two tags, one rule:
 *
 *   `[butchr daemon] …`      the daemon speaking for itself — a supervision
 *                            notice, a Jira-poll pointer, a resume nudge.
 *   `[from story/KAN-75] …`  another agent, named by the workspace identity the
 *                            daemon read off the caller's own MCP process.
 *
 * **The rule, in one sentence: every message Butchr injects begins with a
 * bracketed tag, so an untagged message is one nobody injected — the human,
 * typing.** That is what turns "unmarked means the human" from an assumption
 * into something this side of the system actually enforces.
 *
 * WHAT THIS IS NOT: AUTHENTICATION
 *
 * Stated here and stated again in every prompt, because a marker trusted more
 * than it deserves is worse than no marker at all. The tag is a *convention*:
 *
 *   * An agent can type `[from epic/KAN-39]` into a message body itself. The
 *     daemon's tag is always the **leading** one — see {@link withSenderTag} —
 *     so the impersonation shows up as a second tag rather than replacing the
 *     first, but nothing stops the text from being there.
 *   * A human typing directly into a pane is untagged, and so is anything else
 *     that reaches the pane without going through the daemon.
 *   * Any process that can reach the daemon's Unix socket can state whatever
 *     identity it likes on the wire. The socket is the trust boundary and it is
 *     an ordinary filesystem permission, not a credential check.
 *
 * So this removes **accident**, not malice, and accident is what has actually
 * been costing us: three misattributed interrupts in two days, none of them
 * anyone's idea of an attack.
 */
/**
 * The daemon speaking for itself.
 *
 * A constant rather than three string literals because it was three string
 * literals: `nudge.ts` and `jira-poll.ts` each spelled it `[butchr daemon]`
 * while `resume.ts` spelled it `[butchr]`, and nothing would ever have caught
 * a fourth builder inventing a fourth spelling. The prompts teach one token;
 * this is that token.
 */
export const DAEMON_SENDER_TAG = '[butchr daemon]';
/** The tag on a message whose sender the daemon could not identify. */
export const UNIDENTIFIED_SENDER_TAG = '[from an unidentified butchr caller]';
/**
 * The tag for a message injected on behalf of an agent.
 *
 * An identity the daemon does not have yields {@link UNIDENTIFIED_SENDER_TAG}
 * rather than no tag at all, and that choice is the whole of point 4 of the
 * ticket's fix sketch. Falling back to "no tag" would mean an unidentified
 * caller's message is indistinguishable from the human typing — which is the
 * bug — so the honest fallback is to say *that the sender is unknown*, not to
 * fall silent and let the reader assume the human. It is the difference between
 * "unmarked means the human" as an assumption and as a property the daemon
 * maintains: nothing the daemon injects is ever unmarked.
 *
 * A caller with no workspace identity is a real case, not a defect. A human's
 * own Claude Code session calling `butchr_send_to_agent` has no `.mcp.json`
 * workspace flags, and it is a *relay* rather than the human's own voice — so
 * marking it unidentified is more accurate than either alternative.
 */
export function senderTagFor(identity) {
    const type = identity?.type?.trim();
    const key = identity?.key?.trim();
    if (!type || !key)
        return UNIDENTIFIED_SENDER_TAG;
    return `[from ${type}/${key}]`;
}
/**
 * Put the sender's tag in front of a message, leaving the message itself alone.
 *
 * THREE DECISIONS WORTH THE WORDS
 *
 * **The tag leads, and it leads on the same line.** Not cosmetic: the delivery
 * confirmation in nudge.ts fingerprints a message by its first line, capped at
 * sixty characters, and counts how many times that fingerprint appears above
 * the composer. A tag on its own line would make every daemon notice share a
 * fingerprint with every other, and `landedCount` could no longer tell one
 * delivered message from another.
 *
 * **The body is passed through verbatim.** The daemon is a courier here. A body
 * that itself begins `[from epic/KAN-39]` is delivered with both tags visible —
 * `[from task/KAN-149] [from epic/KAN-39] …` — because the leading tag is the
 * one the daemon derived and the second is content an agent typed. Stripping or
 * rewriting the body would be the daemon editing a message it does not
 * understand, and would break the one property that makes the leading tag worth
 * anything: that it is a statement about the *request*, never about the text.
 *
 * **Already-tagged daemon messages are not tagged twice.** The daemon's own
 * builders compose their tag into the sentence they write, because the tag has
 * to be inside the string the delivery check fingerprints. Passing one of those
 * through here is a no-op rather than `[butchr daemon] [butchr daemon] …`.
 */
export function withSenderTag(tag, message) {
    return message.startsWith(tag) ? message : `${tag} ${message}`;
}
/**
 * Whether a delivered message carries the tag of a given sender.
 *
 * Exported for the proof, and deliberately anchored at the start: "contains the
 * tag somewhere" is the assertion that a body claiming a false sender would
 * satisfy, and telling those two apart is the point.
 */
export function hasLeadingTag(message, tag) {
    return message.startsWith(tag);
}
