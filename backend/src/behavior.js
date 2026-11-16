// Fair-play rules. People who keep cancelling trips that someone already
// accepted waste other people's time and money, so:
//
//  Captains:   2 cancels in 24 h = warning, 3 = offered fewer trips (they rank as if
//              twice as far away), 5 = no offers for 60 minutes.
//  Passengers: 2 cancels in 24 h = warning, 4 = cannot request for 60 minutes.
//
// Only cancels after a captain accepted count. Cancelling while still
// "finding a captain" is free. The numbers are constants here on purpose:
// change them after watching real behaviour.

export const RULES = Object.freeze({
  windowHours: 24,
  captain: { warnAt: 2, slowAt: 3, pauseAt: 5, pauseMinutes: 60, slowFactor: 2 },
  passenger: { warnAt: 2, blockAt: 4, blockMinutes: 60 },
});

const sinceIso = (nowIso) => new Date(Date.parse(nowIso) - RULES.windowHours * 3600 * 1000).toISOString();

/** { captainId -> {count, lastAt} } of cancels by captains inside the window. */
export function captainCancelCounts(db, nowIso) {
  const rows = db
    .prepare(
      `SELECT captain_id AS id, COUNT(*) AS count, MAX(updated_at) AS lastAt FROM trips
       WHERE status = 'cancelled' AND cancelled_by = 'captain' AND captain_id IS NOT NULL AND updated_at >= ?
       GROUP BY captain_id`,
    )
    .all(sinceIso(nowIso));
  return new Map(rows.map((r) => [r.id, { count: r.count, lastAt: r.lastAt }]));
}

export function passengerCancelCount(db, userId, nowIso) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS lastAt FROM trips
       WHERE passenger_id = ? AND status = 'cancelled' AND cancelled_by = 'passenger'
         AND captain_id IS NOT NULL AND updated_at >= ?`,
    )
    .get(userId, sinceIso(nowIso));
}

const addMinutes = (iso, min) => new Date(Date.parse(iso) + min * 60000).toISOString();

/**
 * How a captain stands right now.
 * @returns {{level:'ok'|'warning'|'slowed'|'paused', cancels:number, rankFactor:number, pausedUntil:string|null, message:string|null}}
 */
export function captainStanding(entry, nowIso) {
  const r = RULES.captain;
  const count = entry?.count ?? 0;
  const out = { level: 'ok', cancels: count, rankFactor: 1, pausedUntil: null, message: null };
  if (count >= r.pauseAt) {
    const until = addMinutes(entry.lastAt, r.pauseMinutes);
    if (Date.parse(until) > Date.parse(nowIso)) {
      return {
        ...out,
        level: 'paused',
        rankFactor: r.slowFactor,
        pausedUntil: until,
        message: `You cancelled ${count} trips in a day, so you will not get trip offers until ${until}. Please only accept trips you will do.`,
      };
    }
  }
  if (count >= r.slowAt) {
    return {
      ...out,
      level: 'slowed',
      rankFactor: r.slowFactor,
      message: `You cancelled ${count} trips today, so you are offered fewer trips. Finish the trips you accept to get back to normal.`,
    };
  }
  if (count >= r.warnAt) {
    return {
      ...out,
      level: 'warning',
      message: `Warning: you cancelled ${count} accepted trips today. More cancellations will move you down the list.`,
    };
  }
  return out;
}

/**
 * How a passenger stands right now.
 * @returns {{level:'ok'|'warning'|'blocked', cancels:number, blockedUntil:string|null, message:string|null}}
 */
export function passengerStanding({ count, lastAt }, nowIso) {
  const r = RULES.passenger;
  const out = { level: 'ok', cancels: count, blockedUntil: null, message: null };
  if (count >= r.blockAt) {
    const until = addMinutes(lastAt, r.blockMinutes);
    if (Date.parse(until) > Date.parse(nowIso)) {
      return {
        ...out,
        level: 'blocked',
        blockedUntil: until,
        message: `You cancelled ${count} trips after a captain accepted, so you cannot request a ride until ${until}.`,
      };
    }
  }
  if (count >= r.warnAt) {
    return {
      ...out,
      level: 'warning',
      message: `Warning: you cancelled ${count} trips after a captain accepted. Captains lose time and money when this happens. Too many cancellations will stop you from requesting rides for a while.`,
    };
  }
  return out;
}
