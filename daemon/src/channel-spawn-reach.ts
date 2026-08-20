import type { AgentAddress } from './agent-connections.js';
import type { ChannelReach } from './channel.js';

/**
 * WHAT A PARTICULAR AGENT'S SPAWN DECIDED ABOUT ITS CHANNEL (KAN-497).
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES, AND WHY IT WAS A GAP RATHER THAN AN OVERSIGHT
 * ---------------------------------------------------------------------------
 *
 * {@link import('./agent-runtime.js').AgentRuntime.channelReach} answers about a
 * runtime's **spawn shape** — *"can agents this runtime spawns hear us at all?"*
 * — and it is deliberately a property rather than a lookup, because for a
 * runtime whose spawns structurally cannot carry the flag the answer is the
 * same for every agent forever. `HerdrBridge` is not that runtime. Its spawns
 * **can** carry the flag, and whether any one of them did depends on the kill
 * switch **as it stood at the moment that pane started**:
 *
 * - an agent spawned while the switch was off has no flag and keeps none for
 *   its whole life — argv is fixed at process start;
 * - flipping the switch on afterwards changes nothing for it, while the daemon
 *   happily resolves it in KAN-243's identity map and writes frames its client
 *   discards in silence.
 *
 * `launchers.ts` has said exactly that in prose since KAN-246, and it describes
 * the KAN-495 defect on the herdr path. What was missing was never the
 * knowledge — `AgentSpawn.channelEnabled` is that fact, taken at the one site
 * that takes it, and it has crossed `setAgentSpawnedListener` on every herdr
 * spawn since KAN-294. **Nothing kept it.** The listener used it for
 * channel-startup supervision and dropped it on the floor. This is where it is
 * kept.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY THIS IS A SIBLING OF `ChannelSelfCheckStore` AND NOT A FIELD ON IT
 * ---------------------------------------------------------------------------
 *
 * KAN-497's own sketch proposed keeping this verdict *inside*
 * `ChannelSelfCheckStore` — it is already keyed by address, already lives for
 * the daemon's life, and is already consulted by `routeChannelMessage`, so the
 * shape looks identical. **The shape is identical and the LIFETIME is not**,
 * and putting one inside the other would delete this record on two paths that
 * are correct for a self-check and wrong for a spawn:
 *
 * - `ChannelSelfCheckStore.releaseConnection` drops a verdict when the socket
 *   it was about closes. A spawn verdict is not about a socket. An agent that
 *   reconnects has the same argv it was started with, so dropping the record on
 *   a socket close would turn a known `'not-loaded'` back into `'unknown'` on
 *   the first reconnect — silently, and in the direction that resumes writing
 *   frames nobody can read.
 * - `ChannelSelfCheckStore.forget` is called at the top of a channel-enabled
 *   spawn, deliberately, so an agent reads `unchecked` rather than carrying a
 *   previous run's verdict. Correct there; here the re-spawn is precisely the
 *   event that PRODUCES the new record, and forgetting it in the same breath
 *   would leave the window with no answer at all.
 *
 * So the two stores sit beside each other and answer different questions about
 * the same address, which is what the ticket asked for in substance. They are
 * consulted by the same route in the same order they always were.
 *
 * ---------------------------------------------------------------------------
 * IN MEMORY, AND THAT IS NOT AN OMISSION
 * ---------------------------------------------------------------------------
 *
 * Same argument `ChannelSelfCheckStore` makes for itself: a spawn verdict is
 * about a process that is running right now, and a daemon that restarts has no
 * panes it spawned to have verdicts about. Persisting them would produce the
 * artefact this codebase keeps paying for — a stored fact that outlives what it
 * described and reads as current. **An agent that outlives a daemon restart has
 * no record here and reads `'unknown'`, which routes exactly as this daemon
 * routed before KAN-495 and claims nothing.** That is the intended answer, not
 * a degradation to be repaired.
 */

/** The canonical form two spellings of one agent must collapse to. */
function canonical(address: AgentAddress): string {
  return `${address.type.trim().toLowerCase()}/${address.key.trim().toLowerCase()}`;
}

/**
 * A spawn's three-state channel verdict as a reach, where there is one to have.
 *
 * ⚠ **`null` returns `undefined`, and that is the whole of this function.**
 * `AgentSpawn.channelEnabled` is `true | false | null` and `null` means *no
 * spawn decided this* — it is the absence of a verdict, never a verdict of
 * "no channel". There is nothing to record for it, so nothing is recorded, and
 * the reader falls through to whatever the runtime can say about its own spawn
 * shape.
 *
 * **Storing `null` as `'unknown'` would be the subtle version of the same
 * defect.** Such a record reads exactly like no record at the one place that
 * matters — both answer `'unknown'` — while being able to **shadow a runtime
 * that does know**: under CrabCast, whose `channelReach` is derived from the
 * argv it actually sends (KAN-496), a stored `'unknown'` would overwrite a
 * correct `'loaded'` with a shrug. Absence composes; a recorded shrug does not.
 */
export function reachFromSpawnVerdict(channelEnabled: boolean | null): ChannelReach | undefined {
  if (channelEnabled === true) return 'loaded';
  if (channelEnabled === false) return 'not-loaded';
  return undefined;
}

/**
 * Every agent's spawn-time channel verdict, keyed by address.
 *
 * The one writer is `daemon.ts`'s `setAgentSpawnedListener` closure; the one
 * reader is the `channelReach` thunk that `routeChannelMessage` and the
 * `list_agents` row both consult. KAN-274 made those one function so a row
 * cannot report a carrier the next send will not take, and that property is
 * what this store has to preserve: it is asked by the route and by the report,
 * and it answers both from the same map.
 */
export class ChannelSpawnReachStore {
  private readonly byAddress = new Map<string, ChannelReach>();

  /**
   * Record what this spawn decided. A `null` verdict records NOTHING — see
   * {@link reachFromSpawnVerdict} for why that is the point rather than a
   * shortcut.
   *
   * Returns what was stored, or `undefined` where nothing was, so a caller that
   * wants to log the decision does not have to re-derive it.
   *
   * **Unconditional overwrite, and the previous value is not consulted.** A
   * re-spawn is the event that makes the old record wrong: the pane it
   * described is gone and the switch may have moved since. An agent respawned
   * with the switch off must read `'not-loaded'` immediately, however loudly
   * its previous incarnation could hear us.
   */
  public record(address: AgentAddress, channelEnabled: boolean | null): ChannelReach | undefined {
    const reach = reachFromSpawnVerdict(channelEnabled);
    if (reach === undefined) return undefined;
    this.byAddress.set(canonical(address), reach);
    return reach;
  }

  /**
   * What this agent's own spawn decided, or `undefined` where nothing here
   * established it.
   *
   * ⚠ **`undefined` is NOT `'not-loaded'`, and collapsing the two would be a
   * fleet outage** — the same three-valued discipline `ChannelReach` itself is
   * written around. Agents that outlive a daemon restart have no record, and
   * they are fine; answering `'not-loaded'` for them takes a working fleet off
   * channels for a fact nobody established. The caller's fall-through is to the
   * runtime's own spawn-shape answer, which under herdr is `'unknown'`.
   */
  public get(address: AgentAddress): ChannelReach | undefined {
    return this.byAddress.get(canonical(address));
  }

  /**
   * Drop this agent's record, so it reads as unrecorded again.
   *
   * Nothing in the daemon calls this today, and it exists for two readers that
   * are not the product: a session that ended and whose pane is gone, should a
   * later ticket decide that is worth reflecting, and the red drive in
   * `verify-herdr-channel-reach-per-agent.mjs`, which deletes a real record to
   * show that the answer falls back to `'unknown'` rather than to
   * `'not-loaded'`. That drive is AC2 of KAN-497 and it needs a way to take the
   * record away that is not "restart the daemon".
   */
  public forget(address: AgentAddress): boolean {
    return this.byAddress.delete(canonical(address));
  }

  /**
   * A census of what is held, for a diagnostic and for proofs.
   *
   * Counts rather than addresses: this is for a log line and a health field,
   * and a list of every agent's address is a different thing with a different
   * audience.
   */
  public describe(): { loaded: number; notLoaded: number; total: number } {
    let loaded = 0;
    let notLoaded = 0;
    for (const reach of this.byAddress.values()) {
      if (reach === 'loaded') loaded++;
      else if (reach === 'not-loaded') notLoaded++;
    }
    return { loaded, notLoaded, total: this.byAddress.size };
  }
}
