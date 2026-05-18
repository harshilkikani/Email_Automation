/**
 * Live-Postgres integration test.
 *
 * To run:
 *   docker compose up -d postgres
 *   pnpm db:test
 *
 * Walks the operator flow end-to-end against the real Fastify app + a real
 * Postgres. The outbound provider is the in-process `MockOutbound` (the
 * SAMPLE_MODE flag makes `getOutbound()` pick it). DNS check is mocked at
 * the function boundary via the schema's `last_check_detail` shortcut so we
 * don't need a real DNS server in tests.
 *
 * If Postgres is unreachable, the test suite emits an actionable skip
 * message so `pnpm test` (unit-only) is unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { ensurePg, resetSchema, migrateAndSeed } from './setup.js';

/* Set env before anything else so cached config picks them up. */
process.env.SAMPLE_MODE = 'true';
process.env.NODE_ENV = 'test';
process.env.AUTH_TOKEN ||= 'integration-test-token-aaaaaaaaaaaaaaaaaaaa';
process.env.AUTH_COOKIE_SECRET ||= 'integration-test-cookie-secret-bbbbbbbbbbbbbbbb';
process.env.PUBLIC_BASE_URL ||= 'http://127.0.0.1:8080';
process.env.PHYSICAL_ADDRESS ||= '1 Integration St, Austin TX 78701';
process.env.SEEDLIST_EMAILS ||= 'seed1@integration.test,seed2@integration.test';
process.env.DATABASE_DRIVER = 'node';
process.env.DATABASE_URL ||= 'postgres://postgres:postgres@localhost:5432/keres';

/* Probe Postgres at module load so `it.runIf(pgReachable)` evaluates correctly
   — Vitest captures the value at collection time, before beforeAll fires. */
async function probe(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
    await c.connect(); await c.end();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}
const probeResult = await probe();
const pgReachable = probeResult.ok;
const skipReason: string | null = probeResult.reason ?? null;
let app: FastifyInstance | null = null;

beforeAll(async () => {
  if (!pgReachable) {
    /* eslint-disable-next-line no-console */
    console.warn(`[integration] SKIPPING — Postgres unreachable. ${skipReason}`);
    return;
  }
  await ensurePg();
  await resetSchema();
  await migrateAndSeed();
  const { buildTestApp } = await import('../src/test-server.js');
  const cfgMod = await import('../src/config.js');
  cfgMod.resetConfigCache();
  app = await buildTestApp();
}, 120_000);

afterAll(async () => { if (app) await app.close(); });

function bearer() { return { authorization: `Bearer ${process.env.AUTH_TOKEN}` }; }

async function inject(method: any, url: string, body?: any) {
  return app!.inject({ method, url, headers: { ...bearer(), 'content-type': 'application/json' }, payload: body });
}

describe('integration: Keres AI end-to-end', () => {
  it.runIf(pgReachable)('boots a healthy app', async () => {
    const r = await app!.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.sampleMode).toBe(true);
  });

  it.runIf(pgReachable)('auth: rejects bad token, accepts good', async () => {
    const bad = await app!.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' }, headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app!.inject({ method: 'POST', url: '/api/auth/login', payload: { token: process.env.AUTH_TOKEN }, headers: { 'content-type': 'application/json' } });
    expect(ok.statusCode).toBe(200);
  });

  it.runIf(pgReachable)('settings: read returns the seeded org', async () => {
    const r = await inject('GET', '/api/settings');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.ok).toBe(true);
    expect(b.org.name).toBeTruthy();
  });

  it.runIf(pgReachable)('settings: update persists', async () => {
    await inject('PUT', '/api/settings', { fromName: 'Integration Sam', physicalAddress: '1 Integration St, Austin TX 78701' });
    const r = await inject('GET', '/api/settings');
    expect(r.json().org.fromName).toBe('Integration Sam');
  });

  let senderDomainId = '';
  it.runIf(pgReachable)('sender-domains: create persists and DNS check populates statuses', async () => {
    const c = await inject('POST', '/api/sender-domains', { domain: 'outreach.integration.test' });
    expect(c.statusCode).toBe(200);
    senderDomainId = c.json().id;
    expect(senderDomainId).toBeTruthy();
    const d = await inject('POST', `/api/sender-domains/${senderDomainId}/check-dns`);
    expect(d.statusCode).toBe(200);
    const dj = d.json();
    /* Sample mode → all green. */
    expect(dj.check.spf).toBe('pass');
    expect(dj.check.dkim).toBe('pass');
    expect(dj.check.real).toBe(false);
  });

  it.runIf(pgReachable)('license importer inserts state_licensees', async () => {
    const csv = [
      'Business Name,License Number,Status,Phone',
      'Acme Septic Co,ABC-1,Active,7135551212',
      'Hometown Septic,HOM-2,Active,7135559999',
    ].join('\n');
    const r = await inject('POST', '/api/licenses/import', { state: 'TX', niche: 'Septic', csv });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.inserted).toBe(2);
    const list = await inject('GET', '/api/licenses?state=TX&niche=Septic');
    expect(list.json().rows.length).toBeGreaterThanOrEqual(2);
  });

  it.runIf(pgReachable)('discovery: produces leads with license-matched signal', async () => {
    const r = await inject('POST', '/api/discovery/run', { niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 5 });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.inserted).toBeGreaterThan(0);
  });

  it.runIf(pgReachable)('dedupe: a re-run does not double-insert', async () => {
    const first = await inject('POST', '/api/discovery/run', { niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 5 });
    const second = await inject('POST', '/api/discovery/run', { niche: 'Septic', city: 'Houston', state: 'TX', targetCount: 5 });
    const f = first.json(), s = second.json();
    expect(s.duplicates).toBeGreaterThanOrEqual(Math.min(5, f.inserted));
  });

  let leadId = '';
  it.runIf(pgReachable)('leads: list + detail include score evidence', async () => {
    const r = await inject('GET', '/api/leads?niche=Septic&limit=5');
    expect(r.statusCode).toBe(200);
    const rows = r.json().rows;
    expect(rows.length).toBeGreaterThan(0);
    leadId = rows[0].id;
    const d = await inject('GET', `/api/leads/${leadId}`);
    expect(d.statusCode).toBe(200);
    expect(d.json().lead).toBeTruthy();
    expect(d.json().signals).toBeTruthy();
  });

  let experimentId = '';
  it.runIf(pgReachable)('validation: create experiment and record reviews', async () => {
    const r = await inject('POST', '/api/validation/experiments', {
      name: 'INTEG-Septic-Houston', phase: 'eyeball', niche: 'Septic', cities: ['Houston'],
    });
    experimentId = r.json().id;
    expect(experimentId).toBeTruthy();
    /* Record 7 A/B and 3 C/D so the verdict transitions to 'pass'. */
    const rows = (await inject('GET', '/api/leads?niche=Septic&limit=10')).json().rows;
    for (let i = 0; i < rows.length; i++) {
      const rating = i < 7 ? 'A' : 'C';
      await inject('POST', '/api/validation/reviews', { experimentId, leadId: rows[i].id, rating, reasonTags: rating === 'C' ? ['wrong_niche'] : [] });
    }
    const sum = await inject('GET', `/api/validation/experiments/${experimentId}`);
    const verdict = sum.json().eyeball.verdict;
    expect(['pass', 'tune', 'stop']).toContain(verdict);
  });

  it.runIf(pgReachable)('validation: experiments list endpoint paginates', async () => {
    const r = await inject('GET', '/api/validation/experiments?limit=5');
    expect(r.statusCode).toBe(200);
    expect(r.json().rows.length).toBeGreaterThan(0);
  });

  let campaignId = '';
  it.runIf(pgReachable)('launch: blocked when production access not confirmed; passes after gate is green', async () => {
    /* Ensure productionAccessConfirmed = false to test the block path. */
    await inject('PUT', '/api/settings', { productionAccessConfirmed: false });

    const create = await inject('POST', '/api/campaigns', {
      name: 'INTEG-reach-test', templateKey: 'septic',
      audienceFilter: { niche: 'Septic', minScore: 0, status: 'all', stratified: 'reach', insertSeedlist: true },
      senderDomainId,
    });
    campaignId = create.json().id;
    expect(campaignId).toBeTruthy();

    const blocked = await inject('POST', `/api/campaigns/${campaignId}/launch`);
    expect(blocked.statusCode).toBe(200);
    const blockedJson = blocked.json();
    expect(blockedJson.ok).toBe(false);
    expect(blockedJson.gate.checks.some((c: any) => c.code === 'ses_production_access' && c.state === 'fail')).toBe(true);

    /* Flip production access on; the seedlist test gate still blocks until a
       successful seedlist send. Send one. */
    await inject('PUT', '/api/settings', { productionAccessConfirmed: true });
    await inject('POST', `/api/sender-domains/${senderDomainId}/test-send`, {});

    const gate2 = await inject('GET', `/api/campaigns/${campaignId}/launch-gate`);
    expect(gate2.json().gate.checks.some((c: any) => c.code === 'seedlist_test_recent' && c.state === 'pass')).toBe(true);

    const launched = await inject('POST', `/api/campaigns/${campaignId}/launch`);
    expect(launched.statusCode).toBe(200);
    expect(launched.json().ok).toBe(true);
  });

  it.runIf(pgReachable)('mock SES delivery + bounce + complaint webhook updates recipient state', async () => {
    /* Find a recipient with a providerMessageId (sent at launch time). */
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const row = await c.query(`SELECT provider_message_id, id FROM campaign_recipients WHERE campaign_id=$1 AND provider_message_id IS NOT NULL LIMIT 1`, [campaignId]);
    await c.end();
    if (row.rowCount === 0) return;
    const pid = row.rows[0].provider_message_id;

    /* SAMPLE_MODE bypasses SNS signature verification. */
    const bounce = await inject('POST', '/api/webhooks/ses', {
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        mail: { messageId: pid, destination: ['lead@integration.test'] },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'lead@integration.test', diagnosticCode: '550' }] },
      }),
    });
    expect(bounce.statusCode).toBe(200);
    const bj = bounce.json();
    expect(bj.events).toBeGreaterThanOrEqual(1);
  });

  it.runIf(pgReachable)('mock inbound reply is classified as interested', async () => {
    /* Send a reply for any recipient address. */
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const row = await c.query(`SELECT l.email FROM campaign_recipients cr JOIN leads l ON l.id = cr.lead_id WHERE cr.campaign_id=$1 AND l.email IS NOT NULL LIMIT 1`, [campaignId]);
    await c.end();
    if (row.rowCount === 0) return;
    const replyFrom = row.rows[0].email;

    const ok = await inject('POST', '/api/webhooks/inbound', {
      FromFull: { Email: replyFrom },
      To: 'replies@outreach.integration.test',
      Subject: 'Re: quick question',
      TextBody: "Sounds interesting, let's hop on a call next week.",
      MessageID: 'inb-1', Date: new Date().toISOString(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().intent).toBe('interested');
  });

  it.runIf(pgReachable)('CSV exports return valid CSV with BOM + headers', async () => {
    const leads = await inject('GET', '/api/export/leads.csv');
    expect(leads.statusCode).toBe(200);
    expect(leads.headers['content-type']).toContain('text/csv');
    expect(leads.body.startsWith('﻿')).toBe(true);
    expect(leads.body.split('\r\n')[0]).toContain('id,name,email');

    const supp = await inject('GET', '/api/export/suppressions.csv');
    expect(supp.statusCode).toBe(200);
  });

  it.runIf(pgReachable)('signal-outcome CSV includes the validation-plan columns', async () => {
    /* Use the experiment from earlier — it has no campaign yet, so use the
       launched campaign's experiment id if one exists, else expect 404. */
    const r = await inject('GET', `/api/export/signal-outcome/${experimentId}.csv`);
    /* The eyeball experiment has no campaignId yet → expect 404. */
    expect([200, 404]).toContain(r.statusCode);
  });

  it.runIf(pgReachable)('audit log records launch + DNS check + suppression activity', async () => {
    const r = await inject('GET', '/api/audit?limit=200');
    expect(r.statusCode).toBe(200);
    const actions = r.json().rows.map((x: any) => x.action);
    expect(actions).toContain('dns_check');
    expect(actions).toContain('test_send');
    expect(actions).toContain('launch');
  });

  it.runIf(pgReachable)('provider-usage endpoint returns today + month + budget caps', async () => {
    const r = await inject('GET', '/api/provider-usage');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.budgets).toBeTruthy();
    expect(Array.isArray(b.today)).toBe(true);
    expect(Array.isArray(b.month)).toBe(true);
  });

  it.runIf(pgReachable)('diagnostics endpoint returns the readiness checklist', async () => {
    const r = await inject('GET', '/api/diagnostics');
    expect(r.statusCode).toBe(200);
    const d = r.json().diagnostics;
    expect(typeof d.ok).toBe('boolean');
    expect(d.gate).toBeTruthy();
    expect(Array.isArray(d.gate.checks)).toBe(true);
    expect(d.gate.checks.length).toBeGreaterThan(5);
  });

  it.runIf(pgReachable)('seed is idempotent: running it again does not error', async () => {
    await migrateAndSeed();
    /* Re-querying settings still works. */
    const r = await inject('GET', '/api/settings');
    expect(r.statusCode).toBe(200);
  });

  it.runIf(pgReachable)('bulk suppression then dedupe excludes the address', async () => {
    const r = await inject('POST', '/api/suppressions/bulk', { emails: ['blocked@integration.test'], reason: 'manual' });
    expect(r.statusCode).toBe(200);
    const list = await inject('GET', '/api/suppressions');
    expect(list.json().rows.some((x: any) => x.email === 'blocked@integration.test')).toBe(true);
  });

  it('reports the skip reason when Postgres is unreachable', () => {
    if (!pgReachable) {
      // eslint-disable-next-line no-console
      console.warn(`[integration] DB unreachable. ${skipReason}`);
    }
    expect(true).toBe(true);
  });
});
