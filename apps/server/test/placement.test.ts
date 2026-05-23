import { describe, it, expect } from 'vitest';
import { currentWarmupTarget, WARMUP_RAMP } from '../src/services/placement.js';

describe('warmup ramp', () => {
  it('returns day-1 cap for fresh domains', () => {
    expect(currentWarmupTarget(0).cap).toBe(10);
    expect(currentWarmupTarget(1).cap).toBe(10);
  });
  it('returns day-7 cap once warmup reaches 7', () => {
    expect(currentWarmupTarget(8).cap).toBe(25);
  });
  it('returns day-30 cap once warmup reaches 30', () => {
    expect(currentWarmupTarget(40).cap).toBe(100);
  });
  it('ramp is monotonically non-decreasing', () => {
    let last = 0;
    for (const r of WARMUP_RAMP) {
      expect(r.cap).toBeGreaterThanOrEqual(last);
      last = r.cap;
    }
  });
});
