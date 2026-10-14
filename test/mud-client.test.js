const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const MudClient = require("../src/mud-client");
const { isLoopbackHost } = MudClient;

/** Creates an injectable network module and captures each opened fake socket. */
function createNetworkModule({ encrypted = false, ipVersion = 0 } = {}) {
    const calls = [];
    return {
        calls,
        isIP: () => ipVersion,
        connect(options, callback) {
            const socket = new EventEmitter();
            socket.encrypted = encrypted;
            socket.writes = [];
            socket.callbacks = [];
            socket.destroyed = false;
            socket.finishConnect = () => callback();
            socket.write = (value, callback) => {
                socket.writes.push(value);
                socket.callbacks.push(callback);
                return true;
            };
            socket.destroy = () => {
                socket.destroyed = true;
            };
            calls.push({ options, socket });
            return socket;
        }
    };
}

test("MudClient opens certificate-validated TLS and forwards socket events", () => {
    const netModule = createNetworkModule();
    const tlsModule = createNetworkModule({ encrypted: true });
    const client = new MudClient({ useTls: true, netModule, tlsModule });
    const received = { data: [], errors: [], closes: [] };
    let connected = false;
    client.on("data", data => received.data.push(data));
    client.on("error", error => received.errors.push(error));
    client.on("close", hadError => received.closes.push(hadError));

    assert.equal(client.connect(8181, "mud.example.com", () => {
        connected = true;
    }), client);
    assert.equal(netModule.calls.length, 0);
    assert.deepEqual(tlsModule.calls[0].options, {
        host: "mud.example.com",
        port: 8181,
        rejectUnauthorized: true,
        servername: "mud.example.com"
    });

    const { socket } = tlsModule.calls[0];
    socket.finishConnect();
    assert.equal(connected, true);
    assert.equal(client.encrypted, true);
    assert.equal(client.write("hello"), true);
    assert.deepEqual(socket.writes, ["hello"]);

    const socketError = new Error("offline");
    socket.emit("data", Buffer.from("record\n"));
    socket.emit("error", socketError);
    socket.emit("close", true);
    assert.deepEqual(received.data, [Buffer.from("record\n")]);
    assert.deepEqual(received.errors, [socketError]);
    assert.deepEqual(received.closes, [true]);
    assert.equal(client.encrypted, false);
    assert.equal(client.socket, undefined);
});

test("writes before connect are rejected and false means accepted once until drain", () => {
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });
    client.connect(8181, "127.0.0.1", () => {});
    const { socket } = netModule.calls[0];
    assert.throws(() => client.write("before-connect"), { code: "MUD_NOT_CONNECTED" });
    socket.finishConnect();
    const originalWrite = socket.write;
    socket.write = (...args) => { originalWrite(...args); return false; };
    const results = [];
    assert.equal(client.write("accepted", error => results.push(error)), false);
    assert.throws(() => client.write("not accepted"), { code: "MUD_WRITE_CAPACITY" });
    socket.callbacks[0]();
    assert.deepEqual(results, [undefined]);
    assert.throws(() => client.write("still waiting for drain"), { code: "MUD_WRITE_CAPACITY" });
    socket.write = originalWrite;
    socket.emit("drain");
    assert.equal(client.write("next"), true);
    assert.deepEqual(socket.writes, ["accepted", "next"]);
    socket.callbacks[1]();
    assert.equal(client.writeState.bytes, 0);
    assert.equal(client.writeState.pending.size, 0);
    socket.writable = false;
    assert.throws(() => client.write("after end"), { code: "MUD_NOT_CONNECTED" });
    socket.writable = true;
    socket.destroyed = true;
    assert.throws(() => client.write("after destroy"), { code: "MUD_NOT_CONNECTED" });
});

test("pending writes are bounded by count and UTF-8 bytes including the socket buffer", () => {
    const { MAX_PENDING_MUD_WRITES, MAX_PENDING_MUD_BYTES } = MudClient;
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });
    client.connect(8181, "127.0.0.1", () => {});
    const { socket } = netModule.calls[0];
    socket.finishConnect();
    for (let i = 0; i < MAX_PENDING_MUD_WRITES; i++) client.write("x");
    assert.throws(() => client.write("overflow"), { code: "MUD_WRITE_CAPACITY" });
    assert.equal(socket.writes.length, MAX_PENDING_MUD_WRITES);
    socket.callbacks.forEach(callback => callback());
    client.write("🔥".repeat(MAX_PENDING_MUD_BYTES / 4));
    assert.equal(client.writeState.bytes, MAX_PENDING_MUD_BYTES);
    assert.throws(() => client.write("x"), { code: "MUD_WRITE_CAPACITY" });
    socket.callbacks.at(-1)();
    assert.throws(() => client.write("x".repeat(MAX_PENDING_MUD_BYTES + 1)), { code: "MUD_WRITE_CAPACITY" });
    socket.writableLength = MAX_PENDING_MUD_BYTES;
    assert.throws(() => client.write("x"), { code: "MUD_WRITE_CAPACITY" });
    socket.writableLength = 0;
    socket.writableNeedDrain = true;
    assert.throws(() => client.write("x"), { code: "MUD_WRITE_CAPACITY" });
    socket.writableNeedDrain = false;
    client.write("recovered");
    socket.callbacks.at(-1)();
    assert.equal(client.writeState.bytes, 0);
});

test("disconnect, replacement and shutdown settle pending writes once without replay", () => {
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });
    const results = [];
    client.connect(8181, "127.0.0.1", () => {});
    const first = netModule.calls[0].socket;
    first.finishConnect();
    client.write("uncertain", error => results.push(error.code));
    client.connect(8181, "127.0.0.1", () => {});
    const second = netModule.calls[1].socket;
    second.finishConnect();
    first.callbacks[0]();
    first.emit("drain");
    assert.deepEqual(results, ["MUD_WRITE_INTERRUPTED"]);
    assert.deepEqual(second.writes, []);
    client.write("new", error => results.push(error.code));
    second.callbacks[0](Object.assign(new Error("private body"), { code: "EPIPE" }));
    second.emit("close", true);
    assert.deepEqual(results, ["MUD_WRITE_INTERRUPTED", "EPIPE"]);
    assert.equal(client.writeState, undefined);
    client.connect(8181, "127.0.0.1", () => {});
    const third = netModule.calls[2].socket;
    third.finishConnect();
    client.write("shutdown", error => results.push(error.code));
    client.destroy();
    third.callbacks[0](new Error("late error"));
    assert.deepEqual(results, ["MUD_WRITE_INTERRUPTED", "EPIPE", "MUD_WRITE_INTERRUPTED"]);
});

test("a thrown socket write releases capacity without also calling its callback", () => {
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });
    client.connect(8181, "127.0.0.1", () => {});
    const { socket } = netModule.calls[0];
    socket.finishConnect();
    socket.write = () => { throw new Error("failed"); };
    assert.throws(() => client.write("failed", () => assert.fail("not admitted")), /failed/);
    assert.equal(client.writeState.bytes, 0);
    assert.equal(client.writeState.pending.size, 0);
});

test("MudClient supports plaintext without claiming encryption", () => {
    const netModule = createNetworkModule({ ipVersion: 4 });
    const tlsModule = createNetworkModule({ encrypted: true });
    const client = new MudClient({ netModule, tlsModule });

    client.connect(8181, "127.0.0.1", () => {});
    netModule.calls[0].socket.finishConnect();

    assert.deepEqual(netModule.calls[0].options, {
        host: "127.0.0.1",
        port: 8181
    });
    assert.equal(tlsModule.calls.length, 0);
    assert.equal(client.encrypted, false);
    client.destroy();
    assert.equal(netModule.calls[0].socket.destroyed, true);
    assert.equal(client.socket, undefined);

    const disconnected = new MudClient({ netModule, tlsModule });
    assert.throws(() => disconnected.write("hello"), /not connected/);
    disconnected.destroy();
});

test("MudClient restricts plaintext connections to loopback hosts", () => {
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });

    assert.throws(
        () => client.connect(8181, "mud.localhost", () => {}),
        /restricted to loopback hosts/
    );
    assert.equal(netModule.calls.length, 0);
    assert.equal(isLoopbackHost("localhost"), false);
    assert.equal(isLoopbackHost("mud.localhost"), false);
    assert.equal(isLoopbackHost("127.42.0.1"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("192.0.2.10"), false);
});

test("MudClient honors an explicit TLS server name", () => {
    const netModule = createNetworkModule({ ipVersion: 4 });
    const tlsModule = createNetworkModule({ encrypted: true });
    const client = new MudClient({
        useTls: true,
        servername: "mud.example.com",
        netModule,
        tlsModule
    });

    client.connect(8181, "192.0.2.10", () => {});

    assert.equal(tlsModule.calls[0].options.servername, "mud.example.com");
    assert.equal(tlsModule.calls[0].options.rejectUnauthorized, true);
});

test("MudClient ignores events from superseded sockets", () => {
    const netModule = createNetworkModule();
    const client = new MudClient({ netModule });
    const received = [];
    const connections = [];
    client.on("data", data => received.push(data));

    client.connect(8181, "127.0.0.1", () => connections.push("first"));
    const firstSocket = netModule.calls[0].socket;
    client.connect(8181, "127.0.0.1", () => connections.push("second"));
    const secondSocket = netModule.calls[1].socket;
    firstSocket.finishConnect();
    firstSocket.emit("data", Buffer.from("stale"));
    firstSocket.emit("close", false);
    secondSocket.finishConnect();
    secondSocket.emit("data", Buffer.from("current"));

    assert.equal(firstSocket.destroyed, true);
    assert.deepEqual(connections, ["second"]);
    assert.deepEqual(received, [Buffer.from("current")]);
    assert.equal(client.socket, secondSocket);
});
