/**
 * Free email verification chain:
 *   1. Syntax
 *   2. Disposable domain list
 *   3. Role-account flag (info|sales|admin…) — passes but downstream may de-prioritize
 *   4. DNS MX lookup (real implementation deferred to caller wiring `dns/promises`)
 *   5. SMTP RCPT probe — disabled in MVP for Gmail/Outlook/iCloud/Yahoo
 *
 * The actual DNS / SMTP I/O is injected via callbacks so this stays testable
 * without network access.
 */
import { emailIntakeFilter, isRoleEmail } from '@keres/core';
import type { VerificationProvider, VerificationResult } from './types.js';

export interface FreeVerifierConfig {
  /** Resolves MX records for a domain; returns the list of priorities or empty. */
  resolveMx?: (domain: string) => Promise<string[]>;
  /** Probes the mailbox via SMTP RCPT TO. Returns true=accepted false=rejected null=ambiguous. */
  smtpProbe?: (email: string, mx: string) => Promise<boolean | null>;
  /** When true, attempts SMTP probes; defaults to false at MVP. */
  enableSmtp?: boolean;
}

const BIG_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

export class FreeVerifier implements VerificationProvider {
  readonly name = 'free-chain';
  constructor(private cfg: FreeVerifierConfig = {}) {}

  isEnabled() { return true; }

  async verify(email: string): Promise<VerificationResult> {
    const lower = email.trim().toLowerCase();
    const syntax = emailIntakeFilter(lower);
    if (!syntax.ok) {
      return {
        status: syntax.reason === 'disposable_domain' ? 'disposable' : 'invalid',
        source: syntax.reason === 'disposable_domain' ? 'disposable' : 'syntax',
        detail: syntax.reason,
      };
    }
    if (isRoleEmail(lower)) {
      /* Role accounts pass intake but get marked so the scorer can derank. */
      // fall through, but tag with `role`
    }
    const domain = lower.split('@')[1] ?? '';
    if (!domain) return { status: 'invalid', source: 'syntax' };

    /* MX check */
    let mxRecords: string[] = [];
    if (this.cfg.resolveMx) {
      try { mxRecords = await this.cfg.resolveMx(domain); }
      catch { mxRecords = []; }
    }
    if (this.cfg.resolveMx && mxRecords.length === 0) {
      return { status: 'invalid', source: 'mx', detail: 'no MX records' };
    }

    /* Big providers don't reliably accept SMTP RCPT probes — skip. */
    if (BIG_PROVIDERS.has(domain)) {
      return { status: 'unverifiable_provider', source: 'smtp', detail: 'major free provider' };
    }

    /* Optional SMTP probe — disabled by default. */
    if (this.cfg.enableSmtp && this.cfg.smtpProbe && mxRecords.length > 0) {
      const accepted = await this.cfg.smtpProbe(lower, mxRecords[0]!);
      if (accepted === true) return { status: isRoleEmail(lower) ? 'role' : 'valid', source: 'smtp' };
      if (accepted === false) return { status: 'invalid', source: 'smtp' };
      return { status: 'unknown', source: 'smtp', detail: 'ambiguous response' };
    }

    /* Default: MX exists, no SMTP probe → mark as `unknown` so a Bouncer fallback can pick this up if score >= 80. */
    return { status: isRoleEmail(lower) ? 'role' : 'unknown', source: 'mx' };
  }
}
