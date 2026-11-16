// Trip lifecycle. A trip moves through fixed states and only the right
// person (passenger, captain or the system) may make each move.
// Functions never change the trip they are given; they return a new one.

import { haversineKm } from './geo.js';

export const TRIP_STATUS = Object.freeze({
  REQUESTED: 'requested',
  ACCEPTED: 'accepted',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_CAPTAIN: 'no_captain',
});

const S = TRIP_STATUS;

// next status -> { from: allowed current statuses, by: who may do it }
const RULES = Object.freeze({
  [S.ACCEPTED]: { from: [S.REQUESTED], by: ['captain'] },
  [S.ARRIVED]: { from: [S.ACCEPTED], by: ['captain', 'system'] },
  [S.IN_PROGRESS]: { from: [S.ARRIVED], by: ['captain', 'system'] },
  [S.COMPLETED]: { from: [S.IN_PROGRESS], by: ['captain', 'system'] },
  [S.CANCELLED]: { from: [S.REQUESTED, S.ACCEPTED, S.ARRIVED], by: ['passenger', 'captain'] },
  [S.NO_CAPTAIN]: { from: [S.REQUESTED], by: ['system'] },
});

export const FINAL_STATUSES = Object.freeze([S.COMPLETED, S.CANCELLED, S.NO_CAPTAIN]);

export class TripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TripError';
  }
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TripError(`${name} is required`);
  }
}

function requirePlace(p, name) {
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') {
    throw new TripError(`${name} must be {lat, lng}`);
  }
  haversineKm(p, p); // validates the ranges
}

function requireTime(at) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TripError('at must be an ISO date-time string');
  }
}

export function createTrip({ id, passengerId, pickup, dropoff, fare, paymentMethod, at }) {
  requireText(id, 'id');
  requireText(passengerId, 'passengerId');
  requirePlace(pickup, 'pickup');
  requirePlace(dropoff, 'dropoff');
  requireTime(at);
  if (!Number.isInteger(fare) || fare <= 0) throw new TripError('fare must be whole UGX above 0');
  if (!['cash', 'wallet', 'mobile_money'].includes(paymentMethod)) {
    throw new TripError('paymentMethod must be cash, wallet or mobile_money');
  }
  return {
    id,
    passengerId,
    captainId: null,
    pickup,
    dropoff,
    fare,
    paymentMethod,
    status: S.REQUESTED,
    history: [{ status: S.REQUESTED, by: 'passenger', actorId: passengerId, at }],
  };
}

/**
 * Move a trip to its next status.
 * @param {object} trip
 * @param {string} next      a TRIP_STATUS value
 * @param {{by:'passenger'|'captain'|'system', actorId?:string, at:string}} who
 */
export function transitionTrip(trip, next, { by, actorId, at }) {
  const rule = RULES[next];
  if (!rule) throw new TripError(`unknown status: ${next}`);
  requireTime(at);
  if (!rule.from.includes(trip.status)) {
    throw new TripError(`cannot go from ${trip.status} to ${next}`);
  }
  if (!rule.by.includes(by)) throw new TripError(`${by} cannot set status ${next}`);

  let captainId = trip.captainId;
  if (next === S.ACCEPTED) {
    requireText(actorId, 'actorId');
    captainId = actorId;
  } else if (by === 'captain') {
    if (actorId !== trip.captainId) throw new TripError('only the trip captain can do this');
  } else if (by === 'passenger') {
    if (actorId !== trip.passengerId) throw new TripError('only the trip passenger can do this');
  }

  return {
    ...trip,
    captainId,
    status: next,
    history: [...trip.history, { status: next, by, actorId: actorId ?? null, at }],
  };
}

export const isFinal = (trip) => FINAL_STATUSES.includes(trip.status);
