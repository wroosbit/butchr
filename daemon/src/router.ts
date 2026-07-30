import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge, HerdrSession, HerdrAgentStatus, agentNameFor } from './herdr.js';

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
  url: string;
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
    private broadcast: (msg: any) => void = send
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

    switch (data.action) {
      case 'reset':
        this.handleReset(data, respond);
        break;
      case 'reset_by_key':
        this.handleResetByKey(data, respond);
        break;
      case 'activate':
        this.handleActivate(data, respond);
        break;
      case 'activate_by_key':
        this.handleActivateByKey(data, respond);
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
        this.handleStatus(data, respond);
        break;
      case 'list_agents':
        this.handleListAgents(data, respond);
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

  private handleActivate(data: any, respond: Respond) {
    const resolved = this.registry.resolve(data.url);
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

  public handleActivateByKey(data: any, respond: Respond) {
    const { type, key, defaultAgent } = data;

    // In a real scenario we'd look up the config from registry by type,
    // but for now we'll assume it's a valid type since we only have 'task'
    const promptTemplateFile = `prompts/${type}.md`;
    let session = this.herdrBridge.getSessionByKey(key);

    if (!session) {
      const renderedPrompt = this.promptLoader.loadAndRender(promptTemplateFile, {
        KEY: key,
        URL: `https://workspace.local/${type}/${key}`
      });
      // In a real scenario we'd look up config, but for now we hardcode defaults
      session = this.herdrBridge.spawnSession(type, key, `https://workspace.local/${type}/${key}`, renderedPrompt, defaultAgent, ['atlassian', 'butchr']);
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
    } else {
      respond({
        action: 'deactivate_response',
        success: false,
        error: 'Session not found'
      });
    }
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

  private handleReset(data: any, respond: Respond) {
    const resolved = this.registry.resolve(data.url);
    if (!resolved) {
      respond({ action: 'reset_response', success: false, error: 'Unsupported URL' });
      return;
    }
    const { config, key } = resolved;
    const session = this.herdrBridge.getSessionByKey(key);

    if (session) {
      this.herdrBridge.terminateSession(session.sessionId);
    }

    const success = this.herdrBridge.resetWorkspace(config.type, key);
    respond({ action: 'reset_response', success });
  }

  public handleResetByKey(data: any, respond: Respond) {
    const { type, key } = data;
    const session = this.herdrBridge.getSessionByKey(key);

    if (session) {
      this.herdrBridge.terminateSession(session.sessionId);
    }

    const success = this.herdrBridge.resetWorkspace(type, key);

    // Broadcast event so UI can update
    this.broadcast({
      action: 'agent_reset_event',
      type,
      key,
      success
    });

    respond({ action: 'reset_response', success });
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

  private handleStatus(data: any, respond: Respond) {
    const resolved = this.registry.resolve(data.url);
    if (resolved) {
      const session = this.herdrBridge.getSessionByKey(resolved.key);
      const agent = session
        ? this.toAgentDto(session, this.herdrBridge.listHerdrStatuses())
        : undefined;
      respond({
        action: 'status_response',
        success: true,
        supported: true,
        type: resolved.config.type,
        key: resolved.key,
        active: !!session,
        sessionId: agent?.sessionId,
        status: agent?.status,
        workDir: agent?.workDir,
        createdAt: agent?.createdAt,
        herdrStatus: agent?.herdrStatus
      });
    } else {
      respond({
        action: 'status_response',
        success: true,
        supported: false
      });
    }
  }

  private handleListAgents(data: any, respond: Respond) {
    const statuses = this.herdrBridge.listHerdrStatuses();
    respond({
      action: 'list_agents_response',
      success: true,
      agents: this.herdrBridge.listActiveSessions().map(s => this.toAgentDto(s, statuses))
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
