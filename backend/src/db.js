// Database: SQLite through Node's built-in node:sqlite (no packages needed).
// One small server process is plenty for a pilot. The schema is plain SQL so
// it can move to PostgreSQL later.

import { DatabaseSync } from 'node:sqlite';

import * as ledger from './ledger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','captain','admin')),
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','pending','suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captain_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  bike_plate TEXT NOT NULL,
  bike_model TEXT,
  national_id TEXT NOT NULL,
  permit_number TEXT NOT NULL,
  stage_name TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  location_at TEXT
);

CREATE TABLE IF NOT EXISTS trip_messages (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS trip_messages_trip ON trip_messages(trip_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  passenger_id TEXT NOT NULL REFERENCES users(id),
  captain_id TEXT REFERENCES users(id),
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  pickup_label TEXT,
  dropoff_lat REAL NOT NULL,
  dropoff_lng REAL NOT NULL,
  dropoff_label TEXT,
  distance_km REAL NOT NULL,
  duration_min REAL NOT NULL,
  route_source TEXT NOT NULL,
  fare INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  captain_earnings INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  history TEXT NOT NULL,
  rating INTEGER,
  rating_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS trips_passenger ON trips(passenger_id, created_at);
CREATE INDEX IF NOT EXISTS trips_captain ON trips(captain_id, created_at);

CREATE TABLE IF NOT EXISTS declines (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  captain_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, captain_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  captain_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  memo TEXT,
  trip_id TEXT,
  actor_id TEXT,
  reversal_of TEXT REFERENCES ledger_journals(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id TEXT NOT NULL REFERENCES ledger_journals(id),
  account TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount <> 0)
);
CREATE INDEX IF NOT EXISTS ledger_entries_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS ledger_entries_journal ON ledger_entries(journal_id);
-- Posted entries are history: they can never be changed or deleted.
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'ledger entries cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'ledger entries cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS ledger_journals_no_update BEFORE UPDATE ON ledger_journals
  BEGIN SELECT RAISE(ABORT, 'ledger journals cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS ledger_journals_no_delete BEFORE DELETE ON ledger_journals
  BEGIN SELECT RAISE(ABORT, 'ledger journals cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  kind TEXT NOT NULL,
  trip_id TEXT REFERENCES trips(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_user ON wallet_ledger(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_once_per_trip ON wallet_ledger(trip_id, kind, user_id) WHERE trip_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS topups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  internal_reference TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS topups_user ON topups(user_id, created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Add columns that older databases do not have yet. */
function migrate(db) {
  // Older databases required a phone number. Email-only passengers need it optional.
  const phoneCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'phone');
  if (phoneCol && phoneCol.notnull === 1) rebuildUsersWithOptionalPhone(db);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!cols.includes('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  const addColumn = (table, column, ddl) => {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  addColumn('captain_profiles', 'vehicle_type', "TEXT NOT NULL DEFAULT 'boda'");
  addColumn('trips', 'vehicle_type', "TEXT NOT NULL DEFAULT 'boda'");
  addColumn('trips', 'cancel_reason', 'TEXT');
  addColumn('trips', 'cancelled_by', 'TEXT');
  addColumn('topups', 'purpose', "TEXT NOT NULL DEFAULT 'passenger_wallet'");
  addColumn('trips', 'kind', "TEXT NOT NULL DEFAULT 'ride'");
  addColumn('trips', 'delivery_item', 'TEXT');
  addColumn('trips', 'receiver_name', 'TEXT');
  addColumn('trips', 'receiver_phone', 'TEXT');
  addColumn('trips', 'night_percent', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('trips', 'auto_started', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('topups', 'error', 'TEXT');
  addColumn('trips', 'receipt_emailed_at', 'TEXT');
  addColumn('users', 'backup_phone', 'TEXT');
  addColumn('users', 'photo', 'BLOB');
  addColumn('users', 'photo_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('trips', 'pickup_pin', 'TEXT');
  addColumn('trips', 'pin_attempts', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('trips', 'pin_verified', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('trips', 'commission_rate', 'REAL');
  addColumn('trips', 'cancelled_from', 'TEXT');
  addColumn('trips', 'cancel_distance_m', 'INTEGER');
  addColumn('trips', 'passenger_rating', 'INTEGER');
  addColumn('trips', 'passenger_rating_comment', 'TEXT');
  moveOldWalletRows(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
}

/** Entries from the first, single-entry wallet become balanced journals once. */
function moveOldWalletRows(db) {
  const rows = db
    .prepare(
      `SELECT w.id, w.user_id, w.amount, w.kind, w.created_at, u.role FROM wallet_ledger w JOIN users u ON u.id = w.user_id
       ORDER BY w.rowid`,
    )
    .all();
  for (const r of rows) {
    const account = r.role === 'captain' ? `rider_payable:${r.user_id}` : `passenger_wallet:${r.user_id}`;
    ledger.post(db, {
      ref: `legacy:${r.id}`, kind: `legacy_${r.kind}`, memo: 'Moved from the first wallet', at: r.created_at,
      entries: [{ account: 'company_bank', amount: r.amount }, { account, amount: -r.amount }],
    });
  }
}

function rebuildUsersWithOptionalPhone(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const have = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const opt = (c) => (have.includes(c) ? c : 'NULL');
    db.exec(`CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('passenger','captain','admin')),
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','pending','suspended')),
      created_at TEXT NOT NULL,
      email TEXT,
      google_sub TEXT
    )`);
    db.exec(`INSERT INTO users_new (id, role, name, phone, password_hash, status, created_at, email, google_sub)
             SELECT id, role, name, phone, password_hash, status, created_at, ${opt('email')}, ${opt('google_sub')} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Run fn inside one all-or-nothing transaction. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
