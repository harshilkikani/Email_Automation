# Domain Decision

The single biggest decision before any DNS, SES, or first send. Read end
to end before buying anything.

## The rule

**Cold outreach goes through a dedicated outreach domain. It does not go
through your day-to-day company domain.**

## Why a separate outreach domain

- **Reputation isolation.** A cold-mail program inevitably accumulates
  bounces, complaints, and the occasional Gmail/Yahoo block. If those
  events land on your *real* domain, your invoices, customer support,
  password resets, and one-on-one mail all break at the same time.
- **DMARC freedom.** A dedicated outreach domain can run `p=none` while
  you tune deliverability, then move to `p=quarantine` and `p=reject` at
  your own pace, without forcing your main domain to be permissive.
- **Reversibility.** If a campaign goes wrong, you can park the outreach
  domain and start a new one. You cannot do that with the domain on every
  invoice you've ever sent.

## Good domain patterns

| pattern                                       | example                       |
| --------------------------------------------- | ----------------------------- |
| `<brand>-outreach.com`                        | `keres-outreach.com`          |
| `<brand>mail.com`                             | `keresmail.com`               |
| `<brand>-contact.com`                         | `keres-contact.com`           |
| `try<brand>.com`                              | `trykeres.com`                |
| `<brand>-leads.com`                           | `keres-leads.com`             |

Pick something that's still obviously associated with your brand —
reviewers (and recipients) should be able to tell at a glance who you are.

## Bad patterns

| pattern                              | why                                                |
| ------------------------------------ | -------------------------------------------------- |
| Your real company root domain        | reputation contagion (see above)                   |
| `<brand>123.com` / `<brand>2.com`    | looks like a typo-squat                            |
| Random initialisms                   | no brand recall; recipients can't verify you       |
| Free TLDs (`.tk`, `.ml`, `.ga`)      | universally blocked by Gmail and Microsoft         |
| Newly-registered fake brand          | aged-domain heuristics will hurt your delivery     |

## Sending subdomain options

Send from a subdomain of the outreach root, never the root itself. Common
patterns:

| subdomain                        | when to use                                         |
| -------------------------------- | --------------------------------------------------- |
| `outreach.<ROOT_DOMAIN>`         | default; clearest signal of intent                   |
| `mail.<ROOT_DOMAIN>`             | shorter, neutral                                     |
| `news.<ROOT_DOMAIN>`             | only if your copy genuinely is newsletter-style      |
| `<niche>.<ROOT_DOMAIN>`          | only when you have a single niche; helps DMARC tuning |

DMARC alignment is per-organizational-domain, so a subdomain inherits the
parent's `p=` policy unless you set `sp=` separately. SPF and DKIM are
strictly per-subdomain — they have to be set on the subdomain you actually
send from.

## App hostname

Separate from the outreach domain. The console (Keres operator UI) can:

1. Stay on the Fly URL: `https://keres-ops.fly.dev/`. Free, works today.
2. Move to a pretty hostname like `ops.<ROOT_DOMAIN>` via a CNAME to
   `keres-ops.fly.dev`. Cosmetic. Adds one Cloudflare CNAME record.

Either is fine. Option 1 is enough until the first real customer logs in.

## Non-secret values you'll decide

These are the only values needed from you to move forward. None of them
are secrets — they appear in DNS, email headers, and the CAN-SPAM footer.

| value                          | example                                               | notes                                                 |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| `ROOT_DOMAIN`                  | `keres-outreach.com`                                  | the new outreach domain you buy                       |
| `OUTREACH_SUBDOMAIN`           | `outreach`                                            | becomes `outreach.<ROOT_DOMAIN>`                      |
| `APP_DOMAIN`                   | `keres-ops.fly.dev` (default) or `ops.<ROOT_DOMAIN>`  | hostname for the operator console                     |
| `FROM_EMAIL`                   | `hello@outreach.keres-outreach.com`                   | shown in recipients' "From" line                      |
| `REPLY_TO_EMAIL`               | `replies@outreach.keres-outreach.com`                 | where bounces and replies land (Postmark Inbound later) |
| `PHYSICAL_MAILING_ADDRESS`     | `123 Main St Suite 5, Houston, TX 77002`              | real US business address; CAN-SPAM requirement        |
| `SEEDLIST_EMAILS`              | `keres.seed.gmail@gmail.com,keres.seed@outlook.com,kpi@<ROOT_DOMAIN>` | mailboxes you actually log into to check placement  |
| `BOOKING_LINK`                 | `https://cal.<ROOT_DOMAIN>/intro` (or skip for now)   | optional CTA link                                     |

## What to do next

1. Pick `ROOT_DOMAIN` and the subdomain pattern.
2. Buy the domain at Cloudflare Registrar (wholesale + free WHOIS privacy)
   or Porkbun/Namecheap. ~$10–15/yr.
3. Once registered, tell me the eight values in the table above.
4. I'll run `pnpm domain:plan` with those values and print the exact
   Cloudflare DNS records to add (still no execution — just a plan).
5. Then `docs/CLOUDFLARE-DNS-RUNBOOK.md` walks the actual DNS clicks.
6. Then `docs/AWS-SES-RUNBOOK.md` walks the SES side (still gated).

Until you've decided `ROOT_DOMAIN`, nothing changes in AWS, Cloudflare,
Postmark, or any paid provider. The app stays in safe setup mode.
