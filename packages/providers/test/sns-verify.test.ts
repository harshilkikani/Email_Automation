import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign, X509Certificate } from 'node:crypto';
import { verifySnsMessage } from '@keres/providers';

/* Helper: build a self-signed cert + sign an SNS canonical string with it. */
function makeCertAndSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = new (X509Certificate as any)
    ? null : null;
  return { privateKey, publicKey };
}

/* The crypto module's X509Certificate doesn't include a self-signed cert
   builder. For these tests we sign with the public key only — we inject a
   fake `fetchCert` that returns the public key as a PEM-like blob, and
   replace the runtime use with a known cert. To keep things simple and
   deterministic, we test the *rejection* paths (host check, missing fields)
   which don't need a valid cert. */

describe('SNS signature verification — rejection paths', () => {
  it('rejects missing signature fields', async () => {
    const r = await verifySnsMessage({ Type: 'Notification' } as any);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('missing_signature_fields');
  });
  it('rejects invalid cert host', async () => {
    const r = await verifySnsMessage({
      Type: 'Notification',
      MessageId: '1', TopicArn: 'arn', Timestamp: 'now', Message: 'x',
      Signature: 'AA==', SignatureVersion: '1',
      SigningCertURL: 'https://evil.example.com/cert.pem',
    } as any);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signing_cert_host');
  });
  it('rejects unknown signature version', async () => {
    const r = await verifySnsMessage({
      Type: 'Notification',
      MessageId: '1', TopicArn: 'arn', Timestamp: 'now', Message: 'x',
      Signature: 'AA==', SignatureVersion: '99',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    } as any);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('unknown_signature_version');
  });
  it('skips when opts.skip', async () => {
    const r = await verifySnsMessage({} as any, { skip: true });
    expect(r.valid).toBe(true);
  });
});
