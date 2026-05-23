# Pre-account deployment audit

> Verified against the actual repo on 2026-05-18. The repo is safe to deploy with **zero real credentials** in either `SAMPLE_MODE=true` (local) or production-with-mocks mode (`SAMPLE_MODE=false` + `ENABLE_SES=false`). No real email can leave the system under either configuration.

## 1. What is ready for account creation

| Area | State |
|---|---|
| Codebase | Feature-complete; 195 tests pass (173 unit + 22 integration); 0 lint warnings; clean typecheck |
| Repo on GitHub | Public at `harshilkikani/keres-ai`, `main` branch only, CI/CD wired |
| Local Postgres path | `docker compose up -d postgres` + `pnpm db:migrate` + `pnpm db:seed` proven working |
| Live integration suite | `pnpm db:test` exercises 22 e2e scenarios against real PG with mock providers |
| Pre-commit secret scanner | Installed via `scripts/install-hooks.sh`; refuses `.env*` + key-shaped strings |
| GitHub Actions | `test.yml` (typecheck + lint + tests + integration vs PG 15) ran green on the first push; `deploy.yml` no-ops cleanly when `FLY_API_TOKEN` is absent |
| `fly.toml` | Configured with `auto_stop_machines = "stop"`, `min_machines_running = 0` (sub-$5/mo target) |
| `apps/server/Dockerfile` | Multi-stage, bundles SPA at build time, `SERVE_WEB=true` baked in |
| `.dockerignore` | Excludes node_modules, dist, .env, .git, .claude, IDE dirs |
| Scheduler | 9-tick automation runs 24/7 in non-sample mode; disabled in SAMPLE_MODE |
| Launch gate | 20+ blockers; refuses to send when any compliance/identity check fails |

## 2. What is not ready

| Missing | Severity | Phase |
|---|---|---|
| `pnpm preflight:local` script | Low | Phase 2 |
| `pnpm preflight:deploy` script | Low | Phase 2 |
| `scripts/generate-secrets.sh` | Low | Phase 4 |
| Separate `UNSUBSCRIBE_SIGNING_SECRET` env (currently shares `AUTH_COOKIE_SECRET`) | Low (defense-in-depth) | Phase 4 |
| Explicit `CORS_ORIGIN` env (currently derives from `PUBLIC_BASE_URL`) | Low | Phase 4 |
| `docs/ACCOUNT-CREATION-CHECKLIST.md` | Medium | Phase 3 |
| `docs/SECRET-HANDLING.md` | Medium | Phase 3 |
| `docs/DEPLOYMENT-SECRETS-RUNBOOK.md` | Medium | Phase 3 |
| `docs/FIRST-DEPLOYMENT-RUNBOOK.md` | Medium | Phase 3 |

## 3. What must be fixed before Fly/Neon deployment

**Nothing in the code.** All needed inputs come from environment variables; the operator pastes those into `flyctl secrets set` on their machine. The code does not require any change before first deployment.

The operator must:
1. Create a Fly account (or skip Fly and run on a different host — `apps/server/Dockerfile` is platform-agnostic).
2. Create a Neon project (or skip Neon and use any reachable Postgres 15+).
3. Run `flyctl auth login` (interactive — opens browser).
4. Generate strong secrets locally (Phase 4 ships a script).
5. Set Fly secrets via `flyctl secrets set` (never paste them anywhere they get logged).

## 4. What must be fixed before AWS SES

**Nothing in the code.** SES adapter (`packages/providers/src/ses.ts`) is feature-complete. Operator must:

1. Verify the outreach subdomain in SES.
2. Publish SPF, 3 DKIM CNAMEs, DMARC at Cloudflare DNS.
3. Open SES production-access ticket.
4. Create configuration set `keres-outreach` with SNS event destinations.
5. Set `ENABLE_SES=true` AND `SES_PRODUCTION_ACCESS_CONFIRMED=true` AND populate SES creds.
6. Confirm at `/diagnostics` that the launch gate goes green.

The launch gate refuses to allow a real send if any of the above are missing. `validateConfig()` refuses to even start the server in production if `ENABLE_SES=true` but `SES_PRODUCTION_ACCESS_CONFIRMED=false`.

## 5. What must be fixed before any real email

The launch gate already enforces every condition required for compliant cold email under Gmail/Yahoo 2024 bulk-sender rules + CAN-SPAM + AWS SES AUP. None of those checks can be bypassed in code; the only escape is `POST /api/campaigns/:id/launch` with `override.reason` which writes an audit-log entry.

Specifically blocked until green:
- `sample_mode_off` — SAMPLE_MODE=false
- `sender_identity_complete` — From / Reply-To / Org name set
- `physical_address_set` — CAN-SPAM postal address set
- `ses_production_access` — SES sandbox lifted
- `outbound_configured` — `ENABLE_SES=true` with creds
- `seedlist_configured` — at least one mailbox in `SEEDLIST_EMAILS`
- `seedlist_test_recent` — successful seedlist send in last 7 days
- `sender_domain_exists` — `sender_domains` row present
- `spf_pass` / `dkim_pass` / `dmarc_pass` — DNS records verified
- `unsub_reachable` — `GET /api/unsubscribe/health` returns 200
- `warmup_ok` — sender domain warmup state ≥ warming
- `daily_cap_ok` — daily cap not exceeded
- `bounce_rate_safe` — 24h bounce < 4%
- `complaint_rate_safe` — 24h complaint < 0.1%
- `copy_lint` — body/subject pass the linter (no fake personalization, no spammy phrases, no missing footer)

## 6. Which scripts exist

| Script | Purpose | Status |
|---|---|---|
| `pnpm install` | install deps + install git hooks via postinstall | ✓ |
| `pnpm dev` | concurrent server (:8080) + web (:5173) | ✓ |
| `pnpm typecheck` | tsc --noEmit across all 6 packages | ✓ |
| `pnpm lint` | ESLint flat config | ✓ |
| `pnpm test` | 173 unit tests (no DB / no network) | ✓ |
| `pnpm db:test` | 22 integration tests against real Postgres | ✓ |
| `pnpm build` | all packages + web bundle | ✓ |
| `pnpm db:migrate` | tsx packages/db/src/migrate.ts | ✓ |
| `pnpm db:seed` | tsx apps/server/src/seed.ts | ✓ |
| `pnpm doctor` | scripts/doctor.ts — env + DB + unsub + provider config check | ✓ |
| `pnpm start` | run pre-built server (production) | ✓ |

## 7. Which scripts are missing

| Script | Adds in Phase 2 |
|---|---|
| `pnpm preflight:local` | One-shot: install + typecheck + lint + test + db:test + build + doctor |
| `pnpm preflight:deploy` | Account/secrets checklist printout — no creds required |

## 8. Which deployment artifacts exist

```
✓ fly.toml                              auto-stop, health/ready checks
✓ apps/server/Dockerfile                multi-stage, bundles SPA
✓ .dockerignore
✓ docker-compose.yml                    local Postgres 15-alpine
✓ .env.example                          every variable documented
✓ .gitignore                            excludes .env, node_modules, .claude, .vscode, .idea, *.tgz
✓ .github/workflows/test.yml            CI on PR + push: typecheck + lint + test + integration
✓ .github/workflows/deploy.yml          on main after test passes; no-ops without FLY_API_TOKEN
✓ .github/dependabot.yml                npm + actions + docker
✓ scripts/install-hooks.sh              installs pre-commit secret scanner
✓ scripts/pre-commit.sh                 refuses .env files + AWS/GH/Stripe/Anthropic key shapes
✓ scripts/doctor.ts                     readiness check
```

## 9. Which deployment artifacts are missing

| Artifact | Phase |
|---|---|
| `scripts/generate-secrets.sh` (or .mjs) — generate strong values locally, never echo them inadvertently | 4 |
| `.env.production.example` — separate template for prod values | 4 |
| `docs/ACCOUNT-CREATION-CHECKLIST.md` | 3 |
| `docs/SECRET-HANDLING.md` | 3 |
| `docs/DEPLOYMENT-SECRETS-RUNBOOK.md` | 3 |
| `docs/FIRST-DEPLOYMENT-RUNBOOK.md` | 3 |

## 10. Can production run safely with `SAMPLE_MODE=false` + `ENABLE_SES=false`?

**Yes.**

Path of an outbound attempt in this configuration:
1. Operator hits `POST /api/campaigns/:id/launch`.
2. `evaluateLaunchGate` reports `outbound_configured = fail` because `cfg.ses.enabled === false`.
3. Launch returns `{ ok: false, gate: { ... } }`.
4. No campaign is moved to `running`.
5. The scheduler's send-batch tick has nothing to send (no recipients in `pending` state because no campaign launched).
6. Even if the operator force-launches via `override.reason`, `getOutbound()` returns `MockOutbound` (since `cfg.sampleMode || !cfg.ses.enabled`). No bytes leave the machine.

`validateConfig()` enforces additional guardrails:
- `NODE_ENV=production` + `SAMPLE_MODE=true` → **fatal**, refuses to boot.
- `NODE_ENV=production` + `ENABLE_SES=true` + missing creds → **fatal**.
- `NODE_ENV=production` + `ENABLE_SES=true` + `SES_PRODUCTION_ACCESS_CONFIRMED=false` → **fatal**.
- `NODE_ENV=production` + weak `AUTH_TOKEN` or `AUTH_COOKIE_SECRET` → **fatal**.
- `NODE_ENV=production` + non-https `PUBLIC_BASE_URL` → **fatal**.

This means: **the only way to send real email is to deliberately satisfy every safety condition**. It cannot happen by accident.

## 11. Does the launch gate block all real sends while SES is disabled?

**Yes** — verified by:
- `apps/server/src/services/launch-gate.ts:91` — `outbound_configured` check fails when `!cfg.ses.enabled && !cfg.sampleMode`.
- `apps/server/src/services/sender-factory.ts:15` — `if (cfg.sampleMode || !cfg.ses.enabled) { provider = new MockOutbound() }`.
- 5 of the 173 unit tests + 3 of the 22 integration tests assert that the gate refuses launches with these flags.

## 12. Can any route accidentally send real mail?

**Audited routes that touch outbound:**

| Route | Provider call path | Safe with `ENABLE_SES=false`? |
|---|---|---|
| `POST /api/campaigns/:id/launch` | Through gate → `sendBatch` → `getOutbound()` | ✓ Gate fails, MockOutbound only. |
| `POST /api/sender-domains/:id/test-send` | `sendSeedlistTest` → `getOutbound()` | ✓ MockOutbound when `ENABLE_SES=false`. |
| Scheduler's `send_batch` tick | Same `sendBatch` → `getOutbound()` | ✓ MockOutbound. Also: the campaign would have to be in `running` state, which requires the gate to have passed. |

**No other route in the codebase invokes any SES API.** Audited via `Grep "SesAdapter|SESv2Client|SendEmailCommand"` — only `packages/providers/src/ses.ts` matches.

## 13. Is any provider key exposed to the frontend?

**No.** Verified by:
- Grep across `apps/web/src/` for `apiKey|API_KEY|secret|password|token`: only matches are the login form's `token` field (operator types their AUTH_TOKEN), `Settings.tsx` warning copy ("Never enter SMTP passwords..."), and `Costs.tsx`/`ProviderUsage.tsx` informational copy.
- `GET /api/settings` whitelists 9 non-secret org fields plus a runtime block listing only `providersEnabled` booleans, no key material.
- `Settings.tsx` PUT body whitelist on the server (`routes.ts`): only `fromName, fromEmail, replyTo, physicalAddress, outreachSubdomain, defaultBookingLink, budgetMode, productionAccessConfirmed, name` accepted; any other field is dropped.

## 14. Exact next actions

In this session (zero account creation, zero secrets pasted into chat):
1. Phase 2 — add `pnpm preflight:local` and `pnpm preflight:deploy` to `package.json`.
2. Phase 3 — write four runbook docs.
3. Phase 4 — add `scripts/generate-secrets.sh`, separate `UNSUBSCRIBE_SIGNING_SECRET` + `CORS_ORIGIN` env, `.env.production.example`.

After this session (operator-driven):
1. Read `docs/SECRET-HANDLING.md`.
2. Run `bash scripts/generate-secrets.sh` locally — write each value to your secrets store (1Password / Bitwarden / KeepassXC). Do NOT paste into Claude chat.
3. Read `docs/ACCOUNT-CREATION-CHECKLIST.md` and create the 1–2 accounts you need *right now* (Fly + Neon).
4. Read `docs/DEPLOYMENT-SECRETS-RUNBOOK.md`.
5. Run the deployment from `docs/FIRST-DEPLOYMENT-RUNBOOK.md`.
6. Defer SES / Postmark / Yelp / Hunter / Bouncer until you actually need to send.
