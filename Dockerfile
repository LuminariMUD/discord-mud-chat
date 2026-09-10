# Use the latest Node.js LTS release on Alpine Linux
FROM node:26.8.2-alpine3.24@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

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
