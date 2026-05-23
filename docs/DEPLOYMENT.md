# Deployment

> Target: v3.1 sub-$5/mo. Fly.io auto-stop machine + Neon Postgres free + Cloudflare DNS/Cron + AWS SES + Postmark Inbound.

## Architecture in one breath

```
Cloudflare DNS + 7am keep-warm cron
        │
        ▼
Fly machine (shared-cpu-1x@512MB, min_machines_running = 0)
  • Fastify  → /api/*  + webhooks
  • DB-backed job runner (in-process)
        │
        ▼
Neon Postgres (scale-to-zero)
        │
        ├── AWS SES (outbound)
        └── Postmark Inbound (reply parser)
```

## Prerequisites
- Fly.io account + `flyctl` CLI
- Neon account
- AWS account (SES)
- Postmark account (Inbound stream only)
- Cloudflare account for DNS

## Step 1 — Database
1. Create a Neon project.
2. Copy the **pooled** connection string (the `*-pooler.<region>.neon.tech` host).
3. Append `?sslmode=require`.

## Step 2 — Fly app
```bash
flyctl auth login
flyctl launch --no-deploy --copy-config=false --name keres-ops --region iad
```

Then write `fly.toml`:
```toml
app = "keres-ops"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Set secrets:
```bash
flyctl secrets set \
  DATABASE_URL='postgres://...neon.tech/...?sslmode=require' \
  DATABASE_DRIVER='neon-serverless' \
  AUTH_TOKEN='...' \
  AUTH_COOKIE_SECRET='...' \
  PUBLIC_BASE_URL='https://keres-ops.fly.dev' \
  SAMPLE_MODE='false' \
  ENABLE_SES='true' \
  SES_REGION='us-east-1' \
  SES_ACCESS_KEY_ID='...' SES_SECRET_ACCESS_KEY='...' \
  SES_CONFIGURATION_SET='keres-outreach' \
  SES_PRODUCTION_ACCESS_CONFIRMED='true' \
  ENABLE_POSTMARK_INBOUND='true' \
  POSTMARK_INBOUND_USERNAME='...' POSTMARK_INBOUND_PASSWORD='...'
```

## Step 3 — Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
EXPOSE 8080
CMD ["pnpm", "--filter", "@keres/server", "start"]
```

(The static frontend served from `apps/web/dist`. Wire `@fastify/static` to it in `apps/server/src/index.ts` if you'd like a single-domain deploy — current scaffold proxies via Vite in dev and you can serve the SPA from a separate Cloudflare Pages site in prod.)

## Step 4 — Deploy
```bash
flyctl deploy
```

## Step 5 — Cloudflare DNS + Cron
1. Point your domain at the Fly app.
2. Create a Cron Trigger that hits `https://keres-ops.fly.dev/api/health` at 7am M–F. This wakes the auto-stopped machine before the operator's day starts and keeps Neon warm.

## Step 6 — AWS SES
1. Verify your outreach subdomain in SES.
2. Add SPF (`v=spf1 include:amazonses.com -all`), DKIM CNAMEs (3 SES-provided), DMARC (`v=DMARC1; p=none; rua=mailto:rua@yourdomain.com`).
3. Open production-access request in SES console.
4. Create a configuration set `keres-outreach` with SNS event destinations for Bounce, Complaint, Delivery, Send, Reject.
5. The SNS topic should HTTP/S deliver to `https://keres-ops.fly.dev/api/webhooks/ses`. The first POST will be `SubscriptionConfirmation` — the server returns it back as `subscribeUrl` in the response; copy/paste it into a browser to confirm.

## Step 7 — Postmark Inbound
1. In Postmark, create a Server with an Inbound stream.
2. Set the inbound webhook URL to `https://keres-ops.fly.dev/api/webhooks/inbound`.
3. Optionally protect it with Basic Auth and configure `POSTMARK_INBOUND_USERNAME` / `POSTMARK_INBOUND_PASSWORD`.
4. Set up an MX record on the inbound subdomain (e.g. `inbound.outreach.yourdomain.com`) pointing to `inbound.postmarkapp.com`.
5. Configure `Reply-To` to that inbound address.

## Step 8 — Confirm
- Sign in to `https://keres-ops.fly.dev`.
- Settings → confirm sender identity is complete.
- Deliverability → run DNS check. All four tiles green.
- Validation → kick off a Day-0 review experiment.

## Cost reconciliation
After 30 days, the Costs page should show monthly burn under $5 at ~1k qualified leads/month.
