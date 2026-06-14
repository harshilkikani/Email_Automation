-- Owner / decision-maker finding. Idempotent.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_source TEXT;   -- direct_owner|pattern|generic
