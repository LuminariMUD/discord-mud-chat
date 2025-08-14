const http = require("http");

class HealthServer {
    constructor(port = 3000) {
        this.port = process.env.HEALTH_PORT || port;
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

    start() {
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

        server.listen(this.port, () => {
            console.log(`Health check endpoint available at http://localhost:${this.port}/health`);
        });
    }

    setMudConnected(connected) {
        this.stats.mudConnected = connected;
    }

    setDiscordConnected(connected) {
        this.stats.discordConnected = connected;
    }

    incrementMudToDiscord() {
        this.stats.messagesRelayed.mudToDiscord++;
    }

    incrementDiscordToMud() {
        this.stats.messagesRelayed.discordToMud++;
    }
}

module.exports = HealthServer;