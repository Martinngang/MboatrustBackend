// The aggregation now lives in milestoneFundingService (the single source of
// truth for contract value / funded / released / unfunded and per-milestone
// funding). Re-exported under the old module path so existing callers —
// dashboardStatsService, groupController, projectController — are unchanged.
const { getFundingSummaryData } = require('./milestoneFundingService');

module.exports = { getFundingSummaryData };
