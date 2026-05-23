-- Keres AI v3.3 feature migration.
-- Adds: per-mailbox sender pool, daily reputation rollup, warmup plans,
-- market saturation tracker, signal-outcome aggregates, scoring proposals,
-- website intelligence, reply-branch FSM state, niche seasonality + weather
-- overlays, queue metrics snapshots, AI run audit.

CREATE TABLE IF NOT EXISTS "sender_mailboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sender_domain_id" uuid NOT NULL REFERENCES "sender_domains"("id") ON DELETE CASCADE,
  "from_email" citext NOT NULL,
  "from_name" text NOT NULL,
  "reply_to" citext,
  "state" text NOT NULL DEFAULT 'provisioning',
  "reputation_score" integer NOT NULL DEFAULT 50,
  "warmup_day" integer NOT NULL DEFAULT 0,
  "sends_today" integer NOT NULL DEFAULT 0,
  "sends_today_date" text,
  "hourly_tokens" integer NOT NULL DEFAULT 0,
  "hourly_tokens_refilled_at" timestamptz,
  "cooldown_until" timestamptz,
  "last_used_at" timestamptz,
  "pause_reason" text,
  "warmup_plan_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sm_state_check" CHECK ("state" IN ('provisioning','warming','active','paused','retired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "sender_mailboxes_org_email" ON "sender_mailboxes" ("org_id","from_email");
CREATE INDEX IF NOT EXISTS "sender_mailboxes_domain_state" ON "sender_mailboxes" ("sender_domain_id","state");

CREATE TABLE IF NOT EXISTS "sender_reputation_daily" (
  "mailbox_id" uuid NOT NULL REFERENCES "sender_mailboxes"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "sent" integer NOT NULL DEFAULT 0,
  "delivered" integer NOT NULL DEFAULT 0,
  "bounced" integer NOT NULL DEFAULT 0,
  "complained" integer NOT NULL DEFAULT 0,
  "replied" integer NOT NULL DEFAULT 0,
  "unsubscribed" integer NOT NULL DEFAULT 0,
  "seedlist_inbox" integer NOT NULL DEFAULT 0,
  "seedlist_spam" integer NOT NULL DEFAULT 0,
  "reputation_score" integer NOT NULL DEFAULT 50,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("mailbox_id","date")
);
CREATE INDEX IF NOT EXISTS "srd_date" ON "sender_reputation_daily" ("date");

CREATE TABLE IF NOT EXISTS "warmup_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "daily_caps" integer[] NOT NULL,
  "pause_bounce_pct" double precision NOT NULL DEFAULT 4,
  "pause_complaint_pct" double precision NOT NULL DEFAULT 0.1,
  "min_reputation_to_advance" integer NOT NULL DEFAULT 40,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "warmup_plans_org_name" ON "warmup_plans" ("org_id","name");

-- Backfill: insert a sensible default 28-day conservative ramp for every existing org.
INSERT INTO "warmup_plans" ("org_id","name","daily_caps","pause_bounce_pct","pause_complaint_pct","min_reputation_to_advance","is_default")
SELECT id, 'conservative-28d',
       ARRAY[20,30,50,75,100,125,150,180,210,240,275,310,350,400,450,500,560,620,680,750,820,900,975,1050,1125,1200,1300,1400]::integer[],
       4.0, 0.1, 40, true
FROM "organizations"
ON CONFLICT DO NOTHING;

-- Connect mailbox.warmup_plan_id -> warmup_plans.id now that the table exists.
ALTER TABLE "sender_mailboxes"
  ADD CONSTRAINT "sender_mailboxes_warmup_plan_fk"
  FOREIGN KEY ("warmup_plan_id") REFERENCES "warmup_plans"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "market_saturation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "niche" text NOT NULL,
  "city" text,
  "state" text,
  "postal_code" text,
  "window_end_date" text NOT NULL,
  "rolling_days" integer NOT NULL,
  "sent_leads" integer NOT NULL DEFAULT 0,
  "eligible_leads" integer NOT NULL DEFAULT 0,
  "saturation_pct" double precision NOT NULL DEFAULT 0,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ms_geo_window" ON "market_saturation" ("org_id","niche","postal_code","window_end_date","rolling_days");
CREATE INDEX IF NOT EXISTS "ms_niche_geo" ON "market_saturation" ("org_id","niche","city","state");

CREATE TABLE IF NOT EXISTS "signal_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "signal_key" text NOT NULL,
  "signal_value" text NOT NULL,
  "window_days" integer NOT NULL,
  "window_end_date" text NOT NULL,
  "n_observations" integer NOT NULL DEFAULT 0,
  "n_sent" integer NOT NULL DEFAULT 0,
  "n_replied" integer NOT NULL DEFAULT 0,
  "n_qualified" integer NOT NULL DEFAULT 0,
  "n_bounced" integer NOT NULL DEFAULT 0,
  "n_complained" integer NOT NULL DEFAULT 0,
  "n_unsubscribed" integer NOT NULL DEFAULT 0,
  "lift_reply" double precision,
  "lift_qualified" double precision,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "so_signal_window" ON "signal_outcomes" ("org_id","signal_key","signal_value","window_days","window_end_date");

CREATE TABLE IF NOT EXISTS "scoring_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "base_version_id" integer NOT NULL,
  "deltas" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "applied_version_id" integer,
  "notes" text,
  "proposed_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz,
  CONSTRAINT "sp_status_check" CHECK ("status" IN ('pending','applied','rejected','superseded'))
);
CREATE INDEX IF NOT EXISTS "sp_org_status" ON "scoring_proposals" ("org_id","status");

CREATE TABLE IF NOT EXISTS "website_intel" (
  "lead_id" uuid PRIMARY KEY REFERENCES "leads"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "home_url" text,
  "final_url" text,
  "http_status" integer,
  "tech_stack" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "booking_vendor" text,
  "emails" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "phones" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "social" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "services" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "hours_text" text,
  "address_text" text,
  "year_founded" integer,
  "language" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wi_org_booking" ON "website_intel" ("org_id","booking_vendor");

CREATE TABLE IF NOT EXISTS "reply_branch_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "campaign_id" uuid REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "recipient_id" uuid REFERENCES "campaign_recipients"("id") ON DELETE CASCADE,
  "node" text NOT NULL DEFAULT 'awaiting_reply',
  "last_intent" text,
  "follow_ups_sent" integer NOT NULL DEFAULT 0,
  "next_action_at" timestamptz,
  "next_action_kind" text,
  "next_action_payload" jsonb,
  "trail" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rbs_node_check" CHECK ("node" IN ('awaiting_reply','engaged','asked_for_info','scheduling','won','lost','dormant','suppressed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "rbs_campaign_lead" ON "reply_branch_states" ("campaign_id","lead_id");
CREATE INDEX IF NOT EXISTS "rbs_next_action" ON "reply_branch_states" ("next_action_at") WHERE "next_action_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "niche_seasons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "niche" text NOT NULL,
  "monthly_multipliers" double precision[] NOT NULL,
  "storm_boost_multiplier" double precision NOT NULL DEFAULT 1.0,
  "storm_event_types" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "storm_boost_window_days" integer NOT NULL DEFAULT 30,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ns_months_len" CHECK (array_length("monthly_multipliers",1) = 12)
);
CREATE UNIQUE INDEX IF NOT EXISTS "ns_org_niche" ON "niche_seasons" ("org_id","niche");

-- Seed niche-season defaults per existing org. The numbers come from
-- packages/core/src/seasons.ts and reflect intuition (HVAC bimodal,
-- Roofer post-storm, Septic spring/summer, Towing winter).
INSERT INTO "niche_seasons" ("org_id","niche","monthly_multipliers","storm_boost_multiplier","storm_event_types","storm_boost_window_days")
SELECT o.id, n.niche, n.mult, n.boost, n.events, 30
FROM "organizations" o
CROSS JOIN (VALUES
  ('Septic',      ARRAY[0.9,0.9,1.0,1.1,1.2,1.2,1.15,1.1,1.05,1.0,0.95,0.9]::double precision[],   1.10, ARRAY['Flood','Heavy Rain']::text[]),
  ('Roofer',      ARRAY[0.85,0.85,0.95,1.05,1.1,1.05,1.0,1.0,1.05,1.1,1.05,0.95]::double precision[], 1.40, ARRAY['Hail','Tornado','Hurricane','Thunderstorm Wind']::text[]),
  ('HVAC',        ARRAY[1.15,1.05,0.95,0.9,1.0,1.2,1.3,1.25,1.05,0.95,1.0,1.15]::double precision[], 1.05, ARRAY['Excessive Heat','Extreme Cold/Wind Chill']::text[]),
  ('Plumber',     ARRAY[1.1,1.1,1.05,1.0,0.95,0.95,0.95,0.95,1.0,1.05,1.1,1.15]::double precision[], 1.10, ARRAY['Extreme Cold/Wind Chill']::text[]),
  ('Water/Mold',  ARRAY[0.9,0.95,1.05,1.15,1.2,1.15,1.1,1.05,1.05,1.0,0.95,0.9]::double precision[], 1.50, ARRAY['Flood','Heavy Rain','Hurricane']::text[]),
  ('Electrician', ARRAY[1.0,1.0,1.05,1.05,1.05,1.05,1.1,1.05,1.05,1.0,0.95,0.95]::double precision[], 1.10, ARRAY['Thunderstorm Wind','Hurricane']::text[]),
  ('Towing',      ARRAY[1.2,1.15,1.05,0.95,0.95,0.95,0.95,0.95,0.95,1.0,1.1,1.2]::double precision[],  1.20, ARRAY['Heavy Snow','Ice Storm','Winter Storm']::text[]),
  ('Real Estate', ARRAY[0.9,0.95,1.05,1.1,1.15,1.1,1.05,1.0,1.0,0.95,0.9,0.85]::double precision[],  1.00, ARRAY[]::text[])
) AS n("niche","mult","boost","events")
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS "niche_weather_overlays" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "postal_code" text NOT NULL,
  "event_type" text NOT NULL,
  "intensity" double precision NOT NULL DEFAULT 0,
  "last_event_at" timestamptz,
  "refreshed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "nwo_postal_event" ON "niche_weather_overlays" ("postal_code","event_type");

CREATE TABLE IF NOT EXISTS "queue_metrics_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tier" text NOT NULL,
  "counts" jsonb NOT NULL,
  "oldest_queued_ms" integer,
  "sampled_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "qms_sampled" ON "queue_metrics_snapshots" ("sampled_at");

CREATE TABLE IF NOT EXISTS "ai_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "adapter" text NOT NULL,
  "operation" text NOT NULL,
  "input_hash" text NOT NULL,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "latency_ms" integer,
  "result" jsonb,
  "status" text NOT NULL DEFAULT 'ok',
  "error" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_runs_status_check" CHECK ("status" IN ('ok','error','rejected')),
  CONSTRAINT "ai_runs_op_check" CHECK ("operation" IN ('generate_template','analyze_replies','suggest_weights','summarize_intel'))
);
CREATE INDEX IF NOT EXISTS "ai_runs_org_occurred" ON "ai_runs" ("org_id","occurred_at");

-- Attribution: link campaign_recipients to the mailbox that sent it. The
-- warmup engine + reputation rollup read this. NULL for any pre-v3.3 row.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "sender_mailbox_id" uuid;
CREATE INDEX IF NOT EXISTS "cr_sender_mailbox" ON "campaign_recipients" ("sender_mailbox_id") WHERE "sender_mailbox_id" IS NOT NULL;
