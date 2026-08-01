const mongoose = require('mongoose');
const { Rating } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, toUserId, projectId, roleContext } = req.query;
  const filter = {};
  if (toUserId) filter.toUserId = toUserId;
  if (projectId) filter.projectId = projectId;
  if (roleContext) filter.roleContext = roleContext;

  const [items, total] = await Promise.all([
    Rating.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Rating.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getSummary = catchAsync(async (req, res) => {
  const stats = await Rating.aggregate([
    { $match: { toUserId: new mongoose.Types.ObjectId(req.params.userId) } },
    { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
  ]);
  return ok(res, stats[0] || { average: null, count: 0 });
});

const create = catchAsync(async (req, res) => {
  if (String(req.body.toUserId) === String(req.user._id)) {
    throw ApiError.badRequest('Cannot rate yourself');
  }
  const rating = await Rating.create({ ...req.body, fromUserId: req.user._id });
  return created(res, rating);
});

module.exports = { getAll, getSummary, create };
