import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm } from '../src/geo.js';
import { normalizeUgPhone } from '../src/phone.js';

test('Kampala to Entebbe is about 35 km in a straight line', () => {
  const kampala = { lat: 0.3476, lng: 32.5825 };
  const entebbe = { lat: 0.0512, lng: 32.4637 };
  const km = haversineKm(kampala, entebbe);
  assert.ok(km > 34 && km < 37, `got ${km}`);
});

test('distance is zero for the same point and the same both ways', () => {
  const a = { lat: 0.355, lng: 32.615 };
  const b = { lat: 0.39, lng: 32.64 };
  assert.equal(haversineKm(a, a), 0);
  assert.equal(haversineKm(a, b), haversineKm(b, a));
});

test('invalid coordinates are rejected', () => {
  const ok = { lat: 0, lng: 0 };
  assert.throws(() => haversineKm({ lat: 91, lng: 0 }, ok), RangeError);
  assert.throws(() => haversineKm(ok, { lat: 0, lng: 181 }), RangeError);
  assert.throws(() => haversineKm(ok, { lat: NaN, lng: 0 }), RangeError);
  assert.throws(() => haversineKm(ok, null), RangeError);
});

test('Uganda phone numbers in common formats become +256 format', () => {
  assert.equal(normalizeUgPhone('0772123456'), '+256772123456');
  assert.equal(normalizeUgPhone('256772123456'), '+256772123456');
  assert.equal(normalizeUgPhone('+256772123456'), '+256772123456');
  assert.equal(normalizeUgPhone('+256 (772) 123-456'), '+256772123456');
  assert.equal(normalizeUgPhone(' 0701 234 567 '), '+256701234567');
});

test('numbers that are not Uganda mobiles are rejected', () => {
  assert.throws(() => normalizeUgPhone('077212345'), RangeError); // too short
  assert.throws(() => normalizeUgPhone('07721234567'), RangeError); // too long
  assert.throws(() => normalizeUgPhone('+254712345678'), RangeError); // Kenya
  assert.throws(() => normalizeUgPhone('0412345678'), RangeError); // landline
  assert.throws(() => normalizeUgPhone('abc'), RangeError);
  assert.throws(() => normalizeUgPhone(772123456), TypeError);
});
