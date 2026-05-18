# Cost model

> Locked target: **< $5/mo at 1k qualified leads/mo, ~$3.40 baseline.**

## Per-provider monthly burn at 1k qualified leads

```
Fixed infrastructure
  Fly shared-cpu-1x@512MB auto-stop ($0/idle, ~12 hrs awake)   $1.50
  Neon Postgres free                                            $0.00
  Cloudflare DNS + Cron Triggers                                $0.00
  Cloudflare R2 backups (~50MB compressed)                      $0.00
  Domain (annual ÷ 12)                                          $1.00

Outbound
  AWS SES — 5,000 sends/mo (after free 12-mo period)            $0.50

Inbound
  Postmark Inbound (free 10k/mo)                                $0.00

Discovery / signals
  OSM Overpass                                                  $0.00
  Yelp Fusion (free 500/day, no-store)                          $0.00
  NOAA Storm Events CSV                                         $0.00
  Census Business Patterns CSV                                  $0.00
  State license adapters                                        $0.00

Email discovery / verification
  Free verification chain (syntax + MX + role + disposable)     $0.00
  Hunter free 50 credits/mo (top-tier fallback only)            $0.00
  Bouncer PAYG ($8 / 20 months amortized)                       $0.40

AI (deferred)
  Anthropic — runtime per-lead AI                               $0.00

Phone enrichment (deferred to point-of-sale)
  Twilio Lookup                                                 $0.00
                                                              -----
TOTAL                                                          $3.40
```

**Per qualified lead: $0.0034. Per emailed lead: ~$0.0011.**

## Hard guardrails

Implemented in `packages/core/src/budget.ts`:

| Guardrail | Rule |
|---|---|
| Runtime AI | **Permanently disabled.** No Anthropic SDK in the server. |
| Hunter | Only when `score ≥ 95` AND scrape failed AND monthly free credits remaining. |
| Bouncer | Only when `score ≥ 80` AND free chain returned ambiguous AND monthly budget remaining. |
| Google Places | Disabled unless `ENABLE_PLACES=true`. Not present at MVP. |
| Twilio Lookup at intake | Permanently disabled. Deferred to post-reply. |

Tests in `packages/core/test/budget.test.ts` lock these rules into CI.

## Cost dashboard

`/api/metrics/costs` returns:
- Per-provider month-to-date spend (sum of `cost_events.cost_cents`).
- Forecasted monthly total (fixed infra + actual paid usage + SES extrapolation).

The Costs page renders both with a summary card.

## When the cost ceiling stretches

| Trigger | Upgrade | Added cost |
|---|---|---|
| DB > 0.5 GB (~10k leads + history) | Neon Launch | +$19/mo |
| Reply volume > 200/mo | Anthropic Haiku for reply classification | +$5–10/mo |
| Bouncer credits < $1 remaining | Re-up $8 | +$8 (lasts ~20 months) |
| SES > 5k sends/mo | $0.10/k extra | linear |
| Operator complains about cold starts | Fly always-on | +$2.38/mo |
| Need Multi-AZ DB | Neon Launch | +$19/mo |

## When the cost ceiling breaks

Past ~10k qualified leads/mo, realistic budget is $50–80/mo, dominated by:
- Anthropic for reply classification + follow-up drafts ($30–50).
- Postgres upgrade ($20).
- SES linear with sends.

We never need Apollo or Clay or LinkedIn enrichment. The "no expensive enrichment vendors" rule holds at every scale.
