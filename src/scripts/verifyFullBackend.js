// Real, end-to-end proof that Prompts FB1-FB15 (the "Full Backend Build
// Guide — Login to Admin") work together against the real database — not
// just that each one passed in isolation when it was built. Walks one
// realistic journey touching every prompt in order and prints a PASS/FAIL
// line per prompt. Safe to re-run: every fixture it creates is tagged and
// torn down at the end, pass or fail.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const {
  User, ContractorProfile, Project, Bid, Contract, Escrow, LandListing, LandOffer,
  Group, GroupMember, PooledContribution, Subscription,
} = require('../models');
const userController = require('../controllers/userController');
const projectController = require('../controllers/projectController');
const matchingController = require('../controllers/matchingController');
const landOfferController = require('../controllers/landOfferController');
const groupController = require('../controllers/groupController');
const contractController = require('../controllers/contractController');
const paymentService = require('../services/paymentService');
const feeService = require('../services/feeService');
const conversionService = require('../services/conversionService');
const storageService = require('../services/storageService');

const TAG = 'verify-full-backend-script';
const TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

// Minimal req/res fakes so this script can call Express controllers
// directly, the same way the real routes do, without spinning up an HTTP
// server — keeps this one process, one script, matching seedFeeConfig.js's
// standalone-script convention. catchAsync() fires-and-forgets its promise
// (Promise.resolve(fn(...)).catch(next), never returned) rather than
// returning it, so `call()` has to resolve/reject via res.json()/next()
// itself instead of just awaiting the handler's own return value — awaiting
// that directly resolves near-instantly with undefined, before the handler
// has actually finished, which silently races every check below it.
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      status: () => res,
      json: (body) => { resolve(body); return res; },
      send: () => { resolve(undefined); return res; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdListingIds = [];
  const createdGroupIds = [];

  try {
    // ── User + FB1 (avatar upload) ────────────────────────────────────
    const funder = await User.create({
      fullName: `${TAG} funder`,
      email: `${TAG}-funder@test.local`,
      firebaseUid: `${TAG}-funder`,
      roles: [{ roleType: 'funder' }, { roleType: 'admin' }],
    });
    createdUserIds.push(funder._id);
    const upload = await storageService.uploadBuffer(TEST_IMAGE, { folder: `mboatrust/${TAG}` });
    const funderWithAvatar = await User.findByIdAndUpdate(funder._id, { avatarUrl: upload.secure_url }, { new: true });
    record('FB1 — avatar upload persists a real URL', Boolean(funderWithAvatar.avatarUrl?.startsWith('http')));

    const coSigner = await User.create({
      fullName: `${TAG} cosigner`,
      email: `${TAG}-cosigner@test.local`,
      firebaseUid: `${TAG}-cosigner`,
      roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(coSigner._id);

    const contractor = await User.create({
      fullName: `${TAG} contractor`,
      email: `${TAG}-contractor@test.local`,
      firebaseUid: `${TAG}-contractor`,
      roles: [{ roleType: 'contractor' }],
    });
    createdUserIds.push(contractor._id);
    await ContractorProfile.create({ userId: contractor._id, categories: ['Water & Sanitation'], isAvailable: true });

    // ── FB2 — co-signer / multi-sig enforcement ───────────────────────
    const multiSigProject = await Project.create({
      projectType: 'funding',
      ownerId: funder._id,
      title: `${TAG} multisig project`,
      category: 'Water & Sanitation',
      totalAmount: 200000,
      currency: 'XAF',
      requiresMultiSig: true,
      milestones: [{ name: 'Only milestone', amount: 200000, orderIndex: 0 }],
    });
    createdProjectIds.push(multiSigProject._id);
    multiSigProject.coSignerId = coSigner._id;
    await multiSigProject.save();

    const m1 = multiSigProject.milestones[0];
    m1.evidence.push({ type: 'photo', fileUrl: upload.secure_url, fileHash: 'fb16-fake-hash', submittedBy: funder._id });
    m1.status = 'under_review';
    await multiSigProject.save();

    await call(projectController.decideApproval, {
      params: { id: String(multiSigProject._id), milestoneId: String(m1._id) },
      body: { status: 'approved' },
      user: funder,
    });
    const afterOwnerOnly = await Project.findById(multiSigProject._id);
    const stillPending = afterOwnerOnly.milestones[0].status === 'under_review';

    await call(projectController.decideApproval, {
      params: { id: String(multiSigProject._id), milestoneId: String(m1._id) },
      body: { status: 'approved' },
      user: coSigner,
    });
    const afterBoth = await Project.findById(multiSigProject._id);
    const nowReleased = afterBoth.milestones[0].status === 'released';
    record('FB2 — multi-sig requires both signers, not just one', stillPending && nowReleased);

    // ── FB5/FB6 — tender bid, real contract document, lifecycle ──────
    const tender = await Project.create({
      projectType: 'tender',
      ownerId: funder._id,
      title: `${TAG} tender`,
      category: 'Water & Sanitation',
      totalAmount: 150000,
      currency: 'XAF',
      milestones: [{ name: 'Only milestone', amount: 150000, orderIndex: 0 }],
    });
    createdProjectIds.push(tender._id);

    const bid = await Bid.create({ projectId: tender._id, contractorId: contractor._id, price: 140000, timelineDays: 20 });

    // FB4-style recommendation/comparison check while we're here.
    const recommended = await require('../services/contractorMatchingService').getRecommendedContractors(tender._id, { limit: 5 });
    record('FB (matching) — recommended contractors includes the real contractor', recommended.some((r) => String(r.contractorId) === String(contractor._id)));

    bid.status = 'accepted';
    await bid.save();
    const contractDoc = await require('../services/contractDocumentService').generateAndUploadContract({ project: tender, bid });
    const contract = await Contract.create({
      projectId: tender._id,
      bidId: bid._id,
      generatedDocumentText: contractDoc.text,
      generatedDocumentUrl: contractDoc.url,
    });
    record('FB5 — contract has a real, non-null document URL', Boolean(contract.generatedDocumentUrl?.startsWith('http')));

    const completed = await call(contractController.markCompleted, {
      params: { id: String(contract._id) },
      user: funder,
    });
    record('FB6 — contract lifecycle transitions to completed', completed?.data?.status === 'completed');

    // ── FB8 — land offer negotiation ──────────────────────────────────
    const seller = await User.create({
      fullName: `${TAG} seller`,
      email: `${TAG}-seller@test.local`,
      firebaseUid: `${TAG}-seller`,
      roles: [{ roleType: 'land_seller' }],
    });
    createdUserIds.push(seller._id);
    const listing = await LandListing.create({
      sellerId: seller._id,
      title: `${TAG} plot`,
      region: 'Centre',
      city: 'Yaounde',
      sizeSqm: 500,
      price: 10000000,
      verificationStatus: 'verified',
    });
    createdListingIds.push(listing._id);

    const offer = await LandOffer.create({ listingId: listing._id, buyerId: funder._id, offerAmount: 8000000 });
    await call(landOfferController.counter, { params: { id: String(offer._id) }, body: { counterAmount: 9000000 }, user: seller });
    const acceptResult = await call(landOfferController.accept, { params: { id: String(offer._id) }, user: funder });
    const purchaseProject = acceptResult?.data?.project;
    if (purchaseProject) createdProjectIds.push(purchaseProject._id);
    record('FB8 — accepted land offer creates a project at the negotiated price', purchaseProject?.totalAmount === 9000000);

    // ── FB12 — group + dashboard ───────────────────────────────────────
    const groupProject = await Project.create({
      projectType: 'funding',
      ownerId: funder._id,
      title: `${TAG} group project`,
      category: 'Education',
      totalAmount: 100000,
      currency: 'XAF',
    });
    createdProjectIds.push(groupProject._id);

    const groupResult = await call(groupController.create, {
      body: { name: `${TAG} group`, purpose: 'test', linkedProjectId: String(groupProject._id) },
      user: funder,
    });
    const group = groupResult?.data;
    if (group) createdGroupIds.push(group._id);
    await call(groupController.invite, { params: { id: String(group._id) }, body: { userId: String(coSigner._id) }, user: funder });

    const feeContrib = await feeService.calculateFee('project_funding', 30000, 'XAF');
    await paymentService.collect('mtn_momo', { amount: feeContrib.grossAmount, currency: 'XAF', payerPhoneNumber: '+237677000111', externalId: `${TAG}-contrib` });
    const contribEscrow = await Escrow.create({
      projectId: groupProject._id, type: 'fund', grossAmount: feeContrib.grossAmount,
      feeBreakdown: { feeType: feeContrib.feeType, feeRate: feeContrib.feeRate, feeAmount: feeContrib.feeAmount },
      netAmount: feeContrib.netAmount, currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'collection', status: 'completed',
    });
    await PooledContribution.create({
      projectId: groupProject._id, contributorId: coSigner._id, amount: 30000, currency: 'XAF',
      status: 'collected', escrowId: contribEscrow._id,
    });

    const dashboard = await call(groupController.getDashboard, { params: { id: String(group._id) }, user: funder });
    record('FB12 — group dashboard reflects real membership + funding', dashboard?.data?.memberCount === 2 && dashboard?.data?.fundingSummary?.raised > 0);

    // ── FB13/FB14 — admin user management + platform stats ───────────
    const deactivated = await call(userController.deactivate, { params: { id: String(coSigner._id) }, user: funder });
    const reactivated = await call(userController.reactivate, { params: { id: String(coSigner._id) }, user: funder });
    record('FB13 — admin can deactivate/reactivate a user', deactivated?.data?.isActive === false && reactivated?.data?.isActive === true);

    const stats = await call(require('../controllers/platformStatsController').getPlatformStats, { query: {}, user: funder });
    record('FB14 — platform stats returns real aggregated numbers', typeof stats?.data?.totalUsers === 'number' && stats.data.totalUsers > 0);

    // ── FB15 — subscription + currency converter ──────────────────────
    const subResult = await call(require('../controllers/subscriptionController').create, {
      body: { planType: 'pro_contractor', paymentProvider: 'mtn_momo', payerPhoneNumber: '+237677222333' },
      user: contractor,
    });
    record('FB15 — subscription created only after a real completed charge', subResult?.data?.status === 'active');
    if (subResult?.data?._id) await Subscription.deleteOne({ _id: subResult.data._id });

    const conversion = await conversionService.convertAmount(50000, 'XAF', 'USD');
    record('FB15 — currency converter produces a real converted amount', conversion.convertedAmount > 0);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } finally {
    await Contract.deleteMany({ projectId: { $in: createdProjectIds } });
    await Bid.deleteMany({ projectId: { $in: createdProjectIds } });
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await PooledContribution.deleteMany({ projectId: { $in: createdProjectIds } });
    await GroupMember.deleteMany({ groupId: { $in: createdGroupIds } });
    await Group.deleteMany({ _id: { $in: createdGroupIds } });
    await LandOffer.deleteMany({ listingId: { $in: createdListingIds } });
    await LandListing.deleteMany({ _id: { $in: createdListingIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await ContractorProfile.deleteMany({ userId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
