const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");

async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mud-pm2-smoke-"));
    const env = { PATH: process.env.PATH, PM2_HOME: path.join(temp, "pm2") };
    const pm2 = (...args) => exec("pm2", args, { cwd: root, env, timeout: 15000 });
    const output = path.join(temp, "evidence.json");
    const file = path.join(temp, "ecosystem.config.cjs");
    const base = require(path.join(root, "ecosystem.config"));
    const app = { ...base.apps[0], name: "mud-bridge-fixture", cwd: root,
        script: path.join(root, "scripts/testing/deployment-smoke.js"),
        interpreter: process.execPath, cron_restart: undefined,
        env: { ...base.apps[0].env, HEALTH_PORT: 0, SMOKE_MODE: "hold", SMOKE_OUTPUT: output },
        out_file: path.join(temp, "out.log"), error_file: path.join(temp, "error.log"),
        log_file: path.join(temp, "combined.log") };
    assert.equal(app.instances, 1);
    assert.equal(app.exec_mode, "fork");
    assert.ok(!app.shutdown_with_message, "app shutdown handlers require PM2 signal mode");
    await fs.writeFile(file, "module.exports = " + JSON.stringify({ apps: [app] }) + ";\n");
    async function waitReady(previousPid) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            try {
                const evidence = JSON.parse(await fs.readFile(output, "utf8"));
                if (evidence.stage === "ready" && evidence.pid !== previousPid) return evidence;
            } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("PM2 fixture failed to become ready: " + await fs.readFile(path.join(temp, "error.log"), "utf8"));
    }
    try {
        await pm2("start", file);
        const first = await waitReady();
        const list = JSON.parse((await pm2("jlist")).stdout);
        assert.equal(list.length, 1);
        assert.equal(list[0].pid, first.pid);
        assert.equal(list[0].pm2_env.exec_mode, "fork_mode");
        await pm2("restart", "mud-bridge-fixture");
        const second = await waitReady(first.pid);
        assert.notEqual(second.pid, first.pid);
        await pm2("stop", "mud-bridge-fixture");
        const stopped = JSON.parse(await fs.readFile(output, "utf8"));
        assert.equal(stopped.stage, "stopped", "PM2 must invoke graceful shutdown before process exit");
        const remaining = JSON.parse((await pm2("jlist")).stdout);
        assert.equal(remaining[0].pm2_env.status, "stopped");
        console.log("PM2 single-instance startup, restart, health and signal shutdown passed");
    } finally {
        await pm2("kill").catch(() => {});
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
