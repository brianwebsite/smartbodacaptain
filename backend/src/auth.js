// Passwords and sign-in tokens. Uses only Node's built-in crypto.

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const KEY_LENGTH = 64;
const SESSION_DAYS = 365; // people stay signed in until they sign out

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A new random token for the app, and the hash we store instead of it. */
export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function sessionExpiry(nowIso) {
  return new Date(Date.parse(nowIso) + SESSION_DAYS * 86400 * 1000).toISOString();
}

/** Counts attempts per key inside a sliding window. In memory, per process. */
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Returns true if this attempt is allowed. */
  allow(key, nowMs) {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}
