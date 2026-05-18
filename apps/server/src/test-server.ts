/**
 * Build a Fastify app for integration tests without listening on a port.
 *
 * Shared with `db:test` to ensure the same plugin / route registration as
 * production. We do NOT start the in-process scheduler — tests drive sends
 * synchronously.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { getConfig } from './config.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  const cfg = getConfig();
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: cfg.authCookieSecret });
  await app.register(formbody);
  /* Rate limit kept enabled but with high caps so tests never trigger 429. */
  await app.register(rateLimit, { global: false, max: 10_000, timeWindow: '1 minute', skipOnError: true });
  registerAuth(app);
  registerRoutes(app);
  await app.ready();
  return app;
}
