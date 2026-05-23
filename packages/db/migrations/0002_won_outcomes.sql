-- Won-outcome tracking columns on reply_branch_states.
-- Allows operators to record deal outcomes per conversation thread.
ALTER TABLE reply_branch_states ADD COLUMN IF NOT EXISTS won_at TIMESTAMPTZ;
ALTER TABLE reply_branch_states ADD COLUMN IF NOT EXISTS won_outcome_type TEXT;
ALTER TABLE reply_branch_states ADD COLUMN IF NOT EXISTS won_revenue_usd DOUBLE PRECISION;
