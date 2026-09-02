const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createApplication, main, registerShutdownHandlers } = require("../src/index");

test("createApplication composes, starts, and stops runtime dependencies once", () => {
    const calls = [];
    const config = { discordToken: "token" };
    const gatewayIntentBits = {
        Guilds: 1,
        GuildMessages: 2,
        MessageContent: 3,
        GuildMembers: 4
    };
    const events = { ClientReady: "ready", MessageCreate: "message" };
    let discordOptions;
    let bridgeOptions;

    class FakeLogger {
        constructor(options) {
            calls.push(["logger:construct", options]);
        }

        close() {
            calls.push(["logger:close"]);
        }
    }

    class FakeHealthServer {
        start() {
            calls.push(["health:start"]);
        }

        stop() {
            calls.push(["health:stop"]);
        }
    }

    class FakeDiscordClient {
        constructor(options) {
            discordOptions = options;
        }
    }

    class FakeSocket {}

    class FakeBridge {
        constructor(options) {
            bridgeOptions = options;
        }

        start() {
            calls.push(["bridge:start"]);
        }

        stop() {
            calls.push(["bridge:stop"]);
        }
    }

    const loggerOptions = { overrideConsole: false };
    const application = createApplication({
        config,
        LoggerClass: FakeLogger,
        loggerOptions,
        HealthServerClass: FakeHealthServer,
        DiscordClientClass: FakeDiscordClient,
        gatewayIntentBits,
        events,
        SocketClass: FakeSocket,
        BridgeClass: FakeBridge
    });

    assert.deepEqual(discordOptions, { intents: [1, 2, 3, 4] });
    assert.equal(bridgeOptions.config, config);
    assert.equal(bridgeOptions.discordClient, application.discordClient);
    assert.equal(bridgeOptions.mudClient, application.mudClient);
    assert.equal(bridgeOptions.healthServer, application.healthServer);
    assert.equal(bridgeOptions.events, events);

    application.start();
    application.start();
    application.stop();
    application.stop();

    assert.deepEqual(calls, [
        ["logger:construct", loggerOptions],
        ["health:start"],
        ["bridge:start"],
        ["bridge:stop"],
        ["health:stop"],
        ["logger:close"]
    ]);
});

test("createApplication accepts prebuilt dependencies", () => {
    const calls = [];
    const dependencies = {
        logger: { close: () => calls.push("logger") },
        healthServer: {
            start: () => calls.push("health:start"),
            stop: () => calls.push("health:stop")
        },
        discordClient: {},
        mudClient: {},
        bridge: {
            start: () => calls.push("bridge:start"),
            stop: () => calls.push("bridge:stop")
        }
    };

    const application = createApplication({ config: {}, ...dependencies });
    application.start();
    application.stop();

    assert.equal(application.logger, dependencies.logger);
    assert.equal(application.healthServer, dependencies.healthServer);
    assert.equal(application.discordClient, dependencies.discordClient);
    assert.equal(application.mudClient, dependencies.mudClient);
    assert.equal(application.bridge, dependencies.bridge);
    assert.deepEqual(calls, [
        "health:start",
        "bridge:start",
        "bridge:stop",
        "health:stop",
        "logger"
    ]);
});

test("registerShutdownHandlers handles SIGTERM and exits cleanly", () => {
    const processRef = new EventEmitter();
    const exitCodes = [];
    const logs = [];
    let stops = 0;
    processRef.exit = code => exitCodes.push(code);

    const shutdown = registerShutdownHandlers(
        { stop: () => stops++ },
        processRef,
        { log: message => logs.push(message) }
    );

    processRef.emit("SIGTERM");

    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(logs, ["SIGTERM received, closing connections..."]);
    assert.equal(typeof shutdown, "function");
});

test("registerShutdownHandlers handles SIGINT", () => {
    const processRef = new EventEmitter();
    const exitCodes = [];
    const logs = [];
    let stops = 0;
    processRef.exit = code => exitCodes.push(code);

    registerShutdownHandlers(
        { stop: () => stops++ },
        processRef,
        { log: message => logs.push(message) }
    );
    processRef.emit("SIGINT");

    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(logs, ["SIGINT received, closing connections..."]);
});

test("main starts an injected application and registers shutdown handlers", () => {
    const processRef = new EventEmitter();
    processRef.exit = () => {};
    const calls = [];
    const application = main({
        applicationOptions: {
            config: {},
            logger: { close: () => calls.push("logger:close") },
            healthServer: {
                start: () => calls.push("health:start"),
                stop: () => calls.push("health:stop")
            },
            discordClient: {},
            mudClient: {},
            bridge: {
                start: () => calls.push("bridge:start"),
                stop: () => calls.push("bridge:stop")
            }
        },
        processRef,
        logger: { log: () => {} }
    });

    assert.ok(application);
    assert.deepEqual(calls, ["health:start", "bridge:start"]);
    assert.equal(processRef.listenerCount("SIGTERM"), 1);
    assert.equal(processRef.listenerCount("SIGINT"), 1);
});
