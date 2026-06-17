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
  'Pest Control': `nwr["shop"="pest_control"]({{area}});\nnwr["craft"="pest_control"]({{area}});\nnwr["name"~"pest control|exterminat|pest",i]({{area}});`,
  'Garage Door': `nwr["name"~"garage door",i]({{area}});`,
  Locksmith: `nwr["shop"="locksmith"]({{area}});\nnwr["craft"="locksmith"]({{area}});\nnwr["name"~"locksmith|lock and key|lock & key",i]({{area}});`,
  'Appliance Repair': `nwr["shop"="appliance"]({{area}});\nnwr["name"~"appliance repair|appliance",i]({{area}});`,
  'Pool Service': `nwr["shop"="swimming_pool"]({{area}});\nnwr["name"~"pool service|pool cleaning|pool repair|pools",i]({{area}});`,
  Landscaping: `nwr["craft"="gardener"]({{area}});\nnwr["shop"="garden_centre"]({{area}});\nnwr["name"~"landscap|lawn care|lawn|gardening|tree and lawn",i]({{area}});`,
  Painter: `nwr["craft"="painter"]({{area}});\nnwr["name"~"painting|painter",i]({{area}});`,
  'Carpet Cleaning': `nwr["shop"="carpet"]({{area}});\nnwr["name"~"carpet clean|carpet|upholstery|rug clean",i]({{area}});`,
  Handyman: `nwr["craft"="handyman"]({{area}});\nnwr["name"~"handyman|home repair|honey do",i]({{area}});`,
  'Tree Service': `nwr["name"~"tree service|tree removal|tree care|arborist|tree trimming",i]({{area}});`,
  Fencing: `nwr["craft"="fence"]({{area}});\nnwr["name"~"fence|fencing",i]({{area}});`,
  Concrete: `nwr["name"~"concrete|paving|masonry|driveway",i]({{area}});`,
  Moving: `nwr["shop"="moving"]({{area}});\nnwr["name"~"moving|movers|relocation",i]({{area}});`,
  'Junk Removal': `nwr["name"~"junk removal|junk|hauling|debris removal",i]({{area}});`,
  'Window Cleaning': `nwr["name"~"window cleaning|window washing|windows",i]({{area}});`,
  'Pressure Washing': `nwr["name"~"pressure wash|power wash|soft wash|exterior cleaning",i]({{area}});`,
  Solar: `nwr["name"~"solar",i]({{area}});`,
  Flooring: `nwr["shop"="flooring"]({{area}});\nnwr["name"~"flooring|floor|hardwood|tile",i]({{area}});`,
};

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Geographic bounding box: [south, west, north, east] in decimal degrees. */
export type BBox = [number, number, number, number];

export interface OsmAdapterConfig {
  endpoint: string;
  userAgent: string;
  enabled: boolean;
  fetcher?: (q: string) => Promise<OsmElement[]>;   // for tests / sample mode
  /** City→bbox geocoder seam. Default uses Nominatim. */
  geocoder?: (city: string, state: string) => Promise<BBox | null>;
}

export class OsmAdapter implements DiscoveryProvider {
  readonly name = 'osm';
  constructor(private cfg: OsmAdapterConfig) {}

  isEnabled() { return this.cfg.enabled; }

  async search(q: DiscoveryQuery): Promise<DiscoveryResult> {
    const fetcher = this.cfg.fetcher ?? this.realFetch.bind(this);
    /* Geocode the city to a bounding box first. The old area["name"=City]
       boundary lookup silently returns 0 for tons of US cities (the admin
       boundary name/level doesn't match), which is why OSM "found nothing".
       A bbox around the city actually surfaces the businesses. Fall back to
       the area approach only if geocoding fails. */
    let bbox: BBox | null = null;
    /* Use the real geocoder only when not under an injected fetcher (tests/sample
       mode), unless a geocoder seam is explicitly provided. */
    const geocode = this.cfg.geocoder ?? (this.cfg.fetcher ? null : this.realGeocode.bind(this));
    if (geocode) {
      try { bbox = await geocode(q.city, q.state); }
      catch { /* fall back to area query */ }
    }
    /* Expand the city bbox outward to the surrounding metro (~16km) so suburbs
       and edge-of-town businesses are included — the city proper alone misses a
       large share of real service businesses. */
    if (bbox) bbox = padBbox(bbox, 0.15);

    const body = buildOverpass(q, bbox ?? undefined);
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

  /** Nominatim geocode: "City, State, USA" → bbox. Free, ≤1 req/s + UA. */
  private async realGeocode(city: string, state: string): Promise<BBox | null> {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q: `${city}, ${state}, USA`, format: 'jsonv2', limit: '1', countrycodes: 'us',
    })}`;
    const res = await request(url, {
      method: 'GET',
      headers: { 'User-Agent': this.cfg.userAgent, Accept: 'application/json' },
      headersTimeout: 10_000,
      bodyTimeout: 12_000,
    });
    if (res.statusCode >= 400) return null;
    const arr = (await res.body.json()) as Array<{ boundingbox?: [string, string, string, string] }>;
    const bb = arr?.[0]?.boundingbox;
    if (!bb || bb.length !== 4) return null;
    /* Nominatim order = [south, north, west, east]; our BBox = [south, west, north, east]. */
    const [south, north, west, east] = bb.map(Number) as [number, number, number, number];
    if ([south, north, west, east].some(n => Number.isNaN(n))) return null;
    return [south, west, north, east];
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

/** Expand a [south, west, north, east] box by `deg` on every side. */
function padBbox(b: BBox, deg: number): BBox {
  return [
    Math.max(-90, b[0] - deg), Math.max(-180, b[1] - deg),
    Math.min(90, b[2] + deg), Math.min(180, b[3] + deg),
  ];
}

export function buildOverpass(q: DiscoveryQuery, bbox?: BBox): string {
  const filters = NICHE_TO_OSM[q.niche] ?? `nwr["name"~"${q.niche}",i]({{area}});`;
  if (bbox) {
    /* Query directly within the geocoded bounding box — reliable, unlike the
       area-name boundary lookup. Overpass bbox order = (south,west,north,east). */
    const bb = `(${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]})`;
    return `[out:json][timeout:25];
(
${filters.replace(/\{\{area\}\}/g, bb)}
);
out body center tags;`;
  }
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
  const phone = tags['contact:phone'] ?? tags['phone'] ?? null;
  const website = tags['website'] ?? tags['contact:website'] ?? null;
  const email = tags['email'] ?? tags['contact:email'] ?? null;
  /* Keep anything we can actually act on: a website (scrape for email), a
     direct email, or a phone. Dropping website-only records (no phone tag)
     was throwing away the best leads — those are exactly the ones we can
     scrape an owner email from. */
  if (!website && !email && !phone) return null;
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
  'Pest Control': ['Shield Pest Control', 'Guardian Exterminators', 'EcoPest Solutions', 'Anchor Pest Services', 'Hometown Pest'],
  'Garage Door': ['Precision Garage Doors', 'Overhead Door Co', 'Reliable Garage Door', 'Apex Door Service', 'Crown Garage Doors'],
  Locksmith: ['Anchor Locksmith', 'Rapid Lock & Key', 'Pioneer Locksmith', 'Secure Lock Services', '24Hour Locksmith'],
  'Appliance Repair': ['Reliable Appliance Repair', 'Hometown Appliance', 'Apex Appliance Service', 'Direct Appliance Repair', 'Crown Appliance'],
  'Pool Service': ['Crystal Clear Pools', 'Bluewave Pool Service', 'Anchor Pool Care', 'Sunset Pool Services', 'Pristine Pools'],
  Landscaping: ['Greenscape Landscaping', 'Evergreen Lawn Care', 'Pioneer Landscapes', 'Summit Lawn & Landscape', 'Hometown Landscaping'],
  Painter: ['Pioneer Painting', 'Crown Painters', 'Summit Painting Co', 'Liberty Painting', 'Heritage Painters'],
  'Carpet Cleaning': ['Fresh Start Carpet Cleaning', 'Anchor Carpet Care', 'Pristine Carpet Cleaning', 'Direct Carpet Services', 'Hometown Carpet'],
  Handyman: ['Reliable Handyman Services', 'Anchor Home Repair', 'Hometown Handyman', 'Direct Home Services', 'Honey-Do Handyman'],
  'Tree Service': ['Summit Tree Service', 'Pioneer Tree Care', 'Ironclad Tree Removal', 'Crown Tree Service', 'Hometown Arborists'],
  Fencing: ['Ironclad Fence Co', 'Summit Fencing', 'Pioneer Fence', 'Crown Fence & Gate', 'Hometown Fencing'],
  Concrete: ['Summit Concrete', 'Ironclad Concrete & Paving', 'Pioneer Concrete Works', 'Crown Masonry', 'Hometown Concrete'],
  Moving: ['Anchor Moving Co', 'Summit Movers', 'Pioneer Moving & Storage', 'Direct Movers', 'Hometown Moving'],
  'Junk Removal': ['Rapid Junk Removal', 'Anchor Hauling', 'Summit Junk Removal', 'Direct Haul Away', 'Hometown Junk'],
  'Window Cleaning': ['Crystal Clear Windows', 'Summit Window Cleaning', 'Pioneer Window Care', 'Bright View Windows', 'Hometown Window Cleaning'],
  'Pressure Washing': ['Reliable Pressure Washing', 'Summit Power Wash', 'Anchor Exterior Cleaning', 'Crown Soft Wash', 'Hometown Pressure Washing'],
  Solar: ['Summit Solar', 'Pioneer Solar Power', 'Crown Solar Energy', 'Liberty Solar', 'Hometown Solar'],
  Flooring: ['Summit Flooring', 'Pioneer Floors', 'Crown Hardwood & Tile', 'Heritage Flooring', 'Hometown Floors'],
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
