/* Common types shared across the core package. */

export type Niche =
  | 'Roofer'
  | 'Septic'
  | 'Water/Mold'
  | 'HVAC'
  | 'Plumber'
  | 'Electrician'
  | 'Towing'
  | 'Real Estate';

export const ALL_NICHES: Niche[] = [
  'Septic', 'Water/Mold', 'HVAC', 'Roofer',
  'Plumber', 'Electrician', 'Towing', 'Real Estate',
];

export type WebPresenceLevel = 'none' | 'social_only' | 'gbp_only' | 'basic' | 'modern' | 'unknown';

export type LicenseStatus = 'active' | 'expired' | 'suspended' | 'unknown';

export type PhoneLineType = 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown';

export type LeadStatus =
  | 'new' | 'uncontacted' | 'contacted' | 'replied'
  | 'interested' | 'booked' | 'bounced' | 'unsubscribed' | 'dnc';

export type ReplyIntent =
  | 'interested' | 'conditional' | 'objection'
  | 'not_interested_polite' | 'not_interested_hostile'
  | 'wrong_person' | 'auto_reply' | 'referral'
  | 'bounce' | 'unsubscribe' | 'unknown';

export const REPLY_INTENTS: ReplyIntent[] = [
  'interested', 'conditional', 'objection',
  'not_interested_polite', 'not_interested_hostile',
  'wrong_person', 'auto_reply', 'referral',
  'bounce', 'unsubscribe', 'unknown',
];

export interface LeadCandidate {
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  niche: Niche;
  source: string;
  sourceExternalId?: string | null;
}

export interface ScoringInputs {
  niche: Niche;
  webPresenceLevel: WebPresenceLevel;
  hasPhone: boolean;
  phoneLineType: PhoneLineType;
  hasOnlineBooking: boolean;
  isStormZone: boolean;
  licenseStatus: LicenseStatus;
  reviewCount30d: number | null;
  reviewRating: number | null;
  competitorDensity: number | null;
  ownerOperator: boolean;
  serviceDispatchModel: boolean;
  emergencyNiche: boolean;
  multiLocation: boolean;
  isFranchise: boolean;
  isResidentialAddress: boolean;
  deadDomain: boolean;
}

export interface ScoringContribution {
  signal: string;
  value: string | number | boolean | null;
  points: number;
  confidence: number;          // 0–1
  evidence?: Record<string, unknown>;
}

export interface ScoringResult {
  score: number;               // 0–100
  contributions: ScoringContribution[];
  disqualified: boolean;
  disqualificationReason?: string;
  confidence: number;
  scoringVersion: number;
}

export interface ScoringVersion {
  id: number;
  weights: ScoringWeights;
  notes?: string;
}

export interface ScoringWeights {
  webPresence: Record<WebPresenceLevel, number>;
  nicheFit: Record<Niche, number>;
  phonePresent: number;
  phoneLineLandlineOrVoip: number;
  licenseActive: number;
  licenseExpired: number;
  stormBumpForStormNiches: number;
  reviewVelocityLow: number;
  reviewVelocityHigh: number;
  hasOnlineBookingPenalty: number;
  competitorDensityHigh: number;
  ownerOperator: number;
  serviceDispatchModel: number;
  emergencyNiche: number;
  multiLocationPenalty: number;
  franchisePenalty: number;
  residentialPenalty: number;
  deadDomainPenalty: number;
}
