# Compliance

> **What it covers:** Gmail/Yahoo bulk-sender rules, CAN-SPAM, AWS SES AUP, GDPR-light, OSM attribution, Yelp TOS, Postmark/Resend AUP. Implementation details and where each gate lives.

## Gmail / Yahoo bulk-sender (2024+)

Source: [Gmail bulk-sender guidelines](https://support.google.com/mail/answer/81126), [Yahoo Sender best practices](https://senders.yahooinc.com/best-practices/).

| Requirement | Where enforced |
|---|---|
| SPF + DKIM aligned to From-domain | `apps/server/src/services/sender.ts::runDnsCheck` plus `services/gates.ts::canSend` blocks send unless both pass. |
| DMARC `p=none` minimum | Same `canSend` block. The Deliverability page surfaces the policy and warns if it's still `none` once you're past warmup. |
| Spam rate < 0.3% | `BOUNCE_PAUSE_PCT` (default 4) and `COMPLAINT_PAUSE_PCT` (default 0.1) trip auto-pause *well before* Gmail's threshold. |
| RFC 8058 one-click unsubscribe | Every send includes `List-Unsubscribe: <https://...>, <mailto:...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. See `packages/email/src/headers.ts`. |
| Honor unsubscribes in 2 days | `processUnsubscribe` writes a suppression row immediately (`apps/server/src/services/unsubscribe.ts`). The send pipeline skips suppressed addresses on the next batch. |

## CAN-SPAM

Source: [FTC compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

| Rule | Implementation |
|---|---|
| No false / misleading header info | `buildHeaders` always populates a real `From:` aligned with the verified outreach subdomain. |
| No deceptive subject lines | `packages/email/src/linter.ts` rejects subjects starting with `Re:` / `Fwd:`. |
| Identify the email as an ad | Subjects are direct (e.g. "after-hours calls, {{business}}"). The footer's "you received this because…" line is explicit. |
| Physical postal address | `canSend` blocks if `organizations.physical_address` is empty. The CAN-SPAM footer renders it on every send. |
| Easy opt-out mechanism | Body contains the one-click URL **and** "reply with unsubscribe" instructions. `List-Unsubscribe` header included. |
| Honor opt-outs within 10 business days | We honor in **2 days** to satisfy Gmail/Yahoo, which is well within the 10-day floor. |
| Monitor third parties | Single-tenant at MVP — no third-party agents. If you outsource send, audit them yourself. |

## AWS SES Acceptable Use Policy

Source: [SES sending review FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html).

| Threshold | Our auto-pause |
|---|---|
| Bounce review at 5% | Pause at 4% (configurable). |
| Bounce suspend at 10% | Already paused at 4%. |
| Complaint review at 0.1% | Pause at 0.1% — we use the review threshold as the hard stop. |
| Complaint suspend at 0.5% | Already paused at 0.1%. |
| Sandbox 200/day | `SES_PRODUCTION_ACCESS_CONFIRMED` must be `true` before any send. Until then, `canSend` blocks. |

## Yelp Fusion TOS

Source: [Yelp Fusion display & caching rules](https://docs.developer.yelp.com/docs/display-requirements).

| Rule | Implementation |
|---|---|
| 24-hour cache limit on business response data | `YelpAdapter.enrichForScoring()` returns scoring inputs only; the result is consumed by the scoring function and discarded. **No DB column persists Yelp-sourced display data.** |
| Long-term storage of `business_id` only | The schema has no Yelp-named columns. `packages/providers/test/yelp-no-store.test.ts` is a lint test that enforces this. |
| 500 calls/day free | Configure `YELP_MONTHLY_BUDGET_USD` to cap. Cost guards in `packages/core/src/budget.ts` will prevent additional calls once the budget is reached. |

## Postmark / Resend outbound TOS

Source: [Postmark transactional definition](https://postmarkapp.com/support/article/804-what-are-transactional-emails), [Resend AUP](https://resend.com/legal/acceptable-use).

| Rule | Implementation |
|---|---|
| Postmark outbound for cold = prohibited | **No Postmark outbound adapter exists.** `packages/providers/test/forbidden-providers.test.ts` asserts the file does not exist. Postmark Inbound is allowed and is the only Postmark adapter present. |
| Resend outbound for cold = effectively prohibited | Same. No Resend adapter exists. |

## OpenStreetMap ODbL

Source: [OSM copyright page](https://www.openstreetmap.org/copyright).

| Rule | Implementation |
|---|---|
| Attribute "© OpenStreetMap contributors" | The frontend footer (`apps/web/src/App.tsx`) renders this on every page. Discovery results from the OSM adapter also include the attribution string. |
| Identifiable User-Agent | `OSM_USER_AGENT` in `.env` defaults to `KeresAI/0.1 (ops@keresai.com)` — change to your contact info. The Overpass adapter sets it on every request. |
| ≤ 10k queries/day per IP, ≤ 1 req/sec courtesy | At 1k qualified leads/month we run ~10 queries/day — far below the cap. |

## GDPR-light

We do not knowingly contact EU citizens. If you must, add a region check before discovery insert (the `hardFilter` reject `non_us`). For paid customers, expose a "right to erasure" endpoint that hard-deletes from `leads`, `lead_signals`, `email_events`, `inbound_messages`.

## Anti-pattern guards

Each item below is enforced in code or in a CI test:

| Banned | Where |
|---|---|
| Per-lead AI | No Anthropic SDK in `apps/server/package.json`. Budget guard rejects calls. |
| Open tracking | No pixel or open-event handler. SES `open` events are ignored. |
| HTML emails | Renderer outputs `text/plain; charset=UTF-8` only. |
| Apollo / Clay / LinkedIn / ZoomInfo / RocketReach | No adapter files exist. CI test asserts. |
| Browser-stored secrets | Settings UI whitelists only public fields. Server-side `.env` is the only home for secrets. |
| Postmark / Resend outbound | No adapter files. CI test asserts. |
| Sending without DNS green | `canSend` blocks. |
| Sending without production access | `canSend` blocks. |
| Sending while bounce/complaint over threshold | `canSend` blocks + in-loop auto-pause. |
| Yelp display fields in DB | Schema lint test asserts. |
