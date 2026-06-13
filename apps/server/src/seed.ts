/**
 * Seed script: ensures the single organization, a sender domain, and one
 * scoring_versions row exist. Idempotent — safe to run multiple times.
 *
 * For the single-tenant deployment, env/config is the source of truth for the
 * sender identity, so an existing org/domain is *reconciled* to the configured
 * values (identity, physical address, and the active provider's SPF/DKIM
 * expectations). This is how a prod machine is pointed at Spacemail:
 *   fly ssh console -a keres-ops -C "node apps/server/dist/apps/server/src/seed.js"
 */
import { getDbWithClose } from '@keres/db';
import { schema } from '@keres/db';
import { DEFAULT_WEIGHTS_V1, SCORING_VERSION_V1 } from '@keres/core';
import { eq } from 'drizzle-orm';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  const { db, close } = getDbWithClose();
  /* DNS-check expectations follow whichever outbound provider is active so
     "Check DNS" validates the right records (Spacemail ≠ SES). */
  const spfInclude = cfg.smtp.enabled ? cfg.smtp.spfInclude
    : cfg.mailgun.enabled ? 'mailgun.org'
    : 'amazonses.com';
  const dkimSelectors = cfg.smtp.enabled ? [cfg.smtp.dkimSelector] : undefined;
  /* Mailbox hosts (Spacemail, etc.) send from shared, already-reputable IPs —
     there's no dedicated IP to warm, so treat the domain as warmed. Dedicated-
     IP ESPs (SES) start 'pending' and ramp. Sample mode is always 'warmed'. */
  const initialWarmup = cfg.sampleMode || cfg.smtp.enabled ? 'warmed' : 'pending';
  try {
    const existing = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
    let orgId: string;
    if (existing[0]) {
      orgId = existing[0].id;
      const update: Record<string, unknown> = {
        name: cfg.org.name, fromName: cfg.org.fromName, fromEmail: cfg.org.fromEmail,
        replyTo: cfg.org.replyTo, outreachSubdomain: cfg.org.outreachSubdomain,
        defaultBookingLink: cfg.org.defaultBookingLink, budgetMode: cfg.budgetMode,
        productionAccessConfirmed: cfg.ses.productionAccessConfirmed,
      };
      if (cfg.org.physicalAddress.trim()) update.physicalAddress = cfg.org.physicalAddress;
      await db.update(schema.organizations).set(update).where(eq(schema.organizations.id, orgId));
      console.log(`org reconciled to config: ${orgId} (${cfg.org.fromEmail})`);
    } else {
      const inserted = await db.insert(schema.organizations).values({
        slug: 'keres', name: cfg.org.name,
        timezone: 'America/Chicago',
        fromName: cfg.org.fromName, fromEmail: cfg.org.fromEmail,
        replyTo: cfg.org.replyTo, physicalAddress: cfg.org.physicalAddress,
        outreachSubdomain: cfg.org.outreachSubdomain,
        defaultBookingLink: cfg.org.defaultBookingLink,
        productionAccessConfirmed: cfg.ses.productionAccessConfirmed,
        budgetMode: cfg.budgetMode,
      }).returning({ id: schema.organizations.id });
      orgId = inserted[0]!.id;
      console.log(`org created: ${orgId}`);
    }
    const sd = await db.select({ id: schema.senderDomains.id, warmupState: schema.senderDomains.warmupState })
      .from(schema.senderDomains).where(eq(schema.senderDomains.orgId, orgId)).limit(1);
    if (!sd[0]) {
      await db.insert(schema.senderDomains).values({
        orgId, domain: cfg.org.outreachSubdomain,
        sesConfigurationSet: cfg.ses.configurationSet,
        dailySendBudget: cfg.dailySendCapDefault,
        warmupState: initialWarmup,
        spfExpectedInclude: spfInclude,
        ...(dkimSelectors ? { dkimSelectors } : {}),
      });
      console.log(`sender_domain created (${cfg.org.outreachSubdomain}, warmup: ${initialWarmup}, SPF include: ${spfInclude}${dkimSelectors ? `, DKIM: ${dkimSelectors.join(',')}` : ''})`);
    } else {
      /* Promote a mailbox-host domain out of 'pending' (pre-warmed IPs); never
         override a deliberate 'paused'. */
      const promote = cfg.smtp.enabled && sd[0].warmupState === 'pending';
      await db.update(schema.senderDomains).set({
        domain: cfg.org.outreachSubdomain,
        spfExpectedInclude: spfInclude,
        ...(dkimSelectors ? { dkimSelectors } : {}),
        ...(promote ? { warmupState: 'warmed' } : {}),
      }).where(eq(schema.senderDomains.id, sd[0].id));
      console.log(`sender_domain reconciled (${cfg.org.outreachSubdomain}${promote ? ', warmup: warmed' : ''}, SPF include: ${spfInclude}${dkimSelectors ? `, DKIM: ${dkimSelectors.join(',')}` : ''})`);
    }
    const sv = await db.select({ id: schema.scoringVersions.id }).from(schema.scoringVersions).where(eq(schema.scoringVersions.id, 1)).limit(1);
    if (!sv[0]) {
      await db.insert(schema.scoringVersions).values({
        id: 1, orgId, weights: DEFAULT_WEIGHTS_V1 as unknown as Record<string, unknown>,
        notes: SCORING_VERSION_V1.notes ?? null,
      });
      console.log('scoring_versions v1 inserted');
    }
    console.log('seed done.');
  } finally {
    await close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
