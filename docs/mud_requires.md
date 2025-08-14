# MUD Integration Technical Requirements

## Executive Summary
This document outlines the comprehensive technical requirements for MUD-side implementation to integrate with the Discord chat bridge. The MUD must implement a TCP socket server that exchanges JSON-formatted messages with the Discord bridge client.

**Latest Update**: The Discord bridge application has been fully refactored and now includes file logging, PM2 support, and Docker containerization. The protocol remains unchanged for backward compatibility.

## Network Protocol Specifications

### Connection Requirements
- **Protocol**: TCP/IP Socket
- **Connection Type**: Persistent TCP connection
- **Role**: MUD acts as TCP server, Discord bridge acts as TCP client
- **Port**: Configurable (example: 8181)
- **IP Binding**: Should bind to appropriate interface (127.0.0.1 for local, or external IP for remote connections)

### Connection Management
The MUD server must handle:
- **Accept incoming connections** from the Discord bridge client
- **Maintain persistent connections** - do not close after each message
- **Handle connection drops gracefully** - the Discord bridge will automatically reconnect
- **Support reconnection attempts** - Discord bridge retries up to 5 times with 30-second delays

## Message Protocol

### Message Format
All communication uses JSON-encoded messages sent over the TCP socket.

#### MUD to Discord Message Structure
```json
{
    "channel": "string",    // MUD channel name (required)
    "name": "string",       // Player/character name (required)
    "message": "string",    // Message content (required)
    "emoted": 0 | 1        // Optional: 1 for emotes, 0 for regular messages
}
```

#### Discord to MUD Message Structure
```json
{
    "channel": "string",    // MUD channel name (required)
    "name": "string",       // Discord username/nickname (required, emoji stripped)
    "message": "string"     // Message content (required, emoji stripped by default)
}
```

### Message Handling Requirements

#### Receiving Messages (Discord to MUD)
1. **Parse incoming JSON** from the TCP socket
2. **Extract fields**: `channel`, `name`, `message`
3. **Route to appropriate MUD channel** based on the `channel` field
4. **Display in MUD** with format: `[Discord] Name: Message` (or similar)
5. **Handle malformed JSON** gracefully without dropping connection

#### Sending Messages (MUD to Discord)
1. **Capture chat messages** from configured MUD channels
2. **Build JSON message** with required fields
3. **Include player name** from the MUD character/account
4. **Send as raw JSON string** over the TCP socket
5. **Include newline delimiter** after each JSON message (recommended)

### Data Validation

#### Incoming Messages (from Discord)
- **Maximum message length**: 65,535 characters (configurable)
- **Empty messages**: Should be ignored
- **Special characters**: Handle Unicode/UTF-8 properly
- **Emoji handling**: Emojis will be stripped by default on Discord side

#### Outgoing Messages (to MUD)
- **Message sanitization**: Remove or escape MUD color codes/formatting
- **Player names**: Should be the actual character/player name in the MUD
- **Channel names**: Must match exactly with configured channel mappings

## Channel Configuration

### Channel Mapping
The MUD must support configurable channel mappings. Each mapped channel requires:
- **MUD channel identifier** (string) - internal MUD channel name/ID
- **Enable/disable flag** - ability to toggle individual channel bridges
- **Permissions** - optional access control for who can use bridged channels

### Example Channel Configuration
```
MUD Channel     | Status  | Description
----------------|---------|------------------
"gossip"        | Enabled | General gossip channel
"auction"       | Enabled | Auction/trading channel
"gratz"         | Enabled | Congratulations channel
```

## Implementation Requirements

### Core Features

#### 1. TCP Socket Server
```pseudocode
function startDiscordBridge() {
    server = createTCPServer(port: 8181)
    
    server.onConnection = function(socket) {
        log("Discord bridge connected from " + socket.address)
        
        socket.onData = function(data) {
            try {
                message = parseJSON(data)
                routeMessageToMUD(message)
            } catch (error) {
                log("Invalid JSON received: " + error)
            }
        }
        
        socket.onClose = function() {
            log("Discord bridge disconnected")
        }
    }
}
```

#### 2. Message Router
```pseudocode
function routeMessageToMUD(message) {
    if (!message.channel || !message.name || !message.message) {
        return // Invalid message structure
    }
    
    mudChannel = getMUDChannel(message.channel)
    if (mudChannel && mudChannel.isEnabled) {
        broadcastToChannel(
            channel: mudChannel,
            sender: "[Discord] " + message.name,
            message: message.message
        )
    }
}
```

#### 3. MUD Event Handler
```pseudocode
function onMUDChannelMessage(channel, player, message) {
    if (!isDiscordBridgeEnabled(channel)) {
        return
    }
    
    discordMessage = {
        "channel": getDiscordChannelName(channel),
        "name": player.name,
        "message": stripMUDFormatting(message),
        "emoted": isEmote(message) ? 1 : 0
    }
    
    sendToDiscordBridge(JSON.stringify(discordMessage))
}
```

### Optional Features

#### 1. Emote Support
- Detect emote/action messages in MUD
- Set `"emoted": 1` flag in JSON
- Discord bridge will format as: `*Name performs action*` instead of `Name: message`

#### 2. Connection Authentication
- Optional authentication token/password
- Send upon connection establishment
- Reject unauthorized connections

#### 3. Rate Limiting
- Implement message rate limiting per channel
- Prevent spam/flooding
- Suggested: 10 messages per second per channel maximum

#### 4. Message Filtering
- Filter out system messages
- Exclude private messages/tells
- Remove MUD-specific formatting codes

## Security Considerations

### Network Security
1. **Firewall rules**: Only allow connections from authorized Discord bridge IPs
2. **Connection limits**: Limit to one active Discord bridge connection
3. **TLS/SSL**: Consider implementing TLS for encrypted communication (optional)

### Content Security
1. **Input validation**: Validate all incoming JSON fields
2. **Injection prevention**: Sanitize Discord usernames and messages
3. **Command filtering**: Prevent Discord users from executing MUD commands
4. **Length limits**: Enforce maximum message lengths

### Access Control
1. **Channel permissions**: Respect existing MUD channel access controls
2. **User filtering**: Option to filter messages from specific Discord users
3. **Bridge toggle**: Global on/off switch for Discord bridge

## Configuration File Example

### MUD-side configuration (example format)
```json
{
    "discord_bridge": {
        "enabled": true,
        "listen_port": 8181,
        "listen_ip": "127.0.0.1",
        "max_message_length": 65535,
        "connection_timeout": 300,
        "channels": [
            {
                "mud_channel": "gossip",
                "discord_name": "gossip",
                "enabled": true,
                "filter_emotes": false
            },
            {
                "mud_channel": "auction",
                "discord_name": "auction", 
                "enabled": true,
                "filter_emotes": false
            },
            {
                "mud_channel": "gratz",
                "discord_name": "gratz",
                "enabled": true,
                "filter_emotes": false
            }
        ],
        "message_format": {
            "from_discord": "[Discord] %name%: %message%",
            "to_discord": "standard"
        }
    }
}
```

## Testing Checklist

### Basic Functionality
- [ ] TCP server starts and listens on configured port
- [ ] Accepts connection from Discord bridge
- [ ] Receives and parses JSON messages correctly
- [ ] Routes messages to correct MUD channels
- [ ] Sends MUD messages to Discord bridge
- [ ] Handles connection drops gracefully
- [ ] Supports reconnection from Discord bridge

### Message Handling
- [ ] Processes regular chat messages
- [ ] Handles emotes/actions correctly
- [ ] Filters out unwanted message types
- [ ] Respects message length limits
- [ ] Handles Unicode/special characters
- [ ] Strips MUD formatting codes

### Error Handling
- [ ] Handles malformed JSON without crashing
- [ ] Manages network errors gracefully
- [ ] Logs errors appropriately
- [ ] Continues operation after errors
- [ ] Provides meaningful error messages

### Performance
- [ ] Handles high message volume
- [ ] Minimal latency (< 100ms)
- [ ] Efficient memory usage
- [ ] No memory leaks over time
- [ ] Scales with multiple channels

## Monitoring and Logging

### Recommended Logging
1. **Connection events**: Connect, disconnect, reconnect attempts
2. **Message statistics**: Messages sent/received per channel
3. **Error events**: JSON parsing errors, network errors
4. **Performance metrics**: Message latency, queue sizes

**Note**: The Discord bridge now includes automatic file logging to `logs/app.log` with timestamps and log levels for better debugging and monitoring.

### Health Checks
1. **Connection status**: Is Discord bridge connected?
2. **Message flow**: Last message sent/received timestamp
3. **Error rate**: Errors per minute/hour
4. **Channel status**: Which channels are active

## Troubleshooting Guide

### Common Issues and Solutions

#### Discord bridge won't connect
- Verify TCP server is listening on correct port
- Check firewall rules
- Confirm IP address is accessible
- Review connection logs

#### Messages not appearing in MUD
- Verify JSON parsing is working
- Check channel name mapping
- Confirm channel is enabled
- Review message routing logic

#### Messages not reaching Discord
- Ensure JSON format is correct
- Verify socket write is successful
- Check for network issues
- Monitor Discord bridge logs

#### High latency or message delays
- Check network connection quality
- Review message queue implementation
- Monitor server CPU/memory usage
- Consider implementing message batching

## Support and Maintenance

### Version Compatibility
- Maintain backward compatibility with message format
- Version protocol if breaking changes needed
- Document all protocol changes

### Discord Bridge Deployment Options
The Discord bridge now supports multiple deployment methods:
1. **Standard Node.js**: `npm start` or `node src/index.js`
2. **PM2 Process Manager**: `pm2 start ecosystem.config.js`
3. **Docker Container**: `docker-compose up -d`

### Future Enhancements
1. **Bidirectional authentication**
2. **Message encryption (TLS)**
3. **Compression for high-volume channels**
4. **Rich message support** (attachments, reactions)
5. **Command bridge** for MUD commands via Discord
6. **Presence synchronization** (online player lists)

## Appendix: Sample Implementation

### Python Example (Basic TCP Server)
```python
import socket
import json
import threading

class DiscordBridge:
    def __init__(self, port=8181):
        self.port = port
        self.socket = None
        self.client = None
        
    def start(self):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.bind(('127.0.0.1', self.port))
        self.socket.listen(1)
        print(f"Discord bridge listening on port {self.port}")
        
        while True:
            client, address = self.socket.accept()
            print(f"Discord bridge connected from {address}")
            self.client = client
            self.handle_client()
    
    def handle_client(self):
        buffer = ""
        while True:
            try:
                data = self.client.recv(4096).decode('utf-8')
                if not data:
                    break
                    
                buffer += data
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    self.process_message(line)
                    
            except Exception as e:
                print(f"Error handling client: {e}")
                break
                
        print("Discord bridge disconnected")
        self.client = None
    
    def process_message(self, data):
        try:
            message = json.loads(data)
            # Route message to MUD channel
            self.route_to_mud(
                message.get('channel'),
                message.get('name'),
                message.get('message')
            )
        except json.JSONDecodeError as e:
            print(f"Invalid JSON received: {e}")
    
    def send_to_discord(self, channel, name, message, emoted=0):
        if not self.client:
            return
            
        data = json.dumps({
            'channel': channel,
            'name': name,
            'message': message,
            'emoted': emoted
        })
        
        try:
            self.client.send((data + '\n').encode('utf-8'))
        except Exception as e:
            print(f"Error sending to Discord: {e}")
    
    def route_to_mud(self, channel, name, message):
        # Implement MUD-specific routing logic here
        print(f"[{channel}] Discord/{name}: {message}")
```

This document provides comprehensive technical requirements for implementing Discord bridge support on the MUD side. The implementation should focus on reliability, security, and maintainability while providing seamless bidirectional communication between MUD and Discord users.