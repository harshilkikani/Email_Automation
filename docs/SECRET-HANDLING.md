# Secret handling

> Rule zero: **do not paste secrets into Claude chat, Slack, email, or any chat tool.** Use your password manager, your terminal, or the provider dashboard.

## What counts as a secret

| Class | Examples |
|---|---|
| App-level | `AUTH_TOKEN`, `AUTH_COOKIE_SECRET`, `UNSUBSCRIBE_SIGNING_SECRET` |
| DB | `DATABASE_URL` (contains password) |
| Provider creds | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `POSTMARK_INBOUND_TOKEN`, `HUNTER_API_KEY`, `BOUNCER_API_KEY`, `YELP_API_KEY` |
| Deploy | `FLY_API_TOKEN`, `NEON_API_KEY` |

If any of these end up in a public Git repo, a public chat log, or a screenshot — **rotate immediately**, then audit what was exposed.

## The safe handling pattern

```
+--------------------+                +---------------------+
| Your local shell   | --- secret --> |  Provider dashboard |
| (`openssl rand`)   |                |  Fly secrets        |
|                    |                |  GitHub secrets     |
|                    |                |  1Password etc.     |
+--------------------+                +---------------------+
        |
        |  NEVER goes here:
        v
+-------------------------------+
|  Claude chat, Slack, email,   |
|  screenshots, git commits,    |
|  unencrypted Notes, screen    |
|  shares, browser autocomplete |
+-------------------------------+
```

## How to generate strong values

Run **on your machine, in your terminal:**

```bash
pnpm secrets:gen
```

This prints three values to stdout:
- `AUTH_TOKEN` (48 hex chars / 192 bits) — your sign-in password
- `AUTH_COOKIE_SECRET` (48 hex chars) — signs session cookies
- `UNSUBSCRIBE_SIGNING_SECRET` (48 hex chars) — signs unsubscribe + seedlist tokens

Pipe them anywhere you need:

```bash
# Direct into Fly:
pnpm secrets:gen --quiet | while IFS== read -r k v; do
  flyctl secrets set "$k=$v" --app keres-ops
done

# Into your password manager (1Password CLI example):
pnpm secrets:gen --quiet | while IFS== read -r k v; do
  op item create --category password --title "Keres $k" password="$v"
done

# Into your clipboard one at a time (then paste into 1Password's GUI):
pnpm secrets:gen --quiet | grep AUTH_TOKEN | cut -d= -f2 | clip          # Windows
pnpm secrets:gen --quiet | grep AUTH_TOKEN | cut -d= -f2 | pbcopy        # macOS
pnpm secrets:gen --quiet | grep AUTH_TOKEN | cut -d= -f2 | xclip -sel c  # Linux
```

The script **never** logs the value back to your screen if you use `--quiet`.

## How to copy a secret from a provider dashboard

Most providers (Neon, Fly, AWS, Postmark, Hunter, Bouncer, Yelp) show the secret **once** in their console after generation. The safe handling sequence:

1. Open the provider dashboard in your browser.
2. Generate the key. Leave the tab open.
3. In your terminal:
   ```bash
   flyctl secrets set DATABASE_URL='paste-value-here' --app keres-ops
   ```
   (Or use `read -s` to avoid bash history capture: see below.)
4. **Close the provider tab.** Don't bookmark a page that shows the secret.
5. If the provider lets you save it for later viewing, prefer to *not* save it — regenerate when you need it.

### Bash trick to avoid history capture

```bash
read -s -p 'paste DATABASE_URL > ' DATABASE_URL
flyctl secrets set "DATABASE_URL=$DATABASE_URL" --app keres-ops
unset DATABASE_URL
```

`-s` hides the input from your terminal. The value never appears in your shell history.

## Where each secret should live

| Secret | Where in production | Where in CI | Where on your laptop |
|---|---|---|---|
| `AUTH_TOKEN` | `flyctl secrets set` | — | password manager |
| `AUTH_COOKIE_SECRET` | `flyctl secrets set` | — | password manager |
| `UNSUBSCRIBE_SIGNING_SECRET` | `flyctl secrets set` | — | password manager |
| `DATABASE_URL` | `flyctl secrets set` | `gh secret set` for integration tests | password manager |
| SES creds | `flyctl secrets set` | — | password manager (rotate after each season) |
| `FLY_API_TOKEN` | — | `gh secret set FLY_API_TOKEN` | password manager |
| `NEON_API_KEY` (optional) | — | `gh secret set NEON_API_KEY` if you automate Neon | password manager |

Local `.env` is fine **only** for dev secrets you generated yourself. The pre-commit hook refuses any commit that tries to add a `.env` file.

## Rotation procedure

1. Generate the new value: `pnpm secrets:gen` (or provider dashboard).
2. Set the new value:
   ```bash
   flyctl secrets set AUTH_TOKEN='<new>' --app keres-ops   # automatic restart
   ```
3. Update your password manager entry.
4. If the secret was leaked: revoke at the provider, audit access logs, force-log-out users (the cookie secret rotates session validity automatically when you replace `AUTH_COOKIE_SECRET`).

For DB rotation (Neon → reset password), do this **out of business hours**:
1. Reset DB password in Neon dashboard.
2. Copy new pooled connection string.
3. `flyctl secrets set DATABASE_URL='<new>' --app keres-ops` → Fly restarts.
4. ~10 seconds of downtime on the auto-stopped machine.

## What to do if a secret leaks

| Leak | Action |
|---|---|
| Pasted in a chat | **Revoke immediately.** Regenerate. Update Fly + password manager. Audit access logs. |
| Committed to git | Revoke. Regenerate. `git push --force` will NOT remove it from history — use `git filter-repo` + force-push + email collaborators + rotate. |
| Public repo | Same as above + assume bots have already scraped it. Revoke first. |
| Visible in `git log -p` | Revoke. Same procedure. |
| Lost (deleted accidentally) | Generate new. Update Fly. No leak risk, just unavailability. |

## Pre-commit defense

The repo ships a pre-commit hook (`scripts/pre-commit.sh`, installed via `postinstall`) that refuses commits containing:
- `.env` files (other than `.env.example`)
- AWS access keys (`AKIA…`)
- GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghr_`)
- Stripe/OpenAI/Anthropic patterns (`sk_…`, `sk-`)
- Slack tokens (`xoxb-`, `xoxp-`)

Bypass is technically possible (`git commit --no-verify`) but **don't**. If you need to bypass for a legitimate reason, document why in the commit message.

## What NOT to do

- Paste a secret into Claude chat (or any LLM chat tool that retains history).
- Email a secret.
- Slack a secret.
- Screenshot a value.
- Put a value in a GitHub issue / PR body / comment.
- Put a value in CI environment variables that are visible to logs.
- Reuse a dev secret in production.
- Use the same value for `AUTH_TOKEN`, `AUTH_COOKIE_SECRET`, and `UNSUBSCRIBE_SIGNING_SECRET` — they protect different things.
- Trust a value you generated with `head -c 20 /dev/random` — the script uses `crypto.randomBytes(24)` for cryptographic strength.
