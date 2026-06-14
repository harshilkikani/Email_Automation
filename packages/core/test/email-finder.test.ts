import { describe, it, expect } from 'vitest';
import {
  extractPeople, pickDecisionMaker, detectEmailPattern, generateCandidates, chooseBestEmail,
} from '../src/index.js';

describe('extractPeople + pickDecisionMaker', () => {
  it('pulls names + roles from common phrasings', () => {
    const text = 'About us. John Smith, Owner. Our team: Sarah Lee - Office Manager. Founded by Mike Brown.';
    const people = extractPeople(text);
    const byName = (n: string) => people.find(p => p.name === n);
    expect(byName('John Smith')?.role).toBe('owner');
    expect(byName('Mike Brown')?.role).toBe('owner');   // "founded by"
    expect(byName('Sarah Lee')?.role).toBe('manager');
  });
  it('picks the most senior person', () => {
    const people = extractPeople('Jane Doe, Manager. Bob King, Owner.');
    expect(pickDecisionMaker(people)?.name).toBe('Bob King');
  });
});

describe('detectEmailPattern', () => {
  it('infers {first}.{last} from a name-matched email', () => {
    const p = { name: 'John Smith', firstName: 'John', lastName: 'Smith', role: 'owner' };
    expect(detectEmailPattern([{ email: 'john.smith@co.com', person: p }])).toBe('{first}.{last}');
  });
  it('infers {f}{last}', () => {
    const p = { name: 'Alex Lee', firstName: 'Alex', lastName: 'Lee', role: null };
    expect(detectEmailPattern([{ email: 'alee@co.com', person: p }])).toBe('{f}{last}');
  });
  it('ignores generic mailboxes', () => {
    const p = { name: 'John Smith', firstName: 'John', lastName: 'Smith', role: null };
    expect(detectEmailPattern([{ email: 'info@co.com', person: p }])).toBeNull();
  });
});

describe('generateCandidates', () => {
  it('puts the detected pattern first', () => {
    const c = generateCandidates({ firstName: 'Alex', lastName: 'Smith' }, 'co.com', '{f}{last}');
    expect(c[0]).toBe('asmith@co.com');
    expect(c).toContain('alex@co.com');
    expect(c).toContain('alex.smith@co.com');
  });
});

describe('chooseBestEmail', () => {
  const owner = { name: 'John Smith', firstName: 'John', lastName: 'Smith', role: 'owner' };
  it('prefers an on-site email matching the owner (direct_owner)', () => {
    const r = chooseBestEmail(owner, ['john@acme.com', 'info@acme.com'], 'acme.com', null);
    expect(r).toEqual({ email: 'john@acme.com', source: 'direct_owner', confidence: 0.95 });
  });
  it('uses a pattern-inferred owner address when no direct match', () => {
    const r = chooseBestEmail(owner, ['sarah.lee@acme.com'], 'acme.com', '{first}.{last}');
    expect(r?.source).toBe('pattern');
    expect(r?.email).toBe('john.smith@acme.com');
  });
  it('falls back to the best generic mailbox', () => {
    const r = chooseBestEmail(null, ['sales@acme.com', 'info@acme.com'], 'acme.com', null);
    expect(r).toEqual({ email: 'info@acme.com', source: 'generic', confidence: 0.8 });
  });
});
