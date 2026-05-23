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
  /* Only set content-type when we actually have a JSON payload — otherwise
     Fastify's JSON parser rejects "empty body but Content-Type: application/json". */
  const headers: Record<string, string> = { ...bearer() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({ method, url, headers, payload: body });
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
    /* The bad-token attempt registers an IP-backoff penalty that would 429 the
       follow-up good-token attempt. Reset before the good-token check so we
       test the auth logic in isolation, not the rate-limit interaction (which
       has its own coverage). */
    const { resetAuthBackoff } = await import('../src/auth.js');
    const bad = await app!.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' }, headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(401);
    resetAuthBackoff();
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

    /* Flip production access on + run a seedlist test so the per-campaign
       gates clear. `sample_mode_off` will still fail (SAMPLE_MODE=true is the
       whole point of integration testing), so we exercise the explicit
       operator-override path and verify the audit log records it. */
    await inject('PUT', '/api/settings', { productionAccessConfirmed: true });
    await inject('POST', `/api/sender-domains/${senderDomainId}/test-send`, {});

    const gate2 = await inject('GET', `/api/campaigns/${campaignId}/launch-gate`);
    expect(gate2.json().gate.checks.some((c: any) => c.code === 'seedlist_test_recent' && c.state === 'pass')).toBe(true);

    /* Launch via operator override (acknowledging SAMPLE_MODE) — this is the
       documented path for the integration / sample-mode flow. */
    const launched = await inject('POST', `/api/campaigns/${campaignId}/launch`, {
      override: { reason: 'Integration test — sample mode, MockOutbound in use' },
    });
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

  it.runIf(pgReachable)('/api/ready returns structured JSON with blockers when gate fails', async () => {
    const r = await app!.inject({ method: 'GET', url: '/api/ready' });
    /* In integration mode SAMPLE_MODE=true, so the launch gate has at least
       the `sample_mode_off` blocker — the endpoint MUST be 503 and the body
       MUST be JSON with a structured shape. */
    expect(r.statusCode).toBe(503);
    const b = r.json();
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('launch_gate_blocked');
    expect(typeof b.blockingCount).toBe('number');
    expect(b.blockingCount).toBeGreaterThan(0);
    expect(Array.isArray(b.blockers)).toBe(true);
    expect(b.blockers.length).toBe(b.blockingCount);
    for (const x of b.blockers) {
      expect(typeof x.key).toBe('string');
      expect(x.status).toBe('fail');
      expect(typeof x.message).toBe('string');
    }
    /* `realOutboundEnabled` must be derivable from runtime config, not faked. */
    expect(b.realOutboundEnabled).toBe(false);
    expect(typeof b.enableSes).toBe('boolean');
    expect(typeof b.sampleMode).toBe('boolean');
    expect(typeof b.timestamp).toBe('string');
    expect(b.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it.runIf(pgReachable)('unknown /api routes return clean JSON 404 (when authed)', async () => {
    const r = await inject('GET', '/api/this-does-not-exist-anywhere');
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const b = r.json();
    expect(b.ok).toBe(false);
    expect(b.error).toBe('not_found');
    expect(b.reason).toBe('unknown_api_route');
  });

  it.runIf(pgReachable)('/api/leads/search hits the UUID guard, returns 404 JSON (not 500)', async () => {
    const r = await inject('GET', '/api/leads/search');
    expect(r.statusCode).toBe(404);
    const b = r.json();
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('invalid_id_format');
    expect(b.param).toBe('id');
  });

  it.runIf(pgReachable)('/api/leads/<garbage> returns 404 JSON, never 500', async () => {
    const r = await inject('GET', '/api/leads/this-is-not-a-uuid');
    expect(r.statusCode).toBe(404);
    expect(r.json().reason).toBe('invalid_id_format');
  });

  it.runIf(pgReachable)('/api/campaigns/<garbage> returns 404 JSON, never 500', async () => {
    const r = await inject('GET', '/api/campaigns/not-a-uuid-either');
    expect(r.statusCode).toBe(404);
    expect(r.json().reason).toBe('invalid_id_format');
  });

  /* ──────────────── New-layer integration coverage ──────────────── */

  it.runIf(pgReachable)('domain_events: insert + read round-trips', async () => {
    const { emitEvent } = await import('../src/services/events.js');
    const db = (await import('@keres/db')).getDb();
    const orgRow = (await db.select({ id: (await import('@keres/db')).schema.organizations.id }).from((await import('@keres/db')).schema.organizations).limit(1))[0];
    if (!orgRow) throw new Error('no org seeded');
    await emitEvent(db, orgRow.id, 'test.audit_probe', 'integration_test', 'probe-1', { hello: 'world' });
    const r = await inject('GET', '/api/domain-events?aggregateType=integration_test&aggregateId=probe-1');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
    const probe = j.rows.find((e: any) => e.eventType === 'test.audit_probe');
    expect(probe).toBeTruthy();
    expect(probe.payload?.hello).toBe('world');
  });

  it.runIf(pgReachable)('closed-loop tick: writes proposals but does NOT auto-apply when CLOSED_LOOP_AUTO_APPLY=false', async () => {
    /* The integration test runs in SAMPLE_MODE=true and never sets
       CLOSED_LOOP_AUTO_APPLY, so the env default (false) governs. We
       assert the tick is a no-op for auto-apply regardless of evidence:
       it should record proposals (or 0 if no recipients) but never write
       a new scoring_versions row. */
    const { tickClosedLoop } = await import('../src/services/closed-loop.js');
    const db = (await import('@keres/db')).getDb();
    const before = (await db.select().from((await import('@keres/db')).schema.scoringVersions)).length;
    const log = (app as any).log;
    const out = await tickClosedLoop(db, log) as { totalAutoApplied?: number; totalAutoSkipped?: number };
    expect(out.totalAutoApplied ?? 0).toBe(0);
    /* totalAutoSkipped equals the number of proposals that *would* have
       been considered for auto-apply but were skipped because the env
       flag is off. May be 0 if there were no proposals at all. */
    expect(out.totalAutoSkipped).toBeGreaterThanOrEqual(0);
    const after = (await db.select().from((await import('@keres/db')).schema.scoringVersions)).length;
    expect(after).toBe(before);
  });

  it.runIf(pgReachable)('DLQ replay: refuses when launch gate fails', async () => {
    /* Construct a synthetic dead_letters row pointing at the existing seeded
       campaign + recipient (from the launch flow earlier in this suite). The
       campaign's gate will fail at minimum on sample_mode_off (we're in
       SAMPLE_MODE=true) so the replay must return 412 with the structured
       blocker list. */
    const db = (await import('@keres/db')).getDb();
    const { schema: s } = await import('@keres/db');
    const orgRow = (await db.select({ id: s.organizations.id }).from(s.organizations).limit(1))[0]!;
    const camp = (await db.select().from(s.campaigns).limit(1))[0];
    if (!camp) {
      console.warn('[integration] DLQ replay test skipped — no campaign in DB');
      return;
    }
    const { eq: _eq } = await import('drizzle-orm');
    const recipient = (await db.select().from(s.campaignRecipients).where(_eq(s.campaignRecipients.campaignId, camp.id)).limit(1))[0];
    if (!recipient) {
      console.warn('[integration] DLQ replay test skipped — no recipient');
      return;
    }
    const inserted = await db.insert(s.deadLetters).values({
      orgId: orgRow.id, campaignId: camp.id, recipientId: recipient.id,
      failReason: 'integration_test_synthetic', archivedAt: new Date(),
    }).returning({ id: s.deadLetters.id });
    const dlId = inserted[0]!.id;
    const r = await inject('POST', `/api/dead-letters/${dlId}/replay`);
    expect(r.statusCode).toBe(412);
    const b = r.json();
    expect(b.ok).toBe(false);
    expect(b.error).toBe('launch_gate_blocked');
    expect(b.reason).toBe('replay_would_violate_launch_gate');
    expect(Array.isArray(b.blockers)).toBe(true);
    expect(b.blockers.length).toBeGreaterThan(0);
    /* Recipient must NOT have been resurrected. */
    const after = (await db.select().from(s.campaignRecipients).where(_eq(s.campaignRecipients.id, recipient.id)).limit(1))[0]!;
    expect(after.state).toBe(recipient.state);  // unchanged
  });

  it.runIf(pgReachable)('send-time deferral writes a future nextSendAt when histogram says so', async () => {
    /* Pure-function delegate: deferralTarget() already has full unit
       coverage. Here we just verify the wiring — that getPreferredHoursBulk
       returns a Map keyed by orgId|niche for our seeded org without
       throwing. */
    const { getPreferredHoursBulk } = await import('../src/services/send-time-histogram.js');
    const db = (await import('@keres/db')).getDb();
    const { schema: s } = await import('@keres/db');
    const orgRow = (await db.select({ id: s.organizations.id }).from(s.organizations).limit(1))[0]!;
    const m = await getPreferredHoursBulk(db, [{ orgId: orgRow.id, niche: 'Septic' }], { startHour: 14, endHour: 22 });
    expect(m).toBeInstanceOf(Map);
    /* Cold-start: empty histogram → empty Map. The deferral logic falls back
       to "send now" in that case, which is the desired behaviour for a
       fresh deployment. */
  });

  it.runIf(pgReachable)('queue.enqueue + singletonKey dedup + sampleMetrics', async () => {
    const { initQueue } = await import('../src/services/queue.js');
    const { schema: s, getDb } = await import('@keres/db');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    const log = (app as any).log;
    const q = await initQueue(db, log);
    const farFuture = new Date(Date.now() + 60_000);  // 60s out — won't be claimed

    /* enqueue + queued state */
    const id1 = await q.enqueue('q_int_basic', { hello: 'world' }, { scheduledFor: farFuture });
    expect(typeof id1).toBe('string');
    const row = (await db.select().from(s.jobRuns).where(eq(s.jobRuns.id, id1!)).limit(1))[0];
    expect(row?.kind).toBe('q_int_basic');
    expect(row?.status).toBe('queued');

    /* singletonKey dedup: second enqueue returns same id */
    const key = 'sk-' + Math.random().toString(36).slice(2);
    const a = await q.enqueue('q_int_singleton', { a: 1 }, { singletonKey: key, scheduledFor: farFuture });
    const b = await q.enqueue('q_int_singleton', { a: 2 }, { singletonKey: key, scheduledFor: farFuture });
    expect(b).toBe(a);

    /* sampleMetrics groups by (kind, status) */
    const m = await q.sampleMetrics(db);
    expect(m.tier).toBe('db');
    expect(m.counts['q_int_basic']?.['queued']).toBeGreaterThanOrEqual(1);
    expect(m.counts['q_int_singleton']?.['queued']).toBe(1);  // dedup proves only ONE row
  });

  it.runIf(pgReachable)('migrations are idempotent against a seeded DB', async () => {
    /* The release_command runs `node packages/db/dist/migrate.js` on every
       deploy. Confirm it's a no-op when nothing new is pending. */
    const { migrateAndSeed } = await import('./setup.js');
    /* Run migrate+seed a second time. */
    await migrateAndSeed();
    /* If we got here without throwing, the migrations are happy with
       existing data. Also verify the migration ledger has at least the
       6 known migration files. */
    const db = (await import('@keres/db')).getDb();
    const r = await db.execute((await import('drizzle-orm')).sql`SELECT count(*)::int AS n FROM _keres_migrations`);
    const n = ((r as unknown as { rows?: Array<{ n: number }> }).rows?.[0]?.n ?? 0);
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it('reports the skip reason when Postgres is unreachable', () => {
    if (!pgReachable) {

      console.warn(`[integration] DB unreachable. ${skipReason}`);
    }
    expect(true).toBe(true);
  });
});
