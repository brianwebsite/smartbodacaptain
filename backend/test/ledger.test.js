import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { estimateRouting } from '../src/routing.js';
import { hashPassword } from '../src/auth.js';
import { livepayClient } from '../src/livepay.js';
import * as ledger from '../src/ledger.js';
import * as wallet from '../src/wallet.js';

const PICKUP = { lat: 0.355, lng: 32.615 };
const DROPOFF = { lat: 0.39, lng: 32.64 };
const NEAR = { lat: 0.3551, lng: 32.615 };

async function harness() {
  const lp = { remote: new Map() };
  const fetchImpl = async (url, opts = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).endsWith('/collect-money')) {
      const b = JSON.parse(opts.body);
      lp.remote.set(b.reference, { status: 'Pending', amount: b.amount, internal_reference: `LP-${b.reference}` });
      return json(200, { success: true, internal_reference: `LP-${b.reference}` });
    }
    const ref = new URL(url).searchParams.get('reference');
    const r = lp.remote.get(ref);
    return r ? json(200, { success: true, ...r, customer_reference: ref, currency: 'UGX' }) : json(404, { success: false });
  };
  const livepay = livepayClient({ enabled: true, apiKey: 'k', accountNumber: 'a', webhookSecret: 's', fetchImpl });
  const db = openDb(':memory:');
  const clock = { ms: Date.parse('2026-11-16T10:00:00Z') };
  const { server } = createApp({ db, routing: estimateRouting(), livepay, now: () => new Date(clock.ms).toISOString() });
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
  db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), 'admin', 'Boss', '+256700000009', hashPassword('adminpass123'), 'active', new Date(clock.ms).toISOString());
  const admin = (await call('POST', '/api/auth/login', { phone: '0700000009', password: 'adminpass123' })).body.token;
  // A flat UGX 5,000 fare with 10% commission = UGX 500, the example in the brief.
  await call('PUT', '/api/admin/settings', { fare: { baseFare: 5000, perKm: 0, perMinute: 0, minimumFare: 5000, commissionRate: 0.1, roundTo: 100 } }, admin);
  let n = 0;
  const phone = () => `07744${String(10000 + n++)}`;
  const passenger = async () => {
    const r = await call('POST', '/api/auth/register', { role: 'passenger', name: 'Amina', phone: phone(), password: 'secret123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  const rider = async () => {
    const r = await call('POST', '/api/auth/register', {
      role: 'captain', name: 'Rider', phone: phone(), password: 'secret123', bikePlate: 'UEH 123X',
      nationalId: 'CM12345678ABCD', permitNumber: 'DP998877',
    });
    await call('POST', `/api/admin/captains/${r.body.user.id}/approve`, {}, admin);
    await call('POST', '/api/captain/presence', { online: true, ...NEAR }, r.body.token);
    return { token: r.body.token, id: r.body.user.id };
  };
  const topUp = async (who, amount) => {
    const r = await call('POST', '/api/wallet/topup', { amount, phone: '0772123456' }, who.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    lp.remote.get(r.body.reference).status = 'Success';
    const s = await call('GET', `/api/wallet/topup/${r.body.reference}`, undefined, who.token);
    assert.equal(s.body.status, 'success');
    clock.ms += 11 * 60 * 1000; // past the top-up rate limit window
  };
  const request = (p, extra = {}) => call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF, paymentMethod: 'cash', ...extra }, p.token);
  const ping = (r) => call('POST', '/api/captain/location', NEAR, r.token); // the clock jumps in top-ups
  const accept = async (r, id) => {
    await ping(r);
    return call('POST', `/api/trips/${id}/accept`, {}, r.token);
  };
  const step = (r, id, what) => call('POST', `/api/trips/${id}/${what}`, {}, r.token);
  const bal = (r) => ({
    free: wallet.creditFree(db, r.id), reserved: wallet.creditReserved(db, r.id), payable: wallet.earningsPayable(db, r.id),
  });
  return { db, lp, call, admin, passenger, rider, topUp, request, accept, step, bal, clock, close: () => new Promise((r) => server.close(r)) };
}

test('the brief: UGX 10,000 top-up, UGX 5,000 cash ride, UGX 500 commission', async () => {
  const h = await harness();
  const rider = await h.rider();
  const pax = await h.passenger();
  await h.topUp(rider, 10000);
  assert.deepEqual(h.bal(rider), { free: 10000, reserved: 0, payable: 0 });
  assert.equal(ledger.companyPosition(h.db).commissionRevenue, 0); // a deposit is not revenue
  assert.equal(ledger.companyPosition(h.db).unusedRiderCredit, 10000);

  const t = (await h.request(pax)).body.trip;
  assert.equal(t.fare, 5000);
  assert.equal(t.commission, undefined); // the passenger never sees the rider's side
  await h.accept(rider, t.id);
  assert.deepEqual(h.bal(rider), { free: 9500, reserved: 500, payable: 0 }); // 500 set aside at accept
  for (const w of ['arrived', 'start', 'complete']) assert.equal((await h.step(rider, t.id, w)).status, 200);

  assert.deepEqual(h.bal(rider), { free: 9500, reserved: 0, payable: 0 }); // one deduction; no payout created
  const pos = ledger.companyPosition(h.db);
  assert.equal(pos.commissionRevenue, 500);
  assert.equal(pos.riderPayable, 0);
  const done = (await h.call('GET', `/api/trips/${t.id}`, undefined, rider.token)).body.trip;
  assert.equal(done.captainEarnings, 4500); // for reporting only: the rider already holds the cash
  assert.deepEqual(ledger.unbalancedJournals(h.db), []);
  await h.close();
});

test('the brief: a digital UGX 5,000 trip is UGX 500 commission and UGX 4,500 owed to the rider', async () => {
  const h = await harness();
  const rider = await h.rider();
  const pax = await h.passenger();
  await h.topUp(pax, 5000);
  const t = (await h.request(pax, { paymentMethod: 'wallet' })).body.trip;
  await h.accept(rider, t.id); // no commission credit needed for digital trips
  for (const w of ['arrived', 'start', 'complete']) await h.step(rider, t.id, w);
  const pos = ledger.companyPosition(h.db);
  assert.equal(pos.commissionRevenue, 500);
  assert.equal(pos.riderPayable, 4500);
  assert.equal(pos.passengerWallets, 0);
  assert.equal(h.bal(rider).payable, 4500);
  // totals stay separate: 5,000 fare = 500 revenue + 4,500 payable
  assert.equal(pos.commissionRevenue + pos.riderPayable, 5000);
  await h.close();
});

test('not enough commission credit: the cash trip is hidden, acceptance is refused, and the message says how much is missing', async () => {
  const h = await harness();
  const rider = await h.rider();
  const pax = await h.passenger();
  await h.topUp(rider, 1000);
  await h.call('POST', `/api/admin/users/${rider.id}/wallet`, { amount: -600, note: 'test setup' }, h.admin); // 400 left
  const t = (await h.request(pax)).body.trip;
  await h.call('POST', '/api/captain/location', NEAR, rider.token);
  const offers = await h.call('GET', '/api/captain/offers', undefined, rider.token);
  assert.deepEqual(offers.body.offers, []);
  assert.equal(offers.body.credit.creditNeeded, 100);
  const r = await h.accept(rider, t.id);
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'insufficient_credit');
  assert.match(r.body.error, /UGX 100 more/);
  assert.equal((await h.call('GET', '/api/wallet', undefined, rider.token)).status, 200); // balance and top-up stay reachable
  await h.close();
});

test('cancelling after accept releases the reservation exactly once', async () => {
  const h = await harness();
  const rider = await h.rider();
  const pax = await h.passenger();
  await h.topUp(rider, 10000);
  const t = (await h.request(pax)).body.trip;
  await h.accept(rider, t.id);
  assert.deepEqual(h.bal(rider), { free: 9500, reserved: 500, payable: 0 });
  assert.equal((await h.call('POST', `/api/trips/${t.id}/cancel`, { reason: 'too_far' }, rider.token)).status, 200);
  assert.deepEqual(h.bal(rider), { free: 10000, reserved: 0, payable: 0 });
  assert.equal((await h.call('POST', `/api/trips/${t.id}/cancel`, { reason: 'too_far' }, rider.token)).status, 409);
  assert.equal(wallet.releaseCommission(h.db, { riderId: rider.id, tripId: t.id, commission: 500, at: new Date().toISOString() }), false);
  assert.deepEqual(h.bal(rider), { free: 10000, reserved: 0, payable: 0 });
  assert.equal(ledger.companyPosition(h.db).commissionRevenue, 0);
  await h.close();
});

test('completing twice or retrying never charges twice', async () => {
  const h = await harness();
  const rider = await h.rider();
  const pax = await h.passenger();
  await h.topUp(rider, 10000);
  const t = (await h.request(pax)).body.trip;
  await h.accept(rider, t.id);
  await h.step(rider, t.id, 'arrived');
  await h.step(rider, t.id, 'start');
  const [a, b] = await Promise.all([h.step(rider, t.id, 'complete'), h.step(rider, t.id, 'complete')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await h.step(rider, t.id, 'complete')).status, 409);
  assert.deepEqual(h.bal(rider), { free: 9500, reserved: 0, payable: 0 });
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM ledger_journals WHERE ref = ?").get(`commission:${t.id}`).c, 1);
  // posting the same reference again is ignored
  assert.equal(wallet.chargeCommission(h.db, { riderId: rider.id, tripId: t.id, commission: 500, at: new Date().toISOString() }), false);
  await h.close();
});

test('two cash trips cannot spend the same credit', async () => {
  const h = await harness();
  const rider = await h.rider();
  const p1 = await h.passenger();
  const p2 = await h.passenger();
  await h.topUp(rider, 1000);
  await h.call('POST', `/api/admin/users/${rider.id}/wallet`, { amount: -500, note: 'test setup' }, h.admin); // exactly one commission left
  const t1 = (await h.request(p1)).body.trip;
  const t2 = (await h.request(p2)).body.trip;
  await h.call('POST', '/api/captain/location', NEAR, rider.token);
  const post = (id) => h.call('POST', `/api/trips/${id}/accept`, {}, rider.token);
  const [a, b] = await Promise.all([post(t1.id), post(t2.id)]);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
  assert.deepEqual(h.bal(rider), { free: 0, reserved: 500, payable: 0 });
  await h.close();
});

test('the ledger cannot be edited or deleted, and money moves only through balanced journals', async () => {
  const h = await harness();
  const rider = await h.rider();
  await h.topUp(rider, 10000);
  assert.throws(() => h.db.exec('UPDATE ledger_entries SET amount = 1'), /cannot be changed/);
  assert.throws(() => h.db.exec('DELETE FROM ledger_entries'), /cannot be deleted/);
  assert.throws(() => h.db.exec('DELETE FROM ledger_journals'), /cannot be deleted/);
  assert.throws(() => ledger.post(h.db, { ref: 'x', kind: 'bad', at: new Date().toISOString(), entries: [{ account: 'a', amount: 5 }, { account: 'b', amount: -4 }] }), /does not balance/);
  // a mistake is fixed with a linked reversal, and the original stays
  const ref = h.db.prepare("SELECT ref FROM ledger_journals WHERE kind = 'credit_topup'").get().ref;
  assert.equal(ledger.reverse(h.db, { ref: 'rev-1', originalRef: ref, memo: 'test', at: new Date().toISOString() }), true);
  assert.equal(wallet.creditFree(h.db, rider.id), 0);
  assert.equal(ledger.reverse(h.db, { ref: 'rev-1', originalRef: ref, at: new Date().toISOString() }), false);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM ledger_journals').get().c, 2);
  assert.deepEqual(ledger.unbalancedJournals(h.db), []);
  await h.close();
});

test('forged confirmations create no credit; manual credit needs a reason and an admin', async () => {
  const h = await harness();
  const rider = await h.rider();
  const r = await h.call('POST', '/api/wallet/topup', { amount: 10000, phone: '0772123456' }, rider.token);
  // the app saying "paid" changes nothing: only LivePay's own answer counts
  assert.equal((await h.call('GET', `/api/wallet/topup/${r.body.reference}?paid=true`, undefined, rider.token)).body.status, 'pending');
  assert.equal(wallet.creditFree(h.db, rider.id), 0);
  h.lp.remote.get(r.body.reference).amount = 100; // paid a different amount
  h.lp.remote.get(r.body.reference).status = 'Success';
  assert.equal((await h.call('GET', `/api/wallet/topup/${r.body.reference}`, undefined, rider.token)).body.status, 'pending');
  assert.equal(wallet.creditFree(h.db, rider.id), 0);

  const other = await h.rider();
  assert.equal((await h.call('POST', `/api/admin/users/${rider.id}/wallet`, { amount: 5000, note: 'x y z' }, other.token)).status, 403);
  assert.equal((await h.call('POST', `/api/admin/users/${rider.id}/wallet`, { amount: 5000 }, h.admin)).status, 400);
  assert.equal((await h.call('POST', `/api/admin/users/${rider.id}/wallet`, { amount: 5000, note: 'cash at office' }, h.admin)).status, 200);
  assert.equal(wallet.creditFree(h.db, rider.id), 5000);
  // one rider cannot read another's top-up
  assert.equal((await h.call('GET', `/api/wallet/topup/${r.body.reference}`, undefined, other.token)).status, 404);
  await h.close();
});
