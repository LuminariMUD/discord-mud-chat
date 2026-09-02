const http = require("http");

/** Exposes bridge connection and relay statistics over HTTP. */
class HealthServer {
    /** Creates a health server on the environment or caller-provided port. */
    constructor(port = 3000) {
        this.port = process.env.HEALTH_PORT || port;
        this.host = "127.0.0.1";
        this.server = undefined;
        this.starting = undefined;
        this.stopping = undefined;
        this.stats = {
            uptime: Date.now(),
            mudConnected: false,
            discordConnected: false,
            messagesRelayed: {
                mudToDiscord: 0,
                discordToMud: 0
            }
        };
    }

    /** Starts the health listener once and resolves after it is listening. */
    start() {
        if (this.starting) return this.starting;
        if (this.server) return Promise.resolve(this.server);

        const server = http.createServer((req, res) => {
            if (req.url === "/health" && req.method === "GET") {
                const status = this.stats.mudConnected && this.stats.discordConnected ? 200 : 503;
                const health = {
                    status: status === 200 ? "healthy" : "unhealthy",
                    timestamp: new Date().toISOString(),
                    uptime: Math.floor((Date.now() - this.stats.uptime) / 1000),
                    connections: {
                        mud: this.stats.mudConnected,
                        discord: this.stats.discordConnected
                    },
                    messages: this.stats.messagesRelayed
                };

                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(health, null, 2));
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
            }
        });
        this.server = server;

        const startPromise = new Promise((resolve, reject) => {
            /** Rejects startup and releases the failed server instance. */
            const handleError = error => {
                server.off("listening", handleListening);
                if (this.server === server) this.server = undefined;
                reject(error);
            };
            /** Resolves startup after the listener has successfully bound. */
            const handleListening = () => {
                server.off("error", handleError);
                console.log(`Health check endpoint available at http://${this.host}:${this.port}/health`);
                resolve(server);
            };

            server.once("error", handleError);
            server.once("listening", handleListening);
            try {
                server.listen(this.port, this.host);
            } catch (error) {
                handleError(error);
            }
        });
        const trackedStart = startPromise.finally(() => {
            if (this.starting === trackedStart) this.starting = undefined;
        });
        this.starting = trackedStart;
        return trackedStart;
    }

    /** Stops the health listener after active connections drain. */
    async stop() {
        if (this.stopping) return this.stopping;

        const stopPromise = (async () => {
            if (this.starting) {
                try {
                    await this.starting;
                } catch {
                    return;
                }
            }
            if (!this.server) return;

            const server = this.server;
            this.server = undefined;
            await new Promise((resolve, reject) => {
                /** Restores the server reference so a failed close can be retried. */
                const handleCloseError = error => {
                    if (!this.server) this.server = server;
                    reject(error);
                };

                try {
                    server.close(error => {
                        if (error) handleCloseError(error);
                        else resolve();
                    });
                } catch (error) {
                    handleCloseError(error);
                }
            });
        })();
        const trackedStop = stopPromise.finally(() => {
            if (this.stopping === trackedStop) this.stopping = undefined;
        });
        this.stopping = trackedStop;
        return trackedStop;
    }

    /** Records whether the MUD transport is connected. */
    setMudConnected(connected) {
        this.stats.mudConnected = connected;
    }

    /** Records whether the Discord transport is connected. */
    setDiscordConnected(connected) {
        this.stats.discordConnected = connected;
    }

    /** Records a successfully delivered MUD-to-Discord message. */
    incrementMudToDiscord() {
        this.stats.messagesRelayed.mudToDiscord++;
    }

    /** Records a Discord-to-MUD message. */
    incrementDiscordToMud() {
        this.stats.messagesRelayed.discordToMud++;
    }
}

module.exports = HealthServer;
