const { Escrow, Project } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const paymentService = require('../services/paymentService');
const escrowAnomalyService = require('../services/escrowAnomalyService');

// Transactions are their own collection (not embedded in Project) so admin
// revenue reports and per-user transaction history can query independently.
// A non-admin caller is silently scoped to their own transactions — as the
// contractor a release/fee_deduction was paid to, or as the funder of a
// project a fund/refund happened on — rather than being blocked outright;
// only an unscoped, cross-user view is admin-only.
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, type, status, paymentProvider } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (paymentProvider) filter.paymentProvider = paymentProvider;

  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  if (!isAdmin) {
    const myProjects = await Project.find({ ownerId: req.user._id }).select('_id').lean();
    filter.$or = [{ contractorId: req.user._id }, { projectId: { $in: myProjects.map((p) => p._id) } }];
  }

  const [items, total] = await Promise.all([
    Escrow.find(filter)
      .populate('projectId', 'title projectType')
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

  // Two concurrent refund requests for the same original transaction (a
  // double-click, two admins acting at once) would otherwise both pass the
  // check above, both make a real disbursement call, and both create a
  // refund record — a real double-refund. Checked as early as possible,
  // before any side-effecting work; the unique index on Escrow (see
  // models/Escrow.js) is the hard guarantee for the rare case that slips
  // past this.
  const existingRefund = await Escrow.findOne({ originalEscrowId: original._id, type: 'refund' });
  if (existingRefund) return created(res, existingRefund);

  const project = await Project.findById(original.projectId);
  const fee = await feeService.calculateFee('refund', original.netAmount, original.currency);
  const paymentResult = await paymentService.disburse(original.paymentProvider, {
    amount: fee.netAmount,
    currency: original.currency,
    payeePhoneNumber: null,
    externalId: `refund_${original._id}`,
  });

  let refundEscrow;
  try {
    refundEscrow = await Escrow.create({
      projectId: original.projectId,
      milestoneId: original.milestoneId,
      originalEscrowId: original._id,
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
  } catch (err) {
    if (err.code !== 11000) throw err;
    return created(res, await Escrow.findOne({ originalEscrowId: original._id, type: 'refund' }));
  }

  if (project && paymentResult.status === 'completed') {
    original.status = 'reversed';
    await original.save();
  }

  // Detection-only — runs after the refund is already persisted, never
  // able to delay or block it. See escrowAnomalyService. Refunds have no
  // tracked funder identity (no Contribution model to resolve one from),
  // so the project owner stands in as the responsible party of record —
  // ownerId is required on every Project, so this is never null.
  if (project) {
    await escrowAnomalyService.checkAndFlag({ escrow: refundEscrow, beneficiaryId: project.ownerId });
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
