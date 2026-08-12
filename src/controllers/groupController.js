const { Group, GroupMember, User, PooledContribution } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { getFundingSummaryData } = require('./projectController');

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

module.exports = { create, invite, join, leave, getMine, getOne, getDashboard };
