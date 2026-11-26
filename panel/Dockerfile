# Stage 1: Build Vue 3 SPA
FROM oven/bun:1-alpine AS web-builder
WORKDIR /app

COPY package.json bun.lock* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN bun install --frozen-lockfile || bun install

COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/web ./apps/web

RUN bun --filter @panel/web build

# Stage 2: Lightweight Bun Runtime + postgresql17-client + openssl
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache postgresql17-client openssl ca-certificates

COPY --from=web-builder /app/node_modules ./node_modules
COPY --from=web-builder /app/apps/api ./apps/api
COPY --from=web-builder /app/apps/web/dist ./apps/api/public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["bun", "run", "apps/api/src/index.ts"]
