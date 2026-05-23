# First validation run — Septic / Houston

> The exact step-by-step. Each step links to the operator screen that fixes it. The same checklist is rendered live at `/first-run` in the app — `first-run` is the source of truth; this doc is the offline mirror.

## 0. Before you start

You should have:
- A registered domain (any registrar; Cloudflare Registrar = cheapest).
- A Cloudflare account for DNS.
- An AWS account.
- A Postmark account (Inbound stream only — Postmark outbound is TOS-banned for cold).
- A Bouncer account ($8 PAYG, optional but recommended).
- 3 controlled mailboxes for seedlist observation (Gmail + Outlook + a custom-domain).

Cost target: ~$3.40/mo at 1k qualified leads.

## 1. Spin up infra

```bash
# Postgres
docker compose up -d postgres        # local
# (or sign up at neon.tech for prod)

cp .env.example .env
# generate strong secrets
openssl rand -hex 24                 # paste as AUTH_TOKEN
openssl rand -hex 24                 # paste as AUTH_COOKIE_SECRET

pnpm install
pnpm db:migrate
pnpm db:seed
pnpm doctor                          # confirm everything green
```

## 2. Set sender identity

`/settings` →
- Org name, From name, From email (`hello@outreach.yourdomain.com`)
- Reply-To (`replies@outreach.yourdomain.com`)
- **Physical mailing address** (CAN-SPAM-required)
- Outreach subdomain (`outreach.yourdomain.com`)
- Default booking link

## 3. Add the outreach subdomain

`/deliverability` → "Add an outreach subdomain" → `outreach.yourdomain.com`.

DNS records to publish at your registrar:
```
outreach.yourdomain.com  TXT   "v=spf1 include:amazonses.com -all"
s1._domainkey.outreach   CNAME  s1.<your-ses-region>.amazonses.com
s2._domainkey.outreach   CNAME  s2.<your-ses-region>.amazonses.com
s3._domainkey.outreach   CNAME  s3.<your-ses-region>.amazonses.com
_dmarc.yourdomain.com    TXT   "v=DMARC1; p=none; rua=mailto:rua@yourdomain.com"
```

Click "Check DNS" — all five tiles green.

## 4. Open SES production access

AWS SES Console → Account dashboard → "Request production access". When approved (~24h), toggle `Settings → Compliance → Production access confirmed`.

Set the SES configuration set name in `SES_CONFIGURATION_SET` (default: `keres-outreach`). Create that configuration set with event destinations for Bounce / Complaint / Delivery / Send, pointing at an SNS topic that posts to `https://<your-host>/api/webhooks/ses`.

## 5. Postmark Inbound

Postmark → Server → enable an Inbound stream → set the inbound webhook to `https://<your-host>/api/webhooks/inbound`. Set the MX of `inbound.outreach.yourdomain.com` (or whatever address you put in `INBOUND_ADDRESS`) to `inbound.postmarkapp.com`.

## 6. Send the seedlist test

`/deliverability` → click "Send seedlist test" on your sender domain.

Open each seed mailbox manually. In `/deliverability` (under the domain) click the placement that matches what you observed: `primary` / `promotions` / `spam` / `missing`.

Goal: ≥ 80% of observations in `primary`. If `spam` ≥ 40%, **STOP** and audit DNS — that's what the gate will tell you.

## 7. Import TX Septic licensees

```bash
# Download CSV from TDLR (manual; see docs/LICENSE-SOURCES.md → TX → TDLR)
curl -s -u :$AUTH_TOKEN \
  -X POST https://<host>/api/licenses/import \
  -H 'content-type: application/json' \
  -d "$(jq -Rs --arg s TX --arg n Septic '{state:$s, niche:$n, csv:.}' < tx-septic.csv)"
```

## 8. Discovery

`/discover` → Niche=Septic, City=Houston, State=TX, Target=50. Click "Run discovery".

You should see ~25 leads inserted (the OSM yield), ~half scored ≥ 80 if licenses imported.

## 9. Day 0 eyeball review

`/validation` → New experiment (`Septic — Houston Day 0`, phase=eyeball). Top 50 leads load. Rate each A / B / C / D — add reason tags for C/D.

Verdict:
- ≥ 70% A+B → proceed to step 10.
- 50-69% → tune scoring weights via signal-outcome (Refine phase) before sending.
- < 50% → stop and re-investigate (likely OSM tag mapping or wrong city).

## 10. Build the reach-test campaign

Same Validation page → switch phase to "reach" → click "Build campaign". 100-send stratified (Top 40 / Mid 30 / Bottom 20 / Control 10) + seedlist insertion.

## 11. Final launch gate

`/diagnostics` → every check green.

`/campaigns` → click the campaign → Launch. If any blocker fires, the UI tells you exactly which DNS record / setting to fix.

## 12. Monitor

Daily, for 7 days:
- `/inbox` → triage replies (j / k to navigate, i = interested, h = hostile + auto-suppress, etc.)
- `/diagnostics` → confirm bounce / complaint rates stay safe.
- `/costs` and `/provider-usage` → confirm budget is on plan.

## 13. Day 7 verdict

Targets (from VALIDATION-PLAN.md):
- Inbox placement ≥ 80% on the seedlist.
- Bounce rate < 5%.
- ≥ 1 reply.

If green → proceed to the 500-send engagement test (`/validation` → phase=engagement → Build campaign).
If not → don't send more. Audit DNS, copy, or targeting.

## 14. After Day 21

If top-bucket reply rate ≥ 5% and the top-mid gap ≥ 3pp, the scoring engine is validated. Generate the signal-outcome CSV from Validation → Export and decide whether to refine weights via the Refine phase.

If the gap isn't there, the scoring isn't predictive — either send to everyone or hunt for new signals.

---

The wizard at `/first-run` walks through all of this with live status and deep-links.
