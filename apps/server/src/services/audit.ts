/**
 * Audit-log helper — writes a row to `audit_log` for every state-changing
 * action that matters for incident reconstruction.
 *
 * Actor is "operator" at MVP (single-tenant). The IP + UA are recorded so we
 * can identify which device performed an action.
 *
 * Use sparingly: this is for *security-relevant* events, not chatty telemetry.
 */
import type { FastifyRequest } from 'fastify';
import { getDb } from '@keres/db';
import { schema } from '@keres/db';

export interface AuditEntry {
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export async function writeAudit(
  action: string, target: string | null | undefined, detail: Record<string, unknown> | undefined,
  req?: FastifyRequest,
): Promise<void> {
  try {
    const db = getDb();
    const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
    if (!org) return;
    await db.insert(schema.auditLog).values({
      orgId: org.id,
      actor: 'operator',
      action,
      target: target ?? null,
      detail: (detail ?? null) as unknown as Record<string, unknown> | null,
      ip: req ? (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? req.ip) : null,
      userAgent: req ? req.headers['user-agent']?.toString().slice(0, 256) ?? null : null,
    });
  } catch {
    /* Never let audit-log writes break the request. */
  }
}
