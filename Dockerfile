# syntax=docker/dockerfile:1
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi && \
    npm install --global "$(node -p 'require("./package.json").packageManager')" && \
    npm ci --omit=dev

COPY src ./src
COPY config ./config

RUN addgroup -g 1001 -S nodejs && \
    adduser -S -G nodejs -u 1001 nodejs && \
    mkdir logs && chown nodejs:nodejs logs

USER nodejs
CMD ["node", "src/index.js"]
