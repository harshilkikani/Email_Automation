/**
 * Deterministic regex-based reply classifier. No AI at MVP.
 *
 * Matches the taxonomy from VALIDATION-PLAN.md Part 4.3.
 */
import type { ReplyIntent } from './types.js';

const HOSTILE_TERMS = [
  /\b(stop|quit|cease|leave us alone|do not (contact|email)|never email)\b/i,
  /\b(remove|unsubscribe me|don'?t (ever )?email)\b/i,
  /\b(spam|spammer|harass|harassing|fuck|shit|piss|scam)\b/i,
];

const INTERESTED_TERMS = [
  /\b(tell me more|sounds (good|great)|i'?m interested\b|interested in (learning|hearing)|i'?d like to|hop on a call|book a (demo|call|meeting)|set up (a )?(call|meeting|demo)|let'?s (talk|chat)|happy to (chat|talk))\b/i,
  /\b(pricing|how much|what.{0,12}(cost|price))\b/i,
];

const CONDITIONAL_TERMS = [
  /\b(maybe|might|possibly|q[1-4]\b|next (quarter|month|year)|later this|circle back|follow up in|no time (right )?now|booked|busy right now)\b/i,
  /\b(send (me )?(info|details|more))\b/i,
];

const OBJECTION_TERMS = [
  /\b(we already (have|use)|happy with|using (\w+))\b/i,
  /\b(competitor|already (set up|sorted))\b/i,
];

const POLITE_NO_TERMS = [
  /\b(no thanks?|not interested|pass|not (for|right for) us|not at this time)\b/i,
];

const WRONG_PERSON_TERMS = [
  /\b(wrong person|not the (owner|right person)|please contact|email .{2,20}@)\b/i,
  /\bi don'?t (handle|deal with|own)\b/i,
];

const AUTO_REPLY_TERMS = [
  /\b(out of (office|the office)|on vacation|annual leave|maternity|out of country|away from (my )?(desk|email))\b/i,
  /\b(automatic reply|auto[- ]reply|i am currently)\b/i,
];

const REFERRAL_TERMS = [
  /\b(my friend|colleague|partner) (at|with|runs)\b/i,
  /\byou should (also )?talk to\b/i,
];

const BOUNCE_TERMS = [
  /\b(undeliverable|delivery (status|failure)|mailer-?daemon|postmaster|did not reach|message blocked|address (rejected|not found)|550 5\.|recipient (address|inbox).{0,20}(rejected|not exist))\b/i,
];

const UNSUB_TERMS = [
  /\bunsubscribe(?!\s+me\s+from\s+a)/i,
  /\b(opt[- ]?out|remove me)\b/i,
];

export interface ClassifyResult {
  intent: ReplyIntent;
  isAutoReply: boolean;
  hostile: boolean;
  matchedTerms: string[];
}

export function classifyReply(subject: string, body: string): ClassifyResult {
  const text = `${subject}\n${body}`;
  const matched: string[] = [];

  const test = (terms: RegExp[]) => {
    for (const t of terms) {
      const m = text.match(t);
      if (m) {
        matched.push(m[0]);
        return true;
      }
    }
    return false;
  };

  if (test(BOUNCE_TERMS))      return { intent: 'bounce', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(UNSUB_TERMS))       return { intent: 'unsubscribe', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(HOSTILE_TERMS))     return { intent: 'not_interested_hostile', isAutoReply: false, hostile: true, matchedTerms: matched };

  const isAuto = test(AUTO_REPLY_TERMS);
  if (isAuto)                  return { intent: 'auto_reply', isAutoReply: true, hostile: false, matchedTerms: matched };

  if (test(WRONG_PERSON_TERMS))return { intent: 'wrong_person', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(REFERRAL_TERMS))    return { intent: 'referral', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(POLITE_NO_TERMS))   return { intent: 'not_interested_polite', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(CONDITIONAL_TERMS)) return { intent: 'conditional', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(OBJECTION_TERMS))   return { intent: 'objection', isAutoReply: false, hostile: false, matchedTerms: matched };
  if (test(INTERESTED_TERMS))  return { intent: 'interested', isAutoReply: false, hostile: false, matchedTerms: matched };

  return { intent: 'unknown', isAutoReply: false, hostile: false, matchedTerms: matched };
}
