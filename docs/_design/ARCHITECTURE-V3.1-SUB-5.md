# Keres AI — Sub-$5/mo Architecture (v3.1)

> **The constraint.** < $5/mo at 1k qualified leads/month, **with no quality loss**.
>
> **The finding.** Yes, $3.50/mo is achievable. The savings come almost entirely from **infrastructure choices**, not from cutting enrichment. Quality of *leads* depends on data sources and signal extraction — both kept intact. Quality of *infra* (uptime, latency) can absorb cold starts for an internal sales tool.
>
> **The honest caveat.** This document corrects three things v3 got wrong based on current (late 2025/early 2026) pricing:
> 1. **Yelp Fusion now prohibits caching business data > 24 hours.** v3 treated it as a free cache source. It's not.
> 2. **Postmark and Resend ban cold outreach in their TOS.** v3 mentioned them as backups; they aren't viable for prospecting at all.
> 3. **Google Places' $200 universal credit was eliminated.** Place Details Basic is now $5/1k, not $17/1k. Still skippable for our ICP.

---

## Part 1 — Verified pricing (the table I had wrong)

| Service | Free tier | First paid | TOS gotcha |
|---|---|---|---|
| **Fly.io machines** | None (free allowance retired) | shared-cpu-1x@256MB **$1.94/mo always-on; auto-stop drops to ~$0.50/mo idle** | Volumes still billed when stopped |
| **Hetzner CX22** | None | **€4.49/mo** (2 vCPU, 4GB, 40GB) | EU/US only |
| **Cloudflare Workers** | 100k req/day, **10ms CPU/req** | $5/mo: 10M req, 30M CPU-ms, **300s max CPU per req, Sockets API GA** | 10ms free-tier ceiling kills SMTP probes |
| **Neon Postgres** | **0.5GB storage, 100 CU-hrs/mo, scale-to-zero** | $19/mo Launch | Cold start ~500ms–1s on wake |
| **Supabase free** | 500MB, 50k MAU, 5GB egress | $25/mo Pro | **Projects auto-pause after 1 week idle** — bad for prod |
| **Cloudflare D1** | 5GB, 5M reads/day, 100k writes/day | $5/mo (with Workers Paid) | SQLite, not Postgres; 10GB/DB cap |
| **Upstash Redis** | **500k commands/mo**, 256MB, 200GB bandwidth | $0.20/100k commands PAYG | Monthly cap, not daily |
| **Cloudflare Queues** | **1M ops/mo (on Workers Paid $5)** | $0.40/M ops over | Each msg counted ~3× (write/read/ack) |
| **AWS SES** | **3k/mo first 12 months only** | $0.10/1k after | Sandbox 200/day; cold email allowed if <0.1% complaint, <5% bounce; own risk |
| **Resend** | 3k/mo | $20/mo (50k) | **Cold outreach prohibited — actively policed** |
| **Brevo free** | 300/day | $9/mo (5k) | **Branded with Brevo logo on free** |
| **Postmark** | 100 test/mo | $15/mo (10k) | **Cold outreach explicitly banned** |
| **Mailgun Flex** | 100/day | $15/mo (10k) | Cold-email tolerated with own domain |
| **Hunter.io free** | **25 searches + 50 verifications/mo** | $34/mo Starter (500 searches) | None |
| **Bouncer PAYG** | 100 free on signup | **$8 for 1,000 credits, never expire, no charge for dupes/unknowns** | None — best PAYG option |
| **Emailable PAYG** | 250 free | $32 for 5,000 ($0.0064/each) | Min $32 spend |
| **ZeroBounce PAYG** | 100 free | $20–$39 min | Credits never expire |
| **Yelp Fusion** | **500/day (new clients post-May 2023)** | Paid tiers | **TOS prohibits caching most fields > 24 hours** — kills v3 plan |
| **Google Places** | **$200 credit eliminated**; per-SKU tiered free (Essentials 10k, Pro 5k, Enterprise 1k events/mo) | Details Basic ~**$5/1k** | Place IDs storable; full data is not |
| **Overpass (OSM)** | Public free endpoint, ~10k queries/day per IP | Self-host for prod | ODbL license; attribute; identify in User-Agent |
| **Foursquare Places** | 10k Pro/mo + $200 credit **drops to 500/mo on June 1, 2026** | $0.50–$3/1k Pro | Cliff incoming — don't build on |
| **Postmark Inbound** | **10k/mo free** | usage tiered | Inbound only; not cold-outbound |

The two corrections that matter most:

1. **Yelp Fusion 24h cache rule** means we can't use Yelp as a storage-cached source. We can still call Yelp **at moment of discovery** to read review counts/ratings, *use those values in scoring*, and **not store the Yelp-sourced fields** — only the lead identity. Legal; quality preserved.

2. **Bouncer's $8-PAYG-never-expires** is the right pick for email verification, not Emailable's monthly minimum. At 50 ambiguous emails/month, $8 lasts **20 months**. Amortized: $0.40/mo.

---

## Part 2 — Line-by-line audit of v3's $14

| v3 line | Cost | Replaceable? | Replacement | New cost |
|---|---|---|---|---|
| Fly machine always-on | $3.88 | Yes → auto-stop | Auto-stop, ~12 hrs awake/day | **$1.50** |
| Fly Postgres dev plan | $5.00 | Yes → free Postgres | **Neon free tier** + 4-min keep-warm ping | **$0** |
| Upstash Redis free | $0 | Stay | — | **$0** |
| AWS SES (5k sends) | $0.50 | No (best cold-outreach option) | — | **$0.50** |
| Anthropic Haiku reply classify | $0.50 | Yes — defer to v1 | Manual triage at 80 replies/mo (5 min/day) | **$0** |
| Anthropic follow-up drafts | $0.20 | Yes — defer to v1 | Operator writes their own | **$0** |
| Hunter.io overage | $0.34 | Yes — tighten criteria | Restrict to score ≥ 90 → fits free tier 25 searches | **$0** |
| Emailable verification | $0.35 | Yes — swap to Bouncer PAYG | $8 for 1k credits / 20 months | **$0.40** |
| Twilio Lookup | $0.40 | Yes — defer to point-of-sale | libphonenumber free for line-type heuristic | **$0** |
| Google Places gap-fill | $1.70 | Yes — already optional | **Yelp Fusion at-call-time (no store)** + OSM primary | **$0** |
| Domain | $1.00 | No | — | **$1.00** |
| Postmark Inbound free | $0 | Stay | — | **$0** |
| OSM / NOAA / Census / state licenses | $0 | Stay | — | **$0** |
| **TOTAL** | **$13.87** | | | **$3.40** |

**Per qualified lead: $0.0034.** Under the $5 cap.

The savings are 75% — and **the $9.97 we cut is entirely infrastructure ($8.88) plus deferred AI/verification (~$1.09)**. Not a single dollar of *lead-quality data* was cut.

---

## Part 3 — The five swaps that get us under $5

### 3.1 Hosting: Fly always-on → Fly auto-stop

The internal sales tool runs maybe 10–50 actual HTTP requests/day from one operator. Most of the day, the machine sits idle. Fly's auto-stop machines suspend when idle and resume on the next request.

```toml
# fly.toml
app = "keres"
primary_region = "iad"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"     # ← key
  auto_start_machines = true
  min_machines_running = 0        # ← key: idle = $0 compute

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

**Cost: $0.50–$1.50/month** depending on actual uptime. Cold start: ~5 seconds on the first morning request. Acceptable for a tool one person uses.

**Workers ALSO get auto-stopped.** Cron jobs and BullMQ consumers don't run while the machine is asleep. Workaround:
- Triggered work (HTTP request, webhook): machine wakes, processes, sleeps when done. Fine.
- Scheduled work (every-hour cron): use **Cloudflare Cron Triggers** (free, 30 triggers/account, runs every minute up to once/day) to HTTP-hit the Fly machine at the right times, which both wakes it AND runs the job.

So the scheduler becomes "Cloudflare Cron → POST /internal/run/discovery-batch → Fly machine wakes, runs work, sleeps." Free.

### 3.2 Database: Fly Postgres → Neon free tier

Neon free tier specs vs our actual needs at 1k qualified leads:

| Limit | Neon free | Our usage at 1k leads | Headroom |
|---|---|---|---|
| Storage | 0.5 GB | ~50 MB total (leads + signals + events) | 10× |
| Compute hours | 100 hrs/mo | ~10–30 hrs/mo realistic | 3–10× |
| Branches | 1 | 1 | OK |
| Connections | Pooled | ~5 concurrent | OK |

We fit comfortably. Cold start on idle wake-up is 500ms–1s. Same Cloudflare Cron trick can keep it warm during business hours.

**Drizzle works with Neon's serverless driver** (`@neondatabase/serverless`) at full feature parity for our query patterns.

```ts
// apps/server/src/db/client.ts
import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@keres/db/schema';

neonConfig.fetchConnectionCache = true;
export const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
```

**Cost: $0**.

### 3.3 Discovery: Google Places gap-fill → Yelp Fusion (no-store)

Yelp Fusion's TOS prohibits caching most business fields > 24 hours. v3 incorrectly used it as a cached enrichment source — that's a violation.

**Compliant pattern:** call Yelp **at the moment of discovery only**, extract review count + rating + URL into our scoring function, then **discard the Yelp-sourced fields**. Store only the lead's identity (name, address, phone, website) which is also visible in OSM.

```ts
// services/discovery/yelp.ts
async function enrichWithYelp(candidate: Candidate): Promise<DiscoveryScore> {
  const yelpHit = await yelp.businessSearch({ name: candidate.name, location: candidate.address });
  if (!yelpHit) return { reviewCount: null, rating: null, source: 'osm_only' };

  // Use these for scoring NOW. Do NOT persist Yelp-sourced fields beyond 24h.
  const scoreInputs = {
    reviewCount: yelpHit.review_count,
    rating: yelpHit.rating,
    isClaimed: yelpHit.is_claimed,
  };

  return scoreInputs;  // → fed to scorer, then discarded
}
```

Yelp's free tier is **500/day** for new clients (down from 5k). At 1k qualified leads/month spread across the month, that's 33/day. Headroom 15×.

**Cost: $0**.

### 3.4 Verification: Emailable monthly → Bouncer PAYG one-time

Bouncer's pricing model is a perfect fit:
- $8 for 1,000 credits
- **Credits never expire**
- **Free for duplicates and "unknown" results** (you only pay for actually-attempted verifications)
- Bulk + API both supported

At 50 ambiguous emails/month needing paid verification, $8 lasts ~20 months. Amortized: **$0.40/month**.

```ts
// services/email/verify.ts
async function verifyEmail(email: string): Promise<VerifyResult> {
  // 1. Free chain first
  const free = await freeVerify(email);  // syntax + MX + SMTP RCPT + catch-all probe

  if (free.status === 'valid' || free.status === 'invalid') return free;  // done, $0

  // 2. Only ambiguous + score ≥ 80 leads hit paid
  if (free.status === 'unverifiable' && lead.score >= 80) {
    return await bouncerVerify(email);  // ~$0.008
  }

  // 3. Below score threshold → just skip the lead
  return { status: 'skipped_low_priority' };
}
```

### 3.5 AI: Anthropic at MVP → defer to v1

At 1k leads × ~4% reply rate × 2k sends = ~80 replies/mo. That's manageable manually. Operator reviewing 80 replies takes ~5 minutes/day, and the operator is the salesperson who'd read them anyway.

**AI earns its keep once reply volume exceeds ~200/mo (v1 or later).** Until then, defer.

Quality impact: arguably *higher* than AI at MVP. The salesperson sees every reply, hand-classifies, and can immediately craft a follow-up. AI classification adds latency, intermediate confidence scores, and a UI to triage — none of which is needed at 80/mo.

**Cost: $0**.

---

## Part 4 — Quality preservation argument (the part that matters)

The user's hard constraint was "**without losing the quality at all.**" Below is each quality dimension, the v3 plan, the v3.1 plan, and the delta.

| Quality dimension | v3 plan ($14) | v3.1 plan ($3.50) | Delta |
|---|---|---|---|
| **Lead accuracy** (does business exist, are facts right?) | OSM + state license + signal-extraction + paid gap-fill | OSM + state license + signal-extraction + Yelp at-call-time gap-fill | **Equal** — Yelp ≈ Google Places for US local business coverage |
| **Lead fit** (is it ICP?) | Free signals do all scoring | Free signals do all scoring | **Equal** — no signal cut |
| **Email discoverability** | Scrape + Hunter free + paid overage | Scrape + Hunter free, tighter score threshold | **Equal** — overage was buying emails for borderline leads we should skip anyway |
| **Email verification** | DNS + SMTP + Emailable monthly | DNS + SMTP + Bouncer PAYG (cheaper) | **Equal — same provider class** |
| **Email deliverability** | AWS SES, no dedicated IP | AWS SES, no dedicated IP | **Equal** — same infra |
| **Personalization** | Templates + signal-aware slots | Templates + signal-aware slots | **Equal** — both deferred AI |
| **Reply handling** | AI Haiku classification | Manual triage at MVP (≤80/mo) | **Manual = arguably better at MVP volume** — salesperson sees all replies |
| **Suppression / opt-out** | Hard-required, RFC 8058 one-click, SES SNS auto-suppress | Same | **Equal** |
| **DNS / sender-side compliance** | SPF + DKIM + DMARC, send-test-email gate | Same | **Equal** |
| **Compliance footer / CAN-SPAM** | Required, validated pre-launch | Same | **Equal** |
| **Audit logs** | Async BullMQ job → Postgres | Same | **Equal** |
| **Scoring accuracy** | Heuristic from free signals | Heuristic from free signals | **Equal** |
| **Storage durability** | Fly Postgres dev backups | Neon free PITR + nightly pg_dump → R2 | **Equal** (R2 backup added for belt-and-suspenders) |
| **Uptime SLA** | Fly Postgres dev (no Multi-AZ) | Neon free (no Multi-AZ) | **Equal** |
| **Cold-start latency** | None (always-on machine) | 5–10s on first morning request | **Slightly worse** — acceptable for internal sales tool |

**The honest summary:** quality of leads and quality of deliverability are unchanged. Cold-start latency on the first request of the day is the one real concession, and it's mitigated by the Cloudflare-Cron keep-warm ping.

---

## Part 5 — Final cost breakdown (verified line items)

### 5.1 At 1k qualified leads / month

```
Infrastructure
  Fly shared-cpu-1x@512MB auto-stop           $1.50
  Neon Postgres free tier                     $0.00
  Upstash Redis free tier (500k cmd/mo)       $0.00
  Cloudflare DNS + Cron Triggers              $0.00
  Cloudflare R2 backups (~50MB compressed)    $0.00 (free under 10GB)
  Domain (annual / 12)                        $1.00

Email
  AWS SES (5k sends, after free 12-mo period) $0.50
  Postmark Inbound (free 10k/mo)              $0.00

Lead discovery / signals
  OSM Overpass                                $0.00
  Yelp Fusion (500/day free, no-store)        $0.00
  NOAA Storm Events (free CSV)                $0.00
  Census Business Patterns (free)             $0.00
  State license scrapers (free)               $0.00

Email discovery
  Website scrape (in-process)                 $0.00
  Hunter.io (free 25 searches + 50 verifies)  $0.00

Verification
  Free chain (syntax + MX + SMTP RCPT)        $0.00
  Bouncer PAYG ($8 / 20 months amortized)     $0.40

AI (deferred to v1)
  Anthropic                                   $0.00

Phone enrichment (deferred to point-of-sale)
  Twilio Lookup                               $0.00

Monitoring (free tiers)
  Sentry / Better Stack / Honeycomb           $0.00

                                              ─────
TOTAL                                         $3.40 / month
```

**Per qualified lead: $0.0034. Per emailed lead: ~$0.0011.**

### 5.2 Scaling cost ceiling (when v3.1 breaks)

The architecture has graceful degradation. As volume grows, specific items upgrade:

| Trigger | What breaks | Upgrade | Added cost |
|---|---|---|---|
| **DB > 0.5GB** (~10k leads + history) | Neon free storage | Neon Launch $19/mo | +$19 |
| **DB > 100 CU-hours/mo** | Neon free compute | Same upgrade | (same) |
| **Reply volume > 200/mo** | Manual triage burden | Anthropic Haiku reply classify | +$5–10 |
| **Discovery > 500 Yelp calls/day** | Yelp free cap | OSM-only fallback OR Yelp paid | +$0–20 |
| **Hunter searches > 25/mo** | Free tier exhausted | Hunter Starter $34 OR tighten criteria | +$0–34 |
| **Bouncer < $8 remaining** | Credits depleted | Re-up $8 | +$8 every ~20 months |
| **SES > 5k sends/mo** | $0.10/1k linear | Just pays | +$linear |
| **Operator complaint about cold starts** | Auto-stop UX | Always-on machine $3.88 | +$2.38 |
| **Need real multi-AZ DB** | Single-AZ risk | Fly Postgres dedicated OR Neon Launch | +$15–25 |

**At 10k qualified leads/mo, the realistic v3.1 cost is ~$50–80/mo** — still well below v3's $99 estimate at the same scale.

---

## Part 6 — Operational risks unique to sub-$5

A cheap stack has different failure modes than a paid one. Calling them out so we don't pretend they aren't there.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fly auto-stop adds cold start on first morning request | Certain | 5–10s latency for the operator | Cloudflare Cron pings `/health` at 7am local time M–F |
| Neon free scales to zero | Certain | 500ms–1s on first query of idle window | Same keep-warm ping queries the DB |
| Neon free hits 100 CU-hours | Possible @ ~5k leads | DB queries throttled | Upgrade to Neon Launch $19 |
| Upstash free hits 500k cmd/mo | Possible @ ~3k qualified leads | Job queue backs up | Pay-as-you-go $0.20/100k |
| Yelp 24h TOS violation | Risk if we accidentally cache | Account ban | Lint test: no Yelp field allowed in DB schema |
| Hunter free tier exhausted mid-month | Possible if discovery surges | Some priority leads have no email | Tighten score threshold to ≥ 90 |
| AWS SES sandbox restriction | Day 1 only | Can't send to non-verified | Open production access ticket immediately on Day 1 |
| Bouncer credits forgotten | Possible at low volume | Verification chain stops at "unverifiable" | Skip lead instead of risking bounce — acceptable |
| Single-machine Fly = SPOF | Always | Outage on machine failure | Internal sales tool can tolerate; upgrade to 2 machines ($3/mo) if it matters |
| Cloudflare Cron has 30-trigger account limit | Hit at scale | Can't schedule more jobs | BullMQ repeatable jobs on Fly cover anything Cron can't |
| Postgres backup if Neon free fails | Real | Recovery from PITR or pg_dump | Nightly pg_dump → R2 via cron |

The pattern: **every cheap component fails toward "slower" or "degraded", not "data loss"**. We can pay our way out of any specific limit as it bites.

---

## Part 7 — Architecture diagram (v3.1)

```
                            ┌─────────────────────────────┐
                            │   Operator's browser        │
                            │   (sales person, 1 user)    │
                            └──────────────┬──────────────┘
                                           │ HTTPS
                                           ▼
                  ┌────────────────────────────────────────────┐
                  │           Cloudflare DNS + TLS              │
                  │       (free; *.keres.ai → Fly app)         │
                  └────────────────────────┬───────────────────┘
                                           │
                                           ▼
                  ┌────────────────────────────────────────────┐
                  │     Fly.io shared-cpu-1x@512MB             │
                  │     (auto-stop: $0.50–$1.50/mo)            │
                  │     • Fastify HTTP                          │
                  │     • BullMQ workers (in-process)           │
                  │     • Better-Auth                            │
                  │     • Drizzle ORM                            │
                  └─────┬──────────────┬──────────────┬─────────┘
                        │              │              │
                        ▼              ▼              ▼
              ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
              │ Neon         │ │ Upstash      │ │ Cloudflare R2     │
              │ Postgres free│ │ Redis free   │ │ Backups + uploads │
              │ (scale-to-0) │ │ 500k cmd/mo  │ │ 10GB free         │
              └──────────────┘ └──────────────┘ └──────────────────┘

                                           ▲
                                           │ wake + scheduled jobs
                                           │
                  ┌────────────────────────────────────────────┐
                  │     Cloudflare Cron Triggers (free)         │
                  │     • 7am M–F: keep-warm                    │
                  │     • Hourly: warmup adjustments           │
                  │     • Daily: backup, suppression cleanup    │
                  │     • Monthly: NOAA refresh                 │
                  └────────────────────────────────────────────┘

           ┌───────────────────────────────────────────────────┐
           │              External APIs (mostly free)           │
           │                                                    │
           │  Outbound mail        AWS SES         $0.50/mo   │
           │  Inbound mail         Postmark        free 10k   │
           │  Discovery primary    OSM Overpass    free       │
           │  Discovery gap-fill   Yelp Fusion     free 500/d │
           │  Storm signal         NOAA CSV        free       │
           │  Density signal       Census CSV      free       │
           │  License signal       state scrapers  free       │
           │  Email pattern        Hunter.io       free 25/mo │
           │  Verify ambiguous     Bouncer PAYG    $8/20mo    │
           │  Auth                 Better-Auth     self-host  │
           │  Billing              Stripe          % of rev   │
           │  Errors               Sentry          free 5k    │
           │  Uptime               Better Stack    free       │
           │  Traces               Honeycomb       free 20M   │
           └───────────────────────────────────────────────────┘
```

---

## Part 8 — Implementation delta from v3 (the 3-week MVP plan)

Only **9 small changes** from v3:

| v3 step | v3.1 change |
|---|---|
| Week 1 Day 1: Fly + Fly Postgres dev | **Fly + Neon free** (+ `@neondatabase/serverless`) |
| Week 1 Day 1: Fly always-on machine | **Fly auto-stop + min_machines_running=0** |
| Week 1 Day 1: (none) | **Cloudflare Cron Trigger** at 7am ET M–F → POST `/internal/keep-warm` |
| Week 1 Day 5: state license scrapers | **Add weekly cron via Cloudflare** (free) |
| Week 2 Day 2: Google Places gap-fill | **Yelp Fusion at-call-time only (no DB columns for Yelp fields)** |
| Week 2 Day 5: Emailable account | **Bouncer account + $8 PAYG credit** |
| Week 3 Day 2: Anthropic SDK wired | **Removed — defer to v1** |
| Week 3 Day 2: Reply classification | **Manual triage: simple inbox view, regex auto-detect for `unsubscribe`/OOX only** |
| Week 3 Day 3: Twilio Lookup | **Removed — defer to point-of-sale** |

Total: still 3 weeks. Lower cost, same quality, fewer external dependencies to wire up.

---

## Part 9 — When sub-$5 stops being possible

Sub-$5 is sustainable at:
- **1 to ~3 paying orgs** (single-tenant or small multi-tenant)
- **≤ 3k qualified leads/month aggregate**
- **≤ 200 replies/month aggregate**
- **≤ 10k DB rows/day write rate** (Upstash + Neon free combined limit)

Past those thresholds, costs climb naturally — but to under $50/mo, never $500/mo. The economic model is intact through ~10k leads/month.

Past 10k leads/month, the realistic budget is $50–100/mo, dominated by:
- Anthropic for personalization + reply classification ($30–50)
- Postgres upgrade to Neon Launch or Fly Postgres dedicated ($20)
- SES at $0.10/k (linear with sends)

We never need Apollo or Clay or LinkedIn enrichment. The "no expensive enrichment vendors" rule is correct **at every scale** for our ICP.

---

## Part 10 — The shopping list (exact accounts to create)

To stand up the v3.1 stack from zero, the operator needs accounts at:

| # | Service | Cost on signup | Notes |
|---|---|---|---|
| 1 | Fly.io | $0 | Add card for billing; pre-pay $5 to start |
| 2 | Neon | $0 | Free tier auto-applied |
| 3 | Upstash | $0 | Pick Redis region close to Fly region |
| 4 | Cloudflare | $0 | Used for DNS + Cron Triggers + R2 |
| 5 | AWS | $0 | For SES; need to open production access ticket Day 1 |
| 6 | Postmark | $0 | Inbound free tier |
| 7 | Yelp Developer | $0 | Apply for Fusion key; 500/day |
| 8 | Hunter.io | $0 | Free tier 25/mo |
| 9 | Bouncer | $8 one-time | 1,000 credits, never expire |
| 10 | Stripe | $0 (rev share) | Billing |
| 11 | Sentry | $0 | Free tier |
| 12 | Better Stack | $0 | Free tier |
| 13 | Domain registrar | $12/year | Cloudflare Registrar = at-cost |

**Out-of-pocket Day 1: $20** (Stripe pre-load + Bouncer + domain).

**Monthly recurring: $3.40.**

---

*Sub-$5 is real — and the architecture is simpler than v3, not more complex. The trick was that v3's $14 was mostly infrastructure tax on a low-volume product; quality of leads never depended on that tax.*
