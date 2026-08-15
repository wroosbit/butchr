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
 * moved 3 → 4 by KAN-324, 4 → 7 then 7 → 8 by KAN-357).
 *
 * CrabCast's read-path contract (their KAN-277, `fe9ec80`) puts a version on the
 * wire and documents `list_agents` and `agent_status` field by field. It was
 * `3` at {@link CRABCAST_PIN} — read off a real daemon at that build, not off
 * their notice.
 *
 * ## Why this is 8, and what "proved against" had to mean to move it
 *
 * v7 is **mechanically additive**, exactly as v4 was: three fields on the
 * existing `UnreadableRecord` row — `claimsAt`, `claimsEvent` and `standing` —
 * and a new closed vocabulary, `rowStanding`. Nothing changed meaning or type,
 * nothing was removed, and no behaviour changed: the same rows are skipped,
 * disclosed and carried across compaction as at v4. A consumer ignoring all
 * three reads exactly what it read at v6 and is not *wrong*.
 *
 * **It is not therefore neutral for us**, and that sentence is this constant's
 * own history rather than a principle borrowed from somewhere. *"Additive, you
 * need not move"* is what preceded KAN-324 by one release. What v7 answers is a
 * question we asked the wire and could not get an answer to:
 * `unreadableRecordsTotal` has read **1** on this machine since 2026-08-03 — a
 * tombstone their KAN-302 preserves on purpose — and nothing on the wire could
 * say whether that `1` was transient or permanent. **A genuinely lost agent
 * arrives as a `2` where the `1` has become background noise**, so a number
 * nobody can act on becomes a branch only once `standing` distinguishes a
 * retired row from one claiming an agent.
 *
 * So this number was moved **only after the census started reading the new
 * fields** — {@link readUnreadableDisclosure} — and never as a number on its
 * own. **A version constant bumped without reading the new fields would
 * reproduce KAN-324 one release later**, with a green check on top.
 *
 * ## Why 8 and not 7, and what v8 actually changed
 *
 * **This read `7` from 2026-08-13 to 2026-08-14, and the paragraph here said no
 * live peer had ever served those fields. That is no longer true**, and the
 * sentence is replaced rather than softened: `epic/KAN-203` deployed CrabCast
 * on the human's authorisation, the peer went **6 → 8 in one step**, and the v7
 * fields arrived on the wire for the first time. Pinning `7` afterwards would
 * pin to a version nobody serves.
 *
 * **v8's whole delta is to `capacity`** — `measuredTreesSeen` added, and
 * `measuredAgentTrees` narrowed in *population* rather than in type. **The
 * `UnreadableRecord` row shape and the `rowStanding` vocabulary are
 * byte-identical between v7 and v8**, established by diffing their published
 * contract at `a520c763` against their `main`, not by reading their source and
 * not by taking a summary. So the surface this adapter consumes did not move.
 *
 * **We read no `capacity` field off their wire, and that is asserted rather
 * than claimed** — `verify-crabcast-standing.mjs` §5 checks that nothing
 * v8-shaped reaches the census reading, because it is the fact that licensed
 * moving this number. **Beware the name collision:** Butchr has its *own*
 * `measuredAgentTrees` on `list_agents_response`, computed by `capacity.ts`
 * from this machine and unrelated to theirs. A reader who greps the name after
 * reading their v8 notice will find ours and may "correct" it to match. Do not:
 * ours narrowed independently at KAN-276, for the same reason theirs did, which
 * is what makes the collision so easy to mistake for a shared field.
 *
 * ## What IS and is NOT proved against a real wire
 *
 * **Proved:** the refusal below the door (against the committed v6 capture, and
 * against the live v6 peer while it existed), and the reading above it — a real
 * peer's `standing`, `claimsAt` and `claimsEvent`, off bytes CrabCast sent.
 * **The live tombstone reads `retired`**, so the permanently-`1` count that
 * commissioned KAN-324 and KAN-357 is answered: it is a retired row, not a lost
 * agent, and the verdict is checkable against its own `claimsEvent`.
 *
 * **Not proved:** the `claims-an-agent` and `matched` arms. No real wire has
 * ever carried them — there is one unreadable row on this machine and it is a
 * tombstone — so the branch this work exists to *enable* is exercised against
 * constructed frames only. That needs a registry fault nobody can schedule, and
 * it is named in the proof's header rather than left to be discovered from a
 * green run.
 *
 * See `CRABCAST_STANDING_MIN_VERSION` in `crabcast-runtime.ts` for why the gate
 * is a separate constant from this one: it is a **floor**, so v8 opens the door
 * that v7 unlocked. Deriving the gate from this number would have slammed it
 * shut at the deploy.
 *
 * **Recorded and reported, never enforced**, for the same reason the pin is:
 * refusing on a version bump would be Butchr pressuring their release cadence.
 * The v7 gate is not an exception to that — it refuses **one field**, not the
 * connection, and a peer below 7 is served in every other respect exactly as it
 * was. And this is deliberately not polled: their document says to read it once
 * and re-read when `bootId` moves, which is what {@link CrabCastLink.handshake}
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
export const CRABCAST_CONTRACT_VERSION = 8;

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

/**
 * A transition of the connection itself, announced to whoever owns state that
 * the connection carries (KAN-381).
 *
 * **This exists because a reconnect restores the link and not the things built
 * on it.** CrabCast's pty subscriptions belong to a connection: when the socket
 * goes, they go, and the next socket starts with none. Nothing about
 * `connected` returning true again says the mirrors are live, so the owner of
 * those mirrors has to be *told* rather than left to poll a boolean that has
 * already gone back to what it was before.
 *
 * A discriminated union rather than a boolean and a timestamp: `at` means the
 * drop on one arm and the connect on the other, and a single flat shape is
 * where a reader takes the second for the first.
 */
export type LinkStateEvent =
  | {
      state: 'connected';
      /** `Date.now()` at the moment the socket became usable. */
      at: number;
      /** 1 for the first connection this link ever made. */
      connectionSeq: number;
    }
  | {
      state: 'disconnected';
      /** `Date.now()` at the moment the socket closed. */
      at: number;
      /** The connection that just ended. */
      connectionSeq: number;
      /** Node's errno where one was recorded, else null. */
      errno: string | null;
    };

/**
 * What the handshake on a new connection can say about **which peer answered**
 * (KAN-403).
 *
 * A closed vocabulary rather than a boolean, because there are four answers and
 * two of them are kinds of *not knowing* — and the two differ in a way a reader
 * acts on. `unknown` is a peer that publishes no `bootId` at all, which is a
 * real state rather than a hypothetical: `bootId` is outside CrabCast's
 * read-path contract, so a build may simply not carry it.
 * `first-connection` is a peer that published one and had nothing to be
 * compared against. Folding either into `false` would say *"the peer did not
 * restart"* on the strength of never having looked, which is the collapse
 * {@link readChannelEnabled} exists to prevent one field over.
 *
 * **`restarted` is the only value that licenses acting**, and what it licenses
 * is disclosure rather than repair — see `CrabCastRuntime`'s reconnect resync
 * for why the repair deliberately does not key on this.
 */
export type PeerIdentity =
  /** `bootId` moved between this connection and the previous one. */
  | 'restarted'
  /** `bootId` is the same one the previous connection read. */
  | 'same-peer'
  /** A `bootId` was read, and there was no earlier one to compare it against. */
  | 'first-connection'
  /** No `bootId` was read at all — the peer publishes none, or the handshake failed. */
  | 'unknown';

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
  private readonly linkStateHandlers = new Set<(event: LinkStateEvent) => void>();

  /** How many connections this link has made. 0 until the first one lands. */
  private connectionSeq = 0;

  private connecting = false;
  private closed = false;
  private attempts = 0;
  private lastErrno: string | null = null;
  private lastGoodAt: Date | null = null;
  private downSince = Date.now();
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** `daemon_status.build.commit`, once observed. Null until then. */
  private peerCommit: string | null = null;

  /**
   * `daemon_status.contractVersion`, once observed. Null until then, and null
   * against a peer too old to publish one — which is a real state rather than a
   * hypothetical: it did not exist before their `fe9ec80`.
   */
  private peerContractVersion: number | null = null;

  /**
   * `daemon_status.bootId` for the connection currently held. Null until read.
   *
   * **This is the identifier that actually moves when a peer restarts, and it
   * was the one this link did not read** (KAN-403). Measured against a real
   * restart of a real CrabCast: `bootId` moved, `build.commit` and
   * `contractVersion` did not — the peer was the same installed binary, which is
   * what a redeploy of an unchanged build looks like and what every restart
   * looks like to the two identifiers the handshake read before this ticket.
   */
  private peerBootId: string | null = null;

  /** The `bootId` the PREVIOUS connection read, or null if there was none. */
  private previousPeerBootId: string | null = null;

  private peerIdentityVerdict: PeerIdentity = 'unknown';

  /**
   * Settles when the current connection's handshake has finished, whichever way
   * it went.
   *
   * **This exists so that a consumer can wait for the identity without the
   * `connected` event having to.** That event is emitted before the handshake
   * deliberately (see {@link connect}), so anything reading
   * {@link observedPeerIdentity} straight off it would race a round trip and
   * read the *previous* connection's verdict — which is the reassuring answer,
   * `same-peer`, exactly when it is wrong.
   */
  private handshakeSettled: Promise<PeerIdentity> = Promise.resolve('unknown');
  private settleHandshake: (verdict: PeerIdentity) => void = () => {};

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

  get observedContractVersion(): number | null {
    return this.peerContractVersion;
  }

  get observedPeerBootId(): string | null {
    return this.peerBootId;
  }

  /**
   * What the last completed handshake concluded about which peer answered.
   *
   * **Read this through {@link peerIdentified} on a reconnect path**, not
   * directly: straight off the `connected` event it still holds the previous
   * connection's verdict.
   */
  get observedPeerIdentity(): PeerIdentity {
    return this.peerIdentityVerdict;
  }

  /**
   * The current connection's identity verdict, once its handshake has settled.
   *
   * Bounded by the handshake's own request timeout rather than by a timer here:
   * a `daemon_status` that never answers rejects inside {@link request}, and the
   * catch in {@link handshake} settles this with `unknown`. So this never hangs
   * longer than one request, and its failure mode is the honest verdict rather
   * than a hang.
   */
  peerIdentified(): Promise<PeerIdentity> {
    return this.handshakeSettled;
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
      this.connectionSeq++;
      this.log(`connected to ${this.socketPath} (connection #${this.connectionSeq})`);
      // The identity promise is armed HERE, before the state is announced, so a
      // link-state handler that calls `peerIdentified()` synchronously gets THIS
      // connection's verdict rather than the previous one's (KAN-403). Arming it
      // inside `handshake()` would leave a window in which the old promise —
      // already resolved, with the old answer — is what a handler receives.
      this.handshakeSettled = new Promise<PeerIdentity>((resolve) => {
        this.settleHandshake = resolve;
      });
      // Announced BEFORE the handshake is awaited, deliberately. The handshake
      // is a round trip; a mirror owner that waited for it would leave its
      // subscription down for the length of one, and the frames CrabCast sends
      // in that window would be lost with nothing recording that they were.
      // Nothing the handshake reads is needed to re-subscribe.
      this.emitLinkState({ state: 'connected', at: Date.now(), connectionSeq: this.connectionSeq });
      void this.handshake();
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.connecting = false;
      this.lastErrno = err.code ?? err.message;
      // **`this.socket` is deliberately NOT cleared here** (KAN-381). It used
      // to be, and that quietly stole the disconnect notice from the one path
      // most likely to produce it: node always follows `error` with `close`, so
      // clearing the reference here made `close`'s "was this the current
      // connection?" test answer *no* for every ECONNRESET, and the mirrors
      // that connection carried were never marked stale. A peer that dies
      // rather than closing politely is the ordinary case, so the hole was in
      // the common path rather than an exotic one. `close` owns the teardown;
      // this handler owns the errno. An errored socket is already destroyed, so
      // `connected` answers false in the window between the two events.
      this.scheduleReconnect();
    });

    socket.on('close', () => {
      this.connecting = false;
      const wasCurrent = this.socket === socket;
      if (wasCurrent) {
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
      // every mirror is stale. **This is where the owner is told** — until
      // KAN-381 the comment said "owners re-subscribe" and no owner was ever
      // informed, so nothing did. The handlers in `ptyHandlers` are kept: they
      // are what `subscribedSessions` reads to say which mirrors the drop
      // invalidated, and a re-subscribe replaces the entry rather than needing
      // a fresh one.
      if (wasCurrent) {
        this.emitLinkState({
          state: 'disconnected',
          at: this.downSince,
          connectionSeq: this.connectionSeq,
          errno: this.lastErrno
        });
      }
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
  private async handshake(): Promise<void> {
    try {
      const status = await this.request({ action: 'daemon_status' });
      const build = status.build as { commit?: string } | undefined;
      this.peerCommit = build?.commit ?? null;
      // **`bootId` is read here and nowhere else, which is what makes the
      // comparison below meaningful** (KAN-403). CrabCast's own guidance is to
      // read their identity once and re-read it when `bootId` moves; this method
      // already ran once per connection, so the re-read was in place and the
      // value that says whether it moved was the one field not being kept.
      //
      // Carried BEFORE the new value overwrites it, so `previousPeerBootId` is
      // the previous CONNECTION's reading rather than this one's.
      const previous = this.peerBootId;
      const current = typeof status.bootId === 'string' ? status.bootId : null;
      this.previousPeerBootId = previous;
      this.peerBootId = current;
      this.peerIdentityVerdict =
        current === null
          ? 'unknown'
          : previous === null
            ? 'first-connection'
            : current === previous
              ? 'same-peer'
              : 'restarted';
      if (current !== null && previous !== null && this.peerIdentityVerdict === 'restarted') {
        this.log(
          `peer bootId moved ${previous.slice(0, 8)} → ${current.slice(0, 8)}: ` +
            `this reconnect is a peer RESTART, not a socket blip. Every session id the previous ` +
            `daemon issued is dead — see CrabCastRuntime's resync, which re-resolves rather than ` +
            `retrying them.`
        );
      }
      // Absent on a peer older than their fe9ec80, and absent is null rather
      // than 0 — "this daemon publishes no contract version" is not "version
      // zero", and the difference is the same one channelEnabled makes below.
      this.peerContractVersion =
        typeof status.contractVersion === 'number' ? status.contractVersion : null;
      if (
        this.peerContractVersion !== null &&
        this.peerContractVersion !== CRABCAST_CONTRACT_VERSION
      ) {
        this.log(
          `peer publishes read-path contract v${this.peerContractVersion}, this adapter was ` +
            `proved against v${CRABCAST_CONTRACT_VERSION}. Reporting, not refusing — and note ` +
            `the contract covers list_agents and agent_status only, so a matching version is ` +
            `not a statement about activate_response.`
        );
      }
      if (this.peerCommit && this.peerCommit !== CRABCAST_PIN) {
        this.log(
          `peer is CrabCast ${this.peerCommit.slice(0, 12)}, this adapter was proved against ` +
            `${CRABCAST_PIN.slice(0, 12)}. Reporting, not refusing: CrabCast gives no ` +
            `compatibility guarantee below 1.0, and refusing here would be Butchr pressuring ` +
            `their release cadence.`
        );
      }
    } catch (err) {
      // A handshake that could not complete read no `bootId`, so it knows
      // nothing about which peer answered. `unknown` rather than leaving the
      // PREVIOUS connection's verdict standing, which would be a stale answer
      // wearing a fresh one's clothes.
      this.peerIdentityVerdict = 'unknown';
      this.log(`handshake failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Settled on both arms. A waiter that is never resolved is a resync that
      // never runs, which is a worse outcome than an honest `unknown`.
      this.settleHandshake(this.peerIdentityVerdict);
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
   * Subscribe to connection transitions. Returns an unsubscribe function.
   *
   * **A handler that throws must not take the link down with it**, so each is
   * called inside its own try. A mirror owner failing to re-subscribe one
   * session is a bad outcome for that session; it is not a reason for the other
   * handlers to go unnotified, and it is certainly not a reason to unwind
   * through a socket event.
   */
  onLinkState(handler: (event: LinkStateEvent) => void): () => void {
    this.linkStateHandlers.add(handler);
    return () => this.linkStateHandlers.delete(handler);
  }

  private emitLinkState(event: LinkStateEvent): void {
    for (const handler of this.linkStateHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.log(
          `a link-state handler threw on ${event.state}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
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

  /**
   * CrabCast session ids we currently mirror.
   *
   * **This existed and was called from nowhere until KAN-381**, which is the
   * fossil of the gap that ticket closed: the accessor for re-subscribing after
   * a reconnect was written, the comment on the `close` handler said owners
   * would use it, and no owner was ever told a reconnect had happened. It is
   * read now by `CrabCastRuntime`'s link-state handler.
   */
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
    pinnedContractVersion: number;
    peerContractVersion: number | null;
    /**
     * The peer's `bootId` on the connection currently held (KAN-403).
     *
     * **This is the only field on this report that moves when a peer restarts.**
     * `peerCommit` does not: measured against a real restart, the commit was
     * byte-identical across it, because a restart of the same build is the
     * ordinary case and a redeploy that ships no new code is indistinguishable
     * from one that ships none.
     */
    peerBootId: string | null;
    /**
     * What the last completed handshake concluded about which peer answered.
     *
     * `restarted` beside `connections > 1` is the deploy case: the link is
     * healthy and every session id issued by the previous daemon is dead.
     */
    peerIdentity: PeerIdentity;
    attempts: number;
    /**
     * Connections made. **`> 1` means this link has reconnected**, which is the
     * one figure that distinguishes a link that has been up since boot from one
     * that has been up since a drop — and those two answer `connected: true`
     * identically (KAN-381).
     */
    connections: number;
    lastErrno: string | null;
    lastGoodAt: string | null;
  } {
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
      peerBootId: this.peerBootId,
      peerIdentity: this.peerIdentityVerdict,
      attempts: this.attempts,
      connections: this.connectionSeq,
      lastErrno: this.lastErrno,
      lastGoodAt: this.lastGoodAt ? this.lastGoodAt.toISOString() : null
    };
  }
}
