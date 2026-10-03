const mongoose = require('mongoose');
const { Escrow, Project, Bid } = require('../models');
const ApiError = require('../utils/ApiError');
const feeService = require('./feeService');
const conversionService = require('./conversionService');
const notificationService = require('./notificationService');

// Amounts are XAF (no minor unit) and fee/gross-up maths rounds to 2dp, so
// comparisons tolerate half a franc rather than failing on rounding dust.
const EPS = 0.5;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * THE single source of truth for "how funded is this project" — everything
 * (funding-summary endpoint, gates, dashboards, notifications) derives from
 * the Escrow ledger + the project's milestones through this one function, so
 * contract value / funded / released / unfunded can never drift apart.
 *
 *  - totalContractValue: the agreed price (project.totalAmount).
 *  - fundedAmount: net credited to escrow (fund minus refunds), XAF-converted.
 *    Net, because the funding fee is charged ON TOP: to cover X the funder
 *    pays gross-for-net(X) (see quoteFunding), so credited == coverage.
 *  - releasedAmount: value of milestones actually released (milestone amounts,
 *    i.e. contract basis — the release fee comes out of each payout).
 *  - inEscrow: funded − released. unfundedAmount: what is still to be funded.
 *  - Milestones are covered by a waterfall over unreleased milestones in
 *    orderIndex order; a milestone is `funded` only when fully covered.
 *    `full_upfront` projects have no `funded` milestone until the whole
 *    contract value is in escrow.
 */
async function getFundingState(project, { excludeEscrowId } = {}) {
  const projectId = new mongoose.Types.ObjectId(project._id);
  const match = {
    projectId,
    $or: [{ status: 'completed' }, { type: 'fund', status: 'reversed' }],
  };
  if (excludeEscrowId) match._id = { $ne: new mongoose.Types.ObjectId(excludeEscrowId) };

  const [rows, pendingRows] = await Promise.all([
    Escrow.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$type',
          net: { $sum: { $multiply: ['$netAmount', { $ifNull: ['$currencyConversion.rate', 1] }] } },
        },
      },
    ]),
    Escrow.aggregate([
      { $match: { projectId, type: 'fund', status: 'pending', ...(excludeEscrowId ? { _id: { $ne: new mongoose.Types.ObjectId(excludeEscrowId) } } : {}) } },
      { $group: { _id: null, net: { $sum: { $multiply: ['$netAmount', { $ifNull: ['$currencyConversion.rate', 1] }] } } } },
    ]),
  ]);
  const byType = Object.fromEntries(rows.map((r) => [r._id, r.net]));
  const fundedAmount = round2((byType.fund || 0) - (byType.refund || 0));
  const pendingFunding = round2(pendingRows[0]?.net || 0);

  const milestones = [...(project.milestones || [])].sort((a, b) => a.orderIndex - b.orderIndex);
  const totalContractValue = project.totalAmount || 0;
  const releasedAmount = round2(milestones.filter((m) => m.status === 'released').reduce((s, m) => s + m.amount, 0));
  const inEscrow = round2(fundedAmount - releasedAmount);
  const unfundedAmount = round2(Math.max(0, totalContractValue - fundedAmount));
  const fundingMode = project.fundingMode || 'staged';
  const fullyFundedForUpfront = fundedAmount + EPS >= totalContractValue;

  let pool = Math.max(0, inEscrow);
  const out = milestones.map((m) => {
    const base = {
      id: String(m._id),
      name: m.name,
      amount: m.amount,
      orderIndex: m.orderIndex,
      status: m.status,
      proceedAtRisk: Boolean(m.riskAcknowledgedAt),
      riskAcknowledgedAt: m.riskAcknowledgedAt || null,
      awaitingFunds: m.status === 'approved',
    };
    if (m.status === 'released') {
      return { ...base, fundedAmount: m.amount, unfundedAmount: 0, fundingStatus: 'released', workable: false };
    }
    // Sub-franc leftovers (the fee gross-up rounds to 2dp) are dust, not
    // "partially funded" — ignore anything under EPS.
    const rawCover = Math.min(pool, m.amount);
    const cover = rawCover < EPS ? 0 : rawCover;
    pool = round2(pool - rawCover);
    const covered = cover + EPS >= m.amount;
    let fundingStatus;
    if (fundingMode === 'full_upfront') {
      fundingStatus = fullyFundedForUpfront ? 'funded' : cover > 0 ? 'partially_funded' : 'unfunded';
    } else {
      fundingStatus = covered ? 'funded' : cover > 0 ? 'partially_funded' : 'unfunded';
    }
    return {
      ...base,
      fundedAmount: round2(cover),
      unfundedAmount: round2(m.amount - cover),
      fundingStatus,
      workable: fundingStatus === 'funded' || base.proceedAtRisk,
    };
  });

  const next = out.find((m) => m.fundingStatus !== 'released' && m.fundingStatus !== 'funded');
  const nextMilestoneToFund = next
    ? {
        id: next.id,
        name: next.name,
        shortfall: fundingMode === 'full_upfront' ? unfundedAmount : Math.min(next.unfundedAmount, unfundedAmount),
      }
    : null;

  return {
    totalContractValue,
    fundedAmount,
    releasedAmount,
    inEscrow,
    unfundedAmount,
    remainingToFund: unfundedAmount,
    pendingFunding,
    fundingMode,
    milestones: out,
    nextMilestoneToFund,
    suggestedFundingAmount: nextMilestoneToFund ? nextMilestoneToFund.shortfall : 0,
    // Legacy field names — existing consumers (dashboards, group screens)
    // keep reading these.
    raised: fundedAmount,
    released: releasedAmount,
    escrowBalance: inEscrow,
  };
}

/** Same aggregation, addressed by project id — kept under the old name so
 * dashboardStatsService/groupController callers keep working unchanged. */
async function getFundingSummaryData(projectId) {
  const project = await Project.findById(projectId).select('totalAmount fundingMode milestones');
  if (!project) return { totalContractValue: 0, fundedAmount: 0, releasedAmount: 0, inEscrow: 0, unfundedAmount: 0, remainingToFund: 0, pendingFunding: 0, fundingMode: 'staged', milestones: [], nextMilestoneToFund: null, suggestedFundingAmount: 0, raised: 0, released: 0, escrowBalance: 0 };
  return getFundingState(project);
}

/** Throws unless work on this milestone may start/continue: it must be fully
 * funded, or the contractor must have explicitly chosen "Proceed Without
 * Full Escrow". */
function assertMilestoneWorkable(state, milestoneId) {
  const m = state.milestones.find((x) => x.id === String(milestoneId));
  if (!m) return;
  if (m.workable || m.fundingStatus === 'released') return;
  throw new ApiError(
    409,
    state.fundingMode === 'full_upfront'
      ? 'This contract is set to full upfront funding — the whole contract value must be in escrow before any milestone starts.'
      : `This milestone is not fully funded (${m.unfundedAmount} still unfunded). The funder must add funds to escrow, or you can explicitly proceed without full escrow.`,
    {
      code: 'MILESTONE_NOT_FUNDED',
      milestoneId: m.id,
      fundingStatus: m.fundingStatus,
      unfundedAmount: m.unfundedAmount,
      fundedAmount: m.fundedAmount,
      fundingMode: state.fundingMode,
    }
  );
}

/** "Fee on top" quote — what the funder actually pays to have `netAmount`
 * credited to escrow. netAmount is in XAF coverage units; for another
 * payment currency the gross is converted at the same static rate the fund
 * endpoint records on the escrow. */
async function quoteFunding(netAmount, currency = 'XAF') {
  let netInPayCurrency = netAmount;
  let rate = 1;
  if (currency !== 'XAF') {
    rate = (await conversionService.convertAmount(1, currency, 'XAF')).rate;
    netInPayCurrency = netAmount / rate;
  }
  const fee = await feeService.grossForNet('project_funding', netInPayCurrency, currency);
  return {
    currency,
    netAmount: round2(fee.netAmount * rate),
    creditedNet: fee.netAmount,
    grossAmount: fee.grossAmount,
    feeAmount: fee.feeAmount,
    feeRate: fee.feeRate,
  };
}

async function findAcceptedContractorId(project) {
  if (project.projectType !== 'tender') return null;
  const bid = await Bid.findOne({ projectId: project._id, status: 'accepted' }).select('contractorId').lean();
  return bid?.contractorId || null;
}

/**
 * Called once whenever a fund escrow becomes `completed` (immediately for
 * synchronous providers, from refreshStatus/webhooks for async ones). The one
 * place that replaces the old copy-pasted `open -> funded` blocks, tells the
 * contractor which milestones just became workable, and releases any
 * milestone the funder already approved while escrow was short.
 */
async function handleFundCompleted(project, escrow) {
  const [before, after] = await Promise.all([
    getFundingState(project, { excludeEscrowId: escrow._id }),
    getFundingState(project),
  ]);

  if (project.status === 'open') {
    project.status = 'funded';
    await project.save();
  }

  const contractorId = await findAcceptedContractorId(project);
  if (contractorId) {
    const beforeById = new Map(before.milestones.map((m) => [m.id, m]));
    for (const m of after.milestones) {
      const was = beforeById.get(m.id);
      if (m.fundingStatus === 'funded' && was && was.fundingStatus !== 'funded' && m.status !== 'approved') {
        await notificationService.notify(contractorId, 'milestone_funded', {
          projectId: project._id,
          milestoneId: m.id,
          milestoneName: m.name,
          amount: m.amount,
        });
      }
    }
  }

  // Lazy require: milestoneReleaseService needs this module's state helpers.
  const { settleApprovedMilestones } = require('./milestoneReleaseService');
  await settleApprovedMilestones(project._id);
  return after;
}

module.exports = {
  EPS,
  getFundingState,
  getFundingSummaryData,
  assertMilestoneWorkable,
  quoteFunding,
  handleFundCompleted,
  findAcceptedContractorId,
};
