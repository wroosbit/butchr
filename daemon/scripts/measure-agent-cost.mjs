// What one agent actually costs this machine, measured rather than assumed.
//
// The measurement itself lives in daemon/src/agent-cost.ts (extracted there
// by KAN-55 so the daemon can run the same instrument); this script is the
// argv parsing and the printing. See the module header for what is measured
// and why — trees under the outermost claude, CPU as cores rather than load
// average.
//
// Since KAN-276 it also says which *kind* of agent each tree is, and reports
// the task-agent average separately from the all-tree one. Those two numbers
// were the same number until KAN-276, and the difference between them is the
// defect that ticket is about: capacity.ts divides by "what one task agent
// costs" and was handed the average over every tree including the supervisors
// it never admits. Measured on a 4-core laptop on 2026-08-11, the two answers
// were 0.198 and 0.087 core.
//
// Usage: node daemon/scripts/measure-agent-cost.mjs [seconds] [--json]

import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMeasurement, finishMeasurement, groupByAgent } from '../dist/agent-cost.js';
import { supervisorPredicate } from './lib/supervisor-types.mjs';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { isSupervisor } = await supervisorPredicate(distDir);

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

const measurement = finishMeasurement(start, isSupervisor);
const { elapsed, loadStart, loadEnd, agents, totals, chargeable, supervisors, unmarked } =
  measurement;

const per = (t, field, digits) =>
  t.agents > 0 ? (t[field] / t.agents).toFixed(digits) : '—';

if (json) {
  // `totals` keeps its historical meaning (every tree) so archived --json
  // evidence stays comparable across this change; the split is additive.
  console.log(
    JSON.stringify(
      { elapsed, loadStart, loadEnd, agents, totals, chargeable, supervisors, unmarked },
      null,
      2
    )
  );
} else {
  console.log(`\nover ${elapsed.toFixed(1)}s, load ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}\n`);
  console.log('  pid      type       key          procs     cores   resident');
  for (const a of agents) {
    console.log(
      `  ${String(a.pid).padStart(7)} ${(a.workspaceType ?? '(unmarked)').padEnd(10)}` +
      ` ${(a.workspaceKey ?? '-').padEnd(12)} ${String(a.processes).padStart(5)}` +
      ` ${a.cores.toFixed(2).padStart(9)}  ${(a.residentMb.toFixed(0) + ' MB').padStart(9)}`
    );
  }
  console.log(
    `\n  task agents  ${String(chargeable.agents).padStart(2)}: ` +
    `${per(chargeable, 'cores', 3)} core, ${per(chargeable, 'residentMb', 0)} MB each` +
    '   <- what capacity.ts divides by'
  );
  console.log(
    `  supervisors  ${String(supervisors.agents).padStart(2)}: ` +
    `${per(supervisors, 'cores', 3)} core, ${per(supervisors, 'residentMb', 0)} MB each` +
    '   <- CPU not charged; memory reserved off the cap'
  );
  if (unmarked.agents > 0) {
    console.log(
      `  unmarked     ${String(unmarked.agents).padStart(2)}: ` +
      `${per(unmarked, 'cores', 3)} core, ${per(unmarked, 'residentMb', 0)} MB each` +
      '   <- not started by this daemon; charged nowhere'
    );
  }
  console.log(
    `  all trees    ${String(totals.agents).padStart(2)}: ` +
    `${per(totals, 'cores', 3)} core, ${per(totals, 'residentMb', 0)} MB each` +
    '   <- what it divided by before KAN-276'
  );
  console.log(
    `\n  load average ${loadEnd.toFixed(2)} against ${totals.cores.toFixed(2)} cores of actual work:\n` +
    '  the gap is queueing, and it is what the person using the desktop feels.'
  );
}
