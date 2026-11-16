// Starts the Smart Boda server. Settings come from environment variables.
//
//   PORT                 default 8080
//   DB_PATH              default ./data/smartboda.db
//   GOOGLE_MAPS_API_KEY  optional. Without it fares use a labelled distance estimate.
//   ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_NAME
//                        creates the first admin account if no admin exists yet
//   GOOGLE_CLIENT_ID     optional. The "Web" OAuth client ID; turns on Google sign-in for passengers.
//   PHOTON_URL           optional. Your own Photon place-search server (default: the free public one).
//   TRUST_PROXY          set to 1 when behind Caddy or another proxy

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openDb } from './db.js';
import { createApp } from './app.js';
import { chooseRouting } from './routing.js';
import { googleVerifier } from './google.js';
import { ensureAdmin } from './admin.js';
import { photonPlaces } from './places.js';
import { brevoMailer } from './mailer.js';
import { livepayClient } from './livepay.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const dbPath = process.env.DB_PATH ?? './data/smartboda.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

ensureAdmin(db, process.env);

const routing = chooseRouting({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
console.log(`Routing: ${routing.name}`);

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
console.log(`Google sign-in: ${googleClientId ? 'on' : 'off'}`);

const mailer = brevoMailer({ apiKey: process.env.BREVO_API_KEY?.trim(), from: process.env.MAIL_FROM?.trim() });
console.log(`Password reset email: ${mailer ? 'on' : 'off'}`);

const livepay = livepayClient({
  enabled: process.env.LIVEPAY_ENABLED === 'true',
  apiKey: process.env.LIVEPAY_API_KEY?.trim(),
  accountNumber: process.env.LIVEPAY_ACCOUNT_NUMBER?.trim(),
  webhookSecret: process.env.LIVEPAY_WEBHOOK_SECRET?.trim(),
});
console.log(`LivePay top-ups: ${livepay ? 'on' : 'off'}`);

const { server } = createApp({
  mailer,
  livepay,
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
  db,
  routing,
  googleClientId,
  places: photonPlaces({ baseUrl: process.env.PHOTON_URL || undefined }),
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
