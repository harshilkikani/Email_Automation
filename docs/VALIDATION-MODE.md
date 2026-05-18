# Validation Mode — operator playbook

> The product implementation of `VALIDATION-PLAN.md`. Four phases over 30 days. Each phase has a kill criterion.

## Phase 0 — Eyeball (1 hour, $0)

**Goal:** Confirm the top-scored leads look like real buyers when a human reviews them.

1. Navigate **Validation → New experiment**.
2. Phase = `eyeball`, niche = `Septic` (recommended starting niche), cities = `Houston, Tampa, Atlanta`.
3. Click **Create experiment**.
4. The page lists the top 50 leads (highest score first). For each, click one of:
   - **A** — Clear buyer-fit. Real business, accurate signals, would pitch.
   - **B** — Probably real, some signals questionable but worth contacting.
   - **C** — Signals wrong (defunct, mis-tagged niche, residential, franchise).
   - **D** — Not a real business / spam / compliance risk.
5. The verdict updates live:
   - ≥ 70% A+B → **pass** (proceed to Reach).
   - 50–69% A+B → **tune** (look at C/D reasons; adjust scoring weights via signal-outcome matrix later, or add hard filters).
   - < 50% A+B → **stop** (major scoring problem; don't send).

**What to look for in C/D ratings:**
- Closed/defunct → license signal missing or stale; OSM data outdated.
- Franchise → add to `FRANCHISE_NAME_PATTERNS` in `packages/core/src/filters.ts`.
- Residential → add address-type filter.
- Wrong niche → OSM tag interpretation wrong; refine `NICHE_TO_OSM` in `packages/providers/src/osm.ts`.
- Tiny one-person operation → **possibly a feature**, not a bug. These are the deepest buyers.

## Phase 1 — Reach test (1 week, ~$0.50)

**Goal:** Confirm emails arrive in inbox (≥ 80%), bounce rate < 5%.

1. From the Eyeball verdict page: change phase to `reach`, click **Build stratified campaign**.
2. The system creates a campaign with 100 recipients:
   - Top (80–100): 40
   - Mid (60–79): 30
   - Bottom (40–59): 20
   - Control (20–39): 10
   - Seedlist mailboxes inserted automatically (from `SEEDLIST_EMAILS` env).
3. Launch the campaign. The compliance gate blocks send if:
   - DNS not all-green
   - SES production access not confirmed
   - Physical address missing
   - Bounce/complaint thresholds exceeded
4. Watch the dashboard. Daily, check your seedlist mailboxes (Gmail, Outlook, plus one custom-domain) and report inbox placement.

**Kill criteria:**
- Inbox placement < 70% → **fix_dns** verdict. Pause. Re-run DNS check. Wait 24h after fixes before resuming.
- Bounce rate > 8% → **fix_verification** verdict. Pause. Tighten email discovery (more Bouncer, or higher score threshold for Hunter).
- 0 replies after 50 sends → **audit_copy** verdict. Pause and review template + sender identity.

## Phase 2 — Engagement test (2 weeks, ~$2)

**Goal:** Confirm the score predicts reply rate.

1. From the experiment: change phase to `engagement`, click **Build stratified campaign**.
2. 500 recipients:
   - Top: 200, Mid: 150, Bottom: 100, Control: 50.
3. Launch. The send pipeline rate-limits to `send_speed_per_min` and per-domain caps. Auto-pauses on threshold breaches.

**Target metrics:**
- Top bucket reply rate ≥ 5%
- Top-mid gap ≥ 3 percentage points
- Qualified reply % (interested + conditional + referral / total replies) ≥ 30%
- Bounce rate < 3%

**Verdicts:**
- `scale` — all targets met. Proceed to Refine.
- `no_lift` — top reply ≥ 5% but gap < 3pp. Scoring doesn't differentiate buyers. Either drop scoring or find new signals.
- `icp_broken` — top reply < 3%. Targeting hypothesis is wrong. Switch niche or city.
- `junk_replies` — qualified % < 20%. Copy is misleading or niche fit is poor.
- `paused` — bounce > 5%. List quality degraded.

## Phase 3 — Refine (1 week, ~$1.50)

**Goal:** Iterate scoring weights based on observed outcomes.

The product builds the signal-outcome matrix from `email_events` + `inbound_messages` for the engagement campaign:

```
P(reply | signal=true)  vs  P(reply | signal=false)
P(qualified | signal=true)  vs  P(qualified | signal=false)
```

The frontend lists each signal with its observed lift. Click **Apply** on a proposed weight delta — the system creates a new `scoring_versions` row capped at ±30% per weight (per the validation-plan rules).

Then run a confirmatory 200–400-send campaign with the new weights. If top reply holds or improves, the new version is "confirmed." If it drops, roll back.

## End-of-month verdict

Walk out with one of:
- **VALIDATED** — scoring predictive + at least one demo booked. Scaffold the rest of the v3.1 stack and scale.
- **scoring-not-predictive** — top-mid gap < 3pp. Either drop scoring entirely (send to everyone above qualified threshold) or hunt for new signals.
- **ICP-broken** — top reply < 3%. Targeting is wrong. Try a different niche or metro.

## Anti-patterns to avoid (from the plan)

- "Friendly first 10 sends to people I know." Replies because they like you. Useless signal.
- A/B testing copy in week 1. You don't have a baseline yet.
- Iterating scoring weights after 50 sends. Need 500+ outcomes.
- Adding AI personalization during the experiment. Adds a confound.
- Switching cities mid-test. Pick one combo, run it, then try another.
- Quitting at Day 14 because results look soft. Day 14 is statistically too early.

The product enforces none of these — operator discipline matters.
