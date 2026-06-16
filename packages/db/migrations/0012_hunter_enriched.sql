-- Owner enrichment via Hunter domain-search: marker so we attempt each lead once
-- (paid credits are scarce — never re-burn one on a lead we already tried).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hunter_enriched_at timestamptz;
