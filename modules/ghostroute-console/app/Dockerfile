FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
RUN apk add --no-cache bash openssh-client tini && \
    addgroup -g 10000 ghostroute && \
    adduser -D -u 10000 -G ghostroute ghostroute
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=ghostroute:ghostroute /app/.next/standalone ./
COPY --from=builder --chown=ghostroute:ghostroute /app/.next/static ./.next/static
COPY --from=builder --chown=ghostroute:ghostroute /app/public ./public
COPY --from=builder --chown=ghostroute:ghostroute /app/scripts ./scripts
USER ghostroute
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/run-with-collector.mjs"]
