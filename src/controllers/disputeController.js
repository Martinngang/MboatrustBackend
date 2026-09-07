const { Dispute, Project, RiskFlag } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const notificationService = require('../services/notificationService');
const { logAdminAction } = require('../services/adminActionLogService');

const MULTIPLE_DISPUTES_THRESHOLD = 3;

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, status } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (status) filter.status = status;

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (!isAdmin) {
    const myProjects = await Project.find({ ownerId: req.user._id }).select('_id').lean();
    filter.$or = [{ raisedBy: req.user._id }, { projectId: { $in: myProjects.map((p) => p._id) } }];
  }

  const [items, total] = await Promise.all([
    Dispute.find(filter)
      .populate('raisedBy', 'fullName')
      .populate({ path: 'projectId', select: 'title totalAmount ownerId', populate: { path: 'ownerId', select: 'fullName' } })
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Dispute.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const dispute = await Dispute.findById(req.params.id)
    .populate('raisedBy', 'fullName')
    .populate({ path: 'projectId', select: 'title totalAmount ownerId', populate: { path: 'ownerId', select: 'fullName' } });
  if (!dispute) throw ApiError.notFound('Dispute not found');

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const project = dispute.projectId;
  const ownerId = project && typeof project.ownerId === 'object' ? project.ownerId._id : project?.ownerId;
  const isParty = String(dispute.raisedBy?._id ?? dispute.raisedBy) === String(req.user._id) || String(ownerId) === String(req.user._id);
  if (!isAdmin && !isParty) throw ApiError.forbidden('Not authorized to view this dispute');

  return ok(res, dispute);
});

const create = catchAsync(async (req, res) => {
  const project = await Project.findById(req.body.projectId);
  if (!project) throw ApiError.notFound('Project not found');

  if (req.body.milestoneId) {
    const milestone = project.milestones.id(req.body.milestoneId);
    if (!milestone) throw ApiError.notFound('Milestone not found');
    milestone.status = 'disputed';
  }
  project.status = 'disputed';
  await project.save();

  const dispute = await Dispute.create({ ...req.body, raisedBy: req.user._id });

  if (String(project.ownerId) !== String(req.user._id)) {
    await notificationService.notify(project.ownerId, 'dispute_raised', {
      projectId: project._id,
      disputeId: dispute._id,
    });
  }

  // Flag the project owner once their projects have accumulated enough
  // disputes to be a real pattern rather than a one-off — only once, not
  // re-raised on every subsequent dispute past the threshold.
  const ownerProjectIds = (await Project.find({ ownerId: project.ownerId }).select('_id')).map((p) => p._id);
  const disputeCount = await Dispute.countDocuments({ projectId: { $in: ownerProjectIds } });
  if (disputeCount >= MULTIPLE_DISPUTES_THRESHOLD) {
    const alreadyFlagged = await RiskFlag.findOne({ userId: project.ownerId, flagType: 'multiple_disputes' });
    if (!alreadyFlagged) {
      await RiskFlag.create({
        userId: project.ownerId,
        flagType: 'multiple_disputes',
        severity: disputeCount >= MULTIPLE_DISPUTES_THRESHOLD * 2 ? 'high' : 'medium',
        detail: { disputeCount },
      });
    }
  }

  return created(res, dispute);
});

/** Admin/mediator resolution — reopens the milestone into review rather than assuming approval. */
const resolve = catchAsync(async (req, res) => {
  const dispute = await Dispute.findById(req.params.id);
  if (!dispute) throw ApiError.notFound('Dispute not found');

  dispute.status = req.body.status;
  dispute.resolutionNotes = req.body.resolutionNotes;
  await dispute.save();

  const project = await Project.findById(dispute.projectId);
  if (dispute.status === 'resolved' && project) {
    if (dispute.milestoneId) {
      const milestone = project.milestones.id(dispute.milestoneId);
      if (milestone && milestone.status === 'disputed') milestone.status = 'under_review';
    }
    if (project.status === 'disputed') project.status = 'in_progress';
    await project.save();
  }

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const meta = isAdmin
    ? { adminId: req.user._id, relatedAction: 'dispute.resolve', relatedType: 'Dispute', relatedId: dispute._id }
    : {};
  const payload = { disputeId: dispute._id, projectId: dispute.projectId, status: dispute.status };

  if (String(dispute.raisedBy) !== String(req.user._id)) {
    await notificationService.notify(dispute.raisedBy, 'dispute_resolved', payload, meta);
  }
  // The counterparty (the project owner, when they didn't raise this
  // dispute themselves) previously never learned it was resolved at all —
  // a real gap, since they're just as much a party to it as the raiser.
  if (project && String(project.ownerId) !== String(dispute.raisedBy) && String(project.ownerId) !== String(req.user._id)) {
    await notificationService.notify(project.ownerId, 'dispute_resolved_counterparty', payload, meta);
  }

  await logAdminAction({
    adminId: req.user._id,
    action: 'dispute.resolve',
    targetType: 'Dispute',
    targetId: dispute._id,
    detail: { status: dispute.status, projectId: dispute.projectId },
  });

  return ok(res, dispute);
});

module.exports = { getAll, getOne, create, resolve };
