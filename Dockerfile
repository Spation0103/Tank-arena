FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS node-runtime

WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN apk add --no-cache binutils \
    && strip --strip-debug --strip-unneeded /usr/local/bin/node \
    && npm ci --omit=dev

FROM alpine:3.23 AS runtime

ARG BUILD_SHA=development
ENV NODE_ENV=production
ENV PORT=3001
ENV LOG_DIR=/data/logs
ENV BUILD_SHA=${BUILD_SHA}
WORKDIR /app

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ libgcc \
    && addgroup -S -g 1000 node \
    && adduser -S -u 1000 -G node node
COPY --from=node-runtime --chown=node:node /app/node_modules ./node_modules
RUN mkdir -p /data/logs && chown -R node:node /app /data
COPY --from=build --chown=node:node /app/server/build ./server/build
COPY --from=build --chown=node:node /app/client/dist ./client/dist

USER node
EXPOSE 3001
VOLUME ["/data/logs"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/build/server/index.js"]
