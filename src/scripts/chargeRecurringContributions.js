// Finds every recurring PooledContribution whose nextChargeAt has passed and
// charges it again through the exact same collection path as a first-time
// contribution (feeService + paymentService.collect + a real Escrow), then
// advances nextChargeAt by another recurrenceIntervalDays. No job scheduler
// is installed in this project (checked package.json) — run this on a cron
// entry / Task Scheduler outside the app, same as seedFeeConfig.js is a
// manually-triggered script rather than a background job.
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');
const { PooledContribution, Project, Escrow } = require('../models');
const feeService = require('../services/feeService');
const paymentService = require('../services/paymentService');
const notificationService = require('../services/notificationService');

async function run() {
  await connectDB();

  const due = await PooledContribution.find({
    isRecurring: true,
    status: 'collected',
    paused: false,
    nextChargeAt: { $lte: new Date() },
  });
  console.log(`[recurring] ${due.length} contribution(s) due for charge`);

  for (const contribution of due) {
    try {
      const project = await Project.findById(contribution.projectId);
      if (!project) {
        console.log(`[recurring] ${contribution._id}: project missing, skipping`);
        continue;
      }

      const fee = await feeService.calculateFee('project_funding', contribution.amount, contribution.currency);
      if (!contribution.payerPhoneNumber) {
        console.log(`[recurring] ${contribution._id}: no stored payer phone number, skipping (was it ever successfully charged once?)`);
        continue;
      }

      const paymentResult = await paymentService.collect('mtn_momo', {
        amount: contribution.amount,
        currency: contribution.currency,
        payerPhoneNumber: contribution.payerPhoneNumber,
        externalId: `pooled_recurring_${contribution._id}_${Date.now()}`,
      });

      const escrow = await Escrow.create({
        projectId: project._id,
        type: 'fund',
        grossAmount: fee.grossAmount,
        feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
        netAmount: fee.netAmount,
        currency: contribution.currency,
        paymentProvider: 'mtn_momo',
        providerRole: 'collection',
        providerReference: paymentResult.providerReference,
        status: paymentResult.status,
      });

      if (paymentResult.status === 'completed') {
        contribution.escrowId = escrow._id;
        contribution.nextChargeAt = new Date(Date.now() + contribution.recurrenceIntervalDays * 24 * 60 * 60 * 1000);
        await contribution.save();
        await notificationService.notify(project.ownerId, 'pooled_contribution_collected', {
          projectId: project._id,
          contributionId: contribution._id,
          amount: fee.netAmount,
        });
        console.log(`[recurring] ${contribution._id}: charged, next due ${contribution.nextChargeAt.toISOString()}`);
      } else {
        // A failed recurring charge is never left "active" past its due
        // date — stop retrying automatically rather than silently keep a
        // stale nextChargeAt that would just fail again next run.
        contribution.isRecurring = false;
        contribution.nextChargeAt = null;
        await contribution.save();
        console.log(`[recurring] ${contribution._id}: charge failed, recurrence stopped`);
      }
    } catch (err) {
      console.error(`[recurring] ${contribution._id}: error`, err.message);
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[recurring] failed:', err);
  process.exit(1);
});
