/**
 * State licensee CSV importer.
 *
 * Why CSV: most state licensing boards (TX TDLR, FL DBPR, GA Sec. of State) publish
 * a downloadable CSV/Excel export of currently-active licensees, but their
 * websites disallow scraping or require manual download. The pragmatic
 * production path is:
 *   1. Operator downloads the official CSV (per LICENSE-SOURCES.md).
 *   2. Operator POSTs the file to /api/licenses/import with the state + niche.
 *   3. This service normalises columns and upserts into `state_licensees`.
 *   4. Discovery then matches by normalized name + state, and (when present)
 *      by normalized phone or postal code, to set the `license_status` signal.
 *
 * The importer is intentionally column-permissive — it accepts a wide variety
 * of common column names (Name, Business Name, Legal Name, License Number,
 * Lic #, Status, Active, Expiration Date, Expires, Phone, City, Zip) and
 * surfaces any rows it could not interpret in the response.
 */
import { eq, and, sql } from 'drizzle-orm';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';

export interface LicenseImportInput {
  state: string;              // 'TX', 'FL', 'GA', ...
  niche: string;              // 'Septic', 'Roofer', 'HVAC', etc.
  csv: string;
  sourceUrl?: string;
  sourceFile?: string;
}

export interface LicenseImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  unmatchedColumns?: string[];
}

const COL = {
  name:     ['name', 'business name', 'legal name', 'company name', 'entity name',
             'licensee', 'licensee name', 'name on license', 'dba', 'name of business'],
  number:   ['license number', 'license #', 'lic #', 'license_no', 'licenseno',
             'license id', 'license no', 'license no.', 'license'],
  status:   ['status', 'license status', 'license state', 'active', 'standing',
             'license type/status', 'license condition'],
  expires:  ['expiration date', 'expires', 'expiration', 'expires on',
             'expiration_date', 'exp date', 'license expiration', 'date of expiration'],
  phone:    ['phone', 'phone number', 'business phone', 'contact phone', 'phone(s)', 'telephone'],
  city:     ['city', 'business city', 'mailing city', 'physical city', 'principal city'],
  state:    ['state', 'business state', 'physical state'],
  postal:   ['zip', 'zipcode', 'zip code', 'postal code', 'postal',
             'business zip', 'business zip code', 'business zipcode', 'physical zip'],
};

function pick(headers: string[], aliases: string[]): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const m = new Map(headers.map(h => [norm(h), h]));
  for (const a of aliases) {
    const got = m.get(norm(a));
    if (got) return got;
  }
  return null;
}

function classifyStatus(raw: string | undefined): 'active' | 'expired' | 'suspended' {
  if (!raw) return 'expired';
  const s = raw.toLowerCase();
  if (/(active|current|in good standing|standing|valid|registered|yes|true|1)\b/.test(s)) return 'active';
  /* suspended/probation/revoked/disciplinary all mean "not currently OK to operate". */
  if (/(suspend|revok|disciplin|probation|debarred|sanction|warning)/.test(s)) return 'suspended';
  if (/(expir|inactive|lapsed|terminat|cancel|closed)/.test(s)) return 'expired';
  return 'expired';
}

export async function importLicenseCsv(db: Database, input: LicenseImportInput): Promise<LicenseImportResult> {
  const rows = parseCsv(input.csv, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };
  const headers = Object.keys(rows[0]!);
  const cNm = pick(headers, COL.name);
  if (!cNm) return { inserted: 0, updated: 0, skipped: rows.length, unmatchedColumns: ['name'] };
  const cNum = pick(headers, COL.number);
  const cSt  = pick(headers, COL.status);
  const cExp = pick(headers, COL.expires);
  const cPh  = pick(headers, COL.phone);
  const cCity = pick(headers, COL.city);
  const cState = pick(headers, COL.state);
  const cZip = pick(headers, COL.postal);

  let inserted = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const name = (cNm && r[cNm] ? r[cNm].trim() : '');
    if (!name) { skipped++; continue; }
    const licenseNumber = cNum ? (r[cNum] ?? '').trim() || null : null;
    const status = classifyStatus(cSt ? r[cSt] : undefined);
    const expiresRaw = cExp ? r[cExp] : undefined;
    const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
    const phone = cPh ? (r[cPh] ?? '').trim() || null : null;
    const city = cCity ? (r[cCity] ?? '').trim() || null : null;
    const stateCode = cState ? (r[cState] ?? '').toUpperCase().slice(0, 2) || null : input.state.toUpperCase();
    const postal = cZip ? (r[cZip] ?? '').trim() || null : null;

    /* Upsert: prefer the (state, licenseNumber) unique key when present. */
    if (licenseNumber) {
      const existing = (await db.select({ id: schema.stateLicensees.id })
        .from(schema.stateLicensees)
        .where(and(eq(schema.stateLicensees.state, input.state), eq(schema.stateLicensees.licenseNumber, licenseNumber)))
        .limit(1))[0];
      if (existing) {
        await db.update(schema.stateLicensees).set({
          name, niche: input.niche, status,
          expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
          phone, city, stateCode, postalCode: postal,
          sourceUrl: input.sourceUrl ?? null, sourceFile: input.sourceFile ?? null,
          importedAt: new Date(), refreshedAt: new Date(),
        }).where(eq(schema.stateLicensees.id, existing.id));
        updated++;
        continue;
      }
    }
    await db.insert(schema.stateLicensees).values({
      state: input.state, niche: input.niche, name,
      licenseNumber, status,
      expiresAt: expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null,
      phone, city, stateCode, postalCode: postal,
      sourceUrl: input.sourceUrl ?? null, sourceFile: input.sourceFile ?? null,
    });
    inserted++;
  }
  return { inserted, updated, skipped };
}

/**
 * DB-backed lookup. Replaces the prior stub adapter. Matches in order:
 *   1. Exact normalized name + state + niche
 *   2. Phone-based match (fewer false positives on common names)
 *   3. Fuzzy name (trigram similarity) — only when pg_trgm is available, else skip
 */
export interface LicenseLookupParams {
  name: string;
  state: string;
  niche: string;
  phone?: string | null;
}
export interface LicenseLookupHit {
  status: 'active' | 'expired' | 'suspended' | 'unknown';
  licenseNumber?: string | null;
  expiresAt?: Date | null;
  source?: string | null;
  sourceUrl?: string | null;
  matchedBy?: 'name' | 'phone' | 'fuzzy';
  confidence: number;          // 0..1
  staleDays?: number;
}

const STALENESS_WARN_DAYS = 180;

export async function lookupLicense(db: Database, p: LicenseLookupParams): Promise<LicenseLookupHit> {
  const state = p.state.toUpperCase().slice(0, 2);
  const normName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normName) return { status: 'unknown', confidence: 0 };

  /* Phone-first match — strongest signal when available. */
  const phoneDigits = (p.phone ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 7) {
    const row = (await db.select().from(schema.stateLicensees)
      .where(and(
        eq(schema.stateLicensees.state, state),
        eq(schema.stateLicensees.niche, p.niche),
        eq(schema.stateLicensees.dedupPhone, phoneDigits),
      ))
      .limit(1))[0];
    if (row) return hitFromRow(row, 'phone', 0.95);
  }

  /* Exact normalized-name match. */
  const exact = (await db.select().from(schema.stateLicensees)
    .where(and(
      eq(schema.stateLicensees.state, state),
      eq(schema.stateLicensees.niche, p.niche),
      eq(schema.stateLicensees.dedupName, normName),
    ))
    .limit(1))[0];
  if (exact) return hitFromRow(exact, 'name', 0.9);

  /* Fuzzy match via pg_trgm (extension created in 0000_init.sql). Best-effort:
     wrap in try/catch so absence of pg_trgm doesn't break lookups. */
  try {
    const fuzzy = await db.execute(sql`
      SELECT id, name, license_number, status, expires_at, source_url,
             similarity(dedup_name, ${normName}) AS sim
      FROM state_licensees
      WHERE state = ${state} AND niche = ${p.niche}
        AND dedup_name % ${normName}
      ORDER BY sim DESC
      LIMIT 1
    `);
    const r: any = (fuzzy as any).rows?.[0] ?? (fuzzy as any)[0];
    if (r && r.sim >= 0.55) {
      return {
        status: r.status,
        licenseNumber: r.license_number,
        expiresAt: r.expires_at ? new Date(r.expires_at) : null,
        sourceUrl: r.source_url,
        matchedBy: 'fuzzy',
        confidence: Math.min(0.85, Number(r.sim)),
      };
    }
  } catch { /* pg_trgm unavailable or non-Postgres backend — skip. */ }

  return { status: 'unknown', confidence: 0 };
}

function hitFromRow(row: typeof schema.stateLicensees.$inferSelect, matchedBy: 'name' | 'phone', baseConf: number): LicenseLookupHit {
  const staleDays = row.refreshedAt ? Math.floor((Date.now() - new Date(row.refreshedAt).getTime()) / 86400000) : null;
  return {
    status: row.status as LicenseLookupHit['status'],
    licenseNumber: row.licenseNumber,
    expiresAt: row.expiresAt,
    sourceUrl: row.sourceUrl,
    matchedBy,
    confidence: staleDays !== null && staleDays > STALENESS_WARN_DAYS
      ? baseConf - 0.2
      : baseConf,
    ...(staleDays !== null ? { staleDays } : {}),
  };
}
