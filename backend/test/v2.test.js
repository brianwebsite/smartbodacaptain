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
import * as wallet from '../src/wallet.js';

const PICKUP = { lat: 0.355, lng: 32.615 };
const DROPOFF = { lat: 0.39, lng: 32.64 };
const NEAR = { lat: 0.3551, lng: 32.615 };

async function harness({ start = '2026-11-16T10:00:00Z', mailer = null, push = null } = {}) {
  const db = openDb(':memory:');
  const clock = { ms: Date.parse(start) };
  const { server } = createApp({
    db, routing: estimateRouting(), mailer, push, now: () => new Date(clock.ms).toISOString(),
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
    await call('POST', `/api/admin/users/${r.body.user.id}/wallet`, { amount: 100000, note: 'test credit' }, adminToken);
    const on = await call('POST', '/api/captain/presence', { online: true, ...where }, r.body.token);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return { token: r.body.token, id: r.body.user.id };
  };
  const request = (p, extra = {}) =>
    call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF, paymentMethod: 'cash', ...extra }, p.token);
  const accept = (c, id) => call('POST', `/api/trips/${id}/accept`, {}, c.token);
  const step = (c, id, what) => call('POST', `/api/trips/${id}/${what}`, what === 'start' || what === 'complete' ? { pin: db.prepare('SELECT pickup_pin FROM trips WHERE id = ?').get(id).pickup_pin } : {}, c.token);
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
  assert.equal(after.body.entries[0].kind, 'digital_trip');
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

// ---------- LivePay top-ups (LivePay itself is replaced by a stand-in) ----------
import { createHmac } from 'node:crypto';
import { livepayClient } from '../src/livepay.js';

async function lpHarness() {
  const lp = { collects: [], remote: new Map(), refuse: false, down: false };
  const fetchImpl = async (url, opts = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).endsWith('/collect-money')) {
      const b = JSON.parse(opts.body);
      if (lp.down) throw new Error('network');
      lp.collects.push(b);
      if (lp.refuse) return json(400, { success: false });
      lp.remote.set(b.reference, { status: 'Pending', amount: b.amount, internal_reference: 'LP-' + b.reference });
      return json(200, { success: true, internal_reference: 'LP-' + b.reference });
    }
    const ref = new URL(url).searchParams.get('reference');
    const r = lp.remote.get(ref);
    if (!r) return json(404, { success: false });
    return json(200, { success: true, status: r.status, customer_reference: ref, amount: r.amount, currency: 'UGX', internal_reference: r.internal_reference });
  };
  const livepay = livepayClient({ enabled: true, apiKey: 'k', accountNumber: 'acc', webhookSecret: 'whsec', fetchImpl });
  const db = openDb(':memory:');
  const { server } = createApp({ db, routing: estimateRouting(), livepay, publicUrl: 'https://sb.example', now: () => new Date().toISOString() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const reg = await call('POST', '/api/auth/register', { role: 'passenger', name: 'Amina', phone: '0773999001', password: 'secret123' });
  return { lp, call, token: reg.body.token, id: reg.body.user.id, close: () => new Promise((r) => server.close(r)) };
}

test('top-up: money is added only after LivePay confirms it, and only once', async () => {
  const h = await lpHarness();
  assert.equal((await h.call('GET', '/api/wallet', undefined, h.token)).body.topupAvailable, true);
  const r = await h.call('POST', '/api/wallet/topup', { amount: 20000, phone: '0772123456' }, h.token);
  assert.equal(r.status, 200);
  assert.equal(h.lp.collects[0].phoneNumber, '0772123456');
  assert.equal(h.lp.collects[0].amount, 20000);
  const ref = r.body.reference;

  let s = await h.call('GET', `/api/wallet/topup/${ref}`, undefined, h.token);
  assert.equal(s.body.status, 'pending');
  assert.equal(s.body.balance, 0);

  h.lp.remote.get(ref).status = 'Success';
  s = await h.call('GET', `/api/wallet/topup/${ref}`, undefined, h.token);
  assert.equal(s.body.status, 'success');
  assert.equal(s.body.balance, 20000);
  await h.call('GET', `/api/wallet/topup/${ref}`, undefined, h.token);
  assert.equal((await h.call('GET', '/api/wallet', undefined, h.token)).body.balance, 20000); // not twice
  await h.close();
});

test('top-up: a wrong amount from LivePay, a refusal and a failure never add money', async () => {
  const h = await lpHarness();
  const a = (await h.call('POST', '/api/wallet/topup', { amount: 5000, phone: '0772123456' }, h.token)).body.reference;
  h.lp.remote.get(a).status = 'Success';
  h.lp.remote.get(a).amount = 1000; // does not match what we asked for
  assert.equal((await h.call('GET', `/api/wallet/topup/${a}`, undefined, h.token)).body.status, 'pending');
  h.lp.remote.get(a).status = 'Failed';
  assert.equal((await h.call('GET', `/api/wallet/topup/${a}`, undefined, h.token)).body.status, 'failed');

  h.lp.refuse = true;
  const refused = await h.call('POST', '/api/wallet/topup', { amount: 5000, phone: '0772123456' }, h.token);
  assert.equal(refused.status, 502);
  assert.equal((await h.call('GET', '/api/wallet', undefined, h.token)).body.balance, 0);

  assert.equal((await h.call('POST', '/api/wallet/topup', { amount: 10, phone: '0772123456' }, h.token)).status, 400);
  assert.equal((await h.call('POST', '/api/wallet/topup', { amount: 5000, phone: '0412123456' }, h.token)).status, 400);
  await h.close();
});

test('top-up: a network error is never retried, and the next wallet visit settles it', async () => {
  const h = await lpHarness();
  h.lp.down = true;
  const r = await h.call('POST', '/api/wallet/topup', { amount: 5000, phone: '0772123456' }, h.token);
  assert.equal(r.status, 200); // might still have reached LivePay, so we keep it pending
  assert.equal(h.lp.collects.length, 0);
  h.lp.down = false;
  h.lp.remote.set(r.body.reference, { status: 'Success', amount: 5000, internal_reference: 'x' });
  assert.equal((await h.call('GET', '/api/wallet', undefined, h.token)).body.balance, 5000);
  await h.close();
});

test('webhook: only a correctly signed call is accepted', async () => {
  const h = await lpHarness();
  const ref = (await h.call('POST', '/api/wallet/topup', { amount: 5000, phone: '0772123456' }, h.token)).body.reference;
  h.lp.remote.get(ref).status = 'Success';
  const body = { customer_reference: ref, internal_reference: 'LP-' + ref, status: 'Success' };
  const t = String(Math.floor(Date.now() / 1000));
  const sign = (secret) => `t=${t},v=${createHmac('sha256', secret).update(`https://sb.example/api/livepay-webhook${t}customer_reference${ref}internal_reference${body.internal_reference}statusSuccess`).digest('hex')}`;
  const bad = await h.call('POST', '/api/livepay-webhook', body, null, { 'x-webhook-signature': sign('wrong') });
  assert.equal(bad.status, 401);
  const good = await h.call('POST', '/api/livepay-webhook', body, null, { 'x-webhook-signature': sign('whsec') });
  assert.equal(good.status, 200);
  assert.equal((await h.call('GET', '/api/wallet', undefined, h.token)).body.balance, 5000);
  await h.close();
});

test('receipt emails go to passenger and rider once; a phone is needed to request a ride', async () => {
  const sent = [];
  const h = await harness({ mailer: { send: async (m) => sent.push(m) } });
  const pax = await h.passenger({ phone: undefined, email: 'amina@example.com' });
  const cap = await h.captain();
  // An email-only passenger must add a phone first, so the rider can call.
  const noPhone = await h.request(pax);
  assert.equal(noPhone.status, 409);
  assert.equal(noPhone.body.code, 'phone_needed');
  assert.equal((await h.call('PUT', '/api/me/phone', { phone: 'abc' }, pax.token)).status, 400);
  const ok = await h.call('PUT', '/api/me/phone', { phone: '0772555111' }, pax.token);
  assert.equal(ok.body.user.phone, '+256772555111');

  const t = await h.request(pax);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  await h.accept(cap, t.body.trip.id);
  const view = (await h.call('GET', `/api/trips/${t.body.trip.id}`, undefined, cap.token)).body.trip;
  assert.equal(view.passenger.phone, '+256772555111'); // the captain can now call
  await h.finish(cap, t.body.trip.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1); // only the passenger has an email
  assert.equal(sent[0].to, 'amina@example.com');
  assert.match(sent[0].subject, /^Your Smart Boda receipt SB-/);
  assert.match(sent[0].text, /Fare: UGX/);
  assert.ok(!/commission/i.test(sent[0].text)); // the passenger never sees the rider's side
  await h.step(cap, t.body.trip.id, 'complete'); // a repeat does not send again
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  await h.close();
});

test('push notifications reach the right phone at each step, and dead tokens are dropped', async () => {
  const sent = [];
  const push = {
    send: async (token, m) => {
      sent.push({ token, ...m });
      return token === 'dead-token-dead-token-dead' ? 'unregistered' : 'sent';
    },
  };
  const h = await harness({ push });
  const wait = () => new Promise((r) => setTimeout(r, 40));
  const pax = await h.passenger();
  const cap = await h.captain();
  const stranger = await h.captain();
  assert.equal((await h.call('PUT', '/api/me/push-token', { token: 'short' }, pax.token)).status, 400);
  await h.call('PUT', '/api/me/push-token', { token: 'passenger-phone-token-0000001' }, pax.token);
  await h.call('PUT', '/api/me/push-token', { token: 'captain-phone-token-000000001' }, cap.token);
  await h.call('PUT', '/api/me/push-token', { token: 'dead-token-dead-token-dead' }, stranger.token);

  const t = await h.request(pax);
  await wait();
  const offers = sent.filter((m) => m.data.type === 'offer');
  assert.deepEqual(offers.map((m) => m.token).sort(), ['captain-phone-token-000000001', 'dead-token-dead-token-dead']);
  // the dead token is removed so we stop trying it
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM push_tokens WHERE token = 'dead-token-dead-token-dead'").get().c, 0);

  sent.length = 0;
  await h.accept(cap, t.body.trip.id);
  await h.step(cap, t.body.trip.id, 'arrived');
  await wait();
  const toPassenger = sent.filter((m) => m.token === 'passenger-phone-token-0000001').map((m) => m.title);
  assert.deepEqual(toPassenger, ['Captain on the way', 'Your captain has arrived']);

  sent.length = 0;
  await h.call('POST', `/api/trips/${t.body.trip.id}/messages`, { body: 'I am at the gate' }, pax.token);
  await h.call('POST', `/api/trips/${t.body.trip.id}/cancel`, {}, pax.token);
  await wait();
  assert.ok(sent.some((m) => m.token === 'captain-phone-token-000000001' && m.body === 'I am at the gate'));
  assert.ok(sent.some((m) => m.token === 'captain-phone-token-000000001' && m.title === 'Trip cancelled'));
  assert.ok(!sent.some((m) => m.token === 'passenger-phone-token-0000001')); // you are not told about your own action
  await h.close();
});

test('FCM client signs with the service account and sends a notification', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { fcmFromEnv } = await import('../src/fcm.js');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', expires_in: 3600 }) };
    return { ok: true, status: 200 };
  };
  assert.equal(fcmFromEnv(''), null);
  assert.equal(fcmFromEnv('not json'), null);
  const fcm = fcmFromEnv(JSON.stringify({ client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey, project_id: 'proj-1' }), { fetchImpl });
  assert.equal(await fcm.send('tok', { title: 'Hi', body: 'There', data: { tripId: 5 } }), 'sent');
  await fcm.send('tok2', { title: 'Hi', body: 'Again' });
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1); // the access token is reused
  const sentCall = calls.find((c) => c.url.includes('/projects/proj-1/messages:send'));
  assert.equal(sentCall.opts.headers.Authorization, 'Bearer at-1');
  const msg = JSON.parse(sentCall.opts.body).message;
  assert.equal(msg.notification.title, 'Hi');
  assert.equal(msg.data.tripId, '5');
  const jwt = String(calls[0].opts.body.get('assertion')).split('.');
  assert.equal(jwt.length, 3);
  assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
});

test('a captain who drives on past the destination without finishing is charged for the extra distance', async () => {
  const h = await harness();
  const cap = await h.captain('boda', NEAR);
  const p = await h.passenger();
  const t = await h.request(p);
  const id = t.body.trip.id;
  await h.accept(cap, id);
  assert.equal((await h.step(cap, id, 'arrived')).status, 200);
  assert.equal((await h.step(cap, id, 'start')).status, 200);
  const trip = h.db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  const at = (lat) => h.call('POST', '/api/captain/location', { lat, lng: 32.64 }, cap.token);
  const status = () => h.db.prepare('SELECT status FROM trips WHERE id = ?').get(id).status;

  await at(0.3905); // reaches the drop-off area, but does not finish the trip
  assert.equal(status(), 'in_progress');
  await at(0.3941); // 400 m past
  await at(0.3985);
  assert.equal(status(), 'in_progress'); // not far enough yet
  assert.ok(h.db.prepare('SELECT overrun_commission AS c FROM trips WHERE id = ?').get(id).c > 0);
  await at(0.4030);
  await at(0.4070); // more than 1.5 km of extra distance
  assert.equal(status(), 'completed');
  const done = h.db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  assert.ok(done.overrun_commission >= 100);
  assert.equal(wallet.creditFree(h.db, cap.id), 100000 - trip.commission - done.overrun_commission);
  assert.equal(wallet.creditReserved(h.db, cap.id), 0);
  // The captain sees the extra charge on his receipt, the passenger does not.
  const cr = (await h.call('GET', `/api/trips/${id}/receipt`, undefined, cap.token)).body.receipt;
  assert.equal(cr.overrunCommission, done.overrun_commission);
  const pr = (await h.call('GET', `/api/trips/${id}/receipt`, undefined, p.token)).body.receipt;
  assert.equal(pr.overrunCommission, undefined);
  await h.close();
});

test('a finished trip with no captain activity for hours is closed by the system and the commission is charged', async () => {
  const h = await harness();
  const cap = await h.captain('boda', NEAR);
  const p = await h.passenger();
  const t = await h.request(p);
  const id = t.body.trip.id;
  await h.accept(cap, id);
  await h.step(cap, id, 'arrived');
  await h.step(cap, id, 'start');
  const trip = h.db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  h.clock.ms += 5 * 3600 * 1000; // phone switched off for five hours
  await h.call('GET', '/api/captain/offers', undefined, cap.token);
  assert.equal(h.db.prepare('SELECT status FROM trips WHERE id = ?').get(id).status, 'completed');
  assert.equal(wallet.creditFree(h.db, cap.id), 100000 - trip.commission);
  await h.close();
});

test('push test: tells the person exactly what is missing', async () => {
  const sent = [];
  const push = { send: async (token, m) => { sent.push({ token, ...m }); return 'sent'; } };
  const off = await harness();
  const a = await off.passenger();
  const none = (await off.call('POST', '/api/me/push-test', {}, a.token)).body;
  assert.equal(none.ok, false);
  assert.match(none.message, /FIREBASE_SERVICE_ACCOUNT/);
  await off.close();

  const h = await harness({ push });
  const p = await h.passenger();
  assert.match((await h.call('POST', '/api/me/push-test', {}, p.token)).body.message, /not registered/);
  await h.call('PUT', '/api/me/push-token', { token: 'passenger-phone-token-0000001' }, p.token);
  const ok = (await h.call('POST', '/api/me/push-test', {}, p.token)).body;
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
  const st = (await h.call('GET', '/api/admin/push-status', undefined, h.adminToken)).body;
  assert.equal(st.on, true);
  assert.equal(st.phones.passengers, 1);
  assert.equal((await h.call('GET', '/api/admin/push-status', undefined, p.token)).status, 403);
  await h.close();
});

test('delivery: no code to start, the code confirms the handover at the end', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  const t = await h.request(p, { kind: 'delivery', deliveryItem: 'Shoes', receiverName: 'Joan', receiverPhone: '0772 111222' });
  const id = t.body.trip.id;
  await h.accept(cap, id);
  assert.equal((await h.call('POST', `/api/trips/${id}/arrived`, {}, cap.token)).status, 200);
  // Starting needs no code.
  assert.equal((await h.call('POST', `/api/trips/${id}/start`, {}, cap.token)).status, 200);
  // The sender still sees the code on the way, to give to the receiver.
  const pin = h.db.prepare('SELECT pickup_pin FROM trips WHERE id = ?').get(id).pickup_pin;
  assert.equal((await h.call('GET', `/api/trips/${id}`, undefined, p.token)).body.trip.pickupPin, pin);
  assert.equal((await h.call('GET', `/api/trips/${id}`, undefined, cap.token)).body.trip.pickupPin, undefined);
  // The phone cannot finish a delivery by itself at the drop-off.
  h.clock.ms += 200_000;
  await h.call('POST', '/api/captain/location', DROPOFF, cap.token);
  assert.equal(h.db.prepare('SELECT status FROM trips WHERE id = ?').get(id).status, 'in_progress');
  // Completing needs the code.
  assert.equal((await h.call('POST', `/api/trips/${id}/complete`, {}, cap.token)).status, 400);
  const wrong = String((Number(pin) + 1) % 10000).padStart(4, '0');
  assert.equal((await h.call('POST', `/api/trips/${id}/complete`, { pin: wrong }, cap.token)).body.code, 'wrong_pin');
  assert.equal((await h.call('POST', `/api/trips/${id}/complete`, { pin }, cap.token)).status, 200);
  assert.equal(h.db.prepare('SELECT status FROM trips WHERE id = ?').get(id).status, 'completed');
  assert.equal((await h.call('GET', `/api/trips/${id}`, undefined, p.token)).body.trip.pickupPin, undefined);
  await h.close();
});

test('captains see earnings only for trips paid from the app wallet', async () => {
  const h = await harness();
  const cap = await h.captain();
  const p = await h.passenger();
  await h.credit(p, 50000);
  const cash = (await h.request(p, { paymentMethod: 'cash' })).body.trip.id;
  await h.accept(cap, cash);
  assert.equal((await h.call('GET', '/api/captain/current', undefined, cap.token)).body.trip.captainEarnings, null);
  await h.finish(cap, cash);
  const wal = (await h.request(p, { paymentMethod: 'wallet' })).body.trip.id;
  await h.accept(cap, wal);
  assert.ok((await h.call('GET', '/api/captain/current', undefined, cap.token)).body.trip.captainEarnings > 0);
  await h.finish(cap, wal);
  const receipt = (id) => h.call('GET', `/api/trips/${id}/receipt`, undefined, cap.token).then((r) => r.body.receipt);
  assert.equal((await receipt(cash)).riderEarnings, undefined);
  assert.ok((await receipt(cash)).commission > 0);
  assert.ok((await receipt(wal)).riderEarnings > 0);
  const e = (await h.call('GET', '/api/captain/earnings', undefined, cap.token)).body;
  const walletEarn = h.db.prepare("SELECT captain_earnings AS e FROM trips WHERE id = ?").get(wal).e;
  assert.equal(e.totals.net, walletEarn);
  assert.equal(e.totals.trips, 2);
  await h.close();
});
