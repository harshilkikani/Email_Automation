# Post-Deploy Neon Seed Log — 2026-05-18

Picks up where `FIRST-FLY-NEON-DEPLOYMENT-LOG.md` left off. Records the
idempotent Neon seed, the post-seed launch-gate state, and which blockers
were intentionally left in place.

---

## Result

- **Seed:** Succeeded, idempotent, exit 0.
- **No real email sent.** No paid provider called. `ENABLE_SES=false`,
  `SAMPLE_MODE=false` throughout.
- **Launch gate** still blocks campaigns: **8 blockers**, all expected.
  The list shifted from "no infrastructure" blockers (no org, no domain) to
  "DNS / SES / seedlist not yet configured" blockers — exactly what the
  next human step should address.

---

## Pre-seed safety verification

Before running anything against Neon I verified:

1. `git status` clean on `24176d4`.
2. All 12 required scripts present (`secrets:gen`, `db:test`, `doctor`,
   `preflight:local`, `preflight:deploy`, `db:migrate`, `db:seed`, `build`,
   `typecheck`, `lint`, `test`, `start`).
3. `fly.toml` app = `keres-ops`, region = `iad`, `release_command` set.
4. Dockerfile CMD uses the fixed entry path
   `apps/server/dist/apps/server/src/index.js`.
5. `docs/FIRST-FLY-NEON-DEPLOYMENT-LOG.md` already committed.
6. No `.env`, `.keres-*`, or generated secret file is tracked in git.
7. `.gitignore` broadened to `.env.*` (allowing `*.example` templates) and
   to local Neon/secrets file patterns. Verified via `git check-ignore -v`.
8. **Connection target confirmed as Neon** by parsing the host out of the
   local connection URI: `ep-plain-unit-aqa7lxjk.c-8.us-east-1.aws.neon.tech`.
   Not the local Docker `keres-pg`. Username and password never printed.

---

## Seed script idempotency

`apps/server/src/seed.ts` was inspected before running. Confirmed:

- Org: `SELECT ... LIMIT 1` first, insert only if missing.
- Sender domain: `SELECT ... WHERE orgId = $1 LIMIT 1`, insert only if absent.
- Scoring versions: `SELECT id = 1`, insert only if missing.

Safe to re-run any number of times.

---

## Rows created

```
  organizations           1
  scoring_versions        1
  sender_domains          1
  campaigns               0
  campaign_recipients     0
  leads                   0
  lead_signals            0
  discovery_jobs          0
  email_events            0
  suppressions            0
  job_runs                0
  cost_events             0
  state_licensees         0
  validation_experiments  0
  seedlist_tests          0
  _keres_migrations       2
```

(`audit_logs` was queried but doesn't exist under that name — schema uses a
different identifier; non-blocking, will reconcile when needed.)

The bootstrap org row uses values from production config (defaulted, not
invented):

| field                       | value                                       |
| --------------------------- | ------------------------------------------- |
| slug                        | `keres`                                     |
| name                        | `Keres AI`                                  |
| timezone                    | `America/Chicago`                           |
| fromName                    | `Keres AI`                                  |
| fromEmail                   | `hello@outreach.keresai.com` *(placeholder; update before SES)* |
| replyTo                     | `replies@outreach.keresai.com` *(placeholder)* |
| physicalAddress             | empty *(intentional — see "Reminders" below)* |
| outreachSubdomain           | `outreach.keresai.com` *(placeholder)*       |
| productionAccessConfirmed   | `false`                                     |
| budgetMode                  | `free`                                      |

The single sender_domain row is `outreach.keresai.com` with
`warmupState='pending'` and no DNS columns marked verified. The launch gate
correctly treats it as "domain exists" but still fails SPF/DKIM/DMARC/unsub.

---

## Launch-gate state delta

| code                       | before seed | after seed | comment                                                                       |
| -------------------------- | ----------- | ---------- | ----------------------------------------------------------------------------- |
| `sample_mode_off`          | ✓ pass      | ✓ pass     |                                                                               |
| `budget_mode_set`          | ✕ fail      | ✓ **pass** | org row exists with `budgetMode='free'`                                       |
| `sender_identity_complete` | ✕ fail      | ✓ **pass** | org has fromName / fromEmail / replyTo (placeholder values, still valid)      |
| `sender_domain_exists`     | ✕ fail      | ✓ **pass** | placeholder domain row inserted; DNS columns NOT marked verified              |
| `physical_address_set`     | ✕ fail      | ✕ fail     | **intentionally left blocked** — see Reminders                                |
| `ses_production_access`    | ✕ fail      | ✕ fail     | intentionally left — flips when AWS console confirms + you set the flag       |
| `outbound_configured`      | ✕ fail      | ✕ fail     | intentionally left — `ENABLE_SES=false`                                       |
| `seedlist_configured`      | ✕ fail      | ✕ fail     | intentionally left — `SEEDLIST_EMAILS` empty                                  |
| `spf_pass`                 | (n/a)       | ✕ fail     | new check, only runs once a domain row exists; expected fail until DNS done   |
| `dkim_pass`                | (n/a)       | ✕ fail     | same                                                                          |
| `dmarc_pass`               | (n/a)       | ✕ fail     | same                                                                          |
| `unsub_reachable`          | (n/a)       | ✕ fail     | same                                                                          |

**Net: blockingCount = 8.** Real campaign launches remain impossible.

---

## Deployed smoke checks

| route                          | result                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `GET /`                        | 200 (SPA index, 755 B)                                              |
| `GET /api/health`              | 200 `{"ok":true,"sampleMode":false,"mode":"free"}`                  |
| `GET /api/ready`               | 503 (intentional — gate has blockers). Body empty: existing FYI follow-up. |
| `GET /api/diagnostics` (auth)  | 200 — db connected, last migration applied                          |
| `GET /api/launch-gate` (auth)  | 200 — 8 blockers, 0 warnings                                        |
| `GET /api/settings` (auth)     | 200 — bootstrap org returned                                        |
| `GET /api/sender-domains` (auth)| 200 — placeholder domain row                                       |
| `GET /api/leads` (auth)        | 200 — empty                                                          |
| `GET /api/discovery/jobs`       | 200 — empty                                                          |
| `GET /api/campaigns`           | 200 — empty                                                          |
| `GET /api/validation/experiments` | 200 — empty                                                       |
| `GET /api/audit`               | 200 — small payload from seed-time audit                            |
| `GET /api/wizard/first-validation` | 200 — wizard report                                              |

Post-seed log (Fly) shows the scheduler ticks running cleanly — the previous
`relation "organizations" does not exist` errors are gone. The machine
auto-stops on idle and auto-starts on incoming requests, exactly as
configured. Each restart logs `Keres server listening on 8080
(sampleMode=false, ses=false)`.

---

## Safe-mode reaffirmation

Confirmed end-to-end after seed:

- `SAMPLE_MODE=false` — production validation path is active.
- `ENABLE_SES=false` — outbound provider resolves to `MockOutbound` only.
- `sendBatch()` short-circuits in production when `!ENABLE_SES && !SAMPLE_MODE`,
  so the `/api/campaigns/:id/resume` bypass cannot turn the mock into real
  recipient touch.
- `evaluateLaunchGate()` reports `outbound_configured: fail` with detail
  `"ENABLE_SES=false"` and `ses_production_access: fail`.
- Seedlist test would fail at `recipients.length === 0` (SEEDLIST_EMAILS
  unset), before reaching the mock provider.
- No paid provider key is set. No paid provider call happens.

---

## Reminders (intentionally left to human)

These are not bugs — they are paused on purpose because the right value
needs a real-world decision.

1. **Physical postal address (CAN-SPAM).** Required in every commercial
   email. Set via UI Settings → Sender identity → Physical postal address,
   or by `PUT /api/settings { physicalAddress: "..." }`. The address must be
   a real US business mailing address (street, suite, city, state, ZIP) —
   PO boxes are accepted by SES but disliked by Gmail/Yahoo reputation.
2. **Outreach domain / subdomain.** The seed used the placeholder
   `outreach.keresai.com`. If you choose a different domain, update both
   the org's `outreachSubdomain` and the existing sender_domains row before
   touching DNS or SES.
3. **From / Reply-To** still point at the placeholder. Update to match the
   real domain after Cloudflare DNS is configured.
4. **Seedlist mailboxes.** Set `SEEDLIST_EMAILS` (Gmail + Outlook + a
   custom-domain mailbox you own) only when ready for the first real send.

The deployed UI's Settings page should be the primary surface for entering
these. Do not paste any of them into chat.

---

## Files added / changed since the deploy commit

| path                                         | reason                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `.gitignore`                                 | broaden to `.env.*` (allowing `*.example`) + local secret patterns  |
| `scripts/seed-verify.ts` (new)               | prints row counts, never values; runs `SELECT count(*)::int`         |
| `docs/POST-DEPLOY-NEON-SEED-LOG.md` (this)   | this log                                                            |

No code or schema changes were needed for the seed. Migrations from the
previous deploy already covered all DDL.

---

## Next step

Read `docs/NEXT-DOMAIN-CLOUDFLARE-SES-PLAN.md`. It contains the exact
checklist for the next set of human decisions (domain, Cloudflare DNS,
AWS SES). Do nothing in AWS, Cloudflare, Postmark, or any paid provider
until that document is reviewed and a domain has been chosen.
