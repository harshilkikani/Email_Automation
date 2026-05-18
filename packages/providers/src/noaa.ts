/**
 * NOAA Storm Events ingestion. Monthly CSV download.
 * Free, no API key. We store storm zones by zip + event type.
 *
 * Real-mode: download CSV from
 *   https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/
 * and call `parseCsv()` to upsert rows.
 *
 * Sample-mode: returns a small synthetic storm set so the storm-bump signal
 * fires on Houston, Tampa, Atlanta zips during dev / tests.
 */
export interface StormEvent {
  postalCode: string;
  eventType: string;
  eventDate: Date;
}

export interface NoaaAdapterConfig {
  enabled: boolean;
  fetcher?: () => Promise<string>;
}

export class NoaaAdapter {
  readonly name = 'noaa';
  constructor(private cfg: NoaaAdapterConfig) {}
  isEnabled() { return this.cfg.enabled; }

  /** Returns rows for upsert into noaa_storm_zones. */
  async fetchRecent(): Promise<StormEvent[]> {
    if (!this.cfg.fetcher) return sampleStormEvents();
    const csv = await this.cfg.fetcher();
    return parseCsv(csv);
  }
}

export function parseCsv(csv: string): StormEvent[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = (lines[0] ?? '').split(',').map(h => h.replace(/"/g, '').toLowerCase());
  const idxState = headers.indexOf('state');
  const idxZ = headers.indexOf('zipcode');
  const idxType = headers.indexOf('event_type');
  const idxDate = headers.indexOf('begin_date_time');
  if (idxZ === -1 || idxType === -1) return [];
  const out: StormEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map(c => c.replace(/"/g, '').trim());
    const zip = cols[idxZ];
    const type = cols[idxType];
    if (!zip || !type) continue;
    const d = idxDate >= 0 ? new Date(cols[idxDate] ?? '') : new Date();
    out.push({ postalCode: zip, eventType: type, eventDate: isNaN(d.getTime()) ? new Date() : d });
  }
  return out;
}

function sampleStormEvents(): StormEvent[] {
  const recent = new Date(Date.now() - 7 * 86400 * 1000);
  return [
    { postalCode: '77001', eventType: 'Hail', eventDate: recent },
    { postalCode: '77002', eventType: 'Thunderstorm Wind', eventDate: recent },
    { postalCode: '30303', eventType: 'Hail', eventDate: recent },
    { postalCode: '33602', eventType: 'Tropical Storm', eventDate: recent },
  ];
}
