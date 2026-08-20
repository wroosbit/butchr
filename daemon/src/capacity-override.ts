// The agent cap, settable while the daemon runs — because the one moment you
// need to scale down is the moment you cannot afford a restart.
//
// WHAT THIS IS FOR
//
// `BUTCHR_MAX_AGENTS` lives in a systemd drop-in, so changing it means
// `systemctl --user restart butchr-daemon`. A restart drops every channel
// registration and every session, and sessions do not re-form by themselves —
// they are made by activation. So the operator's only throttle costs the fleet
// its addressability at exactly the moment the machine is already struggling.
// KAN-544 is the human asking for that throttle to be usable under load.
//
// The cap was already re-read per admission: `readCapacity()` calls
// `optionsFromEnv()` fresh every time. The only thing fixing it at process
// start was the *source* — `process.env`, which nothing outside the process can
// rewrite. So nothing here restructures anything. A source that can change
// while the process runs is the whole of the fix.
//
// WHY A FILE RATHER THAN AN IN-MEMORY SETTER, WHICH IS THE LOAD-BEARING CHOICE
//
// An MCP round-trip is exactly what may fail to complete on a thrashing
// machine, and that is the machine this control exists for. `echo
// '{"maxAgents":2}' > ~/.local/share/butchr/capacity-override.json` works when
// almost nothing else does. An in-memory-only control is unavailable in its own
// emergency, which is a control that does not exist for the case it was built
// for. {@link setCapacityOverride} writes this file and is a convenience;
// reading is file-based so that the convenience is never the only way in.
//
// WHY IT DOES NOT EXPIRE — THE OPPOSITE CHOICE FROM agent-cost-store.ts
//
// That file holds a *measurement*, and a measurement of a fleet that has gone
// is not evidence about the fleet that is here, so it ages out. This file holds
// a *decision*. A decision does not become less true while nobody looks at it,
// and an operator who scaled the fleet down before going to bed must not find
// it silently scaled back up. Surviving a restart is a requirement of this
// ticket rather than a side effect: the file is durable precisely so that the
// emergency throttle outlives the emergency.
//
// EVERY REJECTION FALLS THROUGH, AND NEVER TO ZERO
//
// Absent, empty, unparseable, wrong type, zero, negative, fractional, absurd —
// all of them return null, and null means "this file said nothing", which is
// the behaviour that existed before it did. That is deliberate and it is the
// direction that matters: a half-written file must not be readable as `cap 0`,
// because a cap of 0 admits nothing and would take the fleet down by way of a
// typo. The one edit an operator makes under load is the one most likely to be
// truncated, and it must degrade to the old behaviour rather than to a stop.

import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';

/** Where the runtime cap lives. One small file, next to the cost estimate. */
export const CAPACITY_OVERRIDE_PATH = path.join(BUTCHR_DIR, 'capacity-override.json');

/**
 * A ceiling nobody should be able to set by typo.
 *
 * Not a statement about hardware — the derivation already bounds what a machine
 * can carry, and `cap` is only ever one term in a `min`, so a large number here
 * is inert rather than dangerous. It is a guard on the *shape* of the input: a
 * value this size is a fat-fingered digit or a byte count, not a fleet size,
 * and reading it as a cap would quietly discard the env var that was doing the
 * job.
 */
export const MAX_OVERRIDE_AGENTS = 1024;

export interface CapacityOverride {
  /** The cap the operator set. Always a whole number ≥ 1. */
  maxAgents: number;
  /** Where it was read from, so a report can name the file rather than assert one. */
  path: string;
}

/**
 * The cap an operator set at runtime, or null.
 *
 * Null for every reason there could be one, and null means the env var and then
 * the derivation answer exactly as they did before this file existed. `file` is
 * a parameter rather than a read so the whole of this can be driven from a
 * script without touching the real one.
 */
export function loadCapacityOverride(
  file: string = CAPACITY_OVERRIDE_PATH
): CapacityOverride | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No file, an empty file, a half-written file, a directory — the same
    // answer to all of them, because the caller's next move is the same.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = (parsed as { maxAgents?: unknown }).maxAgents;
  if (!isUsableCap(value)) return null;
  return { maxAgents: value, path: file };
}

/**
 * Whether a value is a cap this daemon will act on.
 *
 * Exported because {@link setCapacityOverride} and the router's refusal must
 * agree with the reader to the digit. A writer that accepts what the reader
 * will later discard is a control that reports success and changes nothing —
 * the failure-as-success shape this repository keeps re-finding.
 */
export function isUsableCap(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_OVERRIDE_AGENTS
  );
}

/**
 * Write the cap down. Returns whether it landed.
 *
 * Temp file, fsync, rename — the same three steps as the cost estimate, and for
 * the same reason: rename is atomic within a directory, so a reader sees the
 * whole previous cap or the whole new one and never a torn one. That matters
 * more here than there, because {@link loadCapacityOverride} runs on the
 * admission path and a torn read would fall through to the env var — a cap
 * silently reverting for one admission is worse than a cap that never moved.
 *
 * Refuses a value {@link isUsableCap} would reject rather than writing a file
 * the reader will ignore.
 */
export function setCapacityOverride(
  maxAgents: number,
  file: string = CAPACITY_OVERRIDE_PATH
): boolean {
  if (!isUsableCap(maxAgents)) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    ensureButchrDir();
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ maxAgents }));
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
 * Forget the runtime cap, handing the question back to `BUTCHR_MAX_AGENTS` and
 * then to the derivation.
 *
 * Idempotent: a file that is already gone is the state the caller wanted, so an
 * absent file is not an error. Returns true when the override is gone by the
 * time this returns, which is the fact a caller can act on — as distinct from
 * "this call is what removed it", which nobody needs.
 */
export function clearCapacityOverride(file: string = CAPACITY_OVERRIDE_PATH): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return !fs.existsSync(file);
  }
}
