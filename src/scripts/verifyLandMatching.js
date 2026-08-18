// Real, end-to-end proof that the funder-facing land recommendation list
// (GET /land-listings/recommended) works: a funder with no offer history
// still gets ranked suggestions (verification + seller reputation only,
// never a fabricated price/location preference), a funder with real offer
// history sees a listing matching their own price range and region
// outrank a mismatched one, a seller's own listings never recommend to
// themselves, and a flagged listing never appears regardless of how well
// it would otherwise score. Genuine HTTP requests against a running
// server (npm run dev). Safe to re-run any time — every fixture is tagged
// and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, LandListing, LandOffer } = require('../models');

const TAG = 'verify-land-matching-script';
const REGION_A = `${TAG}-region-a`;
const REGION_B = `${TAG}-region-b`;
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
  const createdOfferIds = [];

  try {
    const seller = await User.create({
      fullName: `${TAG} Seller`, email: `${TAG}-seller-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-seller-${Date.now()}`, roles: [{ roleType: 'land_seller' }],
    });
    createdUserIds.push(seller._id);
    const sellerClient = asUser(seller._id);

    // A verified listing matching what "history buyer" will later show
    // interest in (region A, ~5000/sqm), a verified but mismatched one
    // (region B, ~20000/sqm), a merely-pending one at the matching price,
    // and a flagged one that must never appear at all.
    const matchListing = await sellerClient.post('/land-listings', {
      title: `${TAG} matching listing`, region: REGION_A, sizeSqm: 500, price: 500 * 5000,
    });
    createdListingIds.push(matchListing.data.data._id);
    const mismatchListing = await sellerClient.post('/land-listings', {
      title: `${TAG} mismatched listing`, region: REGION_B, sizeSqm: 500, price: 500 * 20000,
    });
    createdListingIds.push(mismatchListing.data.data._id);

    // Flag it via the verification-status endpoint (admin/verifier only) —
    // simplest real path to a 'flagged' listing without touching internals.
    const admin = await User.create({
      fullName: `${TAG} Admin`, email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`, roles: [{ roleType: 'admin' }],
    });
    createdUserIds.push(admin._id);
    const flaggedListing = await sellerClient.post('/land-listings', {
      title: `${TAG} flagged listing`, region: REGION_A, sizeSqm: 500, price: 500 * 5000,
    });
    createdListingIds.push(flaggedListing.data.data._id);
    await asUser(admin._id).patch(`/land-listings/${flaggedListing.data.data._id}/verification-status`, { verificationStatus: 'flagged', disputeReason: 'test' });

    // ── 1. A funder with no offer history still gets recommendations,
    // scored only on verification + reputation (no fabricated price/location fit) ──
    const coldFunder = await User.create({
      fullName: `${TAG} Cold Funder`, email: `${TAG}-cold-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-cold-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(coldFunder._id);
    const coldRes = await asUser(coldFunder._id).get('/land-listings/recommended');
    record('Cold-start funder still gets a 200 with recommendations', coldRes.status === 200 && Array.isArray(coldRes.data.data), `status=${coldRes.status}`);
    const coldIds = (coldRes.data?.data ?? []).map((r) => r.listingId);
    record('Flagged listing never appears, even for a cold-start funder', !coldIds.includes(flaggedListing.data.data._id));
    const coldSample = coldRes.data?.data?.[0];
    record('Cold-start score breakdown has no priceFit/locationMatch dimension', coldSample && coldSample.score.breakdown.priceFit === undefined && coldSample.score.breakdown.locationMatch === undefined, JSON.stringify(coldSample?.score?.breakdown));

    // ── 2. A funder with real offer history ranks the matching listing
    // above the mismatched one ──────────────────────────────────────────
    const historyFunder = await User.create({
      fullName: `${TAG} History Funder`, email: `${TAG}-history-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-history-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(historyFunder._id);
    // Three past offers, all in region A around 5000/sqm — real behavioral history.
    for (let i = 0; i < 3; i++) {
      const offer = await LandOffer.create({
        listingId: matchListing.data.data._id, buyerId: historyFunder._id, offerAmount: 500 * (4800 + i * 100),
      });
      createdOfferIds.push(offer._id);
    }

    const historyRes = await asUser(historyFunder._id).get('/land-listings/recommended');
    record('Funder with history gets a 200', historyRes.status === 200, `status=${historyRes.status}`);
    const byId = new Map((historyRes.data?.data ?? []).map((r) => [r.listingId, r]));
    const matchScore = byId.get(matchListing.data.data._id)?.score?.total;
    const mismatchScore = byId.get(mismatchListing.data.data._id)?.score?.total;
    record('Matching-price-and-region listing outranks the mismatched one', typeof matchScore === 'number' && typeof mismatchScore === 'number' && matchScore > mismatchScore, `match=${matchScore} mismatch=${mismatchScore}`);
    record('History-based score breakdown includes priceFit and locationMatch', byId.get(matchListing.data.data._id)?.score?.breakdown?.priceFit !== undefined);

    // ── 3. A seller never sees their own listings recommended to themselves ──
    // (sellerId equals the requesting user here, even though seller's own
    // role is land_seller not funder — the exclusion is on sellerId, not role)
    const sellerOwnListingsRes = await sellerClient.get('/land-listings/recommended');
    const sellerOwnIds = (sellerOwnListingsRes.data?.data ?? []).map((r) => r.listingId);
    record('Seller never sees their own listings in their own recommendations', !sellerOwnIds.includes(matchListing.data.data._id) && !sellerOwnIds.includes(mismatchListing.data.data._id));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await LandOffer.deleteMany({ _id: { $in: createdOfferIds } });
    await LandListing.deleteMany({ _id: { $in: createdListingIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
