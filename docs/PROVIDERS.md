# Providers

A single source of truth on which provider does what, how to enable it, and the TOS gotchas to remember.

## Discovery

### OpenStreetMap Overpass (primary)
- **Free.** Public endpoint at `https://overpass-api.de/api/interpreter`.
- Etiquette: ≤ 10k queries/day per IP, ≤ 1 req/sec courtesy, identifying `User-Agent` required.
- License: ODbL. Show "© OpenStreetMap contributors" wherever the data is displayed (the frontend footer already does this).
- Env: `ENABLE_OSM=true`, `OSM_OVERPASS_URL`, `OSM_USER_AGENT`, `OSM_CONTACT_EMAIL`.
- Implementation: `packages/providers/src/osm.ts`. Sample mode produces 25 deterministic candidates per query so dev/test never touches the public endpoint.

### Yelp Fusion (gap-fill, no-store)
- **Free 500/day** for new clients (since 2023).
- **TOS:** business response data cannot be cached beyond 24 hours. Only `business_id` may be persisted.
- Our adapter (`YelpAdapter.enrichForScoring`) returns `{ businessId, reviewCount, rating, isClaimed }` — used by the scoring function and discarded. **No DB column stores Yelp display fields.** A schema lint test (`packages/providers/test/yelp-no-store.test.ts`) enforces this.
- Env: `ENABLE_YELP=true`, `YELP_API_KEY`. Default disabled.

### State license registries
- Free. Adapters in `packages/providers/src/licenses/index.ts`.
- TX, FL, GA scaffolded; other states fall through to `unknown`.
- Sample mode returns deterministic `active`/`expired` based on name hash so the active-license signal lights up in dev.
- Production: implement state-specific HTML scrapers as needed.

### NOAA Storm Events
- Free CSV downloads at https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/.
- Monthly cron: download → `parseCsv` → upsert into `noaa_storm_zones`.
- Env: `NOAA_STORM_REFRESH_CRON='0 4 1 * *'` (UTC).

### Census Business Patterns
- Free annual CSV (or API with a free key).
- Used for competitor-density signal.
- Sample mode returns synthetic densities indexed by metro zip.

### Google Places
- **Disabled at MVP** (`ENABLE_PLACES=false`). v3.1 removes it because the $200 universal credit was eliminated; OSM + Yelp is enough.
- Adapter shell intentionally absent — add only if you've justified the cost.

## Email discovery / verification

### Website scraper (free)
- `packages/providers/src/scraper.ts`. Cheerio-based, no JS execution.
- HEAD → GET. Pulls emails from `mailto:` + plain-text scan. Detects online-booking widgets.

### Free verification chain
- `packages/providers/src/verify.ts::FreeVerifier`.
- Syntax → disposable-domain list → role-account flag → DNS MX → SMTP RCPT (only on non-major providers).
- Gmail / Yahoo / Outlook / iCloud return `unverifiable_provider` — verification falls through to Bouncer if score ≥ 80.

### Bouncer (PAYG)
- $8 / 1000 credits, **never expire**, free for duplicates and unknowns. (Source: usebouncer.com/pricing)
- Enabled only when `freeChainResult ∈ {unverifiable_provider, unknown, catch_all}` AND `score ≥ 80` AND monthly budget remaining.
- Env: `ENABLE_BOUNCER=true`, `BOUNCER_API_KEY`, `BOUNCER_MONTHLY_BUDGET_USD=5`.

### Hunter.io (fallback)
- 2026 free tier: **50 unified credits/month** (consolidated from the older 25 searches + 50 verifications split).
- Enabled only when scrape failed AND `score ≥ 95` AND monthly credits remaining.
- Env: `ENABLE_HUNTER=true`, `HUNTER_API_KEY`, `HUNTER_MONTHLY_FREE_CREDITS=50`.

### Phone (free)
- `packages/providers/src/phone.ts` — libphonenumber heuristic. No Twilio at intake.
- Twilio Lookup deferred to point-of-sale post-reply.

## Outbound

### AWS SES (only allowed outbound)
- $0.10/1000 sends + $0.12/GB attachment. Free 3k/mo for the first 12 months after enabling.
- Sandbox limits: 200/24h, 1 msg/sec, only to verified addresses. Open production access via the SES console; AWS replies in ~24h.
- Reputation thresholds (we auto-pause earlier than AWS suspends):
  - Bounce: AWS review at 5%, suspend at 10%. We auto-pause at **4%**.
  - Complaint: AWS review at 0.1%, suspend at 0.5%. We auto-pause at **0.1%**.
- Account-level suppression list: bounces and complaints are auto-added. Adjust via console.
- Env: `ENABLE_SES=true`, region, keys, `SES_CONFIGURATION_SET=keres-outreach`, `SES_PRODUCTION_ACCESS_CONFIRMED=true`.

### NOT Postmark
- Postmark's TOS prohibits cold outbound. We send **inbound only** with Postmark. There is no Postmark outbound adapter in this repo, and a CI test asserts that.

### NOT Resend
- Resend's AUP makes cold outbound infeasible in practice. Same — no Resend outbound adapter, CI-enforced.

## Inbound (replies)

### Postmark Inbound
- Free up to 10k inbound emails/month.
- Webhook handler at `/api/webhooks/inbound`. Basic-auth + token-based auth both supported.
- DNS: set the inbound subdomain's MX record to `inbound.postmarkapp.com`.
- Env: `ENABLE_POSTMARK_INBOUND=true`, plus auth fields.

## Cost summary

At default budgets, expected monthly spend at 1k qualified leads:

| Provider | Cost |
|---|---|
| AWS SES (5k sends, post-free-tier) | $0.50 |
| Bouncer PAYG ($8 / 20 mo) | $0.40 |
| Hunter free | $0.00 |
| Yelp free | $0.00 |
| OSM, NOAA, Census, state licenses | $0.00 |
| Postmark Inbound (under free tier) | $0.00 |

Plus infrastructure: Fly $1.50 + domain $1.00 = $3.40 total.
