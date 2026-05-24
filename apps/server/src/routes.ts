/**
 * All HTTP route handlers. Kept in one file to keep the router boot order
 * obvious. Each handler is small and delegates to a service in `./services`.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, desc, sql, isNull, gte, inArray, lt } from 'drizzle-orm';
import { parse as parseCsv } from 'csv-parse/sync';
import { getDb } from '@keres/db';
import { schema } from '@keres/db';
import {
  scoreLead, SCORING_VERSION_V1, hardFilter,
  ALL_NICHES,
} from '@keres/core';
import { classifyPhone } from '@keres/providers';
import { getConfig } from './config.js';
import { runDiscovery } from './services/discovery.js';
import {
  createCampaign, buildRecipients, renderPreview,
} from './services/campaigns.js';
import { sendBatch } from './services/sender-pipeline.js';
import { handleSesSns, handleInboundReply } from './services/inbound-handler.js';
import { processUnsubscribe } from './services/unsubscribe.js';
import { runDnsCheck } from './services/sender.js';
import { sendSeedlistTest } from './services/seedlist.js';
import {
  createExperiment, recordReview, buildStratifiedCampaign,
  experimentResults, eyeballSummary,
} from './services/validation.js';
import { PostmarkInboundAdapter, verifySnsMessage } from '@keres/providers';
import { evaluateLaunchGate } from './services/launch-gate.js';
import { runDiagnostics } from './services/diagnostics.js';
import { importLicenseCsv } from './services/license-importer.js';
import { toCsv, csvResponse } from './services/csv.js';
import { writeAudit } from './services/audit.js';
import { generateWizard, saveStepNotes } from './services/wizard.js';
import {
  aggregateSignalOutcomes, proposeScoringChanges,
  applyScoringProposal, rejectScoringProposal,
} from './services/closed-loop.js';
import { refreshWebsiteIntelForLead } from './services/website-intel.js';
import { emitEvent } from './services/events.js';

/* Get the single-tenant org id from env / db — cached for 60s to avoid per-request DB lookup. */
let _cachedOrgId: string | null = null;
let _cachedOrgIdAt = 0;
async function singleOrgId(): Promise<string> {
  const now = Date.now();
  if (_cachedOrgId && now - _cachedOrgIdAt < 60_000) return _cachedOrgId;
  const db = getDb();
  const rows = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
  if (!rows[0]) throw new Error('No organization configured. Run `pnpm db:seed` first.');
  _cachedOrgId = rows[0].id;
  _cachedOrgIdAt = now;
  return _cachedOrgId;
}

/* UUID v4 / general 36-char form: 8-4-4-4-12 hex with dashes.
   Used by the global :id guard below to convert what would be a 500
   ("invalid input syntax for type uuid") into a clean 404. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Per-org in-memory rate limiter: max 120 mutation requests per minute.
   No Redis required — Map is reset on restart which is acceptable for MVP. */
const _orgRateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_RPM = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function registerRoutes(app: FastifyInstance) {
  const cfg = getConfig();

  /* Global guard: every route that takes a `:id` (or `:campaignId`, etc.)
     parameter expects a UUID. If the URL hits a parameterised route with a
     non-UUID value (e.g. someone probes `/api/leads/search` and the router
     binds `id="search"`), we'd otherwise hit Postgres with an invalid uuid
     literal and emit a 500. This converts those into a clean 404 JSON. */
  app.addHook('preHandler', async (req, reply) => {
    const params = req.params as Record<string, string> | undefined;
    if (!params) return;
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (typeof v !== 'string') continue;
      const looksLikeIdKey = k === 'id' || /Id$/.test(k);
      if (!looksLikeIdKey) continue;
      if (UUID_RE.test(v)) continue;
      reply.code(404);
      return reply.send({
        ok: false,
        error: 'not_found',
        reason: 'invalid_id_format',
        param: k,
        hint: 'expected a UUID',
      });
    }
  });

  /* Per-org rate limiting for mutation endpoints. Webhooks are excluded
     because they receive bursts from SES/Postmark that must not be throttled. */
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/webhooks/') || req.url.startsWith('/api/unsubscribe')) return;
    const orgId = await singleOrgId().catch(() => null);
    if (!orgId) return;
    const now = Date.now();
    let bucket = _orgRateMap.get(orgId);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      _orgRateMap.set(orgId, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT_RPM) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      reply.code(429).send({ ok: false, error: 'rate_limited', retryAfter });
      return;
    }
  });

  /* ────────────── Health ────────────── */
  app.get('/api/health', async () => ({
    ok: true,
    sampleMode: cfg.sampleMode,
    mode: cfg.budgetMode,
    enableSes: cfg.ses.enabled || cfg.mailgun.enabled || cfg.resend.enabled,
  }));

  /* ────────────── Settings ────────────── */
  app.get('/api/settings', async () => {
    const db = getDb();
    const org = (await db.select().from(schema.organizations).limit(1))[0];
    if (!org) return { ok: false };
    return {
      ok: true,
      org: {
        id: org.id,
        name: org.name,
        timezone: org.timezone,
        fromName: org.fromName,
        fromEmail: org.fromEmail,
        replyTo: org.replyTo,
        physicalAddress: org.physicalAddress,
        outreachSubdomain: org.outreachSubdomain,
        defaultBookingLink: org.defaultBookingLink,
        productionAccessConfirmed: org.productionAccessConfirmed,
        budgetMode: org.budgetMode,
      },
      runtime: {
        sampleMode: cfg.sampleMode,
        providersEnabled: {
          ses: cfg.ses.enabled,
          postmarkInbound: cfg.postmarkInbound.enabled,
          osm: cfg.osm.enabled,
          yelp: cfg.yelp.enabled,
          hunter: cfg.hunter.enabled,
          bouncer: cfg.bouncer.enabled,
          places: cfg.places.enabled,
        },
      },
    };
  });

  app.put('/api/settings', async (req) => {
    const db = getDb();
    const body = req.body as Record<string, unknown>;
    const id = await singleOrgId();
    /* whitelist: only sender-identity + booking link + budget mode + production access flag */
    const update: Record<string, unknown> = {};
    for (const k of ['fromName','fromEmail','replyTo','physicalAddress','outreachSubdomain','defaultBookingLink','budgetMode','productionAccessConfirmed','name']) {
      if (body[k] !== undefined) update[k] = body[k];
    }
    if (Object.keys(update).length === 0) return { ok: true, noop: true };
    await db.update(schema.organizations).set(update as any).where(eq(schema.organizations.id, id));
    return { ok: true };
  });

  /* ────────────── Sender Domains ────────────── */
  app.get('/api/sender-domains', async () => {
    const db = getDb();
    const id = await singleOrgId();
    const rows = await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.orgId, id));
    return { ok: true, rows };
  });

  app.post('/api/sender-domains', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const b = req.body as { domain: string; sesConfigurationSet?: string; dailySendBudget?: number };
    if (!b?.domain) return { ok: false, error: 'missing_domain' };
    const r = await db.insert(schema.senderDomains).values({
      orgId, domain: b.domain, sesConfigurationSet: b.sesConfigurationSet ?? cfg.ses.configurationSet,
      dailySendBudget: b.dailySendBudget ?? cfg.dailySendCapDefault,
    }).returning({ id: schema.senderDomains.id });
    return { ok: true, id: r[0]?.id };
  });

  app.post('/api/sender-domains/:id/check-dns', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const row = (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, id)).limit(1))[0];
    if (!row) return { ok: false, error: 'not_found' };
    const check = await runDnsCheck(row.domain, {
      requiredDkimSelectors: row.dkimSelectors ?? undefined,
      expectedSpfInclude: row.spfExpectedInclude ?? undefined,
    });
    await db.update(schema.senderDomains).set({
      spfStatus: check.spf, dkimStatus: check.dkim, dmarcStatus: check.dmarc, mxStatus: check.mx,
      dmarcPolicy: check.dmarcPolicy ?? null,
      unsubReachable: check.unsubscribeReachable === 'pass',
      unsubLastStatus: check.detail.unsubscribe.status ?? null,
      lastCheckDetail: check as unknown as Record<string, unknown>,
      lastCheckedAt: new Date(),
    }).where(eq(schema.senderDomains.id, id));
    await writeAudit('dns_check', id, { real: check.real, spf: check.spf, dkim: check.dkim, dmarc: check.dmarc, mx: check.mx, unsub: check.unsubscribeReachable }, req);
    return { ok: true, check };
  });

  app.post('/api/sender-domains/:id/test-send', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { to?: string; subject?: string };
    const r = await sendSeedlistTest(db, id, body.to, body.subject);
    await writeAudit('test_send', id, { to: body.to ?? 'seedlist', ok: r.ok, sent: r.sent, failed: r.failed }, req);
    return r;
  });

  /** Seedlist test history + placement observations. */
  app.get('/api/sender-domains/:id/seedlist', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const rows = await db.select().from(schema.seedlistTests)
      .where(eq(schema.seedlistTests.senderDomainId, id))
      .orderBy(desc(schema.seedlistTests.sentAt))
      .limit(200);
    const { summarisePlacement, currentWarmupTarget } = await import('./services/placement.js');
    const sd = (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.id, id)).limit(1))[0];
    const summary7 = await summarisePlacement(db, id, 7);
    const summary30 = await summarisePlacement(db, id, 30);
    const ramp = currentWarmupTarget(sd?.warmupDay ?? 0);
    return { ok: true, rows, summary7, summary30, ramp };
  });

  app.patch('/api/seedlist-tests/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const b = req.body as { observed?: 'primary'|'promotions'|'spam'|'missing' };
    if (!b.observed) return { ok: false, error: 'missing_observation' };
    await db.update(schema.seedlistTests).set({
      observed: b.observed, observedAt: new Date(),
    }).where(eq(schema.seedlistTests.id, id));
    await writeAudit('placement_observed', id, { observed: b.observed }, req);
    return { ok: true };
  });

  /* ────────────── Discovery Jobs ────────────── */
  app.post('/api/discovery/jobs', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const b = req.body as { name: string; niche: string; city: string; state: string; targetCount?: number; sourceMix?: string[] };
    const r = await db.insert(schema.discoveryJobs).values({
      orgId, name: b.name, niche: b.niche, city: b.city, state: b.state,
      targetCount: b.targetCount ?? 25,
      sourceMix: (b.sourceMix ?? ['osm']) as unknown as Record<string, unknown>,
    }).returning({ id: schema.discoveryJobs.id });
    return { ok: true, id: r[0]?.id };
  });

  app.get('/api/discovery/jobs', async () => {
    const db = getDb();
    const id = await singleOrgId();
    const rows = await db.select().from(schema.discoveryJobs).where(eq(schema.discoveryJobs.orgId, id));
    return { ok: true, rows };
  });

  app.post('/api/discovery/jobs/:id/run', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const job = (await db.select().from(schema.discoveryJobs).where(eq(schema.discoveryJobs.id, id)).limit(1))[0];
    if (!job) return { ok: false, error: 'not_found' };
    const out = await runDiscovery(db, {
      orgId: job.orgId, niche: job.niche as 'Septic', city: job.city, state: job.state,
      targetCount: job.targetCount,
    });
    await db.update(schema.discoveryJobs).set({ lastRunAt: new Date() }).where(eq(schema.discoveryJobs.id, id));
    return { ok: true, ...out };
  });

  /* Ad-hoc discovery without a job. */
  app.post('/api/discovery/run', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const b = req.body as { niche: string; city: string; state: string; targetCount?: number };
    const out = await runDiscovery(db, {
      orgId, niche: b.niche as 'Septic', city: b.city, state: b.state,
      targetCount: b.targetCount ?? 25,
    });
    return { ok: true, ...out };
  });

  /* ────────────── Leads ────────────── */
  app.get('/api/leads', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as Record<string, string | undefined>;
    const conds = [eq(schema.leads.orgId, orgId), isNull(schema.leads.deletedAt)];
    if (q.niche)  conds.push(eq(schema.leads.niche, q.niche));
    if (q.state)  conds.push(eq(schema.leads.state, q.state.toUpperCase().slice(0, 2)));
    if (q.status) conds.push(eq(schema.leads.status, q.status));
    const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const rows = await db.select().from(schema.leads).where(and(...conds))
      .orderBy(desc(schema.leads.score), desc(schema.leads.discoveredAt))
      .limit(limit).offset(offset);
    return { ok: true, rows };
  });

  app.get('/api/leads/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1))[0];
    if (!lead) return { ok: false, error: 'not_found' };
    const signals = (await db.select().from(schema.leadSignals).where(eq(schema.leadSignals.leadId, id)).limit(1))[0] ?? null;
    const events = await db.select().from(schema.leadSourceEvents).where(eq(schema.leadSourceEvents.leadId, id));
    const intel = (await db.select().from(schema.websiteIntel).where(eq(schema.websiteIntel.leadId, id)).limit(1))[0] ?? null;
    return { ok: true, lead, signals, events, intel };
  });

  app.post('/api/leads/:id/refresh-intel', async (req) => {
    const { id } = req.params as { id: string };
    const r = await refreshWebsiteIntelForLead(getDb(), id);
    await writeAudit('website_intel_refresh', id, { ok: r.ok, reason: r.reason ?? null }, req);
    return r;
  });

  app.patch('/api/leads/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = req.body as Partial<typeof schema.leads.$inferInsert>;
    const allowed: Record<string, unknown> = {};
    for (const k of ['status', 'tags', 'notes'] as const) {
      if (body[k] !== undefined) allowed[k] = body[k];
    }
    if (Object.keys(allowed).length === 0) return { ok: true, noop: true };
    await db.update(schema.leads).set(allowed as any).where(eq(schema.leads.id, id));
    return { ok: true };
  });

  app.post('/api/leads/:id/suppress', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const orgId = await singleOrgId();
    const body = (req.body ?? {}) as { reason?: string };
    const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1))[0];
    if (!lead || !lead.email) return { ok: false, error: 'no_email' };
    await db.insert(schema.suppressions).values({
      orgId, email: lead.email, scope: 'org',
      reason: body.reason ?? 'manual', sourceEvent: 'manual',
    }).onConflictDoNothing();
    await db.update(schema.leads).set({ status: 'dnc' }).where(eq(schema.leads.id, id));
    return { ok: true };
  });

  app.post('/api/leads/import-csv', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const body = (req.body ?? {}) as { csv?: string };
    if (!body.csv) return { ok: false, error: 'missing_csv' };
    const rows = parseCsv(body.csv, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
    let inserted = 0, skipped = 0, disqualified = 0;
    for (const r of rows) {
      const c = {
        name: r.name ?? r.business ?? '', email: r.email ?? null, phone: r.phone ?? null,
        website: r.website ?? null, address: r.address ?? null,
        city: r.city ?? null, state: (r.state ?? '').toUpperCase().slice(0, 2) || null,
        postalCode: r.postal_code ?? r.zip ?? null,
        niche: (r.niche ?? 'Septic') as 'Septic', source: 'csv',
        sourceExternalId: null,
      };
      const hf = hardFilter({ candidate: c as any, niche: c.niche });
      if (!hf.ok) { disqualified++; continue; }
      const phone = classifyPhone(c.phone);
      const scored = scoreLead({
        niche: c.niche,
        webPresenceLevel: c.website ? 'basic' : 'none',
        hasPhone: !!c.phone,
        phoneLineType: phone.lineType,
        hasOnlineBooking: false, isStormZone: false,
        licenseStatus: 'unknown',
        reviewCount30d: null, reviewRating: null, competitorDensity: null,
        ownerOperator: phone.lineType === 'mobile',
        serviceDispatchModel: true,
        emergencyNiche: ['Septic','Water/Mold','HVAC','Plumber','Towing'].includes(c.niche),
        multiLocation: false, isFranchise: false, isResidentialAddress: false, deadDomain: false,
      }, SCORING_VERSION_V1);
      try {
        await db.insert(schema.leads).values({
          orgId, name: c.name, email: c.email, phone: c.phone,
          website: c.website, address: c.address, city: c.city, state: c.state, postalCode: c.postalCode,
          niche: c.niche, source: 'csv', status: 'new',
          score: scored.score, scoringVersion: scored.scoringVersion, confidence: scored.confidence,
          disqualified: scored.disqualified, disqualificationReason: scored.disqualificationReason ?? null,
        });
        inserted++;
      } catch { skipped++; }
    }
    return { ok: true, inserted, skipped, disqualified };
  });

  /* ────────────── Campaigns ────────────── */
  app.post('/api/campaigns', async (req) => {
    const orgId = await singleOrgId();
    const b = req.body as any;
    const { id } = await createCampaign(getDb(), { orgId, ...b });
    return { ok: true, id };
  });

  app.get('/api/campaigns', async () => {
    const db = getDb();
    const id = await singleOrgId();
    const rows = await db.select().from(schema.campaigns).where(eq(schema.campaigns.orgId, id))
      .orderBy(desc(schema.campaigns.createdAt));
    return { ok: true, rows };
  });

  app.get('/api/campaigns/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1))[0];
    if (!camp) return { ok: false, error: 'not_found' };
    return { ok: true, campaign: camp };
  });

  app.post('/api/campaigns/:id/render-preview', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { leadId?: string };
    if (!body.leadId) return { ok: false, error: 'missing_lead' };
    const out = await renderPreview(getDb(), id, body.leadId);
    return { ok: true, ...out };
  });

  app.post('/api/campaigns/:id/launch', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { override?: { reason: string } };
    const camp = (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1))[0];
    if (!camp) return { ok: false, error: 'not_found' };
    if (camp.recipientCount === 0) {
      await buildRecipients(db, id);
    }
    /* Run the *full* Production Readiness Gate, not just the legacy gate. */
    const gate = await evaluateLaunchGate(db, {
      campaignId: id,
      bouncePausePct: cfg.bouncePausePct, complaintPausePct: cfg.complaintPausePct,
      seedlistTtlHours: 24 * 7,
    });
    if (!gate.ok && !body.override?.reason) {
      return { ok: false, gate };
    }
    if (!gate.ok && body.override?.reason) {
      await writeAudit('launch_override', id, { reason: body.override.reason, blockers: gate.checks.filter(c => c.state === 'fail') }, req);
    }
    await db.update(schema.campaigns).set({
      status: 'running', launchedAt: new Date(),
    }).where(eq(schema.campaigns.id, id));
    await writeAudit('launch', id, { name: camp.name, kind: camp.kind, recipients: camp.recipientCount, overridden: !!body.override?.reason }, req);
    const orgId2 = await singleOrgId();
    await emitEvent(db, orgId2, 'campaign.launched', 'campaign', id, {
      name: camp.name, kind: camp.kind, recipientCount: camp.recipientCount,
    });
    const sent = await sendBatch(db, { campaignId: id, maxToSend: cfg.queue.sendBatchSize });
    return { ok: true, gate, sent };
  });

  app.post('/api/campaigns/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    await getDb().update(schema.campaigns).set({ status: 'paused', pauseReason: 'manual' }).where(eq(schema.campaigns.id, id));
    await writeAudit('pause', id, { reason: 'manual' }, req);
    return { ok: true };
  });

  app.post('/api/campaigns/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    await getDb().update(schema.campaigns).set({ status: 'running', pauseReason: null }).where(eq(schema.campaigns.id, id));
    await writeAudit('resume', id, {}, req);
    return { ok: true };
  });

  app.get('/api/campaigns/:id/launch-gate', async (req) => {
    const { id } = req.params as { id: string };
    const gate = await evaluateLaunchGate(getDb(), {
      campaignId: id,
      bouncePausePct: cfg.bouncePausePct, complaintPausePct: cfg.complaintPausePct,
      seedlistTtlHours: 24 * 7,
    });
    return { ok: true, gate };
  });

  /* ────────────── Reply-branch outcomes ────────────── */
  app.post('/api/reply-branches/:id/won', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { outcomeType, revenueUsd } = (req.body ?? {}) as { outcomeType?: string; revenueUsd?: number };
    const db = getDb();
    const row = (await db.select({ id: schema.replyBranchStates.id })
      .from(schema.replyBranchStates)
      .where(eq(schema.replyBranchStates.id, id))
      .limit(1))[0];
    if (!row) return reply.code(404).send({ ok: false, error: 'not_found' });
    const rbsFull = (await db.select().from(schema.replyBranchStates).where(eq(schema.replyBranchStates.id, id)).limit(1))[0]!;
    await db.update(schema.replyBranchStates).set({
      node: 'won',
      wonAt: new Date(),
      wonOutcomeType: outcomeType ?? 'manual',
      wonRevenueUsd: revenueUsd ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.replyBranchStates.id, id));
    await writeAudit('reply_branch_won', id, { outcomeType: outcomeType ?? 'manual', revenueUsd: revenueUsd ?? null });
    await emitEvent(db, rbsFull.orgId, 'reply_branch.won', 'reply_branch', id, {
      leadId: rbsFull.leadId, campaignId: rbsFull.campaignId,
      outcomeType: outcomeType ?? 'manual', revenueUsd: revenueUsd ?? null,
    });
    if (rbsFull.leadId) {
      await emitEvent(db, rbsFull.orgId, 'lead.won', 'lead', rbsFull.leadId, {
        replyBranchId: id, outcomeType: outcomeType ?? 'manual', revenueUsd: revenueUsd ?? null,
      });
    }
    return { ok: true };
  });

  /* ────────────── Revenue attribution ────────────── */
  app.get('/api/revenue', async () => {
    const db = getDb();
    const orgId = await singleOrgId();

    const [funnelRows, wonRows] = await Promise.all([
      /* Funnel counts from campaign_recipients */
      db.select({
        state: schema.campaignRecipients.state,
        cnt: sql<number>`count(*)::int`,
      }).from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.orgId, orgId))
        .groupBy(schema.campaignRecipients.state),

      /* Won rows with optional revenue */
      db.select({
        id: schema.replyBranchStates.id,
        campaignId: schema.replyBranchStates.campaignId,
        leadId: schema.replyBranchStates.leadId,
        wonAt: schema.replyBranchStates.wonAt,
        wonOutcomeType: schema.replyBranchStates.wonOutcomeType,
        wonRevenueUsd: schema.replyBranchStates.wonRevenueUsd,
      }).from(schema.replyBranchStates)
        .where(and(
          eq(schema.replyBranchStates.orgId, orgId),
          eq(schema.replyBranchStates.node, 'won'),
        )),
    ]);

    const funnelMap: Record<string, number> = {};
    for (const r of funnelRows) funnelMap[r.state] = Number(r.cnt);

    /* Engaged = reply_branch_states rows currently in 'engaged' or beyond */
    const engagedCount = await db.select({ cnt: sql<number>`count(*)::int` })
      .from(schema.replyBranchStates)
      .where(and(
        eq(schema.replyBranchStates.orgId, orgId),
        sql`${schema.replyBranchStates.node} IN ('engaged','asked_for_info','scheduling','won')`,
      ));

    /* Revenue by campaign */
    const byCampaign: Record<string, { won: number; revenueUsd: number }> = {};
    for (const w of wonRows) {
      const cid = w.campaignId ?? 'unknown';
      if (!byCampaign[cid]) byCampaign[cid] = { won: 0, revenueUsd: 0 };
      byCampaign[cid].won++;
      byCampaign[cid].revenueUsd += w.wonRevenueUsd ?? 0;
    }

    /* Revenue by niche — join leads */
    const wonLeadIds = wonRows.map(w => w.leadId);
    const wonLeads = wonLeadIds.length > 0
      ? await db.select({ id: schema.leads.id, niche: schema.leads.niche })
          .from(schema.leads).where(inArray(schema.leads.id, wonLeadIds))
      : [];
    const leadNicheMap = new Map(wonLeads.map(l => [l.id, l.niche]));
    const byNiche: Record<string, { won: number; revenueUsd: number }> = {};
    for (const w of wonRows) {
      const niche = leadNicheMap.get(w.leadId) ?? 'unknown';
      if (!byNiche[niche]) byNiche[niche] = { won: 0, revenueUsd: 0 };
      byNiche[niche].won++;
      byNiche[niche].revenueUsd += w.wonRevenueUsd ?? 0;
    }

    return {
      ok: true,
      funnel: {
        sent: (funnelMap['sent'] ?? 0) + (funnelMap['delivered'] ?? 0),
        replied: funnelMap['replied'] ?? 0,
        engaged: Number(engagedCount[0]?.cnt ?? 0),
        won: wonRows.length,
      },
      wonRevenueUsd: wonRows.reduce((s, w) => s + (w.wonRevenueUsd ?? 0), 0),
      byCampaign: Object.entries(byCampaign).map(([id, v]) => ({ campaignId: id, ...v })),
      byNiche: Object.entries(byNiche).map(([niche, v]) => ({ niche, ...v })),
    };
  });

  /* ────────────── Audit log (paginated) ────────────── */
  app.get('/api/audit-log', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as { limit?: string; before?: string; action?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 200);
    const before = q.before ? new Date(q.before) : new Date();
    const conds = [
      eq(schema.auditLog.orgId, orgId),
      sql`${schema.auditLog.occurredAt} < ${before.toISOString()}`,
    ];
    if (q.action) conds.push(eq(schema.auditLog.action, q.action));
    const rows = await db.select().from(schema.auditLog)
      .where(and(...conds))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(limit);
    return { ok: true, rows, hasMore: rows.length === limit };
  });

  /* ────────────── Webhooks ────────────── */
  app.post('/api/webhooks/ses', async (req, reply) => {
    const orgId = await singleOrgId();
    /* Verify the SNS signature unless we're in sample mode or running tests. */
    const v = await verifySnsMessage(req.body as any, { skip: cfg.sampleMode });
    if (!v.valid) {
      app.log.warn({ reason: v.reason }, 'rejected unsigned SNS message');
      reply.code(400).send({ ok: false, error: v.reason ?? 'invalid_signature' });
      return;
    }
    return handleSesSns(getDb(), orgId, req.body);
  });

  app.post('/api/webhooks/inbound', async (req) => {
    const orgId = await singleOrgId();
    const adapter = new PostmarkInboundAdapter({
      enabled: cfg.postmarkInbound.enabled || cfg.sampleMode,
      basicAuthUser: cfg.postmarkInbound.basicUser || undefined,
      basicAuthPass: cfg.postmarkInbound.basicPass || undefined,
      webhookToken: cfg.postmarkInbound.token || undefined,
    });
    const ev = adapter.parseWebhook(req.body, req.headers as Record<string, string | string[] | undefined>);
    if (!ev) return { ok: false, error: 'invalid_inbound' };
    const r = await handleInboundReply(getDb(), orgId, ev);
    return { ok: true, ...r };
  });

  /* ────────────── Unsubscribe ────────────── */
  /* Health endpoint (no token) used by the DNS check to confirm the unsubscribe
     service is reachable from the public internet. */
  app.get('/api/unsubscribe/health', async (_req, reply) => {
    reply.code(200).send({ ok: true });
  });

  app.get('/api/unsubscribe/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const r = await processUnsubscribe(getDb(), token);
    reply.type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0c;color:#f4f4f0;padding:40px;max-width:560px;margin:auto}
.ok{color:#34d399}.err{color:#f87171}</style></head>
<body>
${r.ok
  ? `<h1>You\'ve been unsubscribed.</h1><p class="ok">We will not contact ${r.email ?? 'this address'} again.</p>`
  : `<h1>Unable to unsubscribe.</h1><p class="err">${r.reason ?? 'unknown error'}</p><p>Reply to any of our emails with "unsubscribe" and we will remove you within 2 days.</p>`
}
</body></html>`);
  });

  app.post('/api/unsubscribe', async (req, reply) => {
    /* RFC 8058 one-click POST. Body is application/x-www-form-urlencoded with
       `List-Unsubscribe=One-Click` plus our token in the query string. */
    const params = req.query as Record<string, string | undefined>;
    let token = params.token;
    if (!token) {
      const body = (req.body ?? {}) as Record<string, string>;
      token = body.token;
    }
    if (!token) return reply.code(400).send({ ok: false, error: 'missing_token' });
    const r = await processUnsubscribe(getDb(), token);
    return reply.send(r);
  });

  /* ────────────── Validation Mode ────────────── */
  app.post('/api/validation/experiments', async (req) => {
    const orgId = await singleOrgId();
    const b = req.body as any;
    const r = await createExperiment(getDb(), { orgId, ...b });
    await writeAudit('validation_experiment_create', r.id, { name: b?.name, phase: b?.phase, niche: b?.niche }, req);
    return { ok: true, id: r.id };
  });

  /**
   * Server-side experiment list. Filters: status, phase, niche, city, state,
   * fromDate, toDate. Sort: createdAt|status|phase. Paginated.
   */
  app.get('/api/validation/experiments', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as Record<string, string | undefined>;
    const conds = [eq(schema.validationExperiments.orgId, orgId)];
    if (q.status) conds.push(eq(schema.validationExperiments.status, q.status));
    if (q.phase)  conds.push(eq(schema.validationExperiments.phase, q.phase));
    if (q.niche)  conds.push(eq(schema.validationExperiments.niche, q.niche));
    if (q.fromDate) conds.push(gte(schema.validationExperiments.createdAt, new Date(q.fromDate)));
    const sortKey = (q.sort ?? 'createdAt');
    const order = sortKey === 'status' ? desc(schema.validationExperiments.status)
                : sortKey === 'phase'  ? desc(schema.validationExperiments.phase)
                : desc(schema.validationExperiments.createdAt);
    const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const rows = await db.select().from(schema.validationExperiments)
      .where(and(...conds)).orderBy(order).limit(limit).offset(offset);
    return { ok: true, rows, limit, offset };
  });

  app.get('/api/validation/experiments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const r = await experimentResults(getDb(), id);
    const verdict = await eyeballSummary(getDb(), id);
    return { ok: true, results: r, eyeball: verdict };
  });

  app.post('/api/validation/reviews', async (req) => {
    const b = req.body as { experimentId: string; leadId: string; rating: 'A'|'B'|'C'|'D'; reasonTags?: string[]; notes?: string };
    await recordReview(getDb(), b.experimentId, b.leadId, b.rating, b.reasonTags ?? [], b.notes);
    return { ok: true };
  });

  app.get('/api/validation/experiments/:id/signal-outcomes', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const exp = (await db.select().from(schema.validationExperiments).where(eq(schema.validationExperiments.id, id)).limit(1))[0];
    if (!exp || !exp.campaignId) return { ok: true, rows: [] };
    /* Build the signal-outcome matrix in one pass. */
    const rows = await db.execute(sql`
      SELECT
        cr.lead_id, cr.bucket, cr.state, cr.replied_at,
        l.name, l.niche, l.city, l.state AS lead_state, l.score,
        s.web_presence_level, s.is_storm_zone, s.license_status,
        s.review_count_30d, s.has_phone, s.has_online_booking, s.emergency_niche,
        im.auto_intent, im.manual_intent
      FROM campaign_recipients cr
      JOIN leads l ON l.id = cr.lead_id
      LEFT JOIN lead_signals s ON s.lead_id = l.id
      LEFT JOIN inbound_messages im ON im.recipient_id = cr.id
      WHERE cr.campaign_id = ${exp.campaignId}
    `);
    const list: any[] = (rows as any).rows ?? rows;
    return { ok: true, rows: list };
  });

  app.post('/api/validation/experiments/:id/create-stratified-campaign', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { templateKey: string; size: 'reach'|'engagement'; senderDomainId?: string };
    const orgId = await singleOrgId();
    const r = await buildStratifiedCampaign(getDb(), { orgId, experimentId: id, ...b });
    return { ok: true, ...r };
  });

  /* ────────────── Metrics ────────────── */
  app.get('/api/metrics/dashboard', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const totalLeads = (await db.select({ c: sql<number>`count(*)::int` })
      .from(schema.leads).where(and(eq(schema.leads.orgId, orgId), isNull(schema.leads.deletedAt))))[0]?.c ?? 0;
    const fresh = (await db.select({ c: sql<number>`count(*)::int` })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId),
                 gte(schema.leads.discoveredAt, new Date(Date.now() - 7 * 86400e3)))))[0]?.c ?? 0;
    const ev24 = await db.select({ t: schema.emailEvents.eventType, c: sql<number>`count(*)::int` })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.orgId, orgId),
                 gte(schema.emailEvents.occurredAt, new Date(Date.now() - 24 * 3600e3))))
      .groupBy(schema.emailEvents.eventType);
    const map = Object.fromEntries(ev24.map(r => [r.t, Number(r.c)]));
    return {
      ok: true,
      totals: { leads: totalLeads, freshLast7d: fresh },
      last24h: {
        sent: map.send ?? 0, delivered: map.delivered ?? 0,
        bounced: map.bounce ?? 0, complained: map.complaint ?? 0,
        replied: map.reply ?? 0, unsubscribed: map.unsubscribe ?? 0,
      },
      providers: {
        sampleMode: cfg.sampleMode,
        budgetMode: cfg.budgetMode,
      },
    };
  });

  app.get('/api/metrics/costs', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1); startOfMonth.setUTCHours(0, 0, 0, 0);
    const rows = await db.select({
      provider: schema.costEvents.provider, cents: sql<number>`sum(cost_cents)::int`,
    })
      .from(schema.costEvents)
      .where(and(eq(schema.costEvents.orgId, orgId), gte(schema.costEvents.occurredAt, startOfMonth)))
      .groupBy(schema.costEvents.provider);
    const breakdown = Object.fromEntries(rows.map(r => [r.provider, Number(r.cents) / 100]));
    const fixedInfra = 1.50 + 1.00; // Fly auto-stop + domain amortized
    const ses = 0.50;
    const bouncer = 0.40;
    const forecast = +(fixedInfra + ses + bouncer + Object.values(breakdown).reduce((a, b) => a + b, 0)).toFixed(2);
    return { ok: true, breakdown, forecast };
  });

  /** Provider-usage timeline (today + month-to-date counts and dollars per provider/SKU). */
  app.get('/api/provider-usage', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(today);
    startOfMonth.setUTCDate(1);

    const todayRows = await db.select({
      provider: schema.costEvents.provider, sku: schema.costEvents.sku,
      count: sql<number>`count(*)::int`,
      cents: sql<number>`sum(cost_cents)::int`,
    })
      .from(schema.costEvents)
      .where(and(eq(schema.costEvents.orgId, orgId), gte(schema.costEvents.occurredAt, today)))
      .groupBy(schema.costEvents.provider, schema.costEvents.sku);

    const monthRows = await db.select({
      provider: schema.costEvents.provider, sku: schema.costEvents.sku,
      count: sql<number>`count(*)::int`,
      cents: sql<number>`sum(cost_cents)::int`,
    })
      .from(schema.costEvents)
      .where(and(eq(schema.costEvents.orgId, orgId), gte(schema.costEvents.occurredAt, startOfMonth)))
      .groupBy(schema.costEvents.provider, schema.costEvents.sku);

    /* Last call timestamp per provider. */
    const lastCalls = await db.select({
      provider: schema.costEvents.provider,
      lastOccurredAt: sql<Date>`max(occurred_at)`,
    })
      .from(schema.costEvents)
      .where(eq(schema.costEvents.orgId, orgId))
      .groupBy(schema.costEvents.provider);

    const budgets = {
      bouncer_usd: cfg.bouncer.monthlyBudgetCents / 100,
      hunter_credits: cfg.hunter.monthlyFreeCredits,
      yelp_usd: cfg.yelp.monthlyBudgetUsd,
      places_usd: cfg.places.monthlyBudgetUsd,
    };

    const providersEnabled = {
      bouncer: cfg.bouncer.enabled,
      hunter:  cfg.hunter.enabled,
      yelp:    cfg.yelp.enabled,
      places:  cfg.places.enabled,
      ses:     cfg.ses.enabled,
    };

    return {
      ok: true,
      today: todayRows, month: monthRows,
      lastCalls,
      budgets,
      providersEnabled,
      sampleMode: cfg.sampleMode,
    };
  });

  app.get('/api/export/provider-usage.csv', async (_req, reply) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.costEvents)
      .where(eq(schema.costEvents.orgId, orgId))
      .orderBy(desc(schema.costEvents.occurredAt))
      .limit(20000);
    const headers = ['id','provider','sku','unitCount','costCents','leadId','campaignId','occurredAt'];
    csvResponse(reply, 'provider-usage.csv', toCsv(headers, rows.map(r => ({
      id: r.id, provider: r.provider, sku: r.sku,
      unitCount: r.unitCount, costCents: r.costCents,
      leadId: r.leadId ?? '', campaignId: r.campaignId ?? '',
      occurredAt: r.occurredAt?.toISOString() ?? '',
    }))));
  });

  /* ────────────── Suppressions ────────────── */
  app.get('/api/suppressions', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.suppressions)
      .where(sql`${schema.suppressions.scopeKey} IN (${orgId}, 'GLOBAL')`)
      .orderBy(desc(schema.suppressions.createdAt));
    return { ok: true, rows };
  });

  app.post('/api/suppressions/bulk', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const body = (req.body ?? {}) as { emails?: string[]; domains?: string[]; reason?: string };
    const reason = body.reason ?? 'manual_bulk';
    let inserted = 0;
    for (const email of (body.emails ?? [])) {
      const e = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+$/.test(e)) continue;
      await db.insert(schema.suppressions).values({
        orgId, email: e, scope: 'org', reason, sourceEvent: 'manual',
      }).onConflictDoNothing();
      inserted++;
    }
    for (const domain of (body.domains ?? [])) {
      const d = domain.toLowerCase().trim().replace(/^@/, '');
      if (!d) continue;
      await db.insert(schema.suppressions).values({
        orgId, domain: d, scope: 'domain', reason, sourceEvent: 'manual',
      }).onConflictDoNothing();
      inserted++;
    }
    await writeAudit('suppress_bulk', null, { inserted, emails: body.emails?.length ?? 0, domains: body.domains?.length ?? 0 }, req);
    return { ok: true, inserted };
  });

  app.post('/api/leads/:id/merge', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { intoLeadId?: string };
    if (!body.intoLeadId || body.intoLeadId === id) return { ok: false, error: 'invalid_target' };
    /* Soft-delete the duplicate. Reassignment of recipients/events is intentionally
       conservative — we only relink campaign_recipients that hadn't sent yet. */
    await db.update(schema.campaignRecipients)
      .set({ leadId: body.intoLeadId })
      .where(and(eq(schema.campaignRecipients.leadId, id), eq(schema.campaignRecipients.state, 'pending')));
    await db.update(schema.leads).set({ deletedAt: new Date(), notes: sql`coalesce(${schema.leads.notes}, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('merged_into', ${body.intoLeadId}::text, 'at', now()))` }).where(eq(schema.leads.id, id));
    await writeAudit('lead_merge', id, { intoLeadId: body.intoLeadId }, req);
    return { ok: true };
  });

  /* ────────────── Inbound list ────────────── */
  app.get('/api/inbound', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.inboundMessages)
      .where(eq(schema.inboundMessages.orgId, orgId))
      .orderBy(desc(schema.inboundMessages.receivedAt))
      .limit(200);
    return { ok: true, rows };
  });

  app.patch('/api/inbound/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { manualIntent?: string; triaged?: boolean; bookedDemo?: boolean };
    const update: Record<string, unknown> = {};
    if (b.manualIntent !== undefined) {
      update.manualIntent = b.manualIntent;
      update.classifierSource = 'manual';
    }
    if (b.triaged !== undefined) update.triaged = b.triaged;
    if (b.bookedDemo !== undefined) update.bookedDemo = b.bookedDemo;
    if (Object.keys(update).length === 0) return { ok: true, noop: true };
    await getDb().update(schema.inboundMessages).set(update as any).where(eq(schema.inboundMessages.id, id));
    await writeAudit('inbound_triage', id, update, req);
    return { ok: true };
  });

  /** Suppress the lead/domain associated with an inbound reply. */
  app.post('/api/inbound/:id/suppress', async (req) => {
    const db = getDb();
    const { id } = req.params as { id: string };
    const orgId = await singleOrgId();
    const body = (req.body ?? {}) as { scope?: 'email' | 'domain'; reason?: string };
    const msg = (await db.select().from(schema.inboundMessages).where(eq(schema.inboundMessages.id, id)).limit(1))[0];
    if (!msg) return { ok: false, error: 'not_found' };
    const email = msg.fromEmail.toLowerCase();
    if (body.scope === 'domain') {
      const domain = email.split('@')[1];
      await db.insert(schema.suppressions).values({
        orgId, domain, scope: 'domain', reason: body.reason ?? 'manual_inbound',
        sourceEvent: 'manual',
      }).onConflictDoNothing();
    } else {
      await db.insert(schema.suppressions).values({
        orgId, email, scope: 'org', reason: body.reason ?? 'manual_inbound',
        sourceEvent: 'manual',
      }).onConflictDoNothing();
    }
    if (msg.leadId) {
      await db.update(schema.leads).set({ status: 'dnc' }).where(eq(schema.leads.id, msg.leadId));
    }
    await writeAudit('suppress_from_inbound', id, { scope: body.scope ?? 'email' }, req);
    return { ok: true };
  });

  /* ────────────── Dead letter queue ────────────── */
  app.get('/api/dead-letters', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as { limit?: string; includeReplayed?: string };
    const conds = [eq(schema.deadLetters.orgId, orgId)];
    if (q.includeReplayed !== 'true') conds.push(isNull(schema.deadLetters.replayedAt));
    const rows = await db.select().from(schema.deadLetters)
      .where(and(...conds))
      .orderBy(desc(schema.deadLetters.archivedAt))
      .limit(Math.min(Number(q.limit ?? 50) || 50, 200));
    return { ok: true, rows, total: rows.length };
  });

  app.post('/api/dead-letters/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const row = (await db.select().from(schema.deadLetters).where(eq(schema.deadLetters.id, id)).limit(1))[0];
    if (!row) return { ok: false, error: 'not_found' };
    if (!row.recipientId) return { ok: false, error: 'no_recipient' };
    if (!row.campaignId) return { ok: false, error: 'no_campaign' };

    /* Re-check the launch gate before resurrecting a DLQ'd recipient. The
       original launch passed the gate at campaign-launch time; circumstances
       can have changed (SES disabled, DNS regressed, seedlist stale,
       campaign paused). Refusing to replay onto a now-failing gate is the
       safer default — the operator can resolve the underlying blocker first
       and click replay again. */
    const gate = await evaluateLaunchGate(db, {
      campaignId: row.campaignId,
      bouncePausePct: cfg.bouncePausePct,
      complaintPausePct: cfg.complaintPausePct,
      seedlistTtlHours: 24 * 7,
    });
    /* Block on any of the "real send is unsafe" checks — the rest (e.g.
       per-campaign copy lint warnings) shouldn't gate an individual replay. */
    const BLOCKING_FOR_REPLAY = new Set([
      'sample_mode_off', 'outbound_configured', 'ses_production_access',
      'sender_domain_exists', 'spf_pass', 'dkim_pass', 'dmarc_pass',
      'unsub_reachable', 'physical_address_set', 'campaign_state',
    ]);
    const failing = gate.checks.filter(c => c.state === 'fail' && BLOCKING_FOR_REPLAY.has(c.code));
    if (failing.length > 0) {
      await writeAudit('dead_letter_replay_blocked', id, {
        recipientId: row.recipientId, blockers: failing.map(f => f.code),
      }, req);
      reply.code(412);
      return {
        ok: false,
        error: 'launch_gate_blocked',
        reason: 'replay_would_violate_launch_gate',
        blockers: failing.map(f => ({ key: f.code, message: f.label, howToFix: f.fix ?? null })),
      };
    }

    /* Reset the recipient back to pending so the next sendBatch tick picks it up. */
    await db.update(schema.campaignRecipients).set({
      state: 'pending', retryCount: 0, nextSendAt: null, skipReason: null,
    }).where(eq(schema.campaignRecipients.id, row.recipientId));
    await db.update(schema.deadLetters).set({
      replayedAt: new Date(),
      replayCount: sql`${schema.deadLetters.replayCount} + 1`,
    }).where(eq(schema.deadLetters.id, id));
    await writeAudit('dead_letter_replay', id, { recipientId: row.recipientId, replayCount: (row.replayCount ?? 0) + 1 }, req);
    return { ok: true };
  });

  /* ────────────── Sender mailbox reputation trend ────────────── */
  app.get('/api/sender-mailboxes/:id/reputation-trend', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const rows = await db.select({
      date: schema.senderReputationDaily.date,
      sent: schema.senderReputationDaily.sent,
      bounced: schema.senderReputationDaily.bounced,
      complained: schema.senderReputationDaily.complained,
      reputationScore: schema.senderReputationDaily.reputationScore,
    }).from(schema.senderReputationDaily)
      .where(eq(schema.senderReputationDaily.mailboxId, id))
      .orderBy(desc(schema.senderReputationDaily.date))
      .limit(14);
    const last3 = rows.slice(0, 3).map(r => r.reputationScore);
    const prev7 = rows.slice(3, 10).map(r => r.reputationScore);
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const avgRecent = avg(last3);
    const avgPrior = avg(prev7);
    const trend = (avgRecent !== null && avgPrior !== null) ? avgRecent - avgPrior : null;
    const direction = trend === null ? 'insufficient_data'
                    : trend > 3 ? 'improving'
                    : trend < -3 ? 'declining'
                    : 'stable';
    return { ok: true, rows, trend: { direction, deltaPoints: trend !== null ? Math.round(trend) : null, avgRecent, avgPrior } };
  });

  /* ────────────── Global operator dashboard ────────────── */
  app.get('/api/dashboard', async () => {
    const db = getDb();
    const orgId = await singleOrgId();

    const [
      campaignStatusRows,
      queueRow,
      dlqRow,
      mailboxRows,
      proposalRow,
      funnelRows,
      recentActivity,
      recentSignals,
    ] = await Promise.all([
      /* Campaign status breakdown */
      db.select({ status: schema.campaigns.status, cnt: sql<number>`count(*)::int` })
        .from(schema.campaigns).where(eq(schema.campaigns.orgId, orgId))
        .groupBy(schema.campaigns.status),

      /* Queue depth: pending campaign recipients */
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients)
        .where(and(eq(schema.campaignRecipients.orgId, orgId), eq(schema.campaignRecipients.state, 'pending'))),

      /* DLQ unresolved */
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(schema.deadLetters)
        .where(and(eq(schema.deadLetters.orgId, orgId), isNull(schema.deadLetters.replayedAt))),

      /* Mailbox health */
      db.select({
        state: schema.senderMailboxes.state,
        cnt: sql<number>`count(*)::int`,
        avgRep: sql<number>`avg(reputation_score)::int`,
      }).from(schema.senderMailboxes).where(eq(schema.senderMailboxes.orgId, orgId))
        .groupBy(schema.senderMailboxes.state),

      /* Pending scoring proposals */
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(schema.scoringProposals)
        .where(and(eq(schema.scoringProposals.orgId, orgId), eq(schema.scoringProposals.status, 'pending'))),

      /* Engagement funnel */
      db.select({ state: schema.campaignRecipients.state, cnt: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients).where(eq(schema.campaignRecipients.orgId, orgId))
        .groupBy(schema.campaignRecipients.state),

      /* Recent audit activity */
      db.select({ action: schema.auditLog.action, target: schema.auditLog.target, occurredAt: schema.auditLog.occurredAt })
        .from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))
        .orderBy(desc(schema.auditLog.occurredAt)).limit(10),

      /* Recent high-lift signal outcomes */
      db.select({
        signalKey: schema.signalOutcomes.signalKey,
        signalValue: schema.signalOutcomes.signalValue,
        nSent: schema.signalOutcomes.nSent,
        nReplied: schema.signalOutcomes.nReplied,
        nWon: schema.signalOutcomes.nWon,
        computedAt: schema.signalOutcomes.computedAt,
      }).from(schema.signalOutcomes).where(eq(schema.signalOutcomes.orgId, orgId))
        .orderBy(desc(schema.signalOutcomes.computedAt)).limit(5),
    ]);

    const campMap: Record<string, number> = {};
    for (const r of campaignStatusRows) campMap[r.status] = Number(r.cnt);
    const funnelMap: Record<string, number> = {};
    for (const r of funnelRows) funnelMap[r.state] = Number(r.cnt);

    return {
      ok: true,
      campaigns: {
        running: campMap.running ?? 0,
        paused: campMap.paused ?? 0,
        draft: campMap.draft ?? 0,
        completed: campMap.completed ?? 0,
        failed: campMap.failed ?? 0,
      },
      queue: {
        depth: Number(queueRow[0]?.cnt ?? 0),
        dlqUnresolved: Number(dlqRow[0]?.cnt ?? 0),
      },
      mailboxes: mailboxRows.map(m => ({
        state: m.state,
        count: Number(m.cnt),
        avgReputation: Number(m.avgRep ?? 0),
      })),
      scoring: {
        pendingProposals: Number(proposalRow[0]?.cnt ?? 0),
      },
      funnel: {
        pending: funnelMap.pending ?? 0,
        sent: (funnelMap.sent ?? 0) + (funnelMap.delivered ?? 0),
        replied: funnelMap.replied ?? 0,
        skipped: funnelMap.skipped ?? 0,
        failed: funnelMap.failed ?? 0,
      },
      recentSignals,
      recentActivity,
    };
  });

  /* ────────────── Domain events (event sourcing log) ────────────── */
  app.get('/api/domain-events', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as { aggregateType?: string; aggregateId?: string; limit?: string; before?: string };
    const conds = [eq(schema.domainEvents.orgId, orgId)];
    if (q.aggregateType) conds.push(eq(schema.domainEvents.aggregateType, q.aggregateType));
    if (q.aggregateId) conds.push(eq(schema.domainEvents.aggregateId, q.aggregateId));
    if (q.before) conds.push(lt(schema.domainEvents.occurredAt, new Date(q.before)));
    const rows = await db.select().from(schema.domainEvents)
      .where(and(...conds))
      .orderBy(desc(schema.domainEvents.occurredAt))
      .limit(Math.min(Number(q.limit ?? 50) || 50, 500));
    return { ok: true, rows, hasMore: rows.length === Math.min(Number(q.limit ?? 50) || 50, 500) };
  });

  /* ────────────── Misc helpers ────────────── */
  app.get('/api/niches', async () => ({ ok: true, niches: ALL_NICHES }));

  /* ────────────── System Diagnostics ────────────── */
  /**
   * `/api/ready` returns 200 only when every required launch-gate check
   * passes. Until then it returns 503 with the full list of blockers so the
   * operator (and any external monitor — Fly's own health checker, an
   * uptime tool, Cloudflare cron) can read the JSON and know exactly which
   * setup step is incomplete.
   *
   * `safeToUseForSetup` is the explicit "yes, the app is fine to click
   * around in even though real send is off" signal. It is true when:
   *   - DB is reachable
   *   - migrations are applied
   *   - sample mode is off (we're in real production code paths)
   *   - SES is off (so no real send can happen)
   * It does NOT imply real sending is allowed.
   */
  app.get('/api/ready', async (_req, reply) => {
    const timestamp = new Date().toISOString();
    try {
      const d = await runDiagnostics();
      const blockers = d.gate.checks
        .filter(c => c.state === 'fail')
        .map(c => ({
          key: c.code,
          status: c.state,
          message: c.detail ? `${c.label} — ${c.detail}` : c.label,
          howToFix: c.fix ?? null,
          docs: c.docs ?? null,
        }));
      const safeToUseForSetup =
        d.db === 'connected' && d.migrations.current && !cfg.sampleMode && !cfg.ses.enabled && !cfg.resend.enabled;
      const ok = d.ok && blockers.length === 0;
      const payload = {
        ok,
        reason: ok ? null : 'launch_gate_blocked',
        blockingCount: blockers.length,
        warningCount: d.gate.warningCount,
        blockers,
        safeToUseForSetup,
        realOutboundEnabled: (cfg.ses.enabled || cfg.mailgun.enabled || cfg.resend.enabled) && !cfg.sampleMode,
        enableSes: cfg.ses.enabled || cfg.mailgun.enabled || cfg.resend.enabled,
        sampleMode: cfg.sampleMode,
        db: d.db,
        migrations: d.migrations,
        timestamp,
      };
      reply.code(ok ? 200 : 503);
      return payload;
    } catch (e: any) {
      reply.code(503);
      return {
        ok: false,
        reason: 'diagnostics_threw',
        error: e?.message ?? String(e),
        safeToUseForSetup: false,
        realOutboundEnabled: (cfg.ses.enabled || cfg.mailgun.enabled || cfg.resend.enabled) && !cfg.sampleMode,
        enableSes: cfg.ses.enabled || cfg.mailgun.enabled || cfg.resend.enabled,
        sampleMode: cfg.sampleMode,
        timestamp,
      };
    }
  });
  app.get('/api/diagnostics', async () => {
    const d = await runDiagnostics();
    return { ok: true, diagnostics: d };
  });
  app.get('/api/launch-gate', async () => {
    const gate = await evaluateLaunchGate(getDb(), {
      bouncePausePct: cfg.bouncePausePct, complaintPausePct: cfg.complaintPausePct,
      seedlistTtlHours: 24 * 7,
      systemDiagnostics: true,
    });
    return { ok: true, gate };
  });

  /* ────────────── First-run wizard ────────────── */
  app.get('/api/wizard/first-validation', async () => {
    const report = await generateWizard(getDb());
    return { ok: true, report };
  });
  app.put('/api/wizard/first-validation/notes', async (req) => {
    const orgId = await singleOrgId();
    const b = req.body as { stepKey?: string; notes?: string };
    if (!b.stepKey) return { ok: false, error: 'missing_stepKey' };
    await saveStepNotes(getDb(), orgId, b.stepKey, b.notes ?? '');
    return { ok: true };
  });

  /* ────────────── Audit log query ────────────── */
  app.get('/api/audit', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as Record<string, string | undefined>;
    const conds = [eq(schema.auditLog.orgId, orgId)];
    if (q.action) conds.push(eq(schema.auditLog.action, q.action));
    const rows = await db.select().from(schema.auditLog)
      .where(and(...conds))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(Math.min(Number(q.limit ?? 200) || 200, 1000));
    return { ok: true, rows };
  });

  /* ────────────── Queue metrics ────────────── */
  app.get('/api/queue/metrics', async () => {
    const { getQueue } = await import('./services/queue.js');
    try {
      const q = getQueue();
      const metrics = await q.sampleMetrics(getDb());
      return { ok: true, metrics };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get('/api/queue/snapshots', async (req) => {
    const db = getDb();
    const q = req.query as Record<string, string | undefined>;
    const rows = await db.select().from(schema.queueMetricsSnapshots)
      .orderBy(desc(schema.queueMetricsSnapshots.sampledAt))
      .limit(Math.min(Number(q.limit ?? 100) || 100, 1000));
    return { ok: true, rows };
  });

  /* ────────────── Sender mailboxes (rotation pool) ────────────── */
  app.get('/api/sender-mailboxes', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.senderMailboxes)
      .where(eq(schema.senderMailboxes.orgId, orgId))
      .orderBy(desc(schema.senderMailboxes.createdAt));
    return { ok: true, rows };
  });

  app.post('/api/sender-mailboxes', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const b = req.body as { senderDomainId: string; fromEmail: string; fromName: string; replyTo?: string; warmupPlanId?: string };
    if (!b.senderDomainId || !b.fromEmail || !b.fromName) return { ok: false, error: 'missing_required' };
    const r = await db.insert(schema.senderMailboxes).values({
      orgId, senderDomainId: b.senderDomainId,
      fromEmail: b.fromEmail.toLowerCase(),
      fromName: b.fromName, replyTo: b.replyTo?.toLowerCase() ?? null,
      warmupPlanId: b.warmupPlanId ?? null,
      state: 'warming',
    }).returning({ id: schema.senderMailboxes.id });
    await writeAudit('sender_mailbox_create', r[0]?.id ?? null, { fromEmail: b.fromEmail }, req);
    return { ok: true, id: r[0]?.id };
  });

  app.patch('/api/sender-mailboxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { state?: string; pauseReason?: string | null; warmupPlanId?: string | null };
    const allowed: Record<string, unknown> = {};
    if (b.state !== undefined) allowed.state = b.state;
    if (b.pauseReason !== undefined) allowed.pauseReason = b.pauseReason;
    if (b.warmupPlanId !== undefined) allowed.warmupPlanId = b.warmupPlanId;
    if (b.state === 'warming' || b.state === 'active') allowed.cooldownUntil = null;
    await getDb().update(schema.senderMailboxes).set(allowed as any).where(eq(schema.senderMailboxes.id, id));
    await writeAudit('sender_mailbox_update', id, allowed as Record<string, unknown>, req);
    return { ok: true };
  });

  /* ────────────── Warmup plans ────────────── */
  app.get('/api/warmup-plans', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.warmupPlans).where(eq(schema.warmupPlans.orgId, orgId));
    return { ok: true, rows };
  });

  app.post('/api/warmup-plans', async (req) => {
    const orgId = await singleOrgId();
    const b = req.body as { name: string; dailyCaps: number[]; pauseBouncePct?: number; pauseComplaintPct?: number; minReputationToAdvance?: number; isDefault?: boolean };
    if (!b.name || !Array.isArray(b.dailyCaps) || b.dailyCaps.length < 7) {
      return { ok: false, error: 'invalid_plan' };
    }
    const r = await getDb().insert(schema.warmupPlans).values({
      orgId, name: b.name, dailyCaps: b.dailyCaps,
      pauseBouncePct: b.pauseBouncePct ?? 4,
      pauseComplaintPct: b.pauseComplaintPct ?? 0.1,
      minReputationToAdvance: b.minReputationToAdvance ?? 40,
      isDefault: !!b.isDefault,
    }).returning({ id: schema.warmupPlans.id });
    return { ok: true, id: r[0]?.id };
  });

  /* ────────────── Closed-loop scoring ────────────── */
  app.get('/api/scoring/proposals', async (req) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as Record<string, string | undefined>;
    const conds = [eq(schema.scoringProposals.orgId, orgId)];
    if (q.status) conds.push(eq(schema.scoringProposals.status, q.status));
    const rows = await db.select().from(schema.scoringProposals)
      .where(and(...conds))
      .orderBy(desc(schema.scoringProposals.proposedAt))
      .limit(Math.min(Number(q.limit ?? 50) || 50, 200));
    return { ok: true, rows };
  });

  app.post('/api/scoring/proposals/refresh', async (req) => {
    const orgId = await singleOrgId();
    const b = (req.body ?? {}) as { windowDays?: number };
    const agg = await aggregateSignalOutcomes(getDb(), orgId, b.windowDays ?? 30);
    const prop = await proposeScoringChanges(getDb(), orgId, b.windowDays ?? 30);
    await writeAudit('closed_loop_refresh', null, { windowDays: b.windowDays ?? 30, signals: agg.written, proposalId: prop.proposalId }, req);
    return { ok: true, signalsWritten: agg.written, proposalId: prop.proposalId, evidenceCount: prop.proposal.evidence.length };
  });

  app.post('/api/scoring/proposals/:id/apply', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string };
    const r = await applyScoringProposal(getDb(), id, { reason: b.reason });
    return r;
  });

  app.post('/api/scoring/proposals/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string };
    if (!b.reason) return { ok: false, error: 'missing_reason' };
    return rejectScoringProposal(getDb(), id, b.reason);
  });

  app.get('/api/scoring/versions', async () => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.scoringVersions)
      .where(eq(schema.scoringVersions.orgId, orgId))
      .orderBy(desc(schema.scoringVersions.id));
    return { ok: true, rows };
  });

  /* ────────────── License import (operator-driven) ────────────── */
  app.post('/api/licenses/import', async (req) => {
    const b = (req.body ?? {}) as { state?: string; niche?: string; csv?: string; sourceUrl?: string; sourceFile?: string };
    if (!b.state || !b.niche || !b.csv) return { ok: false, error: 'missing_required_fields' };
    const out = await importLicenseCsv(getDb(), {
      state: b.state.toUpperCase().slice(0, 2),
      niche: b.niche,
      csv: b.csv,
      sourceUrl: b.sourceUrl,
      sourceFile: b.sourceFile,
    });
    await writeAudit('licenses_import', `${b.state}/${b.niche}`, out as unknown as Record<string, unknown>, req);
    return { ok: true, ...out };
  });

  app.get('/api/licenses', async (req) => {
    const db = getDb();
    const q = req.query as Record<string, string | undefined>;
    const conds = [];
    if (q.state) conds.push(eq(schema.stateLicensees.state, q.state.toUpperCase().slice(0, 2)));
    if (q.niche) conds.push(eq(schema.stateLicensees.niche, q.niche));
    const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
    const rows = await db.select().from(schema.stateLicensees)
      .where(conds.length > 0 ? and(...conds) : undefined as any)
      .limit(limit);
    return { ok: true, rows };
  });

  /* ────────────── CSV exports ────────────── */
  /**
   * All exports respect the same filters as the corresponding list endpoints.
   * Every cell is run through csv-injection protection (`'` prefix on
   * =/+/-/@/tab leading characters).
   */
  app.get('/api/export/leads.csv', async (req, reply) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const q = req.query as Record<string, string | undefined>;
    const conds = [eq(schema.leads.orgId, orgId), isNull(schema.leads.deletedAt)];
    if (q.niche)  conds.push(eq(schema.leads.niche, q.niche));
    if (q.state)  conds.push(eq(schema.leads.state, q.state.toUpperCase().slice(0, 2)));
    if (q.status) conds.push(eq(schema.leads.status, q.status));
    const rows = await db.select().from(schema.leads)
      .where(and(...conds))
      .orderBy(desc(schema.leads.score))
      .limit(Math.min(Number(q.limit ?? 5000) || 5000, 20000));
    const headers = ['id','name','email','phone','website','address','city','state','postalCode','niche','source','status','score','scoringVersion','confidence','disqualified','disqualificationReason','emailVerificationStatus','discoveredAt','lastContactedAt'];
    const data = rows.map(r => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, website: r.website,
      address: r.address, city: r.city, state: r.state, postalCode: r.postalCode,
      niche: r.niche, source: r.source, status: r.status, score: r.score,
      scoringVersion: r.scoringVersion, confidence: r.confidence,
      disqualified: r.disqualified, disqualificationReason: r.disqualificationReason ?? '',
      emailVerificationStatus: r.emailVerificationStatus ?? '',
      discoveredAt: r.discoveredAt?.toISOString() ?? '',
      lastContactedAt: r.lastContactedAt?.toISOString() ?? '',
    }));
    csvResponse(reply, 'leads.csv', toCsv(headers, data));
  });

  app.post('/api/export/leads-selected.csv', async (req, reply) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const body = (req.body ?? {}) as { leadIds?: string[] };
    if (!body.leadIds || body.leadIds.length === 0) {
      reply.code(400).send({ ok: false, error: 'no_lead_ids' });
      return;
    }
    const rows = await db.select().from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId), inArray(schema.leads.id, body.leadIds)));
    const headers = ['id','name','email','phone','niche','city','state','score','status'];
    const data = rows.map(r => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, niche: r.niche,
      city: r.city, state: r.state, score: r.score, status: r.status,
    }));
    csvResponse(reply, 'leads-selected.csv', toCsv(headers, data));
  });

  app.get('/api/export/suppressions.csv', async (_req, reply) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.suppressions)
      .where(sql`${schema.suppressions.scopeKey} IN (${orgId}, 'GLOBAL')`)
      .orderBy(desc(schema.suppressions.createdAt));
    const headers = ['id','email','domain','scope','reason','sourceEvent','createdAt'];
    csvResponse(reply, 'suppressions.csv', toCsv(headers, rows.map(r => ({
      id: r.id, email: r.email ?? '', domain: r.domain ?? '', scope: r.scope,
      reason: r.reason, sourceEvent: r.sourceEvent ?? '',
      createdAt: r.createdAt?.toISOString() ?? '',
    }))));
  });

  app.get('/api/export/cost-events.csv', async (_req, reply) => {
    const db = getDb();
    const orgId = await singleOrgId();
    const rows = await db.select().from(schema.costEvents)
      .where(eq(schema.costEvents.orgId, orgId))
      .orderBy(desc(schema.costEvents.occurredAt));
    const headers = ['id','provider','sku','unitCount','costCents','leadId','campaignId','occurredAt'];
    csvResponse(reply, 'cost-events.csv', toCsv(headers, rows.map(r => ({
      id: r.id, provider: r.provider, sku: r.sku,
      unitCount: r.unitCount, costCents: r.costCents,
      leadId: r.leadId ?? '', campaignId: r.campaignId ?? '',
      occurredAt: r.occurredAt?.toISOString() ?? '',
    }))));
  });

  app.get('/api/export/campaign-recipients/:campaignId.csv', async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const db = getDb();
    const rows = await db.select({
      id: schema.campaignRecipients.id,
      leadId: schema.campaignRecipients.leadId,
      bucket: schema.campaignRecipients.bucket,
      state: schema.campaignRecipients.state,
      providerMessageId: schema.campaignRecipients.providerMessageId,
      renderedSubject: schema.campaignRecipients.renderedSubject,
      firstSentAt: schema.campaignRecipients.firstSentAt,
      repliedAt: schema.campaignRecipients.repliedAt,
      bouncedAt: schema.campaignRecipients.bouncedAt,
      skipReason: schema.campaignRecipients.skipReason,
    }).from(schema.campaignRecipients).where(eq(schema.campaignRecipients.campaignId, campaignId));
    const headers = ['id','leadId','bucket','state','providerMessageId','renderedSubject','firstSentAt','repliedAt','bouncedAt','skipReason'];
    csvResponse(reply, `campaign-${campaignId}-recipients.csv`, toCsv(headers, rows.map(r => ({
      ...r,
      renderedSubject: r.renderedSubject ?? '',
      providerMessageId: r.providerMessageId ?? '',
      firstSentAt: r.firstSentAt?.toISOString() ?? '',
      repliedAt: r.repliedAt?.toISOString() ?? '',
      bouncedAt: r.bouncedAt?.toISOString() ?? '',
      skipReason: r.skipReason ?? '',
    }))));
  });

  app.get('/api/export/validation-reviews/:experimentId.csv', async (req, reply) => {
    const { experimentId } = req.params as { experimentId: string };
    const db = getDb();
    const rows = await db.select().from(schema.validationReviews)
      .where(eq(schema.validationReviews.experimentId, experimentId));
    const headers = ['id','leadId','rating','reasonTags','notes','reviewedAt'];
    csvResponse(reply, `experiment-${experimentId}-reviews.csv`, toCsv(headers, rows.map(r => ({
      id: r.id, leadId: r.leadId, rating: r.rating,
      reasonTags: (r.reasonTags ?? []).join(';'),
      notes: r.notes ?? '',
      reviewedAt: r.reviewedAt?.toISOString() ?? '',
    }))));
  });

  /**
   * Signal-outcome matrix export — the validation-plan-ready CSV.
   * Columns match docs/VALIDATION-MODE.md and the 30-day spreadsheet template.
   */
  app.get('/api/export/signal-outcome/:experimentId.csv', async (req, reply) => {
    const db = getDb();
    const { experimentId } = req.params as { experimentId: string };
    const exp = (await db.select().from(schema.validationExperiments).where(eq(schema.validationExperiments.id, experimentId)).limit(1))[0];
    if (!exp || !exp.campaignId) {
      reply.code(404).send({ ok: false, error: 'experiment_has_no_campaign' });
      return;
    }
    const res = await db.execute(sql`
      SELECT
        l.id AS lead_id, l.name AS business_name, l.niche, l.city, l.state, l.score,
        cr.bucket,
        (s.web_presence_level = 'none')         AS no_website,
        (s.web_presence_level = 'social_only')  AS social_only,
        (s.web_presence_level = 'gbp_only')     AS gbp_only,
        coalesce(s.is_storm_zone, false)        AS storm_zone,
        (s.license_status = 'active')           AS license_active,
        CASE WHEN s.review_count_30d IS NULL THEN ''
             WHEN s.review_count_30d <= 1 THEN 'low'
             WHEN s.review_count_30d >= 8 THEN 'high'
             ELSE 'mid' END                     AS review_velocity_bucket,
        coalesce(s.has_phone, false)            AS has_phone,
        coalesce(s.has_online_booking, false)   AS has_online_booking,
        (cr.state IN ('sent','delivered','replied','bounced','complained'))  AS sent,
        (cr.state IN ('delivered','replied'))                                AS delivered,
        (cr.state = 'bounced')                                               AS bounced,
        (cr.state = 'replied')                                               AS replied,
        coalesce(im.manual_intent, im.auto_intent, '')                       AS reply_intent,
        (coalesce(im.manual_intent, im.auto_intent) IN ('interested','conditional','referral'))
                                                                              AS qualified_reply,
        false                                                                 AS booked_demo,
        coalesce(
          (SELECT sum(cost_cents)::int FROM cost_events ce WHERE ce.lead_id = l.id), 0
        ) / 100.0                                                             AS cost_usd
      FROM campaign_recipients cr
      JOIN leads l ON l.id = cr.lead_id
      LEFT JOIN lead_signals s ON s.lead_id = l.id
      LEFT JOIN inbound_messages im ON im.recipient_id = cr.id
      WHERE cr.campaign_id = ${exp.campaignId}
      ORDER BY l.score DESC
    `);
    const rows: any[] = (res as any).rows ?? res;
    const headers = [
      'lead_id','business_name','niche','city','state','score','bucket',
      'no_website','social_only','gbp_only','storm_zone','license_active',
      'review_velocity_bucket','has_phone','has_online_booking',
      'sent','delivered','bounced','replied','reply_intent','qualified_reply','booked_demo','cost_usd',
    ];
    csvResponse(reply, `signal-outcomes-${experimentId}.csv`, toCsv(headers, rows));
  });
}
