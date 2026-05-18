/**
 * Keres AI — Drizzle schema (v3.2).
 *
 * Notes:
 *  - All tables are `org_id`-scoped where relevant. Single-tenant is enforced
 *    in code at boot; the FK pattern stays multi-tenant-ready.
 *  - `citext` extension is required (created in migration 0000_init.sql).
 *  - Generated columns power dedupe; partial indexes power soft-delete filters.
 *  - `email_events` is the only table whose (provider_message_id, event_type)
 *    pair must be globally unique to ensure idempotent webhook replays.
 *  - There is **no Yelp display field** anywhere in this schema — Yelp's TOS
 *    forbids caching most fields > 24h. A test in
 *    packages/providers/test/yelp-no-store.test.ts enforces this.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, integer, boolean, jsonb,
  primaryKey, uniqueIndex, index, check, bigint, doublePrecision,
} from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

/* citext type (the extension is created in migration 0000_init.sql). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/* ───── Organizations (single-tenant at MVP) ───── */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/Chicago'),
  fromName: text('from_name'),
  fromEmail: citext('from_email'),
  replyTo: citext('reply_to'),
  physicalAddress: text('physical_address'),
  outreachSubdomain: text('outreach_subdomain'),
  defaultBookingLink: text('default_booking_link'),
  productionAccessConfirmed: boolean('production_access_confirmed').notNull().default(false),
  budgetMode: text('budget_mode').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  budgetModeCheck: check('budget_mode_check', sql`${t.budgetMode} IN ('free','low','normal')`),
}));

/* ───── Users (operator accounts) ───── */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  fullName: text('full_name'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ───── Sender domains + DNS/warmup state ───── */
export const senderDomains = pgTable('sender_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  sesConfigurationSet: text('ses_configuration_set'),
  /** Authoritative DKIM selectors. Defaults to SES Easy DKIM's s1/s2/s3. */
  dkimSelectors: text('dkim_selectors').array().notNull().default(sql`ARRAY['s1','s2','s3']::text[]`),
  /** Expected SPF include directive (e.g. amazonses.com). */
  spfExpectedInclude: text('spf_expected_include').notNull().default('amazonses.com'),
  spfStatus: text('spf_status').notNull().default('pending'),
  dkimStatus: text('dkim_status').notNull().default('pending'),
  dmarcStatus: text('dmarc_status').notNull().default('pending'),
  dmarcPolicy: text('dmarc_policy'),                         // none|quarantine|reject
  mxStatus: text('mx_status').notNull().default('pending'),
  unsubReachable: boolean('unsub_reachable').notNull().default(false),
  unsubLastStatus: integer('unsub_last_status'),
  /** Latest full DNS detail snapshot (JSONB). */
  lastCheckDetail: jsonb('last_check_detail'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  /** Last time a seedlist test-send completed (any state). */
  lastSeedlistTestAt: timestamp('last_seedlist_test_at', { withTimezone: true }),
  /** Last successful seedlist test-send (used by the launch gate). */
  lastSeedlistPassAt: timestamp('last_seedlist_pass_at', { withTimezone: true }),
  warmupState: text('warmup_state').notNull().default('pending'),  // pending|warming|warmed|paused
  warmupDay: integer('warmup_day').notNull().default(0),
  dailySendBudget: integer('daily_send_budget').notNull().default(50),
  perDomainCap: integer('per_domain_cap').notNull().default(10),
  sendsToday: integer('sends_today').notNull().default(0),
  sendsTodayDate: text('sends_today_date'),                   // YYYY-MM-DD (UTC) — used to roll over
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqOrgDomain: uniqueIndex('sender_domains_org_domain').on(t.orgId, t.domain),
  spfCheck: check('spf_check', sql`${t.spfStatus} IN ('pending','pass','fail')`),
  dkimCheck: check('dkim_check', sql`${t.dkimStatus} IN ('pending','pass','fail')`),
  dmarcCheck: check('dmarc_check', sql`${t.dmarcStatus} IN ('pending','pass','fail')`),
  mxCheck: check('mx_check', sql`${t.mxStatus} IN ('pending','pass','fail')`),
  warmupCheck: check('warmup_check', sql`${t.warmupState} IN ('pending','warming','warmed','paused')`),
}));

/* ───── Leads ───── */
export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: citext('email'),
  phone: text('phone'),
  website: text('website'),
  domain: text('domain'),
  address: text('address'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  niche: text('niche').notNull(),
  source: text('source').notNull(),                          // 'osm'|'yelp'|'license'|'csv'|'manual'|'seed'
  sourceExternalId: text('source_external_id'),
  status: text('status').notNull().default('new'),           // new|uncontacted|contacted|replied|interested|booked|bounced|unsubscribed|dnc
  score: integer('score').notNull().default(0),
  scoringVersion: integer('scoring_version').notNull().default(1),
  confidence: doublePrecision('confidence').notNull().default(0.5),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  emailVerificationStatus: text('email_verification_status'),    // valid|catch_all|invalid|unverifiable_provider|skipped|unknown
  emailVerificationSource: text('email_verification_source'),    // syntax|mx|smtp|bouncer|hunter|disposable|skipped
  emailVerificationCostCents: integer('email_verification_cost_cents').notNull().default(0),
  disqualified: boolean('disqualified').notNull().default(false),
  disqualificationReason: text('disqualification_reason'),
  notes: jsonb('notes').notNull().default(sql`'[]'::jsonb`),
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /* generated dedupe keys */
  dedupEmail: citext('dedup_email').generatedAlwaysAs(sql`lower(email)`),
  dedupPhone: text('dedup_phone').generatedAlwaysAs(sql`regexp_replace(coalesce(phone, ''), '\D', '', 'g')`),
  dedupDomain: text('dedup_domain').generatedAlwaysAs(
    sql`regexp_replace(lower(coalesce(website,'')), '^https?://(www\.)?|/.*$', '', 'g')`,
  ),
  dedupName: text('dedup_name').generatedAlwaysAs(sql`regexp_replace(lower(coalesce(name,'')), '[^a-z0-9]', '', 'g')`),
}, t => ({
  statusCheck: check('lead_status_check',
    sql`${t.status} IN ('new','uncontacted','contacted','replied','interested','booked','bounced','unsubscribed','dnc')`),
  uniqOrgEmail: uniqueIndex('leads_org_email')
    .on(t.orgId, t.dedupEmail)
    .where(sql`${t.dedupEmail} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  uniqOrgPhone: uniqueIndex('leads_org_phone')
    .on(t.orgId, t.dedupPhone)
    .where(sql`length(${t.dedupPhone}) >= 7 AND ${t.deletedAt} IS NULL`),
  idxOrgScore: index('leads_org_score').on(t.orgId, t.score).where(sql`${t.deletedAt} IS NULL`),
  idxOrgNicheScore: index('leads_org_niche_score').on(t.orgId, t.niche, t.score).where(sql`${t.deletedAt} IS NULL`),
  idxOrgStatus: index('leads_org_status').on(t.orgId, t.status).where(sql`${t.deletedAt} IS NULL`),
}));

/* ───── Lead signals + evidence ───── */
export const leadSignals = pgTable('lead_signals', {
  leadId: uuid('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  webPresenceLevel: text('web_presence_level').notNull().default('unknown'),  // none|social_only|gbp_only|basic|modern|unknown
  webEvidence: jsonb('web_evidence'),
  hasPhone: boolean('has_phone').notNull().default(false),
  phoneLineType: text('phone_line_type'),                    // mobile|landline|voip|toll_free|unknown
  hasOnlineBooking: boolean('has_online_booking').notNull().default(false),
  isStormZone: boolean('is_storm_zone').notNull().default(false),
  stormLastEvent: timestamp('storm_last_event', { withTimezone: true }),
  licenseStatus: text('license_status'),                     // active|expired|suspended|unknown
  licenseExpiresAt: timestamp('license_expires_at', { withTimezone: true }),
  ownerOperatorHeuristic: boolean('owner_operator_heuristic').notNull().default(false),
  serviceDispatchModel: boolean('service_dispatch_model').notNull().default(false),
  emergencyNiche: boolean('emergency_niche').notNull().default(false),
  reviewCount30d: integer('review_count_30d'),
  reviewRating: doublePrecision('review_rating'),
  competitorDensity: integer('competitor_density'),
  multiLocation: boolean('multi_location').notNull().default(false),
  isFranchise: boolean('is_franchise').notNull().default(false),
  isResidentialAddress: boolean('is_residential_address').notNull().default(false),
  deadDomain: boolean('dead_domain').notNull().default(false),
  contributions: jsonb('contributions').notNull().default(sql`'[]'::jsonb`),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  webCheck: check('web_check', sql`${t.webPresenceLevel} IN ('none','social_only','gbp_only','basic','modern','unknown')`),
  licCheck: check('lic_check', sql`${t.licenseStatus} IS NULL OR ${t.licenseStatus} IN ('active','expired','suspended','unknown')`),
}));

/* ───── Source-event provenance ───── */
export const leadSourceEvents = pgTable('lead_source_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),                          // osm|yelp|license|csv|manual|seed|hunter|bouncer|scrape
  externalId: text('external_id'),
  payload: jsonb('payload'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxLead: index('lse_lead').on(t.leadId, t.occurredAt),
}));

/* ───── Suppressions ───── */
/**
 * Scope key (generated): coalesce(org_id::text, 'GLOBAL').
 * Unique index on (scope_key, email) lets us mix per-org and global rows
 * in a single table without breaking the v3 DDL bug of indexing a non-IMMUTABLE expression.
 */
export const suppressions = pgTable('suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  email: citext('email'),
  domain: text('domain'),
  scope: text('scope').notNull().default('org'),                  // org|global|domain
  reason: text('reason').notNull(),
  sourceEvent: text('source_event'),                              // hard_bounce|complaint|unsubscribe|manual|dnc|hostile_reply
  campaignId: uuid('campaign_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  scopeKey: text('scope_key').generatedAlwaysAs(sql`coalesce(org_id::text, 'GLOBAL')`),
}, t => ({
  scopeCheck: check('supp_scope_check', sql`${t.scope} IN ('org','global','domain')`),
  uniqEmailScope: uniqueIndex('suppressions_scope_email')
    .on(t.scopeKey, t.email)
    .where(sql`${t.email} IS NOT NULL`),
  uniqDomainScope: uniqueIndex('suppressions_scope_domain')
    .on(t.scopeKey, t.domain)
    .where(sql`${t.domain} IS NOT NULL`),
}));

/* ───── Scoring versions ───── */
export const scoringVersions = pgTable('scoring_versions', {
  id: integer('id').primaryKey(),                            // monotonically increasing integer
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  weights: jsonb('weights').notNull(),
  notes: text('notes'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  measuredLift: jsonb('measured_lift'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ───── Campaigns ───── */
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('standard'),         // standard|validation_reach|validation_engagement|validation_refine
  status: text('status').notNull().default('draft'),         // draft|ready|running|paused|completed|failed
  templateKey: text('template_key').notNull(),
  subjectA: text('subject_a').notNull().default(''),
  subjectB: text('subject_b'),
  audienceFilter: jsonb('audience_filter').notNull().default(sql`'{}'::jsonb`),
  recipientCount: integer('recipient_count').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  bouncedCount: integer('bounced_count').notNull().default(0),
  complainedCount: integer('complained_count').notNull().default(0),
  repliedCount: integer('replied_count').notNull().default(0),
  unsubCount: integer('unsub_count').notNull().default(0),
  dailyCap: integer('daily_cap').notNull().default(50),
  sendSpeedPerMin: integer('send_speed_per_min').notNull().default(20),
  senderDomainId: uuid('sender_domain_id').references(() => senderDomains.id, { onDelete: 'set null' }),
  validationExperimentId: uuid('validation_experiment_id'),
  pauseReason: text('pause_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  launchedAt: timestamp('launched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => ({
  statusCheck: check('campaign_status_check',
    sql`${t.status} IN ('draft','ready','running','paused','completed','failed')`),
  kindCheck: check('campaign_kind_check',
    sql`${t.kind} IN ('standard','validation_reach','validation_engagement','validation_refine')`),
}));

/* ───── Campaign recipients ───── */
export const campaignRecipients = pgTable('campaign_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  bucket: text('bucket'),                                    // top|mid|bottom|control|seedlist
  state: text('state').notNull().default('pending'),         // pending|queued|sent|delivered|bounced|complained|replied|skipped|failed
  nextSendAt: timestamp('next_send_at', { withTimezone: true }),
  renderedSubject: text('rendered_subject'),
  renderedBody: text('rendered_body'),
  variantSeed: bigint('variant_seed', { mode: 'bigint' }),
  slotKey: text('slot_key'),
  providerMessageId: text('provider_message_id'),
  firstSentAt: timestamp('first_sent_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  skipReason: text('skip_reason'),
}, t => ({
  uniqCampaignLead: uniqueIndex('cr_campaign_lead').on(t.campaignId, t.leadId),
  idxNextSend: index('cr_next_send').on(t.orgId, t.nextSendAt).where(sql`${t.state} = 'queued'`),
  stateCheck: check('cr_state_check',
    sql`${t.state} IN ('pending','queued','sent','delivered','bounced','complained','replied','skipped','failed')`),
  bucketCheck: check('cr_bucket_check',
    sql`${t.bucket} IS NULL OR ${t.bucket} IN ('top','mid','bottom','control','seedlist')`),
}));

/* ───── Email events (idempotent webhook sink) ───── */
export const emailEvents = pgTable('email_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').references(() => campaignRecipients.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),                  // send|delivered|bounce|complaint|reply|unsubscribe|reject|fail
  bounceType: text('bounce_type'),                          // hard|soft|null
  providerMessageId: text('provider_message_id'),
  diagnostic: text('diagnostic'),
  rawPayload: jsonb('raw_payload'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  eventTypeCheck: check('ee_event_check',
    sql`${t.eventType} IN ('send','delivered','bounce','complaint','reply','unsubscribe','reject','fail','open','click')`),
  uniqIdem: uniqueIndex('ee_idempotency')
    .on(t.providerMessageId, t.eventType)
    .where(sql`${t.providerMessageId} IS NOT NULL`),
  idxLead: index('ee_lead').on(t.leadId, t.occurredAt),
  idxCampaign: index('ee_campaign').on(t.campaignId, t.occurredAt),
}));

/* ───── Inbound messages (parsed replies) ───── */
export const inboundMessages = pgTable('inbound_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  recipientId: uuid('recipient_id').references(() => campaignRecipients.id, { onDelete: 'set null' }),
  providerMessageId: text('provider_message_id'),
  fromEmail: citext('from_email').notNull(),
  toEmail: citext('to_email'),
  subject: text('subject'),
  textBody: text('text_body'),
  htmlBody: text('html_body'),
  autoIntent: text('auto_intent'),                          // regex auto-classification
  manualIntent: text('manual_intent'),                      // operator override
  classifierSource: text('classifier_source').notNull().default('regex'),  // regex|manual|imported|future_ai
  bookedDemo: boolean('booked_demo').notNull().default(false),
  isAutoReply: boolean('is_auto_reply').notNull().default(false),
  triaged: boolean('triaged').notNull().default(false),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  autoIntentCheck: check('im_auto_intent_check',
    sql`${t.autoIntent} IS NULL OR ${t.autoIntent} IN ('interested','conditional','objection','not_interested_polite','not_interested_hostile','wrong_person','auto_reply','referral','bounce','unsubscribe','unknown')`),
  manualIntentCheck: check('im_manual_intent_check',
    sql`${t.manualIntent} IS NULL OR ${t.manualIntent} IN ('interested','conditional','objection','not_interested_polite','not_interested_hostile','wrong_person','auto_reply','referral','bounce','unsubscribe','unknown')`),
  uniqProvider: uniqueIndex('im_provider_idem')
    .on(t.providerMessageId)
    .where(sql`${t.providerMessageId} IS NOT NULL`),
}));

/* ───── Validation experiments ───── */
export const validationExperiments = pgTable('validation_experiments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phase: text('phase').notNull(),                           // eyeball|reach|engagement|refine
  status: text('status').notNull().default('running'),       // running|passed|tuned|failed|stopped
  niche: text('niche').notNull(),
  cities: text('cities').array().notNull().default(sql`ARRAY[]::text[]`),
  templateKey: text('template_key'),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  killCriteria: jsonb('kill_criteria').notNull().default(sql`'{}'::jsonb`),
  results: jsonb('results').notNull().default(sql`'{}'::jsonb`),
  verdict: text('verdict'),                                 // pass|tune|stop|null
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => ({
  phaseCheck: check('ve_phase_check', sql`${t.phase} IN ('eyeball','reach','engagement','refine')`),
  statusCheck: check('ve_status_check', sql`${t.status} IN ('running','passed','tuned','failed','stopped')`),
}));

/* ───── Validation reviews (Day 0 eyeball ratings) ───── */
export const validationReviews = pgTable('validation_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  experimentId: uuid('experiment_id').notNull().references(() => validationExperiments.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  rating: text('rating').notNull(),                         // A|B|C|D
  reasonTags: text('reason_tags').array().notNull().default(sql`ARRAY[]::text[]`),
  notes: text('notes'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ratingCheck: check('vr_rating_check', sql`${t.rating} IN ('A','B','C','D')`),
  uniqExpLead: uniqueIndex('vr_exp_lead').on(t.experimentId, t.leadId),
}));

/* ───── Cost events / provider usage ───── */
export const costEvents = pgTable('cost_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),                     // hunter|bouncer|ses|places|yelp|twilio|anthropic
  sku: text('sku').notNull(),
  unitCount: integer('unit_count').notNull().default(1),
  costCents: integer('cost_cents').notNull().default(0),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxProviderMonth: index('cost_provider_month').on(t.provider, t.occurredAt),
}));

/* ───── Discovery jobs (recurring configs) ───── */
export const discoveryJobs = pgTable('discovery_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  niche: text('niche').notNull(),
  city: text('city').notNull(),
  state: text('state').notNull(),
  radiusKm: doublePrecision('radius_km'),
  targetCount: integer('target_count').notNull().default(25),
  sourceMix: jsonb('source_mix').notNull().default(sql`'["osm"]'::jsonb`),
  cron: text('cron'),                                      // null = on-demand only
  validationExperimentId: uuid('validation_experiment_id').references(() => validationExperiments.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ───── Job runs (DB-backed queue) ───── */
export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),                            // discovery|send|verify|warmup|dns_check|noaa_refresh|cbp_refresh
  status: text('status').notNull().default('queued'),      // queued|running|done|failed
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  lockToken: text('lock_token'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
}, t => ({
  statusCheck: check('jr_status_check', sql`${t.status} IN ('queued','running','done','failed')`),
  idxScheduled: index('jr_scheduled').on(t.status, t.scheduledFor),
}));

/* ───── NOAA storm zones cache ───── */
export const noaaStormZones = pgTable('noaa_storm_zones', {
  postalCode: text('postal_code').notNull(),
  eventType: text('event_type').notNull(),
  eventCount: integer('event_count').notNull().default(0),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.postalCode, t.eventType] }),
}));

/* ───── State licensee cache ───── */
export const stateLicensees = pgTable('state_licensees', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull(),
  niche: text('niche').notNull(),
  name: text('name').notNull(),
  licenseNumber: text('license_number'),
  status: text('status').notNull(),                        // active|expired|suspended
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Optional address/phone published by the registry — used for matching. */
  city: text('city'),
  stateCode: text('state_code'),
  postalCode: text('postal_code'),
  phone: text('phone'),
  /** Provenance: source URL + manual import timestamp. */
  sourceUrl: text('source_url'),
  sourceFile: text('source_file'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  dedupName: text('dedup_name').generatedAlwaysAs(sql`regexp_replace(lower(name), '[^a-z0-9]', '', 'g')`),
  dedupPhone: text('dedup_phone').generatedAlwaysAs(sql`regexp_replace(coalesce(phone, ''), '\D', '', 'g')`),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxStateNicheName: index('sl_state_niche_dedup').on(t.state, t.niche, t.dedupName),
  idxStatePhone: index('sl_state_phone').on(t.state, t.dedupPhone),
  uniqStateLicense: uniqueIndex('sl_unique_license')
    .on(t.state, t.licenseNumber)
    .where(sql`${t.licenseNumber} IS NOT NULL`),
}));

/* ───── First-run wizard progress (server-persisted) ───── */
export const wizardProgress = pgTable('wizard_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  wizardKey: text('wizard_key').notNull(),
  stepKey: text('step_key').notNull(),
  completed: boolean('completed').notNull().default(false),
  notes: text('notes'),
  detail: jsonb('detail'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqOrgWizardStep: uniqueIndex('wp_unique').on(t.orgId, t.wizardKey, t.stepKey),
}));

/* ───── Seedlist test history (placement tracking) ───── */
export const seedlistTests = pgTable('seedlist_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  senderDomainId: uuid('sender_domain_id').references(() => senderDomains.id, { onDelete: 'cascade' }),
  mailbox: citext('mailbox').notNull(),
  providerMessageId: text('provider_message_id'),
  observed: text('observed'),                        // primary|promotions|spam|missing|null (pending)
  observedAt: timestamp('observed_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  observedCheck: check('seed_obs_check', sql`${t.observed} IS NULL OR ${t.observed} IN ('primary','promotions','spam','missing')`),
  idxDomain: index('seedlist_domain').on(t.senderDomainId, t.sentAt),
}));

/* ───── Audit log (campaign launches, suppression, overrides, scoring changes) ───── */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),                          // 'operator' for now (single-tenant)
  action: text('action').notNull(),                        // launch|pause|resume|override|suppress|unsuppress|settings|scoring_version|dns_check|test_send|...
  target: text('target'),                                  // freeform id (campaign uuid, lead uuid, etc.)
  detail: jsonb('detail'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxOccurred: index('audit_occurred').on(t.orgId, t.occurredAt),
  idxAction: index('audit_action').on(t.orgId, t.action),
}));
