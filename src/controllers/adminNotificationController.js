const mongoose = require('mongoose');
const { Notification, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { notifyMany } = require('../services/notificationService');
const { logAdminAction } = require('../services/adminActionLogService');

const ROLE_TYPES = ['funder', 'contractor', 'land_seller', 'verifier', 'admin', 'supplier'];

const broadcast = catchAsync(async (req, res) => {
  const { targetRole, type, message, payload = {} } = req.body;
  if (!type) throw ApiError.badRequest('type is required');
  if (targetRole && !ROLE_TYPES.includes(targetRole)) throw ApiError.badRequest('Invalid targetRole');

  const filter = targetRole ? { 'roles.roleType': targetRole } : {};
  const users = await User.find(filter).select('_id');
  const userIds = users.map((u) => u._id);
  if (!userIds.length) throw ApiError.badRequest('No matching users found for that target');

  const finalPayload = message ? { ...payload, message } : payload;
  const broadcastId = new mongoose.Types.ObjectId();
  await notifyMany(userIds, type, finalPayload, { broadcastId, sentByAdminId: req.user._id });

  await logAdminAction({
    adminId: req.user._id,
    action: 'notification.broadcast',
    targetType: 'Notification',
    targetId: broadcastId,
    detail: { targetRole: targetRole || 'all', type, recipientCount: userIds.length },
  });

  return ok(res, { broadcastId, recipientCount: userIds.length }, undefined, 201);
});

// One row per broadcast batch (grouped by broadcastId), not one row per
// recipient Notification — a send to 500 users must show as one history
// entry, not 500.
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const [rows, totalAgg] = await Promise.all([
    Notification.aggregate([
      { $match: { broadcastId: { $ne: null } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$broadcastId',
          type: { $first: '$type' },
          payload: { $first: '$payload' },
          sentByAdminId: { $first: '$sentByAdminId' },
          createdAt: { $first: '$createdAt' },
          recipientCount: { $sum: 1 },
          readCount: { $sum: { $cond: ['$read', 1, 0] } },
        },
      },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: Number(limit) },
    ]),
    Notification.aggregate([
      { $match: { broadcastId: { $ne: null } } },
      { $group: { _id: '$broadcastId' } },
      { $count: 'total' },
    ]),
  ]);

  const adminIds = [...new Set(rows.map((r) => String(r.sentByAdminId)).filter((id) => id && id !== 'null'))];
  const admins = await User.find({ _id: { $in: adminIds } }).select('fullName').lean();
  const adminMap = Object.fromEntries(admins.map((a) => [String(a._id), a.fullName]));

  const items = rows.map((r) => ({
    broadcastId: r._id,
    type: r.type,
    payload: r.payload,
    createdAt: r.createdAt,
    recipientCount: r.recipientCount,
    readCount: r.readCount,
    sentByName: adminMap[String(r.sentByAdminId)] || 'Unknown admin',
  }));

  return ok(res, items, { page: Number(page), limit: Number(limit), total: totalAgg[0]?.total || 0 });
});

module.exports = { broadcast, getAll };
