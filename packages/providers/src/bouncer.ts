/**
 * Bouncer.com PAYG adapter.
 *
 * Pricing 2026: $8 for 1000 credits, no expiration, free for duplicates and
 * "unknown". Used as the last line of defense for ambiguous emails where the
 * lead score is ≥ 80 AND the free chain returned unverifiable.
 */
import { request } from 'undici';
import type { VerificationProvider, VerificationResult } from './types.js';

export interface BouncerConfig {
  apiKey: string;
  enabled: boolean;
  fetcher?: (url: string) => Promise<any>;
}

export class BouncerAdapter implements VerificationProvider {
  readonly name = 'bouncer';
  constructor(private cfg: BouncerConfig) {}
  isEnabled() { return this.cfg.enabled && this.cfg.apiKey.length > 0; }

  async verify(email: string): Promise<VerificationResult> {
    if (!this.isEnabled()) return { status: 'unknown', source: 'bouncer', detail: 'disabled' };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const url = `https://api.usebouncer.com/v1.1/email/verify?email=${encodeURIComponent(email)}`;
    const json = await fetcher(url);
    const status = (json?.status as string) ?? 'unknown';
    const reason = (json?.reason as string) ?? null;
    const cost = (json?.account?.cost as number | undefined) ?? null;
    const mapped: VerificationResult['status'] =
      status === 'deliverable' ? 'valid' :
      status === 'undeliverable' ? 'invalid' :
      status === 'risky' ? 'catch_all' :
      'unknown';
    return {
      status: mapped, source: 'bouncer',
      detail: reason ?? status,
      /* Bouncer's PAYG SKU is $0.008/check; round up to 1 cent for ledger math. */
      costCents: typeof cost === 'number' ? Math.ceil(cost * 100) : 1,
    };
  }

  private async realFetch(url: string): Promise<any> {
    const res = await request(url, {
      headers: {
        'x-api-key': this.cfg.apiKey,
        Accept: 'application/json',
      },
      headersTimeout: 15_000, bodyTimeout: 30_000,
    });
    if (res.statusCode >= 400) throw new Error(`Bouncer returned ${res.statusCode}`);
    return await res.body.json();
  }
}
