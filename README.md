# MUD-Discord Chat Bridge

A Node.js application that bridges communication between a MUD (Multi-User Dungeon) and Discord channels, enabling bidirectional chat relay.

## Features

- 🔄 Bidirectional message relay between MUD and Discord
- 📊 Multiple channel mapping support
- 🔌 Automatic reconnection with configurable retry logic
- 🚫 Security features (@everyone/@here mention stripping)
- ⚡ Rate limiting to prevent spam
- 🔐 Optional MUD authentication support
- 😊 Emoji stripping for MUD compatibility
- 📝 Winston logging with rotation and multiple outputs
- 🏥 Health check endpoint for monitoring
- 🛑 Graceful shutdown handling
- 🐳 Docker containerization support
- 📦 PM2 support for production deployment

## Quick Start

1. Clone the repository:
```bash
git clone https://github.com/LuminariMUD/discord-mud-chat.git
cd discord-mud-chat
```

2. Install dependencies:
```bash
npm install
```

3. Configure the application:
   - Copy `config/config.example.json` to `config/config.json`
   - Edit `config/config.json` with your MUD connection details and channel mappings
   - Copy `.env.example` to `.env`
   - Add your Discord bot token to `.env`

4. Run the application:
```bash
npm start  # Production mode
npm run dev  # Development mode with auto-restart
```

For detailed installation and deployment instructions, see [📚 Deployment Guide](docs/deploy.md).

## Discord Bot Setup

### Step 1: Create Discord Application

1. Visit the [Discord Developer Portal](https://discord.com/developers/applications/) and create a new application
2. Record the **Client ID** (you'll need this for the invite URL)
3. Navigate to the **Bot** section in the left sidebar
4. Click **Reset Token** and record the token for later use
5. Under **Privileged Gateway Intents**, enable:
   - Server Members Intent
   - Message Content Intent

### Step 2: Invite Bot to Server

1. Use this URL, replacing `CLIENT_ID` with your Client ID:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=3072
   ```
2. Select your server and authorize the bot

### Step 3: Get Discord Channel IDs

1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click on any channel you want to bridge
3. Select **Copy ID**

![Channel ID Copy](https://user-images.githubusercontent.com/1266935/114635703-45329300-9c93-11eb-9da4-f92b05b0fa0e.png)

## Configuration

### Environment Variables (.env)

Create a `.env` file in the project root:

```env
# Required
DISCORD_TOKEN=your_discord_bot_token_here

# Optional
# MUD_AUTH_TOKEN=your_mud_auth_token_here  # For MUD authentication
# HEALTH_PORT=3000                          # Health check endpoint port
# LOG_LEVEL=info                            # Logging level (error, warn, info, debug)
```

### Configuration File (config/config.json)

Copy `config/config.example.json` to `config/config.json` and customize:

```json
{
  "mud_name": "LuminariMUD",
  "mud_ip": "127.0.0.1",
  "mud_port": 8181,
  "mud_auth_token": "",
  "mud_retry_count": 5,
  "mud_retry_delay": 30000,
  "rate_limit_per_channel": 10,
  "strip_emoji": true,
  "enable_bitly": false,
  "largest_printable_string": 65535,
  "channels": [
    { "discord": "432623057706811394", "mud": "gossip" },
    { "discord": "819275737328386118", "mud": "auction" },
    { "discord": "716021506605318195", "mud": "gratz" }
  ]
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `mud_name` | Display name for your MUD | Required |
| `mud_ip` | MUD server IP address | Required |
| `mud_port` | MUD server port | Required |
| `mud_auth_token` | Optional authentication token for MUD | "" |
| `mud_retry_count` | Number of reconnection attempts | 5 |
| `mud_retry_delay` | Delay between reconnection attempts (ms) | 30000 |
| `rate_limit_per_channel` | Messages per second per channel | 10 |
| `strip_emoji` | Remove emojis from messages | true |
| `enable_bitly` | Reserved for future use | false |
| `largest_printable_string` | Maximum message length | 65535 |
| `channels` | Array of channel mappings | Required |

## Message Format

The application exchanges JSON messages with the MUD:

```json
{
  "channel": "String",  // MUD channel name
  "name": "String",     // Username/player name  
  "message": "String",  // Chat message content
  "emoted": 0          // Optional: 1 for emote messages
}
```

## Deployment

### 🚀 Quick Start (Local)
```bash
npm start    # Production mode
npm run dev  # Development mode with auto-restart
```

### 🐳 Docker (Recommended)
```bash
docker-compose up -d
```

### 📦 PM2 (Process Management)
```bash
pm2 start ecosystem.config.js
```

**For detailed deployment instructions including:**
- Local installation and configuration
- Docker deployment with compose
- PM2 process management
- Production best practices
- Security hardening
- Monitoring and health checks
- Troubleshooting guide

**See the complete [📚 Deployment Guide](docs/deploy.md)**

### Available Scripts

- `npm start` - Start the application
- `npm run dev` - Start with nodemon for development
- `npm run lint` - Run ESLint to check code quality
- `npm run lint:fix` - Run ESLint with auto-fix

## Troubleshooting

### Bot Not Connecting to Discord
- Verify your Discord token in `.env` is correct
- Check that the bot has been invited to your server
- Ensure the bot has proper permissions in the target channels
- Check console output for specific error messages

### MUD Connection Issues
- Verify the MUD IP and port in `config/config.json`
- Ensure the MUD server is running and accepting connections
- Check firewall settings on both client and server
- Review console logs for connection errors

### Messages Not Relaying
- Confirm channel IDs in `config/config.json` are correct
- Verify the bot can see and send messages in the Discord channels
- Check that MUD channel names match exactly (case-sensitive)
- Ensure Message Content Intent is enabled in Discord Developer Portal

### Performance Issues
- Adjust `mud_retry_delay` for less frequent reconnection attempts
- Monitor message volume and adjust `largest_printable_string` if needed
- Consider using PM2 for better process management and auto-restart

## Project Structure

```
mud-discord-chat/
├── src/
│   ├── index.js          # Main application file
│   ├── logger.js         # Winston logging configuration
│   └── health.js         # Health check HTTP server
├── config/
│   ├── config.json       # Your configuration (git ignored)
│   ├── config.js         # Configuration loader
│   └── config.example.json # Configuration template
├── docs/
│   ├── deploy.md         # Comprehensive deployment guide
│   ├── bridge_requires.md # Technical requirements specification
│   └── mud_example/      # Example MUD integration code
├── logs/                 # Log files directory (auto-created)
├── .env                  # Environment variables (git ignored)
├── .env.example          # Environment template
├── .eslintrc.json        # ESLint configuration
├── ecosystem.config.js   # PM2 configuration
├── Dockerfile            # Docker container definition
├── docker-compose.yml    # Docker Compose configuration
├── .dockerignore         # Docker ignore patterns
├── CLAUDE.md             # Claude Code guidance file
├── LICENSE.txt           # ISC License
├── package.json          # Project dependencies
└── README.md            # This file
```

## Monitoring & Health

### Logging

The application uses Winston for comprehensive logging:
- **Console output** with colored formatting in development
- **File logs** with automatic rotation (7 days retention, 10MB max size)
- `logs/app.log` - All application logs
- `logs/error.log` - Error logs only
- `logs/pm2-*.log` - PM2-specific logs (when using PM2)

Log levels can be configured via `LOG_LEVEL` environment variable (error, warn, info, debug).

### Health Check Endpoint

Monitor application health at `http://localhost:3000/health`:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "connections": {
    "mud": true,
    "discord": true
  },
  "messages": {
    "mudToDiscord": 150,
    "discordToMud": 200
  }
}
```

## Contributing

Issues and pull requests are welcome at https://github.com/LuminariMUD/discord-mud-chat

## License

ISC License - See LICENSE file for details
