// Real, end-to-end proof of the tender "Supplier required" option: a funder
// can post a tender as "no supplier", "I already have a Supplier" (explicit,
// approved supplier only) or "I need a Supplier" (nothing auto-assigned),
// the requirement and chosen supplier are stored and publicly visible to
// contractors, only the owner can change it, and the selected supplier is
// notified exactly once. Genuine HTTP requests against a running server
// (npm run dev). Safe to re-run — every fixture is deleted at the end.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, SupplierProfile, Notification } = require('../models');

const TAG = 'verify-supplier-requirement';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}
const asUser = (id) => axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(id) }, validateStatus: () => true });

async function run() {
  await connectDB();
  const userIds = [];
  const projectIds = [];
  const supplierIds = [];
  const t = Date.now();
  const mkUser = async (n, roles) => {
    const u = await User.create({ fullName: `${TAG} ${n}`, email: `${TAG}-${n}-${t}@test.local`, firebaseUid: `${TAG}-${n}-${t}`, roles: roles.map((roleType) => ({ roleType })) });
    userIds.push(u._id);
    return u;
  };

  try {
    const funder = await mkUser('funder', ['funder']);
    const stranger = await mkUser('stranger', ['funder']);
    const contractor = await mkUser('contractor', ['contractor']);
    const supplierOwner = await mkUser('supplier', ['supplier']);
    const pendingOwner = await mkUser('pending', ['supplier']);
    const approved = await SupplierProfile.create({ ownerId: supplierOwner._id, businessName: `${TAG} Quincaillerie`, region: 'Littoral', applicationStatus: 'approved' });
    const pending = await SupplierProfile.create({ ownerId: pendingOwner._id, businessName: `${TAG} Pending Co`, region: 'Centre', applicationStatus: 'pending' });
    supplierIds.push(approved._id, pending._id);

    const funderApi = asUser(funder._id);
    const contractorApi = asUser(contractor._id);
    const strangerApi = asUser(stranger._id);
    const base = { projectType: 'tender', title: `${TAG} tender`, description: 'x', category: 'General', totalAmount: 100000, milestones: [{ name: 'M1', description: 'x', amount: 100000, orderIndex: 0 }] };
    const create = async (extra) => {
      const r = await funderApi.post('/projects', { ...base, ...extra });
      if (r.data?.data?._id) projectIds.push(r.data.data._id);
      return r;
    };
    const notifCount = (userId) => Notification.countDocuments({ userId, type: 'supplier_selected_for_project' });

    // ── Default: no supplier required ──────────────────────────────────────
    const none = await create({});
    record('Tender with no supplier option is created — 201', none.status === 201, `status=${none.status}`);
    record('Defaults to supplierRequirement "none", contractor-managed, no supplier',
      none.data?.data?.supplierRequirement === 'none' && none.data.data.materialsManagedBy === 'contractor' && none.data.data.preferredSupplierId === null);

    // ── "I need a Supplier": flagged, nothing auto-assigned ───────────────
    const need = await create({ supplierRequirement: 'need_supplier' });
    record('"I need a Supplier" tender is created — 201', need.status === 201, `status=${need.status}`);
    record('Stored as need_supplier with NO supplier auto-assigned',
      need.data?.data?.supplierRequirement === 'need_supplier' && need.data.data.preferredSupplierId === null && need.data.data.supplier === null);
    record('A stray preferredSupplierId is ignored when "need_supplier" is chosen',
      (await create({ supplierRequirement: 'need_supplier', preferredSupplierId: String(approved._id) })).data?.data?.preferredSupplierId === null);
    record('Nobody was notified by a need_supplier tender', (await notifCount(supplierOwner._id)) === 0);

    const needId = need.data.data._id;
    const publicView = await contractorApi.get(`/projects/${needId}`);
    record('A contractor reviewing the tender sees supplierRequirement=need_supplier',
      publicView.status === 200 && publicView.data?.data?.supplierRequirement === 'need_supplier');
    const anonList = await axios.get(`${BASE_URL}/projects`, { params: { projectType: 'tender', limit: 100 }, validateStatus: () => true });
    const inList = anonList.data?.data?.find((p) => String(p._id) === String(needId));
    record('The public tender list also exposes supplierRequirement', inList?.supplierRequirement === 'need_supplier');

    // ── "I already have a Supplier" validation ────────────────────────────
    record('have_supplier without a supplier id is rejected — 400', (await funderApi.post('/projects', { ...base, supplierRequirement: 'have_supplier' })).status === 400);
    record('have_supplier with an unknown supplier is rejected — 404',
      (await funderApi.post('/projects', { ...base, supplierRequirement: 'have_supplier', preferredSupplierId: '000000000000000000000000' })).status === 404);
    record('have_supplier with a not-yet-approved supplier is rejected — 400',
      (await funderApi.post('/projects', { ...base, supplierRequirement: 'have_supplier', preferredSupplierId: String(pending._id) })).status === 400);

    // ── Explicit, approved supplier ───────────────────────────────────────
    const have = await create({ supplierRequirement: 'have_supplier', preferredSupplierId: String(approved._id) });
    record('"I already have a Supplier" tender is created — 201', have.status === 201, `status=${have.status}`);
    record('Stored as have_supplier, supplier-managed, with the chosen supplier id',
      have.data?.data?.supplierRequirement === 'have_supplier' && have.data.data.materialsManagedBy === 'supplier' && String(have.data.data.preferredSupplierId) === String(approved._id));
    record('Response carries the supplier\'s public summary (business name, region)',
      have.data?.data?.supplier?.businessName === approved.businessName && have.data.data.supplier.region === 'Littoral');
    const haveId = have.data.data._id;
    const contractorSees = await contractorApi.get(`/projects/${haveId}`);
    record('A contractor sees which supplier the funder chose', contractorSees.data?.data?.supplier?.businessName === approved.businessName);
    record('The selected supplier was notified exactly once', (await notifCount(supplierOwner._id)) === 1);
    record('The supplier summary never leaks the supplier owner\'s contact/user id',
      contractorSees.data?.data?.supplier && !('ownerId' in contractorSees.data.data.supplier) && !('phone' in contractorSees.data.data.supplier));

    // ── Permissions: contractors cannot post tenders at all ───────────────
    record('A contractor cannot post a tender (any supplier option) — 403',
      (await contractorApi.post('/projects', { ...base, supplierRequirement: 'need_supplier' })).status === 403);

    // ── Changing it later: owner only ─────────────────────────────────────
    record('An unrelated user cannot change the supplier requirement — 403',
      (await strangerApi.post(`/projects/${needId}/assign-supplier`, { supplierRequirement: 'none' })).status === 403);
    const assign = await funderApi.post(`/projects/${needId}/assign-supplier`, { supplierId: String(approved._id) });
    record('Owner can later select a supplier on a need_supplier tender — 200', assign.status === 200, `status=${assign.status}`);
    record('It flips to have_supplier and exposes the supplier',
      assign.data?.data?.supplierRequirement === 'have_supplier' && assign.data.data.supplier?.businessName === approved.businessName);
    record('Selecting the supplier on a second project notifies them again (new selection)', (await notifCount(supplierOwner._id)) === 2);
    await funderApi.post(`/projects/${needId}/assign-supplier`, { supplierId: String(approved._id) });
    record('Re-saving the SAME supplier does not re-notify', (await notifCount(supplierOwner._id)) === 2);
    const back = await funderApi.post(`/projects/${needId}/assign-supplier`, { supplierRequirement: 'need_supplier' });
    record('Owner can switch back to "I need a Supplier" — supplier cleared',
      back.data?.data?.supplierRequirement === 'need_supplier' && back.data.data.preferredSupplierId === null && back.data.data.materialsManagedBy === 'contractor');
    const cleared = await funderApi.post(`/projects/${needId}/assign-supplier`, { supplierId: null });
    record('Legacy { supplierId: null } still clears everything to "none"',
      cleared.data?.data?.supplierRequirement === 'none' && cleared.data.data.preferredSupplierId === null);
    record('Assigning a not-approved supplier is rejected — 400',
      (await funderApi.post(`/projects/${needId}/assign-supplier`, { supplierId: String(pending._id) })).status === 400);

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend running? (npm run dev)`);
    throw err;
  } finally {
    await Notification.deleteMany({ userId: { $in: userIds } });
    await Project.deleteMany({ _id: { $in: projectIds } });
    await SupplierProfile.deleteMany({ _id: { $in: supplierIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
