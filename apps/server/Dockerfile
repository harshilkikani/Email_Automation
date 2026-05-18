# Multi-stage build for the Keres API server.
#
# Stage 1 — install + build all packages.
# Stage 2 — copy only runtime artefacts into a slim image.
#
# Note: we serve the API only from this image. The web SPA is built separately
# and served either by Cloudflare Pages or by enabling `@fastify/static` on the
# `apps/web/dist` output. Keeping them separate keeps the container small.

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
 && pnpm --filter @keres/server build

FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

ENV NODE_ENV=production

COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/apps/server/package.json apps/server/
COPY --from=builder /repo/apps/server/dist apps/server/dist
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
