# Keres AI — Validation Plan

> **The premise.** Before scaffolding code, prove the scoring engine actually surfaces businesses that buy AI receptionists. The risk we're guarding against: building a beautiful pipeline that produces technically-impressive lead lists no one converts on.
>
> **The methodology.** Three sequential tests, each cheaper than the next stage to repeat: **eyeball → reach → engagement**. Each test has a kill criterion. If a test fails, we re-tune scoring *before* scaling — not after spending a month sending the wrong people the wrong emails.
>
> **The output.** After 30 days you have either a defensible answer "scoring predicts buyers, here's the data" or a clear "scoring needs N specific changes." Either way, no wasted infrastructure.

---

## Part 1 — The validation methodology in one diagram

```
   Day 0          Day 1-7            Day 8-21              Day 22-30
   ─────          ───────            ────────              ────────
   EYEBALL  →     REACH       →     ENGAGEMENT     →      REFINE
   (0 sent)       (~100 sent)        (~500 sent)           (~400 sent)

   "Does the      "Do emails         "Do high-score        "Update weights
    list look     arrive in          leads reply           from outcomes;
    like real     inboxes?"          more than low-        re-test."
    buyers?"                         score ones?"

   Cost:  $0      Cost: ~$0.50       Cost: ~$2            Cost: ~$1.50
   Time:  1 hr    Time: 1 wk         Time: 2 wks          Time: 1 wk

   ↓ kill if      ↓ kill if          ↓ kill if            ↓ proceed to
   <60% A+B       inbox <70%         top-bucket reply     scaling if all
   rated          OR bounce >5%      <3% OR no gap        green
                                     vs mid bucket
```

The whole plan: **~1,000 total sends, ~$5 spend, 30 days, one human operator.** No code-side scaling, no second engineer, no growth marketing budget.

---

## Part 2 — Day 0: The eyeball test (1 hour, $0)

Before sending a single email, prove the score-100 leads look like real buyers when a human looks at them.

### 2.1 Pull 50 top-scored leads

From your first target market combo (Part 7 of this doc — start with **Septic, Houston TX**), run the OSM Overpass discovery + scoring once, take the top 50 by score.

### 2.2 For each lead, run a 60-second check

| Check | What to look for | Pass / fail |
|---|---|---|
| Search business name on Google | Real, currently operating result on page 1 | Pass = real |
| Click their website (if any) | Loads, looks current (any update in last 2 years) | Pass = active web presence; if scored "no_website" but a site loads → false positive |
| Look at their Google Business Profile | Exists, has recent reviews (any in last 90 days), hours posted | Pass = signal of active business |
| Look at their phone number | Has format that suggests a real business line (not a 1-800, not Google Voice routed) | Pass = direct phone |
| Open their address on Google Maps | Real location, looks like a business address (not residential, not a UPS Store) | Pass = real ops |
| Gut check: "Would I cold-call this person to pitch an AI receptionist?" | Yes / no with one-sentence reason | Pass = subjective buyer fit |

### 2.3 Rate each lead A/B/C/D

- **A** — Clear buyer-fit. Real business, signals accurate, you'd happily pitch them.
- **B** — Probably real, some signals questionable but worth contacting.
- **C** — Signals wrong somehow: defunct business, mis-tagged niche, residential address, or franchise location.
- **D** — Not a real business / spam / compliance risk (chain, govt entity, non-US, etc.).

### 2.4 Kill criterion

| Rating distribution in top 50 | Action |
|---|---|
| ≥ 70% A+B | **Pass.** Proceed to reach test. |
| 50–69% A+B | **Tune before testing.** Look at C/D leads — what false signal triggered the high score? Fix scoring weights or add a hard filter. |
| < 50% A+B | **Stop. Major scoring problem.** Do not send. Investigate before any send budget. |

### 2.5 What you're really looking for in C and D leads

These tell you which signals are noise. Tally the *reasons* leads got into C/D:

| C/D reason | What it tells you about the signal |
|---|---|
| Business is closed/defunct | License-status signal is missing or wrong; OSM data is stale |
| It's a franchise/chain | Niche-fit signal is too coarse; need "is_franchise" filter |
| Residential address | OSM has tagging errors; need address-type filter |
| Wrong niche | OSM tag interpretation is wrong; the candidate is a related-but-different niche |
| Has a website I didn't detect | HEAD-request false-negative; check redirect behavior |
| Tiny business < 1 person | Score too generous for one-person shops; *but this might be a FEATURE — they need a receptionist the most* |

The last row is the most important — **inspect carefully whether "tiny one-person operations" are actually our best buyers, not worst**. The pre-build assumption was yes. Day 0 is when you check.

---

## Part 3 — Day 1-7: The reach test (~100 sends, $0.50)

Now we send for the first time, with two objectives:
1. **Confirm emails arrive in primary inbox** (not spam folder).
2. **Confirm bounce rate is acceptable** on a freshly scraped list.

We do NOT yet care about reply rate.

### 3.1 Setup

- Pick **one** sender domain (e.g. `outreach.<yourbrand>.com`).
- Warm it minimally: send 10 emails/day for the prior 7 days to a personal seedlist (3-5 mailboxes you control on Gmail, Outlook, and a custom domain).
- Verify inbox placement on the seedlist: send a test, check each inbox manually. Primary or Promotions tab on Gmail = OK. Spam folder = stop and fix DNS.

### 3.2 The 100-send pilot — stratified across scores

Send to a **stratified random sample** to measure the score-prediction relationship:

| Bucket | Score range | Sample size |
|---|---|---|
| Top | 80–100 | 40 |
| Mid | 60–79 | 30 |
| Bottom | 40–59 | 20 |
| Control | 20–39 | 10 |

Total: 100 leads.

Why stratified: if we send only to top-bucket and get a 6% reply rate, we don't know if that's good. If top gets 6% and bottom gets 6%, the scoring is useless. **We need contrast.**

### 3.3 Email template for the pilot

Use one template per niche, no variants. Plain text. Signal-aware opener (no_website / storm_zone / default). Same subject line for every recipient in that niche.

Keep variables tight — we're testing **scoring**, not copy. Copy A/B testing comes later.

### 3.4 What to measure

| Metric | Target | If miss |
|---|---|---|
| Inbox placement on seedlist | ≥ 80% primary | Fix DNS (SPF/DKIM/DMARC) or warm longer before resuming |
| Bounce rate | < 5% | Likely email-discovery problem; tighten Hunter / verify chain |
| Complaint rate | 0% (sample too small to be meaningful but anything > 1 is alarm) | Pause; investigate per-recipient |
| Reply rate (any) | ≥ 1% across all buckets | If 0%, deliverability or template problem |
| Reply rate by bucket | Directional only at this volume | — |

### 3.5 Kill criterion

| Pilot result | Action |
|---|---|
| Inbox ≥ 80%, bounce < 5%, ≥ 1 reply | **Proceed to engagement test.** |
| Inbox < 70% | **Stop sending.** Spend a week fixing DNS + warming + subject lint before any more sends. |
| Bounce > 8% | **Stop sending.** Re-verify your email-discovery pipeline. Likely scraping bad addresses. |
| 0 replies after 7 days | **Audit copy + sender identity.** Not a scoring problem yet. |

### 3.6 The seedlist (high-leverage trick)

Have 3-5 mailboxes you control. Include them as recipient #1 in every batch. Open the email in each mailbox personally. You see:
- Whether it landed in Primary, Promotions, or Spam (Gmail labels).
- How the rendered email actually looks (line breaks, footer, unsub link).
- Whether the unsubscribe link actually works (click it and verify in your DB).

This catches 90% of rendering and deliverability problems without staring at logs.

---

## Part 4 — Day 8-21: The engagement test (~500 sends, $2)

Now we measure whether the score *predicts* reply rate, and what the replies tell us.

### 4.1 Send 500 with the same stratification (scaled up)

| Bucket | Score range | Sample size in this phase | Cumulative across pilot + phase |
|---|---|---|---|
| Top | 80–100 | 200 | 240 |
| Mid | 60–79 | 150 | 180 |
| Bottom | 40–59 | 100 | 120 |
| Control | 20–39 | 50 | 60 |

We expect:
- **Top bucket reply rate: 5–10%** (if scoring is working)
- **Mid bucket: 2–4%**
- **Bottom bucket: < 2%**
- **Control: ~0%**

If top ≥ 5% AND top-mid gap ≥ 3 percentage points, **scoring is predictive**. That's the validation we need.

### 4.2 Sample size math (why these numbers)

We want to detect a 3-percentage-point difference between 6% (top) and 3% (mid) reply rates with 80% statistical power and 95% confidence. The required sample per group:

```
n ≈ 16 × p̄(1-p̄) / δ² ≈ 16 × 0.045 × 0.955 / 0.0009 ≈ 760 per bucket
```

That's too expensive at MVP. So we accept lower power for directional signal:

- **240 in top bucket gives 60% power** to detect 6% vs 3%
- **Combined 240+180 = 420 across top+mid gives 80% power**

Translation: with ~500 sends, **we'll see a real difference if one exists, but a null result might still mean "not enough data"**. Plan for a possible repeat phase.

### 4.3 Reply classification taxonomy

For every reply, the operator hand-classifies (this is where AI lives in v1; at MVP it's you):

| Intent | What it looks like | Action |
|---|---|---|
| **interested** | "Tell me more", "what's the price?", "can we hop on a call?" | Book demo. **This is the gold signal.** |
| **conditional** | "We're booked but maybe Q4", "send info, no time now" | Nurture; follow up in 30d. |
| **objection** | "We already have a receptionist", "we use [competitor]" | Track competitor mentions. Discard. |
| **not_interested_polite** | "Thanks but no thanks" | Suppress. |
| **not_interested_hostile** | "Stop emailing", curse words | Suppress + DNC + flag. |
| **wrong_person** | "I'm not the owner — talk to X" | Forward; track referral. |
| **OOX / auto_reply** | Vacation responder | Ignore. |
| **referral** | "You should talk to my friend at Y company" | High-value; pursue. |
| **bounce / undeliverable** | Postmaster response | Suppress. |

Plot the distribution by score bucket. **Interested + Conditional + Referral** are the qualified pool.

### 4.4 What success looks like at end of Day 21

| Metric | Target | Stretch |
|---|---|---|
| Reply rate, top bucket | ≥ 5% | ≥ 8% |
| Reply rate gap, top vs mid | ≥ 3 pp | ≥ 5 pp |
| Qualified reply % (interested + conditional + referral / all replies) | ≥ 30% | ≥ 50% |
| Demos booked from replies | ≥ 3 | ≥ 8 |
| Bounce rate | < 3% | < 1.5% |
| Hostile replies | < 2% of all replies | 0 |

### 4.5 Kill criterion at Day 21

| Result | Action |
|---|---|
| Top reply ≥ 5% AND gap ≥ 3pp AND qualified % ≥ 30% | **Proceed to refine + scale.** |
| Top reply ≥ 5% AND gap < 3pp | **Scoring doesn't differentiate.** Either drop scoring entirely and send to everyone, OR find new predictive signals. |
| Top reply < 3% AND copy/deliverability fine | **ICP/niche fit may be wrong.** Switch verticals (see Part 8). |
| Qualified % < 20% | **The reply pool is junk.** Either copy is misleading or targeting is wrong niche. |
| Bounce > 5% mid-phase | **Pause.** List quality has degraded; tighten enrichment. |

---

## Part 5 — Day 22-30: Refine + repeat (~400 sends, $1.50)

We now have enough data to **iterate scoring** instead of guessing.

### 5.1 The signal-outcome matrix

Build a spreadsheet (literally — Google Sheets is fine):

| Lead ID | Niche | City | Score | no_website | social_only | storm_zone | license_active | review_velocity | has_phone | sent | bounced | replied | reply_intent | booked_demo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

One row per sent lead from Days 1-21. At this point you have ~600 rows.

### 5.2 Compute observed lift per signal

For each binary signal, compute:

```
P(reply | signal=true)  vs  P(reply | signal=false)
P(qualified | signal=true)  vs  P(qualified | signal=false)
```

Example output (hypothetical):

```
Signal              P(reply|true)  P(reply|false)  Lift
no_website          8.2%           3.1%            2.6×
social_only         6.4%           4.2%            1.5×
storm_zone          11.2%          4.5%            2.5×
license_active      5.8%           2.1%            2.8×
review_velocity ≤1  9.1%           3.8%            2.4×
has_online_booking  2.3%           6.1%            0.4×  (negative)
```

### 5.3 Iterate the scoring weights

Original (Part 9 / Appendix B of v3 doc):
```
no_website: +35, social_only: +28, license_active: +10, storm_zone: +15, ...
```

After data:
```
- If observed lift confirms direction → keep weight, fine-tune
- If observed lift contradicts (lift ≈ 1 or negative) → drop weight to 0
- If observed lift is much higher than expected → increase weight
```

Don't overfit. With 600 rows, weight changes should be moderate (max ±30% per signal). Run a confirmatory phase before treating a single signal change as proven.

### 5.4 Confirmatory phase (last week of Day 22-30)

Send 200-400 more with the updated scoring. Compare:
- Top bucket reply rate vs Days 8-21 top bucket
- Should be **equal or higher**, not lower

If lower → you overfit. Roll back.

### 5.5 The end-of-month verdict

You walk out of Day 30 with one of three outcomes:

| Outcome | What it means | Next step |
|---|---|---|
| **Scoring confirmed predictive + ≥1 paying customer or demo→close in pipeline** | Thesis validated; scale | Scaffold the v3.1 infrastructure; start week 1 of MVP build |
| **Scoring confirmed predictive + 0 closes** | Lead quality good, sales motion needs work | Don't scaffold yet; fix sales / pricing / demo before more leads |
| **Scoring not predictive (no top-mid gap)** | Targeting hypothesis flawed | Re-test with different niche/city; consider that ICP definition needs work |

---

## Part 6 — The metrics that matter (and don't)

### 6.1 In order of importance during validation

1. **Manual A-rating % of top-scored leads** — proves scoring isn't fantasy. Day 0.
2. **Inbox placement on seedlist** — proves emails actually arrive. Day 1-7.
3. **Bounce rate** — proves email discovery is good. Day 1-7.
4. **Reply rate, by score bucket** — proves scoring is predictive. Day 8-21.
5. **Qualified reply %** — proves replies are real buyers, not noise. Day 8-21.
6. **Demos booked from qualified replies** — proves the funnel works. Day 8-30.
7. **First close (or strong verbal commit)** — proves the whole thesis. Day 22-30.

### 6.2 What does NOT matter during validation

| Metric | Why ignore |
|---|---|
| Open rate | Apple MPP inflates this to ~70% regardless of engagement. Pure noise. |
| Click rate | Plaintext cold email has minimal links. No signal. |
| Unsubscribe rate | At MVP volume, 1-2 unsubs/100 sends is statistical noise. Worry only if > 3%. |
| Time-to-first-reply | Doesn't predict close rate. |
| LTV / churn / NPS / CAC payback period | Need months of customer data; not relevant in first 30 days. |
| Sender reputation score (SenderScore, Talos) | Not predictive at this volume; reputation builds slowly. |
| Domain authority / SEO metrics on the lead's website | Has zero bearing on whether they'll buy. |
| Lead's social media followers | Irrelevant to AI receptionist purchase. |
| MQL/SQL ratios | We don't have a marketing funnel yet; these terms don't apply. |

---

## Part 7 — Verticals: where to test first

Ranked by **fit × ease of finding × low competition for AI receptionist sales**:

### 7.1 Tier S — start here

| Niche | Why it wins |
|---|---|
| **Septic services** | After-hours emergencies dominate; missed call = same-day job lost to competitor; small operator-owned; minimal AI-receptionist sales-tool competition; OSM has decent coverage with `craft=septic_tank_cleaner` and similar; state license registries are clean. |

### 7.2 Tier A — test second

| Niche | Why it works |
|---|---|
| **Water / mold restoration** | 24/7 expectation; $5-25k average job; insurance-driven urgency; small ops; same pitch as septic. |
| **HVAC** | Large market; summer (cooling) and winter (heating) emergency demand; mix of small operators and franchise locations — target the small. |
| **Roofing** | Storm-driven; high job value ($8k+ for a re-roof); but **more competition** from existing lead-gen tools (PowerProfit, ServiceTitan etc.). |

### 7.3 Tier B — test third

| Niche | Why later |
|---|---|
| **Plumbing** | Similar to HVAC but more saturated with national-franchise leads (Roto-Rooter, Mr. Rooter). Local small ops harder to find. |
| **Pest control** | Recurring-revenue model; less emergency-driven; lower fit but possible. |
| **Electrical** | Sometimes emergency, often scheduled; mixed fit. |

### 7.4 Tier C — defer or skip

| Niche | Why deprioritize |
|---|---|
| **Real estate agents** | Heavily over-targeted by lead-gen tools; agent ICP is bigger ops (teams) not solo agents. |
| **Restaurants / retail** | Walk-in-driven, not call-driven; AI receptionist doesn't solve their problem. |
| **Auto repair** | Phone-driven yes, but margin too low to justify $200+/mo SaaS. |
| **Salons / spas** | Already have online booking; have receptionists; low fit. |

### 7.5 Recommendation

**Start with Septic in 2-3 cities.** Why:
- Tightest ICP: every septic business is small, owner-operated, phone-driven.
- Cleanest signal validation: less noise from franchise/national/big-ops competitors.
- Best initial reply rates expected (least over-targeted by competitors).
- Easiest to interpret results — failures here mean methodology is wrong; failures in Roofing might just mean "too much competition."

---

## Part 8 — Cities: where to test first

### 8.1 Selection criteria

1. **Big enough to have 50–100 candidates per niche** (statistical relevance)
2. **Small enough to avoid national-franchise dominance**
3. **Storm-prone** (bonus for Roofer/Water-Mold)
4. **Geographically diverse** (catch geographic signal noise)
5. **You can plausibly travel there or know the area** (qualitative gut check matters)

### 8.2 Tier 1 — start here

| City | Why it wins |
|---|---|
| **Houston, TX** | Storm-prone; large; mix of urban and suburban service businesses; weak national-franchise grip in suburbs; large septic market (rural Harris County). |
| **Atlanta, GA** | Storm-prone; growing suburbs with many small operators; less franchise saturation than NYC/LA. |
| **Tampa, FL** | Year-round storm risk; high water-damage niche; smaller than Houston/Atlanta but rich in target businesses. |

### 8.3 Tier 2 — expand to

| City | Why useful |
|---|---|
| **Nashville, TN** | Growing fast; fewer mega-franchises; mid-sized metro = better small-op mix. |
| **Phoenix, AZ** | Large + dry — useful as **storm-signal control**: if storm-zone scoring matters, Phoenix-only sends will reply at *baseline* rates while Houston-during-storm replies will spike. |
| **Charlotte, NC** | Mid-sized; storm + Atlantic hurricane corridor. |
| **Indianapolis, IN** | Underserved geographically; lots of small-op HVAC. |

### 8.4 Cities NOT to start in

| City | Why avoid |
|---|---|
| **New York City** | National-franchise dominance; tiny operators don't show up well in public data; super-saturated with cold outreach already. |
| **Los Angeles** | Same. Plus weather doesn't drive demand for our top niches. |
| **San Francisco** | Tiny target market for these niches; high tech-savvy means high competitor saturation. |
| **Tiny rural cities (<50k)** | Sample size too small for statistical signal. |

### 8.5 Recommendation

**Houston (Septic) + Tampa (Septic) + Atlanta (Septic) for Day 0 eyeball test.** 50 leads from each = 150 candidates. Pick the top 50 across all three. Sufficient sample for an eyeball test; geographically diverse enough to catch city-specific noise.

---

## Part 9 — Signals: which ones to bet on

### 9.1 Likely to be predictive (use in initial scoring)

| Signal | Expected lift over base reply rate | Confidence |
|---|---|---|
| `web_presence_level = none` | **2.5–3×** | High — single biggest signal for our ICP |
| `web_presence_level = social_only` (Facebook page only) | 1.5–2× | High |
| `storm_zone = true` AND niche ∈ {Roofer, Water/Mold} (last 14 days) | 2–3× | Medium — time-sensitive |
| `license_status = active` (filter out defunct) | 2–3× | High — but mostly negative filter |
| `review_velocity_30d ≤ 1` | 1.5–2× | Medium — proxy for "not getting found online" |
| `niche × phone-present` | 1.5× | High — phone-driven business model is core ICP |
| `has_online_booking = false` | 1.5× | Medium — direct fit, but hard to detect cleanly |

### 9.2 Likely to be NOISE (don't waste scoring weight on these at MVP)

| Signal | Why it's probably noise |
|---|---|
| Census Business Patterns competitor density | Too coarse; doesn't predict individual buyer |
| NAICS density | Same |
| Domain age (from WHOIS) | Adversarial — old domains aren't more or less likely to buy |
| Email format (info@ vs first.last@) | Irrelevant for our pitch — both are valid for cold contact |
| Phone line type at intake (mobile vs landline) | Interesting but doesn't predict reply; matters only at sales close |
| Google review rating | High AND low both can be fits — high = busy, struggling to keep up; low = literally struggling. Doesn't differentiate. |
| Has-Facebook-page | Too common; ~70% of businesses have one |
| State license expiration proximity | Doesn't predict buying intent |
| Business name length / keyword density | Marketing-vanity signals; no commercial relevance |
| Industry seasonality | Already captured indirectly by `storm_zone` for our niches |

### 9.3 Worth measuring but don't score on yet

These are interesting to capture for analysis but **do not weight in scoring until you have 1000+ outcomes**:

- Time-of-day phone is listed as "open"
- Number of physical locations
- Co-located with other businesses (commercial vs standalone)
- Distance to nearest competitor
- Days-since-business-was-founded

After validation phase, you may discover one of these is predictive. Until then, capture-don't-score.

### 9.4 The data-driven update rule

After Day 21, for each currently-weighted signal:

```
if observed_lift < 1.2× → remove from scoring (it's noise)
if observed_lift ≥ 1.2× and < 2× → reduce weight to half
if observed_lift ≥ 2× → keep weight as is, or increase
if observed_lift < 1× (negative) → flip sign or remove
```

---

## Part 10 — Measuring "AI receptionist fit" and "operational pain"

These are abstractions. They need observable proxies.

### 10.1 AI receptionist fit — proxies, ranked

| Proxy | Why it indicates fit |
|---|---|
| **Phone-as-primary-channel** (no online booking, no email visible) | They literally need their phone answered |
| **Owner-operated** (single license, single location, mobile phone) | Decision-maker is the same person fielding calls = pain is real |
| **Service-dispatch model** (jobs are scheduled, not walk-in) | Missed call = lost dispatch |
| **Emergency-niche** (septic, water, HVAC) | After-hours calls = paid jobs |
| **Active license + no website** | Business in operation but no online presence = leads come through phone only |

Composite: a business with **all 5** is ICP-perfect. **4 of 5** is strong. **3 of 5** is worth testing. **< 3** likely poor fit.

### 10.2 Operational pain — proxies, ranked

Hard to measure without talking to them. Best proxies:

| Proxy | What it signals |
|---|---|
| **No website + Active license + Phone in listing** | They're in business and getting calls but can't allocate time to even build a website |
| **Single Google review in last 90 days** | Either no customer growth, OR not capturing reviews — both signal operational stretch |
| **Hours "by appointment" or "varies"** | They're reactive, can't commit to set hours = small operation |
| **One-person Yelp/Google listing** (no team page, owner is named operator) | One person doing everything |
| **Listing has been recently updated** (within last 6 months) | They care about their listing but haven't invested in a site = "I want presence but can't commit" |

### 10.3 The validation question that proves both

In your demo or reply follow-up, ask:

> "Out of curiosity, what happens at [business] when someone calls and nobody picks up? Voicemail? Forwarded to a cell? Something else?"

How they answer reveals everything:
- **"We just call them back when we can"** = strong fit, painful
- **"It goes to voicemail, my wife checks it"** = strong fit, family operation
- **"My answering service handles it"** = already paying for partial solution → expansion sale
- **"We never miss calls, we have a great team"** = no fit, move on
- **No clear answer / annoyed by question** = no fit

Track which answers correlate with closes. After 10-20 closes, you have a real qualification script.

---

## Part 11 — What success actually looks like at Day 30

A realistic 30-day picture if everything goes right:

```
Day 0  (1 hour, $0)
  ✓ 50 top-scored leads eyeballed across Septic in Houston + Tampa + Atlanta
  ✓ 36/50 = 72% rated A+B → scoring directionally correct
  ✓ Top noise patterns identified: 4 franchise locations (need is_franchise filter),
     3 residential addresses (need address-type filter)

Day 1-7  (1 week, $0.50)
  ✓ Sender domain set up, DNS green, warmed via personal seedlist
  ✓ 100 emails sent: 40 top, 30 mid, 20 bottom, 10 control
  ✓ Inbox placement on seedlist: 4/5 primary, 1/5 Promotions = 80% — acceptable
  ✓ Bounce rate: 3 of 100 = 3% — good
  ✓ Replies: 5 total (3 top, 1 mid, 1 bottom, 0 control)
  ✓ 1 OOX, 2 not-interested-polite, 2 interested

Day 8-21  (2 weeks, $2)
  ✓ 500 emails sent: 200 top, 150 mid, 100 bottom, 50 control
  ✓ Reply rates by bucket: top 7.0%, mid 4.0%, bottom 1.0%, control 0%
  ✓ Top-mid gap = 3.0 pp — meets minimum predictive threshold
  ✓ 38 total replies, 14 qualified (interested + conditional + referral)
  ✓ 4 demos booked, 1 verbal close (~$200/mo plan)
  ✓ Bounce rate: 11 of 500 = 2.2%, declining as enrichment tightens

Day 22-30  (1 week, $1.50)
  ✓ Spreadsheet analysis of 600 sends → outcomes
  ✓ Findings:
      - no_website lift confirmed (3.1×)
      - storm_zone × Roofer lift confirmed (only tested on a small sample,
        N=20, but directionally strong)
      - license_active lift confirmed
      - review_velocity signal weaker than expected (1.4× lift)
      - Census density signal: no lift (0.95×) → REMOVED from scoring
  ✓ Updated weights, confirmed via 200 more sends: top reply 7.5% (held)
  ✓ 2nd demo closed = $200/mo customer #2
  ✓ Pipeline: 6 demos booked, 2 closed, 3 in negotiation

End-of-month verdict: VALIDATED
  • Scoring predictive (3pp+ gap holds across two phases)
  • A-rating eyeball ≥ 70%
  • Bounce < 3%
  • Inbox placement ≥ 80%
  • 2 paying customers ≈ $400/mo revenue
  • Total spend (incl. infra): ~$8
  • CAC: ~$4 per paying customer

Ready to scaffold and scale.
```

### 11.1 What "not validated" looks like

If at Day 30 you have:
- Reply rate top bucket ≤ 3%
- OR top-mid gap < 2 pp
- OR 0 demos booked
- OR bounce > 5% even after tightening

Don't scale. Don't scaffold. Investigate:
1. Is the niche choice wrong? (Try a different vertical from Part 7.)
2. Is the city choice wrong? (Try a different metro.)
3. Is the copy fundamentally wrong? (Show 3 friends in the industry your email — does it sound like spam or like a peer?)
4. Is the ICP definition itself wrong? (Maybe AI receptionist isn't for solo operators; maybe it's for 5-20-person shops.)

Each is solvable in another 2-week test. The validation methodology is reusable.

---

## Part 12 — The cheap tools that make validation possible

You do not need to build a SaaS to run this validation. Most of it can be done with:

| Task | Tool | Cost |
|---|---|---|
| OSM Overpass queries | Their web interface or `curl` | $0 |
| State license lookups | Browser, 1 hour scraping per state | $0 |
| NOAA storm zone lookup | CSV downloaded once | $0 |
| Lead spreadsheet | Google Sheets | $0 |
| Scoring formula | Sheet column with weighted formula | $0 |
| Email sending | A Gmail account or your `outreach.yourdomain.com` mailbox with a tool like Mailmodo / Apollo's free tier / Instantly trial | $0–$30 |
| Reply tracking | Inbox + manual labels | $0 |
| Outcome analysis | Sheet pivot tables | $0 |

**You can validate Days 0-7 with literally a spreadsheet and a personal Gmail.** The whole Keres AI codebase exists to *automate* what you're validating manually here. Build it only after the manual version proves the thesis.

This is the most important point in the document.

---

## Part 13 — Anti-patterns to avoid during validation

Things that look like "validation" but aren't:

| Anti-pattern | Why it's broken |
|---|---|
| **"Friendly first 10 sends to people I know"** | They reply because they like you. Tells you nothing about cold-prospect behavior. |
| **A/B testing copy in Week 1** | You don't know your baseline yet. A/B requires a baseline. |
| **Sending to >200 leads in Week 1 because "we need volume"** | If deliverability is broken, you're burning your sender domain on noise. 100 sends is plenty for Week 1. |
| **Targeting whatever-niche-comes-up-first instead of Septic** | Niche selection IS the experiment. Pick deliberately. |
| **Measuring open rate as a success signal** | Apple MPP. Already mentioned. Critical. |
| **Iterating scoring weights after 50 sends** | Not enough data. Iterate at 500+ outcomes only. |
| **Adding AI personalization to "see if it helps reply rate"** | Adds confound; you won't know if change is from AI or noise. Hold copy constant. |
| **Switching cities mid-test** | Same. Pick one combo, run it, *then* try another. |
| **"Let me try LinkedIn DMs at the same time"** | Multi-channel attribution is hard. Validate one channel first. |
| **Quitting at Day 14 because results look soft** | Day 14 is statistically too early. Wait for Day 21. |
| **"Maybe the issue is we need a fancier subject line"** | Maybe. But far more likely the issue is targeting. Fix targeting first. |
| **Hiring an SDR to manually call leads instead of testing the email** | Different test. Different costs. Skip. |
| **"Let's also try a different demographic — what about HVAC?"** | Yes, but as a separate test phase, not concurrently. |

---

## Part 14 — Decision tree at Day 30

```
                     Day 30 results
                          │
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
       Top reply       Top reply      Top reply
       ≥ 5% AND        ≥ 5% AND       < 3%
       gap ≥ 3pp       gap < 3pp
            │             │              │
            ▼             ▼              ▼
       VALIDATED      "Scoring         "Targeting
       Build the       doesn't          is broken"
       infrastructure  differentiate"
                          │              │
                          ▼              ▼
                       Either:        Try:
                       a) Send to     a) Different
                          everyone       niche
                          (drop          (Part 7
                          scoring)       Tier S)
                       b) Find        b) Different
                          new            cities
                          signals        (Part 8
                          via            Tier 1)
                          regression  c) Different
                                         copy
                                         (peer review)
                                      d) Check ICP
                                         assumption
```

---

## Part 15 — The single line summary

**Send 1,000 stratified emails to Septic businesses in 3 cities over 30 days. Measure reply rate by score bucket. If top bucket ≥ 5% and top-mid gap ≥ 3 percentage points, scale. Otherwise iterate before any code.**

Everything else in this document supports that one sentence.

---

*Validate before scaffolding. The product is the prospect list, not the codebase.*
