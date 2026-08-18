// Real, end-to-end proof that the Team Management + Templates backend works
// — genuine HTTP requests against a running server (DEV_AUTH_BYPASS's
// x-dev-user-id header), not direct function calls, since ownership scoping
// lives partly in route/controller wiring. Requires the backend dev server
// to be running (npm run dev). Safe to re-run any time: every fixture is
// tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, TeamMember, ProjectTemplate } = require('../models');

const TAG = 'verify-team-templates-script';
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
    const owner = await User.create({
      fullName: `${TAG} Owner`,
      email: `${TAG}-owner-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-owner-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    const existingInvitee = await User.create({
      fullName: `${TAG} Invitee`,
      email: `${TAG}-invitee-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-invitee-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    const outsider = await User.create({
      fullName: `${TAG} Outsider`,
      email: `${TAG}-outsider-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-outsider-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(owner._id, existingInvitee._id, outsider._id);

    const ownerClient = asUser(owner._id);
    const outsiderClient = asUser(outsider._id);
    const inviteeClient = asUser(existingInvitee._id);

    // ── Team ──────────────────────────────────────────────────────────
    const mine1 = await ownerClient.get('/team-members/mine');
    record(
      'getMine auto-creates the owner row',
      mine1.status === 200 && mine1.data?.data?.length === 1 && mine1.data.data[0].role === 'owner' && mine1.data.data[0].status === 'active'
    );

    const inviteExisting = await ownerClient.post('/team-members', { email: existingInvitee.email, role: 'approver' });
    record(
      'Inviting an existing user goes active immediately',
      inviteExisting.status === 201 && inviteExisting.data?.data?.status === 'active' && String(inviteExisting.data.data.userId) === String(existingInvitee._id),
      `status=${inviteExisting.status}`
    );

    const pendingEmail = `${TAG}-notyet-${Date.now()}@test.local`;
    const invitePending = await ownerClient.post('/team-members', { email: pendingEmail, name: 'Not Yet Signed Up', role: 'viewer' });
    record('Inviting a non-existent email stays pending', invitePending.status === 201 && invitePending.data?.data?.status === 'invited');

    // The pending invitee signs up for real (matching email) and claims it.
    const newSignup = await User.create({
      fullName: 'Not Yet Signed Up',
      email: pendingEmail,
      firebaseUid: `${TAG}-newsignup-${Date.now()}`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(newSignup._id);
    const claimResult = await asUser(newSignup._id).post('/team-members/claim');
    record('claim() links a pending invite to the new account', claimResult.status === 200 && claimResult.data?.data?.claimed === 1);
    const afterClaim = await TeamMember.findOne({ invitedEmail: pendingEmail.toLowerCase() }).lean();
    record('Claimed row is now active with the right userId', afterClaim.status === 'active' && String(afterClaim.userId) === String(newSignup._id));

    // Non-owner mutations must be rejected.
    const memberRow = inviteExisting.data.data;
    const outsiderUpdate = await outsiderClient.patch(`/team-members/${memberRow._id}/role`, { role: 'viewer' });
    record('Non-owner cannot update another owner\'s roster', outsiderUpdate.status === 403, `got ${outsiderUpdate.status}`);
    const outsiderRemove = await outsiderClient.delete(`/team-members/${memberRow._id}`);
    record('Non-owner cannot remove from another owner\'s roster', outsiderRemove.status === 403, `got ${outsiderRemove.status}`);

    // Owner can update/remove a non-owner row.
    const ownerUpdate = await ownerClient.patch(`/team-members/${memberRow._id}/role`, { role: 'viewer' });
    record('Owner can update a member\'s role', ownerUpdate.status === 200 && ownerUpdate.data?.data?.role === 'viewer');
    const ownerRemove = await ownerClient.delete(`/team-members/${memberRow._id}`);
    record('Owner can remove a member', ownerRemove.status === 204);

    // ── Templates ─────────────────────────────────────────────────────
    const createTpl = await ownerClient.post('/project-templates', {
      name: `${TAG} Template`,
      category: 'Water & Sanitation',
      milestones: [{ title: 'Step 1', amount: 100000, description: '' }],
    });
    record('Owner can create a template', createTpl.status === 201);
    const tplId = createTpl.data?.data?._id;

    const listMine = await ownerClient.get('/project-templates/mine');
    record('getMine lists only the caller\'s templates', listMine.status === 200 && listMine.data?.data?.some((t) => t._id === tplId));

    const otherDelete = await inviteeClient.delete(`/project-templates/${tplId}`);
    record('A different user cannot delete this template', otherDelete.status === 403, `got ${otherDelete.status}`);

    const ownDelete = await ownerClient.delete(`/project-templates/${tplId}`);
    record('Owner can delete their own template', ownDelete.status === 204);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await User.deleteMany({ _id: { $in: createdUserIds } });
    await TeamMember.deleteMany({ ownerId: { $in: createdUserIds } });
    await ProjectTemplate.deleteMany({ ownerId: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
