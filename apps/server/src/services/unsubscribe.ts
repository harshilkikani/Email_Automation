/**
 * Unsubscribe service. Verifies tokens, persists suppression, idempotent.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { verifyUnsubscribeToken } from '@keres/email';
import { getConfig } from '../config.js';

export interface UnsubscribeOutcome {
  ok: boolean;
  reason?: string;
  email?: string;
}

export async function processUnsubscribe(db: Database, token: string): Promise<UnsubscribeOutcome> {
  const cfg = getConfig();
  const payload = verifyUnsubscribeToken(token, cfg.authCookieSecret);
  if (!payload) return { ok: false, reason: 'invalid_or_expired_token' };
  const orgId = payload.scope === 'GLOBAL' ? null : payload.scope;
  await db.insert(schema.suppressions).values({
    orgId, email: payload.email, scope: orgId ? 'org' : 'global',
    reason: 'unsubscribe', sourceEvent: 'one_click_post',
    campaignId: payload.campaignId ?? null,
  }).onConflictDoNothing();
  if (orgId) {
    await db.update(schema.leads)
      .set({ status: 'unsubscribed' })
      .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.email, payload.email)));
  }
  return { ok: true, email: payload.email };
}
