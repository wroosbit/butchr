import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { JiraIssueTypeService } from './jira.js';
import {
  HerdrBridge,
  HerdrSession,
  HerdrAgentDescription,
  HerdrAgentStatus,
  agentNameFor,
  typeFromAgentName
} from './herdr.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';

type Respond = (msg: any) => void;

/**
 * What the UI is told about a session. Sessions are never sent over the wire
 * directly: they carry a ~100KB ptyBuffer and a live ptyProcess handle, and
 * the Agents page polls list_agents every 2s.
 */
interface AgentDto {
  sessionId: string;
  type: string;
  key: string;
  /** Absent when the session was activated by key without a known page URL. */
  url?: string;
  createdAt: string;
  status: HerdrSession['status'];
  workDir: string;
  herdrStatus: HerdrAgentStatus;
}

/**
 * The addressing convention shared by every agent-targeted action: a key is
 * required, a type is optional but must be meaningful when present. Returns
 * the complaint, or null when the address is usable.
 */
function invalidAddress(key: unknown, type: unknown): string | null {
  if (typeof key !== 'string' || !key.trim()) return 'Missing or invalid key';
  if (type !== undefined && (typeof type !== 'string' || !type.trim())) {
    return 'Invalid type: expected a non-empty string';
  }
  return null;
}

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  constructor(
    private registry: WorkspaceRegistry,
    private promptLoader: PromptLoader,
    private herdrBridge: HerdrBridge,
    private send: (msg: any) => void,
    private broadcast: (msg: any) => void = send,
    private jira?: JiraIssueTypeService
  ) {}

  public handle(data: any) {
    // Responses echo the request's `id` so a transport can correlate them.
    // Chrome's messages carry no id; their replies go out on the default
    // channel, which is what the extension already listens to.
    const respond: Respond = (msg) =>
      this.send(data.id !== undefined ? { ...msg, id: data.id } : msg);

    // Fire-and-forget actions only reply when a caller asked to be
    // correlated, so Chrome doesn't get an ack per keystroke.
    const ack: Respond = (msg) => {
      if (data.id !== undefined) this.send({ ...msg, id: data.id });
    };

    // Resolution reaches the network now, so the handlers that use it are
    // async. A rejected handler promise would otherwise escape the try/catch
    // the daemon wraps this call in and surface as an unhandled rejection,
    // leaving the caller waiting on a response that never comes.
    const guard = (p: Promise<void>, action: string) =>
      p.catch((err: any) => {
        console.error(`Handler error in ${action}:`, err?.message ?? String(err));
        respond({
          action: `${action}_response`,
          success: false,
          error: err?.message ?? String(err)
        });
      });

    switch (data.action) {
      case 'reset':
        void guard(this.handleReset(data, respond), 'reset');
        break;
      case 'reset_by_key':
        this.handleResetByKey(data, respond);
        break;
      case 'activate':
        void guard(this.handleActivate(data, respond), 'activate');
        break;
      case 'activate_by_key':
        void guard(this.handleActivateByKey(data, respond), 'activate');
        break;
      case 'deactivate':
        this.handleDeactivate(data, respond);
        break;
      case 'deactivate_by_key':
        this.handleDeactivateByKey(data, respond);
        break;
      case 'send_to_agent':
        this.handleSendToAgent(data, respond);
        break;
      case 'tail_agent':
        this.handleTailAgent(data, respond);
        break;
      case 'agent_status':
        this.handleAgentStatus(data, respond);
        break;
      case 'status':
        void guard(this.handleStatus(data, respond), 'status');
        break;
      case 'list_agents':
        this.handleListAgents(data, respond);
        break;
      case 'jira_credential_status':
        this.handleJiraCredentialStatus(respond);
        break;
      case 'set_jira_credential':
        void guard(this.handleSetJiraCredential(data, respond), 'set_jira_credential');
        break;
      case 'clear_jira_credential':
        void guard(this.handleClearJiraCredential(respond), 'clear_jira_credential');
        break;
      case 'pty_init':
        this.handlePtyInit(data, respond);
        break;
      case 'pty_input':
        this.handlePtyInput(data, ack);
        break;
      case 'pty_resize':
        this.handlePtyResize(data, ack);
        break;
      default:
        console.warn('Unknown action:', data.action);
        respond({
          action: 'error_response',
          success: false,
          error: `Unknown action: ${data.action}`
        });
    }
  }

  private async handleActivate(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      respond({
        action: 'activate_response',
        success: false,
        error: 'Unsupported URL. No matching Workspace Type found.'
      });
      return;
    }

    const { config, key } = resolved;
    const renderedPrompt = this.promptLoader.loadAndRender(config.promptTemplateFile, {
      KEY: key,
      URL: data.url
    });

    let session = this.herdrBridge.getSessionByKey(key);
    if (!session) {
      session = this.herdrBridge.spawnSession(config.type, key, data.url, renderedPrompt, data.defaultAgent, config.mcpServers);
    }

    if (session.spawnError) {
      respond({
        action: 'activate_response',
        success: false,
        type: config.type,
        key,
        url: data.url,
        error: session.spawnError
      });
      return;
    }

    this.broadcast({
      action: 'agent_activated_event',
      type: config.type,
      key,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir
    });

    respond({
      action: 'activate_response',
      success: true,
      type: config.type,
      key,
      url: data.url,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir,
      createdAt: session.createdAt.toISOString(),
      mcpServers: config.mcpServers
    });
  }

  public async handleActivateByKey(data: any, respond: Respond) {
    const { type, key, defaultAgent } = data;

    // A key alone does not determine a URL: the registry maps URLs to keys,
    // not the other way round. Callers who know the page URL pass it; for
    // callers who don't, the session simply has no url. Never invent one —
    // a fabricated link is worse than no link.
    const url =
      typeof data.url === 'string' && data.url.trim() ? data.url.trim() : undefined;

    // The url is advisory: an explicit key always wins. A disagreement is
    // worth a log line but not a rejection — the caller may legitimately be
    // binding an agent to a page the registry doesn't recognise.
    if (url) {
      const resolved = await this.registry.resolve(url);
      if (resolved && resolved.key !== key) {
        console.warn(
          `activate_by_key: url ${url} resolves to key ${resolved.key}, but key ${key} was given; using ${key}`
        );
      }
    }

    // Prefer the registered config so a type's prompt file and MCP servers
    // come from one place. An unregistered type still works on the old
    // convention — callers may address a type this daemon doesn't know.
    const config = this.registry.get(type);
    const promptTemplateFile = config?.promptTemplateFile ?? `prompts/${type}.md`;
    const mcpServers = config?.mcpServers ?? ['atlassian', 'butchr'];
    let session = this.herdrBridge.getSessionByKey(key);

    if (!session) {
      const renderedPrompt = this.promptLoader.loadAndRender(promptTemplateFile, {
        KEY: key,
        URL: url ?? ''
      });
      session = this.herdrBridge.spawnSession(type, key, url, renderedPrompt, defaultAgent, mcpServers);
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists. Reporting it as a failure here is not KAN-23's
    // post-spawn existence check — that still has to be added, for the case
    // where herdr reports success and the agent is nevertheless absent — but
    // an error herdr handed us must never be answered with success: true.
    if (session.spawnError) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        url,
        error: session.spawnError
      });
      return;
    }

    this.broadcast({
      action: 'agent_activated_event',
      type,
      key,
      sessionId: session.sessionId,
      status: session.status
    });

    respond({
      action: 'activate_response',
      success: true,
      type,
      key,
      url: session.url,
      sessionId: session.sessionId,
      status: session.status
    });
  }

  private handleDeactivate(data: any, respond: Respond) {
    if (!data.sessionId) {
      respond({
        action: 'deactivate_response',
        success: false,
        error: 'Missing sessionId'
      });
      return;
    }

    const success = this.herdrBridge.terminateSession(data.sessionId);
    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId
    });
  }

  public handleDeactivateByKey(data: any, respond: Respond) {
    const { key } = data;
    const session = this.herdrBridge.getSessionByKey(key);

    if (session) {
      const success = this.herdrBridge.terminateSession(session.sessionId);

      this.broadcast({
        action: 'agent_deactivated_event',
        type: session.type,
        key: session.key,
        sessionId: session.sessionId
      });

      respond({
        action: 'deactivate_response',
        success,
        sessionId: session.sessionId
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not. Close it through the fallback
    // rather than telling the caller an obviously-running agent is gone.
    const result = this.herdrBridge.closeAgentByKey(key);

    if (result.success) {
      this.broadcast({
        action: 'agent_deactivated_event',
        type: result.agentName ? typeFromAgentName(result.agentName, key) : undefined,
        key
      });
    }

    respond({
      action: 'deactivate_response',
      key,
      success: result.success,
      ...(result.error ? { error: result.error } : {})
    });
  }

  /**
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const { key, type, message } = data;
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (typeof message !== 'string' || !message.trim()) {
      fail('Missing or invalid message');
      return;
    }

    this.herdrBridge.sendToAgent(key, message, type).then(
      (result) => respond({ action: 'send_to_agent_response', key, ...result }),
      (err) => fail(err?.message ?? String(err))
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private handleTailAgent(data: any, respond: Respond) {
    const { key, type, lines } = data;
    const fail = (error: string) =>
      respond({ action: 'tail_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (lines !== undefined && (typeof lines !== 'number' || !Number.isFinite(lines))) {
      fail('Invalid lines: expected a number');
      return;
    }

    try {
      respond({
        action: 'tail_agent_response',
        key,
        ...this.herdrBridge.tailAgent(key, type, lines)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  /**
   * Everything the sidepanel's Info tab shows, by address. A daemon restart
   * empties the session map while the herdr pane keeps running, so a missing
   * session degrades to herdr's own view (`sessionless: true`) rather than
   * failing — an agent that outlived its daemon is exactly the one a
   * supervisor most needs to inspect.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    const { key, type } = data;
    const fail = (error: string) =>
      respond({ action: 'agent_status_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }

    try {
      const session = this.herdrBridge.getSessionByAddress(key, type);
      if (session) {
        respond({
          action: 'agent_status_response',
          success: true,
          sessionless: false,
          agentName: agentNameFor(session.type, session.key),
          ...this.toAgentDto(session, this.herdrBridge.listHerdrStatuses())
        });
        return;
      }

      const described = this.herdrBridge.describeAgent(key, type);
      respond({
        action: 'agent_status_response',
        success: true,
        sessionless: true,
        agentName: described.agentName,
        sessionId: null,
        type: described.type,
        key,
        url: null,
        createdAt: null,
        status: null,
        workDir: described.workDir,
        herdrStatus: described.herdrStatus
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  private async handleReset(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      respond({ action: 'reset_response', success: false, error: 'Unsupported URL' });
      return;
    }
    const { config, key } = resolved;
    const session = this.herdrBridge.getSessionByKey(key);

    // Same ordering rule as handleResetByKey: the agent goes first, whether we
    // reach it through the session map or the herdr-list fallback.
    if (session) {
      this.herdrBridge.terminateSession(session.sessionId);
    } else {
      this.herdrBridge.closeAgentByKey(key);
    }

    const success = this.herdrBridge.resetWorkspace(config.type, key);
    respond({ action: 'reset_response', success });
  }

  public handleResetByKey(data: any, respond: Respond) {
    const { type, key } = data;
    const session = this.herdrBridge.getSessionByKey(key);

    // Tear the agent down *before* resetWorkspace deletes the directory it is
    // running in. Without a session the agent is still reachable through the
    // herdr-list fallback, and skipping that left the agent alive in a cwd
    // that no longer exists.
    let agentClosed = false;
    let agentError: string | undefined;

    if (session) {
      agentClosed = this.herdrBridge.terminateSession(session.sessionId);
    } else {
      const result = this.herdrBridge.closeAgentByKey(key);
      agentClosed = result.success;
      agentError = result.error;
    }

    // The workspace still goes away even if no agent was there to close —
    // reset's job is to leave nothing behind.
    const success = this.herdrBridge.resetWorkspace(type, key);

    // Broadcast event so UI can update
    this.broadcast({
      action: 'agent_reset_event',
      type,
      key,
      success,
      agentClosed
    });

    respond({
      action: 'reset_response',
      success,
      agentClosed,
      ...(agentError ? { agentError } : {}),
      ...(success ? {} : { error: agentError ?? `No workspace directory for ${type}/${key}` })
    });
  }

  private toAgentDto(session: HerdrSession, statuses: Map<string, HerdrAgentStatus>): AgentDto {
    return {
      sessionId: session.sessionId,
      type: session.type,
      key: session.key,
      url: session.url,
      createdAt: session.createdAt.toISOString(),
      status: session.status,
      workDir: session.workDir,
      herdrStatus: statuses.get(agentNameFor(session.type, session.key)) ?? 'unknown'
    };
  }

  /**
   * Does an agent exist for this page, and are we attached to it?
   *
   * Two different truths, and conflating them is what made the toggle lie:
   * `active` is the agent's own existence, which is herdr's and survives a
   * daemon restart; `attached` is whether *this* daemon holds a session for
   * it, which is ephemeral and dies with the process. A missing session used
   * to answer `active: false` for an agent that was demonstrably still
   * working, so a session miss now asks herdr before calling anything Off.
   */
  private async handleStatus(data: any, respond: Respond) {
    const resolved = await this.registry.resolve(data.url);
    if (!resolved) {
      respond({ action: 'status_response', success: true, supported: false });
      return;
    }

    const base = {
      action: 'status_response',
      success: true,
      supported: true,
      type: resolved.config.type,
      key: resolved.key
    };

    const session = this.herdrBridge.getSessionByKey(resolved.key);
    if (session) {
      const agent = this.toAgentDto(session, this.herdrBridge.listHerdrStatuses());
      respond({
        ...base,
        active: true,
        attached: true,
        sessionId: agent.sessionId,
        status: agent.status,
        workDir: agent.workDir,
        createdAt: agent.createdAt,
        herdrStatus: agent.herdrStatus
      });
      return;
    }

    // The registry knows this page's type, so the agent can be named exactly
    // rather than resolved by suffix. Not-found is the ordinary answer here,
    // not a failure: it is precisely the case where the agent really is gone.
    let described: HerdrAgentDescription | undefined;
    try {
      described = this.herdrBridge.describeAgent(resolved.key, resolved.config.type);
    } catch {
      described = undefined;
    }

    if (!described) {
      respond({ ...base, active: false, attached: false });
      return;
    }

    respond({
      ...base,
      active: true,
      attached: false,
      // Session-only fields stay absent — there is no session to describe,
      // and herdr knows nothing about sessionId, createdAt or pty status.
      // workDir is included only when herdr actually reported a cwd.
      ...(described.workDir !== null ? { workDir: described.workDir } : {}),
      herdrStatus: described.herdrStatus
    });
  }

  // --- Atlassian credential -------------------------------------------------
  //
  // The token's whole journey is: settings UI → native messaging → here →
  // CredentialStore. It never travels back. These handlers answer with
  // configured/not-configured and a validation verdict, never with the value,
  // so there is nothing for the extension to retain even by accident.

  private handleJiraCredentialStatus(respond: Respond) {
    respond({
      action: 'jira_credential_status_response',
      success: true,
      available: !!this.jira,
      ...(this.jira ? this.jira.status() : { configured: false })
    });
  }

  private async handleSetJiraCredential(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'set_jira_credential_response', success: false, valid: false, error });

    if (!this.jira) {
      fail('This daemon has no Jira credential support.');
      return;
    }

    const siteUrl = typeof data.siteUrl === 'string' ? data.siteUrl.trim() : '';
    const email = typeof data.email === 'string' ? data.email.trim() : '';
    const token = typeof data.token === 'string' ? data.token : '';

    if (!siteUrl || !email || !token) {
      fail('Site URL, account email and API token are all required.');
      return;
    }

    // Normalise before storing: a trailing slash would double up in every
    // request path, and a bare hostname needs a scheme to be fetchable.
    const normalisedSite = (/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`)
      .replace(/\/+$/, '');

    let parsed: URL;
    try {
      parsed = new URL(normalisedSite);
    } catch {
      fail('That does not look like a valid site URL.');
      return;
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      fail('Enter just the site address, e.g. https://yoursite.atlassian.net');
      return;
    }

    const result = await this.jira.setCredential({
      siteUrl: parsed.origin,
      email,
      token
    });

    // Note what is *not* here: the token, and any echo of the request. The
    // response carries a verdict and the non-secret site/account only.
    console.log(
      `jira: credential submitted for ${email} @ ${parsed.origin} — ` +
        (result.valid ? `valid, stored in ${result.storage}` : `rejected (${result.error})`)
    );

    respond({
      action: 'set_jira_credential_response',
      success: true,
      valid: result.valid,
      ...(result.error ? { error: result.error } : {}),
      ...(result.accountName ? { accountName: result.accountName } : {}),
      ...(result.storage ? { storage: result.storage } : {}),
      status: this.jira.status()
    });
  }

  private async handleClearJiraCredential(respond: Respond) {
    if (!this.jira) {
      respond({ action: 'clear_jira_credential_response', success: false, error: 'unsupported' });
      return;
    }
    await this.jira.clearCredential();
    console.log('jira: credential cleared');
    respond({
      action: 'clear_jira_credential_response',
      success: true,
      status: this.jira.status()
    });
  }

  private handleListAgents(data: any, respond: Respond) {
    const statuses = this.herdrBridge.listHerdrStatuses();

    // Descriptor headroom, reported where someone looking at agents will see
    // it. On KAN-24 the herdr server's fd usage was invisible until spawning
    // broke, and the only way to learn it was to read /proc by hand. Expressed
    // in panes because that is the unit the reader can act on — "room for 12
    // more agents" is a decision, "62000 descriptors" is trivia.
    const usage = readFdUsage();

    respond({
      action: 'list_agents_response',
      success: true,
      agents: this.herdrBridge.listActiveSessions().map(s => this.toAgentDto(s, statuses)),
      ...(usage ? {
        herdrHealth: {
          pid: usage.pid,
          openFds: usage.openFds,
          softLimit: usage.softLimit,
          headroomPanes: usage.headroomPanes,
          fdPressure: Math.round(usage.ratio * 100) / 100,
          ...(isFdPressureHigh(usage) ? {
            warning:
              `herdr server is using ${Math.round(usage.ratio * 100)}% of its open-file soft limit ` +
              `(${usage.openFds}/${usage.softLimit}); room for about ${usage.headroomPanes} more panes ` +
              `at ${PTMX_FDS_PER_PANE} descriptors each. Close idle agents.`
          } : {})
        }
      } : {})
    });
  }

  private handlePtyInit(data: any, respond: Respond) {
    const buffer = this.herdrBridge.getPtyBuffer(data.sessionId);
    respond({
      action: 'pty_init_response',
      sessionId: data.sessionId,
      buffer: buffer
    });

    if (this.activePtyListeners.has(data.sessionId)) {
      const oldCleanup = this.activePtyListeners.get(data.sessionId);
      if (oldCleanup) oldCleanup();
    }

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    const cleanup = this.herdrBridge.registerDataListener(data.sessionId, (ptyData) => {
      this.send({
        action: 'pty_output',
        sessionId: data.sessionId,
        data: ptyData
      });
    });

    this.activePtyListeners.set(data.sessionId, cleanup);
  }

  private handlePtyInput(data: any, ack: Respond) {
    this.herdrBridge.writePty(data.sessionId, data.data);
    ack({ action: 'pty_input_response', success: true });
  }

  private handlePtyResize(data: any, ack: Respond) {
    this.herdrBridge.resizePty(data.sessionId, data.cols, data.rows);
    ack({ action: 'pty_resize_response', success: true });
  }

  public cleanup() {
    this.activePtyListeners.forEach(unsub => unsub());
    this.activePtyListeners.clear();
  }
}
