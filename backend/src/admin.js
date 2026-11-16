// Creates (or repairs) the admin account from the ADMIN_PHONE / ADMIN_PASSWORD settings.
// The settings are the source of truth: change the password there, redeploy, and it changes here.

import { randomUUID } from 'node:crypto';

import { hashPassword, verifyPassword } from './auth.js';
import { normalizeUgPhone } from './phone.js';

/** Hosting dashboards sometimes keep quote marks or spaces typed around a value. */
const clean = (v) => String(v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string,string|undefined>} env
 * @param {(msg: string) => void} log
 */
export function ensureAdmin(db, env, log = console.log) {
  const rawPhone = clean(env.ADMIN_PHONE);
  const password = clean(env.ADMIN_PASSWORD);
  if (!rawPhone && !password) {
    log('Admin: ADMIN_PHONE and ADMIN_PASSWORD are not set, so no admin account is created.');
    return;
  }
  if (!rawPhone || !password) {
    log('Admin: set BOTH ADMIN_PHONE and ADMIN_PASSWORD. No admin was created.');
    return;
  }
  let phone;
  try {
    phone = normalizeUgPhone(rawPhone);
  } catch {
    log('Admin: ADMIN_PHONE is not a Uganda mobile number like 0772123456. No admin was created.');
    return;
  }
  if (password.length < 10) {
    log('Admin: ADMIN_PASSWORD must be at least 10 characters. No admin was created.');
    return;
  }

  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (existing && existing.role !== 'admin') {
    log(`Admin: the phone ${phone} already belongs to a ${existing.role} account, so it cannot be the admin. Use another number.`);
    return;
  }
  if (existing) {
    if (!verifyPassword(password, existing.password_hash)) {
      db.prepare('UPDATE users SET password_hash = ?, status = ? WHERE id = ?').run(hashPassword(password), 'active', existing.id);
      log(`Admin: password for ${phone} updated from ADMIN_PASSWORD.`);
    } else {
      log(`Admin: account ${phone} is ready.`);
    }
    return;
  }
  db.prepare(
    'INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(randomUUID(), 'admin', clean(env.ADMIN_NAME) || 'Admin', phone, hashPassword(password), 'active', new Date().toISOString());
  log(`Admin: account ${phone} created.`);
}
