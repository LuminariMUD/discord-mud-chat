const winston = require("winston");
const path = require("path");
const fs = require("fs");

/** Writes structured console and file logs through Winston. */
class Logger {
    /** Creates the Winston transports and optionally redirects console methods. */
    constructor(options = {}) {
        this.consoleRef = options.consoleRef || console;
        this.originalConsoleMethods = undefined;
        this.consoleOverrides = undefined;
        this.logDir = options.logDir || path.join(__dirname, "../logs");

        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        // Create winston logger
        this.winston = winston.createLogger({
            level: options.level || process.env.LOG_LEVEL || "info",
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
        if (options.overrideConsole !== false) this.setupConsoleOverrides();
    }

    /** Routes console calls through the configured Winston logger. */
    setupConsoleOverrides() {
        if (this.originalConsoleMethods) return;

        this.originalConsoleMethods = {
            log: this.consoleRef.log,
            error: this.consoleRef.error,
            warn: this.consoleRef.warn,
            debug: this.consoleRef.debug
        };
        this.consoleOverrides = {
            log: (...args) => {
                const message = args.join(" ");
                this.winston.info(message);
            },
            error: (...args) => {
                const message = args.join(" ");
                this.winston.error(message);
            },
            warn: (...args) => {
                const message = args.join(" ");
                this.winston.warn(message);
            },
            debug: (...args) => {
                const message = args.join(" ");
                this.winston.debug(message);
            }
        };

        Object.assign(this.consoleRef, this.consoleOverrides);
    }

    /** Restores console methods still owned by this logger instance. */
    restoreConsoleOverrides() {
        if (!this.originalConsoleMethods) return;

        for (const [method, original] of Object.entries(this.originalConsoleMethods)) {
            if (this.consoleRef[method] === this.consoleOverrides[method]) {
                this.consoleRef[method] = original;
            }
        }

        this.originalConsoleMethods = undefined;
        this.consoleOverrides = undefined;
    }

    /** Restores the console and closes all Winston transports. */
    close() {
        this.restoreConsoleOverrides();
        this.winston.close();
    }
}

module.exports = Logger;
