// Real, end-to-end proof that hard-delete-my-account actually removes the
// right things and leaves other real users' data intact: the account and
// everything it solely owns is gone, a bid with a real accepted contract on
// someone ELSE's project survives (dangling contractorId, never deleted —
// deleting it would corrupt that other project owner's hire history), an
// escrow payout on someone else's project keeps its ledger row with
// contractorId nulled, a shared conversation loses only this participant
// (not the whole thread), and the literal-confirm validator actually gates
// the endpoint. Genuine HTTP requests against a running server (npm run
// dev). Safe to re-run any time — every fixture not itself deleted by the
// test is torn down at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const {
  User, Project, Bid, Escrow, Contract, ContractorProfile, Conversation, Message, Rating,
} = require('../models');

const TAG = 'verify-hard-delete-script';
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
  const createdEscrowIds = [];
  const createdBidIds = [];
  const createdContractIds = [];
  const createdConversationIds = [];

  try {
    const deleter = await User.create({
      fullName: `${TAG} Deleter`, email: `${TAG}-deleter-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-deleter-${Date.now()}`, roles: [{ roleType: 'funder' }, { roleType: 'contractor' }],
    });
    const otherOwner = await User.create({
      fullName: `${TAG} Other Owner`, email: `${TAG}-other-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(deleter._id, otherOwner._id);
    const deleterClient = asUser(deleter._id);

    // ── Fixture: something the deleter solely owns ────────────────────
    const contractorProfile = await ContractorProfile.create({ userId: deleter._id, categories: ['General'], isAvailable: true });
    const ownedProject = await Project.create({
      projectType: 'funding', ownerId: deleter._id, title: `${TAG} owned project`,
      totalAmount: 100000, milestones: [{ name: 'M1', amount: 100000, orderIndex: 0 }],
    });
    createdProjectIds.push(ownedProject._id);
    const ownedProjectEscrow = await Escrow.create({
      projectId: ownedProject._id, type: 'fund', grossAmount: 100000, netAmount: 100000,
      currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'collection', status: 'completed',
    });

    // ── Fixture: an accepted bid + contract on someone ELSE's project —
    // must survive with contractorId left dangling ─────────────────────
    const othersTenderProject = await Project.create({
      projectType: 'tender', ownerId: otherOwner._id, title: `${TAG} others tender`,
      totalAmount: 50000, milestones: [{ name: 'M1', amount: 50000, orderIndex: 0 }],
    });
    createdProjectIds.push(othersTenderProject._id);
    const acceptedBid = await Bid.create({ projectId: othersTenderProject._id, contractorId: deleter._id, price: 50000, timelineDays: 10, status: 'accepted' });
    createdBidIds.push(acceptedBid._id);
    const realContract = await Contract.create({ projectId: othersTenderProject._id, bidId: acceptedBid._id, status: 'active' });
    createdContractIds.push(realContract._id);

    // ── Fixture: an escrow payout to the deleter on someone else's project —
    // ledger row must survive, contractorId nulled ─────────────────────
    const payoutEscrow = await Escrow.create({
      projectId: othersTenderProject._id, contractorId: deleter._id, type: 'release',
      grossAmount: 50000, netAmount: 48000, currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'disbursement', status: 'completed',
    });
    createdEscrowIds.push(payoutEscrow._id);

    // ── Fixture: an unaccepted bid on someone else's project — safe to delete ──
    const unrelatedProject = await Project.create({
      projectType: 'tender', ownerId: otherOwner._id, title: `${TAG} unrelated tender`,
      totalAmount: 20000, milestones: [{ name: 'M1', amount: 20000, orderIndex: 0 }],
    });
    createdProjectIds.push(unrelatedProject._id);
    const unacceptedBid = await Bid.create({ projectId: unrelatedProject._id, contractorId: deleter._id, price: 20000, timelineDays: 5, status: 'submitted' });
    createdBidIds.push(unacceptedBid._id);

    // ── Fixture: a shared conversation with another real participant ────
    const conversation = await Conversation.create({ contextType: 'project', contextId: othersTenderProject._id, participantIds: [deleter._id, otherOwner._id] });
    createdConversationIds.push(conversation._id);
    await Message.create({ conversationId: conversation._id, senderId: deleter._id, body: 'hello' });

    // ── Fixture: a rating given by the deleter about the other owner ─────
    await Rating.create({ fromUserId: deleter._id, toUserId: otherOwner._id, projectId: othersTenderProject._id, score: 5, roleContext: 'contractor' });

    // ── Validator actually gates the endpoint ────────────────────────────
    const wrongConfirm = await deleterClient.delete('/users/me', { data: { confirm: 'nope' } });
    record('Wrong confirmation value is rejected (400)', wrongConfirm.status === 400, `status=${wrongConfirm.status}`);
    const noConfirm = await deleterClient.delete('/users/me', { data: {} });
    record('Missing confirmation is rejected (400)', noConfirm.status === 400, `status=${noConfirm.status}`);

    // ── The real deletion ─────────────────────────────────────────────────
    const res = await deleterClient.delete('/users/me', { data: { confirm: 'DELETE' } });
    record('Confirmed delete returns 200', res.status === 200 && res.data?.data?.deleted === true, `status=${res.status}`);

    const deletedUser = await User.findById(deleter._id).lean();
    record('User document is really gone', deletedUser === null);

    const deletedProfile = await ContractorProfile.findOne({ userId: deleter._id }).lean();
    record('Solely-owned ContractorProfile is gone', deletedProfile === null);

    const deletedOwnedProject = await Project.findById(ownedProject._id).lean();
    record('Project the deleter owned is gone', deletedOwnedProject === null);

    const deletedOwnedEscrow = await Escrow.findById(ownedProjectEscrow._id).lean();
    record("Owned project's own escrow is cascaded away", deletedOwnedEscrow === null);

    const survivingBid = await Bid.findById(acceptedBid._id).lean();
    record('Accepted bid with a real contract survives on the other owner\'s project', Boolean(survivingBid), `found=${Boolean(survivingBid)}`);
    record('Surviving bid has a dangling (untouched) contractorId, not deleted out from under the contract', String(survivingBid?.contractorId) === String(deleter._id));

    const survivingContract = await Contract.findById(realContract._id).lean();
    record('The real contract on the other owner\'s project survives untouched', Boolean(survivingContract) && survivingContract.status === 'active');

    const survivingOthersProject = await Project.findById(othersTenderProject._id).lean();
    record("The OTHER owner's tender project itself is completely untouched", Boolean(survivingOthersProject));

    const deletedUnacceptedBid = await Bid.findById(unacceptedBid._id).lean();
    record('An unaccepted bid on someone else\'s project is deleted (no contract to protect)', deletedUnacceptedBid === null);

    const survivingPayoutEscrow = await Escrow.findById(payoutEscrow._id).lean();
    record('A real payout escrow on someone else\'s project survives as a ledger row', Boolean(survivingPayoutEscrow));
    record('...but its contractorId is detached (nulled), not left pointing at a promise of a user that no longer exists in a way that would falsely resolve', survivingPayoutEscrow?.contractorId === null);

    const survivingConversation = await Conversation.findById(conversation._id).lean();
    record('A shared conversation survives with only the deleter removed', Boolean(survivingConversation) && survivingConversation.participantIds.length === 1 && String(survivingConversation.participantIds[0]) === String(otherOwner._id));

    const ratingsAbout = await Rating.find({ toUserId: otherOwner._id, projectId: othersTenderProject._id }).lean();
    record('A rating the deleter gave is removed along with them', ratingsAbout.length === 0);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Message.deleteMany({ conversationId: { $in: createdConversationIds } });
    await Conversation.deleteMany({ _id: { $in: createdConversationIds } });
    await Contract.deleteMany({ _id: { $in: createdContractIds } });
    await Bid.deleteMany({ _id: { $in: createdBidIds } });
    await Escrow.deleteMany({ _id: { $in: createdEscrowIds } });
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await Rating.deleteMany({ projectId: { $in: createdProjectIds } });
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
