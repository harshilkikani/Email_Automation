/**
 * Background re-verification of the existing lead pool.
 *
 * Leads discovered before catch-all detection existed were marked sendable even
 * when their mailbox is dead or the domain is catch-all — that's what drives the
 * high bounce rate (>2% is a domain-wide spam trigger). This tick re-runs the
 * (now catch-all-aware) verifier over sendable leads and flips the bad ones to
 * invalid/catch_all so `isSendableStatus` excludes them everywhere, including any
 * already-queued recipients via the send-time guard in sender-pipeline.
 *
 * Paced deliberately: SMTP RCPT probes hit recipient MX servers, so we do a small
 * batch per tick. Leads about to send (queued recipients) are re-checked first.
 * `last_verified_at` is the marker — set on each pass, so the pool is swept once
 * then re-checked weekly, never in a tight loop.
 */
import { sql, eq } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { getConfig } from '../config.js';
import { getVerifier, isSendableStatus } from './verify.js';
import { obs } from '../observability.js';

const UNSENDABLE = new Set(['invalid', 'disposable', 'catch_all']);

export interface ReverifyResult {
  skipped?: string;
  rechecked?: number;
  newlyBad?: number;
  stillSendable?: number;
}

export async function tickReverify(db: Database, log: FastifyBaseLogger): Promise<ReverifyResult> {
  const cfg = getConfig();
  if (!cfg.reverify.enabled || cfg.sampleMode) return { skipped: 'disabled' };

  const batch = Math.max(1, cfg.reverify.batch);
  /* Pick sendable, emailable leads not verified in the last 7 days, queued ones
     first (about to send), then highest score. */
  const res = await db.execute(sql`
    SELECT l.id, l.email
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT 1 FROM campaign_recipients cr
      WHERE cr.lead_id = l.id AND cr.state IN ('pending','queued') LIMIT 1
    ) q ON true
    WHERE l.deleted_at IS NULL
      AND l.email IS NOT NULL
      AND l.status NOT IN ('bounced','unsubscribed','dnc')
      AND (l.email_verification_status IS NULL
           OR l.email_verification_status NOT IN ('invalid','disposable','catch_all'))
      AND (l.last_verified_at IS NULL OR l.last_verified_at < now() - interval '7 days')
    ORDER BY (q IS NOT NULL) DESC, l.score DESC
    LIMIT ${batch}
  `);
  const rows = ((res as unknown as { rows?: Array<{ id: string; email: string }> }).rows ?? []) as Array<{ id: string; email: string }>;
  if (rows.length === 0) return { rechecked: 0, newlyBad: 0, stillSendable: 0 };

  const verifier = getVerifier();
  let rechecked = 0, newlyBad = 0, stillSendable = 0;
  for (const r of rows) {
    rechecked++;
    let status = 'unknown', source = 'mx';
    try { const v = await verifier.verify(r.email); status = v.status; source = v.source; }
    catch (e) { obs().captureException(e, { leadId: r.id, op: 'reverify' }); }

    const set: Partial<typeof schema.leads.$inferInsert> = {
      emailVerificationStatus: status,
      emailVerificationSource: source,
      lastVerifiedAt: new Date(),
    };
    if (UNSENDABLE.has(status)) { newlyBad++; }
    else if (isSendableStatus(status)) { stillSendable++; }
    await db.update(schema.leads).set(set).where(eq(schema.leads.id, r.id));
  }

  if (newlyBad > 0) log.info({ rechecked, newlyBad, stillSendable }, 'reverify swept bad addresses');
  obs().meter.gauge('reverify_newly_bad_total', newlyBad);
  return { rechecked, newlyBad, stillSendable };
}
