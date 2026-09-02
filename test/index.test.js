const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createApplication, main, registerShutdownHandlers } = require("../src/index");

test("createApplication composes, starts, and stops runtime dependencies once", async () => {
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

    await Promise.all([application.start(), application.start()]);
    await application.stop();
    await application.stop();

    assert.deepEqual(calls, [
        ["logger:construct", loggerOptions],
        ["health:start"],
        ["bridge:start"],
        ["bridge:stop"],
        ["health:stop"],
        ["logger:close"]
    ]);
});

test("createApplication accepts prebuilt dependencies", async () => {
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
    await application.start();
    await application.stop();

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

test("createApplication configures the default MUD transport for TLS", () => {
    const application = createApplication({
        config: {
            mud_tls: true,
            mud_tls_servername: "mud.example.com"
        },
        logger: {},
        healthServer: {},
        discordClient: {},
        bridge: {}
    });

    assert.equal(application.mudClient.useTls, true);
    assert.equal(application.mudClient.servername, "mud.example.com");
});

test("createApplication enforces TLS policy before constructing runtime resources", () => {
    let loggerConstructed = false;

    class FakeLogger {
        constructor() {
            loggerConstructed = true;
        }
    }

    assert.throws(() => createApplication({
        config: { mud_ip: "mud.example.com", mud_tls: false },
        LoggerClass: FakeLogger,
        mudClient: {}
    }), /restricted to literal loopback addresses/);
    assert.equal(loggerConstructed, false);
});

test("createApplication stop is terminal before start", async () => {
    const calls = [];
    const application = createApplication({
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
    });

    await application.stop();
    await application.start();

    assert.deepEqual(calls, ["bridge:stop", "health:stop", "logger:close"]);
});

test("createApplication cleans up resources after partial startup", async () => {
    const calls = [];
    const application = createApplication({
        config: {},
        logger: { close: () => calls.push("logger:close") },
        healthServer: {
            start: () => calls.push("health:start"),
            stop: () => calls.push("health:stop")
        },
        discordClient: {},
        mudClient: {},
        bridge: {
            start: () => {
                calls.push("bridge:start");
                throw new Error("bridge start failed");
            },
            stop: () => calls.push("bridge:stop")
        }
    });

    await assert.rejects(application.start(), {
        message: "bridge start failed"
    });
    await application.start();

    assert.deepEqual(calls, [
        "health:start",
        "bridge:start",
        "bridge:stop",
        "health:stop",
        "logger:close"
    ]);
});

test("createApplication rolls back an asynchronous health startup failure", async () => {
    const calls = [];
    const startupError = Object.assign(new Error("health port unavailable"), {
        code: "EADDRINUSE"
    });
    const application = createApplication({
        config: {},
        logger: { close: () => calls.push("logger:close") },
        healthServer: {
            start: () => {
                calls.push("health:start");
                return Promise.reject(startupError);
            },
            stop: () => calls.push("health:stop")
        },
        discordClient: {},
        mudClient: {},
        bridge: {
            start: () => calls.push("bridge:start"),
            stop: () => calls.push("bridge:stop")
        }
    });

    await assert.rejects(application.start(), startupError);
    await application.start();

    assert.deepEqual(calls, [
        "health:start",
        "bridge:stop",
        "health:stop",
        "logger:close"
    ]);
});

test("createApplication reports both startup and rollback failures", async () => {
    const startupError = new Error("health start failed");
    const cleanupError = new Error("bridge stop failed");
    const application = createApplication({
        config: {},
        logger: { close() {} },
        healthServer: {
            start: () => Promise.reject(startupError),
            stop() {}
        },
        discordClient: {},
        mudClient: {},
        bridge: {
            start() {},
            stop: () => {
                throw cleanupError;
            }
        }
    });

    await assert.rejects(application.start(), error => {
        assert.equal(error.name, "AggregateError");
        assert.equal(error.message, "Application startup and rollback failed");
        assert.equal(error.cause.name, "AggregateError");
        assert.deepEqual(error.cause.errors, [cleanupError]);
        assert.deepEqual(error.errors, [startupError, cleanupError]);
        return true;
    });
});

test("createApplication waits for shutdown, coalesces stops, and prevents restart", async () => {
    const calls = [];
    let finishHealthStop;
    const healthStopped = new Promise(resolve => {
        finishHealthStop = resolve;
    });
    const application = createApplication({
        config: {},
        logger: { close: () => calls.push("logger:close") },
        healthServer: {
            start: () => calls.push("health:start"),
            stop: () => {
                calls.push("health:stop");
                return healthStopped;
            }
        },
        discordClient: {},
        mudClient: {},
        bridge: {
            start: () => calls.push("bridge:start"),
            stop: () => calls.push("bridge:stop")
        }
    });

    await application.start();
    const firstStop = application.stop();
    const secondStop = application.stop();
    await application.start();
    await Promise.resolve();

    assert.deepEqual(calls, [
        "health:start",
        "bridge:start",
        "bridge:stop",
        "health:stop"
    ]);

    finishHealthStop();
    await Promise.all([firstStop, secondStop]);
    assert.deepEqual(calls.slice(-1), ["logger:close"]);

    await application.start();
    assert.deepEqual(calls.slice(-1), ["logger:close"]);
});

test("createApplication completes every shutdown path after a partial failure", async () => {
    const calls = [];
    let bridgeStopAttempts = 0;
    const application = createApplication({
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
            stop: () => {
                calls.push("bridge:stop");
                bridgeStopAttempts++;
                if (bridgeStopAttempts === 1) throw new Error("bridge close failed");
            }
        }
    });

    await application.start();
    await assert.rejects(application.stop(), {
        name: "AggregateError",
        message: "Application shutdown failed"
    });
    await application.start();
    await application.stop();
    await application.stop();

    assert.deepEqual(calls, [
        "health:start",
        "bridge:start",
        "bridge:stop",
        "health:stop",
        "logger:close",
        "bridge:stop"
    ]);
});

test("createApplication retries a transient logger cleanup failure", async () => {
    const calls = [];
    let loggerCloseAttempts = 0;
    const application = createApplication({
        config: {},
        logger: {
            close: () => {
                calls.push("logger:close");
                loggerCloseAttempts++;
                if (loggerCloseAttempts === 1) throw new Error("logger close failed");
            }
        },
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
    });

    await application.start();
    await assert.rejects(application.stop(), {
        name: "AggregateError",
        message: "Application shutdown failed"
    });
    await application.stop();
    await application.stop();

    assert.deepEqual(calls, [
        "health:start",
        "bridge:start",
        "bridge:stop",
        "health:stop",
        "logger:close",
        "logger:close"
    ]);
});

test("registerShutdownHandlers handles SIGTERM and exits cleanly", async () => {
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

    await shutdown("SIGTERM");

    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(logs, ["SIGTERM received, closing connections..."]);
    assert.equal(typeof shutdown, "function");
});

test("registerShutdownHandlers handles SIGINT", async () => {
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
    await shutdown("SIGINT");

    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.deepEqual(logs, ["SIGINT received, closing connections..."]);
});

test("registerShutdownHandlers reports shutdown failures before exiting", async () => {
    const processRef = new EventEmitter();
    const exitCodes = [];
    const errors = [];
    processRef.exit = code => exitCodes.push(code);
    const shutdownError = new Error("close failed");
    const shutdown = registerShutdownHandlers(
        { stop: () => Promise.reject(shutdownError) },
        processRef,
        {
            log() {},
            error: (...args) => errors.push(args)
        }
    );

    await shutdown("SIGTERM");

    assert.deepEqual(exitCodes, [1]);
    assert.equal(errors[0][0], "Failed to shut down cleanly:");
    assert.equal(errors[0][1], shutdownError);
});

test("main starts an injected application and registers shutdown handlers", async () => {
    const processRef = new EventEmitter();
    processRef.exit = () => {};
    const calls = [];
    const application = await main({
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
