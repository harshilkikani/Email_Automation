# Account creation checklist

> Create accounts in the order below. **Stop at step 2** until you actually need to send real email. Every step beyond Fly + Neon is deferred until the launch gate forces you to set it up.

## Account map at a glance

| # | Account | When | Cost | Sensitive values |
|---|---|---|---|---|
| 1 | Fly.io | **now** (deploys the app) | ~$1.50/mo (auto-stop) | `FLY_API_TOKEN` (for CI deploy) |
| 2 | Neon | **now** (Postgres) | $0 (free tier) | `DATABASE_URL` |
| 3 | Cloudflare | **before domain** | $0 (free tier) | none until you wire Cron |
| 4 | Domain registrar | **before SES** | ~$10/year (excluded from $5/mo target) | none |
| 5 | AWS SES | **before real outbound** | $0.10/1k sends | SES access key + secret |
| 6 | Postmark | **before reply parsing** | $0 (free 10k/mo inbound) | inbound webhook token |
| 7 | Yelp Developer | **only if you turn on Yelp gap-fill** | $0 (free 500/day) | `YELP_API_KEY` |
| 8 | Hunter | **only if you turn on the Hunter fallback** | $0 (free 50/mo) | `HUNTER_API_KEY` |
| 9 | Bouncer | **only if you turn on paid verify** | $8 one-time PAYG | `BOUNCER_API_KEY` |

Anything beyond Fly + Neon stays off until you've finished Day-0 + Day-1-7 validation locally.

---

## 1. Fly.io — needed NOW

- Why: hosts the app on a single auto-stop machine (idle = $0 compute).
- Sign up at https://fly.io/app/sign-up.
- Provide a credit card (required even on free allowance; with `auto_stop_machines=stop` + `min_machines_running=0` the bill stays around $1.50/mo).
- Install CLI: `iwr https://fly.io/install.ps1 -useb | iex` (Windows) or `curl -L https://fly.io/install.sh | sh`.
- Authenticate **in your terminal**: `flyctl auth login` (opens browser, no value to paste).
- Do **not** enable:
  - Dedicated IPv4 (`fly ips allocate-v4`) — $2/mo, not needed for outbound.
  - Volumes — DB is on Neon, app is stateless.
  - Wireguard — not needed.
- Create app and deploy: `flyctl launch --no-deploy --copy-config` then `flyctl secrets set …` then `flyctl deploy`. Full sequence in `docs/FIRST-DEPLOYMENT-RUNBOOK.md`.
- For CI auto-deploy: `flyctl tokens create deploy` → set as `gh secret set FLY_API_TOKEN`. Generate **in your terminal**, copy from CLI output, paste into the `gh secret set` command — never into chat.

## 2. Neon — needed NOW

- Why: Postgres host with scale-to-zero, free tier.
- Sign up at https://console.neon.tech/signup (no credit card).
- Create a new project. Region: choose `aws-us-east-1` (same as Fly) for sub-millisecond latency.
- **Copy the pooled connection string** (ends in `-pooler.<region>.aws.neon.tech?sslmode=require`). The pooled URL is what the app uses. Do not paste it in chat.
- Set `DATABASE_DRIVER=neon-serverless` in Fly secrets so the app uses Neon's HTTP driver (avoids cold-start TCP handshakes).
- Optional Neon CLI for automated setup later: `npm i -g neonctl`. **Do not require an API key** unless you're scripting future provisioning. If you create an API key:
  - Generate at console.neon.tech/app/settings/api-keys → "Create new API key"
  - Store in `~/.config/neonctl/credentials.json` (CLI handles it)
  - Or as `NEON_API_KEY` env var in your shell (don't commit)
  - Revoke when finished automating

## 3. Cloudflare — before domain

- Why: free DNS, free Cron Triggers, free TLS. Used by SES for SPF/DKIM/DMARC records.
- Sign up at https://dash.cloudflare.com/sign-up.
- Add your domain (you can either transfer to Cloudflare Registrar or just use Cloudflare for DNS).
- Once Fly is deployed, point your `outreach.<your-domain>` to the Fly app:
  - `outreach.<your-domain>.com` → CNAME → `keres-ops.fly.dev` (proxied or DNS-only)
- Add the **SPF / DKIM / DMARC records** (you'll get these from SES in step 5).
- Add a Cron Trigger that hits `https://outreach.<your-domain>.com/api/health` at 7am M-F to keep the auto-stopped machine warm.
- Do **not** enable:
  - Workers Paid ($5/mo) — not needed.
  - Image Resizing — not needed.
  - Pro / Business plans — not needed.

## 4. Domain registrar — before SES

- Why: SES requires you to verify ownership of the sending domain.
- Cheapest: Cloudflare Registrar (at-cost ~$10/year).
- Don't send from your root domain. Use a dedicated subdomain (`outreach.<root>`) so reputation damage stays contained.
- No CLI needed.

## 5. AWS SES — before real outbound

- Why: the only outbound provider this product supports (Postmark + Resend are TOS-banned for cold).
- **Do not create yet** unless you're ready to send within ~24h.
- Sign up at https://aws.amazon.com.
- Open SES Console → "Verified identities" → add `outreach.<your-domain>` → publish the SPF + 3 DKIM CNAMEs + DMARC at Cloudflare.
- Open the **Production access request** ticket. AWS responds in ~24h.
- Create configuration set `keres-outreach`:
  - Event destination → SNS topic → HTTPS subscription → `https://outreach.<your-domain>.com/api/webhooks/ses`
  - Subscribe to: Bounce, Complaint, Delivery, Send, Reject, Open (ignored), Click (ignored)
- Create an IAM user with `AmazonSESFullAccess` (or scoped policy) → generate access key + secret. **One time only**.
- Do **not** enable:
  - Dedicated IP ($24.95/mo) — needed only above ~10k sends/day.
  - Virtual Deliverability Manager (paid).
  - Mail Manager paid endpoints.
  - VPC Lattice / VPC endpoints — not needed for outbound.

When done, set in Fly:
```
flyctl secrets set ENABLE_SES=true \
  SES_REGION=us-east-1 \
  SES_ACCESS_KEY_ID=<from-IAM> \
  SES_SECRET_ACCESS_KEY=<from-IAM> \
  SES_CONFIGURATION_SET=keres-outreach \
  SES_SNS_TOPIC_ARN=<from-SNS> \
  SES_PRODUCTION_ACCESS_CONFIRMED=true \
  --app keres-ops
```

The launch gate refuses any send until all of these are set together.

## 6. Postmark — before reply parsing

- Why: inbound parser only. Postmark outbound is TOS-banned for cold; outbound stays on SES.
- Sign up at https://postmarkapp.com/sign_up.
- Create a server → enable an Inbound stream → set webhook to `https://outreach.<your-domain>.com/api/webhooks/inbound`.
- Set the MX of your inbound subdomain (e.g. `inbound.outreach.<your-domain>`) to `inbound.postmarkapp.com`.
- Optional: protect the webhook with Basic Auth (set `POSTMARK_INBOUND_USERNAME` + `_PASSWORD`) or a webhook token.
- Do **not** enable outbound streams for cold outreach.

## 7. Yelp Developer — only if you use gap-fill

- Why: optional 500/day free queries; the no-store rule is enforced by the schema lint test.
- Apply at https://www.yelp.com/developers.
- API key: keep it local.
- The product disables Yelp by default (`ENABLE_YELP=false`). Only flip it on when you want to test the score-only enrichment.
- Do **not** enable Yelp paid tiers — quality of the free plan is sufficient for our ICP and the cache rule is the same anyway.

## 8. Hunter — only when free scrape isn't enough

- Why: 50 free credits/month for high-score leads where website scrape produced no email.
- Sign up at https://hunter.io/users/sign_up.
- Generate API key in account settings.
- Default disabled. Cost guard refuses to call Hunter unless `score >= 95` AND scrape failed AND monthly credits remain.

## 9. Bouncer — only if SMTP probes are too ambiguous

- Why: $8 PAYG for 1,000 verification credits, never expire, free for duplicates/unknowns.
- Sign up at https://www.usebouncer.com/.
- Add $8 PAYG once.
- Default disabled. Cost guard refuses to call Bouncer unless `score >= 80` AND free chain returned ambiguous AND monthly budget remaining.

---

## Account opening order if you want to send within a week

1. Day 0: **Fly + Neon** → deploy + DB. App is reachable.
2. Day 0: **Domain registrar + Cloudflare** → DNS infrastructure ready.
3. Day 0: **AWS** → file SES production-access ticket (24h turnaround).
4. Day 1 (during SES wait): **Postmark Inbound** → inbound stream + MX configured.
5. Day 1: import a TX TDLR Septic CSV via `POST /api/licenses/import` (no provider needed for this — TDLR is free).
6. Day 1: run Day 0 eyeball validation in the app.
7. Day 2: SES ticket approved → set `ENABLE_SES=true + SES_PRODUCTION_ACCESS_CONFIRMED=true` → seedlist test → reach-test campaign launches.
8. Day 3-7: collect reach-test data.

Defer Hunter / Bouncer / Yelp until Day-7+ if validation says scoring is predictive.

## Hard rules

- **Never** enable Apollo / Clay / LinkedIn / ZoomInfo / RocketReach — they violate our cost target and TOS for our ICP. The repo has CI tests asserting these adapter files don't exist.
- **Never** flip `SAMPLE_MODE=false` and `ENABLE_SES=true` and `SES_PRODUCTION_ACCESS_CONFIRMED=false` simultaneously — `validateConfig()` refuses to start.
- **Never** set `productionAccessConfirmed=true` in the UI until your AWS ticket is actually approved. The launch gate trusts your toggle.
- **Never** reuse dev secrets in production.
