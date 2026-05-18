/**
 * Cost guard / budget enforcement.
 *
 * Every paid provider call must pass `canUse(...)` first. The guard reads the
 * configured `BUDGET_MODE` and the month-to-date usage totals.
 */
import { tierFor } from './scoring.js';

export type BudgetMode = 'free' | 'low' | 'normal';

export interface ProviderBudgets {
  mode: BudgetMode;
  hunterCreditsThisMonth: number;
  bouncerCentsSpentThisMonth: number;
  hunterFreeMonthlyCredits: number;          // 50 in 2026
  bouncerMonthlyBudgetCents: number;         // configured via env
}

export interface BudgetContext {
  leadScore: number;
  scrapeFailed?: boolean;
  freeChainResult?: 'valid' | 'invalid' | 'unverifiable_provider' | 'catch_all' | 'unknown';
}

export interface BudgetDecision {
  ok: boolean;
  reason?: string;
}

export function canUseHunter(b: ProviderBudgets, ctx: BudgetContext): BudgetDecision {
  if (b.mode === 'free') {
    if (b.hunterCreditsThisMonth >= b.hunterFreeMonthlyCredits) {
      return { ok: false, reason: `Hunter monthly free credits exhausted (${b.hunterCreditsThisMonth}/${b.hunterFreeMonthlyCredits})` };
    }
  }
  if (ctx.leadScore < 95) return { ok: false, reason: 'Lead score below 95 — Hunter reserved for top tier' };
  if (!ctx.scrapeFailed) return { ok: false, reason: 'Site scrape must fail before calling Hunter' };
  return { ok: true };
}

export function canUseBouncer(b: ProviderBudgets, ctx: BudgetContext): BudgetDecision {
  if (ctx.leadScore < 80) return { ok: false, reason: 'Lead score below 80 — Bouncer reserved for priority leads' };
  if (ctx.freeChainResult !== 'unverifiable_provider' && ctx.freeChainResult !== 'unknown' && ctx.freeChainResult !== 'catch_all') {
    return { ok: false, reason: 'Free verification chain already returned a definitive result' };
  }
  if (b.bouncerCentsSpentThisMonth >= b.bouncerMonthlyBudgetCents) {
    return { ok: false, reason: `Bouncer monthly budget exhausted ($${b.bouncerCentsSpentThisMonth / 100}/$${b.bouncerMonthlyBudgetCents / 100})` };
  }
  return { ok: true };
}

export function canUsePlaces(): BudgetDecision {
  return { ok: false, reason: 'Google Places disabled at MVP. Set ENABLE_PLACES=true to enable.' };
}

export function canUseTwilioLookupAtIntake(): BudgetDecision {
  return { ok: false, reason: 'Twilio Lookup is deferred to point-of-sale — never at intake.' };
}

export function canUseRuntimeAI(): BudgetDecision {
  return { ok: false, reason: 'Per-lead runtime AI is forbidden at MVP.' };
}

/** Returns the tier label used by the UI cost dashboard. */
export function leadTierLabel(score: number): 'discard' | 'qualified' | 'priority' | 'top' {
  return tierFor(score);
}
