/**
 * Yelp Fusion adapter — **scoring-only**, never persistent.
 *
 * Yelp TOS: business response fields cannot be cached > 24 hours.
 * We expose `enrichForScoring()` that returns review_count + rating + claimed
 * status that the scorer uses NOW and we never persist them.
 *
 * The only identifier we may store long-term is `business_id`.
 */
import { request } from 'undici';

export interface YelpScoringInputs {
  businessId: string | null;
  reviewCount: number | null;
  rating: number | null;
  isClaimed: boolean | null;
}

export interface YelpAdapterConfig {
  apiKey: string;
  enabled: boolean;
  fetcher?: (url: string) => Promise<any>;
}

export class YelpAdapter {
  readonly name = 'yelp';
  constructor(private cfg: YelpAdapterConfig) {}

  isEnabled() { return this.cfg.enabled && this.cfg.apiKey.length > 0; }

  /**
   * Returns scoring inputs. The caller MUST NOT persist these fields anywhere
   * other than the scoring pipeline. Only the business_id may be stored.
   */
  async enrichForScoring(name: string, address: string): Promise<YelpScoringInputs> {
    if (!this.isEnabled()) return { businessId: null, reviewCount: null, rating: null, isClaimed: null };
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const q = `?term=${encodeURIComponent(name)}&location=${encodeURIComponent(address)}&limit=1`;
    const json = await fetcher(`https://api.yelp.com/v3/businesses/search${q}`);
    const hit = json?.businesses?.[0];
    if (!hit) return { businessId: null, reviewCount: null, rating: null, isClaimed: null };
    return {
      businessId: hit.id ?? null,
      reviewCount: typeof hit.review_count === 'number' ? hit.review_count : null,
      rating: typeof hit.rating === 'number' ? hit.rating : null,
      isClaimed: typeof hit.is_claimed === 'boolean' ? hit.is_claimed : null,
    };
  }

  private async realFetch(url: string): Promise<any> {
    const res = await request(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        Accept: 'application/json',
      },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400) {
      throw new Error(`Yelp Fusion returned ${res.statusCode}`);
    }
    return await res.body.json();
  }
}

/**
 * Compile-time guard: this file should be the ONLY place that names Yelp data
 * fields like rating / review_count. The lint test asserts no Yelp-named DB
 * columns exist in `packages/db/src/schema.ts`.
 */
