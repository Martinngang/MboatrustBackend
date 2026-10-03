const { Project } = require('../models');

/** The caller's release escrows that are theirs to claim and not yet marked
 * withdrawn — shared by escrowController (the Earnings screen's balance and
 * the withdraw action) and dashboardStatsService (the dashboard's "Available
 * payout" tile), so the two can never disagree.
 *
 * Only `completed` releases count: a `pending` or `failed` disbursement is
 * money that hasn't landed in the payee's account, so it is neither
 * "available" nor something the withdraw action should mark as claimed. */
async function withdrawableFilter(user) {
  const myProjects = await Project.find({ ownerId: user._id }).select('_id').lean();
  return {
    type: 'release',
    status: 'completed',
    withdrawnAt: null,
    $or: [
      { payeeType: 'contractor', contractorId: user._id },
      { payeeType: 'recipient', projectId: { $in: myProjects.map((p) => p._id) } },
    ],
  };
}

module.exports = { withdrawableFilter };
