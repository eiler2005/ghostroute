FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM builder AS prod-deps
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
RUN apk add --no-cache bash openssh-client tini && \
    addgroup -g 10000 ghostroute && \
    adduser -D -u 10000 -G ghostroute ghostroute
WORKDIR /app
ARG GHOSTROUTE_CONSOLE_BUILD_COMMIT=unknown
ARG GHOSTROUTE_CONSOLE_BUILD_AT=unknown
ENV NODE_ENV=production
ENV GHOSTROUTE_CONSOLE_BUILD_COMMIT=${GHOSTROUTE_CONSOLE_BUILD_COMMIT}
ENV GHOSTROUTE_CONSOLE_BUILD_AT=${GHOSTROUTE_CONSOLE_BUILD_AT}
COPY --from=builder --chown=ghostroute:ghostroute /app/.next/standalone ./
COPY --from=prod-deps --chown=ghostroute:ghostroute /app/node_modules ./node_modules
COPY --from=builder --chown=ghostroute:ghostroute /app/.next/static ./.next/static
COPY --from=builder --chown=ghostroute:ghostroute /app/public ./public
COPY --from=builder --chown=ghostroute:ghostroute /app/scripts ./scripts
COPY --from=builder --chown=ghostroute:ghostroute /app/src/lib ./src/lib
USER ghostroute
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/run-with-collector.mjs"]
