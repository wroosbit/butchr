import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import * as net from 'net';
import { connectToDaemon, onJsonLines, writeJsonLine } from './ipc.js';

const server = new Server(
  {
    name: "butchr-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    },
  }
);

// Persistent connection to the Butchr daemon's Unix socket. Requests carry
// an id the daemon echoes back; broadcast events arrive without one and are
// forwarded as MCP logging notifications.
let daemonSocket: net.Socket | null = null;
let connectingDaemon: Promise<net.Socket> | null = null;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextRequestId = 0;

function daemonLink(): Promise<net.Socket> {
  if (daemonSocket) return Promise.resolve(daemonSocket);
  if (!connectingDaemon) {
    connectingDaemon = connectToDaemon()
      .then((socket) => {
        connectingDaemon = null;
        daemonSocket = socket;

        onJsonLines(socket, (msg) => {
          const entry = msg?.id !== undefined ? pending.get(msg.id) : undefined;
          if (entry) {
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            const { id, ...body } = msg;
            entry.resolve(body);
          } else if (typeof msg?.action === 'string' && msg.action.endsWith('_event')) {
            server.notification({
              method: "notifications/message",
              params: {
                level: "info",
                data: `[Butchr Event] ${msg.action} - ${msg.type}/${msg.key}`
              }
            }).catch(() => {});
          }
        });

        socket.on('error', () => {});
        socket.on('close', () => {
          daemonSocket = null;
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Daemon connection closed'));
          }
          pending.clear();
        });

        return socket;
      })
      .catch((err) => {
        connectingDaemon = null;
        throw err;
      });
  }
  return connectingDaemon;
}

// Helper to send requests to the main daemon
async function callDaemonAPI(action: string, data: any = {}): Promise<any> {
  const socket = await daemonLink();
  const id = `mcp-${process.pid}-${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Daemon request timed out: ${action}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    writeJsonLine(socket, {
      action,
      ...data,
      id,
      workspaceType: process.env.BUTCHR_WORKSPACE_TYPE || undefined,
      workspaceKey: process.env.BUTCHR_WORKSPACE_KEY || undefined
    });
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "butchr_activate_agent",
        description: "Activates an agent for a specific workspace type and key (e.g. task and KAN-1)",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The workspace type (e.g., 'task')",
            },
            key: {
              type: "string",
              description: "The workspace key (e.g., 'KAN-1')",
            },
            url: {
              type: "string",
              description: "Optional. The page URL this agent is bound to, e.g. the Jira issue URL. Omit it if unknown — the agent is then shown without a link rather than with a fabricated one.",
            },
            defaultAgent: {
              type: "string",
              description: "Optional. The default agent to launch (e.g. 'claude', 'anti-gravity')",
            },
          },
          required: ["type", "key"],
        },
      },
      {
        name: "butchr_deactivate_agent",
        description: "Deactivates an active agent by its workspace key",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key (e.g., 'KAN-1')",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "butchr_send_to_agent",
        description:
          "Sends a message to a running agent's terminal as if a human typed it: interrupts any partially typed input, types the message, and presses Enter. Use this to give a still-running agent new instructions (e.g. review feedback) without attaching to its terminal.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to message (e.g., 'KAN-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
            message: {
              type: "string",
              description: "The message to type into the agent's terminal",
            },
          },
          required: ["key", "message"],
        },
      },
      {
        name: "butchr_tail_agent",
        description:
          "Reads the recent terminal output of an agent without attaching to it. Use this to find out what an agent is actually doing — or why it stopped — when its reported status alone is not enough.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to read (e.g., 'KAN-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
            lines: {
              type: "number",
              description: "Optional. How many trailing lines to return (default 40, max 200)",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "butchr_agent_status",
        description:
          "Reports an agent's full state: session id, workspace type and key, url, creation time, session status, working directory, and herdr's own view of what the agent is doing. If the daemon has restarted and lost its session, the herdr-only fields are still returned with sessionless: true.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to inspect (e.g., 'KAN-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "butchr_list_agents",
        description: "Lists all currently active agents",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "butchr_reset_agent",
        description: "Deactivates an agent and securely deletes its workspace directory",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The workspace type (e.g., 'task')",
            },
            key: {
              type: "string",
              description: "The workspace key (e.g., 'KAN-1')",
            },
          },
          required: ["type", "key"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "butchr_activate_agent") {
      const { type, key, url, defaultAgent } = args as any;
      if (!type || !key) throw new Error("Missing required arguments");

      const res = await callDaemonAPI('activate_by_key', { type, key, url, defaultAgent });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } 
    
    if (name === "butchr_deactivate_agent") {
      const { key } = args as any;
      if (!key) throw new Error("Missing key argument");
      
      const res = await callDaemonAPI('deactivate_by_key', { key });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    if (name === "butchr_send_to_agent") {
      const { key, type, message } = args as any;
      if (!key || !message) throw new Error("Missing required arguments: key, message");

      const res = await callDaemonAPI('send_to_agent', { key, type, message });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "butchr_tail_agent") {
      const { key, type, lines } = args as any;
      if (!key) throw new Error("Missing required argument: key");

      const res = await callDaemonAPI('tail_agent', { key, type, lines });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "butchr_agent_status") {
      const { key, type } = args as any;
      if (!key) throw new Error("Missing required argument: key");

      const res = await callDaemonAPI('agent_status', { key, type });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "butchr_list_agents") {
      const res = await callDaemonAPI('list_agents');
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    if (name === "butchr_reset_agent") {
      const { type, key } = args as any;
      if (!type || !key) throw new Error("Missing required arguments: type, key");
      
      const res = await callDaemonAPI('reset_by_key', { type, key });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Butchr MCP Server running on stdio");
  // Connect eagerly (spawning the daemon if needed) so broadcast events
  // stream as notifications; tool calls reconnect lazily on failure.
  daemonLink().catch(() => {});
}

run().catch(console.error);
