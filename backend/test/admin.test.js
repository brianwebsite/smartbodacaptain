import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { ensureAdmin } from '../src/admin.js';
import { verifyPassword } from '../src/auth.js';

const run = (db, env) => {
  const lines = [];
  ensureAdmin(db, env, (m) => lines.push(m));
  return lines.join('\n');
};
const admins = (db) => db.prepare("SELECT * FROM users WHERE role = 'admin'").all();

test('creates the admin, ignoring quotes and spaces typed around the settings', () => {
  const db = openDb(':memory:');
  run(db, { ADMIN_PHONE: ' "0772123456" ', ADMIN_PASSWORD: " 'LongPassword123' " });
  const [a] = admins(db);
  assert.equal(a.phone, '+256772123456');
  assert.ok(verifyPassword('LongPassword123', a.password_hash));
});

test('changing ADMIN_PASSWORD changes the admin password; running twice is harmless', () => {
  const db = openDb(':memory:');
  const env = { ADMIN_PHONE: '0772123456', ADMIN_PASSWORD: 'LongPassword123' };
  run(db, env);
  assert.match(run(db, env), /is ready/);
  assert.match(run(db, { ...env, ADMIN_PASSWORD: 'AnotherPassword9' }), /updated/);
  const all = admins(db);
  assert.equal(all.length, 1);
  assert.ok(verifyPassword('AnotherPassword9', all[0].password_hash));
  assert.ok(!verifyPassword('LongPassword123', all[0].password_hash));
});

test('says plainly what is wrong instead of failing quietly', () => {
  const db = openDb(':memory:');
  assert.match(run(db, {}), /not set/);
  assert.match(run(db, { ADMIN_PHONE: '0772123456' }), /BOTH/);
  assert.match(run(db, { ADMIN_PHONE: 'abc', ADMIN_PASSWORD: 'LongPassword123' }), /not a Uganda mobile/);
  assert.match(run(db, { ADMIN_PHONE: '0772123456', ADMIN_PASSWORD: 'short' }), /at least 10/);
  assert.equal(admins(db).length, 0);

  db.prepare("INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES ('p','passenger','P','+256772123456','x','active','2026-01-01')").run();
  assert.match(run(db, { ADMIN_PHONE: '0772123456', ADMIN_PASSWORD: 'LongPassword123' }), /already belongs to a passenger/);
  assert.equal(admins(db).length, 0);
});
