/**
 * Phone line-type heuristic using libphonenumber.
 * Free, in-process. Used at intake to power `phone_line_type` signal.
 */
import lpn from 'google-libphonenumber';
import type { PhoneLineType } from '@keres/core';

const PNF = lpn.PhoneNumberFormat;
const util = lpn.PhoneNumberUtil.getInstance();
const PNT = (lpn as unknown as { PhoneNumberType: typeof import('google-libphonenumber').PhoneNumberType }).PhoneNumberType ?? null;

export interface PhoneClassification {
  e164: string | null;
  valid: boolean;
  lineType: PhoneLineType;
  countryCode: string | null;
}

export function classifyPhone(input: string | null | undefined, defaultRegion = 'US'): PhoneClassification {
  if (!input) return { e164: null, valid: false, lineType: 'unknown', countryCode: null };
  try {
    const parsed = util.parse(input, defaultRegion);
    if (!util.isValidNumber(parsed)) {
      return { e164: null, valid: false, lineType: 'unknown', countryCode: null };
    }
    const e164 = util.format(parsed, PNF.E164);
    const region = util.getRegionCodeForNumber(parsed) ?? null;
    const type = util.getNumberType(parsed);
    return { e164, valid: true, lineType: mapType(type), countryCode: region };
  } catch {
    return { e164: null, valid: false, lineType: 'unknown', countryCode: null };
  }
}

function mapType(t: number): PhoneLineType {
  /* libphonenumber's PhoneNumberType enum is exposed inconsistently. We rely
     on the documented numeric mapping. */
  switch (t) {
    case 0: return 'landline';        // FIXED_LINE
    case 1: return 'mobile';          // MOBILE
    case 2: return 'mobile';          // FIXED_LINE_OR_MOBILE (lean mobile)
    case 3: return 'toll_free';       // TOLL_FREE
    case 4: return 'toll_free';       // PREMIUM_RATE
    case 5: return 'toll_free';       // SHARED_COST
    case 6: return 'voip';            // VOIP
    case 7: return 'mobile';          // PERSONAL_NUMBER
    case 8: return 'toll_free';       // PAGER
    case 9: return 'voip';            // UAN
    case 10: return 'unknown';        // VOICEMAIL
    case 11: return 'unknown';
    default: return 'unknown';
  }
}
