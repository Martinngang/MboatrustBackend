const { VerificationTask, Project, LandListing } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { getRecommendedVerifiers } = require('../services/verifierMatchingService');

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

/** Whether `userId` is the real-world owner of the milestone/land-listing a
 * verification task targets — a funder checking their own project's
 * milestone, or a seller checking their own listing. Distinct from being
 * the assigned verifier: this is "do you own the thing being inspected". */
async function isTargetOwner(userId, targetType, targetId) {
  if (targetType === 'land_listing') {
    const listing = await LandListing.findById(targetId).select('sellerId').lean();
    return Boolean(listing && String(listing.sellerId) === String(userId));
  }
  const project = await Project.findOne({ 'milestones._id': targetId }).select('ownerId coSignerId').lean();
  if (!project) return false;
  return String(project.ownerId) === String(userId) || String(project.coSignerId) === String(userId);
}

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, targetType, targetId, verifierId, status } = req.query;
  const filter = {};
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  if (status) filter.status = status;

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');

  if (targetId) {
    // A specific-target lookup ("has this milestone/listing been
    // independently verified?") is legitimate for whoever owns that real
    // target, not just the assigned verifier — e.g. a funder checking their
    // own project's milestone review. Scoping by verifierId here would hide
    // the real report from the one person the feature exists for.
    if (!isAdmin && !(await isTargetOwner(req.user._id, targetType, targetId))) {
      filter.verifierId = req.user._id;
    }
  } else if (verifierId && (isAdmin || String(verifierId) === String(req.user._id))) {
    // Self-scoped by default — a verifier's own task queue, not every
    // verifier's assignments and (once submitted) private field reports
    // platform-wide. Only an admin may see another verifier's tasks or the
    // full unfiltered list.
    filter.verifierId = verifierId;
  } else if (!isAdmin) {
    filter.verifierId = req.user._id;
  }

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

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (
    !isAdmin &&
    String(task.verifierId) !== String(req.user._id) &&
    !(await isTargetOwner(req.user._id, task.targetType, task.targetId))
  ) {
    throw ApiError.forbidden();
  }

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

/** Admin-only suggestion list for the manual-assignment flow: which
 * approved verifiers best fit this milestone/land-listing target, ranked by
 * proximity, specialty match, and open caseload. */
const getRecommendedVerifiersForTarget = catchAsync(async (req, res) => {
  const { targetType, targetId, limit } = req.query;
  if (!targetType || !targetId) throw ApiError.badRequest('targetType and targetId are required');
  const recommendations = await getRecommendedVerifiers(targetType, targetId, { limit: Number(limit) || 10 });
  return ok(res, recommendations);
});

module.exports = { getAll, getOne, create, startTask, submitReport, getRecommendedVerifiersForTarget };
