# Setup

## Requirements
- Node 20 LTS (24 also works)
- pnpm 9+
- Postgres 15+ (locally via Docker or any reachable instance)

## What ships in the repo vs. what each developer brings

The `.gitignore` deliberately excludes three categories of files. Nothing is missing — each category has its own way of being supplied:

| Category | Examples | How a new collaborator gets them |
|---|---|---|
| **Regenerated from lockfile** | `node_modules/`, `dist/`, `.vite/`, `coverage/`, `*.log`, `.cache/` | `pnpm install` and (if needed) `pnpm build`. `pnpm-lock.yaml` IS committed so versions are deterministic. |
| **Secrets (per-developer)** | `.env`, `.env.local`, AWS / Postmark / Bouncer / Hunter keys | Each developer copies `.env.example` → `.env` and fills in *their own* values. **Never commit a real `.env`.** For shared production credentials use Fly.io secrets / 1Password / `gh secret set` — see step 3 below. |
| **Per-machine / IDE** | `.vscode/`, `.idea/`, `.claude/`, `.DS_Store`, `Thumbs.db`, `data/` | Each developer sets these up locally as they wish. Local working data like downloaded license CSVs lives under `data/`. |

## Step-by-step

### 1. Clone & install
```bash
git clone https://github.com/harshilkikani/keres-ai.git
cd keres-ai
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

# generate your OWN strong secrets (don't reuse anyone else's):
openssl rand -hex 24      # paste into AUTH_TOKEN
openssl rand -hex 24      # paste into AUTH_COOKIE_SECRET
```

Edit `.env`:
- `DATABASE_URL` — already set to the docker container default; change if your Postgres is elsewhere.
- `AUTH_TOKEN` — your sign-in password. Long random string.
- `AUTH_COOKIE_SECRET` — signs session cookies + unsubscribe tokens. Long random string.
- `ORG_NAME`, `FROM_NAME`, `FROM_EMAIL`, `REPLY_TO`, `PHYSICAL_ADDRESS`, `OUTREACH_SUBDOMAIN`, `DEFAULT_BOOKING_LINK` — your sender identity.
- Provider toggles (`ENABLE_OSM` etc.) — leave default; flip to `true` only after you have credentials.

#### Sharing credentials with the team

`.env` is gitignored and must never be committed. For team-shared values:
- **Production (Fly.io)**: `flyctl secrets set ENABLE_SES=true SES_REGION=us-east-1 ...`
- **CI (GitHub Actions)**: `gh secret set DATABASE_URL --body "$value"`
- **Between teammates**: use 1Password / Bitwarden / AWS Secrets Manager. Never paste secrets in Slack or commit them.

If a real secret ever lands in a commit, rotate it immediately — git history is permanent on public repos.

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
