# Cloudflare DNS Runbook

Exact clicks to set up Cloudflare for the outreach domain. **Do not start
this runbook until `docs/DOMAIN-DECISION.md` is read and `ROOT_DOMAIN` is
chosen.**

The end state of this runbook:

- Cloudflare hosts DNS for `ROOT_DOMAIN`.
- SPF / DMARC / SES MAIL-FROM placeholders are in.
- App hostname CNAME (optional) is in.
- **SES DKIM CNAMEs are NOT yet added** — those come after `docs/AWS-SES-RUNBOOK.md`.
- **No paid Cloudflare add-on is enabled.**

Outputs needed from `pnpm domain:plan`:

```
ROOT_DOMAIN=<your domain> \
OUTREACH_SUBDOMAIN=outreach \
APP_DOMAIN=ops.<your domain>   # or keep the default keres-ops.fly.dev \
FROM_LOCAL_PART=hello \
REPLY_TO_LOCAL_PART=replies \
pnpm domain:plan
```

That prints the records below with the right names. Treat the snippets in
this file as templates — copy the exact values from your `domain:plan`
output.

---

## 1. Add the zone

1. Sign in to https://dash.cloudflare.com/.
2. **Add a Site** → enter `ROOT_DOMAIN`.
3. Plan: **Free**. Do not pick any paid plan.
4. Cloudflare scans existing DNS (will be empty for a fresh registration).
5. Cloudflare shows two nameservers (e.g. `tegan.ns.cloudflare.com`,
   `vlad.ns.cloudflare.com`). Go to your registrar (Cloudflare Registrar,
   Porkbun, Namecheap, etc.) and replace the existing nameservers with
   these.
6. **Wait** until Cloudflare's "Overview" page shows the zone as **Active**
   (usually 5–30 min, occasionally up to 24 h). Do nothing else here until
   it does.

---

## 2. DNS records to add NOW

Open the zone → **DNS → Records**. All four go in. **None of them is
proxied — every one is "DNS only" (grey cloud), not "Proxied" (orange).**

### 2.1 App hostname CNAME *(optional)*

Skip this if you decided to keep the operator console on `keres-ops.fly.dev`.

| field    | value                       |
| -------- | --------------------------- |
| Type     | CNAME                       |
| Name     | `ops`                       |
| Target   | `keres-ops.fly.dev`         |
| Proxy    | **DNS only** (grey cloud)   |
| TTL      | Auto                        |

Fly terminates TLS itself. If you proxy through Cloudflare, you'll either
get a 525 SSL error or you'll have to mess with Origin Certificates.
Just don't proxy.

### 2.2 Primary SPF on the outreach subdomain

| field    | value                                          |
| -------- | ---------------------------------------------- |
| Type     | TXT                                            |
| Name     | `outreach` *(this becomes `outreach.<ROOT_DOMAIN>`)* |
| Content  | `v=spf1 include:amazonses.com -all`            |
| TTL      | Auto                                           |

`-all` (hard fail) is correct here because **only SES** should send from
this subdomain. Do not add other SPF includes "just in case".

### 2.3 DMARC monitoring record on the root

| field    | value                                          |
| -------- | ---------------------------------------------- |
| Type     | TXT                                            |
| Name     | `_dmarc`                                       |
| Content  | `v=DMARC1; p=none; rua=mailto:dmarc-rua@<ROOT_DOMAIN>; ruf=mailto:dmarc-ruf@<ROOT_DOMAIN>; fo=1; aspf=r; adkim=r;` |
| TTL      | Auto                                           |

Stay at `p=none` for at least two weeks while you read the daily DMARC
aggregate reports that arrive at `dmarc-rua@<ROOT_DOMAIN>`. After two
clean weeks (no unauthenticated sources, no failures), move to
`p=quarantine`. Eventually `p=reject`.

You will need a mailbox at `dmarc-rua@<ROOT_DOMAIN>` to receive those
reports. Cloudflare Email Routing (free) is the simplest way to forward
them to a real inbox — but only configure Email Routing on the **root**,
never on the outreach subdomain.

### 2.4 SES MAIL-FROM MX + secondary SPF on the outreach subdomain

These give the bounce path a name aligned to your subdomain (instead of
the default `*.amazonses.com`).

| field    | value                                                       |
| -------- | ----------------------------------------------------------- |
| Type     | MX                                                          |
| Name     | `outreach`                                                  |
| Mail server | `feedback-smtp.us-east-1.amazonses.com`                  |
| Priority | `10`                                                        |
| TTL      | Auto                                                        |

| field    | value                                       |
| -------- | ------------------------------------------- |
| Type     | TXT                                         |
| Name     | `outreach`                                  |
| Content  | `v=spf1 include:amazonses.com ~all`         |
| TTL      | Auto                                        |

Cloudflare will let you add a second SPF TXT on the same name. Some
registrars don't — if you ever migrate off Cloudflare, you'd need to
merge the two SPFs into one record.

If you switch SES regions, update the MX value's region segment.

---

## 3. DNS records to add LATER (after AWS SES verifies the identity)

`pnpm domain:plan` emits these with `<TOKEN1>`, `<TOKEN2>`, `<TOKEN3>`
placeholders. You cannot fill them in until SES → Create identity → Easy
DKIM has run for `outreach.<ROOT_DOMAIN>`. That step is in `docs/AWS-SES-RUNBOOK.md`.

Format AWS will give you (each line is a separate CNAME in Cloudflare):

```
<TOKEN1>._domainkey.outreach.<ROOT_DOMAIN>    →   <TOKEN1>.dkim.amazonses.com
<TOKEN2>._domainkey.outreach.<ROOT_DOMAIN>    →   <TOKEN2>.dkim.amazonses.com
<TOKEN3>._domainkey.outreach.<ROOT_DOMAIN>    →   <TOKEN3>.dkim.amazonses.com
```

All three **DNS only / grey cloud / not proxied**.

---

## 4. DNS records to defer until inbound replies are wanted

Postmark Inbound's MX placeholder is in `pnpm domain:plan` for
visibility. **Do not add it yet** — it conflicts with the SES MAIL-FROM
MX above on the same name. When you actually enable inbound parsing, you
either:

- Use a sub-subdomain (`replies.outreach.<ROOT_DOMAIN>`) for Postmark,
  keeping the SES MAIL-FROM MX where it is. **Recommended.**
- Or replace the SES MAIL-FROM MX with Postmark's and accept the default
  AWS bounce path. Less clean.

---

## 5. Cloudflare Cron wakeup (free, later)

Once the app domain is decided, you can keep the auto-stopped Fly VM warm
on work mornings with a free Cloudflare Worker:

- Worker fetches `https://keres-ops.fly.dev/api/health` (or the
  `APP_DOMAIN` you chose).
- Cron trigger: `0 12 * * 1-5` (12:00 UTC ≈ 07:00 US Central, weekdays).
- Free quota: 100k requests / day. One request / weekday = 22 / month.

Set this up *after* DNS is live. Not now.

---

## 6. What stays OFF

- ❌ **Cloudflare Pro / Business / Enterprise** — Free is enough.
- ❌ **Cloudflare Argo / Smart Routing** — paid; not needed.
- ❌ **Cloudflare proxy ("orange cloud")** on any mail-related record —
  breaks SES.
- ❌ **Cloudflare proxy on the app CNAME** — breaks Fly TLS.
- ❌ **Cloudflare Email Routing on the outreach subdomain** — intercepts
  mail before Postmark Inbound can see it.
- ❌ **Cloudflare Workers paid plan** — free Workers cover the cron use.

---

## 7. Verifying the records are live

After ~5 minutes you can verify from anywhere:

```bash
dig +short TXT outreach.<ROOT_DOMAIN>      # SPF
dig +short TXT _dmarc.<ROOT_DOMAIN>        # DMARC
dig +short MX  outreach.<ROOT_DOMAIN>      # MAIL-FROM MX
dig +short CNAME ops.<ROOT_DOMAIN>         # app hostname (if added)
```

When all four resolve, ping me. I'll re-run the deployed launch-gate
check and confirm only SES-side items still fail. Then move to
`docs/AWS-SES-RUNBOOK.md`.
