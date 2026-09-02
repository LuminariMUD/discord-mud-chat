const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const Logger = require("../src/logger");

function createConsoleRef() {
    return {
        log() {},
        error() {},
        warn() {},
        debug() {}
    };
}

test("Logger creates its log directory and forwards console methods", t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mud-logger-"));
    const logDir = path.join(temporaryRoot, "nested", "logs");
    const consoleRef = createConsoleRef();
    const originalMethods = { ...consoleRef };
    const logger = new Logger({ logDir, consoleRef, level: "debug" });
    t.after(() => {
        logger.close();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    const calls = { info: [], error: [], warn: [], debug: [] };
    logger.winston.info = message => calls.info.push(message);
    logger.winston.error = message => calls.error.push(message);
    logger.winston.warn = message => calls.warn.push(message);
    logger.winston.debug = message => calls.debug.push(message);

    assert.equal(fs.existsSync(logDir), true);
    assert.equal(logger.winston.level, "debug");

    consoleRef.log("hello", 42);
    consoleRef.error("failure", "details");
    consoleRef.warn("careful");
    consoleRef.debug("state", true);

    assert.deepEqual(calls, {
        info: ["hello 42"],
        error: ["failure details"],
        warn: ["careful"],
        debug: ["state true"]
    });

    logger.setupConsoleOverrides();
    logger.restoreConsoleOverrides();
    assert.deepEqual(consoleRef, originalMethods);
});

test("Logger can leave a supplied console untouched", t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mud-logger-"));
    const consoleRef = createConsoleRef();
    const originalMethods = { ...consoleRef };
    const logger = new Logger({
        logDir: path.join(temporaryRoot, "logs"),
        consoleRef,
        overrideConsole: false
    });
    t.after(() => {
        logger.close();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    assert.deepEqual(consoleRef, originalMethods);
    logger.restoreConsoleOverrides();
    assert.deepEqual(consoleRef, originalMethods);
});
