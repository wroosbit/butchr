#!/usr/bin/env node
/**
 * WHAT THIS MEASURES: how long a daemon restart leaves each surviving agent
 * unaddressable over the channel — per agent, per restart, in milliseconds.
 *
 * KAN-454 asks what a restart costs the channel layer. The daemon already
 * records every input that question needs, and has since KAN-274; nothing had
 * ever read them back. This reads them.
 *
 * The three lines it joins, all written by the daemon itself:
 *
 *   `Butchr daemon listening on <sock> (pid N)`
 *       a restart boundary. t0 for everything below it.
 *
 *   `[reconcile] N of M surviving agent(s) hold no channel registration: a, b`
 *   `[reconcile] All N surviving agent(s) hold a channel registration.`
 *       who survived the restart, named. This is the denominator, and it is
 *       the daemon's own count of what it lost — see the KAN-274 comment at
 *       daemon/src/daemon.ts, which explains why it counts what is missing now
 *       rather than claiming a memory of its predecessor.
 *
 *   `Connection conn-K is <type>/<KEY> — X identified of Y connected`
 *       a registration arriving. The FIRST one per agent after t0 is that
 *       agent's recovery; later ones are additional connections (bring-up
 *       spawns more than one MCP server) and are counted but not timed.
 *
 * WHAT THIS DOES NOT MEASURE, said here because the gap is the whole risk:
 * this is the DAEMON's view of the channel coming back. It does not establish
 * that a message sent in that window would have been delivered to a model, and
 * it says nothing about what the agent lost while the link was down — that is
 * the mid-turn question, which needs a staged restart and cannot be read out of
 * a log. Whoever reads this must not let "recovered in 200ms" stand in for
 * "cost nothing".
 *
 * The down-window is bounded, never exact: the old daemon does not log its own
 * death, so the outage began at or before the last line it wrote. That bound is
 * reported as `downWindowMs` and is an UPPER bound on the gap between daemons —
 * the real one is shorter by however long the old daemon sat idle before dying.
 *
 * Usage:
 *   node daemon/scripts/measure-restart-channel-recovery.mjs [--log PATH] [--json]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_LOG = join(homedir(), '.local/share/butchr/daemon.log');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const logIdx = argv.indexOf('--log');
const logPath = logIdx >= 0 ? argv[logIdx + 1] : DEFAULT_LOG;

// The log carries PTY output, so it is not clean UTF-8 text throughout. Read it
// as latin1 so every byte maps to a character and no line is silently dropped:
// a decoder that replaces invalid sequences can eat a whole line, and a missing
// line here reads as an agent that never came back.
let raw;
try {
  raw = readFileSync(logPath, 'latin1');
} catch (err) {
  console.error(`cannot read ${logPath}: ${err.message}`);
  process.exit(2);
}

const lines = raw.split('\n');

const TS = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;
const START = /Butchr daemon listening on \S+ \(pid (\d+)\)/;
const SURVIVORS_NONE = /\[reconcile\] (\d+) of (\d+) surviving agent\(s\) hold no channel registration: ([^.]+)\./;
const SURVIVORS_ALL = /\[reconcile\] All (\d+) surviving agent\(s\) hold a channel registration\./;
// Deliberately NOT anchored on the trailing em-dash. The log is decoded latin1
// (see above), which turns every multi-byte character into mojibake, so a
// pattern containing `—` matches nothing — and the failure is silent and total:
// the first cut of this script required it, found zero identifications, and
// printed "NEVER re-registered" for all 60 agent-restarts in the file. That is a
// well-formed, plausible, catastrophically wrong answer, and nothing in the
// output could have said so. Match only ASCII the decoder cannot damage.
const IDENTIFY = /Connection (conn-\d+) is (\S+\/\S+)/;

function tsOf(line) {
  const m = TS.exec(line);
  return m ? Date.parse(m[1]) : null;
}

/** Every restart boundary in the file, with the line index it sits at. */
const restarts = [];
for (let i = 0; i < lines.length; i++) {
  const m = START.exec(lines[i]);
  if (!m) continue;
  const at = tsOf(lines[i]);
  if (at === null) continue;
  restarts.push({ index: i, at, pid: m[1] });
}

// The last line the PREVIOUS daemon wrote bounds the outage. Walk back from the
// boundary to the newest timestamped line that belongs to the old process.
function lastLineBefore(index, startAt) {
  for (let i = index - 1; i >= 0; i--) {
    const t = tsOf(lines[i]);
    if (t === null) continue;
    // A line stamped at or after the boundary is the new daemon's own preamble
    // (staleness, credentials), not the old daemon's. Keep walking.
    if (t >= startAt - 1) continue;
    return t;
  }
  return null;
}

const results = [];

for (let r = 0; r < restarts.length; r++) {
  const { index, at, pid } = restarts[r];
  const end = r + 1 < restarts.length ? restarts[r + 1].index : lines.length;

  let survivors = null;
  let survivorsHeldRegistration = false;

  // The reconcile verdict lands within a second of the boundary. Scan a bounded
  // window rather than the whole epoch so a later restart's line cannot be
  // attributed to this one.
  for (let i = index; i < end; i++) {
    const none = SURVIVORS_NONE.exec(lines[i]);
    if (none) {
      survivors = none[3].split(',').map((s) => s.trim()).filter(Boolean);
      break;
    }
    const all = SURVIVORS_ALL.exec(lines[i]);
    if (all) {
      survivors = [];
      survivorsHeldRegistration = true;
      break;
    }
  }

  // No reconcile verdict at all means this boundary is not a restart-with-
  // survivors: a cold boot, or a daemon that died before reconciling. Reported
  // rather than dropped, because a silently skipped restart is indistinguishable
  // from one that went perfectly.
  if (survivors === null) {
    results.push({ pid, at: new Date(at).toISOString(), verdict: 'no-reconcile-line', agents: [] });
    continue;
  }

  const downWindowMs = (() => {
    const prev = lastLineBefore(index, at);
    return prev === null ? null : at - prev;
  })();

  /** First identification per agent after t0, plus how many arrived in total. */
  const firstSeen = new Map();
  const totalConns = new Map();
  for (let i = index; i < end; i++) {
    const m = IDENTIFY.exec(lines[i]);
    if (!m) continue;
    const t = tsOf(lines[i]);
    if (t === null) continue;
    const addr = m[2];
    totalConns.set(addr, (totalConns.get(addr) ?? 0) + 1);
    if (!firstSeen.has(addr)) firstSeen.set(addr, { at: t, conn: m[1] });
  }

  const agents = survivors.map((addr) => {
    const seen = firstSeen.get(addr);
    return {
      agent: addr,
      recoveredMs: seen ? seen.at - at : null,
      conn: seen ? seen.conn : null,
      connectionsInWindow: totalConns.get(addr) ?? 0,
    };
  });

  results.push({
    pid,
    at: new Date(at).toISOString(),
    verdict: survivorsHeldRegistration ? 'survivors-kept-registration' : 'survivors-dropped',
    downWindowMs,
    windowSeconds: Math.round(((r + 1 < restarts.length ? restarts[r + 1].at : at) - at) / 1000),
    agents,
  });
}

if (asJson) {
  console.log(JSON.stringify({ logPath, restarts: results }, null, 2));
  process.exit(0);
}

console.log(`log: ${logPath}`);
console.log(`restart boundaries found: ${results.length}\n`);

const timed = [];
const neverCameBack = [];

for (const r of results) {
  if (r.verdict === 'no-reconcile-line') {
    console.log(`${r.at}  pid ${r.pid}  — no reconcile verdict in window (cold boot or early death)`);
    continue;
  }
  if (r.verdict === 'survivors-kept-registration') {
    console.log(`${r.at}  pid ${r.pid}  — reconcile found survivors ALREADY registered (no drop to measure)`);
    continue;
  }
  const down = r.downWindowMs === null ? 'unknown' : `<=${r.downWindowMs}ms`;
  console.log(`${r.at}  pid ${r.pid}  survivors: ${r.agents.length}  daemon gap ${down}`);
  for (const a of r.agents) {
    if (a.recoveredMs === null) {
      console.log(`    ${a.agent.padEnd(18)}  NEVER re-registered in this window`);
      neverCameBack.push({ restart: r.at, agent: a.agent });
    } else {
      timed.push(a.recoveredMs);
      const extra = a.connectionsInWindow > 1 ? `  (+${a.connectionsInWindow - 1} more conn in window)` : '';
      console.log(`    ${a.agent.padEnd(18)}  back in ${String(a.recoveredMs).padStart(6)}ms  via ${a.conn}${extra}`);
    }
  }
  console.log('');
}

if (timed.length) {
  const sorted = [...timed].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  console.log('--- recovery latency across every measured restart ---');
  console.log(`samples      ${sorted.length} agent-restarts`);
  console.log(`min          ${sorted[0]}ms`);
  console.log(`median       ${pct(50)}ms`);
  console.log(`p90          ${pct(90)}ms`);
  console.log(`max          ${sorted[sorted.length - 1]}ms`);
}
console.log(`\nagents that never re-registered: ${neverCameBack.length}`);
for (const n of neverCameBack) console.log(`    ${n.restart}  ${n.agent}`);
