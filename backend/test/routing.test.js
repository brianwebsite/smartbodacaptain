import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePolyline, thinPath, osrmRouting, chooseRouting } from '../src/routing.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

// The well-known example from Google's documentation.
const SAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

test('polyline decoding and thinning', () => {
  assert.deepEqual(decodePolyline(SAMPLE), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const many = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const thin = thinPath(many, 100);
  assert.equal(thin.length, 100);
  assert.deepEqual(thin[0], [0, 0]);
  assert.deepEqual(thin[99], [999, 999]);
});

test('OSRM gives real road distance and the path to draw; failures fall back to the estimate', async () => {
  const fetchFn = async (url) => {
    assert.match(String(url), /route\/v1\/driving\/32\.615,0\.355;32\.64,0\.39\?overview=full&geometries=polyline/);
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 6200, duration: 780, geometry: SAMPLE }] }) };
  };
  const r = await osrmRouting({ fetchFn }).route({ lat: 0.355, lng: 32.615 }, { lat: 0.39, lng: 32.64 });
  assert.equal(r.source, 'osrm');
  assert.equal(r.distanceKm, 6.2);
  assert.equal(r.durationMin, 13);
  assert.equal(r.path.length, 3);

  const broken = chooseRouting({ fetchFn: async () => ({ ok: false, status: 503 }) });
  const e = await broken.route({ lat: 0.355, lng: 32.615 }, { lat: 0.39, lng: 32.64 });
  assert.equal(e.source, 'estimate');
  assert.equal(e.path, undefined);
});

test('the route endpoint returns the road, remembers it, and needs a signed-in person', async () => {
  let calls = 0;
  const routing = { route: async () => { calls += 1; return { distanceKm: 6.2, durationMin: 13, source: 'osrm', path: [[0.355, 32.615], [0.39, 32.64]] }; } };
  const db = openDb(':memory:');
  const { server } = createApp({ db, routing });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const reg = await call('POST', '/api/auth/register', { role: 'passenger', name: 'Amina', phone: '0772000111', password: 'secret123' });
  const token = reg.body.token;
  const body = { from: { lat: 0.355, lng: 32.615 }, to: { lat: 0.39, lng: 32.64 } };
  assert.equal((await call('POST', '/api/route', body)).status, 401);
  const a = await call('POST', '/api/route', body, token);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.path, [[0.355, 32.615], [0.39, 32.64]]);
  await call('POST', '/api/route', body, token);
  assert.equal(calls, 1); // the second answer came from memory
  assert.equal((await call('POST', '/api/route', { from: { lat: 0.3, lng: 32.6 }, to: { lat: 3.5, lng: 32.6 } }, token)).status, 400);
  await new Promise((r) => server.close(r));
  db.close();
});
