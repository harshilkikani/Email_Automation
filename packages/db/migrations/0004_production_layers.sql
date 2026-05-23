-- Revenue-weighted signal outcomes
ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS n_won INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS total_revenue_usd DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Dead letter queue
CREATE TABLE IF NOT EXISTS dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  recipient_id UUID REFERENCES campaign_recipients(id) ON DELETE SET NULL,
  fail_reason TEXT NOT NULL,
  last_error TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at TIMESTAMPTZ,
  replay_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dl_org_archived ON dead_letters (org_id, archived_at);

-- Send-time histograms (adaptive per-niche UTC-hour reply-rate optimization)
CREATE TABLE IF NOT EXISTS send_time_histograms (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  niche TEXT NOT NULL,
  utc_hour INTEGER NOT NULL CHECK (utc_hour >= 0 AND utc_hour <= 23),
  n_sent INTEGER NOT NULL DEFAULT 0,
  n_replied INTEGER NOT NULL DEFAULT 0,
  reply_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, niche, utc_hour)
);

-- Typed domain events (event sourcing layer)
CREATE TABLE IF NOT EXISTS domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS de_agg ON domain_events (org_id, aggregate_type, aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS de_corr ON domain_events (correlation_id) WHERE correlation_id IS NOT NULL;
