import { describe, it, expect } from 'vitest';
import { classifyReply } from '@keres/core';

describe('reply classifier', () => {
  it('classifies interested', () => {
    expect(classifyReply('Re: quick question', "Sounds interesting, let's hop on a call next week").intent).toBe('interested');
    expect(classifyReply('', "What's the pricing?").intent).toBe('interested');
  });
  it('classifies conditional', () => {
    expect(classifyReply('', "Maybe Q4, send me info but no time now").intent).toBe('conditional');
  });
  it('classifies hostile', () => {
    const r = classifyReply('', 'Stop emailing me, you spammer!');
    expect(r.intent).toBe('not_interested_hostile');
    expect(r.hostile).toBe(true);
  });
  it('classifies unsubscribe', () => {
    expect(classifyReply('Unsubscribe', 'please remove me').intent).toBe('unsubscribe');
  });
  it('classifies polite no', () => {
    expect(classifyReply('', 'Thanks but no thanks, not interested').intent).toBe('not_interested_polite');
  });
  it('classifies wrong person', () => {
    expect(classifyReply('', "I'm not the owner, contact john@biz.com").intent).toBe('wrong_person');
  });
  it('classifies bounce', () => {
    const r = classifyReply('Delivery Status Notification', 'mailer-daemon undeliverable address rejected 550 5.1.1');
    expect(r.intent).toBe('bounce');
  });
  it('classifies out-of-office as auto reply', () => {
    const r = classifyReply('Out of office', 'I am currently out of the office until Monday');
    expect(r.intent).toBe('auto_reply');
    expect(r.isAutoReply).toBe(true);
  });
});
