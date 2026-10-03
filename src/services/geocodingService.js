const axios = require('axios');
const env = require('../config/env');

// OpenStreetMap's free Nominatim API — no API key required, unlike Google
// Maps/Mapbox (this project has credentials for neither; see
// Mboa_Trust_Technical_Architecture.md's original "Maps / geocoding" row,
// never actually provisioned). Their usage policy requires a real,
// identifying User-Agent and caps free usage around 1 request/second, both
// fine for milestone-evidence submission volume. Called from the backend
// only — never directly from the browser — so that header, the timeout, and
// the graceful-failure behavior all live in one place.
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const NOMINATIM_USER_AGENT = 'MboaTrust/1.0 (geocoding; contact via app)';

// Nominatim's usage policy caps free use at ~1 request/second — fine for a
// single milestone-evidence submission, but the migration script
// (backfillCoordinates.js) calls forwardGeocode in a loop across every
// record missing coordinates, which would otherwise burst well past that.
// This tracks the last call across ANY caller (request or migration) in
// this process and inserts a delay when needed, rather than trusting every
// call site to remember to throttle itself.
let lastNominatimCallAt = 0;
async function throttleNominatim() {
  const minGapMs = 1100;
  const wait = lastNominatimCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimCallAt = Date.now();
}

/** Nominatim's `display_name` is a long, full postal-style address — this
 * picks 2-3 of the most locally-meaningful address parts instead (suburb/
 * neighbourhood, city, region/country) for a short label that reads
 * naturally next to a photo, matching how the rest of the app already
 * shows locations (e.g. "Douala, Littoral Region"). */
function buildPlaceName(data) {
  const addr = data?.address;
  if (!addr) return data?.display_name || null;
  const locality = addr.suburb || addr.neighbourhood || addr.village || addr.town || addr.city_district;
  const city = addr.city || addr.town || addr.municipality;
  const region = addr.state || addr.region;
  const country = addr.country;
  const parts = [...new Set([locality, city, region, country].filter(Boolean))];
  return parts.length > 0 ? parts.slice(0, 3).join(', ') : data?.display_name || null;
}

/** Resolves a lat/lng pair to a short place name AND the geocoder's own full
 * formatted address, or null if the coordinates are missing, the request
 * fails, or it times out — callers already treat "no place name" as a
 * normal, displayable state (falls back to raw coordinates), so this never
 * throws. `formattedAddress` is Nominatim's own `display_name` — no extra
 * request needed, it's already in the same response `buildPlaceName` reads. */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    await throttleNominatim();
    const { data } = await axios.get(`${NOMINATIM_BASE_URL}/reverse`, {
      params: { format: 'jsonv2', lat, lon: lng, zoom: 16, addressdetails: 1 },
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      timeout: 8000,
    });
    const placeName = buildPlaceName(data);
    if (!placeName && !data?.display_name) return null;
    return { placeName: placeName || data.display_name, formattedAddress: data?.display_name || placeName };
  } catch (err) {
    console.warn('[geocodingService] reverse geocode failed — leaving placeName unset:', err.message);
    return null;
  }
}

/** Forward-geocodes via Nominatim's `/search` — the free fallback path, and
 * (today, with no Google key configured) the only path. Returns null rather
 * than throwing on "no match"/network failure, same convention as
 * reverseGeocode — every caller already treats "couldn't resolve this" as a
 * normal, non-fatal outcome (leave location unset, let the user pin it
 * manually) rather than a hard error. */
async function forwardGeocodeNominatim(query) {
  try {
    await throttleNominatim();
    const { data } = await axios.get(`${NOMINATIM_BASE_URL}/search`, {
      params: { format: 'jsonv2', q: query, limit: 1, addressdetails: 1 },
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      timeout: 8000,
    });
    const best = Array.isArray(data) ? data[0] : null;
    if (!best) return null;
    const lat = Number(best.lat);
    const lng = Number(best.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, placeName: buildPlaceName(best) || best.display_name || query, formattedAddress: best.display_name || query };
  } catch (err) {
    console.warn('[geocodingService] Nominatim forward geocode failed:', err.message);
    return null;
  }
}

/** Forward-geocodes via Google's Geocoding API — tried first when
 * GOOGLE_MAPS_API_KEY is configured, since it's generally more accurate for
 * named landmarks/businesses than Nominatim. Not restricted to Cameroon
 * (diaspora funders may enter a foreign address), but `region=cm` nudges
 * ambiguous matches toward Cameroon rather than forcing them. Returns null
 * (never throws) on any failure so the caller can fall through to
 * Nominatim — this is exactly what forwardGeocode() below does. */
async function forwardGeocodeGoogle(query) {
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: query, region: 'cm', key: env.googleMaps.apiKey },
      timeout: 8000,
    });
    if (data.status !== 'OK' || !data.results?.length) return null;
    const best = data.results[0];
    const { lat, lng } = best.geometry.location;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Google's Geocoding API has no separate "short name" field the way
    // Nominatim's address components do — the locality/admin-area pair
    // (skipping the country, already implied) is the closest short label.
    const comp = (type) => best.address_components?.find((c) => c.types.includes(type))?.long_name;
    const shortParts = [comp('locality') || comp('sublocality'), comp('administrative_area_level_1')].filter(Boolean);
    return { lat, lng, placeName: shortParts.join(', ') || best.formatted_address || query, formattedAddress: best.formatted_address || query };
  } catch (err) {
    console.warn('[geocodingService] Google forward geocode failed, falling back to Nominatim:', err.message);
    return null;
  }
}

/** Turns a free-text address/place name into coordinates. Tries Google
 * first when a key is configured (more accurate for named places), and
 * always falls back to free Nominatim — whether because no key is set, or
 * the Google call failed/found nothing. This means the feature works with
 * zero setup today and upgrades transparently the moment a key is added,
 * with no call-site changes needed either way. Returns null (never throws)
 * if neither service can resolve the query — callers leave location unset
 * and let the user pin it manually, same convention as reverseGeocode. */
async function forwardGeocode(query) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return null;
  if (env.googleMaps.apiKey) {
    const viaGoogle = await forwardGeocodeGoogle(trimmed);
    if (viaGoogle) return viaGoogle;
  }
  return forwardGeocodeNominatim(trimmed);
}

module.exports = { reverseGeocode, forwardGeocode };
