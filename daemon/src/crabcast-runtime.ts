import fs from 'fs';
import path from 'path';
import type { AgentRuntime, AgentSpawn, WorkspaceMcpServers } from './agent-runtime.js';
import {
  CRABCAST_CONTRACT_VERSION,
  CrabCastLink,
  type CrabCastRefusal,
  type LinkStateEvent,
  renderRefusal
} from './crabcast-link.js';
import {
  AmbiguousKeyError,
  agentNameFor,
  ambiguousKeyMessage,
  resolveAmongSessions,
  workspaceDirFor,
  workspacesRoot,
  type AgentPresence,
  type ButchrAgentName,
  type CensusReading,
  type CensusUnreadableRecord,
  type HerdrAgentDescription,
  type HerdrAgentRecord,
  type HerdrAgentStatus,
  type HerdrSession,
  PTY_DISCONTINUITY_LIMIT,
  type PtyDiscontinuity,
  type PtyStreamListener,
  type RowStanding,
  type SessionAddressResolution,
  type SessionEndedEvent,
  type StandingReading,
  type SupersessionJoin,
  type TailSource
} from './herdr.js';
import type { McpServerDefinitions } from './integrations/integration.js';
import type { BriefLocation, ResumeCause, ResumedConversation } from './resume.js';
import {
  clearWorkspaceMcpResidue,
  deleteWorkspaceDir,
  WORKSPACE_MCP_CONFIG
} from './workspace-dir.js';

/**
 * A second implementation of {@link AgentRuntime}, backed by CrabCast (KAN-278).
 *
 * **It is off by default and nothing is migrated onto it.** Selection lives in
 * `runtime-switch.ts`; this file is only what the switch selects. The channel
 * work is the precedent being copied: land it inert, exercise it deliberately,
 * and let becoming the default be a separate decision on a separate ticket.
 *
 * ## The finding that shapes this whole file
 *
 * KAN-224 established that **PTY is the one method group that is not a
 * passthrough**, and that is true. But it is not the binding constraint, and
 * building this turned up the one that is:
 *
 * > **`AgentRuntime` is a synchronous interface and CrabCast is a socket.**
 * > 14 of the 23 methods return data synchronously. A socket cannot answer a
 * > synchronous call, so every one of them is served from a mirror, from a
 * > local record, or not at all.
 *
 * That is a bigger break than PTY and it was not on anybody's list. PTY at
 * least *has* a clean answer (KAN-224's local mirror, implemented below and
 * confirmed against the running daemon). Synchrony had three answers and no
 * fourth, exactly as KAN-224 §5.1 found for `ptyBuffer` alone:
 *
 * 1. **Serve it from a mirror the adapter keeps warm.** Correct for census
 *    questions — "what is the fleet doing?" — because the honest answer to
 *    those is already an observation with a timestamp, and `HerdrBridge`'s own
 *    answer is a `herdr agent list` shell-out that is stale the moment it
 *    returns. Used for the census group.
 * 2. **Serve it from a record only this adapter holds.** Correct for sessions
 *    *we* started: we know them exactly, with no round trip and no staleness.
 *    Used for the session-lookup group.
 * 3. **Refuse, with figures, naming the leg.** The only honest answer where the
 *    caller needs a *fresh* fact that costs a round trip.
 *
 * **KAN-283 added the fourth, which was never a strategy but a repair: change
 * the signature.** `tailAgent` was the whole of category 3 and is served over
 * the wire now — a tail is the one read where a cached answer is the wrong
 * answer, so neither mirror nor local record could serve it, and refusing was
 * the honest answer only for as long as the interface forbade awaiting. **The
 * other 13 synchronous returns were each ruled on and every one stayed
 * synchronous**, because 1 or 2 serves it correctly or because CrabCast has no
 * counterpart to await; the ruling is in `docs/crabcast-runtime.md` under *The
 * synchrony ruling*. So categories 1 and 2 are the design and category 3 is now
 * empty of anything a signature change could rescue.
 *
 * ## What was read to build this
 *
 * CrabCast's **interface**, never its source: `crabcast --help` and each
 * command's help, the `--json` responses of a real daemon, and direct probes of
 * the socket. The human's decision of 2026-08-08 stands unlifted, and no file
 * under `crabcast/src` was opened. Everything asserted here about their
 * behaviour is reproducible by
 * `node daemon/scripts/verify-crabcast-runtime.mjs`.
 */

/** Butchr's `(type, key)` address and CrabCast's path address are the same fact. */
function pathForAddress(type: string, key: string): string {
  return workspaceDirFor(type, key);
}

/**
 * The inverse. Returns null for a path outside Butchr's workspace tree — which
 * is most of what a shared CrabCast daemon reports, since it also sees panes
 * nobody in this daemon started.
 */
function addressForPath(dir: string): { type: string; key: string } | null {
  const rel = path.relative(workspacesRoot(), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;
  return { type: parts[0], key: parts[1] };
}

/**
 * A map key for an agent's address, case-folded on the key exactly as
 * {@link CrabCastRuntime.sessionForAddress} folds it (KAN-403).
 *
 * Spelled once because it is used on both sides of a lookup — a census row's
 * address is built here and a session's address is built here — and two
 * hand-rolled template strings that disagree about case would produce a resync
 * that silently found nothing to re-resolve and re-subscribed a dead id.
 */
function addressKey(type: string, key: string): string {
  return `${type}/${key.toLowerCase()}`;
}

/**
 * **The launcher names Butchr is able to interpret — its own vocabulary, spelled
 * here rather than imported, and the reason for that is not tidiness (KAN-429).**
 *
 * `expectsRuntime` asks *"does this launcher deliver a runtime?"*, and Butchr can
 * answer it for exactly the names Butchr has. `AGENT_LAUNCHERS` in
 * `launchers.ts` is where those names live; {@link isButchrLauncher} is how a
 * string arriving from CrabCast is admitted into them or refused.
 *
 * **Why this is a copy and not `import type { LauncherName }`.** KAN-393's
 * ruling that channel-startup supervision has nothing to supervise on this path
 * rests on a premise about this file's imports — *"this file imports nothing
 * from `launchers.js`, so the flag has no route in even by accident"* — and
 * `verify-crabcast-channel-startup-disablement.mjs` watches that premise
 * literally, `import type` included. Its header calls the tempting version of
 * this edit *"the defect in miniature": somebody needs one export from
 * `launchers.js` — a type, a constant, anything harmless.* This is that
 * somebody, and the answer is a copy.
 *
 * **A copy is a second thing to carry a fix to, so it is checked rather than
 * trusted.** `verify-crabcast-adopt-launcher-vocabulary.mjs` reads
 * `launchers.ts` **as text** — no import, so the premise stays intact — and goes
 * red if this list and `AGENT_LAUNCHERS`'s keys stop agreeing in either
 * direction. Add a launcher there without adding it here and the check is red;
 * delete `shell` from either and this file stops compiling as well, because
 * {@link CrabCastRuntime.adoptFromCensus} compares a narrowed value against it
 * and `error TS2367` is what an impossible comparison becomes.
 */
const BUTCHR_LAUNCHERS = ['claude', 'shell'] as const;

/** A launcher name Butchr has, and can therefore answer `expectsRuntime` for. */
type ButchrLauncher = (typeof BUTCHR_LAUNCHERS)[number];

/**
 * Whether a launcher string off CrabCast's census is one Butchr can interpret.
 *
 * The narrowing is the point: past this guard the value is a
 * {@link ButchrLauncher} and not `string`, so the comparison it feeds is inside
 * one vocabulary instead of across two. See {@link CensusRow.launcher}.
 */
function isButchrLauncher(name: string | null): name is ButchrLauncher {
  return name !== null && (BUTCHR_LAUNCHERS as readonly string[]).includes(name);
}

declare const PANE_NAME_BRAND: unique symbol;

/**
 * **CrabCast's name for a pane — the other string that means "the name of an
 * agent", and the one that is NOT Butchr's (KAN-406).**
 *
 * Whatever process started a pane chose this name. herdr names its own panes
 * `butchr-<type>-<key>`, so for a herdr-started pane this is *equal* to the
 * {@link ButchrAgentName}; CrabCast names the panes it starts
 * `crabcast-<key>-<hash>`, so for those it is not. **The equality is a
 * coincidence of one starter's naming convention, not a property of pane
 * names** — which is precisely why reading it as one cost KAN-346 and KAN-397
 * the same defect twice, and why the two are now different types.
 *
 * Joining a census row on this instead of on its derived Butchr name is
 * `error TS2367` rather than a review catch. **The conversion to a Butchr name
 * has exactly one home, {@link butchrNameForCensusRow}**, and the single
 * legitimate *comparison* between the two spellings has exactly one home too,
 * {@link paneIsNamedAsHerdrWouldName} — which is a comparison and not a
 * conversion, so it produces no Butchr name and adds no second derivation.
 *
 * `readCensus` is the only producer: this is CrabCast's string, so the one cast
 * sits where CrabCast's frame is read and nowhere else.
 */
type PaneName = string & { readonly [PANE_NAME_BRAND]: 'pane-name' };

/** One row of CrabCast's `list_agents.agents`, narrowed to what we branch on. */
interface CensusRow {
  path: string;
  paneName: PaneName;
  sessionId: string | null;
  status: string | null;
  herdrStatus: string | null;
  agentRuntime: string | null;
  state: string | null;
  workDir: string | null;
  /**
   * When CrabCast's own session for this agent was created. Read for
   * {@link CrabCastRuntime.adoptFromCensus}, which must not invent one:
   * `HerdrSession.createdAt` is required, and stamping the adoption moment
   * onto it would report an agent that has been working for hours as seconds
   * old. `null` when the row carried none, and a row without it is not adopted.
   */
  createdAt: string | null;
  /**
   * `config.launcher` — the binary CrabCast was told to start. Read for
   * `expectsRuntime`, which is false for `shell` alone: a bare pane with no
   * runtime behind it is the delivered product there, and calling it dead is
   * the KAN-58 false alarm.
   *
   * **THIS IS THEIR STRING, NOT OURS — AND SINCE KAN-429 IT IS VALIDATED INTO
   * BUTCHR'S VOCABULARY BEFORE IT IS COMPARED, WHICH IS WHY THE COMPARISON IS
   * NOW SAFE.** The hazard was real and is worth keeping written down, because
   * the type below is still `string | null` and always will be: the field is
   * exact for an agent *Butchr* configured — `provision` sends
   * `launcher: defaultAgent ?? 'claude'`, so our own name comes back — and it
   * is CrabCast's own word for an agent CrabCast configured itself, which
   * {@link CrabCastRuntime.adoptFromCensus} sees because it filters on
   * `addressForPath` rather than on who configured the row. Their launcher
   * vocabulary is not ours, invariant 10 forbids reading their source to find
   * out, and a raw `row.launcher !== 'shell'` therefore read a runtime-less
   * launcher of theirs spelled anything else as *expecting a runtime*.
   *
   * **What makes it safe is that nothing guesses any more.** `adoptFromCensus`
   * puts the value through {@link isButchrLauncher} first. A name Butchr has —
   * {@link BUTCHR_LAUNCHERS}, whoever set it — is one Butchr can answer
   * `expectsRuntime` for, so the comparison downstream is `ButchrLauncher`
   * against `'shell'`: **one vocabulary, and `error TS2367` rather than a
   * silent branch if `shell` ever leaves it.** A name Butchr does not have is
   * not interpreted at all — **the row is not adopted**, and the reason is
   * logged. That is a refusal rather than a repair, and it is deliberately the
   * narrow one: it costs the population adoption exists for **nothing**, since
   * every row `provision` produces carries a launcher Butchr itself sent, and
   * a refused row is still listed by `censusRecords()` as the sessionless agent
   * it honestly is.
   *
   * This is the same class KAN-346 and KAN-397 fixed twice — joining on a name
   * whose producer is the other project. The repair is the same shape both of
   * those took: make the wrong join unspellable rather than remembering not to
   * write it.
   */
  launcher: string | null;
}

/**
 * **The Butchr name of a census row, and the ONE place that derivation lives
 * (KAN-397).**
 *
 * KAN-346 established the rule — a row's Butchr name comes from its PATH, never
 * from `paneName`, because an agent CrabCast started carries *their* pane name
 * (`crabcast-<key>-<hash>`) and not `butchr-<type>-<key>`. It then wrote that
 * rule out longhand inside {@link CrabCastRuntime.censusRecords} alone, and
 * `confirmAgentPresent` one function away kept joining on the raw `paneName`.
 * **So the defect KAN-346 fixed survived, for exactly the population this
 * runtime creates**: measured against a live peer, a running `claude` agent that
 * the census reported one line earlier under its Butchr name came back
 * `{present: false, reason: 'absent'}` from `confirmAgentPresent`, on both
 * `requireRuntime` arms — the flag was never reached because the lookup failed
 * first. `router.ts`'s `confirmActivation` answers `absent` by calling
 * `abandonSession`, so under a flipped daemon every such agent would be reported
 * a failed activation and torn down while it kept running.
 *
 * The repair is this function existing rather than the rule being restated: two
 * copies of a derivation are two things to carry a fix to, and the evidence that
 * one of them gets missed is the ticket this docblock is named after. A third
 * reader added later joins on the same source of truth by calling this, or it is
 * a new instance of the same defect.
 *
 * A row outside Butchr's workspace tree has no Butchr name to give it and keeps
 * `paneName`, which is what it always was.
 *
 * **KAN-406 made that last sentence the only cast of a {@link PaneName} to a
 * {@link ButchrAgentName} in `daemon/src`, and it is deliberately the awkward
 * branch.** The derivation proper — `addressForPath` then `agentNameFor` —
 * needs no cast at all, because `agentNameFor` produces the branded type
 * itself. Only the fallback asserts something the types cannot check: that for
 * a pane outside the workspace tree, `paneName` is the best name Butchr has,
 * which is true because there is no other and NOT because the two spellings
 * agree. A second cast written elsewhere would be a second derivation, which is
 * the defect this function exists to end.
 */
function butchrNameForCensusRow(
  row: Pick<CensusRow, 'paneName' | 'path' | 'workDir'>
): ButchrAgentName {
  const address = addressForPath(row.workDir ?? row.path);
  return address
    ? agentNameFor(address.type, address.key)
    : (row.paneName as string as ButchrAgentName);
}

/**
 * **The one place the two spellings may legitimately be compared, and the
 * reason it is a comparison rather than a conversion (KAN-406 AC3).**
 *
 * `describeAgent` searches `census.foreign` — panes CrabCast can see and does
 * not own — for one named the way herdr names a pane it started itself. **For
 * that population `paneName` IS the Butchr name**, because herdr spells its own
 * pane names `butchr-<type>-<key>`, which is exactly what {@link agentNameFor}
 * produces. So the comparison is correct, and #168 established that it must
 * stay: substituting {@link butchrNameForCensusRow} here would be identical for
 * every pane outside the workspace tree and would CHANGE behaviour for one case
 * — a foreign pane whose `workDir` is inside a Butchr workspace, which is a
 * human's own terminal opened there, and which would start being reported as
 * that workspace's agent. Uniform, and wrong.
 *
 * **The brands must permit this, and they do — through here and nowhere else.**
 * Both sides widen to `string` for the one comparison, so no {@link PaneName}
 * becomes a {@link ButchrAgentName} and no second derivation is created; what
 * the brands take away is the ability to write this same comparison *by
 * accident*, spelled `r.paneName === agentName`, which is indistinguishable
 * from the defect KAN-397 fixed. Here the by-construction equality is named,
 * greppable, and carries its own justification.
 */
function paneIsNamedAsHerdrWouldName(
  row: Pick<CensusRow, 'paneName'>,
  agentName: ButchrAgentName
): boolean {
  return (row.paneName as string) === (agentName as string);
}

/** A census reading, with the timestamp that makes its staleness legible. */
interface Census {
  reachable: boolean;
  at: number;
  rows: CensusRow[];
  /** Panes CrabCast can see but does not own. Read for `describeAgent`. */
  foreign: CensusRow[];
  /**
   * `list_agents.unreadableRecordsTotal`, read at read-path contract v4
   * (KAN-324). `null` means the frame carried no disclosure — a peer below v4,
   * or a census that was never taken. **Never defaulted to `0`**: see
   * {@link CensusReading}.
   */
  unreadableRecordsTotal: number | null;
  /** `list_agents.unreadableRecords`, narrowed to what Butchr may carry. */
  unreadableRecords: CensusUnreadableRecord[];
}

/**
 * The empty census — what this runtime holds before it has read one, and what
 * every failure path falls back to.
 *
 * Its disclosure is `null` rather than `0`, and that is the point of it being a
 * named constant rather than an object literal repeated at five call sites: a
 * literal is where somebody writes `0` because it looks tidier, and `0` there
 * is the claim *"a census was taken and found nothing skipped"* about a census
 * that did not happen.
 */
const NO_CENSUS: Census = {
  reachable: false,
  at: 0,
  rows: [],
  foreign: [],
  unreadableRecordsTotal: null,
  unreadableRecords: []
};

const HERDR_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

function asHerdrStatus(value: unknown): HerdrAgentStatus {
  return typeof value === 'string' && (HERDR_STATUSES as string[]).includes(value)
    ? (value as HerdrAgentStatus)
    : 'unknown';
}

/**
 * The read sources a tail may name — the same pair `TAIL_SOURCES` declares in
 * `herdr.ts`, restated here rather than imported because that constant is not
 * exported and the type is.
 *
 * **Confirmed identical on the wire**, which is why the mapping is a narrowing
 * and not a translation: a live CrabCast at `6f47df7d` answered
 * `sourcesTried: ["recent-unwrapped", "visible"]` — their own vocabulary,
 * matching ours value for value. That is the exception rather than the rule
 * across this adapter, and it is the whole reason {@link CrabCastRuntime.tailAgent}
 * is worth serving over the wire instead of approximating.
 */
const TAIL_SOURCE_VALUES = ['recent-unwrapped', 'visible'] as const;

/**
 * A source name we recognise, or `null`.
 *
 * **`null` means "every source was asked and every one was empty"** — the
 * assertion {@link AgentRuntime.tailAgent} defines and that
 * `superviseChannelStartup` relies on — and an unrecognised value collapses to
 * it for a reason worth stating: a source we cannot name is one we cannot make
 * that claim about either, and the alternative is passing a string through the
 * type as if it had been checked. A new source appearing on their side is
 * therefore *visible* here as a `null` rather than smuggled through, and
 * `sourcesTried` still carries what they said.
 */
function narrowTailSource(value: unknown): TailSource | null {
  return typeof value === 'string' && (TAIL_SOURCE_VALUES as readonly string[]).includes(value)
    ? (value as TailSource)
    : null;
}

/** The same narrowing over a list, dropping anything we cannot name. */
function narrowTailSources(values: unknown[]): TailSource[] {
  return values
    .map((v) => narrowTailSource(v))
    .filter((v): v is TailSource => v !== null);
}

/**
 * KAN-224's `PtyMirror`, implemented.
 *
 * The local reconstitution of `HerdrSession`'s pty fields: the snapshot
 * replaces {@link buffer} and is never fanned out; each `pty_output` frame is
 * appended **and** fanned out, with the same `slice(-100000)` bound
 * `HerdrBridge` uses. Two destinations, no overlap, nothing to deduplicate.
 */
interface PtyMirror {
  remoteSessionId: string;
  buffer: string;
  listeners: Array<PtyStreamListener>;
  /**
   * **`'stale'` is the state KAN-381 added, and its absence was the defect.**
   * Before it there were three states and a reconnected-but-unsubscribed mirror
   * had to be one of them — it was `'live'`, which is the claim that this
   * mirror is tracking the pane. It was not; CrabCast was streaming to a socket
   * that no longer existed. A state that cannot be named is one nothing can
   * branch on, which is why the resync had nowhere to hang.
   */
  state: 'subscribing' | 'live' | 'stale' | 'ended';
  /**
   * Incremented on every subscribe attempt, so a `pty_init` that resolves after
   * a *later* drop cannot promote a mirror the link has since lost again.
   * Without it a slow reconnect racing a second drop leaves `'live'` on a
   * mirror with no subscription — the original defect, arrived at by a race
   * instead of by omission.
   */
  generation: number;
  /** Gaps opened on this mirror so far; the source of `PtyDiscontinuity.sequence`. */
  gaps: number;
  /**
   * The gap currently open, or `null` when the mirror is subscribed.
   *
   * The same object that was appended to `HerdrSession.ptyDiscontinuities`, held
   * by reference so closing it updates the durable record and the live one
   * together. Two copies would be two answers.
   */
  openGap: PtyDiscontinuity | null;
}

const PTY_BUFFER_LIMIT = 100_000;

/**
 * Read CrabCast's `channelEnabled` off a frame **without collapsing its third
 * state** (KAN-294, consuming their KAN-281 at `8d7348f`).
 *
 * ## The three states, confirmed from the wire at the pin rather than relayed
 *
 * Driven against a real daemon built at `8d7348f`, isolated `dataDir`:
 *
 * | what was done | surface | value |
 * | --- | --- | --- |
 * | `configure --mcp crabcast`, then `activate` | `activate_response` | `true` |
 * | `configure` with no `--mcp`, then `activate` | `activate_response` | `false` |
 * | `configure`, never activated | `agent_status` | `null` |
 * | a path nobody configured | `agent_status` | `null` |
 * | `activate` refused for capacity | `activate_response` | `null` |
 *
 * That last row was not planned and is the most useful of the five: a refusal
 * spawned nothing, so there is no spawn to be about, and CrabCast answers
 * `null` rather than `false` on the one path most likely to have been written
 * as a boolean.
 *
 * ## Why this is a function and not `frame.channelEnabled ?? false`
 *
 * Because that expression is the defect, and it is a *silent* one. `??` and
 * `!!` and a `boolean` type annotation all turn "nobody decided" into "decided
 * no", and the two differ only for agents nothing ever spawned — so the
 * collapsed version is green against every agent anybody tests with. CrabCast
 * say it on the field itself: *"`null` means there is no spawn to be about,
 * never 'no channel'."* A wrong `false` is the actively damaging value, because
 * `false` is what a caller branches on to conclude the channel is unavailable.
 *
 * **An unrecognised type is `null`, not `false`.** Their §8 requires a value a
 * consumer does not recognise to be handled as an unknown rather than errored
 * on, and `null` is this field's spelling of unknown. A string `"true"` would
 * be a shape nobody has seen; reading it as `true` would be guessing and
 * reading it as `false` would be the collapse.
 *
 * ## Where it is read from, and what that is worth
 *
 * `activate_response` — **which is outside their read-path contract.** They
 * disclosed that themselves and their KAN-287 is the ticket to close it, so
 * this field can change here without moving
 * {@link CRABCAST_CONTRACT_VERSION} and without going red in their CI.
 *
 * **And `list_agents` does not carry it at all** — checked row by row at the
 * pin, the key is simply absent. That is not documented anywhere: their
 * contract covers `list_agents` and `agent_status`, and the `channelEnabled`
 * section describes `agent_status` and `activate_response` without saying the
 * census omits it. It matters here more than it would to most consumers,
 * because **the census is the only thing this runtime polls** ({@link
 * startCensus}). So the verdict is reachable at the spawn and by a per-agent
 * `agent_status` round trip, and never from the poll we already run — which is
 * why it is kept on the session at {@link provision} rather than refreshed.
 */
export function readChannelEnabled(frame: Record<string, unknown>): boolean | null {
  const value = frame.channelEnabled;
  return typeof value === 'boolean' ? value : null;
}

/**
 * Read CrabCast's resume verdict off an `activate_response`, **and the only
 * place in this repository where their spelling meets ours** (KAN-432 AC1).
 *
 * ## The two names, converted here and nowhere else
 *
 * Theirs is `resumedExistingConversation`; ours is `resumedConversation`. One
 * fact, two names, across a project boundary — which is the KAN-346 / KAN-397 /
 * KAN-429 class, and the reason this is a named function with the conversion
 * inside it rather than a field read at the call site. A second site spelling
 * the translation for itself is the defect that class describes, so the ticket
 * asks for exactly one and this is it. `grep -c resumedExistingConversation
 * daemon/src` answering anything but `1` is the drift.
 *
 * **CrabCast also publishes a field called `resumedConversation` — our
 * spelling, on their wire — and it is NOT this one.** It sits in the `spawned`
 * branch's `sometimes` list beside `resume`, and it is their record of a resume
 * *they* were asked for. Reading it here because the name matches would be
 * taking a different question's answer, so the field this function names is
 * theirs-by-their-name and the conversion is deliberate rather than incidental.
 *
 * ## Why absence is `'unknown'` and never `'fresh'`
 *
 * Because their contract says absence is not an answer. `resumedExistingConversation`
 * is on the **spawning** branch and off the **idempotent** one, deliberately —
 * v8 rules that *"no field moves"* and gives the reason: the value is
 * `session.mayResume`, *"the resume decision this spawn made"*, and on a branch
 * where nothing spawned there is no such decision. It is recoverable from
 * nothing afterwards: *"the decision itself is recorded nowhere"*, and its
 * durable input `everActivated` is set to `true` by the very activation that
 * read it.
 *
 * So the absent case is not a peer-version edge — it is **the branch a
 * reconciler meets most**, in their own words: *"a reconciling caller's
 * ordinary call is `activate` on an agent that is already up, so the response a
 * reconciler sees most often is the one missing those four keys."*
 *
 * Collapsing that to `'fresh'` is the precise defect KAN-432 was filed for.
 * `'fresh'` is a claim — *this agent came up with its prompt on the command
 * line and is already working* — and asserting it about a response that said
 * nothing is how a fleet of resumed agents comes up idle while every instrument
 * reports them healthy. **An unrecognised type is `'unknown'` too**, for the
 * same reason `readChannelEnabled` refuses to guess at one: a string `"true"`
 * would be a shape nobody has seen, and reading it either way would be
 * inventing an answer.
 */
export function readResumedConversation(frame: Record<string, unknown>): ResumedConversation {
  const value = frame.resumedExistingConversation;
  if (value === true) return 'restored';
  if (value === false) return 'fresh';
  return 'unknown';
}

/**
 * Read read-path contract v4's skipped-row disclosure off a `list_agents` or
 * `daemon_status` frame (KAN-324), **without collapsing its third state**.
 *
 * ## What this is reading, and why an additive change needed any code at all
 *
 * v4 added `unreadableRecords` and `unreadableRecordsTotal` to both calls
 * because CrabCast's KAN-302 changed what an unreadable registry row does:
 * their daemon used to refuse to start on one and now starts and **skips** it.
 * So from v4 onward a census can be *short*, and at v3 there was no field that
 * could say so. Measured on this machine against a peer at `6258ded`:
 * `agents: []`, `configuredAgents: 0`, `unreadableRecordsTotal: 1` — an empty
 * fleet and a one-row-short fleet, identical on every field a v3 consumer
 * reads. CrabCast put the counts and the disclosure adjacent for exactly this
 * reason: **a count that silently excludes what it could not read is the
 * defect, one field to the left.**
 *
 * ## Why this is a function and not `frame.unreadableRecordsTotal ?? 0`
 *
 * Because that expression is the defect, and it is the *silent* kind — the same
 * one {@link readChannelEnabled} exists to refuse, in the same shape. `?? 0`
 * turns **"this peer disclosed nothing"** into **"this peer disclosed that
 * nothing was skipped"**, and those are opposite claims about how far the agent
 * count can be trusted. It is green against every v4 peer anybody tests with,
 * because a v4 peer sends the field; it is wrong only against the v3 peer this
 * adapter is still expected to meet — and wrong in the direction of looking
 * clean.
 *
 * So: a number is a disclosure, and **anything else is `null`**. A negative or
 * non-integer total is not a count either — it is a shape nobody has seen, and
 * reading it as a count would be guessing while reading it as `0` would be the
 * collapse.
 *
 * ## The total is not the array's length, and must not be derived from it
 *
 * Both are read, separately, and the total wins. CrabCast caps the detail rows
 * it returns on other lists in this same frame (`pages.*.limit` is 25), so a
 * length that had silently stopped at a cap would read as *"that is all of
 * them"* — which is this ticket's own defect, reproduced inside the field
 * written to disclose it. `unreadableRecords` is therefore evidence about the
 * rows it names and never a count of the rows there are.
 *
 * ## v7's three fields, and the door they are read behind (KAN-357)
 *
 * v7 adds `claimsAt`, `claimsEvent` and `standing` to each row. `standing` is
 * the one that turns `unreadableRecordsTotal` from a number nobody can act on
 * into a branch: this machine's count has read **1** since 2026-08-03 — a
 * tombstone CrabCast preserves on purpose — so a genuinely lost agent arrives
 * as a `2` where the `1` has become background noise.
 *
 * **The version is read as the first act and the v7 fields are refused below
 * it**, rather than being read optimistically and defaulted. That ordering is
 * the whole of why this function takes `peerContractVersion` at all, and it is
 * not academic: as of 2026-08-13 the CrabCast serving this machine answers
 * `contractVersion: 6`, so `frame.standing` is `undefined` on every row here
 * and will be until somebody deploys them. An implementation that read
 * `undefined` as *"no standing recorded"* would pass its own tests, ship, and
 * be wrong the moment that deploy happens — because it cannot distinguish
 * **this peer is too old to have the field** from **this row has no standing**.
 * That is absence-versus-zero arriving at the project boundary, and
 * {@link StandingReading} is the type that makes the two un-collapsible.
 *
 * **The refusal is scoped to the v7 fields and to nothing else.** A v6 peer's
 * `unreadableRecordsTotal`, its rows, and `claimsPath` are all still read
 * exactly as before — refusing the whole census on a version mismatch would
 * delete KAN-324's disclosure against the only peer that actually exists, and
 * would be this daemon pressuring their release cadence, which is the one thing
 * KAN-278 forbids outright. The door is in front of `standing`, not in front of
 * the census.
 *
 * ## `null` on a claims-field has exactly one meaning
 *
 * **The row parsed and named none** — never *"we could not see it"*. That is
 * theirs to guarantee and they do guarantee it: a line that does not
 * `JSON.parse` never becomes one of these rows at all, so every row here
 * parsed. It is invariant 11 arriving from the other side of the wire, and it
 * is what makes these fields safe to branch on rather than merely to display.
 */
export function readUnreadableDisclosure(
  frame: Record<string, unknown>,
  peerContractVersion: number | null,
  readablePaths: ReadonlySet<string>
): {
  unreadableRecordsTotal: number | null;
  unreadableRecords: CensusUnreadableRecord[];
} {
  const total = frame.unreadableRecordsTotal;
  const rows = Array.isArray(frame.unreadableRecords) ? frame.unreadableRecords : [];

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  // The door. Read once per frame from what the peer published at handshake,
  // never from the presence or absence of the fields themselves — inferring the
  // version from `'standing' in row` would make a v7 peer that legitimately
  // omitted a field indistinguishable from a v6 peer, which is the same
  // absence-versus-zero mistake one level down.
  const standingAvailable =
    peerContractVersion !== null && peerContractVersion >= CRABCAST_STANDING_MIN_VERSION;

  return {
    unreadableRecordsTotal:
      typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null,
    unreadableRecords: rows.map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const identity = str(r.identity);
      const claimsPath = str(r.claimsPath);
      // All three v7 fields cross the door together, because they arrived
      // together and are absent from the same peers. `claimsAt` outside it
      // would be a `null` meaning "this peer cannot send it", and their
      // contract guarantees that `null` means "the row named none" — the same
      // collapse as `standing`, one field over.
      const standing: StandingReading = standingAvailable
        ? {
            available: true,
            verdict: narrowRowStanding(r.standing),
            // Quotations. Carried as the strings they are and never parsed —
            // see StandingReading.claimsAt for why a date type would be a lie.
            claimsAt: str(r.claimsAt),
            claimsEvent: str(r.claimsEvent)
          }
        : { available: false, because: 'peer-below-v7', peerContractVersion };

      return {
        source: 'crabcast-registry' as const,
        line: typeof r.line === 'number' && Number.isInteger(r.line) ? r.line : null,
        problem: str(r.problem),
        identity,
        reason: str(r.reason),
        // v4, not v7 — on the wire from the peer this machine actually has, so
        // it is read in front of the door rather than behind it.
        claimsPath,
        standing,
        supersession: joinSupersession(standing, claimsPath, identity, readablePaths)
        // `raw` is deliberately not carried. See CensusUnreadableRecord.
      };
    })
  };
}

/**
 * The read-path contract version at which `standing` appears. Separate from
 * {@link CRABCAST_CONTRACT_VERSION} on purpose: that constant says what this
 * adapter was *proved against* and moves whenever we consume anything new,
 * while this one says when **this particular field** became available and must
 * only ever move if CrabCast moves the field. Deriving the gate from the
 * proved-against constant would silently re-open the door every time we bumped
 * for an unrelated reason.
 */
const CRABCAST_STANDING_MIN_VERSION = 7;

/**
 * Narrow their `standing` to {@link RowStanding}, **collapsing an unrecognised
 * value to `unknown` and never to `retired`**.
 *
 * Their contract is explicit that this is where the must-ignore clause bites
 * hardest: `unknown` already means *we will not say*, which is the honest
 * reading of a member we do not recognise, whereas reading *"not a word I
 * know"* as *"harmless"* is the wrong-conclusion-from-a-short-list defect
 * arriving one level up. A value they add in v8 therefore lands here as
 * `unknown` — visible, and never as an all-clear.
 *
 * A missing value from a peer that *is* v7 also lands as `unknown`, and that is
 * correct rather than a collapse: the peer is one we have established can speak
 * this vocabulary, so a row on which it said nothing is a row it declined to
 * rule on. The peer that cannot speak it at all never reaches this function.
 */
function narrowRowStanding(value: unknown): RowStanding {
  return value === 'retired' || value === 'claims-an-agent' ? value : 'unknown';
}

/**
 * The supersession join — CrabCast's own three-outcome table, implemented.
 *
 * Asked **only** of a row whose standing is available and reads
 * `claims-an-agent`; every other row gets `null`, which is *"this question was
 * not asked"* and is distinct from `could-not-run`, which is *"it was asked and
 * could not be answered"*. `retired` needs no join: nothing was going to be
 * restored from it either way.
 *
 * **Joins on `claimsPath` and never on `identity`.** An agent in CrabCast *is*
 * a canonical filesystem path, so `claimsPath` is the only field in the row
 * that speaks the readable list's vocabulary. `identity` is whatever the row
 * called itself — very often `<type>/<key>` on a `pre-migration` row — and the
 * wire does not say which form you are holding, so a failed match on it is
 * indistinguishable from a genuinely absent agent. Branching on it would fire
 * the alarm on the ordinary case, which is worse than no alarm at all.
 */
function joinSupersession(
  standing: StandingReading,
  claimsPath: string | null,
  identity: string | null,
  readablePaths: ReadonlySet<string>
): SupersessionJoin | null {
  if (!standing.available || standing.verdict !== 'claims-an-agent') return null;
  if (claimsPath === null) return { outcome: 'could-not-run', identity };
  return readablePaths.has(claimsPath)
    ? { outcome: 'matched', claimsPath, matchedPath: claimsPath }
    : { outcome: 'ran-found-nothing', claimsPath };
}

/** The two pty verbs that write. `pty_init` is a read and is not one of these. */
type PtyWriteAction = 'pty_input' | 'pty_resize';

/**
 * What became of a pty write, as a closed vocabulary (KAN-459).
 *
 * **Two values, and there is deliberately no third for "fine".** A write that
 * succeeded produces no record at all, so this type can only ever name a way of
 * not working — which is what stops a future author counting successes into the
 * same field and burying the signal. The split is `CrabCastLink.request`'s own
 * distinction, made unrepresentable-if-collapsed rather than asserted:
 *
 * - `refused` — CrabCast answered `success: false`. **We asked and it said no**,
 *   so the peer is reachable and has disowned the session.
 * - `undelivered` — the promise rejected. **We could not ask**: the link was
 *   down, the socket write threw, or no answer arrived inside the timeout. This
 *   says nothing about the session.
 */
type PtyWriteOutcome = 'refused' | 'undelivered';

/** The most recent pty write that did not work, kept so a count has an example. */
interface PtyWriteFailure {
  outcome: PtyWriteOutcome;
  action: PtyWriteAction;
  /** Butchr's session id — the one an operator can look up. */
  sessionId: string;
  /**
   * CrabCast's own machine-readable refusal code where it sent one, e.g.
   * `unknown_session`. Null on an `undelivered`, and null if a future peer
   * refuses without one — an absent code is not a missing refusal.
   */
  refusal: string | null;
  detail: string;
  at: string;
}

/**
 * Everything `configure_agent` needs, sourced from the session it is about.
 *
 * **Required, every one of them, deliberately** — see
 * {@link buildConfigureAgentPayload}.
 */
export interface ConfigureAgentInput {
  /** The session being provisioned. Its `workDir` is CrabCast's address. */
  session: Pick<HerdrSession, 'workDir'>;
  /**
   * What this agent outranks, from `WorkspaceRegistry.priorityFor` (KAN-482).
   * Never a literal: see the payload builder for the defect that was.
   */
  priority: number;
  /**
   * Whether this agent's workspace type hands work out rather than doing it,
   * from `isSupervisorType` (KAN-492). The three gate flags are derived from
   * this ONE input — see the payload builder — so they cannot be set to
   * disagree with each other.
   */
  supervisor: boolean;
  /** The rendered brief, handed over verbatim. CrabCast never reads the bytes. */
  promptContent: string;
  /** The launcher to resolve at spawn. `undefined` means Butchr's own default. */
  defaultAgent: string | undefined;
  /** Prepared definitions; omitted from the payload when there are none. */
  mcpServers: WorkspaceMcpServers | undefined;
}

/**
 * The `configure_agent` request, as a type rather than a bag.
 *
 * A `type` alias and not an `interface`, which is load-bearing rather than
 * style: `CrabCastLink.request` takes `Record<string, unknown>`, and TypeScript
 * gives a type alias the implicit index signature that makes that assignment
 * legal where an interface would need a cast. A cast here would defeat the
 * point — the whole value of naming this shape is that the compiler checks it.
 */
export type ConfigureAgentPayload = {
  action: 'configure_agent';
  path: string;
  priority: number;
  /** May CrabCast's capacity gate refuse this activation? (KAN-492) */
  refusable: boolean;
  /** Does this agent occupy one of CrabCast's charged slots? (KAN-492) */
  chargeable: boolean;
  /** May this agent be stood down to make room for another? (KAN-492) */
  preemptable: boolean;
  launcher: string;
  prompt: string;
  mcpServers?: WorkspaceMcpServers;
};

/**
 * Build the `configure_agent` payload from the session it describes.
 *
 * ## Why this is a function at all (KAN-482)
 *
 * **`provision()` has now dropped four values Butchr already had, and each was
 * found separately, months apart, by somebody looking for something else:** the
 * resume signal (gate 7), `resumedExistingConversation` (gate 10),
 * `mcpConfig` where `mcpServers` was wanted (KAN-294), and the priority scale
 * (this ticket). Every one of them was a payload assembled inline, in a
 * `Record<string, unknown>` where **no field is required, no field is spelled
 * wrong, and nothing is missing** — because that type says nothing at all about
 * what a `configure_agent` is.
 *
 * So the payload has a type now, and its input has a type, and every field of
 * {@link ConfigureAgentInput} is **required**. `defaultAgent` and `mcpServers`
 * are `T | undefined` rather than `?:` for exactly that reason: a caller that
 * has no launcher must write `defaultAgent: undefined` and *say so*, where an
 * optional property would let the next field be dropped in silence. That is the
 * difference between the four defects above and a compile error.
 *
 * **What this does NOT claim.** It does not stop a field CrabCast wants from
 * being absent from this type — nothing on this side can see their contract —
 * and it is not a validator: it makes no assertion, and there is nothing here
 * to delete later. It moves one class of defect from *discovered in production
 * months later* to *rejected at the keyboard*, and that is the whole of it.
 *
 * ## `priority` — the value this ticket is about
 *
 * This read `priority: 1` as a literal until KAN-482, for every agent, on a
 * runtime whose own capacity gate is driven by it. See
 * `AgentRuntime.spawnSession` for what that cost and why the parameter is
 * required rather than defaulted.
 *
 * ## `mcpServers`, AN OBJECT, AND NOT `mcpConfig`, A STRING (KAN-294)
 *
 * This read `configure.mcpConfig = JSON.stringify(mcpServers)` until the
 * re-pin, and that field does not exist on `configure_agent`. It was not
 * rejected — CrabCast accepted the call, answered `success: true`, and simply
 * did not have the servers: `agent_status` echoed `config.mcpServers: undefined`
 * for an agent configured that way. So every agent this runtime spawned got NO
 * MCP servers at all, silently, and `channelEnabled` was structurally `false`
 * for all of them. Confirmed on a real daemon at the pin, both directions — the
 * wrong field echoes `undefined`, the right one echoes back what was sent.
 *
 * The shape is the one CrabCast's own refusal states: *"an object keyed by
 * server name … IT IS DEFINITIONS RATHER THAN NAMES: the command, args and env
 * that spawn each server, written into .mcp.json verbatim."* That is exactly
 * `McpServerDefinitions`, so this is a pass-through and not a translation.
 *
 * **The key is omitted entirely when there is nothing to send**, rather than
 * sent empty: an empty object is a request to write a `.mcp.json` with no
 * servers in it, and the absence is a request to write no file at all.
 *
 * **WHAT IS DELIBERATELY NOT SENT.** Their `"builtin"` sentinel —
 * `{"crabcast": "builtin"}` — is how an agent would be given CrabCast's own
 * channel server, and it is what makes `channelEnabled` answer `true`. This
 * does not send it. Giving Butchr's agents a CrabCast channel is a cutover
 * decision about which daemon an agent talks to, and cutover is out of scope
 * (KAN-294 item 5). The consequence, stated rather than left to be found: an
 * agent spawned through this runtime answers `channelEnabled: false`, and that
 * `false` is now honest — it is CrabCast reporting a spawn that decided, where
 * before it was reporting a spawn whose MCP request it had discarded.
 *
 * ## `refusable` / `chargeable` / `preemptable` — SUPERVISOR-NESS (KAN-492)
 *
 * The fifth value dropped at this seam, and the one that cost a fleet. Butchr
 * has exempted supervisors from its own cap since KAN-41 and told CrabCast
 * nothing, so the cutover of 2026-08-16 charged **five supervisors and zero
 * task agents** against a cap of three and refused two of them on the way back.
 * CrabCast could not have inferred it: `epic` and `story` are Butchr's
 * vocabulary, and their gate sees a directory and a priority.
 *
 * **THE NAMES ARE THEIRS, READ OFF THEIR PUBLISHED SURFACE, NOT INVENTED HERE.**
 * `crabcast configure --help` publishes `--refusable` (*"may the capacity gate
 * refuse it"*), `--chargeable` (*"does it occupy a charged slot"*) and
 * `--preemptable` (*"may it be stood down to make room"*), all defaulting true;
 * `configure_response` echoes the same three names under `config`, and lists
 * them by name in its own `changed`/`applied`/`outcomes` maps. That echo is what
 * the proof reads back, because KAN-294 is the standing lesson here: a field
 * CrabCast does not have is accepted with `success: true` and simply discarded.
 *
 * **All three are sent on every payload, never omitted for the default.** An
 * omitted field is indistinguishable from a field the far side dropped, which
 * is the exact reading KAN-294 could not make. Sending `true` explicitly for a
 * task agent is also what gives the round-trip a positive control: a surface
 * that ignored these fields would answer identically for both kinds of agent —
 * and since their default is `true`, it would answer identically to a CORRECT
 * task payload. Only two rows that DIFFER can tell that apart.
 *
 * **Derived from one boolean rather than passed as three.** A supervisor is
 * exempt from the gate in all three senses or in none, and three independent
 * fields make eight states of which six are incoherent — an agent that cannot
 * be refused but can be preempted, say. `input.supervisor` is the only knob, so
 * the incoherent states are not reachable rather than merely unused: this is
 * the same move as the payload having a type at all. CrabCast publishes
 * `--gate-exempt` as the shorthand for the same three, which is their own
 * statement that these travel together.
 *
 * **THE LIMIT OF THAT, because "not reachable" would otherwise claim more than
 * the mechanism covers.** It is a fact about this builder, which is the only
 * producer of a `ConfigureAgentPayload` in `daemon/src` — nothing else
 * constructs one, so nothing else can name an incoherent trio. It is NOT a fact
 * the type system enforces: `ConfigureAgentPayload` declares three independent
 * booleans, so a future author who hand-writes a payload rather than calling
 * this can still spell `{chargeable: false, preemptable: true}` and compile.
 * Typing the three as a union of the two coherent shapes would close that, and
 * was not done here: the payload must stay assignable to `Record<string,
 * unknown>` for `CrabCastLink.request`, which is why it is a type alias and not
 * an interface, and a union puts that implicit index signature at risk for a
 * defect no call site can currently reach. **What catches it meanwhile is
 * CrabCast**, which refuses the combination on the wire in as many words —
 * belt and braces, in that order, with the braces on their side rather than
 * ours. If a second producer is ever added here, close it with the type.
 *
 * **Why `preemptable` follows from `chargeable`, and is not a separate policy
 * decision.** Preemption's bargain is that standing an agent down frees the
 * slot the incoming one takes. An uncharged agent holds no slot, so standing it
 * down frees nothing and the bargain cannot be struck — it would be pure loss.
 * Butchr's own gate reaches the same place by a different route: `selectVictim`
 * is strictly-greater over epic 3 / story 2 / task 1, so a task activation
 * outranks nothing and can never take a supervisor.
 *
 * **What the exemption does NOT do, checked on the wire rather than assumed.**
 * It is not all-or-nothing and it does not make a supervisor free. CrabCast's
 * own derivation, with one exempt agent running: *"3 charged agent(s), plus 1
 * uncharged agent(s) — not counted against the cap, but 0.9 GiB is now held off
 * the static memory ceiling for them (KAN-275); the live memory term needs no
 * such reserve because MemAvailable has already had their memory taken out of
 * it."* Their `memory allows` term fell 16 → 15 as that agent came up. So the
 * exemption is from the **count** and the CPU divisor, while memory is still
 * charged — which is precisely Butchr's own split (`capacity.ts`: supervisors
 * are uncounted; `agent-cost.ts`: their memory was measured as comparable and
 * is charged). One claim, the same on both sides of the seam.
 *
 * ## Pure, and exported, so a proof can drive the real thing
 *
 * It touches no socket and no disk, so `verify-crabcast-priority-roundtrip.mjs`
 * can build the **production** payload for a synthetic epic session and put it
 * on the wire. A proof that assembled its own payload would be asserting on
 * code nobody runs — the *"a proof that supplies its own input"* defect this
 * repository keeps re-finding.
 */
export function buildConfigureAgentPayload(input: ConfigureAgentInput): ConfigureAgentPayload {
  // One input, three fields, so they cannot be made to disagree. See above for
  // why a supervisor is exempt in all three senses and why the names are read
  // off CrabCast's published surface rather than chosen here.
  const chargeable = !input.supervisor;
  const payload: ConfigureAgentPayload = {
    action: 'configure_agent',
    path: input.session.workDir,
    priority: input.priority,
    refusable: chargeable,
    chargeable,
    preemptable: chargeable,
    launcher: input.defaultAgent ?? 'claude',
    prompt: input.promptContent
  };
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    payload.mcpServers = input.mcpServers;
  }
  return payload;
}

export interface CrabCastRuntimeOptions {
  link: CrabCastLink;
  /** How often the census is refreshed while connected. */
  censusIntervalMs?: number;
  log?: (message: string) => void;
}

export class CrabCastRuntime implements AgentRuntime {
  /** See {@link AgentRuntime.runtimeName}. */
  public readonly runtimeName = 'crabcast' as const;

  private readonly link: CrabCastLink;
  private readonly log: (message: string) => void;
  private readonly censusIntervalMs: number;

  /** Sessions this daemon started. Authoritative, exact, no round trip. */
  private readonly sessions = new Map<string, HerdrSession>();
  /** Butchr session id → CrabCast's own session id, which addresses the wire. */
  private readonly remoteIds = new Map<string, string>();
  /**
   * Butchr session id → the spawn's channel verdict, as CrabCast reported it.
   *
   * **Three states, and the map has a fourth thing to say: an absent key.** A
   * key that is not here is a session this adapter has no verdict for at all —
   * `provision` has not answered yet, or never will. {@link channelEnabledFor}
   * renders that as `null` too, which is right: "no spawn decided" and "no
   * answer reached us" are both *not a verdict*, and neither is `false`.
   */
  private readonly channelEnabled = new Map<string, boolean | null>();
  private readonly ptyMirrors = new Map<string, PtyMirror>();

  /**
   * pty writes that did not work, since this runtime started (KAN-459).
   *
   * **Counts only, and a single example.** Not a ring buffer of every refusal:
   * a stale session refuses once per keystroke, so anything retaining
   * per-occurrence detail is a memory leak keyed to typing speed. The count is
   * unbounded and cheap; `last` is one frame deep and overwritten.
   */
  private readonly ptyWrites: {
    refused: number;
    undelivered: number;
    last: PtyWriteFailure | null;
  } = { refused: 0, undelivered: 0, last: null };

  /**
   * `outcome:action:sessionId` already logged once, to keep the log line
   * first-of-kind. Bounded by sessions × 2 outcomes × 2 verbs, and entries are
   * dropped with the session by {@link endMirror} — so a session id that is
   * somehow reissued gets its first line again rather than being silently
   * suppressed by a dead session's key.
   */
  private readonly ptyWritesLogged = new Set<string>();

  private census: Census = NO_CENSUS;
  private censusTimer: NodeJS.Timeout | null = null;

  private sessionEndedListener: ((event: SessionEndedEvent) => void) | null = null;

  constructor(options: CrabCastRuntimeOptions) {
    this.link = options.link;
    this.censusIntervalMs = options.censusIntervalMs ?? 2_000;
    this.log = options.log ?? ((m) => console.log(`[CrabCastRuntime] ${m}`));

    this.link.onEvent((frame) => this.onCrabCastEvent(frame));
    // Registered BEFORE `connect()`, for the same reason the frame demux is:
    // the first transition this runtime must not miss is its own first one, and
    // a handler installed after the call is a handler that was not there for it.
    this.link.onLinkState((event) => this.onLinkState(event));
    this.link.connect();
    this.startCensus();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void {
    this.sessionEndedListener = listener;
  }

  /**
   * **Never fired, and as of KAN-393 that is a RULING rather than a shortfall.**
   *
   * ---------------------------------------------------------------------------
   * THE RULING (KAN-393, `epic/KAN-39`, 2026-08-14) — READ THIS BEFORE RE-DERIVING
   * ---------------------------------------------------------------------------
   *
   * **Cutover gate 3 is NOT a cutover blocker, and this method not firing IS the
   * deliberate disablement of channel-startup supervision under CrabCast.** It
   * is written here because the alternative — leaving it to decline to start for
   * reasons a future reader has to reconstruct — is the defect this epic keeps
   * paying for: *a mechanism that is off because somebody decided so is a
   * decision; a mechanism that is off because it cannot find its footing is a
   * defect wearing a decision's clothes.*
   *
   * So: nothing below is a leg to be closed. If you arrived here intending to
   * make this fire, the thing to change first is the ruling, not the code.
   *
   * ---------------------------------------------------------------------------
   * WHY THERE IS NOTHING TO SUPERVISE — THREE INDEPENDENT REASONS
   * ---------------------------------------------------------------------------
   *
   * The one caller (`daemon.ts` → `superviseChannelStartup`, KAN-246) exists to
   * answer **one specific dialog**: the full-screen confirmation Claude Code
   * raises for `--dangerously-load-development-channels`. Each of the following
   * is on its own sufficient to make that job empty here.
   *
   * **1. The dialog cannot be raised on this path — structural, not observed.**
   * That flag is composed in exactly one place, `launchers.ts`
   * `developmentChannelFlags()`, and reaches an agent only as argv on a `claude`
   * command line. **`configure_agent` has no argv field**: {@link provision}
   * sends `path`, `priority`, `launcher`, `prompt` and `mcpServers`, and there is
   * no member of that frame through which a flag could travel. This file imports
   * nothing from `launchers.js`, so the flag has no route in even by accident.
   * A dialog whose trigger cannot be spelled cannot be met — and that is a claim
   * about the wire's shape rather than about how many spawns happened to be
   * clean.
   *
   * **2. Even if it fired, the listener returns immediately.** `daemon.ts` gates
   * on `spawn.channelEnabled !== true`, and {@link provision} deliberately does
   * not send CrabCast's `{"crabcast": "builtin"}` sentinel — giving Butchr's
   * agents a CrabCast channel is a cutover decision (KAN-294 item 5). So every
   * agent spawned through this runtime answers `channelEnabled: false`, honestly,
   * and `false` is a non-supervising verdict.
   *
   * **3. CrabCast publishes no spawn command line**, which is what made this
   * unfireable before either of the above was established. `activate_response`
   * carries `launcher` and twenty other fields and no argv. The interface
   * anticipates exactly this: *"A runtime that never spawns a pane of its own may
   * leave this unfired; the daemon installs a listener and does not require it to
   * be called."*
   *
   * ---------------------------------------------------------------------------
   * WHAT WAS MEASURED, AND THE BOUND ON IT
   * ---------------------------------------------------------------------------
   *
   * Reason 1 is the load-bearing one and it is structural. **The corroboration is
   * inherited and is cited as inherited**: `task/KAN-278` saw two cold `claude`
   * starts under this runtime meet no dialog, and `task/KAN-379` saw five more
   * (PR #164) — seven spawns on one machine, which is an observation rather than
   * a guarantee, and would be worth little on its own.
   *
   * **The bound, stated because reason 1 is narrower than "no dialog ever".** It
   * is a claim about the **dev-channels** dialog — the only one this supervision
   * answers. Other Claude Code startup dialogs exist, and what covers them here
   * is only the seven observations plus KAN-278's finding that CrabCast handles
   * folder trust itself (`hasTrustDialogAccepted: true` written by nothing on
   * Butchr's side). Those are `startup-dialog.ts`'s `FOREIGN_DIALOGS`
   * population, which this daemon refuses to answer anywhere — so a foreign
   * dialog under CrabCast is an agent that starts late and says so, not a channel
   * defect, and it is not what gate 3 asked about.
   *
   * ---------------------------------------------------------------------------
   * WHAT WOULD RE-OPEN THIS
   * ---------------------------------------------------------------------------
   *
   * Any one of: `configure_agent` growing a way to pass argv; this file acquiring
   * an import from `launchers.js`; or {@link provision} beginning to send the
   * `"builtin"` channel sentinel. The first two are what
   * `verify-crabcast-channel-startup-disablement.mjs` watches, because they are
   * the premises above rather than the conclusion — the conclusion is prose and
   * prose cannot go red.
   *
   * **`pressPaneKey` remains absent and that is now a fact about a capability we
   * do not need on this path, not an open gate.** `press_pane_key` answers
   * `Unknown action` — re-measured against the live peer at `contractVersion 8`,
   * build `9d4d999c`, on 2026-08-14 — and `send_to_agent` is not a substitute
   * because it opens with a Ctrl+C. It stays recorded as an interface observation
   * for KAN-59 (`epic/KAN-59` ruled the `pty_input` route out as a foundation),
   * and it stays out of the way of the cutover.
   */
  setAgentSpawnedListener(
    _listener: (session: HerdrSession, spawnedAt: number, spawn: AgentSpawn) => void
  ): void {
    this.log(
      'setAgentSpawnedListener: registered and never fired, DELIBERATELY (KAN-393 ruling). ' +
        'Channel-startup supervision is disabled under this runtime, not merely inert: the ' +
        'dev-channels dialog it exists to answer cannot be raised here, because configure_agent ' +
        'carries no argv and DEV_CHANNELS_FLAG reaches an agent only as argv. Independently, ' +
        'provision does not send the "builtin" channel sentinel, so channelEnabled is false and ' +
        "daemon.ts's listener would return at its first line anyway. " +
        'Gate 3 is not a cutover blocker. See the docblock for what would re-open it.'
    );
  }

  /**
   * CrabCast owns the brief file, and does not tell us where it put it
   * (KAN-400).
   *
   * **This is their decision, stated in their published contract, and it is a
   * good one.** `docs/callers-directory.md` at the pin records the bootstrap
   * prompt as *"moved out entirely"* into the agent's sidecar,
   * `<dataDir>/agents/<hash>/prompt.md`, and calls it *"the highest-value single
   * change here, because it was the file rewritten on every activation and
   * therefore the likeliest to show up as a spurious diff or be committed by
   * accident."* Their principle is that the caller's directory is the caller's;
   * `.mcp.json` is the one exception, and only because Claude Code reads MCP
   * configuration from the project root *"and from nowhere else"*.
   *
   * **So this returns prose and not a path, because a path is not obtainable.**
   * Three independent reasons, any one of which is enough: `<dataDir>` is a
   * config knob of theirs (default `~/.local/share/crabcast`), the sidecar is
   * keyed by a hash they mint, and no prompt path crosses the wire at all —
   * `configure_agent` echoes the prompt as a **character count**. Composing a
   * path out of their layout would be reading their internals by another route,
   * and it would break silently the day either half moved. Invariant 10 is why
   * we would not, and the wire is why we could not.
   *
   * **What the agent gets instead is strictly better than a path we invented**,
   * because CrabCast already hands it one: it types
   * `Please read and follow the instructions in <abs path> to begin.` at the
   * pane, which is how the agent read the brief in the first place. The pointer
   * is in the agent's own first turn. Naming that is naming something it can
   * act on; naming `.butchr-prompt.md` was naming a file that is not there.
   */
  briefLocation(_type: string, _key: string): BriefLocation {
    return {
      kind: 'runtime-owned',
      pointer:
        'the file named by the "Please read and follow the instructions in … to begin." ' +
        'line at the start of this session (CrabCast, the runtime that started you, ' +
        'writes the brief into a directory of its own and discloses no path for it, ' +
        'so that pointer line is the only thing that names it)'
    };
  }

  /**
   * `configure_agent` then `activate_agent` — two calls, both asynchronous,
   * behind a signature that is synchronous and must return a session now.
   *
   * The session is returned in `'initializing'`, which is what that state is
   * for, and is promoted to `'active'` when the activation answers. A failure
   * lands in `spawnError`, which the interface documents as the difference
   * between "this agent is quiet" and "this agent was never created".
   *
   * **`HerdrSession.sessionId` stays Butchr's own.** CrabCast mints its own id
   * and we keep it in {@link remoteIds} rather than swapping it into the object
   * the caller is already holding — a caller that read `session.sessionId` and
   * then found it renamed would be holding a key that addresses nothing.
   *
   * **`mcpServers` arrives prepared, and KAN-398 is why the type says so.** This
   * runtime sends the definitions over the wire and CrabCast writes them into
   * `.mcp.json` verbatim — their own word on that verb — so anything not done to
   * them before they get here is not done at all. It used to be nothing:
   * `pathPrefix` crossed the wire as a key no MCP client reads, and the core
   * server went unstamped, undoing KAN-157 and KAN-145 together on this path
   * while `HerdrBridge` did both correctly. Neither implementation was wrong on
   * its own; the transforms simply had no home that both could share. They have
   * one now, above this seam, and {@link WorkspaceMcpServers} is what makes
   * arriving without them a compile error rather than a defect somebody has to
   * notice. **Nothing is applied here, and nothing should be**: this file
   * imports no transform, which is also what keeps §1 of gate 3's guard intact.
   */
  spawnSession(
    type: string,
    key: string,
    url: string | undefined,
    promptContent: string,
    priority: number,
    supervisor: boolean,
    defaultAgent?: string,
    mcpServers?: WorkspaceMcpServers,
    resume?: ResumeCause
  ): HerdrSession {
    const existing = this.sessionForAddress(type, key);
    if (existing && existing.status !== 'terminated') {
      this.log(`reusing live session ${existing.sessionId} for ${agentNameFor(type, key)}`);
      return existing;
    }

    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    const workDir = pathForAddress(type, key);

    // **Butchr creates the directory, because CrabCast will not.** Their north
    // star 3 is that an agent IS a canonical filesystem path and the caller owns
    // it — `configure_agent` refuses a path that does not exist rather than
    // making one. `HerdrBridge` happens to mkdir in the same place, so this is
    // not new behaviour; it is the same behaviour becoming this side's explicit
    // job. It is the exact mirror of {@link resetWorkspace}: the whole lifecycle
    // of the directory is ours under this runtime, both ends of it.
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    const session: HerdrSession = {
      sessionId,
      type,
      key,
      url,
      createdAt: new Date(),
      status: 'initializing',
      workDir,
      ptyBuffer: '',
      onDataListeners: [],
      ptyDiscontinuities: [],
      expectsRuntime: defaultAgent !== 'shell',
      ...(resume ? { resume } : {})
    };
    this.sessions.set(sessionId, session);

    void this.provision(session, promptContent, priority, supervisor, defaultAgent, mcpServers).catch((err) => {
      session.status = 'terminated';
      session.spawnError = err instanceof Error ? err.message : String(err);
      this.log(`spawn failed for ${agentNameFor(type, key)}: ${session.spawnError}`);
    });

    return session;
  }

  private async provision(
    session: HerdrSession,
    promptContent: string,
    priority: number,
    supervisor: boolean,
    defaultAgent?: string,
    mcpServers?: WorkspaceMcpServers
  ): Promise<void> {
    const configure = buildConfigureAgentPayload({
      session,
      priority,
      supervisor,
      promptContent,
      defaultAgent,
      mcpServers
    });
    // WHAT THE PAYLOAD CARRIES is {@link buildConfigureAgentPayload}'s to say,
    // including why `mcpServers` is the field name and what is deliberately not
    // sent. What is left here is the one thing that is not payload construction
    // at all: a write to the workspace's own `.mcp.json`, which has to happen
    // before the call rather than inside the thing being called.
    //
    // The condition is the SAME one the builder uses to decide whether to send
    // the field, and it is repeated rather than derived because the two are
    // answering different questions that happen to agree: *"is there anything to
    // send"* and *"is there anything whose residue could collide"*. Reading it
    // back off `configure.mcpServers` would couple the clearance to the payload's
    // shape, which is the coupling the builder exists to remove.
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      // GATE 2 (KAN-474). Clear Butchr's own entries out of the workspace's
      // `.mcp.json` before CrabCast is asked to write into it.
      //
      // Without this, `configure_agent` refuses every activation whose
      // workspace has ever been started under herdr — which on 2026-08-15 was
      // 368 of 372 workspaces, and was 36 spawn failures and 0 activations
      // across four human-driven cutover attempts. The refusal is CrabCast
      // working as designed and is not theirs to relax: the entries really were
      // written by somebody else, and that somebody is us.
      //
      // WHY HERE, AND NOT AT THE WRITE. There is no write to suppress on this
      // path. `writeWorkspaceMcpConfig` lives in `HerdrBridge` and
      // `runtime-switch.ts` builds exactly one runtime at boot, so under
      // CrabCast it never runs. What collides is what the *previous* runtime
      // left on disk, so the repair belongs at the moment of provisioning, on
      // the workspace being provisioned.
      //
      // WHICH MAKES THE 368 EXISTING FILES A NON-EVENT, and that is the reason
      // for this shape rather than a migration script: each workspace is
      // repaired by its own first CrabCast activation, in the same call that
      // needed it. There is no sweep to order, nothing to run before a flip,
      // and no window in which a workspace created after the sweep is broken
      // again. A backfill would have covered only the workspaces that existed
      // when it ran — and herdr *rewrites* this file on every activation, so a
      // rollback would regrow exactly what the sweep had cleared.
      //
      // ROLLBACK IS SELF-HEALING FOR THE SAME REASON: nothing here runs under
      // herdr, and the first herdr activation after a rollback rewrites the
      // entries this removed.
      //
      // Disclosed at every outcome, including the ones that changed nothing. A
      // cutover that failed four times on this file is one where "there was
      // nothing to clear" and "we cleared nothing" must not read alike in the
      // log.
      const clearance = clearWorkspaceMcpResidue(
        session.type,
        session.key,
        Object.keys(mcpServers)
      );
      const agent = agentNameFor(session.type, session.key);
      switch (clearance.outcome) {
        case 'cleared':
          this.log(
            `${agent}: cleared Butchr's own MCP entries from ${WORKSPACE_MCP_CONFIG} before ` +
              `configure_agent — removed ${clearance.removed.map((n) => `'${n}'`).join(', ')}` +
              `${clearance.kept.length ? `, kept ${clearance.kept.map((n) => `'${n}'`).join(', ')}` : ''}. ` +
              'CrabCast writes them back from what we send it.'
          );
          break;
        case 'nothing-of-ours':
          this.log(
            `${agent}: ${WORKSPACE_MCP_CONFIG} holds none of the servers we are sending` +
              `${clearance.present.length ? ` (it defines ${clearance.present.map((n) => `'${n}'`).join(', ')})` : ''}, ` +
              'so there was nothing to clear.'
          );
          break;
        case 'absent':
          this.log(`${agent}: no ${WORKSPACE_MCP_CONFIG} in the workspace, so nothing to clear.`);
          break;
        case 'refused':
          // Deliberately not fatal. CrabCast's own refusal for a file it cannot
          // parse names the file and says NOTHING WAS STARTED, which is a
          // better error than any we would produce by destroying it first.
          this.log(
            `${agent}: left ${WORKSPACE_MCP_CONFIG} alone — ${clearance.reason} ` +
              'Proceeding; if it collides, CrabCast will refuse and say so.'
          );
          break;
      }
    }

    const configured = await this.link.request(configure);
    if (configured.success !== true) {
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'crabcast-daemon',
            `configure_agent refused: ${String(configured.error ?? 'no reason given')}`,
            'Read the refusal above; CrabCast states the binding constraint with its figures.'
          )
        )
      );
    }

    const activated = await this.link.request({ action: 'activate_agent', path: session.workDir });
    if (activated.success !== true) {
      // A capacity refusal lands here, and it arrives with CrabCast's own
      // derivation attached. Carrying their text verbatim is deliberate: their
      // figures are the product, and paraphrasing them would lose the terms.
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'crabcast-daemon',
            `activate_agent refused: ${String(activated.error ?? 'no reason given')}`,
            'Wait for room, stand an agent down, or read the derivation CrabCast printed.'
          )
        )
      );
    }

    const remoteId = typeof activated.sessionId === 'string' ? activated.sessionId : null;
    if (!remoteId) {
      throw new Error(
        renderRefusal(
          this.link.refusal(
            'butchr-adapter',
            'activate_agent answered success with no sessionId, so nothing can be addressed'
          )
        )
      );
    }
    this.remoteIds.set(session.sessionId, remoteId);

    // THE SPAWN'S CHANNEL VERDICT, TAKEN HERE BECAUSE HERE IS THE ONLY PLACE IT
    // IS AVAILABLE (KAN-294). `activate_response` is the surface that describes
    // *the spawn we just made*; `list_agents` — the only thing this runtime
    // polls — does not carry the field at all, confirmed row by row at the pin.
    // So this is not a cache of something re-readable: it is the record of a
    // fact that has no second source short of a per-agent `agent_status` round
    // trip, and the interface this serves is synchronous.
    //
    // Read through `readChannelEnabled` rather than inline, so that the one
    // place `null` could be flattened into `false` is a named function with a
    // proof pointed at it (`verify-channel-spawn-verdict.mjs` §2).
    this.channelEnabled.set(session.sessionId, readChannelEnabled(activated));

    // THE RESUME VERDICT, TAKEN HERE FOR THE SAME REASON AS THE CHANNEL ONE AND
    // FOR ONE STRONGER (KAN-432). `activate_response` is the only surface that
    // carries it — the census this runtime polls does not, and CrabCast's own
    // contract says the decision "is recorded nowhere" and cannot be recovered
    // from `everActivated` afterwards, because the activation that made it sets
    // `everActivated` to `true` on its way past. So this is not a cache of
    // something re-readable; it is the single moment the fact exists.
    //
    // WHAT WAS WRONG BEFORE THIS LINE. Nothing read the field at all — `grep -c
    // resumedExistingConversation` over this file answered `0` while the value
    // sat on the wire, published in read-path contract v8 and observed live by
    // `task/KAN-396`. `session.resumedConversation` therefore stayed
    // `undefined` for every agent this runtime ever spawned, and all four
    // readers of it tested `=== true`, so `undefined` read as *already
    // working*. Under CrabCast every resumed agent took the no-nudge branch
    // while sitting in the state the nudge exists for — and CrabCast resumes
    // any path it has run before, unasked, so after the cutover that is the
    // whole fleet at the first daemon restart.
    //
    // NOTHING IS ASKED FOR HERE, and that is the boundary this stays inside.
    // `activate_agent` is sent exactly as it was — `{ action, path }` — and no
    // resume key, documented or otherwise, is added. AC1 of KAN-396 established
    // that Butchr cannot *ask* for a resume and `epic/KAN-39` refused re-opening
    // it permanently. This reads an output they already publish and already
    // send; it does not reach for an affordance they have closed.
    session.resumedConversation = readResumedConversation(activated);

    session.status = 'active';
    this.log(
      `activated ${agentNameFor(session.type, session.key)} as ${remoteId} ` +
        `(channelEnabled=${JSON.stringify(readChannelEnabled(activated))}, ` +
        `resumedConversation=${session.resumedConversation}` +
        (session.resumedConversation === 'unknown'
          ? ' — CrabCast said nothing, which its contract makes the ordinary answer on the ' +
            'idempotent branch; this agent is NOT recorded as already-working'
          : '') +
        `)`
    );
  }

  /**
   * Whether the spawn behind a session was channel-capable, as CrabCast reported
   * it at activation. **Three states; `null` is not `false`.**
   *
   * `null` covers three genuinely different situations, and merging them here is
   * correct where merging them with `false` would not be: CrabCast said `null`
   * (no spawn to be about), CrabCast said nothing recognisable, or this adapter
   * has no record for the session. All three are *"no verdict"*, which is what
   * `null` means; none of them is *"there is no channel"*.
   *
   * Nothing branches on this yet, and that is stated rather than implied — see
   * {@link setAgentSpawnedListener} for why the one consumer cannot run under
   * this runtime. It is on {@link describe} so an operator can see it, and it is
   * the value the live proof asserts arrives.
   */
  channelEnabledFor(sessionId: string): boolean | null {
    return this.channelEnabled.get(sessionId) ?? null;
  }

  abandonSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = 'terminated';
    session.spawnError = error;
    this.endMirror(sessionId, 1);
  }

  terminateSession(sessionId: string): { success: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `No session ${sessionId}` };
    // Synchronous signature, asynchronous verb. The local record is marked
    // immediately because the caller's next read must not see a live session,
    // and the wire call is fired behind it. The honest limit: this returns
    // "asked", not "stopped" — CrabCast's own answer arrives later and is
    // logged. Callers that need "stopped" have `agent.detached`.
    session.status = 'terminated';
    void this.link
      .request({ action: 'deactivate_agent', path: session.workDir })
      .then((res) => {
        if (res.success !== true) this.log(`deactivate refused for ${session.workDir}: ${String(res.error)}`);
      })
      .catch((err) => this.log(`deactivate failed for ${session.workDir}: ${err.message}`));
    this.endMirror(sessionId, 0);
    return { success: true };
  }

  /**
   * **Absent on CrabCast, by their design — and served by Butchr since KAN-380,
   * which is a different thing from absent.**
   *
   * Verified from the wire: `reset_workspace` and `reset_agent` both answer
   * with a refusal that states the reason outright — *"`reset` was removed:
   * CrabCast no longer creates the directory an agent runs in, so it may not
   * delete one either."* That is KAN-59's north star 3 (*an agent IS a
   * canonical filesystem path; the caller owns the directory*), not an
   * oversight, and it will not be coming back. **Nothing here asks them to
   * change it**, and this method makes no wire call at all.
   *
   * **It is the exact mirror of {@link spawnSession}, and that symmetry is the
   * argument.** Butchr already creates the directory under this runtime because
   * CrabCast will not; owning creation and disowning deletion is the asymmetry
   * that made a "reset" here leave the previous agent's files in place under
   * the same key — invariant 7 broken at the moment it matters most, since a
   * reset is precisely when somebody is relying on nothing being left behind.
   *
   * **The deletion is not reimplemented here.** It goes through
   * `deleteWorkspaceDir`, the same function `HerdrBridge.resetWorkspace` calls,
   * whose containment discipline and structural guard are documented in
   * `workspace-dir.ts`. This runtime holds no second opinion about which
   * directories Butchr may destroy, and the address it passes is the same
   * `(type, key)` its own `pathForAddress` translates — there is no path
   * parameter to get wrong.
   */
  resetWorkspace(type: string, key: string): { success: boolean; error?: string } {
    return deleteWorkspaceDir(type, key);
  }

  closeAgentByKey(
    key: string,
    type?: string
  ): { success: boolean; agentName?: string; error?: string } {
    const addressed = this.addressedSession(key, type);
    if (addressed.outcome !== 'one') return { success: false, error: addressed.error };
    const session = addressed.session;
    const result = this.terminateSession(session.sessionId);
    return { ...result, agentName: agentNameFor(session.type, session.key) };
  }

  // ── lookup ───────────────────────────────────────────────────────────────

  getSession(sessionId: string): HerdrSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByAddress(key: string, type: string): HerdrSession | undefined {
    return this.sessionForAddress(type, key);
  }

  /**
   * Ambiguity as an outcome, for a caller holding only a key. See
   * {@link SessionAddressResolution} — the rule itself is shared with the local
   * runtime so that one key cannot mean two different things depending on which
   * runtime is wired in.
   */
  resolveSessionByAddress(key: string, type?: string): SessionAddressResolution {
    if (type) {
      const session = this.sessionForAddress(type, key);
      return session ? { outcome: 'one', session } : { outcome: 'none' };
    }
    return resolveAmongSessions(this.sessionsForKey(key));
  }

  listActiveSessions(): HerdrSession[] {
    return [...this.sessions.values()].filter((s) => s.status !== 'terminated');
  }

  describeAgent(key: string, type?: string): HerdrAgentDescription {
    const resolvedType = type ?? this.soleSessionForKey(key)?.type ?? null;
    // `agentNameFor('?', key)` rather than a hand-built `butchr-?-<key>`
    // template (KAN-406). The two produce the identical string — `?` is simply
    // the type, spelled as the unknown it is — so this is the same name it
    // always was, produced through the one producer instead of alongside it.
    // Writing the template here would have needed a second cast to
    // `ButchrAgentName`, and a brand with scattered casts means only "somebody
    // asserted this here", which is the review catch the brand replaces.
    // `||` and not `??`, deliberately: the original was a TRUTHY test, so an
    // empty-string type fell to the `?` placeholder. `??` catches only
    // null/undefined, so it would diverge on **two** members of the domain
    // rather than one, silently in both cases — `''` would spell
    // `butchr--<key>` and `0` would spell `butchr-0-<key>`. `resolvedType` is
    // typed `string | null` so `0` should not arrive; it is named because the
    // truthy/nullish distinction is what makes this line correct, and a later
    // reader retyping the field is exactly who needs to know that.
    const agentName = agentNameFor(resolvedType || '?', key);
    const dir = resolvedType ? pathForAddress(resolvedType, key) : null;
    // **The `paneName` join below is RIGHT, and stays (KAN-397 AC3).** It reads
    // like the defect that ticket fixed and is not one, for two reasons worth
    // writing down rather than re-deriving:
    //
    //   - **It is a fallback the affected population never reaches.** An agent
    //     CrabCast started sits in `census.rows` at its workspace path, so the
    //     `path === dir` join above matches it and this line is not evaluated.
    //     That is why `describeAgent` was already correct while
    //     `confirmAgentPresent` was not: this method joins on the path first and
    //     `confirmAgentPresent` had no path join at all.
    //   - **For what it does search, `paneName` IS the Butchr name.**
    //     `census.foreign` is panes CrabCast can see and does not own; herdr
    //     names its own panes `butchr-<type>-<key>`, which is exactly what
    //     `agentName` holds.
    //
    // Substituting `butchrNameForCensusRow` here would be identical for every
    // pane outside the workspace tree (the derivation falls back to `paneName`
    // for those) and would CHANGE behaviour for one case nobody has evidence
    // about: a foreign pane whose `workDir` is inside a Butchr workspace — a
    // human's own terminal opened there — which would start being reported as
    // that workspace's agent. Uniform, and wrong. So it is left alone.
    //
    // KAN-406 branded the two name types, which makes the raw
    // `r.paneName === agentName` spelling of this line a compile error. **The
    // comparison is unchanged** — it moved into
    // `paneIsNamedAsHerdrWouldName`, which widens both sides for exactly this
    // case and carries the two reasons above in its own docblock. The point is
    // that the correct comparison no longer LOOKS identical to the defect.
    const row =
      (dir ? this.census.rows.find((r) => r.path === dir) : undefined) ??
      this.census.foreign.find((r) => paneIsNamedAsHerdrWouldName(r, agentName));
    return {
      agentName,
      type: resolvedType,
      workDir: row?.workDir ?? row?.path ?? dir,
      herdrStatus: asHerdrStatus(row?.herdrStatus)
    };
  }

  /**
   * Served entirely locally, and that is correct rather than a shortcut.
   *
   * `type` is Butchr's vocabulary — CrabCast has no notion of one, by their
   * north star 4 (*no consumer's vocabulary lives inside it*), and an agent
   * there is a bare directory path. So there is nothing to ask: the mapping
   * from a key to a type is a fact about this daemon's own sessions.
   *
   * Throws on an unknown or ambiguous key, exactly as the interface requires,
   * so an unaddressable key stays unaddressable rather than silently reaching
   * the wrong agent.
   */
  resolveAddress(key: string, type?: string): { type: string; key: string } {
    if (type) return { type, key };
    const matches = [...this.sessions.values()].filter(
      (s) => s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
    if (matches.length === 1) return { type: matches[0].type, key: matches[0].key };
    if (matches.length === 0) throw new Error(`No agent named ${key}`);
    throw new Error(
      `Ambiguous key ${key}: ${matches.map((m) => `${m.type}/${m.key}`).join(', ')}. Pass a type.`
    );
  }

  // ── the runtime's own census ─────────────────────────────────────────────

  herdrReachable(): boolean {
    return this.link.connected && this.census.reachable;
  }

  listHerdrAgents(): HerdrAgentRecord[] {
    return this.censusRecords();
  }

  listHerdrAgentsChecked(): CensusReading {
    // The distinction this method exists for survives intact here, and it is
    // the one CrabCast's north star 2 and Butchr's both insist on: `reachable`
    // is a claim about whether the census could be TAKEN, never about whether
    // it found anything.
    //
    // KAN-324 adds a second distinction of the same species one level down:
    // `agents` is what the census found, and `unreadableRecordsTotal` is how
    // much of the registry it could not look at. A disconnected link discloses
    // `null` for the same reason it reports no agents — there is no reading to
    // qualify, and `0` would claim there was one.
    if (!this.link.connected) {
      return { reachable: false, agents: [], unreadableRecordsTotal: null, unreadableRecords: [] };
    }
    return {
      reachable: this.census.reachable,
      agents: this.censusRecords(),
      unreadableRecordsTotal: this.census.unreadableRecordsTotal,
      unreadableRecords: this.census.unreadableRecords
    };
  }

  listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    const out = new Map<string, HerdrAgentStatus>();
    for (const record of this.censusRecords()) out.set(record.name, record.herdrStatus);
    return out;
  }

  async confirmAgentPresent(
    agentName: ButchrAgentName,
    requireRuntime: boolean,
    timeoutMs = 10_000
  ): Promise<AgentPresence> {
    const startedAt = Date.now();
    let checks = 0;
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
      checks++;
      try {
        const res = await this.link.request({ action: 'list_agents' });
        if (res.success === true) {
          const rows = this.readCensus(res);
          const all = [...rows.rows, ...rows.foreign];
          // KAN-397: derived from the row's path, never the raw `paneName` —
          // the agents this runtime spawns are precisely the ones whose
          // `paneName` is CrabCast's, so a `paneName` join here could not
          // succeed for them. Same derivation as `censusRecords()`, because it
          // is the same function.
          const match = all.find((r) => butchrNameForCensusRow(r) === agentName);
          if (match && (!requireRuntime || match.agentRuntime !== null)) {
            return { present: true, waitedMs: Date.now() - startedAt, checks };
          }
          lastError = match
            ? `pane ${agentName} exists but CrabCast reports no agent runtime behind it`
            : `no pane named ${agentName} in CrabCast's census`;
        } else {
          lastError = String(res.error ?? 'list_agents answered success: false');
        }
      } catch (err) {
        // Could not ask. That is `unverifiable`, never `absent` — the whole
        // point of the two-reason split is that nothing may be concluded from
        // a census that did not happen.
        return {
          present: false,
          reason: 'unverifiable',
          error: err instanceof Error ? err.message : String(err),
          waitedMs: Date.now() - startedAt,
          checks
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      present: false,
      reason: 'absent',
      error: lastError || `${agentName} did not appear within ${timeoutMs}ms`,
      waitedMs: Date.now() - startedAt,
      checks
    };
  }

  // ── talking to an agent ──────────────────────────────────────────────────

  /**
   * **Served for real, over the wire — this is what KAN-283 unblocked.**
   *
   * KAN-278 found this method refusing while CrabCast's own `tail_agent`
   * answered `success`, `text`, `truncated`, `source` and `sourcesTried`, with
   * `source` drawn from the same `'recent-unwrapped' | 'visible'` pair Butchr's
   * own {@link TailSource} uses. **The data was there and our signature could
   * not reach it**: `AgentRuntime.tailAgent` was synchronous, a tail is the one
   * read where a cached answer is the wrong answer, and so the mirror strategy
   * that correctly serves the census group was unavailable. The interface is
   * `Promise`-returning now and the refusal is gone.
   *
   * ## Three things confirmed from the wire rather than from their document
   *
   * Driven against a live daemon at `6f47df7d` (contract v6 — **past our pin**,
   * so these are claims about that build, not about `CRABCAST_PIN`):
   *
   * 1. **`path` is required and must exist.** Omitting it answers *"Missing or
   *    invalid path: an agent is addressed by the directory it runs in"*; a path
   *    that is not there answers `ENOENT` with their reason that the filesystem
   *    is the typo-checker. Both are `success: false`.
   * 2. **`sourcesTried` comes back on the refusal too**, carrying both sources
   *    — so their `success: false` is a claim about the READ in the same sense
   *    ours is, and the field maps straight across.
   * 3. **They can only tail an agent CrabCast itself configured.** Their agent
   *    name is derived from the path (`crabcast-<leaf>-<hash>`), so a pane
   *    *herdr* owns under a Butchr name is `not found` even though
   *    `list_agents` reports it under `foreignPanes`. That is honest rather than
   *    broken — see the note on the fall-through below — and it is why this
   *    method is not a general pane reader under this runtime.
   *
   * ## What is deliberately NOT done here
   *
   * **No fallback to a mirror, and no synthesised empty pane.** A failed read
   * stays `success: false` with the refusal carried verbatim. Returning
   * `success: true, text: ''` on a refusal is the precise defect
   * {@link AgentRuntime.tailAgent}'s contract was written to forbid — a claim
   * about the agent manufactured out of a fact about the read — and it is the
   * one this method must never introduce now that it has a wire to fail on.
   */
  async tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): Promise<{
    success: boolean;
    text?: string;
    truncated?: boolean;
    source?: TailSource | null;
    sourcesTried?: TailSource[];
    /** Set only for an AMBIGUOUS bare key — see {@link AgentRuntime.tailAgent}. */
    candidates?: string[];
    error?: string;
  }> {
    // ADDRESSED THE SAME WAY `describeAgent` IS, so one key cannot mean two
    // agents depending on which method asked. A bare key is resolved through
    // our own session table because `type` is Butchr's vocabulary and CrabCast
    // has none — their north star 4.
    //
    // A key naming two agents REFUSES rather than reading one of them (KAN-473).
    // Answered rather than thrown, because this method's contract is to answer:
    // a read that quietly picks is the worse half of that ticket, since nothing
    // downstream can tell whose pane it was handed.
    const addressed = this.addressedSession(key, type);
    if (addressed.outcome === 'ambiguous') {
      return { success: false, error: addressed.error, candidates: addressed.candidates };
    }
    const resolvedType = type ?? addressed.session?.type ?? null;
    if (!resolvedType) {
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal(
            'butchr-adapter',
            `tailAgent(${key}) cannot be addressed: no type was given and no session this ` +
              'daemon started names that key, so there is no path to ask CrabCast about',
            'Pass a type, or address an agent this daemon spawned.'
          )
        )
      };
    }

    const dir = pathForAddress(resolvedType, key);
    try {
      const res = await this.link.request({
        action: 'tail_agent',
        path: dir,
        ...(lines === undefined ? {} : { lines })
      });

      if (res.success !== true) {
        // THEIR REFUSAL, CARRIED VERBATIM AND NOT PARSED. `sourcesTried` is
        // passed through when they send it because it is the same field with the
        // same meaning — "we looked here" — and dropping it would lose the only
        // evidence that the read was attempted twice.
        return {
          success: false,
          error: renderRefusal(
            this.link.refusal(
              'crabcast-daemon',
              `tail_agent(${resolvedType}/${key}) refused: ` +
                String(res.error ?? 'no reason given'),
              'Start a CrabCast daemon addressing that socket if it is down, or unset ' +
                'BUTCHR_AGENT_RUNTIME to serve tails from the default herdr runtime, which ' +
                'needs no peer. Note that CrabCast can only tail an agent it configured ' +
                'itself: a pane herdr owns under a Butchr name is not theirs to read.'
            )
          ),
          ...(Array.isArray(res.sourcesTried)
            ? { sourcesTried: narrowTailSources(res.sourcesTried) }
            : {})
        };
      }

      // `text` MUST BE A STRING TO BE A SUCCESSFUL READ. A `success: true` with
      // no text is not an empty pane — it is a response we cannot interpret, and
      // the honest report of one is that we could not look.
      if (typeof res.text !== 'string') {
        return {
          success: false,
          error: renderRefusal(
            this.link.refusal(
              'crabcast-daemon',
              `tail_agent(${resolvedType}/${key}) answered success without text ` +
                `(text was ${typeof res.text}), so what is on the pane is UNKNOWN rather ` +
                'than empty',
              'This is an interface observation for KAN-59, not a change request.'
            )
          ),
          ...(Array.isArray(res.sourcesTried)
            ? { sourcesTried: narrowTailSources(res.sourcesTried) }
            : {})
        };
      }

      // `source: null` WITH `success: true` IS "EVERY SOURCE WAS ASKED AND EVERY
      // ONE WAS EMPTY", and it is the assertion `superviseChannelStartup` and
      // `readLandedCount` are entitled to rely on. It is carried through as
      // `null` rather than dropped: an absent `source` and a `null` one are the
      // same fact here only because their empty answer spells it the same way,
      // and `?? null` says so once instead of leaving it to each caller.
      return {
        success: true,
        text: res.text,
        truncated: res.truncated === true,
        source: narrowTailSource(res.source),
        ...(Array.isArray(res.sourcesTried)
          ? { sourcesTried: narrowTailSources(res.sourcesTried) }
          : {})
      };
    } catch (e: any) {
      // A LINK THAT IS DOWN IS A READ WE COULD NOT MAKE, never an empty pane.
      //
      // RE-HEADLINED RATHER THAN CARRIED, and the reason is the one thing this
      // path has that the link's generic refusal does not: a remedy that is
      // *specific to a tail*. `request` rejects with `unreachable()`, whose
      // remedy is the right general advice — start a daemon, or unset the
      // switch — and a reader looking at a failed tail wants to be told that
      // **the default herdr runtime serves tails with no peer at all**. The
      // figures are not lost: `link.refusal()` regenerates socket, errno,
      // attempts, downFor and last-good from the same link, and the original
      // message is appended so nothing the link said is discarded.
      return {
        success: false,
        error: renderRefusal(
          this.link.refusal(
            'crabcast-socket',
            `tail_agent(${resolvedType}/${key}) could not be sent: ` +
              String(e?.message ?? e),
            'Start a CrabCast daemon addressing that socket, or unset ' +
              'BUTCHR_AGENT_RUNTIME to serve tails from the default herdr runtime, which ' +
              'needs no peer.'
          )
        )
      };
    }
  }

  /**
   * **Absent.** CrabCast has no `press_pane_key`: verified from the wire, where
   * it answers `Unknown action`. Its `send_to_agent` is not a substitute — that
   * verb opens with a Ctrl+C (its response reports `interrupts: 1`), which is
   * precisely what this method exists **not** to do. Its one caller answers a
   * full-screen startup dialog that is blocking a session's own boot, where a
   * Ctrl+C would cancel the boot it is trying to unblock.
   *
   * `pty_input` can carry a raw keystroke, but only for a session with a live
   * pty mirror, and the caller here has a *pane* and no session. Pretending
   * otherwise would answer a different question.
   *
   * Throws, as the interface requires of a runtime that cannot reach the pane.
   */
  pressPaneKey(key: string, type: string | undefined, keyName: string): void {
    throw new Error(
      renderRefusal(
        this.link.refusal(
          'butchr-adapter',
          `pressPaneKey(${type ?? '*'}/${key}, ${keyName}) has no CrabCast counterpart — ` +
            'there is no press_pane_key action, and send_to_agent opens with a Ctrl+C, which ' +
            'is the one thing this method must not do',
          'This is an interface observation for KAN-59, not a change request. Channel startup ' +
            'supervision (KAN-246) is inert under this runtime; it is off by default.'
        )
      )
    );
  }

  async sendToAgent(
    key: string,
    message: string,
    type?: string
  ): Promise<{ success: boolean; error?: string }> {
    const addressed = this.addressedSession(key, type);
    if (addressed.outcome !== 'one') return { success: false, error: addressed.error };
    const session = addressed.session;
    try {
      const res = await this.link.request({
        action: 'send_to_agent',
        path: session.workDir,
        message
      });
      if (res.success !== true) {
        return { success: false, error: String(res.error ?? 'send_to_agent answered success: false') };
      }
      // CrabCast answers richer than this interface can carry: `delivered`,
      // `verdict`, `interrupts`, `submits` and an `evidence` block. The
      // interface takes a boolean, and the honest mapping is their `delivered`
      // rather than the bare `success` — `success` says the call worked,
      // `delivered` says the keystrokes landed, and this method's contract is
      // about the typing.
      const delivered = res.delivered === true;
      return delivered
        ? { success: true }
        : { success: false, error: `CrabCast verdict: ${String(res.verdict ?? 'not delivered')}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── pty: KAN-224's design, implemented ───────────────────────────────────

  /**
   * **Returns "do I have this session?", and the ack is read behind it**
   * (KAN-459).
   *
   * The boolean is the whole of what this method promises, and it is the same
   * promise `HerdrBridge.writePty` makes: a local lookup, never "did the bytes
   * reach the pty". That much was always true and is unchanged.
   *
   * **What is not fire-and-forget is the frame.** `CrabCastLink.request`
   * attaches an `id` to every frame it sends — there is no id-less path — so
   * CrabCast acks every keystroke, and the ack is already on the wire whether
   * or not anything reads it. This method therefore does not *choose* to spend
   * a round trip by observing the answer: the round trip is spent either way,
   * and until KAN-459 the answer was thrown away by the `void` in front of it.
   * Nothing here awaits, so no caller gains a per-keystroke wait.
   *
   * This is `terminateSession`'s shape — a synchronous signature over an
   * asynchronous verb, returning "asked" and logging what came back — applied
   * to the one pair of methods that had it and did not use it.
   */
  writePty(sessionId: string | undefined, data: string): boolean {
    // Narrowed rather than asserted: `remoteFor` already returns null for a
    // falsy id, so this branch is unreachable — but the narrowing is what lets
    // `sessionId` be a `string` below without a `!`.
    if (!sessionId) return false;
    const remote = this.remoteFor(sessionId);
    if (!remote) return false;
    this.observePtyWrite(
      'pty_input',
      sessionId,
      remote,
      this.link.request({ action: 'pty_input', sessionId: remote, data })
    );
    return true;
  }

  resizePty(sessionId: string | undefined, cols: number, rows: number): boolean {
    if (!sessionId) return false;
    const remote = this.remoteFor(sessionId);
    if (!remote) return false;
    this.observePtyWrite(
      'pty_resize',
      sessionId,
      remote,
      this.link.request({ action: 'pty_resize', sessionId: remote, cols, rows })
    );
    return true;
  }

  /**
   * Read a pty write's ack without waiting for it.
   *
   * **The two outcomes are kept apart because they are different claims**, and
   * collapsing them is what `CrabCastLink.request`'s own docblock exists to
   * prevent: a rejection is *"we could not ask"*, and `success: false` is *"we
   * asked and it said no"*. An operator seeing `refused` knows CrabCast is
   * reachable and has disowned the session; `undelivered` says nothing about
   * the session at all.
   *
   * **Logging is first-of-kind per session and verb, and the counter is the
   * authority.** A stale session under a held-down key refuses once per
   * keystroke, so a line per refusal would be a log storm keyed to typing
   * speed. The first line says more may follow silently; {@link describe}
   * carries the count that does not lie.
   */
  private observePtyWrite(
    action: PtyWriteAction,
    sessionId: string,
    remote: string,
    answer: Promise<Record<string, unknown>>
  ): void {
    void answer.then(
      (res) => {
        if (res.success === true) return;
        this.recordPtyWriteOutcome('refused', action, sessionId, remote, {
          refusal: typeof res.refusal === 'string' ? res.refusal : null,
          detail: String(res.error ?? 'no reason given')
        });
      },
      (err: unknown) => {
        this.recordPtyWriteOutcome('undelivered', action, sessionId, remote, {
          refusal: null,
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    );
  }

  private recordPtyWriteOutcome(
    outcome: PtyWriteOutcome,
    action: PtyWriteAction,
    sessionId: string,
    remote: string,
    reason: { refusal: string | null; detail: string }
  ): void {
    this.ptyWrites[outcome]++;
    this.ptyWrites.last = {
      outcome,
      action,
      sessionId,
      refusal: reason.refusal,
      detail: reason.detail,
      at: new Date().toISOString()
    };
    const key = `${outcome}:${action}:${sessionId}`;
    if (this.ptyWritesLogged.has(key)) return;
    this.ptyWritesLogged.add(key);
    this.log(
      `${action} ${outcome} for session ${sessionId} (CrabCast ${remote})` +
        `${reason.refusal ? ` [${reason.refusal}]` : ''}: ${reason.detail} ` +
        `— further ${outcome} ${action} on this session are counted, not logged`
    );
  }

  /**
   * Never touches the socket — the point of KAN-224's design.
   *
   * The cross-process subscription is per **session** and is opened once, by
   * {@link ensureMirror}. This call pushes onto a local array and returns a
   * closure that filters it back out, which is the same operation with the same
   * semantics as `HerdrBridge`'s. That is what makes CrabCast's missing detach
   * verb a non-problem rather than a blocker.
   */
  registerDataListener(
    sessionId: string | undefined,
    listener: PtyStreamListener
  ): (() => void) | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const mirror = this.ensureMirror(sessionId);
    if (!mirror) return undefined;
    mirror.listeners.push(listener);
    return () => {
      mirror.listeners = mirror.listeners.filter((fn) => fn !== listener);
    };
  }

  private ensureMirror(sessionId: string): PtyMirror | undefined {
    const existing = this.ptyMirrors.get(sessionId);
    if (existing) return existing;
    const remote = this.remoteFor(sessionId);
    if (!remote) return undefined;

    const mirror: PtyMirror = {
      remoteSessionId: remote,
      buffer: '',
      listeners: [],
      state: 'subscribing',
      generation: 0,
      gaps: 0,
      openGap: null
    };
    this.ptyMirrors.set(sessionId, mirror);
    void this.subscribeMirror(sessionId, mirror);
    return mirror;
  }

  private async subscribeMirror(sessionId: string, mirror: PtyMirror): Promise<void> {
    const generation = ++mirror.generation;
    try {
      const { buffer } = await this.link.ptyInit(mirror.remoteSessionId, (data) => {
        // Appended AND fanned out — the snapshot is neither. Two destinations
        // with no overlap is what makes duplication structurally impossible.
        mirror.buffer = (mirror.buffer + data).slice(-PTY_BUFFER_LIMIT);
        const session = this.sessions.get(sessionId);
        if (session) session.ptyBuffer = mirror.buffer;
        for (const fn of mirror.listeners) fn({ kind: 'data', data });
      });
      // A `pty_init` that resolves after a later drop is answering about a
      // connection that is gone. Promoting on it would put `'live'` on a mirror
      // with no subscription — this ticket's defect, reached by a race rather
      // than by omission.
      if (generation !== mirror.generation) return;
      // Replaces, never appends. Appending the snapshot is the duplication bug
      // in its most tempting form (KAN-224 §3.5).
      mirror.buffer = buffer.slice(-PTY_BUFFER_LIMIT);
      mirror.state = 'live';
      const session = this.sessions.get(sessionId);
      if (session) session.ptyBuffer = mirror.buffer;
      // **Closed AFTER the buffer is replaced, never before.** The marker says
      // the repair finished, and a consumer told so while the snapshot has not
      // landed would read a stale buffer under a fresh verdict.
      this.closeGap(sessionId, mirror, 'succeeded');
    } catch (err) {
      if (generation !== mirror.generation) return;
      const detail = err instanceof Error ? err.message : String(err);
      // **A failed subscribe with the link down is NOT an ended mirror**, and
      // conflating them is how a session becomes permanently unwatched: `ended`
      // is terminal, so the reconnect sweep below skips it and nothing ever
      // subscribes again. `stale` says the pane is still there and we are not
      // listening — which is the truth, and is what the sweep picks up.
      if (!this.link.connected) {
        mirror.state = 'stale';
        this.openGap(sessionId, mirror);
        if (mirror.openGap) mirror.openGap.error = detail;
        this.log(`pty mirror for ${sessionId} could not subscribe (link down): ${detail}`);
        return;
      }
      mirror.state = 'ended';
      this.closeGap(sessionId, mirror, 'failed', detail);
      this.log(`pty mirror for ${sessionId} failed: ${detail}`);
    }
  }

  // ── reconnect resync and the discontinuity it discloses (KAN-381) ─────────

  /**
   * The link came back, or went away. Mirrors are the state that does not
   * survive that, so this is where they are repaired and where the gap is
   * disclosed.
   *
   * **Both halves matter and the second matters more.** Re-subscribing makes
   * the mirror current again; it does nothing about the window in which events
   * were produced and not seen, and a resync that silently succeeded is
   * indistinguishable from one that silently half-succeeded without a marker.
   * So the discontinuity is opened on the drop, unconditionally, and closed on
   * the outcome — never conditioned on whether the repair worked.
   */
  private onLinkState(event: LinkStateEvent): void {
    if (event.state === 'disconnected') {
      let opened = 0;
      for (const [sessionId, mirror] of this.ptyMirrors) {
        // `ended` mirrors have no subscription to lose. `stale` ones already
        // hold an open gap; re-opening would report one drop as two.
        if (mirror.state !== 'live' && mirror.state !== 'subscribing') continue;
        mirror.state = 'stale';
        // Bump the generation so an in-flight `pty_init` from before the drop
        // cannot resolve into `live` behind our backs.
        mirror.generation++;
        this.openGap(sessionId, mirror, event.at);
        opened++;
      }
      this.log(
        `link dropped (connection #${event.connectionSeq}${event.errno ? `, ${event.errno}` : ''}): ` +
          `${opened} pty mirror(s) marked stale and disclosed as discontinuous. CrabCast's own ` +
          `subscriptions died with the socket, so nothing is streaming to us until we re-subscribe.`
      );
      return;
    }

    void this.resyncMirrors(event);
  }

  /**
   * Re-subscribe every stale mirror — **re-resolving its remote session id off a
   * fresh census first** (KAN-403).
   *
   * ## Why re-resolving, and why it is not a retry
   *
   * A restarted CrabCast re-adopts the agents in its durable registry at boot
   * and issues each a **new** `sessionId` for the same pane. Measured against a
   * real restart: the pane survived with its `paneId` and its whole scrollback
   * intact, and the id changed. So the id this daemon holds was issued by a
   * process that no longer exists, and `pty_init` on it is refused
   * `unknown_session` — with the link perfectly healthy, which is what made the
   * failure terminal: `subscribeMirror`'s connected-and-refused branch settles
   * the mirror `ended`, `ended` is terminal, and the sweep here skips it forever.
   * A live pane, a full scrollback, and Butchr rendering nothing at it until the
   * daemon restarts. **Every deploy did this, to every mirror.**
   *
   * **CrabCast's own refusal is what rules out the obvious fix.** In its words:
   * *"A PTY session id is only valid for the daemon process that issued it …
   * Ask for the agent again (activate by path) and use the session id that comes
   * back; retrying this one cannot succeed."* A retry — however many times,
   * however patiently backed off — is a request the peer has already told us can
   * never be answered. What repairs it is asking again **by address**, which is
   * the identity that survives a restart, and taking the id that comes back.
   *
   * ## Why this does NOT key on whether the peer restarted
   *
   * It could: `link.peerIdentified()` says so, and it is awaited here. But it is
   * awaited to **attribute** the gap, never to decide whether to re-resolve —
   * and that distinction is the answer to this ticket's third question rather
   * than an implementation detail. A restart is one reason an id can go stale
   * and not the only one, `bootId` is uncontracted so a peer may publish none,
   * and a re-resolution that finds the id unchanged costs one census read and
   * changes nothing. Keying the repair on the detector would make the repair
   * exactly as reliable as the detector, for no gain; keying it on the census
   * makes it correct even where the detector answers `unknown`.
   *
   * The Butchr `sessionId` deliberately does **not** move with the remote one.
   * It is the address every consumer holds — the extension, `router.ts`, the
   * registry — so re-pointing the mapping keeps one session continuous across a
   * peer restart, which is what a gap on that session's record is describing. A
   * new Butchr session would instead present the restart as *"the old agent
   * vanished and a new one appeared"*, and quietly orphan the discontinuity that
   * explains it.
   */
  private async resyncMirrors(event: LinkStateEvent): Promise<void> {
    const stale = [...this.ptyMirrors.entries()].filter(([, m]) => m.state === 'stale');
    if (stale.length === 0) return;
    this.log(
      `link connected (connection #${event.connectionSeq}): re-subscribing ${stale.length} ` +
        `pty mirror(s). Their gaps stay on the record whether or not this succeeds.`
    );

    // Awaited rather than read off `link.observedPeerIdentity`, because the
    // `connected` event fires BEFORE the handshake completes — reading it
    // directly here returns the PREVIOUS connection's verdict, which is
    // `same-peer` exactly when it is wrong. Bounded by the handshake's own
    // request timeout; `unknown` is what a handshake that never answered gives.
    const identity = await this.link.peerIdentified();
    const peerRestarted =
      identity === 'restarted' ? true : identity === 'same-peer' ? false : null;

    const freshRemoteIds = await this.remoteSessionIdsByAddress();

    for (const [sessionId, mirror] of stale) {
      // Stamped on the OPEN gap, before the re-subscription can close it.
      // `closeGap` settles the same object, so the attribution lands on the
      // record a consumer already holds rather than on a second copy.
      if (mirror.openGap) mirror.openGap.peerRestarted = peerRestarted;

      const session = this.sessions.get(sessionId);
      const fresh = session
        ? freshRemoteIds.get(addressKey(session.type, session.key))
        : undefined;
      if (fresh && fresh !== mirror.remoteSessionId) {
        // The handler is keyed by remote id, so the stale key is dropped rather
        // than left behind: an entry under a dead id routes nothing and would
        // make `subscribedSessions()` report a subscription that cannot exist.
        this.link.releasePty(mirror.remoteSessionId);
        this.log(
          `pty mirror for ${sessionId}: the peer re-issued this pane as ${fresh} ` +
            `(was ${mirror.remoteSessionId}). Re-resolved by address off a fresh census — ` +
            `retrying the old id could not have succeeded, and CrabCast says so in its own ` +
            `refusal.`
        );
        mirror.remoteSessionId = fresh;
        // The write path reads this map rather than the mirror, so a repair that
        // updated only the mirror would render correctly and swallow every
        // keystroke. Both, or the terminal is half-repaired in the direction
        // nobody checks.
        this.remoteIds.set(sessionId, fresh);
      }

      mirror.state = 'subscribing';
      void this.subscribeMirror(sessionId, mirror);
    }
  }

  /**
   * A fresh `list_agents`, reduced to address → the peer's CURRENT session id.
   *
   * Fresh rather than `this.census`, and that is the whole point of the method:
   * the held census was taken from the peer that has just gone, so every id in
   * it is exactly the set of ids that may have died. Reading it would re-resolve
   * a stale id onto itself and report success.
   *
   * An empty map on any failure, and the caller degrades to re-subscribing with
   * the ids it has — which is precisely the behaviour that stood before this
   * ticket. A census that cannot be read must not stop the resync attempt;
   * losing the repair to a failed *optimisation* of it would be worse than the
   * defect.
   */
  private async remoteSessionIdsByAddress(): Promise<Map<string, string>> {
    const byAddress = new Map<string, string>();
    try {
      const res = await this.link.request({ action: 'list_agents' });
      if (res.success !== true) return byAddress;
      this.census = this.readCensus(res);
      for (const row of this.census.rows) {
        if (row.state !== 'running' || !row.sessionId) continue;
        const address = addressForPath(row.workDir ?? row.path);
        if (!address) continue;
        byAddress.set(addressKey(address.type, address.key), row.sessionId);
      }
    } catch (err) {
      this.log(
        `could not read a fresh census to re-resolve pty session ids: ` +
          `${err instanceof Error ? err.message : String(err)}. Re-subscribing with the ids we ` +
          `hold, which is what happened before KAN-403 — a stale id will be refused and the gap ` +
          `will settle failed, disclosed either way.`
      );
    }
    return byAddress;
  }

  /**
   * Open a discontinuity on a mirror, and tell everyone listening **now**.
   *
   * The record is appended to the session as well as fanned out, because a
   * consumer that attaches after the gap was never present for the event —
   * `router.ts` serves it the list at `pty_init`. A live event alone would make
   * disclosure depend on who happened to be watching.
   */
  private openGap(sessionId: string, mirror: PtyMirror, at = Date.now()): void {
    if (mirror.openGap) return;
    const gap: PtyDiscontinuity = {
      sequence: ++mirror.gaps,
      lostAt: new Date(at).toISOString(),
      restoredAt: null,
      windowMs: null,
      resync: 'pending',
      cause: 'link-dropped',
      // Null, not false: at the moment a drop is recorded there is no peer to
      // have an opinion about, and `false` here would claim we had looked. The
      // resync fills it in — see `resyncMirrors` (KAN-403).
      peerRestarted: null
    };
    mirror.openGap = gap;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ptyDiscontinuities.push(gap);
      if (session.ptyDiscontinuities.length > PTY_DISCONTINUITY_LIMIT) {
        session.ptyDiscontinuities.splice(
          0,
          session.ptyDiscontinuities.length - PTY_DISCONTINUITY_LIMIT
        );
      }
    }
    this.emitDiscontinuity(mirror, gap);
  }

  /**
   * Settle the open gap. Mutates the record the session already holds, so the
   * durable copy and the emitted one cannot disagree, and re-emits it under the
   * same `sequence` — a consumer keyed on that updates in place rather than
   * counting one drop twice.
   */
  private closeGap(
    sessionId: string,
    mirror: PtyMirror,
    resync: 'succeeded' | 'failed',
    error?: string
  ): void {
    const gap = mirror.openGap;
    if (!gap) return;
    const restoredAt = Date.now();
    gap.restoredAt = new Date(restoredAt).toISOString();
    gap.windowMs = restoredAt - Date.parse(gap.lostAt);
    gap.resync = resync;
    if (error !== undefined) gap.error = error;
    else delete gap.error;
    mirror.openGap = null;
    this.log(
      `pty mirror for ${sessionId} resync ${resync} after ${gap.windowMs}ms unsubscribed ` +
        `(gap #${gap.sequence}). The window is disclosed regardless of the outcome: a resync ` +
        `that silently succeeded and one that silently half-succeeded look identical without it.`
    );
    this.emitDiscontinuity(mirror, gap);
  }

  private emitDiscontinuity(mirror: PtyMirror, discontinuity: PtyDiscontinuity): void {
    // A listener that throws must not stop the others being told. A gap nobody
    // hears about is the state this whole mechanism exists to prevent, so it is
    // not allowed to be produced by one bad consumer.
    for (const fn of mirror.listeners) {
      try {
        fn({ kind: 'discontinuity', discontinuity });
      } catch (err) {
        this.log(
          `a pty listener threw on a discontinuity: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * The gaps recorded for a session, oldest first — an empty array when there
   * have been none, and an empty array for a session this runtime does not
   * hold.
   *
   * **Those two are deliberately the same answer here and are not the same
   * claim**, which is why the caller is `router.ts`'s `pty_init`, where the
   * session has already been looked up and a missing one is refused before this
   * is reached. Nothing else may use it as an existence check.
   */
  ptyDiscontinuitiesFor(sessionId: string): PtyDiscontinuity[] {
    return this.sessions.get(sessionId)?.ptyDiscontinuities ?? [];
  }

  /**
   * `reason` is `SessionEndReason`, whose two values are `'taken-over'` and
   * `'exited'`.
   *
   * **CrabCast cannot tell those apart and this does not guess.** `taken-over`
   * is Butchr's own concept — an attach evicted by a second one, detected in
   * `HerdrBridge` by scanning the pty buffer for herdr's takeover notice. No
   * CrabCast event carries it: `agent.detached` says the session ended and
   * nothing about why. So every end reported through this runtime is
   * `'exited'`, which is the weaker and true claim, rather than a coin-flip
   * between two states a caller renders differently.
   */
  private endMirror(sessionId: string, exitCode: number): void {
    // The verdict belongs to a spawn, and this spawn is over. Dropped rather
    // than left behind so a later session reusing nothing of this one cannot
    // read a stale `true` — and dropping it renders as `null`, which is the
    // honest answer for a session there is no longer a spawn to be about.
    this.channelEnabled.delete(sessionId);
    // Same reasoning as the verdict above, applied to the log-suppression keys
    // (KAN-459): they exist to stop one session's refusals repeating, and this
    // session is over. The COUNTS are deliberately not reset — they are
    // since-startup totals, and a total that forgets is not one.
    for (const key of this.ptyWritesLogged) {
      if (key.endsWith(`:${sessionId}`)) this.ptyWritesLogged.delete(key);
    }
    const mirror = this.ptyMirrors.get(sessionId);
    if (mirror) {
      this.link.releasePty(mirror.remoteSessionId);
      mirror.state = 'ended';
      mirror.listeners = [];
      this.ptyMirrors.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session && this.sessionEndedListener) {
      const event: SessionEndedEvent = {
        type: session.type,
        key: session.key,
        sessionId,
        reason: 'exited',
        exitCode
      };
      this.sessionEndedListener(event);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private remoteFor(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    return this.remoteIds.get(sessionId) ?? null;
  }

  private sessionForAddress(type: string, key: string): HerdrSession | undefined {
    return [...this.sessions.values()].find(
      (s) => s.type === type && s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
  }

  /**
   * Every live session on a key, whatever type holds it — the whole of what
   * `sessionForKey` used to answer the *first* of (KAN-473). One element is an
   * answer and two are a refusal, and only the list can tell them apart.
   */
  private sessionsForKey(key: string): HerdrSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.key.toLowerCase() === key.toLowerCase() && s.status !== 'terminated'
    );
  }

  /**
   * The one session a bare key names, or `null` when it names none — and it
   * THROWS when it names several. Used by the surfaces whose contract is to
   * throw ({@link describeAgent}); the ones that answer with a response object
   * go through {@link resolveSessionByAddress} instead.
   */
  private soleSessionForKey(key: string): HerdrSession | null {
    const resolution = resolveAmongSessions(this.sessionsForKey(key));
    if (resolution.outcome === 'ambiguous') {
      throw new AmbiguousKeyError(key, resolution.candidates);
    }
    return resolution.outcome === 'one' ? resolution.session : null;
  }

  /**
   * The session an address names, or the refusal owed instead — for the methods
   * whose contract is to ANSWER rather than to throw (KAN-473).
   *
   * The ambiguous case is a refusal in this runtime as much as in the local
   * one: `closeAgentByKey` and `sendToAgent` are the destructive pair, and
   * "whichever session this map iterated first" is not an address either of
   * them may act on.
   */
  private addressedSession(
    key: string,
    type?: string
  ):
    | { outcome: 'one'; session: HerdrSession; error?: undefined; candidates?: undefined }
    | { outcome: 'none'; session?: undefined; error: string; candidates?: undefined }
    | { outcome: 'ambiguous'; session?: undefined; error: string; candidates: ButchrAgentName[] } {
    const missing = () =>
      ({
        outcome: 'none',
        error: renderRefusal(
          this.link.refusal(
            'butchr-adapter',
            `no session this daemon started matches ${type ?? '*'}/${key}`
          )
        )
      }) as const;

    if (type) {
      const session = this.sessionForAddress(type, key);
      return session ? { outcome: 'one', session } : missing();
    }

    const resolution = resolveAmongSessions(this.sessionsForKey(key));
    if (resolution.outcome === 'one') return { outcome: 'one', session: resolution.session };
    if (resolution.outcome === 'none') return missing();
    return {
      outcome: 'ambiguous',
      candidates: resolution.candidates,
      error: renderRefusal(
        this.link.refusal(
          'butchr-adapter',
          ambiguousKeyMessage(key, resolution.candidates),
          'Pass the workspace type, so this addresses one agent rather than whichever ' +
            'session this daemon happens to hold first.'
        )
      )
    };
  }

  /**
   * The census in Butchr's vocabulary — and the name is DERIVED FROM THE PATH,
   * never copied from `paneName` (KAN-346).
   *
   * **`paneName` is CrabCast's name for a pane, and for an agent CrabCast
   * started it is not a Butchr agent name at all.** Measured against a live
   * peer at `6f47df7d`: a `task/kan-346-diag` agent spawned through this
   * adapter came back as `crabcast-kan-346-diag-9728c6a0c69ee8c1` — their
   * prefix, their hash. Every consumer of this list addresses an agent by
   * `addressFromAgentName`, which parses `butchr-<type>-<key>` and answers
   * `null` for anything else; `router.ts`'s `list_agents` loop does
   * `if (!address) continue`, so **the agent was dropped from the fleet
   * listing entirely** — not reported stranded, not reported at all. That is
   * strictly worse than the `sessionless: true` this ticket was filed about,
   * and it is invisible because a shorter list looks like a smaller fleet.
   *
   * **The path is the address, so deriving from it is not a translation.**
   * CrabCast's north star 3 is that an agent IS a canonical filesystem path,
   * and {@link addressForPath} is the exact inverse of the
   * {@link pathForAddress} this adapter spawns with. A row outside Butchr's
   * workspace tree has no Butchr name to give it and keeps `paneName`, which
   * is what it always was.
   *
   * **Nothing changes for a foreign pane that herdr started**, and that is
   * why the flip did not lose those: herdr names its panes
   * `butchr-<type>-<key>` already, so the derived name equals the one this
   * function used to copy. The two disagree only for an agent CrabCast
   * started — exactly the population this runtime creates.
   *
   * **The derivation itself now lives in {@link butchrNameForCensusRow}, and
   * this function is one of its two callers (KAN-397).** It used to be spelled
   * out here, which is how `confirmAgentPresent` came to keep the raw
   * `paneName` join this ticket was filed about: a rule written once and
   * applied once is not a rule the next reader inherits.
   */
  private censusRecords(): HerdrAgentRecord[] {
    const rows = [...this.census.rows, ...this.census.foreign];
    return rows.map((row) => {
      return {
        name: butchrNameForCensusRow(row),
        agentRuntime: row.agentRuntime,
        workDir: row.workDir ?? row.path,
        herdrStatus: asHerdrStatus(row.herdrStatus)
      };
    });
  }

  private readCensus(frame: Record<string, unknown>): Census {
    const toRow = (raw: unknown): CensusRow => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        path: typeof r.path === 'string' ? r.path : '',
        // The only producer of a `PaneName` (KAN-406): this is CrabCast's
        // string, so the cast sits where CrabCast's frame is read.
        paneName: (typeof r.paneName === 'string' ? r.paneName : '') as PaneName,
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        status: typeof r.status === 'string' ? r.status : null,
        herdrStatus: typeof r.herdrStatus === 'string' ? r.herdrStatus : null,
        agentRuntime: typeof r.agentRuntime === 'string' ? r.agentRuntime : null,
        state: typeof r.state === 'string' ? r.state : null,
        workDir: typeof r.workDir === 'string' ? r.workDir : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
        launcher:
          typeof (r.config as Record<string, unknown> | undefined)?.launcher === 'string'
            ? ((r.config as Record<string, unknown>).launcher as string)
            : null
      };
    };
    const agents = Array.isArray(frame.agents) ? frame.agents.map(toRow) : [];
    const foreign = Array.isArray(frame.foreignPanes) ? frame.foreignPanes.map(toRow) : [];

    // The readable side of the supersession join (KAN-357). **Every category
    // this frame carries, not just our own agents** — the question the join
    // asks is whether ANYTHING readable already covers the agent an unreadable
    // row mentions, and a foreign pane covers it exactly as well as one of
    // ours does. Narrowing this to `agents` would report a superseded row as
    // `ran-found-nothing`, which is the alarm-on-the-boring-case failure the
    // join exists to avoid.
    //
    // Both `path` and `workDir` go in because `claimsPath` is built from
    // whichever the row had — their `path`, else the retired `workDir` — so a
    // set keyed on only one of them would fail to match a row that named the
    // other and call it absent.
    const readablePaths = new Set<string>();
    for (const row of [...agents, ...foreign]) {
      if (row.path) readablePaths.add(row.path);
      if (row.workDir) readablePaths.add(row.workDir);
    }

    return {
      reachable: true,
      at: Date.now(),
      rows: agents,
      foreign,
      ...readUnreadableDisclosure(frame, this.link.describe().peerContractVersion, readablePaths)
    };
  }

  /**
   * Rebuild a session record for every agent CrabCast is still running that
   * this daemon has no session for — the restart repair (KAN-346).
   *
   * ## What a Butchr daemon restart actually costs under this runtime
   *
   * The session map dies with the process and the agents do not: they are
   * CrabCast's panes, in CrabCast's process. `HerdrBridge` meets the same state
   * and heals from it by a route this runtime does not have — the sidepanel
   * re-activates on sight, and `spawnSession` there finds the live pane and
   * re-attaches to it. Calling `spawnSession` here would instead
   * `configure_agent` + `activate_agent`, which starts the agent **fresh**:
   * `task/KAN-275` lost its whole conversation that way at the 10:58Z flip and
   * its PR had to be merged by a non-author. So healing has to be a read, and
   * this is it.
   *
   * ## Only `census.rows`, never `census.foreign`, and the line is load-bearing
   *
   * A foreign pane is one CrabCast can *see* and does not *own*: no
   * `sessionId`, so nothing addresses its pty over the wire, and no config, so
   * nothing says what it expects. Adopting one would manufacture a session id
   * that resolves to nothing and hand the extension a terminal that renders
   * forever — a fabrication dressed as a repair. They keep reporting
   * `sessionless: true`, honestly, and {@link describeAgent} still answers for
   * them.
   *
   * **That distinction is the whole answer to why the flip stranded
   * everything.** Every agent alive at 10:58Z had been started by herdr, so
   * CrabCast held all of them as foreign panes and none as its own — measured,
   * in `fixtures/crabcast-v4-short-census.json`, where `agents` is `[]` and all
   * five Butchr agents sit under `foreignPanes`. Nothing in this method would
   * have rescued that fleet, and nothing could have: the panes were never
   * CrabCast's to serve. It rescues the fleet a CrabCast daemon *started*,
   * which is the fleet that exists after a cutover rather than during one.
   *
   * ## What is adopted and what is left to the registry
   *
   * `sessionId`, `createdAt`, `status`, `workDir` and the pty address all come
   * off the row — read, not invented, and a row missing any of them is skipped
   * rather than filled in. **`url` is not there and cannot be**: it is a Butchr
   * concept CrabCast has no field for and we never send, so an adopted session
   * carries none and `router.ts` restores it from the durable agent registry,
   * which recorded it at activation. Two fields, two sources, and neither one
   * falls out of the other.
   *
   * ## And one row is refused rather than filled in: an unreadable launcher
   *
   * `expectsRuntime` is the one adopted field derived from a string **CrabCast**
   * chose, and KAN-429 is the ticket about that. A row whose `launcher` is not a
   * name Butchr has is skipped, because the alternative is a guess in a field
   * that is read as fact: `router.ts`'s `confirmActivation` passes
   * `session.expectsRuntime ?? true` into `confirmAgentPresent`, and an `absent`
   * answer calls `abandonSession` — so a runtime-less foreign launcher adopted
   * as expecting a runtime is a **live pane torn out of Butchr's session map and
   * reported a failed activation**, which is the KAN-397 harm shape exactly.
   *
   * **The refusal costs this method's own population nothing**, which is what
   * makes it the narrow fix rather than a behaviour change wearing one's
   * clothes: every row {@link provision} produces carries
   * `launcher: defaultAgent ?? 'claude'` — Butchr's own string, sent by Butchr —
   * so the guard is a no-op on the fleet a CrabCast daemon started for us, which
   * is the fleet this method exists to rescue. It bites only on an agent
   * CrabCast configured **itself** inside Butchr's workspace tree, a population
   * this method was never designed for and reaches only because it filters on
   * `addressForPath`. Such a row is not hidden by the refusal: `censusRecords()`
   * reads the census and not `this.sessions`, so it is still listed, and
   * honestly, as `sessionless: true`.
   */
  private adoptFromCensus(): void {
    for (const row of this.census.rows) {
      // `state` is CrabCast's word for whether the pane is up. Anything else —
      // configured-but-unstarted, stopped, refused — is not a session, and
      // `unstartedAgents` is precisely where the incident found `task/KAN-275`.
      if (row.state !== 'running') continue;
      // No remote id, no pty, no adoption. `remoteFor` is what `ensureMirror`
      // needs, and a session that cannot serve a terminal is the exact thing
      // this ticket exists to stop reporting.
      if (!row.sessionId) continue;
      // Not a time we may guess. See CensusRow.createdAt.
      if (!row.createdAt) continue;
      const dir = row.workDir ?? row.path;
      const address = addressForPath(dir);
      if (!address) continue; // a CrabCast agent outside Butchr's tree; not ours
      if (this.sessionForAddress(address.type, address.key)) continue; // already held
      // A launcher name Butchr does not have is one Butchr cannot answer
      // `expectsRuntime` for, so it does not answer (KAN-429). See
      // CensusRow.launcher. Skipping leaves the row listed and sessionless,
      // which is true; adopting it would have written a guess into a field
      // `confirmActivation` later reads as fact and answered `absent` for a
      // pane that is alive — abandonSession, on a running agent.
      const launcher = row.launcher;
      if (!isButchrLauncher(launcher)) {
        this.log(
          `not adopting ${agentNameFor(address.type, address.key)}: its launcher ` +
            `${JSON.stringify(launcher)} is not one Butchr has ` +
            `(${BUTCHR_LAUNCHERS.join(', ')}), so whether it delivers an agent runtime is ` +
            `CrabCast's fact and not ours to guess. It stays in the census as a sessionless ` +
            `agent.`
        );
        continue;
      }

      const createdAt = new Date(row.createdAt);
      if (Number.isNaN(createdAt.getTime())) continue;

      const sessionId = `${address.type}-${address.key.toLowerCase()}-${createdAt.getTime()}`;
      const session: HerdrSession = {
        sessionId,
        type: address.type,
        key: address.key,
        // No `url`. It is not on the row and never was — see the docblock.
        createdAt,
        status: 'active',
        workDir: dir,
        ptyBuffer: '',
        onDataListeners: [],
        // Empty, and honestly so: this daemon was not watching this agent
        // before it adopted it, so it has no gaps of its own to report. What
        // it could not see before the adoption is disclosed by `adopted: true`
        // rather than as a discontinuity — a gap is a window this daemon knows
        // it lost, and inventing one for a session it never held would be a
        // claim about a period nobody observed.
        ptyDiscontinuities: [],
        // `launcher` is a ButchrLauncher by now, never `string` — so this is a
        // comparison inside one vocabulary, and TS2367 if `shell` ever leaves
        // it. That narrowing is the whole of KAN-429's fix.
        expectsRuntime: launcher !== 'shell',
        adopted: true
      };
      this.sessions.set(sessionId, session);
      // The half that makes the terminal work: every pty verb goes through
      // `remoteFor`, so without this the adopted session would look attached
      // and render nothing.
      this.remoteIds.set(sessionId, row.sessionId);
      this.log(
        `adopted ${agentNameFor(address.type, address.key)} from the census as ${sessionId} ` +
          `(CrabCast session ${row.sessionId}, created ${row.createdAt}). This daemon did not ` +
          `start it; no url is claimed, because CrabCast has no field for one.`
      );
    }
  }

  private startCensus(): void {
    const tick = () => {
      if (!this.link.connected) {
        this.census = { ...this.census, reachable: false };
        return;
      }
      void this.link
        .request({ action: 'list_agents' })
        .then((res) => {
          if (res.success === true) {
            this.census = this.readCensus(res);
            this.adoptFromCensus();
          } else this.census = { ...this.census, reachable: false };
        })
        .catch(() => {
          this.census = { ...this.census, reachable: false };
        });
    };
    tick();
    this.censusTimer = setInterval(tick, this.censusIntervalMs);
    this.censusTimer.unref?.();
  }

  /**
   * `agent.detached` is how a session death reaches us — the cross-process
   * equivalent of `HerdrBridge`'s in-process `sessionEndedListener`. Verified
   * on the wire: it is broadcast to every connected client, unasked, carrying
   * `at`, `seq` and `bootId`.
   */
  private onCrabCastEvent(frame: Record<string, unknown>): void {
    const action = String(frame.action ?? '');
    const dir = typeof frame.path === 'string' ? frame.path : null;
    if (!dir) return;
    const address = addressForPath(dir);
    if (!address) return; // a CrabCast agent outside Butchr's tree; not ours

    if (action === 'agent.detached' || action === 'agent.deactivated') {
      const session = this.sessionForAddress(address.type, address.key);
      if (!session) return;
      session.status = 'terminated';
      this.endMirror(session.sessionId, 0);
    }
  }

  /** Everything an operator needs about this runtime, for the honest report. */
  describe(): {
    link: ReturnType<CrabCastLink['describe']>;
    sessions: number;
    ptyMirrors: number;
    /**
     * Mirrors by state (KAN-381). **`stale` is the field that makes a
     * reconnected-but-unsubscribed mirror visible to an operator** — the state
     * that used to be reported as `live` because it had no name of its own.
     */
    ptyMirrorStates: { subscribing: number; live: number; stale: number; ended: number };
    /**
     * Gaps recorded across every session this runtime holds, and how many are
     * still open. **A non-zero `open` with `link.connected: true` is the
     * one combination worth an alarm**: the link is back and a mirror has not
     * been re-subscribed.
     */
    ptyDiscontinuities: { total: number; open: number };
    /**
     * pty writes that did not work, since startup (KAN-459).
     *
     * **`refused` is the field that was unreadable before this existed**: the
     * ack was already arriving and was discarded by a `void`, so a session
     * CrabCast had disowned went on accepting keystrokes at this interface
     * forever. A non-zero `refused` beside `link.connected: true` is the
     * combination worth acting on — the peer is up and is turning our writes
     * away, which is what `peerIdentity: 'restarted'` looks like from the pty
     * side.
     *
     * ⚠ **NOTHING IN PRODUCTION READS THIS REPORT.** `describe()` has no
     * caller outside `daemon/scripts`: the router holds this runtime as an
     * `AgentRuntime`, and that interface declares no `describe`. That was true
     * of every field here before KAN-459 and is not a gap KAN-459 introduced or
     * closed — it is recorded here so the next reader does not mistake a
     * populated field for a surfaced one.
     *
     * **The surface that carries a refusal to a human is the daemon log**,
     * written first-of-kind per session and verb by
     * {@link recordPtyWriteOutcome}: `grep pty_input ~/.local/share/butchr/daemon.log`.
     * ⚠ **And that grep is empty on a stock install, for a reason that is not
     * this class's usual one**: `BUTCHR_AGENT_RUNTIME` is unset by default, so
     * this whole runtime is inert and no pty write reaches this file at all.
     * The line is real and reaches a real log — it reaches it only where
     * CrabCast is actually serving agents. Anyone reading a quiet log as
     * evidence of no refusals should check which runtime is live first
     * (`grep '\[runtime\]' ~/.local/share/butchr/daemon.log`).
     */
    ptyWrites: { refused: number; undelivered: number; last: PtyWriteFailure | null };
    censusAgeMs: number | null;
    censusReachable: boolean;
    /**
     * Rows the last census could not read, and therefore did not count
     * (KAN-324). **`censusReachable: true` with a non-zero total here is a
     * census that was taken and is short** — the one state a v3-proved adapter
     * could not express, and the reason this field is on the operator report
     * rather than only in a log line. `null` is no disclosure at all.
     */
    censusUnreadableRecordsTotal: number | null;
    censusUnreadableRecords: CensusUnreadableRecord[];
    /**
     * One entry per session this adapter started, with the spawn's channel
     * verdict. **Counted three ways rather than summed into a boolean** — a
     * count of "channel-enabled agents" would have to decide what to do with
     * the `null`s, and there is no right answer to that question.
     */
    channelEnabled: { true: number; false: number; null: number };
  } {
    const tally = { true: 0, false: 0, null: 0 };
    for (const session of this.sessions.keys()) {
      const verdict = this.channelEnabledFor(session);
      if (verdict === true) tally.true++;
      else if (verdict === false) tally.false++;
      else tally.null++;
    }
    const mirrorStates = { subscribing: 0, live: 0, stale: 0, ended: 0 };
    for (const mirror of this.ptyMirrors.values()) mirrorStates[mirror.state]++;
    // **Both figures are read off the session records, not off the mirrors**, and
    // the difference shows up in exactly one case: a session that ENDED while its
    // gap was still open. `endMirror` drops the mirror, so counting `openGap`
    // across mirrors would report `open: 0` beside a stored record that still
    // reads `pending` — two answers to one question, and the reassuring one
    // would be the wrong one. The record stays `pending` deliberately: that gap
    // was never repaired and now never will be, which is a thing an operator
    // should be able to see rather than a loose end to tidy into `failed`.
    let totalGaps = 0;
    let openGaps = 0;
    for (const session of this.sessions.values()) {
      totalGaps += session.ptyDiscontinuities.length;
      for (const gap of session.ptyDiscontinuities) if (gap.resync === 'pending') openGaps++;
    }
    return {
      link: this.link.describe(),
      sessions: this.sessions.size,
      ptyMirrors: this.ptyMirrors.size,
      ptyMirrorStates: mirrorStates,
      ptyDiscontinuities: { total: totalGaps, open: openGaps },
      ptyWrites: { ...this.ptyWrites },
      censusAgeMs: this.census.at ? Date.now() - this.census.at : null,
      censusReachable: this.census.reachable,
      censusUnreadableRecordsTotal: this.census.unreadableRecordsTotal,
      censusUnreadableRecords: this.census.unreadableRecords,
      channelEnabled: tally
    };
  }

  /** Stops the census poll and drops the connection. Tests and shutdown only. */
  dispose(): void {
    if (this.censusTimer) clearInterval(this.censusTimer);
    this.censusTimer = null;
    this.link.close();
  }
}
