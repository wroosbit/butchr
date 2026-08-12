import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir, writeJsonLine } from './ipc.js';
import type { AgentAddress, AgentConnectionRegistry } from './agent-connections.js';
import { describeAddress } from './agent-connections.js';

/**
 * The channel: what may cross it, and the switch that decides whether anything
 * crosses it at all.
 *
 * WHY THIS MODULE EXISTS (KAN-244, T2 of KAN-150)
 *
 * `docs/channel-messaging-design.md` §1.2 decided that the `claude/channel`
 * capability goes on the existing `butchr` MCP server rather than a sibling —
 * the reply path and the identity argument both point there — and that decision
 * came with a mitigation that §1.2 calls required rather than optional:
 *
 *   > channel emission must be independently disableable at runtime, without
 *   > removing the declared capability and without touching the tool surface.
 *   > When it is off, `mcp.ts` must behave exactly as it does today.
 *
 * This module is that mitigation, plus the allowlist §1.3 asks for. Both halves
 * are here rather than in their consumers so there is one copy of each.
 *
 * ---------------------------------------------------------------------------
 * ONE GATE, IN THE DAEMON, AND THE REASON IT IS NOT TWO
 * ---------------------------------------------------------------------------
 *
 * The switch is honoured in exactly one place: the daemon's addressed-send path
 * (`channel_send`, daemon.ts). It is deliberately NOT also checked in `mcp.ts`.
 *
 * The tempting shape is a gate at both ends — refuse to route, and refuse to
 * emit — on the reasoning that two locks are safer than one. They are not, and
 * this codebase has already paid for finding out: KAN-145's defect was a second
 * source of the same fact, kept in step by hand, and the copy that was never
 * exercised is the one that was wrong. Two switches means two things to flip,
 * two things to read when the fleet is misbehaving, and a state where they
 * disagree that nothing reports.
 *
 * So the gate is where the addressing is. `mcp.ts` emits
 * `notifications/claude/channel` when and only when the daemon writes it a
 * {@link CHANNEL_MESSAGE_ACTION} frame, and the daemon writes one only when this
 * switch is on. With the switch off, no such frame is written, so `mcp.ts`
 * receives nothing new and does nothing new — which is what §1.2 asks for,
 * literally rather than by a second implementation of the same condition.
 *
 * **What that leaves uncovered, said plainly:** this switch cannot suppress the
 * *declaration* of `experimental['claude/channel']` in the server's capabilities
 * — the ticket requires the capability to stay declared while emission is off,
 * so the declaration is unconditional by design. If a future client breaks on
 * the declaration alone rather than on a frame, this switch is not the remedy
 * and reverting the capability is. Nothing here pretends otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHY A FILE, READ FRESH, RATHER THAN AN ENV VAR READ AT BOOT
 * ---------------------------------------------------------------------------
 *
 * A kill switch you cannot pull without restarting the thing you are trying to
 * stop is not a kill switch. The daemon is long-lived and auto-spawned, so its
 * environment is fixed for its whole life by whichever client happened to start
 * it; flipping an env var would mean restarting the daemon, which drops every
 * agent's connection — the fleet-wide disturbance the switch exists to avoid.
 *
 * Reading the file on every routing decision costs one `readFileSync` of a few
 * bytes per addressed message and makes `echo` enough to stop the channel dead,
 * fleet-wide, with nothing restarted. `BoardReconciler.readMode` already reads
 * its mode fresh per cycle for the same reason, and board-control.ts records
 * that reasoning: a value captured at boot is stale in exactly the case that
 * matters.
 */

/** Where the switch lives. Absent is the ordinary state, and it means off. */
export const CHANNEL_SWITCH_PATH = path.join(BUTCHR_DIR, 'channel.json');

/** The daemon → `mcp.ts` frame that carries an addressed channel message. */
export const CHANNEL_MESSAGE_ACTION = 'channel_message';

/** The MCP notification an addressed frame becomes on the agent's own wire. */
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

/**
 * The daemon broadcasts `mcp.ts` forwards onward, named one at a time.
 *
 * REPLACES `msg.action.endsWith('_event')`, which is what this test was until
 * KAN-244 (design §1.3). The suffix test forwards whatever a future author
 * happens to name `*_event`, which makes the set of things that reach an agent's
 * context a consequence of somebody's naming taste rather than a decision
 * anybody made. An allowlist is the smallest thing that turns it back into a
 * decision.
 *
 * **This list is exactly the seven events the daemon emits today**, so it
 * changes what is forwarded not at all — deliberately: KAN-244 is not the
 * ticket that decides which events belong on a channel, and a list that both
 * introduced a mechanism and quietly re-scoped its traffic would be two changes
 * wearing one commit message. What it changes is the direction of the default:
 * an eighth event is not forwarded until somebody adds it here.
 *
 * **The failure mode of an allowlist runs the other way**, and it is worth
 * naming because it is the price of this change: a new event that belongs on
 * the wire and is not listed here is dropped in silence, which is the same
 * quiet the suffix test was chosen to avoid. `verify-channel-emission-gate.mjs`
 * covers that direction by reading the `action: '*_event'` literals out of the
 * daemon sources and failing when one of them is missing from this list.
 */
export const CHANNEL_EVENT_ALLOWLIST: readonly string[] = [
  'agent_activated_event',
  'agent_deactivated_event',
  'agent_detached_event',
  'agent_lost_event',
  'agent_preempted_event',
  'agent_reset_event',
  'capacity_override_event'
];

const allowed = new Set(CHANNEL_EVENT_ALLOWLIST);

/** Whether `mcp.ts` forwards this daemon broadcast onward to its client. */
export function isForwardableEvent(action: unknown): action is string {
  return typeof action === 'string' && allowed.has(action);
}

/**
 * Whether addressed channel emission is on, read fresh from disk every time.
 *
 * Off unless the file says otherwise, and off for every way of being unreadable
 * — missing, malformed, wrong type, unparseable. A kill switch that fails open
 * on a corrupt file is a kill switch that is off precisely when somebody has
 * been editing it in a hurry.
 */
export function channelEmissionEnabled(): boolean {
  try {
    const raw = fs.readFileSync(CHANNEL_SWITCH_PATH, 'utf8');
    return JSON.parse(raw)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Set the switch, atomically.
 *
 * Written via a temp file and `rename` because {@link channelEmissionEnabled}
 * reads on every addressed message: a plain write leaves a window in which the
 * file exists and is half a JSON document, and a reader landing there would see
 * a parse error — which is *off*, so the failure is safe but is also a channel
 * that stops for no reason anybody can find afterwards.
 */
export function writeChannelSwitch(enabled: boolean): void {
  ensureButchrDir();
  const tmp = `${CHANNEL_SWITCH_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CHANNEL_SWITCH_PATH);
}

/**
 * The `meta` a channel frame may carry: attributes, so **string values only**.
 *
 * WHY THIS IS A TYPE RATHER THAN A COMMENT (KAN-319)
 *
 * `docs/channel-delivery.md` records the client contract as `params { content:
 * string, meta?: Record<string,string> }`, and *"each `meta` entry becomes an
 * attribute"*. Until this ticket that constraint lived only in that sentence:
 * {@link routeChannelMessage} took `meta?: unknown` and passed it through, so a
 * caller writing `{ guardianPoke: true }` compiled, wrote, and was reported
 * **delivered**.
 *
 * It is not delivered. A non-string value fails the client's parse of the
 * notification params and **the client discards the whole frame in silence** —
 * not the offending entry, the entire message. Nothing downstream can see that:
 * the daemon's write succeeded, the connection was live, and C1 and C2 are both
 * honestly true. Measured on 2026-08-11 from the recipient side, two frames
 * written to one connection (`conn-15`) in the same instant, differing only in
 * one `meta` value's type — the all-string frame entered the agent's context and
 * the boolean one did not.
 *
 * That is what cost this fleet its supervision for an evening. Six guardian pokes
 * across two agents and three connections carried `guardianPoke: true`, every one
 * recorded `delivered: true`, and **not one reached a model** — while ordinary
 * notifications to the same agents on the same connections, whose meta happens to
 * be all strings, arrived and were acted on throughout. The liveness probe's
 * `livenessProbe: true` was losing every frame the same way, and its record read
 * `no-answer`, which is the state reserved for *a model that declined*.
 *
 * So the fix is a type and not a check, per the standing preference: a check can
 * be deleted by a later author and the build still passes, whereas
 * `{ guardianPoke: true }` against this alias **cannot be written at all**. The
 * assertion below exists as well, for the one caller a type cannot reach.
 */
export type ChannelMeta = Partial<Record<ChannelMetaKey, string>>;

/**
 * The meta keys this daemon is able to send, named one by one (KAN-325).
 *
 * A closed union rather than `string`, and it is the KEY half of the same fix
 * KAN-319 made to the VALUE half one field over. The value axis is closed by
 * {@link ChannelMeta}'s `string`; this closes the key axis, and it closes it the
 * same way and for the same reason — a producer that writes `poke-number` gets a
 * **compile error** rather than an attribute that silently is not there.
 *
 * **Measured, not inherited from the doc.** KAN-325 fired fourteen frames at one
 * live agent's connection and read back what the client rendered. Every frame
 * arrived; the keys outside `/^[A-Za-z_][A-Za-z0-9_]*$/` arrived **minus that one
 * attribute** — see {@link CHANNEL_META_KEY_PATTERN} for the table.
 *
 * **Adding a key is one line here, and that friction is the feature.** The
 * alternative — `Record<string, string>` plus a runtime check — is an assertion a
 * later author can delete with the build still green, which is the trade the
 * standing preference exists to refuse. It is the same shape as `method: 'GET'`
 * in launchdarkly-proxy.ts: the wrong value is not *caught*, it is **not
 * nameable**.
 *
 * These five are every key the daemon produces today: the notification composer's
 * three, plus one marker each for the guardian poke and the liveness probe.
 */
export type ChannelMetaKey =
  | 'sender'
  | 'workspaceType'
  | 'workspaceKey'
  | 'guardianPoke'
  | 'livenessProbe';

/**
 * Which meta keys this client renders as attributes, measured rather than quoted.
 *
 * `docs/channel-delivery.md` said only *"keys must be identifiers — keys
 * containing hyphens or other characters are silently dropped"*, sourced from the
 * channels reference and **never reproduced**. KAN-325 reproduced it, on
 * claude-code **2.1.228**, from the recipient side: fourteen key shapes, one live
 * agent, one connection, every frame reported `success: true`.
 *
 * | rendered | dropped |
 * | --- | --- |
 * | `probeShape` `controlKey` `snake_key` `key2` `_leading` `KEY_NAME` | `hyphen-key` `dot.key` `1leading` `space key` `$dollar` `mid$dollar` `ns:key` `kéy` `""` |
 *
 * So the class is exactly this pattern, and the doc's word *"identifier"* was
 * **wrong in one direction worth naming**: `$` is a legal JavaScript identifier
 * character and is dropped. A leading digit is dropped; a trailing one is kept.
 * Non-ASCII is dropped. The empty key is dropped.
 *
 * **The loss is PARTIAL, and that is the whole difference from KAN-319.** All
 * fourteen frames arrived — body intact, every other attribute intact, minus the
 * offending one. A bad *value* costs the entire frame; a bad *key* costs one
 * attribute. Which is why nothing here refuses: see {@link undeliverableMetaKeys}.
 */
export const CHANNEL_META_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The meta keys this client will drop, named — and **never refused** (KAN-325).
 *
 * The runtime half of {@link ChannelMetaKey}, and it exists for the same single
 * caller {@link unrenderableMetaEntries} does: `channel_send`, whose `meta`
 * arrives off the wire as parsed JSON where no type can reach it. In-process
 * producers cannot reach a bad key at all — the union makes it a compile error.
 *
 * **Why this WARNS where its neighbour REFUSES, which is the decision this ticket
 * exists to make.** Refusing is right for a bad value because the frame is lost
 * either way, so a refusal costs the caller nothing it had. It is wrong here:
 * the frame *otherwise lands*, so refusing would convert a measured partial loss
 * into a certain total one — trading one missing attribute for the whole message,
 * on the very carrier that now hauls supervision. So the frame goes, and the
 * sender is told exactly which keys did not survive it.
 *
 * That is the defect this closes, stated plainly: the loss was not that keys are
 * dropped, it was that **nothing said so** — no error, no log line, no field in
 * the response. A caller now gets all three.
 *
 * Returns `[]` for a non-object rather than reporting it: that shape is
 * {@link unrenderableMetaEntries}'s to refuse, and two reports of one fault send
 * the reader looking for two.
 */
export function undeliverableMetaKeys(meta: unknown): string[] {
  if (meta === undefined || meta === null) return [];
  if (typeof meta !== 'object' || Array.isArray(meta)) return [];
  return Object.keys(meta as Record<string, unknown>).filter(
    (key) => !CHANNEL_META_KEY_PATTERN.test(key)
  );
}

/**
 * The meta entries this client will not render, named one by one.
 *
 * The runtime half of {@link ChannelMeta}, and it exists for exactly one caller:
 * `channel_send`, which takes its `meta` **off the wire** as parsed JSON. A type
 * cannot reach a value that arrived as bytes, so that path gets the assertion and
 * every in-process caller gets the type. Belt and braces, in that order.
 *
 * Empty means every entry survives the client's parse. A non-empty result is a
 * frame that would be written successfully and then silently dropped, which is
 * the one outcome this module must never produce.
 *
 * **What this does NOT check, said rather than left to be discovered.** Meta
 * *keys* are not this function's axis. That gap was named here as uncovered until
 * KAN-325 reproduced it and closed it — see {@link undeliverableMetaKeys}, which
 * **warns rather than refuses**, because a bad key loses one attribute where a bad
 * value loses the whole frame.
 */
export function unrenderableMetaEntries(meta: unknown): string[] {
  if (meta === undefined || meta === null) return [];
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    return [`meta is ${Array.isArray(meta) ? 'an array' : typeof meta}, and the client's contract is an object of string attributes`];
  }
  return Object.entries(meta as Record<string, unknown>)
    .filter(([, value]) => typeof value !== 'string')
    .map(
      ([key, value]) =>
        `${key} is ${value === null ? 'null' : typeof value} (${JSON.stringify(value)}), and only strings render as attributes`
    );
}

/** Why an addressed frame did not go out. Every one of these is sender-visible. */
export type ChannelRefusal =
  | 'channel-disabled'
  | 'selfcheck-failed'
  | 'no-connection'
  | 'registration-lost'
  | 'socket-closed'
  | 'meta-not-renderable';

/** What one attempt to write an addressed frame did. */
export type ChannelRouteOutcome =
  | {
      routed: true;
      connectionId: string;
      address: AgentAddress;
      /**
       * Meta keys the client will drop from this frame (KAN-325).
       *
       * **Present only when non-empty, and on the `routed: true` branch on
       * purpose** — the frame WAS written and the recipient WILL get it, minus
       * these attributes. It is a warning riding on a success, not a refusal
       * wearing one: a partial loss refused as a total loss is the worse trade,
       * and {@link undeliverableMetaKeys} argues it.
       */
      droppedMetaKeys?: string[];
    }
  | { routed: false; reason: ChannelRefusal; detail: string; switchPath?: string };

/**
 * The carrier an agent's next `steer` takes.
 *
 * `'unregistered'` is the third state KAN-274 asks for, and it is neither of the
 * other two on purpose: the agent is not on the channel, and delivering by
 * composer would interrupt work nobody decided to interrupt. A `steer` in this
 * state is **refused**; only `stop-now` still takes the composer, because taking
 * the recipient's work is what `stop-now` is *for*.
 */
export type ChannelCarrier = 'channel' | 'composer' | 'unregistered';

/** What {@link carrierFor} decided, and the sentence that says why. */
export interface CarrierVerdict {
  transport: ChannelCarrier;
  /** `null` exactly when {@link transport} is `'channel'`. */
  refusal: ChannelRefusal | null;
  /** One sentence, derived from the branch taken rather than written twice. */
  detail: string;
}

/**
 * WHICH CARRIER, AND THE ONE PLACE THAT DECIDES IT (KAN-274).
 *
 * Extracted from {@link routeChannelMessage} rather than written beside it, and
 * the extraction is the point rather than tidiness. Before this ticket the
 * routing decision lived here and a *second*, differently-derived answer to the
 * same question lived in `list_agents` — which read the self-check verdict alone
 * and answered `transport: 'channel'` for agents that had no connection at all.
 * That is KAN-145's defect shape exactly: one fact with two implementations, and
 * the copy nobody routes on is the one that was wrong. It cost an agent an
 * interrupt on 2026-08-11, and it cost it *twice over*, because a supervisor that
 * checked the row first was told `channel` and interrupted anyway.
 *
 * So the report and the route now consult this, and the report cannot claim a
 * carrier the next message will not take. `runtime-switch.ts` is the shape.
 *
 * **The order of the branches is load-bearing and unchanged.** The switch is read
 * before the map, so a disabled channel answers `channel-disabled` for a
 * disconnected agent as well as a connected one — the alternative leaks the
 * identity map's contents through a gate that is supposed to be shut, and callers
 * here do not even resolve a connection until the gate has opened. `degraded`
 * sits second so an agent that is both degraded and disconnected reads as
 * degraded, which is the cause somebody can act on.
 *
 * **`managed` is what separates a lost registration from an agent that never had
 * one**, and it needs no new persistence to do it: the durable agent registry
 * already survives a daemon restart and already names exactly the population that
 * runs an MCP server and is therefore *supposed* to hold a connection. A pane, a
 * human-activated workspace, an agent started outside Butchr — none are in it,
 * none ever had a channel to lose, and all of them keep the composer they have
 * always had. Refusing on a bare `no-connection` instead would have broken every
 * one of those, and would have broken the whole fleet the day somebody pulled the
 * kill switch.
 */
export function carrierFor(opts: {
  emissionEnabled: boolean;
  degraded: boolean;
  registered: boolean;
  /** Whether the durable registry expects this agent to be running. */
  managed: boolean;
  /** For the `channel-disabled` sentence only. */
  switchPath?: string;
}): CarrierVerdict {
  if (!opts.emissionEnabled) {
    return {
      transport: 'composer',
      refusal: 'channel-disabled',
      detail:
        'channel emission is switched off fleet-wide, so nothing is written to any connection' +
        (opts.switchPath ? ` (switch: ${opts.switchPath})` : '')
    };
  }

  if (opts.degraded) {
    return {
      transport: 'composer',
      refusal: 'selfcheck-failed',
      detail:
        'this agent failed its startup channel self-check and is degraded to the composer; ' +
        'butchr_list_agents carries the outcome and the client version on its row'
    };
  }

  if (opts.registered) {
    return {
      transport: 'channel',
      refusal: null,
      detail: 'a live channel connection is registered for this agent'
    };
  }

  if (opts.managed) {
    return {
      transport: 'unregistered',
      refusal: 'registration-lost',
      detail:
        'this agent is one the durable registry expects to be running, and it holds no channel ' +
        'registration — its MCP server has not (re-)announced itself since the link dropped. A ' +
        'daemon restart drops every registration, and a socket error or a client reload drops ' +
        'one; the agent is fine and is simply not addressable over the channel yet. It ' +
        're-registers by itself within seconds of the daemon being reachable (KAN-274)'
    };
  }

  return {
    transport: 'composer',
    refusal: 'no-connection',
    detail:
      'no live channel connection is registered for this agent, and the durable registry does ' +
      'not expect one — a pane or a workspace that runs no Butchr MCP server has always been ' +
      'reached by the composer'
  };
}

/**
 * Write one addressed frame to one connection, or say why not.
 *
 * ONE COPY, AND THAT IS THE WHOLE REASON THIS IS A FUNCTION (KAN-247, T4)
 *
 * Two callers need this now: the `channel_send` action KAN-244 added, and
 * `butchr_send_to_agent`'s channel route, which is T4's subject. The tempting
 * shape is for the second to grow its own switch check and its own `resolve`,
 * and it is the shape this codebase has already been burned by — KAN-145's
 * defect was one fact with two implementations, and the copy nobody exercised
 * was the wrong one. A second copy of *the gate in particular* would be worse
 * than most: a `butchr_send_to_agent` that forgot to consult the switch would
 * route over a channel the fleet believes is off, and §1.2's mitigation — the
 * thing that made putting this capability on the shared server defensible — is
 * exactly the claim that could not then be made.
 *
 * **The order of the refusals moved to {@link carrierFor} under KAN-274 and is
 * consulted from here rather than repeated.** It moved because a *second* reader
 * of the same question appeared — `list_agents` — and answered it differently;
 * see that function's header. The ordering itself is unchanged, and the reasons
 * for it are unchanged: the switch is read before the map, so a disabled channel
 * answers `channel-disabled` for a disconnected agent as well as a connected one
 * rather than leaking the identity map through a shut gate, and `selfcheck-failed`
 * sits between them so a degraded agent that is also disconnected reads as
 * degraded — the cause somebody can act on — rather than as an incidental
 * `no-connection`. What this function still owns is everything below the verdict:
 * resolving the connection, writing the frame, and the `socket-closed` race that
 * only a writer can observe.
 *
 * **`selfcheck-failed` is what makes T5's fallback a behaviour rather than a
 * label** (KAN-248), and refusing here — where the carrier is chosen — is the
 * only thing that makes it true of an agent's *traffic* rather than of its row.
 * KAN-274 is the same argument applied to a registration that has gone: a row
 * that said `channel` while the next message took a Ctrl+C was a label with no
 * behaviour under it.
 *
 * `selfCheck` and `managed` are both optional and their ABSENCE ROUTES AS BEFORE.
 * A daemon wired without them — the daemon's own internal router, and every
 * harness — behaves exactly as it did before KAN-248 and KAN-274 respectively. So
 * does an agent with no verdict recorded: unchecked is not failed, and
 * channel-selfcheck.ts argues at length why conflating the two would take the
 * fleet off channels on every daemon restart.
 */
export function routeChannelMessage(opts: {
  registry: AgentConnectionRegistry;
  address: AgentAddress;
  content: string;
  /**
   * String values only — see {@link ChannelMeta}. A boolean here was six
   * undelivered guardian pokes reported as delivered (KAN-319), and it is a
   * compile error rather than a comment for that reason.
   */
  meta?: ChannelMeta;
  /** KAN-248's verdicts. Asked one question: has this agent been degraded? */
  selfCheck?: { degraded: (address: AgentAddress) => boolean };
  /**
   * Whether the durable registry expects this agent to be running (KAN-274).
   *
   * Optional, and **its absence answers `no-connection` exactly as before** — a
   * harness or an internal router wired without it keeps the pre-KAN-274
   * behaviour rather than acquiring a refusal nobody wired a reader for. Same
   * shape and same reason as `selfCheck` above.
   */
  managed?: (address: AgentAddress) => boolean;
}): ChannelRouteOutcome {
  const { registry, address, content, meta, selfCheck, managed } = opts;

  // REFUSED RATHER THAN WRITTEN, AND BEFORE ANYTHING ELSE IS READ (KAN-319).
  //
  // A frame whose meta the client cannot parse is one that would be written
  // successfully, reported `delivered`, and then discarded before it reached a
  // model — the failure this fleet spent an evening unsupervised by. There is no
  // fourth outcome to invent for it: `delivered` was never lying, it was
  // answering C1 and C2 correctly about a frame that could not satisfy C3, and
  // the honest repair is to stop writing such a frame rather than to add a state
  // that describes having written one.
  //
  // FIRST, ahead of the kill switch, and that placement is deliberate rather
  // than incidental. This is the only refusal here that is about the CALLER'S
  // OWN ARGUMENT rather than about the state of the fleet, so it is the only one
  // whose answer does not depend on a switch, a self-check or a map — and a
  // caller holding meta this client will drop has a bug whether or not channels
  // happen to be on. Reporting `channel-disabled` to it would send it to look at
  // the fleet for a defect that is in its own call.
  //
  // **It does not weaken the gate ordering KAN-274 argues for.** That ordering
  // exists so a shut gate cannot leak the identity map's contents; this branch
  // reads neither the map nor the switch and reveals nothing about either — it
  // reports back only what the caller itself passed in. Nothing is written on
  // this path, which is the property the gate is actually protecting.
  //
  // In-process callers cannot reach this branch — `ChannelMeta` makes their
  // mistake a compile error — which is deliberate: the assertion is here for
  // `channel_send`'s wire input, whose `meta` arrives as parsed JSON typed
  // `any`, and a caller that meets it has bypassed a type.
  const unrenderable = unrenderableMetaEntries(meta);
  if (unrenderable.length) {
    return {
      routed: false,
      reason: 'meta-not-renderable',
      detail:
        `${describeAddress(address)}: nothing was written, because this client would have ` +
        `accepted the frame and then dropped it in silence — ${unrenderable.join('; ')}. ` +
        `Channel meta becomes attributes on the <channel> tag, so its values must be strings ` +
        `(docs/channel-delivery.md). Stringify the value and send it again; a frame refused ` +
        `here is one that would otherwise have been reported delivered and never arrived`
    };
  }

  // THE ORDER LIVES IN `carrierFor` AND IS CONSULTED, NOT REPEATED (KAN-274).
  // The gate is still read before the map — literally, not just in the answer:
  // `resolve` is not called at all until emission is on and the agent is not
  // degraded, so a shut gate cannot leak the identity map's contents even by
  // timing.
  const emissionEnabled = channelEmissionEnabled();
  const degraded = selfCheck?.degraded(address) ?? false;
  const target = emissionEnabled && !degraded ? registry.resolve(address) : undefined;

  const verdict = carrierFor({
    emissionEnabled,
    degraded,
    registered: target !== undefined,
    managed: managed?.(address) ?? false,
    switchPath: CHANNEL_SWITCH_PATH
  });

  if (verdict.transport !== 'channel' || !target) {
    // `refusal` is non-null on every non-`channel` branch by construction; the
    // fallback exists so this narrows without a cast rather than because a
    // fifth state is expected.
    return {
      routed: false,
      reason: verdict.refusal ?? 'no-connection',
      detail: `${describeAddress(address)}: ${verdict.detail}`,
      ...(verdict.refusal === 'channel-disabled' ? { switchPath: CHANNEL_SWITCH_PATH } : {})
    };
  }

  const wrote = writeJsonLine(target.socket, {
    action: CHANNEL_MESSAGE_ACTION,
    content,
    meta
  });

  // NAMED ON THE WAY OUT, NOT REFUSED ON THE WAY IN (KAN-325).
  //
  // Computed here rather than beside the `meta-not-renderable` branch above so
  // that the two are not read as one gate with two reasons. They are opposite
  // decisions about opposite failures: a bad VALUE loses the whole frame, so the
  // frame is not written; a bad KEY loses one attribute, so the frame IS written
  // and the caller is told what did not survive it. Measured, both of them —
  // KAN-319 from the recipient side for the value, KAN-325 for the key.
  //
  // At the routing point rather than in `channel_send` for the reason this module
  // gives for `carrierFor`: a property established where the carrier is chosen is
  // true of an agent's TRAFFIC, whereas one established in a single action handler
  // is true only of that handler's callers. Today the type means every in-process
  // producer scores empty here, which costs a regex over at most five keys.
  const droppedMetaKeys = undeliverableMetaKeys(meta);

  // `resolve` skips destroyed sockets, so this is the narrow race where one died
  // between the lookup and the write. Reported rather than retried: a retry
  // would be a second delivery attempt the caller did not ask for, and the
  // caller can see a refusal and decide.
  return wrote
    ? {
        routed: true,
        connectionId: target.id,
        address: target.address,
        ...(droppedMetaKeys.length ? { droppedMetaKeys } : {})
      }
    : {
        routed: false,
        reason: 'socket-closed',
        detail: 'the connection closed before the frame could be written'
      };
}
