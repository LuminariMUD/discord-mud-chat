const path = require("path");
const net = require("net");
const { Client, GatewayIntentBits, Events } = require("discord.js");
const Logger = require("./logger");
const HealthServer = require("./health");
const { ChatBridge } = require("./bridge");

function createApplication(options = {}) {
    const LoggerClass = options.LoggerClass || Logger;
    const logger = options.logger || new LoggerClass(options.loggerOptions);
    const config = options.config || require(path.join(__dirname, "../config/config"));
    const HealthServerClass = options.HealthServerClass || HealthServer;
    const healthServer = options.healthServer || new HealthServerClass();
    const DiscordClientClass = options.DiscordClientClass || Client;
    const gatewayIntentBits = options.gatewayIntentBits || GatewayIntentBits;
    const events = options.events || Events;
    const SocketClass = options.SocketClass || net.Socket;
    const BridgeClass = options.BridgeClass || ChatBridge;

    const discordClient = options.discordClient || new DiscordClientClass({
        intents: [
            gatewayIntentBits.Guilds,
            gatewayIntentBits.GuildMessages,
            gatewayIntentBits.MessageContent,
            gatewayIntentBits.GuildMembers
        ]
    });
    const mudClient = options.mudClient || new SocketClass();
    const bridge = options.bridge || new BridgeClass({
        config,
        discordClient,
        mudClient,
        healthServer,
        events,
        logger: console
    });

    let started = false;
    return {
        logger,
        healthServer,
        discordClient,
        mudClient,
        bridge,
        start() {
            if (started) return;
            healthServer.start();
            bridge.start();
            started = true;
        },
        stop() {
            if (!started) return;
            bridge.stop();
            healthServer.stop();
            if (typeof logger.close === "function") logger.close();
            started = false;
        }
    };
}

function registerShutdownHandlers(application, processRef = process, logger = console) {
    const shutdown = signal => {
        logger.log(`${signal} received, closing connections...`);
        application.stop();
        processRef.exit(0);
    };

    processRef.on("SIGTERM", () => shutdown("SIGTERM"));
    processRef.on("SIGINT", () => shutdown("SIGINT"));
    return shutdown;
}

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
