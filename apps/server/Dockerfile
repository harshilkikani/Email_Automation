# Multi-stage build — single Fly machine runs both the API and the SPA.
#
# Stage 1 — install + build all packages including the web SPA.
# Stage 2 — slim runtime with @fastify/static serving apps/web/dist on `/`.
#
# Behavior controlled by the SERVE_WEB env var (defaulted to `true` in this image).

FROM node:20-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/email/package.json packages/email/
COPY packages/providers/package.json packages/providers/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @keres/core build \
 && pnpm --filter @keres/db build \
 && pnpm --filter @keres/email build \
 && pnpm --filter @keres/providers build \
 && pnpm --filter @keres/server build \
 && pnpm --filter @keres/web build

FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

ENV NODE_ENV=production
ENV SERVE_WEB=true
ENV WEB_DIST_PATH=/app/apps/web/dist

COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/apps/server/package.json apps/server/
COPY --from=builder /repo/apps/server/dist apps/server/dist
COPY --from=builder /repo/apps/web/package.json apps/web/
COPY --from=builder /repo/apps/web/dist apps/web/dist
COPY --from=builder /repo/packages/core/package.json packages/core/
COPY --from=builder /repo/packages/core/dist packages/core/dist
COPY --from=builder /repo/packages/db/package.json packages/db/
COPY --from=builder /repo/packages/db/dist packages/db/dist
COPY --from=builder /repo/packages/db/migrations packages/db/migrations
COPY --from=builder /repo/packages/email/package.json packages/email/
COPY --from=builder /repo/packages/email/dist packages/email/dist
COPY --from=builder /repo/packages/providers/package.json packages/providers/
COPY --from=builder /repo/packages/providers/dist packages/providers/dist

RUN pnpm install --prod --frozen-lockfile

EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
