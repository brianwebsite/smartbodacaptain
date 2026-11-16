// Choosing which captains get a trip offer.

import { haversineKm } from './geo.js';

/**
 * Rank the captains who can take a trip, nearest first.
 *
 * A captain is eligible only if approved, online, not already on a trip, and
 * their last location report is recent. Captains are not offered a trip
 * further than maxKm away (straight line) from the pickup.
 *
 * @param {object} args
 * @param {{lat:number,lng:number}} args.pickup
 * @param {Array<{id:string, approved:boolean, online:boolean, onTrip:boolean,
 *   location:{lat:number,lng:number}, locationAt:string}>} args.captains
 * @param {string} args.now                 ISO time
 * @param {number} [args.maxKm=3]
 * @param {number} [args.staleAfterSeconds=60]
 * @param {number} [args.limit=5]
 * @param {string[]} [args.exclude=[]]      captain ids that already declined
 * @returns {Array<{id:string, distanceKm:number}>}
 */
export function rankCaptains({
  pickup,
  captains,
  now,
  maxKm = 3,
  staleAfterSeconds = 60,
  limit = 5,
  exclude = [],
}) {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new RangeError('now must be an ISO date-time string');
  const skip = new Set(exclude);

  return captains
    .filter((c) => c.approved && c.online && !c.onTrip && !skip.has(c.id))
    .filter((c) => {
      const seen = Date.parse(c.locationAt);
      return !Number.isNaN(seen) && nowMs - seen <= staleAfterSeconds * 1000 && nowMs >= seen;
    })
    .map((c) => ({ id: c.id, distanceKm: haversineKm(pickup, c.location) }))
    .filter((c) => c.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}
