/**
 * Final-pass renderer that:
 *  1. Takes the template-rendered subject+body from @keres/core/templates
 *  2. Appends the CAN-SPAM footer
 *  3. Returns the RFC 5322 raw message + the parsed headers + the unsubscribe URL
 */
import { canSpamFooter, buildHeaders, renderRawMessage, type SendIdentity, type BuiltHeaders } from './headers.js';
import { signUnsubscribeToken, unsubscribeUrl } from './unsubscribe.js';
import type { RenderedEmail } from '@keres/core';

export interface FinalRenderInput {
  rendered: RenderedEmail;
  to: string;
  leadEmail: string;                // address being unsubscribed
  orgScopeKey: string;              // org id or 'GLOBAL'
  campaignId?: string;
  identity: SendIdentity;
  signingSecret: string;
  messageId: string;
}

export interface FinalRenderOutput {
  subject: string;
  bodyWithFooter: string;
  headers: BuiltHeaders;
  rawMessage: string;
  unsubscribeUrl: string;
  unsubscribeToken: string;
}

export function finalRender(input: FinalRenderInput): FinalRenderOutput {
  const token = signUnsubscribeToken(
    { email: input.leadEmail, scope: input.orgScopeKey, campaignId: input.campaignId },
    input.signingSecret,
  );
  const url = unsubscribeUrl(input.identity.publicBaseUrl, token);
  const footer = canSpamFooter(input.identity, url);
  const bodyWithFooter = `${input.rendered.body.trimEnd()}\n${footer}\n`;
  const headers = buildHeaders({
    identity: input.identity,
    to: input.to,
    subject: input.rendered.subject,
    unsubscribeToken: token,
    messageId: input.messageId,
  });
  const rawMessage = renderRawMessage(headers, bodyWithFooter);
  return {
    subject: input.rendered.subject,
    bodyWithFooter,
    headers,
    rawMessage,
    unsubscribeUrl: url,
    unsubscribeToken: token,
  };
}
