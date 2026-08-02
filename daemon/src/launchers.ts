import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { which } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CMD = 'Please read and follow the instructions in .butchr-prompt.md to begin.';

// MCP server definitions Butchr can attach to an agent workspace.
// The official Atlassian MCP is a remote endpoint; mcp-remote bridges it
// to stdio clients (OAuth browser flow on first use).
function mcpServerDefinitions(servers: string[]): Record<string, any> {
  const defs: Record<string, any> = {};
  // Absolute commands: the agent spawns these with the *pane's* PATH, which
  // can be thinner than ours (a login-started herdr server has no nvm) and
  // resolve `node`/`npx` to an ancient system install. The daemon rewrites
  // this file on every activation, so the baked paths never go stale.
  if (servers.includes('atlassian')) {
    defs['atlassian'] = {
      command: which('npx') ?? 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp']
    };
  }
  if (servers.includes('butchr')) {
    defs['butchr'] = {
      command: process.execPath,
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
  const defs = mcpServerDefinitions(servers);
  // Nothing to contribute: leave the user's global config alone entirely.
  if (Object.keys(defs).length === 0) return;

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

  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write agy mcp.json', e);
  }
}

// Claude Code's per-project settings. `.claude/settings.local.json` sits in
// the workspace, so it is Butchr's to create — but a resumed workspace may
// already hold keys Claude Code wrote itself (it records enabledMcpjsonServers
// there once a human approves the .mcp.json servers), so merge rather than
// replace, and bail on a file we cannot parse.
export function configureClaudeSettings(workDir: string): void {
  const settingsPath = path.join(workDir, '.claude', 'settings.local.json');
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error('[Launchers] workspace settings.local.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  // Auto-approves the workspace .mcp.json servers, so no approval prompt.
  settings.enableAllProjectMcpServers = true;
  // Full bypass, not acceptEdits: acceptEdits still routes Bash through the
  // permission classifier, which strands an unattended agent on commands a
  // human would have waved through. Butchr workspaces are disposable and
  // agent-owned, so the agent runs without a prompt gate at all.
  settings.permissions = { ...settings.permissions, defaultMode: 'bypassPermissions' };

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write workspace settings.local.json', e);
  }
}

// Folder trust has no project-scoped setting — Claude Code only reads it from
// `projects[<dir>].hasTrustDialogAccepted` in the user's global ~/.claude.json
// (its own untrusted-workspace error names that key as the sole alternative to
// accepting the dialog by hand). That file holds unrelated user state, so this
// is add-only: bail if unparseable, write nothing if already trusted, and touch
// no key but this workspace's. The trust check walks parent directories, so
// trusting workDir also covers the git worktree the agent clones inside it.
export function trustClaudeWorkspace(workDir: string, configPath?: string): void {
  const claudeConfigPath = configPath ?? path.join(os.homedir(), '.claude.json');
  // Claude Code keys projects by the normalized absolute path, nothing more.
  const trustKey = path.normalize(path.resolve(workDir));

  let config: any = {};
  if (fs.existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
    } catch (e) {
      console.error('[Launchers] ~/.claude.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  if (config.projects?.[trustKey]?.hasTrustDialogAccepted === true) return;

  config.projects = {
    ...config.projects,
    [trustKey]: { ...config.projects?.[trustKey], hasTrustDialogAccepted: true }
  };

  try {
    fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to record workspace trust in ~/.claude.json', e);
  }
}

/**
 * Wrap a string so bash sees exactly these bytes, newlines and all.
 *
 * The launcher command is handed to `bash -c`, and the prompt inside it is now
 * generated text (the degraded-resume framing) rather than a fixed literal, so
 * it must be quoted rather than interpolated. Single quotes disable every form
 * of bash expansion; the only character that needs work is a single quote
 * itself, which is closed, escaped and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface AgentLauncher {
  /**
   * Shell command run inside the herdr pane (via bash -c).
   *
   * A function rather than a constant because the fallback prompt is no longer
   * always the same sentence: an agent being restored after a reboot whose
   * conversation could not be recovered must be told that, not greeted as if
   * it were starting fresh. `promptCommand` is what to say when there is no
   * conversation to continue; omitted, it is the ordinary cold start.
   */
  command: (promptCommand?: string) => string;
  /** Optional pre-launch setup, e.g. CLI-specific MCP config. */
  setup?: (workDir: string, mcpServers: string[]) => void;
}

// The only agents Butchr will launch. defaultAgent arrives from extension
// storage and from MCP tool arguments; it selects from this table and is
// never itself executed as shell.
//
// The resolution rule (KAN-53): an omitted defaultAgent means DEFAULT_AGENT
// (`claude`); an unknown one refuses the activation. Nothing resolves to
// `shell` unless the caller asks for `shell` by name. The old rule was
// `name || 'shell'` plus a warn-and-fall-back for unknown names, and both
// halves were the same trap: an activation that omitted or misspelled the
// field got a bare bash prompt wearing an agent's name, reported
// `success: true, verified: true` because a pane by that name did exist, and
// executed `butchr_send_to_agent` messages as shell commands (live incident,
// 2026-08-02 — a story agent was a shell for twenty minutes).
//
// Default-to-claude was chosen over refuse-when-absent. Omission has exactly
// one meaning in practice: standby records written before KAN-38 recorded
// defaultAgent carry none (`defaultAgent: null`), and the sidepanel's
// reactivation path (useFleetControls) omits the field for them — under a
// refusal those agents would be stranded behind an error the sidepanel gives
// the user no way to amend, while under the default they come back as the
// claude agents they were. Refuse-when-absent is the more honest shape, but
// it spends its honesty on exactly the callers who cannot supply the field.
// The cost of the default is a silent wrong choice if a second default-worthy
// runtime ever ships; the day the fleet stops being all-claude, revisit
// DEFAULT_AGENT rather than assume it.
//
// `shell` stays in the table because it is a legitimate *explicit* request —
// verify scripts activate it as a fixture, and expectsRuntime() in router.ts
// reads the recorded value to excuse a pane that is a bare prompt on purpose
// — but it is reachable only by `defaultAgent: 'shell'`, never by omission
// and never by fallback.
export const AGENT_LAUNCHERS: Record<string, AgentLauncher> = {
  shell: {
    command: () => 'bash'
  },
  claude: {
    // Interactive session: resume if a conversation exists, else start one
    // seeded with the bootstrap prompt. (`claude -p` would run one headless
    // turn and exit, leaving a dead pane.)
    // --permission-mode backs up the settings file on the --continue path,
    // where a resumed session could otherwise carry a stale mode forward.
    //
    // The `||` is load-bearing and was measured: `claude --continue` in a
    // directory with no history exits 1 with "No conversation found to
    // continue", so the fallback is reached exactly when there is nothing to
    // restore — which is what makes it the right place to put the degraded
    // resume prompt.
    command: (promptCommand = PROMPT_CMD) =>
      `claude --permission-mode bypassPermissions --continue || ` +
      `claude --permission-mode bypassPermissions ${shellQuote(promptCommand)}`,
    setup: (workDir) => {
      configureClaudeSettings(workDir);
      trustClaudeWorkspace(workDir);
    }
  },
  'anti-gravity': {
    command: (promptCommand = PROMPT_CMD) =>
      `agy --continue || agy -i ${shellQuote(promptCommand)}`,
    setup: (_workDir, mcpServers) => configureAgyMcp(mcpServers)
  }
};

/** What an omitted defaultAgent means. See the block above AGENT_LAUNCHERS. */
export const DEFAULT_AGENT = 'claude';

/**
 * Map a requested agent name to its launcher.
 *
 * Omitted or blank resolves to DEFAULT_AGENT. An unknown name throws, and the
 * message names the valid launchers — the rule KAN-25 set for pty_init's
 * unknown sessionId: refuse rather than substitute something plausible.
 * initPty turns the throw into session.spawnError, the channel activate
 * already answers `success: false` from, so the refusal reaches the caller
 * without new vocabulary.
 */
export function resolveLauncher(name?: string): { name: string; launcher: AgentLauncher } {
  const requested = name?.trim() ? name.trim() : DEFAULT_AGENT;
  const launcher = AGENT_LAUNCHERS[requested];
  if (!launcher) {
    throw new Error(
      `Unknown agent '${requested}'. Valid launchers: ${Object.keys(AGENT_LAUNCHERS).join(', ')}. ` +
      `Pass one of these as defaultAgent, or omit it to get '${DEFAULT_AGENT}'.`
    );
  }
  return { name: requested, launcher };
}
