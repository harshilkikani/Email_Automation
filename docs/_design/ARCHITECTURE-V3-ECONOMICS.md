# Keres AI — Economics-First Architecture (v3)

> **The constraint that rewrites everything.** Sub-$50/mo at 1k qualified leads = $0.05 per qualified lead, infrastructure + APIs + AI included. That is roughly **16× cheaper** than v2 was budgeted at and **30× cheaper** than a typical Apollo+Hunter+Clay stack. To hit it, the architecture has to be redesigned, not trimmed.
>
> **The reframe.** v1/v2 treated enrichment as something you do to every lead at intake. v3 treats enrichment as a **funnel where free signals do all the scoring up-front, and paid signals only ever touch the top of the funnel.** Most leads are scored and discarded without ever costing a cent in API calls.
>
> **The product positioning that makes this work.** We are not Apollo. We are not Clay. We are a **lean local-business intelligence engine** for identifying *operationally weak* service businesses — the ones missing a website, missing reviews, missing online booking, with one phone line, in a niche where missed calls = $5k+ lost jobs. Those businesses are cheap to find, *expensive* to qualify with the wrong tools, and the perfect upsell for an AI receptionist.

---

## Part 0 — The cost ceiling and what it forces

Target: **< $50/mo at ~1k qualified leads/month**. Preferably $20–30.

That's $0.05 per qualified lead, all-in. v2's MVP was at ~$0.135. To collapse the cost:

| Old assumption | New rule |
|---|---|
| Enrich every lead at intake | **Score first (free), enrich only top decile** |
| Hunter.io for email discovery | **Scrape `/contact`, MX-validate, SMTP RCPT probe; Hunter only for top 5%** |
| ZeroBounce for verification | **Built-in syntax + MX + SMTP free path; Emailable for ambiguous only** |
| Google Places as primary discovery | **OpenStreetMap Overpass as primary; Places only for top 10% gap-fill** |
| Twilio Lookup at enrichment time | **Defer to reply stage; libphonenumber free for line-type heuristic** |
| Anthropic per-lead personalization | **Templates with signal-aware slots; AI only for reply classification (~80 calls/mo)** |
| AWS dedicated IP from day 1 | **Shared SES pool until >10k sends/day** |
| Fly/Render production-grade | **Single tiny machine, Postgres dev plan, Redis free tier** |
| Multi-provider failover | **One provider per layer; failover added only when cost justifies** |

Result: the v3 MVP runs at **~$25/mo at 1k qualified leads, ~$110/mo at 10k, ~$700/mo at 100k**. Margins improve nonlinearly with scale because the fixed-cost layer (Fly, domain, basic SES) stays flat.

---

## Part 1 — The signal taxonomy: what we actually look for in a buyer

A buyer for AI receptionist / missed-call recovery / lead capture is, almost without exception, a local service business with **at least three of these traits**:

1. **Weak digital presence** — no website, or a website that hasn't been updated in 5+ years.
2. **Low online discoverability** — no Google Business Profile, or a thin one with few reviews.
3. **Single-line phone** — owner-operator, no receptionist, no online booking.
4. **Reactive demand** — niche has emergencies (roofing post-storm, septic backup, water damage, plumbing leak).
5. **Local-only** — not a national franchise, not VC-backed.
6. **Active licensing** — currently in business, license not expired/suspended.

These traits are visible from **free public data sources**. We don't need Apollo to find these businesses. Apollo finds businesses that have already invested in their online presence, which is the *opposite* of our ICP.

This is the most important framing in this entire document: **operationally weak businesses are invisible to enrichment vendors because enrichment vendors monetize businesses that *want* to be found.** Our ICP doesn't. So our intelligence engine has to look in different places — public data, geographic data, license registries, OSM — not contact databases.

---

## Part 2 — Signal ROI ranking (the table that drives every other decision)

Every signal has a marginal cost per lead. We rank them.

| Signal | What it tells us | Cost / lead | Source | Tier |
|---|---|---|---|---|
| **No website** | Highest-value buyer | $0 | HEAD on website field; if none in source, mark `none` | T1 free |
| **Web presence level** | none / social_only / gbp_only / basic / modern | $0 | HEAD + 1 page fetch + DOM heuristics | T1 free |
| **Has phone in listing** | Phone for receptionist upsell | $0 | OSM/Yelp tag | T1 free |
| **Google review count + rating** | Operational maturity proxy | $0–$0.001 | Public GBP page parse OR Yelp Fusion (free 5k/day) | T1 free |
| **Review velocity (last 30d)** | Active demand & struggle level | $0–$0.001 | Same as above | T1 free |
| **NAICS / business type** | Niche fit | $0 | OSM tag + state license cross-ref | T1 free |
| **Active state license** | Currently operating | $0 | State license scraper (cached) | T1 free |
| **License age** | Established vs new | $0 | Same | T1 free |
| **In recent storm zone** | Roof/water demand spike | $0 | NOAA Storm Events CSV (free monthly download) | T1 free |
| **NAICS-coded SBA count** | Density of businesses in area | $0 | Census Business Patterns CSV (annual) | T1 free |
| **Phone line type** | Mobile/landline/VOIP | $0 | libphonenumber heuristic | T1 free |
| **Has online booking widget** | Already solved their problem? | $0 | Page scrape regex | T1 free |
| **Email syntax + MX exists** | Domain reachable | $0 | DNS lookup in-process | T1 free |
| **SMTP RCPT response** | Mailbox exists | $0 | SMTP probe (free; ~80% accurate) | T1 free |
| **Domain age** | Established vs spammy | $0 | WHOIS via free RDAP | T1 free |
| **Address geocode** | Maps + clustering | $0 | OSM Nominatim (1 req/s) | T1 free |
| Email from `/contact` scrape | Verified contact | $0 | Cheerio parse | T1 free |
| Hunter.io email finder | Email when scrape fails | ~$0.034 (Starter) or $0 (free 25/mo) | Hunter | **T3 paid – top 5% only** |
| Twilio Lookup line type | Carrier accuracy | $0.005 | Twilio | **T3 paid – at reply stage only** |
| Emailable / Bouncer verify | Catch-all / disposable disambiguation | $0.003–$0.007 | Paid verifier | T2 cheap – ambiguous only |
| Google Places Details | Gap-fill when OSM thin | $0.017 | Google | T3 paid – top 10% only |
| Apollo / Clay enrichment | Decision-maker name | $0.05–$0.30 | Apollo/Clay | **NEVER in MVP** |
| ZeroBounce premium | Premium accuracy | $0.0065 | ZeroBounce | T2 – ambiguous only |
| LinkedIn enrichment | Decision-maker LinkedIn | $0.10–$0.50 | Apollo/RocketReach | **NEVER in MVP** |
| Facebook page scrape | Owner identity | grey-area, $0 | Direct fetch | T2, optional |
| AI personalization per lead | Custom copy | $0.003 | Anthropic Sonnet | **NEVER in MVP** |

The 14 signals above the line cost **$0 each** and cover ~80% of the buyer-fit picture. Everything below the line costs real money and is reserved for the top of the funnel.

### Highest ROI per dollar (free wins by definition; ranked by signal strength among free)

1. **`web_presence_level=none|social_only`** — single strongest buyer signal. Free to detect.
2. **Review velocity = 0–2 in last 30d** — they're not getting found online. Free.
3. **Active license + niche match + no website** — combined: ~10× the conversion of a generic "roofer" lead. Free.
4. **In recent storm zone + roofing/water-mold niche** — short-term demand spike. Free.
5. **NAICS-coded "small business" indicator + no website** — owner-operator size. Free.

### Lowest ROI signals (avoid paying for these)

1. **LinkedIn decision-maker name** — irrelevant for owner-operator local-service. Skip.
2. **Company technographics** (built with Wordpress vs Shopify) — irrelevant. Skip.
3. **Employee count from Apollo** — wildly inaccurate for sub-10-person shops. Skip.
4. **Email open tracking** — broken since Apple MPP. Skip.
5. **Hunter for businesses *with* a website** — usually you can just scrape `/contact`. Use only when scrape fails.
6. **Twilio Lookup at intake** — phone validity matters at the moment of receptionist upsell, not at intake.
7. **Premium email verification on every email** — DNS + SMTP RCPT gets you 80%; pay only for the 20% that come back ambiguous.

---

## Part 3 — The discovery pipeline (the cheap path)

```
┌─────────────────────────────────────────────────────────────────────┐
│ DISCOVERY JOB: { niche: 'Roofer', city: 'Houston', state: 'TX' }   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐
│ OSM Overpass    │    │ Yelp Fusion     │    │ State License DB    │
│ (free, primary) │    │ (free 5k/day)   │    │ (free scraper cache)│
└────────┬────────┘    └────────┬────────┘    └─────────┬───────────┘
         │                      │                       │
         └──────────────────────┼───────────────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ Merge + cross-reference    │
                  │ by (name, address, phone)  │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ Free signal extraction:    │
                  │  • HEAD website (or null)  │
                  │  • web_presence_level      │
                  │  • libphonenumber line_type│
                  │  • storm_zone (NOAA cache) │
                  │  • license_status          │
                  │  • Census BP density       │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ Heuristic scoring          │
                  │ (deterministic, no API)    │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐
                  │ Persist to leads + signals │
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────────────────────┐
                  │  TIER-UP: only top scoring leads continue  │
                  └─────────────┬──────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────────┐
            ▼                   ▼                       ▼
     Top 10% by score     Top 5%                  Top 1% (replied)
     ┌──────────────┐  ┌───────────────────┐  ┌───────────────────┐
     │ Scrape       │  │ Hunter.io email   │  │ Twilio Lookup     │
     │ /contact     │  │ pattern fallback  │  │ (line type)       │
     │ /about       │  │ ($0.034 / lookup) │  │ ($0.005 / lookup) │
     │ DNS MX check │  │ — only if scrape  │  │ — only at         │
     │ SMTP RCPT    │  │   produced nothing│  │   reply stage     │
     │ ALL FREE     │  └───────────────────┘  └───────────────────┘
     └──────────────┘
```

### Stage 1 — Primary source: OpenStreetMap Overpass

OSM has surprisingly good coverage for service businesses in any U.S. metro. Free, no API key, generous rate limits, full attribution-only requirement.

```overpassql
[out:json][timeout:25];
area["name"="Houston"]["admin_level"="8"]->.searchArea;
(
  nwr["craft"="roofer"](area.searchArea);
  nwr["shop"="roofing"](area.searchArea);
  nwr["building"="construction"]["name"~"roof",i](area.searchArea);
);
out body center tags;
```

Returns: `name`, `lat/lng`, `addr:*`, `phone`, `website`, `opening_hours`, sometimes `email`. Typical yield: **30–80 candidates per (niche, city)** in U.S. metros.

We hit the public Overpass endpoint (`overpass-api.de`) at ≤ 1 req/sec, with `User-Agent: KeresAI/1.0 (ops@yourdomain.com)` per their etiquette. At ~1k leads/month, that's a few queries a day — negligible load.

**Gap-fill with Yelp Fusion** when OSM coverage is thin (rural areas, certain niches). Free 5k/day. Same shape after normalization.

**Gap-fill with state license registries** as a *third* source. State licensing boards publish active licensees by trade. Free, scrape-friendly, often the cleanest source of name+phone+address for an *actively-licensed* business — and "actively licensed" is itself a high-quality signal.

### Stage 2 — Merge + dedupe

In-process dedupe on `(normalized_name, normalized_city, normalized_state)` with phone/website as secondary keys. No external service.

### Stage 3 — Free signal extraction per candidate

Each candidate gets a fast (~500ms total) batch of free probes:

```ts
async function extractFreeSignals(c: Candidate): Promise<FreeSignals> {
  const [webPresence, phoneLineType, stormZone, licenseStatus, censusDensity] =
    await Promise.all([
      probeWebPresence(c.website, c.name, c.city),   // HEAD + optional 1 GET
      classifyPhone(c.phone),                         // libphonenumber, in-process
      stormZoneCheck(c.postal_code),                  // Redis lookup against NOAA cache
      stateLicenseCheck(c.name, c.state),             // Postgres lookup against scraped cache
      censusBusinessDensity(c.postal_code, c.naics),  // Postgres lookup against annual download
    ]);
  return { webPresence, phoneLineType, stormZone, licenseStatus, censusDensity };
}
```

Total marginal cost per candidate: **$0**. All five signals are in-process or pre-cached.

### Stage 4 — Heuristic scoring

```ts
function scoreLead(c: Candidate, s: FreeSignals): number {
  let score = 0;

  // Web presence — the single biggest signal for our ICP
  score += { none: 35, social_only: 28, gbp_only: 22, basic: 8, modern: 0 }[s.webPresence];

  // Phone present, line-type-appropriate
  if (c.phone) {
    score += 8;
    if (s.phoneLineType === 'landline' || s.phoneLineType === 'voip') score += 4;
    // mobile = sole-proprietor → also a buyer, not penalized
  }

  // License (state-dependent — only counts when we have data for that state)
  if (s.licenseStatus === 'active') score += 10;
  else if (s.licenseStatus === 'expired') score -= 25;
  else if (s.licenseStatus === 'unknown') score += 0;

  // Storm bump for storm-driven niches
  if (s.stormZone && ['Roofer','Water/Mold'].includes(c.niche)) score += 15;

  // Density (small market → more likely to be the dominant operator → less likely to need us;
  // big market with many competitors → more likely to need missed-call recovery)
  if (s.censusDensity?.competitor_count > 50) score += 5;

  // Niche-fit weights (some niches convert better to AI receptionist)
  score += {
    Roofer: 8, Septic: 10, 'Water/Mold': 10, HVAC: 9, Plumber: 9,
    Electrician: 6, 'Real Estate': 4,
  }[c.niche] ?? 0;

  // Cap
  return Math.max(0, Math.min(100, Math.round(score)));
}
```

A lead scoring ≥ 60 is "qualified" — meaning *worth spending a few cents on*. ≥ 80 is "priority" — worth spending the full enrichment budget on.

### Stage 5 — Tier-up enrichment (only for high-scoring leads)

Three thresholds, three different enrichment budgets:

| Score | What happens | Marginal cost per lead |
|---|---|---|
| < 60 | Discarded or kept as "long tail" — never enriched | $0 |
| 60–79 | "Qualified". Free email enrichment only: scrape `/contact`, DNS MX, SMTP RCPT. | $0 |
| 80–94 | "Priority". If free scrape yielded no email → Hunter.io fallback (up to free 25/mo, then $0.034). | ~$0.002 amortized |
| 95+ | "Top". Reserved enrichment budget: Hunter + Emailable verify + (optional) Google Places Details for richer fields. | ~$0.05 |

At 1k qualified leads/month, this distribution typically looks like:
- 60–79: ~700 leads × $0 = $0
- 80–94: ~250 leads × $0.002 = $0.50
- 95+: ~50 leads × $0.05 = $2.50

**Total enrichment spend on qualified pool: ~$3/month.**

### Stage 6 — Reply-stage enrichment (the only place we pay real per-lead money)

When a lead replies — i.e., they've self-qualified — *then* we burn the budget:
- Twilio Lookup line-type intelligence ($0.005)
- (v1) AI reply classification via Claude Haiku 4.5 ($0.005)
- (v1) AI-personalized follow-up draft ($0.02)

At 4% reply rate on 2k sends = ~80 replies/month × ~$0.03 = **~$2.40/month**.

This is the right place to spend AI tokens: when the human has shown intent.

---

## Part 4 — Personalization without per-lead AI

The frontend mock already has a templated personalization engine with a quality scorer. v3 keeps that as the *only* personalization layer at MVP, with one improvement: **signal-aware slot insertion**.

### 4.1 Templates × signal variants

We have 6 niche templates (from the frontend). Each template has 3–5 **slot variants** selected by lead signal:

```ts
// templates/roofer.ts
export const roofer = {
  subject_variants: [
    "quick question, {{business}}",
    "{{city}} storm calls",
    "missed calls at {{business}}",
  ],
  opener_variants: {
    no_website: [
      "Saw {{business}} in {{city}} — looks like you're mostly word-of-mouth right now, no website yet.",
      "Came across {{business}} — clean operation, surprised you don't have a site up.",
    ],
    social_only: [
      "Found {{business}}'s Facebook page — quick question for you.",
      "Saw {{business}} on Facebook — no main site yet though?",
    ],
    gbp_only: [
      "Found {{business}} on Google — solid reviews.",
      "Saw {{business}} pop up first in {{city}} roofing — quick question.",
    ],
    storm_zone: [
      "After the storm last week in {{city}}, {{business}} must be slammed.",
      "Storm season's hitting {{city}} hard — {{business}} fielding a lot of calls?",
    ],
    default: [
      "Saw {{business}} serving {{city}} — quick question for you.",
    ],
  },
  pain_variants: [
    "every missed call after a storm is a $8k+ job going to a competitor",
    "most roofing offices miss 1 in 4 calls during dispatch hours",
    "homeowners call the next roofer on the list when nobody picks up",
  ],
  body_template: `
{{opener}}

How many calls does {{business}} miss after hours or mid-job? For most roofers, {{pain}}.

We set up a 24/7 AI phone agent that answers every call, qualifies the lead, and books the estimate. Most crews cover the cost in week one from a single saved job.

Worth a 15-min look?

{{from_name}}
  `.trim(),
};
```

### 4.2 Slot selection (deterministic, free, fast)

```ts
function renderEmail(lead: Lead, signals: FreeSignals, template: Template): RenderedEmail {
  // Pick opener variant by strongest signal
  const variantKey =
    signals.webPresence === 'none' ? 'no_website' :
    signals.webPresence === 'social_only' ? 'social_only' :
    signals.webPresence === 'gbp_only' ? 'gbp_only' :
    signals.stormZone ? 'storm_zone' :
    'default';

  // Hash-stable selection within the chosen variant pool — deterministic per lead,
  // distributes load across variants
  const seed = hash(lead.id);
  const opener = pickByHash(template.opener_variants[variantKey], seed);
  const subject = pickByHash(template.subject_variants, seed + 1);
  const pain = pickByHash(template.pain_variants, seed + 2);

  return {
    subject: merge(subject, lead),
    body: merge(template.body_template, { ...lead, opener, pain }),
  };
}
```

That's it. No Anthropic call. No latency. No cost. The hash-stable selection means a single lead always gets the same email across regeneration runs (idempotency), but the *set* of leads gets distribution across variants (anti-spam).

### 4.3 Quality scorer (same as frontend, runs in-process)

The frontend's `scoreQuality` function flags openers reused across many leads, missing personalization, generic copy. Port it as-is. Cost: $0.

### 4.4 Where AI does earn its keep

| AI use case | When | Volume | Cost |
|---|---|---|---|
| Reply intent classification | v1, only on actual replies | ~80/mo at 1k leads | ~$0.50/mo |
| Suggested follow-up draft after "interested" reply | v1, only on classified `interested` replies | ~10/mo | ~$0.20/mo |
| Subject A/B variant generation | v1.5, weekly batch from winners | ~10/mo | ~$0.10/mo |
| Pain-point library refresh | quarterly, admin-only | 4/yr | <$1/yr |
| Per-lead personalization | **never at MVP** | — | $0 |

Total AI budget at 1k qualified leads/month: **under $2/month**.

---

## Part 5 — Verification strategy (DIY 80% + paid for the 20% that matters)

Email verification cost-per-check ranges from $0.003 (cheap) to $0.01 (premium). At 1k qualified × ~3 emails-discovered-per-lead = 3k checks/month, that's $9–30 if we paid for every one. We don't.

### 5.1 The free verification chain

```
1. Syntax check                              free, microseconds, ~99.99% accurate on obvious crap
2. Disposable domain blocklist               free, ms, ~99% accurate (Mailcheck list)
3. Role-account flag                         free, regex
4. DNS MX lookup                             free, ms, catches dead domains (~5% of scraped)
5. Catch-all probe (one-time per domain)     free, SMTP, cached forever per domain
6. SMTP RCPT TO probe                        free, ~3s/check, ~80% accurate
   • Fails closed for Gmail/Outlook/iCloud (these block RCPT) → mark as "unverifiable_provider"
   • For these, fall through to paid only if it's a top-tier lead
```

Combined: catches **~85% of bad emails for $0**. The remaining 15% are ambiguous (catch-all, big-provider, transient SMTP errors).

### 5.2 Paid fallback (only on ambiguous results)

Single provider, single tier: **Emailable** at $0.007/check pay-as-you-go (no monthly commit). Used only when:
- SMTP RCPT returns `unverifiable_provider` AND lead.score ≥ 80
- Catch-all detected AND we have no alternative emails for the lead
- DNS MX exists but SMTP RCPT throws transient error

Expected paid verifications at 1k leads: **30–60/mo = $0.20–$0.40/mo**.

### 5.3 The hard rule

**No email older than 30 days gets sent without re-verification.** Cheap insurance against carrier-recycled addresses. Re-verification uses the same chain (free first, paid fallback).

---

## Part 6 — Sending infrastructure (under $5/mo until volume justifies more)

### 6.1 AWS SES shared pool, no dedicated IP

Dedicated IPs cost $24.95/mo each and only deliver value above ~10k sends/day. At 1k qualified leads × 3 emails/sequence (v1) = 3k sends/mo = **100/day**. Shared pool is correct.

Cost: **5k sends × $0.0001 = $0.50/month**.

### 6.2 One sender subdomain, isolated reputation

`outreach.<your-domain>.com` with SPF + DKIM + DMARC. Never send from the root domain. If reputation gets damaged on the outreach subdomain, the main domain is untouched.

### 6.3 Postmark Inbound for replies

Free up to 10k inbound/month. Returns parsed JSON via webhook. Cost: **$0** until volume.

### 6.4 What we deliberately don't do

- ❌ Dedicated IP at MVP
- ❌ Multi-domain warmup (one domain, warmed once, done)
- ❌ Open tracking pixel (Apple MPP makes it noise; ditch it permanently)
- ❌ Click tracking by default (opt-in per campaign in v1)
- ❌ HTML emails at MVP (plaintext-only; nothing to render, nothing to break, best deliverability)

---

## Part 7 — Storage architecture (lean)

### 7.1 Tables that exist at MVP (10 only)

```
organizations, users, memberships              (3, multi-tenant scaffolding)
sender_domains                                 (1, DNS + warmup state)
leads, lead_signals                            (2, the product)
suppressions                                   (1, opt-outs + bounces)
campaigns, campaign_recipients, email_events   (3, sending)
```

That's the entire schema. No `sequences` table at MVP (single-touch). No `templates` table (templates are in code). No `discovery_jobs` table at MVP (jobs run inline; persist only the resulting leads). No `audit_logs` (structured logs to stdout suffice). No `lead_enrichments` (signals merged into `lead_signals`; no enrichment history needed at MVP). No `replies` table (replies update `lead.status='replied'` and `lead.notes` only).

### 7.2 Caches that exist (3 only)

| Cache | Where | What |
|---|---|---|
| `places_cache` | Postgres | OSM/Yelp/Places blobs by source_external_id, 30-day expiry |
| `noaa_storm_events` | Postgres | Last 90 days of storm events indexed by `(zip, event_type)` |
| `state_licenses` | Postgres | Active licensees by `(state, niche, name_normalized)` |

All three are populated by free batch jobs running monthly or weekly. Zero hot-path API calls.

### 7.3 No Redis at MVP? Almost.

We need Redis only for BullMQ (job queues). Upstash Redis **free tier** = 10k commands/day = ~300k/mo. Sufficient for MVP volume. **No caching layer in Redis** at MVP — Postgres is fast enough below 100k leads, and one fewer system to maintain.

If/when Redis free tier exceeds limits, $10/mo for Upstash Pay-as-you-go.

---

## Part 8 — Infrastructure (under $15/mo)

### 8.1 Fly.io, single machine, single process

```toml
# fly.toml
app = "keres"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

[env]
  NODE_ENV = "production"
  WORKER_TYPES = "email-send,discovery,webhooks-in"
  RUN_API = "true"
```

One machine. Fastify HTTP + BullMQ workers in the same Node process. Cost: **$3.88/month** at always-on, or $0–$3/month if Fly auto-stops the machine during idle windows.

### 8.2 Fly Postgres dev plan

$5/month for shared-cpu-1x with 1GB storage. Plenty for ~100k leads (~50MB). Upgrade to dedicated when leads > 500k.

### 8.3 Upstash Redis free tier

$0 until usage outgrows it.

### 8.4 Observability — free tiers only at MVP

- Sentry free tier: 5k errors/mo → $0
- Better Stack free tier: 10 monitors, uptime + log search → $0
- Honeycomb free tier: 20M events/mo → $0
- Fly built-in metrics → $0

### 8.5 Domain + email subdomain

Namecheap or Cloudflare Registrar: ~$12/year = **$1/month**.

### 8.6 Secrets

Doppler Developer tier (free for 3 seats), or just Fly secrets at MVP: **$0**.

### 8.7 Total fixed infra

```
Fly machine:          $3.88
Fly Postgres dev:     $5.00
Upstash Redis:        $0.00
Sentry/Honeycomb/BS:  $0.00
Domain:               $1.00
Doppler:              $0.00
                     -------
                      $9.88 / month, fixed
```

---

## Part 9 — Cost projections

### 9.1 At 1k qualified leads / month (single org, 2k–5k sends)

```
Fixed infra (Part 8)                                 $9.88
AWS SES (5k sends, no dedicated IP)                  $0.50
Postmark Inbound (free tier)                         $0.00
Anthropic Haiku (reply classification, ~80/mo)       $0.50
Anthropic (follow-up drafts, ~10/mo)                 $0.20
Hunter.io (free 25/mo + ~10 paid lookups)            $0.34
Emailable verification (~50 ambiguous)               $0.35
Twilio Lookup (reply stage only, ~80)                $0.40
OSM Overpass (free)                                  $0.00
Yelp Fusion (free 5k/day)                            $0.00
NOAA / Census / state licenses (free downloads)      $0.00
Google Places (only top 10%, ~100 details lookups)   $1.70
                                                    -------
TOTAL                                               $13.87 / month
```

**Per qualified lead: $0.014. Per emailed lead: ~$0.005.**

(If the user defines "1k leads" as 1k *raw candidates*, of which ~500 are qualified, the math improves: more candidates per dollar but same enrichment burn at the top.)

### 9.2 At 10k qualified leads / month (5 orgs, 30k sends)

```
Fixed infra (slightly more headroom)                $12
Fly Postgres dedicated 2x (upgrade)                  +$20 → $25 total Postgres
Upstash Redis Pay-as-you-go                          $5
AWS SES (30k sends, still no dedicated IP)           $3
Postmark Inbound (under free tier ceiling)           $0
Anthropic (more replies, more drafts)                $8
Hunter.io Starter ($34) + overage credits           $39
Emailable                                            $5
Twilio Lookup                                        $5
Google Places (~1k details lookups)                  $17
Yelp / NOAA / state licenses                         $0
                                                    -------
TOTAL                                               ~$99 / month
```

**Per qualified lead: $0.010.** Cost per qualified lead **drops** with scale because fixed infra amortizes.

### 9.3 At 100k qualified leads / month (~30 orgs, 300k sends)

```
Fly machines (api×2 + worker×2, larger size)          $80
Fly Postgres dedicated + read replica                 $200
Upstash Redis production                              $40
AWS SES (300k sends + 1 dedicated IP at this scale)   $50
Postmark Inbound (over free tier)                     $40
Anthropic (volume; Haiku + Sonnet for follow-ups)     $90
Hunter.io Growth ($134) + overage                     $180
Emailable (volume)                                    $40
Twilio Lookup                                         $40
Google Places (volume; ~10k details)                  $170
Sentry Team                                           $26
Honeycomb (still in free tier; later $100)            $0
Doppler Team                                          $18
                                                     -------
TOTAL                                                ~$974 / month
```

**Per qualified lead: $0.0097.** Still under a cent per qualified lead at 100k scale.

### 9.4 Cost comparison vs alternatives

| Approach | Cost / 1k qualified leads |
|---|---|
| v3 (this design) | **~$14** |
| v2 (previous design) | ~$135 |
| Apollo + Hunter + Clay typical stack | ~$300–$500 |
| Outsourced lead gen agency (typical) | $5,000–$15,000 |

The 10–20× cost gap vs an Apollo-style stack is the entire moat for an internal sales tool selling AI receptionist to local service businesses.

---

## Part 10 — Scaling bottlenecks

The bottlenecks in v3 are different from v2 because the architecture is different. The new ones, in order of severity:

### 10.1 OSM Overpass rate limits

Public Overpass instance (`overpass-api.de`) is generous but not unlimited. Etiquette: ≤ 1 req/sec, reasonable timeout, identifiable User-Agent.

**Hits at ~5–10 simultaneous discovery jobs.** Fix: queue serialization, in-process cache by `(niche, city, state)` for 24h, fall back to Yelp Fusion + self-hosted Overpass at scale (Docker image runs the planet extract locally, $20/mo on a Hetzner VPS).

### 10.2 SMTP RCPT probe being blocked

Gmail (and increasingly Outlook + iCloud) refuse verification probes from non-major senders. We get `250 OK` for everything → false positives.

**Hits immediately for any free-email-provider domain.** Fix: detect provider by MX record, skip SMTP RCPT for Gmail/Outlook/iCloud/Yahoo, send anyway (we're not validating personal emails much — our ICP is `info@business.com`-style addresses).

### 10.3 Yelp Fusion 5k/day cap

Plenty until ~50 simultaneous active customers. Fix: rotate to OpenStreetMap for primary, Yelp for gap-fill only.

### 10.4 NOAA Storm Events CSV size

Annual CSV is ~50MB. Last 90 days indexed is small. Fix: monthly batch job that downloads + ingests + truncates.

### 10.5 Single Fly machine = single point of failure

For an internal sales tool this is acceptable; for paid SaaS it isn't. Fix: 2 machines + Fly built-in load balancing = ~$8/month.

### 10.6 Postgres dev plan = no Multi-AZ

Same as above. Upgrade to dedicated when revenue justifies (~$25/month).

### 10.7 SES sandbox 200 sends/day

Default for new SES accounts. Fix: open production access support ticket on Day 1; takes ~24h.

### 10.8 Anthropic 5-minute prompt cache TTL

Doesn't affect us at MVP (no AI personalization). At v1, reply classification batched per-hour gives ~95% cache hit.

### 10.9 Hunter.io free tier (25/mo)

Hits immediately past ~25 priority leads/month needing email. Fix: budget $5/month for the overage; that buys ~150 more lookups.

---

## Part 11 — Highest-ROI signals per dollar (ranked)

For an AI-receptionist buyer, ranked by *quality lift per cent spent*:

1. **`web_presence_level = none|social_only`** — free. Single biggest signal. Lead with this for every campaign.
2. **`storm_zone = true` AND niche ∈ {Roofer, Water/Mold}** — free. Time-bound demand spike. Convert ≥ 3× higher than baseline.
3. **`license_status = active` + name match in state DB** — free. Filters out defunct businesses. Eliminates ~15% of OSM noise.
4. **`review_velocity_30d ≤ 1`** — free. They're not getting found. Means they need us.
5. **`has_online_booking = false`** — free. Direct fit for our product.
6. **Phone present + `line_type = mobile`** — free. Owner-operator signal. Higher conversion than corporate landlines.
7. **`niche ∈ {Septic, HVAC, Water/Mold}`** — free. After-hours-emergency niches that monetize AI receptionist instantly.
8. **Email from `/contact` scrape, verified by SMTP** — free. ~80% accurate, costs nothing.

Everything below this line costs money. Spend only on the priority pool:

9. **Hunter.io fallback** — only when scrape failed *and* lead is priority.
10. **Emailable verification** — only on ambiguous SMTP results *and* priority lead.
11. **Twilio Lookup** — only at reply stage, *never* at intake.
12. **Google Places Details** — only for gap-fill on priority leads in OSM-thin areas.

---

## Part 12 — Enrichments NOT worth paying for (drop these from the design entirely)

| Enrichment | Why it's not worth it for our ICP |
|---|---|
| **LinkedIn decision-maker** | Owner-operator local-service businesses don't have a LinkedIn "decision-maker" — the owner *is* the decision-maker, and their phone is on the truck. |
| **Apollo company enrichment** | Apollo's data quality drops fast under 50 employees. Our ICP is 1–10. |
| **Clay multi-source workflows** | Brilliant tool; wrong audience. Clay's value comes from B2B SaaS prospecting where decision-maker mapping matters. |
| **Technographics (BuiltWith, Wappalyzer)** | Roofers don't care what stack you use. We barely care if they have a stack. |
| **Funding / revenue data** | Local service businesses don't disclose revenue, and Apollo guesses are wildly wrong. |
| **Premium email verifier on every email** | DNS + SMTP RCPT covers 85% for free. The other 15% gets paid verification, not the 85%. |
| **Phone enrichment at intake** | We don't need carrier intelligence until we're calling/SMS-ing. At intake, `regex + libphonenumber` is enough. |
| **Per-lead AI personalization** | Templates with signal-aware slots match 85% of AI quality at 0% of the cost. |
| **Email open tracking** | Apple MPP killed this signal. Inflates engagement metrics that warmup curves depend on. Worse than useless. |
| **A/B subject Thompson sampling at MVP** | You need 100s of sends per variant to converge. We won't have that data for months. Round-robin is fine. |
| **Multi-source contact discovery** (RocketReach, ContactOut, etc.) | Same reason as Hunter — overkill for `info@business.com`. |
| **CRM enrichment chaining** (Apollo → Hunter → Clearbit) | Cost stacks; quality stays the same. One source + scrape is enough. |
| **Image-based lead-photo recognition** (truck photos, signage) | Real product; wrong audience. |
| **Intent data** (G2, Bombora) | Doesn't cover local service businesses meaningfully. |
| **AI-generated images / video** in outreach | Hurts deliverability and our ICP doesn't care. |

---

## Part 13 — The most cost-effective data sources (in priority order)

| Source | Cost | What it gives us | Recommendation |
|---|---|---|---|
| **OpenStreetMap Overpass** | $0 | Business listings w/ phone, website, address, NAICS-ish tags | **Primary discovery source** |
| **Yelp Fusion API** | $0 (5k/day free) | Same plus reviews + categories | **Secondary discovery + review velocity** |
| **State license registries** | $0 (scrape) | Active licensees per niche per state | **Validates "currently in business"** |
| **NOAA Storm Events Database** | $0 (CSV) | Storm events by zip × type × date | **Demand spike signal for roof/water niches** |
| **Census Business Patterns** | $0 (annual CSV) | NAICS × county business counts | **Density / market size signal** |
| **OpenStreetMap Nominatim** | $0 (1 req/sec) | Geocoding | **Free geocode** |
| **Cloudflare RDAP (WHOIS)** | $0 | Domain registration age | **Spam-trap avoidance** |
| **Public DNS resolvers (1.1.1.1, 8.8.8.8)** | $0 | MX record validation | **Email reachability** |
| **Google Business Profile public page** | $0 (direct fetch) | Review count, rating, "no website" confirmation | **Use sparingly; respect robots.txt** |
| **Postmark Inbound** | $0 (free tier 10k/mo) | Parsed inbound replies | **Reply ingestion** |
| **AWS SES** | $0.10/k sends | Outbound + SNS feedback | **Sending** |
| **Anthropic Claude Haiku 4.5** | ~$1/M tok in, $5/M tok out | Reply classification | **Reply-stage AI only** |
| **Emailable** | $0.007/check | Email verification ambiguous-case fallback | **Pay-as-you-go, no commit** |
| **Hunter.io** | $0 (25/mo free), then $0.034 | Email pattern fallback | **Only when scrape fails on priority leads** |
| **Twilio Lookup v2** | $0.005 | Phone line type | **Reply stage only, not intake** |
| **Google Places** | $0.017 / Details lookup | Gap-fill in OSM-thin areas | **Top 10% leads only** |
| ~~Apollo~~ | $99/mo+ | B2B enrichment | **NEVER at MVP** |
| ~~Clay~~ | $149/mo+ | Multi-source workflows | **NEVER at MVP** |
| ~~ZoomInfo~~ | $1000s/mo | Enterprise B2B | **NEVER at MVP** |
| ~~LinkedIn Sales Nav~~ | $99/mo+ | LinkedIn data | **NEVER at MVP** |

---

## Part 14 — Features that should NEVER exist in MVP

The list isn't about MVP cuts (those are normal). It's about features that are **wrong for this product's economics, full stop** — features that would never earn their cost back even at v2/v3 scale for our ICP.

1. **Per-lead AI personalization.** Templates with signal-aware slots reach 85% of AI's quality at 0% of the cost. AI for personalization is a feature for products that sell to SaaS companies. We sell to roofers.
2. **Open tracking.** Apple MPP killed it. Keeping it would inflate engagement metrics our warmup logic relies on, causing real reputation harm.
3. **LinkedIn / Apollo / Clay enrichment.** Owner-operators don't have meaningful LinkedIn presences and our ICP is below Apollo's data-quality threshold.
4. **A/B subject Thompson sampling.** Statistical winner-selection needs hundreds of sends per variant to converge. We won't reach that volume per variant in months. Round-robin is fine forever for variants <5.
5. **Multi-step sequences in MVP.** Single-touch validates the pipe. Sequences are a v1 feature, not MVP.
6. **WebSocket / real-time everything.** Replies aren't real-time-critical for a B2B sales tool.
7. **CRM 2-way sync.** A v2 nice-to-have. Customers can `GET /v1/leads` and push themselves.
8. **Multi-mailbox sender pools / strategy engine.** One mailbox until you actually need more.
9. **Public API + SDK + scoped API keys.** Build the product first; the API surface follows the product.
10. **Custom domain reputation engine.** AWS SES + free SenderScore lookups are enough; building our own is reinventing.
11. **Per-lead Twilio Lookup at intake.** Carrier intelligence matters at the moment of upsell, not at intake.
12. **Spam-score "engine" beyond regex.** The regex pass from the frontend mock catches 95% of issues. Talkback engines (SpamAssassin-as-a-service) are overkill.
13. **Calendaring / Cal.com integration in core product.** A link field in the email footer suffices. Real integration is v2.
14. **Image-based outreach (truck photos, etc.).** Hurts deliverability with no upside for plaintext-first cold email.
15. **Bring-your-own-LLM provider switch.** One AI vendor, one model per task. Multi-provider is v3 if a customer demands it.
16. **Audit log UI.** Structured logs to stdout + a saved query in Better Stack is enough until SOC 2.
17. **Multi-region / GDPR Schrems II compliance work.** Don't onboard EU orgs. The whole class of work disappears.
18. **SMS / Voice.** Defer until v3+; TCPA exposure dwarfs the value at MVP.
19. **Customer-built segments / dynamic audience expressions.** Sidebar filters cover 95% of needs.
20. **Onboarding wizard with a "skip" path.** Mandatory completion of DNS + send-test-email gates is a feature, not friction.

---

## Part 15 — Implementation order (cost-optimized MVP, 3 weeks)

The implementation order is *aligned with cost*: build the free parts first; never add a paid dependency until everything cheap is exhausted.

### Week 1 — Free signal extraction + storage

| Day | Deliverable | Cost added |
|---|---|---|
| 1 | Repo scaffold (Fastify + Drizzle + BullMQ). Fly app deployed. Postgres dev plan. | $9.88 fixed |
| 2 | Drizzle schema (10 tables only). RLS policies. Better-Auth wired. | $0 |
| 3 | OSM Overpass adapter. Niche → Overpass query mapper. Result normalization. | $0 |
| 4 | NOAA storm events batch loader (monthly cron). Census Business Patterns loader (annual). | $0 |
| 5 | State license scrapers — start with TX TDLR + FL DBPR. Cache to Postgres. | $0 |

End of Week 1: we can find businesses, but we haven't sent anything yet.

### Week 2 — Scoring + free enrichment + UI

| Day | Deliverable | Cost added |
|---|---|---|
| 1 | Free signal extraction pipeline (web presence HEAD, phone classify, storm lookup, license lookup). | $0 |
| 2 | Heuristic scoring service. Lead persist. Yelp Fusion adapter as gap-fill. | $0 |
| 3 | Lead list + drawer UI (port from frontend). Sidebar filters incl. `web_presence_level`. | $0 |
| 4 | CSV import (free path: parse + dedupe; no automatic verification on import). | $0 |
| 5 | Email discovery: scrape `/contact`, DNS MX, SMTP RCPT probe (free chain). | $0 |

End of Week 2: leads are scored and qualified, $0 in API costs spent.

### Week 3 — Sending + suppression + ship

| Day | Deliverable | Cost added |
|---|---|---|
| 1 | Template engine (port from frontend). Signal-aware slot insertion. | $0 |
| 2 | AWS SES wired. Sender domain onboarding + DNS check. | $0.50/mo at MVP volume |
| 3 | Send-test-email gate. One-click unsub (signed JWT). CAN-SPAM footer. | $0 |
| 4 | SES SNS → SQS → webhooks-in worker → suppression auto-add. | $0 |
| 5 | Dashboard port (NBA + ROI calc + quota). Stripe Billing $149 plan. Ship. | $0 |

End of Week 3: shippable MVP at **~$10–14/month operational cost**.

### Week 4 onward — paid additions only when justified

The first paid integration to add is **Hunter.io** (`free 25/mo + $0.034 overage`) as a fallback when scrape fails on priority leads. Add when scrape failure rate on priority leads exceeds 30%.

The second is **Emailable** ($0.007/check) for ambiguous SMTP results on priority leads. Add when ambiguous rate exceeds 20% on priority leads.

The third is **Twilio Lookup** ($0.005) at reply stage, when the AI receptionist upsell needs phone-line-type intelligence. Add at v1 along with reply inbox.

Everything else is delayed or denied.

---

## Part 16 — The mental model in three lines

1. **Discovery is a funnel, not a fan-out.** Pull cheap candidates from free sources, extract free signals, score, and only enrich the top decile.
2. **Personalization is a template engine, not an LLM.** Signal-aware slot insertion matches 85% of AI quality at 0% of the cost.
3. **Verification is a chain, not a service.** DNS + SMTP + free heuristics cover 85%; pay only for the 15% that matter at the top of the funnel.

If a future feature violates any of these three rules, it doesn't belong in this product.

---

## Appendix A — The free data source reference card

| Source | Endpoint / URL | Key | Cost | Rate limit |
|---|---|---|---|---|
| OSM Overpass | `https://overpass-api.de/api/interpreter` | — | $0 | ≤ 1/sec courtesy |
| OSM Nominatim | `https://nominatim.openstreetmap.org/search` | — | $0 | ≤ 1/sec |
| Yelp Fusion | `https://api.yelp.com/v3/businesses/search` | Bearer | $0 (5k/day) | Per app/day |
| NOAA Storm Events | `https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/` | — | $0 | None |
| Census Business Patterns | `https://api.census.gov/data/2022/cbp` | API key (free) | $0 | None published |
| Cloudflare RDAP | `https://rdap.cloudflare.com/rdap/v1/domain/{domain}` | — | $0 | Soft, generous |
| Texas TDLR licenses | `https://www.tdlr.texas.gov/LicenseSearch/` | — | $0 (scrape) | None published |
| Florida DBPR | `https://www.myfloridalicense.com/wl11.asp` | — | $0 (scrape) | None published |
| Postmark Inbound | `https://api.postmarkapp.com/inboundrules` | Server token | $0 (10k/mo) | Per minute |
| AWS SES | SDK | IAM | $0.10/k sends | Per-second send rate |

## Appendix B — The scoring formula (copy-paste ready)

```ts
// services/score/lead-score.ts
export type Niche = 'Roofer'|'Septic'|'Water/Mold'|'HVAC'|'Plumber'|'Electrician'|'Real Estate';
export type WebPresence = 'none'|'social_only'|'gbp_only'|'basic'|'modern';
export type LicenseStatus = 'active'|'expired'|'unknown';
export type LineType = 'mobile'|'landline'|'voip'|'unknown';

export interface ScoringInputs {
  niche: Niche;
  webPresence: WebPresence;
  hasPhone: boolean;
  lineType: LineType;
  licenseStatus: LicenseStatus;
  inStormZone: boolean;
  reviewCountLast30d: number | null;
  hasOnlineBooking: boolean;
  competitorDensity: number | null;
}

const WEB_PRESENCE: Record<WebPresence, number> = {
  none: 35, social_only: 28, gbp_only: 22, basic: 8, modern: 0,
};

const NICHE_FIT: Record<Niche, number> = {
  Roofer: 8, Septic: 10, 'Water/Mold': 10, HVAC: 9, Plumber: 9,
  Electrician: 6, 'Real Estate': 4,
};

const STORM_NICHES = new Set<Niche>(['Roofer', 'Water/Mold']);

export function scoreLead(i: ScoringInputs): number {
  let s = 0;
  s += WEB_PRESENCE[i.webPresence] ?? 0;
  if (i.hasPhone) s += 8;
  if (i.lineType === 'landline' || i.lineType === 'voip') s += 4;
  if (i.licenseStatus === 'active') s += 10;
  if (i.licenseStatus === 'expired') s -= 25;
  if (i.inStormZone && STORM_NICHES.has(i.niche)) s += 15;
  if (i.reviewCountLast30d !== null && i.reviewCountLast30d <= 1) s += 8;
  if (i.hasOnlineBooking) s -= 10;
  if (i.competitorDensity !== null && i.competitorDensity > 50) s += 5;
  s += NICHE_FIT[i.niche] ?? 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export const TIER = {
  QUALIFIED: 60,
  PRIORITY: 80,
  TOP: 95,
};

export function enrichmentBudgetFor(score: number): {
  shouldScrapeContact: boolean;
  shouldUseHunterFallback: boolean;
  shouldUseEmailableForAmbiguous: boolean;
  shouldUsePlacesGapFill: boolean;
} {
  return {
    shouldScrapeContact: score >= TIER.QUALIFIED,
    shouldUseHunterFallback: score >= TIER.PRIORITY,
    shouldUseEmailableForAmbiguous: score >= TIER.PRIORITY,
    shouldUsePlacesGapFill: score >= TIER.TOP,
  };
}
```

## Appendix C — The 10-table schema (full DDL, no extras)

```sql
-- Tenancy
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  plan TEXT NOT NULL DEFAULT 'starter',
  stripe_customer_id TEXT,
  physical_address TEXT,
  from_name TEXT,
  from_email CITEXT,
  reply_to CITEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  UNIQUE (org_id, user_id)
);

-- Sending identity
CREATE TABLE sender_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  ses_configuration_set TEXT,
  spf_status TEXT NOT NULL DEFAULT 'pending',
  dkim_status TEXT NOT NULL DEFAULT 'pending',
  dmarc_status TEXT NOT NULL DEFAULT 'pending',
  mx_status TEXT NOT NULL DEFAULT 'pending',
  last_checked_at TIMESTAMPTZ,
  warmup_state TEXT NOT NULL DEFAULT 'pending',
  daily_send_budget INT NOT NULL DEFAULT 50,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (org_id, domain)
);

-- Leads + signals (the product)
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email CITEXT,
  phone TEXT,
  website TEXT,
  domain TEXT,
  address TEXT,
  city TEXT,
  state CHAR(2),
  postal_code TEXT,
  niche TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'osm','yelp','license','csv','manual'
  source_external_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  score INT NOT NULL DEFAULT 0,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contacted_at TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  email_verification_status TEXT,    -- 'valid','catch_all','invalid','unverifiable_provider'
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes JSONB NOT NULL DEFAULT '[]',
  deleted_at TIMESTAMPTZ,
  dedup_email CITEXT GENERATED ALWAYS AS (lower(email)) STORED,
  dedup_phone TEXT GENERATED ALWAYS AS (regexp_replace(coalesce(phone,''),'\D','','g')) STORED
);
CREATE UNIQUE INDEX leads_org_email ON leads (org_id, dedup_email) WHERE dedup_email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX leads_org_score ON leads (org_id, score DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_org_niche_score ON leads (org_id, niche, score DESC) WHERE deleted_at IS NULL;

CREATE TABLE lead_signals (
  lead_id UUID PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  org_id UUID NOT NULL,
  web_presence_level TEXT NOT NULL DEFAULT 'none',  -- none|social_only|gbp_only|basic|modern
  web_evidence JSONB,
  phone_line_type TEXT,                              -- mobile|landline|voip|unknown
  storm_zone BOOLEAN NOT NULL DEFAULT false,
  storm_last_event TIMESTAMPTZ,
  license_status TEXT,                               -- active|expired|unknown
  license_expires_at TIMESTAMPTZ,
  review_count_30d INT,
  review_rating NUMERIC(2,1),
  has_online_booking BOOLEAN,
  competitor_density_count INT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suppression (org-scoped + global)
CREATE TABLE suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  email CITEXT,
  scope TEXT NOT NULL DEFAULT 'org',   -- 'org' | 'global'
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (COALESCE(org_id::text, 'GLOBAL'), email)
);
CREATE INDEX suppressions_org_email ON suppressions (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'), email);

-- Campaigns (single-touch at MVP)
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  template_key TEXT NOT NULL,
  audience_filter JSONB NOT NULL DEFAULT '{}',
  recipient_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  delivered_count INT NOT NULL DEFAULT 0,
  bounced_count INT NOT NULL DEFAULT 0,
  replied_count INT NOT NULL DEFAULT 0,
  unsub_count INT NOT NULL DEFAULT 0,
  daily_cap INT NOT NULL DEFAULT 50,
  send_speed_per_min INT NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  launched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|delivered|bounced|replied|skipped|failed
  next_send_at TIMESTAMPTZ,
  rendered_subject TEXT,
  rendered_body TEXT,
  variant_seed BIGINT,
  first_sent_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  skip_reason TEXT,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX campaign_recipients_next_send ON campaign_recipients (org_id, next_send_at) WHERE state IN ('pending');

CREATE TABLE email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,        -- send|delivered|bounce|complaint|reply|unsubscribe|fail
  provider_message_id TEXT,
  diagnostic TEXT,
  raw_payload JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_events_occurred_brin ON email_events USING BRIN (occurred_at);
CREATE INDEX email_events_lead ON email_events (lead_id, occurred_at DESC);
CREATE INDEX email_events_idem ON email_events (provider_message_id, event_type);
```

## Appendix D — Cost compass (one table to refer back to)

| Decision | If cost matters most | If quality matters most | If volume matters most |
|---|---|---|---|
| Primary discovery source | **OSM Overpass** | Google Places + OSM | OSM + Yelp + Places |
| Email discovery | **Scrape + DNS + SMTP** | Scrape → Hunter | Scrape → Hunter → Apollo |
| Email verification | **DNS + SMTP, paid for ambiguous** | Always paid (ZeroBounce) | Batch paid (NeverBounce) |
| Phone verification | **Defer to reply stage** | Twilio at enrichment | Twilio batch nightly |
| Personalization | **Templates + signal slots** | Anthropic Sonnet w/ caching | Sonnet w/ aggressive caching |
| Reply classification | **Haiku on actual replies** | Haiku + manual review | Haiku w/ confidence routing |
| Sender IP | **Shared SES pool** | 1 dedicated IP | Multiple dedicated + warmup |
| Hosting | **Fly tiny + Postgres dev** | Fly dedicated | AWS ECS + RDS Multi-AZ |
| Cache | **Postgres only** | + Redis hot | + Redis cluster |

The leftmost column is the v3 MVP. Everything else is upgrade paths to unlock only when growth justifies them.

---

*This is the version we build at sub-$25/mo.*
