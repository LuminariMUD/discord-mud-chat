# Use the latest Node.js LTS release on Alpine Linux
FROM node:26.8.1-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Use the package manager version declared by the project and install production dependencies
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" && \
    npm ci --omit=dev && \
    npm cache clean --force

# Copy application files
COPY src ./src
COPY config ./config

# Create logs directory
RUN mkdir -p logs

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of app directory
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Start the application
CMD ["node", "src/index.js"]
