const { Project, Escrow, Bid, User, SupplierProfile, MaterialOrder } = require('../models');
const feeService = require('./feeService');
const conversionService = require('./conversionService');
const paymentService = require('./paymentService');
const notificationService = require('./notificationService');
const escrowAnomalyService = require('./escrowAnomalyService');
const referralService = require('./referralService');
const { getFundingState, EPS } = require('./milestoneFundingService');

/** Pays out one milestone from escrow (moved out of projectController so the
 * fund-completion path can settle approved-but-unpaid milestones without a
 * controller import cycle). Callers must have already established there is
 * enough escrow — use releaseIfFunded unless you have. */
async function releaseMilestoneEscrow(project, milestone) {
  // Closes (though the unique index below is the hard guarantee) the window
  // where two genuinely concurrent decideApproval calls both pass the
  // caller's status check and both reach here — without this, both would go
  // on to make a REAL disbursement API call and create two release escrows
  // for the same milestone, a real double-payout. Checked as early as
  // possible, before any side-effecting work.
  const existingRelease = await Escrow.findOne({ milestoneId: milestone._id, type: 'release' });
  if (existingRelease) {
    milestone.status = 'released';
    return existingRelease;
  }

  const payoutCurrency = 'XAF';
  let conversion = null;
  let disbursementGross = milestone.amount;

  // Tender projects have a real contractor party (whoever's Bid was
  // accepted) — funding/land_purchase projects don't, so this stays null there.
  let contractorId = null;
  if (project.projectType === 'tender') {
    const acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted' })
      .select('contractorId')
      .lean();
    contractorId = acceptedBid?.contractorId || null;
  }

  // Real payee routing for a materials-managed milestone: if a supplier has
  // actually confirmed/dispatched/delivered an order against this exact
  // milestone by the time it's approved, the release pays that store
  // directly instead of the project's usual payee. Every other milestone
  // keeps the existing behavior (payeePhoneNumber null unless the payee has
  // a payout method). The 'recipient' fallback below is unreachable for any
  // new project (funding-project creation is retired, see
  // assertCanCreateProjectType) but is kept so a still-open legacy funding
  // project's milestone release keeps producing a valid payeeType.
  let payeeType = project.projectType === 'tender' ? 'contractor' : 'recipient';
  let payeeSupplierId = null;
  let payeeSupplierOwnerId = null;
  let payoutProvider = 'mtn_momo';
  let payeePhoneNumber = null;
  let payoutMethodId = null;
  const materialsOrder = await MaterialOrder.findOne({
    milestoneId: milestone._id,
    status: { $in: ['confirmed', 'out_for_delivery', 'delivered'] },
  }).select('supplierId');
  if (materialsOrder) {
    const supplier = await SupplierProfile.findById(materialsOrder.supplierId).select('ownerId paymentProvider payoutPhoneNumber');
    if (supplier) {
      payeeType = 'supplier';
      payeeSupplierId = supplier._id;
      payeeSupplierOwnerId = supplier.ownerId;
      payoutProvider = supplier.paymentProvider;
      payeePhoneNumber = supplier.payoutPhoneNumber || null;
    }
  } else {
    const targetUserId = payeeType === 'contractor' ? contractorId : project.ownerId;
    if (targetUserId) {
      const payeeUser = await User.findById(targetUserId).select('payoutMethods phoneNumber').lean();
      if (payeeUser) {
        const defaultMethod = payeeUser.payoutMethods?.find((m) => m.isDefault) || payeeUser.payoutMethods?.[0];
        if (defaultMethod) {
          payoutProvider = defaultMethod.provider;
          payeePhoneNumber = defaultMethod.phoneNumber;
          payoutMethodId = defaultMethod._id;
        } else if (payeeUser.phoneNumber) {
          payeePhoneNumber = payeeUser.phoneNumber;
        }
      }
    }
  }

  if (project.currency !== payoutCurrency) {
    conversion = await conversionService.convertAmount(milestone.amount, project.currency, payoutCurrency);
    disbursementGross = conversion.settledAmount;
  }

  const fee = await feeService.calculateFee('milestone_release', disbursementGross, payoutCurrency);
  const paymentResult = await paymentService.disburse(payoutProvider, {
    amount: fee.netAmount,
    currency: payoutCurrency,
    payeePhoneNumber,
    externalId: `release_${project._id}_${milestone._id}`,
  });

  let escrow;
  try {
    escrow = await Escrow.create({
      projectId: project._id,
      milestoneId: milestone._id,
      contractorId,
      payeeType,
      payeeSupplierId,
      payeePhoneNumber,
      payoutMethodId,
      type: 'release',
      grossAmount: fee.grossAmount,
      feeBreakdown: { feeType: fee.feeType, feeRate: fee.feeRate, feeAmount: fee.feeAmount },
      netAmount: fee.netAmount,
      currency: payoutCurrency,
      paymentProvider: payoutProvider,
      providerRole: 'disbursement',
      providerReference: paymentResult.providerReference,
      currencyConversion: conversion,
      status: paymentResult.status,
      statusHistory: [{ status: paymentResult.status, detail: 'milestone release disbursed' }],
    });
  } catch (err) {
    // The early check above already handles the common case — this only
    // fires in the rare true-simultaneous race that slips past it. The
    // unique index (see Escrow.js) is what actually guarantees no duplicate
    // ledger entry, not this catch.
    if (err.code !== 11000) throw err;
    escrow = await Escrow.findOne({ milestoneId: milestone._id, type: 'release' });
  }

  milestone.status = 'released';

  // Whoever actually received the disbursement — the funder only ever
  // learns their own milestone *decision* went through, never that money
  // actually landed in the payee's hands, which is the more important half
  // of this event for a contractor/supplier.
  const payeeUserId = payeeType === 'supplier' ? payeeSupplierOwnerId : payeeType === 'contractor' ? contractorId : project.ownerId;
  if (payeeUserId) {
    await notificationService.notify(payeeUserId, 'milestone_payout_received', {
      projectId: project._id,
      milestoneId: milestone._id,
      milestoneTitle: milestone.name,
      amount: fee.netAmount,
      currency: payoutCurrency,
    });
  }

  return escrow;
}

/** Releases the milestone only if escrow actually holds its full amount.
 * Otherwise leaves it `approved` ("approved — waiting for funding") and
 * reports the shortfall; the release happens automatically when the funder
 * tops up (see settleApprovedMilestones). */
async function releaseIfFunded(project, milestone) {
  const state = await getFundingState(project);
  if (state.inEscrow + EPS < milestone.amount) {
    return { escrow: null, awaitingFunds: true, shortfall: Math.round((milestone.amount - state.inEscrow) * 100) / 100 };
  }
  const escrow = await releaseMilestoneEscrow(project, milestone);
  return { escrow, awaitingFunds: false, shortfall: 0 };
}

/** Everything that must happen after one or more releases are persisted:
 * detection-only anomaly checks, the "fund the next milestone" nudge, and
 * completion side-effects. Shared by decideApproval and the auto-release
 * after a top-up so both behave identically. */
async function finalizeReleases(project, releasedEscrows, { justCompleted }) {
  // Detection-only — runs after the release is already persisted, never
  // able to delay or block the payout itself. See escrowAnomalyService.
  for (const releasedEscrow of releasedEscrows) {
    await escrowAnomalyService.checkAndFlag({
      escrow: releasedEscrow,
      beneficiaryId: releasedEscrow.contractorId || project.ownerId,
    });
  }

  if (justCompleted) {
    // A prompt, not an auto-generated rating — never fabricate one on
    // someone's behalf. Reward the referrer of whichever party just
    // finished their side of the work, if either was ever referred.
    await notificationService.notify(project.ownerId, 'rating_prompt', { projectId: project._id });
    await referralService.maybeRewardReferral(project.ownerId);

    if (project.projectType === 'tender') {
      const acceptedBid = await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('contractorId').lean();
      if (acceptedBid) {
        await notificationService.notify(acceptedBid.contractorId, 'rating_prompt', { projectId: project._id });
        await referralService.maybeRewardReferral(acceptedBid.contractorId);
      }
    }
    return;
  }

  if (releasedEscrows.length > 0) {
    const state = await getFundingState(project);
    const next = state.nextMilestoneToFund;
    if (next && next.shortfall > 0) {
      await notificationService.notify(project.ownerId, 'funding_needed', {
        projectId: project._id,
        milestoneId: next.id,
        milestoneName: next.name,
        amount: next.shortfall,
      });
    }
  }
}

/** After a top-up: release every milestone the funder already approved while
 * escrow was short, in order, as far as the new funds reach. Idempotent —
 * releaseMilestoneEscrow itself refuses a second release for a milestone. */
async function settleApprovedMilestones(projectId) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const project = await Project.findById(projectId);
    if (!project) return [];
    const approved = project.milestones.filter((m) => m.status === 'approved').sort((a, b) => a.orderIndex - b.orderIndex);
    if (approved.length === 0) return [];

    const state = await getFundingState(project);
    let available = state.inEscrow;
    const releasedEscrows = [];
    for (const m of approved) {
      if (available + EPS < m.amount) break;
      releasedEscrows.push(await releaseMilestoneEscrow(project, m));
      available -= m.amount;
    }
    if (releasedEscrows.length === 0) return [];

    const allReleased = project.milestones.every((m) => m.status === 'released');
    const justCompleted = allReleased && project.status !== 'completed';
    if (allReleased) project.status = 'completed';
    try {
      await project.save();
    } catch (err) {
      if (err.name !== 'VersionError' || attempt === MAX_ATTEMPTS) throw err;
      continue;
    }
    await finalizeReleases(project, releasedEscrows, { justCompleted });
    return releasedEscrows;
  }
  return [];
}

module.exports = { releaseMilestoneEscrow, releaseIfFunded, finalizeReleases, settleApprovedMilestones };
