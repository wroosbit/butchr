// The damped cost estimate, written down — because it was the one piece of
// capacity state a restart threw away, and since KAN-201 the cap divides by it.
//
// WHAT THIS IS FOR
//
// agent-cost-damping.ts is a filter with state: the previous estimate. That
// state lived in a `let` in daemon.ts, so every daemon start began the filter
// from MEASURED_AGENT_COST — the 0.75-core seed measured on a laptop on
// 2026-07-31, chosen when nothing divided by it. At ALPHA_DOWN, walking from
// 0.75 back down to the ~0.05 a real fleet costs takes on the order of
// twenty-five minutes, and for all of that time the estimate is high, labelled
// `measured`, and dividing the cap. Observed on 2026-08-06: `cap 19 (bound by
// memory)` before a deploy, `cap 3 (bound by cpu)` an hour after it, with the
// published estimate asserting 3.15 cores of agent CPU on a machine reporting
// 1.94 busy in total. That is KAN-204.
//
// Everything else that matters across a restart is already durable — which
// agents should exist (agent-registry.ts), what work they were doing
// (work-state.ts). This is the same argument applied to the one number the cap
// now depends on: a restart is not new information about what an agent costs,
// so it should not reset what we know.
//
// WHY A WHOLE-FILE REPLACE RATHER THAN AN APPEND
//
// The opposite choice from agent-registry.ts, and for the opposite reason. The
// registry's unit of change is one event and its history is the question;
// here there is exactly one fact — the current estimate — rewritten every
// sixty seconds forever. An append-only log of that would grow without bound
// to answer a question only its last line can answer. So: write a temp file,
// fsync it, rename over the target. Rename is atomic within a directory, so a
// reader either sees the whole previous estimate or the whole new one, never a
// torn one — and a crash mid-write leaves the previous estimate intact, which
// is the failure mode worth engineering for.
//
// WHY IT EXPIRES
//
// A restart takes seconds; a machine that has been off for a day comes back to
// a different fleet doing different work, and an estimate from that other era
// is not evidence about this one. {@link COST_ESTIMATE_MAX_AGE_MS} is the line
// between the two. Past it the file is ignored and capacity answers from the
// labelled seed exactly as it did before this file existed — the degraded path
// is the old behaviour, which is what makes it safe to degrade to.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
import type { MeasuredAgentCost } from './capacity.js';

/** Where the estimate lives. One small file, next to the registry. */
export const COST_ESTIMATE_PATH = path.join(BUTCHR_DIR, 'agent-cost.json');

/**
 * How old a persisted estimate may be and still describe this machine.
 *
 * Fifteen minutes. The case this exists for — a deploy restart — is measured
 * in seconds, so anything near this bound is already an unusual restart. It is
 * deliberately shorter than the ~25 minutes the damping takes to walk down from
 * the seed, so that a stale file can never do more harm than the situation it
 * is replacing: past this age, the seed is the honest answer again.
 */
export const COST_ESTIMATE_MAX_AGE_MS = 15 * 60_000;

/**
 * A sample dated further into the future than this is a clock that moved, not
 * a measurement. Small tolerance for the ordinary case of a few milliseconds
 * of skew between writing and reading.
 */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * Persist the estimate the daemon just published.
 *
 * Best-effort by construction: a capacity estimate that cannot be written down
 * is not worth failing a sampler tick over, and the consequence of losing it is
 * the pre-KAN-204 behaviour rather than a wrong answer. Returns whether it
 * landed, so a caller that wants to say so in a log can.
 */
export function saveCostEstimate(
  measured: MeasuredAgentCost,
  file: string = COST_ESTIMATE_PATH
): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    ensureButchrDir();
    // `provenance` is deliberately not written: it describes how the *reader*
    // came by the figure, and every reader of this file came by it the same
    // way. Writing it would let a restored estimate be saved back as
    // `restored` and then re-read as such indefinitely, which is a label
    // outliving the fact it described.
    const body = JSON.stringify({
      residentBytes: measured.residentBytes,
      cores: measured.cores,
      sampledAt: measured.sampledAt,
      windowSeconds: measured.windowSeconds,
      agentTrees: measured.agentTrees,
      // Written when there is one. A restart with supervisors already up would
      // otherwise fall back to the seed for the first window, which is the
      // conservative direction but throws away a measurement for no reason
      // (KAN-276). Absent when the window held no supervisor: null is not zero.
      supervisorResidentBytes: measured.supervisorResidentBytes ?? null
    });
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

/**
 * Read back an estimate a previous daemon published, or null.
 *
 * Null for every reason there could be one — no file, unparseable, a field
 * missing or not a number, a figure outside what this machine could produce, a
 * sample from the future, a sample too old. Null means "capacity answers from
 * the seed", which is what it did before this file existed, so every rejection
 * here degrades to known behaviour rather than to a new one.
 *
 * `now` and `machineTotalBytes` are parameters rather than reads so the whole
 * of this can be driven from a script without a clock or a machine.
 */
export function loadCostEstimate(
  file: string = COST_ESTIMATE_PATH,
  now: number = Date.now(),
  machineTotalBytes: number = os.totalmem()
): MeasuredAgentCost | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const { residentBytes, cores, sampledAt, windowSeconds, agentTrees } = parsed;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!positive(residentBytes) || !positive(cores)) return null;
  if (!positive(windowSeconds) || !positive(agentTrees)) return null;
  // Validated on the same terms as the agent figure and dropped rather than
  // rejecting the whole record: a file written before KAN-276 has no such
  // field, and the rest of it is still a good measurement of this fleet. A
  // dropped figure falls back to the seed, which reserves more, not less.
  const supervisorResidentBytes =
    positive(parsed.supervisorResidentBytes) &&
    parsed.supervisorResidentBytes <= machineTotalBytes
      ? (parsed.supervisorResidentBytes as number)
      : null;
  if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt)) return null;
  // The same ceiling sampleFromMeasurement applies to a live window: one agent
  // tree cannot hold more memory than the machine has.
  if (residentBytes > machineTotalBytes) return null;
  if (sampledAt > now + FUTURE_TOLERANCE_MS) return null;
  if (now - sampledAt > COST_ESTIMATE_MAX_AGE_MS) return null;

  return {
    residentBytes,
    cores,
    sampledAt,
    windowSeconds,
    agentTrees,
    supervisorResidentBytes,
    provenance: 'restored'
  };
}

/**
 * Forget the persisted estimate.
 *
 * Called on exactly the same condition that clears the live one: if a figure is
 * not trustworthy enough to publish now, it is not trustworthy enough to
 * publish after a restart. One rule rather than two — otherwise a sampler that
 * degraded would clear the estimate in memory and leave a copy on disk waiting
 * to resurrect it.
 */
export function clearCostEstimate(file: string = COST_ESTIMATE_PATH): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, which is the state we wanted.
  }
}
