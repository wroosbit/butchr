import * as fs from 'fs';

/**
 * Why an agent failed to spawn, in words a human can act on.
 *
 * herdr reports spawn failures as a bare code — `ghostty error -2` is the one
 * that cost an afternoon on KAN-24 — and Butchr used to discard even that,
 * attaching to an agent that did not exist and reporting success. The point of
 * this module is that whatever we say when a spawn fails must name a cause and
 * a next step, because the alternative is a mystery outage.
 *
 * It lives outside herdr.ts deliberately: that file is contended by several
 * concurrent tickets, and none of this needs to be in it.
 */

/**
 * Open `/dev/ptmx` descriptors the herdr server holds per pane. Measured on
 * herdr 0.6.4, and it is exactly 5 — one pty master plus four dup()s of the
 * same open file description (portable_pty hands out a reader clone and a
 * writer clone; herdr keeps a further dup for its live-handoff path).
 *
 * It is a constant, not a leak: closing a pane returns all five. It is used
 * here only to turn an fd count into a number of panes, which is the unit a
 * human reasons in.
 */
export const PTMX_FDS_PER_PANE = 5;

/**
 * Fraction of the soft limit above which fd usage is worth mentioning
 * unprompted. Below this, quoting descriptor counts at someone debugging an
 * unrelated failure is just noise.
 */
export const FD_PRESSURE_WARN_RATIO = 0.75;

/**
 * The default open-file soft limit on Linux, which is also `FD_SETSIZE` — the
 * largest descriptor `select(2)` can represent. A herdr server left here is
 * capped at {@link PTMX_FDS_PER_PANE} descriptors per pane, i.e. ~205 panes,
 * after which every `agent start` fails.
 *
 * Setup raises it (`daemon/systemd/10-butchr-nofile.conf`). This constant
 * exists so a machine that *did not* get that far says so at startup instead
 * of discovering it as an outage — which is exactly how it went the first
 * time (KAN-24, KAN-33).
 */
export const FD_SETSIZE = 1024;

/**
 * True when herdr is running on the stock ceiling, i.e. setup's fd step was
 * never applied or was lost to a restart. Distinct from
 * {@link isFdPressureHigh}: that fires when the limit is nearly *reached*,
 * this fires the moment the limit is known to be too low, whether or not
 * anything is close to it yet.
 */
export function isFdCeilingUnraised(usage: FdUsage): boolean {
  return usage.softLimit <= FD_SETSIZE;
}

/** One line naming the ceiling in panes, and where the permanent fix lives. */
export function describeFdCeiling(usage: FdUsage): string {
  return (
    `herdr server (pid ${usage.pid}) has an open-file soft limit of ${usage.softLimit}, the stock default. ` +
    `At ${PTMX_FDS_PER_PANE} descriptors per pane that caps it at ~${Math.floor(usage.softLimit / PTMX_FDS_PER_PANE)} ` +
    `panes, after which every 'herdr agent start' fails. Raise it permanently with ` +
    `daemon/scripts/install-service.sh (see docs/SETUP.md), or for the running server: ` +
    `prlimit --pid ${usage.pid} --nofile=65536:1048576`
  );
}

/** How close the herdr server is to its open-file ceiling. */
export interface FdUsage {
  pid: number;
  openFds: number;
  softLimit: number;
  /** Further panes the remaining descriptors could support. */
  headroomPanes: number;
  /** openFds / softLimit, 0..1. */
  ratio: number;
}

/** {@link FdUsage} plus the pty-master breakdown, which costs a scan to get. */
export interface FdPressure extends FdUsage {
  ptmxFds: number;
  /** Panes the ptmx count implies, at the measured cost per pane. */
  estimatedPanes: number;
}

/**
 * The pid of the running herdr server, or undefined if we cannot find one.
 *
 * Read from /proc rather than by shelling out to pgrep: this runs on a failure
 * path that is already slow and already unhappy, and it must not add a process
 * spawn to a machine that may be out of descriptors.
 *
 * Butchr talks to one herdr server, so the first match is the right one. If a
 * second server is running (a scratch instance on its own HERDR_SOCKET_PATH,
 * as the repro scripts start), which of the two this finds is unspecified —
 * acceptable because the result is only ever used to enrich an error message.
 */
export function findHerdrServerPid(): number | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // the process exited between readdir and read, or isn't ours
    }
    // argv is NUL-separated; `herdr server` is argv[0] ending in herdr plus a
    // literal `server`. Matching the parts avoids catching this daemon itself
    // or an `herdr agent attach` client.
    const argv = cmdline.split('\0').filter(Boolean);
    if (argv.length >= 2 && /(^|\/)herdr$/.test(argv[0]) && argv[1] === 'server') {
      return Number(entry);
    }
  }
  return undefined;
}

function readSoftFdLimit(pid: number): number | undefined {
  let limits: string;
  try {
    limits = fs.readFileSync(`/proc/${pid}/limits`, 'utf8');
  } catch {
    return undefined;
  }
  // "Max open files            65536                1048576              files"
  const line = limits.split('\n').find(l => l.startsWith('Max open files'));
  const soft = line?.trim().split(/\s{2,}/)[1];
  const value = Number(soft);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFdNames(pid: number): string[] | undefined {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return undefined; // not ours to inspect, or it exited
  }
}

/**
 * How close the herdr server is to its open-file ceiling, or undefined when
 * that cannot be read (no herdr server, or a platform without /proc).
 *
 * Two syscalls and a directory listing, because this is on the `list_agents`
 * path the Agents page polls every 2s. Never throws.
 */
export function readFdUsage(pid = findHerdrServerPid()): FdUsage | undefined {
  if (pid === undefined) return undefined;

  const softLimit = readSoftFdLimit(pid);
  if (softLimit === undefined) return undefined;

  const fdNames = readFdNames(pid);
  if (fdNames === undefined) return undefined;

  const openFds = fdNames.length;
  return {
    pid,
    openFds,
    softLimit,
    headroomPanes: Math.max(0, Math.floor((softLimit - openFds) / PTMX_FDS_PER_PANE)),
    ratio: openFds / softLimit
  };
}

/**
 * {@link readFdUsage} plus how many descriptors are pty masters. This one
 * readlink()s every descriptor, so it belongs on failure paths rather than on
 * anything polled.
 */
export function readFdPressure(pid = findHerdrServerPid()): FdPressure | undefined {
  const usage = readFdUsage(pid);
  if (!usage) return undefined;

  const fdNames = readFdNames(usage.pid) ?? [];
  let ptmxFds = 0;
  for (const fd of fdNames) {
    try {
      if (fs.readlinkSync(`/proc/${usage.pid}/fd/${fd}`) === '/dev/ptmx') ptmxFds++;
    } catch {
      // fd closed mid-scan; the count is a diagnostic, not an audit
    }
  }

  return {
    ...usage,
    ptmxFds,
    estimatedPanes: Math.round(ptmxFds / PTMX_FDS_PER_PANE)
  };
}

/** One line a human can read, in panes rather than raw descriptors. */
export function describeFdPressure(p: FdPressure): string {
  const percent = Math.round(p.ratio * 100);
  return (
    `herdr server (pid ${p.pid}) holds ${p.openFds}/${p.softLimit} open files (${percent}% of the soft limit); ` +
    `${p.ptmxFds} are pty masters, ≈${p.estimatedPanes} panes at ${PTMX_FDS_PER_PANE} fds/pane, ` +
    `room for ≈${p.headroomPanes} more panes`
  );
}

/** True when fd usage is high enough to be worth reporting on its own. */
export function isFdPressureHigh(p: FdUsage): boolean {
  return p.ratio >= FD_PRESSURE_WARN_RATIO;
}

/**
 * The oldest herdr line Butchr's spawn path can drive.
 *
 * herdr 0.7.0 redesigned `agent start`: it no longer creates a pane, it
 * attaches a *named agent kind* to an existing one (`--kind`/`--pane`), and it
 * dropped `--cwd`, `--tab`, `--no-focus` and the trailing `-- <argv>` command.
 * KAN-533 ported `startAgentInOwnTab` to that API, which is why this moved from
 * `0.6` to `0.7` and **reversed direction: 0.6 is now the unsupported side.**
 *
 * ⚠ **A FLOOR, NOT A PIN — and the difference is the whole lesson of KAN-533.**
 * This constant used to be compared for *equality*, so every herdr release was
 * an alarm until somebody hand-edited this line. An enumeration that must be
 * re-typed whenever the world moves fails toward a false alarm on the day it is
 * stalest — and it did, inside this very ticket: KAN-533 was filed naming 0.7.5
 * as "the latest", and by the time an agent picked it up the installer was
 * handing out **0.8.0**. See {@link checkHerdrVersion} for the three-way answer
 * that replaced the equality test.
 */
export const MINIMUM_HERDR_MAJOR_MINOR = '0.7';

/**
 * The newest herdr line this spawn path has actually been run against.
 *
 * ⚠ **An evidence marker, not a ceiling.** Nothing is refused for being above
 * it; it decides only whether the version note reads *"verified"* or *"newer
 * than anything this has been tried against"*. Raising it is a claim that
 * somebody ran the spawn path against that release, and
 * `daemon/scripts/verify-herdr-spawn-argv.mjs` is where that claim is checked.
 *
 * 0.7.5 and 0.8.0 were both measured for KAN-533 and are API-identical for every
 * command Butchr issues. Their bundled schemas (`herdr api schema --json`)
 * differ in exactly three definitions — `WorkspaceMoveBlockParams`,
 * `IntegrationTarget`, `Subscription` — and Butchr uses none of them: it reaches
 * herdr only through CLI subcommands, and names no socket-API type anywhere in
 * `daemon/src`. That is a measurement rather than an inference; the grep and its
 * positive control are in the KAN-533 PR body.
 */
export const VERIFIED_HERDR_MAJOR_MINOR = '0.8';

/** `herdr --version` output → a comparable `[major, minor]`, or undefined. */
export function parseHerdrVersion(versionOutput: string): [number, number] | undefined {
  const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(versionOutput);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/**
 * A warning when herdr is a line Butchr cannot drive, or undefined when it is
 * fine (or unreadable — an unknown version is not evidence of a problem, and
 * refusing to run on one would break every future release).
 *
 * ## Three answers, and the middle one is why this is not an equality test
 *
 * - **Below {@link MINIMUM_HERDR_MAJOR_MINOR}** — refused, and the message says
 *   *what to do*. This is the branch the red drive exercises: the whole point of
 *   naming the version is that the alternative symptom is a bare
 *   `unknown option: --kind` from herdr's own getopt, which tells a user nothing.
 * - **Between the floor and {@link VERIFIED_HERDR_MAJOR_MINOR}** — silent. This
 *   is the supported range and it spans more than one release on purpose.
 * - **Above the verified line** — a note, not an alarm. Butchr has no reason to
 *   think a newer herdr broke it; it simply has not been tried. ⚠ **Saying
 *   "unverified" where the old code said "this will fail" is the correction, not
 *   a softening**: the old wording asserted breakage it had not observed, and on
 *   0.8.0 — which works — it would have been flatly wrong.
 */
export function checkHerdrVersion(versionOutput: string): string | undefined {
  const parsed = parseHerdrVersion(versionOutput);
  if (!parsed) return undefined;

  const [major, minor] = parsed;
  const [minMajor, minMinor] = MINIMUM_HERDR_MAJOR_MINOR.split('.').map(Number);
  const [verMajor, verMinor] = VERIFIED_HERDR_MAJOR_MINOR.split('.').map(Number);

  // `herdr --version` already prints "herdr 0.7.5", so the name is not
  // prepended — doing so produced "herdr herdr 0.7.5" in the daemon log.
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    return (
      `${versionOutput.trim()} is older than the ${MINIMUM_HERDR_MAJOR_MINOR}.x line Butchr's spawn path ` +
      `requires. Butchr starts agents with 'agent start --kind/--pane', which herdr gained in 0.7, so ` +
      `every activation on this build will fail with 'unknown option: --kind'. Upgrade with the official ` +
      `installer: curl -fsSL https://herdr.dev/install.sh | sh — see docs/SETUP.md, prerequisites.`
    );
  }

  if (major > verMajor || (major === verMajor && minor > verMinor)) {
    return (
      `${versionOutput.trim()} is newer than the ${VERIFIED_HERDR_MAJOR_MINOR}.x line Butchr's spawn path has ` +
      `been verified against; it is expected to work and has not been tried. If activation fails, check ` +
      `whether 'herdr agent start' still takes --kind/--pane and report it — see docs/SETUP.md, prerequisites.`
    );
  }

  return undefined;
}

/**
 * Turn herdr's spawn error into something diagnosable.
 *
 * The message herdr gives is kept verbatim and first — it is the ground truth,
 * and a wrapper that paraphrases an error it does not recognise is how the
 * original gets lost. What we add is the known cause, when the code is one we
 * have actually traced to a mechanism.
 */
export function diagnoseSpawnFailure(herdrMessage: string): string {
  const notes: string[] = [];

  // ⚠ THE VERSION FAILURE MUST NAME ITSELF, AND UPSTREAM'S MESSAGE DOES NOT
  // (KAN-533, acceptance criterion 3). Butchr's spawn path speaks herdr 0.7's
  // `agent start --kind/--pane` and `tab create --env`; run against 0.6.x, herdr
  // answers with its own getopt error and nothing else. Measured on 0.6.4 with
  // the ported daemon: `unknown option: --env`, from `tab create` — note that it
  // is NOT `--kind`, because `tab create` is reached first, so a diagnosis that
  // matched only the flag it expected would have missed the flag it got.
  //
  // Three words of upstream's, and the user is left holding a flag name with no
  // way to know it is a version problem at all. The daemon's startup check
  // (`checkHerdrVersion`) already warns, but a warning at startup is read once
  // and a spawn failure is read at the moment it hurts.
  if (/unknown option:\s*--(env|kind|pane|cwd|tab|no-focus)\b/i.test(herdrMessage)) {
    notes.push(
      'That is a herdr VERSION mismatch, not a bad argument. Butchr starts agents with ' +
      "'agent start --kind/--pane' and 'tab create --env', which herdr gained in 0.7 — so an " +
      'installed herdr older than that rejects the flags one at a time. Check with ' +
      '`herdr --version`; if it is 0.6.x, upgrade with the official installer ' +
      '(`curl -fsSL https://herdr.dev/install.sh | sh`) and restart the daemon. ' +
      'See docs/SETUP.md, prerequisites.'
    );
  }

  // Traced on KAN-24: libghostty refuses to build a terminal with a zero
  // dimension, and herdr sizes a new pane by splitting the workspace layout.
  // The layout is sized to attached clients, so one client that attaches
  // reporting a tiny window (a `script`-spawned pty with no window size
  // reports 1x1) shrinks the layout until a new pane's share rounds to zero —
  // after which every spawn fails until that client goes away. Confirmed on an
  // isolated herdr with two panes, so it is not a resource problem.
  if (/ghostty error -2/i.test(herdrMessage)) {
    notes.push(
      'This is a pane-geometry failure, not a resource failure: herdr tried to create the pane ' +
      'with a zero-sized terminal. It happens when some client has attached to the herdr session ' +
      'reporting a tiny window (a pty opened without a window size reports 1x1), which shrinks the ' +
      'workspace layout until a new pane gets no room. Look for `rows=0 cols=0` on the ' +
      '`pane.spawn.start` line in ~/.config/herdr/herdr-server.log, and for a `client connected ' +
      'cols=1 rows=1` before it; detaching that client restores spawning.'
    );
  }

  // herdr 0.6.4 surfaces EMFILE from openpty as Rust's io::Error Debug form —
  // `failed to openpty: Os { code: 24, ..., message: "No file descriptors
  // available" }` — which says neither "EMFILE" nor "too many open files".
  // Matched here verbatim alongside the conventional spellings, because a
  // diagnosis that only recognises the textbook wording recognises nothing.
  if (/too many open files|no file descriptors available|EMFILE|ENFILE|openpty/i.test(herdrMessage)) {
    notes.push(
      'The herdr server is out of file descriptors. Each pane costs ' +
      `${PTMX_FDS_PER_PANE} of them (one pty master, dup'ed), so closing idle agents is what ` +
      'frees room; raising the soft limit with `prlimit --pid <pid> --nofile=` postpones the ' +
      'ceiling rather than removing it.'
    );
  }

  // Attach fd pressure whenever it is high, even for an unrecognised error:
  // a server near its ceiling misbehaves in ways that do not name the ceiling.
  const pressure = readFdPressure();
  if (pressure && isFdPressureHigh(pressure)) {
    notes.push(`Resource pressure at the time: ${describeFdPressure(pressure)}.`);
  }

  return notes.length ? `${herdrMessage} — ${notes.join(' ')}` : herdrMessage;
}
