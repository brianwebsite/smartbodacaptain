// Night fares: a percentage added to every fare between two hours of the day,
// in Uganda time (UTC+3, no daylight saving).

const UGANDA_OFFSET_HOURS = 3;

export const DEFAULT_NIGHT = Object.freeze({ percent: 5, startHour: 22, endHour: 5 });

/** Hour of day (0-23) in Uganda for an ISO time. */
export function ugandaHour(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError('bad time');
  return (new Date(ms).getUTCHours() + UGANDA_OFFSET_HOURS) % 24;
}

/** True when the hour is inside the night window, which may cross midnight. */
export function isNight(iso, cfg = DEFAULT_NIGHT) {
  const h = ugandaHour(iso);
  const { startHour: s, endHour: e } = cfg;
  if (s === e) return false;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

/** The surcharge percent that applies at this time (0 outside the night window). */
export function nightPercent(iso, cfg = DEFAULT_NIGHT) {
  return isNight(iso, cfg) ? cfg.percent : 0;
}
