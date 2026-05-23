/**
 * Per-organization token-bucket rate limiter.
 *
 * Layer 5 of the production-layers branch: this is what the commit message
 * promised ("per-org request rate limiting (in-memory token bucket)"). The
 * branch's only rate-limiting was the existing `@fastify/rate-limit` plugin
 * with global + per-route static caps — that protects against runaway
 * single-IP traffic but does nothing about a single authenticated org
 * burst-spamming the API.
 *
 * Design:
 *   - One in-memory `TokenBucket` per (resolved) org id.
 *   - Refill rate and burst capacity are env-configurable.
 *   - Hook runs *after* the auth check (so it only ever sees authenticated
 *     callers — see `registerAuth()` in `auth.ts` for the open-route list).
 *   - On bucket-empty: 429 JSON with `retryAfterMs`.
 *   - On bucket-lookup failure (e.g. DB hiccup resolving the org): **fail-open**.
 *     We never want this layer to take the API down. The global static limit
 *     in @fastify/rate-limit is still in effect as a backstop.
 *   - Idle buckets are evicted every 5 min — bounded memory.
 *
 * The bucket is shared across requests within a single Node process. On a
 * single-machine Fly deploy that means the limit is enforced exactly once
 * per process. Scaling to multiple machines (not in scope for v1) would
 * need a shared store (Redis) — wire that in by replacing the in-memory
 * Map with the same API.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb, schema } from '@keres/db';
import { getConfig } from '../config.js';

interface BucketState {
  /** Current tokens, fractional during refill. */
  tokens: number;
  /** Last time we adjusted `tokens`. Monotonic ms. */
  lastRefillAt: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private state: BucketState;

  constructor(opts: { capacity: number; refillRatePerSec: number; now?: number }) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillRatePerSec / 1000;
    this.state = { tokens: opts.capacity, lastRefillAt: opts.now ?? Date.now() };
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.state.lastRefillAt);
    const add = elapsed * this.refillPerMs;
    if (add > 0) {
      this.state.tokens = Math.min(this.capacity, this.state.tokens + add);
      this.state.lastRefillAt = now;
    }
  }

  /**
   * Try to consume `n` tokens. Returns `{ ok: true }` if granted, otherwise
   * `{ ok: false, retryAfterMs }` so the caller can set a `Retry-After` header.
   */
  tryTake(n = 1, now: number = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    this.refill(now);
    if (this.state.tokens >= n) {
      this.state.tokens -= n;
      return { ok: true };
    }
    const deficit = n - this.state.tokens;
    const waitMs = Math.ceil(deficit / this.refillPerMs);
    return { ok: false, retryAfterMs: waitMs };
  }

  /** Test-only inspector. */
  snapshot(): Readonly<BucketState> {
    return { ...this.state };
  }
}

/**
 * Per-org bucket registry with idle eviction.
 *
 * Keys are the resolved org id (string). Buckets are constructed lazily on
 * first request and evicted after `IDLE_MS` of no activity.
 */
const IDLE_MS = 60 * 60 * 1000;      // 1h idle → evict
const EVICT_INTERVAL_MS = 5 * 60 * 1000;  // sweep every 5 min

class BucketRegistry {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { capacity: number; refillRatePerSec: number }) {}

  get(orgId: string, now: number = Date.now()): TokenBucket {
    let entry = this.buckets.get(orgId);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.opts), lastSeen: now };
      this.buckets.set(orgId, entry);
    } else {
      entry.lastSeen = now;
    }
    return entry.bucket;
  }

  evictIdle(now: number = Date.now()): number {
    let removed = 0;
    for (const [k, v] of this.buckets) {
      if (now - v.lastSeen > IDLE_MS) {
        this.buckets.delete(k);
        removed++;
      }
    }
    return removed;
  }

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.evictIdle(), EVICT_INTERVAL_MS);
    /* Don't keep the event loop alive just for the sweeper. */
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Test helper. */
  clear(): void { this.buckets.clear(); }
  size(): number { return this.buckets.size; }
}

let registry: BucketRegistry | null = null;
let cachedOrgId: string | null = null;
let cachedOrgIdAt = 0;
const ORG_ID_CACHE_MS = 60_000;

/**
 * Resolve the active org id for a request. In the v1 single-tenant setup
 * this is the only `organizations` row. Cached briefly to avoid a DB hit
 * on every request — if the org row is deleted the cache will lag for up
 * to `ORG_ID_CACHE_MS` before the resolver re-queries.
 *
 * Exposed for test injection (see `setCachedOrgIdForTests`).
 */
async function resolveOrgId(): Promise<string | null> {
  const now = Date.now();
  if (cachedOrgId && now - cachedOrgIdAt < ORG_ID_CACHE_MS) return cachedOrgId;
  try {
    const db = getDb();
    const row = (await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1))[0];
    if (row) {
      cachedOrgId = row.id;
      cachedOrgIdAt = now;
      return cachedOrgId;
    }
  } catch {
    /* fall-through to fail-open */
  }
  return null;
}

/**
 * Fastify plugin: registers the `onRequest` hook that enforces the
 * per-org bucket. Must be registered AFTER `registerAuth` so the open
 * routes (health/ready/login/webhooks/unsubscribe) are skipped — those
 * either don't carry an org or shouldn't be throttled per-org (webhooks
 * are throttled per-IP by @fastify/rate-limit).
 */
export function registerPerOrgRateLimit(app: FastifyInstance): void {
  const cfg = getConfig();
  if (!cfg.perOrgRateLimit.enabled) {
    app.log.info('Per-org rate limit disabled (PER_ORG_RATE_LIMIT_ENABLED=false).');
    return;
  }
  registry = new BucketRegistry({
    capacity: cfg.perOrgRateLimit.burst,
    refillRatePerSec: cfg.perOrgRateLimit.rps,
  });
  registry.startSweeper();

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    /* Same open-route list as auth.ts — these are checked before auth and
       should not be subject to per-org limits. */
    const open =
      url === '/api/health' ||
      url === '/api/ready' ||
      url === '/api/auth/login' ||
      url === '/api/auth/logout' ||
      url.startsWith('/api/webhooks/') ||
      url.startsWith('/api/unsubscribe') ||
      !url.startsWith('/api/');
    if (open) return;

    let orgId: string | null;
    try {
      orgId = await resolveOrgId();
    } catch {
      /* Fail-open. The global rate limit is still active. */
      return;
    }
    if (!orgId) return;  // org not yet seeded — fail-open

    const bucket = registry!.get(orgId);
    const r = bucket.tryTake(1);
    if (r.ok) return;
    reply.header('Retry-After', Math.ceil(r.retryAfterMs / 1000).toString());
    reply.code(429).type('application/json');
    return reply.send({
      ok: false,
      error: 'rate_limited',
      reason: 'per_org_rate_limit',
      retryAfterMs: r.retryAfterMs,
    });
  });
}

/* ───── test helpers ───── */
/** Wipe + reset the registry. Used by unit tests; not exported via the package boundary. */
export function _resetForTests(): void {
  if (registry) {
    registry.stopSweeper();
    registry.clear();
  }
  registry = null;
  cachedOrgId = null;
  cachedOrgIdAt = 0;
}
export function _setCachedOrgIdForTests(id: string | null): void {
  cachedOrgId = id;
  cachedOrgIdAt = id ? Date.now() : 0;
}
export function _getRegistryForTests(): BucketRegistry | null {
  return registry;
}
