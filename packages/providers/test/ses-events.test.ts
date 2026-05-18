import { describe, it, expect } from 'vitest';
import { parseSnsNotification, shouldAutoSuppress } from '@keres/providers';

describe('SES SNS notification parser', () => {
  it('handles SubscriptionConfirmation', () => {
    const r = parseSnsNotification({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.example.com/confirm',
      TopicArn: 'arn:aws:sns:us-east-1:123:keres',
    });
    expect(r[0].kind).toBe('subscription_confirmation');
    if (r[0].kind === 'subscription_confirmation') expect(r[0].subscribeUrl).toContain('confirm');
  });

  it('parses bounce notification with permanent type → hard bounce', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'msg-123', destination: ['lead@example.com'] },
      bounce: {
        bounceType: 'Permanent', bounceSubType: 'General',
        timestamp: '2026-05-17T10:00:00Z',
        bouncedRecipients: [{ emailAddress: 'lead@example.com', diagnosticCode: '550 rejected' }],
      },
    });
    const r = parseSnsNotification({ Type: 'Notification', Message: msg });
    expect(r.length).toBe(1);
    if (r[0].kind === 'event') {
      expect(r[0].eventType).toBe('bounce');
      expect(r[0].bounceType).toBe('hard');
      expect(r[0].providerMessageId).toBe('msg-123');
      expect(r[0].recipients).toContain('lead@example.com');
    }
    expect(shouldAutoSuppress(r[0])).toBe(true);
  });

  it('classifies temporary bounce as soft → no auto-suppress', () => {
    const msg = JSON.stringify({
      notificationType: 'Bounce',
      mail: { messageId: 'msg-456', destination: ['x@y.com'] },
      bounce: { bounceType: 'Transient' },
    });
    const r = parseSnsNotification({ Type: 'Notification', Message: msg });
    if (r[0].kind === 'event') expect(r[0].bounceType).toBe('soft');
    expect(shouldAutoSuppress(r[0])).toBe(false);
  });

  it('parses complaint → auto-suppress', () => {
    const msg = JSON.stringify({
      eventType: 'Complaint',
      mail: { messageId: 'msg-789', destination: ['c@d.com'] },
      complaint: { complaintFeedbackType: 'abuse' },
    });
    const r = parseSnsNotification({ Type: 'Notification', Message: msg });
    expect(r[0].kind).toBe('event');
    if (r[0].kind === 'event') expect(r[0].eventType).toBe('complaint');
    expect(shouldAutoSuppress(r[0])).toBe(true);
  });

  it('parses delivery → no suppress', () => {
    const msg = JSON.stringify({
      eventType: 'Delivery',
      mail: { messageId: 'msg-000', destination: ['e@f.com'] },
      delivery: { timestamp: '2026-05-17T10:00:00Z' },
    });
    const r = parseSnsNotification({ Type: 'Notification', Message: msg });
    if (r[0].kind === 'event') expect(r[0].eventType).toBe('delivered');
    expect(shouldAutoSuppress(r[0])).toBe(false);
  });
});
