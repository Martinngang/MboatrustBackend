const { TeamMember, TeamActivityLog, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');
const { logTeamActivity } = require('../services/teamActivityLogService');
const notificationService = require('../services/notificationService');

/** Every roster row is implicitly scoped to req.user._id as the owner —
 * there's no route param for "whose team," so a caller can only ever
 * manage their own roster through these self-service endpoints. Only
 * updateRole/remove need an explicit ownership check, since those target a
 * specific row by id that isn't inherently proven to belong to the caller. */
const getMine = catchAsync(async (req, res) => {
  const hasOwnerRow = await TeamMember.exists({ ownerId: req.user._id, userId: req.user._id });
  if (!hasOwnerRow) {
    await TeamMember.create({
      ownerId: req.user._id,
      userId: req.user._id,
      invitedEmail: req.user.email || '',
      invitedName: req.user.fullName,
      role: 'owner',
      status: 'active',
    });
  }
  const members = await TeamMember.find({ ownerId: req.user._id }).populate('userId', 'fullName avatarUrl').sort('createdAt');
  return ok(res, members);
});

/** Straight add when the invited email already belongs to a real account
 * (same "no separate invite-token flow" convention as groupController.invite)
 * — otherwise the row waits in 'invited' status until that person signs up
 * and calls claim. */
const invite = catchAsync(async (req, res) => {
  const { email, name, role, permissions } = req.body;
  const existing = await TeamMember.findOne({ ownerId: req.user._id, invitedEmail: email.toLowerCase() });
  if (existing) throw ApiError.conflict('Already invited');

  const matchedUser = await User.findOne({ email: email.toLowerCase() });
  const member = await TeamMember.create({
    ownerId: req.user._id,
    userId: matchedUser ? matchedUser._id : null,
    invitedEmail: email.toLowerCase(),
    invitedName: name || matchedUser?.fullName || '',
    role,
    permissions: permissions || [],
    status: matchedUser ? 'active' : 'invited',
  });
  await logTeamActivity({
    ownerId: req.user._id,
    actorId: req.user._id,
    action: 'member.invited',
    targetType: 'TeamMember',
    targetId: member._id,
    detail: { email: member.invitedEmail, role, permissions: member.permissions },
  });
  return created(res, member);
});

/** Best-effort, called after login the same way Onboarding.tsx claims a
 * pending referral — never blocks sign-in, just links any roster rows that
 * were invited by email before this account existed. */
const claim = catchAsync(async (req, res) => {
  if (!req.user.email) return ok(res, { claimed: 0 });
  const result = await TeamMember.updateMany(
    { invitedEmail: req.user.email.toLowerCase(), status: 'invited' },
    { $set: { userId: req.user._id, status: 'active' } }
  );
  return ok(res, { claimed: result.modifiedCount });
});

/** Admin-only — every roster row platform-wide (getMine above is owner-
 * scoped, and self-provisions an 'owner' row on first call — an admin
 * calling this never triggers that side effect). */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, ownerId, status } = req.query;
  const filter = {};
  if (ownerId) filter.ownerId = ownerId;
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    TeamMember.find(filter).populate('ownerId', 'fullName').populate('userId', 'fullName').sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    TeamMember.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

function assertOwnsAndNotSelf(member, req) {
  if (!member) throw ApiError.notFound('Team member not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (String(member.ownerId) !== String(req.user._id) && !isAdmin) throw ApiError.forbidden('Only the team owner can do this');
  if (member.role === 'owner') throw ApiError.conflict("Can't modify the owner's own row");
  return isAdmin && String(member.ownerId) !== String(req.user._id);
}

const updateRole = catchAsync(async (req, res) => {
  const member = await TeamMember.findById(req.params.id);
  const asAdmin = assertOwnsAndNotSelf(member, req);
  const { role, permissions } = req.body;
  if (role !== undefined) member.role = role;
  if (permissions !== undefined) member.permissions = permissions;
  await member.save();
  if (asAdmin) {
    await logAdminAction({ adminId: req.user._id, action: 'teamMember.updateRole', targetType: 'TeamMember', targetId: member._id, detail: { ownerId: member.ownerId, role, permissions } });
    if (member.userId) {
      await notificationService.notify(
        member.userId,
        'team_member_role_changed_by_admin',
        { role },
        { adminId: req.user._id, relatedAction: 'teamMember.updateRole', relatedType: 'TeamMember', relatedId: member._id }
      );
    }
  } else {
    await logTeamActivity({
      ownerId: member.ownerId,
      actorId: req.user._id,
      action: 'member.permissionsChanged',
      targetType: 'TeamMember',
      targetId: member._id,
      detail: { role, permissions },
    });
  }
  return ok(res, member);
});

const remove = catchAsync(async (req, res) => {
  const member = await TeamMember.findById(req.params.id);
  const asAdmin = assertOwnsAndNotSelf(member, req);
  const { userId: memberUserId, ownerId, invitedEmail } = member;
  await member.deleteOne();
  if (asAdmin) {
    await logAdminAction({ adminId: req.user._id, action: 'teamMember.remove', targetType: 'TeamMember', targetId: member._id, detail: { ownerId } });
    if (memberUserId) {
      await notificationService.notify(
        memberUserId,
        'team_member_removed_by_admin',
        {},
        { adminId: req.user._id, relatedAction: 'teamMember.remove', relatedType: 'TeamMember', relatedId: member._id }
      );
    }
  } else {
    await logTeamActivity({
      ownerId,
      actorId: req.user._id,
      action: 'member.removed',
      targetType: 'TeamMember',
      targetId: member._id,
      detail: { email: invitedEmail },
    });
  }
  return res.status(204).send();
});

/** A contractor's own durable history of who invited/changed/removed whom,
 * and which delegate submitted evidence on their behalf — see
 * services/teamActivityLogService.js. Owner-scoped the same way getMine is;
 * an admin has no reason to browse this (they have AdminActionLog for their
 * own actions on this roster instead). */
const getActivity = catchAsync(async (req, res) => {
  const items = await TeamActivityLog.find({ ownerId: req.user._id })
    .populate('actorId', 'fullName')
    .sort('-createdAt')
    .limit(200);
  return ok(res, items);
});

module.exports = { getMine, getAll, invite, claim, updateRole, remove, getActivity };
