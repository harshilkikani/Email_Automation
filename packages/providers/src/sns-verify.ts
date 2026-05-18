/**
 * AWS SNS message signature verification.
 *
 * SNS signs every Notification + SubscriptionConfirmation with RSA-SHA1
 * (legacy) or RSA-SHA256 (current). The signing certificate URL must point at
 * an `sns.<region>.amazonaws.com` host. The canonical string to verify is
 * documented at:
 *   https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * We do *not* fetch every signing cert on every request — instead we cache by
 * URL with a 1-hour TTL. In `SAMPLE_MODE` and tests, verification is skipped
 * and the message is treated as authentic.
 */
import { createVerify, X509Certificate } from 'node:crypto';
import { request } from 'undici';

interface CachedCert { pem: string; expiresAt: number }
const certCache = new Map<string, CachedCert>();
const ONE_HOUR_MS = 60 * 60 * 1000;

const FIELDS_NOTIFICATION = ['Message','MessageId','Subject','Timestamp','TopicArn','Type'];
const FIELDS_SUBSCRIPTION = ['Message','MessageId','SubscribeURL','Timestamp','Token','TopicArn','Type'];

export interface SnsMessage {
  Type: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
  Token?: string;
  SubscribeURL?: string;
}

export interface VerifyOptions {
  /** Returns the PEM body of the cert. Injectable for tests. */
  fetchCert?: (url: string) => Promise<string>;
  /** Bypass for tests + sample mode. */
  skip?: boolean;
}

export async function verifySnsMessage(msg: SnsMessage, opts: VerifyOptions = {}): Promise<{ valid: boolean; reason?: string }> {
  if (opts.skip) return { valid: true };
  if (!msg || typeof msg !== 'object') return { valid: false, reason: 'missing_message' };
  if (!msg.SigningCertURL || !msg.Signature || !msg.SignatureVersion) {
    return { valid: false, reason: 'missing_signature_fields' };
  }
  if (!isValidSigningHost(msg.SigningCertURL)) {
    return { valid: false, reason: 'invalid_signing_cert_host' };
  }
  if (msg.SignatureVersion !== '1' && msg.SignatureVersion !== '2') {
    return { valid: false, reason: 'unknown_signature_version' };
  }
  const fields = msg.Type === 'Notification' ? FIELDS_NOTIFICATION : FIELDS_SUBSCRIPTION;
  const canonical = buildCanonical(msg as unknown as Record<string, string | undefined>, fields);
  const pem = await getCert(msg.SigningCertURL, opts.fetchCert);
  if (!pem) return { valid: false, reason: 'cert_unfetchable' };
  try {
    const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const verifier = createVerify(algorithm);
    verifier.update(canonical, 'utf8');
    verifier.end();
    const sig = Buffer.from(msg.Signature, 'base64');
    const valid = verifier.verify(pem, sig);
    return valid ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
  } catch (e: any) {
    return { valid: false, reason: 'verify_error:' + (e?.message ?? String(e)) };
  }
}

function isValidSigningHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
  } catch { return false; }
}

function buildCanonical(msg: Record<string, string | undefined>, fields: string[]): string {
  /* SNS docs: canonical = concatenation of "name\nvalue\n" for present fields
     in alphabetical order. */
  const lines: string[] = [];
  for (const k of fields) {
    const v = msg[k];
    if (v === undefined) continue;
    lines.push(k);
    lines.push(v);
  }
  return lines.join('\n') + '\n';
}

async function getCert(url: string, fetcher?: (u: string) => Promise<string>): Promise<string | null> {
  const cached = certCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;
  try {
    const pem = fetcher ? await fetcher(url) : await fetchPem(url);
    /* Sanity-check that it's a valid X509 cert. */
    new X509Certificate(pem);
    certCache.set(url, { pem, expiresAt: Date.now() + ONE_HOUR_MS });
    return pem;
  } catch {
    return null;
  }
}

async function fetchPem(url: string): Promise<string> {
  const r = await request(url, { headersTimeout: 5_000, bodyTimeout: 5_000 });
  if (r.statusCode >= 400) throw new Error(`cert fetch ${r.statusCode}`);
  return await r.body.text();
}
