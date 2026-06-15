/**
 * Background pool builder — grows the lead pool toward thousands, hands-off.
 *
 * Walks every (niche × US metro) cell one per tick, running the normal
 * discovery + enrich + verify pipeline so the pool fills 24/7 without the
 * operator looping the browser. OSM carries it (no quota); Brave adds open-web
 * businesses until its monthly quota, then fails soft. Per-org + per-source
 * dedupe means re-passes don't create duplicates. Gated by ENABLE_POOL_BUILDER.
 */
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Niche } from '@keres/core';
import { getConfig } from '../config.js';
import { runDiscovery } from './discovery.js';
import { US_METROS } from './quick.js';

const NICHES: Niche[] = [
  'Septic', 'Roofer', 'Water/Mold', 'HVAC', 'Plumber', 'Electrician', 'Towing', 'Real Estate',
  'Pest Control', 'Garage Door', 'Locksmith', 'Appliance Repair', 'Pool Service', 'Landscaping',
  'Painter', 'Carpet Cleaning', 'Handyman', 'Tree Service',
  'Fencing', 'Concrete', 'Moving', 'Junk Removal', 'Window Cleaning', 'Pressure Washing', 'Solar', 'Flooring',
];

/* Cursor over the (niche × metro) grid. Start at a RANDOM cell each process
   start so frequent restarts/deploys don't keep re-sweeping cell 0 — it explores
   the whole 4,914-cell space over time, and dedupe makes overlap harmless. */
let cursor = Math.floor(Math.random() * 1_000_000);

/* Cells processed per tick — sequential, so they don't pile network/CPU on the
   small machine. With a 2-minute tick that's ~2,000+ cells/day. */
const CELLS_PER_TICK = 3;

export async function tickPoolBuilder(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.poolBuilder.enabled || cfg.sampleMode) return { skipped: 'disabled' };
  const org = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };

  const total = NICHES.length * US_METROS.length;
  let inserted = 0, found = 0, processed = 0;
  const cells: string[] = [];
  for (let i = 0; i < CELLS_PER_TICK; i++) {
    const idx = cursor % total;
    cursor++;
    /* Interleave niches within each metro so variety builds fast. */
    const niche = NICHES[idx % NICHES.length]!;
    const metro = US_METROS[Math.floor(idx / NICHES.length) % US_METROS.length]!;
    try {
      const r = await runDiscovery(db, {
        orgId: org.id, niche, city: metro.city, state: metro.state, targetCount: 10,
      });
      inserted += r.inserted; found += r.found; processed++;
      if (r.inserted > 0) cells.push(`${niche}/${metro.city}+${r.inserted}`);
    } catch { /* one cell failing shouldn't stop the batch */ }
  }
  if (inserted > 0) log.info({ inserted, found, processed, cells }, 'pool builder');
  return { inserted, found, processed, cells, total };
}
