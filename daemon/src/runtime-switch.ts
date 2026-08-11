import os from 'os';
import path from 'path';
import type { AgentRuntime } from './agent-runtime.js';
import { CrabCastLink, CRABCAST_PIN, defaultCrabCastSocket } from './crabcast-link.js';
import { CrabCastRuntime } from './crabcast-runtime.js';
import { HerdrBridge } from './herdr.js';

/**
 * Which agent runtime serves this daemon, and the report that says so (KAN-278).
 *
 * ## Off by default, and that is a criterion rather than a preference
 *
 * KAN-278's acceptance criterion 3: *"With no switch set, show `HerdrBridge`
 * still serving and CrabCast untouched — no process, no socket connection. A
 * migration that changes behaviour on merge has failed this criterion."*
 *
 * So {@link selectedRuntimeMode} returns `'herdr'` for an unset variable, for
 * an empty one, and for anything it does not recognise. The only input that
 * selects CrabCast is the exact string `crabcast`. Nothing else — no truthiness
 * test, no prefix match, no `1`.
 *
 * ## The report and the behaviour are one function, deliberately
 *
 * This copies `BUTCHR_BOARD_RECONCILE`'s discipline in `daemon.ts` verbatim,
 * and for its stated reason: *"if the mode the page reports and the mode the
 * loop obeys were two readings, they could differ, and a UI confidently
 * describing a mode the loop is not in is a worse failure than the silence it
 * replaced."*
 *
 * The same trap is open here and it is worse, because the thing being reported
 * is *which runtime is serving your fleet*. {@link runtimeSwitchReport} is
 * built by {@link createAgentRuntime} from the mode it actually selected — not
 * from a second read of the environment — so an operator reading the report is
 * reading the decision that was made rather than a re-derivation of it.
 *
 * ## Read once, not per call — and why that differs from the board switch
 *
 * `boardReconcileMode()` is read on every cycle, because a reconciler's mode
 * can change under it harmlessly. A runtime cannot: it owns live sessions and
 * live pty attachments, and swapping it mid-flight would strand every one of
 * them. So this is read exactly once, at construction, and the report says
 * when. Changing runtimes means restarting the daemon, and the report says
 * that too.
 */

export type RuntimeMode = 'herdr' | 'crabcast';

/** The environment variable that selects a runtime. */
export const RUNTIME_ENV_VAR = 'BUTCHR_AGENT_RUNTIME';
/** Where to reach CrabCast, when one is selected. */
export const CRABCAST_SOCKET_ENV_VAR = 'BUTCHR_CRABCAST_SOCKET';

export interface RuntimeSwitchReport {
  /** The runtime actually serving. Never a guess — see the module docblock. */
  mode: RuntimeMode;
  /** The class serving, by name, so the report cannot drift from the object. */
  implementation: string;
  /** Whether the mode came from the environment or from the default. */
  source: 'default' | 'environment';
  /** The raw value read, so an operator can see a typo for what it is. */
  rawValue: string | null;
  /** Set when a value was present and unusable; null otherwise. */
  fallbackReason: string | null;
  /** When the decision was taken. A runtime is chosen once, at boot. */
  decidedAt: string;
  /** One line an operator can read without knowing any of the above. */
  summary: string;
  /** Present only in crabcast mode. */
  crabcast?: {
    socketPath: string;
    pinnedCommit: string;
  };
}

/**
 * The mode this daemon runs in, from the environment.
 *
 * An unrecognised value falls back to `herdr` **and says so**. That direction
 * of fallback is the safe one and the choice is not symmetric: falling back to
 * the default runtime costs nothing, while falling back to CrabCast on a
 * misspelling would move a whole fleet onto an unproven path because somebody
 * typed `crabcst`.
 */
export function selectedRuntimeMode(env: NodeJS.ProcessEnv = process.env): {
  mode: RuntimeMode;
  source: 'default' | 'environment';
  rawValue: string | null;
  fallbackReason: string | null;
} {
  const raw = env[RUNTIME_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return { mode: 'herdr', source: 'default', rawValue: raw ?? null, fallbackReason: null };
  }
  const value = raw.trim().toLowerCase();
  if (value === 'crabcast') {
    return { mode: 'crabcast', source: 'environment', rawValue: raw, fallbackReason: null };
  }
  if (value === 'herdr') {
    return { mode: 'herdr', source: 'environment', rawValue: raw, fallbackReason: null };
  }
  return {
    mode: 'herdr',
    source: 'default',
    rawValue: raw,
    fallbackReason:
      `${RUNTIME_ENV_VAR} is set to "${raw}", which is not one of herdr | crabcast. ` +
      'Falling back to herdr — an unreadable setting is never a licence to move the fleet ' +
      'onto a different runtime.'
  };
}

/** Where CrabCast's socket is, for this daemon. */
export function crabCastSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[CRABCAST_SOCKET_ENV_VAR];
  if (raw && raw.trim()) return path.resolve(raw.trim().replace(/^~(?=$|\/)/, os.homedir()));
  return defaultCrabCastSocket();
}

/**
 * Build the runtime this daemon will use, and the report that describes it.
 *
 * **In `herdr` mode nothing in this function touches CrabCast**: no
 * {@link CrabCastLink} is constructed, no socket is opened, no census poll is
 * started, and `crabcast-runtime.js` contributes nothing but an unused import
 * binding. That is criterion 3, and it is enforced by construction rather than
 * by care — the CrabCast branch is the only place a link is ever built.
 */
export function createAgentRuntime(options?: {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): { runtime: AgentRuntime; report: RuntimeSwitchReport } {
  const env = options?.env ?? process.env;
  const log = options?.log ?? ((m: string) => console.log(m));
  const decision = selectedRuntimeMode(env);
  const decidedAt = new Date().toISOString();

  if (decision.fallbackReason) log(`[runtime] ${decision.fallbackReason}`);

  if (decision.mode === 'crabcast') {
    const socketPath = crabCastSocketPath(env);
    const link = new CrabCastLink({ socketPath, log: (m) => log(`[crabcast] ${m}`) });
    const runtime = new CrabCastRuntime({ link, log: (m) => log(`[CrabCastRuntime] ${m}`) });
    const report: RuntimeSwitchReport = {
      mode: 'crabcast',
      implementation: runtime.constructor.name,
      source: decision.source,
      rawValue: decision.rawValue,
      fallbackReason: null,
      decidedAt,
      summary:
        `Agents are served by CrabCast over ${socketPath} ` +
        `(adapter proved against CrabCast ${CRABCAST_PIN.slice(0, 12)}). ` +
        `Selected by ${RUNTIME_ENV_VAR}=${decision.rawValue}. ` +
        'This is not the default; unset that variable and restart to return to HerdrBridge.',
      crabcast: { socketPath, pinnedCommit: CRABCAST_PIN }
    };
    log(`[runtime] ${report.summary}`);
    return { runtime, report };
  }

  const runtime = new HerdrBridge();
  const report: RuntimeSwitchReport = {
    mode: 'herdr',
    implementation: runtime.constructor.name,
    source: decision.source,
    rawValue: decision.rawValue,
    fallbackReason: decision.fallbackReason,
    decidedAt,
    summary:
      'Agents are served by HerdrBridge, in this process. ' +
      (decision.source === 'default'
        ? `${RUNTIME_ENV_VAR} is not set, which is the default and the only supported ` +
          'configuration today. No CrabCast connection exists.'
        : `Selected explicitly by ${RUNTIME_ENV_VAR}=${decision.rawValue}. No CrabCast ` +
          'connection exists.')
  };
  log(`[runtime] ${report.summary}`);
  return { runtime, report };
}
