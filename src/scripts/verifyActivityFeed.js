// Real, end-to-end proof of the bug report this fixes: the "Activity Log"
// used to be a hardcoded client-side array every browser session booted up
// with identically, so every user — including one who just signed up —
// saw the exact same fake feed. This asserts the real replacement: a brand
// new user's feed is genuinely empty, a user with real activity sees
// exactly their own events (derived from real Project/Bid/LandListing/
// Escrow/Dispute documents, not a separate log), and a second, unrelated
// user never sees the first user's activity. Genuine HTTP requests against
// a running server (npm run dev). Safe to re-run any time — every fixture
// is tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, LandListing, Escrow, Dispute } = require('../models');

const TAG = 'verify-activity-feed-script';
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
  const createdProjectIds = [];
  const createdListingIds = [];
  const createdBidIds = [];
  const createdEscrowIds = [];
  const createdDisputeIds = [];

  try {
    // ── A brand-new user, zero history — must see an empty feed, not the
    // old shared fake seed data ─────────────────────────────────────────
    const newUser = await User.create({
      fullName: `${TAG} Brand New User`, email: `${TAG}-new-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-new-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(newUser._id);
    const newUserRes = await asUser(newUser._id).get('/activity/mine');
    record('Brand-new user gets a 200', newUserRes.status === 200, `status=${newUserRes.status}`);
    record('Brand-new user\'s feed is genuinely empty (no shared seed data)', Array.isArray(newUserRes.data?.data) && newUserRes.data.data.length === 0, `count=${newUserRes.data?.data?.length}`);

    // ── A user with real activity across every pillar ────────────────────
    const activeUser = await User.create({
      fullName: `${TAG} Active User`, email: `${TAG}-active-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-active-${Date.now()}`, roles: [{ roleType: 'funder' }, { roleType: 'contractor' }, { roleType: 'land_seller' }],
    });
    createdUserIds.push(activeUser._id);

    const otherOwner = await User.create({
      fullName: `${TAG} Other Owner`, email: `${TAG}-other-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(otherOwner._id);

    // A project they own, with one approved milestone (they approved it)
    // and evidence they personally submitted.
    const ownedProject = await Project.create({
      projectType: 'funding', ownerId: activeUser._id, title: `${TAG} owned project`, currency: 'XAF',
      totalAmount: 100000,
      milestones: [{
        name: 'Foundation', amount: 100000, orderIndex: 0, status: 'approved',
        evidence: [{ type: 'photo', fileUrl: 'https://example.com/e.jpg', submittedBy: activeUser._id }],
        approvers: [{ userId: activeUser._id, status: 'approved', decidedAt: new Date() }],
      }],
    });
    createdProjectIds.push(ownedProject._id);

    const fundEscrow = await Escrow.create({
      projectId: ownedProject._id, type: 'fund', grossAmount: 100000, netAmount: 100000,
      currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'collection', status: 'completed',
    });
    createdEscrowIds.push(fundEscrow._id);

    // A dispute they raised on someone else's project.
    const othersProject = await Project.create({
      projectType: 'funding', ownerId: otherOwner._id, title: `${TAG} others project`, currency: 'XAF',
      totalAmount: 50000, milestones: [{ name: 'M1', amount: 50000, orderIndex: 0 }],
    });
    createdProjectIds.push(othersProject._id);
    const dispute = await Dispute.create({ projectId: othersProject._id, raisedBy: activeUser._id, reason: `${TAG} test dispute reason` });
    createdDisputeIds.push(dispute._id);

    // A bid they placed on a tender.
    const tenderProject = await Project.create({
      projectType: 'tender', ownerId: otherOwner._id, title: `${TAG} tender project`, currency: 'XAF',
      totalAmount: 20000, milestones: [{ name: 'M1', amount: 20000, orderIndex: 0 }],
    });
    createdProjectIds.push(tenderProject._id);
    const bid = await Bid.create({ projectId: tenderProject._id, contractorId: activeUser._id, price: 18000, timelineDays: 10 });
    createdBidIds.push(bid._id);

    // A land listing they created.
    const listing = await LandListing.create({ title: `${TAG} listing`, sellerId: activeUser._id, sizeSqm: 500, price: 5000000 });
    createdListingIds.push(listing._id);

    const activeRes = await asUser(activeUser._id).get('/activity/mine');
    record('Active user gets a 200', activeRes.status === 200, `status=${activeRes.status}`);
    const types = (activeRes.data?.data ?? []).map((e) => e.type);
    record('Feed includes project_created', types.includes('project_created'));
    record('Feed includes project_funded', types.includes('project_funded'));
    record('Feed includes milestone_submitted', types.includes('milestone_submitted'));
    record('Feed includes milestone_approved', types.includes('milestone_approved'));
    record('Feed includes milestone_disputed', types.includes('milestone_disputed'));
    record('Feed includes bid_placed', types.includes('bid_placed'));
    record('Feed includes listing_created', types.includes('listing_created'));

    const approvedEvent = (activeRes.data?.data ?? []).find((e) => e.type === 'milestone_approved');
    record('milestone_approved carries the real raw amount (not pre-formatted)', approvedEvent?.amount === 100000);

    const isSortedDesc = (activeRes.data?.data ?? []).every((e, i, arr) => i === 0 || new Date(arr[i - 1].createdAt) >= new Date(e.createdAt));
    record('Feed is sorted most-recent-first', isSortedDesc);

    // ── The critical scoping assertion: a second, unrelated user never
    // sees the active user's activity — this is the exact bug reported.
    // otherOwner legitimately owns othersProject/tenderProject (so their
    // OWN project_created events are expected), but nothing that belongs
    // specifically to activeUser (their bid, their dispute, their own
    // separate owned project) may ever show up here. ──────────────────
    const otherOwnerRes = await asUser(otherOwner._id).get('/activity/mine');
    const otherOwnerEvents = otherOwnerRes.data?.data ?? [];
    record('otherOwner never sees activeUser\'s bid', !otherOwnerEvents.some((e) => e.type === 'bid_placed'));
    record('otherOwner never sees activeUser\'s dispute', !otherOwnerEvents.some((e) => e.type === 'milestone_disputed'));
    record('otherOwner never sees activeUser\'s owned project', !otherOwnerEvents.some((e) => e.projectTitle === ownedProject.title));

    const stillEmptyNewUser = await asUser(newUser._id).get('/activity/mine');
    record('The brand-new user still sees nothing after another user became very active', stillEmptyNewUser.data.data.length === 0);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Escrow.deleteMany({ _id: { $in: createdEscrowIds } });
    await Dispute.deleteMany({ _id: { $in: createdDisputeIds } });
    await Bid.deleteMany({ _id: { $in: createdBidIds } });
    await LandListing.deleteMany({ _id: { $in: createdListingIds } });
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
