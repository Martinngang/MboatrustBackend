// Real, end-to-end proof that the role self-escalation fix actually holds —
// makes genuine HTTP requests against a running server (using
// DEV_AUTH_BYPASS's x-dev-user-id header, not a Firebase token, since this
// is exercising route/validator/middleware wiring, not identity) rather than
// calling controller functions directly, since the bug this fixes was
// specifically a validator/route-wiring gap that a direct function call
// would never have caught. Requires the backend dev server to be running
// (npm run dev) — this script does not start it. Safe to re-run any time:
// every fixture it creates is tagged and deleted again at the end, pass or
// fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User } = require('../models');

const TAG = 'verify-role-security-script';
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
    validateStatus: () => true, // we assert on status codes ourselves
  });
}

async function run() {
  await connectDB();
  const createdUserIds = [];

  try {
    const regular = await User.create({
      fullName: `${TAG} Regular`,
      email: `${TAG}-regular-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-regular-${Date.now()}`,
      roles: [],
    });
    const admin = await User.create({
      fullName: `${TAG} Admin`,
      email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`,
      roles: [{ roleType: 'admin' }],
    });
    createdUserIds.push(regular._id, admin._id);

    const regularClient = asUser(regular._id);
    const adminClient = asUser(admin._id);

    // ── 1. Self-service escalation to admin/verifier must now be rejected ──
    const selfAdmin = await regularClient.post('/users/me/roles', { roleType: 'admin' });
    record('Self-service grant of "admin" is rejected (400)', selfAdmin.status === 400, `got ${selfAdmin.status}`);

    const selfVerifier = await regularClient.post('/users/me/roles', { roleType: 'verifier' });
    record('Self-service grant of "verifier" is rejected (400)', selfVerifier.status === 400, `got ${selfVerifier.status}`);

    // ── 2. Legitimate self-service roles must still work ────────────────
    const selfFunder = await regularClient.post('/users/me/roles', { roleType: 'funder' });
    record(
      'Self-service grant of "funder" still succeeds',
      selfFunder.status === 200 && selfFunder.data?.data?.roles?.some((r) => r.roleType === 'funder'),
      `got ${selfFunder.status}`
    );

    // ── 3. Admin-only grant endpoint must reject non-admins ─────────────
    const nonAdminGrant = await regularClient.post(`/admin/users/${regular._id}/roles`, { roleType: 'verifier' });
    record('Non-admin calling the admin grant-role endpoint is rejected (403)', nonAdminGrant.status === 403, `got ${nonAdminGrant.status}`);

    // ── 4. Admin-only grant endpoint must work for a real admin ─────────
    const adminGrant = await adminClient.post(`/admin/users/${regular._id}/roles`, { roleType: 'verifier' });
    record(
      'Admin granting "verifier" to another user succeeds',
      adminGrant.status === 200 && adminGrant.data?.data?.roles?.some((r) => r.roleType === 'verifier'),
      `got ${adminGrant.status}`
    );
    const afterGrant = await User.findById(regular._id).lean();
    record(
      'Granted role is actually persisted on the target user',
      afterGrant.roles.some((r) => r.roleType === 'verifier')
    );

    // ── 5. Grant/revoke symmetry — the existing revoke endpoint still works ─
    const revoke = await adminClient.delete(`/admin/users/${regular._id}/roles/verifier`);
    record('Admin revoking the granted role still succeeds', revoke.status === 200, `got ${revoke.status}`);
    const afterRevoke = await User.findById(regular._id).lean();
    record(
      'Revoked role is actually removed from the target user',
      !afterRevoke.roles.some((r) => r.roleType === 'verifier')
    );

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    const allPassed = results.every((r) => r.passed);
    process.exitCode = allPassed ? 0 : 1;
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
