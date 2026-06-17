-- Focus mode: prioritize best-fit / focus-trade leads in the send order.
-- Pure ordering — NO lead is ever excluded, just queued behind higher-priority
-- ones, so the limited daily sends hit the most-likely-to-convert prospects first.
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS focus_niches text[] NOT NULL DEFAULT '{}';

-- Backfill: rank existing pending/queued recipients by their lead score so the
-- new ordering takes effect immediately, not just for future campaigns.
UPDATE campaign_recipients cr
SET priority = GREATEST(0, LEAST(l.score, 99999))
FROM leads l
WHERE cr.lead_id = l.id AND cr.state IN ('pending','queued');
