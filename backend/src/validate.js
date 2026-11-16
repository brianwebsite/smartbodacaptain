// Input checks. Every failure becomes a 400 with a message the app can show.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? null;
  }
}

export const bad = (message, code) => new HttpError(400, message, code);

export function obj(value, name = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`${name} must be an object`);
  }
  return value;
}

export function text(value, name, { min = 1, max = 200, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw bad(`${name} is required`);
  }
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const v = value.trim();
  if (v.length < min) throw bad(`${name} is too short`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v;
}

export function oneOf(value, name, allowed) {
  if (!allowed.includes(value)) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function bool(value, name) {
  if (typeof value !== 'boolean') throw bad(`${name} must be true or false`);
  return value;
}

export function num(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${name} must be a number`);
  if (value < min || value > max) throw bad(`${name} must be between ${min} and ${max}`);
  return value;
}

export function int(value, name, opts) {
  const v = num(value, name, opts);
  if (!Number.isInteger(v)) throw bad(`${name} must be a whole number`);
  return v;
}

export function point(value, name) {
  obj(value, name);
  return {
    lat: num(value.lat, `${name}.lat`, { min: -90, max: 90 }),
    lng: num(value.lng, `${name}.lng`, { min: -180, max: 180 }),
  };
}
