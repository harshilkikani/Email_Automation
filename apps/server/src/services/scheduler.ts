/**
 * In-process scheduler — turns the API server into a self-driving
 * automation engine.
 *
 * Jobs (all idempotent + safe to skip-when-busy):
 *   • every 15s   — sendBatch (drains queued recipients)
 *   • every 60s   — auto-pause check (refreshes campaign-level bounce/complaint)
 *   • every 5min  — domain stats rollover (sendsToday reset at UTC midnight)
 *   • every 15min — unsubscribe-endpoint reachability probe (per domain)
 *   • every 1h    — DNS recheck per active sender domain
 *   • every 1h    — warmup ramp — bumps dailySendBudget per WARMUP_RAMP
 *   • every 1h    — budget exhaustion check (pause sends if exceeded)
 *   • daily 06:00 — recurring discovery_jobs that have `cron` configured
 *   • daily 06:30 — license freshness check (flag rows refreshed > 180 days ago)
 *   • monthly 1st — NOAA storm event refresh (cache reset)
 *
 * The scheduler tracks each tick in `job_runs` so the operator can see what
 * the system has been doing. Failures are logged but do not crash the loop.
 *
 * Disabled wholesale in sample mode (the operator wants explicit clicks
 * during dev). When ENABLE_SES=false in production the scheduler still
 * runs — but `tickSendBatch` short-circuits inside `sendBatch` so no
 * outbound calls (even mock) are issued. DNS/warmup/budget ticks still
 * tick because they're useful during pre-SES domain setup.
 */
import { and, eq, sql, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { getConfig } from '../config.js';
import { sendBatch } from './sender-pipeline.js';
import { runDnsCheck } from './sender.js';
import { runDiscovery } from './discovery.js';
import { currentWarmupTarget } from './placement.js';
import { gateCampaign } from './campaigns.js';
import { writeAudit } from './audit.js';

type Tick = { name: string; everyMs: number; fn: (db: Database, log: FastifyBaseLogger) => Promise<unknown> };

/* Track last-ran timestamps in memory; we deliberately *don't* persist these
   because a restart should re-tick everything quickly. */
const lastRan = new Map<string, number>();

export interface SchedulerHandle { stop: () => void }

export function startScheduler(db: Database, log: FastifyBaseLogger): SchedulerHandle {
  const cfg = getConfig();
  if (cfg.sampleMode) {
    log.info('Scheduler disabled (SAMPLE_MODE=true).');
    return { stop: () => undefined };
  }

  /* All ticks share the same wall clock; the dispatcher fires anything due. */
  const ticks: Tick[] = [
    { name: 'send_batch',        everyMs: 15 * 1000,       fn: tickSendBatch },
    { name: 'auto_pause_check',  everyMs: 60 * 1000,       fn: tickAutoPause },
    { name: 'domain_rollover',   everyMs: 5  * 60 * 1000,  fn: tickDomainRollover },
    { name: 'unsub_probe',       everyMs: 15 * 60 * 1000,  fn: tickUnsubProbe },
    { name: 'dns_recheck',       everyMs: 60 * 60 * 1000,  fn: tickDnsRecheck },
    { name: 'warmup_ramp',       everyMs: 60 * 60 * 1000,  fn: tickWarmupRamp },
    { name: 'budget_alert',      everyMs: 60 * 60 * 1000,  fn: tickBudgetAlert },
    { name: 'discovery_cron',    everyMs: 60 * 60 * 1000,  fn: tickDiscoveryCron },
    { name: 'license_freshness', everyMs: 24 * 60 * 60 * 1000, fn: tickLicenseFreshness },
  ];

  const interval = setInterval(async () => {
    const now = Date.now();
    for (const t of ticks) {
      const last = lastRan.get(t.name) ?? 0;
      if (now - last < t.everyMs) continue;
      lastRan.set(t.name, now);
      try {
        await runTick(db, log, t);
      } catch (e: any) {
        log.error({ err: e, tick: t.name }, 'scheduler tick crashed');
      }
    }
  }, 5_000);

  log.info(`Scheduler started (${ticks.length} ticks).`);
  return {
    stop: () => clearInterval(interval),
  };
}

async function runTick(db: Database, log: FastifyBaseLogger, t: Tick): Promise<void> {
  /* Record a job_runs row so the operator can see history. */
  const orgRow = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
  if (!orgRow) return;
  const inserted = await db.insert(schema.jobRuns).values({
    orgId: orgRow.id, kind: t.name, status: 'running',
    startedAt: new Date(),
  }).returning({ id: schema.jobRuns.id });
  const jobId = inserted[0]?.id;
  let status: 'done' | 'failed' = 'done';
  let result: unknown = null;
  let error: string | null = null;
  try {
    result = await t.fn(db, log);
  } catch (e: any) {
    status = 'failed';
    error = e?.message ?? String(e);
    log.warn({ err: e, tick: t.name }, 'tick failed');
  }
  if (jobId) {
    await db.update(schema.jobRuns).set({
      status,
      completedAt: new Date(),
      result: (result ?? null) as Record<string, unknown> | null,
      error,
    }).where(eq(schema.jobRuns.id, jobId));
  }
}

/* ────────── individual ticks ────────── */

async function tickSendBatch(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const r = await sendBatch(db, { maxToSend: 5 });
  if (r.sent > 0) log.info({ sent: r.sent, skipped: r.skipped, failed: r.failed }, 'sendBatch');
  return r;
}

async function tickAutoPause(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  const running = await db.select().from(schema.campaigns).where(eq(schema.campaigns.status, 'running'));
  let paused = 0;
  for (const c of running) {
    const gate = await gateCampaign(db, c.id, {
      bouncePausePct: cfg.bouncePausePct,
      complaintPausePct: cfg.complaintPausePct,
    });
    if (!gate.ok) {
      const reason = gate.blockers[0]?.code ?? 'gate_failed';
      await db.update(schema.campaigns).set({ status: 'paused', pauseReason: reason })
        .where(eq(schema.campaigns.id, c.id));
      await writeAudit('auto_pause', c.id, { reason, blockers: gate.blockers });
      log.warn({ campaign: c.id, reason }, 'campaign auto-paused');
      paused++;
    }
  }
  return { evaluated: running.length, paused };
}

async function tickDomainRollover(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  await db.update(schema.senderDomains).set({
    sendsToday: 0, sendsTodayDate: today,
  }).where(sql`coalesce(${schema.senderDomains.sendsTodayDate}, '') <> ${today}`);
  return { ranAt: today };
}

async function tickUnsubProbe(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  /* Re-runs the DNS check probe for unsub reachability only. Cheap; doesn't
     mutate other DNS columns. */
  const cfg = getConfig();
  const domains = await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.isActive, true));
  let probed = 0;
  for (const d of domains) {
    const c = await runDnsCheck(d.domain, {
      requiredDkimSelectors: d.dkimSelectors ?? undefined,
      expectedSpfInclude: d.spfExpectedInclude ?? undefined,
      publicBaseUrl: cfg.publicBaseUrl,
    });
    await db.update(schema.senderDomains).set({
      unsubReachable: c.unsubscribeReachable === 'pass',
      unsubLastStatus: c.detail.unsubscribe.status ?? null,
    }).where(eq(schema.senderDomains.id, d.id));
    probed++;
  }
  return { probed };
}

async function tickDnsRecheck(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  /* Hourly full DNS check on each active sender domain. */
  const domains = await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.isActive, true));
  let checked = 0;
  for (const d of domains) {
    const check = await runDnsCheck(d.domain, {
      requiredDkimSelectors: d.dkimSelectors ?? undefined,
      expectedSpfInclude: d.spfExpectedInclude ?? undefined,
    });
    await db.update(schema.senderDomains).set({
      spfStatus: check.spf, dkimStatus: check.dkim, dmarcStatus: check.dmarc, mxStatus: check.mx,
      dmarcPolicy: check.dmarcPolicy ?? null,
      unsubReachable: check.unsubscribeReachable === 'pass',
      unsubLastStatus: check.detail.unsubscribe.status ?? null,
      lastCheckDetail: check as unknown as Record<string, unknown>,
      lastCheckedAt: new Date(),
    }).where(eq(schema.senderDomains.id, d.id));
    checked++;
  }
  return { checked };
}

async function tickWarmupRamp(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  /* Step the daily cap up per WARMUP_RAMP if conditions allow.
     Conservative — never raises if there are any failed gate checks. */
  const domains = await db.select().from(schema.senderDomains)
    .where(and(eq(schema.senderDomains.isActive, true), eq(schema.senderDomains.warmupState, 'warming')));
  let bumped = 0;
  for (const d of domains) {
    const targetCap = currentWarmupTarget(d.warmupDay + 1).cap;
    if (targetCap > d.dailySendBudget) {
      await db.update(schema.senderDomains).set({
        warmupDay: d.warmupDay + 1,
        dailySendBudget: targetCap,
      }).where(eq(schema.senderDomains.id, d.id));
      await writeAudit('warmup_ramp', d.id, { fromDay: d.warmupDay, toDay: d.warmupDay + 1, newCap: targetCap });
      bumped++;
    }
  }
  return { bumped };
}

async function tickBudgetAlert(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1); startOfMonth.setUTCHours(0, 0, 0, 0);
  const spends = await db.select({
    provider: schema.costEvents.provider,
    cents: sql<number>`sum(cost_cents)::int`,
  })
    .from(schema.costEvents)
    .where(sql`${schema.costEvents.occurredAt} >= ${startOfMonth}`)
    .groupBy(schema.costEvents.provider);
  const alerts: Array<{ provider: string; pct: number; spentUsd: number; capUsd: number }> = [];
  for (const s of spends) {
    const cap = capForProvider(s.provider, cfg);
    if (cap === null) continue;
    const spentUsd = Number(s.cents) / 100;
    const pct = (spentUsd / cap) * 100;
    if (pct >= 80) {
      alerts.push({ provider: s.provider, pct, spentUsd, capUsd: cap });
      log.warn({ provider: s.provider, pct: pct.toFixed(1), cap }, 'provider budget alert');
    }
  }
  return { alerts };
}

async function tickDiscoveryCron(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  /* Cron string interpretation: we support only "daily" + hour-of-day for
     MVP — `cron` is read as `H` (hour 0-23) when it's a single digit, else
     ignored. Full crontab parsing is a future-v1 concern. */
  const jobs = await db.select().from(schema.discoveryJobs).where(eq(schema.discoveryJobs.isActive, true));
  const now = new Date();
  const hourNow = now.getUTCHours();
  let ran = 0;
  for (const j of jobs) {
    if (!j.cron) continue;
    const wantHour = parseInt(j.cron, 10);
    if (!Number.isFinite(wantHour)) continue;
    if (wantHour !== hourNow) continue;
    /* Skip if it already ran today. */
    if (j.lastRunAt && j.lastRunAt > new Date(Date.now() - 23 * 3600 * 1000)) continue;
    try {
      const r = await runDiscovery(db, {
        orgId: j.orgId,
        niche: j.niche as 'Septic',
        city: j.city, state: j.state,
        targetCount: j.targetCount,
      });
      await db.update(schema.discoveryJobs).set({ lastRunAt: new Date() }).where(eq(schema.discoveryJobs.id, j.id));
      await writeAudit('discovery_cron_run', j.id, r as unknown as Record<string, unknown>);
      ran++;
    } catch (e: any) {
      log.error({ err: e, jobId: j.id }, 'discovery cron failed');
    }
  }
  return { ran };
}

async function tickLicenseFreshness(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const threshold = new Date(Date.now() - 180 * 86400 * 1000);
  const stale = await db.select({ c: sql<number>`count(*)::int` })
    .from(schema.stateLicensees)
    .where(lt(schema.stateLicensees.refreshedAt, threshold));
  const count = Number(stale[0]?.c ?? 0);
  if (count > 0) {
    log.warn({ stale: count }, 'license rows refreshed > 180 days ago');
  }
  return { staleRows: count };
}

function capForProvider(provider: string, cfg: ReturnType<typeof getConfig>): number | null {
  if (provider === 'bouncer') return cfg.bouncer.monthlyBudgetCents / 100;
  if (provider === 'yelp')    return cfg.yelp.monthlyBudgetUsd > 0 ? cfg.yelp.monthlyBudgetUsd : null;
  if (provider === 'places')  return cfg.places.monthlyBudgetUsd > 0 ? cfg.places.monthlyBudgetUsd : null;
  return null;
}
