const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DiscordDelivery, MAX_PENDING_DISCORD_EVENTS, MAX_PENDING_DISCORD_BYTES } = require("../src/discord-delivery");

function harness() {
    const stats = { sent: 0, dropped: 0, errors: [] };
    const delivery = new DiscordDelivery({
        onSent: () => stats.sent++, onDrop: () => stats.dropped++,
        logger: { error: (...args) => stats.errors.push(args) }
    });
    return { delivery, stats };
}

function controlledChannel() {
    const calls = [];
    return { calls, send(payload) {
        return new Promise((resolve, reject) => calls.push({ payload, resolve, reject }));
    } };
}

async function settled() {
    await new Promise(resolve => setImmediate(resolve));
}

test("long content includes the prefix and preserves code points, mentions and order", async () => {
    for (const content of ["A".repeat(2000), "Staff -> Player: " + "x".repeat(1983) + "🔥尾".repeat(1500),
        "Z".repeat(4001), "A: @everyone <@123> \\ \" " + "é".repeat(2300), "bad \ud800 tail"]) {
        const { delivery, stats } = harness();
        const payloads = [];
        delivery.enqueue("one", { async send(payload) { payloads.push(payload); } }, content);
        await settled();
        assert.equal(payloads.map(p => p.content).join(""), content.toWellFormed());
        for (const payload of payloads) {
            assert.ok(payload.content.length <= 2000);
            assert.ok(payload.content.isWellFormed());
            assert.deepEqual(payload.allowedMentions, { parse: [] });
        }
        assert.equal(stats.sent, payloads.length);
        assert.equal(delivery.pendingBytes, 0);
        assert.equal(delivery.pendingEvents, 0);
        assert.equal(delivery.queues.size, 0);
    }
});

test("per-channel ordering prevents later events interleaving and slow channels stay independent", async () => {
    const { delivery, stats } = harness();
    const one = controlledChannel(), two = controlledChannel();
    delivery.enqueue("one", one, "x".repeat(2001));
    delivery.enqueue("one", one, "later");
    delivery.enqueue("two", two, "independent");
    assert.equal(one.calls.length, 1);
    assert.equal(two.calls.length, 1);
    assert.equal(stats.sent, 0);
    one.calls[0].resolve();
    await settled();
    assert.equal(one.calls[1].payload.content, "x");
    assert.equal(one.calls.length, 2);
    one.calls[1].resolve();
    await settled();
    assert.equal(one.calls[2].payload.content, "later");
    one.calls[2].resolve();
    two.calls[0].resolve();
    await settled();
    assert.equal(stats.sent, 4);
    assert.equal(delivery.pendingEvents, 0);
});

test("queue event limit includes the in-flight event and rejects a whole new delivery", async () => {
    const { delivery, stats } = harness();
    const channel = controlledChannel();
    for (let i = 0; i < MAX_PENDING_DISCORD_EVENTS; i++) assert.ok(delivery.enqueue("one", channel, "x"));
    assert.equal(delivery.enqueue("one", channel, "not admitted"), false);
    assert.equal(channel.calls.length, 1);
    assert.equal(delivery.pendingEvents, MAX_PENDING_DISCORD_EVENTS);
    assert.equal(stats.dropped, 1);
    delivery.close();
    delivery.close();
    assert.equal(delivery.pendingBytes, 0);
    assert.equal(delivery.pendingEvents, 0);
    assert.equal(stats.dropped, MAX_PENDING_DISCORD_EVENTS + 1);
    channel.calls[0].resolve();
    await settled();
    assert.equal(channel.calls.length, 1);
    assert.equal(stats.sent, 1); // an already-issued request can complete after stop
    assert.equal(delivery.pendingBytes, 0);
    assert.equal(delivery.enqueue("one", channel, "after stop"), false);
});

test("queue byte limit uses UTF-8 bytes globally and retains partial events", async () => {
    const { delivery, stats } = harness();
    const one = controlledChannel(), two = controlledChannel();
    const first = "🔥".repeat(MAX_PENDING_DISCORD_BYTES / 8);
    assert.equal(delivery.enqueue("one", one, first), true);
    assert.equal(delivery.enqueue("two", two, first), true);
    assert.equal(delivery.pendingBytes, MAX_PENDING_DISCORD_BYTES);
    assert.equal(delivery.enqueue("one", one, "x"), false);
    one.calls[0].resolve();
    await settled();
    assert.equal(delivery.pendingBytes, MAX_PENDING_DISCORD_BYTES);
    assert.equal(delivery.enqueue("one", one, "x"), false);
    one.calls[1].reject(new Error("request body must not be logged"));
    await settled();
    assert.equal(delivery.pendingBytes, MAX_PENDING_DISCORD_BYTES / 2);
    assert.equal(delivery.enqueue("one", one, "recovered"), true);
    assert.ok(!JSON.stringify(stats.errors).includes("request body"));
    delivery.close();
    two.calls[0].reject(new Error("token must not be logged"));
    one.calls[2].resolve();
    await settled();
    assert.equal(delivery.pendingBytes, 0);
    assert.ok(!JSON.stringify(stats.errors).includes("token"));
});

test("failed sends drop remaining parts without replay and later events still run", async () => {
    const { delivery, stats } = harness();
    const channel = controlledChannel();
    delivery.enqueue("one", channel, "a".repeat(4001));
    delivery.enqueue("one", channel, "next event");
    channel.calls[0].resolve();
    await settled();
    channel.calls[1].reject(new Error("private content"));
    await settled();
    assert.equal(channel.calls[2].payload.content, "next event");
    channel.calls[2].resolve();
    await settled();
    assert.equal(channel.calls.length, 3);
    assert.equal(stats.sent, 2);
    assert.equal(stats.dropped, 1);
    assert.equal(delivery.pendingEvents, 0);
    assert.ok(!JSON.stringify(stats.errors).includes("private content"));
    delivery.enqueue("one", { send() { throw new Error("sync request body"); } }, "synchronous failure");
    assert.equal(stats.dropped, 2);
    assert.equal(delivery.queues.size, 0);
});

test("empty emotes and whitespace-only chunks cannot create empty Discord posts", async () => {
    const { delivery, stats } = harness();
    const payloads = [];
    const channel = { async send(payload) { payloads.push(payload); } };
    assert.equal(delivery.enqueue("one", channel, " \n\t"), false);
    assert.equal(delivery.enqueue("one", channel, ""), false);
    assert.equal(delivery.enqueue("one", channel, "A".repeat(2000) + " ".repeat(2000) + "B"), true);
    await settled();
    assert.deepEqual(payloads.map(p => p.content), ["A".repeat(2000), "B"]);
    assert.equal(stats.sent, 2);
    assert.equal(stats.dropped, 2);
});
