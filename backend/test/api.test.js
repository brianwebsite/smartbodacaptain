import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { estimateRouting } from '../src/routing.js';
import { hashPassword } from '../src/auth.js';

const PICKUP = { lat: 0.355, lng: 32.615 };
const DROPOFF = { lat: 0.39, lng: 32.64 };
const NEAR = { lat: 0.356, lng: 32.615 };

async function harness() {
  const db = openDb(':memory:');
  const clock = { ms: Date.parse('2026-11-16T10:00:00Z') };
  const { server } = createApp({
    db,
    routing: estimateRouting(),
    now: () => new Date(clock.ms).toISOString(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, token) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json };
  }

  let n = 0;
  const phone = () => `07721${String(10000 + n++)}`; // 0772110000, 0772110001, ...

  async function passenger(name = 'Amina') {
    const p = phone();
    const r = await call('POST', '/api/auth/register', { role: 'passenger', name, phone: p, password: 'secret123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { token: r.body.token, id: r.body.user.id, phone: p };
  }

  async function captain(name = 'Moses') {
    const p = phone();
    const r = await call('POST', '/api/auth/register', {
      role: 'captain',
      name,
      phone: p,
      password: 'secret123',
      bikePlate: 'ueh 123x',
      bikeModel: 'Bajaj Boxer',
      nationalId: 'CM12345678ABCD',
      permitNumber: 'DP998877',
      stageName: 'Ntinda Stage',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { token: r.body.token, id: r.body.user.id, phone: p };
  }

  function admin() {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(id, 'admin', 'Boss', '+256700000001', hashPassword('adminpass123'), 'active', new Date(clock.ms).toISOString());
    return call('POST', '/api/auth/login', { phone: '0700000001', password: 'adminpass123' }).then((r) => r.body.token);
  }

  async function approvedCaptain(adminToken, name, location = NEAR) {
    const c = await captain(name);
    const a = await call('POST', `/api/admin/captains/${c.id}/approve`, {}, adminToken);
    assert.equal(a.status, 200);
    const on = await call('POST', '/api/captain/presence', { online: true, ...location }, c.token);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return c;
  }

  const close = () => new Promise((r) => server.close(r));
  return { db, clock, call, passenger, captain, admin, approvedCaptain, close };
}

test('health check answers', async () => {
  const h = await harness();
  const r = await h.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  await h.close();
});

test('registration, login and sign-in rules', async () => {
  const h = await harness();
  const p = await h.passenger();

  const dup = await h.call('POST', '/api/auth/register', {
    role: 'passenger', name: 'Again', phone: p.phone, password: 'secret123',
  });
  assert.equal(dup.status, 409);

  const badPhone = await h.call('POST', '/api/auth/register', {
    role: 'passenger', name: 'Bad', phone: '12345', password: 'secret123',
  });
  assert.equal(badPhone.status, 400);

  const shortPass = await h.call('POST', '/api/auth/register', {
    role: 'passenger', name: 'Short', phone: '0772999999', password: '123',
  });
  assert.equal(shortPass.status, 400);

  const noDocs = await h.call('POST', '/api/auth/register', {
    role: 'captain', name: 'No Docs', phone: '0772888888', password: 'secret123',
  });
  assert.equal(noDocs.status, 400);

  const login = await h.call('POST', '/api/auth/login', { phone: p.phone, password: 'secret123' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);

  const wrong = await h.call('POST', '/api/auth/login', { phone: p.phone, password: 'nope-nope' });
  assert.equal(wrong.status, 401);

  const me = await h.call('GET', '/api/me', undefined, login.body.token);
  assert.equal(me.body.user.role, 'passenger');

  const noToken = await h.call('GET', '/api/me');
  assert.equal(noToken.status, 401);

  await h.call('POST', '/api/auth/logout', {}, login.body.token);
  const after = await h.call('GET', '/api/me', undefined, login.body.token);
  assert.equal(after.status, 401);
  await h.close();
});

test('too many wrong passwords are blocked', async () => {
  const h = await harness();
  const p = await h.passenger();
  let last;
  for (let i = 0; i < 12; i++) {
    last = await h.call('POST', '/api/auth/login', { phone: p.phone, password: 'wrong-wrong' });
  }
  assert.equal(last.status, 429);
  await h.close();
});

test('people can only use their own role\'s routes', async () => {
  const h = await harness();
  const p = await h.passenger();
  const c = await h.captain();
  assert.equal((await h.call('GET', '/api/captain/offers', undefined, p.token)).status, 403);
  assert.equal((await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, c.token)).status, 403);
  assert.equal((await h.call('GET', '/api/admin/stats', undefined, p.token)).status, 403);
  await h.close();
});

test('a new captain must be approved before going online', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const c = await h.captain();
  assert.equal(c.token ? 1 : 0, 1);
  const early = await h.call('POST', '/api/captain/presence', { online: true, ...NEAR }, c.token);
  assert.equal(early.status, 403);
  assert.equal(early.body.code, 'pending_approval');

  const list = await h.call('GET', '/api/admin/captains?status=pending', undefined, adminToken);
  assert.equal(list.body.captains.length, 1);
  assert.equal(list.body.captains[0].bikePlate, 'UEH 123X');

  await h.call('POST', `/api/admin/captains/${c.id}/approve`, {}, adminToken);
  const ok = await h.call('POST', '/api/captain/presence', { online: true, ...NEAR }, c.token);
  assert.equal(ok.status, 200);

  await h.call('POST', `/api/admin/captains/${c.id}/suspend`, {}, adminToken);
  const blocked = await h.call('GET', '/api/captain/offers', undefined, c.token);
  assert.equal(blocked.status, 403);
  await h.close();
});

test('a full cash trip from request to rating, with earnings and commission', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger('Amina');
  const c = await h.approvedCaptain(adminToken, 'Moses');

  const est = await h.call('POST', '/api/fare/estimate', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  assert.equal(est.status, 200);
  assert.equal(est.body.source, 'estimate');
  assert.ok(est.body.fare >= 2000 && est.body.fare % 100 === 0);

  const req = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF, pickupLabel: 'Ntinda', dropoffLabel: 'Kira' }, p.token);
  assert.equal(req.status, 201);
  const tripId = req.body.trip.id;
  assert.equal(req.body.trip.status, 'requested');
  assert.equal(req.body.trip.fare, est.body.fare);
  assert.equal(req.body.trip.captain, null);

  const offers = await h.call('GET', '/api/captain/offers', undefined, c.token);
  assert.equal(offers.body.offers.length, 1);
  const offer = offers.body.offers[0];
  assert.equal(offer.trip.id, tripId);
  assert.equal(offer.trip.passenger.name, 'Amina');
  assert.ok(offer.distanceToPickupKm < 1);
  assert.equal(offer.trip.commission + offer.trip.captainEarnings, offer.trip.fare);

  const acc = await h.call('POST', `/api/trips/${tripId}/accept`, {}, c.token);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.trip.status, 'accepted');

  const cur = await h.call('GET', '/api/passenger/current', undefined, p.token);
  assert.equal(cur.body.trip.status, 'accepted');
  assert.equal(cur.body.trip.captain.name, 'Moses');
  assert.equal(cur.body.trip.captain.bikePlate, 'UEH 123X');
  assert.ok(cur.body.trip.captain.location);

  // The captain's moving location shows up for the passenger.
  await h.call('POST', '/api/captain/location', { lat: 0.3555, lng: 32.615 }, c.token);
  const moved = await h.call('GET', '/api/passenger/current', undefined, p.token);
  assert.equal(moved.body.trip.captain.location.lat, 0.3555);

  // Other captains see no offers once the trip is taken, and the captain sees their active trip.
  assert.deepEqual((await h.call('GET', '/api/captain/offers', undefined, c.token)).body.offers, []);
  assert.equal((await h.call('GET', '/api/captain/current', undefined, c.token)).body.trip.id, tripId);

  assert.equal((await h.call('POST', `/api/trips/${tripId}/start`, {}, c.token)).status, 409); // must arrive first
  assert.equal((await h.call('POST', `/api/trips/${tripId}/arrived`, {}, c.token)).body.trip.status, 'arrived');
  assert.equal((await h.call('POST', `/api/trips/${tripId}/start`, {}, c.token)).body.trip.status, 'in_progress');

  const lateCancel = await h.call('POST', `/api/trips/${tripId}/cancel`, {}, p.token);
  assert.equal(lateCancel.status, 409);

  h.clock.ms += 15 * 60 * 1000;
  const done = await h.call('POST', `/api/trips/${tripId}/complete`, {}, c.token);
  assert.equal(done.body.trip.status, 'completed');

  const after = await h.call('GET', '/api/passenger/current', undefined, p.token);
  assert.equal(after.body.trip, null);
  assert.equal(after.body.unrated.id, tripId);

  const rate = await h.call('POST', `/api/trips/${tripId}/rate`, { rating: 5, comment: 'Smooth ride' }, p.token);
  assert.equal(rate.status, 200);
  assert.equal((await h.call('POST', `/api/trips/${tripId}/rate`, { rating: 1 }, p.token)).status, 409);
  assert.equal((await h.call('POST', `/api/trips/${tripId}/rate`, { rating: 9 }, p.token)).status, 400);
  assert.equal((await h.call('GET', '/api/passenger/current', undefined, p.token)).body.unrated, null);

  const earn = await h.call('GET', '/api/captain/earnings?days=7', undefined, c.token);
  assert.equal(earn.body.totals.trips, 1);
  assert.equal(earn.body.totals.gross, est.body.fare);
  assert.equal(earn.body.totals.commission + earn.body.totals.net, est.body.fare);
  assert.equal(earn.body.byDay.length, 1);
  assert.equal(earn.body.commissionOwed, earn.body.totals.commission);

  const hist = await h.call('GET', '/api/trips/history', undefined, p.token);
  assert.equal(hist.body.trips.length, 1);

  // Admin records that the captain paid some commission.
  const owed = earn.body.commissionOwed;
  const settle = await h.call('POST', `/api/admin/captains/${c.id}/settle`, { amount: owed - 100, note: 'MoMo' }, adminToken);
  assert.equal(settle.body.commissionOwed, 100);

  const stats = await h.call('GET', '/api/admin/stats', undefined, adminToken);
  assert.equal(stats.body.completedTotal, 1);
  assert.equal(stats.body.grossTotal, est.body.fare);
  assert.equal(stats.body.passengers, 1);
  assert.equal(stats.body.captains, 1);
  await h.close();
});

test('only one captain can win a trip', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger();
  const c1 = await h.approvedCaptain(adminToken, 'One');
  const c2 = await h.approvedCaptain(adminToken, 'Two');
  const { body } = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  const id = body.trip.id;
  const [a, b] = await Promise.all([
    h.call('POST', `/api/trips/${id}/accept`, {}, c1.token),
    h.call('POST', `/api/trips/${id}/accept`, {}, c2.token),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  await h.close();
});

test('offers respect distance, declines, staleness and online status', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger();
  const near = await h.approvedCaptain(adminToken, 'Near');
  const far = await h.approvedCaptain(adminToken, 'Far', { lat: 0.45, lng: 32.7 });
  const { body } = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  const id = body.trip.id;

  assert.equal((await h.call('GET', '/api/captain/offers', undefined, far.token)).body.offers.length, 0);
  assert.equal((await h.call('GET', '/api/captain/offers', undefined, near.token)).body.offers.length, 1);

  // A captain who was not offered the trip cannot accept it.
  assert.equal((await h.call('POST', `/api/trips/${id}/accept`, {}, far.token)).status, 409);

  // Declining removes the offer for that captain only.
  await h.call('POST', `/api/trips/${id}/decline`, {}, near.token);
  assert.equal((await h.call('GET', '/api/captain/offers', undefined, near.token)).body.offers.length, 0);

  // Going offline removes a captain from dispatch.
  await h.call('POST', '/api/captain/presence', { online: false }, near.token);
  assert.equal((await h.call('GET', '/api/captain/offers', undefined, near.token)).body.offers.length, 0);
  await h.close();
});

test('a captain whose location report is old gets no offers', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger();
  const c = await h.approvedCaptain(adminToken, 'Quiet');
  await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  h.clock.ms += 61 * 1000; // location is now older than 60 seconds
  assert.equal((await h.call('GET', '/api/captain/offers', undefined, c.token)).body.offers.length, 0);
  await h.close();
});

test('a request nobody accepts ends as no_captain', async () => {
  const h = await harness();
  const p = await h.passenger();
  const { body } = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  h.clock.ms += 91 * 1000;
  const cur = await h.call('GET', '/api/passenger/current', undefined, p.token);
  assert.equal(cur.body.trip, null);
  const trip = await h.call('GET', `/api/trips/${body.trip.id}`, undefined, p.token);
  assert.equal(trip.body.trip.status, 'no_captain');
  // The passenger can now ask again.
  assert.equal((await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token)).status, 201);
  await h.close();
});

test('trip request rules', async () => {
  const h = await harness();
  const p = await h.passenger();
  assert.equal((await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token)).status, 201);
  assert.equal((await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token)).status, 409);

  const p2 = await h.passenger('Second');
  const momo = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF, paymentMethod: 'mobile_money' }, p2.token);
  assert.equal(momo.status, 400);
  assert.equal(momo.body.code, 'payment_unavailable');

  const same = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: PICKUP }, p2.token);
  assert.equal(same.status, 400);

  const far = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: { lat: 2.77, lng: 32.3 } }, p2.token);
  assert.equal(far.status, 400);

  const badPoint = await h.call('POST', '/api/trips', { pickup: { lat: 99, lng: 0 }, dropoff: DROPOFF }, p2.token);
  assert.equal(badPoint.status, 400);
  await h.close();
});

test('passengers can cancel a requested trip and others cannot see it', async () => {
  const h = await harness();
  const p = await h.passenger();
  const other = await h.passenger('Other');
  const { body } = await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  const id = body.trip.id;
  assert.equal((await h.call('GET', `/api/trips/${id}`, undefined, other.token)).status, 404);
  assert.equal((await h.call('POST', `/api/trips/${id}/cancel`, {}, other.token)).status, 404);
  const c = await h.call('POST', `/api/trips/${id}/cancel`, {}, p.token);
  assert.equal(c.body.trip.status, 'cancelled');
  await h.close();
});

test('admin can change fares and the change applies to new trips only', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger();
  const before = await h.call('POST', '/api/fare/estimate', { pickup: PICKUP, dropoff: DROPOFF }, p.token);

  const upd = await h.call('PUT', '/api/admin/settings', { fare: { perKm: 1400, commissionRate: 0.1 } }, adminToken);
  assert.equal(upd.status, 200);
  assert.equal(upd.body.fare.perKm, 1400);

  const after = await h.call('POST', '/api/fare/estimate', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  assert.ok(after.body.fare > before.body.fare);

  const bad = await h.call('PUT', '/api/admin/settings', { fare: { commissionRate: 0.9 } }, adminToken);
  assert.equal(bad.status, 400);
  await h.close();
});

test('admin live view lists online captains and active trips', async () => {
  const h = await harness();
  const adminToken = await h.admin();
  const p = await h.passenger();
  await h.approvedCaptain(adminToken, 'Live');
  await h.call('POST', '/api/trips', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  const live = await h.call('GET', '/api/admin/live', undefined, adminToken);
  assert.equal(live.body.captains.length, 1);
  assert.equal(live.body.trips.length, 1);
  assert.equal(live.body.trips[0].status, 'requested');
  await h.close();
});

test('bad requests get clear errors, not crashes', async () => {
  const h = await harness();
  const res = await fetch(`http://127.0.0.1:${(await (async () => {
    const { server } = createApp({ db: openDb(':memory:'), routing: estimateRouting() });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    h.extra = server;
    return server.address();
  })()).port}/api/auth/login`, { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal((await h.call('GET', '/api/nothing-here')).status, 404);
  assert.equal((await h.call('DELETE', '/api/me')).status, 405);
  await new Promise((r) => h.extra.close(r));
  await h.close();
});
