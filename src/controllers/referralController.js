const { Referral } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');

const getMine = catchAsync(async (req, res) => {
  const referrals = await Referral.find({ referrerId: req.user._id }).populate('referredId', 'fullName').sort('-createdAt');
  return ok(res, referrals);
});

/** Admin-only — every referral platform-wide. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    Referral.find(filter).populate('referrerId', 'fullName').populate('referredId', 'fullName').sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    Referral.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
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

/** Admin-only — fraud cleanup (a self-referral loophole, a spam invite
 * loop). No owner-facing delete exists; referrals are otherwise an
 * immutable ledger. */
const remove = catchAsync(async (req, res) => {
  const referral = await Referral.findById(req.params.id);
  if (!referral) throw ApiError.notFound('Referral not found');
  await referral.deleteOne();
  await logAdminAction({ adminId: req.user._id, action: 'referral.remove', targetType: 'Referral', targetId: referral._id, detail: { referrerId: referral.referrerId } });
  return res.status(204).send();
});

module.exports = { getMine, getAll, create, claim, remove };
