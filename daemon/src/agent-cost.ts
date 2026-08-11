// What one agent actually costs this machine, measured rather than assumed.
//
// MEASURED_AGENT_COST in daemon/src/capacity.ts is the whole cap in two
// numbers, and KAN-34 shipped them from a single afternoon's observation with
// a note saying "re-measure it before trusting it". This is that instrument —
// extracted from scripts/measure-agent-cost.mjs (KAN-55) so the daemon can run
// the same measurement the script runs, with exactly one copy of the logic.
// The script is now a thin CLI over this module.
//
// An agent is not the `claude` process. It is that process plus everything it
// starts — tsc, npm, git, ripgrep, subagents — and the cost that matters is
// the whole tree's. So the tree is what is measured: every process is grouped
// under the nearest `claude` ancestor that has no `claude` ancestor of its
// own, and CPU is summed per group.
//
// CPU is measured as cores, not as a load average: utime+stime deltas from
// /proc/<pid>/stat divided by wall-clock seconds. That is the quantity the
// machine actually spends. The load average, reported alongside it, is the
// queue that quantity produces — the number the human feels, and always the
// larger of the two once the machine is contended.
//
// ---------------------------------------------------------------------------
// WHICH TREES THE DIVISOR IS AVERAGED OVER (KAN-276)
// ---------------------------------------------------------------------------
//
// Everything above measures *an agent tree*. capacity.ts then divides by that
// figure to answer a narrower question — "how many more **task** agents fit" —
// and until KAN-276 this file had no idea the two populations differed. It
// grouped every `claude` tree on the machine and averaged them, and the average
// it produced was labelled `measured` and used as the per-task-agent cost.
//
// That is a contamination with a direction, and the direction is the wrong one.
// Supervisors (`epic`, `story`) are exempt from the cap by capacity.ts's own
// rule — never counted in `running`, never reserved for. So they were excluded
// from the numerator and included in the divisor, and headroom divides by that
// divisor:
//
//     headroomByCpu = (cores − inUse − reserved) ÷ agentCores
//
// A smaller divisor is a bigger headroom. Averaging in a population that the
// gate does not admit therefore *loosened* the gate. Measured on this machine
// on 2026-08-11 over a 60s window with a real compile running:
//
//     task agents (n=2):  0.198 core, 844 MB
//     supervisors (n=3):  0.014 core, 775 MB   <- 14x cheaper on CPU
//     all five averaged:  0.087 core, 803 MB   <- what capacity.ts divided by
//
// 0.087 against a true 0.198 is a 56% understatement of what a task agent
// costs, and the fleet reading taken with **zero** task agents running divided
// by 0.123 — a per-task-agent cost computed from a sample containing no task
// agents at all.
//
// The two dimensions are not the same shape, and that is the finding worth
// carrying: over those windows supervisors were ~14x cheaper on **CPU** and 92%
// as heavy on **memory** (775 MB against 844 MB). They are the same `claude`
// binary holding the same MCP servers; what they mostly do not do is spend CPU.
// So excluding them corrects the core figure sharply and the memory figure
// barely — which is why the memory half of this defect is fixed in capacity.ts
// as a *reserve* rather than here as a divisor correction. See
// SUPERVISOR_MEMORY_BYTES there, and read the caveat beside it: a supervisor
// that is actively staffing does spend real CPU (0.25 core, measured), and the
// low figure above is its duty cycle rather than its peak.
//
// HOW A TREE IS CLASSIFIED, AND WHY FROM ARGV
//
// Every agent the daemon starts is given a butchr MCP server whose argv carries
// `--workspace-type <type> --workspace-key <KEY>` (launchers.ts; the argv-not-env
// choice is KAN-145's, made so this is readable from outside the process). That
// server is a child of the agent's `claude` root, so it is already inside the
// tree being measured and costs one /proc/<pid>/cmdline read to find.
//
// The alternative was the root's `/proc/<pid>/cwd`, which is also
// `…/workspaces/<type>/<key>`. It is declined because a cwd is a thing a running
// process may change and the marker is a thing the daemon placed deliberately.
//
// AN UNMARKED TREE IS NOT CHARGEABLE, WHICH IS THE SAFE DIRECTION
//
// A `claude` tree with no marker is not an agent this daemon started — the
// human's own session, or an agent from another tool. It is left out of the
// chargeable population rather than assumed to be a task agent. That is the
// conservative direction on the dimension that matters: excluding a tree can
// only *raise* the per-agent average or empty the sample, and an empty sample
// degrades to the labelled seed (agent-cost-damping.ts), which is higher still.
// The failure mode this leaves is a visible one — reports say `seed` — rather
// than a silent contamination of the kind this comment exists because of.

import * as fs from 'fs';

const CLK_TCK = 100; // Linux USER_HZ; constant on every platform Butchr runs on.
const PAGE_SIZE = 4096;

/**
 * The argv flags the daemon puts on every agent's butchr MCP server. Read
 * rather than assumed — see the header for why argv and not cwd.
 */
const WORKSPACE_TYPE_FLAG = '--workspace-type';
const WORKSPACE_KEY_FLAG = '--workspace-key';

/** One process as read from /proc/<pid>/stat. */
export interface ProcessSample {
  pid: number;
  comm: string;
  ppid: number;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  rssBytes: number;
}

/** The held "before" side of a measurement; produced by startMeasurement(). */
export interface MeasurementStart {
  procs: Map<number, ProcessSample>;
  loadStart: number;
  /** Wall-clock ms (Date.now()) when the sample was taken. */
  startedAt: number;
}

/** One agent tree's cost over the window. */
export interface AgentTreeCost {
  /** The root claude process of the tree. */
  pid: number;
  /** Processes in the tree at the end of the window. */
  processes: number;
  /** utime+stime deltas over wall-clock seconds — cores, not load average. */
  cores: number;
  residentMb: number;
  /**
   * The workspace type this tree is an agent for — `task`, `epic`, `story` —
   * read from the butchr MCP argv marker inside the tree (KAN-276).
   *
   * Null when the tree carries no marker: a `claude` the daemon did not start.
   * Null is not "probably a task agent"; see the header for why it is left out
   * of the chargeable population rather than assumed into it.
   */
  workspaceType: string | null;
  /** The issue key from the same marker, for reports. Null with the type. */
  workspaceKey: string | null;
}

/** The summed figures for some population of trees. */
export interface AgentCostTotals {
  agents: number;
  cores: number;
  residentMb: number;
}

/**
 * Whether a workspace type hands work out rather than doing it.
 *
 * Injected rather than imported, and required rather than defaulted, both for
 * the same reason: supervisor-ness is registry state that integrations
 * populate at boot (registry.ts), so a module-level import would answer
 * `false` for every type in any process that measures without booting the
 * registry — a verify script, say — and silently put supervisors back in the
 * divisor. That is precisely the defect KAN-276 fixed, so it is made
 * impossible to reintroduce by omission: the compiler asks every caller who
 * supervises, and a proof script answers with its own fixture predicate.
 */
export type IsSupervisorType = (type: string) => boolean;

/**
 * A finished measurement. Field names and order match what the script's
 * --json mode has always printed: {elapsed, loadStart, loadEnd, agents,
 * totals} — evidence produced before and after the KAN-55 extraction must
 * stay comparable.
 *
 * `totals` therefore still means *every* tree, unchanged, and KAN-276 did not
 * repurpose it: an old measurement and a new one have to describe the same
 * quantity or the archived evidence stops being comparable. What KAN-276 added
 * is the split — `chargeable` and `supervisors` — and it is `chargeable` that
 * the divisor is computed from. A reader looking for "what one task agent
 * costs" wants `chargeable`; `totals` answers "what is this machine carrying".
 */
export interface AgentCostMeasurement {
  /** Wall-clock seconds actually elapsed between the two samples. */
  elapsed: number;
  loadStart: number;
  loadEnd: number;
  /** Per-tree figures, sorted by cores descending. */
  agents: AgentTreeCost[];
  /** Every tree, whatever it is. The historical field, unchanged. */
  totals: AgentCostTotals;
  /**
   * The trees capacity.ts is entitled to divide by: marked, and not a
   * supervisor. This is the per-task-agent population, and
   * {@link sampleFromMeasurement} averages over it.
   */
  chargeable: AgentCostTotals;
  /**
   * The supervisor trees that were held out. Reported rather than discarded:
   * their memory is charged as a reserve in capacity.ts, and a reader who
   * cannot see what was excluded cannot check the exclusion.
   */
  supervisors: AgentCostTotals;
  /**
   * Trees carrying no workspace marker — not started by this daemon, and
   * charged nowhere. Reported for the same reason: a machine where this is
   * unexpectedly large is a machine where the marker has stopped working, and
   * that shows up as capacity degrading to the seed.
   */
  unmarked: AgentCostTotals;
}

/**
 * One sample of every process on the machine.
 *
 * Reads /proc directly rather than shelling out to ps, because the fields that
 * matter (utime, stime, rss in pages) are there without parsing a human-facing
 * table, and because a process that exits between readdir and read is an
 * ordinary event here, not an error.
 */
export function sampleProcesses(): Map<number, ProcessSample> {
  const procs = new Map<number, ProcessSample>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm is parenthesised and may itself contain spaces and parens, so
      // split on the LAST ')' rather than tokenising the whole line.
      const close = stat.lastIndexOf(')');
      const open = stat.indexOf('(');
      const comm = stat.slice(open + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      // Fields are 1-indexed from `pid` in proc(5); after the split above,
      // rest[0] is field 3 (state), so field N is rest[N - 3].
      procs.set(pid, {
        pid,
        comm,
        ppid: Number(rest[1]),          // field 4
        cpuTicks: Number(rest[11]) + Number(rest[12]), // fields 14, 15
        rssBytes: Number(rest[21]) * PAGE_SIZE          // field 24
      });
    } catch {
      // Exited between readdir and read, or a kernel thread we may not stat.
    }
  }
  return procs;
}

/**
 * Which agent each process belongs to: the nearest `claude` ancestor that is
 * not itself descended from a `claude`.
 *
 * The outer test is what keeps a subagent from being counted as an agent of
 * its own. A subagent is work the parent agent chose to do; charging it
 * separately would report two agents where the user started one.
 */
export function groupByAgent(procs: Map<number, ProcessSample>): Map<number, number[]> {
  const rootOf = new Map<number, number | null>();
  const isClaude = (p: ProcessSample) => p.comm === 'claude';

  const resolve = (pid: number, seen = new Set<number>()): number | null => {
    if (rootOf.has(pid)) return rootOf.get(pid)!;
    const p = procs.get(pid);
    if (!p || seen.has(pid)) return null;
    seen.add(pid);
    const parentRoot = p.ppid > 1 ? resolve(p.ppid, seen) : null;
    // A claude under a claude belongs to the outer one; a claude under
    // anything else starts a group.
    const root = parentRoot ?? (isClaude(p) ? pid : null);
    rootOf.set(pid, root);
    return root;
  };

  const groups = new Map<number, number[]>();
  for (const pid of procs.keys()) {
    const root = resolve(pid);
    if (root === null) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(pid);
  }
  return groups;
}

/**
 * The argv of one process, as a list, or an empty list if it cannot be read.
 *
 * /proc/<pid>/cmdline is NUL-separated with a trailing NUL, so the split leaves
 * an empty last element; it is dropped rather than left to look like an
 * argument. A kernel thread has an empty cmdline, and a process that exited
 * between the group walk and this read is an ordinary event here, exactly as it
 * is in sampleProcesses().
 */
export function readCmdline(pid: number): string[] {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  } catch {
    return [];
  }
}

/**
 * Which workspace a tree belongs to, from the butchr MCP marker on any process
 * inside it.
 *
 * The first marker found wins and the walk stops there. A tree holds exactly
 * one butchr MCP server in the ordinary case, and a tree that somehow held two
 * would hold two for the *same* workspace — the marker names the workspace the
 * agent was launched for, which one process cannot disagree with another about.
 *
 * `pids` is the tree's membership; `readArgv` is injected so a proof can drive
 * this from a fixture with no /proc at all, which is what lets the verify
 * script construct a supervisor tree without starting a supervisor.
 */
export function classifyTree(
  pids: readonly number[],
  readArgv: (pid: number) => string[] = readCmdline
): { workspaceType: string | null; workspaceKey: string | null } {
  for (const pid of pids) {
    const argv = readArgv(pid);
    const t = argv.indexOf(WORKSPACE_TYPE_FLAG);
    if (t < 0) continue;
    const type = argv[t + 1];
    if (typeof type !== 'string' || type === '' || type.startsWith('--')) continue;
    const k = argv.indexOf(WORKSPACE_KEY_FLAG);
    const key = k >= 0 ? argv[k + 1] : undefined;
    return {
      workspaceType: type,
      workspaceKey: typeof key === 'string' && key !== '' && !key.startsWith('--') ? key : null
    };
  }
  return { workspaceType: null, workspaceKey: null };
}

/**
 * Sum a set of trees. Trivial, and named because three populations are summed
 * the same way and a fourth will be.
 */
export function totalsOf(trees: readonly AgentTreeCost[]): AgentCostTotals {
  return {
    agents: trees.length,
    cores: trees.reduce((s, a) => s + a.cores, 0),
    residentMb: trees.reduce((s, a) => s + a.residentMb, 0)
  };
}

const loadNow = (): number =>
  Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

/**
 * Take the "before" sample. The returned value is plain data: a long-lived
 * caller (KAN-56's periodic loop) holds it for as long as it likes and hands
 * it to finishMeasurement() when the window closes.
 */
export function startMeasurement(): MeasurementStart {
  return { procs: sampleProcesses(), loadStart: loadNow(), startedAt: Date.now() };
}

/**
 * Take the "after" sample and compute per-tree figures over the window since
 * `start` — the exact figures scripts/measure-agent-cost.mjs prints.
 *
 * `isSupervisor` decides which trees are chargeable and has no default; see
 * {@link IsSupervisorType} for why omitting it is made impossible rather than
 * given a safe-looking fallback. `readArgv` is injected only so a proof can
 * classify fixture trees without /proc.
 */
export function finishMeasurement(
  start: MeasurementStart,
  isSupervisor: IsSupervisorType,
  readArgv: (pid: number) => string[] = readCmdline
): AgentCostMeasurement {
  const after = sampleProcesses();
  const elapsed = (Date.now() - start.startedAt) / 1000;
  const loadEnd = loadNow();
  return {
    ...aggregateTrees(start.procs, after, elapsed, isSupervisor, readArgv),
    elapsed,
    loadStart: start.loadStart,
    loadEnd
  };
}

/**
 * The whole of the per-tree arithmetic and the chargeable/supervisor split,
 * as a pure function of two process samples.
 *
 * Split out of {@link finishMeasurement} by KAN-276 so a proof can drive it
 * with **no /proc, no fleet and no machine** — which is what lets the exclusion
 * be tested where it actually has to hold. CI runs on a box with no agents on
 * it, so a proof that could only measure a live fleet would assert nothing
 * there and go green on an empty sample; that is the shape of failure this
 * epic keeps re-finding, and capacity.ts is pure for exactly the same reason.
 *
 * `before`/`after` are the two samples; everything else is injected.
 */
export function aggregateTrees(
  before: Map<number, ProcessSample>,
  after: Map<number, ProcessSample>,
  elapsed: number,
  isSupervisor: IsSupervisorType,
  readArgv: (pid: number) => string[] = readCmdline
): Pick<AgentCostMeasurement, 'agents' | 'totals' | 'chargeable' | 'supervisors' | 'unmarked'> {
  // Group on the *later* sample so processes started mid-window are included;
  // their CPU counts from zero, which is what "cost over this window" means.
  const groups = groupByAgent(after);

  const agents: AgentTreeCost[] = [];
  for (const [root, pids] of groups) {
    let ticks = 0;
    let rss = 0;
    for (const pid of pids) {
      const now = after.get(pid);
      if (!now) continue;
      const then = before.get(pid);
      // A pid absent from `before` is new: all of its CPU falls in the window.
      ticks += now.cpuTicks - (then?.cpuTicks ?? 0);
      rss += now.rssBytes;
    }
    agents.push({
      pid: root,
      processes: pids.length,
      cores: ticks / CLK_TCK / elapsed,
      residentMb: rss / (1024 * 1024),
      ...classifyTree(pids, readArgv)
    });
  }
  agents.sort((a, b) => b.cores - a.cores);

  // Three disjoint populations, so every tree is accounted for somewhere and a
  // reader can add them back up. An unmarked tree is its own case rather than
  // being folded into either — "we did not start this" and "this supervises"
  // are different facts, and only one of them earns a memory reserve.
  const marked = agents.filter((a) => a.workspaceType !== null);
  const supervisorTrees = marked.filter((a) => isSupervisor(a.workspaceType as string));
  const chargeableTrees = marked.filter((a) => !isSupervisor(a.workspaceType as string));
  const unmarkedTrees = agents.filter((a) => a.workspaceType === null);

  return {
    agents,
    totals: totalsOf(agents),
    chargeable: totalsOf(chargeableTrees),
    supervisors: totalsOf(supervisorTrees),
    unmarked: totalsOf(unmarkedTrees)
  };
}

/**
 * Measure over a window of `seconds`. Convenience over start/finish for a
 * caller that just wants one figure and can afford to wait in place.
 */
export async function measureAgentCost(
  seconds: number,
  isSupervisor: IsSupervisorType
): Promise<AgentCostMeasurement> {
  const start = startMeasurement();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return finishMeasurement(start, isSupervisor);
}
