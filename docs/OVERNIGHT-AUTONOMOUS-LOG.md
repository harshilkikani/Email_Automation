# Overnight autonomous log

Operator: Claude Opus 4.7 (autonomous mode).
Start: 2026-05-18 ~02:51 UTC.

## Baseline (cycle 0)

```
pnpm typecheck   ✓ all packages clean
pnpm test        ✓ 145/145 across 23 files
pnpm build       ✓ web bundle builds 803ms
```

Known gaps (per operator brief):
1. No live Postgres integration test → P1.
2. SNS positive-path test missing → P2.
3. Provider Usage API exists, no dedicated UI → P3.
4. License sources cover TX/FL/GA only → P4.
5. No first-run wizard → P5.
6. No warmup / placement tracker → P6.
7. Reply triage needs shortcuts → P7.
8. Septic/Houston pilot copy not evidence-mapped → P8.
9. Deployment artifacts unverified → P9.
10. General polish → P10.

## Plan

Tackle in dependency order: P2 (quick) → P1 (largest infra) → P3/P4 (UI + docs) → P5/P6/P7/P8 (operator workflow) → P9 (deployment) → P10 (polish + final).

Each cycle appends `### Cycle N — <topic>` with what was done, files changed, results.

---

### Cycle 1 — P2: SNS positive-path signature test (closed)

- Added `packages/providers/test/sns-verify-positive.test.ts`.
- Generates a fresh RSA-2048 keypair at module load + mints a self-signed X.509 cert with `node-forge` (test-only devDep).
- Signs canonical SNS payload (RSA-SHA256) for Notification + SubscriptionConfirmation.
- Asserts signature pass; tampered Message fails with `signature_mismatch`; malicious cert host fails with `invalid_signing_cert_host`.
- Production verifier untouched: still pins `sns.<region>.amazonaws.com` host.
- Result: 4/4 positive tests pass.

Files changed:
- `packages/providers/test/sns-verify-positive.test.ts` (new)
- `packages/providers/package.json` (+devDeps: node-forge, @types/node-forge)
- `docs/OVERNIGHT-AUTONOMOUS-LOG.md` (this entry)

### Cycle 2 — P1: Live Postgres integration test (closed)

- New `pnpm db:test` script + `vitest.integration.config.ts`.
- New `apps/server/integration/setup.ts` — Postgres probe, schema reset, migrate, seed.
- New `apps/server/integration/integration.test.ts` — 22-scenario end-to-end against the real Fastify app via `app.inject()`.
- New `apps/server/src/test-server.ts` builds a portable Fastify instance for tests.
- New `docs/CI.md` documents local commands + GitHub Actions matrix with the Postgres service.
- Probing PG happens at module load (top-level await) so `it.runIf(pgReachable)` evaluates correctly — when PG is unreachable, tests cleanly skip with an actionable message. No false failures on docker-less runners.
- `pnpm test` excludes `apps/server/integration/**` so unit suites are unaffected.

Files changed:
- `package.json` (+db:test, +doctor)
- `vitest.config.ts` (exclude integration folder)
- `vitest.integration.config.ts` (new)
- `apps/server/integration/setup.ts` (new)
- `apps/server/integration/integration.test.ts` (new)
- `apps/server/src/test-server.ts` (new)
- `apps/server/package.json` (+pg)
- `docs/CI.md` (new)
- `docker-compose.yml` (dropped obsolete version key)

Result without PG running: 22 tests collected, 21 skipped with reason, 1 passed (the reason reporter). No false failures.
Docker is installed but the daemon is not running in this session — operator runs `docker compose up -d postgres && pnpm db:test` to exercise the full path.

### Cycle 3 — P3: Provider Usage UI (closed)

- `/api/provider-usage` extended with last-call timestamp + `providersEnabled` + `sampleMode`.
- New `/api/export/provider-usage.csv` (injection-protected).
- New `apps/web/src/lib/provider-usage.ts` (pure transformer) + `apps/web/src/pages/ProviderUsage.tsx`.
- Provider Usage tab in nav.
- 5 unit tests for budget %, amber/red/cap warning thresholds, SES linear-pricing handling.

### Cycle 4 — P4: License source expansion (closed)

- Expanded `docs/LICENSE-SOURCES.md` with per-state setup for CA (CSLB), AZ (ROC), NC (multi-board), TN (verify.tn.gov).
- `license-importer.ts::COL` aliases expanded; `classifyStatus` now handles `probation`, `revoked`, `debarred`, `sanction`, `warning`.
- 5 new tests, one per state column shape + a status-classification test.

### Cycle 5 — P5: First Validation Run wizard (closed)

- New `wizard_progress` table (server-persisted notes per step).
- New `services/wizard.ts` derives 18 step statuses from diagnostics + launch-gate + DB state.
- New `GET /api/wizard/first-validation` + `PUT /api/wizard/first-validation/notes`.
- New `apps/web/src/pages/FirstRun.tsx` + `First run` nav item at `/first-run`.
- Wizard never bypasses the launch gate (step 14 IS the live gate).

### Cycle 6 — P6: Warmup / placement tracker (closed)

- New `seedlist_tests` table with `observed` enum + observation timestamp.
- `services/seedlist.ts` writes a row per test send + stamps providerMessageId.
- New `services/placement.ts` with `summarisePlacement` (7d/30d) and a 30-day warmup ramp.
- `GET /api/sender-domains/:id/seedlist` + `PATCH /api/seedlist-tests/:id`.
- 9 unit tests covering ramp + placement recommendations.

### Cycle 7 — P7: Reply triage improvements (closed)

- `inbound_messages` gained `classifier_source` + `bookedDemo`.
- `PATCH /api/inbound/:id` accepts `manualIntent` (flips classifierSource to `manual`), `triaged`, `bookedDemo`.
- `POST /api/inbound/:id/suppress` with `scope: 'email' | 'domain'`.
- Inbox UI: filter chips with counts, keyboard shortcuts (`j/k/i/c/o/n/h/w/r/u/b/s/d`), focus ring.

### Cycle 8 — P8: Septic / Houston pilot copy + evidence preview (closed)

- New `templates-septic.ts` with Priority-1 evidence-mapped copy (5 slots).
- Each opener exposes its supporting signal via `SEPTIC_OPENER_EVIDENCE`.
- Default opener never claims unknown facts.
- Registered as `septic-houston-pilot` template.
- 5 unit tests for slot picking, fallback, no-fake-personalization rendering.

### Cycle 9 — P9: Deployment artifacts + doctor (closed)

- `fly.toml` with auto-stop + health/ready checks.
- `apps/server/Dockerfile` multi-stage build.
- `.dockerignore`.
- `scripts/doctor.ts` (verified — exits 1 with actionable fix lines on offline DB/unsub).
- `pg` + `undici` hoisted to root devDeps for `pnpm doctor`.
- `docs/FIRST-RUN-SEPTIC-HOUSTON.md`, `docs/OPERATIONS-CHECKLIST.md`.

### Cycle 10 — P10: Final polish + full checks (closed)

- TODO/FIXME/STUB sweep across `apps/` + `packages/` — clean.
- Full `pnpm typecheck`: all 6 packages green.
- Full `pnpm test`: **173/173 tests across 28 files**.
- `pnpm --filter @keres/web build`: 50 modules, 237 KB.
- `pnpm doctor`: runs end-to-end, reports actionable fixes.
