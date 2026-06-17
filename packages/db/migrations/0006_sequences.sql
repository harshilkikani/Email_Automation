-- Multi-step follow-up sequences. Idempotent.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_steps INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS step_delay_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS step INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
