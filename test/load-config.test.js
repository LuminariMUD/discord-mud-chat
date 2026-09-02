const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadConfig } = require("../config/load-config");

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

test("loadConfig falls back to the file MUD token", () => {
    const config = loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem('{"mud_auth_token":"file-token"}')
    });

    assert.equal(config.discordToken, undefined);
    assert.equal(config.mud_auth_token, "file-token");
});

test("loadConfig defaults a missing MUD token to an empty string", () => {
    const config = loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem("{}")
    });

    assert.equal(config.mud_auth_token, "");
});

test("loadConfig surfaces invalid JSON", () => {
    assert.throws(() => loadConfig({
        configPath: "config.json",
        env: {},
        fsModule: fakeFileSystem("not json")
    }), SyntaxError);
});
