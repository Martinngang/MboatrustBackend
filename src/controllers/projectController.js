const mongoose = require('mongoose');
const { Project, Escrow, Dispute } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const conversionService = require('../services/conversionService');
const paymentService = require('../services/paymentService');
const storageService = require('../services/storageService');
const notificationService = require('../services/notificationService');
const evidenceAnalysisService = require('../services/evidenceAnalysisService');
const { RiskFlag } = require('../models');

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectType, status, ownerId } = req.query;
  const filter = {};
  if (projectType) filter.projectType = projectType;
  if (status) filter.status = status;
  if (ownerId) filter.ownerId = ownerId;

  const [items, total] = await Promise.all([
    Project.find(filter)
      .populate('ownerId', 'fullName')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Project.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id).populate('ownerId', 'fullName');
  if (!project) throw ApiError.notFound('Project not found');
  return ok(res, project);
});

const create = catchAsync(async (req, res) => {
  const milestones = (req.body.milestones || []).sort((a, b) => a.orderIndex - b.orderIndex);
  const project = await Project.create({
    ...req.body,
    milestones,
    ownerId: req.user._id,
    status: 'open',
  });
  await project.populate('ownerId', 'fullName');
  return created(res, project);
});

const update = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  if (String(project.ownerId) !== String(req.user._id)) throw ApiError.forbidden();
  if (project.status !== 'draft' && project.status !== 'open') {
    throw ApiError.conflict('Cannot edit a project once it has received funds');
  }
  Object.assign(project, req.body);
  await project.save();
  return ok(res, project);
});

const remove = catchAsync(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  if (String(project.ownerId) !== String(req.user._id)) throw ApiError.forbidden();
  if (project.status !== 'draft') throw ApiError.conflict('Only draft projects can be deleted');
  await project.deleteOne();
  return res.status(204).send();
});

/** Sum of completed escrow activity for a project, net of fees, used to derive "amount raised". */
const getFundingSummary = catchAsync(async (req, res) => {
  const projectId = req.params.id;
  const rows = await Escrow.aggregate([
    { $match: { projectId: new mongoose.Types.ObjectId(projectId), status: 'completed' } },
    { $group: { _id: '$type', total: { $sum: '$netAmount' } } },
  ]);
  const byType = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  const raised = (byType.fund || 0) - (byType.refund || 0);
  const released = byType.release || 0;
  return ok(res, { raised, released, escrowBalance: raised - released });
});

/**
 * Funder sends money into escrow for a project. Sandbox payment provider
 * "completes" synchronously for the demo; a real integration would move
 * status pending -> completed via a webhook instead.
 */
const fundProject = catchAsync(async (req, res) => {
  const { amount, paymentProvider, currency: requestedCurrency, payerPhoneNumber } = req.body;
  const project = await Project.findById(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const currency = requestedCurrency || project.currency;
  if (!['open', 'funded', 'in_progress'].includes(project.status)) {
    throw ApiError.conflict(`Cannot fund a project in status "${project.status}"`);
  }

  if (paymentProvider === 'mtn_momo' && !payerPhoneNumber) {
    throw ApiError.badRequest('Payer phone number is required for MTN MoMo funding');
  }

  if (['mtn_momo', 'orange_money'].includes(paymentProvider) && currency !== 'XAF') {
    throw ApiError.badRequest('Mobile money funding must be paid in XAF');
  }

  const fee = await feeService.calculateFee('project_funding', amount, currency);
  const paymentResult = await paymentService.collect(paymentProvider, {
    amount,
    currency,
    payerPhoneNumber,
    externalId: `fund_${project._id}`,
  });

  const escrow = await Escrow.create({
    projectId: project._id,
    type: 'fund',
    grossAmount: fee.grossAmount,
    feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
    netAmount: fee.netAmount,
    currency,
    paymentProvider,
    providerRole: 'collection',
    providerReference: paymentResult.providerReference,
    status: paymentResult.status,
  });

  if (paymentResult.status === 'completed' && project.status === 'open') {
    project.status = 'funded';
    await project.save();
  }

  await notificationService.notify(project.ownerId, 'project_funded', {
    projectId: project._id,
    amount: fee.netAmount,
  });

  // Orange Money's webpayment flow is redirect-based: a 'pending' result here
  // carries a payment_url the client must send the payer to. It isn't part of
  // the persisted Escrow record (ephemeral, only useful once), so it's merged
  // into the response body rather than added to the schema.
  return created(res, paymentResult.paymentUrl ? { ...escrow.toObject(), paymentUrl: paymentResult.paymentUrl } : escrow);
});

async function releaseMilestoneEscrow(project, milestone) {
  const payoutCurrency = 'XAF';
  let conversion = null;
  let disbursementGross = milestone.amount;

  if (project.currency !== payoutCurrency) {
    conversion = await conversionService.convertAmount(milestone.amount, project.currency, payoutCurrency);
    disbursementGross = conversion.settledAmount;
  }

  const fee = await feeService.calculateFee('milestone_release', disbursementGross, payoutCurrency);
  const paymentResult = await paymentService.disburse('mtn_momo', {
    amount: fee.netAmount,
    currency: payoutCurrency,
    payeePhoneNumber: null,
    externalId: `release_${project._id}_${milestone._id}`,
  });

  const escrow = await Escrow.create({
    projectId: project._id,
    milestoneId: milestone._id,
    type: 'release',
    grossAmount: fee.grossAmount,
    feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
    netAmount: fee.netAmount,
    currency: payoutCurrency,
    paymentProvider: 'mtn_momo',
    providerRole: 'disbursement',
    providerReference: paymentResult.providerReference,
    currencyConversion: conversion,
    status: paymentResult.status,
  });

  milestone.status = 'released';
  return escrow;
}

/** Adds a photo/video evidence entry to a milestone and moves it into review. */
const submitEvidence = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (!['pending', 'submitted', 'disputed'].includes(milestone.status)) {
    throw ApiError.conflict(`Cannot submit evidence for a milestone in status "${milestone.status}"`);
  }

  let fileUrl = req.body.fileUrl;
  const clientGeotag =
    req.body.geotagLat != null && req.body.geotagLng != null ? { lat: req.body.geotagLat, lng: req.body.geotagLng } : null;
  // Server-computed signals from the actual file bytes — a client can't fake
  // its geotag/timestamp/hash by lying in the request body, only by faking
  // the file's own EXIF data, which is a materially higher bar.
  let analysis = { geotag: clientGeotag ?? { lat: null, lng: null }, fileHash: req.body.fileHash, locationMatch: null, timestampRecent: null, duplicateFlag: false, capturedAt: undefined };
  if (req.file) {
    const uploadResult = await storageService.uploadBuffer(req.file.buffer, {
      folder: `mboatrust/evidence/${project._id}`,
    });
    fileUrl = uploadResult.secure_url;
    analysis = await evidenceAnalysisService.analyzeEvidence(req.file.buffer, project.location, clientGeotag);
  }
  if (!fileUrl) throw ApiError.badRequest('Provide a file upload or fileUrl');

  milestone.evidence.push({
    type: req.body.type,
    fileUrl,
    geotag: analysis.geotag,
    fileHash: analysis.fileHash,
    locationMatch: analysis.locationMatch,
    timestampRecent: analysis.timestampRecent,
    duplicateFlag: analysis.duplicateFlag,
    capturedAt: analysis.capturedAt,
    submittedBy: req.user._id,
  });
  milestone.status = 'under_review';

  if (project.status === 'funded') project.status = 'in_progress';
  await project.save();

  if (analysis.duplicateFlag) {
    await RiskFlag.create({
      userId: req.user._id,
      flagType: 'reused_evidence',
      severity: 'medium',
      detail: { projectId: project._id, milestoneId, fileHash: analysis.fileHash },
    });
  }

  await notificationService.notify(project.ownerId, 'milestone_evidence_submitted', {
    projectId: project._id,
    milestoneId,
  });

  return created(res, project);
});

/**
 * Records an approver's decision. Auto-registers the acting user as an
 * approver on first decision (e.g. the funder reviewing evidence) rather
 * than requiring a separate pre-assignment step.
 */
const decideApproval = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const { status } = req.body;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw ApiError.notFound('Milestone not found');
  if (milestone.status !== 'under_review' && milestone.status !== 'submitted') {
    throw ApiError.conflict(`Milestone is not awaiting approval (status "${milestone.status}")`);
  }

  let approver = milestone.approvers.find((a) => String(a.userId) === String(req.user._id));
  if (!approver) {
    milestone.approvers.push({ userId: req.user._id, status, decidedAt: new Date() });
  } else {
    approver.status = status;
    approver.decidedAt = new Date();
  }

  let releasedEscrow = null;
  if (status === 'rejected') {
    milestone.status = 'disputed';
  } else {
    const allApproved =
      milestone.approvers.length > 0 && milestone.approvers.every((a) => a.status === 'approved');
    if (allApproved || milestone.approvers.length === 0) {
      milestone.status = 'approved';
      releasedEscrow = await releaseMilestoneEscrow(project, milestone);
    }
  }

  const allReleased = project.milestones.every((m) => m.status === 'released');
  if (allReleased) project.status = 'completed';

  await project.save();

  await notificationService.notify(project.ownerId, 'milestone_decision', {
    projectId: project._id,
    milestoneId,
    status: milestone.status,
  });

  return ok(res, { project, releasedEscrow });
});

/** Raises a formal dispute against a milestone (or the whole project when milestoneId is omitted). */
const disputeMilestone = catchAsync(async (req, res) => {
  const { id, milestoneId } = req.params;
  const { reason } = req.body;
  const project = await Project.findById(id);
  if (!project) throw ApiError.notFound('Project not found');

  if (milestoneId) {
    const milestone = project.milestones.id(milestoneId);
    if (!milestone) throw ApiError.notFound('Milestone not found');
    milestone.status = 'disputed';
  }
  project.status = 'disputed';
  await project.save();

  const dispute = await Dispute.create({
    projectId: project._id,
    milestoneId: milestoneId || null,
    raisedBy: req.user._id,
    reason,
  });

  return created(res, dispute);
});

module.exports = {
  getAll,
  getOne,
  create,
  update,
  remove,
  getFundingSummary,
  fundProject,
  submitEvidence,
  decideApproval,
  disputeMilestone,
};
