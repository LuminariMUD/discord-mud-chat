const { EventEmitter } = require("node:events");
const net = require("node:net");
const tls = require("node:tls");

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
    }

    /** Opens a fresh socket and forwards its events through this transport. */
    connect(port, host, callback) {
        const previousSocket = this.socket;
        if (previousSocket) {
            this.socket = undefined;
            this.encrypted = false;
            previousSocket.destroy();
        }

        let socket;
        const handleConnect = () => {
            if (this.socket !== socket) return;
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
        this.encrypted = false;
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
            this.emit("close", hadError);
        });
        return this;
    }

    /** Writes data to the active socket. */
    write(value) {
        if (!this.socket) throw new Error("MUD transport is not connected");
        return this.socket.write(value);
    }

    /** Closes the active socket and clears its security state. */
    destroy() {
        if (!this.socket) return;
        this.socket.destroy();
        this.socket = undefined;
        this.encrypted = false;
    }
}

module.exports = MudClient;
