// Real, end-to-end proof of the funder/contractor role-separation fixes:
// genuine HTTP requests against a running server. Safe to re-run any time —
// every fixture is tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid } = require('../models');

const TAG = 'verify-role-separation-script';
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
    const otherContractor = await User.create({
      fullName: `${TAG} Other Contractor`, email: `${TAG}-other-contractor-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-contractor-${Date.now()}`, roles: [{ roleType: 'contractor' }],
    });
    const funderWhoIsAlsoContractor = await User.create({
      fullName: `${TAG} Dual Role`, email: `${TAG}-dual-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-dual-${Date.now()}`, roles: [{ roleType: 'funder' }, { roleType: 'contractor' }],
    });
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(funder._id, contractor._id, otherContractor._id, funderWhoIsAlsoContractor._id, stranger._id);

    const funderClient = asUser(funder._id);
    const contractorClient = asUser(contractor._id);
    const otherContractorClient = asUser(otherContractor._id);
    const dualClient = asUser(funderWhoIsAlsoContractor._id);
    const strangerClient = asUser(stranger._id);

    // ── Role-gated project creation ─────────────────────────────────────
    const tenderByContractor = await contractorClient.post('/projects', {
      projectType: 'tender', title: `${TAG} illegal tender`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 100000, milestones: [{ name: 'M1', amount: 100000, orderIndex: 0 }],
    });
    record('A contractor cannot post a tender', tenderByContractor.status === 403, `got ${tenderByContractor.status}`);

    const fundingByContractor = await contractorClient.post('/projects', {
      projectType: 'funding', title: `${TAG} illegal funding request`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 100000, milestones: [{ name: 'M1', amount: 100000, orderIndex: 0 }],
    });
    record('A contractor cannot create a funding-type project', fundingByContractor.status === 403, `got ${fundingByContractor.status}`);

    // ── The reported bug: funder posts a tender, must see it under their own list ──
    const tender = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Real Tender`, description: 'Build a wall', category: 'Masonry',
      locationName: 'Douala', totalAmount: 250000, milestones: [{ name: 'M1', amount: 250000, orderIndex: 0 }],
    });
    record('Funder can post a tender', tender.status === 201, `status=${tender.status}`);
    createdProjectIds.push(tender.data.data._id);

    const myTenders = await funderClient.get('/projects', { params: { projectType: 'tender', ownerId: funder._id } });
    record(
      'Newly posted tender immediately appears in the funder\'s own scoped list',
      myTenders.data?.data?.some((p) => p._id === tender.data.data._id)
    );

    // ── Self-bid prevention ──────────────────────────────────────────────
    const dualTender = await dualClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Dual-owned tender`, description: 'x', category: 'General',
      locationName: 'Douala', totalAmount: 100000, milestones: [{ name: 'M1', amount: 100000, orderIndex: 0 }],
    });
    createdProjectIds.push(dualTender.data.data._id);
    const selfBid = await dualClient.post('/bids', {
      projectId: dualTender.data.data._id, price: 90000, timelineDays: 20, materialsPlan: 'x', notes: 'x',
    });
    record('An account cannot bid on its own tender, even if it also holds the contractor role', selfBid.status === 400, `got ${selfBid.status}`);

    // A real, different contractor can bid on it normally.
    const legitBid = await contractorClient.post('/bids', {
      projectId: dualTender.data.data._id, price: 95000, timelineDays: 25, materialsPlan: 'Cement + labor', notes: 'Can start Monday',
    });
    record('A different contractor can bid on the same tender normally', legitBid.status === 201, `status=${legitBid.status}`);
    const bidId = legitBid.data.data._id;

    // ── Bid visibility (IDOR closed) ─────────────────────────────────────
    const noAuth = await axios.get(`${BASE_URL}/bids`, { params: { projectId: dualTender.data.data._id }, validateStatus: () => true });
    record('GET /bids requires authentication now (was previously wide open)', noAuth.status === 401, `got ${noAuth.status}`);

    const strangerList = await strangerClient.get('/bids', { params: { projectId: dualTender.data.data._id } });
    record('An unrelated funder cannot see bids on a tender they do not own', (strangerList.data?.data ?? []).length === 0, `got ${strangerList.data?.data?.length} rows`);

    const ownerList = await dualClient.get('/bids', { params: { projectId: dualTender.data.data._id } });
    record('The tender owner CAN see bids on their own tender', ownerList.data?.data?.some((b) => b._id === bidId));

    const otherContractorSelfList = await otherContractorClient.get('/bids', { params: { contractorId: contractor._id } });
    record('A different contractor cannot list another contractor\'s bids by contractorId', (otherContractorSelfList.data?.data ?? []).length === 0);

    const strangerGetOne = await strangerClient.get(`/bids/${bidId}`);
    record('An unrelated funder cannot fetch a single bid by id either', strangerGetOne.status === 403, `got ${strangerGetOne.status}`);

    const ownerGetOne = await dualClient.get(`/bids/${bidId}`);
    record('The tender owner can fetch that same bid by id', ownerGetOne.status === 200);

    const bidderGetOne = await contractorClient.get(`/bids/${bidId}`);
    record('The bidder themself can fetch their own bid by id', bidderGetOne.status === 200);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
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
