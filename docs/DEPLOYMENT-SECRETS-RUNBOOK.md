# Deployment secrets runbook

> Step-by-step for getting every secret into the right place **without exposing it to chat, logs, or Git**. Run each command in your local terminal.

## Prerequisites

- [`docs/SECRET-HANDLING.md`](./SECRET-HANDLING.md) read end to end.
- Pre-commit hook installed (automatic via `pnpm install` → `postinstall`).
- `flyctl` authenticated (`flyctl auth login` opens browser).
- `gh` authenticated (`gh auth status` returns logged-in).

## Step 1 — Generate app-level secrets

```bash
# In your local terminal. Do not screenshot. Do not paste into chat.
pnpm secrets:gen --quiet > /tmp/keres.secrets
```

`pnpm secrets:gen --quiet` writes 3 `KEY=value` lines to stdout:
- `AUTH_TOKEN=...`
- `AUTH_COOKIE_SECRET=...`
- `UNSUBSCRIBE_SIGNING_SECRET=...`

Each value is 48 hex chars (192 bits of entropy).

Move these into 1Password / Bitwarden / pass under entries named `Keres / AUTH_TOKEN` etc. Then delete the temp file:

```bash
shred -u /tmp/keres.secrets             # Linux
rm -P /tmp/keres.secrets                # macOS
del /F /Q %TMP%\keres.secrets           # Windows
```

## Step 2 — Get the Neon DATABASE_URL

1. Open https://console.neon.tech.
2. Project → Dashboard → "Connection string" → choose **Pooled**.
3. Copy the connection string (`postgres://...neon.tech/...?sslmode=require`).
4. Paste into your password manager under `Keres / DATABASE_URL`.

Do **not** paste it into chat. The password is embedded in the URL.

## Step 3 — Set Fly secrets

`flyctl secrets set` accepts `KEY=value` pairs. Use the `--app` flag explicitly to avoid setting secrets on the wrong app.

```bash
# 1. Open your password manager. Have the 4 values ready: AUTH_TOKEN,
#    AUTH_COOKIE_SECRET, UNSUBSCRIBE_SIGNING_SECRET, DATABASE_URL.
#
# 2. In a terminal where bash history isn't synced anywhere, run:

read -s -p 'AUTH_TOKEN: '                  AUTH_TOKEN                && echo
read -s -p 'AUTH_COOKIE_SECRET: '          AUTH_COOKIE_SECRET        && echo
read -s -p 'UNSUBSCRIBE_SIGNING_SECRET: '  UNSUBSCRIBE_SIGNING_SECRET && echo
read -s -p 'DATABASE_URL: '                DATABASE_URL              && echo

flyctl secrets set \
  NODE_ENV=production \
  SAMPLE_MODE=false \
  ENABLE_SES=false \
  DATABASE_DRIVER=neon-serverless \
  DATABASE_URL="$DATABASE_URL" \
  AUTH_TOKEN="$AUTH_TOKEN" \
  AUTH_COOKIE_SECRET="$AUTH_COOKIE_SECRET" \
  UNSUBSCRIBE_SIGNING_SECRET="$UNSUBSCRIBE_SIGNING_SECRET" \
  PUBLIC_BASE_URL='https://keres-ops.fly.dev' \
  CORS_ORIGIN='https://keres-ops.fly.dev' \
  SERVE_WEB=true \
  PHYSICAL_ADDRESS='1 Real St, City, ST ZIP' \
  ORG_NAME='Keres AI' \
  FROM_NAME='Your Name at Keres AI' \
  FROM_EMAIL='hello@outreach.yourdomain.com' \
  REPLY_TO='replies@outreach.yourdomain.com' \
  OUTREACH_SUBDOMAIN='outreach.yourdomain.com' \
  SEEDLIST_EMAILS='you1@gmail.com,you2@outlook.com,you3@yourdomain.com' \
  --app keres-ops

# 3. Clear the local env vars:
unset AUTH_TOKEN AUTH_COOKIE_SECRET UNSUBSCRIBE_SIGNING_SECRET DATABASE_URL
```

The `read -s` flag hides input. The variables exist only for the duration of one command. They never enter your shell history.

After the `flyctl secrets set` call, Fly restarts the machine automatically (it takes ~10s).

## Step 4 — Verify Fly sees what you expect (without printing values)

```bash
flyctl secrets list --app keres-ops
```

This shows **only secret names + digest fingerprints**, never the values. The fingerprints change every time you `set` so you can confirm a rotation happened.

## Step 5 — GitHub Actions deploy secret

For automatic deploys on push to `main`:

```bash
# Generate a Fly deploy token (scoped, can be revoked):
flyctl tokens create deploy --app keres-ops

# Copy the token output (starts with FlyV1 fm2_...).
# Then immediately:
gh secret set FLY_API_TOKEN --repo harshilkikani/keres-ai --body "PASTE-HERE"
```

The `gh secret set` command takes the value via stdin or `--body`. Don't echo it.

Verify it's set (only the name, not the value):
```bash
gh secret list --repo harshilkikani/keres-ai
```

## Step 6 — When you're ready for SES (later)

Once your AWS SES production-access ticket is approved:

```bash
read -s -p 'SES_ACCESS_KEY_ID: '     SES_ACCESS_KEY_ID     && echo
read -s -p 'SES_SECRET_ACCESS_KEY: ' SES_SECRET_ACCESS_KEY && echo

flyctl secrets set \
  ENABLE_SES=true \
  SES_REGION=us-east-1 \
  SES_ACCESS_KEY_ID="$SES_ACCESS_KEY_ID" \
  SES_SECRET_ACCESS_KEY="$SES_SECRET_ACCESS_KEY" \
  SES_CONFIGURATION_SET=keres-outreach \
  SES_PRODUCTION_ACCESS_CONFIRMED=true \
  --app keres-ops

unset SES_ACCESS_KEY_ID SES_SECRET_ACCESS_KEY
```

The launch gate goes from "outbound_configured = fail" to "pass" within seconds.

## Step 7 — Postmark Inbound

```bash
read -s -p 'POSTMARK_INBOUND_TOKEN: ' POSTMARK_INBOUND_TOKEN && echo

flyctl secrets set \
  ENABLE_POSTMARK_INBOUND=true \
  POSTMARK_INBOUND_TOKEN="$POSTMARK_INBOUND_TOKEN" \
  INBOUND_ADDRESS='replies@outreach.yourdomain.com' \
  --app keres-ops

unset POSTMARK_INBOUND_TOKEN
```

## Step 8 — Optional providers (only when needed)

```bash
# Hunter (free 50/mo, used only when score >= 95 and scrape failed)
read -s -p 'HUNTER_API_KEY: ' HUNTER_API_KEY && echo
flyctl secrets set ENABLE_HUNTER=true HUNTER_API_KEY="$HUNTER_API_KEY" --app keres-ops
unset HUNTER_API_KEY

# Bouncer (PAYG, used only when score >= 80 and free chain ambiguous)
read -s -p 'BOUNCER_API_KEY: ' BOUNCER_API_KEY && echo
flyctl secrets set ENABLE_BOUNCER=true BOUNCER_API_KEY="$BOUNCER_API_KEY" --app keres-ops
unset BOUNCER_API_KEY

# Yelp (free 500/day, used as scoring-only signal — no caching of display fields)
read -s -p 'YELP_API_KEY: ' YELP_API_KEY && echo
flyctl secrets set ENABLE_YELP=true YELP_API_KEY="$YELP_API_KEY" --app keres-ops
unset YELP_API_KEY
```

## Rotation

```bash
# Rotate the cookie + unsub secrets together (forces all sessions to log out):
pnpm secrets:gen --quiet | grep -E '^(AUTH_COOKIE_SECRET|UNSUBSCRIBE_SIGNING_SECRET)' | while IFS== read -r k v; do
  flyctl secrets set "$k=$v" --app keres-ops
done
```

After rotation, update your password manager entries and **immediately verify** the app still boots (`flyctl logs --app keres-ops`).

## What this runbook deliberately avoids

- Pasting any value into Claude chat, Slack, email, or GitHub UI.
- Using `flyctl secrets set KEY="$(pbpaste)"` — clipboard managers (Alfred, Klipper, Windows clipboard history) retain values. Use `read -s` instead.
- Logging secrets to a file (`echo $AUTH_TOKEN > x` is forbidden).
- Reusing dev secrets in prod.
- Committing `.env` (the pre-commit hook also refuses this).

## Audit trail

After this runbook completes, every secret-relevant action has an audit row in `audit_log`:

```bash
flyctl ssh console --app keres-ops -C 'psql $DATABASE_URL -c "SELECT action, occurred_at FROM audit_log ORDER BY occurred_at DESC LIMIT 20"'
```

(That command runs psql inside the Fly VM with `$DATABASE_URL` already injected — no value crosses your terminal.)
