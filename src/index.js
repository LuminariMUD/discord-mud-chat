const path = require("path");
const { Client, GatewayIntentBits, Events } = require("discord.js");
const Logger = require("./logger");
const HealthServer = require("./health");
const { ChatBridge } = require("./bridge");
const MudClient = require("./mud-client");

/** Composes the bridge runtime and provides idempotent lifecycle controls. */
function createApplication(options = {}) {
    const LoggerClass = options.LoggerClass || Logger;
    const logger = options.logger || new LoggerClass(options.loggerOptions);
    const config = options.config || require(path.join(__dirname, "../config/config"));
    const HealthServerClass = options.HealthServerClass || HealthServer;
    const healthServer = options.healthServer || new HealthServerClass();
    const DiscordClientClass = options.DiscordClientClass || Client;
    const gatewayIntentBits = options.gatewayIntentBits || GatewayIntentBits;
    const events = options.events || Events;
    const BridgeClass = options.BridgeClass || ChatBridge;

    const discordClient = options.discordClient || new DiscordClientClass({
        intents: [
            gatewayIntentBits.Guilds,
            gatewayIntentBits.GuildMessages,
            gatewayIntentBits.MessageContent,
            gatewayIntentBits.GuildMembers
        ]
    });
    const MudClientClass = options.MudClientClass || MudClient;
    const mudClient = options.mudClient || (
        options.SocketClass
            ? new options.SocketClass()
            : new MudClientClass({
                useTls: config.mud_tls === true,
                servername: config.mud_tls_servername || undefined
            })
    );
    const bridge = options.bridge || new BridgeClass({
        config,
        discordClient,
        mudClient,
        healthServer,
        events,
        logger: console
    });

    let started = false;
    let stopping;
    return {
        logger,
        healthServer,
        discordClient,
        mudClient,
        bridge,
        /** Starts the health endpoint and message bridge once. */
        start() {
            if (started) return;
            healthServer.start();
            bridge.start();
            started = true;
        },
        /** Waits for both runtime services to stop before closing the logger. */
        async stop() {
            if (!started) return;
            if (!stopping) {
                stopping = (async () => {
                    try {
                        await Promise.all([
                            bridge.stop(),
                            healthServer.stop()
                        ]);
                        if (typeof logger.close === "function") logger.close();
                        started = false;
                    } finally {
                        stopping = undefined;
                    }
                })();
            }
            return stopping;
        }
    };
}

/** Registers process signal handlers that wait for application shutdown. */
function registerShutdownHandlers(application, processRef = process, logger = console) {
    /** Performs one signal-triggered application shutdown. */
    const shutdown = async signal => {
        logger.log(`${signal} received, closing connections...`);
        try {
            await application.stop();
            processRef.exit(0);
        } catch (error) {
            logger.error("Failed to shut down cleanly:", error);
            processRef.exit(1);
        }
    };

    processRef.on("SIGTERM", () => shutdown("SIGTERM"));
    processRef.on("SIGINT", () => shutdown("SIGINT"));
    return shutdown;
}

/** Starts the production application and installs its shutdown handlers. */
function main(options = {}) {
    const application = createApplication(options.applicationOptions);
    application.start();
    registerShutdownHandlers(application, options.processRef, options.logger);
    return application;
}

if (require.main === module) main();

module.exports = {
    createApplication,
    main,
    registerShutdownHandlers
};
