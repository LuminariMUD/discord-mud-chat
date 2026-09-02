const emojiRegexText = require("emoji-regex");
const { StringDecoder } = require("node:string_decoder");
const { isLoopbackHost, validateMudTransportConfig } = require("./mud-client");

const HEARTBEAT_INTERVAL_MS = 240000;
const RATE_LIMIT_RETENTION_MS = 10000;
const DEFAULT_MAX_MUD_RECORD_BYTES = 1024 * 1024;

/** Removes Discord custom emoji and Unicode emoji from a string. */
function stripEmoji(value, emojiRegexFactory = emojiRegexText) {
    const customEmoji = /<a?:\w+:\d{17,20}>/g;
    const unicodeEmoji = emojiRegexFactory();

    return value.replace(customEmoji, "").replace(unicodeEmoji, "");
}

/** Relays messages and connection state between Discord and a MUD server. */
class ChatBridge {
    /** Creates a bridge using injected transport, health, logging, and timing services. */
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
        validateMudTransportConfig(config);

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
        this.eventHandlers = {
            mudClose: hadError => this.handleMudClose(hadError),
            mudData: data => this.handleMudData(data),
            mudError: error => this.handleMudError(error),
            discordReady: client => this.handleDiscordReady(client),
            discordMessage: message => this.handleDiscordMessage(message)
        };
        this.started = false;
        this.stopped = false;
        this.stopping = undefined;
        this.shutdownState = {
            events: false,
            heartbeat: false,
            input: false,
            reconnects: false,
            mudHealth: false,
            discordHealth: false,
            discordClient: false,
            mudClient: false
        };
        this.mudDataBuffer = "";
        this.discardingMudRecord = false;
        this.mudDecoder = new StringDecoder("utf8");
        this.maxMudRecordBytes = config.mud_max_record_bytes || DEFAULT_MAX_MUD_RECORD_BYTES;
    }

    /** Starts the Discord login, event listeners, and MUD connection. */
    start() {
        if (this.started || this.stopped) return;
        this.started = true;
        this.bindEvents();
        this.discordClient.login(this.config.discordToken).catch(error => {
            this.logger.error("Failed to log in to Discord:", error);
        });
        this.connectToMud();
    }

    /** Registers transport event handlers once. */
    bindEvents() {
        if (this.eventsBound) return;

        this.eventsBound = true;
        this.mudClient.on("close", this.eventHandlers.mudClose);
        this.mudClient.on("data", this.eventHandlers.mudData);
        this.mudClient.on("error", this.eventHandlers.mudError);
        this.discordClient.once(this.events.ClientReady, this.eventHandlers.discordReady);
        this.discordClient.on(this.events.MessageCreate, this.eventHandlers.discordMessage);
    }

    /** Removes all transport event handlers owned by this bridge. */
    unbindEvents() {
        if (!this.eventsBound) return;

        this.mudClient.off("close", this.eventHandlers.mudClose);
        this.mudClient.off("data", this.eventHandlers.mudData);
        this.mudClient.off("error", this.eventHandlers.mudError);
        this.discordClient.off(this.events.ClientReady, this.eventHandlers.discordReady);
        this.discordClient.off(this.events.MessageCreate, this.eventHandlers.discordMessage);
        this.eventsBound = false;
    }

    /** Opens the configured MUD socket connection. */
    connectToMud() {
        this.mudClient.connect(this.config.mud_port, this.config.mud_ip, () => {
            this.handleMudConnected();
        });
    }

    /** Authenticates a connected MUD socket and starts its heartbeat. */
    handleMudConnected() {
        if (this.stopped) return;

        if ((this.config.mud_tls === true || !isLoopbackHost(this.config.mud_ip))
            && this.mudClient.encrypted !== true) {
            this.logger.error("Configured MUD connection is not using TLS; closing connection");
            this.healthServer.setMudConnected(false);
            this.mudClient.destroy();
            return;
        }

        this.retries = 0;
        this.logger.log(`Connected to ${this.config.mud_name} ${this.config.mud_ip}:${this.config.mud_port}`);
        this.healthServer.setMudConnected(true);

        if (this.config.mud_auth_token && this.mudClient.encrypted === true) {
            const authMessage = {
                channel: "auth",
                name: "bot",
                message: this.config.mud_auth_token
            };
            if (!this.safeWriteToMud(authMessage, "authentication", true)) return;
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
            if (this.safeWriteToMud(heartbeat, "heartbeat")) {
                this.logger.log("Heartbeat sent to MUD");
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    /** Updates health and schedules reconnection after a clean MUD disconnect. */
    handleMudClose(hadError) {
        if (this.stopped) return;

        this.logger.log(`Disconnected from ${this.config.mud_name} ${this.config.mud_ip}:${this.config.mud_port}`);
        this.healthServer.setMudConnected(false);
        this.clearHeartbeat();
        this.clearMudDataBuffer();

        if (!this.stopped && hadError === false) {
            this.logger.log("Reconnecting...");
            this.scheduleReconnect();
        }
    }

    /** Buffers TCP chunks and relays every complete newline-delimited MUD record. */
    handleMudData(data) {
        if (this.stopped) return false;

        let decodedData = Buffer.isBuffer(data)
            ? this.mudDecoder.write(data)
            : data.toString();
        if (this.discardingMudRecord) {
            const delimiterIndex = decodedData.indexOf("\n");
            if (delimiterIndex === -1) return false;

            decodedData = decodedData.slice(delimiterIndex + 1);
            this.discardingMudRecord = false;
        }

        this.mudDataBuffer += decodedData;
        const records = this.mudDataBuffer.split("\n");
        this.mudDataBuffer = records.pop();
        let relayed = false;

        for (const record of records) {
            if (record.trim().length === 0) continue;
            if (Buffer.byteLength(record, "utf8") > this.maxMudRecordBytes) {
                this.logger.error(`MUD record exceeded ${this.maxMudRecordBytes} bytes; discarding record`);
                continue;
            }
            if (this.relayMudRecord(record)) relayed = true;
        }

        if (Buffer.byteLength(this.mudDataBuffer, "utf8") > this.maxMudRecordBytes) {
            this.logger.error(`Incomplete MUD record exceeded ${this.maxMudRecordBytes} bytes; discarding until next delimiter`);
            this.mudDataBuffer = "";
            this.discardingMudRecord = true;
        }

        return relayed;
    }

    /** Parses and relays one complete MUD record to mapped Discord channels. */
    relayMudRecord(record) {
        let messageData;

        try {
            messageData = JSON.parse(record);
        } catch (error) {
            this.logger.error("Failed to parse message from MUD:", error);
            return false;
        }
        if (messageData === null || Array.isArray(messageData) || typeof messageData !== "object") {
            this.logger.error("Ignoring MUD record because it is not a JSON object");
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
            discordChannel.send({
                content: message,
                allowedMentions: { parse: [] }
            })
                .then(() => this.healthServer.incrementMudToDiscord())
                .catch(error => {
                    this.logger.error(`Failed to send message to Discord channel ${channel.discord}:`, error);
                });
            relayed = true;
        }

        return relayed;
    }

    /** Clears buffered MUD input so records never span separate connections. */
    clearMudDataBuffer() {
        this.mudDataBuffer = "";
        this.discardingMudRecord = false;
        this.mudDecoder = new StringDecoder("utf8");
    }

    /** Applies the configured retry policy after a MUD socket error. */
    handleMudError(error) {
        if (this.stopped) return;
        this.logger.error("Error received from mud", error);
        if (this.reconnectTimeouts.size > 0) return;

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

    /** Marks Discord connected and verifies access to configured channels. */
    handleDiscordReady(client) {
        if (this.stopped) return Promise.resolve([]);

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

    /** Sanitizes and relays one eligible Discord message to the MUD. */
    handleDiscordMessage(message) {
        if (this.stopped) return false;

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

        const authorId = message.author?.id || message.member.user.id || message.member.id;
        if (!authorId) return false;

        const now = this.now();
        const channelKey = `${mappedChannel.mud}-${authorId}`;
        const lastMessage = this.rateLimits.get(channelKey) || 0;
        const rateLimitMs = 1000 / (this.config.rate_limit_per_channel || 10);

        if (now - lastMessage < rateLimitMs) {
            this.logger.log(`Rate limit exceeded for ${authorName} in ${mappedChannel.mud}`);
            return false;
        }

        this.rateLimits.set(channelKey, now);
        this.cleanRateLimits(now);

        if (!this.safeWriteToMud({
            name: authorName,
            channel: mappedChannel.mud,
            message: messageText
        }, "Discord message")) return false;
        this.healthServer.incrementDiscordToMud();
        return true;
    }

    /** Removes expired rate-limit entries when the cache grows large. */
    cleanRateLimits(now) {
        if (this.rateLimits.size <= 100) return;

        const cutoff = now - RATE_LIMIT_RETENTION_MS;
        for (const [key, time] of this.rateLimits) {
            if (time < cutoff) this.rateLimits.delete(key);
        }
    }

    /** Schedules one tracked MUD reconnection attempt. */
    scheduleReconnect() {
        if (this.reconnectTimeouts.size > 0) {
            return this.reconnectTimeouts.values().next().value;
        }

        let timeout;
        timeout = this.timers.setTimeout(() => {
            this.reconnectTimeouts.delete(timeout);
            if (!this.stopped) this.connectToMud();
        }, this.config.mud_retry_delay);
        this.reconnectTimeouts.add(timeout);
        return timeout;
    }

    /** Writes one newline-delimited JSON message to the MUD socket. */
    writeToMud(message) {
        if (message.channel === "auth" && this.mudClient.encrypted !== true) {
            throw new Error("Refusing to send MUD authentication without TLS");
        }
        this.mudClient.write(`${JSON.stringify(message)}\n`);
    }

    /** Writes to the MUD without allowing transport failures to escape event callbacks. */
    safeWriteToMud(message, description, destroyOnFailure = false) {
        try {
            this.writeToMud(message);
            return true;
        } catch (error) {
            this.logger.error(`Failed to write ${description} to MUD:`, error);
            this.healthServer.setMudConnected(false);
            this.clearHeartbeat();
            if (destroyOnFailure) this.mudClient.destroy();
            if (this.started && !this.stopped) this.scheduleReconnect();
            return false;
        }
    }

    /** Cancels the active heartbeat timer, if any. */
    clearHeartbeat() {
        if (this.heartbeatInterval === undefined) return;

        this.timers.clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = undefined;
    }

    /** Cancels scheduled work and closes both transport clients, retrying failed steps. */
    async stop() {
        if (this.stopping) return this.stopping;
        this.stopped = true;
        const operations = {
            events: () => this.unbindEvents(),
            heartbeat: () => this.clearHeartbeat(),
            input: () => this.clearMudDataBuffer(),
            reconnects: () => {
                for (const timeout of this.reconnectTimeouts) {
                    this.timers.clearTimeout(timeout);
                }
                this.reconnectTimeouts.clear();
            },
            mudHealth: () => this.healthServer.setMudConnected(false),
            discordHealth: () => this.healthServer.setDiscordConnected(false),
            discordClient: () => this.discordClient.destroy(),
            mudClient: () => this.mudClient.destroy()
        };
        const pendingOperations = Object.entries(operations)
            .filter(([name]) => !this.shutdownState[name])
            .map(([name, operation]) => Promise.resolve()
                .then(operation)
                .then(() => {
                    this.shutdownState[name] = true;
                }));

        this.stopping = Promise.allSettled(pendingOperations)
            .then(results => {
                const failures = results
                    .filter(result => result.status === "rejected")
                    .map(result => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(failures, "Bridge shutdown failed");
                }
            })
            .finally(() => {
                this.stopping = undefined;
            });
        return this.stopping;
    }
}

module.exports = {
    ChatBridge,
    DEFAULT_MAX_MUD_RECORD_BYTES,
    HEARTBEAT_INTERVAL_MS,
    RATE_LIMIT_RETENTION_MS,
    stripEmoji
};
