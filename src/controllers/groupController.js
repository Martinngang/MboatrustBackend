const { Group, GroupMember, User, PooledContribution } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { getFundingSummaryData } = require('./projectController');
const { logAdminAction } = require('../services/adminActionLogService');

const create = catchAsync(async (req, res) => {
  const group = await Group.create({
    name: req.body.name,
    description: req.body.description || '',
    purpose: req.body.purpose || '',
    linkedProjectId: req.body.linkedProjectId || null,
    createdBy: req.user._id,
  });
  await GroupMember.create({ groupId: group._id, userId: req.user._id, role: 'owner' });
  return created(res, group);
});

/** Owner adds someone directly — no separate invite-token flow exists in
 * this codebase, so this is a straight add-plus-notify, not a pending
 * invitation the recipient has to separately accept. */
const invite = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) throw ApiError.notFound('Group not found');
  const membership = await GroupMember.findOne({ groupId: group._id, userId: req.user._id });
  if (!membership || membership.role !== 'owner') throw ApiError.forbidden('Only the group owner can invite members');

  const target = await User.findById(req.body.userId);
  if (!target) throw ApiError.badRequest('No such user');

  const existing = await GroupMember.findOne({ groupId: group._id, userId: req.body.userId });
  if (existing) throw ApiError.conflict('Already a member of this group');

  const member = await GroupMember.create({ groupId: group._id, userId: req.body.userId, role: 'member' });
  await notificationService.notify(req.body.userId, 'group_invited', { groupId: group._id, groupName: group.name });
  return created(res, member);
});

/** Self-service — anyone with the group id can join directly (e.g. via a
 * shared link), same underlying membership record `invite` creates. */
const join = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) throw ApiError.notFound('Group not found');

  const existing = await GroupMember.findOne({ groupId: group._id, userId: req.user._id });
  if (existing) throw ApiError.conflict('Already a member of this group');

  const member = await GroupMember.create({ groupId: group._id, userId: req.user._id, role: 'member' });
  return created(res, member);
});

const leave = catchAsync(async (req, res) => {
  const membership = await GroupMember.findOne({ groupId: req.params.id, userId: req.user._id });
  if (!membership) throw ApiError.notFound('Not a member of this group');
  if (membership.role === 'owner') throw ApiError.conflict('The owner cannot leave their own group');

  await membership.deleteOne();
  return res.status(204).send();
});

const getMine = catchAsync(async (req, res) => {
  const memberships = await GroupMember.find({ userId: req.user._id }).lean();
  const groupIds = memberships.map((m) => m.groupId);
  const groups = await Group.find({ _id: { $in: groupIds } }).lean();
  return ok(res, groups);
});

/** Admin-only — every group platform-wide (getMine above is /mine-scoped
 * for the consumer app; nothing before this listed all of them). */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const filter = {};
  if (search) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = new RegExp(escaped, 'i');
  }

  const [groups, total] = await Promise.all([
    Group.find(filter).populate('createdBy', 'fullName').sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    Group.countDocuments(filter),
  ]);
  const memberCounts = await GroupMember.aggregate([
    { $match: { groupId: { $in: groups.map((g) => g._id) } } },
    { $group: { _id: '$groupId', count: { $sum: 1 } } },
  ]);
  const countByGroup = new Map(memberCounts.map((c) => [String(c._id), c.count]));
  const items = groups.map((g) => ({ ...g.toObject(), memberCount: countByGroup.get(String(g._id)) || 0 }));
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) throw ApiError.notFound('Group not found');
  return ok(res, group);
});

/**
 * Aggregates the linked project's real funding summary (reusing
 * projectController.getFundingSummaryData rather than reimplementing it)
 * plus real membership + per-member contribution totals when
 * PooledContribution records exist — degrades gracefully to membership-only
 * data for a group with no linked project yet.
 */
const getDashboard = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id).lean();
  if (!group) throw ApiError.notFound('Group not found');

  const members = await GroupMember.find({ groupId: group._id }).populate('userId', 'fullName avatarUrl').lean();

  let fundingSummary = null;
  let contributionsByMember = [];
  if (group.linkedProjectId) {
    fundingSummary = await getFundingSummaryData(group.linkedProjectId);
    const contributions = await PooledContribution.aggregate([
      { $match: { projectId: group.linkedProjectId, status: 'collected' } },
      { $group: { _id: '$contributorId', total: { $sum: '$amount' } } },
    ]);
    contributionsByMember = contributions.map((c) => ({ userId: c._id, total: c.total }));
  }

  return ok(res, {
    group,
    memberCount: members.length,
    members,
    fundingSummary,
    contributionsByMember,
  });
});

/** Admin-only moderation edit — no owner-editable equivalent exists yet
 * (see routes/groupRoutes.js's comment), so this is deliberately the only
 * path onto a Group's name/description/purpose. */
const update = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) throw ApiError.notFound('Group not found');
  const { name, description, purpose } = req.body;
  if (name !== undefined) group.name = name;
  if (description !== undefined) group.description = description;
  if (purpose !== undefined) group.purpose = purpose;
  await group.save();
  await logAdminAction({ adminId: req.user._id, action: 'group.update', targetType: 'Group', targetId: group._id, detail: { fields: Object.keys(req.body) } });
  return ok(res, group);
});

/** Admin-only disband — cascades to every GroupMember row so no orphaned
 * memberships are left pointing at a deleted group. */
const remove = catchAsync(async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) throw ApiError.notFound('Group not found');
  await GroupMember.deleteMany({ groupId: group._id });
  await group.deleteOne();
  await logAdminAction({ adminId: req.user._id, action: 'group.remove', targetType: 'Group', targetId: group._id, detail: { name: group.name } });
  return res.status(204).send();
});

module.exports = { create, invite, join, leave, getMine, getAll, getOne, getDashboard, update, remove };
