# Operations checklist

## Daily

- [ ] Open `/inbox`. Triage replies (`j/k` to navigate; `i/c/o/n/h/w/r/u` to classify; `b` = booked demo; `s` = suppress email; `d` = suppress domain).
- [ ] Open `/diagnostics`. Every check green; if any red, fix before proceeding.
- [ ] Open `/provider-usage`. Confirm no provider near its monthly cap.

## Weekly

- [ ] Re-run `/deliverability → Check DNS` for each sender domain. Rotate DKIM if AWS asks.
- [ ] Inspect `/suppression`. Investigate unexpected hostile replies.
- [ ] Skim `/validation` signal-outcome to see if scoring still predicts.
- [ ] Send a seedlist test to your controlled mailboxes; record placement.

## Monthly

- [ ] Re-run the eyeball validation experiment to confirm scoring still surfaces real buyers.
- [ ] NOAA storm-zone cache should have refreshed (Cloudflare cron).
- [ ] Audit `/audit` for any unexpected actions.
- [ ] Review `/provider-usage` MTD. If Bouncer < $1, top up ($8 buys ~1000 more credits).
- [ ] Confirm `pnpm doctor` is still clean (run from any CI environment).

## Before any production send

- [ ] `pnpm doctor` passes.
- [ ] `/api/diagnostics` reports `ok: true`.
- [ ] `/api/campaigns/:id/launch-gate` reports `ok: true` for the campaign.
- [ ] Seedlist test passed within the last 7 days.
- [ ] Placement ≥ 80% primary in the last 7 days.

## "Do not launch if" — hard stops

- SAMPLE_MODE=true (you're in dev mode — go to `/diagnostics`).
- SES production access not confirmed.
- Any one of SPF / DKIM / DMARC red.
- Unsubscribe endpoint not reachable.
- Daily send cap exceeded for the sender domain.
- 24h bounce rate ≥ 4%.
- 24h complaint rate ≥ 0.1%.
- Bouncer / Hunter monthly budget exhausted (paid lookups will fail closed; non-blocking unless explicitly required by your config).
- Validation experiment kill criteria triggered.

## Incident: campaign auto-paused

1. Open the campaign. Read `pauseReason`.
2. If bounce-rate-high → identify the dead-list source via `/leads` filter on `bounced`; suppress affected domains via `POST /api/suppressions/bulk`.
3. If complaint-rate-high → STOP. Even one complaint per 1000 sends is the SES hard threshold. Audit copy + audience before resuming.
4. Resume only after audit: `/campaigns/:id/resume`.

## Incident: webhook fails

1. SES SNS subscription expired → SES will re-post `SubscriptionConfirmation`. Our handler echoes the `SubscribeURL` in the JSON response. Hit it once in a browser to confirm.
2. Postmark inbound webhook 401s → re-check `POSTMARK_INBOUND_USERNAME/PASSWORD` or `POSTMARK_INBOUND_TOKEN`.
3. SES SNS signature verification fails → check the `SigningCertURL` host is `sns.<region>.amazonaws.com`. If it isn't, the message is forged and the rejection is correct.

## Backup / restore

- Neon free tier offers point-in-time-recovery within the free retention window.
- For belt-and-suspenders: schedule a nightly `pg_dump | gzip` to Cloudflare R2 via a Cloudflare Worker cron + Neon's `pg_dump`. Document the bucket in this checklist when you wire it.

## Cost guardrails

| Provider | Monthly cap | Where set |
|---|---|---|
| Bouncer | $5 (~625 credits) | `BOUNCER_MONTHLY_BUDGET_USD` |
| Hunter | 50 free credits | `HUNTER_MONTHLY_FREE_CREDITS` |
| Yelp | 0 (free tier only) | `YELP_MONTHLY_BUDGET_USD` |
| Places | 0 (disabled) | `PLACES_MONTHLY_BUDGET_USD` |
| SES | linear $0.10/1k | (no cap — billed by AWS) |

If any cap is reached, paid lookups fail-closed and the lead is recorded with `email_verification_status='skipped'` rather than risking a bounce.

## When to upgrade

| Trigger | Upgrade | Cost |
|---|---|---|
| DB > 0.5 GB | Neon Launch | +$19/mo |
| Replies > 200/mo | Claude Haiku reply classification | +$5-10/mo |
| Daily SES > 1k | Consider dedicated IP | +$24.95/mo (review needed) |
| Operator complains about cold start | Always-on Fly | +$2.38/mo |
