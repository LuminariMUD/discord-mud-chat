const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { fork, execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { test } = require("node:test");
const MudClient = require("../src/mud-client");
const { ChatBridge } = require("../src/bridge");
const HealthServer = require("../src/health");
const fixtures = require("./fixtures/mud-protocol/records.json");

async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for protocol condition");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function peerProcess(t) {
    const child = fork(path.join(__dirname, "../scripts/testing/protocol-peer.js"), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const events = [], pending = new Map();
    let nextId = 0, stderr = "";
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("message", message => {
        if (message.id) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.result);
        } else events.push(message);
    });
    child.on("exit", () => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(`peer exited: ${stderr}`));
        }
        pending.clear();
    });
    t.after(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill();
        await exited;
    });
    return { events, rpc(command, args = {}) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`peer timeout: ${command}; ${stderr}`)), 5000);
            pending.set(id, { resolve, reject, timer });
            child.send({ id, command, ...args });
        });
    } };
}

function certificates(t) {
    const dir = mkdtempSync(path.join(tmpdir(), "mud-protocol-tls-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=fixture.test", "-addext", "subjectAltName=DNS:fixture.test", "-keyout", key, "-out", cert],
    { stdio: "ignore" });
    return { key, cert };
}

function transport({ cert, trusted = true, servername = "fixture.test" } = {}) {
    return new MudClient({ useTls: Boolean(cert), servername,
        // Add this test's temporary CA while preserving production TLS options,
        // certificate validation, hostname checking, and actual network I/O.
        tlsModule: { connect(options, callback) {
            return tls.connect({ ...options, ca: trusted ? readFileSync(cert) : undefined }, callback);
        } }
    });
}

function bridgeHarness(t, client, port, useTls) {
    const discord = new EventEmitter(), sent = [], errors = [], intervals = [];
    discord.channels = { cache: new Map([["one", { async send(payload) { sent.push(payload); } }]]) };
    discord.login = async () => {};
    discord.destroy = () => {};
    const health = new HealthServer(0);
    const bridge = new ChatBridge({
        config: {
            mud_name: "Independent fixture", mud_ip: "127.0.0.1", mud_port: port,
            mud_tls: useTls, mud_auth_token: useTls ? "fixture-token" : undefined,
            mud_max_record_bytes: 1024, mud_retry_count: 1, mud_retry_delay: 10,
            largest_printable_string: 65535, strip_emoji: false,
            channels: [{ discord: "one", mud: "Guild/Élite" }, { discord: "one", mud: "gossip" },
                { discord: "staff", mud: "petition", direction: "mud_to_discord" }]
        }, discordClient: discord, mudClient: client, healthServer: health,
        events: { ClientReady: "ready", MessageCreate: "message" },
        timers: { setInterval(callback) { intervals.push(callback); return callback; }, clearInterval() {}, setTimeout, clearTimeout },
        logger: { log() {}, error(...args) { errors.push(args); } }
    });
    t.after(() => bridge.stop());
    bridge.start();
    return { bridge, health, sent, errors, intervals };
}

for (const useTls of [false, true]) {
    test(`independent ${useTls ? "TLS" : "TCP"} peer preserves the generic contract and reconnects`, { timeout: 15000 }, async t => {
        const certs = useTls ? certificates(t) : {};
        const peer = peerProcess(t);
        const port = await peer.rpc("listen", { tls: useTls, ...certs });
        const client = transport(certs);
        const { bridge, health, sent, intervals } = bridgeHarness(t, client, port, useTls);
        await until(() => health.stats.mudConnected && peer.events.some(e => e.event === "connected"));
        assert.equal(client.encrypted, useTls);
        intervals[0]();
        const discordMessage = { content: "Generic 你好 🔥 \\\n@everyone", channel: { id: "one" },
            author: { id: "fixture-user" }, member: { nickname: "Zoë", user: { username: "User", bot: false } } };
        assert.equal(bridge.handleDiscordMessage(discordMessage), true);
        assert.equal(bridge.handleDiscordMessage({ ...discordMessage, channel: { id: "staff" } }), false);
        const expected = [fixtures.controls[1], { name: "Zoë", channel: "Guild/Élite", message: "Generic 你好 🔥 \\\n[mention removed]" }];
        if (useTls) expected.unshift(fixtures.controls[0]);
        await until(() => peer.events.filter(e => e.event === "record").length === expected.length);
        assert.deepEqual(peer.events.filter(e => e.event === "record").map(e => JSON.parse(e.record)), expected);
        assert.equal(health.stats.messagesRelayed.discordToMud, 1);
        assert.equal(health.stats.messagesDropped.discordToMud, 0);

        // The sender fragments inside every multibyte character. Also cover
        // coalesced records, malformed schema, exact bounds, and oversize recovery.
        for (const fixture of fixtures.chat) await peer.rpc("send", { text: fixture.wire, fragment: 1 });
        const exact = { channel: "gossip", name: "A", message: "" };
        exact.message = "x".repeat(1024 - Buffer.byteLength(JSON.stringify(exact)));
        const tail = JSON.stringify({ channel: "gossip", name: "B", message: "after oversized" }) + "\n";
        await peer.rpc("send", { text: fixtures.blank + fixtures.invalid.join("") +
            '{"channel":"gossip","message":42}\n' + JSON.stringify(exact) + "\n" + "x".repeat(1025) });
        await peer.rpc("send", { text: "rest\n" + tail });
        await until(() => sent.length === fixtures.chat.length + 2);
        assert.deepEqual(sent.map(p => p.content), [...fixtures.chat.map(f => f.content), "A: " + exact.message, "B: after oversized"]);
        for (const payload of sent) assert.deepEqual(payload.allowedMentions, { parse: [] });

        await peer.rpc("send", { text: '{"channel":"gossip","name":"stale"' });
        await until(() => bridge.mudDataBuffer.length > 0);
        await peer.rpc("close");
        await until(() => peer.events.filter(e => e.event === "connected").length === 2);
        await until(() => health.stats.mudConnected);
        assert.equal(bridge.mudDataBuffer, "");
        await peer.rpc("send", { index: 1, text: tail });
        await until(() => sent.length === fixtures.chat.length + 3);
        if (useTls) await until(() => peer.events.some(e => e.event === "record" && e.index === 1));
        assert.deepEqual(peer.events.filter(e => e.event === "record" && e.index === 1).map(e => JSON.parse(e.record)),
            useTls ? [fixtures.controls[0]] : []);
        await bridge.stop();
        assert.equal(client.socket, undefined);
    });

    test(`real ${useTls ? "TLS" : "TCP"} write pressure stays bounded and drains without replay`, { timeout: 15000 }, async t => {
        const certs = useTls ? certificates(t) : {};
        const peer = peerProcess(t);
        const port = await peer.rpc("listen", { tls: useTls, paused: true, ...certs });
        const client = transport(certs);
        t.after(() => client.destroy());
        client.on("error", error => assert.fail(error));
        await new Promise(resolve => client.connect(port, "127.0.0.1", resolve));
        await until(() => peer.events.some(e => e.event === "connected"));
        const record = "x".repeat(512 * 1024 - 1) + "\n";
        let accepted = 0;
        for (; accepted < 64; accepted++) {
            try { client.write(record); }
            catch (error) { assert.equal(error.code, "MUD_WRITE_CAPACITY"); break; }
        }
        assert.ok(accepted > 0 && accepted < 64);
        assert.ok(client.writeState.bytes <= MudClient.MAX_PENDING_MUD_BYTES);
        assert.ok(client.socket.writableLength <= MudClient.MAX_PENDING_MUD_BYTES);
        await peer.rpc("resume");
        await until(() => client.writeState.pending.size === 0 && !client.writeState.blocked);
        client.write("recovered\n");
        await until(() => peer.events.some(e => e.record === "recovered"));
        assert.deepEqual(peer.events.filter(e => e.event === "record").map(e => e.length),
            [...Array(accepted).fill(record.length - 1), 9]);
    });
}

test("real TLS rejects an untrusted certificate and a wrong server name before auth", { timeout: 15000 }, async t => {
    const certs = certificates(t);
    for (const options of [{ trusted: false }, { servername: "wrong.fixture.test" }, { servername: "" }]) {
        const peer = peerProcess(t);
        const port = await peer.rpc("listen", { tls: true, ...certs });
        const client = transport({ ...certs, ...options });
        const codes = [];
        client.on("error", error => codes.push(error.code));
        const { health, errors } = bridgeHarness(t, client, port, true);
        await until(() => errors.length > 0 && client.socket === undefined);
        assert.equal(health.stats.mudConnected, false);
        assert.equal(client.encrypted, false);
        assert.deepEqual(codes, [options.trusted === false ? "DEPTH_ZERO_SELF_SIGNED_CERT" : "ERR_TLS_CERT_ALTNAME_INVALID"]);
        assert.deepEqual(peer.events.filter(e => e.event === "record"), []);
    }
});
