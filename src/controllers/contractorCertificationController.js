const { ContractorCertification } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

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
  const cert = await ContractorCertification.create({ ...req.body, userId: req.user._id });
  return created(res, cert);
});

const update = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  if (String(cert.userId) !== String(req.user._id)) throw ApiError.forbidden();
  Object.assign(cert, req.body);
  await cert.save();
  return ok(res, cert);
});

const remove = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  if (String(cert.userId) !== String(req.user._id)) throw ApiError.forbidden();
  await cert.deleteOne();
  return res.status(204).send();
});

/** Admin-only — a contractor can't verify their own certificate. */
const verify = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  cert.verified = true;
  cert.rejected = false;
  await cert.save();
  return ok(res, cert);
});

/** Admin-only — the other half of the review decision. */
const reject = catchAsync(async (req, res) => {
  const cert = await ContractorCertification.findById(req.params.id);
  if (!cert) throw ApiError.notFound('Certification not found');
  cert.rejected = true;
  cert.verified = false;
  await cert.save();
  return ok(res, cert);
});

module.exports = { getAll, getMine, getForUser, create, update, remove, verify, reject };
