const { Conversation } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const getMine = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = { participantIds: req.user._id };

  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .populate('participantIds', 'fullName')
      .sort('-updatedAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Conversation.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id).populate('participantIds', 'fullName');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participantIds.some((p) => String(p._id) === String(req.user._id))) {
    throw ApiError.forbidden();
  }
  return ok(res, conversation);
});

/** Find-or-create — repeat "message this seller/contractor" clicks for the
 * same context reuse the existing thread instead of spawning duplicates. */
const create = catchAsync(async (req, res) => {
  const participantIds = Array.from(new Set([...req.body.participantIds, String(req.user._id)])).sort();

  const existing = await Conversation.findOne({
    contextType: req.body.contextType,
    contextId: req.body.contextId,
    participantIds: { $all: participantIds, $size: participantIds.length },
  }).populate('participantIds', 'fullName');
  if (existing) return ok(res, existing);

  const conversation = await Conversation.create({ ...req.body, participantIds });
  await conversation.populate('participantIds', 'fullName');
  return created(res, conversation);
});

module.exports = { getMine, getOne, create };
