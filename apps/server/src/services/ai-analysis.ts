/**
 * Weekly AI analysis tick — feeds the last 7 days of classified inbound
 * replies into the AI adapter for topic clustering, objection analysis, and
 * recommendations. Results are persisted to ai_runs for the operator dashboard.
 *
 * Deduplicates by inputHash so re-runs on the same reply corpus are no-ops.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { getAiAdapter } from './ai.js';

export async function tickAiAnalysis(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const ai = getAiAdapter();
  const orgRow = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!orgRow) return { skipped: 'no_org' };

  const recentMessages = await db.select({
    autoIntent: schema.inboundMessages.autoIntent,
    subject: schema.inboundMessages.subject,
    textBody: schema.inboundMessages.textBody,
  }).from(schema.inboundMessages)
    .where(and(
      eq(schema.inboundMessages.orgId, orgRow.id),
      sql`${schema.inboundMessages.receivedAt} > now() - interval '7 days'`,
    ))
    .limit(100);

  if (recentMessages.length === 0) return { analyzed: 0, reason: 'no_messages' };

  const samples = recentMessages.map(m => ({
    intent: m.autoIntent ?? 'unknown',
    subject: m.subject ?? '',
    body: (m.textBody ?? '').slice(0, 200),
  }));
  const inputHash = createHash('sha256').update(JSON.stringify(samples)).digest('hex');

  const existing = await db.select({ id: schema.aiRuns.id })
    .from(schema.aiRuns)
    .where(and(
      eq(schema.aiRuns.orgId, orgRow.id),
      eq(schema.aiRuns.operation, 'analyze_replies'),
      eq(schema.aiRuns.inputHash, inputHash),
    ))
    .limit(1);
  if (existing.length > 0) return { analyzed: 0, reason: 'cached' };

  const start = Date.now();
  let status: 'ok' | 'error' = 'ok';
  let result: unknown = null;
  let error: string | null = null;

  try {
    result = await ai.analyzeReplies({ samples });
  } catch (e: any) {
    status = 'error';
    error = e?.message ?? String(e);
  }

  await db.insert(schema.aiRuns).values({
    orgId: orgRow.id,
    adapter: ai.name,
    operation: 'analyze_replies',
    inputHash,
    latencyMs: Date.now() - start,
    result: result as Record<string, unknown> | null,
    status,
    error,
  });

  log.info({ status, adapter: ai.name, messages: recentMessages.length }, 'ai analysis tick');
  return { analyzed: recentMessages.length, status };
}
