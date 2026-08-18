import { renderedKey } from './keys.js';
/** The canonical form two spellings of one agent must collapse to. */
function canonical(address) {
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
export function addressFromAnnouncement(msg) {
    const type = typeof msg?.workspaceType === 'string' ? msg.workspaceType.trim() : '';
    const key = typeof msg?.workspaceKey === 'string' ? msg.workspaceKey.trim() : '';
    if (!type || !key)
        return null;
    return { type, key };
}
/** How an address reads in a log line or a diagnostic. */
export function describeAddress(address) {
    return `${address.type}/${renderedKey(address.key)}`;
}
export class AgentConnectionRegistry {
    /** Canonical address → its connections, oldest first. */
    byAddress = new Map();
    /** The reverse index, so `close` can remove without knowing the address. */
    bySocket = new Map();
    nextId = 0;
    /**
     * Bind an identity to a socket.
     *
     * A second `hello` on a socket that already has one *replaces* its binding
     * rather than adding a second: one socket is one MCP server is one agent, so
     * a socket bound to two identities is a bug wherever it came from, and
     * silently holding both would make `resolve` answer for an agent that is not
     * there.
     */
    register(socket, address, build = null) {
        if (!address.type || !address.key) {
            return { ok: false, error: 'hello requires both workspaceType and workspaceKey' };
        }
        const replaced = this.release(socket) ?? null;
        const connection = {
            id: `conn-${++this.nextId}`,
            address: { type: address.type, key: address.key },
            socket,
            registeredAt: new Date(),
            // Defaulted to null rather than required, so the existing constructions
            // that only care about addressing stay as they were — and so an
            // announcement with no build is stored as the absence it is instead of
            // being rejected. A server that cannot say which build it loaded is still
            // an agent that must stay addressable.
            build
        };
        const slot = this.byAddress.get(canonical(address));
        if (slot)
            slot.push(connection);
        else
            this.byAddress.set(canonical(address), [connection]);
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
    release(socket) {
        const connection = this.bySocket.get(socket);
        if (!connection)
            return undefined;
        this.bySocket.delete(socket);
        const address = canonical(connection.address);
        const slot = this.byAddress.get(address);
        if (slot) {
            const at = slot.indexOf(connection);
            if (at !== -1)
                slot.splice(at, 1);
            // The key goes when its last connection does. A map that keeps empty
            // arrays around is a map that grows for the lifetime of the daemon and
            // answers "yes, I know that agent" about one that left hours ago.
            if (slot.length === 0)
                this.byAddress.delete(address);
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
    resolve(address) {
        const slot = this.byAddress.get(canonical(address));
        if (!slot)
            return undefined;
        for (let i = slot.length - 1; i >= 0; i--) {
            if (!slot[i].socket.destroyed)
                return slot[i];
        }
        return undefined;
    }
    /** Every connection for an address, oldest first. */
    connectionsFor(address) {
        return [...(this.byAddress.get(canonical(address)) ?? [])];
    }
    /** What this socket announced itself as, if anything. */
    identityOf(socket) {
        return this.bySocket.get(socket);
    }
    /**
     * Every agent with at least one live connection, in the announced spelling.
     *
     * Deliberately NOT {@link snapshot}, which renders keys for a human reader —
     * `kan-252` off a pane name comes back as `KAN-252` there, and a caller that
     * fed that back into {@link resolve} would be relying on `canonical` to undo a
     * presentation decision. This is the addressing view: what came in on `hello`,
     * which is what an addressed write needs. KAN-252's scheduled probe is its
     * caller, and it needs to *choose* a recipient rather than be handed one.
     */
    addresses() {
        const out = [];
        for (const [, slot] of this.byAddress) {
            if (slot.length === 0)
                continue;
            // The one `resolve` would write to, so an address here is one that can be
            // written to right now rather than one that was connected at some point.
            const current = this.resolve(slot[0].address);
            if (current)
                out.push({ ...current.address });
        }
        return out.sort((a, b) => `${a.type}/${a.key}`.toLowerCase().localeCompare(`${b.type}/${b.key}`.toLowerCase()));
    }
    /**
     * One row per agent — the connection {@link resolve} would write to, and the
     * build the process behind it loaded (KAN-526).
     *
     * The **current** connection only, and that is the whole shape of it: an
     * agent's older sockets belong to the same process, so counting them would
     * report one stale server several times and make a fleet look worse than it
     * is. Keys are left in the announced spelling, as {@link addresses} does and
     * for its reason — this is read by a check, not printed as a heading.
     */
    servingProcesses() {
        const out = [];
        for (const [, slot] of this.byAddress) {
            if (slot.length === 0)
                continue;
            const current = this.resolve(slot[0].address);
            if (!current)
                continue;
            out.push({
                type: current.address.type,
                key: current.address.key,
                connectionId: current.id,
                build: current.build
            });
        }
        return out.sort((a, b) => `${a.type}/${a.key}`.toLowerCase().localeCompare(`${b.type}/${b.key}`.toLowerCase()));
    }
    /** How many identified connections are held, across all addresses. */
    get size() {
        return this.bySocket.size;
    }
    /** The whole map, for a diagnostic reader. Sorted so output is comparable. */
    snapshot() {
        const out = [];
        for (const [, slot] of this.byAddress) {
            if (slot.length === 0)
                continue;
            const current = this.resolve(slot[0].address);
            out.push({
                type: slot[0].address.type,
                key: renderedKey(slot[0].address.key),
                connections: slot.map((c) => ({
                    id: c.id,
                    registeredAt: c.registeredAt.toISOString(),
                    current: current === c,
                    build: c.build
                }))
            });
        }
        return out.sort((a, b) => `${a.type}/${a.key}`.localeCompare(`${b.type}/${b.key}`));
    }
}
