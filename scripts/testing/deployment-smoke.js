// Exercise the real application lifecycle without logging in to Discord.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const root = process.env.BRIDGE_MODULE_ROOT || path.resolve(__dirname, "../..");
const { createApplication, registerShutdownHandlers } = require(path.join(root, "src/index"));
const { loadConfig } = require(path.join(root, "config/load-config"));

async function main() {
    const generic = process.env.SMOKE_GENERIC === "1";
    const config = loadConfig({
        configPath: path.join(root, "config", generic ? "config.example.json" : "config.duris.example.json"),
        env: { DISCORD_TOKEN: "synthetic-unused-token" }
    });
    const posts = [], incoming = [], sockets = new Set();
    const mapping = config.channels[0];
    const record = { channel: mapping.mud, name: "Fixture", message: "Network namespace 你好 🔥", emoted: 0 };
    let server;
    if (process.env.SMOKE_MUD_PORT) config.mud_port = Number(process.env.SMOKE_MUD_PORT);
    else {
        server = net.createServer(socket => {
            sockets.add(socket);
            let pending = "";
            socket.on("data", data => {
                pending += data.toString();
                let delimiter;
                while ((delimiter = pending.indexOf("\n")) !== -1) {
                    incoming.push(JSON.parse(pending.slice(0, delimiter)));
                    pending = pending.slice(delimiter + 1);
                }
            });
            socket.on("close", () => sockets.delete(socket));
            socket.write(JSON.stringify(record) + "\n");
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        config.mud_port = server.address().port;
    }
    config.mud_ip = "127.0.0.1";
    config.mud_tls = false;
    const discord = new EventEmitter();
    discord.channels = {
        cache: new Map([[mapping.discord, { async send(payload) { posts.push(payload); } }]]),
        async fetch(id) { return { id, name: "fixture", guild: { id: "fixture", name: "fixture" } }; }
    };
    discord.login = async () => { discord.emit("ready", { user: { tag: "fixture" } }); };
    discord.destroy = () => {};
    const app = createApplication({ config, discordClient: discord,
        events: { ClientReady: "ready", MessageCreate: "message" }, logger: { close() {} } });
    let health;
    const evidence = { pid: process.pid, profile: generic ? "generic" : "duris", stage: "starting" };
    const save = stage => {
        evidence.stage = stage;
        if (health) evidence.health = health;
        if (process.env.SMOKE_OUTPUT) fs.writeFileSync(process.env.SMOKE_OUTPUT, JSON.stringify(evidence));
    };
    const stop = app.stop.bind(app);
    app.stop = async () => {
        await stop();
        for (const socket of sockets) socket.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        save("stopped");
    };
    registerShutdownHandlers(app);
    try {
        await app.start();
        const deadline = Date.now() + 5000;
        while (posts.length !== 1) {
            assert.ok(Date.now() < deadline, "fixture did not reach the Discord sink");
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual(posts, [{ content: "Fixture: " + record.message, allowedMentions: { parse: [] } }]);
        const accepted = app.bridge.handleDiscordMessage({ content: "fixture ingress", channel: { id: mapping.discord },
            author: { id: "fixture-user" }, member: { user: { bot: false, username: "User" } } });
        assert.equal(accepted, generic);
        if (generic && server) {
            while (incoming.length !== 1) {
                assert.ok(Date.now() < deadline, "generic ingress did not reach the fixture");
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.deepEqual(incoming, [{ name: "User", channel: mapping.mud, message: "fixture ingress" }]);
        } else assert.deepEqual(incoming, []);
        const address = app.healthServer.server.address();
        assert.equal(address.address, "127.0.0.1");
        const response = await fetch(`http://127.0.0.1:${address.port}/health`);
        assert.equal(response.status, 200);
        health = await response.json();
        assert.deepEqual(health.messages, { mudToDiscord: 1, discordToMud: generic ? 1 : 0 });
        assert.deepEqual(health.droppedMessages, { mudToDiscord: 0, discordToMud: 0 });
        save("ready");
        if (process.env.SMOKE_MODE !== "hold") {
            await app.stop();
            console.log("Application deployment smoke passed");
        }
    } catch (error) {
        await app.stop();
        throw error;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
