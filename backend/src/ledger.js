// A double-entry ledger. Every money event is one "journal": a set of entries
// that add up to exactly zero, so money is never created or lost by a bug.
// Entries are never edited or deleted. A mistake is fixed with a new journal
// that points back at the old one (reversal_of).
//
// Sign rule: positive = debit, negative = credit. Money the company owes to people
// (liabilities) and revenue sit on the credit side, so their balance is -sum.
//
// Accounts (owner id after the colon):
//   rider_credit:ID     liability  prepaid commission credit, free to use
//   rider_reserved:ID   liability  credit set aside for accepted cash trips
//   rider_payable:ID    liability  digital earnings the company owes the rider
//   rider_withdrawal:ID liability  withdrawals requested and not yet finished
//   passenger_wallet:ID liability  passenger prepaid balance
//   company_commission  revenue    commission Smart Boda has earned
//   provider_clearing   asset      money sitting with the payment provider (LivePay)
//   company_bank        asset      company bank / mobile money, outside the provider
//
// All amounts are whole UGX.

import { randomUUID } from 'node:crypto';

export const LIABILITY_PREFIXES = ['rider_credit', 'rider_reserved', 'rider_payable', 'rider_withdrawal', 'passenger_wallet'];

/** Negate without producing -0. */
const neg = (n) => (n === 0 ? 0 : -n);

const isLiability = (account) => LIABILITY_PREFIXES.some((p) => account.startsWith(`${p}:`)) || account === 'company_commission';

/**
 * Post one journal. Does nothing and returns false if this reference was already posted,
 * so retries and duplicate callbacks cannot move money twice.
 * Call inside a transaction when other changes must succeed or fail together with it.
 */
export function post(db, { ref, kind, memo = null, tripId = null, actorId = null, reversalOf = null, at, entries }) {
  if (!ref || typeof ref !== 'string') throw new RangeError('a journal needs a unique reference');
  if (!Array.isArray(entries) || entries.length < 2) throw new RangeError('a journal needs at least two entries');
  let sum = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.amount) || e.amount === 0) throw new RangeError('entry amounts must be whole, non-zero UGX');
    sum += e.amount;
  }
  if (sum !== 0) throw new RangeError('journal does not balance');
  const id = randomUUID();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO ledger_journals (id, ref, kind, memo, trip_id, actor_id, reversal_of, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, ref, kind, memo, tripId, actorId, reversalOf, at);
  if (res.changes !== 1) return false;
  const add = db.prepare('INSERT INTO ledger_entries (journal_id, account, amount) VALUES (?,?,?)');
  for (const e of entries) add.run(id, e.account, e.amount);
  return true;
}

/** Sum of all entries on an account (debit positive). */
export function rawBalance(db, account) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE account = ?').get(account).v;
}

/** What the company holds for or owes on this account: liabilities and revenue are shown positive. */
export function balance(db, account) {
  const raw = rawBalance(db, account);
  return isLiability(account) ? neg(raw) : raw;
}

/** The journal that was posted for a reference, if any. */
export const findJournal = (db, ref) => db.prepare('SELECT * FROM ledger_journals WHERE ref = ?').get(ref);

/** Reverse a posted journal with a linked journal (the original stays untouched). */
export function reverse(db, { ref, originalRef, memo, actorId, at }) {
  const orig = findJournal(db, originalRef);
  if (!orig) throw new RangeError('nothing to reverse');
  const entries = db.prepare('SELECT account, amount FROM ledger_entries WHERE journal_id = ?').all(orig.id);
  return post(db, {
    ref, kind: `reversal:${orig.kind}`, memo, tripId: orig.trip_id, actorId, reversalOf: orig.id, at,
    entries: entries.map((e) => ({ account: e.account, amount: -e.amount })),
  });
}

/** Every journal must add up to zero. Returns the ones that do not (should always be empty). */
export function unbalancedJournals(db) {
  return db
    .prepare(
      `SELECT j.id, j.ref, SUM(e.amount) AS total FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
       GROUP BY j.id HAVING total <> 0`,
    )
    .all();
}

/** Totals per account type for the admin dashboard. */
export function companyPosition(db) {
  const sumPrefix = (prefix) =>
    db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE account LIKE ? || ':%'").get(prefix).v;
  return {
    commissionRevenue: neg(rawBalance(db, 'company_commission')),
    unusedRiderCredit: neg(sumPrefix('rider_credit')),
    reservedRiderCredit: neg(sumPrefix('rider_reserved')),
    riderPayable: neg(sumPrefix('rider_payable')),
    pendingWithdrawals: neg(sumPrefix('rider_withdrawal')),
    passengerWallets: neg(sumPrefix('passenger_wallet')),
    providerClearing: rawBalance(db, 'provider_clearing'),
    companyBank: rawBalance(db, 'company_bank'),
  };
}
