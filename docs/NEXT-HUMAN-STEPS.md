# Next Human Steps

Short. Top-down. Stop at the first step you can't complete.

1. Pick or buy an **outreach root domain**. See
   [`DOMAIN-DECISION.md`](DOMAIN-DECISION.md). ~$10–15/yr at Cloudflare
   Registrar.
2. Decide the **sending subdomain** (default `outreach`).
3. Decide the **From** address and **Reply-To** address (default
   `hello@…` and `replies@…`).
4. Gather your **physical mailing address** (real US business address;
   appears in every email footer per CAN-SPAM).
5. Set up the **seedlist inboxes** per
   [`SEEDLIST-RUNBOOK.md`](SEEDLIST-RUNBOOK.md) — at minimum a fresh
   Gmail, Outlook, and a `kpi@<ROOT_DOMAIN>` mailbox.
6. **Tell me only these non-secret values.** Nothing private. Just:
   - `ROOT_DOMAIN`
   - `OUTREACH_SUBDOMAIN`
   - `APP_DOMAIN` *(or keep the default `keres-ops.fly.dev`)*
   - `FROM_LOCAL_PART`
   - `REPLY_TO_LOCAL_PART`
   - `PHYSICAL_MAILING_ADDRESS`
   - `SEEDLIST_EMAILS`
   - `BOOKING_LINK` *(optional)*
7. I run `pnpm domain:plan` with those values. It mutates nothing and
   prints the exact DNS records to add.
8. **Cloudflare DNS** per [`CLOUDFLARE-DNS-RUNBOOK.md`](CLOUDFLARE-DNS-RUNBOOK.md).
9. **AWS SES** per [`AWS-SES-RUNBOOK.md`](AWS-SES-RUNBOOK.md). DKIM,
   MAIL-FROM, configuration set, SNS topics, production access request.
10. **Only after all SES + DNS + seedlist checks are green on the
    deployed `/api/launch-gate`** → consider flipping
    `ENABLE_SES=true`. Not before.

Until step 1 is done, the deployment stays in safe setup mode:
`SAMPLE_MODE=false`, `ENABLE_SES=false`, real outbound impossible.
