const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const geoPoint = z.object({
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

// A real point, not "unset" — for a manual pin correction or a verifier's
// confirmed coordinates, where null/absent doesn't make sense.
const requiredGeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Optional companions to a top-level `location`/`confirmedLocation` field —
// when the client already resolved a place name/address itself (e.g. an
// address-search result), it's passed alongside the coordinates so the
// server doesn't need a redundant reverse-geocode call. See
// services/locationDetailsService.js's resolveLocationDetails, which every
// controller that persists coordinates routes through. Spread this object
// into a z.object({...}) shape rather than nesting, to match how these
// fields travel in request bodies today (siblings of `location`, not
// members of it).
const locationDetailsExtras = {
  placeName: z.string().optional(),
  formattedAddress: z.string().optional(),
  locationSource: z.enum(['manual_pin', 'gps', 'geocoded_search', 'auto_detected', 'verifier_confirmed']).optional(),
};

module.exports = { objectId, geoPoint, requiredGeoPoint, pagination, locationDetailsExtras };
