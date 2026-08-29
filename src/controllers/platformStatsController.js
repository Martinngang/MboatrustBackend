const { User, Project, Escrow, Dispute } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;

/** Turns a sparse `[{_id: 'YYYY-MM-DD', ...}]` aggregation result into a
 * dense day-by-day array covering the last `days` days (including today),
 * filling gaps with 0 — so a line/area chart never has to special-case
 * missing days itself. */
function fillDailySeries(days, aggRows, valueKey) {
  const byDate = new Map(aggRows.map((r) => [r._id, r[valueKey]]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDate.get(key) || 0 });
  }
  return out;
}

/** Real aggregations over existing collections — no new tracking needed.
 * Reuses the same "sum completed Escrows by type" approach
 * projectController.getFundingSummaryData uses per-project, just without
 * the projectId filter, to avoid two aggregation styles drifting apart. */
const getPlatformStats = catchAsync(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : startOfCurrentMonth();

  const trendSince = new Date(Date.now() - TREND_DAYS * DAY_MS);

  const [
    totalUsers, usersByRoleAgg, activeProjects, escrowByType, openDisputes, completedProjectsThisPeriod,
    newUsersByDayAgg, escrowVolumeByDayAgg,
  ] = await Promise.all([
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
      // Overview trend charts — last 30 days, day-by-day. Kept as separate,
      // narrowly-matched aggregations (not reused from the two above) so
      // this endpoint's existing snapshot fields are untouched either way.
      User.aggregate([
        { $match: { createdAt: { $gte: trendSince } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Escrow.aggregate([
        { $match: { type: 'fund', status: 'completed', createdAt: { $gte: trendSince } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$netAmount' } } },
      ]),
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
    // Additive — existing consumers of this endpoint that don't know about
    // these fields are unaffected.
    trends: {
      newUsersByDay: fillDailySeries(TREND_DAYS, newUsersByDayAgg, 'count'),
      escrowVolumeByDay: fillDailySeries(TREND_DAYS, escrowVolumeByDayAgg, 'total'),
    },
  });
});

module.exports = { getPlatformStats };
