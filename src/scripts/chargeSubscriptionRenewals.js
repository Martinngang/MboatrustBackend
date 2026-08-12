// Same shape as chargeRecurringContributions.js — finds every active
// Subscription whose renewalDate has passed and charges it again. A failed
// charge flips status to 'past_due' immediately rather than silently
// leaving an unpaid subscription marked 'active' past its renewal date.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { Subscription } = require('../models');
const paymentService = require('../services/paymentService');
const notificationService = require('../services/notificationService');
const { PLAN_PRICES, RENEWAL_INTERVAL_DAYS } = require('../controllers/subscriptionController');

async function run() {
  await connectDB();

  const due = await Subscription.find({ status: 'active', renewalDate: { $lte: new Date() } });
  console.log(`[subscriptions] ${due.length} renewal(s) due`);

  for (const sub of due) {
    try {
      const plan = PLAN_PRICES[sub.planType];
      if (!plan) {
        console.log(`[subscriptions] ${sub._id}: unknown planType "${sub.planType}", skipping`);
        continue;
      }
      if (!sub.payerPhoneNumber) {
        console.log(`[subscriptions] ${sub._id}: no stored payer phone number, skipping`);
        continue;
      }

      const paymentResult = await paymentService.collect('mtn_momo', {
        amount: plan.amount,
        currency: plan.currency,
        payerPhoneNumber: sub.payerPhoneNumber,
        externalId: `subscription_renewal_${sub._id}_${Date.now()}`,
      });

      if (paymentResult.status === 'completed') {
        sub.renewalDate = new Date(Date.now() + RENEWAL_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        await sub.save();
        console.log(`[subscriptions] ${sub._id}: renewed, next due ${sub.renewalDate.toISOString()}`);
      } else {
        sub.status = 'past_due';
        await sub.save();
        await notificationService.notify(sub.userId, 'subscription_past_due', { subscriptionId: sub._id });
        console.log(`[subscriptions] ${sub._id}: charge failed, marked past_due`);
      }
    } catch (err) {
      console.error(`[subscriptions] ${sub._id}: error`, err.message);
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[subscriptions] failed:', err);
  process.exit(1);
});
