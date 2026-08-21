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
 *
 * ---------------------------------------------------------------------------
 * AND SINCE KAN-543 IT ALSO OWNS "IS THIS PANE AT A PROMPT", FOR BOTH READERS
 * ---------------------------------------------------------------------------
 *
 * That question used to have two implementations in two files, and they
 * disagreed — the KAN-145 shape, in the file whose header cites KAN-145.
 * `channel-startup.ts` tested {@link SESSION_PROMPT_PATTERN} and would not accept
 * a bare caret; `nudge.ts` kept its own `AGENT_READY_MARKERS` list and would.
 * The caret is what a *dialog* paints over its selected option, so the loose
 * definition called a pane at the development-channels dialog READY and a nudge
 * was typed at it. See {@link frameShowsInputLine} for the whole of that story.
 *
 * Both definitions live here now, adjacent, and both take a
 * {@link DialogFreeFrame} — a value only {@link classifyStartupDialog} can mint,
 * and only for a frame with no dialog waiting for a key on it. So the ordering
 * that was forgotten is no longer possible to forget: there is no way to spell a
 * prompt test against an unclassified pane, exactly as there is no way to spell a
 * keystroke at one. Same construction, second question.
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
const FOREIGN_DIALOGS: ReadonlyArray<{ name: string; markers: RegExp; measured: boolean }> = [
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
const CONFIRMED_DEV_CHANNELS: unique symbol = Symbol('butchr.dev-channels-confirmation');

/**
 * Permission to press Enter at one specific pane frame.
 *
 * Carries the text that earned it so the log can quote the evidence rather than
 * assert the conclusion — the difference between *"answering the dialog"* and
 * *"answering the dialog, matched on `Loading development channels`"* is the
 * whole of what a reader needs to check this was right.
 */
export interface DevChannelsConfirmation {
  readonly [CONFIRMED_DEV_CHANNELS]: true;
  /** The matched prose, for the log line that records the keystroke. */
  readonly evidence: string;
}

/**
 * The brand that makes "no dialog is waiting for a key on this frame" unforgeable
 * outside this module.
 *
 * The same mechanism as {@link CONFIRMED_DEV_CHANNELS} above and for the same
 * reason: a `unique symbol` no other file can name is a property no other file
 * can set, so {@link DialogFreeFrame} has exactly one producer — the `none` arm
 * of {@link classifyStartupDialog} — however many consumers it grows.
 */
const NO_LIVE_DIALOG: unique symbol = Symbol('butchr.no-live-dialog');

/**
 * A pane frame that has been classified and carries no live dialog.
 *
 * Permission to ask the *second* question about a pane — whether it is at a
 * prompt — and the reason that permission has to be carried by a value rather
 * than remembered by a caller is KAN-543. `nudge.ts` asked the second question
 * without asking the first, matched the caret a dialog paints over its selected
 * option, and called a pane at the development-channels dialog READY.
 *
 * Carries the pane text so the predicates below have something to test; that the
 * text is only reachable through a classification is the whole point.
 */
export interface DialogFreeFrame {
  readonly [NO_LIVE_DIALOG]: true;
  /** The frame that classified `none`. */
  readonly pane: string;
}

/**
 * A Claude Code session sitting at its prompt, as it appears on the pane.
 *
 * The status line under the composer, which is present for as long as the session
 * is and absent while it is booting, showing a dialog, or exiting. These are the
 * alternatives KAN-217's probe used as its own readiness pattern.
 *
 * **A false negative here is loud and a false positive is silent**, which is the
 * right way round: if Claude Code restyles this line, every channel-enabled
 * activation reports `no-prompt` and says so in the log, rather than quietly
 * declaring ready over a session that is not there.
 *
 * Moved here from `channel-startup.ts` by KAN-543 so that it and the caret sit in
 * one file rather than in two that disagreed. Nothing outside this module tests
 * it directly — {@link frameShowsLiveSession} and {@link frameShowsInputLine} are
 * what callers reach for, because those take a {@link DialogFreeFrame}.
 */
const SESSION_PROMPT_PATTERN = /for shortcuts|[Bb]ypass(?:ing)? [Pp]ermissions/;

/**
 * The prompt caret, which is the loose half of the readiness question.
 *
 * **This glyph is not evidence of a prompt on its own, and that is the finding
 * KAN-543 exists for.** Every dialog in this file paints it over its selected
 * option — `❯ 1. I am using this for local development`, `❯ 1. Yes, I trust this
 * folder` — so a matcher that accepted it without first asking what the pane was
 * showing returned READY for a box waiting on a keystroke. It is kept rather than
 * deleted because a narrow pane can show the composer's caret with the status
 * footer wrapped off the read, and losing that costs a nudge to an agent that is
 * genuinely idle. What changed is that it is now only ever tested behind a
 * {@link DialogFreeFrame}.
 */
const PROMPT_CARET = '❯';

/**
 * ---------------------------------------------------------------------------
 * TWO READINESS DEFINITIONS, ADJACENT, WITH THE DIFFERENCE STATED (KAN-543 AC4)
 * ---------------------------------------------------------------------------
 *
 * They are not a strict and a sloppy version of one question. They answer two
 * different questions, and the answers are allowed to differ:
 *
 * * {@link frameShowsLiveSession} — *is a Claude Code session up on this pane?*
 *   Asked by `channel-startup.ts` to decide whether an activation may be reported
 *   `ready`. Getting it wrong in the yes direction declares a channel usable over
 *   a session that is seconds from exiting, and nothing downstream re-checks. So
 *   it takes the footer and nothing else.
 *
 * * {@link frameShowsInputLine} — *is there an input line here to type at?*
 *   Asked by `nudge.ts` to decide whether typing is safe. Getting it wrong in the
 *   NO direction costs one nudge and logs loudly; a narrow pane whose footer has
 *   wrapped off the tail is a real frame, and it is the case the caret is kept
 *   for. So it takes the footer OR the caret.
 *
 * Both are gated on the same thing — a {@link DialogFreeFrame} — and that gate is
 * the half that was missing rather than the patterns. The caret was never the
 * defect; asking about the caret before asking what the pane was showing was.
 */

/** Whether a dialog-free frame shows a live session's status footer. */
export function frameShowsLiveSession(frame: DialogFreeFrame): boolean {
  return SESSION_PROMPT_PATTERN.test(frame.pane);
}

/** Whether a dialog-free frame shows an input line — the footer, or a caret. */
export function frameShowsInputLine(frame: DialogFreeFrame): boolean {
  return frameShowsLiveSession(frame) || frame.pane.includes(PROMPT_CARET);
}

/**
 * What the live dialog on a pane is.
 *
 * Four cases, and `none` is not `foreign`: a pane with no dialog on it is the
 * ordinary state of a healthy session, while `foreign` is a box actively waiting
 * on a human. The watcher treats both as "do not press a key" and logs them
 * differently, because only one of them is a reason an agent will never reach its
 * prompt.
 */
export type StartupDialogVerdict =
  | { kind: 'dev-channels'; confirmation: DevChannelsConfirmation }
  | { kind: 'foreign'; dialog: string; measured: boolean }
  | { kind: 'ambiguous'; dialogs: readonly string[] }
  /**
   * Our prose is on the pane and no confirm line delimits it, so which dialog
   * is *live* cannot be decided — and a key is not pressed.
   *
   * **THIS IS THE FALSE NEGATIVE OF THE POSITIONAL GUARD, AND IT IS NAMED
   * RATHER THAN FOLDED INTO `none` FOR ONE REASON: `none` IS SILENT.** The
   * narrowing in this file can only fail in this direction — it refuses where
   * the old whole-frame match would have answered — and the cost of refusing is
   * the brick KAN-246 exists to prevent, an agent that never reaches its
   * prompt. That is the right way round (a false negative here is loud, a false
   * positive grants a folder) but only if somebody is told, so this verdict
   * exists to carry a specific sentence into the log instead of a shrug.
   *
   * Reachable two ways, and the caller treats them the same because it cannot
   * tell them apart from one frame: a dialog caught **mid-paint**, where the
   * confirm line has not been written yet and the next poll will have it; and
   * Claude Code **restyling** `Enter to confirm`, where no poll ever will and
   * every channel-enabled agent wedges until this file is updated. So the
   * watcher keeps polling rather than giving up on the first frame, and the
   * deadline is what separates them.
   */
  | { kind: 'undelimited' }
  /**
   * Nothing is waiting for a key on this frame — the ordinary state of a healthy
   * session, and of a pane that is still booting.
   *
   * **It carries the frame, and that is what makes the prompt test reachable
   * (KAN-543).** This arm is the only producer of a {@link DialogFreeFrame}, so
   * `frame` here is the sole route by which any caller can get a pane text into
   * {@link frameShowsLiveSession} or {@link frameShowsInputLine}. A caller that
   * wants to know whether a pane is at a prompt must first have been told that
   * no dialog is on it.
   */
  | { kind: 'none'; frame: DialogFreeFrame };

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
export function liveDialogRegion(pane: string): string | null {
  CONFIRM_LINE.lastIndex = 0;
  const ends: number[] = [];
  for (let m = CONFIRM_LINE.exec(pane); m !== null; m = CONFIRM_LINE.exec(pane)) {
    ends.push(m.index);
  }
  if (ends.length === 0) return null;
  // From the previous dialog's confirm line (exclusive) to the end of the frame.
  // `ends[ends.length - 2]` is `undefined` for a single dialog, and `slice(0)`
  // is then the whole frame — correct, and the reason this is not an `if`.
  const start = ends.length >= 2 ? ends[ends.length - 2] + 'Enter to confirm'.length : 0;
  return pane.slice(start);
}

/**
 * One dialog whose prose was found in the live region.
 *
 * `dev-channels` carries the matched text because that is what becomes the
 * confirmation's evidence; a foreign dialog carries whether its wording has been
 * measured, because the log line differs.
 */
type IdentifiedDialog =
  | { name: 'dev-channels'; evidence: string }
  | { name: string; measured: boolean };

/**
 * How many distinct dialogs the live region names.
 *
 * **This tagged count is what makes ambiguity a CASE rather than a guard clause,
 * and that distinction is the review requirement it exists to satisfy.** Written
 * as an early `if (dev && foreign) return ambiguous` at the top of the
 * classifier, the ambiguous branch is deletable: strike it out and every
 * remaining path still returns a verdict, so the build stays green and a frame
 * showing two dialogs quietly becomes answerable. Written as the `many` arm of a
 * switch over this union, deleting it is a **compile error** — the function
 * declares `StartupDialogVerdict` and `strict` is on, so a path that returns
 * nothing fails with *"Function lacks ending return statement"*. The compiler
 * holds the case that a reviewer would otherwise have to.
 */
type DialogCount =
  | { count: 'none' }
  | { count: 'one'; dialog: IdentifiedDialog }
  | { count: 'many'; dialogs: readonly IdentifiedDialog[] };

function identifyDialogs(region: string): DialogCount {
  const found: IdentifiedDialog[] = [];

  const devMatch = DEV_CHANNELS_MARKERS.exec(region);
  if (devMatch) found.push({ name: 'dev-channels', evidence: devMatch[0] });
  for (const d of FOREIGN_DIALOGS) {
    if (d.markers.test(region)) found.push({ name: d.name, measured: d.measured });
  }

  if (found.length === 0) return { count: 'none' };
  if (found.length === 1) return { count: 'one', dialog: found[0] };
  return { count: 'many', dialogs: found };
}

/**
 * Mint the permission to ask whether a pane is at a prompt.
 *
 * Private, and called only from the two `none` returns below — which is what
 * makes {@link DialogFreeFrame} mean "classified, and nothing is waiting for a
 * key" rather than "somebody had a string".
 */
function dialogFree(pane: string): DialogFreeFrame {
  return { [NO_LIVE_DIALOG]: true, pane };
}

/** Unreachable-by-type marker; see the `switch` below. */
function assertNever(value: never): never {
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
export function classifyStartupDialog(pane: string): StartupDialogVerdict {
  const region = liveDialogRegion(pane);
  if (region === null) {
    // No confirm line anywhere. If our own prose is nonetheless on the pane,
    // that is the one case this file can get wrong in the wedging direction, and
    // it says so rather than answering `none`. See StartupDialogVerdict.
    return DEV_CHANNELS_MARKERS.test(pane)
      ? { kind: 'undelimited' }
      : { kind: 'none', frame: dialogFree(pane) };
  }

  const identified = identifyDialogs(region);
  switch (identified.count) {
    case 'none':
      return { kind: 'none', frame: dialogFree(pane) };

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
