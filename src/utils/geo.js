const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two {lat,lng} points, in meters. Shared by
 * evidenceAnalysisService (geotag-vs-project-site check), landDuplicateService
 * (duplicate-listing proximity check), and contractorMatchingService
 * (contractor-vs-tender proximity scoring) — kept dependency-free so none of
 * those services has to import another service just for this math. */
function haversineDistanceMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

module.exports = { haversineDistanceMeters };
