import { describe, it, expect } from 'vitest';
import { buildHeaders, canSpamFooter, renderRawMessage } from '@keres/email/headers';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '@keres/email/unsubscribe';

const identity = {
  fromName: 'Keres AI Outreach', fromEmail: 'hello@outreach.keres.com',
  replyTo: 'replies@outreach.keres.com', unsubMailto: 'unsub@outreach.keres.com',
  publicBaseUrl: 'https://app.keres.com',
  physicalAddress: '1 Example St, Austin TX 78701',
  orgName: 'Keres AI',
};

const SECRET = 'unit-test-secret';

describe('RFC 8058 headers', () => {
  it('includes List-Unsubscribe and List-Unsubscribe-Post', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    const h = buildHeaders({
      identity, to: 'lead@example.com', subject: 'Quick question',
      unsubscribeToken: tok, messageId: '<test@out.keres.com>',
    });
    expect(h['List-Unsubscribe']).toContain('https://app.keres.com/unsubscribe/');
    expect(h['List-Unsubscribe']).toContain('mailto:unsub@outreach.keres.com');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(h.From).toContain('Keres AI Outreach');
    expect(h['Content-Type']).toBe('text/plain; charset=UTF-8');
    expect(h.Precedence).toBe('bulk');
  });

  it('renders raw message with CRLF separators', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    const h = buildHeaders({
      identity, to: 'lead@example.com', subject: 'Hi',
      unsubscribeToken: tok, messageId: '<test@out.keres.com>',
    });
    const raw = renderRawMessage(h, 'body line');
    expect(raw).toContain('\r\n');
    expect(raw).toMatch(/From: .+\r\n/);
    expect(raw).toContain('\r\n\r\nbody line');
  });
});

describe('CAN-SPAM footer', () => {
  it('contains organization, address, unsubscribe link', () => {
    const tok = signUnsubscribeToken({ email: 'lead@example.com', scope: 'org-1' }, SECRET);
    const url = `${identity.publicBaseUrl}/unsubscribe/${tok}`;
    const footer = canSpamFooter(identity, url);
    expect(footer).toContain('Keres AI');
    expect(footer).toContain('1 Example St, Austin TX 78701');
    expect(footer).toContain('Unsubscribe (one click)');
    expect(footer).toContain(url);
  });
});
