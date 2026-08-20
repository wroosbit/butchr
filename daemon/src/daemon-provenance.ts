import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { DAEMON_UNIT } from './ipc.js';
import { RUNTIME_ENV_VAR, selectedRuntimeMode } from './runtime-switch.js';

/**
 * Which daemon is actually serving, and whether it is the one you configured.
 *
 * ## The incident this exists for (KAN-550)
 *
 * On 2026-08-20 `butchr-daemon.service` was stopped for about two minutes.
 * Within seconds a daemon was serving the socket again — but not systemd's.
 * Chrome's native host had auto-spawned one, and a child of Chrome inherits
 * Chrome's environment, which carries no `BUTCHR_*` at all. So the fleet came
 * back with the runtime unpinned (a silent flip off crabcast), the cap
 * unpinned (derivation reads 12 on a machine the human had set to 6), the
 * Atlassian proxy off and the board reconciler dropped to report mode.
 *
 * **Every instrument said the service was down while the fleet ran normally.**
 * `systemctl is-active` read `inactive`, because the process holding the
 * socket was not systemd's; `systemctl start` appeared to succeed and left
 * nothing running, because the unit lost the singleton race and exited *0*,
 * and `Restart=on-failure` does not retry a clean exit. A losing instance and
 * a healthy one were byte-identical from outside.
 *
 * #250 closed the way in — {@link spawnDaemon} now asks systemd to start the
 * unit when there is one, so a respawn carries the drop-in environment. This
 * module closes the three ways it *hid*, which is the part the ticket calls
 * the actual defect: the daemon can now answer **who is serving and where its
 * configuration came from**, it refuses to come up silently unpinned, and a
 * daemon that loses the race says so where systemd can hear it.
 *
 * ## Why the unit is the reference and not a constant in this file
 *
 * The pinned values live in the unit's drop-ins, which is the operator's
 * surface — `~/.config/systemd/user/butchr-daemon.service.d/*.conf`. A list of
 * expected variables written *here* would be a second copy of a setting whose
 * whole point is that the human owns it, and it would be wrong the first time
 * somebody added a drop-in. So every question below is asked of systemd, and
 * this module holds no opinion about which variables ought to exist.
 */

/** Set this to 1 to come up unpinned ON PURPOSE. See {@link runtimePinVerdict}. */
export const RUNTIME_PIN_ACK_ENV = 'BUTCHR_ALLOW_UNPINNED_RUNTIME';

/**
 * Say something where **systemd** can hear it.
 *
 * ⚠ **`console.error` does not reach the journal from inside this daemon, and
 * that is not obvious from any call site.** `daemon.ts` assigns both
 * `console.log` and `console.error` to its own file appender, so every module
 * in the process — including this one — writes to `~/.local/share/butchr/
 * daemon.log` and to nothing else. That redirect is right for the daemon's
 * ordinary chatter and it is exactly wrong for the two messages KAN-550 asks
 * for, because *"in the journal"* is the criterion: the journal is where an
 * operator looks when a unit will not start, and `daemon.log` is a file they
 * have no reason to open when `systemctl` has just told them the service is
 * inactive.
 *
 * So this writes the bytes to fd 2 itself. Under systemd that is the journal
 * (`JOURNAL_STREAM` is set to say so); run by hand it is the terminal, which is
 * the other place somebody debugging this will be looking.
 *
 * `alsoLog` is passed the same lines for `daemon.log`, so the record exists in
 * both places rather than moving from one to the other.
 */
export function announceToJournal(lines: string[], alsoLog?: (line: string) => void): void {
  const text = lines.join('\n');
  try {
    process.stderr.write(`${text}\n`);
  } catch {
    // A daemon spawned detached can have a closed or redirected fd 2. Losing
    // the journal copy must not lose the daemon.log copy below, and must never
    // take the process down: this function is called on the paths that exist to
    // report trouble, and throwing here would replace a diagnosis with a crash.
  }
  if (alsoLog) {
    for (const line of lines) alsoLog(line);
  }
}

/**
 * What a daemon exits with when it loses the race for the socket.
 *
 * **The two codes are the whole point, and the unit file's comment used to
 * argue for only the first.** It said losing the race is "a correct no-op", and
 * that is true exactly when the winner is a daemon the operator would have
 * chosen. It was the wrong reading on 2026-08-20, when the winner was an
 * unconfigured child of Chrome: there, the clean exit meant `Restart=` had
 * nothing to act on, so systemd stayed out of the way of the very process that
 * had displaced it, and the unit sat `inactive` while the fleet ran wrong.
 *
 * So the loser now decides on *who won*:
 *
 * - the winner is systemd's, or carries the pinned environment → {@link
 *   LOST_TO_CONFIGURED}, still a no-op, still silent-ish, still 0;
 * - the winner is unconfigured, or would not say → {@link
 *   LOST_TO_UNCONFIGURED}, which is non-zero so `Restart=on-failure` retries
 *   and the unit ends up `failed` rather than `inactive`.
 *
 * `failed` is the load-bearing half. It is a state an operator's existing
 * `is-active` check can already see, and it is the one thing the 2026-08-20
 * incident could not produce.
 */
export const LOST_TO_CONFIGURED = 0;
/** @see LOST_TO_CONFIGURED */
export const LOST_TO_UNCONFIGURED = 3;
/** What a daemon exits with when it refuses to serve unpinned. @see runtimePinVerdict */
export const REFUSED_UNPINNED = 4;

/**
 * What systemd says about the daemon's unit.
 *
 * **Three cases, and they are three constructors rather than a boolean and a
 * comment.** "There is no unit on this machine" and "I could not ask systemd"
 * lead to opposite conclusions — the first means an unpinned daemon is
 * perfectly correct, the second means we know nothing and must not pretend
 * otherwise — and a predicate returning `false` for both invites the caller to
 * treat them as one. That collapse is a filed defect against this repository's
 * other unit predicate ({@link daemonUnitIsManaged} in `ipc.ts`, KAN-559), and
 * it is not fixed here; this is a different call site asking a different
 * question, and it is typed so the same collapse is not *expressible*.
 */
export type UnitQuery =
  | { kind: 'loaded'; environment: Record<string, string>; execMainPid: number | null }
  | { kind: 'absent' }
  | { kind: 'unreachable'; detail: string };

/** Injectable so a proof can drive every branch without a systemd. */
export type CommandRunner = (
  file: string,
  args: string[]
) => { status: number | null; stdout: string; stderr: string };

const realRunner: CommandRunner = (file, args) => {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

/**
 * Split systemd's `Environment=` line into assignments.
 *
 * systemd prints the whole list on one line, space-separated, and quotes any
 * value that contains a space. Nothing in this fleet's drop-ins has a space in
 * it today, which is exactly why the quoting is handled here rather than when
 * somebody first sets one: a parser that is written the day it is needed is
 * written under the pressure of a live incident.
 */
export function parseUnitEnvironment(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    let token = '';
    let quote: string | null = null;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        else token += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ' ') {
        break;
      } else {
        token += ch;
      }
    }
    const eq = token.indexOf('=');
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

/**
 * Ask systemd what the daemon's unit is and what it declares.
 *
 * **One `show` call, because `show` answers all three states and `cat` answers
 * only two.** Measured on this machine rather than reasoned:
 *
 * ```
 * show -p LoadState --value  (real unit)      -> "loaded",     exit 0
 * show -p LoadState --value  (no such unit)   -> "not-found",  exit 0
 * show -p LoadState --value  (no session bus) -> "Failed to connect to bus", exit 1
 * ```
 *
 * ⚠ **`Environment` alone cannot be read for this**, and that is the trap worth
 * naming: `show -p Environment --value` on a unit that does not exist prints an
 * empty line and **exits 0**, which is byte-identical to a unit that exists and
 * declares nothing. `LoadState` is what separates them, so it is read in the
 * same call and never inferred from the environment being empty.
 */
export function queryDaemonUnit(
  run: CommandRunner = realRunner,
  unit: string = DAEMON_UNIT
): UnitQuery {
  let r: { status: number | null; stdout: string; stderr: string };
  try {
    r = run('systemctl', [
      '--user',
      'show',
      unit,
      '-p',
      'LoadState',
      '-p',
      'Environment',
      '-p',
      'ExecMainPID'
    ]);
  } catch (err: any) {
    return { kind: 'unreachable', detail: `systemctl could not be run: ${err?.message ?? err}` };
  }
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    return {
      kind: 'unreachable',
      detail: detail.length > 0 ? detail : `systemctl exited ${String(r.status)} with no output`
    };
  }

  let loadState: string | null = null;
  let environmentLine: string | null = null;
  let execMainPid: number | null = null;
  for (const raw of r.stdout.split('\n')) {
    if (raw.startsWith('LoadState=')) loadState = raw.slice('LoadState='.length).trim();
    else if (raw.startsWith('Environment=')) environmentLine = raw.slice('Environment='.length);
    else if (raw.startsWith('ExecMainPID=')) {
      const n = Number.parseInt(raw.slice('ExecMainPID='.length).trim(), 10);
      // systemd prints 0 for a unit with no running main process. That is
      // "nobody", not pid 0, and it must never compare equal to a real pid.
      execMainPid = Number.isInteger(n) && n > 0 ? n : null;
    }
  }

  // A `show` that answered 0 without naming LoadState is a systemctl this code
  // does not understand. That is not "no unit" — reporting it as one would be
  // the collapse this type exists to prevent, wearing a parser's clothes.
  if (loadState === null) {
    return {
      kind: 'unreachable',
      detail: `systemctl show ${unit} exited 0 but printed no LoadState — output not understood`
    };
  }
  if (loadState !== 'loaded') return { kind: 'absent' };
  return {
    kind: 'loaded',
    environment: parseUnitEnvironment(environmentLine === null ? '' : environmentLine),
    execMainPid
  };
}

/** Where this process came from, as far as it can tell from the outside. */
export interface ProcessProvenance {
  pid: number;
  ppid: number;
  /** `/proc/<ppid>/comm`, so `systemd` and `native-host` are distinguishable. */
  parentComm: string | null;
  /**
   * The `INVOCATION_ID` this process carries, or `null`.
   *
   * ⚠ **This is NOT evidence that systemd started this process, and it was
   * very nearly used as if it were.** systemd sets the variable once per
   * service invocation and it is then inherited by every descendant, however
   * distant. Measured while writing this: an agent's shell — many generations
   * below any unit, and started by no service manager — carried
   * `INVOCATION_ID=9d401f9f…`, while `butchr-daemon.service`'s own invocation
   * was `d04a6431…`. A first draft read the variable's mere presence as "systemd
   * started me" and therefore reported an unconfigured, hand-started daemon as
   * a healthy one — the exact false green KAN-550 exists to remove, rebuilt
   * inside the fix for it.
   *
   * It is kept because it is useful to *see* which invocation a process is
   * descended from. The question of whether systemd started THIS process is
   * answered by {@link isUnitMainProcess} instead, off the unit's
   * `ExecMainPID`, which is an identity and not an inheritance.
   */
  invocationIdInherited: string | null;
  /** systemd sets `JOURNAL_STREAM` when stderr goes to the journal. */
  stderrReachesJournal: boolean;
  /** Every `BUTCHR_*` this process actually carries. */
  butchrEnv: Record<string, string>;
  /** The runtime this process will use, and whether it was chosen or defaulted. */
  runtime: { mode: string; source: 'default' | 'environment'; rawValue: string | null };
}

function readParentComm(ppid: number, readFile: typeof fs.readFileSync): string | null {
  if (!Number.isInteger(ppid) || ppid <= 0) return null;
  try {
    return String(readFile(`/proc/${ppid}/comm`, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Describe the process this code is running in. */
export function describeThisProcess(
  env: NodeJS.ProcessEnv = process.env,
  opts: { pid?: number; ppid?: number; readFile?: typeof fs.readFileSync } = {}
): ProcessProvenance {
  const pid = opts.pid ?? process.pid;
  const ppid = opts.ppid ?? process.ppid;
  const butchrEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('BUTCHR_') && typeof v === 'string') butchrEnv[k] = v;
  }
  const runtime = selectedRuntimeMode(env);
  return {
    pid,
    ppid,
    parentComm: readParentComm(ppid, opts.readFile === undefined ? fs.readFileSync : opts.readFile),
    invocationIdInherited:
      typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0
        ? env.INVOCATION_ID
        : null,
    stderrReachesJournal: typeof env.JOURNAL_STREAM === 'string' && env.JOURNAL_STREAM.length > 0,
    butchrEnv,
    runtime: { mode: runtime.mode, source: runtime.source, rawValue: runtime.rawValue }
  };
}

/** One `BUTCHR_*` the unit declares that this process does not match. */
export interface PinDrift {
  name: string;
  declared: string;
  /** `null` means the process does not carry the variable at all. */
  running: string | null;
}

/**
 * Every `BUTCHR_*` the unit declares that this process is not carrying.
 *
 * Only variables the unit declares are compared. A `BUTCHR_*` present in the
 * process and absent from the unit is not drift — that is an operator running
 * a daemon by hand with an extra setting, which is a thing they are allowed to
 * do and is not what went wrong here.
 */
export function pinDrift(unit: UnitQuery, env: NodeJS.ProcessEnv = process.env): PinDrift[] {
  if (unit.kind !== 'loaded') return [];
  const drift: PinDrift[] = [];
  for (const [name, declared] of Object.entries(unit.environment)) {
    if (!name.startsWith('BUTCHR_')) continue;
    const running = typeof env[name] === 'string' ? (env[name] as string) : null;
    if (running !== declared) drift.push({ name, declared, running });
  }
  return drift;
}

/**
 * The runtime-pin question, answered as a verdict rather than a boolean.
 *
 * KAN-550's third acceptance criterion: *"The daemon refuses to serve, or logs
 * loudly, when `BUTCHR_AGENT_RUNTIME` is unset — a runtime default that
 * silently differs from the pinned value must not be reachable by accident."*
 *
 * **`unset` is not by itself the fault, and treating it as one would be
 * useless noise.** A machine with no unit — a container, a fresh checkout, a CI
 * runner — is *correctly* unpinned, and a daemon that refused there would
 * refuse everywhere the fleet is not yet installed. What the criterion is
 * actually about is the word **silently**: an unpinned daemon on a machine
 * whose unit pins `crabcast` is a fleet that has changed runtime with nobody
 * deciding it.
 *
 * So the discriminating question is not *"is the variable set?"* but *"does
 * this process disagree with what the operator wrote down?"*, and only that
 * refuses. Everything else is logged and served.
 */
export type RuntimePinVerdict =
  /** The unit pins a runtime and this process carries it. Nothing to say. */
  | { kind: 'carried'; value: string }
  /** No unit, or a unit that pins no runtime: unpinned is correct here. */
  | { kind: 'nothing-pinned'; because: 'no-unit' | 'unit-declares-none' }
  /** systemd could not be asked, so this is unknown rather than fine. */
  | { kind: 'cannot-tell'; detail: string }
  /** The unit pins a runtime and this process does NOT carry it. Refuse. */
  | { kind: 'lost'; declared: string; running: string | null; drift: PinDrift[] }
  /** As `lost`, but an operator set {@link RUNTIME_PIN_ACK_ENV} on purpose. */
  | { kind: 'lost-acknowledged'; declared: string; running: string | null; drift: PinDrift[] };

export function runtimePinVerdict(
  unit: UnitQuery,
  env: NodeJS.ProcessEnv = process.env
): RuntimePinVerdict {
  if (unit.kind === 'unreachable') return { kind: 'cannot-tell', detail: unit.detail };
  if (unit.kind === 'absent') return { kind: 'nothing-pinned', because: 'no-unit' };

  const declared = unit.environment[RUNTIME_ENV_VAR];
  if (typeof declared !== 'string' || declared.trim() === '') {
    return { kind: 'nothing-pinned', because: 'unit-declares-none' };
  }
  const running = typeof env[RUNTIME_ENV_VAR] === 'string' ? (env[RUNTIME_ENV_VAR] as string) : null;
  if (running === declared) return { kind: 'carried', value: declared };

  const drift = pinDrift(unit, env);
  const ack = env[RUNTIME_PIN_ACK_ENV];
  const acknowledged = typeof ack === 'string' && ack.trim() === '1';
  return acknowledged
    ? { kind: 'lost-acknowledged', declared, running, drift }
    : { kind: 'lost', declared, running, drift };
}

/** Whether {@link runtimePinVerdict}'s answer means this process must not serve. */
export function mustRefuseToServe(verdict: RuntimePinVerdict): boolean {
  return verdict.kind === 'lost';
}

/**
 * The refusal, as the operator will read it in the journal.
 *
 * Written as a block rather than a line because it has to survive being the
 * only thing anybody sees: it names what was expected, what is actually here,
 * what it would have done had it carried on, and the single command that fixes
 * it. The 2026-08-20 incident produced no line at all, so the bar this has to
 * clear is not brevity.
 */
export function describeRefusal(verdict: RuntimePinVerdict, unit: string = DAEMON_UNIT): string[] {
  if (verdict.kind !== 'lost' && verdict.kind !== 'lost-acknowledged') return [];
  const running = verdict.running === null ? '(not set)' : verdict.running;
  const lines = [
    `butchr: REFUSING TO SERVE — this daemon is not carrying the runtime this machine pins.`,
    `  ${unit} declares ${RUNTIME_ENV_VAR}=${verdict.declared}`,
    `  this process has  ${RUNTIME_ENV_VAR}=${running}`,
    ``,
    `  Serving anyway would run the whole fleet on a runtime nobody chose, and`,
    `  nothing downstream would report it — which is what happened on`,
    `  2026-08-20 (KAN-550). A daemon spawned by a client inherits the CLIENT's`,
    `  environment, and Chrome's carries no BUTCHR_* at all.`
  ];
  if (verdict.drift.length > 1) {
    lines.push(``, `  Every pinned variable that does not match:`);
    for (const d of verdict.drift) {
      lines.push(`    ${d.name}: unit says ${d.declared}, this process has ${d.running ?? '(not set)'}`);
    }
  }
  lines.push(
    ``,
    `  Start it the way it is configured:  systemctl --user start ${unit}`,
    `  To come up unpinned ON PURPOSE:     ${RUNTIME_PIN_ACK_ENV}=1`
  );
  if (verdict.kind === 'lost-acknowledged') {
    lines[0] =
      `butchr: SERVING UNPINNED ON PURPOSE — ${RUNTIME_PIN_ACK_ENV}=1 is set, so the refusal ` +
      `below was overridden.`;
  }
  return lines;
}

/**
 * Is this process the unit's own main process?
 *
 * **The whole question, asked as an identity rather than inferred.** systemd
 * reports `ExecMainPID` for the unit; if it equals our pid then systemd's
 * butchr-daemon *is* us, and if it does not then it is somebody else or
 * nobody — which are the two cases the 2026-08-20 incident consisted of.
 *
 * It needs no environment variable, so nothing about it is inherited, and it
 * is the reading `is-active` should have been paired with all along: the
 * ticket's own triage recipe (`ps -o ppid= -p $MAIN`) is this comparison done
 * by hand.
 */
export function isUnitMainProcess(unit: UnitQuery, pid: number): boolean {
  return unit.kind === 'loaded' && unit.execMainPid !== null && unit.execMainPid === pid;
}

/**
 * The provenance answer this daemon gives over the socket.
 *
 * KAN-550's second acceptance criterion asks for *"some supported command
 * [that] reports the true serving daemon and its provenance"*, and the reason
 * it is answered **over the socket** rather than from a file is that a file can
 * be stale and a socket cannot: whoever replies to this is by construction the
 * process that is serving. A pidfile describing a daemon that died is the same
 * class of artifact as `is-active` describing a unit that is not the one
 * running — it is the confident-and-wrong shape the whole ticket is about.
 */
export interface DaemonProvenanceReport {
  pid: number;
  ppid: number;
  parentComm: string | null;
  /** True only when the unit's `ExecMainPID` IS this pid. @see isUnitMainProcess */
  isUnitMainProcess: boolean;
  invocationIdInherited: string | null;
  stderrReachesJournal: boolean;
  butchrEnvNames: string[];
  runtime: ProcessProvenance['runtime'];
  unit: { kind: UnitQuery['kind']; declaresRuntime: string | null };
  pinDrift: PinDrift[];
  /** One line an operator can act on without reading any of the above. */
  summary: string;
}

export function daemonProvenanceReport(
  unit: UnitQuery,
  self: ProcessProvenance
): DaemonProvenanceReport {
  const drift = unit.kind === 'loaded' ? pinDrift(unit, envOf(self)) : [];
  const declaresRuntime =
    unit.kind === 'loaded' && typeof unit.environment[RUNTIME_ENV_VAR] === 'string'
      ? unit.environment[RUNTIME_ENV_VAR]
      : null;

  const names = Object.keys(self.butchrEnv).sort();
  const isMain = isUnitMainProcess(unit, self.pid);
  const who = isMain
    ? `the main process of ${DAEMON_UNIT}`
    : `NOT the unit's main process (parent ${self.parentComm ?? 'unknown'}, pid ${self.ppid})`;
  const pinned =
    drift.length === 0
      ? 'carrying every pinned variable'
      : `NOT carrying ${drift.length} pinned variable(s): ${drift.map((d) => d.name).join(', ')}`;
  const summary =
    `daemon pid ${self.pid} is serving, ${who}, ${pinned}; runtime ${self.runtime.mode} ` +
    `(from the ${self.runtime.source})`;

  return {
    pid: self.pid,
    ppid: self.ppid,
    parentComm: self.parentComm,
    isUnitMainProcess: isMain,
    invocationIdInherited: self.invocationIdInherited,
    stderrReachesJournal: self.stderrReachesJournal,
    butchrEnvNames: names,
    runtime: self.runtime,
    unit: { kind: unit.kind, declaresRuntime },
    pinDrift: drift,
    summary
  };
}

/** The `BUTCHR_*` view of a provenance record, for re-running `pinDrift` on it. */
function envOf(self: ProcessProvenance): NodeJS.ProcessEnv {
  return { ...self.butchrEnv };
}

/**
 * Is the daemon that answered this report one the operator would have chosen?
 *
 * This is what a loser of the singleton race consults to decide between
 * {@link LOST_TO_CONFIGURED} and {@link LOST_TO_UNCONFIGURED}, and the
 * direction it fails in is deliberate. An **absent or unintelligible** answer
 * counts as *not* configured: an old daemon that does not know the action, a
 * daemon too wedged to reply, and a daemon with no `BUTCHR_*` are all cases
 * where nobody has established that the right process is serving, and the
 * comfortable reading of each is the one that let 2026-08-20 pass unnoticed.
 */
export function incumbentIsConfigured(report: DaemonProvenanceReport | null): boolean {
  if (report === null) return false;
  if (report.pinDrift.length > 0) return false;
  // A machine with no unit at all has nobody to be the main process of, and a
  // daemon there is as configured as it is possible to be. `absent` is the
  // honest yes; `unreachable` is not, because nothing was established.
  if (report.unit.kind === 'absent') return true;
  return report.isUnitMainProcess;
}
