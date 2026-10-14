const fs = require("fs");

/** Rejects unknown mapping directions while preserving the legacy default. */
function validateChannelDirections(config) {
    for (const [index, channel] of (config.channels || []).entries()) {
        if (channel.direction !== undefined && channel.direction !== "both"
            && channel.direction !== "mud_to_discord") {
            throw new Error(`channels[${index}].direction must be "both" or "mud_to_discord", or omitted`);
        }
    }
}

/**
 * Loads JSON configuration, then sources the MUD credential only from the environment.
 *
 * @param {object} options - Configuration-loading dependencies.
 * @returns {object} The merged application configuration.
 */
function loadConfig({ configPath, env = process.env, fsModule = fs }) {
    const config = JSON.parse(fsModule.readFileSync(configPath, "utf8"));

    config.discordToken = env.DISCORD_TOKEN || config.discordToken || "";
    config.mud_auth_token = env.MUD_AUTH_TOKEN || "";

    validateChannelDirections(config);
    return config;
}

module.exports = { loadConfig, validateChannelDirections };
