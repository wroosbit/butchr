// Which agents this daemon has started recently, for capacity's starts-in-flight
// term — held once for the process, because holding it per connection made the
// answer depend on who was asking (KAN-365).
//
// WHAT WENT WRONG
//
// KAN-258's ledger was a field on `MessageRouter`, and daemon.ts constructs one
// router **per client connection**, plus one more for its own reconciliation.
// So there were as many ledgers as there were connected clients, each recording
// only the starts that came in over its own socket, and `unobservedStarts.count`
// was a property of *which socket you asked down* rather than of the machine.
//
// That is the whole of the oscillation four samples were taken of on 2026-08-12
// and no cause was proposed for. It was never one counter moving:
//
//     23:54Z  epic/KAN-59   count 1        <- its connection had started an agent
//     01:00Z  epic/KAN-203  count 0        <- a different connection, empty ledger
//     01:03Z  epic/KAN-59   count 1        <- the first connection again
//
// Read as one instrument it alternates. Read as three instruments it is
// constant, and the sampling interval never mattered. `epic/KAN-203` asking for
// a fourth reading rather than inheriting `epic/KAN-59`'s is what made the
// disagreement visible at all — two observers is what showed there was
// something to explain, and it also happens to be why the "movement" they were
// reasoning about was an artifact of pooling their readings.
//
// A client reload or a daemon restart drops a connection and its ledger with
// it, which is the other half: a count that "cleared" had usually lost its
// router rather than reconciled anything.
//
// WHY ONE PER PROCESS IS THE RIGHT SCOPE
//
// The term answers "what has this *machine* admitted that no instrument has
// priced yet". The machine is the process's scope, not the socket's. The
// daemon's own reconciler starts agents at boot with no client connected at
// all — those starts are exactly the ones KAN-258 was filed about, and under
// the old scoping they were invisible to every client that connected
// afterwards.
//
// Injectable rather than imported directly by the router so that a proof can
// hand two routers two ledgers and watch them disagree, which is how the
// defect above is demonstrated rather than described.

/**
 * A start this daemon made, and whether the fleet census has ever confirmed it.
 *
 * `seen` is what makes pruning exact instead of a race. An entry is dropped
 * only once the census has reported that agent *and* it has since gone — never
 * merely because it is absent, which is the state every start is in for its
 * first moments and is precisely the state this term exists to charge for.
 */
interface StartEntry {
  at: number;
  seen: boolean;
}

/**
 * A leak guard, and named as one so nobody reads it as policy.
 *
 * An entry whose agent never reaches the census — an activation that succeeded
 * onto a pane that then died — is never marked `seen` and so is never dropped
 * by reconciliation. It stops being *charged* on its own after
 * `UNOBSERVED_START_MAX_AGE_SECONDS` (capacity.ts); this only stops the map
 * growing without bound on a daemon that runs for weeks.
 *
 * That sentence used to be written here without the bound existing on the path
 * that mattered, which is the other half of KAN-365 — see
 * `unobservedStartsAmong`.
 */
const MAX_ENTRIES = 256;

export class StartLedger {
  private readonly entries = new Map<string, StartEntry>();

  /** Record that an agent was started. Called on the success path of both
   * activation routes. */
  record(agentName: string, at: number): void {
    this.entries.set(agentName, { at, seen: false });
    this.bound();
  }

  /**
   * Reconcile against a census, in the one order that is safe: mark first, drop
   * second. See {@link StartEntry.seen} for why absence alone must never drop.
   */
  reconcile(live: ReadonlySet<string>): void {
    for (const [name, entry] of this.entries) {
      if (live.has(name)) entry.seen = true;
      else if (entry.seen) this.entries.delete(name);
    }
    this.bound();
  }

  /** When each recorded start happened, for `unobservedStartsAmong`. */
  startedAt(): number[] {
    return [...this.entries.values()].map((e) => e.at);
  }

  /** Entries held. For proofs and for the leak guard's own test. */
  get size(): number {
    return this.entries.size;
  }

  private bound(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    // Oldest first, which is also the order in which they stopped mattering.
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [name] of oldest.slice(0, this.entries.size - MAX_ENTRIES)) {
      this.entries.delete(name);
    }
  }
}

/**
 * The one ledger, for the one machine.
 *
 * Every `MessageRouter` uses this unless a caller injects another, so a start
 * recorded over one connection is charged to a capacity question asked over any
 * other — and to the daemon's own, which is the one that has no connection at
 * all.
 */
export const sharedStartLedger = new StartLedger();
