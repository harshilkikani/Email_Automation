# Keres AI — internal lead-gen & cold-email validation console

> v3.1 architecture · sub-$5/mo · TypeScript monorepo · Vite + Fastify + Drizzle + Postgres.

This repo is the production implementation of the architecture described in `docs/UPDATED-ARCHITECTURE.md` and the validation workflow in `docs/VALIDATION-MODE.md`. The original HTML mock + design briefs are archived under `docs/_design/` for traceability; the operator-facing docs in `docs/` are the source of truth.

## Quick start (local dev)

```bash
# 1. Install
pnpm install

# 2. Postgres (docker-compose ships a 15-alpine container; any reachable 15+ Postgres also works)
docker compose up -d postgres

# 3. Configure
cp .env.example .env
#   (default DATABASE_URL points at the docker-compose container; edit if not)
#   (SAMPLE_MODE=true keeps you offline of every paid provider)

# 4. Migrate
pnpm db:migrate

# 5. Seed (creates the single org + scoring v1)
pnpm db:seed

# 6. Run dev (server :8080, web :5173)
pnpm dev
```

Visit http://localhost:5173. Sign in with the `AUTH_TOKEN` value from `.env`.

## What this is

- **Find** local service businesses (septic, HVAC, roofing, water/mold, plumbing, electrical, towing, real-estate teams) via OSM Overpass + Yelp at-call-time + state license registries + NOAA storm zones.
- **Score** them deterministically with versioned weights. Hard-filter franchise/residential/non-US/no-phone at intake.
- **Dedupe** across email, phone, domain, address, and fuzzy name+city.
- **Verify** emails through a free chain (syntax → MX → disposable → role) with a Bouncer PAYG fallback only on ambiguous priority leads.
- **Send** plaintext, RFC 8058 one-click-unsubscribe, CAN-SPAM-compliant outreach through AWS SES — never Postmark or Resend outbound (TOS).
- **Watch** SES SNS for bounces/complaints, Postmark Inbound for parsed replies. Auto-suppress on hard bounce / complaint / hostile reply / unsubscribe.
- **Validate** with the 30-day plan (eyeball → reach → engagement → refine) as a first-class workflow.
- **Forecast** monthly spend per provider. Hard ceilings on Hunter (top tier only) and Bouncer (PAYG budget).

## What this isn't

- Apollo / Clay / LinkedIn / ZoomInfo enrichment — **never** at any tier (`packages/providers/test/forbidden-providers.test.ts` enforces).
- Per-lead runtime AI — **forbidden**. Deferred to v1 once reply volume crosses ~200/mo.
- Open tracking — Apple MPP makes it noise. Permanently off.
- HTML emails — plain text only at MVP.
- localStorage-stored secrets — every API key lives in `.env`.
- Postmark / Resend outbound — TOS violations. Inbound Postmark is fine.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 20 |
| Monorepo | pnpm workspaces |
| Frontend | Vite + React 18 + TypeScript |
| Backend | Fastify + TypeScript |
| ORM | Drizzle (`drizzle-orm/node-postgres` locally; `drizzle-orm/neon-http` in prod) |
| DB | Postgres 15+ (Neon free tier in prod) |
| Queue | DB-backed `job_runs` (no Redis required at MVP) |
| Outbound mail | AWS SES |
| Inbound mail | Postmark Inbound |
| Discovery | OSM Overpass primary, Yelp Fusion (no-store) gap-fill |
| Verification | DNS / MX / disposable list / role flag → Bouncer PAYG |
| Tests | Vitest |

## Layout

```
.
├── apps/
│   ├── web/                React Vite SPA (ports HTML design)
│   └── server/             Fastify API + DB-backed job loop
├── packages/
│   ├── db/                 Drizzle schema + client + migration runner
│   ├── core/               Scoring, dedupe, templates, validation math, budget guards, reply classifier
│   ├── providers/          OSM, Yelp, NOAA, Census, licenses, Hunter, Bouncer, SES, Postmark Inbound, scraper, phone, verify
│   └── email/              Plain-text renderer, RFC 8058 headers, unsub tokens, body linter
├── docs/
│   ├── AUDIT.md
│   ├── UPDATED-ARCHITECTURE.md
│   ├── SETUP.md
│   ├── DEPLOYMENT.md
│   ├── COMPLIANCE.md
│   ├── PROVIDERS.md
│   ├── VALIDATION-MODE.md
│   ├── COST-MODEL.md
│   ├── SCORING.md
│   └── RUNBOOK.md
├── .env.example
└── package.json
```

## Scripts

```bash
pnpm dev               # concurrently runs apps/server + apps/web
pnpm test              # vitest across all packages
pnpm typecheck         # tsc --noEmit across all packages
pnpm build             # builds every package + the web bundle
pnpm db:generate       # drizzle-kit generate (rare; we hand-author 0000_init.sql)
pnpm db:migrate        # apply migrations
pnpm db:seed           # idempotent — creates the single org + scoring v1
```

## Mock provider mode

`SAMPLE_MODE=true` (default for dev) wires every external provider to an in-memory mock:
- OSM Overpass → `OsmSampleAdapter` returns 25 deterministic candidates.
- DNS check → returns "all pass" so the Deliverability page demonstrates the green-state.
- AWS SES outbound → `MockOutbound` (no real network).
- Bouncer / Hunter / Yelp / NOAA / Census → no network.

You can develop and demo the full pipeline without an internet connection.

## Configuring AWS SES (production)

See `docs/PROVIDERS.md` for the full setup. Summary:

1. Verify your outreach subdomain in SES.
2. Open production-access ticket. Wait ~24h. Toggle `SES_PRODUCTION_ACCESS_CONFIRMED=true`.
3. Create a configuration set named `keres-outreach` with event destinations for Bounce/Complaint/Delivery/Send.
4. Create an SNS topic with HTTPS subscription pointing at `https://<your-host>/api/webhooks/ses`. The first POST will be a `SubscriptionConfirmation` — we auto-confirm via the returned `SubscribeURL`.
5. Set `ENABLE_SES=true`, `SES_REGION`, credentials, and the configuration-set name in `.env`.

## Running the validation plan

```
1. Visit Validation tab → New experiment → choose Septic + Houston/Tampa/Atlanta.
2. Day 0: rate the 50 top-scored leads A / B / C / D. Live verdict.
3. Reach test (Day 1–7): build a stratified 100-send campaign (Top 40 / Mid 30 / Bottom 20 / Control 10) with seedlist insertion.
4. Engagement test (Day 8–21): same shape, 500 sends.
5. Refine (Day 22–30): signal-outcome matrix → derive new scoring weights, capped at ±30% per signal.
```

`docs/VALIDATION-MODE.md` has the full operator playbook.

## What not to do

- Don't put SMTP passwords or API keys in the UI. They live in `.env`.
- Don't enable `ENABLE_PLACES`, Twilio Lookup, or any Apollo/Clay/LinkedIn integration at MVP. They are deliberately not present.
- Don't use Postmark or Resend for outbound. Inbound Postmark is fine.
- Don't add open tracking. Don't switch to HTML emails. Don't add multi-step sequences before the validation plan passes.

## Production readiness checklist

Before any real send, ensure the following are green at `GET /api/diagnostics`:

```
[ ] sample_mode_off              SAMPLE_MODE=false
[ ] sender_identity_complete     From / Reply-To / Org name set in Settings
[ ] physical_address_set         CAN-SPAM mailing address set
[ ] ses_production_access        SES production-access ticket approved + toggled
[ ] outbound_configured          ENABLE_SES=true + region/keys/config-set in .env
[ ] seedlist_configured          SEEDLIST_EMAILS set to controlled mailboxes
[ ] sender_domain_exists         Outreach subdomain added in Deliverability
[ ] spf_pass                     SPF TXT includes amazonses.com
[ ] dkim_pass                    All 3 SES DKIM CNAMEs (s1/s2/s3) resolve
[ ] dmarc_pass                   DMARC TXT exists with p=none (later: quarantine)
[ ] unsub_reachable              GET /api/unsubscribe/health returns 200
[ ] warmup_ok                    Warmup state = warming or warmed
[ ] seedlist_test_recent         Successful seedlist test in the last 7 days
[ ] bounce_rate_safe             24h bounce rate < 4%
[ ] complaint_rate_safe          24h complaint rate < 0.1%
[ ] budget_*                     Per-provider monthly budgets not exhausted
[ ] copy_lint                    Campaign template passes the body linter
```

Click `Diagnostics` in the nav to see the live state with copy-button fixes.

## License sources

The active-license signal in scoring depends on `state_licensees` rows. See `docs/LICENSE-SOURCES.md` for per-state CSV import instructions (TX, FL, GA covered; other states fall through with `license_status = unknown` until you import).

## API surface (added in v3.2)

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness. |
| `GET /api/ready` | Readiness — fails if launch gate fails. |
| `GET /api/diagnostics` | Full system check + launch-gate report. |
| `GET /api/launch-gate` | System-wide launch gate (no campaign). |
| `GET /api/campaigns/:id/launch-gate` | Per-campaign launch gate. |
| `POST /api/campaigns/:id/launch` | Requires gate pass (or `override.reason` + audit log entry). |
| `POST /api/licenses/import` | CSV importer for `state_licensees`. |
| `GET /api/licenses` | Lookup imported license rows. |
| `GET /api/validation/experiments` | Server-side experiment list with filters/sort. |
| `GET /api/export/leads.csv` | Filtered lead CSV (injection-protected). |
| `POST /api/export/leads-selected.csv` | Selected leads CSV. |
| `GET /api/export/suppressions.csv` | Suppressions. |
| `GET /api/export/cost-events.csv` | Cost ledger. |
| `GET /api/export/campaign-recipients/:id.csv` | Per-campaign recipient state. |
| `GET /api/export/validation-reviews/:id.csv` | Day-0 review CSV. |
| `GET /api/export/signal-outcome/:id.csv` | Validation-plan-ready signal × outcome matrix. |
| `POST /api/suppressions/bulk` | Bulk suppress by email or domain. |
| `POST /api/leads/:id/merge` | Soft-merge a duplicate into another lead. |
| `GET /api/provider-usage` | Today + month per-provider counts and spend. |
| `GET /api/audit` | Audit log query. |

## Help / feedback

- `/help` in Claude Code if you spin up an AI loop on the repo.
- File issues at the repo URL.
