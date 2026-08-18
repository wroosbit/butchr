/**
 * Getting a channel-enabled agent past its own startup, and knowing when it is
 * actually reachable.
 *
 * WHY THIS MODULE EXISTS (KAN-246, T3 of KAN-150)
 *
 * `--dangerously-load-development-channels` buys a channel and charges for it
 * at the worst possible moment. Claude Code raises a **full-screen blocking
 * confirmation before the session starts**, once per `claude` invocation — so
 * **twice** on a fresh workspace, because the launcher's `||` runs `claude`
 * twice there. An unattended client sits on that dialog forever.
 *
 * That is the whole reason this ticket is the riskiest of its set, and the
 * asymmetry is worth stating in one sentence: **every other ticket in KAN-150
 * risks a message not arriving; this one risks an agent never reaching its
 * prompt.** A messaging feature that can brick activation is a worse failure
 * than the one it fixes.
 *
 * So two jobs, and they are one loop because they interleave in time:
 *
 *   1. **Answer the dialog.** Bounded, and only when the dialog's own text is on
 *      the pane. KAN-217's probe established the instrument (`herdr pane
 *      send-keys … Enter`) and the wording to match.
 *   2. **Wait for the SERVER, never for the pane.** §1.4 of
 *      docs/channel-messaging-design.md, from KAN-217's defect 3: the client
 *      spawns its channel server only *after* the dialog clears, so a pane can
 *      look ready seconds before any listener exists, and an event fired into
 *      that window is lost in silence.
 *
 * ---------------------------------------------------------------------------
 * WHAT "READY" IS — THREE CONDITIONS, AND THE THIRD WAS PAID FOR IN A LIVE RUN
 * ---------------------------------------------------------------------------
 *
 * Ready is all three of these, observed in the same pass:
 *
 *   1. **A fresh connection** for this agent's address in KAN-243's identity map
 *      — one registered after the spawn. Not a proxy: it is literally the socket
 *      {@link routeChannelMessage} would write an addressed frame to.
 *   2. **No dialog on the pane.**
 *   3. **The pane at a session prompt.**
 *
 * **CONDITION 3 IS NOT BELT AND BRACES, AND THE FIRST LIVE RUN OF
 * `probe-channel-launch.mjs` IS WHY IT IS HERE.** An earlier version returned on
 * condition 1 alone, and on a fresh workspace it reported ready in six seconds
 * having answered ONE dialog — because `claude --continue` boots far enough to
 * spawn its MCP servers *before* it discovers there is no conversation to
 * continue. Its server registered, this watcher declared victory, that `claude`
 * exited 1, the `||` started the second one, and **the second dialog was raised
 * with nobody left watching for it.** The pane read `No conversation found to
 * continue` and the agent never reached its prompt. That is the exact brick this
 * module exists to prevent, produced by the module itself, and only a live run
 * could have shown it: every deterministic harness supplies its own answer to
 * "has a connection appeared" and would have agreed with the bug.
 *
 * So the pane is consulted — and the design's warning (§1.4: wait for server
 * readiness, **not** the pane) is not being disregarded, it is being read
 * correctly. Its point is that a ready-looking pane is not *sufficient*. Here it
 * is one of three *necessary* conditions, and the server-side one is still what
 * makes the claim about reachability.
 *
 * Three tempting alternatives, each rejected for a measured reason:
 *
 *   **The pane alone.** Defect 3 above, exactly: it can look ready seconds
 *   before any listener exists.
 *
 *   **The `Channels (experimental) …` startup banner.** KAN-217 warns in terms:
 *   it was printed over a *crashed* server. A banner is the client saying it
 *   intends to have a channel, not that it has one.
 *
 *   **A connection that is merely present.** A re-activation finds the previous
 *   session's connection still in the map — close is not ordered against a fresh
 *   connect (see agent-connections.ts, decision 3) — so "there is a connection"
 *   would return true instantly, for the *dead* session, every time an agent was
 *   restarted. Freshness is decided against the spawn timestamp rather than
 *   against a snapshot taken here, because the caller knows when it spawned and
 *   this function does not.
 *
 * **AND WHAT READY IS NOT, WHICH IS THE HONEST EDGE OF THIS FILE.** A registered
 * connection proves the agent's `mcp.js` is up and addressable. It does **not**
 * prove the client registered a *channel* with that server: that handshake is
 * stdio between Claude Code and `mcp.js`, and the daemon is not on it. A client
 * that took the flag, showed the dialog, spawned the server and then declined
 * the channel — for any of the six reasons its dispatcher names, `era` and
 * `policy` among them — looks exactly like success from here. **Who covers it:**
 * nobody yet, by design. KAN-248 (T5) is the per-agent startup self-check whose
 * whole subject is that gap, and `probe-channel-launch.mjs` reads the client's
 * own negotiated capabilities off a teed wire, which is evidence but is a probe
 * run by hand rather than a guard that runs. Said here rather than left for a
 * reader to infer a coverage that does not exist.
 */

import type { AgentAddress, AgentConnectionRegistry } from './agent-connections.js';
import { describeAddress } from './agent-connections.js';
import { CHANNEL_SWITCH_PATH } from './channel.js';
import { classifyStartupDialog, type DevChannelsConfirmation } from './startup-dialog.js';

/**
 * The dialog, as it appears on the pane.
 *
 * **THE MATCH THIS NAMES NOW LIVES IN `startup-dialog.ts`, AND SO DOES THE
 * REASON (KAN-340).** This pattern was tested against the whole 140-line pane
 * read, which answers *"is this text anywhere on screen?"* rather than *"is the
 * box waiting for a key the dev-channels one?"* — and the launcher's `||` makes
 * those come apart, because the first `claude`'s dialog can still be in the
 * window when the second paints a **workspace-trust** dialog over it. Pressing
 * Enter there trusts a folder. See that file for the positional fix and for what
 * it leaves uncovered.
 *
 * It is kept, exported, and no longer consulted by this module, because it is the
 * pattern `probe-channel-launch.mjs` and `docs/channel-launch.md` name by this
 * symbol; deleting it would break a probe to make a point. It remains correct as
 * a description of the dialog's prose — it was never wrong about that, only about
 * where it was allowed to look.
 *
 * @deprecated Use `classifyStartupDialog` — a match here is not permission to
 * press a key, and this cannot tell a live dialog from scrollback.
 */
export const DEV_CHANNELS_DIALOG_PATTERN =
  /Loading development channels|I am using this for local development/;

/**
 * A Claude Code session sitting at its prompt, as it appears on the pane.
 *
 * The status line under the composer, which is present for as long as the
 * session is and absent while it is booting, showing a dialog, or exiting. These
 * are the alternatives KAN-217's probe used as its own readiness pattern.
 *
 * **A false negative here is loud and a false positive is silent**, which is the
 * right way round: if Claude Code restyles this line, every channel-enabled
 * activation reports `no-prompt` and says so in the log, rather than quietly
 * declaring ready over a session that is not there.
 */
export const SESSION_PROMPT_PATTERN = /for shortcuts|[Bb]ypass(?:ing)? [Pp]ermissions/;

/**
 * How many Enters this will ever send at one agent.
 *
 * **Two is the measured number** — one per `claude` invocation, and the `||`
 * makes at most two invocations. Four is what is allowed, and the gap between
 * the two is the point: a third dialog means our model of Claude Code's startup
 * sequence is wrong, and pressing Enter blind at a session we no longer
 * understand is worse than stopping. The cap is reported when it is reached, so
 * "we stopped" is never mistaken for "there was nothing to do".
 */
export const MAX_DIALOG_ANSWERS = 4;

/** Between polls of the pane and the identity map. */
const POLL_MS = 3000;

/**
 * After an Enter, before the pane is read again.
 *
 * The pane does not repaint instantly, so re-reading immediately would see the
 * dialog we just dismissed and spend another answer on it — burning the cap on
 * one dialog and leaving nothing for the second. KAN-217's probe uses the same
 * 3s for the same reason.
 */
const DIALOG_SETTLE_MS = 3000;

/**
 * The whole supervision budget.
 *
 * Two dialogs, a `--continue` that has to fail, a second `claude` boot and an
 * MCP server spawn all fit inside it with room; KAN-217 measured the fresh-
 * workspace path at well under a minute. It is a deadline rather than a
 * heartbeat: this reports what it saw and stops, and never becomes a background
 * task that outlives the agent it was watching.
 */
const STARTUP_DEADLINE_MS = 180_000;

/** Why supervision ended. Every one of these is written to the daemon log. */
export type ChannelStartupOutcome =
  | 'ready'
  | 'dialog-unanswered'
  | 'no-prompt'
  | 'no-connection'
  | 'unreadable-pane'
  /**
   * A dialog was on the pane and it was NOT ours, so nothing was pressed
   * (KAN-340).
   *
   * Distinct from `dialog-unanswered`, which is our dialog that we failed to
   * clear — a bug or an outage on our side. This one is the watcher working
   * correctly and declining, and it sends an operator somewhere else entirely:
   * a workspace-trust box is waiting on a **human**, and the agent will sit
   * there until one arrives however long the daemon watches.
   */
  | 'foreign-dialog';

export interface ChannelStartupResult {
  outcome: ChannelStartupOutcome;
  /** True only for `ready`; the one field a caller should branch on. */
  ready: boolean;
  /** Enters herdr accepted. A send that threw is logged and not counted here. */
  dialogsAnswered: number;
  /** The connection an addressed frame would now be written to. */
  connectionId: string | null;
  waitedMs: number;
  /** One sentence for a human reading the log at 3am. */
  detail: string;
}

/**
 * What supervision needs from the world, injected so it can be driven without
 * one.
 *
 * Every member is a *function of the outside world at the moment it is called* —
 * there is no state here and nothing is captured — which is what lets
 * `verify-channel-startup-supervision.mjs` drive the real loop against a scripted
 * pane instead of reimplementing it. A second implementation of this sequencing
 * in a test harness would be the KAN-145 shape: one fact, two copies, and the
 * copy nobody runs in production is the one that stays right.
 */
export interface ChannelStartupWorld {
  /**
   * The agent's pane as text; `null` when it could not be read at all.
   *
   * `Promise`-returning since KAN-283, because `AgentRuntime.tailAgent` is — a
   * runtime that answers over a socket cannot serve a tail synchronously. The
   * three meanings are unchanged: text, `''` for a pane that was read and is
   * empty, and `null` for no reading at all.
   */
  readPane: () => Promise<string | null>;
  /**
   * Send one Enter to the agent's pane. Throwing is reported, not fatal.
   *
   * **The argument is the permission, not the payload (KAN-340).**
   * {@link DevChannelsConfirmation} is branded with a symbol `startup-dialog.ts`
   * does not export, so the only way to obtain one is to have had
   * `classifyStartupDialog` say the pane's *live* dialog is the dev-channels one.
   * An implementation is free to ignore the value — the production one does, it
   * has a pane to type at and nothing to decide — but no caller can construct a
   * call without the classification. That is the difference between a rule about
   * pressing Enter and a rule that cannot be broken: pressing Enter at an
   * unclassified pane is a compile error rather than a review comment.
   */
  pressEnter: (confirmation: DevChannelsConfirmation) => void;
  /** Now, in epoch ms. Injected so a harness need not sleep in real time. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * When this agent's MCP server first registered *after* `spawnedAt`, and the
   * connection id if so. Answering `null` means nothing has connected yet.
   */
  freshConnection: (spawnedAt: number) => { id: string } | null;
  log: (message: string) => void;
}

/**
 * Drive one channel-enabled agent from spawn to reachable, or report why not.
 *
 * Never throws: it is fired from the middle of an activation and there is
 * nobody to catch it there. The activation is **not** blocked on this — see the
 * caller in herdr.ts for why, and for what that costs.
 */
export async function superviseChannelStartup(opts: {
  address: AgentAddress;
  /** Epoch ms taken immediately before the pane was spawned. */
  spawnedAt: number;
  world: ChannelStartupWorld;
  deadlineMs?: number;
}): Promise<ChannelStartupResult> {
  const { address, spawnedAt, world } = opts;
  const deadlineMs = opts.deadlineMs ?? STARTUP_DEADLINE_MS;
  const who = describeAddress(address);
  const startedAt = world.now();
  const deadline = startedAt + deadlineMs;

  let dialogsAnswered = 0;
  let capReached = false;
  let paneReads = 0;
  let paneFailures = 0;
  let dialogOnScreen = false;
  let atPrompt = false;
  let sawConnection = false;
  let sawDialog = false;
  /** So a recurring mid-paint frame does not become the log. See the branch below. */
  let undelimitedLogged = false;

  const done = (
    outcome: ChannelStartupOutcome,
    connectionId: string | null,
    detail: string
  ): ChannelStartupResult => ({
    outcome,
    ready: outcome === 'ready',
    dialogsAnswered,
    connectionId,
    waitedMs: world.now() - startedAt,
    detail
  });

  world.log(`[ChannelStartup] ${who}: watching for the development-channels dialog`);

  // THE DEADLINE IS TESTED AT THE TOP, WHICH IS NOT A STYLE CHOICE. An earlier
  // shape tested it at the bottom, and the dialog branch below `continue`s —
  // so a pane showing a dialog that never cleared skipped the test on every
  // pass and this loop never ended. `verify-channel-startup-supervision.mjs`
  // section 6 hung on it before it was ever built: a herdr refusing `send-keys`
  // would have left the daemon spawning a subprocess every three seconds for the
  // rest of its life, for an agent nobody was watching. One condition, at the
  // one place every path goes through.
  while (world.now() < deadline) {
    // THE PANE IS READ FIRST AND EXACTLY ONCE PER PASS, so the dialog test and
    // the prompt test are answered by the same frame. Asking twice would allow a
    // pass that saw no dialog and no prompt to disagree with itself.
    const pane = await world.readPane();
    paneReads += 1;
    // WHAT IS ON THE PANE IS DECIDED ONCE, HERE, AND THE VERDICT IS WHAT THE
    // REST OF THE PASS BRANCHES ON (KAN-340). `classifyStartupDialog` reads only
    // the dialog that is currently waiting for a key — see startup-dialog.ts for
    // why a whole-frame match was answering a different question — and its
    // `dev-channels` case is the only one carrying a value `pressEnter` will
    // accept.
    const dialog = pane === null ? null : classifyStartupDialog(pane);

    if (pane === null) {
      paneFailures += 1;
    } else if (dialog !== null && (dialog.kind === 'foreign' || dialog.kind === 'ambiguous')) {
      // NOT OURS, SO NOTHING IS PRESSED — and this is a terminal state rather
      // than something to poll through. A trust dialog does not clear itself and
      // no amount of waiting makes it ours; continuing to loop would spend three
      // minutes to reach a worse-worded version of the same conclusion, while
      // this returns immediately and tells an operator what is actually on their
      // screen.
      const what =
        dialog.kind === 'foreign'
          ? `the ${dialog.dialog} dialog` +
            (dialog.measured ? '' : ' (matched on unmeasured wording — see startup-dialog.ts)')
          : `a frame carrying markers for ${dialog.dialogs.join(' and ')}`;
      const detail =
        `${what} is on the pane, not the development-channels one, so NOTHING WAS PRESSED ` +
        `and this agent will not reach its prompt until a human answers it. Auto-confirming ` +
        `here would have answered a question nobody asked this daemon to answer — a trust ` +
        `dialog grants read, edit and execute in the workspace. ${dialogsAnswered} ` +
        `development-channels dialog(s) were answered before it appeared.`;
      world.log(`[ChannelStartup] ${who}: REFUSING TO ANSWER — ${detail}`);
      return done('foreign-dialog', null, detail);
    } else if (dialog !== null && dialog.kind === 'undelimited') {
      // OUR PROSE, NO CONFIRM LINE. Not answered — which dialog is live cannot be
      // decided from this frame — but NOT given up on either: the ordinary cause
      // is a dialog caught mid-paint, and the next poll has the rest of it.
      // Logged once, because a mid-paint frame can recur and this must not
      // become the log.
      dialogOnScreen = true;
      sawDialog = true;
      if (!undelimitedLogged) {
        undelimitedLogged = true;
        world.log(
          `[ChannelStartup] ${who}: the development-channels prose is on the pane but no ` +
          `'Enter to confirm' line delimits it, so which dialog is live cannot be decided ` +
          `and NOTHING WAS PRESSED. Ordinarily this is a dialog caught mid-paint and the ` +
          `next poll clears it. If this run ends in 'dialog-unanswered', suspect that ` +
          `Claude Code has restyled the confirm line — every channel-enabled agent wedges ` +
          `until DEV_CHANNELS_MARKERS/CONFIRM_LINE in startup-dialog.ts are re-measured.`
        );
      }
    } else if (dialog !== null && dialog.kind === 'dev-channels') {
      dialogOnScreen = true;
      sawDialog = true;
      if (dialogsAnswered >= MAX_DIALOG_ANSWERS) {
        if (!capReached) {
          capReached = true;
          world.log(
            `[ChannelStartup] ${who}: ${MAX_DIALOG_ANSWERS} dialogs answered and another is on ` +
            `screen — refusing to press Enter again at a startup sequence this no longer models`
          );
        }
      } else {
        world.log(
          `[ChannelStartup] ${who}: development-channels dialog #${dialogsAnswered + 1} — ` +
          `answering with Enter`
        );
        try {
          // The confirmation is the one this pass produced, for this frame. It
          // cannot outlive the pass or be reused on the next one: there is no
          // variable holding it, and the next iteration classifies again.
          world.pressEnter(dialog.confirmation);
          // COUNTED ONLY WHEN THE SEND SUCCEEDED, which is what keeps
          // `dialogsAnswered` a count of Enters herdr accepted rather than of
          // dialogs this happened to notice. It also means a herdr that is not
          // answering cannot exhaust the cap and turn a transient outage into a
          // permanent refusal to try: an Enter that never left is not one of the
          // four this is allowed to send. The deadline still bounds the retries.
          dialogsAnswered += 1;
        } catch (e: any) {
          world.log(
            `[ChannelStartup] ${who}: could not send Enter to the pane, will retry: ` +
            `${e?.message ?? String(e)}`
          );
        }
        await world.sleep(DIALOG_SETTLE_MS);
        continue;
      }
    } else {
      dialogOnScreen = false;
      atPrompt = SESSION_PROMPT_PATTERN.test(pane);
      // ALL THREE, IN THIS PASS. See the header for the live run that put the
      // prompt test here: a fresh workspace's `claude --continue` spawns its MCP
      // servers and only then discovers it has no conversation, so a connection
      // on its own is satisfied by a session that is seconds from exiting — and
      // the second dialog then went unanswered with nothing watching.
      const connection = world.freshConnection(spawnedAt);
      sawConnection = sawConnection || Boolean(connection);
      if (connection && atPrompt) {
        const waited = world.now() - startedAt;
        world.log(
          `[ChannelStartup] ${who}: ready after ${waited}ms — the agent is at its prompt and ` +
          `its MCP server is registered (connection ${connection.id}, ` +
          `${dialogsAnswered} dialog(s) answered)`
        );
        return done(
          'ready',
          connection.id,
          `the agent reached its prompt and its MCP server registered with the daemon ` +
          `${waited}ms after spawn; an addressed frame now has a socket to be written to`
        );
      }
    }

    await world.sleep(POLL_MS);
  }

  const waited = world.now() - startedAt;

  // WHICH FAILURE THIS IS MATTERS MORE THAN THAT IT FAILED, because the four send
  // an operator to four different places. They are ordered most-specific first: a
  // dialog still on screen is the brick, an unreadable pane is a herdr problem, a
  // server with no prompt behind it is a client that booted and left, and
  // everything else is a server that never came up at all.
  if (dialogOnScreen) {
    const detail =
      `a development-channels dialog was still on the pane ${waited}ms after spawn ` +
      `(${dialogsAnswered} answered${capReached ? `, cap of ${MAX_DIALOG_ANSWERS} reached` : ''}). ` +
      `THE AGENT HAS NOT REACHED ITS PROMPT and will not on its own.`;
    world.log(`[ChannelStartup] ${who}: GIVING UP — ${detail}`);
    logRevert(world.log, who);
    return done('dialog-unanswered', null, detail);
  }

  if (paneFailures === paneReads) {
    const detail =
      `the pane could not be read at all in ${paneReads} attempt(s) over ${waited}ms, so ` +
      `nothing here knows whether a dialog was raised. The agent may be running normally ` +
      `or may be wedged; this reports which question it could not answer, not an answer.`;
    world.log(`[ChannelStartup] ${who}: GIVING UP — ${detail}`);
    return done('unreadable-pane', null, detail);
  }

  // A SERVER BUT NO PROMPT is its own state and is named rather than folded into
  // the one below, because it sends a reader somewhere different: the client got
  // far enough to spawn its MCP servers and then did not arrive at a session.
  // On the fresh path that is the ordinary transient — `claude --continue`
  // failing over into the second arm — so seeing it at the DEADLINE means the
  // second arm never came up either.
  if (sawConnection && !atPrompt) {
    const detail =
      `an MCP server registered for this agent but the pane never reached a session prompt ` +
      `within ${waited}ms of spawn (${dialogsAnswered} dialog(s) answered). A client that ` +
      `booted, connected and then exited looks exactly like this — read the pane before ` +
      `assuming the channel is the problem.`;
    world.log(`[ChannelStartup] ${who}: GIVING UP — ${detail}`);
    logRevert(world.log, who);
    return done('no-prompt', null, detail);
  }

  // A DIALOG SEEN AT ANY POINT, AND NOTHING EVER CONNECTED, IS THE BRICK. The
  // verdict is `sawDialog && !sawConnection` — a memory of the whole run, not a
  // reading of the last frame — so it holds whatever the final pane read
  // happens to say. That independence is the point of the paragraph below.
  //
  // THE JUSTIFICATION THAT USED TO BE HERE WAS FALSE, AND IT IS WORTH KNOWING
  // WHY IT SURVIVED REVIEW (KAN-255). It said `recent-unwrapped` "reports what
  // has RECENTLY SCROLLED", that a dialog paints once and then emits nothing,
  // and that the pane therefore "reads EMPTY within a minute of the dialog
  // appearing" — citing `probe-channel-launch.mjs` phase 3 at t+60s and t+90s.
  // The observation was real. The mechanism was invented, and all three of its
  // claims are refuted by measurement on this machine (herdr 0.6.4):
  //
  //   * THERE IS NO TIME DEPENDENCE, in either direction. A live pane holding
  //     an unanswered full-screen dialog was read every 10s for 100s at
  //     --lines 1, 5, 10, 20, 22, 23, 40, 120 and 200. Every column was
  //     BYTE-IDENTICAL at every sample. Nothing drains.
  //   * WHAT DECIDES AN EMPTY READ IS GEOMETRY. `recent`/`recent-unwrapped
  //     --lines N` window the last N ROWS OF THE GRID; rows below the cursor
  //     are blank, so a pane whose content sits in the top C rows of an R-row
  //     screen answers "" for every N <= R - C. Predicted and hit exactly: a
  //     23-row pane with 3 rows of content answered "" at every N from 1 to 20
  //     and returned text at N = 21.
  //   * SO A DIALOG PANE DOES NOT READ EMPTY AT THE SIZE WE ASK FOR. A
  //     full-screen dialog FILLS the screen, which is the C that makes R - C
  //     small: the wedged pane above answered "" only at --lines 1 and had 607
  //     characters at --lines 120. `readPane` asks for 140. The state this
  //     comment described as "the ordinary way it looks" is one this reader
  //     cannot reach.
  //
  // The probe's own instrument is how the wrong mechanism got written down:
  // `probe-channel-launch.mjs` returned `res?.text ?? ''` from `tail_agent`, so
  // a read that FAILED printed as `(pane reads EMPTY)` exactly like a pane with
  // nothing on it. Its "empty at t+60s" was therefore never evidence about a
  // pane. That conflation is the same defect `tailAgent` had, one layer up, and
  // both are fixed in KAN-255 — see TAIL_SOURCES in herdr.ts.
  //
  // WHAT IS KEPT is the reason this branch is not folded into `no-connection`:
  // it sends an operator somewhere different. A full-screen box nobody pressed
  // Enter at is not a channel fault, and saying `no-connection` about one costs
  // whoever reads the log the whole distance between those two.
  if (sawDialog && !sawConnection) {
    const detail =
      `a development-channels dialog was raised and nothing ever connected in the ` +
      `${waited}ms since spawn (${dialogsAnswered} answered). THE AGENT HAS NOT REACHED ITS ` +
      `PROMPT: this is a full-screen box waiting on an Enter, not a channel fault, so read ` +
      `the pane before looking at the daemon.`;
    world.log(`[ChannelStartup] ${who}: GIVING UP — ${detail}`);
    logRevert(world.log, who);
    return done('dialog-unanswered', null, detail);
  }

  const detail =
    `no MCP server registered for this agent within ${waited}ms of spawn ` +
    `(${dialogsAnswered} dialog(s) answered, pane readable, at a prompt: ${atPrompt}, ` +
    `no dialog ever seen). The session may be up with no channel behind it: an addressed ` +
    `send to this agent will answer 'no-connection', and a channel event fired at it now ` +
    `would be lost in silence.`;
  world.log(`[ChannelStartup] ${who}: GIVING UP — ${detail}`);
  logRevert(world.log, who);
  return done('no-connection', null, detail);
}

/**
 * The revert, printed at the moment somebody needs it.
 *
 * A runbook nobody can find is not a runbook. This failure is discovered by an
 * operator looking at a fleet that is not working, so the instruction goes in
 * the log beside the symptom rather than only in a PR body and a ticket.
 *
 * It is NOT applied automatically, and that is a decision rather than an
 * omission: one agent failing to bring a channel up is not evidence about the
 * fleet, and a daemon that silently flipped a fleet-wide switch on one agent's
 * timeout would be making a policy call nobody asked it to make — and hiding the
 * failure it was reacting to. Loud and manual beats quiet and clever here.
 */
function logRevert(log: (m: string) => void, who: string): void {
  log(
    `[ChannelStartup] ${who}: REVERT — turn channels off with ` +
    `\`echo '{"enabled": false}' > ${CHANNEL_SWITCH_PATH}\` (or delete that file). ` +
    `Every activation after it spawns the pre-KAN-246 command line byte for byte, ` +
    `with no channels flag and therefore no dialog. Already-running agents are ` +
    `unaffected and need no restart; re-activate this one to recover it.`
  );
}

/**
 * The production {@link ChannelStartupWorld.freshConnection}.
 *
 * Kept here, next to the definition of freshness it implements, rather than
 * inline at the wiring site in daemon.ts — the registry's `registeredAt` is the
 * only thing that makes "fresh" decidable, and a reader who wants to know what
 * this daemon means by ready should not have to find it in a constructor.
 *
 * A one-second grace is subtracted from `spawnedAt` because the two clocks are
 * the same clock but the two events are not ordered by anything: the spawn
 * timestamp is taken just before `herdr agent start` returns, and a server that
 * registered inside that window is this agent's. The cost of the grace is that a
 * connection registered in the second before the spawn could be counted as
 * fresh — which requires the *previous* session's server to have connected in
 * that exact second, i.e. to have been alive milliseconds ago, which the pane
 * close that precedes any re-spawn rules out.
 */
export function freshConnectionFrom(
  registry: AgentConnectionRegistry,
  address: AgentAddress
): (spawnedAt: number) => { id: string } | null {
  const GRACE_MS = 1000;
  return (spawnedAt: number) => {
    const connection = registry.resolve(address);
    if (!connection) return null;
    if (connection.registeredAt.getTime() + GRACE_MS < spawnedAt) return null;
    return { id: connection.id };
  };
}

/**
 * Why supervision of an ADOPTED pane ended.
 *
 * A deliberately different vocabulary from {@link ChannelStartupOutcome}, and
 * the difference is the whole point of the function below: that one ends in a
 * claim about **reachability** — an addressed frame has a socket — and this one
 * cannot make that claim about a pane this daemon did not start. See
 * {@link superviseAdoptedStartup} for what it does and does not know.
 */
export type AdoptedStartupOutcome =
  /** No dialog, and the pane is at a session prompt. Nothing was needed. */
  | 'at-prompt'
  /** Our dialog was live, we cleared it, and the pane reached a prompt. */
  | 'dialog-answered'
  /** Our dialog was live and was still there at the deadline. */
  | 'dialog-unanswered'
  /** A dialog only a human may answer. Nothing was pressed. */
  | 'foreign-dialog'
  /** The pane could not be read at all, so nothing here knows what is on it. */
  | 'unreadable-pane'
  /**
   * Readable, and never at a prompt.
   *
   * Covers two situations that share a verdict and NOT a sentence: no dialog
   * was ever seen, and a dialog was seen, cleared, and no prompt followed. The
   * `detail` distinguishes them, because the second one has to say out loud that
   * the keystroke worked — reporting it as `dialog-unanswered`, which this did
   * until it was caught in review, sends an operator to press a key at a box
   * that is no longer there.
   */
  | 'no-prompt';

export interface AdoptedStartupResult {
  outcome: AdoptedStartupOutcome;
  /** True only where the pane was actually observed at a session prompt. */
  atPrompt: boolean;
  /** Enters herdr accepted. A send that threw is logged and not counted here. */
  dialogsAnswered: number;
  waitedMs: number;
  /** One sentence for a human reading the log at 3am. */
  detail: string;
}

/**
 * What supervising an adopted pane needs from the world.
 *
 * **Derived from {@link ChannelStartupWorld} rather than declared beside it**,
 * so the pane reader and the keystroke keep exactly one definition between the
 * two supervisors. `freshConnection` is the one member removed, and its absence
 * is the type-level statement of this function's limit: there is no spawn
 * instant to date a connection against, so this cannot ask the question and
 * cannot be edited into asking it.
 */
export type AdoptedStartupWorld = Omit<ChannelStartupWorld, 'freshConnection'>;

/**
 * Get an ADOPTED pane past a startup dialog nobody else is watching — or say
 * that it is stuck on one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (KAN-538)
 * ---------------------------------------------------------------------------
 *
 * {@link superviseChannelStartup} is armed by `AgentRuntime`'s spawn listener,
 * and under CrabCast that listener fires from exactly one place: the tail of
 * `provision()`. **`adoptFromCensus()` is the other way a live session enters
 * that runtime's map, and it fired nothing** — so a pane CrabCast already had
 * running when the daemon's census arrived was taken into the fleet with no
 * watcher on it. If such a pane was sitting at the development-channels dialog,
 * nothing would ever press the key, and nothing said so.
 *
 * **That is measured, on both columns, over the 13 daemon runs since the
 * CrabCast spawn listener went live (2026-08-18T04:34:53Z):** the set of agents
 * with a `[ChannelStartup] … watching` line equals the set with a
 * `[CrabCastRuntime] activated` line **exactly**, in every run and in both
 * directions — 0 watched-but-not-provisioned, 0 provisioned-but-not-watched —
 * while **76 adopted-and-never-provisioned agent instances got no watcher at
 * all.** `story/KAN-117` and `epic/KAN-59` sat at that dialog for 90 minutes on
 * 2026-08-18 and both are in the adopted column.
 *
 * ⚠ **`restore` versus `provision` is NOT the distinction, and reading it that
 * way is what refuted the first answer to this ticket.** A restore *sometimes*
 * provisions — `epic/KAN-39` has both a `Restoring` line and a watcher — and
 * sometimes does not, because a session adopted seconds earlier makes the
 * reconciler take its `already running; leaving it alone` branch. `Restoring` is
 * upstream of the branch that actually decides, so it separates nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS KNOWS, AND THE ONE THING IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It reads the pane and it answers the pane. It makes **no claim about the
 * channel**, and that is a limit rather than an omission: CrabCast publishes no
 * spawn command line for a session it started before this daemon existed, so
 * whether that pane carries Butchr's `--dangerously-load-development-channels`
 * is a fact this process cannot obtain. `superviseChannelStartup` gates on
 * `spawn.channelEnabled === true` for that reason and would be *lying* if it
 * were handed a `true` here — the KAN-496 trap arriving by a new door.
 *
 * **So the flag is not consulted, and nothing is inferred from its absence.**
 * The pane is asked instead, which answers a narrower question honestly: is the
 * dialog that is *currently waiting for a key* the development-channels one?
 * {@link classifyStartupDialog} is the only thing that may say yes, and it
 * refuses a foreign or ambiguous frame — so a pane carrying no dialog of ours
 * costs one tail and returns, and a workspace-trust box is refused here exactly
 * as it is there.
 *
 * **WHO COVERS WHAT THIS DOES NOT.** Channel reachability for an adopted agent
 * is not established here and is not established anywhere by this function's
 * arrival: `runChannelSelfCheck` is chained onto the *spawn* watcher, so an
 * adopted agent still has no startup verdict and reads as `unchecked`, which is
 * a state the fleet already handles honestly. Reaching a prompt is what this
 * buys, and reaching a prompt is what it claims.
 */
export async function superviseAdoptedStartup(opts: {
  address: AgentAddress;
  /** Epoch ms at which this daemon adopted the pane. NOT a spawn time. */
  adoptedAt: number;
  world: AdoptedStartupWorld;
  deadlineMs?: number;
}): Promise<AdoptedStartupResult> {
  const { address, world } = opts;
  const deadlineMs = opts.deadlineMs ?? STARTUP_DEADLINE_MS;
  const who = describeAddress(address);
  const startedAt = world.now();
  const deadline = startedAt + deadlineMs;

  let dialogsAnswered = 0;
  let capReached = false;
  let paneReads = 0;
  let paneFailures = 0;
  let dialogOnScreen = false;
  let sawDialog = false;
  let undelimitedLogged = false;

  const done = (
    outcome: AdoptedStartupOutcome,
    atPrompt: boolean,
    detail: string
  ): AdoptedStartupResult => ({
    outcome,
    atPrompt,
    dialogsAnswered,
    waitedMs: world.now() - startedAt,
    detail
  });

  world.log(
    `[AdoptedStartup] ${who}: this daemon did not start this pane, so nothing has watched it ` +
    `for a startup dialog — reading it to find out whether one is waiting`
  );

  // THE DEADLINE IS TESTED AT THE TOP, for the reason `superviseChannelStartup`
  // gives at the same place: the dialog branch below `continue`s, so a bottom
  // test is skipped on exactly the path that can loop forever.
  while (world.now() < deadline) {
    const pane = await world.readPane();
    paneReads += 1;
    const dialog = pane === null ? null : classifyStartupDialog(pane);

    if (pane === null) {
      paneFailures += 1;
    } else if (dialog !== null && (dialog.kind === 'foreign' || dialog.kind === 'ambiguous')) {
      const what =
        dialog.kind === 'foreign'
          ? `the ${dialog.dialog} dialog` +
            (dialog.measured ? '' : ' (matched on unmeasured wording — see startup-dialog.ts)')
          : `a frame carrying markers for ${dialog.dialogs.join(' and ')}`;
      const detail =
        `${what} is on the pane of an adopted agent, not the development-channels one, so ` +
        `NOTHING WAS PRESSED and this agent will not reach its prompt until a human answers ` +
        `it. ${dialogsAnswered} development-channels dialog(s) were answered before it appeared.`;
      world.log(`[AdoptedStartup] ${who}: REFUSING TO ANSWER — ${detail}`);
      return done('foreign-dialog', false, detail);
    } else if (dialog !== null && dialog.kind === 'undelimited') {
      dialogOnScreen = true;
      sawDialog = true;
      if (!undelimitedLogged) {
        undelimitedLogged = true;
        world.log(
          `[AdoptedStartup] ${who}: the development-channels prose is on the pane but no ` +
          `'Enter to confirm' line delimits it, so which dialog is live cannot be decided and ` +
          `NOTHING WAS PRESSED. Ordinarily this is a dialog caught mid-paint and the next poll ` +
          `clears it; if this run ends in 'dialog-unanswered', suspect a restyled confirm line.`
        );
      }
    } else if (dialog !== null && dialog.kind === 'dev-channels') {
      dialogOnScreen = true;
      sawDialog = true;
      if (dialogsAnswered >= MAX_DIALOG_ANSWERS) {
        if (!capReached) {
          capReached = true;
          world.log(
            `[AdoptedStartup] ${who}: ${MAX_DIALOG_ANSWERS} dialogs answered and another is on ` +
            `screen — refusing to press Enter again at a startup sequence this no longer models`
          );
        }
      } else {
        world.log(
          `[AdoptedStartup] ${who}: development-channels dialog #${dialogsAnswered + 1} on an ` +
          `ADOPTED pane — answering with Enter, because nothing else is watching this one`
        );
        try {
          world.pressEnter(dialog.confirmation);
          dialogsAnswered += 1;
        } catch (e: any) {
          world.log(
            `[AdoptedStartup] ${who}: could not send Enter to the pane, will retry: ` +
            `${e?.message ?? String(e)}`
          );
        }
        await world.sleep(DIALOG_SETTLE_MS);
        continue;
      }
    } else {
      dialogOnScreen = false;
      // THE PROMPT IS THE WHOLE TERMINAL CONDITION HERE, and that is the
      // difference from the spawn watcher rather than a weaker version of it.
      // There, a prompt without a fresh connection is a session seconds from
      // exiting; here there is no spawn to be fresh against, so the connection
      // is not evidence this function is entitled to read. See the header.
      if (SESSION_PROMPT_PATTERN.test(pane)) {
        const waited = world.now() - startedAt;
        const outcome: AdoptedStartupOutcome =
          dialogsAnswered > 0 ? 'dialog-answered' : 'at-prompt';
        const detail =
          dialogsAnswered > 0
            ? `an adopted pane was sitting at ${dialogsAnswered} development-channels ` +
              `dialog(s) that nothing was watching; they were answered and it reached its ` +
              `prompt ${waited}ms later. Without this it would have sat there indefinitely.`
            : `the adopted pane was already at a session prompt, so no startup dialog was ` +
              `waiting on it (checked ${paneReads} time(s) over ${waited}ms).`;
        world.log(`[AdoptedStartup] ${who}: ${outcome} — ${detail}`);
        return done(outcome, true, detail);
      }
    }

    await world.sleep(POLL_MS);
  }

  const waited = world.now() - startedAt;

  // ⚠ `dialogOnScreen` AND `sawDialog` ARE NOT THE SAME QUESTION, AND THIS
  // BRANCH READ `dialogOnScreen || sawDialog` UNTIL IT WAS CAUGHT IN REVIEW.
  //
  // Under that wording, a dialog that WAS cleared and was followed by a client
  // that never reached a prompt reported `dialog-unanswered` — which sends an
  // operator to press a key at a box that is no longer on the screen, and buries
  // the thing that actually happened. It is this ticket's own defect shape: a
  // verdict claiming more than its mechanism covers, degrading toward the
  // familiar answer.
  //
  // `dialogOnScreen` is the LAST SUCCESSFUL READ's verdict — a failed read
  // leaves it alone deliberately, so an unreadable final frame does not erase
  // the memory of a box that was there a moment ago. That is what makes it safe
  // to branch on rather than the whole-run memory.
  if (dialogOnScreen) {
    const detail =
      `a development-channels dialog was on an adopted pane and was still not cleared ` +
      `${waited}ms later (${dialogsAnswered} answered` +
      `${capReached ? `, cap of ${MAX_DIALOG_ANSWERS} reached` : ''}). THE AGENT HAS NOT ` +
      `REACHED ITS PROMPT and will not on its own.`;
    world.log(`[AdoptedStartup] ${who}: GIVING UP — ${detail}`);
    logRevert(world.log, who);
    return done('dialog-unanswered', false, detail);
  }

  if (paneFailures === paneReads) {
    const detail =
      `the pane of this adopted agent could not be read at all in ${paneReads} attempt(s) over ` +
      `${waited}ms, so nothing here knows whether a dialog was raised. This reports which ` +
      `question it could not answer, not an answer.`;
    world.log(`[AdoptedStartup] ${who}: GIVING UP — ${detail}`);
    return done('unreadable-pane', false, detail);
  }

  // A DIALOG THAT WAS CLEARED AND NO PROMPT BEHIND IT is its own sentence rather
  // than the same one, because it sends a reader somewhere else entirely: the
  // keystroke worked and the client is what did not arrive.
  const detail = sawDialog
    ? `a development-channels dialog on this adopted pane was cleared ` +
      `(${dialogsAnswered} answered) and the pane still never reached a session prompt within ` +
      `${waited}ms. THE KEYSTROKE IS NOT THE PROBLEM — the box is gone; a client that booted ` +
      `and then exited looks exactly like this, so read the pane before pressing anything.`
    : `the pane of this adopted agent was readable and never showed either a startup dialog or ` +
      `a session prompt within ${waited}ms. It is not parked on a dialog this daemon can ` +
      `answer; read the pane before assuming what it is doing.`;
  world.log(`[AdoptedStartup] ${who}: GIVING UP — ${detail}`);
  return done('no-prompt', false, detail);
}

/**
 * One in-flight watcher per agent address, and a truthful answer about which.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (KAN-538), AND IT IS A HAZARD THIS TICKET CREATED
 * ---------------------------------------------------------------------------
 *
 * Arming a watcher on adoption introduced a way to arm TWO. `adoptFromCensus`
 * skips an address it already holds a session for — so a second adoption means
 * the first session left the map and came back, and **measured on this machine
 * it comes back as the SAME pane**: 9 repeat adoptions across the 13-run window,
 * every one of them re-using the identical `sessionId`, which is derived from
 * the pane's own `createdAt`. **One of those gaps is 120.9 seconds**, which is
 * inside {@link STARTUP_DEADLINE_MS}. So the second watcher starts while the
 * first is still polling the same pane.
 *
 * **What two watchers on one pane cost is not a duplicated log line.** The cap
 * is per-watcher, so the fleet's "four Enters and then stop" becomes eight — and
 * the cap is not a rate limit, it is the point at which this daemon admits it no
 * longer models the startup sequence and refuses to press keys blind. Worse, the
 * two race: one clears the dialog and the other's Enter lands a moment later at
 * a pane that is now **at its prompt**. An Enter at an idle Claude Code composer
 * submits whatever is sitting in it, and what sits in an idle composer is the
 * client's own suggestion rather than anything a human typed — `epic/KAN-59`'s
 * read, verbatim, *"rotate the LaunchDarkly token now"*, the one action the human
 * has reserved to themselves. That is a fleet-hazard, not an untidiness.
 *
 * **Keyed by address rather than by session id**, deliberately: the watcher reads
 * the pane through `(key, type)`, so the address is what two watchers would
 * actually collide on. A session id would let two watchers onto one pane
 * whenever the id changed, which is the case this is least able to tolerate.
 *
 * The entry is released in a `finally`, so a watcher that throws — which
 * {@link superviseAdoptedStartup} promises not to do, and which is caught at the
 * call site anyway — cannot wedge an address closed for the life of the daemon.
 */
export function oneWatcherPerAddress(): {
  /**
   * Start `run` unless this address already has one in flight.
   *
   * Returns the promise when it started it and `null` when it declined, so a
   * caller can log the decline rather than discovering it as silence.
   */
  start: (address: AgentAddress, run: () => Promise<unknown>) => Promise<unknown> | null;
  /** How many are in flight. Diagnostic; nothing branches on it. */
  size: () => number;
} {
  const inFlight = new Set<string>();
  return {
    start: (address, run) => {
      const who = describeAddress(address);
      if (inFlight.has(who)) return null;
      inFlight.add(who);
      // `run()` is invoked INSIDE the guard rather than before it, so there is
      // no window in which a synchronous throw from `run` leaves the address
      // marked busy with nothing running.
      let started: Promise<unknown>;
      try {
        started = run();
      } catch (e) {
        inFlight.delete(who);
        throw e;
      }
      return started.finally(() => {
        inFlight.delete(who);
      });
    },
    size: () => inFlight.size
  };
}
