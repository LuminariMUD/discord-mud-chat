module.exports = {
  apps: [{
    name: "mud-discord-chat",
    script: "./src/index.js",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "256M",  // Reduced from 1G - app shouldn't use much memory
    
    // Environment variables
    env: {
      NODE_ENV: "production",
      HEALTH_PORT: 3000,
      LOG_LEVEL: "info"
    },
    env_development: {
      NODE_ENV: "development",
      HEALTH_PORT: 3000,
      LOG_LEVEL: "debug",
      watch: ["src", "config"],
      ignore_watch: ["node_modules", "logs", "*.log", "config/config.json"],
      watch_delay: 1000
    },
    
    // Logging configuration
    error_file: "./logs/pm2-error.log",
    out_file: "./logs/pm2-out.log",
    log_file: "./logs/pm2-combined.log",
    time: true,
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    
    // Restart strategy
    min_uptime: "10s",
    max_restarts: 10,
    restart_delay: 4000,
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: false,  // We don't send ready signal
    listen_timeout: 3000,
    shutdown_with_message: true,
    
    // Process management
    cron_restart: "0 4 * * *",  // Daily restart at 4 AM for log rotation
    
    // Health monitoring  
    max_consecutive_restarts: 10,
    min_process_uptime: 10000,
    
    // Node.js flags
    node_args: "--max-old-space-size=256"  // Limit memory usage
  }]
};