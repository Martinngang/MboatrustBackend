// Real, end-to-end proof that the onboarding Country→City residence fields
// actually persist: a valid ISO country code + city round-trips through
// PATCH /users/me, a malformed "country code" (free text, not a real ISO
// code) is rejected rather than silently accepted, and the fields survive
// a subsequent GET /users/me. Genuine HTTP requests against a running
// server (npm run dev). Safe to re-run any time — the fixture user is
// deleted at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User } = require('../models');

const TAG = 'verify-residence-location-script';
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

  try {
    const user = await User.create({
      fullName: `${TAG} User`, email: `${TAG}-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(user._id);
    const client = asUser(user._id);

    // ── A real ISO country code + real city round-trips ──────────────────
    const save = await client.patch('/users/me', { residenceCountry: 'FR', residenceCity: 'Paris', onboardingCompleted: true });
    record('Valid residence country/city is accepted', save.status === 200, `status=${save.status}`);
    record('Response reflects the saved country', save.data?.data?.residenceCountry === 'FR');
    record('Response reflects the saved city', save.data?.data?.residenceCity === 'Paris');

    const refetch = await client.get('/users/me');
    record('GET /users/me returns the persisted residence fields', refetch.data?.data?.residenceCountry === 'FR' && refetch.data?.data?.residenceCity === 'Paris');

    const inDb = await User.findById(user._id).lean();
    record('Fields are actually persisted in the database, not just echoed', inDb.residenceCountry === 'FR' && inDb.residenceCity === 'Paris');

    // ── Free text that isn't a real ISO code is rejected ──────────────────
    const badCountry = await client.patch('/users/me', { residenceCountry: 'France' });
    record('Free-text "country" (not an ISO code) is rejected, not silently accepted', badCountry.status === 400, `status=${badCountry.status}`);

    const stillFR = await User.findById(user._id).lean();
    record('Rejected update did not overwrite the previously-saved valid value', stillFR.residenceCountry === 'FR');

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
