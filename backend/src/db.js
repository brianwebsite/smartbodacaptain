// Database: SQLite through Node's built-in node:sqlite (no packages needed).
// One small server process is plenty for a pilot. The schema is plain SQL so
// it can move to PostgreSQL later.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','captain','admin')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
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
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!cols.includes('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
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
