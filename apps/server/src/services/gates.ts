/**
 * Compliance / safety gates evaluated before any send.
 *
 * `canSend()` is intentionally a pure function — pass in the campaign,
 * sender_domain, organization, and last-24h stats, get a list of blockers.
 */
import type { campaigns, senderDomains, organizations } from '@keres/db';

type Org = typeof organizations.$inferSelect;
type SenderDomain = typeof senderDomains.$inferSelect;
type Campaign = typeof campaigns.$inferSelect;

export interface Last24hStats {
  sent: number;
  bounced: number;
  complained: number;
}

export interface GateInput {
  org: Org;
  domain: SenderDomain | null;
  campaign: Campaign;
  stats: Last24hStats;
  bouncePausePct: number;
  complaintPausePct: number;
  unsubscribeReachable: boolean;
}

export interface GateResult {
  ok: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

export function canSend(input: GateInput): GateResult {
  const blockers: GateResult['blockers'] = [];
  const warnings: GateResult['warnings'] = [];

  if (!input.org.physicalAddress || input.org.physicalAddress.trim().length === 0) {
    blockers.push({ code: 'no_physical_address', message: 'Organization is missing the required physical mailing address (CAN-SPAM).' });
  }
  if (!input.org.fromName || !input.org.fromEmail || !input.org.replyTo) {
    blockers.push({ code: 'incomplete_sender_identity', message: 'From name, From email, and Reply-To are all required.' });
  }
  if (!input.org.productionAccessConfirmed) {
    blockers.push({ code: 'no_production_access', message: 'SES production access has not been confirmed. Open the request ticket in AWS, then toggle the setting.' });
  }

  if (!input.domain) {
    blockers.push({ code: 'no_sender_domain', message: 'Campaign has no sender domain.' });
  } else {
    if (input.domain.spfStatus !== 'pass') blockers.push({ code: 'spf_not_passing', message: 'SPF check is not passing.' });
    if (input.domain.dkimStatus !== 'pass') blockers.push({ code: 'dkim_not_passing', message: 'DKIM check is not passing.' });
    if (input.domain.dmarcStatus !== 'pass') blockers.push({ code: 'dmarc_not_passing', message: 'DMARC record is missing or invalid.' });
    if (input.domain.mxStatus !== 'pass') blockers.push({ code: 'mx_not_passing', message: 'MX record is not passing.' });
    if (input.domain.warmupState === 'pending') blockers.push({ code: 'not_warmed', message: 'Sender domain has not been warmed.' });
    if (input.domain.warmupState === 'paused') blockers.push({ code: 'warmup_paused', message: 'Sender domain warmup is paused.' });
    if (input.domain.sendsToday >= input.domain.dailySendBudget) {
      blockers.push({ code: 'daily_cap_exceeded', message: `Daily send cap reached (${input.domain.sendsToday}/${input.domain.dailySendBudget}).` });
    }
  }

  if (!input.unsubscribeReachable) {
    blockers.push({ code: 'unsub_unreachable', message: 'Unsubscribe endpoint did not respond OK on the last probe.' });
  }

  const sent = input.stats.sent;
  if (sent > 50) {
    const bouncePct = (input.stats.bounced / sent) * 100;
    const complaintPct = (input.stats.complained / sent) * 100;
    if (bouncePct >= input.bouncePausePct) {
      blockers.push({ code: 'bounce_rate_high', message: `24h bounce rate ${bouncePct.toFixed(1)}% ≥ ${input.bouncePausePct}% threshold.` });
    } else if (bouncePct >= input.bouncePausePct * 0.7) {
      warnings.push({ code: 'bounce_rate_rising', message: `24h bounce rate ${bouncePct.toFixed(1)}% nearing ${input.bouncePausePct}% threshold.` });
    }
    if (complaintPct >= input.complaintPausePct) {
      blockers.push({ code: 'complaint_rate_high', message: `24h complaint rate ${complaintPct.toFixed(2)}% ≥ ${input.complaintPausePct}% threshold.` });
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}
