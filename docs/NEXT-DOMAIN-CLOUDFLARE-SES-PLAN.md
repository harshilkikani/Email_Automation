# Next: Domain → Cloudflare DNS → AWS SES Plan

This is the exact next-human checklist. **None of it has been executed yet.**
Read end-to-end before clicking anything. Do not paste keys into chat.

Current state recap:
- App live at https://keres-ops.fly.dev/
- Neon connected, migrations applied, seed run.
- `ENABLE_SES=false`, `SAMPLE_MODE=false`. Real outbound impossible.
- 8 launch-gate blockers remain. All of them flip safely after the steps
  below — none of them require paid services upfront.

---

## 1. Domain decision

### Option A *(recommended)* — separate outreach domain

Buy a brand-new domain dedicated to outbound. e.g. `keres-outreach.com`,
`keresai-reach.com`, anything that is **not** your day-to-day company
domain. Then send from a subdomain of it — e.g. `outreach.keres-outreach.com`.

**Why a separate domain:**
- Cold sends carry reputation risk. If a major provider (Gmail, Yahoo,
  Microsoft) blocks the sending domain, you do not want your invoices and
  customer support email to break at the same time.
- DMARC alignment is per-organizational-domain, so a dedicated domain lets
  you adopt a stricter `p=reject` DMARC policy on the outreach domain
  without touching your main domain.
- Sub-domains on the outreach domain (e.g. `outreach.`, `mail.`,
  `notifications.`) can be cycled independently if anything ever goes
  sideways.

**Approx cost:** $10–15/yr at any registrar.
**Recommended registrars:** Cloudflare Registrar (sells at wholesale, no
markup, free WHOIS privacy), Porkbun, Namecheap.

### Option B — subdomain of your existing domain

Use a subdomain off a domain you already own. e.g. `outreach.<your-domain>`.
You still get SPF/DKIM/DMARC isolation at the subdomain level, but the
DMARC policy on the apex still applies. Acceptable if your main domain has
no commercial-email reputation cost.

### Option C *(do not pick)* — root domain of your real business

Sending cold email directly from `@<your-company>.com` puts your everyday
inbox reputation on the line. Don't.

### Decision artefact you must produce

```
ROOT_DOMAIN          = <your choice, e.g. keres-outreach.com>
OUTREACH_SUBDOMAIN   = outreach.<ROOT_DOMAIN>
APP_HOST             = keres-ops.fly.dev   ← stays on Fly; you can later point a CNAME like ops.<ROOT_DOMAIN> → keres-ops.fly.dev
```

These three strings are referenced everywhere below.

---

## 2. Cloudflare setup

### 2.1 Account + zone

1. Create / sign in to Cloudflare (free plan is enough).
2. **Add the `ROOT_DOMAIN` as a zone.** Cloudflare lists the nameservers
   to enter at your registrar.
3. At the registrar, change the domain's nameservers to Cloudflare's.
4. Wait for Cloudflare to show "Active" (usually < 1 hour).

### 2.2 DNS records — placeholders, no SES yet

Add these now. They are not enough to send; SES needs three more DKIM
CNAMEs that you can't generate until step 3 runs.

| type | name                         | value                                                         | proxy | notes |
| ---- | ---------------------------- | ------------------------------------------------------------- | ----- | ----- |
| `CNAME` | `ops.<ROOT_DOMAIN>`        | `keres-ops.fly.dev`                                           | OFF (DNS-only) | optional pretty hostname for the app |
| `TXT`  | `<OUTREACH_SUBDOMAIN>`     | `v=spf1 include:amazonses.com -all`                           | n/a   | SPF, hard-fail |
| `TXT`  | `_dmarc.<ROOT_DOMAIN>`     | `v=DMARC1; p=none; rua=mailto:dmarc-rua@<ROOT_DOMAIN>; ruf=mailto:dmarc-ruf@<ROOT_DOMAIN>; fo=1; aspf=r; adkim=r;` | n/a | start at `p=none` — moves to `quarantine` / `reject` after two clean weeks |
| `MX`   | `<OUTREACH_SUBDOMAIN>`     | `feedback-smtp.us-east-1.amazonses.com` (priority `10`)       | n/a   | needed for SES SMTP feedback path on the subdomain |

**Do not** enable Cloudflare Email Routing on the outreach subdomain (it
would intercept mail before Postmark inbound).

**Do not** buy any Cloudflare paid add-on. The free plan covers everything
this project needs: DNS, free Cron Triggers, free Cloudflare Workers if we
ever decide to add a tiny relay (we don't plan to).

### 2.3 Cron wakeup (free)

Cloudflare Cron Triggers can ping the Fly app every weekday at 07:00 local
to keep the auto-stopped machine warm before you start work. **Set this
up only after the app domain is decided.** Either:

- A Cloudflare Worker with one fetch to `https://keres-ops.fly.dev/api/health`,
  scheduled by `0 12 * * 1-5` (12:00 UTC = 07:00 US Central). Free up to
  100k req/day.
- Or `Pages Functions` with a scheduled handler. Same end result.

Until you set this up, the machine cold-starts on the first real request,
which adds ~2 s latency once per work session. Tolerable.

---

## 3. AWS SES setup — plan only, do not execute

These are the steps in order. Each one is a click in the AWS console;
none of them are scripted yet, and **none should run until** the domain is
chosen and Cloudflare DNS is live.

### 3.1 Account

1. Create an AWS account if you don't have one. **Use the root account
   only to set up the org account; never use it day-to-day.**
2. Enable MFA on the root account.
3. Create an IAM user `keres-ops-sender` with **programmatic access only**
   — no console access. This is the user whose access keys you will paste
   into Fly secrets later.
4. Attach a minimal-scope policy. Don't use `AmazonSESFullAccess`; instead
   limit to:
   - `ses:SendEmail`, `ses:SendRawEmail`
   - `ses:GetSendQuota`, `ses:GetSendStatistics`
   - on resources scoped to the SES configuration set ARN.
   The exact policy template will land in this repo under
   `docs/aws/ses-iam-policy.json` when we get there.

### 3.2 Region

- **Region: `us-east-1`** (N. Virginia). Matches both Fly `iad` and Neon
  `aws-us-east-1` — same physical region, sub-1ms intra-AZ latency.
- Do not enable SES in multiple regions.

### 3.3 Verified identity

1. In SES → Verified identities → Create identity.
2. **Identity type: Domain.** Domain = `<OUTREACH_SUBDOMAIN>` (not root).
3. **Use Easy DKIM.** Lets SES manage the three rotating DKIM keys.
4. AWS shows three CNAME records (`s1._domainkey`, `s2._domainkey`,
   `s3._domainkey`). Add each as a Cloudflare CNAME with proxy OFF.
5. Wait for SES to verify the identity (usually < 10 min).

### 3.4 Production access

1. SES → Account dashboard → Request production access.
2. Form asks for use case ("transactional vs. marketing", complaint /
   bounce handling, recipient list quality). Be honest: "B2B cold outreach
   to verified-license sole-proprietor business mailboxes; suppressions
   via Postmark inbound; one-click unsub via RFC 8058".
3. AWS responds within 24 h. Until then, SES is in sandbox: 200 sends/day,
   only to verified addresses.
4. **Do not** flip the app's `SES_PRODUCTION_ACCESS_CONFIRMED` flag until
   AWS has approved.

### 3.5 Configuration set

1. SES → Configuration sets → Create. Name: `keres-outreach`.
2. **Disable** dedicated IP — you do not want one until you exceed
   ~50k sends/month.
3. **Disable** Virtual Deliverability Manager. It costs extra and is not
   needed at this scale.
4. **Disable** SES Mail Manager. Same reason.
5. **Enable** event publishing → destination: SNS topic (see next).

### 3.6 SNS topics for webhooks

Create three SNS topics in `us-east-1`:
- `keres-ses-bounce`
- `keres-ses-complaint`
- `keres-ses-delivery`

Each subscribes to `https://keres-ops.fly.dev/api/webhooks/ses` with the
SES SNS signature verification path. The app already has
`packages/providers/src/ses-events.ts` for verifying these — verified by
the unit tests in `packages/providers/test/sns-verify-positive.test.ts`.

**Subscription confirmation:** SES → SNS sends a POST with
`Type=SubscriptionConfirmation`. The handler must call the `SubscribeURL`
once to confirm. This is already implemented; just ensure the Fly machine
is awake when you confirm (hit `/api/health` first).

### 3.7 Mailbox simulator (test first, don't use real recipients)

After production access and DKIM verified, run a send via SES Mailbox
Simulator before touching real recipients:
- `success@simulator.amazonses.com` (delivered)
- `bounce@simulator.amazonses.com` (bounce event arrives via SNS)
- `complaint@simulator.amazonses.com` (complaint event arrives via SNS)
- `suppressionlist@simulator.amazonses.com` (SES suppression path)

Only after all four simulator paths return the expected webhooks do you
flip `ENABLE_SES=true` for the first real send.

### 3.8 Hard "off" switches that stay off

- `ses:CreateDeliverabilityTestReport` — paid; don't call.
- Dedicated IP Pool — paid; don't create.
- Virtual Deliverability Manager — paid; don't enable.
- Mail Manager — paid; don't enable.
- SESv2 Reputation Dashboard (in newer SES UIs) — free read-only is fine,
  do not enable any active feature.

---

## 4. Seedlist plan

The launch gate's `seedlist_configured` and `seedlist_test_recent` checks
require real mailboxes that you actually log into. Three is the minimum.

1. **Gmail** — create or use a free `gmail.com` mailbox. Place it in
   `SEEDLIST_EMAILS`.
2. **Outlook / Hotmail** — create or use an `@outlook.com` mailbox. Same.
3. **Custom domain** — a mailbox at `<ROOT_DOMAIN>` (other than the
   outreach subdomain). E.g. `kpi@<ROOT_DOMAIN>`. This validates that DNS
   alignment works for the same-domain destination, which is what your
   real recipients are most likely to use.

After each seedlist test send (manual click in the UI), log placement
manually in `Deliverability → Seedlist log`:
- Inbox / Promotions / Updates / Spam — for Gmail.
- Inbox / Focused / Other / Junk — for Outlook.

**Do not fabricate a passing seedlist.** The gate must reflect real
placements, otherwise you'll cold-send before your DKIM/SPF/DMARC are
actually aligned and end up with permanent reputation damage.

---

## 5. Physical address + sender identity

These satisfy CAN-SPAM and the launch gate.

| field             | where                                          | example                                          | sensitive? |
| ----------------- | ---------------------------------------------- | ------------------------------------------------ | ---------- |
| `physicalAddress` | UI Settings → Sender identity                  | `123 Main St Suite 5, Houston, TX 77002`         | low — appears in every email footer |
| `fromName`        | UI Settings → Sender identity                  | `Keres AI`                                       | low |
| `fromEmail`       | UI Settings → Sender identity                  | `hello@<OUTREACH_SUBDOMAIN>`                     | low |
| `replyTo`         | UI Settings → Sender identity                  | `replies@<OUTREACH_SUBDOMAIN>` (Postmark inbound) | low |
| `outreachSubdomain` | UI Settings → Deliverability                 | `<OUTREACH_SUBDOMAIN>`                           | low |
| `defaultBookingLink` | UI Settings → Sender identity               | `https://cal.<ROOT_DOMAIN>/intro`                | low |

None of these are secrets. They are public-facing values. They still
should be entered in the UI rather than typed into chat, because the chat
transcript is harder to redact later if something needs to change.

---

## 6. Budget plan

The app reads these from env / Fly secrets. Recommended caps for the
first 60 days:

| var                          | recommended value          | what blows up if you exceed |
| ---------------------------- | -------------------------- | --------------------------- |
| `BUDGET_MODE`                | `free`                     | bounce/complaint thresholds tighten automatically |
| `DAILY_SEND_CAP_DEFAULT`     | `50`                       | per-domain daily cap; ramped via warmup |
| `BOUNCE_PAUSE_PCT`           | `4`                        | campaigns auto-pause above this 24-h bounce rate |
| `COMPLAINT_PAUSE_PCT`        | `0.1`                      | SES kills your account above ~0.3% |
| `ENABLE_HUNTER`              | `false`                    | leave off — 25 free credits/month is too small to risk burning |
| `HUNTER_MONTHLY_FREE_CREDITS`| `25` *(if you ever enable)*| budget guardrail |
| `ENABLE_BOUNCER`             | `false`                    | leave off — paid per-lookup |
| `BOUNCER_MONTHLY_BUDGET_USD` | `5`                        | cap if/when enabled |
| `ENABLE_YELP`                | `false`                    | leave off — Yelp Fusion paid tier |
| `YELP_MONTHLY_BUDGET_USD`    | `0`                        | guardrail at zero |
| `ENABLE_PLACES`              | `false`                    | leave off — Google Places paid |
| `PLACES_MONTHLY_BUDGET_USD`  | `0`                        | guardrail at zero |
| Twilio / Apollo / Clay / LinkedIn / ZoomInfo / RocketReach / Resend / Postmark outbound | not in repo | none of these are integrated |

Fly compute + Neon free tier total roughly **$1.50/mo** in the
no-real-send state, and rise to roughly **$3–4/mo** once SES is live and
sending ~1k emails/day. Cloudflare DNS + Cron stays $0.

---

## 7. Exact next command sequence (after the domain is chosen)

Run these one at a time, top-down. Stop at any failure and inspect.

```bash
# 7.1  Update local Fly secrets for the chosen domain (no value leaves your terminal)
flyctl secrets set --stage --app keres-ops \
  ORG_NAME="Keres AI" \
  FROM_NAME="Keres AI" \
  FROM_EMAIL="hello@outreach.<ROOT_DOMAIN>" \
  REPLY_TO="replies@outreach.<ROOT_DOMAIN>" \
  OUTREACH_SUBDOMAIN="outreach.<ROOT_DOMAIN>" \
  PUBLIC_BASE_URL="https://keres-ops.fly.dev" \
  CORS_ORIGIN="https://keres-ops.fly.dev"

# 7.2  Update the org row in Neon to match (via the UI is easier, but here's the API)
#      Use the auth cookie you already have, don't paste AUTH_TOKEN.
curl -X PUT https://keres-ops.fly.dev/api/settings \
  -H 'Content-Type: application/json' --cookie-jar /tmp/keres.cookies \
  -d '{ "fromEmail":"hello@outreach.<ROOT_DOMAIN>", "replyTo":"replies@outreach.<ROOT_DOMAIN>", "outreachSubdomain":"outreach.<ROOT_DOMAIN>", "physicalAddress":"<your real US business address>" }'

# 7.3  Re-check the gate. ses_production_access + outbound_configured should still fail,
#      everything else should pass (DNS warns until Cloudflare records propagate).
curl https://keres-ops.fly.dev/api/launch-gate --cookie /tmp/keres.cookies | jq '.gate.checks[] | { code, state }'

# 7.4  Then — and only then — start AWS SES (sections 3.1 → 3.4 above).
#      DO NOT set ENABLE_SES=true until 3.7 mailbox simulator passes for all four cases.
```

---

## What I will NOT do until you tell me to

- Buy any domain.
- Touch any Cloudflare zone.
- Create any AWS account or SES configuration.
- Set `ENABLE_SES=true`, `SES_*`, or any paid-provider env.
- Configure Postmark, Hunter, Bouncer, Yelp, or Google Places.
- Send any real email.
- Ask you to paste a secret into chat.

When you have chosen a `ROOT_DOMAIN` and added the four Cloudflare DNS
records, tell me. I'll run section 7.1 + 7.2 for you with the values
pulled from your local files (never echoed), re-run the gate check, and
report what flipped.
