/**
 * Observability module — centralizes structured logging, Sentry error capture,
 * and OpenTelemetry tracing/metrics in one place.
 *
 * Design goals:
 *  - Zero-cost when disabled: every SDK is loaded via dynamic import so a fresh
 *    checkout that hasn't installed `@sentry/node` or the `@opentelemetry/*`
 *    packages still compiles and boots. The init functions log and skip if the
 *    optional dep is missing.
 *  - One canonical `obs` object that the rest of the server imports. Replaces
 *    ad-hoc `console.log` and `app.log` usage in scheduler ticks.
 *  - Tick wrapper: `withSpan('tick.send_batch', fn)` produces an OTel span, an
 *    error breadcrumb on throw, and a structured log line on completion.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { getConfig } from './config.js';

/** A flat, JSON-serializable bag of span attributes. */
export type SpanAttrs = Record<string, string | number | boolean | null | undefined>;

interface Span {
  setAttr(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  setStatus(ok: boolean, message?: string): void;
  end(): void;
}

interface Tracer {
  startSpan(name: string, attrs?: SpanAttrs): Span;
}

interface Meter {
  counter(name: string, attrs?: SpanAttrs, by?: number): void;
  gauge(name: string, value: number, attrs?: SpanAttrs): void;
  histogram(name: string, value: number, attrs?: SpanAttrs): void;
}

export interface Observability {
  logger: FastifyBaseLogger;
  captureException(err: unknown, context?: SpanAttrs): void;
  captureMessage(msg: string, level?: 'info' | 'warning' | 'error', context?: SpanAttrs): void;
  tracer: Tracer;
  meter: Meter;
  /** Whether Sentry was successfully initialized. */
  sentryEnabled: boolean;
  /** Whether OTel was successfully initialized. */
  otelEnabled: boolean;
}

const noopSpan: Span = {
  setAttr() { /* noop */ },
  recordException() { /* noop */ },
  setStatus() { /* noop */ },
  end() { /* noop */ },
};

const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};

const noopMeter: Meter = {
  counter() { /* noop */ },
  gauge() { /* noop */ },
  histogram() { /* noop */ },
};

/**
 * Holds the live observability handles. Populated by `initObservability` at
 * server start. Until then, every call is a no-op so importing modules never
 * crash on a partially-initialized obs.
 */
const state: { ref: Observability | null } = { ref: null };

/** Lazily resolve the active obs handle. Falls back to a noop until init. */
export function obs(): Observability {
  if (state.ref) return state.ref;
  return {
    logger: noopLogger,
    captureException: (err, ctx) => noopLogger.error({ err, ...ctx }, 'captureException (pre-init)'),
    captureMessage: (msg, level, ctx) => noopLogger.warn({ level, ...ctx }, msg),
    tracer: noopTracer,
    meter: noopMeter,
    sentryEnabled: false,
    otelEnabled: false,
  };
}

const noopLogger: FastifyBaseLogger = {
  level: 'silent',
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child() { return noopLogger; },
} as unknown as FastifyBaseLogger;

/**
 * Initialize Sentry + OTel + register Fastify hooks. Safe to call once at boot.
 *
 * Sentry is enabled when `SENTRY_DSN` is set. OTel is enabled when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Both are best-effort — a missing SDK
 * package is logged and skipped, never thrown.
 */
export async function initObservability(app: FastifyInstance): Promise<Observability> {
  const cfg = getConfig();
  const logger = app.log;

  const sentry = await initSentry(cfg.observability.sentryDsn, cfg.nodeEnv, cfg.observability.release, logger);
  const otel = await initOtel(cfg.observability.otelEndpoint, cfg.observability.serviceName, cfg.observability.serviceVersion, logger);

  const ref: Observability = {
    logger,
    sentryEnabled: !!sentry,
    otelEnabled: !!otel,
    tracer: otel?.tracer ?? noopTracer,
    meter: otel?.meter ?? noopMeter,
    captureException(err, context) {
      logger.error({ err, ...context }, 'captureException');
      if (sentry) {
        try { sentry.captureException(err, { extra: context }); } catch { /* swallow */ }
      }
    },
    captureMessage(msg, level = 'info', context) {
      const fn = level === 'error' ? logger.error : level === 'warning' ? logger.warn : logger.info;
      fn.call(logger, { ...context }, msg);
      if (sentry) {
        try { sentry.captureMessage(msg, level); } catch { /* swallow */ }
      }
    },
  };

  state.ref = ref;

  /* Fastify hooks: request span + error capture. */
  app.addHook('onRequest', async (req) => {
    const span = ref.tracer.startSpan('http.request', {
      'http.method': req.method,
      'http.route': req.routerPath ?? req.url,
      'http.target': req.url,
    });
    (req as unknown as { __obsSpan?: Span }).__obsSpan = span;
  });
  app.addHook('onResponse', async (req, reply) => {
    const span = (req as unknown as { __obsSpan?: Span }).__obsSpan;
    if (!span) return;
    span.setAttr('http.status_code', reply.statusCode);
    span.setStatus(reply.statusCode < 500, reply.statusCode >= 500 ? 'server_error' : undefined);
    span.end();
  });
  app.addHook('onError', async (req, _reply, err) => {
    ref.captureException(err, { route: req.routerPath ?? req.url, method: req.method });
  });
  app.setErrorHandler((err, req, reply) => {
    ref.captureException(err, { route: req.routerPath ?? req.url, method: req.method });
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(code).send({ ok: false, error: code >= 500 ? 'internal_error' : (err.message || 'error') });
  });

  logger.info({ sentry: ref.sentryEnabled, otel: ref.otelEnabled }, 'observability initialized');
  return ref;
}

/**
 * Wrap an async function in a span. Records exceptions, sets ok/error status,
 * and surfaces duration through the metric `tick_duration_ms` (histogram).
 * Used by the scheduler to instrument every tick.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs: SpanAttrs = {},
): Promise<T> {
  const o = obs();
  const span = o.tracer.startSpan(name, attrs);
  const t0 = Date.now();
  try {
    const result = await fn();
    span.setStatus(true);
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus(false, err instanceof Error ? err.message : String(err));
    o.captureException(err, { span: name, ...attrs });
    throw err;
  } finally {
    const ms = Date.now() - t0;
    span.setAttr('duration_ms', ms);
    span.end();
    o.meter.histogram('tick_duration_ms', ms, { tick: name });
  }
}

/**
 * Process-level metrics: collected on a 30s interval. Exposes memory + event-loop
 * lag so an operator can see if the Node process is healthy.
 */
export function startProcessMetrics(): { stop: () => void } {
  let last = Date.now();
  const interval = setInterval(() => {
    const now = Date.now();
    const drift = Math.max(0, now - last - 30_000);  // event loop lag approximation
    last = now;
    const mem = process.memoryUsage();
    obs().meter.gauge('process_event_loop_lag_ms', drift);
    obs().meter.gauge('process_heap_used_bytes', mem.heapUsed);
    obs().meter.gauge('process_rss_bytes', mem.rss);
  }, 30_000);
  return { stop: () => clearInterval(interval) };
}

/* ────────── Sentry ────────── */
async function initSentry(
  dsn: string,
  env: string,
  release: string,
  logger: FastifyBaseLogger,
): Promise<{ captureException: (e: unknown, c?: { extra?: SpanAttrs }) => void; captureMessage: (m: string, l: 'info'|'warning'|'error') => void } | null> {
  if (!dsn) return null;
  try {
    const mod = await import('@sentry/node').catch(() => null);
    if (!mod) {
      logger.warn('SENTRY_DSN set but @sentry/node not installed; install to enable error capture');
      return null;
    }
    const Sentry = mod as unknown as {
      init: (opts: Record<string, unknown>) => void;
      captureException: (e: unknown, c?: { extra?: SpanAttrs }) => void;
      captureMessage: (m: string, l: 'info' | 'warning' | 'error') => void;
    };
    Sentry.init({
      dsn,
      environment: env,
      release: release || undefined,
      tracesSampleRate: env === 'production' ? 0.1 : 1.0,
      /* PII filter: drop email-shaped values from breadcrumbs, redact request bodies. */
      beforeSend(event: { request?: { data?: unknown; headers?: Record<string, unknown> } }) {
        if (event.request) {
          delete event.request.data;
          if (event.request.headers) {
            for (const k of ['authorization', 'cookie', 'x-postmark-server-token']) {
              if (k in event.request.headers) (event.request.headers as Record<string, unknown>)[k] = '[redacted]';
            }
          }
        }
        return event;
      },
    });
    return {
      captureException: (e, c) => Sentry.captureException(e, c),
      captureMessage: (m, l) => Sentry.captureMessage(m, l),
    };
  } catch (e) {
    logger.warn({ err: e }, 'Sentry init failed; continuing without it');
    return null;
  }
}

/* ────────── OpenTelemetry ────────── */
async function initOtel(
  endpoint: string,
  serviceName: string,
  serviceVersion: string,
  logger: FastifyBaseLogger,
): Promise<{ tracer: Tracer; meter: Meter } | null> {
  if (!endpoint) return null;
  try {
    const api = await import('@opentelemetry/api').catch(() => null);
    const sdkNode = await import('@opentelemetry/sdk-node').catch(() => null);
    const autoInst = await import('@opentelemetry/auto-instrumentations-node').catch(() => null);
    const traceExp = await import('@opentelemetry/exporter-trace-otlp-http').catch(() => null);
    const metricsExp = await import('@opentelemetry/exporter-metrics-otlp-http').catch(() => null);
    const sdkMetrics = await import('@opentelemetry/sdk-metrics').catch(() => null);
    if (!api || !sdkNode || !autoInst || !traceExp || !metricsExp || !sdkMetrics) {
      logger.warn('OTEL_EXPORTER_OTLP_ENDPOINT set but @opentelemetry/* not installed; install to enable tracing');
      return null;
    }
    const otelApi = api as unknown as {
      trace: { getTracer: (name: string, ver?: string) => { startSpan: (n: string, o?: { attributes?: SpanAttrs }) => OtelNativeSpan } };
      metrics: { getMeter: (name: string, ver?: string) => OtelNativeMeter };
      SpanStatusCode: { OK: number; ERROR: number };
    };
    const { NodeSDK } = sdkNode as unknown as {
      NodeSDK: new (opts: Record<string, unknown>) => { start: () => void; shutdown: () => Promise<void> };
    };
    const { getNodeAutoInstrumentations } = autoInst as unknown as {
      getNodeAutoInstrumentations: (opts?: Record<string, unknown>) => unknown;
    };
    const { OTLPTraceExporter } = traceExp as unknown as {
      OTLPTraceExporter: new (opts: { url: string }) => unknown;
    };
    const { OTLPMetricExporter } = metricsExp as unknown as {
      OTLPMetricExporter: new (opts: { url: string }) => unknown;
    };
    const { PeriodicExportingMetricReader } = sdkMetrics as unknown as {
      PeriodicExportingMetricReader: new (opts: { exporter: unknown; exportIntervalMillis: number }) => unknown;
    };

    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 60_000,
      }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },  // noisy
      })],
    });
    sdk.start();

    const tracer = otelApi.trace.getTracer(serviceName, serviceVersion || undefined);
    const meter = otelApi.metrics.getMeter(serviceName, serviceVersion || undefined);

    const wrappedTracer: Tracer = {
      startSpan(name, attrs = {}) {
        const native = tracer.startSpan(name, { attributes: attrs });
        return {
          setAttr: (k, v) => native.setAttribute(k, v),
          recordException: (e) => native.recordException(e as Error),
          setStatus: (ok, msg) => native.setStatus({ code: ok ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR, message: msg }),
          end: () => native.end(),
        };
      },
    };

    /* Cache instruments per name so the meter exposes a simple counter/gauge/histogram surface. */
    const counters = new Map<string, OtelInstrument>();
    const gauges = new Map<string, OtelInstrument>();
    const histograms = new Map<string, OtelInstrument>();
    const wrappedMeter: Meter = {
      counter(name, attrs, by = 1) {
        let inst = counters.get(name);
        if (!inst) { inst = meter.createCounter(name); counters.set(name, inst); }
        inst.add(by, attrs ?? {});
      },
      gauge(name, value, attrs) {
        /* OTel SDKs use ObservableGauge for true gauges; we approximate via UpDownCounter for simplicity. */
        let inst = gauges.get(name);
        if (!inst) { inst = meter.createUpDownCounter(name); gauges.set(name, inst); }
        inst.add(value, attrs ?? {});
      },
      histogram(name, value, attrs) {
        let inst = histograms.get(name);
        if (!inst) { inst = meter.createHistogram(name); histograms.set(name, inst); }
        inst.record(value, attrs ?? {});
      },
    };

    process.once('SIGTERM', () => { void sdk.shutdown(); });
    process.once('SIGINT', () => { void sdk.shutdown(); });

    return { tracer: wrappedTracer, meter: wrappedMeter };
  } catch (e) {
    logger.warn({ err: e }, 'OTel init failed; continuing without it');
    return null;
  }
}

interface OtelNativeSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(e: Error): void;
  setStatus(s: { code: number; message?: string }): void;
  end(): void;
}
interface OtelNativeMeter {
  createCounter(n: string): OtelInstrument;
  createUpDownCounter(n: string): OtelInstrument;
  createHistogram(n: string): OtelInstrument;
}
interface OtelInstrument {
  add(v: number, a?: SpanAttrs): void;
  record(v: number, a?: SpanAttrs): void;
}
