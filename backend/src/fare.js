// Fare calculation for Smart Boda.
// All money is whole Uganda shillings (UGX), never decimals.
// The default numbers are placeholders to tune during the pilot.

export const DEFAULT_FARE_CONFIG = Object.freeze({
  baseFare: 1000, // charged on every trip
  perKm: 700, // per kilometre
  perMinute: 50, // per minute of trip time
  minimumFare: 2000, // no trip costs less than this
  commissionRate: 0.15, // share of the fare kept by Smart Boda (0 to 1)
  roundTo: 100, // round the fare to the nearest 100 UGX
});

function assertNonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number`);
  }
}

function checkConfig(config) {
  assertNonNegativeNumber(config.baseFare, 'baseFare');
  assertNonNegativeNumber(config.perKm, 'perKm');
  assertNonNegativeNumber(config.perMinute, 'perMinute');
  assertNonNegativeNumber(config.minimumFare, 'minimumFare');
  assertNonNegativeNumber(config.commissionRate, 'commissionRate');
  if (config.commissionRate > 1) {
    throw new RangeError('commissionRate must be between 0 and 1');
  }
  if (!Number.isInteger(config.roundTo) || config.roundTo < 1) {
    throw new RangeError('roundTo must be a whole number of at least 1');
  }
}

function roundToStep(amount, step) {
  return Math.round(amount / step) * step;
}

/**
 * Work out the fare for a trip.
 *
 * @param {object} trip
 * @param {number} trip.distanceKm  route distance in kilometres
 * @param {number} trip.durationMin expected trip time in minutes
 * @param {object} [config]         overrides for DEFAULT_FARE_CONFIG
 * @returns {{fare:number, commission:number, captainEarnings:number}}
 */
export function calculateFare(trip, config = {}) {
  const cfg = { ...DEFAULT_FARE_CONFIG, ...config };
  checkConfig(cfg);
  assertNonNegativeNumber(trip?.distanceKm, 'distanceKm');
  assertNonNegativeNumber(trip?.durationMin, 'durationMin');

  const raw = cfg.baseFare + trip.distanceKm * cfg.perKm + trip.durationMin * cfg.perMinute;
  const fare = Math.max(roundToStep(raw, cfg.roundTo), roundToStep(cfg.minimumFare, cfg.roundTo));

  // Commission is a whole number of shillings; the captain gets the rest,
  // so the two always add up to the fare exactly.
  const commission = Math.round(fare * cfg.commissionRate);
  const captainEarnings = fare - commission;

  return { fare, commission, captainEarnings };
}
