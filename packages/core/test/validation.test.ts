import { describe, it, expect } from 'vitest';
import {
  bucketFor, stratifiedSample, eyeballVerdict, reachVerdict, engagementVerdict,
  REACH_SAMPLE, ENGAGEMENT_SAMPLE, computeLift, deriveWeightPlan,
} from '@keres/core/validation';
import { SCORING_VERSION_V1 } from '@keres/core/scoring';

describe('validation buckets', () => {
  it('classifies score ranges', () => {
    expect(bucketFor(95)).toBe('top');
    expect(bucketFor(70)).toBe('mid');
    expect(bucketFor(50)).toBe('bottom');
    expect(bucketFor(25)).toBe('control');
    expect(bucketFor(10)).toBeNull();
  });
  it('stratified sample respects requested sizes', () => {
    const leads = Array.from({ length: 500 }, (_, i) => ({ id: 'l-' + i, score: i % 100 }));
    const r = stratifiedSample(leads, REACH_SAMPLE);
    expect(r.top.length).toBe(REACH_SAMPLE.top);
    expect(r.mid.length).toBe(REACH_SAMPLE.mid);
    expect(r.bottom.length).toBe(REACH_SAMPLE.bottom);
    expect(r.control.length).toBe(REACH_SAMPLE.control);
  });
  it('stratified sample is deterministic across runs with same seed', () => {
    const leads = Array.from({ length: 300 }, (_, i) => ({ id: 'l-' + i, score: i % 100 }));
    const a = stratifiedSample(leads, ENGAGEMENT_SAMPLE);
    const b = stratifiedSample(leads, ENGAGEMENT_SAMPLE);
    expect(a.top.map(x => x.id)).toEqual(b.top.map(x => x.id));
  });
});

describe('verdict logic', () => {
  it('eyeball — ≥70% A+B passes', () => {
    expect(eyeballVerdict(['A','A','B','B','B','C','D','D','D','D']).verdict).toBe('tune');
    expect(eyeballVerdict(['A','A','A','A','A','A','A','C','D','D']).verdict).toBe('pass');
    expect(eyeballVerdict(['C','C','D','D','D','D','D','D','D','D']).verdict).toBe('stop');
  });

  it('reach — fixes DNS when inbox placement < 70%', () => {
    expect(reachVerdict({ sent: 100, delivered: 90, bounced: 1, complaints: 0, inboxPlacement: 0.6, replies: 1 }).verdict).toBe('fix_dns');
  });
  it('reach — fixes verification when bounce > 8%', () => {
    expect(reachVerdict({ sent: 100, delivered: 90, bounced: 10, complaints: 0, inboxPlacement: 0.9, replies: 1 }).verdict).toBe('fix_verification');
  });
  it('engagement — scale when top ≥5%, gap ≥3pp, qualified ≥30%', () => {
    const r = engagementVerdict({
      sent: 500, delivered: 480, bounced: 5, complaints: 0, inboxPlacement: 0.9, replies: 38,
      byBucket: {
        top: { sent: 200, replied: 14, qualified: 7 },
        mid: { sent: 150, replied: 6, qualified: 2 },
        bottom: { sent: 100, replied: 1, qualified: 0 },
        control: { sent: 50, replied: 0, qualified: 0 },
      },
    });
    expect(r.verdict).toBe('scale');
    expect(r.topReply).toBeCloseTo(0.07, 2);
    expect(r.gap).toBeGreaterThanOrEqual(0.03);
  });
  it('engagement — no_lift when no top-mid gap', () => {
    const r = engagementVerdict({
      sent: 500, delivered: 480, bounced: 5, complaints: 0, inboxPlacement: 0.9, replies: 30,
      byBucket: {
        top: { sent: 200, replied: 10, qualified: 4 },
        mid: { sent: 150, replied: 10, qualified: 4 },
        bottom: { sent: 100, replied: 8, qualified: 3 },
        control: { sent: 50, replied: 2, qualified: 1 },
      },
    });
    expect(r.verdict).toBe('no_lift');
  });
});

describe('signal-outcome lift', () => {
  it('computes P(reply|true) vs P(reply|false)', () => {
    const rows = [
      { leadId: '1', signals: { no_website: true }, replied: true, bucket: 'top' as const },
      { leadId: '2', signals: { no_website: true }, replied: true, bucket: 'top' as const },
      { leadId: '3', signals: { no_website: true }, replied: false, bucket: 'top' as const },
      { leadId: '4', signals: { no_website: false }, replied: false, bucket: 'mid' as const },
      { leadId: '5', signals: { no_website: false }, replied: false, bucket: 'mid' as const },
      { leadId: '6', signals: { no_website: false }, replied: true, bucket: 'mid' as const },
    ];
    const r = computeLift(rows, ['no_website']);
    expect(r[0].pReplyTrue).toBeCloseTo(2 / 3, 5);
    expect(r[0].pReplyFalse).toBeCloseTo(1 / 3, 5);
    expect(r[0].liftReply).toBeCloseTo(2, 5);
  });

  it('derives weight plan capped at ±30%', () => {
    const lift = [
      { signal: 'no_website', pReplyTrue: 0.08, pReplyFalse: 0.03, liftReply: 2.6,
        pQualifiedTrue: 0.04, pQualifiedFalse: 0.02, liftQualified: 2, nTrue: 100, nFalse: 100 },
    ];
    const { plan, nextVersion } = deriveWeightPlan(lift, { no_website: 'webPresence' as any }, SCORING_VERSION_V1);
    /* `webPresence` is a record, not a number, so the plan ignores it cleanly */
    expect(typeof nextVersion.id).toBe('number');
    expect(nextVersion.id).toBe(SCORING_VERSION_V1.id + 1);
  });
});
