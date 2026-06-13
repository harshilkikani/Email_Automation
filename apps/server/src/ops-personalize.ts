/**
 * One-shot: generate fact-grounded personalized openers for leads that need
 * them, on demand (runs regardless of the AI_PERSONALIZATION tick flag, since an
 * operator invoked it explicitly). Run it where an Ollama host is reachable (or
 * with AI off for deterministic openers) — e.g. locally against the DB:
 *
 *   node --env-file=.env apps/server/dist/.../ops-personalize.js [--limit N]
 *   (in the Fly machine:)
 *   fly ssh console -a keres-ops -C "node apps/server/dist/apps/server/src/ops-personalize.js"
 */
import { sql } from 'drizzle-orm';
import { getDbWithClose } from '@keres/db';
import { personalizeLead } from './services/personalization.js';
import { getAiAdapter } from './services/ai.js';

async function main() {
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 200;
  const { db, close } = getDbWithClose();
  try {
    const res = await db.execute(sql`
      SELECT l.id, l.name
      FROM leads l
      JOIN lead_signals s ON s.lead_id = l.id
      WHERE l.deleted_at IS NULL
        AND l.email IS NOT NULL
        AND l.status NOT IN ('bounced','unsubscribed','dnc')
        AND s.personalized_opener IS NULL
      ORDER BY l.score DESC, l.discovered_at DESC
      LIMIT ${limit}
    `);
    const rows = ((res as unknown as { rows?: Array<{ id: string; name: string }> }).rows ?? []);
    console.log(`Personalizing ${rows.length} lead(s) using adapter "${getAiAdapter().name}" …\n`);
    let written = 0, skipped = 0;
    for (const r of rows) {
      const opener = await personalizeLead(db, r.id);
      if (opener) { written++; console.log(`  ✓ ${r.name}\n      ${opener}`); }
      else { skipped++; console.log(`  – ${r.name} (no specific gap found)`); }
    }
    console.log(`\nDone: ${written} written, ${skipped} skipped.`);
  } finally {
    await close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
