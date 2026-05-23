# Seedlist Runbook

The seedlist is a small set of mailboxes you actually log into. Before
any campaign launches, the app sends a test message to every one of them
and the launch gate refuses to proceed unless the most recent test in the
last 7 days reported a `success` event from SES.

**Why this matters more than it sounds.** SES will tell you the message
was accepted (`send` event) even when Gmail silently routes it to Spam.
The only way to know placement is to look. The seedlist is the cheapest
honest signal you have.

**Hard rule: never fake a passing seedlist.** If you mark
`last_seedlist_pass_at` manually without actually checking placement,
you'll go live with bad DKIM alignment and tank your sender reputation
in 24 hours.

---

## Required mailboxes

At minimum three mailboxes. More is better. Pick from:

| inbox provider           | mailbox                                        | why include                                    |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| **Gmail**                | a free `@gmail.com` you own                    | dominant B2B inbox, strictest reputation rules |
| **Outlook / Hotmail**    | a free `@outlook.com` you own                  | Microsoft 365 routing differs from Gmail's      |
| **Yahoo / AOL**          | a free `@yahoo.com` or `@aol.com` (optional)   | overlaps with Outlook on Yahoogroup routing     |
| **Custom domain**        | a mailbox at `<ROOT_DOMAIN>` (Cloudflare Email Routing → your real inbox) | tests same-domain alignment + verifies your DNS works for inbound, not just outbound |

A typical config:

```
SEEDLIST_EMAILS=keres.seed.gmail@gmail.com,keres.seed@outlook.com,kpi@<ROOT_DOMAIN>
```

Stored in **Fly secrets**, not in the repo. Never paste these values into
chat — they're not secrets per se, but the list reveals which mailboxes
you're monitoring, which lowers the value of the test.

---

## Setting up the mailboxes

### Gmail

1. Create a fresh `@gmail.com`. Use a name that's plausibly a person —
   `marcus.delgado.42@gmail.com`, not `seedmailbox1@gmail.com`. Spam
   classifiers down-rank obvious test inboxes.
2. Do not enable forwarding to your real inbox — placement signal is
   different on a forwarded message.
3. Log in once a day. Keep "Promotions" tab enabled, default filters.

### Outlook / Microsoft

1. Create a fresh `@outlook.com`. Same naming guidance.
2. Default settings. **Focused / Other** matters; do not turn it off.

### Custom domain

1. In Cloudflare → Email Routing on `<ROOT_DOMAIN>` (not the outreach
   subdomain), create address `kpi@<ROOT_DOMAIN>` and route it to your
   real inbox.
2. Add the verification TXT records Cloudflare instructs.
3. Send a manual test from elsewhere first to confirm routing works.

---

## How a seedlist test runs

After the per-domain DNS check passes:

1. UI → **Deliverability** → **Send seedlist test**.
2. The app sends one plain-text message to each `SEEDLIST_EMAILS` entry.
3. Each send writes a `seedlist_tests` row + uses the same SES path real
   sends will use (same configuration set, same DKIM key).
4. The send updates `sender_domains.last_seedlist_test_at` regardless.
5. If **every** send succeeded, it also sets
   `sender_domains.last_seedlist_pass_at = now()`.

The launch gate check `seedlist_test_recent` requires that
`last_seedlist_pass_at` is within the last 7 days.

---

## What the operator must do AFTER the seedlist test runs

The app cannot see where Gmail actually filed the message. You have to
log in and look.

For each mailbox, observe and record one of:

| code              | what it means                                                |
| ----------------- | ------------------------------------------------------------ |
| `inbox`           | landed in the main Inbox / Focused                            |
| `promotions`      | landed in Promotions (Gmail) or Other (Outlook)               |
| `spam`            | landed in Spam / Junk                                         |
| `missing`         | nothing arrived within 5 minutes                              |

Record these in the UI's **Deliverability → Seedlist log** for the
sender domain. The app stores a per-mailbox row in `seedlist_tests`. You
can also do this via `PATCH /api/seedlist-tests/:id { placement: 'inbox' }`.

### Decision rules

- **Any `spam` or `missing` on Gmail or Outlook** → fix DNS / warm
  slower / lower per-day cap. Do not launch a real campaign.
- **`promotions` on Gmail** → acceptable for cold outreach, but rephrase
  the subject and CTA to be less marketingy. Try again.
- **`inbox` on all three** → ready to consider the next launch-gate step.

A successful seedlist run is **not** permission to flip
`ENABLE_SES=true` on its own. The launch gate needs the rest of the row
green too (`spf_pass`, `dkim_pass`, `dmarc_pass`, `unsub_reachable`,
`ses_production_access`, `physical_address_set`, `sender_identity_complete`).

---

## What stays off until seedlist is happy

- ❌ **Real campaign launch.** The gate blocks it anyway, but don't override.
- ❌ **Increase the daily cap beyond 50.** Warmup ramp does this for you
  automatically once `warmupState='warming'` is set.
- ❌ **Skip the seedlist on subsequent campaign launches.** It's a 7-day
  TTL, not a one-time check.

---

## What stays off in the runbook itself

- ❌ Do not run a seedlist test until SES is configured per
  `docs/AWS-SES-RUNBOOK.md`.
- ❌ Do not run a seedlist test in `SAMPLE_MODE=true`. It uses
  `MockOutbound` and won't tell you anything about real DKIM alignment.
  The launch gate blocks this combination anyway, but be explicit.
- ❌ Do not seedlist-test from a freshly-rotated DKIM. SES takes ~24
  hours to roll new keys cleanly across all major receivers.
- ❌ Do not seedlist-test through a corporate VPN. Gmail and Microsoft
  weight IP geography lightly but consistently.
