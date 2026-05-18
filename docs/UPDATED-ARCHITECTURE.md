# Keres AI — Updated Architecture (v3.2)

> Merges v3 (signal pipeline + funnel) with v3.1 (sub-$5 infrastructure) and the corrections from `docs/AUDIT.md`. This is the spec the code implements.

---

## 1. The headline

Keres AI ships an **internal lead generation + cold-email validation console** for selling AI receptionists to phone-driven local service businesses (septic, HVAC, roofing, water/mold, towing, plumbing, electrical, real-estate teams).

It is sub-$5/mo at 1k qualified leads/mo and follows the 30-day validation methodology *as a product workflow*, not as an external doc.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 | LTS; `@neondatabase/serverless` requires Node 18+. |
| Monorepo | pnpm workspaces | Spec; fast; deterministic. |
| Frontend | Vite + React 18 + TypeScript | Single-page internal tool; preserves HTML design system. |
| Backend | Fastify 4 + TypeScript | Spec; schema validation; small dependency surface. |
| DB | Postgres 15+ (Neon in prod) | `citext`, generated columns, partial indexes, brin indexes. |
| ORM | Drizzle | Spec; native pg types. |
| Queue | DB-backed (`job_runs` table) with poll loop | Avoids Upstash dep at MVP. |
| Auth | Single-tenant bearer token from `.env`, cookie-backed | "Single-tenant is enough for MVP." |
| Tests | Vitest | ESM-native; fast. |
| Email outbound | AWS SES adapter (interface `OutboundProvider`) | Spec. |
| Email inbound | Postmark Inbound adapter (interface `InboundProvider`) | TOS-safe for inbound-only. |
| Discovery primary | OSM Overpass | Spec. |
| Discovery gap-fill | Yelp Fusion (no-store) | TOS-compliant. |
| Verification chain | DNS MX + SMTP RCPT + disposable list + role list → Bouncer fallback | Spec. |
| Email pattern fallback | Hunter.io free tier only when score ≥ 90 + scrape failed | Spec. |
| Storm signal | NOAA Storm Events monthly batch loader | Spec. |
| Density signal | Census Business Patterns annual loader | Spec. |
| License signal | State license adapters (TX, FL, GA, others stubbed) | Spec. |
| Phone classify | libphonenumber (free) | Spec. |
| Hosting | Fly.io auto-stop + Cloudflare Cron heartbeat | v3.1. |
| Secrets | `.env` (Fly secrets in prod) | Never browser. |

## 3. Repository layout

```
.
├── apps/
│   ├── web/                     # Vite React frontend (ports HTML design)
│   └── server/                  # Fastify API server
├── packages/
│   ├── db/                      # Drizzle schema + migrations + client
│   ├── core/                    # Scoring, dedupe, templates, validation math, cost guard
│   ├── providers/               # OSM, Yelp, NOAA, Census, state licenses, Hunter, Bouncer, SES, Postmark Inbound, libphonenumber, scraper
│   └── email/                   # Plain-text renderer, RFC 8058 headers, unsubscribe signing, linter
├── docs/
│   ├── AUDIT.md
│   ├── UPDATED-ARCHITECTURE.md   # ← this file
│   ├── README.md / SETUP.md / DEPLOYMENT.md / COMPLIANCE.md / PROVIDERS.md / VALIDATION-MODE.md / COST-MODEL.md / SCORING.md / RUNBOOK.md
├── .env.example
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

## 4. Data model (Drizzle / Postgres)

**16 tables**, all `org_id`-scoped where relevant.

| Table | Purpose |
|---|---|
| `organizations` | Single-tenant: exactly one row at boot. Holds public sender identity. |
| `users` | Operator accounts. |
| `sender_domains` | Outreach subdomain + DNS state + warmup + production-access flag. |
| `leads` | Business records. |
| `lead_signals` | Per-lead evidence + scoring inputs. |
| `lead_source_events` | Every time a lead was touched by a source (provenance + evidence). |
| `suppressions` | Org + global. Reason + source event + created_at. |
| `campaigns` | Single-touch outreach + validation experiments. |
| `campaign_recipients` | Per-recipient render + state machine. |
| `email_events` | All send/delivered/bounce/complaint/reply/unsubscribe events, idempotent on (provider_message_id, event_type). |
| `inbound_messages` | Parsed incoming replies with regex auto-classification + manual override. |
| `validation_experiments` | One per validation campaign — methodology phase, kill criteria, results. |
| `validation_reviews` | Day-0 A/B/C/D eyeball decisions. |
| `scoring_versions` | Versioned weight sets with effective dates + measured lift. |
| `provider_usage` / `cost_events` | Per-call cost tracking per provider, per day. |
| `discovery_jobs` | Recurring discovery configurations. |
| `job_runs` | Generic DB-backed job queue rows. |

### DDL bug fixes from v3 (Appendix C)

| v3 bug | Fix in v3.2 |
|---|---|
| `dedup_phone` referenced but malformed regex escape `'\D'` in raw SQL | Use Drizzle `generatedAlwaysAs(sql\`regexp_replace(coalesce(phone,''), '\\D', '', 'g')\`)` |
| `UNIQUE (COALESCE(org_id::text,'GLOBAL'), email)` rejected in some PG versions | Generated `scope_key text` column + unique index on `(scope_key, email)` |
| `citext` referenced w/o extension | `CREATE EXTENSION IF NOT EXISTS citext` in 0000_init.sql |
| Missing `org_id` FKs on `lead_signals`, `campaign_recipients`, `email_events` | All added with `ON DELETE CASCADE` |
| No status/state/event_type CHECK constraints | Added |
| `email_events_idem` only a regular index → replay duplicates | Promoted to `UNIQUE (provider_message_id, event_type)` partial where `provider_message_id IS NOT NULL` |
| Missing tables for validation/cost/discovery jobs | Added (see table above) |

## 5. Scoring engine

Deterministic, versioned, audit-trailed.

```ts
score(inputs: ScoringInputs, version: ScoringVersion): { score, contributions, evidence }
```

Weights pulled from `scoring_versions.weights` (JSONB). The default `v1` weights match the v3 Appendix B formula, **plus**:
- Hard filters move *before* the weighted sum: closed/defunct, franchise, residential, UPS box, non-US, wrong niche, no phone, known competitor, duplicate, suppressed → return score 0 + `disqualification` flag.
- New positive signals: emergency/after-hours niche match, owner-operator heuristic (single license + matching mobile phone area), service-dispatch model.
- New negative signals: modern website + online booking, dead domain, multi-location chain, expired license.

Every score returns a `contributions[]` array so the UI can render the **"why score" drawer**:

```ts
contributions = [
  { signal: 'web_presence_level', value: 'none', points: 35, evidence: { url: '...', method: 'HEAD', status: 'no_record' }, confidence: 0.95 },
  ...
]
```

Validation feeds back into scoring via `validation_experiments.measured_lift` → admin can roll a new `scoring_versions` row with weight changes capped at ±30% per signal.

## 6. Dedupe

Tiers, fast-to-slow:
1. Exact email (lowercased CITEXT).
2. Normalized phone (digits-only).
3. Normalized website domain (strip protocol/www).
4. Normalized address (lowercase alnum-only, length ≥ 8).
5. Normalized name + city + state.
6. Fuzzy name + address via trigram similarity (`pg_trgm`) where available.
7. Source external IDs (per-source uniqueness).
8. Manual `merge_into_lead_id` pointer with audit row.

## 7. Templates

Six niche templates ported from the HTML (Roofer, Septic, Water/Mold, HVAC, Plumbing, Electrical, Towing, Real Estate teams, plus general-audit) — each with:
- `subject_variants[]` (3–5)
- `opener_variants{no_website, social_only, gbp_only, storm_zone, by_appointment, default}`
- `pain_variants[]`
- `body_template` with `{{opener}} {{business}} {{city}} {{pain}} {{from_name}}`

`renderEmail(lead, signals, template)`:
- Picks variant key by strongest signal (`no_website` > `storm_zone` > `social_only` > `gbp_only` > `by_appointment` > `default`).
- Hash-stable selection per `lead.id` so re-renders are idempotent.
- Returns `{ subject, body, slot_key, variant_seed }`.

Linter flags (also runs in CI for any template change):
- Generic opener used > 30% of recipients in a campaign.
- Token mismatch (e.g., `{{business}}` empty).
- Claim phrases not on whitelist.
- Excess link count (> 2).
- Word count > 180.
- Spam-trigger words (configurable list).
- Missing CAN-SPAM footer.
- Missing relevance: no niche keyword in subject or body.

## 8. Sending pipeline

```
[campaign launched]
   ↓
[gate checks: SPF/DKIM/DMARC/MX green, domain warmed, sender identity complete,
               physical_address set, unsubscribe endpoint reachable,
               daily cap not exceeded, complaint/bounce ratio safe,
               production_access_confirmed=true]
   ↓
[for each lead]
   ↓
[skip filters: suppressed, bounced, unsubscribed, already in campaign,
               verification status invalid, email_verified > 30d ago]
   ↓
[render(lead, signals, template)]
   ↓
[linter check on rendered email]
   ↓
[provider.send] → returns provider_message_id
   ↓
[insert email_events(send), update campaign_recipients]
   ↓
[poll: SES SNS webhook posts bounce/complaint/delivery]
   ↓
[idempotent insert email_events, auto-suppress on bounce/complaint]
```

Throttle: `send_speed_per_min` per campaign + per-domain cap. Warmup: a `sender_domain.warmup_state` machine bumps the daily cap weekly until target.

Rules baked in:
- `From:` aligned with the DKIM-signing domain.
- `List-Unsubscribe: <https://...token>, <mailto:unsub@...>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Body always contains body unsubscribe link + reply-to instruction.
- CAN-SPAM footer: company name, physical address, "you received this because…", unsubscribe link.

## 9. Inbound, bounces, complaints, suppression

- **AWS SES SNS** webhook (`POST /webhooks/ses`) handles `Bounce`, `Complaint`, `Delivery`, `Send`, `Reject`, `Open` (ignored), `Click` (ignored). HMAC verification + idempotent insert + auto-suppress on hard bounce + complaint.
- **Postmark Inbound** webhook (`POST /webhooks/inbound`) parses replies. Regex auto-classification into the validation taxonomy. Auto-suppression on `unsubscribe`, `bounce`, `not_interested_hostile` keywords. Manual triage UI for the rest.
- **Suppression** table records source event + reason + scope (`org` | `global` | `domain`).

## 10. Validation Mode

A first-class nav page. Three flows:

1. **Eyeball review (Day 0)** — Pull discovery results, present top 50 with A/B/C/D buttons and reason tags for C/D. Live computed % A+B. Verdict banner (pass / tune / stop).

2. **Reach test (Days 1–7)** — Wizard creates a stratified campaign:
   - 40 Top (80–100)
   - 30 Mid (60–79)
   - 20 Bottom (40–59)
   - 10 Control (20–39)
   - 1+ seedlist mailbox inserted.
   Live dashboard: inbox placement, bounce, complaint, reply rate.

3. **Engagement test (Days 8–21)** — Same shape, 500 sends. Computes top-mid gap + qualified-reply %. Auto-pause if kill criteria triggered.

4. **Refine (Days 22–30)** — Builds the signal-outcome matrix from `email_events` + `inbound_messages`. Computes `P(reply|signal=true) / P(reply|signal=false)` per signal. Suggests scoring-weight deltas capped at ±30%. Operator can apply → creates a new `scoring_versions` row.

**Verdict screen** — VALIDATED / scoring-not-predictive / ICP-broken with the data to back it.

## 11. Cost controls

Every paid call books a row in `cost_events(provider, sku, cost_cents, lead_id, campaign_id, occurred_at)`.

Cost guards (in `packages/core/budget.ts`):
- `BUDGET_MODE = 'free' | 'low' | 'normal'` (env-configurable)
- `canUse(provider, sku, lead)` returns boolean
- Hard defaults:
  - Runtime AI: **never**.
  - Hunter: only when `score >= 90 AND scrape_failed AND month_hunter_credits_used < 50`.
  - Bouncer: only when `score >= 80 AND free_chain_unverifiable AND month_bouncer_cost < $5`.
  - Google Places: **disabled** unless `ENABLE_PLACES=true`.
  - Twilio Lookup: **disabled** at intake.

Cost dashboard reads `cost_events` and shows MTD spend per provider + forecast.

## 12. Compliance gates

A send is blocked if any of these are false:

```ts
canSend(domain, campaign): {ok, blockers[]}
- domain.spf_status === 'pass'
- domain.dkim_status === 'pass'
- domain.dmarc_status === 'pass' && policy in {'none','quarantine','reject'}
- domain.mx_status === 'pass'
- domain.production_access_confirmed === true
- domain.warmup_state in {'warmed','warming-ramp-ok'}
- settings.physical_address.length > 0
- settings.from_name && settings.from_email && settings.reply_to
- settings.unsubscribe_base_url is reachable (probed nightly)
- daily cap not exceeded
- last-24h bounce rate < 4%
- last-24h complaint rate < 0.1%
- campaign body passes linter w/ severity < 'error'
- not in seedlist-fail state (validation mode only)
```

## 13. Frontend

Same nav as HTML *plus* three new nav items:
- **Validation** (replaces nothing — added as a top-level tab)
- **Inbox** (replies)
- **Costs** (monthly burn dashboard)

Plus drawer/modal additions:
- "Why score" drawer (per-lead contributions + evidence)
- Sender setup wizard (settings → sender_domains create + DNS check + test-send)
- Discovery jobs CRUD
- Provider usage screen
- Lead review / eyeball workflow

Demo mode (`SAMPLE_MODE=true`) keeps the seed pool but the demo-warning callouts are gone in real mode.

## 14. Provider matrix (env-flag-controlled)

| Env flag | Default | Effect |
|---|---|---|
| `SAMPLE_MODE` | `true` in dev | Uses in-memory mock providers; never calls real endpoints. |
| `ENABLE_OSM` | `true` | OSM Overpass adapter active. |
| `ENABLE_YELP` | `false` | Yelp Fusion adapter (no-store) active. |
| `ENABLE_HUNTER` | `false` | Hunter free-tier fallback active. |
| `ENABLE_BOUNCER` | `false` | Bouncer PAYG active. |
| `ENABLE_SES` | `false` | AWS SES outbound active. |
| `ENABLE_POSTMARK_INBOUND` | `false` | Postmark Inbound webhook active. |
| `ENABLE_PLACES` | `false` | Google Places adapter (disabled unless explicitly turned on). |
| `BUDGET_MODE` | `free` | One of `free`, `low`, `normal`. |

## 15. API surface

(All routes prefixed `/api`.)

```
GET    /health
POST   /auth/login                          # exchange token from env for cookie
GET    /settings
PUT    /settings
POST   /sender-domains
GET    /sender-domains
POST   /sender-domains/:id/check-dns
POST   /sender-domains/:id/test-send
POST   /discovery/jobs
GET    /discovery/jobs
POST   /discovery/jobs/:id/run
GET    /leads
GET    /leads/:id
PATCH  /leads/:id
POST   /leads/import-csv
POST   /leads/:id/verify-email
POST   /leads/:id/suppress
POST   /campaigns
GET    /campaigns
GET    /campaigns/:id
POST   /campaigns/:id/render-preview
POST   /campaigns/:id/launch
POST   /campaigns/:id/pause
POST   /campaigns/:id/resume
POST   /webhooks/ses                        # SNS notifications
POST   /webhooks/inbound                    # Postmark Inbound parser
POST   /unsubscribe                         # one-click POST (RFC 8058)
GET    /unsubscribe/:token                  # landing GET
POST   /validation/experiments
GET    /validation/experiments/:id
POST   /validation/reviews
POST   /validation/experiments/:id/create-stratified-campaign
GET    /metrics/dashboard
GET    /metrics/costs
```

## 16. Tests

| Category | Files |
|---|---|
| Scoring | `packages/core/test/scoring.test.ts` (unit + versioning) |
| Dedupe | `packages/core/test/dedupe.test.ts` (exact + fuzzy + filters) |
| Templates | `packages/core/test/templates.test.ts` (render + no fake personalization) |
| Validation math | `packages/core/test/validation.test.ts` (buckets + lift) |
| Budget | `packages/core/test/budget.test.ts` (cost guards) |
| Email headers | `packages/email/test/headers.test.ts` (RFC 8058 + CAN-SPAM) |
| Unsubscribe tokens | `packages/email/test/unsubscribe.test.ts` |
| Provider adapters | `packages/providers/test/*.test.ts` (each adapter w/ mocked HTTP) |
| Lint absence | `packages/providers/test/forbidden-providers.test.ts` (Postmark outbound, Resend outbound, Apollo, Clay, LinkedIn don't exist) |
| Yelp lint | `packages/providers/test/yelp-no-store.test.ts` (schema lacks Yelp-named columns) |
| Webhook idempotency | `apps/server/test/webhooks.test.ts` |
| SES event parsing | `apps/server/test/ses-events.test.ts` |
| Suppression | `apps/server/test/suppression.test.ts` |
| Compliance gates | `apps/server/test/gates.test.ts` |
| E2E smoke | `apps/server/test/smoke.test.ts` (setup → discover → review → campaign → render → block-if-missing → launch w/ mock → unsubscribe → bounce → reply) |

## 17. Cost summary (locked at MVP)

| Item | Cost/mo |
|---|---|
| Fly auto-stop @ 512MB | $1.50 |
| Neon free | $0.00 |
| Cloudflare DNS + Cron + R2 | $0.00 |
| Domain (annual ÷ 12) | $1.00 |
| AWS SES (post-free-tier, 5k sends) | $0.50 |
| Postmark Inbound (free 10k/mo) | $0.00 |
| Bouncer PAYG ($8 ÷ 20 mo) | $0.40 |
| Hunter free | $0.00 |
| OSM / NOAA / Census / state licenses | $0.00 |
| Runtime AI | $0.00 |
| **Total** | **~$3.40** |

---

*Build proceeds.*
