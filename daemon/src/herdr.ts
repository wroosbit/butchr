import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLauncher, writeWorkspaceMcpConfig } from './launchers.js';
import { diagnoseSpawnFailure } from './herdr-health.js';
import {
  RESUME_ENV,
  ResumeCause,
  degradedResumePrompt,
  hasRestorableConversation
} from './resume.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  onDataListeners: Array<(data: string) => void>;
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
}

/**
 * herdr's own view of what an agent is doing, which is finer-grained than a
 * session's active/terminated bookkeeping: 'blocked' means the agent is
 * waiting on a human, which is the state a user most needs to see.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

const HERDR_AGENT_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

/** Ceiling on any single herdr CLI call, so a wedged herdr can't hang a caller. */
const HERDR_CLI_TIMEOUT_MS = 5000;

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

/** Time the agent's TUI gets to redraw after the interrupt, before we type. */
const INTERRUPT_SETTLE_MS = 100;

/** How much of an agent's terminal a tail returns when the caller doesn't say. */
const TAIL_DEFAULT_LINES = 40;

/** Ceiling on a tail, so one call can't drag a whole scrollback over the wire. */
const TAIL_MAX_LINES = 200;

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

/** The herdr agent a Butchr session drives. Sessions are keyed by workspace. */
export function agentNameFor(type: string, key: string): string {
  return `butchr-${type}-${key.toLowerCase()}`;
}

/**
 * The one directory tree Butchr owns and may therefore destroy. Every
 * workspace is created under it (see `initPty`), and reset refuses to delete
 * anything that does not resolve to a place strictly inside it.
 */
export function workspacesRoot(): string {
  return path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');
}

/** Where a workspace of this type and key lives. Must match `initPty`. */
export function workspaceDirFor(type: string, key: string): string {
  return path.join(workspacesRoot(), type, key.toLowerCase());
}

/**
 * Whether `target` sits strictly below `root` — the root itself is not
 * "inside" it, because deleting the root would take every workspace with it.
 *
 * `path.relative` rather than a `startsWith` prefix test: the latter says yes
 * to `/…/workspaces-old` for root `/…/workspaces`, and both paths must
 * already be real (symlinks resolved) for either test to mean anything.
 */
function isStrictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

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
 * workspace types are single tokens (`task`, `manage`, `story`, `default`)
 * while keys routinely contain dashes (`kan-28`). That is a convention, not a
 * guarantee, so the parse is only trusted when it rebuilds the name it came
 * from — a name this daemon could never have produced yields null rather than
 * a guessed address that later calls would fail to resolve.
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

export class HerdrBridge {
  private sessions: Map<string, HerdrSession> = new Map();

  /** Set by the daemon so a dying PTY can be announced to connected clients. */
  private sessionEndedListener?: (event: SessionEndedEvent) => void;

  public setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void {
    this.sessionEndedListener = listener;
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

  // `url` is `string | undefined` rather than optional: it sits in front of
  // required parameters, and callers who have no URL must pass nothing rather
  // than a placeholder.
  public spawnSession(type: string, key: string, url: string | undefined, promptContent: string, defaultAgent?: string, mcpServers?: string[], resume?: ResumeCause): HerdrSession {
    // One attach per agent, enforced here rather than in each caller. The
    // routers dedupe by key alone, which misses a second workspace *type* on
    // the same key, and the MCP server and the sidepanel's re-attach path can
    // both ask to activate the same agent at once. A second attach would evict
    // the first, so the only safe answer is the session we already have.
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

  private initPty(session: HerdrSession, initialPrompt?: string, defaultAgent?: string, mcpServers?: string[]): void {
    const agentName = agentNameFor(session.type, session.key);

    // Workspace-scoped MCP config, written for every agent type: Claude picks
    // up .mcp.json from its cwd, and the file documents the workspace either way.
    if (mcpServers && mcpServers.length > 0) {
      writeWorkspaceMcpConfig(session.workDir, mcpServers);
    }

    // Agent-specific provisioning, also on every activation: it is idempotent,
    // and a workspace reset out from under a live herdr agent would otherwise
    // never get its settings back.
    const { launcher: setupLauncher } = resolveLauncher(defaultAgent);
    if (setupLauncher.setup) {
      setupLauncher.setup(session.workDir, mcpServers ?? []);
    }

    if (initialPrompt) {
      const promptFile = path.join(session.workDir, '.butchr-prompt.md');
      try {
        fs.writeFileSync(promptFile, initialPrompt);
      } catch (e) {
        console.error('[HerdrBridge] Failed to write prompt file', e);
      }
    }

    let agentExists = false;
    try {
      const output = execSync(`herdr agent get ${agentName}`, { encoding: 'utf8' });
      const json = JSON.parse(output);
      if (json.result && json.result.agent) agentExists = true;
    } catch(e) {}

    if (!agentExists) {
      const { launcher } = resolveLauncher(defaultAgent);

      // What the agent is told when there is no conversation to continue. On a
      // resume with nothing on disk that must not be the cold-start prompt: an
      // agent greeted as if it were starting fresh would claim its ticket and
      // begin again, silently redoing — or conflicting with — work it had
      // already committed. See resume.ts.
      const fallbackPrompt =
        session.resume && session.resumedConversation === false
          ? degradedResumePrompt(session.type, session.key, session.resume)
          : undefined;

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
        this.startAgentInOwnTab(agentName, session.workDir, [
          'env',
          `PATH=${process.env.PATH}`,
          ...Object.entries(RESUME_ENV).map(([name, value]) => `${name}=${value}`),
          'bash', '-c', launcher.command(fallbackPrompt)
        ]);
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
      const ptyProcess = pty.spawn('herdr', attachArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: session.workDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          BUTCHR_WORKSPACE_TYPE: session.type,
          BUTCHR_WORKSPACE_KEY: session.key
        } as Record<string, string>
      });

      session.ptyProcess = ptyProcess;

      ptyProcess.onData((data: string) => {
        session.ptyBuffer = (session.ptyBuffer + data).slice(-100000);
        session.onDataListeners.forEach(fn => fn(data));
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
    } catch (e) {
      // No PTY means no attach: leaving the session 'active' would make
      // liveAttachFor claim an attach that does not exist, and every later
      // activate would be refused in favour of this dead session.
      session.status = 'terminated';
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
    let output: string;
    try {
      output = execSync('herdr agent list', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      return [];
    }

    try {
      const agents = JSON.parse(output)?.result?.agents;
      if (!Array.isArray(agents)) return [];

      return agents
        .filter((agent: any) => agent && typeof agent.name === 'string')
        .map((agent: any) => ({
          name: agent.name as string,
          agentRuntime: typeof agent.agent === 'string' && agent.agent ? agent.agent : null,
          workDir: typeof agent.cwd === 'string' ? agent.cwd : null,
          herdrStatus: toAgentStatus(agent.agent_status)
        }));
    } catch (e) {
      console.error('[HerdrBridge] Could not parse `herdr agent list` output', e);
      return [];
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
    const session = this.getSessionByKey(key);
    if (session) return agentNameFor(session.type, session.key);

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
   * The session for an address, if this daemon owns one. An explicit type has
   * to match: a session for a different type is a different agent, and
   * answering with it would silently ignore the address the caller gave.
   */
  public getSessionByAddress(key: string, type?: string): HerdrSession | undefined {
    const session = this.getSessionByKey(key);
    if (!session) return undefined;
    const trimmedType = typeof type === 'string' ? type.trim() : '';
    if (trimmedType && session.type !== trimmedType) return undefined;
    return session;
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
   * The tail of an agent's terminal, as plain text. `recent-unwrapped` is the
   * source that shows what actually scrolled past — including the frozen last
   * frame of an agent whose process died, which is the state this exists to
   * make visible. Never throws; the caller owes its client a response.
   */
  public tailAgent(
    key: string,
    type?: string,
    lines?: number
  ): { success: boolean; text?: string; truncated?: boolean; error?: string } {
    try {
      const agentName = this.agentNameForAddress(key, type);
      const read = this.runHerdr([
        'agent', 'read', agentName,
        '--source', 'recent-unwrapped',
        '--format', 'text',
        '--lines', String(clampTailLines(lines))
      ])?.result?.read;

      if (!read || typeof read.text !== 'string') {
        throw new Error(`herdr returned no readable output for agent '${agentName}'`);
      }

      return { success: true, text: read.text, truncated: read.truncated === true };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to tail agent for key '${key}':`, error);
      return { success: false, error };
    }
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
   * Tear down the agent behind a workspace key without needing a session. The
   * session map dies with the daemon while the herdr pane outlives it, so both
   * deactivate and reset resolve the agent through the same herdr-list
   * fallback `sendToAgent` uses. Never throws — the caller is a request
   * handler that owes its client a response either way.
   */
  public closeAgentByKey(key: string): { success: boolean; agentName?: string; error?: string } {
    let agentName: string;
    try {
      agentName = this.resolveAgentName(key);
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
   * Deliver a message to an agent's terminal the way a human would: clear
   * whatever is half-typed, type the message, submit it. Never throws — the
   * caller is a request handler that owes its client a response either way.
   */
  public async sendToAgent(key: string, message: string, type?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const agentName = this.agentNameForAddress(key, type);
      const paneId = this.runHerdr(['agent', 'get', agentName])?.result?.agent?.pane_id;
      if (typeof paneId !== 'string' || !paneId) {
        throw new Error(`Agent '${agentName}' has no pane to send to`);
      }

      // Exactly one Ctrl+C. It clears a partially typed line, but a second
      // one is how Claude Code quits — which would kill the very agent we are
      // trying to talk to.
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

  public ensureDefaultSession(): HerdrSession {
    const active = this.listActiveSessions();
    if (active.length > 0) {
      return active[0];
    }
    return this.spawnSession('default', 'workspace', 'local', 'Default shell session');
  }

  /**
   * Delete a workspace directory, and nothing else. This is a recursive
   * delete, so the containment check in front of it is the only thing standing
   * between a malformed key (`../..`), a symlinked workspace, or some future
   * caller that invents its own workspace location, and an `rm -rf` pointed
   * somewhere Butchr does not own. Refusals return an error rather than
   * falling through: there is no path here that deletes an unvalidated target.
   *
   * `error` is set only when the delete was *refused*; a workspace that was
   * already gone reports `success: false` with no error, as before.
   */
  public resetWorkspace(type: string, key: string): { success: boolean; error?: string } {
    const root = workspacesRoot();
    const workDir = workspaceDirFor(type, key);

    const refuse = (reason: string) => {
      const error =
        `Refusing to reset workspace '${type}/${key}': ${reason}. ` +
        `Only directories strictly inside '${root}' may be deleted.`;
      console.error(`[HerdrBridge] ${error}`);
      return { success: false, error };
    };

    // Lexical check first, so a traversal key is rejected by name even when it
    // points at nothing — the answer must not depend on what happens to exist.
    if (!isStrictlyInside(root, workDir)) {
      return refuse(`'${workDir}' is not inside the workspaces root`);
    }

    try {
      if (!fs.existsSync(workDir)) {
        return { success: false }; // Already gone
      }

      // Then the real check. A symlink at (or above) the workspace passes the
      // lexical test while pointing anywhere on the filesystem, so both sides
      // are resolved before they are compared.
      let realRoot: string;
      let realTarget: string;
      try {
        realRoot = fs.realpathSync(root);
        realTarget = fs.realpathSync(workDir);
      } catch (e: any) {
        return refuse(`'${workDir}' could not be resolved (${e?.message ?? String(e)})`);
      }
      if (!isStrictlyInside(realRoot, realTarget)) {
        return refuse(`'${workDir}' resolves to '${realTarget}', outside the workspaces root`);
      }

      fs.rmSync(workDir, { recursive: true, force: true });
      return { success: true };
    } catch (e: any) {
      const error = `Failed to reset workspace '${workDir}': ${e?.message ?? String(e)}`;
      console.error('[HerdrBridge]', error);
      return { success: false, error };
    }
  }

  public writePty(sessionId: string | undefined, data: string): void {
    let session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) {
      session = this.ensureDefaultSession();
    }
    if (session && session.ptyProcess) {
      session.ptyProcess.write(data);
    }
  }

  public resizePty(sessionId: string | undefined, cols: number, rows: number): void {
    let session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) {
      session = this.ensureDefaultSession();
    }
    if (session && session.ptyProcess && cols > 0 && rows > 0) {
      try {
        session.ptyProcess.resize(cols, rows);
      } catch (err) {
        // ignore resize errors if process ended
      }
    }
  }

  public getPtyBuffer(sessionId: string | undefined): string {
    let session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) {
      session = this.ensureDefaultSession();
    }
    return session ? session.ptyBuffer : '';
  }

  public registerDataListener(sessionId: string | undefined, listener: (data: string) => void): () => void {
    let session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) {
      session = this.ensureDefaultSession();
    }
    session.onDataListeners.push(listener);
    return () => {
      if (session) {
        session.onDataListeners = session.onDataListeners.filter(l => l !== listener);
      }
    };
  }

  public terminateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.ptyProcess) {
      session.ptyProcess.kill();
    }

    const agentName = agentNameFor(session.type, session.key);
    try {
      this.closePaneForAgent(agentName);
    } catch(e) {
      console.error('[HerdrBridge] Failed to close pane for agent', agentName, e);
    }

    session.status = 'terminated';
    return true;
  }
}
