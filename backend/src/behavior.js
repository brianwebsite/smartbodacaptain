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

// ---- Review flags -------------------------------------------------------
// These only point a person at records worth a look. They never charge or
// block anyone: GPS can be wrong, so a human decides.

export const FLAG_RULES = Object.freeze({
  windowDays: 7,
  manyCancels: 3, // cancels after a captain accepted
  lateCancels: 2, // cancels after the captain said "arrived"
  nearPickupCancels: 2, // captain cancelled while within nearPickupMeters of pickup
  nearPickupMeters: 150,
  unverifiedStarts: 3, // completed trips that started without the passenger's PIN
});

/** A list of { userId, name, role, code, message, count, tripIds } for the admin to review. */
export function reviewFlags(db, nowIso) {
  const since = new Date(Date.parse(nowIso) - FLAG_RULES.windowDays * 86400000).toISOString();
  const out = [];
  const add = (r, code, message, rows) =>
    out.push({ userId: r.id, name: r.name, phone: r.phone, role: r.role, code, message, count: rows.length, tripIds: rows.map((x) => x.id) });

  const cancelled = db
    .prepare(
      `SELECT t.id, t.cancelled_by, t.cancelled_from, t.cancel_distance_m, t.passenger_id, t.captain_id
       FROM trips t WHERE t.status = 'cancelled' AND t.captain_id IS NOT NULL AND t.updated_at >= ?`,
    )
    .all(since);
  const user = (id) => db.prepare('SELECT id, name, phone, role FROM users WHERE id = ?').get(id);
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
    return m;
  };
  const byCaptain = group(cancelled.filter((r) => r.cancelled_by === 'captain'), 'captain_id');
  for (const [id, rows] of byCaptain) {
    const u = user(id);
    if (rows.length >= FLAG_RULES.manyCancels) add(u, 'many_cancels', `Cancelled ${rows.length} accepted trips in ${FLAG_RULES.windowDays} days`, rows);
    const late = rows.filter((r) => r.cancelled_from === 'arrived');
    if (late.length >= FLAG_RULES.lateCancels) add(u, 'late_cancels', `Cancelled ${late.length} trips after arriving at the pickup`, late);
    const near = rows.filter((r) => r.cancel_distance_m != null && r.cancel_distance_m <= FLAG_RULES.nearPickupMeters);
    if (near.length >= FLAG_RULES.nearPickupCancels) {
      add(u, 'cancel_near_pickup', `Cancelled ${near.length} trips while within ${FLAG_RULES.nearPickupMeters} m of the passenger (may be taking them privately)`, near);
    }
  }
  const byPassenger = group(cancelled.filter((r) => r.cancelled_by === 'passenger'), 'passenger_id');
  for (const [id, rows] of byPassenger) {
    if (rows.length >= FLAG_RULES.manyCancels) add(user(id), 'many_cancels', `Cancelled ${rows.length} accepted trips in ${FLAG_RULES.windowDays} days`, rows);
  }
  const unverified = db
    .prepare(
      `SELECT id, captain_id FROM trips WHERE status = 'completed' AND pin_verified = 0 AND pickup_pin IS NOT NULL AND completed_at >= ?`,
    )
    .all(since);
  for (const [id, rows] of group(unverified, 'captain_id')) {
    if (rows.length >= FLAG_RULES.unverifiedStarts) add(user(id), 'unverified_starts', `${rows.length} trips started without the passenger's PIN`, rows);
  }
  return out;
}
