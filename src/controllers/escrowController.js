const { Escrow, Project } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const paymentService = require('../services/paymentService');

// Transactions are their own collection (not embedded in Project) so admin
// revenue reports and per-user transaction history can query independently.
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, type, status, paymentProvider } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (paymentProvider) filter.paymentProvider = paymentProvider;

  const [items, total] = await Promise.all([
    Escrow.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Escrow.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

const getOne = catchAsync(async (req, res) => {
  const escrow = await Escrow.findById(req.params.id);
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  return ok(res, escrow);
});

/** Reverses a completed "fund" transaction — used when a project is cancelled after receiving funds. */
const refund = catchAsync(async (req, res) => {
  const original = await Escrow.findById(req.params.id);
  if (!original) throw ApiError.notFound('Escrow transaction not found');
  if (original.type !== 'fund' || original.status !== 'completed') {
    throw ApiError.conflict('Only a completed fund transaction can be refunded');
  }

  const project = await Project.findById(original.projectId);
  const fee = await feeService.calculateFee('refund', original.netAmount, original.currency);
  const paymentResult = await paymentService.disburse(original.paymentProvider, {
    amount: fee.netAmount,
    currency: original.currency,
    payeePhoneNumber: null,
    externalId: `refund_${original._id}`,
  });

  const refundEscrow = await Escrow.create({
    projectId: original.projectId,
    milestoneId: original.milestoneId,
    type: 'refund',
    grossAmount: fee.grossAmount,
    feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
    netAmount: fee.netAmount,
    currency: original.currency,
    paymentProvider: original.paymentProvider,
    providerRole: 'disbursement',
    providerReference: paymentResult.providerReference,
    status: paymentResult.status,
  });

  if (project && paymentResult.status === 'completed') {
    original.status = 'reversed';
    await original.save();
  }

  return created(res, refundEscrow);
});

/** Re-polls a still-pending MTN MoMo transaction and, if it has resolved,
 * updates the Escrow (and flips the project to "funded" for a fund
 * transaction that just completed). No-op for Orange Money, which only
 * resolves via the webhook in paymentWebhookController. */
const refreshStatus = catchAsync(async (req, res) => {
  const escrow = await Escrow.findById(req.params.id);
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  if (escrow.status !== 'pending') return ok(res, escrow);

  const product = escrow.type === 'fund' ? 'collection' : 'disbursement';
  const resolved = await paymentService.refreshStatus(escrow.paymentProvider, escrow.providerReference, product);
  if (resolved && resolved !== escrow.status) {
    escrow.status = resolved;
    await escrow.save();
    if (resolved === 'completed' && escrow.type === 'fund') {
      const project = await Project.findById(escrow.projectId);
      if (project && project.status === 'open') {
        project.status = 'funded';
        await project.save();
      }
    }
  }
  return ok(res, escrow);
});

module.exports = { getAll, getOne, refund, refreshStatus };
