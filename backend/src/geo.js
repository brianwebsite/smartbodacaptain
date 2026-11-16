// Distance between two map points, in kilometres (straight line over the earth).

const EARTH_RADIUS_KM = 6371.0088;

function assertPoint(p, name) {
  const ok =
    p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180;
  if (!ok) throw new RangeError(`${name} must be {lat, lng} with valid coordinates`);
}

const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(a, b) {
  assertPoint(a, 'a');
  assertPoint(b, 'b');
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
