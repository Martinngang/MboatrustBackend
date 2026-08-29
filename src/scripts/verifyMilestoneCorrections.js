// Real, end-to-end proof of the flexible milestone/weekly-payment-schedule
// work: genuine HTTP requests against a running server. Covers three real
// gaps found and fixed while building this — (1) decideApproval had no
// ownership check at all in its single-approver default path, letting any
// authenticated caller (including the contractor whose own work was under
// review) register themselves as the sole approver and release real escrow
// money to themselves; (2) disputeMilestone had no party check either,
// letting a stranger dispute a project they have nothing to do with; (3)
// the new, lighter-weight requestMilestoneChanges action (approve /
// request corrections / dispute — three real, distinct outcomes). Safe to
// re-run any time: every fixture is tagged and deleted again at the end,
// pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, Dispute } = require('../models');

const TAG = 'verify-milestone-corrections-script';
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
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(funder._id, contractor._id, stranger._id);

    const funderClient = asUser(funder._id);
    const contractorClient = asUser(contractor._id);
    const strangerClient = asUser(stranger._id);

    // ── Weekly/custom payment schedule — real title+amount+description per row ──
    const tender = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Weekly Tender`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 300000,
      milestones: [
        { name: 'Week 1', description: 'Site prep and materials delivery', amount: 100000, orderIndex: 0 },
        { name: 'Week 2', description: 'Core installation work', amount: 150000, orderIndex: 1 },
        { name: 'Week 3', description: 'Testing and handover', amount: 50000, orderIndex: 2 },
      ],
    });
    record('Funder can post a tender with a real weekly schedule', tender.status === 201, `status=${tender.status}`);
    const projectId = tender.data.data._id;
    createdProjectIds.push(projectId);
    const weeklyMilestones = tender.data.data.milestones;
    record(
      'Each week persists its own label, description, and amount',
      weeklyMilestones[0].name === 'Week 1' && weeklyMilestones[0].description === 'Site prep and materials delivery' && weeklyMilestones[0].amount === 100000
        && weeklyMilestones[1].amount === 150000 && weeklyMilestones[2].amount === 50000
    );
    const milestoneId = weeklyMilestones[0]._id;

    // Award the contractor.
    const bid = await contractorClient.post('/bids', { projectId, price: 290000, timelineDays: 21, materialsPlan: 'x', notes: 'x' });
    await funderClient.patch(`/bids/${bid.data.data._id}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-award` } });

    // Contractor submits evidence for week 1.
    await funderClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/fake.jpg' });

    // ── Security fix #1: decideApproval ownership check ─────────────────
    const contractorSelfApprove = await contractorClient.post(
      `/projects/${projectId}/milestones/${milestoneId}/approval`,
      { status: 'approved' },
      { headers: { 'Idempotency-Key': `${TAG}-contractor-self-approve` } }
    );
    record('The contractor cannot approve/release their own submitted milestone', contractorSelfApprove.status === 403, `got ${contractorSelfApprove.status}`);

    const strangerApprove = await strangerClient.post(
      `/projects/${projectId}/milestones/${milestoneId}/approval`,
      { status: 'approved' },
      { headers: { 'Idempotency-Key': `${TAG}-stranger-approve` } }
    );
    record('An unrelated stranger cannot approve/release the milestone', strangerApprove.status === 403, `got ${strangerApprove.status}`);

    // ── Security fix #2: disputeMilestone party check ────────────────────
    const strangerDispute = await strangerClient.post(`/projects/${projectId}/milestones/${milestoneId}/dispute`, { reason: 'x' });
    record('An unrelated stranger cannot raise a dispute on this project', strangerDispute.status === 403, `got ${strangerDispute.status}`);

    // ── Request corrections — the new, third, lighter-weight action ──────
    const contractorRequestChanges = await contractorClient.post(`/projects/${projectId}/milestones/${milestoneId}/request-changes`, { reason: 'x' });
    record('Only the project owner may request changes, not the contractor', contractorRequestChanges.status === 403, `got ${contractorRequestChanges.status}`);

    const requestChanges = await funderClient.post(`/projects/${projectId}/milestones/${milestoneId}/request-changes`, { reason: 'Photo is blurry, please retake in daylight' });
    record('Funder can request corrections', requestChanges.status === 200, `status=${requestChanges.status}`);
    const afterRequest = requestChanges.data.data.milestones.find((m) => m._id === milestoneId);
    record('Milestone goes back to pending, not disputed', afterRequest.status === 'pending');
    record('Change request reason is recorded', afterRequest.changeRequests.length === 1 && afterRequest.changeRequests[0].reason === 'Photo is blurry, please retake in daylight');
    record('Approvers are cleared on request-changes (no stale auto-release next round)', (afterRequest.approvers ?? []).length === 0);

    // Cannot request changes again while not under review.
    const requestChangesAgain = await funderClient.post(`/projects/${projectId}/milestones/${milestoneId}/request-changes`, { reason: 'y' });
    record('Cannot request changes on a milestone not currently under review', requestChangesAgain.status === 409, `got ${requestChangesAgain.status}`);

    // ── Resubmit → approve should release cleanly, no stale-approver bug ──
    await funderClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/fake-2.jpg' });
    const secondApproval = await funderClient.post(
      `/projects/${projectId}/milestones/${milestoneId}/approval`,
      { status: 'approved' },
      { headers: { 'Idempotency-Key': `${TAG}-second-approval` } }
    );
    record('Funder can approve after resubmission — real release happens', secondApproval.status === 200 && secondApproval.data.data.releasedEscrow != null, `status=${secondApproval.status}`);
    const releasedMilestone = secondApproval.data.data.project.milestones.find((m) => m._id === milestoneId);
    record('Milestone status is released', releasedMilestone.status === 'released');

    // ── The funder (the real party) CAN still dispute a different milestone ──
    const secondMilestoneId = weeklyMilestones[1]._id;
    await funderClient.post(`/projects/${projectId}/milestones/${secondMilestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/fake-3.jpg' });
    const realDispute = await funderClient.post(`/projects/${projectId}/milestones/${secondMilestoneId}/dispute`, { reason: 'Work does not match the milestone' });
    record('The real project owner can still raise a genuine dispute', realDispute.status === 201, `status=${realDispute.status}`);
    const disputeRecord = await Dispute.findById(realDispute.data.data._id).lean();
    record('Dispute is actually persisted with the right project/milestone', String(disputeRecord.projectId) === String(projectId) && String(disputeRecord.milestoneId) === String(secondMilestoneId));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    const { Escrow } = require('../models');
    await Dispute.deleteMany({ projectId: { $in: createdProjectIds } });
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await Bid.deleteMany({ projectId: { $in: createdProjectIds } });
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
