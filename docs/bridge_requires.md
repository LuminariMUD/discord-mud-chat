# Node.js Discord Bridge Requirements

## Overview
This document specifies the requirements for the Node.js Discord bridge application that connects to LuminariMUD's TCP server and enables bidirectional chat between MUD players and Discord users.

## Core Requirements

### 1. Network Connection
- **Protocol**: TCP client connecting to MUD server
- **Port**: 8181 (configurable)
- **Connection Type**: Persistent TCP connection with automatic reconnection
- **Reconnection**: Automatic retry with exponential backoff (5 attempts, 30-second delays)
- **Keep-alive**: Implement connection health monitoring

### 2. Discord Bot Integration
- **Library**: discord.js (latest stable version)
- **Authentication**: Discord bot token
- **Permissions Required**:
  - Read Messages
  - Send Messages
  - View Channel
  - Read Message History
- **Intents Required**:
  - GUILDS
  - GUILD_MESSAGES
  - MESSAGE_CONTENT

### 3. Message Protocol

#### JSON Message Format
**MUD to Discord:**
```json
{
    "channel": "gossip",
    "name": "PlayerName",
    "message": "Message content",
    "emoted": 0
}
```

**Discord to MUD:**
```json
{
    "channel": "gossip",
    "name": "DiscordUser",
    "message": "Message content"
}
```

### 4. Channel Mapping
The bridge must support configurable channel mappings between Discord channels and MUD channels:

| MUD Channel | Discord Channel ID | Description |
|-------------|-------------------|-------------|
| gossip      | (configurable)    | General chat |
| auction     | (configurable)    | Trade channel |
| gratz       | (configurable)    | Congratulations |

### 5. Authentication (Optional)
- Support optional token-based authentication with MUD server
- Send authentication message as first message if token is configured:
```json
{
    "channel": "auth",
    "name": "bot",
    "message": "secret-token-here"
}
```

## Technical Implementation Requirements

### 1. Configuration Management
```javascript
// config.json or .env structure
{
    "mud": {
        "host": "localhost",
        "port": 8181,
        "authToken": "" // Optional
    },
    "discord": {
        "token": "BOT_TOKEN",
        "guildId": "GUILD_ID",
        "channels": {
            "gossip": "CHANNEL_ID_1",
            "auction": "CHANNEL_ID_2",
            "gratz": "CHANNEL_ID_3"
        }
    },
    "bridge": {
        "maxMessageLength": 65535,
        "rateLimitPerChannel": 10, // messages per second
        "reconnectAttempts": 5,
        "reconnectDelay": 30000 // milliseconds
    }
}
```

### 2. Message Processing

#### Discord to MUD Flow:
1. Capture Discord message event
2. Validate channel is mapped
3. Strip emojis and special characters (configurable)
4. Truncate to max length (65535 characters)
5. Build JSON message
6. Send over TCP with newline delimiter
7. Handle send errors gracefully

#### MUD to Discord Flow:
1. Receive JSON from TCP socket
2. Parse and validate JSON
3. Map channel to Discord channel ID
4. Format message for Discord
5. Handle emotes (italic formatting if emoted=1)
6. Post to Discord channel
7. Handle Discord API rate limits

### 3. Error Handling
- **Connection errors**: Log and attempt reconnection
- **JSON parsing errors**: Log error, continue operation
- **Discord API errors**: Implement exponential backoff
- **Rate limit handling**: Queue messages when rate limited
- **Invalid channel mappings**: Log and skip message

### 4. Security Requirements
- **Input sanitization**: Remove @everyone, @here mentions
- **User validation**: Strip invalid characters from usernames
- **Message validation**: Enforce length limits
- **Connection security**: Support TLS/SSL (future)
- **Token storage**: Use environment variables for sensitive data

### 5. Logging Requirements
- **File logging**: Rotate logs daily, keep 7 days
- **Log levels**: ERROR, WARN, INFO, DEBUG
- **Log format**: Timestamp, level, component, message
- **Performance metrics**: Message throughput, latency
- **Error tracking**: Connection failures, parse errors

### 6. Deployment Support
- **Process management**: PM2 configuration
- **Docker support**: Dockerfile and docker-compose.yml
- **Environment variables**: Support for .env files
- **Health checks**: HTTP endpoint for monitoring
- **Graceful shutdown**: Clean disconnect on SIGTERM/SIGINT

## Package Dependencies

### Required NPM Packages:
```json
{
  "dependencies": {
    "discord.js": "^14.x",
    "dotenv": "^16.x",
    "winston": "^3.x",        // Logging
    "node-json-db": "^2.x"    // Optional: persistent storage
  },
  "devDependencies": {
    "nodemon": "^3.x",
    "eslint": "^8.x",
    "jest": "^29.x"           // Testing
  }
}
```

## Implementation Checklist

### Core Features
- [ ] TCP client connection to MUD
- [ ] Automatic reconnection logic
- [ ] Discord bot connection
- [ ] Bidirectional message routing
- [ ] JSON message parsing/building
- [ ] Channel mapping configuration
- [ ] Authentication support

### Message Handling
- [ ] Discord message capture
- [ ] MUD message reception
- [ ] Emoji stripping
- [ ] Length validation
- [ ] Rate limiting
- [ ] Emote formatting

### Error Handling
- [ ] Connection error recovery
- [ ] JSON parse error handling
- [ ] Discord API error handling
- [ ] Graceful degradation

### Security
- [ ] Input sanitization
- [ ] Mention stripping
- [ ] Token management
- [ ] Connection validation

### Monitoring
- [ ] File logging
- [ ] Performance metrics
- [ ] Health endpoint
- [ ] Error tracking

### Deployment
- [ ] PM2 configuration
- [ ] Docker support
- [ ] Environment configuration
- [ ] Documentation

## Example Implementation Structure

```
discord-mud-bridge/
├── src/
│   ├── index.js           // Main entry point
│   ├── mud-client.js      // TCP client for MUD
│   ├── discord-bot.js     // Discord bot handler
│   ├── message-router.js  // Message routing logic
│   ├── config.js          // Configuration loader
│   └── utils/
│       ├── logger.js      // Winston logger setup
│       ├── sanitizer.js   // Message sanitization
│       └── rate-limiter.js // Rate limiting
├── config/
│   ├── default.json       // Default configuration
│   └── production.json    // Production overrides
├── logs/                  // Log files (gitignored)
├── tests/                 // Jest test files
├── .env.example          // Environment template
├── .gitignore
├── package.json
├── ecosystem.config.js    // PM2 configuration
├── Dockerfile
├── docker-compose.yml
└── README.md

```

## Performance Requirements

- **Latency**: < 100ms message routing
- **Throughput**: Handle 100+ messages/second
- **Memory**: < 256MB RAM usage
- **CPU**: < 5% CPU usage idle
- **Uptime**: 99.9% availability target

## Testing Requirements

### Unit Tests
- Message parsing/building
- Channel mapping
- Rate limiting
- Sanitization

### Integration Tests
- TCP connection handling
- Discord API interaction
- End-to-end message flow
- Reconnection logic

### Load Testing
- High message volume
- Concurrent channels
- Connection stability
- Memory leak detection

## Future Enhancements

1. **Web Dashboard**: Real-time statistics and configuration
2. **Command Bridge**: Execute MUD commands from Discord
3. **Rich Embeds**: Enhanced message formatting
4. **Presence Sync**: Show online players in Discord
5. **TLS Support**: Encrypted MUD connection
6. **Multi-MUD Support**: Bridge multiple MUD servers
7. **Database Integration**: Message history and analytics
8. **Webhook Support**: Alternative to bot for sending
9. **Voice Integration**: Text-to-speech for important messages
10. **Mobile App**: Management interface for administrators

## Compatibility Notes

- **Node.js Version**: 18.x or higher recommended
- **Discord.js**: Version 14.x for latest features
- **Operating System**: Linux/macOS/Windows compatible
- **MUD Protocol**: Compatible with LuminariMUD TCP JSON protocol

## Support and Documentation

- Comprehensive README with setup instructions
- API documentation for extensibility
- Troubleshooting guide
- Configuration examples
- Docker deployment guide
- PM2 cluster mode documentation

## License Considerations

The bridge should be licensed compatibly with LuminariMUD's license to allow integration and distribution as part of the complete system.