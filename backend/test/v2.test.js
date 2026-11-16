import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { estimateRouting } from '../src/routing.js';
import { hashPassword } from '../src/auth.js';
import { isNight } from '../src/night.js';

const PICKUP = { lat: 0.355, lng: 32.615 };
const DROPOFF = { lat: 0.39, lng: 32.64 };
const NEAR = { lat: 0.3551, lng: 32.615 };

async function harness({ start = '2026-11-16T10:00:00Z', mailer = null } = {}) {
  const db = openDb(':memory:');
  const clock = { ms: Date.parse(start) };
  const { server } = createApp({
    db, routing: estimateRouting(), mailer, now: () => new Date(clock.ms).toISOString(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  let n = 0;
  const phone = () => `07733${String(10000 + n++)}`;
  const passenger = async (extra = {}) => {
    const r = await call('POST', '/api/auth/register', { role: 'passenger', name: 'Amina', phone: phone(), password: 'secret123', ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { token: r.body.token, id: r.body.user.id };
  };
  const adminToken = await (async () => {
    db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), 'admin', 'Boss', '+256700000009', hashPassword('adminpass123'), 'active', new Date(clock.ms).toISOString());
    return (await call('POST', '/api/auth/login', { phone: '0700000009', password: 'adminpass123' })).body.token;
  })();
  const captain = async (vehicleType = 'boda', where = NEAR) => {
    const r = await call('POST', '/api/auth/register', {
      role: 'captain', name: 'Cap', phone: phone(), password: 'secret123', bikePlate: 'ueh 123x',
      nationalId: 'CM12345678ABCD', permitNumber: 'DP998877', vehicleType,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await call('POST', `/api/admin/captains/${r.body.user.id}/approve`, {}, adminToken);
    const on = await call('POST', '/api/captain/presence', { online: true, ...where }, r.body.token);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return { token: r.body.token, id: r.body.user.id };
  };
  const request = (p, extra = {}) =>
    call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF, paymentMethod: 'cash', ...extra }, p.token);
  const accept = (c, id) => call('POST', `/api/trips/${id}/accept`, {}, c.token);
  const step = (c, id, what) => call('POST', `/api/trips/${id}/${what}`, {}, c.token);
  const finish = async (c, id) => {
    for (const w of ['arrived', 'start', 'complete']) assert.equal((await step(c, id, w)).status, 200);
  };
  const credit = (p, amount) => call('POST', `/api/admin/users/${p.id}/wallet`, { amount, note: 'test' }, adminToken);
  return { db, call, passenger, captain, adminToken, clock, request, accept, step, finish, credit, close: () => new Promise((r) => server.close(r)) };
}

test('night window: 10 pm to 5 am Uganda time', () => {
  assert.equal(isNight('2026-11-16T19:00:00Z'), true); // 22:00
  assert.equal(isNight('2026-11-16T18:59:00Z'), false); // 21:59
  assert.equal(isNight('2026-11-16T01:59:00Z'), true); // 04:59
  assert.equal(isNight('2026-11-16T02:00:00Z'), false); // 05:00
});

test('fares are at least 5 percent higher at night, and the trip records it', async () => {
  const day = await harness({ start: '2026-11-16T10:00:00Z' });
  const night = await harness({ start: '2026-11-16T20:00:00Z' });
  const dp = await day.passenger();
  const np = await night.passenger();
  const body = { pickup: PICKUP, dropoff: DROPOFF };
  const d = (await day.call('POST', '/api/fare/estimate', body, dp.token)).body;
  const n = (await night.call('POST', '/api/fare/estimate', body, np.token)).body;
  assert.equal(d.nightPercent, 0);
  assert.equal(n.nightPercent, 5);
  assert.ok(n.fare >= Math.round(d.fare * 1.05) - 100, `${n.fare} vs ${d.fare}`);
  assert.ok(n.fare > d.fare);
  await night.captain();
  const t = await night.request(np);
  assert.equal(t.body.trip.nightPercent, 5);
  assert.equal(t.body.trip.fare, n.fare);
  await day.close();
  await night.close();
});

test('wallet: pay for a trip from the wallet; captain is credited once', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const poor = await h.request(p, { paymentMethod: 'wallet' });
  assert.equal(poor.status, 402);
  assert.equal(poor.body.code, 'insufficient_wallet');

  assert.equal((await h.credit(p, 50000)).body.balance, 50000);
  const t = await h.request(p, { paymentMethod: 'wallet' });
  assert.equal(t.status, 201);
  const fare = t.body.trip.fare;
  const mid = await h.call('GET', '/api/wallet', undefined, p.token);
  assert.equal(mid.body.balance, 50000);
  assert.equal(mid.body.available, 50000 - fare); // held while the trip runs

  await h.accept(cap, t.body.trip.id);
  await h.finish(cap, t.body.trip.id);
  assert.equal((await h.step(cap, t.body.trip.id, 'complete')).status, 409); // cannot pay twice

  const after = await h.call('GET', '/api/wallet', undefined, p.token);
  assert.equal(after.body.balance, 50000 - fare);
  assert.equal(after.body.held, 0);
  const capWallet = await h.call('GET', '/api/wallet', undefined, cap.token);
  assert.equal(capWallet.body.balance, Math.round(fare * 0.85));
  assert.equal(after.body.entries[0].kind, 'trip_payment');
  await h.close();
});

test('wallet earnings first pay off commission owed on cash trips', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  await h.credit(p, 100000);
  const cash = await h.request(p);
  await h.accept(cap, cash.body.trip.id);
  await h.finish(cap, cash.body.trip.id);
  const owed = (await h.call('GET', '/api/captain/earnings', undefined, cap.token)).body.commissionOwed;
  assert.ok(owed > 0);

  const paid = await h.request(p, { paymentMethod: 'wallet' });
  await h.accept(cap, paid.body.trip.id);
  await h.finish(cap, paid.body.trip.id);
  const e = (await h.call('GET', '/api/captain/earnings', undefined, cap.token)).body;
  assert.equal(e.commissionOwed, 0);
  assert.equal(e.walletBalance, paid.body.trip.fare - Math.round(paid.body.trip.fare * 0.15) - owed);
  await h.close();
});

test('admin can credit and debit wallets but not overdraw, and can pay out captains', async () => {
  const h = await harness();
  const p = await h.passenger();
  await h.credit(p, 10000);
  assert.equal((await h.credit(p, -20000)).status, 400);
  assert.equal((await h.credit(p, -4000)).body.balance, 6000);
  assert.equal((await h.call('POST', `/api/admin/users/${p.id}/wallet`, { amount: 5 }, p.token)).status, 403);
  const found = await h.call('GET', '/api/admin/users?q=amina', undefined, h.adminToken);
  assert.equal(found.body.users[0].walletBalance, 6000);
  const top = await h.call('POST', '/api/wallet/topup', { amount: 5000 }, p.token);
  assert.equal(top.body.code, 'topup_unavailable');
  await h.close();
});

test('delivery: needs the receiver details, is stored, and the captain sees them', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const missing = await h.request(p, { kind: 'delivery' });
  assert.equal(missing.status, 400);
  const t = await h.request(p, {
    kind: 'delivery', deliveryItem: 'A box of shoes', receiverName: 'Joan', receiverPhone: '0772 111222',
  });
  assert.equal(t.status, 201);
  assert.equal(t.body.trip.kind, 'delivery');
  await h.accept(cap, t.body.trip.id);
  const cur = await h.call('GET', '/api/captain/current', undefined, cap.token);
  assert.equal(cur.body.trip.receiverName, 'Joan');
  assert.equal(cur.body.trip.receiverPhone, '+256772111222');
  assert.equal(cur.body.trip.deliveryItem, 'A box of shoes');
  await h.close();
});

test('email-only passengers can sign up; captains still need a phone', async () => {
  const h = await harness();
  const r = await h.call('POST', '/api/auth/register', { role: 'passenger', name: 'Eve', email: 'eve@x.co', password: 'secret123' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.phone, null);
  const login = await h.call('POST', '/api/auth/login', { identifier: 'eve@x.co', password: 'secret123' });
  assert.equal(login.status, 200);
  const none = await h.call('POST', '/api/auth/register', { role: 'passenger', name: 'Eve', password: 'secret123' });
  assert.equal(none.status, 400);
  const cap = await h.call('POST', '/api/auth/register', {
    role: 'captain', name: 'Cap', email: 'cap@x.co', password: 'secret123', bikePlate: 'UEH 123X',
    nationalId: 'CM12345678ABCD', permitNumber: 'DP998877',
  });
  assert.equal(cap.status, 400);
  await h.close();
});

test('captains who keep cancelling get a warning, then fewer trips, then a pause', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const cancelOnce = async () => {
    const t = await h.request(p);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal((await h.accept(cap, t.body.trip.id)).status, 200);
    return h.call('POST', `/api/trips/${t.body.trip.id}/cancel`, { reason: 'too_far' }, cap.token);
  };
  assert.equal((await cancelOnce()).body.user.standing.level, 'ok');
  assert.equal((await cancelOnce()).body.user.standing.level, 'warning');
  assert.equal((await cancelOnce()).body.user.standing.level, 'slowed');
  await cancelOnce();
  const fifth = await cancelOnce();
  assert.equal(fifth.body.user.standing.level, 'paused');
  const offers = await h.request(p);
  const mine = await h.call('GET', '/api/captain/offers', undefined, cap.token);
  assert.deepEqual(mine.body.offers, []); // paused captains are not offered trips
  assert.equal((await h.accept(cap, offers.body.trip.id)).body.code, 'paused');
  await h.close();
});

test('passengers who keep cancelling accepted trips are warned, then blocked for a while', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const cancelOnce = async () => {
    const t = await h.request(p);
    if (t.status !== 201) return t;
    await h.accept(cap, t.body.trip.id);
    return h.call('POST', `/api/trips/${t.body.trip.id}/cancel`, { reason: 'changed_mind' }, p.token);
  };
  await cancelOnce();
  assert.equal((await cancelOnce()).body.user.standing.level, 'warning');
  await cancelOnce();
  assert.equal((await cancelOnce()).body.user.standing.level, 'blocked');
  const blocked = await h.request(p);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'blocked');
  h.clock.ms += 61 * 60 * 1000; // an hour later the block is over
  assert.equal((await h.request(p)).status, 201);
  await h.close();
});

test('cancelling before any captain accepted is free', async () => {
  const h = await harness();
  const p = await h.passenger();
  for (let i = 0; i < 5; i++) {
    const t = await h.request(p);
    assert.equal(t.status, 201);
    await h.call('POST', `/api/trips/${t.body.trip.id}/cancel`, {}, p.token);
  }
  assert.equal((await h.call('GET', '/api/me', undefined, p.token)).body.user.standing.level, 'ok');
  await h.close();
});

test('a captain who owes more commission than the limit cannot go online until they pay', async () => {
  const h = await harness();
  await h.call('PUT', '/api/admin/settings', { limits: { captainDebtLimit: 100 } }, h.adminToken);
  const cap = await h.captain();
  const p = await h.passenger();
  const t = await h.request(p);
  await h.accept(cap, t.body.trip.id);
  await h.finish(cap, t.body.trip.id);
  await h.call('POST', '/api/captain/presence', { online: false }, cap.token);
  const blocked = await h.call('POST', '/api/captain/presence', { online: true, ...NEAR }, cap.token);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'debt_limit');
  const owed = (await h.call('GET', '/api/captain/earnings', undefined, cap.token)).body.commissionOwed;
  await h.call('POST', `/api/admin/captains/${cap.id}/settle`, { amount: owed }, h.adminToken);
  assert.equal((await h.call('POST', '/api/captain/presence', { online: true, ...NEAR }, cap.token)).status, 200);
  await h.close();
});

test('the phone moves a trip along if the captain forgets to tap', async () => {
  const h = await harness();
  const cap = await h.captain('boda', { lat: 0.3600, lng: 32.615 });
  const p = await h.passenger();
  const t = await h.request(p);
  const id = t.body.trip.id;
  await h.accept(cap, id);
  const at = (loc) => h.call('POST', '/api/captain/location', loc, cap.token);
  const status = async () => (await h.call('GET', `/api/trips/${id}`, undefined, cap.token)).body.trip.status;

  await at({ lat: 0.357, lng: 32.615 }); // still ~220 m away
  assert.equal(await status(), 'accepted');
  await at(PICKUP);
  assert.equal(await status(), 'arrived');
  h.clock.ms += 50_000;
  await at({ lat: 0.3560, lng: 32.6150 }); // moved ~110 m: not far enough yet
  assert.equal(await status(), 'arrived');
  await at({ lat: 0.3575, lng: 32.615 }); // ~280 m away
  assert.equal(await status(), 'in_progress');
  assert.equal((await h.call('GET', `/api/trips/${id}`, undefined, cap.token)).body.trip.autoStarted, true);
  await at(DROPOFF); // right away: too soon to count as a real ride
  assert.equal(await status(), 'in_progress');
  h.clock.ms += 130_000;
  await at(DROPOFF);
  assert.equal(await status(), 'completed');
  await h.close();
});

test('captain can rate the passenger once', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const t = await h.request(p);
  await h.accept(cap, t.body.trip.id);
  await h.finish(cap, t.body.trip.id);
  assert.equal((await h.call('POST', `/api/trips/${t.body.trip.id}/rate-passenger`, { rating: 5 }, cap.token)).status, 200);
  assert.equal((await h.call('POST', `/api/trips/${t.body.trip.id}/rate-passenger`, { rating: 1 }, cap.token)).status, 409);
  const next = await h.request(p);
  await h.accept(cap, next.body.trip.id);
  const cur = await h.call('GET', '/api/captain/current', undefined, cap.token);
  assert.equal(cur.body.trip.passenger.rating, 5);
  await h.close();
});

test('forgot password: code by email, then a new password', async () => {
  const sent = [];
  const h = await harness({ mailer: { send: async (m) => sent.push(m) } });
  assert.equal((await h.call('GET', '/api/auth/options')).body.passwordReset, true);
  await h.call('POST', '/api/auth/register', { role: 'passenger', name: 'Eve', email: 'eve@x.co', password: 'oldpass123' });

  const unknown = await h.call('POST', '/api/auth/forgot', { email: 'nobody@x.co' });
  assert.equal(unknown.status, 200); // same answer, nothing sent
  assert.equal(sent.length, 0);

  assert.equal((await h.call('POST', '/api/auth/forgot', { email: 'EVE@x.co' })).status, 200);
  assert.equal(sent.length, 1);
  const code = sent[0].text.match(/\b(\d{6})\b/)[1];
  assert.equal((await h.call('POST', '/api/auth/reset', { email: 'eve@x.co', code: '000000', password: 'newpass123' })).status, 400);
  assert.equal((await h.call('POST', '/api/auth/reset', { email: 'eve@x.co', code, password: 'newpass123' })).status, 200);
  assert.equal((await h.call('POST', '/api/auth/reset', { email: 'eve@x.co', code, password: 'again12345' })).status, 400); // used
  assert.equal((await h.call('POST', '/api/auth/login', { identifier: 'eve@x.co', password: 'oldpass123' })).status, 401);
  assert.equal((await h.call('POST', '/api/auth/login', { identifier: 'eve@x.co', password: 'newpass123' })).status, 200);
  await h.close();
});

test('forgot password says so plainly when email is not set up, and codes expire', async () => {
  const off = await harness();
  const r = await off.call('POST', '/api/auth/forgot', { email: 'eve@x.co' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'email_unavailable');
  await off.close();

  const sent = [];
  const h = await harness({ mailer: { send: async (m) => sent.push(m) } });
  await h.call('POST', '/api/auth/register', { role: 'passenger', name: 'Eve', email: 'eve@x.co', password: 'oldpass123' });
  await h.call('POST', '/api/auth/forgot', { email: 'eve@x.co' });
  const code = sent[0].text.match(/\b(\d{6})\b/)[1];
  h.clock.ms += 16 * 60 * 1000;
  assert.equal((await h.call('POST', '/api/auth/reset', { email: 'eve@x.co', code, password: 'newpass123' })).status, 400);
  await h.close();
});

test('admin can reset anyone\'s password', async () => {
  const h = await harness();
  const p = await h.passenger();
  assert.equal((await h.call('POST', `/api/admin/users/${p.id}/password`, { password: 'brandnew1' }, h.adminToken)).status, 200);
  assert.equal((await h.call('GET', '/api/me', undefined, p.token)).status, 401); // old sessions end
  await h.close();
});

test('an old database that required a phone number is upgraded and keeps its people', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('passenger','captain','admin')), name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','pending','suspended')), created_at TEXT NOT NULL, email TEXT)`);
  old.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('u1', 'passenger', 'Old Timer', '+256772000001', 'x', 'active', '2026-01-01T00:00:00Z', 'o@x.co');
  old.close();

  const db = openDb(path);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
  assert.equal(row.name, 'Old Timer');
  assert.equal(row.email, 'o@x.co');
  db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('u2', 'passenger', 'No Phone', null, 'x', 'active', '2026-01-01T00:00:00Z');
  db.close();
  openDb(path).close(); // opening again is harmless
});
