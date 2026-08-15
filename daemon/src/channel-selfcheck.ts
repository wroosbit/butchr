/**
 * Proving one agent's channel loop at bring-up, and pinning the proof to the
 * client version it was taken on.
 *
 * WHY THIS MODULE EXISTS (KAN-248, T5 of KAN-150)
 *
 * Channels are a **research preview** and the docs say the contract may move.
 * §6.1 of docs/channel-messaging-design.md ranks what breaks if it does, and the
 * entry that has no other guard is the quiet one: *"notification shape changes →
 * events leave and arrive nowhere → bad, and **silent**"*. Every observable the
 * fleet has today still reads fine in that state. T3 (KAN-246) closed the loud
 * half — an agent that never reaches its prompt — and its own header names what
 * it deliberately does not cover and hands here:
 *
 *   > A registered connection proves the agent's `mcp.js` is up and addressable.
 *   > It does **not** prove the client registered a *channel* with that server.
 *
 * So T3 proves a socket exists. **This proves a message crosses it**, at bring-up,
 * when failure is cheap and attributable to one agent.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES — AND THE ORDERING TRICK THAT MAKES A NOTIFICATION PROVABLE
 * ---------------------------------------------------------------------------
 *
 * An MCP notification is unacknowledgeable by construction: the client returns
 * nothing, and `await mcp.notification()` resolves when the bytes reach the
 * transport rather than when anything reads them. KAN-217 measured exactly that
 * and the reference states it. Taken alone it licenses one claim — *we wrote to
 * a pipe* — which is worth very little, and is precisely the kind of claim this
 * epic keeps mistaking for a working feature.
 *
 * **The stream's ordering is what turns it into something better.** stdio is an
 * ordered byte stream, so this check emits the real
 * `notifications/claude/channel` frame and then, on the SAME stream, sends an
 * ordinary MCP `ping` — a request the client must answer. A ping response can
 * only be produced by a client that has consumed everything ahead of it,
 * **including the notification**. So the answered ping upgrades the claim from
 * *"we wrote it"* to *"the client read it"*, without asking the model for
 * anything and without costing a turn.
 *
 * The five legs, and which of them this establishes:
 *
 *   1. daemon → the agent's connection in KAN-243's identity map    **proved**
 *   2. that frame handled by the agent's own `mcp.js`               **proved**
 *   3. `mcp.js` emits `notifications/claude/channel` to the client  **proved**
 *   4. the client's channel dispatcher accepts it                   **NOT proved**
 *   5. the model reads it                                           **NOT proved**
 *
 * Legs 4 and 5 are not proved *here* and are no longer unwatched: KAN-252's
 * scheduled probe (channel-liveness.ts) asks one model, occasionally, to echo a
 * token, and that is the only instrument that reaches them. See the section on
 * leg 4 below for what it can and cannot say.
 *
 * Leg 3 is proved as *consumed by the client*, per the ping above, rather than
 * merely written.
 *
 * ---------------------------------------------------------------------------
 * LEG 4 IS UNOBSERVABLE, AND SAYING SO IS THE POINT RATHER THAN A DISCLAIMER
 * ---------------------------------------------------------------------------
 *
 * **This check cannot detect a client that read the frame and dropped it.**
 * Claude Code 2.1.226 can decline a channel for six separately-named reasons
 * (`policy`, `era`, `provider`, `disabled`, `capability`, `session`) and tells
 * the server none of them. Measured here rather than taken from the reference:
 * the client's `initialize` request carries `capabilities: {roots, elicitation}`
 * and `clientInfo`, and **it is byte-identical with and without
 * `--dangerously-load-development-channels`** — so nothing on the wire
 * distinguishes a client that took the channel from one that did not. A renamed
 * notification method would be dropped by the client in exactly the same silence.
 *
 * So the ticket's own framing — *"the only thing that catches the silent
 * contract move"* — is more than the mechanism can carry, and this module does
 * not pretend to it. What is available is the next thing, and it is the third
 * mechanism §6.1 asks for by name:
 *
 * **PIN THE OBSERVATION TO A VERSION.** {@link VERIFIED_CLIENT_VERSIONS} is the
 * set of client versions on which a channel event was measured all the way to
 * the *model*. The client reports its own version in `initialize`, per agent, and
 * this records it beside the result. When an agent comes up on a version nobody
 * has measured, the check still passes — the loop is genuinely working — and the
 * agent is marked {@link SelfCheckOutcome} `unverified-client` and shown that way
 * to every supervisor reading `butchr_list_agents`.
 *
 * That does not detect the break. **It detects the condition under which the
 * evidence lapsed**, which is the only thing detectable from here, and it is a
 * real change: today *"it worked on 2.1.226"* is an assumption nobody re-examines,
 * and after this it is a per-agent fact with a version and a timestamp on it.
 *
 * THE ALTERNATIVE THAT WOULD COVER LEG 4, AND WHY IT IS NOT THIS. Ask the model
 * to echo a nonce back — KAN-217's config D and KAN-249's compliance probe both
 * did, and both got a real answer. It is rejected as a *startup* check on three
 * counts, none of them stylistic: it costs a model turn per activation; a model
 * may decline on the merits and be right to (KAN-217 measured a correct refusal,
 * and from outside a refusal is indistinguishable from a broken transport); and
 * it cannot run at bring-up, because at bring-up the agent has not yet read its
 * own brief. **Bolting a model echo onto *this* check is the change that looks
 * like a fix and is not one**, and it stays rejected: it would put a false
 * negative — a model correctly declining — into the decision that gives an agent
 * a channel at all.
 *
 * **WHO COVERS IT: `daemon/src/channel-liveness.ts` (KAN-252), on a schedule.**
 * This sentence used to read *"nobody on a schedule"*, and that is the thing
 * KAN-252 made false. One agent, every few hours, long after bring-up, is asked
 * over the channel to assemble and print a token whose two halves are never
 * adjacent in the message — so only a model that read both can put it on a pane.
 * The result is pinned to the client version **this** module recorded for that
 * agent, and it is read off `butchr_list_agents` as `channelLiveness` beside the
 * per-agent rows below.
 *
 * **What that does and does not buy, because the two are easy to run together.**
 * It cannot distinguish a broken dispatcher from a fleet of models that all
 * declined — nothing outside the client can. What it does is stop being green:
 * a leg-4 break leaves *this* check passing on every agent forever, and leaves
 * the liveness record with a `lastProof` that ages and a drought counter that
 * climbs. An unobservable break becomes an observable absence of evidence. That
 * is the whole of the improvement and this module does not claim more of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FAILURE DOES: DEGRADE THE TRANSPORT, LOUDLY, AND NEVER REFUSE THE AGENT
 * ---------------------------------------------------------------------------
 *
 * A failed check moves that one agent to the composer and says so in
 * `butchr_list_agents`. It never fails an activation — T3 carries enough
 * activation risk for this story, and an agent that is up and reachable by the
 * composer is working. The fallback is enforced in `routeChannelMessage`
 * (channel.ts), the one function that decides a carrier, so it is a behaviour
 * rather than a label: a degraded agent's sends answer `selfcheck-failed` and
 * the sender is told which carrier ran and why.
 *
 * **An absent record does NOT degrade an agent**, and that asymmetry is
 * deliberate. `unchecked` means nobody looked — an agent whose pane predates
 * this daemon, most commonly one that survived a daemon restart. Treating that
 * as a failure would take the whole fleet off channels every time the daemon
 * restarts, which is a larger and quieter behaviour change than the one being
 * guarded. It is reported as `unchecked` instead, where it is visible, and the
 * record is dropped when the connection it was measured on goes away so that
 * `unchecked` always means *"the connection you would write to has not been
 * checked"* rather than *"something was checked once"*.
 */

import type { AgentAddress, AgentConnectionRegistry } from './agent-connections.js';
import { describeAddress } from './agent-connections.js';

/** The daemon → `mcp.ts` frame that asks an agent to prove its own channel. */
export const CHANNEL_SELFCHECK_ACTION = 'channel_selfcheck';

/** The answer `mcp.ts` writes back on the same connection. */
export const CHANNEL_SELFCHECK_RESULT_ACTION = 'channel_selfcheck_result';

/**
 * Client versions on which a channel event was measured reaching **the model**.
 *
 * Not "versions we have seen work" and not "versions that are new enough" — each
 * entry is a measurement somebody ran and wrote down, and the citation is the
 * whole value of the list:
 *
 *   - `2.1.224` — KAN-217, configuration D: a nonce that existed only inside a
 *     daemon broadcast came back out through the channel's reply tool, on a real
 *     Butchr agent in a herdr pane (docs/channel-delivery.md).
 *   - `2.1.226` — KAN-219, re-confirmed incidentally while measuring in-flight
 *     disturbance on the same path (docs/channel-inflight-disturbance.md).
 *
 * **Adding a version here is a claim that somebody measured it**, so add one
 * only with a probe run and a document to point at. An agent on a version not
 * listed is not broken and is not treated as broken; it is reported as running
 * on evidence nobody has.
 */
export const VERIFIED_CLIENT_VERSIONS: readonly string[] = ['2.1.224', '2.1.226'];

/** What the check found. Ordered roughly worst-to-best for a reader. */
export type SelfCheckOutcome =
  /** T3's watcher never reached `ready`, so there was no loop to test. */
  | 'not-ready'
  /** Emission was switched off by the time the check ran. */
  | 'channel-disabled'
  /** No live connection to write the probe frame to. */
  | 'no-connection'
  /** The frame was written and the agent's `mcp.js` never answered. */
  | 'no-answer'
  /** `mcp.js` could not emit the notification to its client. */
  | 'emit-failed'
  /** The notification was emitted and the client did not answer the ping. */
  | 'client-unresponsive'
  /**
   * The connection this check was measuring was replaced while it ran (KAN-435).
   *
   * **Not a fault of the agent, and it is on the passing side of
   * {@link transportFor} for that reason.** The probe was written to the
   * connection that was current when the check started; by the time the answer
   * settled, a *different* connection was registered for this address. Whatever
   * the old connection did or did not say is not evidence about the new one, so
   * this reports the swap rather than converting it into a verdict about a
   * channel nobody tested.
   *
   * **It exists because the alternative was measured degrading healthy agents.**
   * The bring-up sequence registers more than one MCP server — `claude
   * --continue || claude` spawns one per invocation — and the last one wins. When
   * `superviseChannelStartup` declared ready on a connection that closed
   * milliseconds later, this check wrote its probe there, waited the full 20s,
   * and returned `no-answer`: a verdict blaming the recipient's build for a
   * connection swap on our own side. Live, 2026-08-15: `task/KAN-441` ready on
   * `conn-176` at 04:01:07.360, `conn-176` closed at 04:01:07.412, `conn-178`
   * registered at 04:01:07.792, `no-answer → composer` recorded at 04:01:27.360.
   * `story/KAN-117` took the same path 7h49m earlier and sat on the composer for
   * every minute since, holding a live channel the whole time.
   */
  | 'connection-replaced'
  /** The loop crossed, on a client version nobody has measured. */
  | 'unverified-client'
  /** The loop crossed, on a client version a probe has measured to the model. */
  | 'passed';

/** Which carrier this agent's messages take as a result. */
export type SelfCheckTransport = 'channel' | 'composer';

/**
 * The outcomes that leave an agent on the channel.
 *
 * `unverified-client` is here rather than with the failures, and the reason is
 * worth stating: a version bump is not a fault. The loop was proved on that very
 * client, seconds ago. Dropping the fleet to the composer on a patch release
 * would be this module inventing a policy nobody asked for, and would make every
 * client upgrade a silent fleet-wide transport change — which is the class of
 * event this ticket exists to make loud, arriving from the direction the ticket
 * created. It is reported, prominently, and it routes.
 *
 * **`connection-replaced` is here for a different reason, and it is the stronger
 * one (KAN-435): it is not a reading of the live connection at all.** The other
 * failures are things that happened to the channel being measured. This one is
 * the measurement losing its subject — so treating it as a failure would degrade
 * an agent on the strength of a connection that no longer exists, which is
 * exactly the defect the outcome was added to name. Unproved is not failed, by
 * the same asymmetry this module's header argues for `unchecked`.
 */
export function transportFor(outcome: SelfCheckOutcome): SelfCheckTransport {
  return outcome === 'passed' ||
    outcome === 'unverified-client' ||
    outcome === 'connection-replaced'
    ? 'channel'
    : 'composer';
}

/** What `mcp.ts` reports back about its own end of the loop. */
export interface ChannelSelfCheckAck {
  nonce: string;
  /** Whether `server.notification()` resolved. */
  emitted: boolean;
  emitError?: string | null;
  /** Whether the client answered an MCP `ping` sent after the notification. */
  pingAnswered: boolean;
  pingError?: string | null;
  /** `clientInfo.name` from the client's own `initialize`. */
  clientName?: string | null;
  /** `clientInfo.version` from the client's own `initialize`. THE VERSION PIN. */
  clientVersion?: string | null;
  /** The capability keys the client declared, as a contract-drift tripwire. */
  clientCapabilities?: string[] | null;
  /** How long the agent's own leg took, by its clock. */
  agentElapsedMs?: number | null;
}

/** One agent's result, as it is stored and as `list_agents` reports it. */
export interface ChannelSelfCheckReport {
  outcome: SelfCheckOutcome;
  transport: SelfCheckTransport;
  /** True only for `passed`; the one field a caller should branch on. */
  proved: boolean;
  clientName: string | null;
  /** The client's own report of itself. `null` when the loop never got there. */
  clientVersion: string | null;
  /**
   * Whether {@link VERIFIED_CLIENT_VERSIONS} contains {@link clientVersion}.
   * `null` when no version was learned, which is not the same as `false`.
   */
  clientVersionVerified: boolean | null;
  /** The connection the probe frame was written to, and which this describes. */
  connectionId: string | null;
  elapsedMs: number;
  checkedAt: string;
  /** One sentence for a supervisor who reads nothing else on the row. */
  detail: string;
}

/**
 * What the check needs from the world, injected so it can be driven without one.
 *
 * Same shape and same reason as {@link import('./channel-startup.js').ChannelStartupWorld}:
 * every member is a function of the outside world at the moment it is called, so
 * `verify-channel-selfcheck.mjs` drives the shipped decision procedure rather
 * than a second copy of it living in a harness. KAN-145's defect was one fact
 * with two implementations, and the copy nobody runs in production is the one
 * that stays right.
 */
export interface ChannelSelfCheckWorld {
  /** The kill switch, read fresh — the same reader every other caller uses. */
  emissionEnabled: () => boolean;
  /** The connection an addressed frame would go to right now, or `null`. */
  resolveConnection: () => { id: string } | null;
  /**
   * Arm the answer BEFORE the frame goes out, and return the promise for it.
   *
   * Two calls rather than one because the ack can arrive before an `await`
   * would have registered for it — the socket round trip is sub-millisecond on a
   * loopback and the agent's leg is a `notification` and a `ping`. Arming first
   * makes that race unrepresentable. Resolves `null` on timeout.
   */
  expectAck: (nonce: string, timeoutMs: number) => Promise<ChannelSelfCheckAck | null>;
  /** Write the probe frame. `false` means it did not leave. */
  writeProbe: (nonce: string) => boolean;
  now: () => number;
  log: (message: string) => void;
}

/** How long the agent gets to answer. */
const ACK_TIMEOUT_MS = 20_000;

/**
 * The one place a nonce is minted, so a caller cannot supply one.
 *
 * The nonce is not a secret and is not doing security work: it exists so that
 * two checks in flight for one agent — a re-activation racing its predecessor —
 * cannot resolve each other's promise and report the dead session's client
 * version as the live one's.
 */
function mintNonce(seq: number, now: number): string {
  return `sc-${now.toString(36)}-${seq}`;
}

let nonceSeq = 0;

/**
 * Run one agent's startup self-check, or say why it could not be run.
 *
 * Never throws: it is fired from a watcher that is itself fired from the middle
 * of an activation, and there is nobody to catch it there.
 */
export async function runChannelSelfCheck(opts: {
  address: AgentAddress;
  world: ChannelSelfCheckWorld;
  /** Set when T3's watcher did not reach `ready`; the check is then skipped. */
  startupOutcome?: string;
  ackTimeoutMs?: number;
}): Promise<ChannelSelfCheckReport> {
  const { address, world } = opts;
  const timeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const who = describeAddress(address);
  const startedAt = world.now();

  const done = (
    outcome: SelfCheckOutcome,
    detail: string,
    extra: Partial<ChannelSelfCheckReport> = {}
  ): ChannelSelfCheckReport => {
    const report: ChannelSelfCheckReport = {
      outcome,
      transport: transportFor(outcome),
      proved: outcome === 'passed',
      clientName: extra.clientName ?? null,
      clientVersion: extra.clientVersion ?? null,
      clientVersionVerified: extra.clientVersionVerified ?? null,
      connectionId: extra.connectionId ?? null,
      elapsedMs: world.now() - startedAt,
      checkedAt: new Date(world.now()).toISOString(),
      detail
    };
    world.log(
      `[ChannelSelfCheck] ${who}: ${outcome} → ${report.transport} ` +
      `(client ${report.clientVersion ?? 'unknown'}, ${report.elapsedMs}ms) — ${detail}`
    );
    if (report.transport === 'composer') {
      // Beside the verdict rather than only in a runbook, for the reason
      // channel-startup.ts prints its revert beside the symptom: this is
      // discovered by somebody looking at a fleet that is behaving oddly.
      world.log(
        `[ChannelSelfCheck] ${who}: this agent is ON THE COMPOSER — its sends will interrupt ` +
        `work in flight. butchr_list_agents reports it on the row; nothing needs restarting to ` +
        `see it, and re-activating this agent re-runs the check.`
      );
    }
    return report;
  };

  // NOT-READY IS A RESULT, NOT AN ABSENCE. T3 already decided this agent never
  // became reachable, and re-deriving that here would be a second opinion on a
  // question already answered — with the two able to disagree. The outcome is
  // carried through verbatim so a reader lands on T3's log line, which is the
  // one that names the brick.
  if (opts.startupOutcome && opts.startupOutcome !== 'ready') {
    return done(
      'not-ready',
      `channel startup supervision ended in '${opts.startupOutcome}', so there was no loop to ` +
      `test — see the [ChannelStartup] lines above for what it saw`
    );
  }

  // THE SAME READER THE LAUNCHER AND THE ROUTER USE, called rather than copied.
  // A switch flipped off between the spawn and here means the fleet has decided
  // to stop, and the correct answer is the composer rather than a probe frame
  // written through a gate that is shut.
  if (!world.emissionEnabled()) {
    return done(
      'channel-disabled',
      'channel emission was switched off before the check ran, so nothing was written'
    );
  }

  const connection = world.resolveConnection();
  if (!connection) {
    return done(
      'no-connection',
      'no live connection is registered for this agent, so there was nothing to write the probe ' +
      'frame to — an addressed send would answer the same thing'
    );
  }

  const nonce = mintNonce(++nonceSeq, world.now());
  // ARMED BEFORE THE WRITE. See `expectAck`.
  const answer = world.expectAck(nonce, timeoutMs);

  if (!world.writeProbe(nonce)) {
    // The armed answer is left to time out on its own rather than cancelled.
    // It resolves `null` to nobody, which costs one map entry for the timeout —
    // and a cancel path would be a second way for an entry to leave the registry
    // and therefore a second thing to get wrong for no gain.
    return done(
      'no-connection',
      `the probe frame could not be written to ${connection.id}; the connection closed between ` +
      `resolving it and writing to it`,
      { connectionId: connection.id }
    );
  }

  const ack = await answer;

  // DID THIS CHECK STILL HAVE A SUBJECT WHEN IT FINISHED? (KAN-435)
  //
  // Asked BEFORE the ack is interpreted, and that order is the whole of it: every
  // branch below describes `connection`, and if a different connection is
  // registered now then none of those sentences is about this agent's channel.
  // A timeout in particular reads as "your MCP server is wedged" when what
  // actually happened is that the server we wrote to exited normally and its
  // successor was never asked.
  //
  // ONLY WHEN A DIFFERENT ONE IS LIVE. A `null` here is an agent whose
  // connection has gone and not been replaced — nothing supersedes the reading,
  // so `no-answer` about the connection that closed is the honest answer and is
  // left alone.
  const live = world.resolveConnection();
  if (live && live.id !== connection.id) {
    return done(
      'connection-replaced',
      `the probe frame was written to ${connection.id}, and by the time this check settled ` +
      `${live.id} was the connection registered for this agent — the bring-up sequence spawns ` +
      `an MCP server per \`claude\` invocation and the last one wins. Whatever ${connection.id} ` +
      `did or did not answer is not evidence about ${live.id}, so nothing is concluded about ` +
      `this agent's channel and it is NOT degraded. Re-activating it runs the check again`,
      { connectionId: connection.id }
    );
  }

  if (!ack) {
    return done(
      'no-answer',
      `the probe frame was written to ${connection.id} and this agent's MCP server did not ` +
      `answer within ${timeoutMs}ms. Either it is not running the build this daemon expects, ` +
      `or it is wedged: an addressed send to it would report success and prove nothing`,
      { connectionId: connection.id }
    );
  }

  // EVERY REMAINING OUTCOME CARRIES THE VERSION, including the failures. A
  // failure on a client nobody has measured is a different investigation from
  // the same failure on one that has been, and the field that tells them apart
  // must not be the one that goes missing when it matters.
  const clientVersion = ack.clientVersion ?? null;
  const clientName = ack.clientName ?? null;
  const clientVersionVerified =
    clientVersion === null ? null : VERIFIED_CLIENT_VERSIONS.includes(clientVersion);
  const carried = {
    connectionId: connection.id,
    clientName,
    clientVersion,
    clientVersionVerified
  };

  if (!ack.emitted) {
    return done(
      'emit-failed',
      `this agent's MCP server could not emit notifications/claude/channel to its client: ` +
      `${ack.emitError ?? 'no reason given'}. The channel contract has moved under us or the ` +
      `client's transport is gone`,
      carried
    );
  }

  if (!ack.pingAnswered) {
    return done(
      'client-unresponsive',
      `the channel frame was written to the client's transport and the client did not answer an ` +
      `MCP ping behind it (${ack.pingError ?? 'no reason given'}), so nothing here can say it was ` +
      `read. A client that has stopped reading its stdin looks exactly like this`,
      carried
    );
  }

  if (clientVersion === null) {
    // The client answered a ping, so it exists; it did not identify itself,
    // which means `initialize` had not completed or the field is gone. Either
    // way the version pin — the thing this ticket is for — is not available, so
    // this is not `passed`.
    return done(
      'unverified-client',
      `the loop crossed to a client that answered a ping, and that client reported no version in ` +
      `its initialize handshake, so this result is pinned to nothing`,
      carried
    );
  }

  if (!clientVersionVerified) {
    return done(
      'unverified-client',
      `the loop crossed and the client read the frame — but ${clientName ?? 'this client'} ` +
      `${clientVersion} is not a version on which channel delivery to the MODEL has been ` +
      `measured (${VERIFIED_CLIENT_VERSIONS.join(', ')}). Channels are a research preview and the ` +
      `contract may have moved; this agent still uses the channel and is flagged so nobody ` +
      `assumes otherwise`,
      carried
    );
  }

  return done(
    'passed',
    `the channel loop crossed to ${clientName ?? 'the client'} ${clientVersion} and the client ` +
    `read it — a notifications/claude/channel frame was emitted on connection ${connection.id} ` +
    `and an MCP ping ordered behind it on the same stream was answered`,
    carried
  );
}

/**
 * The answers this daemon is still waiting for, by nonce.
 *
 * Lives here rather than inline in daemon.ts because it is the half of the
 * arm-before-write rule that daemon.ts owns, and an inline `Map` and two
 * closures would be logic with no way to exercise it — which is how the timeout
 * and the late-answer case would go untested. {@link expect} is
 * {@link ChannelSelfCheckWorld.expectAck} for the real daemon.
 */
export class ChannelSelfCheckAckRegistry {
  private readonly waiting = new Map<
    string,
    { resolve: (ack: ChannelSelfCheckAck | null) => void; timer: NodeJS.Timeout }
  >();

  /** Arm an answer and return the promise for it. `null` on timeout. */
  public expect(nonce: string, timeoutMs: number): Promise<ChannelSelfCheckAck | null> {
    return new Promise((resolve) => {
      // DELIBERATELY NOT `unref`ed. It is a bounded 20s wait that always
      // settles, so holding the event loop is at worst a 20s delay to a
      // shutdown — and an unref'ed timer silently changes the promise's meaning
      // in any process that has nothing else pending, where it never fires and
      // the await never returns. That is not hypothetical: it is what the first
      // run of `verify-channel-selfcheck.mjs` section 2 did, exiting 13 on an
      // unsettled top-level await rather than reporting a timeout.
      const timer = setTimeout(() => {
        this.waiting.delete(nonce);
        resolve(null);
      }, timeoutMs);
      this.waiting.set(nonce, { resolve, timer });
    });
  }

  /**
   * Hand an agent's answer to whoever armed it. `false` when nobody did.
   *
   * **An unknown nonce is dropped, and that is correct rather than lax.** It is
   * what a late answer looks like after the check has already timed out and
   * reported: resolving one then would overwrite a verdict with a reading of a
   * client that has since gone. It is also what an answer for a *previous*
   * activation of the same agent looks like, which is the whole reason the nonce
   * exists.
   */
  public deliver(msg: any): boolean {
    const nonce = typeof msg?.nonce === 'string' ? msg.nonce : '';
    const entry = this.waiting.get(nonce);
    if (!entry) return false;
    this.waiting.delete(nonce);
    clearTimeout(entry.timer);
    entry.resolve(msg as ChannelSelfCheckAck);
    return true;
  }

  /** How many answers are outstanding. For a diagnostic and for proofs. */
  public get pending(): number {
    return this.waiting.size;
  }
}

/**
 * Every agent's latest verdict, and the only thing that reads them.
 *
 * Held in memory rather than on disk deliberately: a verdict is about a
 * connection that exists right now, and a daemon that restarts has no
 * connections to have verdicts about. Persisting them would produce exactly the
 * artefact this codebase keeps paying for — a stored fact that outlives what it
 * described and reads as current.
 */
export class ChannelSelfCheckStore {
  private readonly byAddress = new Map<string, ChannelSelfCheckReport>();

  private static canonical(address: AgentAddress): string {
    return `${address.type.trim().toLowerCase()}/${address.key.trim().toLowerCase()}`;
  }

  public record(address: AgentAddress, report: ChannelSelfCheckReport): void {
    this.byAddress.set(ChannelSelfCheckStore.canonical(address), report);
  }

  public get(address: AgentAddress): ChannelSelfCheckReport | undefined {
    return this.byAddress.get(ChannelSelfCheckStore.canonical(address));
  }

  /**
   * Forget whatever was known about this agent, unconditionally.
   *
   * Called at the top of a channel-enabled spawn, and it is not tidiness — it
   * closes a hole the live probe found. {@link releaseConnection} can only drop a
   * verdict that HAS a connection, and the failure verdicts most worth not
   * keeping are exactly the ones that never got one (`not-ready`,
   * `no-connection`): nothing releases them, so a re-activated agent carried its
   * previous run's verdict on its row, with a `checkedAt` from before the
   * restart, until the new check finished. That is a stale fact reading as a
   * current one, which is the artefact this codebase keeps paying for.
   *
   * A re-activation invalidates the old reading whatever it said, so this runs
   * before the new check rather than after it: for the seconds in between the
   * agent reads `unchecked`, which is true.
   */
  public forget(address: AgentAddress): void {
    this.byAddress.delete(ChannelSelfCheckStore.canonical(address));
  }

  /**
   * Drop the verdict for a connection that has gone away.
   *
   * Called from the socket's `close` beside `AgentConnectionRegistry.release`,
   * and matched on connection id rather than on address: an agent that
   * reconnected before its old socket's close fired has a NEW verdict about a
   * NEW connection, and releasing by address would delete it — the same
   * unordered-close bug agent-connections.ts decision 3 exists to make
   * unrepresentable, reintroduced one map over.
   */
  public releaseConnection(address: AgentAddress, connectionId: string): boolean {
    const key = ChannelSelfCheckStore.canonical(address);
    const held = this.byAddress.get(key);
    if (!held || held.connectionId !== connectionId) return false;
    this.byAddress.delete(key);
    return true;
  }

  /**
   * Whether this agent has been degraded to the composer by a failed check
   * **of the connection it is holding right now**.
   *
   * **`false` for an agent with no record**, which is the whole asymmetry
   * described in this module's header: unchecked is not failed. The gate in
   * `routeChannelMessage` asks exactly this question and no other.
   *
   * ---------------------------------------------------------------------------
   * WHY THE LIVE CONNECTION IS A PARAMETER AND NOT AN OPTION (KAN-435)
   * ---------------------------------------------------------------------------
   *
   * **A verdict is about a connection, so this question cannot be answered about
   * an address alone** — and it was, until this ticket, which is how two agents
   * came to sit on the composer over channels that were working perfectly.
   *
   * {@link releaseConnection} is the only thing that drops a verdict, and it
   * fires from the socket's `close`. That covers the ordinary order — verdict
   * first, close later. It cannot cover the reverse: the check takes up to 20
   * seconds, so a connection that closes *while it runs* is released before
   * there is anything to release, and the verdict lands afterwards naming a
   * connection that is already gone. **Nothing else ever looks at it again**, so
   * it degrades the agent for the life of the daemon.
   *
   * Measured on this fleet, 2026-08-15T04:04:29Z — two of eight agents:
   *
   * | agent | verdict about | actually holding | pinned for |
   * | --- | --- | --- | --- |
   * | `story/KAN-117` | conn-129, closed 20:12:04 | conn-130, live | ~7h52m |
   * | `task/KAN-441` | conn-176, closed 04:01:07 | conn-178, live | since 04:01 |
   *
   * Making the live connection a **required argument** is what stops that coming
   * back, and it is the reason this is not an optional field with a default: a
   * caller cannot ask *"is this agent degraded?"* without saying which connection
   * it means, so a reader that has not got one is a compile error rather than a
   * silent reintroduction of the address-only question. The same shape as
   * `ChannelMeta` in channel.ts — the wrong call is not caught, it is not
   * nameable.
   *
   * **`null` keeps the pre-KAN-435 answer, deliberately.** An agent holding no
   * connection at all is not the case this fixes, and `carrierFor` puts
   * `degraded` ahead of `registered` on purpose so that an agent which is both
   * degraded and disconnected reads as degraded — the cause somebody can act on.
   * Nothing here disturbs that; the new rule bites only when a **different**
   * connection is live, which is precisely the stale verdict.
   */
  public degraded(address: AgentAddress, liveConnectionId: string | null): boolean {
    const held = this.get(address);
    if (held?.transport !== 'composer') return false;
    // A live connection exists and this verdict is not about it — whether it
    // named a different one or (for `not-ready`, `no-connection`,
    // `channel-disabled`) named none at all. In every one of those cases the
    // verdict has nothing to say about the channel this agent is holding now.
    //
    // `typeof === 'string'` RATHER THAN `!== null`, AND IT IS NOT PEDANTRY. The
    // type makes the argument mandatory for every TypeScript caller; the proofs
    // under daemon/scripts are JavaScript and import this out of `dist`, where an
    // omitted argument arrives as `undefined`. Against `!== null` that omission
    // read as "some other connection is live" and answered **not degraded** — a
    // fail-open, in the one direction that matters: it would put a genuinely
    // unproven agent back on the channel silently. `undefined` is not a live
    // connection id; only a string is, and anything else keeps the conservative
    // pre-KAN-435 answer.
    if (typeof liveConnectionId === 'string' && held.connectionId !== liveConnectionId) {
      return false;
    }
    return true;
  }
}
