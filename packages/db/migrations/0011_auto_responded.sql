-- Instant reply auto-responder: one acknowledgement per lead, idempotent.
-- Set when we send the auto-reply to a positive inbound; checked to avoid double-sends.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS auto_responded_at timestamptz;
