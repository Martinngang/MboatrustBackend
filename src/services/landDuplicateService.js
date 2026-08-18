const { haversineDistanceMeters } = require('../utils/geo');
const { LandListing } = require('../models');
const { isAiConfigured, analyzeWithGemini, parseJsonResponse } = require('./aiClient');
const env = require('../config/env');

const PROXIMITY_RADIUS_M = 150; // two listings this close claiming similar size are very likely the same plot
const SIZE_TOLERANCE = 0.1; // ±10%
const MIN_COMPARABLES = 3; // too few listings in a region to trust a median off of
const LOW_OUTLIER_RATIO = 0.4; // priced under 40% of the regional median/sqm
const HIGH_OUTLIER_RATIO = 2.5; // priced over 250% of the regional median/sqm

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Flags a listing whose price/sqm is far outside what other listings in the
 * same region are asking — the land-pillar analogue of a heuristic price
 * check, adapted since land has no transaction history to compare against
 * (unlike escrow, where past releases give a real baseline). Skipped
 * entirely when the region doesn't have enough other listings to trust a
 * median off of, rather than inventing a threshold from too little data.
 */
async function findPriceOutlier(listing) {
  if (!listing.region || !listing.sizeSqm || !listing.price) return null;

  const comparables = await LandListing.find({
    _id: { $ne: listing._id },
    region: listing.region,
    verificationStatus: { $ne: 'flagged' },
    sizeSqm: { $gt: 0 },
    price: { $gt: 0 },
  })
    .select('sizeSqm price')
    .lean();

  if (comparables.length < MIN_COMPARABLES) return null;

  const comparableRates = comparables.map((c) => c.price / c.sizeSqm);
  const regionalMedian = median(comparableRates);
  if (regionalMedian <= 0) return null;

  const rate = listing.price / listing.sizeSqm;
  const ratio = rate / regionalMedian;
  if (ratio >= LOW_OUTLIER_RATIO && ratio <= HIGH_OUTLIER_RATIO) return null;

  return { rate, regionalMedian, ratio, comparableCount: comparables.length };
}

/**
 * AI second opinion — same contract as evidenceAnalysisService's: only
 * called when a heuristic (duplicate or price-outlier) already flagged the
 * listing, never throws, returns null on anything short of a clean parse.
 */
async function getAiSecondOpinion({ listing, duplicateId, priceOutlier }) {
  if ((!duplicateId && !priceOutlier) || !env.ai.fraudAnalysisEnabled || !isAiConfigured()) return null;

  const system =
    'You are a fraud-review second opinion for Mboa Trust, a platform where diaspora buyers purchase land ' +
    'in Cameroon sight-unseen based on listing details and uploaded ownership documents. This listing has ' +
    'already been flagged by deterministic checks below. Give your own independent assessment of whether it ' +
    'looks like a genuine, fairly-priced listing or looks fabricated, re-listed, or otherwise untrustworthy. ' +
    'Reply with strict JSON only, no prose, no markdown fences: ' +
    '{"riskScore": <0-100 integer>, "suspicious": <true|false>, "rationale": "<one or two sentences>"}';

  const prompt =
    `Title: ${listing.title || 'untitled'}\n` +
    `Region: ${listing.region || 'unspecified'}, City: ${listing.city || 'unspecified'}\n` +
    `Size: ${listing.sizeSqm} sqm, Price: ${listing.price}, Title type: ${listing.titleType || 'unspecified'}\n` +
    `Description: ${listing.description || 'none'}\n` +
    `Documents attached: ${listing.documents?.length ?? 0}\n` +
    `Deterministic signals already triggered: duplicateOfListing=${Boolean(duplicateId)}, ` +
    `priceOutlier=${priceOutlier ? `${priceOutlier.ratio.toFixed(2)}x the regional median/sqm (${priceOutlier.comparableCount} comparables)` : 'false'}`;

  const result = await analyzeWithGemini({ system, prompt, imageUrl: listing.imageUrl || undefined });
  if (!result.ok) return null;

  const parsed = parseJsonResponse(result.text);
  if (!parsed || typeof parsed.riskScore !== 'number') return null;

  return {
    riskScore: Math.max(0, Math.min(100, Math.round(parsed.riskScore))),
    suspicious: Boolean(parsed.suspicious),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1000) : '',
  };
}

module.exports = { findDuplicate, findPriceOutlier, getAiSecondOpinion };
