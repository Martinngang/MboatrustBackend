const { EmailLog } = require('../models');
const { ok } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');

/** Paginated email-delivery audit trail — every mailerService.sendEmail()
 * attempt, sent/failed/skipped, most recent first. Same page/limit/meta
 * convention as adminActivityController.getAll (the AdminActionLog
 * equivalent for "what did an admin do"; this is "did the resulting email
 * actually reach the user"). */
const getAll = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, type, recipientUserId, triggeredByAdminId } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (recipientUserId) filter.recipientUserId = recipientUserId;
  if (triggeredByAdminId) filter.triggeredByAdminId = triggeredByAdminId;

  const [items, total] = await Promise.all([
    EmailLog.find(filter)
      .populate('recipientUserId', 'fullName email')
      .populate('triggeredByAdminId', 'fullName email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    EmailLog.countDocuments(filter),
  ]);
  return ok(res, items, { page: Number(page), limit: Number(limit), total });
});

/** Quick counts for an admin dashboard summary tile — sent/failed/skipped
 * over the whole log, not paginated. */
const getSummary = catchAsync(async (req, res) => {
  const rows = await EmailLog.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const summary = { sent: 0, failed: 0, skipped: 0 };
  rows.forEach((r) => { summary[r._id] = r.count; });
  return ok(res, summary);
});

module.exports = { getAll, getSummary };
