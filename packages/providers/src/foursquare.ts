/**
 * Foursquare Places discovery adapter — a second, free-tier business source.
 *
 * Uses the v3 Places Search endpoint and requests the `website` field so we can
 * scrape a contact email (no website → not usable, skipped). Gated behind an
 * API key; fails soft (returns []) so it never breaks a multi-source run.
 *
 * Foursquare's API/auth has shifted over time — base URL + auth header are
 * configurable so this can be pointed at the current endpoint without a rebuild.
 */
import type { LeadCandidate, Niche } from '@keres/core';
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult } from './types.js';

export interface FoursquareConfig {
  enabled: boolean;
  apiKey: string;
  /** New Places API base (default). */
  baseUrl?: string;
  /** X-Places-Api-Version date the new API requires. */
  apiVersion?: string;
  /** Test seam. */
  fetcher?: (url: string) => Promise<FoursquareResponse>;
}

interface FsqPlace {
  fsq_place_id?: string;
  fsq_id?: string;
  name?: string;
  website?: string;
  tel?: string;
  location?: { formatted_address?: string; locality?: string; region?: string; postcode?: string };
}
export interface FoursquareResponse { results?: FsqPlace[] }

export class FoursquareAdapter implements DiscoveryProvider {
  readonly name = 'foursquare';
  constructor(private cfg: FoursquareConfig) {}
  isEnabled() { return this.cfg.enabled && !!this.cfg.apiKey; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult & { costCents: number }> {
    if (!this.isEnabled()) return { candidates: [], source: 'foursquare', attribution: '', costCents: 0 };
    const base = this.cfg.baseUrl ?? 'https://places-api.foursquare.com/places/search';
    const params = new URLSearchParams({
      query: nicheToQuery(q.niche),
      near: `${q.city}, ${q.state}`,
      limit: String(Math.min(Math.max(q.targetCount, 1), 50)),
      fields: 'fsq_place_id,name,website,tel,location',
    });
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    let resp: FoursquareResponse;
    try {
      resp = await fetcher(`${base}?${params.toString()}`);
    } catch {
      return { candidates: [], source: 'foursquare', attribution: '', warnings: ['foursquare_error'], costCents: 0 };
    }

    const candidates: LeadCandidate[] = [];
    for (const p of resp.results ?? []) {
      const website = p.website?.trim();
      const name = p.name?.trim();
      if (!website || !name) continue;            // need a site to scrape an email
      candidates.push({
        name, website,
        phone: p.tel ?? null,
        address: p.location?.formatted_address ?? null,
        city: p.location?.locality ?? q.city,
        state: p.location?.region ?? q.state,
        postalCode: p.location?.postcode ?? null,
        niche: q.niche,
        source: 'foursquare',
        sourceExternalId: p.fsq_place_id ?? p.fsq_id ?? null,
      });
    }
    return {
      candidates: candidates.slice(0, q.targetCount),
      source: 'foursquare',
      attribution: 'Business data © Foursquare.',
      costCents: 0,                                // free tier
    };
  }

  private async realFetch(url: string): Promise<FoursquareResponse> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'X-Places-Api-Version': this.cfg.apiVersion ?? '2025-06-17',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Foursquare ${res.status}`);
    return await res.json() as FoursquareResponse;
  }
}

function nicheToQuery(niche: Niche): string {
  const m: Record<Niche, string> = {
    Septic: 'septic service', Roofer: 'roofing contractor', 'Water/Mold': 'water damage restoration',
    HVAC: 'HVAC contractor', Plumber: 'plumber', Electrician: 'electrician',
    Towing: 'towing service', 'Real Estate': 'real estate agency',
  };
  return m[niche] ?? niche;
}
