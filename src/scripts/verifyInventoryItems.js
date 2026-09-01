// Real, end-to-end proof that the redesigned inventory system works —
// genuine HTTP requests against a running server. Mirrors
// verifySupplierProfile.js's shape: tagged fixtures, cleaned up at the
// end whether the run passes or fails. Requires the backend dev server to
// be running (npm run dev).
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, SupplierProfile, InventoryItem } = require('../models');

const TAG = 'verify-inventory-items-script';
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
  const createdProfileIds = [];

  try {
    const owner = await User.create({
      fullName: `${TAG} Owner`, email: `${TAG}-owner-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-owner-${Date.now()}`, roles: [{ roleType: 'supplier' }],
    });
    const otherOwner = await User.create({
      fullName: `${TAG} Other Owner`, email: `${TAG}-other-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-${Date.now()}`, roles: [{ roleType: 'supplier' }],
    });
    const outsider = await User.create({
      fullName: `${TAG} Outsider`, email: `${TAG}-outsider-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-outsider-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(owner._id, otherOwner._id, outsider._id);

    const profile = await SupplierProfile.create({
      ownerId: owner._id, businessName: `${TAG} Store`, region: 'Littoral', address: 'Akwa', applicationStatus: 'approved',
    });
    const otherProfile = await SupplierProfile.create({
      ownerId: otherOwner._id, businessName: `${TAG} Other Store`, region: 'Centre', address: 'Bastos', applicationStatus: 'approved',
    });
    createdProfileIds.push(profile._id, otherProfile._id);

    const ownerClient = asUser(owner._id);
    const otherOwnerClient = asUser(otherOwner._id);
    const outsiderClient = asUser(outsider._id);

    // ── Create ─────────────────────────────────────────────────────────
    const create1 = await ownerClient.post('/inventory-items', {
      name: `${TAG} Cement 50kg`, category: 'Cement & Concrete', subcategory: 'Cement', unit: 'bag',
      price: 6200, quantityAvailable: 3, minStockLevel: 10, brand: 'Cimencam',
      sourcedFrom: { name: 'Cimencam Ltd', contact: '+237 600 000 000' },
      specifications: [{ key: 'Grade', value: '42.5N' }],
      dimensions: { weightKg: 50, unit: 'cm' },
      projectSuitability: ['Housing', 'Infrastructure'],
    });
    record('Owner can create a rich inventory item', create1.status === 201 && create1.data?.data?.name === `${TAG} Cement 50kg`, `status=${create1.status}`);
    record('Low-stock flag computed correctly on create (3 <= 10)', create1.data?.data?.isLowStock === true);
    const item1Id = create1.data.data._id;

    const create2 = await ownerClient.post('/inventory-items', {
      name: `${TAG} Roofing Sheet`, category: 'Roofing', unit: 'sheet', price: 3900, quantityAvailable: 100, minStockLevel: 10,
    });
    const item2Id = create2.data.data._id;
    record('Not low-stock when quantity well above minimum', create2.data?.data?.isLowStock === false);

    // ── Ownership enforcement ────────────────────────────────────────────
    const outsiderCreate = await outsiderClient.post('/inventory-items', { name: 'x', category: 'x', unit: 'x', price: 1 });
    record('A user with no supplier profile cannot create inventory', outsiderCreate.status === 400, `got ${outsiderCreate.status}`);

    const otherOwnerEdit = await otherOwnerClient.patch(`/inventory-items/${item1Id}`, { price: 1 });
    record("Another supplier owner cannot edit someone else's item", otherOwnerEdit.status === 403, `got ${otherOwnerEdit.status}`);

    // ── Read: mine (owner, all statuses) vs by-supplier (active only) ──
    const mine = await ownerClient.get('/inventory-items/mine');
    record('Owner sees both items in "mine"', mine.data?.data?.length === 2, `count=${mine.data?.data?.length}`);

    const byStore = await outsiderClient.get(`/inventory-items/by-supplier/${profile._id}`);
    record('Any authenticated user can browse the store\'s active catalogue', byStore.status === 200 && byStore.data?.data?.length === 2);

    // ── Search / filter / sort ───────────────────────────────────────────
    const searched = await ownerClient.get('/inventory-items/mine', { params: { search: 'Cement' } });
    record('Text search finds the matching item only', searched.data?.data?.length === 1 && searched.data.data[0]._id === item1Id);

    const filtered = await ownerClient.get('/inventory-items/mine', { params: { category: 'Roofing' } });
    record('Category filter narrows correctly', filtered.data?.data?.length === 1 && filtered.data.data[0]._id === item2Id);

    const lowStockOnly = await ownerClient.get('/inventory-items/mine', { params: { lowStockOnly: 'true' } });
    record('Low-stock filter returns only the understocked item', lowStockOnly.data?.data?.length === 1 && lowStockOnly.data.data[0]._id === item1Id);

    const sorted = await ownerClient.get('/inventory-items/mine', { params: { sortBy: 'price', sortDir: 'desc' } });
    record('Sort by price descending orders correctly', sorted.data?.data?.[0]._id === item1Id && sorted.data.data[1]._id === item2Id);

    // ── Get one ───────────────────────────────────────────────────────
    const getOne = await ownerClient.get(`/inventory-items/${item1Id}`);
    record('Owner can fetch a single item by id', getOne.status === 200 && getOne.data?.data?._id === item1Id);
    const otherOwnerGetOne = await otherOwnerClient.get(`/inventory-items/${item1Id}`);
    record("Another owner cannot fetch someone else's single item", otherOwnerGetOne.status === 403, `got ${otherOwnerGetOne.status}`);

    // ── Update ────────────────────────────────────────────────────────
    const updated = await ownerClient.patch(`/inventory-items/${item1Id}`, { quantityAvailable: 50 });
    record('Owner can update their own item', updated.status === 200 && updated.data?.data?.quantityAvailable === 50);
    record('isLowStock recomputes after update (50 > 10)', updated.data?.data?.isLowStock === false);

    // ── Duplicate ─────────────────────────────────────────────────────
    const dup = await ownerClient.post(`/inventory-items/${item1Id}/duplicate`);
    record('Duplicate creates a new item with "(Copy)" suffix', dup.status === 201 && dup.data?.data?.name === `${TAG} Cement 50kg (Copy)`);
    record('Duplicate starts at zero stock, not a copy of the original\'s count', dup.data?.data?.quantityAvailable === 0);
    const dupId = dup.data.data._id;

    // ── Archive / restore ─────────────────────────────────────────────
    const archived = await ownerClient.post(`/inventory-items/${dupId}/archive`);
    record('Owner can archive an item', archived.data?.data?.status === 'archived');

    const byStoreAfterArchive = await outsiderClient.get(`/inventory-items/by-supplier/${profile._id}`);
    record('Archived item no longer visible in the public store catalogue', !byStoreAfterArchive.data?.data?.some((i) => i._id === dupId));

    const mineAfterArchive = await ownerClient.get('/inventory-items/mine');
    record("Archived item still visible in the owner's own full list", mineAfterArchive.data?.data?.some((i) => i._id === dupId));

    const restored = await ownerClient.post(`/inventory-items/${dupId}/restore`);
    record('Owner can restore an archived item', restored.data?.data?.status === 'active');

    // ── Bulk actions ──────────────────────────────────────────────────
    const bulkArchive = await ownerClient.post('/inventory-items/bulk', { ids: [item1Id, item2Id], action: 'archive' });
    record('Bulk archive matches both items', bulkArchive.data?.data?.matched === 2, `matched=${bulkArchive.data?.data?.matched}`);

    const outsiderBulk = await otherOwnerClient.post('/inventory-items/bulk', { ids: [item1Id], action: 'delete' });
    record("Bulk action scoped to caller's own store — cannot touch another owner's items via id list", outsiderBulk.data?.data?.matched === 0);

    const stillExists = await InventoryItem.findById(item1Id).lean();
    record("Item survives another owner's bulk-delete attempt", stillExists !== null);

    const bulkDelete = await ownerClient.post('/inventory-items/bulk', { ids: [item1Id, item2Id, dupId], action: 'delete' });
    record('Bulk delete matches all three items', bulkDelete.data?.data?.matched === 3, `matched=${bulkDelete.data?.data?.matched}`);

    const mineAfterDelete = await ownerClient.get('/inventory-items/mine');
    record('All items gone after bulk delete', mineAfterDelete.data?.data?.length === 0);

    // ── Public feed (cost estimator) ────────────────────────────────────
    const active3 = await ownerClient.post('/inventory-items', { name: `${TAG} Public Item`, category: 'Cement & Concrete', unit: 'bag', price: 5000 });
    const publicFeed = await outsiderClient.get('/inventory-items/public');
    record('Public active feed includes a freshly created active item', publicFeed.data?.data?.some((i) => i._id === active3.data.data._id));
    await ownerClient.post('/inventory-items/bulk', { ids: [active3.data.data._id], action: 'delete' });

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await InventoryItem.deleteMany({ supplierId: { $in: createdProfileIds } });
    await SupplierProfile.deleteMany({ _id: { $in: createdProfileIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
