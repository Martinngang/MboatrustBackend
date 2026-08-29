// Real, end-to-end proof of the contractor payment negotiation system:
// genuine HTTP requests against a running server. Walks a full
// funder-proposes → contractor-counters → funder-counters →
// contractor-accepts round trip and confirms the FINAL negotiated numbers —
// not the funder's original ask — are what actually land on the project.
// Safe to re-run any time: every fixture is tagged and deleted again at the
// end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, Contract, Escrow } = require('../models');

const TAG = 'verify-bid-negotiation-script';
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
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    createdUserIds.push(funder._id, contractor._id, stranger._id);

    const funderClient = asUser(funder._id);
    const contractorClient = asUser(contractor._id);
    const strangerClient = asUser(stranger._id);

    // ── Funder posts the initial ask ──────────────────────────────────────
    const tender = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Tender`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 300000,
      milestones: [
        { name: 'Week 1', amount: 150000, orderIndex: 0 },
        { name: 'Week 2', amount: 150000, orderIndex: 1 },
      ],
    });
    const projectId = tender.data.data._id;
    createdProjectIds.push(projectId);

    // ── Contractor submits an opening proposal with its own schedule ─────
    const openingBid = await contractorClient.post('/bids', {
      projectId, price: 350000, timelineDays: 21, materialsPlan: 'x', notes: 'Needs more for materials',
      milestones: [
        { title: 'Week 1', description: 'Site prep', amount: 120000 },
        { title: 'Week 2', description: 'Core work', amount: 120000 },
        { title: 'Week 3', description: 'Finish + handover', amount: 110000 },
      ],
    });
    record('Contractor can open a negotiation with price + a real schedule', openingBid.status === 201, `status=${openingBid.status}`);
    const bidId = openingBid.data.data._id;
    record('Opening bid seeds rounds[0] from the contractor', openingBid.data.data.rounds.length === 1 && openingBid.data.data.rounds[0].proposedBy === 'contractor');
    record('lastProposedBy starts as contractor', openingBid.data.data.lastProposedBy === 'contractor');

    // ── Permission boundaries on counter ──────────────────────────────────
    const strangerCounter = await strangerClient.post(`/bids/${bidId}/counter`, { price: 300000, timelineDays: 21, milestones: [] });
    record('An unrelated stranger cannot counter this negotiation', strangerCounter.status === 403, `got ${strangerCounter.status}`);

    // ── Funder counters back with a lower price ───────────────────────────
    const funderCounter = await funderClient.post(`/bids/${bidId}/counter`, {
      price: 320000, timelineDays: 21, message: 'Can go to 320k, not 350k',
      milestones: [
        { title: 'Week 1', description: 'Site prep', amount: 160000 },
        { title: 'Week 2', description: 'Finish + handover', amount: 160000 },
      ],
    });
    record('Funder can counter', funderCounter.status === 200, `status=${funderCounter.status}`);
    record('lastProposedBy flips to funder', funderCounter.data.data.lastProposedBy === 'funder');
    record('rounds history grows (2 rounds now)', funderCounter.data.data.rounds.length === 2);
    record('Top-level price mirrors the latest round', funderCounter.data.data.price === 320000);

    // ── Contractor counters again ─────────────────────────────────────────
    const contractorCounter2 = await contractorClient.post(`/bids/${bidId}/counter`, {
      price: 335000, timelineDays: 18,
      milestones: [
        { title: 'Week 1', description: 'Site prep', amount: 170000 },
        { title: 'Week 2', description: 'Finish + handover', amount: 165000 },
      ],
    });
    record('Contractor can counter again (unlimited rounds, not strictly alternating)', contractorCounter2.status === 200 && contractorCounter2.data.data.rounds.length === 3);

    const cannotCounterFromStranger2 = await strangerClient.post(`/bids/${bidId}/counter`, { price: 1, timelineDays: 1, milestones: [] });
    record('Still blocked for a stranger after multiple rounds', cannotCounterFromStranger2.status === 403);

    // ── Funder accepts the current (contractor's latest) terms ──────────
    const accept = await funderClient.patch(`/bids/${bidId}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-accept` } });
    record('Funder can accept the negotiated terms', accept.status === 200, `status=${accept.status}`);
    record('Contract was created', Boolean(accept.data.data.contract?._id));

    const finalProject = await Project.findById(projectId).lean();
    record(
      'Project totalAmount is the FINAL negotiated price, not the funder\'s original ask',
      finalProject.totalAmount === 335000, `got ${finalProject.totalAmount}`
    );
    record(
      'Project milestones are the FINAL negotiated schedule, not the original 2-week ask',
      finalProject.milestones.length === 2 && finalProject.milestones[0].name === 'Week 1' && finalProject.milestones[0].amount === 170000
    );
    record('Project moved to in_progress', finalProject.status === 'in_progress');

    // ── Cannot act on a bid that's already decided ────────────────────────
    const counterAfterAccept = await contractorClient.post(`/bids/${bidId}/counter`, { price: 1, timelineDays: 1, milestones: [] });
    record('Cannot counter a bid that is already accepted', counterAfterAccept.status === 409, `got ${counterAfterAccept.status}`);

    // ── Funding-lock guard: cannot accept different terms once already funded ──
    const tender2 = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Tender 2`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 200000,
      milestones: [{ name: 'Only milestone', amount: 200000, orderIndex: 0 }],
    });
    const project2Id = tender2.data.data._id;
    createdProjectIds.push(project2Id);
    const bid2 = await contractorClient.post('/bids', { projectId: project2Id, price: 200000, timelineDays: 14, materialsPlan: 'x', notes: 'x', milestones: [] });
    const bid2Id = bid2.data.data._id;
    // Fund the project directly (bypassing the real payment provider call) —
    // this script only needs a real, completed 'fund' Escrow row to exist.
    await Escrow.create({
      projectId: project2Id, funderId: funder._id, type: 'fund', grossAmount: 200000, netAmount: 200000,
      currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'collection', status: 'completed',
    });
    const counterAfterFunding = await funderClient.post(`/bids/${bid2Id}/counter`, { price: 250000, timelineDays: 14, milestones: [] });
    record('Funder can still counter after funding (counter alone doesn\'t move money)', counterAfterFunding.status === 200);
    const acceptAfterFunding = await funderClient.patch(`/bids/${bid2Id}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-accept-2` } });
    record('Accepting DIFFERENT terms after real funding is blocked (409)', acceptAfterFunding.status === 409, `got ${acceptAfterFunding.status}`);

    // ── Regression: accepting a lump-sum (no-schedule) counter-offer must
    // rescale the project's EXISTING milestones to the new price, not leave
    // them summing to the old total — found via live browser testing, where
    // a contractor's schedule-less counter left milestones stuck at the
    // original ask's total while totalAmount moved to the negotiated price.
    const tender3 = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Tender 3`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 400000,
      milestones: [
        { name: 'Milestone 1', amount: 133333, orderIndex: 0 },
        { name: 'Milestone 2', amount: 133333, orderIndex: 1 },
        { name: 'Milestone 3', amount: 133334, orderIndex: 2 },
      ],
    });
    const project3Id = tender3.data.data._id;
    createdProjectIds.push(project3Id);
    const bid3 = await contractorClient.post('/bids', { projectId: project3Id, price: 350000, timelineDays: 42, materialsPlan: 'x', notes: 'x', milestones: [] });
    const bid3Id = bid3.data.data._id;
    const bid3Counter = await funderClient.post(`/bids/${bid3Id}/counter`, { price: 310000, timelineDays: 35, milestones: [] });
    record('Funder can counter a lump-sum bid with another lump-sum figure', bid3Counter.status === 200);
    const bid3Counter2 = await contractorClient.post(`/bids/${bid3Id}/counter`, { price: 325000, timelineDays: 35, milestones: [] });
    record('Contractor can counter back, still no schedule attached', bid3Counter2.status === 200);
    const accept3 = await funderClient.patch(`/bids/${bid3Id}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-accept-3` } });
    record('Funder can accept the final lump-sum terms', accept3.status === 200, `status=${accept3.status}`);
    const finalProject3 = await Project.findById(project3Id).lean();
    const milestoneSum3 = finalProject3.milestones.reduce((sum, m) => sum + m.amount, 0);
    record(
      'Project totalAmount reflects the final negotiated lump-sum price',
      finalProject3.totalAmount === 325000, `got ${finalProject3.totalAmount}`
    );
    record(
      'Existing milestones are rescaled to sum EXACTLY to the new total, not left at the old one',
      milestoneSum3 === 325000, `milestones sum to ${milestoneSum3}, expected 325000`
    );
    record(
      'Rescaled milestones keep the same count/structure (still 3 rows)',
      finalProject3.milestones.length === 3
    );

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await Contract.deleteMany({ projectId: { $in: createdProjectIds } });
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
