# First-deployment runbook

> Stand the app up in production with **zero real provider credentials**. The launch gate will block real sends; everything else (UI, scheduler, DB, DNS check, license import, dedupe, validation reviews, CSV exports) runs. Estimated time: 30 min. Cost from this runbook: domain (~$1/mo, excluded from the $5/mo target) + Fly auto-stop (~$1.50/mo).

## Prerequisites

Before you start:
- `docs/SECRET-HANDLING.md` read.
- `docs/ACCOUNT-CREATION-CHECKLIST.md` steps 1–2 done (Fly + Neon accounts created).
- `flyctl auth login` complete (browser-based, no value to paste).
- `gh auth status` returns logged-in.
- Docker Desktop running locally if you want to run the integration suite first.

## 0. Run the preflight

```bash
pnpm install
pnpm preflight:local       # typecheck + lint + unit tests + (skipped: db:test + doctor without env)
pnpm preflight:deploy      # confirms repo is account-ready, prints next-step checklist
```

Both must pass. Any failure is a code issue to fix before deploying.

## 1. Create the Neon project

```bash
# In the Neon dashboard:
#   1. Click "New Project"
#   2. Region: AWS US East (Ohio or N. Virginia) — same as Fly's iad
#   3. Postgres version: 15 (default)
#   4. Project name: keres-prod
#
# Then click "Connection string" → pooled, ?sslmode=require
# Copy it into your password manager. Do NOT paste in chat.
```

## 2. Create the Fly app (no deploy yet)

```bash
flyctl launch --no-deploy --copy-config --name keres-ops --region iad
# Answers:
#   - "Would you like to set up Postgres?" → No (using Neon)
#   - "Would you like to set up Upstash?" → No
#   - "Create .dockerignore?" → No (we already have one)
```

This populates `fly.toml` and creates the app shell at https://keres-ops.fly.dev.

## 3. Set production secrets

Follow `docs/DEPLOYMENT-SECRETS-RUNBOOK.md` step 3. Summary:

```bash
pnpm secrets:gen --quiet > /tmp/k.txt
# Move the 3 values into 1Password under entries "Keres / AUTH_TOKEN" etc.
shred -u /tmp/k.txt    # macOS: rm -P, Windows: del /F /Q

# Then read each value back from 1Password into your terminal (NOT chat):
read -s -p 'AUTH_TOKEN: '                 AUTH_TOKEN                 && echo
read -s -p 'AUTH_COOKIE_SECRET: '         AUTH_COOKIE_SECRET         && echo
read -s -p 'UNSUBSCRIBE_SIGNING_SECRET: ' UNSUBSCRIBE_SIGNING_SECRET && echo
read -s -p 'DATABASE_URL: '               DATABASE_URL               && echo

flyctl secrets set \
  NODE_ENV=production \
  SAMPLE_MODE=false \
  ENABLE_SES=false \
  DATABASE_DRIVER=neon-serverless \
  DATABASE_URL="$DATABASE_URL" \
  AUTH_TOKEN="$AUTH_TOKEN" \
  AUTH_COOKIE_SECRET="$AUTH_COOKIE_SECRET" \
  UNSUBSCRIBE_SIGNING_SECRET="$UNSUBSCRIBE_SIGNING_SECRET" \
  PUBLIC_BASE_URL='https://keres-ops.fly.dev' \
  CORS_ORIGIN='https://keres-ops.fly.dev' \
  SERVE_WEB=true \
  ORG_NAME='Keres AI' \
  FROM_NAME='You at Keres AI' \
  FROM_EMAIL='hello@outreach.yourdomain.com' \
  REPLY_TO='replies@outreach.yourdomain.com' \
  PHYSICAL_ADDRESS='1 Real St, City, ST ZIP' \
  OUTREACH_SUBDOMAIN='outreach.yourdomain.com' \
  SEEDLIST_EMAILS='you1@gmail.com,you2@outlook.com' \
  --app keres-ops

unset AUTH_TOKEN AUTH_COOKIE_SECRET UNSUBSCRIBE_SIGNING_SECRET DATABASE_URL
```

Note: `ENABLE_SES=false` is intentional. The launch gate refuses real sends until SES is fully configured, but the app boots and the UI is fully usable.

## 4. Run migrations against Neon

```bash
# Use the same DATABASE_URL value (re-read from 1Password):
read -s -p 'DATABASE_URL: ' DATABASE_URL && echo

# Run migrations:
DATABASE_URL="$DATABASE_URL" node --import tsx packages/db/src/migrate.ts

# Seed (idempotent):
DATABASE_URL="$DATABASE_URL" PHYSICAL_ADDRESS='1 Real St' OUTREACH_SUBDOMAIN='outreach.yourdomain.com' \
  node --import tsx apps/server/src/seed.ts

unset DATABASE_URL
```

## 5. Deploy

```bash
flyctl deploy --app keres-ops
```

Build takes ~3 minutes. Watch logs:

```bash
flyctl logs --app keres-ops
```

Look for `Keres server listening on 8080 (sampleMode=false, ses=false)`.

## 6. Smoke test the deployment

```bash
# Health:
curl -s https://keres-ops.fly.dev/api/health
# Expect: {"ok":true,"sampleMode":false,"mode":"free"}

# Readiness (should fail because the launch gate is red — sample_mode_off passes,
# but ses_production_access still fails as expected):
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://keres-ops.fly.dev/api/ready
# Expect: HTTP 503 — that's correct. Fly's healthcheck uses /health, not /ready.

# Diagnostics with bearer auth:
read -s -p 'AUTH_TOKEN: ' TOK && echo
curl -s -H "Authorization: Bearer $TOK" https://keres-ops.fly.dev/api/diagnostics \
  | python -m json.tool | head -40
unset TOK
```

You should see the launch gate report 1-3 blockers (sender_domain_exists, ses_production_access, outbound_configured). That's the system telling you what to do next.

## 7. Wire CI auto-deploy

```bash
# Create a scoped deploy token (revocable any time):
flyctl tokens create deploy --app keres-ops
# Copy the FlyV1 fm2_... output.

gh secret set FLY_API_TOKEN --repo harshilkikani/keres-ai --body 'PASTE-TOKEN'
```

Now every `git push origin main` will:
1. Run `test.yml` (typecheck, lint, unit tests, integration tests against Postgres 15).
2. If green, run `deploy.yml` which calls `flyctl deploy --remote-only` using the token.

## 8. Add Cloudflare warm-up cron

In Cloudflare dashboard → Workers & Pages → Cron Triggers → add:

- Pattern: `0 7 * * MON-FRI` (7am UTC daily, M-F)
- Worker fetch: `https://keres-ops.fly.dev/api/health`

This wakes the auto-stopped Fly machine before your operator's day starts so the first real request doesn't hit a cold start.

(Cron uses Workers free quota; first 100k requests/day are free.)

## 9. Browse the app

Open https://keres-ops.fly.dev in your browser. Sign in with the AUTH_TOKEN you generated in step 3.

Navigate to:
- **`/first-run`** — Live 18-step checklist. Steps 1, 2, 3, 4, 7, 8 should be green. Steps 5 (SES production access), 6 (DNS not yet configured), 9 (no seedlist test yet) red.
- **`/diagnostics`** — Same checklist, system-wide. `outbound_configured` = fail. Expected.
- **`/discover`** — Try running discovery. With `ENABLE_OSM=true` (default), it will hit the public Overpass endpoint. ~25 leads inserted on first run.

The scheduler is now running 24/7 on Fly. Even with `ENABLE_SES=false`, it's doing:
- DNS recheck per hour (against your `outreach.yourdomain.com` once you create the domain).
- Warmup ramp (no-op until a sender domain is added).
- Budget alerts (nothing to alert on — zero spend).
- Domain rollover (resets sends/day at UTC midnight).
- License freshness check.

## 10. What's left before real sends

In order:

1. **Domain registrar** → register `<your-domain>`. ~5 min, ~$10/year.
2. **Cloudflare** → add the domain, create DNS records (placeholder; SES will give you SPF/DKIM/DMARC in the next step).
3. **AWS** → SES production-access ticket. ~24h wait.
4. **AWS SES** → verify `outreach.<your-domain>`, publish SPF + 3 DKIM CNAMEs + DMARC. Configuration set + SNS topic.
5. **`flyctl secrets set ENABLE_SES=true SES_REGION=us-east-1 SES_ACCESS_KEY_ID=... SES_SECRET_ACCESS_KEY=... SES_CONFIGURATION_SET=keres-outreach SES_PRODUCTION_ACCESS_CONFIRMED=true --app keres-ops`**
6. **`flyctl deploy --app keres-ops`** (or just push to main; CI will deploy).
7. **`/deliverability` in the UI** → "Check DNS" → all green.
8. **`/deliverability`** → "Send seedlist test" → manually verify each seed mailbox got primary placement.
9. **`/first-run`** → all 18 steps green except #15-#18 (campaign launch, monitoring, verdict, next action).
10. **`/validation`** → Day 0 review of 50 leads → if ≥70% A+B, build the 100-send reach test → launch.

The Septic / Houston pilot playbook lives in `docs/FIRST-RUN-SEPTIC-HOUSTON.md` from this point.

## Rollback

If anything goes wrong:

```bash
# Roll back to the previous Fly deployment:
flyctl releases --app keres-ops              # list versions
flyctl deploy --image registry.fly.io/keres-ops:deployment-<previous-id> --app keres-ops

# Or pause all sending without touching code:
flyctl secrets set ENABLE_SES=false --app keres-ops
```

## Cost recap

| Item | Monthly cost |
|---|---|
| Fly shared-cpu-1x@256mb auto-stop | ~$1.50 (idle = $0 compute) |
| Neon free tier | $0 |
| Cloudflare DNS + Cron | $0 |
| Domain | ~$1 (annual ÷ 12, excluded from $5/mo target) |
| AWS SES (after free 3k/mo first 12 months) | $0.10/1k after free |
| Postmark Inbound free 10k/mo | $0 |
| Bouncer (when enabled) | $8 every ~20 months |
| Hunter free | $0 |
| **Total (no SES)** | **~$1.50/mo** |
| **Total (with SES, 5k sends/mo)** | **~$3.40/mo** |
