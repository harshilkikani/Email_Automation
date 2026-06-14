-- Deep whole-email personalization: full body for touch 1. Idempotent.
ALTER TABLE lead_signals ADD COLUMN IF NOT EXISTS personalized_body TEXT;
