/**
 * Plain-text body linter. Returns issues with severity `info|warn|error`.
 * The server blocks send if any issue has severity 'error'.
 */
export interface LinterIssue {
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  detail?: string;
}

export interface LintInput {
  subject: string;
  body: string;
  recipientCount?: number;        // for repeat-opener checks
  niche?: string;
  identityHasPhysicalAddress: boolean;
  unsubscribeUrlPresent: boolean;
  canSpamFooterPresent: boolean;
  /** Optional repeat-opener detection across a campaign: pass openers seen so far. */
  openerHistogram?: Record<string, number>;
  thisOpener?: string;
}

const SPAMMY_WORDS = [
  /\bfree money\b/i, /\bact now\b/i, /\bguarantee\b/i, /\b100% (free|guaranteed)\b/i,
  /\$\$\$/, /\bdouble your\b/i, /\bclick here\b/i,
  /\bbuy now\b/i, /\bonce in a lifetime\b/i, /\border now\b/i, /\bexpires\b/i,
  /\binstantly\b/i, /\bcongratulations\b/i,
];

const CLAIM_WHITELIST = [
  /\b24\/7\b/, /\bevery (call|inbound)\b/i, /\bbooks (the )?(estimate|dispatch|appointment)\b/i,
  /\bqualifies the lead\b/i, /\btexts (a )?summary\b/i,
];

const FALSE_CLAIM_PATTERNS = [
  /\b(roi|return on investment|10x|hundreds of \w+|biggest|best|top[- ]?rated|industry[- ]?leading)\b/i,
  /\bunbeatable\b/i, /\bworld[- ]?class\b/i, /\bguaranteed (result|outcome|conversion)\b/i,
];

export function lintEmail(input: LintInput): LinterIssue[] {
  const issues: LinterIssue[] = [];

  /* Compliance */
  if (!input.identityHasPhysicalAddress) {
    issues.push({ severity: 'error', code: 'no_physical_address', message: 'Sender identity is missing a physical postal address (CAN-SPAM).' });
  }
  if (!input.unsubscribeUrlPresent) {
    issues.push({ severity: 'error', code: 'no_unsub_link', message: 'Body must contain a visible unsubscribe link.' });
  }
  if (!input.canSpamFooterPresent) {
    issues.push({ severity: 'error', code: 'no_can_spam_footer', message: 'Body must contain the CAN-SPAM footer block.' });
  }

  /* Subject */
  if (!input.subject || input.subject.trim().length === 0) {
    issues.push({ severity: 'error', code: 'empty_subject', message: 'Subject line is empty.' });
  }
  if (/^Re:/i.test(input.subject) || /^Fwd:/i.test(input.subject)) {
    issues.push({ severity: 'error', code: 'deceptive_subject', message: 'Deceptive subject (looks like a reply / forward).' });
  }
  if (input.subject.length > 70) {
    issues.push({ severity: 'warn', code: 'long_subject', message: 'Subject longer than 70 chars; may truncate on mobile.' });
  }
  if (/[A-Z]{4,}/.test(input.subject)) {
    issues.push({ severity: 'warn', code: 'shouty_subject', message: 'Subject contains all-caps run.' });
  }

  /* Body */
  const wc = input.body.trim().split(/\s+/).length;
  if (wc > 180) {
    issues.push({ severity: 'warn', code: 'too_long', message: `Body is ${wc} words (target ≤ 180).` });
  }
  const linkCount = (input.body.match(/https?:\/\//g) ?? []).length;
  if (linkCount > 2) {
    issues.push({ severity: 'warn', code: 'too_many_links', message: `Body contains ${linkCount} links (target ≤ 2 incl. unsubscribe).` });
  }
  for (const re of SPAMMY_WORDS) {
    const m = input.body.match(re) ?? input.subject.match(re);
    if (m) issues.push({ severity: 'warn', code: 'spam_trigger', message: `Spam-trigger phrase: "${m[0]}"` });
  }
  for (const re of FALSE_CLAIM_PATTERNS) {
    const m = input.body.match(re);
    if (m) issues.push({ severity: 'warn', code: 'false_claim', message: `Possibly unverifiable claim: "${m[0]}"` });
  }

  /* Fake personalization — unresolved template tokens */
  const remaining = input.body.match(/\{\{\s*[a-z_]+\s*\}\}/i);
  if (remaining) {
    issues.push({ severity: 'error', code: 'unresolved_token', message: `Unresolved template token: ${remaining[0]}` });
  }
  if (/\b(\[business\]|\[city\]|\[first_name\])\b/i.test(input.body)) {
    issues.push({ severity: 'error', code: 'unresolved_token', message: 'Unresolved placeholder remains in body.' });
  }

  /* Relevance: at least one allowed Keres claim should be present */
  if (!CLAIM_WHITELIST.some(re => re.test(input.body))) {
    issues.push({ severity: 'info', code: 'no_keres_claim', message: 'Body lacks a Keres positioning claim (24/7, qualifies, books, texts summary).' });
  }

  /* Opener repetition across campaign */
  if (input.thisOpener && input.openerHistogram && input.recipientCount && input.recipientCount > 20) {
    const used = input.openerHistogram[input.thisOpener] ?? 0;
    const pct = used / input.recipientCount;
    if (pct > 0.3) {
      issues.push({
        severity: 'warn', code: 'opener_overused',
        message: `Opener used in ${(pct * 100).toFixed(0)}% of recipients (target < 30%).`,
      });
    }
  }

  return issues;
}

export function highestSeverity(issues: LinterIssue[]): 'info' | 'warn' | 'error' | null {
  let max: 'info' | 'warn' | 'error' | null = null;
  for (const i of issues) {
    if (i.severity === 'error') return 'error';
    if (i.severity === 'warn') max = 'warn';
    else if (!max) max = 'info';
  }
  return max;
}
