/**
 * Hunter.io adapter — used only when the website scrape produced no email,
 * the lead score is ≥ 95, and the monthly free credit pool (50 in 2026) is
 * not yet exhausted.
 *
 * We never call Hunter at intake. The cost guard in @keres/core/budget
 * gates each call.
 */
import { request } from 'undici';
import type { VerificationProvider, VerificationResult } from './types.js';

export interface HunterConfig {
  apiKey: string;
  enabled: boolean;
  fetcher?: (url: string) => Promise<any>;
}

export interface HunterFindResult {
  email: string | null;
  confidence: number | null;
  source: 'hunter';
}

export class HunterAdapter implements VerificationProvider {
  readonly name = 'hunter';
  constructor(private cfg: HunterConfig) {}
  isEnabled() { return this.cfg.enabled && this.cfg.apiKey.length > 0; }

  async findEmail(domain: string, firstName?: string, lastName?: string): Promise<HunterFindResult> {
    if (!this.isEnabled()) return { email: null, confidence: null, source: 'hunter' };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const params = new URLSearchParams({ domain, api_key: this.cfg.apiKey });
    if (firstName) params.set('first_name', firstName);
    if (lastName) params.set('last_name', lastName);
    const json = await fetcher(`https://api.hunter.io/v2/email-finder?${params.toString()}`);
    const data = json?.data;
    if (!data || !data.email) return { email: null, confidence: null, source: 'hunter' };
    return { email: data.email, confidence: typeof data.score === 'number' ? data.score / 100 : null, source: 'hunter' };
  }

  async verify(email: string): Promise<VerificationResult> {
    if (!this.isEnabled()) return { status: 'unknown', source: 'hunter', detail: 'hunter disabled' };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const params = new URLSearchParams({ email, api_key: this.cfg.apiKey });
    const json = await fetcher(`https://api.hunter.io/v2/email-verifier?${params.toString()}`);
    const r = json?.data?.result as string | undefined;
    const mapped: VerificationResult['status'] =
      r === 'deliverable' ? 'valid' :
      r === 'undeliverable' ? 'invalid' :
      r === 'risky' ? 'catch_all' :
      'unknown';
    return { status: mapped, source: 'hunter', detail: r };
  }

  private async realFetch(url: string): Promise<any> {
    const res = await request(url, {
      headers: { Accept: 'application/json' },
      headersTimeout: 10_000, bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400) {
      throw new Error(`Hunter returned ${res.statusCode}`);
    }
    return await res.body.json();
  }
}
