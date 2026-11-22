const assert = require("node:assert/strict");
const { test } = require("node:test");
const { request } = require("node:http");
const { loadNewsConfig } = require("../config/news-config");
const { createNewsIntake, renderNews } = require("../src/news-intake");
const { createNewsPool } = require("../src/news-store");

const secret = "b".repeat(64);
const channelId = "123456789012345678";
const announcement = { id: "a".repeat(64), title: "Patch *notes*", body: "Highlights\n\n- More at https://example.com/a." };
const config = { host: "127.0.0.1", port: 0, channelId, secret };
const silent = { log() {}, error() {} };

function post(port, data, headers = {}, { path = "/v1/announcements/news", method = "POST", raw = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = request({
            host: "127.0.0.1", port, method, path,
            headers: { authorization: "Bearer " + secret, "content-type": "application/json", ...headers }
        }, async response => {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks)) });
        });
        req.on("error", reject);
        req.end(raw ? data : JSON.stringify(data));
    });
}

test("news requires explicit and complete loopback configuration", () => {
    const template = {
        enabled: true, channel_id: channelId, database: { name: "news", user: "bridge" }
    };
    const env = { DISCORD_NEWS_INGEST_SECRET: secret, DISCORD_NEWS_DB_PASSWORD: "test" };
    assert.equal(loadNewsConfig({}, env), undefined);
    assert.equal(loadNewsConfig({ news: { enabled: false } }, env), undefined);
    assert.throws(() => loadNewsConfig({ news: { enabled: "true" } }, env), /boolean/);
    for (const [changes, error] of [
        [{ host: "0.0.0.0" }, /127\.0\.0\.1 or ::1/],
        [{ port: 0 }, /valid port/],
        [{ channel_id: 99 }, /channel ID/],
        [{ database: {} }, /database.name/],
        [{ database: { ...template.database, port: -1 } }, /host and port/],
        [{ database: { ...template.database, socket_path: "" } }, /socket_path/]
    ]) {
        assert.throws(() => loadNewsConfig({ news: { ...template, ...changes } }, env), error);
    }
    assert.throws(() => loadNewsConfig(
        { news: template, channels: [{ discord: channelId }] }, env
    ), /separate from/);
    assert.throws(() => loadNewsConfig({ news: { ...template, secret } }, {}), /INGEST_SECRET/);
    const loaded = loadNewsConfig({ news: { ...template, host: "::1" }, channels: [] }, env);
    assert.equal(loaded.host, "::1");
    assert.equal(loaded.port, 3181);
    assert.equal(loaded.database.password, "test");
});

test("news renders paragraphs, escaped Discord syntax, usable links and UTF-16 chunks", () => {
    const [message] = renderNews({
        title: announcement.title,
        body: announcement.body + "\r\n- https://example.com/wiki/A_(B))\r\n" + "\x60code\x60 <@123>"
    });
    assert.match(message, /^\*\*Patch \\\*notes\\\*\*\*\n\nHighlights\n\n/);
    assert.ok(message.includes("\\- More at <https://example.com/a>\\."));
    assert.ok(message.includes("<https://example.com/wiki/A_(B)>\\)"));
    assert.ok(message.includes("\\\x60code\\\x60 \\<@123\\>"));
    const emoji = String.fromCodePoint(0x1f680);
    const parts = renderNews({ title: "Update", body: "x" + emoji.repeat(2001) + " done" });
    assert.equal(parts.length, 4);
    assert.ok(parts.every(part => part.length <= 2000 && part.isWellFormed()));
    assert.equal(parts.join("").split(emoji).length - 1, 2001);
});

test("loopback intake validates requests, acknowledges only after the store, and reports failures", async t => {
    let available = true;
    const rows = new Map();
    const pool = {
        async query(sql, [id, destination, title, body, parts]) {
            if (!available) throw Error("test storage outage");
            if (sql.startsWith("SELECT")) return [rows.get(id)];
            if (rows.has(id)) throw Object.assign(Error("duplicate"), { code: "ER_DUP_ENTRY" });
            rows.set(id, { destination, title, body, parts: JSON.parse(parts), state: "queued" });
        }
    };
    const errors = [];
    const intake = createNewsIntake({ config, pool, logger: { log() {}, error: line => errors.push(line) } });
    t.after(() => intake.stop());
    const { port } = await intake.start();
    assert.equal((await post(port, {}, { authorization: "Bearer another-secret" })).status, 401);
    assert.equal((await post(port, {}, {}, { path: "/unknown" })).status, 404);
    assert.equal((await post(port, {}, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(port, { ...announcement, channel: "different" })).status, 400);
    assert.equal((await post(port, { ...announcement, title: "" })).status, 400);
    assert.equal((await post(port, { ...announcement, body: "\ud800" })).status, 400);
    assert.equal((await post(port, Buffer.from([0xff]), {}, { raw: true })).status, 400);
    assert.equal((await post(port, { ...announcement, body: "z".repeat(65537) })).status, 413);
    assert.equal(rows.size, 0);

    assert.deepEqual(await post(port, announcement), { status: 202, id: announcement.id, state: "queued" });
    assert.equal(rows.get(announcement.id).destination, channelId);
    assert.deepEqual(await post(port, announcement), { status: 200, id: announcement.id, state: "queued" });
    assert.equal((await post(port, { ...announcement, body: "changed" })).status, 409);
    rows.get(announcement.id).state = "sending";
    assert.equal((await post(port, announcement)).state, "queued");
    available = false;
    assert.equal((await post(port, announcement)).status, 503);
    assert.equal(errors.length, 1);
    assert.ok(!errors[0].includes(announcement.body) && !errors[0].includes(secret));
});

test("MariaDB stores one immutable admission across concurrency and a restart", {
    skip: !process.env.TEST_NEWS_DB_SOCKET
}, async t => {
    const database = { socketPath: process.env.TEST_NEWS_DB_SOCKET, user: "root", database: "discord_news_test" };
    const id = "1".repeat(64);
    const data = { ...announcement, id };
    const pool = createNewsPool(database);
    t.after(() => pool.end());
    await pool.query("DELETE FROM discord_news_delivery WHERE id = ?", [id]);
    const intake = createNewsIntake({ config, pool, logger: silent });
    t.after(() => intake.stop());
    const { port } = await intake.start();
    const statuses = await Promise.all(Array.from({ length: 8 }, () => post(port, data)));
    assert.equal(statuses.filter(item => item.status === 202).length, 1);
    assert.equal(statuses.filter(item => item.status === 200).length, 7);
    const stored = await pool.query("SELECT * FROM discord_news_delivery WHERE id = ?", [id]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].destination, channelId);
    assert.deepEqual(JSON.parse(stored[0].parts), renderNews(data));

    const restartedPool = createNewsPool(database);
    t.after(() => restartedPool.end());
    const restarted = createNewsIntake({ config, pool: restartedPool, logger: silent });
    t.after(() => restarted.stop());
    await intake.stop();
    const address = await restarted.start();
    assert.equal((await post(address.port, data)).status, 200);
    assert.equal((await post(address.port, { ...data, body: "different" })).status, 409);
});
