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
    let closed = false;
    let stopping;
    let bridgeStopped = false;
    let healthServerStopped = false;
    let loggerClosed = typeof logger.close !== "function";
    const application = {
        logger,
        healthServer,
        discordClient,
        mudClient,
        bridge,
        /** Starts the health endpoint and message bridge once. */
        start() {
            if (started || closed) return;
            try {
                healthServer.start();
                bridge.start();
                started = true;
            } catch (error) {
                application.stop().catch(cleanupError => {
                    console.error("Failed to clean up after application startup failure:", cleanupError);
                });
                throw error;
            }
        },
        /** Drains both runtime services and permanently closes the application. */
        async stop() {
            if (stopping) return stopping;
            if (closed && bridgeStopped && healthServerStopped && loggerClosed) return;

            closed = true;
            stopping = (async () => {
                const results = await Promise.allSettled([
                    bridgeStopped
                        ? Promise.resolve()
                        : Promise.resolve().then(() => bridge.stop()).then(() => {
                            bridgeStopped = true;
                        }),
                    healthServerStopped
                        ? Promise.resolve()
                        : Promise.resolve().then(() => healthServer.stop()).then(() => {
                            healthServerStopped = true;
                        })
                ]);
                if (!loggerClosed) {
                    try {
                        await logger.close();
                        loggerClosed = true;
                    } catch (error) {
                        results.push({ status: "rejected", reason: error });
                    }
                }
                started = false;

                const failures = results
                    .filter(result => result.status === "rejected")
                    .map(result => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(failures, "Application shutdown failed");
                }
            })().finally(() => {
                stopping = undefined;
            });
            return stopping;
        }
    };
    return application;
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
