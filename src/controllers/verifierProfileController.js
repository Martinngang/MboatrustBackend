const { VerifierProfile, User } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const storageService = require('../services/storageService');
const { logAdminAction } = require('../services/adminActionLogService');

const getMine = catchAsync(async (req, res) => {
  const profile = await VerifierProfile.findOne({ userId: req.user._id });
  return ok(res, profile);
});

/** Self-service create/update — always resets to 'pending' on any edit
 * after a prior rejection, so a re-application actually gets re-reviewed
 * rather than silently staying 'rejected' forever. Never touches
 * applicationStatus on its own beyond that reset — only approve/reject do. */
const upsertMine = catchAsync(async (req, res) => {
  let idDocumentUrl = req.body.idDocumentUrl;
  if (req.file) {
    const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
      folder: `mboatrust/verifier-applications/${req.user._id}`,
    });
    idDocumentUrl = uploadResult.secure_url;
  }

  const existing = await VerifierProfile.findOne({ userId: req.user._id });
  const wasRejected = existing?.applicationStatus === 'rejected';

  const update = { ...req.body, idDocumentUrl };
  if (wasRejected) {
    update.applicationStatus = 'pending';
    update.reviewedBy = null;
    update.reviewedAt = null;
  }

  const profile = await VerifierProfile.findOneAndUpdate(
    { userId: req.user._id },
    { $set: update, $setOnInsert: { userId: req.user._id } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return created(res, profile);
});

/** Admin review queue — filterable by applicationStatus so the review
 * screen can ask for just the pending ones, same convention as
 * contractorCertificationController.getAll's verified/rejected filters. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, applicationStatus } = req.query;
  const filter = {};
  if (applicationStatus) filter.applicationStatus = applicationStatus;

  const [items, total] = await Promise.all([
    VerifierProfile.find(filter)
      .populate('userId', 'fullName email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    VerifierProfile.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

/** Admin-only. Does the profile-status update AND the role grant in one
 * call (not two separate HTTP round-trips) — reusing grantRole's own logic
 * inline rather than an internal HTTP call, so there's never a state where
 * the application shows approved but the role didn't actually land. */
const approve = catchAsync(async (req, res) => {
  const profile = await VerifierProfile.findById(req.params.id);
  if (!profile) throw ApiError.notFound('Verifier application not found');

  profile.applicationStatus = 'approved';
  profile.reviewedBy = req.user._id;
  profile.reviewedAt = new Date();
  await profile.save();

  const user = await User.findById(profile.userId);
  if (user && !user.roles.some((r) => r.roleType === 'verifier')) {
    user.roles.push({ roleType: 'verifier' });
    await user.save();
  }

  await logAdminAction({ adminId: req.user._id, action: 'verifierProfile.approve', targetType: 'VerifierProfile', targetId: profile._id, detail: { userId: profile.userId } });

  return ok(res, profile);
});

const reject = catchAsync(async (req, res) => {
  const profile = await VerifierProfile.findById(req.params.id);
  if (!profile) throw ApiError.notFound('Verifier application not found');
  profile.applicationStatus = 'rejected';
  profile.reviewedBy = req.user._id;
  profile.reviewedAt = new Date();
  await profile.save();
  await logAdminAction({ adminId: req.user._id, action: 'verifierProfile.reject', targetType: 'VerifierProfile', targetId: profile._id, detail: { userId: profile.userId } });
  return ok(res, profile);
});

/** Admin-only edit of any verifier's profile fields — unlike upsertMine,
 * never touches applicationStatus (that's approve/reject's job only), so
 * an admin correcting a typo doesn't accidentally reset a reviewed
 * application back to pending. */
const adminUpdate = catchAsync(async (req, res) => {
  const { applicationStatus, reviewedBy, reviewedAt, ...safeFields } = req.body;
  const profile = await VerifierProfile.findOneAndUpdate(
    { userId: req.params.userId },
    { $set: safeFields },
    { new: true, runValidators: true }
  );
  if (!profile) throw ApiError.notFound('Verifier profile not found');
  await logAdminAction({ adminId: req.user._id, action: 'verifierProfile.adminUpdate', targetType: 'VerifierProfile', targetId: profile._id, detail: { userId: req.params.userId, fields: Object.keys(safeFields) } });
  return ok(res, profile);
});

module.exports = { getMine, upsertMine, getAll, approve, reject, adminUpdate };
