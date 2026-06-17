/**
 * Recipient-local send timing.
 *
 * Leads span every US timezone, but the send loop only knew UTC — so "10am"
 * meant 10am ET = 7am PT (too early on the coast). Open rates peak at ~10am
 * *local*, so this maps a lead's state → its dominant IANA timezone and tells
 * the send loop to defer a recipient until the next local business-hours slot.
 *
 * Pure + DST-correct: timezone math goes through `Intl.DateTimeFormat`, and the
 * wall clock is passed in so it's deterministically testable. We use the
 * dominant timezone per state (a few states straddle two) — good enough since a
 * metro bbox is approximate anyway and we only need to land in the morning.
 */

/** US state / DC → dominant IANA timezone. */
export const STATE_TZ: Record<string, string> = {
  // Eastern
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', IN: 'America/New_York', KY: 'America/New_York', MA: 'America/New_York',
  MD: 'America/New_York', ME: 'America/New_York', MI: 'America/New_York', NC: 'America/New_York',
  NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VA: 'America/New_York',
  VT: 'America/New_York', WV: 'America/New_York',
  // Central
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago',
  KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago',
  MS: 'America/Chicago', ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  // Mountain
  CO: 'America/Denver', ID: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver',
  UT: 'America/Denver', WY: 'America/Denver',
  AZ: 'America/Phoenix',   // no DST
  // Pacific
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  // Alaska / Hawaii
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

/** Central is a reasonable middle-of-the-country default for unknown states. */
export const DEFAULT_TZ = 'America/Chicago';

export interface LocalTimingOpts {
  openHour: number;          // earliest acceptable local send hour (inclusive)
  closeHour: number;         // latest acceptable local send hour (exclusive)
  morningStartHour: number;  // deferred sends spread from here (local)…
  morningWindowMin: number;  // …across this many minutes (e.g. 120 = 9:00–11:00)
  skipWeekends: boolean;
}

/* Research-backed (2026): the peak window is ~9:30–11:30 local, and firing a whole
   batch at one exact time (:00) is a bulk/automation signal that hurts deliverability.
   So deferred sends spread deterministically across a 9:00–11:00 window — each
   recipient lands on its own minute (stable per recipient, never all at once). */
export const DEFAULT_LOCAL_TIMING: LocalTimingOpts = {
  openHour: 9, closeHour: 17, morningStartHour: 9, morningWindowMin: 120, skipWeekends: true,
};

/** Stable per-recipient minute offset within the window (so it's spread, not bunched). */
function jitterMinutes(seed: string, windowMin: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % Math.max(1, windowMin);
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; dow: number }

/** Wall-clock parts of `now` in the given IANA timezone (DST-correct). */
function partsInTz(now: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const m: Record<string, string> = {};
  for (const p of f.formatToParts(now)) m[p.type] = p.value;
  let hour = parseInt(m.hour ?? '0', 10);
  if (hour === 24) hour = 0;   // some engines render midnight as "24"
  return {
    year: parseInt(m.year ?? '1970', 10),
    month: parseInt(m.month ?? '1', 10),
    day: parseInt(m.day ?? '1', 10),
    hour,
    minute: parseInt(m.minute ?? '0', 10),
    dow: DOW[m.weekday ?? 'Thu'] ?? 4,
  };
}

const isWeekend = (dow: number) => dow === 0 || dow === 6;

/**
 * Return the UTC Date at which this recipient should next be tried so the email
 * lands during local business hours — or `null` if it's fine to send right now.
 */
export function localSendDeferral(
  now: Date,
  state: string | null | undefined,
  seed = '',
  opts: LocalTimingOpts = DEFAULT_LOCAL_TIMING,
): Date | null {
  const tz = STATE_TZ[(state ?? '').trim().toUpperCase()] ?? DEFAULT_TZ;
  const p = partsInTz(now, tz);

  const dayOk = !(opts.skipWeekends && isWeekend(p.dow));
  const inWindow = p.hour >= opts.openHour && p.hour < opts.closeHour;
  if (dayOk && inWindow) return null;   // good to send now

  /* How many days forward to the next eligible day. Today still works if it's an
     eligible day and we're simply before the window opened; otherwise roll
     forward, skipping weekends when configured. */
  let addDays: number;
  if (dayOk && p.hour < opts.openHour) {
    addDays = 0;
  } else {
    addDays = 1;
    while (opts.skipWeekends && isWeekend((p.dow + addDays) % 7)) addDays++;
  }

  /* Spread the target across the morning window on its own minute (per-recipient,
     stable) so a batch never fires at one exact time. Convert the local wall time
     to a UTC instant via the offset observed at `now`. Across a DST flip the target
     may land ±1h off — acceptable for a morning send. */
  const localWallMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const nowFloorMs = Math.floor(now.getTime() / 60000) * 60000;
  const offsetMs = localWallMs - nowFloorMs;

  const mins = jitterMinutes(seed, opts.morningWindowMin);
  const targetHour = opts.morningStartHour + Math.floor(mins / 60);
  const targetMin = mins % 60;

  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  base.setUTCDate(base.getUTCDate() + addDays);
  const targetWallMs = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), targetHour, targetMin);
  const target = new Date(targetWallMs - offsetMs);

  /* Never return a time in the past (e.g. clock-skew edge): fall back to send-now. */
  return target.getTime() > now.getTime() ? target : null;
}
