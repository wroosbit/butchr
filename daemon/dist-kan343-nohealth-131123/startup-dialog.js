/**
 * Which startup dialog a pane is showing — and the one thing that is allowed to
 * answer one.
 *
 * WHY THIS MODULE EXISTS (KAN-340)
 *
 * `superviseChannelStartup` presses Enter at a pane. That is the right thing to
 * do at Claude Code's development-channels warning, which is friction the fleet
 * should never pay a human for, and KAN-246 has been doing it since 2026-08-11.
 * It is a materially wrong thing to do at the **workspace-trust** dialog, which
 * asks whether Claude Code may read, edit and execute files in a directory. The
 * two are answered by the same keystroke and — measured under a real PTY on
 * build 2.1.228, both captures in `verify-startup-dialog-discrimination.mjs` —
 * they present the same affordance, down to the glyph:
 *
 *     ❯ 1. I am using this for local development        ❯ 1. Yes, I trust this folder
 *       2. Exit                                           2. No, exit
 *     Enter to confirm · Esc to cancel                  Enter to confirm · Esc to cancel
 *
 * So nothing about the *shape* of a dialog distinguishes them, and KAN-340 asks
 * for the distinction to be impossible to get wrong **by construction rather
 * than unlikely in practice**. This module is that construction. It has two
 * halves, and they fail differently on purpose.
 *
 * ---------------------------------------------------------------------------
 * HALF ONE: ONLY THE LIVE DIALOG IS CLASSIFIED, AND THAT IS POSITIONAL
 * ---------------------------------------------------------------------------
 *
 * The defect this closes is not a mismatched string. It is that
 * `DEV_CHANNELS_DIALOG_PATTERN` was tested against **the whole 140-line pane
 * read**, so it answered *"is this text anywhere on screen?"* when the question
 * is *"is the box currently waiting for a key the dev-channels one?"*. Those come
 * apart exactly once, and the launcher makes that once reachable: the `||` runs
 * `claude` twice, the first one prints `No conversation found to continue` and
 * exits, and its dialog's text can still be in the window when the second
 * `claude` paints something new. A frame carrying stale dev-channels text above a
 * live trust dialog matched, and the watcher pressed Enter at the trust dialog.
 *
 * The fix is to stop reading the whole frame. A dialog's confirm line is the last
 * thing it paints, so the **live** dialog is the one whose {@link CONFIRM_LINE}
 * is last in the frame, and its body is the text between the previous confirm
 * line and that one. Everything above is scrollback and is not classified at all.
 * That holds for a foreign dialog **nobody has enumerated**, which is what makes
 * it the load-bearing half: it does not depend on this file knowing what else
 * Claude Code can put on screen.
 *
 * ---------------------------------------------------------------------------
 * HALF TWO: AN ENUMERATED FOREIGN DIALOG IN THE LIVE REGION IS AMBIGUOUS
 * ---------------------------------------------------------------------------
 *
 * Belt and braces, in that order — the type is first and the assertion backs it.
 * If the live region somehow carries both dev-channels prose and a known foreign
 * dialog's prose, that is a frame this module does not understand, and the answer
 * is {@link StartupDialogVerdict} `ambiguous` — never a key. Refusing to answer
 * costs an agent that reaches its prompt late and says so loudly in the log;
 * guessing costs a trusted folder. Those are not close.
 *
 * **WHAT THIS LEAVES UNCOVERED, said rather than left to be inferred.**
 * {@link FOREIGN_DIALOGS} lists the dialogs measured on 2.1.228, and a foreign
 * dialog that is not on it is not detected *as foreign*. It is still not
 * answered — with no dev-channels prose in the live region the verdict is `none`
 * — so the uncovered case is narrow and specific: a *future* dialog that quotes
 * the dev-channels wording in its own body would classify `dev-channels`. Nothing
 * here can see that coming, and no list can. What bounds it is that the region is
 * one dialog's body rather than a screenful.
 *
 * ---------------------------------------------------------------------------
 * AND THE KEYSTROKE IS UNREACHABLE WITHOUT A CLASSIFICATION
 * ---------------------------------------------------------------------------
 *
 * {@link DevChannelsConfirmation} is branded with a symbol this module does not
 * export, so it cannot be constructed anywhere else — and
 * {@link ChannelStartupWorld.pressEnter} takes one. A caller that wants to send
 * Enter must have been handed a verdict by {@link classifyStartupDialog} saying
 * the live dialog is the dev-channels one. There is no edit to `channel-startup.ts`
 * that presses a key at an unclassified pane, because there is no way to spell
 * one: it is a compile error rather than a review comment. The runtime assertion
 * is still there too — see the `kind` switch at the call site — for the reason
 * `launchdarkly-proxy.ts` keeps both.
 *
 * This is deliberately NOT a second implementation of "is the channel on?" or of
 * anything else that already has one. It answers a question nobody was asking:
 * *which* dialog is this. See KAN-145 for why a fact with two implementations is
 * worse than an awkward single one.
 */
/**
 * The confirm affordance every one of these dialogs paints as its last line.
 *
 * This is the frame's punctuation rather than any dialog's identity — both
 * measured captures end with it, byte for byte — which is what lets it delimit
 * the live region without this module knowing which dialog it is delimiting.
 *
 * Matched loosely on the separator because it is a `·` in the captures and a
 * separator is the thing most likely to be restyled. `Enter to confirm` alone
 * would be enough today; the tail is here so a restyle degrades to a false
 * negative — an unanswered dialog, logged — rather than to a mismatched region.
 */
const CONFIRM_LINE = /Enter to confirm/g;
/**
 * The development-channels dialog's own prose, as it renders on the pane.
 *
 * Both alternatives are strings from Claude Code's `DevChannelsDialog` — the
 * panel title and the confirm-option label — carried forward from
 * `channel-startup.ts`, where they were matched against a real pane by KAN-217
 * and re-read out of the binary at 2.1.226. They are re-measured at 2.1.228 in
 * `verify-startup-dialog-discrimination.mjs` from a PTY capture rather than
 * trusted across a version bump.
 *
 * **Deliberately not matching the bare flag name.**
 * `--dangerously-load-development-channels` appears in the launch command
 * itself, so a pattern that matched it would fire on any pane that echoed the
 * command line. Every alternative here is prose the dialog renders and the
 * command line does not contain. That reasoning is KAN-246's and is unchanged;
 * it is repeated here because this is now the file that owns the pattern.
 */
const DEV_CHANNELS_MARKERS = /Loading development channels|I am using this for local development/;
/**
 * Dialogs that must never be answered by this daemon, with the prose that names
 * them.
 *
 * A table rather than a disjunction so that the log can say *which* one it
 * refused to answer: an operator reading `refused — workspace-trust` is sent
 * somewhere completely different from one reading `refused — bypass-permissions`,
 * and a bare "some other dialog" would cost them that distance.
 *
 * **`workspace-trust` is the one that motivates the file and the one that is
 * measured.** Its markers are three independent phrases from the capture in the
 * verify script; any one of them is enough, and three are listed because a
 * restyle that changes all three is a different dialog anyway.
 *
 * `bypass-permissions` is listed on the strength of the binary carrying
 * `bypassPermissionsModeAccepted` and of the launcher passing
 * `--permission-mode bypassPermissions` on every spawn, **not** on a PTY capture
 * — it is suppressed on this machine by that setting having been accepted, so it
 * could not be raised to be measured. Marked as such rather than presented as
 * measured: it is a guess about wording, it costs nothing if wrong, and it must
 * not be read as evidence.
 */
const FOREIGN_DIALOGS = [
    {
        name: 'workspace-trust',
        markers: /Yes, I trust this folder|Quick safety check|Accessing workspace:/,
        measured: true
    },
    {
        name: 'bypass-permissions',
        markers: /Bypass Permissions mode|accept edits and run commands without asking/i,
        measured: false
    }
];
/**
 * The brand that makes a confirmation unforgeable outside this module.
 *
 * Not exported, and that is the entire mechanism: a `unique symbol` no other
 * file can name is a property no other file can set, so
 * {@link DevChannelsConfirmation} has exactly one producer —
 * {@link classifyStartupDialog} — however many consumers it grows.
 */
const CONFIRMED_DEV_CHANNELS = Symbol('butchr.dev-channels-confirmation');
/**
 * The body of the dialog currently waiting for a key, or `null` if none is.
 *
 * The region runs from just after the second-to-last confirm line to the end of
 * the frame — i.e. the last complete dialog painted. Anything before that has
 * been superseded, whether it was superseded a millisecond ago or is genuine
 * scrollback from a `claude` that has already exited.
 *
 * Exported for the verify script, which asserts on the region directly as well as
 * on the verdict: a region computed wrongly and a marker matched wrongly produce
 * the same verdict, and only separating them says which one a red is about.
 */
export function liveDialogRegion(pane) {
    CONFIRM_LINE.lastIndex = 0;
    const ends = [];
    for (let m = CONFIRM_LINE.exec(pane); m !== null; m = CONFIRM_LINE.exec(pane)) {
        ends.push(m.index);
    }
    if (ends.length === 0)
        return null;
    // From the previous dialog's confirm line (exclusive) to the end of the frame.
    // `ends[ends.length - 2]` is `undefined` for a single dialog, and `slice(0)`
    // is then the whole frame — correct, and the reason this is not an `if`.
    const start = ends.length >= 2 ? ends[ends.length - 2] + 'Enter to confirm'.length : 0;
    return pane.slice(start);
}
function identifyDialogs(region) {
    const found = [];
    const devMatch = DEV_CHANNELS_MARKERS.exec(region);
    if (devMatch)
        found.push({ name: 'dev-channels', evidence: devMatch[0] });
    for (const d of FOREIGN_DIALOGS) {
        if (d.markers.test(region))
            found.push({ name: d.name, measured: d.measured });
    }
    if (found.length === 0)
        return { count: 'none' };
    if (found.length === 1)
        return { count: 'one', dialog: found[0] };
    return { count: 'many', dialogs: found };
}
/** Unreachable-by-type marker; see the `switch` below. */
function assertNever(value) {
    throw new Error(`unreachable dialog count: ${JSON.stringify(value)}`);
}
/**
 * Classify the dialog a pane is currently waiting on.
 *
 * Total: every string maps to a verdict, and the only verdict carrying
 * permission to press a key is `dev-channels`. Never throws for any pane — the
 * `assertNever` below is unreachable while {@link DialogCount} has three arms,
 * and exists so that adding a fourth is a compile error rather than a silent
 * fall-through.
 */
export function classifyStartupDialog(pane) {
    const region = liveDialogRegion(pane);
    if (region === null) {
        // No confirm line anywhere. If our own prose is nonetheless on the pane,
        // that is the one case this file can get wrong in the wedging direction, and
        // it says so rather than answering `none`. See StartupDialogVerdict.
        return DEV_CHANNELS_MARKERS.test(pane) ? { kind: 'undelimited' } : { kind: 'none' };
    }
    const identified = identifyDialogs(region);
    switch (identified.count) {
        case 'none':
            return { kind: 'none' };
        case 'one': {
            const dialog = identified.dialog;
            // The one place a confirmation is minted, reached only when exactly one
            // dialog is named and it is ours.
            return 'evidence' in dialog
                ? {
                    kind: 'dev-channels',
                    confirmation: { [CONFIRMED_DEV_CHANNELS]: true, evidence: dialog.evidence }
                }
                : { kind: 'foreign', dialog: dialog.name, measured: dialog.measured };
        }
        // MORE THAN ONE DIALOG NAMED IN ONE REGION IS A FRAME THIS MODULE DOES NOT
        // UNDERSTAND, and the answer is no keystroke. Refusing costs an agent that
        // reaches its prompt late and says so in the log; guessing costs a trusted
        // folder. This arm is not an optimisation and must not be collapsed into
        // `foreign` — see DialogCount for why it is a case and not a guard.
        case 'many':
            return { kind: 'ambiguous', dialogs: identified.dialogs.map((d) => d.name) };
        default:
            return assertNever(identified);
    }
}
