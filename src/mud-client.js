const { EventEmitter } = require("node:events");
const net = require("node:net");
const tls = require("node:tls");

const MAX_PENDING_MUD_WRITES = 256;
const MAX_PENDING_MUD_BYTES = 4 * 1024 * 1024;

function transportError(code, message) {
    return Object.assign(new Error(message), { code });
}

/** Returns whether a hostname or address is explicitly confined to loopback. */
function isLoopbackHost(host) {
    if (typeof host !== "string") return false;

    const normalizedHost = host.toLowerCase();
    if (net.isIP(normalizedHost) === 4) return normalizedHost.startsWith("127.");
    return normalizedHost === "::1" || normalizedHost.startsWith("::ffff:127.");
}

/** Rejects MUD settings that could expose a remote connection or authentication token. */
function validateMudTransportConfig(config) {
    if (config.mud_ip && config.mud_tls !== true && !isLoopbackHost(config.mud_ip)) {
        throw new Error("Plaintext MUD transport is restricted to literal loopback addresses; enable mud_tls for remote connections");
    }
    if (config.mud_auth_token && config.mud_tls !== true) {
        throw new Error("MUD authentication requires mud_tls to be enabled");
    }
}

/** Provides a reconnectable TCP or certificate-validated TLS MUD transport. */
class MudClient extends EventEmitter {
    /** Creates a transport with injectable network modules for testing. */
    constructor({
        useTls = false,
        servername,
        netModule = net,
        tlsModule = tls
    } = {}) {
        super();
        this.useTls = useTls;
        this.servername = servername;
        this.netModule = netModule;
        this.tlsModule = tlsModule;
        this.socket = undefined;
        this.encrypted = false;
        this.writeState = undefined;
    }

    /** Opens a fresh socket and forwards its events through this transport. */
    connect(port, host, callback) {
        if (!this.useTls && !isLoopbackHost(host)) {
            throw new Error("Plaintext MUD transport is restricted to loopback hosts; enable mud_tls for remote connections");
        }

        this.destroy();

        let socket;
        const state = { ready: false, blocked: false, pending: new Set(), bytes: 0 };
        const handleConnect = () => {
            if (this.socket !== socket) return;
            state.ready = true;
            this.encrypted = socket.encrypted === true;
            callback();
        };

        if (this.useTls) {
            const options = {
                host,
                port,
                rejectUnauthorized: true
            };
            const servername = this.servername || (
                this.netModule.isIP(host) === 0 ? host : undefined
            );
            if (servername) options.servername = servername;
            socket = this.tlsModule.connect(options, handleConnect);
        } else {
            socket = this.netModule.connect({ host, port }, handleConnect);
        }

        this.socket = socket;
        this.writeState = state;
        this.encrypted = false;
        socket.on("drain", () => {
            if (this.socket === socket) state.blocked = false;
        });
        socket.on("data", data => {
            if (this.socket === socket) this.emit("data", data);
        });
        socket.on("error", error => {
            if (this.socket === socket) this.emit("error", error);
        });
        socket.on("close", hadError => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.encrypted = false;
            this.writeState = undefined;
            this.discardWrites(state);
            this.emit("close", hadError);
        });
        return this;
    }

    /** Admits a whole write; false still means accepted, as with socket.write(). */
    write(value, callback) {
        const socket = this.socket, state = this.writeState;
        if (!socket || !state.ready || socket.destroyed || socket.writable === false) {
            throw transportError("MUD_NOT_CONNECTED", "MUD transport is not connected");
        }
        const bytes = Buffer.byteLength(value, "utf8");
        if (state.blocked || socket.writableNeedDrain
            || state.pending.size >= MAX_PENDING_MUD_WRITES
            || bytes > MAX_PENDING_MUD_BYTES - Math.max(state.bytes, socket.writableLength || 0)) {
            throw transportError("MUD_WRITE_CAPACITY", "MUD write capacity exceeded; record discarded");
        }
        const entry = { bytes, callback };
        state.pending.add(entry);
        state.bytes += bytes;
        try {
            const writable = socket.write(value, error => this.finishWrite(state, entry, error));
            if (!writable) state.blocked = true;
            return writable;
        } catch (error) {
            // A thrown write was not admitted. Its caller owns failure accounting.
            if (state.pending.delete(entry)) state.bytes -= bytes;
            throw error;
        }
    }

    /** Settles a pending write once; stale callbacks cannot change a new connection. */
    finishWrite(state, entry, error) {
        if (!state.pending.delete(entry)) return;
        state.bytes -= entry.bytes;
        entry.callback?.(error);
    }

    /** Discards uncertain pending writes on disconnect; nothing is replayed. */
    discardWrites(state) {
        state.ready = false;
        for (const entry of state.pending) {
            this.finishWrite(state, entry, transportError("MUD_WRITE_INTERRUPTED", "MUD write interrupted"));
        }
    }

    /** Closes the active socket and clears its security state. */
    destroy() {
        if (!this.socket) return;
        const socket = this.socket, state = this.writeState;
        this.socket = undefined;
        this.writeState = undefined;
        this.encrypted = false;
        socket.destroy();
        this.discardWrites(state);
    }
}

module.exports = MudClient;
module.exports.isLoopbackHost = isLoopbackHost;
module.exports.validateMudTransportConfig = validateMudTransportConfig;
module.exports.MAX_PENDING_MUD_WRITES = MAX_PENDING_MUD_WRITES;
module.exports.MAX_PENDING_MUD_BYTES = MAX_PENDING_MUD_BYTES;
