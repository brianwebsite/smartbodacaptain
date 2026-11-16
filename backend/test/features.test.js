import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { estimateRouting } from '../src/routing.js';
import { hashPassword } from '../src/auth.js';
import { toPlace, photonPlaces } from '../src/places.js';
import { scaleFareConfig, etaMinutes } from '../src/vehicles.js';

const PICKUP = { lat: 0.355, lng: 32.615 };
const DROPOFF = { lat: 0.39, lng: 32.64 };
const NEAR = { lat: 0.356, lng: 32.615 };

async function harness() {
  const db = openDb(':memory:');
  const clock = { ms: Date.parse('2026-11-16T10:00:00Z') };
  const searched = [];
  const places = {
    search: async (q, near) => {
      searched.push({ q, near });
      return [{ label: 'Garden City, Kampala', title: 'Garden City', subtitle: 'Kampala', lat: 0.3314, lng: 32.6 }];
    },
    reverse: async () => ({ label: 'Ntinda, Kampala', title: 'Ntinda', subtitle: 'Kampala', lat: 0.35, lng: 32.6 }),
  };
  const { server } = createApp({
    db, routing: estimateRouting(), places, now: () => new Date(clock.ms).toISOString(),
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
  const phone = () => `07722${String(20000 + n++)}`;
  const passenger = async () => {
    const r = await call('POST', '/api/auth/register', { role: 'passenger', name: 'Amina', phone: phone(), password: 'secret123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  const adminToken = await (async () => {
    db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), 'admin', 'Boss', '+256700000009', hashPassword('adminpass123'), 'active', new Date(clock.ms).toISOString());
    return (await call('POST', '/api/auth/login', { phone: '0700000009', password: 'adminpass123' })).body.token;
  })();
  const captain = async (vehicleType, where = NEAR) => {
    const r = await call('POST', '/api/auth/register', {
      role: 'captain', name: `Cap ${vehicleType}`, phone: phone(), password: 'secret123', bikePlate: 'ueh 123x',
      nationalId: 'CM12345678ABCD', permitNumber: 'DP998877', vehicleType,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await call('POST', `/api/admin/captains/${r.body.user.id}/approve`, {}, adminToken);
    await call('POST', `/api/admin/users/${r.body.user.id}/wallet`, { amount: 100000, note: 'test credit' }, adminToken);
    const on = await call('POST', '/api/captain/presence', { online: true, ...where }, r.body.token);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return { token: r.body.token, id: r.body.user.id };
  };
  return { call, passenger, captain, adminToken, clock, searched, close: () => new Promise((r) => server.close(r)) };
}

const trip = (extra = {}) => ({ pickup: PICKUP, dropoff: DROPOFF, paymentMethod: 'cash', ...extra });

test('estimate gives a price and arrival time for each vehicle type', async () => {
  const h = await harness();
  await h.captain('boda');
  await h.captain('car');
  const p = await h.passenger();
  const r = await h.call('POST', '/api/fare/estimate', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.options.map((o) => [o.vehicleType, o]));
  assert.deepEqual(Object.keys(by).sort(), ['boda', 'car', 'car_xl', 'electric_boda']);
  assert.equal(by.boda.nearbyCount, 1);
  assert.ok(by.boda.etaMin >= 1);
  assert.equal(by.electric_boda.nearbyCount, 0);
  assert.equal(by.electric_boda.etaMin, null);
  assert.equal(by.car.fare, by.boda.fare * 2); // default price level for cars is 2x
  assert.equal(r.body.fare, by.boda.fare);
  await h.close();
});

test('a trip is offered only to captains of the vehicle type asked for', async () => {
  const h = await harness();
  const boda = await h.captain('boda');
  const car = await h.captain('car');
  const p = await h.passenger();
  const t = await h.call('POST', '/api/trips', trip({ vehicleType: 'car' }), p.token);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.trip.vehicleType, 'car');

  assert.equal((await h.call('GET', '/api/captain/offers', undefined, boda.token)).body.offers.length, 0);
  const carOffers = await h.call('GET', '/api/captain/offers', undefined, car.token);
  assert.equal(carOffers.body.offers.length, 1);
  assert.equal((await h.call('POST', `/api/trips/${t.body.trip.id}/accept`, {}, boda.token)).status, 409);
  assert.equal((await h.call('POST', `/api/trips/${t.body.trip.id}/accept`, {}, car.token)).status, 200);

  const bad = await h.call('POST', '/api/trips', trip({ vehicleType: 'helicopter' }), p.token);
  assert.equal(bad.status, 400);
  await h.close();
});

test('admin can change the price level of a vehicle type', async () => {
  const h = await harness();
  const p = await h.passenger();
  const put = await h.call('PUT', '/api/admin/settings', { vehicles: { car: { multiplier: 3 } } }, h.adminToken);
  assert.equal(put.status, 200);
  assert.equal(put.body.vehicles.car.multiplier, 3);
  const r = await h.call('POST', '/api/fare/estimate', { pickup: PICKUP, dropoff: DROPOFF }, p.token);
  const by = Object.fromEntries(r.body.options.map((o) => [o.vehicleType, o]));
  assert.equal(by.car.fare, by.boda.fare * 3);
  const tooBig = await h.call('PUT', '/api/admin/settings', { vehicles: { car: { multiplier: 50 } } }, h.adminToken);
  assert.equal(tooBig.status, 400);
  await h.close();
});

test('nearby drivers: positions and times, no names, and only fresh ones', async () => {
  const h = await harness();
  await h.captain('boda', NEAR);
  await h.captain('electric_boda', { lat: 0.4, lng: 32.7 }); // too far (> 5 km)
  const p = await h.passenger();
  const r = await h.call('GET', `/api/passenger/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, undefined, p.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.drivers.length, 1);
  const d = r.body.drivers[0];
  assert.equal(d.vehicleType, 'boda');
  assert.ok(d.etaMin >= 1);
  assert.deepEqual(Object.keys(d).sort(), ['distanceKm', 'etaMin', 'id', 'lat', 'lng', 'vehicleType']);
  assert.equal(r.body.summary.electric_boda.count, 0);

  h.clock.ms += 5 * 60 * 1000; // five minutes pass with no location report
  const later = await h.call('GET', `/api/passenger/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, undefined, p.token);
  assert.equal(later.body.drivers.length, 0);

  const bad = await h.call('GET', '/api/passenger/nearby?lat=abc&lng=1', undefined, p.token);
  assert.equal(bad.status, 400);
  await h.close();
});

test('cancelling records who and why; only listed reasons are accepted', async () => {
  const h = await harness();
  const c = await h.captain('boda');
  const p = await h.passenger();
  const t = (await h.call('POST', '/api/trips', trip(), p.token)).body.trip;
  await h.call('POST', `/api/trips/${t.id}/accept`, {}, c.token);

  const wrong = await h.call('POST', `/api/trips/${t.id}/cancel`, { reason: 'passenger_no_show' }, p.token);
  assert.equal(wrong.status, 400); // that reason is for captains
  const ok = await h.call('POST', `/api/trips/${t.id}/cancel`, { reason: 'captain_far' }, p.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.trip.cancelReason, 'captain_far');
  assert.equal(ok.body.trip.cancelledBy, 'passenger');

  const t2 = (await h.call('POST', '/api/trips', trip(), p.token)).body.trip;
  await h.call('POST', `/api/trips/${t2.id}/accept`, {}, c.token);
  const byCaptain = await h.call('POST', `/api/trips/${t2.id}/cancel`, { reason: 'vehicle_problem' }, c.token);
  assert.equal(byCaptain.body.trip.cancelledBy, 'captain');

  const t3 = (await h.call('POST', '/api/trips', trip(), p.token)).body.trip;
  const noReason = await h.call('POST', `/api/trips/${t3.id}/cancel`, {}, p.token);
  assert.equal(noReason.status, 200);
  assert.equal(noReason.body.trip.cancelReason, null);
  await h.close();
});

test('passenger sees full captain details once accepted', async () => {
  const h = await harness();
  const c = await h.captain('electric_boda');
  const p = await h.passenger();
  const t = (await h.call('POST', '/api/trips', trip({ vehicleType: 'electric_boda' }), p.token)).body.trip;
  await h.call('POST', `/api/trips/${t.id}/accept`, {}, c.token);
  const cur = (await h.call('GET', '/api/passenger/current', undefined, p.token)).body.trip;
  assert.equal(cur.captain.vehicleType, 'electric_boda');
  assert.equal(cur.captain.bikePlate, 'UEH 123X');
  assert.equal(cur.captain.completedTrips, 0);
  assert.equal(cur.captain.rating, null);
  assert.ok(cur.captain.memberSince);
  await h.close();
});

test('chat: only the two people, only while active, with unread counts', async () => {
  const h = await harness();
  const c = await h.captain('boda');
  const p = await h.passenger();
  const stranger = await h.passenger();
  const t = (await h.call('POST', '/api/trips', trip(), p.token)).body.trip;

  // nobody has accepted yet, so there is nobody to talk to
  assert.equal((await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'hi' }, p.token)).status, 404);
  await h.call('POST', `/api/trips/${t.id}/accept`, {}, c.token);

  assert.equal((await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'I am at the gate' }, p.token)).status, 201);
  assert.equal((await h.call('POST', `/api/trips/${t.id}/messages`, { body: '   ' }, p.token)).status, 400);
  assert.equal((await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'x'.repeat(501) }, p.token)).status, 400);
  assert.equal((await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'spy' }, stranger.token)).status, 404);
  assert.equal((await h.call('GET', `/api/trips/${t.id}/messages`, undefined, stranger.token)).status, 404);

  const cur = await h.call('GET', '/api/captain/current', undefined, c.token);
  assert.equal(cur.body.trip.unread, 1);
  const read = await h.call('GET', `/api/trips/${t.id}/messages`, undefined, c.token);
  assert.deepEqual(read.body.messages.map((m) => [m.mine, m.body]), [[false, 'I am at the gate']]);
  assert.equal((await h.call('GET', '/api/captain/current', undefined, c.token)).body.trip.unread, 0);

  await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'Coming now' }, c.token);
  assert.equal((await h.call('GET', '/api/passenger/current', undefined, p.token)).body.trip.unread, 1);

  await h.call('POST', `/api/trips/${t.id}/cancel`, { reason: 'changed_mind' }, p.token);
  const closed = await h.call('POST', `/api/trips/${t.id}/messages`, { body: 'too late' }, p.token);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'chat_closed');
  await h.close();
});

test('place search goes through the server and is limited to signed-in users', async () => {
  const h = await harness();
  const p = await h.passenger();
  assert.equal((await h.call('GET', '/api/places/search?q=garden')).status, 401);
  const r = await h.call('GET', `/api/places/search?q=garden&lat=${PICKUP.lat}&lng=${PICKUP.lng}`, undefined, p.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.places[0].title, 'Garden City');
  assert.deepEqual(h.searched[0].near, PICKUP);
  const rev = await h.call('GET', '/api/places/reverse?lat=0.35&lng=32.6', undefined, p.token);
  assert.equal(rev.body.place.title, 'Ntinda');
  assert.equal((await h.call('GET', '/api/places/reverse?lat=zzz&lng=32.6', undefined, p.token)).status, 400);
  await h.close();
});

test('Photon results become short place labels, Uganda only, and are cached', async () => {
  const feature = (props, lng = 32.6, lat = 0.33) => ({ properties: props, geometry: { coordinates: [lng, lat] } });
  assert.deepEqual(
    toPlace(feature({ name: 'Garden City', street: 'Yusuf Lule Road', district: 'Nakawa', city: 'Kampala', countrycode: 'UG' })),
    { label: 'Garden City, Yusuf Lule Road, Nakawa, Kampala', title: 'Garden City',
      subtitle: 'Yusuf Lule Road, Nakawa, Kampala', lat: 0.33, lng: 32.6 },
  );
  assert.equal(toPlace(feature({ name: 'Nairobi', countrycode: 'KE' })), null);
  assert.equal(toPlace({ properties: { name: 'No point' } }), null);

  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.match(url, /bbox=/);
    return { ok: true, json: async () => ({ features: [feature({ name: 'Ntinda', city: 'Kampala', countrycode: 'UG' })] }) };
  };
  const ph = photonPlaces({ fetchImpl });
  assert.equal((await ph.search('ntinda', { lat: 0.35, lng: 32.6 })).length, 1);
  await ph.search('ntinda', { lat: 0.35, lng: 32.6 });
  assert.equal(calls, 1);
  assert.deepEqual(await ph.search('n'), []); // too short, no request
  assert.equal(calls, 1);
});

test('price scaling and arrival estimates', () => {
  const cfg = { baseFare: 1000, perKm: 700, perMinute: 50, minimumFare: 2000, commissionRate: 0.15, roundTo: 100 };
  assert.deepEqual(scaleFareConfig(cfg, 2), { ...cfg, baseFare: 2000, perKm: 1400, perMinute: 100, minimumFare: 4000 });
  assert.equal(etaMinutes(0), 1);
  assert.equal(etaMinutes(1), 4); // 1 km x 1.35 / 22 km/h = about 3.7 min
  assert.ok(etaMinutes(5) > etaMinutes(1));
});
