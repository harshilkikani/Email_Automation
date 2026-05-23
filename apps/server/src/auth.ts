/**
 * Single-tenant bearer-token auth.
 *
 *  - The static `AUTH_TOKEN` from env is the password.
 *  - POST `/api/auth/login` exchanges the token for a signed cookie.
 *  - Subsequent requests carry the cookie OR a `Bearer <token>` header.
 *  - Login is protected by the global rate limiter (6/min per IP) plus a small
 *    in-process failure backoff so a single hostile IP can't probe forever.
 *  - Open endpoints (no auth) are: /api/health, /api/ready, /api/auth/{login,logout},
 *    /api/webhooks/*, /api/unsubscribe/*.
 *  - Every successful login + every failed attempt is written to audit_log.
 *  - `/api/unsubscribe/health` returns 200 without revealing whether the
 *    server has any sender domain configured.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from './config.js';
import { writeAudit } from './services/audit.js';

function sign(value: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${mac}`;
}
function verify(signed: string, secret: string): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = createHmac('sha256', secret).update(value).digest('hex');
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  return value;
}

function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface AuthBackoff { failures: number; nextAllowed: number }
const failures = new Map<string, AuthBackoff>();

function clientKey(req: FastifyRequest): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) || req.ip || 'unknown';
}

export function registerAuth(app: FastifyInstance) {
  const cfg = getConfig();

  app.post('/api/auth/login', async (req, reply) => {
    const key = clientKey(req);
    const now = Date.now();
    const backoff = failures.get(key);
    if (backoff && backoff.nextAllowed > now) {
      reply.code(429).send({ ok: false, error: 'too_many_attempts', retryAfterMs: backoff.nextAllowed - now });
      return;
    }
    const body = (req.body ?? {}) as { token?: string };
    const ok = !!body.token && body.token.length > 0 && tokenEquals(body.token, cfg.authToken);
    if (!ok) {
      const f = failures.get(key) ?? { failures: 0, nextAllowed: 0 };
      f.failures++;
      f.nextAllowed = now + Math.min(60_000, 500 * 2 ** f.failures);
      failures.set(key, f);
      await writeAudit('auth_login_fail', null, { ip: key, attempt: f.failures }, req);
      reply.code(401).send({ ok: false, error: 'invalid_token' });
      return;
    }
    failures.delete(key);
    const cookieValue = sign(`session:${now}`, cfg.authCookieSecret);
    reply.setCookie(cfg.authCookieName, cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.nodeEnv === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 14,
    });
    await writeAudit('auth_login', null, { ip: key }, req);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie(cfg.authCookieName, { path: '/' });
    await writeAudit('auth_logout', null, {}, req);
    return reply.send({ ok: true });
  });

  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done) => {
    /* Allow webhooks, unsubscribe, login, health, ready unauthenticated. */
    const url = req.url;
    const open =
      url === '/api/health' ||
      url === '/api/ready' ||
      url === '/api/auth/login' ||
      url === '/api/auth/logout' ||
      url.startsWith('/api/webhooks/') ||
      url.startsWith('/api/unsubscribe');
    if (open || !url.startsWith('/api/')) return done();

    const bearer = (req.headers['authorization'] ?? '').toString();
    if (bearer.startsWith('Bearer ')) {
      const tok = bearer.slice(7);
      if (tok.length === cfg.authToken.length && tokenEquals(tok, cfg.authToken)) return done();
    }
    const cookie = (req.cookies as Record<string, string | undefined>)?.[cfg.authCookieName];
    if (cookie && verify(cookie, cfg.authCookieSecret)) return done();
    reply.code(401).send({ ok: false, error: 'unauthorized' });
  });
}

/** Test helper — reset the in-memory backoff. */
export function resetAuthBackoff(): void {
  failures.clear();
}
