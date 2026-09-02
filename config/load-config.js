const fs = require("fs");

/**
 * Loads the JSON configuration and applies token overrides from the environment.
 *
 * @param {object} options - Configuration-loading dependencies.
 * @returns {object} The merged application configuration.
 */
function loadConfig({ configPath, env = process.env, fsModule = fs }) {
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));

    config.discordToken = env.DISCORD_TOKEN || config.discordToken || "";
    config.mud_auth_token = env.MUD_AUTH_TOKEN || config.mud_auth_token || "";

    return config;
}

module.exports = { loadConfig };
