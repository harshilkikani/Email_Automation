/**
 * State license registry adapters.
 * - TX (TDLR), FL (DBPR), GA (Sec. of State) — production scrapers stubbed.
 * - All other states fall back to `unknown` license_status.
 *
 * In dev / SAMPLE_MODE, the sample adapter returns deterministic licensees
 * matching the OSM sample names so the active-license signal lights up.
 */
import type { Niche } from '@keres/core';

export interface LicenseLookupResult {
  status: 'active' | 'expired' | 'suspended' | 'unknown';
  licenseNumber?: string;
  expiresAt?: Date;
  source?: string;
}

export interface LicenseProvider {
  state: string;
  supports(niche: Niche): boolean;
  lookup(name: string, niche: Niche): Promise<LicenseLookupResult>;
}

class StubLicenseProvider implements LicenseProvider {
  constructor(public state: string, private supported: Niche[]) {}
  supports(niche: Niche): boolean { return this.supported.includes(niche); }
  async lookup(_name: string, _niche: Niche): Promise<LicenseLookupResult> {
    return { status: 'unknown', source: `${this.state.toLowerCase()}-stub` };
  }
}

class SampleLicenseProvider implements LicenseProvider {
  constructor(public state: string) {}
  supports(_n: Niche): boolean { return true; }
  async lookup(name: string, _niche: Niche): Promise<LicenseLookupResult> {
    /* Deterministic: alternate-character names get an "active" license. */
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (slug.length === 0) return { status: 'unknown' };
    if (slug.charCodeAt(0) % 3 === 0) return { status: 'unknown', source: 'sample' };
    if (slug.charCodeAt(0) % 5 === 0) {
      return { status: 'expired', expiresAt: new Date(Date.now() - 30 * 86400000), source: 'sample' };
    }
    return {
      status: 'active',
      licenseNumber: 'SAMPLE-' + slug.slice(0, 6).toUpperCase(),
      expiresAt: new Date(Date.now() + 365 * 86400000),
      source: 'sample',
    };
  }
}

export class LicenseRegistry {
  private byState = new Map<string, LicenseProvider>();
  constructor(public sample: boolean) {
    /* Production stubs: hand-rolled HTML scrapers go here in a follow-up commit. */
    this.byState.set('TX', sample ? new SampleLicenseProvider('TX') : new StubLicenseProvider('TX', ['Roofer', 'Septic', 'HVAC', 'Plumber', 'Electrician']));
    this.byState.set('FL', sample ? new SampleLicenseProvider('FL') : new StubLicenseProvider('FL', ['Roofer', 'Septic', 'HVAC', 'Plumber', 'Electrician']));
    this.byState.set('GA', sample ? new SampleLicenseProvider('GA') : new StubLicenseProvider('GA', ['Roofer', 'HVAC', 'Plumber', 'Electrician']));
  }
  async lookup(state: string, name: string, niche: Niche): Promise<LicenseLookupResult> {
    const adapter = this.byState.get(state.toUpperCase());
    if (!adapter || !adapter.supports(niche)) return { status: 'unknown' };
    return adapter.lookup(name, niche);
  }
}
