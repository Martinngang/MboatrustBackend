const { SupplierProfile, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { logAdminAction } = require('../services/adminActionLogService');

const getMine = catchAsync(async (req, res) => {
  const profile = await SupplierProfile.findOne({ ownerId: req.user._id });
  return ok(res, profile);
});

/** Self-service create/update — always resets to 'pending' on any edit
 * after a prior rejection, so a re-application actually gets re-reviewed
 * rather than silently staying 'rejected' forever. Never touches
 * applicationStatus on its own beyond that reset — only approve/reject do.
 * Mirrors verifierProfileController.upsertMine exactly. */
const upsertMine = catchAsync(async (req, res) => {
  const existing = await SupplierProfile.findOne({ ownerId: req.user._id });
  const wasRejected = existing?.applicationStatus === 'rejected';

  const update = { ...req.body };
  if (wasRejected) {
    update.applicationStatus = 'pending';
    update.reviewedBy = null;
    update.reviewedAt = null;
  }

  const profile = await SupplierProfile.findOneAndUpdate(
    { ownerId: req.user._id },
    { $set: update, $setOnInsert: { ownerId: req.user._id } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return ok(res, profile);
});

/** Authenticated (any role), approved-only — funders/contractors browse this
 * to pick a store when requesting a materials milestone, unlike verifier
 * profiles, which are never browsed by ordinary users. Deliberately a
 * separate endpoint from getAll below rather than a query-param toggle on
 * it, so there's no risk of a pending applicant's data leaking to a
 * non-admin through a filter mistake. */
const getDirectory = catchAsync(async (req, res) => {
  const items = await SupplierProfile.find({ applicationStatus: 'approved' })
    .populate('ownerId', 'fullName')
    .sort('-completedOrderCount');
  return ok(res, items);
});

/** Admin review queue — filterable by applicationStatus, same convention as
 * verifierProfileController.getAll. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, applicationStatus } = req.query;
  const filter = {};
  if (applicationStatus) filter.applicationStatus = applicationStatus;

  const [items, total] = await Promise.all([
    SupplierProfile.find(filter)
      .populate('ownerId', 'fullName email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    SupplierProfile.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

/** Admin-only. Does the profile-status update AND the role grant in one
 * call (not two separate HTTP round-trips) — reusing grantRole's own logic
 * inline rather than an internal HTTP call, so there's never a state where
 * the application shows approved but the role didn't actually land. Mirrors
 * verifierProfileController.approve exactly. */
const approve = catchAsync(async (req, res) => {
  const profile = await SupplierProfile.findById(req.params.id);
  if (!profile) throw ApiError.notFound('Supplier application not found');

  profile.applicationStatus = 'approved';
  profile.reviewedBy = req.user._id;
  profile.reviewedAt = new Date();
  await profile.save();

  const user = await User.findById(profile.ownerId);
  if (user && !user.roles.some((r) => r.roleType === 'supplier')) {
    user.roles.push({ roleType: 'supplier' });
    await user.save();
  }

  await logAdminAction({ adminId: req.user._id, action: 'supplierProfile.approve', targetType: 'SupplierProfile', targetId: profile._id, detail: { ownerId: profile.ownerId } });

  return ok(res, profile);
});

const reject = catchAsync(async (req, res) => {
  const profile = await SupplierProfile.findById(req.params.id);
  if (!profile) throw ApiError.notFound('Supplier application not found');
  profile.applicationStatus = 'rejected';
  profile.reviewedBy = req.user._id;
  profile.reviewedAt = new Date();
  await profile.save();
  await logAdminAction({ adminId: req.user._id, action: 'supplierProfile.reject', targetType: 'SupplierProfile', targetId: profile._id, detail: { ownerId: profile.ownerId } });
  return ok(res, profile);
});

module.exports = { getMine, upsertMine, getDirectory, getAll, approve, reject };
