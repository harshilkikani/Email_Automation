# First Fly + Neon Deployment Log — 2026-05-18

A complete record of the first production deployment of `keres-ops` to Fly,
backed by Neon Postgres, with all real outbound disabled. No real email was
sent. No paid providers were called. No secrets were pasted into chat.

---

## Result

- **Deployment:** Succeeded on second attempt (the first failed for an
  entrypoint-path bug that is now fixed for good).
- **Live URL:** https://keres-ops.fly.dev/
- **Image size:** 57 MB (slim runtime — only `dist/*.js` and `--prod` deps).
- **Cost on Fly today:** $0 — the VM auto-stops on idle and the personal
  org's free allowance covers a single 512 MB shared-cpu-1x VM.
- **Cost on Neon today:** $0 — free tier, ~0 KB used.
- **Forecast cost** (after a typical week of operator clicks): ~$1.50/mo
  Fly compute + $0 Neon + ~$0 Cloudflare DNS. SES and other paid providers
  remain off.

---

## Infrastructure

### Fly app

| field                  | value                                       |
| ---------------------- | ------------------------------------------- |
| `app`                  | `keres-ops`                                 |
| organization           | `personal` (slug `keres-ai`)                |
| `primary_region`       | `iad` (Ashburn, Virginia)                   |
| VM class               | `shared-cpu-1x` / 512 MB                    |
| `auto_stop_machines`   | `stop`                                      |
| `auto_start_machines`  | `true`                                      |
| `min_machines_running` | `0`                                         |
| volumes                | none                                        |
| dedicated IPv4         | no — shared IPv4 `66.241.125.154`           |
| IPv6                   | `2a09:8280:1::117:c1af:0`                   |
| health check           | `GET /api/health` every 30 s                |
| readiness check        | `GET /api/ready` every 60 s                 |
| `release_command`      | `node packages/db/dist/migrate.js`          |
| Dockerfile             | `apps/server/Dockerfile`                    |
| build engine           | Fly remote builder (`--remote-only`)        |

**Memory rationale:** 512 MB was chosen over 256 MB because the runtime
peak (OSM Overpass parsing + CSV import) can briefly reach ~250–350 MB.
256 MB would leave no headroom. The Dockerfile builds all artifacts in a
builder stage; the runner stage only runs `node` against `dist/*.js`, so
build memory is irrelevant to the running VM.

### Neon project

| field                  | value                                       |
| ---------------------- | ------------------------------------------- |
| project name           | `keres-ops`                                 |
| project id             | `ancient-tooth-70510934`                    |
| region                 | `aws-us-east-1` (N. Virginia)               |
| plan                   | Free tier                                   |
| connection driver      | `neon-serverless` (HTTP fetch, not pooler)  |
| connection URI         | stored at `~/.keres-neon.json` (locked ACL) |

**Region rationale:** Matches Fly `iad` for minimum cross-region latency
on every DB query.

---

## Scripts verified or added during this deploy

| script              | status   | notes                                                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm install`      | verified | clean install, pnpm 9.7.0, Node 20                                                                           |
| `pnpm typecheck`    | verified | all 5 workspace packages green                                                                               |
| `pnpm lint`         | verified | ESLint 9, zero issues                                                                                        |
| `pnpm test`         | verified | 177 unit tests across 28 files                                                                               |
| `pnpm db:test`      | verified | 22 integration tests against local Postgres 15                                                               |
| `pnpm build`        | verified | all dist outputs present                                                                                     |
| `pnpm doctor`       | verified | works when invoked via `npx tsx scripts/doctor.ts` (the pnpm wrapper has a Windows-PowerShell stdout quirk)  |
| `pnpm preflight:local`  | verified | chains the above                                                                                          |
| `pnpm preflight:deploy` | verified | wraps preflight:local + file/schema checks                                                                |
| `pnpm secrets:gen`  | rewritten | now default-writes to `~/.keres-secrets.env`, locks ACL via `icacls`, refuses overwrite without `--rotate`. Never prints values. `--stdout` flag preserves the old pipe-to-clipboard behaviour. |
| `pnpm db:migrate`   | verified | applied `0000_init.sql` + `0000_overconfident_hellfire_club.sql` to Neon                                     |
| `pnpm db:seed`      | available | **not run** during this deploy; intentionally left to operator decision                                      |
| `pnpm start`        | fixed    | the start script and Dockerfile CMD pointed at `dist/index.js`; the actual emitted path is `dist/apps/server/src/index.js` because path-mapped imports push TS-inferred `rootDir` to the repo root. Both are now corrected. |

### Package `main` / `exports` corrected for runtime

Every workspace package (`@keres/db`, `@keres/core`, `@keres/email`,
`@keres/providers`) had `"main": "src/index.ts"` and `"exports": { ".": "./src/index.ts" }`.
That works under `tsx` in dev but Node 20 can't run `.ts`. All four packages
now point at their compiled `dist/*.js` outputs with proper `types`/`default`
conditional exports.

### Defense-in-depth fix in `sendBatch`

`apps/server/src/services/sender-pipeline.ts` now short-circuits the entire
send loop when `NODE_ENV=production && !ENABLE_SES && !SAMPLE_MODE`. The
launch gate's `outbound_configured` check is the primary gate, but
`/api/campaigns/:id/resume` could revive a paused campaign without re-running
the gate — this guard ensures MockOutbound can never "fake-send" to real
recipients in production.

---

## Production secrets set on Fly

All 12 set via `flyctl secrets set --stage --app keres-ops` from values
read from local files. **No secret value was echoed to chat.** `flyctl
secrets list` confirms only names + 16-char digests are visible.

| name                          | source                       | role                                                  |
| ----------------------------- | ---------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                | `~/.keres-neon.json`         | Neon connection URI                                   |
| `DATABASE_DRIVER`             | static `neon-serverless`     | switches Drizzle to the HTTP fetch driver             |
| `SAMPLE_MODE`                 | static `false`               | turns off the mock outbound in the launch gate        |
| `ENABLE_SES`                  | static `false`               | keeps real SES OFF for the first deploy               |
| `AUTH_TOKEN`                  | `~/.keres-secrets.env`       | bearer token accepted by `/api/auth/login`            |
| `AUTH_COOKIE_SECRET`          | `~/.keres-secrets.env`       | signs session cookies                                 |
| `UNSUBSCRIBE_SIGNING_SECRET`  | `~/.keres-secrets.env`       | signs RFC 8058 one-click unsubscribe tokens           |
| `PUBLIC_BASE_URL`             | `https://keres-ops.fly.dev`  | used in unsub URLs + CORS fallback                    |
| `CORS_ORIGIN`                 | `https://keres-ops.fly.dev`  | explicit CORS allowlist                               |
| `ORG_NAME`                    | static `Keres AI`            | non-sensitive org default                             |
| `FROM_NAME`                   | static `Keres AI`            | non-sensitive org default                             |
| `LOG_LEVEL`                   | static `info`                | pino log level                                        |

**Not set this deploy** (and the app must not require them):
- `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_SNS_TOPIC_ARN`,
  `SES_CONFIGURATION_SET`, `SES_PRODUCTION_ACCESS_CONFIRMED`
- `POSTMARK_INBOUND_TOKEN`, `POSTMARK_INBOUND_USERNAME`, `POSTMARK_INBOUND_PASSWORD`
- `HUNTER_API_KEY`, `BOUNCER_API_KEY`, `YELP_API_KEY`, `PLACES_API_KEY`
- `SEEDLIST_EMAILS`
- `PHYSICAL_ADDRESS`

These remain unset by design. `validateConfig()` only requires them when their
corresponding `ENABLE_*` flag is `true` (or when `NODE_ENV=production` for a
narrow set), and the launch gate refuses any campaign launch in their absence.

---

## Migrations

```
▶ 0000_init.sql                              (239 bytes)   ✓ applied
▶ 0000_overconfident_hellfire_club.sql      (27,335 bytes) ✓ applied
All migrations up to date.
```

Ran from local machine, with `DATABASE_URL` sourced from `~/.keres-neon.json`
and cleared from the shell env immediately after. Future deploys will run
migrations automatically via the new `[deploy] release_command` line in
`fly.toml`.

---

## Smoke-test results

All performed against `https://keres-ops.fly.dev`.

| # | check                                    | result                                                                              |
| - | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 1 | `GET /api/health`                        | **200**  `{"ok":true,"sampleMode":false,"mode":"free"}`                              |
| 2 | `GET /api/ready` (no auth)               | **503** — expected; gate has 7 blockers. (Body is empty — minor cosmetic follow-up.) |
| 3 | `POST /api/auth/login`                   | **200** — session cookie returned                                                    |
| 4 | `GET /api/diagnostics` (auth)            | **200** — db: connected, last migration: `0000_overconfident_hellfire_club.sql`, providers: `ses:false postmark_inbound:false osm:true yelp:false hunter:false bouncer:false places:false`, sampleMode: false, budgetMode: free |
| 5 | `GET /api/launch-gate` (auth)            | **200** — `blockingCount: 7, warningCount: 0`                                       |
| 6 | Launch-gate per-check verdicts           | `sample_mode_off: pass`; **fail** for `budget_mode_set`, `sender_identity_complete`, `physical_address_set`, `ses_production_access`, `outbound_configured` *(detail: "ENABLE_SES=false")*, `seedlist_configured`, `sender_domain_exists`. **Real sends cannot happen.** |
| 7 | DB write evidence                        | migration runner wrote 2 rows to `_keres_migrations` against Neon ✓                  |
| 8 | Real email sent?                         | **No.** Outbound provider resolves to `MockOutbound` (`ENABLE_SES=false`) and `sendBatch` short-circuits in production when SES is off. |
| 9 | Paid provider call?                      | **No.** `ENABLE_HUNTER`, `ENABLE_BOUNCER`, `ENABLE_YELP`, `ENABLE_PLACES` all false. |
| 10 | UI loads?                               | `GET /` → **200**, 755 B, `text/html` (SPA index from `apps/web/dist`)                |

---

## Known issues / follow-ups

1. **`/api/ready` body is empty on 503** — the status code is correct, but
   Fastify is not serializing the JSON body. Diagnose the `onSend` hook
   interaction. Low priority; the status code is what the Fly checks use.
2. **`pnpm doctor` produces no stdout in PowerShell** — but `npx tsx scripts/doctor.ts`
   works. Likely a pnpm-on-Windows-PowerShell wrapper buffering issue.
   Workaround: invoke via `tsx` directly when running interactively.
3. **PUT `/api/settings` returns 500 when no org exists** — `singleOrgId()`
   throws when the row is missing. Either tolerate this state or run
   `pnpm db:seed` to insert the initial org row.
4. **TypeScript emits to deep nested `dist/<workspace>/src/`** because
   path-mapped imports from `packages/*` push the inferred `rootDir` to the
   repo root. Functional but ugly. Long-term fix is TypeScript project
   references or pre-built `.d.ts` consumption.

---

## What we explicitly did NOT do

- Did not create an AWS account.
- Did not enable SES (`ENABLE_SES=false`).
- Did not request SES production access.
- Did not configure Postmark Inbound.
- Did not configure Hunter, Bouncer, Yelp, Places (Google), or any other paid provider.
- Did not configure Cloudflare DNS or any custom domain.
- Did not allocate a dedicated IPv4 (shared IPv4 is fine for this stage).
- Did not provision Fly Postgres, Redis, Tigris, or any add-on.
- Did not insert any real recipients or leads.
- Did not send a single email.
- Did not store any secret in the repo or in any chat transcript.

---

## Next human step

In order, smallest first:

1. **Run `pnpm db:seed` against Neon** to insert the bootstrap org +
   sender_domains row. (You can do this from local with `DATABASE_URL` sourced
   from `~/.keres-neon.json`, same pattern as the migration command.)
2. **Buy / decide on a sending domain.** The placeholder `outreach.keresai.com`
   in `cfg.org.outreachSubdomain` should match a domain you actually own.
   Until then, DNS-based gate checks (`spf_pass`, `dkim_pass`, `dmarc_pass`,
   `unsub_reachable`) will fail.
3. **Cloudflare** — add the root domain + outreach subdomain, then point a
   `CNAME` from `keres-ops.<your-domain>` to `keres-ops.fly.dev` (or just keep
   using the `*.fly.dev` URL during validation).
4. *(Only when you are sure you want to send real email)* AWS account → SES
   verified identity for the outreach subdomain → DKIM CNAMEs in DNS →
   `flyctl secrets set` for SES_* values → set `ENABLE_SES=true` → run the
   seedlist test from the UI.

Stop after each step, re-run `/api/launch-gate`, and verify the blocker
count drops the way you expect.
