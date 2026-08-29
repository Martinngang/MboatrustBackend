const { Escrow, Project } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const feeService = require('../services/feeService');
const paymentService = require('../services/paymentService');
const escrowAnomalyService = require('../services/escrowAnomalyService');
const { logAdminAction } = require('../services/adminActionLogService');

// Transactions are their own collection (not embedded in Project) so admin
// revenue reports and per-user transaction history can query independently.
// A non-admin caller is silently scoped to their own transactions — as the
// contractor a release/fee_deduction was paid to, as the funder who paid
// into a fund escrow, or as the owner of the project it happened on —
// rather than being blocked outright; only an unscoped, cross-user view is
// admin-only.
const isAdminUser = (user) => user.roles?.some((r) => r.roleType === 'admin');

async function scopeToMyTransactions(user) {
  const myProjects = await Project.find({ ownerId: user._id }).select('_id').lean();
  return { $or: [{ contractorId: user._id }, { funderId: user._id }, { projectId: { $in: myProjects.map((p) => p._id) } }] };
}

/** Same three parties getAll scopes non-admins to, applied to a single
 * already-fetched escrow — shared by getOne and refreshStatus so neither
 * lets an unrelated authenticated user read or trigger a side effect on a
 * transaction that isn't theirs. */
async function assertCanAccessEscrow(escrow, user) {
  if (isAdminUser(user)) return;
  const isContractor = escrow.contractorId && String(escrow.contractorId) === String(user._id);
  const isFunder = escrow.funderId && String(escrow.funderId) === String(user._id);
  const isProjectOwner = escrow.projectId && (await Project.exists({ _id: escrow.projectId, ownerId: user._id }));
  if (!isContractor && !isFunder && !isProjectOwner) throw ApiError.forbidden();
}

/** The release escrows where the caller is the actual payee — as the
 * contractor a tender-project release was paid to, or as the recipient who
 * owns the funding/land_purchase project it released on. Deliberately
 * stricter than scopeToMyTransactions: that also matches a funder's own
 * tender project (so they can see the contractor's payout in their
 * transaction history), which must NOT count as money available for the
 * funder to withdraw. */
async function withdrawableFilter(user) {
  const myProjects = await Project.find({ ownerId: user._id }).select('_id').lean();
  return {
    type: 'release',
    withdrawnAt: null,
    $or: [
      { payeeType: 'contractor', contractorId: user._id },
      { payeeType: 'recipient', projectId: { $in: myProjects.map((p) => p._id) } },
    ],
  };
}

/** Sums the caller's unclaimed release escrows — the same figure the
 * Earnings screen's "Total Earned" derives from (release-type escrows),
 * scoped down to ones actually paid to this user and not yet withdrawn. */
const getWithdrawable = catchAsync(async (req, res) => {
  const filter = await withdrawableFilter(req.user);
  const escrows = await Escrow.find(filter).populate('projectId', 'title projectType').sort('-createdAt');
  const available = escrows.reduce((sum, e) => sum + e.netAmount, 0);
  return ok(res, { available, currency: escrows[0]?.currency || 'XAF', escrows });
});

/** Marks the caller's currently-available release escrows as withdrawn.
 * Money already moved to their MoMo/Orange Money account automatically at
 * milestone-release time (see projectController.releaseMilestoneEscrow) —
 * this never re-disburses, it only records that the payee has claimed/seen
 * it, so it stops counting toward "available to withdraw" going forward. */
const withdraw = catchAsync(async (req, res) => {
  const filter = await withdrawableFilter(req.user);
  const escrows = await Escrow.find(filter);
  const amount = escrows.reduce((sum, e) => sum + e.netAmount, 0);
  if (escrows.length === 0) throw ApiError.badRequest('Nothing available to withdraw');

  const withdrawnAt = new Date();
  await Escrow.updateMany({ _id: { $in: escrows.map((e) => e._id) } }, { $set: { withdrawnAt } });

  return ok(res, { amount, currency: escrows[0].currency, count: escrows.length, withdrawnAt });
});

const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, projectId, type, status, paymentProvider } = req.query;
  const filter = {};
  if (projectId) filter.projectId = projectId;
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (paymentProvider) filter.paymentProvider = paymentProvider;

  if (!isAdminUser(req.user)) {
    Object.assign(filter, await scopeToMyTransactions(req.user));
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

// Previously fetched by id with no ownership check at all — any
// authenticated user who knew or guessed an escrow _id could read any
// other user's transaction (amount, fees, payment provider, provider
// reference). Scoped the same way getAll already was for non-admins.
const getOne = catchAsync(async (req, res) => {
  const escrow = await Escrow.findById(req.params.id);
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  await assertCanAccessEscrow(escrow, req.user);
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
  // Stripe/Flutterwave route through their own real refund API (reversing
  // the original charge directly, keyed by providerReference) rather than
  // the generic disburse() neither of them actually supports — see
  // paymentService.refund. mtn_momo/orange_money fall back to disburse()
  // exactly as before, unchanged.
  const paymentResult = await paymentService.refund(original.paymentProvider, {
    amount: fee.netAmount,
    currency: original.currency,
    payeePhoneNumber: null,
    providerReference: original.providerReference,
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

  await logAdminAction({
    adminId: req.user._id,
    action: 'escrow.refund',
    targetType: 'Escrow',
    targetId: refundEscrow._id,
    detail: { originalEscrowId: original._id, projectId: original.projectId, netAmount: fee.netAmount, currency: original.currency },
  });

  return created(res, refundEscrow);
});

/** Re-polls a still-pending MTN MoMo transaction and, if it has resolved,
 * updates the Escrow (and flips the project to "funded" for a fund
 * transaction that just completed). No-op for Orange Money, which only
 * resolves via the webhook in paymentWebhookController. */
const refreshStatus = catchAsync(async (req, res) => {
  const escrow = await Escrow.findById(req.params.id);
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  await assertCanAccessEscrow(escrow, req.user);
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

/** Admin-only manual entry — e.g. recording an off-platform payment or
 * correcting a missing ledger row. `reason` is required and recorded in
 * the audit log; the Escrow document itself has no reason field, this is
 * the real money ledger so a manual write always needs a justification on
 * record even though the operation itself is otherwise unrestricted. */
const adminCreate = catchAsync(async (req, res) => {
  const { reason, ...fields } = req.body;
  const project = await Project.exists({ _id: fields.projectId });
  if (!project) throw ApiError.badRequest('No such project');

  let escrow;
  try {
    escrow = await Escrow.create({ ...fields, currency: fields.currency || 'XAF', status: fields.status || 'pending' });
  } catch (err) {
    // The release/milestoneId and refund/originalEscrowId partial unique
    // indexes (see models/Escrow.js) reject a genuine duplicate — surfaced
    // as a real conflict, not a 500.
    if (err.code === 11000) throw ApiError.conflict('An escrow transaction of this type already exists for that milestone/original transaction');
    throw err;
  }

  await logAdminAction({ adminId: req.user._id, action: 'escrow.create', targetType: 'Escrow', targetId: escrow._id, detail: { reason, projectId: fields.projectId, type: fields.type, netAmount: fields.netAmount } });
  return created(res, escrow);
});

/** Admin-only edit, restricted to status/amount/currency/providerReference
 * — never the identity/linkage fields (projectId, milestoneId, type,
 * contractorId, funderId), which the validator already excludes. */
const adminUpdate = catchAsync(async (req, res) => {
  const { reason, ...fields } = req.body;
  const escrow = await Escrow.findByIdAndUpdate(req.params.id, fields, { new: true, runValidators: true });
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  await logAdminAction({ adminId: req.user._id, action: 'escrow.update', targetType: 'Escrow', targetId: escrow._id, detail: { reason, fields: Object.keys(fields) } });
  return ok(res, escrow);
});

const adminRemove = catchAsync(async (req, res) => {
  const escrow = await Escrow.findById(req.params.id);
  if (!escrow) throw ApiError.notFound('Escrow transaction not found');
  await escrow.deleteOne();
  await logAdminAction({ adminId: req.user._id, action: 'escrow.remove', targetType: 'Escrow', targetId: req.params.id, detail: { reason: req.body.reason, projectId: escrow.projectId, type: escrow.type, netAmount: escrow.netAmount } });
  return res.status(204).send();
});

module.exports = { getAll, getOne, getWithdrawable, withdraw, refund, refreshStatus, adminCreate, adminUpdate, adminRemove };
