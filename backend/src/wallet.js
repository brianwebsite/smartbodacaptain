// Per-person views of the ledger, plus the money moves the apps trigger.
//
// Passengers: one wallet (passenger_wallet).
// Riders:     prepaid commission credit (free + reserved) and digital earnings payable.

import * as ledger from './ledger.js';

const acct = {
  credit: (id) => `rider_credit:${id}`,
  reserved: (id) => `rider_reserved:${id}`,
  payable: (id) => `rider_payable:${id}`,
  withdrawal: (id) => `rider_withdrawal:${id}`,
  wallet: (id) => `passenger_wallet:${id}`,
};
export { acct };

const HOLD_STATUSES = ['requested', 'accepted', 'arrived', 'in_progress'];

// ---------- passengers ----------

export const balance = (db, userId) => ledger.balance(db, acct.wallet(userId));

/** Fares already promised to digital trips that are still running. */
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

// ---------- riders ----------

export const creditFree = (db, riderId) => ledger.balance(db, acct.credit(riderId));
export const creditReserved = (db, riderId) => ledger.balance(db, acct.reserved(riderId));
export const earningsPayable = (db, riderId) => ledger.balance(db, acct.payable(riderId));
export const pendingWithdrawals = (db, riderId) => ledger.balance(db, acct.withdrawal(riderId));

// ---------- money in ----------

/** Provider-confirmed top-up: passenger wallet or rider commission credit. */
export function postTopup(db, { userId, role, amount, topupId, at }) {
  return ledger.post(db, {
    ref: `topup:${topupId}`, kind: role === 'captain' ? 'credit_topup' : 'wallet_topup', memo: `Mobile money ${topupId}`, at,
    entries: [
      { account: 'provider_clearing', amount },
      { account: role === 'captain' ? acct.credit(userId) : acct.wallet(userId), amount: -amount },
    ],
  });
}

/** Staff adds money they received outside the provider (cash at the office, bank deposit). */
export function postManual(db, { userId, role, amount, actorId, note, at, ref }) {
  const target = role === 'captain' ? acct.credit(userId) : acct.wallet(userId);
  return ledger.post(db, {
    ref, kind: amount > 0 ? 'admin_credit' : 'admin_debit', memo: note, actorId, at,
    entries: [
      { account: 'company_bank', amount },
      { account: target, amount: -amount },
    ],
  });
}

// ---------- trips ----------

/** Cash trip accepted: set the commission aside so it cannot be spent twice. Returns false if already reserved. */
export function reserveCommission(db, { riderId, tripId, commission, at }) {
  return ledger.post(db, {
    ref: `reserve:${tripId}`, kind: 'commission_reserved', tripId, at,
    entries: [
      { account: acct.credit(riderId), amount: commission },
      { account: acct.reserved(riderId), amount: -commission },
    ],
  });
}

/** The destination changed after the commission was set aside: move the reservation to the new amount. */
export function adjustReservation(db, { riderId, tripId, from, to, seq, at }) {
  const delta = to - from;
  if (delta === 0 || !ledger.findJournal(db, `reserve:${tripId}`)) return false;
  return ledger.post(db, {
    ref: `reserve-adjust:${tripId}:${seq}`, kind: 'commission_reserved', tripId, at,
    memo: 'Destination changed',
    entries: [
      { account: acct.credit(riderId), amount: delta },
      { account: acct.reserved(riderId), amount: -delta },
    ],
  });
}

/** Cash trip cancelled or expired: give the reserved credit back, once. */
export function releaseCommission(db, { riderId, tripId, commission, at }) {
  if (!ledger.findJournal(db, `reserve:${tripId}`)) return false;
  if (ledger.findJournal(db, `commission:${tripId}`)) return false; // already charged, nothing to release
  return ledger.post(db, {
    ref: `release:${tripId}`, kind: 'commission_released', tripId, at,
    entries: [
      { account: acct.reserved(riderId), amount: commission },
      { account: acct.credit(riderId), amount: -commission },
    ],
  });
}

/** Cash trip completed: the reservation becomes one commission charge. */
export function chargeCommission(db, { riderId, tripId, commission, at }) {
  const reserved = ledger.findJournal(db, `reserve:${tripId}`) && !ledger.findJournal(db, `release:${tripId}`);
  return ledger.post(db, {
    ref: `commission:${tripId}`, kind: 'commission_charged', tripId, at,
    entries: [
      // Trips accepted before reservations existed are charged straight from free credit.
      { account: reserved ? acct.reserved(riderId) : acct.credit(riderId), amount: commission },
      { account: 'company_commission', amount: -commission },
    ],
  });
}

/**
 * A captain who drove on past the destination without finishing the trip: the meter kept running,
 * so the commission on the extra distance is taken from his account. It may take his credit below zero.
 */
export function chargeOverrun(db, { riderId, tripId, amount, digital, at }) {
  if (!(amount > 0)) return false;
  return ledger.post(db, {
    ref: `overrun:${tripId}`, kind: 'overrun_commission', tripId, at,
    memo: 'Commission on distance driven past the destination',
    entries: [
      { account: digital ? acct.payable(riderId) : acct.credit(riderId), amount },
      { account: 'company_commission', amount: -amount },
    ],
  });
}

/** Digital trip completed: passenger pays, company keeps commission, rider is owed the rest. */
export function settleDigitalTrip(db, { passengerId, riderId, tripId, fare, commission, earnings, at }) {
  return ledger.post(db, {
    ref: `trip:${tripId}`, kind: 'digital_trip', tripId, at,
    entries: [
      { account: acct.wallet(passengerId), amount: fare },
      { account: 'company_commission', amount: -commission },
      { account: acct.payable(riderId), amount: -earnings },
    ],
  });
}

// ---------- history shown to people ----------

const LABEL_ACCOUNT = { wallet: 'passenger_wallet', credit: 'rider_credit', reserved: 'rider_reserved', earnings: 'rider_payable' };

/** One person's money history, newest first, in plain terms. */
export function entries(db, userId, limit = 60) {
  const rows = db
    .prepare(
      `SELECT j.rowid AS rid, j.kind, j.memo, j.trip_id, j.created_at,
         COALESCE(SUM(CASE WHEN e.account = ? THEN e.amount END),0) AS wallet,
         COALESCE(SUM(CASE WHEN e.account IN (?,?) THEN e.amount END),0) AS credit,
         COALESCE(SUM(CASE WHEN e.account = ? THEN e.amount END),0) AS earnings
       FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
       WHERE e.account IN (?,?,?,?)
       GROUP BY j.id ORDER BY j.rowid DESC LIMIT ?`,
    )
    .all(
      acct.wallet(userId), acct.credit(userId), acct.reserved(userId), acct.payable(userId),
      acct.wallet(userId), acct.credit(userId), acct.reserved(userId), acct.payable(userId), limit,
    );
  const out = [];
  for (const r of rows) {
    // Liabilities are credits (negative), so the person's balance moves by minus the sum.
    for (const [account, v] of [['wallet', -r.wallet], ['credit', -r.credit], ['earnings', -r.earnings]]) {
      if (v !== 0) out.push({ kind: r.kind, account, amount: v, note: r.memo, tripId: r.trip_id, createdAt: r.created_at });
    }
  }
  return out;
}
export { LABEL_ACCOUNT };
