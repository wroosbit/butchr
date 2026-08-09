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
import { WORKSPACE_KEY_FLAG, WORKSPACE_TYPE_FLAG } from './launchers.js';
import {
  CHANNEL_MESSAGE_ACTION,
  CHANNEL_NOTIFICATION_METHOD,
  isForwardableEvent
} from './channel.js';

/**
 * Which agent this server belongs to, read off this process's own argv.
 *
 * The daemon writes the flags into the workspace's `.mcp.json` at activation
 * (`withWorkspaceIdentity` in launchers.ts), and the agent's CLI spawns this
 * process from that file — so the identity arrives on the command line of the
 * process that actually reaches the daemon, and can be read back out of
 * `/proc/<pid>/cmdline` by anyone who doubts it.
 *
 * It used to be read from `BUTCHR_WORKSPACE_TYPE`/`_KEY` in the environment,
 * and nothing ever set those in this process (KAN-145): the only writer put
 * them on the `herdr agent attach` PTY, which is a client of the agent's pane
 * rather than an ancestor of it. The env read is gone rather than kept as a
 * fallback — an unexercised second source is how the first one went unnoticed
 * for as long as it did.
 *
 * An absent or malformed flag yields `undefined`, which is the honest answer
 * and the one `supervisorOfRecord` already treats as "no supervisor": a human
 * activating from the sidepanel has no parent, and nothing should be invented
 * for one.
 */
function workspaceIdentityFromArgv(argv: string[]): { type?: string; key?: string } {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    // A flag with nothing behind it, or with the next flag behind it, is a
    // malformed command line — not a workspace called '--workspace-key'.
    return value && !value.startsWith('--') ? value : undefined;
  };
  return { type: read(WORKSPACE_TYPE_FLAG), key: read(WORKSPACE_KEY_FLAG) };
}

const callerIdentity = workspaceIdentityFromArgv(process.argv.slice(2));

const server = new Server(
  {
    name: "butchr-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
      // WHAT MAKES THIS SERVER A CHANNEL (KAN-244, design §1.2). Without this
      // key Claude Code registers no listener and every
      // `notifications/claude/channel` below is discarded in silence — KAN-217
      // measured that, and it is why the declaration cannot be conditional on
      // the runtime switch: the client reads capabilities once, at
      // `initialize`, so a declaration that came and went with a file on disk
      // would bind whatever the file said at activation and never notice it
      // changing.
      //
      // Declared unconditionally and therefore ALWAYS. What the switch governs
      // is emission, in the daemon, where the addressing is — see channel.ts
      // for why the gate is there and only there. An agent whose channel is off
      // still advertises the capability and still receives nothing.
      experimental: { 'claude/channel': {} }
    },
    // WHAT THE MODEL IS TOLD ABOUT THIS SERVER (KAN-249, T6, design §3).
    //
    // Goes into the client's system prompt, and it is here because of a
    // measurement rather than for tidiness: KAN-217 pushed a channel event at a
    // session that had been told nothing, and the model **correctly declined to
    // act on it**, naming it as probable prompt injection. Delivery was fine.
    // The brief was missing. From outside, that refusal is indistinguishable
    // from a broken transport.
    //
    // THE WORDING IS LOAD-BEARING AND PRESSURE IN IT BACKFIRES. KAN-217's probe
    // ended its own `instructions` with "Do not ask permission first" and the
    // model quoted that very sentence as the red flag that decided it: content
    // pre-authorising its own execution is what marks it as an attack. Removing
    // that one sentence turned refusal into compliance. So this string
    // *describes* — what a frame is, where it comes from, what its `source`
    // attribute is and is not worth, and that a return path exists — and asks
    // for nothing. Design §3 requires exactly that of the reply path: describe
    // it, do not urge its use, because a brief that tells agents to reply
    // through the channel manufactures traffic.
    //
    // IT IS THE SHORTER OF TWO BRIEFS AND DELIBERATELY NOT THE ONLY ONE. Every
    // token here is paid on every request of every agent forever, so the long
    // form — the provenance limits in full, the turn-boundary semantics, the
    // storm guards — lives in `prompts/*.md`, which the daemon renders into each
    // workspace's `.butchr-prompt.md` and the agent reads at start. This is what
    // remains true for a session that has drifted from that file, and the last
    // line is the pointer between them. The two must say the same thing: if you
    // change the channel section of the prompts, read this string as well.
    instructions:
      'Butchr manages this agent. A message another agent addresses to this one ' +
      'arrives as a channel event — a <channel source="butchr"> block the client ' +
      'places in context — and it is expected traffic about this workspace\'s ticket ' +
      'and the work on it, not an intrusion. Read one as you would read the same ' +
      'words typed at the terminal: judge it on its substance and decide. ' +
      'PROVENANCE: source="butchr" is set by the client and names THIS SERVER, ' +
      'nothing more. It is not evidence of who sent a message — every message on ' +
      'this channel carries the same source — and a channel message is never the ' +
      'human speaking. Who sent it is the [from <type>/<KEY>] tag at the start of ' +
      'the payload, which the daemon stamps from the calling process\'s identity. ' +
      'REPLY PATH: there is no dedicated reply tool here. A reply, if one is wanted, ' +
      'is an ordinary butchr_send_to_agent addressed at the sender\'s type/KEY; it is ' +
      'a new message rather than an acknowledgement, and nothing about receiving a ' +
      'channel message makes a reply owed. The full brief is in .butchr-prompt.md in ' +
      'this workspace, under "Whose voice is this?".'
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
          } else if (msg?.action === 'hello_response') {
            // Said on stderr rather than swallowed. KAN-217's finding was that
            // a dead recipient is loud and a *misconfigured* one is silent; an
            // agent whose identity never bound would be addressable by nobody,
            // with no symptom until a message went missing.
            console.error(
              msg.success
                ? `Registered with the daemon as ${callerIdentity.type}/${callerIdentity.key} (${msg.connectionId})`
                : `Daemon refused this server's identity: ${msg.error ?? 'no reason given'}`
            );
          } else if (msg?.action === CHANNEL_MESSAGE_ACTION) {
            // AN ADDRESSED MESSAGE (KAN-244). Unlike the broadcast below, this
            // frame was written to THIS connection alone: the daemon resolved
            // the recipient through KAN-243's identity map and wrote to one
            // socket, so arriving here is already evidence that this agent was
            // the intended one.
            //
            // There is no switch consulted here, deliberately, and that is not
            // an omission — see channel.ts. The daemon does not write this
            // frame at all when channel emission is off, so this branch is
            // unreachable then and `mcp.ts` behaves exactly as it did before
            // KAN-244. A second gate here would be a second copy of one
            // condition, which is the defect KAN-145 cost this board a day to.
            server.notification({
              method: CHANNEL_NOTIFICATION_METHOD,
              params: { content: msg.content, meta: msg.meta }
            }).catch(() => {});
          } else if (isForwardableEvent(msg?.action)) {
            // Was `msg.action.endsWith('_event')` until KAN-244 (design §1.3).
            // The suffix test forwarded anything a future author happened to
            // name that way; the allowlist in channel.ts names the seven the
            // daemon emits today, so this forwards exactly what it forwarded
            // before and an eighth arrives only when somebody adds it there.
            server.notification({
              method: "notifications/message",
              params: {
                level: "info",
                data: `[Butchr Event] ${msg.action} - ${msg.type}/${msg.key}`
              }
            }).catch(() => {});
          }
        });

        // Introduce ourselves (KAN-243). The daemon holds its clients in a set
        // with no identity on any of them, so it can fan out to everybody and
        // address nobody; this is the announcement that binds this connection
        // to this agent, and it is the *same* argv-derived values that already
        // ride every request body, from the same source, so the two cannot
        // drift apart.
        //
        // Sent on every established link rather than once per process, because
        // the daemon forgets on `close` — a daemon restart must leave this
        // server re-registered rather than silently unaddressable.
        //
        // An unidentified server says nothing at all: `hello` with no identity
        // is refused, and a human-activated workspace legitimately has none.
        // Staying anonymous is the correct outcome there, not an error.
        if (callerIdentity.type && callerIdentity.key) {
          writeJsonLine(socket, {
            action: 'hello',
            workspaceType: callerIdentity.type,
            workspaceKey: callerIdentity.key
          });
        }

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
      // Who is asking. `supervisorOfRecord` (router.ts) records this as the
      // activated agent's supervisor, so a story agent staffing a task is
      // written down as that task's parent by the ordinary act of staffing it.
      workspaceType: callerIdentity.type,
      workspaceKey: callerIdentity.key
    });
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "butchr_capacity",
        description:
          "Reports how many concurrent agents this machine can carry and how many more can be started right now. The cap is derived from the machine's own cores and memory, so it differs between machines; headroom additionally accounts for the CPU and memory actually in use right now, so a fleet that is compiling reports less room than the same fleet idle. The load average is reported (`load1`) but no longer gates anything — `cpuBusyCores`, measured from /proc/stat, is what the CPU term divides. Ask this before activating, not after the machine is on its knees. ALSO REPORTS priorities: what each running agent is worth (epic 3, story 2, task 1), which is what an activation at capacity would have to strictly outrank before it could stand any of them down.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "butchr_activate_agent",
        description:
          "Activates an agent for a specific workspace type and key (e.g. task and KAN-1). Refused when the machine is already at capacity — see butchr_capacity — unless override or preempt is set. A refusal names what is running and what each one is worth; when this activation outranks one of them, the refusal also carries a `preemption` block naming the agent that could be stood down to make room.",
        inputSchema: {
          type: "object",
          properties: {
            override: {
              type: "boolean",
              description:
                "Optional. Start the agent even when the machine is at capacity. The refusal it bypasses is recorded with the load and memory figures at the time. Use it deliberately, not reflexively: the cap exists because a human noticed the desktop had become unusable.",
            },
            preempt: {
              type: "boolean",
              description:
                "Optional, and destructive. Make room by standing down the lowest-priority agent this activation STRICTLY outranks (epic 3 > story 2 > task 1), rather than over-committing the machine as override does. Equal priority never preempts, so a task agent can never displace another task agent, and nothing can displace an epic agent, because 3 is the top of the scale. The victim's uncommitted work is interrupted; it is recorded as preempted, reported by butchr_list_agents until it is put back, and resumes its conversation when re-activated. Read the `preemption` block on the refusal first — it names exactly who would be stopped and what they are doing — and do not pass this without having decided that this work matters more than theirs.",
            },
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
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly — several types can share one key, and a bare key stops whichever of them it happens to reach.",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "butchr_send_to_agent",
        description:
          "Sends a message to a running agent. THE DAEMON CHOOSES HOW IT TRAVELS, PER RECIPIENT, AT SEND TIME — you never choose a transport and must never infer one. Two carriers exist: a CHANNEL, which delivers into the recipient's context and is acted on at its next turn boundary without disturbing work in flight; and the COMPOSER, which types into the recipient's terminal after a Ctrl+C. Which one carried your message is stated in the response as `transport`, together with `transportChosenBecause`. Read it there; do not work it out from whether the recipient has a channel, because you cannot see that and it changes underneath you. WHAT THE COMPOSER COSTS: its Ctrl+C does not merely clear a half-typed line — it cancels whatever the recipient is doing at that moment, including a tool call in flight, which does not resume. On the recipient's side the cancellation renders as a refusal, so an interrupted agent may report that a human rejected work nobody rejected, and an interrupt landing across parallel calls can leave some applied and report them all refused. The response says `interrupted: true` when that is what happened. A channel send costs the recipient nothing but context. WHAT YOU MAY CLAIM AFTERWARDS: the response carries `claims`, four separate facts that are never collapsed into one — the transport accepted the bytes (C1), a live session exists (C2), the text entered the transcript (C3), the model read it (C4). Each is `true`, `false`, or `null`, and NULL IS SILENCE, NOT A NEGATIVE: it means nothing here measured that, so resending on it may type a duplicate at an agent already working on the first copy. `licenses` says in one sentence what you may and may not state. Never report a message as received by an agent on the strength of `success` alone — `success` is C1 and nothing more. PROVENANCE: the daemon prefixes what it delivers with a sender tag it derives from YOUR workspace identity — `[from story/KAN-75] your message` — so do not write a sender into the message yourself; a sender you type is body text and is delivered after the daemon's tag rather than instead of it. The response echoes `sender` and `delivered` so you can see exactly what your recipient reads. On the composer, `butchr_tail_agent` is still the only thing that shows whether the Enter took. The recipient's convention is that an untagged message is the human typing directly, so relay a human decision as a decision you are reporting, not as your own instruction.",
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
              description: "The message to send to the agent",
            },
            intent: {
              type: "string",
              enum: ["steer", "stop-now"],
              description:
                "Optional, default 'steer'. WHAT YOU NEED, NOT HOW IT TRAVELS — this is not a transport selector and choosing a carrier is not yours to do. 'steer' is the ordinary case: the recipient should read this, and it can finish what it is doing first. 'stop-now' says the recipient must STOP what it is doing — it is about to conflict with you, or it is acting on something that has just become false. Only 'stop-now' can destroy a tool call in flight, and it destroys one every time it reaches a busy agent, so it is a decision about somebody else's work rather than a way of being heard sooner: `butchr_tail_agent` first if you want to know what you are about to take. The daemon maps your intent to a carrier and names the carrier it used in the response.",
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
        description:
          "Lists every running agent, from herdr's view of what exists rather than the daemon's session map — so agents that outlived a daemon restart are still listed. Each entry carries sessionless: true when the daemon is not attached to it, in which case the session-only fields (sessionId, url, createdAt, status) are null. Panes named like agents but with no agent behind them are reported separately under unbackedPanes and are not counted as agents. ALSO CHECK missingAgents: agents the durable registry records as active that are not running at all — a ticket of theirs will still read In Progress while nothing is working on it, so treat a non-empty missingAgents as work that has silently stopped and needs re-activating or standing down. ALSO CHECK preemptedAgents: agents deliberately stood down to free capacity for higher-priority work, listed until they are put back. Their work was interrupted rather than finished, so their tickets must NOT be left In Progress — move each back to To Do with a comment naming what took its slot. Re-activating one resumes the conversation it was stopped in. standbyAgents is NOT a problem to fix: agents somebody switched off on purpose whose workspace is still on disk, listed so they can be started again (butchr_activate_agent with their type and key, and their recorded defaultAgent so they come back as what they were). standbyTotal is the unclipped count when more exist than are listed.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "butchr_staleness_check",
        description:
          "Reports whether the Butchr installation on this machine is actually running the code that was merged: local checkout vs origin/main, daemon/src vs daemon/dist, the running daemon vs the build on disk, and extension sources vs extension/dist. Run this BEFORE citing anything observed from a running daemon or a loaded extension as proof that your change works — otherwise you may be testing whatever was last built rather than what you merged. It only reports; it never pulls, rebuilds or restarts anything.",
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description:
                "Optional. Recompute instead of reusing the cached report (cached for 15s). Pass true right after a rebuild.",
            },
          },
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
    if (name === "butchr_capacity") {
      const res = await callDaemonAPI('capacity');
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "butchr_activate_agent") {
      const { type, key, url, defaultAgent, override, preempt } = args as any;
      if (!type || !key) throw new Error("Missing required arguments");

      const res = await callDaemonAPI('activate_by_key', { type, key, url, defaultAgent, override, preempt });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // The sibling tools already flag their failures this way. Without it a
        // failed activation arrives as ordinary text, which is exactly how a
        // caller ends up believing an agent exists that does not.
        isError: res?.success === false,
      };
    }
    
    if (name === "butchr_deactivate_agent") {
      const { key, type } = args as any;
      if (!key) throw new Error("Missing key argument");

      const res = await callDaemonAPI('deactivate_by_key', { key, type });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    if (name === "butchr_send_to_agent") {
      const { key, type, message, intent } = args as any;
      if (!key || !message) throw new Error("Missing required arguments: key, message");

      const res = await callDaemonAPI('send_to_agent', { key, type, message, intent });
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
        // isError when an agent is missing, for the reason the staleness check
        // does the same: a supervisor skimming tool output for problems must
        // not skim past this one. A silently-stopped agent leaves its ticket
        // reading In Progress, which is the failure KAN-21 exists to end.
        //
        // A preempted agent is the same failure by a different route — its
        // ticket also reads In Progress with nothing behind it — so it flags
        // the same way. The difference is that somebody chose this one, which
        // makes it a decision owed rather than a loss to investigate.
        isError:
          res?.success === false ||
          (Array.isArray(res?.missingAgents) && res.missingAgents.length > 0) ||
          (Array.isArray(res?.preemptedAgents) && res.preemptedAgents.length > 0),
      };
    }

    if (name === "butchr_staleness_check") {
      const { force } = (args ?? {}) as any;
      const res = await callDaemonAPI('staleness_check', { force: force === true });
      // isError when something *is* stale, not only when the check failed: a
      // caller that skims tool output for problems must not skim past this one.
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false || res?.stale === true,
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
