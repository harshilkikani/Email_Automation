/**
 * `CampaignDecision` is the per-recipient pre-send envelope: the answer to
 * "should we send to this recipient on this campaign, and if so, with which
 * identity + template + subject(s)?". It is the single seam between the
 * decision policy (which lives in this package) and the actual SES call
 * (which lives in `apps/server/src/services/sender-pipeline.ts`).
 *
 * Exporting the type from `@keres/core` lets every consumer — the send
 * pipeline, the dashboard, future external CLI tools — share one canonical
 * shape and prevents drift.
 *
 * `MailboxIdentity` is the minimum subset of a sender mailbox needed to
 * stamp the outgoing message headers. The server's `PickedMailbox` (in
 * `apps/server/src/services/sender-rotation.ts`) is a structural superset
 * and will assign cleanly to this type. The DB schema row from
 * `senderMailboxes.$inferSelect` also assigns cleanly. We deliberately
 * keep this type small so it does not pull the Drizzle schema into core.
 */
import type { Template } from './templates.js';

export interface MailboxIdentity {
  id: string;
  fromName: string;
  fromEmail: string;
  /** Null when the mailbox has no override; pipeline falls back to org-level reply-to. */
  replyTo: string | null;
}

export interface CampaignDecisionSenderIdentity {
  fromName: string;
  fromEmail: string;
  replyTo: string;
}

export interface CampaignDecision {
  shouldSend: boolean;
  /**
   * Stable machine-readable reason for skip/failure. Examples:
   * `campaign_not_running`, `no_email`, `lead_status`, `saturation_<x>`.
   * Absent when `shouldSend === true`.
   */
  skipReason?: string;
  /** Chosen mailbox, null when no eligible mailbox was found. */
  mailbox: MailboxIdentity | null;
  template: Template;
  /** Optional A/B subjects; empty when none configured. */
  subjectOverrides: string[];
  /** Identity stamped into the outbound headers. */
  senderIdentity: CampaignDecisionSenderIdentity;
}
