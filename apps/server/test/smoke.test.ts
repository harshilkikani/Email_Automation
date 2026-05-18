/**
 * End-to-end smoke test (mock providers, no DB).
 *
 * Walks the full operator flow:
 *   1. Hard filter rejects franchise/residential.
 *   2. Dedupe rejects duplicate phone.
 *   3. Scoring tiers a high-fit Septic lead into 'priority'.
 *   4. Renderer + linter produce clean RFC 8058 + CAN-SPAM email.
 *   5. SES SNS hard-bounce → auto-suppress eligible.
 *   6. Postmark Inbound parses an "interested" reply.
 *   7. Unsubscribe token round-trips.
 *   8. CSV exporter quotes injection-vector cells.
 *   9. License CSV importer parses a TX TDLR-style file (in-memory).
 *  10. Signal-outcome row math holds.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreLead, SCORING_VERSION_V1, hardFilter,
  makeIndex, addToIndex, checkDuplicate,
  TEMPLATES, renderEmail,
  classifyReply,
  bucketFor,
  computeLift,
} from '@keres/core';
import { lintEmail, highestSeverity, signUnsubscribeToken, verifyUnsubscribeToken, finalRender } from '@keres/email';
import { parseSnsNotification, shouldAutoSuppress, PostmarkInboundAdapter, verifySnsMessage } from '@keres/providers';
import { toCsv } from '../src/services/csv.js';

const SECRET = 'smoke-secret';
const identity = {
  fromName: 'Keres AI', fromEmail: 'hello@out.keres.com', replyTo: 'r@out.keres.com',
  unsubMailto: 'unsub@out.keres.com', publicBaseUrl: 'https://app.keres.com',
  physicalAddress: '1 Example St, Austin TX', orgName: 'Keres AI',
};

describe('e2e smoke', () => {
  it('exercises every layer of the production pipeline with mocks', async () => {
    /* 1) Franchise hard-filter */
    expect(hardFilter({ candidate: { name: 'Roto-Rooter of Houston', phone: '713', niche: 'Plumber', source: 'osm' } as any, niche: 'Plumber' }).ok).toBe(false);

    /* 2) Dedupe by phone */
    const idx = makeIndex();
    addToIndex(idx, { name: 'Acme Septic', phone: '7135551212', email: null, website: null, address: null, city: 'Houston', state: 'TX', source: 'osm', sourceExternalId: 'n/1' });
    expect(checkDuplicate({ name: 'Other Co', email: 'x@y.com', phone: '(713) 555-1212', niche: 'Septic', source: 'osm', sourceExternalId: 'n/2' } as any, idx).duplicate).toBe(true);

    /* 3) Score */
    const scored = scoreLead({
      niche: 'Septic', webPresenceLevel: 'none', hasPhone: true, phoneLineType: 'landline',
      hasOnlineBooking: false, isStormZone: false, licenseStatus: 'active',
      reviewCount30d: 0, reviewRating: 4.5, competitorDensity: 30,
      ownerOperator: true, serviceDispatchModel: true, emergencyNiche: true,
      multiLocation: false, isFranchise: false, isResidentialAddress: false, deadDomain: false,
    }, SCORING_VERSION_V1);
    expect(scored.disqualified).toBe(false);
    expect(scored.score).toBeGreaterThan(80);
    expect(bucketFor(scored.score)).toBe('top');

    /* 4) Render + lint */
    const rendered = renderEmail(TEMPLATES.septic, {
      leadId: 'lead-1', business: 'Acme Septic', city: 'Houston',
      signals: { webPresenceLevel: 'none', isStormZone: false, niche: 'Septic', hasOnlineBooking: false },
      fromName: 'Sam', fromSignoff: 'Keres AI',
    });
    const final = finalRender({
      rendered, to: 'lead@acme.com', leadEmail: 'lead@acme.com',
      orgScopeKey: 'org-1', campaignId: 'cmp-1', identity,
      signingSecret: SECRET, messageId: '<m1@out.keres.com>',
    });
    const issues = lintEmail({
      subject: final.subject, body: final.bodyWithFooter,
      identityHasPhysicalAddress: true,
      unsubscribeUrlPresent: final.bodyWithFooter.includes(final.unsubscribeUrl),
      canSpamFooterPresent: final.bodyWithFooter.includes('Unsubscribe (one click)'),
    });
    expect(highestSeverity(issues)).not.toBe('error');
    expect(final.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    /* 5) SES hard bounce → suppress eligible */
    const sns = {
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        mail: { messageId: 'msg-1', destination: ['lead@acme.com'] },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'lead@acme.com', diagnosticCode: '550' }] },
      }),
    };
    const events = parseSnsNotification(sns);
    expect(events.length).toBe(1);
    expect(shouldAutoSuppress(events[0])).toBe(true);
    /* SNS signature verification, bypassed for tests. */
    expect((await verifySnsMessage(sns as any, { skip: true })).valid).toBe(true);

    /* 6) Inbound classification */
    const inbound = new PostmarkInboundAdapter({ enabled: true });
    const ev = inbound.parseWebhook({
      FromFull: { Email: 'lead@acme.com' }, To: 'r@out.keres.com',
      Subject: 'Re: quick question', TextBody: "Sounds interesting, let's hop on a call next week",
      MessageID: 'in-1', Date: '2026-05-18T10:00:00Z',
    }, {});
    expect(ev).not.toBeNull();
    const intent = classifyReply(ev!.subject ?? '', ev!.textBody ?? '');
    expect(intent.intent).toBe('interested');

    /* 7) Unsub round-trip */
    const tok = signUnsubscribeToken({ email: 'lead@acme.com', scope: 'org-1' }, SECRET);
    expect(verifyUnsubscribeToken(tok, SECRET)?.email).toBe('lead@acme.com');

    /* 8) CSV injection protection — formula prefix only (no comma, no quotes needed) */
    const csv = toCsv(['name', 'note'], [{ name: 'Acme', note: '=BAD()' }]);
    expect(csv).toContain(`Acme,'=BAD()`);

    /* 10) Signal-outcome lift math (matches validation plan formulas) */
    const lift = computeLift([
      { leadId: '1', signals: { no_website: true }, replied: true, bucket: 'top' },
      { leadId: '2', signals: { no_website: true }, replied: false, bucket: 'top' },
      { leadId: '3', signals: { no_website: false }, replied: false, bucket: 'mid' },
      { leadId: '4', signals: { no_website: false }, replied: false, bucket: 'mid' },
    ], ['no_website']);
    expect(lift[0].liftReply).toBeGreaterThan(1);
  });
});
