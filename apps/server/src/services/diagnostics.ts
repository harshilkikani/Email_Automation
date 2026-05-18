/**
 * System diagnostics — wraps the launch gate for the "deployment health"
 * dashboard. Reports DB connectivity, migration freshness, provider config,
 * DNS green, unsubscribe reachable, SES config, inbound webhook, budget
 * status, sample mode, last successful job.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@keres/db';
import { getConfig } from '../config.js';
import { evaluateLaunchGate, type LaunchGateReport } from './launch-gate.js';

export interface Diagnostics {
  ok: boolean;
  db: 'connected' | 'unreachable';
  migrations: { current: boolean; lastApplied: string | null };
  providers: Record<string, boolean>;
  sampleMode: boolean;
  budgetMode: string;
  lastJobRun: { kind: string; status: string; completedAt: string | null } | null;
  lastSeedlistPassAt: string | null;
  gate: LaunchGateReport;
}

export async function runDiagnostics(): Promise<Diagnostics> {
  const cfg = getConfig();
  const db = getDb();
  let dbState: 'connected' | 'unreachable' = 'connected';
  let lastMigration: string | null = null;
  try {
    const r = await db.execute(sql`SELECT name FROM _keres_migrations ORDER BY applied_at DESC LIMIT 1`);
    const row: any = (r as any).rows?.[0] ?? (r as any)[0];
    lastMigration = row?.name ?? null;
  } catch { dbState = 'unreachable'; }
  const job = (await db.select().from(schema.jobRuns).orderBy(desc(schema.jobRuns.completedAt)).limit(1))[0] ?? null;
  const domain = (await db.select().from(schema.senderDomains).orderBy(desc(schema.senderDomains.lastCheckedAt)).limit(1))[0] ?? null;
  const gate = await evaluateLaunchGate(db, {
    bouncePausePct: cfg.bouncePausePct,
    complaintPausePct: cfg.complaintPausePct,
    seedlistTtlHours: 24 * 7,
    systemDiagnostics: true,
  });
  return {
    ok: dbState === 'connected' && gate.ok,
    db: dbState,
    migrations: { current: dbState === 'connected' && !!lastMigration, lastApplied: lastMigration },
    providers: {
      ses: cfg.ses.enabled,
      postmark_inbound: cfg.postmarkInbound.enabled,
      osm: cfg.osm.enabled,
      yelp: cfg.yelp.enabled,
      hunter: cfg.hunter.enabled,
      bouncer: cfg.bouncer.enabled,
      places: cfg.places.enabled,
    },
    sampleMode: cfg.sampleMode,
    budgetMode: cfg.budgetMode,
    lastJobRun: job ? { kind: job.kind, status: job.status, completedAt: job.completedAt?.toISOString() ?? null } : null,
    lastSeedlistPassAt: domain?.lastSeedlistPassAt?.toISOString() ?? null,
    gate,
  };
}
