/**
 * Signed unsubscribe tokens (HMAC-SHA256, base64url, no third-party deps).
 *
 * Payload:  email + scope (org id or 'GLOBAL') + issuedAt + expiresAt
 * Encoded:  <base64url(JSON payload)>.<base64url(HMAC)>
 *
 * Anyone with `UNSUB_SIGNING_SECRET` can verify a token. Tokens are bound to a
 * specific email so a leaked token can't be used to suppress someone else.
 *
 * Tokens are accepted by:
 *   - GET  /unsubscribe/:token  (landing page)
 *   - POST /unsubscribe         (RFC 8058 one-click handler — body has token)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_DAYS = 730;          // 2 years — well past the CAN-SPAM 30-day floor

export interface UnsubscribePayload {
  email: string;
  scope: string;                       // org id or 'GLOBAL'
  campaignId?: string;
  issuedAt: number;
  expiresAt: number;
}

const b64url = (s: string | Buffer) =>
  (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const fromB64url = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4), 'base64');

export function signUnsubscribeToken(
  payload: Omit<UnsubscribePayload, 'issuedAt' | 'expiresAt'>,
  secret: string,
  ttlDays = DEFAULT_TTL_DAYS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: UnsubscribePayload = {
    ...payload,
    issuedAt: now,
    expiresAt: now + ttlDays * 86400,
  };
  const body = b64url(JSON.stringify(full));
  const mac = createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const got = fromB64url(sig);
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const json = JSON.parse(fromB64url(body).toString('utf8')) as UnsubscribePayload;
    if (typeof json.email !== 'string' || typeof json.scope !== 'string') return null;
    if (typeof json.expiresAt !== 'number' || json.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return json;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/unsubscribe/${encodeURIComponent(token)}`;
}
