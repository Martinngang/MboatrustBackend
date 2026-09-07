// Real, end-to-end proof that the Feedback & Help System actually works
// against a running server: a user submits each of the four intake types
// (bug report / feedback / question / contact support) with real page
// context and a real attachment, an admin lists and filters them, replies,
// changes status, and the submitter sees that reply on their own ticket —
// plus the help-centre search path users hit before ever filing anything.
// Genuine HTTP requests (npm run dev). Safe to re-run: every fixture is
// tagged and deleted again at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, SupportTicket, HelpArticle } = require('../models');

const TAG = 'verify-support-script';
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

  try {
    const submitter = await User.create({
      fullName: `${TAG} Submitter`, email: `${TAG}-user-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-user-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(submitter._id);
    const admin = await User.create({
      fullName: `${TAG} Admin`, email: `${TAG}-admin-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-admin-${Date.now()}`, roles: [{ roleType: 'admin' }],
    });
    createdUserIds.push(admin._id);

    const userClient = asUser(submitter._id);
    const adminClient = asUser(admin._id);

    // ── 1. Help centre: search before filing ────────────────────────────
    const search = await userClient.get('/help-articles', { params: { q: 'escrow' } });
    record(
      'Help search returns real seeded articles',
      search.status === 200 && Array.isArray(search.data.data) && search.data.data.length > 0,
      `status=${search.status} hits=${search.data?.data?.length}`
    );
    const unpublishedLeak = (search.data?.data || []).some((a) => a.isPublished === false);
    record('Help search hides unpublished articles from non-admins', !unpublishedLeak);

    const byCategory = await userClient.get('/help-articles', { params: { category: 'payments_escrow' } });
    record(
      'Help articles filter by category',
      byCategory.status === 200 && byCategory.data.data.every((a) => a.category === 'payments_escrow'),
      `n=${byCategory.data?.data?.length}`
    );

    // ── 2. All four intake types submit and persist ─────────────────────
    const intakes = [
      { type: 'bug_report', category: 'projects_milestones', subject: `${TAG} bug`, description: 'Milestone proof upload spins forever.' },
      { type: 'feedback', category: 'other', subject: `${TAG} feedback`, description: 'Escrow timeline is clearer than my bank app.' },
      { type: 'question', category: 'verification_kyc', subject: `${TAG} question`, description: 'Which ID counts for enhanced KYC?' },
      { type: 'contact_support', category: 'payments_escrow', subject: `${TAG} contact`, description: 'A release is stuck pending since Tuesday.' },
    ];
    const createdTicketIds = [];
    for (const intake of intakes) {
      const res = await userClient.post('/support-tickets', intake);
      if (res.status === 201) createdTicketIds.push(res.data.data._id);
      record(`Submit ${intake.type}`, res.status === 201, `status=${res.status}`);
    }

    // ── 3. Contextual capture: the screen the user filed from ───────────
    const contextual = await userClient.post('/support-tickets', {
      type: 'bug_report',
      category: 'bids_contracts',
      subject: `${TAG} contextual`,
      description: 'Filed from a specific screen — context should ride along.',
      context: { platform: 'web', screen: '/funder/tender/123/bids', screenLabel: 'Tender bids', feature: 'bids', appVersion: '1.0.0' },
      attachments: [{ url: 'https://example.test/shot.png', type: 'image', mimeType: 'image/png', fileName: 'shot.png', sizeBytes: 2048 }],
    });
    createdTicketIds.push(contextual.data?.data?._id);
    const ctx = contextual.data?.data?.context;
    record(
      'Page context is stored with the submission',
      contextual.status === 201 && ctx?.screen === '/funder/tender/123/bids' && ctx?.screenLabel === 'Tender bids',
      `screen=${ctx?.screen}`
    );
    record(
      'Attachment metadata is stored with the submission',
      contextual.data?.data?.attachments?.[0]?.url === 'https://example.test/shot.png',
      `n=${contextual.data?.data?.attachments?.length}`
    );

    // ── 4. Privacy: a user only ever sees their own tickets ─────────────
    const otherUser = await User.create({
      fullName: `${TAG} Other`, email: `${TAG}-other-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-other-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    createdUserIds.push(otherUser._id);
    const otherList = await asUser(otherUser._id).get('/support-tickets');
    const leaked = (otherList.data?.data || []).some((t) => String(t.submittedBy?._id || t.submittedBy) === String(submitter._id));
    record("A user cannot see another user's tickets in the list", !leaked);
    const otherRead = await asUser(otherUser._id).get(`/support-tickets/${createdTicketIds[0]}`);
    record("A user cannot open another user's ticket by id", otherRead.status === 403, `status=${otherRead.status}`);

    // ── 5. Admin triage: see everything, filter, search ─────────────────
    const adminList = await adminClient.get('/support-tickets');
    const adminSeesSubmitters = (adminList.data?.data || []).some((t) => String(t.submittedBy?._id || t.submittedBy) === String(submitter._id));
    record('Admin sees tickets submitted by other users', adminList.status === 200 && adminSeesSubmitters);

    const filtered = await adminClient.get('/support-tickets', { params: { type: 'bug_report' } });
    record(
      'Admin can filter by type',
      filtered.status === 200 && filtered.data.data.every((t) => t.type === 'bug_report'),
      `n=${filtered.data?.data?.length}`
    );
    const searched = await adminClient.get('/support-tickets', { params: { search: `${TAG} contextual` } });
    record('Admin can search ticket text', searched.status === 200 && searched.data.data.length > 0, `n=${searched.data?.data?.length}`);

    // ── 6. Admin responds; submitter sees the reply ─────────────────────
    const target = createdTicketIds[0];
    const reply = await adminClient.post(`/support-tickets/${target}/responses`, { message: 'We reproduced this and a fix is going out today.' });
    record('Admin can reply on a ticket', reply.status === 200 || reply.status === 201, `status=${reply.status}`);

    const afterReply = await userClient.get(`/support-tickets/${target}`);
    const adminReply = (afterReply.data?.data?.responses || []).find((r) => r.isAdmin);
    record(
      'Submitter sees the admin reply on their own ticket',
      Boolean(adminReply) && adminReply.message.includes('fix is going out'),
      `responses=${afterReply.data?.data?.responses?.length}`
    );

    // ── 7. Status tracking through to resolution ────────────────────────
    const statusRes = await adminClient.patch(`/support-tickets/${target}/status`, { status: 'resolved', priority: 'high' });
    record('Admin can set status and priority', statusRes.status === 200, `status=${statusRes.status} -> ${statusRes.data?.data?.status}`);
    record('Resolving stamps resolvedAt', Boolean(statusRes.data?.data?.resolvedAt));

    const userStatusView = await userClient.get(`/support-tickets/${target}`);
    record('Submitter sees the updated status', userStatusView.data?.data?.status === 'resolved', `status=${userStatusView.data?.data?.status}`);

    // ── 7b. Triage ownership: claim, filter by queue, hand back ─────────
    const claimTarget = createdTicketIds[1];
    const claim = await adminClient.patch(`/support-tickets/${claimTarget}/assignee`, { assignedTo: String(admin._id) });
    record(
      'Admin can claim a ticket',
      claim.status === 200 && String(claim.data?.data?.assignedTo?._id || claim.data?.data?.assignedTo) === String(admin._id),
      `status=${claim.status}`
    );
    record('Claiming an open ticket starts work on it', claim.data?.data?.status === 'in_progress', `status=${claim.data?.data?.status}`);

    const mineQueue = await adminClient.get('/support-tickets', { params: { assignedTo: 'me' } });
    record(
      "The 'me' queue returns only this admin's tickets",
      mineQueue.status === 200 && mineQueue.data.data.every((t) => String(t.assignedTo?._id || t.assignedTo) === String(admin._id)),
      `n=${mineQueue.data?.data?.length}`
    );

    const unassignedQueue = await adminClient.get('/support-tickets', { params: { assignedTo: 'unassigned' } });
    const claimedLeakedIntoUnassigned = (unassignedQueue.data?.data || []).some((t) => String(t._id) === String(claimTarget));
    record("The 'unassigned' queue excludes a claimed ticket", unassignedQueue.status === 200 && !claimedLeakedIntoUnassigned);

    const priorityFiltered = await adminClient.get('/support-tickets', { params: { priority: 'high' } });
    record(
      'Admin can filter by priority',
      priorityFiltered.status === 200 && priorityFiltered.data.data.every((t) => t.priority === 'high'),
      `n=${priorityFiltered.data?.data?.length}`
    );

    const release = await adminClient.patch(`/support-tickets/${claimTarget}/assignee`, { assignedTo: null });
    record('Admin can hand a ticket back to the unassigned queue', release.status === 200 && !release.data?.data?.assignedTo, `status=${release.status}`);

    const badAssignee = await adminClient.patch(`/support-tickets/${claimTarget}/assignee`, { assignedTo: String(submitter._id) });
    record('A ticket cannot be assigned to a non-admin', badAssignee.status === 400, `status=${badAssignee.status}`);

    // ── 8. A non-admin must never be able to triage ─────────────────────
    const forbiddenStatus = await userClient.patch(`/support-tickets/${target}/status`, { status: 'closed' });
    record('A non-admin cannot change ticket status', forbiddenStatus.status === 403, `status=${forbiddenStatus.status}`);
    const forbiddenArticle = await userClient.post('/help-articles', { question: 'x', answer: 'y', category: 'other' });
    record('A non-admin cannot publish help articles', forbiddenArticle.status === 403, `status=${forbiddenArticle.status}`);
    const forbiddenAssign = await userClient.patch(`/support-tickets/${createdTicketIds[0]}/assignee`, { assignedTo: null });
    record('A non-admin cannot assign tickets', forbiddenAssign.status === 403, `status=${forbiddenAssign.status}`);

    // A submitter must never be able to see or filter by the triage queue.
    const submitterPriorityProbe = await userClient.get('/support-tickets', { params: { priority: 'urgent' } });
    const ownTickets = (submitterPriorityProbe.data?.data || []).every((t) => String(t.submittedBy?._id || t.submittedBy) === String(submitter._id));
    record('Triage filters never widen a submitter’s own list', submitterPriorityProbe.status === 200 && ownTickets);

    // ── 9. Validation rejects junk rather than storing it ───────────────
    const badType = await userClient.post('/support-tickets', { type: 'not_a_type', subject: 'x', description: 'y' });
    record('Invalid ticket type is rejected', badType.status === 400, `status=${badType.status}`);
    const missingDesc = await userClient.post('/support-tickets', { type: 'feedback', subject: 'only a subject' });
    record('Missing description is rejected', missingDesc.status === 400, `status=${missingDesc.status}`);
  } finally {
    await SupportTicket.deleteMany({ subject: new RegExp(TAG) });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');

    const passed = results.filter((r) => r.passed).length;
    console.log(`\n${passed}/${results.length} checks passed.`);
    await mongoose.disconnect();
    process.exit(passed === results.length ? 0 : 1);
  }
}

run().catch(async (err) => {
  console.error('Fatal:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
