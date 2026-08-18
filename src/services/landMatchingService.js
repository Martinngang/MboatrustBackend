const mongoose = require('mongoose');
const { LandListing, LandOffer, Rating } = require('../models');

const VERIFICATION_SCORE = { verified: 30, pending: 18, unverified: 8 };
const PRICE_FIT_FULL_BAND = [0.7, 1.3]; // within ±30% of the funder's own average rate: full marks
const PRICE_FIT_ZERO_BAND = [0.3, 2.5]; // outside this: no marks, linear falloff between
const RATING_FULL_CREDIT = 20;
const RATING_NEUTRAL_CREDIT = 10; // a seller with zero ratings yet isn't the same as a badly-rated one

/** A funder's own past LandOffers are real behavioral signal — what
 * price/sqm they've actually been willing to offer, and which regions
 * they've shown interest in — rather than a preference model that has to
 * be filled in or guessed. Returns null (not a fabricated default) when a
 * funder has no offer history at all yet. */
async function getFunderPreferences(funderId) {
  const offers = await LandOffer.find({ buyerId: funderId })
    .populate('listingId', 'sizeSqm region')
    .lean();
  const withListing = offers.filter((o) => o.listingId && o.listingId.sizeSqm > 0);
  if (withListing.length === 0) return null;

  const rates = withListing.map((o) => o.offerAmount / o.listingId.sizeSqm);
  const avgPricePerSqm = rates.reduce((a, b) => a + b, 0) / rates.length;
  const preferredRegions = new Set(withListing.map((o) => (o.listingId.region || '').toLowerCase()).filter(Boolean));

  return { avgPricePerSqm, preferredRegions };
}

function priceFitScore(candidateRate, avgPricePerSqm) {
  if (!avgPricePerSqm || avgPricePerSqm <= 0) return 0;
  const ratio = candidateRate / avgPricePerSqm;
  const [fullLo, fullHi] = PRICE_FIT_FULL_BAND;
  const [zeroLo, zeroHi] = PRICE_FIT_ZERO_BAND;
  if (ratio >= fullLo && ratio <= fullHi) return 30;
  if (ratio < zeroLo || ratio > zeroHi) return 0;
  const distance = ratio < fullLo ? (fullLo - ratio) / (fullLo - zeroLo) : (ratio - fullHi) / (zeroHi - fullHi);
  return Math.round(30 * (1 - distance));
}

/** Batch-averages seller ratings (roleContext 'land_seller') — one query
 * for every candidate seller rather than N, same pattern as
 * contractorMatchingService's cert-count batching. */
async function getSellerRatingSummaries(sellerIds) {
  const rows = await Rating.aggregate([
    { $match: { toUserId: { $in: sellerIds }, roleContext: 'land_seller' } },
    { $group: { _id: '$toUserId', average: { $avg: '$score' }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { average: r.average, count: r.count }]));
}

/** Weighted 0-100 composite score for how well one listing fits one
 * funder — same auditable-breakdown approach as contractor/verifier
 * matching. The price-fit and location dimensions only enter the score at
 * all when the funder has real offer history to judge them against; with
 * no history, the total is normalized over just verification + reputation
 * rather than treating the missing dimensions as a zero (which would
 * unfairly punish every listing equally for a fact about the funder, not
 * the listing). */
function scoreListing(listing, preferences, ratingSummary) {
  const verification = VERIFICATION_SCORE[listing.verificationStatus] ?? 8;
  const reputation = ratingSummary && ratingSummary.count > 0 ? Math.round((ratingSummary.average / 5) * RATING_FULL_CREDIT) : RATING_NEUTRAL_CREDIT;

  let maxPossible = 30 + RATING_FULL_CREDIT;
  let earned = verification + reputation;
  const breakdown = { verification, reputation };

  if (preferences) {
    const candidateRate = listing.sizeSqm > 0 ? listing.price / listing.sizeSqm : 0;
    const priceFit = priceFitScore(candidateRate, preferences.avgPricePerSqm);
    const locationMatch = preferences.preferredRegions.has((listing.region || '').toLowerCase()) ? 20 : 0;
    earned += priceFit + locationMatch;
    maxPossible += 30 + 20;
    breakdown.priceFit = priceFit;
    breakdown.locationMatch = locationMatch;
  }

  const total = Math.round((earned / maxPossible) * 100);
  return { total, breakdown };
}

/** Ranks active listings for one funder. Never a replacement for the main
 * browse feed — an opt-in, additive suggestion list — so this deliberately
 * excludes the funder's own listings (if they also hold a land_seller
 * role) and anything already flagged, rather than trying to rank
 * everything on the platform. */
async function getRecommendedListings(funderId, { limit = 10 } = {}) {
  const preferences = await getFunderPreferences(funderId);

  const candidates = await LandListing.find({
    sellerId: { $ne: funderId },
    verificationStatus: { $ne: 'flagged' },
  })
    .select('title region city sizeSqm price verificationStatus imageUrl sellerId')
    .lean();
  if (candidates.length === 0) return [];

  const sellerIds = [...new Set(candidates.map((c) => String(c.sellerId)))].map((id) => new mongoose.Types.ObjectId(id));
  const ratingBySellerId = await getSellerRatingSummaries(sellerIds);

  const scored = candidates.map((listing) => {
    const ratingSummary = ratingBySellerId.get(String(listing.sellerId)) || null;
    const score = scoreListing(listing, preferences, ratingSummary);
    return { listingId: listing._id, title: listing.title, region: listing.region, city: listing.city, price: listing.price, sizeSqm: listing.sizeSqm, imageUrl: listing.imageUrl, verificationStatus: listing.verificationStatus, score };
  });

  scored.sort((a, b) => b.score.total - a.score.total);
  return scored.slice(0, limit);
}

module.exports = { scoreListing, getRecommendedListings, getFunderPreferences };
