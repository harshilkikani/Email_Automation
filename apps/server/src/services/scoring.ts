/**
 * Server-side scoring wrapper.
 *
 * Wraps `core.scoreLead` with the dynamic factors that depend on the database:
 *   - active scoring version from `scoring_versions` (org-scoped)
 *   - seasonal × weather multiplier from `niche_seasons` / `niche_weather_overlays`
 *   - market-saturation deboost from `market_saturation`
 *
 * Discovery and import paths should use `scoreLeadEnhanced` instead of calling
 * `scoreLead` directly so the dynamic factors are applied consistently.
 */
import { and, eq, desc, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import {
  scoreLead, SCORING_VERSION_V1, DEFAULT_SEASONS,
  seasonalMultiplier, applySeasonalMultiplier,
  type ScoringInputs, type ScoringResult, type ScoringVersion,
  type NicheSeasonConfig, type WeatherOverlay, type Niche,
} from '@keres/core';
import { saturationDeboost } from './saturation.js';

export interface EnhancedScoringContext {
  orgId: string;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  now?: Date;
}

export interface EnhancedScoringResult extends ScoringResult {
  baseScore: number;
  seasonalMultiplier: number;
  seasonalReason: string;
  saturationDeboost: number;
  finalScore: number;
}

export async function scoreLeadEnhanced(
  db: Database,
  inputs: ScoringInputs,
  ctx: EnhancedScoringContext,
): Promise<EnhancedScoringResult> {
  const version = await loadScoringVersion(db, ctx.orgId);
  const base = scoreLead(inputs, version);
  if (base.disqualified) {
    return { ...base, baseScore: 0, seasonalMultiplier: 1, seasonalReason: 'disqualified', saturationDeboost: 0, finalScore: 0 };
  }

  const seasons = await loadSeasonConfig(db, ctx.orgId, inputs.niche);
  const overlays = ctx.postalCode ? await loadWeatherOverlays(db, ctx.postalCode) : [];
  const seasonal = seasonalMultiplier({
    niche: inputs.niche,
    postalCode: ctx.postalCode ?? null,
    now: ctx.now ?? new Date(),
    config: seasons,
    overlays,
  });
  const seasonalAdjusted = applySeasonalMultiplier(base.score, seasonal);

  const deboost = await saturationDeboost(db, {
    orgId: ctx.orgId,
    niche: inputs.niche,
    postalCode: ctx.postalCode ?? null,
  });
  const finalScore = Math.max(0, Math.min(100, Math.round(seasonalAdjusted * (1 - deboost))));

  return {
    ...base,
    score: finalScore,
    baseScore: base.score,
    seasonalMultiplier: seasonal.multiplier,
    seasonalReason: seasonal.reason,
    saturationDeboost: deboost,
    finalScore,
  };
}

async function loadScoringVersion(db: Database, orgId: string): Promise<ScoringVersion> {
  const rows = await db.select().from(schema.scoringVersions)
    .where(eq(schema.scoringVersions.orgId, orgId))
    .orderBy(desc(schema.scoringVersions.id))
    .limit(1);
  const v = rows[0];
  if (!v) return SCORING_VERSION_V1;
  return {
    id: v.id,
    weights: v.weights as unknown as ScoringVersion['weights'],
    notes: v.notes ?? undefined,
  };
}

async function loadSeasonConfig(db: Database, orgId: string, niche: Niche): Promise<NicheSeasonConfig | null> {
  const row = (await db.select().from(schema.nicheSeasons).where(and(
    eq(schema.nicheSeasons.orgId, orgId),
    eq(schema.nicheSeasons.niche, niche),
  )).limit(1))[0];
  if (!row) return DEFAULT_SEASONS[niche] ?? null;
  return {
    niche,
    monthlyMultipliers: row.monthlyMultipliers,
    stormBoostMultiplier: row.stormBoostMultiplier,
    stormEventTypes: row.stormEventTypes,
    stormBoostWindowDays: row.stormBoostWindowDays,
    isActive: row.isActive,
  };
}

async function loadWeatherOverlays(db: Database, postalCode: string): Promise<WeatherOverlay[]> {
  const rows = await db.select().from(schema.nicheWeatherOverlays)
    .where(eq(schema.nicheWeatherOverlays.postalCode, postalCode));
  return rows.map(r => ({
    postalCode: r.postalCode,
    eventType: r.eventType,
    intensity: r.intensity,
    lastEventAt: r.lastEventAt,
  }));
}

/* Re-export the raw scorer for callers that want non-DB scoring. */
export { scoreLead, SCORING_VERSION_V1 };

/* Silence unused-import linters. */
void sql;
