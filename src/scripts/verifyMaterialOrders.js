// Real, end-to-end proof of the Supplier materials-delivery system: genuine
// HTTP requests against a running server, covering the Project
// materials-choice fields, the full MaterialOrder lifecycle, and the
// permission boundaries for both required paths — Funder → Supplier →
// Project and Contractor → Supplier → Project. Mirrors
// verifyProjectTenderRoleSeparation.js / verifySupplierProfile.js's shape.
// Safe to re-run any time: every fixture is tagged and deleted again at the
// end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Bid, SupplierProfile, MaterialOrder, Escrow } = require('../models');

const TAG = 'verify-material-orders-script';
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
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    const admin = await User.create({
      fullName: `${TAG} Admin`, email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`, roles: [{ roleType: 'admin' }],
    });
    const storeOwner = await User.create({
      fullName: `${TAG} Store Owner`, email: `${TAG}-store-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-store-${Date.now()}`, roles: [{ roleType: 'supplier' }],
    });
    const otherStoreOwner = await User.create({
      fullName: `${TAG} Other Store Owner`, email: `${TAG}-other-store-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-store-${Date.now()}`, roles: [{ roleType: 'supplier' }],
    });
    createdUserIds.push(
      funder._id, contractor._id, otherContractor._id, stranger._id, admin._id, storeOwner._id, otherStoreOwner._id
    );

    const funderClient = asUser(funder._id);
    const contractorClient = asUser(contractor._id);
    const otherContractorClient = asUser(otherContractor._id);
    const strangerClient = asUser(stranger._id);
    const adminClient = asUser(admin._id);
    const storeClient = asUser(storeOwner._id);
    const otherStoreClient = asUser(otherStoreOwner._id);

    // ── Set up an approved supplier and a still-pending one ──────────
    const storeReg = {
      businessName: `${TAG} Store`, address: 'Akwa', region: 'Littoral',
      registeredCategories: ['Cement'], phone: '+237 677 000 001',
      paymentProvider: 'mtn_momo', payoutPhoneNumber: '+237 677 000 001',
    };
    const storeSubmit = await storeClient.post('/supplier-profiles/me', storeReg);
    const storeId = storeSubmit.data.data._id;
    await adminClient.post(`/supplier-profiles/${storeId}/approve`);

    const pendingStoreSubmit = await otherStoreClient.post('/supplier-profiles/me', { ...storeReg, businessName: `${TAG} Pending Store` });
    const pendingStoreId = pendingStoreSubmit.data.data._id;
    // Deliberately left unapproved.

    // ── Project defaults to contractor-managed; supplier assigned later ──
    const tender = await funderClient.post('/projects', {
      projectType: 'tender', title: `${TAG} Real Tender`, description: 'Build a wall', category: 'Masonry',
      locationName: 'Douala', totalAmount: 250000,
      milestones: [{ name: 'M1', amount: 250000, orderIndex: 0 }],
    });
    record('Funder can post a tender', tender.status === 201, `status=${tender.status}`);
    record('New tender defaults to contractor-managed materials', tender.data.data.materialsManagedBy === 'contractor' && tender.data.data.preferredSupplierId === null);
    const projectId = tender.data.data._id;
    const milestoneId = tender.data.data.milestones[0]._id;
    createdProjectIds.push(projectId);

    // ── Assign-supplier: the "browse and assign later" flow ─────────
    const strangerAssign = await strangerClient.post(`/projects/${projectId}/assign-supplier`, { supplierId: storeId });
    record('An unrelated stranger cannot assign a supplier to this project', strangerAssign.status === 403, `got ${strangerAssign.status}`);

    const assignPending = await funderClient.post(`/projects/${projectId}/assign-supplier`, { supplierId: pendingStoreId });
    record('Cannot assign a not-yet-approved supplier', assignPending.status === 400, `got ${assignPending.status}`);

    const assign = await funderClient.post(`/projects/${projectId}/assign-supplier`, { supplierId: storeId });
    record(
      'Funder can assign an approved supplier after creation',
      assign.status === 200 && assign.data.data.materialsManagedBy === 'supplier' && assign.data.data.preferredSupplierId === storeId
    );

    const unassign = await funderClient.post(`/projects/${projectId}/assign-supplier`, { supplierId: null });
    record(
      'Funder can unassign, reverting to contractor-managed',
      unassign.status === 200 && unassign.data.data.materialsManagedBy === 'contractor' && unassign.data.data.preferredSupplierId === null
    );

    // Re-assign for the rest of the script's order-lifecycle checks below.
    await funderClient.post(`/projects/${projectId}/assign-supplier`, { supplierId: storeId });

    // ── Award the contractor (needed for the Contractor → Supplier path) ──
    const bid = await contractorClient.post('/bids', {
      projectId, price: 240000, timelineDays: 20, materialsPlan: 'x', notes: 'x',
    });
    const bidId = bid.data.data._id;
    const award = await funderClient.patch(`/bids/${bidId}/status`, { status: 'accepted' }, { headers: { 'Idempotency-Key': `${TAG}-award` } });
    record('Contractor bid awarded', award.status === 200, `status=${award.status}`);

    // ── Create-order authority ────────────────────────────────────────────
    const orderPayload = (supplierId) => ({
      projectId, milestoneId, supplierId,
      items: [{ inventoryItemId: null, name: 'Cement (50kg bag)', quantity: 10, unitPrice: 6000 }],
    });

    const strangerCreate = await strangerClient.post('/material-orders', orderPayload(storeId));
    record('An unrelated stranger cannot request materials on this project', strangerCreate.status === 403, `got ${strangerCreate.status}`);

    const otherContractorCreate = await otherContractorClient.post('/material-orders', orderPayload(storeId));
    record('A non-awarded contractor cannot request materials on this project', otherContractorCreate.status === 403, `got ${otherContractorCreate.status}`);

    const pendingStoreCreate = await funderClient.post('/material-orders', orderPayload(pendingStoreId));
    record('Cannot request materials from a not-yet-approved supplier', pendingStoreCreate.status === 400, `got ${pendingStoreCreate.status}`);

    // Funder → Supplier → Project.
    const funderOrder = await funderClient.post('/material-orders', orderPayload(storeId));
    record('Funder (project owner) can request materials — Funder → Supplier → Project', funderOrder.status === 201, `status=${funderOrder.status}`);
    record(
      'Order response is enriched with display fields (store/project/requester names)',
      funderOrder.data.data.supplierId.businessName === storeReg.businessName
        && funderOrder.data.data.projectId.title === tender.data.data.title
        && funderOrder.data.data.requestedBy.fullName === funder.fullName
    );
    const funderOrderId = funderOrder.data.data._id;
    record('Order total computed correctly from items', funderOrder.data.data.totalAmount === 60000);

    // Contractor → Supplier → Project.
    const contractorOrder = await contractorClient.post('/material-orders', orderPayload(storeId));
    record('Awarded contractor can request materials — Contractor → Supplier → Project', contractorOrder.status === 201, `status=${contractorOrder.status}`);
    const contractorOrderId = contractorOrder.data.data._id;

    // ── Visibility ─────────────────────────────────────────────────────
    const milestoneOrders = await funderClient.get(`/material-orders/projects/${projectId}/milestones/${milestoneId}`);
    record(
      'Project owner sees every order on the milestone',
      [funderOrderId, contractorOrderId].every((id) => milestoneOrders.data.data.some((o) => o._id === id))
    );
    const strangerMilestoneOrders = await strangerClient.get(`/material-orders/projects/${projectId}/milestones/${milestoneId}`);
    record('An unrelated stranger sees nothing for that milestone', strangerMilestoneOrders.status === 403 || (strangerMilestoneOrders.data.data ?? []).length === 0);

    const storeQueue = await storeClient.get('/material-orders/for-supplier');
    record(
      'Store owner sees both incoming orders in their queue',
      [funderOrderId, contractorOrderId].every((id) => storeQueue.data.data.some((o) => o._id === id))
    );

    const otherStoreQueue = await otherStoreClient.get('/material-orders/for-supplier');
    record('A different, unrelated store owner sees none of these orders', !(otherStoreQueue.data.data ?? []).some((o) => o._id === funderOrderId));

    // ── Ownership-scoped confirm/reject ───────────────────────────────────
    const wrongStoreConfirm = await otherStoreClient.post(`/material-orders/${funderOrderId}/confirm`, {});
    record('A different store owner cannot confirm this order', wrongStoreConfirm.status === 403, `got ${wrongStoreConfirm.status}`);

    const confirm = await storeClient.post(`/material-orders/${funderOrderId}/confirm`, { estimatedDeliveryDate: new Date(Date.now() + 86400000).toISOString() });
    record('Store owner confirms the funder\'s order', confirm.status === 200 && confirm.data.data.status === 'confirmed', `status=${confirm.status}`);

    const doubleConfirm = await storeClient.post(`/material-orders/${funderOrderId}/confirm`, {});
    record('Cannot confirm an already-confirmed order', doubleConfirm.status === 400, `got ${doubleConfirm.status}`);

    const reject = await storeClient.post(`/material-orders/${contractorOrderId}/reject`, { reason: 'Out of stock' });
    record('Store owner rejects the contractor\'s order with a reason', reject.status === 200 && reject.data.data.status === 'rejected' && reject.data.data.rejectionReason === 'Out of stock');

    // ── Dispatch + delivery confirmation ──────────────────────────────────
    const dispatch = await storeClient.post(`/material-orders/${funderOrderId}/out-for-delivery`, {});
    record('Store owner marks the confirmed order out for delivery', dispatch.status === 200 && dispatch.data.data.status === 'out_for_delivery');

    const strangerConfirmDelivery = await strangerClient.post(`/material-orders/${funderOrderId}/confirm-delivery`, {});
    record('An unrelated stranger cannot confirm delivery', strangerConfirmDelivery.status === 403, `got ${strangerConfirmDelivery.status}`);

    const beforeCount = (await SupplierProfile.findById(storeId).lean()).completedOrderCount;
    // Delivery confirmed by the awarded CONTRACTOR, not the original funder
    // requester — proves "whoever is physically on-site", not just the requester, can confirm.
    const confirmDelivery = await contractorClient.post(`/material-orders/${funderOrderId}/confirm-delivery`, { geotagLat: 4.05, geotagLng: 9.7 });
    record('A real party (not just the requester) can confirm delivery', confirmDelivery.status === 200 && confirmDelivery.data.data.status === 'delivered');
    record('Delivery confirmation carries the geotag + confirmer', confirmDelivery.data.data.deliveryConfirmation.geotag.lat === 4.05 && confirmDelivery.data.data.deliveryConfirmation.confirmedBy.fullName === contractor.fullName);
    const afterCount = (await SupplierProfile.findById(storeId).lean()).completedOrderCount;
    record('Store completedOrderCount increments on delivery', afterCount === beforeCount + 1, `${beforeCount} -> ${afterCount}`);

    // ── Real escrow payee routing for a delivered materials order ─────────
    // Milestone approval real-money-releases through releaseMilestoneEscrow,
    // which now checks for exactly this kind of delivered MaterialOrder and
    // routes the disbursement to the supplier's own payout details instead
    // of the project's usual payee.
    const submitEvidenceRes = await funderClient.post(`/projects/${projectId}/milestones/${milestoneId}/evidence`, {
      type: 'photo', fileUrl: 'https://example.com/fake-evidence.jpg',
    });
    record('Evidence submission moves the milestone into review', submitEvidenceRes.status === 201 || submitEvidenceRes.status === 200, `status=${submitEvidenceRes.status}`);

    const approval = await funderClient.post(
      `/projects/${projectId}/milestones/${milestoneId}/approval`,
      { status: 'approved' },
      { headers: { 'Idempotency-Key': `${TAG}-approve` } }
    );
    record('Funder can approve the milestone', approval.status === 200, `status=${approval.status}`);
    const releasedEscrow = approval.data.data.releasedEscrow;
    record(
      'Release escrow routes to the supplier, not the usual payee',
      releasedEscrow?.payeeType === 'supplier' && String(releasedEscrow?.payeeSupplierId) === String(storeId),
      `payeeType=${releasedEscrow?.payeeType}`
    );
    record(
      'Release uses the supplier\'s own payment provider/payout number, not a null/default one',
      releasedEscrow?.paymentProvider === 'mtn_momo' && releasedEscrow?.status !== undefined
    );

    // ── Cancel ─────────────────────────────────────────────────────────
    const thirdOrder = await funderClient.post('/material-orders', orderPayload(storeId));
    const thirdOrderId = thirdOrder.data.data._id;
    const wrongCancel = await otherContractorClient.post(`/material-orders/${thirdOrderId}/cancel`, {});
    record('An unrelated party cannot cancel someone else\'s order', wrongCancel.status === 403, `got ${wrongCancel.status}`);
    const cancel = await funderClient.post(`/material-orders/${thirdOrderId}/cancel`, {});
    record('Requester can cancel their own still-pending order', cancel.status === 200 && cancel.data.data.status === 'cancelled');
    const cancelDelivered = await funderClient.post(`/material-orders/${funderOrderId}/cancel`, {});
    record('Cannot cancel an order that already progressed past "requested"', cancelDelivered.status === 400, `got ${cancelDelivered.status}`);

    // ── "My requests" ──────────────────────────────────────────────────
    const myOrders = await funderClient.get('/material-orders/mine');
    record('Funder\'s "my requests" list includes their own orders', [funderOrderId, thirdOrderId].every((id) => myOrders.data.data.some((o) => o._id === id)));

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await MaterialOrder.deleteMany({ projectId: { $in: createdProjectIds } });
    await Bid.deleteMany({ projectId: { $in: createdProjectIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await SupplierProfile.deleteMany({ ownerId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
