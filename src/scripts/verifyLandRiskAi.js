// Real, end-to-end proof that land listings get an automatic fraud second
// opinion at submission: a price/sqm heuristic flags listings priced far
// outside their region's median, a proximity+size heuristic still catches
// duplicates (pre-existing behavior, re-asserted here), and either trigger
// creates a RiskFlag (flagType 'land_listing_risk') that the AI layer can
// augment when GEMINI_API_KEY is set. Genuine HTTP requests against a
// running server (npm run dev). Safe to re-run any time — every fixture is
// tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, LandListing, RiskFlag } = require('../models');
const { isAiConfigured } = require('../services/aiClient');
const env = require('../config/env');

const TAG = 'verify-land-risk-ai-script';
const REGION = `${TAG}-region`;
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'x-dev-user-id': String(userId) },
    validateStatus: () => true,
  });
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdListingIds = [];

  try {
    const seller = await User.create({
      fullName: `${TAG} Seller`,
      email: `${TAG}-seller-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-seller-${Date.now()}`,
      roles: [{ roleType: 'land_seller' }],
    });
    createdUserIds.push(seller._id);
    const seller1 = asUser(seller._id);

    // ── Seed comparable listings so the region has a real median ────────
    // 5 listings around 5,000/sqm — enough to clear MIN_COMPARABLES (3).
    for (let i = 0; i < 5; i++) {
      const res = await seller1.post('/land-listings', {
        title: `${TAG} comparable ${i}`,
        region: REGION,
        sizeSqm: 500,
        price: 500 * 5000, // 5000/sqm
      });
      if (res.status === 201) createdListingIds.push(res.data.data._id);
    }
    record('Seeded 5 comparable listings at the regional baseline price', createdListingIds.length === 5, `created=${createdListingIds.length}`);

    // ── A normally-priced listing should NOT be flagged ──────────────────
    const normal = await seller1.post('/land-listings', {
      title: `${TAG} normal listing`,
      region: REGION,
      sizeSqm: 500,
      price: 500 * 5200, // close to the 5000/sqm median
    });
    createdListingIds.push(normal.data?.data?._id);
    record('Normally-priced listing is created without a dispute flag', normal.status === 201 && normal.data?.data?.disputeFlag === false, `status=${normal.status}`);

    // ── A wildly under-priced listing IS flagged (price outlier) ─────────
    const cheap = await seller1.post('/land-listings', {
      title: `${TAG} suspiciously cheap listing`,
      region: REGION,
      sizeSqm: 500,
      price: 500 * 500, // 500/sqm — 10% of the median, well under the 40% floor
    });
    createdListingIds.push(cheap.data?.data?._id);
    record(
      'Suspiciously under-priced listing is auto-flagged',
      cheap.status === 201 && cheap.data?.data?.disputeFlag === true,
      `status=${cheap.status} disputeFlag=${cheap.data?.data?.disputeFlag}`
    );

    const cheapRiskFlag = await RiskFlag.findOne({ userId: seller._id, flagType: 'land_listing_risk', 'detail.listingId': new mongoose.Types.ObjectId(cheap.data?.data?._id) }).lean();
    record('Price-outlier flag creates a RiskFlag with the right detail', Boolean(cheapRiskFlag && cheapRiskFlag.detail?.priceOutlier));

    // ── Too few comparables in a fresh region: heuristic must skip, not guess ──
    const freshRegionSeller = asUser(seller._id);
    const loneListing = await freshRegionSeller.post('/land-listings', {
      title: `${TAG} lone listing in empty region`,
      region: `${TAG}-empty-region`,
      sizeSqm: 300,
      price: 1, // would look like an extreme outlier if a median were computed off zero comparables
    });
    createdListingIds.push(loneListing.data?.data?._id);
    record(
      'A region with too few comparables is never flagged as a price outlier',
      loneListing.status === 201 && loneListing.data?.data?.disputeFlag === false,
      `status=${loneListing.status} disputeFlag=${loneListing.data?.data?.disputeFlag}`
    );

    // ── Duplicate-proximity heuristic still works (pre-existing, re-asserted) ──
    const original = await seller1.post('/land-listings', {
      title: `${TAG} original plot`,
      region: REGION,
      sizeSqm: 400,
      price: 400 * 5000,
      location: { lat: 4.05, lng: 9.7 },
    });
    createdListingIds.push(original.data?.data?._id);
    const relisted = await seller1.post('/land-listings', {
      title: `${TAG} relisted plot`,
      region: REGION,
      sizeSqm: 405, // within the 10% size tolerance
      price: 405 * 5000,
      location: { lat: 4.0501, lng: 9.7001 }, // well within the 150m radius
    });
    createdListingIds.push(relisted.data?.data?._id);
    record(
      'Duplicate (proximity + size match) listing is auto-flagged',
      relisted.status === 201 && relisted.data?.data?.disputeFlag === true && !!relisted.data?.data?.duplicateOfListingId,
      `status=${relisted.status} disputeFlag=${relisted.data?.data?.disputeFlag}`
    );
    const dupRiskFlag = await RiskFlag.findOne({ userId: seller._id, flagType: 'land_listing_risk', 'detail.listingId': new mongoose.Types.ObjectId(relisted.data?.data?._id) }).lean();
    record('Duplicate flag also creates a RiskFlag', Boolean(dupRiskFlag && dupRiskFlag.detail?.duplicateOfListingId));

    // ── AI second opinion, only if a real key is configured ───────────────
    if (isAiConfigured() && env.ai.fraudAnalysisEnabled) {
      const freshFlag = await RiskFlag.findOne({ userId: seller._id, flagType: 'land_listing_risk', 'detail.listingId': new mongoose.Types.ObjectId(cheap.data?.data?._id) }).lean();
      record('AI second opinion ran and augmented the price-outlier flag', freshFlag && freshFlag.aiRiskScore != null, `aiRiskScore=${freshFlag?.aiRiskScore}`);
    } else {
      console.log('[verify] GEMINI_API_KEY not configured or AI_FRAUD_ANALYSIS_ENABLED=false — skipping AI second-opinion assertion (expected in this environment).');
    }

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await LandListing.deleteMany({ _id: { $in: createdListingIds.filter(Boolean) } });
    await RiskFlag.deleteMany({ userId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
