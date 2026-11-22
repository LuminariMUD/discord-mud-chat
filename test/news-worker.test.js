const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { ChannelType } = require("discord.js");
const { createNewsService } = require("../src/news-service");
const { createNewsPool, enqueueNews } = require("../src/news-store");
const { deliverNextNews, postNewsPart } = require("../src/news-worker");

const destination = "123456789012345678";
const firstMessage = "223456789012345678";
const secondMessage = "323456789012345678";
const parts = ["**Release**\n\n@everyone first", "remaining"];
const silent = { log() {}, error() {} };
const database = { socketPath: process.env.TEST_NEWS_DB_SOCKET, user: "root", database: "discord_news_test" };
const fixtureOnly = { skip: !database.socketPath };

async function makeSink(t) {
    const received = [];
    const replies = [];
    const server = createServer(async (request, response) => {
        const body = [];
        for await (const chunk of request) body.push(chunk);
        received.push({ path: request.url, token: request.headers.authorization, ...JSON.parse(Buffer.concat(body)) });
        const { status = 200, id = firstMessage, headers = {}, disconnect, retry_after } = replies.shift() || {};
        if (disconnect) return request.socket.destroy();
        response.writeHead(status, { "Content-Type": "application/json", ...headers });
        response.end(JSON.stringify({ id, retry_after }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const client = {
        user: {},
        token: "fixture-bot",
        isReady: () => true,
        rest: { options: { api: "http://127.0.0.1:" + server.address().port, version: "10" } },
        channels: {
            cache: new Map([[destination, { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }]])
        }
    };
    return { client, received, replies };
}

test("Discord sender checks the destination and suppresses mentions on an isolated sink", async t => {
    const { client, received, replies } = await makeSink(t);
    assert.deepEqual(await postNewsPart(client, "another-destination", parts[0]), {
        state: "retryable", failure: "check_destination_and_bot_permissions"
    });
    assert.equal(received.length, 0);
    assert.deepEqual(await postNewsPart(client, destination, parts[0]), { id: firstMessage });
    assert.deepEqual(received[0], {
        path: "/v10/channels/" + destination + "/messages",
        token: "Bot fixture-bot",
        content: parts[0],
        allowed_mentions: { parse: [] }
    });

    replies.push({ status: 429, headers: { "Retry-After": "2.25" } });
    assert.equal((await postNewsPart(client, destination, parts[0])).retryAfterMs, 2250);
    replies.push({ status: 429, retry_after: 3.5 }, { status: 403 }, { status: 502 }, { id: "" }, { disconnect: true });
    assert.equal((await postNewsPart(client, destination, parts[0])).retryAfterMs, 3500);
    assert.equal((await postNewsPart(client, destination, parts[0])).state, "retryable");
    assert.equal((await postNewsPart(client, destination, parts[0])).state, "needs_review");
    assert.equal((await postNewsPart(client, destination, parts[0])).failure, "discord_success_without_message_id");
    assert.equal((await postNewsPart(client, destination, parts[0])).failure, "discord_response_unknown");
    assert.equal(received.length, 7);
});

async function fixture(t, idDigit, testDestination = destination) {
    const id = idDigit.repeat(64);
    const pool = createNewsPool(database);
    t.after(async () => {
        await pool.query("DELETE FROM discord_news_delivery WHERE id = ?", [id]);
        await pool.end();
    });
    await pool.query("DELETE FROM discord_news_delivery WHERE id = ?", [id]);
    await enqueueNews(pool, { id, title: "Release", body: "Fixture" }, testDestination, parts);
    const row = async () => (await pool.query(
        "SELECT state, message_ids, failure, attempts, retry_at FROM discord_news_delivery WHERE id = ?", [id]
    ))[0];
    return { id, pool, row };
}

test("MariaDB serializes workers and resumes at the first unsent part after a definite rejection", fixtureOnly, async t => {
    const { id, pool, row } = await fixture(t, "2");
    const { client, received, replies } = await makeSink(t);
    const otherPool = createNewsPool(database);
    t.after(() => otherPool.end());
    let release;
    const unblocked = new Promise(resolve => { release = resolve; });
    let entered;
    const sending = new Promise(resolve => { entered = resolve; });
    const worker = {
        pool, destination, logger: silent,
        async send(channel, content) {
            entered();
            await unblocked;
            return postNewsPart(client, channel, content);
        }
    };

    const first = deliverNextNews(worker);
    await sending;
    try {
        assert.equal((await row()).state, "sending");
        await deliverNextNews({ ...worker, pool: otherPool, send: () => assert.fail("concurrent claim") });
    } finally {
        release();
        await first;
    }
    replies.push({ status: 403 });
    await deliverNextNews(worker);
    assert.equal((await row()).state, "retryable");
    assert.deepEqual(JSON.parse((await row()).message_ids), [firstMessage]);
    await deliverNextNews(worker);
    assert.equal(received.length, 2);

    await pool.query("UPDATE discord_news_delivery SET state = 'queued', attempts = 0, failure = NULL WHERE id = ?", [id]);
    replies.push({ id: secondMessage });
    await deliverNextNews({ ...worker, pool: otherPool });
    assert.equal((await row()).state, "delivered");
    assert.deepEqual(JSON.parse((await row()).message_ids), [firstMessage, secondMessage]);
    assert.deepEqual(received.map(message => message.content), [parts[0], parts[1], parts[1]]);
    await deliverNextNews(worker);
    assert.equal(received.length, 3);
});

test("MariaDB persists backoff, honors Retry-After, and stops after five 429 responses", fixtureOnly, async t => {
    const { id, pool, row } = await fixture(t, "3");
    const { client, replies, received } = await makeSink(t);
    const worker = { pool, destination, logger: silent, send: (channel, content) => postNewsPart(client, channel, content) };
    for (let i = 0; i < 5; i++) replies.push({ status: 429, headers: { "Retry-After": "60" } });
    await deliverNextNews(worker);
    assert.equal((await row()).state, "retryable");
    const seconds = (await pool.query(
        "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), retry_at) AS seconds FROM discord_news_delivery WHERE id = ?", [id]
    ))[0].seconds;
    assert.ok(seconds >= 59 && seconds <= 60);
    await deliverNextNews(worker);
    assert.equal(received.length, 1);
    for (let attempt = 2; attempt <= 5; attempt++) {
        await pool.query("UPDATE discord_news_delivery SET retry_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
        await deliverNextNews(worker);
        assert.equal((await row()).attempts, attempt);
    }
    assert.equal((await row()).retry_at, null);
    await deliverNextNews(worker);
    assert.equal(received.length, 5);
});

test("MariaDB surfaces an ambiguous POST or interrupted claim without replaying it", fixtureOnly, async t => {
    const { id, pool, row } = await fixture(t, "4");
    const { client, received, replies } = await makeSink(t);
    const worker = { pool, destination, logger: silent, send: (channel, content) => postNewsPart(client, channel, content) };
    replies.push({ disconnect: true });
    await deliverNextNews(worker);
    assert.equal((await row()).state, "needs_review");
    assert.equal((await row()).failure, "discord_response_unknown");
    await deliverNextNews(worker);
    assert.equal(received.length, 1);

    // The previous worker can disappear after issuing the POST and before recording an outcome.
    await pool.query("UPDATE discord_news_delivery SET state = 'sending' WHERE id = ?", [id]);
    await deliverNextNews(worker);
    assert.equal((await row()).state, "needs_review");
    assert.equal((await row()).failure, "unconfirmed_previous_send");
    assert.equal(received.length, 1);
});

test("the running news service delivers an accepted announcement to the configured route", fixtureOnly, async t => {
    const { client, received, replies } = await makeSink(t);
    const service = createNewsService({ database, channelId: destination, send: true }, client);
    assert.equal(await service.start(), undefined); // Delivery-only operation opens no intake listener.
    t.after(() => service.stop());
    const { row } = await fixture(t, "5");
    replies.push({ id: firstMessage }, { id: secondMessage });
    const deadline = Date.now() + 6000;
    while ((await row()).state !== "delivered" && Date.now() < deadline) await delay(50);
    assert.equal((await row()).state, "delivered");
    assert.equal(received.length, 2);
    assert.ok(received.every(message => message.path === "/v10/channels/" + destination + "/messages"));
});

test("Duris publishes verified in-game news once across a lost acknowledgement", {
    skip: !database.socketPath || !process.env.TEST_DURIS_ROOT || !process.env.TEST_DURIS_BINARY,
    timeout: 240000
}, async t => {
    const { client, received } = await makeSink(t);
    const secret = "journey-secret-".repeat(4);
    const service = createNewsService({ database, channelId: destination, host: "127.0.0.1",
        port: 0, enabled: true, send: true, secret }, client);
    const url = "http://127.0.0.1:" + (await service.start()).port;
    t.after(() => service.stop());

    const posted = [];
    const proxy = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const ack = await fetch(url + request.url, {
            method: request.method,
            headers: { authorization: request.headers.authorization, "content-type": "application/json" },
            body: Buffer.concat(chunks)
        });
        posted.push({ status: ack.status, ...await ack.json() });
        response.destroy(); // MariaDB committed, but the publisher sees a lost connection.
    });
    await new Promise(resolveListen => proxy.listen(0, "127.0.0.1", resolveListen));
    t.after(() => new Promise(resolveClose => proxy.close(resolveClose)));
    const { stdout } = await promisify(execFile)("bash", [
        "tests/async/with_disposable_mariadb.sh", "python3",
        resolve(__dirname, "../scripts/testing/duris-news-journey.py"),
        resolve(process.env.TEST_DURIS_BINARY)
    ], {
        cwd: process.env.TEST_DURIS_ROOT, timeout: 230000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", DURIS_DISCORD_NEWS_SECRET: secret, TEST_DURIS_NEWS_BRIDGE: url,
            TEST_DURIS_NEWS_OUTAGE: "http://127.0.0.1:" + proxy.address().port }
    });
    const id = stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.deepEqual(posted.map(item => [item.status, item.id]), [[202, id]]);
    const pool = createNewsPool(database);
    t.after(() => pool.end());
    const lookup = () => pool.query("SELECT * FROM discord_news_delivery WHERE id = ?", [id]);
    const deadline = Date.now() + 5000;
    while ((await lookup())[0]?.state !== "delivered" && Date.now() < deadline) await delay(50);
    const rows = await lookup();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "delivered");
    assert.ok(rows[0].body.includes("The verified news command shows this new entry."));
    assert.ok(!rows[0].body.includes("Yesterday"));
    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/v10/channels/" + destination + "/messages");
    assert.deepEqual(received[0].allowed_mentions, { parse: [] });
    assert.deepEqual(JSON.parse(rows[0].message_ids), [firstMessage]);
});
