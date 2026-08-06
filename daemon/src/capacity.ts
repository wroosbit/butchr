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
 * answer travels: the same code on a 64-core box says 73, not 2. The
 * arithmetic is deliberately simple and deliberately explained — a cap nobody
 * can follow is a cap people route around.
 *
 * The costs below are calibrated against that incident and are meant to be
 * re-measured, which is why they are constants with names rather than magic
 * numbers, why every one of them has an environment override, and why
 * `scripts/measure-agent-cost.mjs` exists to produce the evidence.
 *
 * KAN-36 corrected two things about the first version, both discovered the
 * same way — a human found the product unusable and no instrument had noticed:
 *
 *   - The cap counts *task* agents. At the time there was one always-on board
 *     manager, so KAN-36 reserved its share off the top like herdr's rather
 *     than spending it from the same budget as the work. Counting it had left
 *     a 4-core machine able to run exactly one task agent, forever.
 *   - An agent is a process tree, not a process. The MCP servers every agent
 *     starts are most of the difference between 480 MB and the 650 MB one
 *     actually holds.
 *
 * KAN-36's one-slot supervisor reservation was deliberately
 * unconditional. The manager was "present whenever Butchr is being used at
 * all, exactly like herdr", so holding its slot whether or not it happened to
 * be up kept `cap` a static property of the hardware. That was right when it
 * was written, and then KAN-39 removed the thing it assumed: there is no
 * longer one always-on supervisor. Zero or more `epic` and `story` agents are
 * staffed and stood down as work comes and goes, and a fixed reservation for
 * one of them had become arithmetic about an agent that may not exist.
 *
 * The rule that replaced it (KAN-41): only task agents are accounted for at
 * all. `cap` is cores and memory minus the human reserve and herdr's
 * overhead, and nothing else. Epic and story agents are neither counted in
 * `running` nor reserved for — they are typically low-resource and idle,
 * reading Jira, filing tickets and waiting, not competing for the machine the
 * way a task agent compiling a repo does. They are still reported in
 * `Capacity.supervisors`, so a reader of a capacity report can see they
 * exist; they are simply never charged.
 *
 * KAN-44/KAN-56 closed the loop this header opened. `readCapacity()` always
 * read cores, memory and load live; the one static input left was the
 * per-agent cost divisor, measured once on 2026-07-31. Now the daemon
 * re-measures its own fleet on a timer (daemon.ts, with agent-cost.ts as the
 * instrument), damps the estimate (agent-cost-damping.ts — asymmetric on
 * purpose, see that file), and this arithmetic divides by the damped figure.
 * The constants below remain as the *seed*: what capacity answers from when
 * there is nothing to measure — no agent trees, no /proc, a sample that fails
 * validation — because whatever breaks, capacity still answers, conservatively.
 *
 * That accuracy is paid for in predictability. The original argument here was
 * for a static cap — "a cap nobody can follow is a cap people route around" —
 * and a divisor that moves with the fleet is exactly a cap nobody can follow
 * from the constants alone. So the deal is: the cost input may move, but every
 * report says where each figure came from (seed, measured, or override), when
 * the sample was taken, over what window, from how many trees — and the
 * arithmetic from those printed figures to `cap` stays reproducible by hand.
 * A reader who cannot predict tomorrow's cap can still check today's.
 *
 * Precedence is strict and short: an operator override
 * (BUTCHR_AGENT_CORES / BUTCHR_AGENT_MEMORY_MB) beats the measurement
 * outright — someone who typed a number into their environment has re-measured
 * or decided, and a fleet that argues with its operator gets turned off. The
 * measurement beats the seed. The seed is what remains. BUTCHR_MAX_AGENTS
 * still pins the cap and skips the derivation entirely.
 *
 * KAN-201 replaced the live term that actually did the refusing. Until then,
 * headroom asked the 1-minute load average how much of the machine was left:
 *
 *     headroomByLoad = (cores − reservedForHuman − load1) ÷ costPerAgentCores
 *
 * The human's verdict on it was "the formula that limits the number of agents
 * is trash", and the numbers agreed. Four things were wrong with it, and only
 * the last one is about strictness:
 *
 *   1. It measured the whole machine and charged it to the fleet. `load1`
 *      counts the browser, a `npm run build`, and the human's own work
 *      indiscriminately, then subtracts all of it from a budget that is
 *      denominated in *per-agent* cost. One build pinned headroom at 0 for a
 *      minute afterwards with no agent having done anything, which is also why
 *      KAN-57 had to exempt supervisors from a gate that could never open.
 *   2. It contradicted this file's own other answer by two orders of
 *      magnitude. On 2026-08-06, with the same measured 0.064 core/agent
 *      divisor, `capByCpu` said 39 and `headroomByLoad` said 0. Two routes
 *      through one model cannot both describe one machine.
 *   3. It is a lagging average used as an admission test. Admission is a
 *      question about the next agent's marginal cost; `load1` is a smoothed
 *      report of the last minute, so the gate refused on work that may already
 *      have finished, and stayed wrong for up to a minute after it did.
 *   4. It subtracted a queue length from a core count. Load average is the
 *      run-queue — runnable *plus* uninterruptible-sleep tasks — not a
 *      utilisation fraction. A load of 4.45 on this 4-core machine was
 *      measured against 1.19 cores of actual CPU. The arithmetic was
 *      dimensionally confused, and that confusion is the root of (2).
 *
 * What replaced it is the memory term's shape, because the memory term is the
 * one nobody has ever complained about: take what the machine says is
 * *available* right now, hold back the human's reserve, divide by the measured
 * per-agent cost.
 *
 *     headroomByMemory = (availableBytes − reservedBytes) ÷ costPerAgentBytes
 *     headroomByCpu    = (cores − busyCores − reservedCores) ÷ costPerAgentCores
 *
 * `busyCores` is CPU actually consumed, read from /proc/stat over a recent
 * window (see {@link sampleCpuBusy}) — the same quantity, in the same units,
 * that agent-cost.ts already measures per agent tree. `load1` is still read and
 * still reported, because it is the number a human feels when the machine goes
 * treacly; it no longer decides anything.
 *
 * This is a loosening and it is meant to be one — it was authorised as "about
 * 2x" and it delivers more than that on this hardware. What it is not is a
 * removal: a machine whose cores are genuinely spent still refuses, by the
 * same arithmetic, with the same legible reason. The two terms that ration
 * hardest are untouched: memory (which kills rather than slows, and which
 * binds first on this laptop once CPU stops lying) and the static cap.
 * daemon/scripts/verify-cpu-headroom-gate.mjs is the proof that the gate still
 * closes, and it is written so that it goes red if it stops.
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
 * Measured on 2026-07-31, re-measured the same evening with
 * `scripts/measure-agent-cost.mjs`, which exists so the next argument with
 * these numbers can be settled with evidence.
 *
 * `residentBytes` went up, and the reason is the correction: 480 MB was the
 * `claude` process, and an agent is not a process. Every agent also carries
 * its MCP servers — an `npm exec mcp-remote` for Atlassian and a node process
 * for butchr — which the morning's measurement never looked at. Measured over
 * the whole tree: 654, 658 and 679 MB across three live agents, of which the
 * claude process itself was 424–443 MB. 650 MB is the bottom of that range,
 * and memory is the dimension that kills rather than slows.
 *
 * `cores` is neither of the two numbers that can be measured directly, and
 * that is the whole difficulty. Measured CPU is 0.15 cores per agent tree over
 * 90 seconds (0.02–0.24 across three agents), because most of an agent's life
 * is spent waiting on an API; calibrating on that says a 4-core box carries
 * sixteen, and the human who filed KAN-34 had already found out what seven
 * feels like. The load average is the other extreme: seven agents produced a
 * load of 11.3, ~1.6 each, but that is a queue length, and it inflates as the
 * machine gets worse — each of those seven was mostly waiting on the other
 * six. Calibrating on 1.6 says a 4-core box carries one.
 *
 * So it is calibrated on the configuration that was *observed to be fine*.
 * Manager plus two task agents sat at a load of 2.6–2.9 on four cores, with
 * the desktop responsive. Three agents against a budget of 4 cores − 1 held
 * back for the human − 0.5 for herdr = 2.5 gives 0.83 each; 0.75 is that
 * rounded to a figure that divides cleanly and leaves a little slack, and it
 * reproduces exactly the fleet this machine was seen to carry. It sits well
 * above the ~0.3 cores an agent actually spends and well below its
 * thrashing-inflated share, which is the range a divisor in a load-average
 * budget has to live in. Re-measure it before trusting it — that is what the
 * script is for.
 *
 * Since KAN-56 the daemon does re-measure it, continuously, and these numbers
 * are the seed rather than the answer: they hold until the sampler has a
 * damped live figure, and they are what everything degrades to when it does
 * not. A capacity report built from them says `seed`, because a figure nobody
 * measured on this fleet must be labelled as such — that mislabelling is the
 * exact failure story KAN-44 exists to correct.
 */
export const MEASURED_AGENT_COST: AgentCost = {
  residentBytes: 650 * MIB,
  cores: 0.75
};

/** Where a cost figure came from. Tracked per dimension, because the operator
 * may override cores while memory stays measured. */
export type CostSource = 'override' | 'measured' | 'seed';

/**
 * A damped live measurement of what one agent tree costs, with the metadata a
 * reader needs to judge it: when the window closed, how long it was, and how
 * many trees the per-tree figure was averaged over. Produced by the daemon's
 * sampler (daemon.ts) from agent-cost.ts windows, damped by
 * agent-cost-damping.ts — by design never an instantaneous reading.
 */
export interface MeasuredAgentCost extends AgentCost {
  /** Wall-clock ms (Date.now()) when the sample window closed. */
  sampledAt: number;
  /** Length of the window that closed the measurement, in seconds. */
  windowSeconds: number;
  /** Agent trees the per-tree figures were averaged over. */
  agentTrees: number;
}

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
  /**
   * 1-minute load average. Reported, never gated on since KAN-201 — it is the
   * number a human feels, and it is not a count of cores in use.
   */
  load1: number;
  /**
   * Cores actually being consumed right now, measured from /proc/stat over a
   * recent window. This is the CPU analogue of `availableBytes`: what the
   * machine says it is spending, not what it says is queued.
   *
   * Null (or absent) when nothing could be measured — no /proc, no window
   * closed yet, a window too old to describe "now". The arithmetic then falls
   * back to `min(load1, cores)`, which over-states CPU use on a contended
   * machine and therefore refuses sooner: the conservative direction, and
   * labelled `load-average` in every report so nobody mistakes it for a
   * measurement.
   */
  busyCores?: number | null;
  /** Length of the window `busyCores` was averaged over, in seconds. */
  busyWindowSeconds?: number | null;
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

/**
 * Which measurement set the live headroom.
 *
 * `'load'` was retired by KAN-201 along with the term that produced it. It is
 * deliberately not kept as an alias: a reader who sees `cpu` must be able to
 * conclude that CPU actually in use is what bound, and a payload that could
 * still say `load` would leave that in doubt.
 */
export type HeadroomBound = 'cap' | 'cpu' | 'memory';

/** Where the `busyCores` figure the CPU term divided came from. */
export type CpuBusySource = 'measured' | 'load-average';

export interface Capacity {
  machine: MachineFacts;
  cost: AgentCost;
  /** Where each dimension of `cost` came from: override, measured, or seed. */
  costSource: { residentBytes: CostSource; cores: CostSource };
  /**
   * The damped measurement that was consulted, if the sampler had one. Kept
   * even when an override beat it, so a report can say what was ignored.
   */
  measured: MeasuredAgentCost | null;
  reservedForHuman: { cores: number; bytes: number };

  /** Concurrent *task* agents this hardware supports, load aside. */
  cap: number;
  capByCpu: number;
  capByMemory: number;
  capBoundBy: CapBound;
  /** Set when BUTCHR_MAX_AGENTS overrode the derivation. */
  configuredCap: number | null;

  /** Task agents alive right now. Supervisors are not among them. */
  running: number;
  /**
   * Epic and story agents alive right now. Reported, never charged: they
   * supervise rather than do the work, and spend most of their lives idle
   * waiting on Jira. See the header for the argument.
   */
  supervisors: number;

  /** How many more can be started right now. Never negative. */
  headroom: number;
  headroomByCap: number;
  /**
   * What CPU allows right now: (cores − in use − reserved) ÷ per-agent cores.
   * Replaced `headroomByLoad` in KAN-201 — see the header for why the load
   * average was the wrong instrument rather than a strict one.
   */
  headroomByCpu: number;
  headroomByMemory: number;
  headroomBoundBy: HeadroomBound;

  /** The cores-in-use figure the CPU term used, and where it came from. */
  cpuBusyCores: number;
  cpuBusySource: CpuBusySource;
  /** Window `cpuBusyCores` was averaged over; null on the fallback path. */
  cpuBusyWindowSeconds: number | null;

  /** True when starting another agent would exceed what the machine can carry. */
  atCapacity: boolean;
}

export interface CapacityOptions {
  /**
   * Operator-set costs (BUTCHR_AGENT_CORES / BUTCHR_AGENT_MEMORY_MB). A
   * dimension set here beats the measurement outright — see the header for
   * the precedence argument.
   */
  overrides?: Partial<AgentCost>;
  /** The damped live measurement, if there is one. Beats the seed, loses to
   * overrides. */
  measured?: MeasuredAgentCost | null;
  /** A cap the operator set by hand, bypassing the derivation entirely. */
  configuredCap?: number | null;
  /** Supervisors observed running. Reported only; it changes no arithmetic. */
  supervisorsRunning?: number;
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
  // The divisor, one dimension at a time: override, else measured, else seed.
  // Per dimension rather than all-or-nothing so an operator who has re-measured
  // cores does not silently discard the memory measurement too.
  const overrides = options.overrides ?? {};
  const measured = options.measured ?? null;
  const pick = (dim: keyof AgentCost): { value: number; source: CostSource } => {
    const override = overrides[dim];
    if (override !== undefined) return { value: override, source: 'override' };
    if (measured) return { value: measured[dim], source: 'measured' };
    return { value: MEASURED_AGENT_COST[dim], source: 'seed' };
  };
  const resident = pick('residentBytes');
  const coreCost = pick('cores');
  const cost: AgentCost = { residentBytes: resident.value, cores: coreCost.value };
  const costSource = { residentBytes: resident.source, cores: coreCost.source };
  const configuredCap = options.configuredCap ?? null;

  const reservedCores = humanReserveCores(machine.cores);
  const reservedBytes = humanReserveBytes(machine.totalBytes);

  // Static cap: what the hardware supports with nothing else assumed. herdr's
  // share comes off here because the load average cannot be consulted for a
  // machine that is not this one. Nothing is held back for supervisors — see
  // the header: only task agents are charged.
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

  // CPU actually in use, the same way memory asks what is actually available.
  // Every agent, every supervisor, herdr and the human are all in this figure —
  // so it is still the one term that distinguishes three idle agents from three
  // that are compiling, which was the load term's one real virtue and is kept.
  // It is also where running epic and story agents are felt at all: never
  // charged in the model, their real (usually small) usage shows up here and in
  // availableBytes below — a running supervisor's memory is memory the kernel
  // has already stopped offering.
  //
  // What changed in KAN-201 is only which instrument answers "how much of this
  // machine is spent": cores consumed over a recent window, instead of a
  // 1-minute run-queue average that counted I/O waits as CPU demand and
  // disagreed with capByCpu by two orders of magnitude. See the header.
  //
  // The fallback keeps the gate honest when the instrument is missing: no
  // sample means `min(load1, cores)`, which over-states use on a contended
  // machine and so refuses sooner rather than later. On a platform with no load
  // average either (Windows reports 0) this term goes inert, exactly as the
  // load term did, and the count and memory terms still bind.
  const cpuBusySource: CpuBusySource =
    typeof machine.busyCores === 'number' ? 'measured' : 'load-average';
  const cpuBusyCores =
    cpuBusySource === 'measured'
      ? Math.max(0, Math.min(machine.cores, machine.busyCores as number))
      : Math.max(0, Math.min(machine.cores, machine.load1));
  const cpuBusyWindowSeconds =
    cpuBusySource === 'measured' ? machine.busyWindowSeconds ?? null : null;
  // The human's reserve is subtracted here even though what they are already
  // using is inside `cpuBusyCores`, and that is not double-charging: the same
  // is true of the memory term, where the browser's resident pages are already
  // out of `availableBytes`. The reserve is room for what the human might start
  // doing next, which is the complaint the gate exists to answer.
  const liveCpuBudget = machine.cores - cpuBusyCores - reservedCores;
  const headroomByCpu = Math.max(0, Math.floor(liveCpuBudget / cost.cores));

  const headroomByMemory = Math.max(
    0,
    Math.floor(Math.max(0, machine.availableBytes - reservedBytes) / cost.residentBytes)
  );

  const headroom = Math.min(headroomByCap, headroomByCpu, headroomByMemory);
  // Ties resolve to the term the reader can most directly act on: closing an
  // agent is a decision, waiting for the machine to go quiet is not.
  const headroomBoundBy: HeadroomBound =
    headroomByCap <= headroomByCpu && headroomByCap <= headroomByMemory
      ? 'cap'
      : headroomByCpu <= headroomByMemory
        ? 'cpu'
        : 'memory';

  return {
    machine,
    cost,
    costSource,
    measured,
    reservedForHuman: { cores: reservedCores, bytes: reservedBytes },
    cap,
    capByCpu,
    capByMemory,
    capBoundBy,
    configuredCap,
    running,
    supervisors: options.supervisorsRunning ?? 0,
    headroom,
    headroomByCap,
    headroomByCpu,
    headroomByMemory,
    headroomBoundBy,
    cpuBusyCores,
    cpuBusySource,
    cpuBusyWindowSeconds,
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

/**
 * CPU actually consumed, which is not the load average.
 *
 * /proc/stat's first line is cumulative jiffies per CPU state since boot, so
 * one reading says nothing; two readings a window apart say what fraction of
 * the machine was spent in between. That fraction times the core count is the
 * quantity the CPU headroom term divides — the same units agent-cost.ts
 * measures per agent tree, and the reason the two now agree.
 *
 * `idle` and `iowait` both count as *not busy*. A core in iowait had nothing
 * runnable to put on it; it is available to a new agent. Counting it as spent
 * is precisely the run-queue confusion KAN-201 removed, since iowait tasks are
 * a large part of what inflates the load average above real CPU use.
 */
interface CpuTicks {
  busy: number;
  idle: number;
  /** Date.now() when the reading was taken. */
  at: number;
}

/** A closed window: what fraction of the machine was spent over it. */
interface CpuBusyWindow {
  busyFraction: number;
  windowSeconds: number;
  /** Date.now() when the window closed. */
  closedAt: number;
}

/**
 * Windows shorter than this are not closed; the baseline is kept so the next
 * read closes a usable one. Two capacity calls a few milliseconds apart would
 * otherwise divide two nearly-equal jiffy counters and report noise.
 */
const CPU_WINDOW_MIN_SECONDS = 2;
/**
 * A window longer than this is thrown away rather than closed: it would be an
 * average over five minutes of history, which is the very property (a lagging
 * average standing in for "now") that this term exists to stop relying on.
 */
const CPU_WINDOW_MAX_SECONDS = 300;
/**
 * How long a closed window still counts as describing "now". Past this the
 * measurement is discarded and the arithmetic degrades to the labelled
 * load-average fallback rather than dividing by a figure from another era.
 */
const CPU_SAMPLE_MAX_AGE_SECONDS = 120;

function readCpuTicks(): CpuTicks | null {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    if (!line.startsWith('cpu ')) return null;
    // user nice system idle iowait irq softirq steal guest guest_nice
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    if (v.length < 5 || v.some((n) => !Number.isFinite(n))) return null;
    const idle = v[3] + v[4];
    const total = v.reduce((s, n) => s + n, 0);
    return { busy: total - idle, idle, at: Date.now() };
  } catch {
    // not Linux, or /proc is not mounted
    return null;
  }
}

let cpuBaseline: CpuTicks | null = null;
let cpuWindow: CpuBusyWindow | null = null;

/**
 * Advance the /proc/stat sampler and return the most recent completed window,
 * or null if there is none fresh enough to use.
 *
 * Self-maintaining on purpose: every `readMachineFacts()` calls it, so a daemon
 * that answers capacity questions keeps its own measurement warm without any
 * caller having to know that it exists. The daemon also ticks it on a short
 * timer (daemon.ts) so the first question after a quiet spell is answered from
 * a window that closed seconds ago rather than from the fallback — but nothing
 * here *depends* on that timer running, which is what keeps the degraded path
 * a degradation rather than a silent difference between the daemon and every
 * script that imports this module.
 */
export function sampleCpuBusy(): CpuBusyWindow | null {
  const ticks = readCpuTicks();
  if (!ticks) {
    // No instrument at all: forget everything rather than let an old window
    // outlive the thing that produced it.
    cpuBaseline = null;
    cpuWindow = null;
    return null;
  }
  if (cpuBaseline) {
    const seconds = (ticks.at - cpuBaseline.at) / 1000;
    const busy = ticks.busy - cpuBaseline.busy;
    const idle = ticks.idle - cpuBaseline.idle;
    const total = busy + idle;
    if (seconds >= CPU_WINDOW_MIN_SECONDS && seconds <= CPU_WINDOW_MAX_SECONDS) {
      // total <= 0 means the counters did not move (or went backwards, which
      // happens across a suspend): no window, and the baseline restarts.
      if (total > 0 && busy >= 0) {
        cpuWindow = { busyFraction: busy / total, windowSeconds: seconds, closedAt: ticks.at };
      }
      cpuBaseline = ticks;
    } else if (seconds > CPU_WINDOW_MAX_SECONDS) {
      cpuBaseline = ticks;
    }
    // Shorter than the minimum: keep the baseline, so the next read closes.
  } else {
    cpuBaseline = ticks;
  }
  if (cpuWindow && (Date.now() - cpuWindow.closedAt) / 1000 > CPU_SAMPLE_MAX_AGE_SECONDS) {
    cpuWindow = null;
  }
  return cpuWindow;
}

/** What this machine actually is. Never throws. */
export function readMachineFacts(): MachineFacts {
  // os.cpus() returns [] in some containers; a machine with no CPUs is not a
  // thing, so a wrong-but-usable 1 beats a division by zero.
  const cores = os.cpus().length || 1;
  const cpu = sampleCpuBusy();
  return {
    cores,
    totalBytes: os.totalmem(),
    availableBytes: readAvailableBytes(),
    // os.loadavg() is [0,0,0] on Windows. Nothing gates on it since KAN-201,
    // but it is still what a report quotes as the number the human feels.
    load1: os.loadavg()[0],
    // Null until the first window closes — one capacity call cannot measure a
    // rate. The fallback is labelled, and it is the conservative direction.
    busyCores: cpu ? cpu.busyFraction * cores : null,
    busyWindowSeconds: cpu ? cpu.windowSeconds : null
  };
}

function envNumber(name: string, allowZero = false): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    console.warn(
      `${name}=${raw} is not a ${allowZero ? 'non-negative' : 'positive'} number; ignoring it`
    );
    return undefined;
  }
  return value;
}

/**
 * Operator overrides, because someone who has re-measured their own hardware
 * should not have to argue with figures taken on a laptop in July 2026.
 *
 *   BUTCHR_MAX_AGENTS        — set the cap outright, skipping the derivation
 *   BUTCHR_AGENT_MEMORY_MB   — resident cost of one agent
 *   BUTCHR_AGENT_CORES       — load-average cost of one active agent
 */
export function optionsFromEnv(): CapacityOptions {
  const memoryMb = envNumber('BUTCHR_AGENT_MEMORY_MB');
  const cores = envNumber('BUTCHR_AGENT_CORES');
  // Only the dimensions actually set become overrides: an unset variable must
  // leave room for the measurement, not silently pin the seed.
  const overrides: Partial<AgentCost> = {};
  if (memoryMb !== undefined) overrides.residentBytes = memoryMb * MIB;
  if (cores !== undefined) overrides.cores = cores;
  return {
    overrides,
    configuredCap: envNumber('BUTCHR_MAX_AGENTS') ?? null
  };
}

/**
 * The damped live measurement, held here so every caller of readCapacity —
 * each per-connection router and the daemon's own — divides by the same
 * figure. The daemon's sampler (daemon.ts) is the only writer: it sets a
 * fresh value after each valid window and clears back to null the moment the
 * instrument fails, which is what makes "whatever breaks, capacity still
 * answers from the seed" true without any caller having to know.
 */
let liveMeasuredCost: MeasuredAgentCost | null = null;

export function setMeasuredAgentCost(measured: MeasuredAgentCost | null): void {
  liveMeasuredCost = measured;
}

export function getMeasuredAgentCost(): MeasuredAgentCost | null {
  return liveMeasuredCost;
}

/**
 * Capacity of this machine, with `running` task agents already on it.
 *
 * `supervisors` is how many epic and story agents were found running. It is
 * passed so the report can say so, not so the arithmetic can charge for them —
 * they are never charged at all.
 */
export function readCapacity(running: number, supervisors = 0): Capacity {
  return computeCapacity(readMachineFacts(), running, {
    ...optionsFromEnv(),
    measured: liveMeasuredCost,
    supervisorsRunning: supervisors
  });
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
  // The CPU figure gets its own line with its provenance, for the same reason
  // the cost figures do: since KAN-201 this is what the live gate divides, and
  // a reader must be able to tell a /proc/stat measurement from the
  // load-average fallback that stands in when there is none. The load average
  // stays on the line above, reported and no longer consulted — printing only
  // the figure that gates would hide the very disagreement between the two
  // that motivated the change.
  lines.push(
    c.cpuBusySource === 'measured'
      ? `cpu in use: ${c.cpuBusyCores.toFixed(2)} of ${m.cores} cores (measured over ` +
        `${Math.round(c.cpuBusyWindowSeconds ?? 0)}s); the load average is reported above and ` +
        'is not what gates'
      : `cpu in use: ${c.cpuBusyCores.toFixed(2)} of ${m.cores} cores (load-average fallback — ` +
        'no /proc/stat window; this over-states use and so refuses sooner)'
  );
  // Every cost figure carries its provenance, because the divisor can now be
  // a measurement: a reader must be able to tell a number this fleet produced
  // from the 2026-07-31 seed and from a number the operator typed in.
  lines.push(
    `agent cost: ${Math.round(c.cost.residentBytes / MIB)} MB resident (${c.costSource.residentBytes}), ` +
    `${c.cost.cores} core while active (${c.costSource.cores})`
  );
  if (c.measured) {
    const beaten: string[] = [];
    if (c.costSource.residentBytes === 'override') {
      beaten.push(`BUTCHR_AGENT_MEMORY_MB overrides its ${Math.round(c.measured.residentBytes / MIB)} MB`);
    }
    if (c.costSource.cores === 'override') {
      beaten.push(`BUTCHR_AGENT_CORES overrides its ${c.measured.cores} core`);
    }
    lines.push(
      `  measured (damped): ${Math.round(c.measured.residentBytes / MIB)} MB, ` +
      `${c.measured.cores} core per agent tree — ${c.measured.agentTrees} tree(s) ` +
      `over a ${Math.round(c.measured.windowSeconds)}s window ` +
      `ending ${new Date(c.measured.sampledAt).toISOString()}` +
      (beaten.length ? `; ignored: ${beaten.join(', ')}` : '')
    );
  } else if (c.costSource.residentBytes === 'seed' || c.costSource.cores === 'seed') {
    lines.push(
      '  no live measurement; seed figures are the 2026-07-31 constants, ' +
      'not a measurement of this fleet'
    );
  }
  lines.push(
    `reserved for you: ${c.reservedForHuman.cores} core(s), ${gib(c.reservedForHuman.bytes)}`
  );

  if (c.capBoundBy === 'configured') {
    lines.push(`cap: ${c.cap} task agents (set by BUTCHR_MAX_AGENTS, derivation skipped)`);
  } else {
    lines.push(
      `cap: ${c.cap} task agents — ` +
      `CPU allows ${c.capByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${HERDR_OVERHEAD_CORES} for herdr) ÷ ${c.cost.cores} core/agent), ` +
      `memory allows ${c.capByMemory} ((${gib(m.totalBytes)} − ${gib(c.reservedForHuman.bytes)}) ` +
      `÷ ${Math.round(c.cost.residentBytes / MIB)} MB/agent)` +
      (c.capBoundBy === 'floor'
        ? '; both said 0, floored to 1 because a machine that can run nothing is not a useful answer'
        : `; bound by ${c.capBoundBy}`)
    );
  }

  lines.push(
    `running: ${c.running} task agent(s)` +
    (c.supervisors > 0
      ? `, plus ${c.supervisors} epic/story supervisor agent(s) (not counted against the cap)`
      : '')
  );
  lines.push(
    `headroom: ${c.headroom} more — ` +
    `count allows ${c.headroomByCap} (${c.cap} cap − ${c.running} running), ` +
    `cpu allows ${c.headroomByCpu} ((${m.cores} cores − ${c.cpuBusyCores.toFixed(2)} in use ` +
    `− ${c.reservedForHuman.cores} reserved) ÷ ${c.cost.cores}), ` +
    `memory allows ${c.headroomByMemory} ((${gib(m.availableBytes)} available ` +
    `− ${gib(c.reservedForHuman.bytes)} reserved) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB); ` +
    `bound by ${c.headroomBoundBy}`
  );

  return lines.join('\n');
}

/**
 * One line for callers that only have room for one.
 *
 * When there is no room, it leads with the binding constraint rather than
 * with the count (KAN-60): opening "2/10 task agents" on a load-bound refusal
 * read as "at capacity" by count, which the line's own figures contradicted.
 */
export function summarizeCapacity(c: Capacity): string {
  // Cores in use, not the load average: a one-line refusal that quotes a
  // figure nothing gated on sends the reader after the wrong lever, which is
  // the KAN-60 defect in a new costume. The load average is one line down in
  // the derivation for anyone who wants to compare the two.
  const figures =
    `${c.running}/${c.cap} task agents, room for ${c.headroom} more ` +
    `(${c.machine.cores} cores, ${c.cpuBusyCores.toFixed(2)} in use, ` +
    `${gib(c.machine.availableBytes)} available; bound by ${c.headroomBoundBy})`;
  if (!c.atCapacity) return figures;
  // Count-bound, the figures already open with N-of-cap; repeating the whole
  // reason would bury a one-line summary under its own headline.
  return c.headroomBoundBy === 'cap'
    ? `at capacity: ${figures}`
    : `${capacityHeadline(c)}; ${figures}`;
}

/**
 * The one sentence that says why there is no room, without the arithmetic
 * behind it.
 *
 * Separate from {@link capacityRefusal} because the sidepanel has a line, not
 * a page: the panel shows this and puts the full derivation behind a
 * disclosure, while an MCP caller and the log get the whole thing. Both are
 * built from the same numbers, so they cannot drift into disagreeing.
 */
export function capacityReason(c: Capacity): string {
  if (c.headroomBoundBy === 'cpu') {
    // Every figure the CPU term divided, in the order it divides them, so the
    // sentence is checkable without opening the derivation: in use, total,
    // held back. KAN-201 changed the arithmetic, so it changed this sentence
    // with it — a refusal explaining an arithmetic that is no longer the
    // arithmetic is worse than no explanation at all.
    return (
      `${c.cpuBusyCores.toFixed(2)} of this machine's ${c.machine.cores} cores are already ` +
      `in use${c.cpuBusySource === 'measured' ? '' : ' (estimated from the load average)'}, and ` +
      `${c.reservedForHuman.cores} core${c.reservedForHuman.cores === 1 ? ' is' : 's are'} ` +
      `held back for you`
    );
  }
  if (c.headroomBoundBy === 'memory') {
    return (
      `only ${gib(c.machine.availableBytes)} of memory is available, and ` +
      `${gib(c.reservedForHuman.bytes)} of that is held back for you`
    );
  }
  return (
    `${c.running} task agent${c.running === 1 ? ' is' : 's are'} already running ` +
    `against a cap of ${c.cap}`
  );
}

/**
 * The headline of a refusal: the binding constraint, named, then the figures
 * that make it checkable.
 *
 * KAN-60: a load-bound refusal used to be headlined "at capacity" with the
 * cap count leading — read by a human as "2 of 10, at capacity", which was
 * false by its own numbers (2 running against a cap of 10) and pointed at the
 * wrong constraint entirely. `headroomBoundBy` already knows which term
 * bound; the headline renders from it, so "at capacity" is said only when
 * the count is what bound.
 */
export function capacityHeadline(c: Capacity): string {
  const constraint =
    c.headroomBoundBy === 'cpu'
      ? 'not enough cpu'
      : c.headroomBoundBy === 'memory'
        ? 'not enough memory'
        : 'at capacity';
  return `${constraint} — ${capacityReason(c)}`;
}

/** Why an activation was refused, with the arithmetic that refused it. */
export function capacityRefusal(c: Capacity, what: string): string {
  return (
    `Refusing to activate ${what}: ${capacityHeadline(c)}.\n` +
    `${describeCapacity(c)}\n` +
    `Deactivate an agent to make room, or pass override: true to start it anyway ` +
    `(the override is recorded with these numbers).`
  );
}
