import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServerDefinitions } from './integrations/integration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CMD = 'Please read and follow the instructions in .butchr-prompt.md to begin.';

/**
 * Butchr's own MCP server — core, not an integration.
 *
 * It is the daemon talking to itself: the tools an agent uses to see and drive
 * the fleet it belongs to. Every agent gets it regardless of which
 * integrations are configured, which is precisely what makes it core rather
 * than something to be declared and gated. Integration-owned servers (Jira's
 * `atlassian`, for one) live with their integrations; this used to sit beside
 * them in a hardcoded if-chain here, and that chain is what KAN-85 removed.
 *
 * Resolved on every call for the same reason the integrations' are — the
 * daemon rewrites `.mcp.json` on every activation so baked paths cannot go
 * stale.
 */
export function coreMcpServerDefinitions(): McpServerDefinitions {
  return {
    [CORE_MCP_SERVER]: {
      command: process.execPath,
      args: [path.join(__dirname, 'mcp.js')]
    }
  };
}

/** The one server this module owns; `withWorkspaceIdentity` stamps only it. */
export const CORE_MCP_SERVER = 'butchr';

/**
 * The argv flags the core MCP server reads its caller's identity from.
 *
 * Declared here, beside the writer, and imported by the reader (mcp.ts) so the
 * two spellings cannot drift apart. A mismatch here would reproduce KAN-145
 * exactly: a value written where nothing reads it.
 */
export const WORKSPACE_TYPE_FLAG = '--workspace-type';
export const WORKSPACE_KEY_FLAG = '--workspace-key';

/** The workspace an agent belongs to, as the daemon addresses it. */
export interface WorkspaceIdentity {
  type: string;
  key: string;
}

/**
 * Stamp a workspace's own identity onto the core server's command line.
 *
 * This is the first link of the parentage chain, and KAN-145 is what happens
 * when it is missing: `mcp.ts` attaches the caller's `workspaceType`/`Key` to
 * every daemon request and `supervisorOfRecord` (router.ts) records them, but
 * *nothing set them in the agent's process*. The only setter was an env block
 * on the `herdr agent attach` PTY in herdr.ts — a client process that is not in
 * the agent's ancestry — so every activation came back `activatedBy: null` and
 * the org chart had nothing to draw. See docs/agent-tree.md.
 *
 * WHY ARGV AND NOT `env`, WHICH IS THE OTHER OBVIOUS HOME (task 2 of KAN-145):
 *
 *   1. It leaves KAN-106's withholding rule exactly as strict. `describeMcpServers`
 *      in router.ts reports any `env`-carrying definition by name alone, because
 *      `env` is where a credential would ride. Giving `butchr` an `env` would
 *      have hidden the core server's command line from the settings page for no
 *      security reason — and the fix for that would have been an exemption to a
 *      security rule, bought by a plumbing change. Nothing here loosens it.
 *   2. A workspace type and key are provably not secret: they are the ticket
 *      key, rendered in the sidepanel, the Agents page and every log line. The
 *      convention stated on `McpServerDefinition` is that credentials go in
 *      `env` — non-secret configuration in `args` is that convention observed,
 *      not bent.
 *   3. argv is the mechanism with the fewest assumptions left in it. A client
 *      that spawns the server at all necessarily passes its argv; whether a
 *      client forwards a declared `env` is a feature it could lack. Both were
 *      measured against the real Claude Code before this was written — see the
 *      probe transcript in the KAN-145 PR — and argv additionally shows up in
 *      `ps` and `/proc/<pid>/cmdline`, which is precisely what nobody could
 *      check while this bug was live.
 *
 * Applied to the workspace `.mcp.json` only, never to the global agy config
 * (`configureAgyMcp`): that file is one file for every workspace, so a
 * per-workspace identity written into it would name whichever agent was
 * activated last. Recording the wrong supervisor is worse than recording none,
 * so anti-gravity agents stay parentless until their CLI grows a
 * project-scoped config. Stated in docs/agent-tree.md rather than left to be
 * discovered.
 *
 * Takes freshly-built definitions (`coreMcpServerDefinitions()` resolves on
 * every call, by design) so appending cannot accumulate across activations.
 */
export function withWorkspaceIdentity(
  defs: McpServerDefinitions,
  identity: WorkspaceIdentity
): McpServerDefinitions {
  const core = defs[CORE_MCP_SERVER];
  if (!core || !identity.type || !identity.key) return defs;
  return {
    ...defs,
    [CORE_MCP_SERVER]: {
      ...core,
      args: [
        ...core.args,
        WORKSPACE_TYPE_FLAG, identity.type,
        WORKSPACE_KEY_FLAG, identity.key
      ]
    }
  };
}

/**
 * Turn Butchr's own fields on a definition into what an MCP client actually
 * reads — the one place that happens, applied by every writer below.
 *
 * TWO FIELDS, BOTH ADDED BY KAN-157:
 *
 *   `pathPrefix` becomes `env.PATH`, its directories placed ahead of the
 *   daemon's own PATH. This is the field that decides which Node runs an
 *   npx-based server: `npx` and the bin of whatever it fetches are both
 *   `#!/usr/bin/env node`, so the interpreter comes from PATH regardless of how
 *   `command` is spelled — see node-runtime.ts for the measurements. The daemon
 *   composes the value: an integration supplies directories and never a whole
 *   PATH, which is what keeps this from becoming a way to hand a server an
 *   arbitrary environment.
 *
 *   `unusable` is dropped. It is Butchr's note about a server that cannot start
 *   here — read by the activation refusal in herdr.ts and by the settings page —
 *   and no MCP client has a key by that name. Writing it would put a sentence of
 *   English into a config file where a reader could take it for a setting.
 *
 * A definition with neither field is returned unchanged, so the file written for
 * today's `butchr` server is byte-identical to what it was before this existed.
 */
export function materializeMcpServers(defs: McpServerDefinitions): McpServerDefinitions {
  const out: McpServerDefinitions = {};
  for (const [name, definition] of Object.entries(defs)) {
    const { pathPrefix, unusable, ...rest } = definition;
    if (!pathPrefix || pathPrefix.length === 0) {
      out[name] = rest;
      continue;
    }
    const entries: string[] = [];
    for (const part of [...pathPrefix, ...(process.env.PATH || '').split(':')]) {
      if (part && !entries.includes(part)) entries.push(part);
    }
    out[name] = { ...rest, env: { ...rest.env, PATH: entries.join(':') } };
  }
  return out;
}

/**
 * The servers that cannot start on this machine, as `name: why` pairs.
 *
 * Separated from the writers because the answer is needed *before* anything is
 * written: an activation that would provision a workspace whose Atlassian server
 * is dead on arrival is refused rather than completed (KAN-157, in KAN-84's
 * voice). Empty is the normal answer.
 */
export function unusableMcpServers(defs: McpServerDefinitions): Array<[string, string]> {
  return Object.entries(defs)
    .filter(([, definition]) => typeof definition.unusable === 'string' && definition.unusable !== '')
    .map(([name, definition]) => [name, definition.unusable as string]);
}

// Claude Code reads .mcp.json from the project root, and each session's
// workDir is its project — so MCP config is scoped to the workspace instead
// of being injected into the user's global ~/.claude.json.
//
// The definitions arrive assembled — core plus every configured integration's,
// see MessageRouter.mcpServersForSpawn — rather than as names this module
// resolves against a table of its own. Which servers exist is the
// integrations' knowledge; writing them into the workspace is this module's.
//
// Caller-stamped, not stamped here: herdr.ts passes these through
// `withWorkspaceIdentity` first, because the identity belongs to the workspace
// being written and this function is also how a plain assembly is written in
// the proof scripts. What lands on disk for a real activation therefore carries
// the two identity flags on the core server; see withWorkspaceIdentity.
export function writeWorkspaceMcpConfig(workDir: string, defs: McpServerDefinitions): void {
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
  config.mcpServers = { ...config.mcpServers, ...materializeMcpServers(defs) };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write workspace .mcp.json', e);
  }
}

// The antigravity CLI has no project-scoped equivalent, so its global config
// is merged into — and never written when the existing file cannot be parsed,
// which would otherwise replace the user's config with just our entries.
export function configureAgyMcp(defs: McpServerDefinitions, configPath?: string): void {
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

  config.mcpServers = { ...config.mcpServers, ...materializeMcpServers(defs) };

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

/** Outcome of recording folder trust; `ok: false` must refuse the activation. */
export interface TrustResult {
  ok: boolean;
  /** Write attempts made; 0 when the entry was already present on first read. */
  attempts: number;
  error?: string;
}

/**
 * Synchronous sleep. initPty is deliberately synchronous from resolveLauncher
 * to the spawn — no await for another activation to interleave into — and the
 * retries inside that stretch (the trust write below, the prompt-file write in
 * herdr.ts) must stay inside that property, so their delays cannot be Promises.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How many times a clobbered trust entry is rewritten before the activation is
 * refused, and how long each write is given to be overwritten before it is
 * believed. Verifying in the same tick as the write proves nothing — the file
 * would still hold our own bytes even mid-race — so each attempt waits
 * TRUST_SETTLE_MS first, long enough for a competing writer's write-back to
 * land where the re-read can still see and repair it. Three attempts is not
 * tuning: a writer that outruns two repairs is rewriting the file continuously,
 * and no bounded retry beats that — refusing honestly does.
 */
const TRUST_WRITE_ATTEMPTS = 3;
const TRUST_SETTLE_MS = 60;

// Folder trust has no project-scoped setting — Claude Code only reads it from
// `projects[<dir>].hasTrustDialogAccepted` in the user's global ~/.claude.json
// (its own untrusted-workspace error names that key as the sole alternative to
// accepting the dialog by hand). That file holds unrelated user state, so this
// is add-only: bail if unparseable, write nothing if already trusted, and touch
// no key but this workspace's. The trust check walks parent directories, so
// trusting workDir also covers the git worktree the agent clones inside it.
//
// The write is racing Claude Code itself, and that fact picked the mechanism
// (KAN-54). Live incident, 2026-08-02: four story agents activated within ~7s;
// the last one's trust entry was missing from ~/.claude.json when its claude
// booted, and it sat wedged on the trust dialog behind a `success: true,
// verified: true` answer. Two candidate writers were named and tested:
//
//   1. A second briefly-coexisting daemon (the connectToDaemon spawn race in
//      ipc.ts). Ruled out structurally: the loser daemon hits EADDRINUSE,
//      probes the winner's socket and exits *without ever listening*
//      (daemon.ts), and boot restoration — its only write path to this file —
//      runs in onListen. A daemon that never serves never writes.
//
//   2. The spawned `claude` processes themselves. Reproduced with the real
//      binary on 2026-08-02: claude reads ~/.claude.json at boot and writes
//      the whole file back from memory moments later; a trust entry injected
//      between that read and write-back (t+0.45s into boot, present on disk at
//      t+0.47s) was gone at t+0.48s and stayed gone. A sibling booting for an
//      earlier workspace erases entries written after its read — the incident
//      shape exactly, down to the *last*-activated workspace being the victim.
//
// So the racing writer lives in another process, and the rejected alternative
// follows: an in-daemon mutex or per-file promise chain serialises only this
// daemon, which — initPty being synchronous end-to-end — already cannot
// interleave with itself. What works against an external rewriter is what this
// function does: write atomically (temp-then-rename in the same directory, so
// a mid-write reader never parses a torn file), then re-read after a settle
// delay and repair a clobbered entry, bounded, and report failure instead of
// letting the caller spawn an agent into an untrusted folder. The residual
// window — a sibling's write-back landing after the last verify here but
// before the new claude reads the file — closes at the pre-spawn re-check
// (herdr.ts) and cannot be closed entirely from this side of the spawn;
// KAN-49 explicitly defers watching agents past their startup dialogs.
export function trustClaudeWorkspace(workDir: string, configPath?: string): TrustResult {
  const claudeConfigPath = configPath ?? path.join(os.homedir(), '.claude.json');
  // Claude Code keys projects by the normalized absolute path, nothing more.
  const trustKey = path.normalize(path.resolve(workDir));

  const read = (): { config: any } | { unreadable: string } => {
    if (!fs.existsSync(claudeConfigPath)) return { config: {} };
    try {
      return { config: JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')) };
    } catch (e: any) {
      return {
        unreadable:
          `${claudeConfigPath} exists but is unparseable; refusing to overwrite it ` +
          `(${e?.message ?? String(e)})`
      };
    }
  };
  const trusted = (config: any): boolean =>
    config.projects?.[trustKey]?.hasTrustDialogAccepted === true;

  for (let attempt = 1; attempt <= TRUST_WRITE_ATTEMPTS; attempt++) {
    const current = read();
    if ('unreadable' in current) {
      // Not retried: an unparseable file is user state we must not replace,
      // and it does not become parseable by waiting. (Our own writes can no
      // longer tear it — the rename below is atomic — so this is either a
      // torn write from an older Claude Code or genuine corruption.)
      console.error(`[Launchers] ${current.unreadable}`);
      return { ok: false, attempts: attempt - 1, error: current.unreadable };
    }
    if (trusted(current.config)) {
      if (attempt > 1) {
        console.log(
          `[Launchers] Trust entry for ${trustKey} stuck after ${attempt - 1} write attempt(s)`
        );
      }
      return { ok: true, attempts: attempt - 1 };
    }

    const config = current.config;
    config.projects = {
      ...config.projects,
      [trustKey]: { ...config.projects?.[trustKey], hasTrustDialogAccepted: true }
    };

    // Same directory as the target so the rename cannot cross filesystems and
    // stays atomic; pid + attempt keeps concurrent daemons off each other's
    // temp files.
    const tmpPath = `${claudeConfigPath}.butchr-${process.pid}-${attempt}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, claudeConfigPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const error =
        `Failed to record workspace trust in ${claudeConfigPath}: ${e?.message ?? String(e)}`;
      console.error(`[Launchers] ${error}`);
      return { ok: false, attempts: attempt, error };
    }

    sleepSync(TRUST_SETTLE_MS);
    // Loop rather than return on a good re-read: the top of the next iteration
    // is the same check, and going around once more costs nothing when the
    // entry is present (the `trusted` early-return fires with attempts intact).
    const after = read();
    if (!('unreadable' in after) && trusted(after.config)) {
      return { ok: true, attempts: attempt };
    }
    console.error(
      `[Launchers] Trust entry for ${trustKey} was clobbered after write ` +
      `${attempt}/${TRUST_WRITE_ATTEMPTS} — a concurrent writer rewrote ${claudeConfigPath}`
    );
  }

  const error =
    `Trust entry for ${trustKey} in ${claudeConfigPath} would not stick after ` +
    `${TRUST_WRITE_ATTEMPTS} attempts; a concurrent writer keeps rewriting the file. ` +
    `Starting claude now would wedge it on the folder-trust dialog.`;
  console.error(`[Launchers] ${error}`);
  return { ok: false, attempts: TRUST_WRITE_ATTEMPTS, error };
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
  /**
   * Optional pre-launch setup, e.g. CLI-specific MCP config. Throwing refuses
   * the activation: initPty answers with session.spawnError + terminated, the
   * same channel as an unknown launcher, so setup that did not stick is never
   * papered over with `success: true`.
   */
  setup?: (workDir: string, mcpServers: McpServerDefinitions) => void;
  /**
   * Re-run immediately before the pane spawn, after everything between setup
   * and the spawn (prompt write, `herdr agent get`) has had time to happen —
   * time in which another process can undo what setup wrote (KAN-54). Throws
   * to refuse the activation through the same spawnError channel.
   */
  preSpawnCheck?: (workDir: string) => void;
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
      const trust = trustClaudeWorkspace(workDir);
      if (!trust.ok) {
        throw new Error(`Refusing to start claude in an untrusted workspace: ${trust.error}`);
      }
    },
    // trustClaudeWorkspace is its own verifier: present-and-true returns fast
    // with no write, a clobbered entry is rewritten, and only an entry that
    // will not stick throws. So the pre-spawn check is simply setup's trust
    // half again, run as late as the daemon can run anything (KAN-54).
    preSpawnCheck: (workDir) => {
      const trust = trustClaudeWorkspace(workDir);
      if (!trust.ok) {
        throw new Error(`Refusing to spawn claude: ${trust.error}`);
      }
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
