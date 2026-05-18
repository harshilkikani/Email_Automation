/**
 * Parse the JSON envelope SES → SNS posts to /webhooks/ses.
 *
 * SNS can send either a SubscriptionConfirmation (one-time) or a Notification.
 * Notifications carry a JSON Message that we further parse for SES events.
 */
import type { InboundEvent } from './types.js';

export type SesEventType = 'send' | 'delivered' | 'bounce' | 'complaint' | 'reject' | 'open' | 'click';

export interface SubscriptionConfirmation {
  kind: 'subscription_confirmation';
  subscribeUrl: string;
  topicArn: string;
}

export interface SesEvent {
  kind: 'event';
  eventType: SesEventType;
  providerMessageId: string;
  occurredAt: Date;
  bounceType?: 'hard' | 'soft';
  diagnostic?: string;
  recipients: string[];
  raw: unknown;
}

export type ParsedSesEvent = SubscriptionConfirmation | SesEvent;

export function parseSnsNotification(body: any): ParsedSesEvent[] {
  if (!body || typeof body !== 'object') return [];
  if (body.Type === 'SubscriptionConfirmation' && typeof body.SubscribeURL === 'string') {
    return [{ kind: 'subscription_confirmation', subscribeUrl: body.SubscribeURL, topicArn: body.TopicArn ?? '' }];
  }
  if (body.Type !== 'Notification') return [];
  let msg: any = null;
  try { msg = typeof body.Message === 'string' ? JSON.parse(body.Message) : body.Message; }
  catch { return []; }
  if (!msg) return [];

  const eventTypeRaw = (msg.eventType ?? msg.notificationType ?? '').toString().toLowerCase();
  const map: Record<string, SesEventType> = {
    bounce: 'bounce', complaint: 'complaint', delivery: 'delivered',
    send: 'send', reject: 'reject', open: 'open', click: 'click',
  };
  const eventType = map[eventTypeRaw];
  if (!eventType) return [];

  const mail = msg.mail ?? {};
  const providerMessageId: string = mail.messageId ?? msg.messageId ?? '';
  const recipients: string[] = Array.isArray(mail.destination) ? mail.destination : [];

  let occurredAt = new Date();
  let bounceType: 'hard' | 'soft' | undefined;
  let diagnostic: string | undefined;

  if (eventType === 'bounce' && msg.bounce) {
    const t = (msg.bounce.bounceType as string ?? '').toLowerCase();
    bounceType = t.includes('permanent') ? 'hard' : 'soft';
    diagnostic = msg.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? msg.bounce.bounceSubType;
    if (msg.bounce.timestamp) occurredAt = new Date(msg.bounce.timestamp);
  } else if (eventType === 'complaint' && msg.complaint) {
    diagnostic = msg.complaint.complaintFeedbackType ?? null;
    if (msg.complaint.timestamp) occurredAt = new Date(msg.complaint.timestamp);
  } else if (eventType === 'delivered' && msg.delivery?.timestamp) {
    occurredAt = new Date(msg.delivery.timestamp);
  }

  return [{
    kind: 'event',
    eventType, providerMessageId, occurredAt,
    bounceType, diagnostic, recipients, raw: msg,
  }];
}

/** Determine whether to auto-suppress the recipient. */
export function shouldAutoSuppress(ev: ParsedSesEvent): boolean {
  if (ev.kind !== 'event') return false;
  if (ev.eventType === 'complaint') return true;
  if (ev.eventType === 'bounce' && ev.bounceType === 'hard') return true;
  return false;
}

/* For tests that mix SES + inbound parsing types under one module. */
export type { InboundEvent };
