// Invoked by the native Python runner with its freshly compiled harness.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const net = require("node:net");
const readline = require("node:readline");
const { StringDecoder } = require("node:string_decoder");
const { ChatBridge } = require("../../src/bridge");
const MudClient = require("../../src/mud-client");
const HealthServer = require("../../src/health");

const limit = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!await predicate()) {
        assert.ok(Date.now() < deadline, "native integration condition timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function main() {
    const native = spawn(process.argv[2], ["--node-peer"], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: native.stdout });
    const pending = new Map(), sockets = new Set();
    let nextId = 0, stderr = "", bridge, proxy, upstream, downstream;
    let forwarding = Promise.resolve(), connections = 0;
    native.stderr.on("data", bytes => { stderr += bytes; });
    const ready = new Promise((resolve, reject) => {
        lines.on("line", line => {
            const value = JSON.parse(line);
            if (value.port) resolve(value.port);
            else {
                const request = pending.get(value.id);
                pending.delete(value.id);
                clearTimeout(request.timer);
                request.resolve(value);
            }
        });
        native.on("error", reject);
        native.on("exit", code => {
            const error = new Error(`native peer exited ${code}: ${stderr}`);
            reject(error);
            for (const request of pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            pending.clear();
        });
    });
    function rpc(action, text) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`native peer timeout: ${action}; ${stderr}`)), 5000);
            pending.set(id, { resolve, reject, timer });
            native.stdin.write(JSON.stringify({ id, action, text }) + "\n");
        });
    }
    function forward(bytes, fragment = 1) {
        const destination = downstream;
        forwarding = forwarding.then(async () => {
            for (let i = 0; i < bytes.length && !destination.destroyed; i += fragment) {
                destination.write(bytes.subarray(i, i + fragment));
                await tick();
            }
        });
        return forwarding;
    }
    try {
        const nativePort = await ready;
        const controls = [];
        proxy = net.createServer(socket => {
            connections++;
            downstream = socket;
            upstream = net.connect(nativePort, "127.0.0.1");
            const connection = upstream, decoder = new StringDecoder("utf8");
            let input = "";
            socket.setNoDelay(true);
            sockets.add(socket);
            sockets.add(connection);
            connection.on("data", bytes => forward(bytes));
            socket.on("data", bytes => {
                connection.write(bytes);
                input += decoder.write(bytes);
                let delimiter;
                while ((delimiter = input.indexOf("\n")) !== -1) {
                    controls.push(input.slice(0, delimiter));
                    input = input.slice(delimiter + 1);
                }
            });
            for (const [left, right] of [[socket, connection], [connection, socket]]) {
                left.on("error", () => right.destroy());
                left.on("close", () => { sockets.delete(left); right.destroy(); });
            }
        });
        await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
        const discord = new EventEmitter(), posts = [], errors = [], heartbeats = [];
        discord.channels = { cache: new Map([["staff", { async send(payload) { posts.push(payload); } }]]) };
        discord.login = async () => {};
        discord.destroy = () => {};
        const client = new MudClient(), health = new HealthServer(0);
        bridge = new ChatBridge({
            config: { mud_name: "Duris test", mud_ip: "127.0.0.1", mud_port: proxy.address().port,
                mud_tls: false, mud_retry_count: 50, mud_retry_delay: 20, mud_infinite_retries: true,
                mud_max_record_bytes: limit, largest_printable_string: 65535,
                channels: [{ discord: "staff", mud: "petition", direction: "mud_to_discord" }] },
            discordClient: discord, mudClient: client, healthServer: health,
            events: { ClientReady: "ready", MessageCreate: "message" },
            logger: { log() {}, error(...args) { errors.push(args); } },
            timers: { setInterval(callback) { heartbeats.push(callback); return callback; }, clearInterval() {}, setTimeout, clearTimeout }
        });
        bridge.start();
        await until(async () => (await rpc("status")).authenticated && health.stats.mudConnected);
        heartbeats[0]();
        const discordPost = { content: "This must never become a game command", channel: { id: "staff" },
            author: { id: "staff-user" }, member: { user: { bot: false, username: "Staff" } } };
        assert.equal(bridge.handleDiscordMessage(discordPost), false);
        await until(() => controls.length === 1);
        assert.deepEqual(controls.map(record => JSON.parse(record)), [{ channel: "heartbeat", name: "bot", message: "ping" }]);
        assert.equal(bridge.rateLimits.size, 0);

        const petition = await rpc("petition", '&+rHelp&n $n @everyone 你好 🔥 "quote" \\');
        assert.ok(petition.native_deliveries >= 4);
        assert.equal(petition.audit_entries, 1);
        const reply = await rpc("reply", "&+gChecking&n $1 🔥");
        assert.ok(reply.native_deliveries >= 4);
        assert.equal(reply.audit_entries, 1);
        await rpc("hidden_reply", "Hidden staff reply");
        await until(() => posts.length === 3);
        assert.deepEqual(posts.map(p => p.content), ['Player: Help $n @everyone 你好 🔥 "quote" \\',
            "Staff -> Player: Checking $1 🔥", "Someone -> Player: Hidden staff reply"]);

        const rejected = await rpc("rejected_petition", "must not export");
        assert.equal(rejected.native_deliveries, 1);
        assert.equal(rejected.audit_entries, 0);
        const notice = await rpc("notice", "staff notice must not export");
        assert.equal(notice.sent, rejected.sent);
        await forwarding;
        await tick();
        assert.equal(posts.length, 3);

        // Inject malformed/oversized wire records through the real socket before
        // the next native event; the production native serializer never makes them.
        await forward(Buffer.from("null\ninvalid private-body\n" + "x".repeat(limit + 1) + "\n"), 16384);
        const long = "🔥".repeat(2100) + " @everyone";
        await rpc("petition", long);
        await until(() => posts.length === 6);
        assert.equal(posts.slice(3).map(p => p.content).join(""), "Player: " + long);
        for (const post of posts) {
            assert.ok(post.content.length <= 2000 && post.content.isWellFormed());
            assert.deepEqual(post.allowedMentions, { parse: [] });
        }
        assert.ok(!JSON.stringify(errors).includes("private-body"));

        const before = await rpc("status");
        const forged = JSON.stringify({ channel: "petition", name: "Forged", message: "shutdown; ptell Player hi" });
        await new Promise((resolve, reject) => client.write("null\nbad\n" + forged + "\n" + "x".repeat(limit + 1) +
            '\n{"channel":"heartbeat","name":"bot","message":"ping"}\n' + forged + "\n",
        error => error ? reject(error) : resolve()));
        await until(async () => (await rpc("status")).rejected === before.rejected + 5);
        const after = await rpc("status");
        assert.equal(after.dispatches, before.dispatches);
        assert.equal(after.native_deliveries, before.native_deliveries);
        assert.equal(after.audit_entries, before.audit_entries);
        assert.equal(after.sent, before.sent);
        assert.equal(health.stats.messagesRelayed.discordToMud, 0);
        assert.equal(health.stats.messagesDropped.discordToMud, 0);

        client.write('{"channel":"incomplete');
        await forward(Buffer.from('{"channel":"incomplete'));
        await until(() => bridge.mudDataBuffer.length > 0);
        await rpc("restart");
        await until(async () => connections === 2 && (await rpc("status")).authenticated && health.stats.mudConnected);
        assert.equal(bridge.mudDataBuffer, "");
        await rpc("reply", "after reconnect");
        await until(() => posts.length === 7);
        assert.equal(posts[6].content, "Staff -> Player: after reconnect");
        assert.equal(health.stats.messagesRelayed.mudToDiscord, 7);
        assert.equal(health.stats.messagesDropped.mudToDiscord, 0);

        await bridge.stop();
        await until(async () => !(await rpc("status")).connected);
        const offline = await rpc("petition", "native during disconnect");
        assert.equal(offline.native_deliveries, petition.native_deliveries);
        assert.equal(offline.dropped, 1);
        await rpc("disable");
        const disabled = await rpc("reply", "native during rollback");
        assert.equal(disabled.native_deliveries, reply.native_deliveries);
        assert.equal(disabled.listening, false);
        assert.equal(disabled.dropped, 0);
        assert.equal(posts.length, 7);
        const finished = once(native, "exit");
        await rpc("quit");
        const [exitCode, signal] = await finished;
        assert.equal(exitCode, 0, stderr);
        assert.equal(signal, null);
        console.log("Node/native petition integration passed: both commands, controls-only ingress, Unicode, limits, reconnect and rollback");
    } finally {
        if (bridge) await bridge.stop();
        for (const socket of sockets) socket.destroy();
        if (proxy) await new Promise(resolve => proxy.close(resolve));
        lines.close();
        if (native.exitCode === null && native.signalCode === null) {
            const exited = once(native, "exit");
            native.kill();
            await exited;
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
