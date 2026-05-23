CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"ip" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"bucket" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"next_send_at" timestamp with time zone,
	"rendered_subject" text,
	"rendered_body" text,
	"variant_seed" bigint,
	"slot_key" text,
	"provider_message_id" text,
	"first_sent_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"skip_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_key" text NOT NULL,
	"subject_a" text DEFAULT '' NOT NULL,
	"subject_b" text,
	"audience_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"bounced_count" integer DEFAULT 0 NOT NULL,
	"complained_count" integer DEFAULT 0 NOT NULL,
	"replied_count" integer DEFAULT 0 NOT NULL,
	"unsub_count" integer DEFAULT 0 NOT NULL,
	"daily_cap" integer DEFAULT 50 NOT NULL,
	"send_speed_per_min" integer DEFAULT 20 NOT NULL,
	"sender_domain_id" uuid,
	"validation_experiment_id" uuid,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sku" text NOT NULL,
	"unit_count" integer DEFAULT 1 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"lead_id" uuid,
	"campaign_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"niche" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"radius_km" double precision,
	"target_count" integer DEFAULT 25 NOT NULL,
	"source_mix" jsonb DEFAULT '["osm"]'::jsonb NOT NULL,
	"cron" text,
	"validation_experiment_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid,
	"recipient_id" uuid,
	"lead_id" uuid,
	"event_type" text NOT NULL,
	"bounce_type" text,
	"provider_message_id" text,
	"diagnostic" text,
	"raw_payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid,
	"campaign_id" uuid,
	"recipient_id" uuid,
	"provider_message_id" text,
	"from_email" "citext" NOT NULL,
	"to_email" "citext",
	"subject" text,
	"text_body" text,
	"html_body" text,
	"auto_intent" text,
	"manual_intent" text,
	"classifier_source" text DEFAULT 'regex' NOT NULL,
	"booked_demo" boolean DEFAULT false NOT NULL,
	"is_auto_reply" boolean DEFAULT false NOT NULL,
	"triaged" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lock_token" text,
	"locked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_signals" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"web_presence_level" text DEFAULT 'unknown' NOT NULL,
	"web_evidence" jsonb,
	"has_phone" boolean DEFAULT false NOT NULL,
	"phone_line_type" text,
	"has_online_booking" boolean DEFAULT false NOT NULL,
	"is_storm_zone" boolean DEFAULT false NOT NULL,
	"storm_last_event" timestamp with time zone,
	"license_status" text,
	"license_expires_at" timestamp with time zone,
	"owner_operator_heuristic" boolean DEFAULT false NOT NULL,
	"service_dispatch_model" boolean DEFAULT false NOT NULL,
	"emergency_niche" boolean DEFAULT false NOT NULL,
	"review_count_30d" integer,
	"review_rating" double precision,
	"competitor_density" integer,
	"multi_location" boolean DEFAULT false NOT NULL,
	"is_franchise" boolean DEFAULT false NOT NULL,
	"is_residential_address" boolean DEFAULT false NOT NULL,
	"dead_domain" boolean DEFAULT false NOT NULL,
	"contributions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_source_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" "citext",
	"phone" text,
	"website" text,
	"domain" text,
	"address" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"niche" text NOT NULL,
	"source" text NOT NULL,
	"source_external_id" text,
	"status" text DEFAULT 'new' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"scoring_version" integer DEFAULT 1 NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_verification_status" text,
	"email_verification_source" text,
	"email_verification_cost_cents" integer DEFAULT 0 NOT NULL,
	"disqualified" boolean DEFAULT false NOT NULL,
	"disqualification_reason" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"dedup_email" "citext" GENERATED ALWAYS AS (lower(email)) STORED,
	"dedup_phone" text GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), 'D', '', 'g')) STORED,
	"dedup_domain" text GENERATED ALWAYS AS (regexp_replace(lower(coalesce(website,'')), '^https?://(www.)?|/.*$', '', 'g')) STORED,
	"dedup_name" text GENERATED ALWAYS AS (regexp_replace(lower(coalesce(name,'')), '[^a-z0-9]', '', 'g')) STORED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "noaa_storm_zones" (
	"postal_code" text NOT NULL,
	"event_type" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "noaa_storm_zones_postal_code_event_type_pk" PRIMARY KEY("postal_code","event_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"from_name" text,
	"from_email" "citext",
	"reply_to" "citext",
	"physical_address" text,
	"outreach_subdomain" text,
	"default_booking_link" text,
	"production_access_confirmed" boolean DEFAULT false NOT NULL,
	"budget_mode" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoring_versions" (
	"id" integer PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"weights" jsonb NOT NULL,
	"notes" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"measured_lift" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seedlist_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sender_domain_id" uuid,
	"mailbox" "citext" NOT NULL,
	"provider_message_id" text,
	"observed" text,
	"observed_at" timestamp with time zone,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sender_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"ses_configuration_set" text,
	"dkim_selectors" text[] DEFAULT ARRAY['s1','s2','s3']::text[] NOT NULL,
	"spf_expected_include" text DEFAULT 'amazonses.com' NOT NULL,
	"spf_status" text DEFAULT 'pending' NOT NULL,
	"dkim_status" text DEFAULT 'pending' NOT NULL,
	"dmarc_status" text DEFAULT 'pending' NOT NULL,
	"dmarc_policy" text,
	"mx_status" text DEFAULT 'pending' NOT NULL,
	"unsub_reachable" boolean DEFAULT false NOT NULL,
	"unsub_last_status" integer,
	"last_check_detail" jsonb,
	"last_checked_at" timestamp with time zone,
	"last_seedlist_test_at" timestamp with time zone,
	"last_seedlist_pass_at" timestamp with time zone,
	"warmup_state" text DEFAULT 'pending' NOT NULL,
	"warmup_day" integer DEFAULT 0 NOT NULL,
	"daily_send_budget" integer DEFAULT 50 NOT NULL,
	"per_domain_cap" integer DEFAULT 10 NOT NULL,
	"sends_today" integer DEFAULT 0 NOT NULL,
	"sends_today_date" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "state_licensees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"niche" text NOT NULL,
	"name" text NOT NULL,
	"license_number" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"city" text,
	"state_code" text,
	"postal_code" text,
	"phone" text,
	"source_url" text,
	"source_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_name" text GENERATED ALWAYS AS (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) STORED,
	"dedup_phone" text GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), 'D', '', 'g')) STORED,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"email" "citext",
	"domain" text,
	"scope" text DEFAULT 'org' NOT NULL,
	"reason" text NOT NULL,
	"source_event" text,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope_key" text GENERATED ALWAYS AS (coalesce(org_id::text, 'GLOBAL')) STORED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "validation_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phase" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"niche" text NOT NULL,
	"cities" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"template_key" text,
	"campaign_id" uuid,
	"kill_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verdict" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "validation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"reason_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"notes" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wizard_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"wizard_key" text NOT NULL,
	"step_key" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"detail" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sender_domain_id_sender_domains_id_fk" FOREIGN KEY ("sender_domain_id") REFERENCES "public"."sender_domains"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_validation_experiment_id_validation_experiments_id_fk" FOREIGN KEY ("validation_experiment_id") REFERENCES "public"."validation_experiments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_events" ADD CONSTRAINT "email_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_events" ADD CONSTRAINT "email_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_events" ADD CONSTRAINT "email_events_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_events" ADD CONSTRAINT "email_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_events" ADD CONSTRAINT "lead_source_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_events" ADD CONSTRAINT "lead_source_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scoring_versions" ADD CONSTRAINT "scoring_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seedlist_tests" ADD CONSTRAINT "seedlist_tests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seedlist_tests" ADD CONSTRAINT "seedlist_tests_sender_domain_id_sender_domains_id_fk" FOREIGN KEY ("sender_domain_id") REFERENCES "public"."sender_domains"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sender_domains" ADD CONSTRAINT "sender_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_experiments" ADD CONSTRAINT "validation_experiments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_experiments" ADD CONSTRAINT "validation_experiments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_reviews" ADD CONSTRAINT "validation_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_reviews" ADD CONSTRAINT "validation_reviews_experiment_id_validation_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."validation_experiments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "validation_reviews" ADD CONSTRAINT "validation_reviews_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wizard_progress" ADD CONSTRAINT "wizard_progress_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_occurred" ON "audit_log" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_action" ON "audit_log" USING btree ("org_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cr_campaign_lead" ON "campaign_recipients" USING btree ("campaign_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cr_next_send" ON "campaign_recipients" USING btree ("org_id","next_send_at") WHERE "campaign_recipients"."state" = 'queued';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_provider_month" ON "cost_events" USING btree ("provider","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ee_idempotency" ON "email_events" USING btree ("provider_message_id","event_type") WHERE "email_events"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ee_lead" ON "email_events" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ee_campaign" ON "email_events" USING btree ("campaign_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "im_provider_idem" ON "inbound_messages" USING btree ("provider_message_id") WHERE "inbound_messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jr_scheduled" ON "job_runs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lse_lead" ON "lead_source_events" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_org_email" ON "leads" USING btree ("org_id","dedup_email") WHERE "leads"."dedup_email" IS NOT NULL AND "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_org_phone" ON "leads" USING btree ("org_id","dedup_phone") WHERE length("leads"."dedup_phone") >= 7 AND "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_score" ON "leads" USING btree ("org_id","score") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_niche_score" ON "leads" USING btree ("org_id","niche","score") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_status" ON "leads" USING btree ("org_id","status") WHERE "leads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seedlist_domain" ON "seedlist_tests" USING btree ("sender_domain_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sender_domains_org_domain" ON "sender_domains" USING btree ("org_id","domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sl_state_niche_dedup" ON "state_licensees" USING btree ("state","niche","dedup_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sl_state_phone" ON "state_licensees" USING btree ("state","dedup_phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sl_unique_license" ON "state_licensees" USING btree ("state","license_number") WHERE "state_licensees"."license_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppressions_scope_email" ON "suppressions" USING btree ("scope_key","email") WHERE "suppressions"."email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppressions_scope_domain" ON "suppressions" USING btree ("scope_key","domain") WHERE "suppressions"."domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vr_exp_lead" ON "validation_reviews" USING btree ("experiment_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wp_unique" ON "wizard_progress" USING btree ("org_id","wizard_key","step_key");