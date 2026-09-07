// Real, end-to-end proof of contractor team delegation — genuine HTTP
// requests against a running server (DEV_AUTH_BYPASS's x-dev-user-id
// header), not direct function calls, since the delegate's whole point is
// that it changes what bidController/contractController/projectController
// return for someone who ISN'T the contractor. Covers the exact flow the
// feature was built for: create team -> invite member -> assign permission
// -> submit milestone -> funder sees correct submitter -> revoke access ->
// verify access is removed. Safe to re-run any time: every fixture is
// tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, TeamMember, TeamActivityLog, Escrow } = require('../models');

const TAG = 'verify-team-delegation-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(userId) }, validateStatus: () => true });
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];

  try {
    const funder = await User.create({
      fullName: `${TAG} Funder`, email: `${TAG}-funder-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-funder-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    const contractor = await User.create({
      fullName: `${TAG} Contractor`, email: `${TAG}-contractor-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-contractor-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    const delegate = await User.create({
      fullName: `${TAG} Delegate`, email: `${TAG}-delegate-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-delegate-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    const outsider = await User.create({
      fullName: `${TAG} Outsider`, email: `${TAG}-outsider-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-outsider-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    createdUserIds.push(funder._id, contractor._id, delegate._id, outsider._id);

    const funderClient = asUser(funder._id);
    const contractorClient = asUser(contractor._id);
    const delegateClient = asUser(delegate._id);
    const outsiderClient = asUser(outsider._id);

    // ── Set up a real awarded tender with one milestone ──────────────────
    const tender = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Tender`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 100000,
      milestones: [{ name: 'Foundation', description: 'x', amount: 100000, orderIndex: 0 }],
    });
    record('Funder can post a tender', tender.status === 201, `status=${tender.status}`);
    const projectId = tender.data.data._id;
    createdProjectIds.push(projectId);
    const milestoneId = tender.data.data.milestones[0]._id;

    const bid = await contractorClient.post('/bids', { projectId, price: 100000, timelineDays: 14, notes: 'x' });
    const bidId = bid.data.data._id;
    const acceptBid = await funderClient.patch(`/bids/${bidId}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-award` } });
    record('Funder can accept the bid, creating a contract', acceptBid.status === 200 && acceptBid.data.data.contract != null);

    // Every real screen (MyBidsScreen/ContractDetailScreen, web and mobile)
    // queries `contractorId: <the logged-in user's own id>` — never the
    // contractor's id directly. The delegate's visibility has to come from
    // the backend expanding THEIR OWN "contractorId: me" query, exactly as
    // it's actually called; so this script queries the same way.
    // ── Before delegation: the delegate has no visibility into the contractor's work ──
    const bidsBefore = await delegateClient.get('/bids', { params: { contractorId: delegate._id } });
    record(
      'Before delegation, querying "my bids" as the delegate returns nothing tied to the contractor',
      bidsBefore.status === 200 && !bidsBefore.data.data.some((b) => b._id === bidId)
    );

    const evidenceBeforeDelegation = await delegateClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/before.jpg' });
    record('Before delegation, submitting evidence is forbidden', evidenceBeforeDelegation.status === 403, `got ${evidenceBeforeDelegation.status}`);

    // ── Create team: invite the delegate with the milestone-submission permission ──
    const invite = await contractorClient.post('/team-members', { email: delegate.email, role: 'viewer', permissions: ['submit_milestones'] });
    record('Contractor can invite a real account as a delegate with submit_milestones', invite.status === 201 && invite.data.data.status === 'active' && (invite.data.data.permissions || []).includes('submit_milestones'), `status=${invite.status}`);
    const memberId = invite.data.data._id;

    const activityAfterInvite = await TeamActivityLog.find({ ownerId: contractor._id }).lean();
    record('Inviting the delegate wrote a TeamActivityLog entry', activityAfterInvite.some((r) => r.action === 'member.invited'));

    // An unrelated account never gains anything from someone else's delegation.
    const outsiderBids = await outsiderClient.get('/bids', { params: { contractorId: outsider._id } });
    record('An unrelated account still sees nothing for the contractor', outsiderBids.status === 200 && !outsiderBids.data.data.some((b) => b._id === bidId));

    // ── Delegate can now find and act on the contractor's real work ─────
    const bidsAfter = await delegateClient.get('/bids', { params: { contractorId: delegate._id } });
    record('After delegation, the delegate\'s own "contractorId: me" query surfaces the contractor\'s bid', bidsAfter.status === 200 && bidsAfter.data.data.some((b) => b._id === bidId));

    const contractsAfter = await delegateClient.get('/contracts', { params: { bidId } });
    record('The delegate can also see the resulting contract via the same bidId filter', contractsAfter.status === 200 && contractsAfter.data.data.length === 1);

    const submitAsDelegate = await delegateClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/delegate.jpg', notes: 'submitted by delegate' });
    record('The delegate can submit milestone evidence on the contractor\'s behalf', submitAsDelegate.status === 201, `status=${submitAsDelegate.status}`);

    const projectAfterSubmit = await Project.findById(projectId).lean();
    const milestoneAfterSubmit = projectAfterSubmit.milestones.find((m) => String(m._id) === String(milestoneId));
    const lastEvidence = milestoneAfterSubmit.evidence[milestoneAfterSubmit.evidence.length - 1];
    record('The persisted evidence is attributed to the delegate, not the contractor', String(lastEvidence.submittedBy) === String(delegate._id));

    const activityAfterSubmit = await TeamActivityLog.find({ ownerId: contractor._id, action: 'milestone.submittedOnBehalf' }).lean();
    record('The on-behalf submission wrote its own TeamActivityLog entry', activityAfterSubmit.length === 1);

    // ── Funder sees the correct (real) submitter ─────────────────────────
    const funderView = await funderClient.get(`/projects/${projectId}`);
    const funderMilestone = funderView.data.data.milestones.find((m) => m._id === milestoneId);
    const funderLastEvidence = funderMilestone.evidence[funderMilestone.evidence.length - 1];
    record(
      'The funder\'s own project view names the delegate as the submitter, not the contractor',
      funderView.status === 200 && funderLastEvidence.submittedBy && funderLastEvidence.submittedBy.fullName === delegate.fullName
    );

    // An unrelated stranger still can't submit evidence — delegation only ever widens access for the one real delegate.
    const outsiderSubmit = await outsiderClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/outsider.jpg' });
    record('An unrelated stranger still cannot submit evidence on this project', outsiderSubmit.status === 403, `got ${outsiderSubmit.status}`);

    // ── Contractor revokes access at any time ────────────────────────────
    const revoke = await contractorClient.delete(`/team-members/${memberId}`);
    record('Contractor can revoke the delegate at any time', revoke.status === 204, `status=${revoke.status}`);

    const activityAfterRevoke = await TeamActivityLog.find({ ownerId: contractor._id, action: 'member.removed' }).lean();
    record('Revoking wrote its own TeamActivityLog entry', activityAfterRevoke.length === 1);

    // ── Verify access is actually removed ────────────────────────────────
    const bidsAfterRevoke = await delegateClient.get('/bids', { params: { contractorId: delegate._id } });
    record('After revocation, the delegate\'s own query no longer surfaces the contractor\'s bid', bidsAfterRevoke.status === 200 && !bidsAfterRevoke.data.data.some((b) => b._id === bidId));

    const submitAfterRevoke = await delegateClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/after-revoke.jpg' });
    record('After revocation, the (former) delegate can no longer submit evidence', submitAfterRevoke.status === 403, `got ${submitAfterRevoke.status}`);

    const stillOwnerRow = await TeamMember.findOne({ ownerId: contractor._id, userId: delegate._id }).lean();
    record('The delegate\'s roster row is actually gone, not just permission-stripped', stillOwnerRow == null);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await TeamActivityLog.deleteMany({ ownerId: { $in: createdUserIds } });
    await TeamMember.deleteMany({ ownerId: { $in: createdUserIds } });
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await Bid.deleteMany({ projectId: { $in: createdProjectIds } });
    const { Contract } = require('../models');
    await Contract.deleteMany({ projectId: { $in: createdProjectIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
