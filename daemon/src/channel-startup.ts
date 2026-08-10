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

/**
 * The dialog, as it appears on the pane.
 *
 * Both alternatives are strings from Claude Code's own `DevChannelsDialog` — its
 * panel title and its confirm-button label — and they are the two KAN-217's
 * probe matched against a real pane, re-read out of the 2.1.226 binary rather
 * than carried forward on trust.
 *
 * **Deliberately not matching the bare flag name.** `--dangerously-load-`
 * `development-channels` appears in the launch command itself, and a pattern
 * that matched it would fire on any pane that ever echoed the command line —
 * pressing Enter at a session that is running fine rather than at a dialog.
 * Every alternative here is prose the dialog renders and the command line does
 * not contain.
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
  | 'unreadable-pane';

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
  /** The agent's pane as text; `null` when it could not be read at all. */
  readPane: () => string | null;
  /** Send one Enter to the agent's pane. Throwing is reported, not fatal. */
  pressEnter: () => void;
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
    const pane = world.readPane();
    paneReads += 1;
    if (pane === null) {
      paneFailures += 1;
    } else if (DEV_CHANNELS_DIALOG_PATTERN.test(pane)) {
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
          world.pressEnter();
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
