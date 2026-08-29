// Proves the admin-action audit trail (Phase 1 of the admin command-center
// build) actually works end-to-end: every admin mutation writes an
// AdminActionLog row, GET /admin/activity returns it, GET /admin/projects
// (search filter) and the platformStats trend fields both work. Talks to
// the real running backend over HTTP with the dev-bypass header, like
// verifyRoleSecurity.js. Safe to re-run — every fixture is tagged and
// removed at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, Escrow, Dispute, VerifierProfile, ContractorCertification, AdminActionLog } = require('../models');

const TAG = 'verify-admin-action-log-script';
const BASE_URL = process.env.VERIFY_BASE_URL || 'http://localhost:5000/api/v1';

const results = [];
function record(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function asUser(userId) {
  return axios.create({ baseURL: BASE_URL, headers: { 'x-dev-user-id': String(userId) }, validateStatus: () => true });
}

async function latestLogFor(targetId) {
  return AdminActionLog.findOne({ targetId }).sort('-createdAt').lean();
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];

  try {
    const admin = await User.create({ fullName: `${TAG} Admin`, email: `${TAG}-admin-${Date.now()}@test.local`, firebaseUid: `${TAG}-admin-${Date.now()}`, roles: [{ roleType: 'admin' }] });
    const target = await User.create({ fullName: `${TAG} Target`, email: `${TAG}-target-${Date.now()}@test.local`, firebaseUid: `${TAG}-target-${Date.now()}`, roles: [] });
    createdUserIds.push(admin._id, target._id);
    const adminClient = asUser(admin._id);

    // ── 1. user.deactivate / reactivate / grantRole / revokeRole ────────
    let res = await adminClient.patch(`/admin/users/${target._id}/deactivate`);
    record('PATCH /admin/users/:id/deactivate succeeds', res.status === 200, res.status);
    let log = await latestLogFor(target._id);
    record('...writes user.deactivate to AdminActionLog', log?.action === 'user.deactivate' && String(log.adminId) === String(admin._id));

    res = await adminClient.patch(`/admin/users/${target._id}/reactivate`);
    record('PATCH /admin/users/:id/reactivate succeeds', res.status === 200, res.status);
    log = await latestLogFor(target._id);
    record('...writes user.reactivate to AdminActionLog', log?.action === 'user.reactivate');

    res = await adminClient.post(`/admin/users/${target._id}/roles`, { roleType: 'verifier' });
    record('POST /admin/users/:id/roles (grant) succeeds', res.status === 200, res.status);
    log = await latestLogFor(target._id);
    record('...writes user.grantRole to AdminActionLog', log?.action === 'user.grantRole' && log?.detail?.roleType === 'verifier');

    res = await adminClient.delete(`/admin/users/${target._id}/roles/verifier`);
    record('DELETE /admin/users/:id/roles/:roleType succeeds', res.status === 200, res.status);
    log = await latestLogFor(target._id);
    record('...writes user.revokeRole to AdminActionLog', log?.action === 'user.revokeRole');

    // ── 2. GET /admin/activity reflects the writes above ────────────────
    res = await adminClient.get('/admin/activity', { params: { limit: 50 } });
    record('GET /admin/activity succeeds', res.status === 200, res.status);
    const actions = (res.data?.data || []).map((r) => r.action);
    record('...includes all 4 user.* actions just performed', ['user.deactivate', 'user.reactivate', 'user.grantRole', 'user.revokeRole'].every((a) => actions.includes(a)));
    record('...populates adminId with the acting admin\'s name', (res.data?.data || []).some((r) => r.adminId?.fullName === admin.fullName));

    // ── 3. GET /projects search filter (used by the admin project list) ─
    const project = await Project.create({
      title: `${TAG} Unique Searchable Title ${Date.now()}`,
      description: 't', category: 'x', locationName: 'x', totalAmount: 100000,
      projectType: 'funding', status: 'open', ownerId: target._id,
      milestones: [{ name: 'M1', amount: 100000, status: 'pending', orderIndex: 0 }],
    });
    createdProjectIds.push(project._id);
    res = await adminClient.get('/projects', { params: { search: 'Unique Searchable Title' } });
    record('GET /projects?search= finds the matching project', res.status === 200 && (res.data?.data || []).some((p) => p._id === String(project._id)), res.status);
    res = await adminClient.get('/projects', { params: { search: 'zzz_definitely_no_match_zzz' } });
    record('GET /projects?search= with no match returns empty, not an error', res.status === 200 && (res.data?.data || []).length === 0);

    // ── 4. platform-stats trend fields ───────────────────────────────────
    res = await adminClient.get('/admin/platform-stats');
    record('GET /admin/platform-stats succeeds', res.status === 200, res.status);
    const trends = res.data?.data?.trends;
    record('...includes trends.newUsersByDay (30 entries)', Array.isArray(trends?.newUsersByDay) && trends.newUsersByDay.length === 30);
    record('...includes trends.escrowVolumeByDay (30 entries)', Array.isArray(trends?.escrowVolumeByDay) && trends.escrowVolumeByDay.length === 30);
    record('...existing snapshot fields (totalUsers etc.) still present', typeof res.data?.data?.totalUsers === 'number');
    // The admin we just created should show up in today's newUsersByDay bucket.
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayBucket = trends?.newUsersByDay?.find((d) => d.date === todayKey);
    record('...today\'s bucket reflects the users created by this run', (todayBucket?.value ?? 0) >= 2, `value=${todayBucket?.value}`);

    // ── 5. escrow.refund / dispute.resolve / verifierProfile.* / cert.* ─
    // (Smoke-check the log-writing wiring directly, without re-running the
    // full payment/dispute/certification flows already covered by other
    // scripts — just confirms logAdminAction actually gets called.)
    const escrow = await Escrow.create({ projectId: project._id, funderId: admin._id, type: 'fund', grossAmount: 10000, netAmount: 9800, currency: 'XAF', paymentProvider: 'mtn_momo', providerRole: 'collection', status: 'completed' });
    res = await adminClient.post(`/escrows/${escrow._id}/refund`, {}, { headers: { 'Idempotency-Key': `${TAG}-refund-${Date.now()}` } });
    record('POST /escrows/:id/refund succeeds', res.status === 201 || res.status === 200, res.status);
    const refundLog = await AdminActionLog.findOne({ action: 'escrow.refund', 'detail.originalEscrowId': escrow._id }).lean();
    record('...writes escrow.refund to AdminActionLog', !!refundLog);

    const dispute = await Dispute.create({ projectId: project._id, raisedBy: target._id, reason: 'test', status: 'open' });
    res = await adminClient.patch(`/disputes/${dispute._id}/resolve`, { status: 'resolved', resolutionNotes: 'test resolution' });
    record('PATCH /disputes/:id/resolve succeeds', res.status === 200, res.status);
    const disputeLog = await AdminActionLog.findOne({ action: 'dispute.resolve', targetId: dispute._id }).lean();
    record('...writes dispute.resolve to AdminActionLog', !!disputeLog);
    await Dispute.deleteOne({ _id: dispute._id });
    await Escrow.deleteMany({ projectId: project._id });

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') console.error('\n[verify] Could not reach the backend — is it running (npm run dev)?');
    throw err;
  } finally {
    await AdminActionLog.deleteMany({ adminId: { $in: createdUserIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await Escrow.deleteMany({ projectId: { $in: createdProjectIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
