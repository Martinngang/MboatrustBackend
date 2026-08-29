const mongoose = require('mongoose');
const { Rating } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, toUserId, projectId, roleContext } = req.query;
  const filter = {};
  if (toUserId) filter.toUserId = toUserId;
  if (projectId) filter.projectId = projectId;
  if (roleContext) filter.roleContext = roleContext;

  const [items, total] = await Promise.all([
    Rating.find(filter)
      .populate('fromUserId', 'fullName')
      .populate('toUserId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Rating.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

/** Admin-only moderation — hard delete, since a rating has no "hidden"
 * flag in the schema and this is specifically for removing genuinely
 * abusive/fraudulent reviews, not a routine reversible action. */
const remove = catchAsync(async (req, res) => {
  const rating = await Rating.findById(req.params.id);
  if (!rating) throw ApiError.notFound('Rating not found');
  await rating.deleteOne();
  await logAdminAction({ adminId: req.user._id, action: 'rating.remove', targetType: 'Rating', targetId: rating._id, detail: { toUserId: rating.toUserId, score: rating.score } });
  return res.status(204).send();
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

/** Admin-authored rating on a user's behalf — the validator (see
 * validators/ratingValidators.js's adminCreateRating) requires an explicit
 * fromUserId since the admin isn't the author. Worth an audit entry since
 * an admin authoring someone else's review is a real trust action. */
const adminCreate = catchAsync(async (req, res) => {
  if (String(req.body.toUserId) === String(req.body.fromUserId)) {
    throw ApiError.badRequest('A rating cannot target the same user it is from');
  }
  const rating = await Rating.create(req.body);
  await logAdminAction({ adminId: req.user._id, action: 'rating.create', targetType: 'Rating', targetId: rating._id, detail: { fromUserId: rating.fromUserId, toUserId: rating.toUserId, score: rating.score } });
  return created(res, rating);
});

const adminUpdate = catchAsync(async (req, res) => {
  const rating = await Rating.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!rating) throw ApiError.notFound('Rating not found');
  await logAdminAction({ adminId: req.user._id, action: 'rating.update', targetType: 'Rating', targetId: rating._id, detail: { fields: Object.keys(req.body) } });
  return ok(res, rating);
});

module.exports = { getAll, getSummary, create, remove, adminCreate, adminUpdate };
