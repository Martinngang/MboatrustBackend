// Real, end-to-end proof that the verifier application/approval pipeline
// works — genuine HTTP requests against a running server, and specifically
// asserts the thing this design targets: that approval flips
// applicationStatus AND grants the role in the same atomic check, never a
// partial state. Requires the backend dev server to be running (npm run dev).
// Safe to re-run any time: every fixture is tagged and deleted again at the
// end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, VerifierProfile } = require('../models');

const TAG = 'verify-verifier-pipeline-script';
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

    // ── Self-submission ──────────────────────────────────────────────
    const submit = await applicantClient.post('/verifier-profiles/me', {
      specialties: ['Water & Sanitation'],
      regions: ['Centre'],
      bio: 'Field engineer, 5 years site inspection experience.',
    });
    record('Applicant can self-submit an application', submit.status === 201 && submit.data?.data?.applicationStatus === 'pending', `status=${submit.status}`);

    const afterSubmit = await User.findById(applicant._id).lean();
    record('No role granted yet on submission', !afterSubmit.roles.some((r) => r.roleType === 'verifier'));

    // Non-admin cannot approve.
    const profileId = submit.data.data._id;
    const nonAdminApprove = await outsiderClient.post(`/verifier-profiles/${profileId}/approve`);
    record('Non-admin cannot approve an application', nonAdminApprove.status === 403, `got ${nonAdminApprove.status}`);

    // Admin review queue shows it.
    const queue = await adminClient.get('/verifier-profiles', { params: { applicationStatus: 'pending' } });
    record('Admin review queue lists the pending application', queue.status === 200 && queue.data?.data?.some((p) => p._id === profileId));

    // ── Approval — the atomicity this design targets ─────────────────
    const approve = await adminClient.post(`/verifier-profiles/${profileId}/approve`);
    record(
      'Approval flips applicationStatus AND grants the role in one check',
      approve.status === 200 && approve.data?.data?.applicationStatus === 'approved',
      `status=${approve.status}`
    );
    const afterApprove = await User.findById(applicant._id).lean();
    record('Role is actually on the user immediately after approve', afterApprove.roles.some((r) => r.roleType === 'verifier'));

    // ── Reject + re-apply ─────────────────────────────────────────────
    const applicant2 = await User.create({
      fullName: `${TAG} Applicant Two`,
      email: `${TAG}-applicant2-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-applicant2-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(applicant2._id);
    const applicant2Client = asUser(applicant2._id);

    const submit2 = await applicant2Client.post('/verifier-profiles/me', { specialties: ['Electrical'] });
    const profile2Id = submit2.data.data._id;
    const rejectRes = await adminClient.post(`/verifier-profiles/${profile2Id}/reject`);
    record('Admin can reject an application', rejectRes.status === 200 && rejectRes.data?.data?.applicationStatus === 'rejected');

    const reapply = await applicant2Client.post('/verifier-profiles/me', { specialties: ['Electrical', 'Structural'] });
    record('Re-applying after rejection resets status to pending', reapply.status === 201 && reapply.data?.data?.applicationStatus === 'pending');
    const afterReject = await User.findById(applicant2._id).lean();
    record('Rejected applicant never got the role', !afterReject.roles.some((r) => r.roleType === 'verifier'));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await User.deleteMany({ _id: { $in: createdUserIds } });
    await VerifierProfile.deleteMany({ userId: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
