import { describe, it, expect } from 'vitest';
import { importLicenseCsv } from '../src/services/license-importer.js';

/**
 * In-memory DB stand-in mimicking the Drizzle methods we use.
 */
function makeFakeDb() {
  const inserts: any[] = [];
  const updates: any[] = [];
  return {
    db: {
      select() { return makeQuery({ rows: [] }); },
      insert() { return { values: (v: any) => { inserts.push(v); return Promise.resolve(); } }; },
      update() {
        return {
          set: (s: any) => ({ where: () => { updates.push(s); return Promise.resolve(); } }),
        };
      },
      execute: async () => ({ rows: [] }),
    } as any,
    inserts, updates,
  };
}
function makeQuery(result: any) {
  return {
    from() { return this; },
    where() { return this; },
    limit() { return Promise.resolve(result.rows); },
    orderBy() { return this; },
  };
}

const SAMPLE_TX = [
  'Business Name,License Number,Status,Expiration Date,Phone,City,Zip',
  '"Acme Septic Co",ABC-12345,Active,2027-04-30,(713) 555-1212,Houston,77001',
  '"=BAD Septic LLC",DEF-22222,Expired,2024-06-01,7135552323,Houston,77002',  /* CSV-injection-flavored name */
  '"Hometown Septic",HOM-3333,Active,2027-01-01,7135559999,Tomball,77375',
].join('\n');

describe('license CSV importer', () => {
  it('inserts active rows and normalises status', async () => {
    const { db, inserts } = makeFakeDb();
    const r = await importLicenseCsv(db, { state: 'TX', niche: 'Septic', csv: SAMPLE_TX, sourceUrl: 'https://tdlr.example' });
    expect(r.inserted).toBeGreaterThan(0);
    expect(inserts.length).toBe(r.inserted);
    const first = inserts[0];
    expect(first.state).toBe('TX');
    expect(first.niche).toBe('Septic');
    expect(['active','expired','suspended']).toContain(first.status);
  });
  it('skips rows with empty business name', async () => {
    const { db } = makeFakeDb();
    const csv = 'Business Name,Status\n,Active\nReal Co,Active';
    const r = await importLicenseCsv(db, { state: 'TX', niche: 'Septic', csv });
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(1);
  });
  it('returns unmatchedColumns when name column is missing', async () => {
    const { db } = makeFakeDb();
    const csv = 'Foo,Bar\n1,2';
    const r = await importLicenseCsv(db, { state: 'TX', niche: 'Septic', csv });
    expect(r.unmatchedColumns).toEqual(['name']);
  });

  /* Per-state column-mapping coverage. */
  it('CA / CSLB style columns map', async () => {
    const { db, inserts } = makeFakeDb();
    const csv = [
      'Business Name,License No,Status,Class,Expiration Date,Business Phone,Business City,Business Zip',
      'Acme Roofing,1234567,Active,C-39,2027-04-30,(818) 555-0001,Burbank,91501',
    ].join('\n');
    const r = await importLicenseCsv(db, { state: 'CA', niche: 'Roofer', csv });
    expect(r.inserted).toBe(1);
    expect(inserts[0].state).toBe('CA');
    expect(inserts[0].status).toBe('active');
    expect(inserts[0].licenseNumber).toBe('1234567');
  });

  it('AZ / ROC style columns map', async () => {
    const { db, inserts } = makeFakeDb();
    const csv = [
      'Business Name,License Number,License Status,Expiration Date,Business Phone,Business City,Business Zip Code',
      'Desert HVAC,123456,Active,2027-01-15,602-555-1212,Phoenix,85001',
    ].join('\n');
    const r = await importLicenseCsv(db, { state: 'AZ', niche: 'HVAC', csv });
    expect(r.inserted).toBe(1);
    expect(inserts[0].niche).toBe('HVAC');
    expect(inserts[0].phone).toBe('602-555-1212');
  });

  it('NC / NCBEEC style columns map', async () => {
    const { db, inserts } = makeFakeDb();
    const csv = [
      'Licensee,License No,Status,Expires,Phone,City,ZIP',
      'Triangle Electric LLC,U.21000,Active,2027-12-31,919-555-7000,Raleigh,27601',
    ].join('\n');
    const r = await importLicenseCsv(db, { state: 'NC', niche: 'Electrician', csv });
    expect(r.inserted).toBe(1);
    expect(inserts[0].status).toBe('active');
    expect(inserts[0].postalCode).toBe('27601');
  });

  it('TN / verify.tn.gov style columns map', async () => {
    const { db, inserts } = makeFakeDb();
    const csv = [
      'Name on License,License Number,Status,Expiration,Phone,City',
      'Volunteer Plumbing Co.,75123,Active,2027-09-01,615-555-0010,Nashville',
    ].join('\n');
    const r = await importLicenseCsv(db, { state: 'TN', niche: 'Plumber', csv });
    expect(r.inserted).toBe(1);
    expect(inserts[0].name).toBe('Volunteer Plumbing Co.');
    expect(inserts[0].status).toBe('active');
  });

  it('classifies suspended/probation/revoked/expired correctly', async () => {
    const { db, inserts } = makeFakeDb();
    const csv = [
      'Business Name,Status',
      'A,Active',
      'B,Suspended',
      'C,Probation',
      'D,Revoked',
      'E,Expired',
      'F,Pending',
    ].join('\n');
    const r = await importLicenseCsv(db, { state: 'CA', niche: 'HVAC', csv });
    expect(r.inserted).toBe(6);
    expect(inserts.map(i => i.status)).toEqual(['active','suspended','suspended','suspended','expired','expired']);
  });
});
