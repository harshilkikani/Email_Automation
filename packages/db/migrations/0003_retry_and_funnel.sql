-- Add retry tracking to campaign_recipients
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- Expand leads.status to include 'won'
ALTER TABLE leads DROP CONSTRAINT IF EXISTS lead_status_check;
ALTER TABLE leads ADD CONSTRAINT lead_status_check
  CHECK (status IN ('new','uncontacted','contacted','replied','interested','booked','won','bounced','unsubscribed','dnc'));

-- Add won_outcome_type check constraint to reply_branch_states
ALTER TABLE reply_branch_states DROP CONSTRAINT IF EXISTS rbs_won_outcome_check;
ALTER TABLE reply_branch_states ADD CONSTRAINT rbs_won_outcome_check
  CHECK (won_outcome_type IS NULL OR won_outcome_type IN ('booked','call_scheduled','replied_yes','manual'));
