-- DMARC aggregate (rua) reports, parsed from the mailbox so the operator sees a
-- simple pass/fail summary instead of zipped XML attachments.
CREATE TABLE IF NOT EXISTS dmarc_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
  report_id       text NOT NULL,
  org_name        text,
  domain          text,
  policy          text,
  date_begin      timestamptz,
  date_end        timestamptz,
  total_messages  integer NOT NULL DEFAULT 0,
  dmarc_pass      integer NOT NULL DEFAULT 0,
  dmarc_fail      integer NOT NULL DEFAULT 0,
  spf_pass        integer NOT NULL DEFAULT 0,
  dkim_pass       integer NOT NULL DEFAULT 0,
  rows            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dmarc_reports_report_id ON dmarc_reports (report_id);
CREATE INDEX IF NOT EXISTS dmarc_reports_created ON dmarc_reports (created_at DESC);
