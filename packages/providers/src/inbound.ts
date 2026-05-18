/**
 * Postmark Inbound webhook parser.
 *
 * Postmark posts a JSON body to our /webhooks/inbound endpoint with parsed
 * From/To/Subject/Headers/TextBody/HtmlBody and the `MessageID`.
 *
 * Authentication: Postmark supports basic-auth on the webhook URL or signed
 * webhook tokens. We support either.
 */
import type { InboundProvider, InboundEvent } from './types.js';

export interface PostmarkInboundConfig {
  enabled: boolean;
  basicAuthUser?: string;
  basicAuthPass?: string;
  webhookToken?: string;
}

export class PostmarkInboundAdapter implements InboundProvider {
  readonly name = 'postmark-inbound';
  constructor(private cfg: PostmarkInboundConfig) {}
  isEnabled() { return this.cfg.enabled; }

  parseWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): InboundEvent | null {
    if (!this.checkAuth(headers)) return null;
    const b = body as any;
    if (!b || typeof b !== 'object') return null;
    const fromEmail = (b.FromFull?.Email ?? b.From ?? '').toString().toLowerCase();
    const toEmail = (b.ToFull?.[0]?.Email ?? b.To ?? '').toString().toLowerCase();
    const subject = (b.Subject ?? '').toString();
    const textBody = (b.TextBody ?? b.StrippedTextReply ?? '').toString();
    const htmlBody = (b.HtmlBody ?? '').toString();
    const providerMessageId = (b.MessageID ?? b.MessageStream ?? '').toString();
    const date = b.Date ? new Date(b.Date) : new Date();
    if (!fromEmail) return null;
    return { providerMessageId, fromEmail, toEmail, subject, textBody, htmlBody, receivedAt: isNaN(date.getTime()) ? new Date() : date };
  }

  private checkAuth(headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.cfg.basicAuthUser && !this.cfg.webhookToken) return true;
    if (this.cfg.basicAuthUser && this.cfg.basicAuthPass) {
      const hdr = headers['authorization'];
      const auth = Array.isArray(hdr) ? hdr[0] : hdr;
      if (!auth || !auth.startsWith('Basic ')) return false;
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [u, p] = decoded.split(':');
      return u === this.cfg.basicAuthUser && p === this.cfg.basicAuthPass;
    }
    if (this.cfg.webhookToken) {
      const hdr = headers['x-postmark-server-token'];
      const tok = Array.isArray(hdr) ? hdr[0] : hdr;
      return tok === this.cfg.webhookToken;
    }
    return true;
  }
}
