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
// Since KAN-368 it also says which trees were *doing anything* over the window,
// and reports the working average separately from the all-task-agent one. Those
// two are the same number only on a fleet where every agent is busy: an agent
// sitting at its prompt is still a chargeable tree and measures near zero, which
// is how `agentCores` fell 0.262 → 0.184 → 0.081 across four readings while
// `cap` rose 9 → 13 → 15 on an unchanged machine. Working-ness is established
// from herdr's `agent_status` at both ends of the window — never from the CPU
// figure, which would be selection on the quantity being measured. See
// lib/herdr-activity.mjs.
//
// Usage: node daemon/scripts/measure-agent-cost.mjs [seconds] [--json] [--no-activity]

import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMeasurement, finishMeasurement, groupByAgent } from '../dist/agent-cost.js';
import { supervisorPredicate } from './lib/supervisor-types.mjs';
import { readHerdrStatuses, activityClassifier } from './lib/herdr-activity.mjs';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { isSupervisor } = await supervisorPredicate(distDir);

const args = process.argv.slice(2);
const json = args.includes('--json');
// Opt out for a machine with no herdr on it. It does not make the split
// "default off": every tree then classifies `unknown`, the working population
// is empty, and the report says so rather than printing an average nobody
// established — which is the whole reason agent-cost.ts has three arms.
const withActivity = !args.includes('--no-activity');
const seconds = Number(args.find((a) => !a.startsWith('--')) ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('seconds must be a positive number');
  process.exit(1);
}

const statusesBefore = withActivity ? readHerdrStatuses() : new Map();
const start = startMeasurement();

if (!json) {
  const agentCount = groupByAgent(start.procs).size;
  console.log(
    `measuring ${agentCount} agent tree(s) for ${seconds}s ` +
    `(load average is ${start.loadStart.toFixed(2)} right now)…`
  );
}

await new Promise((r) => setTimeout(r, seconds * 1000));

// Read at the *end* of the window and compared against the start, so a tree
// whose status moved is classified `unknown` rather than charged to whichever
// end happened to be read. See lib/herdr-activity.mjs for why that matters.
const statusesAfter = withActivity ? readHerdrStatuses() : new Map();
const measurement = finishMeasurement(
  start,
  isSupervisor,
  undefined,
  withActivity ? activityClassifier(statusesBefore, statusesAfter) : () => 'unknown'
);
const {
  elapsed,
  loadStart,
  loadEnd,
  agents,
  totals,
  chargeable,
  supervisors,
  unmarked,
  working,
  notWorking,
  activityUnknown
} = measurement;

const per = (t, field, digits) =>
  t.agents > 0 ? (t[field] / t.agents).toFixed(digits) : '—';

if (json) {
  // `totals` keeps its historical meaning (every tree) so archived --json
  // evidence stays comparable across this change; the split is additive.
  console.log(
    JSON.stringify(
      {
        elapsed,
        loadStart,
        loadEnd,
        agents,
        totals,
        chargeable,
        supervisors,
        unmarked,
        working,
        notWorking,
        activityUnknown
      },
      null,
      2
    )
  );
} else {
  console.log(`\nover ${elapsed.toFixed(1)}s, load ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}\n`);
  console.log('  pid      type       key          procs     cores   resident   activity');
  for (const a of agents) {
    console.log(
      `  ${String(a.pid).padStart(7)} ${(a.workspaceType ?? '(unmarked)').padEnd(10)}` +
      ` ${(a.workspaceKey ?? '-').padEnd(12)} ${String(a.processes).padStart(5)}` +
      ` ${a.cores.toFixed(2).padStart(9)}  ${(a.residentMb.toFixed(0) + ' MB').padStart(9)}` +
      `   ${a.activity}`
    );
  }
  console.log(
    `\n  task agents  ${String(chargeable.agents).padStart(2)}: ` +
    `${per(chargeable, 'cores', 3)} core, ${per(chargeable, 'residentMb', 0)} MB each` +
    '   <- what capacity.ts divides by'
  );
  // The activity split (KAN-368), printed immediately under the figure it
  // qualifies: `chargeable` is the average `working` and `not-working` are
  // pooled into, and the gap between the first two lines is how much of it is a
  // statement about idleness rather than about cost.
  console.log(
    `    of which working      ${String(working.agents).padStart(2)}: ` +
    `${per(working, 'cores', 3)} core, ${per(working, 'residentMb', 0)} MB each` +
    '   <- what a working agent costs (KAN-368 AC1)'
  );
  console.log(
    `    of which not working  ${String(notWorking.agents).padStart(2)}: ` +
    `${per(notWorking, 'cores', 3)} core, ${per(notWorking, 'residentMb', 0)} MB each` +
    '   <- at its prompt; still in the divisor today'
  );
  console.log(
    `    of which unestablished ${String(activityUnknown.agents).padStart(1)}: ` +
    `${per(activityUnknown, 'cores', 3)} core, ${per(activityUnknown, 'residentMb', 0)} MB each` +
    '   <- no verdict, or one that moved mid-window'
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
