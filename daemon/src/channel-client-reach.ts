import * as fs from 'fs';
import * as path from 'path';
import type { ChannelReach } from './channel.js';
import { CORE_MCP_SERVER, DEV_CHANNELS_FLAG } from './launchers.js';

/**
 * WHETHER THE CLIENT ON THE OTHER END OF THIS CONNECTION CAN RENDER A FRAME —
 * measured off its argv, by the one process that can see it (KAN-319).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, AND WHY KAN-495 AND KAN-497 COULD NOT SEE IT
 * ---------------------------------------------------------------------------
 *
 * Claude Code discards `notifications/claude/channel` unless its client was
 * started with `--dangerously-load-development-channels=server:<name>` — measured
 * both directions by `probe-channel-reaches-model.mjs` under KAN-495. Two
 * mechanisms already existed to keep the daemon from writing frames into that
 * void, and **both derive their answer from a spawn Butchr made**:
 *
 * - `AgentRuntime.channelReach` — a property of a runtime's *spawn shape*;
 * - `ChannelSpawnReachStore` — what one *Butchr spawn* decided, per agent.
 *
 * So `channelReach(address)` is `spawnRecord ?? runtime.channelReach`, and every
 * branch of it is an inference about a launch. **On 2026-08-20 the fleet met the
 * case that has no launch to infer from.** herdr restored four supervisor panes
 * itself — `resume_agents_on_restore`, its own config — and reconstructed each
 * command line as `claude --resume <uuid>`, which is a spelling `launchers.ts`
 * cannot produce: no channel flag, and no `--permission-mode` either, which is
 * the corroborating fingerprint. Butchr spawned none of them, so the store held
 * nothing, the fall-through answered about spawns that were not these, and the
 * daemon wrote frames at four clients that threw every one of them away.
 *
 * Measured that night, `ps -eo pid,lstart,args` against the arrival record:
 *
 * | client | argv | frames arrive |
 * | --- | --- | --- |
 * | `epic/KAN-39`, `epic/KAN-59`, `epic/KAN-203`, `story/KAN-117` | `claude --resume <uuid>` | **no** |
 * | every CrabCast-spawned task agent, `task/KAN-335` included | `claude … --dangerously-load-development-channels=server:butchr …` | **yes** |
 *
 * `task/KAN-335` is the row that matters: a **task** agent in the same 12:17
 * process cohort as the four, carrying the flag and receiving normally. It is
 * what refutes *"the old MCP-server generation is broken"* and *"supervisors are
 * unreachable"* alike. Neither population decides delivery. The argv does.
 *
 * ---------------------------------------------------------------------------
 * SO THE MEASUREMENT MOVES TO THE PROCESS — AND THE DAEMON TAKES IT ITSELF
 * ---------------------------------------------------------------------------
 *
 * An `mcp.js` is a **stdio child of the client it serves** — verified on the
 * live fleet, every server's `ppid` being its own agent's `claude` — and it
 * reaches the daemon over a Unix socket under `BUTCHR_DIR`, so the two are on
 * one host by construction. The daemon therefore has a route to the client's
 * command line that costs nothing and needs nobody's cooperation: **the server
 * pid it is already told on `hello`** (KAN-526's build block), up one `ppid`,
 * and into that process's `cmdline`.
 *
 * ⚠ **That route, rather than having the server announce its own verdict, and
 * the difference is the whole operational value of this ticket.** An `mcp.js` is
 * spawned when its client starts and **nothing in the deploy path restarts one**
 * — that is KAN-526's finding, in this repository, measured. A verdict announced
 * by the server would therefore reach exactly the agents that have restarted
 * since it shipped, which is *precisely the population that no longer has the
 * defect*: a restarted client gets a flagged command line from `launchers.ts`.
 * The four supervisors this ticket is about would have stayed silently green
 * until something restarted them, at which point the fix would have had nothing
 * left to fix. Measuring from the pid works on **every connection whose server
 * announces one**, this minute, with nothing respawned.
 *
 * The property worth naming either way: every other source answers about an
 * *address* or a *runtime*, and this one answers about **the process on the
 * other end of the socket the frame is going down**. It is taken at `hello`,
 * while that process is demonstrably alive because it is the one talking, and it
 * dies with the connection it describes — so nothing has to be invalidated and
 * no pid is ever read after the moment it was known good.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THREE STATES, AND `'unknown'` IS DOING REAL WORK HERE
 * ---------------------------------------------------------------------------
 *
 * The failure this fix can cause is the opposite of the one it repairs: a false
 * `'not-loaded'` takes a working agent off the channel and onto the composer,
 * whose Ctrl+C destroys the tool call it is running. So this module answers
 * `'not-loaded'` **only when it positively read a client's command line and the
 * flag was not on it** — and `'unknown'` for every way of not knowing: no
 * `/proc`, an unreadable one, an empty `cmdline`, or a parent whose argv this
 * module cannot recognise as a Claude Code client at all. `'unknown'` routes
 * exactly as this daemon routed before, and claims nothing.
 */

/**
 * What one measurement of a client's command line concluded.
 *
 * A `detail` beside the verdict rather than a bare enum, because the verdict
 * that costs somebody an interrupt is `'not-loaded'` and the first question
 * anybody will ask of it is *how do you know*. It is carried through `hello`, so
 * the sentence is available in the daemon log and on a diagnostic row without
 * anybody re-deriving it from a pid that may be gone by then.
 */
export interface ClientChannelReach {
  reach: ChannelReach;
  /** One sentence naming what was read and what it decided. */
  detail: string;
  /**
   * The client process the reading is about, or `null` where none was
   * identified. **Diagnostic only** — nothing routes on it, and by the time a
   * reader sees it the pid may belong to something else.
   */
  clientPid: number | null;
}

/**
 * Whether an argv element looks like a flag, and therefore terminates the
 * variadic channel list.
 *
 * A bare `-` is not a flag by this test, which is correct: it is the
 * conventional stdin operand and Claude Code would take it as a channel entry.
 */
function isFlagLike(arg: string): boolean {
  return arg.startsWith('-') && arg.length > 1;
}

/**
 * The channel entries named on this command line, or `null` when the flag is
 * absent entirely.
 *
 * ⚠ **Both spellings, and that is not hedging.** `launchers.ts` composes the
 * `=` form and argues at length why (KAN-496: the flag is variadic, so the
 * two-token form swallows whatever follows it). But this function reads command
 * lines **it did not compose** — that is its entire purpose — so recognising
 * only the form Butchr writes would answer `'not-loaded'` for a correctly
 * flagged client somebody else launched. Reading is liberal; writing stays
 * strict.
 *
 * An empty array is a real answer and distinct from `null`: the flag was there
 * and named nothing, which loads no channel at all.
 */
export function channelEntriesInArgv(argv: readonly string[]): string[] | null {
  let found = false;
  const entries: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === DEV_CHANNELS_FLAG) {
      found = true;
      // Variadic: everything up to the next flag belongs to the list.
      for (let j = i + 1; j < argv.length && !isFlagLike(argv[j]); j++) entries.push(argv[j]);
      continue;
    }
    if (arg.startsWith(`${DEV_CHANNELS_FLAG}=`)) {
      found = true;
      // Comma-splitting is for the same reason the two-token form is read:
      // a spelling this file does not write is still a spelling it may meet.
      for (const entry of arg.slice(DEV_CHANNELS_FLAG.length + 1).split(',')) {
        if (entry) entries.push(entry);
      }
    }
  }
  return found ? entries : null;
}

/**
 * Whether this argv is a Claude Code client's, as far as this module can tell.
 *
 * ⚠ **This guard is what stands between a wrapper and a false negative.** If a
 * client were started through `bash -c 'claude --dangerously-…'`, the parent's
 * argv is bash's and the whole command sits inside **one** element, so the token
 * scan above finds no flag — and without this guard that reads as `'not-loaded'`
 * for an agent that hears us perfectly. An argv this function does not
 * recognise is therefore `'unknown'`, never a verdict.
 *
 * Measured on this fleet: every client's `argv[0]` is the literal `claude`,
 * flagged and flagless alike, so the recognised case is the ordinary one and the
 * fall-through is genuinely for the shapes nobody here produces.
 */
function looksLikeClaudeClient(argv: readonly string[]): boolean {
  const argv0 = argv[0];
  if (!argv0) return false;
  return path.basename(argv0) === 'claude';
}

/**
 * The verdict for one command line. Pure, so the proof can drive every branch
 * of it without a process to point at.
 *
 * `argv` of `null` is *could not read it*, which is not the same fact as an
 * empty command line and answers `'unknown'` either way.
 */
export function reachFromClientArgv(
  argv: readonly string[] | null,
  serverName: string = CORE_MCP_SERVER
): { reach: ChannelReach; detail: string } {
  if (!argv || argv.length === 0) {
    return {
      reach: 'unknown',
      detail: "this server could not read its client's command line, so nothing here established whether the client loads Butchr's channel"
    };
  }

  const entries = channelEntriesInArgv(argv);
  const wanted = `server:${serverName}`;

  if (entries !== null) {
    if (entries.includes(wanted)) {
      return {
        reach: 'loaded',
        detail: `the client's command line carries ${DEV_CHANNELS_FLAG} naming ${wanted}, so it renders channel frames from this server`
      };
    }
    return {
      reach: 'not-loaded',
      detail:
        `the client's command line carries ${DEV_CHANNELS_FLAG} but does not name ${wanted} ` +
        `(it names ${entries.length ? entries.join(', ') : 'nothing at all'}), so it discards this server's channel frames in silence`
    };
  }

  if (looksLikeClaudeClient(argv)) {
    return {
      reach: 'not-loaded',
      detail:
        `the client's command line is a Claude Code invocation with no ${DEV_CHANNELS_FLAG} on it ` +
        `(argv: ${argv.slice(0, 4).join(' ')}${argv.length > 4 ? ' …' : ''}), so it discards notifications/claude/channel in silence — ` +
        'argv is fixed at process start, so nothing short of restarting this client changes it'
    };
  }

  return {
    reach: 'unknown',
    detail:
      `this server's parent process is not a command line this reader recognises as a Claude Code client ` +
      `(argv[0] is ${JSON.stringify(argv[0])}), so nothing here established whether the client loads Butchr's channel`
  };
}

/**
 * One process's argv off `/proc`, or `null` for every way of not getting it.
 *
 * Linux-only and deliberately unapologetic about it: the fleet is Linux, and the
 * honest answer elsewhere is the `null` that becomes `'unknown'`. Nothing here
 * throws — a reader that throws on an unreadable `/proc` entry would take down
 * an MCP server's bring-up over a diagnostic.
 */
export function readProcessArgv(pid: number): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    const parts = raw.split('\0');
    // `cmdline` is NUL-TERMINATED as well as NUL-separated, so a trailing empty
    // element is the ordinary shape rather than an empty argument.
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.length ? parts : null;
  } catch {
    return null;
  }
}

/**
 * One process's parent pid off `/proc/<pid>/stat`, or `null`.
 *
 * ⚠ **Parsed after the LAST `)`, never by splitting on spaces.** Field 2 is the
 * executable name in parentheses and it may contain spaces and parentheses of
 * its own, so a positional split is a parser that works until somebody's binary
 * is called `my program`. `procfs(5)` documents the shape; this is the reading
 * it prescribes.
 */
export function readParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // [0] is state, [1] is ppid.
    const ppid = Number(afterComm[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * What this reading is about, so a `'not-loaded'` can be argued with.
 *
 * Every field is diagnostic; nothing routes on anything but {@link
 * ClientChannelReach.reach}.
 */
export interface ClientReachMeasurement extends ClientChannelReach {
  /** The MCP server process the walk started from. */
  serverPid: number | null;
}

/**
 * Measure the client behind one MCP server, from the server's own pid.
 *
 * Called by the daemon at `hello`, which is the one moment the pid is known to
 * be live — it belongs to the process that is talking. **Pid reuse is therefore
 * not a hazard here and is checked for anyway**: `serverLooksRight` confirms the
 * process at that pid is an `mcp.js` before its parent is believed, so a stale
 * or recycled pid answers `'unknown'` rather than describing somebody else's
 * process tree. A check that cannot fail is not a check, and this one can:
 * point it at any other pid on the machine and it declines.
 *
 * Both readers are injectable so the proof can drive every branch without a
 * process to point at; the defaults are the real `/proc` reads, and the proof
 * exercises those too against a process it starts itself.
 */
export function measureClientReachForServer(opts: {
  serverPid: number | null | undefined;
  serverName?: string;
  readArgv?: (pid: number) => string[] | null;
  readPpid?: (pid: number) => number | null;
}): ClientReachMeasurement {
  const readArgv = opts.readArgv ?? readProcessArgv;
  const readPpid = opts.readPpid ?? readParentPid;
  const serverName = opts.serverName ?? CORE_MCP_SERVER;
  const serverPid = typeof opts.serverPid === 'number' ? opts.serverPid : null;

  if (serverPid === null) {
    return {
      reach: 'unknown',
      detail:
        'this connection announced no server pid (an mcp.js from before KAN-526), so there is no ' +
        "process to walk up from and nothing here established whether its client loads Butchr's channel",
      clientPid: null,
      serverPid: null
    };
  }

  const serverArgv = readArgv(serverPid);
  if (!serverArgv || !serverArgv.some((arg) => path.basename(arg) === 'mcp.js')) {
    return {
      reach: 'unknown',
      detail:
        `pid ${serverPid} is not an mcp.js — it is ${
          serverArgv ? JSON.stringify(serverArgv.slice(0, 2).join(' ')) : 'unreadable'
        }, so this daemon is not looking at the process that announced itself and declines to ` +
        'describe its parent',
      clientPid: null,
      serverPid
    };
  }

  const clientPid = readPpid(serverPid);
  if (clientPid === null) {
    return {
      reach: 'unknown',
      detail: `could not read the parent of mcp.js pid ${serverPid}, so its client's command line was never seen`,
      clientPid: null,
      serverPid
    };
  }

  const { reach, detail } = reachFromClientArgv(readArgv(clientPid), serverName);
  return { reach, detail, clientPid, serverPid };
}

/**
 * WHICH SOURCE DECIDES, WHEN MORE THAN ONE HAS AN ANSWER (KAN-319).
 *
 * Extracted as a function, rather than left as a `??` chain in `daemon.ts`,
 * because the ORDER is the fix and an order nothing can test is an order that
 * drifts. `verify-channel-client-reach.mjs` §2 drives it directly and its red
 * drive swaps two of these lines.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHAT EACH SOURCE IS ACTUALLY A CLAIM ABOUT
 * ---------------------------------------------------------------------------
 *
 * 1. **`measured` — the client's own argv, read by its own child, for the
 *    connection this frame is about to go down.** It wins because it is the only
 *    one of the three that is an observation rather than an inference, and
 *    because it is about the process that will do the discarding.
 * 2. **`spawn` — what a Butchr spawn decided for this address** (KAN-497).
 *    Right whenever Butchr made the launch, and blind when somebody else did.
 * 3. **`runtime` — what this runtime's spawn shape can carry** (KAN-495). The
 *    weakest and the most general; it is a claim about spawns, not about panes.
 *
 * ⚠ **A `'unknown'` measurement must NOT shadow the sources below it**, and this
 * is the trap `channel-spawn-reach.ts` names in its own words: *"absence
 * composes; a recorded shrug does not."* An older `mcp.js` announces nothing, a
 * non-Linux host reads nothing, a wrapper is unrecognisable — all three are
 * `'unknown'`, and every one of them would otherwise erase a `'loaded'` the
 * runtime knows for certain. So `'unknown'` falls through here exactly as a
 * missing measurement does.
 */
export function reachForRoute(opts: {
  /** The connection's own measurement, where the server announced one. */
  measured?: ChannelReach;
  /** What this agent's Butchr spawn decided, where there was one. */
  spawn?: ChannelReach;
  /** What the runtime can say about its own spawn shape. */
  runtime: ChannelReach;
}): ChannelReach {
  if (opts.measured === 'loaded' || opts.measured === 'not-loaded') return opts.measured;
  if (opts.spawn === 'loaded' || opts.spawn === 'not-loaded') return opts.spawn;
  return opts.runtime;
}
