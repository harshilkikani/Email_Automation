# AWS SES Runbook

Exact clicks to set up SES once Cloudflare DNS for the outreach subdomain
is live.

**Do not start this runbook until:**
- `docs/DOMAIN-DECISION.md` has been read and `ROOT_DOMAIN` is chosen.
- `docs/CLOUDFLARE-DNS-RUNBOOK.md` has been run end-to-end and the SPF,
  DMARC, and MAIL-FROM MX records are live and resolving.
- The deployed `/api/launch-gate` shows only SES-side blockers
  (`outbound_configured`, `ses_production_access`, and the SES-specific
  DNS checks if applicable).

When you finish this runbook **`ENABLE_SES` stays `false`.** The flag is
only flipped after Phase 5 (mailbox simulator).

---

## Phase 0 — Account + IAM

1. Create or sign in to AWS. Use root only to bootstrap the org account.
2. Enable MFA on the root account.
3. Create an IAM user `keres-ops-sender`:
   - Access type: **Programmatic access only.** No console access.
   - No console password.
   - No groups; attach policies directly.
4. Attach a minimal inline policy. Save it as `keres-ses-policy`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "SesSend",
         "Effect": "Allow",
         "Action": [
           "ses:SendEmail",
           "ses:SendRawEmail",
           "ses:GetSendQuota",
           "ses:GetSendStatistics",
           "ses:GetAccountSendingEnabled"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

   No `ses:*FullAccess`. No `IAMFullAccess`. Nothing else.

5. After saving, AWS shows the access key ID and secret. **Do not paste
   either into chat.** Pipe them straight into Fly secrets with:

   ```powershell
   # PowerShell, on your machine — never echoed
   Read-Host -AsSecureString -Prompt 'SES_ACCESS_KEY_ID' | ConvertFrom-SecureString -AsPlainText | % { flyctl secrets set --stage --app keres-ops "SES_ACCESS_KEY_ID=$_" }
   Read-Host -AsSecureString -Prompt 'SES_SECRET_ACCESS_KEY' | ConvertFrom-SecureString -AsPlainText | % { flyctl secrets set --stage --app keres-ops "SES_SECRET_ACCESS_KEY=$_" }
   ```

   `--stage` queues them — they apply on the next deploy.

---

## Phase 1 — Region + verified identity

1. Top right region picker → **N. Virginia (us-east-1)**. Matches Fly
   `iad` and Neon `aws-us-east-1` for sub-1ms intra-AZ latency.
2. SES → **Verified identities** → **Create identity**.
3. Identity type: **Domain.**
4. Domain: `outreach.<ROOT_DOMAIN>` *(not the root domain)*.
5. **Use a custom MAIL FROM domain.** Set it to the same
   `outreach.<ROOT_DOMAIN>`. AWS will accept it because the MAIL-FROM MX
   record from the Cloudflare runbook is already in place.
6. **Identity-specific DKIM signing key: Easy DKIM.** Bit length: 2048
   (default).
7. SES shows three CNAMEs:

   ```
   <TOKEN1>._domainkey.outreach.<ROOT_DOMAIN>   →   <TOKEN1>.dkim.amazonses.com
   <TOKEN2>._domainkey.outreach.<ROOT_DOMAIN>   →   <TOKEN2>.dkim.amazonses.com
   <TOKEN3>._domainkey.outreach.<ROOT_DOMAIN>   →   <TOKEN3>.dkim.amazonses.com
   ```

   Paste each as a separate CNAME in Cloudflare → DNS → Records,
   **DNS only (grey cloud), not proxied**, TTL Auto.

8. Wait for SES → Verified identities to show:
   - Identity status: **Verified**
   - DKIM: **Successful**
   - MAIL FROM domain: **Verified**

   Usually < 15 minutes. Walk away and re-check.

---

## Phase 2 — Configuration set

1. SES → **Configuration sets** → **Create**.
2. Name: `keres-outreach`.
3. **Disable** dedicated IP pool. No dedicated IPs.
4. **Disable** Virtual Deliverability Manager (paid).
5. **Disable** Reputation Dashboard active features (paid). Read-only view is fine.
6. **Disable** SES Mail Manager (paid).
7. **Enable** Suppression list management → use account-level suppressions
   (free).
8. **Enable** Event publishing → continue to Phase 3.

Set `SES_CONFIGURATION_SET=keres-outreach` on Fly later.

---

## Phase 3 — SNS topics + event publishing

In `us-east-1`, create three SNS topics:

| name                    | filter when SES publishes |
| ----------------------- | ------------------------- |
| `keres-ses-bounce`      | Bounce                    |
| `keres-ses-complaint`   | Complaint                 |
| `keres-ses-delivery`    | Delivery (optional)       |

For each:
1. SNS → Topics → Create topic. **Type: Standard.**
2. Subscribe an HTTPS endpoint:
   `https://keres-ops.fly.dev/api/webhooks/ses` *(or your APP_DOMAIN)*.
3. **Raw message delivery: off.** SES SNS uses the wrapped envelope so
   the app can verify the signature against the certificate URL.
4. **Subscription confirmation:** SNS sends a POST to the endpoint with
   `Type=SubscriptionConfirmation`. The app already handles it
   (`packages/providers/src/ses-events.ts`). Ensure the Fly machine is
   awake when you confirm — hit `https://keres-ops.fly.dev/api/health`
   first.

Back in SES → Configuration sets → `keres-outreach` → **Event
destinations** → Add destination:
- Destination type: **Amazon SNS**.
- Events to publish: **Bounce, Complaint, Reject, Rendering Failure**.
  (Delivery + Send are optional; they cost SNS pennies per million but
  are useful for the dashboard.)
- Pick the matching topic per event.

---

## Phase 4 — Production access

1. SES → Account dashboard → **Request production access**.
2. Mail type: **Transactional and marketing**.
3. Website URL: `https://keres-ops.fly.dev` (or your APP_DOMAIN).
4. Use case description — honest, low-volume B2B targeted outreach:

   ```
   Keres AI is an internal sales tool. We send fewer than 500 targeted
   B2B emails per day to small-business owners (e.g. licensed septic
   contractors, plumbers) sourced from public state license registries
   and OpenStreetMap. Each recipient has:
     - A verifiable business license number from a state agency, or
     - A publicly-listed business phone number on OpenStreetMap, or
     - Both.

   Every email:
     - Carries a List-Unsubscribe header (RFC 8058 one-click).
     - Carries a CAN-SPAM-compliant physical postal address footer.
     - Is plain text (no HTML, no tracking pixels).
     - Identifies the sender personally and offers a clear path to opt
       out without replying.

   We have implemented:
     - One-click unsubscribe with HMAC-signed tokens.
     - Postmark Inbound parsing of reply bodies for opt-out language.
     - Automated suppression on SES SNS bounce + complaint webhooks.
     - 4% bounce-rate auto-pause threshold and 0.1% complaint-rate
       auto-pause threshold per campaign.
     - Per-domain daily send caps starting at 50/day with a slow warmup
       ramp.
     - A seedlist test that runs against Gmail, Outlook, and a
       custom-domain mailbox before every campaign launch.
     - A pre-launch gate that blocks sending unless DKIM, SPF, DMARC,
       and unsubscribe-endpoint health all pass.

   Expected initial volume: 50/day, ramping to ~500/day over 30 days.
   No purchased lists. No scraped consumer email addresses. No B2C.
   ```

5. Submit. AWS replies within ~24 hours (sometimes faster).
6. While waiting, SES is in sandbox: 200 sends/day, only to verified
   mailboxes. That's enough to run the mailbox simulator.

**Do not flip `SES_PRODUCTION_ACCESS_CONFIRMED=true`** until AWS has
approved and the launch gate's `ses_production_access` check is the only
thing left.

---

## Phase 5 — Mailbox simulator (the actual go/no-go test)

Run this **before** `ENABLE_SES=true`. AWS provides four addresses that
always respond a specific way:

| address                                  | expected outcome                                    |
| ---------------------------------------- | --------------------------------------------------- |
| `success@simulator.amazonses.com`        | accepted, no event                                  |
| `bounce@simulator.amazonses.com`         | hard bounce — SNS posts to `keres-ses-bounce`       |
| `complaint@simulator.amazonses.com`      | complaint — SNS posts to `keres-ses-complaint`      |
| `suppressionlist@simulator.amazonses.com`| SES-side suppression — handled internally           |

Procedure:

1. While SES is still in sandbox, verify each simulator address as a
   recipient (SES → Verified identities → Create → Email address). They
   verify instantly because they're AWS-owned.
2. From your local machine, run a one-off seedlist send to each address.
   *(Will require a real outreach domain + verified DKIM and a working
   `ENABLE_SES=true`. Yes — you DO flip the flag for this phase, briefly,
   in sandbox mode. Production access is not required for the simulator.)*

   Recommended: do this from `flyctl ssh console` against the deployed
   app, then immediately `unset` `ENABLE_SES` once the test is done.

3. Check the deployed app's `/api/webhooks/ses` audit logs and confirm:
   - The bounce simulator triggered a `bounce` event row.
   - The complaint simulator triggered a `complaint` event row + the lead
     went to `dnc` status.
   - The success simulator triggered a `send` event row.

4. **Only after all three behaviors are observed** should you:
   - Wait for AWS production access approval.
   - Flip `SES_PRODUCTION_ACCESS_CONFIRMED=true` and `ENABLE_SES=true`
     for real send.
   - Run a seedlist test (see `docs/SEEDLIST-RUNBOOK.md`).

---

## What stays OFF

- ❌ **Dedicated IP / IP Pool.** Pay-per-month. Need ~50k/mo to make sense.
- ❌ **Virtual Deliverability Manager (VDM).** Pay-per-message dashboard
  feature. Not needed.
- ❌ **SES Mail Manager.** Paid relay / archive product. Not used.
- ❌ **SESv2 Reputation Dashboard active monitors.** Read-only is free;
  enabling alerts is paid.
- ❌ **Send / Render templates.** This app renders templates server-side;
  do not also store them in SES.
- ❌ **Multi-region SES.** One region only.
- ❌ **`ses:*FullAccess` IAM policy.** Use the minimal one above.

---

## What stays OFF on the Keres side too

- `ENABLE_SES=true` — only after Phase 5 passes.
- `SES_PRODUCTION_ACCESS_CONFIRMED=true` — only after AWS approves
  production access **and** all DKIM/SPF/DMARC are green in
  `/api/launch-gate`.
- `ENABLE_HUNTER`, `ENABLE_BOUNCER`, `ENABLE_YELP`, `ENABLE_PLACES` —
  out of scope for this runbook. See per-provider docs when relevant.
- `ENABLE_POSTMARK_INBOUND=true` — only after the Postmark Inbound MX
  record is added (see `docs/CLOUDFLARE-DNS-RUNBOOK.md` section 4).

When you are ready to flip the flag for the simulator test, ping me. I
will run the `flyctl secrets set` with the values from your local file
(never echoed) and stage the change for a single deploy.
