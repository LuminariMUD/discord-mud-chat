const emojiRegexText = require("emoji-regex");

const HEARTBEAT_INTERVAL_MS = 240000;
const RATE_LIMIT_RETENTION_MS = 10000;

function stripEmoji(value, emojiRegexFactory = emojiRegexText) {
    const customEmoji = /<a?:\w+:\d{17,20}>/g;
    const unicodeEmoji = emojiRegexFactory();

    return value.replace(customEmoji, "").replace(unicodeEmoji, "");
}

class ChatBridge {
    constructor({
        config,
        discordClient,
        mudClient,
        healthServer,
        events,
        logger = console,
        timers = globalThis,
        now = Date.now,
        emojiRegexFactory = emojiRegexText
    }) {
        this.config = config;
        this.discordClient = discordClient;
        this.mudClient = mudClient;
        this.healthServer = healthServer;
        this.events = events;
        this.logger = logger;
        this.timers = timers;
        this.now = now;
        this.emojiRegexFactory = emojiRegexFactory;

        this.retries = 0;
        this.rateLimits = new Map();
        this.heartbeatInterval = undefined;
        this.reconnectTimeouts = new Set();
        this.eventsBound = false;
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        this.bindEvents();
        this.discordClient.login(this.config.discordToken);
        this.connectToMud();
    }

    bindEvents() {
        if (this.eventsBound) return;

        this.eventsBound = true;
        this.mudClient.on("close", hadError => this.handleMudClose(hadError));
        this.mudClient.on("data", data => this.handleMudData(data));
        this.mudClient.on("error", error => this.handleMudError(error));
        this.discordClient.once(this.events.ClientReady, client => this.handleDiscordReady(client));
        this.discordClient.on(this.events.MessageCreate, message => this.handleDiscordMessage(message));
    }

    connectToMud() {
        this.mudClient.connect(this.config.mud_port, this.config.mud_ip, () => {
            this.handleMudConnected();
        });
    }

    handleMudConnected() {
        if (this.stopped) return;

        this.retries = 0;
        this.logger.log(`Connected to ${this.config.mud_name} ${this.config.mud_ip}:${this.config.mud_port}`);
        this.healthServer.setMudConnected(true);

        if (this.config.mud_auth_token) {
            const authMessage = {
                channel: "auth",
                name: "bot",
                message: this.config.mud_auth_token
            };
            this.writeToMud(authMessage);
            this.logger.log("Authentication token sent to MUD");
        }

        if (this.heartbeatInterval !== undefined) {
            this.timers.clearInterval(this.heartbeatInterval);
        }

        this.heartbeatInterval = this.timers.setInterval(() => {
            const heartbeat = {
                channel: "heartbeat",
                name: "bot",
                message: "ping"
            };
            this.writeToMud(heartbeat);
            this.logger.log("Heartbeat sent to MUD");
        }, HEARTBEAT_INTERVAL_MS);
    }

    handleMudClose(hadError) {
        this.logger.log(`Disconnected from ${this.config.mud_name} ${this.config.mud_ip}:${this.config.mud_port}`);
        this.healthServer.setMudConnected(false);
        this.clearHeartbeat();

        if (!this.stopped && hadError === false) {
            this.logger.log("Reconnecting...");
            this.scheduleReconnect();
        }
    }

    handleMudData(data) {
        let messageData;

        try {
            messageData = JSON.parse(data.toString());
        } catch (error) {
            this.logger.error("Failed to parse message from MUD:", error);
            return false;
        }

        let relayed = false;
        for (const channel of this.config.channels) {
            if (messageData.channel !== channel.mud) continue;

            const discordChannel = this.discordClient.channels.cache.get(channel.discord);
            if (!discordChannel) continue;

            const message = messageData.emoted === 1
                ? `${messageData.message}`
                : `${messageData.name}: ${messageData.message}`;
            discordChannel.send(message);
            this.healthServer.incrementMudToDiscord();
            relayed = true;
        }

        return relayed;
    }

    handleMudError(error) {
        this.logger.error("Error received from mud", error);
        if (this.stopped) return;

        if (this.config.mud_infinite_retries) {
            this.logger.log(`Retry number ${++this.retries}...`);
            this.scheduleReconnect();
        } else if (++this.retries >= this.config.mud_retry_count) {
            this.logger.error(`Max retries (${this.config.mud_retry_count}) reached. Stopping reconnection attempts.`);
            this.retries = 0;
        } else {
            this.logger.log(`Retry number ${this.retries} of ${this.config.mud_retry_count}...`);
            this.scheduleReconnect();
        }
    }

    handleDiscordReady(client) {
        this.logger.log(`Logged into Discord as ${client.user.tag}.`);
        this.healthServer.setDiscordConnected(true);

        return Promise.all(this.config.channels.map(channel => (
            this.discordClient.channels.fetch(channel.discord)
                .then(result => {
                    const { guild } = result;
                    this.logger.log(`Found channel #${result.name} (${result.id}) on server ${guild.name} (${guild.id})`);
                    return result;
                })
                .catch(error => {
                    this.logger.error(`Failed to fetch Discord channel ${channel.discord}:`, error);
                    return undefined;
                })
        )));
    }

    handleDiscordMessage(message) {
        if (message.content.length < 1) return false;
        if (message.content.length > this.config.largest_printable_string) return false;

        const mappedChannel = this.config.channels.find(channel => message.channel.id === channel.discord);
        if (!mappedChannel) return false;
        if (!message.member || message.member.user.bot === true) return false;

        let messageText = message.content.replace(/@(everyone|here)/gi, "[mention removed]");
        messageText = messageText.replace(/<@!?(\d+)>/g, (mention, memberId) => {
            const member = message.guild?.members?.cache?.get(memberId)
                || (typeof message.guild?.member === "function" ? message.guild.member(memberId) : undefined);
            return member?.displayName || member?.user?.username || member?.username || mention;
        });

        let authorName = message.member.nickname || message.member.user.username;
        if (this.config.strip_emoji === true) {
            authorName = stripEmoji(authorName, this.emojiRegexFactory);
            messageText = stripEmoji(messageText, this.emojiRegexFactory);
        }

        if (authorName.length < 1 || messageText.length < 1) return false;

        const now = this.now();
        const channelKey = `${mappedChannel.mud}-${authorName}`;
        const lastMessage = this.rateLimits.get(channelKey) || 0;
        const rateLimitMs = 1000 / (this.config.rate_limit_per_channel || 10);

        if (now - lastMessage < rateLimitMs) {
            this.logger.log(`Rate limit exceeded for ${authorName} in ${mappedChannel.mud}`);
            return false;
        }

        this.rateLimits.set(channelKey, now);
        this.cleanRateLimits(now);

        this.writeToMud({
            name: authorName,
            channel: mappedChannel.mud,
            message: messageText
        });
        this.healthServer.incrementDiscordToMud();
        return true;
    }

    cleanRateLimits(now) {
        if (this.rateLimits.size <= 100) return;

        const cutoff = now - RATE_LIMIT_RETENTION_MS;
        for (const [key, time] of this.rateLimits) {
            if (time < cutoff) this.rateLimits.delete(key);
        }
    }

    scheduleReconnect() {
        let timeout;
        timeout = this.timers.setTimeout(() => {
            this.reconnectTimeouts.delete(timeout);
            if (!this.stopped) this.connectToMud();
        }, this.config.mud_retry_delay);
        this.reconnectTimeouts.add(timeout);
        return timeout;
    }

    writeToMud(message) {
        this.mudClient.write(`${JSON.stringify(message)}\n`);
    }

    clearHeartbeat() {
        if (this.heartbeatInterval === undefined) return;

        this.timers.clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = undefined;
    }

    stop() {
        this.stopped = true;
        this.clearHeartbeat();

        for (const timeout of this.reconnectTimeouts) {
            this.timers.clearTimeout(timeout);
        }
        this.reconnectTimeouts.clear();

        this.discordClient.destroy();
        this.mudClient.destroy();
    }
}

module.exports = {
    ChatBridge,
    HEARTBEAT_INTERVAL_MS,
    RATE_LIMIT_RETENTION_MS,
    stripEmoji
};
