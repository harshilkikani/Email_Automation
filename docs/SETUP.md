# Setup

## Requirements
- Node 20 LTS (24 also works)
- pnpm 9+
- Postgres 15+ (locally via Docker or any reachable instance)

## Step-by-step

### 1. Clone & install
```bash
pnpm install
```

### 2. Postgres
The simplest local DB is Docker:
```bash
docker run --name keres-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:15
```

For production, sign up for [Neon](https://neon.tech) — the free tier (0.5 GB storage, 100 CU-hours/mo, scale-to-zero) easily covers 1k qualified leads/month.

### 3. Environment
```bash
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — already set to the docker container default; change if your Postgres is elsewhere
- `AUTH_TOKEN` — set to a long random string. This is your sign-in password.
- `AUTH_COOKIE_SECRET` — another long random string. Used to sign session cookies and unsubscribe tokens.
- `ORG_NAME`, `FROM_NAME`, `FROM_EMAIL`, `REPLY_TO`, `PHYSICAL_ADDRESS`, `OUTREACH_SUBDOMAIN`, `DEFAULT_BOOKING_LINK` — your sender identity.
- Provider toggles (`ENABLE_OSM` etc.) — leave default; flip to `true` only after you have credentials.

### 4. Migrate
```bash
pnpm db:migrate
```
This runs `packages/db/migrations/0000_init.sql` (extensions) and the auto-generated Drizzle migrations.

> ⚠ Drizzle migration generation: `pnpm db:generate` is only needed if you change `packages/db/src/schema.ts`. The shipped repo already contains the necessary migration baseline; the `0000_init.sql` file installs `citext`, `pg_trgm`, and `uuid-ossp`. After your first edit, run `pnpm db:generate` and commit the new SQL file.

### 5. Seed
```bash
pnpm db:seed
```
Creates the single tenant organization, one sender domain stub (the configured `OUTREACH_SUBDOMAIN`), and `scoring_versions` row 1.

### 6. Run
```bash
pnpm dev
```
- API: http://localhost:8080
- Web: http://localhost:5173 (proxies `/api/*` to the API)

Sign in with the `AUTH_TOKEN` value.

## Tests
```bash
pnpm test              # 119+ tests
pnpm typecheck         # tsc --noEmit across all packages
```

## Going live (high level — see `DEPLOYMENT.md`)
1. Move `DATABASE_URL` to Neon.
2. Set `DATABASE_DRIVER=neon-serverless`.
3. Set up AWS SES — see `PROVIDERS.md`.
4. Set up Postmark Inbound — see `PROVIDERS.md`.
5. Toggle `SAMPLE_MODE=false`.
6. Deploy to Fly.io.

## Troubleshooting
- **Server can't connect to DB**: confirm `DATABASE_URL` and that Postgres is reachable.
- **`citext` errors at migration**: the `0000_init.sql` file MUST run before the Drizzle-generated migrations. Re-run `pnpm db:migrate`.
- **Web blank page**: open browser devtools — likely an `/api/settings` 401. Sign in.
- **CSV import does nothing**: file must have a header row with columns `name, email, phone, niche, city, state, website, address`.
