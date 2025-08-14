# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose
This application bridges communication between a MUD (Multi-User Dungeon) and Discord channels, allowing bidirectional chat relay between the two platforms.

## Document format requirement
MUST be written in UTF-8 ASCII and LF

## Architecture Overview

### Core Components
- **src/index.js**: Main application file that manages both Discord and MUD client connections
- **src/logger.js**: File logging utility that captures all console output
- **config/config.js**: Configuration loader that merges config.json with environment variables (.env)
- **config/config.json**: Channel mappings and connection settings (copy from config.example.json)

### Communication Flow
1. **MUD → Discord**: Receives JSON messages from MUD socket, routes to configured Discord channels
2. **Discord → MUD**: Listens to configured Discord channels, forwards messages to MUD socket

### Message Format
The application exchanges JSON messages with the MUD in this format:
```json
{
    "channel": "String",  // MUD channel name
    "name": "String",     // Username/player name
    "message": "String"   // Chat message content
}
```

## Development Commands

### Running the Application
```bash
npm install                # Install dependencies
npm start                  # Start the application
npm run dev               # Start with nodemon for development
npm run lint              # Run ESLint on src/
npm run lint:fix          # Run ESLint with auto-fix
```

### Production Deployment
```bash
pm2 start ecosystem.config.js            # Start with PM2
pm2 start ecosystem.config.js --env development  # Start in development mode
```

### Configuration Setup
1. Copy `config/config.example.json` to `config/config.json`
2. Copy `.env.example` to `.env` and set:
   - `DISCORD_TOKEN` (required)
   - `BITLY_TOKEN` (optional, reserved for future use)
3. Configure channel mappings in config/config.json

## Key Dependencies
- **discord.js v14**: Discord bot framework
- **dotenv**: Environment variable management
- **emoji-regex**: Emoji stripping functionality
- **url-regex-safe**: URL detection
- **nodemon**: Development auto-restart (dev dependency)
- **eslint**: Code quality linting (dev dependency)

## Important Configuration Options
- `mud_retry_count`: Number of reconnection attempts (default: 50)
- `mud_retry_delay`: Delay between reconnection attempts in ms (default: 30000)
- `mud_infinite_retries`: Enable infinite reconnection attempts (default: true)
- `strip_emoji`: Remove emojis from messages (default: true)
- `enable_bitly`: Reserved for future use (default: false)
- `largest_printable_string`: Maximum message length (default: 65535)

## Error Handling
- Automatic reconnection to MUD with configurable retry count and delay
- Graceful handling of Discord API errors
- All console output automatically logged to files in logs/ directory
- PM2 process management for automatic restarts in production

## Project Structure
```
mud-discord-chat/
├── src/
│   ├── index.js      # Main application entry point
│   └── logger.js     # File logging utility
├── config/
│   ├── config.js     # Configuration loader
│   └── config.example.json  # Example configuration template
├── docs/
│   ├── deploy.md     # Deployment documentation
│   ├── mud_requires.md  # MUD integration requirements
│   └── mud_example/  # Example MUD integration code
├── ecosystem.config.js  # PM2 configuration for production
├── .env.example      # Environment variables template
├── .eslintrc.json    # ESLint configuration
├── Dockerfile        # Docker container configuration
└── docker-compose.yml  # Docker Compose configuration
```