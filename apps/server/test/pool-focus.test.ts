import { describe, it, expect } from 'vitest';
import { effectiveNiches } from '../src/services/pool-builder.js';
import type { Niche } from '@keres/core';

const ALL: Niche[] = ['Septic', 'Roofer', 'HVAC', 'Plumber', 'Electrician'];

describe('effectiveNiches (discovery focus)', () => {
  it('returns all niches when focus is empty/null', () => {
    expect(effectiveNiches(ALL, [])).toEqual(ALL);
    expect(effectiveNiches(ALL, null)).toEqual(ALL);
    expect(effectiveNiches(ALL, undefined)).toEqual(ALL);
  });

  it('restricts to the focus trades when set (preserving focus order)', () => {
    expect(effectiveNiches(ALL, ['HVAC', 'Roofer'])).toEqual(['HVAC', 'Roofer']);
  });

  it('ignores focus values that are not real niches', () => {
    expect(effectiveNiches(ALL, ['HVAC', 'NotATrade'])).toEqual(['HVAC']);
  });

  it('falls back to all niches if focus has no valid trades (never discovers nothing)', () => {
    expect(effectiveNiches(ALL, ['Nope', 'Bogus'])).toEqual(ALL);
  });
});
