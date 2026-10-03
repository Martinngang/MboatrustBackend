// Real, end-to-end proof of staged / fund-as-you-go escrow funding, through
// genuine HTTP requests against a running server (mock payment providers
// complete synchronously): negotiation (with a funding mode) -> award ->
// partial funding -> funded-milestone gate -> work -> approval -> release ->
// next top-up, plus "Proceed Without Full Escrow" and full-upfront mode.
// Every fixture is tagged and deleted at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, Contract, Escrow, Notification, MilestoneRiskAcknowledgement } = require('../models');

const TAG = 'verify-staged-funding-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';
const PHONE = '+237670000000';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}
const near = (a, b, eps = 0.6) => Math.abs(a - b) <= eps;
let keyCounter = 0;
const idem = () => ({ headers: { 'Idempotency-Key': `${TAG}-${Date.now()}-${keyCounter++}` } });

function asUser(userId) {
  return axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(userId) }, validateStatus: () => true });
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];

  try {
    const mk = async (label, roleType) => {
      const u = await User.create({
        fullName: `${TAG} ${label}`, email: `${TAG}-${label}-${Date.now()}@test.local`,
        firebaseUid: `${TAG}-${label}-${Date.now()}`, roles: [{ roleType }],
      });
      createdUserIds.push(u._id);
      return u;
    };
    const funder = await mk('funder', 'funder');
    const contractor = await mk('contractor', 'contractor');
    const stranger = await mk('stranger', 'contractor');
    const admin = await mk('admin', 'admin');
    const F = asUser(funder._id);
    const C = asUser(contractor._id);
    const S = asUser(stranger._id);
    const A = asUser(admin._id);

    const summary = async (projectId) => (await F.get(`/projects/${projectId}/funding-summary`)).data.data;
    const fundNet = async (projectId, net) => {
      const quote = await F.get(`/projects/${projectId}/funding-quote`, { params: { netAmount: net } });
      const res = await F.post(`/projects/${projectId}/fund`, { amount: quote.data.data.grossAmount, paymentProvider: 'mtn_momo', payerPhoneNumber: PHONE }, idem());
      return { quote: quote.data.data, res };
    };
    const evidence = (client, projectId, milestoneId) =>
      client.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, { type: 'photo', fileUrl: 'https://example.com/proof.jpg', notes: 'proof' });

    // ── Negotiate a 20M contract with two 10M milestones ─────────────────
    const tender = await F.post('/projects', {
      projectType: 'tender', title: `${TAG} 20M tender`, description: 'x', category: 'General', locationName: 'Douala',
      totalAmount: 20000000,
      milestones: [{ name: 'Phase 1', amount: 10000000, orderIndex: 0 }, { name: 'Phase 2', amount: 10000000, orderIndex: 1 }],
    });
    const projectId = tender.data.data._id;
    createdProjectIds.push(projectId);

    const bid = await C.post('/bids', {
      projectId, price: 20000000, timelineDays: 60, materialsPlan: 'x', notes: 'opening', fundingMode: 'staged',
      milestones: [{ title: 'Phase 1', description: '', amount: 10000000 }, { title: 'Phase 2', description: '', amount: 10000000 }],
    });
    const bidId = bid.data.data._id;
    record('Contractor bid carries a funding mode on round 0', bid.status === 201 && bid.data.data.rounds[0].fundingMode === 'staged');

    const upfrontCounter = await F.post(`/bids/${bidId}/counter`, {
      price: 20000000, timelineDays: 60, fundingMode: 'full_upfront', message: 'fund it all first?',
      milestones: [{ title: 'Phase 1', description: '', amount: 10000000 }, { title: 'Phase 2', description: '', amount: 10000000 }],
    });
    record('Funder can counter proposing full upfront funding; bid mirrors the latest round',
      upfrontCounter.status === 200 && upfrontCounter.data.data.fundingMode === 'full_upfront' && upfrontCounter.data.data.rounds[1].fundingMode === 'full_upfront');
    const stagedCounter = await C.post(`/bids/${bidId}/counter`, {
      price: 20000000, timelineDays: 60, fundingMode: 'staged', message: 'staged please',
      milestones: [{ title: 'Phase 1', description: '', amount: 10000000 }, { title: 'Phase 2', description: '', amount: 10000000 }],
    });
    record('Contractor counters back to staged funding', stagedCounter.status === 200 && stagedCounter.data.data.fundingMode === 'staged');
    const omitted = await F.post(`/bids/${bidId}/counter`, {
      price: 20000000, timelineDays: 60, message: 'price unchanged, funding mode omitted',
      milestones: [{ title: 'Phase 1', description: '', amount: 10000000 }, { title: 'Phase 2', description: '', amount: 10000000 }],
    });
    record('Omitting fundingMode on a counter keeps the current mode', omitted.status === 200 && omitted.data.data.fundingMode === 'staged');

    const accept = await F.patch(`/bids/${bidId}/status`, { status: 'accepted' }, idem());
    record('Funder awards the contract', accept.status === 200, `status=${accept.status}`);
    const contract = accept.data.data.contract;
    record('Contract snapshots the agreed total, funding mode and milestone schedule',
      contract.totalAmount === 20000000 && contract.fundingMode === 'staged' && contract.milestoneSchedule.length === 2);
    record('Contract text states the funding terms', /Funding terms: STAGED/.test(contract.generatedDocumentText || ''));
    const project = await Project.findById(projectId).lean();
    record('Project records the negotiated funding mode', project.fundingMode === 'staged');
    const m1 = String(project.milestones[0]._id);
    const m2 = String(project.milestones[1]._id);

    // ── Nothing funded: four amounts are separate and correct ────────────
    let s = await summary(projectId);
    record('Summary: total 20M, funded 0, released 0, remaining 20M',
      s.totalContractValue === 20000000 && s.fundedAmount === 0 && s.releasedAmount === 0 && s.remainingToFund === 20000000);
    record('Both milestones start unfunded and the next to fund is Phase 1',
      s.milestones[0].fundingStatus === 'unfunded' && s.milestones[1].fundingStatus === 'unfunded' && s.nextMilestoneToFund.id === m1 && s.nextMilestoneToFund.shortfall === 10000000);

    // ── Contractor cannot work on an unfunded milestone ──────────────────
    const blocked = await evidence(C, projectId, m1);
    record('Evidence on an unfunded milestone is refused (409 MILESTONE_NOT_FUNDED)',
      blocked.status === 409 && blocked.data.error.details?.code === 'MILESTONE_NOT_FUNDED', `status=${blocked.status}`);

    // ── Funding cap + fee-on-top quote ───────────────────────────────────
    const over = await F.post(`/projects/${projectId}/fund`, { amount: 30000000, paymentProvider: 'mtn_momo', payerPhoneNumber: PHONE }, idem());
    record('Paying more than the remaining contract value is rejected (400)', over.status === 400 && over.data.error.details?.code === 'EXCEEDS_REMAINING_TO_FUND', `status=${over.status}`);
    const { quote, res: fund1 } = await fundNet(projectId, 10000000);
    record('Fee-on-top quote: gross > net and credits exactly the requested net', quote.grossAmount > 10000000 && near(quote.creditedNet, 10000000, 0.02), `gross=${quote.grossAmount}`);
    record('Funding the first 10M milestone succeeds', fund1.status === 201 && fund1.data.data.status === 'completed', `status=${fund1.status}`);

    s = await summary(projectId);
    record('Summary after partial funding: funded 10M, remaining 10M, released 0',
      near(s.fundedAmount, 10000000) && near(s.remainingToFund, 10000000) && s.releasedAmount === 0);
    record('Phase 1 is funded, Phase 2 still unfunded, next to fund is Phase 2',
      s.milestones[0].fundingStatus === 'funded' && s.milestones[1].fundingStatus === 'unfunded' && s.nextMilestoneToFund.id === m2);
    const notified = await Notification.findOne({ userId: contractor._id, type: 'milestone_funded' }).lean();
    record('Contractor was notified that Phase 1 is funded', Boolean(notified) && notified.payload.milestoneName === 'Phase 1');

    // ── Work on the funded milestone, approve, release ───────────────────
    const ev1 = await evidence(C, projectId, m1);
    record('Contractor can submit evidence on the funded milestone', ev1.status === 201, `status=${ev1.status}`);
    const approve1 = await F.post(`/projects/${projectId}/milestones/${m1}/approval`, { status: 'approved' }, idem());
    record('Funder approves; escrow releases Phase 1', approve1.status === 200 && Boolean(approve1.data.data.releasedEscrow) && approve1.data.data.awaitingFunds === false, `status=${approve1.status}`);
    s = await summary(projectId);
    record('Released 10M, escrow now empty, remaining still 10M',
      s.releasedAmount === 10000000 && near(s.inEscrow, 0) && near(s.remainingToFund, 10000000) && s.milestones[0].fundingStatus === 'released');
    const needed = await Notification.findOne({ userId: funder._id, type: 'funding_needed' }).lean();
    record('Funder was nudged to fund the next milestone', Boolean(needed) && needed.payload.milestoneName === 'Phase 2');

    // ── Next milestone is locked ─────────────────────────────────────────
    const blocked2 = await evidence(C, projectId, m2);
    record('Phase 2 evidence is refused until it is funded', blocked2.status === 409);

    // ── Proceed Without Full Escrow ──────────────────────────────────────
    const noAck = await C.post(`/projects/${projectId}/milestones/${m2}/proceed-at-risk`, {});
    record('Proceed-at-risk requires an explicit acknowledgement (400)', noAck.status === 400);
    const strangerAck = await S.post(`/projects/${projectId}/milestones/${m2}/proceed-at-risk`, { acknowledged: true });
    record('A stranger cannot proceed at risk (403)', strangerAck.status === 403, `got ${strangerAck.status}`);
    const funderAck = await F.post(`/projects/${projectId}/milestones/${m2}/proceed-at-risk`, { acknowledged: true });
    record('The funder cannot choose it for the contractor (403)', funderAck.status === 403, `got ${funderAck.status}`);
    const escrowsBefore = await Escrow.countDocuments({ projectId });
    const ack = await C.post(`/projects/${projectId}/milestones/${m2}/proceed-at-risk`, { acknowledged: true });
    record('Contractor acknowledges the risk and proceeds', ack.status === 201, `status=${ack.status}`);
    const ackDoc = await MilestoneRiskAcknowledgement.findOne({ milestoneId: m2 }).lean();
    record('Immutable audit record captures user, milestone and funded/unfunded amounts',
      Boolean(ackDoc) && String(ackDoc.contractorId) === String(contractor._id) && ackDoc.milestoneAmount === 10000000 && near(ackDoc.fundedAmount, 0) && near(ackDoc.unfundedAmount, 10000000) && /at my own financial risk/.test(ackDoc.statement) && Boolean(ackDoc.acknowledgedAt));
    record('Proceeding is NOT funding or release: no escrow rows created', (await Escrow.countDocuments({ projectId })) === escrowsBefore);
    s = await summary(projectId);
    record('Amounts stay separate: Phase 2 still unfunded, funded/released unchanged, flagged at-risk',
      s.milestones[1].fundingStatus === 'unfunded' && s.milestones[1].proceedAtRisk === true && near(s.fundedAmount, 10000000) && s.releasedAmount === 10000000);
    const riskNote = await Notification.findOne({ userId: funder._id, type: 'milestone_proceed_at_risk' }).lean();
    record('Funder was notified the contractor is proceeding without full escrow', Boolean(riskNote) && near(riskNote.payload.unfundedAmount, 10000000));
    const ackAgain = await C.post(`/projects/${projectId}/milestones/${m2}/proceed-at-risk`, { acknowledged: true });
    record('Acknowledging again is idempotent (one audit record)', ackAgain.status === 200 && (await MilestoneRiskAcknowledgement.countDocuments({ milestoneId: m2 })) === 1);
    const act = await F.get('/activity/mine');
    const actList = act.data.data || [];
    record('Activity feed shows the at-risk event to the funder', actList.some((e) => e.type === 'milestone_proceed_at_risk'));

    const ev2 = await evidence(C, projectId, m2);
    record('Contractor can now work on the unfunded milestone (at own risk)', ev2.status === 201, `status=${ev2.status}`);

    // ── Approval while escrow is short: approved, NOT released ───────────
    const approve2 = await F.post(`/projects/${projectId}/milestones/${m2}/approval`, { status: 'approved' }, idem());
    record('Funder approving an unfunded milestone does not release money',
      approve2.status === 200 && approve2.data.data.releasedEscrow === null && approve2.data.data.awaitingFunds === true, `status=${approve2.status}`);
    const p2 = await Project.findById(projectId).lean();
    record('Milestone is held as approved (awaiting funds); no release ledger row', p2.milestones[1].status === 'approved' && (await Escrow.countDocuments({ milestoneId: m2, type: 'release' })) === 0);
    const awaitNote = await Notification.findOne({ userId: contractor._id, type: 'milestone_awaiting_funds' }).lean();
    record('Contractor was told the milestone is approved but awaiting funding', Boolean(awaitNote));

    // ── Top-up settles the approved milestone automatically ──────────────
    const { res: fund2 } = await fundNet(projectId, 10000000);
    record('Funder tops up the remaining 10M', fund2.status === 201 && fund2.data.data.status === 'completed', `status=${fund2.status}`);
    s = await summary(projectId);
    const p3 = await Project.findById(projectId).lean();
    record('Top-up auto-releases the approved milestone', p3.milestones[1].status === 'released' && (await Escrow.countDocuments({ milestoneId: m2, type: 'release' })) === 1);
    record('Final summary: 20M total, 20M funded, 20M released, 0 remaining',
      s.totalContractValue === 20000000 && near(s.fundedAmount, 20000000) && s.releasedAmount === 20000000 && s.remainingToFund <= 0.6);
    record('Project completed once every milestone is released', p3.status === 'completed');
    const capFull = await F.post(`/projects/${projectId}/fund`, { amount: 1000, paymentProvider: 'mtn_momo', payerPhoneNumber: PHONE }, idem());
    record('A fully funded/completed contract accepts no further funding', capFull.status === 400 || capFull.status === 409, `got ${capFull.status}`);

    // ── Full upfront funding mode ────────────────────────────────────────
    const t2 = await F.post('/projects', {
      projectType: 'tender', title: `${TAG} upfront tender`, description: 'x', category: 'General', locationName: 'Douala',
      totalAmount: 2000000,
      milestones: [{ name: 'A', amount: 1000000, orderIndex: 0 }, { name: 'B', amount: 1000000, orderIndex: 1 }],
    });
    const p2Id = t2.data.data._id;
    createdProjectIds.push(p2Id);
    const bid2 = await C.post('/bids', {
      projectId: p2Id, price: 2000000, timelineDays: 30, materialsPlan: 'x', notes: 'x', fundingMode: 'full_upfront',
      milestones: [{ title: 'A', description: '', amount: 1000000 }, { title: 'B', description: '', amount: 1000000 }],
    });
    const accept2 = await F.patch(`/bids/${bid2.data.data._id}/status`, { status: 'accepted' }, idem());
    record('A full-upfront contract can be awarded and records its mode', accept2.status === 200 && accept2.data.data.contract.fundingMode === 'full_upfront');
    const up = await Project.findById(p2Id).lean();
    const upA = String(up.milestones[0]._id);
    await fundNet(p2Id, 1000000);
    s = await summary(p2Id);
    record('Full upfront: covering only the first milestone does not unlock it',
      s.fundingMode === 'full_upfront' && s.milestones[0].fundingStatus === 'partially_funded' && s.milestones[0].workable === false);
    const upBlocked = await evidence(C, p2Id, upA);
    record('Full upfront: evidence refused until the whole contract is funded', upBlocked.status === 409 && /full upfront/i.test(upBlocked.data.error.message));
    const { res: upFund2 } = await fundNet(p2Id, 1000000);
    const upOk = await evidence(C, p2Id, upA);
    record('Full upfront: fully funded unlocks work', upFund2.status === 201 && upOk.status === 201, `evidence=${upOk.status}`);

    // ── Refund keeps the numbers consistent ──────────────────────────────
    const lastFund = await Escrow.findById(upFund2.data.data._id).lean();
    const refund = await A.post(`/escrows/${lastFund._id}/refund`, {}, idem());
    record('Admin refund succeeds', refund.status === 201, `status=${refund.status}`);
    s = await summary(p2Id);
    record('After the refund, funded drops back to ~1M and the contract is no longer fully funded',
      near(s.fundedAmount, 1000000, 25000) && s.remainingToFund > 900000 && s.milestones[1].fundingStatus !== 'funded');

    // ── Legacy funding-lock: cannot accept terms BELOW what is funded ────
    const t3 = await F.post('/projects', {
      projectType: 'tender', title: `${TAG} lock tender`, description: 'x', category: 'General', locationName: 'Douala',
      totalAmount: 500000, milestones: [{ name: 'Only', amount: 500000, orderIndex: 0 }],
    });
    const p3Id = t3.data.data._id;
    createdProjectIds.push(p3Id);
    // Bid first — the first payment flips the tender to 'funded', which closes bidding.
    const cheap = await C.post('/bids', { projectId: p3Id, price: 300000, timelineDays: 10, materialsPlan: 'x', notes: 'x', milestones: [] });
    await fundNet(p3Id, 400000);
    const lowAccept = await F.patch(`/bids/${cheap.data.data._id}/status`, { status: 'accepted' }, idem());
    record('Accepting a price BELOW the already-funded amount is blocked (409)', lowAccept.status === 409, `got ${lowAccept.status}`);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend running?`);
    }
    throw err;
  } finally {
    await MilestoneRiskAcknowledgement.deleteMany({ projectId: { $in: createdProjectIds } });
    await Notification.deleteMany({ userId: { $in: createdUserIds } });
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
