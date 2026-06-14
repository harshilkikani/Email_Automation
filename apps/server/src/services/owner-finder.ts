/**
 * Owner / decision-maker + best-email finder (Apollo/Hunter-style, free).
 *
 *   crawl public pages → extract people + emails → pick the owner →
 *   detect the company email pattern → choose the best address → MX-verify.
 *
 * "Best address" priority: an on-site email that matches the owner's name (real +
 * personal) > a pattern-inferred owner address > the best generic mailbox. We use
 * the owner's NAME to personalize the greeting regardless of which email we send to.
 */
import type { Scraper } from '@keres/providers';
import { extractPeople, pickDecisionMaker, detectEmailPattern, chooseBestEmail } from '@keres/core';
import { getVerifier } from './verify.js';

export interface OwnerResult {
  ownerName: string | null;
  ownerFirst: string | null;
  email: string | null;
  emailSource: string | null;     // direct_owner | pattern | generic
  confidence: number;
  verifyStatus: string | null;
  verifySource: string | null;
}

const EMPTY: OwnerResult = {
  ownerName: null, ownerFirst: null, email: null, emailSource: null,
  confidence: 0, verifyStatus: null, verifySource: null,
};

export async function findOwnerEmail(
  scraper: Scraper, website: string | null | undefined, knownEmails: string[],
): Promise<OwnerResult> {
  if (!website) return EMPTY;
  const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
  let crawl: { emails: string[]; text: string; pages: number };
  try { crawl = await scraper.deepCrawl(website); } catch { crawl = { emails: [], text: '', pages: 0 }; }

  const allEmails = [...new Set([...knownEmails, ...crawl.emails].map(e => e.toLowerCase()))];
  const people = extractPeople(crawl.text);
  const owner = pickDecisionMaker(people);

  /* Map found emails → people (when the local-part contains their name) to infer
     the company's email pattern. */
  const known = allEmails.map(email => {
    const local = email.split('@')[0] ?? '';
    const person = people.find(p =>
      local.includes(p.firstName.toLowerCase()) ||
      (p.lastName.length > 2 && local.includes(p.lastName.toLowerCase())));
    return { email, person };
  });
  const pattern = detectEmailPattern(known);

  const chosen = chooseBestEmail(owner, allEmails, domain, pattern);
  let verifyStatus: string | null = null, verifySource: string | null = null;
  if (chosen) {
    try { const v = await getVerifier().verify(chosen.email); verifyStatus = v.status; verifySource = v.source; }
    catch { verifyStatus = 'unknown'; verifySource = 'skipped'; }
  }

  return {
    ownerName: owner?.name ?? null,
    ownerFirst: owner?.firstName ?? null,
    email: chosen?.email ?? null,
    emailSource: chosen?.source ?? null,
    confidence: chosen?.confidence ?? 0,
    verifyStatus, verifySource,
  };
}
