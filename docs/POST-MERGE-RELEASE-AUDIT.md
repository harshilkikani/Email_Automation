# Post-Merge Release Audit — 2026-05-23

Audit of `main` after PR #9 (`Merge feature/production-layers + close 4 audit
gaps`, commit `e1e28ba`) was squashed into `main`. Goal: decide whether to
redeploy `keres-ops` to Fly.

---

## 1. Safe to deploy?

**Yes** — after the 4 release blockers in this audit are fixed (3 fixed in
this PR, 1 documented). Production stays in the same safe posture: SAMPLE_MODE
governed by Fly secrets (currently `true`), `ENABLE_SES=false`, launch gate
blocks real sends.

---

## 2. Blockers fixed in this PR

| # | what | severity | fix |
|---|---|---|---|
| 1 | `tickClosedLoop` auto-applied scoring weight changes daily without explicit operator approval | **CRITICAL** | Added `CLOSED_LOOP_AUTO_APPLY=false` env flag (default off). The daily tick now writes proposals but only applies them when the flag is on AND the existing 200-obs/3-signal confidence gate also passes. `apps/server/src/services/closed-loop.ts:328-356` |
| 2 | `POST /api/dead-letters/:id/replay` resurrected DLQ'd recipients without rechecking the launch gate. In a future state where SES is on but DNS/sender-domain has regressed, a click would resume sends to an unsafe state. | **HIGH** | Replay now evaluates the launch gate for the recipient's campaign and refuses with `412 launch_gate_blocked` + structured blocker list if any of `sample_mode_off / outbound_configured / ses_production_access / sender_domain_exists / spf_pass / dkim_pass / dmarc_pass / unsub_reachable / physical_address_set / campaign_state` is failing. Refusal is audit-logged. `apps/server/src/routes.ts:1011-1054` |
| 3 | `tickReplyBranches` crashed at startup (`first_sent_at.getTime is not a function`) because raw `db.execute(sql\`…\`)` returns timestamp columns as ISO strings under the Neon HTTP driver. | **HIGH** (would have crash-looped on every prod tick) | Coerce to `Date` defensively: `first_sent_at instanceof Date ? first_sent_at : new Date(first_sent_at)`. `apps/server/src/services/reply-branches.ts:78-86` |

## 3. Blockers remaining

| # | what | severity | follow-up |
|---|---|---|---|
| 4 | `tickWebsiteIntelRefresh` makes outbound HTTP fetches to lead websites every 6h (up to ~100 req per tick: 25 leads × 4 paths each). It's gentle but ungated. | **LOW** — no paid provider involved, but operator may want an `ENABLE_WEBSITE_INTEL` flag to disable in tightly-controlled networks. | Tracked as low-priority. Doesn't block deploy. |

---

## 4. Migrations summary

| file | rows added/altered | idempotent? | destructive? |
|---|---|---|---|
| `0000_init.sql` | already applied — _keres_migrations ledger | yes (`CREATE TABLE IF NOT EXISTS`) | no |
| `0000_overconfident_hellfire_club.sql` | already applied | yes | no |
| `0001_features.sql` | **new** — adds `sender_mailboxes`, `sender_reputation_daily`, `warmup_plans`, `market_saturation`, `signal_outcomes`, `scoring_proposals`, `website_intel`, `reply_branch_states`, `niche_seasons`, `niche_weather_overlays`, `queue_metrics_snapshots`, `ai_runs`. Inserts one default warmup plan per existing org. | yes (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`) | no — additive, no DROP/RENAME |
| `0002_won_outcomes.sql` | **new** — `ALTER TABLE reply_branch_states ADD COLUMN IF NOT EXISTS won_at/won_outcome_type/won_revenue_usd` | yes | no |
| `0003_retry_and_funnel.sql` | **new** — `ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS retry_count`, expands `leads.status` CHECK to include 'won', adds CHECK on `reply_branch_states.won_outcome_type` | yes (DROP CONSTRAINT IF EXISTS first, then ADD) | column expansion **expands** allowed values — existing data stays valid |
| `0004_production_layers.sql` | **new** — adds `n_won` + `total_revenue_usd` to `signal_outcomes`, creates `dead_letters`, `send_time_histograms`, `domain_events` | yes | no |

**Net:** 22 → 37 tables. **Zero tables removed.** Run via the existing
`fly.toml [deploy] release_command = 'node packages/db/dist/migrate.js'` —
the runner already skips already-applied migrations via the
`_keres_migrations` ledger.

---

## 5. New endpoints summary (21)

All behind the auth onRequest hook (auth.ts). Open routes unchanged.

| route | method | gated by | mutates | notes |
|---|---|---|---|---|
| `/api/leads/:id/refresh-intel` | POST | UUID guard + auth | yes (website_intel row) | calls 3rd-party websites |
| `/api/reply-branches/:id/won` | POST | UUID guard + auth | yes (reply_branch_states) | revenue tracking |
| `/api/revenue` | GET | auth | no | aggregate read |
| `/api/audit-log` | GET | auth | no | read |
| `/api/dead-letters` | GET | auth | no | read |
| `/api/dead-letters/:id/replay` | POST | UUID guard + auth + **launch-gate re-check** | yes (recipient state) | audit-logged, refused if gate fails |
| `/api/sender-mailboxes/:id/reputation-trend` | GET | UUID guard + auth | no | read |
| `/api/dashboard` | GET | auth | no | aggregate read |
| `/api/domain-events` | GET | auth | no | read |
| `/api/queue/metrics` | GET | auth | no | read |
| `/api/queue/snapshots` | GET | auth | no | read |
| `/api/sender-mailboxes` | GET, POST | UUID guard + auth | POST creates row | no DNS verification — operator action |
| `/api/sender-mailboxes/:id` | PATCH | UUID guard + auth | yes | |
| `/api/warmup-plans` | GET, POST | auth | POST creates row | |
| `/api/scoring/proposals` | GET | auth | no | |
| `/api/scoring/proposals/refresh` | POST | auth | yes (proposal row) | audit-logged |
| `/api/scoring/proposals/:id/apply` | POST | UUID guard + auth | yes (scoring_versions) | audit-logged; only human-driven now |
| `/api/scoring/proposals/:id/reject` | POST | UUID guard + auth | yes (proposal status) | audit-logged |
| `/api/scoring/versions` | GET | auth | no | read |

---

## 6. Auth / rate-limit / audit coverage

- **Auth:** all 21 new endpoints are gated by `auth.ts`'s `onRequest` hook
  (Bearer token or signed session cookie). Open-route list unchanged.
- **Rate limit:**
  - Global: 240/min default via `@fastify/rate-limit`.
  - Per-route: tighter caps on `/api/auth/login` (6/min), `/api/webhooks` (600/min),
    `/api/unsubscribe` (60/min), `/api/*/launch` (12/min).
  - **Per-org token bucket** (this PR): 10 rps / 100 burst, fails open on
    org-resolver error, idle eviction after 1h.
- **Audit:** dangerous mutations write to `audit_log` —
  `dead_letter_replay`, `dead_letter_replay_blocked` (this PR),
  `scoring_proposal_applied`, `scoring_proposal_rejected`,
  `closed_loop_refresh`. `tickClosedLoop` also writes via
  `applyScoringProposal` when auto-apply is enabled.

---

## 7. Queue/DLQ safety verdict

**Safe** with these properties:

- `dead_letters` rows are inserted only from `sender-pipeline.ts` after a
  recipient exhausts 3 send attempts. Audit-logged via `emitEvent`
  (`send.dead_lettered`).
- `/api/dead-letters/:id/replay` re-checks the launch gate (this PR). Refuses
  with 412 + blocker list when any real-send gate fails. Logs
  `dead_letter_replay_blocked`.
- The defense-in-depth `sendBatch` guard
  (`if (production && !ses && !sampleMode) return early`) still applies after
  a replay, so even a successful replay cannot send while ENABLE_SES=false.
- `job_runs` queue (db tier): `SELECT … FOR UPDATE SKIP LOCKED` — race-safe
  on multiple workers in the same process. Singleton-key dedup via
  `payload->>'_singletonKey'`. Idempotent: integration test
  `queue.enqueue + singletonKey dedup + sampleMetrics` proves it.
- pg-boss tier is opt-in via `QUEUE_TIER=pg-boss`. Not active today.

---

## 8. Closed-loop scoring safety verdict

**Safe with `CLOSED_LOOP_AUTO_APPLY=false` (this PR's default).**

- Daily tick aggregates `signal_outcomes` over a 30-day window.
- Proposes weight changes capped at ±30% per signal.
- Writes `scoring_proposals` row.
- **Skips auto-apply unless the env flag is `true`.** New integration test
  asserts: `tickClosedLoop` produces 0 auto-applied weight changes when the
  flag is off, and `scoring_versions` count is unchanged.
- Operator approves via `POST /api/scoring/proposals/:id/apply`. Both apply
  and reject paths are audit-logged.

To enable auto-apply later, set `CLOSED_LOOP_AUTO_APPLY=true`. The 200-obs/
3-signal confidence gate still applies even in auto-apply mode.

---

## 9. Local AI / Ollama safety verdict

**Safe.** Defaults are all-off:

- `ENABLE_LOCAL_AI=false` → `getAdapter()` returns `NoopAdapter` (deterministic
  fallback). No network, no LLM.
- Even with `ENABLE_LOCAL_AI=true`, `AI_RUNTIME=noop` (default) keeps the
  Noop adapter. Only `AI_RUNTIME=ollama` flips to OllamaAdapter.
- The Ollama HTTP target defaults to `localhost:11434`. Will fail
  immediately on Fly (no localhost service); error caught and falls back to
  Noop adapter for that call.
- AI operations are strictly batch — no per-lead per-runtime calls.
- The boot rehearsal confirmed: `ai analysis tick → adapter:noop, messages:1`.

---

## 10. Launch-gate safety verdict

**Strongly protective.** Current `keres-ops.fly.dev` reports:

```
GET /api/health  →  {"ok":true,"sampleMode":true,"mode":"free","enableSes":false}
```

`sampleMode=true` causes `sample_mode_off` to fail with severity 'fail',
blocking every campaign launch path. Even without that, `outbound_configured`
fails when ENABLE_SES=false, and at minimum 4 more DNS/SES gates fail.

After deploy:
- The new layers do not weaken the gate.
- `sendBatch` defense-in-depth guard is intact at
  `apps/server/src/services/sender-pipeline.ts:76-78`.
- DLQ replay is now gated (this PR).
- Auto-apply scoring is off by default (this PR).

---

## 11. Exact deploy command (only if §1 is "yes")

```powershell
# 1. From the project root, on main, after `git pull` to ensure we have
#    the latest squashed merge + this audit's fixes.
$env:Path = "$HOME\.fly\bin;$env:Path"

# 2. (Optional) confirm prod state before deploy:
flyctl status --app keres-ops

# 3. Build remotely + deploy. release_command runs the migration runner
#    before any traffic shifts. Migrations are idempotent so a re-run is
#    a no-op against the already-migrated Neon DB.
flyctl deploy --app keres-ops --remote-only --ha=false

# 4. Tail logs for 60–120s to verify the boot and first scheduler tick.
flyctl logs --app keres-ops
```

Estimated time: 3–6 min (build) + ~30s (release_command migration) + ~1 min
(machine restart + health checks).

---

## 12. Exact rollback command

```powershell
$env:Path = "$HOME\.fly\bin;$env:Path"

# Roll back to the image that was previously deployed (the one currently
# in production at the moment of audit). The image tag is in
# `flyctl status --app keres-ops` under "Image" — record it BEFORE deploy:
#   keres-ops:deployment-01KSB1KNGK2HBQJF1XDJKWHFXR  (current as of 2026-05-23)

flyctl deploy --app keres-ops --image registry.fly.io/keres-ops:deployment-01KSB1KNGK2HBQJF1XDJKWHFXR --remote-only --ha=false
```

The new migrations are additive (no DROP/RENAME), so rolling the IMAGE back
to the prior commit leaves the new tables in Neon — empty and unreferenced
by the rolled-back code. No data loss. The forward-roll would refill them.

If a data-only revert is needed (very rare), the migrations can be reverted
via hand-written down-migrations. None are scripted today; raise a follow-up
task if/when this becomes necessary.

---

## 13. Exact post-deploy smoke test

```powershell
$base = 'https://keres-ops.fly.dev'

# 1. Health — must be 200 with enableSes=false.
Invoke-WebRequest "$base/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content

# 2. Ready — must be 503 with structured JSON. Use curl for body capture
#    because PowerShell drops non-2xx bodies.
curl -sS "$base/api/ready" | jq '{ok, reason, blockingCount, safeToUseForSetup, realOutboundEnabled, enableSes, sampleMode, dbStatus: .db, lastMigration: .migrations.lastApplied}'

# 3. Launch gate — must list the same blockers as before merge.
#    Use the local AUTH_TOKEN from ~/.keres-secrets.env; don't paste in chat.
$secrets = @{}
Get-Content "$HOME\.keres-secrets.env" | ForEach-Object {
  $p = $_ -split '=', 2; if ($p.Length -eq 2) { $secrets[$p[0].Trim()] = $p[1] }
}
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest "$base/api/auth/login" -Method POST -Body (@{token=$secrets.AUTH_TOKEN}|ConvertTo-Json) -ContentType 'application/json' -WebSession $s -UseBasicParsing | Out-Null
Remove-Variable secrets
(Invoke-WebRequest "$base/api/launch-gate" -WebSession $s -UseBasicParsing).Content | ConvertFrom-Json | Select-Object -ExpandProperty gate | Select-Object ok, blockingCount, warningCount

# 4. New endpoints reachable (authed).
Invoke-WebRequest "$base/api/dashboard" -WebSession $s -UseBasicParsing | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest "$base/api/dead-letters" -WebSession $s -UseBasicParsing | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest "$base/api/queue/metrics" -WebSession $s -UseBasicParsing | Select-Object -ExpandProperty StatusCode

# 5. Live logs for 60s to confirm no tick crashes.
flyctl logs --app keres-ops
```

Expected after deploy:
- `/api/health` 200 with `enableSes:false`
- `/api/ready` 503 with structured blocker list including
  `outbound_configured: ENABLE_SES=false`
- `/api/launch-gate` `ok:false`, blockingCount ≥ 7
- `/api/dashboard`, `/api/dead-letters`, `/api/queue/metrics` all 200
- Logs show `Scheduler started (21 ticks).` and no `tick failed`
- `reply branches tick: due:0, acted:0, newlyCreated:0`

If any of these fail, run the rollback command (§12).
