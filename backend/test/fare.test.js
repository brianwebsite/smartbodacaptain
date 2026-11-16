import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFare, DEFAULT_FARE_CONFIG } from '../src/fare.js';

test('a typical 5 km, 15 minute trip', () => {
  // 1000 + 5*700 + 15*50 = 5250 -> rounds to 5300
  const r = calculateFare({ distanceKm: 5, durationMin: 15 });
  assert.equal(r.fare, 5300);
  assert.equal(r.commission, 795); // 15% of 5300
  assert.equal(r.captainEarnings, 4505);
});

test('short trips are lifted to the minimum fare', () => {
  // 1000 + 0.2*700 + 1*50 = 1190, below the 2000 minimum
  const r = calculateFare({ distanceKm: 0.2, durationMin: 1 });
  assert.equal(r.fare, DEFAULT_FARE_CONFIG.minimumFare);
});

test('commission and captain earnings always add up to the fare', () => {
  for (let km = 0; km <= 30; km += 0.7) {
    for (let min = 0; min <= 60; min += 3) {
      const r = calculateFare({ distanceKm: km, durationMin: min });
      assert.equal(r.commission + r.captainEarnings, r.fare);
      assert.ok(Number.isInteger(r.fare));
      assert.ok(Number.isInteger(r.commission));
      assert.equal(r.fare % 100, 0);
    }
  }
});

test('a custom commission rate is applied', () => {
  const r = calculateFare({ distanceKm: 5, durationMin: 15 }, { commissionRate: 0.1 });
  assert.equal(r.fare, 5300);
  assert.equal(r.commission, 530);
  assert.equal(r.captainEarnings, 4770);
});

test('zero commission gives the captain the whole fare', () => {
  const r = calculateFare({ distanceKm: 3, durationMin: 10 }, { commissionRate: 0 });
  assert.equal(r.commission, 0);
  assert.equal(r.captainEarnings, r.fare);
});

test('longer trips never cost less than shorter ones', () => {
  let last = 0;
  for (let km = 0; km <= 40; km += 0.5) {
    const { fare } = calculateFare({ distanceKm: km, durationMin: km * 3 });
    assert.ok(fare >= last);
    last = fare;
  }
});

test('bad trip numbers are rejected', () => {
  assert.throws(() => calculateFare({ distanceKm: -1, durationMin: 5 }), RangeError);
  assert.throws(() => calculateFare({ distanceKm: 5, durationMin: NaN }), RangeError);
  assert.throws(() => calculateFare({ distanceKm: '5', durationMin: 5 }), RangeError);
  assert.throws(() => calculateFare(undefined), RangeError);
});

test('bad config is rejected', () => {
  const trip = { distanceKm: 5, durationMin: 15 };
  assert.throws(() => calculateFare(trip, { commissionRate: 1.5 }), RangeError);
  assert.throws(() => calculateFare(trip, { commissionRate: -0.1 }), RangeError);
  assert.throws(() => calculateFare(trip, { roundTo: 0 }), RangeError);
  assert.throws(() => calculateFare(trip, { perKm: -5 }), RangeError);
});
