// Real, end-to-end proof that the supplier application/approval pipeline
// works — genuine HTTP requests against a running server. Mirrors
// verifyVerifierPipeline.js's shape exactly, plus the two things specific
// to this actor type: an approved-only public directory (funders/
// contractors browse this; verifier profiles have no equivalent), and the
// generic admin role-grant/revoke drawer (GRANTABLE_ROLES) also being able
// to reach 'supplier' directly, not just via the review queue.
// Requires the backend dev server to be running (npm run dev). Safe to
// re-run any time: every fixture is tagged and deleted again at the end,
// pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, SupplierProfile } = require('../models');

const TAG = 'verify-supplier-profile-script';
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
    const applicant = await User.create({
      fullName: `${TAG} Applicant`,
      email: `${TAG}-applicant-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-applicant-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    const admin = await User.create({
      fullName: `${TAG} Admin`,
      email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`,
      roles: [{ roleType: 'admin' }],
    });
    const outsider = await User.create({
      fullName: `${TAG} Outsider`,
      email: `${TAG}-outsider-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-outsider-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(applicant._id, admin._id, outsider._id);

    const applicantClient = asUser(applicant._id);
    const adminClient = asUser(admin._id);
    const outsiderClient = asUser(outsider._id);

    const registration = {
      businessName: `${TAG} Store`,
      address: 'Akwa, Rue de la Joie',
      region: 'Littoral',
      registeredCategories: ['Cement', 'Roofing'],
      phone: '+237 677 100 200',
      paymentProvider: 'mtn_momo',
      payoutPhoneNumber: '+237 677 100 200',
    };

    // ── Self-submission ──────────────────────────────────────────────
    const submit = await applicantClient.post('/supplier-profiles/me', registration);
    record('Applicant can self-submit a registration', submit.status === 200 && submit.data?.data?.applicationStatus === 'pending', `status=${submit.status}`);

    const afterSubmit = await User.findById(applicant._id).lean();
    record('No role granted yet on submission', !afterSubmit.roles.some((r) => r.roleType === 'supplier'));

    // Not visible in the public directory (pending, not approved).
    const dirBeforeApproval = await applicantClient.get('/supplier-profiles/directory');
    record('Pending registration is not in the public directory', !dirBeforeApproval.data?.data?.some((p) => p.businessName === registration.businessName));

    // Non-admin cannot approve.
    const profileId = submit.data.data._id;
    const nonAdminApprove = await outsiderClient.post(`/supplier-profiles/${profileId}/approve`);
    record('Non-admin cannot approve a registration', nonAdminApprove.status === 403, `got ${nonAdminApprove.status}`);

    // Admin review queue shows it.
    const queue = await adminClient.get('/supplier-profiles', { params: { applicationStatus: 'pending' } });
    record('Admin review queue lists the pending registration', queue.status === 200 && queue.data?.data?.some((p) => p._id === profileId));

    // ── Approval — atomicity ──────────────────────────────────────────
    const approve = await adminClient.post(`/supplier-profiles/${profileId}/approve`);
    record(
      'Approval flips applicationStatus AND grants the role in one check',
      approve.status === 200 && approve.data?.data?.applicationStatus === 'approved',
      `status=${approve.status}`
    );
    const afterApprove = await User.findById(applicant._id).lean();
    record('Role is actually on the user immediately after approve', afterApprove.roles.some((r) => r.roleType === 'supplier'));

    // Now visible in the public directory.
    const dirAfterApproval = await outsiderClient.get('/supplier-profiles/directory');
    record('Approved registration now appears in the public directory', dirAfterApproval.data?.data?.some((p) => p._id === profileId));

    // ── Generic admin role drawer can also reach 'supplier' ──────
    const revoke = await adminClient.delete(`/admin/users/${applicant._id}/roles/supplier`);
    record('Admin can revoke the supplier role via the generic role endpoint', revoke.status === 200 && !revoke.data?.data?.roles?.some((r) => r.roleType === 'supplier'));
    const regrant = await adminClient.post(`/admin/users/${applicant._id}/roles`, { roleType: 'supplier' });
    record('Admin can grant the supplier role via the generic role endpoint', regrant.status === 200 && regrant.data?.data?.roles?.some((r) => r.roleType === 'supplier'));
    const selfGrantAttempt = await applicantClient.post('/users/me/roles', { roleType: 'supplier' });
    record('supplier is never self-grantable (trust-elevating, admin/approval only)', selfGrantAttempt.status === 400, `got ${selfGrantAttempt.status}`);

    // ── Reject + re-apply ─────────────────────────────────────────────
    const applicant2 = await User.create({
      fullName: `${TAG} Applicant Two`,
      email: `${TAG}-applicant2-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-applicant2-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(applicant2._id);
    const applicant2Client = asUser(applicant2._id);

    const submit2 = await applicant2Client.post('/supplier-profiles/me', { ...registration, businessName: `${TAG} Store Two` });
    const profile2Id = submit2.data.data._id;
    const rejectRes = await adminClient.post(`/supplier-profiles/${profile2Id}/reject`);
    record('Admin can reject a registration', rejectRes.status === 200 && rejectRes.data?.data?.applicationStatus === 'rejected');

    const reapply = await applicant2Client.post('/supplier-profiles/me', { ...registration, businessName: `${TAG} Store Two Resubmitted` });
    record('Re-applying after rejection resets status to pending', reapply.status === 200 && reapply.data?.data?.applicationStatus === 'pending');
    const afterReject = await User.findById(applicant2._id).lean();
    record('Rejected applicant never got the role', !afterReject.roles.some((r) => r.roleType === 'supplier'));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await User.deleteMany({ _id: { $in: createdUserIds } });
    await SupplierProfile.deleteMany({ ownerId: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
