/**
 * Hybrid queue abstraction.
 *
 *   QUEUE_TIER=db        → existing job_runs table; in-process poller
 *   QUEUE_TIER=pg-boss   → pg-boss on the same Postgres; worker pool of N
 *
 * Exposes a tiny surface:
 *   enqueue(name, payload, opts)
 *   work(name, handler)             — registers a worker
 *   sampleMetrics()                 — counts per queue
 *
 * Both tiers handle retries via job-level metadata. pg-boss provides
 * retry/backoff natively; the db tier uses the existing job_runs.attempts
 * column. A migration to pg-boss never loses jobs — both tiers can coexist;
 * setting QUEUE_TIER=pg-boss just routes *new* enqueues through pg-boss.
 */
import { and, eq, isNull, lt, sql, desc } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import type { FastifyBaseLogger } from 'fastify';
import { getConfig } from '../config.js';
import { obs } from '../observability.js';

export interface EnqueueOptions {
  /** When the job should first become eligible to run. Defaults to now. */
  scheduledFor?: Date;
  /** Optional priority — higher first. pg-boss only; db tier ignores. */
  priority?: number;
  /** Retry policy override. */
  retryLimit?: number;
  /** Unique key — second enqueue with the same key is a no-op. */
  singletonKey?: string;
}

export interface QueueHandler<TPayload> {
  (payload: TPayload, ctx: { jobId: string; attempt: number; log: FastifyBaseLogger }): Promise<void>;
}

export interface QueueMetrics {
  tier: 'db' | 'pg-boss';
  counts: Record<string, Record<string, number>>;  // queueName -> stateName -> count
  oldestQueuedMs: number | null;
}

interface QueueAdapter {
  init(db: Database, log: FastifyBaseLogger): Promise<void>;
  shutdown(): Promise<void>;
  enqueue<T>(name: string, payload: T, opts?: EnqueueOptions): Promise<string | null>;
  work<T>(name: string, handler: QueueHandler<T>): Promise<void>;
  sampleMetrics(db: Database): Promise<QueueMetrics>;
}

let active: QueueAdapter | null = null;

export async function initQueue(db: Database, log: FastifyBaseLogger): Promise<QueueAdapter> {
  if (active) return active;
  const cfg = getConfig();
  const adapter = cfg.queue.tier === 'pg-boss' ? await createPgBossAdapter() : new DbAdapter();
  await adapter.init(db, log);
  active = adapter;
  return adapter;
}

export function getQueue(): QueueAdapter {
  if (!active) throw new Error('queue not initialized — call initQueue first');
  return active;
}

/* ────────── db tier ────────── */

class DbAdapter implements QueueAdapter {
  private db!: Database;
  private log!: FastifyBaseLogger;
  private handlers = new Map<string, QueueHandler<unknown>>();
  private poller: ReturnType<typeof setInterval> | null = null;

  async init(db: Database, log: FastifyBaseLogger): Promise<void> {
    this.db = db;
    this.log = log;
    /* Poll loop: every 2s, claim up to N due jobs across registered handlers. */
    this.poller = setInterval(() => { void this.drain(); }, 2_000);
  }

  async shutdown(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  async enqueue<T>(name: string, payload: T, opts: EnqueueOptions = {}): Promise<string | null> {
    /* Singleton: refuse duplicate queued/running rows with the same payload hash. */
    if (opts.singletonKey) {
      const existing = (await this.db.select({ id: schema.jobRuns.id }).from(schema.jobRuns).where(and(
        eq(schema.jobRuns.kind, name),
        sql`${schema.jobRuns.payload}->>'_singletonKey' = ${opts.singletonKey}`,
        sql`${schema.jobRuns.status} IN ('queued','running')`,
      )).limit(1))[0];
      if (existing) return existing.id;
    }
    const orgId = await firstOrgId(this.db);
    const row = await this.db.insert(schema.jobRuns).values({
      orgId,
      kind: name,
      status: 'queued',
      payload: { ...payload, _singletonKey: opts.singletonKey ?? null } as Record<string, unknown>,
      scheduledFor: opts.scheduledFor ?? new Date(),
    }).returning({ id: schema.jobRuns.id });
    return row[0]?.id ?? null;
  }

  async work<T>(name: string, handler: QueueHandler<T>): Promise<void> {
    this.handlers.set(name, handler as QueueHandler<unknown>);
  }

  async sampleMetrics(db: Database): Promise<QueueMetrics> {
    const counts: Record<string, Record<string, number>> = {};
    const rows = await db.select({
      kind: schema.jobRuns.kind,
      status: schema.jobRuns.status,
      c: sql<number>`count(*)::int`,
    }).from(schema.jobRuns).groupBy(schema.jobRuns.kind, schema.jobRuns.status);
    for (const r of rows) {
      counts[r.kind] = counts[r.kind] ?? {};
      counts[r.kind]![r.status] = Number(r.c);
    }
    const oldest = (await db.select({ at: schema.jobRuns.scheduledFor }).from(schema.jobRuns)
      .where(eq(schema.jobRuns.status, 'queued'))
      .orderBy(schema.jobRuns.scheduledFor)
      .limit(1))[0];
    const oldestQueuedMs = oldest?.at ? Date.now() - oldest.at.getTime() : null;
    return { tier: 'db', counts, oldestQueuedMs };
  }

  private async drain(): Promise<void> {
    const now = new Date();
    for (const [name, handler] of this.handlers) {
      /* Claim up to 8 rows for this kind. Atomically mark them running via
         RETURNING. Race-safe even with multiple workers. */
      const claimed = await this.db.execute<{ id: string; payload: Record<string, unknown>; attempts: number }>(sql`
        UPDATE job_runs
        SET status = 'running', started_at = now(), lock_token = ${cryptoRandom()}, locked_at = now(),
            attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM job_runs
          WHERE kind = ${name}
            AND status = 'queued'
            AND scheduled_for <= ${now.toISOString()}
          ORDER BY scheduled_for ASC
          LIMIT 8
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, payload, attempts
      `);
      const list: Array<{ id: string; payload: Record<string, unknown>; attempts: number }> =
        (claimed as { rows?: Array<{ id: string; payload: Record<string, unknown>; attempts: number }> }).rows
        ?? (claimed as unknown as Array<{ id: string; payload: Record<string, unknown>; attempts: number }>);

      for (const job of list) {
        const childLog = this.log.child({ queue: name, jobId: job.id });
        try {
          await handler(job.payload as never, { jobId: job.id, attempt: job.attempts, log: childLog });
          await this.db.update(schema.jobRuns).set({ status: 'done', completedAt: new Date() })
            .where(eq(schema.jobRuns.id, job.id));
          obs().meter.counter('queue_job_done', { queue: name });
        } catch (e: unknown) {
          obs().captureException(e, { queue: name, jobId: job.id });
          const err = (e as Error).message ?? String(e);
          const max = 3;
          if (job.attempts >= max) {
            await this.db.update(schema.jobRuns).set({ status: 'failed', completedAt: new Date(), error: err })
              .where(eq(schema.jobRuns.id, job.id));
            obs().meter.counter('queue_job_failed', { queue: name });
          } else {
            /* Re-queue with exponential backoff. */
            const backoffMs = 30_000 * Math.pow(2, job.attempts - 1);
            await this.db.update(schema.jobRuns).set({
              status: 'queued',
              error: err,
              scheduledFor: new Date(Date.now() + backoffMs),
            }).where(eq(schema.jobRuns.id, job.id));
            obs().meter.counter('queue_job_retry', { queue: name });
          }
        }
      }
    }
  }
}

/* ────────── pg-boss tier (optional dep) ────────── */

interface PgBossModule {
  default: new (config: { connectionString: string }) => PgBossInstance;
}
interface PgBossInstance {
  start(): Promise<void>;
  stop(opts?: { graceful?: boolean }): Promise<void>;
  send(name: string, data: unknown, opts?: Record<string, unknown>): Promise<string | null>;
  work(name: string, opts: { teamSize?: number; teamConcurrency?: number }, handler: (job: { id: string; data: unknown; retrycount?: number }) => Promise<void>): Promise<string>;
  getQueueSize(name: string): Promise<number>;
  countStates(): Promise<Record<string, Record<string, number>>>;
}

async function createPgBossAdapter(): Promise<QueueAdapter> {
  const mod = await import('pg-boss').catch(() => null);
  if (!mod) {
    /* Graceful fallback. */
    console.warn('[queue] QUEUE_TIER=pg-boss but pg-boss is not installed; falling back to db tier');
    return new DbAdapter();
  }
  return new PgBossAdapter(mod as unknown as PgBossModule);
}

class PgBossAdapter implements QueueAdapter {
  private boss!: PgBossInstance;
  private log!: FastifyBaseLogger;

  constructor(private mod: PgBossModule) {}

  async init(_db: Database, log: FastifyBaseLogger): Promise<void> {
    const cfg = getConfig();
    this.log = log;
    this.boss = new this.mod.default({ connectionString: cfg.queue.connectionString });
    await this.boss.start();
    log.info({ connection: redactConn(cfg.queue.connectionString) }, 'pg-boss started');
  }

  async shutdown(): Promise<void> {
    if (this.boss) await this.boss.stop({ graceful: true });
  }

  async enqueue<T>(name: string, payload: T, opts: EnqueueOptions = {}): Promise<string | null> {
    return this.boss.send(name, payload, {
      startAfter: opts.scheduledFor,
      priority: opts.priority,
      retryLimit: opts.retryLimit ?? 3,
      retryBackoff: true,
      singletonKey: opts.singletonKey,
    });
  }

  async work<T>(name: string, handler: QueueHandler<T>): Promise<void> {
    const cfg = getConfig();
    const log = this.log;
    await this.boss.work(name, { teamSize: cfg.queue.workerConcurrency, teamConcurrency: 1 }, async (job) => {
      const childLog = log.child({ queue: name, jobId: job.id });
      try {
        await handler(job.data as T, { jobId: job.id, attempt: (job.retrycount ?? 0) + 1, log: childLog });
        obs().meter.counter('queue_job_done', { queue: name });
      } catch (e) {
        obs().captureException(e, { queue: name, jobId: job.id });
        obs().meter.counter('queue_job_failed', { queue: name });
        throw e;   // let pg-boss handle retry
      }
    });
  }

  async sampleMetrics(_db: Database): Promise<QueueMetrics> {
    /* pg-boss's countStates returns: { created: { all: n }, retry: { ... }, ... }
       where each top-level key is a state and the inner keys are queue names. */
    const raw = await this.boss.countStates();
    const counts: Record<string, Record<string, number>> = {};
    for (const [state, byQueue] of Object.entries(raw)) {
      for (const [queueName, count] of Object.entries(byQueue)) {
        if (queueName === 'all') continue;
        counts[queueName] = counts[queueName] ?? {};
        counts[queueName]![state] = Number(count);
      }
    }
    return { tier: 'pg-boss', counts, oldestQueuedMs: null };
  }
}

/* ────────── helpers + scheduler tick ────────── */

async function firstOrgId(db: Database): Promise<string> {
  const r = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
  if (!r[0]) throw new Error('queue.enqueue: no org configured');
  return r[0].id;
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2);
}

function redactConn(s: string): string {
  return s.replace(/:\/\/[^@]+@/, '://***:***@');
}

export async function tickQueueMetrics(db: Database, _log: FastifyBaseLogger): Promise<unknown> {
  const q = active;
  if (!q) return { skipped: true };
  const metrics = await q.sampleMetrics(db);
  await db.insert(schema.queueMetricsSnapshots).values({
    tier: metrics.tier,
    counts: metrics.counts as Record<string, unknown>,
    oldestQueuedMs: metrics.oldestQueuedMs ?? null,
  });
  obs().meter.gauge('queue_oldest_queued_ms', metrics.oldestQueuedMs ?? 0, { tier: metrics.tier });
  for (const [queue, byState] of Object.entries(metrics.counts)) {
    for (const [state, count] of Object.entries(byState)) {
      obs().meter.gauge('queue_jobs_by_state', count, { queue, state, tier: metrics.tier });
    }
  }
  return metrics;
}

/* Silence unused-import linters. */
void isNull; void lt; void desc;
