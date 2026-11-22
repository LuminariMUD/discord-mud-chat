function loadNewsConfig(config, env) {
    const { enabled = false, send = enabled, host = "127.0.0.1", port = 3181, channel_id: channelId, database } = config.news || {};
    if (typeof enabled !== "boolean") throw new Error("news.enabled must be a boolean");
    if (typeof send !== "boolean") throw new Error("news.send must be a boolean");
    if (!enabled && !send) return undefined;

    if (enabled && host !== "127.0.0.1" && host !== "::1") throw new Error("news.host must be 127.0.0.1 or ::1");
    if (enabled && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("news.port must be a valid port");
    if (typeof channelId !== "string" || !/^[1-9]\d{16,19}$/.test(channelId)) {
        throw new Error("news.channel_id must be a Discord channel ID string");
    }
    if (config.channels?.some(channel => String(channel.discord) === channelId)) {
        throw new Error("news.channel_id must be separate from chat and petition mappings");
    }
    const secret = env.DISCORD_NEWS_INGEST_SECRET;
    if (enabled && (typeof secret !== "string" || !/^[A-Za-z0-9._~+/=-]{32,256}$/.test(secret))) {
        throw new Error("DISCORD_NEWS_INGEST_SECRET must contain 32 to 256 bearer-token characters");
    }
    const { host: dbHost = "127.0.0.1", port: dbPort = 3306, socket_path: socketPath, name, user } =
        database || {};
    if (![name, user, env.DISCORD_NEWS_DB_PASSWORD].every(value => typeof value === "string" && value.length)) {
        throw new Error("Configure news.database.name, news.database.user and DISCORD_NEWS_DB_PASSWORD");
    }
    if (typeof dbHost !== "string" || !dbHost || !Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535 ||
        (socketPath !== undefined && (typeof socketPath !== "string" || !socketPath))) {
        throw new Error("Configure a valid news.database host and port or Unix socket_path");
    }
    return {
        enabled, send, host, port, channelId, secret,
        database: { host: dbHost, port: dbPort, socketPath, database: name, user, password: env.DISCORD_NEWS_DB_PASSWORD }
    };
}

module.exports = { loadNewsConfig };
