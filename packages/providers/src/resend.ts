/**
 * Resend adapter — sends pre-built RFC 5322 messages via the Resend REST API.
 * No credit card required for the free tier (3,000 emails/month).
 *
 * Sign up at resend.com → add domain → copy API key → set RESEND_API_KEY.
 */
import type { OutboundProvider, SendInput, SendResult } from './types.js';

export interface ResendConfig {
  enabled: boolean;
  apiKey: string;
}

export class ResendAdapter implements OutboundProvider {
  readonly name = 'resend';
  constructor(private cfg: ResendConfig) {}
  isEnabled() { return this.cfg.enabled; }

  async send(input: SendInput): Promise<SendResult> {
    if (!this.isEnabled()) throw new Error('Resend disabled');

    /* Split raw RFC 5322 message into header block and body. */
    const sep = input.rawMessage.indexOf('\r\n\r\n');
    const headerBlock = sep >= 0 ? input.rawMessage.slice(0, sep) : input.rawMessage;
    const textBody    = sep >= 0 ? input.rawMessage.slice(sep + 4) : '';

    const getHeader = (name: string) =>
      headerBlock.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();

    const from        = getHeader('From') ?? '';
    const replyTo     = getHeader('Reply-To');
    const listUnsub   = getHeader('List-Unsubscribe');
    const listUnsubP  = getHeader('List-Unsubscribe-Post');
    const messageId   = getHeader('Message-ID');
    const precedence  = getHeader('Precedence');

    const extraHeaders: Record<string, string> = {};
    if (listUnsub)  extraHeaders['List-Unsubscribe']      = listUnsub;
    if (listUnsubP) extraHeaders['List-Unsubscribe-Post'] = listUnsubP;
    if (messageId)  extraHeaders['Message-ID']            = messageId;
    if (precedence) extraHeaders['Precedence']            = precedence;

    const payload: Record<string, unknown> = {
      from,
      to: [input.to],
      subject: input.subject,
      text: textBody,
      headers: extraHeaders,
    };
    if (replyTo) payload.reply_to = [replyTo];

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      throw new Error(`Resend send failed (${res.status}): ${json.message ?? res.statusText}`);
    }
    return {
      provider: this.name,
      providerMessageId: json.id ?? '',
      costCents: 0,
    };
  }
}
