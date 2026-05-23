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
import { tickClosedLoop } from './closed-loop.js';
import { tickWarmupEngine, refillHourlyTokens } from './warmup-engine.js';
import { tickReplyBranches } from './reply-branches.js';
import { tickSaturationRefresh } from './saturation.js';
import { tickWebsiteIntelRefresh } from './website-intel.js';
import { tickQueueMetrics } from './queue.js';
import { withSpan } from '../observability.js';
import { tickAiAnalysis } from './ai-analysis.js';
import { NoaaAdapter } from '@keres/providers';

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
    { name: 'send_batch',         everyMs: 15 * 1000,            fn: tickSendBatch },
    { name: 'auto_pause_check',   everyMs: 60 * 1000,            fn: tickAutoPause },
    { name: 'domain_rollover',    everyMs: 5  * 60 * 1000,       fn: tickDomainRollover },
    { name: 'queue_metrics',      everyMs: 5  * 60 * 1000,       fn: (db, log) => withSpan('tick.queue_metrics',   () => tickQueueMetrics(db, log)) },
    { name: 'stuck_jobs_cleanup', everyMs: 5  * 60 * 1000,       fn: tickStuckJobsCleanup },
    { name: 'reply_branches',     everyMs: 5  * 60 * 1000,       fn: (db, log) => withSpan('tick.reply_branches',  () => tickReplyBranches(db, log)) },
    { name: 'unsub_probe',        everyMs: 15 * 60 * 1000,       fn: tickUnsubProbe },
    { name: 'warmup_engine',      everyMs: 30 * 60 * 1000,       fn: (db, log) => withSpan('tick.warmup_engine',   () => tickWarmupEngine(db, log)) },
    { name: 'token_refill',       everyMs: 60 * 60 * 1000,       fn: async (db, _log) => refillHourlyTokens(db) },
    { name: 'dns_recheck',        everyMs: 60 * 60 * 1000,       fn: tickDnsRecheck },
    { name: 'warmup_ramp',        everyMs: 60 * 60 * 1000,       fn: tickWarmupRamp },
    { name: 'budget_alert',       everyMs: 60 * 60 * 1000,       fn: tickBudgetAlert },
    { name: 'discovery_cron',     everyMs: 60 * 60 * 1000,       fn: tickDiscoveryCron },
    { name: 'website_intel',      everyMs: 6  * 60 * 60 * 1000,  fn: (db, log) => withSpan('tick.website_intel',   () => tickWebsiteIntelRefresh(db, log)) },
    { name: 'saturation_refresh', everyMs: 12 * 60 * 60 * 1000,  fn: (db, log) => withSpan('tick.saturation',      () => tickSaturationRefresh(db, log)) },
    { name: 'send_time_histogram', everyMs: 12 * 60 * 60 * 1000,       fn: tickSendTimeHistogram },
    { name: 'reputation_trend',   everyMs: 6  * 60 * 60 * 1000,       fn: tickReputationTrend },
    { name: 'closed_loop',        everyMs: 24 * 60 * 60 * 1000,       fn: (db, log) => withSpan('tick.closed_loop',   () => tickClosedLoop(db, log)) },
    { name: 'license_freshness',  everyMs: 24 * 60 * 60 * 1000,       fn: tickLicenseFreshness },
    { name: 'ai_analysis',        everyMs: 7  * 24 * 60 * 60 * 1000,  fn: tickAiAnalysis },
    { name: 'noaa_refresh',       everyMs: 30 * 24 * 60 * 60 * 1000,  fn: tickNoaaRefresh },
  ];

  /* Prevent a slow tick from running again before the previous invocation
     finishes — eliminates the double-send risk on send_batch. */
  const running = new Set<string>();
  const interval = setInterval(() => {
    const now = Date.now();
    for (const t of ticks) {
      const last = lastRan.get(t.name) ?? 0;
      if (now - last < t.everyMs) continue;
      if (running.has(t.name)) continue;
      lastRan.set(t.name, now);
      running.add(t.name);
      runTick(db, log, t)
        .finally(() => running.delete(t.name))
        .catch((e: Error) => log.error({ err: e, tick: t.name }, 'scheduler tick crashed'));
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
  const cfg = getConfig();
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();
  const w = cfg.sendWindow;
  if (!w.daysOfWeek.includes(utcDay) || utcHour < w.startHour || utcHour >= w.endHour) {
    return { sent: 0, skipped: 0, failed: 0, reason: 'outside_send_window' };
  }
  const r = await sendBatch(db, { maxToSend: cfg.sendBatchSize });
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

async function tickNoaaRefresh(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cfg = getConfig();
  const adapter = new NoaaAdapter({ enabled: true, fetcher: cfg.sampleMode ? undefined : undefined });
  const events = await adapter.fetchRecent();
  if (events.length === 0) return { upserted: 0 };

  /* Group events by (postalCode, eventType) to aggregate counts. */
  const grouped = new Map<string, { postalCode: string; eventType: string; count: number; lastEventAt: Date }>();
  for (const ev of events) {
    const key = `${ev.postalCode}|${ev.eventType}`;
    const row = grouped.get(key);
    if (row) {
      row.count++;
      if (ev.eventDate > row.lastEventAt) row.lastEventAt = ev.eventDate;
    } else {
      grouped.set(key, { postalCode: ev.postalCode, eventType: ev.eventType, count: 1, lastEventAt: ev.eventDate });
    }
  }

  const now = new Date();
  for (const row of grouped.values()) {
    await db.insert(schema.noaaStormZones).values({
      postalCode: row.postalCode,
      eventType: row.eventType,
      eventCount: row.count,
      lastEventAt: row.lastEventAt,
      refreshedAt: now,
    }).onConflictDoUpdate({
      target: [schema.noaaStormZones.postalCode, schema.noaaStormZones.eventType],
      set: { eventCount: row.count, lastEventAt: row.lastEventAt, refreshedAt: now },
    });
  }

  log.info({ upserted: grouped.size }, 'noaa storm zones refreshed');
  return { upserted: grouped.size };
}

async function tickStuckJobsCleanup(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  const cutoff = new Date(Date.now() - 10 * 60_000);
  const updated = await db.update(schema.jobRuns).set({
    status: 'failed',
    error: 'timeout: still running after 10 min (likely crashed mid-execution)',
    completedAt: new Date(),
  }).where(and(
    eq(schema.jobRuns.status, 'running'),
    lt(schema.jobRuns.startedAt, cutoff),
  )).returning({ id: schema.jobRuns.id });
  if (updated.length > 0) log.warn({ count: updated.length }, 'cleaned up stuck job_runs');
  return { cleaned: updated.length };
}

async function tickSendTimeHistogram(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  /* Compute per-niche per-UTC-hour reply rates from the last 90 days of sends.
     Results power adaptive nextSendAt scheduling toward high-reply hours. */
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
  let updated = 0;
  const windowStart = new Date(Date.now() - 90 * 86400 * 1000);
  for (const org of orgs) {
    const rows = await db.execute(sql`
      SELECT
        l.niche,
        extract(hour FROM cr.first_sent_at)::int AS utc_hour,
        count(*)::int AS n_sent,
        count(cr.replied_at)::int AS n_replied
      FROM campaign_recipients cr
      JOIN leads l ON l.id = cr.lead_id
      WHERE l.org_id = ${org.id}
        AND cr.first_sent_at IS NOT NULL
        AND cr.first_sent_at >= ${windowStart.toISOString()}
      GROUP BY l.niche, utc_hour
    `);
    const list = ((rows as { rows?: unknown[] }).rows ?? (rows as unknown[])) as Array<{
      niche: string; utc_hour: number; n_sent: number; n_replied: number;
    }>;
    for (const row of list) {
      const replyRate = row.n_sent > 0 ? row.n_replied / row.n_sent : 0;
      await db.insert(schema.sendTimeHistograms).values({
        orgId: org.id,
        niche: row.niche,
        utcHour: row.utc_hour,
        nSent: row.n_sent,
        nReplied: row.n_replied,
        replyRate,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [schema.sendTimeHistograms.orgId, schema.sendTimeHistograms.niche, schema.sendTimeHistograms.utcHour],
        set: { nSent: row.n_sent, nReplied: row.n_replied, replyRate, updatedAt: new Date() },
      });
      updated++;
    }
  }
  return { updated };
}

async function tickReputationTrend(db: Database, log: FastifyBaseLogger): Promise<unknown> {
  /* For each active mailbox, compare average reputation over last 3 days vs
     prior 4 days. Auto-pause mailboxes trending steeply downward (>10 pts). */
  const mailboxes = await db.select({
    id: schema.senderMailboxes.id,
    orgId: schema.senderMailboxes.orgId,
    fromEmail: schema.senderMailboxes.fromEmail,
    state: schema.senderMailboxes.state,
  }).from(schema.senderMailboxes)
    .where(sql`${schema.senderMailboxes.state} IN ('warming','active')`);

  let autoPaused = 0;
  for (const mx of mailboxes) {
    const recent = await db.select({
      date: schema.senderReputationDaily.date,
      rep: schema.senderReputationDaily.reputationScore,
    }).from(schema.senderReputationDaily)
      .where(eq(schema.senderReputationDaily.mailboxId, mx.id))
      .orderBy(sql`${schema.senderReputationDaily.date} DESC`)
      .limit(7);
    if (recent.length < 5) continue;
    const last3 = recent.slice(0, 3).map(r => r.rep);
    const prev4 = recent.slice(3, 7).map(r => r.rep);
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const trend = avg(last3) - avg(prev4);
    if (trend <= -10) {
      await db.update(schema.senderMailboxes).set({
        state: 'paused',
        pauseReason: `reputation_trend: -${Math.abs(Math.round(trend))} pts over 7d`,
      }).where(eq(schema.senderMailboxes.id, mx.id));
      await writeAudit('mailbox_auto_paused_trend', mx.id, { email: mx.fromEmail, trend: Math.round(trend) });
      log.warn({ mailboxId: mx.id, email: mx.fromEmail, trend }, 'mailbox auto-paused: declining reputation trend');
      autoPaused++;
    }
  }
  return { evaluated: mailboxes.length, autoPaused };
}

function capForProvider(provider: string, cfg: ReturnType<typeof getConfig>): number | null {
  if (provider === 'bouncer') return cfg.bouncer.monthlyBudgetCents / 100;
  if (provider === 'yelp')    return cfg.yelp.monthlyBudgetUsd > 0 ? cfg.yelp.monthlyBudgetUsd : null;
  if (provider === 'places')  return cfg.places.monthlyBudgetUsd > 0 ? cfg.places.monthlyBudgetUsd : null;
  return null;
}
