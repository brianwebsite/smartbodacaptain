// Money held for people on Smart Boda, as a ledger: every change is a row,
// and the balance is the sum of the rows. Amounts are whole UGX.
// Positive = money in, negative = money out.
//
// Passengers: topup / admin_credit (+), trip_payment (-).
// Captains:   trip_earning (+, for trips paid from the wallet), payout (-).

import { randomUUID } from 'node:crypto';

export const LEDGER_KINDS = Object.freeze([
  'topup',
  'admin_credit',
  'admin_debit',
  'trip_payment',
  'trip_earning',
  'payout',
  'commission_netted',
]);

const HOLD_STATUSES = ['requested', 'accepted', 'arrived', 'in_progress'];

export function balance(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM wallet_ledger WHERE user_id = ?').get(userId).v;
}

/** Money already promised to trips that are still running. */
export function held(db, userId) {
  const marks = HOLD_STATUSES.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT COALESCE(SUM(fare),0) AS v FROM trips
       WHERE passenger_id = ? AND payment_method = 'wallet' AND status IN (${marks})`,
    )
    .get(userId, ...HOLD_STATUSES).v;
}

export const available = (db, userId) => balance(db, userId) - held(db, userId);

/** Adds one ledger row. A trip can pay or earn only once, so a repeat does nothing. */
export function addEntry(db, { userId, amount, kind, tripId = null, note = null, at }) {
  if (!Number.isInteger(amount) || amount === 0) throw new RangeError('amount must be a whole number above or below 0');
  if (!LEDGER_KINDS.includes(kind)) throw new RangeError(`unknown ledger kind: ${kind}`);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO wallet_ledger (id, user_id, amount, kind, trip_id, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), userId, amount, kind, tripId, note, at);
  return res.changes === 1;
}

export function entries(db, userId, limit = 50) {
  return db
    .prepare(
      `SELECT id, amount, kind, trip_id AS tripId, note, created_at AS createdAt
       FROM wallet_ledger WHERE user_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(userId, limit)
    .map((r) => ({ ...r }));
}
