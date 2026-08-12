const { PooledContribution, Project, Escrow } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const paymentService = require('../services/paymentService');
const notificationService = require('../services/notificationService');

/** Project owner invites someone else to pledge toward the project — a
 * pending PooledContribution the invited party must still actually pay
 * via `contribute` before any money moves. */
const invite = catchAsync(async (req, res) => {
  const { projectId, contributorId, amount, currency, isRecurring, recurrenceIntervalDays } = req.body;
  const project = await Project.findById(projectId);
  if (!project) throw ApiError.notFound('Project not found');
  if (String(project.ownerId) !== String(req.user._id)) throw ApiError.forbidden('Only the project owner can invite a co-funder');

  const contribution = await PooledContribution.create({
    projectId,
    contributorId,
    amount,
    currency: currency || project.currency,
    isRecurring: Boolean(isRecurring),
    recurrenceIntervalDays: isRecurring ? recurrenceIntervalDays : null,
  });
  await notificationService.notify(contributorId, 'pooled_contribution_invited', {
    projectId,
    contributionId: contribution._id,
    amount: contribution.amount,
  });
  return created(res, contribution);
});

/**
 * Charges a real payment — either fulfilling an existing invited (pending)
 * contribution, or a self-initiated one created inline in this same call —
 * through the exact same collection path as a normal single-funder deposit
 * (feeService + paymentService.collect + a real Escrow document), so a
 * pooled contribution is never a second, parallel money-movement system.
 */
const contribute = catchAsync(async (req, res) => {
  const { contributionId, paymentProvider, payerPhoneNumber } = req.body;

  let contribution;
  if (contributionId) {
    contribution = await PooledContribution.findById(contributionId);
    if (!contribution) throw ApiError.notFound('Contribution not found');
    if (String(contribution.contributorId) !== String(req.user._id)) {
      throw ApiError.forbidden('Only the invited contributor can pay this pledge');
    }
    if (contribution.status !== 'pending') throw ApiError.conflict(`Contribution already "${contribution.status}"`);
  } else {
    const { projectId, amount, currency, isRecurring, recurrenceIntervalDays } = req.body;
    const project = await Project.findById(projectId);
    if (!project) throw ApiError.notFound('Project not found');
    contribution = await PooledContribution.create({
      projectId,
      contributorId: req.user._id,
      amount,
      currency: currency || project.currency,
      isRecurring: Boolean(isRecurring),
      recurrenceIntervalDays: isRecurring ? recurrenceIntervalDays : null,
    });
  }

  const project = await Project.findById(contribution.projectId);
  if (!project) throw ApiError.notFound('Project not found');
  if (!['open', 'funded', 'in_progress'].includes(project.status)) {
    throw ApiError.conflict(`Cannot fund a project in status "${project.status}"`);
  }
  if (paymentProvider === 'mtn_momo' && !payerPhoneNumber) {
    throw ApiError.badRequest('Payer phone number is required for MTN MoMo funding');
  }

  const fee = await feeService.calculateFee('project_funding', contribution.amount, contribution.currency);
  const paymentResult = await paymentService.collect(paymentProvider, {
    amount: contribution.amount,
    currency: contribution.currency,
    payerPhoneNumber,
    externalId: `pooled_${contribution._id}_${Date.now()}`,
  });

  const escrow = await Escrow.create({
    projectId: project._id,
    type: 'fund',
    grossAmount: fee.grossAmount,
    feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
    netAmount: fee.netAmount,
    currency: contribution.currency,
    paymentProvider,
    providerRole: 'collection',
    providerReference: paymentResult.providerReference,
    status: paymentResult.status,
  });

  if (paymentResult.status === 'completed') {
    contribution.status = 'collected';
    contribution.escrowId = escrow._id;
    if (payerPhoneNumber) contribution.payerPhoneNumber = payerPhoneNumber;
    if (contribution.isRecurring) {
      contribution.nextChargeAt = new Date(Date.now() + contribution.recurrenceIntervalDays * 24 * 60 * 60 * 1000);
    }
    if (project.status === 'open') {
      project.status = 'funded';
      await project.save();
    }
  } else {
    contribution.status = 'failed';
  }
  await contribution.save();

  await notificationService.notify(project.ownerId, 'pooled_contribution_collected', {
    projectId: project._id,
    contributionId: contribution._id,
    amount: fee.netAmount,
  });

  return ok(res, { contribution, escrow });
});

/** Stops future recurring charges without touching any escrow already collected. */
const cancelRecurring = catchAsync(async (req, res) => {
  const contribution = await PooledContribution.findById(req.params.id);
  if (!contribution) throw ApiError.notFound('Contribution not found');
  if (String(contribution.contributorId) !== String(req.user._id)) throw ApiError.forbidden();
  if (!contribution.isRecurring) throw ApiError.conflict('This contribution is not recurring');

  contribution.isRecurring = false;
  contribution.nextChargeAt = null;
  await contribution.save();
  return ok(res, contribution);
});

/** Skips future charges until resumed — the charge cron excludes paused
 * contributions — without losing the recurring schedule the way cancelling
 * would. */
const pauseRecurring = catchAsync(async (req, res) => {
  const contribution = await PooledContribution.findById(req.params.id);
  if (!contribution) throw ApiError.notFound('Contribution not found');
  if (String(contribution.contributorId) !== String(req.user._id)) throw ApiError.forbidden();
  if (!contribution.isRecurring) throw ApiError.conflict('This contribution is not recurring');

  contribution.paused = true;
  await contribution.save();
  return ok(res, contribution);
});

const resumeRecurring = catchAsync(async (req, res) => {
  const contribution = await PooledContribution.findById(req.params.id);
  if (!contribution) throw ApiError.notFound('Contribution not found');
  if (String(contribution.contributorId) !== String(req.user._id)) throw ApiError.forbidden();
  if (!contribution.isRecurring) throw ApiError.conflict('This contribution is not recurring');

  contribution.paused = false;
  // Time may have passed while paused — push a now-overdue schedule forward
  // rather than firing a backlog of missed charges the instant it resumes.
  if (contribution.nextChargeAt && contribution.nextChargeAt <= new Date()) {
    contribution.nextChargeAt = new Date(Date.now() + contribution.recurrenceIntervalDays * 24 * 60 * 60 * 1000);
  }
  await contribution.save();
  return ok(res, contribution);
});

const getAll = catchAsync(async (req, res) => {
  const { projectId, contributorId, status } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (contributorId) filter.contributorId = contributorId;
  if (status) filter.status = status;
  const items = await PooledContribution.find(filter)
    .populate('contributorId', 'fullName')
    .populate('projectId', 'title')
    .sort('-createdAt');
  return ok(res, items);
});

module.exports = { invite, contribute, cancelRecurring, pauseRecurring, resumeRecurring, getAll };
