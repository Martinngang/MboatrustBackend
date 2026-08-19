const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { getRecentActivity } = require('../services/activityService');

const getMine = catchAsync(async (req, res) => {
  const events = await getRecentActivity(req.user._id, { limit: Number(req.query.limit) || 50 });
  return ok(res, events);
});

module.exports = { getMine };
