/**
 * Fact-grounded personalization tick.
 *
 * Batch job (NOT in the send hot path): for leads that have scraped intel +
 * computed signals but no opener yet, derive the *true* deficiencies and ask the
 * AI adapter to phrase a 1–2 sentence opener from them. The result is cached on
 * `lead_signals.personalized_opener` and read at render time.
 *
 * Degrades gracefully: if the AI adapter returns null (Ollama off or errored) we
 * fall back to a deterministic, still fact-grounded opener. With nothing
 * verifiable to say, we leave the opener null and the renderer uses its slot
 * opener — so behavior is never worse than today.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  deriveDeficiencies, deterministicOpener,
  type IntelFacts, type SignalFacts, type Niche,
} from '@keres/core';
import { getAiAdapter } from './ai.js';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

const PRODUCT = 'a 24/7 AI receptionist that answers every call and books the job';
const BATCH = 25;

/** Generate + store a personalized opener for one lead. Returns the opener or null. */
export async function personalizeLead(db: Database, leadId: string): Promise<string | null> {
  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
  if (!lead) return null;
  const intel = (await db.select().from(schema.websiteIntel).where(eq(schema.websiteIntel.leadId, leadId)).limit(1))[0];
  const sig = (await db.select().from(schema.leadSignals).where(eq(schema.leadSignals.leadId, leadId)).limit(1))[0];
  if (!sig) return null;

  const intelFacts: IntelFacts = {
    bookingVendor: intel?.bookingVendor ?? null,
    techStack: intel?.techStack ?? [],
    emails: intel?.emails ?? [],
    hoursText: intel?.hoursText ?? null,
    yearFounded: intel?.yearFounded ?? null,
  };
  const signalFacts: SignalFacts = {
    webPresenceLevel: (sig.webPresenceLevel ?? 'unknown') as SignalFacts['webPresenceLevel'],
    hasOnlineBooking: sig.hasOnlineBooking,
    reviewCount30d: sig.reviewCount30d ?? null,
    reviewRating: sig.reviewRating ?? null,
  };

  const deficiencies = deriveDeficiencies(intelFacts, signalFacts);
  if (deficiencies.length === 0) return null;   // nothing true & specific to say

  const adapter = getAiAdapter();
  let opener: string | null = null;
  const ownerFirst = lead.ownerName?.trim().split(/\s+/)[0] ?? null;
  let model = adapter.name;
  try {
    opener = await adapter.personalizeOpener({
      business: lead.name, city: lead.city ?? '',
      niche: lead.niche as Niche, deficiencies, product: PRODUCT, ownerFirst,
    });
  } catch (e) {
    obs().captureException(e, { leadId, op: 'personalize_opener' });
  }
  if (!opener) {
    opener = deterministicOpener(lead.name, lead.city ?? '', deficiencies, ownerFirst);
    model = 'deterministic';
  }
  if (!opener) return null;

  await db.update(schema.leadSignals).set({
    personalizedOpener: opener,
    personalizationFact: deficiencies[0]!.code,
    personalizationModel: model,
    personalizationAt: new Date(),
  }).where(eq(schema.leadSignals.leadId, leadId));
  return opener;
}

export async function tickPersonalization(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.ai.personalization) return { skipped: 'disabled' };

  /* Leads with computed signals but no opener yet, sendable, highest-score first. */
  const candidates = await db.execute(sql`
    SELECT l.id
    FROM leads l
    JOIN lead_signals s ON s.lead_id = l.id
    WHERE l.deleted_at IS NULL
      AND l.email IS NOT NULL
      AND l.status NOT IN ('bounced','unsubscribed','dnc')
      AND s.personalized_opener IS NULL
    ORDER BY l.score DESC, l.discovered_at DESC
    LIMIT ${BATCH}
  `);
  const rows = ((candidates as unknown as { rows?: Array<{ id: string }> }).rows ?? []) as Array<{ id: string }>;

  let written = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    try {
      const opener = await personalizeLead(db, r.id);
      if (opener) written++; else skipped++;
    } catch (e) {
      failed++;
      obs().captureException(e, { leadId: r.id, op: 'tick_personalization' });
    }
  }
  log.info({ written, skipped, failed, candidates: rows.length, model: getAiAdapter().name }, 'personalization tick');
  return { written, skipped, failed };
}
