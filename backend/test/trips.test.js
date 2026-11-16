import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrip, transitionTrip, isFinal, TRIP_STATUS as S, TripError } from '../src/trips.js';

const T0 = '2026-11-16T10:00:00Z';
const T1 = '2026-11-16T10:01:00Z';
const T2 = '2026-11-16T10:05:00Z';
const T3 = '2026-11-16T10:06:00Z';
const T4 = '2026-11-16T10:20:00Z';

const base = () =>
  createTrip({
    id: 't1',
    passengerId: 'p1',
    pickup: { lat: 0.355, lng: 32.615 },
    dropoff: { lat: 0.39, lng: 32.64 },
    fare: 5300,
    paymentMethod: 'cash',
    at: T0,
  });

test('a new trip starts as requested with no captain', () => {
  const t = base();
  assert.equal(t.status, S.REQUESTED);
  assert.equal(t.captainId, null);
  assert.equal(t.history.length, 1);
});

test('the full happy path ends completed with a full history', () => {
  let t = base();
  t = transitionTrip(t, S.ACCEPTED, { by: 'captain', actorId: 'c1', at: T1 });
  t = transitionTrip(t, S.ARRIVED, { by: 'captain', actorId: 'c1', at: T2 });
  t = transitionTrip(t, S.IN_PROGRESS, { by: 'captain', actorId: 'c1', at: T3 });
  t = transitionTrip(t, S.COMPLETED, { by: 'captain', actorId: 'c1', at: T4 });
  assert.equal(t.status, S.COMPLETED);
  assert.equal(t.captainId, 'c1');
  assert.deepEqual(
    t.history.map((h) => h.status),
    [S.REQUESTED, S.ACCEPTED, S.ARRIVED, S.IN_PROGRESS, S.COMPLETED],
  );
  assert.ok(isFinal(t));
});

test('transitions return a new trip and leave the old one unchanged', () => {
  const t = base();
  const t2 = transitionTrip(t, S.ACCEPTED, { by: 'captain', actorId: 'c1', at: T1 });
  assert.equal(t.status, S.REQUESTED);
  assert.equal(t.history.length, 1);
  assert.notEqual(t, t2);
});

test('steps cannot be skipped', () => {
  const t = base();
  assert.throws(
    () => transitionTrip(t, S.IN_PROGRESS, { by: 'captain', actorId: 'c1', at: T1 }),
    TripError,
  );
  assert.throws(
    () => transitionTrip(t, S.COMPLETED, { by: 'captain', actorId: 'c1', at: T1 }),
    TripError,
  );
});

test('a passenger cannot accept, arrive or complete a trip', () => {
  const t = base();
  assert.throws(
    () => transitionTrip(t, S.ACCEPTED, { by: 'passenger', actorId: 'p1', at: T1 }),
    TripError,
  );
});

test('only the assigned captain can move an accepted trip on', () => {
  let t = base();
  t = transitionTrip(t, S.ACCEPTED, { by: 'captain', actorId: 'c1', at: T1 });
  assert.throws(
    () => transitionTrip(t, S.ARRIVED, { by: 'captain', actorId: 'c2', at: T2 }),
    TripError,
  );
});

test('only the trip passenger can cancel as passenger', () => {
  const t = base();
  assert.throws(
    () => transitionTrip(t, S.CANCELLED, { by: 'passenger', actorId: 'p2', at: T1 }),
    TripError,
  );
  const c = transitionTrip(t, S.CANCELLED, { by: 'passenger', actorId: 'p1', at: T1 });
  assert.equal(c.status, S.CANCELLED);
});

test('a captain can cancel after accepting, but nobody can cancel once the ride has started', () => {
  let t = base();
  t = transitionTrip(t, S.ACCEPTED, { by: 'captain', actorId: 'c1', at: T1 });
  const cancelled = transitionTrip(t, S.CANCELLED, { by: 'captain', actorId: 'c1', at: T2 });
  assert.equal(cancelled.status, S.CANCELLED);

  t = transitionTrip(t, S.ARRIVED, { by: 'captain', actorId: 'c1', at: T2 });
  t = transitionTrip(t, S.IN_PROGRESS, { by: 'captain', actorId: 'c1', at: T3 });
  assert.throws(
    () => transitionTrip(t, S.CANCELLED, { by: 'passenger', actorId: 'p1', at: T4 }),
    TripError,
  );
});

test('no_captain can only be set by the system on a requested trip', () => {
  const t = base();
  assert.throws(
    () => transitionTrip(t, S.NO_CAPTAIN, { by: 'passenger', actorId: 'p1', at: T1 }),
    TripError,
  );
  const n = transitionTrip(t, S.NO_CAPTAIN, { by: 'system', at: T1 });
  assert.equal(n.status, S.NO_CAPTAIN);
  assert.ok(isFinal(n));
});

test('a finished trip cannot move again', () => {
  const n = transitionTrip(base(), S.NO_CAPTAIN, { by: 'system', at: T1 });
  assert.throws(
    () => transitionTrip(n, S.ACCEPTED, { by: 'captain', actorId: 'c1', at: T2 }),
    TripError,
  );
});

test('bad trip details are rejected', () => {
  const ok = {
    id: 't1',
    passengerId: 'p1',
    pickup: { lat: 0.355, lng: 32.615 },
    dropoff: { lat: 0.39, lng: 32.64 },
    fare: 5300,
    paymentMethod: 'cash',
    at: T0,
  };
  assert.throws(() => createTrip({ ...ok, fare: 0 }), TripError);
  assert.throws(() => createTrip({ ...ok, fare: 5300.5 }), TripError);
  assert.throws(() => createTrip({ ...ok, paymentMethod: 'bitcoin' }), TripError);
  assert.throws(() => createTrip({ ...ok, passengerId: '' }), TripError);
  assert.throws(() => createTrip({ ...ok, at: 'yesterday' }), TripError);
  assert.throws(() => createTrip({ ...ok, pickup: { lat: 200, lng: 0 } }), RangeError);
});
