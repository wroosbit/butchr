// What one agent actually costs this machine, measured rather than assumed.
//
// The measurement itself lives in daemon/src/agent-cost.ts (extracted there
// by KAN-55 so the daemon can run the same instrument); this script is the
// argv parsing and the printing. See the module header for what is measured
// and why — trees under the outermost claude, CPU as cores rather than load
// average.
//
// Usage: node daemon/scripts/measure-agent-cost.mjs [seconds] [--json]

import { startMeasurement, finishMeasurement, groupByAgent } from '../dist/agent-cost.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const seconds = Number(args.find((a) => !a.startsWith('--')) ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('seconds must be a positive number');
  process.exit(1);
}

const start = startMeasurement();

if (!json) {
  const agentCount = groupByAgent(start.procs).size;
  console.log(
    `measuring ${agentCount} agent tree(s) for ${seconds}s ` +
    `(load average is ${start.loadStart.toFixed(2)} right now)…`
  );
}

await new Promise((r) => setTimeout(r, seconds * 1000));

const { elapsed, loadStart, loadEnd, agents, totals } = finishMeasurement(start);

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
