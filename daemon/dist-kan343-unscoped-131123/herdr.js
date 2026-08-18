import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLauncher, sleepSync, writeWorkspaceMcpConfig } from './launchers.js';
import { diagnoseSpawnFailure } from './herdr-health.js';
import { runHerdrCli } from './herdr-cli.js';
import { RESUME_ENV, degradedResumePrompt, hasRestorableConversation, workspaceBrief } from './resume.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** How many gaps a session remembers before the oldest is dropped. */
export const PTY_DISCONTINUITY_LIMIT = 50;
const HERDR_AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
/** Ceiling on any single herdr CLI call, so a wedged herdr can't hang a caller. */
export { HERDR_CLI_TIMEOUT_MS } from './herdr-cli.js';
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
const TAIL_SOURCES = ['recent-unwrapped', 'visible'];
/**
 * The last `lines` lines of `text`, used to hold the `visible` fallback to the
 * bound the caller asked for. `visible` ignores `--lines`, so without this a
 * `--lines 8` request could be answered with a whole screen.
 */
function lastLines(text, lines) {
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
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * The herdr agent a Butchr session drives. Sessions are keyed by workspace.
 *
 * **The signature is unchanged at runtime and must stay that way**: seventeen
 * `daemon/scripts/*.mjs` files import this from `dist/` and call it, and
 * `tsc` never sees them (KAN-406). Branding the return type is invisible to
 * them — brands erase — but a rename or a re-signature would break all
 * seventeen with nothing to report it.
 */
export function agentNameFor(type, key) {
    return `butchr-${type}-${key.toLowerCase()}`;
}
/**
 * Where a workspace lives, and whether Butchr may delete one, now live in
 * `workspace-dir.ts` (KAN-380) — because a *second* runtime needed them and
 * they were sitting inside this one as private detail. They are re-exported
 * from here unchanged so the twenty-odd modules and scripts that import them
 * from `herdr.js` keep working; nothing about their meaning moved.
 */
export { containWorkspaceDir, deleteWorkspaceDir, isStrictlyInside, workspaceDirFor, workspacesRoot } from './workspace-dir.js';
// A re-export creates no local binding, so this file's own uses of the two it
// calls are imported as well. Same module, same functions.
import { deleteWorkspaceDir, workspaceDirFor } from './workspace-dir.js';
/**
 * Inverse of agentNameFor. When an agent is resolved through the herdr-list
 * fallback there is no session to read a type off of, but the name still
 * carries one — enough to broadcast a complete event.
 */
export function typeFromAgentName(agentName, key) {
    const prefix = 'butchr-';
    const suffix = `-${key.toLowerCase()}`;
    if (!agentName.startsWith(prefix) || !agentName.endsWith(suffix))
        return undefined;
    return agentName.slice(prefix.length, agentName.length - suffix.length) || undefined;
}
/**
 * The ambiguity rule itself, in one place, so both runtimes cannot disagree
 * about what a bare key means. Callers hand it every ACTIVE session that
 * matched the address by their own key-comparison rule — `HerdrBridge` matches
 * a key exactly, `CrabCastRuntime` case-insensitively, and neither of those is
 * this function's business.
 *
 * Sorted, because a refusal that names two agents in map-iteration order is a
 * refusal whose text changes with the order they were started in.
 */
export function resolveAmongSessions(matches) {
    if (matches.length === 0)
        return { outcome: 'none' };
    if (matches.length === 1)
        return { outcome: 'one', session: matches[0] };
    return {
        outcome: 'ambiguous',
        candidates: matches.map(s => agentNameFor(s.type, s.key)).sort()
    };
}
/**
 * The refusal a caller owes an ambiguous bare key, worded once so that every
 * surface refuses in the same words. It names both halves of the fix: which
 * agents matched, and that `type` is what separates them.
 */
export function ambiguousKeyMessage(key, candidates) {
    return (`Key '${key}' is ambiguous; it matches agents: ${candidates.join(', ')}. ` +
        'Name the workspace type to address one of them exactly.');
}
/**
 * An ambiguous address, thrown where the surface's contract is to throw.
 *
 * The candidates ride on the error rather than only inside its message: a
 * handler that catches this owes its client a refusal it can act on, and
 * re-parsing agent names back out of prose is how the list and the sentence
 * drift apart.
 */
export class AmbiguousKeyError extends Error {
    candidates;
    constructor(key, candidates) {
        super(ambiguousKeyMessage(key, candidates));
        this.name = 'AmbiguousKeyError';
        this.candidates = [...candidates];
    }
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
export function addressFromAgentName(agentName) {
    const prefix = 'butchr-';
    if (!agentName.startsWith(prefix))
        return null;
    const rest = agentName.slice(prefix.length);
    const split = rest.indexOf('-');
    if (split <= 0 || split >= rest.length - 1)
        return null;
    const address = { type: rest.slice(0, split), key: rest.slice(split + 1) };
    return agentNameFor(address.type, address.key) === agentName ? address : null;
}
function toAgentStatus(value) {
    return HERDR_AGENT_STATUSES.includes(value)
        ? value
        : 'unknown';
}
function parseJson(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function clampTailLines(lines) {
    const requested = typeof lines === 'number' && Number.isFinite(lines)
        ? Math.floor(lines)
        : TAIL_DEFAULT_LINES;
    return Math.min(Math.max(requested, 1), TAIL_MAX_LINES);
}
export class HerdrBridge {
    /** See {@link AgentRuntime.runtimeName}. */
    runtimeName = 'herdr';
    /**
     * See {@link AgentRuntime.channelReach}. `'unknown'`, and that is the honest
     * answer rather than a gap left for somebody (KAN-495).
     *
     * **This runtime's spawns CAN carry the flag** — `launchers.ts`
     * `claudeCommand()` composes it onto both arms of the `||`, from
     * `developmentChannelFlags()`, which reads the kill switch. So `'not-loaded'`
     * would be wrong here and `'loaded'` would be a lie.
     *
     * ⚠ **What is missing is a PER-AGENT record, and the reason is worth
     * carrying.** The launch decision is taken once, at spawn; the emission
     * decision is taken per message. An agent spawned while the switch was off
     * has no flag and keeps none for its whole life, while the daemon will
     * happily resolve it and write frames its client discards — launchers.ts has
     * said so in prose since KAN-246 and nothing has ever been able to answer it
     * for a particular agent. `AgentSpawn.channelEnabled` is exactly that fact
     * and it crosses `setAgentSpawnedListener` already; what does not exist is
     * anywhere that keeps it. That is **KAN-497**, and until it lands this member
     * must stay `'unknown'` — guessing `'not-loaded'` here would take a working
     * fleet off channels for a fact nobody established.
     */
    channelReach = 'unknown';
    sessions = new Map();
    /** Set by the daemon so a dying PTY can be announced to connected clients. */
    sessionEndedListener;
    setSessionEndedListener(listener) {
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
    agentSpawnedListener;
    setAgentSpawnedListener(listener) {
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
    liveAttachFor(agentName) {
        for (const session of this.sessions.values()) {
            if (session.status !== 'active' || !session.ptyProcess)
                continue;
            if (agentNameFor(session.type, session.key) === agentName)
                return session;
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
    briefLocation(type, key) {
        return workspaceBrief(workspaceDirFor(type, key));
    }
    // `url` is `string | undefined` rather than optional: it sits in front of
    // required parameters, and callers who have no URL must pass nothing rather
    // than a placeholder.
    //
    // `priority` is accepted and DELIBERATELY UNUSED here (KAN-482). Under herdr
    // the capacity gate and the preemption comparison both run in `router.ts`,
    // above this seam, off the same `registry.priorityFor` this parameter carries
    // — so there is nothing for this runtime to do with it, and doing anything
    // would be a second opinion on a decision already taken. It is on the
    // interface because the *other* implementation is a separate daemon that
    // makes those decisions itself and must be told the number; see
    // `AgentRuntime.spawnSession`. Naming it `_priority` was considered and
    // rejected: the name is what makes the parameter list read the same on both
    // implementations, and an underscore would invite a future reader to think
    // herdr was handed something meaningless.
    //
    // `supervisor` is accepted and DELIBERATELY UNUSED for the same reason
    // (KAN-492). Under herdr the exemption is applied by `router.ts`'s
    // `capacityGate`, which consults `isSupervisorType` itself and passes a
    // supervisor activation unconditionally; this runtime rationing nothing has
    // nothing to apply it to. Under CrabCast the rationing belongs to another
    // daemon, which is why the value has to cross this seam at all.
    //
    // `override` is the third of exactly this species (KAN-507), and it is the one
    // whose absence had teeth. Under herdr the override is applied by
    // `capacityGate` immediately above this call — the gate it overrides IS
    // Butchr's — so by the time a spawn happens there is nothing left to override
    // and this runtime correctly ignores it. Under CrabCast the gate that refuses
    // belongs to the other daemon, so the flag has to travel or it does nothing at
    // all; it went nowhere until KAN-507, and four activations were refused
    // holding a flag that had never left the process.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    spawnSession(type, key, url, promptContent, priority, supervisor, defaultAgent, mcpServers, resume, override) {
        // One attach per agent, enforced here rather than in each caller. The
        // routers dedupe by (key, type), but the MCP server and the sidepanel's
        // re-attach path can both ask to activate the same agent at once. A second
        // attach would evict the first, so the only safe answer is the session we
        // already have.
        const agentName = agentNameFor(type, key);
        const existing = this.liveAttachFor(agentName);
        if (existing) {
            console.log(`[HerdrBridge] Reusing live session ${existing.sessionId} for ${agentName}; ` +
                `refusing to open a second attach that would evict it`);
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
        //
        // **This runtime never answers `'unknown'`, and that is a property of where
        // it looks rather than of care taken here** (KAN-432): the transcript
        // directory is on this machine and readable synchronously, so there is no
        // state in which HerdrBridge has to guess. `CrabCastRuntime` learns the
        // same fact from a peer's response and can be told nothing, which is why
        // {@link ResumedConversation} has a third state that never appears on this
        // line.
        const resumedConversation = resume
            ? hasRestorableConversation(defaultWorkDir)
                ? 'restored'
                : 'fresh'
            : undefined;
        if (resume) {
            console.log(`[HerdrBridge] Resuming ${agentName} after ${resume}: ` +
                (resumedConversation === 'restored'
                    ? 'a conversation is on disk, so --continue will restore it'
                    : 'no conversation on disk, so it will start with the degraded-resume prompt'));
        }
        const session = {
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
    startAgentInOwnTab(agentName, workDir, argv) {
        const start = (placement) => this.runHerdr([
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
            }
            catch (e) {
                // The name being taken means the agent exists already — the caller
                // handles that, and retrying would start a second one.
                if (e?.herdrCode === AGENT_NAME_TAKEN)
                    throw e;
                // Tab ids are positional and renumber whenever an earlier tab closes,
                // so the id we were just handed can go stale between the two calls.
                // Ours is always the newest and therefore the highest-numbered, so a
                // renumber can only leave it dangling — herdr answers
                // `agent_placement_not_found` and never resolves it to somebody else's
                // tab. Falling back keeps the spawn working through that race.
                console.error(`[HerdrBridge] Could not place ${agentName} in tab ${tab.tabId} ` +
                    `(${e?.message ?? String(e)}); starting it in herdr's default placement instead`);
                start([]);
            }
        }
        finally {
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
    createAgentTab(agentName, cwd) {
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
        }
        catch (e) {
            console.error(`[HerdrBridge] Could not create a tab for ${agentName} (${e?.message ?? String(e)}); ` +
                `it will share whichever tab herdr picks`);
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
    closeTabPlaceholder(tab) {
        try {
            const panes = this.runHerdr(['pane', 'list', '--workspace', tab.workspaceId])?.result?.panes;
            const placeholder = Array.isArray(panes)
                ? panes.find((pane) => pane?.terminal_id === tab.placeholderTerminalId)
                : undefined;
            // Already gone: the human closed it, or the tab never survived.
            if (typeof placeholder?.pane_id !== 'string')
                return;
            this.runHerdr(['pane', 'close', placeholder.pane_id]);
        }
        catch (e) {
            // A stranded placeholder costs one idle shell, which is not worth
            // failing an otherwise good activation over.
            console.error(`[HerdrBridge] Could not close the placeholder pane in tab ${tab.tabId}: ` +
                `${e?.message ?? String(e)}`);
        }
    }
    initPty(session, initialPrompt, defaultAgent, mcpServers) {
        const agentName = agentNameFor(session.type, session.key);
        // Resolved before anything else happens. An unknown defaultAgent refuses
        // the whole activation (KAN-53), and it must do so before the workspace is
        // provisioned for an agent that will never exist. The refusal travels as
        // spawnError — the same channel a spawn herdr refused uses — so activate
        // answers `success: false` with the message naming the valid launchers.
        let launcher;
        let launcherName;
        try {
            ({ name: launcherName, launcher } = resolveLauncher(defaultAgent));
        }
        catch (e) {
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
            }
            catch (e) {
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
            let writeError;
            for (let attempt = 1; attempt <= PROMPT_WRITE_ATTEMPTS; attempt++) {
                try {
                    fs.writeFileSync(promptFile, initialPrompt);
                    writeError = undefined;
                    break;
                }
                catch (e) {
                    writeError = e?.message ?? String(e);
                    console.error(`[HerdrBridge] Prompt-file write ${attempt}/${PROMPT_WRITE_ATTEMPTS} for ` +
                        `${agentName} failed: ${writeError}`);
                    if (attempt < PROMPT_WRITE_ATTEMPTS)
                        sleepSync(PROMPT_WRITE_RETRY_MS);
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
        let staleRecord;
        try {
            const record = this.runHerdr(['agent', 'get', agentName])?.result?.agent;
            if (record) {
                const backed = typeof record.agent === 'string' && record.agent !== '';
                if (backed || !session.expectsRuntime)
                    agentExists = true;
                else
                    staleRecord = record;
            }
        }
        catch (e) {
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
            console.log(`[HerdrBridge] ${agentName} is a herdr name registration with no agent behind it ` +
                `(pane ${staleRecord.pane_id ?? 'unknown'}, status ${staleRecord.agent_status ?? 'unknown'}); ` +
                `closing the stale pane and taking the spawn path`);
            try {
                if (typeof staleRecord.pane_id === 'string' && staleRecord.pane_id) {
                    this.runHerdr(['pane', 'close', staleRecord.pane_id]);
                }
            }
            catch (e) {
                const code = e?.herdrCode;
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
            // CONSUMER 3 OF 4 (KAN-432). `=== false` became `=== 'fresh'` and the
            // meaning is unchanged *on this path*, because this branch only ever runs
            // inside `HerdrBridge`, which cannot produce `'unknown'` (see
            // `spawnSession` above). Stated rather than assumed: what makes the
            // rewrite safe is not that `'unknown'` is handled here, it is that it
            // cannot arrive here. Were it ever to — a runtime other than this one
            // reusing `initPty` — the degraded prompt would correctly NOT be used,
            // since an unknown is not a known-fresh start and greeting an agent that
            // may hold its whole conversation as though it were starting over is the
            // failure `degradedResumePrompt` exists to avoid.
            const fallbackPrompt = session.resume && session.resumedConversation === 'fresh'
                ? degradedResumePrompt(session.type, session.key, this.briefLocation(session.type, session.key), session.resume)
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
                }
                catch (e) {
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
                }
                catch (e) {
                    console.error(`[HerdrBridge] Agent-spawned listener for ${agentName} threw; the agent is ` +
                        `unaffected: ${e?.message ?? String(e)}`);
                }
            }
            catch (e) {
                if (e?.herdrCode === AGENT_NAME_TAKEN) {
                    // Someone created it between our check and our start. Attach to it.
                    console.log(`[HerdrBridge] Agent ${agentName} already existed; attaching to it`);
                }
                else {
                    session.spawnError = diagnoseSpawnFailure(e?.message ?? String(e));
                    // 'terminated' rather than 'active': there is no agent to attach to,
                    // and a session left active would advertise a terminal that can never
                    // produce output.
                    session.status = 'terminated';
                    console.error(`[HerdrBridge] Could not start herdr agent ${agentName}: ${session.spawnError}`);
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
        console.log(`[HerdrBridge] Attaching session ${session.sessionId} to ${agentName} ` +
            `(takeover=${takeover}): herdr ${attachArgs.join(' ')}`);
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
                }
            });
            session.ptyProcess = ptyProcess;
            ptyProcess.onData((data) => {
                session.ptyBuffer = (session.ptyBuffer + data).slice(-100000);
                session.onDataListeners.forEach(fn => fn({ kind: 'data', data }));
            });
            ptyProcess.onExit(({ exitCode }) => {
                // herdr's parting line is the only place the cause is recorded, so
                // read it off the buffer before anything else claims the exit.
                const tail = session.ptyBuffer.slice(-EXIT_REASON_SCAN_CHARS);
                const reason = tail.includes(TAKEOVER_NOTICE) ? 'taken-over' : 'exited';
                console.log(`[HerdrBridge] PTY for session ${session.sessionId} (${agentName}) ` +
                    `exited with code ${exitCode}; reason=${reason}`);
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
        }
        catch (e) {
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
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /**
     * Every active session on a key, whatever type holds it. Private, and it is
     * the whole of what used to be `getSessionByKey` (KAN-473) — that method
     * returned the *first* of these and was public, so "pick whichever one the
     * map iterated first" was a thing any caller could reach for by accident.
     * The list is what a caller actually needs: one element is an answer, two are
     * a refusal, and only the list can tell them apart.
     */
    activeSessionsForKey(key) {
        return Array.from(this.sessions.values()).filter(session => session.key === key && session.status === 'active');
    }
    listActiveSessions() {
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
    listHerdrAgents() {
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
    listHerdrAgentsChecked() {
        /** No census, therefore no disclosure. `0` would be a claim about a read that did not occur. */
        const unread = {
            reachable: false,
            agents: [],
            unreadableRecordsTotal: null,
            unreadableRecords: []
        };
        let output;
        try {
            output = execSync('herdr agent list', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore']
            });
        }
        catch (e) {
            return unread;
        }
        try {
            const rows = JSON.parse(output)?.result?.agents;
            if (!Array.isArray(rows))
                return unread;
            const agents = [];
            const unreadable = [];
            rows.forEach((agent, index) => {
                if (!agent || typeof agent.name !== 'string') {
                    unreadable.push({
                        source: 'herdr-census',
                        // `herdr agent list` is a JSON array, not a line-oriented registry,
                        // so the position in that array is the only locator there is.
                        line: index + 1,
                        problem: 'no-name',
                        identity: null,
                        reason: 'this row carried no string `name`, and a census row without one cannot be ' +
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
                    name: agent.name,
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
        }
        catch (e) {
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
    async confirmAgentPresent(agentName, requireRuntime, timeoutMs = requireRuntime ? RUNTIME_CONFIRM_TIMEOUT_MS : AGENT_CONFIRM_TIMEOUT_MS) {
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
            if (Date.now() + AGENT_CONFIRM_POLL_MS >= deadline)
                break;
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
                error: `Could not confirm agent '${agentName}' exists: herdr did not answer ` +
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
    abandonSession(sessionId, error) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        session.spawnError = error;
        session.status = 'terminated';
        try {
            session.ptyProcess?.kill();
        }
        catch (e) {
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
    herdrReachable() {
        try {
            this.runHerdr(['agent', 'list']);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * The same view as {@link listHerdrAgents}, keyed by name, for callers that
     * only want to decorate something they already have with a status.
     */
    listHerdrStatuses() {
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
    // Delegated to `herdr-cli.ts` since KAN-496, unchanged in behaviour. The
    // implementation moved because CrabCast's panes are herdr panes too, so
    // `CrabCastRuntime.pressPaneKey` needs the same runner; the method stays here
    // so that every existing call site reads exactly as it did.
    runHerdr(args) {
        return runHerdrCli(args);
    }
    /**
     * The herdr agent behind a workspace key. The in-memory session map is the
     * fast path, but it dies with the daemon while the herdr pane outlives it —
     * so fall back to matching herdr's own agent list, which is the case that
     * matters most here (messaging an agent that has been running a while).
     */
    resolveAgentName(key) {
        // All sessions on the key, not the first: two types can hold one key at
        // once (KAN-83), and a bare key naming two agents must be refused here
        // exactly as the herdr-list fallback below refuses it — silently picking
        // one would deliver someone's message, close, or reset to whichever agent
        // happened to be created first.
        //
        // `AmbiguousKeyError` rather than a bare `Error` (KAN-473): a handler that
        // catches this has to hand its client the candidate list, and reading it
        // back out of the message is how the list and the sentence drift apart.
        const resolution = resolveAmongSessions(this.activeSessionsForKey(key));
        if (resolution.outcome === 'ambiguous') {
            throw new AmbiguousKeyError(key, resolution.candidates);
        }
        if (resolution.outcome === 'one') {
            return agentNameFor(resolution.session.type, resolution.session.key);
        }
        const suffix = `-${key.toLowerCase()}`;
        const matches = Array.from(this.listHerdrStatuses().keys())
            .filter(name => name.startsWith('butchr-') && name.endsWith(suffix))
            .sort();
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            throw new AmbiguousKeyError(key, matches);
        throw new Error(`No agent found for key '${key}'`);
    }
    /**
     * The agent named by an address. A caller that knows the workspace type
     * names the agent exactly, which is the only unambiguous form when several
     * types share a key; a bare key keeps the resolve-by-suffix fallback.
     */
    agentNameForAddress(key, type) {
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
    resolveAddress(key, type) {
        const trimmedType = typeof type === 'string' ? type.trim() : '';
        if (trimmedType)
            return { type: trimmedType, key };
        const name = this.resolveAgentName(key);
        const prefix = 'butchr-';
        const suffix = `-${key.toLowerCase()}`;
        if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) {
            throw new Error(`Resolved agent '${name}' for key '${key}' is not spelled the way agentNameFor spells one, ` +
                'so its workspace type cannot be recovered; name the type explicitly.');
        }
        return { type: name.slice(prefix.length, name.length - suffix.length), key };
    }
    /**
     * The session for a FULL address, if this daemon owns one. An explicit type
     * has to match: a session for a different type is a different agent, and
     * answering with it would silently ignore the address the caller gave.
     *
     * Searched by (key, type) directly. Two types legitimately hold the same key
     * at once (KAN-83), and key-first would only ever see whichever session was
     * created first — the other type's session would exist and be unaddressable.
     *
     * **`type` is required, and that is the point rather than a tidy-up
     * (KAN-473).** It used to be optional, and a bare key fell through to a
     * first-match pick — so the two callers that had no type reached the
     * arbitrary answer *without naming it*, one of them to stand an agent down.
     * A caller that may have no type calls {@link resolveSessionByAddress} and
     * has to handle its `ambiguous` outcome to get at a session at all; there is
     * no longer a spelling of "resolve a bare key" that quietly picks one.
     */
    getSessionByAddress(key, type) {
        // `typeof` rather than a bare `type.trim()`, because the type system is not
        // the only caller: every router handler destructures its address out of a
        // `data: any` IPC frame, so a client that omits `type` reaches here with
        // `undefined` and no compiler saw it. An unusable type matches no session,
        // which is the honest answer — it is never a licence to fall back to a key.
        const trimmedType = typeof type === 'string' ? type.trim() : '';
        if (!trimmedType)
            return undefined;
        for (const session of this.sessions.values()) {
            if (session.key === key && session.type === trimmedType && session.status === 'active') {
                return session;
            }
        }
        return undefined;
    }
    /**
     * The session an address names, with ambiguity as an outcome rather than as
     * an arbitrary answer. See {@link SessionAddressResolution} for why.
     *
     * A named type addresses exactly one agent, so that branch can only be `one`
     * or `none`. A bare key is where the three-way answer earns its keep.
     */
    resolveSessionByAddress(key, type) {
        const trimmedType = typeof type === 'string' ? type.trim() : '';
        if (trimmedType) {
            const session = this.getSessionByAddress(key, trimmedType);
            return session ? { outcome: 'one', session } : { outcome: 'none' };
        }
        return resolveAmongSessions(this.activeSessionsForKey(key));
    }
    /**
     * Ask herdr directly about an agent. This is the answer for a key whose
     * session died with a previous daemon: the pane outlives us, so its status
     * and cwd are still there to be read. Throws when herdr has no such agent.
     */
    describeAgent(key, type) {
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
    async tailAgent(key, type, lines) {
        const wanted = clampTailLines(lines);
        const tried = [];
        const answeredEmpty = [];
        let firstError;
        // RESOLVED ONCE, OUTSIDE THE LOOP. A bare key costs a `herdr agent list` to
        // resolve, and asking two sources must not double that — a tail runs on
        // every poll of the delivery-confirmation loop. Failing to resolve is a
        // "could not look" before any source has been asked, so `sourcesTried` is
        // empty and says so rather than implying a read that never happened.
        let agentName;
        try {
            agentName = this.agentNameForAddress(key, type);
        }
        catch (e) {
            const error = e?.message ?? String(e);
            console.error(`[HerdrBridge] Failed to tail agent for key '${key}':`, error);
            return {
                success: false,
                error,
                sourcesTried: [],
                ...(e instanceof AmbiguousKeyError ? { candidates: e.candidates } : {})
            };
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
            }
            catch (e) {
                // A source that FAILS is not a source that said "empty". Remember the
                // first failure and let the next source try: herdr answering one read
                // and refusing another is a state we have seen, and the pane is
                // readable if either of them answers.
                if (firstError === undefined)
                    firstError = e?.message ?? String(e);
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
            const error = `Could not establish what is on agent '${agentName}': ` +
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
    pressPaneKey(key, type, keyName) {
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
    closePaneForAgent(agentName) {
        const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
        if (typeof paneId !== 'string' || !paneId)
            return false;
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
    closeAgentByKey(key, type) {
        let agentName;
        try {
            agentName = this.agentNameForAddress(key, type);
        }
        catch (e) {
            const error = e?.message ?? String(e);
            console.error(`[HerdrBridge] Could not resolve an agent for key '${key}':`, error);
            return { success: false, error };
        }
        try {
            if (!this.closePaneForAgent(agentName)) {
                return { success: false, agentName, error: `Agent '${agentName}' has no pane to close` };
            }
            return { success: true, agentName };
        }
        catch (e) {
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
    async sendToAgent(key, message, type) {
        let interruptSent = false;
        try {
            const agentName = this.agentNameForAddress(key, type);
            const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
            if (typeof paneId !== 'string' || !paneId) {
                // A pane was LOOKED FOR and was not there, so this is the one branch
                // here entitled to `no` rather than `not-measured` (KAN-498): the
                // registry was asked and it answered.
                return {
                    success: false,
                    error: `Agent '${agentName}' has no pane to send to`,
                    pane: {
                        reached: 'no',
                        detail: `herdr's agent record for '${agentName}' carries no pane_id, so there is no pane`
                    }
                };
            }
            // Exactly one Ctrl+C. One cancels the recipient's turn — its in-flight
            // tool call with it — which is the cost of this call. A second one is how
            // Claude Code quits, and would kill the very agent we are trying to talk
            // to, which is the cost of getting this wrong.
            this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);
            interruptSent = true;
            await delay(INTERRUPT_SETTLE_MS);
            this.runHerdr(['pane', 'send-text', paneId, message]);
            this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);
            return {
                success: true,
                pane: {
                    reached: 'typed',
                    // This runtime drives the pane itself, so it knows the Ctrl+C was
                    // issued. What it does NOT know is whether the client accepted the
                    // Enter — a lost Enter strands the text at the composer (nudge.ts,
                    // KAN-79) — so `submitted` is silence rather than a claim. Nothing
                    // here reads the pane back; `deliverToAgent` is what does.
                    interrupted: true,
                    submitted: 'not-measured',
                    // KAN-475: the name is DERIVED, not typed. This sentence reaches an
                    // agent as C2's basis, and a literal here is the same defect that
                    // ticket converted in `router.ts` — one file down.
                    detail: `${this.runtimeName} sent C-c, the text and Enter to pane ${paneId}; nothing here ` +
                        'read the pane back, so whether the Enter took is unmeasured'
                }
            };
        }
        catch (e) {
            const error = e?.message ?? String(e);
            console.error(`[HerdrBridge] Failed to send message to agent for key '${key}':`, error);
            return {
                success: false,
                error,
                pane: interruptSent
                    ? {
                        // The Ctrl+C had already gone in before this threw, so the pane is
                        // real and its composer has been cleared. Answering `no` here
                        // would be KAN-498's defect in miniature.
                        reached: 'typed',
                        interrupted: true,
                        submitted: 'not-measured',
                        detail: 'the interrupt reached the pane before the send failed, so the pane exists and its ' +
                            `composer was cleared: ${error}`
                    }
                    : {
                        reached: 'not-measured',
                        detail: `the send failed before any key reached a pane: ${error}`
                    }
            };
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
    resetWorkspace(type, key) {
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
    writePty(sessionId, data) {
        const session = sessionId ? this.getSession(sessionId) : undefined;
        if (!session)
            return false;
        if (session.ptyProcess) {
            session.ptyProcess.write(data);
        }
        return true;
    }
    resizePty(sessionId, cols, rows) {
        const session = sessionId ? this.getSession(sessionId) : undefined;
        if (!session)
            return false;
        if (session.ptyProcess && cols > 0 && rows > 0) {
            try {
                session.ptyProcess.resize(cols, rows);
            }
            catch (err) {
                // ignore resize errors if process ended
            }
        }
        return true;
    }
    /** The session's replay buffer, or `undefined` when there is no such session. */
    getPtyBuffer(sessionId) {
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
    registerDataListener(sessionId, listener) {
        const session = sessionId ? this.getSession(sessionId) : undefined;
        if (!session)
            return undefined;
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
    terminateSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return { success: false, error: `No session '${sessionId}' to terminate` };
        if (session.ptyProcess) {
            session.ptyProcess.kill();
        }
        const agentName = agentNameFor(session.type, session.key);
        let error;
        try {
            this.closePaneForAgent(agentName);
        }
        catch (e) {
            const code = e?.herdrCode;
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
