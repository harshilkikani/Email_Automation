/**
 * Lead email verification (free chain).
 *
 * Wires the @keres/providers `FreeVerifier` to real DNS MX resolution:
 *   syntax → disposable → role → MX lookup.
 * SMTP probing stays OFF — cloud-IP RCPT probes are unreliable and can hurt
 * sender reputation, so a domain with valid MX resolves to `unknown` rather
 * than a confirmed mailbox. Cost is always $0.
 *
 * In sample mode we skip real DNS so demo data isn't flagged invalid.
 */
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { resolveMx as dnsResolveMx } from 'node:dns/promises';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { FreeVerifier, type VerificationResult } from '@keres/providers';
import { getConfig } from '../config.js';

const SKIPPED: VerificationResult = { status: 'skipped', source: 'skipped', detail: 'sample_mode' };

async function resolveMx(domain: string): Promise<string[]> {
  try {
    const records = await dnsResolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
  } catch {
    return [];
  }
}

const verifier = new FreeVerifier({ resolveMx, enableSmtp: false });

/** Verify a single email address. Returns a `skipped` result in sample mode. */
export async function verifyEmailAddress(email: string | null | undefined): Promise<VerificationResult | null> {
  if (!email) return null;
  if (getConfig().sampleMode) return SKIPPED;
  return verifier.verify(email);
}

/** Map a verification result onto the lead's persisted verification columns. */
export function verificationFields(result: VerificationResult) {
  return {
    emailVerifiedAt: new Date(),
    emailVerificationStatus: result.status,
    emailVerificationSource: result.source,
    emailVerificationCostCents: result.costCents ?? 0,
  };
}

export interface VerifyLeadOutput {
  ok: boolean;
  error?: string;
  status?: string;
  source?: string;
}

/** Verify one lead by id and persist the result. */
export async function verifyLead(db: Database, leadId: string): Promise<VerifyLeadOutput> {
  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
  if (!lead) return { ok: false, error: 'not_found' };
  if (!lead.email) return { ok: false, error: 'no_email' };
  const result = await verifyEmailAddress(lead.email);
  if (!result) return { ok: false, error: 'no_email' };
  await db.update(schema.leads).set(verificationFields(result)).where(eq(schema.leads.id, leadId));
  return { ok: true, status: result.status, source: result.source };
}

export interface VerifyPendingOutput {
  ok: true;
  verified: number;
  skipped: number;
}

/**
 * Verify up to `limit` leads that have an email but no verification status yet.
 * Runs sequentially so DNS lookups don't fan out into a burst.
 */
export async function verifyPendingLeads(db: Database, orgId: string, limit = 100): Promise<VerifyPendingOutput> {
  const pending = await db.select({ id: schema.leads.id, email: schema.leads.email })
    .from(schema.leads)
    .where(and(
      eq(schema.leads.orgId, orgId),
      isNull(schema.leads.deletedAt),
      isNotNull(schema.leads.email),
      isNull(schema.leads.emailVerificationStatus),
    ))
    .limit(Math.min(limit, 500));

  let verified = 0, skipped = 0;
  for (const lead of pending) {
    const result = await verifyEmailAddress(lead.email);
    if (!result) { skipped++; continue; }
    await db.update(schema.leads).set(verificationFields(result)).where(eq(schema.leads.id, lead.id));
    verified++;
  }
  return { ok: true, verified, skipped };
}
