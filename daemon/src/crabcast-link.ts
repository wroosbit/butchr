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
 *    `7c6d97f` lists ten commands — configure, activate, deactivate, forget,
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
 * `--json` mode that promises to print the daemon's answer verbatim. The socket
 * frames are *not yet* published — that is exactly what their KAN-277 is
 * building, and it is In Progress rather than landed. So we are consuming a
 * surface whose contract is still being written. **Pinning is how we pay for
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
 * decided **no compatibility guarantee below 1.0** (their KAN-277, In Progress
 * at the time of writing, confirmed by reading that ticket rather than by
 * relay). What they offer instead is a *notice* promise — a documented
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
export const CRABCAST_PIN = '7c6d97fff1010f18a3b0afb506e3a28d72873f79';

/** Where a stock CrabCast puts its socket, per its own README. */
export function defaultCrabCastSocket(): string {
  return path.join(os.homedir(), '.local', 'share', 'crabcast', 'crabcast.sock');
}

/**
 * Why a call could not be served, with the arithmetic a reader can reproduce.
 *
 * Both projects' north stars require the same thing of a refusal and neither is
 * satisfied by "could not connect": Butchr's, that `success: false` is a claim
 * about the read rather than about the world; CrabCast's, that a refusal says
 * why in figures headlined by the constraint that actually bound. The field
 * that does the work here is {@link leg} — **a refusal names the leg that
 * refused it**, so an operator is never left deciding whether Butchr, the
 * socket, CrabCast or herdr said no.
 */
export interface CrabCastRefusal {
  /** Which hop produced this answer. The headline of any rendering. */
  leg: 'butchr-adapter' | 'crabcast-socket' | 'crabcast-daemon';
  /** One clause naming the binding constraint. */
  headline: string;
  socketPath: string;
  /** Node's own errno where the socket refused, e.g. ENOENT / ECONNREFUSED. */
  errno: string | null;
  /** Connection attempts made since this link last held a connection. */
  attempts: number;
  /** Milliseconds since the link last had a working connection, or since boot. */
  downForMs: number;
  /** When the link last completed a request, or null if it never has. */
  lastGoodAt: string | null;
  /** What an operator should do about it. */
  remedy: string;
}

/** Renders a refusal as the one-line string an `error` field carries. */
export function renderRefusal(r: CrabCastRefusal): string {
  return (
    `refused by ${r.leg}: ${r.headline}. ` +
    `socket ${r.socketPath}; errno ${r.errno ?? 'none'}; ` +
    `${r.attempts} connection attempt(s) over ${Math.round(r.downForMs / 100) / 10}s; ` +
    `last good ${r.lastGoodAt ?? 'never — this link has never connected'}. ` +
    `${r.remedy}`
  );
}

type Pending = {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface CrabCastLinkOptions {
  socketPath: string;
  /** Per-request ceiling, so a wedged CrabCast cannot hang this daemon. */
  requestTimeoutMs?: number;
  /** Delay between reconnection attempts. */
  reconnectDelayMs?: number;
  log?: (message: string) => void;
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
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly ptyHandlers = new Map<string, (data: string) => void>();
  private readonly eventHandlers = new Set<(frame: Record<string, unknown>) => void>();

  private connecting = false;
  private closed = false;
  private attempts = 0;
  private lastErrno: string | null = null;
  private lastGoodAt: Date | null = null;
  private downSince = Date.now();
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** `daemon_status.build.commit`, once observed. Null until then. */
  private peerCommit: string | null = null;

  readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly log: (message: string) => void;

  constructor(options: CrabCastLinkOptions) {
    this.socketPath = options.socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.log = options.log ?? ((m) => console.log(`[crabcast] ${m}`));
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get observedPeerCommit(): string | null {
    return this.peerCommit;
  }

  /**
   * The refusal this link would produce right now.
   *
   * Built even when the link is healthy, because a caller that wants to explain
   * *why* it is refusing something else should not have to reconstruct the
   * figures.
   */
  refusal(leg: CrabCastRefusal['leg'], headline: string, remedy?: string): CrabCastRefusal {
    return {
      leg,
      headline,
      socketPath: this.socketPath,
      errno: this.lastErrno,
      attempts: this.attempts,
      downForMs: this.connected ? 0 : Date.now() - this.downSince,
      lastGoodAt: this.lastGoodAt ? this.lastGoodAt.toISOString() : null,
      remedy:
        remedy ??
        'Start a CrabCast daemon addressing that socket (any of `crabcast configure|activate|' +
          'deactivate|forget|send` spawns one), or unset BUTCHR_AGENT_RUNTIME to serve from ' +
          'HerdrBridge, which needs no peer.'
    };
  }

  /** The standing refusal for "there is no connection", with its figures. */
  unreachable(): CrabCastRefusal {
    return this.refusal(
      'crabcast-socket',
      this.lastErrno === null
        ? 'no connection to the CrabCast daemon has been established yet'
        : `the CrabCast daemon socket refused the connection (${this.lastErrno})`
    );
  }

  connect(): void {
    if (this.closed || this.connecting || this.connected) return;
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

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.connecting = false;
      this.lastErrno = err.code ?? err.message;
      if (this.socket === socket) this.socket = null;
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

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
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
   * `daemon_status.build.commit` is the only build identifier on the wire at
   * the pin — CrabCast's own KAN-277 is deciding where a *contract* version
   * will live, and it has not landed. A mismatch is reported, never enforced
   * (see {@link CRABCAST_PIN}).
   */
  private async handshake(): Promise<void> {
    try {
      const status = await this.request({ action: 'daemon_status' });
      const build = status.build as { commit?: string } | undefined;
      this.peerCommit = build?.commit ?? null;
      if (this.peerCommit && this.peerCommit !== CRABCAST_PIN) {
        this.log(
          `peer is CrabCast ${this.peerCommit.slice(0, 12)}, this adapter was proved against ` +
            `${CRABCAST_PIN.slice(0, 12)}. Reporting, not refusing: CrabCast gives no ` +
            `compatibility guarantee below 1.0, and refusing here would be Butchr pressuring ` +
            `their release cadence.`
        );
      }
    } catch (err) {
      this.log(`handshake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
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
  private dispatch(frame: Record<string, unknown>): void {
    const id = typeof frame.id === 'string' ? frame.id : null;
    if (id && this.pending.has(id)) {
      const p = this.pending.get(id)!;
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
      if (handler) handler(data);
      // No handler means we are not mirroring that session. Dropping is
      // correct — CrabCast streams to the connection that asked, and a session
      // we stopped mirroring is one nobody is rendering.
      return;
    }

    if (action.startsWith('agent.')) {
      for (const handler of this.eventHandlers) handler(frame);
      return;
    }

    // An unsolicited frame that is neither. Say so rather than swallow it:
    // CrabCast may add frames, and a consumer that silently drops them learns
    // nothing when it starts mattering.
    if (!id) this.log(`unrouted frame: ${action || '(no action)'}`);
  }

  /** Subscribe to `agent.*` broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (frame: Record<string, unknown>) => void): () => void {
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
  request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.connected) {
      this.connect();
      return Promise.reject(new Error(renderRefusal(this.unreachable())));
    }
    const id = `butchr-${process.pid}-${this.nextId++}`;
    const frame = { ...body, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            renderRefusal(
              this.refusal(
                'crabcast-daemon',
                `no answer to \`${String(body.action)}\` within ${this.requestTimeoutMs}ms`,
                'Check the CrabCast daemon is healthy (`crabcast daemon-status`); it accepted the ' +
                  'connection but did not answer.'
              )
            )
          )
        );
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.write(JSON.stringify(frame) + '\n');
      } catch (err) {
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
  async ptyInit(
    sessionId: string,
    onOutput: (data: string) => void
  ): Promise<{ buffer: string }> {
    this.ptyHandlers.set(sessionId, onOutput);
    try {
      const res = await this.request({ action: 'pty_init', sessionId });
      if (res.success !== true) {
        throw new Error(
          renderRefusal(
            this.refusal('crabcast-daemon', `pty_init refused: ${String(res.error ?? 'no reason given')}`)
          )
        );
      }
      return { buffer: typeof res.buffer === 'string' ? res.buffer : '' };
    } catch (err) {
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
  releasePty(sessionId: string): void {
    this.ptyHandlers.delete(sessionId);
  }

  /** Session ids we currently mirror — used to re-subscribe after a reconnect. */
  subscribedSessions(): string[] {
    return [...this.ptyHandlers.keys()];
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  /** Everything an operator needs to see about this link, for the report. */
  describe(): {
    socketPath: string;
    connected: boolean;
    pinnedCommit: string;
    peerCommit: string | null;
    peerMatchesPin: boolean | null;
    attempts: number;
    lastErrno: string | null;
    lastGoodAt: string | null;
  } {
    return {
      socketPath: this.socketPath,
      connected: this.connected,
      pinnedCommit: CRABCAST_PIN,
      peerCommit: this.peerCommit,
      peerMatchesPin: this.peerCommit === null ? null : this.peerCommit === CRABCAST_PIN,
      attempts: this.attempts,
      lastErrno: this.lastErrno,
      lastGoodAt: this.lastGoodAt ? this.lastGoodAt.toISOString() : null
    };
  }
}
