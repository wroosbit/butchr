import * as fs from 'fs';
import { readCmdline, sampleProcesses, type ProcessSample } from './agent-cost.js';

/**
 * Reaping MCP stdio servers whose client has gone (KAN-273).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY WRONG
 * ---------------------------------------------------------------------------
 *
 * An agent's MCP servers are started by `claude`, not by this daemon, and they
 * are not always cleaned up when it stops talking to them. Two shapes, and
 * KAN-273 was filed believing they were separate wastes:
 *
 *   1. an `mcp-remote` hung on the official Atlassian endpoint's OAuth flow —
 *      it never reads its input, `claude` gives up and closes the request
 *      channel, and ~80 MB stays resident for the life of the box;
 *   2. an MCP server whose `claude` died, adopted by `init`, surviving daemon
 *      restarts and fleet churn with nothing that remembers it.
 *
 * **They are one mechanism read at two moments**, and the measurement that
 * says so is on the ticket: on 2026-08-22, all five `mcp-remote` processes on
 * the manager box were parented to `systemd --user` — *including every one
 * belonging to a live agent*. `npx` spawns the real `mcp-remote` and exits, so
 * the child is adopted by `init` the moment it starts. There is no window in
 * which it was ever parented to `claude`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OBVIOUS IDENTIFIER IS THE DANGEROUS ONE
 * ---------------------------------------------------------------------------
 *
 * KAN-273's description asks the right question — *"whatever identifies an
 * orphan must be exact"* — and the two answers that suggest themselves are
 * both wrong **now**, whatever they were worth when it was filed:
 *
 * - **By parentage.** On 2026-08-11 a proxy under `claude` was live and one
 *   under `systemd` was litter. Today every proxy is under `systemd`, so a
 *   reaper that matched on that would have killed all five live agents'
 *   servers. The identifier did not stop working; the world moved under it.
 * - **By command line.** `mcp-remote` in an argv matches a healthy server on
 *   an install with the proxy `off`, where it is the *only* route to Atlassian.
 *   It also matches the shell doing the searching, which is how two probes on
 *   this ticket found themselves in their own results.
 *
 * - **By a recorded pid.** Unavailable, and not by oversight: the daemon does
 *   not spawn these processes and never holds their pids.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTIFIER THIS USES, AND WHY IT CANNOT SAY "ORPHAN" ABOUT A LIVE SERVER
 * ---------------------------------------------------------------------------
 *
 * Claude Code wires MCP stdio over `AF_UNIX` socketpairs — one pair per
 * direction, so a server's fd 0 and fd 1 are *different* sockets. A server
 * whose fd 0 has no peer can never be sent another request: there is nothing
 * left to write into it, and a socket does not reconnect. That is the whole
 * of the test, and it is a statement about reachability rather than about
 * parentage, liveness or naming.
 *
 * `/proc/net/unix` carries a `RefCount` per socket, and `/proc/<pid>/fd`
 * carries who holds it. Measured on the manager box, 2026-08-22:
 *
 * ```
 *                                   refCount   fdRefs   difference
 *   mcp-remote x5 (client gone)         2         1          1
 *   daemon/dist/mcp.js x3 (working)     3         1          2
 * ```
 *
 * So `refCount - fdRefs >= 2` iff a peer still holds a reference. The second
 * row is the positive control and it is the important one: three MCP servers
 * the measuring agent was talking to at the time, on the same instrument,
 * returning the other answer. **A check with no reachable failing branch is
 * not a weak check — it is a check that does not exist while appearing to.**
 *
 * The subtraction rather than a bare `refCount === 2` is what makes it
 * derivation-free: a duplicated fd raises both terms, so the difference is
 * unmoved by how many descriptors happen to be open on the socket.
 *
 * **It fails toward declining to reap, deliberately.** Every way this can go
 * wrong — a `/proc/<pid>/fd` this daemon may not read, a socket absent from
 * `/proc/net/unix`, a `/proc` entry that vanished mid-walk — *undercounts*
 * `fdRefs` or removes the row, which inflates the difference or yields
 * {@link ClientLink} `unmeasurable`. Both read as *keep*. There is no failure
 * mode in which a healthy server is misread as unreachable, and that asymmetry
 * is the reason this is safe to run unattended.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not make an unreaped orphan *visible*. `groupByAgent` resolves a
 * process to its nearest `claude` ancestor and an init-adopted process has
 * none, so between sweeps these are still charged nowhere — not the divisor,
 * not `running`, not any reserve (comment `11403` on KAN-273 is where that gap
 * was first written down). Reaping removes the memory rather than accounting
 * for it, which is the better outcome and not the same one. The cost model's
 * blindness to init-adopted processes is untouched here and outlives this
 * module.
 */

/**
 * The MCP servers this daemon is willing to reap.
 *
 * A closed set rather than a predicate, because "which processes may this
 * daemon kill" is exactly the decision that must not be extensible by
 * accident. Adding a kind is a deliberate edit here; it cannot be reached by
 * passing a wider matcher in from a call site.
 */
export type McpServerKind = 'atlassian-mcp-remote' | 'butchr-mcp';

/** One MCP stdio server process, as read off `/proc`. */
export interface McpServerProcess {
  readonly pid: number;
  readonly kind: McpServerKind;
  readonly ppid: number;
  readonly rssBytes: number;
  /** Seconds since the process started. See {@link REAP_GRACE_SECONDS}. */
  readonly ageSeconds: number;
  /** The socket inode on fd 0, or null when stdin is not a unix socket. */
  readonly stdinInode: number | null;
  /** argv, kept so a reap can be re-verified against the same process. */
  readonly argv: readonly string[];
}

/**
 * Whether a server's client can still reach it.
 *
 * Three states and not two: `unmeasurable` is what this returns when the
 * instrument could not answer, and it is deliberately distinct from `gone`.
 * An absent `/proc/net/unix` row and a socket whose peer has been released are
 * the same *absence*, and collapsing them would make "this daemon could not
 * look" and "the client has gone" the same verdict — with a kill on the end of
 * it.
 */
export type ClientLink =
  | { readonly state: 'connected'; readonly refCount: number; readonly fdRefs: number }
  | { readonly state: 'gone'; readonly refCount: number; readonly fdRefs: number }
  | { readonly state: 'unmeasurable'; readonly because: string };

/**
 * A server that has been *shown* unreachable, paired with the reading that
 * showed it.
 *
 * `link.state` is the literal `'gone'` rather than {@link ClientLink}, and
 * that is load-bearing: {@link reapUnreachableMcpServers} takes only these, so
 * handing it a server whose client is connected is a **compile error** and not
 * an assertion somebody can delete. The invariant here is about what the code
 * is able to say, which is what makes it the type's job — the assertions in
 * this module are for what actually happened on the machine, which is the
 * other half.
 */
export interface UnreachableMcpServer {
  readonly process: McpServerProcess;
  readonly link: { readonly state: 'gone'; readonly refCount: number; readonly fdRefs: number };
}

/** A server left alone, with the reason, so the exclusion can be checked. */
export interface HeldMcpServer {
  readonly process: McpServerProcess;
  readonly link: ClientLink;
  readonly because: string;
}

/**
 * How long a server must have been running before it may be reaped.
 *
 * Not because a young server is expected to read as unreachable — the
 * socketpair is created before the fork, so there is no window in which a
 * healthy one has no peer. It is here because the cost of the two mistakes is
 * not symmetric: a reap deferred by one sweep costs 80 MB for 30 seconds, and
 * a reap that races a bring-up costs an agent its Atlassian tools for the rest
 * of its run. Thirty seconds is comfortably longer than the ~12 s an agent
 * takes to finish registering (KAN-435's measurement).
 */
export const REAP_GRACE_SECONDS = 30;

/**
 * The difference between a socket's kernel refcount and the descriptors held
 * on it, at or above which a peer is still attached.
 *
 * Measured rather than derived from the kernel source, and the measurement is
 * in this file's header: 2 for every connected endpoint, 1 for an endpoint
 * whose peer has been released.
 */
const PEER_ATTACHED_MIN_DIFFERENCE = 2;

/** Which MCP server a command line names, or null if it names none. */
export function mcpServerKindOf(argv: readonly string[]): McpServerKind | null {
  // Matched on argv *elements*, never on a joined string: the joined form is
  // what lets a process match on a shell's own command line, which is the trap
  // recorded on KAN-273 twice — a probe finding itself and reporting it.
  const isNode = (a: string) => /(^|\/)node$/.test(a);
  if (!argv.some(isNode)) return null;
  if (argv.some((a) => /(^|\/)mcp-remote$/.test(a) || a === 'mcp-remote')) {
    return 'atlassian-mcp-remote';
  }
  if (argv.some((a) => /(^|\/)daemon\/dist\/mcp\.js$/.test(a))) return 'butchr-mcp';
  return null;
}

/**
 * Every unix socket's refcount, by inode.
 *
 * `/proc/net/unix`'s second column is a hex refcount and its last is the
 * inode. Parsed positionally from the end, because a socket bound to a path
 * carries that path as a trailing field on some kernels and a fixed column
 * index would read it as the inode.
 */
export function readUnixSocketRefCounts(text?: string): Map<number, number> {
  const counts = new Map<number, number>();
  let raw: string;
  try {
    raw = text ?? fs.readFileSync('/proc/net/unix', 'utf8');
  } catch {
    return counts;
  }
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    // Layout: Num RefCount Protocol Flags Type St Inode [Path]
    const refCount = Number.parseInt(fields[1], 16);
    const inode = Number(fields[6]);
    if (!Number.isFinite(refCount) || !Number.isInteger(inode) || inode <= 0) continue;
    counts.set(inode, refCount);
  }
  return counts;
}

/**
 * How many open descriptors, across every process this daemon can read, refer
 * to each socket inode.
 *
 * One walk of `/proc/*_/fd` for the whole machine rather than one per
 * candidate: the candidates are few and the walk is the expensive half.
 * Anything unreadable is skipped silently, which undercounts — see the
 * header's note on which direction that fails in.
 */
export function countSocketFdReferences(pids?: readonly number[]): Map<number, number> {
  const refs = new Map<number, number>();
  let entries: string[];
  try {
    entries = pids ? pids.map(String) : fs.readdirSync('/proc');
  } catch {
    return refs;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // not ours to read, or exited mid-walk
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (!match) continue;
      const inode = Number(match[1]);
      refs.set(inode, (refs.get(inode) ?? 0) + 1);
    }
  }
  return refs;
}

/** The socket inode on a process's fd 0, or null if stdin is not a socket. */
export function stdinSocketInode(pid: number): number | null {
  try {
    const target = fs.readlinkSync(`/proc/${pid}/fd/0`);
    const match = /^socket:\[(\d+)\]$/.exec(target);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Seconds since a process started.
 *
 * `/proc/<pid>`'s ctime is the process's start time on Linux. Cross-checked
 * against field 22 of `/proc/<pid>/stat` over `/proc/uptime` on 2026-08-22 —
 * both gave 544.2 s for the same pid — and preferred to it because it needs no
 * `_SC_CLK_TCK`, which Node cannot ask for and which would otherwise arrive
 * here as a hard-coded 100.
 */
export function processAgeSeconds(pid: number, now = Date.now()): number {
  try {
    return (now - fs.statSync(`/proc/${pid}`).ctimeMs) / 1000;
  } catch {
    return 0; // unreadable reads as brand new, which is the keep direction
  }
}

/** Every MCP stdio server process on this machine that this daemon knows. */
export function identifyMcpServers(
  procs: Map<number, ProcessSample> = sampleProcesses(),
  now = Date.now()
): McpServerProcess[] {
  const found: McpServerProcess[] = [];
  for (const [pid, sample] of procs) {
    const argv = readCmdline(pid);
    const kind = mcpServerKindOf(argv);
    if (kind === null) continue;
    found.push({
      pid,
      kind,
      ppid: sample.ppid,
      rssBytes: sample.rssBytes,
      ageSeconds: processAgeSeconds(pid, now),
      stdinInode: stdinSocketInode(pid),
      argv
    });
  }
  return found;
}

/** Whether a server's client still holds the other end of its input socket. */
export function classifyClientLink(
  inode: number | null,
  refCounts: Map<number, number>,
  fdRefs: Map<number, number>
): ClientLink {
  if (inode === null) {
    return { state: 'unmeasurable', because: 'stdin is not a unix socket' };
  }
  const refCount = refCounts.get(inode);
  if (refCount === undefined) {
    return { state: 'unmeasurable', because: `no /proc/net/unix row for inode ${inode}` };
  }
  const held = fdRefs.get(inode) ?? 0;
  if (held === 0) {
    return { state: 'unmeasurable', because: `no descriptor found for inode ${inode}` };
  }
  const difference = refCount - held;
  return difference >= PEER_ATTACHED_MIN_DIFFERENCE
    ? { state: 'connected', refCount, fdRefs: held }
    : { state: 'gone', refCount, fdRefs: held };
}

/** What one sweep found, both halves. */
export interface McpOrphanSurvey {
  /** Shown unreachable, and old enough to touch. */
  readonly unreachable: readonly UnreachableMcpServer[];
  /**
   * Left alone, with the reason. Reported rather than dropped, for the reason
   * agent-cost.ts reports its excluded trees: a reader who cannot see what was
   * excluded cannot check the exclusion.
   */
  readonly held: readonly HeldMcpServer[];
}

/** Classify every MCP server on this machine. Reads only; kills nothing. */
export function surveyMcpServers(
  servers: readonly McpServerProcess[] = identifyMcpServers(),
  refCounts: Map<number, number> = readUnixSocketRefCounts(),
  fdRefs: Map<number, number> = countSocketFdReferences()
): McpOrphanSurvey {
  const unreachable: UnreachableMcpServer[] = [];
  const held: HeldMcpServer[] = [];
  for (const process of servers) {
    const link = classifyClientLink(process.stdinInode, refCounts, fdRefs);
    if (link.state !== 'gone') {
      held.push({
        process,
        link,
        because:
          link.state === 'connected'
            ? `client holds the other end (refCount ${link.refCount} - ${link.fdRefs} fd(s) = ${link.refCount - link.fdRefs})`
            : `cannot measure: ${link.because}`
      });
      continue;
    }
    if (process.ageSeconds < REAP_GRACE_SECONDS) {
      held.push({
        process,
        link,
        because: `within the ${REAP_GRACE_SECONDS}s grace (up ${process.ageSeconds.toFixed(1)}s)`
      });
      continue;
    }
    unreachable.push({ process, link });
  }
  return { unreachable, held };
}

/** What one reap attempt did to one process. */
export interface ReapOutcome {
  readonly pid: number;
  readonly kind: McpServerKind;
  readonly rssBytes: number;
  readonly result: 'signalled' | 'vanished' | 'pid-reused' | 'refused';
  readonly detail?: string;
}

/**
 * Kill the servers that have been shown unreachable.
 *
 * Takes {@link UnreachableMcpServer} and nothing wider, so there is no way to
 * express "reap this process" without having first produced the reading that
 * says it is unreachable.
 *
 * **Re-verified immediately before the signal, against argv.** Between the
 * survey and here the process may have exited and its pid been reused by
 * something else entirely; killing on a stale pid is the one way this could
 * harm a process it was never looking at. The re-read costs one file per
 * candidate and turns that race into a `pid-reused` outcome.
 */
export function reapUnreachableMcpServers(
  candidates: readonly UnreachableMcpServer[],
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) =>
    process.kill(pid, signal)
): ReapOutcome[] {
  const outcomes: ReapOutcome[] = [];
  for (const { process: server } of candidates) {
    const base = { pid: server.pid, kind: server.kind, rssBytes: server.rssBytes };
    const argvNow = readCmdline(server.pid);
    if (argvNow.length === 0) {
      outcomes.push({ ...base, result: 'vanished' });
      continue;
    }
    if (argvNow.join('\0') !== server.argv.join('\0')) {
      outcomes.push({
        ...base,
        result: 'pid-reused',
        detail: `argv changed since the survey; left alone`
      });
      continue;
    }
    try {
      // SIGTERM rather than SIGKILL: these are Node processes with their own
      // shutdown, and a server that will not go on a TERM is a finding rather
      // than something to escalate past on the same sweep. The next sweep sees
      // it again thirty seconds later.
      kill(server.pid, 'SIGTERM');
      outcomes.push({ ...base, result: 'signalled' });
    } catch (err) {
      outcomes.push({
        ...base,
        result: 'refused',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return outcomes;
}

/** One whole sweep: survey, reap, and say what was done and what was not. */
export interface McpOrphanSweep {
  readonly survey: McpOrphanSurvey;
  readonly outcomes: readonly ReapOutcome[];
  /** Resident bytes held by the servers that were signalled. */
  readonly reclaimedBytes: number;
}

export function sweepMcpOrphans(
  options: {
    survey?: McpOrphanSurvey;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {}
): McpOrphanSweep {
  const survey = options.survey ?? surveyMcpServers();
  const outcomes = reapUnreachableMcpServers(survey.unreachable, options.kill);
  const reclaimedBytes = outcomes
    .filter((o) => o.result === 'signalled')
    .reduce((sum, o) => sum + o.rssBytes, 0);
  return { survey, outcomes, reclaimedBytes };
}

/** One line per sweep, for the daemon log. Empty when there is nothing to say. */
export function describeSweep(sweep: McpOrphanSweep): string | null {
  if (sweep.outcomes.length === 0) return null;
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  const byResult = new Map<string, number>();
  for (const o of sweep.outcomes) byResult.set(o.result, (byResult.get(o.result) ?? 0) + 1);
  const parts = [...byResult].map(([result, n]) => `${n} ${result}`).join(', ');
  return (
    `[mcp-orphan] ${parts}; ${mb(sweep.reclaimedBytes)} reclaimed; ` +
    `${sweep.survey.held.length} left alone`
  );
}
