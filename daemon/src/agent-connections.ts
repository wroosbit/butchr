import * as net from 'net';
import { renderedKey } from './keys.js';

/**
 * Which agent is on the other end of a daemon connection.
 *
 * WHY THIS MODULE EXISTS (KAN-243, T1 of KAN-150)
 *
 * The daemon has always held its clients in a bare `Set<net.Socket>` and fanned
 * every event out to all of them (`broadcast`, daemon.ts). That is right for
 * fleet events — every client wants `agent_activated_event` — and it is the
 * whole story only for as long as nothing needs to reach *one* agent.
 *
 * `docs/channel-messaging-design.md` §1.3 named the gap: agent identity does
 * reach the daemon, but only *per request*, on the `workspaceType`/`workspaceKey`
 * that `mcp.ts` stamps into each call body. That answers "who is asking"; it
 * never answers "which socket do I write to in order to reach `task/KAN-1`".
 * Broadcasting an addressed message instead is not an acceptable substitute: it
 * puts every private steer into every agent's context and makes the storm
 * guards meaningless, because every send would interrupt the whole fleet.
 *
 * So this is the missing half — a registry of identity → connection, populated
 * by an explicit `hello` and emptied on `close`. It **routes nothing**. KAN-244
 * (T2) is what writes an addressed frame to a connection resolved here.
 *
 * FOUR DECISIONS, STATED HERE RATHER THAN LEFT TO BE DISCOVERED
 *
 * **1. An unidentified connection is ordinary, not an error.** The sidepanel
 * and the Agents page are connections too, and they are emphatically not
 * routable agents (design §1.3). A client that never says `hello` keeps
 * everything it has today — it is answered, it receives every broadcast — and
 * is simply not addressable. Refusing such a connection would break the
 * extension; inventing an identity for it would make the extension routable as
 * an agent, which is exactly what the design forbids.
 *
 * **2. Identity binds only via `hello`, never from a request body.** The
 * sidepanel's `pty_init`/`pty_input` carry the type and key of the agent being
 * *viewed*, not of the viewer. Binding identity from those fields would
 * register the extension as whichever agent a human happened to be looking at,
 * and the first addressed message would go to a browser tab. One explicit
 * announcement, one source (argv), no inference.
 *
 * **3. One agent may hold several connections, and all of them are kept.**
 * Reconnection is routine here — agents are restarted constantly, and the
 * daemon is too. The tempting shape is `Map<address, socket>` with
 * last-write-wins, and it has a specific bug: TCP/unix close is not ordered
 * against a fresh connect, so an agent that reconnects *before* its old
 * socket's `close` fires would have the old socket's cleanup delete the **new**
 * entry, leaving a live agent unaddressable with nothing in any log to say so.
 * Keeping every connection and removing by *socket identity* ({@link release})
 * makes that unrepresentable. {@link resolve} then answers with the **newest
 * live** connection, which after a restart is the session that actually exists.
 *
 * **4. A `hello` is a claim, not authentication, and this does not change the
 * trust boundary.** Anything that can reach the socket can announce any
 * identity — but anything that can reach the socket can already activate,
 * deactivate and type into any agent's terminal. KAN-149 names the socket
 * itself as the boundary, enforced by filesystem permission (`0o700` on
 * BUTCHR_DIR, ipc.ts). Recorded so that nobody later reads this map as an
 * authenticated one.
 */

/** A workspace, as the daemon addresses it. */
export interface AgentAddress {
  type: string;
  key: string;
}

/** One live, identified connection. */
export interface AgentConnection {
  /**
   * Stable id for this connection, so two sockets belonging to one agent are
   * tellable apart by a reader who has no socket object to compare — which is
   * every reader outside this process.
   */
  id: string;
  /** The address as announced, in the spelling the announcer used. */
  address: AgentAddress;
  socket: net.Socket;
  registeredAt: Date;
}

/** What `connected_agents` reports; a shape a diagnostic reader can print. */
export interface AgentConnectionSnapshot {
  type: string;
  /** Rendered for a reader — `kan-243` off a pane name is `KAN-243` on a board. */
  key: string;
  connections: {
    id: string;
    registeredAt: string;
    /** Whether {@link AgentConnectionRegistry.resolve} would pick this one. */
    current: boolean;
  }[];
}

export type RegisterResult =
  | { ok: true; connection: AgentConnection; replaced: AgentConnection | null }
  | { ok: false; error: string };

/** The canonical form two spellings of one agent must collapse to. */
function canonical(address: AgentAddress): string {
  return `${address.type.trim().toLowerCase()}/${address.key.trim().toLowerCase()}`;
}

/**
 * A workspace address off the wire, or `null` when the announcement is not one.
 *
 * Deliberately strict about types: `{ workspaceKey: 42 }` is a malformed
 * announcement, not an agent called `42`. An absent field is the ordinary
 * anonymous case (a human activating from the sidepanel has no identity to
 * announce), and it is `null` here for the same reason `workspaceIdentityFromArgv`
 * yields `undefined` — nothing is invented for it.
 */
export function addressFromAnnouncement(msg: any): AgentAddress | null {
  const type = typeof msg?.workspaceType === 'string' ? msg.workspaceType.trim() : '';
  const key = typeof msg?.workspaceKey === 'string' ? msg.workspaceKey.trim() : '';
  if (!type || !key) return null;
  return { type, key };
}

/** How an address reads in a log line or a diagnostic. */
export function describeAddress(address: AgentAddress): string {
  return `${address.type}/${renderedKey(address.key)}`;
}

export class AgentConnectionRegistry {
  /** Canonical address → its connections, oldest first. */
  private readonly byAddress = new Map<string, AgentConnection[]>();
  /** The reverse index, so `close` can remove without knowing the address. */
  private readonly bySocket = new Map<net.Socket, AgentConnection>();
  private nextId = 0;

  /**
   * Bind an identity to a socket.
   *
   * A second `hello` on a socket that already has one *replaces* its binding
   * rather than adding a second: one socket is one MCP server is one agent, so
   * a socket bound to two identities is a bug wherever it came from, and
   * silently holding both would make `resolve` answer for an agent that is not
   * there.
   */
  public register(socket: net.Socket, address: AgentAddress): RegisterResult {
    if (!address.type || !address.key) {
      return { ok: false, error: 'hello requires both workspaceType and workspaceKey' };
    }

    const replaced = this.release(socket) ?? null;

    const connection: AgentConnection = {
      id: `conn-${++this.nextId}`,
      address: { type: address.type, key: address.key },
      socket,
      registeredAt: new Date()
    };
    const slot = this.byAddress.get(canonical(address));
    if (slot) slot.push(connection);
    else this.byAddress.set(canonical(address), [connection]);
    this.bySocket.set(socket, connection);

    return { ok: true, connection, replaced };
  }

  /**
   * Forget a socket, returning what it was bound to.
   *
   * **By socket, never by address** — that is decision 3 above, and it is the
   * whole reason a reconnect cannot evict the connection that replaced it. An
   * anonymous socket returns `undefined`, which is not a failure: most
   * connections are anonymous and every one of them reaches this on `close`.
   */
  public release(socket: net.Socket): AgentConnection | undefined {
    const connection = this.bySocket.get(socket);
    if (!connection) return undefined;
    this.bySocket.delete(socket);

    const address = canonical(connection.address);
    const slot = this.byAddress.get(address);
    if (slot) {
      const at = slot.indexOf(connection);
      if (at !== -1) slot.splice(at, 1);
      // The key goes when its last connection does. A map that keeps empty
      // arrays around is a map that grows for the lifetime of the daemon and
      // answers "yes, I know that agent" about one that left hours ago.
      if (slot.length === 0) this.byAddress.delete(address);
    }
    return connection;
  }

  /**
   * The connection an addressed message should go to, or `undefined`.
   *
   * Newest live wins (decision 3). A socket already destroyed is skipped rather
   * than returned: `writeJsonLine` would refuse it anyway, and answering with a
   * dead socket would turn "the agent is not there" — the honest, sender-visible
   * answer design §1.3 asks for — into a silent discard.
   */
  public resolve(address: AgentAddress): AgentConnection | undefined {
    const slot = this.byAddress.get(canonical(address));
    if (!slot) return undefined;
    for (let i = slot.length - 1; i >= 0; i--) {
      if (!slot[i].socket.destroyed) return slot[i];
    }
    return undefined;
  }

  /** Every connection for an address, oldest first. */
  public connectionsFor(address: AgentAddress): AgentConnection[] {
    return [...(this.byAddress.get(canonical(address)) ?? [])];
  }

  /** What this socket announced itself as, if anything. */
  public identityOf(socket: net.Socket): AgentConnection | undefined {
    return this.bySocket.get(socket);
  }

  /** How many identified connections are held, across all addresses. */
  public get size(): number {
    return this.bySocket.size;
  }

  /** The whole map, for a diagnostic reader. Sorted so output is comparable. */
  public snapshot(): AgentConnectionSnapshot[] {
    const out: AgentConnectionSnapshot[] = [];
    for (const [, slot] of this.byAddress) {
      if (slot.length === 0) continue;
      const current = this.resolve(slot[0].address);
      out.push({
        type: slot[0].address.type,
        key: renderedKey(slot[0].address.key),
        connections: slot.map((c) => ({
          id: c.id,
          registeredAt: c.registeredAt.toISOString(),
          current: current === c
        }))
      });
    }
    return out.sort((a, b) => `${a.type}/${a.key}`.localeCompare(`${b.type}/${b.key}`));
  }
}
