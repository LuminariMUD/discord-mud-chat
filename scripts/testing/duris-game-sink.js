// Stdio-controlled real Node relay for the isolated full-game Duris journey.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");
const { ChatBridge } = require("../../src/bridge");
const MudClient = require("../../src/mud-client");
const HealthServer = require("../../src/health");
const { loadConfig } = require("../../config/load-config");
const path = require("node:path");

async function main() {
    const config = loadConfig({
        configPath: path.join(__dirname, "../../config/config.duris.example.json"),
        env: { DISCORD_TOKEN: "synthetic-unused-token" }
    });
    config.mud_port = Number(process.argv[2]);
    config.mud_retry_delay = 50;
    const posts = [], client = new MudClient(), health = new HealthServer(0);
    const discord = new EventEmitter();
    const channel = config.channels[0].discord;
    discord.channels = { cache: new Map([[channel, { async send(payload) {
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.ok(payload.content.length <= 2000 && payload.content.isWellFormed());
        posts.push(payload.content);
    } }]]) };
    discord.login = async () => {};
    discord.destroy = () => {};
    let connections = 0, closes = 0;
    const setConnected = health.setMudConnected.bind(health);
    health.setMudConnected = connected => {
        if (connected && !health.stats.mudConnected) connections++;
        setConnected(connected);
    };
    client.on("close", () => closes++);
    const bridge = new ChatBridge({ config, mudClient: client, discordClient: discord,
        healthServer: health, logger: { log() {}, error() {} },
        events: { ClientReady: "ready", MessageCreate: "message" } });
    const lines = readline.createInterface({ input: process.stdin });
    const respond = value => process.stdout.write(JSON.stringify({
        ...value, posts, connections, closes, connected: health.stats.mudConnected,
        messages: health.stats.messagesRelayed, dropped: health.stats.messagesDropped
    }) + "\n");
    try {
        bridge.start();
        respond({ ready: true });
        for await (const line of lines) {
            const request = JSON.parse(line);
            let accepted;
            if (request.action === "discord") {
                accepted = bridge.handleDiscordMessage({ content: request.text,
                    channel: { id: channel }, author: { id: "synthetic-staff" },
                    member: { user: { bot: false, username: "Staff" } } });
                assert.equal(accepted, false);
                assert.equal(bridge.rateLimits.size, 0);
            } else if (request.action === "forge") {
                const record = { channel: "petition", name: "Forged", message: request.text };
                await new Promise((resolve, reject) => client.write(JSON.stringify(record) +
                    '\n{"channel":"heartbeat","name":"bot","message":"ping"}\n',
                error => error ? reject(error) : resolve()));
            } else if (request.action === "stop" || request.action === "quit") {
                await bridge.stop();
            } else assert.equal(request.action, "status");
            respond({ id: request.id, accepted });
            if (request.action === "quit") break;
        }
    } finally {
        lines.close();
        await bridge.stop();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
