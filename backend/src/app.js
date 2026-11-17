// The Smart Boda API. Passengers, captains and admins all talk to this.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash, randomInt } from 'node:crypto';

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
import {
  getFareConfig, getAppInfo, getDispatchConfig, getVehicleConfig, getNightConfig, getLimits, updateSettings,
} from './settings.js';
import { nightPercent } from './night.js';
import * as wallet from './wallet.js';
import * as ledger from './ledger.js';
import { captainCancelCounts, passengerCancelCount, captainStanding, passengerStanding, reviewFlags } from './behavior.js';
import { haversineKm } from './geo.js';
import { isVerifiedSuccess, isFailedStatus } from './livepay.js';
import { VEHICLE_TYPES, VEHICLE_SEATS, CANCEL_REASONS, scaleFareConfig, etaMinutes } from './vehicles.js';
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
  mailer = null,
  livepay = null,
  push = null,
  livepayStatus = null,
  publicUrl = null,
  backups = null,
}) {
  const router = new Router();
  const loginByPhone = new RateLimiter(10, 15 * 60 * 1000);
  const loginByIp = new RateLimiter(40, 15 * 60 * 1000);
  const registerByIp = new RateLimiter(20, 60 * 60 * 1000);
  const placesByUser = new RateLimiter(60, 60 * 1000);
  const messagesByUser = new RateLimiter(40, 60 * 1000);
  const forgotByIp = new RateLimiter(10, 60 * 60 * 1000);
  const forgotByEmail = new RateLimiter(3, 60 * 60 * 1000);
  const resetByEmail = new RateLimiter(5, 15 * 60 * 1000);
  const fmtUgx = (n) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

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

  const pushState = { sent: 0, failed: 0, lastError: null, lastErrorAt: null, lastSentAt: null };

  /** Sends a push notification to every phone the person is signed in on. Never blocks or fails a request. */
  function notify(userId, { title, body, data = {} }, onlyIf = null) {
    if (!push || !userId) return;
    setImmediate(async () => {
      try {
        if (onlyIf && !onlyIf()) return; // the situation changed (or rolled back) before we got to send
        const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId);
        for (const { token } of tokens) {
          try {
            const r = await push.send(token, { title, body, data });
            if (r === 'unregistered') db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
            else {
              pushState.sent += 1;
              pushState.lastSentAt = now();
            }
          } catch (err) {
            console.error(`Push failed: ${err.message}`);
            pushState.failed += 1;
            pushState.lastError = err.message;
            pushState.lastErrorAt = now();
          }
        }
      } catch (err) {
        console.error(`Push failed: ${err.message}`);
      }
    });
  }

  /** The words for each step of a trip, sent to the passenger. */
  function notifyTripStep(tripId, status) {
    const row = getTripRow(tripId);
    if (!row) return;
    const cap = row.captain_id ? getUser(row.captain_id) : null;
    const words = {
      accepted: ['Captain on the way', `${cap?.name ?? 'Your captain'} accepted your request and is coming.`],
      arrived: ['Your captain has arrived', 'Please head to your captain now.'],
      in_progress: ['Trip started', 'Have a safe trip.'],
      completed: ['Trip complete', 'Thank you for riding with Smart Boda. Please rate your captain.'],
      no_captain: ['No captain found', 'Nobody nearby could take your request. Please try again.'],
    }[status];
    if (!words) return;
    notify(row.passenger_id, { title: words[0], body: words[1], data: { type: 'trip', tripId, status } }, () => getTripRow(tripId)?.status === status);
  }

  function saveTransition(oldRow, next, completedAt = null) {
    const res = db
      .prepare(
        `UPDATE trips SET captain_id = ?, status = ?, history = ?, updated_at = ?,
           completed_at = COALESCE(?, completed_at)
         WHERE id = ? AND status = ?`,
      )
      .run(next.captainId, next.status, JSON.stringify(next.history), now(), completedAt, next.id, oldRow.status);
    if (res.changes !== 1) throw new HttpError(409, 'This trip just changed. Please refresh.', 'trip_changed');
    notifyTripStep(next.id, next.status);
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
      kind: row.kind,
      deliveryItem: row.delivery_item,
      receiverName: row.receiver_name,
      receiverPhone: row.receiver_phone,
      nightPercent: row.night_percent,
      autoStarted: Boolean(row.auto_started),
      pinVerified: Boolean(row.pin_verified),
    };
    // Only the passenger sees the code; they tell it to the rider when the rider arrives.
    // For a delivery the code is used at the end, so the sender can pass it to the receiver.
    const pinStates = row.kind === 'delivery' ? ['accepted', 'arrived', 'in_progress'] : ['accepted', 'arrived'];
    if (viewer === 'passenger' && row.pickup_pin && !row.pin_verified && pinStates.includes(row.status)) {
      view.pickupPin = row.pickup_pin;
    }
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
          photoVersion: u.photo_version ?? 0,
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
      const pr = db
        .prepare('SELECT AVG(passenger_rating) AS avg, COUNT(passenger_rating) AS n FROM trips WHERE passenger_id = ?')
        .get(pu.id);
      view.passenger = {
        id: pu.id, name: pu.name, phone: pu.phone,
        rating: pr.avg == null ? null : round1(pr.avg), ratingCount: pr.n,
      };
      view.passengerRating = row.passenger_rating;
      view.commission = row.commission;
      // Cash is the captain's own money and only commission is taken from credit, so earnings show for in-app payments only.
      view.captainEarnings = viewer === 'captain' && row.payment_method === 'cash' ? null : row.captain_earnings;
    }
    return view;
  }

  // ---------- trips that nobody accepted ----------

  /** A trip still "in progress" long after it should have ended (phone off, app closed): finish it so the commission is charged. */
  function finishAbandonedTrips() {
    const rows = db.prepare('SELECT * FROM trips WHERE status = ?').all(S.IN_PROGRESS);
    for (const row of rows) {
      const hist = JSON.parse(row.history);
      const startedAt = [...hist].reverse().find((h) => h.status === S.IN_PROGRESS)?.at;
      if (!startedAt) continue;
      const allowedMin = Math.max(90, row.duration_min * 3 + 30);
      if (Date.parse(now()) - Date.parse(startedAt) < allowedMin * 60 * 1000) continue;
      try {
        transaction(db, () => {
          const fresh = getTripRow(row.id);
          if (fresh?.status === S.IN_PROGRESS) completeTrip(fresh, 'system', null);
        });
      } catch (err) {
        if (!(err instanceof HttpError) && !(err instanceof TripError)) throw err;
      }
    }
  }

  function expireStaleTrips() {
    finishAbandonedTrips();
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

  /** Throws when this captain may not take trips right now (cancelled too many accepted trips). */
  function captainGate(userId) {
    const st = captainStanding(captainCancelCounts(db, now()).get(userId), now());
    if (st.level === 'paused') throw new HttpError(403, st.message, 'paused');
  }

  function candidateCaptains() {
    const cancels = captainCancelCounts(db, now());
    return db
      .prepare(
        `SELECT u.id, p.lat, p.lng, p.location_at, p.vehicle_type,
           EXISTS (SELECT 1 FROM trips t WHERE t.captain_id = u.id
                   AND t.status IN (${placeholders(WITH_CAPTAIN_STATUSES)})) AS on_trip
         FROM captain_profiles p JOIN users u ON u.id = p.user_id
         WHERE p.online = 1 AND u.status = 'active' AND p.lat IS NOT NULL`,
      )
      .all(...WITH_CAPTAIN_STATUSES)
      .map((c) => ({ c, st: captainStanding(cancels.get(c.id), now()) }))
      .filter(({ st }) => st.level !== 'paused')
      .map(({ c, st }) => ({
        distanceFactor: st.rankFactor,
        creditFree: wallet.creditFree(db, c.id),
        id: c.id,
        approved: true,
        online: true,
        onTrip: Boolean(c.on_trip),
        vehicleType: c.vehicle_type,
        location: { lat: c.lat, lng: c.lng },
        locationAt: c.location_at,
      }));
  }

  function rankingFor(row, captains, { ignoreCredit = false } = {}) {
    const cfg = getDispatchConfig(db);
    const declined = db.prepare('SELECT captain_id FROM declines WHERE trip_id = ?').all(row.id);
    return rankCaptains({
      pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
      // A cash trip goes only to riders whose free commission credit covers its commission.
      captains: captains.filter(
        (c) => c.vehicleType === row.vehicle_type && (ignoreCredit || row.payment_method !== 'cash' || c.creditFree >= row.commission),
      ),
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

  function priceFor(route, vehicleType, kind = 'ride') {
    const vehicle = getVehicleConfig(db)[vehicleType]?.multiplier ?? 1;
    const delivery = kind === 'delivery' ? getLimits(db).deliveryMultiplier : 1;
    const night = nightPercent(now(), getNightConfig(db));
    return {
      ...calculateFare(
        { distanceKm: route.distanceKm, durationMin: route.durationMin },
        scaleFareConfig(getFareConfig(db), vehicle * delivery * (1 + night / 100)),
      ),
      nightPercent: night,
    };
  }

  async function quote(pickup, dropoff, vehicleType = 'boda', kind = 'ride') {
    const route = await routeFor(pickup, dropoff);
    return {
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      source: route.source,
      ...priceFor(route, vehicleType, kind),
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
    passwordReset: Boolean(mailer),
  }));

  // Forgot password: a 6-digit code goes to the account's email address.
  router.add('POST', '/api/auth/forgot', async ({ body, ip }) => {
    obj(body);
    const email = parseEmail(body.email, false);
    const t = Date.parse(now());
    if (!forgotByIp.allow(ip, t) || !forgotByEmail.allow(email, t)) {
      throw new HttpError(429, 'Too many requests. Try again later.', 'rate_limited');
    }
    if (!mailer) {
      throw new HttpError(503, 'Password reset by email is not set up yet. Ask Smart Boda support to reset it.', 'email_unavailable');
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && user.status !== 'suspended') {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(
        hashToken(user.id + code), user.id, new Date(t + 15 * 60 * 1000).toISOString(),
      );
      try {
        await mailer.send({
          to: email,
          subject: 'Your Smart Boda reset code',
          text: `Your Smart Boda code is ${code}. It works for 15 minutes. If you did not ask for it, ignore this email.`,
        });
      } catch (err) {
        console.error('reset email failed:', err.message);
        throw new HttpError(503, 'We could not send the email. Try again in a moment.', 'email_failed');
      }
    }
    // Same answer whether or not the email has an account.
    return { ok: true };
  });

  router.add('POST', '/api/auth/reset', ({ body }) => {
    obj(body);
    const email = parseEmail(body.email, false);
    const code = text(body.code, 'Code', { min: 6, max: 6 });
    const password = text(body.password, 'Password', { min: 6, max: 128 });
    const t = Date.parse(now());
    if (!resetByEmail.allow(email, t)) {
      throw new HttpError(429, 'Too many tries. Ask for a new code in a few minutes.', 'rate_limited');
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const row = user
      ? db
          .prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
          .get(hashToken(user.id + code), now())
      : null;
    if (!row) throw new HttpError(400, 'That code is wrong or has expired', 'bad_code');
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    return { ok: true };
  });

  router.add('POST', '/api/auth/register', ({ body, ip }) => {
    if (!registerByIp.allow(ip, Date.parse(now()))) {
      throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.', 'rate_limited');
    }
    obj(body);
    const role = oneOf(body.role, 'role', ['passenger', 'captain']);
    const name = text(body.name, 'Name', { min: 2, max: 80 });
    const email = parseEmail(body.email);
    // Passengers may sign up with just an email. Captains always need a phone number.
    const hasPhone = body.phone != null && String(body.phone).trim() !== '';
    if (!hasPhone && !(role === 'passenger' && email)) throw bad('Enter your phone number', 'bad_phone');
    const phone = hasPhone ? parsePhone(body.phone) : null;
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
    // Same email as an account made with a typed email. Google has verified this address, so the
    // person here owns it: attach Google to that account. Whoever typed the email at sign-up never
    // proved they owned it, so the old password is replaced and old sign-ins are ended. That stops
    // someone who pre-registered another person's email from keeping access.
    const sameEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(g.email);
    if (sameEmail) {
      if (sameEmail.role !== 'passenger') {
        throw new HttpError(409, 'That email belongs to a captain account. Use the Smart Boda Captain app.', 'email_taken');
      }
      if (sameEmail.status === 'suspended') throw new HttpError(403, 'This account is suspended', 'suspended');
      transaction(db, () => {
        db.prepare('UPDATE users SET google_sub = ?, password_hash = ? WHERE id = ?').run(
          g.sub, hashPassword(randomUUID() + randomUUID()), sameEmail.id,
        );
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(sameEmail.id);
      });
      return startSession(getUser(sameEmail.id));
    }
    const name = (typeof body.name === 'string' && body.name.trim()) || g.name;
    if (name.trim().length < 2) {
      return { needsProfile: true, name: g.name, email: g.email };
    }
    if (!registerByIp.allow(ip, t)) {
      throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.', 'rate_limited');
    }
    const cleanName = text(name, 'Name', { min: 2, max: 80 });
    const phone = body.phone == null || String(body.phone).trim() === '' ? null : parsePhone(body.phone);
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
    const view = { id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email ?? null, status: u.status, backupPhone: u.backup_phone ?? null, photoVersion: u.photo_version ?? 0 };
    if (u.role === 'passenger') {
      view.wallet = { balance: wallet.balance(db, u.id), available: wallet.available(db, u.id) };
      view.standing = passengerStanding(passengerCancelCount(db, u.id, now()), now());
    }
    if (u.role === 'captain') {
      const p = getProfile(u.id);
      view.wallet = { balance: wallet.earningsPayable(db, u.id), available: wallet.earningsPayable(db, u.id) };
      view.credit = { free: wallet.creditFree(db, u.id), reserved: wallet.creditReserved(db, u.id) };
      view.standing = captainStanding(captainCancelCounts(db, now()).get(u.id), now());
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

  // The main phone number, for people who signed up with an email only. Riders call it.
  router.add(
    'PUT',
    '/api/me/phone',
    ({ user, body }) => {
      obj(body);
      const phone = parsePhone(body.phone);
      const taken = db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(phone, user.id);
      if (taken) throw new HttpError(409, 'That number is already used by another account', 'phone_taken');
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, user.id);
      return { user: meView(getUser(user.id)) };
    },
    { roles: ['passenger'] },
  );

  // The phone's push token, so Smart Boda can notify it when the app is closed.
  router.add(
    'PUT',
    '/api/me/push-token',
    ({ user, body }) => {
      obj(body);
      const token = text(body.token, 'token', { min: 20, max: 400 });
      db.prepare(
        `INSERT INTO push_tokens (token, user_id, updated_at) VALUES (?,?,?)
         ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`,
      ).run(token, user.id, now());
      return { ok: true, pushOn: Boolean(push) };
    },
    { roles: ['passenger', 'captain'] },
  );

  // "Send me a test notification": proves this phone, the Firebase key and the server all work together.
  router.add(
    'POST',
    '/api/me/push-test',
    async ({ user }) => {
      if (!push) {
        return { ok: false, message: 'The server is not set up for notifications yet. Add FIREBASE_SERVICE_ACCOUNT in Render.' };
      }
      const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(user.id);
      if (!tokens.length) {
        return { ok: false, message: 'This phone has not registered for notifications. Allow notifications, then try again.' };
      }
      let sent = 0;
      let error = null;
      for (const { token } of tokens) {
        try {
          const r = await push.send(token, { title: 'Smart Boda', body: 'Notifications are working on this phone.', data: { type: 'test' } });
          if (r === 'unregistered') db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
          else sent += 1;
        } catch (err) {
          error = err.message;
        }
      }
      if (sent > 0) return { ok: true, message: 'Sent. If nothing appears on this phone, allow notifications for Smart Boda in the phone settings.' };
      return { ok: false, message: error ?? 'That phone is no longer registered. Open the app again and allow notifications.' };
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'GET',
    '/api/admin/push-status',
    () => ({
      on: Boolean(push),
      phones: {
        captains: db.prepare(`SELECT COUNT(*) AS v FROM push_tokens t JOIN users u ON u.id = t.user_id WHERE u.role = 'captain'`).get().v,
        passengers: db.prepare(`SELECT COUNT(*) AS v FROM push_tokens t JOIN users u ON u.id = t.user_id WHERE u.role = 'passenger'`).get().v,
      },
      ...pushState,
    }),
    { roles: ['admin'] },
  );

  // A second number Smart Boda can reach the person on, for example a relative.
  router.add(
    'PUT',
    '/api/me/backup-phone',
    ({ user, body }) => {
      obj(body);
      const empty = body.phone == null || String(body.phone).trim() === '';
      const phone = empty ? null : parsePhone(body.phone);
      if (phone && phone === user.phone) throw bad('Use a different number from your main one');
      db.prepare('UPDATE users SET backup_phone = ? WHERE id = ?').run(phone, user.id);
      return { user: meView(getUser(user.id)) };
    },
    { roles: ['passenger', 'captain'] },
  );

  // A profile picture: small JPEG or PNG, sent as base64 text. Captains show theirs to passengers.
  router.add(
    'PUT',
    '/api/me/photo',
    ({ user, body }) => {
      obj(body);
      const b64 = typeof body.image === 'string' ? body.image : '';
      if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 100) throw bad('Send the picture as base64 text', 'bad_photo');
      const bytes = Buffer.from(b64, 'base64');
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!jpeg && !png) throw bad('The picture must be a JPEG or PNG', 'bad_photo');
      if (bytes.length > 45_000) throw bad('That picture is too big. Choose a smaller one.', 'photo_too_big');
      db.prepare('UPDATE users SET photo = ?, photo_version = photo_version + 1 WHERE id = ?').run(bytes, user.id);
      return { user: meView(getUser(user.id)) };
    },
    { roles: ['passenger', 'captain'] },
  );

  // Who may see a picture: its owner, an admin, and the other person on a trip they share.
  router.add(
    'GET',
    '/api/photos/:id',
    ({ user, params }) => {
      const owner = db.prepare('SELECT id, photo FROM users WHERE id = ?').get(params.id);
      if (!owner || !owner.photo) throw new HttpError(404, 'No picture');
      const allowed =
        user.role === 'admin' ||
        user.id === owner.id ||
        db
          .prepare(
            `SELECT 1 FROM trips WHERE (passenger_id = ? AND captain_id = ?) OR (passenger_id = ? AND captain_id = ?) LIMIT 1`,
          )
          .get(user.id, owner.id, owner.id, user.id);
      if (!allowed) throw new HttpError(404, 'No picture');
      const png = owner.photo[0] === 0x89;
      return { binary: Buffer.from(owner.photo), contentType: png ? 'image/png' : 'image/jpeg' };
    },
    { roles: ['passenger', 'captain', 'admin'] },
  );

  // Contact details and social links, set by the admin. Public so the apps can show them.
  router.add('GET', '/api/app-info', () => ({ app: getAppInfo(db) }));

  // Which LivePay settings the server can see (yes or no only, never the values).
  router.add(
    'GET',
    '/api/admin/payments-status',
    async ({ query }) => ({
      probe: query.probe === '1' && livepay ? await livepay.probe() : null,
      recentTopups: db
        .prepare(
          `SELECT t.id, t.created_at AS createdAt, t.amount, t.status, t.error, u.role,
                  substr(t.phone, 1, 4) || '****' || substr(t.phone, -2) AS phone
           FROM topups t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 10`,
        )
        .all(),
      topupsOn: Boolean(livepay),
      settings: livepayStatus ?? { enabledFlag: Boolean(livepay), apiKey: Boolean(livepay), accountNumber: Boolean(livepay), webhookSecret: Boolean(livepay?.hasWebhookSecret), publicUrl: Boolean(publicUrl) },
      webhookUrl: publicUrl ? `${publicUrl}/api/livepay-webhook` : null,
    }),
    { roles: ['admin'] },
  );

  // Proof the backup bucket works: what happened last, and a button that writes then reads back.
  router.add(
    'GET',
    '/api/admin/backup-status',
    () => ({ on: Boolean(backups), ...(backups ? backups.status() : {}) }),
    { roles: ['admin'] },
  );
  router.add(
    'POST',
    '/api/admin/backup-now',
    async () => {
      if (!backups) throw new HttpError(400, 'Backups are not set up. Add the BACKUP_S3_* settings in Render.', 'backup_off');
      return { result: await backups.verify(), status: backups.status() };
    },
    { roles: ['admin'] },
  );

  router.add(
    'POST',
    '/api/auth/logout',
    ({ token, body }) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      if (body && typeof body.pushToken === 'string') db.prepare('DELETE FROM push_tokens WHERE token = ?').run(body.pushToken);
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
        const prof = row.captain_id ? getProfile(row.captain_id) : null;
        const distM = prof && prof.lat != null ? Math.round(haversineKm({ lat: prof.lat, lng: prof.lng }, { lat: row.pickup_lat, lng: row.pickup_lng }) * 1000) : null;
        saveTransition(row, transitionTrip(rowToTrip(row), S.CANCELLED, { by: user.role, actorId: user.id, at: now() }));
        db.prepare('UPDATE trips SET cancel_reason = ?, cancelled_by = ?, cancelled_from = ?, cancel_distance_m = ? WHERE id = ?').run(
          reason, user.role, row.status, distM, row.id,
        );
        releaseIfReserved(row);
        const other = user.role === 'passenger' ? row.captain_id : row.passenger_id;
        notify(other, { title: 'Trip cancelled', body: user.role === 'passenger' ? 'The passenger cancelled this trip.' : 'Your captain cancelled this trip. You can request another ride.', data: { type: 'trip', tripId: row.id, status: 'cancelled' } }, () => getTripRow(row.id)?.status === 'cancelled');
        return { trip: tripView(getTripRow(row.id), user.role), user: meView(getUser(user.id)) };
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
      const to = row.passenger_id === user.id ? row.captain_id : row.passenger_id;
      notify(to, { title: user.name, body: message.slice(0, 120), data: { type: 'message', tripId: row.id } }, () => Boolean(db.prepare('SELECT 1 FROM trip_messages WHERE id = ?').get(id)));
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


  // The road between two points, to draw on the map. Remembered for a while so the same leg is not looked up twice.
  const routeCache = new Map();
  const routeByUser = new RateLimiter(90, 60 * 1000);
  router.add(
    'POST',
    '/api/route',
    async ({ user, body }) => {
      obj(body);
      const from = point(body.from, 'from');
      const to = point(body.to, 'to');
      if (!routeByUser.allow(user.id, Date.parse(now()))) throw new HttpError(429, 'Too many map requests. Please wait a moment.', 'rate_limited');
      if (haversineKm(from, to) > 80) throw bad('Those places are too far apart');
      const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(4)).join(',');
      const hit = routeCache.get(key);
      if (hit && Date.parse(now()) - hit.at < 10 * 60 * 1000) return { path: hit.path };
      const r = await routing.route(from, to);
      const path = r.path ?? null;
      routeCache.set(key, { path, at: Date.parse(now()) });
      if (routeCache.size > 500) routeCache.delete(routeCache.keys().next().value);
      return { path, distanceKm: round1(r.distanceKm), source: r.source };
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'POST',
    '/api/fare/estimate',
    async ({ user, body }) => {
      obj(body);
      const pickup = point(body.pickup, 'pickup');
      const kind = body.kind === undefined ? 'ride' : oneOf(body.kind, 'kind', ['ride', 'delivery']);
      const route = await routeFor(pickup, point(body.dropoff, 'dropoff'));
      const near = nearbySummary(nearbyCaptains(pickup));
      const options = VEHICLE_TYPES.map((t) => ({
        vehicleType: t,
        seats: VEHICLE_SEATS[t],
        fare: priceFor(route, t, kind).fare,
        nearbyCount: near[t].count,
        etaMin: near[t].etaMin,
      }));
      return {
        distanceKm: round1(route.distanceKm),
        durationMin: Math.round(route.durationMin),
        fare: options[0].fare,
        options,
        source: route.source,
        kind,
        nightPercent: priceFor(route, 'boda', kind).nightPercent,
        path: route.path ?? null, // the road to draw on the map, when we have one
        paymentMethods: ['cash', 'wallet'],
        wallet: { available: wallet.available(db, user.id) },
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
      if (!['cash', 'wallet'].includes(pm)) {
        throw new HttpError(400, 'Choose cash or your Smart Boda wallet', 'payment_unavailable');
      }
      if (!user.phone) {
        throw new HttpError(409, 'Add your phone number so your captain can call you.', 'phone_needed');
      }
      const standing = passengerStanding(passengerCancelCount(db, user.id, now()), now());
      if (standing.level === 'blocked') throw new HttpError(403, standing.message, 'blocked');
      const kind = body.kind === undefined ? 'ride' : oneOf(body.kind, 'kind', ['ride', 'delivery']);
      const delivery =
        kind === 'delivery'
          ? {
              item: text(body.deliveryItem, 'What are we delivering?', { min: 2, max: 120 }),
              receiverName: text(body.receiverName, 'Receiver name', { min: 2, max: 80 }),
              receiverPhone: parsePhone(body.receiverPhone),
            }
          : { item: null, receiverName: null, receiverPhone: null };
      const pickupLabel = text(body.pickupLabel, 'pickupLabel', { max: 120, optional: true });
      const dropoffLabel = text(body.dropoffLabel, 'dropoffLabel', { max: 120, optional: true });
      const vehicleType = body.vehicleType === undefined ? 'boda' : oneOf(body.vehicleType, 'vehicleType', VEHICLE_TYPES);
      const q = await quote(pickup, dropoff, vehicleType, kind);
      const id = randomUUID();
      const at = now();
      const trip = createTrip({ id, passengerId: user.id, pickup, dropoff, fare: q.fare, paymentMethod: pm, at });
      transaction(db, () => {
        if (activeTripForPassenger(user.id)) {
          throw new HttpError(409, 'You already have a trip in progress', 'trip_active');
        }
        if (pm === 'wallet' && wallet.available(db, user.id) < q.fare) {
          throw new HttpError(
            402,
            `Your wallet has ${fmtUgx(wallet.available(db, user.id))}, but this trip costs ${fmtUgx(q.fare)}. Add money or pay cash.`,
            'insufficient_wallet',
          );
        }
        db.prepare(
          `INSERT INTO trips (id, passenger_id, pickup_lat, pickup_lng, pickup_label, dropoff_lat, dropoff_lng,
             dropoff_label, distance_km, duration_min, route_source, fare, commission, captain_earnings,
             payment_method, status, history, created_at, updated_at, vehicle_type,
             kind, delivery_item, receiver_name, receiver_phone, night_percent, pickup_pin, commission_rate)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id, user.id, pickup.lat, pickup.lng, pickupLabel, dropoff.lat, dropoff.lng, dropoffLabel,
          q.distanceKm, q.durationMin, q.source, q.fare, q.commission, q.captainEarnings,
          trip.paymentMethod, trip.status, JSON.stringify(trip.history), at, at, vehicleType,
          kind, delivery.item, delivery.receiverName, delivery.receiverPhone, q.nightPercent,
          String(randomInt(0, 10000)).padStart(4, '0'), getFareConfig(db).commissionRate,
        );
      });
      // Tell the nearest matching riders, even if their app is closed.
      const created = getTripRow(id);
      if (push) {
        for (const r of rankingFor(created, candidateCaptains())) {
          notify(r.id, {
            title: created.kind === 'delivery' ? 'New delivery request' : 'New ride request',
            body: `${created.pickup_label ?? 'A pickup near you'} · ${fmtUgx(created.fare)}`,
            data: { type: 'offer', tripId: id },
          }, () => getTripRow(id)?.status === 'requested');
        }
      }
      return { status: 201, body: { trip: tripView(created, 'passenger') } };
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

  // ---------- routes: wallet ----------

  router.add(
    'GET',
    '/api/wallet',
    async ({ user }) => {
      await settlePendingTopups(user.id, user.role);
      const rider = user.role === 'captain';
      return {
        balance: rider ? wallet.earningsPayable(db, user.id) : wallet.balance(db, user.id),
        held: rider ? 0 : wallet.held(db, user.id),
        available: rider ? wallet.earningsPayable(db, user.id) : wallet.available(db, user.id),
        credit: rider
          ? { free: wallet.creditFree(db, user.id), reserved: wallet.creditReserved(db, user.id) }
          : null,
        pendingWithdrawals: rider ? wallet.pendingWithdrawals(db, user.id) : 0,
        entries: wallet.entries(db, user.id),
        topupAvailable: Boolean(livepay),
      };
    },
    { roles: ['passenger', 'captain'] },
  );

  const topupByUser = new RateLimiter(3, 10 * 60 * 1000);

  /** Asks LivePay what happened to one top-up and, if it truly succeeded, adds the money once. */
  async function reconcileTopup(row) {
    if (row.status !== 'pending') return row.status;
    let d;
    try {
      d = await livepay.status(row.id);
    } catch {
      return 'pending'; // LivePay unreachable: try again later, never guess
    }
    if (isVerifiedSuccess(d, row)) {
      transaction(db, () => {
        const res = db.prepare("UPDATE topups SET status = 'success' WHERE id = ? AND status = 'pending'").run(row.id);
        if (res.changes === 1) {
          const owner = getUser(row.user_id);
          wallet.postTopup(db, { userId: row.user_id, role: owner.role, amount: row.amount, topupId: row.id, at: now() });
        }
      });
      return 'success';
    }
    if (isFailedStatus(d)) {
      db.prepare("UPDATE topups SET status = 'failed' WHERE id = ? AND status = 'pending'").run(row.id);
      return 'failed';
    }
    return 'pending';
  }

  router.add(
    'POST',
    '/api/wallet/topup',
    async ({ user, body }) => {
      if (!livepay) {
        throw new HttpError(
          503,
          'Adding money by mobile money is not switched on yet. Please try again later or contact Smart Boda.',
          'topup_unavailable',
        );
      }
      obj(body);
      const amount = int(body.amount, 'amount', { min: 1000, max: 500_000 });
      const intl = parsePhone(body.phone); // +2567XXXXXXXX
      const phone = `0${intl.slice(4)}`; // 07XXXXXXXX, the form LivePay takes
      if (!/^0[37]\d{8}$/.test(phone)) throw bad('Enter an MTN or Airtel mobile money number', 'bad_phone');
      if (!topupByUser.allow(user.id, Date.parse(now()))) {
        throw new HttpError(429, 'Please wait a few minutes before another top-up.', 'rate_limited');
      }
      const id = `SB${randomUUID().replaceAll('-', '').slice(0, 26)}`;
      db.prepare('INSERT INTO topups (id, user_id, amount, phone, created_at, purpose) VALUES (?,?,?,?,?,?)').run(
        id, user.id, amount, phone, now(), user.role === 'captain' ? 'rider_credit' : 'passenger_wallet',
      );
      try {
        const r = await livepay.collect({ phone, amount, reference: id, description: user.role === 'captain' ? 'Smart Boda commission credit' : 'Smart Boda wallet' });
        db.prepare('UPDATE topups SET internal_reference = ? WHERE id = ?').run(r.internalReference, id);
      } catch (err) {
        if (err.refused) {
          console.error(`LivePay refused a collect request: HTTP ${err.status} ${err.detail ?? ''}`);
          db.prepare("UPDATE topups SET status = 'failed', error = ? WHERE id = ?").run(`LivePay answered HTTP ${err.status}: ${err.detail ?? ''}`.slice(0, 250), id);
          throw new HttpError(502, 'The payment request could not be sent. Please try again.', 'topup_failed');
        }
        // Timeout or network error: LivePay may still have received it. Never send it again;
        // checking its status settles it either way. The reason is kept for the admin to see.
        console.error(`LivePay collect did not complete: ${err.name}: ${err.message}`);
        db.prepare('UPDATE topups SET error = ? WHERE id = ?').run(`${err.name}: ${err.message}`.slice(0, 250), id);
      }
      return { reference: id, status: 'pending' };
    },
    { roles: ['passenger', 'captain'] },
  );

  router.add(
    'GET',
    '/api/wallet/topup/:reference',
    async ({ user, params }) => {
      const row = db.prepare('SELECT * FROM topups WHERE id = ? AND user_id = ?').get(params.reference, user.id);
      if (!row) throw new HttpError(404, 'Payment not found');
      const status = livepay ? await reconcileTopup(row) : row.status;
      return { status, amount: row.amount, balance: user.role === 'captain' ? wallet.creditFree(db, user.id) : wallet.balance(db, user.id) };
    },
    { roles: ['passenger', 'captain'] },
  );

  // LivePay tells us a payment changed. We still ask LivePay for the truth before adding any money.
  router.add('POST', '/api/livepay-webhook', async ({ req, body }) => {
    if (!livepay) throw new HttpError(404, 'Not found');
    obj(body);
    const origin = publicUrl ?? `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
    const ok = livepay.verifyWebhook({
      signature: String(req.headers['x-webhook-signature'] ?? ''),
      origin,
      body,
      nowSec: Date.parse(now()) / 1000,
    });
    if (!ok) throw new HttpError(401, 'Invalid signature', 'bad_signature');
    const row = db.prepare('SELECT * FROM topups WHERE id = ?').get(String(body.customer_reference ?? ''));
    if (row) await reconcileTopup(row);
    return { ok: true };
  });

  // Top-ups that were paid while the app was closed are settled the next time the passenger opens it.
  async function settlePendingTopups(userId) {
    if (!livepay) return;
    const since = new Date(Date.parse(now()) - 24 * 3600 * 1000).toISOString();
    const rows = db
      .prepare("SELECT * FROM topups WHERE user_id = ? AND status = 'pending' AND created_at >= ? LIMIT 3")
      .all(userId, since);
    for (const r of rows) await reconcileTopup(r);
  }

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
        captainGate(user.id);
        const p = point(body, 'location');
        const wasOnline = getProfile(user.id)?.online;
        db.prepare('UPDATE captain_profiles SET online = 1, lat = ?, lng = ?, location_at = ? WHERE user_id = ?').run(
          p.lat, p.lng, now(), user.id,
        );
        // Passengers who asked while nobody was online are still waiting: tell this captain.
        if (!wasOnline && push) {
          expireStaleTrips();
          const captains = candidateCaptains();
          const waiting = db.prepare('SELECT * FROM trips WHERE status = ? ORDER BY created_at').all(S.REQUESTED)
            .filter((row) => rankingFor(row, captains).some((c) => c.id === user.id));
          if (waiting.length) {
            notify(user.id, {
              title: waiting.length === 1 ? 'A passenger is waiting' : `${waiting.length} passengers are waiting`,
              body: `${waiting[0].pickup_label ?? 'A pickup near you'} · ${fmtUgx(waiting[0].fare)}`,
              data: { type: 'offer', tripId: waiting[0].id },
            });
          }
        }
      } else {
        if (activeTripForCaptain(user.id)) throw new HttpError(409, 'Finish your current trip first', 'on_trip');
        db.prepare('UPDATE captain_profiles SET online = 0 WHERE user_id = ?').run(user.id);
      }
      return { online };
    },
    { roles: ['captain'] },
  );

  // If the captain forgets to tap, the phone's own location moves the trip along:
  // near the pickup = arrived; driving away from the pickup = started;
  // sitting at the drop-off after a real ride = completed.
  const ARRIVE_KM = 0.06;
  const LEAVE_KM = 0.15;
  const DROPOFF_KM = 0.08;
  // Past the destination: once the captain has reached the drop-off, every kilometre driven beyond it
  // keeps earning commission for Smart Boda. After this much extra distance the system ends the trip.
  const DROPOFF_REACHED_KM = 0.15;
  const OVERRUN_LIMIT_KM = 1.5;
  const MAX_STEP_KM = 3; // ignore a GPS jump bigger than this between two reports
  function trackOverrun(fresh, p, prev) {
    const dKm = haversineKm(p, { lat: fresh.dropoff_lat, lng: fresh.dropoff_lng });
    if (dKm <= DROPOFF_REACHED_KM) {
      if (!fresh.dropoff_reached_at) db.prepare('UPDATE trips SET dropoff_reached_at = ? WHERE id = ?').run(now(), fresh.id);
      return fresh;
    }
    if (!fresh.dropoff_reached_at || !prev) return fresh;
    const step = haversineKm(prev, p);
    if (!(step > 0) || step > MAX_STEP_KM) return fresh;
    const km = fresh.overrun_km + step;
    const rate = fresh.commission_rate ?? getFareConfig(db).commissionRate;
    const perKm = fresh.fare / Math.max(fresh.distance_km, 1);
    const commission = Math.round((km * perKm * rate) / 100) * 100;
    db.prepare('UPDATE trips SET overrun_km = ?, overrun_commission = ? WHERE id = ?').run(km, commission, fresh.id);
    return getTripRow(fresh.id);
  }
  function autoAdvance(row, p, prev = null) {
    const at = now();
    const lastAt = (status) => [...JSON.parse(row.history)].reverse().find((h) => h.status === status)?.at;
    try {
      transaction(db, () => {
        const fresh = getTripRow(row.id);
        if (!fresh || fresh.status !== row.status) return;
        const trip = rowToTrip(fresh);
        if (fresh.status === S.ACCEPTED && haversineKm(p, trip.pickup) <= ARRIVE_KM) {
          saveTransition(fresh, transitionTrip(trip, S.ARRIVED, { by: 'system', at }));
        } else if (fresh.status === S.ARRIVED) {
          const since = Date.parse(at) - Date.parse(lastAt(S.ARRIVED));
          if (since >= 45_000 && haversineKm(p, trip.pickup) >= LEAVE_KM) {
            saveTransition(fresh, transitionTrip(trip, S.IN_PROGRESS, { by: 'system', at }));
            db.prepare('UPDATE trips SET auto_started = 1 WHERE id = ?').run(fresh.id);
          }
        } else if (fresh.status === S.IN_PROGRESS) {
          const since = Date.parse(at) - Date.parse(lastAt(S.IN_PROGRESS));
          const tracked = trackOverrun(fresh, p, prev);
          if (fresh.kind !== 'delivery' && since >= 120_000 && haversineKm(p, trip.dropoff) <= DROPOFF_KM) {
            completeTrip(tracked, 'system', null); // a delivery is only finished with the receiver's code
          } else if (tracked.overrun_km >= OVERRUN_LIMIT_KM) {
            completeTrip(tracked, 'system', null); // drove on and never finished: end it and charge
          }
        }
      });
    } catch (err) {
      if (!(err instanceof HttpError) && !(err instanceof TripError)) throw err;
    }
  }

  /** Finishes a trip and moves the money. Call inside a transaction. Safe to call twice: each journal posts once. */
  /** What a receipt shows. The passenger sees the fare; the rider also sees commission and earnings. */
  function buildReceipt(row, forRole) {
    const cap = row.captain_id ? getUser(row.captain_id) : null;
    const prof = row.captain_id ? getProfile(row.captain_id) : null;
    const digital = row.payment_method === 'wallet';
    const receipt = {
      number: `SB-${row.id.slice(0, 8).toUpperCase()}`,
      tripId: row.id,
      date: row.completed_at,
      kind: row.kind,
      pickup: row.pickup_label,
      dropoff: row.dropoff_label,
      distanceKm: round1(row.distance_km),
      vehicleType: row.vehicle_type,
      rider: cap ? { name: cap.name, plate: prof?.bike_plate ?? null } : null,
      fare: row.fare,
      nightPercent: row.night_percent,
      paymentMethod: row.payment_method,
      paymentStatus: digital ? 'Paid from Smart Boda wallet' : 'Cash paid to the rider',
      pinVerified: Boolean(row.pin_verified),
    };
    if (forRole !== 'passenger') {
      receipt.commission = row.commission;
      receipt.commissionRate = row.commission_rate;
      if (digital) receipt.riderEarnings = row.captain_earnings; // cash trips: the rider keeps the cash, nothing to show
      if (row.overrun_commission > 0) receipt.overrunCommission = row.overrun_commission;
      receipt.earningsNote = digital
        ? 'Paid through the app: this amount is payable to the rider.'
        : 'Collected in cash by the rider. Only the commission is taken, from the rider\'s credit.';
    }
    return receipt;
  }

  function receiptText(r, forRole, name) {
    const when = new Date(Date.parse(r.date) + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const lines = [
      `Hello ${name},`,
      '',
      forRole === 'passenger' ? 'Thank you for riding with Smart Boda. Here is your receipt.' : 'Here is the receipt for the trip you completed.',
      '',
      `Receipt: ${r.number}`,
      `Date: ${when} (Uganda time)`,
      `From: ${r.pickup ?? 'Pickup point'}`,
      `To: ${r.dropoff ?? 'Drop-off point'}`,
      `Distance: ${r.distanceKm} km`,
      r.rider ? `${forRole === 'passenger' ? 'Rider' : 'Rider (you)'}: ${r.rider.name}${r.rider.plate ? ' · ' + r.rider.plate : ''}` : null,
      `Fare: ${fmtUgx(r.fare)}`,
      `Payment: ${r.paymentStatus}`,
    ];
    if (r.commission !== undefined) {
      lines.push(`Smart Boda commission: ${fmtUgx(r.commission)}`, `Your earnings before costs: ${fmtUgx(r.riderEarnings)}`, r.earningsNote);
    }
    lines.push('', 'Smart Boda');
    return lines.filter((l) => l !== null).join('\n');
  }

  /** Emails the receipt to the passenger and the rider (when they have an email). Once per trip; never blocks the trip. */
  async function emailReceipts(tripId) {
    if (!mailer) return;
    try {
      const claimed = db
        .prepare("UPDATE trips SET receipt_emailed_at = ? WHERE id = ? AND status = 'completed' AND receipt_emailed_at IS NULL")
        .run(now(), tripId).changes;
      if (claimed !== 1) return;
      const row = getTripRow(tripId);
      for (const [id, role] of [[row.passenger_id, 'passenger'], [row.captain_id, 'captain']]) {
        const u = id ? getUser(id) : null;
        if (!u?.email) continue;
        const r = buildReceipt(row, role);
        await mailer.send({ to: u.email, subject: `Your Smart Boda receipt ${r.number}`, text: receiptText(r, role, u.name) });
      }
    } catch (err) {
      console.error(`Receipt email failed: ${err.message}`);
    }
  }

  function completeTrip(row, by, actorId) {
    const at = now();
    row = getTripRow(row.id) ?? row; // the latest figures, including any distance driven past the drop-off
    saveTransition(row, transitionTrip(rowToTrip(row), S.COMPLETED, { by, actorId, at }), at);
    if (row.payment_method === 'wallet') {
      wallet.settleDigitalTrip(db, {
        passengerId: row.passenger_id, riderId: row.captain_id, tripId: row.id,
        fare: row.fare, commission: row.commission, earnings: row.captain_earnings, at,
      });
    } else if (row.payment_method === 'cash') {
      // The passenger pays the rider in cash; only the commission moves, from reserved credit to revenue.
      wallet.chargeCommission(db, { riderId: row.captain_id, tripId: row.id, commission: row.commission, at });
    }
    if (row.overrun_commission > 0) {
      wallet.chargeOverrun(db, {
        riderId: row.captain_id, tripId: row.id, amount: row.overrun_commission, digital: row.payment_method === 'wallet', at,
      });
    }
    setImmediate(() => void emailReceipts(row.id)); // after the trip is saved
  }

  /** A trip that ended without being completed gives its reserved commission back, once. */
  function releaseIfReserved(row) {
    if (row.captain_id && row.payment_method === 'cash') {
      wallet.releaseCommission(db, { riderId: row.captain_id, tripId: row.id, commission: row.commission, at: now() });
    }
  }

  router.add(
    'POST',
    '/api/captain/location',
    ({ user, body }) => {
      requireActiveCaptain(user);
      const p = point(obj(body), 'location');
      const before = getProfile(user.id);
      const prev = before?.lat != null && before.location_at && Date.parse(now()) - Date.parse(before.location_at) < 5 * 60 * 1000
        ? { lat: before.lat, lng: before.lng }
        : null;
      db.prepare('UPDATE captain_profiles SET lat = ?, lng = ?, location_at = ? WHERE user_id = ?').run(
        p.lat, p.lng, now(), user.id,
      );
      const active = activeTripForCaptain(user.id);
      if (active) autoAdvance(active, p, prev);
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
      let creditNeeded = null; // commission credit missing for the nearest cash trip we had to hide
      const free = wallet.creditFree(db, user.id);
      for (const row of requested) {
        const ranked = rankingFor(row, captains);
        const me = ranked.find((c) => c.id === user.id);
        if (!me) {
          const wouldBe = rankingFor(row, captains, { ignoreCredit: true }).some((c) => c.id === user.id);
          if (wouldBe && row.payment_method === 'cash') {
            const missing = row.commission - free;
            if (missing > 0 && (creditNeeded === null || missing < creditNeeded)) creditNeeded = missing;
          }
          continue;
        }
        offers.push({
          trip: tripView(row, 'captain'),
          distanceToPickupKm: round1(me.distanceKm),
          expiresAt: new Date(Date.parse(row.created_at) + cfg.offerSeconds * 1000).toISOString(),
        });
      }
      return { offers, credit: { free, creditNeeded } };
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
        captainGate(user.id);
        if (activeTripForCaptain(user.id)) throw new HttpError(409, 'Finish your current trip first', 'on_trip');
        const row = getTripRow(params.id);
        if (!row) throw new HttpError(404, 'Trip not found');
        if (row.status !== S.REQUESTED) throw new HttpError(409, 'Another captain took this trip', 'taken');
        if (row.payment_method === 'cash') {
          const free = wallet.creditFree(db, user.id);
          if (free < row.commission) {
            throw new HttpError(
              402,
              `You need ${fmtUgx(row.commission - free)} more commission credit to take this cash trip. Top up your credit.`,
              'insufficient_credit',
            );
          }
        }
        const ranked = rankingFor(row, candidateCaptains());
        if (!ranked.some((c) => c.id === user.id)) {
          throw new HttpError(409, 'This trip is no longer offered to you', 'not_offered');
        }
        saveTransition(row, transitionTrip(rowToTrip(row), S.ACCEPTED, { by: 'captain', actorId: user.id, at: now() }));
        // The commission is set aside now, so the same credit cannot back two trips.
        if (row.payment_method === 'cash') {
          wallet.reserveCommission(db, { riderId: user.id, tripId: row.id, commission: row.commission, at: now() });
        }
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
      ({ user, params, body }) => {
        requireActiveCaptain(user);
        const out = transaction(db, () => {
          const row = getTripRow(params.id);
          if (!row || row.captain_id !== user.id) throw new HttpError(404, 'Trip not found');
          // A ride is started with the passenger's 4-digit code (the right person is on board).
          // A delivery is finished with it (the receiver has the item).
          const isDelivery = row.kind === 'delivery';
          const needsPin =
            row.pickup_pin && !row.pin_verified &&
            ((!isDelivery && status === S.IN_PROGRESS && row.status === S.ARRIVED) ||
              (isDelivery && status === S.COMPLETED));
          if (needsPin) {
            if (row.pin_attempts >= 5) throw new HttpError(429, 'Too many wrong codes. Ask support for help.', 'pin_locked');
            const given = String((body && body.pin) ?? '').trim();
            if (given !== row.pickup_pin) {
              // Counted outside the transaction so the failed attempt is kept.
              return { wrongPin: row.id };
            }
            db.prepare('UPDATE trips SET pin_verified = 1 WHERE id = ?').run(row.id);
          }
          if (status === S.COMPLETED) {
            completeTrip(row, 'captain', user.id);
          } else {
            saveTransition(row, transitionTrip(rowToTrip(row), status, { by: 'captain', actorId: user.id, at: now() }));
          }
          return { trip: tripView(getTripRow(row.id), 'captain') };
        });
        if (out.wrongPin) {
          db.prepare('UPDATE trips SET pin_attempts = pin_attempts + 1 WHERE id = ?').run(out.wrongPin);
          throw new HttpError(400, 'That code is not right. Ask for the 4-digit code again.', 'wrong_pin');
        }
        return out;
      },
      { roles: ['captain'] },
    );
  }

  router.add(
    'POST',
    '/api/trips/:id/rate-passenger',
    ({ user, params, body }) => {
      obj(body);
      const rating = int(body.rating, 'rating', { min: 1, max: 5 });
      const row = getTripRow(params.id);
      if (!row || row.captain_id !== user.id) throw new HttpError(404, 'Trip not found');
      if (row.status !== S.COMPLETED) throw bad('You can only rate a finished trip');
      const res = db
        .prepare('UPDATE trips SET passenger_rating = ? WHERE id = ? AND passenger_rating IS NULL')
        .run(rating, row.id);
      if (res.changes !== 1) throw new HttpError(409, 'You already rated this passenger');
      return { ok: true };
    },
    { roles: ['captain'] },
  );

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
             COALESCE(SUM(CASE WHEN payment_method = 'wallet' THEN captain_earnings END),0) AS net
           FROM trips WHERE captain_id = ? AND status = 'completed' AND completed_at >= ?`,
        )
        .get(user.id, since);
      const byDay = db
        .prepare(
          `SELECT date(datetime(completed_at, '+3 hours')) AS day, COUNT(*) AS trips,
             SUM(fare) AS gross, COALESCE(SUM(CASE WHEN payment_method = 'wallet' THEN captain_earnings END),0) AS net
           FROM trips WHERE captain_id = ? AND status = 'completed' AND completed_at >= ?
           GROUP BY day ORDER BY day DESC`,
        )
        .all(user.id, since);
      return {
        days,
        totals: { ...totals },
        byDay: byDay.map((d) => ({ ...d })),
        credit: { free: wallet.creditFree(db, user.id), reserved: wallet.creditReserved(db, user.id) },
        walletBalance: wallet.earningsPayable(db, user.id),
        standing: captainStanding(captainCancelCounts(db, now()).get(user.id), now()),
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
          creditFree: wallet.creditFree(db, r.id),
          creditReserved: wallet.creditReserved(db, r.id),
          walletBalance: wallet.earningsPayable(db, r.id),
          standing: captainStanding(captainCancelCounts(db, now()).get(r.id), now()).level,
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

  // Trips and people worth a human look. Nothing here charges or blocks anyone.
  router.add('GET', '/api/admin/flags', () => ({ flags: reviewFlags(db, now()) }), { roles: ['admin'] });

  // Receipt for a finished trip. The passenger sees the fare; the rider also sees commission and earnings.
  router.add(
    'GET',
    '/api/trips/:id/receipt',
    ({ user, params }) => {
      const row = getTripRow(params.id);
      const allowed =
        row && (user.role === 'admin' || row.passenger_id === user.id || row.captain_id === user.id);
      if (!allowed) throw new HttpError(404, 'Trip not found');
      if (row.status !== 'completed') throw new HttpError(409, 'A receipt is ready once the trip is complete', 'not_complete');
      const receipt = buildReceipt(row, user.role === 'passenger' ? 'passenger' : 'captain');
      return { receipt };
    },
    { roles: ['passenger', 'captain', 'admin'] },
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
        position: ledger.companyPosition(db),
      };
    },
    { roles: ['admin'] },
  );

  router.add(
    'GET',
    '/api/admin/settings',
    () => ({
      fare: getFareConfig(db),
      dispatch: getDispatchConfig(db),
      vehicles: getVehicleConfig(db),
      night: getNightConfig(db),
      limits: getLimits(db),
      app: getAppInfo(db),
    }),
    { roles: ['admin'] },
  );

  router.add(
    'GET',
    '/api/admin/users',
    ({ query }) => {
      const q = `%${String(query.q ?? '').trim().toLowerCase()}%`;
      const rows = db
        .prepare(
          `SELECT id, role, name, phone, email, status FROM users
           WHERE role <> 'admin' AND (lower(name) LIKE ? OR phone LIKE ? OR lower(COALESCE(email,'')) LIKE ?)
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all(q, q, q);
      return {
        users: rows.map((r) =>
          r.role === 'captain'
            ? { ...r, creditFree: wallet.creditFree(db, r.id), creditReserved: wallet.creditReserved(db, r.id), walletBalance: wallet.earningsPayable(db, r.id) }
            : { ...r, walletBalance: wallet.balance(db, r.id) },
        ),
      };
    },
    { roles: ['admin'] },
  );

  // Positive amount adds money to someone's wallet (for example after they paid cash at the office
  // or by mobile money); negative takes it back.
  router.add(
    'POST',
    '/api/admin/users/:id/wallet',
    ({ user, params, body }) => {
      obj(body);
      const u = getUser(params.id);
      if (!u || u.role === 'admin') throw new HttpError(404, 'User not found');
      const amount = int(body.amount, 'amount', { min: -100_000_000, max: 100_000_000 });
      if (amount === 0) throw bad('Amount cannot be 0');
      const note = text(body.note, 'Reason', { min: 3, max: 200 });
      const rider = u.role === 'captain';
      return transaction(db, () => {
        const current = rider ? wallet.creditFree(db, u.id) : wallet.balance(db, u.id);
        if (amount < 0 && current + amount < 0) throw bad('That is more than is available');
        wallet.postManual(db, { userId: u.id, role: u.role, amount, actorId: user.id, note, at: now(), ref: `manual:${randomUUID()}` });
        return { balance: rider ? wallet.creditFree(db, u.id) : wallet.balance(db, u.id) };
      });
    },
    { roles: ['admin'] },
  );

  // Pay a captain the wallet earnings they have built up (the admin sends the money, then records it here).
  router.add(
    'POST',
    '/api/admin/captains/:id/payout',
    ({ user, params, body }) => {
      obj(body);
      const u = getUser(params.id);
      if (!u || u.role !== 'captain') throw new HttpError(404, 'Captain not found');
      const amount = int(body.amount, 'amount', { min: 1, max: 100_000_000 });
      const note = text(body.note, 'Reason', { min: 3, max: 200 });
      return transaction(db, () => {
        if (amount > wallet.earningsPayable(db, u.id)) throw bad('That is more than the captain is owed');
        ledger.post(db, {
          ref: `payout:${randomUUID()}`, kind: 'manual_payout', memo: note, actorId: user.id, at: now(),
          entries: [{ account: wallet.acct.payable(u.id), amount }, { account: 'company_bank', amount: -amount }],
        });
        return { balance: wallet.earningsPayable(db, u.id) };
      });
    },
    { roles: ['admin'] },
  );

  router.add(
    'POST',
    '/api/admin/users/:id/password',
    ({ params, body }) => {
      obj(body);
      const u = getUser(params.id);
      if (!u) throw new HttpError(404, 'User not found');
      const password = text(body.password, 'Password', { min: 6, max: 128 });
      transaction(db, () => {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      });
      return { ok: true };
    },
    { roles: ['admin'] },
  );
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
      if (out && typeof out === 'object' && out.binary) {
        res.writeHead(200, {
          'Content-Type': out.contentType,
          'Content-Length': out.binary.length,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(out.binary);
      }
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
