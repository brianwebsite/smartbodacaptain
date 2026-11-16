// Place search for destinations ("where to?") and "what is here?" lookups.
// The apps never talk to the search service directly: they ask our server,
// which caches answers, limits use, and lets us change provider later.
//
// Provider: Photon (OpenStreetMap data), free to try. Its public server has
// fair-use limits, so for real launch use a paid or self-hosted instance
// (set PHOTON_URL) or add another provider here.

// minLon, minLat, maxLon, maxLat: a box around Uganda
const UGANDA_BBOX = '29.5,-1.5,35.1,4.3';
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** Turn one Photon result into {label, title, subtitle, lat, lng}. */
export function toPlace(feature) {
  const p = feature?.properties ?? {};
  const c = feature?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lng, lat] = c;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (p.countrycode && p.countrycode !== 'UG') return null;

  const street = [clean(p.housenumber), clean(p.street)].filter(Boolean).join(' ');
  const title = clean(p.name) || street || clean(p.district) || clean(p.city) || clean(p.county);
  if (!title) return null;

  const parts = [street, clean(p.locality), clean(p.district), clean(p.city) || clean(p.county)].filter(
    (x, i, all) => x && x !== title && all.indexOf(x) === i,
  );
  const subtitle = parts.join(', ');
  return {
    label: subtitle ? `${title}, ${subtitle}` : title,
    title,
    subtitle,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
  };
}

export function photonPlaces({
  fetchImpl = fetch,
  baseUrl = 'https://photon.komoot.io',
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  async function getJson(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let value;
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SmartBoda/0.1 (+https://github.com/brianwebsite/smartbodacaptain)',
        },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`place search answered ${res.status}`);
      value = await res.json();
    } catch (err) {
      if (hit) return hit.value; // an old answer is better than none while the service is slow
      throw err;
    }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(url, { at: now(), value });
    return value;
  }

  return {
    name: 'photon',

    /** @returns {Promise<Array<{label,title,subtitle,lat,lng}>>} */
    async search(query, near) {
      const q = clean(query);
      if (q.length < 2) return [];
      const params = new URLSearchParams({ q: q.slice(0, 80).toLowerCase(), limit: '8', lang: 'en', bbox: UGANDA_BBOX });
      if (near) {
        params.set('lat', near.lat.toFixed(2));
        params.set('lon', near.lng.toFixed(2));
      }
      const json = await getJson(`${baseUrl}/api/?${params}`);
      return (json.features ?? []).map(toPlace).filter(Boolean);
    },

    /** The place at a point, or null when the map has nothing there. */
    async reverse(lat, lng) {
      const params = new URLSearchParams({ lat: lat.toFixed(4), lon: lng.toFixed(4), lang: 'en' });
      const json = await getJson(`${baseUrl}/reverse?${params}`);
      return (json.features ?? []).map(toPlace).find(Boolean) ?? null;
    },
  };
}
