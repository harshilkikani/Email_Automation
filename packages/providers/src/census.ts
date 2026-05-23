/**
 * Census Business Patterns loader (annual CSV).
 * Used for competitor-density signal at the (postal_code, niche) grain.
 *
 * Endpoint: https://api.census.gov/data/2022/cbp (free API key required for production)
 *
 * Sample-mode returns synthetic density numbers indexed by city.
 */
export interface DensityRow {
  postalCode: string;
  niche: string;
  competitorCount: number;
}

export interface CensusAdapterConfig {
  enabled: boolean;
  apiKey?: string;
  fetcher?: (niche: string) => Promise<DensityRow[]>;
}

export class CensusAdapter {
  readonly name = 'census';
  constructor(private cfg: CensusAdapterConfig) {}
  isEnabled() { return this.cfg.enabled; }

  async fetchDensities(niche: string): Promise<DensityRow[]> {
    if (this.cfg.fetcher) return this.cfg.fetcher(niche);
    return sampleDensities(niche);
  }
}

function sampleDensities(niche: string): DensityRow[] {
  /* A handful of metro zip stand-ins. Numbers tuned so storm-prone metros
     fire the competitor_density_high signal. */
  return [
    { postalCode: '77001', niche, competitorCount: 62 },   // Houston
    { postalCode: '30303', niche, competitorCount: 54 },   // Atlanta
    { postalCode: '33602', niche, competitorCount: 48 },   // Tampa
    { postalCode: '85001', niche, competitorCount: 70 },   // Phoenix
    { postalCode: '37201', niche, competitorCount: 35 },   // Nashville
  ];
}
