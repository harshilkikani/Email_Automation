/**
 * Keres AI server entrypoint.
 *
 * Boot order:
 *   1. Validate environment. Fail fast in production on any error.
 *   2. Build Fastify with structured logger, CORS allowlist, secure cookies.
 *   3. Add security headers (CSP, HSTS, no-sniff, no-referrer).
 *   4. Register rate limit plugin.
 *   5. Register auth gate.
 *   6. Register all routes.
 *   7. Start the in-process send scheduler (only when not in sample mode and
 *      SES is enabled).
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { getConfig, validateConfig } from './config.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { getDb } from '@keres/db';

async function main() {
  const cfg = getConfig();
  const issues = validateConfig(cfg);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length > 0) {
    console.error('[startup] config validation failed:');
    for (const e of errors) console.error(`  [${e.code}] ${e.message}`);
    process.exit(2);
  }
  for (const w of issues.filter(i => i.severity === 'warn')) {
    console.warn(`[startup] WARN [${w.code}] ${w.message}`);
  }

  const app = Fastify({
    logger: cfg.nodeEnv === 'development'
      ? { level: cfg.logLevel, transport: { target: 'pino-pretty' } }
      : {
          level: cfg.logLevel,
          /* Redact obvious secret-shaped fields from request logs. */
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie',
                    'req.headers["x-postmark-server-token"]',
                    'req.body.token', 'req.body.password', 'req.body.apiKey'],
            censor: '[redacted]',
          },
        },
    bodyLimit: 10 * 1024 * 1024,
    /* Don't expose the framework. */
    disableRequestLogging: cfg.nodeEnv === 'production',
  });

  /* CORS allowlist — explicit CORS_ORIGIN (comma-separated) wins; falls back
     to PUBLIC_BASE_URL + the local dev port in production; wide-open in dev. */
  const corsOrigins = cfg.nodeEnv === 'production'
    ? (cfg.corsOrigin.length > 0
        ? cfg.corsOrigin
        : [cfg.publicBaseUrl, `http://localhost:${cfg.webPort}`])
    : true;
  await app.register(cors, { origin: corsOrigins as any, credentials: true });

  await app.register(cookie, { secret: cfg.authCookieSecret, parseOptions: { sameSite: 'lax', httpOnly: true, secure: cfg.nodeEnv === 'production' } });
  await app.register(formbody);

  /* Rate limiter. Defaults are conservative for an internal one-operator
     tool; per-route overrides tighten /auth/login, /webhooks, /unsubscribe. */
  await app.register(rateLimit, {
    global: false,                  // we apply per-route overrides
    max: 240, timeWindow: '1 minute',
    skipOnError: true,
    cache: 10000,
  });

  /* Security headers — light-weight CSP/HSTS without an external dependency. */
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    if (cfg.nodeEnv === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    /* CSP for HTML responses (unsubscribe landing page).
       API responses get a safe default that still blocks framing. */
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'");
    return payload;
  });

  registerAuth(app);
  registerRoutes(app);

  /* Optional: serve the React SPA from the same process. Useful for single-machine
     Fly deployments where you don't want a separate Cloudflare-Pages frontend. */
  if (cfg.serveWeb) {
    const fastifyStatic = (await import('@fastify/static')).default;
    const path = await import('node:path');
    const fs = await import('node:fs');
    const root = cfg.webDistPath || path.resolve(process.cwd(), 'apps/web/dist');
    if (!fs.existsSync(root)) {
      app.log.warn({ root }, 'SERVE_WEB=true but web dist not found; run `pnpm --filter @keres/web build` first');
    } else {
      await app.register(fastifyStatic, { root, prefix: '/' });
      /* SPA fallback: any non-/api/* path returns index.html so client-side routes work. */
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) {
          reply.code(404).send({ ok: false, error: 'not_found' });
        } else {
          reply.type('text/html').sendFile('index.html');
        }
      });
      app.log.info({ root }, 'serving web SPA from API process');
    }
  }

  /* Per-route rate limit decorators applied by setting a custom config. */
  app.addHook('onRoute', route => {
    /* Tight limit on the auth login: 6/min. */
    if (route.url === '/api/auth/login' && route.method === 'POST') {
      route.config = { ...(route.config ?? {}), rateLimit: { max: 6, timeWindow: '1 minute' } };
    }
    /* Webhooks: high-volume but per-IP from the provider; 600/min. */
    if (route.url?.startsWith('/api/webhooks/')) {
      route.config = { ...(route.config ?? {}), rateLimit: { max: 600, timeWindow: '1 minute' } };
    }
    /* Unsubscribe: 60/min to deter scanning. */
    if (route.url?.startsWith('/api/unsubscribe')) {
      route.config = { ...(route.config ?? {}), rateLimit: { max: 60, timeWindow: '1 minute' } };
    }
    /* Launch routes: 12/min ceiling — protects against accidental loops. */
    if (route.url?.endsWith('/launch') && route.method === 'POST') {
      route.config = { ...(route.config ?? {}), rateLimit: { max: 12, timeWindow: '1 minute' } };
    }
  });

  /* In-process scheduler — drives discovery / sending / DNS / warmup ramp /
     budget alerts. Disabled in SAMPLE_MODE so dev runs are click-driven.
     Cloudflare Cron pings /api/health at 7am M–F to wake the auto-stopped
     Fly machine; the scheduler catches up on due ticks on wake. */
  const { startScheduler } = await import('./services/scheduler.js');
  const scheduler = startScheduler(getDb(), app.log);
  app.addHook('onClose', async () => scheduler.stop());

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info(`Keres server listening on ${cfg.port} (sampleMode=${cfg.sampleMode}, ses=${cfg.ses.enabled})`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
