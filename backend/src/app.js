// The Smart Boda API. Passengers, captains and admins all talk to this.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

import { calculateFare } from './fare.js';
import { rankCaptains } from './dispatch.js';
import { createTrip, transitionTrip, TRIP_STATUS as S, TripError } from './trips.js';
import { normalizeUgPhone } from './phone.js';
import { transaction } from './db.js';
import {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  sessionExpiry,
  RateLimiter,
} from './auth.js';
import { Router, readJson, sendJson } from './http.js';
import { getFareConfig, getDispatchConfig, getVehicleConfig, updateSettings } from './settings.js';
import { VEHICLE_TYPES, CANCEL_REASONS, scaleFareConfig, etaMinutes } from './vehicles.js';
import { HttpError, bad, obj, text, oneOf, bool, num, int, point } from './validate.js';

const ACTIVE_STATUSES = [S.REQUESTED, S.ACCEPTED, S.ARRIVED, S.IN_PROGRESS];
const WITH_CAPTAIN_STATUSES = [S.ACCEPTED, S.ARRIVED, S.IN_PROGRESS];
const MAX_TRIP_KM = 60;
const MIN_TRIP_KM = 0.1;
const round1 = (n) => Math.round(n * 10) / 10;
const placeholders = (list) => list.map(() => '?').join(',');

export function createApp({
  db,
  routing,
  now = () => new Date().toISOString(),
  trustProxy = false,
  adminHtmlPath = null,
  googleVerify = null,
  googleClientId = null,
  places = null,
}) {
  const router = new Router();
  const loginByPhone = new RateLimiter(10, 15 * 60 * 1000);
  const loginByIp = new RateLimiter(40, 15 * 60 * 1000);
  const registerByIp = new RateLimiter(20, 60 * 60 * 1000);
  const placesByUser = new RateLimiter(60, 60 * 1000);
  const messagesByUser = new RateLimiter(40, 60 * 1000);

  // ---------- database helpers ----------

  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const getProfile = (id) => db.prepare('SELECT * FROM captain_profiles WHERE user_id = ?').get(id);
  const getTripRow = (id) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id);

  const rowToTrip = (row) => ({
    id: row.id,
    passengerId: row.passenger_id,
    captainId: row.captain_id,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    fare: row.fare,
    paymentMethod: row.payment_method,
    status: row.status,
    history: JSON.parse(row.history),
  });

  function saveTransition(oldRow, next, completedAt = null) {
    const res = db
      .prepare(
        `UPDATE trips SET captain_id = ?, status = ?, history = ?, updated_at = ?,
           completed_at = COALESCE(?, completed_at)
         WHERE id = ? AND status = ?`,
      )
      .run(next.captainId, next.status, JSON.stringify(next.history), now(), completedAt, next.id, oldRow.status);
    if (res.changes !== 1) throw new HttpError(409, 'This trip just changed. Please refresh.', 'trip_changed');
  }

  function activeTripForPassenger(userId) {
    return db
      .prepare(
        `SELECT * FROM trips WHERE passenger_id = ? AND status IN (${placeholders(ACTIVE_STATUSES)})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, ...ACTIVE_STATUSES);
  }

  function activeTripForCaptain(userId) {
    return db
      .prepare(
        `SELECT * FROM trips WHERE captain_id = ? AND status IN (${placeholders(WITH_CAPTAIN_STATUSES)})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, ...WITH_CAPTAIN_STATUSES);
  }

  function captainStats(captainId) {
    const r = db
      .prepare(
        `SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) AS trips,
                AVG(rating) AS avg, COUNT(rating) AS rated
         FROM trips WHERE captain_id = ?`,
      )
      .get(captainId);
    return {
      completedTrips: r.trips,
      rating: r.avg == null ? null : round1(r.avg),
      ratingCount: r.rated,
    };
  }

  function unreadFor(tripId, userId) {
    return db
      .prepare('SELECT COUNT(*) AS c FROM trip_messages WHERE trip_id = ? AND sender_id <> ? AND read_at IS NULL')
      .get(tripId, userId).c;
  }

  function tripView(row, viewer) {
    const view = {
      id: row.id,
      status: row.status,
      pickup: { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_label },
      dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, label: row.dropoff_label },
      distanceKm: round1(row.distance_km),
      durationMin: Math.round(row.duration_min),
      routeSource: row.route_source,
      fare: row.fare,
      paymentMethod: row.payment_method,
      vehicleType: row.vehicle_type,
      cancelReason: row.cancel_reason,
      cancelledBy: row.cancelled_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      rating: row.rating,
    };
    if (viewer === 'passenger' || viewer === 'admin') {
      if (row.captain_id) {
        const u = getUser(row.captain_id);
        const p = getProfile(row.captain_id);
        const stats = captainStats(u.id);
        view.captain = {
          id: u.id,
          name: u.name,
          phone: u.phone,
          bikePlate: p.bike_plate,
          bikeModel: p.bike_model,
          vehicleType: p.vehicle_type,
          stageName: p.stage_name,
          rating: stats.rating,
          ratingCount: stats.ratingCount,
          completedTrips: stats.completedTrips,
          memberSince: u.created_at,
          location: p.lat == null ? null : { lat: p.lat, lng: p.lng },
          locationAt: p.location_at,
        };
      } else {
        view.captain = null;
      }
    }
    if (viewer === 'captain' || viewer === 'admin') {
      const pu = getUser(row.passenger_id);
      view.passenger = { id: pu.id, name: pu.name, phone: pu.phone };
      view.commission = row.commission;
      view.captainEarnings = row.captain_earnings;
    }
    return view;
  }

  // ---------- trips that nobody accepted ----------

  function expireStaleTrips() {
    const cfg = getDispatchConfig(db);
    const cutoff = new Date(Date.parse(now()) - cfg.offerSeconds * 1000).toISOString();
    const stale = db
      .prepare('SELECT * FROM trips WHERE status = ? AND created_at <= ?')
      .all(S.REQUESTED, cutoff);
    for (const row of stale) {
      try {
        saveTransition(row, transitionTrip(rowToTrip(row), S.NO_CAPTAIN, { by: 'system', at: now() }));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err; // someone accepted at the same moment
      }
    }
  }

  // ---------- dispatch ----------

  function candidateCaptains() {
    return db
      .prepare(
        `SELECT u.id, p.lat, p.lng, p.location_at, p.vehicle_type,
           EXISTS (SELECT 1 FROM trips t WHERE t.captain_id = u.id
                   AND t.status IN (${placeholders(WITH_CAPTAIN_STATUSES)})) AS on_trip
         FROM captain_profiles p JOIN users u ON u.id = p.user_id
         WHERE p.online = 1 AND u.status = 'active' AND p.lat IS NOT NULL`,
      )
      .all(...WITH_CAPTAIN_STATUSES)
      .map((c) => ({
        id: c.id,
        approved: true,
        online: true,
        onTrip: Boolean(c.on_trip),
        vehicleType: c.vehicle_type,
        location: { lat: c.lat, lng: c.lng },
        locationAt: c.location_at,
      }));
  }

  function rankingFor(row, captains) {
    const cfg = getDispatchConfig(db);
    const declined = db.prepare('SELECT captain_id FROM declines WHERE trip_id = ?').all(row.id);
    return rankCaptains({
      pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
      captains: captains.filter((c) => c.vehicleType === row.vehicle_type),
      now: now(),
      maxKm: cfg.maxKm,
      limit: cfg.limit,
      staleAfterSeconds: cfg.staleAfterSeconds,
      exclude: declined.map((d) => d.captain_id),
    });
  }

  // ---------- fares ----------

  async function routeFor(pickup, dropoff) {
    const route = await routing.route(pickup, dropoff);
    if (route.distanceKm < MIN_TRIP_KM) throw bad('Pickup and drop-off are too close together');
    if (route.distanceKm > MAX_TRIP_KM) throw bad('That trip is too far for Smart Boda');
    return route;
  }

  function priceFor(route, vehicleType) {
    const multiplier = getVehicleConfig(db)[vehicleType]?.multiplier ?? 1;
    return calculateFare(
      { distanceKm: route.distanceKm, durationMin: route.durationMin },
      scaleFareConfig(getFareConfig(db), multiplier),
    );
  }

  async function quote(pickup, dropoff, vehicleType = 'boda') {
    const route = await routeFor(pickup, dropoff);
    return {
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      source: route.source,
      ...priceFor(route, vehicleType),
    };
  }

  // ---------- who is near a point ----------

  const NEARBY_KM = 5;
  const round4 = (n) => Math.round(n * 1e4) / 1e4;
  const publicId = (id) => createHash('sha256').update(id).digest('hex').slice(0, 8);

  /** Free captains near a point, with an "about N minutes" arrival estimate. No names. */
  function nearbyCaptains(at) {
    const cfg = getDispatchConfig(db);
    const all = candidateCaptains();
    const byId = new Map(all.map((c) => [c.id, c]));
    return rankCaptains({
      pickup: at,
      captains: all,
      now: now(),
      maxKm: NEARBY_KM,
      limit: 60,
      staleAfterSeconds: cfg.staleAfterSeconds,
    }).map((r) => {
      const c = byId.get(r.id);
      return {
        id: publicId(r.id),
        vehicleType: c.vehicleType,
        lat: round4(c.location.lat),
        lng: round4(c.location.lng),
        distanceKm: round1(r.distanceKm),
        etaMin: etaMinutes(r.distanceKm),
      };
    });
  }

  function nearbySummary(drivers) {
    const out = {};
    for (const t of VEHICLE_TYPES) {
      const mine = drivers.filter((d) => d.vehicleType === t);
      out[t] = { count: mine.length, etaMin: mine.length ? Math.min(...mine.map((d) => d.etaMin)) : null };
    }
    return out;
  }

  // ---------- routes: public ----------

  router.add('GET', '/health', () => ({ ok: true, time: now() }));

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function parseEmail(value, optional = true) {
    if (value == null || value === '') {
      if (optional) return null;
      throw bad('Enter your email address', 'bad_email');
    }
    const e = String(value).trim().toLowerCase();
    if (e.length > 120 || !EMAIL_RE.test(e)) throw bad('Enter a valid email address', 'bad_email');
    return e;
  }

  function parsePhone(value) {
    try {
      return normalizeUgPhone(String(value ?? ''));
    } catch {
      throw bad('Enter a valid Uganda mobile number, like 0772 123456', 'bad_phone');
    }
  }

  function parseCaptainProfile(body) {
    return {
      bikePlate: text(body.bikePlate, 'Number plate', { min: 3, max: 15 }).toUpperCase().replace(/\s+/g, ' '),
      bikeModel: text(body.bikeModel, 'Bike model', { max: 40, optional: true }),
      nationalId: text(body.nationalId, 'National ID number', { min: 8, max: 20 }).toUpperCase(),
      permitNumber: text(body.permitNumber, 'Driving permit number', { min: 4, max: 30 }).toUpperCase(),
      stageName: text(body.stageName, 'Stage name', { max: 60, optional: true }),
      vehicleType: body.vehicleType === undefined ? 'boda' : oneOf(body.vehicleType, 'vehicleType', VEHICLE_TYPES),
    };
  }

  /** Creates the account and a first session. Throws friendly 409s for duplicates. */
  function createAccount({ role, name, phone, email, passwordHash, googleSub = null, profile }) {
    const id = randomUUID();
    const at = now();
    const { token, tokenHash } = newSessionToken();
    try {
      transaction(db, () => {
        db.prepare(
          `INSERT INTO users (id, role, name, phone, email, google_sub, password_hash, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(id, role, name, phone, email, googleSub, passwordHash, role === 'captain' ? 'pending' : 'active', at);
        if (profile) {
          db.prepare(
            `INSERT INTO captain_profiles (user_id, bike_plate, bike_model, national_id, permit_number, stage_name, vehicle_type)
             VALUES (?,?,?,?,?,?,?)`,
          ).run(
            id, profile.bikePlate, profile.bikeModel, profile.nationalId, profile.permitNumber,
            profile.stageName, profile.vehicleType,
          );
        }
        db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
          tokenHash, id, at, sessionExpiry(at),
        );
      });
    } catch (err) {
      const m = String(err.message);
      if (m.includes('users.email')) {
        throw new HttpError(409, 'That email already has an account. Sign in instead.', 'email_taken');
      }
      if (m.includes('users.google_sub')) {
        throw new HttpError(409, 'That Google account already has an account. Sign in instead.', 'google_taken');
      }
      if (m.includes('UNIQUE')) {
        throw new HttpError(409, 'That phone number already has an account. Sign in instead.', 'phone_taken');
      }
      throw err;
    }
    return { status: 201, body: { token, user: meView(getUser(id)) } };
  }

  function startSession(user) {
    const at = now();
    const { token, tokenHash } = newSessionToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
      tokenHash, user.id, at, sessionExpiry(at),
    );
    return { token, user: meView(user) };
  }

  router.add('GET', '/api/auth/options', () => ({
    google: googleVerify && googleClientId ? { serverClientId: googleClientId } : null,
  }));

  router.add('POST', '/api/auth/register', ({ body, ip }) => {
    if (!registerByIp.allow(ip, Date.parse(now()))) {
      throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.', 'rate_limited');
    }
    obj(body);
    const role = oneOf(body.role, 'role', ['passenger', 'captain']);
    const name = text(body.name, 'Name', { min: 2, max: 80 });
    const phone = parsePhone(body.phone);
    const email = parseEmail(body.email);
    const password = text(body.password, 'Password', { min: 6, max: 128 });
    const profile = role === 'captain' ? parseCaptainProfile(body) : null;
    return createAccount({ role, name, phone, email, passwordHash: hashPassword(password), profile });
  });

  // Sign in with Google (passengers). First call sends only the token; if the
  // person is new, the reply says which details are still needed, and the app
  // calls again with the token plus phone (and name if Google had none).
  router.add('POST', '/api/auth/google', async ({ body, ip }) => {
    if (!googleVerify) throw new HttpError(503, 'Google sign-in is not set up yet', 'google_unavailable');
    obj(body);
    const t = Date.parse(now());
    if (!loginByIp.allow(ip, t)) {
      throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.', 'rate_limited');
    }
    let g;
    try {
      g = await googleVerify(body.idToken);
    } catch {
      throw new HttpError(401, 'Google sign-in failed. Please try again.', 'google_failed');
    }
    const existing = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(g.sub);
    if (existing) {
      if (existing.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'suspended');
      return startSession(existing);
    }
    // Never attach Google to an account that was made with a typed email: nobody
    // proved they own that address, so linking could hand the account to a stranger.
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(g.email)) {
      throw new HttpError(409, 'That email already has an account. Sign in with your password instead.', 'email_taken');
    }
    const name = (typeof body.name === 'string' && body.name.trim()) || g.name;
    if (body.phone == null || name.trim().length < 2) {
      return { needsProfile: true, name: g.name, email: g.email };
    }
    if (!registerByIp.allow(ip, t)) {
      throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.', 'rate_limited');
    }
    const cleanName = text(name, 'Name', { min: 2, max: 80 });
    const phone = parsePhone(body.phone);
    // Google users have no password; store a hash of random bytes nobody knows.
    return createAccount({
      role: 'passenger',
      name: cleanName,
      phone,
      email: g.email,
      googleSub: g.sub,
      passwordHash: hashPassword(randomUUID() + randomUUID()),
      profile: null,
    });
  });

  router.add('POST', '/api/auth/login', ({ body, ip }) => {
    obj(body);
    const raw = String(body.identifier ?? body.phone ?? '').trim();
    let column;
    let key;
    if (raw.includes('@')) {
      column = 'email';
      key = raw.toLowerCase();
    } else {
      column = 'phone';
      try {
        key = normalizeUgPhone(raw);
      } catch {
        throw new HttpError(401, 'Wrong email, phone number or password', 'bad_login');
      }
    }
    const t = Date.parse(now());
    if (!loginByPhone.allow(key, t) || !loginByIp.allow(ip, t)) {
      throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.', 'rate_limited');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare(`SELECT * FROM users WHERE ${column} = ?`).get(key);
    // Hash even when the user is missing so timing does not reveal who has an account.
    const ok = verifyPassword(password, user?.password_hash ?? 'scrypt$AAAA$AAAA') && user;
    if (!ok) throw new HttpError(401, 'Wrong email, phone number or password', 'bad_login');
    if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'suspended');
    return startSession(user);
  });

  // ---------- routes: any signed-in user ----------

  function meView(u) {
    const view = { id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email ?? null, status: u.status };
    if (u.role === 'captain') {
      const p = getProfile(u.id);
      view.captain = {
        bikePlate: p.bike_plate,
        bikeModel: p.bike_model,
        stageName: p.stage_name,
        vehicleType: p.vehicle_type,
        online: Boolean(p.online),
      };
    }
    return view;
  }

  router.add('GET', '/api/me', ({ user }) => ({ user: meView(user) }), { roles: ['passenger', 'captain', 'admin'] });

  router.add(
    'POST',
    '/api/auth/logout',
    ({ token }) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return { ok: true };
    },
    { roles: ['passenger', 'captain', 'admin'] },
  );

  router.add(
    'GET',
    '/api/trips/history',
    ({ user }) => {
      const col = user.role === 'captain' ? 'captain_id' : 'passenger_id';
      const rows = db
        .prepare(`SELECT * FROM trips WHERE ${col} = ? ORDER BY created_at DESC LIMIT 50`)
        .all(user.id);
      return { trips: rows.map((r) => tripView(r, user.role)) };
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'GET',
    '/api/trips/:id',
    ({ user, params }) => {
      expireStaleTrips();
      const row = getTripRow(params.id);
      const allowed =
        row &&
        (user.role === 'admin' ||
          (user.role === 'passenger' && row.passenger_id === user.id) ||
          (user.role === 'captain' && row.captain_id === user.id));
      if (!allowed) throw new HttpError(404, 'Trip not found');
      return { trip: tripView(row, user.role) };
    },
    { roles: ['passenger', 'captain', 'admin'] },
  );

  router.add(
    'POST',
    '/api/trips/:id/cancel',
    ({ user, params, body }) => {
      const b = body && typeof body === 'object' ? body : {};
      const reason =
        b.reason == null ? null : oneOf(b.reason, 'reason', CANCEL_REASONS[user.role].map((r) => r.id));
      return transaction(db, () => {
        const row = getTripRow(params.id);
        const mine =
          row && (user.role === 'passenger' ? row.passenger_id === user.id : row.captain_id === user.id);
        if (!mine) throw new HttpError(404, 'Trip not found');
        saveTransition(row, transitionTrip(rowToTrip(row), S.CANCELLED, { by: user.role, actorId: user.id, at: now() }));
        db.prepare('UPDATE trips SET cancel_reason = ?, cancelled_by = ? WHERE id = ?').run(reason, user.role, row.id);
        return { trip: tripView(getTripRow(row.id), user.role) };
      });
    },
    { roles: ['passenger', 'captain'] },
  );

  // ---------- routes: messages between the two people on a trip ----------

  function tripForChat(user, id) {
    const row = getTripRow(id);
    const isMember = row && (row.passenger_id === user.id || row.captain_id === user.id);
    if (!isMember || !row.captain_id) throw new HttpError(404, 'Trip not found');
    return row;
  }

  router.add(
    'GET',
    '/api/trips/:id/messages',
    ({ user, params }) => {
      const row = tripForChat(user, params.id);
      const rows = db
        .prepare('SELECT id, sender_id, body, created_at FROM trip_messages WHERE trip_id = ? ORDER BY rowid LIMIT 200')
        .all(row.id);
      db.prepare(
        'UPDATE trip_messages SET read_at = ? WHERE trip_id = ? AND sender_id <> ? AND read_at IS NULL',
      ).run(now(), row.id, user.id);
      return {
        messages: rows.map((m) => ({
          id: m.id,
          mine: m.sender_id === user.id,
          body: m.body,
          createdAt: m.created_at,
        })),
      };
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'POST',
    '/api/trips/:id/messages',
    ({ user, params, body }) => {
      obj(body);
      const row = tripForChat(user, params.id);
      if (!WITH_CAPTAIN_STATUSES.includes(row.status)) {
        throw new HttpError(409, 'Messages are only open while the trip is active', 'chat_closed');
      }
      if (!messagesByUser.allow(user.id, Date.parse(now()))) {
        throw new HttpError(429, 'You are sending messages too fast. Wait a moment.', 'rate_limited');
      }
      const message = text(body.body, 'Message', { min: 1, max: 500 });
      const id = randomUUID();
      const at = now();
      db.prepare('INSERT INTO trip_messages (id, trip_id, sender_id, body, created_at) VALUES (?,?,?,?,?)').run(
        id, row.id, user.id, message, at,
      );
      return { status: 201, body: { message: { id, mine: true, body: message, createdAt: at } } };
    },
    { roles: ['passenger', 'captain'] },
  );

  // ---------- routes: place search ----------

  router.add(
    'GET',
    '/api/places/search',
    async ({ user, query }) => {
      if (!places) throw new HttpError(503, 'Place search is not set up', 'places_unavailable');
      if (!placesByUser.allow(user.id, Date.parse(now()))) {
        throw new HttpError(429, 'Searching too fast. Wait a moment.', 'rate_limited');
      }
      const q = String(query.q ?? '');
      let near = null;
      if (query.lat !== undefined && query.lng !== undefined) {
        near = point({ lat: Number(query.lat), lng: Number(query.lng) }, 'near');
      }
      try {
        return { places: await places.search(q, near) };
      } catch {
        throw new HttpError(503, 'Place search is busy. Try again in a moment.', 'places_failed');
      }
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'GET',
    '/api/places/reverse',
    async ({ user, query }) => {
      if (!places) throw new HttpError(503, 'Place search is not set up', 'places_unavailable');
      if (!placesByUser.allow(user.id, Date.parse(now()))) {
        throw new HttpError(429, 'Searching too fast. Wait a moment.', 'rate_limited');
      }
      const at = point({ lat: Number(query.lat), lng: Number(query.lng) }, 'location');
      try {
        return { place: await places.reverse(at.lat, at.lng) };
      } catch {
        throw new HttpError(503, 'Place search is busy. Try again in a moment.', 'places_failed');
      }
    },
    { roles: ['passenger', 'captain'] },
  );

  // ---------- routes: passenger ----------

  router.add(
    'GET',
    '/api/passenger/nearby',
    ({ query }) => {
      const at = point({ lat: Number(query.lat), lng: Number(query.lng) }, 'location');
      const drivers = nearbyCaptains(at);
      return { drivers, summary: nearbySummary(drivers) };
    },
    { roles: ['passenger'] },
  );


  router.add(
    'POST',
    '/api/fare/estimate',
    async ({ body }) => {
      obj(body);
      const pickup = point(body.pickup, 'pickup');
      const route = await routeFor(pickup, point(body.dropoff, 'dropoff'));
      const near = nearbySummary(nearbyCaptains(pickup));
      const options = VEHICLE_TYPES.map((t) => ({
        vehicleType: t,
        fare: priceFor(route, t).fare,
        nearbyCount: near[t].count,
        etaMin: near[t].etaMin,
      }));
      return {
        distanceKm: round1(route.distanceKm),
        durationMin: Math.round(route.durationMin),
        fare: options[0].fare,
        options,
        source: route.source,
        paymentMethods: ['cash'],
      };
    },
    { roles: ['passenger'] },
  );

  router.add(
    'POST',
    '/api/trips',
    async ({ user, body }) => {
      obj(body);
      const pickup = point(body.pickup, 'pickup');
      const dropoff = point(body.dropoff, 'dropoff');
      const pm = body.paymentMethod ?? 'cash';
      if (pm !== 'cash') {
        throw new HttpError(400, 'Only cash payment is available right now', 'payment_unavailable');
      }
      const pickupLabel = text(body.pickupLabel, 'pickupLabel', { max: 120, optional: true });
      const dropoffLabel = text(body.dropoffLabel, 'dropoffLabel', { max: 120, optional: true });
      const vehicleType = body.vehicleType === undefined ? 'boda' : oneOf(body.vehicleType, 'vehicleType', VEHICLE_TYPES);
      const q = await quote(pickup, dropoff, vehicleType);
      const id = randomUUID();
      const at = now();
      const trip = createTrip({ id, passengerId: user.id, pickup, dropoff, fare: q.fare, paymentMethod: 'cash', at });
      transaction(db, () => {
        if (activeTripForPassenger(user.id)) {
          throw new HttpError(409, 'You already have a trip in progress', 'trip_active');
        }
        db.prepare(
          `INSERT INTO trips (id, passenger_id, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng,
             dropoff_label, distance_km, duration_min, route_source, fare, commission, captain_earnings,
             payment_method, status, history, created_at, updated_at, vehicle_type)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id, user.id, pickup.lat, pickup.lng, pickupLabel, dropoff.lat, dropoff.lng, dropoffLabel,
          q.distanceKm, q.durationMin, q.source, q.fare, q.commission, q.captainEarnings,
          trip.paymentMethod, trip.status, JSON.stringify(trip.history), at, at, vehicleType,
        );
      });
      return { status: 201, body: { trip: tripView(getTripRow(id), 'passenger') } };
    },
    { roles: ['passenger'] },
  );

  router.add(
    'GET',
    '/api/passenger/current',
    ({ user }) => {
      expireStaleTrips();
      const active = activeTripForPassenger(user.id);
      const since = new Date(Date.parse(now()) - 24 * 3600 * 1000).toISOString();
      const unrated = db
        .prepare(
          `SELECT * FROM trips WHERE passenger_id = ? AND status = 'completed' AND rating IS NULL
           AND completed_at >= ? ORDER BY completed_at DESC LIMIT 1`,
        )
        .get(user.id, since);
      return {
        trip: active ? { ...tripView(active, 'passenger'), unread: unreadFor(active.id, user.id) } : null,
        unrated: unrated ? tripView(unrated, 'passenger') : null,
      };
    },
    { roles: ['passenger'] },
  );

  router.add(
    'POST',
    '/api/trips/:id/rate',
    ({ user, params, body }) => {
      obj(body);
      const rating = int(body.rating, 'rating', { min: 1, max: 5 });
      const comment = text(body.comment, 'comment', { max: 200, optional: true });
      const row = getTripRow(params.id);
      if (!row || row.passenger_id !== user.id) throw new HttpError(404, 'Trip not found');
      if (row.status !== S.COMPLETED) throw bad('You can only rate a finished trip');
      const res = db
        .prepare('UPDATE trips SET rating = ?, rating_comment = ? WHERE id = ? AND rating IS NULL')
        .run(rating, comment, row.id);
      if (res.changes !== 1) throw new HttpError(409, 'You already rated this trip');
      return { ok: true };
    },
    { roles: ['passenger'] },
  );

  // ---------- routes: captain ----------

  function requireActiveCaptain(user) {
    if (user.status === 'pending') {
      throw new HttpError(403, 'Your account is waiting for approval by Smart Boda', 'pending_approval');
    }
    if (user.status !== 'active') throw new HttpError(403, 'This account is not active', 'not_active');
  }

  router.add(
    'POST',
    '/api/captain/presence',
    ({ user, body }) => {
      requireActiveCaptain(user);
      obj(body);
      const online = bool(body.online, 'online');
      if (online) {
        const p = point(body, 'location');
        db.prepare('UPDATE captain_profiles SET online = 1, lat = ?, lng = ?, location_at = ? WHERE user_id = ?').run(
          p.lat, p.lng, now(), user.id,
        );
      } else {
        if (activeTripForCaptain(user.id)) throw new HttpError(409, 'Finish your current trip first', 'on_trip');
        db.prepare('UPDATE captain_profiles SET online = 0 WHERE user_id = ?').run(user.id);
      }
      return { online };
    },
    { roles: ['captain'] },
  );

  router.add(
    'POST',
    '/api/captain/location',
    ({ user, body }) => {
      requireActiveCaptain(user);
      const p = point(obj(body), 'location');
      db.prepare('UPDATE captain_profiles SET lat = ?, lng = ?, location_at = ? WHERE user_id = ?').run(
        p.lat, p.lng, now(), user.id,
      );
      return { ok: true };
    },
    { roles: ['captain'] },
  );

  router.add(
    'GET',
    '/api/captain/offers',
    ({ user }) => {
      requireActiveCaptain(user);
      expireStaleTrips();
      const profile = getProfile(user.id);
      if (!profile.online || activeTripForCaptain(user.id)) return { offers: [] };
      const cfg = getDispatchConfig(db);
      const captains = candidateCaptains();
      const requested = db.prepare('SELECT * FROM trips WHERE status = ? ORDER BY created_at').all(S.REQUESTED);
      const offers = [];
      for (const row of requested) {
        const ranked = rankingFor(row, captains);
        const me = ranked.find((c) => c.id === user.id);
        if (!me) continue;
        offers.push({
          trip: tripView(row, 'captain'),
          distanceToPickupKm: round1(me.distanceKm),
          expiresAt: new Date(Date.parse(row.created_at) + cfg.offerSeconds * 1000).toISOString(),
        });
      }
      return { offers };
    },
    { roles: ['captain'] },
  );

  router.add(
    'GET',
    '/api/captain/current',
    ({ user }) => {
      requireActiveCaptain(user);
      const row = activeTripForCaptain(user.id);
      return { trip: row ? { ...tripView(row, 'captain'), unread: unreadFor(row.id, user.id) } : null };
    },
    { roles: ['captain'] },
  );

  router.add(
    'POST',
    '/api/trips/:id/accept',
    ({ user, params }) => {
      requireActiveCaptain(user);
      return transaction(db, () => {
        const profile = getProfile(user.id);
        if (!profile.online) throw new HttpError(409, 'Go online to accept trips', 'offline');
        if (activeTripForCaptain(user.id)) throw new HttpError(409, 'Finish your current trip first', 'on_trip');
        const row = getTripRow(params.id);
        if (!row) throw new HttpError(404, 'Trip not found');
        if (row.status !== S.REQUESTED) throw new HttpError(409, 'Another captain took this trip', 'taken');
        const ranked = rankingFor(row, candidateCaptains());
        if (!ranked.some((c) => c.id === user.id)) {
          throw new HttpError(409, 'This trip is no longer offered to you', 'not_offered');
        }
        saveTransition(row, transitionTrip(rowToTrip(row), S.ACCEPTED, { by: 'captain', actorId: user.id, at: now() }));
        return { trip: tripView(getTripRow(row.id), 'captain') };
      });
    },
    { roles: ['captain'] },
  );

  router.add(
    'POST',
    '/api/trips/:id/decline',
    ({ user, params }) => {
      requireActiveCaptain(user);
      const row = getTripRow(params.id);
      if (!row || row.status !== S.REQUESTED) throw new HttpError(404, 'Trip not found');
      db.prepare('INSERT OR IGNORE INTO declines (trip_id, captain_id, created_at) VALUES (?,?,?)').run(
        row.id, user.id, now(),
      );
      return { ok: true };
    },
    { roles: ['captain'] },
  );

  for (const [action, status] of [
    ['arrived', S.ARRIVED],
    ['start', S.IN_PROGRESS],
    ['complete', S.COMPLETED],
  ]) {
    router.add(
      'POST',
      `/api/trips/:id/${action}`,
      ({ user, params }) => {
        requireActiveCaptain(user);
        return transaction(db, () => {
          const row = getTripRow(params.id);
          if (!row || row.captain_id !== user.id) throw new HttpError(404, 'Trip not found');
          const at = now();
          saveTransition(
            row,
            transitionTrip(rowToTrip(row), status, { by: 'captain', actorId: user.id, at }),
            status === S.COMPLETED ? at : null,
          );
          return { trip: tripView(getTripRow(row.id), 'captain') };
        });
      },
      { roles: ['captain'] },
    );
  }

  /** Commission the captain still owes Smart Boda for cash trips. */
  function commissionOwed(captainId) {
    const earned = db
      .prepare(
        `SELECT COALESCE(SUM(commission),0) AS v FROM trips
         WHERE captain_id = ? AND status = 'completed' AND payment_method = 'cash'`,
      )
      .get(captainId).v;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM settlements WHERE captain_id = ?').get(captainId).v;
    return earned - paid;
  }

  router.add(
    'GET',
    '/api/captain/earnings',
    ({ user, query }) => {
      requireActiveCaptain(user);
      const days = Math.min(90, Math.max(1, Number.parseInt(query.days ?? '7', 10) || 7));
      const since = new Date(Date.parse(now()) - days * 86400 * 1000).toISOString();
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS trips, COALESCE(SUM(fare),0) AS gross, COALESCE(SUM(commission),0) AS commission,
             COALESCE(SUM(captain_earnings),0) AS net
           FROM trips WHERE captain_id = ? AND status = 'completed' AND completed_at >= ?`,
        )
        .get(user.id, since);
      const byDay = db
        .prepare(
          `SELECT date(datetime(completed_at, '+3 hours')) AS day, COUNT(*) AS trips,
             SUM(fare) AS gross, SUM(captain_earnings) AS net
           FROM trips WHERE captain_id = ? AND status = 'completed' AND completed_at >= ?
           GROUP BY day ORDER BY day DESC`,
        )
        .all(user.id, since);
      return {
        days,
        totals: { ...totals },
        byDay: byDay.map((d) => ({ ...d })),
        commissionOwed: commissionOwed(user.id),
      };
    },
    { roles: ['captain'] },
  );

  // ---------- routes: admin ----------

  router.add(
    'GET',
    '/api/admin/captains',
    ({ query }) => {
      const status = query.status;
      const rows = db
        .prepare(
          `SELECT u.id, u.name, u.phone, u.status, u.created_at, p.bike_plate, p.bike_model, p.national_id,
             p.permit_number, p.stage_name, p.online, p.vehicle_type,
             (SELECT COUNT(*) FROM trips t WHERE t.captain_id = u.id AND t.status = 'completed') AS trips,
             (SELECT AVG(rating) FROM trips t WHERE t.captain_id = u.id AND t.rating IS NOT NULL) AS avg_rating
           FROM users u JOIN captain_profiles p ON p.user_id = u.id
           WHERE u.role = 'captain' AND (? IS NULL OR u.status = ?)
           ORDER BY u.created_at DESC`,
        )
        .all(status ?? null, status ?? null);
      return {
        captains: rows.map((r) => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          status: r.status,
          createdAt: r.created_at,
          bikePlate: r.bike_plate,
          bikeModel: r.bike_model,
          nationalId: r.national_id,
          permitNumber: r.permit_number,
          stageName: r.stage_name,
          vehicleType: r.vehicle_type,
          online: Boolean(r.online),
          trips: r.trips,
          avgRating: r.avg_rating == null ? null : round1(r.avg_rating),
          commissionOwed: commissionOwed(r.id),
        })),
      };
    },
    { roles: ['admin'] },
  );

  for (const [action, status] of [
    ['approve', 'active'],
    ['suspend', 'suspended'],
  ]) {
    router.add(
      'POST',
      `/api/admin/captains/:id/${action}`,
      ({ params }) => {
        const u = getUser(params.id);
        if (!u || u.role !== 'captain') throw new HttpError(404, 'Captain not found');
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
        if (status === 'suspended') db.prepare('UPDATE captain_profiles SET online = 0 WHERE user_id = ?').run(u.id);
        return { ok: true, status };
      },
      { roles: ['admin'] },
    );
  }

  router.add(
    'POST',
    '/api/admin/captains/:id/settle',
    ({ params, body }) => {
      obj(body);
      const u = getUser(params.id);
      if (!u || u.role !== 'captain') throw new HttpError(404, 'Captain not found');
      const amount = int(body.amount, 'amount', { min: 1, max: 100_000_000 });
      const note = text(body.note, 'note', { max: 200, optional: true });
      db.prepare('INSERT INTO settlements (id, captain_id, amount, note, created_at) VALUES (?,?,?,?,?)').run(
        randomUUID(), u.id, amount, note, now(),
      );
      return { ok: true, commissionOwed: commissionOwed(u.id) };
    },
    { roles: ['admin'] },
  );

  router.add(
    'GET',
    '/api/admin/trips',
    ({ query }) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
      const rows = db
        .prepare('SELECT * FROM trips WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?')
        .all(query.status ?? null, query.status ?? null, limit);
      return { trips: rows.map((r) => tripView(r, 'admin')) };
    },
    { roles: ['admin'] },
  );

  router.add(
    'GET',
    '/api/admin/live',
    () => {
      expireStaleTrips();
      const captains = db
        .prepare(
          `SELECT u.id, u.name, p.bike_plate, p.vehicle_type, p.lat, p.lng, p.location_at,
             EXISTS (SELECT 1 FROM trips t WHERE t.captain_id = u.id
                     AND t.status IN (${placeholders(WITH_CAPTAIN_STATUSES)})) AS on_trip
           FROM captain_profiles p JOIN users u ON u.id = p.user_id
           WHERE p.online = 1 AND p.lat IS NOT NULL`,
        )
        .all(...WITH_CAPTAIN_STATUSES)
        .map((c) => ({
          id: c.id, name: c.name, bikePlate: c.bike_plate, vehicleType: c.vehicle_type, lat: c.lat, lng: c.lng,
          locationAt: c.location_at, onTrip: Boolean(c.on_trip),
        }));
      const trips = db
        .prepare(`SELECT * FROM trips WHERE status IN (${placeholders(ACTIVE_STATUSES)}) ORDER BY created_at`)
        .all(...ACTIVE_STATUSES)
        .map((r) => tripView(r, 'admin'));
      return { captains, trips };
    },
    { roles: ['admin'] },
  );

  router.add(
    'GET',
    '/api/admin/stats',
    () => {
      const dayStart = new Date(Date.parse(now()) + 3 * 3600 * 1000);
      dayStart.setUTCHours(0, 0, 0, 0);
      const todayFrom = new Date(dayStart.getTime() - 3 * 3600 * 1000).toISOString(); // midnight in Uganda
      const count = (sql, ...p) => db.prepare(sql).get(...p).v;
      return {
        passengers: count("SELECT COUNT(*) AS v FROM users WHERE role = 'passenger'"),
        captains: count("SELECT COUNT(*) AS v FROM users WHERE role = 'captain'"),
        captainsPending: count("SELECT COUNT(*) AS v FROM users WHERE role = 'captain' AND status = 'pending'"),
        captainsOnline: count('SELECT COUNT(*) AS v FROM captain_profiles WHERE online = 1'),
        tripsToday: count('SELECT COUNT(*) AS v FROM trips WHERE created_at >= ?', todayFrom),
        completedToday: count("SELECT COUNT(*) AS v FROM trips WHERE status = 'completed' AND completed_at >= ?", todayFrom),
        completedTotal: count("SELECT COUNT(*) AS v FROM trips WHERE status = 'completed'"),
        grossTotal: count("SELECT COALESCE(SUM(fare),0) AS v FROM trips WHERE status = 'completed'"),
        commissionTotal: count("SELECT COALESCE(SUM(commission),0) AS v FROM trips WHERE status = 'completed'"),
        settledTotal: count('SELECT COALESCE(SUM(amount),0) AS v FROM settlements'),
      };
    },
    { roles: ['admin'] },
  );

  router.add('GET', '/api/admin/settings', () => ({ fare: getFareConfig(db), dispatch: getDispatchConfig(db), vehicles: getVehicleConfig(db) }), {
    roles: ['admin'],
  });
  router.add('PUT', '/api/admin/settings', ({ body }) => updateSettings(db, body), { roles: ['admin'] });

  // ---------- the HTTP handler ----------

  function clientIp(req) {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function authenticate(req) {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    const row = db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), now());
    return row ? { user: row, token } : null;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/') {
        res.writeHead(302, { Location: '/admin' });
        return res.end();
      }
      if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
        if (!adminHtmlPath) throw new HttpError(404, 'Not found');
        const html = await readFile(adminHtmlPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        return res.end(html);
      }

      const { route, params, pathMatched } = router.find(req.method, path);
      if (!route) {
        throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
      }

      let user = null;
      let token = null;
      const roles = route.options.roles;
      if (roles) {
        const auth = authenticate(req);
        if (!auth) throw new HttpError(401, 'Please sign in', 'unauthenticated');
        if (auth.user.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'suspended');
        if (!roles.includes(auth.user.role)) throw new HttpError(403, 'Not allowed', 'forbidden');
        user = auth.user;
        token = auth.token;
      }

      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
      const out = await route.handler({
        req, user, token, params, body, ip: clientIp(req), query: Object.fromEntries(url.searchParams),
      });
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) {
        return sendJson(res, out.status, out.body);
      }
      return sendJson(res, 200, out);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, code: err.code });
      }
      if (err instanceof TripError) return sendJson(res, 409, { error: err.message, code: 'trip_rule' });
      console.error('request failed:', err);
      return sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  }

  return { handle, server: createServer(handle) };
}
