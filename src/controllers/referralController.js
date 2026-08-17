const { Referral } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

const getMine = catchAsync(async (req, res) => {
  const referrals = await Referral.find({ referrerId: req.user._id }).populate('referredId', 'fullName').sort('-createdAt');
  return ok(res, referrals);
});

const create = catchAsync(async (req, res) => {
  const referral = await Referral.create({ referrerId: req.user._id });
  return created(res, referral);
});

/** A newly signed-up user claims a pending referral, e.g. from an invite link. */
const claim = catchAsync(async (req, res) => {
  const referral = await Referral.findById(req.params.id);
  if (!referral) throw ApiError.notFound('Referral not found');
  if (referral.status !== 'invited') throw ApiError.conflict('Referral already claimed');
  // Otherwise the referrer could visit their own invite link and later
  // collect maybeRewardReferral's payout for "referring" themselves.
  if (String(referral.referrerId) === String(req.user._id)) {
    throw ApiError.badRequest('Cannot claim your own referral');
  }

  referral.referredId = req.user._id;
  referral.status = 'joined';
  await referral.save();
  return ok(res, referral);
});

module.exports = { getMine, create, claim };
