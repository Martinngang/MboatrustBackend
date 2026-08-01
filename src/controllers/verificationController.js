const { VerificationTask, Project, LandListing } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');

/**
 * `targetId` is a polymorphic reference (a milestone subdocument _id within
 * some Project, or a LandListing _id) with no single collection to
 * `.populate()` — resolves display info (title/location/milestone name) by
 * looking it up in whichever collection actually matches, so verifier
 * screens can show real context instead of a bare ObjectId.
 */
async function resolveTarget(task) {
  if (task.targetType === 'land_listing') {
    const listing = await LandListing.findById(task.targetId).select('title city region').lean();
    return listing ? { title: listing.title || 'Land listing', location: `${listing.city}, ${listing.region}` } : null;
  }
  const project = await Project.findOne({ 'milestones._id': task.targetId }).select('title locationName milestones').lean();
  if (!project) return null;
  const milestone = project.milestones.find((m) => String(m._id) === String(task.targetId));
  return { title: project.title, location: project.locationName, milestoneTitle: milestone?.name, projectId: project._id };
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, targetType, targetId, verifierId, status } = req.query;
  const filter = {};
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  if (verifierId) filter.verifierId = verifierId;
  if (status) filter.status = status;

  const [rawItems, total] = await Promise.all([
    VerificationTask.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    VerificationTask.countDocuments(filter),
  ]);
  const targets = await Promise.all(rawItems.map(resolveTarget));
  const items = rawItems.map((task, i) => ({ ...task.toObject(), target: targets[i] }));
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const task = await VerificationTask.findById(req.params.id);
  if (!task) throw ApiError.notFound('Verification task not found');
  const target = await resolveTarget(task);
  return ok(res, { ...task.toObject(), target });
});

/** Assigns a verifier to inspect a milestone or land listing on the ground. */
const create = catchAsync(async (req, res) => {
  const task = await VerificationTask.create(req.body);
  await notificationService.notify(task.verifierId, 'verification_assigned', {
    taskId: task._id,
    targetType: task.targetType,
    targetId: task.targetId,
  });
  return created(res, task);
});

const startTask = catchAsync(async (req, res) => {
  const task = await VerificationTask.findById(req.params.id);
  if (!task) throw ApiError.notFound('Verification task not found');
  if (String(task.verifierId) !== String(req.user._id)) throw ApiError.forbidden();
  task.status = 'in_progress';
  await task.save();
  return ok(res, task);
});

const submitReport = catchAsync(async (req, res) => {
  const task = await VerificationTask.findById(req.params.id);
  if (!task) throw ApiError.notFound('Verification task not found');
  if (String(task.verifierId) !== String(req.user._id)) throw ApiError.forbidden();

  task.reportText = req.body.reportText;
  task.reportPhotos = req.body.reportPhotos;
  task.confirmedMatch = req.body.confirmedMatch;
  task.status = 'submitted';
  await task.save();
  return ok(res, task);
});

module.exports = { getAll, getOne, create, startTask, submitReport };
