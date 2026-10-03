const crypto = require('crypto');
const { Project, VerifierInvitation, VerificationTask } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { sendEmail } = require('../services/mailerService');
const { renderEmailHtml, webUrl, verifierInvitationEmailContent } = require('../utils/emailTemplates');

const INVITATION_TTL_DAYS = 7;

// Raw token only ever lives in the invite URL/email — this hash is the only
// thing persisted, same "never store the real secret" convention as
// password/API-key handling elsewhere in this codebase (see utils/crypto.js).
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function isOwnerOrAdmin(user, project) {
  const isAdmin = user.roles?.some((r) => r.roleType === 'admin');
  return isAdmin || String(project.ownerId) === String(user._id);
}

/** Auto-flips a pending invitation past its expiresAt to 'expired' on read —
 * so status is always accurate whether or not anything ever calls accept(). */
async function expireIfPastDue(invitation) {
  if (invitation.status === 'pending' && invitation.expiresAt.getTime() < Date.now()) {
    invitation.status = 'expired';
    await invitation.save();
  }
  return invitation;
}

/**
 * Funder-initiated invite for someone THEY already know to become the
 * verifier for THIS project's location-verification task — a narrow
 * alternative to projectController.requestLocationVerification, which only
 * accepts an already-approved verifier off the recommended list. See
 * models/VerifierInvitation.js for why accepting this never creates/approves
 * a VerifierProfile and never touches the funder's own account.
 */
const inviteVerifier = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).select('ownerId title locationName');
  if (!project) throw ApiError.notFound('Project not found');
  if (!isOwnerOrAdmin(req.user, project)) throw ApiError.forbidden();

  const rawToken = crypto.randomBytes(32).toString('hex');
  const invitation = await VerifierInvitation.create({
    projectId: project._id,
    invitedByUserId: req.user._id,
    email: req.body.email,
    name: req.body.name || '',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  // The web-only hash route (see App.tsx) — mobile's only role is to
  // generate and share this exact link, same as ReferralScreen.tsx already
  // does; acceptance itself never happens in the mobile app.
  const inviteUrl = webUrl(`/#/verifier-invite/${rawToken}`);

  // Sent directly, not via notificationService.notify() — the invitee has no
  // User document yet, so notify() (which requires an existing userId) can't
  // reach them.
  const content = verifierInvitationEmailContent({
    projectTitle: project.title,
    funderName: req.user.fullName,
    ctaUrl: inviteUrl,
  });
  await sendEmail(
    { to: req.body.email, subject: content.subject, html: renderEmailHtml(content) },
    {
      type: 'verifier_invitation_sent',
      relatedAction: 'verifierInvitation.create',
      relatedType: 'VerifierInvitation',
      relatedId: invitation._id,
    }
  );

  // The funder explicitly shares this link too (copy button / native share
  // sheet on mobile) — the email is a courtesy, not the only delivery path.
  return created(res, { invitation, inviteUrl });
});

/** Public — no auth. Lets the accept page render project/funder context
 * before or during signup, without leaking anything beyond what's needed to
 * decide whether to accept. */
const getInvitationPreview = catchAsync(async (req, res) => {
  let invitation = await VerifierInvitation.findOne({ tokenHash: hashToken(req.params.token) })
    .populate('projectId', 'title locationName')
    .populate('invitedByUserId', 'fullName');
  if (!invitation) throw ApiError.notFound('Invitation not found');
  invitation = await expireIfPastDue(invitation);

  return ok(res, {
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    projectTitle: invitation.projectId?.title || '',
    locationName: invitation.projectId?.locationName || '',
    funderName: invitation.invitedByUserId?.fullName || '',
  });
});

/**
 * Authenticated — any logged-in user (new or existing) may call this
 * directly once they hold a valid token; there is no separate "claim" step
 * the way the referral system needs one, since this always needs a real
 * signed-in identity to attach the role/task to.
 */
const acceptInvitation = catchAsync(async (req, res) => {
  let invitation = await VerifierInvitation.findOne({ tokenHash: hashToken(req.params.token) });
  if (!invitation) throw ApiError.notFound('Invitation not found');
  invitation = await expireIfPastDue(invitation);
  if (invitation.status !== 'pending') {
    throw ApiError.conflict(`This invitation is ${invitation.status} and can no longer be accepted`);
  }
  if (String(invitation.invitedByUserId) === String(req.user._id)) {
    throw ApiError.forbidden('You cannot accept your own invitation');
  }

  const project = await Project.findById(invitation.projectId);
  if (!project) throw ApiError.notFound('Project not found');

  // Grants ONLY the verifier role (needed to reach the existing start/report
  // endpoints, see verificationRoutes.js's requireRole('verifier')) — no
  // VerifierProfile is ever created or approved, so this person never
  // appears in getRecommendedVerifiers or any other global verifier
  // listing, satisfying "associated only with that specific project's
  // task." The funder's own account/roles are never touched.
  if (!req.user.roles?.some((r) => r.roleType === 'verifier')) {
    req.user.roles.push({ roleType: 'verifier' });
    await req.user.save();
  }

  // Same shape projectController.requestLocationVerification creates,
  // deliberately skipping its VerifierProfile.applicationStatus==='approved'
  // gate — the funder's own invitation is the authorization here.
  const task = await VerificationTask.create({
    targetType: 'project_location',
    targetId: project._id,
    verifierId: req.user._id,
  });
  project.locationVerificationStatus = 'requested';
  project.locationVerificationTaskId = task._id;
  await project.save();

  invitation.status = 'accepted';
  invitation.acceptedByUserId = req.user._id;
  invitation.acceptedAt = new Date();
  invitation.verificationTaskId = task._id;
  await invitation.save();

  await notificationService.notify(invitation.invitedByUserId, 'verifier_invitation_accepted', {
    projectId: project._id,
    verifierName: req.user.fullName,
    projectTitle: project.title,
  });
  // Same notify() type an admin-assigned recommended-verifier task already
  // fires — the mobile/web verifier-task screens key off this unchanged.
  await notificationService.notify(req.user._id, 'verification_assigned', {
    taskId: task._id,
    targetType: task.targetType,
    targetId: task.targetId,
  });

  return ok(res, { task, project });
});

/** Owner/admin-only — the funder's own view of who they've invited and
 * where each invitation stands (pending/accepted/revoked/expired). */
const listInvitationsForProject = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).select('ownerId');
  if (!project) throw ApiError.notFound('Project not found');
  if (!isOwnerOrAdmin(req.user, project)) throw ApiError.forbidden();

  const invitations = await VerifierInvitation.find({ projectId: project._id }).sort('-createdAt');
  return ok(res, invitations);
});

const revokeInvitation = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).select('ownerId');
  if (!project) throw ApiError.notFound('Project not found');
  if (!isOwnerOrAdmin(req.user, project)) throw ApiError.forbidden();

  const invitation = await VerifierInvitation.findOne({ _id: req.params.invitationId, projectId: project._id });
  if (!invitation) throw ApiError.notFound('Invitation not found');
  if (invitation.status !== 'pending') {
    throw ApiError.conflict(`Only a pending invitation can be revoked (this one is "${invitation.status}")`);
  }
  invitation.status = 'revoked';
  await invitation.save();
  return ok(res, invitation);
});

module.exports = {
  inviteVerifier,
  getInvitationPreview,
  acceptInvitation,
  listInvitationsForProject,
  revokeInvitation,
};
