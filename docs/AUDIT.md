# Keres AI — Pre-Build Audit (docs/AUDIT.md)

> Audit produced before scaffolding code. Every claim here is the result of reading the four input files plus checking current (May 2026) official provider docs. Where docs contradict the input files, the docs win and the input files are corrected.

---

## 1. What the HTML prototype already does

`keres_ai_email_automation.html` is a single-page demo. It runs entirely in the browser.

**Working visually:**
- Top nav with 6 pages: Dashboard, Find Leads, Leads, Campaigns, Deliverability, Settings.
- Dashboard hero, stats grid, next-best-actions, daily quota, ROI calculator, recent campaigns.
- Find Leads: discovery form (niche/state/city/keyword/source/count), CSV import, demo results.
- Leads: sidebar filters (status, niche, freshness, source, state), bulk bar, sortable table, drawer for details.
- Campaign builder: 5-step wizard (Audience → Email → Personalize → Deliverability → Review), 6 niche templates, A/B subject toggle, spam linter, anti-repeat protection callout.
- Deliverability: DNS check pretend-flow (SPF/DKIM/DMARC/MX), warmup, seedlist manager.
- Settings: sender identity, provider, compliance, data management.
- Toasts, modals, drawers, progress bars.

**Dark Keres design system:** Instrument Serif headings, Inter body, JetBrains Mono code, accent green `#34d399`, dense table styling, well-considered focus states. Worth preserving 1:1.

## 2. What is fake / demo / local-only

| Component | Reality |
|---|---|
| All persistence | `localStorage` key `keres_state_v2`. No backend. Loses data on clear. |
| Discovery | `Discovery.run()` synthesizes candidates from a hardcoded `POOL` and `SUFFIX` map — not real businesses. Live connectors (Google, Yelp, Apollo, LinkedIn, Clay, Instantly) are listed but `disabled`. |
| Email send | Never actually sends. Pretends to "launch". |
| DNS check | Hand-waved animations. No real DNS lookup. |
| Suppression | List exists in localStorage; never tied to a real provider. |
| API keys | Settings form has fields for SMTP password, Anthropic key, etc. with the warning "stored in browser localStorage". **This is a critical security defect for any non-toy deploy.** |
| Sequences | Single-touch only. No multi-step. |
| Bounces / complaints / replies | No webhook handlers exist. |
| Unsubscribe | No real endpoint; UI mentions one-click but renders no signed-token URL. |
| Reply inbox | None. Replies don't exist. |
| Validation mode | None. The validation methodology lives only in `VALIDATION-PLAN.md`. |
| Cost dashboard | None. |
| Auth | None. Open to anyone. |

So the HTML is a *visual* spec. Production state, real provider integration, and security are 100% to-build.

## 3. What v3 (ARCHITECTURE-V3-ECONOMICS.md) prescribes

- **Funnel-shaped pipeline.** Pull cheap candidates from free sources, extract free signals, score, only enrich the top decile.
- **Sources:** OSM Overpass primary, Yelp Fusion gap-fill (cached), state license registries, NOAA storm CSV, Census Business Patterns, optional Google Places for top 10%.
- **Free signal extraction:** web presence level, phone, line type (libphonenumber), storm zone, license status, review velocity, online booking detection.
- **Verification chain:** DNS MX → SMTP RCPT → catch-all probe → Emailable paid for ambiguous priority leads.
- **Personalization:** templates with signal-aware slots; no per-lead AI.
- **Reply classification:** Claude Haiku — only on actual replies, not at intake.
- **Sending:** AWS SES, one outreach subdomain, no dedicated IP, plaintext, no open tracking.
- **Inbound:** Postmark Inbound (10k/mo free) for parsed replies via webhook.
- **Infra:** Fly always-on machine, Fly Postgres dev, Upstash Redis free, Sentry/Honeycomb/Better Stack free tiers.
- **10-table schema:** organizations, users, memberships, sender_domains, leads, lead_signals, suppressions, campaigns, campaign_recipients, email_events.
- **Forbidden:** Apollo, Clay, LinkedIn, ZoomInfo, RocketReach, paid intent data; HTML email, open tracking, dedicated IP at MVP, multi-step sequences at MVP.

## 4. What v3.1 (ARCHITECTURE-V3.1-SUB-5.md) changes

The big-picture math: v3 was $13.87/mo; v3.1 cuts to $3.40/mo at 1k qualified leads, *without* losing lead quality. Quality cuts were only deferred — not removed.

**The five swaps:**
1. Fly always-on → **Fly auto-stop** with `min_machines_running = 0`. Cloudflare Cron pings `/health` at 7am M–F to keep warm.
2. Fly Postgres dev → **Neon Postgres free tier** (`@neondatabase/serverless` + Drizzle), scale-to-zero.
3. Google Places gap-fill → **Yelp Fusion at-call-time only, no DB persistence** of Yelp-sourced fields beyond 24h (Yelp TOS).
4. Emailable monthly → **Bouncer PAYG $8 for 1000 credits, never expire**.
5. Anthropic at MVP → **defer to v1**. Manual reply triage at MVP (5 min/day on ~80 replies/mo).

**Per-lead cost:** $0.0034/qualified, $0.0011/emailed.

## 5. What VALIDATION-PLAN.md requires (as a product workflow, not a separate doc)

A 30-day, 4-phase methodology that has to be a first-class workflow inside the app — not an Excel template.

| Phase | Days | Volume | Cost | Gate |
|---|---|---|---|---|
| **Eyeball** | 0 | 50 top-scored leads reviewed manually | $0 | ≥ 70% A+B → pass; 50-69% → tune; < 50% → stop |
| **Reach** | 1–7 | 100 stratified sends (Top 40 / Mid 30 / Bottom 20 / Control 10) | ~$0.50 | inbox ≥ 80%, bounce < 5%, ≥ 1 reply |
| **Engagement** | 8–21 | 500 stratified sends (Top 200 / Mid 150 / Bottom 100 / Control 50) | ~$2 | top reply ≥ 5%, top-mid gap ≥ 3pp, qualified % ≥ 30% |
| **Refine** | 22–30 | 200–400 confirmatory sends | ~$1.50 | held-or-better top reply rate |

**Required artifacts in product:**
- Discovery → top 50 review screen with A/B/C/D rating + C/D reason tags.
- Stratified campaign builder (auto-bucket by score range, sample N from each).
- Seedlist insertion (always 1+ controlled mailbox per batch).
- Reply taxonomy: interested, conditional, objection, not_interested_polite, not_interested_hostile, wrong_person, OOX/auto_reply, referral, bounce/undeliverable.
- Signal-outcome matrix with P(reply|signal=true) and P(reply|signal=false).
- Scoring version comparison + max ±30% per-weight change rule.
- End-of-month verdict: VALIDATED / scoring-not-predictive / ICP-broken.

## 6. What is missing or contradictory across the four inputs

| Gap / contradiction | Resolution chosen |
|---|---|
| v3 has 10 tables; v3.1 doesn't enumerate; validation plan needs more tables (validation_reviews, validation_experiments, inbound_messages, scoring_versions, cost_events, discovery_jobs, job_runs). | Build the full table set v3.1 + validation needs. |
| v3 mentions Anthropic ($0.50/mo reply classification); v3.1 forbids it at MVP. | v3.1 wins. No runtime AI. |
| v3 lists Google Places as top-10% gap-fill; v3.1 removes it for cost. | Provider adapter exists but **disabled by default** behind env flag. |
| v3 says Postmark *Inbound* is fine (TOS allows it); user prompt says don't use Postmark *outbound*. | Both true. Postmark Inbound = allowed. Postmark outbound adapter = **must not exist** (test-enforced). |
| v3 says Emailable; v3.1 says Bouncer. | Bouncer. PAYG fits the budget; Emailable is interchangeable but pricier. |
| HTML stores API keys in localStorage; user prompt forbids that. | Settings UI never accepts secrets; only public sender identity fields. Secrets live in env. |
| HTML uses `confirm()`/local-only suppression. | Replace with backend-driven suppression with audit trail. |
| Yelp Fusion: HTML/v3 imply caching is OK. **Yelp TOS prohibits caching most fields > 24 hours** (corrected in v3.1). | No DB column persists Yelp-sourced fields beyond `business_id`. A lint test enforces this. |
| Hunter free tier in v3: "25 searches + 50 verifications/mo." **Current 2026 Hunter free tier is 50 unified credits/month, not split.** | Documented in `docs/PROVIDERS.md`. Budget logic uses the lower of "50 credits" total. |
| v3 mentions "single-tenant or small multi-tenant" without saying which. User prompt: single-tenant is enough for MVP. | Single-tenant. One `organizations` row seeded at boot. No billing scaffolding. |
| HTML has no validation mode or reply inbox; VALIDATION-PLAN.md requires both. | Build both as first-class. |

## 7. Compliance risks I have to design around

| Risk | How the build addresses it |
|---|---|
| **Gmail/Yahoo bulk-sender requirements (2024+):** SPF + DKIM + DMARC, spam < 0.3%, one-click RFC 8058 unsubscribe, From-aligned. | DNS check gate. Spam-rate stop rule. RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers with signed HTTPS URL + `mailto:` fallback. Block send unless From domain has DKIM-aligned signature. |
| **CAN-SPAM:** physical postal address, accurate headers, opt-out honored. | Hard-required `physical_address` setting; send blocked if empty. CAN-SPAM footer rendered in every body. Opt-out wired to suppression in 2 days (we exceed the 10 business day floor). |
| **AWS SES AUP:** cold outreach allowed only under low bounce/complaint thresholds. SES bounce review > 5%, suspend > 10%. Complaint review > 0.1%, suspend > 0.5%. | Live `email_events`-driven bounce/complaint rate monitor with auto-pause at 4% bounce / 0.1% complaint (well under the SES suspend floor). |
| **Yelp Fusion 24h cache TOS.** | Lint test: no DB column may store a Yelp-sourced display field. Only `business_id` permitted long-term. Adapter clears scoring-only fields after the scoring pass. |
| **Postmark TOS:** outbound prohibited for cold. | No outbound Postmark adapter exists. CI test asserts the file does not exist. |
| **Resend TOS:** outbound prohibited for cold in practice. | Same: no outbound adapter; CI test asserts absence. |
| **OSM ODbL attribution:** "© OpenStreetMap contributors" with link to copyright page. | Frontend footer + Discovery results show the attribution. User-Agent string includes app name + contact email. |
| **Browser-stored secrets.** | Settings form never accepts secrets. Real secrets live in `.env` server-side. |
| **Sandbox SES (200/day).** | First-send wizard explicitly explains the production-access ticket. Send blocked if "Has production access" not confirmed in settings. |

## 8. Schema bugs in v3 DDL (and how I fix them)

Reading Appendix C of `ARCHITECTURE-V3-ECONOMICS.md` carefully:

| Bug | Fix |
|---|---|
| `dedup_phone` column referenced in unique index but only `dedup_email` is mentioned in spec — and the DDL has both columns generated with backslash escaping that's wrong for `regexp_replace`. | Use proper Drizzle `generatedAlwaysAs` with correct `\D` escape; create unique indexes on `(org_id, dedup_email)` and `(org_id, dedup_phone)` partial-where-not-null. |
| `UNIQUE (COALESCE(org_id::text, 'GLOBAL'), email)` is a **non-deterministic expression unique constraint** — Postgres rejects this in some versions. | Use a unique index on a generated column `scope_key text` (= coalesced org_id text or 'GLOBAL') and email. |
| `CREATE INDEX suppressions_org_email ON suppressions (COALESCE(org_id, ...))` — same issue. | Same: index on the generated scope_key. |
| `citext` referenced without `CREATE EXTENSION IF NOT EXISTS citext`. | Add to migration `0000_init.sql`. |
| Missing FKs: `lead_signals.org_id`, `campaign_recipients.org_id`, `email_events.org_id`. | Added with `ON DELETE CASCADE`. |
| No `CHECK` constraint on `leads.status`, `campaigns.status`, `campaign_recipients.state`, `email_events.event_type`. | Added enum-like CHECK constraints. |
| Webhook idempotency relies on a non-unique index `email_events_idem`. Replays will create duplicate event rows. | Promote to `UNIQUE (provider_message_id, event_type)` where `provider_message_id IS NOT NULL`. |
| No `discovery_jobs` / `job_runs` / `validation_*` / `scoring_versions` / `provider_usage` tables. | Added. |
| No `inbound_messages` table; v3 plan was to update lead.notes — fragile for taxonomy classification. | Added a dedicated table with reply_intent + auto-detected category. |

## 9. Provider / TOS risks

| Provider | Risk | Mitigation in code |
|---|---|---|
| AWS SES | Sandbox cap; bounce/complaint suspend thresholds. | Send-blocking gate checks `production_access_confirmed=true`. Bounce > 4% / complaint > 0.1% → campaign auto-pause + alert. |
| Postmark outbound | TOS ban. | No adapter file exists. Lint test asserts. |
| Resend outbound | TOS ban (in practice). | No adapter file exists. Lint test asserts. |
| Yelp Fusion | 24h cache rule. | `yelp.scoringOnly()` returns scoring inputs and the adapter never returns persistable display fields. Schema has zero Yelp-named columns. |
| Hunter.io | 50 credits/mo free (unified pool). | Cost guard: budget mode "free" = use only when score ≥ 90 AND scrape failed AND monthly credits < 50 used. |
| Bouncer | $8/1k credits, never expire, free for duplicates. | Cost guard: use only when free verification chain returns "unverifiable" AND score ≥ 80 AND monthly budget allows. |
| Apollo / Clay / LinkedIn / ZoomInfo / RocketReach | Forbidden at MVP. | No adapter files exist. |
| OSM Overpass | ODbL attribution; 10k req/day; identifiable User-Agent. | Adapter sets `User-Agent: KeresAI/0.1 (ops@<configured-domain>)`. UI footer displays "© OpenStreetMap contributors" link. |
| Google Places | $5/1k now (universal credit eliminated). | No adapter at MVP; build placeholder if needed later. |
| Twilio Lookup | $0.005/lookup. | Deferred to point-of-sale (post-reply). Not at intake. |
| Foursquare Places | Free tier drops to 500/mo June 2026 — cliff. | Excluded. |

## 10. Build decisions (locked in for this scaffold)

| Decision | Choice | Why |
|---|---|---|
| Monorepo manager | pnpm workspaces | Faster, deterministic; matches modern Node patterns. |
| Frontend framework | **Vite + React** (not Next.js) | Single-page app, internal tool, no SSR need. Smaller surface area than Next. |
| Backend framework | Fastify | Spec-required; lightweight; native schema validation. |
| ORM | Drizzle | Spec-required; native Postgres types; easier migrations than Prisma for this team. |
| DB driver in dev | `pg` against local Postgres OR `pg-mem` for tests | Real Postgres for the audit; `pg-mem` and SQLite skip — only real Postgres semantics. |
| DB in prod | Neon Postgres free tier via `@neondatabase/serverless` | v3.1 spec. |
| Queue | DB-backed `job_runs` table (poll-based) | Avoid Upstash dep at MVP. |
| Auth | Single-tenant via env var bearer token + cookie | Spec said "single-tenant is enough for MVP". |
| Job scheduling | Internal cron loop using `setInterval` + DB locks | Cloudflare Cron handles prod heartbeats; internal scheduler covers dev. |
| Sample mode | Env flag `SAMPLE_MODE=true` | The seed/demo data path lives; no demo warnings in real mode. |
| Secrets | `.env` only | No localStorage. Settings UI only accepts non-secret values. |
| Testing | Vitest | Fast; ESM-native; matches monorepo. |
| Logging | Pino through Fastify | Structured. |
| Money math | Integers (cents) | Avoid float drift. |
| Dates | UTC; conversion at the UI edge | Avoid TZ bugs across discovery/storm/scoring. |
| Open tracking | **Disabled, permanently** | Apple MPP makes it noise. Spec-required. |
| Per-lead AI | **Forbidden** | Spec. Test enforces no Anthropic SDK in `apps/server`. |
| List-Unsubscribe-Post | Required on every send | Gmail/Yahoo. |
| Plain-text only | Yes | Spec. |
| Demo warnings | Removed in real mode; only shown when `SAMPLE_MODE=true`. | Spec. |

---

*End of audit. Implementation now proceeds against `docs/UPDATED-ARCHITECTURE.md`.*
