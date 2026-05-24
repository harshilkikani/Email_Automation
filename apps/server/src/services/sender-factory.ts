/**
 * Selects the outbound provider once and caches it.
 * Priority: SAMPLE_MODE → MockOutbound; ENABLE_MAILGUN → MailgunAdapter;
 * ENABLE_SES → SesAdapter; else MockOutbound (sends nothing).
 */
import type { OutboundProvider } from '@keres/providers';
import { MailgunAdapter, MockOutbound, ResendAdapter, SesAdapter } from '@keres/providers';
import { getConfig } from '../config.js';

let provider: OutboundProvider | null = null;

export function getOutbound(): OutboundProvider {
  if (provider) return provider;
  const cfg = getConfig();
  if (cfg.sampleMode) {
    provider = new MockOutbound();
  } else if (cfg.resend.enabled) {
    provider = new ResendAdapter({ enabled: true, apiKey: cfg.resend.apiKey });
  } else if (cfg.mailgun.enabled) {
    provider = new MailgunAdapter({
      enabled: true,
      apiKey: cfg.mailgun.apiKey,
      domain: cfg.mailgun.domain,
      region: cfg.mailgun.region,
    });
  } else if (cfg.ses.enabled) {
    provider = new SesAdapter({
      enabled: true,
      region: cfg.ses.region,
      accessKeyId: cfg.ses.accessKeyId,
      secretAccessKey: cfg.ses.secretAccessKey,
      configurationSet: cfg.ses.configurationSet,
    });
  } else {
    provider = new MockOutbound();
  }
  return provider;
}

/** Used in tests to swap the provider for assertions. */
export function setOutboundForTests(p: OutboundProvider): void {
  provider = p;
}
