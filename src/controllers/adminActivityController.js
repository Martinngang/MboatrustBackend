const { AdminActionLog } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

/** Paginated admin-action audit trail — who did what to which record, most
 * recent first. Same page/limit/meta convention as userController.
 * adminGetAll. */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, action, targetType } = req.query;
  const filter = {};
  if (action) filter.action = action;
  if (targetType) filter.targetType = targetType;

  const [items, total] = await Promise.all([
    AdminActionLog.find(filter)
      .populate('adminId', 'fullName email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    AdminActionLog.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

module.exports = { getAll };
