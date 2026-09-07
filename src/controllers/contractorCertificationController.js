const { ContractorCertification } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const storageService = require('../services/storageService');
const { logAdminAction } = require('../services/adminActionLogService');
const notificationService = require('../services/notificationService');

/** Admin review queue — every contractor's certifications, not just one
 * user's (getMine/getForUser). Optional `verified`/`rejected` filters so the
 * admin screen can ask for just the pending ones. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, verified, rejected } = req.query;
  const filter = {};
  if (verified !== undefined) filter.verified = verified === 'true';
  if (rejected !== undefined) filter.rejected = rejected === 'true';

  const [items, total] = await Promise.all([
    ContractorCertification.find(filter)
      .populate('userId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    ContractorCertification.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getMine = catchAsync(async (req, res) => {
  const items = await ContractorCertification.find({ userId: req.user._id }).sort('-createdAt');
  return ok(res, items);
});

const getForUser = catchAsync(async (req, res) => {
  const items = await ContractorCertification.find({ userId: req.params.userId }).sort('-createdAt');
  return ok(res, items);
});

const create = catchAsync(async (req, res) => {
  let documentUrl = req.body.documentUrl;
  if (req.file) {
    const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
      folder: `mboatrust/certifications/${req.user._id}`,
    });
    documentUrl = uploadResult.secure_url;
  }
  const cert = await ContractorCertification.create({ ...req.body, documentUrl, userId: req.user._id });
  return created(res, cert);
});

const update = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const isOwner = String(cert.userId) === String(req.user._id);
  if (!isOwner && !isAdmin) throw ApiError.forbidden();
  Object.assign(cert, req.body);
  await cert.save();
  if (isAdmin && !isOwner) {
    await logAdminAction({ adminId: req.user._id, action: 'contractorCertification.update', targetType: 'ContractorCertification', targetId: cert._id, detail: { userId: cert.userId, fields: Object.keys(req.body) } });
    await notificationService.notify(
      cert.userId,
      'contractor_certification_edited_by_admin',
      { title: cert.title },
      { adminId: req.user._id, relatedAction: 'contractorCertification.update', relatedType: 'ContractorCertification', relatedId: cert._id }
    );
  }
  return ok(res, cert);
});

const remove = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const isOwner = String(cert.userId) === String(req.user._id);
  if (!isOwner && !isAdmin) throw ApiError.forbidden();
  const { userId: certOwnerId, title: certTitle } = cert;
  await cert.deleteOne();
  if (isAdmin && !isOwner) {
    await logAdminAction({ adminId: req.user._id, action: 'contractorCertification.remove', targetType: 'ContractorCertification', targetId: cert._id, detail: { userId: certOwnerId, title: certTitle } });
    await notificationService.notify(
      certOwnerId,
      'contractor_certification_removed',
      { title: certTitle },
      { adminId: req.user._id, relatedAction: 'contractorCertification.remove', relatedType: 'ContractorCertification', relatedId: cert._id }
    );
  }
  return res.status(204).send();
});

/** Admin-only — a contractor can't verify their own certificate. */
const verify = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  cert.verified = true;
  cert.rejected = false;
  await cert.save();
  await logAdminAction({ adminId: req.user._id, action: 'contractorCertification.verify', targetType: 'ContractorCertification', targetId: cert._id, detail: { userId: cert.userId } });
  await notificationService.notify(
    cert.userId,
    'contractor_certification_verified',
    { title: cert.title },
    { adminId: req.user._id, relatedAction: 'contractorCertification.verify', relatedType: 'ContractorCertification', relatedId: cert._id }
  );
  return ok(res, cert);
});

/** Admin-only — the other half of the review decision. */
const reject = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  cert.rejected = true;
  cert.verified = false;
  await cert.save();
  await logAdminAction({ adminId: req.user._id, action: 'contractorCertification.reject', targetType: 'ContractorCertification', targetId: cert._id, detail: { userId: cert.userId } });
  await notificationService.notify(
    cert.userId,
    'contractor_certification_rejected',
    { title: cert.title },
    { adminId: req.user._id, relatedAction: 'contractorCertification.reject', relatedType: 'ContractorCertification', relatedId: cert._id }
  );
  return ok(res, cert);
});

module.exports = { getAll, getMine, getForUser, create, update, remove, verify, reject };
