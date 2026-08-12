const { User, Project, Escrow, Dispute } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Real aggregations over existing collections — no new tracking needed.
 * Reuses the same "sum completed Escrows by type" approach
 * projectController.getFundingSummaryData uses per-project, just without
 * the projectId filter, to avoid two aggregation styles drifting apart. */
const getPlatformStats = catchAsync(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : startOfCurrentMonth();

  const [totalUsers, usersByRoleAgg, activeProjects, escrowByType, openDisputes, completedProjectsThisPeriod] =
    await Promise.all([
      User.countDocuments({}),
      User.aggregate([
        { $unwind: '$roles' },
        { $group: { _id: '$roles.roleType', count: { $sum: 1 } } },
      ]),
      Project.countDocuments({ status: { $in: ['open', 'funded', 'in_progress'] } }),
      Escrow.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$type', total: { $sum: '$netAmount' } } },
      ]),
      Dispute.countDocuments({ status: 'open' }),
      Project.countDocuments({ status: 'completed', updatedAt: { $gte: since } }),
    ]);

  const usersByRole = Object.fromEntries(usersByRoleAgg.map((r) => [r._id, r.count]));
  const byType = Object.fromEntries(escrowByType.map((r) => [r._id, r.total]));
  const totalEscrowHeld = (byType.fund || 0) - (byType.release || 0) - (byType.refund || 0);

  return ok(res, {
    totalUsers,
    usersByRole,
    activeProjects,
    totalEscrowHeld,
    openDisputes,
    completedProjectsThisPeriod,
    since,
  });
});

module.exports = { getPlatformStats };
