import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLauncher, sleepSync, writeWorkspaceMcpConfig } from './launchers.js';
import { McpServerDefinitions } from './integrations/integration.js';
import type { AgentLauncher } from './launchers.js';
import { diagnoseSpawnFailure } from './herdr-health.js';
import type { AgentRuntime, AgentSpawn, WorkspaceMcpServers } from './agent-runtime.js';
import {
  RESUME_ENV,
  ResumeCause,
  degradedResumePrompt,
  hasRestorableConversation,
  workspaceBrief
} from './resume.js';
import type { BriefLocation } from './resume.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * A window in which a pty mirror was not subscribed, and therefore a window in
 * which output may have been produced and not seen (KAN-381).
 *
 * ## Why this exists at all
 *
 * A link that is **down** is visible: calls fail and a caller can act on that. A
 * link that has **reconnected without resyncing** answers every question,
 * promptly, with stale data and no disclosure — nothing errors, nothing is slow,
 * and no field says *"this may have missed events"*. That is indistinguishable
 * from a healthy link from the outside, which is why the resync alone is not the
 * fix and this record is.
 *
 * ## Why it is emitted even when the resync worked
 *
 * Because a resync that silently succeeded and one that silently half-succeeded
 * look identical without a marker. The snapshot CrabCast returns on
 * re-subscription is bounded and so is ours, so a long enough gap loses bytes
 * off the front whatever either side does; and a consumer that was *appending
 * deltas* has a hole in its own copy regardless, because the snapshot replaces
 * the mirror rather than extending it. {@link resync} records how the repair
 * went; it never decides whether the gap is worth mentioning.
 */
export interface PtyDiscontinuity {
  /**
   * 1 for this session's first gap, incrementing per session.
   *
   * A consumer that is told about a gap twice — once as it opens and once as it
   * closes — needs to know it is the same gap.
   *
   * **Assignment never skips; the stored LIST can still start above 1**, and
   * conflating those is the misreading to avoid. Numbers are handed out
   * consecutively, so two live events one apart are two distinct gaps. But
   * `HerdrSession.ptyDiscontinuities` is trimmed to
   * {@link PTY_DISCONTINUITY_LIMIT} from the front, so a first entry numbered
   * higher than 1 means older gaps were dropped — which is information rather
   * than corruption, and the only reason the number is on the record at all
   * rather than being the array index.
   */
  sequence: number;
  /**
   * ISO 8601 — the last moment the mirror is known to have been subscribed.
   *
   * That is the moment the link dropped, and it bounds the window on the early
   * side. It is not a claim that output stopped then.
   */
  lostAt: string;
  /**
   * ISO 8601 when the re-subscription settled, or `null` while it has not.
   *
   * `null` is the live state of an unrepaired gap and must not be read as "no
   * time elapsed" — the gap is open and still growing.
   */
  restoredAt: string | null;
  /** `restoredAt - lostAt` in milliseconds, or `null` while the gap is open. */
  windowMs: number | null;
  /**
   * How the repair went. **`pending` is a real answer**, not a placeholder: it
   * is what an operator sees while the link is still down, and collapsing it
   * into `failed` would claim a verdict on an attempt that has not finished.
   */
  resync: 'pending' | 'succeeded' | 'failed';
  /**
   * Why the subscription was lost. One value today, and a union rather than a
   * string so a second cause has to be declared here before it can be reported.
   */
  cause: 'link-dropped';
  /** The refusal, verbatim, when `resync` is `failed`. Absent otherwise. */
  error?: string;
}

/**
 * What a pty listener receives: either output, or the news that output was
 * missed (KAN-381).
 *
 * **This is a union rather than a second optional argument, and that is the
 * point of the shape.** An optional `discontinuity` parameter is one every
 * existing consumer keeps compiling without reading — so the gap would be
 * delivered to code that renders it as nothing, which is the precise failure
 * this ticket exists to close, reintroduced one layer up. A union makes
 * "handle the bytes, ignore the gap" a thing the code cannot *say*: there is no
 * `.data` to read on the other arm, so every consumer of this stream is made to
 * decide what a gap looks like to it.
 *
 * The narrower alternative — a separate `registerDiscontinuityListener` — was
 * rejected for the same reason. It is opt-in, and an opt-in disclosure is one a
 * consumer that has never heard of it silently does not get.
 */
export type PtyStreamEvent =
  | { kind: 'data'; data: string }
  | { kind: 'discontinuity'; discontinuity: PtyDiscontinuity };

/** The callback shape both runtimes fan {@link PtyStreamEvent} out to. */
export type PtyStreamListener = (event: PtyStreamEvent) => void;

/** How many gaps a session remembers before the oldest is dropped. */
export const PTY_DISCONTINUITY_LIMIT = 50;

export interface HerdrSession {
  sessionId: string;
  type: string;
  key: string;
  /** The page this session is bound to, when the caller knew it. */
  url?: string;
  createdAt: Date;
  status: 'initializing' | 'active' | 'terminated';
  workDir: string;
  ptyProcess?: pty.IPty;
  ptyBuffer: string;
  onDataListeners: Array<PtyStreamListener>;
  /**
   * Every gap in this session's pty stream that this daemon knows about, oldest
   * first (KAN-381).
   *
   * **It sits beside {@link ptyBuffer} because it is the same claim's other
   * half.** The buffer is what the mirror has; this is what the mirror could not
   * see. KAN-367's rule on the notification surface — a state claim is either
   * freshly read, or timestamped and saying what it could not observe — arrives
   * here as two fields on one object, and reading the first without the second
   * is how a stale mirror renders as a fresh one.
   *
   * **Required rather than optional, and that is the load-bearing choice.** An
   * optional array is one a producer may omit and a consumer may treat as empty,
   * and those two mistakes are indistinguishable from a session that genuinely
   * had no gap. Required means every session that can hold a buffer has a place
   * to record what the buffer missed, so "nobody wrote the gap down" is not a
   * state this type can be in.
   *
   * **Empty is a claim, and it is `HerdrBridge`'s honest one.** An in-process
   * pty has no subscription to lose: the listener is a callback on a `node-pty`
   * handle in this process, so it cannot be silently detached while the process
   * lives, and when the process dies the session ends rather than going quiet.
   * So an empty array there says "no gap was possible", not "no gap was
   * recorded". Under {@link CrabCastRuntime} the subscription lives across a
   * socket and is exactly what a reconnect loses.
   */
  ptyDiscontinuities: PtyDiscontinuity[];
  /**
   * Set when `herdr agent start` failed, to herdr's own message plus whatever
   * we can say about the cause. Its presence is the difference between "this
   * agent is quiet" and "this agent was never created": callers report it
   * instead of claiming an activation that did not happen.
   */
  spawnError?: string;
  /**
   * Set when this session was started to bring an agent back after its machine
   * or daemon died under it, rather than to start fresh work.
   */
  resume?: ResumeCause;
  /**
   * On a resume, whether a conversation was there to restore — decided before
   * the spawn by {@link hasRestorableConversation}.
   *
   * `true` means the agent comes back remembering everything and therefore
   * needs to be *told* to carry on, because Claude Code resumes at an empty
   * prompt and waits indefinitely. `false` means the launcher's fallback ran
   * with the degraded-resume prompt and the agent is already working. The
   * caller uses this to decide whether to nudge; undefined outside a resume.
   */
  resumedConversation?: boolean;
  /**
   * Set when this session was **reconstructed from a runtime's census** rather
   * than created by a spawn of this daemon's (KAN-346).
   *
   * A daemon restart empties the session map while the agents keep running, so
   * every session-only field goes `null` and the extension has nothing to
   * attach a terminal to. `HerdrBridge` never meets that state for long — the
   * sidepanel re-activates on sight and its `spawnSession` re-attaches to the
   * live pane — but a runtime that lives behind a socket has to rebuild the
   * record from what the peer still holds. This flag is how a reader tells the
   * two apart, because they are not the same claim: a spawned session was
   * *watched* being created, and an adopted one is this daemon's reading of a
   * row.
   *
   * **`true` or absent, never `false`.** The literal type is deliberate: a
   * session that was spawned must not be *nameable* as `adopted: false` by some
   * later author reaching for symmetry, because then two spellings would mean
   * "spawned" and only one of them would be searchable.
   */
  adopted?: true;
  /**
   * Whether a live agent runtime is what this session's launcher delivers.
   * False only for `shell`, where a bare prompt with no runtime behind the
   * pane is the delivered product — the same exemption router.ts's
   * expectsRuntime() draws. Set by initPty once the launcher is resolved, and
   * read wherever "does an agent exist here?" is answered: for every other
   * launcher, a pane herdr reports no runtime for is not an agent, however
   * many name registrations point at it (KAN-58).
   *
   * ## KAN-395 ruled on this field, and the ruling is that it keeps its meaning
   *
   * The question was live and worth asking: KAN-395 shrank the fleet to
   * `claude`, and a flag whose only false case has been deleted is a mechanism
   * that goes on reporting after the question it answered stopped existing.
   * Four sites are defined by negation against `shell` — here, `router.ts`'s
   * `expectsRuntime()`, and both `crabcast-runtime.ts` producers.
   *
   * **The false case was not deleted, so the field is not a constant.** `shell`
   * stayed in `AGENT_LAUNCHERS` for a reason named there and in
   * `daemon/scripts/lib/channel-probe.mjs` note 3: it is how every channel probe
   * brings up a pane it can drive, through the real daemon. Those are real
   * activations that really produce a runtime-less pane, so `false` here is
   * still produced, still read, and still the thing standing between a probe's
   * bash prompt and `initPty` tearing it down as a stale registration.
   *
   * **What DID change is who can produce one, and that is the part worth
   * writing down.** Before KAN-395 the answer was "any activation that omitted
   * or misspelled `defaultAgent` in the extension" — the sidepanel's service
   * worker defaulted the field to `'shell'`. Now it is "a caller that names
   * `shell` explicitly", which in this repository is the probe harness and
   * nothing else. So this field is no longer a property of ordinary fleet
   * traffic; it is a property of fixtures. Read a `false` here as *"a probe is
   * holding this pane"*, and if that ever stops being true, this field has
   * become the constant KAN-395 looked for and should be deleted rather than
   * pinned to `true` — a `true` nobody can falsify is the same defect wearing
   * the answer's clothes.
   */
  expectsRuntime?: boolean;
}

/**
 * herdr's own view of what an agent is doing, which is finer-grained than a
 * session's active/terminated bookkeeping: 'blocked' means the agent is
 * waiting on a human, which is the state a user most needs to see.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

const HERDR_AGENT_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

/** Ceiling on any single herdr CLI call, so a wedged herdr can't hang a caller. */
export const HERDR_CLI_TIMEOUT_MS = 5000;

/**
 * How long {@link HerdrBridge.confirmAgentPresent} keeps asking before it
 * declares a just-spawned agent absent.
 *
 * `herdr agent start` is synchronous — it returns once the pane exists — so a
 * successful spawn is normally in the census on the first ask and this costs
 * one CLI call. The wait exists for the gap between herdr acknowledging the
 * start and the agent being listable, not as a retry budget; five seconds is
 * far longer than that gap has ever been observed to be, and short enough that
 * a caller blocked on an activation is not left wondering.
 */
export const AGENT_CONFIRM_TIMEOUT_MS = 5000;

/**
 * How long {@link HerdrBridge.confirmAgentPresent} waits for a *runtime* to
 * appear behind the pane, when the launcher is one that delivers a runtime.
 *
 * Longer than {@link AGENT_CONFIRM_TIMEOUT_MS} because it covers a different
 * gap: not herdr registering the name — near-instant — but the launcher's
 * process chain actually reaching claude (`bash -c "claude --continue ||
 * claude …"`, where the `--continue` probe can exit and fall back before the
 * process herdr reports as the pane's agent exists). On the healthy path the
 * poll returns at the first census that shows the runtime, so this ceiling is
 * only ever paid in full when no agent is coming — the case where a slow
 * honest answer beats a fast false one (KAN-58).
 */
const RUNTIME_CONFIRM_TIMEOUT_MS = 20000;

/** Gap between census checks while waiting for a spawned agent to appear. */
const AGENT_CONFIRM_POLL_MS = 250;

/**
 * How many times the initial-prompt write is attempted before the activation
 * is refused, and the pause between attempts. The retry exists for transient
 * FS errors — a momentary EAGAIN or ENOSPC that a beat later clears — not as a
 * way to outlast a workspace that genuinely cannot be written: three failures
 * in a row is a directory that cannot hold the agent's brief, and no bounded
 * retry beats that — refusing honestly does (the TRUST_WRITE_ATTEMPTS lesson,
 * KAN-54).
 */
const PROMPT_WRITE_ATTEMPTS = 3;
const PROMPT_WRITE_RETRY_MS = 60;

/**
 * Whether an agent actually exists, asked after a spawn herdr did not complain
 * about. The two failures are kept apart because they license different
 * actions: `absent` is evidence there is nothing there, and the session may be
 * torn down on the strength of it; `unverifiable` is the absence of evidence —
 * herdr did not answer — and nothing may be concluded, least of all that the
 * agent is dead.
 */
export type AgentPresence =
  | { present: true; waitedMs: number; checks: number }
  | {
      present: false;
      reason: 'absent' | 'unverifiable';
      error: string;
      waitedMs: number;
      checks: number;
    };

/** An Error from {@link HerdrBridge.runHerdr}, carrying herdr's own error code. */
interface HerdrCliError extends Error {
  herdrCode?: string;
}

/**
 * herdr's code for "an agent by that name already exists". Starting an agent
 * is meant to be idempotent here — initPty checks for the agent first — but
 * the check and the start are two calls, so a concurrent activation can win
 * the race between them. That is a no-op, not a failure: the agent the caller
 * asked for exists either way.
 */
const AGENT_NAME_TAKEN = 'agent_name_taken';

/**
 * herdr's codes for "there is no such agent" and "there is no such pane".
 *
 * For a teardown these are the request already being satisfied, not a failure:
 * what the caller asked for is that the agent stop existing, and herdr saying
 * it does not exist is that. Every other error means we do not know what
 * happened, which is a different answer and must not be reported as this one.
 */
const AGENT_NOT_FOUND = 'agent_not_found';
const PANE_NOT_FOUND = 'pane_not_found';

/** Time the agent's TUI gets to redraw after the interrupt, before we type. */
const INTERRUPT_SETTLE_MS = 100;

/** How much of an agent's terminal a tail returns when the caller doesn't say. */
const TAIL_DEFAULT_LINES = 40;

/** Ceiling on a tail, so one call can't drag a whole scrollback over the wire. */
const TAIL_MAX_LINES = 200;

/**
 * The herdr read sources a tail may come from, in the order they are asked.
 *
 * WHY THERE ARE TWO, AND WHY THE FIRST IS STILL FIRST. Measured on herdr 0.6.4
 * against this machine's own panes (KAN-255; the same rule was first measured
 * for `wroosbit/crabcast` by KAN-98). The measurement is the whole reason this
 * is a fallback rather than a substitution:
 *
 *   `recent`/`recent-unwrapped --lines N` return THE LAST N ROWS OF THE GRID
 *   (scrollback + screen). Rows below the cursor are blank, so when a pane's
 *   content sits in the top C rows of an R-row screen, EVERY N <= R - C
 *   selects nothing but blank rows and herdr answers `""` — for a pane that is
 *   alive and plainly has text on it. Predicted from geometry and hit exactly:
 *   a 23-row pane with 3 rows of content answered `""` at every N from 1 to 20
 *   and returned text at N = 21.
 *
 *   `visible` returns the screen's content and IS NOT AFFECTED BY N at all —
 *   byte-identical at every N from 1 to 200 on the same panes.
 *
 * So `recent-unwrapped` is asked first because it reaches back through
 * SCROLLBACK, which `visible` cannot see — measured too: a pane holding 60
 * lines of history answered with rows that had scrolled off the screen.
 * `visible` is asked only when the first came back empty, and its answer is
 * trimmed to the caller's N so a fallback cannot quietly return more than was
 * asked for.
 *
 * WHAT THIS DOES **NOT** BUY, stated because the docblock it replaces claimed
 * it. That comment justified `recent-unwrapped` as the source showing "the
 * frozen last frame of an agent whose process died". IT DOES NOT, AND NEITHER
 * DOES `visible`: herdr destroys the pane with its process, so within ~500ms
 * every source stops returning a `read` object at all and the agent leaves
 * `agent list`. There is no frozen frame to read on this build, so that
 * capability does not exist to be regressed by adding a second source.
 */
const TAIL_SOURCES = ['recent-unwrapped', 'visible'] as const;
export type TailSource = (typeof TAIL_SOURCES)[number];

/**
 * The last `lines` lines of `text`, used to hold the `visible` fallback to the
 * bound the caller asked for. `visible` ignores `--lines`, so without this a
 * `--lines 8` request could be answered with a whole screen.
 */
function lastLines(text: string, lines: number): string {
  const rows = text.split('\n');
  return rows.length <= lines ? text : rows.slice(-lines).join('\n');
}

/**
 * What herdr prints to the attach it is evicting. We match on it to tell the
 * user *why* their terminal stopped, rather than showing a dead pane and
 * letting them guess.
 */
const TAKEOVER_NOTICE = 'terminal attach taken over';

/** How much of the tail of a dead PTY we search for herdr's parting message. */
const EXIT_REASON_SCAN_CHARS = 2000;

/** Why a session's PTY is no longer streaming. */
export type SessionEndReason = 'taken-over' | 'exited';

/**
 * A tab opened for one agent to live in. The terminal id is carried alongside
 * the tab id because it is the only handle here that stays valid: herdr's tab
 * and pane ids are positions in lists that compact whenever anything earlier
 * closes, while a terminal id belongs to the terminal for as long as it runs.
 */
interface AgentTab {
  tabId: string;
  workspaceId: string;
  /** The shell `herdr tab create` opens the tab on, which the agent replaces. */
  placeholderTerminalId: string;
}

/** Told to the UI when a PTY dies, so a dead terminal never renders as a live one. */
export interface SessionEndedEvent {
  type: string;
  key: string;
  sessionId: string;
  reason: SessionEndReason;
  exitCode: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

declare const BUTCHR_AGENT_NAME_BRAND: unique symbol;

/**
 * **The name Butchr addresses an agent by — `butchr-<type>-<key>` — as a type
 * the compiler can tell apart from the other string that means "the name of an
 * agent" (KAN-406).**
 *
 * There are two such strings, and until this brand existed they were the same
 * type. This one is Butchr's; the other is a **pane** name, chosen by whatever
 * process started the pane, which for a CrabCast-started agent is
 * `crabcast-<key>-<hash>`. **They are equal for a herdr-started pane and
 * different for a CrabCast-started one**, so a join on the wrong one is correct
 * in every test that only starts panes through herdr and wrong for exactly the
 * population the CrabCast runtime creates.
 *
 * **That cost two defects in one file.** KAN-346 established the rule — derive
 * the name from the row's *path*, never from `paneName` — and wrote it longhand
 * inside `censusRecords()`. KAN-397 then found `confirmAgentPresent`, one
 * function away, still joining on the raw `paneName`: under a flipped daemon
 * every CrabCast-started `claude` agent was reported a failed activation and
 * torn down while it kept running. Both fixes were right and neither could stop
 * the third instance, because `r.paneName === agentName` type-checks perfectly
 * and the distinction lived only in prose and in the reader's head.
 *
 * With the brand it does not type-check: comparing a {@link PaneName} to one of
 * these is `error TS2367`, at the keystroke rather than at review. The brand is
 * phantom — it exists only in the type system, so one of these is an ordinary
 * `string` at runtime and every `startsWith`, template literal and `Map` key
 * over it is unchanged.
 *
 * **{@link agentNameFor} is the only producer, and the cast inside it is the
 * only place a bare string becomes one of these in `daemon/src`.** A cast
 * written anywhere else claims the `butchr-<type>-<key>` spelling without
 * producing it, which is the review catch this type replaces, with an extra
 * step.
 *
 * **Two limits, because a brand that is trusted past them is worse than none:**
 *
 *  - **It binds only where BOTH sides are branded.** Comparing one of these to
 *    a plain `string` still compiles, by design — that is what keeps this a
 *    typing change rather than a rewrite of every signature in the daemon.
 *  - **It does not exist at runtime**, so `daemon/scripts/*.mjs`, which imports
 *    the compiled `dist/`, gets nothing from it.
 */
export type ButchrAgentName = string & {
  readonly [BUTCHR_AGENT_NAME_BRAND]: 'butchr-agent-name';
};

/**
 * The herdr agent a Butchr session drives. Sessions are keyed by workspace.
 *
 * **The signature is unchanged at runtime and must stay that way**: seventeen
 * `daemon/scripts/*.mjs` files import this from `dist/` and call it, and
 * `tsc` never sees them (KAN-406). Branding the return type is invisible to
 * them — brands erase — but a rename or a re-signature would break all
 * seventeen with nothing to report it.
 */
export function agentNameFor(type: string, key: string): ButchrAgentName {
  return `butchr-${type}-${key.toLowerCase()}` as ButchrAgentName;
}

/**
 * Where a workspace lives, and whether Butchr may delete one, now live in
 * `workspace-dir.ts` (KAN-380) — because a *second* runtime needed them and
 * they were sitting inside this one as private detail. They are re-exported
 * from here unchanged so the twenty-odd modules and scripts that import them
 * from `herdr.js` keep working; nothing about their meaning moved.
 */
export {
  containWorkspaceDir,
  deleteWorkspaceDir,
  isStrictlyInside,
  workspaceDirFor,
  workspacesRoot,
  type ContainedWorkspaceDir,
  type WorkspaceContainment
} from './workspace-dir.js';

// A re-export creates no local binding, so this file's own uses of the two it
// calls are imported as well. Same module, same functions.
import { deleteWorkspaceDir, workspaceDirFor, workspacesRoot } from './workspace-dir.js';

/**
 * Inverse of agentNameFor. When an agent is resolved through the herdr-list
 * fallback there is no session to read a type off of, but the name still
 * carries one — enough to broadcast a complete event.
 */
export function typeFromAgentName(agentName: string, key: string): string | undefined {
  const prefix = 'butchr-';
  const suffix = `-${key.toLowerCase()}`;
  if (!agentName.startsWith(prefix) || !agentName.endsWith(suffix)) return undefined;
  return agentName.slice(prefix.length, agentName.length - suffix.length) || undefined;
}

/** A workspace address recovered from an agent name alone. */
export interface AgentAddress {
  type: string;
  key: string;
}

/**
 * Full inverse of agentNameFor, for the case where not even the key is known:
 * enumerating herdr's agents and working out which workspace each one is.
 *
 * `butchr-<type>-<key>` is split at the *first* dash after the prefix, because
 * workspace types are single tokens (`task`, `epic`, `story`, `confluence`,
 * `default`) while keys routinely contain dashes (`kan-28`). That is a
 * convention, not a guarantee, so the parse is only trusted when it rebuilds
 * the name it came from — a name this daemon could never have produced yields
 * null rather than a guessed address that later calls would fail to resolve.
 *
 * A key need not contain a dash, or letters: Confluence keys are bare page ids
 * (`butchr-confluence-196787` → `{ type: 'confluence', key: '196787' }`). The
 * split is on the first dash, so a dashless key round-trips like any other.
 */
export function addressFromAgentName(agentName: string): AgentAddress | null {
  const prefix = 'butchr-';
  if (!agentName.startsWith(prefix)) return null;

  const rest = agentName.slice(prefix.length);
  const split = rest.indexOf('-');
  if (split <= 0 || split >= rest.length - 1) return null;

  const address = { type: rest.slice(0, split), key: rest.slice(split + 1) };
  return agentNameFor(address.type, address.key) === agentName ? address : null;
}

function toAgentStatus(value: unknown): HerdrAgentStatus {
  return HERDR_AGENT_STATUSES.includes(value as HerdrAgentStatus)
    ? (value as HerdrAgentStatus)
    : 'unknown';
}

function parseJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clampTailLines(lines: unknown): number {
  const requested = typeof lines === 'number' && Number.isFinite(lines)
    ? Math.floor(lines)
    : TAIL_DEFAULT_LINES;
  return Math.min(Math.max(requested, 1), TAIL_MAX_LINES);
}

/**
 * What herdr alone can tell us about an agent, with no session to consult.
 * Unknown fields are explicitly null rather than absent: this is serialized
 * to a client as JSON, where an undefined field would simply vanish and read
 * as "the daemon didn't answer that" instead of "there is nothing to report".
 */
export interface HerdrAgentDescription {
  agentName: string;
  type: string | null;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
}

/**
 * One entry of `herdr agent list` — herdr's own record of a pane, independent
 * of anything this daemon remembers.
 *
 * `agentRuntime` is herdr's `agent` field: the CLI it launched in the pane
 * (`claude`), absent for a pane running a bare shell. It is the only evidence
 * available for whether a `butchr-*` name has an agent behind it at all, which
 * is what separates a live agent from one of the shell panes left over on the
 * board. Absent stays null; nothing is inferred from the name.
 */
export interface HerdrAgentRecord {
  name: string;
  agentRuntime: string | null;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
}

/**
 * CrabCast read-path contract v7's `rowStanding` (their KAN-344).
 *
 * **A verdict about THE ROW, never about an agent**, and the obvious reading is
 * the wrong one. Their registry is append-only and a row is one *event*, so a
 * later readable row may supersede this one entirely. `claims-an-agent` says
 * *this line asserts an agent* — it is not a claim that anything is running
 * now, and their daemon cannot make that claim, because the line it would have
 * to read is the line it could not read.
 *
 * **`unknown` must never be collapsed to `retired`.** Their contract states it
 * outright: reading *"not a word I know"* as *"harmless"* is the
 * wrong-conclusion-from-a-short-list defect arriving one level up. It is also
 * what every `from-newer` row carries, deliberately, even where the event word
 * is one they know.
 */
export type RowStanding = 'retired' | 'claims-an-agent' | 'unknown';

/**
 * A standing verdict, **or the fact that this peer could not offer one** —
 * KAN-357, and the reason this is an object union rather than
 * `RowStanding | null`.
 *
 * ## The state this type exists to make unrepresentable
 *
 * *"This peer is too old to have the field"* and *"this row has no standing we
 * will name"* are different sentences, and only the second is a
 * {@link RowStanding}. `unknown` is **a verdict about a row**; a peer below v7
 * is **a fact about the connection**, which no member of their vocabulary can
 * carry. Spelling the second as `'unknown'` would publish their daemon's
 * verdict on a row it never rendered a verdict on.
 *
 * **A nullable `RowStanding | null` would not have stopped that**, because the
 * collapse is one `??` away and reads as tidying — the same `?? 0` shape that
 * {@link CensusReading.unreadableRecordsTotal} carries three paragraphs of
 * prose to forbid. Prose is what you use when the type cannot say it. Here it
 * can: a consumer **cannot** read `.verdict` off this value without first
 * narrowing on `available`, so the collapse is not a bug to be caught in review
 * but a shape that does not compile. That is the ordering KAN-357 asks for —
 * the type where the invariant is about what the code can say, the assertion
 * where it is about what happened.
 *
 * **And it is the state Butchr is actually in**, which is why it is not
 * hypothetical: as of 2026-08-13 the CrabCast serving this machine answers
 * `contractVersion: 6`, so every row on the wire takes the `available: false`
 * arm and there is no v7 peer anywhere to take the other one.
 *
 * ## All THREE v7 fields live behind this one gate, and that is not tidiness
 *
 * `claimsAt` and `claimsEvent` arrived in the same release as `standing` and
 * are absent from the same peers, so they are on the `available: true` arm
 * rather than beside it. **Putting them outside would reintroduce the very
 * collapse this type exists to prevent, one field over**: their contract
 * guarantees that a line which does not parse never becomes one of these rows
 * at all, so `claimsAt: null` means *the row parsed and named no timestamp* and
 * **never** *we could not see it*. Read off a v6 peer — where the key is not
 * sent — a bare `claimsAt: null` would mean exactly the forbidden second thing,
 * and nothing in its type could say so. Behind the gate, that value is not
 * reachable unless a peer that publishes the field said it.
 *
 * `claimsPath` is **not** here, and that asymmetry is real rather than an
 * oversight: it landed in v4, so a v6 peer genuinely sends it and its `null` on
 * such a peer genuinely means *the row named no path*.
 */
export type StandingReading =
  | {
      available: false;
      /**
       * Why no verdict was available, and the two reasons are **not
       * interchangeable**: `peer-below-v7` is a CrabCast that will answer this
       * once it is deployed, while `source-does-not-disclose` is a source with
       * no such concept at all — herdr's census has no registry rows, no event
       * vocabulary and nothing that could ever render a standing. Folding the
       * second into the first would publish a version complaint about a leg
       * that has no version.
       */
      because: 'peer-below-v7' | 'source-does-not-disclose';
      /**
       * What the peer actually published, so the refusal names its own
       * evidence. `null` where the peer published none, and always `null` for
       * `source-does-not-disclose`.
       */
      peerContractVersion: number | null;
    }
  | {
      available: true;
      /** Their verdict on the row. */
      verdict: RowStanding;
      /**
       * The timestamp the row gives for **itself**, quoted verbatim, or `null`
       * where it named none.
       *
       * **A quotation, not a date, and typed `string` on purpose.** Their
       * promise is that this is what the row said, never that it parses: the
       * row came off a line nobody could read, and a hand-edited one may hold
       * anything at all. A type asserting date-ness would assert something the
       * value cannot honour. It is also **when the row was WRITTEN, not when it
       * became unreadable.**
       */
      claimsAt: string | null;
      /**
       * The row's own `event`, verbatim, or `null` where it named none. **In
       * the row's own vocabulary** — a word their daemon does not know arrives
       * as the word it is rather than as a null.
       *
       * **This is the evidence under {@link verdict}**, and it travels beside
       * it so the verdict can be checked. An interpretation nobody can compare
       * against the underlying quote is one nobody can catch being wrong; that
       * is their argument for shipping both, and it only works if a consumer
       * carries both.
       */
      claimsEvent: string | null;
    };

/**
 * The supersession join CrabCast's contract prescribes — **three outcomes, and
 * the third is the one an earlier draft of their own document left out.**
 *
 * A row whose {@link RowStanding} is `claims-an-agent` is published beside a
 * whole fleet read, so a consumer can ask whether anything readable already
 * covers the agent that line mentions. The join key is `claimsPath` and **not**
 * `identity`: an agent *is* a canonical path, so `claimsPath` matches a
 * readable row's `path` directly, while `identity` is deliberately the row's
 * own vocabulary — `agentName`, else `<type>/<key>`, else `path` — because its
 * job is letting a **human** find the line in the file.
 *
 * **`could-not-run` is not a hedge, and collapsing it into `ran-found-nothing`
 * is the defect this type exists to prevent.** *"We could not join it"* and
 * *"we joined it and found nothing"* are different answers. A `pre-migration`
 * row identified as `shell/demo` will never match a path-keyed list, so reading
 * that failed match as *"absent, therefore lost"* manufactures an alarm on the
 * ordinary case — **an alarm that never clears**, which is the same failure as
 * the permanently-`1` count KAN-357 exists to escape, rebuilt one layer up.
 * That is not a hypothetical either: it is the state of the only real specimen
 * on this machine.
 */
export type SupersessionJoin =
  /** The path appears in a readable category: a later row superseded this line. The boring case. */
  | { outcome: 'matched'; claimsPath: string; matchedPath: string }
  /** The join RAN against a real path and nothing readable carries it. **This is the case the disclosure exists for.** */
  | { outcome: 'ran-found-nothing'; claimsPath: string }
  /** `claimsPath` is null, so there was nothing to join on. **Not evidence either way** — read `raw` and decide by hand. */
  | { outcome: 'could-not-run'; identity: string | null };

/**
 * One row a census could not read, and therefore did not count (KAN-324,
 * extended to read-path contract v7 by KAN-357).
 *
 * **Deliberately does not carry the row's raw text.** CrabCast's own
 * `unreadableRecords[].raw` is the registry line verbatim, with a
 * `promptRedacted` flag beside it because a registry row can hold an agent's
 * prompt. Butchr's `list_agents_response` is read by every agent on the
 * machine, so copying an unbounded verbatim row onto it would move content
 * across a boundary the disclosure never needed to cross. What a reader has to
 * act on is *that* a row was skipped, which one, and why — all three are here.
 * The verbatim row stays where it already is, one `crabcast daemon-status`
 * away.
 */
export interface CensusUnreadableRecord {
  /** Which leg could not read the row. The headline of any rendering. */
  source: 'crabcast-registry' | 'herdr-census';
  /** 1-based line in the source registry, where the source has lines. */
  line: number | null;
  /** The source's own machine-readable classification, verbatim. */
  problem: string | null;
  /**
   * The best identifier that survived the row, where one did.
   *
   * **In the row's own vocabulary, and therefore not a join key** — see
   * {@link SupersessionJoin}. Kept and published because it is what lets a
   * human find the line in the file, which is the job it was built for.
   */
  identity: string | null;
  /** The source's own explanation, verbatim. Never synthesised here. */
  reason: string | null;
  /**
   * A directory this row names — its `path`, else the retired `workDir` — or
   * `null` where it names none. **The join key** ({@link SupersessionJoin}).
   *
   * On the wire from v4 onward, so this is readable against the v6 peer this
   * machine actually has. `null` on the live specimen, which is precisely why
   * `could-not-run` had to be a representable outcome.
   */
  claimsPath: string | null;
  /**
   * **All three of read-path v7's fields, or the fact that this peer is too old
   * to have sent any of them** — their verdict on the row plus the two
   * quotations that are its evidence. See {@link StandingReading} for why this
   * is a union rather than a nullable, and why the three travel together.
   *
   * **Required rather than optional**, for the same reason
   * {@link CensusReading.unreadableRecordsTotal} is: an optional field is one a
   * future runtime can omit and still compile, which puts the silent collapse
   * back one implementation later. A runtime that cannot disclose has to *say
   * so*.
   */
  standing: StandingReading;
  /**
   * The supersession join, computed **only** where {@link standing} is
   * available and reads `claims-an-agent`; `null` everywhere else.
   *
   * `null` here is *"this question was not asked"* — the row is retired, or
   * unknown, or the peer could not tell us — and is distinct from
   * `could-not-run`, which is *"the question was asked and could not be
   * answered"*. `retired` needs none of this: nothing was going to be restored
   * from it either way.
   */
  supersession: SupersessionJoin | null;
}

/**
 * A census reading: the agents, whether it could be taken, **and what it could
 * not read**.
 *
 * ## Why the qualifier is on this type rather than beside it
 *
 * Because an agent count published without it is the defect (KAN-324). Before
 * CrabCast's KAN-302 a registry row their daemon could not read made it refuse
 * to start; now it starts and *skips*, so a census answers a **shorter list
 * with nothing saying it is short** — `agents: []` is byte-for-byte what an
 * empty fleet reads. That is this codebase's recurring shape: a claim true of
 * part of its subject read as true of all of it.
 *
 * Putting {@link unreadableRecordsTotal} in the same returned object as
 * {@link agents} is the same argument {@link reachable} already makes here, and
 * for the same reason: they are two halves of one reading, and asking for the
 * second as a separate call would let the world move between them. A caller
 * cannot hold the count without also holding what qualifies it.
 *
 * **And it is required rather than optional on purpose.** An optional field is
 * one a future runtime can omit and still compile, which puts the silent-short
 * census back one implementation later. Required means a runtime that cannot
 * disclose has to say so — in `null`, below — rather than say nothing.
 *
 * ## `null` is a third state and must not be collapsed to `0`
 *
 * `?? 0` is the defect in one operator: it turns *"nobody disclosed"* into
 * *"there were none"*, which is the exact false reassurance this field exists
 * to remove. The same collapse was already caught once on `channelEnabled` (see
 * `readChannelEnabled` in `crabcast-runtime.ts`), and it degrades the same way
 * — toward looking clean.
 *
 * - `number` — this reading carries a disclosure. `0` means *nothing was
 *   skipped*, and **that is what makes the agent count trustworthy.**
 * - `null` — no disclosure reached us. Either the census could not be taken at
 *   all, or the peer publishes none (a CrabCast below read-path contract v4).
 *   The count may still be short; nothing here says it is not.
 */
export interface CensusReading {
  /** Whether the census could be TAKEN. Never a claim about what it found. */
  reachable: boolean;
  agents: HerdrAgentRecord[];
  /**
   * How many rows the source could not read, or `null` for no disclosure.
   *
   * **The total, not `unreadableRecords.length`.** A source is free to cap the
   * detail rows it returns; a length that silently stopped at that cap would
   * read as "that is all of them", which is the defect one field to the left.
   */
  unreadableRecordsTotal: number | null;
  /**
   * The rows themselves, where the source disclosed them. Always present and
   * empty rather than absent — "nothing was skipped" and "this runtime does not
   * track that" are different answers, and {@link unreadableRecordsTotal} is
   * the field that tells them apart.
   */
  unreadableRecords: CensusUnreadableRecord[];
}

export class HerdrBridge implements AgentRuntime {
  private sessions: Map<string, HerdrSession> = new Map();

  /** Set by the daemon so a dying PTY can be announced to connected clients. */
  private sessionEndedListener?: (event: SessionEndedEvent) => void;

  public setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void {
    this.sessionEndedListener = listener;
  }

  /**
   * Called once per pane this bridge actually spawns, so somebody who knows what
   * a channel is can watch the agent through its startup (KAN-246).
   *
   * A hook rather than a direct call because the thing it has to wait for lives
   * in the daemon and not here: readiness is a connection appearing in KAN-243's
   * identity map, and this class knows about panes and processes and nothing at
   * all about sockets. daemon.ts owns the map and installs the closure over it —
   * the same seam the router's `channelRoute` uses, for the same reason.
   *
   * Absent by default, and every non-daemon caller of HerdrBridge (the verify
   * scripts among them) leaves it absent, which is why a spawn with no hook
   * installed must behave exactly as it did before this existed.
   *
   * **What is passed is the spawn's own verdict, not a second look at the
   * world.** The listener could read the channel switch itself — the launcher
   * read it a few lines earlier to decide — but those are two reads of a file
   * that anything may rewrite between them, and the dangerous direction is not
   * hypothetical: a switch turned off in that window gives a `claude` launched
   * WITH the flag and nothing watching for the dialog it raises, which is
   * precisely the wedged agent KAN-246 exists to prevent.
   *
   * **KAN-294 changed what carries that verdict and not the argument for
   * carrying one.** It used to be the command string, which the listener
   * searched for {@link DEV_CHANNELS_FLAG}. The reasoning above is untouched by
   * the swap — one read, at the composing site, handed over — but the string was
   * a carrier that only works for a launcher that spells its channel decision as
   * a flag. `AgentLauncher.command` now returns the decision beside the command
   * it produced, so `channelEnabled` is what crosses this boundary and the
   * command line is diagnostic.
   */
  private agentSpawnedListener?: (
    session: HerdrSession,
    spawnedAt: number,
    spawn: AgentSpawn
  ) => void;

  public setAgentSpawnedListener(
    listener: (session: HerdrSession, spawnedAt: number, spawn: AgentSpawn) => void
  ): void {
    this.agentSpawnedListener = listener;
  }

  /**
   * A session of ours that is currently attached to this agent's terminal.
   *
   * herdr allows exactly one terminal attach per terminal, so this is the
   * question that decides whether a new attach may use `--takeover`: an
   * attach we already own is a live sidepanel, and stealing it is the KAN-16
   * freeze. A session with no `ptyProcess` never got one (pty.spawn threw) and
   * holds nothing.
   */
  private liveAttachFor(agentName: string): HerdrSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.status !== 'active' || !session.ptyProcess) continue;
      if (agentNameFor(session.type, session.key) === agentName) return session;
    }
    return undefined;
  }

  /**
   * herdr writes the brief into the workspace, so it can name the file.
   *
   * Derived from the same {@link workspaceBrief} the write goes through
   * (`initPty`), which is the whole reason that helper exists: the file this
   * daemon writes and the file it sends an agent to are one expression, not two
   * that happen to agree today.
   *
   * Answers from the address rather than from a live session, per the interface
   * — the workspace path is a function of `(type, key)` here, exactly as
   * `initPty` computes it, so there is no state to be missing.
   */
  public briefLocation(type: string, key: string): BriefLocation {
    return workspaceBrief(workspaceDirFor(type, key));
  }

  // `url` is `string | undefined` rather than optional: it sits in front of
  // required parameters, and callers who have no URL must pass nothing rather
  // than a placeholder.
  public spawnSession(type: string, key: string, url: string | undefined, promptContent: string, defaultAgent?: string, mcpServers?: WorkspaceMcpServers, resume?: ResumeCause): HerdrSession {
    // One attach per agent, enforced here rather than in each caller. The
    // routers dedupe by (key, type), but the MCP server and the sidepanel's
    // re-attach path can both ask to activate the same agent at once. A second
    // attach would evict the first, so the only safe answer is the session we
    // already have.
    const agentName = agentNameFor(type, key);
    const existing = this.liveAttachFor(agentName);
    if (existing) {
      console.log(
        `[HerdrBridge] Reusing live session ${existing.sessionId} for ${agentName}; ` +
        `refusing to open a second attach that would evict it`
      );
      return existing;
    }

    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    const defaultWorkDir = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces', type, key.toLowerCase());

    if (!fs.existsSync(defaultWorkDir)) {
      fs.mkdirSync(defaultWorkDir, { recursive: true });
    }

    console.log(`[HerdrBridge] Spawning PTY session: ${sessionId} in ${defaultWorkDir}`);

    // Asked *before* the spawn, because the directory is checked as it is now
    // and the launcher is about to write into it. It decides which resume
    // framing the agent gets, and — for the caller — whether the restored agent
    // will need to be told to carry on.
    const resumedConversation = resume ? hasRestorableConversation(defaultWorkDir) : undefined;
    if (resume) {
      console.log(
        `[HerdrBridge] Resuming ${agentName} after ${resume}: ` +
        (resumedConversation
          ? 'a conversation is on disk, so --continue will restore it'
          : 'no conversation on disk, so it will start with the degraded-resume prompt')
      );
    }

    const session: HerdrSession = {
      sessionId,
      type,
      key,
      url,
      createdAt: new Date(),
      status: 'active',
      workDir: defaultWorkDir,
      ptyBuffer: '',
      onDataListeners: [],
      // Empty here is a claim rather than an omission, and it stays empty for
      // the life of this session: an in-process pty listener cannot be
      // detached behind our back. See PtyDiscontinuity on HerdrSession.
      ptyDiscontinuities: [],
      ...(resume ? { resume, resumedConversation } : {})
    };

    this.sessions.set(sessionId, session);
    this.initPty(session, promptContent, defaultAgent, mcpServers);

    return session;
  }

  /**
   * Start `agentName` in a herdr tab of its own, running `argv`.
   *
   * `herdr agent start` with no placement flags splits whatever pane is
   * current, so every agent landed in the one tab the human happened to be on.
   * Panes in a rendered tab are sized by the app's split layout, which divides
   * the terminal between them — at seven agents each pane was about four
   * columns wide and `agent read` came back one word per line, unreadable
   * exactly when a large fleet is what you need to supervise.
   *
   * A tab is the unit that fixes this because the app only lays out the tab it
   * is *rendering*. An agent sitting in a background tab keeps whatever size
   * its last attach asked for — the 80x24 the `pty.spawn` in {@link initPty}
   * requests — no matter how many other agents exist. That is the
   * width-independence being bought here, and it is why this is a tab rather
   * than a wider split.
   *
   * herdr has no "start in a new tab" flag, so the tab is made first and the
   * agent placed into it. `tab create` opens the tab on a placeholder shell and
   * `agent start --tab` splits that, so the agent would get half a tab and
   * twice the file descriptors; {@link closeTabPlaceholder} takes the
   * placeholder back out again. What remains is one pane per agent, the same
   * cost as before, and herdr closes the tab on its own once that last pane
   * exits — so finished agents leave nothing behind.
   */
  private startAgentInOwnTab(agentName: string, workDir: string, argv: string[]): void {
    const start = (placement: string[]) => this.runHerdr([
      'agent', 'start', agentName,
      '--cwd', workDir,
      ...placement,
      // Spawning is a background event; the human is usually reading something
      // else. herdr already defaults this way, but a default that flipped
      // would yank the screen away on every activation, so it is stated.
      '--no-focus',
      '--',
      ...argv
    ]);

    const tab = this.createAgentTab(agentName, workDir);
    if (!tab) {
      // No tab is a cosmetic loss; no agent is a broken activation. Spawn the
      // agent the old way rather than fail over where it gets drawn.
      start([]);
      return;
    }

    try {
      try {
        start(['--tab', tab.tabId]);
      } catch (e: any) {
        // The name being taken means the agent exists already — the caller
        // handles that, and retrying would start a second one.
        if ((e as HerdrCliError)?.herdrCode === AGENT_NAME_TAKEN) throw e;

        // Tab ids are positional and renumber whenever an earlier tab closes,
        // so the id we were just handed can go stale between the two calls.
        // Ours is always the newest and therefore the highest-numbered, so a
        // renumber can only leave it dangling — herdr answers
        // `agent_placement_not_found` and never resolves it to somebody else's
        // tab. Falling back keeps the spawn working through that race.
        console.error(
          `[HerdrBridge] Could not place ${agentName} in tab ${tab.tabId} ` +
          `(${e?.message ?? String(e)}); starting it in herdr's default placement instead`
        );
        start([]);
      }
    } finally {
      // Also on the failure paths: an abandoned tab would otherwise sit there
      // holding a shell nobody asked for.
      this.closeTabPlaceholder(tab);
    }
  }

  /**
   * Open a tab for an agent, labelled with the agent's name so the human can
   * tell the fleet apart at a glance. Returns undefined rather than throwing —
   * every caller can still spawn without one.
   */
  private createAgentTab(agentName: string, cwd: string): AgentTab | undefined {
    try {
      const result = this.runHerdr([
        'tab', 'create', '--cwd', cwd, '--label', agentName, '--no-focus'
      ])?.result;

      const tabId = result?.tab?.tab_id;
      const workspaceId = result?.root_pane?.workspace_id;
      const placeholderTerminalId = result?.root_pane?.terminal_id;
      if (typeof tabId !== 'string' || typeof workspaceId !== 'string' || typeof placeholderTerminalId !== 'string') {
        throw new Error('herdr tab create returned no usable tab');
      }

      return { tabId, workspaceId, placeholderTerminalId };
    } catch (e: any) {
      console.error(
        `[HerdrBridge] Could not create a tab for ${agentName} (${e?.message ?? String(e)}); ` +
        `it will share whichever tab herdr picks`
      );
      return undefined;
    }
  }

  /**
   * Close the shell `tab create` opened the tab on, leaving the agent alone in
   * it (or, when the agent went elsewhere, leaving an empty tab that herdr
   * then closes itself).
   *
   * The placeholder is found by terminal id, not by the pane id `tab create`
   * reported. Pane ids are positions in a list that compacts every time any
   * pane anywhere in the workspace closes — an agent finishing two tabs over
   * silently renumbers everything after it — while terminal ids are stable for
   * the life of the terminal. Re-resolving immediately before the close is
   * what keeps this from closing some other agent's pane.
   */
  private closeTabPlaceholder(tab: AgentTab): void {
    try {
      const panes = this.runHerdr(['pane', 'list', '--workspace', tab.workspaceId])?.result?.panes;
      const placeholder = Array.isArray(panes)
        ? panes.find((pane: any) => pane?.terminal_id === tab.placeholderTerminalId)
        : undefined;

      // Already gone: the human closed it, or the tab never survived.
      if (typeof placeholder?.pane_id !== 'string') return;

      this.runHerdr(['pane', 'close', placeholder.pane_id]);
    } catch (e: any) {
      // A stranded placeholder costs one idle shell, which is not worth
      // failing an otherwise good activation over.
      console.error(
        `[HerdrBridge] Could not close the placeholder pane in tab ${tab.tabId}: ` +
        `${e?.message ?? String(e)}`
      );
    }
  }

  private initPty(session: HerdrSession, initialPrompt?: string, defaultAgent?: string, mcpServers?: WorkspaceMcpServers): void {
    const agentName = agentNameFor(session.type, session.key);

    // Resolved before anything else happens. An unknown defaultAgent refuses
    // the whole activation (KAN-53), and it must do so before the workspace is
    // provisioned for an agent that will never exist. The refusal travels as
    // spawnError — the same channel a spawn herdr refused uses — so activate
    // answers `success: false` with the message naming the valid launchers.
    let launcher: AgentLauncher;
    let launcherName: string;
    try {
      ({ name: launcherName, launcher } = resolveLauncher(defaultAgent));
    } catch (e: any) {
      session.spawnError = e?.message ?? String(e);
      session.status = 'terminated';
      console.error(`[HerdrBridge] Refusing to start ${agentName}: ${session.spawnError}`);
      return;
    }

    // Recorded on the session because the question outlives this call: the
    // activation-confirmation path needs to know whether "no runtime behind
    // the pane" means "not an agent" (every real launcher) or "working as
    // asked" (`shell`).
    session.expectsRuntime = launcherName !== 'shell';

    // Workspace-scoped MCP config, written for every agent type: Claude picks
    // up .mcp.json from its cwd, and the file documents the workspace either way.
    // This is the only place the daemon can put it where the agent's *own* MCP
    // server process will see it: everything else about a spawn goes through
    // herdr, and herdr's agent is a child of the herdr daemon rather than of
    // anything this method spawns.
    //
    // ALREADY STAMPED, ALREADY MATERIALISED, AND NEITHER IS THIS METHOD'S JOB
    // ANY MORE (KAN-398). `mcpServers` arrives as `WorkspaceMcpServers`, which
    // is the type's whole point: `withWorkspaceIdentity` (KAN-145) and
    // `materializeMcpServers` (KAN-157) ran above the runtime seam, in
    // `MessageRouter`, so the second runtime cannot omit what this one used to
    // remember. What was here was not wrong — it was unshareable, and
    // `CrabCastRuntime` duly shipped without it.
    //
    // The unusable-server refusal moved with them, to the same place and for a
    // harder reason: `materializeMcpServers` STRIPS `unusable`, so a refusal
    // check standing here would now read an empty list on every activation —
    // green forever, and green because it can no longer see the field it tests.
    // See `MessageRouter.refuseUnusableMcpServers` for the check and for
    // KAN-157's argument, which is unchanged. Its one behavioural difference is
    // recorded there.
    //
    // `writeWorkspaceMcpConfig` still runs `materializeMcpServers` itself and
    // that is deliberate rather than redundant: it is idempotent, and it is
    // also the entry point the proof scripts write a plain assembly through.
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      writeWorkspaceMcpConfig(session.workDir, mcpServers);
    }

    // Agent-specific provisioning, also on every activation: it is idempotent,
    // and a workspace reset out from under a live herdr agent would otherwise
    // never get its settings back. A setup that throws refuses the activation
    // (KAN-54): provisioning that demonstrably did not stick — the folder
    // trust entry above all — would otherwise spawn an agent wedged on a
    // startup dialog behind a `success: true, verified: true` answer.
    if (launcher.setup) {
      try {
        launcher.setup(session.workDir, mcpServers ?? {});
      } catch (e: any) {
        session.spawnError = e?.message ?? String(e);
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${agentName}: ${session.spawnError}`);
        return;
      }
    }

    // The brief is part of the activation (KAN-84). This write used to
    // log-and-fall-through on failure, so the agent booted with no
    // instructions and the activation still answered `success: true,
    // verified: true` — verified proves a live runtime exists, not that it
    // was instructed, and an agent with no brief burns its budget discovering
    // that or improvises one. A workspace that cannot hold its own brief is
    // not a workspace an agent can work in, so a write that fails past the
    // transient-error retry refuses through the same channel as the refusals
    // above. When there is no initialPrompt (resumes, launchers without
    // briefs) there is nothing to write and nothing to refuse over.
    if (initialPrompt) {
      // Through `workspaceBrief`, not a join of its own: this is the write that
      // `briefLocation` above promises an agent, and KAN-400 is the ticket about
      // those two coming apart. One expression, two readers.
      const promptFile = workspaceBrief(session.workDir).path;
      let writeError: string | undefined;
      for (let attempt = 1; attempt <= PROMPT_WRITE_ATTEMPTS; attempt++) {
        try {
          fs.writeFileSync(promptFile, initialPrompt);
          writeError = undefined;
          break;
        } catch (e: any) {
          writeError = e?.message ?? String(e);
          console.error(
            `[HerdrBridge] Prompt-file write ${attempt}/${PROMPT_WRITE_ATTEMPTS} for ` +
            `${agentName} failed: ${writeError}`
          );
          if (attempt < PROMPT_WRITE_ATTEMPTS) sleepSync(PROMPT_WRITE_RETRY_MS);
        }
      }
      if (writeError !== undefined) {
        session.spawnError =
          `Could not write the agent's initial prompt to ${promptFile} ` +
          `(retried; ${PROMPT_WRITE_ATTEMPTS} attempts): ${writeError}. ` +
          `Nothing was started — an agent spawned without its brief would run uninstructed.`;
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${agentName}: ${session.spawnError}`);
        return;
      }
    }

    // Whether to spawn is decided by what is *behind* the name, not by whether
    // the name is taken. herdr keeps a name registration for any pane it ever
    // started an agent into — including panes restored after a reboot as bare
    // shells with nothing running in them — so `herdr agent get` answering is
    // not evidence of an agent. The record's inner `agent` field is: it is
    // herdr's report of a live runtime in the pane, the same field
    // listHerdrAgentsChecked surfaces as agentRuntime and list_agents uses to
    // split agents from unbackedPanes. Reading mere registration as existence
    // skipped the launcher, attached this session to a dead prompt, and still
    // answered `verified: true` (KAN-58).
    let agentExists = false;
    let staleRecord: any;
    try {
      const record = this.runHerdr(['agent', 'get', agentName])?.result?.agent;
      if (record) {
        const backed = typeof record.agent === 'string' && record.agent !== '';
        if (backed || !session.expectsRuntime) agentExists = true;
        else staleRecord = record;
      }
    } catch (e) {
      // `agent_not_found` — the ordinary fresh start — and "herdr did not
      // answer" both land here, and both take the spawn path: for the second,
      // the spawn itself will surface herdr's error through spawnError rather
      // than this probe guessing at it.
    }

    // A stale registration blocks both roads: `agent start` would refuse the
    // taken name, and attaching would type at a dead shell. Release it the way
    // deactivate does — closing the pane drops the registration — so the
    // launcher actually runs. A release herdr refuses stops the activation
    // here: carrying on would hit AGENT_NAME_TAKEN and fall into the attach
    // path, which is the very false success this branch exists to prevent.
    if (staleRecord) {
      console.log(
        `[HerdrBridge] ${agentName} is a herdr name registration with no agent behind it ` +
        `(pane ${staleRecord.pane_id ?? 'unknown'}, status ${staleRecord.agent_status ?? 'unknown'}); ` +
        `closing the stale pane and taking the spawn path`
      );
      try {
        if (typeof staleRecord.pane_id === 'string' && staleRecord.pane_id) {
          this.runHerdr(['pane', 'close', staleRecord.pane_id]);
        }
      } catch (e: any) {
        const code = (e as HerdrCliError)?.herdrCode;
        // Already gone is the outcome we wanted, not a failure.
        if (code !== PANE_NOT_FOUND && code !== AGENT_NOT_FOUND) {
          session.spawnError =
            `Agent name '${agentName}' is held by a stale herdr registration with no agent ` +
            `running behind it, and the stale pane could not be closed: ${e?.message ?? String(e)}. ` +
            `Nothing was started.`;
          session.status = 'terminated';
          console.error(`[HerdrBridge] Refusing to activate ${agentName}: ${session.spawnError}`);
          return;
        }
      }
    }

    if (!agentExists) {
      // What the agent is told when there is no conversation to continue. On a
      // resume with nothing on disk that must not be the cold-start prompt: an
      // agent greeted as if it were starting fresh would claim its ticket and
      // begin again, silently redoing — or conflicting with — work it had
      // already committed. See resume.ts.
      const fallbackPrompt =
        session.resume && session.resumedConversation === false
          ? degradedResumePrompt(
              session.type,
              session.key,
              this.briefLocation(session.type, session.key),
              session.resume
            )
          : undefined;

      // The last daemon-side moment to look (KAN-54). Between setup and here
      // sit the prompt-file write and a subprocess round-trip to `herdr agent
      // get` — real time, in which a sibling claude's boot write-back can
      // erase the trust entry setup just verified. Re-checking now shrinks
      // the unguarded window to spawn-to-config-read, which is as small as it
      // gets without watching the agent past its startup dialogs (deferred by
      // KAN-49). A clobber that will not repair refuses the activation on the
      // spawnError channel rather than starting a wedged agent.
      if (launcher.preSpawnCheck) {
        try {
          launcher.preSpawnCheck(session.workDir);
        } catch (e: any) {
          session.spawnError = e?.message ?? String(e);
          session.status = 'terminated';
          console.error(`[HerdrBridge] Refusing to spawn ${agentName}: ${session.spawnError}`);
          return;
        }
      }

      try {
        // The pane inherits the herdr *server's* environment, not ours — and
        // that server is typically started at login with a thin PATH (no
        // nvm). Inject the daemon's normalized PATH so the agent and every
        // MCP server it spawns resolve the same tools we do. argv-level
        // `env` avoids shell quoting entirely.
        //
        // Routed through runHerdr so a refusal is raised rather than dropped.
        // This call used to be a bare spawnSync whose result was discarded, so
        // a failed spawn was indistinguishable from a successful one: we went
        // straight on to attach to an agent that did not exist, and the
        // session was reported active. That is the silent false success in
        // KAN-24, and the reason `ghostty error -2` read as a mystery.
        //
        // RESUME_ENV rides in on the same `env` invocation. It raises the two
        // thresholds behind Claude Code's "Resume from summary / Resume full
        // session" prompt, which otherwise appears whenever a resumed
        // conversation is both over 70 minutes old and over 100k tokens — the
        // exact shape of an agent that has been working all afternoon, and a
        // hard stop for one with nobody at the keyboard. It is set on every
        // spawn, not only on resumes: the launcher tries `--continue` first
        // every time, so any re-activation can meet that modal.
        //
        // `spawnedAt` is read BEFORE the spawn and handed to the channel-startup
        // watcher below, which uses it to tell this session's MCP server
        // connection from the previous one's. Taken here rather than after the
        // call because `herdr agent start` returns once the pane exists — the
        // agent's own boot, and therefore its server's registration, happens
        // after that return, so a timestamp read afterwards would still be
        // before every connection that matters while being needlessly later
        // than the only one it has to exclude.
        //
        // Composed once and kept, rather than called inline in the argv below:
        // the listener needs the very spawn that was made, and
        // `launcher.command()` reads the channel switch off disk on every call,
        // so calling it twice could hand the watcher a different command from the
        // one running in the pane.
        //
        // `channelEnabled` comes out of THIS call for the same reason, and that
        // is the whole of KAN-294's half of it: the verdict and the command it
        // produced are one return value, so there is no edit to this file that
        // can supervise a channel decision the pane did not make.
        const spawnedAt = Date.now();
        const { command, channelEnabled } = launcher.command(fallbackPrompt);
        this.startAgentInOwnTab(agentName, session.workDir, [
          'env',
          `PATH=${process.env.PATH}`,
          ...Object.entries(RESUME_ENV).map(([name, value]) => `${name}=${value}`),
          'bash', '-c', command
        ]);

        // A pane we just started, and the only branch that reaches here. The
        // attach path below is deliberately excluded: an agent that already
        // existed did not run a launcher, so there is no startup dialog of ours
        // in front of it and nothing to answer.
        //
        // NOT AWAITED, AND THAT IS THE UNCOMFORTABLE HALF OF THIS DESIGN. initPty
        // is synchronous from resolveLauncher to the spawn on purpose (no await
        // for another activation to interleave into), and the caller's caller is
        // an `activate` whose MCP client gives it 30 seconds — while a fresh
        // workspace has to answer two full-screen dialogs, fail a `--continue`,
        // boot a second `claude` and spawn an MCP server. Blocking the response
        // on all of that would trade a wedged agent for a timed-out activation
        // and tell the caller less. So the activation still answers on herdr's
        // own evidence, and this watches afterwards and says what it saw.
        //
        // WHAT THAT COSTS, SAID RATHER THAN LEFT TO BE FOUND: `activate` can
        // answer `success: true, verified: true` for an agent that is sitting on
        // an unanswered dialog and will never reach its prompt. `verified` has
        // always meant "a live runtime is behind the pane" (KAN-58) and a
        // `claude` rendering a dialog is exactly that, so this is not a new lie —
        // but it is a new way for the old one to matter, and the daemon log is
        // where the truth lands. See channel-startup.ts.
        //
        // Its own try/catch because it sits inside the spawn's: a listener that
        // threw would otherwise be diagnosed as a failed `herdr agent start` and
        // terminate a session whose agent is running perfectly well.
        try {
          this.agentSpawnedListener?.(session, spawnedAt, { channelEnabled, command });
        } catch (e: any) {
          console.error(
            `[HerdrBridge] Agent-spawned listener for ${agentName} threw; the agent is ` +
            `unaffected: ${e?.message ?? String(e)}`
          );
        }
      } catch (e: any) {
        if ((e as HerdrCliError)?.herdrCode === AGENT_NAME_TAKEN) {
          // Someone created it between our check and our start. Attach to it.
          console.log(`[HerdrBridge] Agent ${agentName} already existed; attaching to it`);
        } else {
          session.spawnError = diagnoseSpawnFailure(e?.message ?? String(e));
          // 'terminated' rather than 'active': there is no agent to attach to,
          // and a session left active would advertise a terminal that can never
          // produce output.
          session.status = 'terminated';
          console.error(
            `[HerdrBridge] Could not start herdr agent ${agentName}: ${session.spawnError}`
          );
          return;
        }
      }
    }

    // `--takeover` evicts whoever already holds this agent's terminal attach,
    // and the evicted client is killed outright — which is exactly how a live
    // sidepanel froze. The guard in spawnSession is what actually prevents
    // that, so by the time we get here nothing of ours is attached and this
    // resolves to true; it is kept as a second line of defence for any future
    // caller that reaches initPty another way, and because the log line below
    // is the record of which attach asked for what.
    //
    // Taking over remains right when the incumbent is not ours: an attach
    // orphaned by a daemon that died without cleaning up would otherwise
    // strand the agent unreachable forever.
    const takeover = !this.liveAttachFor(agentName);
    const attachArgs = ['agent', 'attach', agentName, ...(takeover ? ['--takeover'] : [])];
    console.log(
      `[HerdrBridge] Attaching session ${session.sessionId} to ${agentName} ` +
      `(takeover=${takeover}): herdr ${attachArgs.join(' ')}`
    );

    try {
      // No BUTCHR_WORKSPACE_TYPE/_KEY here, deliberately, and the deletion is
      // the KAN-145 fix as much as the stamping above is. This PTY runs
      // `herdr agent attach` — a *client* of a pane the herdr daemon already
      // holds the agent in. The agent, and the MCP server the agent spawns, are
      // children of the herdr daemon and inherit its environment; nothing
      // downstream of this process ever read these variables, which is why
      // every agent came back parentless while `mcp.ts` dutifully read them.
      // The identity now travels in the workspace's own .mcp.json instead.
      const ptyProcess = pty.spawn('herdr', attachArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: session.workDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        } as Record<string, string>
      });

      session.ptyProcess = ptyProcess;

      ptyProcess.onData((data: string) => {
        session.ptyBuffer = (session.ptyBuffer + data).slice(-100000);
        session.onDataListeners.forEach(fn => fn({ kind: 'data', data }));
      });

      ptyProcess.onExit(({ exitCode }) => {
        // herdr's parting line is the only place the cause is recorded, so
        // read it off the buffer before anything else claims the exit.
        const tail = session.ptyBuffer.slice(-EXIT_REASON_SCAN_CHARS);
        const reason: SessionEndReason = tail.includes(TAKEOVER_NOTICE) ? 'taken-over' : 'exited';

        console.log(
          `[HerdrBridge] PTY for session ${session.sessionId} (${agentName}) ` +
          `exited with code ${exitCode}; reason=${reason}`
        );
        session.status = 'terminated';

        // Tell the clients. Without this the sidepanel keeps rendering the
        // last frame it received and looks like an agent that is merely quiet.
        this.sessionEndedListener?.({
          type: session.type,
          key: session.key,
          sessionId: session.sessionId,
          reason,
          exitCode
        });
      });
    } catch (e: any) {
      // No PTY means no attach: leaving the session 'active' would make
      // liveAttachFor claim an attach that does not exist, and every later
      // activate would be refused in favour of this dead session.
      session.status = 'terminated';
      // And recorded as a spawn failure, because that is what the caller has
      // to be told. Marking the session terminated without it produced the
      // second false success in KAN-23: activate checks `spawnError` alone, so
      // an attach that threw was answered with `success: true` and, in the
      // same object, `status: "terminated"` — a response that contradicted
      // itself and a session id that could never carry any output. The agent
      // itself may well be running; what failed is our route to it, and the
      // message says so rather than claiming nothing started.
      session.spawnError =
        `Agent '${agentName}' could not be attached to: ${e?.message ?? String(e)}. ` +
        `The agent may be running in herdr, but this activation produced no usable terminal.`;
      console.error('[HerdrBridge] Failed to spawn PTY', e);
    }
  }

  public getSession(sessionId: string): HerdrSession | undefined {
    return this.sessions.get(sessionId);
  }

  public getSessionByKey(key: string): HerdrSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.key === key && session.status === 'active') {
        return session;
      }
    }
    return undefined;
  }

  public listActiveSessions(): HerdrSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }

  /**
   * Every agent herdr knows about. herdr is an optional external binary, so an
   * unavailable, slow, or unparseable herdr yields an empty list: callers
   * degrade rather than fail.
   *
   * An empty list therefore means "herdr told us nothing", which is not the
   * same claim as "there are no agents" — callers that report to a human must
   * not turn one into the other.
   */
  public listHerdrAgents(): HerdrAgentRecord[] {
    return this.listHerdrAgentsChecked().agents;
  }

  /**
   * The same census as {@link listHerdrAgents}, but saying whether herdr
   * actually answered.
   *
   * Both facts come out of one `herdr agent list`, on purpose. A caller that
   * needs to know "is this agent still there?" has to distinguish an absent
   * name from an absent herdr, and asking that as a second call would let herdr
   * die between the two — producing exactly the false verdict the distinction
   * exists to prevent. `reachable: false` means the list below is silence, not
   * evidence, and nothing may be declared dead on the strength of it.
   *
   * ## The row filter had the KAN-324 defect too, and now discloses
   *
   * The `.filter` below drops any row without a usable `name`, and until KAN-324
   * it dropped them **silently** — the same shape the ticket was filed about on
   * CrabCast's side, one layer up and in our own code. herdr publishes no
   * disclosure of its own, so the count is this method's: it is the rows this
   * bridge threw away, counted where they are thrown away.
   *
   * **`null` where the census was not taken, never `0`.** A herdr that did not
   * answer skipped nothing *and read nothing*, so `0` there would be a claim
   * about a census that never happened.
   */
  public listHerdrAgentsChecked(): CensusReading {
    /** No census, therefore no disclosure. `0` would be a claim about a read that did not occur. */
    const unread: CensusReading = {
      reachable: false,
      agents: [],
      unreadableRecordsTotal: null,
      unreadableRecords: []
    };

    let output: string;
    try {
      output = execSync('herdr agent list', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      return unread;
    }

    try {
      const rows = JSON.parse(output)?.result?.agents;
      if (!Array.isArray(rows)) return unread;

      const agents: HerdrAgentRecord[] = [];
      const unreadable: CensusUnreadableRecord[] = [];

      rows.forEach((agent: any, index: number) => {
        if (!agent || typeof agent.name !== 'string') {
          unreadable.push({
            source: 'herdr-census',
            // `herdr agent list` is a JSON array, not a line-oriented registry,
            // so the position in that array is the only locator there is.
            line: index + 1,
            problem: 'no-name',
            identity: null,
            reason:
              'this row carried no string `name`, and a census row without one cannot be ' +
              'addressed, tailed or supervised. Naming it would be inventing the one value ' +
              'that identifies it.',
            // `claimsPath` is CrabCast's registry field and herdr has no
            // counterpart: `herdr agent list` is a JSON array of panes, not a
            // registry of rows that name directories. `null` here is the same
            // `null` the wire uses — this source named none.
            claimsPath: null,
            // And the v7 group is refused outright rather than reported as
            // three nulls. herdr has no registry line, no event vocabulary and
            // no verdict it could render, so `source-does-not-disclose` says
            // that in its own words rather than borrowing a version complaint
            // from a peer that is not on this leg at all.
            standing: {
              available: false,
              because: 'source-does-not-disclose',
              peerContractVersion: null
            },
            supersession: null
          });
          return;
        }
        agents.push({
          name: agent.name as string,
          agentRuntime: typeof agent.agent === 'string' && agent.agent ? agent.agent : null,
          workDir: typeof agent.cwd === 'string' ? agent.cwd : null,
          herdrStatus: toAgentStatus(agent.agent_status)
        });
      });

      return {
        reachable: true,
        agents,
        unreadableRecordsTotal: unreadable.length,
        unreadableRecords: unreadable
      };
    } catch (e) {
      console.error('[HerdrBridge] Could not parse `herdr agent list` output', e);
      return unread;
    }
  }

  /**
   * Does this agent exist? Asked after a spawn, before anyone is told the
   * activation succeeded.
   *
   * A spawn herdr refuses is reported through `spawnError`, and that covers
   * only the failures herdr *tells* us about. The failure this exists for is
   * the other one: herdr acknowledges the start and no agent is there
   * afterwards — the KAN-23 false success, where `success: true` and a
   * plausible session id were returned for an agent that never existed. The
   * response is a factual claim about the world, so it is checked against the
   * world before it is made.
   *
   * The world here is {@link listHerdrAgentsChecked} — the same census
   * `list_agents` reports from, deliberately, so that activate and the fleet
   * list can never disagree about whether an agent exists.
   *
   * `requireRuntime` is what "exists" means. herdr's census lists every name
   * registration, including panes that are bare shells with no agent process
   * behind them — the entries list_agents reports as unbackedPanes — so for
   * any launcher that delivers a runtime, presence-by-name is not presence.
   * The agent is confirmed only when the census shows a runtime behind the
   * pane, which is why `verified: true` can no longer be answered off a name
   * that survived its agent (KAN-58). `false` is for `shell` workspaces,
   * where the name is all there is to see.
   *
   * Bounded by `timeoutMs` of polling: the wait cannot exceed it, and the last
   * census in flight is itself capped by the 5s timeout inside
   * listHerdrAgentsChecked, so the whole call is bounded by the two added
   * together. It never throws — a caller owes its client an answer.
   */
  public async confirmAgentPresent(
    agentName: ButchrAgentName,
    requireRuntime: boolean,
    timeoutMs: number = requireRuntime ? RUNTIME_CONFIRM_TIMEOUT_MS : AGENT_CONFIRM_TIMEOUT_MS
  ): Promise<AgentPresence> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let checks = 0;
    let reachable = false;
    let registered = false;

    for (;;) {
      const census = this.listHerdrAgentsChecked();
      checks++;
      reachable = census.reachable;

      if (reachable) {
        const record = census.agents.find(agent => agent.name === agentName);
        registered = record !== undefined;
        if (record && (!requireRuntime || record.agentRuntime !== null)) {
          return { present: true, waitedMs: Date.now() - startedAt, checks };
        }
      }

      if (Date.now() + AGENT_CONFIRM_POLL_MS >= deadline) break;
      await delay(AGENT_CONFIRM_POLL_MS);
    }

    const waitedMs = Date.now() - startedAt;
    // Which of the two failures this is turns on whether herdr answered at
    // all. An unreachable herdr produces an empty census, and reading that as
    // "the agent is not there" would be the same mistake in the other
    // direction: a confident claim with nothing behind it.
    return reachable
      ? {
          present: false,
          reason: 'absent',
          waitedMs,
          checks,
          error: registered
            ? `herdr has a pane registered under '${agentName}' but reported no agent runtime ` +
              `behind it for ${waitedMs}ms (${checks} checks): the pane is a shell, not a ` +
              `running agent. The launcher's command never became a live agent process. ` +
              `Check ~/.config/herdr/herdr-server.log and the pane itself for what it printed.`
            : `herdr reported no error starting agent '${agentName}', but the agent was not in ` +
              `\`herdr agent list\` ${waitedMs}ms and ${checks} checks later. No agent is running ` +
              `for this activation. Check ~/.config/herdr/herdr-server.log for the pane.spawn line ` +
              `covering this attempt.`
        }
      : {
          present: false,
          reason: 'unverifiable',
          waitedMs,
          checks,
          error:
            `Could not confirm agent '${agentName}' exists: herdr did not answer ` +
            `\`agent list\` within ${waitedMs}ms (${checks} attempts). The agent may or may not ` +
            `be running — this is an unverified activation, not a failed one, and nothing has ` +
            `been torn down. Check that the herdr server is up before retrying.`
        };
  }

  /**
   * Give up on a session whose agent is known not to exist.
   *
   * Without this the failure is sticky rather than merely reported: a session
   * left `active` is what {@link getSessionByAddress} and {@link liveAttachFor}
   * answer with, so the next activate would be handed this dead session and
   * refuse to spawn a real one — the caller could never retry its way out.
   *
   * The pane is deliberately *not* closed. This is only ever called when herdr
   * has told us there is no such agent, so there is nothing to close; and
   * calling it on weaker evidence must not destroy somebody's working agent.
   * Our own terminal attach is killed because it is ours and it leads nowhere.
   */
  public abandonSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.spawnError = error;
    session.status = 'terminated';
    try {
      session.ptyProcess?.kill();
    } catch (e) {
      console.error(`[HerdrBridge] Could not kill the PTY for abandoned session ${sessionId}`, e);
    }
  }

  /**
   * Whether herdr's server is up and answering.
   *
   * {@link listHerdrAgents} deliberately flattens "herdr said nothing" and
   * "herdr has no agents" into an empty list, which is right for a status
   * display and wrong for boot-time reconciliation: there, the two answers lead
   * to opposite actions — wait, or start the whole fleet. This is the question
   * that separates them, and it is asked as its own call rather than by
   * changing what listHerdrAgents returns, so no existing caller has to think
   * about a new empty-ish value.
   */
  public herdrReachable(): boolean {
    try {
      this.runHerdr(['agent', 'list']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The same view as {@link listHerdrAgents}, keyed by name, for callers that
   * only want to decorate something they already have with a status.
   */
  public listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    return new Map(this.listHerdrAgents().map(agent => [agent.name, agent.herdrStatus]));
  }

  /**
   * One herdr CLI call, argv-level so nothing we pass through (agent names,
   * arbitrary message text) is ever handed to a shell. Returns herdr's parsed
   * JSON and throws with herdr's own message on failure — herdr reports errors
   * as a nonzero exit plus an `error` object, on stdout for some commands and
   * on stderr for others, so both streams are worth reading before we fall
   * back to quoting a raw payload at the caller.
   */
  private runHerdr(args: string[]): any {
    const result = spawnSync('herdr', args, {
      encoding: 'utf8',
      timeout: HERDR_CLI_TIMEOUT_MS
    });

    if (result.error) {
      throw new Error(`herdr ${args.join(' ')} failed: ${result.error.message}`);
    }

    const stdout = (result.stdout ?? '').trim();
    const stderr = (result.stderr ?? '').trim();
    const json = parseJson(stdout);

    const reported = json?.error ?? parseJson(stderr)?.error;
    if (reported) {
      const error: HerdrCliError =
        new Error(reported.message ?? `herdr reported ${reported.code ?? 'an error'}`);
      // herdr's machine-readable code, kept alongside the message so callers
      // can distinguish kinds of failure without matching on prose.
      if (typeof reported.code === 'string') error.herdrCode = reported.code;
      throw error;
    }
    if (result.status !== 0) {
      throw new Error(stderr || `herdr ${args.join(' ')} exited with code ${result.status}`);
    }

    return json;
  }

  /**
   * The herdr agent behind a workspace key. The in-memory session map is the
   * fast path, but it dies with the daemon while the herdr pane outlives it —
   * so fall back to matching herdr's own agent list, which is the case that
   * matters most here (messaging an agent that has been running a while).
   */
  private resolveAgentName(key: string): string {
    // All sessions on the key, not the first (getSessionByKey): two types can
    // hold one key at once (KAN-83), and a bare key naming two agents must be
    // refused here exactly as the herdr-list fallback below refuses it —
    // silently picking one would deliver someone's message, close, or reset
    // to whichever agent happened to be created first.
    const sessionNames = this.listActiveSessions()
      .filter(session => session.key === key)
      .map(session => agentNameFor(session.type, session.key));
    if (sessionNames.length > 1) {
      throw new Error(`Key '${key}' is ambiguous; it matches agents: ${sessionNames.join(', ')}`);
    }
    if (sessionNames.length === 1) return sessionNames[0];

    const suffix = `-${key.toLowerCase()}`;
    const matches = Array.from(this.listHerdrStatuses().keys())
      .filter(name => name.startsWith('butchr-') && name.endsWith(suffix));

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Key '${key}' is ambiguous; it matches herdr agents: ${matches.join(', ')}`);
    }
    throw new Error(`No agent found for key '${key}'`);
  }

  /**
   * The agent named by an address. A caller that knows the workspace type
   * names the agent exactly, which is the only unambiguous form when several
   * types share a key; a bare key keeps the resolve-by-suffix fallback.
   */
  private agentNameForAddress(key: string, type?: string): string {
    const trimmedType = typeof type === 'string' ? type.trim() : '';
    return trimmedType ? agentNameFor(trimmedType, key) : this.resolveAgentName(key);
  }

  /**
   * The workspace address behind a caller's `key` and optional `type`.
   *
   * WHY THIS EXISTS (KAN-247, T4 of KAN-150)
   *
   * `butchr_send_to_agent` now has two carriers, and they are addressed
   * differently: the composer reaches a herdr *pane*, and the channel reaches a
   * *connection* in KAN-243's identity map, which is keyed by type **and** key.
   * A caller may still omit the type, so something has to supply one before the
   * channel can be consulted at all.
   *
   * **The danger is two resolutions that disagree.** If the channel resolved a
   * bare key its own way, `KAN-1` could route to `story/KAN-1` over a channel
   * while the composer would have typed into `task/KAN-1` — the same call
   * reaching two different agents depending on a carrier the caller cannot see.
   * That is the transport becoming visible in the worst possible way, and
   * design §5.1's rule (*the daemon decides; the agent never infers*) is only
   * honest if both carriers mean the same agent.
   *
   * So this reuses {@link resolveAgentName} rather than re-deriving anything —
   * one rule, one place — and inverts {@link agentNameFor} to recover the type.
   * The inversion is asserted rather than assumed: a name that does not have
   * the shape `agentNameFor` produces means the two have drifted, and guessing
   * a type from a name we do not recognise is how a message reaches the wrong
   * agent. Throws for the same reasons `resolveAgentName` throws — no agent, or
   * an ambiguous key — so a bare key that is unaddressable stays unaddressable
   * and does not silently become a channel send to somebody.
   *
   * **The key is returned as the caller spelled it**, not lower-cased. The
   * connection map canonicalises on its own (`agent-connections.ts`), and the
   * composer path has always taken the caller's spelling; normalising here
   * would change what `sendToAgent` receives for no benefit this ticket needs.
   */
  public resolveAddress(key: string, type?: string): { type: string; key: string } {
    const trimmedType = typeof type === 'string' ? type.trim() : '';
    if (trimmedType) return { type: trimmedType, key };

    const name = this.resolveAgentName(key);
    const prefix = 'butchr-';
    const suffix = `-${key.toLowerCase()}`;
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) {
      throw new Error(
        `Resolved agent '${name}' for key '${key}' is not spelled the way agentNameFor spells one, ` +
          'so its workspace type cannot be recovered; name the type explicitly.'
      );
    }
    return { type: name.slice(prefix.length, name.length - suffix.length), key };
  }

  /**
   * The session for an address, if this daemon owns one. An explicit type has
   * to match: a session for a different type is a different agent, and
   * answering with it would silently ignore the address the caller gave.
   *
   * Searched by (key, type) directly, not by filtering getSessionByKey's
   * answer. Two types legitimately hold the same key at once (KAN-83), and
   * key-first would only ever see whichever session was created first — the
   * other type's session would exist and be unaddressable.
   */
  public getSessionByAddress(key: string, type?: string): HerdrSession | undefined {
    const trimmedType = typeof type === 'string' ? type.trim() : '';
    if (!trimmedType) return this.getSessionByKey(key);
    for (const session of this.sessions.values()) {
      if (session.key === key && session.type === trimmedType && session.status === 'active') {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Ask herdr directly about an agent. This is the answer for a key whose
   * session died with a previous daemon: the pane outlives us, so its status
   * and cwd are still there to be read. Throws when herdr has no such agent.
   */
  public describeAgent(key: string, type?: string): HerdrAgentDescription {
    const agentName = this.agentNameForAddress(key, type);
    const agent = this.runHerdr(['agent', 'get', agentName])?.result?.agent;
    if (!agent) {
      throw new Error(`No agent found for key '${key}'`);
    }

    return {
      agentName,
      type: typeFromAgentName(agentName, key) ?? null,
      workDir: typeof agent.cwd === 'string' ? agent.cwd : null,
      herdrStatus: toAgentStatus(agent.agent_status)
    };
  }

  /**
   * The tail of an agent's terminal, as plain text.
   *
   * NEVER REPORTS ABSENCE OFF A SINGLE READ. Both sources in {@link
   * TAIL_SOURCES} are asked before this returns an empty string, because one of
   * them answers `""` for a live pane that plainly has text on it — see that
   * constant for the measurement and the exact boundary. An empty answer from
   * ONE source is evidence about the source, not about the pane.
   *
   * The three outcomes are kept apart in the SHAPE rather than in prose, since
   * the defect this replaces was precisely that two of them were the same
   * value:
   *
   *   * TEXT — `success: true`, `text` non-empty, `source` naming who answered.
   *   * GENUINELY EMPTY — `success: true`, `text: ''`, `source: null`, with
   *     `sourcesTried` listing both. The pane was read and there is nothing on
   *     it. That is a real answer about the agent.
   *   * COULD NOT LOOK — `success: false` with `error`. No claim about the pane
   *     is made or may be inferred.
   *
   * `source: null` with `success: true` is therefore the assertion "both of
   * these were asked and both said nothing", and a caller that treats an empty
   * pane as meaningful — `superviseChannelStartup` and `readLandedCount` both
   * do — is entitled to it only because of that.
   *
   * Never throws; the caller owes its client a response. As an `async` method
   * that means it never *rejects* either — every path below returns a value.
   *
   * ## `async` WITHOUT AN `await` IN IT, AND THAT IS DELIBERATE (KAN-283)
   *
   * Every read here is a `spawnSync`, so this body does no waiting and could
   * still be synchronous. It is `Promise`-returning because {@link
   * AgentRuntime.tailAgent} is, and that interface went async for the runtime
   * that answers over a socket — see its docblock. **The `async` keyword is the
   * only change this method received**: not a line of the logic below moved, so
   * the value an awaiting caller observes is the value the synchronous version
   * returned, and the resolution lands on the first microtask rather than after
   * any I/O. `verify-tail-async-awaited.mjs` §1 asserts that equivalence
   * against the built module rather than leaving it as a claim in a comment.
   */
  public async tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): Promise<{
    success: boolean;
    text?: string;
    truncated?: boolean;
    /** Which source the text came from; null when every source was asked and every one was empty. */
    source?: TailSource | null;
    /** Every source asked, in order, so "we looked twice" is auditable rather than trusted. */
    sourcesTried?: TailSource[];
    error?: string;
  }> {
    const wanted = clampTailLines(lines);
    const tried: TailSource[] = [];
    const answeredEmpty: TailSource[] = [];
    let firstError: string | undefined;

    // RESOLVED ONCE, OUTSIDE THE LOOP. A bare key costs a `herdr agent list` to
    // resolve, and asking two sources must not double that — a tail runs on
    // every poll of the delivery-confirmation loop. Failing to resolve is a
    // "could not look" before any source has been asked, so `sourcesTried` is
    // empty and says so rather than implying a read that never happened.
    let agentName: string;
    try {
      agentName = this.agentNameForAddress(key, type);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to tail agent for key '${key}':`, error);
      return { success: false, error, sourcesTried: [] };
    }

    for (const source of TAIL_SOURCES) {
      tried.push(source);
      try {
        const read = this.runHerdr([
          'agent', 'read', agentName,
          '--source', source,
          '--format', 'text',
          '--lines', String(wanted)
        ])?.result?.read;

        if (!read || typeof read.text !== 'string') {
          throw new Error(`herdr returned no readable output for agent '${agentName}'`);
        }

        // An empty string is a string, which is exactly how the single-source
        // version reported a pane it had not really seen. Keep asking.
        if (read.text.length === 0) {
          answeredEmpty.push(source);
          continue;
        }

        return {
          success: true,
          // `visible` ignores --lines, so it is held to what was asked for.
          text: source === 'visible' ? lastLines(read.text, wanted) : read.text,
          truncated: read.truncated === true,
          source,
          sourcesTried: [...tried]
        };
      } catch (e: any) {
        // A source that FAILS is not a source that said "empty". Remember the
        // first failure and let the next source try: herdr answering one read
        // and refusing another is a state we have seen, and the pane is
        // readable if either of them answers.
        if (firstError === undefined) firstError = e?.message ?? String(e);
      }
    }

    // "Empty" is only ever asserted when EVERY source was asked AND ANSWERED.
    // One refusal is enough to make this a read we could not trust — reporting
    // it as an empty pane would be the original defect wearing the fallback's
    // clothes, and it is the shape `probe-channel-launch.mjs` walked into when
    // it collapsed a failed `tail_agent` into `''` and printed "pane reads
    // EMPTY" over it.
    if (answeredEmpty.length !== TAIL_SOURCES.length) {
      const unread = tried.filter((s) => !answeredEmpty.includes(s));
      const error =
        `Could not establish what is on agent '${agentName}': ` +
        `${firstError ?? 'a source failed to answer'}. ` +
        (answeredEmpty.length
          ? `${answeredEmpty.join(', ')} answered empty, but ${unread.join(', ')} could not be ` +
            `read, so whether the pane is empty is UNKNOWN rather than confirmed.`
          : 'no source could be read.');
      console.error(`[HerdrBridge] Failed to tail agent for key '${key}':`, error);
      return { success: false, error, sourcesTried: tried };
    }

    // Every source answered, and every one was empty. That is a fact about the
    // agent rather than about the read, and it is said as one.
    return { success: true, text: '', truncated: false, source: null, sourcesTried: tried };
  }

  /**
   * Press one key at an agent's pane. Throws with herdr's own message when the
   * agent, the pane or herdr itself is not there.
   *
   * **This is not a small cousin of {@link sendToAgent} and must not grow into
   * one.** That method opens with a Ctrl+C, which cancels the recipient's turn
   * and abandons any tool call in flight; this sends exactly the key it is given
   * and nothing else. Its one caller (KAN-246) sends `Enter` at a full-screen
   * startup dialog that is blocking the session's own boot — there is no turn to
   * cancel, because the agent has not started one. A caller wanting to *say*
   * something to a running agent wants `sendToAgent` and its cost, or the
   * channel; not this.
   */
  public pressPaneKey(key: string, type: string | undefined, keyName: string): void {
    const agentName = this.agentNameForAddress(key, type);
    const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
    if (typeof paneId !== 'string' || !paneId) {
      throw new Error(`Agent '${agentName}' has no pane to send keys to`);
    }
    this.runHerdr(['pane', 'send-keys', paneId, keyName]);
  }

  /**
   * Close the herdr pane an agent runs in. Returns false when herdr knows the
   * agent but it has no pane (already closed); throws with herdr's own message
   * when herdr is unreachable or does not know the agent at all.
   */
  private closePaneForAgent(agentName: string): boolean {
    const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
    if (typeof paneId !== 'string' || !paneId) return false;

    this.runHerdr(['pane', 'close', paneId]);
    return true;
  }

  /**
   * Tear down the agent behind a workspace address without needing a session.
   * The session map dies with the daemon while the herdr pane outlives it, so
   * both deactivate and reset resolve the agent the same way `sendToAgent`
   * does: exactly, when the caller names a type; through the herdr-list
   * fallback when it does not. Never throws — the caller is a request handler
   * that owes its client a response either way.
   */
  public closeAgentByKey(key: string, type?: string): { success: boolean; agentName?: string; error?: string } {
    let agentName: string;
    try {
      agentName = this.agentNameForAddress(key, type);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Could not resolve an agent for key '${key}':`, error);
      return { success: false, error };
    }

    try {
      if (!this.closePaneForAgent(agentName)) {
        return { success: false, agentName, error: `Agent '${agentName}' has no pane to close` };
      }
      return { success: true, agentName };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to close pane for agent '${agentName}':`, error);
      return { success: false, agentName, error };
    }
  }

  /**
   * Deliver a message to an agent's terminal the way a human would: interrupt,
   * type the message, submit it. Never throws — the caller is a request handler
   * that owes its client a response either way.
   *
   * **The interrupt is destructive, and "clears a half-typed line" is the
   * smallest thing it does.** Ctrl+C at a Claude Code pane cancels the turn in
   * progress — a running tool call included, which is abandoned rather than
   * resumed, and which renders on the recipient's screen as a refusal it may
   * attribute to the human. Callers are choosing to take that from the
   * recipient; the tool description in `mcp.ts` says so to the agents that call
   * it, and this comment says so to whoever reaches for this method next.
   */
  public async sendToAgent(key: string, message: string, type?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const agentName = this.agentNameForAddress(key, type);
      const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
      if (typeof paneId !== 'string' || !paneId) {
        throw new Error(`Agent '${agentName}' has no pane to send to`);
      }

      // Exactly one Ctrl+C. One cancels the recipient's turn — its in-flight
      // tool call with it — which is the cost of this call. A second one is how
      // Claude Code quits, and would kill the very agent we are trying to talk
      // to, which is the cost of getting this wrong.
      this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);
      await delay(INTERRUPT_SETTLE_MS);
      this.runHerdr(['pane', 'send-text', paneId, message]);
      this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);

      return { success: true };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to send message to agent for key '${key}':`, error);
      return { success: false, error };
    }
  }

  /**
   * Delete a workspace directory, and nothing else.
   *
   * **The body of this method moved to `workspace-dir.ts` in KAN-380 and did
   * not change on the way.** The containment discipline it carried — lexical
   * check first, then `realpath` on both sides — is the same code, called from
   * the same place in the same order; what changed is that `CrabCastRuntime`
   * can now call it too, which is the whole of that ticket. The behaviour a
   * caller sees here is byte-identical, and
   * `verify-workspace-reset-boundary.mjs` §2 is what says so rather than this
   * sentence: it drives both runtimes through the same battery and asserts
   * their answers match, refusal texts included.
   */
  public resetWorkspace(type: string, key: string): { success: boolean; error?: string } {
    return deleteWorkspaceDir(type, key);
  }

  /**
   * The PTY entry points, and the one rule they share: a session id this daemon
   * does not hold gets nothing.
   *
   * Every caller here is a client that was handed a session id earlier, so an
   * id we cannot find is a caller bug — most often a sidepanel re-initialising
   * against a daemon that has restarted since the id was issued. All four of
   * these used to fall through to an `ensureDefaultSession()` helper that
   * returned an arbitrary active session, or spawned a `default/workspace`
   * shell when there were none. A stale re-init was answered with somebody
   * else's terminal, or with a phantom agent that then sat in the pane list —
   * and both look like success from the outside, which is how the bug survived
   * unnoticed. See KAN-25.
   *
   * So: `false`/`undefined` means "no such session", and the caller owes its
   * client an error. Nothing in here creates a session as a side effect, and
   * nothing substitutes a different one for the one that was asked for.
   */
  public writePty(sessionId: string | undefined, data: string): boolean {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return false;
    if (session.ptyProcess) {
      session.ptyProcess.write(data);
    }
    return true;
  }

  public resizePty(sessionId: string | undefined, cols: number, rows: number): boolean {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return false;
    if (session.ptyProcess && cols > 0 && rows > 0) {
      try {
        session.ptyProcess.resize(cols, rows);
      } catch (err) {
        // ignore resize errors if process ended
      }
    }
    return true;
  }

  /** The session's replay buffer, or `undefined` when there is no such session. */
  public getPtyBuffer(sessionId: string | undefined): string | undefined {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    return session ? session.ptyBuffer : undefined;
  }

  /**
   * The unsubscribe, or `undefined` when there is no such session to listen to.
   *
   * **This runtime never delivers the `discontinuity` arm and that is correct
   * rather than unimplemented** (KAN-381). The subscription is a `node-pty`
   * callback in this process: nothing can detach it while the process lives,
   * and when the process dies the session ends — which the caller learns from
   * `setSessionEndedListener`, not from a gap. So there is no window here in
   * which output is produced and unseen. The arm exists on the type because
   * {@link CrabCastRuntime}, whose subscription lives across a socket, has
   * exactly such a window.
   */
  public registerDataListener(
    sessionId: string | undefined,
    listener: PtyStreamListener
  ): (() => void) | undefined {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return undefined;
    session.onDataListeners.push(listener);
    return () => {
      session.onDataListeners = session.onDataListeners.filter(l => l !== listener);
    };
  }

  /**
   * Tear down a session and the agent behind it.
   *
   * The result is the outcome, not the attempt. This used to return a bare
   * `true` for any session it had heard of: the pane close was wrapped in a
   * try/catch that logged the failure and swallowed it, so a stand-down herdr
   * had refused — or never received, because the server was down — was
   * answered `success: true` while the agent carried on working. That is the
   * KAN-23 defect on the other side of the switch, and it is the one place the
   * audit of activate's siblings found it.
   *
   * An agent or pane herdr does not have is still a success: the caller asked
   * for the agent to be gone and it is. Anything else is reported.
   */
  public terminateSession(sessionId: string): { success: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `No session '${sessionId}' to terminate` };

    if (session.ptyProcess) {
      session.ptyProcess.kill();
    }

    const agentName = agentNameFor(session.type, session.key);
    let error: string | undefined;
    try {
      this.closePaneForAgent(agentName);
    } catch (e: any) {
      const code = (e as HerdrCliError)?.herdrCode;
      if (code !== AGENT_NOT_FOUND && code !== PANE_NOT_FOUND) {
        error =
          `Could not close the pane for agent '${agentName}': ${e?.message ?? String(e)}. ` +
          `This daemon's terminal attach is gone, but the agent may still be running.`;
        console.error(`[HerdrBridge] ${error}`);
      }
    }

    // Terminated either way: our PTY is dead, so the session cannot be used
    // again whatever herdr did with the pane. What the caller is told about
    // the *agent* is the returned error, which is a different question.
    session.status = 'terminated';
    return error ? { success: false, error } : { success: true };
  }
}
