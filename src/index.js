const path = require("path");

// Initialize logging (sets up console overrides)
const Logger = require("./logger");
new Logger();

// Initialize health check server
const HealthServer = require("./health");
const healthServer = new HealthServer();
healthServer.start();

// Config
const config = require(path.join(__dirname, "../config/config"));
let retries = 0;

// Rate limiting
const rateLimits = new Map();

// Discord stuff
const { Client, GatewayIntentBits, Events } = require("discord.js");
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Mudclient stuff
const net = require("net");
const mudClient = new net.Socket();
let heartbeatInterval;

// Miscellaneous stuff
const emojiRegexText = require("emoji-regex");

function connectToMud() {
    mudClient.connect(config.mud_port, config.mud_ip, () => {
        retries = 0;
        console.log(`Connected to ${config.mud_name} ${config.mud_ip}:${config.mud_port}`);
        healthServer.setMudConnected(true);
        
        // Send authentication if configured
        if (config.mud_auth_token) {
            const authMessage = {
                channel: "auth",
                name: "bot",
                message: config.mud_auth_token
            };
            mudClient.write(JSON.stringify(authMessage) + "\n");
            console.log("Authentication token sent to MUD");
        }
        
        // Set up heartbeat to prevent timeout (every 4 minutes)
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            const heartbeat = {
                channel: "heartbeat",
                name: "bot",
                message: "ping"
            };
            mudClient.write(JSON.stringify(heartbeat) + "\n");
            console.log("Heartbeat sent to MUD");
        }, 240000); // 4 minutes
    });
}

mudClient.on("close", hadError => {
    console.log(`Disconnected from ${config.mud_name} ${config.mud_ip}:${config.mud_port}`);
    healthServer.setMudConnected(false);
    
    // Clear heartbeat interval
    clearInterval(heartbeatInterval);

    if(hadError === false) {
        console.log("Reconnecting...");
        setTimeout(connectToMud, config.mud_retry_delay);
    }
});

mudClient.on("data", data => {
    let messageData;
    try {
        messageData = JSON.parse(data.toString());
    } catch (err) {
        console.error("Failed to parse message from MUD:", err);
        return;
    }
    for(const channel of config.channels) {
        if(messageData.channel === channel.mud) {
            const discordChannel = discordClient.channels.cache.get(channel.discord);
            if(!discordChannel) continue;
            if( messageData.emoted === 1 ) discordChannel.send(`${messageData.message}`);
            else discordChannel.send(`${messageData.name}: ${messageData.message}`);
            healthServer.incrementMudToDiscord();
        }
    }
});

mudClient.on("error", e => {
    console.error("Error received from mud", e);

    if (config.mud_infinite_retries) {
        console.log(`Retry number ${++retries}...`);
        setTimeout(connectToMud, config.mud_retry_delay);
    } else if (++retries >= config.mud_retry_count) {
        console.error(`Max retries (${config.mud_retry_count}) reached. Stopping reconnection attempts.`);
        retries = 0;
    } else {
        console.log(`Retry number ${retries} of ${config.mud_retry_count}...`);
        setTimeout(connectToMud, config.mud_retry_delay);
    }
});

discordClient.once(Events.ClientReady, c => {
    console.log(`Logged into Discord as ${c.user.tag}.`);
    healthServer.setDiscordConnected(true);
    //TODO: create a global array that handles what channels we found so we will only
    //TODO: listen on those channels.
    for (const discordChannel of config.channels) {
        discordClient.channels.fetch(discordChannel.discord)
            .then(results => {
                const { guild } = results;
                console.log(`Found channel #${results.name} (${results.id}) on server ${guild.name} (${guild.id})`);
                // channel = results
            });
    }
});

discordClient.on(Events.MessageCreate, message => {
    // Do not accept zero-length content.
    if (message.content.length < 1) return;
    if (message.member.user.bot === true) return;

    // Strip @everyone and @here mentions for security
    let messageText = message.content.replace(/@(everyone|here)/gi, '[mention removed]');
    
    // Replace user mentions with display names
    messageText = messageText.replace(/<@!*\d*>/g, mention => {
        if (mention.startsWith('<@') && mention.endsWith('>')) {
            mention = mention.slice(2, -1);

            if (mention.startsWith('!')) {
                mention = mention.slice(1);
            }

            const result = message.guild.member(mention);
            mention = result.displayName || result.username;
        }

        return mention;
    });

    if (message.content.length > config.largest_printable_string) return;

    //Find the right channel to have listened on, discard any other channels
    for (const channel of config.channels) {
        if (message.channel.id === channel.discord) {
            const mudChannel = channel.mud;
            let authorName = message.member.nickname || message.member.user.username;

            // If option to strip emoji is on, which is probably a good idea
            // and is why it is the default
            if (config.strip_emoji === true) {
                authorName = stripEmoji(authorName);
                messageText = stripEmoji(messageText);
            }

            // After emoji stripping, need to now exit if our
            // author or text is empty.
            if (authorName.length < 1) return;
            if (messageText.length < 1) return;

            // URL shortening disabled (bitly removed)

            const mudMessage = {
                name: authorName,
                channel: mudChannel,
                message: messageText
            };

            // Check rate limit
            const now = Date.now();
            const channelKey = `${mudChannel}-${authorName}`;
            const lastMessage = rateLimits.get(channelKey) || 0;
            const rateLimitMs = 1000 / (config.rate_limit_per_channel || 10);
            
            if (now - lastMessage < rateLimitMs) {
                console.log(`Rate limit exceeded for ${authorName} in ${mudChannel}`);
                return;
            }
            
            rateLimits.set(channelKey, now);
            
            // Clean up old rate limit entries every 10 seconds
            if (rateLimits.size > 100) {
                const cutoff = now - 10000;
                for (const [key, time] of rateLimits) {
                    if (time < cutoff) rateLimits.delete(key);
                }
            }
            
            mudClient.write(JSON.stringify(mudMessage) + "\n");
            healthServer.incrementDiscordToMud();
        }
    }
});

function stripEmoji(str) {

    const reg = /<?:\w+:\d{18}>?/g;
    str = str.replace(reg, "");

    const regex = emojiRegexText();
    str = str.replace(regex, "");

    return str;
}

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing connections...');
    clearInterval(heartbeatInterval);
    discordClient.destroy();
    mudClient.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, closing connections...');
    clearInterval(heartbeatInterval);
    discordClient.destroy();
    mudClient.destroy();
    process.exit(0);
});

discordClient.login(config.discordToken);
connectToMud();
