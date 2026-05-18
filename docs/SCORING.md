# Scoring

> Deterministic, versioned, audit-trailed. No AI at intake.

## Inputs

```ts
interface ScoringInputs {
  niche: Niche;
  webPresenceLevel: 'none' | 'social_only' | 'gbp_only' | 'basic' | 'modern' | 'unknown';
  hasPhone: boolean;
  phoneLineType: 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown';
  hasOnlineBooking: boolean;
  isStormZone: boolean;
  licenseStatus: 'active' | 'expired' | 'suspended' | 'unknown';
  reviewCount30d: number | null;
  reviewRating: number | null;
  competitorDensity: number | null;
  ownerOperator: boolean;
  serviceDispatchModel: boolean;
  emergencyNiche: boolean;
  multiLocation: boolean;
  isFranchise: boolean;
  isResidentialAddress: boolean;
  deadDomain: boolean;
}
```

## Hard filters (short-circuit to score 0)

| Filter | Reason |
|---|---|
| `isFranchise` | Wrong ICP. |
| `isResidentialAddress` | Not a real business. |
| `!hasPhone` | Can't upsell an AI receptionist. |

Also applied at intake time (`packages/core/src/filters.ts::hardFilter`):
- Empty name
- UPS/mailbox-store address patterns
- Government / municipal / nonprofit name patterns
- Non-US state code

## Weights (v1)

```ts
webPresence:           { none: 35, social_only: 28, gbp_only: 22, basic: 8, modern: 0, unknown: 5 }
nicheFit:              { Septic: 10, 'Water/Mold': 10, HVAC: 9, Plumber: 9,
                          Roofer: 8, Towing: 7, Electrician: 6, 'Real Estate': 4 }
phonePresent:          +8
phoneLineLandlineOrVoip: +4
licenseActive:         +10
licenseExpired:        -25
stormBumpForStormNiches:+15  (Roofer / Water-Mold only)
reviewVelocityLow:     +8   (review_count_30d ≤ 1)
reviewVelocityHigh:    -4   (review_count_30d ≥ 8 — busy, not in pain)
hasOnlineBookingPenalty:-10
competitorDensityHigh: +5
ownerOperator:         +6
serviceDispatchModel:  +5
emergencyNiche:        +6
multiLocationPenalty:  -8
franchisePenalty:      -50  (also a hard filter; kept as a safety net)
residentialPenalty:    -40  (same)
deadDomainPenalty:     -10
```

Final score is clamped to [0, 100].

## Contributions trail

Every score returns a `contributions[]` array:
```json
[
  { "signal": "web_presence_level", "value": "none", "points": 35, "confidence": 0.85 },
  { "signal": "has_phone",          "value": true,    "points": 8,  "confidence": 0.95 },
  ...
]
```

The Leads drawer renders this as a "why score" panel. Each row shows signal → points → confidence so operators can sanity-check.

## Tiers and enrichment budgets

| Tier | Range | Enrichment budget |
|---|---|---|
| `discard` | 0–59 | none |
| `qualified` | 60–79 | scrape /contact, free MX/RCPT chain |
| `priority` | 80–94 | + Bouncer fallback if ambiguous |
| `top` | 95–100 | + Hunter fallback if scrape failed |

## Versioning

`scoring_versions` is a table with monotonically increasing ids. Each row stores `weights JSONB` plus `notes` and `effective_from`. The Validation Mode workflow creates new versions from observed lift, capped at ±30% per weight.

## Anti-patterns

- **No per-lead AI.** Templates with signal-aware slots match 85% of AI quality at 0% of the cost.
- **No fancy ML.** Linear deterministic scoring is interpretable, fast, and tunable from validation outcomes.
- **No "experiment library" of weights at MVP.** One active version per org.
- **No scoring weights that require paid data.** Every signal listed above is free.

## Updating from validation outcomes

After an engagement experiment, the signal-outcome matrix proposes weight deltas:
```
P(reply | signal=true) / P(reply | signal=false) = lift
  lift ≥ 2 → increase weight by 15% (capped)
  1.2 ≤ lift < 2 → increase by 7%
  lift < 1 → decrease by 20%
```

Click **Apply plan** in the Validation Refine panel. The system writes a new `scoring_versions` row; new scoring happens against the new version while old scored values are preserved via `leads.scoring_version`.
