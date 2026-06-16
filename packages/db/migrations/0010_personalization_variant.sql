-- Records which copy levers (gap pitched, CTA, hook, AI angle) each personalized
-- email used, so the performance loop can learn which variants earn replies.
ALTER TABLE lead_signals ADD COLUMN IF NOT EXISTS personalization_variant jsonb;
