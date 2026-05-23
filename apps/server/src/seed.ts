/**
 * Seed script: creates the single organization, a sender domain, and one
 * scoring_versions row. Idempotent — safe to run multiple times.
 */
import { getDbWithClose } from '@keres/db';
import { schema } from '@keres/db';
import { DEFAULT_WEIGHTS_V1, SCORING_VERSION_V1 } from '@keres/core';
import { eq } from 'drizzle-orm';
import { getConfig } from './config.js';

async function main() {
  const cfg = getConfig();
  const { db, close } = getDbWithClose();
  try {
    const existing = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
    let orgId: string;
    if (existing[0]) {
      orgId = existing[0].id;
      console.log(`org already exists: ${orgId}`);
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
    const sd = await db.select({ id: schema.senderDomains.id }).from(schema.senderDomains).where(eq(schema.senderDomains.orgId, orgId)).limit(1);
    if (!sd[0]) {
      await db.insert(schema.senderDomains).values({
        orgId, domain: cfg.org.outreachSubdomain,
        sesConfigurationSet: cfg.ses.configurationSet,
        dailySendBudget: cfg.dailySendCapDefault,
        warmupState: cfg.sampleMode ? 'warmed' : 'pending',
      });
      console.log('sender_domain created');
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
