/**
 * AWS SES adapter using SES v2 SendEmail with `Raw` content.
 *
 * Why Raw: we need to include our own `List-Unsubscribe`, `List-Unsubscribe-Post`,
 * `Message-ID` and other headers, which SendEmail's structured form doesn't expose.
 *
 * Bounce / complaint / delivery notifications arrive via SES → SNS HTTPS topic →
 * our /webhooks/ses handler. Subscription confirmation is handled there.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { OutboundProvider, SendInput, SendResult } from './types.js';

export interface SesConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  configurationSet?: string;
  enabled: boolean;
}

export class SesAdapter implements OutboundProvider {
  readonly name = 'ses';
  private client: SESv2Client | null = null;
  constructor(private cfg: SesConfig) {}
  isEnabled() { return this.cfg.enabled; }

  private get c(): SESv2Client {
    if (!this.client) {
      this.client = new SESv2Client({
        region: this.cfg.region,
        credentials: this.cfg.accessKeyId && this.cfg.secretAccessKey
          ? { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey }
          : undefined,
      });
    }
    return this.client;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!this.isEnabled()) throw new Error('SES disabled');
    const cmd = new SendEmailCommand({
      ConfigurationSetName: input.configurationSet ?? this.cfg.configurationSet,
      Content: {
        Raw: { Data: new TextEncoder().encode(input.rawMessage) },
      },
    });
    const out = await this.c.send(cmd);
    return {
      provider: this.name,
      providerMessageId: out.MessageId ?? '',
      costCents: 1,    // $0.10/1k = 0.01 cent — round up to 1 cent per ledger row
    };
  }
}

/** Mock outbound provider used in dev / SAMPLE_MODE / tests. */
export class MockOutbound implements OutboundProvider {
  readonly name = 'mock-outbound';
  public sent: Array<SendInput & { providerMessageId: string }> = [];
  isEnabled() { return true; }
  async send(input: SendInput): Promise<SendResult> {
    const providerMessageId = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.sent.push({ ...input, providerMessageId });
    return { provider: this.name, providerMessageId, costCents: 0 };
  }
}
