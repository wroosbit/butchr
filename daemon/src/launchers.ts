import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CMD = 'Please read and follow the instructions in .butchr-prompt.md to begin.';

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
      console.error('[Launchers] Replacing unparseable workspace .mcp.json', e);
      config = {};
    }
  }
  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write workspace .mcp.json', e);
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
      console.error('[Launchers] agy mcp.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  config.mcpServers = { ...config.mcpServers, ...mcpServerDefinitions(servers) };

  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write agy mcp.json', e);
  }
}

export interface AgentLauncher {
  /** Shell command run inside the herdr pane (via bash -c). */
  command: string;
  /** Optional pre-launch setup, e.g. CLI-specific MCP config. */
  setup?: (workDir: string, mcpServers: string[]) => void;
}

// The only agents Butchr will launch. defaultAgent arrives from extension
// storage and from MCP tool arguments; it selects from this table and is
// never itself executed as shell.
export const AGENT_LAUNCHERS: Record<string, AgentLauncher> = {
  shell: {
    command: 'bash'
  },
  claude: {
    // Interactive session: resume if a conversation exists, else start one
    // seeded with the bootstrap prompt. (`claude -p` would run one headless
    // turn and exit, leaving a dead pane.)
    command: `claude --continue || claude "${PROMPT_CMD}"`
  },
  'anti-gravity': {
    command: `agy --continue || agy -i "${PROMPT_CMD}"`,
    setup: (_workDir, mcpServers) => configureAgyMcp(mcpServers)
  }
};

export function resolveLauncher(name?: string): { name: string; launcher: AgentLauncher } {
  const requested = name || 'shell';
  const launcher = AGENT_LAUNCHERS[requested];
  if (launcher) {
    return { name: requested, launcher };
  }
  console.warn(`[Launchers] Unknown agent '${requested}'; falling back to shell`);
  return { name: 'shell', launcher: AGENT_LAUNCHERS['shell'] };
}
