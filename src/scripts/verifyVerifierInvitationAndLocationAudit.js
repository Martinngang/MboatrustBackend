// Real, end-to-end proof that (A) a funder can invite their own verifier by
// email/link — distinct from picking an already-approved verifier off the
// recommended list — and that accepting it grants ONLY the verifier role,
// never a VerifierProfile, never funder access; and (B) every location
// capture point resolves and persists a place name/address alongside the
// coordinates, and a verifier's confirmation preserves a full audit trail
// (who confirmed what, when, and what was there before). Genuine HTTP
// requests against a running server (npm run dev), including real Nominatim
// reverse/forward-geocode calls (no API key configured in this dev
// environment — same free fallback path verifyGeocoding.js already
// exercises). Safe to re-run any time — every fixture created here is
// deleted at the end, pass or fail.
const axios = require('axios');
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { User, Project, VerifierProfile, VerificationTask, VerifierInvitation, LandListing } = require('../models');

const TAG = 'verify-verifier-invitation-script';
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

const noAuth = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

function tokenFromInviteUrl(inviteUrl) {
  const match = /verifier-invite\/([0-9a-f]+)/i.exec(inviteUrl || '');
  return match?.[1] || null;
}

async function run() {
  await connectDB();
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdListingIds = [];
  const createdTaskIds = [];
  const createdInvitationIds = [];

  try {
    const owner = await User.create({
      fullName: `${TAG} Owner`, email: `${TAG}-owner-${Date.now()}@test.local`,
      // Also land_seller — this fixture is reused below to prove a land
      // listing's location gets the same "always resolve a place name" and
      // audit treatment as a project's.
      firebaseUid: `${TAG}-owner-${Date.now()}`, roles: [{ roleType: 'funder' }, { roleType: 'land_seller' }],
    });
    const stranger = await User.create({
      fullName: `${TAG} Stranger`, email: `${TAG}-stranger-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-stranger-${Date.now()}`, roles: [{ roleType: 'funder' }],
    });
    // The invitee — deliberately created with NO roles at all, simulating a
    // real outside person who has never touched Mboa Trust before.
    const invitee = await User.create({
      fullName: `${TAG} Invitee`, email: `${TAG}-invitee-${Date.now()}@test.local`,
      firebaseUid: `${TAG}-invitee-${Date.now()}`, roles: [],
    });
    createdUserIds.push(owner._id, stranger._id, invitee._id);

    const ownerClient = asUser(owner._id);
    const strangerClient = asUser(stranger._id);
    const inviteeClient = asUser(invitee._id);

    // ── Project with no known exact location ───────────────────────────────
    const projectRes = await ownerClient.post('/projects', {
      projectType: 'tender',
      title: `${TAG} Project`,
      description: 'x',
      category: 'General',
      locationName: '',
      totalAmount: 100000,
      milestones: [{ name: 'Milestone 1', description: 'x', amount: 100000, orderIndex: 0 }],
    });
    const projectId = projectRes.data?.data?._id;
    createdProjectIds.push(projectId);
    record('Project created with no location — status=201', projectRes.status === 201, `status=${projectRes.status}`);
    record('Project.location is unset', projectRes.data?.data?.location?.lat == null);

    // ── A. Verifier invitation lifecycle ────────────────────────────────────
    const strangerInviteRes = await strangerClient.post(`/projects/${projectId}/verifier-invitations`, {
      email: 'not-mine@test.local',
    });
    record('An unrelated user cannot invite a verifier for someone else\'s project — got 403', strangerInviteRes.status === 403, `status=${strangerInviteRes.status}`);

    const inviteEmail = `${TAG}-invitee@test.local`;
    const inviteRes = await ownerClient.post(`/projects/${projectId}/verifier-invitations`, {
      email: inviteEmail,
      name: 'Test Invitee',
    });
    record('Owner can invite a verifier by email — status=201', inviteRes.status === 201, `status=${inviteRes.status}`);
    const invitation = inviteRes.data?.data?.invitation;
    const inviteUrl = inviteRes.data?.data?.inviteUrl;
    if (invitation?._id) createdInvitationIds.push(invitation._id);
    record('Response includes a real inviteUrl to share', typeof inviteUrl === 'string' && inviteUrl.includes('/#/verifier-invite/'));
    record('Invitation starts pending', invitation?.status === 'pending');
    const rawToken = tokenFromInviteUrl(inviteUrl);
    record('A raw token was extracted from the invite link', typeof rawToken === 'string' && rawToken.length >= 32);

    // ── Public preview (no auth) ───────────────────────────────────────────
    const previewRes = await noAuth.get(`/verifier-invitations/${rawToken}`);
    record('Public GET preview works with no auth — status=200', previewRes.status === 200, `status=${previewRes.status}`);
    record('Preview shows pending status', previewRes.data?.data?.status === 'pending');
    record('Preview shows the real project title', previewRes.data?.data?.projectTitle === projectRes.data?.data?.title);
    record('Preview shows the inviting funder\'s name', previewRes.data?.data?.funderName === owner.fullName);

    const badTokenPreview = await noAuth.get('/verifier-invitations/0000000000000000000000000000000000000000000000000000000000000000');
    record('An unknown token returns 404 on preview', badTokenPreview.status === 404, `status=${badTokenPreview.status}`);

    // ── Owner-only invitation listing ──────────────────────────────────────
    const listRes = await ownerClient.get(`/projects/${projectId}/verifier-invitations`);
    record('Owner can list invitations on their project — status=200', listRes.status === 200, `status=${listRes.status}`);
    record('The invitation just sent appears in the list', listRes.data?.data?.some((inv) => String(inv._id) === String(invitation._id)));
    const strangerListRes = await strangerClient.get(`/projects/${projectId}/verifier-invitations`);
    record('An unrelated user cannot list invitations on someone else\'s project — got 403', strangerListRes.status === 403, `status=${strangerListRes.status}`);

    // ── The inviting funder cannot accept their own invitation ────────────
    const selfAcceptRes = await ownerClient.post(`/verifier-invitations/${rawToken}/accept`);
    record('The inviting funder cannot accept their own invitation — got 403', selfAcceptRes.status === 403, `status=${selfAcceptRes.status}`);

    // ── Revoke lifecycle, on a SEPARATE invitation (this one is consumed below) ──
    const revokeTargetRes = await ownerClient.post(`/projects/${projectId}/verifier-invitations`, { email: 'revoke-me@test.local' });
    const revokeTarget = revokeTargetRes.data?.data?.invitation;
    if (revokeTarget?._id) createdInvitationIds.push(revokeTarget._id);
    const revokeTargetToken = tokenFromInviteUrl(revokeTargetRes.data?.data?.inviteUrl);
    const strangerRevokeRes = await strangerClient.post(`/projects/${projectId}/verifier-invitations/${revokeTarget._id}/revoke`);
    record('An unrelated user cannot revoke an invitation on someone else\'s project — got 403', strangerRevokeRes.status === 403, `status=${strangerRevokeRes.status}`);
    const revokeRes = await ownerClient.post(`/projects/${projectId}/verifier-invitations/${revokeTarget._id}/revoke`);
    record('Owner can revoke a pending invitation — status=200', revokeRes.status === 200, `status=${revokeRes.status}`);
    record('Revoked invitation status is "revoked"', revokeRes.data?.data?.status === 'revoked');
    const acceptRevokedRes = await inviteeClient.post(`/verifier-invitations/${revokeTargetToken}/accept`);
    record('A revoked invitation cannot be accepted — got 409', acceptRevokedRes.status === 409, `status=${acceptRevokedRes.status}`);
    const doubleRevokeRes = await ownerClient.post(`/projects/${projectId}/verifier-invitations/${revokeTarget._id}/revoke`);
    record('An already-revoked invitation cannot be revoked again — got 409', doubleRevokeRes.status === 409, `status=${doubleRevokeRes.status}`);

    // ── Expired invitation is auto-flipped and rejected ────────────────────
    const expiredInvitation = await VerifierInvitation.create({
      projectId,
      invitedByUserId: owner._id,
      email: 'expired@test.local',
      tokenHash: require('crypto').createHash('sha256').update('expired-raw-token-for-testing').digest('hex'),
      expiresAt: new Date(Date.now() - 1000),
    });
    createdInvitationIds.push(expiredInvitation._id);
    const expiredPreviewRes = await noAuth.get('/verifier-invitations/expired-raw-token-for-testing');
    record('An expired invitation\'s preview auto-flips to "expired"', expiredPreviewRes.data?.data?.status === 'expired');
    const expiredAcceptRes = await inviteeClient.post('/verifier-invitations/expired-raw-token-for-testing/accept');
    record('An expired invitation cannot be accepted — got 409', expiredAcceptRes.status === 409, `status=${expiredAcceptRes.status}`);

    // ── B. Real acceptance: only the verifier role, no VerifierProfile ─────
    const acceptRes = await inviteeClient.post(`/verifier-invitations/${rawToken}/accept`);
    record('Invitee can accept a valid, pending invitation — status=200', acceptRes.status === 200, `status=${acceptRes.status}`);
    const taskId = acceptRes.data?.data?.task?._id;
    if (taskId) createdTaskIds.push(taskId);
    record('Accepting returns a real VerificationTask scoped to project_location', acceptRes.data?.data?.task?.targetType === 'project_location');
    record('The task is assigned to the invitee, not the funder', String(acceptRes.data?.data?.task?.verifierId) === String(invitee._id));

    const inviteeAfterAccept = await User.findById(invitee._id);
    record('Accepting grants roleType:verifier', inviteeAfterAccept.roles.some((r) => r.roleType === 'verifier'));
    record('Accepting grants NOTHING else (no funder/admin role)', inviteeAfterAccept.roles.every((r) => r.roleType === 'verifier'));
    const inviteeProfile = await VerifierProfile.findOne({ userId: invitee._id });
    record('Accepting does NOT create a VerifierProfile — the invitee is invisible to every other project\'s recommendations', inviteeProfile === null);

    const ownerAccountAfter = await User.findById(owner._id);
    record(
      'The funder\'s own account/roles are never touched by the invite flow',
      ownerAccountAfter.roles.length === 2 && !ownerAccountAfter.roles.some((r) => r.roleType === 'verifier')
    );

    const afterAcceptProjectRes = await ownerClient.get(`/projects/${projectId}`);
    record('Project.locationVerificationStatus flips to requested', afterAcceptProjectRes.data?.data?.locationVerificationStatus === 'requested');

    // ── Cannot double-accept, cannot be accepted by yet another user ──────
    const doubleAcceptRes = await inviteeClient.post(`/verifier-invitations/${rawToken}/accept`);
    record('The same invitee cannot accept an already-accepted invitation again — got 409', doubleAcceptRes.status === 409, `status=${doubleAcceptRes.status}`);
    const otherAcceptRes = await strangerClient.post(`/verifier-invitations/${rawToken}/accept`);
    record('A different user cannot accept an already-accepted invitation — got 409', otherAcceptRes.status === 409, `status=${otherAcceptRes.status}`);

    // ── The invited verifier's task works unchanged through the existing
    // start/report endpoints, exactly like an admin-assigned one ──────────
    const startRes = await inviteeClient.post(`/verification-tasks/${taskId}/start`);
    record('The invited verifier can start their task — status=200', startRes.status === 200, `status=${startRes.status}`);

    const strangerReportRes = await strangerClient.post(`/verification-tasks/${taskId}/report`, { reportText: 'x', confirmedMatch: true });
    record('An unrelated user cannot submit a report on the invited verifier\'s task — got 403', strangerReportRes.status === 403, `status=${strangerReportRes.status}`);

    const CONFIRMED_LAT = 4.05;
    const CONFIRMED_LNG = 9.7;
    const reportRes = await inviteeClient.post(`/verification-tasks/${taskId}/report`, {
      reportText: 'Confirmed the site in person.',
      confirmedMatch: true,
      confirmedLocation: { lat: CONFIRMED_LAT, lng: CONFIRMED_LNG },
    });
    record('Invited verifier can submit a report with confirmedLocation — status=200', reportRes.status === 200, `status=${reportRes.status}`);

    // ── Location audit trail: what changed, who changed it, what was there before ──
    const afterConfirmProjectRes = await ownerClient.get(`/projects/${projectId}`);
    const confirmedProject = afterConfirmProjectRes.data?.data;
    record('Project.location is now the verifier-confirmed coordinates', confirmedProject?.location?.lat === CONFIRMED_LAT && confirmedProject?.location?.lng === CONFIRMED_LNG);
    record('Project.locationDetails.source is verifier_confirmed', confirmedProject?.locationDetails?.source === 'verifier_confirmed');
    record(
      'Project.locationDetails has a real resolved place name, not left blank',
      typeof confirmedProject?.locationDetails?.placeName === 'string' && confirmedProject.locationDetails.placeName.length > 0
    );
    record('Project.locationVerificationStatus flips to confirmed', confirmedProject?.locationVerificationStatus === 'confirmed');
    record(
      'Project.locationBeforeVerification preserves the ORIGINAL (unset) pre-verification value',
      confirmedProject?.locationBeforeVerification?.lat == null && confirmedProject?.locationBeforeVerification?.lng == null
    );

    const taskAfterReport = await VerificationTask.findById(taskId);
    record('VerificationTask.confirmedLocationDetails is populated (the audit record itself)', !!taskAfterReport.confirmedLocationDetails?.placeName);
    record('VerificationTask.confirmedLocationDetails.source is verifier_confirmed', taskAfterReport.confirmedLocationDetails?.source === 'verifier_confirmed');
    record('VerificationTask.verifierId identifies who confirmed it', String(taskAfterReport.verifierId) === String(invitee._id));

    // ── The funder is notified both of the acceptance and of the confirmation ──
    const { Notification } = require('../models');
    const acceptedNotif = await Notification.findOne({ userId: owner._id, type: 'verifier_invitation_accepted' });
    record('Funder is notified when their invited verifier accepts', !!acceptedNotif);
    const confirmedNotif = await Notification.findOne({ userId: owner._id, type: 'location_verified' });
    record('Funder is notified when the location is confirmed', !!confirmedNotif);

    // ── Universal "never store coordinates without a resolved name" checks ──
    // A manual PATCH with only {lat,lng} still gets locationDetails
    // auto-resolved server-side, even with no placeName/formattedAddress
    // supplied by the client.
    const manualPinRes = await ownerClient.patch(`/projects/${projectId}/location`, { location: { lat: 4.06, lng: 9.71 } });
    record('Manual pin correction — status=200', manualPinRes.status === 200, `status=${manualPinRes.status}`);
    record('Manual pin correction resolves locationDetails server-side', typeof manualPinRes.data?.data?.locationDetails?.placeName === 'string' && manualPinRes.data.data.locationDetails.placeName.length > 0);
    record('Manual pin correction defaults source to manual_pin', manualPinRes.data?.data?.locationDetails?.source === 'manual_pin');

    // Land listing: create with only city/region auto-geocodes locationDetails too.
    const listingRes = await ownerClient.post('/land-listings', {
      title: `${TAG} Listing`, region: 'Littoral', city: 'Douala', titleType: 'Land Certificate',
      description: 'x', sizeSqm: 500, price: 1000000,
    });
    const listingId = listingRes.data?.data?._id;
    createdListingIds.push(listingId);
    record('Land listing created from city/region — status=201', listingRes.status === 201, `status=${listingRes.status}`);
    record(
      'LandListing.locationDetails was resolved on auto-geocode',
      typeof listingRes.data?.data?.locationDetails?.placeName === 'string' && listingRes.data.data.locationDetails.placeName.length > 0
    );

    const listingPinRes = await ownerClient.patch(`/land-listings/${listingId}`, { location: { lat: 4.2, lng: 9.9 } });
    record('Land listing manual pin correction — status=200', listingPinRes.status === 200, `status=${listingPinRes.status}`);
    record(
      'Land listing manual pin correction resolves locationDetails too',
      typeof listingPinRes.data?.data?.locationDetails?.placeName === 'string' && listingPinRes.data.data.locationDetails.placeName.length > 0
    );

    console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checks passed.`);
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`\n[verify] Could not reach ${BASE_URL} — is the backend dev server running? (npm run dev)`);
    }
    throw err;
  } finally {
    await VerificationTask.deleteMany({ _id: { $in: createdTaskIds } });
    await VerifierInvitation.deleteMany({ _id: { $in: createdInvitationIds } });
    await Project.deleteMany({ _id: { $in: createdProjectIds } });
    await LandListing.deleteMany({ _id: { $in: createdListingIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log('\n[cleanup] all verification fixtures removed.');
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
