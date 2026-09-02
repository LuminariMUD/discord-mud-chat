const http = require("http");

/** Exposes bridge connection and relay statistics over HTTP. */
class HealthServer {
    /** Creates a health server on the environment or caller-provided port. */
    constructor(port = 3000) {
        this.port = process.env.HEALTH_PORT || port;
        this.server = undefined;
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

    /** Starts the health listener once and returns its HTTP server. */
    start() {
        if (this.server) return this.server;

        this.server = http.createServer((req, res) => {
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

        this.server.listen(this.port, () => {
            console.log(`Health check endpoint available at http://localhost:${this.port}/health`);
        });

        return this.server;
    }

    /** Stops the health listener after active connections drain. */
    stop() {
        if (!this.server) return Promise.resolve();

        const server = this.server;
        this.server = undefined;
        return new Promise((resolve, reject) => {
            server.close(error => {
                if (error) reject(error);
                else resolve();
            });
        });
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
