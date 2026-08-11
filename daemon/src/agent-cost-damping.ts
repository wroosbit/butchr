// Believing a measurement, carefully: the damping between what agent-cost.ts
// samples and what capacity.ts divides by.
//
// The instantaneous reading must never reach the arithmetic, because the two
// mistakes it invites are not the same size. Believe too quickly that agents
// are cheap — one idle minute while the whole fleet waits on an API — and the
// cap opens to a fleet the machine cannot carry the moment they all wake,
// which is exactly the desktop-killing incident (KAN-34) this file descends
// from. Believe too slowly that agents are expensive and the only cost is a
// refused activation, which the operator can read, override, or wait out. So
// the filter is asymmetric on purpose: quick to believe an agent is
// expensive, slow to believe it is cheap.
//
// The shape is an EWMA with a per-direction alpha, chosen over a
// high-water-mark window because it needs no history buffer, degrades to
// nothing when the sampler stops feeding it, and its step response is easy to
// state (and is stated, and proved in verify-agent-capacity.mjs sections
// 10–13): at ALPHA_UP = 0.5 a step up is ~87% believed after three windows;
// at ALPHA_DOWN = 0.1 a step down needs ~22 windows to be 90% believed. With
// the daemon's 60-second window that is minutes to charge more and the better
// part of half an hour to charge less — the fast direction protects the
// human, the slow one merely delays an optimism.
//
// Everything here is pure. The state (the previous estimate) belongs to the
// caller — the daemon's sampler loop — so the arithmetic can be driven
// through step responses in a script without a daemon, a clock, or /proc.

import type { AgentCost } from './capacity.js';
import type { AgentCostMeasurement } from './agent-cost.js';

const MIB = 1024 ** 2;

/** Believed per window when the sample says agents got more expensive. */
export const ALPHA_UP = 0.5;
/** Believed per window when the sample says agents got cheaper. */
export const ALPHA_DOWN = 0.1;

/**
 * One damping step: move `previous` toward `sample`, fast upward and slowly
 * downward, per dimension. The first call seeds `previous` with
 * MEASURED_AGENT_COST (the caller does this), so a single flattering window
 * can never swing the estimate to whatever it happened to catch.
 */
export function dampCost(previous: AgentCost, sample: AgentCost): AgentCost {
  const step = (prev: number, next: number) =>
    prev + (next > prev ? ALPHA_UP : ALPHA_DOWN) * (next - prev);
  return {
    residentBytes: step(previous.residentBytes, sample.residentBytes),
    cores: step(previous.cores, sample.cores)
  };
}

/**
 * A finished measurement window reduced to the per-tree cost the damping
 * consumes, or null when the window proved nothing.
 *
 * Null is the degrade signal, and it is deliberately broad: an empty fleet
 * (nothing to measure — the seed is the only honest answer for the *next*
 * agent), a zero or negative core figure (a live claude tree spends *some*
 * CPU every minute; zero means the instrument misread), a resident figure at
 * or below zero or beyond the machine's own RAM (arithmetic gone wrong, not a
 * fleet). A sample rejected here must pull capacity back to the labelled
 * seed rather than leave a stale estimate posing as live — the caller clears
 * its state on null, and verify-agent-capacity.mjs proves each rejection.
 *
 * KAN-276 changed *which* trees are averaged, and changed it **on one dimension
 * only**. That asymmetry is the whole of this comment, because the obvious
 * version of the change — task trees on both dimensions — was measured and
 * rejected.
 *
 * **`cores` is averaged over `m.chargeable`**, the task-agent trees, where it
 * used to be averaged over every `claude` tree on the machine including the
 * supervisors capacity.ts never admits. Measured over 60s and 90s windows on
 * 2026-08-11, a task agent spent 0.187–0.198 core and a supervisor 0.011–0.014
 * — a 14–17x difference in one consistent direction, so including them
 * understated the divisor by ~56%. A smaller divisor is a bigger headroom, so
 * that contamination *loosened* the gate.
 *
 * **`residentBytes` is still averaged over `m.totals`**, every tree, exactly as
 * before this change. On memory the two populations are not distinguishable:
 * the same windows put supervisors at 775 MB against a task agent's 722–844 MB,
 * because a supervisor is the same `claude` binary holding the same MCP servers.
 * Excluding them therefore buys no accuracy, halves the sample, and moves the
 * figure in whichever direction the sample happens to fall — measured on a live
 * fleet at 795 MB → 778 MB, which *lowered* the divisor and raised
 * `headroomByMemory` from 7 to 8.
 *
 * That is an increase in admissions, which this ticket forbids outright, and it
 * is not a safe thing to ship on the argument that some other term will
 * probably bind. Leaving the memory divisor alone is what makes the whole
 * change monotone: `headroomByMemory` cannot move at all, and the memory defect
 * — which is real — is fixed where it actually lives, as capacity.ts's
 * SUPERVISOR_MEMORY_BYTES reserve against the static cap.
 *
 * **"No task agents running" now reaches this function, and the honest answer
 * is the seed on *both* dimensions.** Before KAN-276 the fleet's supervisors
 * kept the tree count above zero whether or not any task agent existed, so an
 * all-supervisor fleet produced a confident-looking figure that no task agent
 * had contributed to — the reading this ticket was filed on divided by 0.123
 * core with `running: 0`. Now that sample is empty and empty degrades, which is
 * the rule the paragraph above already stated: nothing to measure means the
 * seed is the only honest answer for the *next* agent. Memory degrades with it
 * rather than carrying on alone, because publishing half a measurement as
 * though it were a whole one is the labelling failure KAN-44 exists to prevent.
 */
export function sampleFromMeasurement(
  m: AgentCostMeasurement,
  machineTotalBytes: number
): AgentCost | null {
  if (!Number.isFinite(m.elapsed) || m.elapsed <= 0) return null;
  const chargeable = m.chargeable;
  if (!chargeable || !Number.isFinite(chargeable.agents) || chargeable.agents <= 0) return null;
  const all = m.totals;
  if (!all || !Number.isFinite(all.agents) || all.agents <= 0) return null;

  const cores = chargeable.cores / chargeable.agents;
  const residentBytes = (all.residentMb * MIB) / all.agents;

  if (!Number.isFinite(cores) || cores <= 0) return null;
  if (!Number.isFinite(residentBytes) || residentBytes <= 0) return null;
  if (residentBytes > machineTotalBytes) return null;

  return { cores, residentBytes };
}

/**
 * The mean resident memory of one supervisor tree over this window, or null
 * when the window contained none.
 *
 * Separate from {@link sampleFromMeasurement} because it feeds a different term
 * with a different shape: supervisors are charged as a *reserve* against the
 * static cap (capacity.ts's SUPERVISOR_RESERVE), never as a divisor. Their CPU
 * is deliberately not returned — see capacity.ts for why the exemption survives
 * on the dimension where they are 14x cheaper and does not on the one where
 * they are within noise of a task agent.
 *
 * Null rather than zero when there are no supervisors: zero is a measurement
 * that supervisors are free, and no measurement is not that.
 */
export function supervisorMemoryFromMeasurement(
  m: AgentCostMeasurement,
  machineTotalBytes: number
): number | null {
  const s = m.supervisors;
  if (!s || !Number.isFinite(s.agents) || s.agents <= 0) return null;
  const residentBytes = (s.residentMb * MIB) / s.agents;
  if (!Number.isFinite(residentBytes) || residentBytes <= 0) return null;
  if (residentBytes > machineTotalBytes) return null;
  return residentBytes;
}
