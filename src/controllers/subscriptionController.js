const { Subscription } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const getMine = catchAsync(async (req, res) => {
  const subscriptions = await Subscription.find({ userId: req.user._id }).sort('-createdAt');
  return ok(res, subscriptions);
});

const create = catchAsync(async (req, res) => {
  const subscription = await Subscription.create({ ...req.body, userId: req.user._id });
  return created(res, subscription);
});

const cancel = catchAsync(async (req, res) => {
  const subscription = await Subscription.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { status: 'cancelled' },
    { new: true }
  );
  if (!subscription) throw ApiError.notFound('Subscription not found');
  return ok(res, subscription);
});

module.exports = { getMine, create, cancel };
