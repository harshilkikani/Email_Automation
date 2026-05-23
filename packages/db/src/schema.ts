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
    sql`${t.status} IN ('new','uncontacted','contacted','replied','interested','booked','won','bounced','unsubscribed','dnc')`),
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
  /** Which mailbox sent this — populated by the rotation pool when the send completes. */
  senderMailboxId: uuid('sender_mailbox_id'),
  firstSentAt: timestamp('first_sent_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  skipReason: text('skip_reason'),
  retryCount: integer('retry_count').notNull().default(0),
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

/* ═════════════════════════════════════════════════════════════════════════
   v3.3 ADDITIONS — closed-loop scoring, per-mailbox warmup/rotation,
   website intel, branching replies, seasonal/saturation scoring, queue
   metrics, and offline AI runs.
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Per-mailbox sender (the actual From: address). A `sender_domain` can host
 * many mailboxes (info@, hello@, founder@) and the rotator picks one per send.
 * Reputation tracking, warmup curve, and throttling live at this granularity.
 */
export const senderMailboxes = pgTable('sender_mailboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  senderDomainId: uuid('sender_domain_id').notNull().references(() => senderDomains.id, { onDelete: 'cascade' }),
  fromEmail: citext('from_email').notNull(),
  fromName: text('from_name').notNull(),
  replyTo: citext('reply_to'),
  /** Lifecycle: provisioning → warming → active → paused (auto or manual) → retired. */
  state: text('state').notNull().default('provisioning'),
  /** Reputation score 0..100; blended bounce/complaint/seedlist/age. */
  reputationScore: integer('reputation_score').notNull().default(50),
  /** Day index inside the warmup plan (0 = pre-warmup). */
  warmupDay: integer('warmup_day').notNull().default(0),
  /** Today's send count + UTC date string (used for daily rollover). */
  sendsToday: integer('sends_today').notNull().default(0),
  sendsTodayDate: text('sends_today_date'),
  /** Hourly token bucket: how many sends remain this hour. Refilled by scheduler. */
  hourlyTokens: integer('hourly_tokens').notNull().default(0),
  hourlyTokensRefilledAt: timestamp('hourly_tokens_refilled_at', { withTimezone: true }),
  /** Cooldown until: rotator will skip until after this timestamp. */
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  /** Last time the rotator selected this mailbox — used for least-recently-used policy. */
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  /** Pause cause; null when active/warming. */
  pauseReason: text('pause_reason'),
  /** Per-mailbox warmup plan reference; null = inherits domain default. */
  warmupPlanId: uuid('warmup_plan_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  stateCheck: check('sm_state_check', sql`${t.state} IN ('provisioning','warming','active','paused','retired')`),
  uniqOrgEmail: uniqueIndex('sender_mailboxes_org_email').on(t.orgId, t.fromEmail),
  idxOrgDomainState: index('sender_mailboxes_domain_state').on(t.senderDomainId, t.state),
}));

/**
 * Daily reputation rollup per mailbox. One row per (mailbox, date). The
 * warmup engine reads the last N days to decide ramp/pause.
 */
export const senderReputationDaily = pgTable('sender_reputation_daily', {
  mailboxId: uuid('mailbox_id').notNull().references(() => senderMailboxes.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),                             // YYYY-MM-DD (UTC)
  sent: integer('sent').notNull().default(0),
  delivered: integer('delivered').notNull().default(0),
  bounced: integer('bounced').notNull().default(0),
  complained: integer('complained').notNull().default(0),
  replied: integer('replied').notNull().default(0),
  unsubscribed: integer('unsubscribed').notNull().default(0),
  seedlistInbox: integer('seedlist_inbox').notNull().default(0),
  seedlistSpam: integer('seedlist_spam').notNull().default(0),
  /** End-of-day reputation snapshot for this mailbox. */
  reputationScore: integer('reputation_score').notNull().default(50),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.mailboxId, t.date] }),
  idxDate: index('srd_date').on(t.date),
}));

/**
 * Warmup plan: describes the daily-cap ramp curve. Multiple plans can exist
 * (e.g. `conservative-28d`, `aggressive-14d`). Mailboxes reference one.
 */
export const warmupPlans = pgTable('warmup_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Ordered array of daily caps; index = warmupDay. Last value = steady state. */
  dailyCaps: integer('daily_caps').array().notNull(),
  /** Bounce % above which the mailbox auto-pauses during warmup. */
  pauseBouncePct: doublePrecision('pause_bounce_pct').notNull().default(4),
  /** Complaint % above which it auto-pauses. */
  pauseComplaintPct: doublePrecision('pause_complaint_pct').notNull().default(0.1),
  /** Minimum reputation score to proceed to the next day. */
  minReputationToAdvance: integer('min_reputation_to_advance').notNull().default(40),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqOrgName: uniqueIndex('warmup_plans_org_name').on(t.orgId, t.name),
}));

/**
 * Market saturation tracker. Rolling counts per (niche, postalCode, windowEndDate).
 * The aggregator (daily tick) refreshes this from email_events.
 */
export const marketSaturation = pgTable('market_saturation', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  niche: text('niche').notNull(),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  /** End of the rolling window (UTC date). */
  windowEndDate: text('window_end_date').notNull(),
  rollingDays: integer('rolling_days').notNull(),
  /** Distinct leads in this geo+niche we've sent to in the window. */
  sentLeads: integer('sent_leads').notNull().default(0),
  /** Total eligible leads in this geo+niche regardless of contact state. */
  eligibleLeads: integer('eligible_leads').notNull().default(0),
  /** sentLeads / eligibleLeads * 100, decayed via e^(-t/tau). */
  saturationPct: doublePrecision('saturation_pct').notNull().default(0),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqGeoWindow: uniqueIndex('ms_geo_window').on(t.orgId, t.niche, t.postalCode, t.windowEndDate, t.rollingDays),
  idxNicheGeo: index('ms_niche_geo').on(t.orgId, t.niche, t.city, t.state),
}));

/**
 * Signal-outcome aggregation: closed-loop scoring's source of truth. One row
 * per (signal, value, orgId). The aggregator walks email_events ⨝ inboundMessages
 * and counts how often each signal value led to a reply or qualified reply.
 */
export const signalOutcomes = pgTable('signal_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  signalKey: text('signal_key').notNull(),
  signalValue: text('signal_value').notNull(),              // stringified value bucket (true/false/low/high/...)
  windowDays: integer('window_days').notNull(),             // rolling window
  windowEndDate: text('window_end_date').notNull(),
  nObservations: integer('n_observations').notNull().default(0),
  nSent: integer('n_sent').notNull().default(0),
  nReplied: integer('n_replied').notNull().default(0),
  nQualified: integer('n_qualified').notNull().default(0),
  nBounced: integer('n_bounced').notNull().default(0),
  nComplained: integer('n_complained').notNull().default(0),
  nUnsubscribed: integer('n_unsubscribed').notNull().default(0),
  /** Lift (P(reply|signal=v) / P(reply|signal!=v)) for this value. NaN -> stored as null. */
  liftReply: doublePrecision('lift_reply'),
  liftQualified: doublePrecision('lift_qualified'),
  /** Revenue-weighted signal quality — from won deals associated with this signal bucket. */
  nWon: integer('n_won').notNull().default(0),
  totalRevenueUsd: doublePrecision('total_revenue_usd').notNull().default(0),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqSignalWindow: uniqueIndex('so_signal_window').on(t.orgId, t.signalKey, t.signalValue, t.windowDays, t.windowEndDate),
}));

/**
 * Scoring proposal — a candidate weight change generated by the closed-loop
 * proposer. Pending → applied (becomes a new scoringVersion) or rejected.
 */
export const scoringProposals = pgTable('scoring_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  baseVersionId: integer('base_version_id').notNull(),
  /** Map signalKey -> { weightKey, deltaPoints }. */
  deltas: jsonb('deltas').notNull(),
  /** Evidence: snapshot of signal_outcomes rows that motivated the proposal. */
  evidence: jsonb('evidence').notNull(),
  status: text('status').notNull().default('pending'),       // pending|applied|rejected|superseded
  /** When applied, the resulting scoring_versions id. */
  appliedVersionId: integer('applied_version_id'),
  notes: text('notes'),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, t => ({
  statusCheck: check('sp_status_check', sql`${t.status} IN ('pending','applied','rejected','superseded')`),
  idxOrgStatus: index('sp_org_status').on(t.orgId, t.status),
}));

/**
 * Website intelligence — deterministic facts pulled from a lead's website.
 * One row per lead. Refreshed on demand or by scheduler.
 */
export const websiteIntel = pgTable('website_intel', {
  leadId: uuid('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  homeUrl: text('home_url'),
  finalUrl: text('final_url'),
  /** HTTP status of the home page on the last probe. */
  httpStatus: integer('http_status'),
  /** Detected CMS / site builder. */
  techStack: text('tech_stack').array().notNull().default(sql`ARRAY[]::text[]`),
  /** Booking vendor (calendly|housecallpro|servicetitan|squarespace|acuity|other|null). */
  bookingVendor: text('booking_vendor'),
  /** Email addresses scraped from contact/about/footer. */
  emails: text('emails').array().notNull().default(sql`ARRAY[]::text[]`),
  /** Phone numbers scraped. */
  phones: text('phones').array().notNull().default(sql`ARRAY[]::text[]`),
  /** Social URLs (LinkedIn, Facebook, Instagram, Yelp profile, Google profile). */
  social: jsonb('social').notNull().default(sql`'{}'::jsonb`),
  /** Service list discovered (e.g. ["septic-pumping","drain-cleaning"]). */
  services: text('services').array().notNull().default(sql`ARRAY[]::text[]`),
  /** Discovered business hours as a free-form string ("Mon-Fri 8-5"). */
  hoursText: text('hours_text'),
  /** Address snippet found on the site (NOT geocoded). */
  addressText: text('address_text'),
  /** Years-in-business heuristic ("Since 1997" → 1997). */
  yearFounded: integer('year_founded'),
  /** Detected language. */
  language: text('language'),
  /** Free-form evidence (selectors hit, paths probed, etc.). */
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxOrgBooking: index('wi_org_booking').on(t.orgId, t.bookingVendor),
}));

/**
 * Reply-branch state machine progress per (campaign, lead). One row per
 * conversation thread.
 */
export const replyBranchStates = pgTable('reply_branch_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').references(() => campaignRecipients.id, { onDelete: 'cascade' }),
  /** FSM node id (awaiting_reply|engaged|asked_for_info|scheduling|won|lost|dormant). */
  node: text('node').notNull().default('awaiting_reply'),
  /** Last classifier output that drove a transition. */
  lastIntent: text('last_intent'),
  /** Number of follow-ups already sent on this thread. */
  followUpsSent: integer('follow_ups_sent').notNull().default(0),
  /** When to fire the next scheduled action (follow-up send, revisit, etc.). */
  nextActionAt: timestamp('next_action_at', { withTimezone: true }),
  /** What action to take at nextActionAt (e.g. "send_template:septic-followup-1"). */
  nextActionKind: text('next_action_kind'),
  nextActionPayload: jsonb('next_action_payload'),
  /** Trail: chronological list of transitions for audit/debug. */
  trail: jsonb('trail').notNull().default(sql`'[]'::jsonb`),
  /** Won-outcome tracking — populated when operator marks lead as won. */
  wonAt: timestamp('won_at', { withTimezone: true }),
  wonOutcomeType: text('won_outcome_type'),        // booked|call_scheduled|replied_yes|manual
  wonRevenueUsd: doublePrecision('won_revenue_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqCampaignLead: uniqueIndex('rbs_campaign_lead').on(t.campaignId, t.leadId),
  idxNextAction: index('rbs_next_action').on(t.nextActionAt).where(sql`${t.nextActionAt} IS NOT NULL`),
  nodeCheck: check('rbs_node_check',
    sql`${t.node} IN ('awaiting_reply','engaged','asked_for_info','scheduling','won','lost','dormant','suppressed')`),
  wonOutcomeCheck: check('rbs_won_outcome_check',
    sql`${t.wonOutcomeType} IS NULL OR ${t.wonOutcomeType} IN ('booked','call_scheduled','replied_yes','manual')`),
}));

/**
 * Niche seasonality config. Per niche, monthly multipliers + optional
 * weather-event amplifier.
 */
export const nicheSeasons = pgTable('niche_seasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  niche: text('niche').notNull(),
  /** 12-element array of multipliers (1.0 = neutral; 1.2 = +20%; 0.8 = -20%). Index 0 = January. */
  monthlyMultipliers: doublePrecision('monthly_multipliers').array().notNull(),
  /** Multiplier applied when a recent qualifying storm event hits the lead's postal code. */
  stormBoostMultiplier: doublePrecision('storm_boost_multiplier').notNull().default(1.0),
  /** Storm event types that trigger the boost (NOAA event_type strings). */
  stormEventTypes: text('storm_event_types').array().notNull().default(sql`ARRAY[]::text[]`),
  /** How recent the storm must be (days). */
  stormBoostWindowDays: integer('storm_boost_window_days').notNull().default(30),
  /** When `false`, scoring ignores this row. */
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqOrgNiche: uniqueIndex('ns_org_niche').on(t.orgId, t.niche),
  monthsLengthCheck: check('ns_months_len', sql`array_length(${t.monthlyMultipliers}, 1) = 12`),
}));

/**
 * Per-postal-code weather event overlay. Refreshed from NOAA. The scoring path
 * joins this to `noaa_storm_zones` for the seasonal scoring factor.
 */
export const nicheWeatherOverlays = pgTable('niche_weather_overlays', {
  id: uuid('id').primaryKey().defaultRandom(),
  postalCode: text('postal_code').notNull(),
  eventType: text('event_type').notNull(),
  /** Cumulative event score in the rolling window (per the niche-seasons config). */
  intensity: doublePrecision('intensity').notNull().default(0),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  uniqPostalEvent: uniqueIndex('nwo_postal_event').on(t.postalCode, t.eventType),
}));

/**
 * Snapshots of queue depth / lag / worker counts. Sampled by the scheduler so
 * the Observability page can render a queue health timeline.
 */
export const queueMetricsSnapshots = pgTable('queue_metrics_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tier: text('tier').notNull(),                              // 'db' | 'pg-boss'
  /** Counts by queue name and status. */
  counts: jsonb('counts').notNull(),
  /** Oldest queued job age in ms (across all queues). */
  oldestQueuedMs: integer('oldest_queued_ms'),
  /** Sampled at. */
  sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxSampled: index('qms_sampled').on(t.sampledAt),
}));

/**
 * Offline AI runs — every call into the pluggable AI adapter is recorded
 * here. Per-lead invocations are forbidden by code, but we still keep an
 * audit trail of every batch use (template-generation, reply-analysis,
 * weight-suggestion, intel-summarization).
 */
export const aiRuns = pgTable('ai_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** Adapter kind: noop|ollama|... */
  adapter: text('adapter').notNull(),
  /** Operation name: generate_template|analyze_replies|suggest_weights|summarize_intel */
  operation: text('operation').notNull(),
  /** SHA-256 of the redacted input payload (for dedupe + caching). */
  inputHash: text('input_hash').notNull(),
  /** Token counts / latency (provider-dependent). */
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  /** Result blob — for templates this is the new copy; for analyses it's a structured summary. */
  result: jsonb('result'),
  status: text('status').notNull().default('ok'),            // ok|error|rejected
  error: text('error'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  statusCheck: check('ai_runs_status_check', sql`${t.status} IN ('ok','error','rejected')`),
  opCheck: check('ai_runs_op_check',
    sql`${t.operation} IN ('generate_template','analyze_replies','suggest_weights','summarize_intel')`),
  idxOrgOccurred: index('ai_runs_org_occurred').on(t.orgId, t.occurredAt),
}));

/**
 * Dead letter queue — permanently-failed recipients after max retries are
 * archived here. Operators can replay individual items via the API.
 */
export const deadLetters = pgTable('dead_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  recipientId: uuid('recipient_id').references(() => campaignRecipients.id, { onDelete: 'set null' }),
  failReason: text('fail_reason').notNull(),
  lastError: text('last_error'),
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  replayedAt: timestamp('replayed_at', { withTimezone: true }),
  replayCount: integer('replay_count').notNull().default(0),
}, t => ({
  idxOrgArchived: index('dl_org_archived').on(t.orgId, t.archivedAt),
}));

/**
 * Per-niche per-UTC-hour send-time histograms. The scheduler refreshes these
 * from campaign_recipients to find which UTC hours yield the best reply rate.
 * sendBatch uses them to shift nextSendAt toward high-reply hours.
 */
export const sendTimeHistograms = pgTable('send_time_histograms', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  niche: text('niche').notNull(),
  utcHour: integer('utc_hour').notNull(),
  nSent: integer('n_sent').notNull().default(0),
  nReplied: integer('n_replied').notNull().default(0),
  replyRate: doublePrecision('reply_rate').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.orgId, t.niche, t.utcHour] }),
  hourCheck: check('sth_hour_check', sql`${t.utcHour} >= 0 AND ${t.utcHour} <= 23`),
}));

/**
 * Typed domain event log — append-only event sourcing layer. Each FSM
 * transition, campaign state change, scoring change, and revenue event is
 * written here for full auditability and future replay.
 */
export const domainEvents = pgTable('domain_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(), // campaign|lead|mailbox|scoring|reply_branch
  aggregateId: text('aggregate_id').notNull(),
  version: integer('version').notNull().default(1),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  correlationId: text('correlation_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  idxAgg: index('de_agg').on(t.orgId, t.aggregateType, t.aggregateId, t.occurredAt),
  idxCorr: index('de_corr').on(t.correlationId).where(sql`${t.correlationId} IS NOT NULL`),
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
