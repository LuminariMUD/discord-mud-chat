# Use the latest Node.js LTS release on Alpine Linux
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

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

# Expose port for health checks
EXPOSE 3000

# Start the application
CMD ["node", "src/index.js"]
