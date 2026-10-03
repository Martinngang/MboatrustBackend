const geocodingService = require('./geocodingService');

/**
 * The one place that enforces "never store coordinates without attempting to
 * resolve and persist the corresponding place name/address" — every
 * controller path that writes a new {lat,lng} onto a document should route
 * it through here first.
 *
 * If the caller already has a resolved name (e.g. the client's own
 * forward-geocode search result, or a Google/Nominatim response it's already
 * holding), pass it through via `placeName`/`formattedAddress` and no extra
 * network call is made. Otherwise this reverse-geocodes the coordinates
 * itself. Never throws — a failed/timed-out resolution just yields empty
 * strings, exactly like the underlying geocodingService functions already do
 * for "couldn't resolve this."
 */
async function resolveLocationDetails({ lat, lng, placeName, formattedAddress, source = 'manual_pin' }) {
  if (placeName || formattedAddress) {
    return { placeName: placeName || '', formattedAddress: formattedAddress || placeName || '', source, resolvedAt: new Date() };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { placeName: '', formattedAddress: '', source, resolvedAt: null };
  }
  const resolved = await geocodingService.reverseGeocode(lat, lng);
  return {
    placeName: resolved?.placeName || '',
    formattedAddress: resolved?.formattedAddress || '',
    source,
    resolvedAt: resolved ? new Date() : null,
  };
}

module.exports = { resolveLocationDetails };
