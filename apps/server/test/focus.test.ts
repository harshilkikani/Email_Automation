import { describe, it, expect } from 'vitest';
import { recipientPriority, FOCUS_BOOST } from '../src/services/focus.js';

describe('recipientPriority (focus-mode send ordering)', () => {
  it('with no focus, orders purely by lead score', () => {
    expect(recipientPriority(90, 'Plumber', [])).toBeGreaterThan(recipientPriority(40, 'Plumber', []));
    expect(recipientPriority(90, 'Plumber', [])).toBe(90);
  });

  it('focus trades always sort ahead of non-focus trades, regardless of score', () => {
    const focusedLowScore = recipientPriority(10, 'HVAC', ['HVAC']);
    const unfocusedHighScore = recipientPriority(99, 'Roofer', ['HVAC']);
    expect(focusedLowScore).toBeGreaterThan(unfocusedHighScore);
  });

  it('within focus trades, still orders by score', () => {
    expect(recipientPriority(80, 'HVAC', ['HVAC'])).toBeGreaterThan(recipientPriority(50, 'HVAC', ['HVAC']));
    expect(recipientPriority(80, 'HVAC', ['HVAC'])).toBe(FOCUS_BOOST + 80);
  });

  it('never excludes — every lead gets a finite, non-negative priority', () => {
    for (const s of [0, -5, 50, 100, 1e9]) {
      const p = recipientPriority(s, 'Towing', ['HVAC', 'Plumber']);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });
});
