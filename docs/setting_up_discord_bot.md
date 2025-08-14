# Setting Up Discord Bot for MUD-Discord-Chat

This guide walks through setting up a Discord bot for the mud-discord-chat application on Ubuntu.

## Prerequisites
- Ubuntu server with Node.js v18+ installed
- Discord account
- Discord server where you have admin permissions

## Step 1: Create Discord Application

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name your application and create it
4. Save the Application ID and Public Key (for reference)

## Step 2: Create Bot

1. In your application, go to the **"Bot"** section in the left sidebar
2. Click **"Add Bot"** or **"Create Bot"**
3. Copy and save the **Bot Token** - you'll need this for your `.env` file

## Step 3: Configure Bot Settings

1. In the Bot section, configure:
   - **Public Bot**: Can be ON or OFF based on preference
   - Under **Privileged Gateway Intents**, turn ON:
     - Message Content Intent
     - Server Members Intent  
     - Presence Intent (optional but recommended)
2. Save changes

## Step 4: Generate Invite Link

1. Go to **"OAuth2"** � **"URL Generator"** in the left sidebar
2. Select **Scopes**:
   - `bot`
3. Select **Bot Permissions**:
   - Send Messages
   - View Channels (or Read Messages/View Channels)
   - Read Message History
4. Copy the generated URL at the bottom

## Step 5: Add Bot to Your Server

1. Open the invite URL in your browser
2. Select **Guild Install** if prompted
3. Choose your Discord server from the dropdown
4. Click "Authorize"

## Step 6: Install Application on Server

1. Check Node.js is installed:
   ```bash
   node --version  # Should be v18 or higher
   ```

2. Clone the repository:
   ```bash
   cd ~
   git clone https://github.com/LuminariMUD/discord-mud-chat.git
   cd discord-mud-chat
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Set up configuration files:
   ```bash
   cp config/config.example.json config/config.json
   cp .env.example .env
   ```

5. Add your bot token to `.env`:
   ```bash
   nano .env
   # Add: DISCORD_TOKEN=your_bot_token_here
   ```

6. Configure MUD connection in `config/config.json`:
   ```bash
   nano config/config.json
   ```
   Set:
   - `"mud_host": "127.0.0.1"` or `"localhost"`
   - `"mud_port": YOUR_MUD_LISTENER_PORT`
   - Configure channel mappings as needed

## Step 7: Run the Bot

Test the connection:
```bash
npm start
```

You should see:
- Connection to your MUD
- Bot logged into Discord
- List of monitored channels

## Step 8: Keep Bot Running Permanently with PM2

### Install PM2
```bash
sudo npm install -g pm2
```

### Start the bot with PM2
```bash
# From the discord-mud-chat directory
pm2 start ecosystem.config.js
```

You should see the bot listed as "online" in the PM2 output.

### Verify bot is running
```bash
pm2 status
```

### Set up auto-start on server reboot
1. Generate startup script:
   ```bash
   pm2 startup
   ```
   This will output a command starting with `sudo env PATH=...`

2. Copy and run the exact command it gives you (you may need to run it as root/sudo)

3. Save the current PM2 process list:
   ```bash
   pm2 save
   ```

### Useful PM2 commands
```bash
pm2 logs            # View bot logs
pm2 monit           # Real-time monitoring
pm2 restart all     # Restart the bot
pm2 stop all        # Stop the bot
pm2 status          # Check bot status
```

Your bot will now:
- Run continuously in the background
- Auto-restart if it crashes
- Start automatically when the server reboots

## Troubleshooting

- **"Used disallowed intents" error**: Make sure all required intents are enabled in the Bot settings (Message Content, Server Members, Presence)
- **"Private application cannot have a default authorization link"**: This warning when making the bot private is normal - you can leave it public if needed
- **Bot not responding**: Check channel mappings in config.json match your Discord channel names
- **Connection refused**: Verify MUD listener port is correct and accepting connections
- **PM2 not found**: Make sure to install PM2 globally with `sudo npm install -g pm2`