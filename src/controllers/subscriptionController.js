const { Subscription } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const paymentService = require('../services/paymentService');
const { logAdminAction } = require('../services/adminActionLogService');

// Flat prices, not run through feeService.calculateFee — that service
// deducts a fee FROM a gross amount for money already moving through the
// platform (funding, milestone release); a subscription price is the
// charge itself, not something a fee gets subtracted from, so reusing it
// here would be a real semantic mismatch, not just reuse for its own sake.
const PLAN_PRICES = {
  pro_contractor: { amount: 5000, currency: 'XAF' },
  power_funder: { amount: 10000, currency: 'XAF' },
};
const RENEWAL_INTERVAL_DAYS = 30;

const getMine = catchAsync(async (req, res) => {
  const subscriptions = await Subscription.find({ userId: req.user._id }).sort('-createdAt');
  return ok(res, subscriptions);
});

/** Admin-only — every subscription platform-wide. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, planType } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (planType) filter.planType = planType;

  const [items, total] = await Promise.all([
    Subscription.find(filter).populate('userId', 'fullName').sort('-createdAt').skip((page - 1) * limit).limit(Number(limit)),
    Subscription.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

/** Routes the first charge through the exact same payment-provider
 * collection path as a funding deposit — if it doesn't complete, no
 * Subscription document is created at all. */
const create = catchAsync(async (req, res) => {
  const { planType, paymentProvider, payerPhoneNumber } = req.body;
  const plan = PLAN_PRICES[planType];
  if (!plan) throw ApiError.badRequest(`Unknown plan type "${planType}"`);
  if (paymentProvider === 'mtn_momo' && !payerPhoneNumber) {
    throw ApiError.badRequest('Payer phone number is required for MTN MoMo payment');
  }

  const paymentResult = await paymentService.collect(paymentProvider, {
    amount: plan.amount,
    currency: plan.currency,
    payerPhoneNumber,
    externalId: `subscription_${req.user._id}_${Date.now()}`,
  });

  if (paymentResult.status !== 'completed') {
    throw ApiError.badRequest(`Payment did not complete (status: "${paymentResult.status}") — subscription was not created`);
  }

  const subscription = await Subscription.create({
    userId: req.user._id,
    planType,
    status: 'active',
    renewalDate: new Date(Date.now() + RENEWAL_INTERVAL_DAYS * 24 * 60 * 60 * 1000),
    payerPhoneNumber: payerPhoneNumber || null,
  });
  return created(res, subscription);
});

const cancel = catchAsync(async (req, res) => {
  const isAdmin = req.user.roles?.some((r) => r.roleType === 'admin');
  const filter = isAdmin ? { _id: req.params.id } : { _id: req.params.id, userId: req.user._id };
  const subscription = await Subscription.findOneAndUpdate(filter, { status: 'cancelled' }, { new: true });
  if (!subscription) throw ApiError.notFound('Subscription not found');
  if (isAdmin && String(subscription.userId) !== String(req.user._id)) {
    await logAdminAction({ adminId: req.user._id, action: 'subscription.forceCancel', targetType: 'Subscription', targetId: subscription._id, detail: { userId: subscription.userId } });
  }
  return ok(res, subscription);
});

module.exports = { getMine, getAll, create, cancel, PLAN_PRICES, RENEWAL_INTERVAL_DAYS };
