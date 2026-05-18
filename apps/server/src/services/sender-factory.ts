/**
 * Selects the outbound provider once and caches it.
 * - SAMPLE_MODE or ENABLE_SES=false: MockOutbound.
 * - Else: SesAdapter.
 */
import type { OutboundProvider } from '@keres/providers';
import { MockOutbound, SesAdapter } from '@keres/providers';
import { getConfig } from '../config.js';

let provider: OutboundProvider | null = null;

export function getOutbound(): OutboundProvider {
  if (provider) return provider;
  const cfg = getConfig();
  if (cfg.sampleMode || !cfg.ses.enabled) {
    provider = new MockOutbound();
  } else {
    provider = new SesAdapter({
      enabled: true,
      region: cfg.ses.region,
      accessKeyId: cfg.ses.accessKeyId,
      secretAccessKey: cfg.ses.secretAccessKey,
      configurationSet: cfg.ses.configurationSet,
    });
  }
  return provider;
}

/** Used in tests to swap the provider for assertions. */
export function setOutboundForTests(p: OutboundProvider): void {
  provider = p;
}
