const { haversineDistanceMeters } = require('../utils/geo');
const { LandListing } = require('../models');

const PROXIMITY_RADIUS_M = 150; // two listings this close claiming similar size are very likely the same plot
const SIZE_TOLERANCE = 0.1; // ±10%

/**
 * Flags a listing as a likely duplicate of another already-verified/pending
 * listing when both claim a location within ~150m of each other and a
 * similar plot size — the same fraudulent-relisting pattern the funding
 * pillar's evidence file-hash check guards against, adapted to land (no
 * single file to hash; the signal here is geo-proximity + size instead).
 */
async function findDuplicate(listing) {
  if (listing.location?.lat == null || listing.location?.lng == null) return null;

  const candidates = await LandListing.find({
    _id: { $ne: listing._id },
    'location.lat': { $ne: null },
    verificationStatus: { $ne: 'flagged' },
  })
    .select('_id sizeSqm location')
    .lean();

  for (const other of candidates) {
    const distance = haversineDistanceMeters(listing.location, other.location);
    if (distance > PROXIMITY_RADIUS_M) continue;
    const sizeDiff = Math.abs(listing.sizeSqm - other.sizeSqm) / Math.max(listing.sizeSqm, other.sizeSqm, 1);
    if (sizeDiff <= SIZE_TOLERANCE) return other._id;
  }
  return null;
}

module.exports = { findDuplicate };
