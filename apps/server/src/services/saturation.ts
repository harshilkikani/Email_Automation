/**
 * Market saturation server service.
 *
 *   - `tickSaturationRefresh` (every 12h): walks each (org, niche, postal_code)
 *     cell, sums recent sends with exponential decay, and upserts a
 *     market_saturation row keyed by the rolling window end date.
 *   - `checkSaturationBeforeSend`: gated by sender-pipeline.ts — looks up the
 *     latest market_saturation row for the lead's geo and decides {ok, block}.
 *   - `saturationDeboost`: read-only — returns the deboost fraction the
 *     scoring path multiplies (1 - deboost) by.
 */
import { and, eq, gte, sql, desc, isNotNull } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_SATURATION_CONFIG, computeSaturationPct, softDeboost, shouldBlock,
  type SaturationConfig, type SaturationEvent,
} from '@keres/core';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

function getSaturationConfig(): SaturationConfig {
  const c = getConfig().saturation;
  return {
    rollingDays: c.rollingDays,
    hardCapPct: c.hardCapPct,
    softCapPct: c.softCapPct,
    decayTauDays: c.decayTauDays,
  };
}

/* ────────── Refresh ────────── */

export async function tickSaturationRefresh(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getSaturationConfig();
  const now = new Date();
  const windowStart = new Date(now.getTime() - cfg.rollingDays * 86400_000);
  const windowEndDate = now.toISOString().slice(0, 10);

  /* Pull every (org, niche, postal_code) that had any send in the window
     plus the eligible-leads count for that cell. */
  const cells = await db.execute(sql`
    SELECT
      l.org_id,
      l.niche,
      l.postal_code,
      l.city,
      l.state,
      cr.lead_id,
      cr.first_sent_at
    FROM campaign_recipients cr
    JOIN leads l ON l.id = cr.lead_id
    WHERE cr.first_sent_at >= ${windowStart.toISOString()}
      AND l.deleted_at IS NULL
      AND l.postal_code IS NOT NULL
  `);
  const rows = ((cells as unknown as { rows?: SatCellRow[] }).rows ?? []) as SatCellRow[];

  /* Group by (orgId, niche, postalCode). */
  type Key = string;
  type Group = {
    orgId: string; niche: string; postalCode: string; city: string | null; state: string | null;
    events: SaturationEvent[];
  };
  const groups = new Map<Key, Group>();
  for (const r of rows) {
    const key = `${r.org_id}|${r.niche}|${r.postal_code}`;
    if (!groups.has(key)) {
      groups.set(key, { orgId: r.org_id, niche: r.niche, postalCode: r.postal_code, city: r.city, state: r.state, events: [] });
    }
    groups.get(key)!.events.push({ leadId: r.lead_id, sentAt: r.first_sent_at });
  }

  /* Single query to get eligible-lead counts for all (org, niche, postal_code) cells. */
  const eligibleResult = await db.execute(sql`
    SELECT org_id, niche, postal_code, count(*)::int AS c
    FROM leads
    WHERE deleted_at IS NULL AND postal_code IS NOT NULL
    GROUP BY org_id, niche, postal_code
  `);
  const eligibleCountMap = new Map<string, number>();
  for (const row of ((eligibleResult as unknown as { rows?: Array<{ org_id: string; niche: string; postal_code: string; c: number }> }).rows ?? [])) {
    eligibleCountMap.set(`${row.org_id}|${row.niche}|${row.postal_code}`, Number(row.c));
  }

  /* For each cell, count eligible leads (any lead in the same niche+zip
     regardless of contact state). */
  let written = 0;
  for (const g of groups.values()) {
    const eligibleLeads = eligibleCountMap.get(`${g.orgId}|${g.niche}|${g.postalCode}`) ?? 0;
    const saturationPct = computeSaturationPct(g.events, eligibleLeads, now, cfg.decayTauDays);
    const sentLeads = new Set(g.events.map(e => e.leadId)).size;

    await db.insert(schema.marketSaturation).values({
      orgId: g.orgId,
      niche: g.niche,
      city: g.city,
      state: g.state,
      postalCode: g.postalCode,
      windowEndDate, rollingDays: cfg.rollingDays,
      sentLeads, eligibleLeads, saturationPct,
    }).onConflictDoUpdate({
      target: [
        schema.marketSaturation.orgId,
        schema.marketSaturation.niche,
        schema.marketSaturation.postalCode,
        schema.marketSaturation.windowEndDate,
        schema.marketSaturation.rollingDays,
      ],
      set: { sentLeads, eligibleLeads, saturationPct, computedAt: new Date() },
    });
    written++;
  }
  log.info({ written, cells: groups.size }, 'saturation refresh');
  obs().meter.gauge('saturation_cells_total', written);
  return { written, cells: groups.size };
}

interface SatCellRow {
  org_id: string;
  niche: string;
  postal_code: string;
  city: string | null;
  state: string | null;
  lead_id: string;
  first_sent_at: Date;
}

/* ────────── Per-send gate ────────── */

export interface SaturationGateInput {
  orgId: string;
  niche: string;
  postalCode: string | null | undefined;
}

export async function checkSaturationBeforeSend(
  db: Database,
  input: SaturationGateInput,
): Promise<{ action: 'allow' | 'block'; saturationPct: number; reason?: string }> {
  if (!input.postalCode) return { action: 'allow', saturationPct: 0 };
  const cfg = getSaturationConfig();
  const row = await loadLatestSaturation(db, input);
  const pct = row?.saturationPct ?? 0;
  if (shouldBlock(pct, cfg)) {
    return { action: 'block', saturationPct: pct, reason: `pct_${pct.toFixed(1)}_hard_cap_${cfg.hardCapPct}` };
  }
  return { action: 'allow', saturationPct: pct };
}

export async function saturationDeboost(
  db: Database,
  input: SaturationGateInput,
): Promise<number> {
  if (!input.postalCode) return 0;
  const cfg = getSaturationConfig();
  const row = await loadLatestSaturation(db, input);
  return softDeboost(row?.saturationPct ?? 0, cfg);
}

async function loadLatestSaturation(
  db: Database,
  input: SaturationGateInput,
): Promise<{ saturationPct: number } | null> {
  if (!input.postalCode) return null;
  const cfg = getSaturationConfig();
  const r = (await db.select({ saturationPct: schema.marketSaturation.saturationPct })
    .from(schema.marketSaturation)
    .where(and(
      eq(schema.marketSaturation.orgId, input.orgId),
      eq(schema.marketSaturation.niche, input.niche),
      eq(schema.marketSaturation.postalCode, input.postalCode),
      eq(schema.marketSaturation.rollingDays, cfg.rollingDays),
    ))
    .orderBy(desc(schema.marketSaturation.windowEndDate))
    .limit(1))[0];
  return r ? { saturationPct: r.saturationPct } : null;
}

/* Silence unused-import linters. */
void gte; void isNotNull;
