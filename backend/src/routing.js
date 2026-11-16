// Route distance and time between two points.
//
// "google": real driving distance and time from the Google Routes API.
// "estimate": straight-line distance times a detour factor, at an average
//   city speed. Used when no Google key is configured. Results are labelled
//   with their source so nothing pretends to be more exact than it is.

import { haversineKm } from './geo.js';

export function estimateRouting({ detourFactor = 1.35, speedKmh = 22 } = {}) {
  return {
    name: 'estimate',
    async route(from, to) {
      const distanceKm = haversineKm(from, to) * detourFactor;
      return { distanceKm, durationMin: (distanceKm / speedKmh) * 60, source: 'estimate' };
    },
  };
}

export function googleRouting({ apiKey, fetchFn = fetch }) {
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is required for Google routing');
  return {
    name: 'google',
    async route(from, to) {
      const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
          destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
        }),
      });
      if (!res.ok) throw new Error(`Google Routes failed with status ${res.status}`);
      const data = await res.json();
      const r = data.routes?.[0];
      if (!r || typeof r.distanceMeters !== 'number' || typeof r.duration !== 'string') {
        throw new Error('Google Routes returned no route');
      }
      const seconds = Number.parseFloat(r.duration); // "845s"
      if (!Number.isFinite(seconds)) throw new Error('Google Routes returned a bad duration');
      return { distanceKm: r.distanceMeters / 1000, durationMin: seconds / 60, source: 'google' };
    },
  };
}

/** Google when a key is given and works; otherwise the labelled estimate. */
export function chooseRouting({ apiKey, fetchFn } = {}) {
  const fallback = estimateRouting();
  if (!apiKey) return fallback;
  const google = googleRouting({ apiKey, fetchFn });
  return {
    name: 'google-with-estimate-fallback',
    async route(from, to) {
      try {
        return await google.route(from, to);
      } catch (err) {
        console.error('routing: falling back to estimate:', err.message);
        return fallback.route(from, to);
      }
    },
  };
}
