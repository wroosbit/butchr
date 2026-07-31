// What one agent actually costs this machine, measured rather than assumed.
//
// MEASURED_AGENT_COST in daemon/src/capacity.ts is the whole cap in two
// numbers, and KAN-34 shipped them from a single afternoon's observation with
// a note saying "re-measure it before trusting it". This is that instrument,
// so the next person to argue with the constants can produce evidence instead
// of an opinion.
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
// Usage: node daemon/scripts/measure-agent-cost.mjs [seconds] [--json]

import fs from 'fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const seconds = Number(args.find((a) => !a.startsWith('--')) ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('seconds must be a positive number');
  process.exit(1);
}

const CLK_TCK = 100; // Linux USER_HZ; constant on every platform Butchr runs on.
const PAGE_SIZE = 4096;

/**
 * One sample of every process on the machine.
 *
 * Reads /proc directly rather than shelling out to ps, because the fields that
 * matter (utime, stime, rss in pages) are there without parsing a human-facing
 * table, and because a process that exits between readdir and read is an
 * ordinary event here, not an error.
 */
function sampleProcesses() {
  const procs = new Map();
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
function groupByAgent(procs) {
  const rootOf = new Map();
  const isClaude = (p) => p.comm === 'claude';

  const resolve = (pid, seen = new Set()) => {
    if (rootOf.has(pid)) return rootOf.get(pid);
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

  const groups = new Map();
  for (const pid of procs.keys()) {
    const root = resolve(pid);
    if (root === null) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(pid);
  }
  return groups;
}

const loadNow = () => Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

const before = sampleProcesses();
const loadStart = loadNow();
const startedAt = Date.now();

if (!json) {
  const agentCount = groupByAgent(before).size;
  console.log(
    `measuring ${agentCount} agent tree(s) for ${seconds}s ` +
    `(load average is ${loadStart.toFixed(2)} right now)…`
  );
}

await new Promise((r) => setTimeout(r, seconds * 1000));

const after = sampleProcesses();
const elapsed = (Date.now() - startedAt) / 1000;
const loadEnd = loadNow();

// Group on the *later* sample so processes started mid-window are included;
// their CPU counts from zero, which is what "cost over this window" means.
const groups = groupByAgent(after);

const agents = [];
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
    residentMb: rss / (1024 * 1024)
  });
}
agents.sort((a, b) => b.cores - a.cores);

const totals = {
  agents: agents.length,
  cores: agents.reduce((s, a) => s + a.cores, 0),
  residentMb: agents.reduce((s, a) => s + a.residentMb, 0)
};

if (json) {
  console.log(JSON.stringify({ elapsed, loadStart, loadEnd, agents, totals }, null, 2));
} else {
  console.log(`\nover ${elapsed.toFixed(1)}s, load ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}\n`);
  console.log('  pid      procs     cores   resident');
  for (const a of agents) {
    console.log(
      `  ${String(a.pid).padStart(7)} ${String(a.processes).padStart(9)}` +
      ` ${a.cores.toFixed(2).padStart(9)}  ${(a.residentMb.toFixed(0) + ' MB').padStart(9)}`
    );
  }
  console.log(
    `\n  ${totals.agents} agent(s): ${totals.cores.toFixed(2)} cores total, ` +
    `${(totals.cores / (totals.agents || 1)).toFixed(2)} per agent; ` +
    `${(totals.residentMb / (totals.agents || 1)).toFixed(0)} MB resident per agent.`
  );
  console.log(
    `  load average ${loadEnd.toFixed(2)} against ${totals.cores.toFixed(2)} cores of actual work:\n` +
    '  the gap is queueing, and it is what the person using the desktop feels.'
  );
}
