const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadConfig } = require("../config/load-config");

/** Creates a minimal file-system double that returns a fixed config payload. */
function fakeFileSystem(value, assertions = () => {}) {
    return {
        readFileSync(configPath, encoding) {
            assertions(configPath, encoding);
            return value;
        }
    };
}

test("loadConfig reads JSON and applies environment token overrides", () => {
    const config = loadConfig({
        configPath: "/config/config.json",
        env: {
            DISCORD_TOKEN: "discord-from-env",
            MUD_AUTH_TOKEN: "mud-from-env"
        },
        fsModule: fakeFileSystem(JSON.stringify({
            mud_ip: "localhost",
            mud_auth_token: "mud-from-file"
        }), (configPath, encoding) => {
            assert.equal(configPath, "/config/config.json");
            assert.equal(encoding, "utf8");
        })
    });

    assert.deepEqual(config, {
        mud_ip: "localhost",
        discordToken: "discord-from-env",
        mud_auth_token: "mud-from-env"
    });
});

test("loadConfig falls back to file tokens", () => {
    const config = loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem(JSON.stringify({
            discordToken: "discord-from-file",
            mud_auth_token: "mud-from-file"
        }))
    });

    assert.equal(config.discordToken, "discord-from-file");
    assert.equal(config.mud_auth_token, "mud-from-file");
});

test("loadConfig defaults missing tokens to empty strings", () => {
    const config = loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem("{}")
    });

    assert.equal(config.discordToken, "");
    assert.equal(config.mud_auth_token, "");
});

test("config entrypoint loads config/config.json", () => {
    const configModulePath = require.resolve("../config/config");
    const loadConfigModulePath = require.resolve("../config/load-config");
    const originalExports = require.cache[loadConfigModulePath].exports;
    const expected = { discordToken: "loaded" };
    let receivedOptions;

    require.cache[loadConfigModulePath].exports = {
        loadConfig(options) {
            receivedOptions = options;
            return expected;
        }
    };
    delete require.cache[configModulePath];

    try {
        assert.equal(require("../config/config"), expected);
        assert.equal(receivedOptions.configPath, path.join(__dirname, "../config/config.json"));
    } finally {
        require.cache[loadConfigModulePath].exports = originalExports;
        delete require.cache[configModulePath];
    }
});

test("loadConfig surfaces invalid JSON", () => {
    assert.throws(() => loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem("not json")
    }), SyntaxError);
});
