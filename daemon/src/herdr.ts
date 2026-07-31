import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveLauncher, writeWorkspaceMcpConfig } from './launchers.js';
import { WORKSPACES_ROOT, isInsideWorkspacesRoot, resolveWorkDir } from './workspaces.js';

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

/** Time the agent's TUI gets to redraw after the interrupt, before we type. */
const INTERRUPT_SETTLE_MS = 100;

/** How much of an agent's terminal a tail returns when the caller doesn't say. */
const TAIL_DEFAULT_LINES = 40;

/** Ceiling on a tail, so one call can't drag a whole scrollback over the wire. */
const TAIL_MAX_LINES = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The herdr agent a Butchr session drives. Sessions are keyed by workspace. */
export function agentNameFor(type: string, key: string): string {
  return `butchr-${type}-${key.toLowerCase()}`;
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

export class HerdrBridge {
  private sessions: Map<string, HerdrSession> = new Map();

  // `url` is `string | undefined` rather than optional: it sits in front of
  // required parameters, and callers who have no URL must pass nothing rather
  // than a placeholder.
  // `configuredWorkDir` is the workspace type's `workDir` override, already
  // read off its config by the caller; omitted, the session gets the usual
  // per-key directory under the workspaces root.
  public spawnSession(type: string, key: string, url: string | undefined, promptContent: string, defaultAgent?: string, mcpServers?: string[], configuredWorkDir?: string): HerdrSession {
    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    const workDir = resolveWorkDir(type, key, configuredWorkDir);

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    console.log(`[HerdrBridge] Spawning PTY session: ${sessionId} in ${workDir}`);

    const session: HerdrSession = {
      sessionId,
      type,
      key,
      url,
      createdAt: new Date(),
      status: 'active',
      workDir,
      ptyBuffer: '',
      onDataListeners: []
    };

    this.sessions.set(sessionId, session);
    this.initPty(session, promptContent, defaultAgent, mcpServers);

    return session;
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

      try {
        // The pane inherits the herdr *server's* environment, not ours — and
        // that server is typically started at login with a thin PATH (no
        // nvm). Inject the daemon's normalized PATH so the agent and every
        // MCP server it spawns resolve the same tools we do. argv-level
        // `env` avoids shell quoting entirely.
        spawnSync('herdr', [
          'agent', 'start', agentName,
          '--cwd', session.workDir,
          '--',
          'env', `PATH=${process.env.PATH}`, 'bash', '-c', launcher.command
        ]);
      } catch (e) {
        console.error('[HerdrBridge] Failed to start herdr agent', e);
      }
    }

    try {
      const ptyProcess = pty.spawn('herdr', ['agent', 'attach', agentName, '--takeover'], {
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
        console.log(`[HerdrBridge] PTY for session ${session.sessionId} exited with code ${exitCode}`);
        session.status = 'terminated';
      });
    } catch (e) {
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
   * Every agent herdr knows about, as name -> agent_status. herdr is an
   * optional external binary, so an unavailable, slow, or unparseable herdr
   * yields an empty map: callers fall back to 'unknown' rather than failing.
   */
  public listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    const statuses = new Map<string, HerdrAgentStatus>();

    let output: string;
    try {
      output = execSync('herdr agent list', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      return statuses;
    }

    try {
      const agents = JSON.parse(output)?.result?.agents;
      if (!Array.isArray(agents)) return statuses;

      for (const agent of agents) {
        if (agent && typeof agent.name === 'string') {
          statuses.set(agent.name, toAgentStatus(agent.agent_status));
        }
      }
    } catch (e) {
      console.error('[HerdrBridge] Could not parse `herdr agent list` output', e);
    }

    return statuses;
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
      throw new Error(reported.message ?? `herdr reported ${reported.code ?? 'an error'}`);
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
   * Why a reset must not proceed, or null when it may. Callers check this
   * *before* tearing the agent down: a refused reset has to be a no-op, not a
   * killed agent followed by an error.
   */
  public resetRefusal(type: string, key: string, configuredWorkDir?: string): string | null {
    const workDir = resolveWorkDir(type, key, configuredWorkDir);
    if (isInsideWorkspacesRoot(workDir)) return null;
    return `Refusing to reset '${workDir}': only directories strictly inside ${WORKSPACES_ROOT} can be deleted`;
  }

  /**
   * Delete a workspace directory. The guard is not a formality: types may set
   * a `workDir` of their own, `manage` sets it to `~`, and a reset that took
   * the configured directory on trust would `rm -rf` the user's home. Nothing
   * outside the workspaces root is ever deleted — including the root itself,
   * whose removal would take every other agent's workspace with it.
   */
  public resetWorkspace(type: string, key: string, configuredWorkDir?: string): { success: boolean; error?: string } {
    const refusal = this.resetRefusal(type, key, configuredWorkDir);
    if (refusal) {
      console.error(`[HerdrBridge] ${refusal}`);
      return { success: false, error: refusal };
    }

    const workDir = resolveWorkDir(type, key, configuredWorkDir);
    try {
      if (!fs.existsSync(workDir)) {
        return { success: false, error: `No workspace directory at ${workDir}` };
      }
      fs.rmSync(workDir, { recursive: true, force: true });
      return { success: true };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error('[HerdrBridge] Failed to reset workspace:', e);
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
