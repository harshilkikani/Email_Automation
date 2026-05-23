import { describe, it, expect } from 'vitest';
import { classifyPhone } from '@keres/providers';

describe('phone classification', () => {
  it('classifies common US landline', () => {
    const r = classifyPhone('(212) 555-1212');
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+12125551212');
  });
  it('handles bad input', () => {
    const r = classifyPhone('not a phone');
    expect(r.valid).toBe(false);
    expect(r.lineType).toBe('unknown');
  });
  it('null safe', () => {
    expect(classifyPhone(null).valid).toBe(false);
    expect(classifyPhone(undefined).valid).toBe(false);
  });
});
