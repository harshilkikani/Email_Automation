# CI

> One-page guide for running the test matrix.

## Local

```bash
pnpm install
pnpm typecheck       # all packages, strict
pnpm test            # 145+ unit/integration tests (no DB / no network)
pnpm build           # web bundle
```

## DB-backed integration tests

```bash
docker compose up -d postgres
DATABASE_URL='postgres://postgres:postgres@localhost:5432/keres' pnpm db:test
docker compose down                    # cleanup when done
```

`pnpm db:test` runs `vitest.integration.config.ts`, which:

- Probes Postgres at the configured `DATABASE_URL` before scheduling tests.
- **Skips gracefully** (with an actionable log line) if PG is unreachable. This means CI can be safely configured to always run `db:test` — it won't fail builds on docker-less runners. Add an explicit `services:` block to your CI for the actual DB-backed assertions.
- Drops + recreates the `public` schema, runs migrations + seed.
- Boots the Fastify app via `app.inject()` (no port binding).
- Exercises 20+ scenarios end-to-end against real SQL: discovery, dedupe, validation reviews, launch gates, SES SNS webhooks, inbound replies, CSV exports, audit log, provider usage.

## GitHub Actions (suggested)

```yaml
name: test
on:
  push: { branches: [main] }
  pull_request: {}

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_USER: postgres
          POSTGRES_DB: keres
        ports: [ '5432:5432' ]
        options: >-
          --health-cmd "pg_isready -U postgres -d keres"
          --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/keres
```

## Doctor

```bash
pnpm doctor
```

Runs `scripts/doctor.ts` — checks Node version, pnpm version, required env vars, DB reachability, migration state, SAMPLE_MODE, public base URL reachability, provider config presence, and outstanding launch-gate blockers. Used during onboarding and before every production deploy.
