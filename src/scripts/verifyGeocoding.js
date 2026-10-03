// Real, end-to-end proof that the geocoding/mapping system actually works:
// creating a project/land listing/supplier profile with only a text
// location auto-geocodes it (no GOOGLE_MAPS_API_KEY set in this dev
// environment, so this exercises the real Nominatim fallback path — the
// one that ships today), a manual pin correction persists even on a project
// past draft/open (the status that blocks the generic update endpoint),
// and an unrelated user is forbidden from correcting someone else's pin.
// Genuine HTTP requests against a running server (npm run dev). Safe to
// re-run any time — every fixture created here is deleted at the end, pass
// or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, LandListing, SupplierProfile } = require('../models');

const TAG = 'verify-geocoding-script';
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
  const createdProjectIds = [];
  const createdListingIds = [];
  const createdSupplierIds = [];

  try {
    const owner = await User.create({
      fullName: `${TAG} Owner`, email: `${TAG}-owner-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-owner-${Date.now()}`, roles: [{ roleType: 'funder' }, { roleType: 'land_seller' }],
    });
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(owner._id, stranger._id);
    const ownerClient = asUser(owner._id);
    const strangerClient = asUser(stranger._id);

    // ── GET /tools/geocode resolves a real address via the free fallback ──
    const geocodeRes = await ownerClient.get('/tools/geocode', { params: { query: 'Douala, Cameroon' } });
    record('GET /tools/geocode resolves a real place — status=200', geocodeRes.status === 200, `status=${geocodeRes.status}`);
    record(
      'Resolved coordinates are real numbers, not null',
      typeof geocodeRes.data?.data?.result?.lat === 'number' && typeof geocodeRes.data?.data?.result?.lng === 'number'
    );

    // ── Creating a project with only locationName auto-geocodes it ────────
    const projectRes = await ownerClient.post('/projects', {
      projectType: 'tender',
      title: `${TAG} Project`,
      description: 'x',
      category: 'General',
      locationName: 'Douala, Cameroon',
      totalAmount: 100000,
      milestones: [{ name: 'Milestone 1', description: 'x', amount: 100000, orderIndex: 0 }],
    });
    createdProjectIds.push(projectRes.data?.data?._id);
    record('Project with only locationName is created — status=201', projectRes.status === 201, `status=${projectRes.status}`);
    record(
      'Project.location was auto-geocoded, not left null',
      projectRes.data?.data?.location?.lat != null && projectRes.data?.data?.location?.lng != null
    );

    // ── Manual pin correction works even once the project is past draft/open ──
    const projectId = projectRes.data?.data?._id;
    await Project.updateOne({ _id: projectId }, { $set: { status: 'in_progress' } });
    const blockedGenericUpdate = await ownerClient.patch(`/projects/${projectId}`, { title: 'Should be blocked' });
    record(
      'The GENERIC update endpoint correctly blocks edits once in_progress (sanity check)',
      blockedGenericUpdate.status === 409,
      `status=${blockedGenericUpdate.status}`
    );
    const locationFix = await ownerClient.patch(`/projects/${projectId}/location`, { location: { lat: 4.05, lng: 9.7 } });
    record(
      'The DEDICATED location endpoint still works once in_progress — status=200',
      locationFix.status === 200,
      `status=${locationFix.status}`
    );
    record('Corrected coordinates are actually persisted', locationFix.data?.data?.location?.lat === 4.05 && locationFix.data?.data?.location?.lng === 9.7);

    const strangerLocationFix = await strangerClient.patch(`/projects/${projectId}/location`, { location: { lat: 1, lng: 1 } });
    record('An unrelated user cannot correct this project\'s pin — got 403', strangerLocationFix.status === 403, `status=${strangerLocationFix.status}`);

    // ── Milestone-level location ───────────────────────────────────────────
    const milestoneId = projectRes.data?.data?.milestones?.[0]?._id;
    const milestoneLocationFix = await ownerClient.patch(`/projects/${projectId}/milestones/${milestoneId}/location`, {
      location: { lat: 4.1, lng: 9.8 },
    });
    record('Milestone location can be set — status=200', milestoneLocationFix.status === 200, `status=${milestoneLocationFix.status}`);
    const savedMilestone = milestoneLocationFix.data?.data?.milestones?.find((m) => String(m._id) === String(milestoneId));
    record('Milestone location is actually persisted, distinct from the project\'s', savedMilestone?.location?.lat === 4.1 && savedMilestone?.location?.lng === 9.8);

    // ── Land listing: create with only city/region auto-geocodes; update has no status gate ──
    const listingRes = await ownerClient.post('/land-listings', {
      title: `${TAG} Listing`, region: 'Littoral', city: 'Douala', titleType: 'Land Certificate',
      description: 'x', sizeSqm: 500, price: 1000000,
    });
    createdListingIds.push(listingRes.data?.data?._id);
    record('Land listing with only city/region is created — status=201', listingRes.status === 201, `status=${listingRes.status}`);
    record(
      'LandListing.location was auto-geocoded, not left null',
      listingRes.data?.data?.location?.lat != null && listingRes.data?.data?.location?.lng != null
    );
    const listingLocationFix = await ownerClient.patch(`/land-listings/${listingRes.data?.data?._id}`, { location: { lat: 4.2, lng: 9.9 } });
    record('Land listing pin correction via the existing update endpoint works — status=200', listingLocationFix.status === 200, `status=${listingLocationFix.status}`);
    record('Corrected land listing coordinates persisted', listingLocationFix.data?.data?.location?.lat === 4.2);

    // ── Supplier profile: location default is null, not {0,0} ─────────────
    const rawSupplier = await SupplierProfile.create({ ownerId: owner._id, businessName: `${TAG} Supply`, region: 'Littoral' });
    createdSupplierIds.push(rawSupplier._id);
    record(
      'A brand-new SupplierProfile defaults location to null, not {0,0}',
      rawSupplier.location.lat === null && rawSupplier.location.lng === null
    );

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await LandListing.deleteMany({ _id: { $in: createdListingIds } });
    await SupplierProfile.deleteMany({ _id: { $in: createdSupplierIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
