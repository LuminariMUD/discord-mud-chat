const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const {
    ChatBridge,
    DEFAULT_MAX_MUD_RECORD_BYTES,
    HEARTBEAT_INTERVAL_MS,
    RATE_LIMIT_RETENTION_MS,
    stripEmoji
} = require("../src/bridge");

class FakeMudClient extends EventEmitter {
    constructor() {
        super();
        this.connectCalls = [];
        this.writes = [];
        this.destroyed = false;
        this.encrypted = true;
    }

    connect(port, host, callback) {
        this.connectCalls.push({ port, host, callback });
    }

    completeConnection(index = this.connectCalls.length - 1) {
        this.connectCalls[index].callback();
    }

    write(value) {
        this.writes.push(value);
    }

    destroy() {
        this.destroyed = true;
    }
}

class FakeDiscordClient extends EventEmitter {
    constructor() {
        super();
        this.loginCalls = [];
        this.fetchCalls = [];
        this.sentMessages = [];
        this.destroyed = false;
        this.channels = {
            cache: new Map(),
            fetch: id => {
                this.fetchCalls.push(id);
                return Promise.resolve({
                    id,
                    name: `channel-${id}`,
                    guild: { id: "guild-1", name: "Guild One" }
                });
            }
        };
    }

    login(token) {
        this.loginCalls.push(token);
        return Promise.resolve();
    }

    addChannel(id) {
        this.channels.cache.set(id, {
            send: message => {
                this.sentMessages.push({ id, message });
                return Promise.resolve();
            }
        });
    }

    destroy() {
        this.destroyed = true;
    }
}

class FakeHealthServer {
    constructor() {
        this.mudConnected = [];
        this.discordConnected = [];
        this.mudToDiscord = 0;
        this.discordToMud = 0;
    }

    setMudConnected(value) {
        this.mudConnected.push(value);
    }

    setDiscordConnected(value) {
        this.discordConnected.push(value);
    }

    incrementMudToDiscord() {
        this.mudToDiscord++;
    }

    incrementDiscordToMud() {
        this.discordToMud++;
    }
}

/** Creates deterministic timer fakes for bridge lifecycle tests. */
function createFakeTimers() {
    const intervals = [];
    const timeouts = [];
    const clearedIntervals = [];
    const clearedTimeouts = [];

    return {
        intervals,
        timeouts,
        clearedIntervals,
        clearedTimeouts,
        setInterval(callback, delay) {
            const handle = { callback, delay, type: "interval" };
            intervals.push(handle);
            return handle;
        },
        clearInterval(handle) {
            clearedIntervals.push(handle);
        },
        setTimeout(callback, delay) {
            const handle = { callback, delay, type: "timeout" };
            timeouts.push(handle);
            return handle;
        },
        clearTimeout(handle) {
            clearedTimeouts.push(handle);
        }
    };
}

/** Creates a ChatBridge test harness with injectable configuration overrides. */
function createHarness(overrides = {}) {
    const config = {
        mud_name: "TestMUD",
        mud_ip: "127.0.0.1",
        mud_port: 8181,
        mud_auth_token: "secret",
        mud_retry_count: 3,
        mud_retry_delay: 250,
        mud_infinite_retries: false,
        rate_limit_per_channel: 10,
        channels: [
            { discord: "discord-1", mud: "gossip" },
            { discord: "discord-2", mud: "auction" }
        ],
        strip_emoji: true,
        largest_printable_string: 100,
        discordToken: "discord-token",
        ...overrides.config
    };
    const mudClient = new FakeMudClient();
    if (overrides.mudEncrypted !== undefined) {
        mudClient.encrypted = overrides.mudEncrypted;
    }
    const discordClient = new FakeDiscordClient();
    const healthServer = new FakeHealthServer();
    const timers = createFakeTimers();
    const clock = { value: overrides.now || 1000 };
    const logs = [];
    const errors = [];
    const logger = {
        log: (...args) => logs.push(args),
        error: (...args) => errors.push(args)
    };
    const events = {
        ClientReady: "clientReady",
        MessageCreate: "messageCreate"
    };
    const bridge = new ChatBridge({
        config,
        discordClient,
        mudClient,
        healthServer,
        events,
        logger,
        timers,
        now: () => clock.value
    });

    return {
        bridge,
        clock,
        config,
        discordClient,
        errors,
        healthServer,
        logs,
        mudClient,
        timers
    };
}

/** Creates a representative Discord message with optional field overrides. */
function createDiscordMessage(overrides = {}) {
    return {
        content: "Hello from Discord",
        channel: { id: "discord-1" },
        author: { id: "user-1" },
        member: {
            id: "user-1",
            nickname: "Hero",
            user: { id: "user-1", bot: false, username: "Player" }
        },
        guild: {
            members: {
                cache: new Map([["123", {
                    displayName: "member-123",
                    user: { username: "user-123" }
                }]])
            }
        },
        ...overrides
    };
}

/** Parses all newline-delimited writes captured by the fake MUD client. */
function parsedWrites(mudClient) {
    return mudClient.writes.map(value => JSON.parse(value));
}

/** Encodes one MUD record using the bridge's newline-delimited protocol. */
function mudRecord(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`);
}

test("stripEmoji removes custom Discord and Unicode emoji", () => {
    assert.equal(stripEmoji("Hero🔥<:wave:12345678901234567><a:dance:12345678901234567890>"), "Hero");
    assert.equal(stripEmoji("plain text"), "plain text");
});

test("start binds events, logs into Discord, and connects to the configured MUD", () => {
    const { bridge, config, discordClient, mudClient } = createHarness();

    bridge.start();
    bridge.bindEvents();

    assert.deepEqual(discordClient.loginCalls, [config.discordToken]);
    assert.deepEqual(
        mudClient.connectCalls.map(({ port, host }) => ({ port, host })),
        [{ port: config.mud_port, host: config.mud_ip }]
    );
    assert.equal(mudClient.listenerCount("data"), 1);
    assert.equal(discordClient.listenerCount("messageCreate"), 1);
});

test("a MUD connection authenticates, updates health, and starts heartbeats", () => {
    const { bridge, healthServer, logs, mudClient, timers } = createHarness();

    bridge.start();
    bridge.retries = 2;
    const previousHeartbeat = { type: "previous-heartbeat" };
    bridge.heartbeatInterval = previousHeartbeat;
    mudClient.completeConnection();

    assert.equal(bridge.retries, 0);
    assert.deepEqual(healthServer.mudConnected, [true]);
    assert.deepEqual(parsedWrites(mudClient), [
        { channel: "auth", name: "bot", message: "secret" }
    ]);
    assert.deepEqual(timers.clearedIntervals, [previousHeartbeat]);
    assert.equal(timers.intervals[0].delay, HEARTBEAT_INTERVAL_MS);

    timers.intervals[0].callback();
    assert.deepEqual(parsedWrites(mudClient)[1], {
        channel: "heartbeat",
        name: "bot",
        message: "ping"
    });
    assert.ok(logs.some(args => args[0] === "Heartbeat sent to MUD"));
});

test("a MUD connection skips authentication when no token is configured", () => {
    const { bridge, mudClient } = createHarness({ config: { mud_auth_token: "" } });

    bridge.start();
    mudClient.completeConnection();

    assert.deepEqual(mudClient.writes, []);
});

test("a MUD authentication token is never sent over plaintext", () => {
    const { bridge, errors, mudClient } = createHarness({ mudEncrypted: false });

    bridge.start();
    mudClient.completeConnection();

    assert.deepEqual(mudClient.writes, []);
    assert.ok(errors.some(args => String(args[0]).includes("not using TLS")));
});

test("MUD messages relay to mapped Discord channels with emote formatting", async () => {
    const { bridge, discordClient, healthServer } = createHarness();
    discordClient.addChannel("discord-1");

    assert.equal(bridge.handleMudData(mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "Hello",
        emoted: 0
    })), true);
    assert.equal(bridge.handleMudData(mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "waves",
        emoted: 1
    })), true);

    assert.deepEqual(discordClient.sentMessages, [
        {
            id: "discord-1",
            message: {
                content: "Ayla: Hello",
                allowedMentions: { parse: [] }
            }
        },
        {
            id: "discord-1",
            message: {
                content: "waves",
                allowedMentions: { parse: [] }
            }
        }
    ]);
    await Promise.resolve();
    assert.equal(healthServer.mudToDiscord, 2);
});

test("Discord login and channel delivery failures are logged", async () => {
    const { bridge, discordClient, errors, healthServer } = createHarness();
    discordClient.login = token => {
        discordClient.loginCalls.push(token);
        return Promise.reject(new Error("login rejected"));
    };
    discordClient.channels.cache.set("discord-1", {
        send: () => Promise.reject(new Error("send rejected"))
    });

    bridge.start();
    assert.equal(bridge.handleMudData(mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "Hello"
    })), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(healthServer.mudToDiscord, 0);
    assert.ok(errors.some(args => String(args[0]).includes("log in to Discord")));
    assert.ok(errors.some(args => String(args[0]).includes("discord-1")));
});

test("split and coalesced MUD records are relayed without corrupting Unicode", async () => {
    const { bridge, discordClient, healthServer } = createHarness();
    discordClient.addChannel("discord-1");
    const firstRecord = mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "Hello 🔥"
    });
    const emojiOffset = firstRecord.indexOf(Buffer.from("🔥"));
    const secondRecord = mudRecord({
        channel: "gossip",
        name: "Borin",
        message: "Second"
    });

    assert.equal(bridge.handleMudData(firstRecord.subarray(0, emojiOffset + 1)), false);
    assert.equal(bridge.handleMudData(Buffer.concat([
        firstRecord.subarray(emojiOffset + 1),
        secondRecord
    ])), true);
    await Promise.resolve();

    assert.deepEqual(discordClient.sentMessages.map(({ message }) => message.content), [
        "Ayla: Hello 🔥",
        "Borin: Second"
    ]);
    assert.equal(healthServer.mudToDiscord, 2);
    assert.equal(bridge.mudDataBuffer, "");
});

test("oversized incomplete MUD records close the connection", () => {
    const { bridge, errors, mudClient } = createHarness({
        config: { mud_max_record_bytes: 8 }
    });

    assert.equal(bridge.handleMudData(Buffer.from("12345678")), false);
    assert.equal(mudClient.destroyed, false);
    assert.equal(bridge.mudDataBuffer, "12345678");

    assert.equal(bridge.handleMudData(Buffer.from("9")), false);
    assert.equal(mudClient.destroyed, true);
    assert.equal(bridge.mudDataBuffer, "");
    assert.ok(errors.some(args => String(args[0]).includes("exceeded 8 bytes")));
    assert.equal(DEFAULT_MAX_MUD_RECORD_BYTES, 1024 * 1024);
});

test("complete MUD records are relayed before an oversized trailing fragment closes the connection", () => {
    const { bridge, discordClient, mudClient } = createHarness({
        config: { mud_max_record_bytes: 128 }
    });
    discordClient.addChannel("discord-1");
    const completeRecord = mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "Hello"
    });

    assert.equal(bridge.handleMudData(Buffer.concat([
        completeRecord,
        Buffer.alloc(129, "x")
    ])), true);

    assert.deepEqual(discordClient.sentMessages.map(({ message }) => message.content), ["Ayla: Hello"]);
    assert.equal(mudClient.destroyed, true);
    assert.equal(bridge.mudDataBuffer, "");
});

test("oversized complete MUD records close the connection without being parsed", () => {
    const { bridge, errors, mudClient } = createHarness({
        config: { mud_max_record_bytes: 8 }
    });

    assert.equal(bridge.handleMudData(Buffer.from("123456789\n")), false);
    assert.equal(mudClient.destroyed, true);
    assert.ok(errors.some(args => String(args[0]).includes("record exceeded 8 bytes")));
});

test("invalid, unmapped, and unavailable MUD messages are ignored", () => {
    const { bridge, discordClient, errors, healthServer } = createHarness();

    assert.equal(bridge.handleMudData(Buffer.from("not json\n")), false);
    assert.equal(bridge.handleMudData(mudRecord({
        channel: "unknown",
        name: "Ayla",
        message: "Hello"
    })), false);
    assert.equal(bridge.handleMudData(mudRecord({
        channel: "gossip",
        name: "Ayla",
        message: "Hello"
    })), false);

    assert.equal(errors.length, 1);
    assert.deepEqual(discordClient.sentMessages, []);
    assert.equal(healthServer.mudToDiscord, 0);
});

test("a clean MUD close clears the heartbeat and schedules reconnection", () => {
    const { bridge, healthServer, mudClient, timers } = createHarness();
    bridge.start();
    mudClient.completeConnection();

    mudClient.emit("close", false);

    assert.deepEqual(healthServer.mudConnected, [true, false]);
    assert.equal(timers.clearedIntervals.length, 1);
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.timeouts[0].delay, 250);

    timers.timeouts[0].callback();
    assert.equal(mudClient.connectCalls.length, 2);
    assert.equal(bridge.reconnectTimeouts.size, 0);
});

test("an error close does not duplicate error-handler reconnection", () => {
    const { bridge, mudClient, timers } = createHarness();
    bridge.start();

    mudClient.emit("close", true);

    assert.equal(timers.timeouts.length, 0);
});

test("infinite retry mode coalesces overlapping reconnect attempts", () => {
    const { bridge, errors, timers } = createHarness({
        config: { mud_infinite_retries: true }
    });

    bridge.handleMudError(new Error("offline"));
    bridge.handleMudError(new Error("still offline"));

    assert.equal(bridge.retries, 1);
    assert.equal(timers.timeouts.length, 1);
    assert.equal(errors.length, 2);

    timers.timeouts[0].callback();
    bridge.handleMudError(new Error("offline again"));
    assert.equal(bridge.retries, 2);
    assert.equal(timers.timeouts.length, 2);
});

test("reconnect scheduling returns the existing pending attempt", () => {
    const { bridge, timers } = createHarness();

    const firstReconnect = bridge.scheduleReconnect();
    const secondReconnect = bridge.scheduleReconnect();

    assert.equal(secondReconnect, firstReconnect);
    assert.equal(timers.timeouts.length, 1);
});

test("finite retry mode stops and resets at the configured limit", () => {
    const { bridge, errors, timers } = createHarness({
        config: { mud_infinite_retries: false, mud_retry_count: 2 }
    });

    bridge.handleMudError(new Error("offline"));
    bridge.handleMudError(new Error("still offline"));
    timers.timeouts[0].callback();
    bridge.handleMudError(new Error("offline after retry"));

    assert.equal(timers.timeouts.length, 1);
    assert.equal(bridge.retries, 0);
    assert.ok(errors.some(args => String(args[0]).includes("Max retries (2)")));
});

test("Discord readiness updates health and fetches configured channels", async () => {
    const { bridge, discordClient, healthServer, logs } = createHarness();

    const channels = await bridge.handleDiscordReady({ user: { tag: "Bridge#0001" } });

    assert.deepEqual(healthServer.discordConnected, [true]);
    assert.deepEqual(discordClient.fetchCalls, ["discord-1", "discord-2"]);
    assert.equal(channels.length, 2);
    assert.ok(logs.some(args => String(args[0]).includes("Bridge#0001")));
    assert.ok(logs.some(args => String(args[0]).includes("Guild One")));
});

test("Discord readiness logs channel fetch failures without rejecting", async () => {
    const { bridge, discordClient, errors } = createHarness();
    discordClient.channels.fetch = id => id === "discord-1"
        ? Promise.resolve({ id, name: "gossip", guild: { id: "guild-1", name: "Guild" } })
        : Promise.reject(new Error("missing access"));

    const channels = await bridge.handleDiscordReady({ user: { tag: "Bridge#0001" } });

    assert.equal(channels[0].id, "discord-1");
    assert.equal(channels[1], undefined);
    assert.ok(errors.some(args => String(args[0]).includes("discord-2")));
});

test("Discord messages are sanitized and relayed to the mapped MUD channel", () => {
    const { bridge, healthServer, mudClient } = createHarness();
    const message = createDiscordMessage({
        content: "Hello @everyone and <@!123> 🔥",
        member: {
            nickname: "Hero🔥",
            user: { bot: false, username: "Player" }
        },
        guild: {
            members: {
                cache: new Map([["123", { displayName: "Ayla" }]])
            }
        }
    });

    assert.equal(bridge.handleDiscordMessage(message), true);
    assert.deepEqual(parsedWrites(mudClient), [{
        name: "Hero",
        channel: "gossip",
        message: "Hello [mention removed] and Ayla "
    }]);
    assert.equal(healthServer.discordToMud, 1);
});

test("Discord relay falls back to the account username and can retain emoji", () => {
    const { bridge, mudClient } = createHarness({ config: { strip_emoji: false } });
    const message = createDiscordMessage({
        content: "Hello 🔥",
        member: {
            nickname: "",
            user: { bot: false, username: "Player🔥" }
        }
    });

    assert.equal(bridge.handleDiscordMessage(message), true);
    assert.deepEqual(parsedWrites(mudClient)[0], {
        name: "Player🔥",
        channel: "gossip",
        message: "Hello 🔥"
    });
});

test("Discord relay retains unknown mentions and supports legacy member lookup", () => {
    const { bridge, mudClient } = createHarness();
    const message = createDiscordMessage({
        content: "Known <@123>, legacy <@456>, unknown <@999>",
        guild: {
            members: {
                cache: new Map([["123", { user: { username: "ModernUser" } }]])
            },
            member: id => id === "456" ? { username: "LegacyUser" } : undefined
        }
    });

    assert.equal(bridge.handleDiscordMessage(message), true);
    assert.equal(
        parsedWrites(mudClient)[0].message,
        "Known ModernUser, legacy LegacyUser, unknown <@999>"
    );
});

test("Discord message guards reject unsafe or irrelevant messages", async t => {
    const cases = [
        ["empty content", createDiscordMessage({ content: "" }), {}],
        ["bot author", createDiscordMessage({
            member: { nickname: "Bot", user: { bot: true, username: "Bot" } }
        }), {}],
        ["oversized content", createDiscordMessage({ content: "123456" }), {
            largest_printable_string: 5
        }],
        ["unmapped channel", createDiscordMessage({ channel: { id: "other" } }), {}],
        ["message without a guild member", createDiscordMessage({ member: null }), {}],
        ["emoji-only author", createDiscordMessage({
            member: { nickname: "🔥", user: { bot: false, username: "Player" } }
        }), {}],
        ["emoji-only content", createDiscordMessage({ content: "🔥" }), {}]
    ];

    for (const [name, message, config] of cases) {
        await t.test(name, () => {
            const { bridge, healthServer, mudClient } = createHarness({ config });

            assert.equal(bridge.handleDiscordMessage(message), false);
            assert.deepEqual(mudClient.writes, []);
            assert.equal(healthServer.discordToMud, 0);
        });
    }
});

test("rate limiting rejects bursts and accepts the configured boundary", () => {
    const { bridge, clock, logs, mudClient } = createHarness();
    const message = createDiscordMessage();

    assert.equal(bridge.handleDiscordMessage(message), true);
    clock.value = 1050;
    assert.equal(bridge.handleDiscordMessage(message), false);
    clock.value = 1100;
    assert.equal(bridge.handleDiscordMessage(message), true);

    assert.equal(mudClient.writes.length, 2);
    assert.ok(logs.some(args => String(args[0]).includes("Rate limit exceeded")));
});

test("rate limiting uses stable Discord account IDs instead of mutable nicknames", () => {
    const { bridge, mudClient } = createHarness();
    const renamedUser = createDiscordMessage({
        author: { id: "user-1" },
        member: {
            id: "user-1",
            nickname: "Renamed Hero",
            user: { id: "user-1", bot: false, username: "Player" }
        }
    });
    const differentUser = createDiscordMessage({
        author: { id: "user-2" },
        member: {
            id: "user-2",
            nickname: "Hero",
            user: { id: "user-2", bot: false, username: "OtherPlayer" }
        }
    });

    assert.equal(bridge.handleDiscordMessage(createDiscordMessage()), true);
    assert.equal(bridge.handleDiscordMessage(renamedUser), false);
    assert.equal(bridge.handleDiscordMessage(differentUser), true);
    assert.equal(mudClient.writes.length, 2);
});

test("rate-limit cleanup removes stale entries once the map grows", () => {
    const { bridge } = createHarness();
    const now = RATE_LIMIT_RETENTION_MS + 5000;

    for (let index = 0; index < 101; index++) {
        bridge.rateLimits.set(`old-${index}`, 1);
    }
    bridge.rateLimits.set("recent", now);

    bridge.cleanRateLimits(now);

    assert.deepEqual([...bridge.rateLimits], [["recent", now]]);
});

test("stop cancels timers and destroys both clients", async () => {
    const { bridge, discordClient, healthServer, mudClient, timers } = createHarness({
        config: { mud_infinite_retries: true }
    });
    bridge.start();
    mudClient.completeConnection();
    bridge.handleMudError(new Error("offline"));

    await bridge.stop();
    timers.timeouts[0].callback();

    assert.equal(discordClient.destroyed, true);
    assert.equal(mudClient.destroyed, true);
    assert.deepEqual(healthServer.mudConnected.slice(-1), [false]);
    assert.deepEqual(healthServer.discordConnected.slice(-1), [false]);
    assert.equal(timers.clearedIntervals.length, 1);
    assert.equal(timers.clearedTimeouts.length, 1);
    assert.equal(mudClient.connectCalls.length, 1);
});

test("late connection callbacks and errors cannot restart a stopped bridge", async () => {
    const { bridge, discordClient, healthServer, mudClient, timers } = createHarness();
    bridge.start();
    await bridge.stop();

    mudClient.completeConnection();
    bridge.handleMudError(new Error("late error"));
    discordClient.emit("clientReady", { user: { tag: "Late#0001" } });
    discordClient.emit("messageCreate", createDiscordMessage());

    assert.deepEqual(healthServer.mudConnected, [false]);
    assert.deepEqual(healthServer.discordConnected, [false]);
    assert.deepEqual(mudClient.writes, []);
    assert.deepEqual(timers.intervals, []);
    assert.deepEqual(timers.timeouts, []);
    assert.equal(mudClient.listenerCount("data"), 0);
    assert.equal(discordClient.listenerCount("messageCreate"), 0);
});

test("stop retries failed cleanup without repeating successful transport closes", async () => {
    const { bridge, discordClient, mudClient } = createHarness();
    let discordDestroyAttempts = 0;
    let mudDestroyAttempts = 0;
    discordClient.destroy = () => {
        discordDestroyAttempts++;
        if (discordDestroyAttempts === 1) throw new Error("Discord close failed");
    };
    mudClient.destroy = () => {
        mudDestroyAttempts++;
        mudClient.destroyed = true;
    };

    await assert.rejects(bridge.stop(), {
        name: "AggregateError",
        message: "Bridge shutdown failed"
    });
    assert.equal(mudClient.destroyed, true);
    await bridge.stop();
    await bridge.stop();

    assert.equal(discordDestroyAttempts, 2);
    assert.equal(mudDestroyAttempts, 1);
});
