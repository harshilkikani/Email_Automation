import { describe, it, expect } from 'vitest';
import { parseEmail } from '../src/services/reply-ingest.js';

const RAW = `Return-Path: <owner@acmeplumbing.com>
From: "Joe Owner" <owner@acmeplumbing.com>
To: ops@keresai.com
Subject: Re: after-hours calls, Acme Plumbing
Message-ID: <CABCD123@mail.acmeplumbing.com>
Date: Sun, 15 Jun 2026 14:22:10 -0500
Content-Type: text/plain; charset=utf-8

Sounds interesting, can you send pricing?

On Sun, Jun 15 wrote:
> original quoted text
`;

describe('parseEmail (reply ingestion)', () => {
  it('extracts sender, subject, message-id and body', () => {
    const p = parseEmail(RAW)!;
    expect(p.fromEmail).toBe('owner@acmeplumbing.com');
    expect(p.toEmail).toBe('ops@keresai.com');
    expect(p.subject).toBe('Re: after-hours calls, Acme Plumbing');
    expect(p.messageId).toBe('CABCD123@mail.acmeplumbing.com');
    expect(p.textBody).toContain('Sounds interesting');
  });

  it('decodes MIME-encoded subjects', () => {
    const p = parseEmail(`From: a@b.com\nSubject: =?UTF-8?B?UmU6IGhlbGxv?=\n\nbody`)!;
    expect(p.subject).toBe('Re: hello');
  });

  it('returns null when there is no valid From address', () => {
    expect(parseEmail('Subject: no from\n\nbody')).toBeNull();
  });
});
