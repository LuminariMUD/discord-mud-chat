const assert = require("node:assert/strict");
const { test } = require("node:test");
const HealthServer = require("../src/health");

test("health endpoint reports connection state and relay counters", async t => {
    const previousHealthPort = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    t.after(() => {
        if (previousHealthPort === undefined) delete process.env.HEALTH_PORT;
        else process.env.HEALTH_PORT = previousHealthPort;
    });
    t.mock.method(console, "log", () => {});

    const health = new HealthServer(0);
    const server = await health.start();
    t.after(() => health.stop());
    const port = server.address().port;

    const unhealthyResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const unhealthy = await unhealthyResponse.json();
    assert.equal(unhealthyResponse.status, 503);
    assert.equal(unhealthy.status, "unhealthy");
    assert.deepEqual(unhealthy.connections, { mud: false, discord: false });
    assert.deepEqual(unhealthy.messages, { mudToDiscord: 0, discordToMud: 0 });
    assert.ok(Date.parse(unhealthy.timestamp));
    assert.ok(unhealthy.uptime >= 0);

    health.setMudConnected(true);
    health.setDiscordConnected(true);
    health.incrementMudToDiscord();
    health.incrementDiscordToMud();
    health.incrementDiscordToMud();

    const healthyResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthy = await healthyResponse.json();
    assert.equal(healthyResponse.status, 200);
    assert.equal(healthy.status, "healthy");
    assert.deepEqual(healthy.connections, { mud: true, discord: true });
    assert.deepEqual(healthy.messages, { mudToDiscord: 1, discordToMud: 2 });
});

test("health server returns 404 and start is idempotent", async t => {
    const previousHealthPort = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    t.after(() => {
        if (previousHealthPort === undefined) delete process.env.HEALTH_PORT;
        else process.env.HEALTH_PORT = previousHealthPort;
    });
    t.mock.method(console, "log", () => {});

    const health = new HealthServer(0);
    const firstStart = health.start();
    assert.equal(health.start(), firstStart);
    const server = await firstStart;
    assert.equal(await health.start(), server);
    t.after(() => health.stop());

    const response = await fetch(`http://127.0.0.1:${server.address().port}/missing`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not Found");
});

test("health server rejects port conflicts without retaining the failed listener", async t => {
    const previousHealthPort = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    t.after(() => {
        if (previousHealthPort === undefined) delete process.env.HEALTH_PORT;
        else process.env.HEALTH_PORT = previousHealthPort;
    });
    t.mock.method(console, "log", () => {});

    const activeHealth = new HealthServer(0);
    const activeServer = await activeHealth.start();
    t.after(() => activeHealth.stop());
    const conflictingHealth = new HealthServer(activeServer.address().port);

    const failedStart = conflictingHealth.start();
    const failedStop = conflictingHealth.stop();
    await assert.rejects(failedStart, { code: "EADDRINUSE" });
    await failedStop;
    assert.equal(conflictingHealth.server, undefined);
});

test("health server coalesces stop while startup is pending", async t => {
    const previousHealthPort = process.env.HEALTH_PORT;
    delete process.env.HEALTH_PORT;
    t.after(() => {
        if (previousHealthPort === undefined) delete process.env.HEALTH_PORT;
        else process.env.HEALTH_PORT = previousHealthPort;
    });
    t.mock.method(console, "log", () => {});

    const health = new HealthServer(0);
    const starting = health.start();
    const firstStop = health.stop();
    const secondStop = health.stop();
    const server = await starting;
    await Promise.all([firstStop, secondStop]);

    assert.equal(server.listening, false);
    assert.equal(health.server, undefined);
});

test("HEALTH_PORT overrides the constructor port", () => {
    const previousHealthPort = process.env.HEALTH_PORT;
    process.env.HEALTH_PORT = "4567";

    try {
        assert.equal(new HealthServer(1234).port, "4567");
    } finally {
        if (previousHealthPort === undefined) delete process.env.HEALTH_PORT;
        else process.env.HEALTH_PORT = previousHealthPort;
    }
});

test("stopping a server that was never started is safe", async () => {
    const health = new HealthServer(0);
    await health.stop();
    assert.equal(health.server, undefined);
});
