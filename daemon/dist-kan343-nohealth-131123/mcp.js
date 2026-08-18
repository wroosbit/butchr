import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { connectToDaemon, onJsonLines, writeJsonLine } from './ipc.js';
import { WORKSPACE_KEY_FLAG, WORKSPACE_TYPE_FLAG } from './launchers.js';
import { CHANNEL_MESSAGE_ACTION, CHANNEL_NOTIFICATION_METHOD, isForwardableEvent } from './channel.js';
import { CHANNEL_SELFCHECK_ACTION, CHANNEL_SELFCHECK_RESULT_ACTION } from './channel-selfcheck.js';
import { operationByTool, operationsFor } from './atlassian-proxy.js';
import { genericRecovery } from './mcp-recovery.js';
import { ldOperationByTool, ldOperationsFor } from './launchdarkly-proxy.js';
import { fitListAgentsResponse, fitGenericResponse, MEASURED_CLIENT_CAP_CHARS } from './mcp-response-budget.js';
import { BUILD_SKEW_TOLERANCE_MS, classifyServerBuild, newestMtimeMs, readOwnBuild } from './mcp-build.js';
/**
 * Which build THIS server process loaded (KAN-526).
 *
 * Read at module load, before anything can rebuild `dist/` underneath a process
 * that has already read it. Every agent gets its own long-lived copy of this
 * process and nothing in the deploy path restarts them, so this constant is the
 * only thing that can answer "is the code answering you the code that was
 * merged?" without killing the session to find out.
 */
const OWN_BUILD = readOwnBuild(import.meta.url);
/**
 * This process's build, judged against the tree it was loaded from **now**.
 *
 * THE ANSWER TO "IS THE FIX LIVE FOR ME?" (KAN-526, AC2), and it has to be
 * composed here. The daemon can report which servers are stale because they
 * announce themselves to it; it cannot answer this one for the caller, because
 * the caller's question is about the process that is *serving the caller* — and
 * that process is this one. An agent that asks the daemon and reads a green is
 * reading a fact about the daemon.
 *
 * Re-reads the tree on every call rather than caching, deliberately: the whole
 * value of the answer is that {@link OWN_BUILD} was fixed at load while the
 * files on disk were not, and a cached comparison would freeze the half that is
 * supposed to move.
 */
function describeOwnBuild() {
    const nowNewest = newestMtimeMs(OWN_BUILD.distDir);
    return {
        ...OWN_BUILD,
        distBuildAtNow: nowNewest === null ? null : new Date(nowNewest).toISOString(),
        relation: nowNewest === null
            ? { kind: 'unreadable', distDir: OWN_BUILD.distDir }
            : classifyServerBuild(OWN_BUILD, OWN_BUILD.distDir, nowNewest, BUILD_SKEW_TOLERANCE_MS)
    };
}
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
function workspaceIdentityFromArgv(argv) {
    const read = (flag) => {
        const at = argv.indexOf(flag);
        if (at === -1)
            return undefined;
        const value = argv[at + 1];
        // A flag with nothing behind it, or with the next flag behind it, is a
        // malformed command line — not a workspace called '--workspace-key'.
        return value && !value.startsWith('--') ? value : undefined;
    };
    return { type: read(WORKSPACE_TYPE_FLAG), key: read(WORKSPACE_KEY_FLAG) };
}
const callerIdentity = workspaceIdentityFromArgv(process.argv.slice(2));
const server = new Server({
    name: "butchr-mcp",
    version: "1.0.0",
}, {
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
    //
    // AND THE LAST LINE NAMES NO FILE (KAN-400). It read *"the full brief is in
    // .butchr-prompt.md in this workspace"*, which is a fact about `HerdrBridge`
    // — it is the runtime that writes that file — and false under CrabCast,
    // whose published contract deliberately keeps the brief out of the caller's
    // directory. This string is the one site of the three that reaches a
    // CrabCast agent **today**, on every request it makes, restored or not.
    //
    // It names the concept rather than taking a location from the daemon, and
    // that is a decision rather than a shortcut: this process is a *client* of
    // the daemon, spawned by the agent's own CLI from `.mcp.json`, and the only
    // thing it knows about itself is what the daemon stamped onto its argv.
    // Under CrabCast today that is nothing at all — `withWorkspaceIdentity` is
    // applied in `herdr.ts` only, so the core server crosses the wire unstamped
    // (KAN-398). A `--brief` flag added here would therefore be correct on the
    // herdr path, absent on the CrabCast path, and — the part that decides it —
    // would start being *wrongly* present the day KAN-398 makes the transform
    // run on both. Correct by accident now, wrong after somebody else's fix.
    //
    // The concept is findable, which was the objection to naming one: every
    // agent's first turn is a pointer at its brief, under both runtimes. That
    // is the sentence this now names.
    instructions: 'Butchr manages this agent. A message another agent addresses to this one ' +
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
        'channel message makes a reply owed. The full brief is the activation ' +
        'instructions you were pointed at when this session began, under ' +
        '"Whose voice is this?".'
});
// Persistent connection to the Butchr daemon's Unix socket. Requests carry
// an id the daemon echoes back; broadcast events arrive without one and are
// forwarded as MCP logging notifications.
let daemonSocket = null;
let connectingDaemon = null;
const pending = new Map();
let nextRequestId = 0;
/**
 * RE-REGISTERING AFTER THE LINK DROPS, WITHOUT WAITING FOR A TOOL CALL (KAN-274)
 *
 * `daemonLink` is called from exactly one place — `callDaemonAPI` — so before
 * this, a link was only ever established by the agent *doing something*. The
 * `hello` beside it already carried the right intent, and says so: it is sent on
 * every established link "because the daemon forgets on `close` — a daemon
 * restart must leave this server re-registered rather than silently
 * unaddressable". That sentence was true of a **busy** agent and false of an
 * idle one, and the difference is the whole defect.
 *
 * Measured on the 2026-08-11T15:00:40Z restart: four agents survived, `0 failed`,
 * and **no** connection re-identified for 291 seconds. The three that came back
 * did so at their own next tool call (15:05:31, 15:05:41, 15:06:07); the one that
 * was idle never did. So the population left unaddressable is precisely the
 * population it is most costly to interrupt — an idle supervisor is the thing you
 * most often want to steer, and a steer to one arrived as a Ctrl+C.
 *
 * **This has to live agent-side, and that is a finding rather than a preference.**
 * The daemon cannot re-register anybody: the socket it lost is its only path to
 * this process, which is a stdio child of the client and holds no listener the
 * daemon could reach. So the agent must initiate, and the fix is to make it
 * initiate by itself.
 *
 * **Keyed to the link dropping, not to a restart.** A restart is the commonest
 * trigger and demonstrably not the only one — `write EPIPE` dropped
 * `task/KAN-278`'s registration on its own at 14:59:49Z the same day. Every one
 * of them arrives here as a `close`.
 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
let reconnectAttempt = 0;
let reconnectTimer = null;
/** Set once the process is shutting down, so a dying link stops retrying. */
let linkClosedForGood = false;
/**
 * Backoff with full jitter.
 *
 * The jitter is not decoration. Every agent's link dies in the same millisecond
 * when the daemon restarts, so a fixed schedule would have the whole fleet
 * reconnect in lockstep — the thundering herd arriving at a daemon that is still
 * doing its own boot reconciliation. Randomising spreads the same number of
 * connects across the window.
 */
function reconnectDelayMs(attempt) {
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10), RECONNECT_MAX_MS);
    return Math.floor(Math.random() * ceiling);
}
/**
 * Try to get the link back, and keep trying.
 *
 * Failure is expected rather than exceptional: the daemon is down for the whole
 * early part of a restart, so the first few attempts refuse and that is the
 * normal path through here, not an error to report. It is `unref`ed so a process
 * whose only remaining work is a pending reconnect can still exit — an MCP server
 * that outlived its client must not be held open by its own retry timer.
 */
function scheduleReconnect() {
    if (linkClosedForGood || reconnectTimer || daemonSocket || connectingDaemon)
        return;
    const wait = reconnectDelayMs(reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (linkClosedForGood || daemonSocket)
            return;
        daemonLink({ reconnect: true }).then(() => { }, 
        // Still down. Say nothing per attempt — this runs every few seconds during
        // a restart and a line each would bury the one that matters — and come
        // back. `daemonLink`'s own catch has already cleared `connectingDaemon`.
        () => scheduleReconnect());
    }, wait);
    reconnectTimer.unref?.();
}
/**
 * The ONE place a `notifications/claude/channel` frame is emitted.
 *
 * Two callers now — an addressed message from the daemon (KAN-244) and the
 * startup self-check (KAN-248) — and they must be the same emission or the
 * check is testing something the fleet does not use. That is the KAN-145 shape
 * exactly: a self-check with its own copy of the emit path would go green
 * against a copy nobody's messages travel on. One function, called twice.
 */
function emitChannelFrame(content, meta) {
    return server.notification({
        method: CHANNEL_NOTIFICATION_METHOD,
        params: { content, meta }
    });
}
/**
 * How long the client gets to answer the ping behind the channel frame.
 *
 * Shorter than the daemon's own wait for this whole answer (20s), so a client
 * that has stopped reading is reported by this end as `client-unresponsive` —
 * the specific cause — rather than by the daemon's end as a generic `no-answer`.
 * The two failures send a reader to different places and the timeouts are
 * ordered so the more specific one wins.
 */
const SELFCHECK_PING_TIMEOUT_MS = 10_000;
/**
 * Do the self-check's agent-side leg and report what happened, whatever happens.
 *
 * **Reports rather than asserts.** Nothing here decides an outcome — the daemon
 * does, in channel-selfcheck.ts, from these facts. This end is deliberately dumb
 * so that the decision procedure has one implementation and is testable without
 * a client.
 */
async function answerSelfCheck(socket, msg) {
    const startedAt = Date.now();
    const nonce = typeof msg?.nonce === 'string' ? msg.nonce : '';
    const client = server.getClientVersion();
    const capabilities = server.getClientCapabilities();
    let emitted = false;
    let emitError = null;
    try {
        await emitChannelFrame(
        // THE CONTENT IS ADDRESSED TO WHOEVER READS IT, because it may well be
        // read. If the client does place this in the model's context — which is
        // the thing being tested and cannot be observed from here — then an agent
        // meets it seconds after bring-up, and a bare nonce would read as an
        // intrusion at the exact moment it has least context to judge one. It says
        // what it is, asks for nothing, and needs no reply.
        `[butchr] startup channel self-check ${nonce} — this frame exists to prove that the ` +
            `channel loop works for this agent at bring-up. No action is required and no reply is ` +
            `expected. If you are reading this, the channel is delivering into your context.`, { selfCheck: true, nonce });
        emitted = true;
    }
    catch (e) {
        emitError = e?.message ?? String(e);
    }
    // THE PING IS THE EVIDENCE, AND ITS ORDER IS THE WHOLE MECHANISM. stdio is an
    // ordered stream, so a client can only produce this response after consuming
    // everything ahead of it — including the notification written a moment ago.
    // An MCP `ping` is part of the base protocol and needs no declared capability,
    // so this does not depend on anything the preview may move.
    let pingAnswered = false;
    let pingError = null;
    if (emitted) {
        let timer;
        // THE PING'S OWN REJECTION IS HANDLED BEFORE THE RACE, not by it. The SDK
        // gives a request its own 60s timeout, so on a client that never answers
        // this promise rejects long after the race has been decided by the shorter
        // deadline below — with no handler left on it, which in this process is an
        // unhandled rejection inside the agent's own MCP server. Attaching a `catch`
        // here marks it handled whichever way the race goes.
        const ping = server.ping();
        ping.catch(() => { });
        try {
            await Promise.race([
                ping,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`the client did not answer an MCP ping within ${SELFCHECK_PING_TIMEOUT_MS}ms`)), SELFCHECK_PING_TIMEOUT_MS);
                })
            ]);
            pingAnswered = true;
        }
        catch (e) {
            pingError = e?.message ?? String(e);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    writeJsonLine(socket, {
        action: CHANNEL_SELFCHECK_RESULT_ACTION,
        nonce,
        emitted,
        emitError,
        pingAnswered,
        pingError,
        // STRAIGHT OFF THE CLIENT'S OWN `initialize`, which is the only report of the
        // client version that describes THIS agent's client. `claude --version` on
        // the machine answers a different question — what is on PATH now — and an
        // agent started before an upgrade would be described by somebody else's
        // binary. Measured, not assumed: Claude Code 2.1.226 sends
        // `clientInfo: {name: "claude-code", version: "2.1.226", …}`.
        clientName: client?.name ?? null,
        clientVersion: client?.version ?? null,
        // A tripwire rather than a decision input. Nothing here branches on it: the
        // client declares `roots` and `elicitation` and says nothing about channels,
        // identically with and without the channels flag. It is recorded so that a
        // client which one day DOES declare something channel-shaped shows up in the
        // daemon log the day it happens rather than the day something breaks.
        clientCapabilities: capabilities ? Object.keys(capabilities).sort() : null,
        agentElapsedMs: Date.now() - startedAt
    });
}
/**
 * The link to the daemon, established on demand.
 *
 * `reconnect: true` is the KAN-274 path and it differs in one way that matters:
 * **it never spawns a daemon.** `connectToDaemon` starts one when the socket is
 * absent, which is right for a tool call — something wants the daemon *now* —
 * and wrong for a reconnect, which is waiting for a daemon that is already coming
 * back under systemd. The difference only became load-bearing with this ticket:
 * before it, a reconnect happened when one agent happened to make a call, and
 * after it every surviving agent reconnects at once. A fleet-wide `spawnDaemon`
 * on every restart is a race a *systemd* restart can lose — the socket is free
 * for a moment mid-restart, and an agent-spawned daemon that wins it becomes the
 * fleet's daemon as a child of an MCP server, outside the supervision that is
 * supposed to own it. (The reverse race is already known-harmless: a loser hits
 * EADDRINUSE and exits without ever listening, which launchers.ts records.)
 *
 * `retries: 0` for the same reason: the cadence belongs to the jittered backoff
 * in {@link scheduleReconnect}, and `connectToDaemon`'s own 20×250ms loop nested
 * inside it would be two schedules for one wait, with the inner one unjittered.
 */
function daemonLink(opts = {}) {
    if (daemonSocket)
        return Promise.resolve(daemonSocket);
    if (!connectingDaemon) {
        connectingDaemon = connectToDaemon(opts.reconnect ? { spawnIfMissing: false, retries: 0 } : {})
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
                }
                else if (msg?.action === 'hello_response') {
                    // Said on stderr rather than swallowed. KAN-217's finding was that
                    // a dead recipient is loud and a *misconfigured* one is silent; an
                    // agent whose identity never bound would be addressable by nobody,
                    // with no symptom until a message went missing.
                    console.error(msg.success
                        ? `Registered with the daemon as ${callerIdentity.type}/${callerIdentity.key} (${msg.connectionId})`
                        : `Daemon refused this server's identity: ${msg.error ?? 'no reason given'}`);
                }
                else if (msg?.action === CHANNEL_MESSAGE_ACTION) {
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
                    emitChannelFrame(msg.content, msg.meta).catch(() => { });
                }
                else if (msg?.action === CHANNEL_SELFCHECK_ACTION) {
                    // THE STARTUP SELF-CHECK'S AGENT-SIDE LEG (KAN-248, T5).
                    //
                    // This process is the only code in the fleet that can see the
                    // client, so it is the only place two of the three facts the check
                    // needs exist: whether the notification reached the client, and what
                    // version the client says it is. Both are answered by doing the real
                    // thing and reporting what happened — see channel-selfcheck.ts for
                    // why an ordinary MCP `ping` ordered behind the notification is what
                    // turns an unacknowledgeable frame into evidence the client read it.
                    void answerSelfCheck(socket, msg);
                }
                else if (isForwardableEvent(msg?.action)) {
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
                    }).catch(() => { });
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
                    workspaceKey: callerIdentity.key,
                    // WHICH BUILD THIS SERVER IS RUNNING (KAN-526). The daemon cannot
                    // work this out for itself: an `mcp.js` is a stdio child of an
                    // agent's client, so the daemon knows a socket and nothing about
                    // the process behind it — not its pid, not its age, and certainly
                    // not which `dist` it read. Announcing it here is what turns "every
                    // agent might be stale" into a list of which ones are.
                    //
                    // Re-sent on every reconnect along with the identity, and correct
                    // to: the values describe this process, and this process is the one
                    // that has just come back. A server that reconnects has not
                    // reloaded anything.
                    build: OWN_BUILD
                });
            }
            // The link is up, so the next drop starts its backoff from zero rather
            // than from wherever the last outage left it.
            reconnectAttempt = 0;
            socket.on('error', () => { });
            socket.on('close', () => {
                daemonSocket = null;
                for (const entry of pending.values()) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error('Daemon connection closed'));
                }
                pending.clear();
                // KAN-274. Without this the identity binding above is re-sent only when
                // this agent next makes a tool call, so an idle agent stays
                // unaddressable for as long as it stays idle and the next message to it
                // arrives as a composer Ctrl+C. The in-flight requests are still
                // rejected — this reconnects the link, it does not retry their work,
                // and re-sending a request nobody asked to repeat would be a second
                // delivery the caller did not ask for.
                scheduleReconnect();
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
async function callDaemonAPI(action, data = {}) {
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
/**
 * How long tool listing will wait for the daemon to say what its proxy serves.
 *
 * Deliberately far shorter than `callDaemonAPI`'s own 30s. This runs during the
 * client's `initialize`, so a daemon that is wedged would otherwise hold up
 * every agent's bring-up by half a minute to answer a question about an
 * optional feature. Timing out here costs the agent the proxy tools and nothing
 * else — it still has its own Atlassian MCP session, which is what it had
 * before KAN-272 and what it will have if this feature is reverted.
 */
const PROXY_STATUS_TIMEOUT_MS = 3000;
async function proxiedOperations() {
    try {
        const res = await Promise.race([
            callDaemonAPI('atlassian_proxy_status'),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`daemon did not answer within ${PROXY_STATUS_TIMEOUT_MS}ms`)), PROXY_STATUS_TIMEOUT_MS))
        ]);
        const mode = res?.report?.mode;
        // A daemon that answered `success: false`, or answered without a mode, has
        // not said yes either — it is asked-and-unusable rather than switched off,
        // so it lands in `unreachable` with what it actually said.
        if (res?.success !== true || !mode) {
            return {
                outcome: 'unreachable',
                because: 'the daemon answered but named no usable proxy mode' +
                    (typeof res?.error === 'string' ? `: ${res.error}` : ''),
                operations: []
            };
        }
        if (mode === 'off')
            return { outcome: 'off', operations: [], status: res };
        return { outcome: 'serving', mode, operations: operationsFor(mode), status: res };
    }
    catch (err) {
        // Said on stderr rather than swallowed, for `hello_response`'s reason: an
        // agent silently missing tools it was meant to have is the failure that
        // takes longest to notice.
        //
        // ⚠ AND STDERR IS EXACTLY WHY THIS WAS NOT ENOUGH. It reaches the client's
        // log, not the agent's context, so the agent whose tools went missing is
        // the one reader who cannot see this line. That is the half
        // `butchr_atlassian_proxy_status` closes.
        console.error(`Atlassian proxy tools not offered: ${err?.message ?? String(err)}. ` +
            "This agent's own Atlassian MCP session is unaffected.");
        return { outcome: 'unreachable', because: err?.message ?? String(err), operations: [] };
    }
}
/**
 * Which LaunchDarkly operations this agent may be offered, asked of the daemon
 * (KAN-298).
 *
 * Everything {@link proxiedOperations} says applies here unchanged, including
 * the reason the answer is *fetched* rather than computed: this process inherits
 * the agent CLI's environment and the daemon may have been started hours earlier
 * from a systemd unit with quite another one, so a tool list built from the
 * wrong environment is a menu of tools the daemon will refuse.
 *
 * A separate call rather than a field on the Atlassian one, because they are
 * separate switches: an operator turns the LaunchDarkly proxy on without
 * touching the Atlassian proxy, and a combined status would make one status
 * action's timeout cost an agent both sets of tools.
 *
 * ON FAILURE, ADVERTISE NOTHING — a daemon that cannot be asked is not a daemon
 * that said yes.
 */
async function ldProxiedOperations() {
    try {
        const res = await Promise.race([
            callDaemonAPI('launchdarkly_proxy_status'),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`daemon did not answer within ${PROXY_STATUS_TIMEOUT_MS}ms`)), PROXY_STATUS_TIMEOUT_MS))
        ]);
        const mode = res?.report?.mode;
        if (res?.success !== true || !mode || mode === 'off')
            return [];
        return ldOperationsFor(mode);
    }
    catch (err) {
        // Said on stderr rather than swallowed: an agent silently missing tools it
        // was meant to have is the failure that takes longest to notice, and it is
        // the precise failure this integration has been living with — the official
        // LaunchDarkly server has been exiting before it spoke MCP for a week, and
        // what that looked like was a tool list with nothing in it and no reason.
        console.error(`LaunchDarkly proxy tools not offered: ${err?.message ?? String(err)}.`);
        return [];
    }
}
server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Asked per listing rather than cached, so an operator who turns a proxy off
    // does not have to also restart every agent for a *new* client's listing to
    // reflect it. It changes nothing for a client that has already listed — see
    // the daemon's `handleAtlassianProxyCall` and `handleLaunchDarklyProxyCall`
    // for why the gate is there and the advertisement is only advisory.
    //
    // Concurrently, and that matters: each waits up to PROXY_STATUS_TIMEOUT_MS on
    // a daemon that may be wedged, and in series a wedged daemon would cost every
    // agent's bring-up twice that rather than once.
    const [proxied, ldProxied] = await Promise.all([proxiedOperations(), ldProxiedOperations()]);
    return {
        tools: [
            ...proxied.operations.map((op) => ({
                name: op.tool,
                description: op.description,
                inputSchema: op.inputSchema
            })),
            ...ldProxied.map((op) => ({
                name: op.tool,
                description: op.description,
                inputSchema: op.inputSchema
            })),
            // ⚠ ADVERTISED UNCONDITIONALLY, AND THAT IS THE WHOLE POINT (KAN-441).
            // It sits OUTSIDE the `proxied.operations` spread above, so its presence
            // is constant and is evidence of NOTHING about the mode — which is what
            // lets its *answer* be evidence. A tool that appeared only when the proxy
            // was on would be one more thing whose absence means both "off" and
            // "broken", which is the defect rather than the fix.
            {
                name: "butchr_atlassian_proxy_status",
                description: "Reports whether the daemon-side Atlassian proxy is serving, switched off, or could not be asked at all — the question an empty tool list CANNOT answer. READ `outcome` RATHER THAN COUNTING YOUR TOOLS: `serving` means the proxy is on and the `atlassian_*` tools in your list are real; `off` means the daemon was reached and said the switch is off, which is the ordinary default and NOT a fault; `unreachable` means the daemon could not be asked or gave no usable answer, and `because` carries what went wrong. THE FIRST TWO ARE INDISTINGUISHABLE FROM YOUR TOOL LIST and always will be: the proxy deliberately advertises nothing when it cannot deliver, because advertising tools that will refuse is worse than advertising none, so an empty `atlassian_*` menu means `off` AND `unreachable` alike. That is why this tool exists. ⚠ `outcome: 'off'` IS NOT A FAILURE and needs no action — every agent still has its own Atlassian MCP session and nothing about the off state is a degradation. `unreachable` IS worth acting on: your Atlassian tools are missing for a reason nobody chose. ALSO READ `credential.configured` WHEN PRESENT: it says a token is on that machine, NOT that Atlassian still accepts it — only a call establishes the second, and none is made while the proxy is off. `available: false` is a third thing again: the daemon answered but has no Jira service at all, so it could proxy nothing however the switch is set.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "butchr_capacity",
                description: "Reports how many concurrent agents this machine can carry and how many more can be started right now. The cap is derived from the machine's own cores and memory, so it differs between machines; headroom additionally accounts for the CPU and memory actually in use right now, so a fleet that is compiling reports less room than the same fleet idle. The load average is reported (`load1`) but no longer gates anything — `cpuBusyCores`, measured from /proc/stat, is what the CPU term divides. Separately from those counts, a machine that is *stalled* — thrashing on swap or blocked on a failing disk — admits nothing at all however much CPU and memory are free: `stallPercent` is the share of the last 10s in which every non-idle task was stalled (/proc/pressure `full avg10`, the worse of io and memory), and `stalled` says whether it crossed `stallRefusePercent`. A `stallPercent` of null does not mean healthy — it means this machine has no /proc/pressure and nothing is bounding I/O saturation. Ask this before activating, not after the machine is on its knees. ALSO REPORTS priorities: what each running agent is worth (epic 3, story 2, task 1), which is what an activation at capacity would have to strictly outrank before it could stand any of them down.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
            {
                name: "butchr_activate_agent",
                description: "Activates an agent for a specific workspace type and key (e.g. task and KAN-1). Refused when the machine is already at capacity — see butchr_capacity — unless override or preempt is set. A refusal names what is running and what each one is worth; when this activation outranks one of them, the refusal also carries a `preemption` block naming the agent that could be stood down to make room.",
                inputSchema: {
                    type: "object",
                    properties: {
                        override: {
                            type: "boolean",
                            description: "Optional. Start the agent even when the machine is at capacity. The refusal it bypasses is recorded with the load and memory figures at the time. Use it deliberately, not reflexively: the cap exists because a human noticed the desktop had become unusable.",
                        },
                        preempt: {
                            type: "boolean",
                            description: "Optional, and destructive. Make room by standing down the lowest-priority agent this activation STRICTLY outranks (epic 3 > story 2 > task 1), rather than over-committing the machine as override does. Equal priority never preempts, so a task agent can never displace another task agent, and nothing can displace an epic agent, because 3 is the top of the scale. The victim's uncommitted work is interrupted; it is recorded as preempted, reported by butchr_list_agents until it is put back, and resumes its conversation when re-activated. Read the `preemption` block on the refusal first — it names exactly who would be stopped and what they are doing — and do not pass this without having decided that this work matters more than theirs.",
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
                            description: "Optional, and OMITTING IT IS THE ORDINARY CASE — an omitted value launches 'claude', " +
                                "which since KAN-395 is the only agent Butchr launches. Pass it only to bring a " +
                                "standby agent back as whatever the registry recorded for it. 'anti-gravity' was " +
                                "retired on 2026-08-14 and asking for it REFUSES the activation rather than " +
                                "substituting claude; so does any other unknown name.",
                        },
                    },
                    required: ["type", "key"],
                },
            },
            {
                name: "butchr_deactivate_agent",
                description: "Deactivates an active agent by its workspace key. A BARE KEY THAT NAMES MORE THAN ONE AGENT IS REFUSED, NOT GUESSED: several workspace types can hold one key at once (task/KAN-1 and story/KAN-1 are different agents), and when a key matches more than one this REFUSES with `refusedBy: 'ambiguous-key'` and a `candidates` list naming every agent it matched. NOTHING IS STOOD DOWN when that happens — the refusal is the whole response, and the fix is to re-issue the call with `type`. Before KAN-473 the same call stopped whichever agent it happened to reach and reported `success: true` for it, so a supervisor could be destroyed by a correct-looking call.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "The workspace key (e.g., 'KAN-1')",
                        },
                        type: {
                            type: "string",
                            description: "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly. Omit it only when you mean 'whichever agent holds this key' AND are content to be refused if that is more than one — a bare key that matches several agents stops none of them and answers with the candidates instead.",
                        },
                    },
                    required: ["key"],
                },
            },
            {
                name: "butchr_send_to_agent",
                description: "Sends a message to a running agent. THE DAEMON CHOOSES HOW IT TRAVELS, PER RECIPIENT, AT SEND TIME — you never choose a transport and must never infer one. Two carriers exist: a CHANNEL, which delivers into the recipient's context and is acted on at its next turn boundary without disturbing work in flight; and the COMPOSER, which types into the recipient's terminal after a Ctrl+C. Which one carried your message is stated in the response as `transport`, together with `transportChosenBecause`. Read it there; do not work it out from whether the recipient has a channel, because you cannot see that and it changes underneath you. A THIRD VALUE MEANS NOTHING CARRIED IT: `transport: 'unregistered'` with `success: false` is a REFUSAL, not a delivery — the recipient holds no channel registration (a daemon restart, a socket error or a client reload drops one) and a steer is not permitted to reach it by interrupting it. Nothing was sent, so nothing was interrupted and nothing needs undoing. It re-registers by itself within seconds, so the fix is to wait and retry; `error` names the condition and what to do. Do not convert it into a `stop-now` to get past it unless you actually mean to destroy the tool call the recipient is running, which is what `stop-now` does. WHAT THE COMPOSER COSTS: its Ctrl+C does not merely clear a half-typed line — it cancels whatever the recipient is doing at that moment, including a tool call in flight, which does not resume. On the recipient's side the cancellation renders as a refusal, so an interrupted agent may report that a human rejected work nobody rejected, and an interrupt landing across parallel calls can leave some applied and report them all refused. The response says `interrupted: true` when that is what happened. A channel send costs the recipient nothing but context. WHAT YOU MAY CLAIM AFTERWARDS: the response carries `claims`, four separate facts that are never collapsed into one — the transport accepted the bytes (C1), a live session exists (C2), the text entered the transcript (C3), the model read it (C4). Each is `true`, `false`, or `null`, and NULL IS SILENCE, NOT A NEGATIVE: it means nothing here measured that, so resending on it may type a duplicate at an agent already working on the first copy. `licenses` says in one sentence what you may and may not state. Never report a message as received by an agent on the strength of `success` alone — `success` is C1 and nothing more. PROVENANCE: the daemon prefixes what it delivers with a sender tag it derives from YOUR workspace identity — `[from story/KAN-75] your message` — so do not write a sender into the message yourself; a sender you type is body text and is delivered after the daemon's tag rather than instead of it. The response echoes `sender` and `delivered` so you can see exactly what your recipient reads. On the composer, `butchr_tail_agent` is still the only thing that shows whether the Enter took. The recipient's convention is that an untagged message is the human typing directly, so relay a human decision as a decision you are reporting, not as your own instruction.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "The workspace key of the agent to message (e.g., 'KAN-1')",
                        },
                        type: {
                            type: "string",
                            description: "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against this daemon's sessions and herdr's agent list. A KEY THAT MATCHES MORE THAN ONE AGENT IS REFUSED rather than delivered to one of them — `refusedBy: 'ambiguous-key'` with a `candidates` list — because a steer that reaches the wrong agent is a steer the intended one never got and the wrong one acted on.",
                        },
                        message: {
                            type: "string",
                            description: "The message to send to the agent",
                        },
                        intent: {
                            type: "string",
                            enum: ["steer", "stop-now"],
                            description: "Optional, default 'steer'. WHAT YOU NEED, NOT HOW IT TRAVELS — this is not a transport selector and choosing a carrier is not yours to do. 'steer' is the ordinary case: the recipient should read this, and it can finish what it is doing first. 'stop-now' says the recipient must STOP what it is doing — it is about to conflict with you, or it is acting on something that has just become false. Only 'stop-now' can destroy a tool call in flight, and it destroys one every time it reaches a busy agent, so it is a decision about somebody else's work rather than a way of being heard sooner: `butchr_tail_agent` first if you want to know what you are about to take. The daemon maps your intent to a carrier and names the carrier it used in the response.",
                        },
                    },
                    required: ["key", "message"],
                },
            },
            {
                name: "butchr_guardian",
                description: "Reads or changes Butchr's GUARDIAN — the single agent the daemon pokes on a timer to sweep the fleet. THE GUARDIAN IS A POINTER, NOT A SPAWN: it names an agent that already exists and already has its own ticket, the poke is additional to that agent's work, and nothing here starts, reserves or creates anything. Pointing it at an agent that is not running does not bring one up; it makes the next poke report undelivered, which is the intended behaviour and not a gap. WHAT THE RECORD PROVES, AND IT IS LESS THAN IT LOOKS: `state.proves` is the literal 'delivery' and `state.provesDetail` says so in a sentence — this tells you whether the poke reached a live channel connection, NOT whether the fleet is being supervised. A heartbeat proves the loop turns; it says nothing about whether its decisions are right, so do not read a delivered poke as a swept fleet. READ THREE STATES APART: `configured: false` means NO GUARDIAN IS SET and nothing is watching the fleet on a timer; `overdue: true` means pokes are being sent and are not landing, so the guardian is not being asked to sweep; and an ordinary delivered poke means a frame reached a connection and no more. EXACTLY ONE GUARDIAN, ENFORCED: `op: 'set'` is REFUSED when a different agent is already the guardian, and the refusal names the incumbent and when it was set — pass `replace: true` to change it deliberately. Setting it to whoever it already is is idempotent and is not refused. The failure mode of two guardians is two parties each assuming the other swept.",
                inputSchema: {
                    type: "object",
                    properties: {
                        op: {
                            type: "string",
                            enum: ["get", "set", "clear", "poke"],
                            description: "Optional, default 'get'. 'get' reads the current guardian and the poke record. 'set' names the guardian (requires type and key). 'clear' unsets it, after which nothing is watching the fleet on a timer. 'poke' sends one poke NOW, off the schedule, through the same code path the timer takes — use it to find out whether the guardian is actually reachable rather than waiting for the interval. A poke lands in a real agent's context, so it is not free.",
                        },
                        type: {
                            type: "string",
                            description: "For 'set'. The guardian's workspace type (e.g. 'epic').",
                        },
                        key: {
                            type: "string",
                            description: "For 'set'. The guardian's workspace key (e.g. 'KAN-203').",
                        },
                        replace: {
                            type: "boolean",
                            description: "For 'set'. Change the guardian when a different one is already configured. Without it, a set against an existing guardian is refused and names the incumbent — that refusal is the whole point, because the failure it prevents is a silent replacement leaving two agents each believing they are the guardian. Pass it when you know who the guardian is and are changing it.",
                        },
                        intervalMs: {
                            type: "number",
                            description: "Optional, for 'set'. How often the guardian is poked, in milliseconds; defaults to 30 minutes and is clamped to between 1 minute and 24 hours. Omitting it keeps whatever is already configured rather than resetting it, so changing WHO the guardian is does not silently change HOW OFTEN.",
                        },
                    },
                    required: [],
                },
            },
            {
                name: "butchr_tail_agent",
                description: "Reads the recent terminal output of an agent without attaching to it. Use this to find out what an agent is actually doing — or why it stopped — when its reported status alone is not enough. READ THE THREE ANSWERS APART, because two of them look alike and only one is a claim about the agent: `success: true` with text is the pane; `success: true` with `text: \"\"` and `source: null` means EVERY read source was asked and every one was silent, so the pane really is blank; `success: false` means the read did not happen and you know NOTHING about the pane — in particular you must not read it as an idle agent. `source` names which source answered and `sourcesTried` lists what was asked. This matters most before a `stop-now` send: an agent you conclude is idle because a read failed is an agent whose in-flight tool call you are about to destroy. ALSO READ `addressedBy`: `key-and-type` means you named the agent exactly, `key-only` means the type was INFERRED from the one agent holding that key — a correct inference, but not the same claim as an exact address, and worth knowing before you cite this pane as evidence about a named agent.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "The workspace key of the agent to read (e.g., 'KAN-1')",
                        },
                        type: {
                            type: "string",
                            description: "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against this daemon's sessions and herdr's agent list. A KEY THAT MATCHES MORE THAN ONE AGENT IS REFUSED rather than answered about one of them — `refusedBy: 'ambiguous-key'` with a `candidates` list — because a tail attributed to the wrong agent is evidence that looks first-hand and is about somebody else.",
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
                description: "Reports an agent's full state: session id, workspace type and key, url, creation time, session status, working directory, and herdr's own view of what the agent is doing. If the daemon has restarted and lost its session, the herdr-only fields are still returned with sessionless: true. IT ALSO CARRIES `channel`, THE SAME BLOCK butchr_list_agents PUTS ON A ROW, AND BEFORE KAN-435 IT DID NOT — the key was absent for every agent in every state, including agents with a live channel and a millisecond round trip, which was read as `this agent has no channel` and filed as a defect on two agents that were both fine. READ `channel.transport` BEFORE SENDING: `channel` means a send costs the recipient nothing, `composer` means it begins with a Ctrl+C that destroys the tool call in flight, and `unregistered` means a steer is refused rather than delivered. A FRESH AGENT IS NOT A CHANNEL-LESS ONE: registration takes about twelve seconds from spawn while the client answers its startup dialogs, so a missing or `unregistered` carrier in an agent's first seconds clears by itself and waiting costs less than the interrupt does. ALSO READ `addressedBy`: `key-and-type` means you named the agent exactly, `key-only` means the type was INFERRED from the one agent holding that key. A key holding SEVERAL agents is refused rather than resolved — `refusedBy: 'ambiguous-key'` with a `candidates` list — because a status attributed to the wrong agent is a first-hand-looking reading of somebody else, and nothing downstream could tell.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "The workspace key of the agent to inspect (e.g., 'KAN-1')",
                        },
                        type: {
                            type: "string",
                            description: "Optional. The workspace type (e.g., 'task'). Addresses the agent exactly; omit to resolve the key against this daemon's sessions and herdr's agent list. A KEY THAT MATCHES MORE THAN ONE AGENT IS REFUSED rather than answered about one of them — `refusedBy: 'ambiguous-key'` with a `candidates` list.",
                        },
                    },
                    required: ["key"],
                },
            },
            {
                name: "butchr_list_agents",
                description: "READ `completeness` FIRST, BEFORE THE LIST AND BEFORE ANY COUNT YOU TAKE OFF IT. It is the first field on every answer and it says whether this answer is the whole answer. `kind: 'complete'` means every field is present and every list is entire. `kind: 'clipped'` means this response was reduced to fit a declared character budget before it was sent, and it carries a `clipped` array naming each field, what was done to it, and the exact call that returns the rest. THE TWO ARE DIFFERENT SHAPES, NOT ONE SHAPE WITH A FLAG: a complete verdict has no `clipped` key at all, so there is no value you can misread as 'fine' — this is deliberately unlike Jira's `hasNextPage`, which reads `false` in both the complete and the truncated case. `agentsTotal` IS ALWAYS PRESENT AND IS NEVER CLIPPED: compare it against `agents.length` and you have checked the count in one step, whoever did the clipping. WHY THIS EXISTS (KAN-423): this response used to be serialised whole and handed to the client, which cut it to fit — measured at 44,557 characters against a client that delivered 10,000, with the middle of the `agents` array among the bytes that went. A short list and a clipped list were the same bytes, so an agent reading its own fleet under-counted it and concluded things about absence: nothing else is running, nobody holds that file, that key is free. Reduction now happens here, where it can be described. `agentsView` says how much is said about each row when the full rows would not fit: absent means whole rows, `'summarised'` means identity and status per agent, `'addresses'` means type/key only — NOTE THAT NEITHER OF THOSE DROPS AN AGENT, so the count stays exact and only the detail goes. A field reduced away leaves a stub carrying `omitted: 'for-budget'` and a `readWith` recipe rather than vanishing, because a deleted key and a key this daemon does not carry are the same absence and this response uses absence to mean the second one. Pass `view: 'summary'` for counts and addresses only, `section: '<field>'` to get one field back in full, or `offset: <n>` to walk a fleet too large for one answer. "
                    + "Lists every running agent, from herdr's view of what exists rather than the daemon's session map — so agents that outlived a daemon restart are still listed. Each entry carries sessionless: true when the daemon is not attached to it, in which case the session-only fields (sessionId, url, createdAt, status) are null. Panes named like agents but with no agent behind them are reported separately under unbackedPanes and are not counted as agents. ALSO CHECK censusUnreadableRecordsTotal BEFORE YOU TRUST THE AGENT COUNT: it is how many registry rows the census could not read and therefore did NOT count, and a zero there is what makes the list above trustworthy. A non-zero means THIS LIST IS SHORT BY THAT MANY and the agents it omits are named in censusUnreadableRecords with the reason each was skipped — so an agent may be running with no row here, and concluding 'nothing is working on that' from a short list is exactly the mistake this field exists to prevent. `null` is NOT zero and must not be read as one: it means no disclosure reached this daemon at all — the census could not be taken, or the peer predates read-path contract v4 — so the count may be short with nothing able to say so. READ EACH ROW'S `standing` RATHER THAN WATCHING THE COUNT: the count never falls on its own, so a steady non-zero is the ordinary state and is NOT a fault, while ANY INCREASE is a real event. `standing.available: false` means the peer is too old to have rendered a verdict (`because: 'peer-below-v7'`) — that is a fact about the CONNECTION and is NOT the same as `standing: 'unknown'`, which is a verdict about the row; do not read either as an all-clear. Where `standing.available` is true, read the verdict at `standing.verdict` with its evidence `standing.claimsEvent` beside it: `'retired'` means the row records an agent being switched off and nothing was going to be restored from it, while `'claims-an-agent'` is the one to look at. For those, READ `supersession` RATHER THAN GUESSING: `matched` means a later readable row already covers that agent and there is nothing to do, `ran-found-nothing` means nothing readable supersedes it and IS the case worth acting on, and `could-not-run` means the row named no path to join on so THE QUESTION WAS NOT ANSWERED — that is not evidence either way, and treating it as 'lost' manufactures an alarm that never clears. Use `identity` to find the line in the registry by hand; never join on it, because it is in the row's own vocabulary and matches nothing in a path-keyed list. `standing.claimsAt` is a quotation of what the row said and is NOT guaranteed to parse as a date. All three v7 fields sit together behind `standing.available` because they arrive together: a peer below v7 sends none of them, and reading a missing `claimsAt` as 'the row named no timestamp' is the same collapse one field over. ALSO CHECK missingAgents: agents the durable registry records as active that are not running at all — a ticket of theirs will still read In Progress while nothing is working on it, so treat a non-empty missingAgents as work that has silently stopped and needs re-activating or standing down. ALSO CHECK preemptedAgents: agents deliberately stood down to free capacity for higher-priority work, listed until they are put back. Their work was interrupted rather than finished, so their tickets must NOT be left In Progress — move each back to To Do with a comment naming what took its slot. Re-activating one resumes the conversation it was stopped in. standbyAgents is NOT a problem to fix: agents somebody switched off on purpose whose workspace is still on disk, listed so they can be started again (butchr_activate_agent with their type and key, and their recorded defaultAgent so they come back as what they were). standbyTotal is the unclipped count when more exist than are listed. ALSO CHECK each agent's `channel`: what its startup channel self-check found, and the carrier its messages will actually take. `transport: 'composer'` means that agent's channel loop did not prove out at bring-up, so a message to it will interrupt whatever it is doing — an agent silently on the composer while you believe it is on channels is exactly what this field exists to prevent. `outcome: 'unverified-client'` means the loop works but the Claude Code version it is running is one nobody has measured channel delivery on; channels are a research preview and the contract can move, so treat delivery to that agent as unproven and say so if you rely on it. `outcome: 'unchecked'` is NOT a fault: nobody has checked, usually because the agent outlived a daemon restart. READ `transport` RATHER THAN `outcome` FOR THE CARRIER — they are different questions and an unchecked agent can be on any of the three. `transport: 'unregistered'` means the agent holds no channel registration while the registry expects it to: a steer to it is REFUSED rather than delivered, it is the ordinary state for the first seconds after a daemon restart or a socket error, and it clears by itself when the agent's MCP server re-announces. Before KAN-274 this field read `'channel'` in that state and a send to such an agent interrupted it, so an older daemon's row cannot be trusted on this point. `clientVersion` is the client's own report of itself and is what pins any of this to a version. An absent `channel` field means this daemon cannot answer, which is different from every value it could carry. ALSO CHECK undeliveredNotifications: news the DAEMON ITSELF could not deliver — a ticket status change, a new comment, an agent of yours going blocked. Since KAN-301 the daemon never types a notification into a terminal, so a notification whose recipient held no channel registration is HELD rather than delivered by interrupt, and this is where it is visible. `pending` is recoverable: each entry names the recipient, how many notices are waiting, how long the oldest has waited and why the channel would not take it, and every one is retried on the daemon's 30-second sweep and delivered the moment that agent's registration comes back. `abandoned` is the one to act on: those notices waited past their window and were DROPPED, so the agents named there were never told and their Jira tickets are the only remaining record — go and read the ticket named in `lastSubject` rather than assuming somebody was informed. The abandoned count is never reset while this daemon lives. An empty `pending` and an empty `abandoned` together mean every notification this daemon produced reached a live channel. An ABSENT `undeliveredNotifications` field means this daemon does not track that, which is different from tracking it and holding nothing. ALSO CHECK boardControl.health: whether the board reconciler could establish, on its last cycle, that anybody MEANT to stop the agents it is not being told to run. Since KAN-342 an agent is stood down only where the board SAID something — a status that excludes its ticket, or an assignee that is somebody else's — and every other absence spares it. That evidence comes from one diagnostic query, so `health.diagnostic.answered: false` means NO AGENT CAN BE STOOD DOWN AT ALL while it lasts: a ticket moved to Done keeps its agent running, the fleet stops shrinking, and the capacity gate starts refusing real work while the reconciler goes on reporting that it converged. READ `consecutiveFailures` RATHER THAN `answered`, because they answer different questions: 1 is the ordinary one-off 5xx or timeout that the next cycle fixes and is NOT worth acting on, while a number in the tens means stand-downs have been off for that many minutes and somebody has to look — `failingSince` says when it started and `detail` carries Jira's own words, so a partial page is distinguishable from an outage. `health.agents` lists every agent left running for want of evidence, each with the `condition` that spared it: `undetermined` is the diagnostic being silent (the case above), while `no-assignee` is one ticket whose assignee field is empty and is fixed by assigning it to this machine's Jira account. `health: null` is NOT a healthy board — it means no cycle has completed yet, which is the ordinary state for the first minute after a daemon restart. An ABSENT `boardControl` field means no reconciler is wired here at all.",
                inputSchema: {
                    type: "object",
                    properties: {
                        view: {
                            type: "string",
                            enum: ["full", "summary"],
                            description: "Optional, default 'full'. 'summary' answers with every agent's type/key and the fleet counts, and none of the diagnostic sections — the answer that stays small however large the fleet gets. Use it when the question is who is running rather than what each one is doing. `agentsTotal` is present either way, so a summary is still a trustworthy count.",
                        },
                        section: {
                            type: "string",
                            description: "Optional. Return exactly one top-level field of the response, in full, instead of the whole thing. This is what a `readWith` recipe on an omitted stub is telling you to call. An unknown name is refused with the list of names this response actually carries, rather than answered empty — 'no such section' and 'that section is empty' are different facts.",
                        },
                        offset: {
                            type: "number",
                            description: "Optional, default 0. Where the `agents` window starts, for a fleet too large to answer in one call. Only ever needed when `completeness.clipped` reports `agents` with `reduction: 'entries-omitted'`, and the `readTheRest` on that record names the offset to pass.",
                        },
                    },
                    required: [],
                },
            },
            {
                name: "butchr_staleness_check",
                description: "Reports whether the Butchr installation on this machine is actually running the code that was merged: local checkout vs origin/main, daemon/src vs daemon/dist, the running daemon vs the build on disk, THE AGENT MCP SERVERS vs that same build, and extension sources vs extension/dist. Run this BEFORE citing anything observed from a running daemon or a loaded extension as proof that your change works — otherwise you may be testing whatever was last built rather than what you merged. READ `servingProcess` FIRST, AND READ IT AS BEING ABOUT YOU: every other field here was computed by the daemon, and that one is computed by the mcp.js process serving YOUR calls, which a deploy does not restart (KAN-526). `relation.kind` of `older` means the process answering you loaded a build older than the one on disk, so anything you observe through your own proxy is evidence about the code you started with rather than about the deploy — and green daemon-side items sit happily beside it, because the daemon and your server are restarted by different things. The `mcp-servers` item asks the same question of every connected agent. It only reports; it never pulls, rebuilds or restarts anything, and nothing here can reload an mcp.js without costing that agent its session.",
                inputSchema: {
                    type: "object",
                    properties: {
                        force: {
                            type: "boolean",
                            description: "Optional. Recompute instead of reusing the cached report (cached for 15s). Pass true right after a rebuild.",
                        },
                    },
                    required: [],
                },
            },
            {
                name: "butchr_reclaim_workspaces",
                description: "Reclaims disk by deleting `node_modules` directories from Butchr workspaces that have NO live agent in them. A workspace is ~296MB and almost all of it is regenerable dependencies; nothing in the daemon ever removed them, so they accumulate without bound. DEFAULTS TO A DRY RUN — it reports what it would delete and deletes nothing. Pass dryRun: false to actually reclaim, and mean it: the deletion is not reversible, though everything it removes is restored by `npm install`. WHAT IT WILL NOT TOUCH: any workspace with a live agent or an occupied pane (derived from the running fleet at the moment of the sweep, never from a list), source, git worktrees, `.git`, `.butchr-prompt.md`, `.mcp.json`, `.claude/`, `dist/`, a `node_modules` that is a symlink, or anything git does not report as ignored in its own worktree. It never deletes a workspace directory, so conversation history and worktree registrations survive — a reclaimed workspace still resumes the conversation it was stopped in, it just needs `npm install` before it can build again. The response lists every path removed with its bytes; a summary of the last sweep also rides the `butchr_list_agents` response under `reclaim`.",
                inputSchema: {
                    type: "object",
                    properties: {
                        dryRun: {
                            type: "boolean",
                            description: "Optional, defaults to TRUE. When true (or omitted) nothing is deleted and the response reports what would be. Pass false to actually reclaim.",
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
/**
 * THE BUDGET GATE — KAN-423, and it is deliberately the last thing every tool
 * answer passes through.
 *
 * `butchr_list_agents` is fitted properly, by `fitListAgentsResponse`, at its
 * own call site: it knows which fields matter and gives up the passengers
 * before the fleet. Everything else lands here, where the only safe reduction
 * on an unknown shape is to give up whole top-level fields largest-first —
 * which is worse, and is still incomparably better than handing the client more
 * than it will carry and letting it cut bytes off the end.
 *
 * WHY A GATE RATHER THAN A CALL PER TOOL. There are two dozen `return` sites in
 * this handler and a new tool adds another. A rule enforced at each of them is a
 * rule that holds until somebody adds the twenty-fifth; a rule enforced at the
 * one place they all pass through covers the tools nobody has written yet. The
 * defect KAN-423 was filed about is exactly what happens when a size limit is
 * nobody's job.
 *
 * IT IS A BACKSTOP AND NOT THE FIX. On every tool but `butchr_list_agents` it
 * should never fire — measured 2026-08-15, the next largest answer on this
 * server is well under the budget. If it starts firing, that is a tool that has
 * grown a fleet-sized field and wants a ladder of its own.
 */
function boundToBudget(name, result) {
    // Only the text payload is gated. `isError` is a verdict about the call and
    // is carried through untouched: a refusal that got large must not become a
    // success because it was reduced.
    const single = result.content.length === 1 ? result.content[0] : null;
    if (!single || single.type !== 'text')
        return result;
    // Already fitted at its own call site. Re-fitting a fitted answer would wrap
    // a completeness block around a completeness block, so the only case worth
    // handling here is the one that means the call-site fit has a bug in it.
    if (name === 'butchr_list_agents' && single.text.length <= MEASURED_CLIENT_CAP_CHARS) {
        return result;
    }
    let parsed;
    try {
        parsed = JSON.parse(single.text);
    }
    catch {
        // Not JSON — an `Error: ...` string from the catch in `dispatchTool`, which
        // is short by construction. Nothing to reduce, and nothing safe to cut.
        return result;
    }
    if (name === 'butchr_list_agents') {
        // Over the cap despite the call-site fit: a bug in the fit, and not a
        // reason to ship the overflow. Reduced again rather than let through.
        return {
            ...result,
            content: [{ type: 'text', text: fitListAgentsResponse(parsed, {}).text }]
        };
    }
    const fitted = fitGenericResponse(parsed, {
        tool: name,
        recoveryFor: (path) => genericRecovery(name, path)
    });
    // An answer already inside the budget goes back exactly as its tool wrote it.
    // The gate is a ceiling, not a reformatter: adding a `completeness` block to
    // every small answer on this server would churn two dozen tool contracts to
    // say something none of them had a problem with.
    if (fitted.completeness.kind === 'complete')
        return result;
    return { ...result, content: [{ type: 'text', text: fitted.text }] };
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return boundToBudget(name, await dispatchTool(name, args));
});
async function dispatchTool(name, args) {
    try {
        // The Atlassian proxy (KAN-272). Matched against the shared operation table
        // rather than against whatever this process last advertised: a client may
        // call a tool it listed minutes ago, and the daemon — which owns the gate —
        // is where that call is decided. Forwarding an operation the daemon has
        // since switched off produces its refusal, which is the honest answer; a
        // guess here would produce a different one.
        if (operationByTool(name)) {
            const res = await callDaemonAPI('atlassian_proxy_call', { tool: name, args: args ?? {} });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                // A refused read must never arrive as ordinary text. That substitution
                // is the 2026-08-10 failure in miniature: what an agent saw was
                // something that looked like an answer, and the twelve hours went on
                // whether the credential was dead being unknowable from the call.
                isError: res?.success === false,
            };
        }
        // The LaunchDarkly proxy (KAN-298), matched against the shared operation
        // table for the same reason the Atlassian one is: a client may call a tool
        // it listed minutes ago, and the daemon — which owns the gate — is where
        // that call is decided. Forwarding an operation the daemon has since
        // switched off produces its refusal, which is the honest answer.
        //
        // THE PREFIX MATCH IS DELIBERATE AND IS NOT A WIDENING. Any `launchdarkly_`
        // name is forwarded, including the ten this proxy does not have — which are
        // exactly LaunchDarkly's ten write tools. It grants nothing: the daemon
        // refuses every name it does not find, and no request is made. What it buys
        // is the *sentence*. Without it, `launchdarkly_delete_feature_flag` fell
        // through to this server's generic handler and came back as
        // `MCP error -32601: Unknown tool`, which is a correct refusal that tells
        // the caller nothing — so an agent reasonably concludes it guessed the
        // spelling wrong and tries four more variants. The daemon's refusal instead
        // says the omission is deliberate and why, which is the difference between a
        // dead end and an answer. Found by
        // `verify-launchdarkly-proxy-failure-is-loud.mjs` §3, which is the only
        // reason it is not still true.
        if (ldOperationByTool(name) || name.startsWith('launchdarkly_')) {
            const res = await callDaemonAPI('launchdarkly_proxy_call', { tool: name, args: args ?? {} });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                // A refused read must never arrive as ordinary text — a refusal that
                // reads like an answer is the defect this whole integration exists to
                // remove, and an empty flag list that is really a dead credential is
                // exactly the shape it takes here.
                isError: res?.success === false,
            };
        }
        // KAN-441. Answers the question the tool list cannot: is the proxy off, or
        // is the daemon simply not answering?
        //
        // ⚠ ONE ROUND TRIP, NOT TWO, AND THE TYPE IS WHY. `proxiedOperations()`
        // already asked the daemon, so its answer is carried on the advertisement
        // and reported from there. A second, independent call could reach a daemon
        // in a different state from the one that built the menu, and this tool
        // would then describe a world the agent's tool list did not come from — the
        // same two-readings-of-one-switch mistake `proxiedOperations`' own header
        // warns about.
        //
        // ⚠ AND THE `unreachable` VARIANT DELIBERATELY CARRIES NO `status` AT ALL.
        // That is not tidiness: it makes "report a daemon's answer when no daemon
        // answered" un-writable rather than merely wrong. The first draft did fetch
        // a second time, guarded by an `outcome` check — and a mutation that
        // collapsed `unreachable` into `off` sent it to `await` a daemon that was
        // wedged, where it hung for the full 30s `callDaemonAPI` timeout instead of
        // failing. The field being absent from the variant is what removes that
        // whole class; a guard I have to remember to write is not.
        if (name === "butchr_atlassian_proxy_status") {
            const advertised = await proxiedOperations();
            const status = advertised.outcome === 'unreachable' ? null : advertised.status;
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            outcome: advertised.outcome,
                            ...(advertised.outcome === 'unreachable'
                                ? { because: advertised.because }
                                : {}),
                            ...(advertised.outcome === 'serving' ? { mode: advertised.mode } : {}),
                            toolsAdvertised: advertised.operations.map((op) => op.tool),
                            // Stated rather than left to be inferred from an empty list,
                            // because inferring it from an empty list is the defect.
                            whatAnEmptyToolListMeans: "both 'off' and 'unreachable' — read `outcome`, not your tool list",
                            ...(status?.success === true
                                ? { available: status.available, report: status.report }
                                : {})
                        }, null, 2)
                    }
                ],
                // `off` is not an error — it is the default and nothing is wrong. Only
                // a daemon that could not be asked is.
                isError: advertised.outcome === 'unreachable',
            };
        }
        if (name === "butchr_capacity") {
            const res = await callDaemonAPI('capacity');
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                isError: res?.success === false,
            };
        }
        if (name === "butchr_activate_agent") {
            const { type, key, url, defaultAgent, override, preempt } = args;
            if (!type || !key)
                throw new Error("Missing required arguments");
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
            const { key, type } = args;
            if (!key)
                throw new Error("Missing key argument");
            const res = await callDaemonAPI('deactivate_by_key', { key, type });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            };
        }
        if (name === "butchr_send_to_agent") {
            const { key, type, message, intent } = args;
            if (!key || !message)
                throw new Error("Missing required arguments: key, message");
            const res = await callDaemonAPI('send_to_agent', { key, type, message, intent });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                isError: res?.success === false,
            };
        }
        if (name === "butchr_guardian") {
            const { op, type, key, replace, intervalMs } = args;
            if (op === 'set' && (!type || !key)) {
                throw new Error("Missing required arguments for op 'set': type, key");
            }
            const res = await callDaemonAPI('guardian', { op, type, key, replace, intervalMs });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                // BOTH REFUSALS ARRIVE AS ERRORS, and that is the point rather than
                // tidiness. A `set` refused because there is already a guardian, and a
                // `poke` that was not delivered, both answer `success: false` — and an
                // undelivered poke arriving as ordinary text is exactly the reassurance
                // AC2 exists to forbid. `success` is the delivery, never the request.
                isError: res?.success === false,
            };
        }
        if (name === "butchr_tail_agent") {
            const { key, type, lines } = args;
            if (!key)
                throw new Error("Missing required argument: key");
            const res = await callDaemonAPI('tail_agent', { key, type, lines });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                isError: res?.success === false,
            };
        }
        if (name === "butchr_agent_status") {
            const { key, type } = args;
            if (!key)
                throw new Error("Missing required argument: key");
            const res = await callDaemonAPI('agent_status', { key, type });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                isError: res?.success === false,
            };
        }
        if (name === "butchr_list_agents") {
            const { view, section, offset } = (args ?? {});
            const res = await callDaemonAPI('list_agents');
            // KAN-423. The census goes out through the fitter rather than through
            // `JSON.stringify`, so what leaves here is inside a declared budget and
            // carries a `completeness` verdict saying whether it is whole. The daemon
            // socket above is untouched: the board page reads it with no cap, and the
            // census itself is not this ticket's business.
            const fitted = fitListAgentsResponse(res, {
                view: view === 'summary' ? 'summary' : 'full',
                section: typeof section === 'string' && section ? section : null,
                offset: typeof offset === 'number' ? offset : 0
            });
            return {
                content: [{ type: "text", text: fitted.text }],
                // isError when an agent is missing, for the reason the staleness check
                // does the same: a supervisor skimming tool output for problems must
                // not skim past this one. A silently-stopped agent leaves its ticket
                // reading In Progress, which is the failure KAN-21 exists to end.
                //
                // A preempted agent is the same failure by a different route — its
                // ticket also reads In Progress with nothing behind it — so it flags
                // the same way. The difference is that somebody chose this one, which
                // makes it a decision owed rather than a loss to investigate.
                isError: res?.success === false ||
                    (Array.isArray(res?.missingAgents) && res.missingAgents.length > 0) ||
                    (Array.isArray(res?.preemptedAgents) && res.preemptedAgents.length > 0),
            };
        }
        if (name === "butchr_staleness_check") {
            const { force } = (args ?? {});
            const res = await callDaemonAPI('staleness_check', { force: force === true });
            // WHO ANSWERED, AND OUT OF WHICH BUILD (KAN-526).
            //
            // Every other field here was computed by the daemon and forwarded through
            // this process. This one is computed *by* this process, and that is the
            // whole point: the caller is an agent asking "am I looking at the code
            // that was merged?", and the honest answer has two halves, because the
            // daemon and this server are restarted by different things. The daemon's
            // half arrives on a deploy; this half arrives when the agent's client is
            // restarted, which a deploy does not do.
            //
            // It is attached here rather than composed in the daemon for the reason
            // the ticket rests on: a report about the answering process cannot be
            // written by anything except the answering process.
            const serving = describeOwnBuild();
            return {
                content: [{ type: "text", text: JSON.stringify({ ...res, servingProcess: serving }, null, 2) }],
                // A stale *server* is an alarm on the same footing as a stale daemon:
                // it is the state in which this agent's live output is evidence about
                // the build it started with and nothing else.
                isError: res?.success === false || res?.stale === true || serving.relation.kind === 'older',
            };
        }
        if (name === "butchr_reclaim_workspaces") {
            const { dryRun } = (args ?? {});
            // The default lives in one place — the daemon — and this only forwards
            // what the caller actually said. Defaulting here as well would put two
            // copies of "is this destructive by default?" in the codebase, and the
            // one that drifts is the one that deletes.
            const res = await callDaemonAPI('reclaim_sweep', { dryRun });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
                isError: res?.success === false,
            };
        }
        if (name === "butchr_reset_agent") {
            const { type, key } = args;
            if (!type || !key)
                throw new Error("Missing required arguments: type, key");
            const res = await callDaemonAPI('reset_by_key', { type, key });
            return {
                content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            };
        }
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
}
async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // WHEN THE CLIENT GOES, STOP TRYING TO COME BACK (KAN-274). The reconnect
    // loop's whole purpose is to keep an *agent* addressable, and there is no
    // agent once the client that hosts this server has gone: retrying then would
    // re-register an identity nothing can be delivered to, which is worse than
    // being absent, because the daemon would resolve a live connection for it and
    // route real messages into a dead process. The timer is `unref`ed as well, so
    // this is belt-and-braces rather than the only thing that lets the process
    // exit — but an `unref`ed timer still fires in a process that has other work,
    // and this is what stops it doing so.
    //
    // INSTALLED AFTER `connect` AND CHAINED, rather than set before it. `connect`
    // installs its own `onclose`, and the SDK's doc comment states that it
    // "replac[es] any callbacks that have already been set" — its implementation
    // actually chains to the previous one, so setting this first happens to work
    // today. Depending on which of the two is true is depending on the difference
    // between a library's documentation and its implementation, and this ordering
    // needs neither to hold.
    const closedByProtocol = transport.onclose;
    transport.onclose = () => {
        closedByProtocol?.();
        linkClosedForGood = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };
    console.error("Butchr MCP Server running on stdio");
    // Connect eagerly (spawning the daemon if needed) so broadcast events stream
    // as notifications. A link that later drops is re-established by
    // `scheduleReconnect` rather than by the next tool call — see the KAN-274
    // header above it for why waiting for a tool call left idle agents
    // unaddressable, and what that cost them.
    daemonLink().catch(() => { });
}
run().catch(console.error);
