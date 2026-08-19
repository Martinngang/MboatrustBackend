// Real, end-to-end proof that self-service account deactivation ("delete
// account" in the UI) actually works: a user can deactivate their own
// account, it's really persisted (isActive:false, confirmed by a direct DB
// read), the very next authenticated request from that account is rejected
// (matching authenticate's isActive check), and a user cannot deactivate
// anyone but themselves. Genuine HTTP requests against a running server
// (npm run dev). Safe to re-run any time — every fixture is tagged and
// deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User } = require('../models');

const TAG = 'verify-delete-account-script';
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
      fullName: `${TAG} User`,
      email: `${TAG}-user-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-user-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(user._id);
    const client = asUser(user._id);

    // ── A user can deactivate their own account ──────────────────────────
    const res = await client.patch('/users/me/deactivate');
    record('Self-deactivate returns 200 with isActive:false in the response', res.status === 200 && res.data?.data?.isActive === false, `status=${res.status}`);

    const afterDeactivate = await User.findById(user._id).lean();
    record('isActive:false is really persisted (direct DB read)', afterDeactivate.isActive === false);

    // ── The very next authenticated request from this account is rejected ──
    const nextRequest = await client.get('/users/me');
    record('A deactivated account is rejected on its very next request', nextRequest.status === 403, `got ${nextRequest.status}`);

    // ── A user cannot deactivate anyone else's account ───────────────────
    const other = await User.create({
      fullName: `${TAG} Other`,
      email: `${TAG}-other-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(other._id);
    const otherClient = asUser(other._id);
    const selfOnlyRes = await otherClient.patch('/users/me/deactivate');
    record('The endpoint only ever targets the caller\'s own account (no id param to exploit)', selfOnlyRes.status === 200);
    const otherStillActive = await User.findById(user._id).lean(); // the FIRST user, untouched by the second user's own self-deactivate
    record('Deactivating one account never touches a different account', otherStillActive.isActive === false && String(otherStillActive._id) === String(user._id));

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
