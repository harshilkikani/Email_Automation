/**
 * Email-verification factory. Default = the FREE chain (syntax + disposable +
 * MX records), SMTP probe off — enough to drop obvious bounces without a paid
 * service or risky mailbox probing. Hunter/Bouncer can be layered later behind
 * their flags; for now MX-level verification is the policy.
 */
import dns from 'node:dns/promises';
import { FreeVerifier, type VerificationProvider } from '@keres/providers';
import { getConfig } from '../config.js';
import { smtpRcptProbe } from './smtp-probe.js';

let _verifier: VerificationProvider | null = null;

export function getVerifier(): VerificationProvider {
  if (_verifier) return _verifier;
  const cfg = getConfig();
  _verifier = new FreeVerifier({
    resolveMx: async (domain: string) => {
      try {
        const mx = await dns.resolveMx(domain);
        return mx.sort((a, b) => a.priority - b.priority).map(m => m.exchange);
      } catch {
        return [];
      }
    },
    /* Free SMTP RCPT probe — confirms the mailbox exists (port 25 works from Fly)
       so non-existent addresses are caught as `invalid` before they bounce.
       Big free providers are skipped inside the verifier. */
    enableSmtp: cfg.verify.smtpProbe && !cfg.sampleMode,
    smtpProbe: (email, mx) => smtpRcptProbe(email, mx, {
      fromDomain: cfg.org.outreachSubdomain || 'keresai.com',
      fromEmail: cfg.org.fromEmail || cfg.smtp.fromEmail || 'postmaster@keresai.com',
      timeoutMs: cfg.verify.smtpTimeoutMs,
    }),
  });
  return _verifier;
}

/**
 * Under MX-level verification a deliverable business email comes back as `role`
 * (info@/office@…), `unknown` (MX good, mailbox unconfirmed) or
 * `unverifiable_provider` (gmail/outlook) — only `invalid`/`disposable` clearly
 * fail. So "sendable" = passed the free checks. `null` is treated as sendable so
 * pre-existing (un-verified) leads/campaigns keep working; new scraped leads are
 * always verified, so this guard drops the genuine bounces.
 */
const UNSENDABLE_STATUSES = new Set(['invalid', 'disposable']);

export function isSendableStatus(status: string | null | undefined): boolean {
  return !UNSENDABLE_STATUSES.has(status ?? '');
}

/** Test seam. */
export function resetVerifierForTests(): void { _verifier = null; }
