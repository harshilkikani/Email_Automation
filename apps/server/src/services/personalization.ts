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
  deriveDeficiencies, deterministicOpener, composeEmail, messageVariant, cleanFirstName,
  type IntelFacts, type SignalFacts, type Niche,
} from '@keres/core';
import { getAiAdapter } from './ai.js';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

const PRODUCT = 'custom-built solutions for local businesses — websites, online booking, automated review systems, and 24/7 AI phone agents — each matched to the specific gap holding that business back';
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

  /* Derive verifiable gaps. May be empty — that's fine now: the deterministic
     composer produces a varied, still-true generic email so EVERY lead is
     personalized (no one falls back to the identical bare template). */
  const deficiencies = deriveDeficiencies(intelFacts, signalFacts);

  const adapter = getAiAdapter();
  let opener: string | null = null;
  const ownerFirst = cleanFirstName(lead.ownerName);
  let model = adapter.name;
  try {
    opener = deficiencies.length
      ? await adapter.personalizeOpener({
          business: lead.name, city: lead.city ?? '',
          niche: lead.niche as Niche, deficiencies, product: PRODUCT, ownerFirst,
        })
      : null;   // no LLM invention with nothing specific to say
  } catch (e) {
    obs().captureException(e, { leadId, op: 'personalize_opener' });
  }
  if (!opener) {
    /* seed = leadId → each business gets a different (but stable) variant. */
    opener = deterministicOpener(lead.name, lead.city ?? '', deficiencies, ownerFirst, leadId);
    model = 'deterministic';
  }

  /* Deep personalization: a FULL email body (AI if available, else the
     deterministic composer). Replaces the template body for the first touch. */
  let body: string | null = null;
  try {
    body = deficiencies.length
      ? await adapter.personalizeEmail({
          business: lead.name, city: lead.city ?? '',
          niche: lead.niche as Niche, deficiencies, product: PRODUCT, ownerFirst,
        })
      : null;
  } catch (e) {
    obs().captureException(e, { leadId, op: 'personalize_email' });
  }
  if (!body) {
    body = composeEmail({ business: lead.name, city: lead.city ?? '', niche: lead.niche as Niche, deficiencies, ownerFirst, seed: leadId });
  }

  await db.update(schema.leadSignals).set({
    personalizedOpener: opener,
    personalizedBody: body,
    personalizationFact: deficiencies[0]?.code ?? 'generic',
    personalizationModel: model,
    personalizationVariant: messageVariant({ niche: lead.niche as Niche, deficiencies, seed: leadId }) as unknown as Record<string, unknown>,
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
