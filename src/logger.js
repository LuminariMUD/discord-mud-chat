const winston = require("winston");
const path = require("path");
const fs = require("fs");

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, "../logs");
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        
        // Create winston logger
        this.winston = winston.createLogger({
            level: process.env.LOG_LEVEL || "info",
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.printf(({ timestamp, level, message, stack }) => {
                    if (stack) {
                        return `[${timestamp}] [${level.toUpperCase()}] ${message}\n${stack}`;
                    }
                    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
                })
            ),
            transports: [
                // Console transport
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    )
                }),
                // File transport for all logs
                new winston.transports.File({
                    filename: path.join(this.logDir, "app.log"),
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 7, // Keep 7 days of logs
                    tailable: true
                }),
                // Separate file for errors
                new winston.transports.File({
                    filename: path.join(this.logDir, "error.log"),
                    level: "error",
                    maxsize: 10 * 1024 * 1024,
                    maxFiles: 7,
                    tailable: true
                })
            ]
        });
        
        // Override console methods to use winston
        this.setupConsoleOverrides();
    }

    setupConsoleOverrides() {
        console.log = (...args) => {
            const message = args.join(" ");
            this.winston.info(message);
        };

        console.error = (...args) => {
            const message = args.join(" ");
            this.winston.error(message);
        };

        console.warn = (...args) => {
            const message = args.join(" ");
            this.winston.warn(message);
        };
        
        console.debug = (...args) => {
            const message = args.join(" ");
            this.winston.debug(message);
        };
    }
}

module.exports = Logger;