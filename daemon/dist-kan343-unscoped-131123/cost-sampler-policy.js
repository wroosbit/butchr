// What the cost sampler does with a window that produced no sample — because
// "no sample" was two situations wearing one answer, and the answer was right
// for one of them (KAN-365).
//
// THE SITUATION THIS EXISTS FOR
//
// daemon.ts samples the fleet once a minute. When a window yields nothing it
// called `degradeCostMeasurement`, which cleared the estimate in memory, and
// deleted the copy on disk, and left capacity dividing by the 2026-07-31 seed.
// That is correct when the instrument failed. It is wrong when there was simply
// nothing to measure, and the second is the ordinary end of every working day:
// the last task agent finishes, the next window is empty, and the machine
// forgets what an agent costs on it.
//
// Measured on the filing machine on 2026-08-12, thirteen minutes apart:
// `agentCores 0.195, cap 12` while agents ran, `agentCores 0.75, cap 3` once
// they had stopped. The cap fell to a quarter at the exact moment the machine
// was most free, and `epic/KAN-59` was refused three activations against a
// 68-ticket backlog with nothing running.
//
// WHY THE SPLIT IS A TYPE AND NOT A BOOLEAN
//
// {@link MeasurementGap} has no default. A caller reporting a gap must say
// which kind it is, and {@link decideOnMissingSample} switches exhaustively
// with a `never` fallthrough, so a third kind is a compile error at both ends
// rather than a silent inheritance of whichever behaviour was written first.
// That is deliberate: the defect being fixed is precisely one situation
// inheriting another's answer because nothing in the code made them distinct.
// An assertion here would be deletable; this is not expressible.
//
// WHAT IS NOT CHANGED
//
// The failure path. An unreadable /proc, a sample that fails validation, an
// estimate larger than the machine — all still discard, in memory and on disk,
// exactly as before. `degrade, never guess` is untouched for the case it was
// written about. What changes is that an *absent subject* stops being filed
// under a *broken instrument*.
import { COST_ESTIMATE_MAX_AGE_MS } from './agent-cost-store.js';
/**
 * How long a measurement may be held on past the fleet that produced it.
 *
 * A DECISION, NOT A MEASUREMENT — said plainly, as STALL_REFUSE_PERCENT says
 * it, because the rest of this codebase is careful about the difference and no
 * observed outage calibrated this.
 *
 * It is calibrated from the two sides instead. Below it, the figure is a real
 * measurement of the right population on unchanged hardware, and the cost of
 * believing it is bounded by the three live terms and by the seed charged
 * against every start in flight (see capacity.ts). Above it, the fleet that
 * produced it has been gone long enough that it is a claim about another
 * afternoon's work, and the honest answer is the labelled seed — which is what
 * happens today, so the ceiling is where this change stops being a change.
 *
 * Four hours: long enough that an overnight-idle fleet still starts the morning
 * knowing what it costs, which is the case this ticket was filed on, and short
 * enough that no figure survives to describe a machine doing something else
 * entirely.
 *
 * It is deliberately **longer** than agent-cost-store.ts's
 * {@link COST_ESTIMATE_MAX_AGE_MS}, and the asymmetry is the point rather than
 * an oversight: that constant bounds a figure crossing a **restart**, where the
 * daemon cannot know what happened while it was down, and it is imported here
 * so the relationship is stated in code rather than in two comments that can
 * drift. This one bounds a figure held by a process that has been watching the
 * whole time and knows exactly why there is nothing to measure — it was there
 * when the last agent finished.
 *
 * BUTCHR_STALE_COST_MAX_MINUTES overrides it, for the reason every constant in
 * capacity.ts has an override: an operator who has decided should not have to
 * argue. Zero disables retention outright, which restores the pre-KAN-365
 * behaviour exactly and is the honest way to turn this off.
 */
export const STALE_MEASUREMENT_MAX_AGE_MS = Math.max(4 * 60 * 60 * 1000, COST_ESTIMATE_MAX_AGE_MS);
/** The ceiling after any operator override. Exported so a report and a proof
 * read the same number the sampler does. */
export function staleMeasurementMaxAgeMs(env = process.env) {
    const raw = env.BUTCHR_STALE_COST_MAX_MINUTES;
    if (raw === undefined || raw.trim() === '')
        return STALE_MEASUREMENT_MAX_AGE_MS;
    const minutes = Number(raw);
    // Zero is allowed and means "do not retain", which has to be distinguishable
    // from not having set the variable — the same distinction
    // BUTCHR_SUPERVISOR_MEMORY_MB draws for the same reason.
    if (!Number.isFinite(minutes) || minutes < 0) {
        console.warn(`BUTCHR_STALE_COST_MAX_MINUTES=${raw} is not a non-negative number; ignoring it`);
        return STALE_MEASUREMENT_MAX_AGE_MS;
    }
    return minutes * 60 * 1000;
}
/**
 * The whole decision, as a pure function of the gap, what is held, and the time.
 *
 * Pure and exported so the proof drives *this* function rather than a
 * reconstruction of it. The gap between "the arithmetic is right" and "the
 * daemon takes this path" is thereby narrowed to a single call site in
 * daemon.ts — which is still a seam, and verify-idle-fleet-capacity.mjs's
 * header says so rather than leaving a reader to assume otherwise (KAN-145).
 */
export function decideOnMissingSample(gap, held, now, maxAgeMs = STALE_MEASUREMENT_MAX_AGE_MS) {
    switch (gap.kind) {
        case 'instrument-failed':
            return { action: 'degrade', reason: gap.reason };
        case 'nothing-to-measure': {
            // Nothing to hold on to: this is a fleet that has never measured
            // anything, so the seed is the only figure there has ever been and
            // retention has no opinion about it.
            if (!held)
                return { action: 'degrade', reason: gap.reason };
            const ageMs = now - held.sampledAt;
            // A figure stamped in the future is a clock that moved, not a fresh
            // measurement, and believing it would make the ceiling unreachable. It is
            // the store's rejection applied to the same hazard on the in-memory path.
            if (!Number.isFinite(ageMs) || ageMs < 0) {
                return {
                    action: 'degrade',
                    reason: `${gap.reason}, and the held measurement is stamped in the future`
                };
            }
            if (maxAgeMs <= 0) {
                return { action: 'degrade', reason: `${gap.reason}; retention is disabled` };
            }
            if (ageMs > maxAgeMs) {
                return {
                    action: 'degrade',
                    reason: `${gap.reason}, and the last measurement is ${Math.round(ageMs / 60000)} minutes old — ` +
                        `past the ${Math.round(maxAgeMs / 60000)}-minute ceiling, so it is no longer evidence ` +
                        'about this machine'
                };
            }
            return {
                action: 'retain',
                // Relabelled, never recomputed. Every figure is the one the daemon
                // published when it had a fleet to measure; only `provenance` moves,
                // which is what lets a reader tell a live measurement from a held one
                // without the arithmetic changing underneath them.
                measured: { ...held, provenance: 'stale' },
                ageMs,
                reason: gap.reason
            };
        }
        default: {
            // Unreachable by construction. If a third kind is ever added, this line
            // stops compiling and names it — which is the whole reason the gap is a
            // discriminated union rather than a boolean.
            const exhaustive = gap;
            return exhaustive;
        }
    }
}
