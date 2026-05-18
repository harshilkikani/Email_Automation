/**
 * Production Readiness Gate — the central pre-launch check.
 *
 * Every campaign launch must pass `evaluate(...)`. The function returns a
 * comprehensive `LaunchGateReport` that the frontend renders as a checklist
 * with copy-button fixes. Tests assert that each individual blocker triggers.
 *
 * Order of checks is deterministic so the UI can render a stable list.
 */
import { and, eq, sql, gte } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { defaultTemplateFor, renderEmail, TEMPLATES } from '@keres/core';
import { finalRender, lintEmail, highestSeverity } from '@keres/email';
import { getConfig } from '../config.js';

export type GateState = 'pass' | 'fail' | 'warn' | 'skip';

export interface GateCheck {
  code: string;
  label: string;
  state: GateState;
  detail?: string;
  fix?: string;
  docs?: string;
}

export interface LaunchGateReport {
  ok: boolean;
  campaignId?: string;
  checks: GateCheck[];
  blockingCount: number;
  warningCount: number;
  checkedAt: string;
}

export interface LaunchGateOptions {
  campaignId?: string;
  bouncePausePct: number;
  complaintPausePct: number;
  seedlistTtlHours: number;
  /**
   * Allow gates to pass against an unconfigured campaign (used by the
   * "system diagnostics" screen which evaluates the *deployment*, not a
   * specific campaign).
   */
  systemDiagnostics?: boolean;
}

export async function evaluateLaunchGate(db: Database, opts: LaunchGateOptions): Promise<LaunchGateReport> {
  const cfg = getConfig();
  const checks: GateCheck[] = [];

  const org = (await db.select().from(schema.organizations).limit(1))[0];

  /* ── Runtime mode ── */
  push(checks, 'sample_mode_off', 'Sample mode disabled',
    cfg.sampleMode ? 'fail' : 'pass',
    cfg.sampleMode
      ? 'SAMPLE_MODE=true — outbound provider is the mock. Production sends are not possible until this flag is false.'
      : undefined,
    cfg.sampleMode ? 'Set SAMPLE_MODE=false in .env / Fly secrets.' : undefined,
    'docs/DEPLOYMENT.md');

  push(checks, 'budget_mode_set', 'Budget mode configured',
    org ? 'pass' : 'fail',
    org ? `Budget mode is "${org.budgetMode}".` : 'No organization seeded.',
    org ? undefined : 'Run `pnpm db:seed`.');

  /* ── Sender identity / CAN-SPAM ── */
  push(checks, 'sender_identity_complete', 'Sender identity complete',
    org && org.fromName && org.fromEmail && org.replyTo ? 'pass' : 'fail',
    !org ? 'org_missing' : !(org.fromName && org.fromEmail && org.replyTo)
      ? 'Missing one of: from name, from email, reply-to.' : undefined,
    'Settings → Sender identity.');

  push(checks, 'physical_address_set', 'Physical postal address (CAN-SPAM)',
    org && org.physicalAddress && org.physicalAddress.trim().length > 0 ? 'pass' : 'fail',
    !org?.physicalAddress ? 'CAN-SPAM requires a real physical address in every commercial email.' : undefined,
    'Settings → Sender identity → Physical postal address.',
    'docs/COMPLIANCE.md');

  /* ── SES production access ── */
  push(checks, 'ses_production_access', 'SES production access confirmed',
    org?.productionAccessConfirmed ? 'pass' : 'fail',
    org?.productionAccessConfirmed ? undefined : 'SES sandbox limits sending to 200/day and verified addresses only.',
    'Open AWS SES → Account dashboard → Request production access. Then toggle Settings → Compliance.');

  /* ── Outbound provider configured ── */
  push(checks, 'outbound_configured', 'Outbound provider configured (SES)',
    cfg.ses.enabled || cfg.sampleMode ? 'pass' : 'fail',
    cfg.ses.enabled ? undefined : 'ENABLE_SES=false.',
    'Set ENABLE_SES=true and provide region + credentials in .env.');

  /* ── Seedlist configured ── */
  push(checks, 'seedlist_configured', 'Seedlist configured',
    cfg.seedlistEmails.length > 0 ? 'pass' : 'fail',
    cfg.seedlistEmails.length === 0 ? 'No mailboxes in SEEDLIST_EMAILS.' : undefined,
    'Add comma-separated mailboxes to SEEDLIST_EMAILS.');

  /* ── Sender domain ── */
  let domain: typeof schema.senderDomains.$inferSelect | null = null;
  let campaign: typeof schema.campaigns.$inferSelect | null = null;

  if (opts.campaignId) {
    campaign = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, opts.campaignId)).limit(1))[0] ?? null;
    if (campaign?.senderDomainId) {
      domain = (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, campaign.senderDomainId)).limit(1))[0] ?? null;
    }
  }
  if (!domain) {
    domain = (await db.select().from(schema.senderDomains).limit(1))[0] ?? null;
  }

  push(checks, 'sender_domain_exists', 'Sender domain registered', domain ? 'pass' : 'fail',
    domain ? undefined : 'No sender_domains row. Add one in Deliverability.');

  if (domain) {
    push(checks, 'spf_pass', 'SPF aligned to ESP', domain.spfStatus === 'pass' ? 'pass' : 'fail',
      domain.spfStatus === 'pass' ? undefined : 'SPF record missing or wrong include directive.',
      'Add a TXT record on your outreach subdomain with v=spf1 include:amazonses.com -all.');
    push(checks, 'dkim_pass', 'DKIM (3 SES selectors)', domain.dkimStatus === 'pass' ? 'pass' : 'fail',
      domain.dkimStatus === 'pass' ? undefined : 'All three SES Easy DKIM CNAMEs (s1/s2/s3) must resolve.',
      'In AWS SES → verified identities, copy the 3 DKIM CNAMEs into your DNS.');
    push(checks, 'dmarc_pass', 'DMARC record', domain.dmarcStatus === 'pass' ? 'pass' : 'fail',
      domain.dmarcStatus === 'pass' ? undefined : 'DMARC TXT record missing.',
      'Add a TXT record on _dmarc.<root-domain> with v=DMARC1; p=none; rua=mailto:rua@...');
    push(checks, 'unsub_reachable', 'Unsubscribe endpoint reachable',
      domain.unsubReachable ? 'pass' : 'fail',
      domain.unsubReachable ? undefined : 'GET /api/unsubscribe/health was not 2xx the last time it was probed.',
      'Confirm PUBLIC_BASE_URL is reachable from the internet, then Deliverability → Check DNS.');

    if (!opts.systemDiagnostics) {
      push(checks, 'warmup_ok', 'Sender domain warmed',
        domain.warmupState === 'warmed' || domain.warmupState === 'warming' ? 'pass' : 'fail',
        domain.warmupState === 'pending' ? 'Warmup never started.' : domain.warmupState === 'paused' ? 'Warmup is paused.' : undefined,
        'Run a small seedlist test-send first; warmupState transitions to "warming" on first success.');

      const cap = domain.dailySendBudget ?? 50;
      push(checks, 'daily_cap_ok', 'Daily cap available',
        domain.sendsToday < cap ? 'pass' : 'fail',
        domain.sendsToday >= cap ? `Already sent ${domain.sendsToday}/${cap} today.` : undefined,
        'Resumes at UTC midnight, or raise the daily cap in sender domain settings.');

      const seedTtl = opts.seedlistTtlHours * 3600 * 1000;
      const seedOk = !!domain.lastSeedlistPassAt && (Date.now() - new Date(domain.lastSeedlistPassAt).getTime()) < seedTtl;
      push(checks, 'seedlist_test_recent', `Seedlist test-send in last ${opts.seedlistTtlHours}h`,
        seedOk ? 'pass' : 'fail',
        seedOk ? undefined : 'No recent successful seedlist test-send.',
        'Deliverability → run "Send seedlist test". Verify each mailbox manually.');
    }
  }

  /* ── 24h bounce / complaint rates ── */
  if (org && !opts.systemDiagnostics) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const events = await db.select({
      type: schema.emailEvents.eventType, count: sql<number>`count(*)::int`,
    }).from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.orgId, org.id), gte(schema.emailEvents.occurredAt, since)))
      .groupBy(schema.emailEvents.eventType);
    let sent = 0, bounced = 0, complained = 0;
    for (const e of events) {
      if (e.type === 'send') sent += Number(e.count);
      if (e.type === 'bounce') bounced += Number(e.count);
      if (e.type === 'complaint') complained += Number(e.count);
    }
    if (sent > 50) {
      const bp = (bounced / sent) * 100;
      const cp = (complained / sent) * 100;
      push(checks, 'bounce_rate_safe', '24h bounce rate safe',
        bp < opts.bouncePausePct ? 'pass' : 'fail',
        bp >= opts.bouncePausePct ? `24h bounce ${bp.toFixed(1)}% ≥ ${opts.bouncePausePct}% threshold.` : undefined,
        'Pause sends. Audit your email-discovery quality and clean the list before resuming.');
      push(checks, 'complaint_rate_safe', '24h complaint rate safe',
        cp < opts.complaintPausePct ? 'pass' : 'fail',
        cp >= opts.complaintPausePct ? `24h complaint ${cp.toFixed(2)}% ≥ ${opts.complaintPausePct}% threshold.` : undefined,
        'STOP. Even one complaint per 1,000 sends is the SES hard threshold.');
    } else {
      push(checks, 'bounce_rate_safe', '24h bounce rate safe', 'skip', `Only ${sent} sends in last 24h — not statistically meaningful.`);
      push(checks, 'complaint_rate_safe', '24h complaint rate safe', 'skip', `Only ${sent} sends in last 24h.`);
    }
  }

  /* ── Budget exhaustion ── */
  if (org && !opts.systemDiagnostics) {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1); startOfMonth.setUTCHours(0, 0, 0, 0);
    const spends = await db.select({
      provider: schema.costEvents.provider, cents: sql<number>`sum(cost_cents)::int`,
    }).from(schema.costEvents)
      .where(and(eq(schema.costEvents.orgId, org.id), gte(schema.costEvents.occurredAt, startOfMonth)))
      .groupBy(schema.costEvents.provider);
    for (const s of spends) {
      const usd = Number(s.cents) / 100;
      const cap = budgetCapFor(s.provider);
      if (cap !== null && usd >= cap) {
        push(checks, `budget_${s.provider}`, `${s.provider} monthly budget`,
          'fail',
          `MTD spend $${usd.toFixed(2)} >= $${cap.toFixed(2)} cap.`,
          'Raise the per-provider monthly budget in .env, or wait for the next month.');
      } else if (cap !== null && usd >= cap * 0.8) {
        push(checks, `budget_${s.provider}`, `${s.provider} monthly budget`, 'warn',
          `MTD spend $${usd.toFixed(2)} is at ${Math.round((usd / cap) * 100)}% of $${cap.toFixed(2)} cap.`);
      }
    }
  }

  /* ── Per-campaign checks ── */
  if (campaign && !opts.systemDiagnostics) {
    push(checks, 'campaign_has_recipients', 'Campaign has recipients',
      campaign.recipientCount > 0 ? 'pass' : 'fail',
      campaign.recipientCount === 0 ? 'No campaign_recipients rows. Run audience resolution.' : undefined);

    /* Lint check the rendered template against a synthetic minimal lead. */
    try {
      const tpl = TEMPLATES[campaign.templateKey] ?? defaultTemplateFor('Septic');
      const r = renderEmail(tpl, {
        leadId: 'gate-preview',
        business: 'Acme Test',
        city: 'Houston',
        signals: { webPresenceLevel: 'none', isStormZone: false, niche: 'Septic', hasOnlineBooking: false },
        fromName: org?.fromName ?? 'Operator',
        fromSignoff: org?.name ?? 'Keres AI',
      });
      const final = finalRender({
        rendered: r,
        to: 'preview@example.com', leadEmail: 'preview@example.com',
        orgScopeKey: org?.id ?? 'GLOBAL', campaignId: campaign.id,
        identity: {
          fromName: org?.fromName ?? cfg.org.fromName,
          fromEmail: org?.fromEmail ?? cfg.org.fromEmail,
          replyTo: org?.replyTo ?? cfg.org.replyTo,
          unsubMailto: org?.replyTo ?? cfg.org.replyTo,
          publicBaseUrl: cfg.publicBaseUrl,
          physicalAddress: org?.physicalAddress ?? cfg.org.physicalAddress,
          orgName: org?.name ?? cfg.org.name,
        },
        signingSecret: cfg.authCookieSecret,
        messageId: `<gate-${campaign.id}@${cfg.org.outreachSubdomain}>`,
      });
      const issues = lintEmail({
        subject: final.subject, body: final.bodyWithFooter,
        identityHasPhysicalAddress: !!org?.physicalAddress,
        unsubscribeUrlPresent: final.bodyWithFooter.includes(final.unsubscribeUrl),
        canSpamFooterPresent: final.bodyWithFooter.includes('Unsubscribe (one click)'),
      });
      const sev = highestSeverity(issues);
      push(checks, 'copy_lint', 'Copy lint pre-flight',
        sev === 'error' ? 'fail' : 'pass',
        sev === 'error' ? issues.filter(i => i.severity === 'error').map(i => `${i.code}: ${i.message}`).join('; ')
                        : sev === 'warn' ? `Warnings: ${issues.filter(i => i.severity === 'warn').length}` : undefined,
        'Edit the template or sender identity to clear linter errors.');
    } catch (e: any) {
      push(checks, 'copy_lint', 'Copy lint pre-flight', 'fail', `Render error: ${e?.message ?? e}`);
    }

    if (campaign.status === 'paused' || campaign.status === 'failed') {
      push(checks, 'campaign_state', 'Campaign not paused / failed', 'fail',
        `Status is "${campaign.status}". ${campaign.pauseReason ?? ''}`);
    }
  }

  const blocking = checks.filter(c => c.state === 'fail').length;
  const warnings = checks.filter(c => c.state === 'warn').length;
  return {
    ok: blocking === 0,
    campaignId: opts.campaignId,
    checks,
    blockingCount: blocking,
    warningCount: warnings,
    checkedAt: new Date().toISOString(),
  };
}

function push(arr: GateCheck[], code: string, label: string, state: GateState, detail?: string, fix?: string, docs?: string): void {
  arr.push({ code, label, state, detail, fix, docs });
}

function budgetCapFor(provider: string): number | null {
  const cfg = getConfig();
  if (provider === 'bouncer') return cfg.bouncer.monthlyBudgetCents / 100;
  if (provider === 'yelp') return cfg.yelp.monthlyBudgetUsd > 0 ? cfg.yelp.monthlyBudgetUsd : null;
  if (provider === 'places') return cfg.places.monthlyBudgetUsd > 0 ? cfg.places.monthlyBudgetUsd : null;
  if (provider === 'hunter') {
    /* Hunter is credit-based, not dollar; budgets are enforced separately in budget.ts. */
    return null;
  }
  return null;
}
