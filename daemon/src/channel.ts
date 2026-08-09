import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';

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
