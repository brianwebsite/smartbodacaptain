import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCaptains } from '../src/dispatch.js';

const NOW = '2026-11-16T10:00:30Z';
const FRESH = '2026-11-16T10:00:10Z'; // 20 seconds old
const pickup = { lat: 0.355, lng: 32.615 };

// About 0.0045 degrees of latitude is 0.5 km.
const cap = (id, dLat, extra = {}) => ({
  id,
  approved: true,
  online: true,
  onTrip: false,
  location: { lat: pickup.lat + dLat, lng: pickup.lng },
  locationAt: FRESH,
  ...extra,
});

test('captains come back nearest first', () => {
  const out = rankCaptains({
    pickup,
    now: NOW,
    captains: [cap('far', 0.018), cap('near', 0.0045), cap('mid', 0.009)],
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ['near', 'mid', 'far'],
  );
  assert.ok(out[0].distanceKm < out[1].distanceKm);
});

test('unapproved, offline and busy captains are skipped', () => {
  const out = rankCaptains({
    pickup,
    now: NOW,
    captains: [
      cap('ok', 0.002),
      cap('pending', 0.001, { approved: false }),
      cap('offline', 0.001, { online: false }),
      cap('busy', 0.001, { onTrip: true }),
    ],
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ['ok'],
  );
});

test('captains with an old or future location report are skipped', () => {
  const out = rankCaptains({
    pickup,
    now: NOW,
    captains: [
      cap('fresh', 0.002),
      cap('stale', 0.001, { locationAt: '2026-11-16T09:58:00Z' }),
      cap('future', 0.001, { locationAt: '2026-11-16T10:05:00Z' }),
      cap('missing', 0.001, { locationAt: undefined }),
    ],
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ['fresh'],
  );
});

test('captains beyond the maximum distance are skipped', () => {
  const near = cap('near', 0.01); // about 1.1 km
  const far = cap('far', 0.04); // about 4.4 km
  assert.deepEqual(
    rankCaptains({ pickup, now: NOW, captains: [near, far] }).map((c) => c.id),
    ['near'],
  );
  assert.deepEqual(
    rankCaptains({ pickup, now: NOW, captains: [near, far], maxKm: 6 }).map((c) => c.id),
    ['near', 'far'],
  );
});

test('captains who already declined are excluded and the limit is applied', () => {
  const captains = [cap('a', 0.001), cap('b', 0.002), cap('c', 0.003), cap('d', 0.004)];
  assert.deepEqual(
    rankCaptains({ pickup, now: NOW, captains, exclude: ['a'], limit: 2 }).map((c) => c.id),
    ['b', 'c'],
  );
});

test('equal distances are ordered by id so results are repeatable', () => {
  const out = rankCaptains({
    pickup,
    now: NOW,
    captains: [cap('z', 0.002), cap('m', 0.002), cap('a', 0.002)],
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ['a', 'm', 'z'],
  );
});

test('no captains gives an empty list, and a bad time is rejected', () => {
  assert.deepEqual(rankCaptains({ pickup, now: NOW, captains: [] }), []);
  assert.throws(() => rankCaptains({ pickup, now: 'soon', captains: [] }), RangeError);
});
