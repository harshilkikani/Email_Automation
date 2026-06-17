import { describe, it, expect } from 'vitest';
import { parseNdr } from '../src/services/bounce-processor.js';

const HARD_NDR = `From: Mail Delivery System <MAILER-DAEMON@smtp.spacemail.com>
Subject: Undelivered Mail Returned to Sender
Message-ID: <abc123@smtp.spacemail.com>

This is the mail system at host smtp.spacemail.com.

<info@hometownsepticsolutions.com>: host
    hometownsepticsolutions-com.mail.protection.outlook.com[52.101.40.2] said:
    550 5.4.1 Recipient address rejected: Access denied. (in reply to RCPT TO command)

Final-Recipient: rfc822; info@hometownsepticsolutions.com
Action: failed
Status: 5.4.1
Diagnostic-Code: smtp; 550 5.4.1 Recipient address rejected: Access denied.
`;

const SOFT_NDR = `From: Mail Delivery System <MAILER-DAEMON@smtp.spacemail.com>
Subject: Delayed Mail
Message-ID: <soft1@smtp.spacemail.com>

Final-Recipient: rfc822; owner@busysite.com
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full, try again later
`;

describe('parseNdr', () => {
  it('extracts a hard-bounced recipient', () => {
    const r = parseNdr(HARD_NDR);
    expect(r.messageId).toBe('abc123@smtp.spacemail.com');
    expect(r.bounces).toEqual([{ email: 'info@hometownsepticsolutions.com', hard: true }]);
  });

  it('classifies a 4.x.x NDR as soft (not suppressed)', () => {
    const r = parseNdr(SOFT_NDR);
    expect(r.bounces).toEqual([{ email: 'owner@busysite.com', hard: false }]);
  });

  it('ignores our own envelope/daemon addresses', () => {
    const r = parseNdr(`Final-Recipient: rfc822; ops@keresai.com\nStatus: 5.1.1\nFinal-Recipient: rfc822; real@target.com\nStatus: 5.1.1`, 'keresai.com');
    expect(r.bounces.map(b => b.email)).toEqual(['real@target.com']);
  });

  it('returns no bounces for a non-NDR message', () => {
    expect(parseNdr('Subject: hello\n\njust a normal email').bounces).toEqual([]);
  });
});
