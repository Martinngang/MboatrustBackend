const { Notification } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const getMine = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, read } = req.query;
  const filter = { userId: req.user._id };
  if (read !== undefined) filter.read = read === 'true';

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: req.user._id, read: false }),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total, unreadCount });
});

const markRead = catchAsync(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { read: true },
    { new: true }
  );
  if (!notification) throw ApiError.notFound('Notification not found');
  return ok(res, notification);
});

const markAllRead = catchAsync(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
  return ok(res, { success: true });
});

module.exports = { getMine, markRead, markAllRead };
