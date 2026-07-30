import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HerdrSession {
  sessionId: string;
  type: string;
  key: string;
  url: string;
  createdAt: Date;
  status: 'initializing' | 'active' | 'terminated';
  workDir: string;
  ptyProcess?: pty.IPty;
  ptyBuffer: string;
  onDataListeners: Array<(data: string) => void>;
}

// MCP server definitions Butchr can attach to an agent workspace.
// The official Atlassian MCP is a remote endpoint; mcp-remote bridges it
// to stdio clients (OAuth browser flow on first use).
function mcpServerDefinitions(servers: string[]): Record<string, any> {
  const defs: Record<string, any> = {};
  if (servers.includes('atlassian')) {
    defs['atlassian'] = {
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse']
    };
  }
  if (servers.includes('butchr')) {
    defs['butchr'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp.js')]
    };
  }
  return defs;
}

// Claude Code reads .mcp.json from the project root, and each session's
// workDir is its project — so MCP config is scoped to the workspace instead
// of being injected into the user's global ~/.claude.json.
export function writeWorkspaceMcpConfig(workDir: string, servers: string[]): void {
  const defs = mcpServerDefinitions(servers);
  if (Object.keys(defs).length === 0) return;

  const configPath = path.join(workDir, '.mcp.json');
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      // Butchr owns this file; a corrupt one is replaced, not preserved.
      console.error('[HerdrBridge] Replacing unparseable workspace .mcp.json', e);
      config = {};
    }
  }
  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[HerdrBridge] Failed to write workspace .mcp.json', e);
  }
}

// The antigravity CLI has no project-scoped equivalent, so its global config
// is merged into — and never written when the existing file cannot be parsed,
// which would otherwise replace the user's config with just our entries.
export function configureAgyMcp(servers: string[], configPath?: string): void {
  const agyConfigPath = configPath ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp.json');
  const agyConfigDir = path.dirname(agyConfigPath);
  let config: any = {};
  if (fs.existsSync(agyConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(agyConfigPath, 'utf8'));
    } catch (e) {
      console.error('[HerdrBridge] agy mcp.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  config.mcpServers = { ...config.mcpServers, ...mcpServerDefinitions(servers) };

  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[HerdrBridge] Failed to write agy mcp.json', e);
  }
}

export class HerdrBridge {
  private sessions: Map<string, HerdrSession> = new Map();

  public spawnSession(type: string, key: string, url: string, promptContent: string, defaultAgent?: string, mcpServers?: string[]): HerdrSession {
    const sessionId = `${type}-${key.toLowerCase()}-${Date.now()}`;
    const defaultWorkDir = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces', type, key.toLowerCase());

    if (!fs.existsSync(defaultWorkDir)) {
      fs.mkdirSync(defaultWorkDir, { recursive: true });
    }

    console.log(`[HerdrBridge] Spawning PTY session: ${sessionId} in ${defaultWorkDir}`);
    
    const session: HerdrSession = {
      sessionId,
      type,
      key,
      url,
      createdAt: new Date(),
      status: 'active',
      workDir: defaultWorkDir,
      ptyBuffer: '',
      onDataListeners: []
    };

    this.sessions.set(sessionId, session);
    this.initPty(session, promptContent, defaultAgent, mcpServers);

    return session;
  }

  private initPty(session: HerdrSession, initialPrompt?: string, defaultAgent?: string, mcpServers?: string[]): void {
    const agentName = `butchr-${session.type}-${session.key.toLowerCase()}`;

    // Workspace-scoped MCP config, written for every agent type: Claude picks
    // up .mcp.json from its cwd, and the file documents the workspace either way.
    if (mcpServers && mcpServers.length > 0) {
      writeWorkspaceMcpConfig(session.workDir, mcpServers);
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
      let cmd = 'bash';
      if (defaultAgent && defaultAgent !== 'shell') {
        const promptCmd = `Please read and follow the instructions in .butchr-prompt.md to begin.`;
        if (defaultAgent === 'claude') {
          cmd = `claude --continue || claude -p "${promptCmd}"`;
        } else if (defaultAgent === 'anti-gravity') {
          if (mcpServers) configureAgyMcp(mcpServers);
          cmd = `agy --continue || agy -i "${promptCmd}"`;
        } else {
          cmd = defaultAgent;
        }
      }

      try {
        spawnSync('herdr', [
          'agent', 'start', agentName,
          '--cwd', session.workDir,
          '--',
          'bash', '-c', cmd
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
      
      // Send initial banner if it's a new session, or even if it's attached
      if (!agentExists) {
        setTimeout(() => {
          ptyProcess.write(`# Herdr Agent Session ${session.key} initialized\n`);
        }, 500);
      }

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

  public ensureDefaultSession(): HerdrSession {
    const active = this.listActiveSessions();
    if (active.length > 0) {
      return active[0];
    }
    return this.spawnSession('default', 'workspace', 'local', 'Default shell session');
  }

  public resetWorkspace(type: string, key: string): boolean {
    const workDir = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces', type, key.toLowerCase());
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        return true;
      }
      return false; // Already gone
    } catch (e) {
      console.error('[HerdrBridge] Failed to reset workspace:', e);
      return false;
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

    const agentName = `butchr-${session.type}-${session.key.toLowerCase()}`;
    try {
      const output = execSync(`herdr agent get ${agentName}`, { encoding: 'utf8' });
      const json = JSON.parse(output);
      if (json.result && json.result.agent && json.result.agent.pane_id) {
        execSync(`herdr pane close ${json.result.agent.pane_id}`);
      }
    } catch(e) {
      console.error('[HerdrBridge] Failed to close pane for agent', agentName, e);
    }

    session.status = 'terminated';
    return true;
  }
}
