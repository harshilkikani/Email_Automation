# Runbook

> Operator playbook for day-to-day operations of a running Keres AI deployment.

## Daily

### Morning (first thing)
1. Open the dashboard. Check **Last 24h** numbers — sent, delivered, bounced, complained, replied.
2. Open **Inbox**. Triage replies in this order:
   - `interested` → reply within the hour with a calendar link
   - `conditional` → reply with a "happy to circle back in 30 days" note + add a follow-up to your calendar
   - `wrong_person` / `referral` → forward to the named person
   - `not_interested_polite` → no reply; system already moved the lead to suppression-eligible
   - `not_interested_hostile` → system already suppressed; nothing more to do
   - `objection` → record the competitor mention (search the body for the named tool)
3. Check the **Costs** page. If a paid provider is approaching its monthly budget, investigate before it auto-blocks.

### Mid-day
1. Run **Find Leads** for tomorrow's batch. Aim for ~25–50 fresh leads per niche per day.
2. If a campaign is in `paused` state, read the `pauseReason`. Common reasons:
   - `bounce_rate_high` → audit the affected campaign in the Leads view; the bad emails are usually scraped from a small set of dead websites
   - `daily_cap_exceeded` → no action; it resumes tomorrow
   - `complaint_rate_high` → **STOP**. Audit the audience. Did you accidentally include a list you shouldn't have?

### Evening
1. Confirm no pending blockers on the Deliverability page (all four tiles green).
2. Sanity-check tomorrow's queued recipients in the campaign drawer.

## Weekly

### Monday
1. Re-run DNS check (Deliverability → Check DNS) on all sender domains. SPF/DKIM rotation issues can take down deliverability silently.
2. Review the **Suppression** list. Look for unexpected hostile replies — they often signal a copy or targeting issue.

### Wednesday
1. Spot-check 10 lead-drawer "why score" panels. Are the signals firing as expected?
2. Skim 10 random rendered emails in **Campaigns → preview**. Look for unresolved tokens or off-key phrasing.

### Friday
1. Export current campaign metrics for the week. The Validation page surfaces top-bucket vs mid-bucket reply rates — confirm the gap is holding.

## Monthly

1. Re-run the validation experiment to confirm scoring is still predictive.
2. Refresh NOAA Storm Events cache (the cron handles this; check it ran).
3. Review **Costs** page year-over-year. Look for SES growth — at ~5k sends/mo the SES bill is $0.50; at 30k it's $3.

## Incident response

### "Campaign auto-paused at bounce_rate_high"
1. Open the campaign. Read which recipients bounced (state = `bounced`).
2. Compare against the lead source — usually one bad scrape batch.
3. Suppress the bad domains, mark the campaign Resume.

### "Campaign auto-paused at complaint_rate_high"
1. **Don't resume yet.** Even one complaint per 1k is the SES hard threshold.
2. Pull the complaint event from `email_events` and identify the recipient.
3. If it was a clear false positive (e.g. tested in a personal inbox), suppress and continue.
4. If it's a genuine "this looks like spam" reaction, audit the template/targeting end-to-end.

### "Web shows offline"
1. Visit `/api/health` directly. If it returns OK, the proxy is misconfigured.
2. If it doesn't, the Fly machine is asleep. Hit `https://<host>/api/health` directly to wake it (5–10s cold start).
3. If it stays offline, check Fly logs: `flyctl logs -a keres-ops`.

### "SES SNS subscription expired"
1. SNS will resend a `SubscriptionConfirmation` to our webhook. Our handler returns the `subscribeUrl` in its response — copy/paste it into a browser to confirm.
2. Alternatively, confirm via the AWS SNS console.

### "All emails landing in spam suddenly"
1. Run DNS check. If anything turned red, fix that first.
2. Check the SES reputation dashboard. If complaint rate ticked above 0.1%, you're in the "review" state — pause sending entirely for 48 hours and audit.
3. If reputation is fine but placement still bad, your sender domain is being throttled. Reduce daily cap to 10/day for a week to recover.

### "Bouncer credits exhausted"
1. Open the Costs page. Confirm Bouncer MTD spend is at the configured `BOUNCER_MONTHLY_BUDGET_USD` ceiling.
2. Either raise the ceiling in `.env` (and Fly secrets) — $8 buys ~1000 more credits — or wait for the new month.
3. Until then, the verifier returns `unknown` and the send pipeline skips those leads instead of risking a bounce.

## Anti-patterns to refuse

- "Let me bypass the gate just this once." No. Every gate exists to protect sender reputation.
- "Let's send the full list to seedlist first." Seedlist is for inbox-placement spot-checks, not for bulk testing.
- "Let's add open tracking just to see." No. Apple MPP makes the data noise and you'll over-react to fake "opens."
- "Let me re-verify emails older than 60 days inline." No. Re-verify only at the 30-day boundary, and only the score-≥80 priority pool.

## Where things live

| Concern | File |
|---|---|
| Scoring weights | `packages/core/src/scoring.ts` |
| Hard filters | `packages/core/src/filters.ts` |
| Templates | `packages/core/src/templates.ts` |
| Cost guards | `packages/core/src/budget.ts` |
| Email renderer | `packages/email/src/render.ts` |
| RFC 8058 headers | `packages/email/src/headers.ts` |
| Unsubscribe tokens | `packages/email/src/unsubscribe.ts` |
| Reply classifier | `packages/core/src/reply-classifier.ts` |
| Send pipeline | `apps/server/src/services/sender-pipeline.ts` |
| Compliance gates | `apps/server/src/services/gates.ts` |
| Discovery service | `apps/server/src/services/discovery.ts` |
| SES SNS parser | `packages/providers/src/ses-events.ts` |
| Inbound parser | `packages/providers/src/inbound.ts` |
