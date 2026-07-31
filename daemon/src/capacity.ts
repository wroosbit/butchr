import * as fs from 'fs';
import * as os from 'os';

/**
 * How many agents this machine can carry — measured, not declared.
 *
 * On 2026-07-31 the board manager staffed seven agents on a 4-core laptop:
 * load average 11.3 against 4 cores, 9 claude processes holding 3.0 GB, and
 * 319 MB of 15 GB free. Nothing in Butchr knew any of that. The only
 * instrument that noticed was a human saying the desktop felt slow.
 *
 * Everything here is arithmetic over figures read from the machine, so the
 * answer travels: the same code on a 64-core box says 50, not 2. The
 * arithmetic is deliberately simple and deliberately explained — a cap nobody
 * can follow is a cap people route around.
 *
 * The costs below are calibrated against that incident and are meant to be
 * re-measured, which is why they are constants with names rather than magic
 * numbers, and why every one of them has an environment override.
 */

export const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What one agent costs the machine while it is working. */
export interface AgentCost {
  /** Resident memory the agent holds, working or idle. */
  residentBytes: number;
  /** Load-average units the agent contributes while active. */
  cores: number;
}

/**
 * Measured on 2026-07-31, and the two figures come from different evidence.
 *
 * `residentBytes` is direct: claude agents measured 429–526 MB resident, so
 * 480 MB is the middle of the observed range. Memory is the dimension that
 * kills rather than slows, so rounding up inside the range is the safe error.
 *
 * `cores` is *not* the 0.15–0.25 of a core the claude process itself burns.
 * An agent is the claude process plus everything it starts — tsc, npm, git,
 * ripgrep, subagents — and the load average is what the human actually felt.
 * Seven agents produced a load of 11.3, i.e. ~1.6 load units each once the
 * machine was already thrashing. Calibrating on that number alone would say a
 * 4-core box carries one agent; the ticket's own conclusion, from the same
 * afternoon, is that it comfortably carries 2–3. One core per active agent is
 * the figure that reproduces that, and it sits between the process's own
 * share and its thrashing-inflated share. Re-measure it before trusting it.
 */
export const MEASURED_AGENT_COST: AgentCost = {
  residentBytes: 480 * MIB,
  cores: 1.0
};

/**
 * The herdr server's own appetite. It sat at ~49% of a core with seven agents
 * attached, and it is not an agent, so it comes off the top of the budget
 * before agents are counted.
 *
 * This is subtracted only from the *static* cap. Live headroom is computed
 * against the load average, which already contains herdr's real usage —
 * subtracting it there would charge for it twice.
 */
export const HERDR_OVERHEAD_CORES = 0.5;

/** What the machine looks like right now, or what we pretend it looks like. */
export interface MachineFacts {
  cores: number;
  totalBytes: number;
  /** Memory that could be handed out now: MemAvailable, not MemFree. */
  availableBytes: number;
  /** 1-minute load average. */
  load1: number;
}

/**
 * Cores held back for the person using the machine.
 *
 * A whole core on a small box, because that is the complaint this exists to
 * answer: the human is *using* this desktop, and a fleet that eats it to the
 * last cycle is a fleet that gets turned off. It grows with core count so a
 * big machine is not left with a token reservation, but slowly — a 64-core
 * box does not need 16 cores held back to stay responsive.
 */
export function humanReserveCores(cores: number): number {
  return Math.max(1, Math.floor(cores / 8));
}

/**
 * Memory held back for everything that is not an agent: the browser, the
 * editor, the page cache that keeps the machine from feeling like treacle.
 * 15% of RAM, floored at 2 GB so a small machine is not left with scraps.
 */
export function humanReserveBytes(totalBytes: number): number {
  return Math.max(2 * GIB, Math.floor(totalBytes * 0.15));
}

/** Which measurement set the static cap. */
export type CapBound = 'cpu' | 'memory' | 'floor' | 'configured';

/** Which measurement set the live headroom. */
export type HeadroomBound = 'cap' | 'load' | 'memory';

export interface Capacity {
  machine: MachineFacts;
  cost: AgentCost;
  reservedForHuman: { cores: number; bytes: number };

  /** Concurrent agents this hardware supports, load aside. */
  cap: number;
  capByCpu: number;
  capByMemory: number;
  capBoundBy: CapBound;
  /** Set when BUTCHR_MAX_AGENTS overrode the derivation. */
  configuredCap: number | null;

  /** Agents alive right now, the manager's own included. */
  running: number;

  /** How many more can be started right now. Never negative. */
  headroom: number;
  headroomByCap: number;
  headroomByLoad: number;
  headroomByMemory: number;
  headroomBoundBy: HeadroomBound;

  /** True when starting another agent would exceed what the machine can carry. */
  atCapacity: boolean;
}

export interface CapacityOptions {
  cost?: AgentCost;
  /** A cap the operator set by hand, bypassing the derivation entirely. */
  configuredCap?: number | null;
}

/**
 * The whole model, as a pure function of measured figures.
 *
 * Pure so the same arithmetic can be run against hardware nobody here owns —
 * which is the property being bought, and which
 * `scripts/verify-agent-capacity.mjs` exercises.
 */
export function computeCapacity(
  machine: MachineFacts,
  running: number,
  options: CapacityOptions = {}
): Capacity {
  const cost = options.cost ?? MEASURED_AGENT_COST;
  const configuredCap = options.configuredCap ?? null;

  const reservedCores = humanReserveCores(machine.cores);
  const reservedBytes = humanReserveBytes(machine.totalBytes);

  // Static cap: what the hardware supports with nothing else assumed. herdr's
  // share comes off here because the load average cannot be consulted for a
  // machine that is not this one.
  const cpuBudget = machine.cores - reservedCores - HERDR_OVERHEAD_CORES;
  const capByCpu = Math.floor(Math.max(0, cpuBudget) / cost.cores);
  const capByMemory = Math.floor(
    Math.max(0, machine.totalBytes - reservedBytes) / cost.residentBytes
  );

  let cap: number;
  let capBoundBy: CapBound;
  if (configuredCap !== null) {
    cap = configuredCap;
    capBoundBy = 'configured';
  } else {
    cap = Math.min(capByCpu, capByMemory);
    capBoundBy = capByCpu <= capByMemory ? 'cpu' : 'memory';
    if (cap < 1) {
      // A machine too small to carry one agent by this arithmetic can still
      // run one, badly, and refusing everything would make Butchr useless
      // rather than careful. This floor is a decision, not a measurement, and
      // it says so in capBoundBy.
      cap = 1;
      capBoundBy = 'floor';
    }
  }

  // Live headroom: three independent answers to "how many more right now",
  // and the smallest wins. They disagree on purpose — count knows nothing
  // about effort, load knows nothing about memory, and memory knows nothing
  // about either.
  const headroomByCap = Math.max(0, cap - running);

  // The load average already includes every agent, herdr, and whatever the
  // human is running, so this is the one term that distinguishes three idle
  // agents from three that are compiling.
  //
  // It is a 1-minute average, so it lags: two agents started seconds apart are
  // both invisible to it. That is exactly the gap the count term covers, which
  // is why both are computed and the smaller wins rather than one replacing
  // the other.
  const loadBudget = machine.cores - reservedCores - machine.load1;
  const headroomByLoad = Math.max(0, Math.floor(loadBudget / cost.cores));

  const headroomByMemory = Math.max(
    0,
    Math.floor(Math.max(0, machine.availableBytes - reservedBytes) / cost.residentBytes)
  );

  const headroom = Math.min(headroomByCap, headroomByLoad, headroomByMemory);
  // Ties resolve to the term the reader can most directly act on: closing an
  // agent is a decision, waiting for the load average to fall is not.
  const headroomBoundBy: HeadroomBound =
    headroomByCap <= headroomByLoad && headroomByCap <= headroomByMemory
      ? 'cap'
      : headroomByLoad <= headroomByMemory
        ? 'load'
        : 'memory';

  return {
    machine,
    cost,
    reservedForHuman: { cores: reservedCores, bytes: reservedBytes },
    cap,
    capByCpu,
    capByMemory,
    capBoundBy,
    configuredCap,
    running,
    headroom,
    headroomByCap,
    headroomByLoad,
    headroomByMemory,
    headroomBoundBy,
    atCapacity: headroom <= 0
  };
}

/**
 * Memory the kernel believes it could hand out, which is not MemFree: most of
 * a healthy machine's "free" memory is page cache it will surrender on
 * demand. On this machine the two differ by 8 GB, which is the difference
 * between "no room for an agent" and "room for sixteen".
 *
 * Falls back to os.freemem() where /proc/meminfo is not readable, which
 * understates availability — the conservative direction.
 */
export function readAvailableBytes(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const line = meminfo.split('\n').find((l) => l.startsWith('MemAvailable:'));
    const kb = Number(line?.trim().split(/\s+/)[1]);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  } catch {
    // not Linux, or /proc is not mounted
  }
  return os.freemem();
}

/** What this machine actually is. Never throws. */
export function readMachineFacts(): MachineFacts {
  // os.cpus() returns [] in some containers; a machine with no CPUs is not a
  // thing, so a wrong-but-usable 1 beats a division by zero.
  const cores = os.cpus().length || 1;
  return {
    cores,
    totalBytes: os.totalmem(),
    availableBytes: readAvailableBytes(),
    // os.loadavg() is [0,0,0] on Windows. That reads as a perfectly idle
    // machine, which makes the load term inert rather than wrong — the count
    // and memory terms still bind.
    load1: os.loadavg()[0]
  };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`${name}=${raw} is not a positive number; ignoring it`);
    return undefined;
  }
  return value;
}

/**
 * Operator overrides, because someone who has re-measured their own hardware
 * should not have to argue with figures taken on a laptop in July 2026.
 *
 *   BUTCHR_MAX_AGENTS     — set the cap outright, skipping the derivation
 *   BUTCHR_AGENT_MEMORY_MB — resident cost of one agent
 *   BUTCHR_AGENT_CORES    — load-average cost of one active agent
 */
export function optionsFromEnv(): CapacityOptions {
  const memoryMb = envNumber('BUTCHR_AGENT_MEMORY_MB');
  const cores = envNumber('BUTCHR_AGENT_CORES');
  return {
    cost: {
      residentBytes: memoryMb !== undefined ? memoryMb * MIB : MEASURED_AGENT_COST.residentBytes,
      cores: cores ?? MEASURED_AGENT_COST.cores
    },
    configuredCap: envNumber('BUTCHR_MAX_AGENTS') ?? null
  };
}

/** Capacity of this machine, with `running` agents already on it. */
export function readCapacity(running: number): Capacity {
  return computeCapacity(readMachineFacts(), running, optionsFromEnv());
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * The derivation in words, with the numbers that produced it.
 *
 * This is the whole point of the ticket: an agent refused for capacity has to
 * say why, in figures the reader can check, the way KAN-24 made a refused
 * spawn name its cause instead of failing obscurely.
 */
export function describeCapacity(c: Capacity): string {
  const m = c.machine;
  const lines: string[] = [];

  lines.push(
    `machine: ${m.cores} cores, ${gib(m.totalBytes)} RAM ` +
    `(${gib(m.availableBytes)} available), load average ${m.load1.toFixed(2)}`
  );
  lines.push(
    `agent cost: ${Math.round(c.cost.residentBytes / MIB)} MB resident, ` +
    `${c.cost.cores} core while active`
  );
  lines.push(
    `reserved for you: ${c.reservedForHuman.cores} core(s), ${gib(c.reservedForHuman.bytes)}`
  );

  if (c.capBoundBy === 'configured') {
    lines.push(`cap: ${c.cap} agents (set by BUTCHR_MAX_AGENTS, derivation skipped)`);
  } else {
    lines.push(
      `cap: ${c.cap} agents — ` +
      `CPU allows ${c.capByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${HERDR_OVERHEAD_CORES} for herdr) ÷ ${c.cost.cores} core/agent), ` +
      `memory allows ${c.capByMemory} ((${gib(m.totalBytes)} − ${gib(c.reservedForHuman.bytes)}) ` +
      `÷ ${Math.round(c.cost.residentBytes / MIB)} MB/agent)` +
      (c.capBoundBy === 'floor'
        ? '; both said 0, floored to 1 because a machine that can run nothing is not a useful answer'
        : `; bound by ${c.capBoundBy}`)
    );
  }

  lines.push(`running: ${c.running} agent(s)`);
  lines.push(
    `headroom: ${c.headroom} more — ` +
    `count allows ${c.headroomByCap} (${c.cap} cap − ${c.running} running), ` +
    `load allows ${c.headroomByLoad} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
    `− ${m.load1.toFixed(2)} load) ÷ ${c.cost.cores}), ` +
    `memory allows ${c.headroomByMemory} ((${gib(m.availableBytes)} available ` +
    `− ${gib(c.reservedForHuman.bytes)} reserved) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB); ` +
    `bound by ${c.headroomBoundBy}`
  );

  return lines.join('\n');
}

/** One line for callers that only have room for one. */
export function summarizeCapacity(c: Capacity): string {
  return (
    `${c.running}/${c.cap} agents, room for ${c.headroom} more ` +
    `(${c.machine.cores} cores, load ${c.machine.load1.toFixed(2)}, ` +
    `${gib(c.machine.availableBytes)} available; bound by ${c.headroomBoundBy})`
  );
}

/** Why an activation was refused, with the arithmetic that refused it. */
export function capacityRefusal(c: Capacity, what: string): string {
  const reason =
    c.headroomBoundBy === 'load'
      ? `load average ${c.machine.load1.toFixed(2)} already exceeds the ` +
        `${(c.machine.cores - c.reservedForHuman.cores).toFixed(1)} cores available to agents`
      : c.headroomBoundBy === 'memory'
        ? `only ${gib(c.machine.availableBytes)} is available and ` +
          `${gib(c.reservedForHuman.bytes)} of it is reserved`
        : `${c.running} agents are already running against a cap of ${c.cap}`;

  return (
    `Refusing to activate ${what}: no capacity — ${reason}.\n` +
    `${describeCapacity(c)}\n` +
    `Deactivate an agent to make room, or pass override: true to start it anyway ` +
    `(the override is recorded with these numbers).`
  );
}
