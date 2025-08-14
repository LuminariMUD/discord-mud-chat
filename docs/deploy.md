# Deployment Guide

This guide provides comprehensive instructions for deploying the MUD-Discord Chat bridge using various methods, with Docker as the recommended approach.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Installation](#local-installation)
- [Docker Deployment (Recommended)](#docker-deployment-recommended)
- [PM2 Deployment](#pm2-deployment)
- [Production Best Practices](#production-best-practices)
- [Monitoring & Health Checks](#monitoring--health-checks)
- [Security Configuration](#security-configuration)
- [Troubleshooting](#troubleshooting)
- [Updates & Maintenance](#updates--maintenance)

## Prerequisites

### System Requirements

- **Node.js**: Version 18.x or higher (for local/PM2 deployment)
- **Docker**: Version 20.10+ and Docker Compose 2.0+ (for Docker deployment)
- **Memory**: Minimum 256MB RAM
- **Disk**: 100MB for application and dependencies
- **Network**: Outbound HTTPS for Discord API, TCP connection to MUD server

### Discord Bot Setup

1. **Create Discord Application**
   - Visit [Discord Developer Portal](https://discord.com/developers/applications/)
   - Create a new application and navigate to the Bot section
   - Reset Token and save it for later use
   - Enable these Privileged Gateway Intents:
     - Server Members Intent
     - Message Content Intent

2. **Invite Bot to Server**
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=3072
   ```

3. **Get Channel IDs**
   - Enable Developer Mode in Discord (Settings → Advanced)
   - Right-click channels and select "Copy ID"

## Local Installation

### Quick Start

1. **Clone and Install**
   ```bash
   git clone https://github.com/gesslar/mud-discord-chat.git
   cd mud-discord-chat
   npm install
   ```

2. **Configure Environment**
   ```bash
   # Copy and edit environment file
   cp .env.example .env
   nano .env  # Add your DISCORD_TOKEN
   
   # Copy and edit configuration
   cp config/config.example.json config/config.json
   nano config/config.json  # Configure MUD settings and channel mappings
   ```

3. **Run the Application**
   ```bash
   # Production mode
   npm start
   
   # Development mode (with auto-restart)
   npm run dev
   
   # Run linter
   npm run lint
   ```

4. **Verify Operation**
   - Check console output for successful connections
   - Visit health endpoint: `http://localhost:3000/health`
   - Test message relay between Discord and MUD

### Configuration Details

#### Environment Variables (.env)

```env
# Required
DISCORD_TOKEN=your_discord_bot_token_here

# Optional
MUD_AUTH_TOKEN=your_mud_auth_token      # MUD authentication token
HEALTH_PORT=3000                        # Health check endpoint port
LOG_LEVEL=info                          # Logging level (error, warn, info, debug)
```

#### Configuration File (config/config.json)

```json
{
    "mud_name": "YourMUD",
    "mud_ip": "127.0.0.1",
    "mud_port": 8181,
    "mud_auth_token": "",                  // Optional authentication
    "mud_retry_count": 5,
    "mud_retry_delay": 30000,
    "rate_limit_per_channel": 10,          // Messages per second
    "channels": [
        { "discord": "CHANNEL_ID", "mud": "gossip" }
    ],
    "strip_emoji": true,
    "enable_bitly": false,
    "largest_printable_string": 65535
}
```

### Local Development Tips

- Use `npm run dev` for automatic restart on code changes
- Set `LOG_LEVEL=debug` for verbose logging
- Monitor logs in `logs/` directory
- Use VS Code with the ESLint extension for code quality

## Docker Deployment (Recommended)

### Quick Docker Setup

1. **Prepare Configuration**
   ```bash
   cp .env.example .env
   cp config/config.example.json config/config.json
   # Edit both files with your settings
   ```

2. **Start with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Verify Deployment**
   ```bash
   docker-compose ps                      # Check container status
   docker-compose logs -f                 # View logs
   curl http://localhost:3000/health      # Check health endpoint
   ```

### Docker Commands Reference

```bash
# Container Management
docker-compose up -d                    # Start in background
docker-compose down                     # Stop and remove containers
docker-compose restart                  # Restart containers
docker-compose ps                       # List containers
docker-compose logs -f                  # Follow logs

# Updates
git pull origin main                    # Pull latest code
docker-compose down                     # Stop current version
docker-compose up -d --build           # Rebuild and start

# Debugging
docker-compose exec mud-discord-chat sh    # Enter container shell
docker stats mud-discord-chat              # Monitor resources
docker-compose logs --tail=100            # View last 100 log lines
```

### Custom Docker Configuration

#### docker-compose.yml Modifications

```yaml
services:
  mud-discord-chat:
    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          memory: 256M
    
    # Custom health check
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    
    # Log rotation
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## PM2 Deployment

### Installation and Setup

1. **Install PM2 Globally**
   ```bash
   npm install -g pm2
   ```

2. **Start Application**
   ```bash
   # Production mode
   pm2 start ecosystem.config.js
   
   # Development mode with file watching
   pm2 start ecosystem.config.js --env development
   ```

3. **Configure Startup**
   ```bash
   pm2 save                    # Save current process list
   pm2 startup                 # Generate startup script
   # Follow the instructions provided by pm2 startup
   ```

### PM2 Commands

```bash
# Process Management
pm2 list                       # List all processes
pm2 show mud-discord-chat     # Detailed process info
pm2 restart mud-discord-chat  # Restart application
pm2 stop mud-discord-chat     # Stop application
pm2 delete mud-discord-chat   # Remove from PM2

# Monitoring
pm2 monit                      # Real-time monitoring
pm2 logs mud-discord-chat     # View logs
pm2 logs --lines 100          # View last 100 lines

# Cluster Mode (if needed)
pm2 start ecosystem.config.js -i max  # Use all CPU cores
pm2 scale mud-discord-chat 2         # Scale to 2 instances
```

### PM2 Configuration (ecosystem.config.js)

The project includes a comprehensive PM2 configuration with:
- Memory limits (256MB max)
- Automatic restarts on failure
- Daily restart at 4 AM for log rotation
- Development mode with file watching
- Graceful shutdown support

## Production Best Practices

### 1. Environment Security

```bash
# Secure file permissions
chmod 600 .env
chmod 600 config/config.json
chmod 755 logs/

# Use environment variables for sensitive data
export DISCORD_TOKEN="your_token"
export MUD_AUTH_TOKEN="your_auth"
```

### 2. Process Management

- Use Docker or PM2 for automatic restarts
- Configure health checks for monitoring
- Set up log rotation to prevent disk filling
- Implement graceful shutdown handlers

### 3. Network Security

```bash
# Firewall rules (example with ufw)
ufw allow from any to any port 3000  # Health check
ufw allow out 443/tcp                # Discord API
ufw allow out 8181/tcp               # MUD server
```

### 4. Backup Strategy

```bash
# Backup configuration
cp config/config.json config/config.backup.json

# Backup logs (optional)
tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/

# Automated backup script
#!/bin/bash
BACKUP_DIR="/backups/mud-discord"
mkdir -p $BACKUP_DIR
cp config/config.json $BACKUP_DIR/config-$(date +%Y%m%d).json
```

## Monitoring & Health Checks

### Health Endpoint

The application provides a health endpoint at `http://localhost:3000/health`:

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

### Monitoring Setup

1. **Simple Monitoring Script**
   ```bash
   #!/bin/bash
   # health-check.sh
   response=$(curl -s http://localhost:3000/health)
   if [[ $(echo $response | jq -r '.status') != "healthy" ]]; then
     echo "Alert: Service unhealthy"
     # Send alert (email, webhook, etc.)
   fi
   ```

2. **Integration with Monitoring Services**
   - **Uptime Kuma**: Add HTTP monitor for health endpoint
   - **Prometheus**: Scrape metrics from health endpoint
   - **Grafana**: Visualize health metrics

### Logging

Winston logger provides multiple outputs:
- **Console**: Colored output in development
- **Files**: Rotating logs with 7-day retention
  - `logs/app.log` - All logs
  - `logs/error.log` - Errors only
  - `logs/pm2-*.log` - PM2 specific logs

Configure log level via `LOG_LEVEL` environment variable:
- `error` - Only errors
- `warn` - Warnings and errors
- `info` - General information (default)
- `debug` - Detailed debugging

## Security Configuration

### Authentication

1. **MUD Authentication**
   ```json
   {
     "mud_auth_token": "your-secret-token"
   }
   ```
   The token is sent on connection:
   ```json
   {"channel": "auth", "name": "bot", "message": "your-secret-token"}
   ```

2. **Discord Security**
   - Bot token stored in environment variable
   - @everyone/@here mentions automatically stripped
   - Rate limiting prevents spam (10 msg/sec default)

### Docker Security

The Docker image implements security best practices:
- Runs as non-root user (nodejs:1001)
- Uses Alpine Linux for smaller attack surface
- Configuration mounted as read-only
- Production dependencies only

### File Permissions

```bash
# Set appropriate ownership
chown -R 1001:1001 ./logs        # For Docker
chown -R $USER:$USER ./logs      # For local

# Restrict sensitive files
chmod 600 .env
chmod 600 config/config.json
chmod 755 logs/
```

## Troubleshooting

### Common Issues

#### Bot Not Connecting to Discord
```bash
# Check token
echo $DISCORD_TOKEN

# Verify bot permissions in Discord Developer Portal
# Ensure Message Content Intent is enabled
```

#### MUD Connection Failed
```bash
# Test connectivity
nc -zv mud-server-ip 8181
telnet mud-server-ip 8181

# Check firewall
sudo iptables -L -n | grep 8181
```

#### High Memory Usage
```bash
# Monitor memory
docker stats mud-discord-chat
pm2 monit

# Restart if needed
docker-compose restart
pm2 restart mud-discord-chat
```

#### Permission Errors
```bash
# Fix log directory permissions
sudo chown -R $(whoami):$(whoami) logs/
# Or for Docker
sudo chown -R 1001:1001 logs/
```

### Debug Mode

Enable debug logging for troubleshooting:

```bash
# Local/PM2
LOG_LEVEL=debug npm start

# Docker
docker-compose down
echo "LOG_LEVEL=debug" >> .env
docker-compose up
```

### Validation Checklist

Before reporting issues, verify:
- [ ] Discord bot token is valid
- [ ] Bot has required permissions (Send Messages, Read Message History, View Channels)
- [ ] Channel IDs in config.json are correct
- [ ] MUD server is accessible from your host
- [ ] No typos in configuration files
- [ ] Application dependencies are installed
- [ ] Sufficient disk space for logs

## Updates & Maintenance

### Updating the Application

1. **Backup Current Configuration**
   ```bash
   cp config/config.json config/config.backup.json
   cp .env .env.backup
   ```

2. **Pull Latest Changes**
   ```bash
   git pull origin main
   npm install  # Update dependencies
   ```

3. **Restart Application**
   ```bash
   # Docker
   docker-compose down
   docker-compose up -d --build
   
   # PM2
   pm2 restart mud-discord-chat
   
   # Local
   # Ctrl+C to stop, then npm start
   ```

### Maintenance Tasks

#### Log Rotation
- Docker: Automatic via logging driver
- PM2: Daily restart at 4 AM (configured)
- Local: Manual cleanup or use logrotate

#### Dependency Updates
```bash
npm outdated          # Check for updates
npm update           # Update minor versions
npm audit            # Security check
npm audit fix        # Fix vulnerabilities
```

#### Performance Optimization
- Monitor message throughput via health endpoint
- Adjust rate limits if needed
- Review logs for connection issues
- Consider scaling with PM2 cluster mode if needed

## Support

For additional help:

1. Check [GitHub Issues](https://github.com/gesslar/mud-discord-chat/issues)
2. Review logs in `./logs` directory
3. Enable debug logging with `LOG_LEVEL=debug`
4. Create issue with:
   - Node.js/Docker versions
   - Complete error logs
   - Sanitized configuration
   - Steps to reproduce

## Additional Resources

- [Docker Documentation](https://docs.docker.com/)
- [PM2 Documentation](https://pm2.keymetrics.io/)
- [Discord.js Guide](https://discordjs.guide/)
- [Project Repository](https://github.com/gesslar/mud-discord-chat)
- [Technical Requirements](bridge_requires.md)