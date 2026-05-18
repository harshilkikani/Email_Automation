/**
 * OpenStreetMap Overpass adapter.
 *
 * Attribution requirement (ODbL): show "© OpenStreetMap contributors" wherever
 * this data is displayed. The frontend renders that in its footer.
 *
 * Respect ≤ 1 req/sec courtesy + identifiable User-Agent.
 */
import { request } from 'undici';
import type { LeadCandidate, Niche } from '@keres/core';
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult } from './types.js';

const NICHE_TO_OSM: Record<Niche, string> = {
  Roofer: `nwr["craft"="roofer"]({{area}});\nnwr["shop"="roofing"]({{area}});\nnwr["building"="construction"]["name"~"roof",i]({{area}});`,
  Septic: `nwr["craft"="septic_tank_cleaner"]({{area}});\nnwr["shop"~"septic",i]({{area}});\nnwr["amenity"~"septic",i]({{area}});\nnwr["name"~"septic",i]({{area}});`,
  'Water/Mold': `nwr["shop"~"restoration",i]({{area}});\nnwr["name"~"restoration|water damage|mold",i]({{area}});`,
  HVAC: `nwr["craft"="hvac"]({{area}});\nnwr["name"~"hvac|heating|cooling|air conditioning",i]({{area}});`,
  Plumber: `nwr["craft"="plumber"]({{area}});\nnwr["name"~"plumbing|plumber",i]({{area}});`,
  Electrician: `nwr["craft"="electrician"]({{area}});\nnwr["name"~"electric",i]({{area}});`,
  Towing: `nwr["amenity"="tow_yard"]({{area}});\nnwr["name"~"tow|towing|roadside",i]({{area}});`,
  'Real Estate': `nwr["office"="estate_agent"]({{area}});\nnwr["name"~"real estate|realty|realtor",i]({{area}});`,
};

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OsmAdapterConfig {
  endpoint: string;
  userAgent: string;
  enabled: boolean;
  fetcher?: (q: string) => Promise<OsmElement[]>;   // for tests / sample mode
}

export class OsmAdapter implements DiscoveryProvider {
  readonly name = 'osm';
  constructor(private cfg: OsmAdapterConfig) {}

  isEnabled() { return this.cfg.enabled; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult> {
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    const body = buildOverpass(q);
    const elements = await fetcher(body);
    const candidates = elements
      .map(e => elementToCandidate(e, q))
      .filter((c): c is LeadCandidate => c !== null)
      .slice(0, q.targetCount);
    return {
      candidates,
      source: 'osm',
      attribution: '© OpenStreetMap contributors',
    };
  }

  private async realFetch(body: string): Promise<OsmElement[]> {
    const res = await request(this.cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.cfg.userAgent,
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(body)}`,
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
    });
    if (res.statusCode >= 400) {
      throw new Error(`Overpass returned ${res.statusCode}`);
    }
    const json: any = await res.body.json();
    return (json?.elements ?? []) as OsmElement[];
  }
}

export function buildOverpass(q: DiscoveryQuery): string {
  const filters = NICHE_TO_OSM[q.niche] ?? `nwr["name"~"${q.niche}",i]({{area}});`;
  return `[out:json][timeout:25];
area["name"~"^${q.city}$",i]["admin_level"~"8|7|6"]->.searchArea;
(
${filters.replace(/\{\{area\}\}/g, 'area.searchArea')}
);
out body center tags;`;
}

function elementToCandidate(e: OsmElement, q: DiscoveryQuery): LeadCandidate | null {
  const tags = e.tags ?? {};
  const name = tags['name'];
  if (!name) return null;
  const phone = tags['contact:phone'] ?? tags['phone'];
  if (!phone) return null;
  const website = tags['website'] ?? tags['contact:website'] ?? null;
  const email = tags['email'] ?? tags['contact:email'] ?? null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const cityTag = tags['addr:city'] ?? q.city;
  const stateTag = tags['addr:state'] ?? q.state;
  const postal = tags['addr:postcode'] ?? null;
  const address = street ? `${street}, ${cityTag}, ${stateTag}${postal ? ' ' + postal : ''}` : null;
  return {
    name,
    email,
    phone,
    website,
    address,
    city: cityTag,
    state: stateTag.toUpperCase().slice(0, 2),
    postalCode: postal,
    niche: q.niche,
    source: 'osm',
    sourceExternalId: `${e.type}/${e.id}`,
  };
}

/** Sample-mode adapter — deterministic synthetic results for dev / tests. */
export class OsmSampleAdapter implements DiscoveryProvider {
  readonly name = 'osm:sample';
  constructor(private enabled = true) {}
  isEnabled() { return this.enabled; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult> {
    const candidates = sampleCandidates(q);
    return { candidates, source: 'osm:sample', attribution: 'Sample data (no live OSM request).' };
  }
}

const SAMPLE_NAMES: Record<Niche, string[]> = {
  Roofer: ['Summit Roofing Co', 'Apex Roof Systems', 'Ironclad Roofing & Exteriors', 'Pioneer Roofing', 'Crown Roof Contractors'],
  Septic: ['Clearflow Septic Services', 'Anchor Wastewater', 'Statewide Septic & Drain', 'EcoTank Pumping', 'Hometown Septic Solutions'],
  'Water/Mold': ['RestorePro Restoration', 'DryForce Water Damage', 'Guardian Mold Removal', 'Rescue Restoration Group', '24Hour Recovery'],
  HVAC: ['Premier HVAC', 'Crown Heating & Cooling', 'Apex Air Conditioning', 'Liberty HVAC Solutions', 'Skyline Heating'],
  Plumber: ['Reliable Plumbing', 'Anchor Plumbing Services', 'Hometown Plumbers', 'Direct Drain Solutions', 'Statewide Plumbing'],
  Electrician: ['Pioneer Electric', 'Crown Electrical Services', 'Summit Electric', 'Liberty Electrical', 'Heritage Electric'],
  Towing: ['Rapid Tow', 'Action Towing', 'Reliable Roadside', 'Direct Tow Services', 'Hometown Towing'],
  'Real Estate': ['Bluestone Realty Group', 'Keystone Properties', 'Landmark Real Estate', 'Coastal Realty', 'Metro Homes'],
};
const SAMPLE_STREETS = ['Main St', 'Oak Ave', 'Commerce Dr', 'Industrial Blvd', 'Market St', 'Park Ave'];

function sampleCandidates(q: DiscoveryQuery): LeadCandidate[] {
  const names = SAMPLE_NAMES[q.niche];
  const out: LeadCandidate[] = [];
  for (let i = 0; i < q.targetCount; i++) {
    const baseName = names[i % names.length]!;
    const suffix = i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : '';
    const name = baseName + suffix;
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const phone = `(${200 + ((i * 7) % 799)}) ${200 + ((i * 13) % 799)}-${1000 + ((i * 19) % 8999)}`;
    const houseNum = 100 + (i * 137) % 8900;
    const street = SAMPLE_STREETS[i % SAMPLE_STREETS.length]!;
    out.push({
      name,
      email: i % 3 === 0 ? null : `info@${slug}.com`,
      phone,
      website: i % 4 === 0 ? null : `${slug}.com`,
      address: `${houseNum} ${street}, ${q.city}, ${q.state}`,
      city: q.city,
      state: q.state.toUpperCase(),
      postalCode: null,
      niche: q.niche,
      source: 'osm:sample',
      sourceExternalId: `sample/${slug}`,
    });
  }
  return out;
}
