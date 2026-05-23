/**
 * SNS positive-path signature verification.
 *
 * Generates a fresh RSA keypair at test time, mints a self-signed cert with
 * node-forge (test devDep), signs a canonical SNS payload with the documented
 * algorithm + field order, then injects the cert via the `fetchCert` hook.
 *
 * No production secrets are used. Keys live only in memory.
 */
import { describe, it, expect } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import { verifySnsMessage } from '@keres/providers';

const SIGNING_CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';

interface KeyMaterial { privatePem: string; certPem: string }

function makeKeysAndCert(): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const spki = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const fkey = forge.pki.publicKeyFromPem(spki);
  const fpriv = forge.pki.privateKeyFromPem(privatePem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = fkey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 30 * 86_400_000);
  const attrs = [{ name: 'commonName', value: 'sns.us-east-1.amazonaws.com' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(fpriv, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return { privatePem, certPem };
}

function canonical(msg: Record<string, string>): string {
  const fields = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const lines: string[] = [];
  for (const k of fields) {
    if (msg[k] === undefined) continue;
    lines.push(k);
    lines.push(msg[k]);
  }
  return lines.join('\n') + '\n';
}

function signCanonical(payload: string, privatePem: string): string {
  const s = createSign('RSA-SHA256');
  s.update(payload, 'utf8');
  s.end();
  return s.sign(privatePem, 'base64');
}

const keys = makeKeysAndCert();

describe('SNS positive-path verification', () => {
  it('verifies a properly signed Notification', async () => {
    const msg: Record<string, string> = {
      Type: 'Notification',
      MessageId: 'mid-1',
      TopicArn: 'arn:aws:sns:us-east-1:123:keres',
      Subject: 'Bounce',
      Message: JSON.stringify({ notificationType: 'Bounce', mail: { messageId: 'm1' } }),
      Timestamp: '2026-05-18T03:00:00.000Z',
    };
    const sig = signCanonical(canonical(msg), keys.privatePem);
    const r = await verifySnsMessage({
      ...msg, Signature: sig, SignatureVersion: '2', SigningCertURL: SIGNING_CERT_URL,
    } as any, { fetchCert: async () => keys.certPem });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered Notification', async () => {
    const msg: Record<string, string> = {
      Type: 'Notification',
      MessageId: 'mid-2',
      TopicArn: 'arn:aws:sns:us-east-1:123:keres',
      Subject: 'Bounce',
      Message: 'original-payload',
      Timestamp: '2026-05-18T03:00:00.000Z',
    };
    const sig = signCanonical(canonical(msg), keys.privatePem);
    /* Tamper with Message AFTER signing. */
    const r = await verifySnsMessage({
      ...msg, Message: 'tampered-payload',
      Signature: sig, SignatureVersion: '2', SigningCertURL: SIGNING_CERT_URL,
    } as any, { fetchCert: async () => keys.certPem });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  it('verifies a SubscriptionConfirmation when properly signed', async () => {
    const msg: Record<string, string> = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'mid-3',
      TopicArn: 'arn:aws:sns:us-east-1:123:keres',
      Message: 'You have chosen to subscribe',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&...',
      Token: 'tok-abc',
      Timestamp: '2026-05-18T03:00:00.000Z',
    };
    const sig = signCanonical(canonical(msg), keys.privatePem);
    const r = await verifySnsMessage({
      ...msg, Signature: sig, SignatureVersion: '2', SigningCertURL: SIGNING_CERT_URL,
    } as any, { fetchCert: async () => keys.certPem });
    expect(r.valid).toBe(true);
  });

  it('always rejects a malicious cert host even with valid signature shape', async () => {
    const r = await verifySnsMessage({
      Type: 'Notification', MessageId: 'x', TopicArn: 'a', Message: 'm', Timestamp: 't',
      Signature: 'AA==', SignatureVersion: '2',
      SigningCertURL: 'https://evil.example.com/cert.pem',
    } as any, { fetchCert: async () => 'should-never-be-fetched' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signing_cert_host');
  });
});
