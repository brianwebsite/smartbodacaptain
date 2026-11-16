// Vehicle types, how their prices relate, how long a captain takes to arrive,
// and the reasons people can give when cancelling.

export const VEHICLE_TYPES = Object.freeze(['boda', 'electric_boda', 'car']);

export const VEHICLE_LABELS = Object.freeze({
  boda: 'Boda',
  electric_boda: 'Electric boda',
  car: 'Car',
});

/** Price level of each type compared with the base fare formula. The admin can change these. */
export const DEFAULT_VEHICLES = Object.freeze({
  boda: { multiplier: 1 },
  electric_boda: { multiplier: 1 },
  car: { multiplier: 2 },
});

export const CANCEL_REASONS = Object.freeze({
  passenger: [
    { id: 'changed_mind', label: 'I changed my mind' },
    { id: 'wait_too_long', label: 'Waiting too long' },
    { id: 'captain_far', label: 'The captain is too far away' },
    { id: 'wrong_pickup', label: 'Wrong pickup or drop-off' },
    { id: 'found_other_ride', label: 'I found another ride' },
    { id: 'price_too_high', label: 'The price is too high' },
    { id: 'other', label: 'Other reason' },
  ],
  captain: [
    { id: 'passenger_no_show', label: 'Passenger did not show up' },
    { id: 'passenger_asked', label: 'Passenger asked me to cancel' },
    { id: 'too_far', label: 'Pickup is too far' },
    { id: 'vehicle_problem', label: 'Problem with my vehicle' },
    { id: 'safety', label: 'I do not feel safe' },
    { id: 'other', label: 'Other reason' },
  ],
});

/** A fare config with the money amounts scaled for a vehicle type. */
export function scaleFareConfig(cfg, multiplier) {
  const scale = (n) => Math.round(n * multiplier);
  return {
    ...cfg,
    baseFare: scale(cfg.baseFare),
    perKm: scale(cfg.perKm),
    perMinute: scale(cfg.perMinute),
    minimumFare: scale(cfg.minimumFare),
  };
}

// Straight-line distance x 1.35 for roads, at 22 km/h in Kampala traffic.
// This is an estimate, and the apps say "about" when they show it.
const ROAD_FACTOR = 1.35;
const SPEED_KMH = 22;

export function etaMinutes(straightKm) {
  return Math.max(1, Math.round(((straightKm * ROAD_FACTOR) / SPEED_KMH) * 60));
}
