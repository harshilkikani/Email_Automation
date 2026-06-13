/**
 * Selects the outbound provider once and caches it.
 * Priority: SAMPLE_MODE → MockOutbound; ENABLE_SMTP → SmtpAdapter (Spacemail);
 * ENABLE_RESEND → ResendAdapter; ENABLE_MAILGUN → MailgunAdapter;
 * ENABLE_SES → SesAdapter; else MockOutbound.
 */
import type { OutboundProvider } from '@keres/providers';
import { MailgunAdapter, MockOutbound, ResendAdapter, SesAdapter, SmtpAdapter } from '@keres/providers';
import { getConfig } from '../config.js';

let provider: OutboundProvider | null = null;

export function getOutbound(): OutboundProvider {
  if (provider) return provider;
  const cfg = getConfig();
  if (cfg.sampleMode) {
    provider = new MockOutbound();
  } else if (cfg.smtp.enabled) {
    provider = new SmtpAdapter({
      enabled: true,
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      user: cfg.smtp.user,
      pass: cfg.smtp.pass,
      fromEmail: cfg.smtp.fromEmail,
    });
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
