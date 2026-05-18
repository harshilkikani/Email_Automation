# Keres AI — Production Gap Audit

> Recorded before the second-pass refinement. Every claim in this audit was verified by reading the actual code in the repo, not by trusting earlier summaries.

## 1. Current repo structure

```
apps/server/    Fastify API + DB-backed send loop
  src/auth.ts, config.ts, index.ts, routes.ts, seed.ts
  src/services/{campaigns, discovery, gates, inbound-handler, sender, sender-factory, sender-pipeline, unsubscribe, validation}.ts
  test/{gates, smoke}.test.ts

apps/web/       Vite + React SPA
  src/{App, api, main, toast, styles.css}.{tsx,ts,css}
  src/pages/{Dashboard, Discover, Leads, Campaigns, Validation, Inbox, Deliverability, Costs, Suppression, Settings}.tsx

packages/db/    Drizzle schema + migration runner + client
  src/{schema, client, index, migrate}.ts
  migrations/0000_init.sql

packages/core/  Domain logic
  src/{types, scoring, dedupe, filters, templates, validation, budget, reply-classifier, index}.ts
  test/{scoring, dedupe, templates, validation, budget, reply-classifier}.test.ts

packages/providers/
  src/{types, osm, yelp, noaa, census, phone, scraper, verify, hunter, bouncer, ses, ses-events, inbound, index}.ts
  src/licenses/index.ts
  test/{forbidden-providers, yelp-no-store, osm, phone, ses-events, verify}.test.ts

packages/email/ Plain-text renderer + RFC 8058 headers + tokens + linter
  src/{headers, unsubscribe, linter, render, index}.ts
  test/{headers, unsubscribe, linter}.test.ts

docs/           AUDIT, UPDATED-ARCHITECTURE, SETUP, DEPLOYMENT, COMPLIANCE, PROVIDERS, VALIDATION-MODE, COST-MODEL, SCORING, RUNBOOK
```

## 2. What is truly production-ready

| Component | Notes |
|---|---|
| Scoring (`packages/core/src/scoring.ts`) | Deterministic, versioned, audit-trailed, hard filters short-circuit to 0. Tests cover storm-zone bumps, license states, franchise/residential reject. |
| Dedupe (`packages/core/src/dedupe.ts`) | Exact + fuzzy via Dice similarity, city/state guard. |
| Template renderer (`packages/core/src/templates.ts`) | Plain-text, signal-aware slots, hash-stable per `lead.id`, two-pass expansion, no AI. |
| Reply classifier (`packages/core/src/reply-classifier.ts`) | Regex taxonomy matching VALIDATION-PLAN.md. |
| Body linter (`packages/email/src/linter.ts`) | Errors on missing physical address, missing unsub, deceptive subject, unresolved tokens, false claims. |
| RFC 8058 headers (`packages/email/src/headers.ts`) | `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, From alignment, Precedence: bulk. |
| Signed unsub tokens (`packages/email/src/unsubscribe.ts`) | HMAC-SHA256, base64url, expiry-bound. |
| SES SNS event parser (`packages/providers/src/ses-events.ts`) | Bounce/complaint/delivery, hard-vs-soft, idempotent recipient list. |
| Postmark Inbound parser (`packages/providers/src/inbound.ts`) | Basic-auth or webhook-token gated, parses to neutral `InboundEvent`. |
| OSM Overpass adapter (`packages/providers/src/osm.ts`) | Real Overpass HTTP, User-Agent honored, ODbL attribution string, fetcher injectable for tests. |
| Yelp no-store adapter (`packages/providers/src/yelp.ts`) | Returns only `{ businessId, reviewCount, rating, isClaimed }`. Schema lint test enforces no Yelp-tagged columns. |
| Forbidden-provider lint test | Asserts no Postmark outbound / Resend / Apollo / Clay / LinkedIn files exist. |
| Drizzle schema (`packages/db/src/schema.ts`) | All v3 DDL bugs corrected; idempotent webhook unique index; partial indexes on dedupe columns. |

## 3. What is demo/sample/mock only (must not be assumed production-ready)

| Item | File | Reality |
|---|---|---|
| **License lookups in non-sample mode** | `packages/providers/src/licenses/index.ts:24-30,55-58` | `StubLicenseProvider` returns `status: 'unknown'` for every lookup, regardless of state. Production sends will *never* benefit from the active-license signal until a real importer ships. |
| **DNS check in sample mode** | `apps/server/src/services/sender.ts:23-34` | Hardcoded all-green. Acceptable for demo, but the test-send/launch gate must distinguish between "demo passed" and "real DNS verified" or it will green-light sends behind `SAMPLE_MODE=true`. |
| **DKIM check production path** | `apps/server/src/services/sender.ts:60-67` | Probes only `s1._domainkey`. Misses SES's `s2`/`s3` selectors and any other DKIM provider. False positives possible if `s1` resolves but `s2`/`s3` are missing — SES requires all three. |
| **Test-send route** | `apps/server/src/routes.ts:128-134` | Returns a stringified description instead of attempting an actual send. There is no production code path that performs the seedlist test-send. |
| **Validation experiment list (frontend)** | `apps/web/src/pages/Validation.tsx:13,23-25,38-40` | The list lives in component state only. Reload loses everything. No `GET /api/validation/experiments` route exists. |
| **Bouncer + Hunter in sample mode** | `apps/server/src/services/discovery.ts:41-43` | Disabled via `cfg.sampleMode`. Good — but the launch gate must explicitly refuse to send while sample mode is on. |
| **SES outbound** | `packages/providers/src/ses.ts:56-64` | `MockOutbound` is correct for dev. Production code uses the real `SesAdapter`, but there is no SNS-message-signature verification today — anyone who reaches `/api/webhooks/ses` can forge bounces. |
| **CSV import** | `apps/server/src/routes.ts:240-280` | Works but has no CSV-injection protection on exports (because there are no exports yet). |

## 4. Security-sensitive findings

| ID | File / area | Risk | Severity |
|---|---|---|---|
| S-01 | `apps/server/src/index.ts` | No env-var validation at startup. `AUTH_TOKEN=change-me` (the default) would silently run and accept that as the password. | **High** |
| S-02 | `apps/server/src/routes.ts /webhooks/ses` | No SES SNS signature verification. A POST with a forged JSON `Notification` body will be processed, including hard-bounce auto-suppression. | **High** |
| S-03 | `apps/server/src/routes.ts /webhooks/inbound` | Postmark signature verification is *optional* (basic-auth or `x-postmark-server-token`). If neither is configured, anything posts and writes to `inbound_messages`. | Medium |
| S-04 | `apps/server/src/auth.ts` | No rate limiting on `/api/auth/login`. Brute force feasible. | Medium |
| S-05 | `apps/server/src/routes.ts /unsubscribe/:token` | Token verification is HMAC-strong, but no rate limit. Could be abused to scan token spaces (low real impact given 256-bit MAC). | Low |
| S-06 | All routes | No CSRF token. Mitigated by cookie `SameSite=Lax` and bearer-token alternative, but an internal-tool best-practice would be to add a CSRF check on state-changing POSTs initiated from the SPA. | Low |
| S-07 | `packages/db/src/migrate.ts:40`, `apps/server/src/seed.ts` | `console.log` of operational lines is fine; nothing here leaks secrets. | OK |
| S-08 | `apps/server/src/routes.ts` overall | No audit log of who launched a campaign or who overrode a gate. Single operator at MVP, but you can't reconstruct an "I accidentally launched X" incident. | Medium |
| S-09 | `apps/web/src` | No secrets stored or surfaced in the SPA. Settings UI whitelists only public fields. **OK.** | OK |
| S-10 | `apps/server/src/index.ts` CORS | `origin: true, credentials: true` — allows any origin to send credentialed requests. For an internal tool deployed on one host, set an explicit allowlist. | Medium |
| S-11 | No security headers (CSP, HSTS, X-Content-Type-Options). | Medium |

## 5. Compliance-sensitive findings

| ID | File | Risk |
|---|---|---|
| C-01 | `apps/server/src/services/gates.ts` | The gate does **not** block when `SAMPLE_MODE=true`. Because the outbound provider is a `MockOutbound` in sample mode, no real email leaves the machine, *but* the gate as written would happily say "ok=true" on a misconfigured system where `SAMPLE_MODE=true` and `ENABLE_SES=true` — `getOutbound()` would still pick the mock. Belt-and-suspenders demands the gate refuse sample mode explicitly. |
| C-02 | `apps/server/src/services/gates.ts` | The gate does not require a seedlist test-send to have passed within the last N days. |
| C-03 | `apps/server/src/services/gates.ts` | The gate does not run the body linter against the configured template. The send pipeline does (`sender-pipeline.ts` calls `lintEmail`), but the *launch* gate should pre-flight. |
| C-04 | `apps/server/src/services/gates.ts` | Unsubscribe endpoint reachability is read from `sender_domains.unsub_reachable` but nothing in the product probes that. Default `false` means launches block until a domain is manually marked reachable — opaque. |
| C-05 | `apps/server/src/services/sender-pipeline.ts` lint check | The linter pre-blocks sends, but does not record a `campaign_recipients.skip_reason` audit trail of *which* linter rule failed. |
| C-06 | `packages/email/src/headers.ts` | Headers are correct; CAN-SPAM footer is correct; one-click POST endpoint accepts the token. **OK.** |

## 6. What can block a production send

- Compliance gate (`canSend`) currently blocks on: physical address, sender identity, production-access flag, SPF/DKIM/DMARC/MX statuses, warmup state, daily cap, 24h bounce/complaint pct, unsub reachable.
- The send pipeline additionally blocks on linter `error` severity and on lead status (`bounced`/`unsubscribed`/`dnc`).

## 7. What can accidentally allow unsafe sends

| ID | Problem |
|---|---|
| U-01 | A misconfigured deployment with both `SAMPLE_MODE=true` and `ENABLE_SES=true` would silently use the mock. (No actual outbound, but the operator might think live and bring more data; surface the inconsistency.) |
| U-02 | The DKIM check only probes one selector; a domain with `s1` valid but `s2`/`s3` missing or rotated is *not* SES-compliant but reads "pass" in the UI. |
| U-03 | The launch gate does not enforce a successful seedlist test-send. |
| U-04 | The launch gate does not enforce a body-linter pre-flight (the send loop does, but per-recipient, after launch). |
| U-05 | `/api/webhooks/ses` accepts any payload without SNS signature verification — a hostile actor could spam fake-complaint events that would auto-suppress real prospects. |
| U-06 | There's no daily budget check on real provider calls before they are dispatched (we have monthly budgets but no daily); a runaway loop could exhaust Bouncer in one day. |

## 8. What can create inaccurate leads

| ID | Problem |
|---|---|
| L-01 | License signal is always `unknown` outside sample mode → scoring loses ~10 points per active license. Discovery results in real mode are systematically under-scored. |
| L-02 | The OSM adapter's niche → OSM tag map is a starting point; some local terms (e.g. "drain cleaning" vs "plumber") will miss businesses. Tunable in `packages/providers/src/osm.ts::NICHE_TO_OSM`. |
| L-03 | Hard filters list (`packages/core/src/filters.ts`) covers UPS/franchise/government/nonprofit but does not yet flag chain-owned brands like "Mr. Electric" or "1-800-PLUMBER" beyond the partial patterns. |
| L-04 | Web-presence inference is heuristic; thin landing pages may classify as `basic` when they are effectively `none`. |
| L-05 | Dedupe relies on the *current* org's prior leads only — there is no global dedupe across orgs (acceptable for single-tenant MVP). |

## 9. What can exceed the sub-$5/mo target

| ID | Risk |
|---|---|
| B-01 | The Bouncer monthly budget is *enforced* via `canUseBouncer`, but the spend ledger has no concurrency lock — two simultaneous verifications might both pass the budget check. (At our volume this is negligible.) |
| B-02 | If `ENABLE_PLACES=true` is flipped on for any reason, the cost ledger would track it but the budget cap would need to be configured. |
| B-03 | A long-running send job that fails the SES rate limiter could retry indefinitely. The current pipeline catches exceptions per-recipient, so this is bounded, but a real `retry-after`/backoff should be added before any high-volume run. |
| B-04 | Hunter free tier is 50 unified credits/mo in 2026 — the current default `HUNTER_MONTHLY_FREE_CREDITS=50` matches. Test exists in `packages/core/test/budget.test.ts`. |

## 10. Implementation plan, prioritized

Each item below maps to a TaskCreate ID added at the start of this session.

| Priority | Task | Status | Rationale |
|---|---|---|---|
| **P0** | Write this audit | `in_progress` → `completed` | Required before code changes. |
| **P1** | Production Readiness Gate (#12) | Will close U-01..U-04, C-01..C-04. Central function consumed by API + UI. |
| **P1** | DKIM/DNS upgrade (#13) | Will close U-02. Adds SES 3-selector validation, supplemental selectors, unsub URL probe. |
| **P1** | Server-side validation experiments (#14) | Closes the explicit gap in §3. Required by the validation workflow. |
| **P1** | CSV export with injection protection (#15) | Required for the 30-day signal-outcome workflow. |
| **P2** | License sources registry + importer (#16) | Closes L-01. Database-backed lookup + CSV importer + LICENSE-SOURCES.md. |
| **P2** | Security and reliability (#17) | Closes S-01..S-04, S-08, S-10, S-11. Env validation, rate limits, SNS signature, audit log, CORS, secure cookies, security headers. |
| **P2** | Cost guards + provider usage UI (#18) | Closes B-01..B-03. Daily + monthly budgets, provider usage screen. |
| **P3** | UX polish (#19) | Launch-gate checklist; system diagnostics; eyeball-review C/D reason tags; reply-inbox keyboard shortcuts. |
| **P3** | Production smoke test (#20) | End-to-end with DNS-fail block then pass; lint failures; SES events; CSV export. |
| **P3** | Docs & deployment (#21) | LICENSE-SOURCES.md + RUNBOOK refresh + docker-compose. |

## Acceptance criteria for "production-ready for first Septic / Houston validation"

The build is ready when, in order:

1. `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm test && pnpm typecheck && pnpm build` all pass.
2. `GET /api/diagnostics` reports green on: DB connected, migrations current, providers configured, sample mode off, DNS green for the configured outreach subdomain, SES production access confirmed, unsubscribe endpoint reachable, seedlist test-send within the last 24h.
3. `GET /api/launch-gate?campaignId=<draft>` reports green for at least one draft campaign.
4. The new server-side `GET /api/validation/experiments` returns the experiments list with filters.
5. Signal-outcome CSV export downloads a CSV with proper injection-protected leading-character cells.
6. Real DNS check correctly fails when any of `s1`, `s2`, `s3` `_domainkey` CNAMEs are missing.
7. The end-to-end smoke test (mock providers) passes.
8. The first send goes only to the configured seedlist; subsequent sends are rate-limited.

The earlier limitations called out by the original report:
- ✅ State license adapter — closed via CSV-importer path + `state_licensees` DB lookup.
- ✅ DKIM single selector — closed via 3-selector check.
- ✅ Validation experiment list client-only — closed via `GET /api/validation/experiments`.
- ✅ CSV export missing — closed via 7 export endpoints.

After these land, the product is safe for: local testing, seedlist test-send, Day 0 eyeball validation, and (with `SAMPLE_MODE=false` plus real provider configuration) Day 1–7 reach testing on a single niche/city pair.
