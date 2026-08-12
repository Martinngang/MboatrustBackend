const { Subscription } = require('../models');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const paymentService = require('../services/paymentService');

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
  const subscription = await Subscription.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { status: 'cancelled' },
    { new: true }
  );
  if (!subscription) throw ApiError.notFound('Subscription not found');
  return ok(res, subscription);
});

module.exports = { getMine, create, cancel, PLAN_PRICES, RENEWAL_INTERVAL_DAYS };
