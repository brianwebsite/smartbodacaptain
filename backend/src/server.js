// Starts the Smart Boda server. Settings come from environment variables.
//
//   PORT                 default 8080
//   DB_PATH              default ./data/smartboda.db
//   GOOGLE_MAPS_API_KEY  optional. Without it fares use a labelled distance estimate.
//   ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_NAME
//                        creates the first admin account if no admin exists yet
//   GOOGLE_CLIENT_ID     optional. The "Web" OAuth client ID; turns on Google sign-in for passengers.
//   TRUST_PROXY          set to 1 when behind Caddy or another proxy

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDb } from './db.js';
import { createApp } from './app.js';
import { chooseRouting } from './routing.js';
import { hashPassword } from './auth.js';
import { normalizeUgPhone } from './phone.js';
import { googleVerifier } from './google.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const dbPath = process.env.DB_PATH ?? './data/smartboda.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

function ensureAdmin() {
  const { ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_PHONE || !ADMIN_PASSWORD) return;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  if (ADMIN_PASSWORD.length < 10) {
    console.error('ADMIN_PASSWORD must be at least 10 characters. No admin was created.');
    return;
  }
  db.prepare(
    'INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    randomUUID(), 'admin', ADMIN_NAME ?? 'Admin', normalizeUgPhone(ADMIN_PHONE),
    hashPassword(ADMIN_PASSWORD), 'active', new Date().toISOString(),
  );
  console.log('Created the first admin account.');
}
ensureAdmin();

const routing = chooseRouting({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
console.log(`Routing: ${routing.name}`);

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
console.log(`Google sign-in: ${googleClientId ? 'on' : 'off'}`);

const { server } = createApp({
  db,
  routing,
  googleClientId,
  googleVerify: googleClientId ? googleVerifier([googleClientId]) : null,
  trustProxy: process.env.TRUST_PROXY === '1',
  adminHtmlPath: new URL('../../admin/index.html', import.meta.url),
});

server.listen(port, () => console.log(`Smart Boda API listening on port ${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
