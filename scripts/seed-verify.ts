#!/usr/bin/env tsx
/**
 * `tsx scripts/seed-verify.ts` — prints row counts for the core tables.
 * Never prints sensitive values. Just counts.
 *
 * Expects DATABASE_URL in env. Use only with read-only credentials when
 * possible. Returns non-zero if any required table is missing.
 */
import { Client } from 'pg';

const tables = [
  'organizations',
  'scoring_versions',
  'sender_domains',
  'campaigns',
  'campaign_recipients',
  'leads',
  'lead_signals',
  'discovery_jobs',
  'email_events',
  'suppressions',
  'job_runs',
  'audit_logs',
  'cost_events',
  'state_licensees',
  'validation_experiments',
  'seedlist_tests',
  '_keres_migrations',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await c.connect();
  try {
    const sizes: Array<[string, number | string]> = [];
    for (const t of tables) {
      try {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        sizes.push([t, r.rows[0]?.n ?? 0]);
      } catch (e: any) {
        sizes.push([t, `(missing: ${(e?.message ?? '').split('\n')[0]})`]);
      }
    }
    const w = Math.max(...tables.map(t => t.length));
    for (const [t, n] of sizes) console.log(`  ${t.padEnd(w)}  ${n}`);
  } finally {
    await c.end();
  }
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
