const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const dashboardStatsService = require('../services/dashboardStatsService');

/** Admin overview KPIs + 30-day trends. The aggregation itself lives in
 * dashboardStatsService.platform so it shares one definition of "active
 * project" and one escrow-balance formula with the per-role dashboards. */
const getPlatformStats = catchAsync(async (req, res) => {
  const stats = await dashboardStatsService.platform({ since: req.query.since });
  return ok(res, stats);
});

module.exports = { getPlatformStats };
