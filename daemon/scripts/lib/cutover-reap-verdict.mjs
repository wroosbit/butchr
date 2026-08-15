// The rollback's reap verdict, as a pure function of one `list_agents` frame
// and one process census (KAN-483).
//
// It lives here, apart from both the driver that feeds it and the proof that
// exercises it, for the reason `cutover-health-predicate.mjs` gives one file
// over: the thing shipped and the thing tested have to be the same expression.
// The defect this exists to close was never a coding mistake either — it was a
// rollback that MOVED THE RECORD AND LEFT THE REALITY RUNNING, and then
// reported COMPLETE, because nothing in it ever asked whether its subjects
// were still alive.
//
// NODE BUILTINS ONLY, AND ONLY `fs`. No `dist`, no `node_modules`. This runs on
// the worst day, on a checkout nobody installed, beside
// `cutover-health-predicate.mjs` and `probe-cutover-readiness.mjs` which make
// the same promise for the same reason.

import fs from 'fs';

/**
 * ## What went wrong, stated once, because the fix only makes sense against it
 *
 * `~/butchr-cutover/rollback.sh` had two halves: revert the config, then move
 * every post-flip transcript out of `~/.claude` so `claude --continue` finds
 * the original again. Both halves are about RECORDS. Neither half ever stood
 * an agent down.
 *
 * So the flip started three agents under CrabCast, the watchdog tripped, the
 * rollback archived all three transcripts, logged `ROLLBACK COMPLETE`, and all
 * three processes were still running 31 minutes later. Measured 2026-08-15,
 * `epic/KAN-203`:
 *
 *     17:24:16  ROLLBACK archived post-flip transcript for task/kan-473
 *     17:24:17  ROLLBACK COMPLETE (reason: watchdog-health-trip)
 *     17:55     PID 2102451  cwd task/kan-473  age 1897s  cpu 2:26  STILL RUNNING
 *
 * What that cost is on the ticket and is not hypothetical: one of the three
 * committed, pushed and opened a pull request nobody asked for; two agents ran
 * in one worktree for half an hour; they reaped each other's processes reading
 * the other as a stray; and `butchr_capacity` reported `atCapacity: true` with
 * `load1 8.61` for load NO INSTRUMENT COULD ATTRIBUTE, because three of the
 * processes consuming it were not on any census Butchr keeps.
 *
 * ## Why the verdict has THREE terms and not one
 *
 * `agents === 0` alone is what the old rollback would have checked if it had
 * checked anything, and it is precisely the reading that fails here: the
 * registry is a RECORD. Archiving a transcript, or standing an agent down in
 * the registry, empties it whether or not anything stopped. So:
 *
 *   - **`agents`** — the daemon's own census. Zero means the registry expects
 *     nobody.
 *   - **`missing`** — `missingAgents`, the rows the registry expects and cannot
 *     see. A drain that empties `agents` while `missing` climbs has not drained;
 *     it has lost track. `cutover.sh` step 5 already requires BOTH to be zero
 *     before it will flip, and a rollback that asked less of itself than the
 *     flip did would be the weaker gate on the more dangerous side.
 *   - **`processes`** — the machine. This is the term that would have caught
 *     the incident, and it is the only one of the three that is not a record.
 *
 * ⚠ **The third term is an OBSERVATION and never a control.** KAN-483 is
 * explicit that CrabCast's process table is CrabCast's: the reap is a
 * `deactivate_by_key` per agent, so that CrabCast stops what CrabCast started.
 * Counting is how we find out whether it did. Nothing in this module or its
 * driver signals, kills or otherwise touches a process, and
 * `verify-cutover-reap-verdict.mjs` §6 asserts that no kill verb appears in
 * either file so a later edit cannot quietly add one.
 *
 * ## A read that did not happen is not a verdict
 *
 * Copied deliberately from `cutover-health-predicate.mjs`, which learned it the
 * expensive way: "I could not look" and "I looked and they are alive" are
 * different claims. `read: false` renders as exit 2 and the caller counts it
 * separately — a rollback that says INCOMPLETE because the socket was silent is
 * saying something about its instrument, and it must say so in those words.
 *
 * @param {{census: {agents: number, missing: number} | null,
 *          processes: number | null,
 *          readError?: unknown}} input
 * @returns {{read: boolean, down: boolean|null, agents: number|null,
 *   missing: number|null, processes: number|null, reasons: string[],
 *   code: 0|1|2}}
 */
export function reapVerdict(input) {
  const readError = input?.readError ?? null;
  const census = input?.census ?? null;
  const processes = input?.processes ?? null;

  // Any one of the three being unreadable makes the whole verdict unreadable.
  // NOT a partial answer: a report saying "the registry is empty" while the
  // process census failed is the exact shape of the sentence this ticket is
  // about — true about the record, silent about the reality, and read as both.
  if (readError || census === null || typeof processes !== 'number') {
    return {
      read: false,
      down: null,
      agents: census?.agents ?? null,
      missing: census?.missing ?? null,
      processes: typeof processes === 'number' ? processes : null,
      reasons: [
        readError
          ? `the read did not happen: ${String(readError?.message ?? readError)}`
          : census === null
            ? 'no census frame — the daemon socket did not answer'
            : 'no process census — /proc could not be scanned'
      ],
      code: 2
    };
  }

  const agents = Number(census.agents ?? 0);
  const missing = Number(census.missing ?? 0);

  const reasons = [];
  if (agents > 0) reasons.push(`${agents} agent(s) still in the daemon census`);
  if (missing > 0) reasons.push(`${missing} agent(s) expected by the registry and not visible (missingAgents)`);
  if (processes > 0) reasons.push(`${processes} CrabCast agent process(es) still on the machine`);

  const down = agents === 0 && missing === 0 && processes === 0;

  return {
    read: true,
    down,
    agents,
    missing,
    processes,
    reasons,
    code: down ? 0 : 1
  };
}

/**
 * Count the CrabCast agent processes on this machine, by reading `/proc`.
 *
 * ## Why a scan of `/proc` and not `pgrep`
 *
 * Because the answer has to be defensible, and a `pgrep -f` for this pattern
 * MATCHES ITS OWN COMMAND LINE. That is not a stylistic worry: the first
 * measurement taken while working this ticket ran
 * `ps -eo args | grep -c '[c]rabcast/agents'` and got **2** on a machine with
 * **zero** such processes — both matches were the invoking shell and the grep
 * itself. Had that reading been believed, this ticket's own evidence would have
 * been an invented pair of orphans. `excludePids` below is that trapdoor
 * closed by construction rather than by remembering to write the pattern in
 * brackets.
 *
 * ## What it matches, and why the full path rather than the substring
 *
 * A CrabCast-started agent is launched against its own prompt file under the
 * CrabCast agents directory — measured on this machine as
 * `~/.local/share/crabcast/agents/<id>/prompt.md`. Matching the RESOLVED
 * DIRECTORY rather than the substring `crabcast/agents` is what keeps a
 * checkout path, a log line quoted in somebody's editor, or this repository's
 * own scripts out of the count.
 *
 * ## What this cannot see, named because a count reads as complete
 *
 * A process whose command line no longer mentions its prompt file — because it
 * re-execed, or because CrabCast changes how it launches — is invisible here
 * and the count would read zero. That is the honest edge of this instrument:
 * it is a positive detector, so a NON-zero count is strong evidence and a zero
 * is only as good as the marker. `verify-cutover-reap-verdict.mjs` §3 pins the
 * marker against a recorded real command line so the day it stops matching is
 * a red rather than a silent zero, and the driver prints the marker it used on
 * every run so the reader can check it themselves.
 *
 * @param {{procRoot?: string, agentsDir?: string, excludePids?: number[]}} [opts]
 * @returns {{count: number, pids: number[], marker: string, scanned: number}}
 */
export function countAgentProcesses(opts = {}) {
  const procRoot = opts.procRoot ?? '/proc';
  const agentsDir = opts.agentsDir ?? defaultAgentsDir();
  const exclude = new Set(opts.excludePids ?? [process.pid, process.ppid]);

  // Trailing separator: `.../crabcast/agents/` matches a process working on an
  // agent and not one whose argument IS the directory (this script, told where
  // to look).
  const marker = agentsDir.endsWith('/') ? agentsDir : `${agentsDir}/`;

  const pids = [];
  let scanned = 0;

  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch (err) {
    throw new Error(`cannot read ${procRoot}: ${String(err?.message ?? err)}`);
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (exclude.has(pid)) continue;
    scanned++;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`${procRoot}/${entry}/cmdline`, 'utf8');
    } catch {
      // A process that exited between readdir and read, or one this uid cannot
      // see. Skipped rather than counted: an unreadable process is not evidence
      // of an orphan, and the driver reports `scanned` so a caller can see how
      // much of the table this reading actually covered.
      continue;
    }
    // `/proc/<pid>/cmdline` is NUL-separated; a plain `includes` over the raw
    // string is enough and needs no split.
    if (cmdline.includes(marker)) pids.push(pid);
  }

  return { count: pids.length, pids: pids.sort((a, b) => a - b), marker, scanned };
}

/** Where CrabCast keeps its per-agent directories, honouring XDG. */
export function defaultAgentsDir() {
  const base =
    process.env.CRABCAST_AGENTS_DIR ||
    `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/crabcast/agents`;
  return base;
}
