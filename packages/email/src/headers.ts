/**
 * RFC 8058 + CAN-SPAM compliant header builder.
 *
 * Each outbound email gets:
 *   List-Unsubscribe: <https://unsub-url>, <mailto:unsub@addr?subject=unsubscribe>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The header order matters for Gmail/Yahoo bulk-sender checks; we emit them
 * together and the SES adapter passes them through as-is via Raw email.
 */
import { unsubscribeUrl } from './unsubscribe.js';

export interface SendIdentity {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  unsubMailto: string;
  publicBaseUrl: string;
  physicalAddress: string;
  orgName: string;
}

export interface BuildHeadersInput {
  identity: SendIdentity;
  to: string;
  subject: string;
  unsubscribeToken: string;
  messageId: string;
  customHeaders?: Record<string, string>;
}

export interface BuiltHeaders {
  From: string;
  'Reply-To'?: string;
  To: string;
  Subject: string;
  'Message-ID': string;
  'MIME-Version': string;
  'Content-Type': string;
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': string;
  Precedence: string;
  [k: string]: string | undefined;
}

export function buildHeaders(input: BuildHeadersInput): BuiltHeaders {
  const url = unsubscribeUrl(input.identity.publicBaseUrl, input.unsubscribeToken);
  const headers: BuiltHeaders = {
    From: `${q(input.identity.fromName)} <${input.identity.fromEmail}>`,
    To: input.to,
    Subject: input.subject,
    'Message-ID': input.messageId,
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=UTF-8',
    'List-Unsubscribe': `<${url}>, <mailto:${input.identity.unsubMailto}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    Precedence: 'bulk',
  };
  if (input.identity.replyTo) headers['Reply-To'] = input.identity.replyTo;
  for (const [k, v] of Object.entries(input.customHeaders ?? {})) headers[k] = v;
  return headers;
}

function q(s: string): string {
  if (/[",<>@]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/** Renders the CAN-SPAM footer that gets appended to every body. */
export function canSpamFooter(identity: SendIdentity, unsubscribeUrlStr: string): string {
  return [
    '',
    '---',
    `${identity.orgName}`,
    `${identity.physicalAddress}`,
    `You received this because we identified your business as a potential fit for our service.`,
    `Unsubscribe (one click): ${unsubscribeUrlStr}`,
    `Or reply with "unsubscribe" and we will remove you within 2 days.`,
  ].join('\n');
}

/**
 * Renders a complete raw RFC 5322 message (headers + body) — what the SES
 * SendRawEmail / SendEmailRaw API takes.
 */
export function renderRawMessage(headers: BuiltHeaders, body: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}
