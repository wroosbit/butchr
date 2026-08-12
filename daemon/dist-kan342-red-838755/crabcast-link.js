import net from 'net';
import os from 'os';
import path from 'path';
/**
 * The transport half of the CrabCast-backed runtime (KAN-278): one long-lived
 * Unix-socket connection to a CrabCast daemon, newline-delimited JSON,
 * id-correlated.
 *
 * ## Why the socket and not the CLI
 *
 * Both were sanctioned by the ticket. The socket wins on three counts that are
 * facts about CrabCast's surface at the pinned commit rather than preferences,
 * each read off the running daemon rather than off their source:
 *
 * 1. **The CLI cannot serve the PTY group at all.** `crabcast --help` at
 *    `8d7348f` lists ten commands — configure, activate, deactivate, forget,
 *    list, status, tail, send, capacity, daemon-status — and none of them is a
 *    pty verb. The socket answers `pty_init`, `pty_input` and `pty_resize`,
 *    which is 3 of `AgentRuntime`'s 23 methods that the CLI simply cannot
 *    reach. That is by design on their side: CrabCast "never embeds a
 *    terminal" (KAN-59 north star 2), so its *client* exposes no terminal.
 * 2. **`registerDataListener` and `setSessionEndedListener` need a stream, and
 *    a CLI is one process per call.** `pty_output` frames and `agent.*` events
 *    arrive unsolicited on a held-open connection; a process that exits cannot
 *    receive them.
 * 3. **Cost.** `getSessionByAddress` is the daemon's dominant lookup (8 of the
 *    43 call sites KAN-223 derived the interface from). A process spawn per
 *    lookup is not a thing this daemon can afford.
 *
 * **What choosing the socket costs us, stated because it is a real trade.** The
 * CLI is the surface CrabCast documents, with documented exit codes and a
 * `--json` mode that promises to print the daemon's answer verbatim.
 *
 * **That trade got smaller at `8d7348f` and did not go away** (KAN-294). Their
 * KAN-277 has landed: `docs/read-path-contract.md` now covers the socket's
 * `list_agents` and `agent_status` field by field and puts a version on the wire
 * ({@link CRABCAST_CONTRACT_VERSION}). What is still unpublished is everything
 * else we touch — `activate_response`, `configure_response`, the `pty_*` group
 * and the `agent.*` broadcasts. So we are no longer consuming an entirely
 * undocumented surface; we are consuming a partly documented one, and the parts
 * we lean on hardest are the undocumented parts. **Pinning is how we pay for
 * that**, and it is our safety mechanism regardless of what they promise: see
 * {@link CRABCAST_PIN}.
 *
 * ## What this file may and may not know
 *
 * Everything here was derived by driving a real CrabCast daemon and reading
 * what came back on the wire. **No CrabCast source was read** — that is a human
 * decision of 2026-08-08 and it is not lifted. Where a claim about their
 * behaviour appears in a comment, it is a claim about an observation, and the
 * observation is reproducible with `daemon/scripts/verify-crabcast-runtime.mjs`.
 */
/**
 * The CrabCast commit this adapter was built and proved against.
 *
 * **Not a version check and deliberately not enforced as one.** CrabCast has
 * decided **no compatibility guarantee below 1.0** (their KAN-277, landed at
 * `fe9ec80`). What they offer instead is a *notice* promise — a documented
 * read-path field will not change without a consumer notice on KAN-39. That
 * promise explicitly does **not** cover: fields not changing, backward
 * compatibility, a deprecation period, or the notice arriving before we have
 * already pulled.
 *
 * So this constant is recorded, reported by {@link CrabCastLink.describe}, and
 * compared against `daemon_status.build.commit` at connect time — a **mismatch
 * is logged, never fatal**. Refusing to run against a different build would be
 * this daemon pressuring their release cadence, which is the one thing KAN-278
 * forbids outright.
 */
export const CRABCAST_PIN = '8d7348fa98201b61642d2454b3a797373361128a';
/**
 * `daemon_status.contractVersion` this adapter was proved against (KAN-294,
 * moved 3 → 4 by KAN-324).
 *
 * CrabCast's read-path contract (their KAN-277, `fe9ec80`) puts a version on the
 * wire and documents `list_agents` and `agent_status` field by field. It was
 * `3` at {@link CRABCAST_PIN} — read off a real daemon at that build, not off
 * their notice.
 *
 * ## Why this is 4, and what "proved against" had to mean to move it
 *
 * v4 is **mechanically additive**: one new row shape (`UnreadableRecord`) and
 * two new fields — `unreadableRecords` and `unreadableRecordsTotal` — on
 * `list_agents` and `daemon_status`. Nothing changed meaning or type, nothing
 * was removed, and `agent_status` is untouched. A consumer ignoring both fields
 * reads exactly what it read at v3 and is not *wrong*.
 *
 * **It is not therefore neutral for us**, which is the whole of KAN-324. Their
 * KAN-302 changed a registry row this daemon cannot read from *refuse to start*
 * into *start and skip*, so at v3 `list_agents` cannot distinguish a fully-read
 * registry from a silently short one: `agents: []` with one row skipped is
 * byte-for-byte what an empty registry reads. Measured on this machine at the
 * bump, against a peer at `6258ded`: `configuredAgents: 0, expectedAgents: 0,
 * unreadableRecordsTotal: 1`.
 *
 * So this number was moved **only after the census started reading both new
 * fields** — {@link CrabCastRuntime.readCensus} — and the move is proved by
 * `daemon/scripts/verify-crabcast-census-disclosure.mjs`, which exercises the
 * fields rather than asserting the constant. **A version constant bumped
 * without reading the new fields would reproduce KAN-324 one release later**,
 * with a green check on top: that is the failure this paragraph exists to name,
 * and it is why the proof is named here beside the number.
 *
 * **Recorded and reported, never enforced**, for the same reason the pin is:
 * refusing on a version bump would be Butchr pressuring their release cadence.
 * And it is deliberately not polled — their document says to read it once and
 * re-read when `bootId` moves, which is what {@link CrabCastLink.handshake}
 * does, one read per connection.
 *
 * **What it does NOT cover, stated because the number looks like it covers
 * everything.** The contract holds `list_agents` and `agent_status` only.
 * `activate_response` is outside it — CrabCast disclosed that themselves, and
 * their KAN-287 is the ticket to close it. So a field we read from
 * `activate_response` is uncontracted: it can change without moving this
 * number and without going red in their CI. {@link CrabCastRuntime} reads
 * `channelEnabled` from exactly there, and says so at its own call site.
 */
export const CRABCAST_CONTRACT_VERSION = 4;
/** Where a stock CrabCast puts its socket, per its own README. */
export function defaultCrabCastSocket() {
    return path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');
}
/** Renders a refusal as the one-line string an `error` field carries. */
export function renderRefusal(r) {
    return (`refused by ${r.leg}: ${r.headline}. ` +
        `socket ${r.socketPath}; errno ${r.errno ?? 'none'}; ` +
        `${r.attempts} connection attempt(s) over ${Math.round(r.downForMs / 100) / 10}s; ` +
        `last good ${r.lastGoodAt ?? 'never — this link has never connected'}. ` +
        `${r.remedy}`);
}
/**
 * One connection to CrabCast, with the frame demultiplexer wired **before** any
 * request is ever written.
 *
 * That ordering is not stylistic. It is the single rule KAN-224 §3.3 identifies
 * as the whole of the gap problem on our side: register the `pty_output`
 * handler after awaiting `pty_init_response` and every frame that arrives in
 * between is silently dropped — deterministically under load, and never when
 * you test it by hand. Here the reader is installed in {@link connect} before
 * the socket is even writable, and subscriptions are registered by `sessionId`
 * into {@link ptyHandlers} *before* the `pty_init` request goes out
 * ({@link ptyInit}).
 */
export class CrabCastLink {
    socket = null;
    buffer = '';
    nextId = 1;
    pending = new Map();
    ptyHandlers = new Map();
    eventHandlers = new Set();
    connecting = false;
    closed = false;
    attempts = 0;
    lastErrno = null;
    lastGoodAt = null;
    downSince = Date.now();
    reconnectTimer = null;
    /** `daemon_status.build.commit`, once observed. Null until then. */
    peerCommit = null;
    /**
     * `daemon_status.contractVersion`, once observed. Null until then, and null
     * against a peer too old to publish one — which is a real state rather than a
     * hypothetical: it did not exist before their `fe9ec80`.
     */
    peerContractVersion = null;
    socketPath;
    requestTimeoutMs;
    reconnectDelayMs;
    log;
    constructor(options) {
        this.socketPath = options.socketPath;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
        this.log = options.log ?? ((m) => console.log(`[crabcast] ${m}`));
    }
    get connected() {
        return this.socket !== null && !this.socket.destroyed;
    }
    get observedPeerCommit() {
        return this.peerCommit;
    }
    get observedContractVersion() {
        return this.peerContractVersion;
    }
    /**
     * The refusal this link would produce right now.
     *
     * Built even when the link is healthy, because a caller that wants to explain
     * *why* it is refusing something else should not have to reconstruct the
     * figures.
     */
    refusal(leg, headline, remedy) {
        return {
            leg,
            headline,
            socketPath: this.socketPath,
            errno: this.lastErrno,
            attempts: this.attempts,
            downForMs: this.connected ? 0 : Date.now() - this.downSince,
            lastGoodAt: this.lastGoodAt ? this.lastGoodAt.toISOString() : null,
            remedy: remedy ??
                'Start a CrabCast daemon addressing that socket (any of `crabcast configure|activate|' +
                    'deactivate|forget|send` spawns one), or unset BUTCHR_AGENT_RUNTIME to serve from ' +
                    'HerdrBridge, which needs no peer.'
        };
    }
    /** The standing refusal for "there is no connection", with its figures. */
    unreachable() {
        return this.refusal('crabcast-socket', this.lastErrno === null
            ? 'no connection to the CrabCast daemon has been established yet'
            : `the CrabCast daemon socket refused the connection (${this.lastErrno})`);
    }
    connect() {
        if (this.closed || this.connecting || this.connected)
            return;
        this.connecting = true;
        this.attempts++;
        const socket = net.createConnection(this.socketPath);
        // The demux is installed here, before the socket is writable and therefore
        // before any request of ours can have been sent. KAN-224 §3.3.
        socket.on('data', (chunk) => this.onData(String(chunk)));
        socket.on('connect', () => {
            this.connecting = false;
            this.socket = socket;
            this.lastErrno = null;
            this.log(`connected to ${this.socketPath}`);
            void this.handshake();
        });
        socket.on('error', (err) => {
            this.connecting = false;
            this.lastErrno = err.code ?? err.message;
            if (this.socket === socket)
                this.socket = null;
            this.scheduleReconnect();
        });
        socket.on('close', () => {
            this.connecting = false;
            if (this.socket === socket) {
                this.socket = null;
                this.downSince = Date.now();
                this.log('connection closed');
            }
            // Every in-flight request dies with the socket, and each is told which
            // leg killed it rather than timing out anonymously.
            for (const [id, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(renderRefusal(this.refusal('crabcast-socket', 'the connection closed while this request was in flight'))));
                this.pending.delete(id);
            }
            // A dropped socket takes CrabCast's own pty subscriptions with it, so
            // every mirror is stale. Owners re-subscribe; see CrabCastRuntime.
            this.scheduleReconnect();
        });
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);
        // Never hold the process open just to retry a peer that may not exist.
        this.reconnectTimer.unref?.();
    }
    /**
     * Read the peer's identity once per connection.
     *
     * **Two identifiers now, and this is the once-per-connection read their own
     * document asks for.** `build.commit` is the build; `contractVersion` is the
     * read-path contract, which landed in their KAN-277 (`fe9ec80`) after this
     * method was written — the docblock here used to say it "has not landed", and
     * it has. Their guidance is to read it once and re-read when `bootId` moves
     * rather than per poll; a reconnect is exactly when `bootId` may have moved,
     * and this runs once per connection, so that is satisfied by construction
     * rather than by a timer.
     *
     * Both are reported, neither is enforced (see {@link CRABCAST_PIN}).
     */
    async handshake() {
        try {
            const status = await this.request({ action: 'daemon_status' });
            const build = status.build;
            this.peerCommit = build?.commit ?? null;
            // Absent on a peer older than their fe9ec80, and absent is null rather
            // than 0 — "this daemon publishes no contract version" is not "version
            // zero", and the difference is the same one channelEnabled makes below.
            this.peerContractVersion =
                typeof status.contractVersion === 'number' ? status.contractVersion : null;
            if (this.peerContractVersion !== null &&
                this.peerContractVersion !== CRABCAST_CONTRACT_VERSION) {
                this.log(`peer publishes read-path contract v${this.peerContractVersion}, this adapter was ` +
                    `proved against v${CRABCAST_CONTRACT_VERSION}. Reporting, not refusing — and note ` +
                    `the contract covers list_agents and agent_status only, so a matching version is ` +
                    `not a statement about activate_response.`);
            }
            if (this.peerCommit && this.peerCommit !== CRABCAST_PIN) {
                this.log(`peer is CrabCast ${this.peerCommit.slice(0, 12)}, this adapter was proved against ` +
                    `${CRABCAST_PIN.slice(0, 12)}. Reporting, not refusing: CrabCast gives no ` +
                    `compatibility guarantee below 1.0, and refusing here would be Butchr pressuring ` +
                    `their release cadence.`);
            }
        }
        catch (err) {
            this.log(`handshake failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    onData(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (!line.trim())
                continue;
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                this.log(`dropping unparseable frame (${line.length} chars)`);
                continue;
            }
            this.dispatch(frame);
        }
    }
    /**
     * Three kinds of frame arrive here, and telling them apart is the whole job.
     *
     * - A **response** carries the `id` we sent. Correlate and resolve.
     * - **`pty_output`** carries no `id` at all — verified on the wire, and it is
     *   deliberate on CrabCast's side: streamed output must not carry the
     *   `pty_init` id or a correlating transport would try to answer a request
     *   that is already closed. So it is routed by `sessionId`.
     * - An **`agent.*` event** is a broadcast, carrying `at`/`seq`/`bootId` and no
     *   `id`. Verified by holding an idle connection open and deactivating an
     *   agent from a second one: `agent.deactivated` and `agent.detached` both
     *   arrived unasked.
     */
    dispatch(frame) {
        const id = typeof frame.id === 'string' ? frame.id : null;
        if (id && this.pending.has(id)) {
            const p = this.pending.get(id);
            clearTimeout(p.timer);
            this.pending.delete(id);
            p.resolve(frame);
            return;
        }
        const action = typeof frame.action === 'string' ? frame.action : '';
        if (action === 'pty_output') {
            const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
            const data = typeof frame.data === 'string' ? frame.data : '';
            const handler = this.ptyHandlers.get(sessionId);
            if (handler)
                handler(data);
            // No handler means we are not mirroring that session. Dropping is
            // correct — CrabCast streams to the connection that asked, and a session
            // we stopped mirroring is one nobody is rendering.
            return;
        }
        if (action.startsWith('agent.')) {
            for (const handler of this.eventHandlers)
                handler(frame);
            return;
        }
        // An unsolicited frame that is neither. Say so rather than swallow it:
        // CrabCast may add frames, and a consumer that silently drops them learns
        // nothing when it starts mattering.
        if (!id)
            this.log(`unrouted frame: ${action || '(no action)'}`);
    }
    /** Subscribe to `agent.*` broadcasts. Returns an unsubscribe function. */
    onEvent(handler) {
        this.eventHandlers.add(handler);
        return () => this.eventHandlers.delete(handler);
    }
    /**
     * One request, correlated by id.
     *
     * Rejects rather than resolving `{success:false}` when the *link* could not
     * carry it, because those are different claims: a rejection here is "we could
     * not ask", and CrabCast answering `success:false` is "we asked and it said
     * no". Collapsing the two is the failure CrabCast's north star 2 and Butchr's
     * `tailAgent` docblock both exist to prevent.
     */
    request(body) {
        if (!this.connected) {
            this.connect();
            return Promise.reject(new Error(renderRefusal(this.unreachable())));
        }
        const id = `butchr-${process.pid}-${this.nextId++}`;
        const frame = { ...body, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(renderRefusal(this.refusal('crabcast-daemon', `no answer to \`${String(body.action)}\` within ${this.requestTimeoutMs}ms`, 'Check the CrabCast daemon is healthy (`crabcast daemon-status`); it accepted the ' +
                    'connection but did not answer.'))));
            }, this.requestTimeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.socket.write(JSON.stringify(frame) + '\n');
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            this.lastGoodAt = new Date();
        });
    }
    /**
     * `pty_init` with the subscription registered **first**.
     *
     * The ordering is the point of the method existing at all — see the class
     * docblock and KAN-224 §3.3. Everything else about the join is structural:
     * the returned `buffer` **replaces** the mirror and is never fanned out to
     * listeners, while `pty_output.data` is appended **and** fanned out. Those
     * are two destinations with no overlap, so there is nothing to deduplicate
     * and no deduplication logic to get wrong.
     */
    async ptyInit(sessionId, onOutput) {
        this.ptyHandlers.set(sessionId, onOutput);
        try {
            const res = await this.request({ action: 'pty_init', sessionId });
            if (res.success !== true) {
                throw new Error(renderRefusal(this.refusal('crabcast-daemon', `pty_init refused: ${String(res.error ?? 'no reason given')}`)));
            }
            return { buffer: typeof res.buffer === 'string' ? res.buffer : '' };
        }
        catch (err) {
            this.ptyHandlers.delete(sessionId);
            throw err;
        }
    }
    /**
     * Drop a pty subscription locally.
     *
     * **CrabCast has no detach verb** — verified against the running daemon:
     * `pty_close` and `attach_pty` both answer `Unknown action`, and the dispatch
     * accepts exactly `pty_init`, `pty_input`, `pty_resize`. Their stream ends
     * when the connection closes or when a fresh `pty_init` replaces the
     * listener. Under this design that costs nothing, because the per-caller
     * disposer is a local array filter and the cross-process subscription is per
     * *session* rather than per *caller* (KAN-224 §3.4). Dropping the handler
     * means later frames for this session hit the "no handler" branch above.
     */
    releasePty(sessionId) {
        this.ptyHandlers.delete(sessionId);
    }
    /** Session ids we currently mirror — used to re-subscribe after a reconnect. */
    subscribedSessions() {
        return [...this.ptyHandlers.keys()];
    }
    close() {
        this.closed = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.socket?.destroy();
        this.socket = null;
    }
    /** Everything an operator needs to see about this link, for the report. */
    describe() {
        return {
            socketPath: this.socketPath,
            connected: this.connected,
            pinnedCommit: CRABCAST_PIN,
            peerCommit: this.peerCommit,
            peerMatchesPin: this.peerCommit === null ? null : this.peerCommit === CRABCAST_PIN,
            pinnedContractVersion: CRABCAST_CONTRACT_VERSION,
            // Null when unobserved AND when the peer publishes none. Not folded into
            // the pinned value: an absent contract version is not a matching one.
            peerContractVersion: this.peerContractVersion,
            attempts: this.attempts,
            lastErrno: this.lastErrno,
            lastGoodAt: this.lastGoodAt ? this.lastGoodAt.toISOString() : null
        };
    }
}
