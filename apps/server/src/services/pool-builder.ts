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

/* Two cursors so we can concentrate on focus trades without abandoning the rest:
   `cursor` walks the full grid, `focusCursor` walks the focus-only grid. Random
   start so restarts/deploys don't re-sweep cell 0; dedupe makes overlap harmless. */
let cursor = Math.floor(Math.random() * 1_000_000);
let focusCursor = Math.floor(Math.random() * 1_000_000);

/* Cells processed per tick — sequential, so they don't pile network/CPU on the
   small machine. With a 2-minute tick that's ~2,000+ cells/day. */
const CELLS_PER_TICK = 3;

/** The niches discovery should actually sweep: focus trades when set (filtered to
 *  real niches), else all. Pure for testing. */
export function effectiveNiches(all: Niche[], focus: string[] | null | undefined): Niche[] {
  if (!focus || focus.length === 0) return all;
  const valid = new Set(all as string[]);
  const picked = focus.filter(f => valid.has(f)) as Niche[];
  return picked.length > 0 ? picked : all;
}

export async function tickPoolBuilder(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.poolBuilder.enabled || cfg.sampleMode) return { skipped: 'disabled' };
  const org = (await db.select({ id: schema.organizations.id, focusNiches: schema.organizations.focusNiches })
    .from(schema.organizations).limit(1))[0];
  if (!org) return { skipped: 'no_org' };

  /* Focus trades get most of the tick's cells (fattens those pools fast); when
     focus is active we still spend the first cell on the full grid so the other
     trades keep growing slowly and no leads are ever abandoned. */
  const focus = effectiveNiches(NICHES, org.focusNiches);
  const focusActive = focus.length < NICHES.length;

  let inserted = 0, found = 0, processed = 0;
  const cells: string[] = [];
  for (let i = 0; i < CELLS_PER_TICK; i++) {
    const useFocus = focusActive && i > 0;
    const grid = useFocus ? focus : NICHES;
    const total = grid.length * US_METROS.length;
    const idx = (useFocus ? focusCursor++ : cursor++) % total;
    /* Interleave niches within each metro so variety builds fast. */
    const niche = grid[idx % grid.length]!;
    const metro = US_METROS[Math.floor(idx / grid.length) % US_METROS.length]!;
    try {
      const r = await runDiscovery(db, {
        orgId: org.id, niche, city: metro.city, state: metro.state, targetCount: 10,
      });
      inserted += r.inserted; found += r.found; processed++;
      if (r.inserted > 0) cells.push(`${niche}/${metro.city}+${r.inserted}`);
    } catch { /* one cell failing shouldn't stop the batch */ }
  }
  const total = NICHES.length * US_METROS.length;
  if (inserted > 0) log.info({ inserted, found, processed, cells, focus: focusActive ? focus : 'all' }, 'pool builder');
  return { inserted, found, processed, cells, total, focus: focusActive ? focus : null };
}
