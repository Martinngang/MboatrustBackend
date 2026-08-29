const axios = require('axios');

// OpenStreetMap's free Nominatim API — no API key required, unlike Google
// Maps/Mapbox (this project has credentials for neither; see
// Mboa_Trust_Technical_Architecture.md's original "Maps / geocoding" row,
// never actually provisioned). Their usage policy requires a real,
// identifying User-Agent and caps free usage around 1 request/second, both
// fine for milestone-evidence submission volume. Called from the backend
// only — never directly from the browser — so that header, the timeout, and
// the graceful-failure behavior all live in one place.
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';

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

/** Resolves a lat/lng pair to a short place name, or null if the coordinates
 * are missing, the request fails, or it times out — callers already treat
 * "no place name" as a normal, displayable state (falls back to raw
 * coordinates), so this never throws. */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const { data } = await axios.get(`${NOMINATIM_BASE_URL}/reverse`, {
      params: { format: 'jsonv2', lat, lon: lng, zoom: 16, addressdetails: 1 },
      headers: { 'User-Agent': 'MboaTrust/1.0 (milestone evidence geotag; contact via app)' },
      timeout: 8000,
    });
    return buildPlaceName(data);
  } catch (err) {
    console.warn('[geocodingService] reverse geocode failed — leaving placeName unset:', err.message);
    return null;
  }
}

module.exports = { reverseGeocode };
