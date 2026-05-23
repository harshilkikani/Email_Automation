/* Provider interfaces — adapters implement these regardless of mock vs real. */
import type { LeadCandidate, Niche } from '@keres/core';

export interface DiscoveryQuery {
  niche: Niche;
  city: string;
  state: string;
  targetCount: number;
  keyword?: string;
}

export interface DiscoveryResult {
  candidates: LeadCandidate[];
  source: string;
  attribution?: string;
  warnings?: string[];
}

export interface DiscoveryProvider {
  name: string;
  isEnabled(): boolean;
  search(q: DiscoveryQuery): Promise<DiscoveryResult>;
}

export interface VerificationResult {
  status: 'valid' | 'invalid' | 'catch_all' | 'unverifiable_provider' | 'unknown' | 'role' | 'disposable';
  source: 'syntax' | 'mx' | 'smtp' | 'bouncer' | 'hunter' | 'disposable' | 'role' | 'skipped';
  detail?: string;
  costCents?: number;
}

export interface VerificationProvider {
  name: string;
  isEnabled(): boolean;
  verify(email: string): Promise<VerificationResult>;
}

export interface SendInput {
  to: string;
  subject: string;
  rawMessage: string;                     // pre-built RFC 5322 message
  configurationSet?: string;
  /** Echoed back from provider as the messageId for idempotent webhook handling. */
  customMessageId?: string;
}

export interface SendResult {
  providerMessageId: string;
  provider: string;
  costCents?: number;
}

export interface OutboundProvider {
  name: string;
  isEnabled(): boolean;
  send(input: SendInput): Promise<SendResult>;
}

export interface InboundEvent {
  providerMessageId: string;
  fromEmail: string;
  toEmail: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt: Date;
}

export interface InboundProvider {
  name: string;
  isEnabled(): boolean;
  parseWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): InboundEvent | null;
}
