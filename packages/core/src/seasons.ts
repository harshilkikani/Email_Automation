/**
 * Niche × season × weather scoring multipliers.
 *
 * Returns a multiplier the scoring path applies after the base 0-100 score is
 * computed. Multiplier is clamped to [0.5, 1.6] so a single seasonal signal
 * can't dominate the deterministic scoring weights — it nudges, not replaces.
 *
 * Pure: no DB. The server service in apps/server/src/services/scoring.ts
 * loads niche_seasons + niche_weather_overlays and passes the relevant row
 * here.
 */
import type { Niche } from './types.js';

export interface NicheSeasonConfig {
  niche: Niche;
  /** Length 12, index 0 = January. */
  monthlyMultipliers: number[];
  stormBoostMultiplier: number;
  stormEventTypes: string[];
  stormBoostWindowDays: number;
  isActive: boolean;
}

export interface WeatherOverlay {
  postalCode: string;
  eventType: string;
  intensity: number;
  lastEventAt: Date | null;
}

export const MIN_MULTIPLIER = 0.5;
export const MAX_MULTIPLIER = 1.6;

/** Vanilla defaults used when an org has no niche_seasons row yet. */
export const DEFAULT_SEASONS: Record<Niche, NicheSeasonConfig> = {
  Septic: {
    niche: 'Septic',
    monthlyMultipliers: [0.9, 0.9, 1.0, 1.1, 1.2, 1.2, 1.15, 1.1, 1.05, 1.0, 0.95, 0.9],
    stormBoostMultiplier: 1.10, stormEventTypes: ['Flood', 'Heavy Rain'], stormBoostWindowDays: 30, isActive: true,
  },
  Roofer: {
    niche: 'Roofer',
    monthlyMultipliers: [0.85, 0.85, 0.95, 1.05, 1.1, 1.05, 1.0, 1.0, 1.05, 1.1, 1.05, 0.95],
    stormBoostMultiplier: 1.40, stormEventTypes: ['Hail', 'Tornado', 'Hurricane', 'Thunderstorm Wind'], stormBoostWindowDays: 30, isActive: true,
  },
  HVAC: {
    niche: 'HVAC',
    monthlyMultipliers: [1.15, 1.05, 0.95, 0.9, 1.0, 1.2, 1.3, 1.25, 1.05, 0.95, 1.0, 1.15],
    stormBoostMultiplier: 1.05, stormEventTypes: ['Excessive Heat', 'Extreme Cold/Wind Chill'], stormBoostWindowDays: 30, isActive: true,
  },
  Plumber: {
    niche: 'Plumber',
    monthlyMultipliers: [1.1, 1.1, 1.05, 1.0, 0.95, 0.95, 0.95, 0.95, 1.0, 1.05, 1.1, 1.15],
    stormBoostMultiplier: 1.10, stormEventTypes: ['Extreme Cold/Wind Chill'], stormBoostWindowDays: 30, isActive: true,
  },
  'Water/Mold': {
    niche: 'Water/Mold',
    monthlyMultipliers: [0.9, 0.95, 1.05, 1.15, 1.2, 1.15, 1.1, 1.05, 1.05, 1.0, 0.95, 0.9],
    stormBoostMultiplier: 1.50, stormEventTypes: ['Flood', 'Heavy Rain', 'Hurricane'], stormBoostWindowDays: 30, isActive: true,
  },
  Electrician: {
    niche: 'Electrician',
    monthlyMultipliers: [1.0, 1.0, 1.05, 1.05, 1.05, 1.05, 1.1, 1.05, 1.05, 1.0, 0.95, 0.95],
    stormBoostMultiplier: 1.10, stormEventTypes: ['Thunderstorm Wind', 'Hurricane'], stormBoostWindowDays: 30, isActive: true,
  },
  Towing: {
    niche: 'Towing',
    monthlyMultipliers: [1.2, 1.15, 1.05, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 1.0, 1.1, 1.2],
    stormBoostMultiplier: 1.20, stormEventTypes: ['Heavy Snow', 'Ice Storm', 'Winter Storm'], stormBoostWindowDays: 30, isActive: true,
  },
  'Real Estate': {
    niche: 'Real Estate',
    monthlyMultipliers: [0.9, 0.95, 1.05, 1.1, 1.15, 1.1, 1.05, 1.0, 1.0, 0.95, 0.9, 0.85],
    stormBoostMultiplier: 1.0, stormEventTypes: [], stormBoostWindowDays: 30, isActive: true,
  },
};

export interface SeasonalContext {
  niche: Niche;
  postalCode: string | null | undefined;
  now: Date;
  config: NicheSeasonConfig | null;          // null → use DEFAULT_SEASONS[niche]
  overlays?: WeatherOverlay[];               // recent weather events for the postal code
}

export interface SeasonalEvaluation {
  multiplier: number;
  monthMultiplier: number;
  weatherMultiplier: number;
  reason: string;
}

export function seasonalMultiplier(ctx: SeasonalContext): SeasonalEvaluation {
  const config = ctx.config ?? DEFAULT_SEASONS[ctx.niche] ?? null;
  if (!config || !config.isActive) {
    return { multiplier: 1.0, monthMultiplier: 1.0, weatherMultiplier: 1.0, reason: 'no_config' };
  }
  const monthIdx = ctx.now.getUTCMonth();
  const monthMult = config.monthlyMultipliers[monthIdx] ?? 1.0;

  let weatherMult = 1.0;
  let triggered = '';
  if (ctx.overlays && ctx.overlays.length > 0 && ctx.postalCode && config.stormBoostMultiplier > 1) {
    const cutoff = new Date(ctx.now.getTime() - config.stormBoostWindowDays * 86400_000);
    const triggers = ctx.overlays.filter(o =>
      o.postalCode === ctx.postalCode
      && config.stormEventTypes.includes(o.eventType)
      && (o.lastEventAt === null || o.lastEventAt >= cutoff),
    );
    if (triggers.length > 0) {
      weatherMult = config.stormBoostMultiplier;
      triggered = triggers.map(t => t.eventType).join(',');
    }
  }

  const raw = monthMult * weatherMult;
  const clamped = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, raw));
  return {
    multiplier: round3(clamped),
    monthMultiplier: monthMult,
    weatherMultiplier: weatherMult,
    reason: triggered ? `month:${monthIdx + 1};storm:${triggered}` : `month:${monthIdx + 1}`,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Apply the seasonal multiplier to a base score, clamped to 0..100. */
export function applySeasonalMultiplier(baseScore: number, evalResult: SeasonalEvaluation): number {
  const adjusted = baseScore * evalResult.multiplier;
  return Math.max(0, Math.min(100, Math.round(adjusted)));
}
