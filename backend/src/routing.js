// Route distance and time between two points.
//
// "google": real driving distance and time from the Google Routes API.
// "estimate": straight-line distance times a detour factor, at an average
//   city speed. Used when no Google key is configured. Results are labelled
//   with their source so nothing pretends to be more exact than it is.

import { haversineKm } from './geo.js';

/** Decodes an encoded polyline (precision 5, used by both Google and OSRM) into [lat, lng] pairs. */
export function decodePolyline(str) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/** Keeps at most `max` points, always including the first and last, so a route stays small to send. */
export function thinPath(points, max = 250) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(points[Math.round(k * step)]);
  return out;
}

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
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
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
      const path = r.polyline?.encodedPolyline ? thinPath(decodePolyline(r.polyline.encodedPolyline)) : null;
      return { distanceKm: r.distanceMeters / 1000, durationMin: seconds / 60, source: 'google', path };
    },
  };
}

/** Real road routes from OSRM (free, no key). The public server is for light use; set OSRM_URL to your own for more. */
export function osrmRouting({ baseUrl = 'https://router.project-osrm.org', fetchFn = fetch, timeoutMs = 5000 } = {}) {
  return {
    name: 'osrm',
    async route(from, to) {
      const url = `${baseUrl.replace(/\/+$/, '')}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline`;
      const res = await fetchFn(url, { headers: { 'User-Agent': 'SmartBoda/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`OSRM failed with status ${res.status}`);
      const data = await res.json();
      const r = data.routes?.[0];
      if (data.code !== 'Ok' || !r || typeof r.distance !== 'number' || typeof r.duration !== 'number') {
        throw new Error('OSRM returned no route');
      }
      const path = typeof r.geometry === 'string' ? thinPath(decodePolyline(r.geometry)) : null;
      return { distanceKm: r.distance / 1000, durationMin: r.duration / 60, source: 'osrm', path };
    },
  };
}

/** Google when a key is given, then OSRM road routes, then the labelled estimate. */
export function chooseRouting({ apiKey, fetchFn, osrmUrl, osrm = true } = {}) {
  const fallback = estimateRouting();
  const providers = [];
  if (apiKey) providers.push(googleRouting({ apiKey, fetchFn }));
  if (osrm) providers.push(osrmRouting({ baseUrl: osrmUrl || undefined, fetchFn }));
  if (!providers.length) return fallback;
  return {
    name: providers.map((p) => p.name).join('+') + '-with-estimate-fallback',
    async route(from, to) {
      for (const p of providers) {
        try {
          return await p.route(from, to);
        } catch (err) {
          console.error(`routing: ${p.name} failed:`, err.message);
        }
      }
      return fallback.route(from, to);
    },
  };
}
