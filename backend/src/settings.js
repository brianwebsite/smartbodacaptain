// Settings the admin can change: fare formula and dispatch rules.

import { DEFAULT_FARE_CONFIG, calculateFare } from './fare.js';
import { bad, obj, num, int, text } from './validate.js';
import { DEFAULT_VEHICLES, VEHICLE_TYPES } from './vehicles.js';

export const DEFAULT_DISPATCH = Object.freeze({
  maxKm: 3, // how far from the pickup a captain may be and still get the offer
  limit: 5, // how many nearest captains are offered a trip
  staleAfterSeconds: 60, // location reports older than this are ignored
  offerSeconds: 600, // a request stays open this long, so a captain who goes online later still sees it
});

function read(db, key, defaults) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return { ...defaults, ...(row ? JSON.parse(row.value) : {}) };
}

export const DEFAULT_NIGHT = Object.freeze({ percent: 5, startHour: 22, endHour: 5 });
export const DEFAULT_LIMITS = Object.freeze({
  deliveryMultiplier: 1, // price level of delivery trips compared with a normal ride
});

export const DEFAULT_APP = Object.freeze({
  supportPhone: '',
  supportEmail: '',
  whatsapp: '',
  facebook: '',
  instagram: '',
  x: '',
  tiktok: '',
  youtube: '',
  androidStoreUrl: '',
  about: 'Smart Boda connects you with trusted boda riders and drivers in Kampala.',
});
export const getAppInfo = (db) => read(db, 'app', DEFAULT_APP);

export const getFareConfig = (db) => read(db, 'fare', DEFAULT_FARE_CONFIG);
export const getDispatchConfig = (db) => read(db, 'dispatch', DEFAULT_DISPATCH);
export const getNightConfig = (db) => read(db, 'night', DEFAULT_NIGHT);
export const getLimits = (db) => read(db, 'limits', DEFAULT_LIMITS);
export const getVehicleConfig = (db) => read(db, 'vehicles', DEFAULT_VEHICLES);

function write(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

/** Check and save changes. Only known keys are accepted. */
export function updateSettings(db, body) {
  obj(body);
  if (body.fare !== undefined) {
    const f = obj(body.fare, 'fare');
    const next = { ...getFareConfig(db) };
    for (const k of ['baseFare', 'perKm', 'perMinute', 'minimumFare']) {
      if (f[k] !== undefined) next[k] = int(f[k], k, { min: 0, max: 1_000_000 });
    }
    if (f.commissionRate !== undefined) {
      next.commissionRate = num(f.commissionRate, 'commissionRate', { min: 0, max: 0.5 });
    }
    if (f.roundTo !== undefined) next.roundTo = int(f.roundTo, 'roundTo', { min: 1, max: 1000 });
    try {
      calculateFare({ distanceKm: 1, durationMin: 1 }, next);
    } catch (err) {
      throw bad(err.message);
    }
    write(db, 'fare', next);
  }
  if (body.dispatch !== undefined) {
    const d = obj(body.dispatch, 'dispatch');
    const next = { ...getDispatchConfig(db) };
    if (d.maxKm !== undefined) next.maxKm = num(d.maxKm, 'maxKm', { min: 0.2, max: 20 });
    if (d.limit !== undefined) next.limit = int(d.limit, 'limit', { min: 1, max: 20 });
    if (d.staleAfterSeconds !== undefined) {
      next.staleAfterSeconds = int(d.staleAfterSeconds, 'staleAfterSeconds', { min: 10, max: 600 });
    }
    if (d.offerSeconds !== undefined) {
      next.offerSeconds = int(d.offerSeconds, 'offerSeconds', { min: 20, max: 3600 });
    }
    write(db, 'dispatch', next);
  }
  if (body.vehicles !== undefined) {
    const v = obj(body.vehicles, 'vehicles');
    const next = { ...getVehicleConfig(db) };
    for (const type of VEHICLE_TYPES) {
      if (v[type] === undefined) continue;
      const m = num(obj(v[type], type).multiplier, `${type}.multiplier`, { min: 0.5, max: 5 });
      next[type] = { multiplier: m };
    }
    write(db, 'vehicles', next);
  }
  if (body.night !== undefined) {
    const n = obj(body.night, 'night');
    const next = { ...getNightConfig(db) };
    if (n.percent !== undefined) next.percent = num(n.percent, 'percent', { min: 0, max: 100 });
    if (n.startHour !== undefined) next.startHour = int(n.startHour, 'startHour', { min: 0, max: 23 });
    if (n.endHour !== undefined) next.endHour = int(n.endHour, 'endHour', { min: 0, max: 23 });
    write(db, 'night', next);
  }
  if (body.limits !== undefined) {
    const l = obj(body.limits, 'limits');
    const next = { ...getLimits(db) };
    if (l.deliveryMultiplier !== undefined) next.deliveryMultiplier = num(l.deliveryMultiplier, 'deliveryMultiplier', { min: 0.5, max: 5 });
    write(db, 'limits', next);
  }
  if (body.app !== undefined) {
    const a = obj(body.app, 'app');
    const next = { ...getAppInfo(db) };
    for (const k of ['supportPhone', 'supportEmail', 'about']) {
      if (a[k] !== undefined) next[k] = text(a[k], k, { min: 0, max: k === 'about' ? 600 : 120, optional: true }) ?? '';
    }
    for (const k of ['whatsapp', 'facebook', 'instagram', 'x', 'tiktok', 'youtube', 'androidStoreUrl']) {
      if (a[k] === undefined) continue;
      const v = text(a[k], k, { min: 0, max: 300, optional: true }) ?? '';
      if (v && !/^https:\/\/[^\s]+$/i.test(v)) throw bad(`${k} must be a full link starting with https://`);
      next[k] = v;
    }
    write(db, 'app', next);
  }
  return {
    app: getAppInfo(db),
    fare: getFareConfig(db),
    dispatch: getDispatchConfig(db),
    vehicles: getVehicleConfig(db),
    night: getNightConfig(db),
    limits: getLimits(db),
  };
}
