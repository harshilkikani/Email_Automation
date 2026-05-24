/**
 * Mailgun adapter — sends pre-built RFC 5322 messages via the
 * messages.mime API. No AWS required; just an API key and a verified domain.
 *
 * Bounce / complaint events arrive via Mailgun webhooks →
 * POST /api/webhooks/mailgun (handled in routes.ts).
 */
import type { OutboundProvider, SendInput, SendResult } from './types.js';

export interface MailgunConfig {
  enabled: boolean;
  apiKey: string;
  domain: string;
  /** EU region uses api.eu.mailgun.net; US (default) uses api.mailgun.net */
  region?: 'us' | 'eu';
}

export class MailgunAdapter implements OutboundProvider {
  readonly name = 'mailgun';
  constructor(private cfg: MailgunConfig) {}
  isEnabled() { return this.cfg.enabled; }

  private get baseUrl() {
    return this.cfg.region === 'eu'
      ? 'https://api.eu.mailgun.net'
      : 'https://api.mailgun.net';
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!this.isEnabled()) throw new Error('Mailgun disabled');

    const form = new FormData();
    /* Extract To: from the raw message so Mailgun routes it correctly. */
    const toMatch = input.rawMessage.match(/^To:\s*(.+)$/im);
    const to = toMatch?.[1]?.trim() ?? input.to;
    form.append('to', to);
    form.append('message', new Blob([input.rawMessage], { type: 'message/rfc822' }), 'message.mime');

    const url = `${this.baseUrl}/v3/${encodeURIComponent(this.cfg.domain)}/messages.mime`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${this.cfg.apiKey}`).toString('base64')}`,
      },
      body: form,
    });

    const json = await res.json().catch(() => ({})) as { id?: string; message?: string };
    if (!res.ok) {
      throw new Error(`Mailgun send failed (${res.status}): ${json.message ?? res.statusText}`);
    }
    return {
      provider: this.name,
      providerMessageId: (json.id ?? '').replace(/^<|>$/g, ''),
      costCents: 0,
    };
  }
}
